import { expect, test, kexCall, type Page, OUT, SHOT_MS, join } from "./flow";

/** The chart is the production geometry source: the canvas publishes its affine and row bands. */
async function point(page: Page, lane: string, station: number) {
    return page.locator(".chart").evaluate(
        (node, { lane, station }) => {
            const el = node as HTMLCanvasElement;
            const rect = el.getBoundingClientRect();
            const view = JSON.parse(el.dataset.view!) as { pan: number; pxPerU: number };
            const rows = JSON.parse(el.dataset.rows!) as {
                lane: string;
                top: number;
                height: number;
            }[];
            const row = rows.find((item) => item.lane === lane)!;
            return {
                x: rect.left + 76 + station * view.pxPerU - view.pan,
                y: rect.top + row.top + row.height / 2,
            };
        },
        { lane, station },
    );
}

async function valuePoint(page: Page, lane: string, station: number) {
    return page.locator(".chart").evaluate(
        (node, { lane, station }) => {
            const el = node as HTMLCanvasElement;
            const rect = el.getBoundingClientRect();
            const view = JSON.parse(el.dataset.view!) as { pan: number; pxPerU: number };
            const rows = JSON.parse(el.dataset.rows!) as {
                lane: string;
                top: number;
                height: number;
            }[];
            const fits = JSON.parse(el.dataset.valueWindows!) as {
                lane: string;
                lo: number;
                hi: number;
            }[];
            const row = rows.find((item) => item.lane === lane)!;
            const fit = fits.find((item) => item.lane === lane)!;
            const records = (
                window as unknown as {
                    __kex: {
                        lanes(): Record<
                            string,
                            { id: number; start: number; end: number; exit: number }[]
                        >;
                    };
                }
            ).__kex.lanes()[lane]!;
            const record =
                records.find((item) => item.start <= station && item.end > station) ?? records[0]!;
            const y = row.top + 3 + ((fit.hi - record.exit) / (fit.hi - fit.lo)) * (row.height - 6);
            return {
                id: record.id,
                value: record.exit,
                x: rect.left + 76 + record.end * view.pxPerU - view.pan,
                y: rect.top + y,
            };
        },
        { lane, station },
    );
}

async function selectedIds(page: Page): Promise<number[]> {
    return page.evaluate(async () => {
        const path = "/src/editor.ts";
        const { editor } = (await import(path)) as { editor: { records: { ids: Set<number> } } };
        return [...editor.records.ids];
    });
}

async function selectAt(page: Page, lane: string, station: number) {
    const p = await point(page, lane, station);
    await page.mouse.click(p.x, p.y);
    const record = (await kexCall(page, "lanes"))[lane as "geo" | "force" | "velocity"].find(
        (item) => item.start <= station && item.end > station,
    )!;
    await expect.poll(() => selectedIds(page)).toContain(record.id);
    await expect(page.locator(".popover")).toHaveCount(0);
    return { ...p, id: record.id };
}

async function snapshot(page: Page) {
    return { save: await kexCall(page, "save"), undo: await kexCall(page, "undoDepth") };
}

async function pause(page: Page): Promise<void> {
    await expect.poll(async () => (await kexCall(page, "cartArc")) !== null).toBe(true);
    const parked = await kexCall(page, "parked");
    if (!parked) await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect.poll(() => kexCall(page, "parked")).toBe(true);
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
    const p = await point(page, "geo", 5);
    const box = (await page.locator(".chart").boundingBox())!;
    await page.mouse.click(p.x, box.y + 12);
    await expect.poll(() => kexCall(page, "cartArc")).toBeCloseTo(5, 4);
}

async function loadDocument(page: Page, document: unknown): Promise<void> {
    await kexCall(page, "load", JSON.stringify(document));
    const expected = document as {
        lanes: Record<string, { start: number; end: number }[]>;
        track: { order?: number[] };
    };
    const names = ["velocity", "force", "geo"];
    const order = expected.track.order ?? [2, 1, 0];
    await expect
        .poll(async () => {
            const rows = JSON.parse((await page.locator(".chart").getAttribute("data-rows"))!) as {
                lane: string;
                records: { start: number; end: number }[];
            }[];
            return rows.map((row) => ({
                lane: row.lane,
                records: row.records.map(({ start, end }) => ({ start, end })),
            }));
        })
        .toEqual(
            order.map((kind) => ({
                lane: names[kind]!,
                records: expected.lanes[names[kind]!]!.map(({ start, end }) => ({ start, end })),
            })),
        );
}

async function assertRetiredSurfaces(page: Page): Promise<void> {
    await expect(
        page.locator(".feedback, .result, .read-station, .recovered, .actions"),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Segment actions", exact: true })).toHaveCount(0);
}

test("S3j lane value axis — layout", async ({ page, boot }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await boot();
    await pause(page);
    const metric = await page.evaluate(async () => {
        const canvas = document.querySelector<HTMLCanvasElement>(".chart")!;
        const rect = canvas.getBoundingClientRect();
        const adapter = await (navigator as unknown as { gpu: GPU }).gpu.requestAdapter();
        const fits = JSON.parse(canvas.dataset.valueWindows!) as {
            lane: string;
            lo: number;
            hi: number;
            base: number;
        }[];
        return {
            dock: document.querySelector(".dock")!.getBoundingClientRect().height,
            chart: { w: rect.width, h: rect.height, backing: [canvas.width, canvas.height] },
            rows: JSON.parse(canvas.dataset.rows!).length,
            fits,
            gpu: adapter ? `${adapter.info.vendor}/${adapter.info.architecture}` : null,
            top: window === top,
            dpr: devicePixelRatio,
        };
    });
    expect(metric.top).toBe(true);
    expect(metric.gpu).not.toBeNull();
    expect(metric.gpu).not.toMatch(/swiftshader|llvmpipe|lavapipe|warp|basic render/i);
    expect(metric.dock).toBe(140);
    expect(metric.rows).toBe(3);
    expect(metric.chart.backing).toEqual([
        Math.round(metric.chart.w * metric.dpr),
        Math.round(metric.chart.h * metric.dpr),
    ]);
    expect(metric.fits.find((item) => item.lane === "force")?.base).toBe(1);
    expect(metric.fits.find((item) => item.lane === "geo")?.base).toBe(0);
    expect(metric.fits.find((item) => item.lane === "velocity")?.base).toBe(10);
    await assertRetiredSurfaces(page);
    await page.screenshot({ path: join(OUT, "S3j-layout.png") });
    await page.waitForTimeout(SHOT_MS);
});

test("S3j lane value axis — target lifecycle", async ({ page, boot }) => {
    await boot();
    await pause(page);
    await selectAt(page, "force", 30);
    const opening = await snapshot(page);
    const parkedAt = await kexCall(page, "cartArc");
    const restingHi = (
        JSON.parse((await page.locator(".chart").getAttribute("data-value-windows"))!) as {
            lane: string;
            hi: number;
        }[]
    ).find((item) => item.lane === "force")!.hi;
    const knot = await valuePoint(page, "force", 30);
    await page.mouse.move(knot.x, knot.y);
    await page.mouse.down();
    await page.mouse.move(knot.x, knot.y - 18, { steps: 6 });
    await expect(page.locator(".drag-value-label")).toBeVisible();
    await expect(page.locator(".kex-overlay")).toHaveAttribute("data-dragging", "");
    expect(await kexCall(page, "save")).not.toBe(opening.save);
    expect(await kexCall(page, "undoDepth")).toBe(opening.undo);
    expect(await kexCall(page, "cartArc")).toBeCloseTo(parkedAt!, 5);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect.poll(() => kexCall(page, "save")).toBe(opening.save);
    expect(await kexCall(page, "undoDepth")).toBe(opening.undo);
    await expect(page.locator(".drag-value-label")).toHaveCount(0);
    await expect
        .poll(async () => {
            const fit = (
                JSON.parse((await page.locator(".chart").getAttribute("data-value-windows"))!) as {
                    lane: string;
                    hi: number;
                }[]
            ).find((item) => item.lane === "force")!;
            return Math.abs(fit.hi - restingHi);
        })
        .toBeLessThan(0.01);

    const beforeCommit = await snapshot(page);
    const committed = await valuePoint(page, "force", 30);
    await page.mouse.move(committed.x, committed.y);
    await page.mouse.down();
    await page.mouse.move(committed.x + 1, committed.y - 23, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => kexCall(page, "undoDepth")).toBe(beforeCommit.undo + 1);
    const changed = await kexCall(page, "save");
    expect(changed).not.toBe(beforeCommit.save);
    const exit = JSON.parse(changed).lanes.force.find(
        (item: { id: number }) => item.id === committed.id,
    ).exit;
    expect(Math.round(exit * 10) / 10).toBeCloseTo(exit, 9);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => kexCall(page, "save")).toBe(beforeCommit.save);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expect.poll(() => kexCall(page, "save")).toBe(changed);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => kexCall(page, "save")).toBe(beforeCommit.save);

    const freeStart = await valuePoint(page, "force", 30);
    await page.mouse.move(freeStart.x, freeStart.y);
    await page.mouse.down();
    await page.keyboard.down("ControlOrMeta");
    await page.mouse.move(freeStart.x + 1, freeStart.y - 17, { steps: 6 });
    await page.keyboard.up("ControlOrMeta");
    await page.mouse.up();
    const freeExit = JSON.parse(await kexCall(page, "save")).lanes.force.find(
        (item: { id: number }) => item.id === freeStart.id,
    ).exit;
    expect(Number.isFinite(freeExit)).toBe(true);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => kexCall(page, "save")).toBe(beforeCommit.save);
    await page.screenshot({ path: join(OUT, "S3j-target-value-drag.png") });
    await page.waitForTimeout(SHOT_MS);
});

test("S3j lane value axis — station lifecycle", async ({ page, boot }) => {
    await boot();
    await pause(page);
    const doc = JSON.parse(await kexCall(page, "save"));
    doc.lanes.force = [
        { id: 1, start: 0, end: 10, ease: 0, entry: 1, exit: 1.2 },
        { id: 3, start: 10, end: 20, ease: 2, entry: 1.4, exit: 1 },
        { id: 4, start: 23, end: 28, ease: 1, exit: 1 },
    ];
    doc.lanes.geo = [{ id: 0, start: 8, end: 17, ease: 0, entry: 0, exit: 0 }];
    doc.track.end = 30;
    await loadDocument(page, doc);
    const opening = await snapshot(page);
    const shared = await point(page, "force", 10);
    await page.mouse.click(shared.x, shared.y + 7);

    await expect(page.locator("#pf-end")).toBeFocused();
    await expect(page.locator("#pf-end")).toHaveValue("10.00");
    await page.locator(".dock").focus();
    await page.getByRole("checkbox", { name: "Ripple later segments in this lane" }).check();
    await page.locator("#pf-end").fill("12");
    await page.locator("#pf-end").press("Enter");
    await expect.poll(() => kexCall(page, "undoDepth")).toBe(opening.undo + 1);
    expect((await kexCall(page, "lanes")).force.map((item) => [item.start, item.end])).toEqual([
        [0, 12],
        [12, 22],
        [25, 30],
    ]);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => kexCall(page, "save")).toBe(opening.save);
    await loadDocument(page, JSON.parse(opening.save));
    const resetShared = await point(page, "force", 10);
    await page.mouse.click(resetShared.x, resetShared.y + 7);
    await expect(page.locator("#pf-end")).toBeFocused();
    await page.locator("#pf-end").press("Escape");
    expect(await snapshot(page)).toEqual(opening);
    await assertRetiredSurfaces(page);
    await page.screenshot({ path: join(OUT, "S3j-station-lifecycle.png") });
    await page.waitForTimeout(SHOT_MS);
});

test("S3j recovered lane twin — selected curve, knot field, and retirement", async ({
    page,
    boot,
}) => {
    await boot();
    await pause(page);
    const selected = await selectAt(page, "force", 30);
    const chart = page.locator(".chart");
    const fits = JSON.parse((await chart.getAttribute("data-value-windows"))!) as {
        lane: string;
        lo: number;
        hi: number;
    }[];
    const force = fits.find((item) => item.lane === "force")!;
    expect(force.lo).toBeLessThanOrEqual(1);
    expect(force.hi).toBeGreaterThanOrEqual(1);
    const knot = await valuePoint(page, "force", 30);
    await page.mouse.click(knot.x, knot.y);
    await expect(page.locator("#pf-exit")).toBeFocused();
    await expect(page.locator(".drag-value-label")).toHaveCount(0);
    await page.locator("#pf-exit").press("Escape");
    expect(await selectedIds(page)).toContain(selected.id);
    await assertRetiredSurfaces(page);
    await page.screenshot({ path: join(OUT, "S3j-recovered-twin.png") });
    await page.waitForTimeout(SHOT_MS);
});

test("S3f tools — Select gap versus Add, local keys, collision and cancellation", async ({
    page,
    boot,
}) => {
    await boot();
    await pause(page);
    const opening = await snapshot(page);
    const gap = await point(page, "geo", 30);
    await page.mouse.click(gap.x, gap.y);
    await page.keyboard.press("a");
    await expect(
        page.getByRole("button", { name: "Add Segment (A)", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    const start = await point(page, "geo", 30),
        end = await point(page, "geo", 38);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => kexCall(page, "undoDepth")).toBe(opening.undo + 1);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => kexCall(page, "save")).toBe(opening.save);
    await page.getByRole("button", { name: "Add Segment (A)", exact: true }).click();
    const a = await point(page, "geo", 25),
        b = await point(page, "geo", 15);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 4 });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    expect(await snapshot(page)).toEqual(opening);
    await expect(page.getByRole("button", { name: "Select (V)", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
    );
    await page.screenshot({ path: join(OUT, "S3f-tools.png") });
});

test("S3f renderer — lane × selection × driving × edge handle ink above hatch", async ({
    page,
    boot,
}) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await boot();
    await pause(page);
    const base = JSON.parse(await kexCall(page, "save"));
    for (const lane of ["geo", "force", "velocity"]) {
        const doc = structuredClone(base);
        doc.lanes = {
            geo: [{ id: 0, start: 0, end: 10, ease: 0, entry: 0, exit: 0 }],
            force: [{ id: 1, start: 0, end: 10, ease: 0, entry: 1, exit: 1 }],
            velocity: [{ id: 2, start: 0, end: 10, ease: 0, entry: 16, exit: 16 }],
        };
        await loadDocument(page, doc);
        const gap = await point(page, lane, 20);
        await page.mouse.click(gap.x, gap.y);
        const edge = await point(page, lane, 10);
        await page.mouse.move(edge.x - 1, edge.y + 7);
        await expect(page.locator(".chart")).toHaveCSS("cursor", "ew-resize");
        await page.screenshot({ path: join(OUT, `S3f-${lane}-edge.png`) });
    }
    await page.waitForTimeout(SHOT_MS);
});

test("S3f selection and body — Shift highlights only, one pressed subject, all lanes", async ({
    page,
    boot,
}) => {
    await boot();
    await pause(page);
    const opening = await snapshot(page);
    const geo = await point(page, "geo", 10);
    const velocity = await point(page, "velocity", 9);
    await page.mouse.click(geo.x, geo.y);
    await page.keyboard.down("Shift");
    await page.mouse.click(velocity.x, velocity.y);
    await page.keyboard.up("Shift");
    await expect.poll(() => selectedIds(page)).toEqual([0, 2]);
    await expect(page.locator(".popover")).toHaveCount(0);
    expect(await snapshot(page)).toEqual(opening);
    await page.screenshot({ path: join(OUT, "S3f-selection-body.png") });
});
