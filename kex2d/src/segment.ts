/** Pure authored segment-chain laws. A segment owns its terminating boundary; its
 * start is always read from the track start or its predecessor. No editor, ECS, or
 * evaluator dependency belongs in this module. */

export type SegmentId = string | number;
export type Vec = readonly number[];
export type Point = number | Vec;
export type SegmentKind = "Geo" | "Force";
export type Easing = "Linear" | "Cubic" | "Quintic";

export interface Boundary<T = number> {
    readonly id: SegmentId;
    value: T;
}

export interface Segment<T = number> {
    readonly id: SegmentId;
    readonly kind: SegmentKind;
    duration: number;
    readonly easing: Easing;
    end: Boundary<T>;
    station?: number;
}

export interface Chain<T = number> {
    start: Boundary<T>;
    segments: Segment<T>[];
    totalDuration?: number;
}

export interface BoundaryAddress {
    readonly segmentId: SegmentId | null;
    readonly side: "start" | "end";
}

export interface HermiteCurve<T extends Point = Vec> {
    readonly p0: T;
    readonly p1: T;
    /** derivatives with respect to the curve's normalized parameter. */
    readonly m0: T;
    readonly m1: T;
}

export type Cubic<T extends Point = number> = readonly [T, T, T, T];
export type SelectionAction = "membership" | "optimize" | "delete";

export function startBoundary<T>(id: SegmentId, value: T): Boundary<T> {
    return { id, value };
}

function cloneValue<T>(value: T): T {
    return (Array.isArray(value) ? [...value] : value) as T;
}

function sameValue<T>(a: T, b: T): boolean {
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((v, i) => v === b[i]);
    }
    return Object.is(a, b);
}

function cloneSegment<T>(segment: Segment<T>): Segment<T> {
    return {
        id: segment.id,
        kind: segment.kind,
        duration: segment.duration,
        easing: segment.easing,
        end: { id: segment.end.id, value: cloneValue(segment.end.value) },
        ...(segment.station === undefined ? {} : { station: segment.station }),
    };
}

function indexOf<T>(chain: Chain<T>, id: SegmentId): number {
    const index = chain.segments.findIndex((segment) => segment.id === id);
    if (index < 0) throw new Error(`unknown segment: ${String(id)}`);
    return index;
}

function laidOut<T>(chain: Chain<T>): Chain<T> {
    let station = 0;
    const segments = chain.segments.map((segment) => {
        const next = cloneSegment(segment);
        next.station = station;
        station += next.duration;
        return next;
    });
    return {
        start: { id: chain.start.id, value: cloneValue(chain.start.value) },
        segments,
        totalDuration: station,
    };
}

/** Return the stable address of a segment's boundary. A segment's start is a read
 * of the previous owner, not an authored datum. */
export function boundaryAddress<T>(
    chain: Chain<T>,
    segmentId: SegmentId,
    side: "start" | "end" = "end",
): BoundaryAddress {
    const index = indexOf(chain, segmentId);
    if (side === "end") return { segmentId, side };
    return index === 0
        ? { segmentId: null, side: "start" }
        : { segmentId: chain.segments[index - 1].id, side: "end" };
}

/** Read the predecessor-owned boundary at a segment's entrance. */
export function readStart<T>(chain: Chain<T>, segmentId: SegmentId): Boundary<T> {
    const index = indexOf(chain, segmentId);
    return index === 0 ? chain.start : chain.segments[index - 1].end;
}

/** Read the only boundary datum authored by a segment. */
export function readEnd<T>(chain: Chain<T>, segmentId: SegmentId): Boundary<T> {
    return chain.segments[indexOf(chain, segmentId)].end;
}

/** Whether the selected uniform transition is the degenerate equal-value dwell. */
export function isDwell<T>(chain: Chain<T>, segmentId: SegmentId): boolean {
    return sameValue(readStart(chain, segmentId).value, readEnd(chain, segmentId).value);
}

/** Insert a segment before an index or before the segment with that stable id. The
 * inserted segment owns its end; the following segment consequently reads it. */
export function insertSegment<T>(
    chain: Chain<T>,
    segment: Segment<T>,
    before: number | SegmentId = chain.segments.length,
): Chain<T> {
    if (chain.segments.some((candidate) => candidate.id === segment.id)) {
        throw new Error(`duplicate segment: ${String(segment.id)}`);
    }
    const index = typeof before === "number" ? before : indexOf(chain, before);
    if (!Number.isInteger(index) || index < 0 || index > chain.segments.length) {
        throw new RangeError("insertion index is outside the chain");
    }
    const segments = chain.segments.map(cloneSegment);
    segments.splice(index, 0, cloneSegment(segment));
    return laidOut({ start: chain.start, segments });
}

/** Delete a segment while keeping the chain gapless. Its terminating boundary is
 * transferred to the predecessor (or to the track-start record), so downstream
 * segment identities and absolute values are not rewritten. */
export function deleteSegment<T>(chain: Chain<T>, segmentId: SegmentId): Chain<T> {
    const index = indexOf(chain, segmentId);
    const removed = chain.segments[index];
    const segments = chain.segments.filter((segment) => segment.id !== segmentId).map(cloneSegment);
    if (index === 0) {
        return laidOut({
            start: { id: chain.start.id, value: cloneValue(removed.end.value) },
            segments,
        });
    }
    segments[index - 1].end.value = cloneValue(removed.end.value);
    return laidOut({ start: chain.start, segments });
}

/** Change one segment's extent. End-boundary ownership and every later segment
 * remain affixed; their derived stations shift by the same delta. */
export function resizeDuration<T>(
    chain: Chain<T>,
    segmentId: SegmentId,
    duration: number,
): Chain<T> {
    if (!Number.isFinite(duration) || duration <= 0)
        throw new RangeError("duration must be positive");
    const segments = chain.segments.map(cloneSegment);
    segments[indexOf(chain, segmentId)].duration = duration;
    return laidOut({ start: chain.start, segments });
}

/** Return the derived start station for every segment, in chain order. */
export function segmentStations<T>(chain: Chain<T>): number[] {
    return laidOut(chain).segments.map((segment) => segment.station ?? 0);
}

function pointAdd<T extends Point>(a: T, b: T): T {
    if (typeof a === "number" && typeof b === "number") return (a + b) as T;
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
        return a.map((value, index) => value + b[index]) as unknown as T;
    }
    throw new TypeError("curve points must have the same scalar or vector shape");
}

function pointSub<T extends Point>(a: T, b: T): T {
    if (typeof a === "number" && typeof b === "number") return (a - b) as T;
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
        return a.map((value, index) => value - b[index]) as unknown as T;
    }
    throw new TypeError("curve points must have the same scalar or vector shape");
}

function pointScale<T extends Point>(value: T, factor: number): T {
    if (typeof value === "number") return (value * factor) as T;
    return value.map((component) => component * factor) as unknown as T;
}

function midpoint<T extends Point>(a: T, b: T, t: number): T {
    return pointAdd(a, pointScale(pointSub(b, a), t));
}

/** Split a cubic Bézier exactly with De Casteljau at normalized parameter `t`. */
export function splitCubic<T extends Point>(curve: Cubic<T>, t: number): [Cubic<T>, Cubic<T>] {
    if (!Number.isFinite(t) || t <= 0 || t >= 1)
        throw new RangeError("split parameter must be inside (0, 1)");
    const [p0, p1, p2, p3] = curve;
    const a = midpoint(p0, p1, t);
    const b = midpoint(p1, p2, t);
    const c = midpoint(p2, p3, t);
    const d = midpoint(a, b, t);
    const e = midpoint(b, c, t);
    const f = midpoint(d, e, t);
    return [
        [p0, a, d, f],
        [f, e, c, p3],
    ];
}

/** Evaluate a normalized-parameter cubic Hermite curve. */
export function evalHermite<T extends Point>(curve: HermiteCurve<T>, t: number): T {
    if (!Number.isFinite(t) || t < 0 || t > 1)
        throw new RangeError("curve parameter must be inside [0, 1]");
    const t2 = t * t;
    const t3 = t2 * t;
    return pointAdd(
        pointAdd(pointScale(curve.p0, 2 * t3 - 3 * t2 + 1), pointScale(curve.m0, t3 - 2 * t2 + t)),
        pointAdd(pointScale(curve.p1, -2 * t3 + 3 * t2), pointScale(curve.m1, t3 - t2)),
    );
}

function hermiteSpeed(curve: HermiteCurve<readonly number[]>, t: number): number {
    const t2 = t * t;
    let sum = 0;
    for (let i = 0; i < curve.p0.length; i++) {
        const d =
            (6 * t2 - 6 * t) * curve.p0[i]! +
            (3 * t2 - 4 * t + 1) * curve.m0[i]! +
            (-6 * t2 + 6 * t) * curve.p1[i]! +
            (3 * t2 - 2 * t) * curve.m1[i]!;
        sum += d * d;
    }
    return Math.sqrt(sum);
}

function hermiteLength(curve: HermiteCurve<readonly number[]>, end: number): number {
    // Composite Simpson integration is deterministic and converges rapidly for a cubic's speed.
    const steps = 128;
    const h = end / steps;
    let sum = hermiteSpeed(curve, 0) + hermiteSpeed(curve, end);
    for (let i = 1; i < steps; i++) sum += (i & 1 ? 4 : 2) * hermiteSpeed(curve, i * h);
    return (sum * h) / 3;
}

/** Invert a fraction of a cubic Hermite curve's arclength to normalized parameter. */
export function invertHermiteArclength(
    curve: HermiteCurve<readonly number[]>,
    fraction: number,
): number {
    if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1)
        throw new RangeError("arclength fraction must be inside (0, 1)");
    const target = hermiteLength(curve, 1) * fraction;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 48; i++) {
        const mid = (lo + hi) / 2;
        if (hermiteLength(curve, mid) < target) lo = mid;
        else hi = mid;
    }
    return (lo + hi) / 2;
}

/** Split a normalized-parameter cubic Hermite curve exactly. The returned
 * derivatives are with respect to each half's normalized parameter. */
export function splitHermite<T extends Point>(
    curve: HermiteCurve<T>,
    t: number,
): [HermiteCurve<T>, HermiteCurve<T>] {
    if (!Number.isFinite(t) || t <= 0 || t >= 1)
        throw new RangeError("split parameter must be inside (0, 1)");
    const controls: Cubic<T> = [
        curve.p0,
        pointAdd(curve.p0, pointScale(curve.m0, 1 / 3)),
        pointSub(curve.p1, pointScale(curve.m1, 1 / 3)),
        curve.p1,
    ];
    const [left, right] = splitCubic(controls, t);
    return [
        {
            p0: left[0],
            p1: left[3],
            m0: pointScale(pointSub(left[1], left[0]), 3),
            m1: pointScale(pointSub(left[3], left[2]), 3),
        },
        {
            p0: right[0],
            p1: right[3],
            m0: pointScale(pointSub(right[1], right[0]), 3),
            m1: pointScale(pointSub(right[3], right[2]), 3),
        },
    ];
}

/** Uniformly resize a geometry curve in its entry frame. The entry is the local
 * origin, so the endpoint and both concrete tangent vectors scale together. */
export function scaleGeometry<T extends Point>(
    curve: HermiteCurve<T>,
    factor: number,
): HermiteCurve<T> {
    if (!Number.isFinite(factor) || factor < 0)
        throw new RangeError("scale factor must be non-negative");
    return {
        p0: pointScale(curve.p0, factor),
        p1: pointScale(curve.p1, factor),
        m0: pointScale(curve.m0, factor),
        m1: pointScale(curve.m1, factor),
    };
}

/** Collect all channel cuts once. Duplicate cuts are removed without changing any
 * channel's values; evaluators can then split their own exact representation at
 * these shared stations. */
export function unionChannelBoundaries(
    channels: readonly (readonly number[] | { readonly boundaries: readonly number[] })[],
): number[] {
    const cuts: number[] = [];
    for (const channel of channels) {
        const boundaries = Array.isArray(channel)
            ? channel
            : "boundaries" in channel
              ? channel.boundaries
              : (() => {
                    throw new TypeError("channel must provide boundaries");
                })();
        for (const boundary of boundaries) {
            if (!Number.isFinite(boundary))
                throw new RangeError("channel boundaries must be finite");
            cuts.push(boundary);
        }
    }
    return [...new Set(cuts)].sort((a, b) => a - b);
}

export const unionBoundaries = unionChannelBoundaries;

/** Toggle one stable id without mutating the current selection. */
export function toggleSelectionMember(ids: readonly SegmentId[], id: SegmentId): SegmentId[] {
    const index = ids.indexOf(id);
    if (index < 0) return [...ids, id];
    return ids.filter((_, memberIndex) => memberIndex !== index);
}

/** Multi-selection deliberately has no scalar editing verbs. Membership is the
 * selection operation itself; optimize and delete are the only bulk operations. */
export function allowedSelectionActions(_ids: readonly SegmentId[]): SelectionAction[] {
    return ["membership", "optimize", "delete"];
}

export function isMultiSelection(ids: readonly SegmentId[]): boolean {
    return ids.length > 1;
}

/** A station-shaped force key at the temporary run wire boundary. */
export interface ForceStation<T = number> {
    readonly id: SegmentId;
    readonly station: number;
    readonly value: T;
}

/** One canonical member produced by force-station union. `entryStation` is conserved;
 * `duration` and `localStation` are compatibility projections between adjacent stations. */
export interface ForceUnionMember<T = number> {
    id: SegmentId;
    readonly entryStation: number;
    duration: number;
    localStation: number;
    boundary?: ForceStation<T>;
}

/** The ordered station vector is the conserved run frame. Its last entry is the extent;
 * member durations must never be used to reconstruct any entry or the terminal station. */
export interface ForceUnionRun<T = number> {
    readonly id: SegmentId;
    readonly extent: number;
    readonly stations: readonly number[];
    readonly start?: ForceStation<T>;
    members: ForceUnionMember<T>[];
}

/** Union positive-duration force-key stations into canonical members. A key at zero
 * is the predecessor-less start boundary; each later key terminates one member. The
 * terminal member is the residual against the conserved compatibility extent. */
export function forceStationUnion<T>(
    runId: SegmentId,
    extent: number,
    runEntry: ForceStation<T> | undefined,
    points: readonly ForceStation<T>[],
    allocateId: (memberIndex: number) => SegmentId,
): ForceUnionRun<T> {
    if (!Number.isFinite(extent) || extent <= 0)
        throw new RangeError("run extent must be positive");
    const sorted = [...points].sort((a, b) => a.station - b.station);
    for (const point of sorted)
        if (!Number.isFinite(point.station) || point.station < 0 || point.station > extent)
            throw new RangeError("force station is outside the run");
    if (runEntry !== undefined && runEntry.station !== 0)
        throw new RangeError("run entry force boundary must be at station zero");
    let cursor = 0;
    let first = true;
    const members: ForceUnionMember<T>[] = [];
    for (const point of sorted) {
        if (point.station === 0)
            throw new RangeError("station-zero force boundary must use the explicit run entry");
        const duration = point.station - cursor;
        if (!(duration > 0)) throw new RangeError("force boundaries must own positive duration");
        members.push({
            id: first ? runId : allocateId(members.length),
            entryStation: cursor,
            duration,
            localStation: duration,
            boundary: point,
        });
        first = false;
        cursor = point.station;
    }
    if (cursor < extent) {
        members.push({
            id: first ? runId : allocateId(members.length),
            entryStation: cursor,
            duration: extent - cursor,
            localStation: 0,
        });
    }
    // Allocation is deterministic by contract: exactly one callback in canonical member order
    // for every member after the run-id member, with its final zero-based member index.
    return {
        id: runId,
        extent,
        stations: [...members.map((m) => m.entryStation), extent],
        start: runEntry,
        members,
    };
}

/** Project canonical members back to the exact run-nested, station-shaped v3 arm. */
export function projectForceRun<T>(run: ForceUnionRun<T>): {
    id: SegmentId;
    extent: number;
    points: ForceStation<T>[];
} {
    const points: ForceStation<T>[] = [];
    if (run.start) points.push(run.start);
    // The wire station retained on the boundary is authoritative. Re-summing independently
    // rounded f32 member durations would drift and is expressly not the conserved quantity.
    for (const member of run.members) if (member.boundary) points.push(member.boundary);
    return { id: run.id, extent: run.extent, points };
}
