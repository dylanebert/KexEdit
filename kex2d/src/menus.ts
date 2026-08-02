import type { MenuItem } from "./menu";
import { Easing } from "./profile";
import { Domain, SectionKind } from "./section";
import { TangentMode } from "./spline";

/**
 * The editor's context menus as PURE builders over the shared `MenuItem` language: each takes a
 * plain state descriptor (the booleans/enums its surface already derives) plus a record of its
 * actions, and returns the rows. The row arrays used to live inside `$derived.by` closures in
 * `App.svelte` / `Timeline.svelte`, where no pure test could reach them. The components keep the
 * derivation of each individual predicate; only the row construction lives here, so
 * `tests/menu.test.ts` can read a menu.
 *
 * Purity is a MODULE-GRAPH property, not just a claim about these bodies: this module reaches
 * only the other pure atoms (`menu`, `profile`, `section`, `spline`) — never the ECS, `editor`,
 * the DOM, or `localStorage`. That is what lets the tests import it with no shim, and it is
 * asserted as a graph walk in `tests/menu.test.ts` (`refine.test.ts`'s precedent).
 *
 * A descriptor field may arrive as a getter: a surface whose predicate is expensive (a full-track
 * hash walk) declares it lazily so a builder branch that never reads it never pays for it. A
 * builder therefore reads each field at most where it needs it, and never caches one across
 * branches.
 */

/** the section context menu's state (`App.svelte`'s `ctx*` deriveds). */
export type SectionMenuState = {
    /** a live optimize session on THIS section — the mode's own rows replace the menu. */
    inMode: boolean;
    /** the mode's own blocking gate (`editor.optimizeSolving`). */
    solving: boolean;
    /** enough free keys for the solve to have something to move. */
    optSolvable: boolean;
    /** the target section's kind. */
    kind: SectionKind | null;
    /** a multi-set section selection. */
    multi: boolean;
    /** any optimize session is open (`editor.optimizing !== null`). */
    modeOpen: boolean;
    canSolve: boolean;
    canSolveShape: boolean;
    canOptimize: boolean;
    canReset: boolean;
    canDelete: boolean;
};

export type SectionMenuActions = {
    solve: () => void;
    solveShape: () => void;
    optimizeSolve: () => void;
    optimizeExit: () => void;
    optimizeEnter: () => void;
    reset: () => void;
    remove: () => void;
    removeSet: () => void;
};

/** The ONE conversion row. A section is always exactly one kind, so only one direction was ever
 *  live — two rows spent the menu's space on a row that could never fire. The row's label and its
 *  action fit the target's kind (geo → force, force → geo), and it still GRAYS rather than hides
 *  when the kind fits but the invoke can't run (no live bake, a multi-set): the affordance stays
 *  discoverable, which is what the grayed-never-hidden law is for. */
function convertRow(s: SectionMenuState, a: SectionMenuActions): MenuItem {
    const toGeo = s.kind === SectionKind.Force;
    return {
        // `Convert`, no destination noun (stage 7, menus law): the section's kind implies the
        // direction — force converts to geo, geo to force — and the row is summoned ON the
        // section, so the label carries the verb alone.
        label: "Convert",
        group: "modify",
        enabled: toGeo ? s.canSolveShape : s.canSolve,
        action: toGeo ? a.solveShape : a.solve,
    };
}

/** the context menu as data: one array of MenuItems, rendered by the shared menu language —
 *  the conversion row, Optimize (force only), Reset, then Delete. multi-select (Premiere
 *  multi-clip): the single-subject rows gray (a set has no single subject, `selected === 1`);
 *  Delete carries the set-lifted enablement. the destructive Convert row (both single and bulk)
 *  was removed (kex2d-geoforce-editor stage 5): redundant with delete + append; Reset is its
 *  kind-HELD successor (kex2d-idioms stage 2) — back to the kind's default, not a flip. */
export function sectionMenu(s: SectionMenuState, a: SectionMenuActions): MenuItem[] {
    // inside a live optimize session on THIS section: the mode's own rows replace the normal
    // menu entirely — convert/delete/join aren't available inside the mode (the locked
    // decision's consent-boundary law). Solve gates on the same headroom read as the panel's
    // button (below MIN_FREE free keys there is nothing to solve — pure counting).
    if (s.inMode) {
        return [
            {
                label: "Solve",
                group: "modify",
                action: a.optimizeSolve,
                enabled: !s.solving && s.optSolvable,
            },
            { label: "Exit", group: "modify", shortcut: "Esc", action: a.optimizeExit },
        ];
    }
    const del = s.multi ? a.removeSet : a.remove;
    const items: MenuItem[] = [convertRow(s, a)];
    // the mode's entry row — a force section only (the terse verb alone: the menu is summoned
    // ON the section, so the noun restates the invoker — menus law), and only when no other
    // optimize session is already open (one mode at a time, mirroring the conversion tier's
    // per-section lock). Entry needs a live bake (the stamp is read off it), NOT headroom —
    // adding keys in-mode is the sanctioned way to create give.
    if (s.kind === SectionKind.Force && !s.multi) {
        items.push({
            label: "Optimize",
            group: "modify",
            enabled: s.canOptimize && !s.modeOpen,
            action: a.optimizeEnter,
        });
    }
    items.push({ label: "Reset", group: "lifecycle", enabled: s.canReset, action: a.reset });
    items.push({
        label: "Delete",
        group: "lifecycle",
        shortcut: "Del",
        danger: true,
        enabled: s.canDelete,
        action: del,
    });
    return items;
}

/** the node context menu's state (`App.svelte`'s `node*` deriveds). */
export type NodeMenuState = {
    /** a multi-set node selection. */
    multi: boolean;
    /** the target is node 0 — its section's entry anchor. */
    isEntry: boolean;
    /** the lockdown: no optimize session is open, so geo-node edit rows are live. */
    ok: boolean;
    /** the target node's displayed tangent mode. */
    mode: TangentMode;
    /** the target node's handles are summoned (it's in tangent edit). */
    editing: boolean;
    /** the target is its section's chain end (append acts only there). */
    isEnd: boolean;
    /** the chain-end target can be trimmed (the section keeps its two nodes). */
    canTrim: boolean;
    /** the selected set is a Delete-able suffix run. */
    suffixOk: boolean;
};

export type NodeMenuActions = {
    remove: () => void;
    removeSet: () => void;
    add: () => void;
    toggleHandles: () => void;
    pickMode: (mode: TangentMode) => void;
    pickModeSet: (mode: TangentMode) => void;
    reset: () => void;
    resetSet: () => void;
};

/** the node menu as data (the shared MenuItem language), in the grammar's canonical order: Add
 *  (`create`), then a Handles toggle over a Tangents submenu (`modify`; the three modes carry
 *  their `checked`), then Reset and Delete (`lifecycle`, the destructive row terminal). Add and
 *  Delete are both chain-end-only, so both are enablement-gated — the menu is Delete's only
 *  pointer path, the ring carries no trash button. Reset is the Reset idiom law: one click from
 *  anywhere, back to the state a fresh author would get — Reset RE-CREATES the node (default-chord
 *  continuation, tangents Auto). it's
 *  enabled whenever the subject is editable, never gated on "has something to clear" — a reset that
 *  changes nothing records no undo entry (`sameNodes`), the same no-op guard every Reset row leans
 *  on. node 0 (the entry anchor) is the exception — never
 *  appendable/trimmable, and its handle is a single free entry handle (no coupled in-side), so it
 *  carries NO Add/Delete and NO mode submenu: just Handles + Reset (back to the Auto C1 exit). */
export function nodeMenu(s: NodeMenuState, a: NodeMenuActions): MenuItem[] {
    // a multi-selection: the bulk rows (the gray-never-hide law). Delete acts on the whole set iff
    // it's a valid suffix run (else grayed); Add + Handles are single-subject, so they gray out;
    // Tangents ▸ modes + the top-level Reset apply to every member in one entry. the mode `checked` reflects the
    // ACTIVE member (Blender active-only).
    if (s.multi) {
        return [
            { label: "Add", group: "create", shortcut: "Enter", enabled: false },
            { label: "Handles", group: "modify", enabled: false },
            {
                label: "Tangents",
                group: "modify",
                enabled: s.ok,
                children: [
                    {
                        label: "Mirror",
                        group: "modify",
                        checked: s.mode === TangentMode.Mirror,
                        action: () => a.pickModeSet(TangentMode.Mirror),
                    },
                    {
                        label: "Aligned",
                        group: "modify",
                        checked: s.mode === TangentMode.Aligned,
                        action: () => a.pickModeSet(TangentMode.Aligned),
                    },
                    {
                        label: "Free",
                        group: "modify",
                        checked: s.mode === TangentMode.Free,
                        action: () => a.pickModeSet(TangentMode.Free),
                    },
                ],
            },
            { label: "Reset", group: "lifecycle", enabled: s.ok, action: a.resetSet },
            {
                label: "Delete",
                group: "lifecycle",
                shortcut: "Del",
                danger: true,
                enabled: s.suffixOk && s.ok,
                action: a.removeSet,
            },
        ];
    }
    if (s.isEntry) {
        return [
            {
                label: "Handles",
                group: "modify",
                checked: s.editing,
                enabled: s.ok,
                action: a.toggleHandles,
            },
            { label: "Reset", group: "lifecycle", enabled: s.ok, action: a.reset },
        ];
    }
    return [
        {
            label: "Add",
            group: "create",
            shortcut: "Enter",
            enabled: s.isEnd && s.ok,
            action: a.add,
        },
        {
            label: "Handles",
            group: "modify",
            checked: s.editing,
            enabled: s.ok,
            action: a.toggleHandles,
        },
        {
            label: "Tangents",
            group: "modify",
            enabled: s.ok,
            children: [
                {
                    label: "Mirror",
                    group: "modify",
                    checked: s.mode === TangentMode.Mirror,
                    action: () => a.pickMode(TangentMode.Mirror),
                },
                {
                    label: "Aligned",
                    group: "modify",
                    checked: s.mode === TangentMode.Aligned,
                    action: () => a.pickMode(TangentMode.Aligned),
                },
                {
                    label: "Free",
                    group: "modify",
                    checked: s.mode === TangentMode.Free,
                    action: () => a.pickMode(TangentMode.Free),
                },
            ],
        },
        { label: "Reset", group: "lifecycle", enabled: s.ok, action: a.reset },
        {
            label: "Delete",
            group: "lifecycle",
            shortcut: "Del",
            danger: true,
            enabled: s.canTrim && s.ok,
            action: a.remove,
        },
    ];
}

/** the force-keyframe context menu's state (`Timeline.svelte`'s `fmenu*` deriveds). */
export type KeyframeMenuState = {
    /** every selected keyframe's section is editable under the live lockdown. */
    setOk: boolean;
    /** the active keyframe's section is editable under the live lockdown. */
    activeOk: boolean;
    /** the mode-scoped Lock/Unlock row's label, or null when the row does not EXIST. */
    lock: "Lock" | "Unlock" | null;
    /** a multi-set keyframe selection. */
    multi: boolean;
    /** the active keyframe is the last in its section (it governs no following segment). */
    terminal: boolean;
    /** how many selected keyframes govern a following segment (the bulk Easing targets). */
    easeTargets: number;
    /** the addressed segment is bounded by an explicit handle (derived provenance). */
    custom: boolean;
    /** the active keyframe's easing tag. */
    ease: Easing;
    /** the active keyframe holds explicit handles (either side). */
    hasHandles: boolean;
    /** the active keyframe's stored tangent mode. */
    mode: TangentMode;
    /** the row glyph for an easing preset (the real curve, drawn by the surface). */
    presetGlyph: (ease: Easing) => string;
    /** the Custom row's glyph (the addressed segment's actual curve). */
    customGlyph: string;
};

export type KeyframeMenuActions = {
    remove: () => void;
    toggleLock: () => void;
    setEase: (ease: Easing) => void;
    chooseCustom: () => void;
    pickMode: (mode: TangentMode) => void;
};

/** the menu as data, in the grammar's canonical order: the mode-scoped Lock/Unlock, an Easing ▸
 *  submenu, a Tangents ▸ submenu (all `modify`), then Delete last — the whole SET in one entry,
 *  force multi-delete being unconditional. Easing ▸ is Linear | Cubic | Quintic (checked by the
 *  ACTIVE keyframe's tag), the one sanctioned WITHIN-group separator, then Custom — Custom
 *  materializes handles and steps into handle edit, a different kind of row but the same group, so
 *  the divider is authored rather than derived. the preset rows apply to ALL selected non-terminal keyframes — the caller resolves
 *  that member set and reports only its size (`easeTargets`), so the row grays when none is
 *  applicable. each row carries its real curve glyph (drawn from the same
 *  influence the segment uses, so the icon can't drift). Custom is single-subject (the active): both
 *  the derived-provenance indicator (checked when an explicit handle bounds its segment) AND a choice
 *  — picking it materializes the segment's handles and steps into handle edit; picking a preset
 *  clears them back. a single terminal keyframe governs no segment, so it shows Delete alone. */
export function keyframeMenu(s: KeyframeMenuState, a: KeyframeMenuActions): MenuItem[] {
    const items: MenuItem[] = [];
    // the Lock/Unlock row (kex2d stage 6): SHOWN only in optimize mode on the optimizing
    // section's own keys, HIDDEN everywhere else (`lockLabel`'s omit-vs-gray law) — the mouse
    // path to the same set-toggle `Q` drives, over the same filtered member set.
    if (s.lock !== null)
        items.push({ label: s.lock, group: "modify", shortcut: "Q", action: a.toggleLock });
    // shown whenever any easing target could exist (a multi-set, or a single non-terminal keyframe);
    // enabled only when the selection has a non-terminal member — else grayed, never hidden.
    if (s.multi || !s.terminal) {
        const easeRow = (label: string, e: Easing): MenuItem => ({
            label,
            group: "modify",
            glyph: s.presetGlyph(e),
            checked: !s.custom && s.ease === e,
            action: () => a.setEase(e),
        });
        items.push({
            label: "Easing",
            group: "modify",
            enabled: s.easeTargets > 0 && s.setOk,
            children: [
                easeRow("Linear", Easing.Linear),
                easeRow("Cubic", Easing.Cubic),
                easeRow("Quintic", Easing.Quintic),
                { separator: true },
                // Custom is single-subject (the active) and steps into handle edit on it — a terminal
                // keyframe governs no segment, a state single-select can't reach (its whole Easing ▸ is
                // hidden), so gray Custom when the active is terminal even while non-terminal siblings
                // keep the preset rows live.
                {
                    label: "Custom",
                    group: "modify",
                    enabled: !s.terminal && s.activeOk,
                    glyph: s.customGlyph,
                    checked: s.custom,
                    action: a.chooseCustom,
                },
            ],
        });
    }
    // a keyframe with explicit handles (either side) carries a Tangents ▸ mode submenu (Mirror |
    // Aligned | Free, checked by the stored mode) — the geo node menu's convention. shown even at a
    // terminal keyframe (whose only handle is the incoming in-side). no Reset row: the way back to
    // derived is picking a preset in Easing ▸ (which clears the segment's handles).
    if (s.hasHandles) {
        const modeRow = (label: string, mode: TangentMode): MenuItem => ({
            label,
            group: "modify",
            checked: s.mode === mode,
            action: () => a.pickMode(mode),
        });
        items.push({
            label: "Tangents",
            group: "modify",
            enabled: s.activeOk,
            children: [
                modeRow("Mirror", TangentMode.Mirror),
                modeRow("Aligned", TangentMode.Aligned),
                modeRow("Free", TangentMode.Free),
            ],
        });
    }
    items.push({
        label: "Delete",
        group: "lifecycle",
        shortcut: "Del",
        danger: true,
        enabled: s.setOk,
        action: a.remove,
    });
    return items;
}

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

/** the append flyout as data, one instance of the shared menu language. both choices are
 *  always possible (a chain end always accepts a geo or force section), so neither declares
 *  enablement — the substrate carries it, this menu just has nothing to disable. */
export function appendMenu(a: { append: (kind: SectionKind) => void }): MenuItem[] {
    return [
        {
            label: "Geo",
            group: "create",
            aria: "Append geometry section",
            action: () => a.append(SectionKind.Geo),
        },
        {
            label: "Force",
            group: "create",
            aria: "Append force section",
            action: () => a.append(SectionKind.Force),
        },
    ];
}
