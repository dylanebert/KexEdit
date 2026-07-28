import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chordDeficit, type PolishResult, spine } from "../src/polish";
import { custom, type ForcePoint, forceProfile } from "../src/profile";
import {
    authoringFloor,
    CONVERT_STEP,
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
import { evalForce, evalGeo } from "../src/section";
import golden from "./fixtures/convert-golden.json";

const EXPECTED: Record<string, { keys: number; probes: number }> = {
    "circular-arc": { keys: 3, probes: 3 },
    "parabola-hill": { keys: 9, probes: 34 },
    "full-loop": { keys: 7, probes: 35 },
    "s-curve": { keys: 11, probes: 30 },
    "straight-fillet": { keys: 5, probes: 12 },
    "hill-auto": { keys: 7, probes: 35 },
    "hill-explicit": { keys: 6, probes: 15 },
    "loop-explicit": { keys: 11, probes: 42 },
    "double-hump": { keys: 13, probes: 65 },
    "valley-explicit": { keys: 8, probes: 105 },
};

const started = performance.now();
const CORPUS = scenarios.map((scenario) => {
    const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };
    const bake = evalGeo(entry, scenario.nodes, scenario.ds);
    const result = refine({ bake, entry, ds: scenario.ds });
    return { scenario, entry, bake, result };
});
const CORPUS_MS = performance.now() - started;

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

function liveDeviation(
    item: (typeof CORPUS)[number],
    ds = item.result.final.ds,
): {
    deviation: number;
    exit: number;
    exitTheta: number;
    edges: number;
} {
    const { result, entry, bake } = item;
    const out = evalForce(entry, forceProfile(result.final.points, result.final.length, ds), ds);
    const sigma = [0];
    for (let i = 0; i < bake.edges; i++) sigma.push(sigma[i] + bake.ds[i]);
    let deviation = 0;
    let edge = 0;
    for (let j = 0; j <= out.edges; j++) {
        const at = Math.min(j * ds, sigma.at(-1) ?? 0);
        while (edge < bake.edges - 1 && sigma[edge + 1] < at) edge++;
        const span = sigma[edge + 1] - sigma[edge];
        const t = span > 0 ? Math.min(1, Math.max(0, (at - sigma[edge]) / span)) : 0;
        const x = bake.posX[edge] + t * (bake.posX[edge + 1] - bake.posX[edge]);
        const y = bake.posY[edge] + t * (bake.posY[edge + 1] - bake.posY[edge]);
        deviation = Math.max(deviation, Math.hypot(out.posX[j] - x, out.posY[j] - y));
    }
    return {
        deviation,
        exit: Math.hypot(
            out.posX[out.edges] - bake.posX[bake.edges],
            out.posY[out.edges] - bake.posY[bake.edges],
        ),
        exitTheta: Math.abs(out.exit.theta - bake.theta[bake.edges]),
        edges: out.edges,
    };
}

function lockedDeviation(item: (typeof CORPUS)[number], ds: number): number {
    const { result, entry } = item;
    const out = evalForce(entry, forceProfile(result.final.points, result.final.length, ds), ds);
    expect(out.edges).toBe(result.final.spine.edges);
    let deviation = 0;
    for (let index = 0; index <= out.edges; index++)
        deviation = Math.max(
            deviation,
            Math.hypot(
                out.posX[index] - result.final.spine.x[index],
                out.posY[index] - result.final.spine.y[index],
            ),
        );
    return deviation;
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
    test("all ten scenarios hold the fixed authoring floor through the live f32 path", () => {
        for (const item of CORPUS) {
            const { result } = item;
            expect(result.outcome).toBe("floor");
            expect(result.final.converged).toBe(true);
            expect(result.final.deviation).toBeLessThanOrEqual(result.floor);
            const live = liveDeviation(item);
            expect(live.deviation).toBeLessThanOrEqual(result.floor);
            expect(Math.abs(live.deviation - result.final.deviation)).toBeLessThan(1e-3);
            expect(live.exit).toBeLessThan(1e-3);
            // The live f32 maximum is valley-explicit at 9.834766e-6 rad. The
            // 1e-5-rad contract is therefore the first decimal boundary above the
            // measured quantization result, not corpus-tuned slack.
            expect(live.exitTheta).toBeLessThan(1e-5);
            expect(Math.abs(result.final.exit.dtheta)).toBeLessThan(1e-5);
        }
    });

    test("the floor is chord deficit plus half the fixed authoring step", () => {
        for (const { bake, result, scenario } of CORPUS) {
            const target = spine(bake, scenario.ds);
            expect(result.floor).toBe(authoringFloor(target));
            expect(result.floor - chordDeficit(target)).toBeCloseTo(0.5 * CONVERT_STEP, 12);
        }
    });

    test("realized replay holds the corpus floor; nominal replay has one measured miss", () => {
        const rows = CORPUS.map((item) => {
            const realized = lockedDeviation(item, item.result.final.ds);
            const nominal = lockedDeviation(item, item.scenario.ds);
            return {
                name: item.scenario.name,
                floor: item.result.floor,
                realized,
                nominal,
                ratio: nominal / item.result.floor,
            };
        });
        expect(rows.filter(({ floor, realized }) => realized > floor)).toEqual([]);
        const misses = rows.filter(({ floor, nominal }) => nominal > floor);
        const ratios = misses.map(({ ratio }) => ratio);
        expect({
            count: misses.length,
            scenarios: misses.map(({ name }) => name),
            minRatio: Math.min(...ratios),
            maxRatio: Math.max(...ratios),
        }).toEqual({
            count: 1,
            scenarios: ["loop-explicit"],
            minRatio: 1.0762891844739062,
            maxRatio: 1.0762891844739062,
        });

        const item = CORPUS.find(({ scenario }) => scenario.name === "loop-explicit");
        if (!item) throw new Error("missing loop-explicit");
        const realized = liveDeviation(item);
        const nominal = liveDeviation(item, item.scenario.ds);
        expect(item.result.final.ds).toBe(item.result.final.length / item.result.final.edges);
        expect(item.result.final.ds * realized.edges).toBeCloseTo(item.result.final.length, 12);
        expect(item.scenario.ds * nominal.edges).not.toBeCloseTo(item.result.final.length, 6);
        expect(realized.exit).toBeLessThan(1e-3);
        expect(nominal.exit).toBeGreaterThan(realized.exit);
        expect(nominal.exitTheta).toBeGreaterThan(realized.exitTheta);
    });

    test("every returned key is g-only and every segment is default Cubic", () => {
        for (const { result } of CORPUS) {
            for (const point of result.final.points) {
                expect(point).toEqual({ s: point.s, g: point.g });
            }
            for (let k = 0; k + 1 < result.final.points.length; k++)
                expect(custom(result.final.points[k], result.final.points[k + 1])).toBe(false);
            for (const event of result.events)
                for (const point of event.points) expect(point).toEqual({ s: point.s, g: point.g });
        }
    });

    test("the corpus settles at 80 keys, below the rejected 94-key pipeline", () => {
        let total = 0;
        for (const { scenario, result } of CORPUS) {
            expect(result.final.keys).toBe(EXPECTED[scenario.name].keys);
            expect(result.probes).toBe(EXPECTED[scenario.name].probes);
            expect(result.knots).toHaveLength(result.final.keys);
            total += result.final.keys;
        }
        expect(total).toBe(80);
        expect(total).toBeLessThanOrEqual(94);
    });

    test("event streams terminate and report only committed flat states", () => {
        for (const { bake, result } of CORPUS) {
            expect(result.events[0]).toMatchObject({ kind: "init", knots: [0, bake.edges - 1] });
            expect(result.events.length).toBeLessThan(2 * bake.edges);
            expect(result.events.every((event) => event.kind !== "diverged")).toBe(true);
            expect(result.events.at(-1)?.points).toEqual(result.final.points);
        }
    });

    test("the re-derived focused corpus budget has measured headroom", () => {
        // Measured cold in this file on 2026-07-26: ~40 s. Two times that keeps a
        // contended full-suite run out of the verification loop while retaining a hang bar.
        expect(CORPUS_MS).toBeLessThan(80_000);
    });

    // The bit-identity gate for every performance change to the conversion core. The
    // stage-6b human check approved these SPECIFIC outputs as an authoring surface, so a
    // faster solve that moves a key or a g-value by one ulp has silently re-opened that
    // verdict. Frozen from the shipping path (`refine` over the corpus) and compared with
    // `toBe`, never `toBeCloseTo`: an approximate compare would pass exactly the drift
    // this exists to catch. Proven red by perturbing the LM's initial damping constant.
    test("every corpus conversion is bit-identical to the frozen dump", () => {
        expect(Object.keys(golden).sort()).toEqual(CORPUS.map((c) => c.scenario.name).sort());
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
    });

    // The production path is the same conversion with the lab's freight unbuilt, so it must
    // land on the byte-identical answer the rich path froze. Two scenarios, not ten: the
    // recording seam is one branch in `polish`/`refine` that every probe of every geometry
    // takes the same way, and the corpus-wide gate above already runs the math.
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
