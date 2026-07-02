import { describe, expect, test } from "bun:test";
import { bandFactor, bandSolve, bandStore } from "../src/banded";
import { denseSolveSpd } from "./helpers/dense";

/** deterministic pseudo-random in [−1, 1] from two indices (no Math.random —
 *  forbidden, and it would break reproducibility). */
function rand(i: number, j: number): number {
    const s = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453;
    return 2 * (s - Math.floor(s)) - 1;
}

/** a symmetric, diagonally-dominant (hence SPD) banded matrix of half-bandwidth
 *  `b`, returned both as the lower-band storage `a[k][i]=A[i][i−k]` and as a
 *  dense row-major n×n. off-band random, diagonal = 1 + Σ|off-band in row|. */
function spdBand(n: number, b: number): { a: Float64Array[]; dense: Float64Array } {
    const dense = new Float64Array(n * n);
    // symmetric off-diagonals within the band.
    for (let i = 0; i < n; i++) {
        for (let k = 1; k <= b && i - k >= 0; k++) {
            const val = 0.5 * rand(i, i - k);
            dense[i * n + (i - k)] = val;
            dense[(i - k) * n + i] = val;
        }
    }
    // diagonal dominance for SPD.
    for (let i = 0; i < n; i++) {
        let off = 0;
        for (let j = 0; j < n; j++) if (j !== i) off += Math.abs(dense[i * n + j]);
        dense[i * n + i] = 1 + off;
    }
    const a = bandStore(n, b);
    for (let i = 0; i < n; i++) {
        a[0][i] = dense[i * n + i];
        for (let k = 1; k <= b && i - k >= 0; k++) a[k][i] = dense[i * n + (i - k)];
    }
    return { a, dense };
}

describe("banded LDLᵀ — matches a dense reference solve", () => {
    // both are exact factorizations of the same SPD system; the only gap is f64
    // accumulation, bounded ~ c·n·ε_mach·κ(A). the diagonally-dominant band has
    // κ(A)=O(1), so 1e-10 is a derived (not tuned) ceiling.
    for (const [n, b] of [
        [12, 2],
        [40, 5],
        [128, 5],
        [64, 7],
    ] as const) {
        test(`n=${n}, half-bandwidth b=${b}`, () => {
            const { a, dense } = spdBand(n, b);
            const rhs = new Float64Array(n);
            for (let i = 0; i < n; i++) rhs[i] = rand(i, 99);

            // banded solve.
            const l = bandStore(n, b);
            const d = new Float64Array(n);
            const y = new Float64Array(n);
            const xBand = new Float64Array(n);
            bandFactor(a, n, b, l, d);
            bandSolve(l, d, n, b, rhs, xBand, y);

            // dense reference (denseSolveSpd overwrites its inputs).
            const xDense = denseSolveSpd(Float64Array.from(dense), Float64Array.from(rhs), n);

            for (let i = 0; i < n; i++) expect(Math.abs(xBand[i] - xDense[i])).toBeLessThan(1e-10);

            // and independently: the banded solution satisfies A x = rhs.
            for (let i = 0; i < n; i++) {
                let row = 0;
                for (let j = 0; j < n; j++) row += dense[i * n + j] * xBand[j];
                expect(row).toBeCloseTo(rhs[i], 9);
            }
        });
    }

    test("b=2 banded agrees with the dense solve on a pentadiagonal system", () => {
        // the geometry system is b=5; this pins that bandFactor reduces to the
        // pentadiagonal case solve.ts's pentaFactor covers, same answer.
        const n = 20;
        const { a, dense } = spdBand(n, 2);
        const rhs = new Float64Array(n);
        for (let i = 0; i < n; i++) rhs[i] = 1 + 0.3 * Math.sin(i);
        const l = bandStore(n, 2);
        const d = new Float64Array(n);
        const y = new Float64Array(n);
        const x = new Float64Array(n);
        bandFactor(a, n, 2, l, d);
        bandSolve(l, d, n, 2, rhs, x, y);
        const xDense = denseSolveSpd(Float64Array.from(dense), Float64Array.from(rhs), n);
        for (let i = 0; i < n; i++) expect(Math.abs(x[i] - xDense[i])).toBeLessThan(1e-10);
    });
});
