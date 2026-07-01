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

export type Node = { x: number; y: number; theta: number };

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

    posX[0] = nodes[0].x;
    posY[0] = nodes[0].y;

    const offsets = [0];
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
        const va = handle(pa.theta, chordAngle, chordLen);
        const vb = handle(pb.theta, chordAngle, chordLen);
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

        let prevX = pa.x;
        let prevY = pa.y;
        for (let j = 1; j <= m; j++) {
            // j === m → s = 1 lands exactly on pb (no f32 drift off the node).
            const pt = j === m ? pb : hermite(pa, va, pb, vb, j / m);
            posX[offset + j] = pt.x;
            posY[offset + j] = pt.y;
            dsArr[offset + j - 1] = Math.hypot(pt.x - prevX, pt.y - prevY);
            prevX = pt.x;
            prevY = pt.y;
        }
        offset += m;
        offsets.push(offset);
        if (truncated) break;
    }

    return { valid, edges: offset, offsets, truncated };
}
