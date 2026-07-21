/**
 * A row in the shared menu language (`.menu` / `.menu-item`, App.svelte). The section
 * context menu and the append flyout both render an array of these, so a menu is pure data
 * and enablement is a first-class per-item property, not a per-menu special case.
 */
export type MenuItem = {
    /** the row label. */
    label: string;
    /** a11y name when the visible label is terse; defaults to `label`. */
    aria?: string;
    /** an inline shortcut hint, right-aligned by the row (e.g. "Del"). */
    shortcut?: string;
    /** the destructive red tint. */
    danger?: boolean;
    /**
     * whether the action is possible right now. `false` renders the row disabled — dimmed,
     * non-interactive, `aria-disabled` — and the action can't fire. Omitted = always enabled.
     * Derive it from editor state ($derived): the same move as a summoned surface deriving
     * its visibility from its subject existing.
     */
    enabled?: boolean;
    /** the row's action; a disabled row never invokes it. */
    action: () => void;
};
