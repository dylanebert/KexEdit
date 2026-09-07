/** The round-trip yardstick's metric primitives (spec `kex/specs/kex2d-roundtrip.md`, stage 2),
 *  factored out so the follow-on provenance round-trip unit can read the SAME metric definitions
 *  `roundtrip.lab.ts` measures against. Pure, framework-free; no behavior here changed when it
 *  moved out of `roundtrip.lab.ts` (a straight extraction, re-verified by that lab's own
 *  reproduction assert). See `roundtrip.lab.ts`'s header for the metrics' definitions and why the
 *  FINAL round-tripped geo bake is what they're measured over. */

import type { GeofitBake } from "../../src/geofit";
import type { SectionResult } from "../../src/section";

/** sign flips in the discrete second difference of a per-edge force curve, per edge — a
 *  curvature-discontinuity rate, so scenarios of different length are comparable. */
export function flipDensity(fN: ArrayLike<number>): number {
    const n = fN.length;
    if (n < 3) return 0;
    let flips = 0;
    let prevSign = 0;
    for (let i = 1; i < n - 1; i++) {
        const d2 = fN[i + 1] - 2 * fN[i] + fN[i - 1];
        const sign = Math.sign(d2);
        if (sign !== 0) {
            if (prevSign !== 0 && sign !== prevSign) flips++;
            prevSign = sign;
        }
    }
    return flips / n;
}

/** cumulative arclength of each edge's LEFT sample (`cum[i]` = station of `fN[i]`) —
 *  `geofit.ts`'s own per-edge attribution. */
export function stations(ds: ArrayLike<number>): Float64Array {
    const cum = new Float64Array(ds.length);
    let acc = 0;
    for (let i = 0; i < ds.length; i++) {
        cum[i] = acc;
        acc += ds[i];
    }
    return cum;
}

/** `fN` at an arbitrary station, piecewise-constant over the left-sample attribution above
 *  (the edge whose station is nearest without exceeding `s`; clamps at the ends). */
export function sampleAt(cum: Float64Array, fN: ArrayLike<number>, s: number): number {
    if (s <= cum[0]) return fN[0];
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cum[mid] <= s) lo = mid;
        else hi = mid - 1;
    }
    return fN[lo];
}

/** max |Δf_N| over the original curve's own stations, clipped to the span both curves
 *  cover (a fit's realized length can fall short of the original by sub-quantum slack).
 *  Deliberately one-sided (the original's stations, never the round-tripped curve's own, and
 *  never symmetrized with `tests/helpers/stations.ts`'s drift metric): its job is reproducing the
 *  2026-07-29 hand check-in's numbers exactly, not scoring acceptance — `kex2d-provenance`
 *  considered and rejected a budget-based restore acceptance built on a metric like this one
 *  (Goodhart caution, `specs/kex2d-provenance.md`), so there is still no production consumer that
 *  would need it symmetric or two-sided. */
export function maxDivergence(orig: SectionResult, round: SectionResult): number {
    const origCum = stations(orig.ds);
    const roundCum = stations(round.ds);
    const span = Math.min(origCum[origCum.length - 1], roundCum[roundCum.length - 1]);
    let worst = 0;
    for (let i = 0; i < origCum.length; i++) {
        if (origCum[i] > span) break;
        const d = Math.abs(orig.fN[i] - sampleAt(roundCum, round.fN, origCum[i]));
        if (d > worst) worst = d;
    }
    return worst;
}

export function bakeOf(bake: SectionResult): GeofitBake {
    return { x: bake.posX, y: bake.posY, fN: bake.fN, ds: bake.ds, edges: bake.edges };
}
