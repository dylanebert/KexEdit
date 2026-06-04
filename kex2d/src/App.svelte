<script lang="ts">
import type { State } from "@dylanebert/shallot";
import { onMount } from "svelte";
import { cartPose, cartState, sampleFNOverTime } from "./cart";
import { attachControls } from "./controls";
import { editor, select } from "./editor";
import { OPT_GRID, solveOut } from "./optimize";
import { bakeOut, extend, Handle, lastHandle, removeTrailingHandle, Track } from "./track";
import { attachCanvas2D, viewTransform } from "./view";

const { ecs }: { ecs: State } = $props();
let canvas: HTMLCanvasElement;

let trackEid = $state<number | null>(null);
let tick = $state(0);

const Y_MIN = -2;
const Y_MAX = 3;
const Y_BASE = 1;
const PAD_X = 8;
const PAD_Y = 8;
const STRIP_H = 88;

onMount(() => {
    attachCanvas2D(canvas);
    const detach = attachControls(canvas, ecs);
    for (const eid of ecs.query([Track])) {
        trackEid = eid;
        break;
    }
    let raf = 0;
    const loop = (): void => {
        tick++;
        raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
        detach();
        cancelAnimationFrame(raf);
    };
});

// the baked draft F_n on the uniform draft-time grid — what the rider feels. the
// dots; the solved line below is the optimizer's output on the same grid.
const fN = $derived.by((): Float32Array | null => {
    void tick;
    if (trackEid === null) return null;
    return sampleFNOverTime(trackEid, OPT_GRID);
});
// the solved curve (Phase 1 — data prior + always-on curvature smoothing + the
// soft force band), read from the same solveOut that drives the realized track.
const solved = $derived.by((): Float32Array | null => {
    void tick;
    if (trackEid === null) return null;
    return solveOut.get(trackEid)?.fN ?? null;
});
const solvedPath = $derived.by((): string => {
    if (!solved) return "";
    let d = "";
    for (let i = 0; i < solved.length; i++) {
        d += `${i === 0 ? "M" : "L"}${xOf(i, solved.length, 1000).toFixed(2)} ${yOf(solved[i], STRIP_H).toFixed(2)} `;
    }
    return d.trimEnd();
});
// the cart's strip cursor: its progress as a draft-time grid fraction (the strip
// x-axis), mapped through the cart's realized-time position on the solved track.
const cartTFrac = $derived.by((): number | null => {
    void tick;
    if (trackEid === null) return null;
    const st = cartState.get(trackEid);
    if (!st) return null;
    return cartPose(trackEid, st.t)?.u ?? null;
});
const infeasible = $derived.by((): boolean => {
    void tick;
    if (trackEid === null) return false;
    const out = bakeOut.get(trackEid);
    return !!out && out.firstInfeasible >= 0;
});
const handleCount = $derived.by((): number => {
    void tick;
    let n = 0;
    for (const _ of ecs.query([Handle])) n++;
    return n;
});
// the chain end carries a radial action cluster when selected: an extend button
// along the heading (where the next piece lays) and a delete button rotated off
// it. positions are in canvas/CSS pixels at the node's screen point.
const RADIAL_R = 46; // px from node center to a button center
const TRASH_OFFSET = Math.PI / 3; // delete sits 60° (screen-CW) off extend
type EndUI = { x: number; y: number; ext: { x: number; y: number }; del: { x: number; y: number } };
const endUI = $derived.by((): EndUI | null => {
    void tick;
    const eid = editor.selection;
    if (!canvas || eid === null || eid !== lastHandle(ecs)) return null;
    const tx = viewTransform(canvas);
    const x = tx.ox + Handle.pos.x.get(eid) * tx.sx;
    const y = tx.oy + Handle.pos.y.get(eid) * tx.sy;
    // world heading → screen direction; the view flips Y (tx.sy < 0), so this is −θ.
    const th = Handle.theta.get(eid);
    const ang = Math.atan2(Math.sin(th) * tx.sy, Math.cos(th) * tx.sx);
    return {
        x,
        y,
        ext: { x: RADIAL_R * Math.cos(ang), y: RADIAL_R * Math.sin(ang) },
        del: { x: RADIAL_R * Math.cos(ang + TRASH_OFFSET), y: RADIAL_R * Math.sin(ang + TRASH_OFFSET) },
    };
});

const xOf = (i: number, n: number, w: number): number =>
    PAD_X + (i / Math.max(1, n - 1)) * (w - 2 * PAD_X);
const yOf = (v: number, h: number): number =>
    PAD_Y + (1 - (v - Y_MIN) / (Y_MAX - Y_MIN)) * (h - 2 * PAD_Y);

function onExtend(): void {
    select(extend(ecs));
}
function onDelete(): void {
    if (removeTrailingHandle(ecs)) select(lastHandle(ecs));
}
</script>

<canvas bind:this={canvas}></canvas>

{#if infeasible}
    <div class="warning" role="alert">
        <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
                d="M8 1 L15 14 L1 14 Z"
                fill="none"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linejoin="round"
            />
            <path
                d="M8 6 L8 10 M8 11.8 L8 12.3"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
            />
        </svg>
        <span>Insufficient velocity</span>
    </div>
{/if}

<!-- contextual actions radially around the selected chain end: extend along the
     heading, delete rotated off it -->
{#if endUI}
    <div class="radial" style="left: {endUI.x}px; top: {endUI.y}px;" aria-label="End piece actions">
        <button
            type="button"
            class="rbtn extend"
            title="Extend (Enter)"
            aria-label="Extend"
            style="transform: translate(calc(-50% + {endUI.ext.x}px), calc(-50% + {endUI.ext.y}px));"
            onclick={onExtend}
        >
            <svg viewBox="0 0 14 14" aria-hidden="true">
                <path
                    d="M7 3 L7 11 M3 7 L11 7"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                />
            </svg>
        </button>
        {#if handleCount > 2}
            <button
                type="button"
                class="rbtn delete"
                title="Delete (Del)"
                aria-label="Delete"
                style="transform: translate(calc(-50% + {endUI.del.x}px), calc(-50% + {endUI.del.y}px));"
                onclick={onDelete}
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
        {/if}
    </div>
{/if}

{#if fN}
    <aside class="strip" aria-hidden="true">
        <svg
            class="chart"
            viewBox="0 0 1000 {STRIP_H}"
            preserveAspectRatio="none"
        >
            <line
                class="baseline"
                x1={PAD_X}
                x2={1000 - PAD_X}
                y1={yOf(Y_BASE, STRIP_H)}
                y2={yOf(Y_BASE, STRIP_H)}
            />
            {#each fN as v, i (i)}
                <circle
                    class="dot"
                    cx={xOf(i, fN.length, 1000)}
                    cy={yOf(v, STRIP_H)}
                    r="1.6"
                />
            {/each}
            {#if solvedPath}
                <path class="solved" d={solvedPath} />
            {/if}
            {#if cartTFrac !== null}
                <line
                    class="cart-cursor"
                    x1={PAD_X + cartTFrac * (1000 - 2 * PAD_X)}
                    x2={PAD_X + cartTFrac * (1000 - 2 * PAD_X)}
                    y1={PAD_Y}
                    y2={STRIP_H - PAD_Y}
                />
            {/if}
        </svg>
        <div class="legend">
            <span class="tick top">+3g</span>
            <span class="tick base">1g</span>
            <span class="tick bot">−2g</span>
        </div>
    </aside>
{/if}

<style>
    :root,
    :global(:root) {
        --bg: rgba(14, 13, 12, 0.85);
        --bg-solid: #161413;
        --fg: #f0ece8;
        --muted: #a09890;
        --accent: #d49560;
        --accent-soft: rgba(212, 149, 96, 0.18);
        --danger: #e26d5c;
        --danger-soft: rgba(226, 109, 92, 0.16);
        --border: rgba(255, 255, 255, 0.08);
        --shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
    }

    canvas {
        display: block;
        width: 100%;
        height: 100%;
        cursor: default;
    }

    .warning {
        position: absolute;
        top: 16px;
        left: 50%;
        transform: translateX(-50%);
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        background: rgba(226, 109, 92, 0.12);
        border: 1px solid rgba(226, 109, 92, 0.5);
        border-radius: 999px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(6px);
        font-family: "Outfit", system-ui, sans-serif;
        font-size: 12px;
        color: #f0bdb1;
        user-select: none;
        pointer-events: none;
    }
    .warning svg {
        width: 14px;
        height: 14px;
        color: #e26d5c;
    }

    /* zero-size anchor pinned at the node's screen point; buttons orbit it. */
    .radial {
        position: absolute;
        width: 0;
        height: 0;
        z-index: 2;
        pointer-events: none;
        user-select: none;
    }
    .rbtn {
        all: unset;
        position: absolute;
        left: 0;
        top: 0;
        box-sizing: border-box;
        width: 30px;
        height: 30px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        background: var(--bg-solid);
        border: 1px solid var(--border);
        box-shadow: var(--shadow);
        cursor: pointer;
        pointer-events: auto;
        transition: background 120ms ease, border-color 120ms ease;
    }
    .rbtn svg {
        width: 14px;
        height: 14px;
    }
    .rbtn.extend {
        color: var(--accent);
    }
    .rbtn.extend:hover {
        background: var(--accent-soft);
        border-color: var(--accent);
    }
    .rbtn.delete {
        color: var(--danger);
    }
    .rbtn.delete:hover {
        background: var(--danger-soft);
        border-color: var(--danger);
    }

    .strip {
        /* extra-wide but capped for readability: centered, gutters on narrow
           screens, max 1280px (the standard wide-container ceiling). */
        position: absolute;
        left: 50%;
        transform: translateX(-50%);
        width: calc(100% - 32px);
        max-width: 1280px;
        bottom: 16px;
        height: 88px;
        padding: 6px 12px;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 6px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(4px);
        font-family: "Outfit", system-ui, sans-serif;
        user-select: none;
        -webkit-user-select: none;
        pointer-events: none;
    }

    .chart {
        display: block;
        width: 100%;
        height: 100%;
        overflow: visible;
    }

    .baseline {
        stroke: var(--accent);
        stroke-width: 1;
        stroke-dasharray: 2 4;
        opacity: 0.5;
    }

    .dot {
        fill: #cdc5bc;
        opacity: 0.55;
    }

    /* the solved (optimized) F_n over the baked draft dots */
    .solved {
        fill: none;
        stroke: var(--accent);
        stroke-width: 1.6;
        vector-effect: non-scaling-stroke;
    }

    .cart-cursor {
        stroke: #d49560;
        stroke-width: 1.2;
        opacity: 0.9;
        vector-effect: non-scaling-stroke;
    }

    .legend {
        position: absolute;
        inset: 6px 12px;
        pointer-events: none;
    }

    .tick {
        position: absolute;
        right: 0;
        font-family: "JetBrains Mono", ui-monospace, monospace;
        font-size: 9px;
        color: var(--muted);
        opacity: 0.55;
    }

    .tick.top {
        top: 0;
    }

    .tick.base {
        top: 50%;
        transform: translateY(-50%);
        color: var(--accent);
        opacity: 0.7;
    }

    .tick.bot {
        bottom: 0;
    }
</style>
