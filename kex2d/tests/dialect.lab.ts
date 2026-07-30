// G2 dialect spike — measurement only, not adoption (spec `kex/specs/kex2d-roundtrip.md`, stage
// 3). The locked decision: geo→force's flat-tangent default-Cubic keys are C1 at every join but
// curvature-discontinuous, and that's the current dialect's ringing floor. `Easing.Quintic`
// (influence 7/15, exact quintic smoothstep) has zero second derivative at a flat join, so a
// flat-key dialect emitting Quintic segments is G2 by construction. This lab runs the SAME
// round-trip yardstick `roundtrip.lab.ts` pins (`tests/helpers/roundtrip-metrics.ts`) under both
// dialects — over the corpus, and over the steep-long-gradient probes the spec's Goal names as
// the open envelope question — and prints the comparison. It changes NOTHING: the seam is
// `polish.ts`'s `easing` option (unset = the shipping Cubic path, byte-identical) and
// `refine.ts`'s forwarding `easing` option; no default-path code runs any differently than
// before this file existed (`roundtrip.lab.ts`'s own baseline re-run pins that). Adoption —
// re-approving the corpus asserts and re-freezing both goldens — is a human check-in, not this
// lab's call.
//
// Quintic's points are read straight off `RefineResult.final.points` (which carries the `ease`
// tag `polish` stamped), never through `narrow` — `narrow`'s `{s,g}`-only `ConvertResult` is the
// frozen production contract this spike does not touch.
//
// Run: bun tests/dialect.lab.ts

import { V_WARN } from "../src/bake";
import { geofit } from "../src/geofit";
import { Easing, forceProfile } from "../src/profile";
import { refine } from "../src/refine";
import { type Scenario, scenarios } from "../src/scenarios";
import { evalForce, evalGeo } from "../src/section";
import { gradientProbes, minSpeed } from "./helpers/gradient-probes";
import { bakeOf, flipDensity, maxDivergence } from "./helpers/roundtrip-metrics";

interface DialectRow {
    scenario: string;
    origNodes: number;
    roundNodes: number;
    inflation: number;
    flipRatio: number;
    maxDivergence: number;
    outcome: string;
}

/** one dialect's full round-trip over one scenario, at the pure-kernel seam `roundtrip.lab.ts`
 *  calls — identical pipeline, `easing` the only variable. */
function measure(scenario: Scenario, easing?: Easing): DialectRow {
    const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };

    const geoBake = evalGeo(entry, scenario.nodes, scenario.ds);
    const result = refine({ bake: geoBake, entry, ds: scenario.ds, playback: false, easing });
    // read straight off `final.points` (carries the `ease` tag), not `narrow` (strips it).
    const points = result.final.points;
    const profile = forceProfile(points, result.final.length, result.final.ds);
    const forceBake = evalForce(entry, profile, result.final.ds);

    const fit = geofit(bakeOf(forceBake), entry.v);
    const roundBake = evalGeo(entry, fit.nodes, scenario.ds);

    const origFlip = flipDensity(geoBake.fN);
    const roundFlip = flipDensity(roundBake.fN);

    return {
        scenario: scenario.name,
        origNodes: scenario.nodes.length,
        roundNodes: fit.nodes.length,
        inflation: +(fit.nodes.length / scenario.nodes.length).toFixed(3),
        flipRatio: origFlip > 0 ? +(roundFlip / origFlip).toFixed(3) : Number.NaN,
        maxDivergence: +maxDivergence(geoBake, roundBake).toFixed(4),
        outcome: result.outcome,
    };
}

interface CompareRow {
    scenario: string;
    origNodes: number;
    c1Nodes: number;
    quinticNodes: number;
    c1Inflation: number;
    quinticInflation: number;
    c1FlipRatio: number;
    quinticFlipRatio: number;
    dFlipRatio: number;
    c1MaxDiv: number;
    quinticMaxDiv: number;
    dMaxDiv: number;
    c1Outcome: string;
    quinticOutcome: string;
}

function compare(scenario: Scenario): CompareRow {
    const c1 = measure(scenario);
    const q = measure(scenario, Easing.Quintic);
    return {
        scenario: scenario.name,
        origNodes: c1.origNodes,
        c1Nodes: c1.roundNodes,
        quinticNodes: q.roundNodes,
        c1Inflation: c1.inflation,
        quinticInflation: q.inflation,
        c1FlipRatio: c1.flipRatio,
        quinticFlipRatio: q.flipRatio,
        dFlipRatio: +(q.flipRatio - c1.flipRatio).toFixed(3),
        c1MaxDiv: c1.maxDivergence,
        quinticMaxDiv: q.maxDivergence,
        dMaxDiv: +(q.maxDivergence - c1.maxDivergence).toFixed(4),
        c1Outcome: c1.outcome,
        quinticOutcome: q.outcome,
    };
}

console.log("=== corpus: C1 vs Quintic round-trip yardstick ===");
const corpusRows = scenarios.map(compare);
console.table(corpusRows);

const totalOrig = corpusRows.reduce((a, r) => a + r.origNodes, 0);
const totalC1 = corpusRows.reduce((a, r) => a + r.c1Nodes, 0);
const totalQ = corpusRows.reduce((a, r) => a + r.quinticNodes, 0);
console.log(
    `overall node inflation — C1: ${(totalC1 / totalOrig).toFixed(3)}x (${totalOrig} -> ${totalC1}), ` +
        `Quintic: ${(totalQ / totalOrig).toFixed(3)}x (${totalOrig} -> ${totalQ})`,
);

const c1Flips = corpusRows.map((r) => r.c1FlipRatio).filter(Number.isFinite);
const qFlips = corpusRows.map((r) => r.quinticFlipRatio).filter(Number.isFinite);
console.log(
    `flip-density ratio range — C1: ${Math.min(...c1Flips).toFixed(2)}x-${Math.max(...c1Flips).toFixed(2)}x, ` +
        `Quintic: ${Math.min(...qFlips).toFixed(2)}x-${Math.max(...qFlips).toFixed(2)}x`,
);

// ---- steep-long-gradient envelope probes ----
// each probe's v0 is picked so the ORIGINAL bake clears V_WARN with a real margin — a fit or a
// round-tripped bake straying can only get closer to infeasible, never further, so the margin
// here is what "sane" means below (the same convention `src/scenarios.ts` states and
// `tests/scenarios.test.ts` pins for the corpus).
console.log("\n=== steep-long-gradient envelope probes ===");
for (const probe of gradientProbes) {
    const margin = minSpeed(probe);
    if (!(margin > 2 * V_WARN))
        throw new Error(
            `${probe.name}: min recovered speed ${margin.toFixed(2)} m/s doesn't clear ` +
                `2x V_WARN (${2 * V_WARN}) — probe construction is not a real feasibility margin`,
        );
}
const probeRows = gradientProbes.map(compare);
console.table(probeRows);
console.log(
    "reading: a WIDER envelope for a dialect on these probes shows as a LOWER inflation/flip " +
        "ratio (fewer nodes / less ringing needed to close the same sustained-gradient run) or a " +
        "held 'floor' outcome where the other dialect slips to 'budget' — never as a hard pass/" +
        "fail here, since neither dialect's ceiling on this shape is established by the corpus.",
);
