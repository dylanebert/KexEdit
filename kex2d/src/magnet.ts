/** the polar snap resolvers: two pure, device-free 1D families, both relative to the **previous
 *  node** — the exit-tangent **incline** raster (15°, tip drags only) with a continuation landmark,
 *  and the chord-length raster (1 m). the polar manipulator (`manipulator.ts`) consumes them one per
 *  axis: each gesture is already 1-DOF, so there is no screen-px pool, co-fire, or shift-lock here
 *  (the legacy `resolveSnap` 2D pool retired with the free node drag, stage 5). the shaping viewport
 *  is the earned exception to the no-rasters clause (`editor-ui.md`): the PC2 building vocabulary IS
 *  this surface's semantic quantum, and snap quantizes what the piece *does* — its exit incline, its
 *  chord length — never the raw chord angle. no shallot, no DOM — directly `bun test`-able. */

import { SNAP_PX } from "./timeline";

/** the shaping viewport's angular quantum: the tip's exit-tangent incline snaps to 15°
 *  multiples (PC2 quantizes what the piece *does* — its exit incline — not the raw chord). a
 *  design constant (the `SNAP_PX` precedent), tuned only at the feel check — never a per-user
 *  setting. */
export const ANGLE_STEP = Math.PI / 12;

/** the chord-length quantum: integer meters (1 m). the PC2 integer-meter building idiom. */
export const LENGTH_STEP = 1;

// the exit-incline convention (one home for the 1D resolvers + the manipulator's angle control).
// PC2 quantizes the tip's EXIT-TANGENT incline, not the raw chord: the tip's reflected exit incline
// is `2·chord − tangent`, so the chord that yields a given exit incline is `(incline + tangent)/2`.
// these three are the only snap MATH the incline family carries — the resolvers snap-nearest over
// the same primitives.

/** the tip's exit incline for a chord at `chordAngle`, given the previous exit incline `tangent`. */
export function inclineOf(chordAngle: number, tangent: number): number {
    return 2 * chordAngle - tangent;
}

/** the nearest `ANGLE_STEP` raster multiple to an exit incline. */
export function rasterIncline(incline: number): number {
    return Math.round(incline / ANGLE_STEP) * ANGLE_STEP;
}

/** the chord angle that yields a target exit incline (the inverse of `inclineOf`). */
export function chordForIncline(incline: number, tangent: number): number {
    return (incline + tangent) / 2;
}

/** the chord-length 1D resolver: snap a raw chord length (metres) to the nearest whole metre when
 *  the raster sits within `snapPx` of the drag (converted through `pxPerMeter`). the target must be
 *  ≥ 1 m — a 0 m target is the previous node itself (a degenerate coincident node) — and a
 *  non-positive scale disables the family. one of the two per-axis families the polar manipulator
 *  consumes; the length gesture is 1-DOF, so there is no pool, co-fire, or shift-lock here. */
export interface LengthSnap {
    /** the resolved chord length, metres (the whole-metre raster when `snapped`, else the input). */
    meters: number;
    snapped: boolean;
}
export function snapLength(meters: number, pxPerMeter: number, snapPx = SNAP_PX): LengthSnap {
    if (pxPerMeter <= 0) return { meters, snapped: false };
    const target = Math.round(meters / LENGTH_STEP) * LENGTH_STEP;
    if (target < 1) return { meters, snapped: false };
    if (Math.abs(meters - target) * pxPerMeter > snapPx) return { meters, snapped: false };
    return { meters: target, snapped: true };
}

/** the exit-incline 1D resolver (growth tip only): given the raw `chordAngle`, the previous exit
 *  incline `tangent` (world radians) and the tip radius `radiusPx` (screen px, which sets the
 *  angular pull), snap the tip's exit incline to the nearer of the 15° raster or the continuation
 *  landmark (incline = tangent) when it sits within `snapPx`. the pull is a perpendicular screen-px
 *  corridor at the tip radius, so the angular window is DERIVED (px ÷ radius), never a degree count
 *  (the `SNAP_PX` design-constant precedent, `editor-ui.md`): arc distance = Δchord·radius and the
 *  incline is 2·chord, so the window on the incline is `2·snapPx/radius`. returns the snapped incline
 *  and the chord angle that yields it. an interior node (a frozen heading, no incline to snap) never
 *  reaches here — the manipulator gates the family on a non-null tangent. */
export interface InclineSnap {
    /** the chord angle that yields `incline` (the snapped chord when `snapped`, else the input). */
    angle: number;
    /** the tip's exit incline (the raster/continuation landmark when `snapped`, else the raw). */
    incline: number;
    snapped: boolean;
}
export function snapIncline(
    chordAngle: number,
    tangent: number,
    radiusPx: number,
    snapPx = SNAP_PX,
): InclineSnap {
    const incline = inclineOf(chordAngle, tangent);
    if (radiusPx <= 0) return { angle: chordAngle, incline, snapped: false };
    // the nearest raster multiple, or the continuation landmark (keeps the previous exit incline).
    const candidates = [rasterIncline(incline), tangent];
    let best = incline;
    let bestD = Number.POSITIVE_INFINITY;
    for (const c of candidates) {
        const d = Math.abs(c - incline);
        if (d < bestD) {
            bestD = d;
            best = c;
        }
    }
    if (bestD > (2 * snapPx) / radiusPx) return { angle: chordAngle, incline, snapped: false };
    return { angle: chordForIncline(best, tangent), incline: best, snapped: true };
}
