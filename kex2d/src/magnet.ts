/** the polar magnet: a pure, device-free resolver for a viewport node drag. it snaps the
 *  raw drag point (screen px) against target *families* — the cartesian neighbor-alignment
 *  the drag has always had (a dragged node's screen x/y latching another node's), plus the
 *  polar families relative to the **previous node**: the chord-angle raster (15°), the
 *  chord-length raster (1 m), and the continuation / reflection angle landmarks. every
 *  target is one line in screen space (its locus); the nearest within `SNAP_PX` wins, and a
 *  second, sufficiently-orthogonal target can co-fire (their intersection). one resolver,
 *  every family competing in the same screen-px pool — the AE magnet model (`editor-ui.md`)
 *  extended with the shaping viewport's rasters (the earned exception to the no-rasters
 *  clause: the PC2 building vocabulary IS this surface's semantic quantum).
 *
 *  works entirely in screen px so the pull is a fixed on-screen distance at any zoom (the
 *  `SNAP_PX` precedent); the caller projects world→screen at the boundary and inverts the
 *  fired guides back. no shallot, no DOM — directly `bun test`-able. */

import { SNAP_PX } from "./timeline";

/** the shaping viewport's angular quantum: chord angles snap to 15° multiples relative to
 *  the previous node. a design constant (the `SNAP_PX` precedent), tuned only at the feel
 *  check — never a per-user setting. */
export const ANGLE_STEP = Math.PI / 12;

/** the chord-length quantum: integer meters (1 m). the PC2 integer-meter building idiom. */
export const LENGTH_STEP = 1;

/** two fired targets co-fire only when their loci are at least this far from parallel —
 *  `|cos θ| ≤ SQRT1_2`, i.e. ≥45° apart. orthogonal families (cartesian x⟂y, polar
 *  angle⟂length) always combine; two near-parallel targets constrain the same freedom, so
 *  the nearer alone fires (never a distant, ill-conditioned intersection). */
const COMBINE_DOT = Math.SQRT1_2;

const EPS = 1e-9;

/** the kind of a fired guide — the caller renders each in the shared guide language. */
export type GuideKind = "alignX" | "alignY" | "angle" | "length";

/** a fired guide, screen-space. `value` reads by kind: alignX = the screen x of the
 *  vertical line; alignY = the screen y of the horizontal line; angle = the screen-radians
 *  of the ray through the previous node; length = the screen-px radius of the ring around
 *  it. */
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
    /** the screen-heading of the curve tangent at the previous node (the continuation
     *  landmark), or null. */
    tangent: number | null;
    /** the screen-heading of the chord arriving at the previous node (with `tangent`, the
     *  reflection landmark `2·tangent − incoming`), or null. */
    incoming: number | null;
    /** other nodes' screen xs — the vertical-alignment targets. */
    alignX: number[];
    /** other nodes' screen ys — the horizontal-alignment targets. */
    alignY: number[];
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

    // cartesian neighbor alignment: a vertical line at each neighbor's x, a horizontal line
    // at each neighbor's y (the Figma alignment magnet).
    for (const x of inp.alignX)
        out.push({ ox: x, oy: inp.py, dx: 0, dy: 1, guide: { kind: "alignX", value: x } });
    for (const y of inp.alignY)
        out.push({ ox: inp.px, oy: y, dx: 1, dy: 0, guide: { kind: "alignY", value: y } });

    const prev = inp.prev;
    if (!prev) return out;
    const rx = inp.px - prev.x;
    const ry = inp.py - prev.y;
    const r = Math.hypot(rx, ry);
    if (r < EPS) return out; // the drag sits on the previous node — no polar frame
    const ux = rx / r;
    const uy = ry / r;
    const rawAngle = Math.atan2(ry, rx);

    // angle family: the raster multiple nearest the raw chord angle (+ its two neighbors, so
    // rounding never straddles a boundary) and the continuation / reflection landmarks. each
    // is a ray from the previous node; only a FORWARD ray (the drag's half-plane) is a
    // target, so the magnet never flips the node across the previous node.
    const base = Math.round(rawAngle / ANGLE_STEP) * ANGLE_STEP;
    const angles = [base, base + ANGLE_STEP, base - ANGLE_STEP];
    if (inp.tangent !== null) angles.push(inp.tangent); // continuation: along the tangent
    if (inp.tangent !== null && inp.incoming !== null) angles.push(2 * inp.tangent - inp.incoming); // reflection
    for (const a of angles) {
        const dx = Math.cos(a);
        const dy = Math.sin(a);
        if (dx * ux + dy * uy <= 0) continue; // backward ray — unreachable this drag
        out.push({ ox: prev.x, oy: prev.y, dx, dy, guide: { kind: "angle", value: a } });
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
