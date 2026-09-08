import { expect, test } from "./flow";

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
