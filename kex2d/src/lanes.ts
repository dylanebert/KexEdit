/** the lane substrate — the authored track re-keyed as independent per-parameter lanes of
 *  two-handle segments (spec `kex2d-segment-gestures` Locked decision: "a segment is one change
 *  of one parameter over one span").
 *
 *  A lane is one parameter's whole authored history over the track's arclength ruler. Its
 *  members are {@link LaneSegment} records, each a half-open `[start, end)` span in METRES OF
 *  ARCLENGTH carrying exactly two handles — an `exit` it always owns and an `entry` it owns
 *  only when the record carries one — with a named `ease` between them.
 *
 *  **Pure by construction.** Nothing here touches the ECS, the bake, or a `State`. The laws
 *  below are total functions of plain records, so `doc.ts`'s migration and (from S2)
 *  `projection.ts`'s `deriveRuns` read the same rules from one place. `src/track.ts` is the
 *  authored ECS; this module is the grammar it will be re-keyed onto.
 *
 *  **Exclusivity, not clamping.** Within one lane two spans may abut (`a.end === b.start`) but
 *  may never overlap; an overlapping edit is REFUSED, never silently trimmed — the same
 *  contract `track.ts`'s `stripOverlapped` holds for velocity strips today, which
 *  {@link segmentOverlapped} generalizes to every lane.
 *
 *  **Gaps are legal and mean something per lane.** A stretch of track with no segment in a lane
 *  is not an error: it is the lane's inferred value (see {@link inferredEntry}) — velocity
 *  dissipates under physics, force dwells at the last authored exit (`DEFAULT_G` before any),
 *  geo yields to the force lane. */

import { DEFAULT_G } from "./profile";

/** the three authored parameters of a 2D track. Values are the wire's own lane keys' order and
 *  are not stored in a record — a segment knows its lane by the array it lives in. */
export enum Lane {
    /** speed prescriptions: today's `Strip`/`StripKeyframe`. */
    Velocity = 0,
    /** demanded normal force: today's force runs, `ForceBoundary.g`. */
    Force = 1,
    /** track shape: the authored PITCH angle (absolute unwrapped world heading, radians). */
    Geo = 2,
}

/** one change of one parameter over one span — the substrate's whole authored unit.
 *
 *  `start`/`end` are a half-open `[start, end)` span in metres of arclength on the track ruler.
 *  `exit` is the value the parameter reaches AT `end`, always owned. `entry` is the value at
 *  `start`; it is present only when this segment authors its own entry handle, and absent when
 *  the entry reads the abutting predecessor's exit or the lane's inferred value. `ease` is the
 *  `Easing` tag shaping the run from entry to exit.
 *
 *  Every lane's handles are ONE SCALAR (spec Locked decision "geo is pitch as a parameter"):
 *  velocity holds a speed in m/s, force a normal-force multiple in g, and geo a PITCH angle —
 *  an absolute unwrapped world heading in radians, so no frame column travels with a record.
 *  `H` is that handle type, kept generic because the span laws below never read it. */
export interface LaneSegment<H = number> {
    /** stable identity — survives undo/restore, never an entity id. */
    id: number;
    start: number;
    end: number;
    /** `Easing` tag (`profile.ts`) between `entry` and `exit`. */
    ease: number;
    /** present only when this segment OWNS its entry handle. */
    entry?: H;
    exit: H;
}

/** every lane of one track, keyed by parameter. All three hold the same record shape — the
 *  substrate is one scalar span grammar, not three. */
export interface Lanes {
    velocity: LaneSegment[];
    force: LaneSegment[];
    geo: LaneSegment[];
}

/** an empty lane set — the shape a document with nothing authored carries. */
export function emptyLanes(): Lanes {
    return { velocity: [], force: [], geo: [] };
}

/** the shortest span any lane record may occupy, in metres.
 *
 *  One number, in one place: a record shorter than this is not an authoring gesture but a
 *  degenerate span with no direction, and the same floor governs everywhere it is read — the
 *  document boundary's `minExtentFloor` guard, the setters' span refusals, and the split the
 *  pitch fit is allowed to mint (`pitchfit.ts`). The authoring budgets in `geofit.ts` are half
 *  of it.
 *
 *  It is a floor, never a grid: nothing here quantizes. */
export const RECORD_FLOOR = 1;

/** the lane's members in span order, ties broken by stable id so the ordering is total and
 *  independent of the caller's array order. Never mutates the input. */
export function ordered<H>(segments: readonly LaneSegment<H>[]): LaneSegment<H>[] {
    return segments.slice().sort((a, b) => a.start - b.start || a.end - b.end || a.id - b.id);
}

/** does `[start, end)` intersect any member of `segments` other than `exceptId`?
 *
 *  The generalization of `track.ts`'s `stripOverlapped` to every lane. Half-open, so abutting
 *  (`a.end === b.start`) is NOT an overlap and stays legal; a zero-length probe (`start >= end`)
 *  intersects nothing. `exceptId` lets a move/resize gesture ask the question about its own
 *  candidate span without colliding with the record it is about to replace. */
export function segmentOverlapped<H>(
    segments: readonly LaneSegment<H>[],
    start: number,
    end: number,
    exceptId?: number,
): boolean {
    if (!(start < end)) return false;
    for (const s of segments) {
        if (s.id === exceptId) continue;
        if (s.start < end && start < s.end) return true;
    }
    return false;
}

/** the lane's own exclusivity law, as a predicate over a whole lane: no two members overlap.
 *  Abutting members pass; a member with `start >= end` is degenerate and reported separately by
 *  {@link laneRefusals}. */
export function laneExclusive<H>(segments: readonly LaneSegment<H>[]): boolean {
    const rows = ordered(segments);
    for (let i = 1; i < rows.length; i++) {
        if (rows[i]!.start < rows[i - 1]!.end) return false;
    }
    return true;
}

/** every violated law in one lane, named the way `doc.ts`'s document-boundary census names its
 *  guards (`{guard, message}`) so a refusal here keys on the same vocabulary a setter's refusal
 *  does. Empty when the lane is well-formed. */
export function laneRefusals<H>(
    lane: Lane,
    segments: readonly LaneSegment<H>[],
): { guard: string; message: string }[] {
    const out: { guard: string; message: string }[] = [];
    const name = laneName(lane);
    const seen = new Set<number>();
    for (const s of segments) {
        if (seen.has(s.id))
            out.push({
                guard: "duplicateId",
                message: `two or more ${name} segments share id ${s.id}`,
            });
        seen.add(s.id);
        if (!(s.start < s.end))
            out.push({
                guard: "segmentDegenerate",
                message: `${name} segment ${s.id} spans [${s.start}, ${s.end}), which is not a positive half-open span`,
            });
    }
    const rows = ordered(segments);
    for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1]!;
        const cur = rows[i]!;
        if (cur.start < prev.end)
            out.push({
                guard: "segmentOverlapped",
                message: `${name} segment ${cur.id} [${cur.start}, ${cur.end}) overlaps segment ${prev.id} [${prev.start}, ${prev.end})`,
            });
    }
    return out;
}

/** whether a velocity handle is a speed a march may be prescribed: finite and strictly
 *  positive. A zero or negative prescription is not a slow track, it is a march with no
 *  direction, which is why this refuses rather than clamps. */
export function validStripValue(v: number): boolean {
    return Number.isFinite(v) && v > 0;
}

/** the lane's display name, used in refusal messages only. */
export function laneName(lane: Lane): string {
    return lane === Lane.Velocity ? "velocity" : lane === Lane.Force ? "force" : "geo";
}

/** the value a lane holds across a GAP that reaches `station` — the lane's own inference rule
 *  (spec Locked decision):
 *
 *  - **velocity** dissipates under physics: no prescription, so the answer is `undefined` and
 *    the evaluator's own march owns the speed there.
 *  - **force** dwells at the last authored exit at or before `station`, and at `DEFAULT_G`
 *    before any segment exists.
 *  - **geo** yields to the force lane: it prescribes no shape of its own, so `undefined`. The
 *    heading across a geo gap is not this module's to answer — the evaluator's own march owns
 *    it (`forward.step` sweeps θ from the demanded force there), which is exactly why a gap in
 *    the geo lane derives as a FORCE run rather than as a pitch run with an inferred handle.
 *
 *  `segments` need not be sorted. */
export function inferredEntry(
    lane: Lane,
    segments: readonly LaneSegment[],
    station: number,
): number | undefined {
    if (lane !== Lane.Force) return undefined;
    let best: LaneSegment | undefined;
    for (const s of segments) {
        if (s.end > station) continue;
        if (!best || s.end > best.end || (s.end === best.end && s.id > best.id)) best = s;
    }
    return best ? best.exit : DEFAULT_G;
}

/** the value at the entry handle of `segment` — the whole entry law in one place:
 *
 *  1. an OWNED entry (the record carries one) wins outright;
 *  2. otherwise an abutting predecessor's exit (`predecessor.end === segment.start`) is read;
 *  3. otherwise the lane's inferred value across the gap ({@link inferredEntry}).
 *
 *  `undefined` means the lane prescribes nothing at that boundary (velocity dissipating, geo
 *  yielding), which is a real answer and not a missing one. */
export function entryValue<H>(
    lane: Lane,
    segments: readonly LaneSegment<H>[],
    segment: LaneSegment<H>,
): H | number | undefined {
    if (segment.entry !== undefined) return segment.entry;
    let abutting: LaneSegment<H> | undefined;
    for (const s of segments) {
        if (s.id === segment.id) continue;
        if (s.end === segment.start && (!abutting || s.id > abutting.id)) abutting = s;
    }
    if (abutting) return abutting.exit;
    // only the FORCE lane infers across a gap, and its handles are scalars — the other lanes
    // answer `undefined` before the cast is ever reached.
    return inferredEntry(lane, segments as readonly LaneSegment[], segment.start);
}

/** the last station any member of `segments` reaches, or 0 for an empty lane. */
export function laneExit<H>(segments: readonly LaneSegment<H>[]): number {
    let end = 0;
    for (const s of segments) if (s.end > end) end = s.end;
    return end;
}

/** the track's end station.
 *
 *  A pinned `end` (any non-zero authored value) is the answer. `0` means FOLLOW: the end is the
 *  longest lane's last exit — Animate's rule, the document running to the last frame on any
 *  layer. A follow end over three empty lanes is 0. */
export function trackEnd(lanes: Lanes, end: number): number {
    if (end !== 0) return end;
    return Math.max(laneExit(lanes.velocity), laneExit(lanes.force), laneExit(lanes.geo));
}

/** can a pinned end move to `end`? The end handle refuses to drop below any lane's content, as
 *  Animate refuses to delete frames under a span. `0` (follow) is always legal. */
export function endPinnable(lanes: Lanes, end: number): boolean {
    if (end === 0) return true;
    if (!Number.isFinite(end) || end < 0) return false;
    return end >= trackEnd(lanes, 0);
}

/** the lane priority order — a permutation of every {@link Lane}, top to bottom, which is what
 *  `track.order` carries and `projection.deriveRuns` reads as priority (spec Locked decision
 *  "geo and force overlap: store both, lane order drives"). An absent order means the default
 *  `[Geo, Force, Velocity]`.
 *
 *  Refuses anything that is not a PERMUTATION: a short list, a repeat, an unknown lane. A
 *  partial order would silently give one lane no rank, which is a different document from the
 *  one the file claims. */
export function laneOrder(order: readonly unknown[]): Lane[] | undefined {
    const lanes = [Lane.Velocity, Lane.Force, Lane.Geo];
    if (order.length !== lanes.length) return undefined;
    const seen = new Set<number>();
    for (const v of order) {
        if (typeof v !== "number" || !lanes.includes(v as Lane) || seen.has(v)) return undefined;
        seen.add(v);
    }
    return order as Lane[];
}
