/** ephemeral editor state — the current selection. lives outside ECS because it
 *  doesn't persist (no save/load, no replay). plain mutable singleton; Svelte reads
 *  it via the per-RAF tick pattern in App.
 *
 *  Timeline owns its two local tools. Over the lane substrate there is ONE selection kind:
 *  a lane record, addressed by the stable id its lane row and every authoring verb already use
 *  (`record`, below). The six pose-era kinds (node, force, segment, section, strip, strip
 *  keyframe, plus the two singletons) went with the subjects they addressed; the unified
 *  container they were built to share stays, because it is what makes the one surviving kind a
 *  set rather than a scalar — Shift toggles membership, an empty click clears the set, and undo
 *  restores the whole set, not just its active member. */

import type { State } from "@dylanebert/shallot";
import { recordAt } from "./track";

/** which end of a node's tangent a knob edits. The node substrate is retired; the type survives
 *  as the canvas hover seam's own shape until the geo control wiring returns over pitch. */
export type TangentSide = "in" | "out";

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
// one ordered member set of {kind, id} + one active {kind, id}. `editor.records` is a derived
// read over this set, never storage. The container survives the kind census down to one because
// the SET is the substrate: a plain click replace-selects, Shift toggles membership, an empty
// click clears, and the history hook snapshots every member.

/** the selection kinds. One kind over the lane substrate: a lane record, addressed by the stable
 *  id `track.ts`'s setters and `commands.ts`'s ops already address it by, so a selected span, a
 *  headless op and an undo entry all name the same thing. Kept as a UNION (of one) rather than
 *  collapsed away, because the container's shape is per-kind and the next authored subject the
 *  timeline gains — a run, a boundary — joins here rather than reopening the container. */
export type SelKind = "record";

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

function memberHas(kind: SelKind, id: number): boolean {
    return _members.has(memberKey(kind, id));
}

function clearAllMembers(): void {
    _members.clear();
    _active = null;
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

/** whether the selection has more than one subject — the set-level predicate contextual
 *  single-subject chrome reads (the popover binds to one span, so it hides on a multi-set).
 *
 *  a plain function, not a `$derived`: `editor` is a plain singleton with no invalidation signal.
 *  A derived caller must touch its own `tick` dependency, as the surrounding readers do.
 *
 *  @example
 *  // hide the span popover on a multi-set
 *  if (multi()) return null;
 */
export function multi(): boolean {
    return _members.size > 1;
}

/** whether anything is selected — exactly `_members.size > 0`. The dismissal rung's read: what
 *  an empty click or an Escape has to clear before it peels the next layer.
 *
 *  a plain function, not a `$derived`, for the reason {@link multi} gives.
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

interface EditorState {
    /** the selected lane records — a derived `Selection` view over the unified member set,
     *  addressed by the stable record id every setter, op and undo entry already uses. */
    records: Selection;
    /** the active (last-selected) record id, or null — a derived read over the same set. The
     *  single subject the popover, the nudge keys and the Delete rung bind to. Assigning it is a
     *  replace-select (`selectRecord`). */
    record: number | null;
    /** the ruler context menu (Meters / Seconds — the track domain picker): screen position,
     *  or null when closed. summoned by right-clicking the ruler scrub zone (the Premiere/
     *  REAPER/Cubase reference: time-display format lives on the ruler's own context menu). No
     *  target id — it has one subject, the timeline itself. A row's pick is a pure view write
     *  (`domain.convertDomain` writes `Track.domain` alone), so no basis state lives here. */
    rulerMenu: { x: number; y: number } | null;
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

/** the one shared easing curve (`editor-ui.md` Mode vocabulary: Motion) — cubic ease-out,
 *  `1 − (1 − t)³`. The CSS twin is App.svelte's `--ease-out` token, the exact bezier of this
 *  polynomial (`cubic-bezier(0.33333, 1, 0.66667, 1)`); pinned equal in colors.test.ts, so
 *  the two halves can't drift into two dialects of one motion. */
export function easeOut(t: number): number {
    return 1 - (1 - t) ** 3;
}

export const editor: EditorState = {
    get records(): Selection {
        return kindView("record");
    },
    get record(): number | null {
        return kindActiveId("record");
    },
    set record(v: number | null) {
        selectRecord(v);
    },
    rulerMenu: null,
    dragging: false,
    hoverSection: null,
    hoverNode: null,
    hoverForce: null,
    hoverKnob: null,
    hover: "viewport",
    converting: null,
    notice: null,
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

// a plain click replace-selects: clearing every member of every kind, then setting the one.
// shift/marquee toggle within one kind after sweeping the others. the `exclusive*` family is
// deleted — its observable (selecting into one kind clears the others) is preserved by
// replace-select clearing all members and toggle-select sweeping other kinds through the
// unified set. the edit sub-modes stay single-subject — entering one collapses its kind to
// that one member (`enter*Edit` route through the replace form).

/** the two selection forms: "replace" (collapse the kind to one member — today's behavior) and
 *  "toggle" (shift-click add/remove membership). */
export type SelectMode = "replace" | "toggle";

/** replace-select a single record, clearing the set first — the plain-click form. `null` clears. */
export function selectRecord(id: number | null): void {
    clearAllMembers();
    if (id === null) return;
    memberAdd("record", id);
    _active = { kind: "record", id };
}

/** toggle a record's membership — the Shift-click form: add it and make it active, or remove it,
 *  promoting the most-recently-added survivor active when the removed member was the active one
 *  (`lastMemberOfAny`, the same promotion every other path here performs). */
export function toggleRecord(id: number): void {
    if (_members.delete(memberKey("record", id))) {
        if (_active !== null && _active.id === id) _active = lastMemberOfAny();
        return;
    }
    memberAdd("record", id);
    _active = { kind: "record", id };
}

/** replace the selection with a computed set (a marquee's atomic write, and the restore path's
 *  own shape), `active` anchored when it is a member and the last-inserted survivor otherwise. */
export function selectRecords(ids: readonly number[], active: number | null): void {
    clearAllMembers();
    for (const id of ids) memberAdd("record", id);
    _active =
        active !== null && memberHas("record", active)
            ? { kind: "record", id: active }
            : lastMemberOfAny();
}

/** promote an already-selected record to ACTIVE without disturbing membership — grabbing a member
 *  of a multi-set makes it the single subject the popover and the nudge keys bind to. No-op when
 *  `id` isn't a member (the Blender active-object model, over a set). */
export function activateRecord(id: number): void {
    const m = _members.get(memberKey("record", id));
    if (m !== undefined) _active = m;
}

/** clear the whole selection — the empty-lane / empty-ruler click and Escape's selection rung
 *  (`kex2d-event-lane` S4, "one selection model": a click with no subject under the pointer clears
 *  everything). The pose era's `deselectAll` was this plus a node sub-mode reset; the sub-mode
 *  went with the nodes, so one name is left. */
export function clearSelection(): void {
    clearAllMembers();
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

// ── history selection hook ────────────────────────────────────────────────────────
// the editor's snapshot/restore for undo/redo, injected into `history` at boot (`setSelectionHook`)
// so the coupling points inward — history calls this, never imports editor. the whole selection SET
// is snapshotted, not just its active member, so a multi-span drag's undo restores the set it was
// made on. A record is recorded by its STABLE id, the id the setters, the ops and the wire all
// address it by, so it survives the replay exactly when the record does — a deleted record's
// membership is dropped on restore rather than resurrected as a dangling id. Undo restores each
// command's pre-selection, redo its post; a selection change alone is never a command.

/** a single member in the restorable snapshot — kind-tagged, so the container's shape survives a
 *  second kind joining it later without the snapshot silently flattening the two. */
interface MemberSnap {
    kind: SelKind;
    id: number;
}

interface SelSnapshotData {
    members: MemberSnap[];
    active: MemberSnap | null;
}
type SelSnapshot = SelSnapshotData | null;

/** the `SelectionHook` (`history.ts`) the app injects at boot: capture the current selection set in a
 *  restorable form + restore it. history holds the snapshot opaquely. */
export const selectionHook = {
    snapshot(ecs: State): SelSnapshot {
        void ecs;
        if (_members.size === 0) return null;
        const members: MemberSnap[] = [];
        for (const m of _members.values()) members.push({ kind: m.kind, id: m.id });
        const active = _active === null ? null : { kind: _active.kind, id: _active.id };
        return { members, active };
    },
    restore(ecs: State, snap: unknown): void {
        editor.rulerMenu = null; // its rows went stale the moment the document changed
        const s = snap as SelSnapshot;
        if (s === null) {
            clearSelection();
            return;
        }
        clearAllMembers();
        // a member survives the replay only when its record does: `recordAt` is the store's own
        // read, so an undo past a delete restores the set MINUS the record that is gone rather
        // than a member addressing nothing.
        for (const m of s.members) if (recordAt(ecs, m.id) !== null) memberAdd(m.kind, m.id);
        _active =
            (s.active !== null ? _members.get(memberKey(s.active.kind, s.active.id)) : undefined) ??
            lastMemberOfAny();
    },
};
