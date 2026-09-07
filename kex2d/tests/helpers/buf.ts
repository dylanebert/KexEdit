/** SoA scratch buffers for the spline / invert tests: sample arrays sized to
 *  `n` plus per-edge `fN` and `ds` sized to `n − 1`. shared by `spline.test.ts`
 *  (sampleChain writes posX/posY/ds) and `bake.test.ts` (invert writes fN, the
 *  round-trip replays through ds). */
export type Buf = {
    posX: Float32Array;
    posY: Float32Array;
    theta: Float32Array;
    v: Float32Array;
    fN: Float32Array;
    ds: Float32Array;
};

export function makeBuf(n: number): Buf {
    return {
        posX: new Float32Array(n),
        posY: new Float32Array(n),
        theta: new Float32Array(n),
        v: new Float32Array(n),
        fN: new Float32Array(n - 1),
        ds: new Float32Array(n - 1),
    };
}
