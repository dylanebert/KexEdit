import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// Boot the kex2d page and drive the point-target GOLDEN PATH end to end (place → adjust →
// solve → drift → solve → delete, kex/specs/kex2d-force-targets.md §Approach), asserting the
// UI wiring against window.__kex at each step and screenshotting the states for UI review.
// The DEV-only __kex hook (src/main.ts) reads target/drift/undo state and induces drift via a
// raw node nudge; the flow itself drives the real UI (double-click, marker drag, Solve, Del).
// Screenshots land in KEX_OUT (a Windows path when staged; the orchestrator copies them back).

const PORT = process.env.KEX_PORT ?? "3014";
const OUT = process.env.KEX_OUT ?? "shots";
const SETTLE_MS = Number(process.env.KEX_SETTLE_MS ?? "2500");

// window.__kex is the DEV harness hook (src/main.ts); the harness is outside the project
// tsconfig, so these page-context reads use `any` freely.
type Target = { id: number; s: number; g: number };
type Drift = { id: number; achieved: number; err: number; satisfied: boolean };

test("point-target golden path", async ({ page }) => {
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
    const targets = () => page.evaluate((): Target[] => (window as any).__kex.targets());
    const drift = () => page.evaluate((): Drift[] => (window as any).__kex.drift());
    const undoDepth = () => page.evaluate((): number => (window as any).__kex.undoDepth());
    const tTotal = () => page.evaluate((): number => (window as any).__kex.tTotal());

    // seed the representable airtime hill and wait for its first bake.
    await page.evaluate(() => (window as any).__kex.seedHill());
    await expect.poll(tTotal).toBeGreaterThan(0);
    await page.waitForTimeout(SETTLE_MS); // let the cart + curve settle for the baseline shot

    // read-only baseline (empty targets) — the same review crops as before.
    await page.screenshot({ path: join(OUT, "full.png") });
    const vp = page.viewportSize();
    if (vp) {
        await page.screenshot({
            path: join(OUT, "timeline.png"),
            clip: { x: 0, y: vp.height - 240, width: vp.width, height: 240 },
        });
        await page.screenshot({
            path: join(OUT, "top.png"),
            clip: { x: 70, y: vp.height - 210, width: 1300, height: 120 },
        });
    }

    // ── 1. Place: double-click mid-chart drops one target, one undo entry. ──
    const cz = await page.locator(".chartzone").boundingBox();
    if (!cz) throw new Error("chartzone not found");
    await page.mouse.dblclick(cz.x + cz.width * 0.45, cz.y + cz.height * 0.5);
    await expect.poll(async () => (await targets()).length).toBe(1);
    expect(await undoDepth()).toBe(1);
    await expect(page.locator(".tmarker")).toHaveCount(1);
    await page.screenshot({ path: join(OUT, "gp-1-create.png") });

    // ── 2. Adjust: drag the marker up (raise the demand) — off the curve, one entry. ──
    const gBefore = (await targets())[0].g;
    const mk = await page.locator(".tmarker").boundingBox();
    if (!mk) throw new Error("marker not found");
    const mcx = mk.x + mk.width / 2;
    const mcy = mk.y + mk.height / 2;
    await page.mouse.move(mcx, mcy);
    await page.mouse.down();
    await page.mouse.move(mcx, mcy - 55, { steps: 8 }); // screen-up = higher g
    await page.mouse.up();
    await expect.poll(async () => (await targets())[0].g).toBeGreaterThan(gBefore + 0.2);
    expect(await undoDepth()).toBe(2);
    // the demand now sits off the curve — the Solve button accents, the marker turns drift.
    await expect.poll(async () => (await drift())[0].satisfied).toBe(false);
    await expect(page.locator(".solve.dirty")).toBeVisible();
    await page.screenshot({ path: join(OUT, "gp-2-adjust.png") });

    // ── 3. Solve: the batch invocation reshapes the track toward the demand. ──
    const errBefore = (await drift())[0].err;
    await page.locator(".solve").click();
    await page.screenshot({ path: join(OUT, "gp-3-solve.png") }); // catch the freed-node flash
    await expect.poll(async () => (await drift())[0].err).toBeLessThan(errBefore - 0.05);
    expect(await undoDepth()).toBe(3);

    // ── 4. Drift: a later node edit (raw nudge) moves the curve back off the point. ──
    const errSolved = (await drift())[0].err;
    await page.evaluate(() => (window as any).__kex.nudge(3, -1.5)); // deepen the crest near the target
    await expect.poll(async () => (await drift())[0].err).toBeGreaterThan(errSolved + 0.05);
    await expect(page.locator(".solve.dirty")).toBeVisible();
    await page.screenshot({ path: join(OUT, "gp-4-drift.png") });

    // ── 5. Solve again: re-anchor to current geometry, close the reopened gap. ──
    const errDrifted = (await drift())[0].err;
    const undoBeforeReSolve = await undoDepth();
    await page.locator(".solve").click();
    await expect.poll(async () => (await drift())[0].err).toBeLessThan(errDrifted - 0.05);
    expect(await undoDepth()).toBeGreaterThan(undoBeforeReSolve);

    // ── 6. Delete: select the marker, press Del — geometry untouched, target gone. ──
    const undoBeforeDelete = await undoDepth();
    await page.locator(".tmarker").click();
    await page.keyboard.press("Delete");
    await expect.poll(async () => (await targets()).length).toBe(0);
    await expect(page.locator(".tmarker")).toHaveCount(0);
    expect(await undoDepth()).toBe(undoBeforeDelete + 1);
    await page.screenshot({ path: join(OUT, "gp-5-delete.png") });

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

