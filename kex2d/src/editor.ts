/** ephemeral editor state — the current selection. lives outside ECS because it
 *  doesn't persist (no save/load, no replay). plain mutable singleton; Svelte reads
 *  it via the per-RAF tick pattern in App.
 *
 *  there are no tools or modes: you select a node and drag it in the viewport, a
 *  force point on the timeline curve, a whole section, or the track START anchor —
 *  four mutually-exclusive selections (below), so a contextual action never fights
 *  over its target. */

import type { State } from "@dylanebert/shallot";
import { Handle, handleAt } from "./track";

/** the editor surface the pointer is over — the router for surface-scoped keys
 *  (the Blender/Unity hovered-surface model). */
export type Surface = "viewport" | "timeline";

interface EditorState {
    /** eid of the currently selected node (geo section), or null. */
    selection: number | null;
    /** eid of the node in tangent-edit mode (its handles are summoned), or null — a
     *  sub-mode layered on node selection: `tangentEdit !== null` implies
     *  `selection === tangentEdit`. entered by double-clicking a node (Figma vector edit);
     *  any selection change to a different subject, Esc, or click-away exits it. NOT a fifth
     *  mutually-exclusive selection — a refinement of the node-selection state. */
    tangentEdit: number | null;
    /** stable id of the currently selected force point (force section), or null. */
    force: number | null;
    /** stable id of the force keyframe in handle-edit sub-mode (its in/out handles are
     *  summoned), or null — the force analogue of `tangentEdit`, layered on force selection:
     *  `forceEdit !== null` implies `force === forceEdit`. entered by double-clicking a
     *  keyframe (the diamond hit beats insertion); a different selection, Esc, or click-away
     *  exits it. NOT a fifth mutually-exclusive selection. */
    forceEdit: number | null;
    /** stable id of the currently selected section, or null. section selection is a
     *  highlight + the context-menu target; it does NOT gate authoring (force points
     *  are added by cursor position, nodes are dragged in the viewport). */
    section: number | null;
    /** whether the track START anchor is selected. there's one START per track, so a
     *  boolean; selecting it summons the initial-speed (v0) field popover. */
    start: boolean;
    /** the section right-click menu (Convert / Delete): screen position + target
     *  section id, or null when closed. shared so both the clip strip and the viewport
     *  span open the same menu, rendered once at the app root. */
    context: { x: number; y: number; section: number } | null;
    /** the node context menu (`Handles` toggle + a `Tangents ▸` submenu): screen position +
     *  the target node eid, or null when closed. opened by right-click on any pickable node
     *  (any mode) — the same shared menu language as `context`, rendered once at the app root. */
    nodeMenu: { x: number; y: number; eid: number } | null;
    /** the force keyframe right-click menu (Delete / Easing ▸ / Handles / Reset): screen
     *  position + the target point's stable id, or null when closed. the force analogue of
     *  `nodeMenu`, the same shared menu language. */
    forceMenu: { x: number; y: number; id: number } | null;
    /** the snapping magnet toggle (AE model): a persistent editor preference, default
     *  on, `S` toggles it, and holding Ctrl/Cmd momentarily inverts it (`snapActive`).
     *  ephemeral like the rest of `editor` — a view preference, not authored track state. */
    snap: boolean;
    /** whether a pointer drag is in flight (any gesture routed through `beginDrag`). App
     *  projects it as `data-dragging` on the app root; a CSS rule then suppresses `:hover`
     *  on the chrome under the cursor. ephemeral, read via the per-RAF tick. */
    dragging: boolean;
    /** which surface the pointer is over — routes the surface-scoped keys (`F` frames it,
     *  arrows act on it), ending the viewport-nudge vs timeline-playhead double-fire.
     *  defaults to the viewport, so keys route there before the pointer visits the dock;
     *  the dock's enter/leave is the only thing that flips it (the rest is the viewport). */
    hover: Surface;
}

export const editor: EditorState = {
    selection: null,
    tangentEdit: null,
    force: null,
    forceEdit: null,
    section: null,
    start: false,
    context: null,
    nodeMenu: null,
    forceMenu: null,
    snap: true,
    dragging: false,
    hover: "viewport",
};

// ── drag gesture substrate ──
// every pointer drag routes through `beginDrag`. it (1) takes pointer capture — for event
// routing and, more importantly, so hit-testing bypasses the dragged surface, which the
// hover-suppression CSS below marks `pointer-events: none`; and (2) sets `editor.dragging`,
// which App reflects as `data-dragging` on the app root. that attribute drives one CSS rule
// (`pointer-events: none` on the hoverable chrome), the ONLY thing that stops `:hover`
// firing on chrome under the cursor mid-drag — CSS `:hover` ignores pointer capture in both
// Chromium and Firefox, so capture alone can't fix it.
//
// `beginDrag`'s own listeners are the SOLE release authority: they clear the flag + capture
// on `pointerup`/`pointercancel`, keyed on the captured pointerId so a superseded drag's
// late release can't clear a newer one (a new `beginDrag` supersedes a stale one). they
// listen on `window`, not the captured element, so a missed or failed capture still catches
// the release (window sees every pointer event). the per-gesture handlers do NOT clear the
// flag; only the unmount teardowns call `endDrag()` directly, for a drag torn down without a
// release event.
let dragEl: Element | null = null;
let dragId = -1;

/** open a drag gesture on `el` for `pointerId`: take pointer capture and raise the drag
 *  flag; both clear on the pointer's `pointerup`/`pointercancel`. re-entrant safe. */
export function beginDrag(el: Element, pointerId: number): void {
    if (dragEl) endDrag(); // a prior drag whose release was missed — clear before claiming
    dragEl = el;
    dragId = pointerId;
    editor.dragging = true;
    try {
        el.setPointerCapture(pointerId);
    } catch {
        // capture is best-effort (a detached element throws); the window listeners below
        // still catch the release and the flag still drives suppression
    }
    window.addEventListener("pointerup", onDragRelease);
    window.addEventListener("pointercancel", onDragRelease);
    el.addEventListener("lostpointercapture", onDragRelease);
}

function onDragRelease(e: Event): void {
    // ignore a stale listener firing for a pointer that isn't the active drag's
    if (e instanceof PointerEvent && e.pointerId !== dragId) return;
    endDrag();
}

/** clear the drag flag + release capture (idempotent). driven by `beginDrag`'s own release
 *  listeners; also called directly by the unmount teardowns for a drag with no release. */
export function endDrag(): void {
    if (!dragEl) return;
    const el = dragEl;
    const id = dragId;
    dragEl = null;
    dragId = -1;
    editor.dragging = false;
    window.removeEventListener("pointerup", onDragRelease);
    window.removeEventListener("pointercancel", onDragRelease);
    el.removeEventListener("lostpointercapture", onDragRelease);
    try {
        if (el.hasPointerCapture(id)) el.releasePointerCapture(id);
    } catch {
        // already released / detached
    }
}

/** flip the snapping magnet (the `S` key). */
export function toggleSnap(): void {
    editor.snap = !editor.snap;
}

/** whether snapping is active for a gesture, given whether the Ctrl/Cmd bypass modifier
 *  is held: the persistent toggle XOR the momentary modifier (the AE magnet — hold to
 *  invert, so a bypass turns it off while on and summons it while off). */
export const snapActive = (mod: boolean): boolean => editor.snap !== mod;

// the four selections are mutually exclusive — selecting one clears the others, so
// the contextual actions (node extend/trim, force field popover, section ops, v0
// popover) never fight over which target a key press means.

/** select a node (null to clear). selecting a *different* subject (another node, null,
 *  empty space) exits tangent edit; re-selecting the edited node keeps it (so grabbing its
 *  own handle or nudging it doesn't drop the mode). */
export function select(eid: number | null): void {
    if (eid !== editor.tangentEdit) editor.tangentEdit = null;
    editor.selection = eid;
    if (eid !== null) {
        editor.force = null;
        editor.forceEdit = null;
        editor.section = null;
        editor.start = false;
    }
}

/** enter tangent-edit mode on a node — the summon (double-click). selects the node (clearing
 *  the other selections) and layers the edit sub-mode on it, so its handles render and grab.
 *  node 0 (the entry anchor) is editable too — it exposes its single out-handle (the entry
 *  handle), reached at the START diamond or, at a geo→geo boundary, stitched onto its coincident
 *  upstream tip. */
export function enterTangentEdit(eid: number): void {
    editor.selection = eid;
    editor.force = null;
    editor.forceEdit = null;
    editor.section = null;
    editor.start = false;
    editor.tangentEdit = eid;
}

/** exit tangent-edit mode, keeping the node selected (Esc's first peel). */
export function exitTangentEdit(): void {
    editor.tangentEdit = null;
}

/** select a force point by its stable id (null to clear). selecting a *different* subject
 *  (another point, null) exits handle edit; re-selecting the edited point keeps it (so
 *  grabbing its own diamond or nudging it doesn't drop the mode — mirrors `select`). */
export function selectForce(id: number | null): void {
    if (id !== editor.forceEdit) editor.forceEdit = null;
    editor.force = id;
    if (id !== null) {
        editor.selection = null;
        editor.tangentEdit = null;
        editor.section = null;
        editor.start = false;
    }
}

/** enter handle-edit mode on a force keyframe — the summon (double-click). selects the point
 *  (clearing the other selections) and layers the edit sub-mode on it, so its in/out handles
 *  render and grab. mirrors geo's `enterTangentEdit`. */
export function enterForceEdit(id: number): void {
    editor.force = id;
    editor.selection = null;
    editor.tangentEdit = null;
    editor.section = null;
    editor.start = false;
    editor.forceEdit = id;
}

/** exit force handle-edit mode, keeping the point selected (Esc's first peel). */
export function exitForceEdit(): void {
    editor.forceEdit = null;
}

/** select a section by its stable id (null to clear). */
export function selectSection(id: number | null): void {
    editor.section = id;
    if (id !== null) {
        editor.selection = null;
        editor.tangentEdit = null;
        editor.force = null;
        editor.forceEdit = null;
        editor.start = false;
    }
}

/** select (or clear) the track START anchor — the initial-speed handle. */
export function selectStart(on: boolean): void {
    editor.start = on;
    if (on) {
        editor.selection = null;
        editor.tangentEdit = null;
        editor.force = null;
        editor.forceEdit = null;
        editor.section = null;
    }
}

/** open the section context menu at a screen point, targeting a section (also selects
 *  it, so the target reads highlighted). */
export function openContext(x: number, y: number, section: number): void {
    selectSection(section);
    editor.context = { x, y, section };
}

/** close the section context menu. */
export function closeContext(): void {
    editor.context = null;
}

/** open the node context menu at a screen point, targeting a pickable node. */
export function openNodeMenu(x: number, y: number, eid: number): void {
    editor.nodeMenu = { x, y, eid };
}

/** close the node context menu. */
export function closeNodeMenu(): void {
    editor.nodeMenu = null;
}

/** open the force keyframe context menu at a screen point, targeting a point (also selects
 *  it, so the target reads highlighted). */
export function openForceMenu(x: number, y: number, id: number): void {
    selectForce(id);
    editor.forceMenu = { x, y, id };
}

/** close the force keyframe context menu. */
export function closeForceMenu(): void {
    editor.forceMenu = null;
}

// ── history selection hook ────────────────────────────────────────────────────────
// the editor's snapshot/restore for undo/redo, injected into `history` at boot (`setSelectionHook`)
// so the coupling points inward — history calls this, never imports editor. a NODE is snapshotted by
// its stable (section, order), not its eid: `restoreSection`/`restoreAll` recycle the allocator LIFO,
// so a raw eid would remap to a DIFFERENT node after an undo. force/section address by stable id, the
// START by a flag. undo restores each command's pre-selection, redo its post; a selection change
// alone is never a command.

type SelSnapshot =
    | { kind: "node"; section: number; order: number; editing: boolean }
    | { kind: "force"; id: number; editing: boolean }
    | { kind: "section"; id: number }
    | { kind: "start" }
    | null;

/** the `SelectionHook` (`history.ts`) the app injects at boot: capture the current selection in a
 *  restorable form + restore it. history holds the snapshot opaquely. */
export const selectionHook = {
    snapshot(ecs: State): SelSnapshot {
        const sel = editor.selection;
        if (sel !== null && ecs.has(sel, Handle)) {
            return {
                kind: "node",
                section: Handle.section.get(sel),
                order: Handle.order.get(sel),
                editing: editor.tangentEdit === sel,
            };
        }
        if (editor.force !== null)
            return { kind: "force", id: editor.force, editing: editor.forceEdit === editor.force };
        if (editor.section !== null) return { kind: "section", id: editor.section };
        if (editor.start) return { kind: "start" };
        return null;
    },
    restore(ecs: State, snap: unknown): void {
        editor.nodeMenu = null; // its rows (checked mode, enablement) went stale when the document changed
        editor.forceMenu = null; // same — the force keyframe menu's rows go stale on any restore
        const s = snap as SelSnapshot;
        if (s === null) {
            select(null); // clears the selection + the tangent-edit sub-mode
            editor.force = null;
            editor.forceEdit = null;
            editor.section = null;
            editor.start = false;
            return;
        }
        switch (s.kind) {
            case "node": {
                const eid = handleAt(ecs, s.section, s.order); // re-resolve across the eid recycle
                select(eid); // null when the node didn't survive — clears cleanly
                editor.tangentEdit = eid !== null && s.editing ? eid : null;
                break;
            }
            case "force":
                selectForce(s.id);
                editor.forceEdit = s.editing ? s.id : null; // re-summon the handles if they were open
                break;
            case "section":
                selectSection(s.id);
                break;
            case "start":
                selectStart(true);
                break;
        }
    },
};
