import { describe, expect, test } from "bun:test";
import { fit } from "../src/fit";
import { type ForcePoint, forceProfile, sampleForce, segmentControls } from "../src/profile";
import { scenarios } from "../src/scenarios";
import { evalGeo } from "../src/section";
import { G_GRID } from "../src/timeline";

// the geo→force spike's sparse-init step (kex/specs/kex2d-geoforce-spike.md stage 2):
// dense recovered F_n → sparse keyframes + explicit per-side tangents. the oracle is a
// round-trip through the PRODUCTION representation — every fit is re-sampled with
// `profile.sampleForce` / `forceProfile`, never with the fitter's own evaluator, so a
// convention mismatch (the σ frame, the handle sides, the x-monotonicity clamp) fails
// here instead of silently degrading stage 3's warm start.
//
// TOL: half the force axis's authoring quantum (`G_GRID` = 0.1 g, timeline.ts — the value
// grid a keyframe drag snaps to, i.e. the finest force an author can place). A fit inside
// half a quantum says the same thing as the dense curve in the authoring vocabulary. It is
// the domain's own unit, not a number tuned until the corpus passed.
//
// Geometry is a separate question from that bar, and stage 2 is not a valid convert
// because of it. The worst case is a CONSTANT 0.05 g bias, which integrates twice into
// ~½·ε·g·L²/v² ≈ 6 m over hill-auto — but a fit's error alternates sign, so it does not
// accumulate that way: re-integrating these fits through the real `evalForce` and matching
// by arclength measures 0.03–0.31 m on the eight smooth scenarios (hill-auto: 0.06 m).
// What actually breaks geometry is a NARROW spike: valley-explicit's 2-sample 38 g spike
// fits to 0.033 g yet lands 39.7 m off, because the error metric bounds the force at dense
// samples and says nothing about the integral BETWEEN them (one edge at 38 g and v = 14
// turns ~0.95 rad, so a fraction of a misplaced edge swings the rest of the track). A
// zero-sparsity control — a keyframe at every dense sample — deviates 0.04–7 m on its own,
// so most of this is the representation round-trip, not the sparsity. Closing geometry is
// stage 3's job (the constrained polish, warm-started from here); this file does not gate it.
const TOL = G_GRID / 2;

// `forceProfile` writes f32. The corpus peaks near 38 g (the loop-explicit /
// valley-explicit tangent-boundary spikes), so one f32 rounding is ≤ 38·2^-24 ≈ 2.3e-6;
// 1e-5 clears that with margin and stays three orders below TOL. The root solve adds
// |Δg|·1e-13 (profile.ts S_TOL_REL), negligible beside it.
const F32_TOL = 1e-5;

// keyframe counts measured at TOL over the fixed corpus, pinned as a ceiling (the
// `scenarios.test.ts` snapshot convention — a pin, not a tolerance). Fewer keys for the
// same tolerance is an improvement and passes; MORE is bloat and fails. What the numbers
// say: every shaping compresses 15–27× against the dense array except loop-explicit, whose
// FIVE Auto↔explicit tangent-boundary spikes (each a ~10-sample, 30–38 g skirt at a
// quadrant join) hold 21 of its 32 keys — 4.3×, against 7 keys for the same loop shaped
// with Auto tangents (full-loop). valley-explicit's single 2-sample spike is nearly free
// (2 of 11 keys). So a spike costs keys in proportion to its WIDTH, not its height, and
// only a multi-spike shaping pushes the count out of the smooth band.
const Keys: Record<string, number> = {
    "circular-arc": 4,
    "parabola-hill": 12,
    "full-loop": 7,
    "s-curve": 16,
    "straight-fillet": 6,
    "hill-auto": 13,
    "hill-explicit": 15,
    "loop-explicit": 32,
    "double-hump": 22,
    "valley-explicit": 11,
};

function bakeOf(name: string) {
    const s = scenarios.find((x) => x.name === name);
    if (!s) throw new Error(`no scenario named ${name}`);
    return { s, r: evalGeo({ x: 0, y: 0, theta: 0, v: s.v0 }, s.nodes, s.ds) };
}

/** the dense edges' arclengths, σ_i = Σ_{k<i} ds_k — the source-σ frame the fit, the
 *  bake, and `forceProfile` share. Recomputed here (same order, same f64 accumulation)
 *  so the test doesn't take the fitter's word for the frame. */
function sigmas(ds: ArrayLike<number>, edges: number): number[] {
    const out: number[] = [];
    let s = 0;
    for (let i = 0; i < edges; i++) {
        out.push(s);
        s += ds[i];
    }
    return out;
}

/** max |fitted − dense| over every dense edge, measured through `sampleForce`. */
function roundTrip(points: readonly ForcePoint[], fN: ArrayLike<number>, sigma: number[]) {
    let err = 0;
    let at = -1;
    sigma.forEach((s, i) => {
        const e = Math.abs(sampleForce(points, s) - fN[i]);
        if (e > err) {
            err = e;
            at = i;
        }
    });
    return { err, at };
}

describe("sparse init — the corpus fit", () => {
    test("every scenario has a pinned keyframe ceiling", () => {
        for (const s of scenarios) expect(Keys[s.name]).toBeDefined();
    });

    for (const scenario of scenarios) {
        describe(scenario.name, () => {
            test("re-sampled through sampleForce, every dense edge is within TOL", () => {
                const { r } = bakeOf(scenario.name);
                const f = fit(r.fN, r.ds, TOL);
                const sigma = sigmas(r.ds, r.edges);
                const { err, at } = roundTrip(f.points, r.fN, sigma);
                expect(err).toBeLessThanOrEqual(TOL);
                // the reported diagnostic IS that error, not a self-report from another
                // evaluator: the fitter's Bernstein-in-s eval and profile.ts's clamped
                // bezier + root solve must agree to f64 roundoff.
                expect(f.maxError).toBeCloseTo(err, 12);
                expect(f.at).toBe(at);
                // the extent the profile spans: the whole baked arclength, past the last
                // keyframe (which sits at the last dense edge's σ, one ds short of it).
                expect(f.length).toBeCloseTo(sigma[r.edges - 1] + r.ds[r.edges - 1], 12);
            });

            test("stays within its pinned keyframe ceiling, and stays sparse", () => {
                const { r } = bakeOf(scenario.name);
                const f = fit(r.fN, r.ds, TOL);
                expect(f.points.length).toBeLessThanOrEqual(Keys[scenario.name]);
                // "sparse" is definitional: a profile needing more than a keyframe per two
                // dense samples is the dense array in disguise. loop-explicit sits at
                // 32/138 — the corpus's spike-dominated worst case.
                expect(f.points.length).toBeLessThanOrEqual(Math.floor(r.edges / 2));
            });

            test("keyframes interpolate the dense curve at dense σ", () => {
                const { r } = bakeOf(scenario.name);
                const f = fit(r.fN, r.ds, TOL);
                const sigma = sigmas(r.ds, r.edges);
                for (const p of f.points) {
                    const i = sigma.indexOf(p.s);
                    expect(i).toBeGreaterThanOrEqual(0); // a knot lands ON a dense sample
                    expect(p.g).toBe(r.fN[i]); // and takes its value exactly
                    expect(sampleForce(f.points, p.s)).toBe(p.g);
                }
                expect(f.points[0].s).toBe(0);
                expect(f.points[f.points.length - 1].s).toBe(sigma[r.edges - 1]);
            });

            test("the x-monotonicity clamp never fires on fitted handles", () => {
                const { r } = bakeOf(scenario.name);
                const f = fit(r.fN, r.ds, TOL);
                for (let k = 0; k + 1 < f.points.length; k++) {
                    const a = f.points[k];
                    const b = f.points[k + 1];
                    const c = segmentControls(a, b);
                    // both handles reach span/3, so the pair reaches ⅔ of the span and
                    // `segment`'s clamp leaves them verbatim — the fit's linear-s(t)
                    // (hence cubic-in-s) assumption survives the production evaluator.
                    expect(c[1].s).toBe(a.s + a.out!.ds);
                    expect(c[1].g).toBe(a.g + a.out!.dg);
                    expect(c[2].s).toBe(b.s + b.in!.ds);
                    expect(c[2].g).toBe(b.g + b.in!.dg);
                    expect(c[1].s - a.s).toBeCloseTo((b.s - a.s) / 3, 12);
                }
            });

            // this is profile.ts self-consistency at UNIFORM σ — the fitted profile
            // evaluated two ways (the f32 dense array a force section integrates vs the
            // f64 point evaluator) at the same σ = i·ds. It is NOT the fit against the
            // dense input: those σ are the force section's frame, not the fit's cumulative
            // chords, and the values there are nobody's recovered force. What it pins is
            // that loading the fit as a force section reads the same curve back.
            test("the dense array a force section loads matches the point evaluator", () => {
                const { s, r } = bakeOf(scenario.name);
                const f = fit(r.fN, r.ds, TOL);
                const arr = forceProfile(f.points, f.length, s.ds);
                expect(arr.length).toBe(Math.round(f.length / s.ds));
                for (let i = 0; i < arr.length; i++) {
                    expect(Math.abs(arr[i] - sampleForce(f.points, i * s.ds))).toBeLessThanOrEqual(
                        F32_TOL,
                    );
                }
            });
        });
    }
});

describe("sparse init — the atom", () => {
    // the 2×2 Bernstein normal matrix over a full span has eigenvalues ∫B1²±∫B1B2 =
    // 0.150 and 0.021, so its condition number is ~7 and an f64 solve returns the
    // coefficients of O(1) data to ~7·2^-52 ≈ 1.6e-15. 1e-12 clears that with margin
    // while staying far below any real fit error.
    const Exact = 1e-12;
    const Ds = 0.5; // a power of two, so σ accumulates exactly

    function uniform(f: (s: number) => number, edges: number) {
        const fN = new Float64Array(edges);
        const ds = new Float64Array(edges).fill(Ds);
        for (let i = 0; i < edges; i++) fN[i] = f(i * Ds);
        return { fN, ds };
    }

    test("an empty input fits to nothing", () => {
        const f = fit([], [], TOL);
        expect(f.points).toEqual([]);
        expect(f.length).toBe(0);
        expect(f.maxError).toBe(0);
        expect(f.at).toBe(-1);
    });

    test("a single edge fits to one held keyframe", () => {
        const f = fit([2.5], [0.5], TOL);
        expect(f.points).toEqual([{ s: 0, g: 2.5 }]);
        expect(f.length).toBe(0.5);
        expect(f.maxError).toBe(0);
        expect(f.at).toBe(-1);
        expect(sampleForce(f.points, 0.25)).toBe(2.5);
    });

    test("a lone interior sample is interpolated, not averaged: no split", () => {
        // three samples, one interior — the normal equations are rank 1 there, but the
        // sample IS reachable: the minimum-norm correction to the chord hits it exactly.
        // A rank-0 chord fallback would miss by 4 g and split instead.
        const f = fit([1, 5, 2], [0.5, 0.5, 0.5], TOL);
        expect(f.points.length).toBe(2);
        expect(f.maxError).toBeLessThan(Exact);
        expect(f.at).toBe(-1);
        expect(sampleForce(f.points, 0.5)).toBeCloseTo(5, 12);
    });

    test("rejects an input it could not mean anything over", () => {
        expect(() => fit([1, 2], [0.5], TOL)).toThrow(/2 forces against 1 chords/);
        expect(() => fit([1, 2], [0.5, 0.5], -1)).toThrow(/tol must be >= 0/);
        expect(() => fit([1, 2], [0.5, 0.5], Number.NaN)).toThrow(/tol must be >= 0/);
        expect(() => fit([1, Number.NaN], [0.5, 0.5], TOL)).toThrow(/fN\[1\] is NaN/);
        expect(() => fit([1, Number.POSITIVE_INFINITY], [0.5, 0.5], TOL)).toThrow(/fN\[1\]/);
        expect(() => fit([1, 2], [0.5, 0], TOL)).toThrow(/ds\[1\] is 0/);
        expect(() => fit([1, 2], [0.5, -0.5], TOL)).toThrow(/ds\[1\] is -0.5/);
        expect(() => fit([1, 2], [0.5, Number.NaN], TOL)).toThrow(/ds\[1\] is NaN/);
        expect(() => fit([1, 2], [0.5, Number.POSITIVE_INFINITY], TOL)).toThrow(/ds\[1\]/);
    });

    test("a constant curve fits to two keyframes, exactly", () => {
        const { fN, ds } = uniform(() => 1.75, 40);
        const f = fit(fN, ds, TOL);
        expect(f.points.length).toBe(2);
        expect(f.maxError).toBeLessThan(Exact);
        expect(sampleForce(f.points, 7.3)).toBeCloseTo(1.75, 12);
    });

    test("a cubic curve is in the representation's own family: two keyframes, exactly", () => {
        // g(s) = 1 + 0.02s − 0.004s² + 0.00005s³ over 20 m. one bezier piece spans it, so
        // an adaptive fitter must not add a single interior knot.
        const cubic = (s: number) => 1 + 0.02 * s - 0.004 * s * s + 0.00005 * s * s * s;
        const { fN, ds } = uniform(cubic, 40);
        const f = fit(fN, ds, TOL);
        expect(f.points.length).toBe(2);
        expect(f.maxError).toBeLessThan(Exact);
        for (const s of [0.7, 4.2, 9.9, 15.5, 19.4]) {
            expect(sampleForce(f.points, s)).toBeCloseTo(cubic(s), 12);
        }
    });

    test("a tighter tolerance buys accuracy with keyframes", () => {
        const { fN, ds } = uniform((s) => 1 + Math.sin(s / 3), 200);
        const loose = fit(fN, ds, 0.1);
        const tight = fit(fN, ds, 0.001);
        expect(loose.maxError).toBeLessThanOrEqual(0.1);
        expect(tight.maxError).toBeLessThanOrEqual(0.001);
        expect(tight.points.length).toBeGreaterThan(loose.points.length);
    });
});
