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
import {
    emptyLanes,
    Lane,
    type LaneSegment,
    type Lanes,
    laneOrder,
    laneRefusals,
    trackEnd,
    validStripValue,
} from "./lanes";
import { fitPitch } from "./pitchfit";
import {
    Easing,
    type ForcePoint,
    forceProfile,
    resolveStep,
    sampleForce,
    type Step,
} from "./profile";
import { chain, Domain, type Entry, type Section, type SectionResult, type Strip } from "./section";
import { type Node, sampleChain, TangentMode, type Tangent } from "./spline";
import {
    createTrack,
    DS_NOMINAL,
    edgeStrips,
    lanesOf,
    MAX_SAMPLES,
    materializeRunForceClamps,
    MIN_V0,
    type RecordSnapshot,
    reserveIds,
    restoreAll,
    runsOf as derivedRunsOf,
    trackDs,
    SectionKind,
    snapshotAll,
    Track,
    trackEntity,
    type TrackSnapshot,
    V0,
    validCoefficient,
    velocityRows,
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
    /** authored lane PRIORITY, top to bottom — a permutation of `lanes.Lane` (`lanes.laneOrder`
     *  refuses anything else). Absent means the default `[Geo, Force, Velocity]`. Document
     *  state, not a view preference, because it changes the bake: `projection.deriveRuns` cuts
     *  at the higher shape lane's groups (spec Locked decision "geo and force overlap: store
     *  both, lane order drives"). No ECS column backs this until S2e, so `docFromEcs` never
     *  emits it and a file carrying it round-trips it unchanged, exactly as `end` does. */
    order?: number[];
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
    /** the whole authored substrate: independent per-parameter lanes of two-handle segments
     *  (`lanes.ts`). The v3 `segments`/`strips` payload left the wire at S2e-i; a v4 text still
     *  carrying those columns loads with them IGNORED (the lanes are the document), which is
     *  what keeps a file written by the bridge build openable. */
    lanes: Lanes;
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
                // Cubic, not Linear: `profile.segment` reads a missing tag as Cubic, so a
                // strip-born span baked as a Cubic curve on the retired store. A Linear mint
                // would be a wire lie and move `velocity/*` off their digests.
                ease: Easing.Cubic,
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

/** a wire tangent as the pure `spline.Tangent` the sampler reads. */
function fromDocTangent(t: DocGeoTangent | undefined): Tangent | undefined {
    return t
        ? { mode: t.mode as TangentMode, inX: t.inX, inY: t.inY, outX: t.outX, outY: t.outY }
        : undefined;
}

/** one geo run's nodes as the pure `spline.Node` list its sampler reads, in run-global order.
 *  `Handle.order` is run-global (`track.spliceGeoMembers`), so concatenating the members' node
 *  arrays and sorting by `order` rebuilds the run's own chain — the exact list `track.geoNodes`
 *  hands the live bake. */
function runNodes(members: DocSegment[]): Node[] {
    return members
        .flatMap((m) => m.nodes)
        .slice()
        .sort((a, b) => a.order - b.order)
        .map((n) => ({ x: n.x, y: n.y, theta: n.theta, tangent: fromDocTangent(n.tangent) }));
}

/** one geo run's baked edge grid, sampled off its own nodes — the pure twin of
 *  `track.geoChordDs`, down to the buffer sizes, so the payload a document builds and the one
 *  the live ECS builds are the same call on the same numbers. Chord length is frame-invariant
 *  (rigid placement preserves distance), so no entry placement is needed to get the grid. */
function geoChordOf(members: DocSegment[], ds: number): { ds: Float32Array; edges: number } {
    const nodes = runNodes(members);
    const posX = new Float32Array(MAX_SAMPLES);
    const posY = new Float32Array(MAX_SAMPLES);
    const dsArr = new Float32Array(Math.max(1, MAX_SAMPLES - 1));
    const r = sampleChain(nodes, ds, posX, posY, dsArr, MAX_SAMPLES);
    return { ds: dsArr, edges: r.edges };
}

/** the v3 payload's own force keys for one run, at run-local absolute stations. `DocPoint.s` is
 *  already run-local absolute (`toDocSegment` adds each member's `runStation` on emit). */
function runForcePoints(members: DocSegment[]): ForcePoint[] {
    return members
        .flatMap((m) => m.points)
        .slice()
        .sort((a, b) => a.s - b.s || a.id - b.id)
        .map((p) => ({ s: p.s, g: p.boundary.g, ease: p.boundary.ease as Easing }));
}

/** every track-global strip in one run's own edge-index frame — the pure twin of
 *  `track.stripsForStep`/`geoPayload`'s strip half, reading the document's strips instead of
 *  the ECS's. */
function runStrips(
    strips: DocStrip[],
    ds: ArrayLike<number>,
    edges: number,
    offset: number,
): ReturnType<typeof edgeStrips> {
    if (strips.length === 0) return undefined;
    return edgeStrips(
        ds,
        edges,
        strips.map((st) => ({
            start: st.start - offset,
            end: st.end - offset,
            value: st.value,
            keyframes: st.keyframes
                .slice()
                .sort((a, b) => a.s - b.s)
                .map((k) => ({ s: k.s - offset, v: k.v })),
        })),
    );
}

/** the whole v3 payload of one document as the evaluator substrate's own input — the entry
 *  anchor plus one {@link Section} per run, exactly what `track.ts`'s `BakeSystem` builds from
 *  the live ECS (`geoPayload`/`forcePayload`, the same `resolveStep` pairing, the same
 *  `materializeRunForceClamps` + `forceProfile`, the same `edgeStrips` frames, the same
 *  `startEntry(entrySpeed)` seed).
 *
 *  **Pure.** No ECS, no `State`, no bake read: `migrations[3]` runs `section.chain` over this to
 *  learn a geo run's realized shape, and it must be able to do that document-to-document. That
 *  the two builders agree is not an assumption — a standing arm in `tests/doc.test.ts` asserts
 *  `chain(v3Payloads(fixture))` is byte-identical to the live bake over the whole corpus, which
 *  is the premise `tests/fixtures/v3/bake-digests.json` is minted under. */
export function v3Payloads(doc: { track: DocTrack; segments: DocSegment[]; strips: DocStrip[] }): {
    entry: Entry;
    sections: Section[];
    friction: number;
    resistance: number;
    /** each run's absolute entry station, measured the way the live bake measures it — by
     *  summing the published per-edge steps, never by trusting an authored extent. This is the
     *  frame a run's strips are read in, so a caller re-framing them onto another grid starts
     *  from the same number. */
    offsets: number[];
} {
    const ds = doc.track.ds;
    const strips = doc.strips.slice().sort((a, b) => a.start - b.start || a.id - b.id);
    const sections: Section[] = [];
    const offsets: number[] = [];
    let offset = 0;
    for (const run of runsOf(doc.segments)) {
        offsets.push(offset);
        if (run.kind === SectionKind.Force) {
            const step = resolveStep(run.extent, ds);
            const grid = new Float32Array(step.edges).fill(step.ds);
            sections.push({
                kind: "force",
                fN: forceProfile(
                    materializeRunForceClamps(runForcePoints(run.members), run.extent),
                    step,
                ),
                step,
                strips: runStrips(strips, grid, step.edges, offset),
            });
            // the live bake measures a run's window by SUMMING its published per-edge steps,
            // never by trusting the authored extent — mirror that, f32 values and all.
            for (let i = 0; i < step.edges; i++) offset += grid[i]!;
        } else {
            const grid = geoChordOf(run.members, ds);
            sections.push({
                kind: "geo",
                nodes: runNodes(run.members),
                ds,
                strips: runStrips(strips, grid.ds, grid.edges, offset),
            });
            for (let i = 0; i < grid.edges; i++) offset += grid.ds[i]!;
        }
    }
    return {
        entry: { x: 0, y: 0, theta: 0, v: doc.track.v0 ?? V0 },
        sections,
        friction: doc.track.friction,
        resistance: doc.track.resistance,
        offsets,
    };
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

/** the force and geo lane records for one v3 payload, walked along the chain's arclength axis.
 *
 *  The axis is the BAKE's: `section.chain` is run over {@link v3Payloads} once, so a force run's
 *  window and a geo run's window are both read off the realized edges rather than off two
 *  different rules. A force run's records split at its own authored keys ({@link forceRunLane});
 *  a GEO run's are FITTED — its recovered heading is re-expressed as pitch records through
 *  `pitchfit.fitPitch`, knots at the baked node landings, under `geofit.ts`'s dual budget. */
function chainLanes(
    doc: { track: DocTrack; segments: DocSegment[]; strips: DocStrip[] },
    nextId: () => number,
): { force: LaneSegment[]; geo: LaneSegment[] } {
    const force: LaneSegment[] = [];
    const geo: LaneSegment[] = [];
    const runs = runsOf(doc.segments);
    if (runs.length === 0) return { force, geo };
    const payload = v3Payloads(doc);
    const baked = chain(
        payload.entry,
        payload.sections,
        MAX_SAMPLES,
        payload.friction,
        payload.resistance,
    );
    let cursor = 0;
    for (let i = 0; i < runs.length; i++) {
        const run = runs[i]!;
        const result = baked.results[i];
        if (run.kind === SectionKind.Force) {
            force.push(...forceRunLane(run, cursor, nextId));
            cursor += run.extent;
            continue;
        }
        if (!result || result.edges === 0) continue;
        // the fit is seeded at the run's own FIRST SAMPLE, not at the chain entry the run was
        // placed from. `evalGeo` places the node chain rigidly, and a chain whose node 0 is not
        // at its local origin therefore opens offset from that entry; comparing a pitch sweep
        // started at the entry against a node bake started somewhere else would read the offset
        // as a shape error. On a well-formed chain the two coincide.
        const entry: Entry = {
            x: result.posX[0]!,
            y: result.posY[0]!,
            theta: result.theta[0]!,
            v: result.v[0]!,
        };
        const fit = fitGeoRun(
            result,
            entry,
            doc.track,
            cursor,
            nextId,
            runNodes(run.members),
            (step) =>
                runStrips(
                    doc.strips.slice().sort((a, b) => a.start - b.start || a.id - b.id),
                    new Float32Array(step.edges).fill(step.ds),
                    step.edges,
                    payload.offsets[i]!,
                ),
        );
        geo.push(...fit.records);
        cursor += fit.length;
    }
    return { force, geo };
}

/** the run-local stations of the run's authored C0 CORNERS: nodes carrying an explicit tangent
 *  whose in and out directions differ (spec Locked decision "geo is pitch as a parameter").
 *
 *  A corner has unbounded continuum force — the node bake spreads it over its own adaptive
 *  chords, any pitch bake over one uniform cell — so no pointwise force observable converges
 *  there at any grid. The fit mints it as an AUTHORED DISCONTINUITY instead: the predecessor
 *  exits at the last resolved heading before the node sample and the successor owns the first
 *  after it, and the force comparison is not read within one landed edge of the station.
 *
 *  `nodes` is the run's own chain in run-global order (`runNodes`) and `knots` the landing
 *  station of each, so the two are read by the same index — the node ORDER, never a position
 *  search, which is what makes an added or removed node move the corner with it. */
function cornerStations(nodes: readonly Node[], knots: readonly number[]): number[] {
    const out: number[] = [];
    for (let i = 0; i < nodes.length; i++) {
        const t = nodes[i]!.tangent;
        const station = knots[i];
        if (!t || station === undefined || station <= 0) continue;
        // direction, not magnitude: a Mirror or Aligned tangent stores different LENGTHS on the
        // two sides and is perfectly smooth, so comparing the vectors themselves would call
        // every explicit tangent a corner. The cross product against the dot is the angle
        // between them, read without a normalization that a zero-length side would divide by.
        const cross = t.inX * t.outY - t.inY * t.outX;
        const dot = t.inX * t.outX + t.inY * t.outY;
        if (Math.abs(Math.atan2(cross, dot)) > 1e-6) out.push(station);
    }
    return out;
}

/** one baked geo run re-expressed as pitch records on the ABSOLUTE ruler, offset by `cursor`.
 *
 *  **Both refusal outcomes refuse**, never silently widen a budget (spec Locked decision; the
 *  architect Answer of 2026-09-07 rejects a recorded exception as a waiver ledger). A `floor`
 *  outcome names the record floor as the obstacle and a `refused` one names convergence, but
 *  both carry the same remedy: the run holds a sub-quantum feature no ≥1 m record represents,
 *  so the document is kept readable by the `retired/pose-ux` build rather than migrated into a
 *  shape that misrepresents it. */
function fitGeoRun(
    result: SectionResult,
    entry: Entry,
    track: DocTrack,
    cursor: number,
    nextId: () => number,
    nodes: readonly Node[],
    strips: (step: Step) => readonly Strip[] | undefined,
): { records: LaneSegment[]; length: number } {
    let length = 0;
    for (let e = 0; e < result.edges; e++) length += result.ds[e]!;
    const knots: number[] = [];
    let acc = 0;
    let landing = 0;
    for (let sample = 0; sample <= result.edges; sample++) {
        if (result.offsets[landing] === sample) {
            knots.push(acc);
            landing++;
        }
        if (sample < result.edges) acc += result.ds[sample]!;
    }
    const fit = fitPitch(
        {
            x: result.posX,
            y: result.posY,
            theta: result.theta,
            fN: result.fN,
            ds: result.ds,
            edges: result.edges,
            entry,
        },
        knots,
        {
            dsNominal: track.ds,
            friction: track.friction,
            resistance: track.resistance,
            strips,
        },
        nextId,
        cornerStations(nodes, knots),
    );
    if (fit.outcome !== "budget") {
        const why =
            fit.outcome === "floor"
                ? "without a span below the record floor"
                : "even once refinement converged";
        fail(
            `a geo run at station ${cursor} cannot be fitted to pitch records within ${fit.geoBudget} m and ${fit.forceBudget} g ${why} (best ${fit.deviation.toFixed(4)} m / ${fit.forceError.toFixed(4)} g) — this run holds a feature below the authoring quantum; open it with the retired/pose-ux build to recover it`,
        );
    }
    return {
        records: fit.records.map((r) => ({ ...r, start: cursor + r.start, end: cursor + r.end })),
        length,
    };
}

/** every lane of a v3 payload, in one shared id namespace (velocity, then force, then geo) so a
 *  lane record's identity is unique across the whole document. */
export function lanesFromChain(doc: {
    track: DocTrack;
    segments: DocSegment[];
    strips: DocStrip[];
}): Lanes {
    let next = 0;
    const nextId = () => next++;
    const velocity = velocityLane(doc.strips, nextId);
    const { force, geo } = chainLanes(doc, nextId);
    return { velocity, force, geo };
}

// ── ECS → document ─────────────────────────────────────────────────────────────────────────

/** the whole live document — every authored lane record, canonically ordered, plus the
 *  track-level scalars.
 *
 *  **It emits the STORED rows and never fits.** The lanes are the store now, so a save is a
 *  transcription: no `lanesFromChain`, no `pitchfit`, nothing re-derived. That is what lets a
 *  record no fit would accept — a 1 m pitch span turning 3 radians — save and round-trip
 *  byte-identically (`tests/doc.test.ts`'s own arm), which a save that re-fitted could not
 *  promise. `Track.count` stays out: it is bake output, not authored state. */
export function docFromEcs(ecs: State): Kex2dDocument {
    const trackEid = trackEntity(ecs);
    const lanes = lanesOf(ecs);
    if (trackEid === null)
        return {
            version: CURRENT_VERSION,
            track: { ds: DS_NOMINAL, domain: Domain.Distance, friction: 0, resistance: 0 },
            lanes,
        };
    const end = Track.end.get(trackEid);
    const order = Track.order.get(trackEid);
    const v0 = Track.v0.get(trackEid);
    return {
        version: CURRENT_VERSION,
        track: {
            ds: Track.ds.get(trackEid),
            domain: Track.domain.get(trackEid),
            friction: Track.friction.get(trackEid),
            resistance: Track.resistance.get(trackEid),
            ...(end === 0 ? {} : { end }),
            ...(v0 === 0 ? {} : { v0 }),
            ...(order === 0 ? {} : { order: unpackOrder(order) }),
        },
        lanes,
    };
}

/** the `Track.order` column's one u32, back to the wire's lane list. */
function unpackOrder(packed: number): number[] {
    return [(packed >> 4) & 3, (packed >> 2) & 3, packed & 3];
}

/** the wire's lane list, packed into the `Track.order` column. */
function packOrder(order: readonly number[]): number {
    return (order[0]! << 4) | (order[1]! << 2) | order[2]!;
}

// ── document → ECS ─────────────────────────────────────────────────────────────────────────

/** the document's lane records, projected onto `restoreAll`'s own `TrackSnapshot` shape — the
 *  track's `ds`, `domain` and coefficients are applied separately by the caller. */
export function docToTrackSnapshot(doc: Kex2dDocument): TrackSnapshot {
    const records: RecordSnapshot[] = [];
    for (const [lane, rows] of [
        [Lane.Velocity, doc.lanes.velocity],
        [Lane.Force, doc.lanes.force],
        [Lane.Geo, doc.lanes.geo],
    ] as const)
        for (const r of rows) records.push({ ...r, lane });
    return {
        records,
        end: doc.track.end ?? 0,
        order: doc.track.order === undefined ? 0 : packOrder(doc.track.order),
        v0: doc.track.v0 ?? 0,
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
        `  }`,
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

function _validateSegment(v: unknown, i: number): DocSegment {
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

function _validateStrip(v: unknown, i: number): DocStrip {
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
    // shape only here — that the list is a PERMUTATION is a semantic invariant, reported by
    // `checkDocInvariants`'s `laneOrder` guard beside every other authoring law.
    if (v.order !== undefined && (!Array.isArray(v.order) || !v.order.every(isInt)))
        fail("track.order is not an array of lane integers");
    return {
        ds: v.ds as number,
        domain: v.domain as number,
        friction: v.friction as number,
        resistance: v.resistance as number,
        ...(v.end === undefined ? {} : { end: v.end as number }),
        ...(v.v0 === undefined ? {} : { v0: v.v0 as number }),
        ...(v.order === undefined ? {} : { order: v.order as number[] }),
    };
}

/** a GEO lane handle: one PITCH angle — an absolute unwrapped world heading in radians (spec
 *  Locked decision "geo is pitch as a parameter"). A bridged-v4 file written before that
 *  decision carries a node POSE object here instead; that document cannot be reinterpreted (a
 *  pose's `theta` is a run-LOCAL heading in a frame this wire no longer carries), so it is
 *  refused at load with the remedy naming its own v3 input, exactly as the spec's Wire v4
 *  paragraph asks. */
function validatePitchHandle(v: unknown, path: string): number {
    if (isPlainObject(v) && isFiniteNumber(v.x) && isFiniteNumber(v.y) && isFiniteNumber(v.theta))
        fail(
            `${path} is a node pose, which a v${CURRENT_VERSION} geo handle no longer is — this file was written by a bridged build; re-migrate its v3 original from tests/fixtures/v3/ to recover it as a pitch lane`,
        );
    if (!isFiniteNumber(v)) fail(`${path} is missing or not a finite number`);
    return v as number;
}

/** one lane record's span and its two handles. `entry` is genuinely optional (its absence is the
 *  "reads the predecessor or the lane rule" case, `lanes.entryValue`); `exit` is always owned and
 *  always required. Every lane's handles are ONE SCALAR — m/s, g, or radians of absolute
 *  unwrapped world heading — so the substrate is one shape across every lane. */
function validateLaneSegment<H>(
    v: unknown,
    lane: string,
    i: number,
    handle: (raw: unknown, path: string) => H,
): LaneSegment<H> {
    const path = `lanes.${lane}[${i}]`;
    if (!isPlainObject(v)) fail(`${path} is not an object`);
    if (!isInt(v.id)) fail(`${path}.id is missing or not an integer`);
    for (const k of ["start", "end"] as const) {
        if (!isFiniteNumber(v[k])) fail(`${path}.${k} is missing or not a finite number`);
    }
    if (
        !isInt(v.ease) ||
        (v.ease !== Easing.Linear && v.ease !== Easing.Cubic && v.ease !== Easing.Quintic)
    )
        fail(`${path}.ease is missing or not a valid Easing (0, 1, or 2)`);
    return {
        id: v.id as number,
        start: v.start as number,
        end: v.end as number,
        ease: v.ease as number,
        ...(v.entry === undefined ? {} : { entry: handle(v.entry, `${path}.entry`) }),
        exit: handle(v.exit, `${path}.exit`),
    };
}

/** a scalar lane handle: the speed (m/s) or normal-force multiple (g) at a boundary. */
function validateScalarHandle(v: unknown, path: string): number {
    if (!isFiniteNumber(v)) fail(`${path} is missing or not a finite number`);
    return v as number;
}

function validateLanes(v: unknown): Lanes {
    if (!isPlainObject(v)) fail("lanes is missing or not an object");
    const out = emptyLanes();
    for (const lane of ["velocity", "force", "geo"] as const) {
        const rows = v[lane];
        if (!Array.isArray(rows)) fail(`lanes.${lane} is missing or not an array`);
        if (lane === "geo")
            out.geo = rows.map((r, i) => validateLaneSegment(r, lane, i, validatePitchHandle));
        else out[lane] = rows.map((r, i) => validateLaneSegment(r, lane, i, validateScalarHandle));
    }
    return out;
}

/** the full structural validator — every field type-checked, every required key present,
 *  before a single ECS write happens (`loadDocument` calls this, then `restoreAll`, never the
 *  other order). Applied AFTER migration, so it only ever sees `CURRENT_VERSION` shape. */
function validateDocument(raw: Record<string, unknown>): Kex2dDocument {
    if (!isInt(raw.version)) fail("version is missing or not an integer");
    // v4 retired the one-shot array: the start speed is `track.v0` and nothing else.
    if (raw.oneShot !== undefined)
        fail(`oneShot is not a valid field on a v${CURRENT_VERSION} document (use track.v0)`);
    // `segments`/`strips` left the wire at S2e-i. A file written by the bridge build still
    // carries them; they are IGNORED rather than refused, because the lanes beside them already
    // say everything they said (spec S2e-i punch list item 3).
    return {
        version: raw.version as number,
        track: validateTrack(raw.track),
        lanes: validateLanes(raw.lanes),
    };
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

/** every lane's records, paired with their lane — the census walks one list. */
function allRecords(doc: Kex2dDocument): { lane: Lane; row: LaneSegment }[] {
    return [
        ...doc.lanes.velocity.map((row) => ({ lane: Lane.Velocity, row })),
        ...doc.lanes.force.map((row) => ({ lane: Lane.Force, row })),
        ...doc.lanes.geo.map((row) => ({ lane: Lane.Geo, row })),
    ];
}

/** the pure, no-ECS half: every invariant checkable from the parsed document's own fields.
 *  Named per-guard, matching `lanes.laneRefusals`' names, so a caller can branch on the reason
 *  without parsing the message.
 *
 *  **The census shrank at S2e-i, and that is a coverage decision, not a gap.** Six guards —
 *  `duplicateSectionOrder`, `sectionKind`, `stationTaken`, `stripKeyframeTaken`,
 *  `minNodeFloor`, `nodeZeroOrigin` — and their fixtures are gone because a two-handle record
 *  CANNOT violate them: there is no chain order to collide, no per-run kind to mismatch a
 *  payload against, no station list to double-book, no node chain to floor or to anchor at an
 *  origin. Each named a property of the retired node/keyframe substrate, not of the lanes.
 *  `minForceExtent` goes with them for a different reason, measured: it floored a force RUN's
 *  authored extent, and a run is derived now — flooring the records instead refuses documents
 *  that are legitimately authored (`force/sub-min-spacing.kex` migrates to a 0.1 m record, and
 *  `force/f32-hostile-stations.kex` to sub-metre ones), so the whole claim retired with the run.
 *
 *  **The record floor is a SETTER refusal, not a document law**, and deliberately so: a gesture
 *  may not author a span below `RECORD_FLOOR`, but a migrated document that already carries one
 *  loads rather than being refused — the same asymmetry `restoreAll` has always had, since undo
 *  restores already-accepted state without re-reading the guards. */
export function checkDocInvariants(doc: Kex2dDocument): Refusal[] {
    const refusals: Refusal[] = [];
    const records = allRecords(doc);

    const seen = new Set<number>();
    for (const { row } of records) {
        if (seen.has(row.id))
            refusals.push({
                guard: "duplicateId",
                message: `two or more lane records share id ${row.id} — ids are unique across the whole document`,
            });
        seen.add(row.id);
    }

    for (const [lane, rows] of [
        [Lane.Velocity, doc.lanes.velocity],
        [Lane.Force, doc.lanes.force],
        [Lane.Geo, doc.lanes.geo],
    ] as const)
        for (const r of laneRefusals(lane, rows)) refusals.push(r);

    for (const { row } of records) {
        if (!Number.isFinite(row.exit) || (row.entry !== undefined && !Number.isFinite(row.entry)))
            refusals.push({
                guard: "validHandle",
                message: `lane record ${row.id} carries a non-finite handle`,
            });
    }

    if (doc.track.order !== undefined && laneOrder(doc.track.order) === undefined)
        refusals.push({
            guard: "laneOrder",
            message: `track.order [${doc.track.order.join(", ")}] is not a permutation of the three lanes — a partial order would leave a lane unranked, which is a different document from the one this file claims`,
        });

    if (records.length === 0)
        refusals.push({
            guard: "emptyTrack",
            message: "a document must author at least one lane record",
        });

    for (const r of doc.lanes.velocity)
        if (!validStripValue(r.exit) || (r.entry !== undefined && !validStripValue(r.entry)))
            refusals.push({
                guard: "validStripValue",
                message: `velocity record ${r.id}'s handles must be finite and strictly positive`,
            });

    if (
        doc.track.end !== undefined &&
        doc.track.end !== 0 &&
        doc.track.end < trackEnd(doc.lanes, 0)
    )
        refusals.push({
            guard: "endBelowContent",
            message: `track.end ${doc.track.end} sits below the track's own content (${trackEnd(doc.lanes, 0)} m)`,
        });

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

/** a throwaway `State` carrying `doc`'s candidate document — never the caller's live `ecs`.
 *
 *  **Isolation contract: call only where no OTHER `State` is concurrently live in the
 *  process.** `track.ts`'s component storage is module-scoped and eid-indexed with no per-State
 *  bank (`AGENTS.md` Hard gotchas) — two `State`s allocating the same eid alias the same
 *  storage slot, so building this scratch state while another live `ecs` exists can corrupt it.
 *  `loadDocument` never calls this for exactly that reason (its geometry check runs in-place on
 *  the caller's own `ecs`, with an in-place rollback); this path is for a caller validating a
 *  candidate file in isolation — a one-shot CLI `validate`, a bare unit test. */
function buildScratchEcs(doc: Kex2dDocument): State {
    const ecs = new State();
    const trackEid = createTrack(ecs);
    restoreAll(ecs, docToTrackSnapshot(doc));
    Track.ds.set(trackEid, doc.track.ds);
    Track.domain.set(trackEid, doc.track.domain);
    Track.friction.set(trackEid, doc.track.friction);
    Track.resistance.set(trackEid, doc.track.resistance);
    return ecs;
}

/** the one guard that needs a real ECS: a velocity record must cover at least one EDGE of the
 *  partition it lands in, resolved at each derived run's own step.
 *
 *  A record narrower than an edge prescribes nothing — `edgeStrips` maps its two boundaries onto
 *  the same edge index and the point convention re-maps that onto the preceding edge, so the
 *  authored span silently governs an edge it does not cover. That is a geometry question, not a
 *  doc-level number: which edges exist depends on every run's `resolveStep`, so it is read here
 *  off the same `stripsForStep` framing the bake threads. */
function checkGeometryInvariants(ecs: State): Refusal[] {
    const rows = lanesOf(ecs).velocity;
    if (rows.length === 0) return [];
    const ds = trackDs(ecs);
    const covered = new Set<number>();
    let offset = 0;
    for (const run of derivedRunsOf(ecs)) {
        const step = resolveStep(run.length, ds);
        const grid = new Float32Array(step.edges).fill(step.ds);
        // one record at a time: the framing DROPS a row that falls wholly outside the run, so a
        // surviving spec's array index is not the record's own and coverage cannot be read off a
        // whole-lane framing.
        for (const r of rows) {
            const framed = edgeStrips(grid, step.edges, velocityRows([r], offset));
            if (framed && framed.length > 0 && framed[0]!.end > framed[0]!.start) covered.add(r.id);
        }
        for (let i = 0; i < step.edges; i++) offset += grid[i]!;
    }
    return rows
        .filter((r) => !covered.has(r.id))
        .map((r) => ({
            guard: "minExtentFloor",
            message: `velocity record ${r.id} [${r.start}, ${r.end}) covers no edge of the current partition`,
        }));
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
/** the one CONTENT refusal `migrations[3]` owns.
 *
 *  A v3 force run could carry a key past its own authored extent: the key still shaped
 *  `sampleForce`'s profile, but it sat outside the run's partition. The lane grammar has no
 *  place for it — every record is a `[start, end)` span inside its run — so migrating it means
 *  choosing between dropping authored content and minting a record the run does not contain.
 *  Neither is a migration's call, so this refuses instead, with the same named remedy every
 *  other load-boundary rejection carries. Shape problems stay tolerated (`chainToLanes`'s own
 *  docblock): this is reached only for a WELL-SHAPED v3 payload. */
function refuseKeysPastRunExtent(segments: DocSegment[]): void {
    for (const run of runsOf(segments)) {
        if (run.kind !== SectionKind.Force) continue;
        for (const key of run.members.flatMap((m) => m.points)) {
            if (key.s > run.extent)
                fail(
                    `force key ${key.id} sits at station ${key.s}, past its run's extent ${run.extent} — a v3 key outside its own run cannot migrate to a lane record`,
                );
        }
    }
}

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
    if (wellShaped) refuseKeysPastRunExtent(rest.segments as DocSegment[]);
    const track: DocTrack = {
        ds: isFiniteNumber(rawTrack.ds) ? rawTrack.ds : DS_NOMINAL,
        domain: isInt(rawTrack.domain) ? rawTrack.domain : Domain.Distance,
        friction: isFiniteNumber(rawTrack.friction) ? rawTrack.friction : 0,
        resistance: isFiniteNumber(rawTrack.resistance) ? rawTrack.resistance : 0,
        ...(v0 === undefined ? {} : { v0 }),
    };
    const lanes = wellShaped
        ? lanesFromChain({
              track,
              segments: rest.segments as DocSegment[],
              strips: rest.strips as DocStrip[],
          })
        : emptyLanes();
    return {
        ...rest,
        version: 4,
        track: { ...rawTrack, ...(v0 === undefined ? {} : { v0 }) },
        lanes,
    };
}

/** a single forward migration step: takes a raw doc at some version and returns one it stamps at
 *  a higher version. */
export type MigrationStep = (doc: Record<string, unknown>) => Record<string, unknown>;

/** forward-only migrations, keyed by the version they migrate FROM — `migrations[1]` takes a v1
 *  raw doc and returns a v2 one. The seam exists so a version bump costs one function, not a
 *  rewrite.
 *
 *  {@link preLaneMigrations} is the prefix that stops at the frozen v3 payload shape: the bake
 *  digests (`tests/mint-bake-digests.ts`) read every fixture's own v1–v3 text as their reference
 *  input, and that reference must stay computable after the store cuts over and
 *  `segments`/`strips` leave the v4 wire. */
export const preLaneMigrations: Record<number, MigrationStep> = {
    1: dropForceTangent,
    2: sectionsToSegments,
};

const migrations: Record<number, MigrationStep> = {
    ...preLaneMigrations,
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

    // Reserve every identity the wire carried, so a `createRecord` right after a load cannot
    // collide with one.
    const snap = docToTrackSnapshot(doc);
    reserveIds({ record: snap.records.map((r) => r.id) });

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
        : { records: [], end: 0, order: 0, v0: 0 };
    let trackEid = trackEntity(ecs);
    const rollbackScalars = trackEid === null ? null : readTrackScalars(trackEid);

    if (trackEid === null) trackEid = createTrack(ecs);
    // `createTrack`'s fresh entity already zeroes `count`; a REUSED entity carries the previous
    // document's bake-derived sample count until the next tick recomputes it — zero it here too,
    // so there's no window where `Track.count` describes a document that's no longer live.
    else Track.count.set(trackEid, 0);

    restoreAll(ecs, snap);
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
