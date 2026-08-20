import { describe, expect, test } from "bun:test";
import { State } from "@dylanebert/shallot";
import { sectionActs } from "../src/acts";
import {
    cartArc,
    cartPose,
    cartState,
    CartSystem,
    forceCurve,
    loopTime,
    parkAtArc,
    playheadPosition,
    trackMapping,
    velocityCurve,
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
    samples,
    SectionKind,
    sectionCutAt,
    sectionForces,
    sectionInfo,
    sections,
    sectionSpans,
    setBakeFreeze,
    setForcePoint,
    setSectionLength,
    Track,
} from "../src/track";

// cartPose rides the baked track; forceCurve reads the baked force per-sample over
// arclength (the chart's distance axis). driven against the seeded flat chain,
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

test("cartPose + forceCurve + velocityCurve are null before the bake has a chain", () => {
    // a fresh track with no nodes baked: Track.count is 0, so nothing to ride or sample.
    const state = new State();
    const eid = createTrack(state);
    expect(cartPose(eid, 0)).toBeNull();
    expect(forceCurve(eid)).toBeNull();
    expect(velocityCurve(eid)).toBeNull();
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
    const state = new State();
    state.addSystem(BakeSystem);
    const eid = createTrack(state);
    const sec = createSection(state, 0, SectionKind.Geo, 0);
    addNode(state, sec, 0, 0);
    addNode(state, sec, 16, 12); // a real climb, well short of stalling
    state.step(0);
    const f = forceCurve(eid);
    const v = velocityCurve(eid);
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

// ── trackMapping under the downstream freeze (kex2d-optimize-mode stage 7, review finding C) ──
// the freeze's seam is a zero-length gap EDGE over a real position jump, and every arclength
// consumer must use the bake's own per-edge ds (gap contributes zero) — `forceCurve` and
// `sectionSpans` already do; the mapping re-derived arc from raw chord distance and diverged
// from the chart axis by the residual-gap length for every downstream park.
test("trackMapping arclength follows the bake's ds convention across a frozen gap", () => {
    const state = new State();
    state.addSystem(BakeSystem);
    const eid = createTrack(state);
    const secA = createSection(state, 0, SectionKind.Force, 40);
    createForcePoint(state, secA, 0, 1);
    createForcePoint(state, secA, 20, 1.4);
    createForcePoint(state, secA, 40, 1);
    const secB = createSection(state, 1, SectionKind.Force, 30);
    createForcePoint(state, secB, 0, 1);
    createForcePoint(state, secB, 30, 1);
    state.step(0);

    // freeze downstream at its current entry (what mode entry does), then move A's crest so
    // the live exit wanders off the frozen entry — the gap opens.
    const frozen = sectionInfo.get(secB)?.entry;
    if (!frozen) throw new Error("no downstream entry");
    setBakeFreeze({ section: secA, entry: { ...frozen } });
    const crest = sectionForces(state, secA)[1];
    setForcePoint(state, crest.id, crest.s, crest.g + 0.5);
    state.step(0);

    const out = bakeOut.get(eid);
    const s = samples.get(eid);
    const m = trackMapping(eid);
    const n = Track.count.get(eid);
    if (!out || !s || !m) throw new Error("no bake");
    const infoA = sectionInfo.get(secA);
    const infoB = sectionInfo.get(secB);
    if (!infoA || !infoB) throw new Error("no info");

    // positive control: the gap is real — a nonzero position jump across the seam…
    const gap = Math.hypot(
        s.posX[infoB.startSample] - s.posX[infoA.endSample],
        s.posY[infoB.startSample] - s.posY[infoA.endSample],
    );
    expect(gap).toBeGreaterThan(0.01);
    // …that the bake's own edge carries as ZERO arclength.
    expect(out.ds[infoA.endSample]).toBe(0);

    // the mapping must agree with the chart's own axis (prefix sums of out.ds) at every sample —
    // seen failing on 9f3dc41 by exactly `gap` at every downstream sample (the chord re-derive).
    let acc = 0;
    for (let i = 1; i < n; i++) {
        acc += out.ds[i - 1];
        expect(Math.abs(m.arc[i] - acc)).toBeLessThan(1e-9);
    }
    setBakeFreeze(null);
});

describe("playheadPosition — the keyboard Cut's playhead resolution (kex2d-structural-editing stage 8)", () => {
    // a fresh geo track with room for an INTERIOR cut point (node 0 at the origin, node 1 at
    // (32,0) — the single segment's whole open interval is a valid `geoCutAt` landing).
    function geoTrack(): { state: State; eid: number; sec: number } {
        const state = new State();
        state.addSystem(BakeSystem);
        state.addSystem(CartSystem);
        const eid = createTrack(state);
        const sec = createSection(state, 0, SectionKind.Geo, 0);
        addNode(state, sec, 0, 0);
        addNode(state, sec, 32, 0);
        state.step(0);
        return { state, eid, sec };
    }

    // `controls.ts`'s own keyboard-cut resolution, replicated inline (the production seam:
    // `cart.playheadPosition` → `track.sectionCutAt`, scoped to the selected section) — proves
    // the seam itself, not a restatement of `controls.ts`'s dispatch.
    function keyboardCutPosition(state: State, eid: number, sec: number) {
        const ph = playheadPosition(eid);
        if (ph === null) return null;
        return sectionCutAt(state, sec, sectionSpans(state, eid), ph.d, ph.u);
    }

    test("resolves bit-exactly to the playhead's own cartArc reading — no rounding, no threshold", () => {
        const { state, eid } = geoTrack();
        const st = cartState.get(eid);
        if (!st) throw new Error("cartState missing");
        st.held = true;
        parkAtArc(state, eid, 12.3456789); // an arbitrary interior arclength, not a round number
        const d0 = cartArc(eid);
        if (d0 === null) throw new Error("cartArc null after park");
        const ph = playheadPosition(eid);
        // Object.is-exact: the resolution carries no pixel/table round trip at all — it's the
        // SAME number `cartArc` itself holds, whatever that number is.
        expect(ph?.d).toBe(d0);
    });

    test("resolves an interior point arbitrarily close to a section boundary — no proximity gate", () => {
        // unlike the menu's `snapCutToPlayhead` (SNAP_PX-gated), the keyboard path never calls a
        // threshold resolver at all — a park a fraction of a millimetre off either end still
        // resolves to a genuine interior cut point.
        const { state, eid, sec } = geoTrack();
        const st = cartState.get(eid);
        if (!st) throw new Error("cartState missing");
        st.held = true;
        parkAtArc(state, eid, 0.001);
        expect(keyboardCutPosition(state, eid, sec)).not.toBeNull();
        parkAtArc(state, eid, 31.999);
        expect(keyboardCutPosition(state, eid, sec)).not.toBeNull();
    });

    test("cutting at the playhead never moves it — a parked cart re-bakes to the same arclength", () => {
        const { state, eid, sec } = geoTrack();
        const st = cartState.get(eid);
        if (!st) throw new Error("cartState missing");
        st.held = true;
        parkAtArc(state, eid, 12.3456789);
        const before = cartArc(eid);
        if (before === null) throw new Error("cartArc null after park");

        const position = keyboardCutPosition(state, eid, sec);
        expect(position).not.toBeNull();
        sectionActs(state, sec, position).cutAt();
        state.step(0); // re-bake across the new section boundary

        expect(cartArc(eid)).toBeCloseTo(before, 9); // read-only: the cut never wrote `cartState`
        expect(sections(state).length).toBe(2); // sanity: the cut actually landed
    });

    // the mutant `editor-ui.md`'s transport-read clause names: a resolver that ASSIGNS the
    // playhead instead of merely reading it. Simulated here (never landed in production) to
    // prove the test above is discriminating, not vacuous.
    test("mutant check: a resolver that re-parks the playhead after a cut fails the read-only assert", () => {
        const { state, eid, sec } = geoTrack();
        const st = cartState.get(eid);
        if (!st) throw new Error("cartState missing");
        st.held = true;
        parkAtArc(state, eid, 12.3456789);
        const before = cartArc(eid);
        if (before === null) throw new Error("cartArc null after park");

        const position = keyboardCutPosition(state, eid, sec);
        sectionActs(state, sec, position).cutAt();
        state.step(0);
        // the mutant: an authoring op driving the transport, exactly what the isolation forbids.
        parkAtArc(state, eid, before + 5);

        expect(cartArc(eid)).not.toBeCloseTo(before, 9);
    });
});
