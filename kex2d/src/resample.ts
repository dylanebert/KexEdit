/** arclength resampling for the solver grid — the wire stage's
 *  resample-and-continue atom (spec `kex/specs/kex2d-unified-solver.md`,
 *  Stage 4). pure and framework-free like `spline.ts`.
 *
 *  `arcResample` interpolates with Catmull-Rom through the source points, NOT
 *  linearly: linear interpolation inscribes chords, and a resampled point set
 *  whose interior samples sit on chords reads as a curvature (hence force)
 *  blip to the Menger-κ force map at every re-grid — the index-resample
 *  "injects kinks" finding's cousin. the resample tests gate max |ΔF| across
 *  a re-grid. */

/** total chord length of the polyline `(x[i], y[i])`, i < n. */
export function polylineLength(x: ArrayLike<number>, y: ArrayLike<number>, n: number): number {
    let len = 0;
    for (let i = 0; i < n - 1; i++) len += Math.hypot(x[i + 1] - x[i], y[i + 1] - y[i]);
    return len;
}

/** resample the source polyline onto `m` samples uniform in (chord) arclength,
 *  Catmull-Rom through the source points; endpoints exact. */
export function arcResample(
    x: ArrayLike<number>,
    y: ArrayLike<number>,
    n: number,
    outX: Float64Array,
    outY: Float64Array,
    m: number,
): void {
    if (n < 2 || m < 2) {
        for (let k = 0; k < m; k++) {
            outX[k] = x[Math.min(k, n - 1)];
            outY[k] = y[Math.min(k, n - 1)];
        }
        return;
    }
    // cumulative chord arclength of the source.
    const s = new Float64Array(n);
    for (let i = 0; i < n - 1; i++) s[i + 1] = s[i] + Math.hypot(x[i + 1] - x[i], y[i + 1] - y[i]);
    const total = s[n - 1];

    // node tangent, per index: central difference inside, second-order
    // one-sided at the ends (a first-order chord tangent tilts by O(h/2R)
    // and reads as a ~10% Menger-κ error near the endpoints).
    const tangent = (i: number, arr: ArrayLike<number>): number => {
        if (i === 0) return n > 2 ? (-3 * arr[0] + 4 * arr[1] - arr[2]) / 2 : arr[1] - arr[0];
        if (i === n - 1)
            return n > 2
                ? (3 * arr[n - 1] - 4 * arr[n - 2] + arr[n - 3]) / 2
                : arr[n - 1] - arr[n - 2];
        return (arr[i + 1] - arr[i - 1]) / 2;
    };

    let j = 0;
    for (let k = 0; k < m; k++) {
        const target = (total * k) / (m - 1);
        while (j < n - 2 && s[j + 1] < target) j++;
        const seg = s[j + 1] - s[j];
        const u = seg > 0 ? (target - s[j]) / seg : 0;

        // Catmull-Rom on P_{j−1}..P_{j+2}.
        const j2 = j + 1;
        const txA = tangent(j, x);
        const tyA = tangent(j, y);
        const txB = tangent(j2, x);
        const tyB = tangent(j2, y);
        const u2 = u * u;
        const u3 = u2 * u;
        const h00 = 2 * u3 - 3 * u2 + 1;
        const h10 = u3 - 2 * u2 + u;
        const h01 = -2 * u3 + 3 * u2;
        const h11 = u3 - u2;
        outX[k] = h00 * x[j] + h10 * txA + h01 * x[j2] + h11 * txB;
        outY[k] = h00 * y[j] + h10 * tyA + h01 * y[j2] + h11 * tyB;
    }
    // endpoints exact regardless of float accumulation.
    outX[0] = x[0];
    outY[0] = y[0];
    outX[m - 1] = x[n - 1];
    outY[m - 1] = y[n - 1];
}

/** linear resample of a per-sample scalar field from `n` onto `m` samples in
 *  the fraction domain — the λ-multiplier carry across a re-grid. */
export function fracResample(src: Float64Array, n: number, out: Float64Array, m: number): void {
    if (n < 2 || m < 2) {
        for (let k = 0; k < m; k++) out[k] = src[Math.min(k, n - 1)];
        return;
    }
    for (let k = 0; k < m; k++) {
        const p = (k / (m - 1)) * (n - 1);
        const i = Math.min(Math.floor(p), n - 2);
        const u = p - i;
        out[k] = src[i] * (1 - u) + src[i + 1] * u;
    }
}
