import { expect, test } from "bun:test";
import type { State } from "@dylanebert/shallot";
import {
    cartArc,
    cartPose,
    cartState,
    CartSystem,
    forceCurve,
    loopTime,
    parkAtArc,
    velocityCurve,
} from "../src/cart";
import { bakeOut, runsOf } from "../src/track";
import { build } from "./helpers/build";

// cartPose rides the baked track; forceCurve reads the baked force per-sample over
// arclength (the chart's distance axis). driven against the seeded flat chain,
// where constant speed makes t linear in arclength — so the cart's x is a closed-form
// check, not a fixture. device-free harness, like track.test.ts.

// the shared authoring builder: every fixture below is authored through the shared `Build` helper
// (`tests/helpers/build.ts`), the S2e-i lane setters — this file tests `cart.ts`'s read paths,
// which consume an authored track, not the authoring layer itself.

/** a fresh flat track (entry anchor at the origin → node (32,0)), baked. */
function baked(): { eid: number; tTotal: number } {
    const bd = build();
    bd.force(0, 32, 1);
    bd.bake();
    const out = bakeOut.get(bd.trackEid);
    if (!out) throw new Error("bakeOut missing");
    return { eid: bd.trackEid, tTotal: out.tTotal };
}

test("cartPose + forceCurve + velocityCurve are null before the bake has a chain", () => {
    // a fresh track with no nodes baked: Track.count is 0, so nothing to ride or sample.
    const bd = build();
    expect(cartPose(bd.trackEid, 0)).toBeNull();
    expect(forceCurve(bd.trackEid)).toBeNull();
    expect(velocityCurve(bd.trackEid)).toBeNull();
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
    const bd = build();
    bd.geo(0, 32, 0, 1.3);
    bd.bake();
    const out = bakeOut.get(bd.trackEid);
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

test("velocityCurve is forceCurve's twin — same axis, per-sample v straight off bakeOut.v", () => {
    // origin → node (32,0): flat, so speed barely changes (friction=resistance=0 by default).
    const { eid } = baked();
    const out = bakeOut.get(eid);
    if (!out) throw new Error("no bake");
    const c = velocityCurve(eid);
    if (!c) throw new Error("velocityCurve returned null after bake");
    expect(c.n).toBeGreaterThan(2);
    expect(c.s[0]).toBe(0);
    expect(c.s[c.n - 1]).toBeCloseTo(32, 2); // the same cumulative arclength forceCurve reads
    // published straight off the bake's own `v` — no leading-sample repeat (unlike `fN`, `v` is
    // already per-sample), so this is byte-identical, not just close.
    for (let i = 0; i < c.n; i++) expect(c.v[i]).toBe(out.v[i]);
});

test("velocityCurve's range genuinely differs from forceCurve's — the case for its own scale", () => {
    // a climb that sheds real speed: v drops well below its entry value while F_n swings through
    // its own separate g-range — the two channels have no common unit, so a shared axis would
    // either crush one or clip the other. Auto-fit must be per-channel.
    const bd = build();
    bd.geo(0, 32, 0, 0.7); // a real climb, well short of stalling
    bd.bake();
    const f = forceCurve(bd.trackEid);
    const v = velocityCurve(bd.trackEid);
    if (!f || !v) throw new Error("no bake");
    const vLo = Math.min(...v.v.subarray(0, v.n));
    const vHi = Math.max(...v.v.subarray(0, v.n));
    let fLo = f.f[0];
    let fHi = f.f[0];
    for (let i = 0; i < f.n; i++) {
        if (f.f[i] < fLo) fLo = f.f[i];
        if (f.f[i] > fHi) fHi = f.f[i];
    }
    // the velocity range's SPREAD is an order of magnitude past the force range's — a shared
    // axis would flatten the force curve to a hairline or clip the velocity curve entirely.
    expect(vHi - vLo).toBeGreaterThan((fHi - fLo) * 5);
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
 *  system, baked and with `cartState` seeded (held false). Returns the `Build` itself
 *  too — the dependent tests keep authoring past this point (adding force points,
 *  resizing the section). */
function forceTrack(): {
    bd: ReturnType<typeof build>;
    state: State;
    eid: number;
    sec: number;
} {
    const bd = build();
    bd.ecs.addSystem(CartSystem);
    const sec = bd.force(0, 32, 1);
    bd.bake();
    return { bd, state: bd.ecs, eid: bd.trackEid, sec };
}

test("a parked anchor holds its arclength while an edit re-times the ride", () => {
    const { bd, state, eid, sec } = forceTrack();
    const st = cartState.get(eid);
    if (!st) throw new Error("cartState missing after step");
    st.held = true;
    parkAtArc(state, eid, 20); // near the section end, where a re-time compounds
    const arc1 = cartArc(eid);
    if (arc1 === null) throw new Error("cartArc null after park");
    const t1 = st.t;
    expect(arc1).toBeCloseTo(20, 1);

    // an airtime crest re-times the traversal (velocity changes) at a fixed extent —
    // the spec's keyframe-drag case: the parked place must not slide. (the section's reset
    // seed already carries two flat continuation keyframes — this test doesn't need an
    // exact keyframe set, just an airtime shape layered on top, so no clearing gotcha here.)
    bd.span(sec, 0, 16);
    bd.handle(sec, "exit", 0);
    bd.force(16, 32, 0, 1);
    bd.bake();

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
    const { bd, state, eid, sec } = forceTrack();
    bd.span(sec, 0, 40);
    bd.bake();
    const st = cartState.get(eid);
    if (!st) throw new Error("cartState missing");
    st.held = true;
    parkAtArc(state, eid, 30); // near the end of the 40m section
    expect(cartArc(eid)).toBeCloseTo(30, 1);

    bd.span(sec, 0, 20); // shorten under the parked offset
    bd.bake();
    expect(cartArc(eid)).toBeCloseTo(20, 1); // clamped to the new extent, not 30
});

test("a parked anchor re-resolves onto the chain when its run is deleted", () => {
    const bd = build();
    bd.ecs.addSystem(CartSystem);
    const a = bd.geo(0, 32, 0, 0);
    const b = bd.force(32, 62, 1);
    bd.bake();
    const { ecs: state, trackEid: eid } = bd;

    const st = cartState.get(eid);
    if (!st) throw new Error("cartState missing");
    st.held = true;
    parkAtArc(state, eid, 16); // mid the FIRST run
    const first = runsOf(state)[0];
    expect(st.park?.section).toBe(first!.id);

    bd.remove(a); // the anchored run's record is gone
    bd.bake();
    expect(st.park?.section).toBe(runsOf(state)[0]!.id); // re-resolved onto the survivor
    expect(cartArc(eid)).not.toBeNull();
    expect(cartArc(eid)).toBeCloseTo(16, 0); // ~same track place
    void b;
});
