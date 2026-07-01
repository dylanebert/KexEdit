import { bandFactor, bandSolve, bandStore } from "./banded";
import { forceJacobian, forces64 } from "./force";

const G = 9.80665;

/**
 * geometry-primal position-space collocation solver — the rebuild's Stage-3
 * kernel (spec `kex/specs/kex2d-collocation.md`). the decision variable is the
 * dense interior node positions `P_i=(x_i,y_i)`, i=1..N−2 (endpoints pinned);
 * we minimize the least-squares force objective
 *
 *   Φ(P) = ½·wData·‖F(P) − F*‖²           data term (forces64 interior rows, g)
 *
 * by Gauss-Newton with Levenberg-Marquardt globalization. `F(P)` is `forces64`
 * (local, differentiable — the well-conditioned direction) and `∂F/∂P` is the
 * analytic banded `forceJacobian`; the normal system `JᵀJ` is symmetric banded
 * (half-bandwidth 5), solved by the `banded` LDLᵀ atom.
 *
 * WHY LEVENBERG-MARQUARDT IS THE ONLY REGULARIZER. the data Jacobian J is
 * (N−2)×2(N−2): one scalar force per node vs two position DOF, so `JᵀJ` is
 * rank-deficient by ~N−2 — the tangential/reparametrization gauge of
 * differential flatness (sliding a node along the tangent leaves κ,θ,v² hence F
 * unchanged; force determines the *shape*, not the parametrization). LM's μI
 * (i) makes the singular `JᵀJ` SPD so `bandFactor` succeeds at every iterate, and
 * (ii) is trust-region on the GN model — global convergence without a line search
 * (Nocedal & Wright ch. 10). crucially `Jᵀr ⟂ null(J)` (the gradient lives in the
 * normal/shape subspace), so the LM step has zero tangential component: the
 * parametrization is frozen at the initial guess rather than invented. μI
 * penalizes the *step*, not `P−P°`, so at a fixed point Jᵀr→0 ⇒ δ→0 regardless of
 * μ — μ shapes the path, never the landing.
 *
 * NO PENALTY REGULARIZER is added, by evidence (Stage-3 measured this): a
 * magnitude ridge `λ‖P−P°‖²` biases the shape toward the draft by O(λ); an
 * arclength `(|chord|−ds)²` gauge biases it toward straight (a curve's chord is
 * *shorter* than its arclength ds, so the arc is not a zero of that term). μI
 * alone recovers the analytic curve's shape to O(ds²) with residual→0 on an
 * achievable target, and the forward oracle reproduces it. parametrization
 * (uniform ds) is a resampling concern for the live wire (Stage 5), not a
 * Stage-3 penalty. this is provisional: the soft-penalty-GN vs constrained-NLP
 * question turns on Stage 4's inequality force band, where it is decidable.
 */

/** the assembled Gauss-Newton normal system `JᵀJ`, banded (half-bandwidth 5). */
export interface NormalSystem {
    /** `bandStore(2M, 5)` lower-band storage of `H = wData·JᵀJ`. */
    band: Float64Array[];
    /** `−gradient` (length 2M) = `−wData·Jᵀr` — the GN rhs. */
    rhs: Float64Array;
    /** system size `2M`, M = N−2. */
    n: number;
    /** half-bandwidth (5). */
    b: number;
    /** physical force residual `‖F(P) − F*‖` over the interior rows (g). */
    resNorm: number;
}

/**
 * assemble the Gauss-Newton normal system `wData·JᵀJ` + rhs `−wData·Jᵀr` for the
 * interior DOF from the current geometry — a pure transform. DOF are interleaved
 * `[x₁,y₁,x₂,y₂,…]` (the band-5 layout locked in Stage 2); pinned-endpoint
 * columns are dropped. LM damping μI is added by the caller, not here — so `JᵀJ`
 * here is rank-deficient (the tangential null space), by design.
 */
export function normalBand(
    x: Float64Array,
    y: Float64Array,
    N: number,
    ds: number,
    v0: number,
    fTarget: Float64Array,
    wData: number,
    g: number = G,
): NormalSystem {
    const M = Math.max(0, N - 2);
    const n = 2 * M;
    const b = 5;
    const band = bandStore(n, b);
    const rhs = new Float64Array(n);

    // interior column of a node's coordinate, or −1 if the node is a pinned end.
    const col = (node: number, axis: number): number =>
        node >= 1 && node <= N - 2 ? 2 * (node - 1) + axis : -1;
    // accumulate into lower-band storage a[i−j][i] = A[i][j] (i ≥ j).
    const add = (ci: number, cj: number, val: number): void => {
        const hi = Math.max(ci, cj);
        band[hi - Math.min(ci, cj)][hi] += val;
    };

    const { fN } = forces64(x, y, N, ds, v0, g);
    const J = forceJacobian(x, y, N, ds, v0, g).entries;
    let res2 = 0;
    for (let i = 1; i < N - 1; i++) {
        const r = i - 1;
        const ri = fN[i] - fTarget[i];
        res2 += ri * ri;
        // slot t ∈ 0..5 → node, axis (the forceJacobian column order).
        const nodes = [i - 1, i - 1, i, i, i + 1, i + 1];
        for (let p = 0; p < 6; p++) {
            const cp = col(nodes[p], p % 2);
            if (cp < 0) continue;
            const jp = J[r * 6 + p];
            rhs[cp] -= wData * jp * ri;
            for (let q = 0; q <= p; q++) {
                const cq = col(nodes[q], q % 2);
                if (cq < 0) continue;
                add(cp, cq, wData * jp * J[r * 6 + q]);
            }
        }
    }

    return { band, rhs, n, b, resNorm: Math.sqrt(res2) };
}

function residualNorm(
    x: Float64Array,
    y: Float64Array,
    N: number,
    ds: number,
    v0: number,
    fTarget: Float64Array,
    g: number,
): number {
    const { fN } = forces64(x, y, N, ds, v0, g);
    let s = 0;
    for (let i = 1; i < N - 1; i++) {
        const e = fN[i] - fTarget[i];
        s += e * e;
    }
    return Math.sqrt(s);
}

export interface CollocateOpts {
    /** target normal force per node (length N); interior rows 1..N−2 are fit. */
    fTarget: Float64Array;
    /** initial geometry (length N); `[0]` and `[N−1]` are the pinned endpoints. */
    x0: Float64Array;
    y0: Float64Array;
    ds: number;
    v0: number;
    /** data-term weight, the unit (default 1). */
    wData?: number;
    /** iteration cap (default 60). */
    maxIters?: number;
    /** gradient convergence tolerance ‖g‖∞ (default 1e-8). */
    gtol?: number;
    /** relative step convergence tolerance (default 1e-12). */
    stol?: number;
    g?: number;
}

export interface CollocateResult {
    /** solved geometry (length N; ends held at the pins). */
    x: Float64Array;
    y: Float64Array;
    iters: number;
    converged: boolean;
    /** final `‖F(P) − F*‖` over the interior (g). */
    residual: number;
    /** final first-order optimality ‖g‖∞. */
    grad: number;
    /** min pivot of the last accepted factorization (SPD witness). */
    minPivot: number;
    /** per-iteration trace for the lab + convergence tests. */
    history: { residual: number; grad: number; mu: number; step: number }[];
}

/** solve the collocation problem by Levenberg-Marquardt Gauss-Newton. */
export function collocate(opts: CollocateOpts): CollocateResult {
    const g = opts.g ?? G;
    const N = opts.x0.length;
    const { ds, v0, fTarget: fT } = opts;
    const wData = opts.wData ?? 1;
    const maxIters = opts.maxIters ?? 60;
    const gtol = opts.gtol ?? 1e-8;
    const stol = opts.stol ?? 1e-12;
    const n = 2 * Math.max(0, N - 2);

    const x = Float64Array.from(opts.x0);
    const y = Float64Array.from(opts.y0);
    const history: CollocateResult["history"] = [];
    if (n === 0)
        return { x, y, iters: 0, converged: true, residual: 0, grad: 0, minPivot: 0, history };

    // LM scratch (caller-owned, reused across passes / right-hand sides).
    const L = bandStore(n, 5);
    const d = new Float64Array(n);
    const yScr = new Float64Array(n);
    const delta = new Float64Array(n);
    const dampedDiag = new Float64Array(n);
    const xt = new Float64Array(N);
    const yt = new Float64Array(N);

    let phi = 0.5 * wData * residualNorm(x, y, N, ds, v0, fT, g) ** 2;
    let nu = 2;
    let minPivot = 0;
    let converged = false;
    let iters = 0;

    // μ₀ from the H diagonal scale (standard LM initialization).
    let mu: number;
    {
        const sys = normalBand(x, y, N, ds, v0, fT, wData, g);
        let mx = 0;
        for (let k = 0; k < n; k++) mx = Math.max(mx, sys.band[0][k]);
        mu = 1e-3 * (mx > 0 ? mx : 1);
    }

    for (iters = 0; iters < maxIters; iters++) {
        const sys = normalBand(x, y, N, ds, v0, fT, wData, g);
        let grad = 0;
        for (let k = 0; k < n; k++) grad = Math.max(grad, Math.abs(sys.rhs[k]));
        history.push({ residual: sys.resNorm, grad, mu, step: 0 });
        if (grad < gtol) {
            converged = true;
            break;
        }

        // inner damping loop: raise μ until the model step is accepted.
        const Hwork = [dampedDiag, sys.band[1], sys.band[2], sys.band[3], sys.band[4], sys.band[5]];
        let stepTaken = false;
        for (let inner = 0; inner < 40; inner++) {
            for (let k = 0; k < n; k++) dampedDiag[k] = sys.band[0][k] + mu;
            bandFactor(Hwork, n, 5, L, d);
            let ok = true;
            let mp = Number.POSITIVE_INFINITY;
            for (let k = 0; k < n; k++) {
                if (!(d[k] > 0)) {
                    ok = false;
                    break;
                }
                mp = Math.min(mp, d[k]);
            }
            if (!ok) {
                mu *= nu;
                nu *= 2;
                continue;
            }
            bandSolve(L, d, n, 5, sys.rhs, delta, yScr);

            xt.set(x);
            yt.set(y);
            let stepNorm = 0;
            let dd = 0;
            let rd = 0;
            for (let k = 0; k < n; k++) {
                const node = (k >> 1) + 1;
                if ((k & 1) === 0) xt[node] += delta[k];
                else yt[node] += delta[k];
                stepNorm = Math.max(stepNorm, Math.abs(delta[k]));
                dd += delta[k] * delta[k];
                rd += sys.rhs[k] * delta[k];
            }
            const phit = 0.5 * wData * residualNorm(xt, yt, N, ds, v0, fT, g) ** 2;
            // LM predicted reduction = ½(μ‖δ‖² + rhsᵀδ), rhs = −gradient.
            const predicted = 0.5 * (mu * dd + rd);
            const rho = predicted > 0 ? (phi - phit) / predicted : -1;

            if (rho > 0) {
                x.set(xt);
                y.set(yt);
                phi = phit;
                minPivot = mp;
                history[history.length - 1].step = stepNorm;
                mu *= Math.max(1 / 3, 1 - (2 * rho - 1) ** 3);
                nu = 2;
                stepTaken = true;
                let posNorm = 0;
                for (let k = 0; k < N; k++)
                    posNorm = Math.max(posNorm, Math.abs(x[k]), Math.abs(y[k]));
                if (stepNorm < stol * (1 + posNorm)) converged = true;
                break;
            }
            mu *= nu;
            nu *= 2;
        }
        if (!stepTaken || converged) break;
    }

    const fin = normalBand(x, y, N, ds, v0, fT, wData, g);
    let fgrad = 0;
    for (let k = 0; k < n; k++) fgrad = Math.max(fgrad, Math.abs(fin.rhs[k]));
    return { x, y, iters, converged, residual: fin.resNorm, grad: fgrad, minPivot, history };
}
