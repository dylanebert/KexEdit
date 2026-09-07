/** dense SPD Cholesky solve — the reference the banded factorization is
 *  cross-validated against. extracted from the retired F_n-primal `solve.ts`
 *  (kexedit c4be93c) when the geometry-primal atoms were resurrected; test-only. */
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
