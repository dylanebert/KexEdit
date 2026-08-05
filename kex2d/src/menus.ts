import { BINDINGS, type MenuItem } from "./menu";
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
    /** a live pin session on THIS section — the mode's own rows replace the menu. */
    inMode: boolean;
    /** the mode's own blocking gate (`editor.pinSolving`). */
    solving: boolean;
    /** enough free keys for the solve to have something to move. */
    pinSolvable: boolean;
    /** the target section's kind. */
    kind: SectionKind | null;
    /** a multi-set section selection. */
    multi: boolean;
    /** any pin session is open (`editor.pinning !== null`). */
    modeOpen: boolean;
    canSolve: boolean;
    canSolveShape: boolean;
    canPin: boolean;
    canReset: boolean;
    canDelete: boolean;
    /** the resolved cursor position is an interior point AND `sectionOpsAllowed` — Cut's own
     *  enablement (`editor-ui.md`'s grays-never-hides law). Single-subject only: omitted
     *  entirely on a multi-set (below), never read there. OPTIONAL — the resolution wiring
     *  (`editor-ui.md`'s toLocal/toLocalU lens) lands with `kex2d-structural-editing` stage 6;
     *  until a caller supplies it, Cut ships present but conservatively grayed (never `true` by
     *  default), the same shape the `structure` group itself shipped in at stage 3. */
    canCut?: boolean;
    /** whether THIS surface can serve Cut at all — the absent-not-grayed surface law
     *  (`editor-ui.md` Menus, the surface axis): `true` ONLY from the timeline clip strip, its
     *  sole surface; `false` everywhere else (the viewport span, the graph). A row that can never
     *  enable on a surface is ABSENT there, not grayed — graying means "not now", absence means
     *  "not here" — so this is structural (never optional, unlike `canCut` above): every call
     *  site must say which surface it is. A position-along-arclength op has no honest cursor
     *  reading on the canvas (the spatial view `pickSectionArc`/`pickCut` used to fake one for;
     *  both are gone, feel round 7) or on the graph, a plot of values rather than a strip of
     *  subjects (feel round 8 — its empty space names no object, so a right-click there reads as
     *  the click having hit something it didn't; `Timeline.svelte`'s chart carries no
     *  `oncontextmenu` handler at all). `cutSurface: false` there omits the row entirely rather
     *  than shipping it permanently disabled (the exact shape feel round 7 rejected on the force
     *  graph BEFORE round 8 removed the graph as a surface outright). Single-subject only, like
     *  `canCut` — never read on a multi-set, where Join takes the slot instead. */
    cutSurface: boolean;
    /** the selected section SET is a valid Join run — `controls.sectionsJoinable` (a contiguous
     *  run of ≥2, one kind). Multi-set only: never read on a single-subject menu (below, the
     *  Cut/Pin symmetry's mirror image). OPTIONAL, the same shape as `canCut` — `sectionMenu`'s
     *  own state is only ever built in `App.svelte`, out of this stage's scope, so wiring a real
     *  reading lands there even though the predicate itself needs no cursor lens (unlike Cut);
     *  until supplied, Join ships present but conservatively grayed (never `true` by default). */
    canJoin?: boolean;
};

export type SectionMenuActions = {
    solve: () => void;
    solveShape: () => void;
    pinSolve: () => void;
    pinExit: () => void;
    pinEnter: () => void;
    reset: () => void;
    remove: () => void;
    removeSet: () => void;
    /** the cursor-anchored Cut, named apart from `NodeMenuActions`/`KeyframeMenuActions`' `cut` —
     *  this surface carries no keyboard binding at all (the locked decision's shortcut
     *  asymmetry), so the two acts must stay apart by name for the key-act seam's `Acts` table to
     *  tell them apart (`append`/`add`'s own precedent). */
    cutAt: () => void;
    /** the set-lifted Join (stage 5) — merges the selected contiguous same-kind run into one
     *  section as one undo entry (`history.joinSections`). */
    join: () => void;
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
 *  the conversion row, Pin (force only) / Join (multi only), Cut (single only), Reset, then
 *  Delete. multi-select (Premiere multi-clip): the single-subject rows gray (a set has no single
 *  subject, `selected === 1`); Delete carries the set-lifted enablement, Pin and Cut OMIT instead
 *  (a multi-set has neither a single subject to pin nor a single cursor position to cut at) while
 *  Join takes their vacated slot (a single-subject selection has nothing to join). the
 *  destructive Convert row (both single and bulk) was removed (kex2d-geoforce-editor stage 5):
 *  redundant with delete + append; Reset is its kind-HELD successor (kex2d-idioms stage 2) — back
 *  to the kind's default, not a flip. */
export function sectionMenu(s: SectionMenuState, a: SectionMenuActions): MenuItem[] {
    // inside a live pin session on THIS section: the mode's own rows replace the normal
    // menu entirely — convert/delete/join aren't available inside the mode (the locked
    // decision's consent-boundary law). Solve gates on the same headroom read as the panel's
    // button (below MIN_FREE free keys there is nothing to solve — pure counting).
    if (s.inMode) {
        return [
            {
                label: "Solve",
                group: "modify",
                action: a.pinSolve,
                enabled: !s.solving && s.pinSolvable,
            },
            {
                label: "Exit",
                group: "modify",
                shortcut: BINDINGS.exitMode.hint,
                action: a.pinExit,
            },
        ];
    }
    const del = s.multi ? a.removeSet : a.remove;
    const items: MenuItem[] = [convertRow(s, a)];
    // the mode's entry row — a force section only (the terse verb alone: the menu is summoned
    // ON the section, so the noun restates the invoker — menus law), and only when no other
    // pin session is already open (one mode at a time, mirroring the conversion tier's
    // per-section lock). Entry needs a live bake (the stamp is read off it), NOT headroom —
    // adding keys in-mode is the sanctioned way to create give.
    if (s.kind === SectionKind.Force && !s.multi) {
        items.push({
            label: "Pin",
            group: "modify",
            enabled: s.canPin && !s.modeOpen,
            action: a.pinEnter,
        });
    }
    // Cut — single-subject, like Pin above: a multi-section selection has no single cursor
    // position to cut at, so it's OMITTED there (never grayed) rather than shown dead, the same
    // "a row that could never fire on this subject" law that keeps Pin off the multi menu. No
    // `shortcut`: the cursor-anchored section Cut carries no binding at all (the locked
    // decision's asymmetry — `nodeMenu`/`keyframeMenu`'s Cut rows bind `K`, this one can't name a
    // key for a free position). Join is Cut's multi-set mirror: a single-subject selection has
    // nothing to join (`joinNext` needs a same-kind neighbor beside it, and the rejected
    // single-subject "Join Next" would read asymmetric next to a point-anchored Cut — the locked
    // decision), so it's OMITTED there and shown only over a multi-set, `shortcut`ed (Blender/
    // Audacity's `J`, unlike Cut's cursor-anchored asymmetry) since the whole selected set names
    // the run with no cursor needed. `cutSurface` is the OTHER omission axis (stage 7): the
    // canvas can never serve Cut regardless of selection shape, so the row is absent there too —
    // "a row that could never fire on this SURFACE" is the same law as "on this subject", just
    // read off a different field, and both gate the row's PRESENCE, never its `enabled`.
    if (!s.multi && s.cutSurface) {
        items.push({
            label: "Cut",
            group: "structure",
            enabled: s.canCut === true,
            action: a.cutAt,
        });
    } else if (s.multi) {
        items.push({
            label: "Join",
            group: "structure",
            shortcut: BINDINGS.join.hint,
            enabled: s.canJoin === true,
            action: a.join,
        });
    }
    items.push({ label: "Reset", group: "lifecycle", enabled: s.canReset, action: a.reset });
    items.push({
        label: "Delete",
        group: "lifecycle",
        shortcut: BINDINGS.remove.hint,
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
    /** the lockdown: no pin session is open, so geo-node edit rows are live. */
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
    /** the target is a valid Cut point — `acts.nodeCuttable` (interior, never node 0 or the
     *  chain end) — read only on the single-subject rung; the multi rung grays unconditionally.
     *  OPTIONAL, same shape as `SectionMenuState.canCut`: not `true` by default. */
    canCut?: boolean;
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
    cut: () => void;
};

/** the node menu as data (the shared MenuItem language), in the grammar's canonical order: Add
 *  (`create`), then a Handles toggle over a Tangents submenu (`modify`; the three modes carry
 *  their `checked`), then Cut (`structure`), then Reset and Delete (`lifecycle`, the destructive
 *  row terminal). Add and Delete are both chain-end-only, so both are enablement-gated — the menu
 *  is Delete's only pointer path, the ring carries no trash button. Reset is the Reset idiom law:
 *  one click from anywhere, back to the state a fresh author would get — Reset RE-CREATES the node
 *  (default-chord continuation, tangents Auto). it's
 *  enabled whenever the subject is editable, never gated on "has something to clear" — a reset that
 *  changes nothing records no undo entry (`sameNodes`), the same no-op guard every Reset row leans
 *  on. node 0 (the entry anchor) is the exception — never
 *  appendable/trimmable/cuttable (it's the section entry, never an interior split point — a
 *  structural impossibility rather than a contextual one, so it's OMITTED like Add/Delete, not
 *  grayed), and its handle is a single free entry handle (no coupled in-side), so it
 *  carries NO Add/Delete/Cut and NO mode submenu: just Handles + Reset (back to the Auto C1 exit). */
export function nodeMenu(s: NodeMenuState, a: NodeMenuActions): MenuItem[] {
    // a multi-selection: the bulk rows (the gray-never-hide law). Delete acts on the whole set iff
    // it's a valid suffix run (else grayed); Add + Handles are single-subject, so they gray out;
    // Tangents ▸ modes + the top-level Reset apply to every member in one entry. the mode `checked` reflects the
    // ACTIVE member (Blender active-only).
    if (s.multi) {
        return [
            { label: "Add", group: "create", shortcut: BINDINGS.append.hint, enabled: false },
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
            // Cut is single-subject (a cut lands at ONE node) — a multi-set grays it
            // unconditionally, the same shape as Add/Handles above (`canCut` isn't even read).
            { label: "Cut", group: "structure", shortcut: BINDINGS.cut.hint, enabled: false },
            { label: "Reset", group: "lifecycle", enabled: s.ok, action: a.resetSet },
            {
                label: "Delete",
                group: "lifecycle",
                shortcut: BINDINGS.remove.hint,
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
            shortcut: BINDINGS.append.hint,
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
        {
            label: "Cut",
            group: "structure",
            shortcut: BINDINGS.cut.hint,
            enabled: s.ok && s.canCut === true,
            action: a.cut,
        },
        { label: "Reset", group: "lifecycle", enabled: s.ok, action: a.reset },
        {
            label: "Delete",
            group: "lifecycle",
            shortcut: BINDINGS.remove.hint,
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
    /** the ACTIVE keyframe is a valid Cut point — `acts.keyframeCuttable` (interior, never the
     *  section entry or exit) — read only outside a multi-set (below), where Cut grays regardless
     *  (single-subject, like Custom, but unlike Custom it needs exactly ONE clean position).
     *  OPTIONAL, same shape as `SectionMenuState.canCut`: not `true` by default. */
    canCut?: boolean;
    /** no pin session is open ANYWHERE (`acts.sectionOpsAllowed`) — Cut's OWN gate, stricter than
     *  `activeOk` (which only checks the active keyframe's OWN section, `sectionEditable`, and
     *  reads `true` inside a session on that same section — exactly the case Cut must still bar,
     *  since `cutSection` refuses on ANY open session). Cut reads this, never `activeOk` — the
     *  stage-6 review's finding: reusing `activeOk` here let the row read enabled on the pinning
     *  session's own interior keyframe while the act silently no-op'd underneath it. */
    opsAllowed: boolean;
};

export type KeyframeMenuActions = {
    remove: () => void;
    toggleLock: () => void;
    setEase: (ease: Easing) => void;
    chooseCustom: () => void;
    pickMode: (mode: TangentMode) => void;
    cut: () => void;
};

/** the menu as data, in the grammar's canonical order: the mode-scoped Lock/Unlock, an Easing ▸
 *  submenu, a Tangents ▸ submenu (all `modify`), then Cut (`structure`), then Delete last — the
 *  whole SET in one entry, force multi-delete being unconditional. Easing ▸ is Linear | Cubic | Quintic (checked by the
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
    // the Lock/Unlock row (kex2d stage 6): SHOWN only in pin mode on the pinning
    // section's own keys, HIDDEN everywhere else (`lockLabel`'s omit-vs-gray law) — the mouse
    // path to the same set-toggle `Q` drives, over the same filtered member set.
    if (s.lock !== null)
        items.push({
            label: s.lock,
            group: "modify",
            shortcut: BINDINGS.lock.hint,
            action: a.toggleLock,
        });
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
    // Cut — a terminal active keyframe governs no segment, so it's structurally never an
    // interior split point (Easing's own reason to omit its whole submenu); shown otherwise, but
    // GRAYED on a multi-set even when the active is non-terminal — unlike Custom (which stays
    // single-subject regardless of `multi`), Cut needs exactly ONE clean position and a set
    // selection doesn't read as one. `opsAllowed`, NOT `activeOk`, is Cut's own consent-boundary
    // check — Cut is barred while ANY pin session is open, on any section (the widened boundary),
    // stricter than the per-subject `activeOk` Tangents ▸ and Custom above carry (a stage-6
    // review finding: `activeOk` reads true on the pinning session's own keyframe, which Cut must
    // still bar since `cutSection` refuses there too).
    if (!s.terminal) {
        items.push({
            label: "Cut",
            group: "structure",
            shortcut: BINDINGS.cut.hint,
            enabled: s.canCut === true && !s.multi && s.opsAllowed,
            action: a.cut,
        });
    }
    items.push({
        label: "Delete",
        group: "lifecycle",
        shortcut: BINDINGS.remove.hint,
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
