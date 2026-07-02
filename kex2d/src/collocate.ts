import { bandFactor, bandSolve, bandStore } from "./banded";
import { forceJacobian, forces64 } from "./force";

const G = 9.80665;

/**
 * geometry-primal position-space collocation solver — the unified-solver kernel
 * (spec `kex/specs/kex2d-unified-solver.md`). the decision variable is the
 * dense interior node positions `P_i=(x_i,y_i)`, i=1..N−2 (endpoints pinned);
 * we minimize a weighted least-squares objective over residual blocks
 *
 *   Φ(P) = ½·Σ w_i·(F_i − F*_i)²                        force data/pin rows
 *        + ½·w_B·Σ ds·[max(0, s_hi + F_i − hi)² +
 *                      max(0, s_lo + lo − F_i)²]        force band (hinge)
 *        + ½·w_S·Σ ds·‖D^k d_i / ds^k‖²                 shape prior, d = P − P°
 *
 * by Gauss-Newton with Levenberg-Marquardt globalization. `F(P)` is `forces64`
 * (local, differentiable — the well-conditioned direction) and `∂F/∂P` is the
 * analytic banded `forceJacobian`; the normal system `JᵀJ` is symmetric banded
 * (half-bandwidth 5, or 6 with the order-3 prior), solved by the `banded` atom.
 *
 * WEIGHT SEMANTICS. data/pin rows are *point* terms — per-row weights, no ds
 * measure (a pin means "this much, here"). band and shape are *interval* terms —
 * continuum densities, so assembly folds `ds` into their row weights and the
 * discrete Φ approximates the same integral at every grid resolution (the ds
 * sweep tests one continuum problem, not a family). the band's optional shifts
 * `s = λ/w_B` make the same hinge assembly serve plain penalty (s = 0) and the
 * PHR augmented Lagrangian (`collocateAL` manages λ) — the AL shifts move the
 * hinge kink off the constraint boundary at the solution, which is the
 * textbook cure for the penalty method's kink-stall pathology.
 *
 * WHY LEVENBERG-MARQUARDT IS THE ONLY REGULARIZER. the data Jacobian J is
 * (N−2)×2(N−2): one scalar force per node vs two position DOF, so `JᵀJ` is
 * rank-deficient by ~N−2 — the tangential/reparametrization gauge of
 * differential flatness (sliding a node along the curve leaves the chord-based
 * κ,θ,v² hence F *exactly* unchanged — the invariant map makes the gauge the
 * literal null space, not an approximation; force determines the *shape*, not
 * the parametrization). LM's μI
 * (i) makes the singular `JᵀJ` SPD so `bandFactor` succeeds at every iterate, and
 * (ii) is trust-region on the GN model — global convergence without a line search
 * (Nocedal & Wright ch. 10). crucially `Jᵀr ⟂ null(J)` (the gradient lives in the
 * normal/shape subspace), so the LM step has zero tangential component: the
 * parametrization is frozen at the initial guess rather than invented. μI
 * penalizes the *step*, not `P−P°`, so at a fixed point Jᵀr→0 ⇒ δ→0 regardless of
 * μ — μ shapes the path, never the landing. the shape prior is a *normal*-subspace
 * regularizer (it biases the shape toward the draft's deformation profile), so it
 * composes with — never replaces — the LM kernel.
 *
 * NO MAGNITUDE/GAUGE PENALTY on the solved positions themselves, by evidence
 * (Stage-3 measured this): a magnitude ridge `λ‖P−P°‖²` biases the shape toward
 * the draft by O(λ) — which is exactly why the shape prior penalizes deformation
 * *roughness* (a derivative of d), leaving the low-frequency warp modes a force
 * constraint needs nearly free; the `magnitude` kind exists for the lab
 * comparison, not production. an arclength `(|chord|−ds)²` gauge biases toward
 * straight (a curve's chord is *shorter* than its arclength ds) — rejected.
 */

/** force band `lo ≤ F ≤ hi` (g), an interval hinge term. `w` is the penalty
 *  weight (or ρ under `collocateAL`, which supplies the shifts `λ/ρ`). */
export interface BandTerm {
    lo: number;
    hi: number;
    w: number;
    /** PHR-AL shifts (length N, interior rows read); absent = plain penalty. */
    shiftLo?: Float64Array;
    shiftHi?: Float64Array;
}

/** shape prior toward the draft `(x0, y0)`: penalize a derivative of the
 *  deformation `d = P − P°` (`roughness`, the production kind) or `d` itself
 *  (`magnitude`, the lab's negative control — it pins every sample in place and
 *  suppresses the low-frequency warp a force constraint needs). */
export interface ShapeTerm {
    w: number;
    kind?: "roughness" | "magnitude";
    /** difference order of the roughness derivative (default 2). */
    order?: 2 | 3;
}

/** explicit position pins: hold node `i` at `(x, y)` with weight `w` — a
 *  point term (meters), the position analogue of a force data row. */
export interface PosTerm {
    rows: { i: number; x: number; y: number; w: number }[];
}

/** optional residual blocks past the data term. */
export interface Terms {
    /** per-row data weights (length N, interior rows read; overrides `wData`).
     *  zero rows carry no residual — sparse pins are `wF` zero except the pin. */
    wF?: Float64Array;
    band?: BandTerm;
    shape?: ShapeTerm;
    pos?: PosTerm;
    /** force-roughness comfort term: first difference of F per edge between
     *  interior rows, `(F_{i+1} − F_i)/ds`, an interval density. penalizes
     *  the bang-bang band-riding profile (an authoring-level "smoothness"
     *  knob, default absent). widens the stencil to half-bandwidth 7. */
    fRough?: { w: number };
    /** chord-consistency `(|P_{i+1}−P_i| − ds)/ds` per edge — a GRID-QUALITY
     *  regularizer, kept SMALL (0.1–1). `forces64` is parametrization-invariant
     *  (Menger κ + neighbor-chord tangent), so force cannot be cheated by
     *  sliding — this term only keeps spacing from drifting non-uniform under
     *  large warps (frozen asymmetric spacing biases the neighbor-chord tangent
     *  toward the arc-midpoint tangent, an O(asym²/R) shape bias the Stage-2
     *  tests pin) and from degenerating (coincident nodes blow up the Menger
     *  quotient). its own arc-chord bias (a circular arc's chord is
     *  2R·sin(ds/2R) ≈ ds·(1 − ds²/24R²)) pulls toward straight, which is why
     *  the weight stays small and is never escalated — the Stage-2 lab measured
     *  a fixed-ds force map being gamed through exactly this seam (band "met"
     *  with 60–97% chord stretch and no real reshaping) when the weight war was
     *  loseable; invariance of the force map, not weight, is what closed it. */
    chord?: { w: number };
}

// half-bandwidth of the assembled normal system for a term set.
function bandwidth(terms?: Terms): number {
    if (terms?.fRough) return 7; // ΔF couples nodes i−1..i+2
    return terms?.shape?.kind !== "magnitude" && terms?.shape?.order === 3 ? 6 : 5;
}

/** the assembled Gauss-Newton normal system `JᵀWJ`, banded. */
export interface NormalSystem {
    /** `bandStore(2M, b)` lower-band storage of `H = JᵀWJ` over all blocks. */
    band: Float64Array[];
    /** `−gradient` (length 2M) — the GN rhs over all blocks. */
    rhs: Float64Array;
    /** system size `2M`, M = N−2. */
    n: number;
    /** physical force residual `‖F(P) − F*‖` over weighted data rows (g). */
    resNorm: number;
    /** worst band violation max(0, F−hi, lo−F) over interior rows (g); 0 if no band. */
    maxViol: number;
}

/** Φ and its diagnostics at a geometry — must mirror `normalBand` exactly
 *  (the LM acceptance test compares the two). */
export function evaluate(
    x: Float64Array,
    y: Float64Array,
    N: number,
    ds: number,
    v0: number,
    fTarget: Float64Array,
    wData: number,
    g: number = G,
    terms?: Terms,
    draftX?: Float64Array,
    draftY?: Float64Array,
): { phi: number; resNorm: number; maxViol: number } {
    const { fN } = forces64(x, y, N, v0, g);
    let phi = 0;
    let res2 = 0;
    let maxViol = 0;

    for (let i = 1; i < N - 1; i++) {
        const wi = terms?.wF ? terms.wF[i] : wData;
        if (wi > 0) {
            const ri = fN[i] - fTarget[i];
            res2 += ri * ri;
            phi += 0.5 * wi * ri * ri;
        }
        if (terms?.band) {
            const { lo, hi, w, shiftLo, shiftHi } = terms.band;
            const vHi = Math.max(0, (shiftHi ? shiftHi[i] : 0) + fN[i] - hi);
            const vLo = Math.max(0, (shiftLo ? shiftLo[i] : 0) + lo - fN[i]);
            phi += 0.5 * w * ds * (vHi * vHi + vLo * vLo);
            maxViol = Math.max(maxViol, fN[i] - hi, lo - fN[i]);
        }
    }
    if (maxViol < 0) maxViol = 0;

    if (terms?.pos) {
        for (const row of terms.pos.rows) {
            const rx = x[row.i] - row.x;
            const ry = y[row.i] - row.y;
            phi += 0.5 * row.w * (rx * rx + ry * ry);
        }
    }

    if (terms?.fRough) {
        const w = terms.fRough.w * ds;
        for (let i = 1; i < N - 2; i++) {
            const r = (fN[i + 1] - fN[i]) / ds;
            phi += 0.5 * w * r * r;
        }
    }

    if (terms?.chord) {
        const w = terms.chord.w * ds;
        for (let i = 0; i < N - 1; i++) {
            const r = (Math.hypot(x[i + 1] - x[i], y[i + 1] - y[i]) - ds) / ds;
            phi += 0.5 * w * r * r;
        }
    }

    const shape = terms?.shape;
    if (shape && draftX && draftY) {
        const dx = (i: number): number => x[i] - draftX[i];
        const dy = (i: number): number => y[i] - draftY[i];
        if (shape.kind === "magnitude") {
            for (let i = 1; i < N - 1; i++)
                phi += 0.5 * shape.w * ds * (dx(i) * dx(i) + dy(i) * dy(i));
        } else if (shape.order === 3) {
            const inv = 1 / (ds * ds * ds);
            for (let i = 1; i < N - 2; i++) {
                const rx = (-dx(i - 1) + 3 * dx(i) - 3 * dx(i + 1) + dx(i + 2)) * inv;
                const ry = (-dy(i - 1) + 3 * dy(i) - 3 * dy(i + 1) + dy(i + 2)) * inv;
                phi += 0.5 * shape.w * ds * (rx * rx + ry * ry);
            }
        } else {
            const inv = 1 / (ds * ds);
            for (let i = 1; i < N - 1; i++) {
                const rx = (dx(i - 1) - 2 * dx(i) + dx(i + 1)) * inv;
                const ry = (dy(i - 1) - 2 * dy(i) + dy(i + 1)) * inv;
                phi += 0.5 * shape.w * ds * (rx * rx + ry * ry);
            }
        }
    }

    return { phi, resNorm: Math.sqrt(res2), maxViol };
}

/**
 * assemble the Gauss-Newton normal system `JᵀWJ` + rhs `−JᵀWr` for the interior
 * DOF from the current geometry — a pure transform. DOF are interleaved
 * `[x₁,y₁,x₂,y₂,…]`; pinned-endpoint columns are dropped. LM damping μI is added
 * by the caller, not here.
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
    terms?: Terms,
    draftX?: Float64Array,
    draftY?: Float64Array,
): NormalSystem {
    const M = Math.max(0, N - 2);
    const n = 2 * M;
    const b = bandwidth(terms);
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
    // generic weighted rank-1 row update from (column, ∂r/∂col) pairs.
    const addRow = (cols: number[], jac: number[], w: number, r: number): void => {
        for (let p = 0; p < cols.length; p++) {
            const cp = cols[p];
            if (cp < 0) continue;
            rhs[cp] -= w * jac[p] * r;
            for (let q = 0; q <= p; q++) {
                if (cols[q] < 0) continue;
                add(cp, cols[q], w * jac[p] * jac[q]);
            }
        }
    };

    const { fN } = forces64(x, y, N, v0, g);
    const J = forceJacobian(x, y, N, v0, g).entries;
    let res2 = 0;
    let maxViol = 0;
    const fCols = new Array<number>(6);
    const fJac = new Array<number>(6);
    for (let i = 1; i < N - 1; i++) {
        const r = i - 1;
        for (let p = 0; p < 6; p++) {
            const node = i - 1 + (p >> 1);
            fCols[p] = col(node, p % 2);
            fJac[p] = J[r * 6 + p];
        }

        const wi = terms?.wF ? terms.wF[i] : wData;
        if (wi > 0) {
            const ri = fN[i] - fTarget[i];
            res2 += ri * ri;
            addRow(fCols, fJac, wi, ri);
        }

        if (terms?.band) {
            const { lo, hi, w, shiftLo, shiftHi } = terms.band;
            const vHi = Math.max(0, (shiftHi ? shiftHi[i] : 0) + fN[i] - hi);
            const vLo = Math.max(0, (shiftLo ? shiftLo[i] : 0) + lo - fN[i]);
            // active hinge rows share ∂F's Jacobian (lo side negated via r sign:
            // r_lo = max(0, s + lo − F) has ∂r/∂P = −∂F/∂P, so JᵀJ is identical
            // and only the rhs sign flips — fold as weight w·ds, residual ∓v).
            if (vHi > 0) addRow(fCols, fJac, w * ds, vHi);
            if (vLo > 0) {
                for (let p = 0; p < 6; p++) fJac[p] = -fJac[p];
                addRow(fCols, fJac, w * ds, vLo);
            }
            maxViol = Math.max(maxViol, fN[i] - hi, lo - fN[i]);
        }
    }
    if (maxViol < 0) maxViol = 0;

    if (terms?.pos) {
        for (const row of terms.pos.rows) {
            addRow([col(row.i, 0)], [1], row.w, x[row.i] - row.x);
            addRow([col(row.i, 1)], [1], row.w, y[row.i] - row.y);
        }
    }

    if (terms?.fRough) {
        // r_i = (F_{i+1} − F_i)/ds over the union stencil i−1..i+2 (8 cols).
        const w = terms.fRough.w * ds;
        const cols = new Array<number>(8);
        const jac = new Array<number>(8);
        for (let i = 1; i < N - 2; i++) {
            const rA = i - 1; // F_i's jacobian row
            const rB = i; // F_{i+1}'s jacobian row
            for (let p = 0; p < 8; p++) {
                const node = i - 1 + (p >> 1);
                cols[p] = col(node, p % 2);
                // F_i spans nodes i−1..i+1 (its cols 0..5); F_{i+1} spans
                // i..i+2 (union cols 2..7).
                const a = p < 6 ? J[rA * 6 + p] : 0;
                const b = p >= 2 ? J[rB * 6 + (p - 2)] : 0;
                jac[p] = (b - a) / ds;
            }
            addRow(cols, jac, w, (fN[i + 1] - fN[i]) / ds);
        }
    }

    if (terms?.chord) {
        const w = terms.chord.w * ds;
        for (let i = 0; i < N - 1; i++) {
            const cx = x[i + 1] - x[i];
            const cy = y[i + 1] - y[i];
            const len = Math.hypot(cx, cy);
            const r = (len - ds) / ds;
            // ∂r/∂P_{i+1} = û/ds, ∂r/∂P_i = −û/ds (û the edge unit vector).
            const ux = cx / (len * ds);
            const uy = cy / (len * ds);
            addRow([col(i, 0), col(i, 1), col(i + 1, 0), col(i + 1, 1)], [-ux, -uy, ux, uy], w, r);
        }
    }

    const shape = terms?.shape;
    if (shape && draftX && draftY) {
        const dx = (i: number): number => x[i] - draftX[i];
        const dy = (i: number): number => y[i] - draftY[i];
        const w = shape.w * ds;
        if (shape.kind === "magnitude") {
            for (let i = 1; i < N - 1; i++)
                for (const axis of [0, 1] as const)
                    addRow([col(i, axis)], [1], w, axis === 0 ? dx(i) : dy(i));
        } else if (shape.order === 3) {
            const inv = 1 / (ds * ds * ds);
            const coef = [-inv, 3 * inv, -3 * inv, inv];
            for (let i = 1; i < N - 2; i++) {
                for (const axis of [0, 1] as const) {
                    const d = axis === 0 ? dx : dy;
                    const r =
                        -d(i - 1) * inv + 3 * d(i) * inv - 3 * d(i + 1) * inv + d(i + 2) * inv;
                    addRow(
                        [col(i - 1, axis), col(i, axis), col(i + 1, axis), col(i + 2, axis)],
                        coef,
                        w,
                        r,
                    );
                }
            }
        } else {
            const inv = 1 / (ds * ds);
            const coef = [inv, -2 * inv, inv];
            for (let i = 1; i < N - 1; i++) {
                for (const axis of [0, 1] as const) {
                    const d = axis === 0 ? dx : dy;
                    const r = (d(i - 1) - 2 * d(i) + d(i + 1)) * inv;
                    addRow([col(i - 1, axis), col(i, axis), col(i + 1, axis)], coef, w, r);
                }
            }
        }
    }

    return { band, rhs, n, resNorm: Math.sqrt(res2), maxViol };
}

export interface CollocateOpts {
    /** target normal force per node (length N); weighted interior rows are fit. */
    fTarget: Float64Array;
    /** initial geometry AND shape-prior draft (length N); `[0]` and `[N−1]` are
     *  the pinned endpoints. */
    x0: Float64Array;
    y0: Float64Array;
    ds: number;
    v0: number;
    /** uniform data-term weight (default 1); `terms.wF` overrides per row. */
    wData?: number;
    /** optional residual blocks (per-row weights, force band, shape prior). */
    terms?: Terms;
    /** warm start (length N); defaults to the draft `(x0, y0)`. */
    xInit?: Float64Array;
    yInit?: Float64Array;
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
    /** final `‖F(P) − F*‖` over the weighted data rows (g). */
    residual: number;
    /** final worst band violation (g); 0 when no band term. */
    maxViol: number;
    /** final first-order optimality ‖g‖∞. */
    grad: number;
    /** min pivot of the last accepted factorization (SPD witness). */
    minPivot: number;
    /** per-iteration trace for the lab + convergence tests. */
    history: { residual: number; maxViol: number; grad: number; mu: number; step: number }[];
}

/** solve the collocation problem by Levenberg-Marquardt Gauss-Newton. */
export function collocate(opts: CollocateOpts): CollocateResult {
    const g = opts.g ?? G;
    const N = opts.x0.length;
    const { ds, v0, fTarget: fT, terms } = opts;
    const wData = opts.wData ?? 1;
    const maxIters = opts.maxIters ?? 60;
    const gtol = opts.gtol ?? 1e-8;
    const stol = opts.stol ?? 1e-12;
    const n = 2 * Math.max(0, N - 2);
    const b = bandwidth(terms);
    const draftX = opts.x0;
    const draftY = opts.y0;

    const x = Float64Array.from(opts.xInit ?? opts.x0);
    const y = Float64Array.from(opts.yInit ?? opts.y0);
    const history: CollocateResult["history"] = [];
    if (n === 0)
        return {
            x,
            y,
            iters: 0,
            converged: true,
            residual: 0,
            maxViol: 0,
            grad: 0,
            minPivot: 0,
            history,
        };

    // LM scratch (caller-owned, reused across passes / right-hand sides).
    const L = bandStore(n, b);
    const d = new Float64Array(n);
    const yScr = new Float64Array(n);
    const delta = new Float64Array(n);
    const dampedDiag = new Float64Array(n);
    const xt = new Float64Array(N);
    const yt = new Float64Array(N);

    const ev = (px: Float64Array, py: Float64Array): number =>
        evaluate(px, py, N, ds, v0, fT, wData, g, terms, draftX, draftY).phi;

    let phi = ev(x, y);
    let nu = 2;
    let minPivot = 0;
    let converged = false;
    let iters = 0;

    // μ₀ from the H diagonal scale (standard LM initialization).
    let mu: number;
    {
        const sys = normalBand(x, y, N, ds, v0, fT, wData, g, terms, draftX, draftY);
        let mx = 0;
        for (let k = 0; k < n; k++) mx = Math.max(mx, sys.band[0][k]);
        mu = 1e-3 * (mx > 0 ? mx : 1);
    }

    for (iters = 0; iters < maxIters; iters++) {
        const sys = normalBand(x, y, N, ds, v0, fT, wData, g, terms, draftX, draftY);
        let grad = 0;
        for (let k = 0; k < n; k++) grad = Math.max(grad, Math.abs(sys.rhs[k]));
        history.push({ residual: sys.resNorm, maxViol: sys.maxViol, grad, mu, step: 0 });
        if (grad < gtol) {
            converged = true;
            break;
        }

        // inner damping loop: raise μ until the model step is accepted.
        const Hwork = [dampedDiag, ...sys.band.slice(1)];
        let stepTaken = false;
        for (let inner = 0; inner < 40; inner++) {
            for (let k = 0; k < n; k++) dampedDiag[k] = sys.band[0][k] + mu;
            bandFactor(Hwork, n, b, L, d);
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
            bandSolve(L, d, n, b, sys.rhs, delta, yScr);

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
            const phit = ev(xt, yt);
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

    const fin = normalBand(x, y, N, ds, v0, fT, wData, g, terms, draftX, draftY);
    let fgrad = 0;
    for (let k = 0; k < n; k++) fgrad = Math.max(fgrad, Math.abs(fin.rhs[k]));
    return {
        x,
        y,
        iters,
        converged,
        residual: fin.resNorm,
        maxViol: fin.maxViol,
        grad: fgrad,
        minPivot,
        history,
    };
}

/** PHR shifts from the multipliers: `shift = λ/ρ`. */
function alShifts(
    lamLo: Float64Array,
    lamHi: Float64Array,
    rho: number,
    shiftLo: Float64Array,
    shiftHi: Float64Array,
    N: number,
): void {
    for (let i = 0; i < N; i++) {
        shiftLo[i] = lamLo[i] / rho;
        shiftHi[i] = lamHi[i] / rho;
    }
}

/** the PHR multiplier update `λ ← max(0, λ + ρ·c)` over interior rows;
 *  returns the worst band violation (g) of the given force profile. */
function alUpdate(
    lamLo: Float64Array,
    lamHi: Float64Array,
    rho: number,
    fN: Float64Array,
    lo: number,
    hi: number,
    N: number,
): number {
    let viol = 0;
    for (let i = 1; i < N - 1; i++) {
        lamHi[i] = Math.max(0, lamHi[i] + rho * (fN[i] - hi));
        lamLo[i] = Math.max(0, lamLo[i] + rho * (lo - fN[i]));
        viol = Math.max(viol, fN[i] - hi, lo - fN[i]);
    }
    return Math.max(0, viol);
}

export interface ALOpts {
    /** band violation tolerance that ends the outer loop (g). */
    tol?: number;
    /** outer iteration cap (default 8). */
    outers?: number;
    /** ρ escalation factor when a round shrinks violation by < 4× (default 2). */
    escalate?: number;
}

export interface ALResult extends CollocateResult {
    outers: number;
    /** final penalty ρ after any escalation. */
    rho: number;
}

/**
 * solve with the force band as a PHR augmented Lagrangian: outer loop of
 * `collocate` solves with shifted hinges, multiplier update
 * `λ ← max(0, λ + ρ·c)` between them (shift = λ/ρ). exact constraint
 * satisfaction at finite ρ — the alternative to cranking a plain penalty
 * weight (which stiffens JᵀJ and, at the kink, stalls). ρ escalates only when
 * a round stalls (ALTRO's schedule, mild).
 */
export function collocateAL(opts: CollocateOpts, al: ALOpts = {}): ALResult {
    const band = opts.terms?.band;
    if (!band) throw new Error("collocateAL needs terms.band");
    const N = opts.x0.length;
    const tol = al.tol ?? 1e-3;
    const outers = al.outers ?? 8;
    const escalate = al.escalate ?? 2;

    let rho = band.w;
    const lamLo = new Float64Array(N);
    const lamHi = new Float64Array(N);
    const shiftLo = new Float64Array(N);
    const shiftHi = new Float64Array(N);
    const g = opts.g ?? G;

    let xw = opts.xInit ?? opts.x0;
    let yw = opts.yInit ?? opts.y0;
    let result: CollocateResult | undefined;
    let prevViol = Number.POSITIVE_INFINITY;
    let lastViol = Number.POSITIVE_INFINITY;
    let outer = 0;

    for (outer = 0; outer < outers; outer++) {
        alShifts(lamLo, lamHi, rho, shiftLo, shiftHi, N);
        result = collocate({
            ...opts,
            xInit: xw,
            yInit: yw,
            terms: { ...opts.terms, band: { ...band, w: rho, shiftLo, shiftHi } },
        });
        xw = result.x;
        yw = result.y;

        const { fN } = forces64(result.x, result.y, N, opts.v0, g);
        const viol = alUpdate(lamLo, lamHi, rho, fN, band.lo, band.hi, N);
        lastViol = viol;
        if (viol < tol) {
            outer++;
            break;
        }
        if (viol > prevViol / 4) rho *= escalate;
        prevViol = viol;
    }

    if (!result) throw new Error("unreachable: outers >= 1");
    // the outer contract: converged = the band is satisfied to tol. the inner
    // LM flag is budget-bound by design (cheap inners + frequent λ updates beat
    // long inner solves — measured 6× in the Stage-2 lab), so it stays local.
    return { ...result, converged: lastViol < tol, outers: outer, rho };
}

/** the caller-owned AL state that persists across RTI frames: the multipliers
 *  ARE the carry — a drag converges across frames because λ keeps its memory
 *  of which band rows are active. */
export interface RTIState {
    lamLo: Float64Array;
    lamHi: Float64Array;
    rho: number;
    /** the base penalty ρ decays back to once the band is satisfied. */
    rho0: number;
    /** previous frame's violation, for the stall-escalation schedule. */
    prevViol: number;
}

export function createRTIState(N: number, rho0: number): RTIState {
    return {
        lamLo: new Float64Array(N),
        lamHi: new Float64Array(N),
        rho: rho0,
        rho0,
        prevViol: Number.POSITIVE_INFINITY,
    };
}

export interface RTIResult extends CollocateResult {
    /** worst band violation after this outer (g); 0 with no band. */
    viol: number;
}

/**
 * one real-time-iteration frame: a single PHR-AL outer under the per-frame
 * budget — shifts from the persisted `rti`, one budget-bound `collocate`
 * (≤ `opts.maxIters` inners, warm-started via `opts.xInit/yInit`), then the λ
 * update and stall escalation of ρ, mutating `rti` in place. `collocateAL`
 * loops outers to tolerance in one call; this is the same mathematics spread
 * across drag frames (Diehl's RTI). no band term ⇒ a plain `collocate` pass,
 * `rti` untouched (pass null). `tol` gates BOTH the λ update and the stall
 * escalation of ρ: once the band is satisfied to tol the multipliers freeze —
 * updating them there only pumps a millimeter-scale limit cycle (measured
 * ~1.5 mm/frame on the wire-stage valley) instead of letting the warm-started
 * LM reach a fixpoint on the now-constant objective.
 */
export function collocateRTI(opts: CollocateOpts, rti: RTIState | null, tol = 1e-3): RTIResult {
    const band = opts.terms?.band;
    if (!band || !rti) {
        const r = collocate(opts);
        return { ...r, viol: r.maxViol };
    }
    const N = opts.x0.length;
    const g = opts.g ?? G;
    const shiftLo = new Float64Array(N);
    const shiftHi = new Float64Array(N);
    alShifts(rti.lamLo, rti.lamHi, rti.rho, shiftLo, shiftHi, N);
    const result = collocate({
        ...opts,
        terms: { ...opts.terms, band: { ...band, w: rti.rho, shiftLo, shiftHi } },
    });
    const { fN } = forces64(result.x, result.y, N, opts.v0, g);
    let viol = 0;
    for (let i = 1; i < N - 1; i++) viol = Math.max(viol, fN[i] - band.hi, band.lo - fN[i]);
    viol = Math.max(0, viol);
    if (viol >= tol) {
        alUpdate(rti.lamLo, rti.lamHi, rti.rho, fN, band.lo, band.hi, N);
        // budget-bound outers escalate on weak progress (half collocateAL's
        // shrink-by-4× bar — a ≤15-inner frame legitimately shrinks slower),
        // CAPPED at 64×: AL with frequent λ updates converges at finite ρ
        // (the stage-2 evidence), while runaway ρ inflates the LM's μ₀
        // scale until every OTHER term's step falls under the drift stop —
        // measured: a fresh 1-m position demand moved 1e-4 m/frame under a
        // leftover ρ=51k and false-converged. at 64·ρ₀ the same step stays
        // ~3× above STEP_TOL.
        if (viol > rti.prevViol / 2) rti.rho = Math.min(rti.rho * 2, 64 * rti.rho0);
    }
    // satisfied ⇒ λ AND ρ freeze entirely: updating multipliers there pumps
    // a millimeter limit cycle; decaying only interior λ trades it for a
    // slow prior-vs-hinge orbit; and decaying ρ under frozen λ grows the
    // shifts λ/ρ and wobbles the hinge (all three measured). the freeze's
    // cost is a schedule-dependent riding level — leftover λ overshoot can
    // hold the profile up to ~0.25 g INSIDE the band where the prior would
    // ride the ceiling — a soft-preference bias, accepted for
    // settle-stability. the escalation CAP is what protects later edits'
    // trust regions (an uncapped ρ=51k inflated μ₀ until a fresh 1-m
    // position demand moved 1e-4 m/frame and false-converged on the drift
    // stop; at the cap the same step stays ~3× above it).
    rti.prevViol = viol;
    return { ...result, viol };
}
