/** ephemeral editor state — the current selection. lives outside ECS because it
 *  doesn't persist (no save/load, no replay). plain mutable singleton; Svelte reads
 *  it via the per-RAF tick pattern in App.
 *
 *  there are no tools or modes: you select a node and drag it in the viewport, a
 *  force point on the timeline curve, a whole section, or the track START anchor —
 *  four mutually-exclusive selections (below), so a contextual action never fights
 *  over its target. */

import type { State } from "@dylanebert/shallot";
import { createHistory, type History, redirectHistory } from "./history";
import type { OptimizeOutcome, UnreachableReason } from "./optimize";
import { forceAt, Handle, handleAt, sectionAt, setBakeFreeze, setBakeLanding } from "./track";
import type { TangentSide } from "./tangents";

/** the editor surface the pointer is over — the router for surface-scoped keys
 *  (the Blender/Unity hovered-surface model). */
export type Surface = "viewport" | "timeline";

/** a per-kind selection: a set of members with the last-selected one active. single-select is the
 *  size-1 case (the substrate, not a parallel path). the node kind holds live eids (resolved fresh
 *  each pick); the force and section kinds hold stable ids (`Force.id` / `Section.id`), per the
 *  stable-form recycle-safety law. members are insertion-ordered (JS Set), so toggling out the active
 *  member promotes the most-recently-added survivor deterministically. */
export interface Selection {
    /** the selected members — eids (node kind) or stable ids (force/section kind). */
    ids: Set<number>;
    /** the active (last-selected) member: the single subject the readout, popover, manipulator ring,
     *  and snap resolution anchor to. null iff `ids` is empty; otherwise always a member of `ids`. */
    active: number | null;
}

function emptySel(): Selection {
    return { ids: new Set(), active: null };
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

function clearSel(sel: Selection): void {
    sel.ids.clear();
    sel.active = null;
}

interface EditorState {
    /** the selected geo nodes (a set + active member). ids are live eids, resolved fresh each pick
     *  and re-resolved by stable (section, order) across an undo (the eid recycles). */
    nodes: Selection;
    /** the selected force keyframes (set + active), addressed by stable `Force.id`. */
    forces: Selection;
    /** the selected sections (set + active), addressed by stable `Section.id`. */
    sections: Selection;
    /** the active geo node eid, or null — the single-subject accessor over `nodes` (its active
     *  member). reading it is "the one subject" (readout, ring, manipulator, snap); assigning it is
     *  a replace-select (`select`). readers wanting the whole set read `nodes` directly. */
    selection: number | null;
    /** the active force keyframe id, or null — the single-subject accessor over `forces`. */
    force: number | null;
    /** the active section id, or null — the single-subject accessor over `sections`. */
    section: number | null;
    /** eid of the node in tangent-edit mode (its handles are summoned), or null — a
     *  sub-mode layered on node selection: `tangentEdit !== null` implies the node set is exactly
     *  `{tangentEdit}` with it active. entered by double-clicking a node (Figma vector edit);
     *  any selection change to a different subject (or the set growing past it), Esc, or click-away
     *  exits it. NOT a fifth mutually-exclusive selection — a refinement of the node-selection state. */
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
    /** whether the track START anchor is selected. there's one START per track, so a
     *  boolean; selecting it summons the initial-speed (v0) field popover. */
    start: boolean;
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
     *  subject, the timeline itself. A row's pick is a document conversion op
     *  (`domain.convertDomain`), not a view write, so no basis state lives here. */
    rulerMenu: { x: number; y: number } | null;
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
    nodes: emptySel(),
    forces: emptySel(),
    sections: emptySel(),
    get selection(): number | null {
        return this.nodes.active;
    },
    set selection(v: number | null) {
        select(v);
    },
    get force(): number | null {
        return this.forces.active;
    },
    set force(v: number | null) {
        selectForce(v);
    },
    get section(): number | null {
        return this.sections.active;
    },
    set section(v: number | null) {
        selectSection(v);
    },
    tangentEdit: null,
    forceEdit: null,
    forceHandle: null,
    start: false,
    context: null,
    nodeMenu: null,
    forceMenu: null,
    rulerMenu: null,
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

// the four selection kinds are mutually exclusive — selecting into one clears the others, so the
// contextual actions (node extend/trim, force field popover, section ops, v0 popover) never fight
// over which target a key press means. each `select*` grows a `mode`: "replace" (the default, and
// today's single-select behavior — collapse the kind to one member) and "toggle" (shift-click
// membership: add-and-activate, or remove-and-promote). the edit sub-modes stay single-subject —
// entering one collapses its kind to that one member (`enter*Edit` route through the replace form).

/** the two selection forms: "replace" (collapse the kind to one member — today's behavior) and
 *  "toggle" (shift-click add/remove membership). */
export type SelectMode = "replace" | "toggle";

/** clear the non-node kinds — the mutual-exclusion sweep a node select runs (switching to / staying
 *  in the node kind). leaves `nodes` and `tangentEdit` for the caller. */
function exclusiveNode(): void {
    clearSel(editor.forces);
    clearSel(editor.sections);
    editor.forceEdit = null;
    editor.forceHandle = null;
    editor.start = false;
}

function exclusiveForce(): void {
    clearSel(editor.nodes);
    clearSel(editor.sections);
    editor.tangentEdit = null;
    editor.start = false;
}

function exclusiveSection(): void {
    clearSel(editor.nodes);
    clearSel(editor.forces);
    editor.tangentEdit = null;
    editor.forceEdit = null;
    editor.forceHandle = null;
    editor.start = false;
}

/** drop tangent edit unless the node selection is exactly its subject (a set that grew past one, or
 *  whose active moved off it, leaves the single-subject sub-mode). */
function reconcileTangent(): void {
    if (
        editor.tangentEdit !== null &&
        (editor.nodes.ids.size !== 1 || editor.nodes.active !== editor.tangentEdit)
    )
        editor.tangentEdit = null;
}

/** drop force handle-edit unless the force selection is exactly its subject. */
function reconcileForceEdit(): void {
    if (
        editor.forceEdit !== null &&
        (editor.forces.ids.size !== 1 || editor.forces.active !== editor.forceEdit)
    )
        editor.forceEdit = null;
}

/** select a geo node. "replace" (default) collapses the node set to `eid` (or clears it when null) —
 *  today's behavior; "toggle" adds/removes `eid` (shift-click). either non-clearing form sweeps the
 *  other kinds. a select to a different subject exits tangent edit; re-selecting the edited node (as
 *  the sole member) keeps it, so grabbing its own handle or nudging it doesn't drop the mode. */
export function select(eid: number | null, mode: SelectMode = "replace"): void {
    if (eid === null || mode === "replace") {
        setMember(editor.nodes, eid);
        if (eid !== null) exclusiveNode();
    } else {
        exclusiveNode();
        toggleMember(editor.nodes, eid);
    }
    reconcileTangent();
}

/** replace the node selection with a computed set (the marquee's atomic write): members `ids`,
 *  `active` active, the other kinds swept when non-empty. the set-valued analog of `select` — one
 *  write of a whole merged hit set, same exclusivity + reconcile. an empty set clears the node kind
 *  only (the caller sweeps the rest for a full deselect, matching empty-click). */
export function selectNodes(ids: number[], active: number | null): void {
    rebuild(editor.nodes, ids, active);
    if (ids.length) exclusiveNode();
    reconcileTangent();
}

/** replace the force selection with a computed set (the marquee's atomic write) — the force
 *  analog of `selectNodes`. */
export function selectForces(ids: number[], active: number | null): void {
    rebuild(editor.forces, ids, active);
    if (ids.length) exclusiveForce();
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
    if (id === null || mode === "replace") {
        setMember(editor.forces, id);
        if (id !== null) exclusiveForce();
    } else {
        exclusiveForce();
        toggleMember(editor.forces, id);
    }
    editor.forceHandle = null; // selecting the point itself shows the keyframe readout
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
    if (editor.forces.ids.has(id)) editor.forces.active = id;
}

/** select a section by stable id. "replace" (default) collapses the section set to `id` (or clears
 *  it when null); "toggle" adds/removes it (shift-click). either non-clearing form sweeps the
 *  other kinds. */
export function selectSection(id: number | null, mode: SelectMode = "replace"): void {
    if (id === null || mode === "replace") {
        setMember(editor.sections, id);
        if (id !== null) exclusiveSection();
    } else {
        exclusiveSection();
        toggleMember(editor.sections, id);
    }
}

/** select (or clear) the track START anchor — the initial-speed handle. */
export function selectStart(on: boolean): void {
    editor.start = on;
    if (on) {
        clearSel(editor.nodes);
        clearSel(editor.forces);
        clearSel(editor.sections);
        editor.tangentEdit = null;
        editor.forceEdit = null;
        editor.forceHandle = null;
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
    if (editor.sections.ids.has(section)) editor.sections.active = section;
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
    if (editor.nodes.ids.has(eid)) editor.nodes.active = eid;
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
    if (editor.forces.ids.has(id)) editor.forces.active = id;
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

// ── history selection hook ────────────────────────────────────────────────────────
// the editor's snapshot/restore for undo/redo, injected into `history` at boot (`setSelectionHook`)
// so the coupling points inward — history calls this, never imports editor. the whole selection SET
// is snapshotted: a NODE by its stable (section, order), not its eid (`restoreSection`/`restoreAll`
// recycle the allocator LIFO, so a raw eid would remap to a DIFFERENT node after an undo), force and
// section by stable id, the START by a flag; the active member rides along in the same form. undo
// restores each command's pre-selection, redo its post; a selection change alone is never a command.

interface NodeRef {
    section: number;
    order: number;
}
type SelSnapshot =
    | { kind: "node"; members: NodeRef[]; active: NodeRef; editing: boolean }
    | { kind: "force"; ids: number[]; active: number; editing: boolean }
    | { kind: "section"; ids: number[]; active: number }
    | { kind: "start" }
    | null;

/** rebuild a selection set from restored members, re-anchoring the active (or promoting the
 *  most-recently-added survivor when the snapshotted active didn't survive the restore). */
function rebuild(sel: Selection, ids: number[], active: number | null): void {
    sel.ids.clear(); // mutate in place (like setMember/toggleMember) so no held reference goes stale
    for (const id of ids) sel.ids.add(id);
    sel.active = active !== null && sel.ids.has(active) ? active : lastMember(sel.ids);
}

/** the `SelectionHook` (`history.ts`) the app injects at boot: capture the current selection set in a
 *  restorable form + restore it. history holds the snapshot opaquely. */
export const selectionHook = {
    snapshot(ecs: State): SelSnapshot {
        const n = editor.nodes;
        if (n.active !== null && ecs.has(n.active, Handle)) {
            const members: NodeRef[] = [];
            for (const eid of n.ids)
                if (ecs.has(eid, Handle))
                    members.push({
                        section: Handle.section.get(eid),
                        order: Handle.order.get(eid),
                    });
            const active = {
                section: Handle.section.get(n.active),
                order: Handle.order.get(n.active),
            };
            return { kind: "node", members, active, editing: editor.tangentEdit === n.active };
        }
        if (editor.forces.active !== null)
            return {
                kind: "force",
                ids: [...editor.forces.ids],
                active: editor.forces.active,
                editing: editor.forceEdit === editor.forces.active,
            };
        if (editor.sections.active !== null)
            return {
                kind: "section",
                ids: [...editor.sections.ids],
                active: editor.sections.active,
            };
        if (editor.start) return { kind: "start" };
        return null;
    },
    restore(ecs: State, snap: unknown): void {
        editor.nodeMenu = null; // its rows (checked mode, enablement) went stale when the document changed
        editor.forceMenu = null; // same — the force keyframe menu's rows go stale on any restore
        const s = snap as SelSnapshot;
        if (s === null) {
            clearSel(editor.nodes); // clears the selection + (below) the tangent-edit sub-mode
            clearSel(editor.forces);
            clearSel(editor.sections);
            editor.tangentEdit = null;
            editor.forceEdit = null;
            editor.forceHandle = null;
            editor.start = false;
            return;
        }
        switch (s.kind) {
            case "node": {
                const ids: number[] = [];
                for (const m of s.members) {
                    const eid = handleAt(ecs, m.section, m.order); // re-resolve across the eid recycle
                    if (eid !== null) ids.push(eid); // drop a member that didn't survive
                }
                const active = handleAt(ecs, s.active.section, s.active.order);
                rebuild(editor.nodes, ids, active);
                exclusiveNode();
                editor.tangentEdit =
                    s.editing && editor.nodes.ids.size === 1 ? editor.nodes.active : null;
                break;
            }
            case "force":
                // prune ids whose point didn't survive the restore, matching the node path — a
                // dropped active then promotes the last survivor via rebuild's has-check
                rebuild(
                    editor.forces,
                    s.ids.filter((id) => forceAt(ecs, id) !== null),
                    s.active,
                );
                exclusiveForce();
                editor.forceHandle = null;
                editor.forceEdit =
                    s.editing && editor.forces.ids.size === 1 ? editor.forces.active : null;
                break;
            case "section":
                rebuild(
                    editor.sections,
                    s.ids.filter((id) => sectionAt(ecs, id) !== null),
                    s.active,
                );
                exclusiveSection();
                break;
            case "start":
                selectStart(true);
                break;
        }
    },
};
