// the corpus-wide conversion gates — run explicitly (`bun test ./tests/refine.oracle.ts`), outside the default
// `bun test` glob because building the ten-scenario corpus in-process costs ~25 s. The fast tier
// (`refine.test.ts`) keeps a three-scenario mini-corpus golden gate against the same fixture, so
// a kernel edit still fails in seconds; the corpus-wide claims live here.
import { describe, expect, test } from "bun:test";
import { chordDeficit, spine } from "../src/polish";
import { custom, forceProfile } from "../src/profile";
import { authoringFloor, CONVERT_STEP, narrow, refine } from "../src/refine";
import { scenarios } from "../src/scenarios";
import { evalForce, evalGeo } from "../src/section";
import golden from "./fixtures/convert-golden.json";
import { assertGolden } from "./helpers/compare";
import { CONVERT_REGISTRY, GOLDEN, nominalMissAt, PLATFORM_STAMP } from "./helpers/golden";

const started = performance.now();
const CORPUS = scenarios.map((scenario) => {
    const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };
    const bake = evalGeo(entry, scenario.nodes, scenario.ds);
    const result = refine({ bake, entry, ds: scenario.ds });
    return { scenario, entry, bake, result };
});
const CORPUS_MS = performance.now() - started;

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

describe("flat split → exhaustive prune: the corpus", () => {
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

    test("realized replay holds the corpus floor; nominal replay matches this platform's measured miss record", () => {
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
        // which scenarios miss the nominal-replay floor is a discrete structural fact about the
        // fresh solve on THIS platform (refine's knot placement diverges cross-machine, 3e), not
        // a continuous quantity a shared literal can hold — declared per-stamp in helpers/golden.ts.
        expect({
            count: misses.length,
            scenarios: misses.map(({ name }) => name),
            minRatio: Math.min(...ratios),
            maxRatio: Math.max(...ratios),
        }).toEqual(nominalMissAt(PLATFORM_STAMP));

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
            // `keys`/`probes` are structural fields the golden already declares
            // (`helpers/golden.ts`'s `CONVERT_REGISTRY`) — read off it directly rather than a
            // second, hand-copied table that can drift from the fixture it restates.
            expect(result.final.keys).toBe(GOLDEN(scenario.name).keys);
            expect(result.probes).toBe(GOLDEN(scenario.name).probes);
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
        // Measured cold in this file on 2026-07-29: ~25 s (the corpus build alone, without the
        // fast tier's atoms sharing the process). Two times that keeps a contended full-tier run
        // out of the verification loop while retaining a hang bar.
        expect(CORPUS_MS).toBeLessThan(50_000);
    });

    // The golden gate for every performance change to the conversion core. The stage-6b human
    // check approved these SPECIFIC outputs as an authoring surface, so a faster solve that
    // moves structure — a key, a knot — has silently re-opened that verdict; that half stays a
    // hard fail. The continuous half (`floor`, `deviation`, `points[].g`) is bounded, not
    // bit-compared, through the declared registry (`helpers/compare.ts`): this machine's libm
    // doesn't reproduce the frozen dump's implementation-defined `Math` calls bit-for-bit, and a
    // `toBe` there would fail on drift the contract doesn't own (`kex2d-golden-reproducibility`).
    test("every corpus conversion is bit-identical to the frozen dump", () => {
        const platform = golden[PLATFORM_STAMP as keyof typeof golden];
        expect(Object.keys(platform).sort()).toEqual(CORPUS.map((c) => c.scenario.name).sort());
        for (const { scenario, result } of CORPUS)
            assertGolden(narrow(result), GOLDEN(scenario.name), CONVERT_REGISTRY, scenario.name);
    });
});
