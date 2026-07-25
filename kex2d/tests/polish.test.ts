import { describe, expect, test } from "bun:test";
import { fit } from "../src/fit";
import { polish, type PolishResult, spine, TOL_FEAS } from "../src/polish";
import { type ForcePoint, forceProfile, segmentControls } from "../src/profile";
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
                    expect(snap.x.length).toBe(out.edges + 1);
                    expect(snap.y.length).toBe(out.edges + 1);
                    expect(snap.fN.length).toBe(out.edges);
                    expect(snap.points.length).toBe(out.keys);
                    expect(Number.isFinite(snap.feasibility)).toBe(true);
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
