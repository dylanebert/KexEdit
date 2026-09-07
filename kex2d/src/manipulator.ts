/** the polar manipulator: a pure, device-free geometry for the two 1D node controls (the Planet
 *  Coaster piece controls, extending to turn/roll in 3D). a selected node moves not by a free 2D
 *  drag but along two separate axes in the polar frame around its **previous node**:
 *
 *  - **length** — the chord `previous → selected`, snapped to the length grid (default whole
 *    metres, min 1 m);
 *  - **angle** — the circle through the selected node centered on the previous node; snapped to the
 *    angle grid uniformly (default 5°) — at a growth tip the displayed and snapped value is the exit incline, at an
 *    interior node the chord angle itself (feel round 6: a plain grid, no incline quantum, so no
 *    "interior rotates free" asymmetry).
 *
 *  each axis has a **locus** (the chord ray, the tangential arc) the drag rides, and a screen→value
 *  **inverse** (`screenToLength`/`screenToAngle`) with an exact forward (`lengthToPoint`/
 *  `angleToPoint`), so a value round-trips through its locus. the snap grids run through `magnet.ts`,
 *  which reads its two increments live from `settings.ts` (per-user, configurable off the tool
 *  rail's magnet) — this module never sees them. it takes **screen px** in (the caller projects
 *  world→screen at the boundary) and works device-free — directly `bun test`-able; no shallot, no DOM.
 *
 *  **the semantic values are world-space.** `screenToLength` already returns world metres; the
 *  angle inverse and `angleControl` emit **world** radians (the screen y-flip seam lives inside the
 *  module — `angleToPoint`/`screenToAngle` fold it once), so the exit incline matches the sign
 *  `nodeMetrics` reads off world samples. one convention across the resting readout, the drag
 *  readout, and the 3D pitch/turn/roll port — no per-consumer negation. only the *geometry* the
 *  loci carry (the chord ray's screen direction, the arc's screen centre/radius) stays screen px:
 *  it's the drag's own space, and a caller that draws a locus wants it there. */

import {
    chordForIncline,
    inclineOf,
    type LengthSnap,
    snapAngle,
    snapGrid,
    snapLength,
} from "./magnet";

const EPS = 1e-9;

/** the polar manipulation frame around a node — the LIVE app builds this only for a growth tip
 *  (`nodeFrame`, `controls.ts`); an interior node uses `chordFrame` below instead (stage 2 of
 *  kex2d-node-move-ux retired the polar frame's interior role — see the module note ahead of
 *  `chordFrame`). the geometry (`px`/`py`/`ux`/`uy`/`radius`) is
 *  screen px — the length axis runs along the unit chord `(ux, uy)` from the previous node, the
 *  angle axis along the circle of `radius` centred on it. `tangent` is the previous exit incline in
 *  **world** radians (the same convention `angleControl` emits) for a growth tip; `tangent: null` is
 *  the module's own generality (a frame with no incline to snap), kept because the pure math still
 *  supports it and it's exercised directly by unit tests, but no live caller constructs one any
 *  more. `degenerate` marks a coincident
 *  previous/selected node — no chord direction, zero radius — where the direction falls back to `+x`
 *  and the loci collapse to the origin; the inverses stay finite but the round-trip only holds for a
 *  non-degenerate frame.
 *
 *  **a single-node drag rebuilds the frame per pointermove, not once at gesture start.** its
 *  `radius` is the live chord radius that `angleToPoint` holds constant through an angle drag, so the
 *  caller rebuilds the frame each move against the live selected-node position — the node stays on
 *  its own arc as the angle changes. the group move (`polarDelta` below) is the deliberate exception:
 *  it derives a cumulative delta, which needs a fixed zero, so its caller freezes one frame at
 *  gesture start. */
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
    /** the previous exit incline in WORLD radians at a growth tip; null only in the module's own
     *  generality (no live caller passes it — see the doc above). */
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
 *  quantizes to the length grid (default whole metres, min 1); the Ctrl modifier (`snap === false`)
 *  bypasses to continuous (still ≥ 1). the length family is universal — tip + interior. */
export function lengthControl(f: Frame, px: number, py: number, snap: boolean): LengthSnap {
    return snapLength(screenToLength(f, px, py), snap);
}

/** the angle control: resolve a raw screen point to a chord angle (+ the tip's exit incline), both
 *  in **world** radians — the tip's own control (`f.tangent` set; the live app never builds a
 *  null-tangent `Frame`, see `Frame`'s doc). snap-by-default quantizes to the angle grid
 *  (`snapAngle`, default 5°): it snaps the **exit incline** to the grid and maps back to the
 *  chord that yields it (`incline` is that value). the Ctrl modifier (`snap === false`) bypasses
 *  to continuous. the `f.tangent === null` branch is the module's own generality (no incline to
 *  snap, so it snaps the bare chord angle instead) — dead from the live app, kept for the pure
 *  math's own completeness and exercised directly by unit tests. */
export interface AngleControl {
    /** the resolved chord angle in WORLD radians — the chord that yields the snapped incline (tip)
     *  or the snapped chord itself (the null-tangent generality). */
    angle: number;
    /** the tip's exit incline in WORLD radians (snapped to the grid), or null under the
     *  null-tangent generality. */
    incline: number | null;
    snapped: boolean;
}
export function angleControl(f: Frame, px: number, py: number, snap: boolean): AngleControl {
    const chord = screenToAngle(f, px, py);
    if (f.tangent === null) {
        // the null-tangent generality (unreachable from the live app): no incline — snap the bare
        // chord angle itself to the grid.
        return { angle: snap ? snapAngle(chord) : chord, incline: null, snapped: snap };
    }
    // tip: snap the EXIT INCLINE to the grid, then map back to the chord that produces it.
    const incline = snap ? snapAngle(inclineOf(chord, f.tangent)) : inclineOf(chord, f.tangent);
    return { angle: chordForIncline(incline, f.tangent), incline, snapped: snap };
}

// ── the neighbor-chord frame (interior nodes) ────────────────────────────────────────
// stage 2 of kex2d-node-move-ux: an INTERIOR node (both neighbors exist and stay frozen) trades
// the polar frame for two constrained 1D axes anchored on the frozen `prev`→`next` chord instead
// of orbiting the dragged node itself — `polarFrame` doesn't fit here (no previous exit incline to
// snap, and a group of one polar frame per interior node would let a drag perturb its own anchor).
// `slide` (∥, along the chord) replaces the length knob; `offset` (⊥, off the chord) replaces the
// angle knob — same two-knob vocabulary, new loci. Both snap to the SAME 1 m grid (`snapGrid`, no
// floor — an interior axis is a genuine signed coordinate, unlike a chord); there is no angle grid
// on an interior node any more (the law `magnet.ts`/`editor-ui.md` documents as retired by this
// stage).
//
// `v` is `u` rotated a FIXED +90°, never sign-picked toward the dragged node. A per-rebuild
// sign-pick (tried first, reverted by the stage-2 adversarial pass) makes the reported offset jump
// discontinuously the instant a drag crosses the chord: at offset +1.2 m the frame's `v` points one
// way; drag to the other side and the NEXT rebuild (this frame is rebuilt every pointermove, `sel`
// being the only thing that moves) re-picks `v` toward the node's new side and the SAME physical
// motion reads as a sign flip on top of the real delta — the write stays continuous, the label
// lies. A fixed `v` has no such branch: crossing the chord is just the coordinate passing through
// zero, the same way `screenToLength` already returns negative behind the previous node's ray.
//
// A fixed rotation is only "the same side" if it's fixed in ONE handedness — and the module has
// two build spaces with OPPOSITE handedness for the identical `(-uy, ux)` formula: `nodeFrame`
// (`controls.ts`) builds from SCREEN points (y grows downward), `chordNudge` below builds from
// SECTION-LOCAL points (y grows upward, matching world/physics convention — `pxPerMeter: 1`). The
// same algebraic rotation therefore points to the physically OPPOSITE world side depending on
// which space built the frame (found by the follow-up adversarial pass, adjacent to the sign-pick
// bug above but distinct — this one survives even a perfectly fixed `v`). `screenSpace` is the
// fold: **world-space is the canonical handedness** (matching `chordNudge`'s existing local-space
// callers, unaffected), and a screen-space caller (`nodeFrame`) negates the naive rotation to
// land on the SAME world side — the same seam `polarFrame`'s `screenToAngle`/`angleToPoint` fold
// the y-flip through for its angle, just applied to a rotation instead of an atan2. Which
// physical side reads "+" was never adjudicated (sign-symmetric); what's fixed is that it agrees
// between the two build sites.

/** the neighbor-chord manipulation frame around an interior node. `u = normalized(next − prev)` is
 *  the slide axis; `v` is `u` rotated a FIXED +90° in WORLD-space handedness — NEVER sign-picked
 *  toward `sel` (see the module note above: a per-rebuild sign-pick is the discontinuous-readout
 *  bug the stage-2 adversarial pass found), and `screenSpace` folds the y-flip so a screen-built
 *  frame (`nodeFrame`, y grows downward) picks the SAME world side as a locally-built one
 *  (`chordNudge`, y grows upward) — the cross-space handedness bug the follow-up adversarial pass
 *  found. Offset is therefore a genuine signed 1D coordinate, one convention everywhere it's
 *  built — negative is legitimate, it's simply the other side. `slide0`/`offset0` are `sel`'s own
 *  coordinates in this frame at build time — the "other axis" locus each control's `*ToPoint`
 *  holds fixed while the other one is dragged, exactly the role `polarFrame.radius` plays for
 *  `angleToPoint` and `polarFrame.ux`/`uy` play for `lengthToPoint`. Rebuilt per pointermove like
 *  `polarFrame` — `sel` moves, `prev`/`next` never do (frozen neighbors), so `u`/`v` are
 *  gesture-stable and only `slide0`/`offset0` track the live position. `degenerate` marks a
 *  coincident `prev`≈`next` (no chord direction) — `u` falls back to `+x`, `v` to `+y`; the
 *  inverses stay finite but the round-trip only holds non-degenerate. */
export interface ChordFrame {
    /** the previous node — the axis origin, in the caller's own space (screen px or local metres). */
    px: number;
    py: number;
    /** the unit chord direction previous→next (the slide axis); `(1, 0)` when degenerate. */
    ux: number;
    uy: number;
    /** the unit perpendicular (the offset axis) — `u` rotated a FIXED +90° in WORLD handedness
     *  (folded per `screenSpace` at build time), never sign-picked; `(0, 1)` when degenerate. */
    vx: number;
    vy: number;
    /** `sel`'s own slide coordinate at build time (world metres) — the locus `offsetToPoint` holds
     *  fixed. */
    slide0: number;
    /** `sel`'s own offset coordinate at build time (world metres, SIGNED) — the locus
     *  `slideToPoint` holds fixed. */
    offset0: number;
    /** screen px per world metre (both axes share one scale); `1` for a frame built directly in
     *  local/world metres (`chordNudge`). */
    pxPerMeter: number;
    degenerate: boolean;
}

/** build the chord frame from the previous, next, and selected (interior) node's points.
 *  `screenSpace` folds the build space's handedness into a fixed WORLD-space `v` (see
 *  `ChordFrame`'s doc) — `true` for screen px (y grows downward, `nodeFrame`'s caller), `false`
 *  for section-local/world coordinates (y grows upward, `chordNudge`'s own build). rebuilt per
 *  pointermove (see `ChordFrame`). */
export function chordFrame(
    prev: { x: number; y: number },
    next: { x: number; y: number },
    sel: { x: number; y: number },
    pxPerMeter: number,
    screenSpace: boolean,
): ChordFrame {
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy);
    if (len < EPS) {
        return {
            px: prev.x,
            py: prev.y,
            ux: 1,
            uy: 0,
            vx: 0,
            vy: 1,
            slide0: 0,
            offset0: 0,
            pxPerMeter,
            degenerate: true,
        };
    }
    const ux = dx / len;
    const uy = dy / len;
    // the naive +90° rotation `(-uy, ux)` is CCW in a y-UP frame — the WORLD/canonical handedness
    // (chordNudge's own build space). A screen-space caller's y grows DOWNWARD, so the identical
    // formula there lands on the opposite physical side; negate to fold it back to world.
    const flip = screenSpace ? -1 : 1;
    const vx = -uy * flip;
    const vy = ux * flip;
    const base: ChordFrame = {
        px: prev.x,
        py: prev.y,
        ux,
        uy,
        vx,
        vy,
        slide0: 0,
        offset0: 0,
        pxPerMeter,
        degenerate: false,
    };
    return {
        ...base,
        slide0: screenToSlide(base, sel.x, sel.y),
        offset0: screenToOffset(base, sel.x, sel.y),
    };
}

/** screen point → slide (world metres): the signed projection onto the chord axis ÷ the scale. the
 *  exact inverse of `slideToPoint`. */
export function screenToSlide(f: ChordFrame, px: number, py: number): number {
    const along = (px - f.px) * f.ux + (py - f.py) * f.uy;
    return f.pxPerMeter > 0 ? along / f.pxPerMeter : 0;
}

/** slide (metres) → the screen point on the slide locus — the line through the frame's `offset0`,
 *  parallel to the chord. the exact inverse of `screenToSlide` (a point on the locus, its
 *  projection reads back the same slide). */
export function slideToPoint(f: ChordFrame, meters: number): { x: number; y: number } {
    const s = meters * f.pxPerMeter;
    const o = f.offset0 * f.pxPerMeter;
    return { x: f.px + f.ux * s + f.vx * o, y: f.py + f.uy * s + f.vy * o };
}

/** screen point → offset (world metres): the signed projection onto the perpendicular axis ÷ the
 *  scale. the exact inverse of `offsetToPoint`. */
export function screenToOffset(f: ChordFrame, px: number, py: number): number {
    const along = (px - f.px) * f.vx + (py - f.py) * f.vy;
    return f.pxPerMeter > 0 ? along / f.pxPerMeter : 0;
}

/** offset (metres) → the screen point on the offset locus — the line through the frame's
 *  `slide0`, parallel to the perpendicular. the exact inverse of `screenToOffset`. */
export function offsetToPoint(f: ChordFrame, meters: number): { x: number; y: number } {
    const s = f.slide0 * f.pxPerMeter;
    const o = meters * f.pxPerMeter;
    return { x: f.px + f.ux * s + f.vx * o, y: f.py + f.uy * s + f.vy * o };
}

/** the slide control: resolve a raw screen point to a slide in world metres. snap-by-default
 *  quantizes to the SAME length grid the tip's length knob uses, but through `snapGrid` — NO
 *  `LENGTH_MIN` floor (the floor is a chord-degeneracy guard, meaningless on a signed axis where 0
 *  is a legitimate station); the Ctrl modifier (`snap === false`) bypasses to continuous. */
export function slideControl(f: ChordFrame, px: number, py: number, snap: boolean): LengthSnap {
    return snapGrid(screenToSlide(f, px, py), snap);
}

/** the offset control: resolve a raw screen point to an offset in world metres. snap-by-default
 *  quantizes through `snapGrid` — a plain signed quantize, no magnitude/sign dance and no floor:
 *  an offset is a genuine signed 1D coordinate (0 = on the chord, negative = the other side), and
 *  `v`'s fixed (never sign-picked) orientation is what makes a plain signed quantize correct — see
 *  `ChordFrame`'s module note on why a sign-picked `v` would need one. Ctrl (`snap === false`)
 *  bypasses to continuous. */
export function offsetControl(f: ChordFrame, px: number, py: number, snap: boolean): LengthSnap {
    return snapGrid(screenToOffset(f, px, py), snap);
}

/** the chord arrow-nudge target (the offset/slide controls' keyboard twin, `polarNudge`'s interior
 *  analogue): step an interior node along its own chord frame by `step` world metres, `dir` = ±1.
 *  works directly in the same world-space coordinates `polarNudge` takes (section-local, not
 *  screen — `pxPerMeter` is fixed at 1 so `step` reads as metres straight through). a degenerate
 *  chord (coincident neighbors) leaves the node in place — there is no axis to nudge along. pure —
 *  unit-tested. */
export function chordNudge(
    prev: { x: number; y: number },
    next: { x: number; y: number },
    node: { x: number; y: number },
    axis: "slide" | "offset",
    dir: 1 | -1,
    step: number,
): { x: number; y: number } {
    const f = chordFrame(prev, next, node, 1, false); // local/world coords — the canonical handedness
    if (f.degenerate) return node;
    return axis === "slide"
        ? slideToPoint(f, f.slide0 + dir * step)
        : offsetToPoint(f, f.offset0 + dir * step);
}

// ── per-node polar delta (the multiselect group move) ───────────────────────────────
// a multi-node move applies ONE shared Δlength / Δangle to every selected node, each in its own
// polar frame around its previous node (Blender's Individual Origins). the transform runs in the
// SECTION-LOCAL frame (nodes are stored section-local, and a fixed entry rotation commutes with a
// rotation delta, so a world-frame Δθ IS a local-frame Δθ — no world/bake round-trip needed, so the
// group stays coherent mid-gesture without a re-bake). the chord VECTOR transform reads START
// positions (order-independent); the ANCHOR reads the running (possibly already-moved) previous
// node, walked ascending, so a selected RUN carries rigidly — a consecutive selected pair anchors
// the later on the moved earlier.

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
