import { check } from "@dylanebert/shallot/harness/check";
import {
    clampViewport,
    FIT_PADDING_PX,
    frameAll,
    panByPixels,
    pixelToTime,
    timeToPixel,
    timelineDomainEnd,
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
    "the timeline domain uses a content-relative post-end pad",
    { claim: "timeline domain padding is not exactly one authored duration" },
    () => {
        for (const duration of [12, 37.5]) {
            if (timelineDomainEnd(duration) !== 2 * duration) throw new Error(`domain end ${timelineDomainEnd(duration)}`);
        }
        refuses(() => timelineDomainEnd(0));
        refuses(() => timelineDomainEnd(Number.NaN));
    },
);

check(
    "one-sided frame-all keeps zero at the surface origin",
    { claim: "timeline frame-all admits negative time or loses its fixed post-end clearance" },
    () => {
        for (const width of [520, 1323]) {
            const view = frameAll(12, 100, width);
            if (view.start !== 0 || !close(timeToPixel(view, width, 0), 0) || !close(timeToPixel(view, width, 12), width - FIT_PADDING_PX)) {
                throw new Error(`one-sided fit ${JSON.stringify({ width, view })}`);
            }
            if (!(view.span > 12 && view.span < 24)) {
                throw new Error(`fit does not leave post-end context ${JSON.stringify({ width, view })}`);
            }
        }
        refuses(() => frameAll(1, 100, 48));
        const view = frameAll(12, 100, 520);
        for (const time of [0.25, 2, 6.5, 11.75]) {
            const pixel = timeToPixel(view, 1200, time);
            if (!close(pixelToTime(view, 1200, pixel), time)) throw new Error(`round trip at ${time}`);
        }
    },
);

check(
    "the timeline maximum is a unique complete legal domain",
    { claim: "timeline maximum or pan bounds expose time outside zero through twice the duration" },
    () => {
        const fit = frameAll(20, 10, 1000);
        const view = clampViewport({ ...fit, start: 5, span: 5 });
        const maximum = zoomAtPixel(view, 1000, 500, 1e12);
        if (maximum.start !== 0 || maximum.span !== 40 || maximum.start + maximum.span !== timelineDomainEnd(20)) {
            throw new Error(`maximum is not exact ${JSON.stringify(maximum)}`);
        }
        if (!close(timeToPixel(maximum, 1000, 20), 500)) throw new Error("authored end is not half the maximum view");
        if (zoomAtPixel(maximum, 1000, 500, 4) !== maximum) throw new Error("maximum outward zoom was not an identity no-op");

        for (const span of [1, 5, 19]) {
            const base = clampViewport({ ...fit, start: 5, span });
            const left = panByPixels(base, 1000, -1e9);
            const right = panByPixels(base, 1000, 1e9);
            if (left.start !== 0 || right.start !== 40 - span || left.start < 0 || right.start + span > 40) {
                throw new Error(`pan escaped legal domain ${JSON.stringify({ span, left, right })}`);
            }
        }
    },
);

check(
    "cursor zoom preserves interior anchors and clamps only at domain edges",
    { claim: "timeline cursor zoom translates before clamping or exposes an illegal edge to preserve its anchor" },
    () => {
        const width = 1000;
        const base = clampViewport({ ...frameAll(20, 10, width), start: 4, span: 8 });
        for (const fraction of [0, 0.25, 0.7, 1]) {
            const pixel = width * fraction;
            const before = pixelToTime(base, width, pixel);
            const zoomIn = zoomAtPixel(base, width, pixel, 0.25);
            const zoomOut = zoomAtPixel(base, width, pixel, 1.25);
            if (!close(pixelToTime(zoomIn, width, pixel), before) || !close(pixelToTime(zoomOut, width, pixel), before)) {
                throw new Error(`interior anchor moved at ${fraction}`);
            }
        }

        const fromFit = zoomAtPixel(frameAll(20, 10, width), width, 0, 2);
        if (fromFit.start !== 0) throw new Error(`outward fit zoom exposed negative time ${fromFit.start}`);
        const left = zoomAtPixel(clampViewport({ ...base, start: 0, span: 3 }), width, width, 100);
        if (left.start !== 0) throw new Error(`left boundary exception ${left.start}`);
        const right = zoomAtPixel(clampViewport({ ...base, start: 37, span: 3 }), width, 0, 6);
        if (right.start !== 22 || right.start + right.span !== timelineDomainEnd(20)) throw new Error(`right boundary did not choose nearest legal viewport ${JSON.stringify(right)}`);

        const minimum = zoomAtPixel(base, width, 500, 1e-12);
        if (minimum.span !== minimum.minSpan || zoomAtPixel(minimum, width, 500, 0.01) !== minimum) throw new Error("minimum no-op failed");
    },
);

check(
    "fit resize and domain changes preserve the intended presentation state",
    { claim: "timeline fit resize or domain changes infer the wrong seconds interval" },
    () => {
        const narrow = frameAll(12, 100, 520);
        const wide = frameAll(12, 100, 1323);
        if (narrow.start !== 0 || wide.start !== 0 || narrow.span === wide.span) throw new Error("fit did not recompute its width-dependent span");

        const manual = clampViewport({ ...frameAll(20, 10, 1000), start: 22, span: 8 });
        const retained = updateDomain(manual, 15, 10);
        if (retained.start !== 22 || retained.span !== 8 || retained.duration !== 15) throw new Error(`legal manual interval was reframed ${JSON.stringify(retained)}`);
        const clamped = updateDomain(manual, 10, 10);
        if (clamped.start !== 12 || clamped.span !== 8 || clamped.start + clamped.span !== timelineDomainEnd(10)) {
            throw new Error(`changed-domain clamp failed ${JSON.stringify(clamped)}`);
        }
    },
);

check(
    "visible ticks cover only the legal domain and retain adaptive 1-2-5 spacing",
    { claim: "timeline ticks emit negative time, exceed the legal end, or clip visible post-end context" },
    () => {
        const ranges = [
            { view: frameAll(120, 10, 960), width: 960 },
            { view: clampViewport({ ...frameAll(120, 10, 960), start: 23, span: 4 }), width: 960 },
            { view: clampViewport({ ...frameAll(120, 10, 480), start: 30, span: 1 }), width: 480 },
        ];
        const observedSteps = new Set<number>();
        for (const { view, width } of ranges) {
            const ticks = visibleTicks(view, width);
            if (!ticks.length || ticks.some((tick) => tick.seconds < -1e-8 || tick.seconds > timelineDomainEnd(view.duration) + 1e-8)) {
                throw new Error(`illegal tick ${JSON.stringify(ticks)}`);
            }
            const majors = ticks.filter((tick) => tick.major);
            const minors = ticks.filter((tick) => !tick.major);
            if (majors.length < 2 || !minors.length) throw new Error(`insufficient tick population ${JSON.stringify(ticks)}`);
            const step = majors[1].seconds - majors[0].seconds;
            observedSteps.add(step);
            const power = 10 ** Math.floor(Math.log10(step));
            if (![1, 2, 5].some((candidate) => close(step / power, candidate))) throw new Error(`not a 1-2-5 step ${step}`);
            if (!majors.slice(1).some((major, index) => minors.some((minor) => minor.seconds > majors[index].seconds && minor.seconds < major.seconds))) {
                throw new Error("no minor subdivision between majors");
            }
        }
        const postEnd = clampViewport({ duration: 12, minSpan: 0.1, start: 18, span: 4 });
        const postEndTicks = visibleTicks(postEnd, 960);
        if (!postEndTicks.some((tick) => tick.seconds > 12) || postEndTicks.some((tick) => tick.seconds < 0 || tick.seconds > 24)) {
            throw new Error(`post-end ticks were clipped or illegal ${JSON.stringify(postEndTicks)}`);
        }
        if (observedSteps.size < 2) throw new Error(`visible range did not adapt its step: ${[...observedSteps]}`);
    },
);

check(
    "wheel deltas retain direct manipulation direction and geometric increments",
    { claim: "timeline wheel normalization reverses direction, jumps scales, or loses pan sign" },
    () => {
        const plain = wheelZoomRatio(100, 0);
        if (!close(plain, 2 ** 0.2) || !close(wheelZoomRatio(-100, 0), 2 ** -0.2)) throw new Error("pixel wheel direction or ratio failed");
        if (wheelZoomRatio(10_000, 0) !== 2 ** 0.25 || wheelZoomRatio(-10_000, 0) !== 2 ** -0.25) throw new Error("wheel exponent was not capped");
        if (wheelZoomRatio(1, 1) !== 2 ** 0.05 || wheelZoomRatio(1, 2) !== 2 ** 0.25) throw new Error("line/page normalization failed");
        if (wheelZoomRatio(0.01, 0, true) !== 2 ** 0.0002 || wheelZoomRatio(100, 0, true) !== 2 ** 0.25) throw new Error("modified gain failed");

        const start = clampViewport({ ...frameAll(100, 10, 1000), start: 30, span: 20 });
        const first = zoomAtPixel(start, 1000, 400, plain);
        const second = zoomAtPixel(first, 1000, 400, plain);
        if (!close(second.span / first.span, first.span / start.span) || second.span === Math.round(second.span)) throw new Error("wheel zoom was not continuous");
        const pan = panByPixels(start, 1000, 16);
        if (!(pan.start > start.start) || pan.span !== start.span) throw new Error("positive pan sign failed");
    },
);
