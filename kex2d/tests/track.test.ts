import { describe, expect, test } from "bun:test";
import { State } from "@dylanebert/shallot";
import {
    addNode,
    appendSection,
    BakeSystem,
    bakeOut,
    convertSection,
    createForcePoint,
    createSection,
    createTrack,
    EXTEND_DIST,
    exitWorld,
    extend,
    forceEase,
    type ForceTangent,
    forceTangent,
    Handle,
    handleAt,
    handleTangent,
    MAX_SAMPLES,
    reheadOnDrag,
    removeTrailingHandle,
    resetForceTangent,
    resetTangent,
    restoreAll,
    samples,
    SectionKind,
    sectionForces,
    sectionHandles,
    sectionInfo,
    sections,
    sectionSpans,
    seedTangent,
    setForceEase,
    setForcePoint,
    setForceTangent,
    setSectionLength,
    setTangent,
    setTrackV0,
    snapshotAll,
    toGlobal,
    toLocal,
    Track,
} from "../src/track";
import {
    appendSection as appendSectionCmd,
    beginForceTangent,
    commit,
    createHistory,
    redo,
    setForceEase as setForceEaseCmd,
    undo,
} from "../src/history";
import { DEFAULT_G, Easing } from "../src/profile";
import { editTangent, type Node, sampleChain, TangentMode } from "../src/spline";

// the ECS layer: BakeSystem walks the sorted sections → chain(START, payloads) →
// computeTime, syncs each geo node's sample index, and records the per-section
// orphan / feasibility state the renderer reads. the pure pieces are covered in
// section/spline/bake/forward; this pins the integration the glue owns. the bake is
// pure CPU, so the test runs BakeSystem on a device-free State via the scheduler.

/** a fresh flat track: one geo section, node 0 at the local origin (the pinned entry
 *  anchor) + a flat shape node — the same seed shape the plugin starts with. */
function track(): { state: State; eid: number; sec: number } {
    const state = new State();
    state.addSystem(BakeSystem);
    const eid = createTrack(state);
    const sec = createSection(state, 0, SectionKind.Geo, 0);
    addNode(state, sec, 0, 0);
    addNode(state, sec, EXTEND_DIST, 0);
    return { state, eid, sec };
}

describe("BakeSystem", () => {
    test("a flat horizontal chain bakes to 1g and is fully feasible", () => {
        const { state, eid } = track();
        state.step(0);
        const count = Track.count.get(eid);
        const out = bakeOut.get(eid);
        const s = samples.get(eid);
        if (!out || !s) throw new Error("track buffers missing");

        expect(count).toBeGreaterThan(2);
        // straight + level: no turning (dθ = 0) and cos θ = 1, so F_n = 1g.
        for (let i = 0; i < count - 1; i++) expect(out.fN[i]).toBeCloseTo(1, 3);
        for (let i = 0; i < count; i++) expect(s.posY[i]).toBeCloseTo(0, 4);
        expect(out.firstInfeasible).toBe(-1);
        for (let i = 0; i < count; i++) expect(out.feasible[i]).toBe(1);
    });

    test("the baked curve passes through every node; free positions stay put", () => {
        const { state, eid, sec } = track();
        addNode(state, sec, 40, 2); // a third node off-axis
        state.step(0);
        const s = samples.get(eid);
        if (!s) throw new Error("samples missing");

        const handles = sectionHandles(state, sec);
        for (const h of handles) {
            const i = Handle.sample.get(h);
            // section 0's entry is START (identity), so local ≡ world.
            expect(s.posX[i]).toBeCloseTo(Handle.pos.x.get(h), 4);
            expect(s.posY[i]).toBeCloseTo(Handle.pos.y.get(h), 4);
        }
        // every position is authored, not derived — unmoved by the bake.
        expect(Handle.pos.x.get(handles[0])).toBeCloseTo(0, 6);
        expect(Handle.pos.y.get(handles[0])).toBeCloseTo(0, 6);
        expect(Handle.pos.x.get(handles[2])).toBeCloseTo(40, 6);
        expect(Handle.pos.y.get(handles[2])).toBeCloseTo(2, 6);
    });

    test("node 0 is the entry anchor: it lands at sample 0, the world origin", () => {
        // every section's node 0 is pinned at the local origin; section 0's entry
        // is START, so it renders at the world origin (sample 0). guards the substrate
        // wiring — the chain seeds sample 0 from START and the section shares it.
        const { state, eid, sec } = track();
        state.step(0);
        const s = samples.get(eid);
        if (!s) throw new Error("samples missing");
        const node0 = sectionHandles(state, sec)[0];
        expect(Handle.sample.get(node0)).toBe(0);
        expect(s.posX[0]).toBeCloseTo(0, 4);
        expect(s.posY[0]).toBeCloseTo(0, 4);
    });

    test("extend lays a node continuing the last edge's direction", () => {
        const { state, sec } = track(); // last edge is +x from (EXTEND_DIST,0)
        const before = sectionHandles(state, sec).length;
        const e = extend(state, sec);
        state.step(0);
        const handles = sectionHandles(state, sec);
        expect(handles.length).toBe(before + 1);
        expect(handles[handles.length - 1]).toBe(e);
        // the new node lands EXTEND_DIST further along +x.
        expect(Handle.pos.x.get(e)).toBeCloseTo(2 * EXTEND_DIST, 6);
        expect(Handle.pos.y.get(e)).toBeCloseTo(0, 6);
    });

    test("removing the trailing node drops it, never below two nodes", () => {
        const { state, sec } = track();
        extend(state, sec); // a third node
        state.step(0);
        expect(sectionHandles(state, sec).length).toBe(3);

        expect(removeTrailingHandle(state, sec)).toBe(true);
        expect(sectionHandles(state, sec).length).toBe(2);
        // a two-node chain is the floor — further removal is refused.
        expect(removeTrailingHandle(state, sec)).toBe(false);
        expect(sectionHandles(state, sec).length).toBe(2);
    });

    test("deleting the tip re-derives the promoted node's heading (no stale jump)", () => {
        const { state, sec } = track();
        addNode(state, sec, 40, 0); // nodes 0,1,2
        const h = sectionHandles(state, sec);
        // node 1 is interior with an off-axis position and a deliberately stale
        // heading — what a frozen interior heading looks like before promotion.
        Handle.pos.set(h[1], 16, 8);
        Handle.theta.set(h[1], 0.5);
        expect(removeTrailingHandle(state, sec)).toBe(true); // drop node 2 → node 1 is the tip
        // the promoted tip re-derives from node 0 (origin, flat): reflect(0, chord₀→₁).
        expect(Handle.theta.get(h[1])).toBeCloseTo(2 * Math.atan2(8, 16), 10);
        expect(Handle.theta.get(h[1])).not.toBe(0.5); // not the stale value
    });

    // ── promoted-tip reconciliation ──────────────────────────────────────────────
    // deleting the trailing node promotes an interior node to chain tip. an interior
    // node's authored tangent shapes the segments around it; once it's the tip, its
    // out-vector shaped the segment we just deleted, so it's ghost state. the class
    // invariant: after a delete the promoted tip is well-formed — Auto (no ghost
    // tangent), heading re-derived, so the readout (`exitWorld`) reports the authored
    // heading, indistinguishable from having authored the shorter chain directly.

    /** the chain tip is a well-formed Auto tip: no explicit tangent, and its authored
     *  exit heading is the arc reflection of its predecessor — the same state a freshly
     *  added tip carries. one assertion covers the bake (drives `handle()` via `theta`),
     *  the readout (`exitWorld` reads `theta` for an Auto node), and extend/append. */
    function expectTipReconciled(state: State, sec: number): void {
        const h = sectionHandles(state, sec);
        const tip = h[h.length - 1];
        const prev = h[h.length - 2];
        expect(handleTangent(state, sec, Handle.order.get(tip))).toBeUndefined();
        // the reflection references the predecessor's ACTUAL exit — an authored predecessor
        // exits along its out-vector, an Auto one along its stored theta.
        const prevTan = handleTangent(state, sec, Handle.order.get(prev));
        const prevExit = prevTan ? Math.atan2(prevTan.outY, prevTan.outX) : Handle.theta.get(prev);
        const chord = Math.atan2(
            Handle.pos.y.get(tip) - Handle.pos.y.get(prev),
            Handle.pos.x.get(tip) - Handle.pos.x.get(prev),
        );
        const expected = 2 * chord - prevExit;
        expect(Handle.theta.get(tip)).toBeCloseTo(expected, 10);
        // prev is the first section here (entry.theta = 0), so the readout reports the
        // re-derived heading directly, not a stale out-vector.
        expect(exitWorld(tip)).toBeCloseTo(expected, 10);
    }

    test("delete after authoring a tangent on the intermediate node resets the promoted tip", () => {
        // the user's exact sequence: manipulate an intermediate node's handle, then
        // delete the node after it. before the fix the promoted tip kept its Aligned
        // out-vector (authored toward the deleted node) and reported 45°, not the flat 0°.
        const { state, sec } = track();
        addNode(state, sec, 20, 5); // nodes 0(0,0) 1(EXTEND_DIST,0) 2(20,5)
        state.step(0);
        const seed = seedTangent(state, sec, 1, TangentMode.Aligned);
        if (!seed) throw new Error("seed");
        setTangent(state, sec, 1, editTangent(seed, "out", 8, 8)); // pull node 1's handle to 45°
        state.step(0);
        expect(exitWorld(handleAt(state, sec, 1) as number)).toBeCloseTo(Math.PI / 4, 6); // 45° authored

        expect(removeTrailingHandle(state, sec)).toBe(true); // delete node 2 → node 1 is the tip
        state.step(0);
        expectTipReconciled(state, sec);
        expect(exitWorld(handleAt(state, sec, 1) as number)).toBeCloseTo(0, 10); // flat, not 45°
    });

    test("delete when the trailing tip itself carries a tangent leaves a well-formed tip", () => {
        // the deleted node's own tangent goes with it; the promoted node still reconciles.
        const { state, sec } = track();
        addNode(state, sec, 20, 6); // 0,1,2
        state.step(0);
        // author BOTH the interior node and the trailing tip.
        const s1 = seedTangent(state, sec, 1, TangentMode.Aligned);
        const s2 = seedTangent(state, sec, 2, TangentMode.Free);
        if (!s1 || !s2) throw new Error("seed");
        setTangent(state, sec, 1, editTangent(s1, "out", 6, 5));
        setTangent(state, sec, 2, editTangent(s2, "in", -4, 3));
        state.step(0);
        expect(removeTrailingHandle(state, sec)).toBe(true);
        state.step(0);
        expectTipReconciled(state, sec);
    });

    test("deleting down to the two-node floor keeps every surviving tip well-formed", () => {
        const { state, sec } = track();
        addNode(state, sec, 20, 4);
        addNode(state, sec, 34, 10); // 0,1,2,3
        state.step(0);
        // author tangents across the interior so each promotion crosses a concrete node.
        for (const order of [1, 2]) {
            const seed = seedTangent(state, sec, order, TangentMode.Aligned);
            if (!seed) throw new Error("seed");
            setTangent(state, sec, order, editTangent(seed, "out", 5, 4));
        }
        state.step(0);
        expect(removeTrailingHandle(state, sec)).toBe(true); // 3 → node 2 tip
        state.step(0);
        expectTipReconciled(state, sec);
        expect(removeTrailingHandle(state, sec)).toBe(true); // 2 → node 1 tip
        state.step(0);
        expectTipReconciled(state, sec);
        expect(removeTrailingHandle(state, sec)).toBe(false); // floor
        expect(sectionHandles(state, sec).length).toBe(2);
    });

    test("append after authoring the old tip, then delete, round-trips to a well-formed tip", () => {
        // demotion (append makes the old tip interior — its tangent legitimately shapes both
        // its segments) then re-promotion (delete) must not leave ghost state.
        const { state, sec } = track();
        state.step(0);
        const seed = seedTangent(state, sec, 1, TangentMode.Free);
        if (!seed) throw new Error("seed");
        setTangent(state, sec, 1, editTangent(seed, "out", 7, 6)); // author the tip (node 1)
        addNode(state, sec, 30, 8); // append node 2 → node 1 demotes to interior, keeps its tangent
        state.step(0);
        expect(handleTangent(state, sec, 1)).toBeDefined(); // interior authored state preserved
        expect(removeTrailingHandle(state, sec)).toBe(true); // delete node 2 → node 1 re-promoted
        state.step(0);
        expectTipReconciled(state, sec); // the once-authored node is now a clean Auto tip
    });

    test("an unchanged chain is not re-baked; moving a node re-bakes (hash gate)", () => {
        const { state, eid, sec } = track();
        state.step(0);
        const out = bakeOut.get(eid);
        if (!out) throw new Error("bakeOut missing");
        out.fN[0] = 999; // a re-bake would overwrite this sentinel
        state.step(0);
        expect(out.fN[0]).toBe(999); // unchanged → bake skipped

        Handle.pos.set(sectionHandles(state, sec)[1], EXTEND_DIST, 1); // move a node
        state.step(0);
        expect(out.fN[0]).not.toBe(999); // hash miss → re-baked
    });

    test("a steep straight climb beyond the energy budget flags downstream infeasible", () => {
        // ½·V0² = 50 J/kg reaches only ~5.1 m of climb. a straight ramp up at
        // ~60° (rise ≈ 27.7 m over 16 m) depletes energy partway up.
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        const sec = createSection(state, 0, SectionKind.Geo, 0);
        addNode(state, sec, 0, 0);
        addNode(state, sec, 16, 27.7);
        state.step(0);
        const out = bakeOut.get(eid);
        const count = Track.count.get(eid);
        if (!out) throw new Error("bakeOut missing");

        expect(out.feasible[0]).toBe(1); // launches at V0 = 10
        expect(out.firstInfeasible).toBeGreaterThan(0);
        expect(out.firstInfeasible).toBeLessThan(count);
        expect(out.feasible[count - 1]).toBe(0); // energy-depleted up the climb
    });

    test("the authored v0 threads into the bake: a higher launch clears a climb the default can't", () => {
        // the same steep climb the energy-budget test flags infeasible at the default
        // V0=10; a higher authored v0 carries enough energy to clear it — proving v0
        // reaches the physics (and that a v0 change is a bake-hash miss → re-bake).
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        const sec = createSection(state, 0, SectionKind.Geo, 0);
        addNode(state, sec, 0, 0);
        addNode(state, sec, 16, 27.7);
        state.step(0);
        expect(bakeOut.get(eid)?.firstInfeasible).toBeGreaterThan(0); // default V0 depletes

        setTrackV0(eid, 30); // ½·30² = 450 J/kg clears g·27.7 ≈ 272
        state.step(0);
        expect(bakeOut.get(eid)?.firstInfeasible).toBe(-1); // now fully feasible
    });

    test("a smooth curve bakes to a non-oscillating F_n", () => {
        // a gentle S-wave (shifted so node 0 sits at the origin): its true normal force
        // varies slowly, so the baked F_n's slope should reverse only where the
        // curvature genuinely turns over — not sample-to-sample. guards against
        // regressing BakeSystem back to the leapfrog-mode reflection inverse.
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        const sec = createSection(state, 0, SectionKind.Geo, 0);
        addNode(state, sec, 0, 0);
        addNode(state, sec, 20, 2);
        addNode(state, sec, 40, 0);
        addNode(state, sec, 60, -2);
        addNode(state, sec, 80, 0);
        state.step(0);
        const out = bakeOut.get(eid);
        const count = Track.count.get(eid);
        if (!out) throw new Error("bakeOut missing");

        let reversals = 0;
        for (let i = 2; i < count - 1; i++) {
            const a = out.fN[i - 1] - out.fN[i - 2];
            const b = out.fN[i] - out.fN[i - 1];
            if (a * b < 0) reversals++;
        }
        expect(reversals).toBeLessThan((count - 1) / 4);
    });

    test("an empty force profile bakes a flat 1g track over the section length", () => {
        // convert the flat geo seed to force: the two continuation seeds hold the entry
        // force (1g here, the first section's DEFAULT_G start), so the profile is a
        // constant 1g that integrates to a straight level track matching the extent.
        const { state, eid, sec } = track();
        state.step(0); // geo bake first, so the convert inherits its arclength
        convertSection(state, sec);
        expect(sections(state)[0].kind).toBe(SectionKind.Force);
        const len = sections(state)[0].length;
        expect(len).toBeGreaterThan(20); // the seed's ~24 m

        state.step(0); // force bake
        const count = Track.count.get(eid);
        const out = bakeOut.get(eid);
        const s = samples.get(eid);
        if (!out || !s) throw new Error("track buffers missing");

        expect(count).toBeGreaterThan(2);
        for (let i = 0; i < count - 1; i++) expect(out.fN[i]).toBeCloseTo(1, 3);
        for (let i = 0; i < count; i++) expect(s.posY[i]).toBeCloseTo(0, 3);
        expect(out.firstInfeasible).toBe(-1);
        let arc = 0;
        for (let i = 0; i < count - 1; i++) arc += out.ds[i];
        expect(arc).toBeCloseTo(len, 1); // integrated length ≈ the authored extent
    });

    test("force points shape the bake — a localized dip recovers below 1g, non-flat", () => {
        // three points hold 1g at the ends and dip to 0g mid-track: a localized
        // airtime crest. the recovered display force follows the authored dip (O(ds)
        // off) and the geometry is no longer flat.
        const { state, eid, sec } = track();
        state.step(0);
        convertSection(state, sec);
        const len = sections(state)[0].length;
        createForcePoint(state, sec, len * 0.2, 1);
        createForcePoint(state, sec, len * 0.5, 0);
        createForcePoint(state, sec, len * 0.8, 1);
        state.step(0);

        const count = Track.count.get(eid);
        const out = bakeOut.get(eid);
        const s = samples.get(eid);
        if (!out || !s) throw new Error("track buffers missing");

        const mid = Math.floor((count - 1) / 2);
        expect(out.fN[mid]).toBeLessThan(0.4); // near the authored 0g crest
        expect(out.fN[1]).toBeGreaterThan(0.7); // near the authored 1g lead-in
        let maxAbsY = 0;
        for (let i = 0; i < count; i++) maxAbsY = Math.max(maxAbsY, Math.abs(s.posY[i]));
        expect(maxAbsY).toBeGreaterThan(0.5); // the geometry responded (not flat)
    });

    test("convert geo→force clears the nodes and resets to the default extent", () => {
        const { state, sec } = track();
        addNode(state, sec, 60, 0); // extend the geo well past the default extent
        state.step(0);
        // the baked geo arclength is now ~60, but a convert RESETS the force extent
        // (the extent is the force section's own property), it does not inherit it.
        convertSection(state, sec);
        expect(sections(state)[0].kind).toBe(SectionKind.Force);
        expect(sectionHandles(state, sec).length).toBe(0);
        expect(sections(state)[0].length).toBeCloseTo(EXTEND_DIST, 5); // the default
    });

    test("a force section's extent is settable and floors at the minimum", () => {
        const { state, eid, sec } = track();
        state.step(0);
        convertSection(state, sec);
        setSectionLength(state, sec, 50);
        state.step(0);
        const out = bakeOut.get(eid);
        const count = Track.count.get(eid);
        if (!out) throw new Error("bakeOut missing");
        let arc = 0;
        for (let i = 0; i < count - 1; i++) arc += out.ds[i];
        expect(arc).toBeCloseTo(50, 1); // the integrated track matches the set extent

        setSectionLength(state, sec, 0.0001); // below the floor
        expect(sections(state)[0].length).toBeGreaterThanOrEqual(2); // clamped, not degenerate
    });

    test("convert force→geo clears the points and reseeds the flat two-node shape", () => {
        const { state, sec } = track();
        state.step(0);
        convertSection(state, sec); // → force (seeds the two continuation keyframes)
        createForcePoint(state, sec, 5, 2);
        expect(sectionForces(state, sec).length).toBe(3); // 2 seeds + the authored point

        convertSection(state, sec); // → geo
        expect(sections(state)[0].kind).toBe(SectionKind.Geo);
        expect(sectionForces(state, sec).length).toBe(0);
        expect(sectionHandles(state, sec).length).toBe(2);
    });

    test("a kind flip busts the bake hash; an unchanged force track is not re-baked", () => {
        const { state, eid, sec } = track();
        state.step(0);
        convertSection(state, sec);
        state.step(0);
        const out = bakeOut.get(eid);
        if (!out) throw new Error("bakeOut missing");
        out.fN[0] = 999;
        state.step(0);
        expect(out.fN[0]).toBe(999); // unchanged force track → skipped
        createForcePoint(state, sec, 5, 2);
        state.step(0);
        expect(out.fN[0]).not.toBe(999); // a new point → re-baked
    });

    test("a coincident interior node orphans the trailing nodes", () => {
        const { state, sec } = track(); // nodes order 0,1
        addNode(state, sec, EXTEND_DIST, 0); // order 2 — coincident with node 1
        addNode(state, sec, 40, 0); // order 3
        state.step(0);
        const info = sectionInfo.get(sec);
        if (!info) throw new Error("sectionInfo missing");

        expect(info.bakedNodes).toBe(2); // only nodes 0,1 landed
        const orphaned = sectionHandles(state, sec)
            .map((h) => Handle.order.get(h))
            .filter((o) => o >= info.bakedNodes);
        expect(orphaned).toEqual([2, 3]);
    });
});

describe("reheadOnDrag", () => {
    // the drag-time heading refresh: the last node always tracks its predecessor;
    // node 0 (the entry anchor) + interior nodes stay frozen. controls.ts calls this
    // after every pointermove; the pure logic is exercised here without the DOM.

    test("dragging the last node re-derives its heading (the bend you drag in)", () => {
        const { state, sec } = track(); // flat seed (0,0),(EXTEND_DIST,0), both θ = 0
        const end = sectionHandles(state, sec)[1];
        Handle.pos.set(end, EXTEND_DIST, 10); // drag the end up
        reheadOnDrag(state, end);
        // predecessor heading is 0, so the exit reflects to 2·chord — a real arc.
        expect(Handle.theta.get(end)).toBeCloseTo(2 * Math.atan2(10, EXTEND_DIST), 10);
    });

    test("dragging the node before the last re-aims the last node — no stale jump", () => {
        const { state, sec } = track();
        addNode(state, sec, 40, 0); // nodes 0,1,2 — node 2 is last, node 1 is before it
        const h = sectionHandles(state, sec);
        expect(Handle.theta.get(h[2])).toBe(0); // last starts flat
        Handle.pos.set(h[1], 16, 8); // drag the node *before* the last
        reheadOnDrag(state, h[1]);
        // node 1 stays frozen; the last node re-derives from node 1's new position.
        expect(Handle.theta.get(h[1])).toBe(0);
        expect(Handle.theta.get(h[2])).toBeCloseTo(2 * Math.atan2(0 - 8, 40 - 16), 10);
    });

    test("the entry anchor and a pure interior node never re-derive", () => {
        const { state, sec } = track();
        addNode(state, sec, 40, 0);
        addNode(state, sec, 64, 0); // nodes 0,1,2,3
        const h = sectionHandles(state, sec);
        Handle.theta.set(h[1], 0.5); // node 1 is pure interior (not last, not before-last)
        const lastBefore = Handle.theta.get(h[3]);

        Handle.pos.set(h[1], 16, 8); // drag the pure interior node far off its chord
        reheadOnDrag(state, h[1]);
        expect(Handle.theta.get(h[1])).toBe(0.5); // frozen
        expect(Handle.theta.get(h[3])).toBe(lastBefore); // last node untouched
    });

    test("a dragged end bends its segment into an arc — end to end", () => {
        const { state, eid, sec } = track();
        const end = sectionHandles(state, sec)[1];
        Handle.pos.set(end, EXTEND_DIST, 10);
        reheadOnDrag(state, end);
        state.step(0);
        const s = samples.get(eid);
        if (!s) throw new Error("samples missing");
        const count = Track.count.get(eid);
        // the re-derived heading makes a clean arc that *exits* climbing at
        // reflect(0, chord) > 0.3 rad; the exit angle pins the re-head.
        expect(s.theta[count - 1]).toBeGreaterThan(0.3);
        expect(s.posY[Math.floor(count / 2)]).toBeGreaterThan(0); // a real climb
    });
});

// the coordinate lens (track.ts): section-local arclength `s` (storage) ↔ track-global
// distance `d` (the author surface / timeline ruler). `d = section offset + local s`;
// `sectionSpans` is the one offset table, `toGlobal`/`toLocal` the affine + inverse.
describe("coordinate lens (s ↔ d)", () => {
    /** geo → force → force, each force point authored section-local, baked. */
    function chainTrack(): { state: State; eid: number; secs: number[] } {
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        const g = createSection(state, 0, SectionKind.Geo, 0);
        addNode(state, g, 0, 0);
        addNode(state, g, EXTEND_DIST, 0);
        const f1 = appendSection(state, SectionKind.Force);
        const f2 = appendSection(state, SectionKind.Force);
        createForcePoint(state, f2, 5, 1); // a point 5 m into the last section
        state.step(0);
        return { state, eid, secs: [g, f1, f2] };
    }

    test("toGlobal ∘ toLocal is identity for interior addresses across sections", () => {
        const { state, eid, secs } = chainTrack();
        const spans = sectionSpans(state, eid);
        expect(spans.map((sp) => sp.id)).toEqual(secs); // one span per section, in order
        // a strictly-interior local s round-trips through d back to the same (section, s):
        // interior points can't land on a shared boundary, so the address is unambiguous.
        for (const sp of spans) {
            const s = sp.len * 0.3;
            const d = toGlobal(spans, sp.id, s);
            if (d === null) throw new Error("toGlobal null for a live section");
            const back = toLocal(spans, d);
            expect(back?.section).toBe(sp.id);
            expect(back?.s).toBeCloseTo(s, 10); // f64 offset±offset noise only
        }
    });

    test("boundary addresses resolve by the upstream-inclusive policy", () => {
        const { state, eid, secs } = chainTrack();
        const spans = sectionSpans(state, eid);
        // d = 0 → the first section's entry.
        expect(toLocal(spans, 0)).toEqual({ section: secs[0], s: 0 });
        // a shared interior boundary belongs to the UPSTREAM section (its exit), not the
        // downstream entry — the clip strip's / cart's convention.
        const boundary = spans[0].offset + spans[0].len; // == spans[1].offset
        expect(boundary).toBeCloseTo(spans[1].offset, 10);
        expect(toLocal(spans, boundary)).toEqual({ section: secs[0], s: spans[0].len });
        // track end → the last section's exit.
        const end = spans[2].offset + spans[2].len;
        expect(toLocal(spans, end)).toEqual({ section: secs[2], s: spans[2].len });
        // past the end clamps to the last exit; below zero clamps to the first entry.
        expect(toLocal(spans, end + 100)).toEqual({ section: secs[2], s: spans[2].len });
        expect(toLocal(spans, -50)).toEqual({ section: secs[0], s: 0 });
    });

    test("a mid-track length change shifts downstream d but not downstream local s", () => {
        // the invariant that motivated the design: storage is section-local, so growing an
        // upstream section moves every downstream section's global offset (and its points'
        // d) while their stored s stays put — keyframes ride with their section.
        const { state, eid, secs } = chainTrack();
        const [, f1, f2] = secs;

        const before = sectionSpans(state, eid);
        // the interior authored point (s=5), not a seed keyframe at the section edges.
        const pt = sectionForces(state, f2).find((p) => p.s === 5);
        if (!pt) throw new Error("interior force point missing");
        const sBefore = pt.s;
        const dBefore = toGlobal(before, f2, sBefore);
        const offBefore = before.find((sp) => sp.id === f2)?.offset ?? Number.NaN;

        const len1 = sections(state).find((r) => r.id === f1)?.length ?? 0;
        setSectionLength(state, f1, len1 + 10); // grow the middle section by 10 m
        state.step(0);

        const after = sectionSpans(state, eid);
        const ptAfter = sectionForces(state, f2).find((p) => p.s === 5);
        if (!ptAfter) throw new Error("interior force point missing after edit");
        const offAfter = after.find((sp) => sp.id === f2)?.offset ?? Number.NaN;
        const dAfter = toGlobal(after, f2, ptAfter.s);

        // stored local s is untouched — the upstream edit never rewrote it.
        expect(ptAfter.s).toBe(sBefore);
        // the downstream offset (and thus the point's d) shifted by the length delta
        // (baked arclength tracks the authored extent to within a sample step).
        expect(offAfter - offBefore).toBeCloseTo(10, 1);
        if (dBefore === null || dAfter === null) throw new Error("toGlobal null");
        expect(dAfter - dBefore).toBeCloseTo(offAfter - offBefore, 10);
    });
});

describe("explicit tangents (substrate)", () => {
    test("an explicit tangent survives a whole-track snapshot round-trip and shapes the bake", () => {
        const { state, eid, sec } = track();
        addNode(state, sec, 40, 0); // node 1 at (24,0) becomes interior; node 2 the tip

        // a Free corner on the interior node: arrives down-right (in-vector), leaves
        // up-right (out-vector) — the two diverge, so it's a genuine kink.
        const tan = { mode: TangentMode.Free, inX: 12, inY: -4, outX: 8, outY: 8 };
        setTangent(state, sec, 1, tan);

        // serialize/deserialize: the structural-op undo unit (snapshotAll/restoreAll)
        // must round-trip the mode + both vectors verbatim.
        const snap = snapshotAll(state);
        restoreAll(state, snap);
        expect(handleTangent(state, sec, 1)).toEqual(tan);

        // and the bake honors it: the outgoing segment departs the node up-right (the
        // out-vector), the incoming arrives down-right (the in-vector) — a corner the
        // flat Auto seed never produces.
        state.step(0);
        const s = samples.get(eid);
        if (!s) throw new Error("samples missing");
        const node1 = handleAt(state, sec, 1);
        if (node1 === null) throw new Error("node 1 missing");
        const off = Handle.sample.get(node1);
        expect(off).toBeGreaterThan(0);

        const dep = Math.atan2(s.posY[off + 1] - s.posY[off], s.posX[off + 1] - s.posX[off]);
        const arr = Math.atan2(s.posY[off] - s.posY[off - 1], s.posX[off] - s.posX[off - 1]);
        expect(dep).toBeGreaterThan(0.15); // departs upward toward the +45° out-vector
        let turn = dep - arr;
        turn = ((((turn + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
        expect(Math.abs(turn)).toBeGreaterThan(0.3); // in ≠ out → a corner, not C1
    });

    test("seedTangent reproduces the Auto tangents, so summoning explicit is continuous", () => {
        // a bent chain: node 1 + node 2 interior with real curvature, so the seeded vectors
        // are non-trivial. bake the Auto curve, then summon an Aligned tangent on node 2 from
        // seedTangent and re-bake — the curve must not jump (the Auto→explicit continuity the
        // summon relies on; the only difference is f32 storage of the seeded vectors vs the
        // Auto path's unstored handle(), ≪ 5e-3 over a ~70 m span).
        const { state, eid, sec } = track();
        addNode(state, sec, 40, 15);
        addNode(state, sec, 70, 10);
        state.step(0);
        const n = Track.count.get(eid);
        const baseX = Array.from(samples.get(eid)?.posX.subarray(0, n) ?? []);
        const baseY = Array.from(samples.get(eid)?.posY.subarray(0, n) ?? []);

        const seed = seedTangent(state, sec, 2, TangentMode.Aligned);
        if (!seed) throw new Error("seed failed");
        setTangent(state, sec, 2, seed);
        state.step(0);
        expect(Track.count.get(eid)).toBe(n); // same sampling topology → same node count
        const s = samples.get(eid);
        if (!s) throw new Error("samples missing");
        for (let i = 0; i < n; i++) {
            expect(s.posX[i]).toBeCloseTo(baseX[i], 2);
            expect(s.posY[i]).toBeCloseTo(baseY[i], 2);
        }
    });

    test("setTangent(…, null) reverts a node to Auto (byte-identical to the arc bake)", () => {
        const { state, eid, sec } = track();
        addNode(state, sec, 40, 6); // node 1 becomes interior (Auto — no stamp); node 2 the Auto tip
        state.step(0);
        const baseline = Array.from(samples.get(eid)?.posY.subarray(0, Track.count.get(eid)) ?? []);

        // author + revert an explicit tangent on the *tip* (node 2, Auto in the baseline): the
        // revert lands back on Auto, so the whole curve is byte-identical to the baseline (node 1
        // is Auto in both, node 2 Auto in both).
        setTangent(state, sec, 2, { mode: TangentMode.Free, inX: 5, inY: 9, outX: 2, outY: 9 });
        state.step(0);
        setTangent(state, sec, 2, null); // revert
        state.step(0);
        const reverted = Array.from(samples.get(eid)?.posY.subarray(0, Track.count.get(eid)) ?? []);
        expect(reverted).toEqual(baseline); // Auto path unchanged by the round trip
    });
});

describe("tangent model (feel round 2)", () => {
    test("the default add/extend/drag flow stores NO tangents and bakes the pure arc rule", () => {
        // the round-2 reversal of stamp-on-append: the default shaping is byte-identical to the
        // pre-handles editor. run the default flow (seed → extend ×2 → drag an interior + the tip)
        // and pin both halves: (a) no node carries a stored tangent, (b) the ECS bake matches a
        // direct `sampleChain` over the same nodes with no tangents (the arc-rule reference).
        const { state, eid, sec } = track();
        extend(state, sec); // node 2
        extend(state, sec); // node 3 (the tip)
        // drag an interior node and the tip through the ECS path (localize is identity for the
        // first section; `reheadOnDrag` re-derives only the tip's heading).
        const n2 = handleAt(state, sec, 2);
        const n3 = handleAt(state, sec, 3);
        if (n2 === null || n3 === null) throw new Error("nodes missing");
        Handle.pos.set(n2, 40, 10);
        reheadOnDrag(state, n2);
        Handle.pos.set(n3, 66, 4);
        reheadOnDrag(state, n3);
        state.step(0);

        // (a) every node is still Auto (no stamp anywhere on the default path).
        const handles = sectionHandles(state, sec);
        for (const h of handles)
            expect(handleTangent(state, sec, Handle.order.get(h))).toBeUndefined();

        // (b) the arc-rule reference: extract the section-local nodes (no tangent) and sample them
        // directly. the first section entry is START {0,0,0}, so `place` is identity → the bake's
        // world samples equal this local reference.
        const nodes: Node[] = handles.map((h) => ({
            x: Handle.pos.x.get(h),
            y: Handle.pos.y.get(h),
            theta: Handle.theta.get(h),
        }));
        const count = Track.count.get(eid);
        const ref = {
            posX: new Float32Array(MAX_SAMPLES),
            posY: new Float32Array(MAX_SAMPLES),
            ds: new Float32Array(MAX_SAMPLES),
        };
        sampleChain(nodes, Track.ds.get(eid), ref.posX, ref.posY, ref.ds, MAX_SAMPLES);
        const s = samples.get(eid);
        if (!s) throw new Error("samples missing");
        for (let i = 0; i < count; i++) {
            expect(s.posX[i]).toBeCloseTo(ref.posX[i], 5);
            expect(s.posY[i]).toBeCloseTo(ref.posY[i], 5);
        }
    });

    test("extend at an explicit-tangent tip appends along the visible curve exit, not the stale heading", () => {
        const { state, sec } = track(); // [node 0, node 1] flat; node 1 is the tip at (EXTEND_DIST, 0)
        // author an explicit tangent whose out-vector points +y (the visible curve exit), while the
        // node's stored heading stays flat (θ = 0) — the arch-pass stale-`Handle.theta` defect: the
        // old `extend` reads the heading and would lay the node along +x.
        setTangent(state, sec, 1, { mode: TangentMode.Free, inX: 10, inY: 0, outX: 0, outY: 10 });
        const tip = handleAt(state, sec, 1);
        if (tip === null) throw new Error("tip missing");
        const lx = Handle.pos.x.get(tip);
        const ly = Handle.pos.y.get(tip);

        const e = extend(state, sec);
        // the new node lays EXTEND_DIST along the out-vector (+y), not the stale +x heading.
        expect(Handle.pos.x.get(e)).toBeCloseTo(lx, 6);
        expect(Handle.pos.y.get(e)).toBeCloseTo(ly + EXTEND_DIST, 6);
    });

    test("resetTangent clears back to live for both an interior node and the tip", () => {
        const { state, sec } = track();
        addNode(state, sec, 40, 15);
        addNode(state, sec, 70, 10); // [0, 1, 2, 3]; node 3 is the tip

        // interior node 1: author a Free corner, then Reset → cleared back to absent (live Auto),
        // now meaningful for interiors since they're live by default.
        setTangent(state, sec, 1, { mode: TangentMode.Free, inX: 3, inY: 9, outX: 9, outY: -3 });
        resetTangent(state, sec, 1);
        expect(handleTangent(state, sec, 1)).toBeUndefined();

        // the tip (node 3): author it explicit, then Reset → cleared to absent, heading re-derived.
        setTangent(state, sec, 3, { mode: TangentMode.Free, inX: 5, inY: 5, outX: 5, outY: 5 });
        expect(handleTangent(state, sec, 3)).toBeDefined();
        resetTangent(state, sec, 3);
        expect(handleTangent(state, sec, 3)).toBeUndefined(); // live again
        const tip = handleAt(state, sec, 3);
        const prev = handleAt(state, sec, 2);
        if (tip === null || prev === null) throw new Error("tip/prev missing");
        // live tip heading is the arc reflection of its predecessor's exit about their chord.
        const chord = Math.atan2(
            Handle.pos.y.get(tip) - Handle.pos.y.get(prev),
            Handle.pos.x.get(tip) - Handle.pos.x.get(prev),
        );
        const tan2 = handleTangent(state, sec, 2);
        const exit2 = tan2 ? Math.atan2(tan2.outY, tan2.outX) : Handle.theta.get(prev);
        expect(Handle.theta.get(tip)).toBeCloseTo(2 * chord - exit2, 6);
    });

    test("resetTangent clears node 0's authored entry handle back to live", () => {
        const { state, sec } = track();
        addNode(state, sec, 40, 15); // [0, 1, 2]; node 0 is the entry anchor
        // node 0 is editable now — its out-vector is the entry handle. author it, then Reset →
        // cleared back to absent (Auto C1 exit resumes).
        setTangent(state, sec, 0, { mode: TangentMode.Free, inX: 1, inY: 0, outX: 8, outY: 4 });
        expect(handleTangent(state, sec, 0)).toBeDefined();
        resetTangent(state, sec, 0);
        expect(handleTangent(state, sec, 0)).toBeUndefined();
    });

    test("an authored node-0 entry handle shapes the first segment and busts the bake hash", () => {
        const { state, sec, eid } = track();
        addNode(state, sec, 40, 0); // [0, 1, 2] flat
        state.step(0);
        const hashDefault = bakeOut.get(eid)?.hash;
        const s = samples.get(eid);
        if (!s || !hashDefault) throw new Error("bake missing");
        // sample near the start of the first segment (a few samples past node 0).
        const yDefault = s.posY[2];

        // author node 0's out-handle to swing the exit up (+y); the first segment must bulge and
        // the hash must miss (a node-0 tangent is in the hash), forcing a re-bake.
        setTangent(state, sec, 0, { mode: TangentMode.Free, inX: 1, inY: 0, outX: 20, outY: 20 });
        state.step(0);
        expect(bakeOut.get(eid)?.hash).not.toBe(hashDefault);
        const s2 = samples.get(eid);
        if (!s2) throw new Error("bake missing");
        expect(s2.posY[2]).toBeGreaterThan(yDefault); // the curve now leaves node 0 rising
    });

    test("seedTangent at node 0 seeds an out-vector along the chord to node 1", () => {
        const { state, sec } = track(); // node 0 at origin, node 1 at (EXTEND_DIST, 0) — flat
        const seed = seedTangent(state, sec, 0, TangentMode.Free);
        if (!seed) throw new Error("node-0 seed missing");
        // node 1 sits straight ahead on +x, so the arc-rule out-vector points +x (flat exit).
        expect(seed.outX).toBeGreaterThan(0);
        expect(seed.outY).toBeCloseTo(0, 6);
        // node 0 drives no in-segment, so its in-vector is the bare heading unit (unused by the bake).
        expect(seed.inX).toBeCloseTo(1, 6);
        expect(seed.inY).toBeCloseTo(0, 6);
    });

    // the default-path pin (kex2d-geo-ux stage 1): with NO node-0 tangents authored the bake hash
    // is byte-identical to the pre-change value — stage 1 is all UI enablement and must not touch
    // the bake. a node-0 tangent is Auto by default (TANGENT_AUTO), so it contributes NO `~mode:...`
    // suffix to the hash; this literal was pinned from the pre-change substrate. the section id is a
    // per-run allocator artifact (`nextSectionId`), not part of the default geometry, so it's
    // normalized out before the compare. the pin goes red if the default geo bake path ever changes
    // (a node pose, ds, v0, the hash format, or a node-0 tangent leaking in) — the guard.
    test("the default flat track bakes to the pinned hash (no node-0 tangents = byte-identical)", () => {
        const { state, eid } = track(); // node 0 (0,0), node 1 (EXTEND_DIST=24, 0); default ds/v0
        state.step(0);
        const hash = (bakeOut.get(eid)?.hash ?? "").replace(/\|S\d+:/g, "|S:"); // drop the allocator id
        expect(hash).toBe("ds0.5v010|S:0:0,0:0:0,24:0:0");
    });
});

// stage B (kex2d-force-ux): force keyframes grow an easing tag + explicit handles, and a
// fresh force section (append or geo→force convert) is SEEDED with two continuation
// keyframes at the recovered entry force — stamped from the current bake, not live-inferred.
describe("force easing + seeding (stage B)", () => {
    /** a geo→geo chain whose first section curves, so the second section's entry force
     *  (recovered at the boundary) is clearly ≠ DEFAULT_G — the value a seed must stamp. */
    function curvedChain(): { state: State; eid: number; a: number; b: number; entryF: number } {
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        const a = createSection(state, 0, SectionKind.Geo, 0);
        addNode(state, a, 0, 0);
        addNode(state, a, 20, -4);
        addNode(state, a, 44, -16); // a steepening descent → the exit edge recovers < 1g
        const b = appendSection(state, SectionKind.Geo); // b is a flat two-node geo section
        state.step(0);
        const out = bakeOut.get(eid);
        const infoB = sectionInfo.get(b);
        if (!out || !infoB) throw new Error("bake missing");
        // b's entry force = the edge arriving at b's entry = a's exit edge.
        const entryF = out.fN[infoB.startSample - 1];
        return { state, eid, a, b, entryF };
    }

    test("appendSection(Force) seeds two continuation keyframes at the recovered entry force", () => {
        const { state, eid, entryF } = curvedChain();
        expect(Math.abs(entryF - DEFAULT_G)).toBeGreaterThan(0.05); // meaningful: entry ≠ default

        // the appended force section's entry is the current last (geo b) section's exit.
        const out = bakeOut.get(eid);
        const infoLast = sectionInfo.get(sections(state)[1].id); // b, the current tail
        if (!out || !infoLast) throw new Error("bake missing");
        const expected = out.fN[infoLast.endSample - 1];

        const f = appendSection(state, SectionKind.Force);
        const pts = sectionForces(state, f);
        expect(pts.map((p) => p.s)).toEqual([0, EXTEND_DIST]); // the two continuation keyframes
        for (const p of pts) expect(p.g).toBeCloseTo(expected, 6); // both stamped from the entry
    });

    test("convert geo→force seeds from the section's recovered entry force, not DEFAULT_G", () => {
        const { state, b, entryF } = curvedChain();
        expect(Math.abs(entryF - DEFAULT_G)).toBeGreaterThan(0.05);

        convertSection(state, b); // → force; seeds continue b's entry force
        const pts = sectionForces(state, b);
        expect(pts.map((p) => p.s)).toEqual([0, EXTEND_DIST]);
        for (const p of pts) expect(p.g).toBeCloseTo(entryF, 6);
    });

    test("a force section at the track start, or with no bake, seeds at DEFAULT_G", () => {
        // no bake yet: append force before any step → the fallback.
        const { state } = track();
        const f = appendSection(state, SectionKind.Force);
        for (const p of sectionForces(state, f)) expect(p.g).toBe(DEFAULT_G);

        // the first section (entry sample 0) has no upstream edge → DEFAULT_G even with a bake.
        const t2 = track();
        t2.state.step(0);
        convertSection(t2.state, t2.sec);
        for (const p of sectionForces(t2.state, t2.sec)) expect(p.g).toBe(DEFAULT_G);
    });

    test("a seed is stamped: an upstream reshape that changes the entry force leaves it unchanged", () => {
        // convert b→force stamps b's entry force; reshaping a changes b's ACTUAL entry force,
        // but the stored seed g stays absolute (no hidden global support — the failure mode
        // this project rejects). the ride re-times; the authored force does not rewrite itself.
        const { state, eid, a, b, entryF } = curvedChain();
        convertSection(state, b); // → force, seeds stamped at entryF
        const seedG = sectionForces(state, b)[0].g;
        expect(seedG).toBeCloseTo(entryF, 6);

        // reshape a's tip so its exit force changes, then re-bake.
        const aTip = handleAt(state, a, 2);
        if (aTip === null) throw new Error("a tip missing");
        Handle.pos.set(aTip, 44, -2); // a much shallower descent → a different exit force
        reheadOnDrag(state, aTip);
        state.step(0);
        const infoB = sectionInfo.get(b);
        const out = bakeOut.get(eid);
        if (!infoB || !out) throw new Error("bake missing");
        const newEntryF = out.fN[infoB.startSample - 1];
        expect(Math.abs(newEntryF - entryF)).toBeGreaterThan(0.02); // the actual entry really moved

        // the stamped seed is unchanged despite the upstream edit.
        expect(sectionForces(state, b)[0].g).toBe(seedG);
    });

    test("a keyframe's ease + explicit handles survive a whole-track snapshot round-trip", () => {
        const { state, sec } = track();
        state.step(0);
        convertSection(state, sec); // → force (seeds two keyframes)
        const id = createForcePoint(state, sec, 12, 0.5);
        setForceEase(state, id, Easing.Sharp);
        // f32-exact offsets (multiples of 1/4) so the round-trip is byte-identical, not just close.
        const tan: ForceTangent = {
            mode: TangentMode.Free,
            in: { ds: -2, dg: 0.25 },
            out: { ds: 3, dg: -0.5 },
        };
        setForceTangent(state, id, tan);

        const snap = snapshotAll(state);
        restoreAll(state, snap); // the structural-op undo unit must round-trip the new fields
        expect(forceEase(state, id)).toBe(Easing.Sharp);
        expect(forceTangent(state, id)).toEqual(tan);
        // a seed keyframe stays the default: Ease tag, no handles.
        const seed = sectionForces(state, sec).find((p) => p.s === 0);
        if (!seed) throw new Error("seed missing");
        expect(forceEase(state, seed.id)).toBe(Easing.Ease);
        expect(forceTangent(state, seed.id)).toBeUndefined();
    });

    test("a keyframe's ease flows through the bake (forcePayload): Ease ≠ Linear, and busts the hash", () => {
        const { state, eid, sec } = track();
        state.step(0);
        convertSection(state, sec); // → force; two flat seeds at 1g
        // step the profile 1g → 2g by lifting the exit seed, so the leading tag actually shapes it.
        const pts = sectionForces(state, sec);
        const lead = pts[0];
        const tail = pts[1];
        setForcePoint(state, tail.id, tail.s, 2);

        setForceEase(state, lead.id, Easing.Ease);
        state.step(0);
        let out = bakeOut.get(eid);
        if (!out) throw new Error("bake missing");
        const easeF = Array.from(out.fN.subarray(0, Track.count.get(eid) - 1));
        const easeHash = out.hash;

        setForceEase(state, lead.id, Easing.Linear);
        state.step(0);
        out = bakeOut.get(eid);
        if (!out) throw new Error("bake missing");
        const linF = Array.from(out.fN.subarray(0, Track.count.get(eid) - 1));

        expect(out.hash).not.toBe(easeHash); // the ease tag is in the bake hash
        let maxDiff = 0;
        for (let i = 0; i < Math.min(easeF.length, linF.length); i++) {
            maxDiff = Math.max(maxDiff, Math.abs(easeF[i] - linF[i]));
        }
        expect(maxDiff).toBeGreaterThan(0.05); // the smoothstep vs chord shape reaches the recovery
    });

    test("an explicit force handle flows through the bake (forcePayload passes in/out)", () => {
        const { state, eid, sec } = track();
        state.step(0);
        convertSection(state, sec); // → force; two flat seeds
        const pts = sectionForces(state, sec);
        const lead = pts[0];
        const tail = pts[1];
        setForcePoint(state, tail.id, tail.s, 2); // a 1g → 2g step so the shape is visible
        state.step(0);
        let out = bakeOut.get(eid);
        if (!out) throw new Error("bake missing");
        const derivedF = Array.from(out.fN.subarray(0, Track.count.get(eid) - 1));

        // author an explicit out-handle on the leading keyframe that lifts g early — a shape
        // the derived flat tangent can't make, so the recovered force must move if in/out reach
        // forceProfile.
        setForceTangent(state, lead.id, {
            mode: TangentMode.Free,
            in: { ds: 0, dg: 0 },
            out: { ds: 6, dg: 0.75 },
        });
        state.step(0);
        out = bakeOut.get(eid);
        if (!out) throw new Error("bake missing");
        const handF = Array.from(out.fN.subarray(0, Track.count.get(eid) - 1));

        let maxDiff = 0;
        for (let i = 0; i < Math.min(derivedF.length, handF.length); i++) {
            maxDiff = Math.max(maxDiff, Math.abs(derivedF[i] - handF[i]));
        }
        expect(maxDiff).toBeGreaterThan(0.05);
    });

    test("history: appending a force section undoes/redoes byte-identical, seeds included", () => {
        const { state } = track();
        state.step(0);
        const h = createHistory();
        const before = snapshotAll(state);

        const f = appendSectionCmd(h, state, SectionKind.Force);
        expect(sectionForces(state, f).length).toBe(2); // the two seeds
        const seeded = snapshotAll(state);

        undo(h, state);
        expect(sections(state).length).toBe(before.length); // the section is gone
        expect(snapshotAll(state)).toEqual(before);

        redo(h, state);
        expect(snapshotAll(state)).toEqual(seeded); // seeds restored verbatim
    });

    test("history: setForceEase collapses to one entry; undo restores the prior tag", () => {
        const { state, sec } = track();
        state.step(0);
        convertSection(state, sec); // → force
        const id = createForcePoint(state, sec, 10, 1);
        const h = createHistory();
        expect(forceEase(state, id)).toBe(Easing.Ease); // the fresh-keyframe default

        setForceEaseCmd(h, state, id, Easing.Sharp);
        expect(h.undo.length).toBe(1);
        expect(forceEase(state, id)).toBe(Easing.Sharp);

        undo(h, state);
        expect(forceEase(state, id)).toBe(Easing.Ease);
        redo(h, state);
        expect(forceEase(state, id)).toBe(Easing.Sharp);

        // a no-op set (same tag) records nothing.
        setForceEaseCmd(h, state, id, Easing.Sharp);
        expect(h.undo.length).toBe(1);
    });

    test("history: a handle drag (beginForceTangent) collapses to one entry; undo clears the handles", () => {
        const { state, sec } = track();
        state.step(0);
        convertSection(state, sec); // → force
        const id = createForcePoint(state, sec, 10, 1);
        const h = createHistory();
        expect(forceTangent(state, id)).toBeUndefined(); // derives from ease

        beginForceTangent(state, id);
        setForceTangent(state, id, {
            mode: TangentMode.Aligned,
            in: { ds: -1, dg: 0 },
            out: { ds: 4, dg: 0.25 },
        }); // live preview frames
        setForceTangent(state, id, {
            mode: TangentMode.Aligned,
            in: { ds: -1, dg: 0 },
            out: { ds: 5, dg: 0.5 },
        });
        commit(h);
        expect(h.undo.length).toBe(1); // the whole drag → one entry
        expect(forceTangent(state, id)?.out).toEqual({ ds: 5, dg: 0.5 });

        undo(h, state);
        expect(forceTangent(state, id)).toBeUndefined(); // back to the ease-derived default

        // resetForceTangent clears authored handles back to the ease-derived default.
        const tan: ForceTangent = {
            mode: TangentMode.Free,
            in: { ds: -2, dg: 0.25 },
            out: { ds: 2, dg: -0.25 },
        };
        setForceTangent(state, id, tan);
        resetForceTangent(state, id);
        expect(forceTangent(state, id)).toBeUndefined();
        setForceTangent(state, id, tan); // restore for the round-trip assertion
        expect(forceTangent(state, id)).toEqual(tan);
    });
});
