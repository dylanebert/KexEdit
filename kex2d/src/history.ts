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
import { collinear, type Easing, segmentSeed } from "./profile";
import type { Domain, Entry as TrackEntry } from "./section";
import {
    applyConvert,
    applyConvertGeo,
    appendSection as appendSectionTrack,
    clearForceTangentSide,
    convertSection as flipSectionKind,
    createForcePoint,
    deleteSection as deleteSectionTrack,
    destroyForce,
    extend,
    forceEase,
    type ForcePointState,
    forcePointState,
    forceTangent,
    Handle,
    handleAt,
    handleTangent,
    type NodeState,
    nextForce,
    nodeSnapshot,
    removeTrailingHandle,
    resetSection as resetSectionKind,
    resetNode,
    restoreAll,
    restoreForcePoint,
    restoreNodes,
    restoreSection,
    sameForceTangent,
    sameForcePoint,
    sameNodes,
    SectionKind,
    sections,
    type SectionSnapshot,
    seedTangent,
    setTangent,
    type SectionLengthState,
    sectionLengthState,
    setForceEase as writeForceEase,
    setForcePoint,
    setForceTangent,
    setSectionLength,
    setStickyLen,
    snapshotAll,
    snapshotSection,
    stampProvenance,
    type SolvedForce,
    type SolvedGeo,
    spawnForce,
    spawnStrip,
    createStrip as createStripTrack,
    destroyStrip,
    type StripState,
    stripState,
    restoreStrip,
    createOneShot as createOneShotTrack,
    destroyOneShot,
    entryOneShot,
    setOneShotValue,
    spawnOneShot,
    createStripKeyframe as createStripKf,
    destroyStripKeyframe,
    spawnStripKeyframe,
    restoreStripKeyframe,
    stripKeyframeState,
    type StripKeyframeState,
    setTrackDomain,
    trackDomain,
    type TrackFrictionState,
    trackFrictionState,
    setTrackFriction,
    type TrackResistanceState,
    trackResistanceState,
    setTrackResistance,
} from "./track";
import { alignTangent, mirrorTangent, TangentMode } from "./spline";
import { retargetMode } from "./timeline";

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

// ── the sandbox redirect (kex2d-optimize-mode stage 7) ────────────────────────────
// while an pin mode is open, EVERY recording lands in the mode's sandbox history instead of
// the outer stack — structural containment (belt-and-suspenders with the editing lockdown: an
// edit that slipped a guard still can't touch outer history). the editor sets it on mode open
// and clears it on close (`beginPin`/`endPin`); the one outer record while a mode is
// open — the Solve landing — runs after the close, so it lands outer by ordering.
let redirect: History | null = null;
export function redirectHistory(h: History | null): void {
    redirect = h;
    resumed = false;
}

// whether the open sandbox was RESUMED by undoing a landed Solve (the landing's own `enter`
// closure marks it): a redo at the sandbox's end then falls through to the outer redo — the
// re-land — so Ctrl+Shift+Z right after the reopening Ctrl+Z does what the sandbox contract
// promises ("redo re-lands and closes"). a NEW in-mode edit forks the experiment and clears the
// offer (`record`, the same edit-invalidates-redo law); in-mode undo/redo of the restored
// entries keep it, so walking the resumed experiment and returning to its end still re-lands.
let resumed = false;
export function markResumedLanding(): void {
    resumed = true;
}
export function resumedLanding(): boolean {
    return resumed;
}

/** push an already-applied command (the do-path mutated live data first), with the pre-command
 *  selection snapshot (`undefined` for a gesture, which leaves the selection alone). */
export function record(h: History, cmd: Command, pre?: unknown): void {
    const t = redirect ?? h;
    if (t === redirect) resumed = false; // a new in-mode edit forks off the re-land offer
    t.undo.push({ cmd, pre });
    // the redirect target (a sandbox) is EXEMPT from eviction: its Exit discards by replaying
    // reverses and its landing freezes the stacks whole, so evicting an entry silently breaks
    // both byte-identity guarantees (the stage-4 eviction hazard, resurfaced by the close
    // review). a sandbox is bounded by its mode's lifetime — it grows, then dies with the mode.
    if (t !== redirect && t.undo.length > MAX_UNDO) t.undo.shift();
    t.redo.length = 0; // a new edit invalidates the redo branch
}

/** push an already-applied command onto `h` DIRECTLY, bypassing any live redirect — the landing
 *  seam: a Solve's outcome entry belongs to the outer history even though a sandbox is (or was
 *  just) the redirect target. structural, so the guarantee doesn't hang on call ordering between
 *  the mode close and the record (the close-review's template hazard). */
export function recordOuter(h: History, cmd: Command, pre?: unknown): void {
    h.undo.push({ cmd, pre });
    if (h.undo.length > MAX_UNDO) h.undo.shift();
    h.redo.length = 0;
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

/** trim a section's trailing node, recording an undoable remove. promotion touches nothing
 *  (the promoted tip keeps its authored tangent AND its frozen `theta` — deletion never
 *  re-heads); the command captures the whole section before/after (pose + heading + the
 *  trimmed node's tangent). no-op below the two-node floor (records nothing, returns false). */
export function trimTrack(h: History, ecs: State, section: number): boolean {
    const pre = selHook?.snapshot(ecs); // the tip being trimmed — captured before it's destroyed
    const before = snapshotSection(ecs, section);
    if (!removeTrailingHandle(ecs, section)) return false;
    const after = snapshotSection(ecs, section);
    record(h, restoreCommand(ecs, before, after, restoreSection), pre);
    return true;
}

/** Reset a node to its CREATION state as one undoable entry (`track.resetNode`: position
 *  re-created at the default-chord continuation + tangents cleared to `Auto`; node 0 the tangent
 *  clear alone — its position isn't authorable). `stitch` is the downstream node-0 eid coincident
 *  with `tip` when `tip` is a geo→geo boundary (the "one node, stitched at the UI" view —
 *  kex2d-geo-ux): the boundary is one node, so the entry re-creates the tip AND clears the
 *  downstream node-0 half; the downstream section rides the moved exit rigidly (the
 *  rigid-placement invariant), so the boundary coincidence holds by construction. `null` is the
 *  plain single-node reset. The affected sections (one or two) go in one command, so a single undo
 *  restores every half; a reset that changes nothing (the node already sits at creation state)
 *  records nothing. Uses `restoreNodes` (writes by stable order, no eid recycle), matching the
 *  tangent-edit gesture. */
export function resetNodes(h: History, ecs: State, tip: number, stitch: number | null): void {
    const pre = selHook?.snapshot(ecs);
    const secs = [Handle.section.get(tip)];
    if (stitch !== null && !secs.includes(Handle.section.get(stitch)))
        secs.push(Handle.section.get(stitch));
    const before = secs.map((s) => nodeSnapshot(ecs, s));
    resetNode(ecs, Handle.section.get(tip), Handle.order.get(tip));
    if (stitch !== null) resetNode(ecs, Handle.section.get(stitch), Handle.order.get(stitch));
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

/** open a gesture on a MULTI-node move (the per-node polar-delta group drag / nudge), snapshotting
 *  every affected section's pose in `sections` order. commit coalesces the live writes into one
 *  entry over the whole affected set; the no-op test is that no section's nodes changed, so a click
 *  or a nudge back to start records nothing. the size-1 case is `beginMove`. */
export function beginMoves(ecs: State, sections: readonly number[]): void {
    begin(
        () => sections.map((s) => nodeSnapshot(ecs, s)),
        (snaps: NodeState[][]) => {
            for (let i = 0; i < sections.length; i++) restoreNodes(ecs, sections[i], snaps[i]);
        },
        (a: NodeState[][], b: NodeState[][]) =>
            a.length === b.length && a.every((s, i) => sameNodes(s, b[i])),
    );
}

/** trim a section's `k` trailing nodes as ONE undoable entry (the geo multi-delete — the suffix run
 *  the enablement predicate cleared: `suffixRun`). `removeTrailingHandle` floors at the two nodes a
 *  section needs, so it stops early rather than over-trim; the whole-section snapshot pair collapses
 *  all `k` removes into a single restore, so undo brings back every trimmed node (and its selection,
 *  re-resolved by stable (section, order) at the stack layer). no-op (records nothing) when nothing
 *  was removed. returns true when at least one node was trimmed. */
export function trimSuffix(h: History, ecs: State, section: number, k: number): boolean {
    const pre = selHook?.snapshot(ecs); // the selected SET — captured before any node is destroyed
    const before = snapshotSection(ecs, section);
    let removed = 0;
    for (let i = 0; i < k; i++) {
        if (!removeTrailingHandle(ecs, section)) break;
        removed++;
    }
    if (removed === 0) return false;
    const after = snapshotSection(ecs, section);
    record(h, restoreCommand(ecs, before, after, restoreSection), pre);
    return true;
}

/** Reset a SET of nodes to creation state as ONE undoable entry (the bulk Reset over a
 *  multi-selection) — the sort GROUPS by section (its stable id, not chain `Section.order`) and
 *  ascends `order` WITHIN each group, which is the only ordering `resetNode` reads: it re-creates
 *  a node against its own section's `order − 1` predecessor and nothing else, so cross-section
 *  order is unobservable and the section key needs no `Section.order` lookup. Within a section
 *  each member is therefore computed against its already-reset predecessor: a bulk suffix reset is
 *  byte-equivalent to deleting the suffix and re-extending fresh. unlike the single
 *  `resetNodes` it doesn't couple a boundary stitch (a bulk reset resets each member's own
 *  half); records nothing when no member changed. */
export function resetNodesBulk(
    h: History,
    ecs: State,
    members: readonly { section: number; order: number }[],
): void {
    const pre = selHook?.snapshot(ecs);
    const sorted = [...members].sort((a, b) => a.section - b.section || a.order - b.order);
    const secs = [...new Set(sorted.map((m) => m.section))];
    const before = secs.map((s) => nodeSnapshot(ecs, s));
    for (const m of sorted) resetNode(ecs, m.section, m.order);
    const after = secs.map((s) => nodeSnapshot(ecs, s));
    if (secs.every((_, i) => sameNodes(before[i], after[i]))) return; // nothing changed
    const restore = (snap: NodeState[][]): void => {
        for (let i = 0; i < secs.length; i++) restoreNodes(ecs, secs[i], snap[i]);
    };
    record(h, { apply: () => restore(after), reverse: () => restore(before) }, pre);
}

/** set a SET of nodes' tangent MODE as ONE undoable entry (the bulk Tangents ▸ over a
 *  multi-selection) — each member seeded from the arc rule when live then re-collinearized to the
 *  mode (`Mirror`/`Aligned` recouple, `Free` relabels), exactly the per-node `pickMode` move, one
 *  command over the affected sections. picking `Aligned` on a live-inferred member is a no-op (it
 *  already displays Aligned — no stamp); records nothing when no member changed. */
export function setTangentModes(
    h: History,
    ecs: State,
    members: readonly { section: number; order: number }[],
    mode: TangentMode,
): void {
    const pre = selHook?.snapshot(ecs);
    const secs = [...new Set(members.map((m) => m.section))];
    const before = secs.map((s) => nodeSnapshot(ecs, s));
    for (const m of members) {
        const cur = handleTangent(ecs, m.section, m.order);
        if (cur === undefined && mode === TangentMode.Aligned) continue; // inferred already Aligned
        const base = cur ?? seedTangent(ecs, m.section, m.order, mode);
        if (!base) continue;
        const next =
            mode === TangentMode.Mirror
                ? mirrorTangent(base)
                : mode === TangentMode.Aligned
                  ? alignTangent(base)
                  : { ...base, mode: TangentMode.Free };
        setTangent(ecs, m.section, m.order, next);
    }
    const after = secs.map((s) => nodeSnapshot(ecs, s));
    if (secs.every((_, i) => sameNodes(before[i], after[i]))) return; // nothing changed
    const restore = (snap: NodeState[][]): void => {
        for (let i = 0; i < secs.length; i++) restoreNodes(ecs, secs[i], snap[i]);
    };
    record(h, { apply: () => restore(after), reverse: () => restore(before) }, pre);
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

/** delete a SET of force points by id as ONE undoable entry (the bulk delete — force multi-delete
 *  is unconditional). undo re-spawns them all verbatim into their original sections; ids already
 *  gone are skipped, and nothing records when the set is empty. a single-id array (`[id]`) is the
 *  size-1 case — deleting one point. */
export function deleteForces(h: History, ecs: State, ids: readonly number[]): void {
    const pre = selHook?.snapshot(ecs); // the selected SET — captured before any point is destroyed
    const sts: ForcePointState[] = [];
    for (const id of ids) {
        const st = forcePointState(ecs, id);
        if (st) sts.push(st);
    }
    if (sts.length === 0) return;
    const drop = (): void => {
        for (const st of sts) destroyForce(ecs, st.id);
    };
    drop();
    record(
        h,
        {
            apply: drop,
            reverse: () => {
                for (const st of sts)
                    spawnForce(ecs, st.section, st.id, st.s, st.g, st.ease, st.tangent);
            },
        },
        pre,
    );
}

/** open a gesture on a force-point drag (or an inline field edit), snapshotting the
 *  point's full state. commit coalesces the live writes into one entry; the no-op test is
 *  {@link sameForcePoint}, field-wise over the whole snapshot — exhaustive by type, so the next
 *  column added to `ForcePointState` can't be silently dropped from the comparison. */
export function beginForceMove(ecs: State, id: number): void {
    begin(
        () => forcePointState(ecs, id),
        (st: ForcePointState) => restoreForcePoint(ecs, st),
        sameForcePoint,
    );
}

/** open a gesture on a MULTI force-point move (the shared-delta bulk drag / arrow-nudge),
 *  snapshotting every member's full state in `ids` order. commit coalesces the live writes into
 *  one entry; the no-op test is {@link sameForcePoint} per member (see `beginForceMove` for why it
 *  is the whole snapshot and not `s`/`g`), so a click or a nudge back to start records nothing while
 *  a drag that cleared a provenance bit does. the size-1 case is `beginForceMove`. */
export function beginForceMoves(ecs: State, ids: readonly number[]): void {
    begin(
        () => {
            const sts: ForcePointState[] = [];
            for (const id of ids) {
                const st = forcePointState(ecs, id);
                if (st) sts.push(st);
            }
            return sts.length ? sts : undefined;
        },
        (sts: ForcePointState[]) => {
            for (const st of sts) restoreForcePoint(ecs, st);
        },
        (a: ForcePointState[], b: ForcePointState[]) =>
            a.length === b.length && a.every((s, i) => sameForcePoint(s, b[i])),
    );
}

// ── velocity strips ────────────────────────────────────────────────────────────

/** author a track-global velocity strip over `[start, end)` at `value`, recording an
 *  undoable add — `createForce`'s span-shaped twin. The overlap guard lives in
 *  `track.createStrip` itself, so a refused (overlapping) span records nothing and
 *  returns `null`. The id is allocated once; undo destroys by it and redo re-spawns
 *  verbatim, keyframes included — `track.createStrip` seeds two keyframes at `start`/`end`
 *  (S4), so a redo has to replant them too, not only the strip row. `destroyStrip` already
 *  destroys a strip's keyframes as children, so the undo (reverse) side needs no change. */
export function addStrip(
    h: History,
    ecs: State,
    start: number,
    end: number,
    value: number,
): number | null {
    const pre = selHook?.snapshot(ecs);
    const id = createStripTrack(ecs, start, end, value);
    if (id === null) return null;
    const st = stripState(ecs, id) as StripState;
    record(
        h,
        {
            apply: () => {
                spawnStrip(ecs, id, start, end, value);
                for (const k of st.kfs) spawnStripKeyframe(ecs, id, k.id, k.s, k.v);
            },
            reverse: () => destroyStrip(ecs, id),
        },
        pre,
    );
    return id;
}

/** delete a SET of velocity strips by id as ONE undoable entry — `deleteForces`' twin.
 *  undo re-spawns them all verbatim, keyframes included (`StripState.kfs`, S4 — every
 *  strip now carries at least its two seeded keyframes, so losing them on undo is the
 *  common case, not an edge one); ids already gone are skipped, and nothing records when
 *  the set is empty. */
export function deleteStrips(h: History, ecs: State, ids: readonly number[]): void {
    const pre = selHook?.snapshot(ecs);
    const sts: StripState[] = [];
    for (const id of ids) {
        const st = stripState(ecs, id);
        if (st) sts.push(st);
    }
    if (sts.length === 0) return;
    for (const st of sts) destroyStrip(ecs, st.id);
    record(
        h,
        {
            apply: () => {
                for (const st of sts) destroyStrip(ecs, st.id);
            },
            reverse: () => {
                for (const st of sts) {
                    spawnStrip(ecs, st.id, st.start, st.end, st.value);
                    for (const k of st.kfs) spawnStripKeyframe(ecs, st.id, k.id, k.s, k.v);
                }
            },
        },
        pre,
    );
}

// ── the track-start one-shot (S3, its own structurally distinct point kind) ────────────

/** author the track-start one-shot, recording an undoable add — `addStrip`'s point-kind
 *  twin. The id is allocated once; undo destroys by it and redo re-spawns verbatim. Real
 *  UI callers never take this when one already exists (`entryOneShot`'s "first hit wins"
 *  reading) — a right-click "Add initial velocity" row is only enabled when none does. */
export function addOneShot(h: History, ecs: State, value: number): number {
    const pre = selHook?.snapshot(ecs);
    const id = createOneShotTrack(ecs, value);
    const v = entryOneShot(ecs)?.value ?? value; // read back the floored (MIN_V0) value
    record(
        h,
        {
            apply: () => spawnOneShot(ecs, id, v),
            reverse: () => destroyOneShot(ecs, id),
        },
        pre,
    );
    return id;
}

/** delete the track-start one-shot by id, recording an undoable entry — `deleteStrips`'
 *  single-subject twin (there is only ever one to delete). a no-op (nothing recorded) when
 *  `id` is already gone. */
export function deleteOneShot(h: History, ecs: State, id: number): void {
    const pre = selHook?.snapshot(ecs);
    const os = entryOneShot(ecs);
    if (!os || os.id !== id) return;
    const value = os.value;
    destroyOneShot(ecs, id);
    record(
        h,
        {
            apply: () => destroyOneShot(ecs, id),
            reverse: () => spawnOneShot(ecs, id, value),
        },
        pre,
    );
}

/** open a gesture on the one-shot's inline value field edit (F5) — `beginForceMove`'s
 *  single-scalar twin: no position to snapshot, since the axis is LOCKED (the one-shot's
 *  `s` never moves, `setOneShotValue`'s own docblock). commit coalesces the live writes
 *  into one entry; a no-op edit (a click, a re-typed identical value) records nothing. */
export function beginOneShotMove(ecs: State, id: number): void {
    begin(
        () => {
            const os = entryOneShot(ecs);
            return os && os.id === id ? { id: os.id, value: os.value } : undefined;
        },
        (st: { id: number; value: number }) => setOneShotValue(ecs, st.id, st.value),
        (a: { id: number; value: number }, b: { id: number; value: number }) => a.value === b.value,
    );
}

/** open a gesture on a strip drag (create-drag, resize, body drag, or an inline field
 *  edit), snapshotting the strip's full state. commit coalesces the live writes into
 *  one entry; a no-move release records nothing (`beginForceMove`'s span-shaped twin).
 *  the UI writes through `track.setStrip`, whose own overlap guard applies to every
 *  live write this gesture makes. Non-sticking on a RESIZE (S3): `setStrip` never moves
 *  a keyframe on `start`/`end`, so `stripState`/`restoreStrip`'s `kfs` round-trip is a
 *  no-op over THAT gesture. A BODY drag is the exception (S5, F1): the caller carries
 *  every keyframe by the strip's own Δd alongside the `setStrip` write, so `kfs`' round-
 *  trip is what makes THIS gesture's undo restore the keyframes too, not a no-op — the
 *  no-op test (below) stays position/value only, which is exactly why it's correct here:
 *  a body drag always changes `start`/`end` when `kfs` changes, so a no-op `start`/`end`
 *  reading already implies no-op keyframes. */
export function beginStripMove(ecs: State, id: number): void {
    begin(
        () => stripState(ecs, id),
        (st: StripState) => restoreStrip(ecs, st),
        (a: StripState, b: StripState) =>
            a.start === b.start && a.end === b.end && a.value === b.value,
    );
}

// ── velocity-strip keyframes (T2: value in the graph) ──────────────────────────

/** author a new velocity keyframe on a strip, recording an undoable add — `createForce`'s
 *  strip-keyframe twin. The id is allocated once; undo destroys by it and redo re-spawns
 *  verbatim. `createStripKeyframe` clamps `s` to the strip's `[start, end]` extent; the
 *  redo callback must use the SAME clamped value, because `spawnStripKeyframe` does not
 *  clamp — so the clamped `s` is read back from the created keyframe and used in both
 *  the live write and the redo path. */
export function addStripKeyframe(
    h: History,
    ecs: State,
    stripId: number,
    s: number,
    v: number,
): number {
    const pre = selHook?.snapshot(ecs);
    const id = createStripKf(ecs, stripId, s, v);
    // read back the clamped s so the redo callback agrees with the create path
    const cs = stripKeyframeState(ecs, id)?.s ?? s;
    record(
        h,
        {
            apply: () => spawnStripKeyframe(ecs, stripId, id, cs, v),
            reverse: () => destroyStripKeyframe(ecs, id),
        },
        pre,
    );
    return id;
}

/** delete a velocity keyframe by stable id as one undoable entry. */
export function deleteStripKeyframe(h: History, ecs: State, id: number): void {
    const pre = selHook?.snapshot(ecs);
    const st = stripKeyframeState(ecs, id);
    if (!st) return;
    destroyStripKeyframe(ecs, id);
    record(
        h,
        {
            apply: () => destroyStripKeyframe(ecs, id),
            reverse: () => spawnStripKeyframe(ecs, st.strip, st.id, st.s, st.v),
        },
        pre,
    );
}

/** delete a SET of velocity keyframes by id as ONE undoable entry (`deleteForces`' strip-keyframe
 *  twin — S4's multi-select for strip keyframes). undo re-spawns them all verbatim onto their
 *  original strips; ids already gone are skipped, and nothing records when the set is empty. */
export function deleteStripKeyframes(h: History, ecs: State, ids: readonly number[]): void {
    const pre = selHook?.snapshot(ecs);
    const sts: StripKeyframeState[] = [];
    for (const id of ids) {
        const st = stripKeyframeState(ecs, id);
        if (st) sts.push(st);
    }
    if (sts.length === 0) return;
    for (const st of sts) destroyStripKeyframe(ecs, st.id);
    record(
        h,
        {
            apply: () => {
                for (const st of sts) destroyStripKeyframe(ecs, st.id);
            },
            reverse: () => {
                for (const st of sts) spawnStripKeyframe(ecs, st.strip, st.id, st.s, st.v);
            },
        },
        pre,
    );
}

/** Delete a mixed set of members across ALL kinds as ONE undoable entry (S3 repair: the
 *  general mixed-set Delete). The caller (`mixedSetDelete` in `acts.ts`) checks each kind's
 *  guard and builds the destruction callbacks; this function snapshots the whole track before
 *  and after, and records one command so a single undo restores everything the gesture removed
 *  across every kind. Uses `snapshotAll`/`restoreAll` — the section kind's existing whole-track
 *  capture — because per-kind captures overlap (`snapshotSection` includes forces, `snapshotAll`
 *  includes everything), so composing them would duplicate on restore. */
export function deleteMembers(h: History, ecs: State, ops: readonly (() => void)[]): boolean {
    if (ops.length === 0) return false;
    const pre = selHook?.snapshot(ecs);
    const before = snapshotAll(ecs);
    for (const op of ops) op();
    const after = snapshotAll(ecs);
    record(h, restoreCommand(ecs, before, after, restoreAll), pre);
    return true;
}

/** open a gesture on a strip-keyframe drag, snapshotting the keyframe's full state.
 *  commit coalesces the live writes into one entry; a no-move release records nothing.
 *  Restores through `restoreStripKeyframe` (the snapshot-restore writer, `setForcePoint`'s
 *  overlap-refusal docblock at `track.ts:2165` states why the live writer is wrong for
 *  restore: `setStripKeyframe` refuses a station another key already holds, which a
 *  multi-member gesture's own members can legitimately occupy mid-restore) rather than
 *  `spawnStripKeyframe` — the dragged keyframe's entity is never destroyed mid-gesture, so
 *  re-creating it on undo left a duplicate (S5, red-first witnessed: undo produced two rows
 *  sharing one stable id, and `entrySpeed` read the wrong one off the pair). */
export function beginStripKeyframeMove(ecs: State, id: number): void {
    begin(
        () => stripKeyframeState(ecs, id),
        (st: StripKeyframeState) => restoreStripKeyframe(ecs, st),
        (a: StripKeyframeState, b: StripKeyframeState) => a.s === b.s && a.v === b.v,
    );
}

/** open a gesture on a MULTI strip-keyframe move (the shared-delta bulk drag / arrow-nudge),
 *  snapshotting every member's full state in `ids` order. commit coalesces the live writes into
 *  one entry; the no-op test is per-member `s`/`v` equality. the size-1 case is
 *  `beginStripKeyframeMove`. (`beginForceMoves`'s strip-keyframe twin.) Restores through
 *  `restoreStripKeyframe`, not `setStripKeyframe`: the live writer's overlap refusal
 *  (`track.ts:1039`) is correct for a drag pausing at an occupied slot but wrong for a
 *  multi-member undo, whose members can be re-parking onto stations each other member is
 *  mid-transit through — a refusal there silently drops a member's position and the undo is
 *  no longer byte-identical (B2). */
export function beginStripKeyframeMoves(ecs: State, ids: readonly number[]): void {
    begin(
        () => {
            const sts: StripKeyframeState[] = [];
            for (const id of ids) {
                const st = stripKeyframeState(ecs, id);
                if (st) sts.push(st);
            }
            return sts.length ? sts : undefined;
        },
        (sts: StripKeyframeState[]) => {
            for (const st of sts) restoreStripKeyframe(ecs, st);
        },
        (a: StripKeyframeState[], b: StripKeyframeState[]) =>
            a.length === b.length && a.every((s, i) => s.s === b[i].s && s.v === b[i].v),
    );
}

/** begin a mixed-set keyframe drag gesture — S2's cross-kind co-selection means a drag can
 *  carry both force and strip keyframes in one history entry. one `begin()` call snapshots
 *  both kinds together, so a single undo restores all members of both kinds. */
export function beginKeyframeMoves(
    ecs: State,
    forceIds: readonly number[],
    stripKfIds: readonly number[],
): void {
    begin(
        () => {
            const fsts: ForcePointState[] = [];
            for (const id of forceIds) {
                const st = forcePointState(ecs, id);
                if (st) fsts.push(st);
            }
            const ssts: StripKeyframeState[] = [];
            for (const id of stripKfIds) {
                const st = stripKeyframeState(ecs, id);
                if (st) ssts.push(st);
            }
            if (fsts.length === 0 && ssts.length === 0) return undefined;
            return { forces: fsts, stripKfs: ssts };
        },
        (s: { forces: ForcePointState[]; stripKfs: StripKeyframeState[] }) => {
            for (const st of s.forces) restoreForcePoint(ecs, st);
            for (const st of s.stripKfs) restoreStripKeyframe(ecs, st);
        },
        (
            a: { forces: ForcePointState[]; stripKfs: StripKeyframeState[] },
            b: { forces: ForcePointState[]; stripKfs: StripKeyframeState[] },
        ) =>
            a.forces.length === b.forces.length &&
            a.forces.every((s, i) => sameForcePoint(s, b.forces[i])) &&
            a.stripKfs.length === b.stripKfs.length &&
            a.stripKfs.every((s, i) => s.s === b.stripKfs[i].s && s.v === b.stripKfs[i].v),
    );
}

/** record one undoable entry over the addressed segment's two bounding keyframes — the
 *  leading keyframe `id` and its successor `next` (if any) — after `mutate` has already
 *  run on the live data. the command restores both keyframes, so a single undo reverts
 *  the whole segment-scoped gesture; nothing records when neither keyframe changed. */
function recordSegment(h: History, ecs: State, id: number, mutate: () => void): void {
    const pre = selHook?.snapshot(ecs);
    const next = nextForce(ecs, id);
    const beforeA = forcePointState(ecs, id);
    if (!beforeA) return;
    const beforeB = next !== null ? forcePointState(ecs, next) : undefined;
    mutate();
    const afterA = forcePointState(ecs, id);
    const afterB = next !== null ? forcePointState(ecs, next) : undefined;
    if (afterA === undefined) return;
    const sameA = beforeA.ease === afterA.ease && sameForceTangent(beforeA.tangent, afterA.tangent);
    const sameB =
        beforeB === undefined ||
        afterB === undefined ||
        (beforeB.ease === afterB.ease && sameForceTangent(beforeB.tangent, afterB.tangent));
    if (sameA && sameB) return;
    const restore = (a: ForcePointState, b?: ForcePointState): void => {
        restoreForcePoint(ecs, a);
        if (b) restoreForcePoint(ecs, b);
    };
    record(
        h,
        { apply: () => restore(afterA, afterB), reverse: () => restore(beforeA, beforeB) },
        pre,
    );
}

/** apply a preset easing to every APPLICABLE (non-terminal) keyframe in `ids` as ONE undoable
 *  entry (the menu one-shot, the bulk Easing ▸ — AE/Unity bulk interpolation): each such
 *  keyframe's tag is set and its addressed segment's two bounding sides (its own out + the next
 *  keyframe's in) cleared back to the preset — this keyframe's out and the next keyframe's in,
 *  never this keyframe's in (which belongs to the preceding segment). choosing a named row is the
 *  way back up the layers, subsuming the old Reset. a terminal keyframe (governs no following
 *  segment) is skipped — the enablement grays those rows at the UI. records nothing when no
 *  applicable keyframe changed. a single-id array (`[id]`) is the size-1 case — one gesture over
 *  the addressed keyframe and its successor, exactly the menu's single-select pick. */
export function setForcesEase(h: History, ecs: State, ids: readonly number[], ease: Easing): void {
    const pre = selHook?.snapshot(ecs);
    // the affected keyframes: each applicable leading keyframe + the successor it re-eases (deduped),
    // so one command restores every touched keyframe.
    const affected = new Set<number>();
    for (const id of ids) {
        const next = nextForce(ecs, id);
        if (next === null) continue; // terminal — no segment to ease
        affected.add(id);
        affected.add(next);
    }
    if (affected.size === 0) return;
    const before: ForcePointState[] = [];
    for (const id of affected) {
        const st = forcePointState(ecs, id);
        if (st) before.push(st);
    }
    for (const id of ids) {
        const next = nextForce(ecs, id);
        if (next === null) continue;
        writeForceEase(ecs, id, ease);
        clearForceTangentSide(ecs, id, "out"); // the segment's leading (out) side
        clearForceTangentSide(ecs, next, "in"); // its trailing (in) side
    }
    const after = before.map((b) => forcePointState(ecs, b.id));
    if (
        before.every((b, i) => {
            const a = after[i];
            return a !== undefined && b.ease === a.ease && sameForceTangent(b.tangent, a.tangent);
        })
    )
        return; // nothing changed
    const restore = (states: (ForcePointState | undefined)[]): void => {
        for (const st of states) if (st) restoreForcePoint(ecs, st);
    };
    record(h, { apply: () => restore(after), reverse: () => restore(before) }, pre);
}

/** materialize the addressed segment's explicit handles from its current derived shape —
 *  this keyframe's out + the next keyframe's in, seeded so the curve never jumps (a Linear
 *  segment seeds chord-aligned; see `profile.segmentSeed`) — as one undoable entry. the
 *  UI (`chooseCustom`) pairs this with entering handle edit. a bounding side that is
 *  already explicit is left as-is; records nothing at a terminal keyframe (no segment). */
export function materializeCustom(h: History, ecs: State, id: number): void {
    recordSegment(h, ecs, id, () => {
        const next = nextForce(ecs, id);
        if (next === null) return;
        const a = forcePointState(ecs, id);
        const b = forcePointState(ecs, next);
        if (!a || !b) return;
        const pa = { s: a.s, g: a.g, ease: forceEase(ecs, id) };
        const pb = { s: b.s, g: b.g };
        // when a bounding side is already explicit, materializing the other must not claim a
        // collinearity the two sides don't have: store Aligned only when the resulting in/out
        // pair is collinear (a single-sided keyframe or a derived-flat pair qualifies), else
        // Free. never re-align the preserved side to force collinearity — that would jump a
        // handle (the Aligned ⟹ collinear invariant).
        const exA = forceTangent(ecs, id);
        if (exA?.out === undefined) {
            const out = segmentSeed(pa, pb, "out");
            setForceTangent(ecs, id, {
                mode: collinear(exA?.in, out) ? TangentMode.Aligned : TangentMode.Free,
                in: exA?.in,
                out,
            });
        }
        const exB = forceTangent(ecs, next);
        if (exB?.in === undefined) {
            const inn = segmentSeed(pa, pb, "in");
            setForceTangent(ecs, next, {
                mode: collinear(inn, exB?.out) ? TangentMode.Aligned : TangentMode.Free,
                in: inn,
                out: exB?.out,
            });
        }
    });
}

/** set a force keyframe's tangent MODE as one undoable entry (the Tangents ▸ menu one-shot,
 *  the geo `pickMode` analogue): reconcile the existing handle pair to the new mode retroactively
 *  (`retargetMode` — `Aligned`/`Mirror` re-collinearize in chart pixels, `Free` relabels), keeping
 *  the pair jump-consistent with `composeTangent`'s per-drag coupling. keyframe-scoped (the mode is
 *  a per-keyframe property); records nothing when the tangent is unchanged (picking the current
 *  mode). the menu only offers this on a keyframe that already holds explicit handles, so a derived
 *  keyframe (no mode to edit) never reaches it. `pxPerU`/`pyPerG` are the live chart axis scales. */
export function setForceTangentMode(
    h: History,
    ecs: State,
    id: number,
    mode: TangentMode,
    pxPerU: number,
    pyPerG: number,
): void {
    beginForceTangent(ecs, id);
    const cur = forceTangent(ecs, id);
    if (cur) setForceTangent(ecs, id, retargetMode(cur, mode, pxPerU, pyPerG));
    commit(h);
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

/** commit a `beginLength` extent-trim gesture: coalesce the drag into one undo entry
 *  (`commit`) AND, when `armed` (the gesture cleared its dead-zone latch), record the landed
 *  extent as the session's new sticky append default for FORCE sections in the track's ACTIVE
 *  domain (`track.setStickyLen` — a meters trim never becomes a seconds default, or vice versa).
 *  `armed=false` (a no-move release under the latch) commits bare — a click-vs-drag release
 *  must not overwrite the sticky value with the section's UNCHANGED extent. A solve landing
 *  never calls this (it commits through `solveForce`/`solveGeo`), so a converted section's
 *  realized extent never becomes the next append's default. */
export function commitLength(h: History, ecs: State, id: number, armed: boolean): void {
    if (armed) {
        const st = sectionLengthState(ecs, id);
        if (st) setStickyLen(SectionKind.Force, st.length, trackDomain(ecs));
    }
    commit(h);
}

/** commit a geo node's LENGTH adjust — the polar length manipulator's drag or its arrow nudge —
 *  the geo twin of `commitLength`: one undo entry (`commit`) plus, when `armed` (the gesture
 *  cleared its dead-zone latch, or a nudge — always armed, since a nudge always moves), the
 *  landed chord recorded as the session's sticky append length for geo (`track.setStickyLen`),
 *  so the next appended segment opens at the length just authored. `armed=false` (a no-move
 *  click release) commits bare — the chord is unchanged, so nothing to record. The chord is
 *  read section-local off the two nodes (rigid placement makes that the world chord too); a
 *  node with no predecessor has no chord and just commits. Only the length axis calls this —
 *  an angle adjust holds the chord fixed, so it has nothing to record. */
export function commitChord(h: History, ecs: State, eid: number, armed: boolean): void {
    if (armed) {
        const order = Handle.order.get(eid);
        const prev = order > 0 ? handleAt(ecs, Handle.section.get(eid), order - 1) : null;
        if (prev !== null) {
            setStickyLen(
                SectionKind.Geo,
                Math.hypot(
                    Handle.pos.x.get(eid) - Handle.pos.x.get(prev),
                    Handle.pos.y.get(eid) - Handle.pos.y.get(prev),
                ),
            );
        }
    }
    commit(h);
}

// ── friction / drag (Coulomb loss + quadratic drag coefficients) ───────────────

/** open a gesture on the track's friction field (scrub or typed edit), snapshotting
 *  `Track.friction`. `trackFrictionState` reads `undefined` both for a gone track and the
 *  in-mode lockdown (`track.trackEditable`), so `begin` refuses to open on either — the
 *  gesture-open suspenders to `setTrackFriction`'s own write-side belt. commit coalesces the
 *  live writes into one entry; a no-change release records nothing. */
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

/** reset a section to its own kind's default (the flat two-node seed / the two continuation
 *  keyframes), as one undoable entry — `convertSection`'s wrapper shape over the kind-held
 *  `track.resetSection`, so undo restores the pre-reset payload byte-identical: the safety
 *  that replaces a confirm dialog (the Reset idiom law, editor-ui.md Menus). */
export function resetSection(h: History, ecs: State, section: number): void {
    const pre = selHook?.snapshot(ecs);
    const before = snapshotSection(ecs, section);
    resetSectionKind(ecs, section);
    const after = snapshotSection(ecs, section);
    record(h, restoreCommand(ecs, before, after, restoreSection), pre);
}

/** land an invoked solve's document write as one undoable entry — the `snapshotSection` pair the
 *  destructive convert uses, so undo restores the pre-solve payload byte-identical. shared by
 *  both solve directions (`solveForce`/`solveGeo`): `apply` performs the direction's own write
 *  (`applyConvert`/`applyConvertGeo`), already computed pure and off-thread by the time either
 *  caller reaches here — this is the single moment either touches the document, which is what
 *  makes the command atomic without any rollback path. `stamp` (kex2d-provenance) reuses `before`
 *  — the pre-solve payload already captured here — as the provenance sidecar's payload; both
 *  directions pass it (`solveForce`'s geo→force landing, `solveGeo`'s force→geo landing), so
 *  either reverse convert has something to consult (`forcegeo.convertForce`'s
 *  `tryRestore`/`geoforce.convertGeo`'s own twin). */
function landSolve(
    h: History,
    ecs: State,
    section: number,
    apply: () => void,
    stamp: boolean,
): void {
    const pre = selHook?.snapshot(ecs);
    const before = snapshotSection(ecs, section);
    apply();
    const after = snapshotSection(ecs, section);
    if (stamp) stampProvenance(ecs, section, before);
    record(h, restoreCommand(ecs, before, after, restoreSection), pre);
}

/** land an invoked geo→force solve on a section (`geoforce.convertGeo` drives it) as one
 *  undoable entry. named direction-explicitly now that a force→geo twin (`solveGeo`) exists. */
export function solveForce(h: History, ecs: State, section: number, solved: SolvedForce): void {
    landSolve(h, ecs, section, () => applyConvert(ecs, section, solved), true);
}

/** land an invoked force→geo fit on a section (`forcegeo.convertForce` drives it) as one
 *  undoable entry — the observation-space twin of `solveForce`. `entry` is the section's own
 *  entry anchor at invoke time, the frame `applyConvertGeo` localizes the fit's nodes against.
 *  Stamps (kex2d-provenance stage 3): `before` is the pre-fit FORCE section, the payload a
 *  same-session geo→force convert restores verbatim once its own token + entry match. */
export function solveGeo(
    h: History,
    ecs: State,
    section: number,
    solved: SolvedGeo,
    entry: TrackEntry,
): void {
    landSolve(h, ecs, section, () => applyConvertGeo(ecs, section, solved, entry), true);
}

/** land an invoked pin-mode solve (`pin.ts` drives it) on a section as one
 *  undoable entry — the mode's own landing, sibling to `solveForce`/`solveGeo` but narrower: the
 *  kernel (`optimize.ts`) only ever rewrites free keys' `g`, so `writes` carries just those pairs
 *  (locked keys, `s`, easing, handles, length, and structure are the same values already there).
 *  The whole-section snapshot pair still brackets it, and there is no provenance stamp: this
 *  isn't a kind conversion, so there is nothing for a reverse convert to consult.
 *
 *  **The landing IS the mode close** (the sandbox contract, stage 7): Solve confirms
 *  and closes the mode, so the entry carries the mode transition alongside the write — redo
 *  re-closes (`mode.exit`), undo re-ENTERS the mode with its state restored (`mode.enter`). The
 *  closures are injected (this module never imports editor — the SelectionHook precedent), and
 *  the entry lands even when `writes` is empty: a zero-drift Solve still closes the mode, and
 *  that transition must sit on the stack or undo/redo would walk through mode states it can't
 *  reproduce. */
export function solvePin(
    h: History,
    ecs: State,
    section: number,
    writes: readonly { id: number; g: number }[],
    mode: { enter(): void; exit(): void },
): void {
    const pre = selHook?.snapshot(ecs);
    const before = snapshotSection(ecs, section);
    for (const w of writes) {
        const st = forcePointState(ecs, w.id);
        if (st) setForcePoint(ecs, w.id, st.s, w.g);
    }
    mode.exit();
    const after = snapshotSection(ecs, section);
    // recordOuter, structurally: the landing is the ONE outer entry a mode ever produces, and
    // it must land outer even if a redirect were still (or again) live — never by the accident
    // of `mode.exit()` having run first.
    recordOuter(
        h,
        {
            apply: () => {
                restoreSection(ecs, after);
                mode.exit();
            },
            reverse: () => {
                restoreSection(ecs, before);
                mode.enter();
            },
        },
        pre,
    );
}

/** land a section's stamped provenance verbatim as one undoable entry — the reverse convert's
 *  own short-circuit (kex2d-provenance stage 2), `landSolve`'s twin without a solve: `payload` IS
 *  the exact pre-solve `SectionSnapshot` a forward solve already captured (`stampProvenance`'s
 *  own second consumer, `track.ts`), so there is nothing to compute, only to restore
 *  (`restoreSection` is both the do-path and, via `restoreCommand`, the undo). `order` is read
 *  live rather than taken off the payload — the payload's own order is a stale reading from the
 *  forward landing, and the token+entry check that gates this call deliberately doesn't cover
 *  chain position (`sectionToken`'s own contract: reorder isn't content). No `stamp` argument:
 *  a restore isn't itself a new solve landing, so the sidecar is left as-is for the next real
 *  solve to overwrite. */
export function restoreProvenance(
    h: History,
    ecs: State,
    section: number,
    payload: SectionSnapshot,
): void {
    const pre = selHook?.snapshot(ecs);
    const before = snapshotSection(ecs, section);
    restoreSection(ecs, { ...payload, order: before.order });
    const after = snapshotSection(ecs, section);
    record(h, restoreCommand(ecs, before, after, restoreSection), pre);
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

// ── structural ops (append / delete) ──────────────────────────
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

/** delete a SET of sections by id as ONE undoable entry (the bulk Delete — Premiere multi-clip).
 *  guards the last-section floor: refuses (records nothing, returns false) when the set is EVERY
 *  section, since one must always survive — the same floor `deleteSection` enforces per-call, lifted
 *  to the set so a partial bulk delete can't stop one section short of empty (`sectionsDeletable`,
 *  `controls.ts`, is the UI's matching enablement predicate). undo respawns every removed section
 *  verbatim (whole-track snapshot — a delete reorders every downstream section). the size-1 case is
 *  `removeSection`. */
export function removeSections(h: History, ecs: State, ids: readonly number[]): boolean {
    const targets = new Set(ids);
    if (targets.size === 0 || targets.size >= sections(ecs).length) return false;
    const pre = selHook?.snapshot(ecs);
    const before = snapshotAll(ecs);
    for (const id of targets) deleteSectionTrack(ecs, id);
    const after = snapshotAll(ecs);
    record(h, restoreCommand(ecs, before, after, restoreAll), pre);
    return true;
}
