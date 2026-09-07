// kex2d's investigation-LAB capture flows: screenshots of the standalone atom pages
// (geometry/loop/FVD/collocate/fit labs), device-free scenarios captured through their own DEV
// hooks (`__solve`, `__fitlab` — distinct from the app's `__kex`). Shared helpers live in `./flow`.

import { test, expect, join, OUT, SHOT_MS } from "./flow";

// The geometry→force atom observability page:
// the ∂F/∂P sparsity heatmap, the round-trip overlay, and the conditioning plot.
// Pure canvas2D (no GPU) rendered on module load; capture the page + each panel.
test("geometry atoms lab", async ({ page, boot }) => {
    await boot("/geometry-lab.html");
    const panels = page.locator(".panel");
    await expect(panels).toHaveCount(3);
    await page.waitForTimeout(SHOT_MS);

    await page.screenshot({ path: join(OUT, "geometry-lab.png"), fullPage: true });
    const names = ["geometry-sparsity", "geometry-roundtrip", "geometry-conditioning"];
    for (let i = 0; i < names.length; i++) {
        await panels.nth(i).screenshot({ path: join(OUT, `${names[i]}.png`) });
    }
});

// The Stage-2 loop-solve observability page:
// draft-vs-solved geometry under the band, the force curve entering the band,
// and the infeasible pin losing loudly. Pure canvas2D rendered on module load.
test("loop solve lab", async ({ page, boot }) => {
    await boot("/loop-lab.html");
    const panels = page.locator(".panel");
    await expect(panels).toHaveCount(3);
    await page.waitForTimeout(SHOT_MS);

    await page.screenshot({ path: join(OUT, "loop-lab.png"), fullPage: true });
    const names = ["loop-geometry", "loop-force", "loop-infeasible"];
    for (let i = 0; i < names.length; i++) {
        await panels.nth(i).screenshot({ path: join(OUT, `${names[i]}.png`) });
    }
});

// The Stage-3 FVD-limit observability page:
// the sketch→oracle overlay on the loop, tracking across aggressiveness, and
// warm-start cost per target edit. Pure canvas2D rendered on module load.
test("FVD limit lab", async ({ page, boot }) => {
    await boot("/fvd-lab.html");
    const panels = page.locator(".panel");
    await expect(panels).toHaveCount(3);
    await page.waitForTimeout(SHOT_MS);

    await page.screenshot({ path: join(OUT, "fvd-lab.png"), fullPage: true });
    const names = ["fvd-overlay", "fvd-tracking", "fvd-warmstart"];
    for (let i = 0; i < names.length; i++) {
        await panels.nth(i).screenshot({ path: join(OUT, `${names[i]}.png`) });
    }
});

// The collocation solver observability page:
// the LM convergence curve, the solved-vs-analytic overlay, and the solved-vs-
// target force. Pure canvas2D (no GPU) rendered on module load.
test("collocation solver lab", async ({ page, boot }) => {
    await boot("/collocate-lab.html");
    const panels = page.locator(".panel");
    await expect(panels).toHaveCount(3);
    await page.waitForTimeout(SHOT_MS);

    await page.screenshot({ path: join(OUT, "collocate-lab.png"), fullPage: true });
    const names = ["collocate-convergence", "collocate-overlay", "collocate-force"];
    for (let i = 0; i < names.length; i++) {
        await panels.nth(i).screenshot({ path: join(OUT, `${names[i]}.png`) });
    }
});

// The geo→force fit lab: the flat conversion is the default view and solves on demand;
// the lighter full-free oracle corpus fills in cooperatively on load. The conversion runs
// through the worker pool (`convert.ts`), so the page answers throughout it — which is also
// why this flow now measures 5.8 s, down from 22.1 s when the solve blocked the main thread.
// The config's 60 s per-test ceiling stays: it is a stall tripwire, not a budget to re-tune.
test("fit lab", async ({ page, boot }) => {
    await boot("/fit-lab.html");
    const panels = page.locator(".panel");
    await expect(panels).toHaveCount(4);

    const ready = () => page.evaluate((): boolean => (window as any).__fitlab.ready());
    const errors = () => page.evaluate((): string[] => (window as any).__fitlab.errors());
    const rows = () =>
        page.evaluate((): { name: string; converged: boolean }[] =>
            (window as any).__fitlab.rows(),
        );

    expect(await page.evaluate(() => (window as any).__fitlab.mode())).toBe("convert");
    await expect.poll(ready, { timeout: 10_000 }).toBe(true);
    expect(await errors()).toEqual([]);
    const solved = await rows();
    expect(solved).toHaveLength(10);
    for (const row of solved) expect(row.converged, `${row.name} did not converge`).toBe(true);

    // The opt-in oracle keeps the legacy fit→polish playback correspondence.
    await page.evaluate(() => (window as any).__fitlab.setMode("exact"));
    await page.evaluate(() => (window as any).__fitlab.select("valley-explicit"));
    await page.evaluate(() => (window as any).__fitlab.setMode("exact"));
    const oraclePhases = await page.evaluate((): { phase: string; start: number; end: number }[] =>
        (window as any).__fitlab.phases(),
    );
    const oracleFrames = await page.evaluate((): number => (window as any).__fitlab.frames());
    expect(oraclePhases.map((phase) => phase.phase)).toEqual(["recover", "fit", "polish"]);
    expect(oraclePhases[0].start).toBe(0);
    expect(oraclePhases[2].end).toBe(oracleFrames - 1);
    for (let i = 1; i < oraclePhases.length; i++)
        expect(oraclePhases[i].start).toBe(oraclePhases[i - 1].end + 1);
    const warm = await page.evaluate((): number => (window as any).__fitlab.warmFrame());
    expect(warm).toBe(oraclePhases[1].end);
    await page.evaluate((value: number) => (window as any).__fitlab.setFrame(value), warm);
    const handles = await page.evaluate(
        (): { mirror: number; aligned: number; broken: number; single: number } =>
            (window as any).__fitlab.handles(),
    );
    const oracleKeys = await page.evaluate((): number => (window as any).__fitlab.frameKeys());
    expect(handles.mirror + handles.aligned + handles.broken + handles.single).toBe(oracleKeys);
    expect(handles.broken).toBeGreaterThan(0);
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "fit-lab.png"), fullPage: true });

    // The shipping timeline is only dense recovery plus the loop's own flat decisions.
    await page.evaluate(() => (window as any).__fitlab.select("full-loop"));

    // The solve runs in the conversion worker pool, so the page answers WHILE it solves. This
    // observes a state a blocking solve cannot produce: probes already counted, no answer yet.
    // (With the in-thread solve, the first evaluate to return did so after the answer landed —
    // proven by reverting the lab to `refine`, where this poll times out.)
    await expect
        .poll(
            () =>
                page.evaluate(() => {
                    const lab = (window as any).__fitlab;
                    return lab.progress().probes > 0 && lab.metrics() === null;
                }),
            { timeout: 5_000 },
        )
        .toBe(true);

    await expect
        .poll(
            () =>
                page.evaluate(
                    () =>
                        (window as any).__fitlab.metrics() !== null ||
                        (window as any).__fitlab.errors().length > 0,
                ),
            { timeout: 10_000 },
        )
        .toBe(true);
    expect(await errors()).toEqual([]);
    const convertPhases = await page.evaluate((): { phase: string; start: number; end: number }[] =>
        (window as any).__fitlab.phases(),
    );
    const convertFrames = await page.evaluate((): number => (window as any).__fitlab.frames());
    expect(convertPhases.map((phase) => phase.phase)).toEqual(["recover", "refine"]);
    expect(convertPhases[0].start).toBe(0);
    expect(convertPhases[1].end).toBe(convertFrames - 1);
    expect(convertPhases[1].start).toBe(convertPhases[0].end + 1);

    const events = await page.evaluate((): { kind: string; keys: number; frame: number }[] =>
        (window as any).__fitlab.events(),
    );
    expect(events[0]).toMatchObject({ kind: "init", keys: 2 });
    expect(events.some((event) => event.kind === "split")).toBe(true);
    expect(events.some((event) => event.kind === "diverged")).toBe(false);
    for (const event of events) {
        expect(event.frame).toBeGreaterThanOrEqual(convertPhases[1].start);
        expect(event.frame).toBeLessThanOrEqual(convertPhases[1].end);
    }
    const chips = await page.locator(".phases > span").allTextContents();
    expect(chips).toHaveLength(events.length + 1);
    expect(chips[0]).toBe("recover");
    for (let index = 0; index < events.length; index++)
        expect(chips[index + 1]).toContain(events[index].kind);
    expect(chips.at(-1)).toContain("answer");
    expect(await page.evaluate(() => (window as any).__fitlab.outcome())).toBe("floor");
    expect(await page.evaluate((): number => (window as any).__fitlab.warmFrame())).toBe(
        convertFrames - 1,
    );

    await page.evaluate(
        (value: number) => (window as any).__fitlab.setFrame(value),
        convertFrames - 1,
    );
    const vocab = await page.evaluate(
        (): {
            mirror: number;
            aligned: number;
            broken: number;
            single: number;
            flat: number;
            named: number;
            segments: number;
            keys: number;
        } => (window as any).__fitlab.vocab(),
    );
    const metrics = await page.evaluate((): { keys: number; heldFloor: boolean; ms: number } =>
        (window as any).__fitlab.metrics(),
    );
    expect(vocab.mirror + vocab.aligned + vocab.broken + vocab.single).toBe(vocab.keys);
    expect(vocab.keys).toBe(metrics.keys);
    expect(vocab.broken).toBe(0);
    expect(vocab.flat).toBe(vocab.keys);
    expect(vocab.segments).toBe(vocab.keys - 1);
    expect(vocab.named).toBe(vocab.segments);
    expect(metrics.heldFloor).toBe(true);
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "fit-lab-convert.png"), fullPage: true });
});
