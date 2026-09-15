export interface TimelineViewport {
    duration: number;
    minSpan: number;
    start: number;
    span: number;
}

export interface TimelineTick {
    seconds: number;
    major: boolean;
    label: string;
}

export const FIT_PADDING_PX = 24;
export const POST_END_PADDING_RATIO = 1;
export const MAX_SPAN_RATIO = 1 + POST_END_PADDING_RATIO;

const finitePositive = (value: number, name: string): void => {
    if (!(Number.isFinite(value) && value > 0)) throw new Error(`${name}: expected finite > 0, got ${value}`);
};

export function timelineDomainEnd(duration: number): number {
    finitePositive(duration, "timeline duration");
    return duration * MAX_SPAN_RATIO;
}

function validateViewport(view: TimelineViewport): void {
    finitePositive(view.duration, "timeline duration");
    finitePositive(view.minSpan, "timeline minimum span");
    if (view.minSpan > view.duration) throw new Error("timeline minimum span exceeds duration");
    if (!(Number.isFinite(view.start) && Number.isFinite(view.span))) {
        throw new Error("timeline viewport: start and span must be finite");
    }
}

/** Fit the whole authored range inside a fixed screen-space inset. */
export function frameAll(duration: number, headerRate: number, width: number): TimelineViewport {
    finitePositive(duration, "timeline duration");
    finitePositive(headerRate, "timeline header rate");
    validateWidth(width);
    if (!(width > 2 * FIT_PADDING_PX)) {
        throw new Error(`timeline width: expected > ${2 * FIT_PADDING_PX}, got ${width}`);
    }
    const innerWidth = width - FIT_PADDING_PX;
    const span = (duration * width) / innerWidth;
    return { duration, minSpan: Math.min(duration, 1 / headerRate), start: 0, span };
}

/** Preserve an existing interval when the authored domain changes, applying the current legal bounds. */
export function updateDomain(view: TimelineViewport, duration: number, headerRate: number): TimelineViewport {
    finitePositive(duration, "timeline duration");
    finitePositive(headerRate, "timeline header rate");
    validateViewport(view);
    return clampViewport({ duration, minSpan: Math.min(duration, 1 / headerRate), start: view.start, span: view.span });
}

/** Apply the load-bearing span-then-start clamp order. */
export function clampViewport(view: TimelineViewport): TimelineViewport {
    validateViewport(view);
    const end = timelineDomainEnd(view.duration);
    const span = Math.min(end, Math.max(view.minSpan, view.span));
    const start = Math.min(end - span, Math.max(0, view.start));
    return { ...view, start, span };
}

function validateWidth(width: number): void {
    finitePositive(width, "timeline width");
}

/** Affine seconds-to-pixels transform. Its time argument is deliberately not clamped. */
export function timeToPixel(view: TimelineViewport, width: number, time: number): number {
    validateViewport(view);
    validateWidth(width);
    if (!Number.isFinite(time)) throw new Error(`timeline time: expected finite, got ${time}`);
    return (time - view.start) * width / view.span;
}

/** Affine pixels-to-seconds transform. Its pixel argument is deliberately not clamped. */
export function pixelToTime(view: TimelineViewport, width: number, pixel: number): number {
    validateViewport(view);
    validateWidth(width);
    if (!Number.isFinite(pixel)) throw new Error(`timeline pixel: expected finite, got ${pixel}`);
    return view.start + (pixel * view.span) / width;
}

/** Pan by a pixel delta; positive wheel motion reveals later authored time. */
export function panByPixels(view: TimelineViewport, width: number, deltaPixels: number): TimelineViewport {
    validateViewport(view);
    validateWidth(width);
    if (!Number.isFinite(deltaPixels)) throw new Error(`timeline pan: expected finite delta, got ${deltaPixels}`);
    return clampViewport({ ...view, start: view.start + (deltaPixels * view.span) / width });
}

/** Zoom geometrically around a pixel anchor, clamping the span before translating the anchor. */
export function zoomAtPixel(view: TimelineViewport, width: number, pixel: number, ratio: number): TimelineViewport {
    validateViewport(view);
    validateWidth(width);
    if (!Number.isFinite(pixel)) throw new Error(`timeline anchor: expected finite pixel, got ${pixel}`);
    finitePositive(ratio, "timeline zoom ratio");
    const boundedPixel = Math.min(width, Math.max(0, pixel));
    const newSpan = Math.min(timelineDomainEnd(view.duration), Math.max(view.minSpan, view.span * ratio));
    if (newSpan === view.span) return view;
    const anchor = pixelToTime(view, width, boundedPixel);
    const fraction = boundedPixel / width;
    return clampViewport({ ...view, start: anchor - fraction * newSpan, span: newSpan });
}

/** Normalize a wheel delta to a bounded geometric exponent used by the viewport. */
export function wheelZoomRatio(deltaY: number, deltaMode: number, modified = false): number {
    if (!Number.isFinite(deltaY)) throw new Error(`timeline wheel delta: expected finite, got ${deltaY}`);
    const unit = deltaMode === 1 ? 0.05 : deltaMode === 2 ? 1 : 0.002;
    const gain = modified ? 10 : 1;
    const exponent = Math.min(0.25, Math.max(-0.25, deltaY * unit * gain));
    return 2 ** exponent;
}

function niceStep(rawStep: number): number {
    finitePositive(rawStep, "timeline tick step");
    const power = 10 ** Math.floor(Math.log10(rawStep));
    const normalized = rawStep / power;
    const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
    return multiplier === 10 ? power * 10 : power * multiplier;
}

function labelFor(seconds: number, step: number): string {
    const precision = Math.max(0, -Math.floor(Math.log10(step)));
    const value = Math.abs(seconds) < step * 1e-9 ? 0 : seconds;
    return value.toFixed(precision).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

/** Generate only visible 1–2–5 minor marks and labeled majors for a viewport. */
export function visibleTicks(view: TimelineViewport, width: number): TimelineTick[] {
    validateViewport(view);
    validateWidth(width);
    const targetIntervals = Math.max(2, Math.floor(width / 96));
    const majorStep = niceStep(view.span / targetIntervals);
    const minorStep = majorStep / 5;
    const epsilon = minorStep * 1e-9;
    const first = Math.ceil((view.start - epsilon) / minorStep);
    const last = Math.floor((view.start + view.span + epsilon) / minorStep);
    const ticks: TimelineTick[] = [];

    for (let index = first; index <= last; index += 1) {
        const raw = index * minorStep;
        const seconds = Math.abs(raw) < epsilon ? 0 : raw;
        const major = index % 5 === 0;
        ticks.push({ seconds, major, label: major ? labelFor(seconds, majorStep) : "" });
    }
    return ticks;
}
