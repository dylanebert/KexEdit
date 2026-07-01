import { describe, expect, test } from "bun:test";
import { bandFactor, bandSolve, bandStore } from "../src/banded";
import { invert } from "../src/bake";
import { collocate, normalBand } from "../src/collocate";
import { forceJacobian, forces64 } from "../src/force";
import { denseSolveSpd } from "../src/solve";
import { forward64 } from "./helpers/forward64";
import { rk4 } from "./oracles/rk4";

const G = 9.80665;
const EPS = 2.220446049250313e-16;
const R = 12; // arc centered at (0, R), radius R, launched horizontally (θ₀=0)
const V0 = 30;

/** uniform-arclength circular arc + its continuum analytic force. */
function arc(N: number, ds: number) {
    const x = new Float64Array(N);
    const y = new Float64Array(N);
    const fStar = new Float64Array(N);
    for (let i = 0; i < N; i++) {
        const s = i * ds;
        x[i] = R * Math.sin(s / R);
        y[i] = R * (1 - Math.cos(s / R));
        const v2 = V0 * V0 - 2 * G * y[i];
        fStar[i] = v2 / (R * G) + Math.cos(s / R);
    }
    return { x, y, fStar };
}

/** perturb interior nodes in the local arc normal by amp·sin(2π s/Λ). */
function perturb(x: Float64Array, y: Float64Array, ds: number, amp: number, lambda = 6) {
    const px = Float64Array.from(x);
    const py = Float64Array.from(y);
    for (let i = 1; i < x.length - 1; i++) {
        const s = i * ds;
        const w = amp * Math.sin((2 * Math.PI * s) / lambda);
        px[i] += w * -Math.sin(s / R);
        py[i] += w * Math.cos(s / R);
    }
    return { px, py };
}

/** max distance of any interior node to the analytic circle — the
 *  parametrization-invariant shape metric (force fixes shape, not spacing). */
function shapeDev(x: Float64Array, y: Float64Array) {
    let m = 0;
    for (let i = 1; i < x.length - 1; i++)
        m = Math.max(m, Math.abs(Math.hypot(x[i], y[i] - R) - R));
    return m;
}

/** dense 2M×2M `JᵀJ` reconstructed independently from `forceJacobian`, the
 *  reference the banded assembly is checked against. */
function denseJtJ(x: Float64Array, y: Float64Array, N: number, ds: number): Float64Array {
    const M = N - 2;
    const n = 2 * M;
    const J = forceJacobian(x, y, N, ds, V0).entries;
    const dense = new Float64Array(n * n);
    const col = (node: number, axis: number) =>
        node >= 1 && node <= N - 2 ? 2 * (node - 1) + axis : -1;
    for (let i = 1; i < N - 1; i++) {
        const r = i - 1;
        const nodes = [i - 1, i - 1, i, i, i + 1, i + 1];
        for (let p = 0; p < 6; p++) {
            const cp = col(nodes[p], p % 2);
            if (cp < 0) continue;
            for (let q = 0; q < 6; q++) {
                const cq = col(nodes[q], q % 2);
                if (cq < 0) continue;
                dense[cp * n + cq] += J[r * 6 + p] * J[r * 6 + q];
            }
        }
    }
    return dense;
}

describe("normalBand — assembly matches an independent dense JᵀJ", () => {
    const ds = 0.25;
    const N = 40;
    const { x, y, fStar } = arc(N, ds);
    const { px, py } = perturb(x, y, ds, 0.1);

    test("the banded storage expands to the dense JᵀJ entrywise", () => {
        const sys = normalBand(px, py, N, ds, V0, fStar, 1);
        const dense = denseJtJ(px, py, N, ds);
        const n = sys.n;
        // expand the lower band to dense and compare both triangles.
        for (let i = 0; i < n; i++) {
            for (let k = 0; k <= 5; k++) {
                const j = i - k;
                if (j < 0) continue;
                const banded = sys.band[k][i];
                const ref = dense[i * n + j];
                // same products summed in a different order: f64 accumulation only.
                expect(Math.abs(banded - ref)).toBeLessThan(1e-9 * (1 + Math.abs(ref)));
            }
        }
    });

    test("the damped system solves identically banded vs dense (κ-scaled tol)", () => {
        const sys = normalBand(px, py, N, ds, V0, fStar, 1);
        const n = sys.n;
        const dense = denseJtJ(px, py, N, ds);
        // Weyl: adding μI floors every eigenvalue by μ, so λ_min ≥ μ; Gershgorin
        // bounds λ_max ≤ max row sum. κ is then derived, not assumed.
        let mu = 0;
        for (let k = 0; k < n; k++) mu = Math.max(mu, sys.band[0][k]);
        mu *= 1e-3;
        let maxRow = 0;
        for (let i = 0; i < n; i++) {
            let row = mu; // the added diagonal
            for (let j = 0; j < n; j++) row += Math.abs(dense[i * n + j]);
            maxRow = Math.max(maxRow, row);
        }
        const kappa = maxRow / mu;

        const rhs = new Float64Array(n);
        for (let i = 0; i < n; i++) rhs[i] = Math.sin(1.3 * i + 0.2);

        // banded solve of (JᵀJ + μI).
        const damped = [
            new Float64Array(n),
            sys.band[1],
            sys.band[2],
            sys.band[3],
            sys.band[4],
            sys.band[5],
        ];
        for (let k = 0; k < n; k++) damped[0][k] = sys.band[0][k] + mu;
        const L = bandStore(n, 5);
        const d = new Float64Array(n);
        const yb = new Float64Array(n);
        const xb = new Float64Array(n);
        bandFactor(damped, n, 5, L, d);
        bandSolve(L, d, n, 5, rhs, xb, yb);

        // dense reference.
        const denseD = Float64Array.from(dense);
        for (let i = 0; i < n; i++) denseD[i * n + i] += mu;
        const xd = denseSolveSpd(denseD, Float64Array.from(rhs), n);

        for (let i = 0; i < n; i++)
            expect(Math.abs(xb[i] - xd[i])).toBeLessThan(100 * n * EPS * kappa);
    });
});

describe("normalBand — rank-deficient without damping, SPD with it", () => {
    // the data Jacobian is M×2M: force is one scalar per node, position two DOF,
    // so JᵀJ has an M-dim tangential null space and its LDLᵀ hits a non-positive
    // pivot. LM's μI floors every eigenvalue by μ (Weyl) ⇒ all pivots > 0.
    const ds = 0.25;
    const N = 40;
    const { x, y } = arc(N, ds);
    const { px, py } = perturb(x, y, ds, 0.1);
    const sys = normalBand(px, py, N, ds, V0, new Float64Array(N), 1);
    const n = sys.n;

    test("the undamped data-only factor has a non-positive pivot", () => {
        const L = bandStore(n, 5);
        const d = new Float64Array(n);
        bandFactor(sys.band, n, 5, L, d);
        let bad = 0;
        for (let k = 0; k < n; k++) if (!(d[k] > 0)) bad++;
        expect(bad).toBeGreaterThan(0);
    });

    test("adding μI makes every pivot positive", () => {
        let mu = 0;
        for (let k = 0; k < n; k++) mu = Math.max(mu, sys.band[0][k]);
        mu *= 1e-3;
        const damped = [
            new Float64Array(n),
            sys.band[1],
            sys.band[2],
            sys.band[3],
            sys.band[4],
            sys.band[5],
        ];
        for (let k = 0; k < n; k++) damped[0][k] = sys.band[0][k] + mu;
        const L = bandStore(n, 5);
        const d = new Float64Array(n);
        bandFactor(damped, n, 5, L, d);
        for (let k = 0; k < n; k++) expect(d[k]).toBeGreaterThan(0);
    });
});

describe("collocate — reproduces the analytic optimum", () => {
    test("circle shape recovery is O(ds²)", () => {
        // force fixes shape (not parametrization), and forces64 is O(ds²) vs the
        // continuum; the well-conditioned geometry solve carries that order into
        // the recovered shape ⇒ ~4×/halving, the same 2nd-order signature as
        // force.test.ts's circle test. The ratio IS the evidence.
        const dev = (ds: number) => {
            const N = Math.floor(15 / ds) + 1;
            const { x, y, fStar } = arc(N, ds);
            const { px, py } = perturb(x, y, ds, 0.1);
            const res = collocate({ fTarget: fStar, x0: px, y0: py, ds, v0: V0 });
            return shapeDev(res.x, res.y);
        };
        const e0 = dev(0.5);
        const e1 = dev(0.25);
        const e2 = dev(0.125);
        expect(e0).toBeLessThan(5e-3); // coarse absolute cap
        expect(e0 / e1).toBeGreaterThan(3.5);
        expect(e0 / e1).toBeLessThan(4.5);
        expect(e1 / e2).toBeGreaterThan(3.5);
        expect(e1 / e2).toBeLessThan(4.5);
    });

    test("a straight incline (κ=0) is recovered to ~machine (μI backstops the thin block)", () => {
        // central differences are exact on a line (x''=y''=0), so forces64(line) is
        // exact and the recovered shape is machine-limited, not O(ds²). Exercises
        // the κ→0 branch of forceJacobian where the curvature block is thinnest.
        const ds = 0.5;
        const N = 30;
        const beta = 0.3;
        const x = new Float64Array(N);
        const y = new Float64Array(N);
        const fStar = new Float64Array(N);
        for (let i = 0; i < N; i++) {
            x[i] = i * ds * Math.cos(beta);
            y[i] = i * ds * Math.sin(beta);
            fStar[i] = Math.cos(beta);
        }
        const px = Float64Array.from(x);
        const py = Float64Array.from(y);
        const nx = -Math.sin(beta);
        const ny = Math.cos(beta);
        for (let i = 1; i < N - 1; i++) {
            const w = 0.15 * Math.sin((2 * Math.PI * i) / 7);
            px[i] += w * nx;
            py[i] += w * ny;
        }
        const res = collocate({ fTarget: fStar, x0: px, y0: py, ds, v0: V0 });
        // distance of each node to the exact line through the origin.
        let dev = 0;
        for (let i = 1; i < N - 1; i++)
            dev = Math.max(dev, Math.abs(nx * res.x[i] + ny * res.y[i]));
        expect(res.converged).toBe(true);
        expect(res.minPivot).toBeGreaterThan(0);
        expect(dev).toBeLessThan(1e-6);
    });
});

describe("collocate — convergence", () => {
    test("residual → 0 on an exactly achievable target", () => {
        // F* = forces64(arc) lives on the discrete manifold, so the minimum has
        // residual 0 (no discretization floor) — this separates "optimizer
        // converged" from the O(ds²) discretization-limited circle test.
        const ds = 0.25;
        const N = Math.floor(15 / ds) + 1;
        const { x, y } = arc(N, ds);
        const fAch = forces64(x, y, N, ds, V0).fN;
        const { px, py } = perturb(x, y, ds, 0.1);
        const res = collocate({ fTarget: fAch, x0: px, y0: py, ds, v0: V0 });
        expect(res.converged).toBe(true);
        expect(res.residual).toBeLessThan(1e-8);
    });

    test("line-searched LM descends monotonically and converges within a derived cap", () => {
        // each accepted LM step reduces Φ = ½‖r‖², so the recorded residual is
        // non-increasing (tiny f64 slack). small-residual GN is ~quadratic, so a
        // handful of iters suffice — assert ≤30 (a bound, not a tuned count).
        const ds = 0.25;
        const N = Math.floor(15 / ds) + 1;
        const { x, y, fStar } = arc(N, ds);
        const { px, py } = perturb(x, y, ds, 0.25, 5); // a rougher start
        const res = collocate({ fTarget: fStar, x0: px, y0: py, ds, v0: V0, maxIters: 30 });
        expect(res.converged).toBe(true);
        expect(res.iters).toBeLessThanOrEqual(30);
        for (let k = 1; k < res.history.length; k++)
            expect(res.history[k].residual).toBeLessThanOrEqual(
                res.history[k - 1].residual * (1 + 1e-9),
            );
    });
});

describe("collocate — forward-oracle self-consistency", () => {
    const ds = 0.25;
    const N = Math.floor(15 / ds) + 1;
    const { x, y, fStar } = arc(N, ds);
    const { px, py } = perturb(x, y, ds, 0.1);
    const res = collocate({ fTarget: fStar, x0: px, y0: py, ds, v0: V0 });

    test("forward(forces64(solved)) reproduces the solved endpoint within the conditioning envelope", () => {
        // recover force from the solved geometry, integrate it back from the pinned
        // start. This is the ill-conditioned inverse (σ_pos ~ N^1.56), so NOT
        // machine precision — bounded by σ_pos·‖δF‖ exactly as force.test.ts's
        // round-trip, where δF is the central-vs-source-convention force gap (O(ds)).
        const F64 = forces64(res.x, res.y, N, ds, V0).fN;
        const hat = forward64(res.x[0], res.y[0], 0, V0, N, ds, (s) => F64[Math.round(s / ds)]);
        const drift = Math.hypot(hat[N - 1][0] - res.x[N - 1], hat[N - 1][1] - res.y[N - 1]);

        // source-convention force implied by the solved geometry (bake.invert, the
        // integrator's exact reflection inverse); central−source is the O(ds) δF.
        const src = new Float32Array(N);
        invert(
            Float32Array.from(res.x),
            Float32Array.from(res.y),
            new Float32Array(N),
            new Float32Array(N),
            src,
            N,
            ds,
            0,
            V0,
        );
        let dF2 = 0;
        for (let i = 1; i < N - 1; i++) dF2 += (F64[i] - src[i]) ** 2;
        dF2 = Math.sqrt(dF2);

        // σ_pos: largest singular value of ∂(x,y)_end/∂F via central FD.
        const h = 1e-5;
        let aa = 0;
        let bb = 0;
        let cc = 0;
        for (let i = 0; i < N - 1; i++) {
            const fp = Float64Array.from(F64);
            const fm = Float64Array.from(F64);
            fp[i] += h;
            fm[i] -= h;
            const ep = forward64(res.x[0], res.y[0], 0, V0, N, ds, (s) => fp[Math.round(s / ds)])[
                N - 1
            ];
            const em = forward64(res.x[0], res.y[0], 0, V0, N, ds, (s) => fm[Math.round(s / ds)])[
                N - 1
            ];
            const jx = (ep[0] - em[0]) / (2 * h);
            const jy = (ep[1] - em[1]) / (2 * h);
            aa += jx * jx;
            cc += jy * jy;
            bb += jx * jy;
        }
        const disc = Math.sqrt(Math.max((aa + cc) ** 2 / 4 - (aa * cc - bb * bb), 0));
        const sigmaPos = Math.sqrt((aa + cc) / 2 + disc);

        expect(drift).toBeGreaterThan(1e-9); // the ill-conditioned inverse: not exact
        expect(drift).toBeLessThan(5 * sigmaPos * dF2); // bounded by the derived envelope
    });

    test("forward64 and rk4 agree on the solved force to O(ds²)", () => {
        // the two independent schemes integrate the identical solved force; their
        // gap is forward64's midpoint discretization (2nd order — it uses the
        // midpoint angle) against near-exact RK4, so it quarters with ds. The
        // oracle gate: an independent scheme + parameterization, not self-consistency.
        const gap = (ds: number) => {
            const N = Math.floor(15 / ds) + 1;
            const { x, y, fStar } = arc(N, ds);
            const { px, py } = perturb(x, y, ds, 0.1);
            const r = collocate({ fTarget: fStar, x0: px, y0: py, ds, v0: V0 });
            const F = forces64(r.x, r.y, N, ds, V0).fN;
            const fn = (s: number) => F[Math.round(s / ds)];
            const e = forward64(r.x[0], r.y[0], 0, V0, N, ds, fn)[N - 1];
            const o = rk4(r.x[0], r.y[0], 0, V0, N, ds, fn)[N - 1];
            return Math.hypot(e[0] - o[0], e[1] - o[1]);
        };
        const g0 = gap(0.5);
        const g1 = gap(0.25);
        expect(g0).toBeLessThan(5e-3); // coarse absolute cap
        expect(g0 / g1).toBeGreaterThan(3.5); // ~quarters with ds (2nd order)
        expect(g0 / g1).toBeLessThan(4.5);
    });
});
