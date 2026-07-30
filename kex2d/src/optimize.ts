/** The masked-collocation solve behind optimize mode (`kex2d-optimize-mode` stage 1) — the
 *  invoked tool that restores a force section's stamped exit `(x, y, θ)` after the author
 *  retunes its keyframes, moving only the UN-LOCKED keys' g-ordinates.
 *
 *  **DOF = g-ordinates of free keys, nothing else** (the spec's hard invariant): `s`, length,
 *  structure, easing, and explicit handles never move — the caller passes the same `ForcePoint`
 *  array back with only free-index `g` fields rewritten. This is what makes the objective live in
 *  a single-unit space: with every key's `s` frozen, `profile.segment`'s bezier control points are
 *  affine in the two bounding keyframes' `g` values ONLY (the s-side control points and every
 *  explicit handle's `(Δs, Δg)` offset are fixed, independent of `g`), so the dense force response
 *  `fN(σ)` is affine in the full g-vector GLOBALLY, not just to first order. That is what makes
 *  the Gram matrix below exact rather than a local linearization: computed once from a unit bump
 *  at the baseline, it is the same matrix at every iterate.
 *
 *  **Objective**: the closed-form force-curve L2 deviation `∫(F_new − F_draft)² ds = Δg·M·Δg`
 *  (`M` the Gram matrix of the free keys' basis response, ds-weighted). **Constraint**: the
 *  section's own recovered exit (`section.evalForce`, the same integrator the document bakes)
 *  matches the mode-entry stamp — nonlinear in g through the forward integration, so it's solved
 *  by constrained Gauss-Newton (SQP): minimize the fixed quadratic subject to the constraint
 *  linearized at each iterate, a small (P+3)-scale dense KKT solve, never the big banded dense-spine
 *  machinery `polish.ts`/`collocate.ts` assemble for the entirely different geo→force problem (a
 *  full per-sample position match, not a 3-row exit pin) — reusing that shape here would carry
 *  dense per-edge state variables this problem has no use for. The Jacobian of the exit w.r.t. the
 *  free g's has no closed form as clean as the Gram matrix's (it crosses the nonlinear forward
 *  integrator), so it is read by central finite differences against `section.evalForce` — the
 *  exact production integrator, so what the solve targets is exactly what the document would bake.
 *
 *  **Refusal taxonomy (stage 1 slice).** `"unreachable"`: fewer than `MIN_FREE` free keys — the
 *  necessary condition a 3-row exit pin needs, checked before any solving starts. `"diverged"`:
 *  everything else — a stalled backtrack, a singular normal system (near-straight keys, a
 *  rank-deficient Jacobian) — reported honestly as "did not converge" rather than diagnosed
 *  (stage 3 adds the at-invoke conditioning check + continuation; this slice refuses instead of
 *  guessing). Both leave the caller free to retry with a different lock set — nothing here writes
 *  to the document; that's the caller's job, once, on a `"solved"` answer.
 *
 *  **Zero-drift identity.** An untouched draft's own exit already equals a stamp taken from that
 *  same draft by the identical computation (`computeExit`), so the very first residual check is
 *  bit-exact zero and the solve returns immediately with every Δg exactly 0 — no floating step
 *  ever executes. */

import { type Domain, type Entry, evalForce } from "./section";
import { forceProfile, type ForcePoint } from "./profile";

/** the section's exit anchor a stamp addresses — `v` is excluded (energy conservation makes it a
 *  derived function of `y` given the fixed entry speed, so pinning `(x, y, θ)` pins it too). */
export interface OptimizeStamp {
    x: number;
    y: number;
    theta: number;
}

/** the fewest free keys a 3-row exit pin can generically satisfy — the necessary condition
 *  `"unreachable"` certifies (locked decision: "unreachable" may only be produced by this check
 *  in this slice; a rank-deficient Jacobian above this floor reads as `"diverged"` instead, since
 *  certifying that needs the at-invoke conditioning check stage 3 adds). */
export const MIN_FREE = 3;

/** provisional numeric floor (stage 1): the position/heading gap below which the exit counts as
 *  restored. Not yet the derived f32-bake floor the locked decision names (`kex2d-optimize-mode`
 *  Approach, stage 3) — that requires measuring the live bake's replay noise for this solve's step
 *  count, deferred with the rest of stage 3's diagnostics. Flagged provisional, not tuned to a
 *  corpus: loosen only when stage 3's measurement says so. */
export const TOL_POS = 1e-4;
export const TOL_ANGLE = 1e-4;

const MAX_ITERS = 30;
/** central-difference step for the exit Jacobian, in g units — the cube root of the forward
 *  map's own fractional accuracy, times the argument's curvature scale (Numerical Recipes §5.7).
 *  `evalForce` is f32 (`section.ts`'s display-path law), so its fractional accuracy is the f32
 *  unit roundoff `2^-24`; a force ordinate is an O(1 g) quantity and the exit varies smoothly
 *  over that scale, so the curvature scale is 1 g. Hence `h = cbrt(2^-24) · 1 g = 2^-8`.
 *
 *  A step below this is NOT "more accurate": the central difference's error is
 *  `h²·|f'''|/6 + ε/h`, so shrinking `h` amplifies the f32 quantization of the exit by `1/2h`
 *  until it swamps the derivative. Measured on the gentle-hill corpus scenario (exit x ≈ 39.8 m,
 *  where 2^-24·x ≈ 2.4e-6 — unit-roundoff scaling, not the bit-level ulp) against a
 *  Richardson-extrapolated reference: the ∂x/∂g row is ~10% off at `h = 1e-4` and ~50% off at
 *  `h = 1e-5`, against ~1e-3 here. That noise is what stalls the SQP
 *  loop — it converges to ~1e-3 and then random-walks above `TOL_POS` until `MAX_ITERS`, which
 *  a modest single-key edit reaches (a ±0.2 g tweak refused on 6 of 30 corpus cases). */
const JAC_H = 2 ** -8;

export type OptimizeOutcome = "solved" | "unreachable" | "diverged";

export interface OptimizeResult {
    /** the input points with only free-index `g` fields rewritten — `s`, `ease`, `in`/`out`, and
     *  every locked key's `g` are the SAME values passed in, by construction (the masking
     *  invariant, asserted structurally in `tests/optimize.test.ts`). */
    points: ForcePoint[];
    /** per-key Δg (length === `points.length`), 0 at every locked index — the solve's ledger. */
    deltaG: number[];
    outcome: OptimizeOutcome;
    iters: number;
    /** final max |x, y| exit gap (m). */
    residual: number;
    /** final |θ| exit gap (rad). */
    angleResidual: number;
}

export interface OptimizeOpts {
    entry: Entry;
    /** the CURRENT draft's keyframes, sorted by `s` (the target is always the current draft, per
     *  the locked decision — never the mode-entry draft). */
    points: readonly ForcePoint[];
    /** indices into `points` that are locked (their `g` never moves). */
    locked: ReadonlySet<number>;
    length: number;
    ds: number;
    domain?: Domain;
    stamp: OptimizeStamp;
    maxIters?: number;
    tol?: number;
    angleTol?: number;
}

/** the section's own recovered exit for a keyframe set — the same call the document bakes
 *  (`section.evalForce`), so a stamp taken here and a residual checked here are the identical
 *  computation the live bake would produce. */
export function computeExit(
    entry: Entry,
    points: readonly ForcePoint[],
    length: number,
    ds: number,
    domain?: Domain,
): OptimizeStamp {
    const dense = forceProfile(points, length, ds);
    const exit = evalForce(entry, dense, ds, domain);
    return { x: exit.exit.x, y: exit.exit.y, theta: exit.exit.theta };
}

function withG(points: readonly ForcePoint[], g: ArrayLike<number>): ForcePoint[] {
    return points.map((p, k) => ({ ...p, g: g[k] }));
}

function residualOf(e: { x: number; y: number; theta: number }, stamp: OptimizeStamp): number[] {
    return [e.x - stamp.x, e.y - stamp.y, e.theta - stamp.theta];
}

/** dense Cholesky factorization (lower-triangular, row-major `n×n`), or null if `A` isn't SPD to
 *  working precision — the small-scale dense solve this problem's DOF count (tens, not the
 *  banded-spine scale `polish.ts` needs) makes simplest and exactly correct; no need to borrow
 *  `banded.ts`'s general bandwidth machinery for a system this size. */
function choleskyFactor(A: Float64Array, n: number): Float64Array | null {
    const L = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
        for (let j = 0; j <= i; j++) {
            let sum = A[i * n + j];
            for (let k = 0; k < j; k++) sum -= L[i * n + k] * L[j * n + k];
            if (i === j) {
                if (!(sum > 0)) return null;
                L[i * n + j] = Math.sqrt(sum);
            } else {
                L[i * n + j] = sum / L[j * n + j];
            }
        }
    }
    return L;
}

function choleskySolve(L: Float64Array, n: number, b: ArrayLike<number>): Float64Array {
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let sum = b[i];
        for (let k = 0; k < i; k++) sum -= L[i * n + k] * y[k];
        y[i] = sum / L[i * n + i];
    }
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
        let sum = y[i];
        for (let k = i + 1; k < n; k++) sum -= L[k * n + i] * x[k];
        x[i] = sum / L[i * n + i];
    }
    return x;
}

/** solve the masked exit-restore: minimize `Δg·M·Δg` over the free keys' g-ordinates subject to
 *  the section's recovered exit matching `stamp`, s/length/structure/locked-g held exactly fixed.
 *
 * @example
 * const stamp = computeExit(entry, draftAtModeEntry, length, ds);
 * // ... the author retunes some keyframes, locks a few ...
 * const r = solveOptimize({ entry, points: currentDraft, locked, length, ds, stamp });
 * if (r.outcome === "solved") landOptimize(history, ecs, section, r.points);
 */
export function solveOptimize(opts: OptimizeOpts): OptimizeResult {
    const { entry, points, locked, length, ds, domain, stamp } = opts;
    const maxIters = opts.maxIters ?? MAX_ITERS;
    const tol = opts.tol ?? TOL_POS;
    const angleTol = opts.angleTol ?? TOL_ANGLE;
    const K = points.length;
    const g0 = Float64Array.from(points, (p) => p.g);
    const freeIdx: number[] = [];
    for (let k = 0; k < K; k++) if (!locked.has(k)) freeIdx.push(k);
    const P = freeIdx.length;

    const zeroResult = (
        outcome: OptimizeOutcome,
        iters: number,
        res: number,
        ang: number,
    ): OptimizeResult => ({
        points: points.map((p) => ({ ...p })),
        deltaG: new Array(K).fill(0),
        outcome,
        iters,
        residual: res,
        angleResidual: ang,
    });

    if (P < MIN_FREE) return zeroResult("unreachable", 0, NaN, NaN);

    const exitAt = (g: ArrayLike<number>): { x: number; y: number; theta: number } => {
        const dense = forceProfile(withG(points, g), length, ds);
        return evalForce(entry, dense, ds, domain).exit;
    };

    const e0 = exitAt(g0);
    const c0 = residualOf(e0, stamp);
    if (c0[0] === 0 && c0[1] === 0 && c0[2] === 0) return zeroResult("solved", 0, 0, 0);

    // the Gram matrix M (P×P): each free key's unit-g-bump response, ds-weighted inner product.
    // exact globally (not a linearization) — the dense profile is affine in g with s frozen.
    const edges = Math.max(1, Math.round(length / ds));
    const base = forceProfile(points, length, ds);
    const cols: Float64Array[] = freeIdx.map((k) => {
        const gPert = Float64Array.from(g0);
        gPert[k] += 1;
        const prof = forceProfile(withG(points, gPert), length, ds);
        const col = new Float64Array(edges);
        for (let e = 0; e < edges; e++) col[e] = prof[e] - base[e];
        return col;
    });
    const M = new Float64Array(P * P);
    for (let i = 0; i < P; i++) {
        for (let j = 0; j <= i; j++) {
            let s = 0;
            for (let e = 0; e < edges; e++) s += cols[i][e] * cols[j][e];
            s *= ds;
            M[i * P + j] = s;
            M[j * P + i] = s;
        }
    }
    const Ml = choleskyFactor(M, P);
    if (!Ml)
        return zeroResult(
            "diverged",
            0,
            Math.max(Math.abs(c0[0]), Math.abs(c0[1])),
            Math.abs(c0[2]),
        );

    // full g-vector scattering a free-index iterate `z` over the locked baseline.
    const scatter = (z: ArrayLike<number>): Float64Array => {
        const g = Float64Array.from(g0);
        for (let i = 0; i < P; i++) g[freeIdx[i]] = z[i];
        return g;
    };

    const z0 = Float64Array.from(freeIdx, (k) => g0[k]);
    let z = Float64Array.from(z0);
    let resNorm = Math.max(Math.abs(c0[0]), Math.abs(c0[1]));
    let angRes = Math.abs(c0[2]);
    let iters = 0;
    let outcome: OptimizeOutcome = "diverged";

    for (; iters < maxIters; iters++) {
        const g = scatter(z);
        const e = exitAt(g);
        const c = residualOf(e, stamp);
        resNorm = Math.max(Math.abs(c[0]), Math.abs(c[1]));
        angRes = Math.abs(c[2]);
        if (resNorm < tol && angRes < angleTol) {
            outcome = "solved";
            break;
        }

        // exit Jacobian w.r.t. the free g's, central-differenced against the production
        // integrator around the CURRENT iterate (the constraint linearization point).
        const J: Float64Array[] = [new Float64Array(P), new Float64Array(P), new Float64Array(P)];
        for (let m = 0; m < P; m++) {
            const zP = Float64Array.from(z);
            zP[m] += JAC_H;
            const zM = Float64Array.from(z);
            zM[m] -= JAC_H;
            const eP = exitAt(scatter(zP));
            const eM = exitAt(scatter(zM));
            J[0][m] = (eP.x - eM.x) / (2 * JAC_H);
            J[1][m] = (eP.y - eM.y) / (2 * JAC_H);
            J[2][m] = (eP.theta - eM.theta) / (2 * JAC_H);
        }

        // U[c] = M⁻¹ J_cᵀ (three P-vectors); A3 = J M⁻¹ Jᵀ (3×3, symmetric); rhs = J(z0−z) + c.
        const U: Float64Array[] = J.map((row) => choleskySolve(Ml, P, row));
        const A3 = new Float64Array(9);
        for (let a = 0; a < 3; a++)
            for (let b = 0; b < 3; b++) {
                let s = 0;
                for (let k = 0; k < P; k++) s += J[b][k] * U[a][k];
                A3[a * 3 + b] = s;
            }
        const rhs = new Float64Array(3);
        for (let a = 0; a < 3; a++) {
            let s = c[a];
            for (let k = 0; k < P; k++) s += J[a][k] * (z0[k] - z[k]);
            rhs[a] = s;
        }
        const A3l = choleskyFactor(A3, 3);
        if (!A3l) break; // rank-deficient constraint directions — refuse, stage 3 diagnoses why
        const lambda = choleskySolve(A3l, 3, rhs);

        const zNext = new Float64Array(P);
        for (let k = 0; k < P; k++) {
            let s = z0[k];
            for (let a = 0; a < 3; a++) s -= U[a][k] * lambda[a];
            zNext[k] = s;
        }

        // damped backtrack: accept the full SQP iterate unless it made the constraint worse, in
        // which case blend toward the previous iterate until it doesn't (or give up on this step).
        let t = 1;
        let accepted = false;
        let zTrial = zNext;
        for (let ls = 0; ls < 20; ls++) {
            zTrial = new Float64Array(P);
            for (let k = 0; k < P; k++) zTrial[k] = z[k] + t * (zNext[k] - z[k]);
            const eT = exitAt(scatter(zTrial));
            const cT = residualOf(eT, stamp);
            const rT = Math.max(Math.abs(cT[0]), Math.abs(cT[1]), Math.abs(cT[2]));
            const rNow = Math.max(resNorm, angRes);
            if (rT < rNow || t < 1e-3) {
                accepted = true;
                break;
            }
            t *= 0.5;
        }
        if (!accepted) break;
        z = zTrial;
    }

    if (outcome !== "solved") {
        // one last honest reading at whatever `z` reached, for the caller's diagnostics.
        const g = scatter(z);
        const e = exitAt(g);
        const c = residualOf(e, stamp);
        resNorm = Math.max(Math.abs(c[0]), Math.abs(c[1]));
        angRes = Math.abs(c[2]);
    }

    const gFinal = scatter(z);
    const outPoints = points.map((p, k) => ({ ...p, g: gFinal[k] }));
    const deltaG = new Array(K).fill(0);
    for (const k of freeIdx) deltaG[k] = gFinal[k] - g0[k];
    return { points: outPoints, deltaG, outcome, iters, residual: resNorm, angleResidual: angRes };
}
