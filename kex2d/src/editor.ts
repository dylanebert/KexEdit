/** ephemeral editor state — the current selection. lives outside ECS because it
 *  doesn't persist (no save/load, no replay). plain mutable singleton; Svelte reads
 *  it via the per-RAF tick pattern in App.
 *
 *  there are no tools or modes: you select a node and drag it in the viewport, a
 *  force point on the timeline curve, a whole section, a velocity strip in the header
 *  band, the track START anchor, or the track-start one-shot (S3, its own point kind) —
 *  six selection kinds (below) behind one unified container, so a contextual action
 *  never fights over its target. */

import type { State } from "@dylanebert/shallot";
import { createHistory, type History, redirectHistory } from "./history";
import type { OptimizeOutcome, UnreachableReason } from "./optimize";
import {
    entryOneShot,
    forceAt,
    Handle,
    handleAt,
    sectionAt,
    setBakeFreeze,
    setBakeLanding,
    stripAt,
    stripKeyframeAt,
} from "./track";
import type { TangentSide } from "./tangents";

/** the editor surface the pointer is over — the router for surface-scoped keys
 *  (the Blender/Unity hovered-surface model). */
export type Surface = "viewport" | "timeline";

/** a per-kind selection: a set of members with the last-selected one active. single-select is the
 *  size-1 case (the substrate, not a parallel path). the node kind holds live eids (resolved fresh
 *  each pick); the force and section kinds hold stable ids (`Force.id` / `Section.id`), per the
 *  stable-form recycle-safety law. members are insertion-ordered (JS Set), so toggling out the active
 *  member promotes the most-recently-added survivor deterministically.
 *
 *  the editor's per-kind views (`editor.nodes`, `editor.forces`, etc.) return a fresh `Selection`
 *  per access whose `ids` and `active` are getter-only properties — a new `Set` is allocated on
 *  each `ids` read, and `active` is derived from the unified member set. a direct assignment like
 *  `editor.forces.active = 5` type-checks (the interface declares `active: number | null`) but
 *  throws at runtime (the property has no setter on the getter-only view). use the select* APIs
 *  (`selectForce`, `selectForces`, etc.) to mutate selection state. */
export interface Selection {
    /** the selected members — eids (node kind) or stable ids (force/section kind). */
    ids: Set<number>;
    /** the active (last-selected) member: the single subject the readout, popover, manipulator ring,
     *  and snap resolution anchor to. null iff `ids` is empty; otherwise always a member of `ids`. */
    active: number | null;
}

/** the last member in insertion order, or null — the active-promotion pick when the active is
 *  toggled out (the most-recently-added survivor). */
export function lastMember(ids: Set<number>): number | null {
    let last: number | null = null;
    for (const id of ids) last = id;
    return last;
}

/** replace a selection with a single member, or clear it (null) — the size-1 (or size-0) case that
 *  makes single-select the default form. */
export function setMember(sel: Selection, id: number | null): void {
    sel.ids.clear();
    if (id !== null) sel.ids.add(id);
    sel.active = id;
}

/** toggle `id` in a selection (shift-click semantics): add it and make it active, or remove it —
 *  promoting the most-recently-added survivor active when the removed member was the active one. */
export function toggleMember(sel: Selection, id: number): void {
    if (sel.ids.delete(id)) {
        if (sel.active === id) sel.active = lastMember(sel.ids);
    } else {
        sel.ids.add(id);
        sel.active = id;
    }
}

// ── the unified selection container (S1) ────────────────────────────────────────
// one ordered member set of {kind, id} + one active {kind, id}. the per-kind `Selection`
// records (`nodes`, `forces`, `sections`, `strips`, `stripKfs`) and the two booleans
// (`start`, `oneShot`) are derived reads over this set — they stop being storage. the
// `exclusive*` family is deleted: a plain click replace-selects, clearing every member of
// every kind, and shift/marquee toggle within one kind after sweeping the others.

/** the selection kinds — one per subject type. `start` and `oneShot` are singleton kinds
 *  (at most one of each per track), carried with a constant id 0. */
export type SelKind = "node" | "force" | "section" | "strip" | "stripKf" | "start" | "oneShot";

/** a typed subject reference in the unified selection set. */
export interface Member {
    kind: SelKind;
    id: number;
}

const _members = new Map<string, Member>();
let _active: Member | null = null;

const memberKey = (kind: SelKind, id: number): string => `${kind}:${id}`;

function memberAdd(kind: SelKind, id: number): void {
    _members.set(memberKey(kind, id), { kind, id });
}

function memberRemove(kind: SelKind, id: number): void {
    _members.delete(memberKey(kind, id));
}

function memberHas(kind: SelKind, id: number): boolean {
    return _members.has(memberKey(kind, id));
}

function clearAllMembers(): void {
    _members.clear();
    _active = null;
}

function clearKind(kind: SelKind): void {
    for (const [key, m] of _members) if (m.kind === kind) _members.delete(key);
    if (_active !== null && _active.kind === kind) _active = lastMemberOfAny();
}

function sweepOtherKinds(keep: readonly SelKind[]): void {
    const keepSet = new Set(keep);
    for (const [key, m] of _members) if (!keepSet.has(m.kind)) _members.delete(key);
    if (_active !== null && !keepSet.has(_active.kind)) _active = lastMemberOfAny();
}

function lastMemberOfAny(): Member | null {
    let last: Member | null = null;
    for (const m of _members.values()) last = m;
    return last;
}

function kindIds(kind: SelKind): Set<number> {
    const s = new Set<number>();
    for (const m of _members.values()) if (m.kind === kind) s.add(m.id);
    return s;
}

function kindActiveId(kind: SelKind): number | null {
    if (_active !== null && _active.kind === kind) return _active.id;
    // fall back to the last member of this kind in insertion order — the per-kind active
    // (strip keyframes are layered under strip selection, so both kinds can have members
    // simultaneously, each with its own last-selected member)
    let last: number | null = null;
    for (const m of _members.values()) if (m.kind === kind) last = m.id;
    return last;
}

/** the active member's kind, or null when nothing is selected — the routing key for the two
 *  window-keydown handlers (the Blender active-vs-selected split the Locked decision names).
 *  `kindActiveId`'s fallback-to-last-member is what makes the old per-kind accessor guards read
 *  non-null simultaneously under cross-kind co-selection; `activeKind` has no fallback, so only
 *  one handler's guard passes on a mixed selection. */
export function activeKind(): SelKind | null {
    return _active?.kind ?? null;
}

/** whether the selection is a multi-set — two or more members of any kind, cross-kind included.
 *  the set-level multi predicate (editor-ui.md Multi context UI): a per-kind `ids.size > 1`
 *  predicate reads a two-member cross-kind selection as single-select, so the context readers
 *  (manip ring, force-point popover, readout) read this instead. bulk-op applicability readers
 *  (Delete set-lift, Cut single-subject gate, arrow-nudge group move) stay per-kind — the law
 *  governs context, never bulk-op applicability.
 *
 *  the one context reader that does *not* read this yet is the strip-keyframe typed-field popover
 *  (`multiStripKf`, `Timeline.svelte`): a plain click on a strip keyframe keeps the owning strip
 *  (`sweepOtherKinds(["stripKf", "strip"])`), so a size-only count reads that single-subject click
 *  as a multi-set and hides the popover. counting co-selected siblings instead of raw members needs
 *  the per-member ownership read S4 introduces, and that migration is S5.
 *
 *  a plain function, not a `$derived`: `editor` is a plain singleton with no invalidation signal
 *  of its own, so a derived over it only re-runs on `tick` — the `void tick` idiom the existing
 *  derived predicates document. every caller is already inside a `void tick` derived, so the
 *  read is live there.
 *
 *  @example
 *  // hide the viewport ring on a multi-set (App.svelte)
 *  if (multi()) return null;
 */
export function multi(): boolean {
    return _members.size > 1;
}

/** whether any member of any kind is selected — the set's non-empty read, `multi()`'s size-0
 *  sibling. the live-selection layer of a dismissal ladder reads this, never a hand-enumerated
 *  OR over the per-kind views: such an OR is only as complete as the kinds its author listed,
 *  and a kind added later peels a rung the guard never knew about — the pin-mode Escape guard
 *  read node/force/section/START and nothing else, so Escape with only a strip, strip keyframe,
 *  or the track-start one-shot selected read `selected: false` and exited the pin session
 *  instead of yielding the selection rung.
 *
 *  a plain function, not a `$derived`, per `multi()`'s note above: `editor` has no invalidation
 *  signal of its own, so a derived over it only re-runs on `tick` — the `void tick` idiom the
 *  existing derived predicates document. its one caller is the pin-mode rung below, which calls it
 *  at event time, where the read is fresh by construction — the later clear rungs read
 *  `controls.ts`'s `escapeCrossesKinds` instead, being the rung after the yield.
 *
 *  @example
 *  // the pin-mode Escape rung's live-selection layer (App.svelte's modeKeyAct call)
 *  selected: anySelected(),
 */
export function anySelected(): boolean {
    return _members.size > 0;
}

/** a live `Selection` view over the unified set for one kind — `ids` and `active` read the
 *  current state on each access, so a held reference stays current after a write. */
function kindView(kind: SelKind): Selection {
    return {
        get ids(): Set<number> {
            return kindIds(kind);
        },
        get active(): number | null {
            return kindActiveId(kind);
        },
    };
}

/** the singleton id for the two singleton kinds (`start`, `oneShot`). */
const SINGLETON_ID = 0;

interface EditorState {
    /** the selected geo nodes — a derived `Selection` view over the unified member set, filtered
     *  to the `"node"` kind. ids are live eids, resolved fresh each pick and re-resolved by stable
     *  (section, order) across an undo (the eid recycles). */
    nodes: Selection;
    /** the selected force keyframes — a derived view over the unified set, filtered to `"force"`.
     *  addressed by stable `Force.id`. */
    forces: Selection;
    /** the selected sections — a derived view over the unified set, filtered to `"section"`.
     *  addressed by stable `Section.id`. */
    sections: Selection;
    /** the selected velocity strips — a derived view over the unified set, filtered to `"strip"`,
     *  addressed by stable `Strip.id`. */
    strips: Selection;
    /** the selected velocity-strip keyframes — a derived view over the unified set, filtered to
     *  `"stripKf"`, addressed by stable `StripKeyframe.id`, layered under strip selection like
     *  {@link stripKf} always was (`stripKfs.ids` non-empty implies `editor.strip !== null`). */
    stripKfs: Selection;
    /** the active geo node eid, or null — a derived read: the active member's id when its kind
     *  is `"node"`, else null. assigning it is a replace-select (`select`). */
    selection: number | null;
    /** the active force keyframe id, or null — a derived read: the active member's id when its
     *  kind is `"force"`, else null. */
    force: number | null;
    /** the active section id, or null — a derived read: the active member's id when its kind is
     *  `"section"`, else null. */
    section: number | null;
    /** the active velocity strip id, or null — a derived read: the active member's id when its
     *  kind is `"strip"`, else null. */
    strip: number | null;
    /** eid of the node in tangent-edit mode (its handles are summoned), or null — a
     *  sub-mode layered on node selection: `tangentEdit !== null` implies the node set is exactly
     *  `{tangentEdit}` with it active. entered by double-clicking a node (Figma vector edit);
     *  any selection change to a different subject (or the set growing past it), Esc, or click-away
     *  exits it. NOT a fifth mutually-exclusive selection — a refinement of the node-selection state. */
    /** the active velocity-strip keyframe's stable id, or null — a derived read: the active
     *  member's id when its kind is `"stripKf"`, else null. a sub-selection layered on strip
     *  selection: non-empty `stripKfs` implies `editor.strip !== null` (the owning strip is
     *  selected, so its keyframe diamonds are drawn). Clicking a diamond selects it for Delete
     *  (shift-click toggles membership); Escape peels the set before clearing the strip selection
     *  (the force keyframe's own Escape ladder). NOT a mutually-exclusive selection kind.
     *  READ-ONLY, unlike its sibling active views: the replace-select sweep is per-member
     *  containment and needs the owning strip — an ECS read this module deliberately lacks
     *  (selection lives outside the ECS). the clearing path is `selectStripKf(null)`, and the
     *  plain-click number path resolves the owner and calls `selectStripKf(id, "replace", owner)`. */
    readonly stripKf: number | null;
    tangentEdit: number | null;
    /** stable id of the force keyframe in handle-edit sub-mode (its in/out handles are
     *  summoned), or null — the force analogue of `tangentEdit`, layered on force selection:
     *  `forceEdit !== null` implies the force set is exactly `{forceEdit}` with it active. entered by
     *  double-clicking a keyframe (the diamond hit beats insertion); a different selection, Esc, or
     *  click-away exits it. NOT a fifth mutually-exclusive selection. */
    forceEdit: number | null;
    /** which handle of the keyframe in handle-edit sub-mode is selected — `"in"`, `"out"`, or
     *  null when the keyframe itself holds the readout. a refinement layered on `forceEdit`
     *  (`forceHandle !== null` implies `forceEdit === force`): clicking a handle knob selects
     *  it, swapping the contextual readout from the keyframe to the handle's (Δs, Δg) offset;
     *  re-selecting the keyframe (or Esc) clears it back. NOT a mutually-exclusive selection. */
    forceHandle: "in" | "out" | null;
    /** whether the track START anchor is selected — a derived read: true iff the unified set
     *  contains a `"start"` member. there's one START per track; selecting it summons the field
     *  popover for the friction/drag coefficients (`Track.friction`/`.resistance`'s own authoring
     *  surface) — initial speed (v0) moved out (S5, now the track-start one-shot, S3's own point
     *  kind, `oneShot` below). */
    start: boolean;
    /** whether the track-start one-shot (S3, Locked decision — its own structurally distinct
     *  point kind, never a degenerate `Strip`) is selected — a derived read: true iff the unified
     *  set contains an `"oneShot"` member. */
    oneShot: boolean;
    /** the section right-click menu (Convert / Delete): screen position + target
     *  section id, or null when closed. shared so the clip strip and the viewport span both
     *  open the same menu, rendered once at the app root — the graph never opens it at all (the
     *  chart's only right-click subject is a keyframe diamond, `Timeline.svelte forceCtx`,
     *  through the separate `fmenu`). `cut` is the free-position Cut's own resolved landing
     *  point (`track.sectionCutAt`, run once at open time off the click that summoned this menu
     *  — the cursor doesn't move while the menu is open, so there's nothing to re-resolve): a
     *  geo section's segment + parameter, or a force section's native local `s`, or null when
     *  the click didn't resolve one (no live bake, a stale span). `cutSurface` is the
     *  absent-not-grayed surface law (`editor-ui.md` Menus): `true` ONLY from the timeline clip
     *  strip, its sole surface; `false` from the viewport span — `menus.sectionMenu` omits the
     *  Cut row entirely when it's `false`, rather than rendering it grayed, since the canvas has
     *  no honest cursor position for a structural op to land at. */
    context: {
        x: number;
        y: number;
        section: number;
        cut: { at: number; t?: number } | null;
        cutSurface: boolean;
    } | null;
    /** the node context menu (`Handles` toggle + a `Tangents ▸` submenu): screen position +
     *  the target node eid, or null when closed. opened by right-click on any pickable node
     *  (any mode) — the same shared menu language as `context`, rendered once at the app root. */
    nodeMenu: { x: number; y: number; eid: number } | null;
    /** the force keyframe right-click menu (Delete / Easing ▸ / Handles / Reset): screen
     *  position + the target point's stable id, or null when closed. the force analogue of
     *  `nodeMenu`, the same shared menu language. */
    forceMenu: { x: number; y: number; id: number } | null;
    /** the ruler context menu (Meters / Seconds — the track domain picker): screen position,
     *  or null when closed. summoned by right-clicking the ruler scrub zone (the Premiere/
     *  REAPER/Cubase reference: time-display format lives on the ruler's own context menu), the
     *  same shared menu language as `context`/`nodeMenu`/`forceMenu`. No target id — it has one
     *  subject, the timeline itself. A row's pick is a pure view write
     *  (`domain.convertDomain` writes `Track.domain` alone), so no basis state lives here. */
    rulerMenu: { x: number; y: number } | null;
    /** the velocity-strip band context menu (Add / Delete): screen position + the clicked
     *  track-global station `d` (meters of arclength from track start — strips are
     *  track-global, S2 Locked decision, so there is no owning section to carry), or null
     *  when closed. Summoned by right-clicking the band — on empty space for creation (the
     *  row names the thing; the strip appears at the clicked station at minimum extent,
     *  selected, curve flattened and solid), on an existing strip for deletion. Empty band
     *  space is inert — no plain-drag-on-empty, no modifier-drag, no standing mode toggle
     *  (Locked decision, the rescope that retired C5's create-drag). `strip` is the targeted
     *  strip's stable id, -1 when the right-click landed on empty band (creation of a strip
     *  or — S3's own row, when none exists — the one-shot), or -2 when the right-click
     *  landed on the track-start one-shot's own glyph (its Delete row, `menus.stripMenu`'s
     *  own `-2` branch — a sentinel, not a `Strip.id`, since the one-shot is never a strip
     *  row, S3 Locked decision). */
    stripMenu: { x: number; y: number; d: number; strip: number } | null;
    /** the snapping magnet toggle (AE model): a persistent editor preference, default
     *  on, `S` toggles it, and holding Ctrl/Cmd momentarily inverts it (`snapActive`).
     *  ephemeral like the rest of `editor` — a view preference, not authored track state. */
    snap: boolean;
    /** whether a pointer drag is in flight (any gesture routed through `beginDrag`). App
     *  projects it as `data-dragging` on the app root; a CSS rule then suppresses `:hover`
     *  on the chrome under the cursor. ephemeral, read via the per-RAF tick. */
    dragging: boolean;
    /** the stable id of the viewport section span under the pointer, or null — the ephemeral
     *  hover read the render overlay draws one kind-color rung up (`hovered`, colors.ts), the
     *  canvas twin of the clip strip's hover fill. written per pointermove by the controls'
     *  `pickSection`, cleared on pointer leave and for the whole of any gesture (`beginDrag`).
     *  viewport-local by design: hovering a clip does not light the span, and vice versa. */
    hoverSection: number | null;
    /** the eid of the pickable geo node under the pointer, or null — the node-level hover read
     *  (kex2d-optimize-mode stage 6: hover must match what's clickable, and a node picks before
     *  its section). written per pointermove by the controls' `pickNode`, mutually exclusive
     *  with `hoverSection` (the pointer is over exactly one pick target), cleared on pointer
     *  leave and for the whole of any gesture (`beginDrag`) like its section twin. */
    hoverNode: number | null;
    /** the stable id of the viewport force marker under the pointer, or null — the force twin of
     *  `hoverNode` (kex2d-idioms stage 3: force keyframes display + select on the track). written
     *  per pointermove by the controls' pick sweep, mutually exclusive with `hoverNode`/
     *  `hoverSection` (exactly one pick target under the pointer), cleared on pointer leave and
     *  for the whole of any gesture (`beginDrag`). viewport-local like its siblings. */
    hoverForce: number | null;
    /** the tangent-edited node's handle under the pointer, or null — the knob twin of
     *  `hoverNode`/`hoverForce`/`hoverSection` (kex2d-burndown stage 3: knobs were the one
     *  pickable glyph class with no hover). written first in the controls' pointermove sweep,
     *  through `pickTangentHandle`, so it wins on the same priority a click takes (a handle over
     *  its node still grabs) — mutually exclusive with the other three. `side` distinguishes a
     *  node's two knobs (in/out), matching `dragTangent`'s shape. cleared on pointer leave and
     *  for the whole of any gesture (`beginDrag`) like its siblings. */
    hoverKnob: { eid: number; side: TangentSide } | null;
    /** which surface the pointer is over — routes the surface-scoped keys (`F` frames it,
     *  arrows act on it), ending the viewport-nudge vs timeline-playhead double-fire.
     *  defaults to the viewport, so keys route there before the pointer visits the dock;
     *  the dock's enter/leave is the only thing that flips it (the rest is the viewport). */
    hover: Surface;
    /** the geo→force solve in flight, or null — the MODAL GATE. while it's set the progress
     *  surface is up and every other editor input is blocked (App's capture-phase swallow + the
     *  scrim), because the solve's answer is only valid against the shape it was handed. */
    converting: Converting | null;
    /** the transient readout of the last solve, or null — the completion outcome or the failure,
     *  auto-dismissed. it lives here and nowhere else: nothing of a solve past points / length /
     *  realized `ds` is ever stored on the document. */
    notice: Notice | null;
    /** the pin-mode session in flight on a force section, or null — the mode-scoped stamp +
     *  entry-frame ghost (`kex2d-optimize-mode` stage 1: `optimize.ts`'s masked solve). Entering
     *  the mode stamps the section's CURRENT exit as the pin and freezes a ghost of the CURRENT
     *  shape; both live and die with this field — there is no persistent pin. A refused solve
     *  never clears it (refusal stays in-mode); only `endPin` does — Exit/Esc, or the
     *  landed Solve that closes the mode. */
    pinning: PinSession | null;
    /** locked force-keyframe ids for the live pin session — mode-scoped: locks persist
     *  across solves while the mode is open and are discarded on `endPin` (exit or the
     *  landed Solve that closes the mode). All keys are free by default (the locked decision's
     *  "all-free, locking is the gesture" law) — an in-mode-added key is free by construction,
     *  since locking is opt-in membership here. Meaningless outside a session, but not reset
     *  automatically on entry ordering — `beginPin` clears it explicitly. */
    locked: Set<number>;
    /** whether an invoked pin solve is running — the mode's OWN blocking gate, separate from
     *  `converting` (a geo↔force kind conversion): the two invoked tools never overlap in scope
     *  (a converting section can't be mid-pin, since entering pin mode requires an
     *  already-force, already-baked section) but share nothing else, so a shared boolean would
     *  couple two independent modal surfaces. */
    pinSolving: boolean;
    /** the live paced-landing display, or null — see {@link Landing}. cosmetic only. */
    landing: Landing | null;
}

/** the mode-entry stamp + ghost the optimize kernel (`optimize.ts`) and its editor command
 *  (`pin.ts`) read/write against — structural, so this module never imports either (the
 *  `SolveOutcome`/`Converting` precedent). `stamp` is the pin (frozen at mode entry — it lives and
 *  dies with the session, the mode-scoped-stamp law); `ghost` is the mode-entry shape's dense
 *  positions, for the whole-shape ghost overlay — also frozen, never re-derived.
 *
 *  **Everything else about the section is read live, every solve.** There is no cached entry
 *  frame/length/ds/domain here: `pin.runPinSection` re-reads the section's CURRENT
 *  baking parameters at each invoke (`sectionSpec`) — the invoked-command convention, so the
 *  solve always targets exactly what's on screen. The entry frame is STABLE in-mode by the
 *  editing lockdown (only the pinning section is editable — no upstream edits, no v0), so the
 *  live re-read and the stamp describe the same entry for the mode's whole life; the re-read is
 *  convention, not drift-handling. */
export interface PinSession {
    section: number;
    stamp: { x: number; y: number; theta: number; v: number };
    ghost: { x: Float32Array; y: Float32Array };
    /** the section's full recovered exit at mode entry — the downstream freeze's chain seed
     *  (`track.setBakeFreeze`): while the mode is open, sections after this one bake from HERE,
     *  not the live exit (stage 7 — downstream holds its mode-entry placement; the boundary gap
     *  is the residual made visible). frozen with the stamp, so a reopened session (undo of the
     *  landed Solve) freezes identically. */
    freeze: { x: number; y: number; theta: number; v: number };
}

/** a solve in flight: the façade's own progress, rewritten per report. */
export interface Converting {
    /** the refinement's phase, verbatim from the façade (`"open"` | `"split"` | `"prune"`). a
     *  plain string so the conversion tier stays off this module's graph. */
    phase: string;
    /** keys in the probe just answered. */
    keys: number;
    /** probes finished so far. There is deliberately no total — the refinement discovers how many
     *  it needs as it goes. */
    probes: number;
}

/** a transient outcome (root ui.md): the solve's completion readout, or the error surface for a
 *  diverged / failed / expired one. Text, because it is display and nothing else. */
export interface Notice {
    kind: "done" | "error";
    text: string;
}

/** the paced landing (kex2d-optimize-mode stage 5, display-wide since kex2d-idioms stage 4): a
 *  landed Solve's keyframes animate continuously from their pre-solve to their solved `g` over
 *  {@link LANDING_MS} so the solve reads as a process. COSMETIC ONLY — the document landed
 *  atomically before this state exists; it offsets where the timeline DRAWS the moved diamonds
 *  AND, through the bake seam (`track.setBakeLanding`), what the whole display bakes while it
 *  runs — curve, viewport geometry, markers, cart, with the downstream freeze held through the
 *  window. Esc or any pointerdown skips to the end state (`skipLanding`); expiry is equivalent
 *  to skipping. It is also the mode's EXIT TRANSITION (kex2d-idioms stage 8): while it runs
 *  the modal presentation holds — {@link modeChromeSection}. */
export interface Landing {
    /** `performance.now()` at the landing. */
    start: number;
    /** the landed session's section — the modal chrome's subject through the window
     *  ({@link modeChromeSection}): the dim's scope and the subject hatch key here once the
     *  mode itself has closed. */
    section: number;
    /** the moved keys only: each id's pre-solve and solved g. */
    moves: readonly { id: number; from: number; to: number }[];
}

/** the paced landing's duration (ms) — deliberate pacing, not latency (the solve itself is
 *  milliseconds; this is the feedback). */
export const LANDING_MS = 500;

/** open the paced landing display. a solve that moved nothing shows nothing. `hold` is the
 *  landed session's section + frozen entry (`PinSession.freeze`): the display bake keeps
 *  downstream seeded there for the window, so the freeze the mode close released doesn't snap
 *  — it eases shut as the interpolated exit converges to the stamp. */
export function beginLanding(
    moves: readonly { id: number; from: number; to: number }[],
    hold: { section: number; entry: { x: number; y: number; theta: number; v: number } },
): void {
    if (moves.length === 0) {
        // clear BOTH halves: a prior override left live under a null `editor.landing` would be
        // unreleasable (every skip listener guards on the landing) and bake every frame forever.
        editor.landing = null;
        setBakeLanding(null);
        return;
    }
    const landing: Landing = { start: performance.now(), section: hold.section, moves };
    editor.landing = landing;
    setBakeLanding({
        section: hold.section,
        entry: hold.entry,
        g: (id) => landingG(landing, id, performance.now()),
    });
}

/** skip (or expire) the landing: the display snaps to the document's own values — the chart's
 *  diamond override and the bake-seam override clear together (one skip, whole display). */
export function skipLanding(): void {
    editor.landing = null;
    setBakeLanding(null);
}

/** the modal chrome's subject section, or null when no modal presentation holds (kex2d-idioms
 *  stage 8): the live pin session's, else the paced landing's — the landing is the mode's
 *  exit transition, so the panel, the dim wash, and the subject hatch hold through the window
 *  and release in ONE moment (expiry or skip). CHROME ONLY, never a second mode state:
 *  enablement and consent predicates (`sectionOpsAllowed`, `sectionEditable`, the lockdowns)
 *  keep reading `editor.pinning` — document truth — and an in-window edit stays
 *  possible-but-skip (every entry gesture routes through `skipLanding` first). */
export function modeChromeSection(): number | null {
    return editor.pinning?.section ?? editor.landing?.section ?? null;
}

/** the one shared easing curve (`editor-ui.md` Mode vocabulary: Motion) — cubic ease-out,
 *  `1 − (1 − t)³`. The CSS twin is App.svelte's `--ease-out` token, the exact bezier of this
 *  polynomial (`cubic-bezier(0.33333, 1, 0.66667, 1)`); pinned equal in colors.test.ts, so
 *  the two halves can't drift into two dialects of one motion. */
export function easeOut(t: number): number {
    return 1 - (1 - t) ** 3;
}

/** the displayed g for a keyframe under the live landing, or null when the landing doesn't
 *  cover it (or has expired) — the one cosmetic display override. the shared ease-out, so the
 *  motion decelerates into the solved value. */
export function landingG(landing: Landing, id: number, now: number): number | null {
    const t = (now - landing.start) / LANDING_MS;
    if (t >= 1) return null;
    const m = landing.moves.find((mv) => mv.id === id);
    if (!m) return null;
    const k = t <= 0 ? 0 : easeOut(t);
    return m.from + (m.to - m.from) * k;
}

export const editor: EditorState = {
    get nodes(): Selection {
        return kindView("node");
    },
    get forces(): Selection {
        return kindView("force");
    },
    get sections(): Selection {
        return kindView("section");
    },
    get strips(): Selection {
        return kindView("strip");
    },
    get stripKfs(): Selection {
        return kindView("stripKf");
    },
    get selection(): number | null {
        return kindActiveId("node");
    },
    set selection(v: number | null) {
        select(v);
    },
    get force(): number | null {
        return kindActiveId("force");
    },
    set force(v: number | null) {
        selectForce(v);
    },
    get section(): number | null {
        return kindActiveId("section");
    },
    set section(v: number | null) {
        selectSection(v);
    },
    get strip(): number | null {
        return kindActiveId("strip");
    },
    set strip(v: number | null) {
        selectStrip(v);
    },
    get stripKf(): number | null {
        return kindActiveId("stripKf");
    },
    tangentEdit: null,
    forceEdit: null,
    forceHandle: null,
    get start(): boolean {
        return memberHas("start", SINGLETON_ID);
    },
    get oneShot(): boolean {
        return memberHas("oneShot", SINGLETON_ID);
    },
    context: null,
    nodeMenu: null,
    forceMenu: null,
    rulerMenu: null,
    stripMenu: null,
    snap: true,
    dragging: false,
    hoverSection: null,
    hoverNode: null,
    hoverForce: null,
    hoverKnob: null,
    hover: "viewport",
    converting: null,
    notice: null,
    pinning: null,
    locked: new Set(),
    pinSolving: false,
    landing: null,
};

/** the four hover fields as one named shape — `controls.pickHover`'s return type, annotated
 *  explicitly at that one call site rather than left as an inferred object literal, so excess
 *  properties are checked at BOTH ends: a `pickHover` that grows a fifth hover read is a compile
 *  error here, not a silently-dropped field caught only by code review (`kex2d-followups` finding
 *  2 — the three-of-four bug class `writeHover` exists to close, reopened by a non-literal
 *  parameter turning excess-property checking off). Exported so `controls.ts` can annotate against
 *  it without importing `EditorState`; the dependency stays one-way (`controls.ts` already imports
 *  from `./editor`, never the reverse). */
export type Hover = {
    knob: EditorState["hoverKnob"];
    node: EditorState["hoverNode"];
    force: EditorState["hoverForce"];
    section: EditorState["hoverSection"];
};

/** write a pointer-hover reading to `editor` through ONE seam — the four hover fields (`hoverKnob`
 *  /`hoverNode`/`hoverForce`/`hoverSection`, above) land together, so a caller can't write three of
 *  them and miss the fourth. `clearHover`'s null form is the same seam every clear site shares
 *  (pointer leave, remount teardown, `beginDrag`'s whole-gesture suppression, below) — a site now
 *  CALLS the shared clear instead of restating four literal assignments, which is what makes a
 *  dropped field impossible rather than merely unlikely (the kex2d-idioms 10b bug class this
 *  closes). Typed on {@link Hover}, this module's own shape (not `ReturnType<typeof pickHover>` —
 *  that reference would pull the dependency the wrong way): `controls.ts` annotates `pickHover`'s
 *  return as `Hover` explicitly, which is what makes a fifth field a compile error at both ends. */
export function writeHover(hover: Hover): void {
    editor.hoverKnob = hover.knob;
    editor.hoverNode = hover.node;
    editor.hoverForce = hover.force;
    editor.hoverSection = hover.section;
}

/** clear all four hover reads — `writeHover`'s null form. */
export function clearHover(): void {
    editor.hoverKnob = null;
    editor.hoverNode = null;
    editor.hoverForce = null;
    editor.hoverSection = null;
}

// ── pin mode (kex2d-optimize-mode stage 7: the sandbox) ──────────────────────
// mode-scoped: entering stamps the exit, freezes a ghost + the downstream chain, and opens the
// SANDBOX — a second History every in-mode recording lands in (`history.redirectHistory`), so the
// pin state is temporary and the outer stacks are untouched until a Solve lands. locking is
// a set of force-keyframe ids, all-free by default (the locked decision's consent-boundary law).
// `beginPin`/`endPin` are the ONLY open/close choke points — every path (fresh entry,
// Exit/Esc, the landed Solve, undo/redo of the landing) goes through them, so the sandbox, the
// redirect, and the downstream freeze can never leak past the mode.

let sandboxH: History | null = null;

/** the live sandbox history, or null when no mode is open — in-mode undo/redo operate on THIS
 *  stack only (`pin.undoRouted`/`redoRouted`); the outer stacks are unreachable from
 *  inside (the sandbox contract). */
export function sandbox(): History | null {
    return sandboxH;
}

/** swap the live sandbox's stacks for captured ones — the landed Solve's undo path: the outer
 *  entry carries the sandbox frozen at solve time, and undoing it reopens the mode with the
 *  experiment resumed (edits present, in-mode undo/redo intact). copies both ways, so repeated
 *  undo/redo cycles can't mutate the entry's frozen arrays. a no-op with no mode open. */
export function restoreSandbox(undoE: History["undo"], redoE: History["redo"]): void {
    if (sandboxH === null) return;
    sandboxH.undo = [...undoE];
    sandboxH.redo = [...redoE];
}

/** enter pin mode on a force section: stamp its current exit, freeze the mode-entry ghost,
 *  open a fresh sandbox (all in-mode recordings land there — nothing applies to the outer
 *  history until Solve), freeze the downstream chain at the session's recovered exit, and clear
 *  any stale lock set from a prior session. */
export function beginPin(session: PinSession): void {
    // a session never opens over a live landing override (exitPinMode's symmetric skip):
    // the new session's freeze and a stale hold would fight over the two-part chain.
    skipLanding();
    editor.pinning = session;
    editor.locked = new Set();
    editor.notice = null;
    sandboxH = createHistory();
    redirectHistory(sandboxH);
    setBakeFreeze({ section: session.section, entry: session.freeze });
}

/** close pin mode: drop the stamp, the ghost, every lock, the sandbox, and the downstream
 *  freeze (the next bake repropagates downstream from the live exit). the document-level close
 *  semantics live with the callers (`pin.ts`): Exit reverts the sandbox first; the
 *  landed Solve captures it into the outer entry. */
export function endPin(): void {
    editor.pinning = null;
    editor.locked.clear();
    editor.pinSolving = false;
    sandboxH = null;
    redirectHistory(null);
    setBakeFreeze(null);
}

/** toggle a single force keyframe's lock — the basic lock/free gesture. a no-op outside a live
 *  session (nothing to lock against). */
export function toggleLocked(id: number): void {
    if (editor.pinning === null) return;
    if (editor.locked.has(id)) editor.locked.delete(id);
    else editor.locked.add(id);
}

/** the keyframe context menu's Lock/Unlock row, or null when the row does not EXIST (kex2d
 *  stage 6): lock is mode-scoped state — outside an pin session (or on a section other than
 *  the pinning one) there is nothing to lock, so the row is OMITTED, not grayed (menus law:
 *  gray a blocked action, omit one the subject rules out — contrast the in-mode Convert rows,
 *  which gray because convert exists and is temporarily barred). the label mirrors the `Q`
 *  hotkey's toggle semantics (`toggleLockedSet`): an all-locked selection offers Unlock,
 *  anything else Lock.
 *
 * @example
 * const label = lockLabel(editor.pinning, pt.section, memberIds, editor.locked);
 * if (label) items.unshift({ label, action: () => toggleLockedSet(memberIds) });
 */
export function lockLabel(
    pinning: PinSession | null,
    section: number,
    ids: readonly number[],
    locked: ReadonlySet<number>,
): "Lock" | "Unlock" | null {
    if (pinning === null || pinning.section !== section || ids.length === 0) return null;
    return ids.every((id) => locked.has(id)) ? "Unlock" : "Lock";
}

/** toggle a SET of force keyframes' lock as one gesture (the multiselect bulk form, mirroring the
 *  bulk force ops elsewhere): if every member is already locked, unlock them all; otherwise lock
 *  every member (the "select some free keys among locked ones" case locks the rest, matching the
 *  bulk-toggle convention the easing/tangent-mode rows already use — act on the whole set, not
 *  per-member). a no-op outside a live session. */
export function toggleLockedSet(ids: readonly number[]): void {
    if (editor.pinning === null || ids.length === 0) return;
    const allLocked = ids.every((id) => editor.locked.has(id));
    for (const id of ids) {
        if (allLocked) editor.locked.delete(id);
        else editor.locked.add(id);
    }
}

/** open the pin solve's own blocking gate — a solve is in flight, no other editor input. */
export function beginPinSolve(): void {
    editor.pinSolving = true;
}

/** close the pin solve's blocking gate — resolution, cancel, or failure alike. */
export function endPinSolve(): void {
    editor.pinSolving = false;
}

// ── the invoked-solve gate ────────────────────────────────────────────────────────
// one geo→force solve at a time, modal for its whole duration (`geoforce.ts`: the answer
// describes the shape the solve was handed, so the document must not move under it). the gate is
// pure state — the AbortController and the await live with the surface that opened it.

/** open the gate: the modal mounts, all other input is blocked, and the previous solve's readout
 *  clears. The subject isn't held here — one solve runs at a time and the surface that opened it
 *  owns the section id, so a copy would only be a second truth to keep in sync. */
export function beginConvert(): void {
    editor.converting = { phase: "open", keys: 0, probes: 0 };
    editor.notice = null;
}

/** fold a façade progress report into the live gate. A report landing after the gate closed — a
 *  cancelled solve's in-flight probe — is dropped, or it would raise the modal back over an editor
 *  that is no longer converting. */
export function convertProgress(p: { phase: string; keys: number; probes: number }): void {
    const c = editor.converting;
    if (c === null) return;
    c.phase = p.phase;
    c.keys = p.keys;
    c.probes = p.probes;
}

/** close the gate — resolution, cancel, or failure alike. Input is live again. */
export function endConvert(): void {
    editor.converting = null;
}

/** raise the transient readout (the completion outcome, or a failure). */
export function notify(kind: "done" | "error", text: string): void {
    editor.notice = { kind, text };
}

/** clear the transient readout (its auto-dismiss, or a new solve starting). */
export function dismissNotice(): void {
    editor.notice = null;
}

// ── what a finished solve says ────────────────────────────────────────────────────
// the two pure mappings from a solve's exit onto the readout, kept out of the component so every
// branch is unit-testable (`tests/editor.test.ts`) — the same move as `controls.sectionSolvable`.
// They are the ONLY place a solve's outcome becomes words: nothing of a `ConvertResult` past
// points / length / realized `ds` is ever stored, so this text is where it ends.

/** what the readout needs off a solve's answer — structural, so the conversion tier stays off this
 *  module's graph (the `SolvedForce` precedent, `track.ts`). */
export interface SolveOutcome {
    /** `"floor"` | `"budget"` | `"diverged"` (`refine.ts`'s `RefineOutcome`). */
    outcome: string;
    keys: number;
    deviation: number;
    floor: number;
}

/** metres for the readout. */
const metres = (v: number): string => `${v.toFixed(2)} m`;

/** an achieved-vs-allowed miss, the constraint-solver readout (`editor-ui.md`) — printed only
 *  where a budget was NOT held, which is the one case the numbers tell the author something. */
const missed = (achieved: string, budget: string): string => `${achieved} off (${budget} allowed)`;

/** the readout for a convert that RESOLVED. A convert that held its budget says so and stops —
 *  anything past the confirmation is noise. `"budget"` landed too (the
 *  sanctioned narrow-feature outcome), but it missed, so it reports the miss. `"diverged"`
 *  resolved as well and landed NOTHING (the refinement hit an unreadable probe), so it reads as
 *  a failure. */
export function solveDone(r: SolveOutcome): Notice {
    if (r.outcome === "diverged")
        return { kind: "error", text: "The solve could not fit this shape. Nothing changed." };
    // no key count (stage-7 feel: the count told the author nothing — the curve is on screen).
    const text = "Converted to force";
    if (r.outcome !== "budget") return { kind: "done", text };
    return { kind: "done", text: `${text} · ${missed(metres(r.deviation), metres(r.floor))}` };
}

/** what the readout needs off a force→geo fit's answer (`forcegeo.convertForce`) — the
 *  observation-space twin of `SolveOutcome`. dual budget: the fit holds BOTH a geometric
 *  deviation (m) and a recovered-force error (g) to their own bound (`geofit.ts`'s locked
 *  criterion), so the readout reports both, unlike the single-axis geo→force floor. structural,
 *  like `SolveOutcome` — `geofit.GeofitResult` satisfies it, but this module never imports the
 *  conversion tier for one check. */
export interface FitOutcome {
    /** `"floor"` | `"budget"` | `"diverged"` (`geofit.GeofitOutcome`) | `"dense"`
     *  (`forcegeo.ConvertForceOutcome`'s own addition — a `"budget"` answer too big to author). */
    outcome: string;
    nodes: number;
    deviation: number;
    forceError: number;
    geoBudget: number;
    forceBudget: number;
}

const gforce = (v: number): string => `${v.toFixed(2)} g`;

/** the readout for a fit that RESOLVED — `solveDone`'s force→geo twin, same three-way branch and
 *  the same standard: a held fit is a short confirmation, a `"budget"` fit names its miss. Dual
 *  budget, so only the axis (or axes) that actually missed is printed — the held one has nothing
 *  to say. `"dense"` reads like `"diverged"` (nothing landed) rather than like `"budget"` (which
 *  DID land) — a node count over the authoring ceiling is its own failure, not a miss to report
 *  against a budget that was in fact held. */
export function fitDone(r: FitOutcome): Notice {
    if (r.outcome === "diverged")
        return { kind: "error", text: "The solve could not fit this shape. Nothing changed." };
    if (r.outcome === "dense")
        return {
            kind: "error",
            text: `The fit needs ${r.nodes} nodes — too many to author. Nothing changed.`,
        };
    // node count dropped with the force twin's key count (stage 7 — one convention).
    const text = "Converted to geo";
    if (r.outcome !== "budget") return { kind: "done", text };
    const misses: string[] = [];
    if (r.deviation > r.geoBudget) misses.push(missed(metres(r.deviation), metres(r.geoBudget)));
    if (r.forceError > r.forceBudget)
        misses.push(missed(gforce(r.forceError), gforce(r.forceBudget)));
    // defensive: `geofit` only reports `budget` with at least one finite axis over its bound, so
    // this is reachable only on a NaN reading — report both readings, there's no miss to point at.
    if (misses.length === 0)
        misses.push(
            missed(metres(r.deviation), metres(r.geoBudget)),
            missed(gforce(r.forceError), gforce(r.forceBudget)),
        );
    return { kind: "done", text: `${text} · ${misses.join(" · ")}` };
}

/** the readout for a solve that REFUSED — raised on the shared transient notice (the app's one
 *  status surface, stage-7 fourth check-in: the panel keeps only Solve/Exit + the starved
 *  reason). one TERSE sentence per refusal class — no "Nothing changed" padding, the sandbox
 *  guarantees it — with the taxonomy's two labels (unreachable variants vs did-not-converge)
 *  kept distinguishable. `reason` is the certifying check on an `"unreachable"` answer. typed on
 *  the kernel's own exported unions — a TYPE-ONLY import is erased at compile, so the solver
 *  tier still never joins this module's runtime graph (the structural-read rule guards the
 *  graph, not the types). there is deliberately no landed-solve readout: the paced landing
 *  animation is the feedback. */
export function pinRefused(outcome: OptimizeOutcome, reason?: UnreachableReason): string {
    if (outcome === "unreachable") {
        if (reason === "stall") return "The draft stalls before the exit.";
        if (reason === "conditioning") return "The free keys can't steer the exit.";
        return "Fewer than 3 free keys.";
    }
    return "Failed to converge.";
}

/** the readout for a solve that REJECTED, plus the raw detail for the console.
 *
 * One plain sentence per class, never the thrown message: those name sections by id and functions
 * by name (`convertGeo: section 3 has no live bake`), which tells an author nothing and leaks
 * internals into the UI. The detail goes to `console.error` instead, where it's for us.
 * A cancel says nothing at all — the author asked for it, and nothing was written to undo. */
export function solveFailed(
    e: unknown,
    cancelled: boolean,
): { notice: Notice | null; detail: string | null } {
    const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
    if (cancelled) return { notice: null, detail: null };
    // `StaleConvert` by NAME, not `instanceof`: importing the class would pull the conversion tier
    // (and its worker) onto this module's graph for one check. `geoforce.ts` sets `name` in its
    // constructor, and `tests/editor.test.ts` pins this against the real class.
    if (e instanceof Error && e.name === "StaleConvert")
        return {
            notice: {
                kind: "error",
                text: "The track changed while the solve ran. Nothing changed.",
            },
            detail,
        };
    return {
        notice: { kind: "error", text: "The solve could not finish. Nothing changed." },
        detail,
    };
}

// ── drag gesture substrate ──
// every pointer drag routes through `beginDrag`. it (1) takes pointer capture — for event
// routing and, more importantly, so hit-testing bypasses the dragged surface, which the
// hover-suppression CSS below marks `pointer-events: none`; and (2) sets `editor.dragging`,
// which App reflects as `data-dragging` on the app root. that attribute drives one CSS rule
// (`pointer-events: none` on the hoverable chrome), the ONLY thing that stops `:hover`
// firing on chrome under the cursor mid-drag — CSS `:hover` ignores pointer capture in both
// Chromium and Firefox, so capture alone can't fix it.
//
// `beginDrag`'s own listeners are the SOLE release authority: they clear the flag + capture
// on `pointerup`/`pointercancel`, keyed on the captured pointerId so a superseded drag's
// late release can't clear a newer one (a new `beginDrag` supersedes a stale one). they
// listen on `window`, not the captured element, so a missed or failed capture still catches
// the release (window sees every pointer event). the per-gesture handlers do NOT clear the
// flag; only the unmount teardowns call `endDrag()` directly, for a drag torn down without a
// release event.
let dragEl: Element | null = null;
let dragId = -1;

/** open a drag gesture on `el` for `pointerId`: take pointer capture and raise the drag
 *  flag; both clear on the pointer's `pointerup`/`pointercancel`. re-entrant safe. */
export function beginDrag(el: Element, pointerId: number): void {
    if (dragEl) endDrag(); // a prior drag whose release was missed — clear before claiming
    dragEl = el;
    dragId = pointerId;
    editor.dragging = true;
    // the canvas hover has no `:hover` for the CSS rule below to kill, so the same suppression is
    // an explicit clear here (through the one hover seam, `clearHover`, above): nothing lights up
    // under a live gesture, whichever surface owns it.
    clearHover();
    try {
        el.setPointerCapture(pointerId);
    } catch {
        // capture is best-effort (a detached element throws); the window listeners below
        // still catch the release and the flag still drives suppression
    }
    window.addEventListener("pointerup", onDragRelease);
    window.addEventListener("pointercancel", onDragRelease);
    el.addEventListener("lostpointercapture", onDragRelease);
}

function onDragRelease(e: Event): void {
    // ignore a stale listener firing for a pointer that isn't the active drag's
    if (e instanceof PointerEvent && e.pointerId !== dragId) return;
    endDrag();
}

/** clear the drag flag + release capture (idempotent). driven by `beginDrag`'s own release
 *  listeners; also called directly by the unmount teardowns for a drag with no release. */
export function endDrag(): void {
    if (!dragEl) return;
    const el = dragEl;
    const id = dragId;
    dragEl = null;
    dragId = -1;
    editor.dragging = false;
    window.removeEventListener("pointerup", onDragRelease);
    window.removeEventListener("pointercancel", onDragRelease);
    el.removeEventListener("lostpointercapture", onDragRelease);
    try {
        if (el.hasPointerCapture(id)) el.releasePointerCapture(id);
    } catch {
        // already released / detached
    }
}

/** flip the snapping magnet (the `S` key). */
export function toggleSnap(): void {
    editor.snap = !editor.snap;
}

/** whether snapping is active for a gesture, given whether the Ctrl/Cmd bypass modifier
 *  is held: the persistent toggle XOR the momentary modifier (the AE magnet — hold to
 *  invert, so a bypass turns it off while on and summons it while off). */
export const snapActive = (mod: boolean): boolean => editor.snap !== mod;

// a plain click replace-selects: clearing every member of every kind, then setting the one.
// shift/marquee toggle within one kind after sweeping the others. the `exclusive*` family is
// deleted — its observable (selecting into one kind clears the others) is preserved by
// replace-select clearing all members and toggle-select sweeping other kinds through the
// unified set. the edit sub-modes stay single-subject — entering one collapses its kind to
// that one member (`enter*Edit` route through the replace form).

/** the two selection forms: "replace" (collapse the kind to one member — today's behavior) and
 *  "toggle" (shift-click add/remove membership). */
export type SelectMode = "replace" | "toggle";

/** replace-select a single member of `kind`, clearing every member of every kind first. */
function selectSingle(kind: SelKind, id: number | null): void {
    if (id !== null) {
        clearAllMembers();
        memberAdd(kind, id);
        _active = { kind, id };
    } else {
        clearKind(kind);
    }
}

/** toggle-select a member of `kind` — shift-click extends across kinds (S2): the other kinds
 *  are NOT swept, so force and strip keyframes can be co-selected as members of one set. */
function toggleSingle(kind: SelKind, id: number): void {
    if (memberHas(kind, id)) {
        memberRemove(kind, id);
        if (_active !== null && _active.kind === kind && _active.id === id)
            _active = lastMemberOfAny();
    } else {
        memberAdd(kind, id);
        _active = { kind, id };
    }
}

/** replace a kind's membership with a computed set (the marquee's atomic write). a non-empty set
 *  clears only its own kind and writes the set — the marquee extends across kinds (S2), so other
 *  kinds are NOT swept. an empty set clears only that kind, leaving the rest for the caller to
 *  sweep (matching empty-click). */
function selectSet(kind: SelKind, ids: number[], activeId: number | null): void {
    if (ids.length) {
        clearKind(kind);
        for (const id of ids) memberAdd(kind, id);
        if (activeId !== null && memberHas(kind, activeId)) _active = { kind, id: activeId };
        else _active = lastMemberOfAny();
    } else {
        clearKind(kind);
    }
}

/** promote an already-selected member to active without disturbing set membership. */
function activateMember(kind: SelKind, id: number): void {
    if (memberHas(kind, id)) _active = { kind, id };
}

/** clear every member and every sub-mode at once — the empty-ruler / empty-lane deselect
 *  (`kex2d-event-lane` S4, "one selection model": clicking empty space with no object under the
 *  pointer clears segments, spans, keyframes, and nodes together). */
export function deselectAll(): void {
    clearAllMembers();
    editor.tangentEdit = null;
    editor.forceEdit = null;
    editor.forceHandle = null;
}

/** drop tangent edit unless the node selection is exactly its subject (a set that grew past one, or
 *  whose active moved off it, leaves the single-subject sub-mode). */
function reconcileTangent(): void {
    if (
        editor.tangentEdit !== null &&
        (kindIds("node").size !== 1 || kindActiveId("node") !== editor.tangentEdit)
    )
        editor.tangentEdit = null;
}

/** drop force handle-edit unless the force selection is exactly its subject. */
function reconcileForceEdit(): void {
    if (
        editor.forceEdit !== null &&
        (kindIds("force").size !== 1 || kindActiveId("force") !== editor.forceEdit)
    )
        editor.forceEdit = null;
}

/** select a geo node. "replace" (default) collapses the node set to `eid` (or clears it when null) —
 *  today's behavior; "toggle" adds/removes `eid` (shift-click). either non-clearing form sweeps the
 *  other kinds. a select to a different subject exits tangent edit; re-selecting the edited node (as
 *  the sole member) keeps it, so grabbing its own handle or nudging it doesn't drop the mode. */
export function select(eid: number | null, mode: SelectMode = "replace"): void {
    if (eid === null || mode === "replace") selectSingle("node", eid);
    else toggleSingle("node", eid);
    reconcileTangent();
}

/** replace the node selection with a computed set (the marquee's atomic write): members `ids`,
 *  `active` active, the other kinds swept when non-empty. the set-valued analog of `select` — one
 *  write of a whole merged hit set, same exclusivity + reconcile. an empty set clears the node kind
 *  only (the caller sweeps the rest for a full deselect, matching empty-click). */
export function selectNodes(ids: number[], active: number | null): void {
    selectSet("node", ids, active);
    reconcileTangent();
}

/** replace the force selection with a computed set (the marquee's atomic write) — the force
 *  analog of `selectNodes`. */
export function selectForces(ids: number[], active: number | null): void {
    selectSet("force", ids, active);
    editor.forceHandle = null;
    reconcileForceEdit();
}

/** enter tangent-edit mode on a node — the summon (double-click). collapses the node selection to
 *  this one subject (clearing the other kinds) and layers the edit sub-mode on it, so its handles
 *  render and grab. node 0 (the entry anchor) is editable too — it exposes its single out-handle
 *  (the entry handle), reached at the START diamond or, at a geo→geo boundary, stitched onto its
 *  coincident upstream tip. */
export function enterTangentEdit(eid: number): void {
    select(eid);
    editor.tangentEdit = eid;
}

/** exit tangent-edit mode, keeping the node selected (Esc's first peel). */
export function exitTangentEdit(): void {
    editor.tangentEdit = null;
}

/** select a force keyframe by stable id. "replace" (default) collapses the force set to `id` (or
 *  clears it when null); "toggle" adds/removes it (shift-click). either non-clearing form sweeps the
 *  other kinds and resets the handle sub-selection (the keyframe itself holds the readout). a select
 *  to a different subject exits handle edit; re-selecting the edited point (sole member) keeps it. */
export function selectForce(id: number | null, mode: SelectMode = "replace"): void {
    if (id === null || mode === "replace") selectSingle("force", id);
    else toggleSingle("force", id);
    editor.forceHandle = null;
    reconcileForceEdit();
}

/** enter handle-edit mode on a force keyframe — the summon (double-click). collapses the force
 *  selection to this one subject (clearing the other kinds) and layers the edit sub-mode on it, so
 *  its in/out handles render and grab. mirrors geo's `enterTangentEdit`. */
export function enterForceEdit(id: number): void {
    selectForce(id);
    editor.forceEdit = id;
}

/** select a summoned handle of the edited keyframe (`"in"`/`"out"`, or null to clear back to
 *  the keyframe readout) — the click-select that swaps the contextual popover to the handle's
 *  (Δs, Δg). only meaningful inside handle-edit (`forceEdit` set). */
export function selectForceHandle(side: "in" | "out" | null): void {
    editor.forceHandle = side;
}

/** exit force handle-edit mode, keeping the point selected (Esc's first peel). */
export function exitForceEdit(): void {
    editor.forceEdit = null;
    editor.forceHandle = null;
}

/** promote an already-selected force keyframe to the ACTIVE member without disturbing set
 *  membership — grabbing or right-clicking a member of a multi-set makes it the single subject the
 *  popover, readout, and single-subject menu rows bind to (the anchor). no-op when `id` isn't a
 *  member (the grammar's Blender active-object model, over a set). */
export function activateForce(id: number): void {
    activateMember("force", id);
}

/** select a section by stable id. "replace" (default) collapses the section set to `id` (or clears
 *  it when null); "toggle" adds/removes it (shift-click). either non-clearing form sweeps the
 *  other kinds. */
export function selectSection(id: number | null, mode: SelectMode = "replace"): void {
    if (id === null || mode === "replace") selectSingle("section", id);
    else toggleSingle("section", id);
}

/** select a velocity strip by stable id. "replace" (default) collapses the strip set to `id`
 *  (or clears it when null); "toggle" adds/removes it (shift-click, unused by today's gestures
 *  today but kept for the same reason `selectForces`' set shape is — a future Cut/Join bulk
 *  action). either non-clearing form sweeps the other kinds, mirroring `selectSection`. */
export function selectStrip(id: number | null, mode: SelectMode = "replace"): void {
    if (id === null || mode === "replace") selectSingle("strip", id);
    else toggleSingle("strip", id);
    if (editor.strip === null) clearKind("stripKf");
}

/** ensure a strip member is in the unified set without clearing other kinds (S2: shift-click on
 *  a strip keyframe from a different strip adds the owning strip to the set rather than
 *  replace-selecting it, so the co-selection survives). no-op when the strip is already a
 *  member; when it ADDS, the new member becomes the active one — the same last-added-member
 *  promotion every add-path here performs (the singleton `selectStrip`/`selectStripKfs`'
 *  marquee set write), so the marquee's last ensured strip is the active strip. */
export function ensureStrip(id: number): void {
    if (!memberHas("strip", id)) {
        memberAdd("strip", id);
        _active = { kind: "strip", id };
    }
}

/** select a velocity-strip keyframe by its stable id — `selectForce`'s own two-form shape,
 *  reached through the same `Timeline.svelte kfDesc` descriptor `keyframeDown` calls for either
 *  kind (S9, F7). "replace" (default) collapses the set to `id` (or clears it when null);
 *  "toggle" adds/removes it (shift-click). the replace form sweeps the other top-level kinds,
 *  then keeps ONLY the strip that owns the clicked keyframe (`owner`, required with a non-null
 *  id, resolved from the ECS by the plain-click caller through `owningStrip`/track.ts — the
 *  Delete path's own ancestor read) — containment is per member, not per kind, so a
 *  co-selected strip that owns nothing in the new set drops like any other sibling. this is
 *  the plain-click path, and `sweepOtherKinds` survives here alone (S2 deleted it from the
 *  shift/marquee paths). a sub-selection layered on strip selection: the owning strip stays
 *  selected (its diamonds are drawn), and the set becomes the Delete/Escape target. selection
 *  state in editor, Delete through the history wrapper. */
export function selectStripKf(id: null, mode?: SelectMode): void;
export function selectStripKf(id: number, mode: "toggle"): void;
export function selectStripKf(id: number, mode: "replace", owner: number): void;
export function selectStripKf(
    id: number | null,
    mode: SelectMode = "replace",
    owner?: number,
): void {
    if (id === null || mode === "replace") {
        if (id !== null) {
            sweepOtherKinds(["stripKf", "strip"]);
            // containment is per member: only the strip that OWNS the clicked keyframe survives
            // the sweep — the strip kind as a whole is not an ancestor. a co-selected strip
            // that owns nothing in the new set is a sibling, and drops exactly like every
            // other kind. `owner` is the strip the plain-click caller resolves from the ECS
            // (the SAME read the Delete path answers through, `owningStrip`/track.ts), so
            // Delete and replace-select agree on what an ancestor is; with no owner resolvable
            // (an untyped caller — the overloads make this unreachable) NOTHING is kept, the
            // fail-closed direction for a containment exception
            for (const [key, m] of _members)
                if (m.kind === "strip" && m.id !== owner) _members.delete(key);
            clearKind("stripKf");
            memberAdd("stripKf", id);
            _active = { kind: "stripKf", id };
        } else {
            clearKind("stripKf");
        }
    } else {
        toggleSingle("stripKf", id);
    }
}

/** replace the strip-keyframe selection with a computed set (the marquee's atomic write) —
 *  `selectForces`' own strip-keyframe form (S9, F7's finding (a): before, `marqueeUp` never
 *  built a strip-keyframe candidate pool at all, so a rubber-band never took one). S2: the
 *  marquee extends across kinds, so other kinds are NOT swept here. */
export function selectStripKfs(ids: number[], active: number | null): void {
    if (ids.length) {
        clearKind("stripKf");
        for (const id of ids) memberAdd("stripKf", id);
        if (active !== null && memberHas("stripKf", active))
            _active = { kind: "stripKf", id: active };
        else _active = lastMemberOfAny();
    } else {
        clearKind("stripKf");
    }
}

/** promote an already-selected strip keyframe to the ACTIVE member without disturbing set
 *  membership — `activateForce`'s strip-keyframe form, reached through the same `kfDesc`
 *  descriptor: grabbing a member of a multi-set makes it the single subject the popover binds
 *  to. no-op when `id` isn't a member. */
export function activateStripKf(id: number): void {
    activateMember("stripKf", id);
}

/** select (or clear) the track START anchor — the friction/drag coefficient popover's
 *  own target (v0 moved out, S5/S3: see `oneShot`). */
export function selectStart(on: boolean): void {
    if (on) {
        clearAllMembers();
        memberAdd("start", SINGLETON_ID);
        _active = { kind: "start", id: SINGLETON_ID };
        editor.tangentEdit = null;
        editor.forceEdit = null;
        editor.forceHandle = null;
    } else {
        clearKind("start");
    }
}

/** select (or clear) the track-start one-shot (S3, Locked decision — its own structurally
 *  distinct point kind). mirrors `selectStart`'s own shape: a boolean, since there's at
 *  most one `OneShot` entity per track. */
export function selectOneShot(on: boolean): void {
    if (on) {
        clearAllMembers();
        memberAdd("oneShot", SINGLETON_ID);
        _active = { kind: "oneShot", id: SINGLETON_ID };
        editor.tangentEdit = null;
        editor.forceEdit = null;
        editor.forceHandle = null;
    } else {
        clearKind("oneShot");
    }
}

/** open the section context menu at a screen point, targeting a section. a right-click on a
 *  member of a multi-set keeps the set and promotes the target to active (the bulk rows — Delete,
 *  Convert — act on the whole set; single-subject rows, like Convert's named destination, read the
 *  active); a right-click outside the set replace-selects just it (today's single-select behavior).
 *  mirrors `openNodeMenu`/`openForceMenu`. `cut` is the free-position Cut's own resolved landing
 *  point (`track.sectionCutAt`) — optional, defaulting to null (no resolvable position) so a
 *  caller that never resolves one still compiles. `cutSurface` defaults to `false` (the
 *  conservative default — Cut absent, `editor-ui.md` Menus): only the timeline clip strip,
 *  Cut's sole surface, passes `true` explicitly. */
export function openContext(
    x: number,
    y: number,
    section: number,
    cut: { at: number; t?: number } | null = null,
    cutSurface = false,
): void {
    if (memberHas("section", section)) activateMember("section", section);
    else selectSection(section);
    editor.context = { x, y, section, cut, cutSurface };
}

/** close the section context menu. */
export function closeContext(): void {
    editor.context = null;
}

/** open the node context menu at a screen point, targeting a pickable node. a right-click on a
 *  member of a multi-set keeps the set and promotes the target to active (the bulk rows — Delete,
 *  Tangents, Reset — act on the whole set; single-subject rows on the active); a right-click outside
 *  the set replace-selects just it (today's single-select behavior). mirrors `openForceMenu`. */
export function openNodeMenu(x: number, y: number, eid: number): void {
    if (memberHas("node", eid)) activateMember("node", eid);
    else select(eid);
    editor.nodeMenu = { x, y, eid };
}

/** close the node context menu. */
export function closeNodeMenu(): void {
    editor.nodeMenu = null;
}

/** open the force keyframe context menu at a screen point, targeting a point. a right-click on a
 *  member of a multi-set keeps the set and promotes the target to active (bulk rows — Delete,
 *  Easing — act on the whole set; single-subject rows on the active); a right-click outside the set
 *  replace-selects just it (today's single-select behavior). */
export function openForceMenu(x: number, y: number, id: number): void {
    if (memberHas("force", id)) activateMember("force", id);
    else selectForce(id);
    editor.forceMenu = { x, y, id };
}

/** close the force keyframe context menu. */
export function closeForceMenu(): void {
    editor.forceMenu = null;
}

/** open the ruler context menu at a screen point (Meters / Seconds, the track domain picker).
 *  No target subject to select — the ruler addresses the whole timeline, not a track element. */
export function openRulerMenu(x: number, y: number): void {
    editor.rulerMenu = { x, y };
}

/** close the ruler context menu. */
export function closeRulerMenu(): void {
    editor.rulerMenu = null;
}

/** open the velocity-strip band context menu at a screen point — `d` is the track-global
 *  station (arclength from track start) the click landed at, `strip` the targeted strip's
 *  stable id (-1 for empty band, i.e. creation). */
export function openStripMenu(x: number, y: number, d: number, strip: number): void {
    editor.stripMenu = { x, y, d, strip };
}

/** close the strip band context menu. */
export function closeStripMenu(): void {
    editor.stripMenu = null;
}

// ── history selection hook ────────────────────────────────────────────────────────
// the editor's snapshot/restore for undo/redo, injected into `history` at boot (`setSelectionHook`)
// so the coupling points inward — history calls this, never imports editor. the whole selection SET
// is snapshotted: every member with its kind, so a mixed-set drag's undo/redo restores every kind,
// not just the active one. a NODE is recorded by its stable (section, order), not its eid
// (`restoreSection`/`restoreAll` recycle the allocator LIFO, so a raw eid would remap to a DIFFERENT
// node after an undo); force, section, strip, stripKf by stable id; start/oneShot by their singleton
// id. the active member and the sub-modes (tangentEdit, forceEdit, forceHandle) ride along. undo
// restores each command's pre-selection, redo its post; a selection change alone is never a command.

/** a single member in the restorable snapshot — kind-tagged so restore does not switch on the
 *  active member's kind (the old shape dropped the passive kind on a mixed-set undo/redo). */
interface MemberSnap {
    kind: SelKind;
    /** node only — re-resolved across the eid recycle on restore. */
    section: number;
    /** node only. */
    order: number;
    /** non-node kinds — the stable id. 0 for node. */
    id: number;
}

/** the active member in the restorable snapshot — same shape as {@link MemberSnap} minus the kind
 *  tag on the restore side (it carries its own). */
interface ActiveSnap {
    kind: SelKind;
    section: number;
    order: number;
    id: number;
}

interface SelSnapshotData {
    members: MemberSnap[];
    active: ActiveSnap | null;
    tangentEdit: { section: number; order: number } | null;
    forceEdit: number | null;
    forceHandle: "in" | "out" | null;
}
type SelSnapshot = SelSnapshotData | null;

/** the `SelectionHook` (`history.ts`) the app injects at boot: capture the current selection set in a
 *  restorable form + restore it. history holds the snapshot opaquely. */
export const selectionHook = {
    snapshot(ecs: State): SelSnapshot {
        if (_members.size === 0) return null;
        const members: MemberSnap[] = [];
        for (const m of _members.values()) {
            if (m.kind === "node") {
                if (!ecs.has(m.id, Handle)) continue; // drop a dead node
                members.push({
                    kind: "node",
                    section: Handle.section.get(m.id),
                    order: Handle.order.get(m.id),
                    id: 0,
                });
            } else {
                members.push({ kind: m.kind, section: 0, order: 0, id: m.id });
            }
        }
        let active: ActiveSnap | null = null;
        if (_active !== null) {
            if (_active.kind === "node") {
                if (ecs.has(_active.id, Handle))
                    active = {
                        kind: "node",
                        section: Handle.section.get(_active.id),
                        order: Handle.order.get(_active.id),
                        id: 0,
                    };
            } else {
                active = { kind: _active.kind, section: 0, order: 0, id: _active.id };
            }
        }
        let tangentEdit: { section: number; order: number } | null = null;
        if (editor.tangentEdit !== null && ecs.has(editor.tangentEdit, Handle))
            tangentEdit = {
                section: Handle.section.get(editor.tangentEdit),
                order: Handle.order.get(editor.tangentEdit),
            };
        return {
            members,
            active,
            tangentEdit,
            forceEdit: editor.forceEdit,
            forceHandle: editor.forceHandle,
        };
    },
    restore(ecs: State, snap: unknown): void {
        editor.nodeMenu = null; // its rows (checked mode, enablement) went stale when the document changed
        editor.forceMenu = null; // same — the force keyframe menu's rows go stale on any restore
        editor.stripMenu = null; // same — the strip menu's rows go stale on any restore
        const s = snap as SelSnapshot;
        if (s === null) {
            deselectAll(); // clears every kind + (below) every sub-mode
            return;
        }
        clearAllMembers();
        for (const m of s.members) {
            if (m.kind === "node") {
                const eid = handleAt(ecs, m.section, m.order); // re-resolve across the eid recycle
                if (eid !== null) memberAdd("node", eid); // drop a member that didn't survive
            } else if (m.kind === "force") {
                if (forceAt(ecs, m.id) !== null) memberAdd("force", m.id);
            } else if (m.kind === "section") {
                if (sectionAt(ecs, m.id) !== null) memberAdd("section", m.id);
            } else if (m.kind === "strip") {
                if (stripAt(ecs, m.id) !== null) memberAdd("strip", m.id);
            } else if (m.kind === "stripKf") {
                if (stripKeyframeAt(ecs, m.id) !== null) memberAdd("stripKf", m.id);
            } else if (m.kind === "start") {
                memberAdd("start", SINGLETON_ID);
            } else if (m.kind === "oneShot") {
                // the one-shot may have been deleted by whatever the undo/redo just replayed —
                // singleton-shaped: add only when it survived.
                if (entryOneShot(ecs)) memberAdd("oneShot", SINGLETON_ID);
            }
        }
        // restore the active member
        if (s.active !== null) {
            if (s.active.kind === "node") {
                const eid = handleAt(ecs, s.active.section, s.active.order);
                if (eid !== null && memberHas("node", eid)) _active = { kind: "node", id: eid };
                else _active = lastMemberOfAny();
            } else if (memberHas(s.active.kind, s.active.id)) {
                _active = { kind: s.active.kind, id: s.active.id };
            } else {
                _active = lastMemberOfAny();
            }
        } else {
            _active = lastMemberOfAny();
        }
        // restore sub-modes — only when the selection is exactly the sub-mode's subject
        if (s.tangentEdit !== null) {
            const eid = handleAt(ecs, s.tangentEdit.section, s.tangentEdit.order);
            const nv = kindView("node");
            editor.tangentEdit =
                eid !== null && nv.ids.size === 1 && nv.active === eid ? eid : null;
        } else {
            editor.tangentEdit = null;
        }
        if (s.forceEdit !== null) {
            const fv = kindView("force");
            editor.forceEdit = fv.ids.size === 1 && fv.active === s.forceEdit ? s.forceEdit : null;
            editor.forceHandle = editor.forceEdit !== null ? s.forceHandle : null;
        } else {
            editor.forceEdit = null;
            editor.forceHandle = null;
        }
    },
};
