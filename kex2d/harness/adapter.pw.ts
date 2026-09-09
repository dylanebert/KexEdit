import { expect, test, kexCall, type Page, OUT, SHOT_MS, join } from "./flow";

async function selectAt(page: Page, lane: string, station: number) {
    const p = await point(page, lane, station);
    await page.mouse.click(p.x, p.y);
    const record = (await kexCall(page, "lanes"))[lane as "geo" | "force" | "velocity"].find(
        (r) => r.start <= station && r.end > station,
    )!;
    await expect(page.locator(".popover")).toHaveAttribute("data-record", String(record.id));
    await expect(page.locator("#pf-exit")).toBeVisible();
    return p;
}
async function expectedReading(page: Page, lane: string, s: number) {
    return page.evaluate(
        async ({ lane, s }) => {
            const path = "/src/track.ts",
                t = await import(path);
            const eid = (window as unknown as { __kex: { track: number } }).__kex.track;
            const out = t.bakeOut.get(eid),
                sm = t.samples.get(eid),
                n = t.Track.count.get(eid);
            const stations = [0];
            for (let i = 1; i < n; i++) stations.push(stations[i - 1]! + out.ds[i - 1]);
            let i = 0;
            while (i + 1 < n && stations[i + 1]! <= s) i++;
            const column = lane === "force" ? out.fN : lane === "geo" ? sm.theta : out.v;
            const alpha = i + 1 < n ? (s - stations[i]!) / (stations[i + 1]! - stations[i]!) : 0;
            const value =
                lane === "force" || i + 1 === n
                    ? column[i]
                    : column[i] + (column[i + 1] - column[i]) * alpha;
            return `≈ ${(value * (lane === "geo" ? 180 / Math.PI : 1)).toFixed(lane === "geo" ? 1 : 2)} ${lane === "geo" ? "°" : lane === "force" ? "g" : "m/s"}`;
        },
        { lane, s },
    );
}
async function inspectAt(page: Page, lane: string, s: number) {
    await page.locator(".chart").evaluate((el) =>
        el.addEventListener(
            "contextmenu",
            (event) => {
                const v = JSON.parse((el as HTMLCanvasElement).dataset.view!);
                (window as unknown as { __inspectionStation: number }).__inspectionStation =
                    ((event as MouseEvent).clientX - el.getBoundingClientRect().left - 76 + v.pan) /
                    v.pxPerU;
            },
            { once: true },
        ),
    );
    const p = await point(page, lane, s);
    await page.mouse.click(p.x, p.y, { button: "right" });
    await page.getByRole("menuitem", { name: "Inspect result", exact: true }).click();
    await expect(page.locator(".result")).toBeVisible();
    return page.evaluate(
        () => (window as unknown as { __inspectionStation: number }).__inspectionStation,
    );
}
async function openAction(page: Page, name: string) {
    await page.getByRole("button", { name: "Segment actions", exact: true }).click();
    await page.getByRole("menuitem", { name, exact: true }).click();
}

test("S3i hierarchy — layout", async ({ browser }) => {
    const logical = new Map<number, unknown>();
    let cases = 0;
    for (const width of [1280, 800])
        for (const deviceScaleFactor of [1, 2]) {
            const context = await browser.newContext({
                viewport: { width, height: width === 1280 ? 720 : 600 },
                deviceScaleFactor,
            });
            const page = await context.newPage();
            const errors: string[] = [];
            page.on("pageerror", (e) => errors.push(e.message));
            try {
                await page.goto(`http://localhost:${process.env.KEX_PORT ?? 3014}/`);
                await expect(page.locator(".dock")).toBeVisible();
                await page.evaluate(() => document.fonts.ready);
                await pause(page);
                const metric = await page.evaluate(async () => {
                    const box = (s: string) => {
                        const el = document.querySelector(s)!,
                            r = el.getBoundingClientRect();
                        return { x: r.x, y: r.y, w: r.width, h: r.height };
                    };
                    const c = document.querySelector<HTMLCanvasElement>(".chart")!;
                    const tx = c.getContext("2d")!.getTransform();
                    const adapter = await (
                        navigator as unknown as { gpu: GPU }
                    ).gpu.requestAdapter();
                    return {
                        viewport: box(".viewport"),
                        player: box(".player"),
                        dock: box(".dock"),
                        strip: box(".tool-strip"),
                        chart: box(".chart"),
                        button: box(".tool-strip button"),
                        glyph: box(".tool-strip svg"),
                        rightBand: c
                            .getContext("2d")!
                            .getImageData(c.width - 3, Math.round(45 * devicePixelRatio), 1, 1)
                            .data[3],
                        backing: [c.width, c.height],
                        tx: [tx.a, tx.d],
                        dpr: devicePixelRatio,
                        rows: JSON.parse(c.dataset.rows!).length,
                        top: window === top,
                        gpu: adapter ? `${adapter.info.vendor}/${adapter.info.architecture}` : null,
                    };
                });
                console.log(
                    "S3i controlled layout",
                    JSON.stringify({ width, deviceScaleFactor, metric }),
                );
                expect(metric.top).toBe(true);
                expect(metric.gpu).not.toBeNull();
                expect(metric.gpu).not.toMatch(/swiftshader|llvmpipe|lavapipe|warp|basic render/i);
                expect
                    .soft(
                        Math.abs(
                            metric.player.x +
                                metric.player.w / 2 -
                                metric.viewport.x -
                                metric.viewport.w / 2,
                        ),
                    )
                    .toBeLessThanOrEqual(1);
                expect(metric.backing).toEqual([
                    Math.round(metric.chart.w * deviceScaleFactor),
                    Math.round(metric.chart.h * deviceScaleFactor),
                ]);
                expect(metric.tx).toEqual([deviceScaleFactor, deviceScaleFactor]);
                expect(metric.dock.h).toBe(140);
                expect(metric.strip.w).toBe(36);
                expect([metric.button.w, metric.button.h, metric.glyph.w, metric.glyph.h]).toEqual([
                    28, 28, 14, 14,
                ]);
                expect(metric.rows).toBe(3);
                expect(
                    metric.rightBand,
                    "no reserved telemetry strip in the rendered row",
                ).toBeGreaterThan(0);
                await expect(page.locator(".tool-strip button")).toHaveCount(2);
                await expect(page.locator(".popover, .read-station, .recovered")).toHaveCount(0);
                const css = {
                    ...metric,
                    backing: undefined,
                    tx: undefined,
                    dpr: undefined,
                    gpu: undefined,
                };
                if (deviceScaleFactor === 1) logical.set(width, css);
                else expect(css).toEqual(logical.get(width));
                const select = page.getByRole("button", { name: "Select (V)", exact: true });
                for (const mode of ["active", "hover", "focus"]) {
                    if (mode === "hover") await select.hover();
                    if (mode === "focus") await select.focus();
                    const style = await select.evaluate((el) => {
                        const s = getComputedStyle(el);
                        const probe = document.createElement("span");
                        probe.style.color = "var(--accent)";
                        el.append(probe);
                        const accent = getComputedStyle(probe).color;
                        probe.remove();
                        return {
                            color: s.color,
                            border: s.borderColor,
                            shadow: s.boxShadow,
                            outline: s.outlineColor,
                            accent,
                        };
                    });
                    expect(style.color).not.toBe(style.accent);
                    expect(style.border).not.toBe(style.accent);
                    expect(style.shadow).toBe("none");
                    if (mode === "focus") expect(style.outline).not.toBe(style.accent);
                }
                const positions: number[] = [];
                for (const station of [19, 48]) {
                    const p = await selectAt(page, "force", station);
                    await expect
                        .poll(async () => {
                            const r = (await page.locator(".popover").boundingBox())!;
                            return Math.abs(r.x + r.width / 2 - p.x);
                        })
                        .toBeLessThan(1);
                    const box = (await page.locator(".popover").boundingBox())!;
                    expect(box.y + box.height).toBeCloseTo(p.y - 13 - 8, 4);
                    positions.push(box.x);
                    await expect(page.locator(".popover .field")).toHaveCount(1);
                    await expect(
                        page.locator(".head, .quantity, .disclosure, .ease-control"),
                    ).toHaveCount(0);
                }
                expect(positions[1]! - positions[0]!).toBeGreaterThan(100);
                for (const lane of ["geo", "velocity"]) {
                    await selectAt(page, lane, 9);
                    await openAction(page, "Start…");
                    const field = page.locator("#pf-start");
                    await expect(field).toBeFocused();
                    await field.fill("-123456789");
                    await expect(page.getByRole("status")).not.toBeEmpty();
                    const r = (await page.locator(".popover").boundingBox())!;
                    expect(r.x).toBeGreaterThanOrEqual(8);
                    expect(r.y).toBeGreaterThanOrEqual(8);
                    expect(r.x + r.width).toBeLessThanOrEqual(width - 8);
                    expect(r.y + r.height).toBeLessThanOrEqual((width === 1280 ? 720 : 600) - 8);
                    expect(
                        await page
                            .getByRole("status")
                            .evaluate((el) => el.scrollHeight <= el.clientHeight),
                    ).toBe(true);
                    await field.press("Escape");
                }
                await page.screenshot({
                    path: join(OUT, `S3i-${width}-dpr${deviceScaleFactor}.png`),
                });
                expect(errors).toEqual([]);
                cases++;
            } finally {
                await context.close();
            }
        }
    expect(cases).toBe(4);
});

test("S3i hierarchy — target lifecycle", async ({ page, boot }) => {
    await observeLifetimes(page);
    await boot();
    await pause(page);
    for (const lane of ["geo", "force", "velocity"] as const) {
        await selectAt(page, lane, lane === "force" ? 30 : 9);
        const opening = await snapshot(page),
            park = await kexCall(page, "cartArc"),
            time = await kexCall(page, "tTotal");
        const panel = page.locator(".popover"),
            field = page.locator("#pf-exit");
        await expect(panel.locator(".unit")).toHaveText(
            lane === "geo" ? "°" : lane === "force" ? "g" : "m/s",
        );
        await field.focus();
        const box = (await panel.boundingBox())!;
        await field.fill(
            lane === "geo" ? "12.123456789" : lane === "force" ? "1.23456789" : "26.123456789",
        );
        expect(await kexCall(page, "save")).not.toBe(opening.save);
        expect(await kexCall(page, "undoDepth")).toBe(opening.undo);
        await expect.poll(() => kexCall(page, "tTotal")).not.toBe(time);
        expect((await panel.boundingBox())!.x).toBe(box.x);
        expect((await panel.boundingBox())!.y).toBe(box.y);
        expect(await kexCall(page, "cartArc")).toBeCloseTo(park!, 5);
        await field.press("Enter");
        const changed = await kexCall(page, "save");
        expect(JSON.parse(changed).lanes[lane][0].entry).toBe(
            JSON.parse(opening.save).lanes[lane][0].entry,
        );
        expect(await kexCall(page, "undoDepth")).toBe(opening.undo + 1);
        await page.keyboard.press("ControlOrMeta+z");
        await expect.poll(() => kexCall(page, "save")).toBe(opening.save);
        await page.keyboard.press("ControlOrMeta+Shift+z");
        await expect.poll(() => kexCall(page, "save")).toBe(changed);
        await page.keyboard.press("ControlOrMeta+z");
        await expect.poll(() => kexCall(page, "save")).toBe(opening.save);
        const label = (await page.locator('label[for="pf-exit"]').boundingBox())!;
        await page.mouse.move(label.x + 10, label.y + 10);
        await page.mouse.down();
        await page.mouse.move(label.x + 18, label.y + 10, { steps: 4 });
        expect(await kexCall(page, "save")).not.toBe(opening.save);
        await page.keyboard.press("Escape");
        await page.mouse.up();
        await expect.poll(() => kexCall(page, "save")).toBe(opening.save);
        await field.focus();
        await field.fill("");
        await expect(page.getByRole("status")).toHaveText("Enter a finite number");
        for (const key of ["a", "v", "s", "Space", "ArrowLeft", "Delete"]) await field.press(key);
        await field.press("Escape");
        expect(await snapshot(page)).toEqual(opening);
    }
    const base = await kexCall(page, "save");
    for (const [index, reason] of [
        "blur",
        "pointercancel",
        "delete",
        "unmount",
        "layout",
    ].entries()) {
        await kexCall(page, "load", base);
        await showTimeline(page, false);
        const hidden = (await life(page)).listeners;
        await showTimeline(page, true);
        await expect
            .poll(
                async () =>
                    JSON.parse((await page.locator(".chart").getAttribute("data-view"))!).pxPerU,
            )
            .toBeGreaterThan(0);
        const gap = await point(page, "geo", 65);
        await page.mouse.click(gap.x, gap.y);
        await pause(page);
        const lane = (["geo", "force", "velocity"] as const)[index % 3]!;
        await selectAt(page, lane, lane === "force" ? 30 : 9);
        const mounted = (await life(page)).listeners;
        const opening = await snapshot(page);
        const playing = index % 2 === 1;
        if (playing) await page.getByRole("button", { name: "Play", exact: true }).click();
        await resetLife(page);
        const label = (await page.locator('label[for="pf-exit"]').boundingBox())!;
        await page.mouse.move(label.x + 10, label.y + 10);
        await page.mouse.down();
        await page.mouse.move(label.x + 18, label.y + 10, { steps: 4 });
        await expect.poll(() => kexCall(page, "save")).not.toBe(opening.save);
        await expect(page.locator("#app")).toHaveAttribute("data-dragging", "");
        expect((await life(page)).active).toBe(true);
        if (reason === "unmount") await showTimeline(page, false);
        else if (reason === "delete") {
            const id = (await kexCall(page, "lanes"))[lane][0]!.id;
            await page.evaluate(
                (id) =>
                    (
                        window as unknown as { __kex: { removeRecord(id: number): void } }
                    ).__kex.removeRecord(id),
                id,
            );
        } else if (reason === "layout") {
            const panel = (await page.locator(".popover").boundingBox())!;
            const p = await point(page, lane, lane === "force" ? 30 : 9);
            await page.locator(".dock").evaluate(
                (el, shift) => {
                    (el as HTMLElement).style.bottom = `${16 + shift}px`;
                },
                p.y - panel.y - panel.height / 2,
            );
        } else
            await page.evaluate(
                (reason) =>
                    window.dispatchEvent(
                        reason === "blur"
                            ? new Event("blur")
                            : new PointerEvent("pointercancel", { pointerId: 1 }),
                    ),
                reason,
            );
        await expect(page.locator("#app")).not.toHaveAttribute("data-dragging");
        await expect.poll(() => kexCall(page, "parked")).toBe(!playing);
        await expect.poll(async () => (await life(page)).active).toBe(false);
        const after = await life(page);
        expect(after.heldWrites).toEqual(playing ? [true, false] : []);
        expect(after.sets, reason).toBe(1);
        expect(after.releases, reason).toBeLessThanOrEqual(1);
        if (reason === "layout" || reason === "blur") expect(after.releases, reason).toBe(1);
        if (reason === "unmount") expect(after.listeners).toEqual(hidden);
        else if (reason !== "delete") expect(after.listeners).toEqual(mounted);
        if (reason === "delete") {
            const expected = JSON.parse(opening.save);
            expected.lanes[lane] = [];
            expect(JSON.parse(await kexCall(page, "save"))).toEqual(expected);
            expect(await kexCall(page, "undoDepth")).toBe(opening.undo + 1);
        } else expect(await snapshot(page)).toEqual(opening);
        const settled = await snapshot(page);
        await page.mouse.up();
        await page.evaluate(() => window.dispatchEvent(new Event("blur")));
        expect(await snapshot(page)).toEqual(settled);
        expect((await life(page)).heldWrites).toEqual(after.heldWrites);
        if (reason === "unmount") await showTimeline(page, true);
        if (reason === "layout")
            await page.locator(".dock").evaluate((el) => {
                (el as HTMLElement).style.bottom = "16px";
            });
    }
});

test("S3i hierarchy — station lifecycle", async ({ page, boot }) => {
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
    await kexCall(page, "load", JSON.stringify(doc));
    await expect
        .poll(
            async () =>
                JSON.parse((await page.locator(".chart").getAttribute("data-rows"))!).find(
                    (r: { lane: string }) => r.lane === "force",
                ).records.length,
        )
        .toBe(3);
    const opening = await snapshot(page);
    const shared = await point(page, "force", 10);
    await page.mouse.move(shared.x, shared.y);
    await expect(page.locator(".chart")).toHaveCSS("cursor", "ew-resize");
    await page.mouse.click(shared.x, shared.y);
    await expect(page.locator("#pf-end")).toBeFocused();
    await expect(page.locator("#pf-end")).toHaveValue("10.00");
    expect(await snapshot(page)).toEqual(opening);
    await page.locator("#pf-end").press("Escape");
    await selectAt(page, "force", 5);
    await openAction(page, "End…");
    const field = page.locator("#pf-end");
    await expect(field).toBeFocused();
    await expect(page.locator(".field")).toHaveCount(1);
    await expect(page.locator("#pf-exit, #pf-start")).toHaveCount(0);
    await field.fill("9");
    await field.press("Escape");
    expect(await snapshot(page)).toEqual(opening);
    await openAction(page, "End…");
    await page.locator(".dock").focus();
    const ripple = page.getByRole("checkbox", { name: "Ripple later segments in this lane" });
    await expect(ripple).not.toBeChecked();
    await ripple.focus();
    await ripple.press("Space");
    await expect(ripple).toBeChecked();
    await field.focus();
    await field.fill("12");
    await expect(ripple).toBeDisabled();
    expect((await kexCall(page, "lanes")).force.map((r) => [r.start, r.end])).toEqual([
        [0, 12],
        [12, 22],
        [25, 30],
    ]);
    const lastValid = await kexCall(page, "save");
    await field.fill("13");
    await expect(page.getByRole("status")).toContainText(/pin/i);
    expect(await kexCall(page, "save")).toBe(lastValid);
    await field.press("Escape");
    expect(await snapshot(page)).toEqual(opening);
    await openAction(page, "End…");
    await field.fill("12");
    await field.press("Enter");
    expect(await kexCall(page, "undoDepth")).toBe(opening.undo + 1);
    expect((await kexCall(page, "lanes")).geo).toEqual(doc.lanes.geo);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => kexCall(page, "save")).toBe(opening.save);
    await openAction(page, "Start…");
    await page.locator(".dock").focus();
    const label = (await page.locator('label[for="pf-start"]').boundingBox())!;
    const box = (await page.locator(".popover").boundingBox())!;
    await page.mouse.move(label.x + 10, label.y + 10);
    await page.mouse.down();
    await page.mouse.move(label.x + 18, label.y + 10, { steps: 4 });
    expect((await kexCall(page, "lanes")).force.map((r) => [r.start, r.end])).toEqual([
        [2, 10],
        [10, 20],
        [23, 28],
    ]);
    expect((await page.locator(".popover").boundingBox())!.x).toBe(box.x);
    expect((await page.locator(".popover").boundingBox())!.y).toBe(box.y);
    await page
        .locator(".chart")
        .dispatchEvent("contextmenu", { clientX: shared.x, clientY: shared.y });
    await expect(page.locator(".menu-anchor")).toHaveCount(0);
    await page.evaluate(() =>
        window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 })),
    );
    await page.mouse.up();
    expect(await snapshot(page)).toEqual(opening);
    doc.lanes.force = [
        { id: 1, start: 0, end: 0.6, ease: 0, entry: 1, exit: 1 },
        { id: 3, start: 0.6, end: 1.2, ease: 0, entry: 1, exit: 1 },
    ];
    await kexCall(page, "load", JSON.stringify(doc));
    await expect
        .poll(
            async () =>
                JSON.parse((await page.locator(".chart").getAttribute("data-rows"))!).find(
                    (r: { lane: string }) => r.lane === "force",
                ).records[0].end,
        )
        .toBe(0.6);
    const narrow = await snapshot(page);
    for (const which of ["start", "end"] as const) {
        const p = await point(page, "force", which === "start" ? 0 : 0.6);
        await page.mouse.move(p.x + (which === "start" ? 1 : -1), p.y);
        await expect(page.locator(".chart")).toHaveCSS("cursor", "ew-resize");
        await page.mouse.click(p.x + (which === "start" ? 1 : -1), p.y);
        await expect(page.locator(`#pf-${which}`)).toBeFocused();
        await expect(page.locator(`#pf-${which}`)).toHaveValue(which === "start" ? "0.00" : "0.60");
        await page.locator(`#pf-${which}`).press("Escape");
        expect(await snapshot(page)).toEqual(narrow);
    }
});

test("S3i hierarchy — contextual actions", async ({ page, boot }) => {
    await boot();
    await pause(page);
    for (const lane of ["geo", "force", "velocity"] as const) {
        const p = await selectAt(page, lane, lane === "force" ? 30 : 9);
        const opening = await snapshot(page);
        const button = page.getByRole("button", { name: "Segment actions", exact: true });
        await button.focus();
        await expect(button).toBeVisible();
        const invoker = (await button.boundingBox())!;
        await button.press("Enter");
        const root = page.locator(".menu-anchor.menu");
        await expect(root).toHaveCSS("overflow", "visible");
        const menuBox = (await root.boundingBox())!;
        expect(
            menuBox.y + menuBox.height <= invoker.y - 8 ||
                menuBox.y >= invoker.y + invoker.height + 8,
        ).toBe(true);
        await expect(root).toHaveCSS("border-top-width", "1px");
        expect(await root.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(
            "rgba(0, 0, 0, 0)",
        );
        await expect(root.locator(":scope > .menu-rows > .menu-item").last()).toHaveClass(/danger/);
        await expect(root.locator(".sk")).toHaveText("Del");
        const labels = await page
            .locator(".menu-anchor > .menu-rows > .menu-item")
            .allTextContents();
        await page.keyboard.press("Escape");
        await page.mouse.click(p.x, p.y, { button: "right" });
        expect(
            await page.locator(".menu-anchor > .menu-rows > .menu-item").allTextContents(),
        ).toEqual(labels);
        await page.getByRole("menuitem", { name: "Easing", exact: true }).hover();
        const flyout = (await page.locator(".menu-anchor .submenu").boundingBox())!;
        const viewport = page.viewportSize()!;
        expect(flyout.x).toBeGreaterThanOrEqual(0);
        expect(flyout.y).toBeGreaterThanOrEqual(0);
        expect(flyout.x + flyout.width).toBeLessThanOrEqual(viewport.width);
        expect(flyout.y + flyout.height).toBeLessThanOrEqual(viewport.height);
        await expect(
            page.getByRole("menuitem", { name: "Quintic", exact: true }).locator("path"),
        ).toHaveAttribute("d", /^M/);
        await page.getByRole("menuitem", { name: "Quintic", exact: true }).click();
        expect((await kexCall(page, "lanes"))[lane][0]!.ease).toBe(2);
        expect(await kexCall(page, "undoDepth")).toBe(opening.undo + 1);
        await page.keyboard.press("ControlOrMeta+z");
        await expect.poll(() => kexCall(page, "save")).toBe(opening.save);
        await button.click();
        await page.getByRole("menuitem", { name: "Entry", exact: true }).hover();
        await page.getByRole("menuitem", { name: "Inherit entry", exact: true }).click();
        const inherited = await snapshot(page);
        expect(JSON.parse(inherited.save).lanes[lane][0].entry).toBeUndefined();
        if (lane === "velocity")
            await expect(page.getByRole("status")).toContainText("prescription unavailable");
        await button.click();
        await page.getByRole("menuitem", { name: "Entry", exact: true }).hover();
        await page.getByRole("menuitem", { name: "Override entry…", exact: true }).click();
        const entry = page.locator("#pf-entry");
        await expect(entry).toBeFocused();
        if (lane !== "force") await expect(entry).toHaveValue("");
        expect(await snapshot(page)).toEqual(inherited);
        await entry.fill("");
        await entry.press("Enter");
        await expect(page.getByRole("status")).toContainText("Enter a finite number");
        await entry.fill("1.23456789");
        await entry.press("Enter");
        expect(await kexCall(page, "undoDepth")).toBe(inherited.undo + 1);
        await page.keyboard.press("ControlOrMeta+z");
        await expect.poll(() => kexCall(page, "save")).toBe(inherited.save);
        await page.keyboard.press("ControlOrMeta+z");
        await expect.poll(() => kexCall(page, "save")).toBe(opening.save);
        await openAction(page, "Inspect result");
        await expect(page.locator(".result")).toContainText(
            lane === "force"
                ? "Recovered unavailable g"
                : `Recovered ${await expectedReading(page, lane, 5)}`,
        );
        await expect(page.locator(".field")).toHaveCount(0);
        expect(await snapshot(page)).toEqual(opening);
        await page.keyboard.press("Escape");
        await expect(page.locator("#pf-exit")).toBeVisible();
        const station = lane === "force" ? 30 : 9;
        const at = await inspectAt(page, lane, station);
        await expect(page.locator(".result")).toContainText(
            `Recovered ${await expectedReading(page, lane, at)} @ ${at.toFixed(2)} m`,
        );
        const frozen = await page.locator(".result").innerText();
        const moved = await point(page, lane, station + 2);
        await page.mouse.move(moved.x, moved.y);
        expect(await page.locator(".result").innerText()).toBe(frozen);
        // Remove the published input, not a reading callback; restore the exact reference.
        await page.evaluate(async () => {
            const path = "/src/track.ts",
                t = await import(path);
            const w = window as unknown as { __kex: { track: number }; __restoreReading(): void };
            const out = t.bakeOut.get(w.__kex.track);
            t.bakeOut.delete(w.__kex.track);
            w.__restoreReading = () => t.bakeOut.set(w.__kex.track, out);
        });
        try {
            await expect(page.locator(".result")).toContainText("Recovered unavailable");
        } finally {
            await page.evaluate(() =>
                (window as unknown as { __restoreReading(): void }).__restoreReading(),
            );
        }
        await expect(page.locator(".result")).toContainText(
            `Recovered ${await expectedReading(page, lane, at)}`,
        );
        expect(await snapshot(page)).toEqual(opening);
        await page.keyboard.press("Escape");
    }
    const opening = await snapshot(page);
    async function checkResidual(lane: "geo" | "force") {
        const expected = await page.evaluate(async (lane) => {
            const path = "/src/track.ts",
                t = await import(path);
            const w = window as unknown as { __kex: { track: number; save(): string } };
            const out = t.bakeOut.get(w.__kex.track),
                sm = t.samples.get(w.__kex.track),
                n = t.Track.count.get(w.__kex.track);
            const r = JSON.parse(w.__kex.save()).lanes[lane][0];
            let s = 0,
                worst = 0,
                at = 0,
                found = false;
            for (let i = 0; i < (lane === "force" ? n - 1 : n); i++) {
                if (i) s += out.ds[i - 1];
                if (s < r.start || s > r.end) continue;
                const u = (s - r.start) / (r.end - r.start),
                    f = lane === "force" ? u : u * u * (3 - 2 * u);
                const miss =
                    (lane === "force" ? out.fN[i] : sm.theta[i]) -
                    (r.entry + (r.exit - r.entry) * f);
                if (!found || Math.abs(miss) > Math.abs(worst)) {
                    found = true;
                    worst = miss;
                    at = s;
                }
            }
            return {
                found,
                value: (worst * (lane === "geo" ? 180 / Math.PI : 1)).toFixed(
                    lane === "geo" ? 1 : 2,
                ),
                at: at.toFixed(2),
            };
        }, lane);
        expect(expected.found).toBe(true);
        await expect(page.locator(".result")).toContainText(
            `≈ ${expected.value} ${lane === "force" ? "g" : "°"} recovered − demanded · worst sampled @ ${expected.at} m`,
        );
    }
    await inspectAt(page, "force", 30);
    await checkResidual("force");
    const force = await point(page, "force", 0),
        geo = await point(page, "geo", 0),
        chart = (await page.locator(".chart").boundingBox())!;
    await page.mouse.move(chart.x + 30, force.y);
    await page.mouse.down();
    await page.mouse.move(chart.x + 30, geo.y, { steps: 4 });
    await page.mouse.up();
    await expect
        .poll(async () => JSON.parse(await kexCall(page, "save")).track.order)
        .toEqual([1, 2, 0]);
    await inspectAt(page, "force", 30);
    await expect(page.locator(".result")).not.toContainText("worst sampled");
    await inspectAt(page, "geo", 9);
    await checkResidual("geo");
    expect(await kexCall(page, "undoDepth")).toBe(opening.undo + 1);
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => kexCall(page, "save")).toBe(opening.save);
    const turn = JSON.parse(opening.save);
    turn.lanes.geo[0].exit = 2 * Math.PI + 0.35;
    await kexCall(page, "load", JSON.stringify(turn));
    const at = await inspectAt(page, "geo", 19.123);
    await expect.poll(() => expectedReading(page, "geo", at)).toMatch(/≈ 3[6-9]\d\./);
    await expect(page.locator(".result")).toContainText(await expectedReading(page, "geo", at));
    await page.evaluate(async () => {
        const path = "/src/track.ts",
            t = await import(path);
        const w = window as unknown as { __kex: { track: number }; __restoreCount(): void };
        const n = t.Track.count.get(w.__kex.track);
        t.Track.count.set(w.__kex.track, 2);
        w.__restoreCount = () => t.Track.count.set(w.__kex.track, n);
    });
    try {
        await expect(page.locator(".result")).toContainText("Recovered unavailable");
    } finally {
        await page.evaluate(() =>
            (window as unknown as { __restoreCount(): void }).__restoreCount(),
        );
    }
    await expect(page.locator(".result")).toContainText(await expectedReading(page, "geo", at));
});

// Native resource observations, installed before application listeners attach. Calls are
// forwarded unchanged; no application handler or state transition is replaced.
type LifeReading = {
    listeners: Record<string, number>;
    sets: number;
    releases: number;
    active: boolean;
    heldWrites: boolean[];
};
async function observeLifetimes(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const types = new Set([
            "pointermove",
            "pointerup",
            "pointercancel",
            "pointerdown",
            "keydown",
            "blur",
            "resize",
        ]);
        const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
        const capture = (o?: boolean | AddEventListenerOptions): boolean =>
            typeof o === "boolean" ? o : !!o?.capture;
        const add = window.addEventListener.bind(window),
            remove = window.removeEventListener.bind(window);
        window.addEventListener = ((
            type: string,
            fn: EventListenerOrEventListenerObject,
            options?: boolean | AddEventListenerOptions,
        ) => {
            if (types.has(type)) {
                const key = `${type}/${capture(options)}`;
                const set = listeners.get(key) ?? new Set();
                set.add(fn);
                listeners.set(key, set);
            }
            add(type, fn, options);
        }) as typeof window.addEventListener;
        window.removeEventListener = ((
            type: string,
            fn: EventListenerOrEventListenerObject,
            options?: boolean | EventListenerOptions,
        ) => {
            listeners.get(`${type}/${capture(options)}`)?.delete(fn);
            remove(type, fn, options);
        }) as typeof window.removeEventListener;
        const set = Element.prototype.setPointerCapture,
            release = Element.prototype.releasePointerCapture;
        let last: Element | null = null,
            pointer = 0,
            sets = 0,
            releases = 0;
        const heldWrites: boolean[] = [];
        Element.prototype.setPointerCapture = function (id) {
            set.call(this, id);
            last = this;
            pointer = id;
            sets++;
        };
        Element.prototype.releasePointerCapture = function (id) {
            release.call(this, id);
            releases++;
        };
        const probe = {
            heldWrites,
            reset: () => {
                sets = 0;
                releases = 0;
                last = null;
                heldWrites.length = 0;
            },
            read: () => ({
                listeners: Object.fromEntries(
                    [...listeners]
                        .filter(([, set]) => set.size)
                        .map(([key, set]) => [key, set.size])
                        .sort(),
                ),
                sets,
                releases,
                active: !!last?.hasPointerCapture(pointer),
                heldWrites: [...heldWrites],
            }),
        };
        (window as unknown as { __life: typeof probe }).__life = probe;
    });
}
async function life(page: Page): Promise<LifeReading> {
    return page.evaluate(() =>
        (window as unknown as { __life: { read(): LifeReading } }).__life.read(),
    );
}
async function resetLife(page: Page): Promise<void> {
    await page.evaluate(async () => {
        const w = window as unknown as {
            __kex: { track: number };
            __life: { reset(): void; heldWrites: boolean[] };
        };
        const path = "/src/cart.ts";
        const { cartState } = (await import(path)) as { cartState: Map<number, { held: boolean }> };
        const state = cartState.get(w.__kex.track)!;
        let held = state.held;
        Object.defineProperty(state, "held", {
            configurable: true,
            get: () => held,
            set: (value: boolean) => {
                w.__life.heldWrites.push(value);
                held = value;
            },
        });
        w.__life.reset();
    });
}
async function showTimeline(page: Page, value: boolean): Promise<void> {
    await page.evaluate(
        (value) =>
            (
                window as unknown as { __kex: { showTimeline(value: boolean): void } }
            ).__kex.showTimeline(value),
        value,
    );
    await expect(page.locator(".dock")).toHaveCount(value ? 1 : 0);
}

// Production geometry, not a second framing algorithm. The canvas publishes the affine
// and row boxes that its renderer consumes; authored effects are read through the live hook.
async function point(page: Page, lane: string, s: number) {
    return page.locator(".chart").evaluate(
        (node, { lane, s }) => {
            const el = node as HTMLCanvasElement,
                rect = el.getBoundingClientRect();
            const v = JSON.parse(el.dataset.view!) as { pan: number; pxPerU: number };
            const rows = JSON.parse(el.dataset.rows!) as {
                lane: string;
                top: number;
                height: number;
            }[];
            const row = rows.find((r) => r.lane === lane)!;
            return {
                x: rect.left + 76 + s * v.pxPerU - v.pan,
                y: rect.top + row.top + row.height / 2,
            };
        },
        { lane, s },
    );
}
async function drag(page: Page, lane: string, from: number, to: number) {
    const a = await point(page, lane, from),
        b = await point(page, lane, to);
    const rows = (await kexCall(page, "lanes"))[lane as "geo" | "force" | "velocity"];
    // Press inside the rendered 2px grip, not the fractional outside boundary.
    const inset = rows.some((r) => r.end === from)
        ? -1
        : rows.some((r) => r.start === from)
          ? 1
          : 0;
    await page.mouse.move(a.x + inset, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 6 });
    await page.mouse.up();
}
async function pause(page: Page) {
    const button = page.getByRole("button", { name: "Pause", exact: true });
    if (await button.count()) await button.click();
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
    // Bind a nonzero station through the real ruler; a timing-dependent parked landmark
    // otherwise legitimately wins snapping over the expected station grid.
    const p = await point(page, "geo", 5),
        box = (await page.locator(".chart").boundingBox())!;
    await page.mouse.click(p.x, box.y + 12);
    await expect.poll(() => kexCall(page, "cartArc")).toBeCloseTo(5, 4);
}
async function snapshot(page: Page) {
    return { save: await kexCall(page, "save"), undo: await kexCall(page, "undoDepth") };
}

test("S3f tools — Select gap versus Add, local keys, collision and cancellation", async ({
    page,
    boot,
}) => {
    await boot();
    await pause(page);
    const opening = await snapshot(page);
    await drag(page, "geo", 30, 38);
    expect(await snapshot(page)).toEqual(opening);
    // Canvas context has no A claim; timeline hover has the positive control.
    await page.mouse.click(500, 100);
    await page.keyboard.press("a");
    await expect(page.getByRole("button", { name: "Select (V)", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
    );
    const gap = await point(page, "geo", 30);
    await page.mouse.move(gap.x, gap.y);
    await page.keyboard.press("a");
    await expect(
        page.getByRole("button", { name: "Add Segment (A)", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await drag(page, "geo", 30, 38);
    await expect.poll(() => kexCall(page, "undoDepth")).toBe(opening.undo + 1);
    const made = (await kexCall(page, "lanes")).geo.find((r) => r.start === 30)!;
    expect(made.end).toBe(38);
    expect(made.ease).toBe(0);
    await expect(page.getByRole("button", { name: "Select (V)", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
    );
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => kexCall(page, "save")).toBe(opening.save);
    await page.getByRole("button", { name: "Add Segment (A)", exact: true }).click();
    await drag(page, "geo", 25, 15);
    expect(await snapshot(page)).toEqual(opening);
    await expect(page.getByRole("status")).toContainText("Overlaps");
    await expect(
        page.getByRole("button", { name: "Add Segment (A)", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    // Cancellation has a live preview upper rung and no authored intermediate row.
    const a = await point(page, "force", 60),
        b = await point(page, "velocity", 68);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y);
    expect(await snapshot(page)).toEqual(opening);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    expect(await snapshot(page)).toEqual(opening);
    await expect(page.getByRole("button", { name: "Select (V)", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
    );
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "S3f-tools.png") });
});

async function ink(page: Page, p: { x: number; y: number; body?: boolean }) {
    return page.locator(".chart").evaluate((node, p) => {
        const c = node as HTMLCanvasElement,
            r = c.getBoundingClientRect();
        const sx = c.width / r.width,
            sy = c.height / r.height;
        return Array.from(
            c
                .getContext("2d")!
                .getImageData(
                    Math.floor((p.x - r.left) * sx),
                    Math.floor((p.y - r.top - (p.body ? 0 : 16)) * sy),
                    1,
                    p.body ? 1 : Math.floor(22 * sy),
                ).data,
        );
    }, p);
}

test("S3f renderer — lane × selection × driving × edge handle ink above hatch", async ({
    page,
    boot,
}) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await boot();
    await pause(page);
    const base = JSON.parse(await kexCall(page, "save"));
    let cases = 0;
    const composites = new Map<string, { base: number[]; hot: number[]; active: number[] }>();
    for (const lane of ["geo", "force", "velocity"])
        for (const selected of [false, true])
            for (const driven of [false, true]) {
                // Velocity cannot be driven: drive priority excludes it (timeline.test.ts pins this).
                if (lane === "velocity" && driven) continue;
                const doc = structuredClone(base);
                doc.track.order =
                    (lane === "geo" && driven) || (lane === "force" && !driven)
                        ? [1, 2, 0]
                        : [2, 1, 0];
                doc.lanes = {
                    geo: [{ id: 0, start: 0, end: 10, ease: 0, entry: 0, exit: 0 }],
                    force: [{ id: 1, start: 0, end: 10, ease: 0, entry: 1, exit: 1 }],
                    velocity: [{ id: 2, start: 0, end: 10, ease: 0, entry: 16, exit: 16 }],
                };
                await kexCall(page, "load", JSON.stringify(doc));
                // Loading publishes ECS immediately; the renderer consumes it on its next tick.
                // Bind the complete row population, not only order (the first order can match
                // the old fixture while its affine still frames the old extent).
                await expect
                    .poll(async () => {
                        const rows = JSON.parse(
                            (await page.locator(".chart").getAttribute("data-rows"))!,
                        ) as {
                            lane: string;
                            records: { id: number; start: number; end: number }[];
                        }[];
                        return rows.map(({ lane, records }) => ({ lane, records }));
                    })
                    .toEqual(
                        doc.track.order.map((kind: number) => {
                            const lane = ["velocity", "force", "geo"][kind]!;
                            return {
                                lane,
                                records: doc.lanes[lane].map(
                                    ({
                                        id,
                                        start,
                                        end,
                                    }: {
                                        id: number;
                                        start: number;
                                        end: number;
                                    }) => ({ id, start, end }),
                                ),
                            };
                        }),
                    );
                const gap = await point(page, lane, 20);
                await page.mouse.click(gap.x, gap.y);
                if (selected) {
                    const p = await point(page, lane, 5);
                    await page.mouse.click(p.x, p.y);
                }
                for (const edge of ["start", "end"] as const) {
                    const p = await point(page, lane, edge === "start" ? 0 : 10);
                    const sample = { x: p.x + (edge === "start" ? 1 : -1), y: p.y + 5 };
                    await page.mouse.move(gap.x, gap.y);
                    const bodyPoint = { ...(await point(page, lane, 7)), body: true };
                    bodyPoint.y += 5; // off the flat curve and the bound 5m playhead
                    const bodyBefore = await ink(page, bodyPoint);
                    const before = await ink(page, sample);
                    await page.locator(".chart").screenshot({
                        path: join(OUT, `S3f-${lane}-${selected}-${driven}-${edge}-default.png`),
                    });
                    await page.mouse.move(sample.x, sample.y);
                    await expect(page.locator(".chart")).toHaveCSS("cursor", "ew-resize");
                    await expect.poll(() => ink(page, sample)).not.toEqual(before);
                    const hot = await ink(page, sample);
                    expect(
                        await ink(page, bodyPoint),
                        "handle hover must not recolor its body",
                    ).toEqual(bodyBefore);
                    await page.locator(".chart").screenshot({
                        path: join(OUT, `S3f-${lane}-${selected}-${driven}-${edge}-hover.png`),
                    });
                    await page.mouse.down();
                    await expect.poll(() => ink(page, sample)).not.toEqual(hot);
                    const active = await ink(page, sample);
                    expect(
                        await ink(page, bodyPoint),
                        "handle press must not recolor its body",
                    ).toEqual(bodyBefore);
                    await page.locator(".chart").screenshot({
                        path: join(OUT, `S3f-${lane}-${selected}-${driven}-${edge}-active.png`),
                    });
                    const key = `${lane}/${selected}/${edge}`;
                    const composite = { base: before, hot, active };
                    if (driven)
                        expect(composite, `hatch must not alter handle ink: ${key}`).toEqual(
                            composites.get(key),
                        );
                    else composites.set(key, composite);
                    // An active drag selects its pressed subject after threshold; an unselected active
                    // moving handle is excluded by that guard rather than silently omitted.
                    await page.keyboard.press("Escape");
                    await page.mouse.up();
                    cases++;
                }
                await page.waitForTimeout(SHOT_MS);
                await page.screenshot({ path: join(OUT, `S3f-${lane}-${selected}-${driven}.png`) });
            }
    expect(cases).toBe(20);
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "S3f-handle-matrix.png") });
});

test("S3f selection and body — Shift highlights only, one pressed subject, all lanes", async ({
    page,
    boot,
}) => {
    await boot();
    await pause(page);
    const opening = await snapshot(page);
    const selected = () =>
        page.evaluate(async () => {
            const path = "/src/editor.ts";
            const { editor } = (await import(path)) as {
                editor: { records: { ids: Set<number> } };
            };
            return [...editor.records.ids];
        });
    const geo = await point(page, "geo", 10),
        velocity = await point(page, "velocity", 9);
    await page.mouse.click(geo.x, geo.y);
    await page.keyboard.down("Shift");
    await page.mouse.click(velocity.x, velocity.y);
    await page.keyboard.up("Shift");
    await expect.poll(selected).toEqual([0, 2]);
    await expect(page.locator(".popover")).toHaveCount(0);
    const force = await point(page, "force", 14);
    await page.keyboard.down("Shift");
    await page.mouse.click(force.x + 1, force.y);
    await page.keyboard.up("Shift");
    await expect.poll(selected).toEqual([0, 2, 1]);
    await expect(page.locator(".popover")).toHaveCount(0);
    expect(await snapshot(page)).toEqual(opening);
    for (const [lane, from, to, start, end] of [
        ["geo", 10, 13, 3, 23],
        ["force", 35, 38, 17, 57],
        ["velocity", 9, 12, 7, 17],
    ] as const) {
        await drag(page, lane, from, to);
        await expect
            .poll(async () => (await kexCall(page, "lanes"))[lane].map((r) => [r.start, r.end]))
            .toEqual([[start, end]]);
        expect(await kexCall(page, "undoDepth")).toBe(opening.undo + 1);
        await page.keyboard.press("ControlOrMeta+z");
        await expect.poll(() => kexCall(page, "save")).toBe(opening.save);
    }
    // Crossing rows during Add still writes only the press lane, and starts no interim record.
    await page.getByRole("button", { name: "Add Segment (A)", exact: true }).click();
    const a = await point(page, "force", 60),
        b = await point(page, "velocity", 68);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 4 });
    expect(await snapshot(page)).toEqual(opening);
    await page.keyboard.press("v"); // a tool switch cannot commit the live preview
    expect(await snapshot(page)).toEqual(opening);
    await page.mouse.up();
    await expect
        .poll(async () => (await kexCall(page, "lanes")).force.map((r) => [r.start, r.end]))
        .toEqual([
            [14, 54],
            [60, 68],
        ]);
    expect((await kexCall(page, "lanes")).velocity).toEqual(
        JSON.parse(opening.save).lanes.velocity,
    );
    expect(await kexCall(page, "undoDepth")).toBe(opening.undo + 1);
});
