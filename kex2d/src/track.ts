import { f32, type Plugin, sparse, type State, type System, u32, vec2 } from "@dylanebert/shallot";
import { forces, V_FLOOR, V_WARN } from "./bake";
import { constraintRev, hasConstraints, Pin, PosPin } from "./constraints";
import { type DraftInput, solveState, solveStep } from "./solve";
import { type Node, reflect, sampleChain } from "./spline";

/** per-track scalars. `count` is the total sample count (bake output, varies
 *  with the nodes). `ds` is the user's nominal target spacing (input to bake;
 *  per-edge actual ds lives in `bakeOut.ds`). the bake recovers each sample's
 *  θ from the sampled geometry; the node headings that *shape* the curve live
 *  on `Handle.theta`. */
export const Track = {
    count: sparse(u32),
    ds: sparse(f32),
};

type Samples = {
    posX: Float32Array;
    posY: Float32Array;
    theta: Float32Array;
    v: Float32Array;
};

/** SoA sample buffers per track, sized once to MAX_SAMPLES. only indices
 *  `[0, Track.count)` carry valid data. */
export const samples = new Map<number, Samples>();

/** baked per-edge state for each track. `fN` is force in g (per-edge, length
 *  MAX_SAMPLES − 1). `ds` is per-edge actual spacing. `t` is per-sample
 *  cumulative time `t[i] = Σ_{k<i} ds_k / v_safe_k`, length MAX_SAMPLES —
 *  the cart and the timeline read from it. `tTotal = t[count − 1]`.
 *  `feasible[i]` is 1 when `|v[i]| ≥ V_WARN`, 0 otherwise — drives the red
 *  track / red handle / warning banner UX. `firstInfeasible` is the first
 *  sample below V_WARN, or -1 if the whole chain is feasible.
 *  `lastBakedOrder` is the `Handle.order` of the last node the walk
 *  reached — nodes with `order > lastBakedOrder` are orphaned (their segment
 *  was degenerate or hit MAX_SAMPLES) and render red even though no
 *  infeasibility flag fires. `hash` is the input state that produced the
 *  current bake; a miss triggers a full re-bake. */
export const bakeOut = new Map<
    number,
    {
        fN: Float32Array;
        ds: Float32Array;
        t: Float32Array;
        tTotal: number;
        feasible: Uint8Array;
        firstInfeasible: number;
        lastBakedOrder: number;
        hash: string;
    }
>();

/** a node on the track. `order` is the ordinal position along the chain
 *  (0 = first), monotonically increasing. `pos` is the node's free world
 *  position, dragged directly; the curve passes through it exactly, so it's
 *  never derived or written back. `theta` is the node's exit heading — set when
 *  the node is appended (via `reflect`) and refreshed by `reheadOnDrag`: the
 *  *last* node tracks its predecessor (re-derived when it or the node before it
 *  is dragged), the first node is a fixed flat anchor (θ = 0), and interior nodes
 *  keep their heading frozen. only the last node's heading ever changes on a
 *  drag, so the edit reshapes only the two segments sharing the dragged node.
 *  `sample` is the sample index this node lands on (kept in sync by BakeSystem). */
export const Handle = {
    order: sparse(u32),
    sample: sparse(u32),
    pos: sparse(vec2),
    theta: sparse(f32),
};

const MAX_SAMPLES = 4096;
const DS_NOMINAL = 0.5;
/** launch speed (m/s) — the bake's and the solver's v0 must be the same
 *  number or their force profiles disagree systematically. */
export const V0 = 10;

/** how far `extend` lays the next node past the chain end, along the last
 *  edge's direction. it's a starting point you then drag, not a fixed length. */
export const EXTEND_DIST = 24;

/** allocate an empty track entity + its sample / bake-output buffers, sized
 *  once to MAX_SAMPLES. no nodes — callers (the demo seed, tests) add their
 *  own. returns the track eid. */
export function createTrack(ecs: State): number {
    const trackEid = ecs.create();
    ecs.add(trackEid, Track);
    Track.count.set(trackEid, 0);
    Track.ds.set(trackEid, DS_NOMINAL);
    samples.set(trackEid, {
        posX: new Float32Array(MAX_SAMPLES),
        posY: new Float32Array(MAX_SAMPLES),
        theta: new Float32Array(MAX_SAMPLES),
        v: new Float32Array(MAX_SAMPLES),
    });
    bakeOut.set(trackEid, {
        fN: new Float32Array(MAX_SAMPLES - 1),
        ds: new Float32Array(MAX_SAMPLES - 1),
        t: new Float32Array(MAX_SAMPLES),
        tTotal: 0,
        feasible: new Uint8Array(MAX_SAMPLES),
        firstInfeasible: -1,
        lastBakedOrder: -1,
        hash: "",
    });
    return trackEid;
}

/** append a node at the chain's end (order = maxOrder + 1) at world `(x, y)`.
 *  used by the seed, the controls, and `extend`. the new node's heading is the
 *  circular-arc exit from its predecessor's heading (`reflect`): placed straight
 *  ahead it continues straight, placed off-axis it bends one arc. the first node
 *  is a fixed flat anchor (θ = 0) — the track always launches horizontally from
 *  it, and node 1 reflects that flat launch. */
export function addNode(ecs: State, x: number, y: number): number {
    const prev = lastHandle(ecs);
    const order = prev === null ? 0 : Handle.order.get(prev) + 1;
    const eid = ecs.create();
    ecs.add(eid, Handle);
    Handle.order.set(eid, order);
    Handle.sample.set(eid, 0);
    Handle.pos.set(eid, x, y);
    if (prev === null) {
        Handle.theta.set(eid, 0); // the first node is a fixed flat anchor
    } else {
        const chord = Math.atan2(y - Handle.pos.y.get(prev), x - Handle.pos.x.get(prev));
        Handle.theta.set(eid, reflect(Handle.theta.get(prev), chord));
    }
    return eid;
}

/** resolve a node by its stable `order` to its ECS eid, or null. undo/redo
 *  address nodes by order — a stable identity for this append/delete-trailing
 *  chain (an interior node's order never changes), the way pins address by a
 *  stable `id` — so a recycled eid across a delete→undo can't alias the wrong
 *  node. */
export function handleAt(ecs: State, order: number): number | null {
    for (const eid of ecs.query([Handle])) {
        if (Handle.order.get(eid) === order) return eid;
    }
    return null;
}

/** re-create a node at an *exact* order / position / heading — no `reflect`, no
 *  rehead. restores a node deleted by a trim (undo) or re-adds one dropped by an
 *  extend (redo); the saved state is replayed verbatim so the bake reproduces the
 *  same curve. */
export function spawnNode(ecs: State, order: number, x: number, y: number, theta: number): number {
    const eid = ecs.create();
    ecs.add(eid, Handle);
    Handle.order.set(eid, order);
    Handle.sample.set(eid, 0);
    Handle.pos.set(eid, x, y);
    Handle.theta.set(eid, theta);
    return eid;
}

/** a node's undoable pose — position + stored heading, keyed by stable order. */
export interface NodeState {
    order: number;
    x: number;
    y: number;
    theta: number;
}

/** snapshot every node's pose (the whole chain — a handful of nodes). the move
 *  gesture captures this before/after a drag; a drag never adds or removes a
 *  node, so the two snapshots share the same order set. */
export function nodeSnapshot(ecs: State): NodeState[] {
    const snap: NodeState[] = [];
    for (const eid of ecs.query([Handle])) {
        snap.push({
            order: Handle.order.get(eid),
            x: Handle.pos.x.get(eid),
            y: Handle.pos.y.get(eid),
            theta: Handle.theta.get(eid),
        });
    }
    return snap;
}

/** write a chain snapshot back onto the live nodes by order (move undo/redo and
 *  gesture cancel). only pose is touched — the node set is unchanged. */
export function restoreNodes(ecs: State, snap: NodeState[]): void {
    for (const s of snap) {
        const eid = handleAt(ecs, s.order);
        if (eid === null) continue;
        Handle.pos.set(eid, s.x, s.y);
        Handle.theta.set(eid, s.theta);
    }
}

function seed(ecs: State): void {
    createTrack(ecs);
    // a flat horizontal start, one extension-length long (matches `extend`).
    addNode(ecs, -EXTEND_DIST / 2, 0);
    addNode(ecs, EXTEND_DIST / 2, 0);
}

/** collect every node eid on the chain, sorted by `Handle.order`. ECS query
 *  order isn't guaranteed; the multi-segment bake needs deterministic order to
 *  walk nodes. */
export function sortedHandles(ecs: State): number[] {
    const eids: number[] = [];
    for (const eid of ecs.query([Handle])) eids.push(eid);
    eids.sort((a, b) => Handle.order.get(a) - Handle.order.get(b));
    return eids;
}

/** highest-order node on the chain, or null when empty. */
export function lastHandle(ecs: State): number | null {
    let best: number | null = null;
    let bestOrder = -1;
    for (const eid of ecs.query([Handle])) {
        const o = Handle.order.get(eid);
        if (o > bestOrder) {
            bestOrder = o;
            best = eid;
        }
    }
    return best;
}

/** lay a new node past the chain end, continuing straight along the last node's
 *  exit heading by `EXTEND_DIST` — the "extend the track" gesture (the new node
 *  is then free to drag). placing it along the heading makes `reflect` return
 *  the same heading, so the new segment opens straight. returns the new node. */
export function extend(ecs: State): number {
    const last = lastHandle(ecs);
    if (last === null) return addNode(ecs, 0, 0);
    const th = Handle.theta.get(last);
    const lx = Handle.pos.x.get(last);
    const ly = Handle.pos.y.get(last);
    return addNode(ecs, lx + Math.cos(th) * EXTEND_DIST, ly + Math.sin(th) * EXTEND_DIST);
}

/** the standing invariant: the last (heading) node's angle is the circular-arc
 *  reflection of its predecessor's heading about their chord. re-derived
 *  whenever the chain's tail changes — a drag of the tip or the node before it,
 *  or a deletion that promotes a new tip — so the tip's angle is never stale
 *  (and never jumps the next time it's grabbed). takes the sorted handles;
 *  no-op below two nodes. */
function headLast(handles: number[]): void {
    const n = handles.length;
    if (n < 2) return;
    const last = handles[n - 1];
    const prev = handles[n - 2];
    const chord = Math.atan2(
        Handle.pos.y.get(last) - Handle.pos.y.get(prev),
        Handle.pos.x.get(last) - Handle.pos.x.get(prev),
    );
    Handle.theta.set(last, reflect(Handle.theta.get(prev), chord));
}

/** refresh headings after a node is dragged. the **last** (heading) node always
 *  tracks its predecessor: it re-derives whenever *it* moves or the node *before*
 *  it moves, so its segment stays a clean arc and its angle never goes stale (so
 *  grabbing it next never makes it jump). the **first** node is a fixed flat
 *  anchor and **interior** nodes keep their heading frozen — the arc contract
 *  can't hold on both of an interior node's segments at once, so a stable
 *  heading beats one that thrashes its outgoing segment on every nudge. a drag
 *  only ever changes the *last* node's heading, so the edit stays local; tangent
 *  lengths re-proportion automatically (length is the live chord). */
export function reheadOnDrag(ecs: State, eid: number): void {
    const handles = sortedHandles(ecs);
    const last = handles.length - 1;
    if (last < 1) return;
    const idx = handles.indexOf(eid);
    if (idx === last || idx === last - 1) headLast(handles);
}

/** remove the trailing (highest-order) node — undo the last node. this only
 *  ever drops the chain's end, never below the two nodes a chain needs. the
 *  node it promotes to the new tip re-derives its heading (`headLast`) so it's
 *  already arc-consistent and won't jump when grabbed. the next BakeSystem tick
 *  re-derives the curve. returns true when a node was removed. */
export function removeTrailingHandle(ecs: State): boolean {
    const last = lastHandle(ecs);
    if (last === null) return false;
    let count = 0;
    for (const _ of ecs.query([Handle])) count++;
    if (count <= 2) return false;
    ecs.destroy(last);
    headLast(sortedHandles(ecs)); // the promoted tip tracks its predecessor
    return true;
}

/** input-state hash that gates the bake: every node's position in walk order.
 *  BakeSystem re-bakes on a miss (any node moved / added / removed), skips
 *  otherwise. */
function bakeHash(ecs: State, handles: number[] = sortedHandles(ecs)): string {
    let hash = "";
    for (const eid of handles) {
        hash += `|${Handle.pos.x.get(eid)}:${Handle.pos.y.get(eid)}:${Handle.theta.get(eid)}`;
    }
    return hash;
}

/** per-sample cumulative time `t[i] = Σ_{k<i} ds_k / v̄_k` plus the
 *  diagnostic feasibility flag. v̄ floors at V_FLOOR so energy-depleted
 *  regions take long-but-finite time; `feasible[i] = |v[i]| >= V_WARN`
 *  drives the red track / red handle / banner UX (warning threshold is
 *  intentionally higher than the numerical floor). */
function computeTime(
    s: Samples,
    out: NonNullable<ReturnType<typeof bakeOut.get>>,
    count: number,
): void {
    out.t[0] = 0;
    out.feasible[0] = Math.abs(s.v[0]) >= V_WARN ? 1 : 0;
    let firstBad = out.feasible[0] === 0 ? 0 : -1;
    for (let i = 0; i < count - 1; i++) {
        const vA = Math.max(Math.abs(s.v[i]), V_FLOOR);
        const vB = Math.max(Math.abs(s.v[i + 1]), V_FLOOR);
        const vAvg = 0.5 * (vA + vB);
        out.t[i + 1] = out.t[i] + out.ds[i] / vAvg;
        const f = Math.abs(s.v[i + 1]) >= V_WARN ? 1 : 0;
        out.feasible[i + 1] = f;
        if (firstBad < 0 && f === 0) firstBad = i + 1;
    }
    out.tTotal = count > 0 ? out.t[count - 1] : 0;
    out.firstInfeasible = firstBad;
}

type BakeOut = NonNullable<ReturnType<typeof bakeOut.get>>;

/** the pre-solver bake: sample the Hermite curve through every node (stored
 *  headings, live-chord tangent lengths) straight into `samples`, then
 *  recover the physical force profile: θ from the curve's local tangent, v
 *  from energy, F_n = κ·v²/g + cos θ. a degenerate segment or a full buffer
 *  commits the prefix and orphans the trailing nodes. */
function bakeIdentity(
    trackEid: number,
    s: Samples,
    out: BakeOut,
    handles: number[],
    hash: string,
): void {
    const dsNominal = Track.ds.get(trackEid);
    const nodes: Node[] = handles.map((eid) => ({
        x: Handle.pos.x.get(eid),
        y: Handle.pos.y.get(eid),
        theta: Handle.theta.get(eid),
    }));

    const r = sampleChain(nodes, dsNominal, s.posX, s.posY, out.ds, MAX_SAMPLES);
    if (r.truncated) {
        console.warn(
            `kex2d: track ${trackEid} hit MAX_SAMPLES=${MAX_SAMPLES}; trailing nodes dropped`,
        );
    }
    if (r.edges < 1) return; // degenerate first segment — keep prior bake

    forces(s.posX, s.posY, s.theta, s.v, out.fN, out.ds, 0, r.edges, V0);

    // sync each baked node's sample index; the last baked node sets
    // lastBakedOrder. nodes past it are orphans (their `.sample` is
    // stale) and HandleDrawSystem renders them red.
    for (let k = 0; k < r.offsets.length; k++) {
        Handle.sample.set(handles[k], r.offsets[k]);
    }
    out.lastBakedOrder = Handle.order.get(handles[r.offsets.length - 1]);
    out.hash = hash;
    Track.count.set(trackEid, r.edges + 1);
    computeTime(s, out, r.edges + 1);
}

// draft scratch for the constrained path — the solver consumes the sampled
// chain without touching `samples` (which then carries the SOLVED geometry).
const draftX = new Float32Array(MAX_SAMPLES);
const draftY = new Float32Array(MAX_SAMPLES);
const draftDs = new Float32Array(MAX_SAMPLES - 1);

export const BakeSystem: System = {
    update(ecs: State): void {
        for (const trackEid of ecs.query([Track])) {
            const s = samples.get(trackEid);
            const out = bakeOut.get(trackEid);
            if (!s || !out) continue;

            const handles = sortedHandles(ecs);
            if (handles.length < 2) continue;

            const hash = bakeHash(ecs, handles);

            if (!hasConstraints(ecs, trackEid)) {
                // the identity short-circuit: no constraints, the pre-solver
                // editor verbatim (byte-identical output, no solver state).
                // deleting live solver state forces one rebake even on a hash
                // match — the realized track must snap back to the draft.
                const hadSolve = solveState.delete(trackEid);
                if (hash === out.hash && !hadSolve) continue;
                bakeIdentity(trackEid, s, out, handles, hash);
                continue;
            }

            const st0 = solveState.get(trackEid);
            const rev = constraintRev(ecs, trackEid);
            const skip =
                hash === out.hash && st0 && st0.rev === rev && (st0.settled || st0.suspended);
            if (skip) continue;

            // the draft re-samples only on a hash miss; polish ticks reuse
            // the grid stored in SolveState.
            let draft: DraftInput | null = null;
            if (hash !== out.hash || !st0 || st0.suspended) {
                const dsNominal = Track.ds.get(trackEid);
                const nodes: Node[] = handles.map((eid) => ({
                    x: Handle.pos.x.get(eid),
                    y: Handle.pos.y.get(eid),
                    theta: Handle.theta.get(eid),
                }));
                const r = sampleChain(nodes, dsNominal, draftX, draftY, draftDs, MAX_SAMPLES);
                if (r.truncated) {
                    console.warn(
                        `kex2d: track ${trackEid} hit MAX_SAMPLES=${MAX_SAMPLES}; trailing nodes dropped`,
                    );
                }
                if (r.edges < 1) continue;
                draft = {
                    posX: draftX,
                    posY: draftY,
                    dsArr: draftDs,
                    count: r.edges + 1,
                    offsets: r.offsets,
                };
            }

            const st = solveStep(ecs, trackEid, draft, hash, V0, Track.ds.get(trackEid));

            if (st.suspended) {
                // energy-infeasible draft: realize the draft itself so the
                // red-track / banner UX tells the story. (bakeIdentity owns
                // the hash commit — a degenerate bake keeps retrying.)
                bakeIdentity(trackEid, s, out, handles, hash);
                continue;
            }

            // realized = solved: the display bake runs on the solver output.
            const n = st.n;
            for (let i = 0; i < n; i++) {
                s.posX[i] = st.x[i];
                s.posY[i] = st.y[i];
            }
            for (let i = 0; i < n - 1; i++) {
                out.ds[i] = Math.hypot(st.x[i + 1] - st.x[i], st.y[i + 1] - st.y[i]);
            }
            forces(s.posX, s.posY, s.theta, s.v, out.fN, out.ds, 0, n - 1, V0);
            const baked = Math.min(st.nodeFracs.length, handles.length);
            for (let k = 0; k < baked; k++) {
                Handle.sample.set(handles[k], Math.round(st.nodeFracs[k] * (n - 1)));
            }
            if (baked > 0) out.lastBakedOrder = Handle.order.get(handles[baked - 1]);
            out.hash = hash;
            Track.count.set(trackEid, n);
            computeTime(s, out, n);
        }
    },
};

export const TrackPlugin: Plugin = {
    name: "Track",
    components: { Track, Handle, Pin, PosPin },
    traits: {
        Track: { defaults: () => ({ count: 0, ds: 0 }) },
        Handle: { defaults: () => ({ order: 0, sample: 0, pos: [0, 0], theta: 0 }) },
        Pin: { defaults: () => ({ track: 0, id: 0, sigma: 0, f: 0, w: 0, width: 0 }) },
        PosPin: { defaults: () => ({ track: 0, id: 0, sigma: 0, x: 0, y: 0, w: 0 }) },
    },
    initialize(ecs) {
        seed(ecs);
    },
    systems: [BakeSystem],
};
