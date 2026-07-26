import { describe, expect, test } from "bun:test";
import { ALIGN_PX, census, type Scale } from "../src/census";
import { fit } from "../src/fit";
import {
    applyDof,
    AUTHOR_EPS,
    authoringFloor,
    chordDeficit,
    fairNorm,
    fairRows,
    forceMatrix,
    type HandleDof,
    polish,
    type PolishResult,
    readDof,
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

// EXIT_ANG_TOL — the reference exit HEADING residual (rad), measured on the quantity a
// downstream section consumes: `evalForce` re-recovers its exit from the swept geometry
// (the one-display-path law), so the bar reads that bisector tangent, not the integrator's
// own θ. The solve pins the same recovered quantity (`polish.ts` `exitTheta`), so the only
// floor left is the f32 path's — ~1e-6 rad of accumulated rounding. The CEILING is the
// readout: `controls.formatDeg` prints one decimal, so 0.1° = 1.7e-3 rad is the coarsest
// heading error the surface could show. 1e-3 rad = 0.057° sits under it and three decades
// above the float floor. Measured worst over all 40 corpus solves: 1.3e-5 rad (7.3e-4°).
//
// It used to be the other way round: with the equality written in the INTEGRATOR's
// convention the recovered exit was free by ¼(θ_{E−2} − 2θ_{E−1} + θ_E) = O(ds²·κ′),
// which reached 3.6e-3 rad (0.21°) on loop-explicit aligned+calm and needed a named
// per-scenario exception. Pinning the recovery instead closed it by ~380× and the
// exception is gone.
const EXIT_ANG_TOL = 1e-3;

// A cold corpus solve's budget (ms). The solves are memoized per (scenario, mode, family),
// so whichever test touches a pair first pays for the whole thing — and a calm solve is a
// full discrepancy bisection, up to ten LM/PHR solves. Measured worst with this file run
// alone: 2.6 s (double-hump, aligned, both modes). `bun test` runs the 30 suite files
// concurrently and the whole-suite wall time varies ~2× with that contention, so bun's 5 s
// default leaves no margin — it fired on double-hump under load while the same test passes
// in 2.6 s alone. An order above the measurement still catches a genuine hang, since the
// AL's outer/inner caps bound a solve's work absolutely.
const SOLVE_MS = 30_000;

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

/** the fairing seminorm of an answer, read in the family it was solved in — `∫(F″)² ds`,
 *  the quantity the prior prices and the one that survives the operator change. `maxDg`
 *  measures a handle's SIZE, which a chord-aligned handle on a steep ramp makes large by
 *  construction, so it is a per-scenario pin here and never a cross-mode bar. */
function roughnessOf(r: PolishResult): number {
    return fairNorm(fairRows(r.points, r.handles), readDof(r.points, r.handles));
}

/** `∫(F″)² ds` by NUMERICAL QUADRATURE — the seminorm's own definition, independent of
 *  `fairRows`'s algebra at every step: F comes from `profile.sampleForce` (the shipped
 *  bezier + root solve), F″ from a central second difference of it, and the integral from
 *  4-point Gauss-Legendre inside each segment — never across a knot, where F″ jumps.
 *
 *  This is the truth `fairRows` is checked against, and the only way to price a profile
 *  that has left the span/3 reach family (where the closed form stops being exact).
 *  4-point Gauss-Legendre on [−1, 1] (Abramowitz & Stegun table 25.4), exact for the
 *  degree-6 integrand a cubic's (F″)² would be even before the difference stencil. */
const Gx = [-0.8611363115940526, -0.3399810435848563, 0.3399810435848563, 0.8611363115940526];
const Gw = [0.3478548451374538, 0.6521451548625461, 0.6521451548625461, 0.3478548451374538];
function quadRoughness(pts: readonly ForcePoint[]): number {
    let total = 0;
    for (let k = 0; k + 1 < pts.length; k++) {
        const span = pts[k + 1].s - pts[k].s;
        const mid = 0.5 * (pts[k].s + pts[k + 1].s);
        const h = span / 100;
        let acc = 0;
        for (let i = 0; i < Gx.length; i++) {
            const at = mid + 0.5 * span * Gx[i];
            const f2 =
                (sampleForce(pts, at + h) - 2 * sampleForce(pts, at) + sampleForce(pts, at - h)) /
                (h * h);
            acc += Gw[i] * f2 * f2;
        }
        total += 0.5 * span * acc;
    }
    return total;
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
// reason: what the prior can reach is a property of the shape, the keyframe placement, and
// where the bisection lands, and no closed form bounds it. These are the drift tripwires for
// the before/after that is the human check-in's verdict input (spec stage 6), not derived
// bars. `peakG` is the peak of the DENSE force the profile drives (the one that catches
// inter-key overshoot invisible in the diamonds); `maxDg` the largest handle offset an
// author would have to grab.
//
// Each is the measured value plus ~10% headroom. The headroom is deliberate: the discrepancy
// search lands wherever a bisection branch falls, and several scenarios' accepted λ sit
// under 1% below their floor — one flipped branch there moves λ by a bisection step and the
// violence with it, which is drift to look at, not a regression. The real teeth are
// elsewhere in this block: the seminorm falling against exact, and the strict-reduction
// assert on the spike scenarios.
//
// RE-PINNED for the fairing seminorm (spec stage 2), everything else held. The handle
// numbers rose across the board and that is the operator, not a regression: the flat Δg
// prior drove handles to zero (four scenarios pinned at the G_GRID/2 floor, i.e. every
// segment flat = all-Cubic), while the fairing prior prices CURVATURE and leaves a
// chord-aligned handle — large Δg, straight line — free. Read the peaks for violence: they
// moved by less than ±5% except loop-explicit, which halved (29.8 → 28.5 free, 29.8 → 14.3
// in the aligned family).
const CalmViolence: Record<string, { peakG: number; maxDg: number }> = {
    "circular-arc": { peakG: 2.04, maxDg: 0.25 },
    "parabola-hill": { peakG: 3.73, maxDg: 1.19 },
    "full-loop": { peakG: 7.13, maxDg: 2.23 },
    "s-curve": { peakG: 4.24, maxDg: 1.7 },
    "straight-fillet": { peakG: 3.45, maxDg: 1.87 },
    "hill-auto": { peakG: 4.76, maxDg: 1.86 },
    "hill-explicit": { peakG: 3.22, maxDg: 1.75 },
    "loop-explicit": { peakG: 31.3, maxDg: 16.4 },
    "double-hump": { peakG: 4.48, maxDg: 1.64 },
    "valley-explicit": { peakG: 38.7, maxDg: 51.6 },
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
            test(
                "re-integrated through the live evalForce path, the exit is still pinned",
                () => {
                    const out = calmed(scenario.name);
                    expect(out.converged).toBe(true);
                    expect(out.feasibility).toBeLessThan(TOL_FEAS);
                    const r = reference(scenario.name, out.points, out.length, out.ds);
                    expect(r.exit).toBeLessThanOrEqual(EXIT_TOL);
                    expect(r.exitTheta).toBeLessThanOrEqual(EXIT_ANG_TOL);
                },
                SOLVE_MS,
            );

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
                // the cross-mode invariant, in the prior's OWN quantity: whatever geometry
                // slack calm mode spends, it buys a smoother profile than the exact solve
                // it traded away. Measured margin is 3 to 13 orders of magnitude on nine
                // scenarios and 1.9× on valley-explicit, whose fallback finds little slack.
                // `peakG` is NOT a cross-mode bar — the answer is free to sit anywhere
                // inside the authoring floor and the fairing prior does not price the peak.
                //
                // Strict only where a prior was actually applied: the documented λ = 0
                // fallback returns solve(0), which IS the exact answer, so equality there
                // is the contract rather than a regression.
                if (cm.lambda > 0) expect(roughnessOf(cm)).toBeLessThan(roughnessOf(ex));
                else expect(roughnessOf(cm)).toBeLessThanOrEqual(roughnessOf(ex));
                // and `maxDg` still falls in the FREE family — every one of the ten, by 1.2×
                // (valley-explicit) to 10.6× (full-loop). Handle size stopped measuring
                // violence under this prior, but "the calm answer's handles are no larger
                // than the exact answer's" remains an invariant here, not a pin, because a
                // free handle's Δs is fixed: only its Δg moves, so a smoother profile cannot
                // reach further. The ALIGNED family is where it genuinely breaks (one slope
                // serves both sides, so a chord-aligned handle grows), which is why this
                // assert lives in the free block alone.
                expect(cm.maxDg).toBeLessThanOrEqual(ex.maxDg);
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
        // the negative control for the fairing block. Same loosened floor, no penalty —
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
        // and the profile is exact mode's to the last bit, seminorm included — which is
        // why the per-scenario roughness comparison above allows EQUALITY at λ = 0 rather
        // than demanding a strict reduction. This is the branch that says so; the free
        // corpus never lands on the fallback, the aligned family does.
        expect(roughnessOf(out)).toBe(roughnessOf(ex));
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
        // loop-explicit's whole free family fits inside its floor, so the strong-end probe
        // holds on the first try and the bisection never runs. Its λ is LAM_MAX — the end
        // of the bracket, not a discrepancy point the search located — and the answer sits
        // in the seminorm's NULL SPACE: piecewise-linear in s, roughness collapsed to
        // rounding (1e-11 against the warm start's 3.9e+5, seventeen orders). That is what
        // "the strong end is strong enough" means, and it is the assert that would catch a
        // bracket whose top no longer reaches.
        const { bake } = bakeOf("loop-explicit");
        const warm = fit(bake.fN, bake.ds, FIT_TOL).points;
        const out = calmed("loop-explicit");
        expect(out.solves).toBe(1);
        expect(out.lambda).toBe(1e3);
        expect(roughnessOf(out)).toBeLessThan(
            1e-6 * fairNorm(fairRows(warm, "free"), readDof(warm, "free")),
        );
    });

    test(
        "calm mode is deterministic: two solves are identical",
        () => {
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
        },
        SOLVE_MS,
    );
});

// ─────────────────────────────────────────────────────────────────────────────────────
// The AUTHORABLE DOF family (`handles: "aligned"`, spec `kex2d-geoforce-convert` lock 1):
// one slope `m` per key instead of two independent handle Δg, so a BROKEN key is
// unrepresentable rather than penalized.
//
// THE ATTRIBUTION RUN — the DOF restriction alone, prior unchanged (the flat Δg Tikhonov it
// was run under, pushed through the reparameterization, so λ measured the same quantity in
// both families). Final-frame censuses only; violence numbers are ds-dependent, so read them
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
// The finding carried into stage 2: **the vocabulary constraint fixes the census, not
// the magnitudes.** loop-explicit's exact-mode handles get 13× LOUDER under the
// restriction — aligned, and enormous — because near the geometry floor the problem is
// ill-posed in both families and nothing in the DOF choice prefers a quiet slope.
//
// STAGE 2's answer to that, measured: the exact-mode numbers above are UNTOUCHED by the
// fairing seminorm, and structurally so — exact mode carries no prior at all (λ = 0), which
// is what makes it the oracle baseline. The 1866 is therefore not a number any prior can
// move; only calm mode has a prior to change. There the fairing seminorm halves the spike
// scenario's dense peak in this family (loop-explicit 29.8 → 14.3 g) and un-saturates the
// vocabulary (below), while handle SIZES rise, since a chord-aligned handle is large and
// straight. Violence lives in `CalmViolence`, per scenario, for that reason.
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

/** the DENSE peak the aligned answer drives (g) — the violence bar for this family, pinned
 *  per scenario at the measured value plus ~10% headroom, one-sided, exactly as
 *  `CalmViolence` is and PROVISIONAL for the same reason. `maxDg` is deliberately not here:
 *  under the fairing prior a chord-aligned handle on a steep ramp is a large Δg drawing a
 *  straight line, so handle size stopped measuring violence (the metric law, spec lock 2)
 *  and the dense peak is what an author feels.
 *
 *  The headline these guard is loop-explicit: the flat Δg prior left it at 29.8 g, the
 *  fairing seminorm halves it to 14.3. Nothing pinned that before.
 *
 *  Read them as tripwires per scenario, never as a cross-mode bar — calm makes the peak
 *  slightly WORSE than the aligned exact solve on five of the ten (parabola-hill 3.30 →
 *  3.71, s-curve 3.97 → 4.23, hill-auto 4.18 → 4.41, hill-explicit 2.87 → 2.89,
 *  double-hump 4.18 → 4.49). That is the discrepancy principle spending geometry slack it
 *  is allowed to spend: the prior prices the seminorm, not the peak, and inside the
 *  authoring floor the answer is free to sit anywhere. */
const AlignedCalmPeak: Record<string, number> = {
    "circular-arc": 2.0,
    "parabola-hill": 4.09,
    "full-loop": 6.73,
    "s-curve": 4.66,
    "straight-fillet": 2.93,
    "hill-auto": 4.86,
    "hill-explicit": 3.18,
    "loop-explicit": 15.7,
    "double-hump": 4.94,
    "valley-explicit": 17.6,
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
            test(
                "converges in the aligned family, both modes",
                () => {
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
                },
                SOLVE_MS,
            );

            test("re-integrated through the live evalForce path, the exit is pinned", () => {
                // one bar for both modes and every scenario: the exception the
                // integrator-convention pin needed is gone (`EXIT_ANG_TOL`).
                for (const mode of ["exact", "calm"] as const) {
                    const out = aligned(scenario.name, mode);
                    const r = reference(scenario.name, out.points, out.length, out.ds);
                    expect(r.exit).toBeLessThanOrEqual(EXIT_TOL);
                    expect(r.exitTheta).toBeLessThanOrEqual(EXIT_ANG_TOL);
                }
            });

            test("the dense peak it drives is inside its pinned violence", () => {
                const out = aligned(scenario.name, "calm");
                const pin = AlignedCalmPeak[scenario.name];
                expect(pin).toBeDefined();
                expect(out.peakG).toBeLessThanOrEqual(pin);
                // the reported peak is the profile's own, not a solver diagnostic.
                expect(violence(out.points, out.length, out.ds).peakG).toBeCloseTo(out.peakG, 12);
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
                // this panel is 0.86 px against a 0.5 px threshold — hill-auto exact — so
                // the identical profiles census 1 broken on a half-scale panel and 32 on a
                // quarter-scale one (pinned below). Read a
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
        // climbs (0 at full scale, 1 at half, 32 at quarter over the corpus's twenty
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

    test("no aligned solve saturates the λ bracket", () => {
        // The bracket's top is argued safe by REACHING the seminorm's null space: four
        // free-mode scenarios clip at `LAM_MAX` with their roughness collapsed to rounding,
        // and a seminorm cannot go under zero, so a wider top would buy nothing there.
        // That argument covers the free family ONLY. The aligned family's null space is
        // just 2-D (one slope per key, so only a globally straight profile is free), and no
        // aligned solve in this corpus can sit in it while holding the floor — every one of
        // them stops short. So `LAM_MAX` is doing no work in this family, and if it ever
        // did, the answer would be a clip rather than a located discrepancy point and the
        // bracket would need re-arguing. Measured largest accepted aligned λ: 8.4e+1,
        // 1.1 decades under the top.
        let worst = 0;
        for (const s of scenarios) worst = Math.max(worst, aligned(s.name, "calm").lambda);
        expect(worst).toBeLessThan(1e3);
        expect(worst).toBeLessThan(0.2 * 1e3);
        // and the free family DOES reach it — the negative control that keeps the assert
        // above from passing on a bracket that nothing can ever hit.
        expect(calmed("loop-explicit").lambda).toBe(1e3);
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
        // the aligned fairing coefficient is `Δg = m·Δs`'s chain rule — that side's Δs —
        // and the corpus alone cannot tell: a `fit.ts` warm start's handles are all
        // span/3, so a wrong-but-uniform coefficient just rescales λ and every solve
        // still converges. Price ONE hand-built profile in both families instead, with
        // spans an order apart, where the coefficient has nowhere to hide.
        //
        // The profile is collinear (Δg = m·Δs at every key) and its handles reach span/3,
        // so both families represent it exactly and the seminorm — ∫(F″)² ds, closed form
        // 12(A² + AB + B²)/span³ per segment over the control-value second differences
        // A = P₀ − 2P₁ + P₂, B = P₁ − 2P₂ + P₃ — must come out the same number, by hand:
        //
        //   key 0: m = 3,    out Δs = 2/3  → Δg = 2
        //   key 1: m = −6,   in  Δs = −2/3 → Δg = 4,   out Δs = 16/3 → Δg = −32
        //   key 2: m = 1.5,  in  Δs = −16/3 → Δg = −8
        //
        //   segment 0 (span 2,  Δg_chord 4):  A = 4,  B = −10 → 76·12/2³    = 114
        //   segment 1 (span 16, Δg_chord −8): A = 48, B = −8  → 1984·12/16³ = 5.8125
        //   ∫(F″)² ds = 119.8125
        //
        // Every control value is dyadic, so the hand sum is exact; the rows carry an
        // irrational √(12/span³) each, so the READ is exact to f64 rounding, not to the bit.
        const pts: ForcePoint[] = [
            { s: 0, g: 1, out: { ds: 2 / 3, dg: 2 } },
            { s: 2, g: 5, in: { ds: -2 / 3, dg: 4 }, out: { ds: 16 / 3, dg: -32 } },
            { s: 18, g: -3, in: { ds: -16 / 3, dg: -8 } },
        ];
        for (const p of pts) expect(collinear(p.in, p.out)).toBe(true);

        const free = fairRows(pts, "free");
        const alignedRows = fairRows(pts, "aligned");
        // two rows per SEGMENT in both families — the square root of the segment energy's
        // 2×2 form — so `wFair = λ` matches too and equal seminorms mean equal Φ_fair.
        expect(free.length).toBe(4);
        expect(alignedRows.length).toBe(4);
        expect(fairNorm(free, readDof(pts, "free"))).toBeCloseTo(119.8125, 9);
        expect(fairNorm(alignedRows, readDof(pts, "aligned"))).toBeCloseTo(119.8125, 9);
    });

    test("the closed-form fairing matrix IS ∫(F″)² ds — against quadrature", () => {
        // THE ORACLE for the prior. `fairRows` is derived algebra (the Bernstein second
        // differences, integrated), and algebra is exactly what a typo hides in — a wrong
        // 1.5, a √3/2 on the wrong row, a span power off by one all still produce a PSD
        // form that converges. So integrate the seminorm's own definition NUMERICALLY,
        // through the production evaluator, and demand the closed form reproduce it.
        //
        // The quadrature (`quadRoughness`) is independent of the algebra under test at
        // every step — see its own note.
        //
        // TOL: the difference stencil is EXACT here (its error term carries F⁗, zero for a
        // cubic), so the error is the root solve's, `S_TOL_REL` = 1e-13 of the span in s,
        // which enters as |F′|·1e-13·span / h² ≈ 1e-9 against an F″ of order 1 at
        // h = span/100. Squared and integrated that is ~1e-8 relative; 1e-6 clears it by
        // two decades and is still four decades tighter than any algebra slip.

        // a deterministic LCG, not Math.random: a corpus of profiles that differs per run
        // would make a failure unreproducible.
        let seed = 20260726;
        const rnd = (): number => {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            return seed / 0x7fffffff;
        };
        let worst = 0;
        for (let trial = 0; trial < 20; trial++) {
            const K = 3 + Math.floor(rnd() * 5);
            const pts: ForcePoint[] = [];
            let s = 0;
            for (let k = 0; k < K; k++) {
                pts.push({ s, g: (rnd() - 0.5) * 20 });
                s += 1 + rnd() * 12;
            }
            // span/3 handles, the fit family the closed form is exact on. Half the trials
            // get a collinear profile so the aligned family represents it too.
            const align = trial % 2 === 0;
            for (let k = 0; k + 1 < K; k++) {
                const reach = (pts[k + 1].s - pts[k].s) / 3;
                pts[k].out = { ds: reach, dg: (rnd() - 0.5) * 8 };
                pts[k + 1].in = { ds: -reach, dg: (rnd() - 0.5) * 8 };
            }
            if (align)
                for (const p of pts) {
                    const m = (rnd() - 0.5) * 4;
                    if (p.in) p.in.dg = m * p.in.ds;
                    if (p.out) p.out.dg = m * p.out.ds;
                }
            const num = quadRoughness(pts);
            expect(num).toBeGreaterThan(1e-3); // a flat corpus would prove nothing
            const families: HandleDof[] = align ? ["free", "aligned"] : ["free"];
            for (const handles of families) {
                const closed = fairNorm(fairRows(pts, handles), readDof(pts, handles));
                worst = Math.max(worst, Math.abs(closed - num) / num);
            }
        }
        expect(worst).toBeLessThan(1e-6);
    });

    test("the fairing prior reaches the aligned family through the slopes", () => {
        // the fairing block prices the same curvature in both families; in the aligned one
        // it reaches the handles through `Δg = m·Δs`, chain rule and all. If those rows
        // named the wrong DOF — or none — calm mode would silently BE exact mode:
        // converged, reporting a λ, penalizing nothing. So drive λ to the strong end of the
        // bracket and check the seminorm actually collapses against the unregularized
        // solve. It is the SEMINORM that has to fall, not `maxDg`: a chord-aligned handle
        // on a steep ramp is a large Δg drawing a straight line, which is what this prior
        // wants and the old flat one forbade.
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
        expect(roughnessOf(strong)).toBeLessThan(0.01 * roughnessOf(none));
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

    // ---- the CORNER: the one broken-key state, introduced only by the refine loop ----

    /** a profile with a genuine SLOPE BREAK at its middle key — in-slope 0.4 against
     *  out-slope 0.9 — with every reach at span/3 so the closed form still applies. The
     *  aligned family cannot draw this; the corner family can. */
    const kinked: ForcePoint[] = [
        { s: 0, g: 1, out: { ds: 2, dg: 1.2 } },
        { s: 6, g: 3, in: { ds: -2, dg: -0.8 }, out: { ds: 3, dg: 2.7 } },
        { s: 15, g: 2, in: { ds: -3, dg: 1.5 } },
    ];

    test("an empty corner set is the plain aligned family, column for column", () => {
        // the negative control for the whole discrete state: a solve with no corners must be
        // the stage-1/2 aligned layout, or stage 3 would have moved the fixed-knot answer.
        const pts = fit(bakeOf("hill-auto").bake.fN, bakeOf("hill-auto").bake.ds, FIT_TOL).points;
        expect(readDof(pts, "aligned", [])).toEqual(readDof(pts, "aligned"));
        expect(fairRows(pts, "aligned", [])).toEqual(fairRows(pts, "aligned"));
        const dof = readDof(pts, "aligned");
        expect(applyDof(pts, "aligned", dof, [])).toEqual(applyDof(pts, "aligned", dof));
    });

    test("a corner is one more DOF, and it unbinds that key's two sides", () => {
        expect(readDof(kinked, "aligned", [1]).length).toBe(readDof(kinked, "aligned").length + 1);
        // every slot in the corner layout carries exactly ONE side here, so the projection is
        // exact and the round-trip reproduces the kink.
        const back = applyDof(kinked, "aligned", readDof(kinked, "aligned", [1]), [1]);
        expect(back).toEqual(kinked);
        expect(collinear(back[1].in, back[1].out)).toBe(false);
        // without the corner the same read least-squares both sides onto one slope, which is
        // the vocabulary constraint doing its job: the kink is unrepresentable.
        const flat = applyDof(kinked, "aligned", readDof(kinked, "aligned"));
        expect(collinear(flat[1].in, flat[1].out)).toBe(true);
        expect(flat).not.toEqual(kinked);
    });

    test("the corner layout prices ∫(F″)² like every other — freedom, not a discount", () => {
        // λ must price the same function of the PROFILE whichever layout carries it, or the
        // discrepancy search could buy a lower fairing energy by declaring a corner instead
        // of by getting smoother. Checked against the free family (which represents the kink
        // exactly too) AND against the quadrature oracle, so a mis-routed slope cannot hide.
        expect(applyDof(kinked, "free", readDof(kinked, "free"))).toEqual(kinked);
        const free = fairNorm(fairRows(kinked, "free"), readDof(kinked, "free"));
        const corner = fairNorm(fairRows(kinked, "aligned", [1]), readDof(kinked, "aligned", [1]));
        expect(corner).toBeCloseTo(free, 9);
        expect(corner).toBeCloseTo(quadRoughness(kinked), 6);
        // and the absolute number, so the three readings agreeing on ZERO would still fail.
        expect(corner).toBeCloseTo(0.4091, 3);
    });

    test("a corner solve still locates a real lambda, and does not clip the bracket", () => {
        // `LAM_MAX`'s safety argument is made for the FREE family and leans, for aligned, on
        // that family's null space being 2-D. A corner makes a slope break at its key free, so
        // the corner family's null space is strictly LARGER and the plain-aligned headroom pin
        // does not transfer — measured, circular-arc accepts 1.8e+2 with a corner against
        // 8.4e+1 without, so the corner family sits CLOSER to the top of the bracket. Still
        // clear of it; if this ever clips, the reported lambda is a bracket artifact by the
        // module's own reasoning and the top needs re-arguing.
        const { s: sc, entry, bake } = bakeOf("circular-arc");
        const warm = fit(bake.fN, bake.ds, FIT_TOL).points;
        const opts = { bake, entry, points: warm, ds: sc.ds, mode: "calm" as const };
        const plain = polish({ ...opts, handles: "aligned" as const });
        const broken = polish({ ...opts, handles: "aligned" as const, corners: [2] });
        for (const r of [plain, broken]) {
            expect(r.converged).toBe(true);
            expect(r.heldFloor).toBe(true);
            expect(r.lambda).toBeGreaterThan(0);
            expect(r.lambda).toBeLessThan(1e3);
        }
        expect(broken.lambda).toBeGreaterThan(plain.lambda);
        expect(broken.corners).toEqual([2]);
    });

    test("a corner outside the aligned family, or at an end, is refused", () => {
        // refused at the boundary for the reason every other option here is: each of these
        // silently produces a DOF layout whose columns no longer mean what `slopeSlots` says.
        const { s: sc, entry, bake } = bakeOf("circular-arc");
        const warm = fit(bake.fN, bake.ds, FIT_TOL).points;
        const call = (o: Record<string, unknown>) =>
            polish({ bake, entry, points: warm, ds: sc.ds, ...o });
        expect(() => call({ handles: "free", corners: [1] })).toThrow(/aligned-family state/);
        expect(() => call({ handles: "aligned", corners: [0] })).toThrow(/interior key index/);
        expect(() => call({ handles: "aligned", corners: [1.5] })).toThrow(/interior key index/);
        expect(() => call({ handles: "aligned", corners: [2, 1] })).toThrow(/corners must ascend/);
    });
});

describe("constrained polish — the deviation profile", () => {
    // `deviations` is a SECOND implementation of the loop `deviation`/`at` come from, and it
    // is the array `refine.ts` reads to decide where every split, stall verdict, and corner
    // goes. An off-by-one in it would leave `deviation`/`at` correct and every refinement
    // decision quietly wrong, so its contract is pinned against the readings it must agree
    // with rather than against itself.
    test("it resolves the same reading the max was taken over", () => {
        for (const name of ["circular-arc", "hill-auto", "valley-explicit"]) {
            const r = solved(name).out;
            expect(r.deviations.length).toBe(r.edges + 1);
            // state 0 is the pinned entry, so it is exactly 0 — not merely small.
            expect(r.deviations[0]).toBe(0);
            expect(Math.max(...r.deviations)).toBe(r.deviation);
            expect(r.deviations[r.at]).toBe(r.deviation);
            expect(r.at).toBeGreaterThan(0);
            for (const d of r.deviations) expect(Number.isFinite(d)).toBe(true);
        }
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

    test("rejects a warm start that has left the span/3 reach family", () => {
        // THE DOMAIN GUARD. `fairRows` is closed-form only where every handle reaches
        // span/3 in s — that is what keeps s(t) linear in the bezier parameter, so F is an
        // ordinary cubic in s and the Bernstein second differences integrate to
        // 12(A² + AB + B²)/span³. Off that family the same expression prices the
        // CHORD-parameterized cubic through the same four control values, which is a
        // different curve, and it mis-prices SILENTLY: the form stays PSD, the solve still
        // converges, and the answer is regularized against a roughness nobody asked for.
        //
        // Both directions of the error, measured here rather than asserted in prose:
        const span = 2;
        const key = (reach: number): ForcePoint[] => [
            { s: 0, g: 0, out: { ds: reach, dg: 1 } },
            { s: span, g: 1, in: { ds: -reach, dg: 1 } },
        ];
        //   under-price: the closed form is blind to the reach (it reads the four control
        //   VALUES), so shortening the handles leaves it at 6.00 on this profile while the
        //   true energy climbs — 10.9 at span/4, 30.7 at span/10, a 5.1× under-price. The
        //   bar is 4× because the claim is "silently wrong", not a tuned ratio.
        const short = key(span / 10);
        expect(
            fairNorm(fairRows(key(span / 3), "free"), readDof(key(span / 3), "free")),
        ).toBeCloseTo(quadRoughness(key(span / 3)), 6);
        expect(quadRoughness(short)).toBeGreaterThan(
            4 * fairNorm(fairRows(short, "free"), readDof(short, "free")),
        );
        //   over-price: `Easing.Linear`'s reach 0 with chord-aligned Δg draws a straight
        //   line — true roughness zero — and the closed form charges for it anyway. This
        //   is the one stage 4's quantizer will meet, since a named tag leaves the family.
        const straight: ForcePoint[] = [
            { s: 0, g: 0, out: { ds: 0, dg: 0 } },
            { s: span, g: 1, in: { ds: 0, dg: 0 } },
        ];
        expect(quadRoughness(straight)).toBeLessThan(1e-6);
        expect(fairNorm(fairRows(straight, "free"), readDof(straight, "free"))).toBeGreaterThan(1);

        // so `polish` refuses the input at the boundary rather than solving against a
        // prior that means something else.
        const { s, entry, bake } = bakeOf("hill-auto");
        const base = { bake, entry, ds: s.ds };
        for (const reach of [span / 4, span / 10, 0, span / 2])
            expect(() => polish({ ...base, points: key(reach) })).toThrow(
                /handle reaches .* not the span\/3/,
            );
        // one side off is enough — the guard reads each side, not their sum.
        expect(() =>
            polish({
                ...base,
                points: [
                    { s: 0, g: 0, out: { ds: span / 3, dg: 1 } },
                    { s: span, g: 1, in: { ds: -span / 4, dg: 1 } },
                ],
            }),
        ).toThrow(/keyframe 1 in handle reaches/);
        // and the family itself passes, at both signs of the in-side convention.
        expect(() => polish({ ...base, points: key(span / 3) })).not.toThrow();
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

        // and the SINGLE-EDGE grid, the other branch of the recovered exit-heading stencil
        // (`polish.ts` `exitTheta`): with one edge there is no θ_{E−2} to extrapolate from,
        // so `bake.forces` reads the exit as the bare chord bisector and the pin has to
        // match that instead of the three-term form. Reachable whenever the nominal step is
        // coarser than ⅔ of the section, and it would otherwise index a state that is not
        // there.
        const one = polish({
            bake,
            entry,
            ds: 20,
            points: [
                { s: 0, g: 1, out: { ds: 20 / 3, dg: 0 } },
                { s: 20, g: 1, in: { ds: -20 / 3, dg: 0 } },
            ],
        });
        expect(one.edges).toBe(1);
        expect(one.converged).toBe(true);
        expect(Math.abs(one.exit.dtheta)).toBeLessThan(TOL_FEAS);
        expect(one.exit.dist).toBeLessThan(TOL_FEAS);
    });
});
