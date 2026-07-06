<script lang="ts">
import type { State } from "@dylanebert/shallot";
import { onMount } from "svelte";
import { attachControls } from "./controls";
import { closeContext, editor, select, selectSection } from "./editor";
import { convertSection, extendTrack, history, removeSection, trimTrack } from "./history";
import Timeline from "./Timeline.svelte";
import {
    bakeOut,
    Handle,
    lastHandle,
    samples,
    SectionKind,
    sectionHandles,
    sectionInfo,
    sections,
    Track,
} from "./track";
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
    const eid = editor.selection;
    if (eid === null) return 0;
    return sectionHandles(ecs, Handle.section.get(eid)).length;
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
    if (!canvas || eid === null || trackEid === null) return null;
    const section = Handle.section.get(eid);
    if (eid !== lastHandle(ecs, section)) return null;
    const s = samples.get(trackEid);
    const info = sectionInfo.get(section);
    if (!s || !info) return null;
    const tx = viewTransform(canvas);
    // nodes are section-local; the baked sample is where the node lands in world.
    const i = Handle.sample.get(eid);
    const x = tx.ox + s.posX[i] * tx.sx;
    const y = tx.oy + s.posY[i] * tx.sy;
    // world heading (local + the section entry heading) → screen direction; the view
    // flips Y (tx.sy < 0).
    const th = Handle.theta.get(eid) + info.entry.theta;
    const ang = Math.atan2(Math.sin(th) * tx.sy, Math.cos(th) * tx.sx);
    return {
        x,
        y,
        ext: { x: RADIAL_R * Math.cos(ang), y: RADIAL_R * Math.sin(ang) },
        del: { x: RADIAL_R * Math.cos(ang + TRASH_OFFSET), y: RADIAL_R * Math.sin(ang + TRASH_OFFSET) },
    };
});

function onExtend(): void {
    const eid = editor.selection;
    if (eid === null) return;
    select(extendTrack(history, ecs, Handle.section.get(eid)));
}
function onDelete(): void {
    const eid = editor.selection;
    if (eid === null) return;
    const section = Handle.section.get(eid);
    if (trimTrack(history, ecs, section)) select(lastHandle(ecs, section));
}

// the section context menu (Convert / Delete), summoned by right-click on a clip or a
// viewport span (both call editor.openContext). rendered once here at the app root so it
// can float over both the viewport and the dock; positioned at the cursor (screen px).
const ctx = $derived.by((): { x: number; y: number; section: number } | null => {
    void tick;
    return editor.context;
});
const ctxKind = $derived.by((): SectionKind | null => {
    void tick;
    if (ctx === null) return null;
    return sections(ecs).find((s) => s.id === ctx.section)?.kind ?? null;
});
function ctxConvert(): void {
    if (ctx === null) return;
    convertSection(history, ecs, ctx.section); // destructive, undoable
    closeContext();
}
function ctxDelete(): void {
    if (ctx === null) return;
    const id = ctx.section;
    closeContext();
    if (removeSection(history, ecs, id)) selectSection(null);
}
// dismiss the menu on any outside press or Escape (clicks on the menu itself pass through
// so its items can act before it closes).
$effect(() => {
    if (ctx === null) return;
    const onDown = (e: PointerEvent): void => {
        if ((e.target as HTMLElement | null)?.closest(".ctxmenu")) return;
        closeContext();
    };
    const onEsc = (e: KeyboardEvent): void => {
        if (e.key === "Escape") closeContext();
    };
    window.addEventListener("pointerdown", onDown, { capture: true });
    window.addEventListener("keydown", onEsc);
    return () => {
        window.removeEventListener("pointerdown", onDown, { capture: true });
        window.removeEventListener("keydown", onEsc);
    };
});
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

<!-- the section context menu (Convert / Delete): summoned by right-click on a clip or a
     viewport section span; occasional destructive ops, so hidden until summoned. -->
{#if ctx}
    <div class="ctxmenu" style="left: {ctx.x}px; top: {ctx.y}px" role="menu">
        <div class="ctx-item ctx-sub" role="menuitem" aria-haspopup="true">
            <span>Convert</span>
            <span class="chev">▸</span>
            <div class="ctx-submenu" role="menu">
                <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={ctxKind === SectionKind.Geo}
                    disabled={ctxKind === SectionKind.Geo}
                    onclick={ctxConvert}
                >
                    Geo
                </button>
                <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={ctxKind === SectionKind.Force}
                    disabled={ctxKind === SectionKind.Force}
                    onclick={ctxConvert}
                >
                    Force
                </button>
            </div>
        </div>
        <button type="button" class="ctx-item danger" role="menuitem" onclick={ctxDelete}>
            <span>Delete</span><span class="sk">Del</span>
        </button>
    </div>
{/if}

<Timeline {ecs} eid={trackEid} {tick} />

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

    /* the section context menu: an opaque floating surface at the cursor (border +
       shadow elevation), rows on one column. Convert is a submenu (▸) opening the kind
       list; Delete carries its Del shortcut, right-aligned, and reddens on hover. */
    .ctxmenu {
        position: fixed;
        z-index: 10;
        min-width: 132px;
        display: flex;
        flex-direction: column;
        padding: 3px;
        background: var(--bg-solid);
        border: 1px solid var(--border);
        border-radius: 6px;
        box-shadow: var(--shadow);
        font-family: "Outfit", system-ui, sans-serif;
        font-size: 12px;
        user-select: none;
        animation: ctx-in 120ms ease;
    }
    @keyframes ctx-in {
        from {
            opacity: 0;
            transform: translateY(-2px);
        }
    }
    /* one row, shared by the button rows and the submenu-parent div */
    .ctx-item {
        all: unset;
        box-sizing: border-box;
        position: relative;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 6px 10px;
        border-radius: 4px;
        color: var(--fg);
        cursor: pointer;
        transition: background 120ms ease, color 120ms ease;
    }
    .ctx-item:hover {
        background: var(--neutral-soft);
    }
    .ctx-item.danger:hover {
        background: var(--danger-soft);
        color: #f0bdb1;
    }
    .chev {
        color: var(--muted);
        font-size: 10px;
    }
    .sk {
        font-family: "JetBrains Mono", ui-monospace, monospace;
        font-size: 10px;
        color: var(--muted);
    }
    /* the Convert submenu: opens to the right of its parent row, on hover of the parent
       (a descendant, so hovering the submenu keeps the parent hovered — no JS state). */
    .ctx-submenu {
        position: absolute;
        left: 100%;
        top: -4px;
        display: none;
        flex-direction: column;
        min-width: 96px;
        padding: 3px;
        background: var(--bg-solid);
        border: 1px solid var(--border);
        border-radius: 6px;
        box-shadow: var(--shadow);
    }
    .ctx-sub:hover .ctx-submenu {
        display: flex;
    }
    .ctx-submenu button {
        all: unset;
        box-sizing: border-box;
        padding: 6px 10px;
        border-radius: 4px;
        color: var(--fg);
        cursor: pointer;
        transition: background 120ms ease;
    }
    .ctx-submenu button:hover:not(:disabled) {
        background: var(--neutral-soft);
    }
    .ctx-submenu button:disabled {
        color: var(--muted);
        cursor: default;
    }

</style>
