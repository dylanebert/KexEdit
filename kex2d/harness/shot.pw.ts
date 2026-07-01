import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// Boot the kex2d page, let the cart + curve settle, then screenshot the timeline for UI review.
// Authors a couple of force pins so the shot exercises pins + the constraint curve + tangent
// handles — a richer review than the bare seeded track. Screenshots land in KEX_OUT (a Windows
// path when staged; the orchestrator copies them back).

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

    // author two force pins (double-click to add — Unity/AE convention), then re-shoot:
    // exercises pins, the dashed constraint curve, and the selected pin's tangent handles.
    // then double-click a pin to open the inline value editor and shoot that too. best-effort:
    // a miss must not fail the capture, so the bare-track shots above are always produced first.
    try {
        const box = await page.locator(".dock").boundingBox();
        if (box) {
            // the chart band sits below the ruler+gap (~34px from the dock top); add safely inside
            const ax = box.x + box.width * 0.38;
            // one pin first — its tangent handles must show even with no neighbor
            await page.mouse.dblclick(ax, box.y + 85);
            await page.waitForTimeout(400);
            await page.screenshot({ path: join(OUT, "onepin.png") });
            // add a second pin → constraint curve + both pins' handles
            await page.mouse.dblclick(box.x + box.width * 0.62, box.y + 55);
            await page.waitForTimeout(500);
            await page.locator(".dock").hover(); // summon the active pin's tangent handles
            await page.waitForTimeout(200);
            await page.screenshot({ path: join(OUT, "pins.png") });

            // double-click the first pin to open the inline value editor. target the pin's
            // hit-circle directly: pins snap to the curve value on add, so a fixed click
            // height misses them (and the band positions shift with the dock layout).
            await page.locator(".pin-hit").first().dblclick();
            await page.waitForTimeout(250);
            const ed = await page.locator(".pin-editor").boundingBox();
            if (ed) {
                await page.screenshot({
                    path: join(OUT, "editor.png"),
                    clip: {
                        x: Math.max(0, ed.x - 40),
                        y: Math.max(0, ed.y - 30),
                        width: ed.width + 80,
                        height: ed.height + 60,
                    },
                });
            }
        }
    } catch (e) {
        errors.push(`pin authoring skipped: ${e}`);
    }

    if (errors.length) console.log(`KEX_PAGE_NOTES ${JSON.stringify(errors)}`);
});
