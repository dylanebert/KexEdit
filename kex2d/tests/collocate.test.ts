import { describe, expect, test } from "bun:test";
import { bandFactor, bandSolve, bandStore } from "../src/banded";
import { forces as bakeForces, invert } from "../src/bake";
import { collocate, collocateAL, evaluate, normalBand } from "../src/collocate";
import { forceJacobian, forces64 } from "../src/force";
import { denseSolveSpd } from "./helpers/dense";
import { forward64 } from "./helpers/forward64";
import { loopTrack } from "./helpers/loop";
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
function denseJtJ(x: Float64Array, y: Float64Array, N: number): Float64Array {
    const M = N - 2;
    const n = 2 * M;
    const J = forceJacobian(x, y, N, V0).entries;
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
        const dense = denseJtJ(px, py, N);
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
        const dense = denseJtJ(px, py, N);
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
    test("circle recovery is gauge-limited without the chord term, ds-independent", () => {
        // the chord-based force map is parametrization-invariant, so the
        // initial perturbation's tangential component is frozen (LM never moves
        // in the null space). frozen ASYMMETRIC spacing biases the neighbor-
        // chord tangent (it is the arc-midpoint tangent, not the node tangent,
        // under asymmetric spacing), and the solver bends the curve slightly to
        // compensate — an O(amp²/R) shape deviation set by the perturbation,
        // NOT by ds. the evidence is ds-independence: halving ds leaves the
        // deviation unchanged (the old fixed-ds map was O(ds²) here).
        const dev = (ds: number) => {
            const N = Math.floor(15 / ds) + 1;
            const { x, y, fStar } = arc(N, ds);
            const { px, py } = perturb(x, y, ds, 0.1);
            const res = collocate({ fTarget: fStar, x0: px, y0: py, ds, v0: V0 });
            return shapeDev(res.x, res.y);
        };
        const e0 = dev(0.5);
        const e1 = dev(0.25);
        expect(e0).toBeLessThan(5e-3); // O(amp²/R) ≈ 8e-4 scale, with margin
        expect(e0 / e1).toBeGreaterThan(0.5); // ds-independent: ratio ≈ 1,
        expect(e0 / e1).toBeLessThan(2); // not the ≈4 of an O(ds²) mechanism
    });

    test("the chord term uniformizes spacing and restores near-exact recovery", () => {
        // with spacing pulled uniform, the neighbor-chord tangent is exact on
        // the circle (symmetric spacing) and Menger κ is exact at any spacing,
        // so recovery is limited by the arc-chord bias of the chord term itself
        // (per-edge pull ds³/24R² ≈ 4e-5 m, damped by the weight ratio
        // w_c·ds/wData = 0.05 → ~2e-6 m) plus LM tolerance. derived bound 1e-5
        // (~20× the mechanism scale). this is the chord term's production role:
        // grid quality, NOT gauge enforcement — the invariant map cannot be
        // cheated by sliding, so the weight stays small and bias negligible.
        const ds = 0.5;
        const N = Math.floor(15 / ds) + 1;
        const { x, y, fStar } = arc(N, ds);
        const { px, py } = perturb(x, y, ds, 0.1);
        const res = collocate({
            fTarget: fStar,
            x0: px,
            y0: py,
            ds,
            v0: V0,
            terms: { chord: { w: 0.1 } },
        });
        expect(res.converged).toBe(true);
        expect(shapeDev(res.x, res.y)).toBeLessThan(1e-5);
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
        const fAch = forces64(x, y, N, V0).fN;
        const { px, py } = perturb(x, y, ds, 0.1);
        const res = collocate({ fTarget: fAch, x0: px, y0: py, ds, v0: V0 });
        expect(res.converged).toBe(true);
        expect(res.residual).toBeLessThan(1e-8);
    });

    test("damped LM descends monotonically and converges within a derived cap", () => {
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
        const F64 = forces64(res.x, res.y, N, V0).fN;
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
            const F = forces64(r.x, r.y, N, V0).fN;
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

describe("stage 2 — residual-block assembly matches finite differences", () => {
    test("−rhs equals ∇Φ over pins + shifted band + shape + chord", () => {
        // every block live at once, on a generic (perturbed-arc) geometry: pins
        // (sparse wF), a band tight enough that both hinge sides have active
        // rows, AL shifts nonzero (the shifted-kink path), the roughness prior
        // toward the unperturbed draft, and the chord term. central FD of
        // `evaluate().phi` vs `normalBand`'s −rhs. FD tol: h=1e-6 central ⇒
        // O(h²·Φ''') ≈ 1e-9 relative to gradient scale; assert 1e-5 relative
        // (4 orders of margin, still far below any real assembly error).
        for (const shape of [
            { w: 2, order: 2 as const },
            { w: 2, order: 3 as const },
            { w: 2, kind: "magnitude" as const },
        ]) {
            const ds = 0.5;
            const N = 12;
            const { x, y } = arc(N, ds);
            const { px, py } = perturb(x, y, ds, 0.15);
            const fT = new Float64Array(N);
            const wF = new Float64Array(N);
            fT[3] = 0.5;
            wF[3] = 7;
            const shiftLo = new Float64Array(N).fill(0.05);
            const shiftHi = new Float64Array(N).fill(0.03);
            const terms = {
                wF,
                band: { lo: 0.9, hi: 1.6, w: 3, shiftLo, shiftHi },
                shape,
                chord: { w: 1.5 },
            };

            // the band must actually clip somewhere for the test to mean anything.
            const f = forces64(px, py, N, V0);
            let active = 0;
            for (let i = 1; i < N - 1; i++) {
                if (0.03 + f.fN[i] - 1.6 > 0 || 0.05 + 0.9 - f.fN[i] > 0) active++;
            }
            expect(active).toBeGreaterThan(0);

            const sys = normalBand(px, py, N, ds, V0, fT, 0, G, terms, x, y);
            const h = 1e-6;
            let scale = 0;
            let worst = 0;
            for (let k = 0; k < sys.n; k++) {
                const node = (k >> 1) + 1;
                const arr = (k & 1) === 0 ? px : py;
                const keep = arr[node];
                arr[node] = keep + h;
                const fp = evaluate(px, py, N, ds, V0, fT, 0, G, terms, x, y).phi;
                arr[node] = keep - h;
                const fm = evaluate(px, py, N, ds, V0, fT, 0, G, terms, x, y).phi;
                arr[node] = keep;
                const gFd = (fp - fm) / (2 * h);
                scale = Math.max(scale, Math.abs(gFd));
                worst = Math.max(worst, Math.abs(-sys.rhs[k] - gFd));
            }
            expect(worst).toBeLessThan(1e-5 * scale);
        }
    });
});

describe("stage 2 — the 0g loop (band + pin + prior)", () => {
    // the scenario: draft circle R=10 at v0=√(5gR) — F exactly 0g at the apex,
    // 6g at the bottom, 1g on the leads. comfort band [−1, 4]g is violated
    // across the whole bottom half; the solve must genuinely reshape. AL
    // schedule from the Stage-2 lab: cheap inners + frequent λ updates.
    const Lo = -1;
    const Hi = 4;
    const Al = { tol: 1e-3, outers: 40 };
    const Inner = 15;
    const Rho = 50;

    function loopOpts(t: ReturnType<typeof loopTrack>, fPin: number, hi = Hi) {
        const wF = new Float64Array(t.n);
        wF[t.apex] = 100;
        const fTarget = new Float64Array(t.n);
        fTarget[t.apex] = fPin;
        return {
            fTarget,
            x0: t.x,
            y0: t.y,
            ds: t.ds,
            v0: t.v0,
            wData: 0,
            terms: {
                wF,
                band: { lo: Lo, hi, w: Rho },
                shape: { w: 0.1 },
                chord: { w: 1 },
            },
            maxIters: Inner,
        };
    }

    /** independent re-check through the f32 bake (exact per-edge chords, a
     *  different code path): band violation of the solved GEOMETRY. */
    function bakeViol(
        t: ReturnType<typeof loopTrack>,
        rx: Float64Array,
        ry: Float64Array,
        hi = Hi,
    ) {
        const px = Float32Array.from(rx);
        const py = Float32Array.from(ry);
        const th = new Float32Array(t.n);
        const v = new Float32Array(t.n);
        const fN = new Float32Array(t.n);
        const dsArr = new Float32Array(t.n - 1);
        for (let i = 0; i < t.n - 1; i++)
            dsArr[i] = Math.hypot(px[i + 1] - px[i], py[i + 1] - py[i]);
        bakeForces(px, py, th, v, fN, dsArr, 0, t.n - 1, t.v0);
        let m = 0;
        for (let i = 1; i < t.n - 1; i++) m = Math.max(m, fN[i] - hi, Lo - fN[i]);
        return Math.max(0, m);
    }

    test("teardrop: AL satisfies the band and the pin hits its analytic curvature", () => {
        // pin F*=−0.3 at the apex: κ_a·v_a²/g = 1 + F* there, so the solved
        // apex curvature must be 0.70× the draft's (whose pin value is 0) —
        // an analytic prediction of the pin mechanism, not a snapshot.
        const t = loopTrack(10, 0.5, 15);
        const r = collocateAL(loopOpts(t, -0.3), Al);
        expect(r.converged).toBe(true);
        expect(r.maxViol).toBeLessThan(1e-3);

        const f = forces64(r.x, r.y, t.n, t.v0);
        const draft = forces64(t.x, t.y, t.n, t.v0);
        expect(Math.abs(f.fN[t.apex] - -0.3)).toBeLessThan(1e-2);
        const kRatio = f.kappa[t.apex] / draft.kappa[t.apex];
        expect(kRatio).toBeGreaterThan(0.68);
        expect(kRatio).toBeLessThan(0.72);

        // the independent f32 bake sees the same geometry inside the band up to
        // the node-vs-edge centering gap: forces64 is node-centered, the bake
        // edge-centered, differing by ½·ds·|F'| ≈ 0.08g at ds=0.5 on the loop's
        // transitions (measured 0.14 in the lab); bound at 0.3 = ~2× measured.
        expect(bakeViol(t, r.x, r.y)).toBeLessThan(0.3);

        for (let i = 0; i < t.n; i++) {
            expect(Number.isFinite(r.x[i])).toBe(true);
            expect(Number.isFinite(r.y[i])).toBe(true);
        }
    });

    test("plain hinge penalty stalls at the kink; AL converges to tolerance", () => {
        // the architecture decision, pinned: at any fixed penalty weight the
        // hinge's curvature discontinuity leaves a finite violation (measured
        // ~1.5e-2 across w ∈ [1e2, 1e4] in the lab — more weight does NOT
        // help); the PHR shifts move the kink off the boundary and reach the
        // same tolerance the outer loop asks for.
        const t = loopTrack(10, 0.5, 15);
        const penalty = collocate({ ...loopOpts(t, 0), maxIters: 300 });
        expect(penalty.maxViol).toBeGreaterThan(5e-3);

        const al = collocateAL(loopOpts(t, 0), Al);
        expect(al.converged).toBe(true);
        expect(al.maxViol).toBeLessThan(1e-3);
    });

    test("ds robustness: the same continuum problem solves at every grid", () => {
        // the prior attempt's "ds=0.5 kink stall" re-tested on the clean base:
        // interval terms are ds-densities, so these are one continuum problem.
        for (const ds of [1.0, 0.5, 0.35]) {
            const t = loopTrack(10, ds, 15);
            const r = collocateAL(loopOpts(t, 0), Al);
            expect(r.converged).toBe(true);
            expect(r.maxViol).toBeLessThan(1e-3);
        }
    });

    test("an infeasible pin loses loudly to the hard band, landing at the floor", () => {
        // pin F*=−5 conflicts with band lo=−1. the AL band is exact; the soft
        // pin compromises — and the compromise is legible: the apex lands ON
        // the band floor, the pin's residual (≈4g) is the "this constraint is
        // losing" signal the authoring UI surfaces. no NaN, no spiral.
        const t = loopTrack(10, 0.5, 15);
        const r = collocateAL(loopOpts(t, -5), Al);
        expect(r.converged).toBe(true);
        const f = forces64(r.x, r.y, t.n, t.v0);
        expect(Math.abs(f.fN[t.apex] - Lo)).toBeLessThan(2e-2);
        for (let i = 0; i < t.n; i++) {
            expect(Number.isFinite(r.x[i])).toBe(true);
            expect(Number.isFinite(r.y[i])).toBe(true);
        }
    });

    test("a length-infeasible band fails loud and finite, not silently", () => {
        // band hi=2 needs a bottom radius ≥ 50m — more arclength than the
        // fixed N·ds grid with pinned endpoints can supply. the correct
        // behavior is a loud least-violation compromise: converged=false,
        // violation O(1), every coordinate finite. (length adaptation is the
        // wire stage's resample-and-continue mechanism, not the solver's.)
        const t = loopTrack(10, 0.5, 15);
        const r = collocateAL(loopOpts(t, 0, 2), { ...Al, outers: 20 });
        expect(r.converged).toBe(false);
        expect(r.maxViol).toBeGreaterThan(1);
        for (let i = 0; i < t.n; i++) {
            expect(Number.isFinite(r.x[i])).toBe(true);
            expect(Number.isFinite(r.y[i])).toBe(true);
        }
    });
});
