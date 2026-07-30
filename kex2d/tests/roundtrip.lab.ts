// Round-trip yardstick (spec `kex/specs/kex2d-roundtrip.md`, stage 2).
//
// Question: what does geo→force→geo do to a corpus scenario, in the exact numbers the
// 2026-07-29 check-in eyeballed by hand — node inflation, force-curve ringing, and
// force-curve divergence? This is the metric the rest of the spec's stages are judged
// against (a G2 dialect spike, budget knobs), so its baseline rows must reproduce the
// recorded readings before anything downstream trusts a delta against it.
//
// Pipeline mirrors the shipping commands exactly, called at their pure-kernel seam (no
// ECS/history — `geoforce.ts`/`forcegeo.ts` are the same calls behind a document lock):
//   1. geo→force: `evalGeo` the corpus scenario, `refine`+`narrow` it (`geoforce.convertGeo`'s
//      own call), `forceProfile`+`evalForce` the landed points — the force section's OWN
//      geometry-recovered curve, exactly what the timeline would show post-convert.
//   2. force→geo: `geofit` that bake back to a sparse Auto node chain (`forcegeo.convertForce`'s
//      own call).
//
// Both curves compared below are the GEOMETRY-RECOVERED force (the one-display-path law,
// `section.ts`) — the original scenario's own bake, and the bake of the round-tripped geo
// chain (`fit.nodes`, fed back through `evalGeo`, exactly what the timeline would show once
// the fit landed and the section re-baked). Comparing at the FINAL geo bake, not the
// intermediate force-section curve, is deliberate: the locked decision's mechanism is that
// the fit's picked nodes sit at the flat-tangent joins' curvature kinks, and it's the
// SECOND conversion's own Hermite re-fit through those picks that rings — measuring the
// intermediate curve (a cubic-bezier F_n(s), no geometry re-fit yet) showed no such
// pattern (flip-ratio spread 0.19x-1.67x, not the recorded 2-3.5x) and was replaced.
//
// Metrics, each defined over that pipeline:
//   - **node inflation** = round-tripped node count / original scenario node count.
//   - **force flip-density** = sign flips in the discrete second difference of the per-edge
//     F_n curve, divided by edge count (a rate, comparable across scenarios of different
//     length) — the curvature-discontinuity signature the locked decision names (G2 joins
//     have none). Reported as the ROUND-TRIPPED curve's density over the ORIGINAL's.
//   - **max force divergence** = max |ΔF_n| (g) between the original and round-tripped
//     curves, resampled onto the original's own per-edge stations (piecewise-constant,
//     left-sample attribution — `geofit.ts`'s own convention) over their common arclength
//     span.
//
// Run: bun tests/roundtrip.lab.ts

import { type GeofitBake, geofit } from "../src/geofit";
import { forceProfile } from "../src/profile";
import { narrow, refine } from "../src/refine";
import { type Scenario, scenarios } from "../src/scenarios";
import { evalForce, evalGeo, type SectionResult } from "../src/section";

interface Row {
    scenario: string;
    origNodes: number;
    roundNodes: number;
    inflation: number;
    origFlipDensity: number;
    roundFlipDensity: number;
    flipRatio: number;
    maxDivergence: number;
    fitOutcome: string;
}

/** sign flips in the discrete second difference of a per-edge force curve, per edge — a
 *  curvature-discontinuity rate, so scenarios of different length are comparable. */
function flipDensity(fN: ArrayLike<number>): number {
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
function stations(ds: ArrayLike<number>): Float64Array {
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
function sampleAt(cum: Float64Array, fN: ArrayLike<number>, s: number): number {
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
 *  cover (a fit's realized length can fall short of the original by sub-quantum slack). */
function maxDivergence(orig: SectionResult, round: SectionResult): number {
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

function bakeOf(bake: SectionResult): GeofitBake {
    return { x: bake.posX, y: bake.posY, fN: bake.fN, ds: bake.ds, edges: bake.edges };
}

function measure(scenario: Scenario): Row {
    const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };

    // geo→force: the exact call `geoforce.convertGeo` makes.
    const geoBake = evalGeo(entry, scenario.nodes, scenario.ds);
    const converted = narrow(refine({ bake: geoBake, entry, ds: scenario.ds, playback: false }));
    const profile = forceProfile(converted.points, converted.length, converted.ds);
    const forceBake = evalForce(entry, profile, converted.ds);

    // force→geo: the exact call `forcegeo.convertForce` makes.
    const fit = geofit(bakeOf(forceBake), entry.v);

    // the round-tripped geo section's own bake — what the timeline shows once the fit
    // lands (fit.nodes are literal picks of forceBake's samples, already in the entry
    // frame since entry is the identity here, so they feed evalGeo directly as Nodes).
    const roundBake = evalGeo(entry, fit.nodes, scenario.ds);

    const origFlip = flipDensity(geoBake.fN);
    const roundFlip = flipDensity(roundBake.fN);

    return {
        scenario: scenario.name,
        origNodes: scenario.nodes.length,
        roundNodes: fit.nodes.length,
        inflation: +(fit.nodes.length / scenario.nodes.length).toFixed(3),
        origFlipDensity: +origFlip.toFixed(4),
        roundFlipDensity: +roundFlip.toFixed(4),
        flipRatio: origFlip > 0 ? +(roundFlip / origFlip).toFixed(3) : Number.NaN,
        maxDivergence: +maxDivergence(geoBake, roundBake).toFixed(4),
        fitOutcome: fit.outcome,
    };
}

const rows = scenarios.map(measure);
console.table(rows);

const totalOrig = rows.reduce((a, r) => a + r.origNodes, 0);
const totalRound = rows.reduce((a, r) => a + r.roundNodes, 0);
console.log(
    `overall node inflation: ${(totalRound / totalOrig).toFixed(3)}x (${totalOrig} -> ${totalRound})`,
);

// "concentrated entirely in the two explicit-tangent scenarios" is a NET claim: individual
// non-explicit rows drift either way (a fit can pick fewer nodes than the original chain
// too), but that drift cancels — the whole corpus's net gain equals loop-explicit's +
// valley-explicit's own net gain, exactly.
const delta = (r: Row) => r.roundNodes - r.origNodes;
const drivers = rows.filter(
    (r) => r.scenario === "loop-explicit" || r.scenario === "valley-explicit",
);
const others = rows.filter((r) => r !== drivers[0] && r !== drivers[1]);
const driverNet = drivers.reduce((a, r) => a + delta(r), 0);
const othersNet = others.reduce((a, r) => a + delta(r), 0);
console.log(
    `net node delta: loop-explicit + valley-explicit = ${driverNet >= 0 ? "+" : ""}${driverNet}, every other scenario combined = ${othersNet >= 0 ? "+" : ""}${othersNet} (total ${totalRound - totalOrig})`,
);

const flipRatios = rows.map((r) => r.flipRatio).filter((r) => Number.isFinite(r));
console.log(
    `force flip-density ratio range (whole corpus): ${Math.min(...flipRatios).toFixed(2)}x - ${Math.max(...flipRatios).toFixed(2)}x`,
);
console.log(
    `force flip-density ratio (the two node-inflation drivers): ${drivers.map((r) => `${r.scenario} ${r.flipRatio}x`).join(", ")}`,
);

// deterministic content assert, per the repo's lab idiom (perf.lab.ts's golden-reproduction
// check): this lab's whole job is reproducing the 2026-07-29 check-in's hand-measured
// numbers, so a drift here means the metric stopped tracking what was measured, not that
// the corpus changed under it.
const overallInflation = totalRound / totalOrig;
// the check-in recorded "1.22x" — a number rounded to 2 decimals, so ±0.005 is that
// rounding's own tolerance, not a tuned slop.
if (Math.abs(overallInflation - 1.22) > 0.005) {
    throw new Error(
        `overall node inflation drifted: ${overallInflation.toFixed(3)}x, expected ~1.22x`,
    );
}
if (othersNet !== 0) {
    throw new Error(
        `node inflation is no longer concentrated in loop-explicit + valley-explicit: every other scenario net ${othersNet}`,
    );
}
for (const r of drivers) {
    if (r.flipRatio < 2 || r.flipRatio > 3.5) {
        throw new Error(
            `${r.scenario}: flip-density ratio ${r.flipRatio}x outside the recorded 2x-3.5x band`,
        );
    }
}
