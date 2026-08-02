// the pool's corpus-wide gates — run explicitly (`bun test ./tests/convert.oracle.ts`), outside the default
// `bun test` glob because driving the whole corpus through the worker pool costs ~20 s. The
// fast tier (`convert.test.ts`) keeps every pool-behavior check on cheap scenarios; the
// corpus-wide claims and the fan-out-dependent abort live here.
import { describe, expect, test } from "bun:test";
import { convert, liveWorkers } from "../src/convert";
import { narrow, refine } from "../src/refine";
import { scenarios } from "../src/scenarios";
import { bakeOf, GOLDEN } from "./helpers/golden";

describe("pooled conversion: the corpus", () => {
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

    // Cancel is pool termination, not "stop asking for probes": a probe in flight is up to a
    // second of solving, and waiting it out is the freeze this whole façade exists to remove. So
    // the assert is a latency budget AND an empty pool — the second is what proves the first
    // wasn't just a promise settling ahead of workers that are still burning a core.
    //
    // The abort waits for the PRUNE phase deliberately. The split phase is serial, so aborting on
    // the first progress event only ever exercises one busy worker and an empty queue — the easy
    // case. A prune round is fanned across the pool with more candidates than workers, so the
    // abort has to tear down several in-flight probes AND reject a queued tail. Full tier: only
    // double-hump's prune rounds fan wide enough to catch the pool mid-fan-out reliably — a cheap
    // scenario's prune phase is over before the abort lands.
    test("an abort mid-fan-out settles promptly and leaves no live workers", async () => {
        const { scenario, entry, bake } = bakeOf("double-hump");
        const controller = new AbortController();
        let pruning = false;
        const solving = convert(bake, entry, scenario.ds, {
            workers: 4,
            signal: controller.signal,
            onProgress: ({ phase }) => {
                pruning ||= phase === "prune";
            },
        });
        solving.catch(() => {});
        while (!pruning) await Bun.sleep(5);
        // the whole pool is busy on the round, not just the one worker a split needs.
        expect(liveWorkers()).toBeGreaterThan(1);
        const at = performance.now();
        controller.abort();
        await expect(solving).rejects.toThrow();
        const latency = performance.now() - at;
        expect(liveWorkers()).toBe(0);
        // a probe on this scenario is 100–450 ms; 50 ms says the abort did not wait for one.
        expect(latency).toBeLessThan(50);
    }, 120_000);
});
