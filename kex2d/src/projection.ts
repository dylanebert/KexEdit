import type { State } from "@dylanebert/shallot";
import { entryValue, Lane, type LaneSegment, type Lanes, ordered, trackEnd } from "./lanes";
import { Easing, type ForcePoint, sampleForce } from "./profile";
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
    /** @temporary S3–S7 — conserved run-local member entry stations, run extent appended, so
     *  `stations.length === segmentIds.length + 1` on every run. */
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

/** one evaluator run derived from the lanes: a maximal stretch of track under a single
 *  {@link SectionKind}, carrying the lane records that fall inside it.
 *
 *  `id` is the run's stable identity — its first member's lane-segment id, or a synthetic one
 *  above every authored id when the run's first record opened before the run. `stations` holds
 *  each member's run-local entry station with the run length appended, exactly the conserved
 *  frame `RunProjectionRow.stations` publishes; member extents are never summed to rebuild it.
 *  `points` is the run's authored profile in RUN-LOCAL arclength — normal force (g) on a force
 *  run, pitch (absolute unwrapped world heading, radians) on a geo one, since both shape lanes
 *  hold scalars and read one generic path. `openEase` is the opening record's easing, which is
 *  what `section.evalPitch` gives the span from the run's entry heading to the first key. */
export interface DerivedRun {
    id: number;
    kind: SectionKind;
    /** absolute track-global entry station (m). */
    start: number;
    /** the run's extent (m). */
    length: number;
    segmentIds: number[];
    stations: number[];
    points: ForcePoint[];
    /** the opening record's `Easing` tag; `Linear` on a memberless run. */
    openEase: Easing;
}

/** the keys one lane's records publish inside a run, in run-local arclength.
 *
 *  Most boundary stations carry ONE value and ONE easing tag, because the evaluator's profile is
 *  a keyframe list, and the easing is always the LEADING record's, because `profile.ts` gives
 *  the leading keyframe's tag the following segment (the Blender F-curve convention). A
 *  run-terminal key's tag governs nothing and is carried through unread.
 *
 *  **An authored discontinuity is TWO keys at one station, exit then entry** (spec Locked
 *  decision; architect Answer, 2026-09-07, S2d): where a successor owns an entry that differs
 *  from the predecessor's exit, the author asked for a step, and a single key cannot say that —
 *  keeping only the successor's value silently rewrites the predecessor's whole span to arrive
 *  somewhere it never authored. Two keys honour the predecessor's owned exit up to the station
 *  and let the successor's value govern from it on; the zero-width span between them changes no
 *  sample, because `profile.sampleForce` and `forceProfile` already skip one.
 *
 *  Where the successor owns no entry the predecessor's exit stands alone: the lane dwells into
 *  the successor (force) or the march's incoming heading opens it (geo).
 *
 *  One implementation over BOTH shape lanes: force keys are g and pitch keys are radians, and
 *  neither this nor `profile.sampleForce` reads the unit. */
function lanePoints(rows: readonly LaneSegment[], runStart: number): ForcePoint[] {
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
        const ease = (leading ?? trailing)!.ease as Easing;
        const owned = leading?.entry;
        const prior = trailing?.exit;
        if (owned !== undefined && prior !== undefined && owned !== prior)
            out.push({ s: station - runStart, g: prior, ease });
        const g = owned ?? prior;
        if (g === undefined) continue;
        out.push({ s: station - runStart, g, ease });
    }
    return out;
}

/** the value one record's OWN curve reaches at absolute station `station`.
 *
 *  This is what a cut reads. When the driving lane's group cuts a driven record, each side of
 *  the cut is a window over the SAME authored curve, so the boundary the cut mints carries that
 *  curve's value there — never the record's far handle borrowed across the intervening run,
 *  which would step the profile at the seam and change the bake. `entry` is the value the
 *  record's own lane entry law resolved to (`lanes.entryValue`: owned, else the abutting
 *  predecessor's exit, else the lane's dwell), and it is a PRECONDITION here: a record whose
 *  entry law is undefined has no curve to read, only an exit the march walks toward, which is
 *  why {@link clipToWindow} never asks. */
function curveAt(entry: number, record: LaneSegment, station: number): number {
    return sampleForce(
        [
            { s: record.start, g: entry, ease: record.ease as Easing },
            { s: record.end, g: record.exit, ease: record.ease as Easing },
        ],
        station,
    );
}

/** one record as it is seen INSIDE the window `[start, stop)` of one derived run.
 *
 *  A record wholly inside its run passes through unchanged. A record the window cuts is
 *  narrowed to the overlap and the cut boundary becomes an OWNED handle carrying
 *  {@link curveAt}'s value, so every key the run publishes lands inside `[0, length]` and every
 *  window of a cut record agrees with its neighbours on the shared curve.
 *
 *  **A record whose entry law is undefined keeps an undefined entry, cut or not.** That is a geo
 *  record opening off a gap: the heading it starts from is the one the incoming march arrives
 *  with, which no authored handle knows and this partition must not invent. Minting a flat entry
 *  at the exit value there would author a constant-heading opening the document never asked for
 *  — a straight stretch in place of the ramp the run actually bakes (spec `kex2d-segment-gestures`
 *  architect Answer, 2026-09-07, S2d, finding (d)). */
function clipToWindow(
    lane: Lane,
    rows: readonly LaneSegment[],
    record: LaneSegment,
    start: number,
    stop: number,
): LaneSegment {
    const lo = Math.max(record.start, start);
    const hi = Math.min(record.end, stop);
    const law = entryValue(lane, rows, record) as number | undefined;
    const entry =
        lo > record.start
            ? law === undefined
                ? undefined
                : curveAt(law, record, lo)
            : record.entry;
    return {
        id: record.id,
        start: lo,
        end: hi,
        ease: record.ease,
        ...(entry === undefined ? {} : { entry }),
        exit: hi < record.end && law !== undefined ? curveAt(law, record, hi) : record.exit,
    };
}

/** the maximal abutting groups of one lane's ordered records — the stretches the DRIVING shape
 *  lane cuts the track at (spec Locked decision "geo and force overlap: store both, lane order
 *  drives"). */
function abuttingGroups(rows: readonly LaneSegment[]): LaneSegment[][] {
    const groups: LaneSegment[][] = [];
    for (const r of ordered(rows)) {
        const last = groups[groups.length - 1];
        if (last && last[last.length - 1]!.end === r.start) last.push(r);
        else groups.push([r]);
    }
    return groups;
}

/** the default lane order, top to bottom — the priority an absent `track.order` means. */
export const DEFAULT_ORDER: readonly Lane[] = [Lane.Geo, Lane.Force, Lane.Velocity];

/** derive the evaluator's run partition from the authored lanes.
 *
 *  **Lane order is priority.** Of the two SHAPE lanes (geo and force) the one standing higher in
 *  `order` DRIVES: its maximal abutting groups are the cuts, and the lower lane is driven
 *  wherever those groups cover it — its records survive intact in the authored lanes and are
 *  simply not read there. Velocity never competes for shape, so its position in `order` changes
 *  nothing in this partition. Where the driving lane has no span the driven one drives over its
 *  own groups, and where neither lane has a span the track is a FORCE run dwelling at the last
 *  exit — a force gap is always well-defined track.
 *
 *  Every emitted run has a unique id: a run whose first record OPENS there takes that record's
 *  lane id, and every other run takes a synthetic id above every authored one.
 *
 *  `end` is `Track.end` — 0 meaning follow the longest lane, `lanes.trackEnd`'s own rule.
 *  `order` defaults to {@link DEFAULT_ORDER}. */
export function deriveRuns(
    lanes: Lanes,
    end: number,
    order: readonly Lane[] = DEFAULT_ORDER,
): DerivedRun[] {
    const total = trackEnd(lanes, end);
    const geoAbove = order.indexOf(Lane.Geo) <= order.indexOf(Lane.Force);
    const geo = ordered(lanes.geo);
    const force = ordered(lanes.force);
    let synthetic =
        Math.max(
            -1,
            ...lanes.velocity.map((r) => r.id),
            ...lanes.force.map((r) => r.id),
            ...lanes.geo.map((r) => r.id),
        ) + 1;

    const runs: DerivedRun[] = [];

    /** one run over `[start, stop)` gathering `lane`'s records; `kind` is the lane's own. */
    const emit = (lane: Lane, start: number, stop: number): void => {
        if (!(start < stop)) return;
        const rows0 = lane === Lane.Geo ? geo : force;
        const members = rows0.filter((r) => r.start < stop && start < r.end);
        const rows = members.map((r) => clipToWindow(lane, rows0, r, start, stop));
        // Run identity is the first member's lane id, but only when that member OPENS here: a
        // record another group cut already spent its id on the window it started in, so a
        // continuation window takes a synthetic id above every authored one and no two derived
        // runs can ever collide. The test is the AUTHORED start, not the clipped one.
        const head = members[0];
        const opens = head !== undefined && head.start >= start;
        // Every member's own entry station, run-local, with the run length appended — the
        // conserved frame, never rebuilt by summing extents.
        runs.push({
            id: opens ? head.id : synthetic++,
            kind: lane === Lane.Geo ? SectionKind.Geo : SectionKind.Force,
            start,
            length: stop - start,
            segmentIds: rows.map((r) => r.id),
            stations: [...rows.map((r) => r.start - start), stop - start],
            points: lanePoints(rows, start),
            openEase: (rows[0]?.ease ?? Easing.Linear) as Easing,
        });
    };

    // The partition is stated once, as the stretches the GEO lane is actually read over: every
    // other stretch is a force run. That framing is what keeps force runs MAXIMAL under either
    // order — a force group's own boundary is not a cut, because the force lane bakes across it
    // unchanged (S2a decision: adjacent force runs merge), and splitting there would re-grid the
    // run under `resolveStep` for nothing.
    const span = (g: readonly LaneSegment[]): [number, number] => [
        g[0]!.start,
        g[g.length - 1]!.end,
    ];
    // where geo is driven, the force lane's groups take the overlap away from it and only the
    // remainder — the stretch the higher lane leaves uncovered — is still read as geo.
    const covers = geoAbove ? [] : abuttingGroups(force).map(span);
    const geoWindows: [number, number][] = [];
    for (const group of abuttingGroups(geo)) {
        let pieces: [number, number][] = [span(group)];
        for (const [cs, ce] of covers) {
            pieces = pieces.flatMap(([a, b]): [number, number][] => {
                const lo = Math.max(a, cs);
                const hi = Math.min(b, ce);
                if (!(lo < hi)) return [[a, b]];
                const out: [number, number][] = [];
                if (a < lo) out.push([a, lo]);
                if (hi < b) out.push([hi, b]);
                return out;
            });
        }
        geoWindows.push(...pieces);
    }
    geoWindows.sort((a, b) => a[0] - b[0]);

    let cursor = 0;
    for (const [start, end0] of geoWindows) {
        const stop = Math.min(end0, total);
        if (!(cursor < stop) || !(start < total)) continue;
        emit(Lane.Force, cursor, start);
        emit(Lane.Geo, Math.max(cursor, start), stop);
        cursor = stop;
    }
    emit(Lane.Force, cursor, total);
    return runs;
}
