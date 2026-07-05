import { expect, test } from "bun:test";
import { State } from "@dylanebert/shallot";
import { cartPose, forceCurve, loopTime } from "../src/cart";
import { addNode, BakeSystem, bakeOut, createTrack } from "../src/track";

// cartPose rides the baked track; forceCurve reads the baked force per-sample over
// arclength (the chart's distance axis, spec §4). driven against the seeded flat chain,
// where constant speed makes t linear in arclength — so the cart's x is a closed-form
// check, not a fixture. device-free harness, like track.test.ts.

/** a fresh flat track (anchor (−16,0) → node (16,0)), baked. */
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

test("cartPose + forceCurve are null before the bake has a chain", () => {
    // a fresh track with no nodes baked: Track.count is 0, so nothing to ride or sample.
    const state = new State();
    const eid = createTrack(state);
    expect(cartPose(eid, 0)).toBeNull();
    expect(forceCurve(eid)).toBeNull();
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

test("forceCurve reads per-sample ~1g over the flat chain's arclength [0, 32]", () => {
    // anchor (−16,0) → node (16,0): a 32m flat span at ≈1g everywhere.
    const { eid } = baked();
    const c = forceCurve(eid);
    if (!c) throw new Error("forceCurve returned null after bake");
    expect(c.n).toBeGreaterThan(2);
    expect(c.s[0]).toBe(0);
    expect(c.s[c.n - 1]).toBeCloseTo(32, 2); // total arclength = the chord span
    for (let i = 1; i < c.n; i++) expect(c.s[i]).toBeGreaterThan(c.s[i - 1]); // monotone
    for (let i = 0; i < c.n; i++) expect(c.f[i]).toBeCloseTo(1, 3);
});

test("cartPose rides the baked track flat, anchor to end", () => {
    // the flat chain bakes to ≈ 1g at constant speed, so t is linear in arclength.
    const { eid, tTotal } = baked();
    const start = cartPose(eid, 0);
    const mid = cartPose(eid, tTotal / 2);
    const end = cartPose(eid, tTotal);
    if (!start || !mid || !end) throw new Error("cartPose returned null after bake");

    expect(start.x).toBeCloseTo(-16, 2);
    expect(end.x).toBeCloseTo(16, 2);
    expect(mid.x).toBeCloseTo(0, 1); // flat at constant v ⇒ half-time is x = 0
    expect(mid.y).toBeCloseTo(0, 3);
    expect(mid.theta).toBeCloseTo(0, 3);
});
