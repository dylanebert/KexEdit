import { expect, test } from "bun:test";
import { State } from "@dylanebert/shallot";
import { OPT_GRID, SolveSystem, solveOut } from "../src/optimize";
import { DEFAULT_BAND } from "../src/solve";
import { addNode, BakeSystem, bakeOut, createTrack, Track } from "../src/track";

const G = 9.80665;
// SolveSystem solves the convex F_n optimizer on the draft-time grid, then rides
// the solved force to the realized track the cart follows. driven device-free
// via the scheduler (Bake then Solve, registration order), like track.test.ts.

/** a fresh flat track (anchor (−16,0) → node (16,0)), baked + solved. */
function solved(): number {
    const state = new State();
    state.addSystem(BakeSystem);
    state.addSystem(SolveSystem);
    const eid = createTrack(state);
    addNode(state, -16, 0);
    addNode(state, 16, 0);
    state.step(0);
    return eid;
}

test("a chain shorter than two nodes produces no solve output", () => {
    const state = new State();
    state.addSystem(BakeSystem);
    state.addSystem(SolveSystem);
    const eid = createTrack(state); // empty track, never bakes
    state.step(0);
    expect(solveOut.get(eid)).toBeUndefined();
});

test("the realized track of a flat draft rides flat, anchor to end", () => {
    // a flat draft is 1g everywhere: smoothing a constant leaves it constant and
    // 1g sits inside the band, so the solved force stays ≈ 1 and riding it
    // reproduces the flat line — the realized geometry coincides with the draft.
    // closed form: x spans the draft's 32 m arclength, y holds at 0.
    const eid = solved();
    const so = solveOut.get(eid);
    if (!so) throw new Error("solveOut missing after solve");

    expect(so.count).toBe(OPT_GRID);
    for (let i = 0; i < so.count; i++) expect(so.fN[i]).toBeCloseTo(1, 3);

    expect(so.posX[0]).toBeCloseTo(-16, 4); // launches at the anchor
    expect(so.posX[so.count - 1]).toBeCloseTo(16, 2); // rides the full 32 m
    for (let i = 1; i < so.count; i++) expect(so.posX[i]).toBeGreaterThan(so.posX[i - 1]);
    for (let i = 0; i < so.count; i++) expect(so.posY[i]).toBeCloseTo(0, 3);
    expect(so.firstInfeasible).toBe(-1); // the flat never depletes energy
});

test("the realized ride preserves draft arclength and conserves energy on a varying-velocity draft", () => {
    // a gentle hill: the draft slows over the crest, so the draft-time grid is
    // non-uniform in arclength (the flat case is degenerate — linear). riding the
    // solved force must still distribute the draft's *total* arclength across the
    // grid (each step rides its draft-arclength interval) and conserve energy.
    const state = new State();
    state.addSystem(BakeSystem);
    state.addSystem(SolveSystem);
    const eid = createTrack(state);
    addNode(state, -16, 0);
    addNode(state, 0, 2);
    addNode(state, 16, 0);
    state.step(0);
    const so = solveOut.get(eid);
    const out = bakeOut.get(eid);
    if (!so || !out) throw new Error("missing solve/bake output");

    // the realized polyline length equals the draft's Σ ds (the σ-mapping sums to
    // the full draft arclength).
    const count = Track.count.get(eid);
    let draftLen = 0;
    for (let i = 0; i < count - 1; i++) draftLen += out.ds[i];
    let realizedLen = 0;
    for (let i = 0; i < so.count - 1; i++) {
        realizedLen += Math.hypot(so.posX[i + 1] - so.posX[i], so.posY[i + 1] - so.posY[i]);
    }
    expect(realizedLen).toBeCloseTo(draftLen, 2);

    // energy is conserved along the ride: ½v² + g·y = ½V0².
    const E0 = 0.5 * so.v[0] * so.v[0] + G * so.posY[0];
    for (let i = 0; i < so.count; i++) {
        if (so.v[i] <= 0) break; // past an energy-out point v clamps to 0
        expect(0.5 * so.v[i] * so.v[i] + G * so.posY[i]).toBeCloseTo(E0, 2);
    }
});

test("an out-of-band draft recovers to the drawn shape (the always-on anchor)", () => {
    // a draft whose OWN geometry exceeds the band (a tight V dips to ≈-5g, below the
    // -2g floor). the band clamps it; the recovery anchor holds the realized endpoint
    // to the drawn shape instead of swinging metres off (measured 0.8 m with the
    // anchor vs 6.9 m without; the 2 m bound sits between, with margin). removing the
    // anchor from the solve fails this — the solve-level mechanism is anchor.test.ts.
    const state = new State();
    state.addSystem(BakeSystem);
    state.addSystem(SolveSystem);
    const eid = createTrack(state);
    for (const [x, y] of [
        [-16, 0],
        [-0.9, 0.7],
        [0.9, -0.6],
        [16, 0],
    ])
        addNode(state, x, y);
    state.step(0);
    const out = bakeOut.get(eid);
    const so = solveOut.get(eid);
    if (!out || !so) throw new Error("missing bake/solve output");

    // the draft genuinely violates the band — else there is nothing to recover from.
    let minF = Number.POSITIVE_INFINITY;
    const count = Track.count.get(eid);
    for (let i = 0; i < count - 1; i++) minF = Math.min(minF, out.fN[i]);
    expect(minF).toBeLessThan(DEFAULT_BAND[0]);

    // the realized ride stays feasible (no stall to NaN) and its endpoint tracks the
    // drawn shape (the last node) instead of swinging metres off.
    expect(so.firstInfeasible).toBe(-1);
    expect(Number.isFinite(so.posX[so.count - 1])).toBe(true);
    const endDrift = Math.hypot(so.posX[so.count - 1] - 16, so.posY[so.count - 1] - 0);
    expect(endDrift).toBeLessThan(2);
});

test("a re-solve is skipped while the bake is unchanged (hash gate)", () => {
    const state = new State();
    state.addSystem(BakeSystem);
    state.addSystem(SolveSystem);
    const eid = createTrack(state);
    addNode(state, -16, 0);
    addNode(state, 16, 0);
    state.step(0);
    const first = solveOut.get(eid);
    if (!first) throw new Error("solveOut missing after solve");
    state.step(0); // nothing moved
    expect(solveOut.get(eid)).toBe(first); // same object — not recomputed
});
