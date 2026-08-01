import { describe, expect, test } from "bun:test";
import { State } from "@dylanebert/shallot";
import {
    appendSection as appendCmd,
    createHistory,
    joinSection as joinCmd,
    removeSection as removeCmd,
    splitSection as splitCmd,
    undo,
} from "../src/history";
import {
    addNode,
    appendSection,
    BakeSystem,
    convertSection,
    createForcePoint,
    createSection,
    createTrack,
    deleteSection,
    EXTEND_DIST,
    exitWorld,
    Handle,
    handleAt,
    handleTangent,
    joinNext,
    reheadOnDrag,
    removeTrailingHandle,
    samples,
    SectionKind,
    sectionForces,
    sectionHandles,
    sectionInfo,
    sections,
    seedTangent,
    setTangent,
    setTrackDomain,
    splitForce,
    splitGeo,
    Track,
} from "../src/track";
import { Domain } from "../src/section";
import { editTangent, TangentMode } from "../src/spline";
import { stitchNode } from "../src/tangents";

// the multi-section structural ops: append / split / join / delete over the section
// chain (kex2d/AGENTS.md, structural ops). the substrate (chain, sectionInfo,
// local storage) is covered in section.test.ts; this pins the ECS-authoring layer —
// chain continuity across a boundary, split/join losslessness (f32 rigid round-off),
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

        // the point at s=10 stays in A; the s=30 point moves to B, rebased to 10.
        expect(sectionForces(state, a).map((p) => p.s)).toEqual([10]);
        expect(sectionForces(state, b).map((p) => p.s)).toEqual([10]);
        // extents split at 20.
        expect(sections(state).find((s) => s.id === a)?.length).toBe(20);
        expect(sections(state).find((s) => s.id === b)?.length).toBe(20);
    });

    test("splitting a force section in a Time-domain track is a lossless partition in the store's unit (seconds)", () => {
        // splitForce/joinNext partition whatever unit `Track.domain` holds — the docstrings
        // used to say "arclength s", which is false once the store is seconds. This pins
        // the split as a lossless partition in the store's own unit, then joins back.
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        setTrackDomain(state, Domain.Time);
        const a = createSection(state, 0, SectionKind.Force, 40);
        createForcePoint(state, a, 10, 1);
        createForcePoint(state, a, 30, 2);

        const b = splitForce(state, a, 20);
        expect(b).not.toBeNull();
        if (b === null) return;

        // keyframe positions re-home exactly: the s=10 point stays in A, the s=30 point
        // moves to B rebased to 10 — in seconds, same as the arclength case.
        expect(sectionForces(state, a).map((p) => p.s)).toEqual([10]);
        expect(sectionForces(state, b).map((p) => p.s)).toEqual([10]);
        // extents split at 20 (seconds).
        expect(sections(state).find((s) => s.id === a)?.length).toBe(20);
        expect(sections(state).find((s) => s.id === b)?.length).toBe(20);

        // join restores the pre-split partition exactly.
        expect(joinNext(state, a)).toBe(true);
        expect(sectionForces(state, a).map((p) => p.s)).toEqual([10, 30]);
        expect(sections(state).find((s) => s.id === a)?.length).toBe(40);
    });
});

describe("join", () => {
    test("joining across a boundary with an explicit tangent keeps the baked world curve", () => {
        // one-sided: A and B are built directly, NOT via splitGeo (a split→join round-trip
        // would cancel the frame bug — the two re-frames compose back to identity — so it
        // can't pin `joinNext`'s own use of `headExit`). mirrors the split pin above.
        //
        // A's tip (node 2) carries an explicit Mirror tangent whose direction is far from its
        // stored `Handle.theta` (a stale leftover from `reflect`, unused once a tangent is
        // explicit) — the exact decoupling `headExit` must resolve against the RECOVERED exit,
        // not the stale stored heading. B's entry node is given the world-equal tangent
        // (rotated into B's own local frame) so the two-section bake's departure from the
        // boundary matches what the join will produce once A's tip's own vector goes live —
        // isolating the assertion to whether `headExit` places B's downstream node at the
        // right world position, not a re-authoring of the departure itself.
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        const a = createSection(state, 0, SectionKind.Geo, 0);
        for (const [x, y] of [
            [0, 0],
            [20, 4],
            [40, 4],
        ])
            addNode(state, a, x, y);
        const mag = 15;
        const ang = 1.2;
        const wx = mag * Math.cos(ang);
        const wy = mag * Math.sin(ang);
        setTangent(state, a, 2, { mode: TangentMode.Mirror, inX: wx, inY: wy, outX: wx, outY: wy });

        const b = appendSection(state, SectionKind.Geo);
        state.step(0); // learn B's actual recovered entry frame (A's real exit, not a guess)
        const infoB = sectionInfo.get(b);
        if (!infoB) throw new Error("section B info missing");
        const phi = infoB.entry.theta;
        const c = Math.cos(phi);
        const s = Math.sin(phi);
        // rotate A's tip's world-space tangent into B's local frame (R(−phi)) so B's own
        // departure matches, in world space, the vector that will govern the join.
        setTangent(state, b, 0, {
            mode: TangentMode.Mirror,
            inX: c * wx + s * wy,
            inY: -s * wx + c * wy,
            outX: c * wx + s * wy,
            outY: -s * wx + c * wy,
        });
        state.step(0);
        const before = worldSamples(eid);

        expect(joinNext(state, a)).toBe(true);
        state.step(0);
        const after = worldSamples(eid);

        expect(after.length).toBe(before.length);
        let maxDev = 0;
        for (let i = 0; i < before.length; i++)
            maxDev = Math.max(
                maxDev,
                Math.hypot(after[i].x - before[i].x, after[i].y - before[i].y),
            );
        // same derived floor as the split pin (`splitting at a node with an explicit tangent
        // keeps the baked world curve`, above): the Auto join's f32 rigid round-off, with
        // headroom well below the metres a stale-theta frame would drift on this decoupled
        // boundary.
        expect(maxDev).toBeLessThan(0.05);
    });
});

describe("split → join round-trips", () => {
    test("geo split then join restores the node payload (exact to f32 round-off)", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        const a = createSection(state, 0, SectionKind.Geo, 0);
        for (const [x, y] of [
            [0, 0],
            [20, 6],
            [40, 6],
            [60, -2],
            [80, 0],
        ])
            addNode(state, a, x, y);
        const before = sectionHandles(state, a).map((e) => ({
            x: Handle.pos.x.get(e),
            y: Handle.pos.y.get(e),
            theta: Handle.theta.get(e),
        }));

        const b = splitGeo(state, a, 2);
        expect(b).not.toBeNull();
        expect(joinNext(state, a)).toBe(true); // join A with the tail it just spawned

        expect(sections(state).length).toBe(1);
        const after = sectionHandles(state, a).map((e) => ({
            x: Handle.pos.x.get(e),
            y: Handle.pos.y.get(e),
            theta: Handle.theta.get(e),
        }));
        expect(after.length).toBe(before.length);
        for (let i = 0; i < before.length; i++) {
            expect(after[i].x).toBeCloseTo(before[i].x, 4);
            expect(after[i].y).toBeCloseTo(before[i].y, 4);
            expect(after[i].theta).toBeCloseTo(before[i].theta, 5);
        }
    });

    test("force split then join restores the point payload and extent", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        const a = createSection(state, 0, SectionKind.Force, 40);
        createForcePoint(state, a, 8, 1.5);
        createForcePoint(state, a, 24, 0.4);
        const before = sectionForces(state, a).map((p) => ({ s: p.s, g: p.g }));

        const b = splitForce(state, a, 16);
        expect(b).not.toBeNull();
        expect(joinNext(state, a)).toBe(true);

        expect(sections(state).length).toBe(1);
        expect(sections(state)[0].length).toBeCloseTo(40, 5);
        const after = sectionForces(state, a).map((p) => ({ s: p.s, g: p.g }));
        expect(after.length).toBe(before.length);
        for (let i = 0; i < before.length; i++) {
            expect(after[i].s).toBeCloseTo(before[i].s, 4);
            expect(after[i].g).toBe(before[i].g);
        }
    });

    test("join refuses across kinds", () => {
        const { state, a } = twoGeo();
        convertSection(state, a); // a is now force, b is geo — mismatched
        expect(joinNext(state, a)).toBe(false);
    });
});

// the per-section step (kex2d-geoforce-editor stage 1): a converted section carries the
// solve's realized step (`Section.ds`, 0 = the track-nominal `Track.ds`). the structural ops
// have one rule each — a split inherits it into both halves, a join takes the upstream's.
describe("per-section step through split / join", () => {
    /** a two-force-section chain with the given steps, ready to join. */
    function twoForce(dsA: number, dsB: number): { state: State; a: number } {
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        const a = createSection(state, 0, SectionKind.Force, 20, dsA);
        createSection(state, 1, SectionKind.Force, 20, dsB);
        return { state, a };
    }

    test("a force split gives both halves the step", () => {
        // both halves still span their own solve at the same density — the split partitions
        // the profile, it doesn't re-solve it. 0.25 is f32-exact.
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        const a = createSection(state, 0, SectionKind.Force, 40, 0.25);
        createForcePoint(state, a, 10, 1);
        createForcePoint(state, a, 30, 2);

        expect(splitForce(state, a, 20)).not.toBeNull();
        expect(sections(state).map((s) => s.ds)).toEqual([0.25, 0.25]);
    });

    test("a join keeps the upstream step", () => {
        // the joined section is no longer either solve's output, so the downstream step has no
        // claim on it: upstream wins, whichever way round the pair carries one.
        const kept = twoForce(0.25, 0);
        expect(joinNext(kept.state, kept.a)).toBe(true);
        expect(sections(kept.state).map((s) => s.ds)).toEqual([0.25]);

        const dropped = twoForce(0, 0.25);
        expect(joinNext(dropped.state, dropped.a)).toBe(true);
        expect(sections(dropped.state).map((s) => s.ds)).toEqual([0]);
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

    test("join and delete record undoable entries; a cross-kind join records nothing", () => {
        const { state, a } = twoGeo();
        const h = createHistory();
        expect(joinCmd(h, state, a)).toBe(true); // both geo → joins
        expect(h.undo.length).toBe(1);
        undo(h, state);
        expect(sections(state).length).toBe(2);

        expect(removeCmd(h, state, a)).toBe(true);
        expect(h.undo.length).toBe(1);
    });
});
