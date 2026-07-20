<script lang="ts">
import type { State } from "@dylanebert/shallot";
import { onMount } from "svelte";
import { attachControls } from "./controls";
import {
    beginDrag,
    closeContext,
    editor,
    select,
    selectSection,
    selectStart,
    toggleSnap,
} from "./editor";
import {
    beginV0,
    commit,
    convertSection,
    extendTrack,
    history,
    removeSection,
    trimTrack,
} from "./history";
import Timeline from "./Timeline.svelte";
import {
    bakeOut,
    Handle,
    lastHandle,
    samples,
    SectionKind,
    sectionAt,
    sectionHandles,
    sectionInfo,
    sections,
    setTrackV0,
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

// the snapping magnet's persistent state (read through the per-RAF tick) — the viewport
// toggle's lit/quiet state.
const snapOn = $derived.by((): boolean => {
    void tick;
    return editor.snap;
});

const infeasible = $derived.by((): boolean => {
    void tick;
    if (trackEid === null) return false;
    const out = bakeOut.get(trackEid);
    return !!out && out.firstInfeasible >= 0;
});
// reflect the drag flag as `data-dragging` on the app root — the CSS hook a drag uses to
// suppress `:hover` on the chrome under the cursor (both this component's and the dock's).
// read through the per-RAF tick like the rest of the projected editor state.
const dragging = $derived.by((): boolean => {
    void tick;
    return editor.dragging;
});
$effect(() => {
    document.getElementById("app")?.toggleAttribute("data-dragging", dragging);
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
// a summoned surface lives only as long as its subject (root ui.md): the menu's visibility
// DERIVES from its target section still existing, so any death path — Del, undo, a programmatic
// edit — dismisses it by derivation, no per-path close call. the effect below clears the stale
// target id once the subject is gone, so an undo that restores the same id can't resurrect it.
const ctx = $derived.by((): { x: number; y: number; section: number } | null => {
    void tick;
    const c = editor.context;
    if (c === null || sectionAt(ecs, c.section) === null) return null;
    return c;
});
$effect(() => {
    // kept out of the derivation (deriving stays side-effect-free): once the subject is gone,
    // clear the dangling target so a later reappearance of the id doesn't re-open the menu.
    if (editor.context !== null && ctx === null) closeContext();
});
const ctxKind = $derived.by((): SectionKind | null => {
    void tick;
    if (ctx === null) return null;
    return sections(ecs).find((s) => s.id === ctx.section)?.kind ?? null;
});
// the kind the convert flips TO — the label names the destination, not the toggle.
const ctxTarget = $derived(ctxKind === SectionKind.Force ? "Geo" : "Force");
function ctxConvert(): void {
    if (ctx === null) return;
    convertSection(history, ecs, ctx.section); // destructive, undoable
    closeContext();
}
function ctxDelete(): void {
    if (ctx === null) return;
    // no explicit close: removing the section makes `ctx` derive null, so the menu dismisses
    // by subject existence (one mechanism) and the $effect clears the stale target id.
    if (removeSection(history, ecs, ctx.section)) selectSection(null);
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

// the track START anchor (initial-speed handle): selectable in the viewport, it summons
// a v0 field popover at its screen point — the world origin under the camera. the anchor
// recomputes per tick (`startPos`), so it tracks a viewport pan/zoom; it holds still
// during the v0 scrub only because that gesture never moves the camera (root ui.md
// "nothing moves under its own gesture"), so no anchor-freeze is needed here.
const startSel = $derived.by((): boolean => {
    void tick;
    return editor.start;
});
const v0 = $derived.by((): number => {
    void tick;
    return trackEid === null ? 0 : Track.v0.get(trackEid);
});
const startPos = $derived.by((): { x: number; y: number } | null => {
    void tick;
    if (!canvas || trackEid === null) return null;
    const tx = viewTransform(canvas);
    return { x: tx.ox, y: tx.oy }; // the world origin's screen point (the START diamond)
});

const V0_SCRUB = 0.1; // m/s per px — the START field's label-scrub rate
// the v₀ field: a scrub handle (drag the label) + a typed input, each committing one
// undo entry (begin → set → commit). the label scrub rounds to the field's precision so
// the number never shows jitter.
function v0ScrubStart(e: PointerEvent): void {
    if (trackEid === null) return;
    const te = trackEid;
    e.preventDefault();
    const label = e.currentTarget as HTMLElement;
    beginDrag(label, e.pointerId);
    beginV0(te);
    let acc = Track.v0.get(te);
    const move = (ev: PointerEvent): void => {
        acc = Math.max(0, acc + ev.movementX * V0_SCRUB);
        setTrackV0(te, Math.round(acc * 10) / 10);
    };
    const up = (): void => {
        label.removeEventListener("pointermove", move);
        label.removeEventListener("pointerup", up);
        label.removeEventListener("pointercancel", up);
        commit(history);
    };
    label.addEventListener("pointermove", move);
    label.addEventListener("pointerup", up);
    // a cancelled pointer must still close the gesture (one gesture at a time).
    label.addEventListener("pointercancel", up);
}
function onV0Field(e: Event): void {
    if (trackEid === null) return;
    const val = Number.parseFloat((e.currentTarget as HTMLInputElement).value);
    if (!Number.isFinite(val)) return; // guard a cleared field
    beginV0(trackEid);
    setTrackV0(trackEid, val);
    commit(history);
}
// field keys: Enter commits (blur fires change); Escape reverts and blurs. after blur the
// window handler (controls.ts, skips inputs) takes the NEXT Escape to deselect the START.
function v0Keydown(e: KeyboardEvent, reset: string): void {
    const input = e.currentTarget as HTMLInputElement;
    if (e.key === "Enter") input.blur();
    else if (e.key === "Escape") {
        input.value = reset;
        input.blur();
    }
}
// dismiss the v0 popover on an outside press. canvas clicks route through controls (which
// re-picks the START or deselects); popover clicks keep it open.
$effect(() => {
    if (!startSel) return;
    const onDown = (e: PointerEvent): void => {
        const t = e.target as HTMLElement | null;
        if (t?.closest(".vtip") || t === canvas) return;
        selectStart(false);
    };
    window.addEventListener("pointerdown", onDown, { capture: true });
    return () => window.removeEventListener("pointerdown", onDown, { capture: true });
});
</script>

<canvas bind:this={canvas}></canvas>

<!-- the viewport toggle cluster: a small persistent overlay top-left of the shaping
     viewport — the Blender viewport-header precedent collapsed to an overlay (a viewport
     affordance, not a second dock). the home for viewport toggles; today just the snap
     magnet. lit when on (default), dimmed when off; `S` also toggles, Ctrl/Cmd bypasses
     per-gesture. -->
<div class="viewport-tools" aria-label="Viewport tools">
    <button
        class="vtool"
        class:on={snapOn}
        type="button"
        onclick={toggleSnap}
        title="Snapping (S)"
        aria-label="Snapping"
        aria-pressed={snapOn}
    >
        <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
                d="M4 2 L4 8 a4 4 0 0 0 8 0 L12 2 L9.5 2 L9.5 8 a1.5 1.5 0 0 1 -3 0 L6.5 2 Z"
                fill="currentColor"
                fill-rule="evenodd"
            />
            <rect x="4" y="2" width="2.5" height="2.2" fill="var(--danger)" />
            <rect x="9.5" y="2" width="2.5" height="2.2" fill="var(--geo)" />
        </svg>
    </button>
</div>

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
     viewport section span; occasional destructive ops, so hidden until summoned. Convert
     is a single contextual item naming the target kind (a section is one of two kinds, so
     the flip is unambiguous) — one click, no submenu. -->
{#if ctx}
    <div class="ctxmenu menu" style="left: {ctx.x}px; top: {ctx.y}px" role="menu">
        <button type="button" class="menu-item" role="menuitem" onclick={ctxConvert}>
            <span>Convert to {ctxTarget}</span>
        </button>
        <button type="button" class="menu-item danger" role="menuitem" onclick={ctxDelete}>
            <span>Delete</span><span class="sk">Del</span>
        </button>
    </div>
{/if}

<!-- the track START anchor's initial-speed field: a popover summoned AT the diamond (on
     the object). one row — the v₀ label doubles as a scrub handle, the input types it;
     each edit is one undo entry. -->
{#if startSel && startPos}
    {@const vText = v0.toFixed(1)}
    <div class="vtip" style="left: {startPos.x}px; top: {startPos.y}px">
        <div class="fld">
            <span class="key" onpointerdown={v0ScrubStart} role="presentation">v₀</span>
            <input
                type="number"
                step="0.5"
                min="0"
                value={vText}
                onchange={onV0Field}
                onfocus={(e) => e.currentTarget.select()}
                onkeydown={(e) => v0Keydown(e, vText)}
                aria-label="Initial speed (m/s)"
            />
            <span class="unit">m/s</span>
        </div>
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
        --geo: #78a5d6; /* geo-section kind color (viewport polyline + clip strip); force's is --accent */
        /* selection = a brighter, still-saturated OKLCH variant of the element's own kind
           color (the Ableton/Premiere clip idiom); the relative-color twin of colors.ts
           `selected()` — lift L, boost C, hold hue (an sRGB white-mix would drain chroma). */
        --geo-sel: oklch(from var(--geo) calc(l + 0.14) calc(c * 1.15) h);
        --accent-sel: oklch(from var(--accent) calc(l + 0.14) calc(c * 1.15) h);
        --pin: #ece8e3; /* authored force-pin marker (light, not accent) */
        --neutral: #b8b1a8; /* chrome: player icon, slider fill/thumb */
        --neutral-soft: rgba(255, 255, 255, 0.1);
        --danger: #e26d5c;
        --danger-soft: rgba(226, 109, 92, 0.16);
        --snap: #e879b0; /* snap alignment-guide flash (timeline + viewport); mirrors render.ts COLOR_SNAP */
        --border: rgba(255, 255, 255, 0.08);
        --shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
    }

    canvas {
        display: block;
        width: 100%;
        height: 100%;
        cursor: default;
    }

    /* hover suppression while a drag is in flight (see Timeline.svelte): `data-dragging` on
       the app root kills pointer-events on this component's hoverable chrome too, so a node
       drag sweeping over the radial buttons / a summoned menu doesn't flash their `:hover`.
       the dragged surface holds pointer capture, so it's unaffected. */
    :global([data-dragging]) .rbtn,
    :global([data-dragging]) .ctxmenu,
    :global([data-dragging]) .vtool,
    :global([data-dragging]) .vtip {
        pointer-events: none;
        user-select: none;
    }

    /* the viewport toggle cluster: a persistent overlay top-left of the shaping viewport —
       the Blender viewport-header precedent collapsed to an overlay (a viewport affordance,
       not a second dock). a column so future toggles stack under the magnet; opaque surface,
       elevation from border + shadow (root ui.md). */
    .viewport-tools {
        position: absolute;
        top: 16px;
        left: 16px;
        z-index: 2;
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 3px;
        background: var(--bg-solid);
        border: 1px solid var(--border);
        border-radius: 6px;
        box-shadow: var(--shadow);
        user-select: none;
        -webkit-user-select: none;
    }
    /* a viewport toggle: quiet muted icon by default, accent-lit when on — a persistent
       editor preference, not a loud control (the removed dock-corner snap toggle's look). */
    .vtool {
        all: unset;
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        border-radius: 4px;
        color: var(--muted);
        cursor: pointer;
        opacity: 0.6;
        transition: opacity 120ms ease, color 120ms ease, background 120ms ease;
    }
    .vtool:hover {
        opacity: 0.9;
        background: rgba(255, 255, 255, 0.06);
    }
    .vtool.on {
        color: var(--accent);
        opacity: 1;
    }
    .vtool svg {
        width: 15px;
        height: 15px;
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

    /* the shared menu language (root ui.md one-language): the append flyout's standard menu
       look, lifted to a global class so the section context menu and the flyout are two
       instances of ONE style — opaque surface, quiet muted rows, an accent-soft hover wash.
       each instance adds only its own position, width, and entrance animation. */
    :global(.menu) {
        display: flex;
        flex-direction: column;
        background: var(--bg-solid);
        border: 1px solid var(--border);
        border-radius: 5px;
        box-shadow: var(--shadow);
        overflow: hidden;
        font-family: "Outfit", system-ui, sans-serif;
        font-size: 11px;
        user-select: none;
        -webkit-user-select: none;
    }
    :global(.menu-item) {
        all: unset;
        box-sizing: border-box;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 5px 10px;
        color: var(--muted);
        cursor: pointer;
        transition: background 120ms ease, color 120ms ease;
    }
    :global(.menu-item:hover) {
        background: var(--accent-soft);
        color: var(--fg);
    }
    /* the destructive row: a red text tint (the danger token, the only semantic color), held
       on hover while the row wash matches every other item. */
    :global(.menu-item.danger),
    :global(.menu-item.danger:hover) {
        color: var(--danger);
    }
    /* an inline shortcut hint, right-aligned by the row's space-between. */
    :global(.menu-item .sk) {
        font-family: "JetBrains Mono", ui-monospace, monospace;
        font-size: 10px;
        color: var(--muted);
    }

    /* the section context menu: an instance of `.menu` at the cursor — only its fixed
       position, width, and entrance are its own. */
    .ctxmenu {
        position: fixed;
        z-index: 10;
        min-width: 132px;
        animation: ctx-in 120ms ease;
    }
    @keyframes ctx-in {
        from {
            opacity: 0;
            transform: translateY(-2px);
        }
    }

    /* the START anchor's initial-speed popover: the same floating-field surface as the
       timeline point popover (opaque, one row — scrub-handle key · value · unit, no boxed
       input), anchored above the START diamond. */
    .vtip {
        position: absolute;
        z-index: 3;
        display: flex;
        flex-direction: column;
        padding: 3px 0;
        background: var(--bg-solid);
        border: 1px solid var(--border);
        border-radius: 5px;
        box-shadow: var(--shadow);
        overflow: hidden; /* the focus wash clips to the rounded corners */
        transform: translate(-50%, calc(-100% - 12px));
        font-family: "JetBrains Mono", ui-monospace, monospace;
        animation: vtip-in 120ms ease;
    }
    @keyframes vtip-in {
        from {
            opacity: 0;
        }
    }
    .vtip .fld {
        display: grid;
        grid-template-columns: 18px 44px auto;
        align-items: center;
        gap: 6px;
        padding: 4px 9px;
        font-size: 11px;
        transition: background 120ms ease;
    }
    .vtip .fld:focus-within {
        background: rgba(255, 255, 255, 0.04);
    }
    /* the key doubles as the scrub handle (the shallot cell-handle treatment): a
       full-row-height cell whose hit area extends to the row edges, ew-resize + wash on
       hover. */
    .vtip .key {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        align-self: stretch;
        margin: -4px 0 -4px -9px;
        padding: 4px 0 4px 9px;
        color: var(--muted);
        cursor: ew-resize;
        user-select: none;
        -webkit-user-select: none;
        touch-action: none;
        transition: color 120ms ease, background 120ms ease;
    }
    .vtip .key:hover {
        color: var(--fg);
        background: rgba(255, 255, 255, 0.05);
    }
    .vtip .fld:focus-within .key {
        color: var(--fg);
    }
    .vtip .unit {
        color: var(--muted);
    }
    .vtip input {
        width: 44px;
        box-sizing: border-box;
        padding: 0;
        background: none;
        border: none;
        outline: none;
        color: var(--fg);
        font: inherit;
        font-variant-numeric: tabular-nums;
        text-align: right;
        appearance: textfield; /* no native spinner chrome; arrow keys still step */
    }
    .vtip input::-webkit-outer-spin-button,
    .vtip input::-webkit-inner-spin-button {
        -webkit-appearance: none;
        margin: 0;
    }
    .vtip input::selection {
        background: var(--accent-soft);
    }

</style>
