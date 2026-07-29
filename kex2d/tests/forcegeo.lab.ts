// Force→geo fit corpus sweep + perf reading (spec `kex/specs/kex2d-forcegeo.md`, stage 2).
//
// Question: does `geofit` hold its dual budget over every golden-derived force section AND
// the authoring-scale stress trio, and how fast — the number stage 3 routes on (sync vs the
// modal/async façade). Corpus targets mirror `geofit.test.ts`'s oracle exactly (golden `{s,g}`
// points → `forceProfile` → `evalForce`), never re-derived here. The stress trio has no frozen
// golden (`helpers/stress.ts` — deliberately not corpus members), so its own force-section
// target is derived the analogous way: run the SAME geo→force conversion (`refine`/`narrow`)
// that originally produced the corpus goldens, live, over each stress scenario's own geo bake,
// then feed its `{s,g}` points through the identical `forceProfile` → `evalForce` path. Only
// the `geofit` call itself is timed — the conversion that builds the target is setup, not the
// measured fit.
//
// Run: bun tests/forcegeo.lab.ts

import { FORCE_BUDGET, GEO_BUDGET, type GeofitBake, geofit } from "../src/geofit";
import { forceProfile } from "../src/profile";
import { narrow, refine } from "../src/refine";
import { type Scenario, scenarios } from "../src/scenarios";
import { evalForce, evalGeo } from "../src/section";
import golden from "./fixtures/convert-golden.json";
import { stress } from "./helpers/stress";

interface Row {
    scenario: string;
    edges: number;
    nodes: number;
    deviation: number;
    forceError: number;
    outcome: string;
    ms: number;
}

function bakeOf(
    x: ArrayLike<number>,
    y: ArrayLike<number>,
    fN: ArrayLike<number>,
    ds: ArrayLike<number>,
): GeofitBake {
    return { x, y, fN, ds, edges: fN.length };
}

/** the corpus target: the golden-derived force section (`geofit.test.ts`'s oracle), unchanged. */
function corpusTarget(scenario: Scenario): { bake: GeofitBake; v0: number } {
    const g = golden[scenario.name as keyof typeof golden];
    const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };
    const profile = forceProfile(g.points, g.length, g.ds);
    const bake = evalForce(entry, profile, g.ds);
    return { bake: bakeOf(bake.posX, bake.posY, bake.fN, bake.ds), v0: entry.v };
}

/** the stress trio's force-section target: no frozen golden exists (stress scenarios are
 *  deliberately not corpus members), so the SAME geo→force conversion that minted the corpus
 *  goldens runs live over the stress scenario's own geo bake, then the answer feeds the
 *  identical `forceProfile` → `evalForce` path the corpus target above uses. */
function stressTarget(scenario: Scenario): { bake: GeofitBake; v0: number } {
    const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };
    const geoBake = evalGeo(entry, scenario.nodes, scenario.ds);
    const converted = narrow(refine({ bake: geoBake, entry, ds: scenario.ds, playback: false }));
    const profile = forceProfile(converted.points, converted.length, converted.ds);
    const bake = evalForce(entry, profile, converted.ds);
    return { bake: bakeOf(bake.posX, bake.posY, bake.fN, bake.ds), v0: entry.v };
}

function measure(name: string, target: { bake: GeofitBake; v0: number }): Row {
    const at = performance.now();
    const result = geofit(target.bake, target.v0);
    const ms = performance.now() - at;
    return {
        scenario: name,
        edges: target.bake.edges,
        nodes: result.nodes.length,
        deviation: +result.deviation.toFixed(4),
        forceError: +result.forceError.toFixed(4),
        outcome: result.outcome,
        ms: +ms.toFixed(2),
    };
}

// one discarded fit first: the JIT is cold on the very first call, and a warm-up that lands
// inside a measured row reads as that scenario being intrinsically slower.
measure("warmup", corpusTarget(scenarios[0]));

const corpus = scenarios.map((scenario) => measure(scenario.name, corpusTarget(scenario)));
const beyond = stress.map((scenario) => measure(scenario.name, stressTarget(scenario)));

// deterministic content assert, per the repo's lab idiom (perf.lab.ts's golden-reproduction
// check): every corpus row must hold both budgets at "floor" — the corpus oracle
// (`geofit.test.ts`) already pins this per-scenario; a lab regression here means the sweep
// stopped exercising what it claims to.
for (const row of corpus) {
    if (row.outcome !== "floor" || row.deviation > GEO_BUDGET || row.forceError > FORCE_BUDGET) {
        throw new Error(
            `${row.scenario}: corpus row failed to hold budget (${JSON.stringify(row)})`,
        );
    }
}

console.table([...corpus, ...beyond]);

const totals = (rows: Row[]) => ({
    nodes: rows.reduce((a, r) => a + r.nodes, 0),
    worstDeviation: +Math.max(...rows.map((r) => r.deviation)).toFixed(4),
    worstForceError: +Math.max(...rows.map((r) => r.forceError)).toFixed(4),
    totalMs: +rows.reduce((a, r) => a + r.ms, 0).toFixed(2),
    worstMs: +Math.max(...rows.map((r) => r.ms)).toFixed(2),
});
console.table({ corpus: totals(corpus), stress: totals(beyond) });

// the stage-3 routing checkpoint: the stress trio's worst SINGLE-target wall time under bun.
// Timing is reported, never asserted against a threshold (timing asserts flake) — the ~1 s bar
// from the spec is a human read on the number below, not a gate here.
const worstStressMs = Math.max(...beyond.map((r) => r.ms));
console.log(`stress-trio worst single-target wall time: ${worstStressMs.toFixed(2)} ms`);
