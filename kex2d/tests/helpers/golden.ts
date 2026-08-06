import type { GeofitOutcome } from "../../src/geofit";
import type { RefineOutcome } from "../../src/refine";
import { scenarios } from "../../src/scenarios";
import { evalGeo } from "../../src/section";
import convertGolden from "../fixtures/convert-golden.json";
import forcegeoGolden from "../fixtures/forcegeo-golden.json";
import type { FieldRegistry } from "./compare";

/** a corpus scenario's bake input by name — the same call `BakeSystem` makes. */
export function bakeOf(name: string) {
    const scenario = scenarios.find((candidate) => candidate.name === name);
    if (!scenario) throw new Error(`missing scenario ${name}`);
    const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };
    return { scenario, entry, bake: evalGeo(entry, scenario.nodes, scenario.ds) };
}

/** the frozen conversion answer for a scenario, in `ConvertResult` shape. */
export const GOLDEN = (name: string) => {
    const want = convertGolden[name as keyof typeof convertGolden];
    return { ...want, outcome: want.outcome as RefineOutcome };
};

/** `convert-golden.json`'s field → bucket → bound contract (`kex2d-golden-reproducibility.md`,
 *  "The contract"). `knots`/`outcome`/`probes`/`keys`/`edges` are structural — a different
 *  answer, not a drifted one. `length`/`ds`/`points[].s` are exact but not structural: they are
 *  inherited from the f32 barrier (bit-identical on this machine pair) rather than authored, so
 *  they carry no bound of their own. `floor`/`deviation`/`points[].g` are the three fields whose
 *  producer crosses an implementation-defined `Math` call with nothing quantizing it afterward,
 *  bounded at the max measured structure-conditional cross-machine spread, rounded to the next
 *  decade. */
export const CONVERT_REGISTRY: FieldRegistry = {
    knots: { kind: "structural" },
    outcome: { kind: "structural" },
    probes: { kind: "structural" },
    keys: { kind: "structural" },
    edges: { kind: "structural" },
    length: { kind: "exact" },
    ds: { kind: "exact" },
    floor: { kind: "bounded", rel: 1e-14 },
    deviation: { kind: "bounded", rel: 1e-8 },
    points: { array: { s: { kind: "exact" }, g: { kind: "bounded", rel: 1e-8 } } },
};

/** the frozen force→geo fit answer for a scenario, in `forcegeo-golden.json`'s own shape (not
 *  `GeofitResult` — the fixture omits `nodes[].length` chrome the fit computes internally). */
export const FORCEGEO_GOLDEN = (name: string) => {
    const want = forcegeoGolden[name as keyof typeof forcegeoGolden];
    return { ...want, outcome: want.outcome as GeofitOutcome };
};

/** `forcegeo-golden.json`'s field → bucket → bound contract. `nodes[].x`/`.y`/`.theta` and
 *  `forceError` are exact — `Float32Array`-stored (or built from exact IEEE reductions over
 *  f32-sourced values) behind the f32 quantization barrier. `outcome` is structural. `deviation`
 *  is the one field with no store after it: a single `hypot` over the bit-identical f32 table, so
 *  the bound is tight-by-construction at 1 ulp of its own magnitude rather than a measured
 *  relative spread — an ABSOLUTE bound, unlike every `bounded` row above. */
export const FORCEGEO_REGISTRY: FieldRegistry = {
    outcome: { kind: "structural" },
    forceError: { kind: "exact" },
    deviation: { kind: "ulp" },
    nodes: {
        array: { x: { kind: "exact" }, y: { kind: "exact" }, theta: { kind: "exact" } },
    },
};
