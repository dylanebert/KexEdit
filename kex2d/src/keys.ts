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
 *  the multi node-set trim and the single chain-end extend/trim, plus (single) `K` Cut. A
 *  discriminated union on `multi`: the multi rung never reads `endSelected`/`cuttable` (its own
 *  suffix-run validity is the act layer's guard, and Cut is single-subject — `nodeMenu` grays it
 *  unconditionally on a multi-set), so neither single-subject field exists on that variant, and
 *  the return type below narrows per branch instead of carrying a dead `removeSet` case into the
 *  single-subject rung. `cuttable` is OPTIONAL (default not-cuttable) so an existing caller
 *  driving only remove/add keeps compiling — `acts.nodeCuttable(order, count)` is its source. */
export type NodeKeyState =
    | { editable: boolean; multi: true }
    | { editable: boolean; multi: false; endSelected: boolean; cuttable?: boolean };

type NodeAct = Extract<keyof NodeMenuActions, "remove" | "removeSet" | "add" | "cut">;

/** node Enter/Delete/`K`: `add` on the chain end (`BINDINGS.append`), `remove` to trim it
 *  (`BINDINGS.remove`, single), `removeSet` to trim a selected suffix run (`BINDINGS.remove`,
 *  multi), `cut` on a cuttable interior node (`BINDINGS.cut`, single only — the landmark path,
 *  `editor-ui.md`'s shortcut asymmetry) — `null` off every binding, off the lockdown, or (single,
 *  non-cut) off the chain end. Overloaded on `NodeKeyState`'s discriminant so a multi-subject call
 *  site sees only `"removeSet" | null` and a single-subject call site only
 *  `"remove" | "add" | "cut" | null` — the caller's dispatch record never has to guard the
 *  unreachable branch. */
export function nodeKeyAct(
    key: string,
    s: { editable: boolean; multi: true },
): Extract<NodeAct, "removeSet"> | null;
export function nodeKeyAct(
    key: string,
    s: { editable: boolean; multi: false; endSelected: boolean; cuttable?: boolean },
): Extract<NodeAct, "remove" | "add" | "cut"> | null;
export function nodeKeyAct(key: string, s: NodeKeyState): NodeAct | null {
    if (!s.editable) return null;
    if (s.multi) return bound(BINDINGS.remove, key) ? "removeSet" : null;
    if (bound(BINDINGS.cut, key)) return s.cuttable === true ? "cut" : null;
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
    /** the ACTIVE keyframe is a valid Cut point — `acts.keyframeCuttable(s, length)`. OPTIONAL
     *  (default not-cuttable) so an existing caller driving only remove/lock keeps compiling. */
    cuttable?: boolean;
    /** the ACTIVE keyframe's own section is editable under the live lockdown
     *  (`acts.sectionEditable`) — Cut's OWN gate, mirroring `nodeKeyAct`'s top-level `editable`.
     *  `cuttable` is purely the interior-point predicate and knows nothing about a live pin
     *  session elsewhere barring this section, so Cut needs both. `remove`/`toggleLock` don't
     *  read this field — `remove` guards its own editability inside the act body (`keyframeActs`
     *  doc), and `toggleLock`'s own act filters to the pinning section by construction. OPTIONAL
     *  (default not-editable) so an existing caller driving only remove/lock keeps compiling. */
    editable?: boolean;
};

/** force-keyframe Delete/`Q`/`K`: `remove` (unconditional — `deleteSelectedForce` guards its own
 *  editability), `toggleLock` only in-mode over a non-empty set, `cut` on a cuttable, EDITABLE
 *  active keyframe with EXACTLY one selected (single-subject — a set reads as no clean position,
 *  the same reason `keyframeMenu` grays Cut on a multi-set), `null` otherwise. Typed off
 *  `KeyframeMenuActions`' own keys, per `sectionKeyAct` above. */
export function forceKeyAct(
    key: string,
    s: ForceKeyState,
): Extract<keyof KeyframeMenuActions, "remove" | "toggleLock" | "cut"> | null {
    if (bound(BINDINGS.remove, key)) return "remove";
    if (bound(BINDINGS.lock, key) && s.pinning && s.size > 0) return "toggleLock";
    if (bound(BINDINGS.cut, key) && s.size === 1 && s.cuttable === true && s.editable === true)
        return "cut";
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
