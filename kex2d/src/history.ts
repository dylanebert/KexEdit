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
import type { Domain } from "./section";
import {
    setTrackDomain,
    setTrackFriction,
    setTrackResistance,
    trackDomain,
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
