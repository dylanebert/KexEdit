import { expect, test } from "bun:test";
import { State } from "@dylanebert/shallot";
import { cartPose, loopTime, sampleFNOverTime } from "../src/cart";
import { addNode, BakeSystem, bakeOut, createTrack } from "../src/track";

// cartPose / sampleFNOverTime resample the bake onto the time axis (binary
// search over cumulative t, then lerp). driven against the seeded flat chain,
// where constant speed makes t linear in arclength — so the cart's x is a
// closed-form check, not a fixture. device-free harness, like track.test.ts.

/** a fresh flat track (anchor (−16,0) → node (16,0)) and its baked output. */
function baked(): { eid: number; tTotal: number } {
    const state = new State();
    state.addSystem(BakeSystem);
    const eid = createTrack(state);
    addNode(state, -16, 0);
    addNode(state, 16, 0);
    state.step(0);
    const out = bakeOut.get(eid);
    if (!out) throw new Error("bakeOut missing");
    return { eid, tTotal: out.tTotal };
}

test("cartPose returns null before the first bake", () => {
    // a track with no bake yet: count is still 0, so there is nothing to sample.
    const state = new State();
    const eid = createTrack(state);
    expect(cartPose(eid, 0)).toBeNull();
    expect(sampleFNOverTime(eid, 16)).toBeNull();
});

test("cartPose tracks the flat chain from anchor to end node", () => {
    const { eid, tTotal } = baked();
    const start = cartPose(eid, 0);
    const mid = cartPose(eid, tTotal / 2);
    const end = cartPose(eid, tTotal);
    if (!start || !mid || !end) throw new Error("cartPose returned null after bake");

    expect(start.x).toBeCloseTo(-16, 3);
    expect(end.x).toBeCloseTo(16, 3);
    // flat chord at constant v ⇒ t linear in x ⇒ the half-time point is x = 0.
    expect(mid.x).toBeCloseTo(0, 2);
    expect(mid.y).toBeCloseTo(0, 4);
    expect(mid.theta).toBeCloseTo(0, 4);
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
