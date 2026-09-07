/**
 * general symmetric-banded LDLᵀ — the collocation solver's linear-algebra atom
 * (spec `kex/specs/kex2d-collocation.md`). the geometry normal equations `JᵀJ`
 * are symmetric positive-definite and banded (locality of the force map), so a
 * direct banded factorization solves them exactly regardless of conditioning.
 * this generalizes `solve.ts`'s `pentaFactor` (the b=2 pentadiagonal case) to an
 * arbitrary half-bandwidth `b`, because the interleaved geometry system is
 * half-bandwidth 5 (and Stage-4's roughness term stays within it). `solve.ts`
 * stays on `pentaFactor` — that F_n solver retires with the rebuild.
 *
 * storage. a symmetric banded matrix is its lower band, `b+1` diagonals:
 * `diag[k][i] = A[i][i−k]` for k=0..b (k=0 the main diagonal), valid i in
 * `[k, n)`. `bandStore(n, b)` allocates that shape; the same shape holds the
 * factor's L subdiagonals. scratch is caller-owned and reused across passes /
 * right-hand sides, matching `pentaFactor`'s contract.
 */

/** allocate the `b+1` lower diagonals for an n×n symmetric band (or its L). */
export function bandStore(n: number, b: number): Float64Array[] {
    const diag: Float64Array[] = [];
    for (let k = 0; k <= b; k++) diag.push(new Float64Array(n));
    return diag;
}

/**
 * factor a symmetric positive-definite banded `A` (half-bandwidth `b`, stored as
 * `a[k][i]=A[i][i−k]`) as `L D Lᵀ` with unit-lower banded L. writes L's
 * subdiagonals into `l[k][i]=L[i][i−k]` (k=1..b; `l[0]` unused) and D into `d`.
 * `l` (from `bandStore`) and `d` (len ≥ n) are caller-owned scratch.
 */
export function bandFactor(
    a: Float64Array[],
    n: number,
    b: number,
    l: Float64Array[],
    d: Float64Array,
): void {
    for (let i = 0; i < n; i++) {
        let di = a[0][i];
        const lo = Math.max(0, i - b);
        for (let m = lo; m < i; m++) {
            const lim = l[i - m][i]; // L[i][m]
            di -= lim * lim * d[m];
        }
        d[i] = di;

        // column i of L: rows j = i+1 .. min(n−1, i+b).
        const jHi = Math.min(n - 1, i + b);
        for (let j = i + 1; j <= jHi; j++) {
            let s = a[j - i][j]; // A[j][i]
            const mLo = Math.max(0, j - b);
            for (let m = mLo; m < i; m++) s -= l[j - m][j] * l[i - m][i] * d[m];
            l[j - i][j] = s / d[i];
        }
    }
}

/** solve `A x = rhs` from the `bandFactor` output; `y` is scratch (len ≥ n). */
export function bandSolve(
    l: Float64Array[],
    d: Float64Array,
    n: number,
    b: number,
    rhs: Float64Array,
    x: Float64Array,
    y: Float64Array,
): void {
    // forward solve L y = rhs
    for (let i = 0; i < n; i++) {
        let yi = rhs[i];
        const kHi = Math.min(b, i);
        for (let k = 1; k <= kHi; k++) yi -= l[k][i] * y[i - k];
        y[i] = yi;
    }
    // diagonal solve D z = y (in place)
    for (let i = 0; i < n; i++) y[i] /= d[i];
    // back solve Lᵀ x = z
    for (let i = n - 1; i >= 0; i--) {
        let xi = y[i];
        const kHi = Math.min(b, n - 1 - i);
        for (let k = 1; k <= kHi; k++) xi -= l[k][i + k] * x[i + k];
        x[i] = xi;
    }
}
