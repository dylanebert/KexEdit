import { resolve } from "node:path";
import { check } from "@dylanebert/shallot/harness/check";
import launch from "@dylanebert/shallot/harness/browser" with { type: "json" };
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dir, "..");

type RideSample = {
    header: { length: number; endReason: string; endTick: number };
    transport: { playhead: number; playing: boolean };
};

type TrainSample = { tick: number; held: boolean; playhead: number };

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
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = listener.port;
    listener.stop();
    return port;
}

async function openPage(url: string, browser: Awaited<ReturnType<typeof chromium.launch>>) {
    const page = await browser.newPage({ viewport: { width: 1563, height: 944 } });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10_000 });
    await page.waitForFunction(
        () => window.__harness?.ready === true && "__kexeditPath" in globalThis,
        undefined,
        { timeout: 15_000 },
    );
    return page;
}

check(
    "in Chromium the timeline transport controls the ride and presents its refusal tail",
    {
        claim: "the timeline controls do not drive the ride or hide its solved and unsolved transport states",
        size: "integration",
        requires: ["chromium"],
        subject: ["src/Transport.svelte", "src/Timeline.svelte", "src/Status.svelte", "src/View.svelte", "src/path/view.ts"],
        budget: 20_000,
    },
    async () => {
        const port = freePort();
        const root = `http://127.0.0.1:${port}`;
        const server = Bun.spawn(
            [process.execPath, "run", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
            { cwd: ROOT, stdout: "ignore", stderr: "ignore" },
        );
        const errors: string[] = [];
        let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
        try {
            await waitForServer(`${root}/`, server);
            browser = await chromium.launch({ headless: true, ...launch });
            const full = await openPage(`${root}/`, browser);
            full.on("pageerror", (error) => errors.push(error.message));
            full.on("console", (message) => {
                if (message.type() === "error") errors.push(message.text());
            });

            await full.keyboard.press("Space");
            const playing = (await full.evaluate(() => (globalThis as any).__kexeditPath.ride())) as RideSample;
            await full.keyboard.press("Space");
            const paused = (await full.evaluate(() => (globalThis as any).__kexeditPath.ride())) as RideSample;
            const ruler = full.locator('[data-region="ruler"]');
            const box = await ruler.boundingBox();
            if (!box) throw new Error("timeline ruler has no bounds");
            await full.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
            await full.mouse.down();
            await full.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2);
            await full.mouse.up();
            await full.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
            const scrubbed = (await full.evaluate(() => (globalThis as any).__kexeditPath.ride())) as RideSample & { transport: { playhead: number } };
            const fullStates = await full.evaluate(() => ({
                deadTail: document.querySelectorAll('[data-region="dead-tail"]').length,
                endMark: document.querySelectorAll('[data-region="end-mark"]').length,
                badge: document.querySelector('[data-diagnostic-badge]')?.textContent,
            }));

            const stalled = await openPage(`${root}/?fixture=stalled`, browser);
            stalled.on("pageerror", (error) => errors.push(error.message));
            stalled.on("console", (message) => {
                if (message.type() === "error") errors.push(message.text());
            });
            const stalledRide = (await stalled.evaluate(() => (globalThis as any).__kexeditPath.ride())) as RideSample;
            await stalled.evaluate((tick: number) => (globalThis as any).__kexeditPath.scrub(tick + 2), stalledRide.header.endTick);
            await stalled.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
            const held = (await stalled.evaluate(() => (globalThis as any).__kexeditPath.train())) as TrainSample;
            const states = await stalled.evaluate(() => ({
                tail: document.querySelector('[data-region="dead-tail"]') !== null,
                endMark: document.querySelector('[data-region="end-mark"]') !== null,
                status: document.querySelector('[data-diagnostic-entry]')?.textContent ?? "",
                badge: document.querySelector('[data-diagnostic-badge]')?.textContent ?? "",
            }));
            await stalled.locator('[data-diagnostic-entry]').click();
            const returned = (await stalled.evaluate(() => (globalThis as any).__kexeditPath.ride())) as RideSample;

            if (
                !playing.transport.playing ||
                paused.transport.playing ||
                scrubbed.transport.playhead <= 0 ||
                fullStates.deadTail !== 0 ||
                fullStates.endMark !== 0 ||
                fullStates.badge !== "0" ||
                stalledRide.header.endReason !== "stalled" ||
                !states.tail ||
                !states.endMark ||
                !states.status.includes("stalled") ||
                !states.status.includes("need") ||
                !states.status.includes("have") ||
                states.badge !== "1" ||
                !held.held ||
                returned.transport.playhead !== stalledRide.header.endTick ||
                errors.length
            ) {
                throw new Error(
                    `transport UI failed: ${JSON.stringify({ playing, paused, scrubbed, fullStates, stalledRide, held, states, returned, errors })}`,
                );
            }
        } finally {
            await browser?.close();
            server.kill();
            await server.exited;
        }
    },
);
