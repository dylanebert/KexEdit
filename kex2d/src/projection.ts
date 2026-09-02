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
    return rows;
}

/** @temporary S3–S7 — one stable evaluator payload over contiguous canonical segments. */
export interface RunProjectionRow extends SegmentProjectionRow {
    segmentIds: number[];
}

/** @temporary S3–S7 — derive the evaluator partition from canonical segment order. */
export function rebuildRunProjection(ecs: State): RunProjectionRow[] {
    const segments = rebuildSegmentProjection(ecs);
    const runs: RunProjectionRow[] = [];
    for (const segment of segments) {
        const runId = Segment.run.get(segment.eid);
        const prior = runs[runs.length - 1];
        if (prior && prior.id === runId) {
            if (prior.kind !== segment.kind) throw new Error(`run ${runId} crosses segment kinds`);
            prior.length += segment.length;
            prior.segmentIds.push(segment.id);
            continue;
        }
        runs.push({ ...segment, id: runId, segmentIds: [segment.id] });
    }
    return runs;
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
    const rows = [...ecs.query([Force, ForceBoundary])].map((eid) => ({
        eid,
        segment: Force.segment.get(eid),
        id: Force.id.get(eid),
        s: Force.s.get(eid),
        g: ForceBoundary.g.get(eid),
        ease: ForceBoundary.ease.get(eid),
    }));
    rows.sort((a, b) => a.segment - b.segment || a.s - b.s || a.id - b.id);
    return rows;
}

/** @temporary S7 — legacy evaluator vocabulary; never an authored owner. */
export type SectionProjectionRow = SegmentProjectionRow;

/** @temporary S7 — section readers eagerly see the canonical columns, so rebuilding is pure
 * and has no stale interval after a structural writer. */
export const rebuildSectionProjection = rebuildSegmentProjection;
