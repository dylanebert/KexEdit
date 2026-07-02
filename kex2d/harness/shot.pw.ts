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

// The wired solver (specs/kex2d-unified-solver.md stage 4): `?demo=solve`
// seeds a dip that breaks the comfort band + a crest force pin; the editor
// must ride SOLVED geometry (realized = solved). `?demo=losing` pins the
// crest at −5 g against band lo −1 — the losing-constraint readout (amber
// chip + timeline whisker). Asserts on the live solve via window.__kexSolve.
test("solver wired", async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
        if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    await page.goto(`http://localhost:${PORT}/?demo=solve`, { waitUntil: "load" });
    await expect(page.locator(".dock")).toBeVisible();
    await page.waitForTimeout(SETTLE_MS); // let the solve settle + the cart ride

    const solve = await page.evaluate(() => {
        const handle = (
            window as unknown as {
                __kexSolve: {
                    solveState: Map<
                        number,
                        {
                            n: number;
                            settled: boolean;
                            suspended: boolean;
                            x: Float64Array;
                            y: Float64Array;
                            report: { kind: string; satisfied: boolean; residual: number }[];
                        }
                    >;
                    samples: Map<number, { posX: Float32Array; posY: Float32Array }>;
                };
            }
        ).__kexSolve;
        for (const [eid, st] of handle.solveState) {
            const s = handle.samples.get(eid);
            if (!s) continue;
            // realized = solved: the f32 samples are the rounded solver output.
            const mid = st.n >> 1;
            const realized =
                s.posX[mid] === Math.fround(st.x[mid]) && s.posY[mid] === Math.fround(st.y[mid]);
            return {
                settled: st.settled,
                suspended: st.suspended,
                realized,
                report: st.report,
            };
        }
        return null;
    });
    if (!solve) throw new Error("no live solve state");
    console.log(`KEX_SOLVE_REPORT ${JSON.stringify(solve.report)}`);
    expect(solve.suspended).toBe(false);
    expect(solve.settled).toBe(true);
    expect(solve.realized).toBe(true);
    for (const r of solve.report) expect(r.satisfied).toBe(true);

    await page.screenshot({ path: join(OUT, "solve-valley.png") });

    // pin authoring on the curve (stage 5): double-click the chart adds a
    // pin at (σ, g) under the cursor; a drag near its diamond slides anchor
    // + target; the summoned chip appears on selection. drive it for real
    // and assert the authored set grew.
    const chart = page.locator(".dock .body canvas");
    const box = await chart.boundingBox();
    if (!box) throw new Error("no chart box");
    const cx = box.x + box.width * 0.35;
    const cy = box.y + box.height * 0.6;
    // raw mouse coordinates: the interaction surface is the svg chartzone
    // rect layered over the canvas, which locator clicks refuse to click
    // "through".
    await page.mouse.dblclick(cx, cy);
    await page.waitForTimeout(300);
    const pins = await page.evaluate(() => {
        const handle = (
            window as unknown as {
                __kexSolve: {
                    solveState: Map<number, { report: { kind: string }[] }>;
                };
            }
        ).__kexSolve;
        for (const [, st] of handle.solveState) {
            return st.report.filter((r) => r.kind === "pin").length;
        }
        return 0;
    });
    console.log(`KEX_PINS_AFTER_DBLCLICK ${pins}`);
    expect(pins).toBe(2); // the demo pin + the authored one
    await expect(page.locator(".pinchip")).toBeVisible(); // selected on add

    // drag the new pin: anchor slides right, target slides up.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 60, cy - 20, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(SETTLE_MS / 2);
    await page.screenshot({ path: join(OUT, "solve-pin-authored.png") });

    // the relax verb (stage 6): commit the sketch toward the solve — the
    // ghost collapses onto the track, one undoable entry.
    await expect(page.locator(".relax")).toBeVisible();
    await page.locator(".relax").click();
    await page.waitForTimeout(SETTLE_MS / 2);
    const relaxed = await page.evaluate(() => {
        const handle = (
            window as unknown as {
                __kexSolve: {
                    solveState: Map<
                        number,
                        {
                            n: number;
                            settled: boolean;
                            x: Float64Array;
                            y: Float64Array;
                            draftX: Float64Array;
                            draftY: Float64Array;
                        }
                    >;
                };
            }
        ).__kexSolve;
        for (const [, st] of handle.solveState) {
            // ghost gap, point-to-segment: after relax the sketch generates
            // (approximately) what the solve wants.
            let max = 0;
            for (let i = 0; i < st.n; i++) {
                let best = Number.POSITIVE_INFINITY;
                for (let j = 0; j < st.n - 1; j++) {
                    const ex = st.draftX[j + 1] - st.draftX[j];
                    const ey = st.draftY[j + 1] - st.draftY[j];
                    const ee = ex * ex + ey * ey;
                    let u = ee > 0 ? ((st.x[i] - st.draftX[j]) * ex + (st.y[i] - st.draftY[j]) * ey) / ee : 0;
                    u = Math.max(0, Math.min(1, u));
                    best = Math.min(
                        best,
                        Math.hypot(st.x[i] - (st.draftX[j] + u * ex), st.y[i] - (st.draftY[j] + u * ey)),
                    );
                }
                max = Math.max(max, best);
            }
            return { settled: st.settled, ghostGap: max };
        }
        return null;
    });
    if (!relaxed) throw new Error("no live solve after relax");
    console.log(`KEX_RELAX ${JSON.stringify(relaxed)}`);
    expect(relaxed.ghostGap).toBeLessThan(0.5);
    await page.screenshot({ path: join(OUT, "solve-relaxed.png") });

    await page.goto(`http://localhost:${PORT}/?demo=losing`, { waitUntil: "load" });
    await expect(page.locator(".dock")).toBeVisible();
    await page.waitForTimeout(SETTLE_MS);
    // the losing pin: amber chip up, residual ≈ 4 g in the report.
    await expect(page.locator(".warning.losing")).toBeVisible();
    await page.screenshot({ path: join(OUT, "solve-losing.png") });

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
