/**
 * A row in the shared menu language (`Menu.svelte`, rendered inside the `.menu` look). The
 * section context menu, the node context menu, and the append flyout all render an array of
 * these, so a menu is pure data and enablement, separators, and submenus are first-class
 * per-item properties, not per-menu special cases.
 */
export type MenuItem = {
    /** the row label. omitted for a separator. */
    label?: string;
    /** a11y name when the visible label is terse; defaults to `label`. */
    aria?: string;
    /** an inline shortcut hint, right-aligned by the row (e.g. "Del"). */
    shortcut?: string;
    /** the destructive red tint. */
    danger?: boolean;
    /** a selected/active row (the accent-lit state) — e.g. the current tangent mode in a
     *  mode-picker submenu. Omitted = not a selectable row. */
    checked?: boolean;
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
