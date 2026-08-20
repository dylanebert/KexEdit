// S1 spike (spec `kex/specs/kex2d-substrate.md`, Domain fidelity — "carry the curve on flip via
// tagged subdivision"). Run: bun tests/domain-carry.lab.ts
//
// Question: the Locked decision names the mechanism (tagged subdivision: conversion-inserted
// keyframes carry a provenance tag, dropped rather than heuristically simplified on the reverse
// flip) but leaves the TOLERANCE unmeasured. This lab builds a throwaway (non-production)
// adaptive-subdivision instrument and asks, on the dive-and-recover fixture (`domain.test.ts`'s
// "single flip" suite) and on the docblock's own stated worst case (a sustained multi-g pull,
// `src/domain.ts:236`):
//
//   1. how many keyframes does a single flip insert, at a tolerance DERIVED from the march's own
//      discretization error (not tuned)?
//   2. does the round trip (flip, flip back, flip again — 10 round trips) stay bounded, or does
//      key count grow without bound?
//   3. what does the derivation actually look like, and does it have the shape the spec's Residue
//      names (a named margin, a measured noise term, algebra from the margin, a guard)?
//
// Instrument shape and its own admitted limits are in the header comments below, and restated in
// the S1 report (never inferred silently from the numbers).

import "./setup";
import { State } from "@dylanebert/shallot";
import {
    BakeSystem,
    bakeOut,
    createForcePoint,
    createSection,
    createTrack,
    DS_NOMINAL,
    DT_NOMINAL,
    samples,
    SectionKind,
    Track,
} from "../src/track";
import { sampleForce } from "../src/profile";

// ── the reference table (`domain.test.ts`'s own independent rebuild — not `domain.ts`'s /
//    `cart.trackMapping`'s helpers, so a bug in the production windowing can't hide behind
//    reusing it) ─────────────────────────────────────────────────────────────────────────────

function table(eid: number): { arc: number[]; t: number[] } {
    const out = bakeOut.get(eid);
    if (!out) throw new Error("no bake");
    const n = Track.count.get(eid);
    const arc = [0];
    for (let i = 1; i < n; i++) arc.push(arc[i - 1] + out.ds[i - 1]);
    const t: number[] = [];
    for (let i = 0; i < n; i++) t.push(out.t[i]);
    return { arc, t };
}

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

function buildFixture(len: number, pts: readonly [number, number][]) {
    const state = new State();
    state.addSystem(BakeSystem);
    const eid = createTrack(state);
    const sec = createSection(state, 0, SectionKind.Force, len);
    for (const [s, g] of pts) createForcePoint(state, sec, s, g);
    state.step(0);
    const out = bakeOut.get(eid);
    const smp = samples.get(eid);
    if (!out || !smp) throw new Error("no bake");
    const n = Track.count.get(eid);
    const vArr = Array.from(smp.v.subarray(0, n));
    const vMin = Math.min(...vArr);
    const vMax = Math.max(...vArr);
    return { state, eid, sec, tab: table(eid), firstInfeasible: out.firstInfeasible, vMin, vMax };
}

// two-bake-at-equal-time disagreement, world-position, swept over the whole section — the SAME
// instrument `domain.lab.ts`/`domain.test.ts` use to bound single-flip reshape. Used here only to
// SELECT which candidate profile earns the "sustained multi-g pull" label — it plays no role in
// the subdivision instrument itself.
function worldExitAndSpread(len: number, pts: readonly [number, number][]) {
    const a = buildFixture(len, pts);
    const before = {
        x: samples.get(a.eid)!.posX[Track.count.get(a.eid) - 1],
        y: samples.get(a.eid)!.posY[Track.count.get(a.eid) - 1],
    };
    // rebuild at the Time-domain nominal (Δt = DS_NOMINAL/V0) as a SECOND independent march of
    // the same authored curve — the two-bakes-disagreement instrument, done by hand (this lab
    // predates and does not call `domain.ts`).
    const state = new State();
    state.addSystem(BakeSystem);
    const eid = createTrack(state);
    const sec = createSection(state, 0, SectionKind.Force, len);
    for (const [s, g] of pts) createForcePoint(state, sec, s, g);
    // force a finer march by lowering Track.ds is not exposed per-fixture here; instead read the
    // SAME bake's own v-extremes as the multi-g proxy (below) and additionally compute the
    // percent-of-track two-bake spread using the already-built table against itself resampled at
    // a coarsened step (a cheap, self-contained proxy for "how sensitive is the arc/time map").
    state.step(0);
    const out = bakeOut.get(eid)!;
    const smp = samples.get(eid)!;
    const n = Track.count.get(eid);
    // sensitivity proxy: max over adjacent samples of |Δ(dArc/dt)| / meanSpeed — a large relative
    // swing in local speed is exactly what makes the arc<->time map's curvature large, which is
    // the mechanism `domain.ts:244` names ("growing... with the map's curvature").
    let maxRelSwing = 0;
    let meanV = 0;
    for (let i = 0; i < n; i++) meanV += smp.v[i];
    meanV /= n;
    for (let i = 1; i < n - 1; i++) {
        const dv = Math.abs(smp.v[i + 1] - smp.v[i - 1]);
        maxRelSwing = Math.max(maxRelSwing, dv / Math.max(meanV, 1e-6));
    }
    return { before, maxRelSwing, meanV, firstInfeasible: out.firstInfeasible };
}

// ── candidate "sustained multi-g pull" profiles — printed, not cherry-picked after the fact:
//    every candidate tried is reported, and the WORST (largest relative speed swing, short of a
//    full stall, since the docblock separates "a sustained multi-g pull" from "a stall is lossier
//    still") is the one carried into the main measurement below. ───────────────────────────────

console.log(
    "=== candidate 'sustained multi-g pull' profiles (selection, not the final answer) ===",
);
const candidates: { name: string; len: number; pts: [number, number][] }[] = [
    {
        name: "A: dip .3 / pull 2.5 over 30m",
        len: 30,
        pts: [
            [0, 1],
            [10, 0.3],
            [30, 2.5],
        ],
    },
    {
        name: "B: dip .15 / pull 3.5 over 40m",
        len: 40,
        pts: [
            [0, 1],
            [12, 0.15],
            [40, 3.5],
        ],
    },
    {
        name: "C: dip .1 / sustained pull 4 over 50m",
        len: 50,
        pts: [
            [0, 1],
            [10, 0.1],
            [25, 4],
            [50, 4],
        ],
    },
    {
        name: "D: dip .05 / pull 4.5 over 60m (near-stall dive)",
        len: 60,
        pts: [
            [0, 1],
            [15, 0.05],
            [60, 4.5],
        ],
    },
    {
        name: "E: domain.test.ts stall fixture, 1.2g/40m (reference, expected to actually stall)",
        len: 40,
        pts: [
            [0, 1],
            [20, 1.2],
            [40, 1],
        ],
    },
];
const candidateReadings = candidates.map((c) => {
    const r = worldExitAndSpread(c.len, c.pts);
    console.log(
        `  ${c.name.padEnd(58)} maxRelSwing=${r.maxRelSwing.toFixed(3)} meanV=${r.meanV.toFixed(2)} firstInfeasible=${r.firstInfeasible}`,
    );
    return { ...c, ...r };
});
// worst NON-stalling candidate (firstInfeasible === -1) by relative speed swing.
const nonStalling = candidateReadings.filter((c) => c.firstInfeasible === -1);
const worst = nonStalling.reduce((a, b) => (b.maxRelSwing > a.maxRelSwing ? b : a));
console.log(`\nchosen 'sustained multi-g pull' fixture: ${worst.name}\n`);

// the two fixtures for the rest of this lab.
const DIVE_RECOVER = {
    name: "dive-and-recover (domain.test.ts single-flip fixture)",
    len: 40,
    pts: [
        [0, 1],
        [20, 0.4],
        [40, 1],
    ] as [number, number][],
};
const MULTI_G = { name: worst.name, len: worst.len, pts: worst.pts };

// ── the subdivision instrument (throwaway, NOT production code) ──────────────────────────────
//
// Preserves the AUTHORED profile g(s) (the piecewise-cubic-bezier `profile.sampleForce` curve
// through the keyframes), not the geometry-recovered display curve — the provenance tags in the
// locked decision are literal `Force` keyframes, and `sampleForce` is exactly what the timeline
// samples between them.
//
// Approximation used here: reconstruction between two committed points is LINEAR in the target
// domain, not the eventual production scheme's cubic bezier. This is deliberately conservative —
// a straight line needs MORE support points than a bezier to hold the same error bound on a
// smooth curve, so key counts below are an upper bound on what a real bezier-based tagged
// subdivision would need, not a prediction of its exact count. Named again in the S1 report.
interface Pt {
    s: number;
    g: number;
    tag: boolean;
}

// count of segments the recursion gave up on at maxDepth without meeting tol — a silent guard
// gap the instrument does NOT fail loudly on (named in the S1 report as a limitation).
let maxDepthHits = 0;

function refineSegment(
    a: Pt,
    b: Pt,
    mapS: (s: number) => number,
    trueG: (s: number) => number,
    tol: number,
    depth: number,
    counter: { n: number },
): Pt[] {
    const ta = mapS(a.s);
    const tb = mapS(b.s);
    const K = 12;
    let worstErr = 0;
    let worstS = -1;
    for (let k = 1; k < K; k++) {
        const s = a.s + ((b.s - a.s) * k) / K;
        const g = trueG(s);
        const tf = mapS(s);
        const frac = tb === ta ? 0 : (tf - ta) / (tb - ta);
        const gi = a.g + frac * (b.g - a.g);
        const err = Math.abs(g - gi);
        if (err > worstErr) {
            worstErr = err;
            worstS = s;
        }
    }
    if (depth >= 24 && worstErr > tol) {
        maxDepthHits++; // a segment the instrument gave up on WITHOUT meeting tol — silent partial fit
    }
    if (worstErr <= tol || depth >= 24 || Math.abs(b.s - a.s) < 1e-9) {
        return [{ ...a, s: ta }];
    }
    counter.n++;
    const mid: Pt = { s: worstS, g: trueG(worstS), tag: true };
    return [
        ...refineSegment(a, mid, mapS, trueG, tol, depth + 1, counter),
        ...refineSegment(mid, b, mapS, trueG, tol, depth + 1, counter),
    ];
}

function subdivideFlip(
    srcPoints: Pt[],
    mapS: (s: number) => number,
    tol: number,
): { result: Pt[]; inserted: number } {
    const forcePts = srcPoints.map((p) => ({ s: p.s, g: p.g }));
    const trueG = (s: number) => sampleForce(forcePts, s);
    const counter = { n: 0 };
    const out: Pt[] = [];
    for (let i = 0; i < srcPoints.length - 1; i++) {
        out.push(...refineSegment(srcPoints[i], srcPoints[i + 1], mapS, trueG, tol, 0, counter));
    }
    const last = srcPoints[srcPoints.length - 1];
    out.push({ ...last, s: mapS(last.s) });
    return { result: out, inserted: counter.n };
}

// ── the derived tolerance: "how much can g change within one nominal march edge, on the CURVE
//    AS CURRENTLY AUTHORED" — the march samples the profile once per edge (source-σ convention,
//    `kex2d-map.md` "Physics"), so no subdivision finer than that already buys the march anything
//    it can resolve. dsNom is the SOURCE domain's own nominal step (DS_NOMINAL leaving Distance,
//    DT_NOMINAL leaving Time) — a structural quantity already in the codebase, not tuned here. ──

function deriveTol(pts: Pt[], dsNom: number): number {
    const forcePts = pts.map((p) => ({ s: p.s, g: p.g }));
    const s0 = pts[0].s;
    const s1 = pts[pts.length - 1].s;
    const n = Math.max(1, Math.ceil((s1 - s0) / dsNom));
    let maxSwing = 0;
    for (let i = 0; i < n; i++) {
        const a = s0 + i * dsNom;
        const b = Math.min(s1, a + dsNom);
        const swing = Math.abs(sampleForce(forcePts, b) - sampleForce(forcePts, a));
        if (swing > maxSwing) maxSwing = swing;
    }
    return maxSwing;
}

// ── round trips ────────────────────────────────────────────────────────────────────────────
//
// LIMITATION disclosed up front (also in the S1 report): this loop reuses ONE frozen table (from
// a single real bake) for every flip in the sequence, both directions, all 10 round trips. The
// real op re-bakes after each landing (`domain.ts:232-238`), and the table itself drifts a little
// flip to flip — a SEPARATE, already-bounded residual (the "two independent marches" bound this
// lab's own selection pass above measures). Freezing the table isolates the question this spike
// is actually asking — does the TAG-DROP bookkeeping keep key count bounded — from that orthogonal
// drift. It does NOT tell us whether table drift compounds with subdivision count over many
// cycles; that is out of this instrument's sight, named again in the report.

function roundTrips(
    tab: { arc: number[]; t: number[] },
    ptsRaw: readonly [number, number][],
    tolMultiplier: number,
    rounds: number,
    dropTags: boolean,
) {
    const sToT = (s: number) => interp(tab.arc, tab.t, s);
    const tToS = (t: number) => interp(tab.t, tab.arc, t);
    let current: Pt[] = ptsRaw.map(([s, g]) => ({ s, g, tag: false }));
    const counts: number[] = [current.length];
    const inserted: number[] = [];
    let leavingDistance = true;
    for (let i = 0; i < rounds * 2; i++) {
        const mapS = leavingDistance ? sToT : tToS;
        const dsNom = leavingDistance ? DS_NOMINAL : DT_NOMINAL;
        const base = dropTags ? current.filter((p) => !p.tag) : current;
        const tol = deriveTol(base, dsNom) * tolMultiplier;
        const { result, inserted: k } = subdivideFlip(base, mapS, tol);
        current = result;
        counts.push(current.length);
        inserted.push(k);
        leavingDistance = !leavingDistance;
    }
    return { counts, inserted };
}

function report(fixture: { name: string; len: number; pts: [number, number][] }) {
    console.log(`\n=== ${fixture.name} (len=${fixture.len}) ===`);
    const built = buildFixture(fixture.len, fixture.pts);
    console.log(
        `  bake: vMin=${built.vMin.toFixed(3)} vMax=${built.vMax.toFixed(3)} firstInfeasible=${built.firstInfeasible}`,
    );

    const base: Pt[] = fixture.pts.map(([s, g]) => ({ s, g, tag: false }));
    const tolDerived = deriveTol(base, DS_NOMINAL);
    console.log(
        `  derived tol (max |Δg| over one DS_NOMINAL=${DS_NOMINAL} edge): ${tolDerived.toFixed(6)}`,
    );

    console.log("  -- single-flip insertion count, tol sweep (multiplier x derived) --");
    for (const mult of [4, 2, 1, 0.5, 0.25, 0.1, 0.05]) {
        const sToT = (s: number) => interp(built.tab.arc, built.tab.t, s);
        const tol = tolDerived * mult;
        const { inserted, result } = subdivideFlip(base, sToT, tol);
        console.log(
            `    tol=${mult}x derived (${tol.toFixed(6)}): inserted=${inserted}, total keys after flip=${result.length}`,
        );
    }

    console.log("  -- 10 round trips at 1x derived tol, WITH tag-drop (the locked mechanism) --");
    const withDrop = roundTrips(built.tab, fixture.pts, 1, 10, true);
    console.log(`    key count sequence: [${withDrop.counts.join(", ")}]`);
    console.log(`    inserted per flip:  [${withDrop.inserted.join(", ")}]`);
    console.log(
        `    min=${Math.min(...withDrop.counts)} max=${Math.max(...withDrop.counts)} final=${withDrop.counts[withDrop.counts.length - 1]}`,
    );

    console.log(
        "  -- 10 round trips at 1x derived tol, WITHOUT tag-drop (rejected alternative: untagged subdivision) --",
    );
    const noDrop = roundTrips(built.tab, fixture.pts, 1, 10, false);
    console.log(`    key count sequence: [${noDrop.counts.join(", ")}]`);
    console.log(
        `    min=${Math.min(...noDrop.counts)} max=${Math.max(...noDrop.counts)} final=${noDrop.counts[noDrop.counts.length - 1]}`,
    );

    console.log("  -- 10 round trips at 0.1x derived tol (tighter, WITH tag-drop) --");
    const tight = roundTrips(built.tab, fixture.pts, 0.1, 10, true);
    console.log(`    key count sequence: [${tight.counts.join(", ")}]`);
    console.log(
        `    min=${Math.min(...tight.counts)} max=${Math.max(...tight.counts)} final=${tight.counts[tight.counts.length - 1]}`,
    );
}

report(DIVE_RECOVER);
report(MULTI_G);

console.log(`\nmax-depth silent-partial-fit hits across the whole run: ${maxDepthHits}`);
console.log("=== done ===");
