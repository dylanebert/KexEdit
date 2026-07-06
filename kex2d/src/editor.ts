/** ephemeral editor state — the current selection. lives outside ECS because it
 *  doesn't persist (no save/load, no replay). plain mutable singleton; Svelte reads
 *  it via the per-RAF tick pattern in App.
 *
 *  there are no tools or modes: in geo mode you select a node and drag it freely,
 *  and when the selected node is the chain end the extend/delete actions appear; in
 *  force mode you select a force point on the timeline. the two selections are
 *  mutually exclusive by mode (a force-mode track has no nodes, and vice versa). */

interface EditorState {
    /** eid of the currently selected node (geo section), or null. */
    selection: number | null;
    /** stable id of the currently selected force point (force section), or null. */
    force: number | null;
    /** stable id of the currently selected section, or null. section selection is a
     *  highlight + the context-menu target; it does NOT gate authoring (force points
     *  are added by cursor position, nodes are dragged in the viewport). */
    section: number | null;
    /** the section right-click menu (Convert / Delete): screen position + target
     *  section id, or null when closed. shared so both the clip strip and the viewport
     *  span open the same menu, rendered once at the app root. */
    context: { x: number; y: number; section: number } | null;
}

export const editor: EditorState = {
    selection: null,
    force: null,
    section: null,
    context: null,
};

// the three selections are mutually exclusive — selecting one clears the others, so
// the contextual actions (node extend/trim, force field popover, section ops) never
// fight over which target a key press means.

/** select a node (null to clear). */
export function select(eid: number | null): void {
    editor.selection = eid;
    if (eid !== null) {
        editor.force = null;
        editor.section = null;
    }
}

/** select a force point by its stable id (null to clear). */
export function selectForce(id: number | null): void {
    editor.force = id;
    if (id !== null) {
        editor.selection = null;
        editor.section = null;
    }
}

/** select a section by its stable id (null to clear). */
export function selectSection(id: number | null): void {
    editor.section = id;
    if (id !== null) {
        editor.selection = null;
        editor.force = null;
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
