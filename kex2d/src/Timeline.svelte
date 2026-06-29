<script lang="ts">
import { onMount } from "svelte";
import { cartPose, cartState, cartTimeAtU, sampleFNOverTime } from "./cart";
import { OPT_GRID, solveOut } from "./optimize";
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
    <div class="body" bind:this={host} bind:clientWidth={w} bind:clientHeight={h}>
        <canvas bind:this={canvas}></canvas>
        <svg class="overlay" width={w} height={h}>
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
