import { expect, test, kexCall, type Page, OUT, SHOT_MS, join } from "./flow";

// The display gate's own witness, and the smallest flow in the suite.
//
// `bun run capture` exists to run kex2d's UI under a REAL GPU: shallot's `run()` acquires a device
// even though kex2d draws canvas2D, so a capture taken off a software rasterizer is a picture of a
// different renderer. Measured on this seat 2026-09-08 (Omarchy/Hyprland, RTX 4090): headed system
// Chrome reports `nvidia / lovelace`, headless reports `google / swiftshader` under every flag set
// tried. The adapter identity is therefore asserted, not assumed — `flow.ts`'s `boot` reads
// `adapter.info` on every navigation, prints it once per worker and fails the run on a
// SwiftShader-class name.
//
// This flow adds the boot itself, so the suite can never collect zero tests and report the display
// route "green" without ever opening a browser. It drives no gesture and takes no screenshot: the
// lane-gesture flows carry those, and each arrives with its gesture's check-in (spec
// `kex2d-segment-gestures`).
for (const viewport of [
    { width: 1280, height: 720 },
    { width: 800, height: 600 },
])
    for (const lane of ["geo", "force", "velocity"] as const)
        test(`S3g compact editor ${lane}/${viewport.width} — measured disclosure, shared easing and entry ownership`, async ({
            page,
            boot,
        }) => {
            await page.setViewportSize(viewport);
            await boot();
            await pause(page);
            const s = lane === "force" ? 30 : 9;
            const p = await point(page, lane, s);
            await page.mouse.click(p.x, p.y);
            const panel = page.locator(".popover");
            await expect(panel).toBeVisible();
            await expect(page.locator('label[for="pf-exit"]')).toHaveText("Target");
            await expect(page.locator("#pf-start")).toHaveCount(0);
            await expect(page.locator("#pf-end")).toHaveCount(0);
            await expect(page.locator(".ease-control")).toContainText("Easing");
            const before = await snapshot(page);
            await page.locator(".ease-control").click();
            for (const key of ["a", "v", "s", "Delete"]) await page.keyboard.press(key);
            expect(await snapshot(page)).toEqual(before);
            await expect(
                page.getByRole("button", { name: "Select (V)", exact: true }),
            ).toHaveAttribute("aria-pressed", "true");
            for (const name of ["Linear", "Cubic", "Quintic"]) {
                const row = page.getByRole("menuitem", { name, exact: true });
                await expect(row).toBeVisible();
                const path = (await row.locator("path").getAttribute("d"))!;
                expect(path).toMatch(/^M/);
                const coordinates = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
                // Bind each rendered name to the existing profile family, not a copied curve dialect.
                const quarter = await page.evaluate(async (name) => {
                    const path = "/src/profile.ts",
                        p = await import(path),
                        ease = p.Easing[name];
                    return p.sampleForce(
                        [
                            { s: 0, g: 0, ease },
                            { s: 1, g: 1, ease },
                        ],
                        0.25,
                    );
                }, name);
                expect(coordinates).toHaveLength(34);
                expect(coordinates[8]).toBe(7);
                expect(coordinates[9]).toBeCloseTo(12 - 10 * quarter, 10);
            }
            await page.getByRole("menuitem", { name: "Quintic", exact: true }).click();
            await expect.poll(async () => (await kexCall(page, "lanes"))[lane][0]!.ease).toBe(2);
            await expect(page.locator(".ease-control")).toContainText("Quintic");
            expect(await kexCall(page, "undoDepth")).toBe(before.undo + 1);
            await page.keyboard.press("ControlOrMeta+z");
            await expect.poll(() => kexCall(page, "save")).toBe(before.save);
            const compact = (await panel.boundingBox())!;
            await disclose(page);
            const expanded = (await panel.boundingBox())!;
            expect(expanded.height).toBeGreaterThan(compact.height);
            expect(expanded.x).toBeGreaterThanOrEqual(0);
            expect(expanded.y).toBeGreaterThanOrEqual(0);
            expect(expanded.x + expanded.width).toBeLessThanOrEqual(viewport.width);
            expect(expanded.y + expanded.height).toBeLessThanOrEqual(viewport.height);
            await expect(page.locator("#pf-start")).toBeVisible();
            await expect(page.locator("#pf-entry")).toBeVisible();
            await expect(panel).toContainText("Owned start");
            const style = await panel.evaluate((el) => ({
                bg: getComputedStyle(el).backgroundColor,
                position: getComputedStyle(el).position,
            }));
            expect(style.bg).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
            expect(style.position).toBe("fixed");
            const checkbox = page.getByRole("checkbox", {
                name: "Ripple later segments in this lane",
            });
            await checkbox.focus();
            await page.keyboard.press("Space");
            await expect(checkbox).toBeChecked();
            expect(await snapshot(page)).toEqual(before);
            await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
            await page.getByRole("button", { name: "Inherit entry", exact: true }).click();
            await expect
                .poll(async () => JSON.parse(await kexCall(page, "save")).lanes[lane][0].entry)
                .toBeUndefined();
            await expect(page.locator("#pf-entry")).toHaveCount(0);
            await expect(panel).toContainText(
                lane === "force" ? "Inherited start" : "Unresolved entry",
            );
            const inherited = await snapshot(page);
            await page.getByRole("button", { name: "Override entry", exact: true }).click();
            const entry = page.locator("#pf-entry");
            await expect(entry).toBeFocused();
            if (lane !== "force") await expect(entry).toHaveValue("");
            await entry.fill("not-a-number");
            await expect(panel).toContainText("Enter a finite number");
            expect(await snapshot(page)).toEqual(inherited);
            await entry.fill(lane === "force" ? "1.25" : "21.123456789");
            await entry.press("Enter");
            await expect(panel).toContainText("Owned start");
            const expected =
                lane === "geo"
                    ? (21.123456789 * Math.PI) / 180
                    : lane === "force"
                      ? 1.25
                      : 21.123456789;
            await expect
                .poll(async () => JSON.parse(await kexCall(page, "save")).lanes[lane][0].entry)
                .toBeCloseTo(expected, 12);
            expect(await kexCall(page, "undoDepth")).toBe(inherited.undo + 1);
            await page.keyboard.press("ControlOrMeta+z");
            await expect.poll(() => kexCall(page, "save")).toBe(inherited.save);
            await page.keyboard.press("ControlOrMeta+z");
            await expect.poll(() => kexCall(page, "save")).toBe(before.save);
            const target = page.locator("#pf-exit");
            await target.focus();
            const held = (await panel.boundingBox())!;
            await target.fill("21.1234567890123");
            await expect(page.locator("#app")).toHaveAttribute("data-dragging", "");
            await expect(checkbox).toBeDisabled();
            expect((await panel.boundingBox())!.x).toBe(held.x);
            expect((await panel.boundingBox())!.y).toBe(held.y);
            await target.press("Enter");
            const stored = JSON.parse(await kexCall(page, "save")).lanes[lane][0].exit;
            expect(stored).toBeCloseTo(
                lane === "geo" ? (21.1234567890123 * Math.PI) / 180 : 21.1234567890123,
                12,
            );
            expect(stored).not.toBe(Number(stored.toFixed(2)));
            expect(await kexCall(page, "undoDepth")).toBe(before.undo + 1);
            await page.keyboard.press("ControlOrMeta+z");
            await expect.poll(() => kexCall(page, "save")).toBe(before.save);
            for (const which of ["start", "end"] as const) {
                const row = (await kexCall(page, "lanes"))[lane][0]!;
                const edge = await point(page, lane, row[which]);
                await page.mouse.click(edge.x + (which === "start" ? 1 : -1), edge.y);
                await expect(page.locator(`#pf-${which}`)).toBeFocused();
                const bounds = (await panel.boundingBox())!;
                expect(bounds.x).toBeGreaterThanOrEqual(0);
                expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
                expect(bounds.y + bounds.height).toBeLessThan(edge.y - 8);
                await page.locator(`#pf-${which}`).press("Escape");
                expect(await snapshot(page)).toEqual(before);
            }
            await page.waitForTimeout(SHOT_MS);
            await page.screenshot({ path: join(OUT, `s3g-${lane}-${viewport.width}.png`) });
        });

test("S3g recovered readings — common hover/playhead station, published ds and missing inputs", async ({
    page,
    boot,
}) => {
    await boot();
    await pause(page);
    // Expected readings come from published columns, independently of timeline reading helpers.
    async function expected(s: number) {
        return page.evaluate(async (s) => {
            const path = "/src/track.ts";
            const t = await import(path);
            const eid = (window as unknown as { __kex: { track: number } }).__kex.track;
            const out = t.bakeOut.get(eid),
                sm = t.samples.get(eid),
                n = t.Track.count.get(eid);
            const stations = [0];
            for (let i = 1; i < n; i++) stations.push(stations[i - 1]! + out.ds[i - 1]);
            let i = stations.findIndex((x) => x > s) - 1;
            if (i < 0) i = n - 2;
            const alpha = (s - stations[i]!) / (stations[i + 1]! - stations[i]!);
            return {
                geo: `≈ ${(((sm.theta[i] + (sm.theta[i + 1] - sm.theta[i]) * alpha) * 180) / Math.PI).toFixed(1)} °`,
                force: `≈ ${out.fN[i].toFixed(2)} g`,
                velocity: `≈ ${(out.v[i] + (out.v[i + 1] - out.v[i]) * alpha).toFixed(2)} m/s`,
            };
        }, s);
    }
    for (const s of [5.123, 25.123, 45.123]) {
        const p = await point(page, "geo", s);
        await page.mouse.move(p.x, p.y);
        await expect(page.locator(".read-station")).toHaveText(`Recovered @ ${s.toFixed(2)} m`);
        const values = await expected(s);
        for (const lane of ["geo", "force", "velocity"] as const)
            await expect(page.locator(`.recovered[data-lane="${lane}"]`)).toHaveText(values[lane]);
    }
    await page.mouse.move(2, 2);
    const parked = (await kexCall(page, "cartArc"))!;
    await expect(page.locator(".read-station")).toHaveText(`Recovered @ ${parked.toFixed(2)} m`);
    const values = await expected(parked);
    for (const lane of ["geo", "force", "velocity"] as const)
        await expect(page.locator(`.recovered[data-lane="${lane}"]`)).toHaveText(values[lane]);
    // The viewport extends beyond authored/baked coverage; no exit extrapolation there.
    const outside = await point(page, "geo", 65);
    await page.mouse.move(outside.x, outside.y);
    for (const lane of ["geo", "force", "velocity"])
        await expect(page.locator(`.recovered[data-lane="${lane}"]`)).toContainText("Unavailable");
    // Inherit via the actual editor leaves isolated velocity unresolved, not a flat exit seed.
    const p = await point(page, "velocity", 9);
    await page.mouse.click(p.x, p.y);
    await disclose(page);
    await page.getByRole("button", { name: "Inherit entry", exact: true }).click();
    await page.mouse.move(p.x, p.y);
    await expect(page.locator('.recovered[data-lane="velocity"]')).toHaveText("Unavailable m/s");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(page.locator('.recovered[data-lane="velocity"]')).not.toContainText("Unavailable");
    const unwrapped = JSON.parse(await kexCall(page, "save"));
    unwrapped.lanes.geo[0].entry = 0;
    unwrapped.lanes.geo[0].exit = 2 * Math.PI + 0.35;
    await kexCall(page, "load", JSON.stringify(unwrapped));
    const turn = await point(page, "geo", 19.123);
    await page.mouse.move(turn.x, turn.y);
    await expect.poll(async () => (await expected(19.123)).geo).toMatch(/≈ 3[6-9]\d\./);
    await expect(page.locator('.recovered[data-lane="geo"]')).toHaveText(
        (await expected(19.123)).geo,
    );
    // A partially published record can be read inside coverage, never beyond its terminal station.
    await page.evaluate(async () => {
        const path = "/src/track.ts",
            t = await import(path);
        const w = window as unknown as { __kex: { track: number }; __countRestore: () => void };
        const eid = w.__kex.track,
            count = t.Track.count.get(eid),
            out = t.bakeOut.get(eid);
        let n = 1,
            s = 0;
        while (n < count && s + out.ds[n - 1] <= 10) {
            s += out.ds[n - 1];
            n++;
        }
        t.Track.count.set(eid, n);
        w.__countRestore = () => t.Track.count.set(eid, count);
    });
    try {
        for (const lane of ["geo", "force", "velocity"])
            await expect(page.locator(`.recovered[data-lane="${lane}"]`)).toContainText(
                "Unavailable",
            );
        const covered = await point(page, "geo", 5.123);
        await page.mouse.move(covered.x, covered.y);
        await expect(page.locator('.recovered[data-lane="geo"]')).toHaveText(
            (await expected(5.123)).geo,
        );
    } finally {
        await page.evaluate(() =>
            (window as unknown as { __countRestore(): void }).__countRestore(),
        );
    }
    // Remove actual published inputs, not a mock reading callback. Restore exact references.
    await page.evaluate(async () => {
        const path = "/src/track.ts",
            t = await import(path);
        const w = window as unknown as { __kex: { track: number }; __readingRestore: () => void };
        const eid = w.__kex.track,
            out = t.bakeOut.get(eid);
        t.bakeOut.delete(eid);
        w.__readingRestore = () => t.bakeOut.set(eid, out);
    });
    try {
        for (const lane of ["geo", "force", "velocity"])
            await expect(page.locator(`.recovered[data-lane="${lane}"]`)).toContainText(
                "Unavailable",
            );
    } finally {
        await page.evaluate(() =>
            (window as unknown as { __readingRestore(): void }).__readingRestore(),
        );
    }
    await expect(page.locator('.recovered[data-lane="velocity"]')).not.toContainText("Unavailable");
});

test("S3g diagnostics — real row reorder moves driven residual and preserves exact undo", async ({
    page,
    boot,
}) => {
    await boot();
    await pause(page);
    const opening = await snapshot(page);
    async function select(lane: "geo" | "force") {
        const p = await point(page, lane, lane === "geo" ? 9 : 30);
        await page.mouse.click(p.x, p.y);
        await expect(page.locator(".popover")).toHaveAttribute("aria-label", `${lane} segment`);
        if (
            (await page
                .getByRole("button", { name: /Entry, range & diagnostics/ })
                .getAttribute("aria-expanded")) === "false"
        )
            await disclose(page);
    }
    async function residual(lane: "geo" | "force") {
        const expected = await page.evaluate(async (lane) => {
            const path = "/src/track.ts",
                t = await import(path);
            const w = window as unknown as { __kex: { track: number; save(): string } };
            const eid = w.__kex.track,
                out = t.bakeOut.get(eid),
                sm = t.samples.get(eid),
                n = t.Track.count.get(eid);
            const r = JSON.parse(w.__kex.save()).lanes[lane][0];
            let s = 0,
                worst = 0,
                at = 0,
                found = false;
            for (let i = 0; i < (lane === "force" ? n - 1 : n); i++) {
                if (i) s += out.ds[i - 1];
                if (s < r.start || s > r.end) continue;
                const u = (s - r.start) / (r.end - r.start);
                const f = lane === "force" ? u : u * u * (3 - 2 * u);
                const demanded = r.entry + (r.exit - r.entry) * f;
                const miss = (lane === "force" ? out.fN[i] : sm.theta[i]) - demanded;
                if (!found || Math.abs(miss) > Math.abs(worst)) {
                    found = true;
                    worst = miss;
                    at = s;
                }
            }
            return {
                value: (worst * (lane === "geo" ? 180 / Math.PI : 1)).toFixed(
                    lane === "geo" ? 1 : 2,
                ),
                at: at.toFixed(2),
                found,
            };
        }, lane);
        expect(expected.found).toBe(true);
        await expect(page.locator(".residual")).toContainText(
            `≈ ${expected.value} ${lane === "force" ? "g" : "°"} recovered − demanded · worst sampled @ ${expected.at} m`,
        );
    }
    await select("force");
    await residual("force");
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
    await expect(page.locator(".residual")).toHaveCount(0);
    await select("geo");
    await residual("geo");
    expect(await kexCall(page, "undoDepth")).toBe(opening.undo + 1);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => kexCall(page, "save")).toBe(opening.save);
});

test("adapter witness — the app boots on a real GPU", async ({ page, boot }) => {
    await boot();
    // The dock is the app's own mounted-and-laid-out gate (`boot` awaits it); assert the canvas the
    // shots are taken of is really there too, so a boot that renders nothing cannot pass this.
    await expect(page.locator("canvas").first()).toBeVisible();
});

async function disclose(page: Page): Promise<void> {
    await page.getByRole("button", { name: /Entry, range & diagnostics/ }).click();
    await expect
        .poll(async () => {
            const panel = (await page.locator(".popover").boundingBox())!;
            const dock = (await page.locator(".dock").boundingBox())!;
            return panel.y + panel.height <= dock.y - 8;
        })
        .toBe(true);
}

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

for (const mode of ["span", "scrub", "typed", "targetScrub", "targetTyped"] as const)
    for (const reason of ["unmount", "resize", "delete", "layout"] as const)
        for (const playing of [false, true])
            test(`${mode.startsWith("target") || reason === "layout" ? "S3g" : "S3f"} lifecycle ${mode}/${reason}/${playing ? "playing" : "held"}`, async ({
                page,
                boot,
            }) => {
                await observeLifetimes(page);
                await page.setViewportSize({ width: 1280, height: 720 });
                await boot();
                await pause(page);
                // Two actual mount lifetimes on one page expose leaked static listeners.
                await showTimeline(page, false);
                const hidden = (await life(page)).listeners;
                await showTimeline(page, true);
                const idle = (await life(page)).listeners;
                const body = await point(page, "velocity", 9);
                await page.mouse.click(body.x, body.y);
                await expect(page.locator(".popover")).toBeVisible();
                await disclose(page);
                const mounted = (await life(page)).listeners;
                const opening = await snapshot(page);
                if (playing) await page.getByRole("button", { name: "Play", exact: true }).click();
                await resetLife(page);
                const target = mode.startsWith("target");
                const typed = mode === "typed" || mode === "targetTyped";
                const field = target ? "exit" : "end";
                if (mode === "span") {
                    const a = await point(page, "velocity", 14),
                        b = await point(page, "velocity", 16);
                    await page.mouse.move(a.x - 1, a.y);
                    await page.mouse.down();
                    await page.mouse.move(b.x, b.y, { steps: 4 });
                } else if (!typed) {
                    const box = (await page.locator(`label[for="pf-${field}"]`).boundingBox())!;
                    await page.mouse.move(box.x + 10, box.y + 10);
                    await page.mouse.down();
                    await page.mouse.move(box.x + 18, box.y + 10, { steps: 4 });
                } else {
                    await page.locator(`#pf-${field}`).focus();
                    await page.locator(`#pf-${field}`).fill(target ? "26" : "16");
                }
                await expect
                    .poll(async () => (await kexCall(page, "lanes")).velocity[0]![field])
                    .toBe(target ? 26 : 16);
                expect(await kexCall(page, "save")).not.toBe(opening.save);
                expect(await kexCall(page, "undoDepth")).toBe(opening.undo);
                await expect(page.locator("#app")).toHaveAttribute("data-dragging", "");
                await expect.poll(() => kexCall(page, "parked")).toBe(true);
                const live = await life(page);
                expect(live.sets).toBe(typed ? 0 : 1);
                expect(live.active).toBe(!typed);
                if (reason === "unmount") await showTimeline(page, false);
                else if (reason === "delete") {
                    await page.evaluate(() =>
                        (
                            window as unknown as { __kex: { removeRecord(id: number): unknown } }
                        ).__kex.removeRecord(2),
                    );
                    await expect
                        .poll(async () => (await kexCall(page, "lanes")).velocity.length)
                        .toBe(0);
                } else {
                    await page.evaluate(() => {
                        const w = window as unknown as {
                            __kex: { save(): string };
                            __reflow: string[];
                        };
                        w.__reflow = [];
                        const observer = new MutationObserver(() =>
                            w.__reflow.push(w.__kex.save()),
                        );
                        observer.observe(document.querySelector(".popover")!, {
                            attributes: true,
                            attributeFilter: ["style"],
                        });
                    });
                    if (reason === "layout")
                        await page.locator(".dock").evaluate((el) => {
                            (el as HTMLElement).style.bottom = "136px";
                        });
                    else await page.setViewportSize({ width: 800, height: 600 });
                }
                await expect(page.locator("#app")).not.toHaveAttribute("data-dragging");
                await expect.poll(() => kexCall(page, "parked")).toBe(!playing);
                await expect.poll(async () => (await life(page)).active).toBe(false);
                const after = await life(page);
                expect(after.heldWrites).toEqual(playing ? [true, false] : []);
                expect(after.releases).toBeLessThanOrEqual(1);
                if ((reason === "resize" || reason === "layout") && !typed)
                    expect(after.releases).toBe(1);
                expect(after.listeners).toEqual(
                    reason === "unmount" ? hidden : reason === "delete" ? idle : mounted,
                );
                if (reason === "delete") {
                    const expected = JSON.parse(opening.save);
                    expected.lanes.velocity = [];
                    expect(JSON.parse(await kexCall(page, "save"))).toEqual(expected);
                    expect(await kexCall(page, "undoDepth")).toBe(opening.undo + 1);
                } else expect(await snapshot(page)).toEqual(opening);
                if (reason === "resize" || reason === "layout") {
                    const observed = await page.evaluate(
                        () => (window as unknown as { __reflow: string[] }).__reflow,
                    );
                    expect(observed.length).toBeGreaterThan(0);
                    expect(observed.every((text) => text === opening.save)).toBe(true);
                    const box = (await page.locator(".popover").boundingBox())!;
                    expect(box.x).toBeGreaterThanOrEqual(0);
                    expect(box.x + box.width).toBeLessThanOrEqual(reason === "resize" ? 800 : 1280);
                    expect(box.y).toBeGreaterThanOrEqual(0);
                    expect(box.y + box.height).toBeLessThanOrEqual(reason === "resize" ? 600 : 720);
                }
                // Late events cannot commit, reopen the gesture, or restore playback twice.
                const settled = await snapshot(page);
                await page.mouse.move(600, 200);
                await page.mouse.up();
                await page.evaluate(() => {
                    window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 }));
                    window.dispatchEvent(new Event("blur"));
                });
                expect(await snapshot(page)).toEqual(settled);
                expect((await life(page)).heldWrites).toEqual(after.heldWrites);
                expect((await life(page)).releases).toBe(after.releases);
                if (reason === "delete") {
                    await page.locator(".dock").focus();
                    await page.keyboard.press("ControlOrMeta+z");
                    await expect.poll(() => kexCall(page, "save")).toBe(opening.save);
                }
                if (reason === "unmount") {
                    await showTimeline(page, true);
                    await expect(page.locator(".popover")).toBeVisible();
                    expect((await life(page)).listeners).toEqual(mounted);
                }
            });

test("S3f menu exclusion — live gesture refuses context menu, idle positive writes once", async ({
    page,
    boot,
}) => {
    await boot();
    await pause(page);
    const opening = await snapshot(page);
    const a = await point(page, "geo", 20),
        b = await point(page, "geo", 23);
    await page.mouse.move(a.x - 1, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 4 });
    await expect.poll(async () => (await kexCall(page, "lanes")).geo[0]!.end).toBe(23);
    const preview = await snapshot(page);
    await page.mouse.click(b.x, b.y, { button: "right" });
    await expect(page.locator(".menu-anchor")).toHaveCount(0);
    expect(await snapshot(page)).toEqual(preview);
    await expect(page.locator("#app")).toHaveAttribute("data-dragging", "");
    await page.mouse.up();
    expect(await kexCall(page, "undoDepth")).toBe(opening.undo + 1);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => kexCall(page, "save")).toBe(opening.save);
    const body = await point(page, "geo", 10);
    await page.mouse.click(body.x, body.y, { button: "right" });
    await expect(page.locator(".menu-anchor")).toBeVisible();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await expect.poll(async () => (await kexCall(page, "lanes")).geo.length).toBe(0);
    expect(await kexCall(page, "undoDepth")).toBe(opening.undo + 1);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => kexCall(page, "save")).toBe(opening.save);
});

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

test("S3f handles — click field, typing owns keys, Enter once, Escape blur and pointercancel", async ({
    page,
    boot,
}) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await boot();
    await pause(page);
    const opening = await snapshot(page),
        end = await point(page, "geo", 20);
    await page.mouse.move(end.x - 1, end.y);
    await page.mouse.down();
    await page.mouse.move(end.x - 3, end.y);
    await page.mouse.up();
    await expect(page.locator("#pf-end")).toBeFocused();
    expect(await snapshot(page)).toEqual(opening);
    const field = page.locator("#pf-end");
    await field.fill("22");
    await expect.poll(async () => (await kexCall(page, "lanes")).geo[0]!.end).toBe(22);
    expect(await kexCall(page, "undoDepth")).toBe(opening.undo);
    await page.keyboard.press("Escape");
    await expect.poll(() => kexCall(page, "save")).toBe(opening.save);
    await field.focus();
    await field.fill("23");
    await field.press("Enter");
    await expect.poll(() => kexCall(page, "undoDepth")).toBe(opening.undo + 1);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => kexCall(page, "save")).toBe(opening.save);
    await field.focus();
    await field.fill("24");
    await page.locator(".dock").focus();
    await expect.poll(() => kexCall(page, "save")).toBe(opening.save);
    await field.focus();
    await field.fill("vas");
    const debug = await page.locator("body").getAttribute("data-shallot-debug");
    await field.press("F3");
    expect(await page.locator("body").getAttribute("data-shallot-debug")).toBe(debug);
    await field.press("Space");
    await field.press("ArrowLeft");
    await field.press("Delete");
    await field.press("Escape");
    expect(await snapshot(page)).toEqual(opening);
    await expect(page.getByRole("button", { name: "Select (V)", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
    );
    const a = await point(page, "geo", 20),
        b = await point(page, "geo", 25);
    await page.mouse.move(a.x - 1, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 4 });
    await expect.poll(async () => (await kexCall(page, "lanes")).geo[0]!.end).toBe(25);
    await page.evaluate(() =>
        window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 })),
    );
    await page.mouse.up();
    await expect.poll(() => kexCall(page, "save")).toBe(opening.save);
    expect(await kexCall(page, "undoDepth")).toBe(opening.undo);
});

test("S3f menu — real wrapper/style, reachable flyout, secondary actions and retired row routes", async ({
    page,
    boot,
}) => {
    await page.setViewportSize({ width: 800, height: 600 });
    await boot();
    await pause(page);
    const opening = await snapshot(page),
        body = await point(page, "force", 30);
    await page.mouse.click(body.x, body.y, { button: "right" });
    const root = page.locator(".menu-anchor.menu");
    await expect(root).toBeVisible();
    const style = await root.evaluate((el) => {
        const s = getComputedStyle(el);
        return { bg: s.backgroundColor, border: s.borderTopWidth, overflow: s.overflow };
    });
    expect(style.bg).not.toBe("rgba(0, 0, 0, 0)");
    expect(style.border).toBe("1px");
    expect(style.overflow).toBe("visible");
    await expect(root.locator(":scope > .menu-rows > .menu-item").last()).toHaveClass(/danger/);
    await expect(root.locator(".sk")).toHaveText("Del");
    const rowStyle = await root
        .locator(".menu-item")
        .first()
        .evaluate((el) => ({
            display: getComputedStyle(el).display,
            padding: getComputedStyle(el).paddingLeft,
        }));
    expect(rowStyle).toEqual({ display: "flex", padding: "10px" });
    await page.keyboard.press("a");
    expect(await snapshot(page)).toEqual(opening);
    await expect(page.getByRole("button", { name: "Select (V)", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
    );
    const camera = await kexCall(page, "cam");
    await page.keyboard.press("f");
    expect(await kexCall(page, "cam")).toEqual(camera);
    await root.getByRole("menuitem", { name: "Easing" }).hover();
    const sub = root.locator(".submenu");
    await expect(sub).toBeVisible();
    const bounds = (await sub.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(800);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(600);
    await sub.getByRole("menuitem", { name: "Quintic" }).click();
    await expect.poll(() => kexCall(page, "undoDepth")).toBe(opening.undo + 1);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => kexCall(page, "save")).toBe(opening.save);
    const gap = await point(page, "geo", 30);
    await page.mouse.click(gap.x, gap.y, { button: "right" });
    await expect(page.locator(".menu-anchor")).toHaveCount(0);
    await page.mouse.dblclick(body.x, body.y);
    expect(await snapshot(page)).toEqual(opening);
    await expect(page.getByText("Expand", { exact: true })).toHaveCount(0);
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "S3f-menu-retirement.png") });
});

test("S3f ripple — real end updater, independent body/start, refusal, cancel and undo", async ({
    page,
    boot,
}) => {
    await boot();
    await pause(page);
    const doc = JSON.parse(await kexCall(page, "save"));
    doc.lanes.force.push({ id: 3, start: 60, end: 70, ease: 2, entry: 2.5, exit: 1 });
    doc.track.end = 72;
    await kexCall(page, "load", JSON.stringify(doc));
    await expect.poll(async () => (await kexCall(page, "lanes")).force.length).toBe(2);
    const opening = await snapshot(page),
        body = await point(page, "force", 35);
    await page.mouse.click(body.x, body.y);
    await disclose(page);
    const checkbox = page.getByRole("checkbox", { name: "Ripple later segments in this lane" });
    await checkbox.check();
    await drag(page, "force", 54, 56);
    await expect
        .poll(async () => (await kexCall(page, "lanes")).force.map((r) => [r.start, r.end]))
        .toEqual([
            [14, 56],
            [62, 72],
        ]);
    expect(await kexCall(page, "undoDepth")).toBe(opening.undo + 1);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => kexCall(page, "save")).toBe(opening.save);
    // A pin violation must expose refusal while preserving the whole last valid candidate.
    await drag(page, "force", 54, 58);
    const refused = (await kexCall(page, "lanes")).force;
    expect(refused[1]!.end).toBeLessThanOrEqual(72);
    await expect(page.getByRole("status")).toContainText(/pin/i);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => kexCall(page, "save")).toBe(opening.save);
    // Start never invokes ripple, even with mode on.
    await drag(page, "force", 14, 16);
    await expect
        .poll(async () => (await kexCall(page, "lanes")).force.map((r) => [r.start, r.end]))
        .toEqual([
            [16, 54],
            [60, 70],
        ]);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => kexCall(page, "save")).toBe(opening.save);
    const a = await point(page, "force", 54),
        b = await point(page, "force", 56);
    await page.mouse.move(a.x - 1, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 4 });
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.mouse.up();
    await expect.poll(() => kexCall(page, "save")).toBe(opening.save);
    expect(await kexCall(page, "undoDepth")).toBe(opening.undo);
});

test("S3f field composition — screen hold, live bake, playhead hold and release", async ({
    page,
    boot,
}) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await boot();
    await pause(page);
    const body = await point(page, "velocity", 9);
    await page.mouse.click(body.x, body.y);
    const opening = await snapshot(page);
    const park = await kexCall(page, "cartArc"),
        time = await kexCall(page, "tTotal");
    const label = page.locator('label[for="pf-exit"]'),
        box = (await label.boundingBox())!;
    const panel = page.locator(".popover"),
        bounds = (await panel.boundingBox())!;
    await page.mouse.move(box.x + 10, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x + 22, box.y + 10, { steps: 4 });
    await expect.poll(() => kexCall(page, "tTotal")).not.toBe(time);
    const held = (await panel.boundingBox())!;
    expect(held.x).toBe(bounds.x);
    expect(held.y).toBe(bounds.y);
    expect(await kexCall(page, "cartArc")).toBeCloseTo(park!, 5);
    expect(await kexCall(page, "undoDepth")).toBe(opening.undo);
    await page.mouse.up();
    expect(await kexCall(page, "undoDepth")).toBe(opening.undo + 1);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(() => kexCall(page, "save")).toBe(opening.save);
    // Disclosed range retains the same station gesture, not a new editing mode.
    await disclose(page);
    // Station scrub moves the span anchor while the actual screen box must stay put.
    const stationLabel = (await page.locator('label[for="pf-end"]').boundingBox())!;
    const stationBox = (await panel.boundingBox())!;
    await page.mouse.move(stationLabel.x + 10, stationLabel.y + 10);
    await page.mouse.down();
    await page.mouse.move(stationLabel.x + 18, stationLabel.y + 10, { steps: 4 });
    await expect.poll(async () => (await kexCall(page, "lanes")).velocity[0]!.end).toBe(16);
    expect((await panel.boundingBox())!.x).toBe(stationBox.x);
    expect((await panel.boundingBox())!.y).toBe(stationBox.y);
    await page.evaluate(() =>
        window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 })),
    );
    await page.mouse.up();
    await expect.poll(() => kexCall(page, "save")).toBe(opening.save);
    expect(await kexCall(page, "undoDepth")).toBe(opening.undo);
    // Playing is the opposite release-state control; opening a field must hold it.
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.locator("#pf-end").focus();
    await expect.poll(() => kexCall(page, "parked")).toBe(true);
    await page.locator("#pf-end").fill("15");
    await page.locator("#pf-end").press("Escape");
    await expect.poll(() => kexCall(page, "parked")).toBe(false);
    await expect.poll(() => kexCall(page, "save")).toBe(opening.save);
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
