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
