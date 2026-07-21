/** the polar magnet: a pure, device-free resolver for a viewport node drag. it snaps the
 *  raw drag point (screen px) against target *families*, all relative to the **previous
 *  node**: the exit-tangent **incline** raster (15°, tip drags only), the chord-length raster
 *  (1 m), and the continuation incline landmark. every target is one line in screen space
 *  (its locus); the nearest within `SNAP_PX` wins, and a second, sufficiently-orthogonal
 *  target can co-fire (their intersection). one resolver, every family competing in the same
 *  screen-px pool — the AE magnet model (`editor-ui.md`) extended with the shaping viewport's
 *  rasters (the earned exception to the no-rasters clause: the PC2 building vocabulary IS this
 *  surface's semantic quantum). the world-absolute cartesian neighbor-alignment families are
 *  gone (feel round 3): they fought the incline snapping and don't generalize to 3D; the
 *  polar frame relative to the previous node is the whole surface.
 *
 *  works entirely in screen px so the pull is a fixed on-screen distance at any zoom (the
 *  `SNAP_PX` precedent); the caller projects world→screen at the boundary and inverts the
 *  fired guides back. no shallot, no DOM — directly `bun test`-able. */

import { SNAP_PX } from "./timeline";

/** the shaping viewport's angular quantum: the tip's exit-tangent incline snaps to 15°
 *  multiples (PC2 quantizes what the piece *does* — its exit incline — not the raw chord). a
 *  design constant (the `SNAP_PX` precedent), tuned only at the feel check — never a per-user
 *  setting. */
export const ANGLE_STEP = Math.PI / 12;

/** the chord-length quantum: integer meters (1 m). the PC2 integer-meter building idiom. */
export const LENGTH_STEP = 1;

// the exit-incline convention (one home for both the 1D resolvers and the legacy `resolveSnap`
// pool). PC2 quantizes the tip's EXIT-TANGENT incline, not the raw chord: the tip's reflected
// exit incline is `2·chord − tangent`, so the chord that yields a given exit incline is
// `(incline + tangent)/2`. these three are the only snap MATH the incline family carries — the
// resolvers snap-nearest, the pool enumerates flanking targets, both over the same primitives.

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
 *  incline `tangent` (screen radians) and the tip radius `radiusPx` (screen px, which sets the
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

/** two fired targets co-fire only when their loci are at least this far from parallel —
 *  `|cos θ| ≤ SQRT1_2`, i.e. ≥45° apart. orthogonal families (the incline ray ⟂ the radial
 *  length locus) combine; two near-parallel targets constrain the same freedom, so
 *  the nearer alone fires (never a distant, ill-conditioned intersection). */
const COMBINE_DOT = Math.SQRT1_2;

const EPS = 1e-9;

/** the kind of a fired guide — the caller renders each in the shared guide language. */
export type GuideKind = "angle" | "length";

/** a fired guide, screen-space. `value` reads by kind: angle = the screen-radians of the
 *  snapped **exit-tangent incline** (the caller draws a tangent ray at the dragged node + a °
 *  label); length = the screen-px radius from the previous node (a metre label). */
export interface Guide {
    kind: GuideKind;
    value: number;
}

/** the shift axis-lock: `x` pins screen x (the point moves vertically), `y` pins screen y
 *  (moves horizontally), null is a free 2-DOF drag. */
export type Lock = "x" | "y" | null;

export interface SnapInput {
    /** the raw (unsnapped, shift-lock already applied) drag point, screen px. */
    px: number;
    py: number;
    /** the previous node — the polar origin — screen px, or null when there is none. */
    prev: { x: number; y: number } | null;
    /** the previous node's exit-tangent incline (screen radians) — enables the tip incline
     *  family (raster + continuation). null for an interior drag: a frozen interior heading has
     *  no incline to snap, so only the length family fires there. */
    tangent: number | null;
    /** screen px per world meter (the length raster's scale). */
    pxPerMeter: number;
    lock: Lock;
    /** pull distance, default `SNAP_PX`. */
    threshold?: number;
}

export interface SnapResult {
    /** the snapped point, screen px (unchanged from the input when nothing latched). */
    px: number;
    py: number;
    /** the fired guides (0..2), each flashed by the caller. */
    guides: Guide[];
}

/** one candidate: a line `(o, d)` in screen px (a point on it + a unit direction along it)
 *  and the guide it flashes when it wins. */
interface Candidate {
    ox: number;
    oy: number;
    dx: number;
    dy: number;
    guide: Guide;
}

/** enumerate every family's candidate lines for this drag. */
function candidates(inp: SnapInput): Candidate[] {
    const out: Candidate[] = [];

    const prev = inp.prev;
    if (!prev) return out;
    const rx = inp.px - prev.x;
    const ry = inp.py - prev.y;
    const r = Math.hypot(rx, ry);
    if (r < EPS) return out; // the drag sits on the previous node — no polar frame
    const ux = rx / r;
    const uy = ry / r;
    const rawAngle = Math.atan2(ry, rx);

    // incline family (tip drags only — `tangent` is the previous node's exit incline, null for
    // an interior drag). PC2 quantizes the tip's EXIT-TANGENT incline, not the raw chord: the
    // tip's reflected exit incline is `2·chord − tangent`, so snapping the incline to the 15°
    // raster means the chord targets `(raster + tangent)/2`. each target is still a ray through
    // the previous node (the Candidate shape holds); the guide it flashes carries the INCLINE
    // (the caller draws a tangent ray at the dragged node + a ° label). the continuation landmark
    // keeps the previous segment's exit incline (incline = tangent → chord = tangent), a real
    // incline landmark, not a raster duplicate. only a FORWARD ray is a target, so the magnet
    // never flips the node across the previous node.
    if (inp.tangent !== null) {
        const base = rasterIncline(inclineOf(rawAngle, inp.tangent));
        const inclines = [base, base + ANGLE_STEP, base - ANGLE_STEP, inp.tangent];
        for (const incline of inclines) {
            const c = chordForIncline(incline, inp.tangent); // the chord that yields this exit incline
            const dx = Math.cos(c);
            const dy = Math.sin(c);
            if (dx * ux + dy * uy <= 0) continue; // backward ray — unreachable this drag
            out.push({ ox: prev.x, oy: prev.y, dx, dy, guide: { kind: "angle", value: incline } });
        }
    }

    // length family: the integer-meter radii flanking the raw radius (≥1 m — a 0 m target is
    // the previous node itself, a degenerate coincident node). the locus is the circle around
    // the previous node, taken as its tangent line at the current angle (the local
    // linearization; sub-pixel across the pull).
    if (inp.pxPerMeter > 0) {
        const meters = r / inp.pxPerMeter;
        for (const m of [Math.floor(meters), Math.ceil(meters)]) {
            if (m < 1) continue;
            const radius = m * inp.pxPerMeter;
            out.push({
                ox: prev.x + ux * radius,
                oy: prev.y + uy * radius,
                dx: -uy,
                dy: ux,
                guide: { kind: "length", value: radius },
            });
        }
    }

    return out;
}

/** perpendicular px distance from `(px, py)` to a candidate line. */
function perp(c: Candidate, px: number, py: number): number {
    return Math.abs((px - c.ox) * c.dy - (py - c.oy) * c.dx);
}

/** the foot of the perpendicular from `(px, py)` onto a candidate line. */
function project(c: Candidate, px: number, py: number): { x: number; y: number } {
    const t = (px - c.ox) * c.dx + (py - c.oy) * c.dy;
    return { x: c.ox + t * c.dx, y: c.oy + t * c.dy };
}

/** intersection of two candidate lines, or null when (near-)parallel. */
function intersect(a: Candidate, b: Candidate): { x: number; y: number } | null {
    const denom = a.dx * b.dy - a.dy * b.dx;
    if (Math.abs(denom) < EPS) return null;
    const t = ((b.ox - a.ox) * b.dy - (b.oy - a.oy) * b.dx) / denom;
    return { x: a.ox + t * a.dx, y: a.oy + t * a.dy };
}

/** resolve the drag against every family. nearest-perpendicular within `threshold` is the
 *  primary; the nearest sufficiently-orthogonal target co-fires as the secondary (their
 *  intersection). shift-locked, the drag is 1-DOF (moves along the free screen axis): only a
 *  target reachable along that axis fires — a locus parallel to the movement is an
 *  incompatible family, skipped (the constraint owns the locked axis). */
export function resolveSnap(inp: SnapInput): SnapResult {
    const thr = inp.threshold ?? SNAP_PX;
    const cands = candidates(inp);

    if (inp.lock) {
        // the movement axis: x-lock pins x → move vertically; y-lock pins y → move horizontally.
        const mdx = inp.lock === "x" ? 0 : 1;
        const mdy = inp.lock === "x" ? 1 : 0;
        let best: Candidate | null = null;
        let bestMove = 0;
        let bestAbs = thr;
        for (const c of cands) {
            const denom = mdx * c.dy - mdy * c.dx;
            if (Math.abs(denom) < EPS) continue; // parallel to the movement axis — unreachable
            const t = ((c.ox - inp.px) * c.dy - (c.oy - inp.py) * c.dx) / denom;
            if (Math.abs(t) <= bestAbs) {
                bestAbs = Math.abs(t);
                bestMove = t;
                best = c;
            }
        }
        if (!best) return { px: inp.px, py: inp.py, guides: [] };
        return { px: inp.px + bestMove * mdx, py: inp.py + bestMove * mdy, guides: [best.guide] };
    }

    const inRange = cands
        .map((c) => ({ c, d: perp(c, inp.px, inp.py) }))
        .filter((e) => e.d <= thr)
        .sort((a, b) => a.d - b.d);
    if (inRange.length === 0) return { px: inp.px, py: inp.py, guides: [] };

    const primary = inRange[0].c;
    let secondary: Candidate | null = null;
    for (let i = 1; i < inRange.length; i++) {
        const c = inRange[i].c;
        if (Math.abs(primary.dx * c.dx + primary.dy * c.dy) <= COMBINE_DOT) {
            secondary = c;
            break;
        }
    }
    if (secondary) {
        const hit = intersect(primary, secondary);
        if (hit) return { px: hit.x, py: hit.y, guides: [primary.guide, secondary.guide] };
    }
    const p = project(primary, inp.px, inp.py);
    return { px: p.x, py: p.y, guides: [primary.guide] };
}
