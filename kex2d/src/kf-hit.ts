/** Pure chart hit routing over already-projected pixel coordinates. The caller supplies one fresh
 * snapshot for the whole press; this is the chart counterpart of `bandDown`, rather than a set of
 * independently paced DOM hit targets.
 *
 * Specificity is deliberate: knob, point, terminating boundary, span body, empty chart. Points
 * remain nearest-wins because overlapping fat point radii are a proximity question. An exact
 * point tie preserves the former paint order by choosing strip over force. */

export type KfKind = "force" | "strip";

export interface KfPointCandidate {
    kind: KfKind;
    id: number;
    x: number;
    y: number;
}

export interface KfKnobCandidate {
    id: number;
    edge: "start" | "end";
    x: number;
    y: number;
}

export interface KfSpanCandidate {
    id: number;
    x0: number;
    x1: number;
}

export interface KfHitCandidate {
    knobs: readonly KfKnobCandidate[];
    points: readonly KfPointCandidate[];
    spans: readonly KfSpanCandidate[];
}

export type KfHit =
    | { kind: "knob"; id: number; edge: "start" | "end" }
    | { kind: "point"; pointKind: KfKind; id: number }
    | { kind: "boundary"; id: number }
    | { kind: "body"; id: number }
    | { kind: "empty" };

function d2(x: number, y: number, point: { x: number; y: number }): number {
    const dx = x - point.x;
    const dy = y - point.y;
    return dx * dx + dy * dy;
}

/** Classify one chart coordinate. `radius` is the shared fat-hit radius for point-like subjects
 * and the horizontal tolerance around a full-height terminating boundary. */
export function classifyKfHit(
    x: number,
    y: number,
    candidates: KfHitCandidate,
    radius: number,
): KfHit {
    const r2 = radius * radius;

    let knob: KfKnobCandidate | null = null;
    let knobD2 = r2;
    for (const candidate of candidates.knobs) {
        const distance = d2(x, y, candidate);
        if (distance > knobD2) continue;
        if (knob !== null && distance === knobD2) continue;
        knob = candidate;
        knobD2 = distance;
    }
    if (knob !== null) return { kind: "knob", id: knob.id, edge: knob.edge };

    let point: KfPointCandidate | null = null;
    let pointD2 = r2;
    for (const candidate of candidates.points) {
        const distance = d2(x, y, candidate);
        if (distance > pointD2) continue;
        if (
            point !== null &&
            distance === pointD2 &&
            !(candidate.kind === "strip" && point.kind === "force")
        )
            continue;
        point = candidate;
        pointD2 = distance;
    }
    if (point !== null) return { kind: "point", pointKind: point.kind, id: point.id };

    let boundary: KfSpanCandidate | null = null;
    let boundaryDistance = radius;
    for (const candidate of candidates.spans) {
        const distance = Math.abs(x - candidate.x1);
        if (distance > boundaryDistance) continue;
        if (boundary !== null && distance === boundaryDistance) continue;
        boundary = candidate;
        boundaryDistance = distance;
    }
    if (boundary !== null) return { kind: "boundary", id: boundary.id };

    for (const candidate of candidates.spans) {
        const lo = Math.min(candidate.x0, candidate.x1);
        const hi = Math.max(candidate.x0, candidate.x1);
        if (x >= lo && x <= hi) return { kind: "body", id: candidate.id };
    }
    return { kind: "empty" };
}
