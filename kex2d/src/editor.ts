/** ephemeral editor state — the current selection. lives outside ECS because it
 *  doesn't persist (no save/load, no replay). plain mutable singleton; Svelte reads
 *  it via the per-RAF tick pattern in App.
 *
 *  there are no tools or modes: in geo mode you select a node and drag it freely,
 *  and when the selected node is the chain end the extend/delete actions appear; in
 *  force mode you select a force point on the timeline. the two selections are
 *  mutually exclusive by mode (a force-mode track has no nodes, and vice versa). */

interface EditorState {
    /** eid of the currently selected node (geo mode), or null. */
    selection: number | null;
    /** stable id of the currently selected force point (force mode), or null. */
    force: number | null;
}

export const editor: EditorState = {
    selection: null,
    force: null,
};

/** select a node (null to clear). */
export function select(eid: number | null): void {
    editor.selection = eid;
}

/** select a force point by its stable id (null to clear). */
export function selectForce(id: number | null): void {
    editor.force = id;
}
