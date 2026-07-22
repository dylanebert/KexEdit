import { f32, type Plugin, sparse, type State, type System, u32, vec2 } from "@dylanebert/shallot";
import { V_FLOOR, V_WARN } from "./bake";
import { type ForcePoint, forceProfile } from "./profile";
import {
    chain,
    type Entry,
    evalGeo,
    localize,
    place,
    type Section as SectionSpec,
} from "./section";
import { autoTangent, type Node, reflect, type Tangent, type TangentMode } from "./spline";

/** whether a section is authored as GEOMETRY (drag nodes in the viewport, recover
 *  the force) or FORCE (place points on the force curve, integrate the geometry) —
 *  the two atomic idioms of the section substrate.
 *  a track is a chain of sections, each with its own kind. stored on `Section.kind`
 *  as its numeric value. */
export enum SectionKind {
    Geo = 0,
    Force = 1,
}

/** per-track scalars. `count` is the total sample count over the whole chain (bake
 *  output, varies with the authored payload). `ds` is the nominal target spacing —
 *  one value shared by every section (per-edge actual ds lives in `bakeOut.ds`).
 *  `v0` is the authored initial speed (m/s) at the track start (the START handle's
 *  field; default `V0`, in the bake hash). the per-section kind + extent live on
 *  `Section`, not here. */
export const Track = {
    count: sparse(u32),
    ds: sparse(f32),
    v0: sparse(f32),
};

/** one section in the track's chain. `id` is the stable identity undo/redo and
 *  node/point membership address (eids recycle across a delete→undo; ids never do
 *  — the `Handle.order` convention). `order` is its position along the chain
 *  (0 = first), reassigned by the structural ops (append/split/join/delete). `kind`
 *  is the `SectionKind`. `length` is a FORCE section's extent (m) — the distance the
 *  force profile spans; unused (0) for a geo section, whose extent is its node chain.
 *  a section's entry anchor is derived (the prior section's exit, or `START` for the
 *  first); it is never stored. */
export const Section = {
    id: sparse(u32),
    order: sparse(u32),
    kind: sparse(u32),
    length: sparse(f32),
};

/** a node on a geo section. `section` is the owning section's stable id. `order`
 *  is the node's position within that section (0 = the section entry, pinned at
 *  local origin). `pos` is the node's **section-local** position; the substrate
 *  places it rigidly at the section's entry frame, so world = `place(entry, pos)`
 *  (the bake writes the world sample; the drag localizes the world pointer back).
 *  `theta` is the node's section-local exit heading — set when appended (via
 *  `reflect`) and refreshed by `reheadOnDrag`: the *last* node tracks its
 *  predecessor, node 0 is a fixed local flat anchor (θ = 0), interior nodes stay
 *  frozen. only the last node's heading changes on a drag, so the edit reshapes
 *  only the two segments sharing the dragged node. `sample` is the global sample
 *  index this node lands on (synced by BakeSystem).
 *  `tmode` is the node's `TangentMode` (0 = Auto, the default: derive tangents
 *  from `theta` via the arc rule). when it isn't Auto, `tin`/`tout` hold the
 *  explicit in/out tangent vectors (section-local, absolute) the bake honors in
 *  place of the arc rule — the summoned inner layer (`Aligned` / `Free`). */
export const Handle = {
    section: sparse(u32),
    order: sparse(u32),
    sample: sparse(u32),
    pos: sparse(vec2),
    theta: sparse(f32),
    tmode: sparse(u32),
    tin: sparse(vec2),
    tout: sparse(vec2),
};

/** the numeric value stored on `Handle.tmode` for an `Auto` node (no explicit
 *  tangent). the `TangentMode` enum starts at 1, so 0 is the third, default state. */
const TANGENT_AUTO = 0;

/** read a node's explicit tangent, or undefined when it's `Auto` — the projection
 *  onto the pure `spline.Node.tangent`. */
function readTangent(eid: number): Tangent | undefined {
    const mode = Handle.tmode.get(eid);
    if (mode === TANGENT_AUTO) return undefined;
    return {
        mode: mode as TangentMode,
        inX: Handle.tin.x.get(eid),
        inY: Handle.tin.y.get(eid),
        outX: Handle.tout.x.get(eid),
        outY: Handle.tout.y.get(eid),
    };
}

/** write a node's tangent onto its columns; undefined resets it to `Auto` (zeroed
 *  vectors). the one place `Handle.tmode`/`tin`/`tout` are written together. */
function writeTangent(eid: number, tan: Tangent | undefined): void {
    if (tan) {
        Handle.tmode.set(eid, tan.mode);
        Handle.tin.set(eid, tan.inX, tan.inY);
        Handle.tout.set(eid, tan.outX, tan.outY);
    } else {
        Handle.tmode.set(eid, TANGENT_AUTO);
        Handle.tin.set(eid, 0, 0);
        Handle.tout.set(eid, 0, 0);
    }
}

/** an authored force keyframe on a FORCE section. `section` is the owning section's
 *  stable id; `id` is the point's stable identity (undo/redo address, eid-recycle
 *  safe); `s` its arclength (m) measured from the section entry; `g` the demanded
 *  normal force (g). the timeline places, drags, and deletes these; the bake gathers
 *  each section's points (sorted by s) into a dense profile (`profile.forceProfile`). */
export const Force = {
    section: sparse(u32),
    id: sparse(u32),
    s: sparse(f32),
    g: sparse(f32),
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
 *  sample below V_WARN, or -1 if the whole chain is feasible. `hash` is the
 *  input state that produced the current bake; a miss triggers a full re-bake. */
export const bakeOut = new Map<
    number,
    {
        fN: Float32Array;
        ds: Float32Array;
        t: Float32Array;
        tTotal: number;
        feasible: Uint8Array;
        firstInfeasible: number;
        hash: string;
    }
>();

/** per-section realized metadata the flat SoA drops — keyed by stable section id,
 *  written by BakeSystem, read by the drag (localize against `entry`), the render
 *  (boundary markers at `entry`, orphan nodes past `bakedNodes`), and the timeline
 *  (section boundaries + cumulative-s offset via the sample range). */
export interface SectionInfo {
    /** the section's entry anchor (world) — `START` for the first, the prior
     *  section's exit otherwise. the frame a geo node localizes against. */
    entry: Entry;
    /** global sample index of the section's first point (its entry, shared with the
     *  prior section's last point). */
    startSample: number;
    /** global sample index of the section's last point (its exit). */
    endSample: number;
    /** geo: how many nodes landed (a degenerate/truncated segment bakes a prefix, so
     *  nodes past this are orphans). force: 2 (the boundary anchors). */
    bakedNodes: number;
}

export const sectionInfo = new Map<number, SectionInfo>();

export const MAX_SAMPLES = 4096;
const DS_NOMINAL = 0.5;

/** the DEFAULT initial speed (m/s) a fresh track's start anchor gets. it's now
 *  authored per-track (`Track.v0`, set via the START handle's field); this is only
 *  the seed until the user (or some upstream idiom — a launch, a lift hill) sets it.
 *  matches kexedit / FVD. */
export const V0 = 10;

/** the slowest the authored initial speed can be set — a positive floor so the start
 *  is never zero/negative (which would make a level track take infinite time). */
const MIN_V0 = 0.1;

/** how far `extend` lays the next node past the chain end, along the last edge's
 *  direction. it's a starting point you then drag, not a fixed length. */
export const EXTEND_DIST = 24;

/** the track's initial anchor for a given initial speed: the entry to the first
 *  section, a level start at the origin. world position is cosmetic in this 2D
 *  prototype (the view auto-frames), so it's fixed — the authored variable is the
 *  initial speed `v` (`Track.v0`), which this threads into the entry frame. */
function startEntry(v0: number): Entry {
    return { x: 0, y: 0, theta: 0, v: v0 };
}

/** the extent (m) a fresh force section gets — an append or a geo→force convert
 *  resets to this (the extent is the force section's own authored property, not a
 *  leftover of the pre-convert geo shape). matches the geo seed's length, so a fresh
 *  geo and a fresh force section start the same size; the end handle then resizes it. */
const DEFAULT_FORCE_LEN = EXTEND_DIST;

/** the shortest a force section can be dragged — a couple of edges, so the profile
 *  never collapses below what `forceProfile` can sample. */
export const MIN_FORCE_LEN = 2;

/** allocate an empty track entity + its sample / bake-output buffers, sized once
 *  to MAX_SAMPLES. no sections — callers (the demo seed, tests) add their own.
 *  returns the track eid. */
export function createTrack(ecs: State): number {
    const trackEid = ecs.create();
    ecs.add(trackEid, Track);
    Track.count.set(trackEid, 0);
    Track.ds.set(trackEid, DS_NOMINAL);
    Track.v0.set(trackEid, V0);
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
        hash: "",
    });
    return trackEid;
}

// ── sections ─────────────────────────────────────────────────────────────────

// monotone id source — never reused, even after a delete: history can re-spawn any
// deleted section, so a scan-the-live-set allocator would alias a fresh section
// with a restorable one (the eid-recycling bug one level up).
let nextSectionId = 0;

/** a section read off the ECS: eid + its stable id, chain order, kind, and force
 *  extent. */
export interface SectionRow {
    eid: number;
    id: number;
    order: number;
    kind: SectionKind;
    length: number;
}

/** every section, sorted by chain order — the sequence the bake threads and the
 *  UI walks. */
export function sections(ecs: State): SectionRow[] {
    const rows: SectionRow[] = [];
    for (const eid of ecs.query([Section])) {
        rows.push({
            eid,
            id: Section.id.get(eid),
            order: Section.order.get(eid),
            kind: Section.kind.get(eid) as SectionKind,
            length: Section.length.get(eid),
        });
    }
    rows.sort((a, b) => a.order - b.order);
    return rows;
}

/** resolve a section by its stable id to its eid, or null. */
export function sectionAt(ecs: State, id: number): number | null {
    for (const eid of ecs.query([Section])) {
        if (Section.id.get(eid) === id) return eid;
    }
    return null;
}

/** a section's place on the global distance axis: its stable id, its `offset` (the
 *  track-global distance `d` at its entry = the cumulative baked arclength of every
 *  upstream section), and its `len` (its own baked arclength). the section occupies the
 *  d-interval `[offset, offset + len]`. */
export interface SectionSpan {
    id: number;
    offset: number;
    len: number;
}

/** the coordinate lens — the ONE seam between the author-facing track-global distance
 *  `d` (meters, the timeline ruler) and the section-local arclength `s` the substrate
 *  stores. `sectionSpans` is its table (one accumulating pass over the baked ds), and
 *  `toGlobal`/`toLocal` are the affine `d = offset + s` and its inverse. every d readout
 *  — timeline clips/boundaries, force-point placement, cart park — derives here; nothing
 *  walks the cumulative ds itself. sections are contiguous (each shares its entry sample
 *  with the prior exit), so one pass suffices. */
export function sectionSpans(ecs: State, eid: number): SectionSpan[] {
    const out = bakeOut.get(eid);
    if (!out) return [];
    const res: SectionSpan[] = [];
    let cum = 0;
    for (const sec of sections(ecs)) {
        const info = sectionInfo.get(sec.id);
        if (!info) continue;
        const offset = cum;
        for (let i = info.startSample; i < info.endSample; i++) cum += out.ds[i];
        res.push({ id: sec.id, offset, len: cum - offset });
    }
    return res;
}

/** section-local `(section, s)` → track-global distance `d = offset + s`. null when the
 *  section isn't on the current bake. */
export function toGlobal(spans: SectionSpan[], section: number, s: number): number | null {
    const sp = spans.find((x) => x.id === section);
    return sp ? sp.offset + s : null;
}

/** track-global distance `d` → the section-local address `(section, s)`. boundary policy:
 *  a `d` on a shared section boundary resolves to the UPSTREAM (earlier) section — the
 *  first span whose exit reaches `d` wins (left/upstream-inclusive spans), matching the
 *  clip strip's boundary guides and the cart's park resolution. out-of-range `d` resolves
 *  to the nearest end of the track. null when there's no bake. */
export function toLocal(spans: SectionSpan[], d: number): { section: number; s: number } | null {
    if (spans.length === 0) return null;
    for (const sp of spans) {
        if (d <= sp.offset + sp.len) return { section: sp.id, s: Math.max(0, d - sp.offset) };
    }
    const last = spans[spans.length - 1];
    return { section: last.id, s: last.len };
}

/** create a section at `order` with a fresh stable id — the append/seed path.
 *  returns the id (undo/redo, membership, and selection address by id). */
export function createSection(
    ecs: State,
    order: number,
    kind: SectionKind,
    length: number,
): number {
    const eid = ecs.create();
    ecs.add(eid, Section);
    const id = nextSectionId++;
    Section.id.set(eid, id);
    Section.order.set(eid, order);
    Section.kind.set(eid, kind);
    Section.length.set(eid, length);
    return id;
}

/** re-create a section at an *exact* id / order / kind / length — undo of a delete,
 *  redo of a create, or a snapshot restore. no id allocation, so it round-trips
 *  byte-identical. its nodes/points are respawned separately. */
function spawnSection(
    ecs: State,
    id: number,
    order: number,
    kind: SectionKind,
    length: number,
): void {
    const eid = ecs.create();
    ecs.add(eid, Section);
    Section.id.set(eid, id);
    Section.order.set(eid, order);
    Section.kind.set(eid, kind);
    Section.length.set(eid, length);
}

// ── geo nodes (section-local) ────────────────────────────────────────────────

/** collect every node on a section, sorted by `Handle.order`. ECS query order
 *  isn't guaranteed; the bake and the heading walk need deterministic order. */
export function sectionHandles(ecs: State, sectionId: number): number[] {
    const eids: number[] = [];
    for (const eid of ecs.query([Handle])) {
        if (Handle.section.get(eid) === sectionId) eids.push(eid);
    }
    eids.sort((a, b) => Handle.order.get(a) - Handle.order.get(b));
    return eids;
}

/** highest-order node on a section, or null when empty. */
export function lastHandle(ecs: State, sectionId: number): number | null {
    let best: number | null = null;
    let bestOrder = -1;
    for (const eid of ecs.query([Handle])) {
        if (Handle.section.get(eid) !== sectionId) continue;
        const o = Handle.order.get(eid);
        if (o > bestOrder) {
            bestOrder = o;
            best = eid;
        }
    }
    return best;
}

/** append a node at the section's end (order = maxOrder + 1) at **section-local**
 *  `(x, y)`. the new node's heading is the circular-arc exit from its predecessor's
 *  heading (`reflect`): placed straight ahead it continues straight, off-axis it
 *  bends one arc. node 0 (local origin, the section entry) is a fixed flat anchor
 *  (θ = 0) — the section always leaves its entry along the entry heading, and node 1
 *  reflects that. */
export function addNode(ecs: State, sectionId: number, x: number, y: number): number {
    const prev = lastHandle(ecs, sectionId);
    const order = prev === null ? 0 : Handle.order.get(prev) + 1;
    const eid = ecs.create();
    ecs.add(eid, Handle);
    Handle.section.set(eid, sectionId);
    Handle.order.set(eid, order);
    Handle.sample.set(eid, 0);
    Handle.pos.set(eid, x, y);
    writeTangent(eid, undefined); // a fresh node is Auto — the arc rule (the live growth tip)
    if (prev === null) {
        Handle.theta.set(eid, 0); // node 0 is a fixed local flat anchor (the entry)
    } else {
        const chord = Math.atan2(y - Handle.pos.y.get(prev), x - Handle.pos.x.get(prev));
        Handle.theta.set(eid, reflect(exitHeading(prev), chord));
        // the old tip becomes interior but stays live (`Auto`) — the default add/drag flow stores
        // NO tangents and shapes exactly like the pre-handles editor (frozen interior heading,
        // chord-scaled length, tip reflection). a node turns concrete bezier only when authored
        // (a handle drag or a mode set), never at append.
    }
    return eid;
}

/** a node's exit heading — the direction its curve leaves along. an explicit node exits along
 *  its stored out-vector (the departure tangent); an `Auto` node exits along its stored heading
 *  `theta` (the arc rule points the handle exactly there). the append direction and the `reflect`
 *  seed derive from this, so an explicit tip appends along the visible curve, not a stale
 *  `Handle.theta` (which explicit tangents decouple from the recovered heading). */
function exitHeading(eid: number): number {
    const tan = readTangent(eid);
    return tan ? Math.atan2(tan.outY, tan.outX) : Handle.theta.get(eid);
}

/** a node's exit heading in **world** space — its section-local `exitHeading` rotated into world
 *  by the section entry frame (the same rotation `tangents.ts` applies to place a handle). the
 *  authored exit direction the selected-node readout reports: an explicit out-vector else the
 *  stored `Auto` heading, both section-local, carried to world here. never a bake re-derivation, so
 *  it holds constant while a handle drags along an engaged angle-snap ray. one source with
 *  `exitHeading` (the append/reflect reader) — the readout doesn't invent a third. */
export function exitWorld(eid: number): number {
    const info = sectionInfo.get(Handle.section.get(eid));
    return exitHeading(eid) + (info ? info.entry.theta : 0);
}

/** resolve a node by its section + stable `order` to its eid, or null. undo/redo
 *  address nodes by (section, order) — a stable identity for the append/delete-
 *  trailing chain (an interior node's order never changes), so a recycled eid across
 *  a delete→undo can't alias the wrong node. */
export function handleAt(ecs: State, sectionId: number, order: number): number | null {
    for (const eid of ecs.query([Handle])) {
        if (Handle.section.get(eid) === sectionId && Handle.order.get(eid) === order) return eid;
    }
    return null;
}

/** re-create a node at an *exact* section / order / position / heading (+ optional
 *  explicit tangent) — no `reflect`, no rehead. restores a node deleted by a trim
 *  (undo) or re-adds one dropped by an extend (redo); the saved state is replayed
 *  verbatim so the bake reproduces the same curve. an absent `tan` is `Auto`. */
export function spawnNode(
    ecs: State,
    sectionId: number,
    order: number,
    x: number,
    y: number,
    theta: number,
    tan?: Tangent,
): number {
    const eid = ecs.create();
    ecs.add(eid, Handle);
    Handle.section.set(eid, sectionId);
    Handle.order.set(eid, order);
    Handle.sample.set(eid, 0);
    Handle.pos.set(eid, x, y);
    Handle.theta.set(eid, theta);
    writeTangent(eid, tan);
    return eid;
}

/** a node's undoable pose — section-local position + stored heading + its explicit
 *  tangent (absent = Auto), keyed by stable order within its section. */
export interface NodeState {
    order: number;
    x: number;
    y: number;
    theta: number;
    tangent?: Tangent;
}

/** snapshot every node's pose on a section (a handful of nodes). the move gesture
 *  captures this before/after a drag; a drag never adds or removes a node, so the
 *  two snapshots share the same order set. */
export function nodeSnapshot(ecs: State, sectionId: number): NodeState[] {
    const snap: NodeState[] = [];
    for (const eid of sectionHandles(ecs, sectionId)) {
        snap.push({
            order: Handle.order.get(eid),
            x: Handle.pos.x.get(eid),
            y: Handle.pos.y.get(eid),
            theta: Handle.theta.get(eid),
            tangent: readTangent(eid),
        });
    }
    return snap;
}

/** whether two explicit tangents are equal (both absent = equal). */
function sameTangent(a?: Tangent, b?: Tangent): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return (
        a.mode === b.mode &&
        a.inX === b.inX &&
        a.inY === b.inY &&
        a.outX === b.outX &&
        a.outY === b.outY
    );
}

/** whether two node snapshots are pose-identical (matched by stable order),
 *  including the explicit tangent. the gesture no-op test for any surface that
 *  moves nodes or edits their tangents. */
export function sameNodes(a: NodeState[], b: NodeState[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const bi = b.find((n) => n.order === a[i].order);
        if (!bi || bi.x !== a[i].x || bi.y !== a[i].y || bi.theta !== a[i].theta) return false;
        if (!sameTangent(bi.tangent, a[i].tangent)) return false;
    }
    return true;
}

/** write a node snapshot back onto a section's live nodes by order (move undo/redo
 *  and gesture cancel). pose + explicit tangent are restored; the node set is
 *  unchanged. */
export function restoreNodes(ecs: State, sectionId: number, snap: NodeState[]): void {
    for (const s of snap) {
        const eid = handleAt(ecs, sectionId, s.order);
        if (eid === null) continue;
        Handle.pos.set(eid, s.x, s.y);
        Handle.theta.set(eid, s.theta);
        writeTangent(eid, s.tangent);
    }
}

/** a node's explicit tangent, or undefined when it's `Auto` — the read for the
 *  tangent-handle UI and tests. */
export function handleTangent(ecs: State, sectionId: number, order: number): Tangent | undefined {
    const eid = handleAt(ecs, sectionId, order);
    return eid === null ? undefined : readTangent(eid);
}

/** seed an explicit tangent from a node's current `Auto` arc-rule tangents, so summoning
 *  explicit (the popover mode control or a handle pull) starts from exactly what the arc
 *  rule draws — the Auto→explicit conversion is visually continuous (`spline.autoTangent`
 *  reproduces the bake's own tangent). the in-vector reads the live section-local chord
 *  from the previous node, the out-vector the chord to the next; a chain end with no
 *  outgoing segment mirrors the incoming length forward along the heading. returns a
 *  `Tangent` in `mode` (the two vectors share direction `theta`, so it's a valid `Aligned`
 *  seed and bit-continuous with the Auto bake). */
export function seedTangent(
    ecs: State,
    sectionId: number,
    order: number,
    mode: TangentMode,
): Tangent | null {
    const eid = handleAt(ecs, sectionId, order);
    if (eid === null) return null;
    const nx = Handle.pos.x.get(eid);
    const ny = Handle.pos.y.get(eid);
    const th = Handle.theta.get(eid);

    const prev = handleAt(ecs, sectionId, order - 1);
    let inVec: [number, number];
    if (prev !== null) {
        const dx = nx - Handle.pos.x.get(prev);
        const dy = ny - Handle.pos.y.get(prev);
        inVec = autoTangent(th, Math.atan2(dy, dx), Math.hypot(dx, dy));
    } else {
        inVec = [Math.cos(th), Math.sin(th)]; // no incoming segment (order 0 — not summonable)
    }

    const next = handleAt(ecs, sectionId, order + 1);
    let outVec: [number, number];
    if (next !== null) {
        const dx = Handle.pos.x.get(next) - nx;
        const dy = Handle.pos.y.get(next) - ny;
        outVec = autoTangent(th, Math.atan2(dy, dx), Math.hypot(dx, dy));
    } else {
        // a chain end drives no outgoing segment; mirror the incoming length forward so the
        // out-handle has a sensible (invisible) value for the Aligned coupling.
        const inLen = Math.hypot(inVec[0], inVec[1]);
        outVec = [inLen * Math.cos(th), inLen * Math.sin(th)];
    }

    return { mode, inX: inVec[0], inY: inVec[1], outX: outVec[0], outY: outVec[1] };
}

/** set (or clear, with null) a node's explicit tangent — the programmatic tangent
 *  setter the summon/handle-drag gestures (and tests) write through. `null` reverts
 *  the node to `Auto`. does not itself record history — a gesture (`beginMove` /
 *  a discrete command) wraps it, and `nodeSnapshot` captures the tangent for undo. */
export function setTangent(
    ecs: State,
    sectionId: number,
    order: number,
    tan: Tangent | null,
): void {
    const eid = handleAt(ecs, sectionId, order);
    if (eid !== null) writeTangent(eid, tan ?? undefined);
}

/** the standing invariant: the last (heading) node's angle is the circular-arc
 *  reflection of its predecessor's heading about their chord. re-derived whenever
 *  the chain's tail changes so the tip's angle is never stale. takes the section's
 *  sorted handles; no-op below two nodes. */
function headLast(handles: number[]): void {
    const n = handles.length;
    if (n < 2) return;
    const last = handles[n - 1];
    const prev = handles[n - 2];
    const chord = Math.atan2(
        Handle.pos.y.get(last) - Handle.pos.y.get(prev),
        Handle.pos.x.get(last) - Handle.pos.x.get(prev),
    );
    Handle.theta.set(last, reflect(exitHeading(prev), chord));
}

/** the Reset action: clear a node's explicit tangent back to live (`Auto` inference resumes).
 *  meaningful for any node: an interior re-uses its frozen arc-rule heading, the growth tip
 *  re-tracks its predecessor (its heading re-derived), and node 0 (the entry anchor, editable via
 *  its out-handle) returns to the `Auto` C1 exit along the entry heading. does not itself record
 *  history — a gesture (`beginMove`/`commit`) wraps it, `nodeSnapshot` captures the tangent + theta
 *  for undo. node 0 is never the chain tip, so it never triggers the tip re-head. */
export function resetTangent(ecs: State, sectionId: number, order: number): void {
    const handles = sectionHandles(ecs, sectionId);
    if (handles.length === 0) return;
    const eid = handleAt(ecs, sectionId, order);
    if (eid === null) return;
    writeTangent(eid, undefined); // clear to live
    if (eid === handles[handles.length - 1]) headLast(handles); // the tip re-tracks its predecessor
}

/** refresh headings after a node is dragged. the **last** (heading) node always
 *  tracks its predecessor (re-derives when it or the node before it moves); node 0
 *  (the flat anchor) and **interior** nodes keep their heading frozen — the arc
 *  contract can't hold on both of an interior node's segments at once, so a stable
 *  heading beats one that thrashes. a drag only changes the last node's heading, so
 *  the edit stays local; tangent lengths re-proportion automatically. */
export function reheadOnDrag(ecs: State, eid: number): void {
    const sectionId = Handle.section.get(eid);
    const handles = sectionHandles(ecs, sectionId);
    const last = handles.length - 1;
    if (last < 1) return;
    const idx = handles.indexOf(eid);
    if (idx === last || idx === last - 1) headLast(handles);
}

/** lay a new node past a section's end, continuing straight along the last node's
 *  exit heading by `EXTEND_DIST` (in the section-local frame) — the "extend"
 *  gesture. placing it along the heading makes `reflect` return the same heading, so
 *  the new segment opens straight. returns the new node. */
export function extend(ecs: State, sectionId: number): number {
    const last = lastHandle(ecs, sectionId);
    if (last === null) return addNode(ecs, sectionId, 0, 0);
    // continue along the tip's actual exit — its explicit out-vector when authored, else its
    // stored heading (the arc rule exits exactly along `theta`). placing straight along the exit
    // makes `reflect` return it, so the new segment opens straight.
    const th = exitHeading(last);
    const lx = Handle.pos.x.get(last);
    const ly = Handle.pos.y.get(last);
    return addNode(
        ecs,
        sectionId,
        lx + Math.cos(th) * EXTEND_DIST,
        ly + Math.sin(th) * EXTEND_DIST,
    );
}

/** remove the trailing (highest-order) node on a section — never below the two
 *  nodes a geo section needs (node 0 the entry + one shape node). the promoted tip
 *  is reconciled to a well-formed tip: its explicit tangent is cleared to `Auto`
 *  and its heading re-derived (`headLast`) — the same reset a tip gets from
 *  `resetTangent`. returns true when a node was removed. */
export function removeTrailingHandle(ecs: State, sectionId: number): boolean {
    const last = lastHandle(ecs, sectionId);
    if (last === null) return false;
    if (sectionHandles(ecs, sectionId).length <= 2) return false;
    ecs.destroy(last);
    const handles = sectionHandles(ecs, sectionId);
    // the promoted node was authored as an interior node: its out-vector shaped the segment we
    // just deleted, so that vector is now ghost state pointing at where the trailing node stood.
    // an explicit node's `Handle.theta` is dead (`exitHeading`/the bake read the out-vector), so
    // `headLast` alone would silently no-op and the tip would report/extend along the stale
    // out-vector. clear to `Auto` first so `headLast` actually governs — a delete now yields the
    // same tip regardless of the promoted node's mode, indistinguishable from having authored the
    // shorter chain directly. undo restores the tangent (`trimTrack` snapshots after this).
    writeTangent(handles[handles.length - 1], undefined);
    headLast(handles); // the promoted tip re-derives its heading from its new predecessor
    return true;
}

// ── force points ─────────────────────────────────────────────────────────────

/** an authored force keyframe read off the ECS: eid + section, stable `id`,
 *  arclength `s` (from the section entry), and demanded force `g`. */
export interface ForceRow {
    eid: number;
    section: number;
    id: number;
    s: number;
    g: number;
}

/** every force point on a section, sorted by arclength — the order `forceProfile`
 *  and the timeline both consume. */
export function sectionForces(ecs: State, sectionId: number): ForceRow[] {
    const rows: ForceRow[] = [];
    for (const eid of ecs.query([Force])) {
        if (Force.section.get(eid) !== sectionId) continue;
        rows.push({
            eid,
            section: sectionId,
            id: Force.id.get(eid),
            s: Force.s.get(eid),
            g: Force.g.get(eid),
        });
    }
    rows.sort((a, b) => a.s - b.s);
    return rows;
}

/** resolve a force point by its stable `id` to its eid, or null (ids are globally
 *  unique — undo/redo never holds eids, so a recycled eid can't alias). */
export function forceAt(ecs: State, id: number): number | null {
    for (const eid of ecs.query([Force])) {
        if (Force.id.get(eid) === id) return eid;
    }
    return null;
}

// monotone id source — never reused, even after a delete (the section-id rationale).
let nextForceId = 0;

/** author a new force point on a section at `(s, g)` with a fresh stable id — the
 *  create path. returns the id (undo/redo addresses points by id, not eid). */
export function createForcePoint(ecs: State, sectionId: number, s: number, g: number): number {
    const eid = ecs.create();
    ecs.add(eid, Force);
    const id = nextForceId++;
    Force.section.set(eid, sectionId);
    Force.id.set(eid, id);
    Force.s.set(eid, s);
    Force.g.set(eid, g);
    return id;
}

/** re-create a force point at an *exact* section / id / s / g — undo of a delete,
 *  redo of a create, or a snapshot restore. no id allocation, so it round-trips
 *  byte-identical. */
export function spawnForce(ecs: State, sectionId: number, id: number, s: number, g: number): void {
    const eid = ecs.create();
    ecs.add(eid, Force);
    Force.section.set(eid, sectionId);
    Force.id.set(eid, id);
    Force.s.set(eid, s);
    Force.g.set(eid, g);
}

/** destroy a force point by stable id (no-op if already gone). */
export function destroyForce(ecs: State, id: number): void {
    const eid = forceAt(ecs, id);
    if (eid !== null) ecs.destroy(eid);
}

/** a force point's undoable state, keyed by stable id (+ its section, so a restore
 *  re-homes it). the drag/field gesture snapshots this. */
export interface ForcePointState {
    section: number;
    id: number;
    s: number;
    g: number;
}

/** snapshot one force point by id, or undefined if it's gone (the gesture opens
 *  nothing). */
export function forcePointState(ecs: State, id: number): ForcePointState | undefined {
    const eid = forceAt(ecs, id);
    if (eid === null) return undefined;
    return { section: Force.section.get(eid), id, s: Force.s.get(eid), g: Force.g.get(eid) };
}

/** write a force point's `s`/`g` (live drag preview + gesture restore). */
export function setForcePoint(ecs: State, id: number, s: number, g: number): void {
    const eid = forceAt(ecs, id);
    if (eid === null) return;
    Force.s.set(eid, s);
    Force.g.set(eid, g);
}

// ── force-section extent ──────────────────────────────────────────────────────

/** a force section's undoable extent, keyed by stable id — the end-handle drag
 *  gesture snapshots this. */
export interface SectionLengthState {
    id: number;
    length: number;
}

/** snapshot a section's extent by id, or undefined if it's gone. */
export function sectionLengthState(ecs: State, id: number): SectionLengthState | undefined {
    const eid = sectionAt(ecs, id);
    return eid === null ? undefined : { id, length: Section.length.get(eid) };
}

/** set a force section's extent (m), floored at the minimum — the end-handle drag +
 *  gesture restore. re-bakes on the next tick (the extent is in the bake hash). */
export function setSectionLength(ecs: State, id: number, length: number): void {
    const eid = sectionAt(ecs, id);
    if (eid === null) return;
    Section.length.set(eid, Math.max(MIN_FORCE_LEN, length));
}

// ── track initial speed (v0) ───────────────────────────────────────────────────

/** the track's undoable initial speed (m/s) — the START handle's scrub/type gesture
 *  snapshots this. */
export interface TrackV0State {
    v0: number;
}

/** snapshot a track's authored initial speed. */
export function trackV0State(trackEid: number): TrackV0State {
    return { v0: Track.v0.get(trackEid) };
}

/** set the track's initial speed (m/s), floored at MIN_V0 — the field/scrub write +
 *  gesture restore. re-bakes on the next tick (v0 is in the bake hash). */
export function setTrackV0(trackEid: number, v0: number): void {
    Track.v0.set(trackEid, Math.max(MIN_V0, v0));
}

// ── per-section kind + conversion ─────────────────────────────────────────────

/** one section's full undoable state: its identity/order, kind, force extent, its
 *  geo nodes, and its force points. a destructive convert (or a structural op)
 *  snapshots this before/after so undo is byte-identical. */
export interface SectionSnapshot {
    id: number;
    order: number;
    kind: SectionKind;
    length: number;
    nodes: NodeState[];
    points: { id: number; s: number; g: number }[];
}

/** capture a section (both kinds' payloads — one is empty). */
export function snapshotSection(ecs: State, sectionId: number): SectionSnapshot {
    const eid = sectionAt(ecs, sectionId);
    if (eid === null) throw new Error(`snapshotSection: no section ${sectionId}`);
    return {
        id: sectionId,
        order: Section.order.get(eid),
        kind: Section.kind.get(eid) as SectionKind,
        length: Section.length.get(eid),
        nodes: nodeSnapshot(ecs, sectionId),
        points: sectionForces(ecs, sectionId).map((p) => ({ id: p.id, s: p.s, g: p.g })),
    };
}

/** clear a section's payload and rebuild it verbatim from a snapshot — restores a
 *  convert (either direction) or a structural op byte-identical. the Section entity
 *  is assumed to exist (its order/kind/length are rewritten); nodes respawn by
 *  order, points by id, so eids recycle but identities don't. */
export function restoreSection(ecs: State, snap: SectionSnapshot): void {
    const eid = sectionAt(ecs, snap.id);
    if (eid === null) throw new Error(`restoreSection: no section ${snap.id}`);
    for (const h of sectionHandles(ecs, snap.id)) ecs.destroy(h);
    for (const p of sectionForces(ecs, snap.id)) ecs.destroy(p.eid);
    Section.order.set(eid, snap.order);
    Section.kind.set(eid, snap.kind);
    Section.length.set(eid, snap.length);
    for (const n of snap.nodes) spawnNode(ecs, snap.id, n.order, n.x, n.y, n.theta, n.tangent);
    for (const p of snap.points) spawnForce(ecs, snap.id, p.id, p.s, p.g);
}

/** destructively flip a section's kind to its opposite, resetting to that kind's
 *  default: geo → force clears the nodes for an empty profile (constant 1g)
 *  whose extent is the section's baked arclength; force → geo clears the points for
 *  the flat two-node seed. undo (a `snapshotSection` pair) makes it safe, so there's
 *  no confirmation. does not itself record history — `history.convertSection` wraps
 *  it. */
export function convertSection(ecs: State, sectionId: number): void {
    const eid = sectionAt(ecs, sectionId);
    if (eid === null) return;
    const kind = Section.kind.get(eid);
    if (kind === SectionKind.Geo) {
        for (const h of sectionHandles(ecs, sectionId)) ecs.destroy(h);
        Section.kind.set(eid, SectionKind.Force);
        Section.length.set(eid, DEFAULT_FORCE_LEN); // reset to the default extent, not inherited
    } else {
        for (const p of sectionForces(ecs, sectionId)) ecs.destroy(p.eid);
        Section.kind.set(eid, SectionKind.Geo);
        Section.length.set(eid, 0);
        addNode(ecs, sectionId, 0, 0);
        addNode(ecs, sectionId, EXTEND_DIST, 0);
    }
}

// ── structural ops (append / split / join / delete) ──────────────────────────
// each mutates the section chain directly; `history` wraps it in a whole-track
// snapshot pair so undo is byte-identical. geo split/join re-express nodes rigidly
// in the boundary frame (`place`/`localize`, exact to f32 round-off); force
// split/join partition + rebase points by arclength (lossless).

/** shift every section at or past `threshold` order by `delta` — makes room to
 *  insert (delta +1) or closes a gap after a remove (delta −1). */
function bumpOrders(ecs: State, threshold: number, delta: number): void {
    for (const eid of ecs.query([Section])) {
        const o = Section.order.get(eid);
        if (o >= threshold) Section.order.set(eid, o + delta);
    }
}

/** the section immediately after `sectionId` in the chain, or null at the end. */
function nextSection(ecs: State, sectionId: number): SectionRow | null {
    const secs = sections(ecs);
    const i = secs.findIndex((s) => s.id === sectionId);
    return i >= 0 && i + 1 < secs.length ? secs[i + 1] : null;
}

/** capture the whole track — every section (order/kind/length) with its nodes and
 *  points. the structural-op undo unit: a snapshot pair round-trips byte-identical
 *  (respawns the stored f32 verbatim), which is what makes the ops safely reversible. */
export function snapshotAll(ecs: State): SectionSnapshot[] {
    return sections(ecs).map((s) => snapshotSection(ecs, s.id));
}

/** clear the whole track and rebuild it from a snapshot (structural-op undo/redo). */
export function restoreAll(ecs: State, snaps: SectionSnapshot[]): void {
    for (const e of [...ecs.query([Section])]) ecs.destroy(e);
    for (const e of [...ecs.query([Handle])]) ecs.destroy(e);
    for (const e of [...ecs.query([Force])]) ecs.destroy(e);
    for (const snap of snaps) {
        spawnSection(ecs, snap.id, snap.order, snap.kind, snap.length);
        for (const n of snap.nodes) spawnNode(ecs, snap.id, n.order, n.x, n.y, n.theta, n.tangent);
        for (const p of snap.points) spawnForce(ecs, snap.id, p.id, p.s, p.g);
    }
}

/** append a new section of `kind` at the end of the chain. geo gets the flat
 *  two-node seed (its entry is the prior exit, so it opens straight along the
 *  running heading); force gets an empty default-length profile. returns the id. */
export function appendSection(ecs: State, kind: SectionKind): number {
    const order = sections(ecs).length;
    const id = createSection(ecs, order, kind, kind === SectionKind.Force ? DEFAULT_FORCE_LEN : 0);
    if (kind === SectionKind.Geo) {
        addNode(ecs, id, 0, 0);
        addNode(ecs, id, EXTEND_DIST, 0);
    }
    return id;
}

/** the track's nominal spacing (the bake's `ds`) — read from the Track component so
 *  a re-frame samples at the same density the bake does. */
function trackDs(ecs: State): number {
    for (const t of ecs.query([Track])) return Track.ds.get(t);
    return DS_NOMINAL;
}

/** the recovered exit state of a geo section's head chain `[0..k]`, in the section's
 *  local frame — the exact frame the bake places the downstream tail at (`evalGeo` →
 *  `exitOf`). split/join must re-express against THIS heading, not the boundary node's
 *  stored `Handle.theta`: an explicit tangent decouples `Handle.theta` from the curve's
 *  recovered tangent, so a stored-theta frame rotates the whole downstream section. the
 *  recovered exit IS the bake's downstream entry, so `place∘localize` telescopes and the
 *  shape is preserved. (`v` is geometry-irrelevant — `place`/`localize` are pure rigid
 *  transforms; the recovered heading/position are v-independent.) */
function headExit(ecs: State, handles: readonly number[], k: number): Entry {
    const nodes: Node[] = [];
    for (let i = 0; i <= k; i++) {
        nodes.push({
            x: Handle.pos.x.get(handles[i]),
            y: Handle.pos.y.get(handles[i]),
            theta: Handle.theta.get(handles[i]),
            tangent: readTangent(handles[i]),
        });
    }
    return evalGeo({ x: 0, y: 0, theta: 0, v: V0 }, nodes, trackDs(ecs)).exit;
}

/** split a geo section at an interior node (order `k`, 1 ≤ k ≤ n−1): the head keeps
 *  nodes [0..k], a new section takes [k..n] re-expressed in the head's recovered
 *  boundary frame (rigid — its node 0 becomes {0,0,0} at heading 0 only when the
 *  boundary is Auto; an explicit-tangent boundary carries a nonzero node-0 heading
 *  that compensates the recovered-vs-stored gap). node k stays the head's new tip.
 *  no-op at the entry or last node. returns the new (tail) section id, or null. */
export function splitGeo(ecs: State, sectionId: number, k: number): number | null {
    const secEid = sectionAt(ecs, sectionId);
    if (secEid === null || Section.kind.get(secEid) !== SectionKind.Geo) return null;
    const handles = sectionHandles(ecs, sectionId);
    const n = handles.length - 1;
    if (k < 1 || k >= n) return null;

    // re-frame against the head's RECOVERED exit (the bake's downstream entry), not the
    // boundary node's stored heading — see `headExit`.
    const frame = headExit(ecs, handles, k);
    const order = Section.order.get(secEid);
    bumpOrders(ecs, order + 1, +1);
    const bId = createSection(ecs, order + 1, SectionKind.Geo, 0);
    for (let i = k; i <= n; i++) {
        const bl = localize(frame, {
            x: Handle.pos.x.get(handles[i]),
            y: Handle.pos.y.get(handles[i]),
            theta: Handle.theta.get(handles[i]),
            tangent: readTangent(handles[i]),
        });
        spawnNode(ecs, bId, i - k, bl.x, bl.y, bl.theta, bl.tangent);
    }
    for (let i = k + 1; i <= n; i++) ecs.destroy(handles[i]); // trim the head to [0..k]
    return bId;
}

/** split a force section at arclength `s` (0 < s < length): the head keeps extent
 *  [0, s] and its points there; a new section takes extent [s, length] with the
 *  remaining points rebased to its entry (a lossless partition). no-op outside
 *  the interior. returns the new (tail) section id, or null. */
export function splitForce(ecs: State, sectionId: number, s: number): number | null {
    const secEid = sectionAt(ecs, sectionId);
    if (secEid === null || Section.kind.get(secEid) !== SectionKind.Force) return null;
    const len = Section.length.get(secEid);
    if (s <= 0 || s >= len) return null;

    const order = Section.order.get(secEid);
    bumpOrders(ecs, order + 1, +1);
    const bId = createSection(ecs, order + 1, SectionKind.Force, len - s);
    for (const p of sectionForces(ecs, sectionId)) {
        if (p.s >= s) {
            Force.section.set(p.eid, bId);
            Force.s.set(p.eid, p.s - s);
        }
    }
    Section.length.set(secEid, s);
    return bId;
}

/** join a section with the next one in the chain (same-kind only). geo appends the
 *  neighbor's shape nodes re-expressed in the head's tip frame (exact inverse of a
 *  geo split); force concatenates the extents and rebases the neighbor's points. the
 *  neighbor is removed and downstream orders close up. returns true when joined. */
export function joinNext(ecs: State, sectionId: number): boolean {
    const aEid = sectionAt(ecs, sectionId);
    const b = nextSection(ecs, sectionId);
    if (aEid === null || b === null) return false;
    const aKind = Section.kind.get(aEid) as SectionKind;
    if (aKind !== b.kind) return false;

    if (aKind === SectionKind.Geo) {
        const aHandles = sectionHandles(ecs, sectionId);
        const aN = aHandles.length - 1;
        // place B against A's RECOVERED exit (the bake's downstream entry, the exact
        // inverse of a geo split), not A's stored tip heading — see `headExit`.
        const frame = headExit(ecs, aHandles, aN);
        const bHandles = sectionHandles(ecs, b.id);
        // skip B node 0 (== the shared boundary, already A's tip); append B[1..m].
        for (let j = 1; j < bHandles.length; j++) {
            const w = place(frame, {
                x: Handle.pos.x.get(bHandles[j]),
                y: Handle.pos.y.get(bHandles[j]),
                theta: Handle.theta.get(bHandles[j]),
                tangent: readTangent(bHandles[j]),
            });
            spawnNode(ecs, sectionId, aN + j, w.x, w.y, w.theta, w.tangent);
        }
        for (const h of bHandles) ecs.destroy(h);
    } else {
        const aLen = Section.length.get(aEid);
        for (const p of sectionForces(ecs, b.id)) {
            Force.section.set(p.eid, sectionId);
            Force.s.set(p.eid, p.s + aLen);
        }
        Section.length.set(aEid, aLen + b.length);
    }
    ecs.destroy(b.eid);
    bumpOrders(ecs, b.order + 1, -1);
    return true;
}

/** delete a section and its payload; downstream sections close the gap and rebase
 *  rigidly (their nodes are section-local, so the bake re-places them at the new
 *  upstream exit). refuses to remove the last remaining section. returns true
 *  when deleted. */
export function deleteSection(ecs: State, sectionId: number): boolean {
    const secEid = sectionAt(ecs, sectionId);
    if (secEid === null) return false;
    if (sections(ecs).length <= 1) return false; // keep at least one section
    const order = Section.order.get(secEid);
    for (const h of sectionHandles(ecs, sectionId)) ecs.destroy(h);
    for (const p of sectionForces(ecs, sectionId)) ecs.destroy(p.eid);
    ecs.destroy(secEid);
    bumpOrders(ecs, order + 1, -1);
    return true;
}

function seed(ecs: State): void {
    createTrack(ecs);
    // one geo section: node 0 at the local origin (the fixed start anchor) + a flat
    // extension-length shape node. the whole track launches level from `START`.
    const id = createSection(ecs, 0, SectionKind.Geo, 0);
    addNode(ecs, id, 0, 0);
    addNode(ecs, id, EXTEND_DIST, 0);
}

// ── bake ─────────────────────────────────────────────────────────────────────

/** a geo section's payload: its section-local nodes (node 0 at {0,0,0}) + the shared
 *  nominal spacing. the substrate places them rigidly at the running chain entry. */
function geoPayload(ecs: State, sectionId: number, ds: number): SectionSpec {
    const nodes: Node[] = sectionHandles(ecs, sectionId).map((eid) => ({
        x: Handle.pos.x.get(eid),
        y: Handle.pos.y.get(eid),
        theta: Handle.theta.get(eid),
        tangent: readTangent(eid),
    }));
    return { kind: "geo", nodes, ds };
}

/** a force section's payload: its authored points gathered into a dense per-edge
 *  F_n(σ) profile over the section extent + the shared spacing. */
function forcePayload(ecs: State, sectionId: number, length: number, ds: number): SectionSpec {
    const points: ForcePoint[] = sectionForces(ecs, sectionId).map((p) => ({ s: p.s, g: p.g }));
    return { kind: "force", fN: forceProfile(points, length, ds), ds };
}

/** input-state hash that gates the bake: the shared ds + initial speed, then every
 *  section in order — its id/order/kind, and its authored payload (a geo section's
 *  node poses, a force section's extent + points). BakeSystem re-bakes on a miss
 *  (anything moved, added, removed, converted, reordered, or the v0 retimed), skips
 *  otherwise. */
function bakeHash(ecs: State, secs: SectionRow[], ds: number, v0: number): string {
    let h = `ds${ds}v0${v0}`;
    for (const sec of secs) {
        h += `|S${sec.id}:${sec.order}:${sec.kind}`;
        if (sec.kind === SectionKind.Force) {
            h += `:L${sec.length}`;
            for (const p of sectionForces(ecs, sec.id)) h += `,${p.id}=${p.s}:${p.g}`;
        } else {
            for (const eid of sectionHandles(ecs, sec.id)) {
                h += `,${Handle.pos.x.get(eid)}:${Handle.pos.y.get(eid)}:${Handle.theta.get(eid)}`;
                const mode = Handle.tmode.get(eid);
                if (mode !== TANGENT_AUTO) {
                    h += `~${mode}:${Handle.tin.x.get(eid)}:${Handle.tin.y.get(eid)}:${Handle.tout.x.get(eid)}:${Handle.tout.y.get(eid)}`;
                }
            }
        }
    }
    return h;
}

type BakeOut = NonNullable<ReturnType<typeof bakeOut.get>>;

/** per-sample cumulative time `t[i] = Σ_{k<i} ds_k / v̄_k` plus the diagnostic
 *  feasibility flag. v̄ floors at V_FLOOR so energy-depleted regions take
 *  long-but-finite time; `feasible[i] = |v[i]| ≥ V_WARN` drives the red-track UX
 *  (warning threshold above the numerical floor). */
function computeTime(s: Samples, out: BakeOut, count: number): void {
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

/** the bake: thread the section chain from `START` into one flat SoA + per-section
 *  metadata. each geo section contributes its local nodes (placed rigidly at the
 *  running entry — an upstream edit rigidly carries downstream); each force
 *  section its integrated-then-recovered profile. writes `samples` + `bakeOut`,
 *  syncs each geo node's global sample index, and records `sectionInfo` (entry,
 *  range, arclength, orphan cutoff) the drag/render read. skips (keeps the prior
 *  bake) when a geo section is below its two-node floor or the chain degenerates. */
function bake(ecs: State, trackEid: number, s: Samples, out: BakeOut, secs: SectionRow[]): void {
    const ds = Track.ds.get(trackEid);
    const v0 = Track.v0.get(trackEid);
    const start = startEntry(v0);

    // a geo section needs ≥2 nodes to bake; if any is short, keep the prior bake
    // rather than half-render the chain.
    for (const sec of secs) {
        if (sec.kind === SectionKind.Geo && sectionHandles(ecs, sec.id).length < 2) return;
    }

    const payloads = secs.map((sec) =>
        sec.kind === SectionKind.Geo
            ? geoPayload(ecs, sec.id, ds)
            : forcePayload(ecs, sec.id, sec.length, ds),
    );
    const c = chain(start, payloads, MAX_SAMPLES);
    const count = c.count;
    if (count < 2) return; // fully degenerate first section — keep the prior bake

    let truncatedAny = false;
    for (let k = 0; k < secs.length; k++) {
        const r = c.results[k];
        const range = c.ranges[k];
        const entry = k === 0 ? start : c.exits[k - 1];

        if (secs[k].kind === SectionKind.Geo) {
            const hs = sectionHandles(ecs, secs[k].id);
            for (let n = 0; n < r.offsets.length; n++) {
                Handle.sample.set(hs[n], range.start + r.offsets[n]);
            }
        }
        sectionInfo.set(secs[k].id, {
            entry,
            startSample: range.start,
            endSample: range.end,
            bakedNodes: r.offsets.length,
        });
        if (r.truncated) truncatedAny = true;
    }
    if (truncatedAny) {
        console.warn(
            `kex2d: track ${trackEid} hit MAX_SAMPLES=${MAX_SAMPLES}; trailing nodes dropped`,
        );
    }

    s.posX.set(c.posX.subarray(0, count));
    s.posY.set(c.posY.subarray(0, count));
    s.theta.set(c.theta.subarray(0, count));
    s.v.set(c.v.subarray(0, count));
    out.fN.set(c.fN.subarray(0, count - 1));
    out.ds.set(c.ds.subarray(0, count - 1));
    out.hash = bakeHash(ecs, secs, ds, v0);
    Track.count.set(trackEid, count);
    computeTime(s, out, count);
}

export const BakeSystem: System = {
    update(ecs: State): void {
        for (const trackEid of ecs.query([Track])) {
            const s = samples.get(trackEid);
            const out = bakeOut.get(trackEid);
            if (!s || !out) continue;
            const secs = sections(ecs);
            if (secs.length === 0) continue;
            const hash = bakeHash(ecs, secs, Track.ds.get(trackEid), Track.v0.get(trackEid));
            if (hash === out.hash) continue; // nothing changed — reuse the bake
            bake(ecs, trackEid, s, out, secs);
        }
    },
};

export const TrackPlugin: Plugin = {
    name: "Track",
    components: { Track, Section, Handle, Force },
    traits: {
        Track: { defaults: () => ({ count: 0, ds: 0, v0: V0 }) },
        Section: { defaults: () => ({ id: 0, order: 0, kind: 0, length: 0 }) },
        Handle: {
            defaults: () => ({
                section: 0,
                order: 0,
                sample: 0,
                pos: [0, 0],
                theta: 0,
                tmode: TANGENT_AUTO,
                tin: [0, 0],
                tout: [0, 0],
            }),
        },
        Force: { defaults: () => ({ section: 0, id: 0, s: 0, g: 0 }) },
    },
    initialize(ecs) {
        seed(ecs);
    },
    systems: [BakeSystem],
};
