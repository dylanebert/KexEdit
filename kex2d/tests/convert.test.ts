import { describe, expect, test } from "bun:test";
import { convert, convertPlayback, type ConvertProgress, liveWorkers } from "../src/convert";
import { narrow } from "../src/refine";
import { bakeOf, GOLDEN } from "./helpers/golden";
import { divergingPool, dyingPool, withWorker } from "./helpers/pool";

// pool behavior on cheap scenarios — the fast tier. The corpus-wide pool gates (whole-corpus
// bit-identity, pool-size invariance, the mid-fan-out abort that needs double-hump's wide prune
// rounds) run at `convert.oracle.ts`, run explicitly.

describe("pooled conversion", () => {
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

    // An unvalidated size is not a smaller pool but an unbounded one: `Math.floor(NaN)` is NaN and
    // every `size` comparison against it is false, so the cap disappears.
    test("workers must be a finite count", async () => {
        const { scenario, entry, bake } = bakeOf("circular-arc");
        for (const workers of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
            await expect(convert(bake, entry, scenario.ds, { workers })).rejects.toThrow(
                /finite number >= 1/,
            );
            expect(liveWorkers()).toBe(0);
        }
    });

    test("an abort before the first probe rejects without spawning anything", async () => {
        const { scenario, entry, bake } = bakeOf("circular-arc");
        const controller = new AbortController();
        controller.abort();
        await expect(
            convert(bake, entry, scenario.ds, { signal: controller.signal }),
        ).rejects.toThrow();
        expect(liveWorkers()).toBe(0);
    });

    // A probe that throws inside the worker comes back as a `failed` reply, not a dead worker:
    // the pool has to turn that into a rejection rather than a hang, and stay usable. A NaN in
    // the dense force is the honest trigger — the caller-side validation reads the geometry, so
    // it passes there and blows up in the probe, exactly where a real bad bake would.
    test("a probe that throws in the worker rejects, and the next conversion still lands the golden", async () => {
        const { scenario, entry, bake } = bakeOf("circular-arc");
        const fN = Float64Array.from(bake.fN);
        fN[3] = Number.NaN;
        await expect(convert({ ...bake, fN }, entry, scenario.ds)).rejects.toThrow(
            /convert worker: .*fN\[3\] is NaN/,
        );
        expect(liveWorkers()).toBe(0);
        // the pool is per-conversion, so a failure doesn't poison the module: the next
        // conversion still lands the golden.
        expect(await convert(bake, entry, scenario.ds)).toEqual(GOLDEN("circular-arc"));
    }, 120_000);

    // The other worker failure: one that stops existing mid-probe (an OOM, a host kill). It
    // reaches the pool as an `error` event with no reply, and the job it was carrying has to
    // reject rather than wait forever on a corpse.
    test("a worker that dies mid-probe rejects the conversion and leaves no live workers", async () => {
        const { scenario, entry, bake } = bakeOf("circular-arc");
        await withWorker(dyingPool(), async () => {
            await expect(convert(bake, entry, scenario.ds)).rejects.toThrow(/worker died/);
        });
        expect(liveWorkers()).toBe(0);
    });

    // A prune round is the one place the pool runs ahead of the loop, so it's the one place a
    // divergence leaves work in flight: the candidate that came back unreadable ends the round,
    // and the prefetched tail behind it is never consumed. That has to settle as a clean
    // `"diverged"` answer with an empty pool — not an unhandled rejection or a leaked worker.
    test("an unreadable prune candidate ends the conversion as diverged", async () => {
        const { scenario, entry, bake } = bakeOf("straight-fillet");
        const result = await withWorker(divergingPool(), () =>
            convert(bake, entry, scenario.ds, { workers: 4 }),
        );
        expect(result.outcome).toBe("diverged");
        expect(result.deviation).toBeNaN();
        expect(liveWorkers()).toBe(0);
    }, 120_000);

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
