import { expect, test } from "bun:test";
import { chordDeficit, spine } from "../src/polish";
import { refine } from "../src/refine";
import { scenarios } from "../src/scenarios";
import { evalGeo } from "../src/section";

/** Decision-reference sweep for the fixed flat family.
 *
 * The production 0.50 m point reproduces the scope probe's 80 keys exactly. Exhaustive
 * pruning moves the 0.25 m point by one key (99 → 100). At 0.05 m, valley-explicit reaches
 * the derived observability budget at 75 keys and lands 1.8 mm outside its floor; that is
 * the sanctioned narrow-feature outcome, not part of the shipping 0.50 m contract. */
test("flat authoring-half-step sweep", () => {
    const rows: { halfStep: number; keys: number; held: number; ms: number }[] = [];
    for (const halfStep of [0.05, 0.1, 0.25, 0.5]) {
        const started = performance.now();
        let keys = 0;
        let held = 0;
        for (const scenario of scenarios) {
            const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };
            const bake = evalGeo(entry, scenario.nodes, scenario.ds);
            const floor = chordDeficit(spine(bake, scenario.ds)) + halfStep;
            const result = refine({ bake, entry, ds: scenario.ds, floor });
            keys += result.final.keys;
            if (result.outcome === "floor" && result.final.deviation <= floor) held++;
            if (halfStep === 0.05 && scenario.name === "valley-explicit") {
                expect(result.outcome).toBe("budget");
                expect(result.final.keys).toBe(75);
                expect(result.floor).toBeCloseTo(0.103510402, 9);
                expect(result.final.deviation).toBeCloseTo(0.105263744, 9);
            }
        }
        rows.push({ halfStep, keys, held, ms: performance.now() - started });
    }
    console.table(rows);
    expect(rows.map(({ keys }) => keys)).toEqual([212, 130, 100, 80]);
    expect(rows.map(({ held }) => held)).toEqual([9, 10, 10, 10]);
}, 360_000);
