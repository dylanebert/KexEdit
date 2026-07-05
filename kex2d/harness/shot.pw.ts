import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// Boot the kex2d page, let the cart + curve settle, then screenshot the READ-ONLY timeline for
// UI review — the authored track + the baked F_n force curve + navigation. Force-constraint
// authoring lands with the unified solver (specs/kex2d-unified-solver.md), so there is nothing
// to author here yet.
// Screenshots land in KEX_OUT (a Windows path when staged; the orchestrator copies them back).

const PORT = process.env.KEX_PORT ?? "3014";
const OUT = process.env.KEX_OUT ?? "shots";
const SETTLE_MS = Number(process.env.KEX_SETTLE_MS ?? "2500");

test("kex2d timeline", async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
    await expect(page.locator(".dock")).toBeVisible();
    await expect(page.locator(".player")).toBeVisible();
    await page.waitForTimeout(SETTLE_MS); // let the cart + curve draw a few frames

    await page.screenshot({ path: join(OUT, "full.png") });

    // a tight crop of the timeline region (player + dock) for spacing/padding review
    const vp = page.viewportSize();
    if (vp) {
        await page.screenshot({
            path: join(OUT, "timeline.png"),
            clip: { x: 0, y: vp.height - 240, width: vp.width, height: 240 },
        });
        // a tighter crop of just the player bar + ruler + top of chart, to scrutinize
        // internal padding and the player↔ruler↔chart vertical rhythm.
        await page.screenshot({
            path: join(OUT, "top.png"),
            clip: { x: 70, y: vp.height - 210, width: 1300, height: 120 },
        });
    }

    if (errors.length) console.log(`KEX_PAGE_NOTES ${JSON.stringify(errors)}`);
});

// The geometry→force atom observability page (specs/kex2d-unified-solver.md):
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

// The Stage-2 loop-solve observability page (specs/kex2d-unified-solver.md):
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

// The Stage-3 FVD-limit observability page (specs/kex2d-unified-solver.md):
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

// The collocation solver observability page (specs/kex2d-unified-solver.md):
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

// The Stage-3 force-target golden path (kex/specs/kex2d-force-targets.md): create →
// demand → drift → re-solve → delete, driven through the real timeline input and
// asserted against the DEV `window.__kex` inspection hook. This is the surface's real
// verification — the harness stops being screenshot-only for the force-target UX.
// biome-ignore lint/suspicious/noExplicitAny: the browser-side hook is untyped here.
type Kex = any;
test("force-target golden path", async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });
    await expect(page.locator(".dock")).toBeVisible();

    // lay the representable airtime hill (crest at order 3) so a demand has a crest to
    // reshape; wait for the bake so the chart + drag zone render.
    await page.evaluate(() => (window as unknown as { __kex: Kex }).__kex.seedHill());
    const chartzone = page.locator(".chartzone");
    await expect(chartzone).toBeVisible();

    const targetCount = (): Promise<number> =>
        page.evaluate(() => (window as unknown as { __kex: Kex }).__kex.targets().length);
    const firstG = (): Promise<number> =>
        page.evaluate(() => (window as unknown as { __kex: Kex }).__kex.targets()[0].g);
    const firstSatisfied = (): Promise<boolean> =>
        page.evaluate(() => (window as unknown as { __kex: Kex }).__kex.drift()[0].satisfied);
    const drag = async (x0: number, y0: number, x1: number, y1: number): Promise<void> => {
        await page.mouse.move(x0, y0);
        await page.mouse.down();
        for (let i = 1; i <= 8; i++)
            await page.mouse.move(x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8);
        await page.mouse.up();
    };

    // ── create: drag-select a span over the crest on the chart ──
    const chart = await chartzone.boundingBox();
    if (!chart) throw new Error("no chartzone box");
    const cy = chart.y + chart.height / 2;
    await drag(chart.x + chart.width * 0.32, cy, chart.x + chart.width * 0.62, cy);
    await expect.poll(targetCount).toBe(1);
    const born = await firstG();
    await page.screenshot({ path: join(OUT, "gp-1-create.png") });

    // ── demand: drag the band vertically; the live RTI solve reshapes the crest ──
    // (a horizontal SVG <line> has a zero-height client rect, so read its screen
    // midpoint directly rather than boundingBox/toBeVisible, which call it hidden.)
    const bandhit = page.locator(".bandhit");
    await bandhit.waitFor({ state: "attached" });
    const mid = await bandhit.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
    });
    await drag(mid.x, mid.y, mid.x, mid.y + chart.height * 0.05); // a small, feasible demand
    await expect.poll(firstG).not.toBe(born); // the target value moved
    await expect.poll(firstSatisfied).toBe(true); // the curve followed the band
    await page.screenshot({ path: join(OUT, "gp-2-demand.png") });

    // ── drift: a later geometry edit shoves the crest off the band ──
    await page.evaluate(() => (window as unknown as { __kex: Kex }).__kex.nudge(3, 2));
    await expect.poll(firstSatisfied).toBe(false);
    await expect(page.locator(".resolve")).toBeVisible(); // ⟳ summoned only on drift
    await page.screenshot({ path: join(OUT, "gp-3-drift.png") });

    // ── re-solve: the summoned ⟳ pulls the curve back onto the band ──
    await page.locator(".resolve").click();
    await expect.poll(firstSatisfied).toBe(true);
    await expect(page.locator(".resolve")).toHaveCount(0); // quiet again
    await page.screenshot({ path: join(OUT, "gp-4-resolve.png") });

    // ── delete: select the chip, Del; the target goes, geometry stays ──
    await page.locator(".chip").click();
    await page.keyboard.press("Delete");
    await expect.poll(targetCount).toBe(0);
    await page.screenshot({ path: join(OUT, "gp-5-delete.png") });

    expect(pageErrors).toEqual([]);
});
