import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PolishResult } from "../src/polish";
import type { ForcePoint } from "../src/profile";
import {
    type Frame,
    narrow,
    readable,
    refine,
    type RefineOutcome,
    residual,
    siteIn,
    splitSite,
} from "../src/refine";
import { scenarios } from "../src/scenarios";
import { evalGeo } from "../src/section";
import golden from "./fixtures/convert-golden.json";

// The seconds-scale slice of the conversion corpus — the three cheapest scenarios, refined
// through the same shipping path the full corpus takes. The corpus-wide gates (floor hold,
// replay, key counts, the full golden) run in `refine.oracle.ts`,
// run explicitly; this mini corpus keeps a bit-identity golden gate in the default
// `bun test` loop so a kernel edit still fails in seconds.
const MINI = ["circular-arc", "straight-fillet", "hill-explicit"] as const;
const CORPUS = MINI.map((name) => {
    const scenario = scenarios.find((candidate) => candidate.name === name);
    if (!scenario) throw new Error(`missing scenario ${name}`);
    const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };
    const bake = evalGeo(entry, scenario.nodes, scenario.ds);
    const result = refine({ bake, entry, ds: scenario.ds });
    return { scenario, entry, bake, result };
});

function answer(
    points: readonly ForcePoint[],
    patch: Partial<PolishResult> & Pick<PolishResult, "converged" | "deviation" | "deviations">,
): PolishResult {
    return {
        ...CORPUS[0].result.final,
        ...patch,
        points: points.map(({ s, g }) => ({ s, g })),
        keys: points.length,
        snapshots: [],
    };
}

/** every `src` module reachable from an entry, over every sibling specifier in the source —
 *  static, type-only, dynamic, or a `new URL` worker entry alike. Type-only imports count even
 *  though a bundler erases them: the source dependency is what a later edit turns back into a
 *  runtime one. */
function reach(entry: string): Set<string> {
    const seen = new Set<string>();
    const queue = [entry];
    for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
        if (seen.has(file)) continue;
        seen.add(file);
        const source = readFileSync(join(import.meta.dir, "..", "src", file), "utf8");
        for (const [, name] of source.matchAll(/"\.\/([\w-]+(?:\.\w+)?)"/g))
            queue.push(name.includes(".") ? name : `${name}.ts`);
    }
    return seen;
}

describe("flat split → exhaustive prune", () => {
    // The fast half of the bit-identity gate: the same fixture, the same `toBe` compare, over
    // the mini corpus — so a kernel edit that moves a key or a g-value by one ulp fails here in
    // seconds, not only at the full-tier golden (`refine.oracle.ts`).
    test("every mini-corpus conversion is bit-identical to the frozen dump", () => {
        for (const { scenario, result } of CORPUS) {
            const want = golden[scenario.name as keyof typeof golden];
            expect(result.knots).toEqual(want.knots);
            expect(result.outcome).toBe(want.outcome as RefineOutcome);
            expect(result.floor).toBe(want.floor);
            expect(result.probes).toBe(want.probes);
            expect(result.final.keys).toBe(want.keys);
            expect(result.final.edges).toBe(want.edges);
            expect(result.final.length).toBe(want.length);
            expect(result.final.ds).toBe(want.ds);
            expect(result.final.deviation).toBe(want.deviation);
            expect(result.final.points).toHaveLength(want.points.length);
            for (let k = 0; k < want.points.length; k++) {
                expect(result.final.points[k].s).toBe(want.points[k].s);
                expect(result.final.points[k].g).toBe(want.points[k].g);
            }
        }
    });

    // What a document converts to is a frozen contract, so the conversion quantum is the
    // core's own constant and `settings.ts` — the localStorage-backed per-user preference
    // home — must stay out of its module graph, worker bundle included. `magnet.ts` is the
    // walker's positive control: it DOES read the live preference, so a walker that finds
    // nothing anywhere would fail there first.
    test("the conversion core's module graph never reaches the preference home", () => {
        expect(reach("magnet.ts")).toContain("settings.ts");
        const core = reach("refine.ts");
        expect(core).toContain("polish.ts");
        expect(core).not.toContain("settings.ts");
        // the pool's worker is its own bundle entry — the one the "worker bundle included"
        // clause above is actually about, now that it exists.
        const worker = reach("convert-worker.ts");
        expect(worker).toContain("polish.ts");
        expect(worker).not.toContain("settings.ts");
    });

    // The production path is the same conversion with the lab's freight unbuilt, so it must
    // land on the byte-identical answer the rich path froze. Two scenarios, not ten: the
    // recording seam is one branch in `polish`/`refine` that every probe of every geometry
    // takes the same way, and the corpus-wide gate (`refine.oracle.ts`) already runs the math.
    test("the production path narrows to the golden with no freight recorded", () => {
        for (const name of ["circular-arc", "hill-explicit"]) {
            const item = CORPUS.find(({ scenario }) => scenario.name === name);
            if (!item) throw new Error(`missing ${name}`);
            const quiet = refine({
                bake: item.bake,
                entry: item.entry,
                ds: item.scenario.ds,
                playback: false,
            });
            expect(quiet.events).toEqual([]);
            expect(quiet.final.snapshots).toEqual([]);
            // typed as `ConvertResult`, so the fixture and the payload having the same field
            // set is checked by `tsc`, not just field-by-field at runtime.
            const want = golden[name as keyof typeof golden];
            expect(narrow(quiet)).toEqual({ ...want, outcome: want.outcome as RefineOutcome });
            // the rich path still records — otherwise the assertions above pass on a seam
            // that stopped doing anything.
            expect(item.result.events.length).toBeGreaterThan(0);
            expect(item.result.final.snapshots.length).toBeGreaterThan(0);
            expect(narrow(item.result)).toEqual(narrow(quiet));
        }
    });

    test("conversion is deterministic", () => {
        const first = CORPUS[0];
        const again = refine({
            bake: first.bake,
            entry: first.entry,
            ds: first.scenario.ds,
        });
        expect(again).toEqual(first.result);
    });
});

describe("placement, pruning, and divergence atoms", () => {
    const frame: Frame = {
        sigma: Float64Array.from([0, 1, 2, 3, 4, 5, 6]),
        ds: 1,
        minSpan: 2,
    };

    test("split placement uses residual equidistribution and preserves observable halves", () => {
        const deviations = Float64Array.from([0, 10, 1, 1, 8, 8, 0]);
        const segments = residual(frame, [0, 6], deviations);
        expect(segments[0].half).toBe(4);
        expect(siteIn(frame, 0, 6, segments[0].half)).toBe(4);
        expect(splitSite(frame, [0, 6], deviations).site).toBe(4);
        expect(siteIn(frame, 0, 3, 1)).toBe(-1);
    });

    test("interval readings and unreadable residuals are explicit", () => {
        const segments = residual(frame, [0, 3, 6], Float64Array.from([0, 1, 2, 3, 2, 1, 0]));
        expect(segments.map(({ worst }) => worst)).toEqual([2, 3]);
        expect(readable(Float64Array.from([0, 1, 2]))).toBe(true);
        expect(readable(Float64Array.from([0, Number.NaN, 2]))).toBe(false);
        expect(readable(Float64Array.from([Number.POSITIVE_INFINITY]))).toBe(false);
    });

    test("an unreadable prune counterfactual terminates on the failed candidate", () => {
        const { scenario, bake, entry } = CORPUS[0];
        const violated = new Float64Array(bake.edges + 1).fill(1);
        violated[0] = 0;
        const held = new Float64Array(bake.edges + 1);
        const unreadable = new Float64Array(bake.edges + 1);
        unreadable[1] = Number.NaN;
        let calls = 0;
        const result = refine({
            bake,
            entry,
            ds: scenario.ds,
            floor: 0.5,
            probe: (points) => {
                calls++;
                if (calls === 1)
                    return answer(points, {
                        converged: false,
                        deviation: 1,
                        deviations: violated,
                    });
                if (calls === 2)
                    return answer(points, {
                        converged: true,
                        deviation: 0.25,
                        deviations: held,
                    });
                return answer(points, {
                    converged: true,
                    deviation: 0.25,
                    deviations: unreadable,
                });
            },
        });
        expect(result.outcome).toBe("diverged");
        expect(result.knots).toHaveLength(2);
        expect(result.final.points).toHaveLength(2);
        expect(result.events.at(-1)).toMatchObject({
            kind: "diverged",
            knots: result.knots,
            points: result.final.points,
        });
    });

    test("an unreadable opening terminates before any structural decision", () => {
        const { scenario, bake, entry } = CORPUS[0];
        const unreadable = new Float64Array(bake.edges + 1);
        unreadable[1] = Number.NaN;
        const result = refine({
            bake,
            entry,
            ds: scenario.ds,
            floor: 0.5,
            probe: (points) =>
                answer(points, {
                    converged: false,
                    deviation: 1,
                    deviations: unreadable,
                }),
        });
        expect(result.outcome).toBe("diverged");
        expect(result.probes).toBe(1);
        expect(result.events.map(({ kind }) => kind)).toEqual(["init", "diverged"]);
        expect(result.events.at(-1)).toMatchObject({
            knots: result.knots,
            points: result.final.points,
        });
    });

    test("an unreadable split logs the actual failed candidate", () => {
        const { scenario, bake, entry } = CORPUS[0];
        const violated = new Float64Array(bake.edges + 1).fill(1);
        violated[0] = 0;
        const unreadable = new Float64Array(bake.edges + 1);
        unreadable[1] = Number.POSITIVE_INFINITY;
        let calls = 0;
        const result = refine({
            bake,
            entry,
            ds: scenario.ds,
            floor: 0.5,
            probe: (points) =>
                ++calls === 1
                    ? answer(points, {
                          converged: false,
                          deviation: 1,
                          deviations: violated,
                      })
                    : answer(points, {
                          converged: false,
                          deviation: 0.75,
                          deviations: unreadable,
                      }),
        });
        expect(result.outcome).toBe("diverged");
        expect(result.knots).toHaveLength(3);
        expect(result.final.points).toHaveLength(3);
        expect(result.events.at(-1)).toMatchObject({
            kind: "diverged",
            knots: result.knots,
            points: result.final.points,
        });
        expect(result.events.at(-1)?.at).toBeGreaterThan(0);
    });

    test("a finite unconverged opening remains a waypoint", () => {
        const { scenario, bake, entry } = CORPUS[0];
        const violated = new Float64Array(bake.edges + 1).fill(1);
        violated[0] = 0;
        const held = new Float64Array(bake.edges + 1);
        let calls = 0;
        const result = refine({
            bake,
            entry,
            ds: scenario.ds,
            floor: 0.5,
            probe: (points) => {
                calls++;
                if (calls === 1)
                    return answer(points, {
                        converged: false,
                        deviation: 1,
                        deviations: violated,
                    });
                if (calls === 2)
                    return answer(points, {
                        converged: true,
                        deviation: 0.25,
                        deviations: held,
                    });
                return answer(points, {
                    converged: false,
                    deviation: 0.75,
                    deviations: violated,
                });
            },
        });
        expect(result.outcome).toBe("floor");
        expect(result.events.map(({ kind }) => kind)).toEqual(["init", "split"]);
        expect(result.final.points).toHaveLength(3);
        expect(result.probes).toBe(3);
    });

    test("an exhausted readable grid is budget, never divergence", () => {
        const { scenario, bake, entry } = CORPUS[0];
        const violated = new Float64Array(bake.edges + 1).fill(1);
        violated[0] = 0;
        const result = refine({
            bake,
            entry,
            ds: scenario.ds,
            floor: 0.5,
            probe: (points) =>
                answer(points, {
                    converged: false,
                    deviation: 1,
                    deviations: violated,
                }),
        });
        expect(result.outcome).toBe("budget");
        expect(result.events.at(-1)?.kind).toBe("budget");
        expect(result.events.map(({ kind }) => kind)).not.toContain("diverged");
        expect(result.events.map(({ kind }) => kind)).not.toContain("prune");
    });
});
