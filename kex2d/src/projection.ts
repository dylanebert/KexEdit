import type { State } from "@dylanebert/shallot";
import { Segment } from "./track";

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

/** @temporary S7 — legacy evaluator vocabulary; never an authored owner. */
export type SectionProjectionRow = SegmentProjectionRow;

/** @temporary S7 — section readers eagerly see the canonical columns, so rebuilding is pure
 * and has no stale interval after a structural writer. */
export const rebuildSectionProjection = rebuildSegmentProjection;
