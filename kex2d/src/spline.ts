/** the position generator: a cubic Hermite curve through every node, pure and
 *  framework-free (mirrors `forward.ts` / `bake.ts`) so it's directly testable
 *  under `bun test`; only the ECS layer (`track.ts`) imports the shallot barrel.
 *
 *  each node carries a free position *and* a stored heading θ (`Node.theta`).
 *  the heading is authored by `reflect` (the circular-arc exit tangent) when a
 *  node is appended, and refreshed by `track.ts reheadOnDrag`. the *last*
 *  (heading) node tracks its predecessor — it re-derives whenever it or the node
 *  before it is dragged, so its angle never goes stale; the first node is a
 *  fixed flat anchor and interior nodes keep their heading frozen. the only
 *  heading a drag recomputes is the last node's, and it has no successor, so the
 *  edit stays local: moving a node touches *only* the two segments that share
 *  it, nothing before the previous node or after the next. a freshly placed last
 *  node's two flanking headings are a reflection pair, so its segment is a single
 *  circular arc (one bend, never an S); a dragged interior node's frozen heading
 *  can pull its segments off the arc — the accepted misshaping, since the
 *  contract can't hold on both sides at once.
 *
 *  a node may instead carry an *explicit* tangent (`Node.tangent`, the summoned
 *  inner layer): its in/out tangent vectors are stored absolute in the node's
 *  local frame (the Figma/Blender bezier convention — a handle holds its length
 *  under an anchor drag, unlike the live-chord-proportional `Auto` arc). `Mirror`
 *  keeps the two collinear and equal length (one handle mirrored); `Aligned` keeps
 *  them collinear with per-side length; `Free` lets them diverge, so a corner (C0
 *  kink) becomes expressible. `handle()` is the only seam
 *  where a heading becomes a tangent, so `Auto` (no `tangent`) stays byte-identical
 *  to the arc rule while explicit nodes substitute their stored vector there.
 *
 *  the sampled positions feed the kinematic recovery (`bake.ts`) → canonical
 *  F_n; the curve is only F_n's input, so this module stays geometry-only (no
 *  physics). a Hermite cubic's curvature varies within a span, so the recovered
 *  F_n is smoothly varying. */

const EPS = 1e-9;

/**
 * upper bound on the per-edge turning angle. without it a short, tight bend
 * (small arc length, large total turning) would get too few edges and the F_n
 * timeline would read near-flat across real curvature. the sampler floors a
 * segment's edge count at `⌈turning / (2·MAX_U_PER_EDGE)⌉`. π/24 → ≥12 edges
 * per half-turn.
 */
export const MAX_U_PER_EDGE = Math.PI / 24;

/** rough fine-sampling resolution for the per-segment arc-length + turning
 *  estimate that picks the edge count. positions themselves are exact cubic
 *  evals, so this only affects how many edges a segment gets, not accuracy. */
const FINE = 32;

/** tangent-length saturation. `k = sec²(φ/2)` (below) reproduces a circular arc
 *  exactly at creation and stays ≈1 for gentle bends, but diverges as the
 *  stored heading approaches antiparallel to its chord (φ → π, a U-turn a drag
 *  can force). capping at 4 (a 120° single-segment turn) keeps the magnitude
 *  bounded there; the segment is the accepted misshaping, not a blow-up. */
const K_MAX = 4;

/** a node's tangent authoring mode (Figma's mirroring taxonomy). `Auto` (the default,
 *  represented by an absent `Node.tangent`) derives both tangents from the stored heading
 *  via the arc rule; `Mirror`, `Aligned`, and `Free` supply explicit stored vectors,
 *  honored verbatim in `handle()`. `Mirror` keeps the in/out vectors collinear AND equal
 *  length (one authored handle, mirrored through the node); `Aligned` keeps them collinear
 *  with per-side length (one direction, two lengths); `Free` allows a C0 corner. the
 *  substrate reads the vectors the same way for all three — the mode is authoring metadata
 *  (which handle drag rotates/mirrors the other) that rides through storage and undo. */
export enum TangentMode {
    Aligned = 1,
    Free = 2,
    Mirror = 3,
}

/** an explicit tangent on a node: the in/out tangent vectors (segment-space,
 *  forward-pointing along the curve — the same space `handle()` returns) stored
 *  absolute in the node's local frame. present only when the node is not `Auto`. */
export interface Tangent {
    mode: TangentMode;
    /** incoming tangent (the arriving segment's `s=1` velocity). */
    inX: number;
    inY: number;
    /** outgoing tangent (the departing segment's `s=0` velocity). */
    outX: number;
    outY: number;
}

export type Node = { x: number; y: number; theta: number; tangent?: Tangent };

type Pt = { x: number; y: number };

export type ChainResult = {
    /** every segment baked and landed on its node (no degenerate/truncated). */
    valid: boolean;
    /** total edge count; the last written sample index. */
    edges: number;
    /** sample index of each baked node (`offsets[0] === 0`); length = baked
     *  node count, which is < nodes.length when a segment went degenerate or
     *  the buffer filled. */
    offsets: number[];
    /** the chain hit `maxSamples` and trailing nodes were dropped. */
    truncated: boolean;
};

/** wrap an angle delta into (−π, π]. */
function wrapPi(a: number): number {
    return ((((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
}

/**
 * circular-arc exit heading: reflect the incoming heading `prev` about the
 * `chord` to the next point. the unique circle leaving a point at heading
 * `prev` and passing through the next point exits at `2·chord − prev`. placing
 * the next point straight ahead (chord = prev) returns `prev` — a straight
 * continuation; deviating the placement by δ rotates the exit by 2δ.
 *
 * this is where the curve's *shape* is authored: `track.ts` calls it when a
 * node is appended and when the last node (or the node before it) is dragged
 * (`reheadOnDrag`), and stores the result on that one node. a forward reflection chain cascades (each exit
 * feeds the next entry), so re-deriving it for every node every bake would
 * ripple a single drag down the whole tail; storing the headings and refreshing
 * only the dragged node is what bounds an edit to two segments.
 */
export function reflect(prev: number, chord: number): number {
    return 2 * chord - prev;
}

/** segment-space tangent vector at a node: direction is the node's stored
 *  heading θ; magnitude is `k·chordLen`, where `k = sec²(φ/2)` is the cubic
 *  handle length that best-fits a circular arc whose tangent makes angle φ with
 *  the chord (the 4/3-rule generalization, exact to ~3e-4·R at a quarter turn).
 *  φ = 0 (heading along the chord) → k = 1 and a straight segment; a fresh
 *  node's reflected-pair headings give equal φ at both ends, so the segment is
 *  one circular arc. `k` saturates at `K_MAX`. */
function handle(theta: number, chordAngle: number, chordLen: number): [number, number] {
    const c = Math.cos(wrapPi(theta - chordAngle) / 2);
    const k = Math.min(1 / (c * c), K_MAX);
    return [k * chordLen * Math.cos(theta), k * chordLen * Math.sin(theta)];
}

/** the segment-start (outgoing) tangent at node `n`: its stored explicit vector
 *  when the node isn't `Auto`, else the arc-rule `handle`. an explicit vector is
 *  absolute (chord-independent), so an anchor drag leaves it fixed. */
function outVec(n: Node, chordAngle: number, chordLen: number): [number, number] {
    return n.tangent ? [n.tangent.outX, n.tangent.outY] : handle(n.theta, chordAngle, chordLen);
}

/** the segment-end (incoming) tangent at node `n` — the explicit in-vector, else
 *  the arc-rule `handle`. */
function inVec(n: Node, chordAngle: number, chordLen: number): [number, number] {
    return n.tangent ? [n.tangent.inX, n.tangent.inY] : handle(n.theta, chordAngle, chordLen);
}

/** the arc-rule tangent vector — `handle` exposed for the summon seed. an `Auto` node's
 *  in/out vector at a given chord; summoning an explicit tangent seeds each side from this,
 *  so the Auto→explicit conversion starts from exactly what the arc rule draws (visually
 *  continuous). direction is `theta`, magnitude the chord-scaled cubic handle length. */
export function autoTangent(theta: number, chordAngle: number, chordLen: number): [number, number] {
    return handle(theta, chordAngle, chordLen);
}

/** de Casteljau-subdivide the Hermite segment between adjacent nodes `pa`/`pb` at
 *  parameter `t` ∈ (0, 1) — the geo half of an exact mid-segment Cut, `profile.subdivide`'s
 *  positional twin. A cubic Hermite is a cubic bezier under the standard conversion
 *  (`P1 = pa + va/3`, `P2 = pb − vb/3`, where `va`/`vb` are `outVec(pa, …)`/`inVec(pb, …)` —
 *  the SAME per-edge tangent `sampleAt` resolves, so this reads the segment exactly as the
 *  bake would), and de Casteljau's split control points ARE that bezier's own geometry,
 *  re-parented rather than re-derived: the two resulting halves (pa→mid, mid→pb) trace
 *  exactly the original segment's curve, divided at `t`. `outA` (`pa`'s own facing tangent)
 *  and `inB` (`pb`'s) come back re-parented too — their old scale was proportioned to the
 *  FULL segment, invalid once it splits — alongside the new midpoint's `inMid`/`outMid`.
 *  Cutting at `t = 0` or `t = 1` is the caller's job to special-case (a node already sits
 *  there); this always subdivides. */
export function subdivide(
    pa: Node,
    pb: Node,
    t: number,
): {
    x: number;
    y: number;
    outA: [number, number];
    inMid: [number, number];
    outMid: [number, number];
    inB: [number, number];
} {
    const chordAngle = Math.atan2(pb.y - pa.y, pb.x - pa.x);
    const chordLen = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    const va = outVec(pa, chordAngle, chordLen);
    const vb = inVec(pb, chordAngle, chordLen);

    const p1x = pa.x + va[0] / 3;
    const p1y = pa.y + va[1] / 3;
    const p2x = pb.x - vb[0] / 3;
    const p2y = pb.y - vb[1] / 3;

    const lerp = (x0: number, x1: number) => x0 + (x1 - x0) * t;

    // the standard cubic de Casteljau split at `t`: two rounds of control-point
    // lerps (P0..P3 → Q1..Q3 → R1..R2), the third round landing on the curve point
    // itself (M) — the left curve is [P0, Q1, R1, M], the right [M, R2, Q3, P3].
    const q1x = lerp(pa.x, p1x);
    const q1y = lerp(pa.y, p1y);
    const q2x = lerp(p1x, p2x);
    const q2y = lerp(p1y, p2y);
    const q3x = lerp(p2x, pb.x);
    const q3y = lerp(p2y, pb.y);
    const r1x = lerp(q1x, q2x);
    const r1y = lerp(q1y, q2y);
    const r2x = lerp(q2x, q3x);
    const r2y = lerp(q2y, q3y);
    const mx = lerp(r1x, r2x);
    const my = lerp(r1y, r2y);

    return {
        x: mx,
        y: my,
        outA: [3 * (q1x - pa.x), 3 * (q1y - pa.y)],
        inMid: [3 * (mx - r1x), 3 * (my - r1y)],
        outMid: [3 * (r2x - mx), 3 * (r2y - my)],
        inB: [3 * (pb.x - q3x), 3 * (pb.y - q3y)],
    };
}

/** the visual offset of a tangent handle from its node, segment-local — the space the UI
 *  draws the handle knob at and a handle drag inverts through. the out-handle sits at the
 *  stored out-vector (the forward departure velocity); the in-handle sits at the *negated*
 *  in-vector — the in-vector is the forward arrival velocity, so its handle draws on the
 *  opposite side, the Figma/Blender through-the-node convention. `editTangent` is the exact
 *  inverse. */
export function handleTip(tan: Tangent, side: "in" | "out"): [number, number] {
    return side === "out" ? [tan.outX, tan.outY] : [-tan.inX, -tan.inY];
}

/** edit a tangent by dragging one handle to the segment-local visual offset `(offX, offY)`
 *  from the node (the `handleTip` space — its inverse). `Free` moves only the dragged side.
 *  `Mirror` mirrors angle AND length: both sides become the dragged forward vector. `Aligned`
 *  keeps the two collinear: the dragged side sets the shared forward direction and its own
 *  length, the other side keeps its length rotated onto that direction — dragging one handle's
 *  direction rotates both, lengths stay per-side. a degenerate drag onto the node (zero offset)
 *  is ignored for `Mirror`/`Aligned`, since it has no direction to align to. */
export function editTangent(tan: Tangent, side: "in" | "out", offX: number, offY: number): Tangent {
    // the out-handle stores the offset directly; the in-handle stores its negation (the
    // inverse of `handleTip`, so a round-trip is exact).
    const sx = side === "out" ? offX : -offX;
    const sy = side === "out" ? offY : -offY;
    if (tan.mode === TangentMode.Free) {
        return side === "out" ? { ...tan, outX: sx, outY: sy } : { ...tan, inX: sx, inY: sy };
    }
    const len = Math.hypot(sx, sy);
    if (len < EPS) return tan;
    if (tan.mode === TangentMode.Mirror) {
        // both sides equal the dragged forward vector — angle and length mirrored.
        return { mode: tan.mode, inX: sx, inY: sy, outX: sx, outY: sy };
    }
    const dx = sx / len;
    const dy = sy / len;
    // Aligned: the dragged side takes the new length; the other keeps its own, rotated onto
    // the shared direction.
    const inLen = side === "in" ? len : Math.hypot(tan.inX, tan.inY);
    const outLen = side === "out" ? len : Math.hypot(tan.outX, tan.outY);
    return {
        mode: tan.mode,
        inX: dx * inLen,
        inY: dy * inLen,
        outX: dx * outLen,
        outY: dy * outLen,
    };
}

/** collinearity tolerance shared by every direction-agnostic caller below, under TWO readings.
 *  As an angular bound (`collinearVec`, below): relative to the vector magnitudes, f32 handle
 *  storage (`Handle.tin`/`tout`, `Force.tin`/`tout` alike; 2^-24 unit roundoff) perturbs a
 *  genuinely collinear pair's angle by ≤ ~2·2^-24 ≈ 1.2e-7. As a relative DISTANCE bound
 *  (`track.vecEqual`, `Mirror`'s equal-vector constraint): the same f32 storage perturbs a
 *  genuinely equal pair's component-wise gap by ≤ ~√2·2^-24 ≈ 8.4e-8. 1e-6 clears both readings
 *  with 8–12× margin while staying orders below any deliberate off-flat divergence — one shared
 *  constant, so a tightening for one reading doesn't silently retune the other. */
export const COLLINEAR_TOL = 1e-6;

/** whether two vectors lie on one line through the origin — the scale-relative cross-product
 *  magnitude test, and nothing more. Direction-agnostic by design: a parallel AND an
 *  antiparallel pair both read collinear here. `spline`/`profile`/`track` share two callers
 *  with OPPOSITE sign conventions (a geo `Tangent`'s `in`/`out` point forward along travel, a
 *  force `Offset` pair points away from the key in opposite directions), so a sign requirement
 *  belongs to each caller, never to this core (`kex2d-followups` Locked decision). */
export function collinearVec(ax: number, ay: number, bx: number, by: number): boolean {
    const cross = ax * by - ay * bx;
    const scale = Math.hypot(ax, ay) * Math.hypot(bx, by);
    return Math.abs(cross) <= scale * COLLINEAR_TOL;
}

/** collinearize a tangent onto one shared forward direction, keeping each side's length —
 *  what switching a `Free` node to `Aligned` does (the Blender handle-type change re-aligns
 *  immediately, rather than leaving a corner the mode label contradicts). the direction comes
 *  from whichever handle has length (the out-handle preferred); a fully degenerate tangent
 *  keeps its zeroed vectors. */
export function alignTangent(tan: Tangent): Tangent {
    const outLen = Math.hypot(tan.outX, tan.outY);
    const inLen = Math.hypot(tan.inX, tan.inY);
    let dx: number;
    let dy: number;
    if (outLen >= EPS) {
        dx = tan.outX / outLen;
        dy = tan.outY / outLen;
    } else if (inLen >= EPS) {
        dx = tan.inX / inLen;
        dy = tan.inY / inLen;
    } else {
        return { ...tan, mode: TangentMode.Aligned };
    }
    return {
        mode: TangentMode.Aligned,
        inX: dx * inLen,
        inY: dy * inLen,
        outX: dx * outLen,
        outY: dy * outLen,
    };
}

/** collinearize AND equalize a tangent onto one shared forward vector — what switching to
 *  `Mirror` does (angle and length both mirrored). the survivor is the out (departure) handle
 *  when it has length, else the in handle; a fully degenerate tangent keeps its zeroed vectors.
 *  both sides become the survivor's vector, so an Aligned tangent's shorter side grows/shrinks
 *  to match the survivor rather than the switch silently keeping two lengths the mode forbids. */
export function mirrorTangent(tan: Tangent): Tangent {
    const outLen = Math.hypot(tan.outX, tan.outY);
    const inLen = Math.hypot(tan.inX, tan.inY);
    let vx: number;
    let vy: number;
    if (outLen >= EPS) {
        vx = tan.outX;
        vy = tan.outY;
    } else if (inLen >= EPS) {
        vx = tan.inX;
        vy = tan.inY;
    } else {
        return { ...tan, mode: TangentMode.Mirror };
    }
    return { mode: TangentMode.Mirror, inX: vx, inY: vy, outX: vx, outY: vy };
}

/** cubic Hermite point on the segment between `pa` (s=0) and `pb` (s=1). `va` /
 *  `vb` are the segment-space tangent vectors (already scaled by chord and k);
 *  sharing each node's heading across its two segments makes the joins
 *  tangent-continuous (no kink). */
function hermite(
    pa: Pt,
    va: readonly [number, number],
    pb: Pt,
    vb: readonly [number, number],
    s: number,
): Pt {
    const s2 = s * s;
    const s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1;
    const h10 = s3 - 2 * s2 + s;
    const h01 = -2 * s3 + 3 * s2;
    const h11 = s3 - s2;
    return {
        x: h00 * pa.x + h10 * va[0] + h01 * pb.x + h11 * vb[0],
        y: h00 * pa.y + h10 * va[1] + h01 * pb.y + h11 * vb[1],
    };
}

/** arc length + total absolute turning of one segment, from a coarse fine-
 *  sample. used only to choose the segment's edge count. */
function segMetrics(
    pa: Pt,
    va: readonly [number, number],
    pb: Pt,
    vb: readonly [number, number],
): { length: number; turning: number } {
    let length = 0;
    let turning = 0;
    let prevAngle = 0;
    let prev: Pt = pa;
    for (let k = 1; k <= FINE; k++) {
        const cur = hermite(pa, va, pb, vb, k / FINE);
        const dx = cur.x - prev.x;
        const dy = cur.y - prev.y;
        length += Math.hypot(dx, dy);
        const angle = Math.atan2(dy, dx);
        if (k > 1) turning += Math.abs(wrapPi(angle - prevAngle));
        prevAngle = angle;
        prev = cur;
    }
    return { length, turning };
}

/** per-segment edge counts (the discrete sampling topology). `counts[i]` edges
 *  bake the segment from node `i` to `i+1`; `counts.length` is the baked-segment
 *  count, `< nodes.length − 1` when a degenerate segment or the buffer stopped
 *  the walk. */
export type ChainCounts = {
    counts: number[];
    valid: boolean;
    truncated: boolean;
};

/**
 * the adaptive edge-count rule, split out of `sampleChain` so a solve can
 * **freeze** the sampling topology once and sample many node-parameter
 * variations against it (`sampleAt`) — a stable residual dimension for a
 * finite-difference Jacobian, and constant force-target sample indices across
 * the solve. per segment: `max(⌈length/dsNominal⌉, ⌈turning/(2·MAX_U_PER_EDGE)⌉)`,
 * clamped by remaining buffer. a ≈coincident chord or a full buffer stops the
 * walk (the prefix is kept, trailing nodes orphaned) — the same rule
 * `sampleChain` applies inline.
 */
export function chainCounts(
    nodes: readonly Node[],
    dsNominal: number,
    maxSamples: number,
): ChainCounts {
    const counts: number[] = [];
    let offset = 0;
    let valid = true;
    let truncated = false;

    for (let i = 0; i < nodes.length - 1; i++) {
        const pa = nodes[i];
        const pb = nodes[i + 1];
        const dx = pb.x - pa.x;
        const dy = pb.y - pa.y;
        const chordLen = Math.hypot(dx, dy);
        if (chordLen < EPS) {
            // node sits on its predecessor — no segment to bake. commit the
            // prefix; this node and everything after it are orphans.
            valid = false;
            break;
        }
        const chordAngle = Math.atan2(dy, dx);
        const va = outVec(pa, chordAngle, chordLen);
        const vb = inVec(pb, chordAngle, chordLen);
        const { length, turning } = segMetrics(pa, va, pb, vb);
        const byArc = Math.max(1, Math.round(length / dsNominal));
        const byTurn = Math.ceil(turning / (2 * MAX_U_PER_EDGE));
        let m = Math.max(byArc, byTurn, 1);

        const avail = maxSamples - 1 - offset;
        if (avail < 1) {
            truncated = true;
            valid = false;
            break;
        }
        if (m > avail) {
            m = avail;
            truncated = true;
        }
        counts.push(m);
        offset += m;
        if (truncated) break;
    }

    return { counts, valid, truncated };
}

/**
 * sample a node chain at **given** per-segment edge counts into `posX` / `posY`
 * (+ per-edge chord length into `dsArr`), landing each segment exactly on its
 * end node. the tangent length re-derives from the *live* chord every call, so
 * moving a node re-proportions the curve — only the discrete count is frozen.
 * `dsArr[i]` is the exact chord `|P_{i+1} − P_i|`. counts must fit the buffer
 * (`chainCounts` guarantees it); no bounds check here.
 */
export function sampleAt(
    nodes: readonly Node[],
    counts: readonly number[],
    posX: Float32Array | Float64Array,
    posY: Float32Array | Float64Array,
    dsArr: Float32Array | Float64Array,
): { offsets: number[]; edges: number } {
    posX[0] = nodes[0].x;
    posY[0] = nodes[0].y;

    const offsets = [0];
    let offset = 0;

    for (let i = 0; i < counts.length; i++) {
        const pa = nodes[i];
        const pb = nodes[i + 1];
        const chordAngle = Math.atan2(pb.y - pa.y, pb.x - pa.x);
        const chordLen = Math.hypot(pb.x - pa.x, pb.y - pa.y);
        const va = outVec(pa, chordAngle, chordLen);
        const vb = inVec(pb, chordAngle, chordLen);
        const m = counts[i];

        let prevX = pa.x;
        let prevY = pa.y;
        for (let j = 1; j <= m; j++) {
            // j === m → s = 1 lands exactly on pb (no float drift off the node).
            const pt = j === m ? pb : hermite(pa, va, pb, vb, j / m);
            posX[offset + j] = pt.x;
            posY[offset + j] = pt.y;
            dsArr[offset + j - 1] = Math.hypot(pt.x - prevX, pt.y - prevY);
            prevX = pt.x;
            prevY = pt.y;
        }
        offset += m;
        offsets.push(offset);
    }

    return { offsets, edges: offset };
}

/**
 * sample a node chain into `posX` / `posY` (+ per-edge chord length into
 * `dsArr`). each segment is a cubic Hermite between the two nodes' stored
 * headings, the tangent length scaled by the *live* chord (so dragging
 * re-proportions the curve instead of over/undershooting). node 0 lands at
 * sample 0; each segment is sampled uniformly in its parameter and lands
 * exactly on its end node.
 *
 * `dsArr[i]` is the **exact** chord `|P_{i+1} − P_i|` between consecutive
 * *samples*, which makes the kinematic inversion the algebraic inverse of the
 * forward step (so the round-trip reproduces these positions to f32 noise). a
 * degenerate (≈coincident) segment or a full buffer stops the walk: a partial
 * chain is committed and trailing nodes are orphaned.
 *
 * the adaptive `chainCounts` + `sampleAt` split (above) is the same walk; this
 * is the fused convenience the identity bake and every test call.
 */
export function sampleChain(
    nodes: readonly Node[],
    dsNominal: number,
    posX: Float32Array,
    posY: Float32Array,
    dsArr: Float32Array,
    maxSamples: number,
): ChainResult {
    if (nodes.length < 2) return { valid: false, edges: 0, offsets: [], truncated: false };
    const { counts, valid, truncated } = chainCounts(nodes, dsNominal, maxSamples);
    const { offsets, edges } = sampleAt(nodes, counts, posX, posY, dsArr);
    return { valid, edges, offsets, truncated };
}
