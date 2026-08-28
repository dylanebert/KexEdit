/** S1 of `kex2d-segment-spike` (see the spec, `specs/kex2d-segment-spike.md`): the pure segment
 *  model and the ripple duration law over a LOCAL `ForcePoint[]` copy — never the document, never
 *  the ECS. Boundary values are absolute; durations are chained (each segment's span is the gap
 *  between its two adjacent boundaries' `s`). This module owns three things only: the segment view
 *  over `points`, hit-testing (nearest-boundary preference over the segment area, with deterministic
 *  cycling on a repeated click at tied boundaries), and knob/duration geometry for one active
 *  segment. No draw code, no Svelte, no ECS — the caller (S2) projects `s`/`g` to screen space and
 *  drives this module with already-projected candidates, exactly `strip-hit.ts`'s convention. The
 *  arc a caller renders is read through `profile.ts`'s `sampleForce`/`segmentControls` directly —
 *  this module introduces no second evaluator.
 *
 *  The duration law is ripple, and it is the only law (the "absorbed by the neighbour" roll
 *  alternative was proposed and rejected — Locked decision): editing the duration of the segment
 *  ending at boundary `index` shifts that boundary and every later boundary's `s` by exactly the
 *  edit's delta, and leaves every boundary's `g`/`ease`/handle untouched. The total span (the last
 *  boundary's `s`) moves by the same delta, since it is itself a later boundary (or the edited one). */

import type { ForcePoint } from "./profile";

/** one segment between two adjacent boundaries in `points` — `index` names the LEADING boundary,
 *  so segment `index`'s span is `points[index + 1].s - points[index].s`. */
export interface Segment {
    index: number;
    a: ForcePoint;
    b: ForcePoint;
}

/** the local segment view over `points`: one entry per adjacent boundary pair, in `points` order.
 *  `points` MUST already be sorted by `s` (the same precondition `sampleForce` carries) — this
 *  module never sorts, since sorting is the caller's seeding step, not a segment-model concern. */
export function segments(points: readonly ForcePoint[]): Segment[] {
    const out: Segment[] = [];
    for (let i = 0; i + 1 < points.length; i++) {
        out.push({ index: i, a: points[i], b: points[i + 1] });
    }
    return out;
}

/** one boundary's `s`/`g`, at its `points` index — the "knob" position for the active segment's
 *  two ends. Domain-space (s, g), not screen space: the caller projects, this stays pure. */
export interface Knob {
    index: number;
    s: number;
    g: number;
}

/** knob geometry for one active segment's two boundaries — always exactly the segment's own `a`
 *  and `b`, deliberately trivial: the geometry IS the boundary, nothing derived. Throws on an
 *  out-of-range `segmentIndex` rather than returning a partial pair, so a caller's off-by-one
 *  never silently draws one knob. */
export function segmentKnobs(points: readonly ForcePoint[], segmentIndex: number): [Knob, Knob] {
    if (segmentIndex < 0 || segmentIndex + 1 >= points.length) {
        throw new Error(`segmentKnobs: segmentIndex out of range (${segmentIndex})`);
    }
    const a = points[segmentIndex];
    const b = points[segmentIndex + 1];
    return [
        { index: segmentIndex, s: a.s, g: a.g },
        { index: segmentIndex + 1, s: b.s, g: b.g },
    ];
}

/** a boundary candidate for hit-testing, already projected to screen x by the caller — the same
 *  convention `strip-hit.ts`'s `StripHitCandidate` uses, so this module never touches a coordinate
 *  system. `index` is the boundary's index into `points`. */
export interface BoundaryCandidate {
    index: number;
    x: number;
}

/** a segment-area candidate for hit-testing, already projected to screen x — `x0 < x1`, the
 *  segment's own span. `index` is the segment's leading-boundary index (`Segment.index`). */
export interface SegmentCandidate {
    index: number;
    x0: number;
    x1: number;
}

export type SpikeHit =
    | { kind: "boundary"; index: number }
    | { kind: "segment"; index: number }
    | { kind: "none" };

/** the cycling state a caller threads across clicks: the last pointer x that resolved a tied
 *  boundary set, and how many times in a row that exact x has been clicked. Passing the previous
 *  call's returned `state` back in is what makes repeated clicks at the same x advance the cycle;
 *  a click at any other x resets it. */
export interface HitState {
    x: number;
    cycle: number;
}

/** classify a pointer x against already-projected boundary and segment candidates. Nearest-boundary
 *  preference: any boundary within `radius` of `pointerX` wins over a segment-area hit, even when
 *  the pointer also sits inside that segment's own span — mirrors `strip-hit.ts`'s
 *  endpoint-beats-body precedence. Among several boundaries within `radius` (tightly overlapping
 *  boundaries), the nearest wins on a fresh click; a repeated click at the exact same `pointerX`
 *  (per `prev`) advances deterministically through the tied set in nearest-first, index-tiebroken
 *  order, wrapping around. No boundary in range falls through to the first segment whose `[x0, x1]`
 *  contains `pointerX`; nothing at all is `{ kind: "none" }`. */
export function pickHit(
    pointerX: number,
    boundaries: readonly BoundaryCandidate[],
    segs: readonly SegmentCandidate[],
    radius: number,
    prev: HitState | null,
): { hit: SpikeHit; state: HitState } {
    const within = boundaries
        .map((b) => ({ b, d: Math.abs(b.x - pointerX) }))
        .filter((c) => c.d <= radius)
        .sort((p, q) => p.d - q.d || p.b.index - q.b.index);

    if (within.length > 0) {
        const repeat = prev !== null && prev.x === pointerX;
        const cycle = repeat ? (prev.cycle + 1) % within.length : 0;
        const chosen = within[cycle];
        return { hit: { kind: "boundary", index: chosen.b.index }, state: { x: pointerX, cycle } };
    }

    for (const s of segs) {
        if (pointerX >= s.x0 && pointerX <= s.x1) {
            return { hit: { kind: "segment", index: s.index }, state: { x: pointerX, cycle: 0 } };
        }
    }

    return { hit: { kind: "none" }, state: { x: pointerX, cycle: 0 } };
}

/** the duration law, and the only one (ripple — Locked decision, no roll/absorb alternative): edit
 *  the duration of the segment ending at boundary `boundaryIndex` (`points[boundaryIndex]` is that
 *  segment's trailing/right boundary) by `delta`. `boundaryIndex` and every later boundary's `s`
 *  shift by exactly `delta`; every boundary's `g`/`ease`/`in`/`out` is untouched. The edited
 *  segment's own duration changes by `delta`; every later segment's duration is unchanged, since
 *  both its endpoints shift together; the total span (the last boundary's `s`) moves by `delta`
 *  because it is itself at or after `boundaryIndex`. `boundaryIndex` must name a real trailing
 *  boundary (`1 <= boundaryIndex < points.length`) — boundary 0 terminates no segment, so it is not
 *  a valid duration-edit target. */
export function rippleDuration(
    points: readonly ForcePoint[],
    boundaryIndex: number,
    delta: number,
): ForcePoint[] {
    if (boundaryIndex < 1 || boundaryIndex >= points.length) {
        throw new Error(`rippleDuration: boundaryIndex out of range (${boundaryIndex})`);
    }
    return points.map((p, i) => (i >= boundaryIndex ? { ...p, s: p.s + delta } : p));
}
