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
        subject: ["src/Transport.svelte", "src/Timeline.svelte", "src/Status.svelte", "src/View.svelte", "src/path/view.ts", "src/timeline/viewport.ts", "src/app.css"],
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
            const noLoop = await full.evaluate(() => ({
                action: document.querySelector('[data-action="loop"]'),
                named: [...document.querySelectorAll("button")].some((button) => button.getAttribute("aria-label") === "Loop"),
                reservedLoop: Boolean((globalThis as any).__kexeditPath.ride()?.transport.loop),
            }));
            if (noLoop.action || noLoop.named || !noLoop.reservedLoop) throw new Error(`loop surface failed: ${JSON.stringify(noLoop)}`);

            const readView = () => full.evaluate(() => {
                const surface = document.querySelector<HTMLElement>('[data-region="timeline-surface"]');
                if (!surface) throw new Error("timeline surface is missing");
                return {
                    start: Number(surface.dataset.viewStart),
                    end: Number(surface.dataset.viewEnd),
                    span: Number(surface.dataset.viewSpan),
                };
            });
            const dispatchWheel = (options: { deltaX?: number; deltaY?: number; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) =>
                full.evaluate((input) => {
                    const surface = document.querySelector<HTMLElement>('[data-region="timeline-surface"]');
                    if (!surface) throw new Error("timeline surface is missing");
                    const bounds = surface.getBoundingClientRect();
                    const event = new WheelEvent("wheel", {
                        bubbles: true,
                        cancelable: true,
                        clientX: bounds.left + bounds.width * 0.5,
                        deltaX: input.deltaX ?? 0,
                        deltaY: input.deltaY ?? 0,
                        ctrlKey: input.ctrlKey ?? false,
                        metaKey: input.metaKey ?? false,
                        shiftKey: input.shiftKey ?? false,
                    });
                    return { accepted: surface.dispatchEvent(event), defaultPrevented: event.defaultPrevented };
                }, options);
            const initialView = await readView();
            const zoomWheel = await dispatchWheel({ deltaY: -40, ctrlKey: true });
            const zoomedView = await readView();
            if (zoomWheel.accepted || !zoomWheel.defaultPrevented || !(zoomedView.span < initialView.span)) {
                throw new Error(`Ctrl-wheel did not zoom: ${JSON.stringify({ initialView, zoomedView, zoomWheel })}`);
            }
            const anchorProbe = await full.evaluate(() => {
                const surface = document.querySelector<HTMLElement>('[data-region="timeline-surface"]');
                if (!surface) throw new Error("timeline surface is missing");
                const bounds = surface.getBoundingClientRect();
                const start = Number(surface.dataset.viewStart);
                const span = Number(surface.dataset.viewSpan);
                return { time: start + span * 0.5, x: bounds.left + bounds.width * 0.5 };
            });
            const zoomBeforeAnchor = await readView();
            const metaWheel = await full.evaluate((input) => {
                const surface = document.querySelector<HTMLElement>('[data-region="timeline-surface"]');
                if (!surface) throw new Error("timeline surface is missing");
                const event = new WheelEvent("wheel", {
                    bubbles: true,
                    cancelable: true,
                    clientX: input.x,
                    deltaY: -20,
                    ctrlKey: false,
                    metaKey: true,
                    shiftKey: false,
                });
                return { accepted: surface.dispatchEvent(event), defaultPrevented: event.defaultPrevented };
            }, anchorProbe);
            const zoomAfterMeta = await readView();
            const anchoredAfterMeta = await full.evaluate((x: number) => {
                const surface = document.querySelector<HTMLElement>('[data-region="timeline-surface"]');
                if (!surface) throw new Error("timeline surface is missing");
                const bounds = surface.getBoundingClientRect();
                return Number(surface.dataset.viewStart) + ((x - bounds.left) * Number(surface.dataset.viewSpan)) / bounds.width;
            }, anchorProbe.x);
            if (metaWheel.accepted || !metaWheel.defaultPrevented || !(zoomAfterMeta.span < zoomBeforeAnchor.span) || Math.abs(anchoredAfterMeta - anchorProbe.time) > zoomBeforeAnchor.span * 1e-3) {
                throw new Error(`Meta-wheel anchor failed: ${JSON.stringify({ anchorProbe, zoomBeforeAnchor, zoomAfterMeta, metaWheel })}`);
            }
            const ctrlShift = await dispatchWheel({ deltaY: -10, ctrlKey: true, shiftKey: true });
            const afterCtrlShift = await readView();
            if (ctrlShift.accepted || !ctrlShift.defaultPrevented || afterCtrlShift.span !== zoomAfterMeta.span || !(afterCtrlShift.start < zoomAfterMeta.start)) {
                throw new Error(`Shift+Ctrl did not pan with Shift priority: ${JSON.stringify({ zoomAfterMeta, afterCtrlShift, ctrlShift })}`);
            }
            const ordinaryBefore = await readView();
            const ordinaryWheel = await dispatchWheel({ deltaY: 40 });
            const ordinaryAfter = await readView();
            if (ordinaryWheel.accepted || !ordinaryWheel.defaultPrevented || !(ordinaryAfter.span > ordinaryBefore.span)) {
                throw new Error(`plain wheel did not zoom: ${JSON.stringify({ ordinaryWheel, ordinaryBefore, ordinaryAfter })}`);
            }
            const horizontalBefore = await readView();
            const horizontalWheel = await dispatchWheel({ deltaX: 40 });
            const horizontalAfter = await readView();
            if (!horizontalWheel.accepted || horizontalWheel.defaultPrevented || JSON.stringify(horizontalBefore) !== JSON.stringify(horizontalAfter)) {
                throw new Error(`pure horizontal wheel was claimed by the timeline: ${JSON.stringify({ horizontalWheel, horizontalBefore, horizontalAfter })}`);
            }
            const panBefore = await readView();
            const shiftWheel = await dispatchWheel({ deltaY: 24, shiftKey: true });
            const panAfter = await readView();
            if (shiftWheel.accepted || !shiftWheel.defaultPrevented || panAfter.span !== panBefore.span || !(panAfter.start > panBefore.start)) {
                throw new Error(`Shift-wheel did not pan horizontally: ${JSON.stringify({ panBefore, panAfter, shiftWheel })}`);
            }
            const panTicksBefore = await full.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-region="ruler"] [data-tick-level]')].map((mark) => ({ seconds: Number(mark.dataset.tickSeconds), left: mark.getBoundingClientRect().left })));
            if (panTicksBefore.length < 2 || panTicksBefore.some((tick) => !Number.isFinite(tick.seconds))) throw new Error("visible ticks have no seconds observable");

            const gestureBefore = await readView();
            const gestureRideBefore = (await full.evaluate(() => (globalThis as any).__kexeditPath.ride())) as RideSample;
            const laneBox = await full.locator('[data-region="timeline-lane"]').first().boundingBox();
            if (!laneBox) throw new Error("timeline lane has no bounds");
            const gestureX = laneBox.x + laneBox.width * 0.65;
            await full.mouse.move(gestureX, laneBox.y + laneBox.height / 2);
            await full.keyboard.down("Space");
            await full.mouse.down();
            await full.mouse.move(gestureX - 100, laneBox.y + laneBox.height / 2);
            await full.mouse.up();
            await full.keyboard.up("Space");
            const gestureAfter = await readView();
            const gestureRideAfter = (await full.evaluate(() => (globalThis as any).__kexeditPath.ride())) as RideSample;
            if (gestureAfter.start === gestureBefore.start || gestureAfter.span !== gestureBefore.span || gestureRideAfter.transport.playhead !== gestureRideBefore.transport.playhead || gestureRideAfter.transport.playing) {
                throw new Error(`Space-drag conflicted with scrub/playback: ${JSON.stringify({ gestureBefore, gestureAfter, gestureRideBefore, gestureRideAfter })}`);
            }
            await full.keyboard.press("Space");
            const tappedPlaying = (await full.evaluate(() => (globalThis as any).__kexeditPath.ride())) as RideSample;
            await full.keyboard.press("Space");
            if (!tappedPlaying.transport.playing) throw new Error("Space tap after a pan did not toggle playback once");

            const middleBefore = await readView();
            const middleRideBefore = (await full.evaluate(() => (globalThis as any).__kexeditPath.ride())) as RideSample;
            await full.mouse.move(gestureX, laneBox.y + laneBox.height / 2);
            await full.mouse.down({ button: "middle" });
            await full.mouse.move(gestureX + 90, laneBox.y + laneBox.height / 2);
            await full.mouse.up({ button: "middle" });
            const middleAfter = await readView();
            const middleRideAfter = (await full.evaluate(() => (globalThis as any).__kexeditPath.ride())) as RideSample;
            if (middleAfter.start === middleBefore.start || middleAfter.span !== middleBefore.span || middleRideAfter.transport.playhead !== middleRideBefore.transport.playhead) {
                throw new Error(`middle drag did not pan independently: ${JSON.stringify({ middleBefore, middleAfter, middleRideBefore, middleRideAfter })}`);
            }

            const ordinaryScrubView = await readView();
            const scrubBox = await ruler.boundingBox();
            if (!scrubBox) throw new Error("timeline ruler has no bounds");
            await full.mouse.move(scrubBox.x + scrubBox.width * 0.2, scrubBox.y + scrubBox.height / 2);
            await full.mouse.down();
            await full.mouse.move(scrubBox.x + scrubBox.width * 0.7, scrubBox.y + scrubBox.height / 2);
            await full.mouse.up();
            const ordinaryScrubRide = (await full.evaluate(() => (globalThis as any).__kexeditPath.ride())) as RideSample;
            const ordinaryScrubAfter = await readView();
            if (ordinaryScrubAfter.start !== ordinaryScrubView.start || ordinaryScrubAfter.span !== ordinaryScrubView.span || ordinaryScrubRide.transport.playhead <= 0) {
                throw new Error(`ordinary ruler scrub changed the viewport or did not move the playhead: ${JSON.stringify({ ordinaryScrubView, ordinaryScrubAfter, ordinaryScrubRide })}`);
            }

            const beforeFramePlayhead = ordinaryScrubRide.transport.playhead;
            await full.keyboard.press("f");
            const framed = await readView();
            const afterFramePlayhead = (await full.evaluate(() => (globalThis as any).__kexeditPath.ride())) as RideSample;
            if (framed.start !== 0 || Math.abs(framed.end - initialView.end) > 1e-9 || afterFramePlayhead.transport.playhead !== beforeFramePlayhead) {
                throw new Error(`F did not frame authored time without scrubbing: ${JSON.stringify({ framed, initialView, beforeFramePlayhead, afterFramePlayhead })}`);
            }

            const typography = await full.evaluate(() => {
                const transport = document.querySelector<HTMLElement>(".transport");
                const readout = document.querySelector<HTMLElement>(".transport-readout");
                const label = document.querySelector<HTMLElement>(".timeline-tick-label");
                const current = document.querySelector<HTMLElement>(".transport-time-current");
                const total = document.querySelector<HTMLElement>(".transport-time-total");
                if (!transport || !readout || !label || !current || !total) throw new Error("timeline hierarchy nodes missing");
                return {
                    body: getComputedStyle(transport).fontFamily,
                    readout: getComputedStyle(readout).fontFamily,
                    tick: getComputedStyle(label).fontFamily,
                    currentWeight: getComputedStyle(current).fontWeight,
                    totalWeight: getComputedStyle(total).fontWeight,
                    currentColor: getComputedStyle(current).color,
                    totalColor: getComputedStyle(total).color,
                    readoutSize: getComputedStyle(readout).fontSize,
                    labelSize: getComputedStyle(label).fontSize,
                    labelLineHeight: getComputedStyle(label).lineHeight,
                };
            });
            if (!typography.body.includes("IBM Plex Sans") || !typography.readout.includes("JetBrains Mono") || !typography.tick.includes("JetBrains Mono") || typography.currentWeight === typography.totalWeight || typography.currentColor === typography.totalColor || typography.readoutSize !== "12px" || typography.labelSize !== "11px" || typography.labelLineHeight !== "12px") {
                throw new Error(`timeline hierarchy failed: ${JSON.stringify(typography)}`);
            }
            const focusBefore = await full.evaluate(() => {
                const ruler = document.querySelector<HTMLElement>('[data-region="ruler"]');
                const surface = document.querySelector<HTMLElement>('[data-region="timeline-surface"]');
                if (!ruler || !surface) throw new Error("focus geometry nodes missing");
                const read = (rect: DOMRect) => [rect.left, rect.top, rect.width, rect.height];
                return { ruler: read(ruler.getBoundingClientRect()), surface: read(surface.getBoundingClientRect()), pointerFocused: document.activeElement === ruler };
            });
            await ruler.focus();
            const focus = await full.evaluate(() => {
                const ruler = document.querySelector<HTMLElement>('[data-region="ruler"]');
                const surface = document.querySelector<HTMLElement>('[data-region="timeline-surface"]');
                const head = document.querySelector<HTMLElement>(".timeline-playhead-head");
                const current = document.querySelector<HTMLElement>(".transport-time-current");
                if (!ruler || !surface || !head || !current) throw new Error("focus affordances missing");
                return {
                    outline: getComputedStyle(ruler).outlineStyle,
                    rulerRect: [ruler.getBoundingClientRect().left, ruler.getBoundingClientRect().top, ruler.getBoundingClientRect().width, ruler.getBoundingClientRect().height],
                    surfaceRect: [surface.getBoundingClientRect().left, surface.getBoundingClientRect().top, surface.getBoundingClientRect().width, surface.getBoundingClientRect().height],
                    headShadow: getComputedStyle(head).boxShadow,
                    currentShadow: getComputedStyle(current).boxShadow,
                };
            });
            if (focusBefore.pointerFocused || focus.outline !== "none" || focus.headShadow !== "none" || focus.currentShadow !== "none" || JSON.stringify(focusBefore.ruler) !== JSON.stringify(focus.rulerRect) || JSON.stringify(focusBefore.surface) !== JSON.stringify(focus.surfaceRect)) {
                throw new Error(`timeline focus has an unearned ornament or pointer focus: ${JSON.stringify({ focusBefore, focus })}`);
            }
            await full.keyboard.press("Home");
            const home = (await full.evaluate(() => (globalThis as any).__kexeditPath.ride())) as RideSample;
            await full.keyboard.press("End");
            const end = (await full.evaluate(() => (globalThis as any).__kexeditPath.ride())) as RideSample;
            await full.keyboard.press("ArrowLeft");
            const left = (await full.evaluate(() => (globalThis as any).__kexeditPath.ride())) as RideSample;
            await full.keyboard.press("Shift+ArrowLeft");
            const shiftedLeft = (await full.evaluate(() => (globalThis as any).__kexeditPath.ride())) as RideSample;
            await full.keyboard.press("Space");
            const keyboardPlaying = (await full.evaluate(() => (globalThis as any).__kexeditPath.ride())) as RideSample;
            await full.keyboard.press("Space");
            const keyboardPaused = (await full.evaluate(() => (globalThis as any).__kexeditPath.ride())) as RideSample;

            const rideBeforeWrap = (await full.evaluate(() => (globalThis as any).__kexeditPath.ride())) as RideSample;
            await full.evaluate((tick: number) => (globalThis as any).__kexeditPath.scrub(tick - 0.25), rideBeforeWrap.header.length);
            await full.keyboard.press("Space");
            await full.waitForFunction(() => {
                const ride = (globalThis as any).__kexeditPath.ride();
                return ride.transport.playing && ride.transport.playhead < ride.header.length - 1;
            }, undefined, { timeout: 2_000 });
            const wrapped = (await full.evaluate(() => (globalThis as any).__kexeditPath.ride())) as RideSample;
            await full.keyboard.press("Space");
            if (!wrapped.transport.playing || wrapped.transport.playhead >= wrapped.header.length - 1) throw new Error(`playback did not unconditionally wrap: ${JSON.stringify(wrapped)}`);

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
                        top: rect.top,
                        height: rect.height,
                        label: mark.querySelector('.timeline-tick-label')?.textContent?.trim() ?? "",
                        labelRect: mark.querySelector<HTMLElement>('.timeline-tick-label')?.getBoundingClientRect(),
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
                    rulerHeight: bounds.height,
                    majorHeight: majors[0]?.height ?? 0,
                    minorHeight: minors[0]?.height ?? 0,
                    labelHeight: majors.find((mark) => mark.label)?.labelRect?.height ?? 0,
                    labelLineGap: majors.find((mark) => mark.label)?.labelRect ? (majors.find((mark) => mark.label)?.labelRect!.bottom ?? 0) - (majors.find((mark) => mark.label)?.top ?? 0) : 0,
                    labelOffset: majors.find((mark) => mark.label)?.labelRect && majors.find((mark) => mark.label)?.left ? (majors.find((mark) => mark.label)?.labelRect!.left ?? 0) - (majors.find((mark) => mark.label)?.left ?? 0) : 0,
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
                rulerGeometry.rulerHeight !== 30 ||
                rulerGeometry.majorHeight !== 10 ||
                rulerGeometry.minorHeight !== 5 ||
                rulerGeometry.labelHeight !== 12 ||
                Math.abs(rulerGeometry.labelOffset - 4) > 1 ||
                Math.abs(rulerGeometry.labelLineGap + 2) > 1 ||
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
            const fullStates = await full.evaluate(() => {
                const status = document.querySelector<HTMLElement>('[data-region="status"]');
                const gutters = [...document.querySelectorAll<HTMLElement>('.timeline-gutter')];
                const controls = document.querySelector<HTMLElement>('.transport-control-viewport')?.getBoundingClientRect();
                const surface = document.querySelector<HTMLElement>('[data-region="timeline-surface"]')?.getBoundingClientRect();
                const ruler = document.querySelector<HTMLElement>('[data-region="ruler"]')?.getBoundingClientRect();
                const lanes = [...document.querySelectorAll<HTMLElement>('[data-region="timeline-lane"]')].map((lane) => lane.getBoundingClientRect());
                const play = document.querySelector<HTMLElement>('[data-action="play-pause"]')?.getBoundingClientRect();
                const readout = document.querySelector<HTMLElement>('[data-readout="time"]')?.getBoundingClientRect();
                const seam = status ? getComputedStyle(status).borderTopStyle : "";
                return {
                    deadTail: document.querySelectorAll('[data-region="dead-tail"]').length,
                    endMark: document.querySelectorAll('[data-region="end-mark"]').length,
                    statusEmpty: Boolean(status && status.childElementCount === 0 && status.textContent?.trim() === "" && status.getBoundingClientRect().height === 32 && seam === "solid"),
                    gutters: gutters.map((gutter) => ({ width: gutter.getBoundingClientRect().width, right: gutter.getBoundingClientRect().right, empty: gutter.childElementCount === 0, text: gutter.textContent?.trim() ?? "", interactive: Boolean(gutter.querySelector("button,input,output")) })),
                    controlBounds: controls && surface && ruler ? { controls, surface, ruler, lanes, play, readout } : null,
                    obsolete: document.querySelector('[data-region="diagnostics"], [data-diagnostic-badge], [data-diagnostic-entry], .status-ready') !== null,
                };
            });

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
            const states = await stalled.evaluate(() => {
                const status = document.querySelector<HTMLElement>('[data-region="status"]');
                return {
                    tail: document.querySelector('[data-region="dead-tail"]') !== null,
                    endMark: document.querySelector('[data-region="end-mark"]') !== null,
                    statusEmpty: Boolean(status && status.childElementCount === 0 && status.textContent?.trim() === ""),
                    obsolete: document.querySelector('[data-region="diagnostics"], [data-diagnostic-badge], [data-diagnostic-entry], .status-ready') !== null,
                };
            });

            const controlBounds = fullStates.controlBounds;
            if (!controlBounds) throw new Error(`timeline control geometry is missing: ${JSON.stringify(fullStates)}`);
            const playBounds = controlBounds.play;
            const readoutBounds = controlBounds.readout;
            if (!playBounds || !readoutBounds) throw new Error(`timeline controls are missing: ${JSON.stringify(fullStates)}`);
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
                !fullStates.statusEmpty ||
                fullStates.obsolete ||
                fullStates.gutters.length !== 2 ||
                fullStates.gutters.some((gutter) => gutter.width !== 240 || !gutter.empty || gutter.text !== "" || gutter.interactive) ||
                Math.abs(fullStates.gutters[0].right - fullStates.gutters[1].right) > 1 ||
                !fullStates.controlBounds ||
                Math.abs((playBounds.left + playBounds.width / 2) - (controlBounds.controls.left + controlBounds.controls.width / 2)) > 1 ||
                Math.abs(readoutBounds.right - (controlBounds.surface.right - 14)) > 1 ||
                Math.abs(controlBounds.controls.left - controlBounds.ruler.left) > 1 ||
                Math.abs(controlBounds.controls.right - controlBounds.ruler.right) > 1 ||
                controlBounds.lanes.some((lane) => Math.abs(lane.left - controlBounds.ruler.left) > 1 || Math.abs(lane.right - controlBounds.ruler.right) > 1) ||
                home.transport.playhead !== 0 ||
                end.transport.playhead !== end.header.length ||
                left.transport.playhead !== end.header.length - 1 ||
                !(shiftedLeft.transport.playhead < left.transport.playhead) ||
                !keyboardPlaying.transport.playing ||
                keyboardPaused.transport.playing ||
                stalledRide.header.endReason !== "stalled" ||
                !states.tail ||
                !states.endMark ||
                !states.statusEmpty ||
                states.obsolete ||
                !held.held ||
                !stalledGeometry ||
                Math.abs(stalledGeometry.tailStart - stalledGeometry.markCenter) > 1 ||
                stalledGeometry.playheadCenter <= stalledGeometry.markCenter ||
                errors.length
            ) {
                throw new Error(
                    `transport UI failed: ${JSON.stringify({ playing, paused, scrubbed, fullStates, playheadGeometry, stalledRide, held, stalledGeometry, states, errors })}`,
                );
            }
        } finally {
            await browser?.close();
            server.kill();
            await server.exited;
        }
    },
);
