<script lang="ts">
import type { State } from "@dylanebert/shallot";
import { onMount } from "svelte";
import { attachControls } from "./controls";
import { editor } from "./editor";
import { inputOwnsKey } from "./keys";
import { history, removeRecord } from "./history";
import Timeline from "./Timeline.svelte";
import { bakeOut, Track } from "./track";
import { attachCanvas2D } from "./view";

/** The app shell over the lane substrate (spec `kex2d-segment-gestures` S3): a canvas that
 *  draws the bake, the lane timeline docked over it, and the standing infeasibility banner.
 *  Authoring lives in the dock — one row per lane, spans edited in place — and the canvas
 *  stays a READ-ONLY view of the bake until the geo control wiring returns over pitch
 *  segments. Every authoring surface this component used to host — the node ring and
 *  manipulator knobs, the node/section context menus, pin mode's panel, the conversion modal
 *  and the track-start dissipation fields — went with the gestures they drove
 *  (`retired/pose-ux`); `commands.ts`/`cli.ts` remain the headless authoring surface. */

const { ecs, canvas, root }: { ecs: State; canvas: HTMLCanvasElement; root: HTMLElement } = $props();
const isDev = import.meta.env?.DEV === true;

let trackEid = $state<number | null>(null);
let tick = $state(0);
let timelineVisible = $state(true);

let controls: ReturnType<typeof attachControls> | undefined;

onMount(() => {
    const inputKey = (e: KeyboardEvent): void => {
        const target = e.target as HTMLElement | null;
        const field = !!target && (target.matches("input, textarea, select") || target.isContentEditable);
        if (inputOwnsKey(e.key, field, document.querySelector(".menu-anchor") !== null)) e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", inputKey, true);
    attachCanvas2D(canvas);
    controls = attachControls(canvas, ecs);
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
    // DEV composition witnesses use the same mounted component and ECS, never a test State.
    const hook = isDev
        ? (window as unknown as { __kex: Record<string, unknown> }).__kex
        : undefined;
    if (hook) {
        hook.showTimeline = (visible: boolean): void => { timelineVisible = visible; };
        hook.removeRecord = (id: number) => removeRecord(history, ecs, id);
    }
    return () => {
        if (hook) { delete hook.showTimeline; delete hook.removeRecord; }
        window.removeEventListener("keydown", inputKey, true);
        controls?.detach();
        cancelAnimationFrame(raf);
    };
});

const infeasible = $derived.by((): boolean => {
    void tick;
    if (trackEid === null) return false;
    const out = bakeOut.get(trackEid);
    return !!out && out.firstInfeasible >= 0;
});

// reflect the drag flag as `data-dragging` on the app root — the CSS hook a drag uses to
// suppress `:hover` on the chrome under the cursor. read through the per-RAF tick like the
// rest of the projected editor state.
const dragging = $derived.by((): boolean => {
    void tick;
    return editor.dragging;
});
$effect(() => {
    root.toggleAttribute("data-dragging", dragging);
});
</script>

<svelte:head>
    <title>kex2d</title>
    <link rel="icon" type="image/svg+xml" href="/icon.svg" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Outfit:wght@400;500;600;700&display=swap" rel="stylesheet" />
</svelte:head>

<!-- the standing infeasibility banner: the one status surface a read-only view still owes,
     since an infeasible bake is a property of the document, not of a gesture. -->
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

{#if timelineVisible}<Timeline {ecs} eid={trackEid} {tick} />{/if}

<style>
    :root,
    :global(:root) {
        --bg-solid: #161413;
        --fg: #f0ece8;
        --muted: #a09890;
        --accent: #d49560;
        --accent-soft: rgba(212, 149, 96, 0.18);
        --geo: #78a5d6; /* geo-run kind color (viewport polyline + clip strip); force's is --accent */
        /* selection = a brighter, still-saturated OKLCH variant of the element's own kind
           color (the Ableton/Premiere clip idiom); the relative-color twin of colors.ts
           `selected()` — lift L, boost C, hold hue (an sRGB white-mix would drain chroma). */
        --geo-sel: oklch(from var(--geo) calc(l + 0.14) calc(c * 1.15) h);
        --accent-sel: oklch(from var(--accent) calc(l + 0.14) calc(c * 1.15) h);
        --pin: #ece8e3;
        --neutral: #b8b1a8; /* chrome: player icon, slider fill/thumb */
        --neutral-soft: rgba(255, 255, 255, 0.1);
        --danger: #e26d5c;
        --danger-soft: rgba(226, 109, 92, 0.16);
        --guide: #9aa0a6; /* snap-guide neutral gray; mirrors colors.ts COLOR_GUIDE_RAY */
        --dim: rgba(22, 20, 19, 0.55); /* out-of-scope dim wash; mirrors colors.ts DIM_WASH */
        --ease-out: cubic-bezier(0.33333, 1, 0.66667, 1); /* the one easing token (ui.md Motion) */
        --border: rgba(255, 255, 255, 0.08);
        --shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
    }

    /* the standing infeasibility banner, top-center: status shifts nothing beside it. */
    .warning {
        position: absolute;
        top: 16px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 4;
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
</style>
