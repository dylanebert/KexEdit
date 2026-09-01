import { describe, expect, test } from "bun:test";
import { State } from "@dylanebert/shallot";
import {
    appendSection as appendCmd,
    createHistory,
    removeSection as removeCmd,
    splitSection as splitCmd,
    undo,
} from "../src/history";
import {
    addNode,
    allStrips,
    appendSection,
    BakeSystem,
    createForcePoint,
    createSection,
    createStrip,
    createTrack,
    deleteSection,
    DS_NOMINAL,
    EXTEND_DIST,
    bakeOut,
    exitWorld,
    Force,
    forceTangent,
    geoCutAt,
    Handle,
    handleAt,
    handleTangent,
    insertGeoNode,
    reheadOnDrag,
    removeTrailingHandle,
    samples,
    sectionCutAt,
    SectionKind,
    sectionForces,
    sectionHandles,
    sectionInfo,
    sections,
    sectionSpans,
    seedTangent,
    setTangent,
    setTrackDomain,
    setTrackFriction,
    splitForce,
    splitGeo,
    splitGeoAt,
    Track,
    trackDs,
} from "../src/track";
import { Domain } from "../src/section";
import { custom, DEFAULT_G, type Easing, type ForcePoint, sampleForce } from "../src/profile";
import { editTangent, subdivide, TangentMode } from "../src/spline";
import { stitchNode } from "../src/tangents";

/** a section's authored force keyframes as `profile.ts`'s `ForcePoint[]` — the exact
 *  projection `forceDense`/the bake use — so a test can sample the section's own
 *  profile through `sampleForce`, the SAME math the bake samples through, rather
 *  than re-deriving `splitForce`'s point-partition arithmetic (`coding.md`: a check
 *  that re-derives the rule it checks discriminates almost nothing). */
function forcePoints(state: State, sectionId: number): ForcePoint[] {
    return sectionForces(state, sectionId).map((p) => {
        const tan = forceTangent(state, p.id);
        return {
            s: p.s,
            g: p.g,
            ease: Force.ease.get(p.eid) as Easing,
            in: tan?.in,
            out: tan?.out,
        };
    });
}

// the multi-section structural ops: append / split / delete over the section
// chain (kex2d/AGENTS.md, structural ops). the substrate (chain, sectionInfo,
// local storage) is covered in section.test.ts; this pins the ECS-authoring layer —
// chain continuity across a boundary, split losslessness (f32 rigid round-off),
// and the rigid-placement payoff: an upstream edit rigidly carries downstream. device-free.

/** a two-geo-section chain: a bent lead-in section (exit heading ≠ 0, so the boundary
 *  frame is a real rotation) + an appended flat section. baked. */
function twoGeo(): { state: State; eid: number; a: number; b: number } {
    const state = new State();
    state.addSystem(BakeSystem);
    const eid = createTrack(state);
    const a = createSection(state, 0, SectionKind.Geo, 0);
    addNode(state, a, 0, 0);
    addNode(state, a, EXTEND_DIST, 0);
    // bend the lead-in: raise its tip and rehead, so section a exits climbing.
    const tip = sectionHandles(state, a)[1];
    Handle.pos.set(tip, EXTEND_DIST, 10);
    reheadOnDrag(state, tip);
    const b = appendSection(state, SectionKind.Geo);
    state.step(0);
    return { state, eid, a, b };
}

/** every baked world sample as {x,y}. */
function worldSamples(eid: number): { x: number; y: number }[] {
    const s = samples.get(eid);
    const count = Track.count.get(eid);
    if (!s) throw new Error("samples missing");
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < count; i++) out.push({ x: s.posX[i], y: s.posY[i] });
    return out;
}

/** cumulative arclength at each sample of a polyline (chord sums, `s[0] = 0`) — the
 *  station axis `atArc` interpolates over. */
function cumulativeArc(pts: { x: number; y: number }[]): number[] {
    const s = [0];
    for (let i = 1; i < pts.length; i++) {
        s.push(s[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    }
    return s;
}

/** a baked polyline's own position at an arbitrary cumulative arclength, linearly
 *  interpolated between its two bracketing samples — the world-curve pin's "matching
 *  arclengths" primitive: it reads a station independent of how densely either side of
 *  a cut happened to re-quantize its own segment. */
function atArc(
    pts: { x: number; y: number }[],
    arc: number[],
    target: number,
): { x: number; y: number } {
    const clamped = Math.max(0, Math.min(target, arc[arc.length - 1]));
    let i = 1;
    while (i < arc.length - 1 && arc[i] < clamped) i++;
    const s0 = arc[i - 1];
    const s1 = arc[i];
    const frac = s1 > s0 ? (clamped - s0) / (s1 - s0) : 0;
    return {
        x: pts[i - 1].x + frac * (pts[i].x - pts[i - 1].x),
        y: pts[i - 1].y + frac * (pts[i].y - pts[i - 1].y),
    };
}

/** the largest 3-point circumscribed-circle curvature over a polyline — κ = 4·Area(ABC)
 *  / (|AB|·|BC|·|CA|), measured directly off the baked samples. Feeds the derived
 *  chord-interpolation error bound in the world-curve pin below (never a tuned number,
 *  `coding.md`'s tolerance-discipline rule). */
function maxCurvature(pts: { x: number; y: number }[]): number {
    let k = 0;
    for (let i = 1; i < pts.length - 1; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const c = pts[i + 1];
        const area = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
        const ab = Math.hypot(b.x - a.x, b.y - a.y);
        const bc = Math.hypot(c.x - b.x, c.y - b.y);
        const ca = Math.hypot(a.x - c.x, a.y - c.y);
        if (ab > 0 && bc > 0 && ca > 0) k = Math.max(k, (4 * area) / (ab * bc * ca));
    }
    return k;
}

describe("chain continuity", () => {
    test("appended section shares its entry with the prior exit (no gap, C0)", () => {
        const { eid, a, b } = twoGeo();
        const infoA = sectionInfo.get(a);
        const infoB = sectionInfo.get(b);
        if (!infoA || !infoB) throw new Error("sectionInfo missing");
        // the boundary is one shared sample: A's last == B's first.
        expect(infoA.endSample).toBe(infoB.startSample);
        const s = samples.get(eid);
        if (!s) throw new Error("samples missing");
        // B's entry anchor is exactly A's exit (the chain seeds it, no tolerance).
        expect(infoB.entry.x).toBeCloseTo(s.posX[infoA.endSample], 6);
        expect(infoB.entry.y).toBeCloseTo(s.posY[infoA.endSample], 6);
    });

    test("a geo→force appended chain bakes across the boundary", () => {
        const { state, eid, a } = twoGeo();
        const f = appendSection(state, SectionKind.Force); // a third, force section
        state.step(0);
        expect(sections(state).map((x) => x.kind)).toEqual([
            SectionKind.Geo,
            SectionKind.Geo,
            SectionKind.Force,
        ]);
        const info = sectionInfo.get(f);
        if (!info) throw new Error("force section info missing");
        // the force section integrates from the geo chain's exit — a real, non-origin,
        // climbing entry — not from START.
        expect(info.entry.y).not.toBeCloseTo(0, 1);
        expect(Track.count.get(eid)).toBeGreaterThan(info.startSample);
        void a;
    });
});

describe("split", () => {
    test("splitting a geo section at an interior node preserves the geometry (lossless)", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        const a = createSection(state, 0, SectionKind.Geo, 0);
        for (const [x, y] of [
            [0, 0],
            [20, 4],
            [40, 4],
            [60, 0],
        ])
            addNode(state, a, x, y);
        state.step(0);
        const before = worldSamples(eid);

        const b = splitGeo(state, a, 2); // split at node order 2
        expect(b).not.toBeNull();
        state.step(0);
        const after = worldSamples(eid);

        // the split lands on a node (a sample boundary), so segments are unchanged —
        // the baked geometry is identical up to f32 rigid round-off.
        expect(after.length).toBe(before.length);
        for (let i = 0; i < before.length; i++) {
            expect(after[i].x).toBeCloseTo(before[i].x, 3);
            expect(after[i].y).toBeCloseTo(before[i].y, 3);
        }
        // two sections now, contiguous.
        expect(sections(state).map((s) => s.order)).toEqual([0, 1]);
    });

    test("splitting at a node with an explicit tangent keeps the baked world curve", () => {
        // the boundary re-frame must use the heading the bake will actually place the
        // tail at — the recovered curve heading (evalGeo/exitOf), NOT stored Handle.theta.
        // an explicit tangent decouples the two: here node 2 carries a Free corner whose
        // in/out vectors point far from its arc-rule theta, so a stored-theta frame
        // rotates the whole downstream section by metres.
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        const a = createSection(state, 0, SectionKind.Geo, 0);
        for (const [x, y] of [
            [0, 0],
            [20, 4],
            [40, 4],
            [60, 0],
        ])
            addNode(state, a, x, y);
        const mag = 15;
        setTangent(state, a, 2, {
            mode: TangentMode.Free,
            inX: mag * Math.cos(-1.2),
            inY: mag * Math.sin(-1.2),
            outX: mag * Math.cos(1.2),
            outY: mag * Math.sin(1.2),
        });
        state.step(0);
        const before = worldSamples(eid);

        const b = splitGeo(state, a, 2); // split ON the explicit-tangent node
        expect(b).not.toBeNull();
        state.step(0);
        const after = worldSamples(eid);

        expect(after.length).toBe(before.length);
        let maxDev = 0;
        for (let i = 0; i < before.length; i++)
            maxDev = Math.max(
                maxDev,
                Math.hypot(after[i].x - before[i].x, after[i].y - before[i].y),
            );
        // floor is the Auto split's f32 rigid round-off (~0.014 m over these ~60 m
        // coordinates, measured); 0.05 m is a few × that and far below the metres of
        // drift a stored-theta frame produces on this decoupled boundary.
        expect(maxDev).toBeLessThan(0.05);
    });

    test("splitting a force section partitions the points by arclength", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        const a = createSection(state, 0, SectionKind.Force, 40);
        createForcePoint(state, a, 10, 1);
        createForcePoint(state, a, 30, 2);
        const b = splitForce(state, a, 20);
        expect(b).not.toBeNull();
        if (b === null) return;

        // the point at s=10 stays in A; the s=30 point moves to B, rebased to 10 — plus
        // the boundary keyframe the exactness fix plants into both halves at the cut
        // (`splitForce`'s own subdivided value, s=20 head-side / s=0 tail-side).
        expect(sectionForces(state, a).map((p) => p.s)).toEqual([10, 20]);
        expect(sectionForces(state, b).map((p) => p.s)).toEqual([0, 10]);
        // extents split at 20.
        expect(sections(state).find((s) => s.id === a)?.length).toBe(20);
        expect(sections(state).find((s) => s.id === b)?.length).toBe(20);
    });

    test("splitForce preserves the head's authored profile exactly (plants the boundary keyframe)", () => {
        // `splitForce` moves points by `s`, but never planted a boundary keyframe at
        // the cut — the head was left holding its last remaining keyframe's value flat
        // to its new end, instead of continuing to curve toward the point that moved
        // to the tail. Sample the ORIGINAL authored profile (via `sampleForce`, not a
        // re-derivation of `splitForce`'s own point-partition arithmetic) across the
        // head's future extent [0, 20] before the split, then compare against the
        // head's own profile after — a cut mid-segment (s=20, strictly between the
        // keyframes at 10 and 30) must not change the curve on either side of it.
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        const a = createSection(state, 0, SectionKind.Force, 40);
        createForcePoint(state, a, 10, 1);
        createForcePoint(state, a, 30, 2);
        const original: ForcePoint[] = [
            { s: 10, g: 1 },
            { s: 30, g: 2 },
        ];

        const before: number[] = [];
        for (let s = 0; s <= 20; s += 2) before.push(sampleForce(original, s));

        const b = splitForce(state, a, 20);
        expect(b).not.toBeNull();
        if (b === null) return;

        const head = forcePoints(state, a);
        const after: number[] = [];
        for (let s = 0; s <= 20; s += 2) after.push(sampleForce(head, s));

        for (let i = 0; i < before.length; i++) expect(after[i]).toBeCloseTo(before[i], 5);
    });

    test("splitForce on a LANDMARK (s exactly on an existing keyframe) preserves the profile exactly and stays in the named-easing layer", () => {
        // the spec's primary Cut path: a cut invoked from a node/keyframe menu lands
        // exactly on that landmark. Distinct branch from the mid-segment one above —
        // no subdivision needed, so it must NOT demote to Custom (`profile.custom`):
        // the duplicated boundary keyframe on each side keeps deriving its tangent
        // from `ease`, same as before the cut.
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        const a = createSection(state, 0, SectionKind.Force, 40);
        createForcePoint(state, a, 10, 1);
        createForcePoint(state, a, 30, 2);
        const original: ForcePoint[] = [
            { s: 10, g: 1 },
            { s: 30, g: 2 },
        ];

        const b = splitForce(state, a, 10); // exactly on the s=10 keyframe
        expect(b).not.toBeNull();
        if (b === null) return;

        const head = forcePoints(state, a);
        const tail = forcePoints(state, b);
        for (let s = 0; s <= 10; s += 1)
            expect(sampleForce(head, s)).toBeCloseTo(sampleForce(original, s), 5);
        for (let s = 10; s <= 30; s += 2)
            expect(sampleForce(tail, s - 10)).toBeCloseTo(sampleForce(original, s), 5);

        // stays named — no explicit handles anywhere near the boundary, and the
        // (only) segment on each side reads as NOT Custom (`profile.custom`).
        expect(head.some((p) => p.in !== undefined || p.out !== undefined)).toBe(false);
        expect(tail.some((p) => p.in !== undefined || p.out !== undefined)).toBe(false);
        for (let i = 0; i + 1 < head.length; i++) expect(custom(head[i], head[i + 1])).toBe(false);
        for (let i = 0; i + 1 < tail.length; i++) expect(custom(tail[i], tail[i + 1])).toBe(false);
    });

    test("splitForce before the first keyframe holds the head flat and preserves the tail exactly", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        const a = createSection(state, 0, SectionKind.Force, 40);
        createForcePoint(state, a, 20, 1);
        createForcePoint(state, a, 30, 2);
        const original: ForcePoint[] = [
            { s: 20, g: 1 },
            { s: 30, g: 2 },
        ];

        const b = splitForce(state, a, 5); // strictly before the first keyframe (s=20)
        expect(b).not.toBeNull();
        if (b === null) return;

        const head = forcePoints(state, a);
        const tail = forcePoints(state, b);
        for (let s = 0; s <= 5; s += 1)
            expect(sampleForce(head, s)).toBeCloseTo(sampleForce(original, s), 5);
        for (let s = 5; s <= 40; s += 2)
            expect(sampleForce(tail, s - 5)).toBeCloseTo(sampleForce(original, s), 5);
    });

    test("splitForce past the last keyframe preserves the head exactly and holds the tail flat", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        const a = createSection(state, 0, SectionKind.Force, 40);
        createForcePoint(state, a, 10, 1);
        createForcePoint(state, a, 20, 2);
        const original: ForcePoint[] = [
            { s: 10, g: 1 },
            { s: 20, g: 2 },
        ];

        const b = splitForce(state, a, 30); // strictly after the last keyframe (s=20)
        expect(b).not.toBeNull();
        if (b === null) return;

        const head = forcePoints(state, a);
        const tail = forcePoints(state, b);
        for (let s = 0; s <= 30; s += 2)
            expect(sampleForce(head, s)).toBeCloseTo(sampleForce(original, s), 5);
        for (let s = 30; s <= 40; s += 2)
            expect(sampleForce(tail, s - 30)).toBeCloseTo(sampleForce(original, s), 5);
    });

    test("splitForce on a section with ZERO keyframes is a no-op profile on both halves (flat DEFAULT_G)", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        const a = createSection(state, 0, SectionKind.Force, 40);

        const b = splitForce(state, a, 15);
        expect(b).not.toBeNull();
        if (b === null) return;

        expect(sectionForces(state, a)).toEqual([]);
        expect(sectionForces(state, b)).toEqual([]);
        for (let s = 0; s <= 15; s += 3)
            expect(sampleForce(forcePoints(state, a), s)).toBe(DEFAULT_G);
        for (let s = 0; s <= 25; s += 3)
            expect(sampleForce(forcePoints(state, b), s)).toBe(DEFAULT_G);
    });

    test("splitForce on a section with ONE keyframe preserves the profile exactly, cutting before it", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        const a = createSection(state, 0, SectionKind.Force, 40);
        createForcePoint(state, a, 15, 2.5);
        const original: ForcePoint[] = [{ s: 15, g: 2.5 }];

        const b = splitForce(state, a, 5); // before the single keyframe
        expect(b).not.toBeNull();
        if (b === null) return;

        const head = forcePoints(state, a);
        const tail = forcePoints(state, b);
        for (let s = 0; s <= 5; s += 1)
            expect(sampleForce(head, s)).toBeCloseTo(sampleForce(original, s), 5);
        for (let s = 5; s <= 40; s += 2)
            expect(sampleForce(tail, s - 5)).toBeCloseTo(sampleForce(original, s), 5);
    });

    test("splitForce on a section with ONE keyframe preserves the profile exactly, cutting after it", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        const a = createSection(state, 0, SectionKind.Force, 40);
        createForcePoint(state, a, 15, 2.5);
        const original: ForcePoint[] = [{ s: 15, g: 2.5 }];

        const b = splitForce(state, a, 25); // after the single keyframe
        expect(b).not.toBeNull();
        if (b === null) return;

        const head = forcePoints(state, a);
        const tail = forcePoints(state, b);
        for (let s = 0; s <= 25; s += 2)
            expect(sampleForce(head, s)).toBeCloseTo(sampleForce(original, s), 5);
        for (let s = 25; s <= 40; s += 2)
            expect(sampleForce(tail, s - 25)).toBeCloseTo(sampleForce(original, s), 5);
    });

    test("splitting a force section in a Time-domain track is a lossless partition in the store's unit (seconds)", () => {
        // splitForce partitions whatever unit `Track.domain` holds — the docstrings
        // used to say "arclength s", which is false once the store is seconds. This pins
        // the split as a lossless partition in the store's own unit, the domain the
        // timeline's s-axis actually authors in when the track is Time
        // (`kex2d/AGENTS.md` Two coordinate frames).
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        setTrackDomain(state, Domain.Time);
        const a = createSection(state, 0, SectionKind.Force, 40);
        createForcePoint(state, a, 10, 1);
        createForcePoint(state, a, 30, 2);
        const before = forcePoints(state, a);

        const b = splitForce(state, a, 20);
        expect(b).not.toBeNull();
        if (b === null) return;

        // keyframe positions re-home exactly: the s=10 point stays in A, the s=30 point
        // moves to B rebased to 10 — in seconds, same as the arclength case — plus the
        // boundary keyframe the exactness fix plants at the cut in each half.
        expect(sectionForces(state, a).map((p) => p.s)).toEqual([10, 20]);
        expect(sectionForces(state, b).map((p) => p.s)).toEqual([0, 10]);
        // extents split at 20 (seconds).
        expect(sections(state).find((s) => s.id === a)?.length).toBe(20);
        expect(sections(state).find((s) => s.id === b)?.length).toBe(20);

        // the exactness oracle: the head's sampled profile over [0, 20] is unchanged
        // by the cut (the boundary key continues the original curve, not a flat hold).
        for (let s = 0; s <= 20; s += 2)
            expect(sampleForce(forcePoints(state, a), s)).toBeCloseTo(sampleForce(before, s), 5);
    });

    // C3: Cut is lossless for a velocity strip — the pre-op v² samples across the WHOLE
    // extent (natural march AND the strip-covered edges) reproduce across both post-cut
    // halves. The cut lands exactly on the nominal grid (a multiple of `DS_NOMINAL`), so
    // both halves resolve their own `resolveStep` with no rounding residue and every
    // sample lines up index-for-index with the pre-cut bake (`profile.resolveStep`'s own
    // fixed-point law) — the same shape the force-profile exactness oracle above uses,
    // read off `bakeOut.v` instead of the sampled g profile.
    test("Cut is lossless for a velocity strip: pre-cut v samples across the whole extent reproduce across both post-cut halves, and the strip's own row is byte-identical (Locked decision: split never touches strips)", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        const trackEid = createTrack(state);
        const a = createSection(state, 0, SectionKind.Force, 20);
        // a non-flat profile — F_n = 1.3g curves the path, so v naturally VARIES outside the
        // strip; a broken split would either lose that variation or the strip's own hold.
        createForcePoint(state, a, 0, 1.3);
        createForcePoint(state, a, 20, 1.3);
        // the strip straddles the cut point at global station 10 — a track-global strip,
        // segment-independent (Locked decision), so the split never touches it.
        const stripId = createStrip(state, 5, 15, 6);
        expect(stripId).not.toBeNull();
        if (stripId === null) return;
        state.step(0);

        const rowBefore = allStrips(state).find((s) => s.id === stripId);
        if (!rowBefore) throw new Error("strip missing before split");

        const infoBefore = sectionInfo.get(a);
        if (!infoBefore) throw new Error("no pre-cut bake");
        const outBefore = bakeOut.get(trackEid);
        if (!outBefore) throw new Error("no pre-cut bakeOut");
        const preV = Array.from(
            { length: infoBefore.endSample - infoBefore.startSample + 1 },
            (_, i) => outBefore.v[infoBefore.startSample + i],
        );

        const b = splitForce(state, a, 10); // on the DS_NOMINAL grid — no rounding residue
        expect(b).not.toBeNull();
        if (b === null) return;
        state.step(0);

        // split is span-blind (S2 Locked decision): the strip's row survives untouched,
        // still addressed by its own stable id — no head/tail division.
        const rowAfter = allStrips(state).find((s) => s.id === stripId);
        expect(rowAfter).toEqual(rowBefore);

        const infoHead = sectionInfo.get(a);
        const infoTail = sectionInfo.get(b);
        if (!infoHead || !infoTail) throw new Error("no post-cut bake");
        const outAfter = bakeOut.get(trackEid);
        if (!outAfter) throw new Error("no post-cut bakeOut");

        const headCount = infoHead.endSample - infoHead.startSample; // exactly 20 edges (10 m / DS_NOMINAL)
        expect(headCount).toBe(Math.round(10 / DS_NOMINAL));
        for (let i = 0; i <= headCount; i++) {
            expect(outAfter.v[infoHead.startSample + i]).toBeCloseTo(preV[i], 4);
        }
        // the tail marches FRESH from head's own recovered exit (`evalForce` re-recovers v
        // at the boundary, then the tail sums its OWN Σloss from there) rather than continuing
        // the pre-cut chain's single unbroken Σ — floating-point summation is non-associative,
        // so the two independent marches agree to a re-entry tolerance, not bit-for-bit (the
        // same "two independent marches of one authored ride" shape `domain.ts`'s single-flip
        // bound documents for the analogous re-entry at a domain conversion). The disagreement
        // GROWS across the tail's own edges (a genuine forward-accumulating divergence, not a
        // fixed re-entry offset): measured ~0.012% at the boundary sample, ~0.2% by the far
        // end. Bounded relative (1%), comfortably above the measured growth yet far tighter
        // than a vacuous check — a genuinely broken split (dropped strip, wrong rebase) misses
        // by orders of magnitude more than this.
        const tailCount = infoTail.endSample - infoTail.startSample;
        for (let i = 0; i <= tailCount; i++) {
            const want = preV[headCount + i];
            const got = outAfter.v[infoTail.startSample + i];
            expect(Math.abs(got - want)).toBeLessThan(1e-2 * Math.max(1, Math.abs(want)));
        }
    });

    // C3 review, finding 2 (superseded by S2's track-global migration): `splitGeo`
    // (reached by `splitGeoAt`) once needed its own strip-splitting loop because strips
    // were section-owned; S2 deletes strip section-ownership entirely, so a geo split
    // is span-blind by construction now (Locked decision) — the row below asserts that
    // directly rather than a head/tail division.
    test("Cut is lossless for a velocity strip on a geo section: the tail half holds its value under friction, not decays, and the strip's own row is byte-identical (Locked decision: split never touches strips)", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        const a = createSection(state, 0, SectionKind.Geo, 0);
        addNode(state, a, 0, 0);
        addNode(state, a, 24, 0); // flat, straight, 24 m
        setTrackFriction(eid, 0.05);
        const stripId = createStrip(state, 8, 16, 5);
        expect(stripId).not.toBeNull();
        if (stripId === null) return;
        state.step(0);

        const rowBefore = allStrips(state).find((s) => s.id === stripId);
        if (!rowBefore) throw new Error("strip missing before split");

        const infoBefore = sectionInfo.get(a);
        if (!infoBefore) throw new Error("no pre-cut bake");
        const outBefore = bakeOut.get(eid);
        if (!outBefore) throw new Error("no pre-cut bakeOut");
        const preV = Array.from(
            { length: infoBefore.endSample - infoBefore.startSample + 1 },
            (_, i) => outBefore.v[infoBefore.startSample + i],
        );

        // segment 0 (the section's only segment) at t=0.5: a symmetric straight-line cubic
        // lands its midpoint parameter at the exact spatial/arclength midpoint (12), inside
        // the strip [8, 16) — straddling it, the case a boundary-aligned strip can't exercise.
        const b = splitGeoAt(state, a, 0, 0.5);
        expect(b).not.toBeNull();
        if (b === null) return;
        state.step(0);

        // split is span-blind (S2 Locked decision): the strip's row survives untouched,
        // still addressed by its own stable id — no head/tail division.
        const rowAfter = allStrips(state).find((s) => s.id === stripId);
        expect(rowAfter).toEqual(rowBefore);

        const infoHead = sectionInfo.get(a);
        const infoTail = sectionInfo.get(b);
        if (!infoHead || !infoTail) throw new Error("no post-cut bake");
        const outAfter = bakeOut.get(eid);
        if (!outAfter) throw new Error("no post-cut bakeOut");

        const headCount = infoHead.endSample - infoHead.startSample;
        for (let i = 0; i <= headCount; i++) {
            expect(outAfter.v[infoHead.startSample + i]).toBeCloseTo(preV[i], 3);
        }
        const tailCount = infoTail.endSample - infoTail.startSample;
        for (let i = 0; i <= tailCount; i++) {
            expect(outAfter.v[infoTail.startSample + i]).toBeCloseTo(preV[headCount + i], 3);
        }
    });
});

// `splitGeoAt` — the free-position geo cut (`spline.subdivide` + `insertGeoNode` +
// `splitGeo`). The landmark cases (t at 0 or 1) reduce to today's `splitGeo`
// unchanged; the interior case is the world-curve pin, `headExit`'s telescoping
// argument extended from a node boundary to an arbitrary mid-segment one.
describe("splitGeoAt — geo cut at arbitrary t", () => {
    /** four Auto nodes with real curvature — the same fixture the landmark split
     *  tests use, so a mid-segment cut is measured against a known-good baseline. */
    function fourNode(): { state: State; eid: number; a: number } {
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        const a = createSection(state, 0, SectionKind.Geo, 0);
        for (const [x, y] of [
            [0, 0],
            [20, 4],
            [40, 4],
            [60, 0],
        ])
            addNode(state, a, x, y);
        return { state, eid, a };
    }

    test("t = 0 reduces to today's splitGeo unchanged — no node inserted, the boundary stays Auto", () => {
        const { state, a } = fourNode();
        const beforeModes = sectionHandles(state, a).map((e) => Handle.tmode.get(e));

        const b = splitGeoAt(state, a, 2, 0); // segment 2's start IS node 2 — the landmark
        expect(b).not.toBeNull();
        if (b === null) return;

        // no midpoint inserted: the head keeps exactly 3 nodes (orders 0..2), the tail 2
        // (orders 0..1) — the same partition a bare `splitGeo(state, a, 2)` produces.
        expect(sectionHandles(state, a).length).toBe(3);
        expect(sectionHandles(state, b).length).toBe(2);
        // the boundary node's tangent mode is untouched (still Auto) — a landmark cut
        // never demotes anything.
        expect(Handle.tmode.get(sectionHandles(state, a)[2])).toBe(beforeModes[2]);
    });

    test("t = 1 of the LAST segment reduces to today's splitGeo unchanged (its own no-op at the tip)", () => {
        const { state, a } = fourNode();
        // segment j=2 runs node 2 → node 3 (the tip); t=1 lands exactly on the tip, where
        // `splitGeo` already refuses (nothing downstream of the last node to cut off).
        expect(splitGeoAt(state, a, 2, 1)).toBeNull();
        expect(sections(state).length).toBe(1);
        expect(sectionHandles(state, a).length).toBe(4); // untouched
    });

    test("the cut's baked world curve reproduces the PRE-CUT bake across the WHOLE extent, both halves — not just the tail's own entry", () => {
        // the boundary-only pin this replaces (`info.entry` against a `subdivide`-built
        // expectation) covers nothing past the split: mutation-proven, swapping
        // `insertGeoNode`'s write of `pb`'s tangent (`inX: sub.inB[1], inY: sub.inB[0]`,
        // corrupting the mid→pb segment) passed every test in this file. Building the
        // expectation from `subdivide` is ALSO invalid on its own — mutation-proven,
        // perturbing `subdivide`'s own midpoint (`mx/my += 5`) passed too, because both
        // sides of that pin called the same production function. This pin bakes the
        // PRE-cut curve first (touching neither `subdivide` nor `insertGeoNode`), cuts,
        // then samples both post-cut halves' ACTUAL baked world curve at matching
        // arclengths across the full original extent — the independent truth the locked
        // decision names.
        const { state, eid, a } = fourNode();
        state.step(0);
        const pre = worldSamples(eid);
        const preArc = cumulativeArc(pre);
        const total = preArc[preArc.length - 1];
        const kappa = maxCurvature(pre);
        const ds = trackDs(state);

        const b = splitGeoAt(state, a, 1, 0.35);
        expect(b).not.toBeNull();
        if (b === null) return;
        state.step(0);
        const post = worldSamples(eid);
        const postArc = cumulativeArc(post);

        // `subdivide` reproduces the identical analytic curve exactly (proven in
        // `spline.test.ts`), so the only disagreement between the pre- and post-cut
        // POLYLINES at a shared target arclength is chord-interpolation error: each side
        // independently re-quantizes its segment's edge count (`sampleChain`'s own
        // `round(length/ds)`, `spline.ts:432`), so the discrete samples bracketing a given
        // station don't land at the same parameter on each side. That error is a sagitta,
        // at most ds²·κ/8 per side (standard chord-vs-arc bound at curvature κ over a
        // step ≤ ds) — ds²·κ/4 total for the two independent reconstructions — plus the
        // rigid re-frame's own f32 round-off floor (0.05 m), the SAME derived floor the
        // sibling node-boundary split pin above carries ("splitting at a node with an
        // explicit tangent keeps the baked world curve").
        const tol = 0.05 + (ds * ds * kappa) / 4;

        for (let f = 0.05; f < 1; f += 0.1) {
            const s = f * total;
            const p = atArc(pre, preArc, s);
            const q = atArc(post, postArc, s);
            expect(Math.hypot(q.x - p.x, q.y - p.y)).toBeLessThan(tol);
        }
    });

    test("cutting mid-segment preserves the FAR side of each boundary node (only the facing side re-parents)", () => {
        const { state, a } = fourNode();
        const before1 = seedTangent(state, a, 1, TangentMode.Free); // node 1's live Auto vectors
        const before2 = seedTangent(state, a, 2, TangentMode.Free); // node 2's live Auto vectors
        if (!before1 || !before2) throw new Error("seedTangent failed");

        insertGeoNode(state, a, 1, 0.35);

        // node 1 (order 1, unmoved): its `in` (arriving from node 0) is untouched by a
        // split of ITS OWN segment — only `out` (facing the new mid node) re-parents.
        // precision 5, not 6: `before1` is the raw f64 computation, `after1` reads back
        // through the ECS's f32 `Handle.tin` column — one f32 quantization at magnitude
        // ~19 (~2e-6), which `toBeCloseTo(…, 6)` (5e-7) is tighter than.
        const after1 = handleTangent(state, a, 1);
        expect(after1?.inX).toBeCloseTo(before1.inX, 5);
        expect(after1?.inY).toBeCloseTo(before1.inY, 5);

        // node 2 shifted to order 3 (the mid node took order 2): its `out` (departing
        // to node 3) is untouched — only `in` (facing the new mid node) re-parents.
        const after2 = handleTangent(state, a, 3);
        expect(after2?.outX).toBeCloseTo(before2.outX, 5);
        expect(after2?.outY).toBeCloseTo(before2.outY, 5);
    });
});

// `geoCutAt`/`sectionCutAt` — the free-position Cut's cursor resolution (`track.ts`). Zero unit
// coverage existed before this suite (kex2d-structural-editing stage 6 review): the capture
// flows only assert `sectionCount`/`sectionKinds`/`undoDepth`, which a wrong-but-still-interior
// resolution satisfies just as well as a correct one.
describe("geoCutAt — the geo-side bracket walk + interior refusal", () => {
    /** four Auto nodes with real curvature (3 segments) — `splitGeoAt`'s own fixture, so the
     *  bracket boundaries are known-good from that suite. */
    function fourNode(): { state: State; eid: number; a: number } {
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        const a = createSection(state, 0, SectionKind.Geo, 0);
        for (const [x, y] of [
            [0, 0],
            [20, 4],
            [40, 4],
            [60, 0],
        ])
            addNode(state, a, x, y);
        state.step(0);
        return { state, eid, a };
    }

    /** the node arclengths ground truth, independent of `geoCutAt`'s own walk: the baked
     *  polyline's cumulative chord sum, indexed at each node's landing sample — the SAME per-edge
     *  `out.ds` values `geoCutAt` reads, but read here through `worldSamples`, not `bakeOut`
     *  directly, so a corrupted bracket-index arithmetic in `geoCutAt` can't also corrupt the
     *  expectation (`coding.md`'s "a check that re-derives the rule it checks" — the two paths
     *  share only the bake's OWN geometry, never `geoCutAt`'s bookkeeping). */
    function nodeArcs(state: State, eid: number, a: number): number[] {
        const pts = worldSamples(eid);
        const arc = cumulativeArc(pts);
        return sectionHandles(state, a).map((h) => arc[Handle.sample.get(h)]);
    }

    test("a point in the FIRST segment resolves to bracket 0", () => {
        const { state, eid, a } = fourNode();
        const arcs = nodeArcs(state, eid, a);
        const mid = (arcs[0] + arcs[1]) / 2;
        const r = geoCutAt(state, a, mid);
        expect(r).not.toBeNull();
        expect(r?.at).toBe(0);
        expect(r?.t).toBeGreaterThan(0);
        expect(r?.t).toBeLessThan(1);
    });

    test("a point in an INTERIOR segment resolves to its own bracket (the multi-segment walk)", () => {
        const { state, eid, a } = fourNode();
        const arcs = nodeArcs(state, eid, a);
        const mid = (arcs[1] + arcs[2]) / 2;
        const r = geoCutAt(state, a, mid);
        expect(r).not.toBeNull();
        expect(r?.at).toBe(1);
    });

    test("a point in the LAST segment resolves to the final bracket", () => {
        const { state, eid, a } = fourNode();
        const arcs = nodeArcs(state, eid, a);
        const mid = (arcs[2] + arcs[3]) / 2;
        const r = geoCutAt(state, a, mid);
        expect(r).not.toBeNull();
        expect(r?.at).toBe(2);
    });

    test("t increases monotonically with s within one bracket", () => {
        const { state, eid, a } = fourNode();
        const arcs = nodeArcs(state, eid, a);
        const lo = arcs[1] + 0.05 * (arcs[2] - arcs[1]);
        const hi = arcs[1] + 0.95 * (arcs[2] - arcs[1]);
        const rLo = geoCutAt(state, a, lo);
        const rHi = geoCutAt(state, a, hi);
        expect(rLo?.at).toBe(1);
        expect(rHi?.at).toBe(1);
        expect(rHi?.t ?? 0).toBeGreaterThan(rLo?.t ?? 1);
    });

    // the two refusal boundaries `nodeCuttable`'s own interior bound owes (`editor-ui.md`'s
    // grays-never-hides law reads this same predicate at the row): a resolution AT or before node
    // 0, and AT or past the chain's last node, are both never a split point.
    test("resolves to node 0 (at or before its arclength) refuses — never a split point", () => {
        const { state, a } = fourNode();
        expect(geoCutAt(state, a, 0)).toBeNull();
        expect(geoCutAt(state, a, -5)).toBeNull();
    });

    test("resolves to the chain's last node (at or past its arclength) refuses", () => {
        const { state, eid, a } = fourNode();
        const arcs = nodeArcs(state, eid, a);
        const total = arcs[arcs.length - 1];
        expect(geoCutAt(state, a, total)).toBeNull();
        expect(geoCutAt(state, a, total + 5)).toBeNull();
    });

    test("null off a force section, an unset bake, or a <2-node chain", () => {
        const geoOnly = fourNode();
        const b = createSection(geoOnly.state, 1, SectionKind.Force, 40);
        expect(geoCutAt(geoOnly.state, b, 10)).toBeNull(); // wrong kind

        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        const empty = createSection(state, 0, SectionKind.Geo, 0);
        addNode(state, empty, 0, 0); // one node only — never bakes
        state.step(0);
        expect(geoCutAt(state, empty, 5)).toBeNull(); // <2-node chain

        const noBakeState = new State();
        const noBakeEid = createTrack(noBakeState);
        const noBakeSec = createSection(noBakeState, 0, SectionKind.Geo, 0);
        addNode(noBakeState, noBakeSec, 0, 0);
        addNode(noBakeState, noBakeSec, EXTEND_DIST, 0);
        void noBakeEid;
        expect(geoCutAt(noBakeState, noBakeSec, 5)).toBeNull(); // no BakeSystem — unset bake
    });

    // the click-landing exactness pin (kex2d-structural-editing stage 6 review): the returned `t`
    // must reproduce the point the author actually clicked, not a nearby one. `t` is resolved by
    // walking the bake's own sub-edge arclength table (`out.ds` between consecutive SAMPLES, the
    // exact discretization `sampleAt` used to draw the curve), never a linear guess across the
    // whole node-to-node bracket — a linear guess is exact only at constant curve speed, and a
    // real bend's speed varies with the local tangent length. Oracle shape: pick a point EXACTLY
    // at a baked sample (the pixel the author visually clicked, since the render IS this
    // polyline), resolve it through `geoCutAt`, then feed the returned `(at, t)` to `subdivide` —
    // an independently-tested function this pin doesn't touch — and compare ITS landing to the
    // true clicked point. That closes the loop end to end without re-deriving `geoCutAt`'s own
    // bracket arithmetic (`coding.md`'s "a check that re-derives the rule it checks").
    test("the resolved t lands `subdivide` back at the exact point the author clicked, on a high-curvature single segment", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        const a = createSection(state, 0, SectionKind.Geo, 0);
        addNode(state, a, 0, 0);
        addNode(state, a, 10, 0);
        state.step(0);
        const handles = sectionHandles(state, a);
        // explicit tangents pointing sharply apart — a single segment with real bend, the class
        // of curve the linear guess gets furthest wrong (measured below: the app's documented
        // curvature range, not a contrived extreme).
        setTangent(state, a, 0, { mode: TangentMode.Free, inX: 0, inY: 0, outX: 5, outY: 8 });
        setTangent(state, a, 1, { mode: TangentMode.Free, inX: -8, inY: 5, outX: 0, outY: 0 });
        state.step(0);

        const out = bakeOut.get(eid);
        const s = samples.get(eid);
        if (!out || !s) throw new Error("no bake");
        const count = Track.count.get(eid);
        const mid = Math.floor(count / 2);
        let sTrue = 0;
        for (let i = 0; i < mid; i++) sTrue += out.ds[i];
        const trueX = s.posX[mid];
        const trueY = s.posY[mid];

        const r = geoCutAt(state, a, sTrue);
        expect(r).not.toBeNull();
        if (r === null) return;

        const ta = handleTangent(state, a, 0);
        const tb = handleTangent(state, a, 1);
        const pa = {
            x: Handle.pos.x.get(handles[0]),
            y: Handle.pos.y.get(handles[0]),
            theta: Handle.theta.get(handles[0]),
            tangent: ta,
        };
        const pb = {
            x: Handle.pos.x.get(handles[1]),
            y: Handle.pos.y.get(handles[1]),
            theta: Handle.theta.get(handles[1]),
            tangent: tb,
        };
        const landed = subdivide(pa, pb, r.t);
        const err = Math.hypot(landed.x - trueX, landed.y - trueY);
        // measured: ~2e-8 m (f32-storage-roundoff floor: `Handle.pos` is f32, hermite evaluated
        // in f64 from it, magnitude ~10 → ulp ~6e-7). 1e-4 clears that floor with wide margin
        // while sitting three-and-a-half orders below the linear guess's own error on this exact
        // fixture (measured ~1.72 m, 15% of the ~11.35 m segment — the mutant this pin catches).
        expect(err).toBeLessThan(1e-4);
    });
});

describe("sectionCutAt — the kind-fitted geo/force dispatch", () => {
    function geoFixture(): { state: State; eid: number; a: number } {
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        const a = createSection(state, 0, SectionKind.Geo, 0);
        for (const [x, y] of [
            [0, 0],
            [20, 4],
            [40, 4],
            [60, 0],
        ])
            addNode(state, a, x, y);
        state.step(0);
        return { state, eid, a };
    }

    function forceFixture(domain: Domain = Domain.Distance): {
        state: State;
        eid: number;
        a: number;
    } {
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        if (domain === Domain.Time) setTrackDomain(state, Domain.Time);
        const a = createSection(state, 0, SectionKind.Force, 40);
        createForcePoint(state, a, 10, 1);
        createForcePoint(state, a, 30, 2);
        state.step(0);
        return { state, eid, a };
    }

    test("geo branch reduces to `geoCutAt` off the arc reading `d`, ignoring `u`", () => {
        const { state, eid, a } = geoFixture();
        const spans = sectionSpans(state, eid);
        const arcs = worldSamples(eid);
        const arc = cumulativeArc(arcs);
        const total = arc[arc.length - 1];
        const d = total * 0.4;
        // `u` is deliberately garbage — the geo branch must never read it.
        const r = sectionCutAt(state, a, spans, d, -999999);
        expect(r).toEqual(geoCutAt(state, a, d));
        expect(r).not.toBeNull();
    });

    test("geo branch returns null when `d` resolves outside the target section", () => {
        const { state, eid, a } = geoFixture();
        const b = appendSection(state, SectionKind.Geo);
        addNode(state, b, 200, 0);
        state.step(0);
        const spans = sectionSpans(state, eid);
        // a `d` deep into section b's span, queried against `a`.
        const bSpan = spans.find((s) => s.id === b);
        if (!bSpan) throw new Error("no span for b");
        expect(sectionCutAt(state, a, spans, bSpan.offset + 1, 0)).toBeNull();
    });

    test("force branch resolves the native `s` directly (`toLocal` alone, no subdivision param)", () => {
        const { state, eid, a } = forceFixture();
        const spans = sectionSpans(state, eid);
        // the force branch reads `u`, not `d` — feed a garbage `d` to prove it's never read.
        const r = sectionCutAt(state, a, spans, -999999, 15);
        expect(r).toEqual({ at: 15 }); // no `t` — splitForce is exact at any interior s already
    });

    test("force branch is domain-dependent: `u` reads whichever native axis `Track.domain` holds", () => {
        // the SAME authored section (points at s=10, s=30 of a length-40 extent), built once in
        // Distance and once in Time — `u` names a different physical quantity (meters vs seconds)
        // in each, and the branch must read whichever one `Track.domain` currently holds rather
        // than always resolving arclength.
        const dist = forceFixture(Domain.Distance);
        const distSpans = sectionSpans(dist.state, dist.eid);
        expect(sectionCutAt(dist.state, dist.a, distSpans, 0, 15)).toEqual({ at: 15 });

        const time = forceFixture(Domain.Time);
        const timeSpans = sectionSpans(time.state, time.eid);
        // same `u = 15`, but now interpreted as seconds of section-local march time — the
        // section-local force store already holds `s` in seconds (`createForcePoint(a, 10, 1)`
        // means "10 seconds in"), so the resolution is still a direct pass-through, just of a
        // different unit than the Distance case above.
        expect(sectionCutAt(time.state, time.a, timeSpans, 0, 15)).toEqual({ at: 15 });
    });

    test("force branch returns null when `u` resolves outside the target section", () => {
        const { state, eid, a } = forceFixture();
        const b = appendSection(state, SectionKind.Force);
        createForcePoint(state, b, 10, 1);
        state.step(0);
        const spans = sectionSpans(state, eid);
        const bSpan = spans.find((s) => s.id === b);
        if (!bSpan) throw new Error("no span for b");
        expect(sectionCutAt(state, a, spans, 0, bSpan.offset + 1)).toBeNull();
    });
});

describe("upstream edits carry downstream rigidly", () => {
    test("moving a lead-in node leaves the downstream section's local shape untouched", () => {
        const { state, eid, a, b } = twoGeo();
        // capture B's local nodes and its baked world samples before the upstream edit.
        const bLocalBefore = sectionHandles(state, b).map((e) => ({
            x: Handle.pos.x.get(e),
            y: Handle.pos.y.get(e),
            theta: Handle.theta.get(e),
        }));
        const bInfoBefore = sectionInfo.get(b);
        if (!bInfoBefore) throw new Error("section b info missing");
        const s = samples.get(eid);
        if (!s) throw new Error("samples missing");
        const bWorldBefore = {
            x: s.posX[bInfoBefore.startSample],
            y: s.posY[bInfoBefore.startSample],
        };

        // edit the lead-in: raise its tip further, changing section A's exit.
        const tip = sectionHandles(state, a)[1];
        Handle.pos.set(tip, EXTEND_DIST, 24);
        reheadOnDrag(state, tip);
        state.step(0);

        // B's LOCAL nodes are untouched — the shape is preserved exactly.
        const bLocalAfter = sectionHandles(state, b).map((e) => ({
            x: Handle.pos.x.get(e),
            y: Handle.pos.y.get(e),
            theta: Handle.theta.get(e),
        }));
        expect(bLocalAfter).toEqual(bLocalBefore);
        // but B moved in the WORLD — the upstream exit (its entry) shifted, so the
        // whole downstream shape translated+rotated rigidly with it.
        const bInfoAfter = sectionInfo.get(b);
        if (!bInfoAfter) throw new Error("section b info missing");
        const bWorldAfter = {
            x: s.posX[bInfoAfter.startSample],
            y: s.posY[bInfoAfter.startSample],
        };
        expect(
            Math.hypot(bWorldAfter.x - bWorldBefore.x, bWorldAfter.y - bWorldBefore.y),
        ).toBeGreaterThan(1);
        // still C0 at the boundary after the edit.
        expect(bInfoAfter.entry.y).toBeCloseTo(bWorldAfter.y, 5);
    });
});

describe("delete", () => {
    test("deleting a section closes the chain; the last section can't be deleted", () => {
        const { state, a, b } = twoGeo();
        expect(deleteSection(state, a)).toBe(true);
        expect(sections(state).map((s) => s.id)).toEqual([b]);
        expect(sections(state)[0].order).toBe(0); // downstream closed the gap
        expect(deleteSection(state, b)).toBe(false); // the last one stays
    });

    test("the surviving section rebases to START after deleting the lead-in", () => {
        const { state, eid, a, b } = twoGeo();
        deleteSection(state, a);
        state.step(0);
        const info = sectionInfo.get(b);
        if (!info) throw new Error("section b info missing");
        // b is now first — its entry is START (the origin), so it bakes from there.
        expect(info.entry.x).toBeCloseTo(0, 5);
        expect(info.entry.y).toBeCloseTo(0, 5);
        const s = samples.get(eid);
        if (!s) throw new Error("samples missing");
        expect(s.posX[0]).toBeCloseTo(0, 4);
    });

    test("trimming a downstream section's tip keeps the authored tangent in the rotated frame", () => {
        // the boundary case: section B sits at A's climbing exit (entry.theta ≠ 0). author a
        // tangent on an interior node of B, then trim B's tail. the promoted tip keeps its
        // authored tangent whole (a neighbor's delete is not the tip's own move) and its exit
        // heading is the authored out-vector rotated through the entry frame.
        const { state, b } = twoGeo();
        addNode(state, b, 20, 5); // B now has nodes 0,1,2 (section-local)
        state.step(0);
        const seed = seedTangent(state, b, 1, TangentMode.Aligned);
        if (!seed) throw new Error("seed");
        setTangent(state, b, 1, editTangent(seed, "out", 8, 8));
        state.step(0);
        const authored = handleTangent(state, b, 1);
        if (!authored) throw new Error("tangent");

        expect(removeTrailingHandle(state, b)).toBe(true); // trim B's tail → node 1 is B's tip
        state.step(0);

        const h = sectionHandles(state, b);
        const tip = h[h.length - 1];
        expect(handleTangent(state, b, Handle.order.get(tip))).toEqual(authored); // preserved
        const info = sectionInfo.get(b);
        if (!info) throw new Error("section b info missing");
        // the readout reports the authored out-vector rotated into world by the entry frame.
        const localExit = Math.atan2(authored.outY, authored.outX);
        expect(exitWorld(tip)).toBeCloseTo(localExit + info.entry.theta, 10);
    });

    test("trimming the upstream section leaves the stitched boundary pair's authored state whole", () => {
        // the geo→geo boundary is two coincident entities: A's tip + B's node 0 (the
        // rigid-placement invariant). deleting A's trailing node moves B's entry frame,
        // never B's section-local authored state: B's node-0 tangent survives
        // byte-identical (it rides the frame rigidly), the promoted A node keeps its
        // own authored tangent, and B's entry re-derives to the new tip's exit.
        const { state, eid, a, b } = twoGeo();
        addNode(state, a, 30, 14); // A now has nodes 0,1,2 — node 1 is the old boundary-adjacent interior
        state.step(0);
        // author A's interior node 1 (promoted by the trim) and B's node-0 out-handle (the stitch).
        const sa = seedTangent(state, a, 1, TangentMode.Free);
        const sb = seedTangent(state, b, 0, TangentMode.Free);
        if (!sa || !sb) throw new Error("seed");
        setTangent(state, a, 1, editTangent(sa, "out", 6, 7));
        setTangent(state, b, 0, editTangent(sb, "out", 9, 3));
        state.step(0);
        const aAuthored = handleTangent(state, a, 1);
        const bAuthored = handleTangent(state, b, 0);
        if (!aAuthored || !bAuthored) throw new Error("tangent");

        expect(removeTrailingHandle(state, a)).toBe(true); // delete A's boundary tip → node 1 promoted
        state.step(0);

        expect(handleTangent(state, a, 1)).toEqual(aAuthored); // promoted tip whole
        expect(handleTangent(state, b, 0)).toEqual(bAuthored); // stitch half untouched
        const newTip = sectionHandles(state, a)[sectionHandles(state, a).length - 1];
        expect(stitchNode(state, newTip)).toBe(handleAt(state, b, 0)); // still the boundary pair
        const infoA = sectionInfo.get(a);
        const infoB = sectionInfo.get(b);
        if (!infoA || !infoB) throw new Error("section info missing");
        // the rigid re-place: B's entry is A's recovered exit (the substrate's entry-propagation
        // contract, a bake-derived state — deliberately NOT the authored heading verbatim), and
        // the boundary stays one shared sample: B's node 0 rides the frame to A's new tip.
        expect(infoB.startSample).toBe(infoA.endSample);
        const s = samples.get(eid);
        if (!s) throw new Error("samples missing");
        expect(infoB.entry.x).toBeCloseTo(s.posX[infoB.startSample], 4);
        expect(infoB.entry.y).toBeCloseTo(s.posY[infoB.startSample], 4);
    });
});

describe("undo (byte-identical)", () => {
    test("append → undo restores the single-section chain byte-identical", () => {
        const { state, a, b } = twoGeo();
        void b;
        const h = createHistory();
        const before = sections(state).map((s) => s.id);

        const f = appendCmd(h, state, SectionKind.Force);
        expect(sections(state).length).toBe(3);
        void f;

        undo(h, state);
        expect(sections(state).map((s) => s.id)).toEqual(before);
        expect(sections(state)[0].id).toBe(a);
    });

    test("split → undo restores the node payload byte-identical", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        const a = createSection(state, 0, SectionKind.Geo, 0);
        for (const [x, y] of [
            [0, 0],
            [20, 4],
            [40, 4],
            [60, 0],
        ])
            addNode(state, a, x, y);
        const before = sectionHandles(state, a).map((e) => ({
            order: Handle.order.get(e),
            x: Handle.pos.x.get(e),
            y: Handle.pos.y.get(e),
            theta: Handle.theta.get(e),
        }));
        const h = createHistory();

        splitCmd(h, state, a, 2);
        expect(sections(state).length).toBe(2);

        undo(h, state);
        expect(sections(state).length).toBe(1);
        const after = sectionHandles(state, a).map((e) => ({
            order: Handle.order.get(e),
            x: Handle.pos.x.get(e),
            y: Handle.pos.y.get(e),
            theta: Handle.theta.get(e),
        }));
        // restoreAll replays the stored f32 verbatim — bit-exact, not just close.
        expect(after).toEqual(before);
    });

    test("force split → undo restores the point payload byte-identical (the boundary-keyframe plant included)", () => {
        // the exactness fix's data boundary: `splitCmd`'s whole-track snapshot must
        // round-trip the PLANTED boundary keyframe's explicit tangent columns
        // (`Force.tmode`/`tin`/`tout`), not just `s`/`g` — a risky surface this stage
        // newly exercises (`review.md`'s data-boundary trigger).
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        const a = createSection(state, 0, SectionKind.Force, 40);
        createForcePoint(state, a, 10, 1);
        createForcePoint(state, a, 30, 2);
        const before = forcePoints(state, a);
        const h = createHistory();

        const b = splitCmd(h, state, a, 20);
        expect(b).not.toBeNull();
        expect(sections(state).length).toBe(2);
        expect(sectionForces(state, a).map((p) => p.s)).toEqual([10, 20]);

        undo(h, state);
        expect(sections(state).length).toBe(1);
        const after = forcePoints(state, a);
        // restoreAll replays the stored f32/tangent columns verbatim.
        expect(after).toEqual(before);
    });

    test("delete records an undoable entry", () => {
        const { state, a } = twoGeo();
        const h = createHistory();
        expect(removeCmd(h, state, a)).toBe(true);
        expect(h.undo.length).toBe(1);
    });
});
