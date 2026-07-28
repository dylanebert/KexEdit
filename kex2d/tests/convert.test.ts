import { describe, expect, test } from "bun:test";
import { convert, convertPlayback, type ConvertProgress, liveWorkers } from "../src/convert";
import { narrow, refine, type RefineOutcome } from "../src/refine";
import { scenarios } from "../src/scenarios";
import { evalGeo } from "../src/section";
import golden from "./fixtures/convert-golden.json";

function bakeOf(name: string) {
    const scenario = scenarios.find((candidate) => candidate.name === name);
    if (!scenario) throw new Error(`missing scenario ${name}`);
    const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };
    return { scenario, entry, bake: evalGeo(entry, scenario.nodes, scenario.ds) };
}

const GOLDEN = (name: string) => {
    const want = golden[name as keyof typeof golden];
    return { ...want, outcome: want.outcome as RefineOutcome };
};

describe("pooled conversion", () => {
    // The boundary oracle. A worker probe is `polish` in another VM against a structured-cloned
    // bake, so anything that copied wrong — a truncated array, a float that went through a
    // string, a bake field silently dropped — moves the answer. Compared against the frozen
    // golden with `toEqual` over plain numbers, which is exact: `toBeCloseTo` would pass exactly
    // the drift the gate exists to catch. The whole corpus, because "the pool reproduces the
    // shipping conversion" is the claim, not "it reproduced one of them".
    test("every corpus conversion crosses the pool bit-identical", async () => {
        for (const { name } of scenarios) {
            const { scenario, entry, bake } = bakeOf(name);
            const result = await convert(bake, entry, scenario.ds);
            expect(result, name).toEqual(GOLDEN(name));
        }
        // the pool is a resource, not a leak: a completed conversion leaves nothing running.
        expect(liveWorkers()).toBe(0);
    }, 300_000);

    // Pool size is the one thing a caller's machine changes about a conversion, so it is the one
    // thing that must not change the answer. Size 1 serializes every prune round; size 8 fans it
    // out and lets it finish in whatever order the OS schedules. Same scenario, same answer, and
    // both equal to the in-process `refine` the golden was frozen from.
    test("the answer is invariant to pool size and completion order", async () => {
        const { scenario, entry, bake } = bakeOf("parabola-hill");
        const serial = await convert(bake, entry, scenario.ds, { workers: 1 });
        const fanned = await convert(bake, entry, scenario.ds, { workers: 8 });
        const sync = narrow(refine({ bake, entry, ds: scenario.ds, playback: false }));
        expect(serial).toEqual(fanned);
        expect(serial).toEqual(sync);
        expect(serial).toEqual(GOLDEN("parabola-hill"));
    }, 300_000);

    // Progress is what makes a multi-second solve legible, so it has to be honest about the shape
    // of the work: the opening probe, then splits while the floor is violated, then prune rounds.
    // The count is the loop's own probe ordinal, which is why it lands exactly on `probes`.
    test("progress reports every probe once, in phase order", async () => {
        const { scenario, entry, bake } = bakeOf("straight-fillet");
        const seen: ConvertProgress[] = [];
        const result = await convert(bake, entry, scenario.ds, {
            onProgress: (progress) => seen.push(progress),
        });
        expect(seen.map(({ probes }) => probes)).toEqual(
            Array.from({ length: result.probes }, (_, index) => index + 1),
        );
        expect(seen[0].phase).toBe("open");
        expect(seen[0].keys).toBe(2);
        expect(new Set(seen.map(({ phase }) => phase))).toEqual(
            new Set(["open", "split", "prune"]),
        );
        // phases never go backwards: no split after the first prune.
        const firstPrune = seen.findIndex(({ phase }) => phase === "prune");
        expect(seen.slice(firstPrune).every(({ phase }) => phase === "prune")).toBe(true);
    }, 120_000);

    // Cancel is pool termination, not "stop asking for probes": a probe in flight is up to a
    // second of solving, and waiting it out is the freeze this whole façade exists to remove. So
    // the assert is a latency budget AND an empty pool — the second is what proves the first
    // wasn't just a promise settling ahead of workers that are still burning a core.
    test("an abort settles promptly and leaves no live workers", async () => {
        const { scenario, entry, bake } = bakeOf("double-hump");
        const controller = new AbortController();
        let started = 0;
        const solving = convert(bake, entry, scenario.ds, {
            signal: controller.signal,
            onProgress: () => {
                if (started === 0) started = performance.now();
            },
        });
        solving.catch(() => {});
        // abort mid-solve, not before it: wait for the pool to actually be working.
        while (started === 0) await Bun.sleep(5);
        expect(liveWorkers()).toBeGreaterThan(0);
        const at = performance.now();
        controller.abort();
        await expect(solving).rejects.toThrow();
        const latency = performance.now() - at;
        expect(liveWorkers()).toBe(0);
        // a probe on this scenario is 100–450 ms; 50 ms says the abort did not wait for one.
        expect(latency).toBeLessThan(50);
    }, 120_000);

    test("an abort before the first probe rejects without spawning anything", async () => {
        const { scenario, entry, bake } = bakeOf("circular-arc");
        const controller = new AbortController();
        controller.abort();
        await expect(
            convert(bake, entry, scenario.ds, { signal: controller.signal }),
        ).rejects.toThrow();
        expect(liveWorkers()).toBe(0);
    });

    // The labs read the decisions, not just the answer, so the playback variant carries the same
    // events and per-probe frames the in-process rich path builds — and lands on the same answer.
    test("the playback variant keeps the freight and the answer", async () => {
        const { scenario, entry, bake } = bakeOf("circular-arc");
        const rich = await convertPlayback(bake, entry, scenario.ds);
        expect(narrow(rich)).toEqual(GOLDEN("circular-arc"));
        expect(rich.events.length).toBeGreaterThan(0);
        expect(rich.events[0]).toMatchObject({ kind: "init", knots: [0, bake.edges - 1] });
        expect(rich.final.snapshots.length).toBeGreaterThan(0);
        expect(rich.events.at(-1)?.points).toEqual(rich.final.points);
        expect(liveWorkers()).toBe(0);
    }, 120_000);
});
