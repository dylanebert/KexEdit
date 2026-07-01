import { describe, expect, test } from "bun:test";
import { type ForceJac, forceJacobian, forces64 } from "../src/force";
import { forward64 } from "./helpers/forward64";

const G = 9.80665;
const EPS = 2.220446049250313e-16;

/** forward-integrate a per-node force (source convention F[i] drives i→i+1) into
 *  uniform-arclength positions — the integrator produces exactly ds-spaced
 *  samples, which is the grid forces64 expects. */
function rollout(F: Float64Array, N: number, ds: number, v0: number) {
    const traj = forward64(0, 0, 0, v0, N, ds, (s) => F[Math.min(N - 1, Math.round(s / ds))]);
    return {
        x: Float64Array.from(traj, (p) => p[0]),
        y: Float64Array.from(traj, (p) => p[1]),
        end: traj[N - 1],
    };
}

/** a gentle washboard force (in-band, no net turning): fixed per-length shape so
 *  only N scales — the conditioning.lab draft. */
function washboard(N: number, ds: number, amp = 0.3, lambda = 20): Float64Array {
    const F = new Float64Array(N);
    for (let i = 0; i < N; i++) F[i] = 1 + amp * Math.sin((2 * Math.PI * (i * ds)) / lambda);
    return F;
}

describe("forces64 — geometry→force accuracy", () => {
    test("matches the analytic circle force to O(ds²)", () => {
        // a constant-curvature arc (κ=1/R) sampled uniformly in arclength: an
        // exact continuum reference. central θ,κ are each 2nd-order, so the
        // geometry→force error is O(ds²) — the honest accuracy gate. R,v0 chosen
        // feasible (v² stays well above 0).
        const R = 12;
        const arcLen = 15;
        const v0 = 30;

        const err = (ds: number): number => {
            const N = Math.floor(arcLen / ds) + 1;
            const x = new Float64Array(N);
            const y = new Float64Array(N);
            for (let i = 0; i < N; i++) {
                const s = i * ds;
                x[i] = R * Math.sin(s / R);
                y[i] = R * (1 - Math.cos(s / R));
            }
            const { fN } = forces64(x, y, N, ds, v0);
            let m = 0;
            for (let i = 1; i < N - 1; i++) {
                const s = i * ds;
                const v2 = v0 * v0 - 2 * G * y[i];
                const analytic = v2 / R / G + Math.cos(s / R);
                m = Math.max(m, Math.abs(fN[i] - analytic));
            }
            return m;
        };

        const e0 = err(0.5);
        const e1 = err(0.25);
        const e2 = err(0.125);
        expect(e0).toBeLessThan(5e-3); // absolute at the coarse grid
        // halving ds quarters the error (2nd order). derived band [3.5, 4.5].
        expect(e0 / e1).toBeGreaterThan(3.5);
        expect(e0 / e1).toBeLessThan(4.5);
        expect(e1 / e2).toBeGreaterThan(3.5);
        expect(e1 / e2).toBeLessThan(4.5);
    });

    test("matches the integrator source force to O(ds), bounded by ½·ds·max|κ'|·v²/g", () => {
        // forces64 (node-centered, O(ds²) vs continuum) and the integrator's
        // forward-Euler source force differ by ½·ds·κ'·v²/g — an O(ds) *consistency*
        // gap that measures the integrator's discretization, not forces64's error.
        const v0 = 25;
        const arcLen = 40;

        const measure = (ds: number) => {
            const N = Math.floor(arcLen / ds) + 1;
            const F = washboard(N, ds);
            const { x, y } = rollout(F, N, ds, v0);
            const { fN: F64, kappa } = forces64(x, y, N, ds, v0);
            // interior, away from the extrapolated ends.
            let err = 0;
            let maxKp = 0;
            let maxV2 = 0;
            for (let i = 2; i < N - 2; i++) {
                err = Math.max(err, Math.abs(F64[i] - F[i]));
                maxKp = Math.max(maxKp, Math.abs((kappa[i + 1] - kappa[i - 1]) / (2 * ds)));
                maxV2 = Math.max(maxV2, v0 * v0 - 2 * G * y[i]);
            }
            return { err, bound: (0.5 * ds * maxKp * maxV2) / G };
        };

        const a = measure(0.5);
        const b = measure(0.25);
        expect(a.err).toBeLessThan(a.bound * 1.5); // the derived O(ds) envelope holds
        expect(a.err / b.err).toBeGreaterThan(1.6); // halving ds ~halves the error (1st order)
        expect(a.err / b.err).toBeLessThan(2.5);
    });

    test("position round-trip forward(forces64(P°)) stays within the conditioning envelope", () => {
        // the *inverse* composition: recover force from geometry, integrate it
        // back. this is the ill-conditioned direction (σ_pos ~ N^1.56), so it is
        // NOT machine-precision — it is bounded by the linear envelope σ_pos·‖δF‖.
        // its non-zero residual is exactly why the solver stays geometry-primal
        // (the machine-precision inverse lives in invertRange / bake.test.ts).
        const N = 80;
        const ds = 0.5;
        const v0 = 25;
        const F = washboard(N, ds);
        const p = rollout(F, N, ds, v0);
        const { fN: F64 } = forces64(p.x, p.y, N, ds, v0);

        const hat = rollout(F64, N, ds, v0);
        const drift = Math.hypot(hat.end[0] - p.end[0], hat.end[1] - p.end[1]);

        // δF (source-indexed) and its 2-norm.
        let dF2 = 0;
        for (let i = 0; i < N - 1; i++) dF2 += (F64[i] - F[i]) ** 2;
        dF2 = Math.sqrt(dF2);

        // σ_pos: largest singular value of ∂(x,y)_end/∂F via central FD (the
        // conditioning.lab method — 2×M Jacobian, σ_max from the 2×2 JJᵀ).
        const h = 1e-5;
        let aa = 0;
        let bb = 0;
        let cc = 0;
        for (let i = 0; i < N - 1; i++) {
            const fp = Float64Array.from(F);
            const fm = Float64Array.from(F);
            fp[i] += h;
            fm[i] -= h;
            const ep = rollout(fp, N, ds, v0).end;
            const em = rollout(fm, N, ds, v0).end;
            const jx = (ep[0] - em[0]) / (2 * h);
            const jy = (ep[1] - em[1]) / (2 * h);
            aa += jx * jx;
            cc += jy * jy;
            bb += jx * jy;
        }
        const disc = Math.sqrt(Math.max((aa + cc) ** 2 / 4 - (aa * cc - bb * bb), 0));
        const sigmaPos = Math.sqrt((aa + cc) / 2 + disc);

        expect(drift).toBeGreaterThan(1e-6); // the ill-conditioned inverse: not exact
        expect(drift).toBeLessThan(5 * sigmaPos * dF2); // but bounded by the derived envelope
    });
});

describe("forceJacobian — analytic ∂F/∂P vs central finite differences", () => {
    // a curved draft (θ°≠0, v° varying) exercises every chain-rule term. the
    // optimal central-FD step is h≈ε^{1/3}·L; κ's 1/ds² amplifies the entry
    // magnitudes but the relative agreement stays ≈1e-6 (a few orders above the
    // ε^{2/3} FD floor).
    const N = 56;
    const ds = 0.5;
    const v0 = 28;
    const draft = new Float64Array(N);
    for (let i = 0; i < N; i++) draft[i] = 1.12 + 0.35 * Math.sin((2 * Math.PI * (i * ds)) / 11);
    const { x, y } = rollout(draft, N, ds, v0);

    /** ∂F_i/∂(coord at node j) by central FD; axis 0=x, 1=y. */
    function fd(i: number, j: number, axis: 0 | 1): number {
        const arr = axis === 0 ? x : y;
        const h = Math.cbrt(EPS) * Math.max(1, Math.abs(arr[j]));
        const base = arr[j];
        arr[j] = base + h;
        const fp = forces64(x, y, N, ds, v0).fN[i];
        arr[j] = base - h;
        const fm = forces64(x, y, N, ds, v0).fN[i];
        arr[j] = base;
        return (fp - fm) / (2 * h);
    }

    test("the six in-band entries match FD entrywise", () => {
        const J: ForceJac = forceJacobian(x, y, N, ds, v0);
        const tol = (m: number) => 1e-6 * (1 + Math.abs(m));
        for (let i = 1; i < N - 1; i++) {
            const r = (i - 1) * 6;
            // column order [x_{i−1}, y_{i−1}, x_i, y_i, x_{i+1}, y_{i+1}].
            const checks: [number, number, 0 | 1][] = [
                [r + 0, i - 1, 0],
                [r + 1, i - 1, 1],
                [r + 2, i, 0],
                [r + 3, i, 1],
                [r + 4, i + 1, 0],
                [r + 5, i + 1, 1],
            ];
            for (const [slot, j, axis] of checks) {
                const f = fd(i, j, axis);
                expect(Math.abs(J.entries[slot] - f)).toBeLessThan(tol(f));
            }
        }
    });

    test("the Jacobian is banded — no dependence outside {i−1, i, i+1}", () => {
        // pick a mid row and FD against every node; only the 3-node window is
        // nonzero, confirming half-bandwidth 1 per coordinate.
        const i = 28;
        for (let j = 0; j < N; j++) {
            if (Math.abs(i - j) <= 1) continue;
            expect(Math.abs(fd(i, j, 0))).toBeLessThan(1e-7);
            expect(Math.abs(fd(i, j, 1))).toBeLessThan(1e-7);
        }
    });
});

describe("conditioning thesis — geometry→force is banded / flat in N", () => {
    // σ_max(∂F/∂P) is bounded by the max row 2-norm, which is set by the local
    // stencil (~v²/g/ds²) and is N-independent. contrast the force→geometry
    // direction, σ_pos ~ N^1.56 (conditioning.lab). the flatness is what makes
    // geometry the well-conditioned control.

    /** largest singular value of the banded J via power iteration on JᵀJ
     *  (matrix-free over the 6-entry interleaved rows). */
    function sigmaMax(J: ForceJac): number {
        const N = J.n;
        const cols = 2 * N;
        const M = N - 2;
        const colOf = (r: number, t: number): number => {
            const i = r + 1;
            const node = [i - 1, i - 1, i, i, i + 1, i + 1][t];
            return 2 * node + (t % 2); // even slot = x, odd = y
        };
        let v = new Float64Array(cols);
        for (let k = 0; k < cols; k++) v[k] = Math.sin(1.7 * k + 0.3);
        let sigma = 0;
        for (let iter = 0; iter < 60; iter++) {
            const w = new Float64Array(M); // w = J v
            for (let r = 0; r < M; r++) {
                let s = 0;
                for (let t = 0; t < 6; t++) s += J.entries[r * 6 + t] * v[colOf(r, t)];
                w[r] = s;
            }
            const u = new Float64Array(cols); // u = Jᵀ w
            for (let r = 0; r < M; r++)
                for (let t = 0; t < 6; t++) u[colOf(r, t)] += J.entries[r * 6 + t] * w[r];
            let norm = 0;
            for (let k = 0; k < cols; k++) norm += u[k] * u[k];
            norm = Math.sqrt(norm);
            sigma = Math.sqrt(norm); // λ_max(JᵀJ) = ‖u‖/‖v‖, v unit ⇒ σ = √λ
            v = new Float64Array(cols);
            for (let k = 0; k < cols; k++) v[k] = u[k] / norm;
        }
        return sigma;
    }

    test("σ_max(∂F/∂P) is flat in N (log-log slope < 0.2)", () => {
        const ds = 0.5;
        const v0 = 25;
        const Ns = [64, 128, 256, 512];
        const sig = Ns.map((N) => {
            const F = washboard(N, ds);
            const { x, y } = rollout(F, N, ds, v0);
            return sigmaMax(forceJacobian(x, y, N, ds, v0));
        });
        // log-log least-squares slope.
        const lx = Ns.map(Math.log);
        const ly = sig.map(Math.log);
        const mx = lx.reduce((s, v) => s + v, 0) / lx.length;
        const my = ly.reduce((s, v) => s + v, 0) / ly.length;
        let num = 0;
        let den = 0;
        for (let i = 0; i < Ns.length; i++) {
            num += (lx[i] - mx) * (ly[i] - my);
            den += (lx[i] - mx) ** 2;
        }
        const slope = num / den;
        expect(Math.abs(slope)).toBeLessThan(0.2);
    });
});
