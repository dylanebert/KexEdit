import { describe, expect, test } from "bun:test";
import { editor, select, selectionHook } from "../src/editor";
import { State } from "@dylanebert/shallot";
import { V_FLOOR } from "../src/bake";
import { trackMapping } from "../src/cart";
import { convertDomain } from "../src/domain";
import { createHistory, redo, setSelectionHook, undo } from "../src/history";
import { Domain } from "../src/section";
import { TangentMode } from "../src/spline";
import {
    BakeSystem,
    bakeOut,
    createForcePoint,
    createSection,
    createTrack,
    DS_NOMINAL,
    DT_NOMINAL,
    Force,
    forceTangent,
    Handle,
    handleAt,
    MIN_FORCE_LEN,
    samples,
    Section,
    sectionAt,
    SectionKind,
    sectionForces,
    sectionInfo,
    sections,
    setForceTangent,
    Track,
    trackDomain,
    V0,
    addNode,
} from "../src/track";

// `domain.convertDomain` — the track-global domain conversion op. `Track.domain` says what
// unit every force keyframe's `s` and every force section's extent are stored in, so the
// ruler-menu basis pick is a DOCUMENT conversion: one history entry that flips the domain and
// rewrites the store through the live bake's arc↔time table.
//
// The tests below are device-free (canvas2D + a bare `State`) and split by what they pin:
//
//   1. the guards — no live bake, the already-active domain;
//   2. the forward conversion, against the bake's OWN arc↔time table rebuilt independently in
//      this file (`table`/`interp`), so a bug in `domain.ts`'s helpers can't hide behind them;
//   3. the round trip, bounded by a DERIVED tolerance (see `describe("round trip")`);
//   4. undo byte-identity + selection survival — the only bit-identical way back, per the
//      locked decision;
//   5. the two degeneracies the locked decision names: a plateau where the ride stalls, and a
//      keyframe past the baked span (per SECTION, not per track).

/** the arc↔time table, rebuilt from the bake's raw SoA — the independent reference the forward
 *  conversion is checked against. Deliberately NOT `cart.trackMapping` composed with
 *  `timeline.arcToTime`: those are what `domain.ts` itself converts through, so reusing them
 *  would only assert the code agrees with itself. */
function table(eid: number): { arc: number[]; t: number[] } {
    const s = samples.get(eid);
    const out = bakeOut.get(eid);
    if (!s || !out) throw new Error("no bake");
    const n = Track.count.get(eid);
    const arc = [0];
    for (let i = 1; i < n; i++)
        arc.push(arc[i - 1] + Math.hypot(s.posX[i] - s.posX[i - 1], s.posY[i] - s.posY[i - 1]));
    const t: number[] = [];
    for (let i = 0; i < n; i++) t.push(out.t[i]);
    return { arc, t };
}

/** linear interpolation of `ys` at where `v` falls in the monotone `xs`, extrapolating at the
 *  boundary interval's slope past either end (the past-span rule). A tied interval resolves to
 *  its last index, matching `timeline.interpMono`. */
function interp(xs: readonly number[], ys: readonly number[], v: number): number {
    const last = xs.length - 1;
    const slope = (i: number) => (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
    if (v >= xs[last]) return ys[last] + (v - xs[last]) * slope(last - 1);
    if (v <= xs[0]) return ys[0] + (v - xs[0]) * slope(0);
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (xs[mid] <= v) lo = mid;
        else hi = mid;
    }
    const span = xs[hi] - xs[lo];
    return ys[lo] + (span > 0 ? (v - xs[lo]) / span : 0) * (ys[hi] - ys[lo]);
}

/** a one-force-section track: the authored profile over `len` (m), baked once. */
function forceTrack(
    len: number,
    pts: readonly [number, number][],
): { state: State; eid: number; sec: number } {
    const state = new State();
    state.addSystem(BakeSystem);
    const eid = createTrack(state);
    const sec = createSection(state, 0, SectionKind.Force, len);
    for (const [s, g] of pts) createForcePoint(state, sec, s, g);
    state.step(0);
    return { state, eid, sec };
}

/** section `id`'s track-global entry distance on the rebuilt table — the cumulative baked
 *  arclength at its own entry sample (the bake's `sectionInfo` range, not the lens). */
function offsetOf(id: number, tab: { arc: number[] }): number {
    const info = sectionInfo.get(id);
    if (!info) throw new Error(`no bake for section ${id}`);
    return tab.arc[info.startSample];
}

/** the whole track's baked arclength, off the bake's own per-edge ds. */
function arcTotal(eid: number): number {
    const out = bakeOut.get(eid);
    if (!out) throw new Error("no bake");
    let cum = 0;
    for (let i = 0; i < Track.count.get(eid) - 1; i++) cum += out.ds[i];
    return cum;
}

const kfs = (state: State, sec: number): number[] => sectionForces(state, sec).map((p) => p.s);
const extent = (state: State, sec: number): number => {
    const eid = sectionAt(state, sec);
    if (eid === null) throw new Error("no section");
    return Section.length.get(eid);
};

describe("guards", () => {
    test("no live bake rejects: nothing written, nothing recorded", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        const sec = createSection(state, 0, SectionKind.Force, 40);
        createForcePoint(state, sec, 0, 1);
        createForcePoint(state, sec, 40, 1);
        const h = createHistory();

        // never stepped — `bakeLive` is false, so there is no arc↔time table to convert through.
        expect(convertDomain(h, state, Domain.Time)).toBe(false);
        expect(trackDomain(state)).toBe(Domain.Distance);
        expect(kfs(state, sec)).toEqual([0, 40]);
        expect(h.undo.length).toBe(0);
    });

    test("a bake that went stale under an edit rejects too", () => {
        const { state, sec } = forceTrack(40, [
            [0, 1],
            [40, 1],
        ]);
        const h = createHistory();
        createForcePoint(state, sec, 20, 1.2); // authored past the last bake, not re-baked

        expect(convertDomain(h, state, Domain.Time)).toBe(false);
        expect(trackDomain(state)).toBe(Domain.Distance);
        expect(h.undo.length).toBe(0);
    });

    test("the already-active domain is a no-op, not an empty history entry", () => {
        const { state, sec } = forceTrack(40, [
            [0, 1],
            [40, 1],
        ]);
        const h = createHistory();
        expect(convertDomain(h, state, Domain.Distance)).toBe(false);
        expect(h.undo.length).toBe(0);
        expect(kfs(state, sec)).toEqual([0, 40]);
    });
});

describe("forward conversion", () => {
    // f32 quantization of one `Force.s` store: the column is f32, so a stored value carries at
    // most 2^-24 relative error. Everything else in the conversion is f64.
    const f32Tol = (magnitude: number) => 2 ** -24 * Math.max(1, magnitude);

    test("each keyframe's time is the bake's own arc→time table at its global distance", () => {
        const { state, eid, sec } = forceTrack(40, [
            [0, 1],
            [10, 1.6],
            [25, 0.6],
            [40, 1],
        ]);
        const before = kfs(state, sec);
        const tab = table(eid);
        const h = createHistory();

        expect(convertDomain(h, state, Domain.Time)).toBe(true);
        expect(trackDomain(state)).toBe(Domain.Time);
        const after = kfs(state, sec);
        for (let i = 0; i < before.length; i++) {
            const want = interp(tab.arc, tab.t, before[i]);
            expect(after[i]).toBeCloseTo(want, 6);
            expect(Math.abs(after[i] - want)).toBeLessThanOrEqual(f32Tol(want));
        }
        // the extent converts as a position too: the time the section's own span takes.
        expect(extent(state, sec)).toBeCloseTo(interp(tab.arc, tab.t, 40), 6);
        // a varying-speed ride: the map is genuinely nonlinear, so this isn't a scale factor.
        expect(after[2] / after[3]).not.toBeCloseTo(before[2] / before[3], 3);
    });

    test("keyframes stay SECTION-local: the second section's entry is its own zero", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        const a = createSection(state, 0, SectionKind.Force, 30);
        createForcePoint(state, a, 0, 1);
        createForcePoint(state, a, 30, 0.8);
        const b = createSection(state, 1, SectionKind.Force, 30);
        createForcePoint(state, b, 0, 0.8);
        createForcePoint(state, b, 15, 1.2);
        createForcePoint(state, b, 30, 1);
        state.step(0);
        const tab = table(eid);
        const h = createHistory();

        expect(convertDomain(h, state, Domain.Time)).toBe(true);
        const offsetB = offsetOf(b, tab);
        const entryTime = interp(tab.arc, tab.t, offsetB);
        expect(entryTime).toBeGreaterThan(0); // B really does start mid-ride
        expect(kfs(state, b)[0]).toBe(0); // local 0 stays local 0 — no re-homing
        expect(kfs(state, b)[1]).toBeCloseTo(interp(tab.arc, tab.t, offsetB + 15) - entryTime, 6);
        // and A's own keyframes are measured from the track start (offset 0).
        expect(kfs(state, a)[1]).toBeCloseTo(interp(tab.arc, tab.t, 30), 6);
    });

    test("a solved section releases its step back to the nominal sentinel", () => {
        const { state, sec } = forceTrack(40, [
            [0, 1],
            [40, 1],
        ]);
        const eid = sectionAt(state, sec);
        if (eid === null) throw new Error("no section");
        Section.ds.set(eid, 0.37); // an invoked solve's realized ARCLENGTH step
        state.step(0);

        expect(convertDomain(createHistory(), state, Domain.Time)).toBe(true);
        // the step's only job is pinning the solve's exit under the distance march; a time march
        // no longer spans that arclength, so the claim lapses (the join-step rule's reasoning).
        expect(Section.ds.get(eid)).toBe(0);
    });

    test("geo sections are untouched — they stay position-authored in either domain", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        const geo = createSection(state, 0, SectionKind.Geo, 0);
        addNode(state, geo, 0, 0);
        addNode(state, geo, 24, 0);
        addNode(state, geo, 48, 6);
        const force = createSection(state, 1, SectionKind.Force, 30);
        createForcePoint(state, force, 0, 1);
        createForcePoint(state, force, 30, 1);
        state.step(0);
        const nodes = [...state.query([Handle])].map((e) => [
            Handle.pos.x.get(e),
            Handle.pos.y.get(e),
            Handle.theta.get(e),
        ]);

        expect(convertDomain(createHistory(), state, Domain.Time)).toBe(true);
        expect(
            [...state.query([Handle])].map((e) => [
                Handle.pos.x.get(e),
                Handle.pos.y.get(e),
                Handle.theta.get(e),
            ]),
        ).toEqual(nodes);
        expect(extent(state, geo)).toBe(0); // a geo section has no extent to convert
    });
});

describe("round trip", () => {
    // Meters → Seconds → Meters is NEAR-identical, never bit-identical, and the bound is
    // derivable exactly.
    //
    // The conversion itself is an exact inverse: both directions interpolate the SAME
    // piecewise-linear table, so `timeToArc(arcToTime(d)) === d` in exact arithmetic. What
    // moves is the table. Flipping to Seconds re-bakes the section with a time march
    // (`Δt = DT_NOMINAL`) where the distance bake used `Δs = DS_NOMINAL`, and the flip back
    // converts through THAT table. So
    //
    //     s' − s  =  timeToArc_B(t) − timeToArc_A(t),   t = arcToTime_A(s)
    //
    // — exactly the two bakes' disagreement at equal time, and nothing else. The tolerance is
    // therefore that disagreement, computed here from the two bakes' own tables (independent of
    // `domain.ts`), plus f32 quantization of the two `Force.s` stores.
    //
    // How LARGE that disagreement is belongs to the ride, not to this op: it is sub-quantum on
    // the gentle profile below, but tens of percent of the track on a sustained multi-g pull,
    // where the θ/v system amplifies the two marches' first-order difference. So the assertion
    // is the equality above (the conversion adds nothing of its own), never an absolute number.

    test("a level 1g ride round-trips EXACTLY — the analytic anchor", () => {
        // level + 1g ⇒ dθ = (1 − cos 0)·… = 0, so θ ≡ 0 and v ≡ v0 for both marches: each
        // table represents t = s/v0 exactly, so there is no disagreement to absorb.
        const { state, sec } = forceTrack(40, [
            [0, 1],
            [40, 1],
        ]);
        const before = kfs(state, sec);
        const h = createHistory();
        expect(convertDomain(h, state, Domain.Time)).toBe(true);
        // the forward value is t = s/v0 to the bake's own f32 arclength accumulation.
        expect(kfs(state, sec)[1]).toBeCloseTo(40 / V0, 5);
        state.step(0);
        expect(convertDomain(h, state, Domain.Distance)).toBe(true);
        expect(kfs(state, sec)).toEqual(before);
    });

    test("a varying-speed ride round-trips within the two bakes' own disagreement", () => {
        // 0.7 g through the middle: the cart dives and speeds up (v 10 → 16.3 m/s), so the
        // arc↔time map is strongly nonlinear and the two marches genuinely disagree.
        const { state, eid, sec } = forceTrack(40, [
            [0, 1],
            [20, 0.7],
            [40, 1],
        ]);
        const before = kfs(state, sec);
        const tabA = table(eid);
        const h = createHistory();

        expect(convertDomain(h, state, Domain.Time)).toBe(true);
        const times = kfs(state, sec);
        state.step(0);
        const tabB = table(eid);

        // the derived tolerance: max over the converted times of |arc_B(t) − arc_A(t)|.
        let disagree = 0;
        for (const t of [...times, extent(state, sec)])
            disagree = Math.max(
                disagree,
                Math.abs(interp(tabB.t, tabB.arc, t) - interp(tabA.t, tabA.arc, t)),
            );
        const arcTotal = tabA.arc[tabA.arc.length - 1];
        const tol = disagree + 4 * 2 ** -24 * arcTotal;

        expect(convertDomain(h, state, Domain.Distance)).toBe(true);
        const after = kfs(state, sec);
        for (let i = 0; i < before.length; i++)
            expect(Math.abs(after[i] - before[i])).toBeLessThanOrEqual(tol);

        // the bound is neither vacuous nor a freebie: the two marches DO disagree (so the
        // level-ride path above isn't what's being exercised), and the drift stays under one
        // bake quantum on a 40 m section.
        expect(disagree).toBeGreaterThan(0);
        expect(disagree).toBeLessThan(DS_NOMINAL);
    });
});

describe("undo", () => {
    /** every authored column the conversion can touch, in `sections` order. */
    function document(state: State) {
        return {
            domain: trackDomain(state),
            secs: sections(state).map((s) => ({
                id: s.id,
                order: s.order,
                kind: s.kind,
                length: s.length,
                ds: s.ds,
                points: sectionForces(state, s.id).map((p) => ({
                    id: p.id,
                    s: p.s,
                    g: p.g,
                    ease: Force.ease.get(p.eid),
                    tmode: Force.tmode.get(p.eid),
                    tin: [Force.tin.x.get(p.eid), Force.tin.y.get(p.eid)],
                    tout: [Force.tout.x.get(p.eid), Force.tout.y.get(p.eid)],
                })),
            })),
        };
    }

    test("undo restores the document byte-identical, redo re-lands it", () => {
        const { state, sec } = forceTrack(40, [
            [0, 1],
            [10, 1.6],
            [25, 0.6],
            [40, 1],
        ]);
        const ids = sectionForces(state, sec).map((p) => p.id);
        setForceTangent(state, ids[1], {
            mode: TangentMode.Free,
            in: { ds: -3, dg: -0.2 },
            out: { ds: 4, dg: 0.3 },
        });
        state.step(0);
        const before = document(state);
        const h = createHistory();

        expect(convertDomain(h, state, Domain.Time)).toBe(true);
        const converted = document(state);
        expect(converted).not.toEqual(before);

        undo(h, state);
        expect(document(state)).toEqual(before); // f32 columns respawned verbatim

        redo(h, state);
        expect(document(state)).toEqual(converted);
    });
});

describe("explicit easing handles", () => {
    test("Δs scales by the local slope dt/ds = 1/v; Δg passes through unchanged", () => {
        const { state, eid, sec } = forceTrack(40, [
            [0, 1],
            [20, 0.7],
            [40, 1],
        ]);
        const ids = sectionForces(state, sec).map((p) => p.id);
        setForceTangent(state, ids[1], {
            mode: TangentMode.Free,
            in: { ds: -3, dg: -0.2 },
            out: { ds: 4, dg: 0.3 },
        });
        state.step(0);
        const m = trackMapping(eid);
        if (!m) throw new Error("no mapping");
        // the speed the table itself carries over the interval holding the keyframe (d = 20 m,
        // the section being first so local s == global d).
        let lo = 0;
        while (lo + 2 < m.n && m.arc[lo + 1] <= 20) lo++;
        const v = (m.arc[lo + 1] - m.arc[lo]) / (m.t[lo + 1] - m.t[lo]);

        expect(convertDomain(createHistory(), state, Domain.Time)).toBe(true);
        const tan = forceTangent(state, ids[1]);
        if (!tan?.in || !tan.out) throw new Error("handles lost");
        expect(tan.in.ds).toBeCloseTo(-3 / v, 5);
        expect(tan.out.ds).toBeCloseTo(4 / v, 5);
        // unit-relative — the value axis never converts, so the f32 column is untouched.
        expect(tan.in.dg).toBe(Math.fround(-0.2));
        expect(tan.out.dg).toBe(Math.fround(0.3));
        expect(tan.mode).toBe(TangentMode.Free); // the tag rides through
    });
});

describe("degeneracies", () => {
    test("a plateau where the ride stalls: keyframes inside it collapse, by construction", () => {
        // 1.2 g sustained over 40 m drains the energy: v reaches zero and the cart never moves
        // again. In the Distance bake time runs away (ds/v̄ at the V_FLOOR clamp), so the
        // section's converted duration is enormous; the Time bake then MARCHES that duration at
        // Δt with the cart frozen, so its arclength plateaus EXACTLY (ds_i = v_i·Δt, v_i == 0).
        //
        // Converting back is therefore LOSSY on purpose: two keyframes at different times inside
        // a frozen stretch are at the same PLACE, so they must convert to the same arclength.
        // That's the documented data-loss-on-flip semantic, and undo is the way back.
        const { state, eid, sec } = forceTrack(40, [
            [0, 1],
            [20, 1.2],
            [40, 1],
        ]);
        const out = bakeOut.get(eid);
        if (!out) throw new Error("no bake");
        expect(out.firstInfeasible).toBeGreaterThanOrEqual(0); // the stall is really there
        const h = createHistory();

        expect(convertDomain(h, state, Domain.Time)).toBe(true);
        const times = kfs(state, sec);
        expect(times.every(Number.isFinite)).toBe(true);
        for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1]);
        state.step(0);

        const outB = bakeOut.get(eid);
        if (!outB) throw new Error("no bake");
        let zeroEdges = 0;
        for (let i = 0; i < Track.count.get(eid) - 1; i++) if (outB.ds[i] === 0) zeroEdges++;
        expect(zeroEdges).toBeGreaterThan(0); // the exact plateau really is in the table

        // author two MORE keyframes deep inside the frozen stretch, then flip back.
        const dur = extent(state, sec);
        const stallIds = [
            createForcePoint(state, sec, dur * 0.7, 1),
            createForcePoint(state, sec, dur * 0.85, 1),
        ];
        // plus one PAST the duration, so it extrapolates on a section whose last interval is
        // itself frozen — the one place the 0/0 slope actually divides work.
        const pastId = createForcePoint(state, sec, dur * 1.2, 1);
        state.step(0);
        const arcEnd = arcTotal(eid);
        const authored = kfs(state, sec);
        expect(convertDomain(h, state, Domain.Distance)).toBe(true);
        const back = kfs(state, sec);
        expect(back.every(Number.isFinite)).toBe(true);
        for (let i = 1; i < back.length; i++) expect(back[i]).toBeGreaterThanOrEqual(back[i - 1]);
        // the collapse, asserted as behaviour: the two stall-interior keyframes land on the SAME
        // arclength, byte-identical — the cart is not moving there, so there is no other answer.
        const landed = stallIds.map((id) => {
            const row = sectionForces(state, sec).find((p) => p.id === id);
            if (!row) throw new Error(`keyframe ${id} lost`);
            return row.s;
        });
        expect(landed[1]).toBe(landed[0]);
        expect(extent(state, sec)).toBeGreaterThanOrEqual(MIN_FORCE_LEN);

        // the past-duration keyframe extrapolates at `V_FLOOR` — the frozen section's exit
        // interval reads 0/0, and resolving it at the engine's own slowest meaningful speed is
        // what keeps the keyframe PAST the section end instead of pinned exactly onto it.
        const past = sectionForces(state, sec).find((p) => p.id === pastId);
        if (!past) throw new Error("past-span keyframe lost");
        expect(past.s).toBeGreaterThan(arcEnd);
        expect(past.s).toBeCloseTo(arcEnd + (dur * 1.2 - dur) * V_FLOOR, 3);

        // and undo brings them back distinct — the lossy flip is recoverable, always.
        undo(h, state);
        const restored = kfs(state, sec);
        expect(restored).toEqual(authored);
        expect(new Set(restored).size).toBe(restored.length);
    });

    test("a keyframe past its section's span extrapolates at the boundary speed, symmetric", () => {
        // the extent is trimmed below the last keyframe's s: shortening stops sampling there
        // but the keyframe persists (non-destructive trim), so its position sits past the
        // section's whole baked span. On a level 1g ride v ≡ V0 exactly, so the answer is
        // analytic — t = s / V0 — for the extrapolated point as much as the interior ones.
        const { state, eid, sec } = forceTrack(20, [
            [0, 1],
            [20, 1],
            [30, 1], // 10 m past the extent
        ]);
        const out = bakeOut.get(eid);
        if (!out) throw new Error("no bake");
        const tTotal = out.tTotal;
        const h = createHistory();

        expect(convertDomain(h, state, Domain.Time)).toBe(true);
        const times = kfs(state, sec);
        expect(times[2]).toBeCloseTo(30 / V0, 4);
        // the failure this guards: a plain table lookup CLAMPS at the last station, collapsing
        // the past-span keyframe onto the track end.
        expect(times[2]).toBeGreaterThan(tTotal);
        expect(times[1]).toBeCloseTo(tTotal, 4);

        state.step(0);
        expect(convertDomain(h, state, Domain.Distance)).toBe(true);
        expect(kfs(state, sec)[2]).toBeCloseTo(30, 4); // symmetric — the same slope back
    });

    test("past-span is per SECTION: an interior section extrapolates at ITS OWN exit speed", () => {
        // section A is a level 1g ride trimmed to 20 m with a keyframe at s = 40 — 20 m past its
        // own span — and a DIVING section B follows it. A's exit speed is exactly V0, so the
        // keyframe's honest time is 40/V0 = 4.0 s. Composing into B's territory instead would run
        // the extra 20 m through B's (much higher) speeds and report ~3.53 s.
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        const a = createSection(state, 0, SectionKind.Force, 20);
        createForcePoint(state, a, 0, 1);
        createForcePoint(state, a, 20, 1);
        createForcePoint(state, a, 40, 1); // 20 m past A's extent
        const b = createSection(state, 1, SectionKind.Force, 60);
        createForcePoint(state, b, 0, 0.2); // dive hard — B runs much faster than A
        createForcePoint(state, b, 60, 0.2);
        state.step(0);
        const m = trackMapping(eid);
        if (!m) throw new Error("no mapping");
        const infoB = sectionInfo.get(b);
        if (!infoB) throw new Error("no bake for B");
        const vB =
            (m.arc[infoB.endSample] - m.arc[infoB.startSample]) /
            (m.t[infoB.endSample] - m.t[infoB.startSample]);
        expect(vB).toBeGreaterThan(V0 * 1.2); // B really is the faster stretch

        expect(convertDomain(createHistory(), state, Domain.Time)).toBe(true);
        // A's own exit speed, not the composition through B.
        expect(kfs(state, a)[2]).toBeCloseTo(40 / V0, 3);
        // and B's keyframes are unaffected by A's overhang.
        expect(kfs(state, b)[0]).toBe(0);
    });
});

describe("the time march the document threads", () => {
    test("a Time-domain bake's t table IS the march's accumulated Δt — one truth", () => {
        // `computeTime` derives t = Σ ds/v̄ wherever a section has no marched time. A Time-domain
        // force section HAS one, and a keyframe's stored t is that accumulated march time by
        // construction, so the table must carry it: deriving instead is a second truth that
        // diverges without bound at a stall (measured 155.45 s marched vs 3.77 s derived).
        const { state, eid, sec } = forceTrack(40, [
            [0, 1],
            [20, 1.2], // stalls: v reaches zero and the derived time runs away
            [40, 1],
        ]);
        expect(convertDomain(createHistory(), state, Domain.Time)).toBe(true);
        const duration = extent(state, sec);
        state.step(0);

        const out = bakeOut.get(eid);
        if (!out) throw new Error("no bake");
        const edges = Track.count.get(eid) - 1;
        // the march: `edges` steps of Δt = DT_NOMINAL (the sentinel-0 nominal). `out.t` is f32, so
        // the tolerance is its accumulation error — one rounding per edge, each at most 2^-24
        // relative — and a per-edge difference is exact to a couple of f32 ulps at that magnitude.
        expect(Math.abs(out.tTotal - edges * DT_NOMINAL)).toBeLessThanOrEqual(
            edges * 2 ** -24 * out.tTotal,
        );
        // and it spans the authored duration: `forceProfile` takes round(duration/Δt) edges, so the
        // realized total is within half a step of it, plus the same f32 accumulation.
        expect(Math.abs(out.tTotal - duration)).toBeLessThanOrEqual(
            DT_NOMINAL / 2 + edges * 2 ** -24 * out.tTotal,
        );
        const ulp = 2 ** (Math.ceil(Math.log2(out.tTotal)) - 23);
        for (let i = 0; i + 1 < Track.count.get(eid); i++)
            expect(Math.abs(out.t[i + 1] - out.t[i] - DT_NOMINAL)).toBeLessThanOrEqual(2 * ulp);

        // the derived reading, for contrast: the stall's frozen edges have ds == 0, so Σ ds/v̄
        // stops advancing entirely and would report a fraction of the real duration.
        let derived = 0;
        for (let i = 0; i < edges; i++) {
            const vA = Math.max(Math.abs(samples.get(eid)?.v[i] ?? 0), V_FLOOR);
            const vB = Math.max(Math.abs(samples.get(eid)?.v[i + 1] ?? 0), V_FLOOR);
            derived += out.ds[i] / (0.5 * (vA + vB));
        }
        expect(derived).toBeLessThan(out.tTotal / 10);
    });

    test("a Distance-domain track's t table stays derived, byte-identical", () => {
        // the marched override must be inert wherever nothing marched in time — geo sections and
        // every Distance-domain force section keep `t = Σ ds/v̄` exactly.
        const { eid } = forceTrack(40, [
            [0, 1],
            [20, 0.7],
            [40, 1],
        ]);
        const out = bakeOut.get(eid);
        const s = samples.get(eid);
        if (!out || !s) throw new Error("no bake");
        let derived = 0;
        for (let i = 0; i + 1 < Track.count.get(eid); i++) {
            const vA = Math.max(Math.abs(s.v[i]), V_FLOOR);
            const vB = Math.max(Math.abs(s.v[i + 1]), V_FLOOR);
            derived = Math.fround(derived + out.ds[i] / (0.5 * (vA + vB)));
            expect(out.t[i + 1]).toBe(derived);
        }
    });

    test("a Time-domain flat 1g section marches ds = v·DT_NOMINAL", () => {
        const { state, eid, sec } = forceTrack(40, [
            [0, 1],
            [40, 1],
        ]);
        expect(convertDomain(createHistory(), state, Domain.Time)).toBe(true);
        state.step(0);
        const out = bakeOut.get(eid);
        if (!out) throw new Error("no bake");
        const count = Track.count.get(eid);
        // level 1g holds v at the entry speed, so every realized edge is exactly V0·DT_NOMINAL
        // — which is DS_NOMINAL by DT_NOMINAL's own derivation.
        expect(V0 * DT_NOMINAL).toBeCloseTo(DS_NOMINAL, 10);
        for (let i = 0; i < count - 1; i++) expect(out.ds[i]).toBeCloseTo(V0 * DT_NOMINAL, 5);
        expect(count - 1).toBe(Math.round(extent(state, sec) / DT_NOMINAL));
    });
});

describe("selection across the conversion", () => {
    // `landDomain`'s undo replays the whole-track `restoreAll` pair, which destroys and respawns
    // every node and keyframe; the eid allocator recycles LIFO, so an undo without the selection
    // hook's `pre` snapshot leaves the selection naming a DIFFERENT entity. The do-path writes in
    // place, so the live eid survives the flip itself.
    test("a selected node survives the conversion and its undo, by identity not eid", () => {
        setSelectionHook(selectionHook);
        try {
            const state = new State();
            state.addSystem(BakeSystem);
            createTrack(state);
            const geo = createSection(state, 0, SectionKind.Geo, 0);
            addNode(state, geo, 0, 0);
            addNode(state, geo, 24, 0);
            addNode(state, geo, 48, 4);
            const force = createSection(state, 1, SectionKind.Force, 30);
            createForcePoint(state, force, 0, 1);
            createForcePoint(state, force, 30, 0.8);
            state.step(0);

            const target = handleAt(state, geo, 2);
            if (target === null) throw new Error("no node");
            select(target);
            const h = createHistory();

            // the do-path touches no entity, so the live eid is still the same node.
            expect(convertDomain(h, state, Domain.Time)).toBe(true);
            expect(editor.nodes.active).toBe(target);

            undo(h, state);
            const active = editor.nodes.active;
            if (active === null) throw new Error("selection lost across the undo");
            // the eid may legitimately have been recycled; the IDENTITY must not move.
            expect(Handle.section.get(active)).toBe(geo);
            expect(Handle.order.get(active)).toBe(2);
        } finally {
            select(null);
            setSelectionHook(null);
        }
    });
});
