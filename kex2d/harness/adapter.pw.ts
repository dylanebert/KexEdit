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
test("adapter witness — the app boots on a real GPU", async ({ page, boot }) => {
    await boot();
    // The dock is the app's own mounted-and-laid-out gate (`boot` awaits it); assert the canvas the
    // shots are taken of is really there too, so a boot that renders nothing cannot pass this.
    await expect(page.locator("canvas").first()).toBeVisible();
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

for (const mode of ["span", "scrub", "typed"] as const)
    for (const reason of ["unmount", "resize", "delete"] as const)
        for (const playing of [false, true])
            test(`S3f lifecycle ${mode}/${reason}/${playing ? "playing" : "held"}`, async ({
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
                const mounted = (await life(page)).listeners;
                const opening = await snapshot(page);
                if (playing) await page.getByRole("button", { name: "Play", exact: true }).click();
                await resetLife(page);
                if (mode === "span") {
                    const a = await point(page, "velocity", 14),
                        b = await point(page, "velocity", 16);
                    await page.mouse.move(a.x - 1, a.y);
                    await page.mouse.down();
                    await page.mouse.move(b.x, b.y, { steps: 4 });
                } else if (mode === "scrub") {
                    const box = (await page.locator('label[for="pf-end"]').boundingBox())!;
                    await page.mouse.move(box.x + 10, box.y + 10);
                    await page.mouse.down();
                    await page.mouse.move(box.x + 18, box.y + 10, { steps: 4 });
                } else {
                    await page.locator("#pf-end").focus();
                    await page.locator("#pf-end").fill("16");
                }
                await expect
                    .poll(async () => (await kexCall(page, "lanes")).velocity[0]!.end)
                    .toBe(16);
                expect(await kexCall(page, "save")).not.toBe(opening.save);
                expect(await kexCall(page, "undoDepth")).toBe(opening.undo);
                await expect(page.locator("#app")).toHaveAttribute("data-dragging", "");
                await expect.poll(() => kexCall(page, "parked")).toBe(true);
                const live = await life(page);
                expect(live.sets).toBe(mode === "typed" ? 0 : 1);
                expect(live.active).toBe(mode !== "typed");
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
                    await page.setViewportSize({ width: 800, height: 600 });
                }
                await expect(page.locator("#app")).not.toHaveAttribute("data-dragging");
                await expect.poll(() => kexCall(page, "parked")).toBe(!playing);
                await expect.poll(async () => (await life(page)).active).toBe(false);
                const after = await life(page);
                expect(after.heldWrites).toEqual(playing ? [true, false] : []);
                expect(after.releases).toBeLessThanOrEqual(1);
                if (reason === "resize" && mode !== "typed") expect(after.releases).toBe(1);
                expect(after.listeners).toEqual(
                    reason === "unmount" ? hidden : reason === "delete" ? idle : mounted,
                );
                if (reason === "delete") {
                    const expected = JSON.parse(opening.save);
                    expected.lanes.velocity = [];
                    expect(JSON.parse(await kexCall(page, "save"))).toEqual(expected);
                    expect(await kexCall(page, "undoDepth")).toBe(opening.undo + 1);
                } else expect(await snapshot(page)).toEqual(opening);
                if (reason === "resize") {
                    const observed = await page.evaluate(
                        () => (window as unknown as { __reflow: string[] }).__reflow,
                    );
                    expect(observed.length).toBeGreaterThan(0);
                    expect(observed.every((text) => text === opening.save)).toBe(true);
                    const box = (await page.locator(".popover").boundingBox())!;
                    expect(box.x).toBeGreaterThanOrEqual(0);
                    expect(box.x + box.width).toBeLessThanOrEqual(800);
                    expect(box.y).toBeGreaterThanOrEqual(0);
                    expect(box.y + box.height).toBeLessThanOrEqual(600);
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
