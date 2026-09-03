import type { State } from "@dylanebert/shallot";
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
