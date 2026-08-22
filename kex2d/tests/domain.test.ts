import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { editor, select, selectionHook } from "../src/editor";
import { State } from "@dylanebert/shallot";
import { V_FLOOR, V_WARN } from "../src/bake";
import { trackMapping } from "../src/cart";
import {
    carryForce,
    convertDomain,
    convertFailed,
    convertible,
    convertSolve,
    pickable,
    resolutionFloor,
} from "../src/domain";
import { Easing, type ForcePoint, resolveStep, sampleForce } from "../src/profile";
import {
    createForce,
    createHistory,
    deleteForces,
    redo,
    setSelectionHook,
    undo,
} from "../src/history";
import { Domain } from "../src/section";
import { TangentMode } from "../src/spline";
import {
    appendSection,
    BakeSystem,
    bakeOut,
    createForcePoint,
    createSection,
    createStrip,
    createTrack,
    DS_NOMINAL,
    DT_NOMINAL,
    Force,
    forceCarried,
    forceEase,
    forceTangent,
    Handle,
    handleAt,
    MAX_SAMPLES,
    MIN_FORCE_LEN,
    minForceExtent,
    samples,
    Section,
    sectionAt,
    SectionKind,
    sectionForces,
    sectionInfo,
    sections,
    sectionStrips,
    stripCoversOneEdge,
    type ForceTangent,
    setForceCarried,
    setForcePoint,
    setForceTangent,
    splitForce,
    setTrackDomain,
    setTrackV0,
    spanCoversOneEdge,
    Track,
    trackDomain,
    trackEntity,
    V0,
    addNode,
} from "../src/track";

// `domain.convertDomain` — the track-global domain conversion op. `Track.domain` says what
// unit every force keyframe's `s` and every force section's extent are stored in, so the
// ruler-menu pick is a DOCUMENT conversion: one history entry that flips the domain and
// rewrites the store through the live bake's arc↔time table.
//
// The tests below are device-free (canvas2D + a bare `State`) and split by what they pin:
//
//   1. the guards — no live bake, the already-active domain, a section off the bake — plus
//      `convertible` and `pickable`, the ruler menu's row-enablement rule over the same reading;
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
    // the bake's own per-edge ds is the arclength CONVENTION (stage-7 review finding C: the
    // freeze's gap edge is zero-length over a real position jump, so a chord re-derive diverges
    // from the chart axis). the independence this helper supplies is the window/interp logic,
    // not the axis source — both sides must speak the one ds axis.
    for (let i = 1; i < n; i++) arc.push(arc[i - 1] + out.ds[i - 1]);
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

/** the AUTHORED keyframe stations, ascending — conversion-inserted (`carried`) keys excluded.
 *  Every arm below that indexes this list is a claim about where the person's own keys land, and
 *  the carry plants extra keys between them (`describe("the carry")`), so an unfiltered read would
 *  index a carried key and pin nothing about authored placement. `carriedKfs` is the other half. */
const kfs = (state: State, sec: number): number[] =>
    sectionForces(state, sec)
        .filter((p) => !p.carried)
        .map((p) => p.s);

/** the conversion-inserted keyframe stations, ascending. */
const carriedKfs = (state: State, sec: number): number[] =>
    sectionForces(state, sec)
        .filter((p) => p.carried)
        .map((p) => p.s);
const extent = (state: State, sec: number): number => {
    const eid = sectionAt(state, sec);
    if (eid === null) throw new Error("no section");
    return Section.length.get(eid);
};

// ── single-flip world-position snapshot — `describe("single flip")` below ────────────────────

interface Pos {
    x: number;
    y: number;
}

interface WorldBake {
    t: number[];
    x: number[];
    y: number[];
}

/** a plain-array COPY of the bake's own per-sample time + world position — never the live
 *  `samples`/`bakeOut` typed arrays, which the next re-bake mutates in place (the same buffer is
 *  reused for the whole track's lifetime), so a reference captured before a flip would silently
 *  read the POST-flip values by the time it's compared against them. */
function bakeSnapshot(eid: number): WorldBake {
    const s = samples.get(eid);
    const out = bakeOut.get(eid);
    if (!s || !out) throw new Error("no bake");
    const n = Track.count.get(eid);
    return {
        t: Array.from(out.t.subarray(0, n)),
        x: Array.from(s.posX.subarray(0, n)),
        y: Array.from(s.posY.subarray(0, n)),
    };
}

/** world position at elapsed time `t`, linear-interpolated over a bake's own per-sample march
 *  clock — `domain.lab.ts`'s `worldAtTime`, re-derived here over a plain-array snapshot instead
 *  of the lab's live typed-array references. */
function worldAtTime(b: WorldBake, t: number): Pos {
    const { t: ts, x, y } = b;
    const n = ts.length;
    if (t <= ts[0]) return { x: x[0], y: y[0] };
    if (t >= ts[n - 1]) return { x: x[n - 1], y: y[n - 1] };
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (ts[mid] <= t) lo = mid;
        else hi = mid;
    }
    const span = ts[hi] - ts[lo];
    const f = span > 0 ? (t - ts[lo]) / span : 0;
    return { x: x[lo] + f * (x[hi] - x[lo]), y: y[lo] + f * (y[hi] - y[lo]) };
}

const worldDist = (a: Pos, b: Pos): number => Math.hypot(a.x - b.x, a.y - b.y);

// ── D1: the domain carry ─────────────────────────────────────────────────────────────

/** the authored force curve as `profile.sampleForce` consumes it — keys WITH their easing tags and
 *  explicit handles. Reading `{s, g}` alone is the instrument trap this suite met once: the carried
 *  keys hold the carry's whole first-order content in their handles, so a handle-blind read reported
 *  a 0.078 g flip delta where the real curve moved 0.0044 g. */
const profilePts = (state: State, sec: number): ForcePoint[] =>
    sectionForces(state, sec).map((p) => {
        const tan = forceTangent(state, p.id);
        const pt: ForcePoint = { s: p.s, g: p.g, ease: forceEase(state, p.id) };
        if (tan?.in) pt.in = tan.in;
        if (tan?.out) pt.out = tan.out;
        return pt;
    });

/** the two fixtures the carry is measured on, rebuilt from § Domain fidelity's own description plus
 *  S1's recorded resolution floors (0.0225 g and 0.195 g, cross-checked in the first arm below).
 *  `pull` is the largest speed swing that does NOT stall (v 10 → 3.77 m/s): every longer or heavier
 *  variant measured brought the cart to `V_FLOOR`, which is a different subject (the stall
 *  degeneracy) rather than a harder carry. */
const DIVE_AND_RECOVER: [number, [number, number][]] = [
    40,
    [
        [0, 1],
        [20, 0.4],
        [40, 1],
    ],
];
const MULTI_G_PULL: [number, [number, number][]] = [
    24,
    [
        [0, 1],
        [11.5, 4],
        [12.5, 4],
        [24, 1],
    ],
];

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

    // `convertible` is the row-enablement reading: the ruler menu grays its inactive row on
    // exactly what `convertDomain` rejects on, so a blocked pick shows as blocked instead of
    // clicking through to a silent no-op. Each case below pins the two answers together.
    test("convertible reads true exactly when the conversion can run", () => {
        const { state } = forceTrack(40, [
            [0, 1],
            [40, 1],
        ]);
        const h = createHistory();
        expect(convertible(state)).toBe(true);
        expect(convertDomain(h, state, Domain.Time)).toBe(true);
    });

    test("convertible is false with no bake and with a stale one", () => {
        const fresh = new State();
        fresh.addSystem(BakeSystem);
        createTrack(fresh);
        const sec = createSection(fresh, 0, SectionKind.Force, 40);
        createForcePoint(fresh, sec, 0, 1);
        createForcePoint(fresh, sec, 40, 1);
        expect(convertible(fresh)).toBe(false); // never stepped

        const { state, sec: sec2 } = forceTrack(40, [
            [0, 1],
            [40, 1],
        ]);
        expect(convertible(state)).toBe(true);
        createForcePoint(state, sec2, 20, 1.2); // authored past the last bake
        expect(convertible(state)).toBe(false);
    });

    // `pickable` is the ruler menu's ONE enablement rule over that reading: the ACTIVE row always
    // (its pick is a no-op by the menu law), a CONVERTING row only when the conversion can run.
    // The row that must gray is the one the author would otherwise click into a silent no-op.
    test("pickable: the active row is always enabled, the converting row follows convertible", () => {
        const { state, sec } = forceTrack(40, [
            [0, 1],
            [40, 1],
        ]);
        const h = createHistory();
        // live bake, Distance active: both rows offer something real.
        expect(pickable(state, Domain.Distance)).toBe(true);
        expect(pickable(state, Domain.Time)).toBe(true);

        // flip to Time and re-bake: now Meters is the converting row and Seconds the no-op.
        expect(convertDomain(h, state, Domain.Time)).toBe(true);
        state.step(0);
        expect(pickable(state, Domain.Time)).toBe(true);
        expect(pickable(state, Domain.Distance)).toBe(true);

        // an edit past the last bake leaves nothing to convert THROUGH — the converting row grays
        // while the active one stays lit, in both directions.
        createForcePoint(state, sec, 1, 1.1);
        expect(convertible(state)).toBe(false);
        expect(pickable(state, Domain.Time)).toBe(true); // the active row: still a no-op
        expect(pickable(state, Domain.Distance)).toBe(false); // …and the pick is blocked
        state.step(0);
        expect(pickable(state, Domain.Distance)).toBe(true); // the re-bake unblocks it
    });

    test("a force section past the sample cap blocks the whole conversion", () => {
        // the flat SoA is capped at `MAX_SAMPLES`. Post `kex2d-correctness-fixes` stage 2c,
        // `chain` clips a force section's copy at the buffer's end (never reporting a would-be
        // count past it), so a section placed past the cap carries an EMPTY sample range clamped
        // at the buffer's last index — `windowOf`'s `end <= start` rejects it exactly as it did
        // when the range was merely out of bounds instead of empty. Converting through it would
        // otherwise write NaN into every one of that section's keyframes, so the op rejects the
        // WHOLE track (a partial conversion would leave metres and seconds side by side in one
        // store) and the menu row grays on the same reading.
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        const long = createSection(state, 0, SectionKind.Force, MAX_SAMPLES * DS_NOMINAL * 2);
        createForcePoint(state, long, 0, 1);
        const tail = createSection(state, 1, SectionKind.Force, 40);
        createForcePoint(state, tail, 0, 1);
        createForcePoint(state, tail, 40, 1);
        state.step(0);
        const info = sectionInfo.get(tail);
        if (!info) throw new Error("no bake for the tail section");
        // an EMPTY range at the buffer's last index — it really is off the buffer, never a start
        // past `MAX_SAMPLES`.
        expect(info.startSample).toBe(info.endSample);
        expect(info.startSample).toBe(MAX_SAMPLES - 1);
        expect(Track.count.get(eid)).toBe(MAX_SAMPLES); // …which the published count stops at

        const h = createHistory();
        expect(convertible(state)).toBe(false);
        expect(convertDomain(h, state, Domain.Time)).toBe(false);
        expect(trackDomain(state)).toBe(Domain.Distance);
        expect(kfs(state, tail)).toEqual([0, 40]);
        expect(h.undo.length).toBe(0);
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

// C3's own seam: a strip's `start`/`end` convert exactly like a keyframe's `s` — each
// endpoint independently, through the section's own window — while `value` (m/s) is
// domain-independent and passes through unconverted. The wrong-granularity headline: an
// INTERIOR-start, INTERIOR-end strip, both directions (Distance→Time and Time→Distance) —
// a whole-section strip would pass even a broken endpoint conversion, since a boundary
// landing exactly at 0 or the section's own extent is the one case every off-by-one bug
// also gets right (the wrong-granularity headline arm).
describe("velocity strip endpoints (C3)", () => {
    const f32Tol = (magnitude: number) => 2 ** -24 * Math.max(1, magnitude);

    test("Distance→Time: an interior strip's start/end convert through the section's own window; value is untouched", () => {
        const { state, eid, sec } = forceTrack(40, [
            [0, 1],
            [10, 1.6],
            [25, 0.6],
            [40, 1],
        ]);
        const stripId = createStrip(state, sec, 12, 28, 7.5) as number; // interior, off any keyframe
        expect(stripId).not.toBeNull();
        state.step(0); // the new strip enters the bake hash — re-bake before reading the table
        const tab = table(eid);
        const h = createHistory();

        expect(convertDomain(h, state, Domain.Time)).toBe(true);
        expect(trackDomain(state)).toBe(Domain.Time);
        const after = sectionStrips(state, sec)[0];
        const wantStart = interp(tab.arc, tab.t, 12);
        const wantEnd = interp(tab.arc, tab.t, 28);
        expect(after.start).toBeCloseTo(wantStart, 6);
        expect(Math.abs(after.start - wantStart)).toBeLessThanOrEqual(f32Tol(wantStart));
        expect(after.end).toBeCloseTo(wantEnd, 6);
        expect(Math.abs(after.end - wantEnd)).toBeLessThanOrEqual(f32Tol(wantEnd));
        expect(after.value).toBe(7.5); // velocity is not a station — unconverted
        expect(after.start).toBeGreaterThan(0); // still interior, not collapsed to an endpoint
        expect(after.end).toBeLessThan(extent(state, sec));
    });

    test("Time→Distance: an interior strip's start/end convert through the section's own window; value is untouched", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        setTrackDomain(state, Domain.Time);
        const sec = createSection(state, 0, SectionKind.Force, 4); // 4 s, off-flat profile
        createForcePoint(state, sec, 0, 1.3);
        createForcePoint(state, sec, 1.5, 0.7);
        createForcePoint(state, sec, 4, 1.3);
        state.step(0);
        const stripId = createStrip(state, sec, 1, 3, 6) as number; // interior seconds
        expect(stripId).not.toBeNull();
        state.step(0);
        const tab = table(eid);
        const h = createHistory();

        expect(convertDomain(h, state, Domain.Distance)).toBe(true);
        expect(trackDomain(state)).toBe(Domain.Distance);
        const after = sectionStrips(state, sec)[0];
        // the inverse table lookup: distance where the bake's own arc↔time table reads t=1/t=3.
        const wantStart = interp(tab.t, tab.arc, 1);
        const wantEnd = interp(tab.t, tab.arc, 3);
        expect(after.start).toBeCloseTo(wantStart, 6);
        expect(Math.abs(after.start - wantStart)).toBeLessThanOrEqual(f32Tol(wantStart));
        expect(after.end).toBeCloseTo(wantEnd, 6);
        expect(Math.abs(after.end - wantEnd)).toBeLessThanOrEqual(f32Tol(wantEnd));
        expect(after.value).toBe(6);
        expect(after.start).toBeGreaterThan(0);
        expect(after.end).toBeLessThan(extent(state, sec));
    });

    test("a strip on a geo section passes through untouched, like a geo node", () => {
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
        createStrip(state, geo, 5, 15, 4);
        state.step(0);
        const before = sectionStrips(state, geo)[0];

        expect(convertDomain(createHistory(), state, Domain.Time)).toBe(true);
        const after = sectionStrips(state, geo)[0];
        expect(after).toEqual(before);
    });

    // ── B2(b): the min-extent law is stated over stored spans under the current bake, and the
    // domain flip rewrites strip start/end through the arc↔time map with no floor — three lines
    // below the same object literal applying `Math.max(floor, …)` to `length`. A min-extent
    // Distance strip (one edge = ds = 0.5 m) converts to a Time extent of ds/V seconds, which is
    // sub-edge when V > V0 (10 m/s) — on any drop. The floor ensures the converted extent covers
    // ≥ 1 edge of the target domain's bake. WITNESSED RED before the floor: a Distance strip at
    // [0, 0.5) (one edge) flipped to Time at V > V0 produced a sub-edge span that mapped to zero
    // overridden edges — silently inert.
    test("B2(b): a min-extent Distance strip's extent is floored on Distance→Time flip", () => {
        const { state, sec } = forceTrack(40, [
            [0, 1],
            [40, 1],
        ]);
        state.step(0);
        // create a min-extent (1-edge) Distance strip: [0, 0.5)
        const stripId = createStrip(state, sec, 0, DS_NOMINAL, 5) as number;
        expect(stripId).not.toBeNull();
        state.step(0);
        const h = createHistory();

        expect(convertDomain(h, state, Domain.Time)).toBe(true);
        const after = sectionStrips(state, sec)[0];
        // the strip must still cover ≥ 1 edge in the Time bake — the same predicate every
        // other write path checks, not a nominal-size proxy (which can differ from the resolved
        // ds by f32 precision or the round-up case)
        expect(stripCoversOneEdge(state, sec, after.start, after.end)).toBe(true);
    });

    test("B2(b): a min-extent Time strip's extent is floored on Time→Distance flip", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        setTrackDomain(state, Domain.Time);
        const sec = createSection(state, 0, SectionKind.Force, 4);
        createForcePoint(state, sec, 0, 1.3);
        createForcePoint(state, sec, 4, 1.3);
        state.step(0);
        // create a min-extent (1-edge) Time strip: [0, DT_NOMINAL = 0.05)
        const stripId = createStrip(state, sec, 0, DT_NOMINAL, 5) as number;
        expect(stripId).not.toBeNull();
        state.step(0);
        const h = createHistory();

        expect(convertDomain(h, state, Domain.Distance)).toBe(true);
        const after = sectionStrips(state, sec)[0];
        // the strip must still cover ≥ 1 edge in the Distance bake — the same predicate every
        // other write path checks, not a nominal-size proxy
        expect(stripCoversOneEdge(state, sec, after.start, after.end)).toBe(true);
    });

    // PASS-5 (2): the floor must call the same `spanCoversOneEdge`-on-resolved-`ds` predicate
    // every other write path calls, not a `< targetNominal` proxy. The proxy is unsafe in the
    // round-DOWN case: `resolveStep(length, nominal)` gives `edges = round(length/nominal)`,
    // `ds = length/edges`, so when `length/nominal` rounds down, `ds > nominal`. A span of
    // exactly `targetNominal` at an unlucky phase then reads `spanCoversOneEdge === false`
    // (both endpoints map to the same edge boundary), a silently-inert sub-edge strip the
    // floor exists to prevent.
    //
    // RED-FIRST WITNESS: force section length 10.045, step 0.5 → `resolveStep` gives
    // edges 20, ds 0.50225 > 0.5. A strip of length exactly `targetNominal` (0.5) at phase 0
    // reads `spanCoversOneEdge === true` (boundary(0)=0, boundary(0.5)=1). At phase ≈0.252
    // it reads `spanCoversOneEdge === false` (boundary(0.252)=1, boundary(0.752)=1 — both
    // endpoints on edge 1). At `bb9e638` the `< targetNominal` proxy did not floor this
    // strip (0.5 is not < 0.5), so the flip stored a silently-inert sub-edge strip. After
    // the fix, the `spanCoversOneEdge` predicate catches it and the floor extends to
    // `resolved.ds` (0.50225).
    test("the floor uses spanCoversOneEdge, not the nominal-size proxy, at the unlucky phase (pass-5 deliverable 2)", () => {
        // The round-DOWN case: resolveStep(10.045, 0.5) gives edges 20, ds 0.50225 > 0.5.
        // A span of exactly targetNominal (0.5) at the unlucky phase reads spanCoversOneEdge === false
        // (both endpoints round to the same edge boundary), but the old `< targetNominal` proxy
        // would not floor it (0.5 is not < 0.5). The new spanCoversOneEdge predicate catches it.
        const resolved = resolveStep(10.045, DS_NOMINAL);
        expect(resolved.edges).toBe(20);
        expect(resolved.ds).toBeGreaterThan(DS_NOMINAL);
        const targetDs = new Float32Array(resolved.edges).fill(resolved.ds);
        // at phase 0, the span [0, 0.5) DOES cover one edge (boundary(0)=0, boundary(0.5)=1)
        expect(spanCoversOneEdge(targetDs, resolved.edges, 0, DS_NOMINAL)).toBe(true);
        // at the unlucky phase (~0.252, near the midpoint of edge 0), the span [0.252, 0.752)
        // has both endpoints round to edge 1 — zero edges, silently inert
        const unluckyStart = 0.252;
        expect(
            spanCoversOneEdge(targetDs, resolved.edges, unluckyStart, unluckyStart + DS_NOMINAL),
        ).toBe(false);
        // the old proxy: 0.5 < 0.5 is false → would NOT floor → silently inert strip
        // the new predicate: spanCoversOneEdge === false → DOES floor → extends to resolved.ds
    });
});

describe("round trip", () => {
    // Meters → Seconds → Meters is NEAR-identical, never bit-identical, and the bound is
    // derivable exactly.
    //
    // The conversion itself is an exact inverse: both directions interpolate the SAME
    // piecewise-linear table, so `timeToArc(arcToTime(d)) === d` in exact arithmetic. What
    // moves is the table. Flipping to Seconds re-bakes the section at its own EXACT step
    // (`length/edges`, the `kex2d-section-extent` conforming rule — never the nominal
    // `DT_NOMINAL` quantum, which would leave the Time-domain march short of the converted
    // duration) where the distance bake used its own exact `Δs`, and the flip back converts
    // through THAT table. So
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

    test("a level 1g ride round-trips within the two bakes' own disagreement — the analytic anchor", () => {
        // level + 1g ⇒ dθ = (1 − cos 0)·… = 0, so θ ≡ 0 and v ≡ v0 for both marches: there is
        // no PHYSICS disagreement to absorb (unlike the varying-speed ride below, where the
        // θ/v system itself amplifies a first-order difference). What's left is a pure
        // quantization one — the forward bake's arc→time table is built from the exact
        // `Δs = length/edges`, the reverse bake's time→arc table from the exact `Δt =
        // duration/edges` conforming to the FLOATED (not bit-exact) converted duration — a
        // scheme difference between the two exact steps, not a physics one, so it stays far
        // below the varying-speed ride's bound even though it's no longer exactly zero.
        const { state, eid, sec } = forceTrack(40, [
            [0, 1],
            [40, 1],
        ]);
        const before = kfs(state, sec);
        const tabA = table(eid);
        const h = createHistory();
        expect(convertDomain(h, state, Domain.Time)).toBe(true);
        // the forward value is t = s/v0 to the bake's own f32 arclength accumulation.
        expect(kfs(state, sec)[1]).toBeCloseTo(40 / V0, 5);
        state.step(0);
        const tabB = table(eid);

        let disagree = 0;
        for (const t of [...kfs(state, sec), extent(state, sec)])
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

        // no PHYSICS disagreement: the quantization-only gap stays orders below the
        // varying-speed ride's (which also bounds it under one bake quantum).
        expect(disagree).toBeLessThan(1e-3);
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

describe("single flip", () => {
    // Stage 3b's verdict (`kex2d-correctness-fixes`, Locked decision): a SINGLE flip moves the
    // exit too, by the same mechanism and inside the same bound the round trip above already
    // derives — the two-bakes-at-equal-time disagreement. **What this describe measures is the baked
    // WORLD exit, and that is all it ever measured.** The story it used to tell about the curve — that
    // the segment between keys genuinely reshapes across a flip, since a cubic bezier authored in
    // (s, g) is not one in (t, g) under the nonlinear arc↔time map and an explicit handle's Δs scaling
    // is only that map's first-order term — was the pre-carry document. D1 closed it: `carryForce`
    // subdivides until the reshape sits inside the march's own resolution floor (`describe("the carry
    // (D1)")`, which is where that property is now pinned). The exit deviation this bound covers is
    // the two marches disagreeing at equal elapsed time, not the curve, and the carry leaves it
    // exactly where it was — which is why this arm reads unchanged across D1.
    //
    // Computed the way `domain.lab.ts` computes it (world Euclidean distance at the force
    // section's exit; the disagreement swept over the section's WHOLE sample range at equal
    // elapsed time, not just the keyframe stations) — a keyframe-only probe under-reads: at this
    // ride's own numbers, checking disagreement only at the keyframe stations gives 0.20437…,
    // which the measured exit deviation of 0.20438… already exceeds. The keys land almost exactly
    // right; the reshape between them is what only the swept sweep catches.
    //
    // What this bound does NOT guard: it's measured on the same bake pair as the deviation it
    // bounds, and the exit's own equal-time disagreement is a member of the swept set — so a
    // conversion defect that corrupts key placement inflates both sides together and this test
    // stays green through it. That's fine here (the property under test IS the consistency
    // between the two, not key placement), but key placement is a separate claim, pinned instead
    // by the round-trip test above against an independently-rebuilt table.

    test("a single flip's exit deviation stays inside the two-bakes-at-equal-time bound", () => {
        const { state, eid, sec } = forceTrack(40, [
            [0, 1],
            [20, 0.4],
            [40, 1],
        ]);
        const infoBefore = sectionInfo.get(sec);
        if (!infoBefore) throw new Error("no bake for section");
        const bakeA = bakeSnapshot(eid);
        const exitBefore = { x: bakeA.x[infoBefore.endSample], y: bakeA.y[infoBefore.endSample] };

        const h = createHistory();
        expect(convertDomain(h, state, Domain.Time)).toBe(true);
        state.step(0);

        const infoAfter = sectionInfo.get(sec);
        if (!infoAfter) throw new Error("no bake for section");
        const bakeB = bakeSnapshot(eid);
        const exitAfter = { x: bakeB.x[infoAfter.endSample], y: bakeB.y[infoAfter.endSample] };
        const exitDeviation = worldDist(exitBefore, exitAfter);

        // the honest bound: how far the two independent marches (Δs-nominal, then Δt-nominal)
        // disagree at equal elapsed time, swept over the section's whole sample range — not just
        // its keyframe stations, per the comment above.
        let twoBakeDisagreement = 0;
        for (let idx = infoAfter.startSample; idx <= infoAfter.endSample; idx++) {
            const t = bakeB.t[idx];
            const a = worldAtTime(bakeA, t);
            const b = { x: bakeB.x[idx], y: bakeB.y[idx] };
            twoBakeDisagreement = Math.max(twoBakeDisagreement, worldDist(a, b));
        }

        // not vacuous: the flip really does move the exit, and the assertion is the derived
        // inequality alone — never an absolute number (measured ratio ~0.81 on this section, and
        // 0.82–0.88 on stage 3a's own sweep, so a bare `<=` needs no fudge factor).
        expect(exitDeviation).toBeGreaterThan(0);
        expect(exitDeviation).toBeLessThanOrEqual(twoBakeDisagreement);
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
                points: sectionForces(state, s.id).map((p) => ({
                    id: p.id,
                    s: p.s,
                    g: p.g,
                    ease: Force.ease.get(p.eid),
                    tmode: Force.tmode.get(p.eid),
                    tin: [Force.tin.x.get(p.eid), Force.tin.y.get(p.eid)],
                    tout: [Force.tout.x.get(p.eid), Force.tout.y.get(p.eid)],
                })),
                strips: sectionStrips(state, s.id).map((r) => ({
                    id: r.id,
                    start: r.start,
                    end: r.end,
                    value: r.value,
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
        createStrip(state, sec, 12, 28, 7.5); // an interior strip rides the undo entry too
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
        // 1.2 g sustained over 30 m drains the energy: v reaches zero — a TRUE stall
        // (`forward.step`'s v²≤0 freeze, `kex2d-map.md`) — and the cart never moves again. In the
        // Distance bake time runs away (ds/v̄ at the V_FLOOR clamp), so the section's converted
        // duration is enormous; the Time bake then MARCHES that duration at Δt with the cart
        // frozen, so its arclength plateaus EXACTLY (ds_i = v_i·Δt, v_i == 0). The section length
        // is kept short enough past the stall that the converted duration stays inside
        // `MAX_SAMPLES` — the freeze makes the frozen dwell time honest (and hence bigger than
        // the pre-freeze creep's), so a 40 m section here would overrun the sample budget.
        //
        // Converting back is therefore LOSSY on purpose: two keyframes at different times inside
        // a frozen stretch are at the same PLACE, so they must convert to the same arclength.
        // That's the documented data-loss-on-flip semantic, and undo is the way back.
        const { state, eid, sec } = forceTrack(30, [
            [0, 1],
            [15, 1.2],
            [30, 1],
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
        // diverges without bound at a stall (measured 154.24 s marched vs derived a fraction of
        // it — the section shortened to 30 m, the same fixture as the "plateau" test above, to
        // keep the TRUE-stall-freeze's honest dwell time inside `MAX_SAMPLES`).
        const { state, eid, sec } = forceTrack(30, [
            [0, 1],
            [15, 1.2], // stalls: v reaches zero and the derived time runs away
            [30, 1],
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
            const vA = Math.max(Math.abs(out.v[i] ?? 0), V_FLOOR);
            const vB = Math.max(Math.abs(out.v[i + 1] ?? 0), V_FLOOR);
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
        if (!out) throw new Error("no bake");
        let derived = 0;
        for (let i = 0; i + 1 < Track.count.get(eid); i++) {
            const vA = Math.max(Math.abs(out.v[i]), V_FLOOR);
            const vB = Math.max(Math.abs(out.v[i + 1]), V_FLOOR);
            derived = Math.fround(derived + out.ds[i] / (0.5 * (vA + vB)));
            expect(out.t[i + 1]).toBe(derived);
        }
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

// `domain.convertSolve` — the landing seam. Invoked solves stay distance-internal (their goldens
// are frozen in meters), so an answer landing on a `Time`-domain track converts through the
// section's own window on the live table, exactly as the ruler pick converts the whole store.
// The document-level pins (one entry, undo byte-identity, seconds actually stored) live with each
// direction's command: `geoforce.test.ts` / `forcegeo.test.ts`.
describe("solve landings", () => {
    /** the meters-domain answer shape a geo→force solve emits over `len`. */
    const solved = (len: number, pts: readonly [number, number][]) => ({
        points: pts.map(([s, g]) => ({ s, g })),
        length: len,
        ds: len / 40,
    });

    /** a Time-domain track carrying one geo hump — the state a geo→force solve lands into. */
    function timeGeoTrack(): { state: State; eid: number; sec: number } {
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        setTrackDomain(state, Domain.Time);
        setTrackV0(eid, 18); // the hump's own entry speed — at the default V0 it stalls on the climb
        const sec = createSection(state, 0, SectionKind.Geo, 0);
        addNode(state, sec, 0, 0);
        addNode(state, sec, 12, 4);
        addNode(state, sec, 24, 0);
        state.step(0);
        return { state, eid, sec };
    }

    test("a Distance track gets the answer back by identity — no bake needed", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        const sec = createSection(state, 0, SectionKind.Geo, 0);
        addNode(state, sec, 0, 0);
        addNode(state, sec, 24, 0);
        // deliberately never stepped: the distance path must not reach for a table at all, so
        // the landing is byte-identical to the pre-domain one.
        const answer = solved(24, [
            [0, 1],
            [24, 1],
        ]);
        expect(convertSolve(state, sec, answer)).toBe(answer);
    });

    test("a Time track converts positions and extent", () => {
        const { state, eid, sec } = timeGeoTrack();
        const tab = table(eid);
        const answer = solved(24, [
            [0, 1],
            [8, 1.4],
            [24, 0.9],
        ]);

        const landed = convertSolve(state, sec, answer);
        if (!landed) throw new Error("convertSolve rejected a live track");
        // each position is the bake's own arc→time reading at that arclength, checked against
        // the independently rebuilt table (not through `domain.ts`'s own helpers).
        for (let i = 0; i < answer.points.length; i++) {
            expect(landed.points[i].s).toBeCloseTo(interp(tab.arc, tab.t, answer.points[i].s), 9);
            expect(landed.points[i].g).toBe(answer.points[i].g); // g is unit-relative
        }
        expect(landed.length).toBeCloseTo(interp(tab.arc, tab.t, 24), 9);
        // seconds, not meters — the whole point of the seam.
        expect(landed.length).toBeLessThan(answer.length / 5);
    });

    test("a Time track floors a collapsed extent at the domain's own minimum", () => {
        const { state, sec } = timeGeoTrack();
        const landed = convertSolve(state, sec, solved(0, [[0, 1]]));
        if (!landed) throw new Error("convertSolve rejected a live track");
        expect(landed.length).toBe(minForceExtent(Domain.Time));
    });

    test("a Time track with no table rejects rather than landing meters", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        setTrackDomain(state, Domain.Time);
        const sec = createSection(state, 0, SectionKind.Geo, 0);
        addNode(state, sec, 0, 0);
        addNode(state, sec, 24, 0);
        // never baked: no arc↔time table, so there is no honest unit for the answer.
        expect(convertSolve(state, sec, solved(24, [[0, 1]]))).toBeNull();
    });

    test("a Time track rejects an answer for a section that isn't on the bake", () => {
        const { state } = timeGeoTrack();
        expect(convertSolve(state, 9999, solved(24, [[0, 1]]))).toBeNull();
    });
});

// The window's two boundaries are exact STATIONS on the arc↔time table (`entryD`/`exitD` and
// `entryT`/`exitT`, read by sample index), and a position landing exactly on one must resolve to
// its station rather than interpolate to it. `interpMono` resolves a tie to the LAST tied index,
// so a stall plateau reaching forward past a section's exit sample would otherwise absorb the
// whole downstream stall into that section's converted duration.
describe("window boundaries", () => {
    /** a Time-domain track whose FIRST force section stalls before its own exit, followed by a
     *  second force section that stays stalled (a frozen cart is a fixed point: `ds = v·Δt` with
     *  `v == 0`). So the arc plateau starts inside section A and reaches past its exit sample —
     *  and A is first in the chain, so its `entryD`/`entryT` are exactly 0 and a length of
     *  `exitD` lands bit-exactly on the boundary. */
    function stalledPair(): { state: State; eid: number; a: number; b: number } {
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        setTrackDomain(state, Domain.Time);
        const a = createSection(state, 0, SectionKind.Force, 6); // 6 s at a sustained 1.2 g
        createForcePoint(state, a, 0, 1.2);
        const b = appendSection(state, SectionKind.Force);
        state.step(0);
        return { state, eid, a, b };
    }

    /** section `id`'s exit station on the independently rebuilt table, under the same clamp
     *  `domain.windowOf` applies (`min(endSample, n − 1)`). */
    function exitStation(eid: number, id: number): { d: number; t: number } {
        const tab = table(eid);
        const info = sectionInfo.get(id);
        if (!info) throw new Error(`no bake for section ${id}`);
        const end = Math.min(info.endSample, tab.arc.length - 1);
        return { d: tab.arc[end], t: tab.t[end] };
    }

    test("a landing extent exactly at the exit takes the exit's own time, not the stall past it", () => {
        const { state, eid, a, b } = stalledPair();
        const outB = bakeOut.get(eid);
        if (!outB) throw new Error("no bake");
        // the plateau really does reach past A's exit: B's first edge is frozen too.
        const infoB = sectionInfo.get(b);
        if (!infoB) throw new Error("no bake for B");
        expect(outB.ds[infoB.startSample]).toBe(0);

        const exit = exitStation(eid, a);
        expect(exit.d).toBeGreaterThan(0);
        // A is the first section, so `entryD` is exactly 0 and this length lands bit-exactly on
        // the exit station — the one address where the tie rule decides the answer.
        const landed = convertSolve(state, a, {
            points: [{ s: exit.d, g: 1 }],
            length: exit.d,
        });
        if (!landed) throw new Error("convertSolve rejected a live track");
        expect(landed.length).toBe(exit.t);
        expect(landed.points[0].s).toBe(exit.t);
        // and the absorbed answer is a genuinely different number — the downstream section's
        // whole frozen duration, which is what makes this worth pinning.
        const absorbed = exitStation(eid, b).t;
        expect(absorbed).toBeGreaterThan(exit.t + 1);
    });

    test("the inverse direction returns its stations exactly too", () => {
        // The mirror of the above, on the SECOND section so the two tables have to cancel a
        // nonzero offset rather than agreeing trivially at the track origin. It is a symmetry
        // guard, not a regression: the time axis carries no plateau of its own (a derived
        // `dt = ds/v̄` vanishes only where `ds` does, so a t-tie is an arc-tie), so `timeToArc`
        // has no stall to absorb — the branch is verified by mutation instead.
        const { state, eid, b } = stalledPair();
        const info = sectionInfo.get(b);
        if (!info) throw new Error("no bake for B");
        expect(table(eid).arc[info.startSample]).toBeGreaterThan(0); // a real offset to cancel
        const seed = sectionForces(state, b)[0];
        expect(seed.s).toBe(0); // B's entry keyframe sits exactly on its own station

        expect(convertDomain(createHistory(), state, Domain.Distance)).toBe(true);
        const back = sectionForces(state, b).find((p) => p.id === seed.id);
        expect(back?.s).toBe(0);
    });
});

// The carry (D1, § Domain fidelity: "carry the curve on flip, via tagged subdivision").
//
// The property is the person's: **flipping the ruler between Metres and Seconds must not change the
// force shape they authored.** The conversion has always landed every keyframe exactly — it IS the
// arc↔time table lookup — but a cubic bezier authored in (s, g) is not a cubic bezier in (t, g)
// under that nonlinear map, so the curve BETWEEN keys reshaped. The carry subdivides until the
// reshape is smaller than anything the march can resolve, tags every inserted key, and drops the
// tags' keys on the way back.
//
// **Red-first, witnessed and recorded.** Removing the carry from `convertDomain` — leaving the
// pre-carry conversion, the Δs-scaled key map that is what `38635a3` shipped in this path — reds the
// two shape arms below at:
//   • dive-and-recover: |Δg| 0.049686 against its 0.022481 g resolution floor — 2.21× over;
//   • multi-g pull:     |Δg| 0.421336 against its 0.195529 g floor          — 2.15× over.
// The dive-and-recover figure was also measured independently against the untouched tree at
// `38635a3`, before any of this landed, by a separate probe: 0.04969 g.
// The pre-existing 0.20/0.25 m arms in `describe("single flip")` pass over exactly that defect —
// they bound the two marches' WORLD disagreement, a different quantity, so they are evidence about
// the tolerance and never about this property.
describe("the carry (D1)", () => {
    /** the flip's user-visible shape delta: the authored force curve sampled at every nominal march
     *  station before the flip, against the carried curve at the SAME ride position after it (the
     *  station mapped through the pre-flip bake's own arc↔time table, rebuilt in this file). This is
     *  the profile the march integrates and the chart draws, read at the resolution the march reads
     *  it at. */
    function flipDelta(
        len: number,
        pts: readonly [number, number][],
        summon?: (state: State, sec: number) => void,
    ) {
        const { state, eid, sec } = forceTrack(len, pts);
        // `summon` is the person's explicit-handle gesture, applied BEFORE the reading is taken: the
        // tolerance, the table and the carry all have to see the same authored curve.
        if (summon) {
            summon(state, sec);
            state.step(0);
        }
        const before = profilePts(state, sec);
        const tab = table(eid);
        const step = resolveStep(len, DS_NOMINAL);
        const tol = resolutionFloor(before, step);
        const h = createHistory();
        expect(convertDomain(h, state, Domain.Time)).toBe(true);
        const after = profilePts(state, sec);
        let worst = 0;
        for (let i = 0; i <= step.edges; i++) {
            const s = Math.min(len, i * step.ds);
            const t = interp(tab.arc, tab.t, s);
            worst = Math.max(worst, Math.abs(sampleForce(after, t) - sampleForce(before, s)));
        }
        return { state, eid, sec, tol, worst, before, after, step };
    }

    test("the tolerance is the march's own resolution floor, and it reproduces S1's two readings", () => {
        // the cross-check on the helper, not a constant it uses: S1 recorded 0.0225 and 0.195 for
        // these two fixtures, computed as `max |Δg|` over one nominal march edge. `resolutionFloor`
        // is computed at runtime from the authored curve and `Track.ds` — the production carry never
        // reads a number from here.
        for (const [len, pts, recorded] of [
            [...DIVE_AND_RECOVER, 0.0225] as const,
            [...MULTI_G_PULL, 0.195] as const,
        ]) {
            const { state, sec } = forceTrack(len, pts);
            const floor = resolutionFloor(profilePts(state, sec), resolveStep(len, DS_NOMINAL));
            expect(floor).toBeCloseTo(recorded, 2);
            // not vacuous: the floor is a small fraction of the curve's own range, so a carry
            // landing inside it is a real claim rather than a free pass.
            const range = Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1]));
            expect(floor).toBeLessThan(range / 4);
        }
    });

    test("a Metres→Seconds flip carries the rendered force shape inside the resolution floor — dive-and-recover", () => {
        const r = flipDelta(...DIVE_AND_RECOVER);
        expect(r.worst).toBeLessThanOrEqual(r.tol); // 0.00436 g vs 0.02248 g (0.19×)
        expect(r.worst).toBeGreaterThan(0); // the flip is real, not a no-op
        // the mechanism actually ran: keys were inserted, and every one is tagged.
        expect(carriedKfs(r.state, r.sec).length).toBe(2);
        expect(kfs(r.state, r.sec).length).toBe(3);
    });

    test("a Metres→Seconds flip carries the rendered force shape inside the resolution floor — multi-g pull", () => {
        const r = flipDelta(...MULTI_G_PULL);
        expect(r.worst).toBeLessThanOrEqual(r.tol); // 0.1369 g vs 0.19553 g (0.70×)
        expect(r.worst).toBeGreaterThan(0);
        expect(carriedKfs(r.state, r.sec).length).toBe(2);
        expect(kfs(r.state, r.sec).length).toBe(4);
    });

    test("a section with SUMMONED explicit handles carries too — the class where the carry does LEAST", () => {
        // The `scaleHandles` path the carry composes with, and the class no other arm reached. An
        // explicit handle steepens the authored curve, which RAISES the resolution floor while the
        // map's reshape grows with it — the two are homogeneous of degree 1 in g together, so the
        // ratio, not the margin, is what the flip has to hold. Measured over a swept handle grid
        // (6×5×6×5 on dive-and-recover, 2 keys × 4×5×4×5 on the pull, 1000 flips):
        //
        //   • the two arms below land at 0.991× and 0.996× of their own tolerance — versus 0.19× and
        //     0.70× for the same fixtures with derived handles, so the comfortable readings the other
        //     arms record do NOT generalize to a section the person has shaped by hand;
        //   • the worst non-stalling configuration in the whole sweep sits at 1.000× (pull, key 1,
        //     Free (-6,+1)/(+2,+1): 0.279494 g against a 0.279568 g floor) — the carry has no margin
        //     left in this class, and nothing said so before this arm;
        //   • the ONLY reading above 1 was 1.351× (pull, key 1, Free (-2,-2)/(+4,-2): 0.575645 g
        //     against 0.426092 g), and that document STALLS — `vmin` = 0, the frozen tail converting
        //     at `ds/V_FLOOR`, which the locked decision accepts as lossy in both directions and the
        //     floor guard's stall clause deliberately does not refuse. Recorded here rather than
        //     asserted, because asserting it would pin the stall's lossiness as a bound.
        //   • and dive-and-recover with handles inserts ZERO carried keys at 0.991×: the carry is
        //     doing nothing there and the flip fits anyway, which is what "does least" means.
        const free = (state: State, sec: number, key: number, tan: ForceTangent): void => {
            const rows = sectionForces(state, sec);
            setForceTangent(state, rows[key].id, tan);
        };
        const dive = flipDelta(...DIVE_AND_RECOVER, (state, sec) =>
            free(state, sec, 1, {
                mode: TangentMode.Free,
                in: { ds: -6, dg: 0.6 },
                out: { ds: 4, dg: -0.3 },
            }),
        );
        expect(dive.worst).toBeLessThanOrEqual(dive.tol); // 0.047927 g vs 0.048340 g (0.991×)
        expect(dive.worst).toBeGreaterThan(0);
        expect(forceTangent(dive.state, sectionForces(dive.state, dive.sec)[1].id)).toBeDefined();

        const pull = flipDelta(...MULTI_G_PULL, (state, sec) =>
            free(state, sec, 2, {
                mode: TangentMode.Free,
                in: { ds: -1, dg: 0 },
                out: { ds: 4, dg: -1 },
            }),
        );
        expect(pull.worst).toBeLessThanOrEqual(pull.tol); // 0.194748 g vs 0.195529 g (0.996×)
        expect(carriedKfs(pull.state, pull.sec).length).toBeGreaterThan(0); // the carry did run here
    });

    test("the reverse flip DROPS the inserted keys rather than simplifying them", () => {
        const [len, pts] = DIVE_AND_RECOVER;
        const r = flipDelta(len, pts);
        const inserted = sectionForces(r.state, r.sec).filter((p) => p.carried).length;
        expect(inserted).toBeGreaterThan(0);
        const droppedIds = sectionForces(r.state, r.sec)
            .filter((p) => p.carried)
            .map((p) => p.id);
        const authoredIds = kfs(r.state, r.sec).length;

        r.state.step(0);
        expect(convertDomain(createHistory(), r.state, Domain.Distance)).toBe(true);
        // every tagged key is gone by IDENTITY — not merged, not re-fitted — and the authored set is
        // untouched. The return flip carries in its own right, so new tagged keys are legitimate.
        const live = sectionForces(r.state, r.sec).map((p) => p.id);
        for (const id of droppedIds) expect(live).not.toContain(id);
        expect(kfs(r.state, r.sec).length).toBe(authoredIds);
    });

    test("a Cut at a carried key's station survives the reverse flip: both halves keep the boundary", () => {
        // The end-to-end witness for the structural-writer half of the law (the per-op arms are in
        // `tests/track.test.ts`). Cut is two clicks from `acts.ts`'s keyframe-cut act, and a carried
        // key is a legal station to cut on — nothing renders it differently (T1's, disclosed).
        //
        // **Red before the repair**, this exact sequence: `splitForce` left the landmark key tagged,
        // so the reverse flip DROPPED the boundary the cut had just built both halves around — the
        // head came back holding ONE keyframe with the authored dive flattened to a constant 1 g,
        // while the tail kept an authored duplicate of a key the document could no longer justify.
        const [len, pts] = DIVE_AND_RECOVER;
        const r = flipDelta(len, pts);
        const landmark = sectionForces(r.state, r.sec).find((p) => p.carried);
        if (!landmark) throw new Error("the carry inserted nothing to cut on");
        const boundaryG = landmark.g;

        const tail = splitForce(r.state, r.sec, landmark.s);
        if (tail === null) throw new Error("split refused");
        r.state.step(0);
        expect(convertDomain(createHistory(), r.state, Domain.Distance)).toBe(true);

        // the head still HAS a curve: its own entry key plus the boundary the cut promoted.
        const head = sectionForces(r.state, r.sec);
        expect(head.length).toBeGreaterThan(1);
        // and the boundary value is the same on both sides of the cut, which is what makes the cut
        // lossless. f32 tolerance: both halves store the value through `Force.g`.
        const headLast = head[head.length - 1];
        const tailFirst = sectionForces(r.state, tail)[0];
        expect(headLast.g).toBeCloseTo(boundaryG, 5);
        expect(tailFirst.g).toBeCloseTo(boundaryG, 5);
        expect(headLast.carried).toBe(false); // nothing can drop the document's own structure
        expect(tailFirst.carried).toBe(false);
    });

    test("DELETING an authored key promotes the carried keys fitted to it, so the reverse flip keeps the shape", () => {
        // The provenance law's NON-writer, end to end and in the person's terms: they flip to
        // Seconds, delete a keyframe, flip back to Metres, and the curve they were looking at must
        // still be there. `carryForce` fits the AUTHORED keys alone and derives its tolerance from
        // them, so every carried key around a destroyed authored key was fitted to a curve the
        // document no longer holds — `history.deleteForces` therefore promotes them
        // (`track.setForceCarried`), even though it writes no column of theirs.
        //
        // **Red before this repair**, this exact sequence: the 2 carried keys stayed tagged, the
        // Seconds curve still dipped to 0.5837 g, and the reverse flip dropped both — leaving TWO
        // keys, both 1 g, FLAT: a 0.41630 g round-trip delta at t = 1.870 against this fixture's
        // 0.0225 g resolution floor (18.5×). No guard could see it, because with the trough gone the
        // authored set is {1 g, 1 g}, `resolutionFloor` is 0.0 and the fit is exact. Deleting two of
        // the three authored keys left ONE keyframe, flat at 1 g — verbatim the witness `882ae1c`
        // recorded for the Cut, reached through Delete instead.
        const [len, pts] = DIVE_AND_RECOVER;
        const r = flipDelta(len, pts);
        expect(carriedKfs(r.state, r.sec).length).toBe(2);
        const seconds = profilePts(r.state, r.sec);
        const tEnd = Math.max(...seconds.map((p) => p.s));
        const h = createHistory();

        // the person deletes the authored trough — the 0.4 g dip — in Seconds.
        const trough = sectionForces(r.state, r.sec)
            .filter((p) => !p.carried)
            .reduce((lo, p) => (p.g < lo.g ? p : lo));
        deleteForces(h, r.state, [trough.id]);
        expect(carriedKfs(r.state, r.sec).length).toBe(0); // nothing droppable is left behind
        const dipped = profilePts(r.state, r.sec);

        r.state.step(0);
        expect(convertDomain(h, r.state, Domain.Distance)).toBe(true);
        const back = profilePts(r.state, r.sec);
        // the returned curve is not flat, and it still dips: the carried keys became the shape's
        // carriers when the key they were fitted to went away.
        expect(back.length).toBeGreaterThan(2);
        expect(Math.min(...back.map((p) => p.g))).toBeLessThan(0.8);

        // and the round trip holds the SHAPE, read the way the person sees it: the Seconds curve they
        // were looking at against what came back, both at the same ride position. 0.00355 g at
        // t = 2.903, 0.2× of the floor — against 0.41630 g / 18.5× before the repair.
        const tab = table(r.eid);
        let worst = 0;
        for (let i = 0; i <= 400; i++) {
            const t = (i / 400) * tEnd;
            const s = interp(tab.t, tab.arc, t);
            worst = Math.max(worst, Math.abs(sampleForce(back, s) - sampleForce(dipped, t)));
        }
        expect(worst).toBeLessThanOrEqual(r.tol);
        expect(worst).toBeGreaterThan(0); // not a vacuous no-op: the flip really ran
    });

    test("an authored INSERT among carried keys does NOT promote them — the asymmetry, measured", () => {
        // The law is about reconstructibility from the authored set, and an insert ADDS a constraint
        // rather than removing one, so the keys around it stay droppable (`history.createForce`
        // promotes nothing). Measured here rather than argued: the curve's min/max survives the round
        // trip either way — 0.4/3.5 g in Seconds after the insert, 0.4/3.5 g back in Metres — which is
        // what makes the delete's promotion a repair and not a blanket rule.
        const [len, pts] = DIVE_AND_RECOVER;
        const r = flipDelta(len, pts);
        const tEnd = Math.max(...sectionForces(r.state, r.sec).map((p) => p.s));
        const h = createHistory();
        createForce(h, r.state, r.sec, tEnd * 0.75, 3.5); // the person authors a 3.5 g key
        expect(carriedKfs(r.state, r.sec).length).toBeGreaterThan(0); // still droppable
        const dense = (ptsIn: ForcePoint[], end: number): number[] =>
            Array.from({ length: 401 }, (_, i) => sampleForce(ptsIn, (i / 400) * end));
        const seconds = dense(profilePts(r.state, r.sec), tEnd);

        r.state.step(0);
        expect(convertDomain(h, r.state, Domain.Distance)).toBe(true);
        const back = profilePts(r.state, r.sec);
        const metres = dense(back, Math.max(...back.map((p) => p.s)));
        expect(Math.min(...metres)).toBeCloseTo(Math.min(...seconds), 2);
        expect(Math.max(...metres)).toBeCloseTo(Math.max(...seconds), 2);
    });

    test("editing an inserted key clears its tag, so the reverse flip keeps it", () => {
        const [len, pts] = DIVE_AND_RECOVER;
        const r = flipDelta(len, pts);
        const edited = sectionForces(r.state, r.sec).find((p) => p.carried);
        if (!edited) throw new Error("the carry inserted nothing to edit");
        setForcePoint(r.state, edited.id, edited.s, edited.g + 0.05); // the person drags it
        expect(forceCarried(r.state, edited.id)).toBe(false);
        const authoredBefore = kfs(r.state, r.sec).length;

        r.state.step(0);
        expect(convertDomain(createHistory(), r.state, Domain.Distance)).toBe(true);
        expect(sectionForces(r.state, r.sec).map((p) => p.id)).toContain(edited.id);
        expect(forceCarried(r.state, edited.id)).toBe(false);
        expect(kfs(r.state, r.sec).length).toBe(authoredBefore);
    });
});

// D1 deliverable 2 — **the re-baked untagged control.** S1's "round trips grow keys without bound"
// was withdrawn as unmeasured because S1's control ran on a FROZEN arc↔time table, which is the very
// compounding mechanism the claim rests on. Re-measured here with the table re-baked after every
// flip (`state.step(0)`), 10 round trips (20 flips), both fixtures, the control produced by clearing
// every key's tag after each flip — the same production carry with the provenance bit never recorded.
//
// **Measured, both schemes, keys AND extent** (this worktree; the extent column is what an earlier
// reading of this table omitted, and it is the reading that decides the verdict):
//   dive-and-recover
//     tagged   keys 5,4,5,4,5,4,5,4,5,4,4,4,4,4,4,4,5,4,4,4    extent 3.16 → 3.08 s / 39.70 → 38.64 m
//     untagged keys flat 5 for all 20 flips                     extent 3.16 → 3.02 s / 39.70 → 37.23 m
//   multi-g pull
//     tagged   keys 6,6,6,6,6,6,5,7,11,14,12,9,9,7,10,7,7,7,12,7 (peak 14)
//                                                               extent 3.36 → 5927.96 s / 25.37 → 99.53 m,
//                                                               `MAX_SAMPLES` truncation firing from flip 9
//     untagged keys 6,6,6,6,11,11,11,13,17,24,28,28,32,32,34,34,35,35,42,42
//                                                               extent 3.36 → 535954 s / 25.37 → 5396.90 m
//
// **Verdict: the withdrawn claim stays withdrawn, because the two candidate mechanisms are
// simultaneous and these readings do not order them.** The candidates are subdivision compounding
// (each flip carries a store the previous flip densified) and extent runaway (each flip re-converts
// the extent through a table the previous flip moved). Three readings, none of which separates them:
//   • the untagged control's key jump (6 → 11) lands on the SAME flip as its own extent jump
//     (3.56 s → 54.37 s) — simultaneous and mutually amplifying, unordered by the data;
//   • the TAGGED carry carries the same runaway (25.37 → 99.53 m, 3.36 → 5927.96 s, `MAX_SAMPLES`
//     truncating) while its key count stays bounded — so runaway is not what distinguishes the two
//     schemes either;
//   • and the runaway is pre-existing rather than the carry's: the adversarial pass measured trunk
//     (`38635a3`, carry absent) at 24 → 62 m over 12 flips. That reading is the review pass's, on a
//     tree this suite cannot construct, and is recorded as attributed rather than re-run.
// So the ordering claim ("the driver is extent runaway, not subdivision") is not one these numbers
// can make either. What they DO support is the locked decision's own ground, and only that: tag-drop
// never lands more keys than the untagged control, lands strictly fewer on the sensitive fixture, and
// RELEASES keys it inserted (every tagged sequence above steps back down; neither untagged one ever
// does) instead of simplifying a denser store heuristically.
describe("round-trip key counts on re-baked tables (D1)", () => {
    test("the tagged carry is BOUNDED, and releases keys rather than accumulating them", () => {
        // "Flat" was the earlier word and it was wrong. What survives measurement is two properties,
        // and the arm leans on the second because the first is nearly vacuous at these numbers:
        //
        //   1. the DERIVED bound — subdivision stops at one nominal march edge, so a section can
        //      never hold more than one key per edge of the bake it is authored against. That is the
        //      only bound this design derives, and it is loose: 52 keys against observed peaks of 14
        //      (pull) and 5 (dive-and-recover). Kept as the structural claim it is, labelled rather
        //      than dressed up as a tight one.
        //   2. the DISCRIMINATING property — the sequence steps back DOWN at least once, i.e. the
        //      scheme releases keys it inserted. That is tag-drop working, and it is exactly what
        //      neither untagged control ever does (dive untagged sits flat at 5 for 20 flips, pull
        //      untagged is monotone non-decreasing to 42), so it separates the two schemes on BOTH
        //      fixtures with no fitted threshold anywhere.
        for (const [len, pts, authored] of [
            [...DIVE_AND_RECOVER, 3] as const,
            [...MULTI_G_PULL, 4] as const,
        ]) {
            const r = untilRefusal(len, pts, false, 20);
            expect(r.refused).toBeNull(); // neither fixture reaches the floor guard's degeneracy
            const counts = r.counts;
            expect(counts.length).toBe(20); // not vacuous: every flip landed
            const budget = authored + resolveStep(len, DS_NOMINAL).edges;
            expect(Math.max(...counts)).toBeLessThanOrEqual(budget);
            expect(counts.some((c, i) => i > 0 && c < counts[i - 1])).toBe(true);
        }
    });

    test("the untagged control never lands FEWER keys, ON THE DISCRIMINATING FIXTURE", () => {
        // This assertion used to run on dive-and-recover, where both maxima are 5 — satisfied by
        // equality, and satisfied just as well with the carry absent. It belongs on the fixture where
        // the two schemes actually part: the pull, at 3 round trips (see the growth arm below for why
        // the sensitive fixture stops there).
        const tagged = untilRefusal(...MULTI_G_PULL, false, 6).counts;
        const control = untilRefusal(...MULTI_G_PULL, true, 6).counts;
        expect(Math.max(...control)).toBeGreaterThan(Math.max(...tagged)); // strict, not >=
    });

    test("the untagged control GROWS on the sensitive fixture where tag-drop does not", () => {
        // Three round trips, not ten, and the reason is a measurement rather than a preference: the
        // untagged control's own extent runaway (25.37 → 5317 m by trip 3) makes the later trips cost
        // 12.6 s of bake, which would be 1.5× the whole default suite. The full sequences are recorded
        // in this describe's docblock; the growth is already unambiguous at six flips (6 → 11 keys
        // untagged, flat 6 tagged), so the arm keeps the finding at 8 ms.
        const [len, pts] = MULTI_G_PULL;
        const tagged = untilRefusal(len, pts, false, 6).counts;
        const control = untilRefusal(len, pts, true, 6).counts;
        expect(control[control.length - 1]).toBeGreaterThan(tagged[tagged.length - 1]);
        expect(tagged[tagged.length - 1]).toBe(tagged[0]);
    });

    /** flip alternately Time/Distance, re-baking after each, until the resolution-floor guard
     *  refuses or `flips` flips have landed. Returns the per-flip key counts and the refusal message
     *  if one came — the guard's throw is a document-level refusal (nothing is written), so a
     *  sequence that ends in one is a shorter sequence, not a corrupt one. */
    function untilRefusal(
        len: number,
        pts: readonly [number, number][],
        untagged: boolean,
        flips: number,
    ): { counts: number[]; refused: string | null } {
        const { state, sec } = forceTrack(len, pts);
        const h = createHistory();
        const counts: number[] = [];
        for (let i = 0; i < flips; i++) {
            try {
                // a refused flip would read as a flat count — the vacuity this loop can have.
                expect(convertDomain(h, state, i % 2 === 0 ? Domain.Time : Domain.Distance)).toBe(
                    true,
                );
            } catch (e) {
                return { counts, refused: (e as Error).message };
            }
            // the control clears the tags through the bit's own writer. Re-writing each key's own
            // `s`/`g` back onto it used to do this and no longer does: a write that moves nothing
            // leaves provenance alone (`track.setForcePoint`), which is the whole point of that
            // repair — so an untagged control built that way would silently BE the tagged scheme.
            if (untagged)
                for (const p of sectionForces(state, sec)) setForceCarried(state, p.id, false);
            state.step(0); // RE-BAKE: the next flip converts through the table this flip made
            counts.push(sectionForces(state, sec).length);
        }
        return { counts, refused: null };
    }
});

// D1 deliverable 3 — **the fail-loud guard at the resolution floor**, and the Residue's open question
// it answers. Subdivision stops when a segment's source span reaches one nominal march edge: below
// that the march samples the segment at most once, so a finer split is unreadable by the instrument
// the tolerance is derived from. The question the Residue left open was whether the resolution-floor
// FORM needs a fail-loud guard at all (not whether to retrofit S1's margin-and-noise algebra).
//
// **Answer: yes, and the reachable class is the map rather than the curve.** Both the tolerance and
// the reshape it must bound are homogeneous of degree 1 in `g` — double the authored curve's
// amplitude and both double — so they are NOT decoupled, and an earlier sentence here saying so was
// false. What is curve-independent is their RATIO: the tolerance is a property of the authored curve,
// the ratio is a property of the arc↔time map alone, which comes from the RIDE (upstream geometry, a
// stall, an extent that drifted). That is what carries the reachability conclusion — a map can push
// the ratio past 1 on any curve, gentle or violent, so "a partial fit at the floor" is not
// self-evidently unreachable — and measurement bears it out: three of the classes below were found
// by running, not by reasoning.
//
// What the derivation DOES bound is the residual where its own premise holds — a map resolved by the
// march grid leaves `tol · O(Δv/v)` per edge — so the guard fires everywhere except the ONE
// degeneracy where the premise is void: a frozen cart, `vLo` at `V_FLOOR`, which the locked decision
// already accepts as lossy both ways and A3 made reachable in Distance. **A speed-swing clause used
// to sit beside that one and is gone** (`carryForce`'s docblock carries the whole autopsy): it tested
// `vHi >= 2·vLo` while claiming the stall's regime, and it silenced the guard hardest exactly where
// residuals are largest — the third arm below is the fixture that shows it, and it is red without the
// repair.
describe("the carry's resolution-floor guard (D1)", () => {
    /** two authored keys one edge apart — already AT the floor, so the guard decides on the first
     *  measurement with no subdivision in between. */
    const floorPair = [
        { id: 1, s: 0, g: 1, ease: Easing.Cubic, carried: false },
        { id: 2, s: 1, g: 2, ease: Easing.Cubic, carried: false },
    ];

    /** a frozen interval's slope as the table actually reports it — two f32 differences divided in
     *  f64, measured at every throw site in this suite, verbatim. `V_FLOOR` + 1.9073e-10, which is
     *  0.2048 of one f32 ulp at 0.01 (the binade [2⁻⁷, 2⁻⁶), so one ulp is 2⁻³⁰ = 9.3132e-10). */
    const FrozenSlope = 0.010000000190734867;

    test("a map whose nonlinearity hides BETWEEN the probes fails loud instead of half-fitting", () => {
        // Red-first, witnessed: with the guard's `throw` replaced by the silent `continue` a
        // depth-capped recursion does, this same call returns 2 keys carrying a **0.4803 g** residual
        // against the 0.19 g bound — a curve half a g off the authored one, no key inserted, and
        // nothing in the store, the hash or the suite saying so.
        // The map is affine at every probe (constant slope, so `Δv/v = 0`: the premise READS as held)
        // and jumps 5 s between two of them, which is the only shape that reaches this branch.
        const spike = (s: number) => ({ value: s <= 0.5 ? s : s + 5, slope: 1 });
        expect(() => carryForce(floorPair, floorPair, spike, Domain.Time, 0.19, 1)).toThrow(
            /partial fit at the march resolution floor/,
        );
    });

    test("a NON-STALL map swinging 3× throws — a speed swing is not an excuse", () => {
        // The reviewer's fixture, and the blocker it carries: the identical hidden station jump as the
        // arm above, with the map's slope swinging 3× at 9 → 3 m/s. Nothing here is stalled — 3 m/s is
        // three orders above `V_FLOOR` (0.01) and three times `V_WARN` (1.0), so the document would not
        // even flag the ride infeasible.
        //
        // **Red before the repair, measured:** the retired `vHi >= 2·vLo` clause silenced the guard on
        // exactly this input, and `carryForce` returned 2 keys carrying a **0.4803 g** residual against
        // the 0.19 g bound — bit for bit the number the pre-guard silent failure was recorded at. The
        // clause's docblock justified itself as "the regime of a stall and its approach" while testing
        // the speed SWING, a different quantity, and swing and residual are correlated through the
        // map's own nonlinearity, so it fired hardest where the residual was worst.
        const swing3x = (u: number) => ({ value: u <= 0.5 ? u : u + 5, slope: u <= 0.5 ? 9 : 3 });
        expect(V_FLOOR).toBeLessThan(3 / 100); // the fixture is nowhere near the stall…
        expect(V_WARN).toBeLessThan(3); // …nor inside the band the document flags infeasible
        expect(() => carryForce(floorPair, floorPair, swing3x, Domain.Time, 0.19, 1)).toThrow(
            /partial fit at the march resolution floor/,
        );
    });

    test("the stall exclusion is read at the TABLE's precision, not f64's", () => {
        // The repair's other half, and why dropping the swing clause alone turned every stalled
        // document's flip into a refusal: a frozen interval's slope is two f32 table differences
        // divided in f64, so it lands just ABOVE `V_FLOOR` — measured at every throw site in this
        // suite, `vLo` came back 0.010000000190734867, an excess of 1.9073e-10, which is 0.2048 of one
        // f32 ulp at that magnitude — and a bare `vLo <= V_FLOOR` is false by exactly that. So the
        // stall clause never fired and the swing clause was doing its work.
        const frozen = FrozenSlope;
        expect(frozen).toBeGreaterThan(V_FLOOR); // the bare comparison misses…
        const stalled = (u: number) => ({ value: u <= 0.5 ? u : u + 5, slope: frozen });
        // …and reading it at the store's own precision does not: this is the stall, and it is silenced.
        expect(
            carryForce(floorPair, floorPair, stalled, Domain.Time, 0.19, 1).map((q) => q.id),
        ).toEqual([1, 2]);
    });

    test("a MIXED-slope map throws — one frozen probe does not excuse a residual in the healthy stretch", () => {
        // The reviewer's fixture for the exclusion's EXTENT (its threshold is unchanged): the map
        // reads the frozen slope on `u < 0.2` and 9 m/s everywhere else, with the same hidden 5 s
        // station jump as the arms above sitting in the MOVING part.
        //
        // **Red before this repair, measured:** the clause was `vLo <= V_FLOOR·STALL_SLACK`, a `min`
        // over the whole segment (endpoints included), so the one frozen endpoint silenced the guard
        // and `carryForce` returned 2 keys carrying a **0.4803 g** residual against the 0.19 g bound —
        // bit for bit B4's own silent-failure number, and the retired swing clause's defect one level
        // down: an exclusion firing precisely where the residual is worst. The repair decides the
        // exclusion on the residual the MOVING probes carry, so a frozen stretch excuses only its own
        // lossiness.
        const mixed = (u: number) => ({
            value: u <= 0.5 ? u : u + 5,
            slope: u < 0.2 ? FrozenSlope : 9,
        });
        expect(mixed(0).slope).toBeLessThan(V_FLOOR * (1 + 16 * 2 ** -24)); // the frozen endpoint is real
        expect(() => carryForce(floorPair, floorPair, mixed, Domain.Time, 0.19, 1)).toThrow(
            /partial fit at the march resolution floor/,
        );
        // and the mirror image: the jump inside the frozen stretch, the moving part carrying the
        // reshape. Also silenced before, also a refusal now.
        const mirrored = (u: number) => ({
            value: u <= 0.5 ? u : u + 5,
            slope: u <= 0.5 ? 9 : FrozenSlope,
        });
        expect(() => carryForce(floorPair, floorPair, mirrored, Domain.Time, 0.19, 1)).toThrow(
            /partial fit at the march resolution floor/,
        );
    });

    test("the same call on an affine map returns — the guard is not a blanket refusal at the floor", () => {
        // the grant direction, which `checks.md` says nobody writes: a locally affine map carries
        // exactly (the Δs scale IS the whole map there), so the floor is reached with nothing to fix.
        const affine = (s: number) => ({ value: 2 * s, slope: 0.5 });
        const out = carryForce(floorPair, floorPair, affine, Domain.Time, 0.19, 1);
        expect(out.map((p) => p.id)).toEqual([1, 2]);
        expect(out.every((p) => !p.carried)).toBe(true);
    });

    test("the refusal reaches the PERSON: one plain sentence for the readout, the internals to the console", () => {
        // The fail-loud deliverable's other half. The guard's throw was caught at the surface and
        // logged only — so the ruler row stayed enabled, the click did nothing, no readout appeared,
        // and (the throw being caught) the capture harness's `pageerror` watch stopped seeing it too:
        // no gate anywhere observed the refusal. `convertFailed` is `editor.solveFailed`'s shape for
        // this module's one throw, and `Timeline.pickDomain` raises the notice beside the log.
        //
        // Red before this repair: no notice existed to assert, and this call site did not exist.
        const spike = (s: number) => ({ value: s <= 0.5 ? s : s + 5, slope: 1 });
        let thrown: unknown;
        try {
            carryForce(floorPair, floorPair, spike, Domain.Time, 0.19, 1);
        } catch (e) {
            thrown = e;
        }
        expect(thrown).toBeInstanceOf(Error);
        const { notice, detail } = convertFailed(thrown);
        // the sentence is for the person: no function names, no g residuals, and it says the document
        // is untouched (which the op guarantees — it lands one entry or none).
        expect(notice).toBe("The units could not be switched. Nothing changed.");
        expect(notice).not.toContain("carryForce");
        expect(notice).not.toMatch(/\d/);
        // and the detail is the thrown message itself, which is what the console is for.
        expect(detail).toContain("partial fit at the march resolution floor");
        expect(detail).toContain("carryForce");
        // a non-Error rejection still yields both halves rather than "undefined".
        expect(convertFailed("broke").detail).toBe("broke");
    });

    test("the ruler pick's catch RAISES the notice as well as logging the detail", () => {
        // The wiring, and this arm is a source-text read because nothing else in this stage's reach
        // can see it: `pickDomain` is inside a Svelte component, and the capture harness (which is
        // where a real click could witness the readout) is outside this footprint. So it asserts the
        // two call expressions inside the catch — not a mention, not a comment — and its own limit is
        // that it cannot prove a notice ever reaches the DOM. What it does pin is the defect that was
        // there: a catch holding `console.error` alone, which is silent to the person and to every
        // gate. Whoever lands a capture flow for the ruler menu should replace this with it.
        const tl = readFileSync(new URL("../src/Timeline.svelte", import.meta.url), "utf8");
        const body = tl.slice(tl.indexOf("function pickDomain"));
        const cat = body.slice(body.indexOf("} catch (e) {"), body.indexOf("const NOTICE_MS"));
        expect(cat).toContain("convertFailed(e)");
        expect(cat).toContain("console.error(detail)");
        expect(cat).toContain('notify("error", notice)');
    });

    test("a real ride that stalls inside a force section flips instead of throwing", () => {
        // the degeneracy the guard must NOT fire on, and the class that found it: a gentle force
        // curve (floor 0.005 g) on a section the upstream geometry brings to a stop. `V_FLOOR` makes
        // each frozen edge cost `ds/V_FLOOR` = 50 s, so the map's slope drops 170× across one floor
        // span — the tolerance says nothing there, and the flip is the locked lossy one, not a defect.
        // Measured before the degeneracy clause: this exact document threw with |Δg| 0.0128 g > 0.005 g.
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        const geo = createSection(state, 0, SectionKind.Geo, 0);
        addNode(state, geo, 0, 0);
        addNode(state, geo, 24, 0);
        addNode(state, geo, 48, 4); // climbs — the cart runs out of speed inside the force section
        const force = createSection(state, 1, SectionKind.Force, 30);
        createForcePoint(state, force, 0, 1);
        createForcePoint(state, force, 30, 0.8);
        state.step(0);
        const out = bakeOut.get(trackEntity(state) as number);
        if (!out) throw new Error("no bake");
        expect(Math.min(...out.v.subarray(0, Track.count.get(trackEntity(state) as number)))).toBe(
            0,
        );

        expect(convertDomain(createHistory(), state, Domain.Time)).toBe(true);
        expect(sectionForces(state, force).some((p) => p.carried)).toBe(true);
    });
});

// D1 deliverable 4 — **the bezier-vs-linear recount.** S1's fit proxy was linear where the real
// scheme is bezier, so every S1 count was a conservative upper bound. Recounted here at the real
// scheme against S1's own proxy on the SAME two fixtures and the same tolerance and probes: the only
// difference is what an inserted key can say about the curve between it and its neighbour.
//
// **Measured: dive-and-recover 5 keys bezier vs 10 linear (2.0×); multi-g pull 6 vs 9 (1.5×).** S1's
// recorded 3→8 and 4→6 were therefore upper bounds, as it said; the real scheme lands 3→5 and 4→6.
describe("bezier vs linear key counts (D1)", () => {
    /** S1's proxy: an inserted key carries a VALUE only, so the target curve between two keys is the
     *  chord. Same tolerance, same probe spacing, same midpoint split, same floor — a fit model, not
     *  a second implementation of the carry. */
    function linearProxyCount(len: number, pts: readonly [number, number][]): number {
        const { state, eid, sec } = forceTrack(len, pts);
        const source = profilePts(state, sec);
        const step = resolveStep(len, DS_NOMINAL);
        const tol = resolutionFloor(source, step);
        const tab = table(eid);
        const at = (s: number): number => interp(tab.arc, tab.t, s);
        let keys = source.length;
        const refine = (a: number, b: number): void => {
            const ta = at(a);
            const tb = at(b);
            const ga = sampleForce(source, a);
            const gb = sampleForce(source, b);
            const probe = Math.min((b - a) / 5, step.ds);
            let worst = 0;
            for (let s = a + probe; s < b - 1e-12; s += probe) {
                const f = (at(s) - ta) / (tb - ta);
                worst = Math.max(worst, Math.abs(ga + f * (gb - ga) - sampleForce(source, s)));
            }
            if (worst <= tol || b - a <= step.ds) return;
            keys++;
            const mid = (a + b) / 2;
            refine(a, mid);
            refine(mid, b);
        };
        for (let i = 0; i + 1 < source.length; i++) refine(source[i].s, source[i + 1].s);
        return keys;
    }

    test("the real bezier scheme lands strictly fewer keys than S1's linear proxy, both fixtures", () => {
        for (const [len, pts] of [DIVE_AND_RECOVER, MULTI_G_PULL]) {
            const { state, sec } = forceTrack(len, pts);
            expect(convertDomain(createHistory(), state, Domain.Time)).toBe(true);
            const bezier = sectionForces(state, sec).length;
            const linear = linearProxyCount(len, pts);
            expect(bezier).toBeLessThan(linear);
        }
    });
});

// BL-2 — the fit reference is the section's VISIBLE curve, not the authored-only set.
// § Locked decision > Domain fidelity: `convertDomain` conflated two sets — the output key set
// (carried keys dropped — correct) and the fit reference (the authored-only bezier — the defect).
// Separating them is the repair: the reverse flip now fits against the full visible curve the carry
// exists to preserve, and the drop survives untouched on the output alone. The Residue lesson is
// that one expression serving two roles is how this stayed hidden through two adversarial passes.
describe("the fit reference (BL-2)", () => {
    /** KeySnap[] from the ECS state — structurally compatible with `SectionSnapshot["points"][number]`. */
    function keySnaps(state: State, sec: number) {
        return sectionForces(state, sec).map((p) => {
            const tan = forceTangent(state, p.id);
            const snap: {
                id: number;
                s: number;
                g: number;
                ease: Easing;
                tangent?: ForceTangent;
                carried: boolean;
            } = {
                id: p.id,
                s: p.s,
                g: p.g,
                ease: forceEase(state, p.id),
                carried: forceCarried(state, p.id),
            };
            if (tan) snap.tangent = tan;
            return snap;
        });
    }

    /** KeySnap[] -> ForcePoint[] (same as domain.ts's internal `asPoint`). */
    function toForcePoints(
        keys: { s: number; g: number; ease: Easing; tangent?: ForceTangent }[],
    ): ForcePoint[] {
        return keys.map((k) => {
            const p: ForcePoint = { s: k.s, g: k.g, ease: k.ease };
            if (k.tangent?.in) p.in = k.tangent.in;
            if (k.tangent?.out) p.out = k.tangent.out;
            return p;
        });
    }

    /** speed (dArc/dt) at global distance `d` from the independent table. */
    function slopeAtDist(tab: { arc: number[]; t: number[] }, d: number): number {
        const last = tab.arc.length - 1;
        if (d <= tab.arc[0] || d >= tab.arc[last]) return V_FLOOR;
        let lo = 0;
        while (lo + 1 < tab.arc.length && tab.arc[lo + 1] <= d) lo++;
        const dt = tab.t[lo + 1] - tab.t[lo];
        return Math.max(dt > 0 ? (tab.arc[lo + 1] - tab.arc[lo]) / dt : 0, V_FLOOR);
    }

    /** speed (dArc/dt) at global time `t` from the independent table. */
    function slopeAtTime(tab: { arc: number[]; t: number[] }, t: number): number {
        const last = tab.t.length - 1;
        if (t <= tab.t[0] || t >= tab.t[last]) return V_FLOOR;
        let lo = 0;
        while (lo + 1 < tab.t.length && tab.t[lo + 1] <= t) lo++;
        const dt = tab.t[lo + 1] - tab.t[lo];
        return Math.max(dt > 0 ? (tab.arc[lo + 1] - tab.arc[lo]) / dt : 0, V_FLOOR);
    }

    /** (a) the reverse-flip (Seconds->Metres) shape delta: the force curve sampled at every nominal
     *  march station before and after the flip, at the same ride position through the source bake's
     *  table. This is the same measurement `flipDelta` makes in the forward direction. */
    function reverseFlipShape(
        len: number,
        pts: readonly [number, number][],
    ): { worst: number; tol: number; ratio: number } {
        const { state, eid, sec } = forceTrack(len, pts);
        const h = createHistory();
        // M->S: forward flip inserts carried keys
        expect(convertDomain(h, state, Domain.Time)).toBe(true);
        state.step(0);

        const before = profilePts(state, sec); // visible curve in Time (authored + carried)
        const tab = table(eid); // Time bake's arc<->time table
        const duration = extent(state, sec);
        const step = resolveStep(duration, DT_NOMINAL);
        const tol = resolutionFloor(before, step);

        // S->M: reverse flip (uses the fix — visible as reference)
        expect(convertDomain(h, state, Domain.Distance)).toBe(true);
        const after = profilePts(state, sec);

        // measure: sample at time stations, map to distance through the Time bake's table
        let worst = 0;
        for (let i = 0; i <= step.edges; i++) {
            const t = Math.min(duration, i * step.ds);
            const s = interp(tab.t, tab.arc, t);
            worst = Math.max(worst, Math.abs(sampleForce(after, s) - sampleForce(before, t)));
        }
        return { worst, tol, ratio: worst / tol };
    }

    /** (b) the M->S->M round-trip: the reverse flip's carry shape preservation (the same
     *  measurement as (a)), plus the witness that the carry inserts NOTHING on the way back —
     *  the "exact" reading the probe recorded. The round trip reads exact because the authored
     *  stations round-trip through the table by lookup and the reference already sits inside
     *  the floor, so the carry inserts nothing on the way back (§ Locked decision). */
    function roundTripShape(
        len: number,
        pts: readonly [number, number][],
    ): { worst: number; tol: number; ratio: number; carriedBack: number } {
        const { state, eid, sec } = forceTrack(len, pts);
        const h = createHistory();
        // M->S: forward flip inserts carried keys
        expect(convertDomain(h, state, Domain.Time)).toBe(true);
        state.step(0);

        const before = profilePts(state, sec); // visible curve in Time
        const tab = table(eid);
        const duration = extent(state, sec);
        const step = resolveStep(duration, DT_NOMINAL);
        const tol = resolutionFloor(before, step);

        // S->M: reverse flip
        expect(convertDomain(h, state, Domain.Distance)).toBe(true);
        const after = profilePts(state, sec);
        const carriedBack = sectionForces(state, sec).filter((p) => p.carried).length;

        // measure the carry's shape preservation: returned Distance vs visible Time at mapped positions
        let worst = 0;
        for (let i = 0; i <= step.edges; i++) {
            const t = Math.min(duration, i * step.ds);
            const s = interp(tab.t, tab.arc, t);
            worst = Math.max(worst, Math.abs(sampleForce(after, s) - sampleForce(before, t)));
        }
        return { worst, tol, ratio: worst / tol, carriedBack };
    }

    // (a) seconds->metres shape arm on both fixtures, delta within the section's runtime-derived
    // floor. Probe readings to beat: 0.116x / 0.727x against a baseline of 1.395x / 2.454x.
    test("(a) seconds->metres shape: dive-and-recover within the floor", () => {
        const r = reverseFlipShape(...DIVE_AND_RECOVER);
        expect(r.worst).toBeLessThanOrEqual(r.tol);
        expect(r.worst).toBeGreaterThan(0); // the flip is real, not a no-op
        // measured reading: 0.096x (worst / tol) — within the floor
    });

    test("(a) seconds->metres shape: multi-g pull within the floor", () => {
        const r = reverseFlipShape(...MULTI_G_PULL);
        expect(r.worst).toBeLessThanOrEqual(r.tol);
        expect(r.worst).toBeGreaterThan(0);
        // measured reading: 0.592x (worst / tol) — within the floor
    });

    // (b) M->S->M round-trip arm on both fixtures, asserting within the floor. The probe read it
    // exact, so the reading is recorded in the docblock rather than pinned as the property —
    // § Locked decision says exactness is a consequence (the reference sits inside the floor, so
    // the carry inserts nothing on the way back), not a promise (the baked world exit still moves).
    test("(b) M->S->M round-trip: dive-and-recover — carry inserts nothing on the way back", () => {
        const r = roundTripShape(...DIVE_AND_RECOVER);
        expect(r.carriedBack).toBe(0); // the "exact" reading: the carry inserted zero keys back
        expect(r.worst).toBeLessThanOrEqual(r.tol); // shape preservation within the floor
    });

    test("(b) M->S->M round-trip: multi-g pull — carry inserts nothing on the way back", () => {
        const r = roundTripShape(...MULTI_G_PULL);
        expect(r.carriedBack).toBe(0); // the "exact" reading
        expect(r.worst).toBeLessThanOrEqual(r.tol);
    });

    // (c) red-first witness on the reference itself. Reverting the fit reference to the authored-only
    // set reds (a) and (b) — witnessed by temporarily reverting the fix in domain.ts (changing
    // `carryForce(visible, authored, ...)` back to `carryForce(authored, authored, ...)` and
    // `resolutionFloor(visible, ...)` back to `resolutionFloor(authored, ...)`) and running the
    // arms above. The witnessed readings (delta / visible-floor, the floor (a) asserts against):
    //   (a) dive-and-recover: 1.32x  (defect) vs 0.096x (fix)  — defect reds, fix passes
    //   (a) multi-g pull:     2.11x  (defect) vs 0.592x (fix)  — defect reds, fix passes
    //   (b) dive-and-recover: 1 carried key back (defect) vs 0 (fix)  — defect reds, fix passes
    //   (b) multi-g pull:     2 carried keys back (defect) vs 0 (fix) — defect reds, fix passes
    // The spec's probe recorded 1.395x / 2.454x for (a) against the authored-only floor (smaller
    // than the visible floor, so the ratio is higher); this test asserts against the visible floor
    // (the correct one), so the defect ratios are 1.32x / 2.11x — both still > 1, which is the red.
    // Without (c) the other two are satisfiable by the defect, which is how BL-2 stayed hidden
    // under a green D1 gate through two adversarial passes — D1's own gate was green in the
    // forward direction throughout.
    test("(c) reverting the fit reference to authored-only reds (a) and (b) — witnessed", () => {
        for (const [len, pts] of [DIVE_AND_RECOVER, MULTI_G_PULL]) {
            const { state, eid, sec } = forceTrack(len, pts);
            const h = createHistory();
            // M->S: forward flip inserts carried keys
            expect(convertDomain(h, state, Domain.Time)).toBe(true);
            state.step(0);

            const before = profilePts(state, sec); // visible curve in Time
            const tab = table(eid);
            const duration = extent(state, sec);
            const step = resolveStep(duration, DT_NOMINAL);
            const correctFloor = resolutionFloor(before, step); // floor from the visible set

            const snaps = keySnaps(state, sec);
            const authored = snaps.filter((p) => !p.carried);
            const visible = snaps;

            // the defect: authored-only as both reference AND output, tol from authored-only
            const defectTol = resolutionFloor(toForcePoints(authored), step);
            const mapToDist = (t: number) => ({
                value: interp(tab.t, tab.arc, t),
                slope: slopeAtTime(tab, t),
            });
            const defectKeys = carryForce(
                authored,
                authored,
                mapToDist,
                Domain.Distance,
                defectTol,
                step.ds,
            );
            const defectAfter = toForcePoints(defectKeys);

            // measure the defect's shape delta the same way (a) does
            let defectWorst = 0;
            for (let i = 0; i <= step.edges; i++) {
                const t = Math.min(duration, i * step.ds);
                const s = interp(tab.t, tab.arc, t);
                defectWorst = Math.max(
                    defectWorst,
                    Math.abs(sampleForce(defectAfter, s) - sampleForce(before, t)),
                );
            }
            // the defect's delta exceeds the correct floor — this is the red
            expect(defectWorst).toBeGreaterThan(correctFloor);

            // and the fix: visible as reference, authored as output, tol from visible
            const fixTol = resolutionFloor(toForcePoints(visible), step);
            const fixKeys = carryForce(
                visible,
                authored,
                mapToDist,
                Domain.Distance,
                fixTol,
                step.ds,
            );
            const fixAfter = toForcePoints(fixKeys);

            let fixWorst = 0;
            for (let i = 0; i <= step.edges; i++) {
                const t = Math.min(duration, i * step.ds);
                const s = interp(tab.t, tab.arc, t);
                fixWorst = Math.max(
                    fixWorst,
                    Math.abs(sampleForce(fixAfter, s) - sampleForce(before, t)),
                );
            }
            // the fix's delta is inside the floor
            expect(fixWorst).toBeLessThanOrEqual(correctFloor);
        }
    });

    // (d) forward-direction byte-identity: a freshly authored section has no carried keys, so
    // `visible === authored` there, and the reference change must move the forward flip not at all.
    // Measured by calling carryForce both ways (visible vs authored as reference) and comparing the
    // resulting curves — the two are byte-identical because the reference and output sets are the
    // same set when nothing is carried.
    test("(d) forward-direction byte-identity: visible === authored, reference change moves nothing", () => {
        for (const [len, pts] of [DIVE_AND_RECOVER, MULTI_G_PULL]) {
            const { state, eid, sec } = forceTrack(len, pts);
            const tab = table(eid);
            const step = resolveStep(len, DS_NOMINAL);

            const snaps = keySnaps(state, sec);
            // a freshly authored section has no carried keys
            expect(snaps.every((p) => !p.carried)).toBe(true);
            const authored = snaps.filter((p) => !p.carried);
            const visible = snaps;
            // visible === authored (same content, no carried keys)
            expect(toForcePoints(visible)).toEqual(toForcePoints(authored));

            const mapToTime = (s: number) => ({
                value: interp(tab.arc, tab.t, s),
                slope: slopeAtDist(tab, s),
            });
            const tol = resolutionFloor(toForcePoints(authored), step);

            const fromVisible = toForcePoints(
                carryForce(visible, authored, mapToTime, Domain.Time, tol, step.ds),
            );
            const fromAuthored = toForcePoints(
                carryForce(authored, authored, mapToTime, Domain.Time, tol, step.ds),
            );

            // byte-identical curves: same key count, same positions, same g values
            expect(fromVisible.length).toBe(fromAuthored.length);
            for (let i = 0; i < fromVisible.length; i++) {
                expect(fromVisible[i].s).toBe(fromAuthored[i].s);
                expect(fromVisible[i].g).toBe(fromAuthored[i].g);
            }
        }
    });
});
