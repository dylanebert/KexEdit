const G = 9.80665;

export type SampleState = readonly [x: number, y: number, theta: number, v: number];

/** f64 forward integrator for math-validation tests. Mirrors `src/forward.ts`. */
export function forward64(
    x0: number,
    y0: number,
    theta0: number,
    v0: number,
    N: number,
    ds: number,
    fN: (sigma: number) => number,
    g: number = G,
): SampleState[] {
    const out: SampleState[] = new Array(N);
    out[0] = [x0, y0, theta0, v0];
    for (let i = 0; i < N - 1; i++) {
        const [xi, yi, ti, vi] = out[i];
        const fNi = fN(i * ds);
        const dTheta = ((fNi - Math.cos(ti)) * g * ds) / (vi * vi);
        const tNext = ti + dTheta;
        const midT = 0.5 * (ti + tNext);
        const xNext = xi + ds * Math.cos(midT);
        const yNext = yi + ds * Math.sin(midT);
        const vSq = vi * vi - 2 * g * (yNext - yi);
        const vNext = Math.sqrt(Math.max(vSq, 0));
        out[i + 1] = [xNext, yNext, tNext, vNext];
    }
    return out;
}
