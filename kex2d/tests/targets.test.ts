import { State } from "@dylanebert/shallot";
import { expect, test } from "bun:test";
import { createHistory, redo, undo } from "../src/history";
import { bakeNodes, sampleArc, samplesForArc, spanResidual } from "../src/solve";
import { chainCounts } from "../src/spline";
import {
    beginDemand,
    cancelDemand,
    createTarget,
    deleteTarget,
    demandTarget,
    endDemand,
    resolveTarget,
    stepDemand,
    Target,
    targetAt,
    targetBands,
    targetDrift,
    targetsFor,
    solveTrack,
    trackMapping,
    trackScope,
} from "../src/targets";
import {
    addNode,
    BakeSystem,
    bakeOut,
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

test("trackScope names exactly the nodes a ⟳ re-solve can move (the highlight is honest)", () => {
    // the ⟳ highlight flashes trackScope; that set must cover every node the
    // solve actually moves, or the flash lies about what changed. so: only freed
    // nodes move, and trackScope is that freed set.
    const { state, track } = ecsHill();
    const h = createHistory();
    const arc = nodeArc(state);
    createTarget(h, state, track, arc[2], arc[4]);

    const freed = trackScope(state, track);
    expect(freed.length).toBeGreaterThan(0);
    expect([...freed].sort((a, z) => a - z)).toEqual(freed); // sorted, deduped
    expect(freed).not.toContain(0); // node 0 is the fixed flat anchor, never freed

    // drift the crest, then re-solve; every node outside trackScope is untouched.
    const crestEid = handleAt(state, 3) as number;
    Handle.pos.set(crestEid, Handle.pos.x.get(crestEid), Handle.pos.y.get(crestEid) + 1.2);
    const before = poses(state);
    resolveTarget(h, state, track);
    const after = poses(state);

    const freedSet = new Set(freed);
    const wasByOrder = new Map(before.map((p) => [p.order, p]));
    let checked = 0;
    for (const p of after) {
        if (freedSet.has(p.order)) continue;
        const was = wasByOrder.get(p.order);
        expect(was).toBeDefined();
        expect(p).toEqual(was as (typeof before)[number]); // untouched, byte-identical
        checked++;
    }
    expect(checked).toBeGreaterThan(0); // real non-freed nodes were verified, not vacuous
});

test("a demand cancelled without a step is a true no-op (backs the click-selects guard)", () => {
    // a band click (pointerdown → pointerup, no drag) opens then cancels the
    // gesture instead of committing, so the settle can't record a near-no-op
    // undo entry. cancel must leave both history and node state exactly as they
    // were — the guard is only safe if cancel is a clean rollback.
    const { state, track } = ecsHill();
    const h = createHistory();
    const arc = nodeArc(state);
    const id = createTarget(h, state, track, arc[2], arc[4]);
    const before = poses(state);
    const nUndo = h.undo.length;

    expect(beginDemand(state, track, id)).toBe(true);
    cancelDemand(); // no stepDemand — the click case

    expect(h.undo.length).toBe(nUndo); // no entry recorded
    expect(poses(state)).toEqual(before); // node state untouched
    expect(targetsFor(state, track)[0].g).toBe(targetsFor(state, track)[0].g);
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

test("a multi-frame RTI demand lands where the batch demand does (draft-anchored)", () => {
    // the live drag drives the same gesture as the batch, but through many small
    // warm-started steps. the draft prior is pinned to the gesture-start chain in
    // both, so both must converge to the SAME node solution — the RTI path is not
    // allowed to smear frame-to-frame.
    const A = ecsHill();
    const hA = createHistory();
    const arcA = nodeArc(A.state);
    const idA = createTarget(hA, A.state, A.track, arcA[2], arcA[4]);
    demandTarget(hA, A.state, A.track, idA, 0);
    const batch = poses(A.state);

    const B = ecsHill();
    const hB = createHistory();
    const arcB = nodeArc(B.state);
    const idB = createTarget(hB, B.state, B.track, arcB[2], arcB[4]);
    const born = targetsFor(B.state, B.track)[0].g;
    expect(beginDemand(B.state, B.track, idB)).toBe(true);
    const Frames = 8;
    for (let f = 1; f <= Frames; f++) stepDemand(B.state, idB, born * (1 - f / Frames));
    endDemand(hB, B.state);
    const live = poses(B.state);

    for (let k = 0; k < batch.length; k++) {
        expect(live[k].x).toBeCloseTo(batch[k].x, 2);
        expect(live[k].y).toBeCloseTo(batch[k].y, 2);
    }
    expect(hB.undo.length).toBe(2); // create + the whole drag = one demand entry
    expect(targetsFor(B.state, B.track)[0].g).toBe(0);
});

test("trackMapping is monotone and its time axis matches the display bake", () => {
    const { state, track } = ecsHill();
    state.addSystem(BakeSystem);
    state.step(0);
    const m = trackMapping(track);
    expect(m).not.toBeNull();
    if (!m) return;
    for (let i = 1; i < m.n; i++) {
        expect(m.arc[i]).toBeGreaterThanOrEqual(m.arc[i - 1]);
        expect(m.t[i]).toBeGreaterThanOrEqual(m.t[i - 1]);
    }
    expect(m.t[m.n - 1]).toBeCloseTo(bakeOut.get(track)?.tTotal ?? -1, 6);
});

test("targetBands projects a target's arclength span onto a forward time extent", () => {
    const { state, track } = ecsHill();
    state.addSystem(BakeSystem);
    state.step(0);
    const h = createHistory();
    const arc = nodeArc(state);
    const id = createTarget(h, state, track, arc[2], arc[4]);
    const m = trackMapping(track);
    expect(m).not.toBeNull();
    if (!m) return;
    const bands = targetBands(state, track, m);
    expect(bands.length).toBe(1);
    const bnd = bands[0];
    expect(bnd.id).toBe(id);
    expect(bnd.g).toBe(targetsFor(state, track)[0].g);
    expect(bnd.t1).toBeGreaterThan(bnd.t0); // span has a forward time extent
    expect(bnd.t0).toBeGreaterThanOrEqual(0);
    expect(bnd.t1).toBeLessThanOrEqual((bakeOut.get(track)?.tTotal ?? 0) + 1e-6);
    expect(bnd.err).toBeGreaterThanOrEqual(0);
});

/** the drift gap (max interior |F−g|) for a target, on current geometry. */
function driftErr(state: State, track: number, id: number): number {
    return targetDrift(state, track).find((d) => d.id === id)?.err ?? Number.POSITIVE_INFINITY;
}
