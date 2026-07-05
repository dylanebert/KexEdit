import { State } from "@dylanebert/shallot";
import { expect, test } from "bun:test";
import { cancel, commit, createHistory, redo, undo } from "../src/history";
import { bakeNodes, pointResidual, sampleArc, sampleAtArc } from "../src/solve";
import { chainCounts } from "../src/spline";
import {
    beginTargetMove,
    createTarget,
    deleteTarget,
    setTarget,
    setTargetActive,
    solveAll,
    solveTrack,
    Target,
    targetAt,
    targetDrift,
    targetMarkers,
    targetsFor,
    trackDirty,
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

/** the node arclength (m) of each node order — points are authored in arclength. */
function nodeArc(state: State): number[] {
    const b = bake(state);
    const arc = sampleArc(b);
    return b.offsets.map((o) => arc[o]);
}

/** the current chain's frozen f64 bake (the drift/assert reference). */
function bake(state: State) {
    const nodes = sortedHandles(state).map((eid) => ({
        x: Handle.pos.x.get(eid),
        y: Handle.pos.y.get(eid),
        theta: Handle.theta.get(eid),
    }));
    const { counts } = chainCounts(nodes, 0.5, MAX_SAMPLES);
    return bakeNodes(nodes, counts, V0);
}

function poses(state: State) {
    return sortedHandles(state).map((eid) => ({
        order: Handle.order.get(eid),
        x: Handle.pos.x.get(eid),
        y: Handle.pos.y.get(eid),
        theta: Handle.theta.get(eid),
    }));
}

/** the drift gap (|achieved − g|) for a target, on current geometry. */
function driftErr(state: State, track: number, id: number): number {
    return targetDrift(state, track).find((d) => d.id === id)?.err ?? Number.POSITIVE_INFINITY;
}

const BUDGET_G = 0.04;

test("createTarget is born at exactly the clicked demand and records one undoable entry", () => {
    const { state, track } = ecsHill();
    const h = createHistory();
    const arc = nodeArc(state);

    const id = createTarget(h, state, track, arc[3], 0);
    expect(id).toBeGreaterThanOrEqual(0);
    expect(h.undo.length).toBe(1);

    const rows = targetsFor(state, track);
    expect(rows.length).toBe(1);
    expect(rows[0].g).toBe(0); // the click IS the demand — no born-satisfied fit
    expect(rows[0].s).toBeCloseTo(arc[3], 4);

    undo(h);
    expect(targetsFor(state, track).length).toBe(0);
    redo(h);
    const back = targetsFor(state, track);
    expect(back.length).toBe(1);
    expect(back[0].id).toBe(id); // same stable id, point, value verbatim
    expect(back[0].s).toBe(rows[0].s);
    expect(back[0].g).toBe(rows[0].g);
});

test("a target placed on the curve reads satisfied; a demand off it reads drifted", () => {
    const { state, track } = ecsHill();
    const h = createHistory();
    const arc = nodeArc(state);
    // on the flat lead segment F_n ≈ 1: a 1g point there sits on the curve.
    const on = createTarget(h, state, track, (arc[0] + arc[1]) / 2, 1);
    // a 0g demand at the crest opens a visible gap until solved.
    const off = createTarget(h, state, track, arc[3], 0);
    const drift = targetDrift(state, track);
    expect(drift.find((d) => d.id === on)?.satisfied).toBe(true);
    expect(drift.find((d) => d.id === off)?.satisfied).toBe(false);
    expect(drift.find((d) => d.id === off)?.err).toBeGreaterThan(BUDGET_G);
});

test("solveTrack is a pure read — it never writes authored state", () => {
    const { state, track } = ecsHill();
    const h = createHistory();
    const arc = nodeArc(state);
    createTarget(h, state, track, arc[3], 0);
    const before = poses(state);
    const solved = solveTrack(state, track);
    expect(solved).not.toBeNull();
    expect(poses(state)).toEqual(before); // no live write
    // the solved chain actually moved the crest (it is a real solution).
    expect(solved?.nodes[3].y).not.toBe(before[3].y);
});

test("solveAll holds 0g at the crest and undo restores node state byte-identical", () => {
    const { state, track, crest } = ecsHill();
    const h = createHistory();
    const arc = nodeArc(state);
    const id = createTarget(h, state, track, arc[3], 0);
    const before = poses(state);

    const solved = solveAll(h, state, track);
    expect(solved).not.toBeNull();
    expect(h.undo.length).toBe(2); // create + solve, one entry each

    // the crest reshaped and the demand is met on the re-baked geometry.
    expect(poses(state)[crest].y).not.toBe(before[crest].y);
    expect(targetsFor(state, track)[0].g).toBe(0); // targets untouched
    expect(driftErr(state, track, id)).toBeLessThan(BUDGET_G);
    const b = bake(state);
    for (let i = 0; i < b.n; i++) expect(b.v2[i]).toBeGreaterThan(0); // feasible

    const after = poses(state);
    undo(h); // undo the solve
    expect(poses(state)).toEqual(before); // node state restored byte-identical
    redo(h);
    expect(poses(state)).toEqual(after); // replays to the solved pose
});

test("a second solveAll is a geometry no-op (idempotent) and records no entry", () => {
    const { state, track, crest } = ecsHill();
    const h = createHistory();
    const arc = nodeArc(state);
    const id = createTarget(h, state, track, arc[crest], 0);
    solveAll(h, state, track);
    expect(driftErr(state, track, id)).toBeLessThan(BUDGET_G);
    const settled = poses(state);
    const nUndo = h.undo.length;

    // pressing Solve again on the converged chain moves nothing and records
    // nothing — the failure mode §3 kills is "press again for more effect".
    const again = solveAll(h, state, track);
    expect(again).not.toBeNull();
    expect(again?.converged).toBe(true);
    expect(h.undo.length).toBe(nUndo); // no new entry — the no-op commit dropped
    expect(poses(state)).toEqual(settled); // byte-identical geometry
});

test("solveAll pulls a drifted curve back onto its point as one node-only entry", () => {
    const { state, track } = ecsHill();
    const h = createHistory();
    const arc = nodeArc(state);
    const id = createTarget(h, state, track, arc[3], 0);
    solveAll(h, state, track);
    expect(driftErr(state, track, id)).toBeLessThan(BUDGET_G);

    // a later geometry edit shoves the crest off the point (drift).
    const crestEid = handleAt(state, 3) as number;
    Handle.pos.set(crestEid, Handle.pos.x.get(crestEid), Handle.pos.y.get(crestEid) + 1.2);
    expect(driftErr(state, track, id)).toBeGreaterThan(BUDGET_G); // the gap opened
    expect(targetDrift(state, track).find((d) => d.id === id)?.satisfied).toBe(false);

    const nUndo = h.undo.length;
    solveAll(h, state, track);
    expect(h.undo.length).toBe(nUndo + 1); // one entry
    expect(targetsFor(state, track)[0].g).toBe(0); // no target change
    expect(driftErr(state, track, id)).toBeLessThan(BUDGET_G); // back on the point
});

test("trackScope names exactly the nodes a solve can move (the flash is honest)", () => {
    // the Solve flash highlights trackScope; that set must cover every node the
    // solve actually moves, or the flash lies about what changed. so: only freed
    // nodes move, and trackScope is that freed set.
    const { state, track } = ecsHill();
    const h = createHistory();
    const arc = nodeArc(state);
    createTarget(h, state, track, arc[3], 0);

    const freed = trackScope(state, track);
    expect(freed.length).toBeGreaterThan(0);
    expect([...freed].sort((a, z) => a - z)).toEqual(freed); // sorted, deduped
    expect(freed).not.toContain(0); // node 0 is the fixed flat anchor, never freed

    const before = poses(state);
    solveAll(h, state, track);
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

test("a marker-move gesture commits one entry; a no-move click records nothing", () => {
    const { state, track } = ecsHill();
    const h = createHistory();
    const arc = nodeArc(state);
    const id = createTarget(h, state, track, arc[3], 0.5);
    const nUndo = h.undo.length;

    // a click with no movement: begin → commit drops the no-op entry.
    beginTargetMove(state, id);
    commit(h);
    expect(h.undo.length).toBe(nUndo);

    // a real drag: many live writes collapse to one entry; undo restores both axes.
    beginTargetMove(state, id);
    setTarget(state, id, arc[3] + 1, 0.3);
    setTarget(state, id, arc[3] + 2, 0.1);
    commit(h);
    expect(h.undo.length).toBe(nUndo + 1);
    let row = targetsFor(state, track)[0];
    expect(row.s).toBeCloseTo(arc[3] + 2, 4);
    expect(row.g).toBeCloseTo(0.1, 6);

    undo(h);
    row = targetsFor(state, track)[0];
    expect(row.s).toBeCloseTo(arc[3], 4);
    expect(row.g).toBe(0.5);

    // cancel rolls a drag back without recording.
    beginTargetMove(state, id);
    setTarget(state, id, arc[3] + 3, 2);
    cancel();
    expect(h.undo.length).toBe(nUndo); // the move undo was consumed above; no new entry
    row = targetsFor(state, track)[0];
    expect(row.s).toBeCloseTo(arc[3], 4);
    expect(row.g).toBe(0.5);
});

test("moving a target never moves geometry (targets are inert data)", () => {
    const { state, track } = ecsHill();
    const h = createHistory();
    const arc = nodeArc(state);
    const id = createTarget(h, state, track, arc[3], 0);
    const geom = poses(state);
    beginTargetMove(state, id);
    setTarget(state, id, arc[2], 1.8);
    commit(h);
    expect(poses(state)).toEqual(geom); // byte-identical — no solve ran
});

test("deleteTarget leaves geometry untouched and is undoable", () => {
    const { state, track } = ecsHill();
    const h = createHistory();
    const arc = nodeArc(state);
    const id = createTarget(h, state, track, arc[3], 0.2);
    solveAll(h, state, track);
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
    const a = createTarget(h, state, track, arc[1], 1);
    deleteTarget(h, state, a);
    const b = createTarget(h, state, track, arc[4], 1);
    expect(b).toBeGreaterThan(a); // fresh id, not the freed one
});

test("solveAll assembles two coupled point demands in one system", () => {
    const { state, track } = ecsHill();
    const h = createHistory();
    const arc = nodeArc(state);
    const t0 = createTarget(h, state, track, arc[2], 1.3);
    const t1 = createTarget(h, state, track, arc[4], 0.5);
    solveAll(h, state, track);
    expect(driftErr(state, track, t0)).toBeLessThan(BUDGET_G);
    expect(driftErr(state, track, t1)).toBeLessThan(BUDGET_G);
});

test("targets are born driving; a driven target moves no geometry but still measures", () => {
    const { state, track, crest } = ecsHill();
    const h = createHistory();
    const arc = nodeArc(state);
    // one demand that WOULD reshape the crest if it drove the solve.
    const id = createTarget(h, state, track, arc[crest], 0);
    expect(targetsFor(state, track)[0].active).toBe(true); // born driving
    expect(driftErr(state, track, id)).toBeGreaterThan(BUDGET_G); // off the curve

    // make it driven: it no longer drives the solve, so Solve is inert.
    setTargetActive(h, state, id, false);
    expect(targetsFor(state, track)[0].active).toBe(false);
    expect(trackScope(state, track)).toEqual([]); // nothing driven → nothing to free
    expect(trackDirty(state, track)).toBe(false); // driven drift never accents Solve

    const geom = poses(state);
    const solved = solveAll(h, state, track);
    expect(solved).toBeNull(); // no active targets — nothing solved
    expect(poses(state)).toEqual(geom); // geometry untouched

    // yet the driven target still measures its drift on the current curve.
    const d = targetDrift(state, track).find((x) => x.id === id);
    expect(d?.active).toBe(false);
    expect(d?.err).toBeGreaterThan(BUDGET_G); // reads the gap, just doesn't chase it
});

test("setTargetActive toggles one undoable entry and activation survives delete→undo", () => {
    const { state, track } = ecsHill();
    const h = createHistory();
    const arc = nodeArc(state);
    const id = createTarget(h, state, track, arc[3], 0);
    const nUndo = h.undo.length;

    setTargetActive(h, state, id, false);
    expect(h.undo.length).toBe(nUndo + 1); // one entry
    expect(targetsFor(state, track)[0].active).toBe(false);
    setTargetActive(h, state, id, false); // no-op toggle records nothing
    expect(h.undo.length).toBe(nUndo + 1);
    undo(h);
    expect(targetsFor(state, track)[0].active).toBe(true); // restored driving

    // a deactivated target restores driven, not driving, across delete→undo.
    setTargetActive(h, state, id, false);
    deleteTarget(h, state, id);
    undo(h); // undo the delete
    expect(targetsFor(state, track)[0].active).toBe(false); // verbatim activation
});

test("with a driving and a driven target, only the driving one drives the solve", () => {
    const { state, track } = ecsHill();
    const h = createHistory();
    const arc = nodeArc(state);
    const driving = createTarget(h, state, track, arc[2], 1.3);
    const driven = createTarget(h, state, track, arc[4], 0.5);
    setTargetActive(h, state, driven, false);

    const scope = trackScope(state, track);
    // the freed set covers the driving target's scope but not the driven one's.
    expect(scope.length).toBeGreaterThan(0);
    solveAll(h, state, track);
    expect(driftErr(state, track, driving)).toBeLessThan(BUDGET_G); // met
    // the driven target measured but its scope was not solved for — it keeps
    // whatever drift the driving reshape left it (still a legible readout).
    expect(Number.isFinite(driftErr(state, track, driven))).toBe(true);
});

test("an infeasible demand fails legibly: closest compromise, finite, drift shown", () => {
    const { state, track } = ecsHill();
    const h = createHistory();
    const arc = nodeArc(state);
    // two demands at the same spot that no geometry satisfies together (one
    // sample can hold one force): the solve lands the least-squares compromise
    // between them and both gaps stay readable.
    const lo = createTarget(h, state, track, arc[3], 0);
    const hi = createTarget(h, state, track, arc[3], 2);
    solveAll(h, state, track);
    const d = targetDrift(state, track);
    const dLo = d.find((x) => x.id === lo);
    const dHi = d.find((x) => x.id === hi);
    expect(Number.isFinite(dLo?.achieved ?? Number.NaN)).toBe(true);
    expect(dLo?.satisfied).toBe(false); // labeled achieved-vs-target,
    expect(dHi?.satisfied).toBe(false); // not silently "done"
    const b = bake(state);
    for (let i = 0; i < b.n; i++) expect(Number.isFinite(b.fN[i])).toBe(true);
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

test("targetMarkers exposes each target's demand and drift at its arclength", () => {
    const { state, track } = ecsHill();
    state.addSystem(BakeSystem);
    state.step(0);
    const h = createHistory();
    const arc = nodeArc(state);
    const id = createTarget(h, state, track, arc[3], 0);
    // the chart's x-axis IS arclength (§4), so the marker carries s directly — no
    // time projection, no mapping argument.
    const markers = targetMarkers(state, track);
    expect(markers.length).toBe(1);
    const mk = markers[0];
    expect(mk.id).toBe(id);
    expect(mk.g).toBe(0);
    expect(mk.s).toBeCloseTo(arc[3], 6);
    expect(mk.err).toBeGreaterThanOrEqual(0);
    // the drift readout matches a direct point residual on the same bake.
    const b = bake(state);
    const a = sampleArc(b);
    const direct = pointResidual(b, { i: sampleAtArc(a, b.n, mk.s), g: 0, w: 1 });
    expect(mk.achieved).toBeCloseTo(direct.achieved, 6);
});

test("Target rows expose exactly {track, id, s, g} (the point component shape)", () => {
    const { state, track } = ecsHill();
    const h = createHistory();
    const id = createTarget(h, state, track, 5, 1.5);
    const eid = targetAt(state, id);
    expect(eid).not.toBeNull();
    if (eid === null) return;
    expect(Target.track.get(eid)).toBe(track);
    expect(Target.id.get(eid)).toBe(id);
    expect(Target.s.get(eid)).toBeCloseTo(5, 5);
    expect(Target.g.get(eid)).toBeCloseTo(1.5, 5);
});
