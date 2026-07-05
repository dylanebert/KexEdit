<script lang="ts">
import type { State } from "@dylanebert/shallot";
import { onMount, untrack } from "svelte";
import { cartState, forceCurve } from "./cart";
import { editor, selectTarget, setHighlight } from "./editor";
import { cancel, commit, history, redo, undo } from "./history";
import {
    beginSolve,
    beginTargetMove,
    cancelSolve,
    createTarget,
    deleteTarget,
    type Marker,
    setTarget,
    setTargetActive,
    solveRunning,
    stepSolve,
    targetMarkers,
    trackMapping,
    trackScope,
} from "./targets";
import { bakeOut } from "./track";
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
    zoomAt,
} from "./timeline";
import { resize } from "./view";

const { ecs, eid, tick }: { ecs: State; eid: number | null; tick: number } = $props();

// the timeline shows the baked F_n force curve the realized track produces, plus
// scrub + zoom/pan navigation. force intent is authored here as point targets
// (double-click to place, drag both axes, Del) satisfied by an explicit Solve
// (kex/specs/kex2d-force-targets.md §3–§5); the span/live-RTI surface was stripped
// 2026-07-05 (git holds it at 3e19820).

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
// the initial y-frame before real data arrives: the reference band + 1g headroom.
const Y_HEADROOM = 1;
const CAP_LO = BAND[0] - Y_HEADROOM;
const CAP_HI = BAND[1] + Y_HEADROOM;
const Y_BASE = 1; // gravity baseline (1g)
const ZOOM_DIV = 200; // wheel-delta → geometric zoom rate
const MARKER_R = 6; // px; the target ring's radius

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
    // keep every target's demand in frame — the marker-to-curve gap IS the drift
    // readout, so a demand above/below the curve's own range must not clip away.
    for (const m of markers) {
        if (m.g < lo) lo = m.g;
        if (m.g > hi) hi = m.g;
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
// displayed axis so a placed/dragged marker can't leave the scale.
function yToG(cy: number): number {
    const inner = h - BOT_PAD - TOP;
    if (inner <= 0) return yView.lo;
    const f = (cy - TOP) / inner;
    return clamp(yView.lo + (1 - f) * (yView.hi - yView.lo), yView.lo, yView.hi);
}

// ── point force targets: inert demands on the force curve (§3–§5) ────────────
// authored by double-clicking the chart, dragged in both axes (vertical = g,
// horizontal = s), satisfied by an explicit Solve. targets store arclength and the
// chart's x-axis IS arclength (§4), so a marker sits at its s directly — no domain
// projection, and it never moves except by the author's hand.
const markers = $derived.by((): Marker[] => {
    void tick;
    return eid === null ? [] : targetMarkers(ecs, eid);
});
// the selected-target id, read through the per-RAF tick (editor is plain state).
const selTarget = $derived.by((): number | null => {
    void tick;
    return editor.target;
});
// the selected target's live marker — the source for the header's numeric fields
// and driving/driven toggle.
const selMarker = $derived.by((): Marker | null => {
    return selTarget === null ? null : (markers.find((m) => m.id === selTarget) ?? null);
});
// the Solve affordance: accented when any ACTIVE point sits off the curve beyond
// tolerance (a drift the solve would close; driven drift never accents, §6).
const dirty = $derived(markers.some((m) => m.active && !m.satisfied));
// whether the animated solve is in flight — the button reads Cancel, edits block.
const running = $derived.by((): boolean => {
    void tick;
    return solveRunning();
});

const markerX = (s: number): number => LEFT_GUT + sToPx(clamped, s);
const chartLocalX = (e: PointerEvent): number =>
    e.clientX - canvas.getBoundingClientRect().left - LEFT_GUT;
const chartLocalY = (e: PointerEvent): number =>
    e.clientY - canvas.getBoundingClientRect().top;
const fmtG = (g: number): string => `${+g.toFixed(1)}g`;

// ── create: double-click the empty chart drops a target at that exact demand ──
function chartCreate(e: MouseEvent): void {
    if (eid === null || solveRunning()) return; // edits blocked while a solve animates
    const rect = canvas.getBoundingClientRect();
    const s = Math.max(0, pxToS(clamped, e.clientX - rect.left - LEFT_GUT));
    const g = yToG(e.clientY - rect.top);
    selectTarget(createTarget(history, ecs, eid, s, g)); // born selected
}

// ── move: drag a marker in both axes (no solve, one undo entry on release) ──
// the x-axis is arclength, so the cursor's s maps straight through — no projection.
let dragging: number | null = null;
let grabDs = 0; // marker s − cursor s, so grabbing off-center doesn't snap
let grabDg = 0;
function markerDown(e: PointerEvent, mk: Marker): void {
    if (eid === null || e.button !== 0 || solveRunning()) return;
    e.preventDefault();
    e.stopPropagation(); // don't also deselect via the chartzone underneath
    beginTargetMove(ecs, mk.id);
    dragging = mk.id;
    selectTarget(mk.id);
    grabDs = mk.s - Math.max(0, pxToS(clamped, chartLocalX(e)));
    grabDg = mk.g - yToG(chartLocalY(e));
    window.addEventListener("pointermove", markerMove);
    window.addEventListener("pointerup", markerUp);
}
function markerMove(e: PointerEvent): void {
    if (dragging === null) return;
    const s = Math.max(0, pxToS(clamped, chartLocalX(e)) + grabDs);
    setTarget(ecs, dragging, s, yToG(chartLocalY(e)) + grabDg);
}
function markerUp(): void {
    if (dragging === null) return;
    dragging = null;
    commit(history); // one drag → one entry; a no-move click drops via the `same` guard
    window.removeEventListener("pointermove", markerMove);
    window.removeEventListener("pointerup", markerUp);
}
function cancelMarkerDrag(): void {
    if (dragging === null) return;
    dragging = null;
    cancel();
    window.removeEventListener("pointermove", markerMove);
    window.removeEventListener("pointerup", markerUp);
}

// ── solve: the explicit batch invocation over all targets, animated (§3, §8) ──
// pressing Solve opens the fixpoint session and highlights the freed nodes; the
// per-frame effect below advances it, morphing the geometry toward the solution.
// while it runs the button is Cancel; clicking it (or Esc) reverts and records
// nothing. only one solve runs at a time (beginSolve refuses a second).
// the cart rides in time and projects onto the distance chart (§4), so a playing
// cart would sweep the playhead across the morphing curve mid-solve. suspend it
// for the animation (a transient hold, not a mode) and restore the prior play
// state when the solve settles — so the author watches the curve, not a dart.
let solveResumePlay = false;
function suspendCart(): void {
    if (eid === null) return;
    const st = cartState.get(eid);
    if (!st) return;
    solveResumePlay = !st.held; // resume playback only if it was playing
    st.held = true;
}
function restoreCart(): void {
    if (eid === null) return;
    const st = cartState.get(eid);
    if (st) st.held = !solveResumePlay;
}
function solveClick(): void {
    if (eid === null) return;
    if (solveRunning()) {
        cancelSolve(); // Cancel: revert the pre-solve pose, record nothing (§8)
        setHighlight([]);
        restoreCart();
        return;
    }
    setHighlight(trackScope(ecs, eid)); // the §5 freed-node scope, lit for the run
    if (beginSolve(ecs, eid, performance.now())) suspendCart();
    else setHighlight([]); // nothing to solve
}
// advance the running solve once per frame (§8): the driver live-writes each
// iterate, the display re-bakes through the bake hash. clears the highlight and
// resumes the cart on completion — the run committed (or, if idempotent, dropped).
$effect(() => {
    void tick; // one step per animation frame
    if (!solveRunning()) return;
    const st = stepSolve(history, performance.now());
    if (st?.done) {
        setHighlight([]);
        restoreCart();
    }
});

function deleteSelectedTarget(): void {
    if (editor.target === null || solveRunning()) return;
    deleteTarget(history, ecs, editor.target);
    selectTarget(null);
}

// ── header fields: type the selected target's s / g and toggle driving/driven ──
// each field commits one undo entry through the marker-move gesture (begin →
// setTarget → commit), the same path the drag uses. blocked while a solve runs.
function commitField(s: number, g: number): void {
    const id = selTarget;
    if (id === null || solveRunning()) return;
    beginTargetMove(ecs, id);
    setTarget(ecs, id, Math.max(0, s), g);
    commit(history);
}
function onFieldS(e: Event): void {
    const v = Number.parseFloat((e.currentTarget as HTMLInputElement).value);
    if (Number.isFinite(v) && selMarker) commitField(v, selMarker.g);
}
function onFieldG(e: Event): void {
    const v = Number.parseFloat((e.currentTarget as HTMLInputElement).value);
    if (Number.isFinite(v) && selMarker) commitField(selMarker.s, v);
}
function toggleDriven(): void {
    if (selTarget === null || !selMarker || solveRunning()) return;
    setTargetActive(history, ecs, selTarget, !selMarker.active); // one undo entry
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
        // Esc cancels a running solve first (§8) — reverts the pose, records nothing.
        if (e.key === "Escape" && solveRunning()) {
            e.preventDefault();
            cancelSolve();
            setHighlight([]);
            restoreCart();
            return;
        }
        // target select/delete — guarded on a live target selection so node Esc/Del
        // (controls.ts) route unambiguously (selection is mutually exclusive).
        if (editor.target !== null) {
            if (e.key === "Escape") {
                e.preventDefault();
                selectTarget(null);
            } else if (e.key === "Delete" || e.key === "Backspace") {
                e.preventDefault();
                deleteSelectedTarget();
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
        cancelMarkerDrag(); // and any in-flight marker drag
        cancelSolve(); // and revert any in-flight animated solve (records nothing)
        restoreCart(); // resume the cart if a solve had suspended it (no stuck pause on remount)
        setHighlight([]); // clear the solve flash so a remount shows no phantom halo
    };
});
</script>

<aside class="dock">
    <!-- the header row: the permanent quiet home for Solve (→ Cancel while running)
         and, when a target is selected, its typed s / g fields + driving/driven
         toggle (§4/§6). empty and silent with no targets/selection (gate 2). -->
    <div class="header">
        {#if selMarker}
            <div class="fields">
                <div class="fld">
                    <span class="key">s</span>
                    <input
                        type="number"
                        step="1"
                        min="0"
                        value={selMarker.s.toFixed(1)}
                        onchange={onFieldS}
                        disabled={running}
                        aria-label="Target distance (m)"
                    />
                    <span class="unit">m</span>
                </div>
                <div class="fld">
                    <span class="key">F</span>
                    <input
                        type="number"
                        step="0.1"
                        value={selMarker.g.toFixed(2)}
                        onchange={onFieldG}
                        disabled={running}
                        aria-label="Target force (g)"
                    />
                    <span class="unit">g</span>
                </div>
                <button
                    class="toggle"
                    class:driven={!selMarker.active}
                    type="button"
                    onclick={toggleDriven}
                    disabled={running}
                    title={selMarker.active
                        ? "Driving — drives the solve. Click to make driven (measure only)."
                        : "Driven — measures only. Click to make driving."}
                >
                    {selMarker.active ? "Driving" : "Driven"}
                </button>
            </div>
        {/if}
        <div class="spacer"></div>
        {#if markers.length > 0}
            <button
                class="solve"
                class:dirty
                class:running
                type="button"
                onclick={solveClick}
                title={running ? "Cancel the solve (Esc)" : "Fit the track to the force targets"}
            >
                {running ? "Cancel" : "Solve"}
            </button>
        {/if}
    </div>
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
                <!-- clip the target markers to the inner chart rect so an off-scale
                     marker doesn't paint over the ruler or the g-gutter. -->
                <clipPath id="chartclip">
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
                <!-- the chart interaction surface: double-click drops a target at the
                     exact demand under the cursor; a bare click on empty chart clears
                     the target selection. markers sit above it. -->
                <rect
                    class="chartzone"
                    x={LEFT_GUT}
                    y={TOP}
                    width={Math.max(0, w - LEFT_GUT)}
                    height={Math.max(0, h - BOT_PAD - TOP)}
                    ondblclick={chartCreate}
                    onpointerdown={(e) => {
                        if (e.button === 0) selectTarget(null);
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
            <!-- point force targets: a hollow ring at (s, g_target) — an optimization
                 constraint, not a keyframe (§6). the dotted drop-line to the curve at
                 its s IS the residual Solve will close; an active drift turns danger and
                 spells out demanded → achieved; a driven target is dashed + faded. drag
                 both axes; the chartzone owns creation. -->
            <g class="markers" clip-path="url(#chartclip)">
                {#each markers as m (m.id)}
                    {@const mx = markerX(m.s)}
                    {#if mx >= LEFT_GUT - MARKER_R && mx <= w + MARKER_R}
                        {@const my = yOf(m.g)}
                        {#if !m.satisfied}
                            <line
                                class="drop"
                                class:drift={m.active}
                                class:driven={!m.active}
                                x1={mx}
                                x2={mx}
                                y1={my}
                                y2={yOf(m.achieved)}
                            />
                        {/if}
                        <circle
                            class="tmarker"
                            class:sel={m.id === selTarget}
                            class:drift={m.active && !m.satisfied}
                            class:driven={!m.active}
                            data-id={m.id}
                            cx={mx}
                            cy={my}
                            r={MARKER_R}
                            onpointerdown={(e) => markerDown(e, m)}
                            role="presentation"
                        />
                        {#if m.active && !m.satisfied}
                            <text class="tlabel" x={mx + MARKER_R + 5} y={my}>
                                {fmtG(m.g)} → {fmtG(m.achieved)}
                            </text>
                        {/if}
                    {/if}
                {/each}
            </g>
        </svg>
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

    .body {
        position: relative;
        flex: 1;
        min-height: 0;
    }

    /* the header row: Solve (→ Cancel) at the right, the selected target's typed
       fields + driving/driven toggle at the left. quiet + empty with no targets. */
    .header {
        flex: none;
        height: 34px;
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 0 10px;
        border-bottom: 1px solid var(--border);
    }
    .spacer {
        flex: 1;
    }
    .fields {
        display: flex;
        align-items: center;
        gap: 10px;
    }
    .fld {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-family: "JetBrains Mono", ui-monospace, monospace;
        font-size: 11px;
        color: var(--muted);
    }
    .fld input {
        width: 54px;
        box-sizing: border-box;
        padding: 2px 5px;
        background: var(--bg-solid);
        border: 1px solid var(--border);
        border-radius: 4px;
        color: var(--fg);
        font: inherit;
        text-align: right;
    }
    .fld input:focus {
        outline: none;
        border-color: var(--neutral);
    }
    .fld input:disabled {
        opacity: 0.5;
    }
    /* driving/driven toggle: accent-filled while driving (it drives the solve),
       muted outline while driven (measure only) — the CAD-sketcher distinction. */
    .toggle {
        all: unset;
        box-sizing: border-box;
        padding: 3px 10px;
        border-radius: 5px;
        border: 1px solid var(--accent);
        background: var(--accent-soft);
        color: var(--accent);
        font-family: "Outfit", system-ui, sans-serif;
        font-size: 11px;
        cursor: pointer;
        transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
    }
    .toggle.driven {
        border-color: var(--border);
        background: transparent;
        color: var(--muted);
    }
    .toggle:disabled {
        opacity: 0.5;
        cursor: default;
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

    /* chart interaction surface: transparent, catches double-click (place) and
       empty-click (deselect). default cursor — placement is a double-click, not a
       primary drag, so no crosshair to promise otherwise. */
    .chartzone {
        fill: transparent;
        pointer-events: all;
        cursor: default;
    }

    /* point force targets: a hollow ring — an optimization constraint, not a filled
       keyframe (§6). the ring color reads state (pin / danger drift / muted driven);
       selection adds a soft glow, so it composes with the state color. */
    .tmarker {
        fill: var(--bg-solid);
        stroke: var(--pin);
        stroke-width: 2;
        pointer-events: all;
        cursor: grab;
        transition: stroke 120ms ease;
    }
    .tmarker:active {
        cursor: grabbing;
    }
    .tmarker.drift {
        stroke: var(--danger);
    }
    .tmarker.driven {
        stroke: var(--muted);
        stroke-dasharray: 2.4 2.4;
        opacity: 0.6;
    }
    .tmarker.sel {
        filter: drop-shadow(0 0 2.5px var(--fg));
    }
    /* the residual made visible: a dotted drop-line from the demand ring to the
       curve at its s. neutral for a driven measurement, danger for an active drift. */
    .drop {
        stroke: var(--muted);
        stroke-width: 1.2;
        stroke-dasharray: 2 3;
        pointer-events: none;
    }
    .drop.drift {
        stroke: var(--danger);
    }
    .drop.driven {
        opacity: 0.5;
    }
    .tlabel {
        fill: var(--danger);
        font-family: "JetBrains Mono", ui-monospace, monospace;
        font-size: 10px;
        dominant-baseline: middle;
        pointer-events: none;
        user-select: none;
    }

    /* Solve: summoned only when targets exist (gate 1/2). neutral while every active
       point sits on the curve, accented when a drift is open; while a solve animates
       it becomes a pulsing Cancel (§8). */
    .solve {
        all: unset;
        box-sizing: border-box;
        padding: 4px 14px;
        border-radius: 5px;
        background: var(--bg-solid);
        border: 1px solid var(--border);
        font-family: "Outfit", system-ui, sans-serif;
        font-size: 12px;
        color: var(--muted);
        cursor: pointer;
        transition: background 120ms ease, border-color 120ms ease, color 120ms ease,
            transform 80ms ease;
    }
    .solve:hover {
        color: var(--fg);
        border-color: var(--neutral);
    }
    .solve:active {
        transform: scale(0.96);
    }
    .solve.dirty {
        color: var(--accent);
        border-color: var(--accent);
        background: var(--accent-soft);
    }
    .solve.running {
        color: var(--danger);
        border-color: var(--danger);
        background: var(--danger-soft);
        animation: solvepulse 1s ease-in-out infinite;
    }
    @keyframes solvepulse {
        0%,
        100% {
            opacity: 1;
        }
        50% {
            opacity: 0.62;
        }
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
