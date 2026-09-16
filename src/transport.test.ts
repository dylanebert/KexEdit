import { check } from "@dylanebert/shallot/harness/check";
import type { Page } from "playwright";
import { openPage, settleFrames, waitForView, withApp } from "./browser.fixture";

type RideSample = {
    header: { length: number; rate: number; endReason: string; endTick: number };
    transport: { playhead: number; playing: boolean };
};

type TrainSample = { tick: number; held: boolean; playhead: number };

type View = { start: number; end: number; span: number };

/** Throws a failure named for the one property that broke. */
function expect(holds: boolean, failure: string, evidence: unknown): void {
    if (!holds) throw new Error(`${failure}: ${JSON.stringify(evidence)}`);
}

const ride = (page: Page) => page.evaluate(() => (globalThis as any).__kexeditPath.ride()) as Promise<RideSample>;

const readView = (page: Page) =>
    page.evaluate(() => {
        const surface = document.querySelector<HTMLElement>('[data-region="timeline-surface"]');
        if (!surface) throw new Error("timeline surface is missing");
        return { start: Number(surface.dataset.viewStart), end: Number(surface.dataset.viewEnd), span: Number(surface.dataset.viewSpan) };
    }) as Promise<View>;

const wheel = (page: Page, input: { deltaY: number; shiftKey?: boolean }) =>
    page.evaluate((options) => {
        const surface = document.querySelector<HTMLElement>('[data-region="timeline-surface"]');
        if (!surface) throw new Error("timeline surface is missing");
        const bounds = surface.getBoundingClientRect();
        const event = new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            clientX: bounds.left + bounds.width * 0.5,
            deltaY: options.deltaY,
            shiftKey: options.shiftKey ?? false,
        });
        surface.dispatchEvent(event);
        return event.defaultPrevented;
    }, input);

check(
    "in Chromium the timeline's DOM input reaches the ride and the viewport, and a stalled ride shows its dead tail",
    {
        claim: "a timeline wheel, key or drag never reaches the ride or the viewport, or a stalled ride hides its unsolved tail",
        size: "integration",
        requires: ["chromium"],
        host: "mac",
        subject: ["src/Transport.svelte", "src/Timeline.svelte", "src/View.svelte", "src/path/view.ts", "src/timeline/viewport.ts", "src/app.css"],
    },
    () =>
        withApp(async ({ url, browser }) => {
            const errors: string[] = [];
            const full = await openPage(browser, url, errors);
            await waitForView(full);

            await full.keyboard.press("Space");
            const playing = await ride(full);
            await full.keyboard.press("Space");
            const paused = await ride(full);
            expect(playing.transport.playing && !paused.transport.playing, "Space does not toggle playback", { playing, paused });

            await settleFrames(full);
            const zoomBefore = await readView(full);
            const zoomHandled = await wheel(full, { deltaY: 40 });
            const zoomAfter = await readView(full);
            expect(zoomHandled && zoomAfter.span > zoomBefore.span, "plain wheel does not reach the viewport zoom", { zoomHandled, zoomBefore, zoomAfter });

            const panHandled = await wheel(full, { deltaY: 24, shiftKey: true });
            const panAfter = await readView(full);
            expect(panHandled && panAfter.span === zoomAfter.span && panAfter.start !== zoomAfter.start, "Shift-wheel does not reach the viewport pan", { panHandled, zoomAfter, panAfter });

            const lane = await full.locator('[data-region="timeline-lane"]').first().boundingBox();
            if (!lane) throw new Error("timeline lane has no bounds");
            const laneX = lane.x + lane.width * 0.65;
            const laneY = lane.y + lane.height / 2;
            const spaceBefore = await readView(full);
            const spaceRideBefore = await ride(full);
            await full.mouse.move(laneX, laneY);
            await full.keyboard.down("Space");
            await full.mouse.down();
            await full.mouse.move(laneX - 100, laneY);
            await full.mouse.up();
            await full.keyboard.up("Space");
            const spaceAfter = await readView(full);
            const spaceRideAfter = await ride(full);
            expect(spaceAfter.start !== spaceBefore.start && spaceAfter.span === spaceBefore.span, "Space-drag does not pan the viewport", { spaceBefore, spaceAfter });
            expect(
                spaceRideAfter.transport.playhead === spaceRideBefore.transport.playhead && !spaceRideAfter.transport.playing,
                "Space-drag scrubs or toggles playback",
                { spaceRideBefore, spaceRideAfter },
            );
            await full.keyboard.press("Space");
            const tapped = await ride(full);
            await full.keyboard.press("Space");
            expect(tapped.transport.playing, "a Space tap after a pan does not toggle playback", tapped);

            const middleBefore = await readView(full);
            const middleRideBefore = await ride(full);
            await full.mouse.move(laneX, laneY);
            await full.mouse.down({ button: "middle" });
            await full.mouse.move(laneX + 90, laneY);
            await full.mouse.up({ button: "middle" });
            const middleAfter = await readView(full);
            const middleRideAfter = await ride(full);
            expect(
                middleAfter.start !== middleBefore.start && middleRideAfter.transport.playhead === middleRideBefore.transport.playhead,
                "middle drag does not pan without scrubbing",
                { middleBefore, middleAfter, middleRideBefore, middleRideAfter },
            );

            const ruler = await full.locator('[data-region="ruler"]').boundingBox();
            if (!ruler) throw new Error("timeline ruler has no bounds");
            const scrubView = await readView(full);
            await full.mouse.move(ruler.x + ruler.width * 0.2, ruler.y + ruler.height / 2);
            await full.mouse.down();
            await full.mouse.move(ruler.x + ruler.width * 0.7, ruler.y + ruler.height / 2);
            await full.mouse.up();
            const scrubbed = await ride(full);
            const scrubViewAfter = await readView(full);
            expect(scrubbed.transport.playhead > 0, "ruler drag does not scrub the playhead", scrubbed);
            expect(scrubViewAfter.start === scrubView.start && scrubViewAfter.span === scrubView.span, "ruler drag moves the viewport", { scrubView, scrubViewAfter });

            await full.keyboard.press("f");
            const framed = await readView(full);
            const framedRide = await ride(full);
            expect(framed.start === 0 && framed.span !== scrubViewAfter.span, "F does not reach frame-all", { scrubViewAfter, framed });
            expect(framedRide.transport.playhead === scrubbed.transport.playhead, "F scrubs the playhead", { scrubbed, framedRide });

            await full.locator('[data-region="ruler"]').focus();
            await full.keyboard.press("Home");
            const home = await ride(full);
            await full.keyboard.press("End");
            const end = await ride(full);
            await full.keyboard.press("ArrowLeft");
            const left = await ride(full);
            await full.keyboard.press("Shift+ArrowLeft");
            const shiftedLeft = await ride(full);
            expect(home.transport.playhead === 0, "Home does not scrub to the start", home);
            expect(end.transport.playhead === end.header.length, "End does not scrub to authored length", end);
            expect(left.transport.playhead === end.header.length - 1, "ArrowLeft does not step one tick", left);
            expect(shiftedLeft.transport.playhead < left.transport.playhead, "Shift+ArrowLeft does not step back", { left, shiftedLeft });

            await full.evaluate((length: number) => (globalThis as any).__kexeditPath.scrub(length - 0.25), end.header.length);
            await full.keyboard.press("Space");
            const wrapped = await full
                .waitForFunction(
                    () => {
                        const current = (globalThis as any).__kexeditPath.ride();
                        return current.transport.playing && current.transport.playhead < current.header.length - 1;
                    },
                    undefined,
                    { timeout: 2_000 },
                )
                .then(
                    () => true,
                    () => false,
                );
            expect(wrapped, "playback does not wrap at authored length", await ride(full));
            await full.keyboard.press("Space");

            const stalled = await openPage(browser, `${url}?fixture=stalled`, errors);
            await waitForView(stalled);
            const stalledRide = await ride(stalled);
            expect(stalledRide.header.endReason === "stalled", "the stalled fixture does not stall", stalledRide.header);
            await stalled.evaluate((tick: number) => (globalThis as any).__kexeditPath.scrub(tick + 2), stalledRide.header.endTick);
            await stalled.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
            const held = (await stalled.evaluate(() => (globalThis as any).__kexeditPath.train())) as TrainSample;
            expect(held.held, "the train is not held past the stalled end", held);
            const tail = await stalled.evaluate(() => {
                const dead = document.querySelector('[data-region="dead-tail"]')?.getBoundingClientRect();
                const mark = document.querySelector('[data-region="end-mark"]')?.getBoundingClientRect();
                const playhead = document.querySelector('[data-region="playhead"]')?.getBoundingClientRect();
                const surface = document.querySelector<HTMLElement>('[data-region="timeline-surface"]');
                const current = (globalThis as any).__kexeditPath.ride();
                if (!dead || !mark || !playhead || !surface) return null;
                const bounds = surface.getBoundingClientRect();
                const duration = current.header.length / current.header.rate;
                return {
                    tailStart: dead.left,
                    tailEnd: dead.right,
                    authoredEnd: bounds.left + ((duration - Number(surface.dataset.viewStart)) * bounds.width) / Number(surface.dataset.viewSpan),
                    markCenter: mark.left + mark.width / 2,
                    playheadCenter: playhead.left + playhead.width / 2,
                };
            });
            expect(tail !== null, "a stalled ride renders no dead tail or end mark", tail);
            expect(Math.abs(tail!.tailStart - tail!.markCenter) <= 1, "the dead tail does not start at the end mark", tail);
            expect(Math.abs(tail!.tailEnd - tail!.authoredEnd) <= 1, "the dead tail does not reach authored length", tail);
            expect(tail!.playheadCenter > tail!.markCenter, "a scrub past the stalled end does not pass the end mark", tail);

            const solidTail = await full.evaluate(() => document.querySelector('[data-region="dead-tail"]') !== null);
            expect(!solidTail, "a complete ride shows a dead tail", solidTail);
            expect(errors.length === 0, "the page logged errors", errors);
        }),
);
