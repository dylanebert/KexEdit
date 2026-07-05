import { expect, test } from "bun:test";
import { forces64 } from "../src/force";
import {
    type Baked,
    bakeNodes,
    DEFAULT_WEIGHTS,
    type PointTarget,
    pointResidual,
    sampleArc,
    sampleAtArc,
    scopeForPoint,
    solveTargets,
} from "../src/solve";
import { chainCounts, type Node } from "../src/spline";
import { hillDraft } from "./helpers/hill";

const DS = 0.5;
const MAX = 4096;

/** the stage-1 evidence gate (spec live log) measured a point demand reaching
 *  the ~0.03 g (≈2 px on the ~260 px timeline chart over a ~4 g fit) display
 *  budget at authoring node density with the auto-scope set; this pins the
 *  promoted solver reproduces that result. the bound carries numeric headroom
 *  over the measured value. */
const BUDGET_G = 0.04;

function bakeHill(): { draft: ReturnType<typeof hillDraft>; b: Baked; counts: number[] } {
    const draft = hillDraft();
    const { counts } = chainCounts(draft.nodes, DS, MAX);
    return { draft, b: bakeNodes(draft.nodes, counts, draft.v0), counts };
}

/** the point target at node `k`'s sample demanding `g`. */
function pointAtNode(b: Baked, arc: Float64Array, k: number, g: number): PointTarget {
    return { i: sampleAtArc(arc, b.n, arc[b.offsets[k]]), g, w: 1 };
}

test("bakeNodes agrees with a direct forces64 over the frozen samples", () => {
    const { draft, b } = bakeHill();
    const direct = forces64(b.x, b.y, b.n, draft.v0);
    for (let i = 0; i < b.n; i++) expect(b.fN[i]).toBeCloseTo(direct.fN[i], 12);
    // each node lands on a sample; offsets are monotone from 0.
    expect(b.offsets[0]).toBe(0);
    expect(b.offsets.length).toBe(draft.nodes.length);
    for (let k = 1; k < b.offsets.length; k++)
        expect(b.offsets[k]).toBeGreaterThan(b.offsets[k - 1]);
});

test("sampleArc is monotone and sampleAtArc round-trips a node's arclength", () => {
    const { b } = bakeHill();
    const arc = sampleArc(b);
    expect(arc[0]).toBe(0);
    for (let i = 1; i < b.n; i++) expect(arc[i]).toBeGreaterThan(arc[i - 1]);
    // the crest node's arclength maps back to (near) its own sample index.
    const crestSample = b.offsets[3];
    const got = sampleAtArc(arc, b.n, arc[crestSample]);
    expect(Math.abs(got - crestSample)).toBeLessThanOrEqual(1);
});

test("scopeForPoint frees the containing segment's nodes plus one neighbor each side", () => {
    const { b } = bakeHill();
    const arc = sampleArc(b);
    // a point just past the crest node (node 3) sits in segment [3,4]; scope
    // widens one neighbor each side → [2..5].
    expect(scopeForPoint(b, arc, arc[b.offsets[3]] + 1)).toEqual([2, 3, 4, 5]);
    // the anchor (node 0) is never freed even when the point sits at the start.
    const scope = scopeForPoint(b, arc, 0);
    expect(scope).not.toContain(0);
    expect(scope[0]).toBeGreaterThanOrEqual(1);
    // a point past the track end clamps to the last segment.
    const last = b.offsets.length - 1;
    const tail = scopeForPoint(b, arc, arc[b.offsets[last]] + 100);
    expect(tail).toContain(last);
    expect(tail).toContain(last - 1);
});

test("solveTargets holds a 0g point demand at the crest within the display budget", () => {
    const { draft, b, counts } = bakeHill();
    const arc = sampleArc(b);
    const target = pointAtNode(b, arc, 3, 0);
    const freed = scopeForPoint(b, arc, arc[b.offsets[3]]);

    const res = solveTargets(draft.nodes, freed, counts, draft.v0, [target]);
    expect(res.iters).toBeLessThanOrEqual(120);

    const bs = bakeNodes(res.nodes, counts, draft.v0);
    const { err } = pointResidual(bs, target);
    expect(err).toBeLessThan(BUDGET_G);
    // finite, feasible throughout (v² stays well above 0 — the hill's launch
    // speed clears the crest with margin).
    for (let i = 0; i < bs.n; i++) {
        expect(Number.isFinite(bs.x[i])).toBe(true);
        expect(bs.v2[i]).toBeGreaterThan(0);
    }
});

test("solveTargets leaves the draft untouched and only moves freed nodes", () => {
    const { draft, b, counts } = bakeHill();
    const arc = sampleArc(b);
    const target = pointAtNode(b, arc, 3, 0);
    const freed = scopeForPoint(b, arc, arc[b.offsets[3]]);
    const before: Node[] = draft.nodes.map((n) => ({ ...n }));

    const res = solveTargets(draft.nodes, freed, counts, draft.v0, [target]);

    // draft is unmodified.
    draft.nodes.forEach((n, k) => {
        expect(n.x).toBe(before[k].x);
        expect(n.y).toBe(before[k].y);
        expect(n.theta).toBe(before[k].theta);
    });
    // unfreed nodes are byte-identical; freed nodes moved.
    res.nodes.forEach((n, k) => {
        if (freed.includes(k)) return;
        expect(n.x).toBe(before[k].x);
        expect(n.y).toBe(before[k].y);
        expect(n.theta).toBe(before[k].theta);
    });
    expect(res.nodes[3].y).not.toBe(before[3].y); // the crest reshaped
});

test("solveTargets composes two coupled point demands in one assembled system", () => {
    const { draft, b, counts } = bakeHill();
    const arc = sampleArc(b);
    // 1.5g on the approach (node 2), 0.4g on the descent (node 4); their scopes
    // share the crest nodes (the coupled case).
    const t0 = pointAtNode(b, arc, 2, 1.5);
    const t1 = pointAtNode(b, arc, 4, 0.4);
    const freed = Array.from(
        new Set([
            ...scopeForPoint(b, arc, arc[b.offsets[2]]),
            ...scopeForPoint(b, arc, arc[b.offsets[4]]),
        ]),
    ).sort((x, z) => x - z);

    const res = solveTargets(draft.nodes, freed, counts, draft.v0, [t0, t1]);
    const bs = bakeNodes(res.nodes, counts, draft.v0);
    expect(pointResidual(bs, t0).err).toBeLessThan(BUDGET_G);
    expect(pointResidual(bs, t1).err).toBeLessThan(BUDGET_G);
});

test("DEFAULT_WEIGHTS keeps the draft prior weak (does not bias a point demand)", () => {
    // the prior at w≈0.1 should not pull the achieved force off a satisfiable
    // target. hold 0g at the crest with the default weights.
    const { draft, b, counts } = bakeHill();
    const arc = sampleArc(b);
    const target = pointAtNode(b, arc, 3, 0);
    const freed = scopeForPoint(b, arc, arc[b.offsets[3]]);
    const res = solveTargets(draft.nodes, freed, counts, draft.v0, [target], DEFAULT_WEIGHTS);
    const { achieved } = pointResidual(bakeNodes(res.nodes, counts, draft.v0), target);
    expect(Math.abs(achieved)).toBeLessThan(BUDGET_G);
});
