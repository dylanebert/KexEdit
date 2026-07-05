/** ephemeral editor state — the current node selection. lives outside ECS
 *  because it doesn't persist (no save/load, no replay). plain mutable singleton;
 *  Svelte reads it via the per-RAF tick pattern in App.
 *
 *  there are no tools or modes: you select a node and drag it freely, and when
 *  the selected node is the chain end the extend/delete actions appear. */

interface EditorState {
    /** eid of the currently selected node, or null. */
    selection: number | null;
}

export const editor: EditorState = {
    selection: null,
};

/** select a node (null to clear). */
export function select(eid: number | null): void {
    editor.selection = eid;
}
