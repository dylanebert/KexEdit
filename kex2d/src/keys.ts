import { BINDINGS, bound } from "./menu";
import type { KeyframeMenuActions, NodeMenuActions, SectionMenuActions } from "./menus";

/**
 * The keyboard twin of `menus.ts`: one pure decider per `BINDINGS` home, each taking the raw
 * `KeyboardEvent.key` plus a plain state descriptor (the guards its surface already derives) and
 * returning an act name from the SAME vocabulary the menu builders' actions record uses
 * (`SectionMenuActions.remove`, `NodeMenuActions.add`, …) — or `null` when the key doesn't apply.
 * A home's window keydown handler dispatches through its own actions record: `const act =
 * xKeyAct(e.key, {…}); if (act !== null) { e.preventDefault(); acts[act](); }`.
 *
 * Purity is a MODULE-GRAPH property here too: at runtime this module reaches only `./menu`
 * (`BINDINGS`, `bound`) — never the ECS, `editor`, or the DOM — so `tests/menu.test.ts` can drive
 * every decider across its full state matrix with no shim, the same way it drives the menu
 * builders. The `./menus` import is type-only (each decider's return type is `Extract<keyof
 * XMenuActions, …>`, deriving the act vocabulary from the actions record instead of restating it
 * as a literal), so it erases at build time and never joins the runtime graph. The predicates
 * that feed a descriptor (`sectionOpsAllowed`, `sectionEditable`, …) stay exactly where they live
 * today; a decider takes their RESULTS, never recomputes them.
 */

/** the whole-section delete rung's state (`controls.ts`'s `onKeyDown`, a section selected). */
export type SectionKeyState = {
    /** the consent boundary: no pin session is open (`sectionOpsAllowed`). */
    opsAllowed: boolean;
    /** a multi-section selection — deletes as one entry (`removeSections`) vs. `removeSection`. */
    multi: boolean;
};

/** whole-section Delete: `remove` for a single section, `removeSet` for a multi-selection, `null`
 *  off `BINDINGS.remove` or while the consent boundary bars structural ops. Typed off
 *  `SectionMenuActions`' own keys — `menus.ts`'s reverse-direction check — rather than a
 *  restated literal, so a rename in the actions record fails here at compile time. */
export function sectionKeyAct(
    key: string,
    s: SectionKeyState,
): Extract<keyof SectionMenuActions, "remove" | "removeSet"> | null {
    if (!bound(BINDINGS.remove, key) || !s.opsAllowed) return null;
    return s.multi ? "removeSet" : "remove";
}

/** the node rungs' state (`controls.ts`'s `onKeyDown`, a node or node set selected) — covers both
 *  the multi node-set trim and the single chain-end extend/trim. A discriminated union on `multi`:
 *  the multi rung never reads `endSelected` (its own suffix-run validity is the act layer's
 *  guard), so the single-subject field doesn't exist on that variant, and the return type below
 *  narrows per branch instead of carrying a dead `removeSet` case into the single-subject rung. */
export type NodeKeyState =
    | { editable: boolean; multi: true }
    | { editable: boolean; multi: false; endSelected: boolean };

type NodeAct = Extract<keyof NodeMenuActions, "remove" | "removeSet" | "add">;

/** node Enter/Delete: `add` on the chain end (`BINDINGS.append`), `remove` to trim it
 *  (`BINDINGS.remove`, single), `removeSet` to trim a selected suffix run (`BINDINGS.remove`,
 *  multi) — `null` off both bindings, off the lockdown, or (single) off the chain end. Overloaded
 *  on `NodeKeyState`'s discriminant so a multi-subject call site sees only `"removeSet" | null`
 *  and a single-subject call site only `"remove" | "add" | null` — the caller's dispatch record
 *  never has to guard the unreachable branch. */
export function nodeKeyAct(
    key: string,
    s: { editable: boolean; multi: true },
): Extract<NodeAct, "removeSet"> | null;
export function nodeKeyAct(
    key: string,
    s: { editable: boolean; multi: false; endSelected: boolean },
): Extract<NodeAct, "remove" | "add"> | null;
export function nodeKeyAct(key: string, s: NodeKeyState): NodeAct | null {
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
 *  editability), `toggleLock` only in-mode over a non-empty set, `null` otherwise. Typed off
 *  `KeyframeMenuActions`' own keys, per `sectionKeyAct` above. */
export function forceKeyAct(
    key: string,
    s: ForceKeyState,
): Extract<keyof KeyframeMenuActions, "remove" | "toggleLock"> | null {
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
 *  yielded, `null` otherwise (including off `BINDINGS.exitMode`). Typed off `SectionMenuActions`'
 *  own `pinExit` key, per `sectionKeyAct` above — the mode's Escape and the section menu's Exit
 *  row invoke the same act. */
export function modeKeyAct(
    key: string,
    s: ModeKeyState,
): Extract<keyof SectionMenuActions, "pinExit"> | null {
    if (!s.modeOpen || !bound(BINDINGS.exitMode, key)) return null;
    if (s.menuOpen || s.editing || s.selected) return null;
    return "pinExit";
}
