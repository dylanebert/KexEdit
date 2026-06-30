import { defineConfig } from "@playwright/test";

// Layered timeouts so a stuck flow fails in seconds, never hangs (a missing locator, a blank canvas).
// The orchestrator adds a spawn ceiling above these as a last-resort backstop (playwright.ts).
export default defineConfig({
    testDir: ".",
    testMatch: "shot.pw.ts",
    fullyParallel: false,
    retries: 0,
    workers: 1,
    reporter: [["list"]],
    timeout: 60_000,
    globalTimeout: 120_000,

    expect: { timeout: 5_000 },

    use: {
        trace: "off",
        video: "off",
        headless: false,
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2, // crisp text/lines for UI review
        actionTimeout: 15_000,
        navigationTimeout: 15_000,
    },

    projects: [{ name: "chromium", use: { channel: "chrome" } }],
});
