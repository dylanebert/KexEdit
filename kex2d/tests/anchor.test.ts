import { describe, expect, test } from "bun:test";
import { recoveryRows } from "../src/anchor";
import { type Anchor, DEFAULT_BAND, solve } from "../src/solve";
import { forward64, type SampleState } from "./helpers/forward64";

/** roll out F_n over a uniform grid with the f64 forward integrator (source
 *  convention: F[i] drives step i→i+1). */
function rollout(F: Float64Array | Float32Array, ds: number, n: number, v0: number): SampleState[] {
    const fn = (sigma: number): number => F[Math.min(n - 1, Math.round(sigma / ds))];
    return forward64(0, 0, 0, v0, n, ds, fn);
}

/** a smooth, curved draft: a steady upward bias (θ° grows, v° drops — real
 *  curvature and a varying velocity, so the exact tangent model and the
 *  frozen-velocity sketch diverge) plus a gentle oscillation. */
function curvedDraft(n: number, ds: number): Float64Array {
    const F = new Float64Array(n);
    for (let i = 0; i < n; i++) F[i] = 1.12 + 0.35 * Math.sin((2 * Math.PI * (i * ds)) / 11);
    return F;
}

describe("anchor — recovery rows (linearized forward sensitivity)", () => {
    test("analytic rows match the finite-difference geometry Jacobian on a curved draft", () => {
        // the gate: the exact tangent model must reproduce the true ∂geometry/∂F
        // of forward64. central differences at EPS=1e-5 resolve f64 derivatives
        // to roundoff ~ ε_mach·|geom|/EPS ≈ 1e-10, so 1e-5 is a safe derived
        // tolerance (≫ FD error, ≪ the row signal). a curved draft (θ°≠0, v°
        // varying) is what distinguishes this from the frozen-velocity sketch.
        const n = 56;
        const ds = 0.5;
        const v0 = 28;
        const Eps = 1e-5;
        const F = curvedDraft(n, ds);
        const dsArr = new Float32Array(n - 1).fill(ds);

        const base = rollout(F, ds, n, v0);
        const theta = Float64Array.from(base, (s) => s[2]);
        const v = Float64Array.from(base, (s) => s[3]);
        // sanity: stays in the differentiable regime (v well above 0).
        expect(Math.min(...v)).toBeGreaterThan(5);

        for (const r of [Math.floor(n / 2), n - 1]) {
            const rows = recoveryRows(theta, v, dsArr, r);
            // FD Jacobian of (x_r, y_r, θ_r) w.r.t. each F[i].
            for (let i = 0; i < n; i++) {
                const fp = Float64Array.from(F);
                const fm = Float64Array.from(F);
                fp[i] += Eps;
                fm[i] -= Eps;
                const ep = rollout(fp, ds, n, v0)[r];
                const em = rollout(fm, ds, n, v0)[r];
                const fdx = (ep[0] - em[0]) / (2 * Eps);
                const fdy = (ep[1] - em[1]) / (2 * Eps);
                const fdt = (ep[2] - em[2]) / (2 * Eps);
                const tol = (m: number) => 1e-5 * (1 + Math.abs(m));
                expect(Math.abs(rows.x[i] - fdx)).toBeLessThan(tol(fdx));
                expect(Math.abs(rows.y[i] - fdy)).toBeLessThan(tol(fdy));
                expect(Math.abs(rows.theta[i] - fdt)).toBeLessThan(tol(fdt));
            }
            // causality: F[i≥r] cannot affect sample r.
            for (let i = r; i < n; i++) {
                expect(rows.x[i]).toBe(0);
                expect(rows.y[i]).toBe(0);
                expect(rows.theta[i]).toBe(0);
            }
        }
    });
});

describe("anchor — Woodbury solver integration", () => {
    test("the solved F satisfies the full dense normal equations A·F = b", () => {
        // independent of geometry: arbitrary dense anchor rows + smoothness + a
        // pin, no band (so no active set). assemble A = w_pos·I + w_s·DᵀD +
        // pin-diagonal + Σ w_a·rowᵀrow and b = w_pos·Fpos + pin + Σ w_a·(row·Fpos)·row
        // densely, and check the Woodbury output solves it.
        const n = 12;
        const wPos = 1;
        const wS = 6;
        const Fpos = new Float32Array(n);
        for (let i = 0; i < n; i++) Fpos[i] = 1 + 0.5 * Math.sin(0.7 * i) - 0.2 * Math.cos(0.3 * i);

        const r1 = new Float64Array(n);
        const r2 = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            r1[i] = Math.sin(0.4 * i + 0.2) * (i < 9 ? 1 : 0);
            r2[i] = (0.3 + 0.1 * i) * (i < 6 ? 1 : 0);
        }
        const anchors: Anchor[] = [
            { row: r1, weight: 3 },
            { row: r2, weight: 7 },
        ];
        const con = [{ index: 4, value: 2.5, weight: 5 }];

        const { fN } = solve(Fpos, { posWeight: wPos, smooth: wS, bandWeight: 0, con, anchors });

        // dense A and b.
        const A = Array.from({ length: n }, () => new Float64Array(n));
        const b = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            A[i][i] += wPos;
            b[i] += wPos * Fpos[i];
        }
        // w_s·DᵀD via the second-difference rows D[m] = [1,−2,1] at m,m+1,m+2.
        for (let m = 0; m + 2 < n; m++) {
            const idx = [m, m + 1, m + 2];
            const st = [1, -2, 1];
            for (let a = 0; a < 3; a++)
                for (let c = 0; c < 3; c++) A[idx[a]][idx[c]] += wS * st[a] * st[c];
        }
        A[con[0].index][con[0].index] += con[0].weight;
        b[con[0].index] += con[0].weight * con[0].value;
        for (const an of anchors) {
            let t = 0;
            for (let i = 0; i < n; i++) t += an.row[i] * Fpos[i];
            for (let i = 0; i < n; i++) {
                b[i] += an.weight * t * an.row[i];
                for (let j = 0; j < n; j++) A[i][j] += an.weight * an.row[i] * an.row[j];
            }
        }

        for (let i = 0; i < n; i++) {
            let row = 0;
            for (let j = 0; j < n; j++) row += A[i][j] * fN[j];
            expect(row).toBeCloseTo(b[i], 4);
        }
    });
});

describe("anchor — downstream geometry heal (red → green)", () => {
    test("a force pin swings downstream geometry; the recovery anchor heals it", () => {
        // a smooth draft → the un-pinned solve sits ≈ on it. a stiff pin off the
        // draft swings the whole downstream rigidly (RED). adding the recovery
        // anchor at r pulls geometry at and past r back to the draft (GREEN), and
        // the heal holds for the full downstream (r..end), not just r itself.
        const n = 96;
        const ds = 0.5;
        const v0 = 24;
        const k = Math.floor(0.25 * n);
        const r = Math.floor(0.7 * n);
        const opts = { posWeight: 1, smooth: 10, band: DEFAULT_BAND, bandWeight: 4 };

        const Fpos = new Float64Array(n);
        for (let i = 0; i < n; i++) Fpos[i] = 1 + 0.25 * Math.sin((2 * Math.PI * (i * ds)) / 14);
        const fpos32 = Float32Array.from(Fpos);

        const draft = rollout(Fpos, ds, n, v0);
        const theta = Float64Array.from(draft, (s) => s[2]);
        const vD = Float64Array.from(draft, (s) => s[3]);
        const dsArr = new Float32Array(n - 1).fill(ds);

        const con = [{ index: k, value: Fpos[k] + 1.2, weight: 1e4 }];
        const rows = recoveryRows(theta, vD, dsArr, r);
        const wA = 1e4;
        const anchors: Anchor[] = [
            { row: rows.x, weight: wA },
            { row: rows.y, weight: wA },
            { row: rows.theta, weight: wA },
        ];

        const red = rollout(solve(fpos32, { ...opts, con }).fN, ds, n, v0);
        const green = rollout(solve(fpos32, { ...opts, con, anchors }).fN, ds, n, v0);

        const off = (a: SampleState[], i: number): number =>
            Math.hypot(a[i][0] - draft[i][0], a[i][1] - draft[i][1]);

        // RED: the pin swings the endpoint far off the draft.
        const redEnd = off(red, n - 1);
        expect(redEnd).toBeGreaterThan(1); // metres — a large, real swing

        // GREEN: healed at the recovery point and held across the whole
        // downstream (r..end) — matching (x,y,θ) at r pins the full state, so
        // everything past r follows the draft. residual is the O(δ²) linearization
        // error, ~2 orders below the swing.
        expect(off(green, r)).toBeLessThan(redEnd / 50);
        expect(off(green, n - 1)).toBeLessThan(redEnd / 50);

        // upstream of the pin moves far less than the swing — a small fore-lobe
        // bleed (the single-point anchor reaches i<k; measured in anchor.lab.ts),
        // not the rigid downstream transform. honest bound, not "unchanged".
        expect(off(green, k)).toBeLessThan(redEnd / 3);
    });

    test("anchorWeight 0 leaves the base solve unchanged", () => {
        const n = 40;
        const Fpos = new Float32Array(n);
        for (let i = 0; i < n; i++) Fpos[i] = 1 + 0.4 * Math.sin(0.3 * i) + (i % 2 ? 0.1 : -0.1);
        const opts = { posWeight: 1, smooth: 8, band: DEFAULT_BAND, bandWeight: 4 };

        const zero: Anchor[] = [{ row: new Float64Array(n).fill(0.5), weight: 0 }];
        const base = solve(Fpos, opts);
        const withZero = solve(Fpos, { ...opts, anchors: zero });
        for (let i = 0; i < n; i++) expect(withZero.fN[i]).toBe(base.fN[i]);
    });
});
