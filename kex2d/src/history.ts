/** undo/redo substrate for the whole editor, mirroring the shallot editor's
 *  command model (`shallot/.../editor/document/index.ts`): opaque `apply`/`reverse`
 *  commands on a dual stack, plus a `begin`/`commit`/`cancel` gesture lifecycle so
 *  one drag collapses to a single entry.
 *
 *  the substrate is domain-agnostic — a `Command` is just a do/undo pair. the track
 *  surfaces (geo nodes, force points, sections — `track.ts`, addressed by stable
 *  id/order so a recycled eid across a delete→undo can't alias) record onto it.
 *  do-paths mutate the live data (the re-bake is instant via the bake `hash` gate)
 *  and record an already-applied command; only undo/redo replay through
 *  apply/reverse. */

import type { State } from "@dylanebert/shallot";
import type { Easing } from "./profile";
import {
    appendSection as appendSectionTrack,
    convertSection as flipSectionKind,
    createForcePoint,
    deleteSection as deleteSectionTrack,
    destroyForce,
    extend,
    type ForcePointState,
    forcePointState,
    Handle,
    joinNext,
    type NodeState,
    nodeSnapshot,
    removeTrailingHandle,
    resetForceTangent as clearForceTangent,
    resetTangent,
    restoreAll,
    restoreForcePoint,
    restoreNodes,
    restoreSection,
    sameForceTangent,
    sameNodes,
    Section,
    SectionKind,
    sectionAt,
    type SectionLengthState,
    sectionLengthState,
    setForceEase as writeForceEase,
    setSectionLength,
    snapshotAll,
    snapshotSection,
    spawnForce,
    splitForce,
    splitGeo,
    type TrackV0State,
    trackV0State,
    setTrackV0,
} from "./track";

/** a do/undo pair. `apply` is the do / redo direction, `reverse` is undo. both
 *  mutate the canonical data directly (there's no runtime mirror to sync). */
export interface Command {
    apply(): void;
    reverse(): void;
}

/** the injected selection-snapshot hook. history stores an OPAQUE per-entry selection snapshot and
 *  calls back to capture / restore it, so the command-stack layer owns *when* (pre on record, post on
 *  the first undo) without importing editor internals — the dependency points inward (the editor
 *  injects it at boot via {@link setSelectionHook}; a test that asserts selection sets it too).
 *  `snapshot` reads the current selection into a restorable form; `restore` writes it back. */
export interface SelectionHook {
    snapshot(ecs: State): unknown;
    restore(ecs: State, snap: unknown): void;
}
let selHook: SelectionHook | null = null;
export function setSelectionHook(hook: SelectionHook | null): void {
    selHook = hook;
}

/** one undo entry: the reversible command bracketed by its selection snapshots. `pre` is the
 *  selection from BEFORE the command — captured by the op, since a destructive op destroys the
 *  selected entity before `record` runs (the shallot `execute(history, nodes, cmd, selection)` shape);
 *  `post` is the settled after-command selection, captured lazily on the first undo (a selection
 *  change alone is never a command). `pre === undefined` marks an entry that leaves selection alone (a
 *  gesture — the dragged node stays selected either direction). */
interface Entry {
    cmd: Command;
    pre: unknown;
    post?: unknown;
}

export interface History {
    undo: Entry[];
    redo: Entry[];
}

const MAX_UNDO = 256;

export function createHistory(): History {
    return { undo: [], redo: [] };
}

/** the app's single history. tests build their own via `createHistory`. */
export const history = createHistory();

/** push an already-applied command (the do-path mutated live data first), with the pre-command
 *  selection snapshot (`undefined` for a gesture, which leaves the selection alone). */
export function record(h: History, cmd: Command, pre?: unknown): void {
    h.undo.push({ cmd, pre });
    if (h.undo.length > MAX_UNDO) h.undo.shift();
    h.redo.length = 0; // a new edit invalidates the redo branch
}

export function undo(h: History, ecs: State): void {
    const entry = h.undo.pop();
    if (!entry) return;
    entry.post = selHook?.snapshot(ecs); // the settled after-command selection (for redo)
    entry.cmd.reverse();
    if (entry.pre !== undefined) selHook?.restore(ecs, entry.pre);
    h.redo.push(entry);
}

export function redo(h: History, ecs: State): void {
    const entry = h.redo.pop();
    if (!entry) return;
    entry.cmd.apply();
    if (entry.post !== undefined) selHook?.restore(ecs, entry.post);
    h.undo.push(entry);
}

// ── gesture lifecycle: a drag (or a live inline edit) writes the canonical data
// every frame for instant preview, then commits one coalesced command. one gesture
// is open at a time (a node drag and a point drag are mutually exclusive input
// surfaces). parameterized by snapshot/restore/equality closures so any domain plugs
// into the same lifecycle.
let gesture: {
    snap: () => unknown;
    restore: (s: unknown) => void;
    same: (a: unknown, b: unknown) => boolean;
    prev: unknown;
} | null = null;

/** open a gesture, deep-capturing the pristine pre-gesture state. `snap` returning
 *  `undefined` (the target is gone) opens nothing. */
export function begin<S>(
    snap: () => S | undefined,
    restore: (s: S) => void,
    same: (a: S, b: S) => boolean,
): void {
    const prev = snap();
    if (prev === undefined) return;
    gesture = {
        snap: snap as () => unknown,
        restore: restore as (s: unknown) => void,
        same: same as (a: unknown, b: unknown) => boolean,
        prev,
    };
}

/** commit the open gesture: record one command (restore prev ↔ restore next) if the
 *  state changed. the live writes already applied `next`. */
export function commit(h: History): void {
    const g = gesture;
    gesture = null;
    if (!g) return;
    const next = g.snap();
    if (next === undefined) return;
    if (g.same(g.prev, next)) return; // a no-op (a click, or a nudge back to start)
    const { restore, prev } = g;
    record(h, { apply: () => restore(next), reverse: () => restore(prev) });
}

/** abort the open gesture, restoring the pre-gesture state. */
export function cancel(): void {
    const g = gesture;
    gesture = null;
    if (g) g.restore(g.prev);
}

// ── selection across undo/redo ────────────────────────────────────────────────────
// selection restoration is the command-stack layer's job (undo restores each entry's `pre`, redo its
// `post`), driven by the injected `SelectionHook` — a selection change alone is never a command
// (clicking around consumes no history). the hook snapshots a node by its stable (section, order),
// not its eid: `restoreSection`/`restoreAll` destroy and respawn a section's nodes and the allocator
// recycles LIFO, so a raw eid would remap to a DIFFERENT node after an undo. it closes the node menu
// on restore (its rows go stale when the document changes). history never touches editor directly.

/** build the undoable command for a snapshot restore pair (section-scoped or whole-track). the
 *  selection is handled at the stack layer (`undo`/`redo`), not here. */
function restoreCommand<S>(
    ecs: State,
    before: S,
    after: S,
    restore: (ecs: State, snap: S) => void,
): Command {
    return {
        apply: () => restore(ecs, after),
        reverse: () => restore(ecs, before),
    };
}

// ── geo nodes ──────────────────────────────────────────────────────────────────

/** extend a section's chain (lay a node past the tip), recording an undoable add. the new node
 *  takes its heading from the old tip's exit, so the command captures the whole section
 *  before/after rather than just the added node. returns the new node's eid. */
export function extendTrack(h: History, ecs: State, section: number): number {
    const pre = selHook?.snapshot(ecs);
    const before = snapshotSection(ecs, section);
    const eid = extend(ecs, section);
    const after = snapshotSection(ecs, section);
    record(h, restoreCommand(ecs, before, after, restoreSection), pre);
    return eid;
}

/** trim a section's trailing node, recording an undoable remove. `removeTrailingHandle` reheads
 *  the promoted tip, so the command captures the whole section before/after (pose + heading +
 *  the trimmed node's tangent). no-op below the two-node floor (records nothing, returns false). */
export function trimTrack(h: History, ecs: State, section: number): boolean {
    const pre = selHook?.snapshot(ecs); // the tip being trimmed — captured before it's destroyed
    const before = snapshotSection(ecs, section);
    if (!removeTrailingHandle(ecs, section)) return false;
    const after = snapshotSection(ecs, section);
    record(h, restoreCommand(ecs, before, after, restoreSection), pre);
    return true;
}

/** Reset a node's tangent(s) back to live (`Auto`), as one undoable entry. `stitch` is the
 *  downstream node-0 eid coincident with `tip` when `tip` is a geo→geo boundary (the "one node,
 *  stitched at the UI" view — kex2d-geo-ux): then the Reset clears BOTH halves, the tip's own
 *  tangent and the downstream section's node-0 tangent, each through its own section's reset path.
 *  `null` is the plain single-node reset (the START node 0, an interior node, or a final tip). The
 *  affected sections (one or two) go in one command, so a single undo restores every cleared half;
 *  records nothing if nothing changed (an enablement-gated Reset always clears something, but the
 *  guard keeps a stray invocation off the undo stack). Uses `restoreNodes` (writes by stable order,
 *  no eid recycle), matching the tangent-edit gesture. */
export function resetTangents(h: History, ecs: State, tip: number, stitch: number | null): void {
    const pre = selHook?.snapshot(ecs);
    const secs = [Handle.section.get(tip)];
    if (stitch !== null && !secs.includes(Handle.section.get(stitch)))
        secs.push(Handle.section.get(stitch));
    const before = secs.map((s) => nodeSnapshot(ecs, s));
    resetTangent(ecs, Handle.section.get(tip), Handle.order.get(tip));
    if (stitch !== null) resetTangent(ecs, Handle.section.get(stitch), Handle.order.get(stitch));
    const after = secs.map((s) => nodeSnapshot(ecs, s));
    if (secs.every((_, i) => sameNodes(before[i], after[i]))) return; // nothing cleared
    const restore = (snap: NodeState[][]): void => {
        for (let i = 0; i < secs.length; i++) restoreNodes(ecs, secs[i], snap[i]);
    };
    record(h, { apply: () => restore(after), reverse: () => restore(before) }, pre);
}

/** open a gesture on a node drag, snapshotting the section's pose. commit coalesces
 *  the drag into one entry; a no-move click records nothing. */
export function beginMove(ecs: State, section: number): void {
    begin(
        () => nodeSnapshot(ecs, section),
        (s: NodeState[]) => restoreNodes(ecs, section, s),
        sameNodes,
    );
}

// ── force points ─────────────────────────────────────────────────────────────

/** author a force point on a section at `(s, g)`, recording an undoable add. the id
 *  is allocated once; undo destroys by it and redo re-spawns verbatim. returns the
 *  new point's stable id. */
export function createForce(h: History, ecs: State, section: number, s: number, g: number): number {
    const pre = selHook?.snapshot(ecs);
    const id = createForcePoint(ecs, section, s, g);
    record(
        h,
        {
            apply: () => spawnForce(ecs, section, id, s, g),
            reverse: () => destroyForce(ecs, id),
        },
        pre,
    );
    return id;
}

/** delete a force point by id, recording an undoable remove — undo re-spawns it
 *  verbatim (into its original section). no-op if the id is already gone. */
export function deleteForce(h: History, ecs: State, id: number): void {
    const pre = selHook?.snapshot(ecs); // the point being deleted — captured before it's destroyed
    const st = forcePointState(ecs, id);
    if (!st) return;
    destroyForce(ecs, id);
    record(
        h,
        {
            apply: () => destroyForce(ecs, id),
            reverse: () => spawnForce(ecs, st.section, st.id, st.s, st.g, st.ease, st.tangent),
        },
        pre,
    );
}

/** open a gesture on a force-point drag (or an inline field edit), snapshotting the
 *  point's full state. commit coalesces the live writes into one entry; a position
 *  drag changes only `s`/`g`, so that's the no-op test. */
export function beginForceMove(ecs: State, id: number): void {
    begin(
        () => forcePointState(ecs, id),
        (st: ForcePointState) => restoreForcePoint(ecs, st),
        (a: ForcePointState, b: ForcePointState) => a.s === b.s && a.g === b.g,
    );
}

/** set a force keyframe's easing tag as one undoable entry (the menu one-shot). the
 *  full easing state (tag + explicit handles) round-trips; records nothing when the
 *  tag is unchanged. */
export function setForceEase(h: History, ecs: State, id: number, ease: Easing): void {
    const pre = selHook?.snapshot(ecs);
    const before = forcePointState(ecs, id);
    if (!before) return;
    writeForceEase(ecs, id, ease);
    const after = forcePointState(ecs, id);
    if (after === undefined || before.ease === after.ease) return;
    record(
        h,
        {
            apply: () => restoreForcePoint(ecs, after),
            reverse: () => restoreForcePoint(ecs, before),
        },
        pre,
    );
}

/** clear a force keyframe's explicit handles back to the `ease`-derived default as one
 *  undoable entry (the Reset action). records nothing when there were no handles. */
export function resetForceTangent(h: History, ecs: State, id: number): void {
    const pre = selHook?.snapshot(ecs);
    const before = forcePointState(ecs, id);
    if (!before) return;
    clearForceTangent(ecs, id);
    const after = forcePointState(ecs, id);
    if (after === undefined || sameForceTangent(before.tangent, after.tangent)) return;
    record(
        h,
        {
            apply: () => restoreForcePoint(ecs, after),
            reverse: () => restoreForcePoint(ecs, before),
        },
        pre,
    );
}

/** open a gesture on a force-keyframe handle drag, snapshotting the keyframe's easing
 *  state (tag + explicit handles). commit coalesces the live handle writes into one
 *  entry; a no-move release records nothing. the UI writes through `setForceTangent`. */
export function beginForceTangent(ecs: State, id: number): void {
    begin(
        () => forcePointState(ecs, id),
        (st: ForcePointState) => restoreForcePoint(ecs, st),
        (a: ForcePointState, b: ForcePointState) =>
            a.ease === b.ease && sameForceTangent(a.tangent, b.tangent),
    );
}

/** open a gesture on a force-section end-handle drag, snapshotting its extent. commit
 *  coalesces the live resize into one entry; a no-move release records nothing. */
export function beginLength(ecs: State, id: number): void {
    begin(
        () => sectionLengthState(ecs, id),
        (st: SectionLengthState) => setSectionLength(ecs, st.id, st.length),
        (a: SectionLengthState, b: SectionLengthState) => a.length === b.length,
    );
}

// ── track initial speed (v0) ───────────────────────────────────────────────────

/** open a gesture on the track's initial-speed field (scrub or typed edit),
 *  snapshotting v0. commit coalesces the live writes into one entry; a no-change
 *  release records nothing. */
export function beginV0(trackEid: number): void {
    begin(
        () => trackV0State(trackEid),
        (st: TrackV0State) => setTrackV0(trackEid, st.v0),
        (a: TrackV0State, b: TrackV0State) => a.v0 === b.v0,
    );
}

// ── per-section kind conversion ───────────────────────────────────────────────

/** flip a section's kind to its opposite, destructively resetting to that kind's
 *  default, as one undoable entry. the command captures the full section state
 *  before and after (`snapshotSection`), so undo restores the pre-convert payload
 *  byte-identical — what makes destructive conversion safe without a confirm dialog. */
export function convertSection(h: History, ecs: State, section: number): void {
    const pre = selHook?.snapshot(ecs);
    const before = snapshotSection(ecs, section);
    flipSectionKind(ecs, section);
    const after = snapshotSection(ecs, section);
    record(h, restoreCommand(ecs, before, after, restoreSection), pre);
}

// ── structural ops (append / split / join / delete) ──────────────────────────
// each wraps a whole-track snapshot pair — the op reorders sections and moves
// nodes/points across them, so a per-section restore can't capture it; the pair
// respawns every section's stored f32 verbatim, so undo/redo is byte-identical.

/** append a new section of `kind` at the chain end, recording one undoable entry.
 *  returns the new section id. */
export function appendSection(h: History, ecs: State, kind: SectionKind): number {
    const pre = selHook?.snapshot(ecs);
    const before = snapshotAll(ecs);
    const id = appendSectionTrack(ecs, kind);
    const after = snapshotAll(ecs);
    record(h, restoreCommand(ecs, before, after, restoreAll), pre);
    return id;
}

/** split a section, recording one undoable entry. `at` is a geo section's interior
 *  node order or a force section's arclength s (the caller supplies the right one for
 *  the kind). no-op (records nothing) at a non-interior split point; returns the new
 *  tail section id, or null. */
export function splitSection(h: History, ecs: State, section: number, at: number): number | null {
    const eid = sectionAt(ecs, section);
    if (eid === null) return null;
    const pre = selHook?.snapshot(ecs);
    const before = snapshotAll(ecs);
    const id =
        Section.kind.get(eid) === SectionKind.Geo
            ? splitGeo(ecs, section, at)
            : splitForce(ecs, section, at);
    if (id === null) return null; // nothing split — don't record
    const after = snapshotAll(ecs);
    record(h, restoreCommand(ecs, before, after, restoreAll), pre);
    return id;
}

/** join a section with its same-kind successor, recording one undoable entry. no-op
 *  (records nothing) when there's no successor or the kinds differ. returns true when
 *  joined. */
export function joinSection(h: History, ecs: State, section: number): boolean {
    const pre = selHook?.snapshot(ecs);
    const before = snapshotAll(ecs);
    if (!joinNext(ecs, section)) return false;
    const after = snapshotAll(ecs);
    record(h, restoreCommand(ecs, before, after, restoreAll), pre);
    return true;
}

/** delete a section, recording one undoable entry. no-op (records nothing) at the
 *  last remaining section. returns true when deleted. */
export function removeSection(h: History, ecs: State, section: number): boolean {
    const pre = selHook?.snapshot(ecs); // the section being deleted — its stable id survives regardless
    const before = snapshotAll(ecs);
    if (!deleteSectionTrack(ecs, section)) return false;
    const after = snapshotAll(ecs);
    record(h, restoreCommand(ecs, before, after, restoreAll), pre);
    return true;
}
