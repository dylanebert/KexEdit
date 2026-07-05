import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// Boot the kex2d page and drive the point-target GOLDEN PATH end to end (place → typed-precision
// edit → animated Solve-to-fixpoint → cancel-reverts → drift → re-solve → driving/driven →
// delete, kex/specs/kex2d-force-targets.md §Approach), asserting the UI wiring against
// window.__kex at each step and screenshotting the states (including a mid-animation frame).
// The DEV-only __kex hook (src/main.ts) reads target/drift/undo/pose state and induces drift via
// a raw node nudge; the flow itself drives the real UI (double-click, typed fields, Solve/Cancel,
// toggle, Del). Screenshots land in KEX_OUT (a Windows path when staged; copied back).

const PORT = process.env.KEX_PORT ?? "3014";
const OUT = process.env.KEX_OUT ?? "shots";
const SETTLE_MS = Number(process.env.KEX_SETTLE_MS ?? "2500");

// window.__kex is the DEV harness hook (src/main.ts); the harness is outside the project
// tsconfig, so these page-context reads use `any` freely.
type Target = { id: number; s: number; g: number; active: boolean };
type Drift = { id: number; achieved: number; err: number; satisfied: boolean; active: boolean };

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
    const poses = () => page.evaluate((): number[][] => (window as any).__kex.poses());
    const nodeS = (order: number) =>
        page.evaluate((o): number => (window as any).__kex.nodeS(o), order);
    const markerX = async (): Promise<number> => {
        const b = await page.locator(".tmarker").boundingBox();
        if (!b) throw new Error("marker not found");
        return b.x + b.width / 2;
    };

    // seed the representable airtime hill and wait for its first bake.
    await page.evaluate(() => (window as any).__kex.seedHill());
    await expect.poll(tTotal).toBeGreaterThan(0);
    await page.waitForTimeout(SETTLE_MS); // let the cart + curve settle for the baseline shot

    // read-only baseline (empty targets, quiet header).
    await page.screenshot({ path: join(OUT, "full.png") });
    const vp = page.viewportSize();
    if (vp) {
        await page.screenshot({
            path: join(OUT, "timeline.png"),
            clip: { x: 0, y: vp.height - 340, width: vp.width, height: 340 },
        });
    }

    // ── 1. Place: double-click near the crest drops one target, one undo entry. ──
    const cz = await page.locator(".chartzone").boundingBox();
    if (!cz) throw new Error("chartzone not found");
    await page.mouse.dblclick(cz.x + cz.width * 0.45, cz.y + cz.height * 0.5);
    await expect.poll(async () => (await targets()).length).toBe(1);
    expect(await undoDepth()).toBe(1);
    await expect(page.locator(".tmarker")).toHaveCount(1);
    // born selected → the header fields + driving toggle show.
    await expect(page.locator('input[aria-label="Target force (g)"]')).toBeVisible();
    await expect(page.locator(".toggle")).toHaveText("Driving");
    await page.screenshot({ path: join(OUT, "gp-1-create.png") });

    // ── 2. Typed-precision edit: set s to the crest and g to a 0g airtime demand. ──
    const crestS = await nodeS(3);
    const sField = page.locator('input[aria-label="Target distance (m)"]');
    const gField = page.locator('input[aria-label="Target force (g)"]');
    await sField.fill(crestS.toFixed(2));
    await sField.press("Enter");
    await gField.fill("0");
    await gField.press("Enter");
    await expect.poll(async () => Math.abs((await targets())[0].g)).toBeLessThan(1e-3);
    await expect.poll(async () => Math.abs((await targets())[0].s - crestS)).toBeLessThan(0.05);
    // the 0g demand sits off the ~1g curve — the marker drifts, Solve accents.
    await expect.poll(async () => (await drift())[0].satisfied).toBe(false);
    await expect(page.locator(".solve.dirty")).toBeVisible();
    await page.screenshot({ path: join(OUT, "gp-2-typed.png") });

    // ── 3. Solve: ONE click animates to the fixpoint (drift < tol, no sleeps). ──
    const sBefore = (await targets())[0].s;
    const xBefore = await markerX();
    const undoBeforeSolve = await undoDepth();
    await page.locator(".solve").click();
    // it animates — the button becomes a pulsing Cancel while it runs (catch it).
    await expect(page.locator(".solve.running")).toBeVisible();
    await expect(page.locator(".solve")).toHaveText("Cancel");
    await page.screenshot({ path: join(OUT, "gp-3-solving.png") }); // a mid-animation frame
    // then it reaches the fixpoint after the SINGLE click and settles.
    await expect.poll(async () => (await drift())[0].satisfied, { timeout: 8000 }).toBe(true);
    await expect(page.locator(".solve.running")).toHaveCount(0);
    expect(await undoDepth()).toBe(undoBeforeSolve + 1); // one command
    // §4 invariant: the marker did not move — its s is untouched and its screen x
    // is stable across the solve (the axis is distance; only geometry reshaped).
    expect((await targets())[0].s).toBe(sBefore);
    expect(Math.abs((await markerX()) - xBefore)).toBeLessThan(8);
    await page.screenshot({ path: join(OUT, "gp-4-solved.png") });

    // ── 4. Idempotent + cancel: reopen a drift, start a solve, Cancel reverts it. ──
    await page.evaluate(() => (window as any).__kex.nudge(3, -1.2)); // deepen the crest
    await expect.poll(async () => (await drift())[0].satisfied).toBe(false);
    await expect(page.locator(".solve.dirty")).toBeVisible();
    const drifted = await poses();
    const undoBeforeCancel = await undoDepth();
    await page.locator(".solve").click();
    await expect(page.locator(".solve.running")).toBeVisible();
    await page.locator(".solve").click(); // the button is now Cancel — abort
    await expect(page.locator(".solve.running")).toHaveCount(0);
    // a cancelled solve is as if it never ran: pose byte-identical, no undo entry.
    expect(await poses()).toEqual(drifted);
    expect(await undoDepth()).toBe(undoBeforeCancel);

    // ── 5. Re-solve: one click closes the reopened gap (re-anchored to current). ──
    await page.locator(".solve").click();
    await expect.poll(async () => (await drift())[0].satisfied, { timeout: 8000 }).toBe(true);
    // the drift satisfies from the live animation; the undo entry records on
    // completion — wait for the run to settle before counting it.
    await expect(page.locator(".solve.running")).toHaveCount(0);
    expect(await undoDepth()).toBe(undoBeforeCancel + 1);

    // ── 6. Driving → driven: a driven target measures but never drives the solve. ──
    await page.locator(".tmarker").click(); // select it
    await page.locator(".toggle").click(); // driving → driven
    await expect(page.locator(".toggle")).toHaveText("Driven");
    await expect.poll(async () => (await targets())[0].active).toBe(false);
    await page.evaluate(() => (window as any).__kex.nudge(3, -1.2)); // reopen a drift
    await expect.poll(async () => (await drift())[0].satisfied).toBe(false);
    // driven drift never accents Solve, and pressing Solve moves no geometry.
    await expect(page.locator(".solve.dirty")).toHaveCount(0);
    const drivenPose = await poses();
    await page.locator(".solve").click();
    await expect(page.locator(".solve.running")).toHaveCount(0); // nothing to solve — no run
    expect(await poses()).toEqual(drivenPose);
    await page.screenshot({ path: join(OUT, "gp-5-driven.png") });

    // ── 7. Delete: select the marker, press Del — geometry untouched, target gone. ──
    const undoBeforeDelete = await undoDepth();
    await page.locator(".tmarker").click();
    await page.keyboard.press("Delete");
    await expect.poll(async () => (await targets()).length).toBe(0);
    await expect(page.locator(".tmarker")).toHaveCount(0);
    expect(await undoDepth()).toBe(undoBeforeDelete + 1);
    await page.screenshot({ path: join(OUT, "gp-6-delete.png") });

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

