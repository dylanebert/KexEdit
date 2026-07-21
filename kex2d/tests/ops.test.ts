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
    Handle,
    joinNext,
    reheadOnDrag,
    samples,
    SectionKind,
    sectionForces,
    sectionHandles,
    sectionInfo,
    sections,
    setTangent,
    splitForce,
    splitGeo,
    Track,
} from "../src/track";
import { TangentMode } from "../src/spline";

// the multi-section structural ops: append / split / join / delete over the section
// chain (kex2d/CLAUDE.md, structural ops). the substrate (chain, sectionInfo,
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

        undo(h);
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

        undo(h);
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
        undo(h);
        expect(sections(state).length).toBe(2);

        expect(removeCmd(h, state, a)).toBe(true);
        expect(h.undo.length).toBe(1);
    });
});
