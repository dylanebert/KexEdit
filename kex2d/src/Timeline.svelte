<script lang="ts">
import type { State } from "@dylanebert/shallot";
import { onMount, untrack } from "svelte";
import { cartState, forceCurve, trackMapping } from "./cart";
import { editor, select, selectForce } from "./editor";
import {
    beginForceMove,
    cancel,
    commit,
    convertTrack,
    createForce,
    deleteForce,
    history,
    redo,
    undo,
} from "./history";
import {
    arcToTime,
    clampView,
    frameAll,
    type Mapping,
    marginArc,
    navDragView,
    navWindow,
    niceStep,
    pxToS,
    sToPx,
    ticks,
    timeToArc,
    type View,
    yFit,
    type YFit,
    yGrow,
    zoomAt,
} from "./timeline";
import { sampleForce } from "./profile";
import { bakeOut, type ForceRow, forcePoints, setForcePoint, Track, TrackKind } from "./track";
import { resize } from "./view";

const { ecs, eid, tick }: { ecs: State; eid: number | null; tick: number } = $props();

// the timeline shows the baked F_n force curve the realized track produces, plus
// scrub + zoom/pan navigation. in FORCE mode it's also the authoring surface: force
// points are placed, dragged, and deleted on the curve (kex/specs/kex2d-sections.md
// §6), and the chart keeps displaying the geometry-recovered curve (§2). in GEO mode
// it stays a read-only curve + player (the track is authored in the viewport).

// timeline bands, top → bottom: a scrubbable RULER (ticks + labels + playhead
// handle, the dedicated scrub zone), a demarcating GAP the playhead passes through,
// then the curve chart. The After Effects / animation-timeline / kexedit-main layout
// (time ruler on top, click-anywhere-to-scrub), not a plot with a bottom axis.
const RULER_H = 26; // top scrub band: ticks, labels, playhead handle
const GAP_H = 20; // marker lane between ruler and chart — a full row (event markers later)
const TOP = RULER_H + GAP_H; // chart top
const BOT_PAD = 8; // chart inset, bottom
const LEFT_GUT = 44; // left gutter: the g-axis labels live here; the chart insets past it
const LABEL_HALF = 5; // px; half a g-label's height — hide a label nearer than this to the plot edge
// reference comfort limits (g) — drawn as faint lines to read the force curve against.
const BAND: [number, number] = [-2, 6];
// the initial y-frame before real data arrives: the reference band + 1g headroom.
const Y_HEADROOM = 1;
const CAP_LO = BAND[0] - Y_HEADROOM;
const CAP_HI = BAND[1] + Y_HEADROOM;
const Y_BASE = 1; // gravity baseline (1g)
const ZOOM_DIV = 200; // wheel-delta → geometric zoom rate
const FMARKER_R = 5; // px; the force-point diamond's half-diagonal
const TIP_HALF = 52; // px; half the point popover's width — clamps it inside the chart
const TIP_FLIP = 64; // px; a point nearer than this to the chart top flips the popover below

let host: HTMLDivElement;
let canvas: HTMLCanvasElement;
let navCanvas: HTMLCanvasElement | undefined = $state();
let w = $state(0);
let h = $state(0);
// the user's view intent; `clamped` re-fits it to the live width/track length, so a
// resize or a track edit never writes back into `view` (which would loop the effect).
let view: View = $state({ pan: 0, pxPerM: 10 });
let framed = false;

const clamp = (x: number, lo: number, hi: number): number => Math.min(Math.max(x, lo), hi);

// the baked F_n force curve as per-sample (arclength, force) points — the chart data
// and the source of the distance domain. no time resample: the x-axis is distance (§4).
const curve = $derived.by((): { s: Float64Array; f: Float32Array; n: number } | null => {
    void tick;
    return eid === null ? null : forceCurve(eid);
});
// total track arclength (m) — the chart's X-axis domain.
const sTotal = $derived(curve ? curve.s[curve.n - 1] : 0);
// total track seconds — the *player* transport's domain (the media player stays in
// time; only the chart is distance, §4).
const tTotal = $derived.by((): number => {
    void tick;
    if (eid === null) return 0;
    return bakeOut.get(eid)?.tTotal ?? 0;
});
// the chart insets past the left g-gutter; the distance affine lives in [LEFT_GUT, w],
// so every timeline.ts call takes `chartW` and screen-X adds/subtracts LEFT_GUT.
const chartW = $derived(Math.max(0, w - LEFT_GUT));
const clamped = $derived(clampView(view, chartW, sTotal));
const tickList = $derived(ticks(clamped, chartW));

// the cart↔chart projection: the cart rides in time, the chart is distance (§4).
const mapping = $derived.by((): Mapping | null => {
    void tick;
    return eid === null ? null : trackMapping(eid);
});
// the cart's time on the baked track's clock (the player transport's readout).
const cartSec = $derived.by((): number | null => {
    void tick;
    if (eid === null) return null;
    return cartState.get(eid)?.t ?? null;
});
// the cart's arclength — its `t` projected onto the chart's distance axis.
const cartS = $derived.by((): number | null => {
    if (cartSec === null || mapping === null) return null;
    return timeToArc(mapping, cartSec);
});
const playPx = $derived.by((): number | null => {
    if (cartS === null) return null;
    const x = LEFT_GUT + sToPx(clamped, cartS);
    return x < LEFT_GUT || x > w ? null : x;
});
const paused = $derived.by((): boolean => {
    void tick;
    return eid === null ? false : (cartState.get(eid)?.held ?? false);
});
// the player slider's fill — the cart's global fraction of the whole track. distinct
// from the timeline playhead (`playPx`), which is local to the zoomed view.
const frac = $derived.by((): number => {
    if (cartSec === null || tTotal <= 0) return 0;
    return clamp(cartSec / tTotal, 0, 1);
});

// the auto-fit g-range *target*: scans the baked force curve. always keeps 1g;
// `yView` (below) eases toward this — the target itself is never drawn.
const yTarget = $derived.by((): YFit => {
    void tick;
    let lo = Y_BASE;
    let hi = Y_BASE;
    const c = curve;
    if (c) {
        for (let i = 0; i < c.n; i++) {
            if (c.f[i] < lo) lo = c.f[i];
            if (c.f[i] > hi) hi = c.f[i];
        }
    }
    return yFit(lo, hi, Y_BASE);
});

// the *displayed* g-range. `yTarget` is a stable default frame that only expands to
// fit data (it never hugs tight), and `yView` approaches it ASYMMETRICALLY: it grows
// fast and contracts lazily — the AE/Unity "grow when content needs it, never snap
// back" feel, smoothed for the web.
let yView: YFit = $state({ lo: CAP_LO, hi: CAP_HI, step: 1 });
let yInit = false;
const Y_OUT = 0.3; // per-frame approach when EXPANDING the view (snappy)
const Y_IN = 0.05; // per-frame approach when CONTRACTING (lazy — no snap-back)
const EDGE_RATE = 0.2; // edge-scroll speed (∝ px past the edge); a by-eye feel constant
$effect(() => {
    void tick; // the ONLY dependency: one run per animation frame
    // untracked: the body reads + writes yView, so a tracked read would make the
    // effect depend on its own write and loop. tick alone paces it.
    untrack(() => {
        const t = yTarget;
        const cur = yView;
        if (!yInit) {
            yView = t; // first valid range appears instantly, no ease-in from the seed
            yInit = true;
            return;
        }
        if (dragForce !== null) {
            // drag mode: the axis HOLDS during a keyframe drag — the live re-bake
            // must never re-fit the view under the held cursor — until the cursor
            // is dragged PAST the chart edge, where yGrow edge-scrolls to follow
            // (speed ∝ overshoot, per frame — the standard drag auto-scroll rule).
            // auto-fit resumes on release and eases to the new curve's range.
            const grown = yGrow(cur, dragCy, TOP, h - BOT_PAD, EDGE_RATE, [CAP_LO, CAP_HI]);
            if (grown !== cur) {
                yView = grown;
                applyDrag(); // re-map the held cursor through the grown axis → the point follows
            }
            return;
        }
        // grow toward an out-of-view bound fast; ooze back from an over-wide one slow.
        const lo = cur.lo + (t.lo - cur.lo) * (t.lo < cur.lo ? Y_OUT : Y_IN);
        const hi = cur.hi + (t.hi - cur.hi) * (t.hi > cur.hi ? Y_OUT : Y_IN);
        const span = Math.max(1e-6, hi - lo);
        const nlo = Math.abs(lo - t.lo) < span * 1e-3 ? t.lo : lo; // snap when within ε
        const nhi = Math.abs(hi - t.hi) < span * 1e-3 ? t.hi : hi;
        const step = niceStep((nhi - nlo) / 5); // step from the displayed span, not the target
        if (nlo !== cur.lo || nhi !== cur.hi || step !== cur.step)
            yView = { lo: nlo, hi: nhi, step };
    });
});

const yOf = (val: number): number =>
    TOP + (1 - (val - yView.lo) / (yView.hi - yView.lo)) * (h - BOT_PAD - TOP);
// the inverse of yOf — a chart-local pixel y back to a g value, for placing/dragging
// force points against the displayed axis.
const yToG = (py: number): number => {
    const inner = Math.max(1, h - BOT_PAD - TOP);
    return yView.lo + (1 - (py - TOP) / inner) * (yView.hi - yView.lo);
};

// ── force authoring (force mode only): points on the curve, the keyframe idiom ──
// filled diamonds at (s, g), authored INPUT (not optimization targets), so no
// drop-line and no driving/driven (§6). double-click places, drag moves both axes,
// Del removes, the point popover fields type s/g. all edits route through `history`.
const kind = $derived.by((): TrackKind => {
    void tick;
    return eid === null ? TrackKind.Geo : (Track.kind.get(eid) as TrackKind);
});
const isForce = $derived(kind === TrackKind.Force);
const points = $derived.by((): ForceRow[] => {
    void tick;
    return eid === null || !isForce ? [] : forcePoints(ecs);
});
// the selected point's id (read through the per-RAF tick; editor is plain state).
const selForce = $derived.by((): number | null => {
    void tick;
    return editor.force;
});
const selPoint = $derived.by((): ForceRow | null => {
    if (selForce === null) return null;
    return points.find((p) => p.id === selForce) ?? null;
});
const markerX = (s: number): number => LEFT_GUT + sToPx(clamped, s);

// chart-local pointer coords (px from the canvas top-left, past the g-gutter for x).
function chartS(e: MouseEvent): number {
    const rect = canvas.getBoundingClientRect();
    return clamp(pxToS(clamped, e.clientX - rect.left - LEFT_GUT), 0, sTotal);
}

// double-click the empty chart drops a force point at that s, ON the authored
// profile (g = the profile's value there — the DAW/AE envelope-insertion identity:
// a new point never bends the curve, and drags from a known start).
function chartCreate(e: MouseEvent): void {
    if (eid === null || !isForce) return;
    const s = chartS(e);
    selectForce(createForce(history, ecs, s, sampleForce(points, s)));
}

// drag a diamond in both axes (horizontal = s, vertical = g), one undo entry. the
// last cursor position is kept in canvas space so the per-frame edge-grow (the
// yView effect's drag branch) can re-map it through a grown axis. shift constrains
// to the dominant axis (the AE/Photoshop rule), measured from the grab.
let dragForce: number | null = $state(null);
let grabDs = 0; // point s − cursor s, so grabbing off-center doesn't snap
let dragCx = 0; // last cursor, canvas-local px
let dragCy = 0;
let dragShift = false;
let dragX0 = 0; // grab cursor + grab values — the shift-constrain anchor
let dragY0 = 0;
let dragS0 = 0;
let dragG0 = 0;
function applyDrag(): void {
    if (dragForce === null) return;
    // both axes clamp the cursor to the chart: the view never moves under a drag,
    // so past an edge the point rides it (y follows only as the edge-grow expands).
    const cx = clamp(dragCx, LEFT_GUT, Math.max(LEFT_GUT, w));
    let s = clamp(pxToS(clamped, cx - LEFT_GUT) + grabDs, 0, sTotal);
    let g = yToG(clamp(dragCy, TOP, h - BOT_PAD));
    if (dragShift) {
        // lock to whichever axis has moved further since the grab; the other holds
        if (Math.abs(dragCx - dragX0) >= Math.abs(dragCy - dragY0)) g = dragG0;
        else s = dragS0;
    }
    setForcePoint(ecs, dragForce, s, g);
}
function forceDown(e: PointerEvent, p: ForceRow): void {
    e.preventDefault();
    e.stopPropagation(); // don't also deselect via the chartzone below
    const rect = canvas.getBoundingClientRect();
    dragCx = e.clientX - rect.left;
    dragCy = e.clientY - rect.top;
    dragShift = e.shiftKey;
    dragX0 = dragCx;
    dragY0 = dragCy;
    dragS0 = p.s;
    dragG0 = p.g;
    grabDs = p.s - chartS(e);
    beginForceMove(ecs, p.id);
    dragForce = p.id;
    selectForce(p.id);
    window.addEventListener("pointermove", forceMove);
    window.addEventListener("pointerup", forceUp);
}
function forceMove(e: PointerEvent): void {
    if (dragForce === null) return;
    const rect = canvas.getBoundingClientRect();
    dragCx = e.clientX - rect.left;
    dragCy = e.clientY - rect.top;
    dragShift = e.shiftKey; // live: shift can be pressed/released mid-drag
    applyDrag();
}
function forceUp(): void {
    if (dragForce === null) return;
    dragForce = null;
    commit(history); // one drag → one entry; a no-move click drops via the `same` guard
    window.removeEventListener("pointermove", forceMove);
    window.removeEventListener("pointerup", forceUp);
}

// ── the mode toggle + the selected point's typed s/g fields ──
// the mode toggle is a destructive, undoable convert (§5): clicking the inactive
// side resets the track to that kind's default. clearing both selections first
// keeps a stale id out of the post-convert view.
function toggleKind(): void {
    if (eid === null) return;
    selectForce(null);
    select(null);
    convertTrack(history, ecs, eid);
}
// each field commits one undo entry through the drag gesture (begin → set → commit).
function fieldEdit(s: number, g: number): void {
    const id = selForce;
    if (id === null || !Number.isFinite(s) || !Number.isFinite(g)) return; // guard a cleared field
    beginForceMove(ecs, id);
    setForcePoint(ecs, id, Math.max(0, s), g);
    commit(history);
}
function onFieldS(e: Event): void {
    if (!selPoint) return;
    fieldEdit(Number.parseFloat((e.currentTarget as HTMLInputElement).value), selPoint.g);
}
function onFieldG(e: Event): void {
    if (!selPoint) return;
    fieldEdit(selPoint.s, Number.parseFloat((e.currentTarget as HTMLInputElement).value));
}
// label scrub (the shallot inspector idiom): pointer-capture the key label and slide
// horizontally to revise its value — one history gesture per scrub, rounded to the
// field's displayed precision so the number never shows scrub jitter.
const SCRUB_S = 0.05; // m per px
const SCRUB_G = 0.01; // g per px
// while a label scrubs, the popover's anchor FREEZES at its gesture-start position —
// a surface never moves under its own gesture (the point moves, the control stays
// put; it re-anchors to the point on release). also holds the popover visible if
// the scrub carries the diamond out of view.
let scrubFreeze: { x: number; y: number } | null = $state(null);
function scrubStart(e: PointerEvent, axis: "s" | "g"): void {
    const p = selPoint;
    if (p === null) return;
    e.preventDefault();
    const label = e.currentTarget as HTMLElement;
    label.setPointerCapture(e.pointerId);
    scrubFreeze = {
        x: clamp(markerX(p.s), LEFT_GUT + TIP_HALF, Math.max(LEFT_GUT + TIP_HALF, w - TIP_HALF)),
        y: clamp(yOf(p.g), TOP, h - BOT_PAD),
    };
    beginForceMove(ecs, p.id);
    let acc = axis === "s" ? p.s : p.g;
    const move = (ev: PointerEvent): void => {
        if (axis === "s") {
            acc = clamp(acc + ev.movementX * SCRUB_S, 0, sTotal);
            setForcePoint(ecs, p.id, Math.round(acc * 10) / 10, p.g);
        } else {
            acc += ev.movementX * SCRUB_G;
            setForcePoint(ecs, p.id, p.s, Math.round(acc * 100) / 100);
        }
    };
    const up = (): void => {
        label.removeEventListener("pointermove", move);
        label.removeEventListener("pointerup", up);
        label.removeEventListener("pointercancel", up);
        scrubFreeze = null; // re-anchor to the point
        commit(history);
    };
    label.addEventListener("pointermove", move);
    label.addEventListener("pointerup", up);
    // a cancelled pointer must still close the gesture — a left-open one would
    // swallow the next edit (one gesture at a time).
    label.addEventListener("pointercancel", up);
}
// field keys: Enter commits (blur fires change); Escape reverts the edit and blurs
// without committing (the standard numeric-field escape). the window handler skips
// inputs, so the NEXT Escape deselects the keyframe — layered dismissal.
function fieldKeydown(e: KeyboardEvent, reset: string): void {
    const input = e.currentTarget as HTMLInputElement;
    if (e.key === "Enter") input.blur();
    else if (e.key === "Escape") {
        input.value = reset;
        input.blur();
    }
}
function deleteSelectedForce(): void {
    if (editor.force === null) return;
    deleteForce(history, ecs, editor.force);
    selectForce(null);
}
function cancelForceDrag(): void {
    if (dragForce === null) return;
    dragForce = null;
    cancel(); // interrupted (unmount mid-drag): revert to the pre-gesture s/g
    window.removeEventListener("pointermove", forceMove);
    window.removeEventListener("pointerup", forceUp);
}

// ── middle-button drag pans the view. intercepted at the host's capture phase so it
// fires before the pointer-events:all SVG rects; the ruler handler also routes a
// middle press here as a backstop.
let panning = false;
let panX0 = 0;
let pan0 = 0;
function panDown(e: PointerEvent): void {
    if (eid === null) return;
    e.preventDefault();
    panning = true;
    panX0 = e.clientX;
    pan0 = clamped.pan;
    window.addEventListener("pointermove", panMove);
    window.addEventListener("pointerup", panUp);
}
function panMove(e: PointerEvent): void {
    if (!panning) return; // drag content right → reveal earlier distance → pan decreases
    view = clampView({ pan: pan0 - (e.clientX - panX0), pxPerM: clamped.pxPerM }, chartW, sTotal);
}
function panUp(): void {
    panning = false;
    window.removeEventListener("pointermove", panMove);
    window.removeEventListener("pointerup", panUp);
}

// ── distance navigator: a full-track overview below the chart, drawn as a preview
// minimap (see renderNav). a window-bracket marks the portion the chart shows; drag the
// body to pan, drag an edge to zoom (the opposite edge anchored). the bar spans
// [0, sTotal + lead-out], so framing the whole track fills it.
let navEl: HTMLDivElement | undefined = $state();
const navWin = $derived(
    eid === null || sTotal <= 0 || chartW <= 0 ? null : navWindow(clamped, chartW, sTotal),
);
let navDrag: { mode: "pan" | "l" | "r"; grab: number } | null = null;
function navSAt(clientX: number): number {
    const rect = navEl!.getBoundingClientRect();
    const total = sTotal + marginArc(sTotal);
    return clamp(((clientX - rect.left) / Math.max(1, rect.width)) * total, 0, total);
}
function navDown(e: PointerEvent, mode: "pan" | "l" | "r"): void {
    if (eid === null || sTotal <= 0) return;
    e.preventDefault();
    e.stopPropagation(); // an edge press must not also start a window pan
    navDrag = { mode, grab: navSAt(e.clientX) - pxToS(clamped, 0) };
    window.addEventListener("pointermove", navMove);
    window.addEventListener("pointerup", navUp);
}
function navMove(e: PointerEvent): void {
    if (!navDrag) return;
    view = navDragView(clamped, chartW, sTotal, navDrag.mode, navSAt(e.clientX), navDrag.grab);
}
function navUp(): void {
    navDrag = null;
    window.removeEventListener("pointermove", navMove);
    window.removeEventListener("pointerup", navUp);
}

function render(ctx: CanvasRenderingContext2D): void {
    const v = clamped;
    ctx.clearRect(0, 0, w, h);
    ctx.font = "9px 'JetBrains Mono', ui-monospace, monospace";

    // ruler + gap bands: a lighter scrub strip over a darker channel, demarcating the
    // scrub zone from the curve chart (a 1px seam marks the chart top).
    ctx.fillStyle = "rgba(255, 255, 255, 0.04)";
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
    ctx.fillRect(0, RULER_H, w, GAP_H);
    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, TOP + 0.5);
    ctx.lineTo(w, TOP + 0.5);
    ctx.stroke();

    for (const tk of tickList) {
        const x = LEFT_GUT + tk.px; // tick px is chart-local; the chart insets past the gutter
        if (x < LEFT_GUT - 1 || x > w + 1) continue;
        // faint gridline through the chart — read the curve against distance
        ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, TOP);
        ctx.lineTo(x, h - BOT_PAD);
        ctx.stroke();
        // tick mark + label in the ruler
        ctx.strokeStyle = "rgba(160, 152, 144, 0.5)";
        ctx.beginPath();
        ctx.moveTo(x, RULER_H - 5);
        ctx.lineTo(x, RULER_H);
        ctx.stroke();
        ctx.fillStyle = "rgba(160, 152, 144, 0.8)";
        ctx.textBaseline = "top";
        ctx.textAlign = "center";
        ctx.fillText(tk.label, x, 8);
    }

    // g gridlines + left-gutter labels, on the displayed range's nice step. labels
    // round to the step's decimals (a raw float prints 0.6000…1, which clips).
    const { lo, hi, step } = yView;
    const dec = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let g = Math.ceil(lo / step) * step; g <= hi + step * 1e-6; g += step) {
        const gv = Math.abs(g) < step * 1e-6 ? 0 : g; // snap fp drift to a clean 0
        const y = yOf(gv);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(LEFT_GUT, y);
        ctx.lineTo(w, y);
        ctx.stroke();
        // skip a label that would bleed past the plot band (the extreme top/bottom
        // gridlines) rather than cram it inward — the interior labels carry the scale.
        if (y >= TOP + LABEL_HALF && y <= h - BOT_PAD - LABEL_HALF) {
            ctx.fillStyle = "rgba(160, 152, 144, 0.7)";
            ctx.fillText(`${gv.toFixed(dec)}g`, LEFT_GUT - 6, y);
        }
    }

    // reference comfort limits — drawn only when within the visible range
    ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
    ctx.lineWidth = 1;
    for (const lim of BAND) {
        if (lim < lo || lim > hi) continue;
        ctx.beginPath();
        ctx.moveTo(LEFT_GUT, yOf(lim));
        ctx.lineTo(w, yOf(lim));
        ctx.stroke();
    }

    // 1g gravity baseline — neutral (accent is reserved for the result curve)
    ctx.strokeStyle = "rgba(205, 197, 188, 0.45)";
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(LEFT_GUT, yOf(Y_BASE));
    ctx.lineTo(w, yOf(Y_BASE));
    ctx.stroke();
    ctx.setLineDash([]);

    // clip the data series to the inner chart rect: a panned/zoomed curve must not
    // paint over the left g-gutter labels or bleed past the ruler / bottom inset.
    ctx.save();
    ctx.beginPath();
    ctx.rect(LEFT_GUT, TOP, w - LEFT_GUT, h - BOT_PAD - TOP);
    ctx.clip();

    // the baked F_n force curve — accent: the force the realized track produces,
    // drawn per-sample over its arclength (the chart's x-axis is distance).
    if (curve) {
        ctx.strokeStyle = "rgb(212, 149, 96)";
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        for (let i = 0; i < curve.n; i++) {
            const x = LEFT_GUT + sToPx(v, curve.s[i]);
            const y = yOf(curve.f[i]);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }

    ctx.restore();
}

// the navigator preview (VSCode-minimap / DAW-overview style): a faint miniature of
// the whole F_n force curve across the full track, so the viewport bracket reads
// against the curve's shape. y-range tracks the chart's `yView`; x is arclength over
// [0, sTotal + lead-out], so the curve occupies only [0, sTotal] (the margin stays empty).
function renderNav(nav: CanvasRenderingContext2D, cw: number, ch: number): void {
    nav.clearRect(0, 0, cw, ch);
    const data = curve;
    if (!data || data.n < 2 || sTotal <= 0) return;
    const total = sTotal + marginArc(sTotal); // the bar spans the track + lead-out
    const { lo, hi } = yView;
    const span = Math.max(1e-6, hi - lo);
    const pad = 2; // vertical inset so the curve doesn't touch the lane edges
    const ny = (val: number): number =>
        pad + (1 - (clamp(val, lo, hi) - lo) / span) * (ch - 2 * pad);
    nav.strokeStyle = "rgba(212, 149, 96, 0.55)"; // dim accent
    nav.lineWidth = 1;
    nav.beginPath();
    for (let i = 0; i < data.n; i++) {
        const x = (data.s[i] / total) * cw;
        const y = ny(data.f[i]);
        if (i === 0) nav.moveTo(x, y);
        else nav.lineTo(x, y);
    }
    nav.stroke();
}

$effect(() => {
    // frame the whole track once, when width + a track first exist.
    if (!framed && chartW > 0 && sTotal > 0) {
        view = frameAll(chartW, sTotal);
        framed = true;
    }
});

$effect(() => {
    // render() reads view/data/size synchronously, so the effect tracks them.
    const ctx = canvas?.getContext("2d");
    if (!ctx) return;
    resize(canvas, ctx);
    render(ctx);
    const nav = navCanvas;
    const nctx = nav?.getContext("2d");
    if (nav && nctx) {
        resize(nav, nctx);
        renderNav(nctx, nav.clientWidth, nav.clientHeight);
    }
});

// ── ruler scrub: click/drag anywhere in the top band positions the playhead. it
// freezes playback while held and *parks* on release — never auto-resumes (the After
// Effects / animation-timeline convention: scrubbing sets time, play is separate).
let scrubbing = false;
function scrubTo(e: PointerEvent): void {
    if (eid === null || !scrubbing) return;
    const m = mapping;
    if (!m) return;
    const rect = canvas.getBoundingClientRect();
    // the ruler is distance; map the picked s back to the cart's time (§4 inverse).
    const s = clamp(pxToS(clamped, e.clientX - rect.left - LEFT_GUT), 0, sTotal);
    const st = cartState.get(eid);
    if (st) st.t = clamp(arcToTime(m, s), 0, tTotal);
}
function endScrub(): void {
    scrubbing = false; // leave st.held true — parked + paused, no auto-resume
    window.removeEventListener("pointermove", scrubTo);
    window.removeEventListener("pointerup", endScrub);
}
function startScrub(e: PointerEvent): void {
    if (eid === null) return;
    if (e.button === 1) {
        panDown(e);
        return;
    }
    if (e.button !== 0) return; // left-only scrub; right suppressed by the host
    const st = cartState.get(eid);
    if (!st) return;
    e.preventDefault();
    scrubbing = true;
    st.held = true; // freeze playback while scrubbing
    scrubTo(e);
    window.addEventListener("pointermove", scrubTo);
    window.addEventListener("pointerup", endScrub);
}

function togglePlay(): void {
    if (eid === null) return;
    const st = cartState.get(eid);
    if (st) st.held = !st.held;
}

// ── player slider: the full-track scrubber. drag maps screen-X → track fraction →
// time (global, not view-relative). holding while dragging freezes the cart; release
// restores the pre-grab play state (grab while paused stays paused — the media-player
// convention).
let scrubEl: HTMLDivElement;
let sliding = false;
let sliderResume = false;
function sliderTo(e: PointerEvent): void {
    if (eid === null || !sliding) return;
    const rect = scrubEl.getBoundingClientRect();
    const f = rect.width > 0 ? clamp((e.clientX - rect.left) / rect.width, 0, 1) : 0;
    const st = cartState.get(eid);
    if (st) st.t = f * tTotal;
}
function sliderUp(): void {
    if (!sliding) return; // not dragging → nothing to restore (cleanup no-op)
    sliding = false;
    if (eid !== null) {
        const st = cartState.get(eid);
        if (st) st.held = sliderResume;
    }
    window.removeEventListener("pointermove", sliderTo);
    window.removeEventListener("pointerup", sliderUp);
}
function sliderDown(e: PointerEvent): void {
    if (eid === null || tTotal <= 0) return;
    const st = cartState.get(eid);
    if (!st) return;
    e.preventDefault();
    sliderResume = st.held; // resume playing only if it was playing before the grab
    sliding = true;
    st.held = true;
    sliderTo(e);
    window.addEventListener("pointermove", sliderTo);
    window.addEventListener("pointerup", sliderUp);
}
// arrow-step the playhead — shared by both scrub controls (the ruler and the slider).
function stepKey(e: KeyboardEvent): void {
    if (eid === null || tTotal <= 0) return;
    const st = cartState.get(eid);
    if (!st) return;
    const step = e.shiftKey ? 1 : 0.1; // seconds; shift = coarse
    const d = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
    if (d === 0) return;
    e.preventDefault();
    st.held = true; // stepping pauses, like a frame-step
    st.t = clamp((cartSec ?? 0) + d, 0, tTotal);
}
onMount(() => {
    const onWheel = (e: WheelEvent): void => {
        e.preventDefault();
        const x = e.clientX - canvas.getBoundingClientRect().left - LEFT_GUT; // chart-local anchor
        // curve-editor standard (Unity/AE): plain wheel zooms, shift+wheel pans.
        // a trackpad's horizontal axis pans too; pinch arrives as ctrl+wheel → zoom.
        const panH = e.shiftKey || (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaX) > Math.abs(e.deltaY));
        if (panH) {
            const dx = e.shiftKey ? e.deltaY : e.deltaX;
            view = clampView({ pan: clamped.pan + dx, pxPerM: clamped.pxPerM }, chartW, sTotal);
        } else {
            view = zoomAt(clamped, x, 2 ** (-e.deltaY / ZOOM_DIV), chartW, sTotal);
        }
    };
    // undo/redo drive the shared history (track-node edits); Space toggles playback.
    const onKey = (e: KeyboardEvent): void => {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        if (e.ctrlKey || e.metaKey) {
            const k = e.key.toLowerCase();
            if (k === "z") {
                e.preventDefault();
                if (e.shiftKey) redo(history);
                else undo(history);
            } else if (k === "y") {
                e.preventDefault();
                redo(history);
            }
            return;
        }
        if (e.code === "Space") {
            e.preventDefault();
            togglePlay();
            return;
        }
        // force-point select/delete — guarded on a live force selection so geo-node
        // Esc/Del (controls.ts) stay unambiguous (the selections are mode-exclusive).
        if (editor.force !== null) {
            if (e.key === "Escape") {
                e.preventDefault();
                selectForce(null);
            } else if (e.key === "Delete" || e.key === "Backspace") {
                e.preventDefault();
                deleteSelectedForce();
            }
        }
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey);
    return () => {
        host.removeEventListener("wheel", onWheel);
        window.removeEventListener("keydown", onKey);
        endScrub(); // drop any in-flight scrub listeners if we unmount mid-drag
        sliderUp(); // and any in-flight player-slider drag
        panUp(); // and any in-flight middle-drag pan
        navUp(); // and any in-flight navigator drag
        cancelForceDrag(); // and any in-flight force-point drag
    };
});
</script>

<aside class="dock">
    <div
        class="body"
        bind:this={host}
        bind:clientWidth={w}
        bind:clientHeight={h}
        onpointerdowncapture={(e) => {
            if (e.button === 1) {
                panDown(e);
                e.stopPropagation();
            }
        }}
        oncontextmenu={(e) => e.preventDefault()}
        role="presentation"
    >
        <canvas bind:this={canvas}></canvas>
        <svg class="overlay" width={w} height={h}>
            <defs>
                <!-- clip the force diamonds to the inner chart rect so a panned/off-
                     scale point doesn't paint over the ruler or the g-gutter. -->
                <clipPath id="fclip">
                    <rect
                        x={LEFT_GUT}
                        y={TOP}
                        width={Math.max(0, w - LEFT_GUT)}
                        height={Math.max(0, h - BOT_PAD - TOP)}
                    />
                </clipPath>
            </defs>
            <!-- the scrub zone: the whole ruler + gap band. click/drag anywhere here
                 moves the playhead (the distance ruler is the scrubber). -->
            {#if eid !== null && sTotal > 0}
                <rect
                    class="rulerzone"
                    x="0"
                    y="0"
                    width={w}
                    height={TOP}
                    onpointerdown={startScrub}
                    onkeydown={stepKey}
                    role="slider"
                    tabindex="0"
                    aria-label="Scrub playhead"
                    aria-valuemin={0}
                    aria-valuemax={Math.round(sTotal * 100) / 100}
                    aria-valuenow={Math.round((cartS ?? 0) * 100) / 100}
                />
            {/if}
            <!-- force mode: the chart is the authoring surface. double-click drops a
                 point at the exact (s, g) under the cursor; a bare click on empty
                 chart clears the point selection. the diamonds sit above it. -->
            {#if isForce && eid !== null && sTotal > 0}
                <rect
                    class="chartzone"
                    x={LEFT_GUT}
                    y={TOP}
                    width={Math.max(0, w - LEFT_GUT)}
                    height={Math.max(0, h - BOT_PAD - TOP)}
                    ondblclick={chartCreate}
                    onpointerdown={(e) => {
                        if (e.button !== 0) return;
                        // layered dismissal: while a popover field is focused, a chart
                        // click only commits/blurs the field (the innermost transient
                        // layer, via the browser's own focus change); the NEXT click
                        // clears the keyframe selection.
                        const ae = document.activeElement;
                        if (ae instanceof HTMLElement && ae.closest(".ptip")) return;
                        selectForce(null);
                    }}
                    role="presentation"
                />
            {/if}
            <!-- playhead: a handle in the ruler + a line down through the gap and
                 chart. visual only — the rulerzone above owns the scrub interaction. -->
            {#if playPx !== null}
                <line class="playhead" x1={playPx} x2={playPx} y1={RULER_H} y2={h - BOT_PAD} />
                <polygon
                    class="grip"
                    points="{playPx - 5},{RULER_H - 10} {playPx + 5},{RULER_H - 10} {playPx},{RULER_H}"
                />
            {/if}
            <!-- force points: a filled diamond at (s, g) — the KEYFRAME idiom (authored
                 input), not the constraint ring (§6): no drop-line, no driving/driven.
                 drag both axes; the chartzone owns creation. -->
            {#if isForce}
                <g class="fmarkers" clip-path="url(#fclip)">
                    {#each points as p (p.id)}
                        {@const mx = markerX(p.s)}
                        {#if mx >= LEFT_GUT - FMARKER_R && mx <= w + FMARKER_R}
                            {@const my = yOf(p.g)}
                            <polygon
                                class="fmarker"
                                class:sel={p.id === selForce}
                                points="{mx},{my - FMARKER_R} {mx + FMARKER_R},{my} {mx},{my + FMARKER_R} {mx - FMARKER_R},{my}"
                                onpointerdown={(e) => forceDown(e, p)}
                                role="button"
                                tabindex="-1"
                                aria-label="Force point"
                            />
                        {/if}
                    {/each}
                </g>
            {/if}
        </svg>
        <!-- the selected point's typed s/g fields: a popover summoned AT the diamond
             (on the object, not a docked row). it follows a live drag as the value
             readout, pointer-inert so it never fights the drag; flips below the point
             near the chart top; clamps inside the chart horizontally. -->
        {#if selPoint}
            {@const mx = markerX(selPoint.s)}
            {#if scrubFreeze !== null || (mx >= LEFT_GUT - FMARKER_R && mx <= w + FMARKER_R)}
                {@const ax =
                    scrubFreeze?.x ??
                    clamp(mx, LEFT_GUT + TIP_HALF, Math.max(LEFT_GUT + TIP_HALF, w - TIP_HALF))}
                {@const ay = scrubFreeze?.y ?? clamp(yOf(selPoint.g), TOP, h - BOT_PAD)}
                {@const sText = selPoint.s.toFixed(1)}
                {@const gText = selPoint.g.toFixed(2)}
                <div
                    class="ptip"
                    class:below={ay < TOP + TIP_FLIP}
                    class:dragging={dragForce !== null}
                    style="left: {ax}px; top: {ay}px"
                >
                    <div class="fld">
                        <span
                            class="key"
                            onpointerdown={(e) => scrubStart(e, "s")}
                            role="presentation">s</span
                        >
                        <input
                            type="number"
                            step="1"
                            min="0"
                            value={sText}
                            onchange={onFieldS}
                            onfocus={(e) => e.currentTarget.select()}
                            onkeydown={(e) => fieldKeydown(e, sText)}
                            aria-label="Point distance (m)"
                        />
                        <span class="unit">m</span>
                    </div>
                    <div class="fld">
                        <span
                            class="key"
                            onpointerdown={(e) => scrubStart(e, "g")}
                            role="presentation">F</span
                        >
                        <input
                            type="number"
                            step="0.1"
                            value={gText}
                            onchange={onFieldG}
                            onfocus={(e) => e.currentTarget.select()}
                            onkeydown={(e) => fieldKeydown(e, gText)}
                            aria-label="Point force (g)"
                        />
                        <span class="unit">g</span>
                    </div>
                </div>
            {/if}
        {/if}
    </div>
    <!-- the time navigator: a full-track overview below the chart (Premiere placement)
         rendered as a preview minimap (VSCode / DAW-overview style) — a miniature of the
         F_n curve with the viewport as a draggable, edge-resizable window. the inner
         track insets by LEFT_GUT so its time axis aligns with the chart above. -->
    <div class="nav" class:idle={navWin === null}>
        <div class="nav-track" bind:this={navEl} style="margin-left: {LEFT_GUT}px">
            <canvas class="nav-canvas" bind:this={navCanvas}></canvas>
            {#if navWin}
                <div
                    class="nav-window"
                    style="left: {navWin.l * 100}%; width: {(navWin.r - navWin.l) * 100}%"
                    onpointerdown={(e) => navDown(e, "pan")}
                    role="presentation"
                >
                    <div class="nav-edge l" onpointerdown={(e) => navDown(e, "l")} role="presentation"></div>
                    <div class="nav-edge r" onpointerdown={(e) => navDown(e, "r")} role="presentation"></div>
                </div>
            {/if}
        </div>
    </div>
</aside>

<!-- the track-mode toggle (a destructive, undoable geo↔force convert, §5): a
     segmented pill floated as its own small surface resting on the dock's top-right
     corner — the same satellite pattern as the player, never covering chart content.
     whole-track stage-C scaffolding (stage D makes kind per-section), so it stays a
     summoned-looking overlay, not docked chrome (gate 1). -->
{#if eid !== null}
    <div class="modebar">
        <div class="kindtoggle" role="group" aria-label="Track mode">
            <button
                type="button"
                class:active={!isForce}
                onclick={() => isForce && toggleKind()}
                title="Geometry mode"
            >
                Geo
            </button>
            <button
                type="button"
                class:active={isForce}
                onclick={() => !isForce && toggleKind()}
                title="Force mode"
            >
                Force
            </button>
        </div>
    </div>
{/if}

<!-- the player: a standard media transport (play/pause · global scrub · timecode)
     floated as its own surface below the timeline. the slider is the *full-track*
     scrubber — global scope, distinct from the timeline's zoomed-local playhead
     (the After Effects comp-vs-timeline split). controls the cart. -->
<div class="player" class:idle={eid === null || tTotal <= 0}>
    <button
        class="play"
        type="button"
        onclick={togglePlay}
        title={paused ? "Play (Space)" : "Pause (Space)"}
        aria-label={paused ? "Play" : "Pause"}
    >
        {#if paused}
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3 L13 8 L5 13 Z" fill="currentColor" /></svg>
        {:else}
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3 L5.5 13 M10.5 3 L10.5 13" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
        {/if}
    </button>
    <div
        class="scrub"
        bind:this={scrubEl}
        onpointerdown={sliderDown}
        onkeydown={stepKey}
        role="slider"
        tabindex="0"
        aria-label="Playback position"
        aria-valuemin={0}
        aria-valuemax={Math.round(tTotal * 100) / 100}
        aria-valuenow={Math.round((cartSec ?? 0) * 100) / 100}
    >
        <div class="rail"></div>
        <div class="fill" style="width: {frac * 100}%"></div>
        <div class="thumb" style="left: {frac * 100}%"></div>
    </div>
    <span class="time">
        {(cartSec ?? 0).toFixed(2)}<span class="sep">/</span><span class="total">{tTotal.toFixed(2)}s</span>
    </span>
</div>

<style>
    .dock {
        position: absolute;
        left: 50%;
        transform: translateX(-50%);
        width: calc(100% - 32px);
        max-width: 1280px;
        bottom: 16px;
        height: 240px;
        display: flex;
        flex-direction: column;
        background: var(--bg-solid);
        border: 1px solid var(--border);
        border-radius: 6px;
        box-shadow: var(--shadow);
        font-family: "Outfit", system-ui, sans-serif;
        user-select: none;
        -webkit-user-select: none;
        overflow: hidden;
    }

    /* the geo↔force mode toggle: a segmented pill (padded track, rounded active
       segment) floated as its own satellite surface on the dock's top-right corner —
       the player's elevation treatment (opaque, border + shadow), aligned to the
       dock's edge at every viewport width via the same centering box. */
    .modebar {
        position: absolute;
        left: 50%;
        transform: translateX(-50%);
        bottom: 264px; /* dock top (16 + 240) + 8 gap */
        width: calc(100% - 32px);
        max-width: 1280px;
        display: flex;
        justify-content: flex-end;
        pointer-events: none; /* the full-width alignment box must not eat clicks */
    }
    .kindtoggle {
        pointer-events: auto;
        display: inline-flex;
        gap: 2px;
        padding: 2px;
        background: var(--bg-solid);
        border: 1px solid var(--border);
        border-radius: 6px;
        box-shadow: var(--shadow);
    }
    .kindtoggle button {
        all: unset;
        box-sizing: border-box;
        padding: 3px 10px;
        border-radius: 4px;
        font-family: "Outfit", system-ui, sans-serif;
        font-size: 11px;
        color: var(--muted);
        cursor: pointer;
        transition: background 120ms ease, color 120ms ease;
    }
    .kindtoggle button:hover {
        color: var(--fg);
    }
    .kindtoggle button.active {
        background: var(--accent-soft);
        color: var(--accent);
        cursor: default;
    }

    /* the selected point's popover: one opaque floating surface anchored to the
       diamond — two field ROWS on a shared column grid (key · value · unit), not
       boxed inputs inside a box (a nested border reads as double chrome). the
       inputs are transparent; focus is a row wash (the floating-input pattern: the
       surface is the field). the key label is the scrub handle (drag to slide, the
       shallot inspector idiom). sits above the point, flips below near the chart
       top; pointer-inert while the point drags (it's the live value readout then,
       not an input surface). */
    .ptip {
        position: absolute;
        z-index: 2;
        display: flex;
        flex-direction: column;
        padding: 3px 0;
        background: var(--bg-solid);
        border: 1px solid var(--border);
        border-radius: 5px;
        box-shadow: var(--shadow);
        overflow: hidden; /* the focus wash clips to the rounded corners */
        transform: translate(-50%, calc(-100% - 12px));
        animation: tip-in 120ms ease;
    }
    .ptip.below {
        transform: translate(-50%, 12px);
    }
    .ptip.dragging {
        pointer-events: none;
    }
    @keyframes tip-in {
        from {
            opacity: 0;
        }
    }
    .fld {
        display: grid;
        grid-template-columns: 14px 48px 12px;
        align-items: center;
        gap: 6px;
        padding: 4px 9px;
        font-family: "JetBrains Mono", ui-monospace, monospace;
        font-size: 11px;
        transition: background 120ms ease;
    }
    .fld:focus-within {
        background: rgba(255, 255, 255, 0.04);
    }
    /* the key doubles as the scrub handle (the shallot cell-handle treatment): a
       full-row-height centered cell whose hit area extends to the row's edges (the
       negative-margin/padding pair), ew-resize + brighten/wash on hover. */
    .fld .key {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        align-self: stretch;
        margin: -4px 0 -4px -9px;
        padding: 4px 0 4px 9px;
        color: var(--muted);
        cursor: ew-resize;
        user-select: none;
        -webkit-user-select: none;
        touch-action: none;
        transition: color 120ms ease, background 120ms ease;
    }
    .fld .key:hover {
        color: var(--fg);
        background: rgba(255, 255, 255, 0.05);
    }
    .fld:focus-within .key {
        color: var(--fg);
    }
    .fld .unit {
        color: var(--muted);
    }
    .fld input {
        width: 42px;
        box-sizing: border-box;
        padding: 0;
        background: none;
        border: none;
        outline: none;
        color: var(--fg);
        font: inherit;
        font-variant-numeric: tabular-nums;
        text-align: right;
        appearance: textfield; /* no native spinner chrome (it truncates the value); arrow keys still step */
    }
    .fld input::-webkit-outer-spin-button,
    .fld input::-webkit-inner-spin-button {
        -webkit-appearance: none;
        margin: 0;
    }
    .fld input::selection {
        background: var(--accent-soft);
    }

    .body {
        position: relative;
        flex: 1;
        min-height: 0;
    }

    /* time navigator: a preview-minimap overview strip below the chart. dims only
       when there's no track (nothing to preview). */
    .nav {
        flex: none;
        padding: 2px 0 6px;
        transition: opacity 150ms ease;
    }
    .nav.idle {
        opacity: 0.4;
    }
    .nav-track {
        position: relative;
        height: 22px;
        background: rgba(0, 0, 0, 0.28);
        border-radius: 3px;
    }
    .nav-canvas {
        position: absolute;
        inset: 0;
        display: block;
        width: 100%;
        height: 100%;
        border-radius: 3px; /* clips the preview curve to the lane's rounded corners */
    }
    /* the viewport window: a translucent highlight over the preview (VSCode-minimap
       style), not a solid block — the curve reads through it. */
    .nav-window {
        position: absolute;
        top: 0;
        bottom: 0;
        min-width: 8px;
        background: rgba(255, 255, 255, 0.07);
        border: 1px solid rgba(255, 255, 255, 0.22);
        border-radius: 3px;
        cursor: grab;
        transition: background 120ms ease;
    }
    .nav-window:hover {
        background: rgba(255, 255, 255, 0.12);
    }
    .nav-window:active {
        cursor: grabbing;
    }
    .nav-edge {
        position: absolute;
        top: -2px;
        bottom: -2px;
        width: 7px;
        cursor: ew-resize;
    }
    .nav-edge.l {
        left: -3px;
    }
    .nav-edge.r {
        right: -3px;
    }

    canvas {
        display: block;
        width: 100%;
        height: 100%;
    }

    .overlay {
        position: absolute;
        inset: 0;
        pointer-events: none;
        overflow: visible;
    }

    .playhead {
        stroke: var(--neutral);
        stroke-width: 1.2;
        opacity: 0.9;
    }

    .grip {
        fill: var(--neutral); /* matches the player knob; accent is reserved for the result curve */
        pointer-events: none; /* visual handle; the rulerzone owns the scrub */
    }

    /* the scrub zone: the whole top ruler + gap band. click/drag anywhere here moves
       the playhead. the body keeps the DEFAULT cursor — the editor-ruler convention
       (After Effects / animation-timeline: the ruler is default, not a resize edge). */
    .rulerzone {
        fill: transparent;
        pointer-events: all;
        cursor: default;
    }
    /* keyboard focus rings the playhead grip, not a full-width box on the ruler
       (mirrors the player slider's thumb focus ring) */
    .rulerzone:focus-visible {
        outline: none;
    }
    .rulerzone:focus-visible ~ .grip {
        stroke: var(--neutral-soft);
        stroke-width: 4;
        paint-order: stroke;
    }

    /* the force-mode chart surface: double-click places a point, a bare click clears
       the selection. default cursor (the diamonds carry their own move cursor). */
    .chartzone {
        fill: transparent;
        pointer-events: all;
        cursor: default;
    }

    /* force points: a filled diamond (the keyframe idiom — authored input, §6), light
       so it reads over the accent curve. selected turns accent with a fitted ring.
       plain arrow cursor — the desktop curve-editor convention (AE/Unity/Blender keep
       the default over keyframes; grab hands are for pannable surfaces, the navigator). */
    .fmarker {
        fill: var(--pin);
        stroke: #0e0d0c;
        stroke-width: 1;
        pointer-events: all;
        cursor: default;
        transition: fill 100ms ease;
    }
    .fmarker:hover {
        fill: #fff;
    }
    .fmarker.sel {
        fill: var(--accent);
        stroke: var(--fg);
        stroke-width: 1.4;
    }

    /* the player: a media transport (play · global scrub · timecode) floated as its
       own opaque surface above the timeline — narrower than the dock and clearly
       detached, a player over its scrubber-timeline. elevation from border + shadow. */
    .player {
        position: absolute;
        left: 50%;
        transform: translateX(-50%);
        bottom: 288px; /* above the dock (bottom 16 + height 240) + 32 gap */
        width: min(calc(100% - 32px), 560px);
        box-sizing: border-box;
        height: 36px;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 0 14px 0 7px;
        background: var(--bg-solid);
        border: 1px solid var(--border);
        border-radius: 6px;
        box-shadow: var(--shadow);
        font-family: "Outfit", system-ui, sans-serif;
        user-select: none;
        -webkit-user-select: none;
    }
    /* no track → the player goes quiet, not loud (gate 2) */
    .player.idle {
        opacity: 0.45;
        pointer-events: none;
    }

    .play {
        all: unset;
        box-sizing: border-box;
        width: 26px;
        height: 26px;
        flex: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        color: var(--neutral);
        cursor: pointer;
        transition: background 120ms ease, transform 80ms ease;
    }
    .play:hover {
        background: var(--neutral-soft);
    }
    .play:active {
        background: var(--neutral-soft);
        transform: scale(0.94);
    }
    .play svg {
        width: 15px;
        height: 15px;
    }

    /* global scrubber: a thin rail + neutral fill + grabbable thumb. the 26px-tall
       row is a fat hit area over a 3px rail. */
    .scrub {
        position: relative;
        flex: 1;
        height: 26px;
        display: flex;
        align-items: center;
        cursor: pointer;
        touch-action: none;
    }
    .rail,
    .fill {
        position: absolute;
        top: 50%;
        height: 3px;
        border-radius: 999px;
        transform: translateY(-50%);
        pointer-events: none;
    }
    .rail {
        left: 0;
        right: 0;
        background: rgba(255, 255, 255, 0.12);
    }
    .fill {
        left: 0;
        background: var(--neutral);
    }
    .thumb {
        position: absolute;
        top: 50%;
        width: 11px;
        height: 11px;
        border-radius: 50%;
        background: var(--neutral);
        border: 2px solid var(--bg-solid);
        transform: translate(-50%, -50%);
        transition: transform 100ms ease;
        pointer-events: none;
    }
    .scrub:hover .thumb,
    .scrub:active .thumb {
        transform: translate(-50%, -50%) scale(1.3);
    }
    .scrub:focus-visible {
        outline: none;
    }
    .scrub:focus-visible .thumb {
        box-shadow: 0 0 0 3px var(--neutral-soft);
    }

    .time {
        flex: none;
        font-family: "JetBrains Mono", ui-monospace, monospace;
        font-size: 11px;
        letter-spacing: -0.02em;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        color: var(--fg);
    }
    .time .sep {
        color: var(--muted);
        margin: 0 0.4em; /* breathing room around the slash */
    }
    .time .total {
        color: var(--muted);
    }
</style>
