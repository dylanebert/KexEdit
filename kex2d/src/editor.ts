/** ephemeral editor state — the current selection + a transient solve highlight.
 *  lives outside ECS because it doesn't persist (no save/load, no replay). plain
 *  mutable singleton; Svelte reads it via the per-RAF tick pattern in App.
 *
 *  there are no tools or modes: you select a node and drag it freely, and when
 *  the selected node is the chain end the extend/delete actions appear. force
 *  targets select the same way (a chip on the timeline). node and target
 *  selection are mutually exclusive — one thing is selected at a time, so `Del`
 *  and `Esc` route unambiguously. `highlight` names the freed node orders while a
 *  solve gesture runs, so the viewport shows the scope the optimizer is moving. */

interface EditorState {
    /** eid of the currently selected node, or null. */
    selection: number | null;
    /** stable id of the currently selected force target, or null. */
    target: number | null;
    /** node orders freed by the active solve gesture (highlighted in the
     *  viewport); empty when no gesture is running. */
    highlight: number[];
}

export const editor: EditorState = {
    selection: null,
    target: null,
    highlight: [],
};

/** select a node (clears any target selection — one thing at a time). */
export function select(eid: number | null): void {
    editor.selection = eid;
    if (eid !== null) editor.target = null;
}

/** select a force target by id (clears any node selection). */
export function selectTarget(id: number | null): void {
    editor.target = id;
    if (id !== null) editor.selection = null;
}

/** set the freed-node highlight shown while a solve gesture runs (empty to clear). */
export function setHighlight(orders: number[]): void {
    editor.highlight = orders;
}
