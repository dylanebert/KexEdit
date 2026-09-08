<script lang="ts">
import type { State } from "@dylanebert/shallot";
import { onMount } from "svelte";
import {
    cartArc,
    cartState,
    holdForGesture,
    parkAtArc,
    parkFromTime,
    releaseGesture,
    trackMapping,
} from "./cart";
import { COLOR_GUIDE_RAY, laneTone } from "./colors";
import { editor, beginDrag, clearSelection, endDrag, selectRecord, toggleRecord } from "./editor";
import { addRecord, beginBody, beginEdge, beginEnd, cancel, commit, history, redo as redoHistory, removeRecord, undo as undoHistory } from "./history";
import { Lane, RECORD_FLOOR, type LaneSegment } from "./lanes";
import { BINDINGS, bound } from "./menu";
import { timelineKeyAct } from "./keys";
import {
    clampSpanDrag,
    COLUMN_W,
    clampView,
    defaultHandle,
    endHandle,
    frameAll,
    hitEndHandle,
    hitRows,
    laneRows,
    type LaneRow,
    marginArc,
    recordEntry,
    type RowHit,
    ROW_H,
    S_GRID,
    snapAxis,
    spanBoxes,
    spanCurve,
    spanTargets,
    ticks,
    timeToArc,
    uToPx,
    pxToU,
    type View,
    zoomAt,
} from "./timeline";
import { bakeOut, endColumn, lanesOf, laneOrderOf, setEnd, setRecordSpan, Track, trackEndOf } from "./track";
import { DOCK_HEIGHT, DOCK_INSET, PLAYER_GAP, PLAYER_H, resize } from "./view";

/** The lane timeline (spec `kex2d-segment-gestures` S3b): one row per authored lane on a shared
 *  arclength ruler, BEHIND a left lane column that names each row by its authored quantity —
 *  Animate's layer column plus its tween-span grammar over the lane substrate (Locked decision,
 *  "timeline layout follows Animate"). A span fills its row's height and carries no chips: the
 *  person's first look read the chip band as busy and unreadable and the rows as starved of
 *  height, so the value labels came off and a small unlabeled curve of the record's own easing
 *  went inside instead (check-in two, points 1, 2, 4, 10, 11).
 *
 *  The row model is `timeline.ts`'s: `laneRows` lays the rows out in `track.order`, `spanBoxes`
 *  projects each record's own stations through the view past the column's inset, `hitRows`
 *  answers one press, `clampSpanDrag` floors a drag at the ruler's origin and `spanTargets`
 *  feeds `snapAxis` the landmark pool. This component owns pixels and pointers and NOTHING else
 *  — every authored write goes through a `history.ts` gesture over a `track.ts` setter
 *  (`beginEdge`/`beginBody` + `setRecordSpan`, `beginEnd` + `setEnd`, `addRecord`,
 *  `removeRecord`), written every frame so the drag projects through the bake as it happens, and
 *  coalesced into one undo entry on release. A refused span simply doesn't move: the setter
 *  declines and the next frame redraws the record where it still is.
 *
 *  The playhead reads and never edits (`editor-ui.md`: scrub never authors), and a live span or
 *  end gesture HOLDS it at its own ruler station for the gesture's duration
 *  (`cart.holdForGesture`), restoring the playing state on release — a re-timing drag must not
 *  move the thing the person is watching (check-in two, point 8). */

const { ecs, eid, tick }: { ecs: State; eid: number | null; tick: number } = $props();

// ── chart geometry ────────────────────────────────────────────────────────────
const RULER_H = 26; // the shared arclength ruler
const ROWS_TOP = RULER_H + 6;
const BOT_PAD = 8;
const ZOOM_DIV = 200; // wheel-delta → geometric zoom rate
const CURVE_PAD = 4; // the miniature curve's inset from its span's top and bottom edges

let canvas: HTMLCanvasElement;
let dockW = $state(0);
let view = $state<View>({ pan: 0, pxPerU: 0 });
let framed = false;
let hover = $state<RowHit>(null);
let onEnd = $state(false);
/** the standing snap preference — landmarks + grid, default ON, toggled by `S` and inverted for
 *  one drag by Ctrl/Cmd (the AE magnet model, `editor-ui.md`). */
let snapping = $state(true);
/** the guide px a live drag's landmark hit flashes, or null (the grid is ambient, no flash). */
let guide = $state<number | null>(null);

const chartW = $derived(Math.max(0, dockW - COLUMN_W));

// the authored document, re-read each published frame (`tick`) — the rows are AUTHORED state,
// unlike the retired read-only dock, which read only the bake.
const doc = $derived.by(() => {
    void tick;
    if (eid === null) return null;
    return { lanes: lanesOf(ecs), order: laneOrderOf(ecs), end: endColumn(ecs), total: trackEndOf(ecs) };
});
const rows = $derived(doc ? laneRows(doc.lanes, doc.order, ROWS_TOP) : []);
const sTotal = $derived(doc?.total ?? 0);
const mFloor = $derived(marginArc(sTotal, 50));
const clamped = $derived(clampView(view, chartW, sTotal, mFloor));
const endH = $derived(doc ? endHandle(doc.lanes, doc.end, clamped, COLUMN_W) : null);
// the selected set, re-read per frame: `editor` is a plain singleton with no invalidation of its
// own, so the tick is what republishes it (the module's own docblock).
const selectedIds = $derived.by((): Set<number> => {
    void tick;
    return editor.records.ids;
});

// ── the transport (the cart's clock, not the document's) ──────────────────────
const tTotal = $derived.by(() => {
    void tick;
    if (eid === null) return 0;
    const out = bakeOut.get(eid);
    const n = Track.count.get(eid);
    return out && n >= 1 ? (out.t[n - 1] ?? 0) : 0;
});
const cartSec = $derived.by(() => {
    void tick;
    return eid === null ? null : (cartState.get(eid)?.t ?? null);
});
const paused = $derived.by(() => {
    void tick;
    return eid === null ? true : (cartState.get(eid)?.held ?? true);
});
const frac = $derived(tTotal > 0 ? Math.min(1, Math.max(0, (cartSec ?? 0) / tTotal)) : 0);
const playheadS = $derived.by(() => {
    void tick;
    if (eid === null) return null;
    const arc = cartArc(eid);
    if (arc !== null) return arc;
    const m = trackMapping(eid);
    return m && cartSec !== null ? timeToArc(m, cartSec) : null;
});

const clamp = (x: number, lo: number, hi: number): number => Math.min(Math.max(x, lo), hi);

// ── render ────────────────────────────────────────────────────────────────────
const xOf = (s: number): number => COLUMN_W + uToPx(clamped, s);

/** one lane row: its band, the column cell naming it, and its spans in the lane color at the rung
 *  their state names — a gap draws nothing, because a gap is the lane's inferred value, not a
 *  record the person authored. */
function drawRow(ctx: CanvasRenderingContext2D, row: LaneRow): void {
    const base = laneTone(row.lane, "base");
    ctx.fillStyle = "rgba(0, 0, 0, 0.24)";
    ctx.fillRect(COLUMN_W, row.top, chartW, ROW_H);

    // the column cell: the row's ONE label, in its own lane color (check-in two, points 2 and 10).
    ctx.fillStyle = "rgba(255, 255, 255, 0.03)";
    ctx.fillRect(0, row.top, COLUMN_W, ROW_H);
    ctx.fillStyle = base;
    ctx.font = '11px "IBM Plex Sans", system-ui, sans-serif';
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(row.name, 10, row.top + ROW_H / 2 + 0.5);

    for (const box of spanBoxes(row, clamped, COLUMN_W)) {
        const rec = row.records.find((r) => r.id === box.id) as LaneSegment;
        const w = Math.max(1, box.x1 - box.x0);
        const tone = selectedIds.has(box.id)
            ? "selected"
            : hover?.kind !== "gap" && hover?.kind !== "column" && hover?.id === box.id
              ? "hover"
              : "base";
        const color = laneTone(row.lane, tone);
        // the span fills the whole row band now — no chip band above it.
        ctx.globalAlpha = tone === "base" ? 0.34 : 0.5;
        ctx.fillStyle = color;
        ctx.fillRect(box.x0, box.y0, w, ROW_H);
        ctx.globalAlpha = 1;
        // the two handles: a solid grip at each end, the span's own two authored stations.
        ctx.fillStyle = color;
        ctx.fillRect(box.x0, box.y0, 2, ROW_H);
        ctx.fillRect(box.x1 - 2, box.y0, 2, ROW_H);
        // the miniature curve: the record's own easing, unlabeled, drawn solid under the
        // kind-color law so a span conveys its shape without a chip.
        const pts = spanCurve(rec, recordEntry(doc!.lanes, row.lane, rec), box, CURVE_PAD);
        if (w > 3) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(box.x0, box.y0, w, ROW_H);
            ctx.clip();
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            for (let i = 0; i < pts.length; i++) {
                const pt = pts[i]!;
                if (i === 0) ctx.moveTo(pt.x, pt.y);
                else ctx.lineTo(pt.x, pt.y);
            }
            ctx.stroke();
            ctx.restore();
        }
    }
}

function render(ctx: CanvasRenderingContext2D): void {
    ctx.clearRect(0, 0, dockW, DOCK_HEIGHT);

    // the ruler band and its 1-2-5 ticks — clipped to the CHART, so the 0 tick sits inside the
    // plot rather than on its cut edge (check-in two, point 4).
    ctx.fillStyle = "rgba(255, 255, 255, 0.04)";
    ctx.fillRect(COLUMN_W, 0, chartW, RULER_H);
    ctx.save();
    ctx.beginPath();
    ctx.rect(COLUMN_W, 0, chartW, RULER_H);
    ctx.clip();
    ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const tk of ticks(clamped, chartW)) {
        const px = COLUMN_W + tk.px;
        ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
        ctx.beginPath();
        ctx.moveTo(px, RULER_H - 6);
        ctx.lineTo(px, RULER_H);
        ctx.stroke();
        ctx.fillStyle = "rgba(160, 152, 144, 0.8)";
        ctx.fillText(tk.label, px, 8);
    }
    ctx.restore();

    for (const row of rows) drawRow(ctx, row);

    // the lane column's own edge — the one hairline separating the annotation from the chart.
    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.beginPath();
    ctx.moveTo(COLUMN_W + 0.5, 0);
    ctx.lineTo(COLUMN_W + 0.5, DOCK_HEIGHT);
    ctx.stroke();

    // the end handle: a pinned end draws solid, a following one hollow — the number is authored
    // in the first case and read off the longest lane in the second.
    if (endH) {
        ctx.strokeStyle = endH.pinned ? "#ece8e3" : "rgba(236, 232, 227, 0.45)";
        ctx.lineWidth = onEnd ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(endH.px, 0);
        ctx.lineTo(endH.px, DOCK_HEIGHT - BOT_PAD);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(endH.px - 5, 0);
        ctx.lineTo(endH.px, 8);
        ctx.lineTo(endH.px + 5, 0);
        ctx.closePath();
        if (endH.pinned) {
            ctx.fillStyle = "#ece8e3";
            ctx.fill();
        } else ctx.stroke();
    }

    // the snap guide: neutral gray, drawn ONLY under a live drag that hit a landmark
    // (`editor-ui.md`: guides are a gesture affordance, never standing chrome).
    if (guide !== null) {
        ctx.strokeStyle = COLOR_GUIDE_RAY;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(guide + 0.5, 0);
        ctx.lineTo(guide + 0.5, DOCK_HEIGHT - BOT_PAD);
        ctx.stroke();
    }

    // the playhead: read, never authored.
    if (playheadS !== null) {
        const x = xOf(playheadS);
        if (x >= COLUMN_W && x <= dockW) {
            ctx.strokeStyle = "rgba(240, 236, 232, 0.75)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, DOCK_HEIGHT - BOT_PAD);
            ctx.stroke();
        }
    }
}

$effect(() => {
    void tick;
    void clamped;
    void rows;
    void endH;
    void hover;
    void onEnd;
    void playheadS;
    void selectedIds;
    void guide;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    resize(canvas, ctx, dockW, DOCK_HEIGHT);
    render(ctx);
});

// frame the whole track once the dock has a width and the document has an extent.
$effect(() => {
    if (framed || chartW <= 0 || sTotal <= 0) return;
    framed = true;
    view = frameAll(chartW, sTotal, marginArc(sTotal, 50));
});

// ── pointers ──────────────────────────────────────────────────────────────────
const localX = (clientX: number): number => clientX - canvas.getBoundingClientRect().left;
const localY = (clientY: number): number => clientY - canvas.getBoundingClientRect().top;
const dAtPx = (clientX: number): number => pxToU(clamped, localX(clientX) - COLUMN_W);

let panning = false;
let panX = 0;
function panMove(e: PointerEvent): void {
    if (!panning) return;
    view = clampView({ pan: clamped.pan - (e.clientX - panX), pxPerU: clamped.pxPerU }, chartW, sTotal, mFloor);
    panX = e.clientX;
}
function panUp(): void {
    if (!panning) return;
    panning = false;
    window.removeEventListener("pointermove", panMove);
    window.removeEventListener("pointerup", panUp);
    window.removeEventListener("pointercancel", panUp);
}

/** the landmark pool for the live drag, in chart px — the caller's projection of
 *  `spanTargets`' domain landmarks. */
function targetsPx(exclude: number | undefined): number[] {
    if (!doc) return [];
    return spanTargets(doc.lanes, playheadS, doc.end, exclude).map((s) => COLUMN_W + uToPx(clamped, s));
}

/** resolve one station of a live drag through the magnet: landmarks first, then the `S_GRID`
 *  station grid, with Ctrl/Cmd inverting the standing preference for this drag alone. The guide
 *  flash is the landmark's own; the grid stays ambient. */
function snapStation(raw: number, exclude: number | undefined, invert: boolean): number {
    const active = invert ? !snapping : snapping;
    const res = snapAxis(
        active,
        COLUMN_W + uToPx(clamped, raw),
        raw,
        targetsPx(exclude),
        S_GRID,
        (px) => pxToU(clamped, px - COLUMN_W),
        null,
    );
    guide = res.guide;
    return res.value;
}

// ── the span gesture: one open drag over one record ────────────────────────────
// `beginEdge`/`beginBody` open it, every move writes the candidate span through `setRecordSpan`
// (the setter refuses an overlap or a sub-floor span, so an illegal frame simply doesn't land),
// and the release commits one entry. Escape cancels back to the pre-drag span. The origin clamp is
// the VIEW's (`clampSpanDrag`): the setter's own `segmentBeforeOrigin` refusal is the headless
// author's, and a pointer must not be refused every frame for a place it can simply not reach.
let drag: {
    id: number;
    which: "start" | "end" | "body";
    start: number;
    end: number;
    grab: number;
} | null = null;

function dragMove(e: PointerEvent): void {
    const g = drag;
    if (!g) return;
    const invert = e.ctrlKey || e.metaKey;
    if (g.which === "body") {
        const shift = snapStation(g.start + (dAtPx(e.clientX) - g.grab), g.id, invert) - g.start;
        const span = clampSpanDrag("body", g.start + shift, g.end + shift);
        setRecordSpan(ecs, g.id, span.start, span.end);
        return;
    }
    const d = snapStation(dAtPx(e.clientX), g.id, invert);
    const span = clampSpanDrag(g.which, g.which === "start" ? d : g.start, g.which === "start" ? g.end : d);
    setRecordSpan(ecs, g.id, span.start, span.end);
}
function dragUp(): void {
    if (!drag) return;
    drag = null;
    guide = null;
    commit(history);
    endDrag();
    if (eid !== null) releaseGesture(eid);
    window.removeEventListener("pointermove", dragMove);
    window.removeEventListener("pointerup", dragUp);
    window.removeEventListener("pointercancel", dragUp);
}

// ── the gap drag-out: an empty stretch of a lane becomes a record ──────────────
// A press on a gap opens nothing; the RELEASE mints one flat record over the dragged stretch
// through `history.addRecord` (one entry), inheriting the lane's own value there so the bake
// doesn't jump. A drag under the record floor adds nothing at all — a click on empty lane is a
// deselect, not an accidental authoring act.
let gap: { lane: Lane; from: number } | null = null;

function gapMove(e: PointerEvent): void {
    if (!gap) return;
    snapStation(dAtPx(e.clientX), undefined, e.ctrlKey || e.metaKey); // the guide flashes live
}
function gapUp(e: PointerEvent): void {
    const g = gap;
    gap = null;
    guide = null;
    endDrag();
    window.removeEventListener("pointermove", gapMove);
    window.removeEventListener("pointerup", gapUp);
    window.removeEventListener("pointercancel", gapUp);
    if (!g || !doc) return;
    const to = snapStation(dAtPx(e.clientX), undefined, e.ctrlKey || e.metaKey);
    guide = null;
    const span = clampSpanDrag("body", Math.min(g.from, to), Math.max(g.from, to));
    if (span.end - span.start < RECORD_FLOOR) return;
    const value = defaultHandle(doc.lanes, g.lane, span.start);
    const write = addRecord(history, ecs, g.lane, {
        start: span.start,
        end: span.end,
        ease: doc.lanes.force[0]?.ease ?? 1,
        entry: value,
        exit: value,
    });
    if (write.id !== null) selectRecord(write.id);
}

// ── the end-handle gesture ─────────────────────────────────────────────────────
// the pin refuses to drop below any lane's content (`setEnd`), so an illegal frame never lands
// and the handle stays where the content holds it.
let endDrag_ = false;
function endMove(e: PointerEvent): void {
    if (!endDrag_) return;
    setEnd(ecs, Math.max(0, snapStation(dAtPx(e.clientX), undefined, e.ctrlKey || e.metaKey)));
}
function endUp(): void {
    if (!endDrag_) return;
    endDrag_ = false;
    guide = null;
    commit(history);
    endDrag();
    if (eid !== null) releaseGesture(eid);
    window.removeEventListener("pointermove", endMove);
    window.removeEventListener("pointerup", endUp);
    window.removeEventListener("pointercancel", endUp);
}

// ── the playhead scrub (the ruler band alone: scrubbing never edits) ───────────
let scrubbing = false;
function scrubTo(e: PointerEvent): void {
    if (eid === null || !scrubbing) return;
    parkAtArc(ecs, eid, clamp(dAtPx(e.clientX), 0, sTotal));
}
function endScrub(): void {
    scrubbing = false;
    window.removeEventListener("pointermove", scrubTo);
    window.removeEventListener("pointerup", endScrub);
    window.removeEventListener("pointercancel", endScrub);
}

function chartMove(e: PointerEvent): void {
    if (drag || endDrag_ || gap || panning) return;
    const px = localX(e.clientX);
    const py = localY(e.clientY);
    onEnd = endH !== null && py < RULER_H && hitEndHandle(endH, px);
    hover = onEnd ? null : hitRows(rows, clamped, px, py, COLUMN_W);
}

function chartDown(e: PointerEvent): void {
    if (e.button === 1) {
        e.preventDefault();
        panning = true;
        panX = e.clientX;
        window.addEventListener("pointermove", panMove);
        window.addEventListener("pointerup", panUp);
        window.addEventListener("pointercancel", panUp);
        return;
    }
    if (e.button !== 0 || eid === null) return;
    const px = localX(e.clientX);
    const py = localY(e.clientY);
    e.preventDefault();

    // the ruler: the end handle first, then the scrub — the handle is the smaller target.
    if (py < RULER_H) {
        if (endH && hitEndHandle(endH, px)) {
            beginEnd(ecs);
            endDrag_ = true;
            holdForGesture(eid); // the cart holds its station for the gesture's duration
            beginDrag(canvas, e.pointerId);
            window.addEventListener("pointermove", endMove);
            window.addEventListener("pointerup", endUp);
            window.addEventListener("pointercancel", endUp);
            return;
        }
        if (px < COLUMN_W) return; // the column's own ruler cell is inert
        const st = cartState.get(eid);
        if (!st) return;
        scrubbing = true;
        st.held = true; // freeze playback while scrubbing
        scrubTo(e);
        window.addEventListener("pointermove", scrubTo);
        window.addEventListener("pointerup", endScrub);
        window.addEventListener("pointercancel", endScrub);
        return;
    }

    const hit = hitRows(rows, clamped, px, py, COLUMN_W);
    if (hit === null) {
        clearSelection(); // an empty click clears the selection (the dismissal rung)
        return;
    }
    if (hit.kind === "column") return; // the reorder drag is S3c's
    if (hit.kind === "gap") {
        clearSelection();
        gap = { lane: hit.lane, from: hit.d };
        beginDrag(canvas, e.pointerId);
        window.addEventListener("pointermove", gapMove);
        window.addEventListener("pointerup", gapUp);
        window.addEventListener("pointercancel", gapUp);
        return;
    }
    const row = rows.find((r) => r.lane === hit.lane);
    const rec = row?.records.find((r) => r.id === hit.id);
    if (!rec) return;
    // the press selects before it drags, so the subject of the gesture is the subject the
    // popover and the keys bind to. Shift toggles membership; a plain press replaces.
    if (e.shiftKey) toggleRecord(hit.id);
    else if (!editor.records.ids.has(hit.id)) selectRecord(hit.id);
    if (hit.kind === "edge") beginEdge(ecs, hit.id);
    else beginBody(ecs, hit.id);
    drag = {
        id: hit.id,
        which: hit.kind === "edge" ? hit.which : "body",
        start: rec.start,
        end: rec.end,
        grab: pxToU(clamped, px - COLUMN_W),
    };
    holdForGesture(eid);
    beginDrag(canvas, e.pointerId);
    window.addEventListener("pointermove", dragMove);
    window.addEventListener("pointerup", dragUp);
    window.addEventListener("pointercancel", dragUp);
}

function togglePlay(): void {
    if (eid === null) return;
    const st = cartState.get(eid);
    if (!st) return;
    st.held = !st.held;
    if (st.held) parkFromTime(ecs, eid); // pausing parks at the cart's current place
}

let scrubEl: HTMLDivElement;
let sliding = false;
let sliderResume = false;
function sliderTo(e: PointerEvent): void {
    if (eid === null || !sliding) return;
    const rect = scrubEl.getBoundingClientRect();
    const f = rect.width > 0 ? clamp((e.clientX - rect.left) / rect.width, 0, 1) : 0;
    const st = cartState.get(eid);
    if (!st) return;
    st.t = f * tTotal;
    parkFromTime(ecs, eid);
}
function sliderUp(): void {
    if (!sliding) return;
    sliding = false;
    if (eid !== null) {
        const st = cartState.get(eid);
        if (st) st.held = sliderResume; // a grab while paused stays paused
    }
    window.removeEventListener("pointermove", sliderTo);
    window.removeEventListener("pointerup", sliderUp);
    window.removeEventListener("pointercancel", sliderUp);
}
function sliderDown(e: PointerEvent): void {
    if (eid === null || tTotal <= 0) return;
    const st = cartState.get(eid);
    if (!st) return;
    e.preventDefault();
    sliderResume = st.held;
    sliding = true;
    st.held = true;
    sliderTo(e);
    window.addEventListener("pointermove", sliderTo);
    window.addEventListener("pointerup", sliderUp);
    window.addEventListener("pointercancel", sliderUp);
}

onMount(() => {
    // wheel zooms the document axis at the cursor, shift+wheel pans — the curve-editor
    // standard. Never under a live gesture (`editor.dragging`, the one live-gesture flag).
    const onWheel = (e: WheelEvent): void => {
        e.preventDefault();
        if (editor.dragging || chartW <= 0) return;
        const x = localX(e.clientX) - COLUMN_W;
        const panH =
            e.shiftKey || (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaX) > Math.abs(e.deltaY));
        if (panH) {
            const dx = e.shiftKey ? e.deltaY : e.deltaX;
            view = clampView({ pan: clamped.pan + dx, pxPerU: clamped.pxPerU }, chartW, sTotal, mFloor);
            return;
        }
        view = zoomAt(clamped, x, Math.exp(-e.deltaY / ZOOM_DIV), chartW, sTotal, mFloor);
    };
    const onKey = (e: KeyboardEvent): void => {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        // Escape peels the innermost layer first: a live gesture, then the selection
        // (`editor-ui.md`: dismissal peels one layer).
        if (bound(BINDINGS.exitMode, e.key)) {
            if (drag || endDrag_ || gap) {
                e.preventDefault();
                drag = null;
                endDrag_ = false;
                gap = null;
                guide = null;
                cancel();
                endDrag();
                if (eid !== null) releaseGesture(eid);
                return;
            }
            if (editor.records.ids.size > 0) {
                e.preventDefault();
                clearSelection();
            }
            return;
        }
        if (e.code === "Space") {
            e.preventDefault();
            togglePlay();
            return;
        }
        const act = timelineKeyAct(e.key, {
            dragging: editor.dragging,
            ctrl: e.ctrlKey || e.metaKey,
            shift: e.shiftKey,
            selected: editor.record !== null,
        });
        if (act === null) return;
        e.preventDefault();
        if (act === "undo") undoHistory(history, ecs);
        else if (act === "redo") redoHistory(history, ecs);
        else if (act === "toggleSnap") snapping = !snapping;
        else if (editor.record !== null) removeRecord(history, ecs, editor.record);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey);
    return () => {
        canvas.removeEventListener("wheel", onWheel);
        window.removeEventListener("keydown", onKey);
        endScrub();
        panUp();
        dragUp();
        endUp();
        sliderUp();
    };
});
</script>

<!-- the timeline dock: the force curve earns persistence (`editor-ui.md`), so this one surface
     stays docked — now as the lane rows themselves, one row per authored parameter. -->
<div
    class="dock"
    bind:clientWidth={dockW}
    style="bottom: {DOCK_INSET}px; height: {DOCK_HEIGHT}px;"
    onpointerenter={() => (editor.hover = "timeline")}
    onpointerleave={() => {
        editor.hover = "viewport";
        hover = null;
        onEnd = false;
    }}
    role="group"
    aria-label="Timeline"
>
    <canvas
        class="chart"
        bind:this={canvas}
        onpointerdown={chartDown}
        onpointermove={chartMove}
        oncontextmenu={(e) => e.preventDefault()}
    ></canvas>
</div>

<!-- the player: a standard media transport (play/pause · global scrub · timecode), floated as
     its own surface above the dock. It drives the cart, never the document. -->
<div
    class="player"
    class:idle={eid === null || tTotal <= 0}
    style="bottom: {DOCK_INSET + DOCK_HEIGHT + PLAYER_GAP}px; height: {PLAYER_H}px;"
    onpointerenter={() => (editor.hover = "timeline")}
    onpointerleave={() => (editor.hover = "viewport")}
    role="group"
    aria-label="Playback"
>
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
    /* `height` and `bottom` are inline-styled from the DOCK_HEIGHT / DOCK_INSET constants
       (view.ts, the single source the viewport camera also reserves from) — not set here. */
    .dock {
        position: absolute;
        left: 50%;
        transform: translateX(-50%);
        width: calc(100% - 32px);
        max-width: 1280px;
        background: var(--bg-solid);
        border: 1px solid var(--border);
        border-radius: 6px;
        box-shadow: var(--shadow);
        font-family: "Outfit", system-ui, sans-serif;
        user-select: none;
        -webkit-user-select: none;
        overflow: hidden;
    }
    .chart {
        display: block;
        width: 100%;
        height: 100%;
        touch-action: none;
    }

    .player {
        position: absolute;
        left: 50%;
        transform: translateX(-50%);
        width: min(calc(100% - 32px), 560px);
        box-sizing: border-box;
        /* height inline-styled from PLAYER_H (view.ts) */
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
    /* no track → the player goes quiet, not loud */
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
        transition: background 120ms var(--ease-out), transform 80ms var(--ease-out);
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
        transition: transform 100ms var(--ease-out);
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
        margin: 0 0.4em;
    }
    .time .total {
        color: var(--muted);
    }
</style>
