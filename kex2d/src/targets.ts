/** point force targets — the authored demand side of the invoked batch solver
 *  (spec `kex/specs/kex2d-force-targets.md` §3–§5). the ECS edge over the pure
 *  `solve.ts` core: the `Target` point component, the batch solve entry that
 *  assembles every target's force row over the freed-node union, the drift
 *  readout, and the history commands that reach authored state only through
 *  undoable commits.
 *
 *  a `Target` is inert authored data, always — "F_n = g at this spot". it is
 *  **stored in arclength** (`s`, meters from the track start): time appears
 *  nowhere in the kernel (v is algebraic in y, t is a post-bake display), so s
 *  is the only domain the solver can hold fixed, and s-anchors stay
 *  feature-attached ("0g at THIS crest"). between solves the app is inert —
 *  geometry never moves, nothing re-fits; drift is *displayed* (point-vs-curve
 *  gap), never chased. the solver runs only when summoned (`solveAll`) and
 *  reaches node poses through one undoable commit. `id` is the stable authored
 *  identity undo/redo addresses (eids recycle across a delete→undo; ids never
 *  do — the `Handle.order` convention). */

import { f32, sparse, type State, u32 } from "@dylanebert/shallot";
import { begin, beginMove, commit, type History, record } from "./history";
import {
    bakeNodes,
    DEFAULT_WEIGHTS,
    type PointTarget,
    pointResidual,
    sampleArc,
    sampleAtArc,
    scopeForPoint,
    solveTargets,
} from "./solve";
import { chainCounts, type Node } from "./spline";
import { arcToTime, type Mapping } from "./timeline";
import {
    bakeOut,
    Handle,
    MAX_SAMPLES,
    type NodeState,
    restoreNodes,
    samples,
    sortedHandles,
    Track,
    V0,
} from "./track";

/** an authored point force target on a track. `s` is the arclength (m) from
 *  the track start — feature-attached, so it survives reshapes where a time
 *  anchor would migrate off the feature. `g` is the demanded normal force (g).
 *  `id` is the stable authored identity undo/redo addresses. */
export const Target = {
    track: sparse(u32),
    id: sparse(u32),
    s: sparse(f32),
    g: sparse(f32),
};

/** the force row's fixed weight — w=1 against the weak draft prior
 *  (`DEFAULT_WEIGHTS`, wPos/wTheta≈0.1), the stage-1 ratio. */
const W_TARGET = 1;

/** drift readout threshold (g): below it the point-vs-curve gap is quiet (the
 *  marker sits on the curve). half the documented ~0.1 g forces64-vs-display-
 *  bake centering gap — a smaller gap is not legible on the readout anyway. */
const DRIFT_TOL = 0.05;

export interface TargetRow {
    eid: number;
    id: number;
    s: number;
    g: number;
}

/** every target on the track, sorted by arclength. */
export function targetsFor(ecs: State, trackEid: number): TargetRow[] {
    const rows: TargetRow[] = [];
    for (const eid of ecs.query([Target])) {
        if (Target.track.get(eid) !== trackEid) continue;
        rows.push({
            eid,
            id: Target.id.get(eid),
            s: Target.s.get(eid),
            g: Target.g.get(eid),
        });
    }
    rows.sort((a, b) => a.s - b.s);
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

/** re-create a target verbatim at an exact id/point/value — undo of a delete,
 *  redo of a create. returns the new eid. */
function spawnTarget(ecs: State, id: number, trackEid: number, s: number, g: number): number {
    nextTargetId = Math.max(nextTargetId, id + 1);
    const eid = ecs.create();
    ecs.add(eid, Target);
    Target.track.set(eid, trackEid);
    Target.id.set(eid, id);
    Target.s.set(eid, s);
    Target.g.set(eid, g);
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
 *  the solve and drift readout both map their points against. null below the
 *  two-node floor. */
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

/** map an authored arclength target to the solver domain against a frozen
 *  bake: one force row at the sample nearest s. */
function pointOf(ctx: Context, row: TargetRow): PointTarget {
    return { i: sampleAtArc(ctx.arc, ctx.b.n, row.s), g: row.g, w: W_TARGET };
}

// ── the solve entry ──────────────────────────────────────────────────────────

export interface TrackSolve {
    /** the solved chain, indexed by node order (0 = anchor). */
    nodes: Node[];
    converged: boolean;
    iters: number;
}

/**
 * solve every target on the track together: assemble all targets' force rows
 * over the union of their freed scopes and run one LM (the coupled case is one
 * system, not per-target). the prior anchors to the *current* geometry —
 * minimum deformation of what's there now (§3). returns the solved chain, or
 * null when there is nothing to solve (no targets or a sub-two-node chain).
 * pure read — the caller commits the poses through history, never this.
 */
export function solveTrack(ecs: State, trackEid: number): TrackSolve | null {
    const ctx = context(ecs, trackEid);
    if (!ctx) return null;
    const rows = targetsFor(ecs, trackEid);
    if (rows.length === 0) return null;

    const points: PointTarget[] = [];
    const scope = new Set<number>();
    for (const row of rows) {
        points.push(pointOf(ctx, row));
        for (const k of scopeForPoint(ctx.b, ctx.arc, row.s)) scope.add(k);
    }
    if (scope.size === 0) return null;
    const freed = [...scope].sort((a, z) => a - z);

    const res = solveTargets(ctx.nodes, freed, ctx.counts, V0, points, DEFAULT_WEIGHTS);
    return { nodes: res.nodes, converged: res.converged, iters: res.iters };
}

/** the freed node orders a summoned solve will move — the same scope union
 *  `solveTrack` builds, exposed for the Solve highlight flash (§5). pure read. */
export function trackScope(ecs: State, trackEid: number): number[] {
    const ctx = context(ecs, trackEid);
    if (!ctx) return [];
    const scope = new Set<number>();
    for (const row of targetsFor(ecs, trackEid)) {
        for (const k of scopeForPoint(ctx.b, ctx.arc, row.s)) scope.add(k);
    }
    return [...scope].sort((a, z) => a - z);
}

export interface Drift {
    id: number;
    /** the force the curve holds at the point's sample (achieved-vs-target). */
    achieved: number;
    /** |achieved − g| — the point-vs-curve gap. */
    err: number;
    /** the gap is below the readout threshold — the marker sits on the curve. */
    satisfied: boolean;
}

/** per-target drift on the *current* baked geometry — the point-vs-curve gap
 *  the marker surfaces (and the Solve-accent trigger). */
export function targetDrift(ecs: State, trackEid: number): Drift[] {
    const ctx = context(ecs, trackEid);
    if (!ctx) return [];
    return targetsFor(ecs, trackEid).map((row) => {
        const { achieved, err } = pointResidual(ctx.b, pointOf(ctx, row));
        return { id: row.id, achieved, err, satisfied: err < DRIFT_TOL };
    });
}

// ── display projection: arclength (stored) ↔ time (shown) ────────────────────

/** the per-sample arclength↔time table over the *display* bake (`samples` +
 *  `bakeOut`, the realized track the timeline draws). targets store arclength;
 *  the chart shows time, so a marker's x projects through this. built from the
 *  same node chain the solver bakes, so its arclength axis matches the
 *  solver's to rounding. null below the two-node floor. static between solves
 *  (no solve runs while editing), so no freeze machinery. */
export function trackMapping(trackEid: number): Mapping | null {
    const s = samples.get(trackEid);
    const out = bakeOut.get(trackEid);
    if (!s || !out) return null;
    const n = Track.count.get(trackEid);
    if (n < 2) return null;
    const arc = new Float64Array(n);
    for (let i = 1; i < n; i++)
        arc[i] = arc[i - 1] + Math.hypot(s.posX[i] - s.posX[i - 1], s.posY[i] - s.posY[i - 1]);
    const t = new Float64Array(n);
    for (let i = 0; i < n; i++) t[i] = out.t[i];
    return { arc, t, n };
}

/** a target projected for display: its demand, arclength, the time through
 *  `m`, and the live drift readout. the marker renders straight off this. */
export interface Marker {
    id: number;
    g: number;
    s: number;
    t: number;
    achieved: number;
    err: number;
    satisfied: boolean;
}

/** every target projected onto the timeline through the display mapping `m` —
 *  the marker render surface, sorted by arclength. */
export function targetMarkers(ecs: State, trackEid: number, m: Mapping): Marker[] {
    const rows = targetsFor(ecs, trackEid);
    if (rows.length === 0) return []; // skip the drift bake on the empty idle
    const drift = targetDrift(ecs, trackEid);
    return rows.map((row) => {
        const d = drift.find((x) => x.id === row.id);
        return {
            id: row.id,
            g: row.g,
            s: row.s,
            t: arcToTime(m, row.s),
            achieved: d?.achieved ?? row.g,
            err: d?.err ?? 0,
            satisfied: d?.satisfied ?? true,
        };
    });
}

// ── history commands ─────────────────────────────────────────────────────────
// targets record onto the shared editor stack (the substrate is domain-agnostic;
// `history.ts` owns begin/commit/record). a target is addressed by stable `id`,
// spawned verbatim on undo/redo. geometry never moves through these — only
// `solveAll` touches nodes, as its own entry.

/** write the solved chain back onto the live nodes by order. */
function applyChain(ecs: State, nodes: Node[]): void {
    const snap: NodeState[] = nodes.map((n, order) => ({ order, x: n.x, y: n.y, theta: n.theta }));
    restoreNodes(ecs, snap);
}

/** create a target born at exactly the clicked demand (s, g) — the click *is*
 *  the demand (spec golden path 1). records one undo entry; returns the new
 *  stable id. */
export function createTarget(
    h: History,
    ecs: State,
    trackEid: number,
    s: number,
    g: number,
): number {
    const id = nextTargetId;
    spawnTarget(ecs, id, trackEid, s, g);
    record(h, {
        apply: () => spawnTarget(ecs, id, trackEid, s, g),
        reverse: () => destroyTarget(ecs, id),
    });
    return id;
}

/** delete a target (geometry untouched), recording an undoable remove. */
export function deleteTarget(h: History, ecs: State, id: number): void {
    const eid = targetAt(ecs, id);
    if (eid === null) return;
    const trackEid = Target.track.get(eid);
    const s = Target.s.get(eid);
    const g = Target.g.get(eid);
    ecs.destroy(eid);
    record(h, {
        apply: () => destroyTarget(ecs, id),
        reverse: () => spawnTarget(ecs, id, trackEid, s, g),
    });
}

/** live-write a target's point during a marker drag — no solve, no history;
 *  inside an open `beginTargetMove` gesture. */
export function setTarget(ecs: State, id: number, s: number, g: number): void {
    const eid = targetAt(ecs, id);
    if (eid === null) return;
    Target.s.set(eid, s);
    Target.g.set(eid, g);
}

interface TargetState {
    s: number;
    g: number;
}

/** open a marker-drag gesture on target `id`: snapshot its (s, g) so the whole
 *  drag commits as one entry (`commit`) or rolls back (`cancel`). a click with
 *  no movement commits as a no-op — the `same` guard drops the entry. */
export function beginTargetMove(ecs: State, id: number): void {
    begin(
        (): TargetState | undefined => {
            const eid = targetAt(ecs, id);
            if (eid === null) return undefined; // target gone — open nothing
            return { s: Target.s.get(eid), g: Target.g.get(eid) };
        },
        (st: TargetState) => setTarget(ecs, id, st.s, st.g),
        (a: TargetState, b: TargetState) => a.s === b.s && a.g === b.g,
    );
}

/** the Solve invocation (§3): run the batch solve over all targets and commit
 *  the node moves as ONE undo entry (targets untouched). the prior re-anchors
 *  to current geometry. returns the solve result (null when nothing to solve;
 *  the no-op gesture then drops without recording). */
export function solveAll(h: History, ecs: State, trackEid: number): TrackSolve | null {
    beginMove(ecs); // snapshots the chain pose only — no target change
    const solved = solveTrack(ecs, trackEid);
    if (solved) applyChain(ecs, solved.nodes);
    commit(h);
    return solved;
}

function destroyTarget(ecs: State, id: number): void {
    const eid = targetAt(ecs, id);
    if (eid !== null) ecs.destroy(eid);
}
