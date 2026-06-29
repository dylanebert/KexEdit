/**
 * convex F_n optimizer — the kex2d solved curve (roadmap "kex2d Phase 1").
 *
 * minimizes, over the solved force profile F (sampled uniformly in draft-time),
 *
 *   L = w_pos·Σ (F[i] − Fpos[i])²                     pull to the position-draft prior
 *     + w_s ·Σ (F[i+1] − 2F[i] + F[i−1])²             curvature smoothness (comfort proxy)
 *     + w_b ·Σ [max(0,F[i]−hi)² + max(0,lo−F[i])²]    soft force-limit band
 *
 * every term is quadratic in F, so this is a convex QP with a unique minimum.
 * the data + smoothness terms form a symmetric positive-definite pentadiagonal
 * system — the second-difference smoothness couples i±2 — solved in O(N) by a
 * banded LDLᵀ. the band's one-sided hinge is an active set: re-solve with the
 * out-of-band samples pinned to the violated limit (an extra w_b on the
 * diagonal, w_b·limit on the rhs), a few banded solves until the active set
 * settles. since the within-set problem is solved exactly each pass, this is a
 * semismooth-Newton step on a convex piecewise-quadratic — it terminates when
 * the set is self-consistent (F[i] > hi ⟺ pinned to hi).
 *
 * F is in units of g, matching `bake.ts forces`. reference: Tikhonov-regularized
 * least squares / smoothing-spline QP; the min-jerk curvature penalty is the
 * Flash & Hogan 1985 lineage. only weight *ratios* matter — fix w_pos as the
 * unit and tune w_s / w_b against it.
 */

/** soft force-limit band in g — airtime floor / sustained-high-g ceiling. */
export const DEFAULT_BAND: readonly [number, number] = [-2, 6];

/** live-overlay feel weights against the unit posWeight — tuned by eye on the
 *  timeline (only the ratios matter), not yet visually settled. */
export const DEFAULT_SMOOTH = 40;
export const DEFAULT_BAND_WEIGHT = 4;

export interface SolveOpts {
    /** w_pos: pull-to-prior weight, the unit. must be > 0 (keeps A definite). */
    posWeight?: number;
    /** w_s: second-difference (curvature) smoothness weight. */
    smooth?: number;
    /** [lo, hi] soft force-limit band in g. */
    band?: readonly [number, number];
    /** w_b: band hinge stiffness (0 disables the limit). */
    bandWeight?: number;
    /** previous solution — seeds the active set so a warm solve converges in one pass. */
    warm?: Float32Array;
    /** active-set iteration cap (safety; convergence is typically 1–3). */
    maxIters?: number;
}

export interface SolveResult {
    /** the solved force profile, same length as the prior (in g). */
    fN: Float32Array;
    /** active-set iterations run to convergence. */
    iters: number;
}

/**
 * solve a symmetric positive-definite pentadiagonal system A x = b, A given by
 * its three upper diagonals: `d` (main, len n), `e` (A[i][i+1], len ≥ n−1),
 * `f` (A[i][i+2], len ≥ n−2). LDLᵀ with unit-lower L (sub-diagonals α=L[i][i−1],
 * β=L[i][i−2]) and diagonal D=p. all scratch arrays are caller-owned (len ≥ n)
 * so an active-set loop reuses them across passes. writes the result into `x`.
 */
function pentaSolve(
    d: Float64Array,
    e: Float64Array,
    f: Float64Array,
    b: Float64Array,
    n: number,
    alpha: Float64Array,
    beta: Float64Array,
    p: Float64Array,
    y: Float64Array,
    x: Float64Array,
): void {
    // factor: β_i = f[i−2]/p[i−2]; α_i = (e[i−1] − β_i·α_{i−1}·p[i−2])/p[i−1];
    //         p_i = d[i] − α_i²·p[i−1] − β_i²·p[i−2].
    p[0] = d[0];
    if (n > 1) {
        alpha[1] = e[0] / p[0];
        beta[1] = 0;
        p[1] = d[1] - alpha[1] * alpha[1] * p[0];
    }
    for (let i = 2; i < n; i++) {
        beta[i] = f[i - 2] / p[i - 2];
        alpha[i] = (e[i - 1] - beta[i] * alpha[i - 1] * p[i - 2]) / p[i - 1];
        p[i] = d[i] - alpha[i] * alpha[i] * p[i - 1] - beta[i] * beta[i] * p[i - 2];
    }

    // forward solve L y = b
    y[0] = b[0];
    if (n > 1) y[1] = b[1] - alpha[1] * y[0];
    for (let i = 2; i < n; i++) y[i] = b[i] - alpha[i] * y[i - 1] - beta[i] * y[i - 2];

    // diagonal solve D z = y (in place)
    for (let i = 0; i < n; i++) y[i] /= p[i];

    // back solve Lᵀ x = z
    x[n - 1] = y[n - 1];
    if (n > 1) x[n - 2] = y[n - 2] - alpha[n - 1] * x[n - 1];
    for (let i = n - 3; i >= 0; i--) x[i] = y[i] - alpha[i + 1] * x[i + 1] - beta[i + 2] * x[i + 2];
}

// second-difference row stencil [1, −2, 1] — DᵀD is its self-outer-product
// accumulated over every interior triple.
const STENCIL = [1, -2, 1];

/** minimize the convex F_n loss; returns the solved profile + iteration count. */
export function solve(Fpos: Float32Array, opts: SolveOpts = {}): SolveResult {
    const n = Fpos.length;
    const fN = new Float32Array(n);
    if (n === 0) return { fN, iters: 0 };

    const wPos = opts.posWeight ?? 1;
    const wS = opts.smooth ?? 0;
    const wB = opts.bandWeight ?? 0;
    const band = opts.band ?? DEFAULT_BAND;
    const lo = band[0];
    const hi = band[1];
    const maxIters = opts.maxIters ?? 64;

    // DᵀD (the smoothness normal equations), three upper diagonals, n-dependent
    // only. sd[i]=A[i][i], se[i]=A[i][i+1], sf[i]=A[i][i+2].
    const sd = new Float64Array(n);
    const se = new Float64Array(Math.max(1, n - 1));
    const sf = new Float64Array(Math.max(1, n - 2));
    for (let j = 0; j + 2 < n; j++) {
        for (let a = 0; a < 3; a++) {
            for (let b = a; b < 3; b++) {
                const v = STENCIL[a] * STENCIL[b];
                if (b - a === 0) sd[j + a] += v;
                else if (b - a === 1) se[j + a] += v;
                else sf[j + a] += v;
            }
        }
    }

    // off-diagonals are constant across active-set passes (the band only touches
    // the main diagonal + rhs).
    const e = new Float64Array(Math.max(1, n - 1));
    const f = new Float64Array(Math.max(1, n - 2));
    for (let i = 0; i < n - 1; i++) e[i] = wS * se[i];
    for (let i = 0; i < n - 2; i++) f[i] = wS * sf[i];

    const d = new Float64Array(n);
    const rhs = new Float64Array(n);
    const x = new Float64Array(n);
    const alpha = new Float64Array(n);
    const beta = new Float64Array(n);
    const p = new Float64Array(n);
    const y = new Float64Array(n);

    // active flags: +1 pinned to hi, −1 pinned to lo, 0 inactive. warm-seed from
    // a prior solution so a frame-to-frame solve starts at the right active set.
    const active = new Int8Array(n);
    if (opts.warm && wB > 0) {
        const w = opts.warm;
        for (let i = 0; i < n; i++) active[i] = w[i] > hi ? 1 : w[i] < lo ? -1 : 0;
    }

    let iters = 0;
    for (;;) {
        iters++;
        for (let i = 0; i < n; i++) {
            let di = wPos + wS * sd[i];
            let bi = wPos * Fpos[i];
            if (wB > 0 && active[i] !== 0) {
                di += wB;
                bi += wB * (active[i] > 0 ? hi : lo);
            }
            d[i] = di;
            rhs[i] = bi;
        }
        pentaSolve(d, e, f, rhs, n, alpha, beta, p, y, x);

        // re-derive the active set from the fresh solution; converged once stable.
        let changed = false;
        if (wB > 0) {
            for (let i = 0; i < n; i++) {
                const a = x[i] > hi ? 1 : x[i] < lo ? -1 : 0;
                if (a !== active[i]) {
                    active[i] = a;
                    changed = true;
                }
            }
        }
        if (!changed || iters >= maxIters) break;
    }

    for (let i = 0; i < n; i++) fN[i] = x[i];
    return { fN, iters };
}
