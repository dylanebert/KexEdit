import { describe, expect, test } from "bun:test";
import { integrate } from "../src/forward";
import { DEFAULT_BAND, solve } from "../src/solve";
import { makeBuf } from "./helpers/buf";
import { rk4 } from "./oracles/rk4";

const G = 9.80665;

/** the curvature proxy the smoothness term minimizes: Σ (second difference)². */
function curvature(F: Float32Array): number {
    let s = 0;
    for (let i = 1; i < F.length - 1; i++) {
        const dd = F[i + 1] - 2 * F[i] + F[i - 1];
        s += dd * dd;
    }
    return s;
}

/** ‖a − b‖², the L2 gap used by the derived envelope. */
function l2sq(a: Float32Array, b: Float32Array): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) {
        const e = a[i] - b[i];
        s += e * e;
    }
    return s;
}

describe("solve — convex F_n optimizer", () => {
    test("smooth=0 with no band leaves the draft untouched (the L2 prior is its own fixed point)", () => {
        // pure data term ⇒ A = w_pos·I, b = w_pos·Fpos ⇒ F = Fpos exactly.
        const Fpos = new Float32Array([1, 0.4, 1.8, -0.3, 2.1, 0.9, 1.2, 0.6]);
        const { fN } = solve(Fpos, { smooth: 0, bandWeight: 0 });
        for (let i = 0; i < Fpos.length; i++) expect(fN[i]).toBeCloseTo(Fpos[i], 5);
    });

    test("smoothing drops the curvature proxy and stays inside the derived L2 envelope", () => {
        // a jagged prior — sample-to-sample reversals the comfort term should iron out.
        const n = 40;
        const Fpos = new Float32Array(n);
        for (let i = 0; i < n; i++)
            Fpos[i] = 1.5 + (i % 2 === 0 ? 0.6 : -0.6) + 0.3 * Math.sin(0.4 * i);
        const wPos = 1;
        const wS = 8;
        const { fN } = solve(Fpos, { posWeight: wPos, smooth: wS, bandWeight: 0 });

        // fN = Fpos is feasible, so objective(F*) ≤ objective(Fpos) = w_s·curvature(Fpos).
        // since objective(F*) ≥ w_s·curvature(F*), the curvature proxy cannot rise.
        expect(curvature(fN)).toBeLessThan(curvature(Fpos));

        // the same inequality bounds the data residual: w_pos·‖F*−Fpos‖² ≤ objective(F*)
        // ≤ w_s·curvature(Fpos) ⇒ ‖F*−Fpos‖² ≤ (w_s/w_pos)·curvature(Fpos). a derived
        // envelope, not a tuned tolerance (+ f32 slack).
        const envelope = (wS / wPos) * curvature(Fpos);
        expect(l2sq(fN, Fpos)).toBeLessThanOrEqual(envelope + 1e-5);
    });

    test("an out-of-band draft is pulled toward the band; a constant draft hits the closed form", () => {
        // constant prior + no smoothing ⇒ samples decouple. each minimizes
        // w_pos(F−Fpos)² + w_b(F−hi)² ⇒ F = (w_pos·Fpos + w_b·hi)/(w_pos+w_b).
        const lo = -2;
        const hi = 6;
        const n = 8;
        const over = 4; // Fpos = hi + 4 = 10, well above the ceiling
        const Fpos = new Float32Array(n).fill(hi + over);
        const wPos = 1;
        const wB = 9;
        const { fN } = solve(Fpos, { posWeight: wPos, smooth: 0, band: [lo, hi], bandWeight: wB });

        const expected = (wPos * (hi + over) + wB * hi) / (wPos + wB);
        for (let i = 0; i < n; i++) {
            expect(fN[i]).toBeCloseTo(expected, 4);
            expect(fN[i]).toBeLessThan(hi + over); // pulled in from the draft
            expect(fN[i]).toBeGreaterThan(hi); // soft hinge — sits just above the ceiling
        }

        // a stiff hinge drives it arbitrarily close to the band. the residual is
        // w_pos/(w_pos+w_b)·over, so w_b = 100 gives 4/101 ≈ 0.040 < 0.05 (derived).
        const stiff = solve(Fpos, { posWeight: wPos, smooth: 0, band: [lo, hi], bandWeight: 100 });
        for (let i = 0; i < n; i++) expect(stiff.fN[i] - hi).toBeLessThan(0.05);
    });

    test("an in-band draft is untouched by the hinge (zero penalty inside the band)", () => {
        // every sample within [−2, 6] ⇒ the hinge is inactive regardless of stiffness.
        const Fpos = new Float32Array([1, 0.5, 2, -1, 3, 0, 5.5, -1.8]);
        const { fN, iters } = solve(Fpos, {
            posWeight: 1,
            smooth: 0,
            band: DEFAULT_BAND,
            bandWeight: 1000,
        });
        for (let i = 0; i < Fpos.length; i++) expect(fN[i]).toBeCloseTo(Fpos[i], 5);
        expect(iters).toBe(1); // no active sample, so the first solve is already consistent
    });

    test("the minimum is unique; a warm start reaches it in one pass, a bad seed still converges", () => {
        const n = 24;
        const Fpos = new Float32Array(n);
        // a prior that pokes out of both ends of the band so the active set is non-trivial.
        for (let i = 0; i < n; i++) Fpos[i] = 2 + 6 * Math.sin(0.5 * i) + (i % 2 ? 0.4 : -0.4);
        const opts = { posWeight: 1, smooth: 2, band: DEFAULT_BAND, bandWeight: 20 };

        const cold = solve(Fpos, opts);
        const warm = solve(Fpos, { ...opts, warm: cold.fN });
        const bad = solve(Fpos, { ...opts, warm: new Float32Array(n).fill(999) });

        // same unique minimum no matter the start.
        for (let i = 0; i < n; i++) {
            expect(warm.fN[i]).toBeCloseTo(cold.fN[i], 5);
            expect(bad.fN[i]).toBeCloseTo(cold.fN[i], 5);
        }
        // seeding the active set from the solution converges immediately, where
        // the cold solve walks the active set out over several passes.
        expect(cold.iters).toBeGreaterThan(1);
        expect(warm.iters).toBe(1);
    });

    test("riding the solved F_n reproduces the independent RK4 oracle trajectory", () => {
        // gate the *positions* the solved force produces against the oracle, not
        // against forward.ts self-consistency: solve a gentle prior, then sample
        // the solved F_n at σ = i·ds (left endpoint, the integrator's source
        // convention) and drive both the f32 integrator and the f64 RK4 oracle.
        const n = 40;
        const ds = 0.2;
        const v0 = 14;
        const Fpos = new Float32Array(n);
        for (let i = 0; i < n; i++) Fpos[i] = 1 + 0.4 * Math.sin(0.3 * i) + (i % 2 ? 0.15 : -0.15);
        const { fN } = solve(Fpos, { posWeight: 1, smooth: 3, band: DEFAULT_BAND, bandWeight: 5 });

        const fn = (sigma: number): number => fN[Math.min(n - 1, Math.floor(sigma / ds + 1e-9))];

        const buf = makeBuf(n);
        buf.v[0] = v0;
        integrate(buf.posX, buf.posY, buf.theta, buf.v, n, ds, fn, G);
        const ref = rk4(0, 0, 0, v0, n, ds, fn, G);

        // O(Δs) semi-implicit-Euler error over ~7.8 m at ds = 0.2 stays well under
        // 0.05 (cf. the rk4-vs-forward gate in rk4.test.ts).
        let maxErr = 0;
        for (let i = 0; i < n; i++) {
            maxErr = Math.max(maxErr, Math.abs(buf.posX[i] - ref[i][0]));
            maxErr = Math.max(maxErr, Math.abs(buf.posY[i] - ref[i][1]));
        }
        expect(maxErr).toBeLessThan(0.05);
    });
});
