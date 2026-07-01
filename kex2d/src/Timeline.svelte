<script lang="ts">
import { onMount, untrack } from "svelte";
import { cartPose, cartState, cartTimeAtU, sampleFNOverTime } from "./cart";
import { beginPin, cancel, commit, drop, erase, history, redo, undo } from "./history";
import { OPT_GRID, solveOut } from "./optimize";
import { findPin, type Pin, pinsOf, setHandle, setPin } from "./pins";
import { DEFAULT_BAND } from "./solve";
import { bakeOut } from "./track";
import {
    clampView,
    frameAll,
    marginSec,
    mirrorTangent,
    navDragView,
    navWindow,
    niceStep,
    pxToSec,
    secToPx,
    ticks,
    type View,
    yFit,
    type YFit,
    yGrow,
    zoomAt,
} from "./timeline";
import { resize } from "./view";

const { eid, tick }: { eid: number | null; tick: number } = $props();

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
// CAP = the force band + 1g headroom. it clamps authored pin values and caps a pin
// drag's edge-grow; it is NOT the display range (that's `yView`, a FIT_FLOOR frame).
const Y_HEADROOM = 1;
const CAP_LO = DEFAULT_BAND[0] - Y_HEADROOM;
const CAP_HI = DEFAULT_BAND[1] + Y_HEADROOM;
const CAP: [number, number] = [CAP_LO, CAP_HI];
const Y_BASE = 1; // gravity baseline (1g)
const ZOOM_DIV = 200; // wheel-delta → geometric zoom rate
const N = OPT_GRID; // draft-time grid size — a pin's index domain [0, N−1]
const PIN_HIT_R = 8; // fat transparent hit-zone (theatre GraphEditorDotScalar)
const PIN_DOT_R = 3; // thin visible dot
const EDITOR_FLIP_PX = 48; // pin nearer the top than this → editor opens below it
const HANDLE_HIT_R = 7; // tangent-handle fat hit-zone
const HANDLE_NUB_R = 2.5; // thin handle nub
// the drawn constraint curve — cool blue, distinct from the warm-orange solved
// result so "what you drew" reads apart from "what the solver produced".
const CON_COLOR = "rgba(120, 175, 205, 0.9)";

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

// total draft-time seconds — the X-axis domain. grid index i ↔ sec (i/(N-1))·tTotal.
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
    return sampleFNOverTime(eid, OPT_GRID);
});
const solved = $derived.by((): Float32Array | null => {
    void tick;
    if (eid === null) return null;
    return solveOut.get(eid)?.fN ?? null;
});
// the cart's draft-time second. `u` is its grid-fraction on the realized track;
// u·tTotal is its draft-second only because the axis samples at OPT_GRID.
const cartSec = $derived.by((): number | null => {
    void tick;
    if (eid === null) return null;
    const st = cartState.get(eid);
    if (!st) return null;
    const u = cartPose(eid, st.t)?.u;
    return u == null ? null : u * tTotal;
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

// ── pin authoring + gesture state. declared up here because the value-axis ease
// reads `manipulating`. double-click adds a pin, drag moves it (live re-solve),
// double-click a pin edits its value, right-click / Del deletes. routed through undo.
let dragId: number | null = null;
let dragMoved = false;
let editing = $state<{ id: number; x: number; y: number } | null>(null);
let editVal = $state(0);
let hoverId = $state<number | null>(null);
let hDrag = $state<{ id: number; side: "l" | "r" } | null>(null);
let selectedId = $state<number | null>(null); // the clicked pin: handles stay shown
let manipulating = $state(false); // a pin/handle drag is in flight
let dragCx = 0; // last cursor in chart space — the per-frame edge-grow re-maps it
let dragCy = 0;

// the auto-fit g-range *target*: scans the solved curve, the baked dots, the pin
// values AND their tangent-handle control points (handles are first-class points for
// scaling — the After Effects rule — so a handle can never settle off-screen). always
// keeps 1g; `yView` (below) eases toward this — the target itself is never drawn.
const yTarget = $derived.by((): YFit => {
    void tick;
    let lo = Y_BASE;
    let hi = Y_BASE;
    const at = (v: number): void => {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
    };
    const scan = (a: Float32Array | null): void => {
        if (!a) return;
        for (let i = 0; i < a.length; i++) at(a[i]);
    };
    scan(solved);
    scan(fN);
    if (eid !== null)
        for (const p of pinsOf(eid)) {
            at(p.value);
            at(p.value + p.hl.dy); // the handle nubs scale the axis too
            at(p.value + p.hr.dy);
        }
    return yFit(lo, hi, Y_BASE);
});

// the *displayed* g-range. `yTarget` is a stable default frame that only expands to
// fit data (it never hugs tight), and `yView` approaches it ASYMMETRICALLY: it grows
// fast and contracts lazily — the AE/Unity "grow when content needs it, never snap
// back" feel, smoothed for the web. While a pin/handle is dragged the axis holds
// steady (no jitter from the live re-solve, and grabbing a near-edge keyframe doesn't
// move it) UNTIL the cursor is dragged PAST the chart edge, where `yGrow` edge-scrolls
// to follow (speed ∝ distance past the edge, applied per frame).
let yView: YFit = $state({ lo: CAP_LO, hi: CAP_HI, step: 1 });
let yInit = false;
const Y_OUT = 0.3; // per-frame approach when EXPANDING the view (snappy)
const Y_IN = 0.05; // per-frame approach when CONTRACTING (lazy — no snap-back)
const EDGE_RATE = 0.2; // edge-scroll speed (∝ distance past the edge); a by-eye feel constant
// a pin clamps to CAP, so its edge-grow caps there; a tangent handle authors overshoot
// PAST the band, so its edge-grow follows further before it stops.
const HANDLE_CAP: [number, number] = [-8, 12];
$effect(() => {
    void tick; // the ONLY dependency: one run per animation frame
    // everything else is untracked — the body reads + writes yView and calls the
    // drag appliers (which read yView via valOf), so a tracked read would make the
    // effect depend on its own write and loop. tick alone paces it.
    untrack(() => {
        const t = yTarget;
        const cur = yView;
        if (!yInit) {
            yView = t; // first valid range appears instantly, no ease-in from CAP
            yInit = true;
            return;
        }
        if (manipulating) {
            // edge-scroll grow-to-follow: stable until the cursor is dragged past the
            // chart edge. a handle follows past CAP (overshoot is authorable); a pin caps at CAP.
            const cap = dragId !== null ? CAP : HANDLE_CAP;
            const grown = yGrow(cur, dragCy, TOP, h - BOT_PAD, EDGE_RATE, cap);
            if (grown !== cur) {
                yView = grown;
                applyDrag(); // re-map the held cursor through the grown axis → element follows
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
// inverse of yOf: screen-Y → force value (for placing / dragging pins).
const valOf = (py: number): number =>
    yView.lo + (1 - (py - TOP) / (h - BOT_PAD - TOP)) * (yView.hi - yView.lo);

// pin draft-time grid index ↔ screen-X, value ↔ screen-Y. screen-X insets past the
// gutter; value clamps to the stable CAP (not yView, or a drag would move the clamp).
const pxOfIndex = (i: number): number => LEFT_GUT + secToPx(clamped, (i / (N - 1)) * tTotal);
const indexAt = (px: number): number =>
    clamp(Math.round((pxToSec(clamped, px - LEFT_GUT) / tTotal) * (N - 1)), 0, N - 1);
const valAt = (py: number): number => clamp(valOf(py), CAP_LO, CAP_HI);

// authored force pins, projected to screen space — the draggable pin dots.
const pinView = $derived.by((): { id: number; x: number; y: number }[] => {
    void tick;
    if (eid === null || tTotal <= 0) return [];
    return pinsOf(eid).map((p) => ({ id: p.id, x: pxOfIndex(p.index), y: yOf(p.value) }));
});

// the pins sorted by draft-time index — the constraint curve and the handle
// neighbor lookup walk them in time order (the store keeps insertion order).
const sortedPins = $derived.by((): Pin[] => {
    void tick;
    if (eid === null || tTotal <= 0) return [];
    return [...pinsOf(eid)].sort((a, b) => a.index - b.index || a.id - b.id);
});

// the pin whose tangent handles are emphasized (all pins' handles always show; this
// brightens one): edited, mid-handle-drag, the selected one (persists after a click),
// or the hovered one.
const activeId = $derived(editing?.id ?? hDrag?.id ?? selectedId ?? hoverId);

// every pin's two tangent handles in screen space, always shown (After Effects keeps
// keyframe tangents visible). a handle's length basis is the segment on that side;
// an endpoint borrows its one adjacent segment so BOTH handles exist (the outer one
// has no curve to bend but, in auto mode, rotating it steers the shared tangent). the
// active pin's handles draw brighter. spans come from `spanOf`, shared with the drag.
type HandleV = { id: number; side: "l" | "r"; x0: number; y0: number; x: number; y: number; active: boolean };
// a handle's length basis = the gap to the neighbor on that side. with no neighbor on
// either side (an endpoint's outer side, or a lone pin), fall back to DEFAULT_SPAN so
// the handles ALWAYS exist — no pin-count branch that hides them.
const DEFAULT_SPAN = N * 0.12; // index units
function spanOf(i: number, side: "l" | "r"): number {
    const pins = sortedPins;
    const near = side === "r" ? i + 1 : i - 1; // the neighbor this side prefers
    const far = side === "r" ? i - 1 : i + 1; // the other neighbor, borrowed at an endpoint
    if (near >= 0 && near < pins.length) return Math.abs(pins[near].index - pins[i].index);
    if (far >= 0 && far < pins.length) return Math.abs(pins[far].index - pins[i].index);
    return DEFAULT_SPAN; // lone pin
}
const handleView = $derived.by((): HandleV[] => {
    void tick;
    if (eid === null || tTotal <= 0) return [];
    const pins = sortedPins;
    const out: HandleV[] = [];
    for (let i = 0; i < pins.length; i++) {
        const p = pins[i];
        const x0 = pxOfIndex(p.index);
        const y0 = yOf(p.value);
        const active = p.id === activeId;
        const spanR = spanOf(i, "r");
        const spanL = spanOf(i, "l");
        if (spanR > 0)
            out.push({ id: p.id, side: "r", x0, y0, x: pxOfIndex(p.index + p.hr.dx * spanR), y: yOf(p.value + p.hr.dy), active });
        if (spanL > 0)
            out.push({ id: p.id, side: "l", x0, y0, x: pxOfIndex(p.index - p.hl.dx * spanL), y: yOf(p.value + p.hl.dy), active });
    }
    return out;
});

// clear selection + close any open editor — a single click on empty chart.
function deselect(): void {
    editCommit();
    selectedId = null;
}

// ── middle-button drag pans the view. intercepted at the host's capture phase so it
// fires before the pointer-events:all SVG rects; each rect handler also routes a
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

// empty chart: a single left-click deselects; a double-click adds a pin (Unity / AE
// curve-editor convention — deliberate, never a misfire on a single press).
function chartDown(e: PointerEvent): void {
    if (e.button === 1) {
        panDown(e);
        return;
    }
    if (e.button !== 0) return; // right → oncontextmenu (host suppresses the menu)
    deselect();
}
function chartAdd(e: MouseEvent): void {
    if (eid === null || tTotal <= 0) return;
    e.preventDefault();
    editCommit(); // close any open editor first (preventDefault suppresses its blur)
    const rect = host.getBoundingClientRect();
    const index = indexAt(e.clientX - rect.left);
    // drop ON the curve at the clicked time, not at the cursor's height: pin the value
    // the user sees (the solved curve, or the baked draft), so the add doesn't jolt the
    // shape — they nudge it from there. cursor height is only the fallback (no curve yet).
    const onCurve = solved ?? fN;
    const v = onCurve && index < onCurve.length ? onCurve[index] : valAt(e.clientY - rect.top);
    const pin = drop(history, eid, index, clamp(v, CAP_LO, CAP_HI));
    selectedId = pin.id; // select the new pin so its handles show
}

// delete a pin (right-click or Del), dropping an open edit gesture on it first.
function deletePin(id: number): void {
    if (eid === null) return;
    if (editing?.id === id) {
        cancel();
        editing = null;
    }
    erase(history, eid, id);
    if (selectedId === id) selectedId = null;
}

function pinDown(e: PointerEvent, id: number): void {
    if (eid === null) return;
    if (e.button === 1) {
        panDown(e); // middle pans even when starting on a pin
        return;
    }
    if (e.button !== 0) return; // right → oncontextmenu deletes
    e.preventDefault();
    e.stopPropagation(); // not a chart click
    editCommit(); // close any open editor first (preventDefault suppresses its blur)
    dragId = id;
    dragMoved = false;
    trackCursor(e); // seed the cursor so a pre-move frame doesn't read a stale edge
    manipulating = true; // steady axis until the cursor hits an edge (then grow-follow)
    beginPin(eid, id); // open the gesture; commit/cancel on release
    window.addEventListener("pointermove", pinDrag);
    window.addEventListener("pointerup", pinUp);
}
// the active drag's screen→data application, factored out of the pointermove so the
// per-frame edge-grow can re-run it against the held cursor as the axis follows.
function trackCursor(e: PointerEvent): void {
    const rect = host.getBoundingClientRect();
    dragCx = e.clientX - rect.left;
    dragCy = e.clientY - rect.top;
}
function applyDrag(): void {
    if (dragId !== null) applyPinDrag();
    else if (hDrag !== null) applyHandleDrag();
}
function pinDrag(e: PointerEvent): void {
    trackCursor(e);
    applyDrag();
}
function applyPinDrag(): void {
    if (eid === null || dragId === null) return;
    // clamp the cursor Y to the chart so the pin sticks to the edge (the edge-scroll
    // grows the axis from there) rather than overflowing off the dock — same as a handle.
    setPin(eid, dragId, indexAt(dragCx), valAt(clamp(dragCy, TOP, h - BOT_PAD)));
    dragMoved = true;
}
function pinUp(): void {
    window.removeEventListener("pointermove", pinDrag);
    window.removeEventListener("pointerup", pinUp);
    manipulating = false; // release the axis (it re-fits smoothly toward the target)
    const id = dragId;
    dragId = null;
    if (id === null) return;
    if (dragMoved) commit(history); // one drag → one undo entry
    else {
        cancel(); // a no-move click: discard the empty gesture, just select
        selectedId = id;
    }
}
// double-click a pin to type a precise value (the standard "double-click to edit",
// distinct from a single click which only selects).
function pinDblClick(id: number): void {
    selectedId = id;
    openEditor(id);
}

// ── tangent-handle drag: X-clamped to the segment (function-of-time), Y free in
// g (overshoot), live re-solve, commit-on-release. routed through the same gesture
// history as a pin drag.
function handleDown(e: PointerEvent, id: number, side: "l" | "r"): void {
    if (eid === null) return;
    if (e.button === 1) {
        panDown(e);
        return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation(); // not a pin drag / chart click
    editCommit(); // close any open editor first
    hDrag = { id, side };
    trackCursor(e); // seed the cursor so a pre-move frame doesn't read a stale edge
    manipulating = true; // steady axis until the cursor hits an edge (then grow-follow)
    beginPin(eid, id); // gesture: commit/cancel on release
    window.addEventListener("pointermove", handleDrag);
    window.addEventListener("pointerup", handleUp);
}
function handleDrag(e: PointerEvent): void {
    trackCursor(e);
    applyDrag();
}
function applyHandleDrag(): void {
    if (eid === null || hDrag === null) return;
    const pins = sortedPins;
    const i = pins.findIndex((p) => p.id === hDrag?.id);
    if (i < 0) return;
    const p = pins[i];
    const x0 = pxOfIndex(p.index);
    const y0 = yOf(p.value);
    // each side's screen reach (pin → where dx=1 lands); endpoints borrow their one
    // adjacent segment via spanOf, so both handles are draggable.
    const reachR = pxOfIndex(p.index + spanOf(i, "r")) - x0;
    const reachL = x0 - pxOfIndex(p.index - spanOf(i, "l"));
    const dReach = hDrag.side === "r" ? reachR : reachL;
    if (dReach <= 0) return;
    // clamp the cursor Y to the chart: the nub sticks to the edge instead of flying
    // off the dock, and the edge-grow ($effect) drives its value past the band while
    // it's held there — so a handle is never dragged out of reach.
    const cy = clamp(dragCy, TOP, h - BOT_PAD);
    // the dragged handle follows the cursor: x clamped to [0,1] of its segment (keeps
    // it a function of time), y via valOf (overshoot grows the axis, not off-screen).
    const ddx = clamp(hDrag.side === "r" ? (dragCx - x0) / reachR : (x0 - dragCx) / reachL, 0, 1);
    setHandle(eid, hDrag.id, hDrag.side, ddx, valOf(cy) - p.value);

    // auto/continuous mode (After Effects default): mirror the OTHER handle to the
    // opposite screen direction, preserving its own length (free lengths) — a smooth
    // tangent through the pin. collinearity is affine-invariant, so screen space = ok.
    const oReach = hDrag.side === "r" ? reachL : reachR;
    if (oReach <= 0) return;
    const other: "l" | "r" = hDrag.side === "r" ? "l" : "r";
    const oh = other === "r" ? p.hr : p.hl;
    const vx = hDrag.side === "r" ? ddx * reachR : -ddx * reachL; // dragged screen vector
    const vy = cy - y0;
    const ox = other === "r" ? oh.dx * reachR : -oh.dx * reachL; // other handle's length
    const oy = yOf(p.value + oh.dy) - y0;
    const m = mirrorTangent(vx, vy, Math.hypot(ox, oy)); // opposite dir, same length
    if (!m) return; // dragged vector had no direction
    const odx = clamp(other === "r" ? m.x / reachR : -m.x / reachL, 0, 1);
    setHandle(eid, hDrag.id, other, odx, valOf(y0 + m.y) - p.value);
}
function handleUp(): void {
    window.removeEventListener("pointermove", handleDrag);
    window.removeEventListener("pointerup", handleUp);
    manipulating = false; // release the axis
    if (hDrag === null) return;
    hDrag = null;
    commit(history); // a handle drag always intends an edit; commit no-ops if unchanged
}

function openEditor(id: number): void {
    if (eid === null) return;
    const pin = findPin(eid, id);
    const p = pinView.find((q) => q.id === id);
    if (!pin || !p) return;
    editVal = Math.round(pin.value * 100) / 100; // the stored value is a long float
    editing = { id, x: p.x, y: p.y };
    beginPin(eid, id); // edits are a gesture too (live preview, commit on close)
}
function editLive(): void {
    if (eid === null || editing === null || !Number.isFinite(editVal)) return;
    const pin = findPin(eid, editing.id);
    if (pin) setPin(eid, editing.id, pin.index, clamp(editVal, CAP_LO, CAP_HI));
}
function editCommit(): void {
    if (editing === null) return;
    commit(history);
    editing = null;
}
function editCancel(): void {
    if (editing === null) return;
    cancel(); // restore the pre-edit value
    editing = null;
}
function editorKey(e: KeyboardEvent): void {
    e.stopPropagation(); // typing never reaches the timeline shortcuts
    if (e.key === "Enter") {
        e.preventDefault();
        editCommit();
    } else if (e.key === "Escape") {
        e.preventDefault();
        editCancel();
    }
}
function autofocus(node: HTMLInputElement): void {
    node.focus();
    node.select();
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

    // force band limits — drawn only when within the visible range
    ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
    ctx.lineWidth = 1;
    for (const lim of DEFAULT_BAND) {
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

    // baked F_n draft dots
    if (fN) {
        ctx.fillStyle = "rgba(205, 197, 188, 0.55)";
        const n = fN.length;
        for (let i = 0; i < n; i++) {
            const x = LEFT_GUT + secToPx(v, (i / (n - 1)) * tTotal);
            if (x < LEFT_GUT - 2 || x > w + 2) continue;
            ctx.beginPath();
            ctx.arc(x, yOf(fN[i]), 1.5, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // the drawn constraint curve: the piecewise bezier through the pins (≥2). drawn
    // with native bezierCurveTo on the screen-mapped control points — pxOfIndex /
    // yOf are affine, so the screen cubic equals the value-space cubic exactly.
    const cpins = sortedPins;
    if (cpins.length >= 2) {
        ctx.strokeStyle = CON_COLOR;
        ctx.lineWidth = 1.2;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(pxOfIndex(cpins[0].index), yOf(cpins[0].value));
        for (let s = 0; s < cpins.length - 1; s++) {
            const a = cpins[s];
            const b = cpins[s + 1];
            const span = b.index - a.index;
            if (span <= 0) {
                ctx.moveTo(pxOfIndex(b.index), yOf(b.value)); // skip a zero-width segment
                continue;
            }
            ctx.bezierCurveTo(
                pxOfIndex(a.index + a.hr.dx * span),
                yOf(a.value + a.hr.dy),
                pxOfIndex(b.index - b.hl.dx * span),
                yOf(b.value + b.hl.dy),
                pxOfIndex(b.index),
                yOf(b.value),
            );
        }
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // solved F_n curve — accent: the canonical result the cart rides
    if (solved) {
        ctx.strokeStyle = "rgb(212, 149, 96)";
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        const n = solved.length;
        for (let i = 0; i < n; i++) {
            const x = LEFT_GUT + secToPx(v, (i / (n - 1)) * tTotal);
            const y = yOf(solved[i]);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }

    ctx.restore();
}

// the navigator preview (VSCode-minimap / DAW-overview style): a faint miniature of
// the whole solved F_n curve across the full track, so the viewport bracket reads
// against the curve's shape. y-range tracks the chart's `yView`; the curve occupies
// only [0, tTotal] of the width (the lead-out margin stays empty).
function renderNav(nav: CanvasRenderingContext2D, cw: number, ch: number): void {
    nav.clearRect(0, 0, cw, ch);
    const data = solved ?? fN;
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
    const u = tTotal > 0 ? clamp(sec / tTotal, 0, 1) : 0;
    const t = cartTimeAtU(eid, u);
    const st = cartState.get(eid);
    if (st && t !== null) st.t = t;
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

// ── player slider: the full-track scrubber. drag maps screen-X → grid-fraction →
// realized time (same bridge as the timeline grip, but global, not view-relative).
// holding while dragging freezes the cart; release restores the pre-grab play state
// (grab while paused stays paused — the media-player convention).
let scrubEl: HTMLDivElement;
let sliding = false;
let sliderResume = false;
function sliderTo(e: PointerEvent): void {
    if (eid === null || !sliding) return;
    const rect = scrubEl.getBoundingClientRect();
    const u = rect.width > 0 ? clamp((e.clientX - rect.left) / rect.width, 0, 1) : 0;
    const t = cartTimeAtU(eid, u);
    const st = cartState.get(eid);
    if (st && t !== null) st.t = t;
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
    const u = clamp(((cartSec ?? 0) + d) / tTotal, 0, 1);
    const t = cartTimeAtU(eid, u);
    if (t !== null) {
        st.held = true; // stepping pauses, like a frame-step
        st.t = t;
    }
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
    const onKey = (e: KeyboardEvent): void => {
        const t = e.target as HTMLElement | null;
        const inField =
            !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
        if (inField) return; // let the field own its keys (incl. native text undo)
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
        if ((e.key === "Delete" || e.key === "Backspace") && selectedId !== null) {
            e.preventDefault();
            e.stopImmediatePropagation(); // not a track-node trim (controls.ts also binds Del)
            deletePin(selectedId);
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
        window.removeEventListener("pointermove", pinDrag);
        window.removeEventListener("pointerup", pinUp);
        window.removeEventListener("pointermove", handleDrag);
        window.removeEventListener("pointerup", handleUp);
    };
});
</script>

<aside class="dock">
    <!-- leaving the dock clears the hover emphasis (the selected pin keeps its bright
         handles); pointerleave on the dock, not the chart, so the dot→nub travel
         doesn't drop it mid-reach. -->
    <div
        class="body"
        bind:this={host}
        bind:clientWidth={w}
        bind:clientHeight={h}
        onpointerleave={() => (hoverId = null)}
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
            <!-- the chart force band: double-click drops a pin, single click
                 deselects (Unity/AE convention). the ruler (above) owns scrubbing.
                 below the pins + grip in DOM, so those take the pointer when hit. -->
            {#if eid !== null && tTotal > 0}
                <rect
                    class="dropzone"
                    x={LEFT_GUT}
                    y={TOP}
                    width={chartW}
                    height={Math.max(0, h - BOT_PAD - TOP)}
                    onpointerdown={chartDown}
                    ondblclick={chartAdd}
                    role="presentation"
                />
                <!-- the scrub zone: the whole ruler + gap band. click/drag anywhere
                     here moves the playhead (the time ruler is the scrubber). -->
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
            {#each pinView as p (p.id)}
                <circle
                    class="pin-hit"
                    cx={p.x}
                    cy={p.y}
                    r={PIN_HIT_R}
                    onpointerdown={(e) => pinDown(e, p.id)}
                    ondblclick={() => pinDblClick(p.id)}
                    onpointerenter={() => (hoverId = p.id)}
                    oncontextmenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        deletePin(p.id);
                    }}
                    role="button"
                    tabindex="-1"
                    aria-label="Force pin"
                />
                <circle
                    class="pin-dot"
                    class:selected={p.id === selectedId}
                    cx={p.x}
                    cy={p.y}
                    r={PIN_DOT_R}
                />
            {/each}
            <!-- every pin's tangent handles (always shown, auto/continuous mode): a stem
                 to a grabbable nub. the active pin's draw brighter; the rest sit quiet so
                 the chart isn't busy. above the pins in DOM so the nub takes the pointer. -->
            {#each handleView as hd (hd.id + hd.side)}
                <line class="handle-stem" class:active={hd.active} x1={hd.x0} y1={hd.y0} x2={hd.x} y2={hd.y} />
                <circle
                    class="handle-hit"
                    cx={hd.x}
                    cy={hd.y}
                    r={HANDLE_HIT_R}
                    onpointerdown={(e) => handleDown(e, hd.id, hd.side)}
                    onpointerenter={() => (hoverId = hd.id)}
                    role="button"
                    tabindex="-1"
                    aria-label="Tangent handle"
                />
                <circle class="handle-nub" class:active={hd.active} cx={hd.x} cy={hd.y} r={HANDLE_NUB_R} />
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
        {#if editing}
            <!-- flip below the pin when it sits too near the top to clear the dock
                 (overflow is hidden), so high-g pins' editors aren't clipped. -->
            <div
                class="pin-editor"
                style="left: {editing.x}px; top: {editing.y}px; transform: translate(-50%, {editing.y <
                EDITOR_FLIP_PX
                    ? 'calc(100% + 10px)'
                    : 'calc(-100% - 10px)'});"
            >
                <input
                    type="number"
                    step="0.1"
                    bind:value={editVal}
                    oninput={editLive}
                    onkeydown={editorKey}
                    onblur={editCommit}
                    use:autofocus
                    aria-label="Pin force (g)"
                />
                <span class="unit">g</span>
            </div>
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

<!-- the player: a standard media transport (play/pause · global scrub · timecode)
     floated as its own surface below the timeline. the slider is the *full-track*
     scrubber — global scope, distinct from the timeline's zoomed-local playhead
     (the After Effects comp-vs-timeline split). controls the cart; authoring lives
     in the timeline above. -->
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

    /* chart surface: double-click adds a pin, single click deselects. default
       cursor (the editor-ruler convention — not a crosshair; add is deliberate). */
    .dropzone {
        fill: transparent;
        pointer-events: all;
        cursor: default;
    }

    /* fat transparent hit-zone over a thin visible dot (theatre pattern). `move`
       (4-way) is the graph-editor standard for a point dragged in x+y — not `grab`,
       which is the canvas-panning hand. */
    .pin-hit {
        fill: transparent;
        pointer-events: all;
        cursor: move;
    }
    .pin-dot {
        fill: var(--pin);
        stroke: var(--bg-solid);
        stroke-width: 1;
        pointer-events: none;
    }
    .pin-hit:hover + .pin-dot {
        r: 5;
    }
    /* the selected pin reads brighter + ringed, distinct from a plain hover */
    .pin-dot.selected {
        r: 4.5;
        stroke: var(--fg);
        stroke-width: 1.5;
    }

    /* tangent handle: a thin stem to a grabbable nub, in the drawn-curve blue. all
       pins' handles show, so the inactive ones stay quiet; the active pin's brighten. */
    .handle-stem {
        stroke: rgba(120, 175, 205, 0.28);
        stroke-width: 1;
        pointer-events: none;
    }
    .handle-stem.active {
        stroke: rgba(120, 175, 205, 0.6);
    }
    .handle-hit {
        fill: transparent;
        pointer-events: all;
        cursor: move;
    }
    .handle-nub {
        fill: rgba(120, 175, 205, 0.5);
        stroke: var(--bg-solid);
        stroke-width: 1;
        pointer-events: none;
    }
    .handle-nub.active {
        fill: rgba(120, 175, 205, 0.95);
    }
    .handle-hit:hover + .handle-nub {
        r: 4;
        fill: rgba(120, 175, 205, 0.95);
    }

    /* inline value editor — a single clean numeric field anchored at the pin (delete
       is right-click / Del, so no in-popup chrome). a small notch ties it to the pin. */
    .pin-editor {
        position: absolute;
        display: flex;
        align-items: baseline;
        gap: 1px;
        padding: 5px 8px;
        background: var(--bg-solid);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 6px;
        box-shadow: var(--shadow);
        z-index: 3;
    }
    .pin-editor input {
        all: unset;
        width: 40px;
        font-family: "JetBrains Mono", ui-monospace, monospace;
        font-size: 12px;
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.02em;
        color: var(--fg);
        text-align: right;
        -moz-appearance: textfield;
        appearance: textfield;
    }
    /* hide the native number spinners — they read as clunky web chrome */
    .pin-editor input::-webkit-outer-spin-button,
    .pin-editor input::-webkit-inner-spin-button {
        -webkit-appearance: none;
        margin: 0;
    }
    .pin-editor .unit {
        font-family: "JetBrains Mono", ui-monospace, monospace;
        font-size: 11px;
        color: var(--muted);
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
       row is a fat hit area over a 3px rail (the same fat-zone/thin-mark pattern as
       the pins). */
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
