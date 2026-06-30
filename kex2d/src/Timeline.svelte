<script lang="ts">
import { onMount } from "svelte";
import { cartPose, cartState, cartTimeAtU, sampleFNOverTime } from "./cart";
import { begin, cancel, commit, drop, erase, history, redo, undo } from "./history";
import { OPT_GRID, solveOut } from "./optimize";
import { findPin, type Pin, pinsOf, setHandle, setPin } from "./pins";
import { DEFAULT_BAND } from "./solve";
import { bakeOut } from "./track";
import { clampView, frameAll, pxToSec, secToPx, ticks, type View, zoomAt } from "./timeline";
import { resize } from "./view";

const { eid, tick }: { eid: number | null; tick: number } = $props();

const PAD = 10; // chart inset, top
const AXIS_H = 18; // bottom band for time labels
// vertical range tracks the solve's force band, not a hardcoded window, so a curve
// riding the band's edge is never clipped. headroom shows near-/over-limit excursions.
const Y_HEADROOM = 1;
const Y_MIN = DEFAULT_BAND[0] - Y_HEADROOM;
const Y_MAX = DEFAULT_BAND[1] + Y_HEADROOM;
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
let w = $state(0);
let h = $state(0);
// the user's view intent; `clamped` re-fits it to the live width/track length, so a
// resize or a track edit never writes back into `view` (which would loop the effect).
let view: View = $state({ pan: 0, pxPerSec: 100 });
let framed = false;

// total draft-time seconds — the X-axis domain. grid index i ↔ sec (i/(N-1))·tTotal.
const tTotal = $derived.by((): number => {
    void tick;
    if (eid === null) return 0;
    return bakeOut.get(eid)?.tTotal ?? 0;
});
const clamped = $derived(clampView(view, w, tTotal));
const tickList = $derived(ticks(clamped, w));

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
    const x = secToPx(clamped, cartSec);
    return x < 0 || x > w ? null : x;
});
const paused = $derived.by((): boolean => {
    void tick;
    return eid === null ? false : (cartState.get(eid)?.held ?? false);
});

const yOf = (val: number): number =>
    PAD + (1 - (val - Y_MIN) / (Y_MAX - Y_MIN)) * (h - AXIS_H - PAD);
// inverse of yOf: screen-Y → force value (for placing / dragging pins).
const valOf = (py: number): number =>
    Y_MIN + (1 - (py - PAD) / (h - AXIS_H - PAD)) * (Y_MAX - Y_MIN);

const clamp = (x: number, lo: number, hi: number): number => Math.min(Math.max(x, lo), hi);
// pin draft-time grid index ↔ screen-X, value ↔ screen-Y (clamped to the chart).
const pxOfIndex = (i: number): number => secToPx(clamped, (i / (N - 1)) * tTotal);
const indexAt = (px: number): number =>
    clamp(Math.round((pxToSec(clamped, px) / tTotal) * (N - 1)), 0, N - 1);
const valAt = (py: number): number => clamp(valOf(py), Y_MIN, Y_MAX);

// authored force pins, projected to screen space — the draggable handles.
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

// ── pin authoring: drop on the empty band, drag a pin (live re-solve), click to
// open an inline value editor, delete. all routed through the undo history.
let dragId: number | null = null;
let dragMoved = false;
let editing = $state<{ id: number; x: number; y: number } | null>(null);
let editVal = $state(0);
let hoverId = $state<number | null>(null);
let hDrag = $state<{ id: number; side: "l" | "r" } | null>(null);

// the pin whose tangent handles are shown: the one being edited, the one whose
// handle is mid-drag, or the hovered one — handles are summoned, not always-on.
const activeId = $derived(editing?.id ?? hDrag?.id ?? hoverId);

// the active pin's tangent handles in screen space. the right handle reaches
// toward the next pin, the left toward the previous; the first pin has no left
// handle, the last no right (no neighbor on that side).
const handleView = $derived.by(
    (): { id: number; side: "l" | "r"; x0: number; y0: number; x: number; y: number }[] => {
        void tick;
        if (eid === null || tTotal <= 0 || activeId === null) return [];
        const pins = sortedPins;
        const i = pins.findIndex((p) => p.id === activeId);
        if (i < 0) return [];
        const p = pins[i];
        const x0 = pxOfIndex(p.index);
        const y0 = yOf(p.value);
        const out: { id: number; side: "l" | "r"; x0: number; y0: number; x: number; y: number }[] = [];
        if (i < pins.length - 1) {
            const span = pins[i + 1].index - p.index;
            if (span > 0)
                out.push({
                    id: p.id,
                    side: "r",
                    x0,
                    y0,
                    x: pxOfIndex(p.index + p.hr.dx * span),
                    y: yOf(p.value + p.hr.dy),
                });
        }
        if (i > 0) {
            const span = p.index - pins[i - 1].index;
            if (span > 0)
                out.push({
                    id: p.id,
                    side: "l",
                    x0,
                    y0,
                    x: pxOfIndex(p.index - p.hl.dx * span),
                    y: yOf(p.value + p.hl.dy),
                });
        }
        return out;
    },
);

function bandDown(e: PointerEvent): void {
    // a click on empty force band drops a new pin at the cursor.
    if (eid === null || tTotal <= 0) return;
    e.preventDefault();
    editCommit(); // close any open editor first (preventDefault suppresses its blur)
    const rect = host.getBoundingClientRect();
    drop(history, eid, indexAt(e.clientX - rect.left), valAt(e.clientY - rect.top));
}

function pinDown(e: PointerEvent, id: number): void {
    if (eid === null) return;
    e.preventDefault();
    e.stopPropagation(); // not a band drop
    editCommit(); // close any open editor first (preventDefault suppresses its blur)
    dragId = id;
    dragMoved = false;
    begin(eid, id); // open the gesture; commit/cancel on release
    window.addEventListener("pointermove", pinDrag);
    window.addEventListener("pointerup", pinUp);
}
function pinDrag(e: PointerEvent): void {
    if (eid === null || dragId === null) return;
    const rect = host.getBoundingClientRect();
    setPin(eid, dragId, indexAt(e.clientX - rect.left), valAt(e.clientY - rect.top));
    dragMoved = true;
}
function pinUp(): void {
    window.removeEventListener("pointermove", pinDrag);
    window.removeEventListener("pointerup", pinUp);
    const id = dragId;
    dragId = null;
    if (id === null) return;
    if (dragMoved) commit(history); // one drag → one undo entry
    else {
        cancel(); // a no-move click: discard the empty gesture, open the editor
        openEditor(id);
    }
}

// ── tangent-handle drag: X-clamped to the segment (function-of-time), Y free in
// g (overshoot), live re-solve, commit-on-release. routed through the same gesture
// history as a pin drag.
function handleDown(e: PointerEvent, id: number, side: "l" | "r"): void {
    if (eid === null) return;
    e.preventDefault();
    e.stopPropagation(); // not a pin drag / band drop
    editCommit(); // close any open editor first
    hDrag = { id, side };
    begin(eid, id); // gesture: commit/cancel on release
    window.addEventListener("pointermove", handleDrag);
    window.addEventListener("pointerup", handleUp);
}
function handleDrag(e: PointerEvent): void {
    if (eid === null || hDrag === null) return;
    const pins = sortedPins;
    const i = pins.findIndex((p) => p.id === hDrag?.id);
    if (i < 0) return;
    // the side's neighbor must exist (an endpoint has no handle on its bare side).
    if (hDrag.side === "r" ? i >= pins.length - 1 : i <= 0) return;
    const p = pins[i];
    const rect = host.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const x0 = pxOfIndex(p.index);
    // dx is the fraction from the pin toward its neighbor on that side; clamping to
    // [0,1] keeps the segment a function of time. dy uses valOf (unclamped), so a
    // handle can author overshoot past the band.
    let dx: number;
    if (hDrag.side === "r") {
        const seg = pxOfIndex(pins[i + 1].index) - x0;
        dx = seg > 0 ? (cx - x0) / seg : 0;
    } else {
        const seg = x0 - pxOfIndex(pins[i - 1].index);
        dx = seg > 0 ? (x0 - cx) / seg : 0;
    }
    setHandle(eid, hDrag.id, hDrag.side, dx, valOf(cy) - p.value);
}
function handleUp(): void {
    window.removeEventListener("pointermove", handleDrag);
    window.removeEventListener("pointerup", handleUp);
    if (hDrag === null) return;
    hDrag = null;
    commit(history); // a handle drag always intends an edit; commit no-ops if unchanged
}

function openEditor(id: number): void {
    if (eid === null) return;
    const pin = findPin(eid, id);
    const p = pinView.find((q) => q.id === id);
    if (!pin || !p) return;
    editVal = pin.value;
    editing = { id, x: p.x, y: p.y };
    begin(eid, id); // edits are a gesture too (live preview, commit on close)
}
function editLive(): void {
    if (eid === null || editing === null || !Number.isFinite(editVal)) return;
    const pin = findPin(eid, editing.id);
    if (pin) setPin(eid, editing.id, pin.index, clamp(editVal, Y_MIN, Y_MAX));
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
function editTrash(): void {
    if (eid === null || editing === null) return;
    cancel(); // drop the open edit gesture, then delete as its own entry
    erase(history, eid, editing.id);
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
    const bot = h - AXIS_H;
    ctx.font = "9px 'JetBrains Mono', ui-monospace, monospace";
    ctx.textBaseline = "middle";

    for (const tk of tickList) {
        if (tk.px < -1 || tk.px > w + 1) continue;
        ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(tk.px, PAD);
        ctx.lineTo(tk.px, bot);
        ctx.stroke();
        ctx.fillStyle = "rgba(160, 152, 144, 0.7)";
        ctx.textAlign = "center";
        ctx.fillText(tk.label, tk.px, bot + AXIS_H / 2);
    }

    // force band limits — the feasible region the solve lives in
    ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
    ctx.lineWidth = 1;
    for (const lim of DEFAULT_BAND) {
        ctx.beginPath();
        ctx.moveTo(0, yOf(lim));
        ctx.lineTo(w, yOf(lim));
        ctx.stroke();
    }

    // 1g gravity baseline
    ctx.strokeStyle = "rgba(212, 149, 96, 0.5)";
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(0, yOf(Y_BASE));
    ctx.lineTo(w, yOf(Y_BASE));
    ctx.stroke();
    ctx.setLineDash([]);

    // baked F_n draft dots
    if (fN) {
        ctx.fillStyle = "rgba(205, 197, 188, 0.55)";
        const n = fN.length;
        for (let i = 0; i < n; i++) {
            const x = secToPx(v, (i / (n - 1)) * tTotal);
            if (x < -2 || x > w + 2) continue;
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

    // solved F_n curve
    if (solved) {
        ctx.strokeStyle = "rgb(212, 149, 96)";
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        const n = solved.length;
        for (let i = 0; i < n; i++) {
            const x = secToPx(v, (i / (n - 1)) * tTotal);
            const y = yOf(solved[i]);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }

    // Y legend — the band edges + the gravity baseline
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(160, 152, 144, 0.55)";
    ctx.fillText(`${DEFAULT_BAND[1]}g`, w - 4, yOf(DEFAULT_BAND[1]) - 5);
    ctx.fillStyle = "rgba(212, 149, 96, 0.7)";
    ctx.fillText("1g", w - 4, yOf(Y_BASE) - 6);
    ctx.fillStyle = "rgba(160, 152, 144, 0.55)";
    ctx.fillText(`${DEFAULT_BAND[0]}g`, w - 4, yOf(DEFAULT_BAND[0]) + 5);
}

$effect(() => {
    // frame the whole track once, when width + a track first exist.
    if (!framed && w > 0 && tTotal > 0) {
        view = frameAll(w, tTotal);
        framed = true;
    }
});

$effect(() => {
    // render() reads view/data/size synchronously, so the effect tracks them.
    const ctx = canvas?.getContext("2d");
    if (!ctx) return;
    resize(canvas, ctx);
    render(ctx);
});

let scrubbing = false;
function scrubTo(e: PointerEvent): void {
    if (eid === null || !scrubbing) return;
    const rect = canvas.getBoundingClientRect();
    const sec = pxToSec(clamped, e.clientX - rect.left);
    const u = tTotal > 0 ? Math.min(Math.max(sec / tTotal, 0), 1) : 0;
    const t = cartTimeAtU(eid, u);
    const st = cartState.get(eid);
    if (st && t !== null) st.t = t;
}
function endScrub(): void {
    scrubbing = false;
    if (eid !== null) {
        const st = cartState.get(eid);
        if (st) st.held = false;
    }
    window.removeEventListener("pointermove", scrubTo);
    window.removeEventListener("pointerup", endScrub);
}
function startScrub(e: PointerEvent): void {
    if (eid === null) return;
    const st = cartState.get(eid);
    if (!st) return;
    e.preventDefault();
    scrubbing = true;
    st.held = true;
    scrubTo(e);
    window.addEventListener("pointermove", scrubTo);
    window.addEventListener("pointerup", endScrub);
}

function togglePlay(): void {
    if (eid === null) return;
    const st = cartState.get(eid);
    if (st) st.held = !st.held;
}
onMount(() => {
    const onWheel = (e: WheelEvent): void => {
        e.preventDefault();
        const x = e.clientX - canvas.getBoundingClientRect().left;
        if (e.ctrlKey || e.metaKey) {
            view = zoomAt(clamped, x, 2 ** (-e.deltaY / ZOOM_DIV), w, tTotal);
        } else {
            const dx = e.shiftKey ? e.deltaY : e.deltaX || e.deltaY;
            view = clampView({ pan: clamped.pan + dx, pxPerSec: clamped.pxPerSec }, w, tTotal);
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
        window.removeEventListener("pointermove", pinDrag);
        window.removeEventListener("pointerup", pinUp);
        window.removeEventListener("pointermove", handleDrag);
        window.removeEventListener("pointerup", handleUp);
    };
});
</script>

<aside class="dock">
    <div class="transport">
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
        <span class="readout">{(cartSec ?? 0).toFixed(2)}s / {tTotal.toFixed(2)}s</span>
    </div>
    <!-- leaving the chart clears the hovered pin (its tangent handles stay summoned
         while the pointer rests on the pin or a handle, so the dot→nub travel never
         loses them; only leaving the dock dismisses them). -->
    <div
        class="body"
        bind:this={host}
        bind:clientWidth={w}
        bind:clientHeight={h}
        onpointerleave={() => (hoverId = null)}
        role="presentation"
    >
        <canvas bind:this={canvas}></canvas>
        <svg class="overlay" width={w} height={h}>
            <!-- empty force band: click to drop a pin. below the pins + grip in
                 DOM, so those take the pointer when hit. -->
            {#if eid !== null && tTotal > 0}
                <rect
                    class="dropzone"
                    x="0"
                    y={PAD}
                    width={w}
                    height={Math.max(0, h - AXIS_H - PAD)}
                    onpointerdown={bandDown}
                    role="presentation"
                />
            {/if}
            {#each pinView as p (p.id)}
                <circle
                    class="pin-hit"
                    cx={p.x}
                    cy={p.y}
                    r={PIN_HIT_R}
                    onpointerdown={(e) => pinDown(e, p.id)}
                    onpointerenter={() => (hoverId = p.id)}
                    role="button"
                    tabindex="-1"
                    aria-label="Force pin"
                />
                <circle class="pin-dot" cx={p.x} cy={p.y} r={PIN_DOT_R} />
            {/each}
            <!-- the active pin's tangent handles: a stem from the pin to a grabbable
                 nub. drag to bend the constraint curve (X-clamped, Y-free). above the
                 pins in DOM so the nub takes the pointer when they overlap. -->
            {#each handleView as hd (hd.id + hd.side)}
                <line class="handle-stem" x1={hd.x0} y1={hd.y0} x2={hd.x} y2={hd.y} />
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
                <circle class="handle-nub" cx={hd.x} cy={hd.y} r={HANDLE_NUB_R} />
            {/each}
            {#if playPx !== null}
                <line class="playhead" x1={playPx} x2={playPx} y1={PAD} y2={h - AXIS_H} />
                <polygon
                    class="grip"
                    points="{playPx - 5},{PAD - 2} {playPx + 5},{PAD - 2} {playPx},{PAD + 6}"
                    onpointerdown={startScrub}
                    role="slider"
                    tabindex="0"
                    aria-label="Scrub playhead"
                    aria-valuenow={Math.round((cartSec ?? 0) * 100) / 100}
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
                <button
                    type="button"
                    class="pin-trash"
                    title="Delete pin"
                    aria-label="Delete pin"
                    onpointerdown={(e) => {
                        e.preventDefault();
                        editTrash();
                    }}
                >
                    <svg viewBox="0 0 14 14" aria-hidden="true">
                        <path
                            d="M3 4 L11 4 M5.5 4 L5.5 2.5 L8.5 2.5 L8.5 4 M4.5 4 L5 11.5 L9 11.5 L9.5 4"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.3"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                        />
                    </svg>
                </button>
            </div>
        {/if}
    </div>
</aside>

<style>
    .dock {
        position: absolute;
        left: 50%;
        transform: translateX(-50%);
        width: calc(100% - 32px);
        max-width: 1280px;
        bottom: 16px;
        height: 140px;
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
        stroke: var(--accent);
        stroke-width: 1.2;
        opacity: 0.9;
    }

    .grip {
        fill: var(--accent);
        pointer-events: auto;
        cursor: ew-resize;
    }

    /* click-to-drop surface over the force band */
    .dropzone {
        fill: transparent;
        pointer-events: all;
        cursor: crosshair;
    }

    /* fat transparent hit-zone over a thin visible dot (theatre pattern) */
    .pin-hit {
        fill: transparent;
        pointer-events: all;
        cursor: grab;
    }
    .pin-hit:active {
        cursor: grabbing;
    }
    .pin-dot {
        fill: var(--accent);
        stroke: var(--bg-solid);
        stroke-width: 1;
        pointer-events: none;
    }
    .pin-hit:hover + .pin-dot {
        r: 5;
    }

    /* tangent handle: a thin stem to a grabbable nub, in the drawn-curve blue */
    .handle-stem {
        stroke: rgba(120, 175, 205, 0.6);
        stroke-width: 1;
        pointer-events: none;
    }
    .handle-hit {
        fill: transparent;
        pointer-events: all;
        cursor: grab;
    }
    .handle-hit:active {
        cursor: grabbing;
    }
    .handle-nub {
        fill: rgba(120, 175, 205, 0.95);
        stroke: var(--bg-solid);
        stroke-width: 1;
        pointer-events: none;
    }
    .handle-hit:hover + .handle-nub {
        r: 4;
    }

    /* inline value editor, anchored at the pin */
    .pin-editor {
        position: absolute;
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 3px 4px 3px 6px;
        background: var(--bg-solid);
        border: 1px solid var(--border);
        border-radius: 5px;
        box-shadow: var(--shadow);
        z-index: 3;
    }
    .pin-editor input {
        all: unset;
        width: 44px;
        font-family: "JetBrains Mono", ui-monospace, monospace;
        font-size: 11px;
        color: var(--fg);
        text-align: right;
    }
    .pin-editor .unit {
        font-family: "JetBrains Mono", ui-monospace, monospace;
        font-size: 11px;
        color: var(--muted);
    }
    .pin-trash {
        all: unset;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        border-radius: 4px;
        color: var(--danger);
        cursor: pointer;
        transition: background 120ms ease;
    }
    .pin-trash:hover {
        background: var(--danger-soft);
    }
    .pin-trash svg {
        width: 13px;
        height: 13px;
    }

    /* persistent transport: play/pause centered, time readout in the right corner
       (ambient status). visible always — transport is a primary control. */
    .transport {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        flex: none;
        height: 30px;
        border-bottom: 1px solid var(--border);
    }

    .play {
        all: unset;
        box-sizing: border-box;
        width: 24px;
        height: 24px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 5px;
        color: var(--accent);
        cursor: pointer;
        transition: background 120ms ease;
    }
    .play:hover {
        background: var(--accent-soft);
    }
    .play svg {
        width: 15px;
        height: 15px;
    }

    .readout {
        position: absolute;
        right: 10px;
        top: 50%;
        transform: translateY(-50%);
        font-family: "JetBrains Mono", ui-monospace, monospace;
        font-size: 10px;
        color: var(--muted);
    }
</style>
