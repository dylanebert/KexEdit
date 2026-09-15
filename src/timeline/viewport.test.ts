import { check } from "@dylanebert/shallot/harness/check";
import {
    clampViewport,
    FIT_PADDING_PX,
    frameAll,
    MAX_SPAN_RATIO,
    panByPixels,
    pixelToTime,
    timeToPixel,
    updateDomain,
    visibleTicks,
    wheelZoomRatio,
    zoomAtPixel,
} from "./viewport";

const close = (actual: number, expected: number, tolerance = 1e-9): boolean =>
    Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(actual), Math.abs(expected));

function refuses(action: () => unknown): void {
    let refused = false;
    try {
        action();
    } catch {
        refused = true;
    }
    if (!refused) throw new Error("expected invalid viewport input to refuse");
}

check(
    "the timeline viewport keeps an affine bounded authored domain",
    { claim: "timeline viewport transforms overscroll or silently accept an invalid width or domain", budget: 250 },
    () => {
        const narrow = frameAll(12, 100, 520);
        const wide = frameAll(12, 100, 1323);
        if (!close(timeToPixel(narrow, 520, 0), FIT_PADDING_PX) || !close(timeToPixel(narrow, 520, 12), 520 - FIT_PADDING_PX)) {
            throw new Error(`narrow fit ${JSON.stringify(narrow)}`);
        }
        if (!close(timeToPixel(wide, 1323, 0), FIT_PADDING_PX) || !close(timeToPixel(wide, 1323, 12), 1323 - FIT_PADDING_PX)) {
            throw new Error(`wide fit ${JSON.stringify(wide)}`);
        }
        if (!(narrow.span > 12 && wide.span > 12 && narrow.span !== wide.span && narrow.span < 24 && wide.span < 24)) {
            throw new Error(`fit span policy failed: ${JSON.stringify({ narrow, wide })}`);
        }
        const view = narrow;
        if (view.minSpan !== 0.01) throw new Error(`minimum span ${view.minSpan}`);
        if (!close(timeToPixel(view, 520, 0), FIT_PADDING_PX) || !close(timeToPixel(view, 520, 12), 520 - FIT_PADDING_PX)) throw new Error("endpoint transform failed");
        for (const time of [0.25, 2, 6.5, 11.75]) {
            const pixel = timeToPixel(view, 1200, time);
            if (!close(pixelToTime(view, 1200, pixel), time)) throw new Error(`round trip at ${time}`);
        }

        const zoomed = clampViewport({ ...view, start: 9, span: 4 });
        if (zoomed.start !== 9 || zoomed.span !== 4) throw new Error(`clamp order ${JSON.stringify(zoomed)}`);
        const left = panByPixels(zoomed, 520, -10_000);
        const right = panByPixels(zoomed, 520, 10_000);
        if (left.start !== -2 || right.start !== 10) throw new Error(`pan crossed the legal blank domain: ${JSON.stringify({ left, right })}`);
        const preserved = updateDomain(zoomed, 20, 10);
        if (preserved.start !== 9 || preserved.span !== 4 || preserved.duration !== 20) throw new Error("domain update inferred or reset the interval");

        refuses(() => frameAll(0, 100, 520));
        refuses(() => frameAll(1, 0, 520));
        refuses(() => frameAll(1, 100, 96));
        refuses(() => timeToPixel(view, 0, 1));
        refuses(() => pixelToTime(view, Number.NaN, 1));
    },
);

check(
    "cursor anchored zoom respects span limits",
    { claim: "timeline zoom loses its cursor anchor or applies a requested span beyond the authored bounds", budget: 250 },
    () => {
        const base = clampViewport({ ...frameAll(20, 10, 1000), start: 4, span: 8 });
        const width = 1000;
        for (const fraction of [0, 0.25, 0.7, 1]) {
            const pixel = width * fraction;
            const before = pixelToTime(base, width, pixel);
            const zoomIn = zoomAtPixel(base, width, pixel, 0.25);
            const zoomOut = zoomAtPixel(base, width, pixel, 1.25);
            if (!close(pixelToTime(zoomIn, width, pixel), before) || !close(pixelToTime(zoomOut, width, pixel), before)) {
                throw new Error(`anchor moved at ${fraction}`);
            }
        }
        const minimum = zoomAtPixel(base, width, 500, 1e-12);
        if (minimum.span !== minimum.minSpan) throw new Error(`minimum ${minimum.span}`);
        if (zoomAtPixel(minimum, width, 500, 0.01) !== minimum) throw new Error("minimum span changed after reaching its limit");
        const maximum = zoomAtPixel(base, width, 500, 1e12);
        if (maximum.span !== maximum.duration * MAX_SPAN_RATIO) throw new Error(`maximum ${maximum.span}`);
        if (zoomAtPixel(maximum, width, 500, 4) !== maximum) throw new Error("maximum span changed after reaching its limit");

        const edge = clampViewport({ ...frameAll(20, 10, 1000), start: 17, span: 3 });
        const framed = zoomAtPixel(edge, width, 500, 100);
        if (!close(framed.start, -1.5) || framed.span !== 40) throw new Error(`edge zoom was not nearest legal view ${JSON.stringify(framed)}`);

        const blank = clampViewport({ ...frameAll(20, 10, 1000), start: -10, span: 40 });
        for (const fraction of [0, 0.25, 0.7, 1]) {
            const pixel = width * fraction;
            const before = pixelToTime(blank, width, pixel);
            const after = zoomAtPixel(blank, width, pixel, 0.5);
            const expectedStart = Math.min(after.duration - after.span / 2, Math.max(-after.span / 2, before - fraction * after.span));
            if (after.start !== expectedStart) throw new Error(`blank edge clamp failed at ${fraction}`);
        }
    },
);

check(
    "timeline pan and frame-all stay on the authored seconds axis",
    { claim: "timeline pan uses the wrong sign or frame-all changes the transport domain", budget: 250 },
    () => {
        const all = frameAll(20, 10, 1000);
        const view = clampViewport({ ...all, start: 5, span: 5 });
        if (panByPixels(view, 1000, 100).start <= view.start) throw new Error("positive wheel delta did not reveal later time");
        if (panByPixels(view, 1000, -100).start >= view.start) throw new Error("negative pointer delta did not reveal earlier time");
        const overscrolled = panByPixels(panByPixels(view, 1000, 1e9), 1000, -1e9);
        if (overscrolled.start !== -view.span / 2) throw new Error(`pan did not return to the left legal boundary ${overscrolled.start}`);
        const right = panByPixels(view, 1000, 1e9);
        if (right.start !== view.duration - view.span / 2) throw new Error(`pan did not reach the right legal boundary ${right.start}`);
        const maximum = clampViewport({ ...view, span: 1e9 });
        if (maximum.span !== 40 || maximum.start < -20 || maximum.start > 0) throw new Error(`maximum domain escaped ${JSON.stringify(maximum)}`);
        const restored = frameAll(view.duration, 10, 1000);
        if (!close(timeToPixel(restored, 1000, 0), FIT_PADDING_PX) || !close(timeToPixel(restored, 1000, 20), 1000 - FIT_PADDING_PX)) {
            throw new Error("frame-all did not restore the padded authored range");
        }
    },
);

check(
    "wheel deltas are bounded continuous cursor zoom and normalized pan inputs",
    { claim: "timeline wheel normalization reverses direction, jumps geometric scales, or loses mode and pan sign", budget: 250 },
    () => {
        const plain = wheelZoomRatio(100, 0);
        if (!close(plain, 2 ** 0.2) || !close(wheelZoomRatio(-100, 0), 2 ** -0.2)) throw new Error("plain pixel wheel direction or ratio failed");
        if (wheelZoomRatio(10_000, 0) !== 2 ** 0.25 || wheelZoomRatio(-10_000, 0) !== 2 ** -0.25) {
            throw new Error("wheel exponent was not capped");
        }
        if (wheelZoomRatio(1, 1) !== 2 ** 0.05 || wheelZoomRatio(1, 2) !== 2 ** 0.25) throw new Error("line/page normalization failed");
        if (wheelZoomRatio(0.01, 0, true) !== 2 ** 0.0002 || wheelZoomRatio(100, 0, true) !== 2 ** 0.25) throw new Error("modified gain failed");

        const width = 1000;
        const start = clampViewport({ ...frameAll(100, 10, 1000), start: 30, span: 20 });
        const first = zoomAtPixel(start, width, 400, plain);
        const second = zoomAtPixel(first, width, 400, plain);
        if (!close(second.span / first.span, first.span / start.span)) throw new Error("equal wheel events were not continuous geometric increments");
        if (second.span === Math.round(second.span)) throw new Error("wheel zoom was rounded to a ruler step");

        const pan = panByPixels(start, width, 16);
        if (!(pan.start > start.start) || pan.span !== start.span) throw new Error("positive normalized pan sign failed");
        const page = panByPixels(start, width, width);
        if (!close(page.start, start.start + start.span)) throw new Error("page pan was not viewport-width normalized");
        if (panByPixels(start, width, -1e9).start !== -start.span / 2 || panByPixels(start, width, 1e9).start !== start.duration - start.span / 2) throw new Error("pan limits failed");
    },
);

check(
    "timeline ticks are sparse visible 1-2-5 marks",
    { claim: "timeline ruler ticks derive from total duration or emit marks outside the visible range", budget: 250 },
    () => {
        const ranges = [
            { view: frameAll(120, 10, 960), width: 960 },
            { view: clampViewport({ ...frameAll(120, 10, 960), start: 23, span: 4 }), width: 960 },
            { view: clampViewport({ ...frameAll(120, 10, 480), start: 30, span: 1 }), width: 480 },
        ];
        let observedSteps = new Set<number>();
        for (const { view, width } of ranges) {
            const ticks = visibleTicks(view, width);
            if (!ticks.length || ticks.some((tick) => tick.seconds < view.start - 1e-8 || tick.seconds > view.start + view.span + 1e-8)) {
                throw new Error(`invisible tick ${JSON.stringify(ticks)}`);
            }
            const majors = ticks.filter((tick) => tick.major);
            const minors = ticks.filter((tick) => !tick.major);
            if (majors.length < 2 || !minors.length) throw new Error(`insufficient tick population ${JSON.stringify(ticks)}`);
            const step = majors[1].seconds - majors[0].seconds;
            observedSteps.add(step);
            const power = 10 ** Math.floor(Math.log10(step));
            const normalized = step / power;
            if (![1, 2, 5].some((candidate) => close(normalized, candidate))) throw new Error(`not a 1-2-5 step ${step}`);
            if (!majors.every((tick, index) => index === 0 || tick.seconds > majors[index - 1].seconds)) throw new Error("major labels do not increase");
            if (!majors.slice(1).some((major, index) => minors.some((minor) => minor.seconds > majors[index].seconds && minor.seconds < major.seconds))) {
                throw new Error("no minor subdivision between majors");
            }
        }
        if (observedSteps.size < 2) throw new Error(`visible range did not adapt its step: ${[...observedSteps]}`);

        const blank = clampViewport({ ...frameAll(12, 10, 520), start: -4, span: 20 });
        const blankTicks = visibleTicks(blank, 520);
        if (!blankTicks.some((tick) => tick.seconds < 0) || !blankTicks.some((tick) => tick.seconds > blank.duration)) {
            throw new Error(`visible ticks were clipped to authored time: ${JSON.stringify(blankTicks)}`);
        }
    },
);
