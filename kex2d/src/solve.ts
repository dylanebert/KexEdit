/**
 * convex F_n optimizer — the kex2d solved curve (roadmap "kex2d Phase 1").
 *
 * minimizes, over the solved force profile F (sampled uniformly in draft-time),
 *
 *   L = w_pos·Σ (F[i] − Fpos[i])²                     pull to the position-draft prior
 *     + w_s ·Σ (F[i+1] − 2F[i] + F[i−1])²             curvature smoothness (comfort proxy)
 *     + w_b ·Σ [max(0,F[i]−hi)² + max(0,lo−F[i])²]    soft force-limit band
 *     + Σ_c w_c·(F[k_c] − v_c)²                        point force constraints (authored pins)
 *     + Σ_a w_a·(g_a·F − g_a·Fpos)²                    recovery anchors (downstream geometry heal)
 *
 * every term is quadratic in F, so this is a convex QP with a unique minimum.
 * the pins are constant diagonal data terms (draft-time addressing fixes k_c);
 * the anchors are dense (each `g_a` a geometry-from-F_n linear functional, see
 * `anchor.ts`), entering via a Woodbury low-rank update around the banded solve.
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

/** an authored pin's pull weight and the recovery anchor's stiffness, both
 *  against the unit posWeight. large so a pin nearly hits its value and the
 *  endpoint geometry holds firmly to the draft; validated at this magnitude in
 *  `anchor.test.ts` (heals the downstream swing to ~1/50th). ratios only. */
export const DEFAULT_PIN_WEIGHT = 1e4;
export const DEFAULT_ANCHOR_WEIGHT = 1e4;

/** a point force constraint: pull F at a fixed grid index toward `value`. an
 *  authored force pin — a one-sample constraint draft (roadmap "kex2d Phase 2a").
 *  draft-time addressing keeps `index` fixed, so the term stays a constant
 *  diagonal data term (convex, banded). */
export interface PointCon {
    index: number;
    value: number;
    weight: number;
}

/** a recovery-anchor term: penalize `weight·(row·F − row·Fpos)²`, pulling a
 *  linear functional of F (a geometry quantity from `anchor.recoveryRows`) back
 *  to its draft value. dense in F, so it enters the solve via a Woodbury low-rank
 *  update rather than the band. */
export interface Anchor {
    row: Float64Array;
    weight: number;
}

export interface SolveOpts {
    /** w_pos: pull-to-prior weight, the unit. must be > 0 (keeps A definite). */
    posWeight?: number;
    /** w_s: second-difference (curvature) smoothness weight. */
    smooth?: number;
    /** [lo, hi] soft force-limit band in g. */
    band?: readonly [number, number];
    /** w_b: band hinge stiffness (0 disables the limit). */
    bandWeight?: number;
    /** point force constraints (authored pins). */
    con?: PointCon[];
    /** recovery-anchor terms (downstream geometry heal). */
    anchors?: Anchor[];
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
 * factor a symmetric positive-definite pentadiagonal A (three upper diagonals
 * `d` main len n, `e` A[i][i+1] len ≥ n−1, `f` A[i][i+2] len ≥ n−2) as LDLᵀ with
 * unit-lower L (sub-diagonals α=L[i][i−1], β=L[i][i−2]) and diagonal D=p. scratch
 * arrays are caller-owned (len ≥ n) and reused across active-set passes. split
 * from the solve so the anchor's extra right-hand sides reuse one factorization.
 */
function pentaFactor(
    d: Float64Array,
    e: Float64Array,
    f: Float64Array,
    n: number,
    alpha: Float64Array,
    beta: Float64Array,
    p: Float64Array,
): void {
    // β_i = f[i−2]/p[i−2]; α_i = (e[i−1] − β_i·α_{i−1}·p[i−2])/p[i−1];
    // p_i = d[i] − α_i²·p[i−1] − β_i²·p[i−2].
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
}

/** solve A x = b given the LDLᵀ factors from `pentaFactor`; `y` is scratch
 *  (len ≥ n). writes the result into `x`. */
function pentaSolveFactored(
    alpha: Float64Array,
    beta: Float64Array,
    p: Float64Array,
    b: Float64Array,
    n: number,
    y: Float64Array,
    x: Float64Array,
): void {
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

/** solve a dense SPD system M λ = b by Cholesky. M is row-major K×K, overwritten
 *  with its factor. the Woodbury capacitance solve for the recovery anchor; also
 *  the dense reference `banded.test.ts` cross-validates the banded factorization
 *  against (spec `kex/specs/kex2d-collocation.md`). */
export function denseSolveSpd(M: Float64Array, b: Float64Array, K: number): Float64Array {
    // M = L Lᵀ in place (lower triangle).
    for (let j = 0; j < K; j++) {
        let dsum = M[j * K + j];
        for (let k = 0; k < j; k++) dsum -= M[j * K + k] * M[j * K + k];
        const ljj = Math.sqrt(dsum);
        M[j * K + j] = ljj;
        for (let i = j + 1; i < K; i++) {
            let s = M[i * K + j];
            for (let k = 0; k < j; k++) s -= M[i * K + k] * M[j * K + k];
            M[i * K + j] = s / ljj;
        }
    }
    const x = new Float64Array(K);
    // forward L y = b
    for (let i = 0; i < K; i++) {
        let s = b[i];
        for (let k = 0; k < i; k++) s -= M[i * K + k] * x[k];
        x[i] = s / M[i * K + i];
    }
    // back Lᵀ x = y
    for (let i = K - 1; i >= 0; i--) {
        let s = x[i];
        for (let k = i + 1; k < K; k++) s -= M[k * K + i] * x[k];
        x[i] = s / M[i * K + i];
    }
    return x;
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

    // point constraints: a constant diagonal data term at each pinned index.
    const con = opts.con ?? [];

    // recovery anchors: dense (row·(F − Fpos))² terms entering as a Woodbury
    // low-rank update. U = the anchor rows (cols of the update), W = the weights,
    // and the rhs gets the bias U W t with t_k = row_k·Fpos — so the anchor pulls
    // geometry back to the *draft* (residual zero at F = Fpos), not toward 0.
    const anchors = (opts.anchors ?? []).filter((c) => c.weight > 0);
    const K = anchors.length;
    const biasRhs = new Float64Array(n);
    for (const c of anchors) {
        let t = 0;
        for (let i = 0; i < n; i++) t += c.row[i] * Fpos[i];
        const wt = c.weight * t;
        for (let i = 0; i < n; i++) biasRhs[i] += wt * c.row[i];
    }

    const d = new Float64Array(n);
    const rhs = new Float64Array(n);
    const z = new Float64Array(n); // base solve A_band⁻¹ b, pre-Woodbury
    const x = new Float64Array(n); // post-Woodbury solution
    const alpha = new Float64Array(n);
    const beta = new Float64Array(n);
    const p = new Float64Array(n);
    const yScratch = new Float64Array(n);
    // Y = A_band⁻¹ U, recomputed each pass (the band diagonal moves with the
    // active set; U is constant). M = W⁻¹ + UᵀY is the small capacitance matrix.
    const Y: Float64Array[] = [];
    for (let k = 0; k < K; k++) Y.push(new Float64Array(n));

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
            d[i] = wPos + wS * sd[i];
            rhs[i] = wPos * Fpos[i] + biasRhs[i];
        }
        for (const c of con) {
            d[c.index] += c.weight;
            rhs[c.index] += c.weight * c.value;
        }
        if (wB > 0) {
            for (let i = 0; i < n; i++) {
                if (active[i] !== 0) {
                    d[i] += wB;
                    rhs[i] += wB * (active[i] > 0 ? hi : lo);
                }
            }
        }

        pentaFactor(d, e, f, n, alpha, beta, p);
        pentaSolveFactored(alpha, beta, p, rhs, n, yScratch, z);

        if (K === 0) {
            x.set(z);
        } else {
            // Woodbury: F = z − Y M⁻¹ (Uᵀz), M = W⁻¹ + UᵀY.
            for (let k = 0; k < K; k++)
                pentaSolveFactored(alpha, beta, p, anchors[k].row, n, yScratch, Y[k]);
            const M = new Float64Array(K * K);
            const uz = new Float64Array(K);
            for (let k = 0; k < K; k++) {
                const rk = anchors[k].row;
                let dot = 0;
                for (let i = 0; i < n; i++) dot += rk[i] * z[i];
                uz[k] = dot;
                M[k * K + k] += 1 / anchors[k].weight;
                for (let l = 0; l < K; l++) {
                    const Yl = Y[l];
                    let m = 0;
                    for (let i = 0; i < n; i++) m += rk[i] * Yl[i];
                    M[k * K + l] += m;
                }
            }
            const lambda = denseSolveSpd(M, uz, K);
            for (let i = 0; i < n; i++) {
                let corr = 0;
                for (let k = 0; k < K; k++) corr += Y[k][i] * lambda[k];
                x[i] = z[i] - corr;
            }
        }

        // re-derive the active set from the post-Woodbury solution.
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
