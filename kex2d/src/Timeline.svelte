<script lang="ts">
import type { State } from "@dylanebert/shallot";
import { onMount } from "svelte";
import { cartArc, cartState, parkAtArc, parkFromTime, trackMapping } from "./cart";
import { laneColor } from "./colors";
import { BINDINGS, bound } from "./menu";
import { editor, beginDrag, endDrag } from "./editor";
import { beginBody, beginEdge, beginEnd, cancel, commit, history } from "./history";
import { Lane, type LaneSegment } from "./lanes";
import {
    CHIP_H,
    clampView,
    endHandle,
    fmt,
    frameAll,
    hitEndHandle,
    hitRows,
    laneRows,
    type LaneRow,
    marginArc,
    type RowHit,
    ROW_GAP,
    ROW_H,
    spanBoxes,
    ticks,
    timeToArc,
    uToPx,
    pxToU,
    type View,
    zoomAt,
} from "./timeline";
import { bakeOut, endColumn, lanesOf, laneOrderOf, setEnd, setRecordSpan, Track, trackEndOf } from "./track";
import { DOCK_HEIGHT, DOCK_INSET, PLAYER_GAP, PLAYER_H, resize } from "./view";

/** The lane timeline (spec `kex2d-segment-gestures` S3): one row per authored lane on a shared
 *  arclength ruler, each lane's records drawn as spans with two handles and a value chip on
 *  each — Animate's tween-span grammar over the lane substrate, not After Effects' property
 *  stack (Locked decision, "timeline layout follows Animate").
 *
 *  The row model is `timeline.ts`'s: `laneRows` lays the rows out in `track.order`, `spanBoxes`
 *  projects each record's own stations through the view, and `hitRows` answers one press. This
 *  component owns pixels and pointers and NOTHING else — every authored write goes through a
 *  `history.ts` gesture over a `track.ts` setter (`beginEdge`/`beginBody` + `setRecordSpan`,
 *  `beginEnd` + `setEnd`), written every frame so the drag projects through the bake as it
 *  happens, and coalesced into one undo entry on release. A refused span simply doesn't move:
 *  the setter declines and the next frame redraws the record where it still is.
 *
 *  The playhead reads and never edits (`editor-ui.md`: scrub never authors). */

const { ecs, eid, tick }: { ecs: State; eid: number | null; tick: number } = $props();

// ── chart geometry ────────────────────────────────────────────────────────────
const RULER_H = 26; // the shared arclength ruler
const ROWS_TOP = RULER_H + 6;
const CHIP_W = 34; // the value chip's drawn width
const BOT_PAD = 8;
const ZOOM_DIV = 200; // wheel-delta → geometric zoom rate

let canvas: HTMLCanvasElement;
let dockW = $state(0);
let view = $state<View>({ pan: 0, pxPerU: 0 });
let framed = false;
let hover = $state<RowHit>(null);
let onEnd = $state(false);

const chartW = $derived(Math.max(0, dockW));

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
const endH = $derived(doc ? endHandle(doc.lanes, doc.end, clamped) : null);

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

/** a handle's value in its lane's own unit — pitch in DEGREES, the one place the substrate's
 *  radians are translated for reading (velocity m/s, force g). */
function chipLabel(lane: Lane, value: number | undefined): string {
    if (value === undefined) return "–";
    if (lane === Lane.Velocity) return `${fmt(value, 1)}`;
    if (lane === Lane.Force) return `${fmt(value, 2)}g`;
    return `${fmt((value * 180) / Math.PI, 1)}°`;
}

// ── render ────────────────────────────────────────────────────────────────────
const xOf = (s: number): number => uToPx(clamped, s);

function drawChip(
    ctx: CanvasRenderingContext2D,
    x: number,
    top: number,
    text: string,
    color: string,
    align: "left" | "right",
): void {
    const w = CHIP_W;
    const x0 = align === "left" ? x : x - w;
    ctx.fillStyle = "rgba(22, 20, 19, 0.85)";
    ctx.fillRect(x0, top, w, CHIP_H);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.5;
    ctx.strokeRect(x0 + 0.5, top + 0.5, w - 1, CHIP_H - 1);
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.font = '9px "JetBrains Mono", ui-monospace, monospace';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x0 + w / 2, top + CHIP_H / 2 + 0.5);
}

/** one lane row: its band, its spans in the lane color, each span's two edge grips, and a value
 *  chip on each handle. A gap draws nothing — it is the lane's inferred value, not a record. */
function drawRow(ctx: CanvasRenderingContext2D, row: LaneRow): void {
    const color = laneColor(row.lane);
    ctx.fillStyle = "rgba(0, 0, 0, 0.24)";
    ctx.fillRect(0, row.top, chartW, ROW_H);
    for (const box of spanBoxes(row, clamped)) {
        const rec = row.records.find((r) => r.id === box.id) as LaneSegment;
        const w = Math.max(1, box.x1 - box.x0);
        const live = hover?.kind !== "gap" && hover?.id === box.id;
        ctx.globalAlpha = live ? 0.55 : 0.4;
        ctx.fillStyle = color;
        ctx.fillRect(box.x0, box.y0 + CHIP_H, w, ROW_H - CHIP_H);
        ctx.globalAlpha = 1;
        // the two handles: a solid grip at each end, the span's own two authored stations.
        ctx.fillStyle = color;
        ctx.fillRect(box.x0, box.y0 + CHIP_H, 2, ROW_H - CHIP_H);
        ctx.fillRect(box.x1 - 2, box.y0 + CHIP_H, 2, ROW_H - CHIP_H);
        drawChip(ctx, box.x0, box.y0, chipLabel(row.lane, rec.entry ?? rec.exit), color, "left");
        drawChip(ctx, box.x1, box.y0, chipLabel(row.lane, rec.exit), color, "right");
    }
}

function render(ctx: CanvasRenderingContext2D): void {
    ctx.clearRect(0, 0, dockW, DOCK_HEIGHT);

    // the ruler band and its 1-2-5 ticks.
    ctx.fillStyle = "rgba(255, 255, 255, 0.04)";
    ctx.fillRect(0, 0, dockW, RULER_H);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, chartW, RULER_H);
    ctx.clip();
    ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const tk of ticks(clamped, chartW)) {
        ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
        ctx.beginPath();
        ctx.moveTo(tk.px, RULER_H - 6);
        ctx.lineTo(tk.px, RULER_H);
        ctx.stroke();
        ctx.fillStyle = "rgba(160, 152, 144, 0.8)";
        ctx.fillText(tk.label, tk.px, 8);
    }
    ctx.restore();

    for (const row of rows) drawRow(ctx, row);

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

    // the playhead: read, never authored.
    if (playheadS !== null) {
        const x = xOf(playheadS);
        if (x >= 0 && x <= chartW) {
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
const dAtPx = (clientX: number): number => pxToU(clamped, localX(clientX));

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

// ── the span gesture: one open drag over one record ────────────────────────────
// `beginEdge`/`beginBody` open it, every move writes the candidate span through `setRecordSpan`
// (the setter refuses an overlap or a sub-floor span, so an illegal frame simply doesn't land),
// and the release commits one entry. Escape cancels back to the pre-drag span.
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
    const d = dAtPx(e.clientX);
    if (g.which === "body") {
        const shift = d - g.grab;
        setRecordSpan(ecs, g.id, g.start + shift, g.end + shift);
    } else if (g.which === "start") {
        setRecordSpan(ecs, g.id, d, g.end);
    } else {
        setRecordSpan(ecs, g.id, g.start, d);
    }
}
function dragUp(): void {
    if (!drag) return;
    drag = null;
    commit(history);
    endDrag();
    window.removeEventListener("pointermove", dragMove);
    window.removeEventListener("pointerup", dragUp);
    window.removeEventListener("pointercancel", dragUp);
}

// ── the end-handle gesture ─────────────────────────────────────────────────────
// the pin refuses to drop below any lane's content (`setEnd`), so an illegal frame never lands
// and the handle stays where the content holds it.
let endDrag_ = false;
function endMove(e: PointerEvent): void {
    if (!endDrag_) return;
    setEnd(ecs, Math.max(0, dAtPx(e.clientX)));
}
function endUp(): void {
    if (!endDrag_) return;
    endDrag_ = false;
    commit(history);
    endDrag();
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
    if (drag || endDrag_ || panning) return;
    const px = localX(e.clientX);
    const py = localY(e.clientY);
    onEnd = endH !== null && py < RULER_H && hitEndHandle(endH, px);
    hover = onEnd ? null : hitRows(rows, clamped, px, py);
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
            beginDrag(canvas, e.pointerId);
            window.addEventListener("pointermove", endMove);
            window.addEventListener("pointerup", endUp);
            window.addEventListener("pointercancel", endUp);
            return;
        }
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

    const hit = hitRows(rows, clamped, px, py);
    if (hit === null || hit.kind === "gap" || hit.kind === "chip") return; // S3 item 3's rungs
    const row = rows.find((r) => r.lane === hit.lane);
    const rec = row?.records.find((r) => r.id === hit.id);
    if (!rec) return;
    if (hit.kind === "edge") beginEdge(ecs, hit.id);
    else beginBody(ecs, hit.id);
    drag = {
        id: hit.id,
        which: hit.kind === "edge" ? hit.which : "body",
        start: rec.start,
        end: rec.end,
        grab: pxToU(clamped, px),
    };
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
        const x = localX(e.clientX);
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
        // Escape cancels the live gesture before anything else (`editor-ui.md`: dismissal peels
        // one layer, and a gesture is the innermost).
        if (bound(BINDINGS.exitMode, e.key) && (drag || endDrag_)) {
            e.preventDefault();
            drag = null;
            endDrag_ = false;
            cancel();
            endDrag();
            return;
        }
        if (e.code === "Space") {
            e.preventDefault();
            togglePlay();
        }
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
