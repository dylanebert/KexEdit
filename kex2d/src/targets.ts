/** span-scoped force targets — the authored demand side of the invoked scoped
 *  solver (spec `kex/specs/kex2d-force-targets.md` §4). the ECS edge over the
 *  pure `solve.ts` core: the `Target` component, the solve entry that assembles
 *  every active target's rows over the freed-node union, the drift readout, and
 *  the history commands that reach authored state only through undoable commits.
 *
 *  a `Target` is an inert authored object — a constant equality band ("hold X g")
 *  over an arclength span. it is **stored in arclength** (`s0`/`s1`, meters):
 *  time appears nowhere in the kernel (v is algebraic in y, t is a post-bake
 *  display), so s is the only domain the solver can hold fixed, and s-anchors
 *  stay feature-attached ("0g over THIS hill"). the solver never writes authored
 *  state outside an explicit commit — targets are inputs, node poses are the
 *  output, and both land on the undo stack as one entry. `id` is the stable
 *  authored identity undo/redo addresses (eids recycle across a delete→undo; ids
 *  never do — the `Handle.order` convention). */

import { f32, sparse, type State, u32 } from "@dylanebert/shallot";
import { begin, beginMove, commit, type History, record } from "./history";
import {
    bakeNodes,
    DEFAULT_WEIGHTS,
    sampleArc,
    samplesForArc,
    scopeForArc,
    solveTargets,
    spanMean,
    spanResidual,
    type SpanTarget,
} from "./solve";
import { chainCounts, type Node } from "./spline";
import {
    Handle,
    MAX_SAMPLES,
    type NodeState,
    nodeSnapshot,
    restoreNodes,
    sameNodes,
    sortedHandles,
    Track,
    V0,
} from "./track";

/** an authored force target on a track. `s0`/`s1` are the arclength span (m)
 *  from the track start — feature-attached, so it survives reshapes where a
 *  time anchor would migrate off the feature. `g` is the held normal force (g);
 *  `w` the fixed row weight (force is already in g, so the equality band is
 *  unit-weighted by tolerance). `id` is the stable authored identity undo/redo
 *  addresses. */
export const Target = {
    track: sparse(u32),
    id: sparse(u32),
    s0: sparse(f32),
    s1: sparse(f32),
    g: sparse(f32),
    w: sparse(f32),
};

/** the equality band's fixed weight — force rows at w=1 against the weak draft
 *  prior (`DEFAULT_WEIGHTS`, wPos/wTheta≈0.1), the stage-1 ratio. */
export const W_TARGET = 1;

/** drift readout threshold (g): below it the band-vs-curve gap is quiet (the
 *  chip shows no ⟳). half the documented ~0.1 g forces64-vs-display-bake
 *  centering gap — a smaller gap is not legible on the readout anyway. */
export const DRIFT_TOL = 0.05;

export interface TargetRow {
    eid: number;
    id: number;
    s0: number;
    s1: number;
    g: number;
    w: number;
}

/** every target on the track, sorted by span start. */
export function targetsFor(ecs: State, trackEid: number): TargetRow[] {
    const rows: TargetRow[] = [];
    for (const eid of ecs.query([Target])) {
        if (Target.track.get(eid) !== trackEid) continue;
        rows.push({
            eid,
            id: Target.id.get(eid),
            s0: Target.s0.get(eid),
            s1: Target.s1.get(eid),
            g: Target.g.get(eid),
            w: Target.w.get(eid),
        });
    }
    rows.sort((a, b) => a.s0 - b.s0);
    return rows;
}

/** resolve a target by its stable authored `id`, or null (undo/redo never holds
 *  eids — the `handleAt` convention). */
export function targetAt(ecs: State, id: number): number | null {
    for (const eid of ecs.query([Target])) {
        if (Target.id.get(eid) === id) return eid;
    }
    return null;
}

// monotone id source — never reused, even after a delete: history can re-spawn
// any deleted id, so a scan-the-live-set allocator would alias a fresh target
// with a restorable one (the eid-recycling bug, one level up).
let nextTargetId = 0;

/** re-create a target verbatim at an exact id/span/value — undo of a delete,
 *  redo of a create. returns the new eid. */
export function spawnTarget(
    ecs: State,
    id: number,
    trackEid: number,
    s0: number,
    s1: number,
    g: number,
    w: number,
): number {
    nextTargetId = Math.max(nextTargetId, id + 1);
    const eid = ecs.create();
    ecs.add(eid, Target);
    Target.track.set(eid, trackEid);
    Target.id.set(eid, id);
    Target.s0.set(eid, s0);
    Target.s1.set(eid, s1);
    Target.g.set(eid, g);
    Target.w.set(eid, w);
    return eid;
}

// ── the solve context: the current chain, frozen once per solve ──────────────

interface Context {
    /** the node chain in order (index k = Handle.order k). */
    nodes: Node[];
    /** frozen per-segment edge counts. */
    counts: number[];
    /** the frozen bake + its per-sample arclength. */
    b: ReturnType<typeof bakeNodes>;
    arc: Float64Array;
}

/** read the chain, freeze the sampling topology, bake once — the shared setup
 *  the solve, drift readout, and born value all map their spans against. null
 *  below the two-node floor. */
function context(ecs: State, trackEid: number): Context | null {
    const handles = sortedHandles(ecs);
    if (handles.length < 2) return null;
    const nodes: Node[] = handles.map((eid) => ({
        x: Handle.pos.x.get(eid),
        y: Handle.pos.y.get(eid),
        theta: Handle.theta.get(eid),
    }));
    const ds = Track.ds.get(trackEid);
    const { counts } = chainCounts(nodes, ds, MAX_SAMPLES);
    const b = bakeNodes(nodes, counts, V0);
    return { nodes, counts, b, arc: sampleArc(b) };
}

/** map an authored arclength target to the solver domain against a frozen bake:
 *  its interior sample-index span. */
function spanOf(ctx: Context, row: TargetRow): SpanTarget {
    const { i0, i1 } = samplesForArc(ctx.b, ctx.arc, row.s0, row.s1);
    return { i0, i1, g: row.g, w: row.w };
}

// ── the solve entry ──────────────────────────────────────────────────────────

export interface TrackSolve {
    /** the solved chain, indexed by node order (0 = anchor). */
    nodes: Node[];
    converged: boolean;
    iters: number;
}

/**
 * solve every active target on the track together: assemble all targets' force
 * rows over the union of their freed scopes and run one LM (the coupled case is
 * one system, not per-target). returns the solved chain, or null when there is
 * nothing to solve (no targets, sub-two-node chain, or every span degenerate).
 * pure read — the caller commits the poses through history, never this.
 */
export function solveTrack(ecs: State, trackEid: number): TrackSolve | null {
    const ctx = context(ecs, trackEid);
    if (!ctx) return null;
    const rows = targetsFor(ecs, trackEid);
    if (rows.length === 0) return null;

    const spans: SpanTarget[] = [];
    const scope = new Set<number>();
    for (const row of rows) {
        const freed = scopeForArc(ctx.b, ctx.arc, row.s0, row.s1);
        if (freed.length === 0) continue;
        spans.push(spanOf(ctx, row));
        for (const k of freed) scope.add(k);
    }
    if (spans.length === 0) return null;
    const freed = [...scope].sort((a, z) => a - z);

    const res = solveTargets(ctx.nodes, freed, ctx.counts, V0, spans, DEFAULT_WEIGHTS);
    return { nodes: res.nodes, converged: res.converged, iters: res.iters };
}

export interface Drift {
    id: number;
    /** the mean held force over the span interior (achieved-vs-target readout). */
    achieved: number;
    /** max |F − g| over the span interior (the band-vs-curve gap). */
    err: number;
    /** the gap is below the readout threshold — the chip is quiet. */
    satisfied: boolean;
}

/** per-target drift on the *current* baked geometry — the band-vs-curve gap the
 *  chip surfaces (and the ⟳ summon trigger). */
export function targetDrift(ecs: State, trackEid: number): Drift[] {
    const ctx = context(ecs, trackEid);
    if (!ctx) return [];
    return targetsFor(ecs, trackEid).map((row) => {
        const { achieved, err } = spanResidual(ctx.b, spanOf(ctx, row));
        return { id: row.id, achieved, err, satisfied: err < DRIFT_TOL };
    });
}

// ── history commands ─────────────────────────────────────────────────────────
// targets record onto the shared editor stack (the substrate is domain-agnostic;
// `history.ts` owns begin/commit/record). a target is addressed by stable `id`,
// spawned verbatim on undo/redo. the demand + re-solve gestures compose a target
// value change with node moves into one entry via the snapshot lifecycle.

/** write the solved chain back onto the live nodes by order. */
function applyChain(ecs: State, nodes: Node[]): void {
    const snap: NodeState[] = nodes.map((n, order) => ({ order, x: n.x, y: n.y, theta: n.theta }));
    restoreNodes(ecs, snap);
}

/** create a target over the arclength span [s0,s1], born satisfied at the span's
 *  current mean force (zero initial loss). records one undo entry; returns the
 *  new stable id. no-op (returns -1) below the two-node floor. */
export function createTarget(
    h: History,
    ecs: State,
    trackEid: number,
    s0: number,
    s1: number,
): number {
    const ctx = context(ecs, trackEid);
    if (!ctx) return -1;
    const { i0, i1 } = samplesForArc(ctx.b, ctx.arc, s0, s1);
    const g = spanMean(ctx.b, i0, i1);
    const id = nextTargetId;
    spawnTarget(ecs, id, trackEid, s0, s1, g, W_TARGET);
    record(h, {
        apply: () => spawnTarget(ecs, id, trackEid, s0, s1, g, W_TARGET),
        reverse: () => destroyTarget(ecs, id),
    });
    return id;
}

/** delete a target (geometry untouched), recording an undoable remove. */
export function deleteTarget(h: History, ecs: State, id: number): void {
    const eid = targetAt(ecs, id);
    if (eid === null) return;
    const trackEid = Target.track.get(eid);
    const s0 = Target.s0.get(eid);
    const s1 = Target.s1.get(eid);
    const g = Target.g.get(eid);
    const w = Target.w.get(eid);
    ecs.destroy(eid);
    record(h, {
        apply: () => destroyTarget(ecs, id),
        reverse: () => spawnTarget(ecs, id, trackEid, s0, s1, g, w),
    });
}

/** the demand gesture: set a target's value and let the solver deform the track,
 *  committed as **one** undo entry (target value + node moves). the batch form —
 *  set `g`, solve to convergence, commit; the live drag (stage 3) replaces the
 *  batch solve with per-frame RTI between the same begin/commit boundary. */
export function demandTarget(
    h: History,
    ecs: State,
    trackEid: number,
    id: number,
    g: number,
): void {
    beginDemand(ecs, trackEid);
    setTargetG(ecs, id, g);
    const solved = solveTrack(ecs, trackEid);
    if (solved) applyChain(ecs, solved.nodes);
    commit(h);
}

/** the summoned ⟳ re-solve: no target change, re-run the solve to pull the curve
 *  back onto its drifted bands. one undo entry (node moves only). */
export function resolveTarget(h: History, ecs: State, trackEid: number): void {
    beginMove(ecs); // snapshots the chain pose only — no target change
    const solved = solveTrack(ecs, trackEid);
    if (solved) applyChain(ecs, solved.nodes);
    commit(h);
}

/** open a demand gesture, snapshotting the target values + chain pose so the
 *  whole live drag+solve collapses to one entry. */
export function beginDemand(ecs: State, trackEid: number): void {
    begin(
        () => ({ targets: targetSnapshot(ecs, trackEid), nodes: nodeSnapshot(ecs) }),
        (s: DemandState) => {
            restoreTargets(ecs, s.targets);
            restoreNodes(ecs, s.nodes);
        },
        sameDemand,
    );
}

interface TargetState {
    id: number;
    g: number;
}
interface DemandState {
    targets: TargetState[];
    nodes: NodeState[];
}

function targetSnapshot(ecs: State, trackEid: number): TargetState[] {
    return targetsFor(ecs, trackEid).map((t) => ({ id: t.id, g: t.g }));
}

function restoreTargets(ecs: State, snap: TargetState[]): void {
    for (const s of snap) setTargetG(ecs, s.id, s.g);
}

function setTargetG(ecs: State, id: number, g: number): void {
    const eid = targetAt(ecs, id);
    if (eid !== null) Target.g.set(eid, g);
}

function destroyTarget(ecs: State, id: number): void {
    const eid = targetAt(ecs, id);
    if (eid !== null) ecs.destroy(eid);
}

function sameDemand(a: DemandState, b: DemandState): boolean {
    if (a.targets.length !== b.targets.length) return false;
    for (let i = 0; i < a.targets.length; i++) {
        const bi = b.targets.find((t) => t.id === a.targets[i].id);
        if (!bi || bi.g !== a.targets[i].g) return false;
    }
    return sameNodes(a.nodes, b.nodes);
}
