import { BINDINGS, bound } from "./menu";

/**
 * The keyboard twin of `menus.ts`: one pure decider per `BINDINGS` home, each taking the raw
 * `KeyboardEvent.key` plus a plain state descriptor (the guards its surface already derives) and
 * returning an act name from the SAME vocabulary the menu builders' actions record uses
 * (`SectionMenuActions.remove`, `NodeMenuActions.add`, …) — or `null` when the key doesn't apply.
 * A home's window keydown handler dispatches through its own actions record: `const act =
 * xKeyAct(e.key, {…}); if (act !== null) { e.preventDefault(); acts[act](); }`.
 *
 * Purity is a MODULE-GRAPH property here too: this module reaches only `./menu` (`BINDINGS`,
 * `bound`) — never the ECS, `editor`, or the DOM — so `tests/menu.test.ts` can drive every
 * decider across its full state matrix with no shim, the same way it drives the menu builders.
 * The predicates that feed a descriptor (`sectionOpsAllowed`, `sectionEditable`, …) stay exactly
 * where they live today; a decider takes their RESULTS, never recomputes them.
 */

/** the whole-section delete rung's state (`controls.ts`'s `onKeyDown`, a section selected). */
export type SectionKeyState = {
    /** the consent boundary: no pin session is open (`sectionOpsAllowed`). */
    opsAllowed: boolean;
    /** a multi-section selection — deletes as one entry (`removeSections`) vs. `removeSection`. */
    multi: boolean;
};

/** whole-section Delete: `remove` for a single section, `removeSet` for a multi-selection, `null`
 *  off `BINDINGS.remove` or while the consent boundary bars structural ops. */
export function sectionKeyAct(key: string, s: SectionKeyState): "remove" | "removeSet" | null {
    if (!bound(BINDINGS.remove, key) || !s.opsAllowed) return null;
    return s.multi ? "removeSet" : "remove";
}

/** the node rungs' state (`controls.ts`'s `onKeyDown`, a node or node set selected) — covers both
 *  the multi node-set trim and the single chain-end extend/trim. */
export type NodeKeyState = {
    /** the editing lockdown: the node's own section is editable (`sectionEditable`). */
    editable: boolean;
    /** a multi node-set selection — remove-only (a set never extends). */
    multi: boolean;
    /** the chain end is the selected subject — append/trim's precondition (`endSelected`);
     *  unread for a multi-set, whose own suffix-run validity is the act layer's guard. */
    endSelected: boolean;
};

/** node Enter/Delete: `add` on the chain end (`BINDINGS.append`), `remove` to trim it
 *  (`BINDINGS.remove`, single), `removeSet` to trim a selected suffix run (`BINDINGS.remove`,
 *  multi) — `null` off both bindings, off the lockdown, or (single) off the chain end. */
export function nodeKeyAct(key: string, s: NodeKeyState): "remove" | "removeSet" | "add" | null {
    if (!s.editable) return null;
    if (s.multi) return bound(BINDINGS.remove, key) ? "removeSet" : null;
    if (!s.endSelected) return null;
    if (bound(BINDINGS.append, key)) return "add";
    if (bound(BINDINGS.remove, key)) return "remove";
    return null;
}

/** the force-keyframe rung's state (`Timeline.svelte`, a force selection). */
export type ForceKeyState = {
    /** a live pin session is open — `Q` (lock) only means something inside one. */
    pinning: boolean;
    /** the selected force set's size — `Q` needs at least one member. */
    size: number;
};

/** force-keyframe Delete/`Q`: `remove` (unconditional — `deleteSelectedForce` guards its own
 *  editability), `toggleLock` only in-mode over a non-empty set, `null` otherwise. */
export function forceKeyAct(key: string, s: ForceKeyState): "remove" | "toggleLock" | null {
    if (bound(BINDINGS.remove, key)) return "remove";
    if (bound(BINDINGS.lock, key) && s.pinning && s.size > 0) return "toggleLock";
    return null;
}

/** the pin-mode Escape rung's state (`App.svelte`'s permanent mode listener) — the dismissal
 *  ladder's yield conditions: a summoned menu, an edit sub-mode, or a live selection each peel
 *  before the mode itself (root `ui.md`: dismissal peels one layer). */
export type ModeKeyState = {
    /** a pin session is open — Exit has nothing to do otherwise. */
    modeOpen: boolean;
    /** a summoned menu (context/node/force/ruler) is open — it peels first. */
    menuOpen: boolean;
    /** an edit sub-mode (tangent edit, force handle edit) is open — it peels first. */
    editing: boolean;
    /** a live selection (node, force, section, or the START anchor) — it clears first
     *  (`controls.ts` / `Timeline.svelte` own that rung). */
    selected: boolean;
};

/** pin-mode Escape: `pinExit` only when the mode is open and every inner layer has already
 *  yielded, `null` otherwise (including off `BINDINGS.exitMode`). */
export function modeKeyAct(key: string, s: ModeKeyState): "pinExit" | null {
    if (!s.modeOpen || !bound(BINDINGS.exitMode, key)) return null;
    if (s.menuOpen || s.editing || s.selected) return null;
    return "pinExit";
}
