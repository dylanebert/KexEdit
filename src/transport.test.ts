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
        subject: ["src/Transport.svelte", "src/Timeline.svelte", "src/Status.svelte", "src/View.svelte", "src/path/view.ts", "src/app.css"],
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
            const absence = await full.evaluate(() => ({
                rateField: document.querySelector('[data-field="rate"]'),
                rateLabel: document.querySelector('[aria-label="Playback rate"]'),
            }));
            if (absence.rateField || absence.rateLabel) throw new Error("visible playback rate control remains");

            const ruler = full.locator('[data-region="ruler"]');
            const rulerGeometry = await full.evaluate(() => {
                const ruler = document.querySelector('[data-region="ruler"]');
                if (!ruler) throw new Error("timeline ruler is missing");
                const bounds = ruler.getBoundingClientRect();
                const marks = [...ruler.querySelectorAll<HTMLElement>('[data-tick-level]')].map((mark) => {
                    const rect = mark.getBoundingClientRect();
                    return {
                        level: mark.dataset.tickLevel,
                        seconds: Number(mark.dataset.tickSeconds),
                        left: rect.left,
                        right: rect.right,
                        height: rect.height,
                        label: mark.querySelector('.timeline-tick-label')?.textContent?.trim() ?? "",
                    };
                });
                const majors = marks.filter((mark) => mark.level === "major");
                const minors = marks.filter((mark) => mark.level === "minor");
                const labelsIncrease = majors.every((mark, index) => index === 0 || (mark.seconds > majors[index - 1].seconds && mark.left > majors[index - 1].left));
                const marksInBounds = marks.every((mark) => mark.left >= bounds.left - 1 && mark.right <= bounds.right + 1);
                const hasMinorBetweenMajors = majors.slice(1).some((major, index) => minors.some((minor) => minor.left > majors[index].left && minor.left < major.left));
                return {
                    majorCount: majors.length,
                    minorCount: minors.length,
                    labels: majors.map((mark) => mark.label),
                    labelsIncrease,
                    marksInBounds,
                    hasMinorBetweenMajors,
                    majorHeight: majors[0]?.height ?? 0,
                    minorHeight: minors[0]?.height ?? 0,
                };
            });
            const lanes = await full.evaluate(() => {
                const ruler = document.querySelector('[data-region="ruler"]')?.getBoundingClientRect();
                const surface = document.querySelector('[data-region="reserved-lanes"]');
                const laneRects = [...document.querySelectorAll<HTMLElement>('[data-region="timeline-lane"]')].map((lane) => {
                    const rect = lane.getBoundingClientRect();
                    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, text: lane.textContent ?? "" };
                });
                const surfaceRect = surface?.getBoundingClientRect();
                const ordered = laneRects.every((lane, index) => index === 0 || Math.abs(lane.top - laneRects[index - 1].bottom) <= 1);
                return {
                    count: laneRects.length,
                    empty: laneRects.every((lane) => lane.text.trim() === ""),
                    ordered,
                    fills: Boolean(surfaceRect && laneRects.length && Math.abs(laneRects[0].top - surfaceRect.top) <= 1 && Math.abs(laneRects.at(-1)!.bottom - surfaceRect.bottom) <= 1),
                    aligned: Boolean(ruler && laneRects.every((lane) => Math.abs(lane.left - ruler.left) <= 1 && Math.abs(lane.right - ruler.right) <= 1)),
                };
            });
            if (
                rulerGeometry.majorCount < 2 ||
                rulerGeometry.minorCount < 1 ||
                !rulerGeometry.labels.every((label) => label !== "" && Number.isFinite(Number(label))) ||
                !rulerGeometry.labelsIncrease ||
                !rulerGeometry.marksInBounds ||
                !rulerGeometry.hasMinorBetweenMajors ||
                rulerGeometry.majorHeight <= rulerGeometry.minorHeight ||
                lanes.count !== 4 ||
                !lanes.empty ||
                !lanes.ordered ||
                !lanes.fills ||
                !lanes.aligned
            ) {
                throw new Error(`timeline composition failed: ${JSON.stringify({ rulerGeometry, lanes })}`);
            }

            const box = await ruler.boundingBox();
            if (!box) throw new Error("timeline ruler has no bounds");
            const beforeScrubX = await full.locator('[data-region="playhead"]').evaluate((element) => element.getBoundingClientRect().left);
            await full.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
            await full.mouse.down();
            const dragAffordance = await full.evaluate(() => {
                const ruler = document.querySelector('[data-region="ruler"]');
                const lanes = document.querySelector('[data-region="reserved-lanes"]');
                return {
                    rulerCursor: ruler ? getComputedStyle(ruler).cursor : "",
                    lanesCursor: lanes ? getComputedStyle(lanes).cursor : "",
                    rulerClass: ruler?.className ?? "",
                };
            });
            await full.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2);
            await full.mouse.up();
            await full.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
            const scrubbed = (await full.evaluate(() => (globalThis as any).__kexeditPath.ride())) as RideSample & { transport: { playhead: number } };
            const playheadGeometry = await full.evaluate(() => {
                const ruler = document.querySelector('[data-region="ruler"]')?.getBoundingClientRect();
                const lanes = document.querySelector('[data-region="reserved-lanes"]')?.getBoundingClientRect();
                const finalLane = [...document.querySelectorAll<HTMLElement>('[data-region="timeline-lane"]')].at(-1)?.getBoundingClientRect();
                const playhead = document.querySelector('[data-region="playhead"]')?.getBoundingClientRect();
                const head = document.querySelector('.timeline-playhead-head')?.getBoundingClientRect();
                const line = document.querySelector('[data-region="playhead-line"]')?.getBoundingClientRect();
                if (!ruler || !lanes || !finalLane || !playhead || !head || !line) return null;
                return {
                    headCenter: head.left + head.width / 2,
                    lineCenter: line.left + line.width / 2,
                    headInRuler: head.top >= ruler.top - 1 && head.bottom <= ruler.bottom + 1,
                    lineCrossesBoundary: line.top < ruler.bottom && line.bottom > lanes.top,
                    lineAtLaneBottom: Math.abs(line.bottom - finalLane.bottom) <= 1,
                    playheadLeft: playhead.left,
                };
            });
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
            const stalledGeometry = await stalled.evaluate(() => {
                const tail = document.querySelector('[data-region="dead-tail"]')?.getBoundingClientRect();
                const mark = document.querySelector('[data-region="end-mark"]')?.getBoundingClientRect();
                const playhead = document.querySelector('[data-region="playhead"]')?.getBoundingClientRect();
                if (!tail || !mark || !playhead) return null;
                return {
                    tailStart: tail.left,
                    markCenter: mark.left + mark.width / 2,
                    playheadCenter: playhead.left + playhead.width / 2,
                };
            });
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
                dragAffordance.rulerCursor !== "default" ||
                dragAffordance.lanesCursor !== "default" ||
                dragAffordance.rulerClass.includes("drag") ||
                !playheadGeometry ||
                Math.abs(playheadGeometry.headCenter - playheadGeometry.lineCenter) > 1 ||
                !playheadGeometry.headInRuler ||
                !playheadGeometry.lineCrossesBoundary ||
                !playheadGeometry.lineAtLaneBottom ||
                playheadGeometry.playheadLeft <= beforeScrubX ||
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
                !stalledGeometry ||
                Math.abs(stalledGeometry.tailStart - stalledGeometry.markCenter) > 1 ||
                stalledGeometry.playheadCenter <= stalledGeometry.markCenter ||
                returned.transport.playhead !== stalledRide.header.endTick ||
                errors.length
            ) {
                throw new Error(
                    `transport UI failed: ${JSON.stringify({ playing, paused, scrubbed, fullStates, playheadGeometry, stalledRide, held, stalledGeometry, states, returned, errors })}`,
                );
            }
        } finally {
            await browser?.close();
            server.kill();
            await server.exited;
        }
    },
);
