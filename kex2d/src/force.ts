const G = 9.80665;

/**
 * geometry→force map, f64 — the collocation atom (spec
 * `kex/specs/kex2d-unified-solver.md`). the decision variable is dense sample
 * positions `P_i=(x_i,y_i)`; force is a *local*, differentiable,
 * **parametrization-invariant** function of nearby positions — the
 * well-conditioned direction, and immune to the grid-stretch cheat.
 *
 * per interior sample, from the actual neighbor geometry (NOT an assumed grid
 * spacing — the Stage-2 lab caught a fixed-ds difference scheme being gamed:
 * a hard force demand was satisfied by sliding nodes along the curve, which
 * stretches local spacing and aliases into the measured κ with no real
 * reshaping; chord-based quantities close that loophole by construction):
 *
 *   e⁻ = P_i − P_{i−1},  e⁺ = P_{i+1} − P_i,  m = P_{i+1} − P_{i−1}
 *   κ_i = 2·(e⁻ × e⁺) / (|e⁻|·|e⁺|·|m|)       ← Menger curvature (circumcircle
 *                                                of the 3 points; exact 1/R on a
 *                                                circle at ANY spacing)
 *   cosθ_i = m_x/|m|                           ← tangent from the neighbor chord
 *   v²_i = v0² − 2g·y_i                        ← energy, local in y_i (raw, unclamped)
 *   F_i = κ_i·v²_i/g + cosθ_i                  = the normal force a cart feels
 *
 * sliding a node along the curve now leaves κ, θ, v² (hence F) unchanged — the
 * tangential/reparametrization direction is *exactly* the Jacobian's null space,
 * so the LM kernel's gauge-freeze argument holds for the discretization, not
 * just the continuum. `v²` is kept raw (no `vSafe`/`sqrt` clamp) so F stays C^∞,
 * the differentiability win over the clamped forward integrator; callers keep
 * the curve feasible (v² well above 0). same bisector-tangent family as
 * `bake.ts forces` (the shipping f32 bake), so solver-F and bake-F agree by
 * definition up to precision and node- vs edge-centering.
 *
 * endpoints `P_0`, `P_{N−1}` are hard-pinned in the collocation problem (they
 * connect to the rest of the track), so they carry no residual/Jacobian row.
 * `F/θ/κ` at the ends are linearly extrapolated from the interior for display +
 * the round-trip forward feed only — not collocation quantities.
 */
export interface ForceOut {
    /** normal force in g, length N; interior `1..N−2` chord-based, ends extrapolated. */
    fN: Float64Array;
    /** tangent angle (rad), length N. */
    theta: Float64Array;
    /** signed curvature (1/m), length N. */
    kappa: Float64Array;
    /** speed² (m²/s²) = v0² − 2g·y_i, length N (raw, may go negative if infeasible). */
    v2: Float64Array;
}

export function forces64(
    x: Float64Array,
    y: Float64Array,
    N: number,
    v0: number,
    g: number = G,
): ForceOut {
    const fN = new Float64Array(N);
    const theta = new Float64Array(N);
    const kappa = new Float64Array(N);
    const v2 = new Float64Array(N);

    for (let i = 0; i < N; i++) v2[i] = v0 * v0 - 2 * g * y[i];

    for (let i = 1; i < N - 1; i++) {
        const ux = x[i] - x[i - 1];
        const uy = y[i] - y[i - 1];
        const wx = x[i + 1] - x[i];
        const wy = y[i + 1] - y[i];
        const mx = ux + wx;
        const my = uy + wy;
        const lu = Math.hypot(ux, uy);
        const lw = Math.hypot(wx, wy);
        const lm = Math.hypot(mx, my);
        const cross = ux * wy - uy * wx;
        theta[i] = Math.atan2(my, mx);
        kappa[i] = (2 * cross) / (lu * lw * lm);
        fN[i] = (kappa[i] * v2[i]) / g + mx / lm;
    }

    // linear extrapolation of the interior trend to the pinned ends (O(ds²),
    // display + round-trip forward feed only; not a collocation row).
    if (N >= 3) {
        theta[0] = 2 * theta[1] - theta[2];
        kappa[0] = 2 * kappa[1] - kappa[2];
        theta[N - 1] = 2 * theta[N - 2] - theta[N - 3];
        kappa[N - 1] = 2 * kappa[N - 2] - kappa[N - 3];
        for (const i of [0, N - 1]) fN[i] = (kappa[i] * v2[i]) / g + Math.cos(theta[i]);
    }

    return { fN, theta, kappa, v2 };
}

/**
 * the analytic Jacobian `∂F_i/∂P` of `forces64`, banded because force is local.
 * `F_i` depends on P only through the two edges `e⁻, e⁺` and `v²_i`, so **row i
 * is nonzero only in the six columns `x_{i−1},y_{i−1},x_i,y_i,x_{i+1},y_{i+1}`** —
 * half-bandwidth 1 per coordinate. only the interior rows `i = 1..N−2` exist
 * (endpoints pinned).
 *
 * rows are returned flat: row `r = i−1` occupies `entries[r*6 .. r*6+6)` in the
 * fixed column order `[x_{i−1}, y_{i−1}, x_i, y_i, x_{i+1}, y_{i+1}]`. with
 * `A = e⁻ × e⁺`, `κ = 2A/(l⁻ l⁺ m)`, `c = m_x/m` (cosθ):
 *
 *   ∂A/∂P_{i−1} = (−w_y,  w_x)      ∂A/∂P_i = (w_y+u_y, −w_x−u_x)   ∂A/∂P_{i+1} = (−u_y, u_x)
 *   ∂l⁻/∂P_{i−1} = −û    ∂l⁻/∂P_i = û      ∂l⁺/∂P_i = −ŵ    ∂l⁺/∂P_{i+1} = ŵ
 *   ∂m/∂P_{i±1} = ±m̂     ∂m/∂P_i = 0
 *   ∂κ = (2·∂A − κ·(∂l⁻·l⁺m + l⁻·∂l⁺·m + l⁻l⁺·∂m)) / (l⁻ l⁺ m)
 *   ∂c/∂P_{i+1} = ((1,0) − c·m̂)/m = −∂c/∂P_{i−1}     ∂c/∂P_i = 0
 *   ∂v²/∂y_i = −2g  ⇒  the `−2κ` term on ∂F/∂y_i
 *
 * validated entrywise against central finite differences.
 */
export interface ForceJac {
    /** node count N. */
    n: number;
    /** interior rows `1..N−2`, flat `(N−2)·6`; six partials per row in the order
     *  `[x_{i−1}, y_{i−1}, x_i, y_i, x_{i+1}, y_{i+1}]`. */
    entries: Float64Array;
}

export function forceJacobian(
    x: Float64Array,
    y: Float64Array,
    N: number,
    v0: number,
    g: number = G,
): ForceJac {
    const M = Math.max(0, N - 2);
    const entries = new Float64Array(M * 6);

    for (let i = 1; i < N - 1; i++) {
        const ux = x[i] - x[i - 1];
        const uy = y[i] - y[i - 1];
        const wx = x[i + 1] - x[i];
        const wy = y[i + 1] - y[i];
        const mx = ux + wx;
        const my = uy + wy;
        const lu = Math.hypot(ux, uy);
        const lw = Math.hypot(wx, wy);
        const lm = Math.hypot(mx, my);
        const A = ux * wy - uy * wx;
        const denom = lu * lw * lm;
        const kappa = (2 * A) / denom;
        const s2overG = (v0 * v0 - 2 * g * y[i]) / g;
        const c = mx / lm;

        // unit vectors
        const uhx = ux / lu;
        const uhy = uy / lu;
        const whx = wx / lw;
        const why = wy / lw;
        const mhx = mx / lm;
        const mhy = my / lm;

        // ∂κ/∂P at each of the three stencil nodes:
        //   κ = 2A/(l⁻l⁺m) ⇒ ∂κ = 2∂A/denom − κ·(∂l⁻/l⁻ + ∂l⁺/l⁺ + ∂m/m)
        const kPrevX = (2 * -wy) / denom - kappa * (-uhx / lu + -mhx / lm);
        const kPrevY = (2 * wx) / denom - kappa * (-uhy / lu + -mhy / lm);
        const kMidX = (2 * (wy + uy)) / denom - kappa * (uhx / lu + -whx / lw);
        const kMidY = (2 * (-wx - ux)) / denom - kappa * (uhy / lu + -why / lw);
        const kNextX = (2 * -uy) / denom - kappa * (whx / lw + mhx / lm);
        const kNextY = (2 * ux) / denom - kappa * (why / lw + mhy / lm);

        // ∂cosθ: only the outer nodes move m.
        const cNextX = (1 - c * mhx) / lm;
        const cNextY = (0 - c * mhy) / lm;

        const r = (i - 1) * 6;
        entries[r + 0] = s2overG * kPrevX - cNextX; // ∂/∂x_{i−1}
        entries[r + 1] = s2overG * kPrevY - cNextY; // ∂/∂y_{i−1}
        entries[r + 2] = s2overG * kMidX; // ∂/∂x_i
        entries[r + 3] = s2overG * kMidY - 2 * kappa; // ∂/∂y_i (+ energy term)
        entries[r + 4] = s2overG * kNextX + cNextX; // ∂/∂x_{i+1}
        entries[r + 5] = s2overG * kNextY + cNextY; // ∂/∂y_{i+1}
    }

    return { n: N, entries };
}
