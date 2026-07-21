/** the polar snap math: two pure, device-free grid quantizers the manipulator consumes, one per
 *  axis. both are plain fixed-increment snaps (feel round 6, replacing the proximity/landmark model)
 *  — snap-by-default, the Ctrl modifier bypasses to continuous:
 *
 *  - **length** snaps the chord to whole metres (`LENGTH_STEP`), floored at `LENGTH_MIN` (a chord
 *    never collapses below a metre);
 *  - **angle** snaps to the `ANGLE_STEP` grid (5°), applied uniformly — the tip's exit incline and an
 *    interior node's chord angle alike (a plain grid needs no incline quantum, so the old
 *    "interior rotates free" asymmetry is gone).
 *
 *  no proximity window, no radius-derived pull, no continuation landmark. no shallot, no DOM —
 *  directly `bun test`-able. the increments are named constants (user-configurable later). */

/** the angle grid: the manipulator's angle control snaps to 5° increments (tip incline + interior
 *  chord alike). a design constant — the future per-user setting, one home. */
export const ANGLE_STEP = Math.PI / 36;

/** the chord-length grid: whole metres. */
export const LENGTH_STEP = 1;

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

/** snap an angle (radians) to the nearest `ANGLE_STEP` grid multiple — the pure angle snap, the
 *  angular analogue of `snapLength`. tip incline + interior chord alike. */
export function snapAngle(a: number): number {
    return Math.round(a / ANGLE_STEP) * ANGLE_STEP;
}

/** the length control's quantizer: default snaps the chord to the nearest whole metre; the modifier
 *  (`snap === false`, Ctrl held) bypasses to continuous. the `LENGTH_MIN` floor holds either way. */
export interface LengthSnap {
    /** the resolved chord length, metres (whole-metre when `snapped`, else continuous; floored). */
    meters: number;
    snapped: boolean;
}
export function snapLength(meters: number, snap: boolean): LengthSnap {
    const q = snap ? Math.round(meters / LENGTH_STEP) * LENGTH_STEP : meters;
    return { meters: Math.max(LENGTH_MIN, q), snapped: snap };
}
