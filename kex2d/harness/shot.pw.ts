import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// Boot the kex2d page, let the cart + curve settle, then screenshot the READ-ONLY timeline for
// UI review — the authored track + the baked F_n force curve + navigation. Authoring force
// constraints is a future scope-first spike (roadmap "kex2d"), so there is nothing to author here.
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
