/** the polar manipulator: a pure, device-free geometry for the two 1D node controls (the Planet
 *  Coaster piece controls, extending to turn/roll in 3D). a selected node moves not by a free 2D
 *  drag but along two separate axes in the polar frame around its **previous node**:
 *
 *  - **length** — the chord `previous → selected`, snapped to whole metres (min 1 m);
 *  - **angle** — the circle through the selected node centered on the previous node; snapped to the
 *    5° grid uniformly — at a growth tip the displayed and snapped value is the exit incline, at an
 *    interior node the chord angle itself (feel round 6: a plain grid, no incline quantum, so no
 *    "interior rotates free" asymmetry).
 *
 *  each axis has a **locus** (the chord ray, the tangential arc) the drag rides, and a screen→value
 *  **inverse** (`screenToLength`/`screenToAngle`) with an exact forward (`lengthToPoint`/
 *  `angleToPoint`), so a value round-trips through its locus. the snap grids run through `magnet.ts`
 *  (one home for the increment constants). the module takes **screen px** in (the caller projects
 *  world→screen at the boundary) and works device-free — directly `bun test`-able; no shallot, no DOM.
 *
 *  **the semantic values are world-space.** `screenToLength` already returns world metres; the
 *  angle inverse and `angleControl` emit **world** radians (the screen y-flip seam lives inside the
 *  module — `angleToPoint`/`screenToAngle` fold it once), so the exit incline matches the sign
 *  `nodeMetrics` reads off world samples. one convention across the resting readout, the drag
 *  readout, and the 3D pitch/turn/roll port — no per-consumer negation. only the *geometry* the
 *  loci carry (the chord ray's screen direction, the arc's screen centre/radius) stays screen px:
 *  it's the drag's own space, and a caller that draws a locus wants it there. */

import { chordForIncline, inclineOf, type LengthSnap, snapAngle, snapLength } from "./magnet";

const EPS = 1e-9;

/** the polar manipulation frame around a node. the geometry (`px`/`py`/`ux`/`uy`/`radius`) is
 *  screen px — the length axis runs along the unit chord `(ux, uy)` from the previous node, the
 *  angle axis along the circle of `radius` centred on it. `tangent` is the previous exit incline in
 *  **world** radians (the same convention `angleControl` emits) for a growth tip, null for an
 *  interior node (which snaps its chord angle, not an incline). `degenerate` marks a coincident
 *  previous/selected node — no chord direction, zero radius — where the direction falls back to `+x`
 *  and the loci collapse to the origin; the inverses stay finite but the round-trip only holds for a
 *  non-degenerate frame.
 *
 *  **the frame is a per-pointermove snapshot, not a gesture-start freeze.** its `radius` is the
 *  live chord radius that `angleToPoint` holds constant through an angle drag, so the caller rebuilds
 *  the frame each move against the live selected-node position — the node stays on its own arc as the
 *  angle changes. */
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
 *  pointermove (see `Frame`): the angle drag holds the live chord radius. */
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

/** the length control: resolve a raw screen point to a chord length in world metres. snap-by-default
 *  quantizes to whole metres (min 1); the Ctrl modifier (`snap === false`) bypasses to continuous
 *  (still ≥ 1). the length family is universal — tip + interior. */
export function lengthControl(f: Frame, px: number, py: number, snap: boolean): LengthSnap {
    return snapLength(screenToLength(f, px, py), snap);
}

/** the angle control: resolve a raw screen point to a chord angle (+ the tip's exit incline), both
 *  in **world** radians. snap-by-default quantizes to the 5° grid (`snapAngle`), applied uniformly —
 *  at a growth tip (`tangent` set) it snaps the **exit incline** to the grid and maps back to the
 *  chord that yields it (`incline` is that value); at an interior node (`tangent` null) it snaps the
 *  **chord angle** to the grid (`incline` null — a frozen heading has no incline to display). the
 *  Ctrl modifier (`snap === false`) bypasses to continuous. a plain grid needs no radius-derived
 *  window, so the old "interior rotates free" asymmetry is gone (feel round 6). */
export interface AngleControl {
    /** the resolved chord angle in WORLD radians — the chord that yields the snapped incline (tip)
     *  or the snapped chord itself (interior). */
    angle: number;
    /** the tip's exit incline in WORLD radians (snapped to the grid), or null for an interior node. */
    incline: number | null;
    snapped: boolean;
}
export function angleControl(f: Frame, px: number, py: number, snap: boolean): AngleControl {
    const chord = screenToAngle(f, px, py);
    if (f.tangent === null) {
        // interior: no incline — snap the chord angle itself to the grid.
        return { angle: snap ? snapAngle(chord) : chord, incline: null, snapped: snap };
    }
    // tip: snap the EXIT INCLINE to the grid, then map back to the chord that produces it.
    const incline = snap ? snapAngle(inclineOf(chord, f.tangent)) : inclineOf(chord, f.tangent);
    return { angle: chordForIncline(incline, f.tangent), incline, snapped: snap };
}

// ── per-node polar delta (the multiselect group move) ───────────────────────────────
// a multi-node move applies ONE shared Δlength / Δangle to every selected node, each in its own
// polar frame around its previous node (Blender's Individual Origins). the transform runs in the
// SECTION-LOCAL frame (nodes are stored section-local, and a fixed entry rotation commutes with a
// rotation delta, so a world-frame Δθ IS a local-frame Δθ — no world/bake round-trip needed, so the
// group stays coherent mid-gesture without a re-bake). the chord VECTOR transform reads START
// positions (order-independent); the ANCHOR reads the running (possibly already-moved) previous
// node, walked ascending, so a selected RUN carries rigidly (the per-move-snapshot live-frame
// rebuild, `manipulator.ts` — a consecutive selected pair anchors the later on the moved earlier).

/** one node of a section's chain in section-local coordinates: its stable `order` (0 = the entry
 *  anchor) and local position. */
export interface ChainNode {
    order: number;
    x: number;
    y: number;
}

/** apply a shared polar delta to a set of selected nodes within one section's chain, in the chain's
 *  own section-local frame. `nodes` is the section's full order-set (0 = entry anchor, never
 *  selected); `selected` the orders to move. the same Δ transforms EACH selected node's chord to its
 *  previous node — `"length"` adds `delta` metres (floored at `minChord`), `"angle"` rotates the
 *  chord by `delta` radians CCW — anchored on the running previous node (start when unselected, else
 *  its already-computed target), walked ascending so a selected run carries rigidly. returns the new
 *  local position per selected order. pure — the size-1 case degenerates to a single node's own
 *  chord transform (today's polar move). */
export function polarDelta(
    nodes: readonly ChainNode[],
    selected: ReadonlySet<number>,
    axis: "length" | "angle",
    delta: number,
    minChord: number,
): Map<number, { x: number; y: number }> {
    const start = new Map<number, { x: number; y: number }>();
    const cur = new Map<number, { x: number; y: number }>();
    for (const n of nodes) {
        start.set(n.order, { x: n.x, y: n.y });
        cur.set(n.order, { x: n.x, y: n.y });
    }
    const out = new Map<number, { x: number; y: number }>();
    const orders = [...selected].sort((a, b) => a - b);
    for (const k of orders) {
        const ps = start.get(k - 1); // start previous (the chord vector reference)
        const ns = start.get(k); // start node
        const pc = cur.get(k - 1); // running previous (the anchor — may have moved this pass)
        if (!ps || !ns || !pc) continue; // a selected node always has a previous (order ≥ 1)
        let vx = ns.x - ps.x;
        let vy = ns.y - ps.y;
        if (axis === "length") {
            const r = Math.hypot(vx, vy);
            const nr = Math.max(minChord, r + delta);
            if (r > EPS) {
                vx = (vx / r) * nr;
                vy = (vy / r) * nr;
            } else {
                vx = nr; // degenerate chord (shouldn't occur — minChord ≥ 1): fall back to +x
                vy = 0;
            }
        } else {
            const c = Math.cos(delta);
            const s = Math.sin(delta);
            const rx = vx * c - vy * s;
            const ry = vx * s + vy * c;
            vx = rx;
            vy = ry;
        }
        const np = { x: pc.x + vx, y: pc.y + vy };
        cur.set(k, np);
        out.set(k, np);
    }
    return out;
}
