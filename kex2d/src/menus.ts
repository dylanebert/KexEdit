import { BINDINGS, type MenuItem } from "./menu";
import { Easing, sampleForce } from "./profile";

export const EASINGS: readonly (readonly [string, Easing])[] = [
    ["Linear", Easing.Linear],
    ["Cubic", Easing.Cubic],
    ["Quintic", Easing.Quintic],
];

/** Named shared families, sampled by the same profile as authored records. */
function presetGlyph(ease: Easing): string {
    const points = [
        { s: 0, g: 0, ease },
        { s: 1, g: 1, ease },
    ];
    return Array.from(
        { length: 17 },
        (_, i) => `${i ? "L" : "M"}${3 + i} ${12 - 10 * sampleForce(points, i / 16)}`,
    ).join(" ");
}
export const EASING_GLYPHS = Object.fromEntries(
    EASINGS.map(([, ease]) => [ease, presetGlyph(ease)]),
) as Record<Easing, string>;
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
 * right-click. The live timeline has only the span's secondary menu. The ruler's pure unit
 * picker remains for its domain contract; no lane/gap menu or expansion route remains.
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

// Secondary span actions. Creation is the explicit local Add tool, not a row menu.

/** the span menu's state (`Timeline.svelte`'s span `ctx*` deriveds). */
export type SpanMenuState = {
    /** the record's own easing tag — what the Easing ▸ rows check against. */
    ease: Easing;
    /** the row glyph for an easing preset (the real curve, drawn by the surface). */
    presetGlyph: (ease: Easing) => string;
    /** the record can be deleted — false only while a live gesture holds it. */
    canDelete: boolean;
    entry?: { owned: boolean; summary: string };
};

export type SpanMenuActions = {
    setEase: (ease: Easing) => void;
    remove: () => void;
    field?: (key: "exit" | "start" | "end" | "entry") => void;
    inherit?: () => void;
    inspect?: () => void;
};

/** Shared secondary actions for the on-object line and span context click. Easing keeps its
 * checked profile previews; ownership is disclosed only in Entry, and Delete stays terminal. */
export function spanMenu(s: SpanMenuState, a: SpanMenuActions): MenuItem[] {
    const easeRow = (label: string, e: Easing): MenuItem => ({
        label,
        group: "modify",
        glyph: s.presetGlyph(e),
        checked: s.ease === e,
        action: () => a.setEase(e),
    });
    return [
        ...(a.field
            ? ([
                  { label: "Target…", group: "modify", action: () => a.field!("exit") },
                  { label: "Start…", group: "modify", action: () => a.field!("start") },
                  { label: "End…", group: "modify", action: () => a.field!("end") },
              ] satisfies MenuItem[])
            : []),
        {
            label: "Easing",
            group: "modify",
            children: [...EASINGS.map(([name, ease]) => easeRow(name, ease))],
        },
        ...(s.entry && a.field && a.inherit
            ? ([
                  {
                      label: "Entry",
                      group: "modify",
                      children: [
                          { label: s.entry.summary, group: "modify", enabled: false },
                          {
                              label: s.entry.owned ? "Edit entry…" : "Override entry…",
                              group: "modify",
                              action: () => a.field!("entry"),
                          },
                          ...(s.entry.owned
                              ? ([
                                    { label: "Inherit entry", group: "modify", action: a.inherit },
                                ] satisfies MenuItem[])
                              : []),
                      ],
                  },
              ] satisfies MenuItem[])
            : []),
        ...(a.inspect
            ? ([
                  { label: "Inspect result", group: "modify", action: a.inspect },
              ] satisfies MenuItem[])
            : []),
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
