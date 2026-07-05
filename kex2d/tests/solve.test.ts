import { expect, test } from "bun:test";
import { forces64 } from "../src/force";
import {
    type Baked,
    bakeNodes,
    DEFAULT_WEIGHTS,
    fixpointSession,
    type PointTarget,
    pointResidual,
    sampleArc,
    sampleAtArc,
    scopeForPoint,
    solveTargets,
    solveToFixpoint,
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

/** drift at an authored ARCLENGTH on a fresh re-bake of `nodes` — the readout
 *  the author sees after a solve commits (re-frozen grid, s re-mapped), distinct
 *  from the frozen-grid residual a single LM pass drives to zero. */
function driftAtArc(nodes: Node[], s: number, g: number, v0: number): number {
    const c = chainCounts(nodes, DS, MAX).counts;
    const b = bakeNodes(nodes, c, v0);
    const arc = sampleArc(b);
    return Math.abs(b.fN[sampleAtArc(arc, b.n, s)] - g);
}

test("solveToFixpoint reaches the fixpoint a single frozen-grid pass regresses past", () => {
    // the §3 mechanism: one LM pass converges essentially exactly on its frozen
    // grid, but the moved nodes redistribute arclength under that grid, so the
    // frozen index no longer sits at the authored s — re-baking reads a LARGE
    // drift there (the measured 0.60 g regression, worse than the 0.34 g start).
    // the outer loop re-freezes the grid until the drift at s itself is closed.
    const { draft, b, counts } = bakeHill();
    const arc = sampleArc(b);
    const sCrest = arc[b.offsets[3]];
    const freed = scopeForPoint(b, arc, sCrest);

    const single = solveTargets(draft.nodes, freed, counts, draft.v0, [
        pointAtNode(b, arc, 3, 0),
    ]).nodes;
    // the single pass regresses the re-baked drift at s (pins the 0.60 g defect).
    expect(driftAtArc(single, sCrest, 0, draft.v0)).toBeGreaterThan(
        driftAtArc(draft.nodes, sCrest, 0, draft.v0),
    );

    const fp = solveToFixpoint(draft.nodes, freed, DS, draft.v0, [{ s: sCrest, g: 0, w: 1 }]);
    expect(fp.converged).toBe(true);
    expect(fp.rounds).toBeGreaterThan(1); // one pass was not enough; the loop iterated
    expect(driftAtArc(fp.nodes, sCrest, 0, draft.v0)).toBeLessThan(BUDGET_G);
    expect(fp.maxDrift).toBeCloseTo(driftAtArc(fp.nodes, sCrest, 0, draft.v0), 6);
    // feasible throughout.
    const bs = bakeNodes(fp.nodes, chainCounts(fp.nodes, DS, MAX).counts, draft.v0);
    for (let i = 0; i < bs.n; i++) expect(bs.v2[i]).toBeGreaterThan(0);
});

test("solveToFixpoint is idempotent — re-solving a converged chain is a byte-identical no-op", () => {
    const { draft, b } = bakeHill();
    const arc = sampleArc(b);
    const sCrest = arc[b.offsets[3]];
    const freed = scopeForPoint(b, arc, sCrest);
    const demand = [{ s: sCrest, g: 0, w: 1 }];

    const fp = solveToFixpoint(draft.nodes, freed, DS, draft.v0, demand);
    const again = solveToFixpoint(fp.nodes, freed, DS, draft.v0, demand);
    expect(again.rounds).toBe(0); // already within tol — the loop body never runs
    again.nodes.forEach((n, k) => {
        expect(n.x).toBe(fp.nodes[k].x);
        expect(n.y).toBe(fp.nodes[k].y);
        expect(n.theta).toBe(fp.nodes[k].theta);
    });
});

test("solveToFixpoint keeps the best iterate and stays finite on an infeasible demand", () => {
    // two demands at one spot no single sample can hold together (0g and 2g):
    // the loop can't reach tol, so it returns the min-drift iterate, finite.
    const { draft, b } = bakeHill();
    const arc = sampleArc(b);
    const sCrest = arc[b.offsets[3]];
    const freed = scopeForPoint(b, arc, sCrest);
    const fp = solveToFixpoint(draft.nodes, freed, DS, draft.v0, [
        { s: sCrest, g: 0, w: 1 },
        { s: sCrest, g: 2, w: 1 },
    ]);
    expect(fp.converged).toBe(false); // legibly unmet, not silently "done"
    expect(Number.isFinite(fp.maxDrift)).toBe(true);
    const bs = bakeNodes(fp.nodes, chainCounts(fp.nodes, DS, MAX).counts, draft.v0);
    for (let i = 0; i < bs.n; i++) expect(Number.isFinite(bs.fN[i])).toBe(true);
});

test("fixpointSession stepped by hand matches solveToFixpoint byte-identical (§8 one source of truth)", () => {
    // the animated driver advances the session frame by frame; the tests + every
    // non-animated caller drain it synchronously. both must reach the same chain
    // to the bit — the drain IS the stepped session run to completion.
    const { draft, b } = bakeHill();
    const arc = sampleArc(b);
    const sCrest = arc[b.offsets[3]];
    const freed = scopeForPoint(b, arc, sCrest);
    const demand = [{ s: sCrest, g: 0, w: 1 }];

    const gen = fixpointSession(draft.nodes, freed, DS, draft.v0, demand);
    let step = gen.next();
    let yields = 0;
    let last: Node[] | null = null;
    while (!step.done) {
        // every yielded value is a full valid chain (the animated iterate).
        expect(step.value.length).toBe(draft.nodes.length);
        last = step.value;
        yields++;
        step = gen.next();
    }
    expect(yields).toBeGreaterThan(0); // it actually animated intermediate iterates
    expect(last).not.toBeNull();

    const drained = solveToFixpoint(draft.nodes, freed, DS, draft.v0, demand);
    step.value.nodes.forEach((n, k) => {
        expect(n.x).toBe(drained.nodes[k].x);
        expect(n.y).toBe(drained.nodes[k].y);
        expect(n.theta).toBe(drained.nodes[k].theta);
    });
    expect(step.value.rounds).toBe(drained.rounds);
    expect(step.value.maxDrift).toBe(drained.maxDrift);
    expect(step.value.converged).toBe(drained.converged);
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
