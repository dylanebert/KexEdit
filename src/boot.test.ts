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
            const shellEvidence = await page.evaluate(() => {
                const shell = document.querySelector<HTMLElement>("[data-region=shell]");
                const context = document.querySelector<HTMLElement>("[data-region=context]");
                const view = document.querySelector<HTMLElement>("[data-region=view-surface]");
                const timeline = document.querySelector<HTMLElement>("[data-region=timeline-track]");
                const timelinePane = document.querySelector<HTMLElement>("[data-region=timeline]");
                const status = document.querySelector<HTMLElement>("[data-region=status]");
                if (!shell || !context || !view || !timeline || !timelinePane || !status) {
                    return { ready: false, flat: false, borders: false };
                }
                const style = (element: HTMLElement) => getComputedStyle(element);
                const grounds = [context, view, timeline, status].map((element) => style(element).backgroundColor);
                const border = "rgb(60, 56, 54)";
                return {
                    ready: shell.dataset.shellReady === "true" && shell.getAttribute("aria-hidden") === "false",
                    flat: grounds.every((ground) => ground === "rgb(29, 32, 33)"),
                    borders:
                        style(context).borderRightColor === border &&
                        style(timelinePane).borderTopColor === border &&
                        style(status).borderTopColor === border,
                };
            });
            if (!shellEvidence.ready || !shellEvidence.flat || !shellEvidence.borders) {
                throw new Error(`flat Gruvbox shell handoff failed: ${JSON.stringify(shellEvidence)}`);
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
                `browser evidence: Chromium GPU ${evidence.hardware}; pixels=${evidence.pixels}; span=${evidence.span}; gridSamples=${grid.samples}; full-page-splash/flat-gruvbox-borders/grid-axis/no-cube/orbit/lighting checks=pass`,
            );
            if (evidence.pixels < 200 || evidence.span < 24) {
                throw new Error(`canvas pixel gate failed: ${JSON.stringify(evidence)}`);
            }
            return { ok: true, checks: [{ name: "GPU canvas rendered", ok: true, data: evidence }] };
        } finally {
            await page?.close();
            await browser?.close();
            if (server.exitCode === null) server.kill();
            await server.exited;
        }
    },
);
