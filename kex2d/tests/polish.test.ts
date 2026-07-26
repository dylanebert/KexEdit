import { describe, expect, test } from "bun:test";
import { ALIGN_PX, census, type Scale } from "../src/census";
import { fit } from "../src/fit";
import {
    applyDof,
    AUTHOR_EPS,
    authoringFloor,
    chordDeficit,
    forceMatrix,
    polish,
    type PolishResult,
    readDof,
    regNorm,
    regRows,
    spine,
    TOL_FEAS,
    violence,
} from "../src/polish";
import {
    collinear,
    type ForcePoint,
    forceProfile,
    type Offset,
    sampleForce,
    segmentControls,
} from "../src/profile";
import { scenarios } from "../src/scenarios";
import { type Entry, evalForce, evalGeo } from "../src/section";
import { G_GRID } from "../src/timeline";

// the geo→force spike's constrained polish (kex/specs/kex2d-geoforce-spike.md stage 3):
// the sparse profile whose INTEGRATED geometry matches the bake, exit pinned. Two bars,
// both measured through the live f32 path, never through the solver's own spine:
//
//   1. the exit is pinned — `evalForce` lands on the bake's exit;
//   2. the geometry deviates less than a pinned per-scenario ceiling.
//
// Every ceiling in this file is proven to have TEETH: the same assert is run against the
// stage-2 warm start, which must FAIL it. That is the red-first evidence carried into the
// suite rather than left in a session log — the warm start integrates 0.006–40.5 m off,
// so a broken polish (or a polish quietly returning its input) fails here.
//
// FIT_TOL: stage 2's own bar, half the force axis's authoring quantum (fit.test.ts).
const FIT_TOL = 0.05;

// EXIT_TOL — the reference exit residual through `evalForce` (m). Bracketed, not tuned:
// the FLOOR is the f32 path's own resolution (one position rounding is 2^-24·|coord| ≤
// 1.3e-5 m at the corpus's ≤220 m coordinates, and E ≤ 431 steps accumulate ~√E of them,
// ~2.7e-4 m), so no profile whatsoever can pin the f32 exit tighter than a few 1e-4 m.
// The CEILING is the authoring vocabulary: the viewport readout prints one decimal
// (`controls.formatLen`), so 0.05 m is the coarsest error an author could even see. 1e-3 m
// sits a decade above the float floor — so the assert measures the solve, not rounding —
// and 50× below what the author can perceive. Measured worst on the corpus: 1.7e-4 m.
const EXIT_TOL = 1e-3;

// EXIT_ANG_TOL — the reference exit HEADING residual (rad). `evalForce` re-recovers its
// exit from the swept geometry (the one-display-path law), and that bisector tangent
// differs from the integrator's own θ by ¼(θ_{j−1} − 2θ_j + θ_{j+1}) = O(ds²·κ′) — the
// known source-vs-centered convention gap, ~1e-4 rad here — so the pin cannot be tighter
// than that whatever the solver does. 1e-3 rad = 0.057°, above that gap and still under
// the 0.1° readout quantum (`formatDeg`). Measured worst: 1.5e-4 rad.
const EXIT_ANG_TOL = 1e-3;

// `forceProfile` writes f32 and the corpus's polished peak reaches ~51 g, so one rounding
// is ≤ 51·2^-24 ≈ 3e-6; 1e-5 clears it with margin (fit.test.ts's constant, same reason).
const F32_TOL = 1e-5;

// Geometry deviation through the live f32 path (m), pinned as MEASURED CEILINGS —
// PROVISIONAL, not derived: what the polish can reach is a property of the shape, the
// keyframe placement, and the two section kinds' discretizations, and no closed form
// bounds it. Fewer metres is an improvement and passes; more is a regression and fails.
//
// The floor is NOT the keyframe budget and NOT the integration step — both were swept.
// loop-explicit sits at ~1.4 cm from K=32 to K=55 (a keyframe per 2.5 dense samples) and
// from ds=0.5 to ds=0.125. What it IS: the geo section's polyline has VARIABLE chords
// (`sampleChain`: 0.214–0.664 m at a 0.5 nominal) while the forward integrator lays down
// edges of exact chord ds, so the arclength-resampled target is not a curve the integrator
// can draw. That deficit, Σ(ds − |chord|) over the target, measures 9e-5 m (circular-arc)
// to 5.4e-2 m (valley-explicit) and tracks these ceilings within a factor of ~4 across
// three orders of magnitude. Every value here is far below the 1 m / 5° authoring grid.
const Deviation: Record<string, number> = {
    "circular-arc": 0.0002,
    "parabola-hill": 0.003,
    "full-loop": 0.012,
    "s-curve": 0.003,
    "straight-fillet": 0.016,
    "hill-auto": 0.002,
    "hill-explicit": 0.003,
    "loop-explicit": 0.017,
    "double-hump": 0.002,
    "valley-explicit": 0.09,
};

// Scenarios whose warm start misses the exit HEADING by more than EXIT_ANG_TOL, i.e. where
// the negative control for that bar is meaningful. The two left out (circular-arc 2.8e-4,
// s-curve 4.3e-4) run out along a straight tail whose heading a flat force already gets
// right, so their warm start arrives pointing the correct way while landing 6 mm / 132 mm
// off — the exit POSITION control still bites on all ten. Same asymmetry the exit-pin
// mutation showed from the other side: on smooth shapes the geometry loss nearly pins the
// exit by itself, and the hard pin earns its place on fillet- and spike-class shapes.
const HeadingBites = new Set([
    "parabola-hill",
    "full-loop",
    "straight-fillet",
    "hill-auto",
    "hill-explicit",
    "loop-explicit",
    "double-hump",
    "valley-explicit",
]);

function entryOf(v0: number): Entry {
    return { x: 0, y: 0, theta: 0, v: v0 };
}

function bakeOf(name: string) {
    const s = scenarios.find((x) => x.name === name);
    if (!s) throw new Error(`no scenario named ${name}`);
    const entry = entryOf(s.v0);
    return { s, entry, bake: evalGeo(entry, s.nodes, s.ds) };
}

// polishing the corpus is the expensive part and `polish` is a pure function of its
// inputs, so memoize one solve per scenario across the suite.
const cache = new Map<string, { fit: ReturnType<typeof fit>; out: PolishResult }>();
function solved(name: string) {
    const hit = cache.get(name);
    if (hit) return hit;
    const { s, entry, bake } = bakeOf(name);
    const f = fit(bake.fN, bake.ds, FIT_TOL);
    const out = polish({ bake, entry, points: f.points, ds: s.ds });
    const val = { fit: f, out };
    cache.set(name, val);
    return val;
}

const calm = new Map<string, PolishResult>();
function calmed(name: string) {
    const hit = calm.get(name);
    if (hit) return hit;
    const { s, entry, bake } = bakeOf(name);
    const f = fit(bake.fN, bake.ds, FIT_TOL);
    const out = polish({ bake, entry, points: f.points, ds: s.ds, mode: "calm" });
    calm.set(name, out);
    return out;
}

/** THE REFERENCE CHECK. Integrate a profile through the LIVE f32 `evalForce` path and
 *  measure it against the original bake by arclength — the bake is a polyline, so its
 *  point at arclength `a` is the linear interpolation along the chord containing `a`.
 *  Recomputed here (not read off `PolishResult.spine`) so the check never takes the
 *  solver's word for the geometry it was aiming at. */
function reference(name: string, points: readonly ForcePoint[], length: number, ds: number) {
    const { entry, bake } = bakeOf(name);
    const out = evalForce(entry, forceProfile(points, length, ds), ds);
    const sigma: number[] = [0];
    for (let i = 0; i < bake.edges; i++) sigma.push(sigma[i] + bake.ds[i]);
    const total = sigma[bake.edges];
    let dev = 0;
    let at = -1;
    let i = 0;
    for (let j = 0; j <= out.edges; j++) {
        const a = Math.min(j * ds, total);
        while (i < bake.edges - 1 && sigma[i + 1] < a) i++;
        const span = sigma[i + 1] - sigma[i];
        const t = span > 0 ? Math.min(1, Math.max(0, (a - sigma[i]) / span)) : 0;
        const x = bake.posX[i] + t * (bake.posX[i + 1] - bake.posX[i]);
        const y = bake.posY[i] + t * (bake.posY[i + 1] - bake.posY[i]);
        const d = Math.hypot(out.posX[j] - x, out.posY[j] - y);
        if (d > dev) {
            dev = d;
            at = j;
        }
    }
    return {
        dev,
        at,
        exit: Math.hypot(
            out.posX[out.edges] - bake.posX[bake.edges],
            out.posY[out.edges] - bake.posY[bake.edges],
        ),
        exitTheta: Math.abs(out.exit.theta - bake.theta[bake.edges]),
        edges: out.edges,
    };
}

describe("constrained polish — the corpus", () => {
    test("every scenario has a pinned deviation ceiling", () => {
        for (const s of scenarios) expect(Deviation[s.name]).toBeDefined();
    });

    for (const scenario of scenarios) {
        describe(scenario.name, () => {
            test("converges: every constraint under the feasibility tolerance", () => {
                const { out } = solved(scenario.name);
                expect(out.converged).toBe(true);
                expect(out.feasibility).toBeLessThan(TOL_FEAS);
                expect(Number.isFinite(out.deviation)).toBe(true);
                // the exit pin is an equality, so it lands with the rest of the band —
                // and the band bounds each COMPONENT, so assert on those. `dist` is the
                // 2-norm of two of them, whose implied bound is √2·tol: asserting `dist <
                // tol` would be a stricter bar than the solver ever promised and could
                // fail spuriously with every component in spec.
                expect(Math.abs(out.exit.dx)).toBeLessThan(TOL_FEAS);
                expect(Math.abs(out.exit.dy)).toBeLessThan(TOL_FEAS);
                // the heading constraint is the Λ-scaled one; Λ = the section length.
                expect(Math.abs(out.exit.dtheta) * out.length).toBeLessThan(TOL_FEAS);
                expect(out.exit.dist).toBeLessThan(Math.SQRT2 * TOL_FEAS);
            });

            test("re-integrated through the live evalForce path, the exit is pinned", () => {
                const { out } = solved(scenario.name);
                const r = reference(scenario.name, out.points, out.length, out.ds);
                expect(r.exit).toBeLessThanOrEqual(EXIT_TOL);
                expect(r.exitTheta).toBeLessThanOrEqual(EXIT_ANG_TOL);
            });

            test("the warm start does NOT pin the exit — the bar has teeth", () => {
                const { fit: f, out } = solved(scenario.name);
                const r = reference(scenario.name, f.points, out.length, out.ds);
                expect(r.exit).toBeGreaterThan(EXIT_TOL);
                if (HeadingBites.has(scenario.name))
                    expect(r.exitTheta).toBeGreaterThan(EXIT_ANG_TOL);
            });

            test("re-integrated geometry stays inside its pinned deviation ceiling", () => {
                const { out } = solved(scenario.name);
                const r = reference(scenario.name, out.points, out.length, out.ds);
                expect(r.dev).toBeLessThanOrEqual(Deviation[scenario.name]);
                // and the solver's own diagnostic agrees with the independent
                // measurement, so a reported deviation is never self-flattering. The two
                // differ by the f32 path's rounding against the f64 spine plus the
                // accumulated feasibility gap — DERIVABLY ~5e-4 worst case (√E·2^-24·|coord|
                // + √E·TOL_FEAS at E ≤ 431). 1e-4 is deliberately tighter than that
                // derivation so the check has teeth on every scenario instead of only the
                // coarse ones; measured worst is 5.2e-5, so it is a pin with ~2× margin,
                // not a bound. Loosen it to 5e-4 before suspecting the solver.
                expect(Math.abs(r.dev - out.deviation)).toBeLessThan(1e-4);
            });

            test("the warm start does NOT meet that ceiling — the bar has teeth", () => {
                const { fit: f, out } = solved(scenario.name);
                const r = reference(scenario.name, f.points, out.length, out.ds);
                expect(r.dev).toBeGreaterThan(Deviation[scenario.name]);
            });

            test("keeps the warm start's keyframe placement exactly", () => {
                const { fit: f, out } = solved(scenario.name);
                // the polish moves values, never placement: s is authoring vocabulary
                // (snapped, discrete), shaping is continuous. Holding every s — which
                // holds every handle Δs with it — is also what makes the map from the DOF
                // to dense force linear, so this test guards the solver's model as much as
                // the authoring law.
                expect(out.keys).toBe(f.points.length);
                for (let k = 0; k < out.keys; k++) {
                    expect(out.points[k].s).toBe(f.points[k].s);
                    expect(out.points[k].out?.ds).toBe(f.points[k].out?.ds);
                    expect(out.points[k].in?.ds).toBe(f.points[k].in?.ds);
                    expect(Number.isFinite(out.points[k].g)).toBe(true);
                }
            });

            test("carries fit's span/3 handles through, so the clamp stays cold", () => {
                // This pins a property of STAGE 2's output surviving the polish, NOT a
                // precondition of anything the solver needs. `segment`'s x-monotonicity
                // clamp scales handles by factors that depend on the s-coordinates alone,
                // so the DOF→force map is linear whether the clamp fires or not; a clamped
                // handle is a different constant, never a nonlinearity. What is worth
                // pinning is that the production evaluator reads back the exact control
                // points we wrote — a silent clamp would mean the polished profile an
                // author loads is not the one that was solved.
                const { out } = solved(scenario.name);
                for (let k = 0; k + 1 < out.keys; k++) {
                    const a = out.points[k];
                    const b = out.points[k + 1];
                    const c = segmentControls(a, b);
                    expect(c[1].s).toBe(a.s + a.out!.ds);
                    expect(c[1].g).toBe(a.g + a.out!.dg);
                    expect(c[2].s).toBe(b.s + b.in!.ds);
                    expect(c[2].g).toBe(b.g + b.in!.dg);
                    expect(c[1].s - a.s).toBeCloseTo((b.s - a.s) / 3, 12);
                }
            });

            test("the solver's force model is the production evaluator", () => {
                // the solve drives F = A·dof, a linear form whose matrix was PROBED out of
                // `profile.sampleForce`. If that model ever drifted from the shipped
                // evaluator the geometry would be optimized against a curve nobody
                // integrates — so pin the last snapshot's dense force against
                // `forceProfile`, the array a force section actually loads.
                const { out } = solved(scenario.name);
                const last = out.snapshots[out.snapshots.length - 1];
                const arr = forceProfile(out.points, out.length, out.ds);
                expect(arr.length).toBe(out.edges);
                for (let j = 0; j < out.edges; j++)
                    expect(Math.abs(arr[j] - last.fN[j])).toBeLessThanOrEqual(F32_TOL);
            });

            test("emits bounded, playable snapshots", () => {
                const { out } = solved(scenario.name);
                expect(out.snapshots.length).toBeGreaterThan(1);
                expect(out.snapshots.length).toBeLessThanOrEqual(120);
                for (const snap of out.snapshots) {
                    expect(snap.fN.length).toBe(out.edges);
                    expect(snap.points.length).toBe(out.keys);
                    expect(Number.isFinite(snap.feasibility)).toBe(true);
                    expect(Number.isFinite(snap.deviation)).toBe(true);
                }
                // playback ends on the answer.
                const last = out.snapshots[out.snapshots.length - 1];
                expect(last.feasibility).toBeCloseTo(out.feasibility, 12);
                for (let k = 0; k < out.keys; k++) expect(last.points[k].g).toBe(out.points[k].g);
            });
        });
    }

    test("the polish is deterministic: two solves are identical", () => {
        const { s, entry, bake } = bakeOf("valley-explicit");
        const f = fit(bake.fN, bake.ds, FIT_TOL);
        const a = polish({ bake, entry, points: f.points, ds: s.ds });
        const b = polish({ bake, entry, points: f.points, ds: s.ds });
        expect(b.iters).toBe(a.iters);
        expect(b.outers).toBe(a.outers);
        expect(b.feasibility).toBe(a.feasibility);
        expect(b.deviation).toBe(a.deviation);
        for (let k = 0; k < a.keys; k++) {
            expect(b.points[k].g).toBe(a.points[k].g);
            expect(b.points[k].out?.dg).toBe(a.points[k].out?.dg);
            expect(b.points[k].in?.dg).toBe(a.points[k].in?.dg);
        }
    });

    test("with the polish disabled the warm start's infeasibility is what shows", () => {
        // the negative control for the convergence assert. The spine is warm-started AT
        // the target geometry, so at iteration zero the tracking loss and the exit pin
        // are already satisfied — all of the warm start's error lives in the dynamics
        // defects (up to 12 position-equivalent metres on valley-explicit's 38 g spike).
        // That is exactly why a far start is harmless here and why `deviation` must never
        // be read off an unconverged solve.
        for (const name of ["circular-arc", "loop-explicit", "valley-explicit"]) {
            const { s, entry, bake } = bakeOf(name);
            const f = fit(bake.fN, bake.ds, FIT_TOL);
            const out = polish({ bake, entry, points: f.points, ds: s.ds, outers: 0 });
            expect(out.converged).toBe(false);
            expect(out.feasibility).toBeGreaterThan(1e4 * TOL_FEAS);
            expect(out.exit.dist).toBe(0);
            expect(out.deviation).toBe(0);
        }
    });
});

// Calm mode's violence — PROVISIONAL, same as the `Deviation` table above and for the same
// reason: what the regularizer can reach is a property of the shape, the keyframe
// placement, and where the bisection lands, and no closed form bounds it. These are the
// drift tripwires for the before/after that is the human check-in's verdict input (spec
// stage 3b), not derived bars. `peakG` is the peak of the DENSE force the profile drives
// (the one that catches inter-key overshoot invisible in the diamonds); `maxDg` the largest
// handle offset an author would have to grab.
//
// Each is the measured value plus ~10% headroom, floored at G_GRID/2 for the handles so a
// scenario whose handles go flat isn't pinned against zero. The headroom is deliberate: the
// discrepancy search lands wherever a bisection branch falls, and full-loop's accepted λ
// sits under 1% below its floor — one flipped branch there moves λ by a bisection step and
// the violence with it, which is drift to look at, not a regression. The real teeth are
// elsewhere in this block: `calm ≤ exact` on handles, and the strict-reduction assert on
// the spike scenarios.
const CalmViolence: Record<string, { peakG: number; maxDg: number }> = {
    "circular-arc": { peakG: 2.02, maxDg: 0.05 },
    "parabola-hill": { peakG: 3.67, maxDg: 0.66 },
    "full-loop": { peakG: 6.62, maxDg: 1.14 },
    "s-curve": { peakG: 4.24, maxDg: 0.86 },
    "straight-fillet": { peakG: 3.26, maxDg: 1.87 },
    "hill-auto": { peakG: 4.71, maxDg: 0.05 },
    "hill-explicit": { peakG: 3.17, maxDg: 1.08 },
    "loop-explicit": { peakG: 32.8, maxDg: 0.05 },
    "double-hump": { peakG: 4.47, maxDg: 0.05 },
    "valley-explicit": { peakG: 38.6, maxDg: 50.7 },
};

// The spike scenarios — the Auto↔explicit tangent boundaries whose ~38 g recovered-F_n
// discontinuity is what made the exact solve violent (spec stage 1 corpus note). These are
// where the reduction has to be MEASURABLE, not merely non-regressive.
const Spikes = ["loop-explicit", "valley-explicit"];

describe("constrained polish — calm mode", () => {
    test("the authoring floor is derived, and it is the two terms", () => {
        // the discrepancy level: what the integrator structurally cannot remove, plus what
        // the readout structurally cannot show. Not a corpus-fitted number.
        const { bake } = bakeOf("valley-explicit");
        const sp = spine(bake, 0.5);
        expect(authoringFloor(sp)).toBeCloseTo(chordDeficit(sp) + AUTHOR_EPS, 12);
        // a bake the integrator CAN draw exactly has no deficit: a straight polyline
        // resampled at uniform arclength has chords of exactly ds.
        const straight = spine(
            { posX: [0, 3, 6], posY: [0, 4, 8], theta: [0, 0, 0], ds: [5, 5], edges: 2 },
            0.7,
        );
        expect(chordDeficit(straight)).toBeCloseTo(0, 9);
        // and a bending one has a strictly positive deficit, on every corpus scenario.
        for (const s of scenarios) {
            const d = chordDeficit(spine(bakeOf(s.name).bake, s.ds));
            expect(d).toBeGreaterThan(0);
            expect(Number.isFinite(d)).toBe(true);
        }
    });

    test("exact mode is untouched by the mode option", () => {
        const { out } = solved("loop-explicit");
        expect(out.mode).toBe("exact");
        expect(out.lambda).toBe(0);
        expect(out.solves).toBe(1);
        // the floor is reported in exact mode but never acted on — exact stops at the
        // numeric floor, three orders below it.
        expect(out.deviation).toBeLessThan(out.floor);
        expect(out.heldFloor).toBe(true);
    });

    test("rejects a mode option it could not mean anything over", () => {
        // each of these silently produces a solve that LOOKS answered: an unknown mode
        // string falls through to calm, a non-positive floor lands every search on the
        // fallback, and a λ of Infinity/NaN poisons Φ so every trial step is rejected and
        // the untouched warm start comes back wearing converged diagnostics — the same
        // silent-no-op class the entry and warm-start guards refuse.
        const { s, entry, bake } = bakeOf("hill-auto");
        const base = { bake, entry, points: fit(bake.fN, bake.ds, FIT_TOL).points, ds: s.ds };
        expect(() => polish({ ...base, mode: "clam" as never })).toThrow(
            /mode must be "exact" or "calm"/,
        );
        expect(() => polish({ ...base, mode: "" as never })).toThrow(/mode must be/);
        for (const floor of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
            expect(() => polish({ ...base, mode: "calm", floor })).toThrow(
                /floor must be a finite number > 0/,
            );
        for (const lambda of [-1, Number.NaN, Number.POSITIVE_INFINITY])
            expect(() => polish({ ...base, mode: "calm", lambda })).toThrow(
                /lambda must be a finite number >= 0/,
            );
        // exact mode ignores the VALUE but still refuses a meaningless one.
        expect(() => polish({ ...base, lambda: Number.NaN })).toThrow(/lambda must be/);
        // and the valid ends of both ranges pass.
        expect(() => polish({ ...base, mode: "calm", lambda: 0 })).not.toThrow();
    });

    for (const scenario of scenarios) {
        describe(scenario.name, () => {
            test("re-integrated through the live evalForce path, the exit is still pinned", () => {
                const out = calmed(scenario.name);
                expect(out.converged).toBe(true);
                expect(out.feasibility).toBeLessThan(TOL_FEAS);
                const r = reference(scenario.name, out.points, out.length, out.ds);
                expect(r.exit).toBeLessThanOrEqual(EXIT_TOL);
                expect(r.exitTheta).toBeLessThanOrEqual(EXIT_ANG_TOL);
            });

            test("stops AT the derived authoring floor, never past it", () => {
                const out = calmed(scenario.name);
                expect(out.floor).toBeCloseTo(
                    authoringFloor(spine(bakeOf(scenario.name).bake, scenario.ds)),
                    12,
                );
                expect(out.deviation).toBeLessThanOrEqual(out.floor);
                expect(out.heldFloor).toBe(true);
                // and the independent f32 measurement agrees — same 1e-4 spine-vs-reference
                // slack the exact-mode ceiling test derives.
                const r = reference(scenario.name, out.points, out.length, out.ds);
                expect(r.dev).toBeLessThanOrEqual(out.floor + 1e-4);
                expect(Math.abs(r.dev - out.deviation)).toBeLessThan(1e-4);
            });

            test("keeps the warm start's keyframe placement, same as exact", () => {
                const { fit: f } = solved(scenario.name);
                const out = calmed(scenario.name);
                expect(out.keys).toBe(f.points.length);
                for (let k = 0; k < out.keys; k++) {
                    expect(out.points[k].s).toBe(f.points[k].s);
                    expect(out.points[k].out?.ds).toBe(f.points[k].out?.ds);
                    expect(out.points[k].in?.ds).toBe(f.points[k].in?.ds);
                }
            });

            test("is calmer than exact, and inside its pinned violence", () => {
                const { out: ex } = solved(scenario.name);
                const cm = calmed(scenario.name);
                const pin = CalmViolence[scenario.name];
                expect(pin).toBeDefined();
                expect(cm.maxDg).toBeLessThanOrEqual(pin.maxDg);
                expect(cm.peakG).toBeLessThanOrEqual(pin.peakG);
                // handles never get worse. Peak dense force may tick UP on a smooth shape
                // (removing handles reshapes the interior a little), bounded by half the
                // force axis's authoring quantum — the coarsest change the chart's readout
                // could show.
                expect(cm.maxDg).toBeLessThanOrEqual(ex.maxDg);
                expect(cm.peakG).toBeLessThanOrEqual(ex.peakG + G_GRID / 2);
                // the reported violence is the profile's own, not a solver diagnostic.
                const v = violence(cm.points, cm.length, cm.ds);
                expect(v.peakG).toBeCloseTo(cm.peakG, 12);
                expect(v.maxDg).toBeCloseTo(cm.maxDg, 12);
            });

            test("emits playable snapshots ending on the answer", () => {
                const out = calmed(scenario.name);
                expect(out.snapshots.length).toBeGreaterThan(1);
                expect(out.snapshots.length).toBeLessThanOrEqual(120);
                const last = out.snapshots[out.snapshots.length - 1];
                expect(last.fN.length).toBe(out.edges);
                expect(last.feasibility).toBeCloseTo(out.feasibility, 12);
                for (let k = 0; k < out.keys; k++) expect(last.points[k].g).toBe(out.points[k].g);
            });

            test("the solver's force model is still the production evaluator", () => {
                // the exact-mode twin of this pins that F = A·dof never drifts from the
                // shipped evaluator. Calm mode needs its own: the snapshots come from the
                // WINNING λ's solve, one of up to ten, so this is also what proves the
                // returned profile and the returned playback are the same solve.
                const out = calmed(scenario.name);
                const last = out.snapshots[out.snapshots.length - 1];
                const arr = forceProfile(out.points, out.length, out.ds);
                expect(arr.length).toBe(out.edges);
                for (let j = 0; j < out.edges; j++)
                    expect(Math.abs(arr[j] - last.fN[j])).toBeLessThanOrEqual(F32_TOL);
            });
        });
    }

    test("the spike scenarios are measurably calmer — the check-in's finding", () => {
        // The human check-in's complaint, in numbers: on the Auto↔explicit boundaries the
        // exact solve buys sub-mm geometry with handles no one would author.
        for (const name of Spikes) {
            const { out: ex } = solved(name);
            const cm = calmed(name);
            expect(cm.maxDg).toBeLessThan(0.9 * ex.maxDg);
            expect(cm.peakG).toBeLessThan(0.9 * ex.peakG);
        }
    });

    test("with λ forced to 0 the violence comes straight back", () => {
        // the negative control for the Tikhonov block. Same loosened floor, no penalty —
        // so the geometry is free to sit anywhere inside the floor and nothing prefers the
        // calm member. It lands on exact mode's answer, violence and all.
        for (const name of Spikes) {
            const { s, entry, bake } = bakeOf(name);
            const { out: ex } = solved(name);
            const f = fit(bake.fN, bake.ds, FIT_TOL);
            const out = polish({
                bake,
                entry,
                points: f.points,
                ds: s.ds,
                mode: "calm",
                lambda: 0,
            });
            expect(out.lambda).toBe(0);
            expect(out.solves).toBe(1);
            expect(out.maxDg).toBeCloseTo(ex.maxDg, 6);
            expect(out.peakG).toBeCloseTo(ex.peakG, 6);
            // and that IS the violence the search removes.
            expect(calmed(name).maxDg).toBeLessThan(0.9 * out.maxDg);
        }
    });

    test("with the floor set to the numeric one, calm mode falls back to exact", () => {
        // the negative control for discrepancy stopping. At TOL_FEAS there is no slack to
        // spend, so no λ in the bracket holds the floor and the search falls back to the
        // unregularized solve — the same answer exact mode gives, violence and all. That
        // answer does NOT reach the floor it was given, and `heldFloor` is the only field
        // that says so: λ = 0 marks the fallback, `converged` is about feasibility, and
        // `deviation` needs the floor beside it to read.
        const name = "loop-explicit";
        const { s, entry, bake } = bakeOf(name);
        const { out: ex } = solved(name);
        const out = polish({
            bake,
            entry,
            points: fit(bake.fN, bake.ds, FIT_TOL).points,
            ds: s.ds,
            mode: "calm",
            floor: TOL_FEAS,
        });
        expect(out.lambda).toBe(0);
        expect(out.floor).toBe(TOL_FEAS);
        expect(out.deviation).toBe(ex.deviation);
        expect(out.maxDg).toBe(ex.maxDg);
        expect(out.converged).toBe(true);
        expect(out.heldFloor).toBe(false);
        // the held path, for contrast: same scenario, the derived floor.
        expect(calmed(name).heldFloor).toBe(true);
    });

    test("a fallback that misses the floor is flagged, not dressed up as held", () => {
        // the real-input version of the control above, no floor override. A coarse fit
        // (tol 10× stage 2's) over a bendy shape leaves the unregularized solve ITSELF
        // outside the derived floor, so the fallback returns the tightest geometry it has
        // while missing the target — `converged` and `lambda` look exactly like a held
        // answer, and only `heldFloor` separates them.
        const { s, entry, bake } = bakeOf("full-loop");
        const coarse = fit(bake.fN, bake.ds, 10 * FIT_TOL);
        const out = polish({ bake, entry, points: coarse.points, ds: s.ds, mode: "calm" });
        expect(out.converged).toBe(true);
        expect(out.lambda).toBe(0);
        expect(out.deviation).toBeGreaterThan(out.floor);
        expect(out.heldFloor).toBe(false);
    });

    test("iters reports the whole search, not the winning solve", () => {
        // the corpus table reads `iters` as what the call cost, and the search runs the
        // solve up to ten times — a per-solve count under-reports it by most of an
        // order of magnitude. Pinned against the winning λ re-solved alone.
        const name = "valley-explicit";
        const { s, entry, bake } = bakeOf(name);
        const cm = calmed(name);
        expect(cm.solves).toBeGreaterThan(1);
        const one = polish({
            bake,
            entry,
            points: fit(bake.fN, bake.ds, FIT_TOL).points,
            ds: s.ds,
            mode: "calm",
            lambda: cm.lambda,
        });
        expect(one.solves).toBe(1);
        expect(one.iters).toBeGreaterThan(0);
        expect(cm.iters).toBeGreaterThan(one.iters);
    });

    test("a saturated bracket is one solve, and λ there is a clip", () => {
        // loop-explicit's whole handle family fits inside its floor, so the strong-end
        // probe holds on the first try and the bisection never runs. Its λ is LAM_MAX —
        // the end of the bracket, not a discrepancy point the search located.
        const out = calmed("loop-explicit");
        expect(out.solves).toBe(1);
        expect(out.lambda).toBe(1e3);
        expect(out.maxDg).toBeLessThan(G_GRID / 2);
    });

    test("calm mode is deterministic: two solves are identical", () => {
        const { s, entry, bake } = bakeOf("full-loop");
        const f = fit(bake.fN, bake.ds, FIT_TOL);
        const base = { bake, entry, points: f.points, ds: s.ds, mode: "calm" as const };
        const a = polish(base);
        const b = polish(base);
        expect(b.lambda).toBe(a.lambda);
        expect(b.iters).toBe(a.iters);
        expect(b.deviation).toBe(a.deviation);
        for (let k = 0; k < a.keys; k++) {
            expect(b.points[k].g).toBe(a.points[k].g);
            expect(b.points[k].out?.dg).toBe(a.points[k].out?.dg);
            expect(b.points[k].in?.dg).toBe(a.points[k].in?.dg);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────────────
// The AUTHORABLE DOF family (`handles: "aligned"`, spec `kex2d-geoforce-convert` lock 1):
// one slope `m` per key instead of two independent handle Δg, so a BROKEN key is
// unrepresentable rather than penalized.
//
// THE ATTRIBUTION RUN — the DOF restriction alone, prior unchanged (the Δg Tikhonov
// pushed through the reparameterization, so λ measures the same quantity in both
// families). Final-frame censuses only; violence numbers are ds-dependent, so read them
// against this corpus at its own `scenario.ds`, never across one.
//
//   census, broken keys summed over the corpus:  exact  117 → 0     calm  50 → 0
//   deviation (exact): within 4× of the free family on every scenario, and still an order
//     under the authoring floor on nine of ten. valley-explicit is the tenth.
//   violence (exact, maxΔg free → aligned): 0.29→0.24, 2.82→1.14, 11.4→3.6, 1.88→1.02,
//     4.60→1.85, 16.1→4.02, 3.83→3.78, 141→**1866**, 2.35→0.71, 56.3→33.8.
//   violence (calm, maxΔg free → aligned): unchanged within ±10% on eight, full-loop
//     1.03→0.92, valley-explicit 46.1→33.8; peak g within ±2% except valley 35.1→15.9.
//
// The finding to carry into stage 2: **the vocabulary constraint fixes the census, not
// the magnitudes.** loop-explicit's exact-mode handles get 13× LOUDER under the
// restriction — aligned, and enormous — because near the geometry floor the problem is
// ill-posed in both families and nothing in a flat Δg→0 prior prefers a quiet slope.
// That is the gap the fairing seminorm is for, and it is why no per-scenario violence
// ceiling is pinned here: stage 2 is expected to move every one of these.
const AlignedDeviation: Record<string, number> = {
    "circular-arc": 0.00045,
    "parabola-hill": 0.0033,
    "full-loop": 0.027,
    "s-curve": 0.0026,
    "straight-fillet": 0.0146,
    "hill-auto": 0.0022,
    "hill-explicit": 0.0043,
    "loop-explicit": 0.0155,
    "double-hump": 0.0023,
    // 0.288 m against a 0.104 m floor. The aligned family cannot draw valley-explicit's
    // ~38 g spike at the warm start's knots — a spike narrower than one keyframe span
    // needs a split or an explicit corner, which is stage 3's refine loop. Recorded as
    // the family's floor residual, NOT as a failure: the authorability directive
    // sanctions approximating an un-authorable feature away, and this scenario is where
    // that trade shows up as geometry.
    "valley-explicit": 0.33,
};

/** the scenarios whose aligned solve reaches the derived authoring floor. The one absent
 *  is the stage-3 input above — pinned as a SET so a scenario silently falling out of the
 *  floor is a failure, not an unnoticed drift. */
const AlignedHoldsFloor = new Set(
    scenarios.map((s) => s.name).filter((n) => n !== "valley-explicit"),
);

const alignedExact = new Map<string, PolishResult>();
const alignedCalm = new Map<string, PolishResult>();
function aligned(name: string, mode: "exact" | "calm"): PolishResult {
    const cache = mode === "exact" ? alignedExact : alignedCalm;
    const hit = cache.get(name);
    if (hit) return hit;
    const { s, entry, bake } = bakeOf(name);
    const f = fit(bake.fN, bake.ds, FIT_TOL);
    const out = polish({ bake, entry, points: f.points, ds: s.ds, mode, handles: "aligned" });
    cache.set(name, out);
    return out;
}

/** the fit lab's own panel transform, which is the surface the census judges on
 *  (`census.ts`: the classification is screen-space, and a count taken against a picture
 *  nobody looks at is a count of nothing). Mirrored rather than imported — `fitlab.ts` is
 *  a DOM page. */
function panelScale(points: readonly ForcePoint[], length: number, ds: number): Scale {
    const dense = forceProfile(points, length, ds);
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const g of dense) {
        lo = Math.min(lo, g);
        hi = Math.max(hi, g);
    }
    for (const p of points) {
        lo = Math.min(lo, p.g);
        hi = Math.max(hi, p.g);
    }
    return { s: (620 - 46 - 14) / length, g: (340 - 34 - 26) / Math.max(hi - lo, 1e-3) };
}

/** a handle's drawn length on a surface (px) — what `handleState` reads a direction from,
 *  and the only thing that can make a collinear key census `broken`. */
function drawnPx(o: Offset, sc: Scale): number {
    return Math.hypot(o.ds * sc.s, o.dg * sc.g);
}

function censusOf(r: PolishResult) {
    return census(r.points, panelScale(r.points, r.length, r.ds));
}

describe("constrained polish — the authorable DOF", () => {
    test("the two families have the sizes the vocabulary implies", () => {
        const { bake } = bakeOf("hill-explicit");
        const pts = fit(bake.fN, bake.ds, FIT_TOL).points;
        const K = pts.length;
        // free: a value per key plus a Δg per handle. aligned: a value AND a slope per key.
        expect(readDof(pts, "free").length).toBe(3 * K - 2);
        expect(readDof(pts, "aligned").length).toBe(2 * K);
    });

    test("free mode round-trips a profile exactly; aligned projects onto its family", () => {
        const { bake } = bakeOf("hill-explicit");
        const pts = fit(bake.fN, bake.ds, FIT_TOL).points;
        const back = applyDof(pts, "free", readDof(pts, "free"));
        for (let k = 0; k < pts.length; k++) {
            expect(back[k].g).toBe(pts[k].g);
            expect(back[k].in?.dg).toBe(pts[k].in?.dg);
            expect(back[k].out?.dg).toBe(pts[k].out?.dg);
            // Δs is never a DOF — placement is held fixed, which is what keeps the map linear.
            expect(back[k].in?.ds).toBe(pts[k].in?.ds);
            expect(back[k].out?.ds).toBe(pts[k].out?.ds);
        }

        // the warm start's handles are NOT collinear (that is the whole problem), so the
        // aligned read has to project. Pin that it is the least-squares projection: any
        // other slope leaves a larger Σ(m·Δs − Δg)² residual at that key.
        const m = readDof(pts, "aligned");
        const K = pts.length;
        let broke = 0;
        for (let k = 0; k < K; k++) {
            if (!collinear(pts[k].in, pts[k].out)) broke++;
            const resid = (slope: number): number => {
                let sum = 0;
                for (const side of [pts[k].in, pts[k].out])
                    if (side) sum += (slope * side.ds - side.dg) ** 2;
                return sum;
            };
            const at = resid(m[K + k]);
            expect(resid(m[K + k] + 1e-3)).toBeGreaterThanOrEqual(at);
            expect(resid(m[K + k] - 1e-3)).toBeGreaterThanOrEqual(at);
        }
        expect(broke).toBeGreaterThan(0);
    });

    test("every aligned profile is collinear at every key — the construction", () => {
        const { bake } = bakeOf("hill-explicit");
        const pts = fit(bake.fN, bake.ds, FIT_TOL).points;
        const K = pts.length;
        const dof = readDof(pts, "aligned");
        // arbitrary slopes, including a sign flip and a huge one: collinearity is not a
        // property of the solved answer, it is a property of the parameterization.
        for (let k = 0; k < K; k++) dof[K + k] = ((k % 5) - 2) * 17.3;
        for (const p of applyDof(pts, "aligned", dof)) expect(collinear(p.in, p.out)).toBe(true);
    });

    test("rejects a DOF vector of the wrong width", () => {
        const { bake } = bakeOf("hill-auto");
        const pts = fit(bake.fN, bake.ds, FIT_TOL).points;
        expect(() => applyDof(pts, "aligned", new Float64Array(3 * pts.length))).toThrow(
            /aligned over \d+ keys takes \d+ dof/,
        );
        expect(() => applyDof(pts, "free", new Float64Array(2 * pts.length))).toThrow(
            /free over \d+ keys takes \d+ dof/,
        );
    });

    test("rejects a handles option it could not mean anything over", () => {
        const { s, entry, bake } = bakeOf("hill-auto");
        const base = { bake, entry, points: fit(bake.fN, bake.ds, FIT_TOL).points, ds: s.ds };
        // an unknown string would fall through to the free family and silently report a
        // solve in a vocabulary nobody asked for — the same silent-no-op class the mode,
        // floor, and lambda guards refuse.
        expect(() => polish({ ...base, handles: "Aligned" as never })).toThrow(
            /handles must be "free" or "aligned"/,
        );
        expect(() => polish({ ...base, handles: "" as never })).toThrow(/handles must be/);
    });

    test("the aligned force map is LINEAR: finite differences reproduce the probed matrix", () => {
        // `F = A·dof` is what lets the LM/PHR machinery survive the reparameterization
        // untouched, so it is checked against the production evaluator directly rather
        // than assumed from the algebra. valley-explicit is the corpus's worst case: the
        // steepest dense curve and the largest handle offsets.
        const { s, bake } = bakeOf("valley-explicit");
        const pts = fit(bake.fN, bake.ds, FIT_TOL).points;
        const sp = spine(bake, s.ds);
        const E = sp.edges;
        const A = forceMatrix(pts, "aligned", E, sp.ds);
        const P = readDof(pts, "aligned").length;
        expect(A.length).toBe(P);

        // TOL: the map is exactly linear, so the only error is `sampleForce`'s root solve
        // — its s-residual is bounded by S_TOL_REL (1e-13) of the span, giving a value
        // error of ~1e-13·|Δg| ≈ 1e-10 at this corpus's offsets. Divided by the smallest
        // 2δ below that is ~1e-9; 1e-7 relative clears it by two decades and is still far
        // tighter than any nonlinearity would be.
        const Tol = 1e-7;
        const base = readDof(pts, "aligned");
        const F = (d: Float64Array): Float64Array => {
            const prof = applyDof(pts, "aligned", d);
            const out = new Float64Array(E);
            for (let j = 0; j < E; j++) out[j] = sampleForce(prof, j * sp.ds);
            return out;
        };

        // 1. central differences at a NON-ZERO base, two step sizes an order apart. A
        //    linear map's difference quotient equals the derivative at every δ; a
        //    nonlinear one's moves with δ, so agreeing at both is the real check.
        let worstFd = 0;
        for (const delta of [1, 0.1]) {
            for (let p = 0; p < P; p++) {
                const up = Float64Array.from(base);
                const dn = Float64Array.from(base);
                up[p] += delta;
                dn[p] -= delta;
                const fu = F(up);
                const fd = F(dn);
                for (let j = 0; j < E; j++) {
                    const slope = (fu[j] - fd[j]) / (2 * delta);
                    worstFd = Math.max(
                        worstFd,
                        Math.abs(slope - A[p][j]) / (1 + Math.abs(A[p][j])),
                    );
                }
            }
        }
        expect(worstFd).toBeLessThan(Tol);

        // 2. the map has no constant term and reconstructs exactly: F(0) = 0 and
        //    F(d) = A·d for an arbitrary d, not just near the base.
        for (const g of F(new Float64Array(P))) expect(g).toBe(0);
        const d = Float64Array.from(base, (v, i) => v * 1.7 - 0.4 * ((i % 3) - 1));
        const got = F(d);
        let worstLin = 0;
        for (let j = 0; j < E; j++) {
            let sum = 0;
            for (let p = 0; p < P; p++) sum += A[p][j] * d[p];
            worstLin = Math.max(worstLin, Math.abs(sum - got[j]) / (1 + Math.abs(got[j])));
        }
        expect(worstLin).toBeLessThan(Tol);
    });

    test("the corpus's free-mode answer IS broken — the census bar has teeth", () => {
        // the negative control for every "0 broken" assert below, and the check-in's
        // complaint in one number: solving the same ten shapes in the independent-handle
        // family leaves 117 keys an author would meet as `Free`.
        let total = 0;
        for (const s of scenarios) {
            const c = censusOf(solved(s.name).out);
            expect(c.broken).toBeGreaterThan(0);
            total += c.broken;
        }
        expect(total).toBe(117);
    });

    for (const scenario of scenarios) {
        describe(scenario.name, () => {
            test("converges in the aligned family, both modes", () => {
                for (const mode of ["exact", "calm"] as const) {
                    const out = aligned(scenario.name, mode);
                    expect(out.handles).toBe("aligned");
                    expect(out.mode).toBe(mode);
                    expect(out.converged).toBe(true);
                    expect(out.feasibility).toBeLessThan(TOL_FEAS);
                    expect(Math.abs(out.exit.dx)).toBeLessThan(TOL_FEAS);
                    expect(Math.abs(out.exit.dy)).toBeLessThan(TOL_FEAS);
                    expect(Math.abs(out.exit.dtheta) * out.length).toBeLessThan(TOL_FEAS);
                }
            });

            test("re-integrated through the live evalForce path, the exit is pinned", () => {
                for (const mode of ["exact", "calm"] as const) {
                    const out = aligned(scenario.name, mode);
                    const r = reference(scenario.name, out.points, out.length, out.ds);
                    expect(r.exit).toBeLessThanOrEqual(EXIT_TOL);
                    expect(r.exitTheta).toBeLessThanOrEqual(EXIT_ANG_TOL);
                }
            });

            test("is collinear at every key by construction — the vocabulary claim", () => {
                // the STRUCTURAL half of lock 1, and the one that says the DOF family did
                // its job: `Δg = m·Δs` per side puts both handles on one line through the
                // key, so the editor's `Free` shape is unrepresentable. `collinear` is the
                // editor's own predicate (the precondition for storing
                // `TangentMode.Aligned`) over the stored offsets, so no surface, panel, or
                // zoom enters it — this assert cannot be moved by a display decision.
                for (const mode of ["exact", "calm"] as const)
                    for (const p of aligned(scenario.name, mode).points)
                        expect(collinear(p.in, p.out)).toBe(true);
            });

            test("censuses 0 broken on the lab's panel — the legibility report", () => {
                // the DISPLAY half, and only that. `census` judges in screen space, so
                // this reports what the fit lab's panel shows at its own transform, not
                // what the family can represent — and the two genuinely part company,
                // because `handleState` also calls a side shorter than ALIGN_PX broken
                // (it carries no direction to read there). The corpus's shortest handle on
                // this panel is 0.79 px against a 0.5 px threshold — hill-auto calm, whose
                // handles go flat — so the identical profiles census 3 broken on a
                // half-scale panel and 71 on a quarter-scale one (pinned below). Read a
                // failure here as handles too small to draw, never as broken vocabulary:
                // that claim is the collinearity test above.
                for (const mode of ["exact", "calm"] as const) {
                    const out = aligned(scenario.name, mode);
                    const sc = panelScale(out.points, out.length, out.ds);
                    expect(census(out.points, sc).broken).toBe(0);
                }
            });

            test("keeps the warm start's keyframe placement, same as the free family", () => {
                const { fit: f } = solved(scenario.name);
                for (const mode of ["exact", "calm"] as const) {
                    const out = aligned(scenario.name, mode);
                    expect(out.keys).toBe(f.points.length);
                    for (let k = 0; k < out.keys; k++) {
                        expect(out.points[k].s).toBe(f.points[k].s);
                        expect(out.points[k].out?.ds).toBe(f.points[k].out?.ds);
                        expect(out.points[k].in?.ds).toBe(f.points[k].in?.ds);
                    }
                }
            });

            test("records the family's floor residual at the warm start's knots", () => {
                // exact + aligned is the TIGHTEST geometry this vocabulary reaches, so its
                // deviation is the honest answer to "can the aligned family draw this
                // shape at these knots". Nine scenarios clear the derived authoring floor;
                // the tenth is stage 3's input, not a failure (see `AlignedDeviation`).
                const out = aligned(scenario.name, "exact");
                const r = reference(scenario.name, out.points, out.length, out.ds);
                expect(r.dev).toBeLessThanOrEqual(AlignedDeviation[scenario.name]);
                expect(out.deviation).toBeLessThanOrEqual(AlignedDeviation[scenario.name]);
                expect(Math.abs(r.dev - out.deviation)).toBeLessThan(1e-3);
                const holds = AlignedHoldsFloor.has(scenario.name);
                expect(out.deviation <= authoringFloor(out.spine)).toBe(holds);
                expect(aligned(scenario.name, "calm").heldFloor).toBe(holds);
            });

            test("the solver's force model is still the production evaluator", () => {
                // the aligned twin of the free-family pin: the reparameterization changed
                // the matrix's columns, so re-prove that what the solve drove is what a
                // force section would load.
                const out = aligned(scenario.name, "calm");
                const last = out.snapshots[out.snapshots.length - 1];
                const arr = forceProfile(out.points, out.length, out.ds);
                expect(arr.length).toBe(out.edges);
                for (let j = 0; j < out.edges; j++)
                    expect(Math.abs(arr[j] - last.fN[j])).toBeLessThanOrEqual(F32_TOL);
            });
        });
    }

    test("a broken reading on an aligned profile is the panel's, never a bend", () => {
        // what makes the split above honest, as an identity rather than a caveat: on a
        // collinear profile the only branch of `handleState` that can return broken is the
        // short-side one, so `broken` counts exactly the two-sided keys whose shorter
        // handle falls under ALIGN_PX — at ANY scale. Shrink the lab's panel and the count
        // climbs (0 at full scale, 3 at half, 71 at quarter over the corpus's twenty
        // solves) while not one profile changes. Stage 3's splits shorten Δs-dominated
        // handles, so this is the reading that keeps a smaller drawn handle from arriving
        // as a vocabulary failure.
        const totals = new Map<number, number>([
            [1, 0],
            [0.5, 0],
            [0.25, 0],
        ]);
        for (const s of scenarios)
            for (const mode of ["exact", "calm"] as const) {
                const out = aligned(s.name, mode);
                const sc = panelScale(out.points, out.length, out.ds);
                for (const [f, total] of totals) {
                    const scaled: Scale = { s: sc.s * f, g: sc.g * f };
                    let tiny = 0;
                    for (const p of out.points) {
                        if (!p.in || !p.out) continue;
                        if (Math.min(drawnPx(p.in, scaled), drawnPx(p.out, scaled)) < ALIGN_PX)
                            tiny++;
                    }
                    const { broken } = census(out.points, scaled);
                    expect(broken).toBe(tiny);
                    totals.set(f, total + broken);
                }
            }
        expect(totals.get(1)).toBe(0);
        expect(totals.get(0.5)).toBeGreaterThan(0);
        expect(totals.get(0.25)).toBeGreaterThan(totals.get(0.5) as number);
    });

    test("the free family is untouched by the option existing", () => {
        // the negative control for the whole reparameterization: `handles` defaults to
        // free, and asking for it explicitly is the same solve to the last bit.
        const { s, entry, bake } = bakeOf("valley-explicit");
        const f = fit(bake.fN, bake.ds, FIT_TOL);
        const base = { bake, entry, points: f.points, ds: s.ds };
        const implicit = polish(base);
        const explicit = polish({ ...base, handles: "free" });
        expect(implicit.handles).toBe("free");
        expect(explicit.iters).toBe(implicit.iters);
        expect(explicit.deviation).toBe(implicit.deviation);
        expect(explicit.maxDg).toBe(implicit.maxDg);
        for (let k = 0; k < implicit.keys; k++) {
            expect(explicit.points[k].g).toBe(implicit.points[k].g);
            expect(explicit.points[k].in?.dg).toBe(implicit.points[k].in?.dg);
        }
    });

    test("the prior prices the profile, not the family it is written in", () => {
        // the aligned Tikhonov coefficient is `Δg = m·Δs`'s chain rule — that side's Δs —
        // and the corpus alone cannot tell: a `fit.ts` warm start's handles are all
        // span/3, so a wrong-but-uniform coefficient just rescales λ and every solve
        // still converges. Price ONE hand-built profile in both families instead, with
        // spans an order apart, where the coefficient has nowhere to hide.
        //
        // The profile is already collinear (Δg = m·Δs at every key), so both families
        // represent it exactly and the seminorm — Σ Δg² over the four handle offsets —
        // must come out the same number, by hand:
        //
        //   key 0: m = 2,    out Δs = 1  → Δg = 2
        //   key 1: m = −1,   in  Δs = −1 → Δg = 1,   out Δs = 9 → Δg = −9
        //   key 2: m = 0.5,  in  Δs = −9 → Δg = −4.5
        //   Σ Δg² = 4 + 1 + 81 + 20.25 = 106.25
        //
        // Every value here is a dyadic rational, so the sum is exact in f64 and the
        // assert is an equality, not a tolerance.
        const pts: ForcePoint[] = [
            { s: 0, g: 1, out: { ds: 1, dg: 2 } },
            { s: 3, g: 4, in: { ds: -1, dg: 1 }, out: { ds: 9, dg: -9 } },
            { s: 30, g: 2, in: { ds: -9, dg: -4.5 } },
        ];
        for (const p of pts) expect(collinear(p.in, p.out)).toBe(true);

        const free = regRows(pts, "free");
        const alignedRows = regRows(pts, "aligned");
        // the row COUNT is the family-independent half (one row per handle offset), so it
        // is `wReg = λL/rows` that matches too, and equal seminorms mean equal Φ_reg.
        expect(free.length).toBe(4);
        expect(alignedRows.length).toBe(4);
        expect(regNorm(free, readDof(pts, "free"))).toBe(106.25);
        expect(regNorm(alignedRows, readDof(pts, "aligned"))).toBe(106.25);
    });

    test("the Δg prior reaches the aligned family through the slopes", () => {
        // the Tikhonov block penalizes the handle OFFSETS in both families; in the aligned
        // one it reaches them through `Δg = m·Δs`, chain rule and all. If those rows named
        // the wrong DOF — or none — calm mode would silently BE exact mode: converged,
        // reporting a λ, penalizing nothing. So drive λ to the strong end of the bracket
        // and check the handles actually go flat against the unregularized solve.
        const { s, entry, bake } = bakeOf("parabola-hill");
        const base = {
            bake,
            entry,
            points: fit(bake.fN, bake.ds, FIT_TOL).points,
            ds: s.ds,
            mode: "calm" as const,
            handles: "aligned" as const,
        };
        const strong = polish({ ...base, lambda: 1e3 });
        const none = polish({ ...base, lambda: 0 });
        expect(strong.maxDg).toBeLessThan(G_GRID / 2);
        expect(none.maxDg).toBeGreaterThan(10 * strong.maxDg);
    });

    test("aligned mode is deterministic: two solves are identical", () => {
        const { s, entry, bake } = bakeOf("full-loop");
        const f = fit(bake.fN, bake.ds, FIT_TOL);
        const base = { bake, entry, points: f.points, ds: s.ds, handles: "aligned" as const };
        const a = polish(base);
        const b = polish(base);
        expect(b.iters).toBe(a.iters);
        expect(b.deviation).toBe(a.deviation);
        for (let k = 0; k < a.keys; k++) {
            expect(b.points[k].g).toBe(a.points[k].g);
            expect(b.points[k].out?.dg).toBe(a.points[k].out?.dg);
        }
    });

    test("the spike scenario is approximated away, not fought", () => {
        // valley-explicit is the one shape the aligned family cannot draw at these knots
        // (a ~38 g spike narrower than a keyframe span). The authorability directive
        // sanctions the trade, and this is what it buys: the peak of the dense force it
        // drives falls by more than half, and every key stays authorable. What it COSTS
        // is the floor, pinned above — the pair is the input to stage 3's refine loop.
        const free = calmed("valley-explicit");
        const al = aligned("valley-explicit", "calm");
        expect(censusOf(free).broken).toBe(9);
        expect(censusOf(al).broken).toBe(0);
        expect(al.peakG).toBeLessThan(0.6 * free.peakG);
        expect(al.deviation).toBeGreaterThan(free.deviation);
    });
});

describe("constrained polish — the target spine", () => {
    for (const scenario of scenarios) {
        test(`${scenario.name}: spans the bake's arclength exactly, uniformly`, () => {
            const { bake } = bakeOf(scenario.name);
            const sp = spine(bake, scenario.ds);
            let total = 0;
            for (let i = 0; i < bake.edges; i++) total += bake.ds[i];
            expect(sp.length).toBeCloseTo(total, 12);
            // the grid spans the bake EXACTLY (ds = length/edges, not the nominal step):
            // at the nominal step the section would end up to ds/2 short of the shape it
            // reproduces, and the exit pin would be asking for a point the bake never had.
            expect(sp.ds * sp.edges).toBeCloseTo(sp.length, 9);
            expect(sp.edges).toBe(Math.round(total / scenario.ds));
            // the ends are the bake's own ends — the entry and the exit pin.
            expect(sp.x[0]).toBe(bake.posX[0]);
            expect(sp.y[0]).toBe(bake.posY[0]);
            expect(sp.x[sp.edges]).toBe(bake.posX[bake.edges]);
            expect(sp.y[sp.edges]).toBe(bake.posY[bake.edges]);
            expect(sp.theta[sp.edges]).toBe(bake.theta[bake.edges]);
        });
    }

    test("interpolates along the bake's chords, not across them", () => {
        // a straight 3-edge bake: every resampled point must land on the line.
        const bake = {
            posX: [0, 1, 2, 3],
            posY: [0, 1, 2, 3],
            theta: [0.25, 0.25, 0.25, 0.25],
            ds: [Math.SQRT2, Math.SQRT2, Math.SQRT2],
            edges: 3,
        };
        const sp = spine(bake, 0.7);
        expect(sp.length).toBeCloseTo(3 * Math.SQRT2, 12);
        for (let j = 0; j <= sp.edges; j++) {
            expect(sp.y[j]).toBeCloseTo(sp.x[j], 12);
            expect(sp.theta[j]).toBeCloseTo(0.25, 12);
            expect(Math.hypot(sp.x[j], sp.y[j])).toBeCloseTo(Math.min(j * sp.ds, sp.length), 9);
        }
    });

    test("rejects a bake it could not mean anything over", () => {
        const ok = { posX: [0, 1, 2], posY: [0, 0, 0], theta: [0, 0, 0], ds: [1, 1], edges: 2 };
        expect(() => spine({ ...ok, edges: 1 }, 0.5)).toThrow(/need >= 2 baked edges/);
        expect(() => spine(ok, 0)).toThrow(/ds must be > 0/);
        expect(() => spine(ok, Number.NaN)).toThrow(/ds must be > 0/);
        expect(() => spine({ ...ok, ds: [1, 0] }, 0.5)).toThrow(/ds\[1\] is 0/);
        expect(() => spine({ ...ok, ds: [1, -1] }, 0.5)).toThrow(/ds\[1\] is -1/);
        expect(() => spine({ ...ok, posY: [0, Number.NaN, 0] }, 0.5)).toThrow(/position 1/);
        expect(() => spine({ ...ok, theta: [0, 0, Number.NaN] }, 0.5)).toThrow(/theta 2/);
    });
});

describe("constrained polish — the atom", () => {
    test("rejects a warm start the formulation could not mean anything over", () => {
        const { s, entry, bake } = bakeOf("hill-auto");
        const base = { bake, entry, ds: s.ds };
        const two: ForcePoint[] = [
            { s: 0, g: 1, out: { ds: 1, dg: 0 } },
            { s: 3, g: 1, in: { ds: -1, dg: 0 } },
        ];
        expect(() => polish({ ...base, points: [two[0]] })).toThrow(/need >= 2 keyframes/);
        expect(() =>
            polish({
                ...base,
                points: [
                    { s: 3, g: 1, out: { ds: 1, dg: 0 } },
                    { s: 0, g: 1, in: { ds: -1, dg: 0 } },
                ],
            }),
        ).toThrow(/s must ascend/);
        expect(() => polish({ ...base, points: [{ s: 0, g: 1 }, two[1]] })).toThrow(
            /keyframe 0 has no out handle/,
        );
        expect(() => polish({ ...base, points: [two[0], { s: 3, g: 1 }] })).toThrow(
            /keyframe 1 has no in handle/,
        );
        expect(() =>
            polish({ ...base, points: [{ s: 0, g: Number.NaN, out: { ds: 1, dg: 0 } }, two[1]] }),
        ).toThrow(/keyframe 0 is not finite/);
    });

    test("rejects an entry the physics could not start from", () => {
        const { s, bake } = bakeOf("hill-auto");
        const f = fit(bake.fN, bake.ds, FIT_TOL);
        const base = { bake, points: f.points, ds: s.ds };
        // v = 0 makes v² = 0 at the entry itself: dθ divides by it. Before this guard the
        // solve ran all 24 outers and returned feasibility NaN.
        expect(() => polish({ ...base, entry: entryOf(0) })).toThrow(/entry speed must be > 0/);
        expect(() => polish({ ...base, entry: entryOf(-5) })).toThrow(/entry speed must be > 0/);
        expect(() => polish({ ...base, entry: entryOf(Number.NaN) })).toThrow(
            /entry speed must be > 0/,
        );
        expect(() => polish({ ...base, entry: { x: 0, y: Number.NaN, theta: 0, v: 22 } })).toThrow(
            /entry position\/heading is not finite/,
        );
    });

    test("rejects a bake the cart cannot reach, instead of reporting a perfect solve", () => {
        // A 30° climb from v0 = 12 runs out of energy at Δy = v0²/2g = 7.34 m. The warm
        // start IS the target geometry, so past that point Φ(z₀) = ∞, every trial step is
        // rejected, and the AL would hand back the UNTOUCHED warm start reporting
        // deviation 0 and exit 0 — a perfect-looking solve over a profile ~26 m off. This
        // is the geometry the live editor draws red-dashed (`bake.V_WARN`), a real
        // authored input; the guard turns a silent no-op into a refusal at the boundary.
        const entry = entryOf(12);
        const edges = 40;
        const th = Math.PI / 6;
        const posX = new Float32Array(edges + 1);
        const posY = new Float32Array(edges + 1);
        const theta = new Float32Array(edges + 1).fill(th);
        const ds = new Float32Array(edges).fill(0.5);
        for (let i = 0; i <= edges; i++) {
            posX[i] = 0.5 * i * Math.cos(th);
            posY[i] = 0.5 * i * Math.sin(th);
        }
        const climb = { posX, posY, theta, ds, edges };
        const points: ForcePoint[] = [
            { s: 0, g: 1, out: { ds: 20 / 3, dg: 0 } },
            { s: 20, g: 1, in: { ds: -20 / 3, dg: 0 } },
        ];
        expect(() => polish({ bake: climb, entry, points, ds: 0.5 })).toThrow(
            /bake is unreachable at sample \d+\/\d+/,
        );
        // the SAME shape entered faster is reachable (the 10 m crest needs v0 > 14.0) and
        // solves normally — the guard fires on the physics, not on the geometry.
        expect(() => polish({ bake: climb, entry: entryOf(16), points, ds: 0.5 })).not.toThrow();
    });

    test("honours the snapshot cap down to a single frame", () => {
        const { s, entry, bake } = bakeOf("hill-auto");
        const f = fit(bake.fN, bake.ds, FIT_TOL);
        for (const cap of [1, 2, 7]) {
            const out = polish({
                bake,
                entry,
                points: f.points,
                ds: s.ds,
                maxSnapshots: cap,
            });
            expect(out.snapshots.length).toBeGreaterThan(0);
            expect(out.snapshots.length).toBeLessThanOrEqual(cap);
            // whatever the cap, playback still ends on the answer.
            const last = out.snapshots[out.snapshots.length - 1];
            for (let k = 0; k < out.keys; k++) expect(last.points[k].g).toBe(out.points[k].g);
            expect(last.feasibility).toBeCloseTo(out.feasibility, 12);
        }
    });

    test("a flat bake is already exact: the polish holds it", () => {
        // a level straight run at 1 g is a fixed point of the whole pipeline — the force
        // that draws it is constant, so the polish must not move the geometry off it.
        const entry = entryOf(20);
        const edges = 40;
        const posX = new Float32Array(edges + 1);
        const posY = new Float32Array(edges + 1);
        const theta = new Float32Array(edges + 1);
        const ds = new Float32Array(edges).fill(0.5);
        for (let i = 0; i <= edges; i++) posX[i] = 0.5 * i;
        const bake = { posX, posY, theta, ds, edges };
        const out = polish({
            bake,
            entry,
            ds: 0.5,
            points: [
                { s: 0, g: 1, out: { ds: 20 / 3, dg: 0 } },
                { s: 20, g: 1, in: { ds: -20 / 3, dg: 0 } },
            ],
        });
        expect(out.converged).toBe(true);
        expect(out.deviation).toBeLessThan(1e-9);
        expect(out.exit.dist).toBeLessThan(TOL_FEAS);
        for (const p of out.points) expect(p.g).toBeCloseTo(1, 6);
    });
});
