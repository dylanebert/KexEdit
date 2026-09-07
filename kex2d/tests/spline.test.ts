import { describe, expect, test } from "bun:test";
import {
    alignTangent,
    autoTangent,
    chainCounts,
    editTangent,
    handleTip,
    MAX_U_PER_EDGE,
    mirrorTangent,
    type Node,
    reflect,
    sampleAt,
    sampleChain,
    type Tangent,
    TangentMode,
} from "../src/spline";
import { withThetas } from "./helpers/chain";
import { makeBuf } from "./helpers/buf";
import autoGolden from "./fixtures/spline-auto-golden.json";

/** wrap an angle delta into (−π, π]. */
function wrap(a: number): number {
    return ((((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
}

const MAX = 4096;
const DS = 0.5;

/** absolute turning of a baked polyline over `[0, edges]`, wrapping each
 *  per-edge delta into (−π, π]. */
function polyTurning(posX: Float32Array, posY: Float32Array, edges: number): number {
    let turning = 0;
    let prev = Math.atan2(posY[1] - posY[0], posX[1] - posX[0]);
    for (let i = 1; i < edges; i++) {
        const a = Math.atan2(posY[i + 1] - posY[i], posX[i + 1] - posX[i]);
        let d = a - prev;
        d = ((((d + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
        turning += Math.abs(d);
        prev = a;
    }
    return turning;
}

describe("reflect — circular-arc exit heading", () => {
    test("placing straight ahead continues the heading unchanged", () => {
        // chord along the incoming heading → exit equals it (a straight segment).
        expect(reflect(0.37, 0.37)).toBeCloseTo(0.37, 12);
    });

    test("a placement offset δ rotates the exit by 2δ", () => {
        // incoming +x (0), chord at δ → exit at 2δ (the arc turns by 2δ).
        const d = 0.4;
        expect(reflect(0, d)).toBeCloseTo(2 * d, 12);
    });
});

describe("sampleChain — interpolation", () => {
    test("the baked curve passes through every node", () => {
        const b = makeBuf(MAX);
        const nodes = withThetas([
            { x: 0, y: 0 },
            { x: 8, y: 3 },
            { x: 16, y: -1 },
            { x: 22, y: 4 },
            { x: 30, y: 0 },
        ]);
        const r = sampleChain(nodes, DS, b.posX, b.posY, b.ds, MAX);
        expect(r.valid).toBe(true);
        expect(r.offsets.length).toBe(nodes.length);
        nodes.forEach((node, k) => {
            expect(b.posX[r.offsets[k]]).toBeCloseTo(node.x, 4);
            expect(b.posY[r.offsets[k]]).toBeCloseTo(node.y, 4);
        });
        // the last node's sample is the final edge index.
        expect(r.offsets[nodes.length - 1]).toBe(r.edges);
    });

    test("a segment with both headings on its chord is a straight line", () => {
        const b = makeBuf(MAX);
        // both headings along the chord → φ = 0 → k = 1 → a straight line (the
        // "placing in line produces a line" case, independent of the anchor rule).
        const a = Math.atan2(5, 12);
        const r = sampleChain(
            [
                { x: 0, y: 0, theta: a },
                { x: 12, y: 5, theta: a },
            ],
            DS,
            b.posX,
            b.posY,
            b.ds,
            MAX,
        );
        expect(r.valid).toBe(true);
        // every sample lies on the chord y = (5/12)·x.
        for (let i = 0; i <= r.edges; i++) {
            expect(b.posY[i]).toBeCloseTo((5 / 12) * b.posX[i], 4);
        }
    });

    test("per-edge ds is the exact chord length (round-trip exactness)", () => {
        const b = makeBuf(MAX);
        const nodes = withThetas([
            { x: 0, y: 0 },
            { x: 7, y: 2 },
            { x: 15, y: -3 },
        ]);
        const r = sampleChain(nodes, DS, b.posX, b.posY, b.ds, MAX);
        for (let i = 0; i < r.edges; i++) {
            const d = Math.hypot(b.posX[i + 1] - b.posX[i], b.posY[i + 1] - b.posY[i]);
            expect(b.ds[i]).toBeCloseTo(d, 5);
        }
    });

    test("average per-edge turning honors the angular cap on a tight chain", () => {
        // a wiggly, short chain — high turning per unit arc length. the M-floor
        // M ≥ ⌈turning/(2·MAX_U)⌉ bounds the average per-edge turning by 2·MAX_U
        // regardless of arc length; this fails if the cap floor is dropped.
        const b = makeBuf(MAX);
        const nodes = withThetas([
            { x: 0, y: 0 },
            { x: 2, y: 0 },
            { x: 2.3, y: 1.2 },
            { x: 0.5, y: 1.4 },
            { x: 0.4, y: 0 },
        ]);
        const r = sampleChain(nodes, DS, b.posX, b.posY, b.ds, MAX);
        expect(r.valid).toBe(true);
        const avg = polyTurning(b.posX, b.posY, r.edges) / r.edges;
        expect(avg).toBeLessThanOrEqual(2 * MAX_U_PER_EDGE + 0.05);
    });
});

describe("chainCounts + sampleAt — frozen sampling topology", () => {
    test("the sample dimension is fixed by the counts, stable as nodes move", () => {
        // the solver's frozen-gesture primitive: freeze per-segment counts once,
        // then sample many node-parameter variations against them — a constant
        // residual dimension for the finite-difference Jacobian.
        const nodes = withThetas([
            { x: 0, y: 0 },
            { x: 12, y: 4 },
            { x: 26, y: 10 },
            { x: 40, y: 4 },
            { x: 54, y: 0 },
        ]);
        const { counts } = chainCounts(nodes, DS, MAX);
        const total = counts.reduce((s, m) => s + m, 0);

        const a = makeBuf(MAX);
        const ra = sampleAt(nodes, counts, a.posX, a.posY, a.ds);
        expect(ra.edges).toBe(total);

        // move an interior node far enough that the *adaptive* rule re-chooses
        // this segment's edge count — the frozen counts must not follow.
        const moved = nodes.map((n) => ({ ...n }));
        moved[2] = { ...moved[2], x: moved[2].x + 6, y: moved[2].y + 5 };
        const b = makeBuf(MAX);
        const rb = sampleAt(moved, counts, b.posX, b.posY, b.ds);
        expect(rb.edges).toBe(total); // dimension unchanged
        expect(rb.offsets).toEqual(ra.offsets); // every node offset stable
        // the adaptive path drifts the dimension — what the freeze exists to avoid.
        const c = makeBuf(MAX);
        expect(chainCounts(moved, DS, MAX).counts).not.toEqual(counts);
        expect(sampleChain(moved, DS, c.posX, c.posY, c.ds, MAX).edges).not.toBe(total);
        // and the frozen bake still lands exactly on the moved node.
        expect(b.posX[rb.offsets[2]]).toBeCloseTo(moved[2].x, 4);
        expect(b.posY[rb.offsets[2]]).toBeCloseTo(moved[2].y, 4);
    });
});

describe("sampleChain — a fresh node's segment is a circular arc", () => {
    test("a reflected-pair segment lies on its circle (4/3-rule fidelity)", () => {
        const R = 10;
        // start at the origin heading +x; a left turn whose chord bisects at 45°
        // lands the exit heading at +y, so the center is (0, R) and the arc runs
        // a quarter circle to (R, R). theta_1 is exactly the reflected exit.
        expect(reflect(0, Math.PI / 4)).toBeCloseTo(Math.PI / 2, 12);
        const nodes: Node[] = [
            { x: 0, y: 0, theta: 0 },
            { x: R, y: R, theta: Math.PI / 2 },
        ];
        const b = makeBuf(MAX);
        const r = sampleChain(nodes, DS, b.posX, b.posY, b.ds, MAX);
        // every sample sits on |P − (0, R)| = R. a cubic best-fits a 90° arc to
        // ≤ ~2.7e-4·R (the 4/3 rule); 1e-3·R is a safe bound and a flat k=1
        // tangent length (which under-bends) would miss it by ~10×.
        let maxErr = 0;
        for (let k = 0; k <= r.edges; k++) {
            maxErr = Math.max(maxErr, Math.abs(Math.hypot(b.posX[k], b.posY[k] - R) - R));
        }
        expect(maxErr).toBeLessThan(1e-3 * R);
    });
});

describe("sampleChain — local support (only the two shared segments move)", () => {
    test("dragging a node leaves every other segment byte-identical", () => {
        const nodes = withThetas([
            { x: 0, y: 0 },
            { x: 8, y: 3 },
            { x: 16, y: -1 },
            { x: 24, y: 2 },
            { x: 32, y: -2 },
            { x: 40, y: 1 },
            { x: 48, y: -1 },
            { x: 56, y: 2 },
        ]);
        const i = 4; // interior; only segments i−1 and i (sharing node i) may move
        const a = makeBuf(MAX);
        const ra = sampleChain(nodes, DS, a.posX, a.posY, a.ds, MAX);
        // move ONLY the position of node i; every heading stays frozen.
        const moved = nodes.map((n) => ({ ...n }));
        moved[i] = { ...moved[i], x: nodes[i].x + 1.3, y: nodes[i].y - 0.9 };
        const b = makeBuf(MAX);
        const rb = sampleChain(moved, DS, b.posX, b.posY, b.ds, MAX);

        // upstream segments 0..i−2 (samples [0, offsets[i−1]]) are byte-identical:
        // none of them reference node i, so even the absolute indices hold.
        expect(rb.offsets[i - 1]).toBe(ra.offsets[i - 1]);
        for (let k = 0; k <= ra.offsets[i - 1]; k++) {
            expect(b.posX[k]).toBe(a.posX[k]);
            expect(b.posY[k]).toBe(a.posY[k]);
        }
        // the two shared segments actually changed.
        let shared = false;
        for (let k = ra.offsets[i - 1]; k <= ra.offsets[i + 1] && k <= rb.offsets[i + 1]; k++) {
            if (a.posX[k] !== b.posX[k] || a.posY[k] !== b.posY[k]) shared = true;
        }
        expect(shared).toBe(true);
        // downstream segments s ≥ i+1 are unchanged in shape (compared relative
        // to each run's own node offsets, since absolute indices may shift).
        for (let s = i + 1; s < nodes.length - 1; s++) {
            const segA = ra.offsets[s + 1] - ra.offsets[s];
            expect(rb.offsets[s + 1] - rb.offsets[s]).toBe(segA);
            for (let j = 0; j <= segA; j++) {
                expect(b.posX[rb.offsets[s] + j]).toBe(a.posX[ra.offsets[s] + j]);
                expect(b.posY[rb.offsets[s] + j]).toBe(a.posY[ra.offsets[s] + j]);
            }
        }
    });
});

describe("sampleChain — degenerate", () => {
    test("a coincident segment commits the prefix and orphans the rest", () => {
        const b = makeBuf(MAX);
        const nodes = withThetas([
            { x: 0, y: 0 },
            { x: 6, y: 2 },
            { x: 6, y: 2 }, // sits on its predecessor
            { x: 12, y: 0 },
        ]);
        const r = sampleChain(nodes, DS, b.posX, b.posY, b.ds, MAX);
        expect(r.valid).toBe(false);
        expect(r.offsets.length).toBe(2); // node 0 + node 1 baked, rest orphaned
        expect(r.edges).toBeGreaterThan(0);
    });

    test("fewer than two nodes bakes nothing", () => {
        const b = makeBuf(MAX);
        const r = sampleChain(withThetas([{ x: 0, y: 0 }]), DS, b.posX, b.posY, b.ds, MAX);
        expect(r.valid).toBe(false);
        expect(r.edges).toBe(0);
    });
});

describe("sampleChain — Auto arc parity (regression pin)", () => {
    // the explicit-tangent seam (`handle()` → `outVec`/`inVec`) must leave the
    // default `Auto` path byte-identical. the golden was baked from the pristine
    // arc rule (`tests/fixtures/spline-auto-golden.json`); Auto nodes carry no
    // `tangent`, so `outVec`/`inVec` fall straight through to `handle` — an exact
    // (not approximate) match is the contract, and this pins it against drift.
    const golden = autoGolden as Record<
        string,
        {
            nodes: Node[];
            edges: number;
            offsets: number[];
            valid: boolean;
            truncated: boolean;
            posX: number[];
            posY: number[];
            ds: number[];
        }
    >;
    for (const [name, g] of Object.entries(golden)) {
        test(`the ${name} chain is byte-identical to the pinned baseline`, () => {
            const b = makeBuf(4096);
            const r = sampleChain(g.nodes, DS, b.posX, b.posY, b.ds, 4096);
            expect(r.edges).toBe(g.edges);
            expect(r.valid).toBe(g.valid);
            expect(r.truncated).toBe(g.truncated);
            expect(r.offsets).toEqual(g.offsets);
            for (let i = 0; i <= r.edges; i++) {
                expect(b.posX[i]).toBe(g.posX[i]); // strict === on the f32 value
                expect(b.posY[i]).toBe(g.posY[i]);
            }
            for (let i = 0; i < r.edges; i++) expect(b.ds[i]).toBe(g.ds[i]);
        });
    }
});

describe("sampleChain — explicit tangents", () => {
    test("an explicit out-vector sets the node's departure tangent, chord-independent", () => {
        // node 0 at the origin (so its position terms vanish) carries an explicit
        // out-vector at 45°; a fine probe recovers the s=0 tangent as that vector.
        const ang = Math.PI / 4;
        const mag = 10;
        const out: Tangent = {
            mode: TangentMode.Free,
            inX: 0,
            inY: 0,
            outX: mag * Math.cos(ang),
            outY: mag * Math.sin(ang),
        };
        const nodes: Node[] = [
            { x: 0, y: 0, theta: 0, tangent: out },
            { x: 20, y: 0, theta: 0 },
        ];
        const b = makeBuf(4096);
        sampleAt(nodes, [800], b.posX, b.posY, b.ds); // dense → the secant ≈ the tangent
        const dir = Math.atan2(b.posY[1] - b.posY[0], b.posX[1] - b.posX[0]);
        expect(dir).toBeCloseTo(ang, 2);

        // absolute, not chord-proportional: moving the far anchor leaves the departure
        // tangent fixed (the Figma/Blender "handle holds its length under an anchor
        // drag") — an Auto node would swing to follow the new chord instead.
        const moved: Node[] = [nodes[0], { x: 40, y: 15, theta: 0 }];
        sampleAt(moved, [800], b.posX, b.posY, b.ds);
        const dir2 = Math.atan2(b.posY[1] - b.posY[0], b.posX[1] - b.posX[0]);
        expect(dir2).toBeCloseTo(ang, 2);
    });

    test("a Free corner (C0 kink) samples sanely and honors the turning rule", () => {
        // node 1 arrives flat (in-vector +x) and leaves upward (out-vector +y) — a
        // 90° corner the arc rule cannot express. large vectors dominate the
        // secant so the measured kink is unambiguous.
        const mag = 30;
        const corner: Tangent = { mode: TangentMode.Free, inX: mag, inY: 0, outX: 0, outY: mag };
        const nodes: Node[] = [
            { x: 0, y: 0, theta: 0 },
            { x: 20, y: 0, theta: 0, tangent: corner },
            { x: 20, y: 20, theta: 0 },
        ];
        const b = makeBuf(4096);
        const r = sampleChain(nodes, DS, b.posX, b.posY, b.ds, 4096);

        expect(r.valid).toBe(true);
        expect(r.offsets.length).toBe(3);
        const off = r.offsets[1];
        // the corner lands exactly on its node, and both flanks got real edges.
        expect(b.posX[off]).toBeCloseTo(20, 4);
        expect(b.posY[off]).toBeCloseTo(0, 4);
        expect(off - r.offsets[0]).toBeGreaterThan(0);
        expect(r.offsets[2] - off).toBeGreaterThan(0);
        for (let i = 0; i <= r.edges; i++) {
            expect(Number.isFinite(b.posX[i])).toBe(true);
            expect(Number.isFinite(b.posY[i])).toBe(true);
        }
        for (let i = 0; i < r.edges; i++) expect(b.ds[i]).toBeGreaterThan(0);

        // the tangent is DISCONTINUOUS at the node: arrival ≈ +x, departure ≈ +y,
        // a ~90° turn a C1 node would never produce.
        const arr = Math.atan2(b.posY[off] - b.posY[off - 1], b.posX[off] - b.posX[off - 1]);
        const dep = Math.atan2(b.posY[off + 1] - b.posY[off], b.posX[off + 1] - b.posX[off]);
        expect(Math.abs(wrap(dep - arr))).toBeGreaterThan(1.2);

        // the turning rule still tames the within-segment bend: the outgoing segment
        // (out-vector +y sweeping to node 2's arc tangent) averages ≤ 2·MAX_U per
        // edge, so `chainCounts` gave it enough edges (this fails if byTurn is skipped
        // for explicit tangents).
        let turn = 0;
        let prev = Math.atan2(b.posY[off + 1] - b.posY[off], b.posX[off + 1] - b.posX[off]);
        for (let i = off + 1; i < r.edges; i++) {
            const a = Math.atan2(b.posY[i + 1] - b.posY[i], b.posX[i + 1] - b.posX[i]);
            turn += Math.abs(wrap(a - prev));
            prev = a;
        }
        expect(turn / (r.edges - off)).toBeLessThanOrEqual(2 * MAX_U_PER_EDGE + 0.05);
    });
});

describe("editTangent / handleTip — the handle-drag math", () => {
    const base = (): Tangent => ({ mode: TangentMode.Free, inX: 4, inY: 0, outX: 6, outY: 0 });

    test("handleTip: out is the stored vector, in is its negation (the through-node draw)", () => {
        const t: Tangent = { mode: TangentMode.Free, inX: 4, inY: 1, outX: 6, outY: -2 };
        expect(handleTip(t, "out")).toEqual([6, -2]);
        expect(handleTip(t, "in")).toEqual([-4, -1]);
    });

    test("handleTip ∘ editTangent round-trips the dragged side (Free)", () => {
        for (const side of ["in", "out"] as const) {
            const edited = editTangent(base(), side, 3, 7);
            expect(handleTip(edited, side)[0]).toBeCloseTo(3, 12);
            expect(handleTip(edited, side)[1]).toBeCloseTo(7, 12);
        }
    });

    test("Free: dragging one handle moves only that side", () => {
        const outDrag = editTangent(base(), "out", 2, 9);
        expect([outDrag.outX, outDrag.outY]).toEqual([2, 9]);
        expect([outDrag.inX, outDrag.inY]).toEqual([4, 0]); // in untouched

        const inDrag = editTangent(base(), "in", 2, 9);
        expect([inDrag.inX, inDrag.inY]).toEqual([-2, -9]); // in stores the negated visual offset
        expect([inDrag.outX, inDrag.outY]).toEqual([6, 0]); // out untouched
    });

    test("Aligned: dragging out rotates both to the shared direction, each side keeps its length", () => {
        // start collinear along +x (in length 4, out length 6). drag the out-handle to (0, 5):
        // the shared forward direction becomes +y; out takes the new length 5, in keeps 4.
        const t: Tangent = { mode: TangentMode.Aligned, inX: 4, inY: 0, outX: 6, outY: 0 };
        const e = editTangent(t, "out", 0, 5);
        // out is the drag (length 5, +y); in keeps length 4 on the same forward direction (+y),
        // so its stored vector — the forward arrival velocity — is (0, 4).
        expect(e.outX).toBeCloseTo(0, 12);
        expect(e.outY).toBeCloseTo(5, 12);
        expect(e.inX).toBeCloseTo(0, 12);
        expect(e.inY).toBeCloseTo(4, 12);
        // the two handles stay collinear through the node (out forward, in drawn opposite).
        expect(handleTip(e, "out")).toEqual([e.outX, e.outY]);
        expect(handleTip(e, "in")[0]).toBeCloseTo(0, 12);
        expect(handleTip(e, "in")[1]).toBeCloseTo(-4, 12); // the in-handle points backward
    });

    test("Aligned: dragging in rotates both; in takes the new length, out keeps its own", () => {
        // in-handle dragged to visual offset (−5, 0) (pointing backward along −x): the forward
        // direction is +x, in length becomes 5, out keeps length 6.
        const t: Tangent = { mode: TangentMode.Aligned, inX: 0, inY: 3, outX: 0, outY: 6 };
        const e = editTangent(t, "in", -5, 0);
        expect(e.inX).toBeCloseTo(5, 12); // forward arrival velocity = +x · 5
        expect(e.inY).toBeCloseTo(0, 12);
        expect(e.outX).toBeCloseTo(6, 12); // out keeps length 6, rotated onto +x
        expect(e.outY).toBeCloseTo(0, 12);
    });

    test("Aligned: a degenerate drop onto the node leaves the tangent unchanged", () => {
        const t: Tangent = { mode: TangentMode.Aligned, inX: 4, inY: 0, outX: 6, outY: 0 };
        expect(editTangent(t, "out", 0, 0)).toEqual(t);
    });

    test("alignTangent: a Free divergent tangent collinearizes onto the out direction, lengths kept", () => {
        // in points +y (length 3), out points +x (length 6) — a corner. aligning shares the out
        // direction (+x): out stays (6,0), in rotates to +x keeping length 3 → (3,0).
        const free: Tangent = { mode: TangentMode.Free, inX: 0, inY: 3, outX: 6, outY: 0 };
        const a = alignTangent(free);
        expect(a.mode).toBe(TangentMode.Aligned);
        expect(a.outX).toBeCloseTo(6, 12);
        expect(a.outY).toBeCloseTo(0, 12);
        expect(a.inX).toBeCloseTo(3, 12);
        expect(a.inY).toBeCloseTo(0, 12);
    });

    test("alignTangent: a zero out-handle falls back to the in direction", () => {
        const t: Tangent = { mode: TangentMode.Free, inX: 0, inY: 5, outX: 0, outY: 0 };
        const a = alignTangent(t);
        expect(a.inX).toBeCloseTo(0, 12);
        expect(a.inY).toBeCloseTo(5, 12);
        expect(a.outX).toBeCloseTo(0, 12);
        expect(a.outY).toBeCloseTo(0, 12); // out length 0 → stays at the node
    });

    test("autoTangent points along theta, scaled by the chord (the arc-rule seed)", () => {
        // heading along the chord (φ = 0) → k = 1, magnitude = chordLen, direction = theta.
        const [x, y] = autoTangent(Math.PI / 6, Math.PI / 6, 10);
        expect(x).toBeCloseTo(10 * Math.cos(Math.PI / 6), 6);
        expect(y).toBeCloseTo(10 * Math.sin(Math.PI / 6), 6);
    });
});

describe("editTangent / mirrorTangent — Mirror mode", () => {
    test("Mirror: dragging out sets both sides to the dragged forward vector (angle + length)", () => {
        const t: Tangent = { mode: TangentMode.Mirror, inX: 4, inY: 0, outX: 6, outY: 0 };
        const e = editTangent(t, "out", 0, 5); // drag out to (0, 5)
        expect([e.outX, e.outY]).toEqual([0, 5]);
        expect([e.inX, e.inY]).toEqual([0, 5]); // in mirrors it exactly — same direction and length
        // both handles draw collinear through the node (out forward, in opposite).
        expect(handleTip(e, "out")).toEqual([0, 5]);
        expect(handleTip(e, "in")).toEqual([-0, -5]);
    });

    test("Mirror: dragging in mirrors onto out too, through the negated-visual convention", () => {
        // the in-handle's visual offset (3, 6) stores as the forward arrival vector (−3, −6); Mirror
        // sets the out-vector equal, so both stored vectors are (−3, −6).
        const t: Tangent = { mode: TangentMode.Mirror, inX: 5, inY: 0, outX: 5, outY: 0 };
        const e = editTangent(t, "in", 3, 6);
        expect([e.inX, e.inY]).toEqual([-3, -6]);
        expect([e.outX, e.outY]).toEqual([-3, -6]);
        expect(handleTip(e, "in")).toEqual([3, 6]); // the dragged in-handle round-trips
    });

    test("Mirror: a degenerate drop onto the node leaves the tangent unchanged", () => {
        const t: Tangent = { mode: TangentMode.Mirror, inX: 4, inY: 0, outX: 4, outY: 0 };
        expect(editTangent(t, "out", 0, 0)).toEqual(t);
    });

    test("mirrorTangent: an Aligned tangent equalizes onto the out (survivor) length", () => {
        // in length 4, out length 6, both +x → switching to Mirror keeps the out (departure) side
        // and grows in to match: both become (6, 0).
        const t: Tangent = { mode: TangentMode.Aligned, inX: 4, inY: 0, outX: 6, outY: 0 };
        const m = mirrorTangent(t);
        expect(m.mode).toBe(TangentMode.Mirror);
        expect([m.outX, m.outY]).toEqual([6, 0]);
        expect([m.inX, m.inY]).toEqual([6, 0]);
    });

    test("mirrorTangent: a Free corner collinearizes AND equalizes onto the out direction", () => {
        // in points +y (length 3), out points +x (length 6) — a corner. Mirror takes the out
        // vector for both: (6, 0) and (6, 0).
        const free: Tangent = { mode: TangentMode.Free, inX: 0, inY: 3, outX: 6, outY: 0 };
        const m = mirrorTangent(free);
        expect(m.mode).toBe(TangentMode.Mirror);
        expect(m.outX).toBeCloseTo(6, 12);
        expect(m.outY).toBeCloseTo(0, 12);
        expect(m.inX).toBeCloseTo(6, 12);
        expect(m.inY).toBeCloseTo(0, 12);
    });

    test("mirrorTangent: a zero out-handle falls back to the in vector for both sides", () => {
        const t: Tangent = { mode: TangentMode.Free, inX: 0, inY: 5, outX: 0, outY: 0 };
        const m = mirrorTangent(t);
        expect([m.inX, m.inY]).toEqual([0, 5]);
        expect([m.outX, m.outY]).toEqual([0, 5]); // out grows to match the survivor
    });
});

describe("sampleChain — stamp-on-append byte continuity", () => {
    test("stamping a node's inferred tangents reproduces the Auto curve byte-identically", () => {
        // the stamp-on-append contract: freezing a live tip's arc-rule tangents as an explicit
        // Aligned tangent must write *exactly* what inference was producing, so the baked curve is
        // byte-identical across the stamp. this is the pure-spline core (f64 vectors, strict ===);
        // the ECS realization stores f32, so track.ts tests it with a tolerance.
        const nodes = withThetas([
            { x: 0, y: 0 },
            { x: 12, y: 5 },
            { x: 28, y: 9 },
            { x: 44, y: 4 },
        ]);
        const a = makeBuf(MAX);
        const ra = sampleChain(nodes, DS, a.posX, a.posY, a.ds, MAX);

        // stamp interior node 1: an Aligned tangent whose in/out are the arc-rule vector along the
        // live chord to the previous / next node — exactly `outVec`/`inVec`'s Auto branch.
        const i = 1;
        const inAng = Math.atan2(nodes[i].y - nodes[i - 1].y, nodes[i].x - nodes[i - 1].x);
        const inLen = Math.hypot(nodes[i].x - nodes[i - 1].x, nodes[i].y - nodes[i - 1].y);
        const outAng = Math.atan2(nodes[i + 1].y - nodes[i].y, nodes[i + 1].x - nodes[i].x);
        const outLen = Math.hypot(nodes[i + 1].x - nodes[i].x, nodes[i + 1].y - nodes[i].y);
        const [ix, iy] = autoTangent(nodes[i].theta, inAng, inLen);
        const [ox, oy] = autoTangent(nodes[i].theta, outAng, outLen);
        const stamped = nodes.map((n) => ({ ...n }));
        stamped[i] = {
            ...stamped[i],
            tangent: { mode: TangentMode.Aligned, inX: ix, inY: iy, outX: ox, outY: oy },
        };

        const b = makeBuf(MAX);
        const rb = sampleChain(stamped, DS, b.posX, b.posY, b.ds, MAX);
        expect(rb.edges).toBe(ra.edges);
        expect(rb.offsets).toEqual(ra.offsets);
        for (let k = 0; k <= ra.edges; k++) {
            expect(b.posX[k]).toBe(a.posX[k]); // strict === — byte-identical
            expect(b.posY[k]).toBe(a.posY[k]);
        }
        for (let k = 0; k < ra.edges; k++) expect(b.ds[k]).toBe(a.ds[k]);
    });
});

describe("fuzz — forward chains hold the bake invariants", () => {
    test("200 random chains: every node hit, all finite, ds positive", () => {
        const b = makeBuf(MAX);
        for (let t = 0; t < 200; t++) {
            const n = 2 + Math.floor(Math.random() * 5); // 2..6 nodes
            const pts = [{ x: 0, y: 0 }];
            let cx = 0;
            let cy = 0;
            for (let k = 1; k < n; k++) {
                cx += Math.random() * 10 + 2; // strictly forward in x → no coincidence
                cy += (Math.random() - 0.5) * 12;
                pts.push({ x: cx, y: cy });
            }
            const nodes = withThetas(pts);
            const r = sampleChain(nodes, DS, b.posX, b.posY, b.ds, MAX);
            expect(r.valid).toBe(true);
            expect(r.offsets.length).toBe(n);
            nodes.forEach((node, k) => {
                expect(b.posX[r.offsets[k]]).toBeCloseTo(node.x, 3);
                expect(b.posY[r.offsets[k]]).toBeCloseTo(node.y, 3);
            });
            for (let i = 0; i <= r.edges; i++) {
                expect(Number.isFinite(b.posX[i])).toBe(true);
                expect(Number.isFinite(b.posY[i])).toBe(true);
            }
            for (let i = 0; i < r.edges; i++) expect(b.ds[i]).toBeGreaterThan(0);
        }
    });
});
