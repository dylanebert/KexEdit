import { expect, test } from "bun:test";
import { State } from "@dylanebert/shallot";
import {
    cartArc,
    cartPose,
    cartState,
    CartSystem,
    forceCurve,
    loopTime,
    parkAtArc,
} from "../src/cart";
import {
    addNode,
    appendSection,
    BakeSystem,
    bakeOut,
    convertSection,
    createForcePoint,
    createSection,
    createTrack,
    deleteSection,
    SectionKind,
    sections,
    setSectionLength,
} from "../src/track";

// cartPose rides the baked track; forceCurve reads the baked force per-sample over
// arclength (the chart's distance axis, spec §4). driven against the seeded flat chain,
// where constant speed makes t linear in arclength — so the cart's x is a closed-form
// check, not a fixture. device-free harness, like track.test.ts.

/** a fresh flat track (entry anchor at the origin → node (32,0)), baked. */
function baked(): { eid: number; tTotal: number } {
    const state = new State();
    state.addSystem(BakeSystem);
    const eid = createTrack(state);
    const sec = createSection(state, 0, SectionKind.Geo, 0);
    addNode(state, sec, 0, 0);
    addNode(state, sec, 32, 0);
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
    const sec = createSection(state, 0, SectionKind.Geo, 0);
    addNode(state, sec, 0, 0);
    addNode(state, sec, 16, 27.7);
    state.step(0);
    const out = bakeOut.get(eid);
    if (!out) throw new Error("bakeOut missing");
    expect(out.firstInfeasible).toBeGreaterThan(0); // there is red
    // the cart loops the moment it reaches red, before the slow energy-out tail.
    expect(loopTime(out)).toBeCloseTo(out.t[out.firstInfeasible], 10);
    expect(loopTime(out)).toBeLessThan(out.tTotal);
});

test("forceCurve reads per-sample ~1g over the flat chain's arclength [0, 32]", () => {
    // origin → node (32,0): a 32m flat span at ≈1g everywhere.
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

    expect(start.x).toBeCloseTo(0, 2);
    expect(end.x).toBeCloseTo(32, 2);
    expect(mid.x).toBeCloseTo(16, 1); // flat at constant v ⇒ half-time is the midpoint
    expect(mid.y).toBeCloseTo(0, 3);
    expect(mid.theta).toBeCloseTo(0, 3);
});

// ── content-anchored playhead parking (fork 4) ──
// while parked (`held`), the truth is a content anchor `{section, offset}` and `t` is
// derived from it through the current bake, so a re-time slides the ride under a
// stationary playhead. driven on a bare State with both systems (BakeSystem re-bakes,
// CartSystem re-derives). the flat-then-airtime force section re-times at a FIXED extent
// (arclength held), the exact spatial-change-free case the spec cites.

/** a fresh force section (extent DEFAULT_FORCE_LEN, flat 1g), on a track with the cart
 *  system, baked and with `cartState` seeded (held false). */
function forceTrack(): { state: State; eid: number; sec: number } {
    const state = new State();
    state.addSystem(BakeSystem);
    state.addSystem(CartSystem);
    const eid = createTrack(state);
    const sec = createSection(state, 0, SectionKind.Geo, 0);
    addNode(state, sec, 0, 0);
    addNode(state, sec, 32, 0);
    state.step(0);
    convertSection(state, sec); // → force, extent resets to the default
    state.step(0);
    return { state, eid, sec };
}

test("a parked anchor holds its arclength while an edit re-times the ride", () => {
    const { state, eid, sec } = forceTrack();
    const st = cartState.get(eid);
    if (!st) throw new Error("cartState missing after step");
    st.held = true;
    parkAtArc(state, eid, 20); // near the section end, where a re-time compounds
    const arc1 = cartArc(eid);
    if (arc1 === null) throw new Error("cartArc null after park");
    const t1 = st.t;
    expect(arc1).toBeCloseTo(20, 1);

    // an airtime crest re-times the traversal (velocity changes) at a fixed extent —
    // the spec's keyframe-drag case: the parked place must not slide.
    const len = sections(state)[0].length;
    createForcePoint(state, sec, len * 0.2, 1);
    createForcePoint(state, sec, len * 0.5, 0);
    createForcePoint(state, sec, len * 0.8, 1);
    state.step(0);

    const arc2 = cartArc(eid);
    if (arc2 === null) throw new Error("cartArc null after re-time");
    expect(arc2).toBeCloseTo(arc1, 1); // playhead stays glued to the track feature
    expect(t2Differs(t1, st.t)).toBe(true); // but the ride re-timed
});

/** the re-time must move `t` meaningfully (not a float-noise wiggle). */
function t2Differs(a: number, b: number): boolean {
    return Math.abs(a - b) > 0.02;
}

test("a parked offset clamps into the section when it shortens", () => {
    const { state, eid, sec } = forceTrack();
    setSectionLength(state, sec, 40);
    state.step(0);
    const st = cartState.get(eid);
    if (!st) throw new Error("cartState missing");
    st.held = true;
    parkAtArc(state, eid, 30); // near the end of the 40m section
    expect(cartArc(eid)).toBeCloseTo(30, 1);

    setSectionLength(state, sec, 20); // shorten under the parked offset
    state.step(0);
    expect(cartArc(eid)).toBeCloseTo(20, 1); // clamped to the new extent, not 30
});

test("a parked anchor re-resolves onto the chain when its section is deleted", () => {
    const state = new State();
    state.addSystem(BakeSystem);
    state.addSystem(CartSystem);
    const eid = createTrack(state);
    const sec1 = createSection(state, 0, SectionKind.Geo, 0);
    addNode(state, sec1, 0, 0);
    addNode(state, sec1, 32, 0);
    state.step(0);
    const sec2 = appendSection(state, SectionKind.Geo); // a second span past the first
    state.step(0);

    const st = cartState.get(eid);
    if (!st) throw new Error("cartState missing");
    st.held = true;
    parkAtArc(state, eid, 16); // mid the FIRST section
    expect(st.park?.section).toBe(sec1);

    deleteSection(state, sec1); // the anchored section is gone
    state.step(0);
    expect(st.park?.section).toBe(sec2); // re-resolved onto the survivor
    expect(cartArc(eid)).not.toBeNull();
    expect(cartArc(eid)).toBeCloseTo(16, 0); // ~same track place (sec2 now spans from 0)
});
