/** the polar manipulator: a pure, device-free geometry for the two 1D node controls (the Planet
 *  Coaster piece controls, extending to turn/roll in 3D). a selected node moves not by a free 2D
 *  drag but along two separate axes in the polar frame around its **previous node**:
 *
 *  - **length** — the chord `previous → selected`, snapped to whole metres;
 *  - **angle** — the circle through the selected node centered on the previous node; at a growth
 *    tip the displayed and snapped value is the exit incline (the `magnet.ts` incline family),
 *    while an interior node rotates free (a frozen heading has no incline quantum, `editor-ui.md`).
 *
 *  each axis has a **locus** (the chord ray, the tangential arc) stage 5 renders and hit-tests, and
 *  a screen→value **inverse** (`screenToLength`/`screenToAngle`) with an exact forward (`lengthTo
 *  Point`/`angleToPoint`), so a value round-trips through its locus. every family the resolver
 *  snapping runs through `magnet.ts` (one source of the raster math). the module takes **screen px**
 *  in (the caller projects world→screen at the boundary, exactly as the magnet does) and works
 *  device-free — directly `bun test`-able; no shallot, no DOM.
 *
 *  **the semantic values are world-space.** `screenToLength` already returns world metres; the
 *  angle inverse and `angleControl` emit **world** radians (the screen y-flip seam lives inside the
 *  module — `angleToPoint`/`screenToAngle` fold it once), so the exit incline matches the sign
 *  `nodeMetrics` reads off world samples. one convention across the resting readout, the drag
 *  readout, and the 3D pitch/turn/roll port — no per-consumer negation. only the *geometry* the
 *  loci carry (the chord ray's screen direction, the arc's screen centre/radius) stays screen px,
 *  because stage 5 draws it there. */

import { inclineOf, type LengthSnap, snapIncline, snapLength } from "./magnet";
import { SNAP_PX } from "./timeline";

const EPS = 1e-9;

/** the polar manipulation frame around a node. the geometry (`px`/`py`/`ux`/`uy`/`radius`) is
 *  screen px — the length axis runs along the unit chord `(ux, uy)` from the previous node, the
 *  angle axis along the circle of `radius` centred on it. `tangent` is the previous exit incline in
 *  **world** radians (the same convention `angleControl` emits) for a growth tip, null for an
 *  interior node (whose angle control rotates free). `degenerate` marks a coincident previous/
 *  selected node — no chord direction, zero radius — where the direction falls back to `+x` and the
 *  loci collapse to the origin; the inverses stay finite but the round-trip only holds for a
 *  non-degenerate frame.
 *
 *  **the frame is a per-pointermove snapshot, not a gesture-start freeze.** its `radius` is the
 *  live chord radius, and the incline snap window derives from it (`snapIncline` at `f.radius`), so
 *  the caller must rebuild the frame each move against the live selected-node position (or hold the
 *  pointer arc-constrained at `f.radius`). freezing the frame at grab would pin the snap window to
 *  the start radius and diverge from the legacy magnet feel, whose window tracked the live drag
 *  radius. */
export interface Frame {
    /** the previous node — the polar origin, screen px. */
    px: number;
    py: number;
    /** the unit chord direction previous→selected (the length axis); `(1, 0)` when degenerate. */
    ux: number;
    uy: number;
    /** the reference chord radius `|selected − previous|` (screen px); 0 when degenerate. */
    radius: number;
    /** screen px per world metre (the length axis' scale). */
    pxPerMeter: number;
    /** the previous exit incline in WORLD radians at a growth tip, else null (interior, free). */
    tangent: number | null;
    degenerate: boolean;
}

/** build the polar frame from the previous and selected node's screen points. rebuilt per
 *  pointermove (see `Frame`): the snap window rides the live chord radius. */
export function polarFrame(
    prev: { x: number; y: number },
    sel: { x: number; y: number },
    pxPerMeter: number,
    tangent: number | null,
): Frame {
    const rx = sel.x - prev.x;
    const ry = sel.y - prev.y;
    const radius = Math.hypot(rx, ry);
    if (radius < EPS) {
        return {
            px: prev.x,
            py: prev.y,
            ux: 1,
            uy: 0,
            radius: 0,
            pxPerMeter,
            tangent,
            degenerate: true,
        };
    }
    return {
        px: prev.x,
        py: prev.y,
        ux: rx / radius,
        uy: ry / radius,
        radius,
        pxPerMeter,
        tangent,
        degenerate: false,
    };
}

/** the chord ray locus (origin + unit direction, screen px) — the length control's track, the ray
 *  from the previous node through the selected node. */
export interface Ray {
    x: number;
    y: number;
    dx: number;
    dy: number;
}
export function chordRay(f: Frame): Ray {
    return { x: f.px, y: f.py, dx: f.ux, dy: f.uy };
}

/** the tangential arc locus (center + radius, screen px) — the angle control's track, the circle
 *  through the selected node centered on the previous node. */
export interface Arc {
    cx: number;
    cy: number;
    r: number;
}
export function tangentArc(f: Frame): Arc {
    return { cx: f.px, cy: f.py, r: f.radius };
}

/** screen point → chord length (world metres): the signed projection onto the chord ray ÷ the
 *  scale. a point behind the origin yields a negative length; the caller floors it at the minimum
 *  chord. the exact inverse of `lengthToPoint`. */
export function screenToLength(f: Frame, px: number, py: number): number {
    const along = (px - f.px) * f.ux + (py - f.py) * f.uy;
    return f.pxPerMeter > 0 ? along / f.pxPerMeter : 0;
}

/** chord length (metres) → the screen point on the chord ray. the exact inverse of
 *  `screenToLength` (a point on the ray, its projection reads back the same length). */
export function lengthToPoint(f: Frame, meters: number): { x: number; y: number } {
    const r = meters * f.pxPerMeter;
    return { x: f.px + f.ux * r, y: f.py + f.uy * r };
}

/** screen point → chord angle in **world** radians: the direction from the previous node with the
 *  screen y-flip folded in — the raw angular DOF, before the tip's incline mapping. a point on the
 *  previous node reads 0 (degenerate). the exact inverse of `angleToPoint`. */
export function screenToAngle(f: Frame, px: number, py: number): number {
    const dx = px - f.px;
    const dy = py - f.py;
    if (Math.hypot(dx, dy) < EPS) return 0;
    return Math.atan2(-dy, dx); // world radians: screen y is down, world up
}

/** chord angle in **world** radians → the screen point on the reference-radius arc. the exact
 *  inverse of `screenToAngle` (the y-flip folded back in, radius preserved); a degenerate
 *  (zero-radius) frame returns the origin. */
export function angleToPoint(f: Frame, angle: number): { x: number; y: number } {
    return { x: f.px + Math.cos(angle) * f.radius, y: f.py - Math.sin(angle) * f.radius };
}

/** the length control: resolve a raw screen point to a chord length in world metres, whole-metre-
 *  snapped through `magnet.snapLength` when `snap` is on (the length family is universal — tip +
 *  interior). */
export function lengthControl(
    f: Frame,
    px: number,
    py: number,
    snap: boolean,
    snapPx = SNAP_PX,
): LengthSnap {
    const meters = screenToLength(f, px, py);
    if (!snap) return { meters, snapped: false };
    return snapLength(meters, f.pxPerMeter, snapPx);
}

/** the angle control: resolve a raw screen point to a chord angle (+ the tip's exit incline), both
 *  in **world** radians. at a growth tip (`tangent` set) the exit incline snaps to the 15° raster /
 *  continuation landmark through `magnet.snapIncline` when `snap` is on; an interior node (`tangent`
 *  null) rotates free — the chord angle passes through, `incline` is null and it never snaps (a
 *  frozen heading has no incline quantum). the snap window derives from `f.radius`, so the caller
 *  rebuilds the frame each pointermove against the live selected-node position (`Frame`). */
export interface AngleControl {
    /** the resolved chord angle in WORLD radians — the snapped chord at a tip, else the raw. */
    angle: number;
    /** the tip's exit incline in WORLD radians, or null for an interior node. */
    incline: number | null;
    snapped: boolean;
}
export function angleControl(
    f: Frame,
    px: number,
    py: number,
    snap: boolean,
    snapPx = SNAP_PX,
): AngleControl {
    const angle = screenToAngle(f, px, py);
    if (f.tangent === null) return { angle, incline: null, snapped: false };
    if (!snap) return { angle, incline: inclineOf(angle, f.tangent), snapped: false };
    const res = snapIncline(angle, f.tangent, f.radius, snapPx);
    return { angle: res.angle, incline: res.incline, snapped: res.snapped };
}
