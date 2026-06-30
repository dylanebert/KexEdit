/** pure transform + tick math for the force-curve timeline. no Svelte, no DOM,
 *  no solve state — just the second↔pixel affine, the 1-2-5 tick generator, and
 *  the pan/zoom clamp. ported from `reference/animation-timeline` (valToPx/pxToVal,
 *  _zoom, _renderTicks, findGoodStep). */

/** view-state: a single affine over the time axis. `pan` is the content pixel at
 *  the left edge (scroll-like); `pxPerSec` is the horizontal scale. */
export interface View {
    pan: number;
    pxPerSec: number;
}

export interface Tick {
    sec: number;
    px: number;
    label: string;
}

/** floor on the breathing room past the track ends, so a sub-second track still
 *  has visible margin. */
const MIN_MARGIN_SEC = 0.5;
/** zoom-in ceiling — a pixel-per-second cap so the axis can't blow up. */
const MAX_PX_PER_SEC = 4000;
/** target spacing between labeled major ticks, in px. */
const TARGET_TICK_PX = 80;

export const secToPx = (v: View, t: number): number => t * v.pxPerSec - v.pan;
export const pxToSec = (v: View, px: number): number => (px + v.pan) / v.pxPerSec;

/** lead-out (seconds) past the track end — proportional, with a floor. one-sided:
 *  the launch is t=0, so there's no lead-*in* (no negative time on the ruler). */
export const marginSec = (tTotal: number): number => Math.max(0.12 * tTotal, MIN_MARGIN_SEC);

const minScale = (width: number, tTotal: number): number =>
    width > 0 ? width / (tTotal + marginSec(tTotal)) : 1;

/** clamp a view to the track extent: scale no smaller than fits [0, tTotal+margin],
 *  the left edge anchored at t=0. a coaster ride starts at launch, so the ruler never
 *  shows negative time (the After Effects / NLE convention); the margin is a right-side
 *  lead-out only, so the last node isn't jammed against the edge. when the track is
 *  smaller than the view the pan range collapses to 0 → the track sits left-aligned. */
export function clampView(v: View, width: number, tTotal: number): View {
    const m = marginSec(tTotal);
    const pxPerSec = Math.min(MAX_PX_PER_SEC, Math.max(minScale(width, tTotal), v.pxPerSec));
    const panMax = Math.max(0, (tTotal + m) * pxPerSec - width);
    const pan = Math.min(panMax, Math.max(0, v.pan));
    return { pan, pxPerSec };
}

/** geometric zoom by `factor` anchored at `anchorPx`: the second under the cursor
 *  stays fixed across the scale change. scale is clamped *before* deriving pan, or
 *  the anchor drifts at the zoom limits (the reference's load-bearing gotcha). */
export function zoomAt(
    v: View,
    anchorPx: number,
    factor: number,
    width: number,
    tTotal: number,
): View {
    const secAnchor = pxToSec(v, anchorPx);
    const pxPerSec = Math.min(
        MAX_PX_PER_SEC,
        Math.max(minScale(width, tTotal), v.pxPerSec * factor),
    );
    return clampView({ pan: secAnchor * pxPerSec - anchorPx, pxPerSec }, width, tTotal);
}

/** the view that frames the whole track + lead-out (min scale, left-anchored at t=0). */
export const frameAll = (width: number, tTotal: number): View =>
    clampView({ pan: -Number.MAX_VALUE, pxPerSec: 0 }, width, tTotal);

/** nearest 1-2-5×10ⁿ to `x` — the nice-number tick step. breakpoints are the
 *  geometric means (√2, √10, √50), so each mantissa snaps to its closest of 1/2/5/10. */
export function niceStep(x: number): number {
    if (!(x > 0) || !Number.isFinite(x)) return 1;
    const pow = 10 ** Math.floor(Math.log10(x));
    const b = x / pow;
    return (b < Math.SQRT2 ? 1 : b < Math.sqrt(10) ? 2 : b < Math.sqrt(50) ? 5 : 10) * pow;
}

function fmtSec(sec: number, step: number): string {
    const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
    return `${sec.toFixed(decimals)}s`;
}

/** the labeled major ticks visible in [0, width], on the 1-2-5 grid. */
export function ticks(v: View, width: number): Tick[] {
    if (!(v.pxPerSec > 0) || width <= 0) return [];
    const step = niceStep(TARGET_TICK_PX / v.pxPerSec);
    const from = pxToSec(v, 0);
    const to = pxToSec(v, width);
    const out: Tick[] = [];
    for (let s = Math.floor(from / step) * step; s <= to + step * 0.5; s += step) {
        const sec = Math.abs(s) < step * 1e-6 ? 0 : s; // snap fp drift to a clean 0
        out.push({ sec, px: secToPx(v, sec), label: fmtSec(sec, step) });
    }
    return out;
}
