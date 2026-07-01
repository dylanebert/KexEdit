const G = 9.80665;

/**
 * geometry→force map, f64 — the collocation atom (roadmap "kex2d", spec
 * `kex/specs/kex2d-collocation.md`). the decision variable is dense sample
 * positions `P_i=(x_i,y_i)` on a uniform arclength grid; force is a *local*,
 * differentiable function of nearby positions, which is the well-conditioned
 * (differentiation) direction — the whole point of geometry-primal solving.
 *
 * per interior sample, from central position differences on the grid:
 *
 *   x'  = (x_{i+1} − x_{i−1})/2ds     x'' = (x_{i+1} − 2x_i + x_{i−1})/ds²   (same for y)
 *   θ_i = atan2(y', x')
 *   κ_i = (x'·y'' − y'·x'') / (x'² + y'²)^{3/2}     ← full quotient; P is NOT unit-speed
 *   v²_i = v0² − 2g·y_i                              ← energy, local in y_i (raw, unclamped)
 *   F_i = κ_i·v²_i/g + cos θ_i                       = the normal force a cart feels
 *
 * this is the Kelly/Betts collocation defect: node-centered, symmetric,
 * O(ds²)-consistent with the continuum. deliberately NOT the forward
 * integrator's reflection inverse (`bake.invertRange`), whose ±(−1)^i leapfrog
 * mode sawtooths κ and would re-enter the normal equations as a spurious
 * near-null direction — `bake.ts forces` chose the same bisector tangent for
 * exactly this reason. `v²` is kept raw (no `vSafe`/`sqrt` clamp) so F stays
 * C^∞, the differentiability win over the clamped forward integrator; callers
 * keep the curve feasible (v² well above 0).
 *
 * endpoints `P_0`, `P_{N−1}` are hard-pinned in the collocation problem (they
 * connect to the rest of the track), so they carry no residual/Jacobian row.
 * `F/θ/κ` at the ends are linearly extrapolated from the interior for display +
 * the round-trip forward feed only — not collocation quantities.
 */
export interface ForceOut {
    /** normal force in g, length N; interior `1..N−2` central, ends extrapolated. */
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
    ds: number,
    v0: number,
    g: number = G,
): ForceOut {
    const fN = new Float64Array(N);
    const theta = new Float64Array(N);
    const kappa = new Float64Array(N);
    const v2 = new Float64Array(N);

    for (let i = 0; i < N; i++) v2[i] = v0 * v0 - 2 * g * y[i];

    for (let i = 1; i < N - 1; i++) {
        const a = (x[i + 1] - x[i - 1]) / (2 * ds); // x'
        const b = (y[i + 1] - y[i - 1]) / (2 * ds); // y'
        const c = (x[i + 1] - 2 * x[i] + x[i - 1]) / (ds * ds); // x''
        const e = (y[i + 1] - 2 * y[i] + y[i - 1]) / (ds * ds); // y''
        const r2 = a * a + b * b;
        theta[i] = Math.atan2(b, a);
        kappa[i] = (a * e - b * c) / (r2 * Math.sqrt(r2));
        fN[i] = (kappa[i] * v2[i]) / g + Math.cos(theta[i]);
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
 * `F_i` depends on P only through `θ_i`, `κ_i` (each a function of
 * `P_{i−1},P_i,P_{i+1}`) and `v²_i` (a function of `y_i` alone), so **row i is
 * nonzero only in the six columns `x_{i−1},y_{i−1},x_i,y_i,x_{i+1},y_{i+1}`** —
 * half-bandwidth 1 per coordinate. only the interior rows `i = 1..N−2` exist
 * (endpoints pinned).
 *
 * rows are returned flat: row `r = i−1` occupies `entries[r*6 .. r*6+6)` in the
 * fixed column order `[x_{i−1}, y_{i−1}, x_i, y_i, x_{i+1}, y_{i+1}]`. the six
 * partials come from the chain rule through atan2 and the curvature quotient
 * (`s2=v²_i`, `r2=x'²+y'²`):
 *
 *   ∂θ/∂a = −b/r2                       ∂θ/∂b =  a/r2
 *   ∂cosθ/∂a = b²/r2^{3/2}              ∂cosθ/∂b = −ab/r2^{3/2}
 *   ∂κ/∂a = e/r2^{3/2} − 3a·κ/r2        ∂κ/∂b = −c/r2^{3/2} − 3b·κ/r2
 *   ∂κ/∂c = −b/r2^{3/2}                 ∂κ/∂e =  a/r2^{3/2}
 *   ∂v²/∂y_i = −2g   (else 0)
 *
 * composed with the constant stencil coefficients (`∂a/∂x_{i±1}=±1/2ds`,
 * `∂c/∂x_{i±1}=1/ds²`, `∂c/∂x_i=−2/ds²`; a,c ⟂ y and b,e ⟂ x). the two diagonal
 * entries scale like `1/ds²` (the stiff curvature term); the `−2κ` on `∂F/∂y_i`
 * is the sole `v²` coupling (θ has no `y_i` dependence — central `y'` excludes
 * `y_i`). validated entrywise against central finite differences.
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
    ds: number,
    v0: number,
    g: number = G,
): ForceJac {
    const M = Math.max(0, N - 2);
    const entries = new Float64Array(M * 6);
    const halfDs = 1 / (2 * ds);
    const invDs2 = 1 / (ds * ds);

    for (let i = 1; i < N - 1; i++) {
        const a = (x[i + 1] - x[i - 1]) / (2 * ds);
        const b = (y[i + 1] - y[i - 1]) / (2 * ds);
        const c = (x[i + 1] - 2 * x[i] + x[i - 1]) * invDs2;
        const e = (y[i + 1] - 2 * y[i] + y[i - 1]) * invDs2;
        const r2 = a * a + b * b;
        const r32 = r2 * Math.sqrt(r2);
        const kappa = (a * e - b * c) / r32;
        const s2overG = (v0 * v0 - 2 * g * y[i]) / g;

        // intermediate partials (∂θ folds directly into ∂cosθ = −sinθ·∂θ)
        const dCosA = (b * b) / r32; // −sinθ · ∂θ/∂a
        const dCosB = (-a * b) / r32; // −sinθ · ∂θ/∂b
        const dKA = e / r32 - (3 * a * kappa) / r2;
        const dKB = -c / r32 - (3 * b * kappa) / r2;
        const dKC = -b / r32;
        const dKE = a / r32;

        // F = s2/g·κ + cosθ, chain through the stencil coefficients.
        const r = (i - 1) * 6;
        entries[r + 0] = s2overG * (dKA * -halfDs + dKC * invDs2) + dCosA * -halfDs; // ∂/∂x_{i−1}
        entries[r + 1] = s2overG * (dKB * -halfDs + dKE * invDs2) + dCosB * -halfDs; // ∂/∂y_{i−1}
        entries[r + 2] = s2overG * (dKC * -2 * invDs2); // ∂/∂x_i  (x_i ⟂ θ)
        entries[r + 3] = s2overG * (dKE * -2 * invDs2) - 2 * kappa; // ∂/∂y_i  (+ energy term)
        entries[r + 4] = s2overG * (dKA * halfDs + dKC * invDs2) + dCosA * halfDs; // ∂/∂x_{i+1}
        entries[r + 5] = s2overG * (dKB * halfDs + dKE * invDs2) + dCosB * halfDs; // ∂/∂y_{i+1}
    }

    return { n: N, entries };
}
