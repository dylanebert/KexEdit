import { resolve } from "node:path";
import { check } from "@dylanebert/shallot/harness/check";
import { chromium, type Page } from "playwright";
import launch from "@dylanebert/shallot/harness/browser" with { type: "json" };

const ROOT = resolve(import.meta.dir, "..");

async function waitForServer(url: string, server: ReturnType<typeof Bun.spawn>): Promise<void> {
    const deadline = performance.now() + 15_000;
    while (performance.now() < deadline) {
        if (server.exitCode !== null) throw new Error(`vite exited with ${server.exitCode}`);
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(500) });
            if (response.ok) return;
        } catch {
            // Vite is still starting.
        }
        await Bun.sleep(50);
    }
    throw new Error(`timed out waiting for Vite at ${url}`);
}

function freePort(): number {
    const listener = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: { data() {} },
    });
    const port = listener.port;
    listener.stop();
    return port;
}

check(
    "the KexEdit canvas boots in Chromium and reaches the final compositor",
    {
        claim: "the view fails to boot or leaves a blank canvas",
        size: "integration",
        requires: ["chromium"],
        subject: [
            "src/App.svelte",
            "src/View.svelte",
            "src/capability.ts",
            "src/app.css",
            "src/grid.ts",
            "public/scenes/scaffold.scene",
        ],
        budget: 20_000,
    },
    async () => {
        const port = freePort();
        const url = `http://127.0.0.1:${port}/`;
        const server = Bun.spawn(
            [process.execPath, "run", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
            { cwd: ROOT, stdout: "ignore", stderr: "ignore" },
        );
        let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
        let page: Page | undefined;
        let reducedPage: Page | undefined;
        let blockedPage: Page | undefined;
        const errors: string[] = [];
        try {
            await waitForServer(url, server);
            browser = await chromium.launch({ headless: false, ...launch });
            const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
            page = await context.newPage();
            page.on("pageerror", (error) => errors.push(error.message));
            page.on("console", (message) => {
                if (message.type() === "error") errors.push(message.text());
            });
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10_000 });
            const bootEvidence = await page.evaluate(() => {
                const overlay = [...document.body.children].find(
                    (candidate) => getComputedStyle(candidate).zIndex === "10000",
                );
                const shell = document.querySelector("[data-shell-ready]");
                const rect = overlay?.getBoundingClientRect();
                return {
                    seen: Boolean(overlay),
                    fullPage:
                        rect !== undefined &&
                        rect.left === 0 &&
                        rect.top === 0 &&
                        rect.width >= window.innerWidth &&
                        rect.height >= window.innerHeight,
                    hasSplash: overlay?.querySelector("svg") !== null,
                    shellHidden: shell?.getAttribute("data-shell-ready") === "false",
                };
            });
            if (!bootEvidence.seen || !bootEvidence.fullPage || !bootEvidence.hasSplash || !bootEvidence.shellHidden) {
                throw new Error(`full-page Shallot splash handoff failed: ${JSON.stringify(bootEvidence)}`);
            }
            await page.waitForFunction(() => window.__harness?.ready === true, undefined, {
                timeout: 15_000,
            });
            // Let the short compositor entrance settle before measuring seam geometry; transforms would
            // otherwise make a one-pixel divider appear displaced while the panes are scaling in.
            await page.waitForTimeout(260);
            const shellEvidence = await page.evaluate(async () => {
                const shell = document.querySelector<HTMLElement>("[data-region=shell]");
                const context = document.querySelector<HTMLElement>("[data-region=context]");
                const viewPane = document.querySelector<HTMLElement>("[data-region=view]");
                const view = document.querySelector<HTMLElement>("[data-region=view-surface]");
                const timeline = document.querySelector<HTMLElement>("[data-region=timeline-track]");
                const timelinePane = document.querySelector<HTMLElement>("[data-region=timeline]");
                const status = document.querySelector<HTMLElement>("[data-region=status]");
                const canvas = document.querySelector<HTMLCanvasElement>("canvas");
                if (!shell || !context || !viewPane || !view || !timeline || !timelinePane || !status || !canvas) {
                    return { ready: false, flat: false, dividers: false, gap: false, clearMatch: false };
                }
                const style = (element: HTMLElement) => getComputedStyle(element);
                const grounds = [context, view, timeline, status].map((element) => style(element).backgroundColor);
                const border = "rgb(60, 56, 54)";
                const noOuterBorder = (element: HTMLElement, allowed: "borderLeftWidth" | "borderTopWidth" | null) =>
                    ["borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"].every(
                        (side) => side === allowed || style(element)[side as "borderTopWidth"] === "0px",
                    );
                const divider = (element: HTMLElement, side: "borderLeftWidth" | "borderTopWidth") =>
                    style(element)[side] === "1px" &&
                    style(element)[side === "borderLeftWidth" ? "borderLeftColor" : "borderTopColor"] === border;
                const contextRect = context.getBoundingClientRect();
                const viewRect = viewPane.getBoundingClientRect();
                const timelineRect = timelinePane.getBoundingClientRect();
                const statusRect = status.getBoundingClientRect();
                const gapValues = [
                    viewRect.left - contextRect.right,
                    timelineRect.top - contextRect.bottom,
                    statusRect.top - timelineRect.bottom,
                ];
                const paneColor = style(context).backgroundColor;
                const rgb = paneColor.match(/\d+/g)?.map(Number) ?? [];
                const dataUrl = canvas.toDataURL("image/png");
                const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
                const sampleSurface = new OffscreenCanvas(bitmap.width, bitmap.height);
                const sampleContext = sampleSurface.getContext("2d");
                if (!sampleContext || rgb.length !== 3) {
                    bitmap.close();
                    return { ready: false, flat: false, dividers: false, gap: false, clearMatch: false };
                }
                sampleContext.drawImage(bitmap, 0, 0);
                const image = sampleContext.getImageData(0, 0, bitmap.width, bitmap.height);
                const samplePoints = [0.08, 0.32, 0.68, 0.92].map((fraction) => [
                    Math.min(bitmap.width - 1, Math.floor(bitmap.width * fraction)),
                    1,
                ]);
                const samples = samplePoints.map(([x, y]) => {
                    const index = (y * bitmap.width + x) * 4;
                    return [image.data[index], image.data[index + 1], image.data[index + 2]];
                });
                bitmap.close();
                const distance = (sample: number[]) =>
                    Math.max(...sample.map((channel, index) => Math.abs(channel - (rgb[index] ?? 0))));
                const clearMatches = samples.filter((sample) => distance(sample) <= 2).length;
                const animation = style(context);
                return {
                    ready: shell.dataset.shellReady === "true" && shell.getAttribute("aria-hidden") === "false",
                    flat: grounds.every((ground) => ground === "rgb(29, 32, 33)"),
                    dividers:
                        noOuterBorder(context, null) &&
                        noOuterBorder(viewPane, "borderLeftWidth") &&
                        noOuterBorder(timelinePane, "borderTopWidth") &&
                        noOuterBorder(status, "borderTopWidth") &&
                        divider(viewPane, "borderLeftWidth") &&
                        divider(timelinePane, "borderTopWidth") &&
                        divider(status, "borderTopWidth"),
                    gap: gapValues.every((value) => Math.abs(value) < 0.1),
                    gapValues,
                    clearMatch: clearMatches >= 3,
                    paneColor,
                    clearSamples: samples,
                    clearMatches,
                    animation: animation.animationName === "pane-enter" && animation.animationDuration === "0.18s",
                };
            });
            if (
                !shellEvidence.ready ||
                !shellEvidence.flat ||
                !shellEvidence.dividers ||
                !shellEvidence.gap ||
                !shellEvidence.clearMatch ||
                !shellEvidence.animation
            ) {
                throw new Error(`shell handoff/divider/zero-gap/clear-color/entrance failed: ${JSON.stringify(shellEvidence)}`);
            }
            await page.waitForTimeout(260);
            const entranceEvidence = await page.evaluate(() => {
                const elements = [
                    ...document.querySelectorAll<HTMLElement>("[data-region=context], [data-region=view], [data-region=timeline], [data-region=status]"),
                ];
                const identity = (transform: string) =>
                    transform === "none" || transform.replaceAll(" ", "") === "matrix(1,0,0,1,0,0)";
                return {
                    count: elements.length,
                    complete: elements.length === 4 && elements.every((element) => {
                        const computed = getComputedStyle(element);
                        return computed.opacity === "1" && identity(computed.transform);
                    }),
                };
            });
            if (!entranceEvidence.complete) {
                throw new Error(`pane entrance did not settle: ${JSON.stringify(entranceEvidence)}`);
            }
            const shellScreenshot = await page.screenshot({ type: "png" });
            const seamEvidence = await page.evaluate(async (encodedScreenshot) => {
                const image = new Image();
                image.src = `data:image/png;base64,${encodedScreenshot}`;
                await image.decode();
                const surface = document.createElement("canvas");
                surface.width = image.naturalWidth;
                surface.height = image.naturalHeight;
                const context = surface.getContext("2d");
                const contextPane = document.querySelector<HTMLElement>("[data-region=context]");
                const viewPane = document.querySelector<HTMLElement>("[data-region=view]");
                const timelinePane = document.querySelector<HTMLElement>("[data-region=timeline]");
                const status = document.querySelector<HTMLElement>("[data-region=status]");
                if (!context || !contextPane || !viewPane || !timelinePane || !status) {
                    return { pass: false, sequences: {} as Record<string, string[]> };
                }
                context.drawImage(image, 0, 0);
                const pixels = context.getImageData(0, 0, surface.width, surface.height).data;
                const scaleX = surface.width / window.innerWidth;
                const scaleY = surface.height / window.innerHeight;
                const colorAt = (x: number, y: number): string => {
                    const pixelX = Math.max(0, Math.min(surface.width - 1, Math.round(x * scaleX)));
                    const pixelY = Math.max(0, Math.min(surface.height - 1, Math.round(y * scaleY)));
                    const index = (pixelY * surface.width + pixelX) * 4;
                    return [pixels[index], pixels[index + 1], pixels[index + 2], pixels[index + 3]]
                        .map((channel) => channel.toString(16).padStart(2, "0"))
                        .join("");
                };
                const horizontal = (left: number, y: number): string[] => {
                    const seam = Math.round(left);
                    return [colorAt(seam - 1, y), colorAt(seam, y), colorAt(seam + 1, y)];
                };
                const vertical = (top: number, x: number): string[] => {
                    const seam = Math.round(top);
                    return [colorAt(x, seam - 1), colorAt(x, seam), colorAt(x, seam + 1)];
                };
                const contextRect = contextPane.getBoundingClientRect();
                const viewRect = viewPane.getBoundingClientRect();
                const timelineRect = timelinePane.getBoundingClientRect();
                const statusRect = status.getBoundingClientRect();
                const sequences = {
                    "context-view": horizontal(contextRect.right, contextRect.top + contextRect.height / 2),
                    "view-timeline": vertical(viewRect.bottom, viewRect.left + viewRect.width * 0.75),
                    "timeline-status": vertical(timelineRect.bottom, statusRect.left + statusRect.width * 0.75),
                };
                const dividerColor = "3c3836ff";
                return {
                    pass: Object.values(sequences).every(
                        (sequence) =>
                            sequence.length === 3 &&
                            sequence[1] === dividerColor &&
                            sequence.filter((color) => color === dividerColor).length === 1,
                    ),
                    sequences,
                };
            }, shellScreenshot.toString("base64"));
            if (!seamEvidence.pass) {
                throw new Error(`pane divider pixel sequence failed: ${JSON.stringify(seamEvidence)}`);
            }
            reducedPage = await browser.newPage();
            await reducedPage.emulateMedia({ reducedMotion: "reduce" });
            await reducedPage.goto(url, { waitUntil: "domcontentloaded", timeout: 10_000 });
            await reducedPage.waitForFunction(() => window.__harness?.ready === true, undefined, { timeout: 15_000 });
            const reducedMotionEvidence = await reducedPage.evaluate(() => {
                const shell = document.querySelector<HTMLElement>("[data-region=shell]");
                const pane = document.querySelector<HTMLElement>("[data-region=context]");
                const status = document.querySelector<HTMLElement>("[data-region=status]");
                if (!shell || !pane || !status) return { reduced: false };
                const paneStyle = getComputedStyle(pane);
                const statusStyle = getComputedStyle(status);
                return {
                    reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
                    ready: shell.dataset.shellReady === "true",
                    animation: paneStyle.animationName,
                    paneStable: paneStyle.opacity === "1" && paneStyle.transform === "none",
                    statusStable: statusStyle.opacity === "1" && statusStyle.transform === "none",
                };
            });
            if (
                !reducedMotionEvidence.reduced ||
                !reducedMotionEvidence.ready ||
                reducedMotionEvidence.animation !== "none" ||
                !reducedMotionEvidence.paneStable ||
                !reducedMotionEvidence.statusStable
            ) {
                throw new Error(`reduced-motion entrance failed: ${JSON.stringify(reducedMotionEvidence)}`);
            }
            blockedPage = await browser.newPage();
            await blockedPage.addInitScript(() => {
                Object.defineProperty(Navigator.prototype, "gpu", { configurable: true, value: undefined });
            });
            await blockedPage.goto(url, { waitUntil: "domcontentloaded", timeout: 10_000 });
            await blockedPage.waitForSelector("[data-region=capability-block]", { timeout: 5_000 });
            const blockedEvidence = await blockedPage.evaluate(() => {
                const shell = document.querySelector<HTMLElement>("[data-region=shell]");
                const block = document.querySelector<HTMLElement>("[data-region=capability-block]");
                return {
                    blocked: shell?.dataset.capability === "block",
                    shellHidden: getComputedStyle(shell ?? document.body).visibility === "hidden",
                    clearMessage: block?.textContent?.includes("WebGPU is required") === true,
                };
            });
            if (!blockedEvidence.blocked || !blockedEvidence.shellHidden || !blockedEvidence.clearMessage) {
                throw new Error(`no-WebGPU capability gate failed: ${JSON.stringify(blockedEvidence)}`);
            }
            const verdict = await page.evaluate(async () => {
                const harness = window.__harness;
                if (!harness?.run) throw new Error("page did not install window.__harness.run");
                return harness.run({ size: "integration", requires: ["chromium"] });
            });
            if (
                verdict.ok !== true ||
                !Array.isArray(verdict.checks) ||
                verdict.checks.length === 0 ||
                verdict.checks.some((check) => check.ok !== true)
            ) {
                throw new Error(`harness protocol failed: ${JSON.stringify(verdict)}`);
            }
            const requiredChecks = [
                "GPU grid material drew",
                "no placeholder cube remains",
                "grid/axis material contract is present",
                "standard Orbit controls camera",
                "standard scene lighting is present",
            ];
            for (const name of requiredChecks) {
                const check = verdict.checks.find((candidate) => candidate.name === name);
                if (!check?.ok) throw new Error(`missing passing scene evidence: ${name}`);
            }
            const grid = await page.evaluate(async () => {
                const probe = (window as Window & {
                    __kexeditGridProbe?: () => Promise<{ samples: number; drawn: boolean }>;
                }).__kexeditGridProbe;
                return (await probe?.()) ?? { samples: 0, drawn: false };
            });
            if (!grid.drawn || grid.samples <= 0) {
                throw new Error(`GPU grid probe failed: ${JSON.stringify(grid)}`);
            }
            const evidence = await page.evaluate(async () => {
                const adapter = await navigator.gpu?.requestAdapter();
                const info = (adapter as (GPUAdapter & { info?: Record<string, string> }) | undefined)?.info;
                const hardware = [info?.description, info?.device, info?.vendor, info?.architecture]
                    .filter((part): part is string => Boolean(part))
                    .join(" ") || (adapter ? "gpu" : "none");
                const canvas = document.querySelector("canvas");
                if (!canvas) return { adapter: false, hardware, pixels: 0, span: 0 };
                const dataUrl = canvas.toDataURL("image/png");
                const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
                const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
                const context = surface.getContext("2d");
                if (!context) return { adapter: Boolean(adapter), hardware, pixels: 0, span: 0 };
                context.drawImage(bitmap, 0, 0);
                const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
                let count = 0;
                let minX = bitmap.width;
                let maxX = -1;
                for (let i = 0; i < pixels.length; i += 4) {
                    if (pixels[i + 3] > 0 && (pixels[i] > 8 || pixels[i + 1] > 8 || pixels[i + 2] > 8)) {
                        count += 1;
                        const x = (i / 4) % bitmap.width;
                        minX = Math.min(minX, x);
                        maxX = Math.max(maxX, x);
                    }
                }
                bitmap.close();
                return { adapter: Boolean(adapter), hardware, pixels: count, span: maxX >= 0 ? maxX - minX + 1 : 0 };
            });
            if (errors.length > 0) throw new Error(errors.join(" | "));
            if (!evidence.adapter) throw new Error("Chromium did not expose a GPU adapter");
            console.log(
                `browser evidence: Chromium GPU ${evidence.hardware}; pixels=${evidence.pixels}; span=${evidence.span}; gridSamples=${grid.samples}; clearSamples=${JSON.stringify(shellEvidence.clearSamples)} vs ${shellEvidence.paneColor} (matches=${shellEvidence.clearMatches}/4); gaps=${JSON.stringify(shellEvidence.gapValues)}px; dividerPixels=${JSON.stringify(seamEvidence.sequences)}; splash/zero-gap/single-divider/entrance/reduced-motion/no-WebGPU-block/grid-axis/no-cube/orbit/lighting checks=pass`,
            );
            if (evidence.pixels < 200 || evidence.span < 24) {
                throw new Error(`canvas pixel gate failed: ${JSON.stringify(evidence)}`);
            }
            return { ok: true, checks: [{ name: "GPU canvas rendered", ok: true, data: evidence }] };
        } finally {
            await blockedPage?.close();
            await reducedPage?.close();
            await page?.close();
            await browser?.close();
            if (server.exitCode === null) server.kill();
            await server.exited;
        }
    },
);
