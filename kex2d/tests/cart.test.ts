import { expect, test } from "bun:test";
import { State } from "@dylanebert/shallot";
import { cartPose, loopTime, sampleFNOverTime } from "../src/cart";
import { SolveSystem, solveOut } from "../src/optimize";
import { addNode, BakeSystem, bakeOut, createTrack } from "../src/track";

// cartPose rides the realized (solved) track; sampleFNOverTime resamples the
// baked draft onto the time axis. driven against the seeded flat chain, where
// the realized track coincides with the draft and constant speed makes t linear
// in arclength — so the cart's x is a closed-form check, not a fixture.
// device-free harness, like track.test.ts. Bake then Solve (registration order).

/** a fresh flat track (anchor (−16,0) → node (16,0)), baked + solved. */
function baked(): { eid: number; tTotal: number } {
    const state = new State();
    state.addSystem(BakeSystem);
    state.addSystem(SolveSystem);
    const eid = createTrack(state);
    addNode(state, -16, 0);
    addNode(state, 16, 0);
    state.step(0);
    const out = bakeOut.get(eid);
    if (!out) throw new Error("bakeOut missing");
    return { eid, tTotal: out.tTotal };
}

test("cartPose returns null before the first solve; sampleFNOverTime before the bake", () => {
    // a track with no bake/solve yet: nothing to ride, nothing to sample. the
    // solveOut Map is module-global and keyed by eid (reused across States), so
    // clear this track's entry to assert the no-output precondition.
    const state = new State();
    const eid = createTrack(state);
    solveOut.delete(eid);
    expect(cartPose(eid, 0)).toBeNull();
    expect(sampleFNOverTime(eid, 16)).toBeNull();
});

test("loopTime is the full track time when the whole chain is feasible", () => {
    const { eid, tTotal } = baked();
    const out = bakeOut.get(eid);
    if (!out) throw new Error("bakeOut missing");
    expect(out.firstInfeasible).toBe(-1);
    expect(loopTime(out)).toBe(tTotal);
});

test("loopTime resets at the first infeasible sample, not the crawl-through end", () => {
    // a steep climb that depletes energy partway up → an infeasible (red) tail.
    const state = new State();
    state.addSystem(BakeSystem);
    const eid = createTrack(state);
    addNode(state, -16, 0);
    addNode(state, 0, 27.7);
    state.step(0);
    const out = bakeOut.get(eid);
    if (!out) throw new Error("bakeOut missing");
    expect(out.firstInfeasible).toBeGreaterThan(0); // there is red
    // the cart loops the moment it reaches red, before the slow energy-out tail.
    expect(loopTime(out)).toBeCloseTo(out.t[out.firstInfeasible], 10);
    expect(loopTime(out)).toBeLessThan(out.tTotal);
});

test("sampleFNOverTime returns N points at ~1g on the flat chain", () => {
    const { eid } = baked();
    const grid = sampleFNOverTime(eid, 64);
    if (!grid) throw new Error("sampleFNOverTime returned null after bake");
    expect(grid.length).toBe(64);
    for (let i = 0; i < grid.length; i++) expect(grid[i]).toBeCloseTo(1, 3);
});

test("cartPose rides the realized track flat, anchor to end", () => {
    // the flat draft solves to ≈ 1g (constant in → constant out, inside the
    // band), so the realized track the cart rides coincides with the flat draft.
    const { eid, tTotal } = baked();
    const start = cartPose(eid, 0);
    const mid = cartPose(eid, tTotal / 2);
    const end = cartPose(eid, tTotal);
    if (!start || !mid || !end) throw new Error("cartPose returned null after solve");

    expect(start.x).toBeCloseTo(-16, 2);
    expect(end.x).toBeCloseTo(16, 2);
    expect(mid.x).toBeCloseTo(0, 1); // flat at constant v ⇒ half-time is x = 0
    expect(mid.y).toBeCloseTo(0, 3);
    expect(mid.theta).toBeCloseTo(0, 3);
    expect(mid.u).toBeCloseTo(0.5, 2); // grid-fraction progress for the strip cursor
});
