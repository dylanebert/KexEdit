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
    /** Convert's own geo→force enablement (`canSolve`, `menus.ts convertRow`) — the same reading
     *  `App.svelte` hands the menu builder. OPTIONAL — an existing caller driving only remove
     *  keeps compiling. */
    canSolve?: boolean;
    /** Convert's own force→geo enablement (`canSolveShape`). */
    canSolveShape?: boolean;
    /** Pin's own enablement (`canPin`) — a single force section with a live bake
     *  (`track.sectionSolvable`); it reads no pinning state, so it stays true while a session is
     *  open on this OR another section. What actually bars `P` mid-session is `opsAllowed`
     *  above (`sectionOpsAllowed(editor.pinning)`), which this decider checks first and returns
     *  `null` before `canPin` is ever read. */
    canPin?: boolean;
    /** Reset's own enablement (`track.sectionResettable`) — exactly one section, and a live
     *  bake on a force section only (the seed's entry force is bake-recovered; a geo reset reads
     *  no bake). OPTIONAL, the `canSolve` shape: an existing caller driving only
     *  remove/convert/pin keeps compiling. */
    canReset?: boolean;
};

/** whole-section Delete/`D`/`P`/`R`: `remove` for a single section, `removeSet` for a
 *  multi-selection (`BINDINGS.remove`), `solve`/`solveShape` on `D` (`BINDINGS.convert` — the
 *  section's kind picks the direction, `menus.ts convertRow`'s own fork, mirrored here rather
 *  than re-derived from a `kind` field this decider would otherwise need to import for),
 *  `pinEnter` on `P` (`BINDINGS.pin`), `reset` on `R` (`BINDINGS.reset`, a plain document act —
 *  no chrome merge needed, unlike Convert/Pin/Solve) — `null` off every binding or while the
 *  consent boundary bars structural ops. Typed off `SectionMenuActions`' own keys — `menus.ts`'s
 *  reverse-direction check — rather than a restated literal, so a rename in the actions record
 *  fails here at compile time. */
export function sectionKeyAct(
    key: string,
    s: SectionKeyState,
): Extract<
    keyof SectionMenuActions,
    "remove" | "removeSet" | "solve" | "solveShape" | "pinEnter" | "reset"
> | null {
    if (!s.opsAllowed) return null;
    if (bound(BINDINGS.remove, key)) return s.multi ? "removeSet" : "remove";
    if (bound(BINDINGS.convert, key))
        return s.canSolveShape === true ? "solveShape" : s.canSolve === true ? "solve" : null;
    if (bound(BINDINGS.pin, key)) return s.canPin === true ? "pinEnter" : null;
    if (bound(BINDINGS.reset, key)) return s.canReset === true ? "reset" : null;
    return null;
}

/** the node rungs' state (`controls.ts`'s `onKeyDown`, a node or node set selected) — covers both
 *  the multi node-set trim and the single chain-end extend/trim. A discriminated union on
 *  `multi`: the multi rung never reads `endSelected` (its own suffix-run validity is the act
 *  layer's guard), so that single-subject field doesn't exist on that variant, and the return
 *  type below narrows per branch instead of carrying a dead `removeSet` case into the
 *  single-subject rung. */
export type NodeKeyState =
    | { editable: boolean; multi: true }
    | { editable: boolean; multi: false; endSelected: boolean };

type NodeAct = Extract<
    keyof NodeMenuActions,
    "remove" | "removeSet" | "add" | "reset" | "resetSet"
>;

/** node Enter/Delete/`R`: `add` on the chain end (`BINDINGS.append`), `remove` to trim it
 *  (`BINDINGS.remove`, single), `removeSet` to trim a selected suffix run (`BINDINGS.remove`,
 *  multi), `reset`/`resetSet` on `R` (`BINDINGS.reset` — unlike Add/Remove, Reset applies to
 *  EVERY node, node 0 and the chain end alike (`nodeMenu`'s own `enabled: s.ok`, no `isEnd`
 *  gate), so it's checked before the chain-end guard below; node 0's tangent-clear delegation is
 *  invisible here — `track.resetNode` picks it, this decider only names the act) — `null` off
 *  every binding, off the lockdown, or (single, non-reset) off the chain end. Overloaded on
 *  `NodeKeyState`'s discriminant so a multi-subject call site sees only `"removeSet" |
 *  "resetSet" | null` and a single-subject call site only `"remove" | "add" | "reset" | null` —
 *  the caller's dispatch record never has to guard the unreachable branch. */
export function nodeKeyAct(
    key: string,
    s: { editable: boolean; multi: true },
): Extract<NodeAct, "removeSet" | "resetSet"> | null;
export function nodeKeyAct(
    key: string,
    s: { editable: boolean; multi: false; endSelected: boolean },
): Extract<NodeAct, "remove" | "add" | "reset"> | null;
export function nodeKeyAct(key: string, s: NodeKeyState): NodeAct | null {
    if (!s.editable) return null;
    if (s.multi) {
        if (bound(BINDINGS.remove, key)) return "removeSet";
        if (bound(BINDINGS.reset, key)) return "resetSet";
        return null;
    }
    if (bound(BINDINGS.reset, key)) return "reset";
    if (!s.endSelected) return null;
    if (bound(BINDINGS.append, key)) return "add";
    if (bound(BINDINGS.remove, key)) return "remove";
    return null;
}

/** the force-keyframe rung's state (`Timeline.svelte`, a force selection). */
export type ForceKeyState = {
    /** a live pin session is open ANYWHERE (`editor.pinning !== null`) — `Q` (lock) only means
     *  something inside one. */
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

/** the pin-mode Escape/Solve rung's state (`App.svelte`'s permanent mode listener). Escape's own
 *  dismissal ladder: a summoned menu, an edit sub-mode, or a live selection each peel before the
 *  mode itself (root `ui.md`: dismissal peels one layer). Solve reads none of those three — it's
 *  the mode's primary action, not a dismissal, so it fires whenever the mode is open and headroom
 *  holds, matching the docked panel's own Solve button (`App.svelte`'s `pinSolvable`/`disabled`),
 *  its keyboard twin (`BINDINGS.solve`, the mode-scoped `Enter` exception, Locked decision 1's
 *  law 3). */
export type ModeKeyState = {
    /** a pin session is open — Exit and Solve both have nothing to do otherwise. */
    modeOpen: boolean;
    /** a summoned menu (context/node/force/ruler) is open — it peels first. Escape only. */
    menuOpen: boolean;
    /** an edit sub-mode (tangent edit, force handle edit) is open — it peels first. Escape only. */
    editing: boolean;
    /** a live selection — any member of the unified member set, node/force/section/strip/
     *  strip-keyframe/START/one-shot alike (the caller reads `editor.ts`'s exported
     *  `anySelected()`, the set's non-empty read, never a hand-enumerated per-kind OR) — it clears
     *  first
     *  (`controls.ts` / `Timeline.svelte` own that rung). Escape only. */
    selected: boolean;
    /** Solve's own headroom gate — `MIN_FREE` free keys (`optimize.ts`, `App.svelte`'s
     *  `pinSolvable`). Unread by Escape. */
    solvable: boolean;
    /** the mode's own blocking gate (`editor.pinSolving`) — Solve is inert mid-solve, matching
     *  the panel button's own `disabled`. Unread by Escape. */
    solving: boolean;
};

/** pin-mode Escape/Enter: `pinExit` when the mode is open, `BINDINGS.exitMode` is pressed, and
 *  every inner layer has already yielded; `pinSolve` when the mode is open, `BINDINGS.solve` is
 *  pressed (mode-scoped `Enter`), not mid-solve, and headroom holds; `null` otherwise. Typed off
 *  `SectionMenuActions`' own `pinExit`/`pinSolve` keys, per `sectionKeyAct` above — the mode's
 *  Escape/Enter and the in-mode section menu's Exit/Solve rows invoke the same acts. */
export function modeKeyAct(
    key: string,
    s: ModeKeyState,
): Extract<keyof SectionMenuActions, "pinExit" | "pinSolve"> | null {
    if (!s.modeOpen) return null;
    if (bound(BINDINGS.exitMode, key))
        return s.menuOpen || s.editing || s.selected ? null : "pinExit";
    if (bound(BINDINGS.solve, key)) return !s.solving && s.solvable ? "pinSolve" : null;
    return null;
}
