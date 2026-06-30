const G = 9.80665;

/**
 * recovery-anchor sensitivity rows — the linearized geometry the Phase-2 anchor
 * pulls back to the draft (roadmap "kex2d Phase 2a", `scratch.md` "Optimizer
 * design").
 *
 * a force edit reshapes geometry *downstream* of the edit: the F_n bump's net
 * area is a persistent heading change, so every sample past it rigidly
 * transforms. the recovery anchor heals that by pulling the rollout's position
 * + heading at a recovery point `r` back to the draft. F_n stays the only
 * decision variable; the anchor is a loss term scored on the geometry F_n
 * produces — the *linearized* rollout — so the whole optimizer stays a convex
 * QP. this builds the linear functionals (∂x_r/∂F, ∂y_r/∂F, ∂θ_r/∂F) the anchor
 * needs.
 *
 * the model is the exact tangent (variational) linearization of the forward
 * integrator about the draft trajectory — not the cruder frozen-velocity
 * operator (`a_i = g·ds/v°²` alone). the dynamical subsystem (θ, s = v²) closes
 * without x,y:
 *
 *   θ_{i+1} = θ_i + (F_i − cos θ_i)·g·ds_i / s_i
 *   s_{i+1} = s_i − 2g·ds_i·sin(½(θ_i + θ_{i+1}))
 *
 * so the per-step partials about the draft (θ°, s°) are
 *
 *   ∂θ_{i+1}/∂θ_i = 1 + g·ds_i·sin θ°_i / s°_i        (= a)
 *   ∂θ_{i+1}/∂s_i = −(θ°_{i+1} − θ°_i) / s°_i          (= b)
 *   ∂θ_{i+1}/∂F_i = g·ds_i / s°_i                       (= c)
 *   ∂s_{i+1}/∂θ_i = ∂s_{i+1}/∂θ_{i+1} = −g·ds_i·cos midθ°_i   (= P)
 *   ∂s_{i+1}/∂s_i = 1
 *
 * propagating the variational state forward (θ-sensitivity feeds s-sensitivity
 * via the shared midpoint, both feed back into θ) and accumulating the position
 * rows from ∂midθ_m/∂F gives the three dense rows. nonzero only for i < r
 * (causality: F_i drives sample i→i+1, so it only affects samples after it).
 * O(N²); N is the draft-time grid (~256), built once per solve.
 */
export interface RecoveryRows {
    /** ∂x_r/∂F[i] — length N, zero for i ≥ r. */
    x: Float64Array;
    /** ∂y_r/∂F[i] — length N, zero for i ≥ r. */
    y: Float64Array;
    /** ∂θ_r/∂F[i] — length N, zero for i ≥ r. */
    theta: Float64Array;
}

/**
 * build the recovery-anchor rows at sample `r`, linearized about the draft
 * rollout `(theta°, v°)` over the per-step grid `ds`. `theta`/`v` are length N
 * (the draft-time grid); `ds` is length N−1 (per-step arclength). `r` is the
 * recovery index in `1 .. N−1`. the rows are pure functions of the draft, so
 * they hold across the solver's active-set passes.
 *
 * @example
 * const { x, y, theta } = recoveryRows(thetaDraft, vDraft, dsGrid, N - 1);
 */
export function recoveryRows(
    theta: Float64Array,
    v: Float64Array,
    ds: Float32Array,
    r: number,
    g: number = G,
): RecoveryRows {
    const n = theta.length;
    const gx = new Float64Array(n);
    const gy = new Float64Array(n);
    const gt = new Float64Array(n);
    const end = Math.min(Math.max(r, 0), n - 1);

    // running variational state: dT[i] = ∂θ_j/∂F[i], dS[i] = ∂s_j/∂F[i] for the
    // current sample j (starts at j = 0, where θ,s are the launch state — F-free).
    const dT = new Float64Array(n);
    const dS = new Float64Array(n);

    for (let j = 0; j < end; j++) {
        const sj = v[j] * v[j];
        const dsj = ds[j];
        const a = 1 + (g * dsj * Math.sin(theta[j])) / sj;
        const b = -(theta[j + 1] - theta[j]) / sj;
        const c = (g * dsj) / sj;
        const midT = 0.5 * (theta[j] + theta[j + 1]);
        const sinMid = Math.sin(midT);
        const cosMid = Math.cos(midT);
        const P = -g * dsj * cosMid; // ∂s_{j+1}/∂θ_j = ∂s_{j+1}/∂θ_{j+1}

        // θ-sensitivity first (it feeds the s-update via the shared midpoint),
        // then accumulate the position rows from the midpoint sensitivity
        // ∂midθ_j/∂F[i] = ½(∂θ_j/∂F[i] + ∂θ_{j+1}/∂F[i]), then advance s.
        for (let i = 0; i <= j; i++) {
            const newT = a * dT[i] + b * dS[i] + (i === j ? c : 0);
            const midSens = 0.5 * (dT[i] + newT);
            gx[i] += dsj * -sinMid * midSens;
            gy[i] += dsj * cosMid * midSens;
            dS[i] = dS[i] + P * (dT[i] + newT);
            dT[i] = newT;
        }
    }

    gt.set(dT.subarray(0, end), 0);
    return { x: gx, y: gy, theta: gt };
}
