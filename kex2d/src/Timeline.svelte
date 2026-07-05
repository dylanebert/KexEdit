<script lang="ts">
import type { State } from "@dylanebert/shallot";
import { onMount, untrack } from "svelte";
import { cartState, sampleFNOverTime } from "./cart";
import { editor, selectTarget, setHighlight } from "./editor";
import { history, redo, undo } from "./history";
import {
    type Band,
    beginDemand,
    cancelDemand,
    createTarget,
    deleteTarget,
    demandScope,
    endDemand,
    resolveTarget,
    stepDemand,
    targetBands,
    trackMapping,
    trackScope,
} from "./targets";
import { bakeOut } from "./track";
import {
    chipLayout,
    clampView,
    frameAll,
    type Mapping,
    marginSec,
    navDragView,
    navWindow,
    niceStep,
    pxToSec,
    secToPx,
    ticks,
    timeToArc,
    type View,
    yFit,
    type YFit,
    zoomAt,
} from "./timeline";
import { resize } from "./view";

const { ecs, eid, tick }: { ecs: State; eid: number | null; tick: number } = $props();

// the timeline shows the baked F_n force curve the realized track produces, plus
// scrub + zoom/pan navigation. force intent is authored here as span-scoped
// targets (kex/specs/kex2d-force-targets.md): drag-select a span to create a
// band, drag the band vertically to demand a held g (a live RTI solve deforms the
// track), summon ⟳ to re-solve drift, Del to remove. targets store arclength and
// display in time through the frozen-per-gesture mapping.

// timeline bands, top → bottom: a scrubbable RULER (ticks + labels + playhead
// handle, the dedicated scrub zone), a demarcating GAP the playhead passes through,
// then the curve chart. The After Effects / animation-timeline / kexedit-main layout
// (time ruler on top, click-anywhere-to-scrub), not a plot with a bottom axis.
const RULER_H = 26; // top scrub band: ticks, labels, playhead handle
const GAP_H = 20; // marker lane between ruler and chart — a full row (event markers later)
const TOP = RULER_H + GAP_H; // chart top
const BOT_PAD = 8; // chart inset, bottom
const LEFT_GUT = 44; // left gutter: the g-axis labels live here; the chart insets past it
const LABEL_EDGE = 22; // px; ruler labels within this of an edge align inward, not centered
const LABEL_HALF = 5; // px; half a g-label's height — hide a label nearer than this to the plot edge
// reference comfort limits (g) — drawn as faint lines to read the force curve against.
const BAND: [number, number] = [-2, 6];
// force curve display resolution: baked F_n resampled onto this many uniform-time points.
const DISPLAY_GRID = 256;
// the initial y-frame before real data arrives: the reference band + 1g headroom.
const Y_HEADROOM = 1;
const CAP_LO = BAND[0] - Y_HEADROOM;
const CAP_HI = BAND[1] + Y_HEADROOM;
const Y_BASE = 1; // gravity baseline (1g)
const ZOOM_DIV = 200; // wheel-delta → geometric zoom rate
const RESOLVE_FLASH_MS = 450; // ⟳ freed-node highlight beat (the solve itself is instant)

let host: HTMLDivElement;
let canvas: HTMLCanvasElement;
let navCanvas: HTMLCanvasElement | undefined = $state();
let w = $state(0);
let h = $state(0);
// the user's view intent; `clamped` re-fits it to the live width/track length, so a
// resize or a track edit never writes back into `view` (which would loop the effect).
let view: View = $state({ pan: 0, pxPerSec: 100 });
let framed = false;

const clamp = (x: number, lo: number, hi: number): number => Math.min(Math.max(x, lo), hi);

// total track seconds — the X-axis domain. force-curve point i ↔ sec (i/(N-1))·tTotal.
const tTotal = $derived.by((): number => {
    void tick;
    if (eid === null) return 0;
    return bakeOut.get(eid)?.tTotal ?? 0;
});
// the chart insets past the left g-gutter; the time affine lives in [LEFT_GUT, w],
// so every timeline.ts call takes `chartW` and screen-X adds/subtracts LEFT_GUT.
const chartW = $derived(Math.max(0, w - LEFT_GUT));
const clamped = $derived(clampView(view, chartW, tTotal));
const tickList = $derived(ticks(clamped, chartW));

const fN = $derived.by((): Float32Array | null => {
    void tick;
    if (eid === null) return null;
    return sampleFNOverTime(eid, DISPLAY_GRID);
});
// the cart's time — its own second on the baked track's clock, the same axis units.
const cartSec = $derived.by((): number | null => {
    void tick;
    if (eid === null) return null;
    return cartState.get(eid)?.t ?? null;
});
const playPx = $derived.by((): number | null => {
    if (cartSec === null) return null;
    const x = LEFT_GUT + secToPx(clamped, cartSec);
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
    const a = fN;
    if (a) {
        for (let i = 0; i < a.length; i++) {
            if (a[i] < lo) lo = a[i];
            if (a[i] > hi) hi = a[i];
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

// invert yOf: a chart cursor Y (canvas-relative px) → its g value, clamped to the
// displayed axis so a dragged band can't leave the scale.
function yToG(cy: number): number {
    const inner = h - BOT_PAD - TOP;
    if (inner <= 0) return yView.lo;
    const f = (cy - TOP) / inner;
    return clamp(yView.lo + (1 - f) * (yView.hi - yView.lo), yView.lo, yView.hi);
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
    if (!panning) return; // drag content right → reveal earlier time → pan decreases
    view = clampView({ pan: pan0 - (e.clientX - panX0), pxPerSec: clamped.pxPerSec }, chartW, tTotal);
}
function panUp(): void {
    panning = false;
    window.removeEventListener("pointermove", panMove);
    window.removeEventListener("pointerup", panUp);
}

// ── time navigator: a full-track overview below the chart, drawn as a preview minimap
// (see renderNav). a window-bracket marks the portion the chart shows; drag the body to
// pan, drag an edge to zoom (the opposite edge anchored). the bar spans [0, tTotal +
// lead-out], so framing the whole track fills it.
let navEl: HTMLDivElement | undefined = $state();
const navWin = $derived(
    eid === null || tTotal <= 0 || chartW <= 0 ? null : navWindow(clamped, chartW, tTotal),
);
let navDrag: { mode: "pan" | "l" | "r"; grab: number } | null = null;
function navSecAt(clientX: number): number {
    const rect = navEl!.getBoundingClientRect();
    const total = tTotal + marginSec(tTotal);
    return clamp(((clientX - rect.left) / Math.max(1, rect.width)) * total, 0, total);
}
function navDown(e: PointerEvent, mode: "pan" | "l" | "r"): void {
    if (eid === null || tTotal <= 0) return;
    e.preventDefault();
    e.stopPropagation(); // an edge press must not also start a window pan
    navDrag = { mode, grab: navSecAt(e.clientX) - pxToSec(clamped, 0) };
    window.addEventListener("pointermove", navMove);
    window.addEventListener("pointerup", navUp);
}
function navMove(e: PointerEvent): void {
    if (!navDrag) return;
    view = navDragView(clamped, chartW, tTotal, navDrag.mode, navSecAt(e.clientX), navDrag.grab);
}
function navUp(): void {
    navDrag = null;
    window.removeEventListener("pointermove", navMove);
    window.removeEventListener("pointerup", navUp);
}

// ── force targets: span-scoped demands on the force curve ────────────────────
// created by drag-selecting a time span, demanded by dragging the band, re-solved
// (⟳) or deleted from the chip. targets store arclength; the display mapping
// projects them to time. during a demand the mapping FREEZES so the band's
// x-extent can't squirm while the geometry deforms (§4), reflowing at rest.

const liveMapping = $derived.by((): Mapping | null => {
    void tick;
    return eid === null ? null : trackMapping(eid);
});
// while demanding, hold the frozen snapshot; otherwise the live (reflowing) map.
let frozenMap: Mapping | null = null;
const mapping = $derived.by((): Mapping | null => {
    void tick;
    return frozenMap ?? liveMapping;
});
const bands = $derived.by((): Band[] => {
    void tick;
    const m = mapping;
    return eid === null || m === null ? [] : targetBands(ecs, eid, m);
});
// the selected-target id, read through the per-RAF tick (editor is plain state).
const selTarget = $derived.by((): number | null => {
    void tick;
    return editor.target;
});
// chip x-centers, de-overlapped along the marker lane.
const CHIP_MIN_GAP = 68; // px between chip centers before they nudge apart
const chipX = $derived.by((): number[] => {
    const raw = bands.map((b) =>
        clamp(LEFT_GUT + secToPx(clamped, (b.t0 + b.t1) / 2), LEFT_GUT + 4, w - 4),
    );
    return chipLayout(raw, CHIP_MIN_GAP);
});

const bandX = (t: number): number => clamp(LEFT_GUT + secToPx(clamped, t), LEFT_GUT, w);
const fmtG = (g: number): string => `${+g.toFixed(1)}g`;
const chartLocalX = (e: PointerEvent): number =>
    e.clientX - canvas.getBoundingClientRect().left - LEFT_GUT;

// ── create: drag-select a time span on the chart ──
let selecting: { x0: number } | null = null;
let selRect: { x0: number; x1: number } | null = $state(null); // chart-local px
const SEL_MIN_PX = 6; // shorter than this reads as a click, not a span

function selectDown(e: PointerEvent): void {
    if (eid === null || e.button !== 0) return;
    e.preventDefault();
    const x0 = chartLocalX(e);
    selecting = { x0 };
    selRect = { x0, x1: x0 };
    window.addEventListener("pointermove", selectMove);
    window.addEventListener("pointerup", selectUp);
}
function selectMove(e: PointerEvent): void {
    if (!selecting) return;
    selRect = { x0: selecting.x0, x1: chartLocalX(e) };
}
function selectUp(e: PointerEvent): void {
    const s = selecting;
    selecting = null;
    selRect = null;
    window.removeEventListener("pointermove", selectMove);
    window.removeEventListener("pointerup", selectUp);
    if (!s || eid === null) return;
    const x1 = chartLocalX(e);
    if (Math.abs(x1 - s.x0) < SEL_MIN_PX) {
        selectTarget(null); // a click on empty chart clears the selection
        return;
    }
    const m = liveMapping;
    if (!m) return;
    const s0 = timeToArc(m, Math.max(0, pxToSec(clamped, Math.min(s.x0, x1))));
    const s1 = timeToArc(m, Math.max(0, pxToSec(clamped, Math.max(s.x0, x1))));
    const id = createTarget(history, ecs, eid, s0, s1);
    if (id >= 0) selectTarget(id);
}

// ── demand: drag a band vertically, live RTI solve per frame ──
let demanding: number | null = null; // the target id being dragged
let demandMoved = false; // did the pointer actually move — else it's a select-only click
function bandDown(e: PointerEvent, id: number): void {
    if (eid === null || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation(); // don't also start a chart select underneath
    if (!beginDemand(ecs, eid, id)) return;
    demanding = id;
    demandMoved = false;
    frozenMap = liveMapping; // freeze the display mapping for the gesture
    selectTarget(id);
    setHighlight(demandScope());
    window.addEventListener("pointermove", bandMove);
    window.addEventListener("pointerup", bandUp);
}
function bandMove(e: PointerEvent): void {
    if (demanding === null) return;
    demandMoved = true;
    stepDemand(ecs, demanding, yToG(e.clientY - canvas.getBoundingClientRect().top));
}
function bandUp(): void {
    if (demanding === null) return;
    demanding = null;
    // a click with no drag only selects (done in bandDown) — cancel the gesture so
    // the settle's sub-epsilon node nudge doesn't record a near-no-op undo entry.
    if (demandMoved) endDemand(history, ecs);
    else cancelDemand();
    frozenMap = null;
    setHighlight([]);
    window.removeEventListener("pointermove", bandMove);
    window.removeEventListener("pointerup", bandUp);
}
function cancelBand(): void {
    if (demanding === null) return;
    demanding = null;
    cancelDemand();
    frozenMap = null;
    setHighlight([]);
    window.removeEventListener("pointermove", bandMove);
    window.removeEventListener("pointerup", bandUp);
}

// ── chip actions ──
let resolveFlash: ReturnType<typeof setTimeout> | null = null;
function resolveClick(e: MouseEvent, id: number): void {
    e.stopPropagation();
    if (eid === null) return;
    selectTarget(id);
    // the solve is synchronous (one frame), so flash the freed nodes for a beat —
    // the instant-solve equivalent of the live demand's held highlight (§5).
    setHighlight(trackScope(ecs, eid));
    resolveTarget(history, ecs, eid);
    if (resolveFlash) clearTimeout(resolveFlash);
    resolveFlash = setTimeout(() => setHighlight([]), RESOLVE_FLASH_MS);
}
function deleteSelectedTarget(): void {
    if (editor.target === null || eid === null) return;
    deleteTarget(history, ecs, editor.target);
    selectTarget(null);
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
        // faint gridline through the chart — read the curve against time
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
        // align the first/last labels inward so an edge tick isn't clipped
        ctx.fillStyle = "rgba(160, 152, 144, 0.8)";
        ctx.textBaseline = "top";
        if (x < LEFT_GUT + LABEL_EDGE) {
            ctx.textAlign = "left";
            ctx.fillText(tk.label, Math.max(LEFT_GUT + 2, x), 8);
        } else if (x > w - LABEL_EDGE) {
            ctx.textAlign = "right";
            ctx.fillText(tk.label, Math.min(w - 2, x), 8);
        } else {
            ctx.textAlign = "center";
            ctx.fillText(tk.label, x, 8);
        }
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

    // the baked F_n force curve — accent: the force the realized track produces
    if (fN) {
        ctx.strokeStyle = "rgb(212, 149, 96)";
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        const n = fN.length;
        for (let i = 0; i < n; i++) {
            const x = LEFT_GUT + secToPx(v, (i / (n - 1)) * tTotal);
            const y = yOf(fN[i]);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }

    ctx.restore();
}

// the navigator preview (VSCode-minimap / DAW-overview style): a faint miniature of
// the whole F_n force curve across the full track, so the viewport bracket reads
// against the curve's shape. y-range tracks the chart's `yView`; the curve occupies
// only [0, tTotal] of the width (the lead-out margin stays empty).
function renderNav(nav: CanvasRenderingContext2D, cw: number, ch: number): void {
    nav.clearRect(0, 0, cw, ch);
    const data = fN;
    if (!data || data.length < 2 || tTotal <= 0) return;
    const trackFrac = tTotal / (tTotal + marginSec(tTotal)); // curve span within the bar
    const { lo, hi } = yView;
    const span = Math.max(1e-6, hi - lo);
    const pad = 2; // vertical inset so the curve doesn't touch the lane edges
    const ny = (val: number): number =>
        pad + (1 - (clamp(val, lo, hi) - lo) / span) * (ch - 2 * pad);
    nav.strokeStyle = "rgba(212, 149, 96, 0.55)"; // dim accent
    nav.lineWidth = 1;
    nav.beginPath();
    const n = data.length;
    for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * trackFrac * cw;
        const y = ny(data[i]);
        if (i === 0) nav.moveTo(x, y);
        else nav.lineTo(x, y);
    }
    nav.stroke();
}

$effect(() => {
    // frame the whole track once, when width + a track first exist.
    if (!framed && chartW > 0 && tTotal > 0) {
        view = frameAll(chartW, tTotal);
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
    const rect = canvas.getBoundingClientRect();
    const sec = pxToSec(clamped, e.clientX - rect.left - LEFT_GUT);
    const st = cartState.get(eid);
    if (st) st.t = clamp(sec, 0, tTotal);
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
            view = clampView({ pan: clamped.pan + dx, pxPerSec: clamped.pxPerSec }, chartW, tTotal);
        } else {
            view = zoomAt(clamped, x, 2 ** (-e.deltaY / ZOOM_DIV), chartW, tTotal);
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
        // Esc cancels an in-flight demand, else deselects the target; Del removes
        // the selected target (node Del/Esc live in controls.ts — selection is
        // mutually exclusive, so exactly one handler acts).
        if (e.key === "Escape") {
            if (demanding !== null) {
                e.preventDefault();
                cancelBand();
            } else if (editor.target !== null) {
                e.preventDefault();
                selectTarget(null);
            }
            return;
        }
        if ((e.key === "Delete" || e.key === "Backspace") && editor.target !== null) {
            e.preventDefault();
            deleteSelectedTarget();
            return;
        }
        if (e.code === "Space") {
            e.preventDefault();
            togglePlay();
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
        cancelBand(); // and any in-flight band demand
        if (resolveFlash) clearTimeout(resolveFlash); // drop a pending ⟳ highlight clear
        selecting = null;
        selRect = null;
        window.removeEventListener("pointermove", selectMove);
        window.removeEventListener("pointerup", selectUp);
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
            <!-- the scrub zone: the whole ruler + gap band. click/drag anywhere here
                 moves the playhead (the time ruler is the scrubber). -->
            {#if eid !== null && tTotal > 0}
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
                    aria-valuemax={Math.round(tTotal * 100) / 100}
                    aria-valuenow={Math.round((cartSec ?? 0) * 100) / 100}
                />
            {/if}
            <!-- chart drag-select zone: a left-drag here authors a new span target.
                 sits below the bands in paint order, so a band catches its own drag. -->
            {#if eid !== null && tTotal > 0}
                <rect
                    class="chartzone"
                    x={LEFT_GUT}
                    y={TOP}
                    width={Math.max(0, w - LEFT_GUT)}
                    height={Math.max(0, h - BOT_PAD - TOP)}
                    onpointerdown={selectDown}
                    role="presentation"
                />
            {/if}
            <!-- the rubber-band while selecting a span -->
            {#if selRect}
                <rect
                    class="selband"
                    x={LEFT_GUT + Math.min(selRect.x0, selRect.x1)}
                    y={TOP}
                    width={Math.abs(selRect.x1 - selRect.x0)}
                    height={Math.max(0, h - BOT_PAD - TOP)}
                />
            {/if}
            <!-- target bands: a draggable horizontal segment at the held g over the
                 span. drag vertically to demand (live RTI solve). -->
            {#each bands as b (b.id)}
                <g class="band" class:sel={b.id === selTarget} class:drift={!b.satisfied}>
                    <line
                        class="bandhit"
                        x1={bandX(b.t0)}
                        x2={bandX(b.t1)}
                        y1={yOf(b.g)}
                        y2={yOf(b.g)}
                        onpointerdown={(e) => bandDown(e, b.id)}
                        role="presentation"
                    />
                    <line
                        class="bandline"
                        x1={bandX(b.t0)}
                        x2={bandX(b.t1)}
                        y1={yOf(b.g)}
                        y2={yOf(b.g)}
                    />
                </g>
            {/each}
            <!-- playhead: a handle in the ruler + a line down through the gap and
                 chart. visual only — the rulerzone above owns the scrub interaction. -->
            {#if playPx !== null}
                <line class="playhead" x1={playPx} x2={playPx} y1={RULER_H} y2={h - BOT_PAD} />
                <polygon
                    class="grip"
                    points="{playPx - 5},{RULER_H - 10} {playPx + 5},{RULER_H - 10} {playPx},{RULER_H}"
                />
            {/if}
        </svg>
        <!-- chip lane: one chip per target in the marker lane. shows the held value,
             or achieved→target + a ⟳ when the curve has drifted off the band. -->
        <div class="chips">
            {#each bands as b, i (b.id)}
                <div
                    class="chip"
                    class:sel={b.id === selTarget}
                    class:drift={!b.satisfied}
                    style="left: {chipX[i]}px; top: {RULER_H + GAP_H / 2}px;"
                    onpointerdown={(e) => {
                        e.stopPropagation();
                        selectTarget(b.id);
                    }}
                    onkeydown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            selectTarget(b.id);
                        }
                    }}
                    role="button"
                    tabindex="0"
                    title={b.satisfied
                        ? `Force target ${fmtG(b.g)}`
                        : `${fmtG(b.achieved)} of ${fmtG(b.g)} — drifted`}
                >
                    <span class="val">
                        {#if b.satisfied}
                            {fmtG(b.g)}
                        {:else}
                            <span class="ach">{fmtG(b.achieved)}</span><span class="arrow">→</span
                            >{fmtG(b.g)}
                        {/if}
                    </span>
                    {#if !b.satisfied}
                        <button
                            class="resolve"
                            type="button"
                            title="Re-solve (⟳)"
                            aria-label="Re-solve"
                            onpointerdown={(e) => e.stopPropagation()}
                            onclick={(e) => resolveClick(e, b.id)}>⟳</button
                        >
                    {/if}
                </div>
            {/each}
        </div>
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
        height: 206px;
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

    /* chart drag-select zone: authors a span target. crosshair to signal "select a
       region"; transparent so the curve reads through. */
    .chartzone {
        fill: transparent;
        pointer-events: all;
        cursor: crosshair;
    }
    /* the rubber-band drawn while dragging out a new span. */
    .selband {
        fill: rgba(212, 149, 96, 0.1);
        stroke: rgba(212, 149, 96, 0.55);
        stroke-width: 1;
        pointer-events: none;
    }

    /* target band: a horizontal segment at the held g. authored intent draws in the
       light --pin tone (the accent is reserved for the result force curve, so the
       demand and what it produces stay visually distinct). */
    .bandhit {
        stroke: transparent;
        stroke-width: 14; /* fat invisible hit area over the 2px line */
        pointer-events: stroke;
        cursor: ns-resize;
    }
    .bandline {
        stroke: var(--pin);
        stroke-width: 2;
        pointer-events: none;
    }
    .band.sel .bandline {
        stroke-width: 3;
    }
    /* drifted off the curve: dashed, so the gap between demand and reality reads. */
    .band.drift .bandline {
        stroke: var(--danger);
        stroke-dasharray: 5 3;
    }

    /* chip lane: chips float over the marker lane; the container passes pointers
       through except on the chips themselves. */
    .chips {
        position: absolute;
        inset: 0;
        z-index: 3;
        pointer-events: none;
    }
    .chip {
        position: absolute;
        transform: translate(-50%, -50%);
        display: inline-flex;
        align-items: center;
        gap: 4px;
        height: 16px;
        padding: 0 6px;
        border-radius: 8px;
        background: var(--bg-solid);
        border: 1px solid var(--border);
        box-shadow: var(--shadow);
        color: var(--fg);
        font-family: "JetBrains Mono", ui-monospace, monospace;
        font-size: 10px;
        line-height: 1;
        white-space: nowrap;
        cursor: pointer;
        pointer-events: auto;
        transition: border-color 120ms ease, background 120ms ease;
    }
    .chip:hover {
        border-color: rgba(255, 255, 255, 0.22);
    }
    .chip.sel {
        border-color: var(--accent);
        background: var(--accent-soft);
    }
    .chip.drift {
        border-color: var(--danger);
    }
    .chip:focus-visible {
        outline: none;
        border-color: var(--accent);
    }
    .chip .ach {
        color: var(--danger);
    }
    .chip .arrow {
        color: var(--muted);
        margin: 0 1px;
    }
    .resolve {
        all: unset;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 13px;
        height: 13px;
        border-radius: 50%;
        color: var(--danger);
        font-size: 11px;
        cursor: pointer;
        transition: background 120ms ease, transform 80ms ease;
    }
    .resolve:hover {
        background: var(--danger-soft);
    }
    .resolve:active {
        transform: scale(0.9);
    }

    /* the player: a media transport (play · global scrub · timecode) floated as its
       own opaque surface above the timeline — narrower than the dock and clearly
       detached, a player over its scrubber-timeline. elevation from border + shadow. */
    .player {
        position: absolute;
        left: 50%;
        transform: translateX(-50%);
        bottom: 254px; /* above the dock (bottom 16 + height 206) + 32 gap */
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
