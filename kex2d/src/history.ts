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
import { editor } from "./editor";
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
    handleAt,
    joinNext,
    type NodeState,
    nodeSnapshot,
    removeTrailingHandle,
    restoreAll,
    restoreNodes,
    restoreSection,
    sameNodes,
    Section,
    SectionKind,
    sectionAt,
    type SectionLengthState,
    sectionLengthState,
    setForcePoint,
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

export interface History {
    undo: Command[];
    redo: Command[];
}

const MAX_UNDO = 256;

export function createHistory(): History {
    return { undo: [], redo: [] };
}

/** the app's single history. tests build their own via `createHistory`. */
export const history = createHistory();

/** push an already-applied command (the do-path mutated live data first). */
export function record(h: History, cmd: Command): void {
    h.undo.push(cmd);
    if (h.undo.length > MAX_UNDO) h.undo.shift();
    h.redo.length = 0; // a new edit invalidates the redo branch
}

export function undo(h: History): void {
    const cmd = h.undo.pop();
    if (!cmd) return;
    cmd.reverse();
    h.redo.push(cmd);
}

export function redo(h: History): void {
    const cmd = h.redo.pop();
    if (!cmd) return;
    cmd.apply();
    h.undo.push(cmd);
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

// ── selection reconcile across a snapshot restore ────────────────────────────────
// `restoreSection`/`restoreAll` destroy and respawn a section's nodes, and the eid
// allocator recycles LIFO — so a raw eid held in `editor.selection` remaps to a
// DIFFERENT node after the restore (a trim-undo would land the selection on the entry
// anchor). keep the node selection valid by its stable (section, order) identity:
// capture it while the eid is still live, re-resolve it after the restore, and clear it
// (with the tangent-edit sub-mode layered on it) when the node no longer exists.
// force/section selections address by stable id, so a restore leaves them valid untouched.
// the node menu is closed outright: its rows (checked mode, enablement) are computed at open
// and are stale after a restore regardless of eid identity — the standard app behavior when
// the document changes under an open menu.

/** run a snapshot restore, re-resolving the editor's node selection by (section, order)
 *  across the eid recycle and closing the node menu. the one seam every
 *  `restoreSection`/`restoreAll` command flows through (`restoreCommand`), so the reconcile
 *  lives in exactly one place. */
function withReconcile(ecs: State, restore: () => void): void {
    const sel = editor.selection;
    const id =
        sel !== null && ecs.has(sel, Handle)
            ? { section: Handle.section.get(sel), order: Handle.order.get(sel) }
            : null;
    const editing = id !== null && editor.tangentEdit === sel;
    editor.nodeMenu = null; // stale contents after the restore; close, don't retarget
    restore();
    if (id === null) return; // no node selected — force/section/start survive by stable id
    const eid = handleAt(ecs, id.section, id.order);
    editor.selection = eid;
    editor.tangentEdit = eid !== null && editing ? eid : null;
}

/** build the undoable command for a snapshot restore pair (section-scoped or whole-track),
 *  wrapping both directions in the selection reconcile so undo AND redo keep the node
 *  selection anchored to its identity, not its eid. */
function restoreCommand<S>(
    ecs: State,
    before: S,
    after: S,
    restore: (ecs: State, snap: S) => void,
): Command {
    return {
        apply: () => withReconcile(ecs, () => restore(ecs, after)),
        reverse: () => withReconcile(ecs, () => restore(ecs, before)),
    };
}

// ── geo nodes ──────────────────────────────────────────────────────────────────

/** extend a section's chain (lay a node past the tip), recording an undoable add. `extend`
 *  stamps the old tip (Auto → frozen `Aligned`) as it becomes interior, so the command captures
 *  the whole section before/after — undo reverts both the added node and the stamp. returns the
 *  new node's eid. */
export function extendTrack(h: History, ecs: State, section: number): number {
    const before = snapshotSection(ecs, section);
    const eid = extend(ecs, section);
    const after = snapshotSection(ecs, section);
    record(h, restoreCommand(ecs, before, after, restoreSection));
    return eid;
}

/** trim a section's trailing node, recording an undoable remove. `removeTrailingHandle` reheads
 *  the promoted tip, so the command captures the whole section before/after (pose + heading +
 *  the trimmed node's tangent). no-op below the two-node floor (records nothing, returns false). */
export function trimTrack(h: History, ecs: State, section: number): boolean {
    const before = snapshotSection(ecs, section);
    if (!removeTrailingHandle(ecs, section)) return false;
    const after = snapshotSection(ecs, section);
    record(h, restoreCommand(ecs, before, after, restoreSection));
    return true;
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
    const id = createForcePoint(ecs, section, s, g);
    record(h, {
        apply: () => spawnForce(ecs, section, id, s, g),
        reverse: () => destroyForce(ecs, id),
    });
    return id;
}

/** delete a force point by id, recording an undoable remove — undo re-spawns it
 *  verbatim (into its original section). no-op if the id is already gone. */
export function deleteForce(h: History, ecs: State, id: number): void {
    const st = forcePointState(ecs, id);
    if (!st) return;
    destroyForce(ecs, id);
    record(h, {
        apply: () => destroyForce(ecs, id),
        reverse: () => spawnForce(ecs, st.section, st.id, st.s, st.g),
    });
}

/** open a gesture on a force-point drag (or an inline field edit), snapshotting the
 *  point's `s`/`g`. commit coalesces the live writes into one entry. */
export function beginForceMove(ecs: State, id: number): void {
    begin(
        () => forcePointState(ecs, id),
        (st: ForcePointState) => setForcePoint(ecs, st.id, st.s, st.g),
        (a: ForcePointState, b: ForcePointState) => a.s === b.s && a.g === b.g,
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
    const before = snapshotSection(ecs, section);
    flipSectionKind(ecs, section);
    const after = snapshotSection(ecs, section);
    record(h, restoreCommand(ecs, before, after, restoreSection));
}

// ── structural ops (append / split / join / delete) ──────────────────────────
// each wraps a whole-track snapshot pair — the op reorders sections and moves
// nodes/points across them, so a per-section restore can't capture it; the pair
// respawns every section's stored f32 verbatim, so undo/redo is byte-identical.

/** append a new section of `kind` at the chain end, recording one undoable entry.
 *  returns the new section id. */
export function appendSection(h: History, ecs: State, kind: SectionKind): number {
    const before = snapshotAll(ecs);
    const id = appendSectionTrack(ecs, kind);
    const after = snapshotAll(ecs);
    record(h, restoreCommand(ecs, before, after, restoreAll));
    return id;
}

/** split a section, recording one undoable entry. `at` is a geo section's interior
 *  node order or a force section's arclength s (the caller supplies the right one for
 *  the kind). no-op (records nothing) at a non-interior split point; returns the new
 *  tail section id, or null. */
export function splitSection(h: History, ecs: State, section: number, at: number): number | null {
    const eid = sectionAt(ecs, section);
    if (eid === null) return null;
    const before = snapshotAll(ecs);
    const id =
        Section.kind.get(eid) === SectionKind.Geo
            ? splitGeo(ecs, section, at)
            : splitForce(ecs, section, at);
    if (id === null) return null; // nothing split — don't record
    const after = snapshotAll(ecs);
    record(h, restoreCommand(ecs, before, after, restoreAll));
    return id;
}

/** join a section with its same-kind successor, recording one undoable entry. no-op
 *  (records nothing) when there's no successor or the kinds differ. returns true when
 *  joined. */
export function joinSection(h: History, ecs: State, section: number): boolean {
    const before = snapshotAll(ecs);
    if (!joinNext(ecs, section)) return false;
    const after = snapshotAll(ecs);
    record(h, restoreCommand(ecs, before, after, restoreAll));
    return true;
}

/** delete a section, recording one undoable entry. no-op (records nothing) at the
 *  last remaining section. returns true when deleted. */
export function removeSection(h: History, ecs: State, section: number): boolean {
    const before = snapshotAll(ecs);
    if (!deleteSectionTrack(ecs, section)) return false;
    const after = snapshotAll(ecs);
    record(h, restoreCommand(ecs, before, after, restoreAll));
    return true;
}
