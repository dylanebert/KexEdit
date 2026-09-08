import { BINDINGS, type MenuItem } from "./menu";
import { Easing } from "./profile";
import { Domain } from "./section";

/**
 * The editor's context menus as PURE builders over the shared `MenuItem` language: each takes a
 * plain state descriptor (the booleans/enums its surface already derives) plus a record of its
 * actions, and returns the rows. The row arrays used to live inside `$derived.by` closures in
 * `App.svelte` / `Timeline.svelte`, where no pure test could reach them. The components keep the
 * derivation of each individual predicate; only the row construction lives here, so
 * `tests/menu.test.ts` can read a menu.
 *
 * Purity is a MODULE-GRAPH property, not just a claim about these bodies: this module reaches
 * only the other pure atoms (`menu`, `profile`, `section`) — never the ECS, `editor`,
 * the DOM, or `localStorage`. That is what lets the tests import it with no shim, and it is
 * asserted as a graph walk in `tests/menu.test.ts` (`refine.test.ts`'s precedent).
 *
 * A descriptor field may arrive as a getter: a surface whose predicate is expensive (a full-track
 * hash walk) declares it lazily so a builder branch that never reads it never pays for it. A
 * builder therefore reads each field at most where it needs it, and never caches one across
 * branches.
 *
 * The pose era's five builders — the section context menu, the node menu, the force-keyframe
 * menu, the velocity-strip band menu and the append flyout — went with the subjects they
 * summoned on (`retired/pose-ux`): there are no sections, nodes, keyframes or strips left to
 * right-click. Their replacements are the lane timeline's own two, a ROW menu on the lane column
 * and a SPAN menu on a record, plus the ruler's unchanged unit picker.
 */

/** the ruler context menu's state (`Timeline.svelte`'s `rulerMenuItems`). */
export type RulerMenuState = {
    /** the live track domain — the store's own unit, what `checked` reads. */
    domain: Domain;
    /** whether picking Meters can actually run (the caller's own predicate — `rulerMenuItems`). */
    metersEnabled: boolean;
    /** whether picking Seconds can actually run (same, resolved independently). */
    secondsEnabled: boolean;
};

/** flat rows, not a `Units ▸` submenu: the menu has nothing else in it, so nesting would spend a
 *  click opening a submenu with no sibling rows to justify it (`editor-ui.md`'s terse-rows law —
 *  a menu that's only ever one submenu should just be its rows). `checked` reads the live
 *  `Track.domain` the caller hands in — the store's own unit, so a lit row can't lie about what
 *  the chart reads. Each row's enablement is its OWN opaque boolean (the caller resolves both
 *  predicates; the derivation is `Timeline.svelte`'s), so the two can disagree — an enabled row
 *  is one whose pick can actually run, grayed otherwise, never hidden. No keyboard shortcut — the
 *  second feel check-in's call: the pick doesn't warrant one, and it is an undoable document op
 *  now. */
export function rulerMenu(s: RulerMenuState, a: { pick: (target: Domain) => void }): MenuItem[] {
    const row = (label: string, target: Domain, enabled: boolean): MenuItem => ({
        label,
        group: "modify",
        enabled,
        checked: s.domain === target,
        action: () => a.pick(target),
    });
    return [
        row("Meters", Domain.Distance, s.metersEnabled),
        row("Seconds", Domain.Time, s.secondsEnabled),
    ];
}

// ── the lane timeline's own two menus (S3c) ───────────────────────────────────────
// A row menu on the lane column and a span menu on a record — the two subjects the rebuilt
// timeline actually has. Neither takes a `Lane`: a builder that imported the lane enum would put
// `lanes.ts` on this module's graph for a label it is handed anyway (`menus.ts`'s own purity
// pin), so the caller passes the quantity's NAME and the rows print it.

/** the lane row menu's state (`Timeline.svelte`'s row `ctx*` deriveds). */
export type RowMenuState = {
    /** the row's authored quantity, for the Add row's own label (`lanes.laneName`). */
    name: string;
    /** the row stands open in the curve view — the toggle names the act it will perform. */
    expanded: boolean;
    /** a record CAN be added at the clicked station: the station falls in a gap with at least
     *  `RECORD_FLOOR` of room before the next record. Grayed, never hidden, when it can't. */
    canAdd: boolean;
};

export type RowMenuActions = {
    /** author a flat record at the clicked station (`history.addRecord`, the drag-out's twin). */
    add: () => void;
    /** expand or collapse this row in place (`timeline.toggleExpanded`). */
    toggleExpand: () => void;
};

/** the row menu as data: Add first (the one row that changes the document), then the step-in
 *  toggle. The toggle names the ACT rather than carrying a check — a row that says "Collapse"
 *  while open tells the person what the click does, which is what `editor-ui.md` asks of a
 *  mixed-capable toggle. No Delete: a row is a lane, and a lane is not a thing a person removes. */
export function rowMenu(s: RowMenuState, a: RowMenuActions): MenuItem[] {
    return [
        {
            label: `Add ${s.name} segment`,
            group: "create",
            enabled: s.canAdd,
            action: a.add,
        },
        {
            label: s.expanded ? "Collapse" : "Expand",
            group: "modify",
            action: a.toggleExpand,
        },
    ];
}

/** the span menu's state (`Timeline.svelte`'s span `ctx*` deriveds). */
export type SpanMenuState = {
    /** the record's own easing tag — what the Easing ▸ rows check against. */
    ease: Easing;
    /** the row glyph for an easing preset (the real curve, drawn by the surface). */
    presetGlyph: (ease: Easing) => string;
    /** the record can be deleted — false only while a live gesture holds it. */
    canDelete: boolean;
};

export type SpanMenuActions = {
    setEase: (ease: Easing) => void;
    remove: () => void;
};

/** the span menu as data: an Easing ▸ submenu checked by the record's own tag, then Delete as the
 *  menu's terminal danger row. Easing is a submenu rather than three flat rows because the menu
 *  has a sibling row to justify the nesting, unlike {@link rulerMenu}'s two. Every span owns an
 *  easing (the record carries the tag on every lane, spec Wire v4), so the row never grays. */
export function spanMenu(s: SpanMenuState, a: SpanMenuActions): MenuItem[] {
    const easeRow = (label: string, e: Easing): MenuItem => ({
        label,
        group: "modify",
        glyph: s.presetGlyph(e),
        checked: s.ease === e,
        action: () => a.setEase(e),
    });
    return [
        {
            label: "Easing",
            group: "modify",
            children: [
                easeRow("Linear", Easing.Linear),
                easeRow("Cubic", Easing.Cubic),
                easeRow("Quintic", Easing.Quintic),
            ],
        },
        {
            label: "Delete",
            group: "lifecycle",
            shortcut: BINDINGS.remove.hint,
            danger: true,
            enabled: s.canDelete,
            action: a.remove,
        },
    ];
}
