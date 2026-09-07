<script lang="ts">
import type { State } from "@dylanebert/shallot";
import { onMount } from "svelte";
import {
    cartArc,
    cartState,
    forceCurve,
    parkAtArc,
    parkFromTime,
    trackMapping,
    velocityCurve,
} from "./cart";
import { COLOR_FORCE, COLOR_VELOCITY, kindSegments } from "./colors";
import { editor } from "./editor";
import {
    clampView,
    fmt,
    frameAll,
    marginArc,
    ticks,
    timeToArc,
    uToPx,
    type View,
    yFit,
    type YFit,
    zoomAt,
} from "./timeline";
import { bakeOut, Track } from "./track";
import { DOCK_HEIGHT, DOCK_INSET, PLAYER_GAP, PLAYER_H, resize } from "./view";

/** The read-only timeline (`retired/pose-ux`, spec `kex2d-segment-gestures` S2c). The pose-era
 *  dock authored force keyframes, velocity strips and section extents in place; every one of
 *  those gestures is retired, and S3 rebuilds this surface as Animate-style lane rows over the
 *  lane substrate. Until then the dock is what the canvas already is: a VIEW of the bake.
 *
 *  It reads the published bake (`bakeOut`, `cart.forceCurve`/`velocityCurve`) and the derived
 *  run projection's kind colors (`colors.kindSegments`) — never authored state, and it writes
 *  none: the only writes are to the cart's own transport (park/hold), which is playback, not
 *  authoring. Both curves are geometry-RECOVERED, so both draw dashed under the mode
 *  vocabulary (`editor-ui.md`: recovered dashed, authored solid) — nothing here is authored. */

const { ecs, eid, tick }: { ecs: State; eid: number | null; tick: number } = $props();

// ── chart geometry ────────────────────────────────────────────────────────────
const RULER_H = 26; // top band: arclength ticks and labels
const GAP_H = 20; // the kind strip: one clip per derived run, in its kind color
const CLIP_PAD = 2;
const CLIP_H = GAP_H - 2 * CLIP_PAD;
const TOP = RULER_H + GAP_H;
const BOT_PAD = 8;
const LEFT_GUT = 44; // g-axis labels live here; the plot insets past it
const RIGHT_GUT = 40; // the speed axis's own labels
const BAND: [number, number] = [-2, 6]; // resting g window (the comfort band)
const V_BAND: [number, number] = [0, 20]; // resting speed window (m/s)
const Y_BASE = 1; // gravity baseline (1 g)
const V_BASE = 0; // speed floor (0 m/s)
const ZOOM_DIV = 200; // wheel-delta → geometric zoom rate

let canvas: HTMLCanvasElement;
let dockW = $state(0);
let view = $state<View>({ pan: 0, pxPerU: 0 });
let framed = false;

const chartW = $derived(Math.max(0, dockW - LEFT_GUT - RIGHT_GUT));

// the bake, re-read each published frame (`tick`) — the one source this surface has.
const bake = $derived.by(() => {
    void tick;
    if (eid === null) return null;
    const f = forceCurve(eid);
    const v = velocityCurve(eid);
    if (!f || !v) return null;
    return { f, v, sTotal: f.s[f.n - 1] ?? 0 };
});
const sTotal = $derived(bake?.sTotal ?? 0);
const mFloor = $derived(marginArc(sTotal, 50));
const clamped = $derived(clampView(view, chartW, sTotal, mFloor));
const segs = $derived.by(() => {
    void tick;
    return eid === null ? [] : kindSegments(ecs);
});

// the two value axes fit the baked data, anchored on their resting bands.
const yF = $derived.by((): YFit => {
    const b = bake;
    if (!b) return yFit(Y_BASE, Y_BASE, Y_BASE, BAND);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < b.f.n; i++) {
        if (b.f.f[i] < lo) lo = b.f.f[i];
        if (b.f.f[i] > hi) hi = b.f.f[i];
    }
    return Number.isFinite(lo) ? yFit(lo, hi, Y_BASE, BAND) : yFit(Y_BASE, Y_BASE, Y_BASE, BAND);
});
const yV = $derived.by((): YFit => {
    const b = bake;
    if (!b) return yFit(V_BASE, V_BASE, V_BASE, V_BAND);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < b.v.n; i++) {
        if (b.v.v[i] < lo) lo = b.v.v[i];
        if (b.v.v[i] > hi) hi = b.v.v[i];
    }
    return Number.isFinite(lo) ? yFit(lo, hi, V_BASE, V_BAND) : yFit(V_BASE, V_BASE, V_BASE, V_BAND);
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
// the playhead's place on the arclength axis — the cart rides in time, the ruler is metres,
// so it projects through the bake's own arclength↔time table (`cart.trackMapping`).
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
function yOf(g: number): number {
    const h = Math.max(1, DOCK_HEIGHT - TOP - BOT_PAD);
    return TOP + ((yF.hi - g) / Math.max(1e-9, yF.hi - yF.lo)) * h;
}
function vOf(v: number): number {
    const h = Math.max(1, DOCK_HEIGHT - TOP - BOT_PAD);
    return TOP + ((yV.hi - v) / Math.max(1e-9, yV.hi - yV.lo)) * h;
}
const xOf = (s: number): number => LEFT_GUT + uToPx(clamped, s);

/** one recovered curve, dashed: every value on this surface is read back out of the bake. */
function drawCurve(
    ctx: CanvasRenderingContext2D,
    s: ArrayLike<number>,
    y: ArrayLike<number>,
    n: number,
    project: (v: number) => number,
    color: string,
): void {
    if (n < 2) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(LEFT_GUT, TOP, chartW, DOCK_HEIGHT - TOP - BOT_PAD);
    ctx.clip();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
        const px = xOf(s[i]);
        const py = project(y[i]);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();
}

function render(ctx: CanvasRenderingContext2D): void {
    const w = dockW;
    const h = DOCK_HEIGHT;
    ctx.clearRect(0, 0, w, h);

    // the bands: ruler, then the kind strip.
    ctx.fillStyle = "rgba(255, 255, 255, 0.04)";
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
    ctx.fillRect(0, RULER_H, w, GAP_H);

    const b = bake;
    // the kind strip: one clip per derived run, in the run's kind color (`colors.kindColor`,
    // the one place kind → color resolves). Read-only — no hover, no selection rung.
    if (b) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(LEFT_GUT, RULER_H, chartW, GAP_H);
        ctx.clip();
        for (const seg of segs) {
            const s0 = b.f.s[Math.min(seg.startSample, b.f.n - 1)] ?? 0;
            const s1 = b.f.s[Math.min(seg.endSample, b.f.n - 1)] ?? 0;
            const x0 = xOf(s0);
            const x1 = xOf(s1);
            ctx.fillStyle = seg.color;
            ctx.globalAlpha = 0.75;
            ctx.fillRect(x0, RULER_H + CLIP_PAD, Math.max(1, x1 - x0), CLIP_H);
        }
        ctx.restore();
    }

    // the shared arclength ruler.
    ctx.save();
    ctx.beginPath();
    ctx.rect(LEFT_GUT, 0, chartW, RULER_H);
    ctx.clip();
    ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
    ctx.lineWidth = 1;
    for (const tk of ticks(clamped, chartW)) {
        const x = LEFT_GUT + tk.px;
        ctx.beginPath();
        ctx.moveTo(x, RULER_H - 6);
        ctx.lineTo(x, RULER_H);
        ctx.stroke();
        ctx.fillStyle = "rgba(160, 152, 144, 0.8)";
        ctx.fillText(tk.label, x, 8);
    }
    ctx.restore();

    // the g gridlines and their labels, then the 1 g baseline.
    ctx.font = '10px "JetBrains Mono", ui-monospace, monospace';
    ctx.textBaseline = "middle";
    const dec = yF.step >= 1 ? 0 : 1;
    for (let g = Math.ceil(yF.lo / yF.step) * yF.step; g <= yF.hi + 1e-9; g += yF.step) {
        const y = yOf(g);
        if (y < TOP + 5 || y > DOCK_HEIGHT - BOT_PAD - 5) continue;
        ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
        ctx.beginPath();
        ctx.moveTo(LEFT_GUT, y);
        ctx.lineTo(LEFT_GUT + chartW, y);
        ctx.stroke();
        ctx.textAlign = "right";
        ctx.fillStyle = "rgba(160, 152, 144, 0.7)";
        ctx.fillText(`${fmt(g, dec)}g`, LEFT_GUT - 6, y);
    }
    ctx.strokeStyle = "rgba(205, 197, 188, 0.35)";
    ctx.beginPath();
    ctx.moveTo(LEFT_GUT, yOf(Y_BASE));
    ctx.lineTo(LEFT_GUT + chartW, yOf(Y_BASE));
    ctx.stroke();

    // the speed axis's own bounds, on the right gutter.
    ctx.textAlign = "left";
    ctx.fillStyle = COLOR_VELOCITY;
    ctx.globalAlpha = 0.7;
    ctx.fillText(`${fmt(yV.hi, 1)}`, LEFT_GUT + chartW + 6, vOf(yV.hi) + 6);
    ctx.fillText(`${fmt(yV.lo, 1)}`, LEFT_GUT + chartW + 6, vOf(yV.lo) - 6);
    ctx.globalAlpha = 1;

    if (b) {
        drawCurve(ctx, b.v.s, b.v.v, b.v.n, vOf, COLOR_VELOCITY);
        drawCurve(ctx, b.f.s, b.f.f, b.f.n, yOf, COLOR_FORCE);
    }

    // the playhead: read, never authored.
    if (playheadS !== null) {
        const x = xOf(playheadS);
        if (x >= LEFT_GUT && x <= LEFT_GUT + chartW) {
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
    void yF;
    void yV;
    void segs;
    void playheadS;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    resize(canvas, ctx, dockW, DOCK_HEIGHT);
    render(ctx);
});

// frame the whole track once the dock has a width and the bake has an extent.
$effect(() => {
    if (framed || chartW <= 0 || sTotal <= 0) return;
    framed = true;
    view = frameAll(chartW, sTotal, marginArc(sTotal, 50));
});

// ── navigation and transport ──────────────────────────────────────────────────
const dAtPx = (clientX: number): number => {
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left - LEFT_GUT;
    return (px + clamped.pan) / Math.max(1e-9, clamped.pxPerU);
};

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

let scrubbing = false;
function scrubTo(e: PointerEvent): void {
    if (eid === null || !scrubbing) return;
    parkAtArc(ecs, eid, clamp(dAtPx(e.clientX), 0, sTotal));
}
function endScrub(): void {
    scrubbing = false; // parked + paused: a scrub never auto-resumes (the AE convention)
    window.removeEventListener("pointermove", scrubTo);
    window.removeEventListener("pointerup", endScrub);
    window.removeEventListener("pointercancel", endScrub);
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
    const st = cartState.get(eid);
    if (!st) return;
    e.preventDefault();
    scrubbing = true;
    st.held = true; // freeze playback while scrubbing
    scrubTo(e);
    window.addEventListener("pointermove", scrubTo);
    window.addEventListener("pointerup", endScrub);
    window.addEventListener("pointercancel", endScrub);
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
        const x = e.clientX - canvas.getBoundingClientRect().left - LEFT_GUT;
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
        sliderUp();
    };
});
</script>

<!-- the timeline dock: the force curve earns persistence (`editor-ui.md`), so this one surface
     stays docked — now as a read-only view of the bake until S3 rebuilds it over lane rows. -->
<div
    class="dock"
    bind:clientWidth={dockW}
    style="bottom: {DOCK_INSET}px; height: {DOCK_HEIGHT}px;"
    onpointerenter={() => (editor.hover = "timeline")}
    onpointerleave={() => (editor.hover = "viewport")}
    role="group"
    aria-label="Timeline"
>
    <canvas
        class="chart"
        bind:this={canvas}
        onpointerdown={chartDown}
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
