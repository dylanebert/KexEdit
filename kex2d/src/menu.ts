/**
 * The row taxonomy, in canonical order — the menus' ordering law:
 *
 * - `create` — the document gains an object (Add, the append flyout's Geo/Force).
 * - `modify` — changes the subject that summoned the menu, or enters / acts in / leaves a mode
 *   scoped to it (Convert, Pin, Solve, Exit, Handles, Tangents ▸, Easing ▸, Lock/Unlock,
 *   Meters/Seconds). The residual class, honestly.
 * - `structure` — changes the CHAIN, reaching past the subject to a neighbor (Cut makes a new
 *   section, Join destroys the one beside it).
 * - `lifecycle` — the subject ends at its creation state or gone (Reset, then Delete).
 *
 * A menu's rows sort by this order, then by frequency WITHIN a group (the old free-form
 * frequency rule, demoted to a tiebreaker where it's cheap and unenforceable-but-harmless).
 * `danger` implies the terminal row of the whole menu. The grammar is machine-checked over every
 * builder across the full state matrix in `tests/menu.test.ts` — it is a gate, not a convention.
 */
export const GROUPS = ["create", "modify", "structure", "lifecycle"] as const;

export type MenuGroup = (typeof GROUPS)[number];

/** a keyboard binding: the `KeyboardEvent.key` values that fire it, and the hint a menu row
 *  advertising the same action prints. */
export type Binding = { readonly keys: readonly string[]; readonly hint: string };

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
 * keyframe); `append` — `controls.ts`; `exitMode` — `App.svelte`; `lock` — `Timeline.svelte`;
 * `cut` — three landing surfaces, all through `keys.ts` deciders: a selected node's own landmark
 * (`controls.ts`), a selected force keyframe's own landmark (`Timeline.svelte`), and a selected
 * SECTION's own playhead (`controls.ts`, `kex2d-structural-editing` stage 8) — the reopening of
 * what used to be a hard asymmetry: a free CURSOR position has no keyboard anchor to name, but
 * the playhead does (`editor-ui.md` Menus, `editor-ui.md`'s transport-read clause), so the
 * clip-strip's cursor-anchored Cut row now advertises the same key its playhead-exact keyboard
 * twin fires. `join` — `controls.ts`, the bulk section-set rung beside `remove`'s own multi
 * branch (Blender/Audacity's own key): unlike Cut it needs no cursor position, only the live
 * selected set, so it's wired directly rather than deferred.
 * `Escape` and `Delete` also drive dismissal/guard rungs that are nobody's menu row; those stay
 * raw literals, and `tests/menu.test.ts` pins exactly which files may hold one.
 */
export const BINDINGS = {
    remove: { keys: ["Delete", "Backspace"], hint: "Del" },
    append: { keys: ["Enter"], hint: "Enter" },
    exitMode: { keys: ["Escape"], hint: "Esc" },
    lock: { keys: ["q", "Q"], hint: "Q" },
    cut: { keys: ["c", "C"], hint: "C" },
    join: { keys: ["j", "J"], hint: "J" },
} as const satisfies Record<string, Binding>;

/** whether a `KeyboardEvent.key` fires this binding.
 *
 * @example if (bound(BINDINGS.remove, e.key)) deleteSelection();
 */
export function bound(binding: Binding, key: string): boolean {
    return binding.keys.includes(key);
}

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
