/** the kex2d document — a canonical, lossless text form of the authored ECS state
 *  (`kex2d/AGENTS.md` § Authoring API): the `Track` authored scalars (`ds`/`domain`/
 *  `friction`/`resistance` — NOT `count`, bake-derived, `BakeSystem` writes it, `track.ts:3920`)
 *  plus every section/node/force-point, strip/strip-keyframe, and the track-start one-shot.
 *  `.kex`, JSON inside, text canonical (spec Locked decision) — the glTF/`.ipynb` shape.
 *
 *  **Canonical emitter, not `JSON.stringify(doc, null, 2)`.** Determinism + diff-readability are
 *  emitter discipline: fixed key order per entity (mirroring each component's own field order),
 *  sections ordered by `order`, nodes by `order`, force points/strips/strip-keyframes by `id`
 *  (their STABLE identity — never by `s`/`start`, which `sectionForces`/`allStrips`/
 *  `stripKeyframes` sort by for the bake's own reasons; sorting the document by a value a drag
 *  can move would reorder the emitted list on every edit). One entity per line.
 *
 *  **f32 exactness.** Every stored scalar here is f32 (`sparse(f32)`/`vec2`'s lanes); a
 *  `Component.get` widens it to the f64 that represents the SAME bits, and `JSON.stringify`
 *  emits the shortest decimal that round-trips to that exact f64 (the JS number-to-string
 *  algorithm) — parse recovers the identical f64, and the f32 component write
 *  (`Math.fround` under the hood) restores identical bits. Never reach for `toFixed`/rounding
 *  here — that's exactly the exactness this module exists to hold.
 *
 *  **Validate fully before touching the ECS.** `loadDocument` parses + validates the WHOLE text
 *  first; a refused load throws and leaves the live document untouched (Locked decision:
 *  "a refused load leaves the live document untouched"). */

import { State } from "@dylanebert/shallot";
import type { Refusal } from "./commands";
import { history } from "./history";
import { type LaneSegment, type Lanes, emptyLanes } from "./lanes";
import { Easing, type ForcePoint, sampleForce } from "./profile";
import { Domain } from "./section";
import { type Node, sampleChain, TangentMode, type Tangent } from "./spline";
import {
    allStrips,
    createTrack,
    DS_NOMINAL,
    MAX_SAMPLES,
    MIN_FORCE_LEN,
    MIN_V0,
    type NodeState,
    refreshVelocityRunMembers,
    reserveIds,
    restoreAll,
    type SectionSnapshot,
    SectionKind,
    stripCoversOneEdge,
    stripOverlapped,
    type StripSnapshot,
    snapshotAll,
    Track,
    trackEntity,
    type TrackSnapshot,
    validCoefficient,
    validStripValue,
} from "./track";

/** the document format's own version — forward-only migrations (below) bridge an older file up
 *  to this. Bumped when the authored shape changes. v1 → v2 (`kex2d-segment-removal` S3) drops
 *  explicit per-keyframe force handles (`DocPoint.tangent`, the `ForceTangent`/`Offset` shape) —
 *  the ECS can no longer author one, so a v1 file carrying that key has it silently dropped on
 *  load; a v1 file's geo tangents (`DocNode.tangent`) are untouched, a structurally distinct key
 *  on a distinct entity. migrations stay cheap by design (one function per version step, applied
 *  in sequence). */
/** v3 → v4 (`kex2d-segment-gestures` S1) opens the LANE substrate on the wire: `lanes.velocity`,
 *  `lanes.force` and `lanes.geo` of two-handle {@link LaneSegment} records, the track-level
 *  `track.end` (absent/0 = follow the longest lane) and `track.v0` replacing the `oneShot`
 *  array. `migrations[3]` derives every lane record from the v3 payload document-to-document
 *  (no ECS, no bake) and moves the one-shot's value onto `track.v0`.
 *
 *  **Bridged until S2.** The v4 wire still carries the v3 `segments`/`strips` payload beside the
 *  lanes, and the ECS load/save path still reads THAT payload: the live store speaks lanes only
 *  from S2 (spec Approach 2), so S1 writes the new grammar alongside the authoritative old one
 *  rather than cutting the store over inside a wire stage. S2 deletes `segments`/`strips` from
 *  this file and makes `lanes` the only authored payload. */
export const CURRENT_VERSION = 4;

// ── wire types (post-parse, post-migration — always shaped exactly like this) ────────────────

export interface DocTrack {
    ds: number;
    domain: number;
    friction: number;
    resistance: number;
    /** authored track end in metres of arclength. Absent (or 0) means FOLLOW: the end is the
     *  longest lane's last exit (`lanes.trackEnd`). No ECS column backs this until S2, so
     *  `docFromEcs` never emits it and a file carrying it round-trips it unchanged. */
    end?: number;
    /** authored initial speed (m/s), replacing v3's `oneShot` array. Absent means no authored
     *  start speed: the entry speed falls back to `track.V0`, exactly as an absent one-shot
     *  does today (`track.entrySpeed`). */
    v0?: number;
}

export interface DocGeoTangent {
    mode: number;
    inX: number;
    inY: number;
    outX: number;
    outY: number;
}

export interface DocNode {
    order: number;
    x: number;
    y: number;
    theta: number;
    tangent?: DocGeoTangent;
}

export interface DocForceBoundary {
    g: number;
    ease: number;
}

export interface DocPoint {
    id: number;
    /** Station ownership remains on the force point until S2b3. */
    s: number;
    /** The value and leading-key easing are authored by the terminating boundary. */
    boundary: DocForceBoundary;
}

export interface DocSegment {
    /** Stable canonical segment identity. */
    id: number;
    order: number;
    kind: number;
    /** Stable run identity; the run's first record has id === run. */
    run: number;
    /** Force-only conserved run-local entry station. */
    station?: number;
    /** Force-only conserved run extent, present on exactly the terminal record. */
    extent?: number;
    /** Geo-only terminating node's run-global order. */
    node?: number;
    /** Geo payload (node zero rides the first record); empty on force records. */
    nodes: DocNode[];
    /** Force points at run-local absolute stations; empty on geo records. */
    points: DocPoint[];
}

export interface DocStripKeyframe {
    id: number;
    s: number;
    v: number;
}

export interface DocStrip {
    id: number;
    start: number;
    end: number;
    value: number;
    keyframes: DocStripKeyframe[];
}

export interface Kex2dDocument {
    version: number;
    track: DocTrack;
    /** the canonical v4 authored substrate: independent per-parameter lanes of two-handle
     *  segments (`lanes.ts`). */
    lanes: Lanes;
    /** @temporary S2 — the v3 chain payload the live ECS still loads from. */
    segments: DocSegment[];
    /** @temporary S2 — the v3 velocity payload the live ECS still loads from; `lanes.velocity`
     *  is derived from it and carries the same authored content in the new grammar. */
    strips: DocStrip[];
    /** @temporary S2 — the track-start one-shot's surviving identity; its value is `track.v0`. */
    oneShot: DocOneShot[];
}

/** @temporary S2 — the track-start one-shot's stable IDENTITY, and nothing else: `track.v0`
 *  replaced its value in v4, but the ECS still addresses the row by id until S2 retires
 *  `OneShot`, and dropping the id would renumber it across a save → load cycle. */
export interface DocOneShot {
    id: number;
}

// ── lane derivation (pure: v3 payload → v4 lanes) ───────────────────────────────────────────
//
// One function shared by `migrations[3]` (a v3 file's lanes) and `docFromEcs` (the live ECS's
// lanes, read off the same v3 payload it already emits), so the two can never disagree and a
// migrated document is a fixed point of a save.
//
// **The arclength axis.** Velocity strips are already TRACK-GLOBAL arclength, so the velocity
// lane migrates exactly. A force run's own extent is authored (`extent`); a GEO run's is not —
// it is read from the baked edge (spec Locked decision: "geo extent is read from the baked edge
// ... never a position chord"). So this derivation re-samples each geo run's own nodes through
// `spline.sampleChain` — the same sampler `track.geoChordDs` runs and the same per-edge `ds` the
// bake publishes, and frame-invariant, so no entry placement is needed — and sums those edges for
// the run's length and each member's span. Every lane record's `start`, and every velocity/force
// `end`, is therefore authored ABSOLUTE arclength; a geo record's `end` is the derived column the
// last bake wrote and `deriveRuns` cuts on, rewritten after every bake, never read as truth.
//
// The one limit: `chain` truncates a track at `MAX_SAMPLES` across the WHOLE chain, while this
// samples each geo run against the full budget. A document already past the budget therefore
// migrates with a longer tail than it bakes — the same degraded regime the bake itself warns
// about, and no document in the corpus reaches it.

/** the boundary value list for one strip: the strip's own span ends plus every keyframe strictly
 *  inside it, deduplicated and ordered. Splitting here is the whole "strip → adjacent segments"
 *  rule (spec Locked decision). */
function stripBoundaries(st: DocStrip): number[] {
    const inner = st.keyframes
        .map((k) => k.s)
        .filter((s) => s > st.start && s < st.end)
        .sort((a, b) => a - b);
    const out: number[] = [st.start];
    for (const s of inner) if (s !== out[out.length - 1]) out.push(s);
    if (st.end !== out[out.length - 1]) out.push(st.end);
    return out;
}

/** the speed a strip prescribes AT station `s`: a keyframe sitting exactly there (highest id
 *  wins, matching the emitter's own id ordering), else the strip's own `value` — which is what a
 *  KEYFRAMELESS strip has everywhere, so such a strip migrates to one constant segment with
 *  `entry === exit === value`. */
function stripValueAt(st: DocStrip, s: number): number {
    let best: DocStripKeyframe | undefined;
    for (const k of st.keyframes) if (k.s === s && (!best || k.id > best.id)) best = k;
    return best ? best.v : st.value;
}

/** every velocity lane record for one strip: one per adjacent `[boundary, boundary)` span, each
 *  owning its entry (a v3 strip authors a value at every one of its own boundaries, so nothing
 *  is inferred). */
function velocityLane(strips: DocStrip[], nextId: () => number): LaneSegment[] {
    const out: LaneSegment[] = [];
    for (const st of strips) {
        if (!(st.start < st.end)) continue;
        const bounds = stripBoundaries(st);
        for (let i = 0; i + 1 < bounds.length; i++) {
            out.push({
                id: nextId(),
                start: bounds[i]!,
                end: bounds[i + 1]!,
                ease: Easing.Linear,
                entry: stripValueAt(st, bounds[i]!),
                exit: stripValueAt(st, bounds[i + 1]!),
            });
        }
    }
    return out;
}

/** the v3 payload's runs, in chain order: contiguous same-`run` members, each carrying the run's
 *  kind, its members and its terminal extent (0 for a geo run, whose extent is bake-derived). */
function runsOf(segments: DocSegment[]): { kind: number; members: DocSegment[]; extent: number }[] {
    const ordered = segments.slice().sort((a, b) => a.order - b.order);
    const out: { kind: number; members: DocSegment[]; extent: number }[] = [];
    for (const member of ordered) {
        const last = out[out.length - 1];
        const head = last?.members[0];
        if (last && head && head.run === member.run && head.kind === member.kind) {
            last.members.push(member);
        } else {
            out.push({ kind: member.kind, members: [member], extent: 0 });
        }
    }
    for (const run of out) {
        if (run.kind !== SectionKind.Force) continue;
        for (const member of run.members)
            if (member.extent !== undefined) run.extent = member.extent;
    }
    return out;
}

/** one geo run's nodes as the pure `spline.Node` list its sampler reads, in run-global order.
 *  `Handle.order` is run-global (`track.spliceGeoMembers`), so concatenating the members' node
 *  arrays and sorting by `order` rebuilds the run's own chain. */
function runNodes(members: DocSegment[]): Node[] {
    return members
        .flatMap((m) => m.nodes)
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((n) => ({ x: n.x, y: n.y, theta: n.theta, tangent: fromDocTangent(n.tangent) }));
}

/** the derived arclength span of each member of one geo run, in run-local metres: the sampled
 *  per-edge `ds` summed between the members' terminating nodes. A run whose chain cannot sample
 *  (fewer than two nodes) spans zero, which is what its degenerate bake publishes. */
function geoMemberSpans(members: DocSegment[], ds: number): number[] {
    const nodes = runNodes(members);
    const posX = new Float32Array(MAX_SAMPLES);
    const posY = new Float32Array(MAX_SAMPLES);
    const dsArr = new Float32Array(Math.max(1, MAX_SAMPLES - 1));
    const r = sampleChain(nodes, ds, posX, posY, dsArr, MAX_SAMPLES);
    const spans: number[] = [];
    for (let i = 0; i < members.length; i++) {
        const lo = r.offsets[i];
        const hi = r.offsets[i + 1];
        let len = 0;
        if (lo !== undefined && hi !== undefined) for (let e = lo; e < hi; e++) len += dsArr[e]!;
        spans.push(len);
    }
    return spans;
}

/** the force lane records for ONE force run, in run-local stations offset by `cursor`.
 *
 *  The run's authored keys become its boundary stations; the span between two of them is one
 *  record whose `ease` is the LEADING key's tag, because `profile.ts` gives the leading keyframe
 *  the following segment (the Blender F-curve convention) — a trailing tag would silently change
 *  the shape. The FIRST record owns its entry at `sampleForce(points, 0)`, which is exactly the
 *  value `track.materializeRunForceClamps` materializes for the run's own start, so no migrated
 *  run reads an inferred entry; a KEYLESS run becomes one flat `DEFAULT_G` record owning both
 *  handles, matching the same clamp. A key past the run's authored extent is out of the run and
 *  is dropped from the partition (it still shapes `sampleForce`, as it shapes the profile). */
function forceRunLane(
    run: { members: DocSegment[]; extent: number },
    cursor: number,
    nextId: () => number,
): LaneSegment[] {
    const keys = run.members
        .flatMap((m) => m.points)
        .slice()
        .sort((a, b) => a.s - b.s || a.id - b.id);
    const points: ForcePoint[] = keys.map((k) => ({
        s: k.s,
        g: k.boundary.g,
        ease: k.boundary.ease,
    }));
    const easeAt = new Map<number, Easing>();
    for (const k of keys) easeAt.set(k.s, k.boundary.ease);

    const stations = [0];
    for (const k of keys) {
        if (k.s > 0 && k.s <= run.extent && k.s !== stations[stations.length - 1])
            stations.push(k.s);
    }
    if (run.extent > stations[stations.length - 1]!) stations.push(run.extent);
    if (stations.length < 2) return [];

    const out: LaneSegment[] = [];
    for (let i = 0; i + 1 < stations.length; i++) {
        const start = stations[i]!;
        const end = stations[i + 1]!;
        out.push({
            id: nextId(),
            start: cursor + start,
            end: cursor + end,
            ease: easeAt.get(start) ?? Easing.Linear,
            ...(i === 0 ? { entry: sampleForce(points, 0) } : {}),
            exit: sampleForce(points, end),
        });
    }
    return out;
}

/** the force and geo lane records for one v3 payload, walked along the chain's arclength axis
 *  (see the module note above for how a geo run's length is resolved). */
function chainLanes(
    segments: DocSegment[],
    ds: number,
    nextId: () => number,
): { force: LaneSegment[]; geo: LaneSegment[] } {
    const force: LaneSegment[] = [];
    const geo: LaneSegment[] = [];
    let cursor = 0;
    for (const run of runsOf(segments)) {
        if (run.kind === SectionKind.Force) {
            force.push(...forceRunLane(run, cursor, nextId));
            cursor += run.extent;
        } else {
            // Geo: one record per member, each terminating at that member's own boundary node
            // over the span the sampler derives for it.
            const spans = geoMemberSpans(run.members, ds);
            for (let i = 0; i < run.members.length; i++) {
                const member = run.members[i]!;
                const nodes = member.nodes.slice().sort((a, b) => a.order - b.order);
                const exitNode = nodes[nodes.length - 1];
                const entryNode = nodes.find((n) => n.order === 0);
                geo.push({
                    id: nextId(),
                    start: cursor,
                    end: cursor + spans[i]!,
                    ease: Easing.Linear,
                    ...(entryNode ? { entry: entryNode.theta } : {}),
                    exit: exitNode ? exitNode.theta : 0,
                });
                cursor += spans[i]!;
            }
        }
    }
    return { force, geo };
}

/** every lane of a v3 payload, in one shared id namespace (velocity, then force, then geo) so a
 *  lane record's identity is unique across the whole document. */
export function lanesFromChain(segments: DocSegment[], strips: DocStrip[], ds: number): Lanes {
    let next = 0;
    const nextId = () => next++;
    const velocity = velocityLane(strips, nextId);
    const { force, geo } = chainLanes(segments, ds, nextId);
    return { velocity, force, geo };
}

// ── ECS → document ─────────────────────────────────────────────────────────────────────────

function toDocTangent(t: Tangent | undefined): DocGeoTangent | undefined {
    return t ? { mode: t.mode, inX: t.inX, inY: t.inY, outX: t.outX, outY: t.outY } : undefined;
}

function toDocSegment(s: SectionSnapshot, terminal: boolean): DocSegment {
    return {
        id: s.id,
        order: s.order,
        kind: s.kind,
        run: s.run,
        ...(s.kind === SectionKind.Force
            ? { station: s.runStation, ...(terminal ? { extent: s.runExtent } : {}) }
            : { node: s.geoEndNode }),
        nodes: s.nodes
            .slice()
            .sort((a, b) => a.order - b.order)
            .map((n) => ({
                order: n.order,
                x: n.x,
                y: n.y,
                theta: n.theta,
                tangent: toDocTangent(n.tangent),
            })),
        points: s.points
            .slice()
            .sort((a, b) => a.id - b.id)
            .map((p) => ({
                id: p.id,
                s: s.runStation + p.s,
                boundary: { g: p.g, ease: p.ease },
            })),
    };
}

function toDocStrip(st: StripSnapshot): DocStrip {
    return {
        id: st.id,
        start: st.start,
        end: st.end,
        value: st.value,
        keyframes: st.keyframes
            .slice()
            .sort((a, b) => a.id - b.id)
            .map((k) => ({ id: k.id, s: k.s, v: k.v })),
    };
}

/** the whole live document — every authored ECS component, canonically ordered. `snapshotAll`
 *  supplies sections/strips/one-shot (already section-order / node-order sorted; force
 *  points/strips/keyframes re-sorted here from their bake-order `s`/`start` reads to their
 *  stable `id`); the four `Track` scalars ride separately (`snapshotAll`'s `TrackSnapshot`
 *  carries no track-global column — `count` is bake output and stays out on purpose). */
export function docFromEcs(ecs: State): Kex2dDocument {
    const snap = snapshotAll(ecs);
    const trackEid = trackEntity(ecs);
    const track: DocTrack =
        trackEid === null
            ? { ds: DS_NOMINAL, domain: Domain.Distance, friction: 0, resistance: 0 }
            : {
                  ds: Track.ds.get(trackEid),
                  domain: Track.domain.get(trackEid),
                  friction: Track.friction.get(trackEid),
                  resistance: Track.resistance.get(trackEid),
              };
    const segments = (() => {
        const ordered = snap.segments.slice().sort((a, b) => a.order - b.order);
        return ordered.map((member, index) =>
            toDocSegment(member, ordered[index + 1]?.run !== member.run),
        );
    })();
    const strips = snap.strips
        .slice()
        .sort((a, b) => a.id - b.id)
        .map(toDocStrip);
    const v0 = snap.oneShot[0]?.value;
    return {
        version: CURRENT_VERSION,
        track: { ...track, ...(v0 === undefined ? {} : { v0 }) },
        lanes: lanesFromChain(segments, strips, track.ds),
        segments,
        strips,
        oneShot: snap.oneShot.map((o) => ({ id: o.id })),
    };
}

// ── document → ECS ─────────────────────────────────────────────────────────────────────────

function fromDocTangent(t: DocGeoTangent | undefined): Tangent | undefined {
    return t
        ? { mode: t.mode as TangentMode, inX: t.inX, inY: t.inY, outX: t.outX, outY: t.outY }
        : undefined;
}

function fromDocSegment(s: DocSegment, length: number, runExtent: number): SectionSnapshot {
    const station = s.station ?? 0;
    return {
        id: s.id,
        order: s.order,
        kind: s.kind as SectionKind,
        length,
        run: s.run,
        runStation: station,
        runExtent,
        geoEndNode: s.node ?? s.nodes.at(-1)?.order ?? 0,
        nodes: s.nodes.map(
            (n): NodeState => ({
                order: n.order,
                x: n.x,
                y: n.y,
                theta: n.theta,
                tangent: fromDocTangent(n.tangent),
            }),
        ),
        points: s.points.map((p) => ({
            id: p.id,
            s: p.s - station,
            g: p.boundary.g,
            ease: p.boundary.ease as Easing,
        })),
    };
}

/** the document's sections/strips/one-shot, projected back onto `restoreAll`'s own
 *  `TrackSnapshot` shape — the four `Track` scalars are applied separately by the caller
 *  (`restoreAll` never touches the `Track` component itself). */
export function docToTrackSnapshot(doc: Kex2dDocument): TrackSnapshot {
    const runExtents = new Map<number, number>();
    for (const segment of doc.segments)
        if (segment.extent !== undefined) runExtents.set(segment.run, segment.extent);
    const segments = doc.segments.map((segment, index) => {
        if (segment.kind === SectionKind.Geo) return fromDocSegment(segment, 0, 0);
        const runExtent = runExtents.get(segment.run)!;
        const terminal = doc.segments[index + 1]?.run !== segment.run;
        const end = terminal ? runExtent : doc.segments[index + 1]!.station!;
        return fromDocSegment(segment, Math.fround(end - segment.station!), runExtent);
    });
    return {
        segments,
        strips: doc.strips.map((st) => ({
            id: st.id,
            start: st.start,
            end: st.end,
            value: st.value,
            keyframes: st.keyframes.map((k) => ({ id: k.id, s: k.s, v: k.v })),
        })),
        // Bridged until S2: the value comes from `track.v0`, the identity from the surviving
        // `oneShot` row. No `v0` means no row, exactly as an absent v3 `oneShot` did:
        // `entrySpeed` falls back to `V0`.
        oneShot:
            doc.track.v0 === undefined
                ? []
                : doc.oneShot.map((o) => ({ id: o.id, value: doc.track.v0 as number })),
    };
}

// ── canonical text emitter ────────────────────────────────────────────────────────────────

/** a JSON number literal for `n` — `String(n)` (the same shortest-round-trip algorithm
 *  `JSON.stringify` uses for a number) EXCEPT for negative zero, which `JSON.stringify`
 *  silently collapses to `"0"` (`JSON.stringify(-0) === "0"`, confirmed) while `JSON.parse`
 *  correctly recovers `-0` from the literal `-0` (`Object.is(JSON.parse("-0"), -0) === true`,
 *  also confirmed) — so `JSON.stringify` alone breaks bit-identical f32 exactness for exactly
 *  this one value. `-0` is valid JSON (the grammar is `-? int frac? exp?`; `int` may be `0`). */
export function numLit(n: number): string {
    if (!Number.isFinite(n))
        throw new Error(
            `kex2d document: cannot serialize a non-finite number (${n}) — the live ECS holds invalid state (this is a bug, not a malformed-file case).`,
        );
    return Object.is(n, -0) ? "-0" : String(n);
}

/** a flat entity (no nested entity arrays, only plain objects/numbers) — one line, fixed key
 *  order. Recurses by hand rather than calling `JSON.stringify` directly so every number in the
 *  tree (not just the top level) routes through {@link numLit} and keeps its `-0`. Key order is
 *  whatever order the caller built the object in (JS preserves string-key insertion order),
 *  which every `toDoc*`/`fromDoc*` above builds to mirror its owning component's own field
 *  order — that's the "fixed key order" the module doc promises. An `undefined` value (an
 *  absent optional field, e.g. a node's `tangent`) drops its key, matching `JSON.stringify`'s
 *  own convention. */
function emitFlat(v: unknown): string {
    if (typeof v === "number") return numLit(v);
    if (Array.isArray(v)) return `[${v.map(emitFlat).join(",")}]`;
    if (v !== null && typeof v === "object") {
        const parts: string[] = [];
        for (const [k, val] of Object.entries(v)) {
            if (val === undefined) continue;
            parts.push(`${JSON.stringify(k)}:${emitFlat(val)}`);
        }
        return `{${parts.join(",")}}`;
    }
    return JSON.stringify(v);
}

/** an array of flat entities, one per line, at `indent` (the array's OWN key's indent — each
 *  entity lands one level deeper). `[]` inline when empty, never an empty multi-line pair. */
function emitFlatArray(indent: string, items: unknown[]): string {
    if (items.length === 0) return "[]";
    const inner = items.map((it) => `${indent}  ${emitFlat(it)}`).join(",\n");
    return `[\n${inner}\n${indent}]`;
}

/** an array of already-rendered multi-line entity blocks (each a bare, un-indented string
 *  starting at `{` and ending at `}`, built by `renderSection`/`renderStrip` below) — indents
 *  every line of every block by `indent + "  "` and joins them, entity commas included. */
function emitBlockArray(indent: string, blocks: string[]): string {
    if (blocks.length === 0) return "[]";
    const inner = blocks
        .map((b) =>
            b
                .split("\n")
                .map((l) => `${indent}  ${l}`)
                .join("\n"),
        )
        .join(",\n");
    return `[\n${inner}\n${indent}]`;
}

/** One flat canonical segment record, rendered at local indent zero. */
function renderSection(sec: DocSegment): string {
    return [
        "{",
        `  "id": ${sec.id},`,
        `  "order": ${sec.order},`,
        `  "kind": ${sec.kind},`,
        `  "run": ${sec.run},`,
        ...(sec.station === undefined ? [] : [`  "station": ${emitFlat(sec.station)},`]),
        ...(sec.extent === undefined ? [] : [`  "extent": ${emitFlat(sec.extent)},`]),
        ...(sec.node === undefined ? [] : [`  "node": ${sec.node},`]),
        `  "nodes": ${emitFlatArray("  ", sec.nodes)},`,
        `  "points": ${emitFlatArray("  ", sec.points)}`,
        "}",
    ].join("\n");
}

function renderStrip(st: DocStrip): string {
    return [
        "{",
        `  "id": ${st.id},`,
        `  "start": ${emitFlat(st.start)},`,
        `  "end": ${emitFlat(st.end)},`,
        `  "value": ${emitFlat(st.value)},`,
        `  "keyframes": ${emitFlatArray("  ", st.keyframes)}`,
        "}",
    ].join("\n");
}

/** the canonical serializer: `serialize(parse(text)) === text` for every document this module
 *  produces (the round-trip oracle's idempotence leg) — no field this function reads is ever
 *  computed from anything but the document itself, so two calls on the same document always
 *  agree. */
export function serializeDocument(doc: Kex2dDocument): string {
    const lines = [
        "{",
        `  "version": ${doc.version},`,
        `  "track": ${emitFlat(doc.track)},`,
        `  "lanes": {`,
        `    "velocity": ${emitFlatArray("    ", doc.lanes.velocity)},`,
        `    "force": ${emitFlatArray("    ", doc.lanes.force)},`,
        `    "geo": ${emitFlatArray("    ", doc.lanes.geo)}`,
        `  },`,
        `  "segments": ${emitBlockArray("  ", doc.segments.map(renderSection))},`,
        `  "strips": ${emitBlockArray("  ", doc.strips.map(renderStrip))},`,
        `  "oneShot": ${emitFlatArray("  ", doc.oneShot)}`,
        "}",
    ];
    return `${lines.join("\n")}\n`;
}

// ── parse + validate + migrate ───────────────────────────────────────────────────────────

/** every parse/validate/migrate failure throws through here — one message shape, the named
 *  remedy the spec's rejection-arm oracle checks for. */
function fail(msg: string): never {
    throw new Error(
        `kex2d document: ${msg}. The file may be truncated, corrupted, or hand-edited invalid — re-save from a working document to recover.`,
    );
}

/** thrown by the semantic-refusal path only (`failSemantics`, below) — carries the per-invariant
 *  `Refusal[]` a structural `fail()` throw never has, so a CLI caller (`cli.ts`'s
 *  `loadTrackFile`/`cmdEdit`/`cmdValidate`) can emit the violated guards structured instead of
 *  re-flattening this error's own message string. `message` still reads exactly like a
 *  structural rejection (same `kex2d document: … ` wrapper) for a caller matching on that prefix
 *  or the recovery-remedy text alone. */
export class SemanticRefusalError extends Error {
    readonly refusals: Refusal[];
    constructor(message: string, refusals: Refusal[]) {
        super(message);
        this.name = "SemanticRefusalError";
        this.refusals = refusals;
    }
}

/** every semantic-invariant refusal throws through here, one thrown message naming every
 *  violated guard — `fail`'s own remedy suffix, so a semantic rejection reads exactly like a
 *  structural one to a caller matching on `/kex2d document:/` or the recovery-remedy text. */
function failGuard(guard: string, message: string): never {
    throw new SemanticRefusalError(
        `kex2d document: ${guard}: ${message}. The file may be truncated, corrupted, or hand-edited invalid — re-save from a working document to recover.`,
        [{ guard, message }],
    );
}

function failSemantics(refusals: Refusal[]): never {
    const detail = refusals.map((r) => `${r.guard}: ${r.message}`).join("; ");
    const msg = `document violates ${refusals.length} invariant${refusals.length === 1 ? "" : "s"} — ${detail}`;
    throw new SemanticRefusalError(
        `kex2d document: ${msg}. The file may be truncated, corrupted, or hand-edited invalid — re-save from a working document to recover.`,
        refusals,
    );
}

function isFiniteNumber(v: unknown): v is number {
    return typeof v === "number" && Number.isFinite(v);
}

function isInt(v: unknown): v is number {
    return typeof v === "number" && Number.isInteger(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** the document's `tangent` key on a NODE is only ever present for an EXPLICIT geo tangent
 *  (`TangentMode`'s 1|2|3 — Aligned/Free/Mirror); the "no explicit tangent" sentinel (`Auto`,
 *  `TANGENT_AUTO` = 0, `track.ts`) is encoded as the key's ABSENCE, never as `{"mode":0,...}` —
 *  `toDocTangent` only ever calls through with a defined `Tangent`, which `readTangent` only
 *  returns for a non-Auto mode. So a document carrying `mode: 0` (or anything outside 1|2|3)
 *  inside a node's `tangent` object is malformed, not a valid Auto encoding. A force keyframe
 *  (`DocPoint`) carries no `tangent` key at all as of v2 (`kex2d-segment-removal` S3) — explicit
 *  per-keyframe force handles left with the ECS that authored them. */
function isExplicitTangentMode(v: unknown): v is TangentMode {
    return v === TangentMode.Aligned || v === TangentMode.Free || v === TangentMode.Mirror;
}

function validateGeoTangent(v: unknown, path: string): DocGeoTangent | undefined {
    if (v === undefined) return undefined;
    if (!isPlainObject(v)) fail(`${path} is not an object`);
    if (!isExplicitTangentMode(v.mode))
        fail(`${path}.mode is missing or not a valid TangentMode (1, 2, or 3)`);
    for (const k of ["inX", "inY", "outX", "outY"] as const) {
        if (!isFiniteNumber(v[k])) fail(`${path}.${k} is missing or not a finite number`);
    }
    return {
        mode: v.mode as number,
        inX: v.inX as number,
        inY: v.inY as number,
        outX: v.outX as number,
        outY: v.outY as number,
    };
}

function validateNode(v: unknown, path: string): DocNode {
    if (!isPlainObject(v)) fail(`${path} is not an object`);
    if (!isInt(v.order)) fail(`${path}.order is missing or not an integer`);
    for (const k of ["x", "y", "theta"] as const) {
        if (!isFiniteNumber(v[k])) fail(`${path}.${k} is missing or not a finite number`);
    }
    return {
        order: v.order as number,
        x: v.x as number,
        y: v.y as number,
        theta: v.theta as number,
        tangent: validateGeoTangent(v.tangent, `${path}.tangent`),
    };
}

function validatePoint(v: unknown, path: string): DocPoint {
    if (!isPlainObject(v)) fail(`${path} is not an object`);
    if (!isInt(v.id)) fail(`${path}.id is missing or not an integer`);
    if (!isFiniteNumber(v.s)) fail(`${path}.s is missing or not a finite number`);
    if (!isPlainObject(v.boundary)) fail(`${path}.boundary is missing or not an object`);
    if (!isFiniteNumber(v.boundary.g)) fail(`${path}.boundary.g is missing or not a finite number`);
    if (
        !isInt(v.boundary.ease) ||
        (v.boundary.ease !== Easing.Linear &&
            v.boundary.ease !== Easing.Cubic &&
            v.boundary.ease !== Easing.Quintic)
    )
        fail(`${path}.boundary.ease is missing or not a valid Easing (0, 1, or 2)`);
    // a v2 force keyframe carries no `tangent` key at all (`kex2d-segment-removal` S3) — the
    // migration seam strips a v1 file's own before this validator ever sees it, so a `tangent`
    // key surviving to here is malformed (hand-edited, or a mis-stamped version), not a
    // structural variant to tolerate.
    if (v.tangent !== undefined)
        fail(`${path}.tangent is not a valid field on a v${CURRENT_VERSION} force keyframe`);
    return {
        id: v.id as number,
        s: v.s as number,
        boundary: { g: v.boundary.g as number, ease: v.boundary.ease as number },
    };
}

function validateSegment(v: unknown, i: number): DocSegment {
    const path = `segments[${i}]`;
    if (!isPlainObject(v)) fail(`${path} is not an object`);
    if (!isInt(v.id)) fail(`${path}.id is missing or not an integer`);
    if (!isInt(v.order)) fail(`${path}.order is missing or not an integer`);
    if (!isInt(v.run)) fail(`${path}.run is missing or not an integer`);
    if (!isInt(v.kind) || (v.kind !== SectionKind.Geo && v.kind !== SectionKind.Force))
        fail(`${path}.kind is missing or not a valid SectionKind (0 or 1)`);
    if (!Array.isArray(v.nodes)) fail(`${path}.nodes is missing or not an array`);
    if (!Array.isArray(v.points)) fail(`${path}.points is missing or not an array`);
    if (v.kind === SectionKind.Geo) {
        if (!isInt(v.node) || (v.node as number) < 0)
            fail(`${path}.node is missing or not a non-negative integer`);
        if (v.station !== undefined || v.extent !== undefined || v.points.length > 0)
            failGuard("sectionKind", `${path} carries a force channel on a geo record`);
    } else {
        if (!isFiniteNumber(v.station)) fail(`${path}.station is missing or not finite`);
        if (v.extent !== undefined && !isFiniteNumber(v.extent))
            fail(`${path}.extent is not finite`);
        if (v.node !== undefined || v.nodes.length > 0)
            failGuard("sectionKind", `${path} carries a geo channel on a force record`);
    }
    return {
        id: v.id as number,
        order: v.order as number,
        kind: v.kind as number,
        run: v.run as number,
        ...(v.station === undefined ? {} : { station: v.station as number }),
        ...(v.extent === undefined ? {} : { extent: v.extent as number }),
        ...(v.node === undefined ? {} : { node: v.node as number }),
        nodes: v.nodes.map((n, j) => validateNode(n, `${path}.nodes[${j}]`)),
        points: v.points.map((p, j) => validatePoint(p, `${path}.points[${j}]`)),
    };
}

function validateStripKeyframe(v: unknown, path: string): DocStripKeyframe {
    if (!isPlainObject(v)) fail(`${path} is not an object`);
    if (!isInt(v.id)) fail(`${path}.id is missing or not an integer`);
    if (!isFiniteNumber(v.s)) fail(`${path}.s is missing or not a finite number`);
    if (!isFiniteNumber(v.v)) fail(`${path}.v is missing or not a finite number`);
    return { id: v.id as number, s: v.s as number, v: v.v as number };
}

function validateStrip(v: unknown, i: number): DocStrip {
    const path = `strips[${i}]`;
    if (!isPlainObject(v)) fail(`${path} is not an object`);
    if (!isInt(v.id)) fail(`${path}.id is missing or not an integer`);
    for (const k of ["start", "end", "value"] as const) {
        if (!isFiniteNumber(v[k])) fail(`${path}.${k} is missing or not a finite number`);
    }
    if (!Array.isArray(v.keyframes)) fail(`${path}.keyframes is missing or not an array`);
    return {
        id: v.id as number,
        start: v.start as number,
        end: v.end as number,
        value: v.value as number,
        keyframes: v.keyframes.map((k, j) => validateStripKeyframe(k, `${path}.keyframes[${j}]`)),
    };
}

function validateTrack(v: unknown): DocTrack {
    if (!isPlainObject(v)) fail("track is missing or not an object");
    for (const k of ["ds", "friction", "resistance"] as const) {
        if (!isFiniteNumber(v[k])) fail(`track.${k} is missing or not a finite number`);
    }
    if (!isInt(v.domain) || (v.domain !== Domain.Distance && v.domain !== Domain.Time))
        fail("track.domain is missing or not a valid Domain (0 or 1)");
    for (const k of ["end", "v0"] as const) {
        if (v[k] !== undefined && !isFiniteNumber(v[k])) fail(`track.${k} is not a finite number`);
    }
    return {
        ds: v.ds as number,
        domain: v.domain as number,
        friction: v.friction as number,
        resistance: v.resistance as number,
        ...(v.end === undefined ? {} : { end: v.end as number }),
        ...(v.v0 === undefined ? {} : { v0: v.v0 as number }),
    };
}

/** one lane record's structural shape. `entry` is genuinely optional (its absence is the
 *  "reads the predecessor or the lane rule" case, `lanes.entryValue`) and is refused only when
 *  present and non-finite; `exit` is always owned and always required. */
function validateOneShot(v: unknown, i: number): DocOneShot {
    const path = `oneShot[${i}]`;
    if (!isPlainObject(v)) fail(`${path} is not an object`);
    if (!isInt(v.id)) fail(`${path}.id is missing or not an integer`);
    // v4 moved the value to `track.v0`; a surviving `value` key is a mis-stamped v3 file.
    if (v.value !== undefined)
        fail(`${path}.value is not a valid field on a v${CURRENT_VERSION} one-shot (use track.v0)`);
    return { id: v.id as number };
}

function validateLaneSegment(v: unknown, lane: string, i: number): LaneSegment {
    const path = `lanes.${lane}[${i}]`;
    if (!isPlainObject(v)) fail(`${path} is not an object`);
    if (!isInt(v.id)) fail(`${path}.id is missing or not an integer`);
    for (const k of ["start", "end", "exit"] as const) {
        if (!isFiniteNumber(v[k])) fail(`${path}.${k} is missing or not a finite number`);
    }
    if (
        !isInt(v.ease) ||
        (v.ease !== Easing.Linear && v.ease !== Easing.Cubic && v.ease !== Easing.Quintic)
    )
        fail(`${path}.ease is missing or not a valid Easing (0, 1, or 2)`);
    if (v.entry !== undefined && !isFiniteNumber(v.entry))
        fail(`${path}.entry is present but not a finite number`);
    return {
        id: v.id as number,
        start: v.start as number,
        end: v.end as number,
        ease: v.ease as number,
        ...(v.entry === undefined ? {} : { entry: v.entry as number }),
        exit: v.exit as number,
    };
}

function validateLanes(v: unknown): Lanes {
    if (!isPlainObject(v)) fail("lanes is missing or not an object");
    const out = emptyLanes();
    for (const lane of ["velocity", "force", "geo"] as const) {
        const rows = v[lane];
        if (!Array.isArray(rows)) fail(`lanes.${lane} is missing or not an array`);
        out[lane] = rows.map((r, i) => validateLaneSegment(r, lane, i));
    }
    return out;
}

/** the full structural validator — every field type-checked, every required key present,
 *  before a single ECS write happens (`loadDocument` calls this, then `restoreAll`, never the
 *  other order). Applied AFTER migration, so it only ever sees `CURRENT_VERSION` shape. */
function validateDocument(raw: Record<string, unknown>): Kex2dDocument {
    if (!isInt(raw.version)) fail("version is missing or not an integer");
    const track = validateTrack(raw.track);
    if (!Array.isArray(raw.segments)) fail("segments is missing or not an array");
    if (!Array.isArray(raw.strips)) fail("strips is missing or not an array");
    if (!Array.isArray(raw.oneShot)) fail("oneShot is missing or not an array");
    if (raw.oneShot.length > 1) fail("oneShot carries more than one entry (at most one may exist)");
    const doc: Kex2dDocument = {
        version: raw.version as number,
        track,
        lanes: validateLanes(raw.lanes),
        segments: raw.segments.map((s, i) => validateSegment(s, i)),
        strips: raw.strips.map((s, i) => validateStrip(s, i)),
        oneShot: raw.oneShot.map((o, i) => validateOneShot(o, i)),
    };
    const ids = new Set<number>();
    const orders = new Set<number>();
    for (const segment of doc.segments) {
        if (ids.has(segment.id))
            failGuard("duplicateId", `two or more segments share id ${segment.id}`);
        if (orders.has(segment.order))
            failGuard("duplicateSectionOrder", `two or more segments claim order ${segment.order}`);
        ids.add(segment.id);
        orders.add(segment.order);
    }
    const seenRuns = new Set<number>();
    for (let i = 0; i < doc.segments.length; ) {
        const first = doc.segments[i]!;
        if (first.order !== i)
            failGuard(
                "duplicateSectionOrder",
                "segments.order is not a bijection onto chain order",
            );
        if (seenRuns.has(first.run)) fail(`run ${first.run} is not contiguous`);
        seenRuns.add(first.run);
        if (first.id !== first.run)
            fail(`run ${first.run}'s first record id does not equal its run id`);
        let end = i + 1;
        while (end < doc.segments.length && doc.segments[end]!.run === first.run) end++;
        const records = doc.segments.slice(i, end);
        if (records.some((record) => record.kind !== first.kind))
            fail(`run ${first.run} mixes kinds`);
        if (first.kind === SectionKind.Force) {
            for (let j = 0; j < records.length; j++) {
                if (j === 0 && records[j]!.station !== 0)
                    fail(`force run ${first.run} does not start at station 0`);
                if (j > 0 && records[j]!.station! <= records[j - 1]!.station!)
                    fail(`force run ${first.run} stations are not strictly increasing`);
                const terminal = j === records.length - 1;
                if (terminal !== (records[j]!.extent !== undefined))
                    fail(`force run ${first.run} has missing or duplicate terminal extent`);
            }
            const last = records.at(-1)!;
            if (last.extent! <= last.station!)
                fail(`force run ${first.run}'s terminal extent is not above its last station`);
        } else if (records.some((record, j) => j > 0 && record.node! <= records[j - 1]!.node!)) {
            fail(`geo run ${first.run} node orders are not strictly increasing`);
        }
        i = end;
    }
    return doc;
}

// ── semantic invariant validation (document-boundary guard census) ───────────────────────
//
// `validateDocument` above is purely structural (types present, enums in range) — it lets
// through a document that is well-SHAPED but violates an authoring invariant the live setters
// enforce (`track.ts`'s guard predicates). `restoreAll`'s spawn path bypasses every one of
// those guards on purpose (an in-session undo snapshot is already-validated state, spec Locked
// decision), so a hand-authored `.kex` file that breaks one loads silently today. The checks
// below close that: every one reuses the SAME named predicate a setter or S2's `commands.ts`
// already reads (`Refusal`'s `{guard, message}` shape imported from there, not reinvented), so
// a refusal here and a refusal from an edit op key on the same guard vocabulary.
//
// Two passes. `checkDocInvariants` is pure — doc-shape only, no ECS — and covers everything
// that's a plain scalar/count comparison over the parsed document (duplicate ids, section-order
// collisions, kind-mismatched payloads, node/extent floors, duplicate stations, coefficient/
// value validity, the start-speed floor). `checkGeometryInvariants` covers the two guards that
// are irreducibly geometric — `stripOverlapped`/`stripCoversOneEdge` resolve a strip's edge
// range against a section's OWN chord length (`sectionEdgeDs`/`geoChordDs`), a real spline
// evaluation, not a doc-level number — so it builds a throwaway `State`, loads the CANDIDATE
// document into it (no bake tick needed: both predicates are pure derivations off the authored
// payload), and reads the predicates there. This throwaway state is never the caller's `ecs` —
// `loadDocument`'s "untouched on refusal" guarantee holds by construction, not by rollback.

function checkDuplicateIds(doc: Kex2dDocument): Refusal[] {
    const refusals: Refusal[] = [];
    const check = (category: string, ids: number[]) => {
        const seen = new Set<number>();
        for (const id of ids) {
            if (seen.has(id))
                refusals.push({
                    guard: "duplicateId",
                    message: `two or more ${category} share id ${id} — ids must be unique within their category`,
                });
            seen.add(id);
        }
    };
    check(
        "sections",
        doc.segments.map((s) => s.id),
    );
    check(
        "force points",
        doc.segments.flatMap((s) => s.points.map((p) => p.id)),
    );
    check(
        "strips",
        doc.strips.map((st) => st.id),
    );
    check(
        "strip keyframes",
        doc.strips.flatMap((st) => st.keyframes.map((k) => k.id)),
    );
    return refusals;
}

/** the pure, no-ECS half: every invariant checkable from the parsed document's own fields.
 *  Named per-guard, matching `track.ts`'s predicate names (or `commands.ts`'s `sectionKind`,
 *  where the guard is an affordance fence rather than a `track.ts` export) so a caller can
 *  branch on the reason without parsing the message, the same contract `commands.ts` keeps. */
export function checkDocInvariants(doc: Kex2dDocument): Refusal[] {
    const refusals: Refusal[] = checkDuplicateIds(doc);

    if (doc.segments.length === 0)
        refusals.push({
            guard: "emptyTrack",
            message: "a document must contain at least one section",
        });

    const orders = new Set<number>();
    for (const segment of doc.segments) {
        if (orders.has(segment.order))
            refusals.push({
                guard: "duplicateSectionOrder",
                message: `two or more segments claim order ${segment.order}`,
            });
        orders.add(segment.order);
    }

    const runs = new Map<number, DocSegment[]>();
    for (const segment of doc.segments) {
        const records = runs.get(segment.run) ?? [];
        records.push(segment);
        runs.set(segment.run, records);
    }
    for (const [runId, records] of runs) {
        const kind = records[0]!.kind;
        const runNodes = records.flatMap((record) => record.nodes);
        const runPoints = records.flatMap((record) => record.points);
        if (kind === SectionKind.Geo) {
            if (runPoints.length > 0)
                refusals.push({
                    guard: "sectionKind",
                    message: `run ${runId} is geo but carries force points`,
                });
            if (runNodes.length < 2)
                refusals.push({
                    guard: "minNodeFloor",
                    message: `run ${runId} has fewer than two nodes`,
                });
            const node0 = runNodes.find((node) => node.order === 0);
            if (node0 && (node0.x !== 0 || node0.y !== 0 || node0.theta !== 0))
                refusals.push({
                    guard: "nodeZeroOrigin",
                    message: `run ${runId}'s node 0 must sit at the local origin with heading 0`,
                });
        } else {
            const extent = records.at(-1)!.extent!;
            if (runNodes.length > 0)
                refusals.push({
                    guard: "sectionKind",
                    message: `run ${runId} is force but carries geo nodes`,
                });
            if (extent < MIN_FORCE_LEN)
                refusals.push({
                    guard: "minForceExtent",
                    message: `run ${runId}'s extent ${extent} is below ${MIN_FORCE_LEN}`,
                });
        }
        const stations = new Set<number>();
        for (const p of runPoints) {
            const key = Math.fround(p.s);
            if (stations.has(key))
                refusals.push({
                    guard: "stationTaken",
                    message: `two or more force points on run ${runId} share station ${p.s}`,
                });
            stations.add(key);
        }
    }

    for (const st of doc.strips) {
        if (!validStripValue(st.value))
            refusals.push({
                guard: "validStripValue",
                message: `strip ${st.id}'s value ${st.value} must be finite and strictly positive`,
            });
        const stations = new Set<number>();
        for (const k of st.keyframes) {
            const key = Math.fround(k.s);
            if (stations.has(key))
                refusals.push({
                    guard: "stripKeyframeTaken",
                    message: `two or more keyframes on strip ${st.id} share station ${k.s}`,
                });
            stations.add(key);
        }
    }

    if (!validCoefficient(doc.track.friction))
        refusals.push({
            guard: "validCoefficient",
            message: `track.friction (${doc.track.friction}) must be finite and non-negative`,
        });
    if (!validCoefficient(doc.track.resistance))
        refusals.push({
            guard: "validCoefficient",
            message: `track.resistance (${doc.track.resistance}) must be finite and non-negative`,
        });

    if (doc.track.v0 !== undefined && doc.track.v0 < MIN_V0)
        refusals.push({
            guard: "minStartSpeed",
            message: `the track-start speed ${doc.track.v0} is below the minimum ${MIN_V0}`,
        });

    return refusals;
}

/** the four `Track` scalars `restoreAll` doesn't own, read off a known-live track entity —
 *  `loadDocument`'s own rollback snapshot for the geometry-refusal path. */
function readTrackScalars(trackEid: number) {
    return {
        ds: Track.ds.get(trackEid),
        domain: Track.domain.get(trackEid),
        friction: Track.friction.get(trackEid),
        resistance: Track.resistance.get(trackEid),
        count: Track.count.get(trackEid),
    };
}

/** a throwaway `State` carrying `doc`'s candidate document — never the caller's live `ecs`,
 *  never bake-ticked (the two geometry guards below are pure derivations off the authored
 *  payload, `track.ts`'s own docblocks on `sectionEdgeDs`/`stripCoversOneEdge`).
 *
 *  **Isolation contract: call only where no OTHER `State` is concurrently live in the
 *  process.** `track.ts`'s component storage is module-scoped and eid-indexed with no
 *  per-State bank (spec Residue) — two `State`s allocating the same eid alias the same
 *  storage slot, so building this scratch state while another live `ecs` exists can corrupt
 *  it. `loadDocument` never calls this for exactly that reason (its geometry check runs
 *  in-place on the caller's own `ecs`, with an in-place rollback); this path is for a caller
 *  validating a candidate file in isolation — a one-shot CLI `validate` invocation, a bare
 *  unit test — with no other `State` around to alias. */
function buildScratchEcs(doc: Kex2dDocument): State {
    const ecs = new State();
    const trackEid = createTrack(ecs);
    restoreAll(ecs, docToTrackSnapshot(doc));
    refreshVelocityRunMembers(ecs);
    Track.ds.set(trackEid, doc.track.ds);
    Track.domain.set(trackEid, doc.track.domain);
    Track.friction.set(trackEid, doc.track.friction);
    Track.resistance.set(trackEid, doc.track.resistance);
    return ecs;
}

/** the two guards that need a real (throwaway) ECS: strip overlap and the strip min-extent
 *  floor, both read off `track.ts`'s own exported predicates — the exact functions `setStrip`/
 *  `createStrip` check, not a doc-level reimplementation of the edge-range math. */
function checkGeometryInvariants(ecs: State): Refusal[] {
    const refusals: Refusal[] = [];
    for (const st of allStrips(ecs)) {
        if (stripOverlapped(ecs, st.start, st.end, st.id))
            refusals.push({
                guard: "stripOverlapped",
                message: `strip ${st.id} [${st.start}, ${st.end}) overlaps another velocity strip`,
            });
        else if (!stripCoversOneEdge(ecs, st.start, st.end))
            refusals.push({
                guard: "minExtentFloor",
                message: `strip ${st.id} [${st.start}, ${st.end}) covers no edge of the current bake`,
            });
    }
    return refusals;
}

/** the full document-boundary invariant check — every setter guard `restoreAll`'s spawn path
 *  bypasses, read against `doc` rather than any live `ecs`. Pass a `parseDocument`-produced
 *  document, get back every violated guard (empty when the document is fully valid —
 *  structurally AND semantically). **Not** the entry point `cli.ts`'s `validate` verb calls —
 *  that verb runs `loadDocument` on its own headless `State` (it needs the loaded, baked track
 *  for the force-limit check that follows), so its structural/semantic refusals come off
 *  `loadDocument`'s thrown `SemanticRefusalError.refusals`, not this function. This export is
 *  for a caller with no live `ecs` to load into and no other `State` concurrently live in the
 *  process (a bare unit test; `tests/invariants.test.ts`'s own oracle) — it builds its own
 *  throwaway scratch state (`buildScratchEcs`) for the geometry half. Skips the geometry pass
 *  when the doc-level pass already found something: a
 *  document with duplicate ids or a kind-mismatched section produces a meaningless or unsafe
 *  scratch ECS to build geometry checks against. */
export function checkDocumentSemantics(doc: Kex2dDocument): Refusal[] {
    const refusals = checkDocInvariants(doc);
    if (refusals.length > 0) return refusals;
    return checkGeometryInvariants(buildScratchEcs(doc));
}

/** v1 → v2 (`kex2d-segment-removal` S3): drop every force keyframe's `tangent` key
 *  (the explicit-handle `ForceTangent`/`Offset` shape the ECS can no longer author) while
 *  leaving every other key on a v1 file untouched — a section's geo `nodes[].tangent` is a
 *  structurally distinct key on a distinct entity and is never read or written here. Tolerant
 *  of a malformed shape (a non-array `sections`/`points`, a non-object entry): it passes the
 *  offending value through unchanged rather than throwing, so `validateDocument` (run AFTER
 *  migration, on the CURRENT_VERSION shape) is the one place that reports the malformed field —
 *  a migration step's job is reshaping a KNOWN-good older shape, not structural validation. */
function dropForceTangent(doc: Record<string, unknown>): Record<string, unknown> {
    const rawSections = doc.sections;
    if (!Array.isArray(rawSections)) return { ...doc, version: 2 };
    const sections = rawSections.map((s) => {
        if (!isPlainObject(s) || !Array.isArray(s.points)) return s;
        const points = s.points.map((p) => {
            if (!isPlainObject(p) || !("tangent" in p)) return p;
            const rest: Record<string, unknown> = {};
            for (const [k, val] of Object.entries(p)) if (k !== "tangent") rest[k] = val;
            return rest;
        });
        return { ...s, points };
    });
    return { ...doc, version: 2, sections };
}

/** v2 → frozen flat v3 emits exactly one segment record per v2 section, never a union. */
function sectionsToSegments(doc: Record<string, unknown>): Record<string, unknown> {
    const { sections, ...rest } = doc;
    const segments = Array.isArray(sections)
        ? sections.map((section) => {
              if (!isPlainObject(section) || !Array.isArray(section.points)) return section;
              const points = section.points.map((point) => {
                  if (!isPlainObject(point)) return point;
                  const { g, ease, ...station } = point;
                  return { ...station, boundary: { g, ease } };
              });
              const { length, nodes, points: _points, id, order, kind, ...unknown } = section;
              const geo = kind === SectionKind.Geo;
              const nodeRows = Array.isArray(nodes) ? nodes : [];
              return {
                  id,
                  order,
                  kind,
                  run: id,
                  ...(geo ? { node: nodeRows.length - 1 } : { station: 0, extent: length }),
                  nodes,
                  points,
                  ...unknown,
              };
          })
        : sections;
    return { ...rest, version: 3, segments };
}

/** v3 → v4 (`kex2d-segment-gestures` S1): open the lane substrate on the wire.
 *
 *  Pure document-to-document, and total on a well-shaped v3 file: it derives `lanes` from the v3
 *  `segments`/`strips` payload through {@link lanesFromChain} (the same derivation `docFromEcs`
 *  runs, so a migrated file is a fixed point of a save), moves the one-shot's value onto
 *  `track.v0`, and drops the `oneShot` array. The v3 payload itself is carried through unchanged
 *  — the ECS still loads from it until S2 (see {@link CURRENT_VERSION}).
 *
 *  Tolerant of a malformed shape, like every step before it: a non-array `segments`/`strips` or a
 *  non-object entry passes through and derives no lanes rather than throwing, leaving
 *  `validateDocument` (which runs AFTER migration, on the CURRENT_VERSION shape) the one place
 *  that reports the malformed field. */
function chainToLanes(doc: Record<string, unknown>): Record<string, unknown> {
    const { oneShot, ...rest } = doc;
    const rawTrack = isPlainObject(rest.track) ? rest.track : {};
    const rows = Array.isArray(oneShot) ? oneShot : [];
    const first = rows[0];
    const v0 = isPlainObject(first) && isFiniteNumber(first.value) ? first.value : undefined;
    const wellShaped =
        Array.isArray(rest.segments) &&
        Array.isArray(rest.strips) &&
        rest.segments.every(isPlainObject) &&
        rest.strips.every(isPlainObject);
    const lanes = wellShaped
        ? lanesFromChain(
              rest.segments as DocSegment[],
              rest.strips as DocStrip[],
              isFiniteNumber(rawTrack.ds) ? rawTrack.ds : DS_NOMINAL,
          )
        : emptyLanes();
    return {
        ...rest,
        version: 4,
        track: { ...rawTrack, ...(v0 === undefined ? {} : { v0 }) },
        lanes,
        oneShot: rows.map((o) => (isPlainObject(o) ? { id: o.id } : o)),
    };
}

/** a single forward migration step: takes a raw doc at some version and returns one it stamps at
 *  a higher version. */
export type MigrationStep = (doc: Record<string, unknown>) => Record<string, unknown>;

/** forward-only migrations, keyed by the version they migrate FROM — `migrations[1]` takes a v1
 *  raw doc and returns a v2 one. The seam exists so a version bump costs one function, not a
 *  rewrite. */
const migrations: Record<number, MigrationStep> = {
    1: dropForceTangent,
    2: sectionsToSegments,
    3: chainToLanes,
};

/** walk a raw parsed object forward from its declared `version` to `CURRENT_VERSION`, one
 *  registered migration step at a time. Refuses (never guesses) a version this build doesn't
 *  recognize — newer than `CURRENT_VERSION`, or older than any registered migration can
 *  bridge — both are "unknown version" the spec's rejection-arm oracle checks for. Also refuses a
 *  step that runs but does not strictly advance the version: an unguarded loop keyed only on
 *  `v < CURRENT_VERSION` would spin forever on a step that forgets to bump (the hang is the worst
 *  shape a data-load boundary can fail in), so every step's stamped version must exceed the one
 *  it started from. `steps` defaults to the production table and is overridable only so a test
 *  can register a deliberately non-bumping step against this same guard without touching the
 *  production table. */
export function migrate(
    raw: Record<string, unknown>,
    steps: Record<number, MigrationStep> = migrations,
): Record<string, unknown> {
    if (!isInt(raw.version)) fail("version is missing or not an integer");
    let doc = raw;
    let v = raw.version as number;
    if (v > CURRENT_VERSION)
        fail(
            `version ${v} is newer than this build supports (max ${CURRENT_VERSION}) — update kex2d`,
        );
    while (v < CURRENT_VERSION) {
        const step = steps[v];
        if (!step) fail(`version ${v} has no migration path to ${CURRENT_VERSION}`);
        doc = step(doc);
        if (!isInt(doc.version)) fail(`migration from version ${v} did not stamp a valid version`);
        const nextV = doc.version as number;
        if (nextV <= v)
            fail(`migration from version ${v} did not advance the version (stamped ${nextV})`);
        v = nextV;
    }
    return doc;
}

/** parse + migrate + validate `text` as a kex2d document. Never touches an ECS — the pure half
 *  of the load boundary, so a caller can validate a candidate file before deciding to load it.
 *  Throws (never returns a partial document) on invalid JSON, an unrecognized version, or any
 *  malformed/missing field — every throw carries a named remedy (`fail`, above). */
export function parseDocument(text: string): Kex2dDocument {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        fail(`invalid JSON (${(e as Error).message})`);
    }
    if (!isPlainObject(raw)) fail("root is not a JSON object");
    return validateDocument(migrate(raw));
}

// ── the save/load boundary ───────────────────────────────────────────────────────────────

/** the whole live document, canonically serialized — `loadDocument(ecs, saveDocument(ecs))` is
 *  a no-op on the live ECS (the round-trip oracle). */
export function saveDocument(ecs: State): string {
    return serializeDocument(docFromEcs(ecs));
}

/** replace the live document with `text`'s — the document-boundary convention of every editor
 *  (spec Locked decision): parses + validates structurally first (throwing, touching nothing,
 *  on a structural or doc-shape semantic rejection), only then destroys/respawns the ECS state
 *  (`restoreAll`) and writes the four `Track` scalars `restoreAll` doesn't own. **The geometry
 *  half of semantic validation is the one exception**: it needs a real, in-place `ecs` to
 *  resolve a strip's edge range against (below), so the candidate loads BEFORE that guard runs
 *  and an in-place rollback (never a second `State` — the two-`State`-aliasing hazard, `AGENTS.md`
 *  Hard gotchas) restores the caller's live document on refusal — the live ECS is touched and
 *  then unwound, not left untouched throughout. Clears the undo stack on a landed load — a load
 *  is a new document, not an edit to undo past. Reserves every stable id the file used
 *  (`reserveIds`) so a `create*` call right after a load can't collide with one. */
export function loadDocument(ecs: State, text: string): void {
    const doc = parseDocument(text); // throws first; the live document is untouched until here

    // semantic invariants, doc-shape half (`checkDocInvariants`) — pure, no ECS touched, so this
    // throws exactly like a structural refusal above: nothing written, nothing to undo.
    const docRefusals = checkDocInvariants(doc);
    if (docRefusals.length > 0) failSemantics(docRefusals);

    // Reserve every identity carried by the wire before deterministic member synthesis.
    reserveIds({
        section: doc.segments.map((s) => s.id),
        force: doc.segments.flatMap((s) => s.points.map((p) => p.id)),
        strip: doc.strips.map((st) => st.id),
        stripKeyframe: doc.strips.flatMap((st) => st.keyframes.map((k) => k.id)),
        oneShot: doc.oneShot.map((o) => o.id),
    });
    const snap = docToTrackSnapshot(doc);
    reserveIds({ section: snap.segments.map((s) => s.id) });

    // the geometry half (`stripOverlapped`/`stripCoversOneEdge`) needs a REAL ecs to resolve a
    // section's chord length against — but it must be run in-place on THIS `ecs`, never a
    // second `State`: `track.ts`'s component storage is module-scoped and eid-indexed with no
    // per-State bank (spec Residue), so a throwaway scratch state built while `ecs` is live can
    // silently alias and corrupt it the moment the two allocate an overlapping eid (measured:
    // building a second `State` here clobbered a live strip's `start`/`end` through exactly
    // this aliasing). So the candidate loads into `ecs` itself, geometry-checked there, and an
    // in-place rollback (never a second `State`) undoes it on refusal.
    const hadTrack = trackEntity(ecs) !== null;
    const rollbackSnap: TrackSnapshot = hadTrack
        ? snapshotAll(ecs)
        : { segments: [], strips: [], oneShot: [] };
    let trackEid = trackEntity(ecs);
    const rollbackScalars = trackEid === null ? null : readTrackScalars(trackEid);

    if (trackEid === null) trackEid = createTrack(ecs);
    // `createTrack`'s fresh entity already zeroes `count`; a REUSED entity carries the previous
    // document's bake-derived sample count until the next tick recomputes it — zero it here too,
    // so there's no window where `Track.count` describes a document that's no longer live.
    else Track.count.set(trackEid, 0);

    restoreAll(ecs, snap);
    // Retained top-level velocity records union their stations back into the restored chain;
    // this also refreshes geo edge membership and all load-derived velocity pointers.
    refreshVelocityRunMembers(ecs);
    Track.ds.set(trackEid, doc.track.ds);
    Track.domain.set(trackEid, doc.track.domain);
    Track.friction.set(trackEid, doc.track.friction);
    Track.resistance.set(trackEid, doc.track.resistance);

    const geomRefusals = checkGeometryInvariants(ecs);
    if (geomRefusals.length > 0) {
        restoreAll(ecs, rollbackSnap);
        if (hadTrack && rollbackScalars) {
            Track.ds.set(trackEid, rollbackScalars.ds);
            Track.domain.set(trackEid, rollbackScalars.domain);
            Track.friction.set(trackEid, rollbackScalars.friction);
            Track.resistance.set(trackEid, rollbackScalars.resistance);
            Track.count.set(trackEid, rollbackScalars.count);
        } else {
            ecs.destroy(trackEid);
        }
        failSemantics(geomRefusals);
    }

    history.undo.length = 0;
    history.redo.length = 0;
}
