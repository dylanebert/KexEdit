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
 *  **Refusal taxonomy (stage 3, panel-corrected).** A local method cannot certify infeasibility —
 *  a fold in the solution branch presents identically to "no solution" — so `"unreachable"` is
 *  produced ONLY by Jacobian-read certificates, all run at invoke before any solving:
 *  `"free-count"` (fewer than `MIN_FREE` free keys), `"stall"` (the exit map has no consistent
 *  θ derivative: some key's two one-sided differences carry OPPOSITE signs, both above the FD
 *  read's noise floor — the vSafe-clamp signature, since a floor-touched step kicks dθ by
 *  `(F−cosθ)·G·ds/V_FLOOR²` ~ ±10⁴ rad and the exit map downstream of it is pathological;
 *  measured (adversarial-pass lab, 2026-07-30): every floor-touching draft shows sign
 *  opposition, every smooth draft none, and every floor-touching case also fails the bypassed
 *  solver outright, so the certificate's firing set coincides with the measured unsolvable
 *  set), and `"conditioning"` (the scaled Jacobian is rank-deficient at the
 *  FD's own noise floor: the three pin directions aren't independently steerable at working
 *  precision — the near-straight trap, where the x row vanishes at first order). A DRAFT-property
 *  read (vMin over the march) is deliberately not a certificate — review removed one: it refused
 *  on what the draft looks like rather than what the Jacobian can certify. Everything else —
 *  backtrack exhaustion, an interior rank failure, the continuation ladder running out — refuses
 *  as `"diverged"` ("did not converge"): honest non-convergence, never a diagnosis. Both refusals
 *  leave the caller free to retry with a different lock set — nothing here writes to the
 *  document; that's the caller's job, once, on a `"solved"` answer.
 *
 *  **Continuation (stage 3).** Large drift puts the stamp outside the direct SQP's basin (a
 *  ±3 g edit converges, slowly, only past the 30-iteration budget). When the direct solve
 *  refuses, a homotopy ladder re-solves through intermediate targets `exit₀ + (k/n)·(stamp −
 *  exit₀)` for n = 2, 4, 8, warm-starting each stage from the last — the objective reference
 *  stays the CURRENT draft throughout, so the answer is still min-change from now. The stage cap
 *  is sized from the measured re-baseline (lab §1: worst corpus direct solve ~54 ms), bounding
 *  the full ladder's ≤14 stage-solves well under a second off-thread.
 *
 *  **Honest backtrack (stage 3).** The damped step accepts ONLY a strict scaled-residual
 *  improvement; a line search that damps below `T_MIN` without one has proven its linearization
 *  useless and the stage refuses right there — never accepts the step and wanders (the stage-1
 *  `t < 1e-3` acceptance did, random-walking the budget away). A refused solve reports the
 *  best-known reading against the true stamp, so `"diverged"` never hands the caller a diagnosis
 *  worse than doing nothing.
 *
 *  **Zero-drift identity.** An untouched draft's own exit already equals a stamp taken from that
 *  same draft by the identical computation (`computeExit`), so the very first residual check is
 *  bit-exact zero and the solve returns immediately with every Δg exactly 0 — no floating step
 *  ever executes. */

import { forceProfile, type ForcePoint } from "./profile";
import { type Domain, type Entry, evalForce } from "./section";

/** the section's exit anchor a stamp addresses — `v` is excluded (energy conservation makes it a
 *  derived function of `y` given the fixed entry speed, so pinning `(x, y, θ)` pins it too). */
export interface OptimizeStamp {
    x: number;
    y: number;
    theta: number;
}

/** the fewest free keys a 3-row exit pin can generically satisfy — the counting necessary
 *  condition, and the only one the ambient badge can read without a Jacobian (the other two
 *  `"unreachable"` certificates — stall, conditioning — run at invoke; see the module header). */
export const MIN_FREE = 3;

const F32_EPS = 2 ** -24;

/** the derived f32 replay floor (`kex2d-optimize-mode` locked decision): the tolerance below
 *  which "restored" is meaningless, because the f32 production integrator itself can't replay an
 *  exit more precisely. Each of the march's N steps commits a rounding error of order
 *  `ε_f32 · scale` (the state is stored f32 at the exit's own magnitude), and the stamp and the
 *  replay follow different g-vectors, so their roundings are independent — a random walk whose
 *  accumulated disagreement is a walk with σ = `ε_f32 · scale · √N`. The tolerance asserts a
 *  single residual READ, which scatters with that same σ even at the true fixpoint, so the
 *  floor carries the standard 3σ coverage factor — a true solution reads "restored" reliably,
 *  where a 1σ floor rejects it ~1 time in 3 (measured: a converged 400 m case grinding at
 *  1.1σ). Never an absolute number: at exit x ≈ 400 m over 800 steps the floor is ~2e-3 (the
 *  stage-1 fixed 1e-4 sat far below it and refused honest solves), at 40 m over 80 steps ~6e-5.
 *  Measured against the mechanism in `tests/optimize.lab.ts` §2–3: the per-read RMS scatter is
 *  ≤1 ulp of scale and the SQP loop reliably converges under this floor across the corpus.
 *  The angle floor is the same length in the scaled-row frame: `pos / length` (a heading error
 *  δθ displaces the downstream by ~L·δθ, the same lever the θ residual row is weighted by). */
export function derivedTol(
    stamp: OptimizeStamp,
    length: number,
    ds: number,
): { pos: number; angle: number } {
    const edges = Math.max(1, Math.round(length / ds));
    const scale = Math.max(Math.abs(stamp.x), Math.abs(stamp.y), length);
    const pos = 3 * F32_EPS * Math.sqrt(edges) * scale;
    return { pos, angle: pos / length };
}

const MAX_ITERS = 30;
/** the FD Jacobian's own relative accuracy, `cbrt(ε_f32)² = 2^-16` (the optimal-step central
 *  difference's error scale, NR §5.7 — the same derivation as `JAC_H` below). A singular-value
 *  ratio below it means the smallest pin direction lies inside the Jacobian's own noise: the
 *  three constraint rows cannot be certified independent at working precision, the
 *  necessary-condition reading behind the `"conditioning"` refusal. Measured separation in
 *  `tests/optimize.lab.ts` §4: healthy corpus drafts sit at 2.6e-3…1.4e-2, an exactly-flat draft
 *  at 0, while a ±0.01 g near-straight wiggle (5.2e-5) stays ABOVE the line and solves — the
 *  certificate only fires on what it can certify. */
const COND_FLOOR = 2 ** -16;
/** backtrack exhaustion: a step damped below this without a strict improvement has proven its
 *  linearization useless (2^-10 of the SQP step), so the stage refuses instead of accepting. */
const T_MIN = 1e-3;
/** adaptive continuation budget: at most this many homotopy stage-solves after the direct
 *  attempt — sized from the lab §1 re-baseline (worst corpus direct solve ~54 ms, typical
 *  0.4–21 ms), bounding the whole solve near a second off-thread even at the cap. */
const STAGE_BUDGET = 32;
/** halving floor for the attempted fraction of the remaining gap: eight consecutive failed
 *  halvings (2^-8) means progress along the path has stopped — refuse as "did not converge"
 *  rather than grind the budget on an unreachable (or folded) branch. */
const FRAC_MIN = 2 ** -8;
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
 *  loop — it converges to ~1e-3 and then random-walks above the floor until `MAX_ITERS`, which
 *  a modest single-key edit reaches (a ±0.2 g tweak refused on 6 of 30 corpus cases). */
const JAC_H = 2 ** -8;

export type OptimizeOutcome = "solved" | "unreachable" | "diverged";

/** which necessary-condition check certified an `"unreachable"` refusal (absent otherwise). */
export type UnreachableReason = "free-count" | "stall" | "conditioning";

export interface OptimizeResult {
    /** the input points with only free-index `g` fields rewritten — `s`, `ease`, `in`/`out`, and
     *  every locked key's `g` are the SAME values passed in, by construction (the masking
     *  invariant, asserted structurally in `tests/optimize.test.ts`). */
    points: ForcePoint[];
    /** per-key Δg (length === `points.length`), 0 at every locked index — the solve's ledger. */
    deltaG: number[];
    outcome: OptimizeOutcome;
    /** set iff `outcome === "unreachable"` — the certifying necessary-condition check. */
    reason?: UnreachableReason;
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
    const tolD = derivedTol(stamp, length, ds);
    const tol = opts.tol ?? tolD.pos;
    const angleTol = opts.angleTol ?? tolD.angle;
    // the θ row's weight (metres per radian): a heading error δθ displaces the downstream track
    // by ~L·δθ, so the scaled frame [x, y, W·θ] compares all three residual rows in metres.
    // Without it the radian row sits ~20× below the metre rows and the backtrack's max-norm
    // criterion effectively ignores the heading. W = length at the derived defaults.
    const W = tol / angleTol;
    const K = points.length;
    const g0 = Float64Array.from(points, (p) => p.g);
    const freeIdx: number[] = [];
    for (let k = 0; k < K; k++) if (!locked.has(k)) freeIdx.push(k);
    const P = freeIdx.length;

    const zeroResult = (
        outcome: OptimizeOutcome,
        reason: UnreachableReason | undefined,
        iters: number,
        res: number,
        ang: number,
    ): OptimizeResult => ({
        points: points.map((p) => ({ ...p })),
        deltaG: new Array(K).fill(0),
        outcome,
        ...(reason === undefined ? {} : { reason }),
        iters,
        residual: res,
        angleResidual: ang,
    });

    if (P < MIN_FREE) return zeroResult("unreachable", "free-count", 0, NaN, NaN);

    const exitAt = (g: ArrayLike<number>): { x: number; y: number; theta: number } => {
        const dense = forceProfile(withG(points, g), length, ds);
        return evalForce(entry, dense, ds, domain).exit;
    };

    const e0 = exitAt(g0);
    const c0 = residualOf(e0, stamp);
    if (c0[0] === 0 && c0[1] === 0 && c0[2] === 0) return zeroResult("solved", undefined, 0, 0, 0);

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
            undefined,
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

    // exit Jacobian w.r.t. the free g's, central-differenced against the production integrator
    // around the given iterate (the constraint linearization point). Raw rows [x, y, θ] —
    // callers apply the W row scaling themselves.
    const jacobianAt = (z: Float64Array): Float64Array[] => {
        const J = [new Float64Array(P), new Float64Array(P), new Float64Array(P)];
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
        return J;
    };

    // ── the at-invoke Jacobian-read certificates (one FD pass, J0 reused below) ──
    const res0 = Math.max(Math.abs(c0[0]), Math.abs(c0[1]));
    const ang0 = Math.abs(c0[2]);

    // (stall) the θ-row derivative-consistency read: the same eP/eM probes the central
    // difference is built from also give the two one-sided differences. On a smooth map both
    // carry the derivative's own sign wherever `h·|f''| < |f'|` — and where curvature exceeds
    // that, they still agree in sign (measured: a +3 g large-drift draft reads a 1.4× magnitude
    // disagreement yet same-signed slopes, and solves). OPPOSITE signs, with both magnitudes
    // above the FD read's own noise floor (so a zero-leverage row can't fire on noise-over-
    // noise), means the map ascends on one side of the draft and descends on the other at the
    // probe scale — a cliff, not curvature: the vSafe-clamp signature (module header). Sign
    // opposition is threshold-free and scale-free — no V_WARN or L assumption (the removed
    // closed-form cap `G·L/V_WARN²` assumed v ≥ V_WARN on every edge and went unboundedly loose
    // with L: at L = 400 it missed a localized stall). Measured in `tests/optimize.lab.ts` §4b:
    // every floor-touching draft shows ≥1 opposite-sign key (the clamp's ±10⁴ rad kick), every
    // smooth draft none — healthy corpus, near-stall smooth (vMin 2.8), curvature-stress drifts,
    // graze, deep stall, the L = 400 localized stall.
    const scale = Math.max(Math.abs(stamp.x), Math.abs(stamp.y), length);
    const noiseSlope = (F32_EPS * scale) / JAC_H;
    const J0 = [new Float64Array(P), new Float64Array(P), new Float64Array(P)];
    let cliff = false;
    for (let m = 0; m < P; m++) {
        const zP = Float64Array.from(z0);
        zP[m] += JAC_H;
        const zM = Float64Array.from(z0);
        zM[m] -= JAC_H;
        const eP = exitAt(scatter(zP));
        const eM = exitAt(scatter(zM));
        J0[0][m] = (eP.x - eM.x) / (2 * JAC_H);
        J0[1][m] = (eP.y - eM.y) / (2 * JAC_H);
        J0[2][m] = (eP.theta - eM.theta) / (2 * JAC_H);
        const fwd = (length * (eP.theta - e0.theta)) / JAC_H;
        const bwd = (length * (e0.theta - eM.theta)) / JAC_H;
        if (fwd * bwd < 0 && Math.min(Math.abs(fwd), Math.abs(bwd)) > noiseSlope) cliff = true;
    }
    if (cliff) return zeroResult("unreachable", "stall", 0, res0, ang0);

    // (conditioning) σmin/σmax of the scaled Jacobian, read exactly off the 3×3 J·Jᵀ
    // eigenvalues (cyclic Jacobi): below COND_FLOOR the smallest pin direction is inside the
    // FD's own noise — the rows cannot be certified independent, so the pin is unreachable
    // at working precision (the near-straight trap: the x row vanishes at first order).
    const A0 = new Float64Array(9);
    for (let a = 0; a < 3; a++)
        for (let b = a; b < 3; b++) {
            const wa = a === 2 ? W : 1;
            const wb = b === 2 ? W : 1;
            let s = 0;
            for (let m = 0; m < P; m++) s += wa * J0[a][m] * wb * J0[b][m];
            A0[a * 3 + b] = s;
            A0[b * 3 + a] = s;
        }
    const eigs = sym3Eigs(A0);
    const lamMax = Math.max(...eigs);
    if (lamMax <= 0 || Math.sqrt(Math.max(0, Math.min(...eigs)) / lamMax) < COND_FLOOR)
        return zeroResult("unreachable", "conditioning", 0, res0, ang0);

    // ── one damped-SQP stage toward `target`, warm-started at `zStart` ──
    // The objective reference stays the global draft `z0` regardless of stage: minimize
    // ‖z − z0‖_M subject to the stage target, so a continuation answer is still min-change
    // from the current draft. `firstJ` reuses the invoke Jacobian when `zStart` is `z0`
    // (the Jacobian depends on the iterate, never on the target).
    const gn = (
        target: OptimizeStamp,
        zStart: Float64Array,
        firstJ: Float64Array[] | null,
        // an intermediate homotopy stage converges its target to the same RELATIVE depth the
        // final stage does (frac × the floor) — at the full tolerance a fractional target can
        // sit inside it from the start and the stage would "solve" without moving.
        tolScale = 1,
    ): { z: Float64Array; solved: boolean; iters: number } => {
        const tolS = tolScale * tol;
        const angleTolS = tolScale * angleTol;
        let z: Float64Array = Float64Array.from(zStart);
        for (let it = 0; it < maxIters; it++) {
            const c = residualOf(exitAt(scatter(z)), target);
            if (Math.abs(c[0]) < tolS && Math.abs(c[1]) < tolS && Math.abs(c[2]) < angleTolS)
                return { z, solved: true, iters: it };
            const rNow = Math.max(Math.abs(c[0]), Math.abs(c[1]), W * Math.abs(c[2]));

            const J = it === 0 && firstJ !== null ? firstJ : jacobianAt(z);
            // U[c] = M⁻¹ J_cᵀ (three P-vectors); A3 = J M⁻¹ Jᵀ (3×3, symmetric);
            // rhs = J(z0−z) + c — all in the scaled row frame [1, 1, W].
            const U: Float64Array[] = J.map((row) => choleskySolve(Ml, P, row));
            const A3 = new Float64Array(9);
            for (let a = 0; a < 3; a++)
                for (let b = 0; b < 3; b++) {
                    const wa = a === 2 ? W : 1;
                    const wb = b === 2 ? W : 1;
                    let s = 0;
                    for (let k = 0; k < P; k++) s += wb * J[b][k] * wa * U[a][k];
                    A3[a * 3 + b] = s;
                }
            const rhs = new Float64Array(3);
            for (let a = 0; a < 3; a++) {
                const wa = a === 2 ? W : 1;
                let s = wa * c[a];
                for (let k = 0; k < P; k++) s += wa * J[a][k] * (z0[k] - z[k]);
                rhs[a] = s;
            }
            const A3l = choleskyFactor(A3, 3);
            // rank-deficient at an interior iterate — not certifiable at invoke, so the stage
            // just fails ("did not converge" unless a finer ladder rung gets past it).
            if (!A3l) return { z, solved: false, iters: it };
            const lambda = choleskySolve(A3l, 3, rhs);

            const zNext = new Float64Array(P);
            for (let k = 0; k < P; k++) {
                let s = z0[k];
                for (let a = 0; a < 3; a++) s -= (a === 2 ? W : 1) * U[a][k] * lambda[a];
                zNext[k] = s;
            }

            // honest backtrack: accept ONLY a strict scaled-residual improvement. A step damped
            // below T_MIN without one has proven the linearization useless here — refuse the
            // stage rather than accept a proven-useless step and wander (the stage-1 bug).
            // The full step gets a second chance as a second-order correction (Nocedal & Wright
            // §15.4, the Maratos fix): the objective pull moves laterally along the CURVED
            // constraint manifold, so the full step's residual can rise even when the step is
            // right — one more constraint solve at zNext with the SAME Jacobian removes the
            // curvature-induced violation instead of collapsing the step to a creep.
            const scaledRes = (cand: Float64Array): number => {
                const cT = residualOf(exitAt(scatter(cand)), target);
                return Math.max(Math.abs(cT[0]), Math.abs(cT[1]), W * Math.abs(cT[2]));
            };
            const soc = (): Float64Array => {
                const cN = residualOf(exitAt(scatter(zNext)), target);
                const rhs2 = new Float64Array(3);
                for (let a = 0; a < 3; a++) rhs2[a] = (a === 2 ? W : 1) * cN[a];
                const lam2 = choleskySolve(A3l, 3, rhs2);
                const zSoc = new Float64Array(P);
                for (let k = 0; k < P; k++) {
                    let s = zNext[k];
                    for (let a = 0; a < 3; a++) s -= (a === 2 ? W : 1) * U[a][k] * lam2[a];
                    zSoc[k] = s;
                }
                return zSoc;
            };
            let zTrial: Float64Array | null = null;
            const zSoc = soc();
            if (scaledRes(zSoc) < rNow) zTrial = zSoc;
            for (let t = 1; zTrial === null && t >= T_MIN; t *= 0.5) {
                const cand = new Float64Array(P);
                for (let k = 0; k < P; k++) cand[k] = z[k] + t * (zNext[k] - z[k]);
                if (scaledRes(cand) < rNow) zTrial = cand;
            }
            if (zTrial === null) {
                // restoration fallback: a pure min-M-norm constraint correction FROM z (drop
                // the z0 pull). The SQP rhs carries J(z0−z), whose FD noise scales with the
                // TOTAL drift and floors the reachable residual well above the replay floor on
                // a large edit; the restoration rhs is the residual alone, so its noise
                // contracts with it — this is what closes the last decade down to the derived
                // floor. The objective cost is O(residual) in g — imperceptible.
                const rhsR = new Float64Array(3);
                for (let a = 0; a < 3; a++) rhsR[a] = (a === 2 ? W : 1) * c[a];
                const lamR = choleskySolve(A3l, 3, rhsR);
                const dR = new Float64Array(P);
                for (let k = 0; k < P; k++) {
                    let s = 0;
                    for (let a = 0; a < 3; a++) s += (a === 2 ? W : 1) * U[a][k] * lamR[a];
                    dR[k] = -s;
                }
                for (let t = 1; zTrial === null && t >= T_MIN; t *= 0.5) {
                    const cand = new Float64Array(P);
                    for (let k = 0; k < P; k++) cand[k] = z[k] + t * dR[k];
                    if (scaledRes(cand) < rNow) zTrial = cand;
                }
            }
            if (zTrial === null) return { z, solved: false, iters: it + 1 };
            z = zTrial;
        }
        return { z, solved: false, iters: maxIters };
    };

    const finalize = (z: Float64Array, outcome: OptimizeOutcome, iters: number): OptimizeResult => {
        const gFinal = scatter(z);
        const c = residualOf(exitAt(gFinal), stamp);
        const outPoints = points.map((p, k) => ({ ...p, g: gFinal[k] }));
        const deltaG = new Array(K).fill(0);
        for (const k of freeIdx) deltaG[k] = gFinal[k] - g0[k];
        return {
            points: outPoints,
            deltaG,
            outcome,
            iters,
            residual: Math.max(Math.abs(c[0]), Math.abs(c[1])),
            angleResidual: Math.abs(c[2]),
        };
    };

    const scaledAt = (z: Float64Array): number => {
        const c = residualOf(exitAt(scatter(z)), stamp);
        return Math.max(Math.abs(c[0]), Math.abs(c[1]), W * Math.abs(c[2]));
    };

    // direct attempt first — the common small-drift case lands here in a few iterations.
    let iters = 0;
    const direct = gn(stamp, z0, J0);
    iters += direct.iters;
    if (direct.solved) return finalize(direct.z, "solved", iters);

    // adaptive continuation: re-anchored homotopy. Walk the target from the best achieved
    // exit toward the stamp — attempt the full remaining gap, halve the attempted fraction on
    // a failed stage, double it back on a solved one, and re-anchor at each success (so no
    // stage ever discards progress already made). A local method can't tell a fold from a
    // basin miss, so exhausting FRAC_MIN or the budget refuses as "did not converge".
    let bestZ: Float64Array = z0;
    let bestRes = scaledAt(z0);
    const consider = (z: Float64Array): void => {
        const r = scaledAt(z);
        if (r < bestRes) {
            bestRes = r;
            bestZ = z;
        }
    };
    consider(direct.z);
    let frac = 0.5;
    for (let stages = 0; stages < STAGE_BUDGET && frac >= FRAC_MIN; stages++) {
        const e = exitAt(scatter(bestZ));
        const c = residualOf(e, stamp);
        if (Math.abs(c[0]) < tol && Math.abs(c[1]) < tol && Math.abs(c[2]) < angleTol)
            return finalize(bestZ, "solved", iters);
        const target: OptimizeStamp =
            frac === 1
                ? stamp
                : {
                      x: e.x + frac * (stamp.x - e.x),
                      y: e.y + frac * (stamp.y - e.y),
                      theta: e.theta + frac * (stamp.theta - e.theta),
                  };
        const st = gn(target, bestZ, null, frac);
        iters += st.iters;
        if (st.solved) {
            consider(st.z);
            frac = Math.min(1, frac * 2);
        } else {
            consider(st.z);
            frac *= 0.5;
        }
    }

    // refused: report the best-known reading against the true stamp — never a diagnosis worse
    // than the drift the author started from.
    return finalize(bestZ, "diverged", iters);
}

/** eigenvalues of a symmetric 3×3 (row-major) by cyclic Jacobi — exact to working precision in
 *  a handful of sweeps at this size; the conditioning certificate reads σ² ratios off it. */
function sym3Eigs(A: Float64Array): number[] {
    const m = Array.from(A);
    for (let sweep = 0; sweep < 32; sweep++) {
        let off = 0;
        for (const [p, q] of [
            [0, 1],
            [0, 2],
            [1, 2],
        ]) {
            const apq = m[p * 3 + q];
            off += apq * apq;
            if (apq === 0) continue;
            const theta = (m[q * 3 + q] - m[p * 3 + p]) / (2 * apq);
            const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
            const c = 1 / Math.sqrt(t * t + 1);
            const s = t * c;
            for (let i = 0; i < 3; i++) {
                const aip = m[i * 3 + p];
                const aiq = m[i * 3 + q];
                m[i * 3 + p] = c * aip - s * aiq;
                m[i * 3 + q] = s * aip + c * aiq;
            }
            for (let i = 0; i < 3; i++) {
                const api = m[p * 3 + i];
                const aqi = m[q * 3 + i];
                m[p * 3 + i] = c * api - s * aqi;
                m[q * 3 + i] = s * api + c * aqi;
            }
        }
        if (off < 1e-30) break;
    }
    return [m[0], m[4], m[8]];
}
