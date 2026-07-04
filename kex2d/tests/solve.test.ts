import { expect, test } from "bun:test";
import { forces64 } from "../src/force";
import {
    type Baked,
    bakeNodes,
    DEFAULT_WEIGHTS,
    sampleArc,
    sampleAtArc,
    scopeForArc,
    solveTargets,
    spanMean,
    spanResidual,
    samplesForArc,
    type SpanTarget,
} from "../src/solve";
import { chainCounts, type Node } from "../src/spline";
import { hillDraft } from "./helpers/hill";

const DS = 0.5;
const MAX = 4096;

/** the stage-1 evidence gate (spec live log) measured the trimmed-interior
 *  error over the auto-scope crest span at fInt ≈ 0.034 g — the ~0.03 g (≈2 px
 *  on the ~260 px timeline chart over a ~4 g fit) display budget it was accepted
 *  as reaching, and a denser control net goes to ~0.016 (well under). this pins
 *  the promoted solver reproduces that result; the bound carries numeric
 *  headroom over the measured value. */
const INTERIOR_BUDGET = 0.04;

function bakeHill(): { draft: ReturnType<typeof hillDraft>; b: Baked; counts: number[] } {
    const draft = hillDraft();
    const { counts } = chainCounts(draft.nodes, DS, MAX);
    return { draft, b: bakeNodes(draft.nodes, counts, draft.v0), counts };
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

test("scopeForArc frees the segments-overlapping nodes plus one neighbor each side", () => {
    const { b } = bakeHill();
    const arc = sampleArc(b);
    // an arclength span straddling the crest (node 3). its segments are [2,3] and
    // [3,4]; scope widens one neighbor each side → [1..5], excluding the anchor.
    const s0 = arc[b.offsets[3]] - 8;
    const s1 = arc[b.offsets[3]] + 8;
    expect(scopeForArc(b, arc, s0, s1)).toEqual([1, 2, 3, 4, 5]);
    // the anchor (node 0) is never freed even when the span reaches the start.
    const scope = scopeForArc(b, arc, 0, arc[b.offsets[2]]);
    expect(scope).not.toContain(0);
    expect(scope[0]).toBeGreaterThanOrEqual(1);
});

test("spanMean is the born-satisfied value: a target at it has zero initial error", () => {
    const { b } = bakeHill();
    const arc = sampleArc(b);
    const { i0, i1 } = samplesForArc(b, arc, arc[b.offsets[2]], arc[b.offsets[4]]);
    const g = spanMean(b, i0, i1);
    // "born satisfied" = zero initial *loss*: g is the least-squares constant, so
    // the signed mean deviation over the span vanishes (max error over a varying
    // span stays ~1 g — that is not the invariant).
    let dev = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = i0; i <= i1; i++) {
        dev += b.fN[i] - g;
        lo = Math.min(lo, b.fN[i]);
        hi = Math.max(hi, b.fN[i]);
    }
    expect(Math.abs(dev) / (i1 - i0 + 1)).toBeLessThan(1e-9);
    // and the value sits within the actual force range over the span.
    expect(g).toBeGreaterThanOrEqual(lo - 1e-9);
    expect(g).toBeLessThanOrEqual(hi + 1e-9);
});

test("solveTargets holds 0g over the crest span within the display budget (auto-scope)", () => {
    const { draft, b, counts } = bakeHill();
    const arc = sampleArc(b);
    const s0 = arc[b.offsets[2]];
    const s1 = arc[b.offsets[4]];
    const { i0, i1 } = samplesForArc(b, arc, s0, s1);
    const freed = scopeForArc(b, arc, s0, s1);
    expect(freed).toEqual([1, 2, 3, 4, 5]);

    const target: SpanTarget = { i0, i1, g: 0, w: 1 };
    const res = solveTargets(draft.nodes, freed, counts, draft.v0, [target]);
    expect(res.iters).toBeLessThanOrEqual(120);

    const bs = bakeNodes(res.nodes, counts, draft.v0);
    const { err } = spanResidual(bs, target);
    expect(err).toBeLessThan(INTERIOR_BUDGET);
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
    const s0 = arc[b.offsets[2]];
    const s1 = arc[b.offsets[4]];
    const { i0, i1 } = samplesForArc(b, arc, s0, s1);
    const freed = scopeForArc(b, arc, s0, s1);
    const before: Node[] = draft.nodes.map((n) => ({ ...n }));

    const res = solveTargets(draft.nodes, freed, counts, draft.v0, [{ i0, i1, g: 0, w: 1 }]);

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

test("solveTargets composes two coupled targets in one assembled system", () => {
    const { draft, b, counts } = bakeHill();
    const arc = sampleArc(b);
    // 1.5g on the approach [n1,n2], 0.4g on the descent [n4,n5]; their scopes
    // share the crest nodes (the coupled case).
    const a = samplesForArc(b, arc, arc[b.offsets[1]], arc[b.offsets[2]]);
    const d = samplesForArc(b, arc, arc[b.offsets[4]], arc[b.offsets[5]]);
    const t0: SpanTarget = { i0: a.i0, i1: a.i1, g: 1.5, w: 1 };
    const t1: SpanTarget = { i0: d.i0, i1: d.i1, g: 0.4, w: 1 };
    const freed = Array.from(
        new Set([
            ...scopeForArc(b, arc, arc[b.offsets[1]], arc[b.offsets[2]]),
            ...scopeForArc(b, arc, arc[b.offsets[4]], arc[b.offsets[5]]),
        ]),
    ).sort((x, z) => x - z);

    const res = solveTargets(draft.nodes, freed, counts, draft.v0, [t0, t1]);
    const bs = bakeNodes(res.nodes, counts, draft.v0);
    expect(spanResidual(bs, t0).err).toBeLessThan(INTERIOR_BUDGET);
    expect(spanResidual(bs, t1).err).toBeLessThan(INTERIOR_BUDGET);
});

test("warm start changes only the iterate, not the minimum (base anchors the prior)", () => {
    // RTI correctness: `warm` seeds the starting point but `base` defines the
    // prior anchor + spacing reference, so a warm solve from a chain nudged off
    // the draft must land on the SAME minimum as a cold solve from the draft —
    // else the live drag would smear path-dependently frame to frame.
    const { draft, b, counts } = bakeHill();
    const arc = sampleArc(b);
    const { i0, i1 } = samplesForArc(b, arc, arc[b.offsets[2]], arc[b.offsets[4]]);
    const freed = scopeForArc(b, arc, arc[b.offsets[2]], arc[b.offsets[4]]);
    const target: SpanTarget = { i0, i1, g: 0, w: 1 };

    const cold = solveTargets(draft.nodes, freed, counts, draft.v0, [target]);
    const nudged = draft.nodes.map((n, k) => (freed.includes(k) ? { ...n, y: n.y + 2 } : { ...n }));
    const hot = solveTargets(
        draft.nodes,
        freed,
        counts,
        draft.v0,
        [target],
        DEFAULT_WEIGHTS,
        120,
        1e-7,
        nudged,
    );
    for (let k = 0; k < cold.nodes.length; k++) {
        expect(hot.nodes[k].x).toBeCloseTo(cold.nodes[k].x, 3);
        expect(hot.nodes[k].y).toBeCloseTo(cold.nodes[k].y, 3);
    }
});

test("DEFAULT_WEIGHTS keeps the draft prior weak (does not bias a point demand)", () => {
    // the prior at w≈0.1 should not pull the achieved force off a satisfiable
    // target. hold 0g over a short span with the default weights.
    const { draft, b, counts } = bakeHill();
    const arc = sampleArc(b);
    const { i0, i1 } = samplesForArc(b, arc, arc[b.offsets[2]], arc[b.offsets[4]]);
    const freed = scopeForArc(b, arc, arc[b.offsets[2]], arc[b.offsets[4]]);
    const res = solveTargets(
        draft.nodes,
        freed,
        counts,
        draft.v0,
        [{ i0, i1, g: 0, w: 1 }],
        DEFAULT_WEIGHTS,
    );
    const { achieved } = spanResidual(bakeNodes(res.nodes, counts, draft.v0), {
        i0,
        i1,
        g: 0,
        w: 1,
    });
    expect(Math.abs(achieved)).toBeLessThan(INTERIOR_BUDGET);
});
