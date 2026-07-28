// Conversion perf baseline (spec `kex/specs/kex2d-geoforce-perf.md`, stage 1).
//
// Question: where does a geo→force conversion spend its wall time, and how does that
// scale past the corpus? Measured through `refine`'s existing `probe` seam, which hands
// back exactly the call the default path makes — same warm start, same flat-family
// `polish`, same options — so the instrumented run is bit-identical to the shipping one.
// The corpus rows are checked against the frozen golden dump to prove that, so a table
// row and a conversion the editor would emit are the same computation.
//
// Reads: per-phase probe counts (split probes grow the knot set, prune probes shrink it),
// wall time per probe, and the per-probe cost against the spine's edge count E — the
// `time ≈ probes × per-probe(E)` factorization every later stage of the spec is measured
// against.
//
// Run: bun tests/perf.lab.ts

import { polish } from "../src/polish";
import { refine, type RefineResult } from "../src/refine";
import { type Scenario, scenarios } from "../src/scenarios";
import { evalGeo } from "../src/section";
import golden from "./fixtures/convert-golden.json";
import { stress } from "./helpers/stress";

interface Row {
    scenario: string;
    outcome: string;
    edges: number;
    keys: number;
    split: number;
    prune: number;
    probes: number;
    totalS: number;
    probeS: number;
    /** the serial phase's own wall time — each split reads the previous answer's residual
     *  profile, so this is the latency floor no amount of probe parallelism removes. */
    splitS: number;
    pruneS: number;
    worstMs: number;
    meanMs: number;
    /** accepted LM steps per probe — how hard the geometry is, separate from how big. */
    itersPerProbe: number;
    /** per-probe cost normalized by spine edges. */
    nsPerEdge: number;
    /** the same cost with the iteration count divided out — flat across scenarios means
     *  one LM iteration is linear in E, so `probes × iters × E` is the whole model. */
    nsPerEdgeIter: number;
}

function measure(scenario: Scenario): { row: Row; result: RefineResult } {
    const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };
    const bake = evalGeo(entry, scenario.nodes, scenario.ds);
    let split = 0;
    let prune = 0;
    let splitS = 0;
    let pruneS = 0;
    let worstMs = 0;
    let iters = 0;
    let widest = 0;
    const started = performance.now();
    const result = refine({
        bake,
        entry,
        ds: scenario.ds,
        probe: (points, knots) => {
            // the split phase only ever grows the knot set and the prune phase only ever
            // shrinks it, so the widest set seen separates the two exactly.
            const splitting = knots.length > widest;
            if (splitting) {
                widest = knots.length;
                split++;
            } else prune++;
            const at = performance.now();
            const answer = polish({
                bake,
                entry,
                points,
                ds: scenario.ds,
                family: "flat",
                maxSnapshots: 1,
            });
            const ms = performance.now() - at;
            iters += answer.iters;
            if (splitting) splitS += ms / 1000;
            else pruneS += ms / 1000;
            worstMs = Math.max(worstMs, ms);
            return answer;
        },
    });
    const totalS = (performance.now() - started) / 1000;
    const probeS = splitS + pruneS;
    const meanMs = (probeS * 1000) / result.probes;
    const itersPerProbe = iters / result.probes;
    return {
        row: {
            scenario: scenario.name,
            outcome: result.outcome,
            edges: result.final.edges,
            keys: result.final.keys,
            split,
            prune,
            probes: result.probes,
            totalS: +totalS.toFixed(2),
            probeS: +probeS.toFixed(2),
            splitS: +splitS.toFixed(2),
            pruneS: +pruneS.toFixed(2),
            worstMs: Math.round(worstMs),
            meanMs: Math.round(meanMs),
            itersPerProbe: +itersPerProbe.toFixed(1),
            nsPerEdge: Math.round((meanMs * 1e6) / result.final.edges),
            nsPerEdgeIter: Math.round((meanMs * 1e6) / (result.final.edges * itersPerProbe)),
        },
        result,
    };
}

// one discarded conversion first: the JIT is cold on the very first probe, and a warm-up
// that lands inside a measured row reads as that scenario being intrinsically slower.
measure(scenarios[0]);

const corpus = scenarios.map((scenario) => {
    const { row, result } = measure(scenario);
    // the instrumented run must BE the shipping conversion, not a lookalike of it.
    const want = golden[scenario.name as keyof typeof golden];
    const same =
        result.knots.join() === want.knots.join() &&
        result.final.points.length === want.points.length &&
        result.final.points.every((p, k) => p.s === want.points[k].s && p.g === want.points[k].g);
    if (!same) throw new Error(`${scenario.name}: the probe seam did not reproduce the golden`);
    return row;
});
const beyond = stress.map((scenario) => measure(scenario).row);
console.table([...corpus, ...beyond]);

const totals = (rows: Row[]) => ({
    keys: rows.reduce((a, r) => a + r.keys, 0),
    probes: rows.reduce((a, r) => a + r.probes, 0),
    totalS: +rows.reduce((a, r) => a + r.totalS, 0).toFixed(2),
    splitS: +rows.reduce((a, r) => a + r.splitS, 0).toFixed(2),
    pruneS: +rows.reduce((a, r) => a + r.pruneS, 0).toFixed(2),
});
console.table({ corpus: totals(corpus), stress: totals(beyond) });
