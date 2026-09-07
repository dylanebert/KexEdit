import type { State } from "@dylanebert/shallot";
import { type LaneSegment, type Lanes, ordered, trackEnd } from "./lanes";
import type { Easing, ForcePoint } from "./profile";
import { SectionKind } from "./section";
import { Force, ForceBoundary, Segment } from "./track";

/** @plumbing — canonical structural row consumed by evaluator adapters. */
export interface SegmentProjectionRow {
    eid: number;
    id: number;
    order: number;
    kind: number;
    length: number;
}

/** @plumbing — rebuild canonical ordered structural input without consulting cached bake state. */
export function rebuildSegmentProjection(ecs: State): SegmentProjectionRow[] {
    const rows = [...ecs.query([Segment])].map((eid) => ({
        eid,
        id: Segment.id.get(eid),
        order: Segment.order.get(eid),
        kind: Segment.kind.get(eid),
        length: Segment.length.get(eid),
    }));
    rows.sort((a, b) => a.order - b.order);
    for (let index = 0; index < rows.length; index++) {
        if (rows[index]!.order !== index)
            throw new Error(
                `segment order must be a contiguous bijection onto 0..${rows.length - 1}`,
            );
    }
    return rows;
}

/** @temporary S3–S7 — one stable evaluator payload over contiguous canonical segments. */
export interface RunProjectionRow extends SegmentProjectionRow {
    segmentIds: number[];
    /** @temporary S3–S7 — conserved run-local boundary stations, including entry zero. */
    stations: number[];
}

/** @temporary S3–S7 — derive the evaluator partition from canonical segment order.
 * The conserved station frame is authoritative: member lengths are compatibility data and
 * must never be accumulated to reconstruct either an interior station or the run extent. */
export function rebuildRunProjection(ecs: State): RunProjectionRow[] {
    const segments = rebuildSegmentProjection(ecs);
    const runs: RunProjectionRow[] = [];
    const seen = new Set<number>();
    for (const segment of segments) {
        const runId = Segment.run.get(segment.eid);
        const entry = Segment.runStation.get(segment.eid);
        const prior = runs[runs.length - 1];
        if (prior && prior.id === runId) {
            if (prior.kind !== segment.kind) throw new Error(`run ${runId} crosses segment kinds`);
            prior.segmentIds.push(segment.id);
            prior.stations.push(entry);
            continue;
        }
        if (seen.has(runId)) throw new Error(`run ${runId} is not contiguous`);
        seen.add(runId);
        runs.push({
            ...segment,
            id: runId,
            length: Segment.runExtent.get(segment.eid),
            segmentIds: [segment.id],
            stations: [entry],
        });
    }
    for (const run of runs) run.stations.push(run.length);
    return runs;
}

/** @temporary S3–S7 — resolve one evaluator run without assuming its entry member owns all data. */
export function runProjection(ecs: State, runId: number): RunProjectionRow | undefined {
    return rebuildRunProjection(ecs).find((run) => run.id === runId);
}

/** @plumbing — evaluator-compatible force row derived from split station/boundary ownership. */
export interface ForceProjectionRow {
    eid: number;
    segment: number;
    id: number;
    s: number;
    g: number;
    ease: number;
}

/** @plumbing — reconstruct prior evaluator input without making the compatibility row an owner. */
export function rebuildForceProjection(ecs: State): ForceProjectionRow[] {
    const chainOrder = new Map(
        rebuildSegmentProjection(ecs).map((segment, index) => [segment.id, index]),
    );
    const rows = [...ecs.query([Force, ForceBoundary])].map((eid) => ({
        eid,
        segment: Force.segment.get(eid),
        id: Force.id.get(eid),
        s: Force.s.get(eid),
        g: ForceBoundary.g.get(eid),
        ease: ForceBoundary.ease.get(eid),
    }));
    rows.sort(
        (a, b) =>
            (chainOrder.get(a.segment) ?? Infinity) - (chainOrder.get(b.segment) ?? Infinity) ||
            a.s - b.s ||
            a.id - b.id,
    );
    return rows;
}

/** @temporary S7 — legacy evaluator vocabulary; never an authored owner. */
export type SectionProjectionRow = RunProjectionRow;

/** @temporary S7 — authored-section readers expose exactly one row per total run. */
export const rebuildSectionProjection = rebuildRunProjection;

// ── lane → evaluator projection ─────────────────────────────────────────────────────────────
//
// `deriveRuns` is the S2 replacement for the authored union chain (spec
// `kex2d-segment-gestures` Locked decision: "the union chain becomes derived, not authored").
// It is PURE — plain lane records in, evaluator run rows out — so the same partition a bake
// threads is readable without an ECS, which is what makes the bake-identity oracle and the
// headless CLI read one rule rather than two.

/** one evaluator run derived from the lanes: a maximal stretch of track of a single
 *  {@link SectionKind}, carrying the lane records that fall inside it.
 *
 *  `id` is the run's stable identity — its first member's lane-segment id — and is what
 *  `runInfo`/`sectionInfo` key on. `stations` holds each member's run-local entry station with
 *  the run length appended, exactly the conserved frame `RunProjectionRow.stations` published;
 *  member extents are never summed to rebuild it. `points` is the run's authored force profile
 *  in run-local arclength, empty on a geo run. */
export interface DerivedRun {
    id: number;
    kind: SectionKind;
    /** absolute track-global entry station (m). */
    start: number;
    /** the run's extent (m); for a geo run this is the sum of its members' derived spans. */
    length: number;
    segmentIds: number[];
    stations: number[];
    points: ForcePoint[];
}

/** the force-lane keys one force run publishes, in run-local arclength.
 *
 *  A boundary station carries ONE value and ONE easing tag, because the evaluator's profile is a
 *  keyframe list. At a station where a record both ends and another begins, the successor's
 *  OWNED entry wins the value (an authored discontinuity resolves forward) and otherwise the
 *  predecessor's exit stands; the easing is always the LEADING record's, because
 *  `profile.ts` gives the leading keyframe's tag the following segment (the Blender F-curve
 *  convention). A run-terminal key's tag governs nothing and is carried through unread. */
function forcePoints(rows: readonly LaneSegment[], runStart: number): ForcePoint[] {
    const startsAt = new Map<number, LaneSegment>();
    const stations: number[] = [];
    for (const r of rows) {
        startsAt.set(r.start, r);
        stations.push(r.start, r.end);
    }
    const seen = new Set<number>();
    const out: ForcePoint[] = [];
    for (const station of stations.sort((a, b) => a - b)) {
        if (seen.has(station)) continue;
        seen.add(station);
        const leading = startsAt.get(station);
        const trailing = rows.find((r) => r.end === station);
        // A gap's opening boundary is not an authored key: the lane dwells there
        // (`lanes.inferredEntry`) and `materializeRunForceClamps` supplies the run's own clamp.
        if (!leading && !trailing) continue;
        // A record that opens a span without owning its entry authors no key there: the lane
        // dwells into it and the run's own clamp supplies the value.
        const g = leading?.entry ?? trailing?.exit;
        if (g === undefined) continue;
        out.push({ s: station - runStart, g, ease: (leading ?? trailing)!.ease as Easing });
    }
    return out;
}

/** the maximal abutting groups of one lane's ordered records — the "maximal abutting group"
 *  the Locked decision names as the frame geo node positions live in. */
function abuttingGroups<H>(rows: readonly LaneSegment<H>[]): LaneSegment<H>[][] {
    const groups: LaneSegment<H>[][] = [];
    for (const r of ordered(rows)) {
        const last = groups[groups.length - 1];
        if (last && last[last.length - 1]!.end === r.start) last.push(r);
        else groups.push([r]);
    }
    return groups;
}

/** derive the evaluator's run partition from the authored lanes.
 *
 *  The geo lane owns shape wherever it has a record (Locked decision: "geo and force overlap:
 *  store both, geo drives"), so its maximal abutting groups are the geo runs and every stretch
 *  of `[0, trackEnd)` they leave uncovered is a force run. A force run gathers the force-lane
 *  records inside it as its members; one with no record at all is still baked (the force lane
 *  dwells across a gap) and takes a synthetic identity above every authored lane id so it can
 *  never collide with one.
 *
 *  `end` is `Track.end` — 0 meaning follow the longest lane, `lanes.trackEnd`'s own rule. */
export function deriveRuns(lanes: Lanes, end: number): DerivedRun[] {
    const total = trackEnd(lanes, end);
    const geoGroups = abuttingGroups(lanes.geo).filter((g) => g[0]!.start < total);
    const force = ordered(lanes.force);
    let synthetic =
        Math.max(
            -1,
            ...lanes.velocity.map((r) => r.id),
            ...lanes.force.map((r) => r.id),
            ...lanes.geo.map((r) => r.id),
        ) + 1;

    const runs: DerivedRun[] = [];
    const emitForce = (start: number, stop: number): void => {
        if (!(start < stop)) return;
        const rows = force.filter((r) => r.start < stop && start < r.end);
        const stations = rows.map((r) => r.start - start);
        if (stations[0] !== 0) stations.unshift(0);
        runs.push({
            id: rows[0]?.id ?? synthetic++,
            kind: SectionKind.Force,
            start,
            length: stop - start,
            segmentIds: rows.map((r) => r.id),
            stations: [...stations.slice(0, Math.max(1, rows.length)), stop - start],
            points: forcePoints(rows, start),
        });
    };

    let cursor = 0;
    for (const group of geoGroups) {
        emitForce(cursor, group[0]!.start);
        const start = group[0]!.start;
        const stop = Math.min(group[group.length - 1]!.end, total);
        runs.push({
            id: group[0]!.id,
            kind: SectionKind.Geo,
            start,
            length: stop - start,
            segmentIds: group.map((r) => r.id),
            stations: [...group.map((r) => r.start - start), stop - start],
            points: [],
        });
        cursor = stop;
    }
    emitForce(cursor, total);
    return runs;
}
