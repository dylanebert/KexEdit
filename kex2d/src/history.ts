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
import type { Lane, LaneSegment } from "./lanes";
import type { Easing } from "./profile";
import type { Domain } from "./section";
import {
    createRecord,
    deleteRecord,
    endColumn,
    entrySpeed,
    type LaneRefusal,
    laneOrderOf,
    orderColumn,
    type LaneWrite,
    recordOf,
    setEnd,
    setOrder as writeLaneOrder,
    setRecordEase,
    setRecordHandle,
    setRecordSpan,
    setV0,
    setTrackDomain,
    setTrackFriction,
    setTrackResistance,
    trackDomain,
    trackEntity,
    type TrackFrictionState,
    trackFrictionState,
    type TrackResistanceState,
    trackResistanceState,
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

// ── friction / drag (Coulomb loss + quadratic drag coefficients) ───────────────

/** open a gesture on the track's friction field (scrub or typed edit), snapshotting
 *  `Track.friction`. `trackFrictionState` reads `undefined` for a gone track, so `begin` refuses
 *  to open there. commit coalesces the live writes into one entry; a no-change release records
 *  nothing. */
export function beginFriction(trackEid: number): void {
    begin(
        () => trackFrictionState(trackEid),
        (st: TrackFrictionState) => setTrackFriction(trackEid, st.friction),
        (a: TrackFrictionState, b: TrackFrictionState) => a.friction === b.friction,
    );
}

/** `beginFriction`'s drag-coefficient twin. */
export function beginResistance(trackEid: number): void {
    begin(
        () => trackResistanceState(trackEid),
        (st: TrackResistanceState) => setTrackResistance(trackEid, st.resistance),
        (a: TrackResistanceState, b: TrackResistanceState) => a.resistance === b.resistance,
    );
}

// ── track domain (view) ─────────────────────────────────────────────────────────

/** land a `Track.domain` flip as one undoable entry. Arclength is the one store every force
 *  keyframe, extent, strip and strip keyframe lives in — the flip changes which unit the
 *  ruler/readouts DISPLAY that store in, never the store itself (`domain.convertDomain`'s own
 *  docblock has the why), so this writes exactly one column and nothing else. */
export function landDomain(h: History, ecs: State, target: Domain): void {
    const pre = selHook?.snapshot(ecs);
    const source = trackDomain(ecs);
    setTrackDomain(ecs, target);
    record(
        h,
        { apply: () => setTrackDomain(ecs, target), reverse: () => setTrackDomain(ecs, source) },
        pre,
    );
}

// ── lane gestures ───────────────────────────────────────────────────────────────
//
// The authored verbs, one per gesture class the timeline performs, all of them over `track.ts`'s
// lane setters — which are the only authored writers, so a gesture never touches a column
// itself (`tests/purity.test.ts` is the census). Structural verbs (`addRecord`, `removeRecord`)
// bracket internally and land one entry; continuous verbs open with `begin*`, let the caller
// write through the setter every frame, and coalesce on `commit` (or revert on `cancel`).
//
// A refusal is the setter's, not the gesture's: an opener that would author an illegal span
// simply never lands, because the setter declines the write and the gesture's `same` reads no
// change. Every verb below returns the setter's own outcome so the caller can name the guard.

/** author one record in `lane` and land it as one undo entry. Returns the setter's outcome, so a
 *  refusal (overlap, floor, duplicate id) names its guard and nothing is recorded. */
export function addRecord(
    h: History,
    ecs: State,
    lane: Lane,
    row: Omit<LaneSegment, "id"> & { id?: number },
): LaneWrite {
    const pre = selHook?.snapshot(ecs);
    const write = createRecord(ecs, lane, row);
    if (write.id === null) return write;
    const id = write.id;
    const landed: LaneSegment = { ...row, id };
    record(
        h,
        {
            // the id travels with the entry, so a redo re-spawns the SAME record a selection
            // snapshot or a later edit addresses — an allocator-fresh id would alias.
            apply: () => void createRecord(ecs, lane, landed),
            reverse: () => void deleteRecord(ecs, id),
        },
        pre,
    );
    return write;
}

/** delete one record and land it as one undo entry. False when there was no such record. */
export function removeRecord(h: History, ecs: State, id: number): boolean {
    const found = recordOf(ecs, id);
    if (!found) return false;
    const pre = selHook?.snapshot(ecs);
    const { lane, row } = found;
    if (!deleteRecord(ecs, id)) return false;
    record(
        h,
        {
            apply: () => void deleteRecord(ecs, id),
            reverse: () => void createRecord(ecs, lane, row),
        },
        pre,
    );
    return true;
}

/** open a gesture on one of a record's two handles — the value chip drag or typed edit. The
 *  snapshot carries handle OWNERSHIP as well as the value: disowning an entry (`undefined`) is
 *  an authoring outcome, so undo has to put the ownership back, not just a number. */
export function beginHandle(ecs: State, id: number, which: "entry" | "exit"): void {
    begin<{ value: number | undefined }>(
        () => {
            const found = recordOf(ecs, id);
            if (!found) return undefined;
            return { value: which === "exit" ? found.row.exit : found.row.entry };
        },
        (st) => void setRecordHandle(ecs, id, which, st.value),
        (a, b) => a.value === b.value,
    );
}

/** open a gesture on a record's span. One opener for the two span gestures the timeline drives —
 *  {@link beginEdge}'s resize and {@link beginBody}'s move — because both write exactly the two
 *  columns `setRecordSpan` owns, so they snapshot and restore the same state. */
function beginSpan(ecs: State, id: number): void {
    begin<{ start: number; end: number }>(
        () => {
            const found = recordOf(ecs, id);
            if (!found) return undefined;
            return { start: found.row.start, end: found.row.end };
        },
        (st) => void setRecordSpan(ecs, id, st.start, st.end),
        (a, b) => a.start === b.start && a.end === b.end,
    );
}

/** open an edge drag: one end of the span moves, the other holds (resize). */
export function beginEdge(ecs: State, id: number): void {
    beginSpan(ecs, id);
}

/** open a body drag: both ends move together (move). */
export function beginBody(ecs: State, id: number): void {
    beginSpan(ecs, id);
}

/** land a record's easing tag as one undo entry — a chip click is a single write, never a drag. */
export function setEase(h: History, ecs: State, id: number, ease: Easing): LaneWrite {
    const found = recordOf(ecs, id);
    if (!found) return setRecordEase(ecs, id, ease); // the setter owns the not-found refusal
    const before = found.row.ease as Easing;
    const write = setRecordEase(ecs, id, ease);
    if (write.id === null || before === ease) return write;
    record(h, {
        apply: () => void setRecordEase(ecs, id, ease),
        reverse: () => void setRecordEase(ecs, id, before),
    });
    return write;
}

/** open a gesture on the ruler's end handle. The snapshot is the raw `end` COLUMN, so unpinning
 *  (writing 0, the follow rule) undoes back to the pinned number rather than to whatever the
 *  content happened to resolve to. A pin below a lane's content is `setEnd`'s refusal: the write
 *  never lands, so the gesture reads no change and records nothing. */
export function beginEnd(ecs: State): void {
    begin<{ end: number }>(
        () => (trackEntity(ecs) === null ? undefined : { end: endColumn(ecs) }),
        (st) => void setEnd(ecs, st.end),
        (a, b) => a.end === b.end,
    );
}

/** land a lane-order swap as one undo entry. The snapshot is the raw `order` COLUMN, not the
 *  resolved priority: an absent column and the default written out are different documents, so
 *  undoing the first swap on a fresh track has to restore ABSENCE. A non-permutation is
 *  `setOrder`'s refusal. */
export function setOrder(h: History, ecs: State, order: readonly Lane[]): LaneRefusal[] {
    const column = orderColumn(ecs);
    const before = column === 0 ? null : laneOrderOf(ecs);
    const refusals = writeLaneOrder(ecs, order);
    if (refusals.length > 0) return refusals;
    const after = laneOrderOf(ecs);
    if (orderColumn(ecs) === column) return refusals;
    record(h, {
        apply: () => void writeLaneOrder(ecs, after),
        reverse: () => void writeLaneOrder(ecs, before),
    });
    return refusals;
}

/** open a gesture on the track's start speed. Below {@link MIN_V0} is `setV0`'s refusal. */
export function beginV0(ecs: State): void {
    begin<{ v0: number }>(
        () => (trackEntity(ecs) === null ? undefined : { v0: entrySpeed(ecs) }),
        (st) => void setV0(ecs, st.v0),
        (a, b) => a.v0 === b.v0,
    );
}
