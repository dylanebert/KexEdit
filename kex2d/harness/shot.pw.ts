import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// Boot the kex2d page and drive the GEO-AUTHORING flow end to end (seed a shaped track →
// see the recovered F_n force curve → extend the chain → undo → reshape a node and watch
// the curve react, kex/specs/kex2d-sections.md stage A/B), asserting the UI wiring against
// window.__kex at each step and screenshotting the states. The DEV-only __kex hook
// (src/main.ts) reads node/undo/track state and drives the geo edits; the flow drives the
// real UI (keyboard extend/trim, undo). The force-authoring flow is the next test.
// Screenshots land in KEX_OUT (a Windows path when staged; copied back).

const PORT = process.env.KEX_PORT ?? "3014";
const OUT = process.env.KEX_OUT ?? "shots";
const SETTLE_MS = Number(process.env.KEX_SETTLE_MS ?? "2500");

// window.__kex is the DEV harness hook (src/main.ts); the harness is outside the project
// tsconfig, so these page-context reads use `any` freely.

test("geo authoring flow", async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
    await expect(page.locator(".dock")).toBeVisible();
    await expect(page.locator(".player")).toBeVisible();

    // read helpers over the DEV hook. expect.poll drives every wait — no fixed sleeps.
    const nodeCount = () => page.evaluate((): number => (window as any).__kex.nodeCount());
    const undoDepth = () => page.evaluate((): number => (window as any).__kex.undoDepth());
    const tTotal = () => page.evaluate((): number => (window as any).__kex.tTotal());
    const poses = () => page.evaluate((): number[][] => (window as any).__kex.poses());

    // seed the airtime hill and wait for its first bake (the recovered force curve).
    await page.evaluate(() => (window as any).__kex.seedHill());
    await expect.poll(tTotal).toBeGreaterThan(0);
    await expect.poll(nodeCount).toBe(7);
    await page.waitForTimeout(SETTLE_MS); // let the cart + curve settle for the baseline shot

    // read-only baseline: the shaped track + its recovered F_n force curve.
    await page.screenshot({ path: join(OUT, "full.png") });
    const vp = page.viewportSize();
    if (vp) {
        await page.screenshot({
            path: join(OUT, "timeline.png"),
            clip: { x: 0, y: vp.height - 340, width: vp.width, height: 340 },
        });
    }

    // ── 1. Extend: select the chain end, press Enter → one node, one undo entry. ──
    await page.evaluate(() => (window as any).__kex.selectEnd());
    await page.keyboard.press("Enter");
    await expect.poll(nodeCount).toBe(8);
    expect(await undoDepth()).toBe(1);
    await page.screenshot({ path: join(OUT, "geo-1-extend.png") });

    // ── 2. Undo: Ctrl+Z drops the extended node, clearing the entry. ──
    await page.keyboard.press("Control+z");
    await expect.poll(nodeCount).toBe(7);
    await expect.poll(undoDepth).toBe(0);

    // ── 3. Reshape: nudge a node and the recovered force curve reacts (re-bake). ──
    const before = await poses();
    const tBefore = await tTotal();
    await page.evaluate(() => (window as any).__kex.nudge(3, 6)); // raise the crest
    await expect.poll(async () => (await poses())[3][1]).not.toBe(before[3][1]);
    // the shape changed, so the baked track — and its time — changed too.
    await expect.poll(async () => Math.abs((await tTotal()) - tBefore) > 1e-4).toBe(true);
    await page.screenshot({ path: join(OUT, "geo-2-reshape.png") });

    if (errors.length) console.log(`KEX_PAGE_NOTES ${JSON.stringify(errors)}`);
});

// Drive the FORCE-AUTHORING flow (kex/specs/kex2d-sections.md stage C): a geo track →
// convert to force via the real mode toggle (resets to an empty 1g profile) → author
// an airtime bump by force points → convert back to geo (resets to the flat seed) →
// undo, which restores the force track with its points byte-identical. The mode toggle
// and undo run through the real UI; point placement uses the __kex hook for precision.
test("force authoring flow", async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
    await expect(page.locator(".dock")).toBeVisible();

    const kind = () => page.evaluate((): number => (window as any).__kex.kind());
    const nodeCount = () => page.evaluate((): number => (window as any).__kex.nodeCount());
    const forceCount = () => page.evaluate((): number => (window as any).__kex.forceCount());
    const tTotal = () => page.evaluate((): number => (window as any).__kex.tTotal());

    // seed a shaped geo track so the convert inherits a real arclength.
    await page.evaluate(() => (window as any).__kex.seedHill());
    await expect.poll(tTotal).toBeGreaterThan(0);
    expect(await kind()).toBe(0); // TrackKind.Geo

    // ── 1. Convert to force via the real mode toggle → empty 1g profile, no nodes. ──
    await page.getByRole("button", { name: "Force" }).click();
    await expect.poll(kind).toBe(1); // TrackKind.Force
    await expect.poll(nodeCount).toBe(0);
    expect(await forceCount()).toBe(0);
    await expect.poll(tTotal).toBeGreaterThan(0); // the flat force track baked
    await page.waitForTimeout(SETTLE_MS);
    await page.screenshot({ path: join(OUT, "force-1-empty.png") });

    // ── 2. Author an airtime bump by force points → the recovered curve reacts. ──
    await page.evaluate(() => (window as any).__kex.seedForceBump());
    await expect.poll(forceCount).toBe(3);
    await page.waitForTimeout(SETTLE_MS);
    await page.screenshot({ path: join(OUT, "force-2-bump.png") });
    const vp = page.viewportSize();
    if (vp) {
        await page.screenshot({
            path: join(OUT, "force-timeline.png"),
            clip: { x: 0, y: vp.height - 340, width: vp.width, height: 340 },
        });
    }

    // ── 2b. Double-click the chart inserts a point ON the authored profile (the
    // envelope-insertion identity): left of the first point the profile holds the
    // shoulder's exact 1g, so the new point's g must be 1 regardless of the cursor's
    // y (which lands well off 1g here). then undo removes it. real pixels. ──
    const body = page.locator(".dock .body");
    const box = await body.boundingBox();
    if (!box) throw new Error("timeline body not laid out");
    await page.mouse.dblclick(box.x + 60, box.y + box.height * 0.35);
    await expect.poll(forceCount).toBe(4);
    // the create selects the point, so its popover is up — capture it for the feel pass
    // (let its 120ms fade-in finish, or the shot catches a ghost).
    await page.waitForTimeout(300);
    if (vp) {
        await page.screenshot({
            path: join(OUT, "force-popover.png"),
            clip: { x: 0, y: vp.height - 340, width: vp.width, height: 340 },
        });
    }
    const rows = await page.evaluate(
        (): { s: number; g: number }[] => (window as any).__kex.forces(),
    );
    expect(rows[0].g).toBeCloseTo(1, 5); // resolved on the profile, not at the cursor
    await page.keyboard.press("Control+z");
    await expect.poll(forceCount).toBe(3);

    // ── 3. Convert back to geo → destructive reset to the flat two-node seed. ──
    await page.getByRole("button", { name: "Geo" }).click();
    await expect.poll(kind).toBe(0);
    await expect.poll(nodeCount).toBe(2); // the flat seed
    expect(await forceCount()).toBe(0);
    await page.screenshot({ path: join(OUT, "force-3-geo.png") });

    // ── 4. Undo the convert → the force track + its points restored byte-identical. ──
    await page.keyboard.press("Control+z");
    await expect.poll(kind).toBe(1);
    await expect.poll(forceCount).toBe(3); // the three points came back

    if (errors.length) console.log(`KEX_PAGE_NOTES ${JSON.stringify(errors)}`);
});

// The geometry→force atom observability page:
// the ∂F/∂P sparsity heatmap, the round-trip overlay, and the conditioning plot.
// Pure canvas2D (no GPU) rendered on module load; capture the page + each panel.
test("geometry atoms lab", async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    await page.goto(`http://localhost:${PORT}/geometry-lab.html`, { waitUntil: "load" });
    const panels = page.locator(".panel");
    await expect(panels).toHaveCount(3);
    await page.waitForTimeout(500); // let the canvases paint

    await page.screenshot({ path: join(OUT, "geometry-lab.png"), fullPage: true });
    const names = ["geometry-sparsity", "geometry-roundtrip", "geometry-conditioning"];
    for (let i = 0; i < names.length; i++) {
        await panels.nth(i).screenshot({ path: join(OUT, `${names[i]}.png`) });
    }

    if (errors.length) console.log(`KEX_PAGE_NOTES ${JSON.stringify(errors)}`);
});

// The Stage-2 loop-solve observability page:
// draft-vs-solved geometry under the band, the force curve entering the band,
// and the infeasible pin losing loudly. Pure canvas2D rendered on module load.
test("loop solve lab", async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    await page.goto(`http://localhost:${PORT}/loop-lab.html`, { waitUntil: "load" });
    const panels = page.locator(".panel");
    await expect(panels).toHaveCount(3);
    await page.waitForTimeout(500); // let the canvases paint

    await page.screenshot({ path: join(OUT, "loop-lab.png"), fullPage: true });
    const names = ["loop-geometry", "loop-force", "loop-infeasible"];
    for (let i = 0; i < names.length; i++) {
        await panels.nth(i).screenshot({ path: join(OUT, `${names[i]}.png`) });
    }

    if (errors.length) console.log(`KEX_PAGE_NOTES ${JSON.stringify(errors)}`);
});

// The Stage-3 FVD-limit observability page:
// the sketch→oracle overlay on the loop, tracking across aggressiveness, and
// warm-start cost per target edit. Pure canvas2D rendered on module load.
test("FVD limit lab", async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    await page.goto(`http://localhost:${PORT}/fvd-lab.html`, { waitUntil: "load" });
    const panels = page.locator(".panel");
    await expect(panels).toHaveCount(3);
    await page.waitForTimeout(500); // let the canvases paint

    await page.screenshot({ path: join(OUT, "fvd-lab.png"), fullPage: true });
    const names = ["fvd-overlay", "fvd-tracking", "fvd-warmstart"];
    for (let i = 0; i < names.length; i++) {
        await panels.nth(i).screenshot({ path: join(OUT, `${names[i]}.png`) });
    }

    if (errors.length) console.log(`KEX_PAGE_NOTES ${JSON.stringify(errors)}`);
});

// The collocation solver observability page:
// the LM convergence curve, the solved-vs-analytic overlay, and the solved-vs-
// target force. Pure canvas2D (no GPU) rendered on module load.
test("collocation solver lab", async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    await page.goto(`http://localhost:${PORT}/collocate-lab.html`, { waitUntil: "load" });
    const panels = page.locator(".panel");
    await expect(panels).toHaveCount(3);
    await page.waitForTimeout(500); // let the canvases paint

    await page.screenshot({ path: join(OUT, "collocate-lab.png"), fullPage: true });
    const names = ["collocate-convergence", "collocate-overlay", "collocate-force"];
    for (let i = 0; i < names.length; i++) {
        await panels.nth(i).screenshot({ path: join(OUT, `${names[i]}.png`) });
    }

    if (errors.length) console.log(`KEX_PAGE_NOTES ${JSON.stringify(errors)}`);
});

