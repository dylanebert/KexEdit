/**
 * The row taxonomy, in canonical order — the menus' ordering law:
 *
 * - `create` — the document gains an object (Add, the append flyout's Geo/Force).
 * - `modify` — changes the subject that summoned the menu, or enters / acts in / leaves a mode
 *   scoped to it (Convert, Pin, Solve, Exit, Handles, Tangents ▸, Easing ▸, Lock/Unlock,
 *   Meters/Seconds). The residual class, honestly.
 * - `lifecycle` — the subject ends at its creation state or gone (Reset, then Delete).
 *
 * A menu's rows sort by this order, then by frequency WITHIN a group (the old free-form
 * frequency rule, demoted to a tiebreaker where it's cheap and unenforceable-but-harmless).
 * `danger` implies the terminal row of the whole menu. The grammar is machine-checked over every
 * builder across the full state matrix in `tests/menu.test.ts` — it is a gate, not a convention.
 * A fourth group, `structure` (Cut/Join splitting or merging the chain), existed through
 * `kex2d-segment-removal` S1 and left with S2 — Cut was its last member; a later segment-authoring
 * unit may reintroduce a category when it next needs one, rather than reopening this one. */
export const GROUPS = ["create", "modify", "lifecycle"] as const;

export type MenuGroup = (typeof GROUPS)[number];

/** a keyboard binding: the `KeyboardEvent.key` values that fire it, and the hint a menu row
 *  advertising the same action prints. `scope` narrows the claim to one named mode (`Reserved`'s
 *  own field, mirrored here rather than duplicated under a second name) — a menu row IS how
 *  Locked decision 1's law-3 exception lands: Solve is an advertised row with a `shortcut` hint,
 *  so it belongs in `BINDINGS`, not `RESERVED`, and needs the same field to coexist with
 *  `append`'s unscoped `Enter`. No entry uses it yet. */
export type Binding = {
    readonly keys: readonly string[];
    readonly hint: string;
    readonly scope?: string;
};

/**
 * The keyboard bindings a menu row may advertise — the ONE place a key and its menu hint are
 * written down. A `shortcut` is legal on a row iff a binding here invokes that row's own action,
 * and both halves read the same entry: the handler matches on `keys` (`bound`), the builder prints
 * `hint`. So a rebind moves the hint with it and a row can't come to lie about its key — the
 * failure the `L` → `Q` rebind would have caused with the table living in a test.
 *
 * A pointer gesture is not a shortcut (`Handles` is double-click and advertises nothing), and the
 * hint names the row's ACTION, not its live enablement — a grayed row keeps it, the way a disabled
 * `Add` still tells you append is `Enter`.
 *
 * Homes: `remove` — `controls.ts` (section, node set, chain-end trim) + `Timeline.svelte` (force
 * keyframe); `append` — `controls.ts`; `exitMode` — `App.svelte`; `lock` — `Timeline.svelte`.
 * `convert`/`pin` — `App.svelte`'s own permanent listener (`kex2d-shortcuts` stage 3): the section
 * menu's remaining single-subject rows, dispatched through the MERGED chrome + document acts
 * record (`solve`/`solveShape`/`pinEnter` are chrome — `editor-ui.md` Menus, the act-BODY seam's
 * residual clause 2 — so `controls.ts`, which only reaches `acts.ts`, can't be their home).
 * `solve` — the mode-scoped `Enter` exception (Locked decision 1's law 3): `Enter` is `append`
 * everywhere else, but pin mode's editing lockdown already bars geo append, so nothing collides in
 * fact; the same permanent listener reads `editor.pinning` to know which claim is live.
 * `reset` — `controls.ts` alone (`kex2d-shortcuts` stage 4): unlike Convert/Pin, `reset` is a plain
 * document act on BOTH `SectionMenuActions` and `NodeMenuActions` (`acts.ts sectionActs`/`nodeActs`
 * already return it — no modal, no `AbortController`), so it never needs the chrome-act merge;
 * `controls.ts`'s existing section/node keydown rungs dispatch it exactly like `remove`.
 * One key, two subject kinds, per law 3: a section (`sectionKeyAct`) or a node/node-set
 * (`nodeKeyAct`, `resetSet` on a multi selection) — node 0's tangent-clear delegation lives inside
 * `track.resetNode` itself, invisible at this seam. Keyframes carry no Reset row and no binding
 * (the Easing-subsumes-Reset law, `kex2d-shortcuts` Locked decision), so `forceKeyAct` never reads it.
 * `Escape` and `Delete` also drive dismissal/guard rungs that are nobody's menu row; those stay
 * raw literals, and `tests/menu.test.ts` pins exactly which files may hold one. `C` (Cut's own
 * binding through `kex2d-segment-removal` S1) is unclaimed since S2 retired Cut's last surface —
 * free for a future segment-authoring gesture, not reclaimed here.
 */
export const BINDINGS = {
    remove: { keys: ["Delete", "Backspace"], hint: "Del" },
    append: { keys: ["Enter"], hint: "Enter" },
    exitMode: { keys: ["Escape"], hint: "Esc" },
    // the one named exemption to the derived map: the mnemonic law gives Lock `L`, and pin mode's
    // feel round 6 re-keyed it to `Q` for reachability while the other hand holds the pointer. A
    // feel verdict outranks a derivation, so it's recorded here rather than re-keyed.
    lock: { keys: ["q", "Q"], hint: "Q" },
    // `V` was the derived pick (law 4's tiebreaker) but is refused: Figma/Rive bind bare `V` to
    // the base select/move tool, an arbitrary letter their camp standardized — exactly the reflex
    // kex2d must not collide with. `D` is free across both camps and wins law 4's left-hand-reach
    // tiebreaker (`kex2d-shortcuts` stage 5 feel verdict).
    convert: { keys: ["d", "D"], hint: "D" },
    // mnemonic-exact (Locked decision 1).
    pin: { keys: ["p", "P"], hint: "P" },
    // mode-scoped: `Enter` also fires `append` (unscoped) everywhere outside pin mode. Law 3's
    // one exception — see the doc comment above.
    solve: { keys: ["Enter"], hint: "Enter", scope: "pin" },
    // mnemonic-exact, left-hand (Locked decision 1). The registry's one two-subject binding
    // (section `reset`, node `reset`/`resetSet`) — law 3's cross-surface case, plain document
    // acts on both menus, so it needs no `scope`.
    reset: { keys: ["r", "R"], hint: "R" },
} as const satisfies Record<string, Binding>;

/** whether a `KeyboardEvent.key` fires this binding.
 *
 * @example if (bound(BINDINGS.remove, e.key)) deleteSelection();
 */
export function bound(binding: Binding, key: string): boolean {
    return binding.keys.includes(key);
}

/** a chord requirement on a `Reserved` press — today's only occupant is `ctrl` (Ctrl or Cmd,
 *  `ctrlKey || metaKey`), earned by undo/redo: kex2d's bare-letters law (Locked decision 1,
 *  `kex2d-shortcuts`) keeps `Z`/`Y` unclaimed on their own, so the modifier is what makes them
 *  representable as a distinct reserved press rather than a collision with a future bare one. */
export type Modifier = "ctrl";

/** a reserved, non-advertised keyboard press — the raw population `BINDINGS` doesn't cover: no
 *  menu row invokes it, so it carries no `hint`, only a `why`. `keys` compares against
 *  `KeyboardEvent.key` unless `form` is `"code"` (today's one instance, `Space` — no printable
 *  `key` worth branching on). `mod` narrows to a required chord (earned by undo/redo). `scope`
 *  narrows the claim to one named mode, so a later entry may reuse the SAME key inside a mode
 *  whose own lockdown makes the unscoped press unreachable there (Locked decision 1's law-3
 *  exception — `Enter` inside pin mode for Solve) without reading as a collision with the
 *  unscoped claim; no entry uses it yet, so the field ships ahead of its first occupant, the
 *  same shape the declared-registry law sanctions for an empty registry (`editor-ui.md` Menus:
 *  "a registry that ships empty... makes the positive controls the whole deliverable"). */
export type Reserved = {
    readonly keys: readonly string[];
    readonly why: string;
    readonly form?: "code";
    readonly mod?: Modifier;
    readonly scope?: string;
};

/**
 * Every non-menu key/code literal `src/` compares, closing the hole `kex2d-shortcuts` stage 1
 * names: `menu.test.ts` used to census raw comparisons only for keys `BINDINGS` already declares
 * (plus one `code` exemption, `Space`), so nothing stopped a new binding from colliding with `S`
 * or `F`. This table is the other half of the closed registry — `tests/menu.test.ts`'s collision
 * oracle reads BOTH tables, never re-derives either.
 *
 * Homes: `snap` — `controls.ts` (the AE magnet toggle; Ctrl/Cmd is guarded off in the handler as
 * the browser-save reflex, not reserved here — it never reaches this table). `frame` —
 * `controls.ts` + `Timeline.svelte` (Unity's `F`, frame selected — Blender's frame-selected is
 * Numpad Period, its bare `F` is Make Edge/Face; Unity alone is the precedent), routed by
 * `editor.hover` so it frames exactly one surface. `playback` — `Timeline.svelte`, the one
 * `code`-form entry (no printable `key` worth branching on, `Space`'s pre-existing `code`
 * exemption). `nudge` — `controls.ts`
 * (node manipulator) + `Timeline.svelte` (force keyframe + playhead step), routed by
 * `editor.hover` / the live selection so one arrow press is one action. `undo`/`redo` —
 * `Timeline.svelte`'s permanent listener, the shared `history` stack, guarded off
 * `editor.dragging` (never mid-gesture) and off a focused field; both compare a `.toLowerCase()`
 * local, so only the lowercase form is a real literal (`Z`/`Y` never appear raw — a Shift+Z also
 * redoes, folded into `why` rather than a second key). `debug` — `main.ts`'s `F3`, shallot's own
 * HUD toggle, not this app's vocabulary.
 */
export const RESERVED = {
    snap: {
        keys: ["s", "S"],
        why: "toggles the persistent snap magnet (editor-ui.md Snapping)",
    },
    frame: {
        keys: ["f", "F"],
        why: "frames the hovered surface — the whole track (viewport) or the whole timeline",
    },
    playback: {
        keys: ["Space"],
        form: "code",
        why: "toggles cart playback",
    },
    nudge: {
        keys: ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"],
        why: "steps the selected node, force keyframe, or scrubbed playhead by a fixed increment",
    },
    undo: {
        keys: ["z"],
        mod: "ctrl",
        why: "undo, the shared history stack",
    },
    redo: {
        keys: ["y"],
        mod: "ctrl",
        why: "redo (Ctrl+Y, or Shift+Ctrl+Z through the same lowered-key branch)",
    },
    debug: {
        keys: ["F3"],
        why: "shallot's own debug HUD toggle — not part of this app's key vocabulary",
    },
} as const satisfies Record<string, Reserved>;

/**
 * A row in the shared menu language (`Menu.svelte`, rendered inside the `.menu` look). The
 * section context menu, the node context menu, and the append flyout all render an array of
 * these, so a menu is pure data and enablement, separators, and submenus are first-class
 * per-item properties, not per-menu special cases.
 */
export type MenuItem = {
    /** the row label. omitted for a separator. */
    label?: string;
    /** the row's taxonomy class — what KIND of act it is, and the menu's whole ordering law.
     *  Every non-separator row declares one; rows sort by `GROUPS`'s canonical order, and
     *  `menuRows` derives a divider at each change. A separator carries none. */
    group?: MenuGroup;
    /** a11y name when the visible label is terse; defaults to `label`. */
    aria?: string;
    /** an inline shortcut hint, right-aligned by the row (e.g. "Del"). */
    shortcut?: string;
    /** the destructive red tint. */
    danger?: boolean;
    /** a selected/active row (the accent-lit state) — e.g. the current tangent mode in a
     *  mode-picker submenu. Omitted = not a selectable row. */
    checked?: boolean;
    /** an optional leading glyph, as an SVG `path` `d` string drawn in a `0 0 22 14` viewBox
     *  (stroked in `currentColor`, so it tints with the row). Generic — a caller passes it to
     *  put a small pictogram beside the label (the easing rows draw their real curve here);
     *  most menus omit it. */
    glyph?: string;
    /**
     * whether the action is possible right now. `false` renders the row disabled — dimmed,
     * non-interactive, `aria-disabled` — and the action can't fire. Omitted = always enabled.
     * Derive it from editor state ($derived): the same move as a summoned surface deriving
     * its visibility from its subject existing.
     */
    enabled?: boolean;
    /** a non-interactive divider between groups — set alone (no label / action / children),
     *  the standard menu grouping rule. */
    separator?: boolean;
    /** a submenu: the row shows a `▸` marker and reveals these children as a flyout on hover
     *  or click. A row with children carries no direct action (its children hold the actions);
     *  the flyout is positioned so it never covers its parent row and flips in-viewport. */
    children?: MenuItem[];
    /** the row's action; a disabled row never invokes it. Omitted for a separator or a
     *  submenu parent. */
    action?: () => void;
};

/** the rows as RENDERED: the builder's rows with a divider derived at every group change. Grouping
 *  is the taxonomy's own consequence, so no builder authors a top-level separator — an explicit
 *  `separator` survives only as a WITHIN-group divider (`Easing ▸`, dividing the preset picks from
 *  Custom), and the grammar oracle constrains it to positions no derived boundary can occupy.
 *  Items pass through by reference: never copy a row here (a builder's descriptor reads are lazy).
 *
 *  A divider is owed before the next row either way — authored or derived — so the two collapse to
 *  ONE (an authored separator sitting AT a group boundary can't double up), and a divider owed with
 *  no row on one side of it is dropped (no leading or trailing hairline, a menu of nothing but
 *  separators renders empty). That makes the renderer correct by construction rather than by the
 *  oracle's within-group law holding forever: this is a public seam other menus will call.
 *
 * @example menuRows([{ label: "Add", group: "create" }, { label: "Reset", group: "lifecycle" }])
 */
export function menuRows(items: MenuItem[]): MenuItem[] {
    const rows: MenuItem[] = [];
    let prev: MenuGroup | undefined;
    let owed = false;
    for (const item of items) {
        if (item.separator) {
            owed = rows.length > 0;
            continue;
        }
        if (rows.length > 0 && (owed || item.group !== prev)) rows.push({ separator: true });
        rows.push(item);
        prev = item.group;
        owed = false;
    }
    return rows;
}

/** where a summoned root context menu's top-left lands so the whole box stays in the viewport,
 *  guarding all four edges (root ui.md "summoned panels fit the viewport"). The menu opens
 *  down-right from the cursor anchor — its top-left AT the point, so it never covers the invoker
 *  — and flips to the opposite side of the anchor when the preferred one would clip:
 *
 * - flip UP (bottom edge at the anchor) when opening down would run past the bottom and there's
 *   room above; flip LEFT likewise for the right edge. This is the standard context-menu flip.
 * - clamp as a last resort when a menu larger than the viewport fits neither way: the top-left
 *   stays on-screen (pinned a `pad` in), clipping the far edge instead — the anchor corner stays
 *   reachable.
 *
 * Pure + device-free so `menu.test.ts` pins it; the `fitMenu` action feeds it the box's measured
 * size. The root-menu twin of `flyoutFit` (which fits a submenu beside its parent row).
 *
 * @example menuFit({ x: 1240, y: 780 }, { w: 132, h: 160 }, { w: 1280, h: 800 }) // flips up-left
 */
export function menuFit(
    anchor: { x: number; y: number },
    size: { w: number; h: number },
    viewport: { w: number; h: number },
    pad = 4,
): { x: number; y: number } {
    let x = anchor.x;
    let y = anchor.y;
    // flip to open leftward when opening right would clip the right edge and the left has room
    if (x + size.w > viewport.w - pad && anchor.x - size.w >= pad) x = anchor.x - size.w;
    // flip to open upward when opening down would clip the bottom and above has room
    if (y + size.h > viewport.h - pad && anchor.y - size.h >= pad) y = anchor.y - size.h;
    // last resort: a menu larger than the viewport fits neither way — keep the top-left on-screen
    x = Math.min(Math.max(x, pad), Math.max(pad, viewport.w - pad - size.w));
    y = Math.min(Math.max(y, pad), Math.max(pad, viewport.h - pad - size.h));
    return { x, y };
}

/** positions a summoned menu box at a cursor anchor, flipping it to stay whole in the viewport
 *  (`menuFit`). Applied to the caller's `.menu` wrapper so its own scoped styling (min-width,
 *  entrance) is untouched; the action only measures the real rendered box and writes left/top,
 *  re-running when the anchor moves. The one home for root context-menu placement — the node
 *  menu, the section context menu, and the force keyframe menu all flip identically. */
export function fitMenu(
    node: HTMLElement,
    anchor: { x: number; y: number },
): { update: (a: { x: number; y: number }) => void } {
    const place = (a: { x: number; y: number }): void => {
        const fit = menuFit(
            a,
            { w: node.offsetWidth, h: node.offsetHeight },
            { w: window.innerWidth, h: window.innerHeight },
        );
        node.style.left = `${fit.x}px`;
        node.style.top = `${fit.y}px`;
    };
    place(anchor);
    return { update: place };
}

/** where a submenu flyout lands so it stays whole in the viewport, guarding all four edges
 *  (root ui.md "summoned panels fit the viewport"). The flyout opens beside its parent row —
 *  to the RIGHT by default, a `gap` past it — and near the row's top. Pure so it's testable
 *  device-free; `Menu.svelte` feeds it the measured parent rect + the flyout's own size.
 *
 * - `flipX`: place the flyout to the parent's LEFT instead. Preferred side is the right; flip
 *   only when the right clips and the left has room. If NEITHER side fits (a viewport narrower
 *   than the flyout), take whichever side has more room.
 * - `shiftY`: a vertical nudge (px) applied to the flyout's top. Nudges UP when the flyout
 *   would clip the bottom, then clamps so the nudge never pushes the TOP off-screen — a flyout
 *   taller than the viewport keeps its top (and the parent connection) visible, clipping the
 *   bottom instead. A flyout opened near the top edge is nudged DOWN to clear it.
 *
 * @example flyoutFit({ left: 100, right: 240, top: 8 }, { w: 128, h: 200 }, { w: 1280, h: 800 })
 */
export function flyoutFit(
    parent: { left: number; right: number; top: number },
    size: { w: number; h: number },
    viewport: { w: number; h: number },
    gap = 3,
    pad = 4,
): { flipX: boolean; shiftY: number } {
    const rightSpace = viewport.w - pad - (parent.right + gap);
    const leftSpace = parent.left - gap - pad;
    const flipX =
        size.w <= rightSpace ? false : size.w <= leftSpace ? true : leftSpace > rightSpace;
    let shiftY = 0;
    if (parent.top + size.h > viewport.h - pad) shiftY = viewport.h - pad - (parent.top + size.h);
    if (parent.top + shiftY < pad) shiftY = pad - parent.top;
    return { flipX, shiftY };
}
