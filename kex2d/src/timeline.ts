/** pure transform + tick math for the force-curve timeline. no Svelte, no DOM,
 *  no solve state — just the arclength↔pixel affine, the 1-2-5 tick generator, and
 *  the pan/zoom clamp. the chart's x-axis is distance (meters): s is the domain the
 *  solver holds fixed, so targets are authored, dragged, and displayed directly in
 *  it. ported from `reference/animation-timeline` (valToPx/pxToVal, _zoom,
 *  _renderTicks, findGoodStep). */

/** view-state: a single affine over the distance axis. `pan` is the content pixel at
 *  the left edge (scroll-like); `pxPerM` is the horizontal scale (px per meter). */
export interface View {
    pan: number;
    pxPerM: number;
}

export interface Tick {
    s: number;
    px: number;
    label: string;
}

/** floor on the breathing room past the track ends, so a short track still has
 *  visible margin. */
const MIN_MARGIN_M = 0.5;
/** zoom-in ceiling — a pixel-per-meter cap so the axis can't blow up. */
export const MAX_PX_PER_M = 4000;
/** target spacing between labeled major ticks, in px. */
const TARGET_TICK_PX = 80;

export const sToPx = (v: View, s: number): number => s * v.pxPerM - v.pan;
export const pxToS = (v: View, px: number): number => (px + v.pan) / v.pxPerM;

/** lead-out (meters) past the track end — proportional, with a floor. one-sided:
 *  the launch is s=0, so there's no lead-*in* (no negative distance on the ruler). */
export const marginArc = (sTotal: number): number => Math.max(0.12 * sTotal, MIN_MARGIN_M);

const minScale = (width: number, sTotal: number): number =>
    width > 0 ? width / (sTotal + marginArc(sTotal)) : 1;

/** clamp a view to the track extent — a PAN clamp, not a zoom clamp. the x-axis is a
 *  document axis (the spatial address of every clip and keyframe), not an auto-fit value
 *  axis, so a content edit that shrinks the track NEVER rescales the ruler: `pxPerM` is
 *  only capped at `MAX_PX_PER_M` (no min-scale floor — zoom changes only by explicit
 *  navigation). the left edge anchors at s=0 (a ride starts at launch, so the ruler shows
 *  no negative distance — the After Effects / NLE convention) and the margin is a
 *  right-side lead-out. a shrunk track just leaves empty ruler on the right; when the
 *  track fits the view the pan range collapses to 0 → left-aligned. */
export function clampView(v: View, width: number, sTotal: number): View {
    const m = marginArc(sTotal);
    const pxPerM = Math.min(MAX_PX_PER_M, v.pxPerM);
    const panMax = Math.max(0, (sTotal + m) * pxPerM - width);
    const pan = Math.min(panMax, Math.max(0, v.pan));
    return { pan, pxPerM };
}

/** geometric zoom by `factor` anchored at `anchorPx`: the meter under the cursor
 *  stays fixed across the scale change. scale is clamped *before* deriving pan, or
 *  the anchor drifts at the zoom limits (the reference's load-bearing gotcha). */
export function zoomAt(
    v: View,
    anchorPx: number,
    factor: number,
    width: number,
    sTotal: number,
): View {
    const sAnchor = pxToS(v, anchorPx);
    // floor at min(current, fit): a below-fit view (after a content shrink) can zoom-out
    // no further but is NEVER pushed UP to the fit — a zoom-out tick must not read as a
    // zoom-in. above fit, the floor is the fit scale, as before.
    const floor = Math.min(v.pxPerM, minScale(width, sTotal));
    const pxPerM = Math.min(MAX_PX_PER_M, Math.max(floor, v.pxPerM * factor));
    return clampView({ pan: sAnchor * pxPerM - anchorPx, pxPerM }, width, sTotal);
}

/** the view that frames the whole track + lead-out (fit scale, left-anchored at s=0).
 *  the one explicit-navigation path that sets the zoom to fit — used for the initial
 *  frame and the F frame-content key, never a content edit (those pan only). */
export const frameAll = (width: number, sTotal: number): View => ({
    pan: 0,
    pxPerM: Math.min(MAX_PX_PER_M, minScale(width, sTotal)),
});

/** the navigator window: the visible span [0, width] expressed as `{l, r}` fractions
 *  of the full track + lead-out (the viewport bracket over the overview). */
export function navWindow(v: View, width: number, sTotal: number): { l: number; r: number } {
    const total = sTotal + marginArc(sTotal);
    const frac = (s: number): number => Math.min(1, Math.max(0, s / total));
    return { l: frac(pxToS(v, 0)), r: frac(pxToS(v, width)) };
}

/** apply a navigator drag and return the clamped view. `pan` slides the window (`grab`
 *  is the meters from the window's left edge to the cursor, held constant); `l`/`r`
 *  drag one edge with the opposite edge anchored — a cursor-anchored zoom. */
export function navDragView(
    v: View,
    width: number,
    sTotal: number,
    mode: "pan" | "l" | "r",
    curS: number,
    grabS: number,
): View {
    const lo = pxToS(v, 0);
    const hi = pxToS(v, width);
    const minSpan = width / MAX_PX_PER_M; // the zoom-in ceiling, as a meter-span floor
    if (mode === "pan")
        return clampView({ pan: (curS - grabS) * v.pxPerM, pxPerM: v.pxPerM }, width, sTotal);
    if (mode === "l") {
        const pps = width / (hi - Math.min(curS, hi - minSpan)); // anchor the right edge
        return clampView({ pan: hi * pps - width, pxPerM: pps }, width, sTotal);
    }
    const pps = width / (Math.max(curS, lo + minSpan) - lo); // anchor the left edge
    return clampView({ pan: lo * pps, pxPerM: pps }, width, sTotal);
}

/** nearest 1-2-5×10ⁿ to `x` — the nice-number tick step. breakpoints are the
 *  geometric means (√2, √10, √50), so each mantissa snaps to its closest of 1/2/5/10. */
export function niceStep(x: number): number {
    if (!(x > 0) || !Number.isFinite(x)) return 1;
    const pow = 10 ** Math.floor(Math.log10(x));
    const b = x / pow;
    return (b < Math.SQRT2 ? 1 : b < Math.sqrt(10) ? 2 : b < Math.sqrt(50) ? 5 : 10) * pow;
}

function fmtDist(s: number, step: number): string {
    const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
    return `${s.toFixed(decimals)}m`;
}

/** the auto-fit g-range for the force axis. `lo`/`hi` bound the display, `step` is
 *  the nice gridline spacing. */
export interface YFit {
    lo: number;
    hi: number;
    step: number;
}

/** the stable default frame the force axis falls back to (a calm window around 1g),
 *  so a gentle near-1g curve always shows the SAME range — no jarring rescale between
 *  zero and one keyframe. it is a floor, not a clamp: data beyond it expands the view. */
const FIT_FLOOR: [number, number] = [-1, 4];
const FIT_PAD = 0.4; // g of breathing room past the data extremes

/** fit a g-range to the data `[min, max]` (and always `base`, the 1g line). The view
 *  is anchored to the stable `FIT_FLOOR` frame and only EXPANDS to include data beyond
 *  it — it never hugs tight, the way After Effects / Unity keep the curve view steady
 *  and grow only when content would clip. Rounds OUTWARD to a nice 1-2-5 step (a pin
 *  wiggle within a step leaves the axis still). The caller eases toward this and
 *  contracts lazily, so an edit grows the view promptly but never snaps it back. */
export function yFit(min: number, max: number, base: number): YFit {
    const lo = Math.min(FIT_FLOOR[0], base, min - FIT_PAD);
    const hi = Math.max(FIT_FLOOR[1], base, max + FIT_PAD);
    const step = niceStep((hi - lo) / 5);
    return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step };
}

/** edge-scroll grow-to-follow for a value drag (the standard "scroll only when the
 *  pointer leaves the viewport" rule): grow the range ONLY when the dragged cursor `cy`
 *  is dragged BEYOND the chart — above `top` or below `bot` — by an amount proportional
 *  to how far past the edge it is (× `rate`), clamped to `cap`. a cursor inside the
 *  chart, even resting on a keyframe at the very edge, returns the range UNCHANGED by
 *  identity (so grabbing a near-boundary keyframe never moves the axis — only dragging
 *  past it does). per-frame application keeps it growing while held beyond the edge. */
export function yGrow(
    v: YFit,
    cy: number,
    top: number,
    bot: number,
    rate: number,
    cap: [number, number],
): YFit {
    const valPerPx = (v.hi - v.lo) / Math.max(1, bot - top);
    let lo = v.lo;
    let hi = v.hi;
    if (cy < top && hi < cap[1]) {
        hi = Math.min(cap[1], hi + (top - cy) * valPerPx * rate);
    } else if (cy > bot && lo > cap[0]) {
        lo = Math.max(cap[0], lo - (cy - bot) * valPerPx * rate);
    } else {
        return v; // cursor within the chart — unchanged (same reference → caller skips)
    }
    return { lo, hi, step: niceStep((hi - lo) / 5) };
}

/** edge-scroll pan-to-follow for a horizontal drag (the x-analogue of `yGrow`): pan
 *  the view to follow a cursor dragged PAST the chart — left of `left` or right of
 *  `right` — by an amount proportional to the overshoot (× `rate`). `pxPerM` is
 *  untouched (no zoom under the drag). a cursor inside the chart returns the view
 *  UNCHANGED by identity (so the caller skips). the left pan floors at 0 — the ruler
 *  never shows negative distance (the launch is s=0). per-frame application keeps it
 *  scrolling while the cursor is held beyond the edge. */
export function xGrow(v: View, cx: number, left: number, right: number, rate: number): View {
    if (cx > right) return { pan: v.pan + (cx - right) * rate, pxPerM: v.pxPerM };
    if (cx < left) {
        const pan = Math.max(0, v.pan - (left - cx) * rate);
        return pan === v.pan ? v : { pan, pxPerM: v.pxPerM };
    }
    return v; // cursor within the chart — unchanged (same reference → caller skips)
}

/** the snap magnet threshold, in screen px — an After Effects magnet design constant (a
 *  fixed on-screen pull distance, zoom-independent), not a tuned tolerance. */
export const SNAP_PX = 8;

/** nearest-target magnet snap on one axis, resolved in screen px (the AE magnet model).
 *  returns the target within `threshold` px closest to `px`, or null when none is in
 *  range — the caller then keeps the raw value and skips the guide flash. targets are
 *  enumerated and projected to px by the caller from content landmarks (section
 *  boundaries, other force points, the playhead, the 1g baseline — never display artifacts
 *  like ruler ticks; editor-ui.md), so the pull is a fixed screen distance at any zoom.
 *  pure — this is the whole snap resolver; the axis target sets live at the call sites. */
export function snap(px: number, targets: Iterable<number>, threshold = SNAP_PX): number | null {
    let best: number | null = null;
    let bestD = threshold;
    for (const t of targets) {
        const d = Math.abs(t - px);
        if (d <= bestD) {
            bestD = d;
            best = t;
        }
    }
    return best;
}

/** the extent-trim magnet targets in chart-local px: content landmarks that are stable
 *  under the resize (editor-ui.md) — the section's own force points (cumulative arclengths
 *  `ownS`, section-local so fixed while the extent changes) and the parked playhead
 *  (`playheadS`, null while playing or unset — the Premiere trim-to-playhead idiom). Ruler
 *  ticks and section boundaries are deliberately absent: ticks are the zoom-dependent
 *  display raster, and the section's own exit + downstream boundaries move with the resize
 *  (self-snap). Projected through the view `v` so the pull is a fixed screen distance. */
export function trimTargets(v: View, ownS: Iterable<number>, playheadS: number | null): number[] {
    const out: number[] = [];
    for (const s of ownS) out.push(sToPx(v, s));
    if (playheadS !== null) out.push(sToPx(v, playheadS));
    return out;
}

/** per-sample cumulative arclength (m) and time (s) over the current baked track,
 *  both monotone increasing — the cart↔chart projection. the chart's x-axis is
 *  distance, but the cart rides the track in *time* (paced by its velocity), so the
 *  playhead projects the cart's `t` through this to a chart s, and a ruler scrub maps
 *  the picked s back to a cart `t`. built from the display bake by `cart.trackMapping`. */
export interface Mapping {
    arc: Float64Array;
    t: Float64Array;
    n: number;
}

/** interpolate `ys` at where `v` falls in the monotone-increasing `xs` (length
 *  `n`), clamped to the ends. a small monotone table lookup — binary search. */
function interpMono(xs: Float64Array, ys: Float64Array, n: number, v: number): number {
    if (n <= 1) return ys[0] ?? 0;
    if (v <= xs[0]) return ys[0];
    if (v >= xs[n - 1]) return ys[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (xs[mid] <= v) lo = mid;
        else hi = mid;
    }
    const span = xs[hi] - xs[lo];
    const f = span > 0 ? (v - xs[lo]) / span : 0;
    return ys[lo] + f * (ys[hi] - ys[lo]);
}

/** track time (s) → arclength (m) along the current bake. */
export const timeToArc = (m: Mapping, time: number): number => interpMono(m.t, m.arc, m.n, time);

/** arclength (m) → track time (s) along the current bake. */
export const arcToTime = (m: Mapping, s: number): number => interpMono(m.arc, m.t, m.n, s);

/** the labeled major ticks visible in [0, width], on the 1-2-5 grid. */
export function ticks(v: View, width: number): Tick[] {
    if (!(v.pxPerM > 0) || width <= 0) return [];
    const step = niceStep(TARGET_TICK_PX / v.pxPerM);
    const from = pxToS(v, 0);
    const to = pxToS(v, width);
    const out: Tick[] = [];
    for (let s = Math.floor(from / step) * step; s <= to + step * 0.5; s += step) {
        const sv = Math.abs(s) < step * 1e-6 ? 0 : s; // snap fp drift to a clean 0
        out.push({ s: sv, px: sToPx(v, sv), label: fmtDist(sv, step) });
    }
    return out;
}
