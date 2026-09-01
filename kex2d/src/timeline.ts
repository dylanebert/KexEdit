/** pure transform + tick math for the force-curve timeline. no Svelte, no DOM,
 *  no solve state — just the coordinate↔pixel affine, the 1-2-5 tick generator, and
 *  the pan/zoom clamp.
 *
 *  The chart's x-axis is a coordinate `u`, one of two global axes: distance `d` (meters) or
 *  march time `t` (seconds), picked by `Track.domain`. Every force keyframe, extent, strip and
 *  strip keyframe is stored in meters of arclength always — `Track.domain` is a view, not the
 *  store's unit — so a Time reading always projects through the lens. `dToU`/`uToD` are the ONE
 *  seam every such subject goes through (a force keyframe on the chart, the recovered force
 *  curve, a geo node tick, the cart's park): identity on distance, the live bake's arc↔time table
 *  on time, frozen per gesture (`gestureMapping`) so the table a drag reads doesn't move under
 *  it. `T_GRID` and `marginFloor` are the two axis-picked constants (snap quantum, lead-out
 *  floor) and `ticks` picks the unit suffix; everything else below (`View`, `uToPx`/`pxToU`,
 *  `zoomAt`, `snap`) reads `u` with no further branching.
 *
 *  ported from `reference/animation-timeline` (valToPx/pxToVal, _zoom, _renderTicks,
 *  findGoodStep). */

import { Domain } from "./section";
import { V0 } from "./track";

const clampN = (x: number, lo: number, hi: number): number => Math.min(Math.max(x, lo), hi);

/** view-state: a single affine over the chart's axis `u` (distance or time, per
 *  `Track.domain`). `pan` is the content pixel at the left edge (scroll-like);
 *  `pxPerU` is the horizontal scale (px per axis unit). */
export interface View {
    pan: number;
    pxPerU: number;
}

export interface Tick {
    s: number;
    px: number;
    label: string;
}

/** floor on the padding past the track end — a significant absolute lead-out (meters), so a
 *  short track always frames zoomed out a bit with real empty ruler to build into (the feel
 *  call, 2026-07-21). also the degenerate guard: an empty track's span never collapses. */
const MARGIN_M = 50;
/** zoom-in ceiling — a px-per-axis-unit cap so the scale can't blow up. */
export const MAX_PX_PER_U = 4000;
/** target spacing between labeled major ticks, in px. */
const TARGET_TICK_PX = 80;

export const uToPx = (v: View, s: number): number => s * v.pxPerU - v.pan;
export const pxToU = (v: View, px: number): number => (px + v.pan) / v.pxPerU;

/** the arclength (m) between a section's entry sample (`sectionInfo.startSample`) and a geo
 *  node's own landing sample (`Handle.sample`): the partial sum of `bakeOut.ds` (the
 *  whole-track per-edge array) over that stretch. Added to the section's span offset
 *  (`SectionSpan.offset`) it gives the node's global distance `d`, which the caller then
 *  projects onto the chart's axis (`dToU`) — a node's timeline position is DERIVED from
 *  geometry, never authored there (dragging it on this axis is the rejected inverse problem,
 *  fit-through-the-bake per gesture), so this is a pure forward sum, no inverse. A degenerate
 *  range (`sample <= startSample`, a zero-length edge in `ds`) sums to 0: the loop just
 *  doesn't advance, never throws. */
export function nodeArc(ds: Float32Array, startSample: number, sample: number): number {
    let arc = 0;
    for (let i = startSample; i < sample; i++) arc += ds[i];
    return arc;
}

/** the axis padding (meters) past the track end — the ONE definition, shared by `clampView`'s
 *  right edge, `frameAll`, `zoomAt`'s zoom floor, and `navWindow`. the floor (`MARGIN_M`)
 *  dominates up to ~417 m, so short tracks frame with a substantial lead-out; past that the
 *  proportional fraction takes over so the framed lead-out stays the same visible slice on long
 *  tracks. it's a permanent part of the addressable span (`sTotal + marginArc`), always pannable
 *  and always framed — not a min-window fallback. one-sided: the launch is s=0, so there's no
 *  lead-*in* (no negative distance on the ruler). the floor is the one DIMENSIONAL constant on
 *  this axis, so it's the caller's to supply in the active domain (`marginFloor`); everything
 *  else here reads the axis coordinate and needs no unit. */
export const marginArc = (sTotal: number, floor: number): number => Math.max(0.12 * sTotal, floor);

/** clamp a view to the track extent — a PAN clamp, not a zoom clamp. the x-axis is a
 *  document axis (the spatial address of every clip and keyframe), not an auto-fit value
 *  axis, so a content edit that shrinks the track NEVER rescales the ruler: `pxPerU` is
 *  only capped at `MAX_PX_PER_U` (no min-scale floor — zoom changes only by explicit
 *  navigation). the left edge anchors at s=0 (a ride starts at launch, so the ruler shows
 *  no negative distance — the After Effects / NLE convention) and the margin is a
 *  right-side lead-out. a shrunk track just leaves empty ruler on the right; when the
 *  track fits the view the pan range collapses to 0 → left-aligned. */
export function clampView(v: View, width: number, sTotal: number, floor: number): View {
    const m = marginArc(sTotal, floor);
    const pxPerU = Math.min(MAX_PX_PER_U, v.pxPerU);
    const panMax = Math.max(0, (sTotal + m) * pxPerU - width);
    const pan = Math.min(panMax, Math.max(0, v.pan));
    return { pan, pxPerU };
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
    floor: number,
): View {
    const sAnchor = pxToU(v, anchorPx);
    // floor at min(current, fit): a below-fit view (after a content shrink) can zoom-out
    // no further but is NEVER pushed UP to the fit — a zoom-out tick must not read as a
    // zoom-in. above fit, the floor is the fit scale. `fit` is `fitScale` — the PADDED
    // framing scale (`frameAll`'s), so a zoom-out returns to exactly the initial/`F` framing,
    // padding included (the padded span `sTotal + marginArc` stays reachable on the way out).
    const lo = Math.min(v.pxPerU, fitScale(width, sTotal, floor));
    const pxPerU = Math.min(MAX_PX_PER_U, Math.max(lo, v.pxPerU * factor));
    return clampView({ pan: sAnchor * pxPerU - anchorPx, pxPerU }, width, sTotal, floor);
}

/** the fit scale (px per axis unit) the padded framing uses: fit the whole addressable span
 *  `sTotal + marginArc` across the width. the ONE source for both the initial/`F` frame
 *  (`frameAll`) and the explicit-navigation zoom-out floor (`zoomAt`), so a zoom-out returns
 *  to exactly the framing it started at — the padding is a permanent part of the span, always
 *  framed. */
const fitScale = (width: number, sTotal: number, floor: number): number =>
    width > 0 ? width / (sTotal + marginArc(sTotal, floor)) : 1;

/** the view that frames the whole addressable span `[0, sTotal + marginArc]` (fit scale,
 *  left-anchored at s=0). the padding past the track end is always part of the span, so a
 *  short track frames its tiny content plus the same proportional lead-out — no min-window
 *  snap, the UX is consistent at every length. the one explicit-navigation path that sets
 *  zoom to fit — used for the initial frame and the F frame-content key, never a content edit
 *  (those pan only). */
export const frameAll = (width: number, sTotal: number, floor: number): View => ({
    pan: 0,
    pxPerU: Math.min(MAX_PX_PER_U, fitScale(width, sTotal, floor)),
});

/** the navigator window: the visible span [0, width] expressed as `{l, r}` fractions
 *  of the full track + lead-out (the viewport bracket over the overview). */
export function navWindow(
    v: View,
    width: number,
    sTotal: number,
    floor: number,
): { l: number; r: number } {
    const total = sTotal + marginArc(sTotal, floor);
    const frac = (s: number): number => Math.min(1, Math.max(0, s / total));
    return { l: frac(pxToU(v, 0)), r: frac(pxToU(v, width)) };
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
    floor: number,
): View {
    const lo = pxToU(v, 0);
    const hi = pxToU(v, width);
    const minSpan = width / MAX_PX_PER_U; // the zoom-in ceiling, as a meter-span floor
    if (mode === "pan")
        return clampView(
            { pan: (curS - grabS) * v.pxPerU, pxPerU: v.pxPerU },
            width,
            sTotal,
            floor,
        );
    if (mode === "l") {
        const pps = width / (hi - Math.min(curS, hi - minSpan)); // anchor the right edge
        return clampView({ pan: hi * pps - width, pxPerU: pps }, width, sTotal, floor);
    }
    const pps = width / (Math.max(curS, lo + minSpan) - lo); // anchor the left edge
    return clampView({ pan: lo * pps, pxPerU: pps }, width, sTotal, floor);
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

/** round `v` to `max` decimals, then strip trailing zeros (and a dangling dot) so a
 *  snapped value prints in its natural vocabulary form (`3.5`, `1`, `24`) while a
 *  Ctrl-freed value keeps its real precision up to the cap (`3.47`). the strip is
 *  DETERMINISTIC post-rounding, off the already-`toFixed`'d string — no epsilon window,
 *  no integer↔decimal flicker. normalizes `-0` → `0`. the force-readout formatting
 *  funnel (the g-axis gutter labels + the selected-point d/g fields); `max` is the
 *  precision cap (2 for g, 1 for s/d), never exceeded. */
export function fmt(v: number, max: number): string {
    const norm = v
        .toFixed(max)
        .replace(/(\.\d*?)0+$/, "$1")
        .replace(/\.$/, "");
    return norm === "-0" ? "0" : norm;
}

/** the auto-fit g-range for the force axis. `lo`/`hi` bound the display, `step` is
 *  the nice gridline spacing. */
export interface YFit {
    lo: number;
    hi: number;
    step: number;
}

const FIT_PAD = 0.4; // g of breathing room past the data extremes

/** fit a g-range to the data `[min, max]` (and always `base`, the 1g line). The view is anchored
 *  to `frame` — the stable resting window the caller owns (kex2d: the comfort band itself) —
 *  and only EXPANDS to include data beyond it, the way After Effects / Unity keep the curve view
 *  steady and grow only when content would clip. A bound the data pushes past rounds OUTWARD to a
 *  nice 1-2-5 step (a pin wiggle within a step leaves the axis still); a bound the data does NOT
 *  reach stays exactly at the frame, since rounding the frame itself wider would show slack the
 *  data never asked for. The caller eases toward this. */
export function yFit(min: number, max: number, base: number, frame: [number, number]): YFit {
    const lo = Math.min(frame[0], base, min - FIT_PAD);
    const hi = Math.max(frame[1], base, max + FIT_PAD);
    const step = niceStep((hi - lo) / 5);
    return {
        lo: lo < frame[0] ? Math.floor(lo / step) * step : frame[0],
        hi: hi > frame[1] ? Math.ceil(hi / step) * step : frame[1],
        step,
    };
}

/** one frame of the displayed g-range's approach to its fit `target` — asymmetric by direction:
 *  `grow` is the rate a bound moves OUTWARD (content needs the room now), `shrink` the rate it
 *  comes back IN. Each bound eases independently, snaps to the target within a thousandth of the
 *  span (so the approach terminates instead of asymptoting), and the gridline step is derived from
 *  the DISPLAYED span, not the target's. Returns `v` itself when nothing moved, so the caller can
 *  skip the write by identity. */
export function yEase(v: YFit, target: YFit, grow: number, shrink: number): YFit {
    const lo = v.lo + (target.lo - v.lo) * (target.lo < v.lo ? grow : shrink);
    const hi = v.hi + (target.hi - v.hi) * (target.hi > v.hi ? grow : shrink);
    const span = Math.max(1e-6, hi - lo);
    const nlo = Math.abs(lo - target.lo) < span * 1e-3 ? target.lo : lo;
    const nhi = Math.abs(hi - target.hi) < span * 1e-3 ? target.hi : hi;
    const step = niceStep((nhi - nlo) / 5);
    if (nlo === v.lo && nhi === v.hi && step === v.step) return v;
    return { lo: nlo, hi: nhi, step };
}

/** edge-scroll grow-to-follow for a value drag (the standard "scroll only when the
 *  pointer leaves the viewport" rule): grow the range ONLY when the dragged cursor `cy`
 *  is dragged BEYOND the chart — above `top` or below `bot` — by an amount proportional
 *  to how far past the edge it is (× `rate`), clamped to `cap`. The cap is what keeps the
 *  gesture usable: growth is proportional to the SPAN, so it compounds per frame and an
 *  uncapped hold runs to absurd g in well under a second. a cursor inside the chart, even
 *  resting on a keyframe at the very edge, returns the range UNCHANGED by identity (so
 *  grabbing a near-boundary keyframe never moves the axis — only dragging past it does).
 *  per-frame application keeps it growing while held beyond the edge. */
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
    if (cy < top && hi < cap[1]) hi = Math.min(cap[1], hi + (top - cy) * valPerPx * rate);
    else if (cy > bot && lo > cap[0]) lo = Math.max(cap[0], lo - (cy - bot) * valPerPx * rate);
    else return v; // within the chart, or already at the cap — unchanged (caller skips by identity)
    return { lo, hi, step: niceStep((hi - lo) / 5) };
}

/** edge-scroll pan-to-follow for a horizontal drag (the x-analogue of `yGrow`): pan
 *  the view to follow a cursor dragged PAST the chart — left of `left` or right of
 *  `right` — by an amount proportional to the overshoot (× `rate`). `pxPerU` is
 *  untouched (no zoom under the drag). a cursor inside the chart returns the view
 *  UNCHANGED by identity (so the caller skips). the left pan floors at 0 — the ruler
 *  never shows negative distance (the launch is s=0). per-frame application keeps it
 *  scrolling while the cursor is held beyond the edge. */
export function xGrow(v: View, cx: number, left: number, right: number, rate: number): View {
    if (cx > right) return { pan: v.pan + (cx - right) * rate, pxPerU: v.pxPerU };
    if (cx < left) {
        const pan = Math.max(0, v.pan - (left - cx) * rate);
        return pan === v.pan ? v : { pan, pxPerU: v.pxPerU };
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

/** the force-keyframe drag grid quanta — the authoring vocabulary a value snaps to when no
 *  landmark is in range (a force keyframe demands a value, so its axes carry a semantic
 *  quantum, unlike the landmarks-only extent/scrub axes). hand-tuned at the feel check-in;
 *  the ONE home for each, so a tweak is a one-line edit. `S_GRID` = arclength (metres),
 *  `G_GRID` = force (g). */
export const S_GRID = 1;
export const G_GRID = 0.1;

/** `S_GRID`'s time twin — the placement quantum a keyframe drag snaps to on the
 *  chart's u-axis while the track reads in `Domain.Time`, in seconds. Derived, not
 *  tuned: the time a cart at the default entry speed `V0` (10 m/s) takes to cover one
 *  `S_GRID` metre, so both domains offer the same authoring resolution at the default
 *  speed. Fixed like its twins — timeline grids are constants, only the manipulator
 *  quanta are per-user (`settings.ts`). */
export const T_GRID = S_GRID / V0;

/** the resolved snap for one axis of a keyframe drag: the DOMAIN value to write, plus the
 *  guide px to flash (a landmark hit) or `null` (the grid — ambient, no flash). */
export interface AxisSnap {
    value: number;
    guide: number | null;
}

/** resolve one axis of a force-keyframe drag: a landmark magnet layered over a domain grid
 *  (the viewport geo-grid precedent applied to the timeline). Two landmark kinds with distinct
 *  reach under the bypass. The per-axis **gesture-start** landmark (`startPx`) is a
 *  direction-intent affordance, not a snap target: it magnetizes in EVERY mode, so a Ctrl/Cmd
 *  bypass frees values without ever losing the axis pin (plain drag = grid + landmarks + axis
 *  magnet; Ctrl drag = continuous values + axis magnet; there is deliberately no fully-free
 *  mode). The **value** landmarks (`targets` — other keyframes, section boundaries, the
 *  playhead, the 1g baseline) and the `grid` quantum are the value set the bypass zeroes.
 *  A landmark within `threshold` screen-px of `rawPx` wins (landmarks own their radius, the
 *  Figma snap-to-object-else-grid order); in the active mode the start landmark competes with
 *  the value landmarks over the grid, in bypass it's the only magnet. Only a landmark draws a
 *  guide — the axis magnet is a landmark, so it keeps its flash; the grid stays ambient.
 *  `fromPx` inverts the view affine for the landmark's px → domain conversion (impure view
 *  state, so it's passed in rather than closed over). */
export function snapAxis(
    active: boolean,
    rawPx: number,
    rawVal: number,
    targets: Iterable<number>,
    grid: number,
    fromPx: (px: number) => number,
    startPx: number | null,
    threshold = SNAP_PX,
): AxisSnap {
    const pool = active ? Array.from(targets) : [];
    if (startPx !== null) pool.push(startPx); // the axis magnet survives the bypass
    const hit = snap(rawPx, pool, threshold);
    if (hit !== null) return { value: fromPx(hit), guide: hit };
    return active
        ? { value: Math.round(rawVal / grid) * grid, guide: null }
        : { value: rawVal, guide: null };
}

/** the rigid group clamp for a multi-keyframe s-drag/nudge (AE comp-start: the block stops as one).
 *  given each selected member's section-local `s` and extent `len`, clamp a desired shared Δs so
 *  EVERY in-extent member stays within its own `[0, len]` — the tightest member bounds the group, so
 *  the relative offsets are preserved exactly. the binding interval intersects `[−s, len − s]` over
 *  members with `0 ≤ s ≤ len` ONLY; an out-of-extent member (`s > len`, reachable by shortening a
 *  section under a keyframe — `setSectionLength` leaves the point's s) has an empty own-interval, so
 *  it would drag the whole block leftward — it's excluded from the binding set and instead rides the
 *  shared Δs under its own outer `clamp(s + Δs, 0, len)` (what a single-select drag of that orphan
 *  already does). the binding interval always contains 0, so the start is never clamped away; when
 *  EVERY member is out of extent the set is empty and Δs passes through unclamped (the per-member
 *  outer clamp still bounds each write). a single in-extent member degenerates to today's
 *  `clamp(s + Δs, 0, len)`. @example clampDelta([{ s: 5, len: 10 }, { s: 1, len: 2 }], 3) // → 1 */
export function clampDelta(
    members: readonly { s: number; len: number; lo?: number }[],
    ds: number,
): number {
    let lo = -Infinity;
    let hi = Infinity;
    for (const m of members) {
        const mLo = m.lo ?? 0; // default lower bound is 0 (force keyframes); strip keyframes pass `start`
        if (m.s > m.len) continue; // out of extent: excluded from the binding set (rides the outer clamp)
        if (mLo - m.s > lo) lo = mLo - m.s; // Δs ≥ lo − s keeps the member ≥ lo
        if (m.len - m.s < hi) hi = m.len - m.s; // Δs ≤ len − s keeps it ≤ len
    }
    const r = Math.min(Math.max(ds, lo), hi); // empty binding set → lo/hi stay ∓∞, Δs unclamped
    return r === 0 ? 0 : r; // normalize −0 (from a member pinned at s = lo) so `=== 0` holds downstream
}

/** the per-member `(s, g)` writes for one arrow-nudge of the selected force set (Timeline.svelte's
 *  keyboard handler). two regimes: a SINGLE selection rounds the ABSOLUTE result to the field grid
 *  (s → 0.1, g → 0.01), re-quantizing an off-grid point onto the grid — the pre-multiselect nudge
 *  semantics, preserved byte-for-byte. a MULTI set moves by ONE shared delta: the nudge step is
 *  already grid-sized, so the rigid clamp is applied LAST (the hard `[0, len]` invariant wins with no
 *  post-clamp rounding — a rounded Δs could exceed the clamp bound and break the offsets), and every
 *  relative offset is preserved exactly. @example nudgeKeyframes([{ id: 1, s: 1.007, v: 2, len: 10 }], 0, 0.05) */
export function nudgeKeyframes(
    members: readonly { id: number; s: number; v: number; len: number; lo?: number }[],
    ds: number,
    dv: number,
): { id: number; s: number; v: number }[] {
    if (members.length === 1) {
        const p = members[0];
        const lo = p.lo ?? 0;
        return [
            {
                id: p.id,
                s: Math.round(clampN(p.s + ds, lo, p.len) * 10) / 10,
                v: Math.round((p.v + dv) * 100) / 100,
            },
        ];
    }
    const d = clampDelta(members, ds); // the rigid group clamp — LAST, no rounding after it
    return members.map((m) => {
        const lo = m.lo ?? 0;
        return { id: m.id, s: clampN(m.s + d, lo, m.len), v: m.v + dv };
    });
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
    for (const s of ownS) out.push(uToPx(v, s));
    if (playheadS !== null) out.push(uToPx(v, playheadS));
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

/** track time (s) → arclength (m) along the current bake. a run of equal-arc samples
 *  (the stalled/v-floor degenerate case) resolves to the LAST tied index — `interpMono`'s
 *  `span <= 0` branch — safe because a stall freezes both tables in lockstep, so every
 *  tied index carries the same time. */
export const timeToArc = (m: Mapping, time: number): number => interpMono(m.t, m.arc, m.n, time);

/** arclength (m) → track time (s) along the current bake. same tie handling, mirrored. */
export const arcToTime = (m: Mapping, s: number): number => interpMono(m.arc, m.t, m.n, s);

/** project global distance `d` (m, the arclength axis) to the chart's coordinate `u` under the
 *  track's `Domain`. identity in `Distance` (the chart IS the distance axis); the live bake's
 *  arc→time table in `Time`. No live bake (`mapping === null`) falls back to distance regardless
 *  of the domain — the seam's one branch beyond the constant picks (`S_GRID`/`T_GRID`, the
 *  readout suffix), per the Locked decision. A non-null mapping is `n >= 2` by construction —
 *  `cart.trackMapping` is the only producer and returns null below that floor.
 *
 *  This is the **projected** side of the chart's axis, for anything whose value is an arclength:
 *  the recovered force curve, a geo node tick, the cart's parked arclength. The force store is in
 *  the chart's own unit, so it never comes through here — `track.toGlobal` is its affine. */
export function dToU(mapping: Mapping | null, domain: Domain, d: number): number {
    return domain === Domain.Time && mapping ? arcToTime(mapping, d) : d;
}

/** invert `dToU`: the chart's coordinate `u` back to global distance `d`. same no-bake
 *  fallback. */
export function uToD(mapping: Mapping | null, domain: Domain, u: number): number {
    return domain === Domain.Time && mapping ? timeToArc(mapping, u) : u;
}

/** `uToD`'s twin for the extent trim: past the bake's own end in Time domain, arclength keeps
 *  advancing at the bake's own EXIT speed (`vExit`) instead of clamping to the last finite
 *  sample. Lengthening a section's authored extent past what the live profile currently bakes
 *  is a legitimate author intent (the Locked decision's own lens, S6) — the addressable span's
 *  lead-out margin sits right there for exactly this — so the trim EXTRAPOLATES
 *  (`s_end + v_exit·Δt`) where every other Time-view reader stays clamped to the last finite t
 *  (`uToD`, the stall styling's own clamp — `dToU`/`uToD`'s docblock). Within the bake's own
 *  covered range this is `uToD` exactly; the divergence only starts past `mapping.t[n-1]`.
 *  Identity in Distance and with no live bake, matching `uToD`'s own fallbacks. `vExit` is the
 *  caller's to floor — Timeline.svelte floors it at `V_FLOOR`, the same guard `computeTime`
 *  marches under, so a near-zero exit speed extrapolates finite-but-slow rather than dividing
 *  the drag's own Δt by zero. */
export function uToDExtend(
    mapping: Mapping | null,
    domain: Domain,
    u: number,
    vExit: number,
): number {
    if (domain !== Domain.Time || !mapping) return uToD(mapping, domain, u);
    const tEnd = mapping.t[mapping.n - 1];
    if (u <= tEnd) return uToD(mapping, domain, u);
    return mapping.arc[mapping.n - 1] + vExit * (u - tEnd);
}

/** `uToDExtend`'s inverse: global distance `d` → the chart's coordinate `u`, extrapolating past
 *  the bake's own end exactly where `uToDExtend` does (finding 9, kex2d-event-lane S1). The
 *  clip strip drew its right edge through plain `dToU` even while a lengthen gesture's WRITE went
 *  through `uToDExtend` — so once the gesture's frozen `mapping` (`gestureMapping`) can't realize
 *  the growing authored extent, `dToU`'s own clamp (`interpMono`'s `v >= xs[n-1]` branch) pins the
 *  drawn edge at the frozen table's last sample while `Section.length` keeps advancing underneath
 *  it: the store moves, the pixel doesn't. The two are the same affine (`d = arc[n-1] + vExit·(u −
 *  t[n-1])`) read in opposite directions, so a single extrapolating pair keeps them agreeing for
 *  the gesture's own duration — outside a gesture (no `mapping` growth in flight) this coincides
 *  with `dToU` exactly, since `d` never exceeds the live bake's own arc range. Landed law: a
 *  reader watching an in-flight extend past the bake's end reads through the SAME extrapolating
 *  projection its writer used, never the plain clamped one — `dToU`/`uToD` stay correct for every
 *  other (non-extending) subject on the chart. @example dToUExtend(m, Domain.Time, uToDExtend(m,
 *  Domain.Time, 20, 4), 4) === 20 */
export function dToUExtend(
    mapping: Mapping | null,
    domain: Domain,
    d: number,
    vExit: number,
): number {
    if (domain !== Domain.Time || !mapping) return dToU(mapping, domain, d);
    const arcEnd = mapping.arc[mapping.n - 1];
    if (d <= arcEnd) return dToU(mapping, domain, d);
    return mapping.t[mapping.n - 1] + (d - arcEnd) / vExit;
}

/** the lead-out floor (`marginArc`'s one dimensional constant) on the active chart axis:
 *  `MARGIN_M` metres, or its time twin at the default entry speed (`MARGIN_M / V0`, `T_GRID`'s
 *  derivation), so a short ride frames the same substantial lead-out to build into either way. */
export const marginFloor = (domain: Domain): number =>
    domain === Domain.Time ? MARGIN_M / V0 : MARGIN_M;

/** bounds the Time-lens addressable span at a stall (kex2d-event-lane S2, finding 13): the bake's
 *  velocity is FLOORED (`V_FLOOR`, `forward.ts`), never zeroed, so past the first infeasible
 *  sample the s↔t table keeps advancing at a finite but crawling rate — a long infeasible tail
 *  makes `uTotal` (the plain `uOf(sTotal)` reading) balloon toward an effectively unbounded
 *  time, stretching the ruler toward t→∞ exactly where the person's read named it. Clamps to the
 *  stall's own time (`stallU`, the first-infeasible sample's `t` — already the cart's own
 *  `loopTime`, `cart.ts`) plus a margin. The margin is NOT a new tuned constant: it's the SAME
 *  lead-out floor every other axis already frames with (`marginFloor`, read in the active
 *  domain), so a stalled Time view keeps exactly the lead-out a feasible one would have shown
 *  past its own end — one constant, reused, never invented. Distance domain and a fully feasible
 *  bake (`stallU === null`) pass `uTotal` through unclamped — there's nothing to bound. */
export function stallClampU(
    uTotal: number,
    domain: Domain,
    stallU: number | null,
    margin: number,
): number {
    if (domain !== Domain.Time || stallU === null) return uTotal;
    return Math.min(uTotal, stallU + margin);
}

function fmtTime(t: number, step: number): string {
    const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
    return `${t.toFixed(decimals)}s`;
}

/** the labeled major ticks visible in [0, width], on the 1-2-5 grid. `v`'s axis is
 *  whatever `domain` the caller reads the chart in (the u-axis) — ticks never re-derives
 *  the projection, it only picks the unit suffix (the readout-suffix branch the Locked
 *  decision sanctions). */
export function ticks(v: View, width: number, domain: Domain = Domain.Distance): Tick[] {
    if (!(v.pxPerU > 0) || width <= 0) return [];
    const step = niceStep(TARGET_TICK_PX / v.pxPerU);
    const from = pxToU(v, 0);
    const to = pxToU(v, width);
    const fmt = domain === Domain.Time ? fmtTime : fmtDist;
    const out: Tick[] = [];
    for (let s = Math.floor(from / step) * step; s <= to + step * 0.5; s += step) {
        const sv = Math.abs(s) < step * 1e-6 ? 0 : s; // snap fp drift to a clean 0
        out.push({ s: sv, px: uToPx(v, sv), label: fmt(sv, step) });
    }
    return out;
}
