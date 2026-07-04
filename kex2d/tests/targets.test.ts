import { State } from "@dylanebert/shallot";
import { expect, test } from "bun:test";
import { createHistory, redo, undo } from "../src/history";
import { bakeNodes, sampleArc, samplesForArc, spanResidual } from "../src/solve";
import { chainCounts } from "../src/spline";
import {
    createTarget,
    deleteTarget,
    demandTarget,
    resolveTarget,
    Target,
    targetAt,
    targetDrift,
    targetsFor,
    solveTrack,
} from "../src/targets";
import {
    addNode,
    createTrack,
    Handle,
    handleAt,
    MAX_SAMPLES,
    sortedHandles,
    V0,
} from "../src/track";

// the stage-1 airtime hill, scaled to the track's V0. the 0g-airtime crest has
// radius v²/g, so a fixed shape stays representable only at the v0 it was
// designed for; scaling all positions by (V0/22)² scales v² (=v0²−2g·y) by the
// same factor, so the 0g radius and the hill's breadth scale together and the
// crest stays a representable airtime shape (the stage-1 hillDraft is tuned at
// v0=22; at V0=10 its y=11 crest is otherwise infeasible). built through the
// exact `addNode` authoring walk; crest at node 3.
function ecsHill(): { state: State; track: number; crest: number } {
    const s = (V0 / 22) ** 2;
    const state = new State();
    const track = createTrack(state);
    for (const [x, y] of [
        [0, 0],
        [20, 0],
        [38, 7],
        [56, 11],
        [74, 7],
        [92, 0],
        [112, 0],
    ] as const)
        addNode(state, x * s, y * s);
    return { state, track, crest: 3 };
}

/** the node arclength (m) of each node order — spans are authored in arclength. */
function nodeArc(state: State): number[] {
    const nodes = sortedHandles(state).map((eid) => ({
        x: Handle.pos.x.get(eid),
        y: Handle.pos.y.get(eid),
        theta: Handle.theta.get(eid),
    }));
    const { counts } = chainCounts(nodes, 0.5, MAX_SAMPLES);
    const b = bakeNodes(nodes, counts, V0);
    const arc = sampleArc(b);
    return b.offsets.map((o) => arc[o]);
}

function poses(state: State) {
    return sortedHandles(state).map((eid) => ({
        order: Handle.order.get(eid),
        x: Handle.pos.x.get(eid),
        y: Handle.pos.y.get(eid),
        theta: Handle.theta.get(eid),
    }));
}

const BUDGET_G = 0.04;

test("createTarget is born at the span mean and records one undoable entry", () => {
    const { state, track } = ecsHill();
    const h = createHistory();
    const arc = nodeArc(state);

    const id = createTarget(h, state, track, arc[2], arc[4]);
    expect(id).toBeGreaterThanOrEqual(0);
    expect(h.undo.length).toBe(1);

    const rows = targetsFor(state, track);
    expect(rows.length).toBe(1);
    // g is the current mean force over the span (born value).
    const nodes = sortedHandles(state).map((e) => ({
        x: Handle.pos.x.get(e),
        y: Handle.pos.y.get(e),
        theta: Handle.theta.get(e),
    }));
    const { counts } = chainCounts(nodes, 0.5, MAX_SAMPLES);
    const b = bakeNodes(nodes, counts, V0);
    const a = sampleArc(b);
    const { i0, i1 } = samplesForArc(b, a, arc[2], arc[4]);
    let sum = 0;
    let cnt = 0;
    for (let i = i0; i <= i1; i++) {
        sum += b.fN[i];
        cnt++;
    }
    expect(rows[0].g).toBeCloseTo(sum / cnt, 4);

    undo(h);
    expect(targetsFor(state, track).length).toBe(0);
    redo(h);
    const back = targetsFor(state, track);
    expect(back.length).toBe(1);
    expect(back[0].id).toBe(id); // same stable id, span, value verbatim
    expect(back[0].s0).toBe(rows[0].s0);
    expect(back[0].g).toBe(rows[0].g);
});

test("a target born on a flat span reads satisfied (band-vs-curve gap is quiet)", () => {
    const { state, track } = ecsHill();
    const h = createHistory();
    const arc = nodeArc(state);
    // a span strictly inside the horizontal lead segment [n0,n1] — F_n ≈ 1
    // constant there, so a band born at the mean holds within tolerance.
    const lead = arc[1] - arc[0];
    const id = createTarget(h, state, track, arc[0] + 0.2 * lead, arc[0] + 0.8 * lead);
    const drift = targetDrift(state, track).find((d) => d.id === id);
    expect(drift).toBeDefined();
    expect(drift?.satisfied).toBe(true);
    expect(drift?.err).toBeLessThan(BUDGET_G);
});

test("solveTrack is a pure read — it never writes authored state", () => {
    const { state, track } = ecsHill();
    const h = createHistory();
    const arc = nodeArc(state);
    createTarget(h, state, track, arc[2], arc[4]);
    // demand a reshape target value directly on the entity (no commit), then
    // solveTrack: the returned chain differs but the live Handles are untouched.
    const id = targetsFor(state, track)[0].id;
    Target.g.set(targetAt(state, id) as number, 0);
    const before = poses(state);
    const solved = solveTrack(state, track);
    expect(solved).not.toBeNull();
    expect(poses(state)).toEqual(before); // no live write
    // the solved chain actually moved the crest (it is a real solution).
    expect(solved?.nodes[3].y).not.toBe(before[3].y);
});

test("demandTarget holds 0g over the crest and undo restores node state byte-identical", () => {
    const { state, track, crest } = ecsHill();
    const h = createHistory();
    const arc = nodeArc(state);
    const id = createTarget(h, state, track, arc[2], arc[4]);
    const before = poses(state);

    demandTarget(h, state, track, id, 0);
    expect(h.undo.length).toBe(2); // create + demand, one entry each

    // the target value updated and the crest reshaped.
    expect(targetsFor(state, track)[0].g).toBe(0);
    expect(poses(state)[crest].y).not.toBe(before[crest].y);

    // achieved ~0g over the span interior, feasible + finite.
    const nodes = sortedHandles(state).map((e) => ({
        x: Handle.pos.x.get(e),
        y: Handle.pos.y.get(e),
        theta: Handle.theta.get(e),
    }));
    const { counts } = chainCounts(nodes, 0.5, MAX_SAMPLES);
    const b = bakeNodes(nodes, counts, V0);
    const a = sampleArc(b);
    const { i0, i1 } = samplesForArc(b, a, arc[2], arc[4]);
    const { achieved } = spanResidual(b, { i0, i1, g: 0, w: 1 });
    expect(Math.abs(achieved)).toBeLessThan(BUDGET_G);
    for (let i = 0; i < b.n; i++) expect(b.v2[i]).toBeGreaterThan(0);

    const after = poses(state);
    undo(h); // undo the demand
    expect(poses(state)).toEqual(before); // node state restored byte-identical
    expect(targetsFor(state, track)[0].g).toBe(targetsFor(state, track)[0].g); // g back
    redo(h);
    expect(poses(state)).toEqual(after); // replays to the solved pose
    expect(targetsFor(state, track)[0].g).toBe(0);
});

test("resolveTarget pulls a drifted curve back onto its band as one node-only entry", () => {
    const { state, track } = ecsHill();
    const h = createHistory();
    const arc = nodeArc(state);
    const id = createTarget(h, state, track, arc[2], arc[4]);
    demandTarget(h, state, track, id, 0);
    const solvedErr = driftErr(state, track, id);
    expect(solvedErr).toBeLessThan(BUDGET_G);

    // a later geometry edit shoves the crest off the band (drift).
    const crestEid = handleAt(state, 3) as number;
    Handle.pos.set(crestEid, Handle.pos.x.get(crestEid), Handle.pos.y.get(crestEid) + 1.2);
    const drifted = driftErr(state, track, id);
    expect(drifted).toBeGreaterThan(BUDGET_G); // the gap opened
    expect(targetDrift(state, track).find((d) => d.id === id)?.satisfied).toBe(false);

    const nUndo = h.undo.length;
    resolveTarget(h, state, track);
    expect(h.undo.length).toBe(nUndo + 1); // one entry
    expect(targetsFor(state, track)[0].g).toBe(0); // no target change
    expect(driftErr(state, track, id)).toBeLessThan(BUDGET_G); // back on band
});

test("deleteTarget leaves geometry untouched and is undoable", () => {
    const { state, track } = ecsHill();
    const h = createHistory();
    const arc = nodeArc(state);
    const id = createTarget(h, state, track, arc[2], arc[4]);
    demandTarget(h, state, track, id, 0.2);
    const geom = poses(state);

    deleteTarget(h, state, id);
    expect(targetsFor(state, track).length).toBe(0);
    expect(poses(state)).toEqual(geom); // geometry untouched

    undo(h);
    const back = targetsFor(state, track);
    expect(back.length).toBe(1);
    expect(back[0].id).toBe(id);
    expect(back[0].g).toBe(0.2); // restored verbatim
});

test("target ids are never reused across a delete→undo (monotone allocator)", () => {
    const { state, track } = ecsHill();
    const h = createHistory();
    const arc = nodeArc(state);
    const a = createTarget(h, state, track, arc[1], arc[2]);
    deleteTarget(h, state, a);
    const b = createTarget(h, state, track, arc[4], arc[5]);
    expect(b).toBeGreaterThan(a); // fresh id, not the freed one
});

test("solveTrack assembles two coupled targets in one system", () => {
    const { state, track } = ecsHill();
    const h = createHistory();
    const arc = nodeArc(state);
    const t0 = createTarget(h, state, track, arc[1], arc[2]);
    const t1 = createTarget(h, state, track, arc[4], arc[5]);
    demandTarget(h, state, track, t0, 1.3);
    // demand the second with the first already committed; the solve assembles
    // both active targets over the scope union.
    demandTarget(h, state, track, t1, 0.5);
    const d = targetDrift(state, track);
    expect(d.find((x) => x.id === t0)?.err).toBeLessThan(0.15);
    expect(d.find((x) => x.id === t1)?.err).toBeLessThan(0.15);
});

/** the drift gap (max interior |F−g|) for a target, on current geometry. */
function driftErr(state: State, track: number, id: number): number {
    return targetDrift(state, track).find((d) => d.id === id)?.err ?? Number.POSITIVE_INFINITY;
}
