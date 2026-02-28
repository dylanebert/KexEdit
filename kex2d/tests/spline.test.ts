import { describe, expect, test } from "bun:test";
import { MAX_U_PER_EDGE, type Node, reflect, sampleChain } from "../src/spline";
import { withThetas } from "./helpers/chain";
import { makeBuf } from "./helpers/buf";

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
