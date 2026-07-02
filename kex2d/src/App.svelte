<script lang="ts">
import type { State } from "@dylanebert/shallot";
import { onMount } from "svelte";
import { attachControls } from "./controls";
import { editor, select } from "./editor";
import { extendTrack, history, trimTrack } from "./history";
import { relaxTrack } from "./relax";
import { type ConstraintReport, solveState } from "./solve";
import Timeline from "./Timeline.svelte";
import { bakeOut, Handle, lastHandle, Track } from "./track";
import { attachCanvas2D, viewTransform } from "./view";

const { ecs }: { ecs: State } = $props();
let canvas: HTMLCanvasElement;

let trackEid = $state<number | null>(null);
let tick = $state(0);

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
// the worst losing constraint, when a solve is live — the one-line "this
// demand is losing by X" summary. rendered only when something is actually
// unsatisfied (gate 2); the per-constraint detail lives on the timeline curve.
const losing = $derived.by((): ConstraintReport | null => {
    void tick;
    if (trackEid === null) return null;
    const st = solveState.get(trackEid);
    if (!st || st.suspended) return null;
    let worst: ConstraintReport | null = null;
    for (const r of st.report) {
        if (r.satisfied) continue;
        if (!worst || Math.abs(r.residual) > Math.abs(worst.residual)) worst = r;
    }
    return worst;
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

function onExtend(): void {
    select(extendTrack(history, ecs));
}
function onDelete(): void {
    if (trimTrack(history, ecs)) select(lastHandle(ecs));
}
// the relax verb (summoned only while a solve is live): re-baseline the
// sketch toward what the solve wants. the chain rebuild recycles node eids,
// so the selection clears.
const solveLive = $derived.by((): boolean => {
    void tick;
    if (trackEid === null) return false;
    const st = solveState.get(trackEid);
    return !!st && !st.suspended;
});
function onRelax(): void {
    if (trackEid === null) return;
    if (relaxTrack(history, ecs, trackEid)) select(null);
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

<!-- a constraint the solve can't satisfy: amber (a negotiation, not a failure),
     one line, only while it's actually losing. detail is on the timeline curve. -->
{#if losing}
    <div class="warning losing" class:below={infeasible} role="status">
        <span>
            {losing.kind === "pin"
                ? "Force pin"
                : losing.kind === "pos"
                  ? "Position pin"
                  : "Comfort band"} losing by
            {Math.abs(losing.residual).toFixed(1)}{losing.kind === "pos" ? "m" : "g"}
        </span>
    </div>
{/if}

<!-- the relax verb: summoned only while a solve is live (the sketch and the
     solve have diverged — the ghost shows it). one undoable commit. -->
{#if solveLive}
    <button type="button" class="relax" onclick={onRelax} title="Relax the sketch toward the solve">
        Relax
    </button>
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

<Timeline eid={trackEid} {tick} {ecs} />

<style>
    :root,
    :global(:root) {
        --bg-solid: #161413;
        --fg: #f0ece8;
        --muted: #a09890;
        --accent: #d49560;
        --accent-soft: rgba(212, 149, 96, 0.18);
        --pin: #ece8e3; /* authored force-pin marker (light, not accent) */
        --neutral: #b8b1a8; /* chrome: player icon, slider fill/thumb */
        --neutral-soft: rgba(255, 255, 255, 0.1);
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
    /* the losing-constraint chip: amber, not red — the solver is negotiating,
       not broken. stacks below the velocity banner when both are up. */
    .warning.losing {
        background: rgba(212, 149, 96, 0.12);
        border-color: rgba(212, 149, 96, 0.5);
        color: #ecd0b4;
    }
    .warning.losing.below {
        top: 52px;
    }

    /* the relax verb: a quiet corner action, present only while a solve is
       live. opaque surface, no dock. */
    .relax {
        all: unset;
        position: absolute;
        top: 16px;
        right: 16px;
        box-sizing: border-box;
        padding: 5px 14px;
        border-radius: 999px;
        background: var(--bg-solid);
        border: 1px solid var(--border);
        box-shadow: var(--shadow);
        font-family: "Outfit", system-ui, sans-serif;
        font-size: 12px;
        color: var(--fg);
        cursor: pointer;
        transition:
            background 120ms ease,
            border-color 120ms ease,
            transform 80ms ease;
    }
    .relax:hover {
        background: var(--accent-soft);
        border-color: var(--accent);
    }
    .relax:active {
        transform: scale(0.96);
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

</style>
