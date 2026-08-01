/** the polar snap math: the two grid quantizers the manipulator consumes, one per axis. both are
 *  plain fixed-increment snaps (feel round 6, replacing the proximity/landmark model) —
 *  snap-by-default, the Ctrl modifier bypasses to continuous:
 *
 *  - **length** snaps the chord to the `snapSteps.length` grid (default whole metres), floored at
 *    `LENGTH_MIN` (a chord never collapses below a metre);
 *  - **angle** snaps to the `snapSteps.angle` grid (default 5°), applied uniformly — the tip's exit
 *    incline and an interior node's chord angle alike (a plain grid needs no incline quantum, so the
 *    old "interior rotates free" asymmetry is gone).
 *
 *  no proximity window, no radius-derived pull, no continuation landmark. no shallot, no DOM —
 *  directly `bun test`-able. the two increments are per-user settings (`settings.ts`), read LIVE per
 *  quantize rather than passed in, so an edited value lands on the next gesture with nothing to
 *  re-thread; that one module read is the only state either quantizer touches. */

import { snapSteps } from "./settings";

/** the minimum chord length (metres): a chord never collapses onto the previous node (which would
 *  leave a degenerate polar frame with no direction). holds whether or not snapping is on. */
export const LENGTH_MIN = 1;

// the exit-incline convention (the tip's angle control). PC2 quantizes the tip's EXIT-TANGENT
// incline, not the raw chord: the reflected exit incline is `2·chord − tangent`, so the chord that
// yields a given exit incline is `(incline + tangent)/2`. the angle control snaps the incline to the
// grid, then maps back to the chord that produces it.

/** the tip's exit incline for a chord at `chordAngle`, given the previous exit incline `tangent`. */
export function inclineOf(chordAngle: number, tangent: number): number {
    return 2 * chordAngle - tangent;
}

/** the chord angle that yields a target exit incline (the inverse of `inclineOf`). */
export function chordForIncline(incline: number, tangent: number): number {
    return (incline + tangent) / 2;
}

/** snap an angle (radians) to the nearest `snapSteps.angle` grid multiple — the pure angle snap, the
 *  angular analogue of `snapLength`. tip incline + interior chord alike. */
export function snapAngle(a: number): number {
    const step = snapSteps.angle;
    return Math.round(a / step) * step;
}

/** the length control's quantizer: default snaps the chord to the nearest `snapSteps.length`
 *  multiple; the modifier (`snap === false`, Ctrl held) bypasses to continuous. the `LENGTH_MIN`
 *  floor holds either way. */
export interface LengthSnap {
    /** the resolved chord length, metres (on the `snapSteps.length` grid when `snapped`, else
     *  continuous; floored either way). */
    meters: number;
    snapped: boolean;
}
export function snapLength(meters: number, snap: boolean): LengthSnap {
    const step = snapSteps.length;
    const q = snap ? Math.round(meters / step) * step : meters;
    return { meters: Math.max(LENGTH_MIN, q), snapped: snap };
}

/** the interior chord axes' quantizer (slide ∥ / offset ⊥, kex2d-node-move-ux stage 2): the SAME
 *  `snapSteps.length` grid as `snapLength`, but with NO floor. `LENGTH_MIN` guards a chord
 *  collapsing onto the previous node (which would leave `polarFrame` with no direction) — a
 *  category error on an interior axis, which is a genuine signed 1D coordinate: 0 (on the chord
 *  line; at the previous node's own station) is a legitimate value, negative is the other
 *  side/direction. The degenerate-chord hazard a snapped-to-0 slide/offset can create (landing
 *  exactly on a neighbor) is accepted — the same tolerance the tangent-edit free node-body drag
 *  already extends. Ctrl (`snap === false`) bypasses to continuous, same as `snapLength`. Since 0
 *  is a real reading here (unlike `snapLength`, which never surfaces it past the floor), a
 *  negative value quantizing to the zero bin is normalized off `-0` (`fmt`'s own display rule,
 *  applied here at the source so no consumer re-derives it). */
export function snapGrid(value: number, snap: boolean): LengthSnap {
    const step = snapSteps.length;
    const q = snap ? Math.round(value / step) * step : value;
    return { meters: q === 0 ? 0 : q, snapped: snap };
}
