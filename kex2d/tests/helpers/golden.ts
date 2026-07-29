import type { RefineOutcome } from "../../src/refine";
import { scenarios } from "../../src/scenarios";
import { evalGeo } from "../../src/section";
import golden from "../fixtures/convert-golden.json";

/** a corpus scenario's bake input by name — the same call `BakeSystem` makes. */
export function bakeOf(name: string) {
    const scenario = scenarios.find((candidate) => candidate.name === name);
    if (!scenario) throw new Error(`missing scenario ${name}`);
    const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };
    return { scenario, entry, bake: evalGeo(entry, scenario.nodes, scenario.ds) };
}

/** the frozen conversion answer for a scenario, in `ConvertResult` shape. */
export const GOLDEN = (name: string) => {
    const want = golden[name as keyof typeof golden];
    return { ...want, outcome: want.outcome as RefineOutcome };
};
