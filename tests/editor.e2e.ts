import { expect, test, type Page } from "@playwright/test";

const shell = '[data-region="shell"][data-shell-ready="true"]';
async function step(page: Page, dt = 0) {
    await page.evaluate(dt => window.kexeditSubject!.step(dt), dt);
}
async function open(page: Page, query = "") {
    await page.goto(`/?stepped${query}`);
    await page.locator(shell).waitFor();
    await page.locator('[data-shallot-loading]').waitFor({ state: "detached" });
}
async function canvasPixels(page: Page) {
    const png = await page.locator("canvas").screenshot();
    return page.evaluate(async base64 => {
        const image = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))]));
        const canvas = new OffscreenCanvas(image.width, image.height);
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(image, 0, 0);
        const result = { width: image.width, height: image.height,
            rgba: Array.from(ctx.getImageData(0, 0, image.width, image.height).data) };
        image.close();
        return result;
    }, png.toString("base64"));
}
function watchErrors(page: Page) {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    return errors;
}

test("built stepped page presents the editor, accepts transport, timeline and orbit input, and remounts cleanly", async ({ page }, testInfo) => {
    const errors = watchErrors(page);
    await open(page);
    console.info("KexEdit browser adapter", await page.evaluate(() => window.kexeditSubject!.adapter()));
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    await expect(page.locator("canvas")).toHaveCount(1);
    const canvas = page.locator("canvas");
    const view = await canvas.boundingBox();
    const context = await page.locator('[data-region="context"]').boundingBox();
    const timeline = await page.locator('[data-region="timeline"]').boundingBox();
    const status = await page.locator('[data-region="status"]').boundingBox();
    expect(context!.x + context!.width).toBeLessThanOrEqual(view!.x);
    expect(timeline!.y).toBeGreaterThan(view!.y);
    expect(status!.y).toBeGreaterThanOrEqual(timeline!.y + timeline!.height);
    const frame = await canvasPixels(page);
    expect(frame.width).toBeGreaterThan(400);
    expect(frame.height).toBeGreaterThan(200);
    expect(frame.rgba.some((v, i) => v !== frame.rgba[i % 4])).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("editor.png") });
    await testInfo.attach("editor", { path: testInfo.outputPath("editor.png"), contentType: "image/png" });

    const ruler = page.getByRole("slider", { name: "Timeline playhead" });
    const playIcon = page.getByRole("button", { name: "Play", exact: true }).locator("svg");
    await expect(playIcon).toHaveAttribute("fill", "currentColor");
    await expect(playIcon).toHaveAttribute("stroke-width", "0");
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await step(page, 0.05);
    await expect(ruler).toHaveAttribute("aria-valuenow", "5");
    const pauseIcon = page.getByRole("button", { name: "Pause", exact: true }).locator("svg");
    await expect(pauseIcon).toHaveAttribute("fill", "currentColor");
    await expect(pauseIcon).toHaveAttribute("stroke-width", "0");
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await step(page, 0.05);
    await expect(ruler).toHaveAttribute("aria-valuenow", "5");
    await ruler.focus();
    await page.keyboard.press("Home");
    await expect(ruler).toHaveAttribute("aria-valuenow", "0");
    await page.keyboard.press("Shift+ArrowRight");
    await expect(ruler).toHaveAttribute("aria-valuenow", "100");
    const bounds = await ruler.boundingBox();
    await page.mouse.click(bounds!.x + bounds!.width * 0.5, bounds!.y + bounds!.height / 2);
    expect(Number(await ruler.getAttribute("aria-valuenow"))).toBeGreaterThan(1000);
    const surface = page.locator('[data-region="timeline-surface"]');
    const span = Number(await surface.getAttribute("data-view-span"));
    await page.mouse.wheel(0, -300);
    await expect.poll(async () => Number(await surface.getAttribute("data-view-span"))).toBeLessThan(span);
    await ruler.focus(); await page.keyboard.press("f");
    await expect.poll(async () => Number(await surface.getAttribute("data-view-span"))).toBeCloseTo(span, 3);

    await page.keyboard.press("Home"); await step(page);
    const before = await canvasPixels(page);
    await page.mouse.move(view!.x + view!.width * 0.5, view!.y + view!.height * 0.5);
    await page.mouse.down(); await step(page, 1 / 60);
    await page.mouse.move(view!.x + view!.width * 0.65, view!.y + view!.height * 0.6, { steps: 5 });
    await step(page, 1 / 60); await page.mouse.up(); await step(page, 1 / 60);
    const after = await canvasPixels(page);
    expect(after.rgba.filter((v, i) => Math.abs(v - before.rgba[i]) > 8).length).toBeGreaterThan(100);

    await page.mouse.wheel(0, -300);
    await step(page, 1 / 60);
    const zoomed = await canvasPixels(page);
    expect(zoomed.rgba.filter((v, i) => Math.abs(v - after.rgba[i]) > 8).length).toBeGreaterThan(100);
    await page.screenshot({ path: testInfo.outputPath("editor-orbit-zoom.png") });
    await testInfo.attach("editor-orbit-zoom", { path: testInfo.outputPath("editor-orbit-zoom.png"), contentType: "image/png" });

    await page.evaluate(() => window.kexeditSubject!.unmount());
    await expect(canvas).toHaveCount(0);
    expect(await page.evaluate(() => window.kexeditSubject!.app === undefined)).toBe(true);
    await page.evaluate(() => window.kexeditSubject!.mount());
    await page.locator(shell).waitFor();
    await expect(canvas).toHaveCount(1);
    await expect(ruler).toHaveAttribute("aria-valuenow", "0");
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await step(page, 0.05);
    await expect(ruler).toHaveAttribute("aria-valuenow", "5");
    expect(errors).toEqual([]);
});

test("built refused ride shows its unsolved tail and keeps the authored timeline endpoint", async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, "&fixture=stalled");
    await expect(page.locator('[data-region="dead-tail"]')).toBeVisible();
    await expect(page.locator('[data-region="end-mark"]')).toBeVisible();
    const ruler = page.getByRole("slider", { name: "Timeline playhead" });
    await ruler.focus(); await page.keyboard.press("End"); await step(page);
    expect(await ruler.getAttribute("aria-valuenow")).toBe(await ruler.getAttribute("aria-valuemax"));
    expect(errors).toEqual([]);
});
