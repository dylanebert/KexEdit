import { describe, expect, test } from "bun:test";
import {
    chainCounts,
    MAX_U_PER_EDGE,
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
