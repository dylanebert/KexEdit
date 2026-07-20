/** ephemeral editor state — the current selection. lives outside ECS because it
 *  doesn't persist (no save/load, no replay). plain mutable singleton; Svelte reads
 *  it via the per-RAF tick pattern in App.
 *
 *  there are no tools or modes: you select a node and drag it in the viewport, a
 *  force point on the timeline curve, a whole section, or the track START anchor —
 *  four mutually-exclusive selections (below), so a contextual action never fights
 *  over its target. */

interface EditorState {
    /** eid of the currently selected node (geo section), or null. */
    selection: number | null;
    /** stable id of the currently selected force point (force section), or null. */
    force: number | null;
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
    /** the snapping magnet toggle (AE model): a persistent editor preference, default
     *  on, `S` toggles it, and holding Ctrl/Cmd momentarily inverts it (`snapActive`).
     *  ephemeral like the rest of `editor` — a view preference, not authored track state. */
    snap: boolean;
    /** whether a pointer drag is in flight (any gesture routed through `beginDrag`). App
     *  projects it as `data-dragging` on the app root; a CSS rule then suppresses `:hover`
     *  on the chrome under the cursor. ephemeral, read via the per-RAF tick. */
    dragging: boolean;
}

export const editor: EditorState = {
    selection: null,
    force: null,
    section: null,
    start: false,
    context: null,
    snap: true,
    dragging: false,
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

/** select a node (null to clear). */
export function select(eid: number | null): void {
    editor.selection = eid;
    if (eid !== null) {
        editor.force = null;
        editor.section = null;
        editor.start = false;
    }
}

/** select a force point by its stable id (null to clear). */
export function selectForce(id: number | null): void {
    editor.force = id;
    if (id !== null) {
        editor.selection = null;
        editor.section = null;
        editor.start = false;
    }
}

/** select a section by its stable id (null to clear). */
export function selectSection(id: number | null): void {
    editor.section = id;
    if (id !== null) {
        editor.selection = null;
        editor.force = null;
        editor.start = false;
    }
}

/** select (or clear) the track START anchor — the initial-speed handle. */
export function selectStart(on: boolean): void {
    editor.start = on;
    if (on) {
        editor.selection = null;
        editor.force = null;
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
