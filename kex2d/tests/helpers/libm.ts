/** shared cross-machine-libm-diffing machinery (`kex2d-golden-reproducibility` 1a/3a') —
 *  factored out so `libm.lab.ts` (the per-call instrumented table + amplification sweeps) and
 *  `libm-spread.lab.ts` (the aggregate perturbation probe) each register only their own tests.
 *  Importing one `.lab.ts` from another would register and run its tests too, since bun collects
 *  `test()` calls at module load. */

/** the nine `Math` functions ECMAScript leaves implementation-defined: `+ - * / sqrt` are
 *  pinned to exact IEEE-754, these are not. */
export const WRAPPED = [
    "sin",
    "cos",
    "tan",
    "atan2",
    "pow",
    "exp",
    "log",
    "hypot",
    "cbrt",
] as const;
export type WrappedFn = (typeof WRAPPED)[number];

/** `x` bumped by a SIGNED ulp count (0 is a no-op, negative moves toward −Infinity).
 *  Bit-pattern-monotonic only for positive finite doubles — the ordering assumption holds with
 *  no sign-aware branch for the values these labs perturb (chord lengths, sines of
 *  physically-bounded angles). */
export function bumpBy(x: number, ulps: number): number {
    if (ulps === 0) return x;
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, x);
    view.setBigUint64(0, view.getBigUint64(0) + BigInt(ulps));
    return view.getFloat64(0);
}
