import { beforeEach, describe, expect, test } from "bun:test";
import { State } from "@dylanebert/shallot";
import {
    addNode,
    appendSection,
    authoredHash,
    BakeSystem,
    bakeLive,
    bakeOut,
    convertSection,
    createForcePoint,
    createSection,
    createStrip,
    createStripKeyframe,
    createTrack,
    destroyStrip,
    edgeStrips,
    restoreStrip,
    sectionStrips,
    spawnStrip,
    Strip,
    stripAt,
    stripMinExtentAt,
    stripOverlapped,
    stripState,
    stripKeyframeState,
    stripKeyframes,
    setStrip,
    stripsForStep,
    setBakeFreeze,
    setBakeLanding,
    deleteSection,
    DS_NOMINAL,
    EXTEND_DIST,
    exitWorld,
    extend,
    forceBake,
    forceEase,
    forceMarkers,
    forcePointState,
    forceSample,
    type ForceTangent,
    forceTangent,
    Handle,
    handleAt,
    handleTangent,
    joinNext,
    MAX_FIT_EDGES,
    MAX_SAMPLES,
    MIN_FORCE_LEN,
    nextForce,
    readProvenance,
    reheadOnDrag,
    removeTrailingHandle,
    nodeSnapshot,
    resetNode,
    resetSection,
    resetTangent,
    sameNodes,
    restoreAll,
    restoreSection,
    samples,
    Section,
    sectionAt,
    SectionKind,
    sectionForces,
    sectionHandles,
    sectionInfo,
    sectionResettable,
    sections,
    sectionSolvable,
    sectionSpans,
    spawnForce,
    stationTaken,
    spanCoversOneEdge,
    splitForce,
    geoSplitStripsRefused,
    geoSplitAtStripsRefused,
    seedTangent,
    setForceEase,
    setForcePoint,
    setForceTangent,
    setSectionLength,
    setStickyLen,
    setTangent,
    setTrackDomain,
    setTrackFriction,
    setTrackResistance,
    setTrackV0,
    snapshotAll,
    snapshotSection,
    stampProvenance,
    stickyLen,
    toGlobal,
    toGlobalU,
    toLocal,
    toLocalU,
    Track,
    trackDomain,
    DEFAULT_FRICTION,
    DEFAULT_RESISTANCE,
    trackEditable,
    trackEntity,
    trackFriction,
    trackResistance,
    TrackPlugin,
    validCoefficient,
    validStripValue,
} from "../src/track";
import {
    appendSection as appendSectionCmd,
    beginForceMove,
    beginForceTangent,
    beginFriction,
    beginResistance,
    commit,
    createHistory,
    extendTrack as extendTrackCmd,
    materializeCustom,
    redo,
    setForcesEase,
    setForceTangentMode as setForceTangentModeCmd,
    splitSection,
    trimTrack as trimTrackCmd,
    undo,
    addStripKeyframe,
} from "../src/history";
import { DEFAULT_G, Easing, resolveStep } from "../src/profile";
import { scenarios } from "../src/scenarios";
import { LENGTH_MIN } from "../src/magnet";
import { Domain, evalGeo } from "../src/section";
import { editTangent, type Node, sampleChain, type Tangent, TangentMode } from "../src/spline";
import { GOLDEN } from "./helpers/golden";

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

    test("deleting the tip keeps the promoted Auto node's frozen heading (stage 7b flip)", () => {
        // stage 7 pinned "an Auto promoted tip re-heads" — wrong by the revised lock:
        // an Auto node's theta is authored substrate state (set by its own move), so
        // a neighbor's delete touches nothing; the re-head list is own move + append only.
        const { state, sec } = track();
        addNode(state, sec, 40, 0); // nodes 0,1,2
        const h = sectionHandles(state, sec);
        // node 1 interior, off-axis, heading deliberately off the arc-rule fixpoint —
        // a re-head would land 2·atan2(8,16), visibly reshaping the surviving segment.
        Handle.pos.set(h[1], 16, 8);
        Handle.theta.set(h[1], 0.5);
        expect(removeTrailingHandle(state, sec)).toBe(true); // drop node 2 → node 1 is the tip
        expect(handleTangent(state, sec, 1)).toBeUndefined(); // still Auto
        expect(Handle.theta.get(h[1])).toBe(0.5); // frozen heading untouched
    });

    // ── promoted-tip reconciliation ──────────────────────────────────────────────
    // deleting the trailing node promotes an interior node to chain tip. authored
    // state is never implicitly destroyed, and a neighbor's delete is not the tip's
    // own move — promotion touches NOTHING (stage 7b): an EXPLICIT promoted tip keeps
    // its tangent whole, an AUTO one keeps its frozen `theta` (authored by its own
    // move, exactly as the tangent record is). the surviving segment holds
    // byte-identical either way; the re-head list is own move + append only.

    test("delete preserves the promoted tip's authored tangent, segment, and exit heading", () => {
        // author an explicit tangent on node 1 (both vectors), then delete node 2.
        // (a) node 1's tangent survives byte-identical, (b) the surviving segment
        // 0→1 bakes byte-identical to pre-delete, (c) the exit heading is the
        // authored out-vector's angle — the segment the user shaped never reshapes.
        const { state, eid, sec } = track();
        addNode(state, sec, 20, 5); // nodes 0(0,0) 1(EXTEND_DIST,0) 2(20,5)
        state.step(0);
        const seed = seedTangent(state, sec, 1, TangentMode.Free);
        if (!seed) throw new Error("seed");
        setTangent(state, sec, 1, editTangent(seed, "out", 8, 8)); // out toward 45°
        setTangent(state, sec, 1, {
            ...(handleTangent(state, sec, 1) as Tangent),
            inX: 9,
            inY: 2, // a distinct authored in-vector — the surviving segment's shape
        });
        state.step(0);
        const authored = handleTangent(state, sec, 1);
        if (!authored) throw new Error("tangent");
        const s = samples.get(eid);
        if (!s) throw new Error("samples");
        const node1 = handleAt(state, sec, 1) as number;
        const upto = Handle.sample.get(node1); // the surviving segment's sample prefix
        const preX = Array.from(s.posX.subarray(0, upto + 1));
        const preY = Array.from(s.posY.subarray(0, upto + 1));

        expect(removeTrailingHandle(state, sec)).toBe(true); // delete node 2 → node 1 is the tip
        state.step(0);
        // (a) the authored tangent survives byte-identical.
        expect(handleTangent(state, sec, 1)).toEqual(authored);
        // (b) the surviving segment's bake is byte-identical (no reshape).
        expect(Array.from(s.posX.subarray(0, upto + 1))).toEqual(preX);
        expect(Array.from(s.posY.subarray(0, upto + 1))).toEqual(preY);
        // (c) exit heading = the authored out-vector's angle (entry.theta = 0 here).
        expect(exitWorld(node1)).toBe(Math.atan2(authored.outY, authored.outX));
    });

    test("delete when the trailing tip itself carries a tangent keeps the promoted node whole", () => {
        // the deleted node's own tangent goes with it; the promoted explicit node
        // keeps its authored state untouched.
        const { state, sec } = track();
        addNode(state, sec, 20, 6); // 0,1,2
        state.step(0);
        const s1 = seedTangent(state, sec, 1, TangentMode.Aligned);
        const s2 = seedTangent(state, sec, 2, TangentMode.Free);
        if (!s1 || !s2) throw new Error("seed");
        setTangent(state, sec, 1, editTangent(s1, "out", 6, 5));
        setTangent(state, sec, 2, editTangent(s2, "in", -4, 3));
        state.step(0);
        const authored = handleTangent(state, sec, 1);
        expect(removeTrailingHandle(state, sec)).toBe(true);
        state.step(0);
        expect(handleTangent(state, sec, 1)).toEqual(authored);
    });

    test("deleting down to the two-node floor keeps every promoted tip's authored tangent", () => {
        const { state, sec } = track();
        addNode(state, sec, 20, 4);
        addNode(state, sec, 34, 10); // 0,1,2,3
        state.step(0);
        for (const order of [1, 2]) {
            const seed = seedTangent(state, sec, order, TangentMode.Aligned);
            if (!seed) throw new Error("seed");
            setTangent(state, sec, order, editTangent(seed, "out", 5, 4));
        }
        state.step(0);
        const t1 = handleTangent(state, sec, 1);
        const t2 = handleTangent(state, sec, 2);
        expect(removeTrailingHandle(state, sec)).toBe(true); // 3 → node 2 tip
        state.step(0);
        expect(handleTangent(state, sec, 2)).toEqual(t2);
        expect(removeTrailingHandle(state, sec)).toBe(true); // 2 → node 1 tip
        state.step(0);
        expect(handleTangent(state, sec, 1)).toEqual(t1);
        expect(removeTrailingHandle(state, sec)).toBe(false); // floor
        expect(sectionHandles(state, sec).length).toBe(2);
    });

    test("append after authoring the old tip, then delete, round-trips the tangent byte-identical", () => {
        // demotion (append makes the old tip interior) then re-promotion (delete)
        // is the identity on the authored tangent.
        const { state, sec } = track();
        state.step(0);
        const seed = seedTangent(state, sec, 1, TangentMode.Free);
        if (!seed) throw new Error("seed");
        setTangent(state, sec, 1, editTangent(seed, "out", 7, 6)); // author the tip (node 1)
        const authored = handleTangent(state, sec, 1);
        addNode(state, sec, 30, 8); // append node 2 → node 1 demotes to interior, keeps its tangent
        state.step(0);
        expect(handleTangent(state, sec, 1)).toEqual(authored); // interior authored state preserved
        expect(removeTrailingHandle(state, sec)).toBe(true); // delete node 2 → node 1 re-promoted
        state.step(0);
        expect(handleTangent(state, sec, 1)).toEqual(authored); // round-trip identity
    });

    test("delete preserves a polar-authored Auto tip's heading and surviving bake (no re-head)", () => {
        // an Auto node's `theta` is authored substrate state (set by its own polar
        // move), exactly as the tangent record is for an explicit node — a neighbor's
        // delete re-deriving it resets the surviving segment the same way. promotion
        // touches nothing; the re-head list is own move + append only.
        const { state, eid, sec } = track();
        const node1 = handleAt(state, sec, 1) as number;
        // author node 1's heading via its OWN move (the real tip-drag path: pos + re-head)
        Handle.pos.set(node1, 18, 9);
        reheadOnDrag(state, node1);
        const authored = Handle.theta.get(node1);
        addNode(state, sec, 34, 2); // append node 2 → node 1 demotes, heading frozen
        // an interior chord-frame move lands a raw pos write, no re-head — theta now
        // deliberately differs from what the arc rule would re-derive at this position.
        Handle.pos.set(node1, 16, 12);
        state.step(0);
        expect(Handle.theta.get(node1)).toBe(authored); // frozen through the interior move
        const s = samples.get(eid);
        if (!s) throw new Error("samples");
        const upto = Handle.sample.get(node1); // the surviving segment's sample prefix
        const preX = Array.from(s.posX.subarray(0, upto + 1));
        const preY = Array.from(s.posY.subarray(0, upto + 1));

        expect(removeTrailingHandle(state, sec)).toBe(true); // delete node 2 → node 1 is the tip
        state.step(0);
        // theta bit-identical: the promoted tip keeps its authored heading whole.
        expect(Handle.theta.get(node1)).toBe(authored);
        // the surviving segment's bake is byte-identical (no reshape).
        expect(Array.from(s.posX.subarray(0, upto + 1))).toEqual(preX);
        expect(Array.from(s.posY.subarray(0, upto + 1))).toEqual(preY);
        // the readout/append exit is the frozen heading — what the node displayed pre-delete.
        expect(exitWorld(node1)).toBe(authored);
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

    test("any op that respawns nodes resyncs the node→sample map (restore, convert, trim+extend)", () => {
        // respawning a node resets its `Handle.sample` to 0, and content that round-trips
        // within one frame hashes exactly like the live bake — so a hash-only gate skips
        // forever and every respawned node reads sample 0 (the whole track picks at the
        // origin). every node creator must force the next bake, not just the restore paths:
        // an op+undo pair, a geo→force→geo convert, and a trim+extend pairing all land here.
        const { state, eid, sec } = track();
        addNode(state, sec, 40, 4);
        state.step(0);
        const before = sectionHandles(state, sec).map((h) => Handle.sample.get(h));
        expect(before[before.length - 1]).toBeGreaterThan(0);

        const h = createHistory();
        // restoreSection path: extend + undo, no frame between.
        extendTrackCmd(h, state, sec);
        undo(h, state);
        state.step(0);
        expect(sectionHandles(state, sec).map((n) => Handle.sample.get(n))).toEqual(before);

        // restoreAll path: append a section + undo, no frame between.
        appendSectionCmd(h, state, SectionKind.Geo);
        undo(h, state);
        state.step(0);
        expect(sectionHandles(state, sec).map((n) => Handle.sample.get(n))).toEqual(before);

        // and the samples the map points at are still the baked node positions.
        const s = samples.get(eid);
        if (!s) throw new Error("samples missing");
        for (const n of sectionHandles(state, sec)) {
            const i = Handle.sample.get(n);
            expect(s.posX[i]).toBeCloseTo(Handle.pos.x.get(n), 4);
            expect(s.posY[i]).toBeCloseTo(Handle.pos.y.get(n), 4);
        }

        // convertSection path: geo→force→geo with no frame between rebuilds the IDENTICAL
        // flat seed, so the round-tripped hash matches the live one.
        const flat = track();
        flat.state.step(0);
        const seeded = sectionHandles(flat.state, flat.sec).map((h) => Handle.sample.get(h));
        expect(seeded[seeded.length - 1]).toBeGreaterThan(0);
        convertSection(flat.state, flat.sec); // geo → force (the nodes are destroyed)
        convertSection(flat.state, flat.sec); // force → geo (respawned as the same flat seed)
        flat.state.step(0);
        expect(sectionHandles(flat.state, flat.sec).map((h) => Handle.sample.get(h))).toEqual(
            seeded,
        );

        // forward pairing (no undo involved): trim the tip and extend it straight back inside
        // one frame — Del-then-Enter, key-repeat reachable — and the chain is identical again.
        const grown = track();
        extend(grown.state, grown.sec);
        grown.state.step(0);
        const tip = sectionHandles(grown.state, grown.sec).map((h) => Handle.sample.get(h));
        expect(tip[tip.length - 1]).toBeGreaterThan(0);
        const h2 = createHistory();
        trimTrackCmd(h2, grown.state, grown.sec);
        extendTrackCmd(h2, grown.state, grown.sec);
        grown.state.step(0);
        expect(sectionHandles(grown.state, grown.sec).map((h) => Handle.sample.get(h))).toEqual(
            tip,
        );
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

    // one property, one station — the invariant AE/Premiere/Unity all hold, and the one
    // `chartCreate`'s snap pool already read ("an occupied s is degenerate") while the write path
    // let a drag land right on top. Two keys at one station span a zero-width segment that
    // `profile.segment` resolves as a vertical step, and their diamonds draw at one point so only
    // the later-painted one is clickable.
    describe("one station, one keyframe", () => {
        /** a force section carrying keys at the given stations. */
        function forceTrack(stations: readonly number[]): {
            state: State;
            sec: number;
            ids: number[];
        } {
            const state = new State();
            state.addSystem(BakeSystem);
            createTrack(state);
            const sec = createSection(state, 0, SectionKind.Force, 20);
            const ids = stations.map((s) => createForcePoint(state, sec, s, 1));
            state.step(0);
            return { state, sec, ids };
        }

        test("stationTaken is self-excluding and exact on the value the store will hold", () => {
            const { state, sec, ids } = forceTrack([5, 10]);
            expect(stationTaken(state, sec, 10, ids[0])).toBe(true); // the neighbour's station
            expect(stationTaken(state, sec, 5, ids[0])).toBe(false); // its own — never a collision
            expect(stationTaken(state, sec, 7, ids[0])).toBe(false); // free
            // `Force.s` is f32, so a candidate that would ROUND onto the neighbour's stored
            // station is that station once written — the comparison runs at the stored width.
            expect(stationTaken(state, sec, Math.fround(10) + 1e-9, ids[0])).toBe(true);
        });

        test("setForcePoint refuses a taken station and still lands the g write", () => {
            const { state, sec, ids } = forceTrack([5, 10]);
            setForcePoint(state, ids[0], 10, 2.5); // drag key 0 onto key 1's station
            const rows = sectionForces(state, sec);
            const moved = rows.find((r) => r.id === ids[0]);
            if (!moved) throw new Error("key missing");
            expect(moved.s).toBe(5); // s held: the slot is occupied
            expect(moved.g).toBe(2.5); // g still landed — a diagonal drag isn't frozen by it
            expect(new Set(rows.map((r) => r.s)).size).toBe(rows.length); // stations stay distinct
        });

        test("a drag passes THROUGH an occupied station rather than stopping at it", () => {
            const { state, sec, ids } = forceTrack([5, 10]);
            // the frames of one continuous drag of key 0 rightward across key 1
            for (const s of [8, 9, 10, 11, 12]) setForcePoint(state, ids[0], s, 1);
            const moved = sectionForces(state, sec).find((r) => r.id === ids[0]);
            expect(moved?.s).toBe(12); // landed past it; only the s = 10 frame was refused
        });

        test("two sections may share a station — that pair is what a cut plants", () => {
            const state = new State();
            state.addSystem(BakeSystem);
            createTrack(state);
            const a = createSection(state, 0, SectionKind.Force, 20);
            const b = createSection(state, 1, SectionKind.Force, 20);
            const ka = createForcePoint(state, a, 20, 1); // a's tail
            const kb = createForcePoint(state, b, 0, 1); // b's head, the same track station
            state.step(0);
            // section-scoped, so neither sees the other; a track-global check would refuse the
            // document's own structural op.
            expect(stationTaken(state, a, 20, ka)).toBe(false);
            expect(stationTaken(state, b, 0, kb)).toBe(false);
            setForcePoint(state, kb, 0, 3); // and the write still lands
            expect(sectionForces(state, b).find((r) => r.id === kb)?.g).toBe(3);
        });

        test("the restore path bypasses the guard — a coincident pair round-trips undo", () => {
            // a document that already holds a coincident pair (authored before this guard, or
            // planted by a structural op) must restore byte-identical, not be silently repaired
            // mid-history. `spawnForce`/`restoreForcePoint` are the restore writers.
            const { state, sec } = forceTrack([5]);
            spawnForce(state, sec, 999, 5, 4); // exactly on the existing key (id supplied)
            state.step(0);
            const rows = sectionForces(state, sec);
            expect(rows.length).toBe(2);
            expect(rows.filter((r) => r.s === 5).length).toBe(2);
            expect(rows.find((r) => r.id === 999)?.g).toBe(4);
        });
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

    test("dragging the node before the last preserves the tip's heading — no swing", () => {
        const { state, sec } = track();
        addNode(state, sec, 40, 0); // nodes 0,1,2 — node 2 is last, node 1 is before it
        const h = sectionHandles(state, sec);
        expect(Handle.theta.get(h[2])).toBe(0); // last starts flat
        Handle.pos.set(h[1], 16, 8); // drag the node *before* the last
        reheadOnDrag(state, h[1]);
        // node 1 stays frozen; the tip's own heading is untouched by a neighbor's move — the
        // interior-node move only re-heads on ITS own move (idx === last), never last − 1.
        expect(Handle.theta.get(h[1])).toBe(0);
        expect(Handle.theta.get(h[2])).toBe(0);
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

// what `BakeSystem` publishes when a chain overruns the flat SoA: the budget, never the would-be
// count — every consumer of the published count (the arc↔time table, `forceCurve`, the lens) reads
// indices that were never written otherwise.
describe("the sample budget", () => {
    test("a section past the budget leaves the published SoA finite, its own range outside it", () => {
        // `BakeSystem` publishes the BUDGET as the count, never a would-be one. Before
        // `kex2d-correctness-fixes` stage 2c, `chain` kept counting a force section's edges past
        // the buffer (its overflow writes silently dropped, a typed-array write past its length
        // being a no-op), so a section left outside carried a `sectionInfo` range whose start
        // ballooned arbitrarily far past `MAX_SAMPLES` — publishing the would-be count instead
        // would have handed every consumer indices that were never written: the arc↔time table,
        // `forceCurve`, and the chart's own axis total all read `undefined` and went NaN, which
        // unmounted the whole timeline. `chain` now clips the copy at the budget (stage 2c), so
        // the section left outside instead gets an EMPTY range clamped at the buffer's last
        // index (`start === end`, never a start past `MAX_SAMPLES`) — still zero baked samples,
        // still what a domain conversion rejects on (`tests/domain.test.ts`), just expressed as
        // an empty range rather than an out-of-range one.
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        const long = createSection(state, 0, SectionKind.Force, MAX_SAMPLES * DS_NOMINAL * 2);
        createForcePoint(state, long, 0, 1);
        const tail = createSection(state, 1, SectionKind.Force, 40);
        createForcePoint(state, tail, 0, 1);
        state.step(0);

        expect(Track.count.get(eid)).toBe(MAX_SAMPLES);
        const out = bakeOut.get(eid);
        const s = samples.get(eid);
        if (!out || !s) throw new Error("no bake");
        for (let i = 0; i < MAX_SAMPLES; i++) {
            expect(Number.isFinite(s.posX[i])).toBe(true);
            expect(Number.isFinite(out.t[i])).toBe(true);
        }
        expect(Number.isFinite(out.tTotal)).toBe(true);
        // the spans stay finite too — the lens is what the chart's axis total derives from.
        for (const sp of sectionSpans(state, eid))
            expect(Number.isFinite(sp.entryU + sp.lenU + sp.offset + sp.len)).toBe(true);
        // …and the tail section really is off the buffer, not merely short: an EMPTY range at
        // the buffer's last index, never a start past `MAX_SAMPLES`.
        const info = sectionInfo.get(tail);
        if (!info) throw new Error("no bake for the tail section");
        expect(info.startSample).toBe(info.endSample);
        expect(info.startSample).toBe(MAX_SAMPLES - 1);
    });

    // `forceBake` re-runs `evalForce` for the fit — geofit's own input, not the chain's — so the
    // same overflow has to reach IT too: a section that isn't fully off the buffer, but whose own
    // extent/step asks for more edges than the few samples left before `MAX_SAMPLES`, must clip
    // its dense profile to that remainder rather than handing the fit a longer shape nothing draws
    // (`forceBake`'s own why-comment, track.ts).
    test("forceBake clips the dense profile to the section's remaining sample budget", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);

        // section 0 eats nearly the whole buffer, leaving section 1 a narrow remainder.
        const n1 = MAX_SAMPLES - 50;
        const head = createSection(state, 0, SectionKind.Force, n1 * DS_NOMINAL);
        createForcePoint(state, head, 0, 2);
        createForcePoint(state, head, n1 * DS_NOMINAL, 0.5);

        // section 1 asks for far more edges (100) than the ~49 samples left in the buffer.
        const tailLen = 100 * DS_NOMINAL;
        const tail = createSection(state, 1, SectionKind.Force, tailLen);
        createForcePoint(state, tail, 0, 1.5);
        createForcePoint(state, tail, tailLen, 0.3);
        state.step(0);

        const info = sectionInfo.get(tail);
        if (!info) throw new Error("no bake for the tail section");
        const avail = Math.max(1, MAX_SAMPLES - 1 - info.startSample);
        expect(avail).toBeGreaterThan(0);
        expect(avail).toBeLessThan(100); // the request really does overrun the remaining budget

        const r = forceBake(state, tail);
        expect(r.edges).toBe(avail); // clipped to the remainder, not the requested 100

        const s = samples.get(eid);
        const out = bakeOut.get(eid);
        if (!s || !out) throw new Error("no bake");
        // positions are pure forward integration — causal, so a clipped re-eval matches the
        // published prefix exactly at every sample `chain` actually wrote.
        for (let k = 0; k <= avail; k++) {
            expect(r.x[k]).toBe(s.posX[info.startSample + k]);
            expect(r.y[k]).toBe(s.posY[info.startSample + k]);
        }
        // fN/ds match too, except the very last edge: `forces()` extrapolates the bisector at a
        // free end, and clipping the input makes that edge a free end where the full unclipped
        // bake (which keeps going past the buffer internally) would not — a real boundary effect,
        // not test noise.
        for (let k = 0; k < avail - 1; k++) {
            expect(r.fN[k]).toBe(out.fN[info.startSample + k]);
            expect(r.ds[k]).toBe(out.ds[info.startSample + k]);
        }
    });
});

// the lens's "native" pair (`entryU`/`lenU`, `toGlobalU`/`toLocalU`) retired the second,
// domain-varying axis it used to switch between arclength and march time (S6): a force
// keyframe's stored `s` is arclength always, so there is nothing left to address on a second
// axis. `entryU`/`lenU`/`toGlobalU`/`toLocalU` are `offset`/`len`/`toGlobal`/`toLocal` now,
// regardless of `Track.domain` — a Time-domain DISPLAY projection is a separate seam
// (`timeline.ts`'s `dToU`/`uToD`), never a second address space here.
describe("coordinate lens — the native pair is the arclength pair (S6)", () => {
    /** geo (flat) then a force section with an interior keyframe, on a track in `domain`. */
    function chain(domain: Domain): { state: State; eid: number; g: number; f: number } {
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        setTrackDomain(state, domain);
        const g = createSection(state, 0, SectionKind.Geo, 0);
        addNode(state, g, 0, 0);
        addNode(state, g, EXTEND_DIST, 0);
        const f = appendSection(state, SectionKind.Force);
        createForcePoint(state, f, 10, 1.2); // 10 m into a 24 m section, strictly interior
        state.step(0);
        return { state, eid, g, f };
    }

    for (const domain of [Domain.Distance, Domain.Time] as const) {
        test(`${Domain[domain]}: entryU/lenU equal offset/len, number for number`, () => {
            const { state, eid, g, f } = chain(domain);
            const spans = sectionSpans(state, eid);
            expect(spans.map((sp) => sp.id)).toEqual([g, f]);
            for (const sp of spans) {
                expect(sp.entryU).toBe(sp.offset);
                expect(sp.lenU).toBe(sp.len);
                const s = sp.len * 0.4;
                expect(toGlobalU(spans, sp.id, s)).toBe(toGlobal(spans, sp.id, s));
                const u = sp.offset + s;
                expect(toLocalU(spans, u)).toEqual(toLocal(spans, u));
            }
        });
    }

    test("no bake: the native pair is null, like its distance twin", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        setTrackDomain(state, Domain.Time);
        const f = createSection(state, 0, SectionKind.Force, 2);
        const spans = sectionSpans(state, eid); // no state.step: nothing baked
        expect(spans).toEqual([]);
        expect(toGlobalU(spans, f, 0.5)).toBeNull();
        expect(toLocalU(spans, 1)).toBeNull();
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

    // kex2d-idioms stage 9: node Reset means CREATION state, not tangent-clear — `resetNode`
    // re-creates: position = the continuation along the PREVIOUS node's exit heading at the
    // default chord `EXTEND_DIST` (never the session-sticky length), tangent cleared to Auto,
    // heading re-seeded by `addNode`'s own arc-rule reflection (shared body, so append and
    // Reset can't drift). node 0 keeps the tangent clear (position not authorable there).
    test("resetNode re-creates an interior node at the default-chord continuation, tangent Auto", () => {
        const { state, sec } = track();
        addNode(state, sec, 40, 15);
        addNode(state, sec, 70, 10); // orders [0, 1, 2, 3]; node 2 interior, node 3 the tip
        const n2 = handleAt(state, sec, 2);
        const n3 = handleAt(state, sec, 3);
        const prev = handleAt(state, sec, 1);
        if (n2 === null || n3 === null || prev === null) throw new Error("setup missing");
        const tipX = Handle.pos.x.get(n3);
        const tipTheta = Handle.theta.get(n3);

        // author node 2: move it off the chain and give it a Free corner.
        Handle.pos.set(n2, 33, 21);
        setTangent(state, sec, 2, { mode: TangentMode.Free, inX: 3, inY: 9, outX: 9, outY: -3 });

        resetNode(state, sec, 2);

        // position = EXTEND_DIST straight along node 1's exit (Auto → its stored heading).
        const th = Handle.theta.get(prev);
        expect(Handle.pos.x.get(n2)).toBeCloseTo(
            Handle.pos.x.get(prev) + Math.cos(th) * EXTEND_DIST,
            4,
        );
        expect(Handle.pos.y.get(n2)).toBeCloseTo(
            Handle.pos.y.get(prev) + Math.sin(th) * EXTEND_DIST,
            4,
        );
        // tangent cleared to live; heading = the creation seed (placed on the exit ray, the
        // reflection returns the exit heading exactly).
        expect(handleTangent(state, sec, 2)).toBeUndefined();
        expect(Handle.theta.get(n2)).toBeCloseTo(th, 6);
        // the neighbor's authored state is untouched — a reset never re-heads the tip (the
        // tip law: re-head is the tip's OWN move + append only).
        expect(Handle.pos.x.get(n3)).toBe(tipX);
        expect(Handle.theta.get(n3)).toBe(tipTheta);
    });

    test("resetting every shape node of a fresh first section lands the seed layout", () => {
        const { state, sec } = track(); // the seed: addNode(0,0) + addNode(EXTEND_DIST, 0)
        const seed = nodeSnapshot(state, sec);
        const n1 = handleAt(state, sec, 1);
        if (n1 === null) throw new Error("node missing");
        // author node 1: move it, swing its heading, stamp a tangent.
        Handle.pos.set(n1, 40, 18);
        Handle.theta.set(n1, 0.7);
        setTangent(state, sec, 1, { mode: TangentMode.Free, inX: 2, inY: 9, outX: 9, outY: -2 });

        resetNode(state, sec, 1);
        // byte-equivalent to the section-Reset geo seed (the two Resets agree by construction).
        expect(sameNodes(nodeSnapshot(state, sec), seed)).toBe(true);
    });

    test("resetNode on node 0 keeps the tangent clear — position isn't authorable there", () => {
        const { state, sec } = track();
        setTangent(state, sec, 0, { mode: TangentMode.Free, inX: 1, inY: 0, outX: 8, outY: 4 });
        resetNode(state, sec, 0);
        expect(handleTangent(state, sec, 0)).toBeUndefined();
        const n0 = handleAt(state, sec, 0);
        if (n0 === null) throw new Error("node missing");
        expect(Handle.pos.x.get(n0)).toBe(0); // the pinned entry never moves
        expect(Handle.pos.y.get(n0)).toBe(0);
        expect(Handle.theta.get(n0)).toBe(0);
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
    // `mu`/`c` are in the literal because `bakeHash` folds the
    // coefficients in unconditionally, beside `v0`. `createTrack` (this fixture's own builder)
    // stays at the kernel's neutral 0/0 — `DEFAULT_FRICTION`/`DEFAULT_RESISTANCE` are `seed`'s
    // (the app-boot document, not this raw ECS entity) — so the literal grows the `mu0c0`
    // segment and nothing else.
    test("the default flat track bakes to the pinned hash (no node-0 tangents = byte-identical)", () => {
        const { state, eid } = track(); // node 0 (0,0), node 1 (EXTEND_DIST=24, 0); default ds/v0
        state.step(0);
        const hash = (bakeOut.get(eid)?.hash ?? "").replace(/\|S\d+:/g, "|S:"); // drop the allocator id
        expect(hash).toBe("ds0.5v010mu0c0|S:0:0,0:0:0,24:0:0");
    });
});

// kex2d-provenance stage 1: the sidecar map + `stampProvenance`/`readProvenance`, and the
// `bakeHash`-factored content hash they share as the token. Stage 1 stamps nothing on its own
// (that's `history.solveForce`, `history.test.ts`) — this pins the store's own contract: stamp,
// read, invalidate on an edit or a domain flip, and never touch `bakeHash`/`authoredHash`.
describe("provenance sidecar (kex2d-provenance stage 1)", () => {
    test("a stamp round-trips: readProvenance returns the payload, token, and entry stamped", () => {
        const { state, sec } = track();
        state.step(0);
        const payload = snapshotSection(state, sec);
        stampProvenance(state, sec, payload);
        const got = readProvenance(sec);
        expect(got).toBeDefined();
        expect(got?.payload).toEqual(payload);
        expect(got?.token).toBe(readProvenance(sec)?.token); // deterministic re-read
        expect(got?.entry).toEqual(sectionInfo.get(sec)?.entry);
    });

    test("editing the section's own rows breaks the stamped token", () => {
        const { state, sec } = track();
        state.step(0);
        stampProvenance(state, sec, snapshotSection(state, sec));
        const stamped = readProvenance(sec)?.token;

        const tip = handleAt(state, sec, 1);
        if (tip === null) throw new Error("no tip");
        Handle.pos.x.set(tip, Handle.pos.x.get(tip) + 1);
        state.step(0);

        // re-stamping now reads the EDITED content — proves the earlier token no longer matches
        // what a live re-hash of the section produces (the reverse-invoke's own check, stage 2/3).
        stampProvenance(state, sec, snapshotSection(state, sec));
        expect(readProvenance(sec)?.token).not.toBe(stamped);
    });

    test("a Track.domain flip does NOT break the stamped token (S6: domain is a display lens)", () => {
        // `Track.domain` used to ride the token because a flip converted the section's own
        // stored numbers — a payload stamped in the old unit could otherwise restore verbatim
        // into a converted store. S6 retired that conversion entirely: a flip changes no
        // authored component, so the token must stay stable across one.
        const { state, sec } = track();
        state.step(0);
        stampProvenance(state, sec, snapshotSection(state, sec));
        const stamped = readProvenance(sec)?.token;

        setTrackDomain(state, Domain.Time);
        state.step(0);
        stampProvenance(state, sec, snapshotSection(state, sec));
        expect(readProvenance(sec)?.token).toBe(stamped);
    });

    test("stamping never touches bakeHash/authoredHash — no-churn", () => {
        const { state, eid, sec } = track();
        state.step(0);
        const before = bakeOut.get(eid)?.hash;
        const beforeAuthored = authoredHash(state);

        stampProvenance(state, sec, snapshotSection(state, sec));

        expect(bakeOut.get(eid)?.hash).toBe(before);
        expect(authoredHash(state)).toBe(beforeAuthored);
        state.step(0); // the gate must still SKIP — stamping alone never forces a re-bake
        expect(bakeOut.get(eid)?.hash).toBe(before);
    });

    test("an un-baked section (no sectionInfo entry) leaves stampProvenance a no-op", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        const sec = createSection(state, 0, SectionKind.Geo, 0); // no nodes, no bake ever ran
        stampProvenance(state, sec, {
            id: sec,
            order: 0,
            kind: SectionKind.Geo,
            length: 0,
            nodes: [],
            points: [],
            strips: [],
        });
        expect(readProvenance(sec)).toBeUndefined();
    });

    test("destroying a section evicts its stamp (deleteSection and joinNext)", () => {
        const { state } = track();
        const second = appendSection(state, SectionKind.Geo);
        if (second === null) throw new Error("append failed");
        state.step(0);
        stampProvenance(state, second, snapshotSection(state, second));
        expect(readProvenance(second)).toBeDefined();
        expect(deleteSection(state, second)).toBe(true);
        expect(readProvenance(second)).toBeUndefined();

        const third = appendSection(state, SectionKind.Geo);
        if (third === null) throw new Error("append failed");
        state.step(0);
        stampProvenance(state, third, snapshotSection(state, third));
        expect(joinNext(state, sections(state)[0].id)).toBe(true);
        expect(readProvenance(third)).toBeUndefined();
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
        setForceEase(state, id, Easing.Quintic);
        // f32-exact offsets (multiples of 1/4) so the round-trip is byte-identical, not just close.
        const tan: ForceTangent = {
            mode: TangentMode.Free,
            in: { ds: -2, dg: 0.25 },
            out: { ds: 3, dg: -0.5 },
        };
        setForceTangent(state, id, tan);

        const snap = snapshotAll(state);
        restoreAll(state, snap); // the structural-op undo unit must round-trip the new fields
        expect(forceEase(state, id)).toBe(Easing.Quintic);
        expect(forceTangent(state, id)).toEqual(tan);
        // a seed keyframe stays the default: Cubic tag, no handles.
        const seed = sectionForces(state, sec).find((p) => p.s === 0);
        if (!seed) throw new Error("seed missing");
        expect(forceEase(state, seed.id)).toBe(Easing.Cubic);
        expect(forceTangent(state, seed.id)).toBeUndefined();
    });

    test("a keyframe's ease flows through the bake (forcePayload): Cubic ≠ Linear, and busts the hash", () => {
        const { state, eid, sec } = track();
        state.step(0);
        convertSection(state, sec); // → force; two flat seeds at 1g
        // step the profile 1g → 2g by lifting the exit seed, so the leading tag actually shapes it.
        const pts = sectionForces(state, sec);
        const lead = pts[0];
        const tail = pts[1];
        setForcePoint(state, tail.id, tail.s, 2);

        setForceEase(state, lead.id, Easing.Cubic);
        state.step(0);
        let out = bakeOut.get(eid);
        if (!out) throw new Error("bake missing");
        const cubicF = Array.from(out.fN.subarray(0, Track.count.get(eid) - 1));
        const cubicHash = out.hash;

        setForceEase(state, lead.id, Easing.Linear);
        state.step(0);
        out = bakeOut.get(eid);
        if (!out) throw new Error("bake missing");
        const linF = Array.from(out.fN.subarray(0, Track.count.get(eid) - 1));

        expect(out.hash).not.toBe(cubicHash); // the ease tag is in the bake hash
        let maxDiff = 0;
        for (let i = 0; i < Math.min(cubicF.length, linF.length); i++) {
            maxDiff = Math.max(maxDiff, Math.abs(cubicF[i] - linF[i]));
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

    test("history: setForcesEase (size-1) collapses to one entry; undo restores the prior tag", () => {
        const { state, sec } = track();
        state.step(0);
        convertSection(state, sec); // → force
        const id = createForcePoint(state, sec, 10, 1);
        const h = createHistory();
        expect(forceEase(state, id)).toBe(Easing.Cubic); // the fresh-keyframe default

        setForcesEase(h, state, [id], Easing.Quintic);
        expect(h.undo.length).toBe(1);
        expect(forceEase(state, id)).toBe(Easing.Quintic);

        undo(h, state);
        expect(forceEase(state, id)).toBe(Easing.Cubic);
        redo(h, state);
        expect(forceEase(state, id)).toBe(Easing.Quintic);

        // a no-op set (same tag) records nothing.
        setForcesEase(h, state, [id], Easing.Quintic);
        expect(h.undo.length).toBe(1);
    });

    test("history: setForceTangentMode reconciles the pair, collapses to one entry, undoes byte-identical", () => {
        const { state, sec } = track();
        state.step(0);
        convertSection(state, sec); // → force
        const id = createForcePoint(state, sec, 10, 1);
        // a corner (Free): in flat along −s, out straight up — NOT collinear, so an Aligned switch
        // must actually reshape the pair (the reconcile is observable).
        const corner: ForceTangent = {
            mode: TangentMode.Free,
            in: { ds: -2, dg: 0 },
            out: { ds: 0, dg: 1 },
        };
        setForceTangent(state, id, corner);
        const h = createHistory();

        // isotropic scales (1 px/m, 1 px/g) keep the reconcile math in offset space for the assert.
        setForceTangentModeCmd(h, state, id, TangentMode.Aligned, 1, 1);
        expect(h.undo.length).toBe(1);
        const after = forceTangent(state, id);
        expect(after?.mode).toBe(TangentMode.Aligned);
        if (!after?.in || !after?.out) throw new Error("both sides must survive the reconcile");
        // Aligned ⟹ collinear: the in/out offsets now lie on one line through the keyframe.
        const cross = after.in.ds * after.out.dg - after.in.dg * after.out.ds;
        expect(cross).toBeCloseTo(0, 6);

        undo(h, state);
        expect(forceTangent(state, id)).toEqual(corner); // Free + the corner offsets restored exactly
        redo(h, state);
        expect(forceTangent(state, id)?.mode).toBe(TangentMode.Aligned);

        // re-picking the current mode is a no-op (the reconcile is idempotent) — records nothing.
        setForceTangentModeCmd(h, state, id, TangentMode.Aligned, 1, 1);
        expect(h.undo.length).toBe(1);
    });

    test("history: choosing a preset clears the addressed segment's bounding sides (out + next.in), one entry", () => {
        // a preset on the LEADING keyframe X addresses segment X→next: it clears X's OUT and the
        // next keyframe's IN (the segment's two bounding sides), never X's IN (the preceding
        // segment). one gesture over both keyframes; undo restores both byte-identical.
        const { state, sec } = track();
        state.step(0);
        convertSection(state, sec); // → force; seeds at s=0 and s=EXTEND_DIST
        const x = createForcePoint(state, sec, 10, 1); // a middle keyframe (prev=seed@0, next=seed@len)
        const next = nextForce(state, x);
        if (next === null) throw new Error("next keyframe missing");
        // X carries explicit handles on BOTH sides; the next keyframe holds BOTH sides too — the
        // clear must remove only its IN (the addressed segment's trailing side) and PRESERVE its
        // OUT + coupling mode (the seam the review flagged — per-side optional is the contract).
        const xTan: ForceTangent = {
            mode: TangentMode.Free,
            in: { ds: -1, dg: 0.25 },
            out: { ds: 1, dg: -0.25 },
        };
        setForceTangent(state, x, xTan);
        const nextTan: ForceTangent = {
            mode: TangentMode.Aligned,
            in: { ds: -2, dg: 0.5 },
            out: { ds: 2, dg: -0.5 },
        };
        setForceTangent(state, next, nextTan);
        const h = createHistory();

        setForcesEase(h, state, [x], Easing.Quintic);
        expect(h.undo.length).toBe(1);
        expect(forceEase(state, x)).toBe(Easing.Quintic);
        // X's OUT (the segment's leading side) is cleared; its IN (the preceding segment) survives.
        expect(forceTangent(state, x)).toEqual({
            mode: TangentMode.Free,
            in: { ds: -1, dg: 0.25 },
        });
        // the next keyframe's IN (the trailing side) is cleared; its OUT + mode survive (the seam).
        expect(forceTangent(state, next)).toEqual({
            mode: TangentMode.Aligned,
            out: { ds: 2, dg: -0.5 },
        });

        undo(h, state); // one entry restores BOTH keyframes
        expect(forceEase(state, x)).toBe(Easing.Cubic);
        expect(forceTangent(state, x)).toEqual(xTan);
        expect(forceTangent(state, next)).toEqual(nextTan);
        redo(h, state);
        expect(forceTangent(state, x)).toEqual({
            mode: TangentMode.Free,
            in: { ds: -1, dg: 0.25 },
        });
        expect(forceTangent(state, next)).toEqual({
            mode: TangentMode.Aligned,
            out: { ds: 2, dg: -0.5 },
        });
    });

    test("history: a preset leaves a keyframe's explicit in-handle from the preceding segment untouched (scenario a)", () => {
        // X carries an explicit IN (the preceding segment W→X is Custom through it) and no OUT.
        // a preset pick on X addresses segment X→next and must not disturb X's IN — the review's
        // "clobbered the preceding segment" failure. the keyframe-scoped clear wiped X entirely.
        const { state, sec } = track();
        state.step(0);
        convertSection(state, sec);
        const x = createForcePoint(state, sec, 10, 1);
        const xIn: ForceTangent = { mode: TangentMode.Free, in: { ds: -1.5, dg: 0.25 } };
        setForceTangent(state, x, xIn);
        const h = createHistory();

        setForcesEase(h, state, [x], Easing.Linear);
        expect(forceEase(state, x)).toBe(Easing.Linear);
        expect(forceTangent(state, x)).toEqual(xIn); // X.in survived; only X.out (already derived) was addressed
    });

    test("history: a preset clears the trailing in-handle when the segment is Custom solely through it (scenario b)", () => {
        // segment X→next is Custom ONLY through next's explicit IN (X.out is derived). a preset on
        // X — even the SAME tag X already carries — must clear that trailing in-side and record it
        // (the no-op guard covers the tag AND both bounding sides), so the segment's Custom
        // provenance unchecks. the keyframe-scoped clear left it checked-but-ineffective.
        const { state, sec } = track();
        state.step(0);
        convertSection(state, sec);
        const x = createForcePoint(state, sec, 10, 1);
        const next = nextForce(state, x);
        if (next === null) throw new Error("next keyframe missing");
        const nextIn: ForceTangent = { mode: TangentMode.Free, in: { ds: -2, dg: 0.5 } };
        setForceTangent(state, next, nextIn);
        const h = createHistory();
        expect(forceTangent(state, x)?.out).toBeUndefined(); // X.out derived
        expect(forceTangent(state, next)?.in).toBeDefined(); // provenance is the trailing in

        setForcesEase(h, state, [x], Easing.Cubic); // Cubic is X's current (default) tag — no tag change
        expect(h.undo.length).toBe(1); // records despite the unchanged tag: the trailing side changed
        expect(forceTangent(state, next)).toBeUndefined(); // Custom provenance gone

        undo(h, state);
        expect(forceTangent(state, next)).toEqual(nextIn); // restored in the same entry
    });

    test("history: materializeCustom seeds the segment's two bounding sides, one entry; undo clears both", () => {
        // choosing Custom on segment X→next materializes X's OUT + next's IN from the derived
        // shape (no jump), leaving X's IN and next's OUT alone. one gesture over both keyframes.
        const { state, sec } = track();
        state.step(0);
        convertSection(state, sec);
        const x = createForcePoint(state, sec, 10, 1);
        const next = nextForce(state, x);
        if (next === null) throw new Error("next keyframe missing");
        const h = createHistory();
        expect(forceTangent(state, x)).toBeUndefined();
        expect(forceTangent(state, next)).toBeUndefined();

        materializeCustom(h, state, x);
        expect(h.undo.length).toBe(1);
        // X's OUT materialized (the leading side), IN still derived (absent).
        expect(forceTangent(state, x)?.out).toBeDefined();
        expect(forceTangent(state, x)?.in).toBeUndefined();
        // next's IN materialized (the trailing side), OUT still derived (absent).
        expect(forceTangent(state, next)?.in).toBeDefined();
        expect(forceTangent(state, next)?.out).toBeUndefined();

        undo(h, state); // one entry clears both back to fully derived
        expect(forceTangent(state, x)).toBeUndefined();
        expect(forceTangent(state, next)).toBeUndefined();
    });

    test("history: materializeCustom stores Free when a preserved side is non-collinear with the seed", () => {
        // X carries an explicit OFF-FLAT in-handle (the preceding segment W→X is Custom through
        // it, its in-handle dragged off horizontal); X's out is still derived. materializing the
        // FOLLOWING segment X→next seeds X's out flat — non-collinear with the off-flat in. the
        // stored mode must be Free: Aligned ⟹ collinear, and re-aligning either side to force
        // collinearity would jump a handle.
        const { state, sec } = track();
        state.step(0);
        convertSection(state, sec); // → force; seeds @0 and @len
        const x = createForcePoint(state, sec, 10, 1);
        const next = nextForce(state, x);
        if (next === null) throw new Error("next keyframe missing");
        const xIn: ForceTangent = { mode: TangentMode.Aligned, in: { ds: -2, dg: 0.5 } };
        setForceTangent(state, x, xIn);
        const h = createHistory();

        materializeCustom(h, state, x); // materialize X→next; seeds X's out + next's in
        const tan = forceTangent(state, x);
        if (!tan) throw new Error("X tangent missing");
        expect(tan.mode).toBe(TangentMode.Free); // the seeded flat out ≠ collinear with the off-flat in
        expect(tan.in).toEqual({ ds: -2, dg: 0.5 }); // in unchanged — never re-aligned
        expect(tan.out?.dg).toBe(0); // out seeded flat (derived), not aligned to the in's slope
        expect(tan.out?.ds).toBeGreaterThan(0); // forward reach into the segment
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

        // a Free two-sided tangent round-trips through set/read, both sides preserved.
        const tan: ForceTangent = {
            mode: TangentMode.Free,
            in: { ds: -2, dg: 0.25 },
            out: { ds: 2, dg: -0.25 },
        };
        setForceTangent(state, id, tan);
        expect(forceTangent(state, id)).toEqual(tan);
    });

    test("history: a position drag (beginForceMove) preserves explicit handles through undo/redo (the same-vs-restore asymmetry)", () => {
        // beginForceMove's no-op guard (`same`) compares only s/g, but its restore writes the
        // FULL snapshot (s/g + ease + tangent) on undo/redo. a position drag must never touch
        // the handles, but the restore path could still clobber them as a side effect if the
        // snapshot/restore pair ever drifted — pin it explicitly (B-review).
        const { state, sec } = track();
        state.step(0);
        convertSection(state, sec); // → force
        const id = createForcePoint(state, sec, 10, 1);
        // f32-exact offsets (multiples of 1/4) so the round-trip is byte-identical, not just close.
        const tan: ForceTangent = {
            mode: TangentMode.Free,
            in: { ds: -1, dg: 0.25 },
            out: { ds: 1, dg: -0.25 },
        };
        setForceTangent(state, id, tan); // author explicit handles OUTSIDE the drag gesture
        const h = createHistory();

        beginForceMove(state, id);
        setForcePoint(state, id, 14, 1.5); // the live drag writes only s/g
        commit(h);
        expect(h.undo.length).toBe(1);
        expect(forcePointState(state, id)?.s).toBe(14);
        expect(forceTangent(state, id)).toEqual(tan); // the drag itself left the handles alone

        undo(h, state);
        expect(forcePointState(state, id)?.s).toBe(10); // position reverted
        expect(forceTangent(state, id)).toEqual(tan); // handles survived the undo

        redo(h, state);
        expect(forcePointState(state, id)?.s).toBe(14); // position re-applied
        expect(forceTangent(state, id)).toEqual(tan); // handles survived the redo
    });
});

// the per-section baking step is removed (kex2d-correctness-fixes stage 5): a solved
// section's step was always `resolveStep(length, nominal)` by construction, so it carried no
// information beyond the solve-time length. The one test worth keeping from the retired
// "per-section step" describe block is the nominal replay's own closing
// bound — every force section now bakes at the nominal quantum, and `profile.resolveStep`'s
// conforming rule (`edges = max(1, round(length/step))`, `ds = length/edges`) is what makes that
// replay close a solve's pinned exit exactly, not merely approximately.
test("the nominal replay closes a solve's pinned exit — the conforming rule (kex2d-section-extent stage 2)", () => {
    // the conversion tier's own oracle, at the document layer: replay a shipped conversion (the
    // frozen golden for loop-explicit) as an authored force section and measure where it lands
    // against the geo shape it was solved from.
    const scenario = scenarios.find((s) => s.name === "loop-explicit");
    if (!scenario) throw new Error("missing loop-explicit scenario");
    const solved = GOLDEN("loop-explicit");
    const target = evalGeo({ x: 0, y: 0, theta: 0, v: scenario.v0 }, scenario.nodes, scenario.ds);
    const pinned = { x: target.posX[target.edges], y: target.posY[target.edges] };

    const state = new State();
    state.addSystem(BakeSystem);
    const eid = createTrack(state);
    setTrackV0(eid, scenario.v0);
    const sec = createSection(state, 0, SectionKind.Force, solved.length);
    for (const p of solved.points) createForcePoint(state, sec, p.s, p.g);
    state.step(0);
    const s = samples.get(eid);
    if (!s) throw new Error("samples missing");
    const last = Track.count.get(eid) - 1;
    const nominal = { x: s.posX[last], y: s.posY[last] };

    const missNominal = Math.hypot(nominal.x - pinned.x, nominal.y - pinned.y);
    // the same 1e-3 m contract `refine.test.ts` holds the atom layer to (measured ~1.9e-5 m
    // through the f32 ECS columns).
    expect(missNominal).toBeLessThan(1e-3);
    // the residual an un-conformed march would have stopped short by, kept as evidence the
    // conforming rule is doing real work here, not passing vacuously on an already-round length.
    const shortfall = Math.abs(solved.length - solved.edges * DS_NOMINAL);
    expect(shortfall).toBeGreaterThan(0.2);
});

// `specs/kex2d-section-extent.md` stage 1 — red-first oracles for the extent-identity defect:
// `profile.forceProfile` bakes `edges = round(length/ds)` and marches exactly that many
// `ds`-sized steps, so the REALIZED extent (`sectionSpans`, a boundary keyframe's
// `toGlobalU`) is `edges·ds` while the AUTHORED extent (`Section.length`) is `length` — the
// two disagree by the rounding residual whenever `length` isn't a whole multiple of `ds`.
// Expected RED until stage 2 makes the bake conform to the authored length.
describe("section extent identity (kex2d-section-extent stage 1)", () => {
    /** a one-force-section track at `(length, ds)` — every section bakes at the TRACK's own
     *  nominal quantum (there is no per-section step, `kex2d-correctness-fixes` stage 5), so the
     *  sweep drives `Track.ds` directly rather than a per-section override. */
    function extentTrack(
        length: number,
        ds: number,
        points: readonly { s: number; g: number }[] = [],
    ): { state: State; eid: number; sec: number } {
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        Track.ds.set(eid, ds);
        const sec = createSection(state, 0, SectionKind.Force, length);
        for (const p of points) createForcePoint(state, sec, p.s, p.g);
        state.step(0);
        return { state, eid, sec };
    }

    /** the DISTANCE-domain f32-accumulation bound, DERIVED, never an absolute number
     *  (`coding.md` "Tolerance discipline"). `sectionSpans`'s `cum` accumulates in f64
     *  (`let cum = 0`) over `edges` copies of ONE narrowed-to-f32 per-edge `ds`
     *  (`resolveStep`'s `ds = length/edges`, `Float32Array.fill`ed once into the section's
     *  march, then read back — Distance's own step is uniform across the march). Each edge's
     *  rounding is the SAME f32 quantization of the same `ds`, so it doesn't accumulate
     *  independently: `edges · |fl32(ds) − ds| ≤ edges · 2^-24 · ds = 2^-24 · (edges·ds) ≈
     *  2^-24 · extent` — the `edges` factor cancels against `ds` rather than compounding it,
     *  unlike an independent per-edge rounding walk. Plus one more `2^-24 · extent` for
     *  `extent` itself: `Section.length`/`.ds` are `sparse(f32)` (`kex2d-map.md`), so the
     *  `length` this bound is measured against already differs from the f64 value the test
     *  authored it with by up to one f32 ulp before the bake even runs. Total: `2 · 2^-24 ·
     *  extent`, with NO `edges` factor — the previous `edges * 2 ** -24 * extent` was loose by
     *  up to `edges` (4096×), because it charged the single shared rounding once per edge
     *  instead of once total. Verified over the full ds × length sweep below (worst observed
     *  ratio to this bound ~0.49, so the derivation holds with margin, not just on average).
     *
     *  This bound is for `sectionSpans`'s Distance-native reading (`sp.len`, and `lenU` when
     *  `Track.domain` is `Distance` — both read off the same `cum`) ONLY. It does NOT cover
     *  `sp.lenU` in the `Time` domain, whose accumulation is a genuinely different recurrence
     *  (below, `marchTol`) — `sectionSpans` does not accumulate that reading the way this
     *  derivation describes, so installing this same bound there is wrong, not merely loose:
     *  measured up to ~47× this bound on the Time-domain sweep. */
    function accumTol(extent: number): number {
        return 2 * 2 ** -24 * extent;
    }

    /** the TIME-domain f32-accumulation bound. Unlike `accumTol` above, `sp.lenU` in `Time`
     *  reads `out.t` (`track.computeTime`), whose recurrence rounds the RUNNING sum itself at
     *  every step (`out.t[i+1] = out.t[i] + dt` written into a `Float32Array`, so each addition
     *  is rounded before the next reads it back) rather than summing `edges` copies of one
     *  pre-narrowed constant in f64. That is the textbook repeated-summation forward-error
     *  bound: `|computed − exact| ≲ (edges−1) · u · Σ|dt_i| ≈ edges · 2^-24 · extent` (`u` =
     *  f32 unit roundoff). The `edges` factor is genuinely load-bearing here — it doesn't cancel
     *  the way it does against `accumTol`'s single shared rounding, because every step both
     *  contributes a term AND re-rounds the accumulator carrying all the prior ones. Verified
     *  over the Time-domain sweep below (worst observed ratio to this bound ~0.23). */
    function _marchTol(edges: number, extent: number): number {
        return edges * 2 ** -24 * extent;
    }

    const dsList = [0.5, 0.25, 0.1, 0.05];
    const lengths = [12.345, 23.7, 8.13, 40.07, 5.555, 100.001, 2.222, 61.61, 3.9, 17.017];

    /** true when `length` happens to land exactly on `ds`'s grid — the sweep is about the
     *  off-grid case, so a coincidental on-grid pair is skipped rather than diluting it. */
    function onGrid(length: number, ds: number): boolean {
        const edges = Math.max(1, Math.round(length / ds));
        return Math.abs(length - edges * ds) < 1e-6;
    }

    test("a section's sectionSpans extent equals its authored length, off-grid lengths × ds", () => {
        for (const ds of dsList) {
            for (const length of lengths) {
                if (onGrid(length, ds)) continue;
                const { state, eid, sec } = extentTrack(length, ds);
                const spans = sectionSpans(state, eid);
                const sp = spans.find((x) => x.id === sec);
                if (!sp) throw new Error("section missing from spans");
                const tol = accumTol(length);
                expect(Math.abs(sp.len - length)).toBeLessThan(tol);
            }
        }
    });

    test("a boundary keyframe's toGlobalU equals the next section's entryU, off-grid cuts", () => {
        for (const ds of dsList) {
            for (const length of lengths) {
                if (onGrid(length, ds)) continue;
                const cut = length * 0.4137; // an off-grid interior split position
                const { state, eid, sec } = extentTrack(length, ds, [
                    { s: 0, g: 1 },
                    { s: length, g: 1 },
                ]);
                const tail = splitForce(state, sec, cut);
                if (tail === null) throw new Error("split refused");
                state.step(0);
                const spans = sectionSpans(state, eid);
                const headU = toGlobalU(spans, sec, cut);
                const tailEntryU = toGlobalU(spans, tail, 0);
                if (headU === null || tailEntryU === null) throw new Error("section off the bake");
                const tol = accumTol(length);
                expect(Math.abs(headU - tailEntryU)).toBeLessThan(tol);
            }
        }
    });

    test("the never-cut case: a section's own seed key at s = length shows the same gap", () => {
        for (const ds of dsList) {
            for (const length of lengths) {
                if (onGrid(length, ds)) continue;
                const { state, eid, sec } = extentTrack(length, ds, [
                    { s: 0, g: 1 },
                    { s: length, g: 1 }, // the section's own seed key at its authored end — no cut
                ]);
                const spans = sectionSpans(state, eid);
                const sp = spans.find((x) => x.id === sec);
                if (!sp) throw new Error("section missing from spans");
                // the authored end (`toGlobalU` at s = length, exact affine over `entryU`) vs
                // the section's own baked exit (`entryU + lenU`, the realized `edges·ds`) — the
                // same disagreement as the cut case, with no cut anywhere in the picture.
                const authoredEnd = toGlobalU(spans, sec, length);
                if (authoredEnd === null) throw new Error("section off the bake");
                const bakedExit = sp.entryU + sp.lenU;
                const tol = accumTol(length);
                expect(Math.abs(authoredEnd - bakedExit)).toBeLessThan(tol);
            }
        }
    });
});

// `Track.domain` (kex2d-time-domain stage 3) — the TRACK-GLOBAL unit every force section's
// keyframes and extent are stored in. The document layer holds it: authored on `Track`, in the
// bake hash only when it isn't the default `Distance` (so every existing track's hash is
// byte-identical), threaded to `evalForce`'s step rule, and paired with a per-domain sticky
// append length. The conversion op itself is `tests/domain.test.ts`.
describe("Track.domain (view lens, S6)", () => {
    test("defaults to Distance", () => {
        const { state } = track();
        expect(trackDomain(state)).toBe(Domain.Distance);
    });

    test("a flip is a pure view write: the bake hash never moves either direction", () => {
        // arclength is the one store (`Track.domain` is a lens over the live bake's s↔t table,
        // never a second march) — so unlike the retired document-conversion op, a domain flip
        // must NOT enter the bake hash. RED FIRST on the pre-S6 tree: the old bake hash suffixed
        // a non-Distance domain, so this assertion read `.not.toBe` there.
        const { state, eid, sec } = track();
        state.step(0);
        convertSection(state, sec); // → force
        state.step(0);
        const distanceHash = bakeOut.get(eid)?.hash;

        setTrackDomain(state, Domain.Time);
        state.step(0);
        expect(bakeOut.get(eid)?.hash).toBe(distanceHash);

        setTrackDomain(state, Domain.Distance);
        state.step(0);
        expect(bakeOut.get(eid)?.hash).toBe(distanceHash);
    });

    test("the extent trim floors at MIN_FORCE_LEN meters regardless of the active domain", () => {
        // storage is domain-invariant: `minForceExtent` still accepts a domain argument (the
        // Time-view snap floor still calls it), but no longer selects a seconds-native floor.
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        const sec = createSection(state, 0, SectionKind.Force, 40);
        setSectionLength(state, sec, 0.1);
        expect(extentOf(state, sec)).toBe(MIN_FORCE_LEN);

        setTrackDomain(state, Domain.Time);
        setSectionLength(state, sec, 0.01);
        expect(extentOf(state, sec)).toBe(MIN_FORCE_LEN); // same floor, same unit, as Distance
    });

    test("a destructive convert resets to the one default extent regardless of the active domain", () => {
        const { state, sec } = track();
        state.step(0);
        setTrackDomain(state, Domain.Time);
        convertSection(state, sec); // geo → force
        expect(extentOf(state, sec)).toBe(EXTEND_DIST);
        const seeds = sectionForces(state, sec).map((p) => p.s);
        expect(seeds[0]).toBe(0);
        expect(seeds[1]).toBe(EXTEND_DIST);
    });

    describe("sticky append length", () => {
        // module-level state in track.ts, shared across the whole run (not ECS, not undo) —
        // reset before each test here, mirroring `history.test.ts`'s convention, so no test in
        // this file or another can leak a committed value into the next.
        beforeEach(() => {
            setStickyLen(SectionKind.Force, EXTEND_DIST);
            setStickyLen(SectionKind.Geo, EXTEND_DIST);
        });

        test("force holds one scalar — a commit under either active domain reads back the same", () => {
            setStickyLen(SectionKind.Force, 40, Domain.Distance);
            expect(stickyLen(SectionKind.Force, Domain.Distance)).toBe(40);
            expect(stickyLen(SectionKind.Force, Domain.Time)).toBe(40);

            setStickyLen(SectionKind.Force, 3, Domain.Time);
            expect(stickyLen(SectionKind.Force, Domain.Time)).toBe(3);
            expect(stickyLen(SectionKind.Force, Domain.Distance)).toBe(3);
            setStickyLen(SectionKind.Force, EXTEND_DIST); // don't leak past the file
        });

        test("a degenerate commit floors at MIN_FORCE_LEN, regardless of the active domain", () => {
            setStickyLen(SectionKind.Force, 0.0001, Domain.Time);
            expect(stickyLen(SectionKind.Force)).toBe(MIN_FORCE_LEN);
            setStickyLen(SectionKind.Force, EXTEND_DIST); // don't leak past the file
        });

        test("a degenerate geo commit floors at LENGTH_MIN, its own gesture's floor", () => {
            setStickyLen(SectionKind.Geo, 0.001);
            expect(stickyLen(SectionKind.Geo)).toBe(LENGTH_MIN);
            setStickyLen(SectionKind.Geo, EXTEND_DIST); // module state: don't leak past the file
        });

        test("a geo append reads its one slot in either active domain", () => {
            setStickyLen(SectionKind.Geo, 17);
            const state = new State();
            state.addSystem(BakeSystem);
            createTrack(state);
            setTrackDomain(state, Domain.Time);
            const id = appendSection(state, SectionKind.Geo);
            const nodes = sectionHandles(state, id);
            expect(Handle.pos.x.get(nodes[1])).toBeCloseTo(17, 6);
            setStickyLen(SectionKind.Geo, EXTEND_DIST); // module state: don't leak past the file
        });
    });
});

/** a section's stored extent by id. */
function extentOf(state: State, id: number): number {
    const eid = sectionAt(state, id);
    if (eid === null) throw new Error("section missing");
    return Section.length.get(eid);
}

// ── the downstream freeze at the sample budget (kex2d-optimize-mode stage 7, review finding D) ──
// reachable only on a track ALREADY past MAX_SAMPLES (the truncation-degraded regime): when the
// live part consumes the whole budget, the frozen downstream part can't bake at all — and its
// PRIOR-bake sectionInfo must not stand (stale info lies; an empty past-buffer range degrades
// honestly, like any over-budget section).
test("freeze with no downstream budget publishes empty ranges, never stale prior-bake info", () => {
    const state = new State();
    state.addSystem(BakeSystem);
    const eid = createTrack(state);
    // a force section long enough to consume the whole sample budget on its own (edges =
    // length/ds = 2200/0.5 = 4400 > MAX_SAMPLES = 4096), plus a downstream section.
    const secA = createSection(state, 0, SectionKind.Force, 2200);
    createForcePoint(state, secA, 0, 1);
    createForcePoint(state, secA, 2200, 1);
    const secB = createSection(state, 1, SectionKind.Force, 30);
    createForcePoint(state, secB, 0, 1);
    createForcePoint(state, secB, 30, 1);
    state.step(0);
    const stale = sectionInfo.get(secB);
    if (!stale) throw new Error("no pre-freeze info");
    // post `kex2d-correctness-fixes` stage 2c, `chain` clips a force section's copy at the
    // buffer's end rather than ballooning `off` past `MAX_SAMPLES` — so the past-budget range is
    // an EMPTY one clamped at the buffer's last index, never a start past `MAX_SAMPLES`.
    expect(stale.startSample).toBe(stale.endSample);
    expect(stale.startSample).toBe(MAX_SAMPLES - 1);

    const entry = sectionInfo.get(secA)?.entry ?? { x: 0, y: 0, theta: 0, v: 10 };
    setBakeFreeze({ section: secA, entry: { ...entry } });
    const rows = sectionForces(state, secA);
    setForcePoint(state, rows[0].id, rows[0].s, rows[0].g + 0.2); // any in-mode edit → rebake
    state.step(0);

    // seen failing on 9f3dc41: the frozen bake skipped part B entirely and secB kept the
    // PRE-FREEZE values above. post-fix it reads as an empty range at the buffer end.
    const info = sectionInfo.get(secB);
    if (!info) throw new Error("no post-freeze info");
    const count = Track.count.get(eid);
    expect(info.startSample).toBe(count);
    expect(info.endSample).toBe(count);
    expect(info.bakedNodes).toBe(0);
    setBakeFreeze(null);
});

// kex2d-idioms stage 2: `resetSection` — the destructive reset to the section's OWN kind's
// default, factored out of `convertSection` (the shared `resetToForce`/`resetToGeo` bodies), so
// the seeds are the SAME code path and can't drift. parity is therefore asserted against what
// convertSection itself lands, never against re-stated constants.
describe("section reset (kex2d-idioms stage 2)", () => {
    test("geo reset holds the kind and lands the flat two-node seed — convertSection's own geo body", () => {
        const { state, sec } = track();
        addNode(state, sec, 40, 6); // shape it: a third off-axis node
        state.step(0);
        const shaped = snapshotSection(state, sec);

        // the reference: the geo seed a force→geo convert lands (the shared body's output).
        convertSection(state, sec); // geo → force
        convertSection(state, sec); // force → geo: the shared geo seed
        const refSeed = snapshotSection(state, sec);

        restoreSection(state, shaped); // back to the shaped chain, byte-identical
        resetSection(state, sec);
        const got = snapshotSection(state, sec);
        expect(got.kind).toBe(SectionKind.Geo);
        expect(got.nodes.length).toBe(2);
        expect(got).toEqual(refSeed);
    });

    test("force reset reseeds the continuation keyframes at the bake-recovered entry force — convertSection's own force body", () => {
        // a curved upstream section so the entry force is clearly ≠ DEFAULT_G.
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        const a = createSection(state, 0, SectionKind.Geo, 0);
        addNode(state, a, 0, 0);
        addNode(state, a, 20, -4);
        addNode(state, a, 44, -16);
        const b = appendSection(state, SectionKind.Geo);
        state.step(0);

        convertSection(state, b); // geo → force: the reference seed
        const seeded = snapshotSection(state, b);
        expect(Math.abs(seeded.points[0].g - DEFAULT_G)).toBeGreaterThan(0.05);

        // author the section away from the seed, then re-bake (the entry force is upstream's,
        // so it is unchanged by b's own edits).
        state.step(0);
        const pts = sectionForces(state, b);
        setForcePoint(state, pts[0].id, pts[0].s, 3);
        createForcePoint(state, b, 11, 2.5);
        setSectionLength(state, b, 77);
        state.step(0);

        resetSection(state, b);
        const got = snapshotSection(state, b);
        expect(got.kind).toBe(SectionKind.Force);
        // byte-identical to the convert's own seed modulo the minted stable ids.
        const strip = (s: typeof got) => ({
            ...s,
            points: s.points.map(({ id: _, ...rest }) => rest),
        });
        expect(strip(got)).toEqual(strip(seeded));
    });

    test("resetSection neither stamps nor consults the provenance sidecar", () => {
        const { state, sec } = track();
        state.step(0);
        convertSection(state, sec); // → force
        state.step(0);
        // author a distinctive profile and stamp it (as a solve landing would).
        const pts = sectionForces(state, sec);
        setForcePoint(state, pts[0].id, pts[0].s, 3);
        state.step(0);
        stampProvenance(state, sec, snapshotSection(state, sec));
        const token = readProvenance(sec)?.token;
        expect(token).toBeDefined();

        resetSection(state, sec);
        // not consulted: the result is the seed (entry-force continuation), not the stamped
        // 3g payload; not stamped/evicted: the sidecar entry is untouched.
        expect(sectionForces(state, sec).every((p) => p.g !== 3)).toBe(true);
        expect(readProvenance(sec)?.token).toBe(token as string);

        // a section with no stamp gains none from a reset.
        const t2 = track();
        t2.state.step(0);
        resetSection(t2.state, t2.sec);
        expect(readProvenance(t2.sec)).toBeUndefined();
    });

    test("sectionResettable: one geo section needs no bake; a force section needs a live one; sets gray", () => {
        expect(sectionResettable(1, SectionKind.Geo, false)).toBe(true);
        expect(sectionResettable(1, SectionKind.Geo, true)).toBe(true);
        expect(sectionResettable(1, SectionKind.Force, false)).toBe(false);
        expect(sectionResettable(1, SectionKind.Force, true)).toBe(true);
        expect(sectionResettable(2, SectionKind.Geo, true)).toBe(false);
        expect(sectionResettable(0, null, true)).toBe(false);
        expect(sectionResettable(1, null, true)).toBe(false);
    });
});

// the invoked solve enablement (`sectionSolvable`, pure/device-free), both directions: the row is
// live for exactly one section of the direction's own target kind with a live bake — `convertGeo`'s
// (geo→force) and `convertForce`'s (force→geo) own guards, which throw, so this is the gate and not
// a hint. Everything else grays.
describe("sectionSolvable — invoked-solve enablement", () => {
    test("one geo section with a live bake enables Convert to force (target Geo)", () => {
        expect(sectionSolvable(1, SectionKind.Geo, true, SectionKind.Geo)).toBe(true);
    });

    test("a stale bake disqualifies — `sectionInfo` describes a shape that isn't on screen", () => {
        expect(sectionSolvable(1, SectionKind.Geo, false, SectionKind.Geo)).toBe(false);
    });

    test("a force section disqualifies Convert to force — there is nothing to convert", () => {
        expect(sectionSolvable(1, SectionKind.Force, true, SectionKind.Geo)).toBe(false);
    });

    test("a multi-set and an empty selection both disqualify (no single subject)", () => {
        expect(sectionSolvable(2, SectionKind.Geo, true, SectionKind.Geo)).toBe(false);
        expect(sectionSolvable(0, null, true, SectionKind.Geo)).toBe(false);
    });

    test("one force section with a live bake enables Convert to geo (target Force)", () => {
        expect(sectionSolvable(1, SectionKind.Force, true, SectionKind.Force)).toBe(true);
    });

    test("a geo section disqualifies Convert to geo — there is no force curve to fit", () => {
        expect(sectionSolvable(1, SectionKind.Geo, true, SectionKind.Force)).toBe(false);
    });

    // the force→geo direction's own density guard (`MAX_FIT_EDGES`): a dense-enough bake refuses
    // at invoke rather than risk running past the modal's designed budget — the row grays, never
    // hides, exactly like the other disqualifiers above. `edges` defaults to 0, so every call
    // above (and every geo→force call, target `Geo`) is unaffected by this guard.
    test("edges at the ceiling still enables Convert to geo", () => {
        expect(sectionSolvable(1, SectionKind.Force, true, SectionKind.Force, MAX_FIT_EDGES)).toBe(
            true,
        );
    });

    test("one edge past the ceiling disqualifies Convert to geo", () => {
        expect(
            sectionSolvable(1, SectionKind.Force, true, SectionKind.Force, MAX_FIT_EDGES + 1),
        ).toBe(false);
    });

    test("edges is inert on the geo→force direction (target Geo) — that input is small authored nodes, not bake edges", () => {
        expect(
            sectionSolvable(1, SectionKind.Geo, true, SectionKind.Geo, MAX_FIT_EDGES + 1000),
        ).toBe(true);
    });
});

// ── viewport force markers (kex2d-idioms stage 3): the arclength→sample placement helper +
// the per-marker world projection the ForceDrawSystem/pickForce read. the helper walks the
// bake's OWN per-edge `ds` (S6: `forceSample` has one table now, no `time` branch), so the
// reference here is an INDEPENDENTLY-summed f64 station table built by the test, never the
// helper's own walk.
describe("forceSample", () => {
    // edges 3..6 of a synthetic bake: stations from the entry are 0, 2, 5, 5 (zero-length
    // edge — the freeze-gap / stall shape), 10.
    const ds = new Float32Array(10);
    ds[3] = 2;
    ds[4] = 3;
    ds[5] = 0;
    ds[6] = 5;
    const info = { startSample: 3, endSample: 7 };

    /** the station a returned address maps back to — the inverse the helper must satisfy. */
    const station = (addr: { index: number; frac: number }): number => {
        let cum = 0;
        for (let i = info.startSample; i < addr.index; i++) cum += ds[i];
        return cum + addr.frac * ds[addr.index];
    };

    test("distance: the address maps back to the clamped station, zero edges skipped", () => {
        // hand table: s=0 → the entry sample; s=1 → half of edge 3; s=6 → 1 m into edge 6.
        expect(forceSample({ ds }, info, 9, 0)).toEqual({ index: 3, frac: 0 });
        expect(forceSample({ ds }, info, 9, 1)).toEqual({ index: 3, frac: 0.5 });
        const at6 = forceSample({ ds }, info, 9, 6);
        expect(at6).not.toBeNull();
        expect(at6?.index).toBe(6); // past the zero edge, never ON it
        expect(station(at6 as { index: number; frac: number })).toBeCloseTo(6, 6);
        // landing exactly at the zero edge's station resolves finite (no divide-by-zero).
        const at5 = forceSample({ ds }, info, 9, 5);
        expect(at5).not.toBeNull();
        expect(Number.isFinite((at5 as { frac: number }).frac)).toBe(true);
        expect(station(at5 as { index: number; frac: number })).toBeCloseTo(5, 6);
    });

    test("distance: probes agree with an independently-summed f64 table", () => {
        // a pseudo-random positive table, f64-summed by the test (the reference oracle).
        const n = 40;
        const rds = new Float32Array(n);
        let seed = 42;
        for (let i = 5; i < 25; i++) {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            rds[i] = 0.25 + (seed % 1000) / 500;
        }
        const rinfo = { startSample: 5, endSample: 25 };
        const cum: number[] = [0]; // f64 stations, one per sample 5..25
        for (let i = 5; i < 25; i++) cum.push(cum[cum.length - 1] + rds[i]);
        const total = cum[cum.length - 1];
        for (let k = 0; k <= 20; k++) {
            const s = (k / 20) * total;
            const addr = forceSample({ ds: rds }, rinfo, n - 1, s);
            expect(addr).not.toBeNull();
            const a = addr as { index: number; frac: number };
            // the independent station of the returned address (f64 partial sums of the table).
            const st = cum[a.index - 5] + a.frac * rds[a.index];
            expect(st).toBeCloseTo(s, 4);
            // and the address brackets the reference table's own landing.
            expect(cum[a.index - 5]).toBeLessThanOrEqual(s + 1e-4);
            expect(cum[a.index - 5 + 1]).toBeGreaterThanOrEqual(s - 1e-4);
        }
    });

    test("distance: clamps at both ends", () => {
        expect(forceSample({ ds }, info, 9, -1)).toEqual({ index: 3, frac: 0 });
        expect(forceSample({ ds }, info, 9, 99)).toEqual({ index: 7, frac: 0 });
    });

    test("an empty published range (past the sample budget) yields null", () => {
        expect(forceSample({ ds }, { startSample: 8, endSample: 8 }, 9, 1)).toBeNull();
        // a range published past the buffer end too (the budget-less downstream shape).
        expect(forceSample({ ds }, { startSample: 12, endSample: 12 }, 9, 1)).toBeNull();
    });
});

describe("forceMarkers", () => {
    test("markers land on the baked track: seeds at the entry/exit samples exactly", () => {
        const { state, eid, sec } = track();
        state.step(0);
        convertSection(state, sec); // → force, two seed keyframes at (0, F) and (length, F)
        state.step(1 / 60);
        const s = samples.get(eid);
        const info = sectionInfo.get(sec);
        if (!s || !info) throw new Error("bake missing");
        const ms = forceMarkers(state);
        expect(ms.length).toBe(2);
        expect(ms[0].section).toBe(sec);
        expect(ms[0].x).toBeCloseTo(s.posX[info.startSample], 5);
        expect(ms[0].y).toBeCloseTo(s.posY[info.startSample], 5);
        expect(ms[1].x).toBeCloseTo(s.posX[info.endSample], 5);
        expect(ms[1].y).toBeCloseTo(s.posY[info.endSample], 5);
    });

    test("an interior marker sits at its independently-summed station on the polyline", () => {
        const { state, eid, sec } = track();
        state.step(0);
        convertSection(state, sec);
        state.step(1 / 60);
        const id = createForcePoint(state, sec, 7.3, 1.2);
        state.step(2 / 60);
        const s = samples.get(eid);
        const out = bakeOut.get(eid);
        const info = sectionInfo.get(sec);
        if (!s || !out || !info) throw new Error("bake missing");
        // the reference: f64-sum the bake's own per-edge ds to the bracketing edge.
        let cum = 0;
        let i = info.startSample;
        while (i < info.endSample && cum + out.ds[i] < 7.3) {
            cum += out.ds[i];
            i++;
        }
        const frac = (7.3 - cum) / out.ds[i];
        const rx = s.posX[i] + frac * (s.posX[i + 1] - s.posX[i]);
        const ry = s.posY[i] + frac * (s.posY[i + 1] - s.posY[i]);
        const m = forceMarkers(state).find((mk) => mk.id === id);
        expect(m).toBeDefined();
        expect(m?.x).toBeCloseTo(rx, 5);
        expect(m?.y).toBeCloseTo(ry, 5);
    });

    // (the dead-bake-range leg is `forceSample`'s own "empty published range" test above.)
    test("a geo section contributes no markers", () => {
        const { state } = track();
        state.step(0);
        expect(forceMarkers(state)).toEqual([]);
    });

    test("a key past the extent draws nothing; a key exactly AT it lands the exit sample", () => {
        const { state, eid, sec } = track();
        state.step(0);
        convertSection(state, sec);
        state.step(1 / 60);
        const row = sections(state).find((r) => r.id === sec);
        if (!row) throw new Error("section missing");
        const exitSeed = sectionForces(state, sec).reduce((a, b) => (b.s > a.s ? b : a));
        // a key trimmed past the extent has no track position (the non-destructive trim law:
        // re-lengthening restores it) — it must NOT clamp onto the exit seed's sample.
        const beyond = createForcePoint(state, sec, row.length + 2, 1.1);
        state.step(2 / 60);
        const ms = forceMarkers(state);
        expect(ms.some((m) => m.id === beyond)).toBe(false);
        // the exit seed sits exactly AT the extent (s === length): present, at the exit sample.
        const s = samples.get(eid);
        const info = sectionInfo.get(sec);
        if (!s || !info) throw new Error("bake missing");
        const exit = ms.find((m) => m.id === exitSeed.id);
        expect(exit).toBeDefined();
        expect(exit?.x).toBeCloseTo(s.posX[info.endSample], 5);
        expect(exit?.y).toBeCloseTo(s.posY[info.endSample], 5);
    });
});

// ── the landing display override at the bake seam (kex2d-idioms stage 4) ──────────
// while a paced landing runs, `forceDense` substitutes the landing's interpolated g for the
// landed section's keyframes and the downstream freeze holds at the session's frozen entry —
// display-level only, outside `bakeHash`, cleared byte-identically. the interpolant itself is
// `editor.landingG` (pinned in editor.test.ts); here the seam contract is pinned: what the
// override's g reads is EXACTLY what an authored g would bake, and clearing leaves no residue.
describe("landing display override (kex2d-idioms stage 4)", () => {
    /** one force section, the crest key clearly off 1 g — the single-section case, so the
     *  hold entry is inert (no downstream to seed) and profile identity is the whole claim. */
    function landedTrack(): { state: State; eid: number; sec: number } {
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        setTrackV0(eid, 20);
        const sec = createSection(state, 0, SectionKind.Force, 40);
        createForcePoint(state, sec, 0, 1);
        createForcePoint(state, sec, 20, 1.5);
        createForcePoint(state, sec, 40, 1);
        state.step(0);
        return { state, eid, sec };
    }

    /** the bake's live per-edge force, sliced to what was actually written. */
    function bakedF(eid: number): number[] {
        const out = bakeOut.get(eid);
        if (!out) throw new Error("no bake");
        return Array.from(out.fN.subarray(0, Track.count.get(eid) - 1));
    }

    const EntryHold = { x: 0, y: 0, theta: 0, v: 20 };

    test("the override's g bakes byte-identical to authoring that g; cleared, byte-identical to the document", () => {
        const { state, eid, sec } = landedTrack();
        const final = bakedF(eid);
        const crest = sectionForces(state, sec)[1];

        // the reference: the same document AUTHORED at the interpolated value — same profile
        // input, same code path, so the seam promises bit-identity (the derived-tolerance law:
        // the mechanism is substitution, so the bound is equality). authored in place and
        // reverted, never a twin State (the bake registries are module maps keyed by eid).
        setForcePoint(state, crest.id, crest.s, 1.2);
        state.step(0);
        const ref = bakedF(eid);
        setForcePoint(state, crest.id, crest.s, crest.g);
        state.step(0);
        expect(bakedF(eid)).toEqual(final); // the authoring round trip itself is clean

        setBakeLanding({
            section: sec,
            entry: EntryHold,
            g: (id) => (id === crest.id ? 1.2 : null),
        });
        state.step(0);
        expect(bakedF(eid)).toEqual(ref); // the interpolant IS the bake input
        expect(bakedF(eid)).not.toEqual(final); // positive control: the display moved

        setBakeLanding(null);
        state.step(0);
        expect(bakedF(eid)).toEqual(final); // cleared ⇒ byte-identical, no residue
    });

    test("an uncovered key (g → null) falls back to its authored value", () => {
        const { state, eid, sec } = landedTrack();
        const final = bakedF(eid);
        setBakeLanding({ section: sec, entry: EntryHold, g: () => null });
        state.step(0);
        expect(bakedF(eid)).toEqual(final); // full fallback = the document's own bake
        setBakeLanding(null);
    });

    test("per-frame invalidation: the interpolant moves while the authored hash stands still", () => {
        const { state, eid, sec } = landedTrack();
        const crest = sectionForces(state, sec)[1];
        let g = 1.5;
        setBakeLanding({
            section: sec,
            entry: EntryHold,
            g: (id) => (id === crest.id ? g : null),
        });
        state.step(0);
        const a = bakedF(eid);
        g = 1.1; // the next frame's interpolant — NO authored change, NO hash change
        state.step(0);
        const b = bakedF(eid);
        expect(b).not.toEqual(a); // the gate baked again anyway (the landing bypass)
        // …and it was the bypass, not a hash miss: the bake's hash matched the authored state
        // the whole time (the override lives outside `bakeHash` by design).
        expect(bakeOut.get(eid)?.hash).toBe(authoredHash(state));
        setBakeLanding(null);
    });

    test("bakeLive is false while the override is live (a contaminated bake is not authored truth)", () => {
        // the bake carries the interpolant but is stamped with the AUTHORED hash, so without the
        // landing consult `bakeLive` would certify a landing-contaminated bake as authored truth
        // for the whole window (consumers: forceBake, bakeEntryForce, enterPin, domain).
        const { state, sec } = landedTrack();
        const crest = sectionForces(state, sec)[1];
        expect(bakeLive(state)).toBe(true);
        setBakeLanding({
            section: sec,
            entry: EntryHold,
            g: (id) => (id === crest.id ? 1.2 : null),
        });
        expect(bakeLive(state)).toBe(false); // false immediately, before any re-bake mid-frame
        state.step(0);
        expect(bakeLive(state)).toBe(false); // …and stays false while the window runs
        setBakeLanding(null);
        state.step(0);
        expect(bakeLive(state)).toBe(true); // skip ⇒ the release re-bake certifies again
    });

    test("the hold: downstream seeds at the frozen entry (gap seam) and releases on clear", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        setTrackV0(eid, 20);
        const secA = createSection(state, 0, SectionKind.Force, 40);
        createForcePoint(state, secA, 0, 1);
        createForcePoint(state, secA, 20, 1.5);
        createForcePoint(state, secA, 40, 1);
        const secB = createSection(state, 1, SectionKind.Force, 30);
        createForcePoint(state, secB, 0, 1);
        createForcePoint(state, secB, 30, 1);
        state.step(0);
        const b0 = sectionInfo.get(secB);
        if (!b0) throw new Error("no pre-landing bake");
        const liveEntry = { ...b0.entry };
        const finalF = bakedF(eid);

        // a held entry visibly OFF the live exit, so the hold is observable (positive control).
        const held = { x: liveEntry.x + 4, y: liveEntry.y - 2, theta: 0.3, v: 15 };
        setBakeLanding({ section: secA, entry: held, g: () => null });
        state.step(0);
        const infoA = sectionInfo.get(secA);
        const infoB = sectionInfo.get(secB);
        if (!infoA || !infoB) throw new Error("no landing bake");
        expect(infoB.startSample).toBe(infoA.endSample + 1); // the two-part gap seam holds
        expect(infoB.entry.x).toBe(held.x); // …seeded at the frozen entry, bit-exact
        expect(infoB.entry.y).toBe(held.y);
        expect(infoB.entry.theta).toBe(held.theta);
        expect(infoB.entry.v).toBe(held.v);

        setBakeLanding(null);
        state.step(0);
        const infoA2 = sectionInfo.get(secA);
        const infoB2 = sectionInfo.get(secB);
        if (!infoA2 || !infoB2) throw new Error("no release bake");
        expect(infoB2.startSample).toBe(infoA2.endSample); // released: shared boundary again
        expect(infoB2.entry.x).toBe(liveEntry.x); // …and downstream back at the live exit
        expect(infoB2.entry.y).toBe(liveEntry.y);
        expect(bakedF(eid)).toEqual(finalF); // byte-identical to the pre-landing bake
    });
});

// `Track.friction`/`Track.resistance` threaded through the ECS +
// history layer — the `Track.v0` gesture pattern (`beginV0`), `bakeHash` coverage,
// absent-in-a-document restoring the kernel's own 0 (never the new-track authoring default),
// undo byte-identity, and the in-mode editing lockdown at the track-global sentinel.
describe("track friction/drag coefficients", () => {
    /** a lone flat force section, baked — mirrors `forceSection()` above (kept local: friction
     *  needs a section long enough, and with enough curvature-free ds, to show a measurable v
     *  drop). */
    function forceSection(): { state: State; eid: number; sec: number } {
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        const sec = createSection(state, 0, SectionKind.Force, 20);
        createForcePoint(state, sec, 0, 1);
        createForcePoint(state, sec, 20, 1);
        state.step(0);
        return { state, eid, sec };
    }

    test("createTrack seeds friction/resistance at the kernel's neutral 0 — every test fixture (and the raw ECS entity) stays byte-identical to before the coefficient existed", () => {
        const { eid } = forceSection();
        expect(Track.friction.get(eid)).toBe(0);
        expect(Track.resistance.get(eid)).toBe(0);
    });

    test("a NEW authored document (TrackPlugin's own seed) gets the physically-grounded nonzero defaults", async () => {
        const state = new State();
        await TrackPlugin.initialize?.(state);
        const eid = trackEntity(state);
        expect(eid).not.toBeNull();
        if (eid === null) throw new Error("no track");
        expect(Track.friction.get(eid)).toBe(DEFAULT_FRICTION);
        expect(Track.resistance.get(eid)).toBe(DEFAULT_RESISTANCE);
    });

    test("an absent-in-a-document Track restores friction/resistance to 0 (the kernel default), never the new-track authoring default", () => {
        // the document-load fallback (`shallot`'s scene codec: `merged = {...defaults(), ...fields}`)
        // reads `TrackPlugin.traits.Track.defaults()` for every field a saved document doesn't
        // carry — an old save predating this feature never authored friction/resistance, so it
        // must restore 0 (a byte-identical march), never `DEFAULT_FRICTION`/`DEFAULT_RESISTANCE`
        // (the NEW-track authoring default, `seed`'s alone). Mirrors `ds`'s own 0-vs-`DS_NOMINAL`
        // split already in this same trait record.
        const defaults = TrackPlugin.traits?.Track?.defaults?.();
        expect(defaults).toMatchObject({ friction: 0, resistance: 0 });
    });

    test("bakeHash moves on a coefficient change and holds otherwise", () => {
        const { state, eid } = forceSection();
        const before = bakeOut.get(eid)?.hash;
        if (!before) throw new Error("no bake");

        setTrackFriction(eid, 0.05);
        state.step(0);
        const withFriction = bakeOut.get(eid)?.hash;
        if (!withFriction) throw new Error("no bake");
        expect(withFriction).not.toBe(before); // authoring friction busts the hash

        state.step(0); // nothing authored changed since — the gate must SKIP
        expect(bakeOut.get(eid)?.hash).toBe(withFriction);

        setTrackResistance(eid, 0.001);
        state.step(0);
        const withResistance = bakeOut.get(eid)?.hash;
        expect(withResistance).not.toBe(withFriction); // a resistance change busts it again

        state.step(0); // nothing authored changed since — holds again
        expect(bakeOut.get(eid)?.hash).toBe(withResistance);
    });

    test("undo round-trips a friction edit byte-identical, redo lands it again", () => {
        // the fixture is a flat 1g force section (dθ = 0 throughout, so the RECOVERED F_n stays
        // cos θ = 1 regardless of v — friction never shows there for a straight span). Read the
        // sample v table instead, which friction directly reduces — the positive control that
        // proves the round trip actually moved something, not just the stored coefficient.
        const { state, eid } = forceSection();
        const v = () => Array.from(bakeOut.get(eid)?.v.subarray(0, Track.count.get(eid)) ?? []);
        const before = v();
        const h = createHistory();

        beginFriction(eid);
        setTrackFriction(eid, 0.1); // the live preview write a scrub would make
        commit(h);
        expect(h.undo.length).toBe(1);
        state.step(0);
        const withFriction = v();
        expect(withFriction[withFriction.length - 1]).toBeLessThan(before[before.length - 1]); // positive control

        undo(h, state);
        state.step(0);
        expect(v()).toEqual(before);
        expect(Track.friction.get(eid)).toBe(0);

        redo(h, state);
        state.step(0);
        expect(v()).toEqual(withFriction);
        expect(Track.friction.get(eid)).toBe(0.1);
    });

    test("undo round-trips a resistance edit byte-identical, redo lands it again", () => {
        const { state, eid } = forceSection();
        const h = createHistory();

        beginResistance(eid);
        setTrackResistance(eid, 0.002);
        commit(h);
        expect(h.undo.length).toBe(1);
        expect(Track.resistance.get(eid)).toBe(0.002);

        undo(h, state);
        expect(Track.resistance.get(eid)).toBe(0);

        redo(h, state);
        expect(Track.resistance.get(eid)).toBe(0.002);
    });

    test("a no-change gesture (scrub back to the same value) records nothing, for both coefficients", () => {
        const { eid } = forceSection();
        const h = createHistory();
        beginFriction(eid);
        setTrackFriction(eid, 0.05);
        setTrackFriction(eid, 0); // scrub back to the start
        commit(h);
        expect(h.undo.length).toBe(0);

        beginResistance(eid);
        setTrackResistance(eid, 0.001);
        setTrackResistance(eid, 0);
        commit(h);
        expect(h.undo.length).toBe(0);
    });

    test("trackFriction/trackResistance read 0 off an empty world — the kernel's own neutral default, not the authoring one", () => {
        const state = new State();
        expect(trackFriction(state)).toBe(0);
        expect(trackResistance(state)).toBe(0);
    });

    test("an in-pin-mode coefficient edit is refused at the track-global sentinel — the same per-subject rule sectionEditable applies elsewhere (trackEditable's own reading)", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        const a = createSection(state, 0, SectionKind.Force, 20);
        createForcePoint(state, a, 0, 1);
        createForcePoint(state, a, 20, 1);
        state.step(0);

        expect(trackEditable()).toBe(true);
        const entry = sectionInfo.get(a)?.entry ?? { x: 0, y: 0, theta: 0, v: 10 };
        setBakeFreeze({ section: a, entry: { ...entry } }); // simulates pin mode open on `a`
        expect(trackEditable()).toBe(false); // v0/friction/resistance are ALWAYS locked in-mode

        const h = createHistory();
        setTrackFriction(eid, 0.1); // the write-side belt
        expect(Track.friction.get(eid)).toBe(0);
        beginFriction(eid); // the gesture-open suspenders
        expect(h.undo.length).toBe(0);
        commit(h); // nothing was open — a no-op
        expect(h.undo.length).toBe(0);

        setTrackResistance(eid, 0.01);
        expect(Track.resistance.get(eid)).toBe(0);

        setBakeFreeze(null);
        expect(trackEditable()).toBe(true);
        setTrackFriction(eid, 0.1); // editable again once the mode closes
        expect(Track.friction.get(eid)).toBe(0.1);
    });
});

// the two coefficient FIELDS beside v0 in the START popover refuse a
// negative or NaN commit at the field, since `setTrackFriction`/`setTrackResistance` apply no
// floor of their own (the kernel takes `|fMag|` unvalidated) — `validCoefficient` is the shared
// predicate both fields' onchange handlers gate on before ever calling the setter.
describe("validCoefficient — the coefficient fields' negative/NaN refusal", () => {
    test("accepts zero and any positive finite value", () => {
        expect(validCoefficient(0)).toBe(true);
        expect(validCoefficient(0.021)).toBe(true);
        expect(validCoefficient(2.5e-4)).toBe(true);
        expect(validCoefficient(1e6)).toBe(true);
    });

    test("refuses negative values, however small", () => {
        expect(validCoefficient(-0.0001)).toBe(false);
        expect(validCoefficient(-1)).toBe(false);
    });

    test("refuses NaN and both infinities", () => {
        expect(validCoefficient(Number.NaN)).toBe(false);
        expect(validCoefficient(Number.POSITIVE_INFINITY)).toBe(false);
        expect(validCoefficient(Number.NEGATIVE_INFINITY)).toBe(false);
    });
});

// ── velocity strips (the section substrate's ECS layer) ────────────────────────
// the ECS layer for `section.Strip`: child entities on the `sectionForces` pattern
// (`kex2d-map.md`'s Velocity strips locked decision). `Strip` component + CRUD +
// the overlap guard are pure ECS reads/writes (mirrors `Force`'s own shape); the
// bake-time edge-index conversion (`edgeStrips`/`stripsForStep`) is the seam
// between the ECS's domain-coordinate storage and the kernel's edge addressing.
describe("velocity strips — ECS layer (C3)", () => {
    test("createStrip refuses an overlapping span; a non-overlapping write at the neighbour's boundary still lands", () => {
        // red before the guard existed: an overlapping createStrip silently succeeded, landing
        // a second strip whose interval intersected the first — verified by removing the
        // `stripOverlapped` check inline and observing both calls return non-null ids.
        const { state, sec } = track();
        convertSection(state, sec); // → force, default extent EXTEND_DIST = 24
        const a = createStrip(state, sec, 5, 15, 8);
        expect(a).not.toBeNull();
        // strictly overlaps [5, 15): refused, nothing written.
        expect(createStrip(state, sec, 10, 20, 6)).toBeNull();
        expect(sectionStrips(state, sec).length).toBe(1);
        // abuts at the boundary (starts exactly where the first ends): legal.
        const c = createStrip(state, sec, 15, 20, 6);
        expect(c).not.toBeNull();
        expect(sectionStrips(state, sec).length).toBe(2);
        // abuts on the other side too (ends exactly where the first starts): legal.
        const d = createStrip(state, sec, 0, 5, 4);
        expect(d).not.toBeNull();
        expect(sectionStrips(state, sec).length).toBe(3);
    });

    // GRANT direction, pinned first (`checks.md`: a fail-closed rewrite's own over-refusal
    // is invisible to every arm the rewrite adds, since those arms all pin refusals) —
    // every one of these must still land after the edge-convention fix below.
    test("grant direction: legitimate abutments and disjoint strips all still land", () => {
        const { state, sec } = track();
        convertSection(state, sec);
        const span = createStrip(state, sec, 5, 15, 8);
        expect(span).not.toBeNull();
        // a one-edge span abutting the span's OWN start: reaches backward to edge [4.5, 5),
        // the span claims [5, 15) — abutting, legal (the reverse boundary, verified genuinely
        // non-colliding — this direction must not break).
        expect(stripOverlapped(state, sec, 4.5, 5, -1)).toBe(false);
        const atStart = createStrip(state, sec, 4.5, 5, 1);
        expect(atStart).not.toBeNull();
        // two spans abutting (one starts exactly where the other ends): legal.
        const nextSpan = createStrip(state, sec, 15, 20, 6);
        expect(nextSpan).not.toBeNull();
        // a one-edge span past everything, and a genuinely disjoint span: both legal.
        const farEdge = createStrip(state, sec, 23.5, 24, 2);
        expect(farEdge).not.toBeNull();
        const disjointSpan = createStrip(state, sec, 20.5, 23, 3);
        expect(disjointSpan).not.toBeNull();
        expect(sectionStrips(state, sec).length).toBe(5);
    });

    test("a point strip strictly inside another strip overlaps; one at its START boundary does not, one at its END boundary does", () => {
        // red before the fix: `stripOverlapped` used the symmetric span formula for a point
        // candidate too, so a point at a span's END read `false` ("no overlap") even though
        // `stripOverride`'s kernel edge convention (`section.ts`) has the point claim exactly
        // the span's own last edge — the same edge, not merely an adjacent station. Witnessed
        // by reverting `stripEdgeRange`'s point branch to the plain `start`/`end` (the old
        // symmetric test): this line read `false` where it must read `true`.
        const { state, sec } = track();
        convertSection(state, sec);
        createStrip(state, sec, 5, 15, 8);
        expect(stripOverlapped(state, sec, 10, 10, -1)).toBe(true); // strictly interior point
        expect(stripOverlapped(state, sec, 5, 5, -1)).toBe(false); // at the start boundary — legal
        expect(stripOverlapped(state, sec, 15, 15, -1)).toBe(true); // at the end boundary — SAME edge, refused
        expect(stripOverlapped(state, sec, 20, 20, -1)).toBe(false); // free
    });

    test("createStrip refuses a point at a span's END boundary — the collision that used to land dead-on-arrival", () => {
        // red before the fix, reproduced end to end (not just at the guard): the point used
        // to be CREATED, then silently shadowed forever — `stripOverride`'s linear scan hits
        // the span first, so the point's authored value never took effect at bake time.
        const { state, sec } = track();
        convertSection(state, sec); // → force, default extent EXTEND_DIST = 24
        const span = createStrip(state, sec, 5, 15, 4);
        expect(span).not.toBeNull();
        const point = createStrip(state, sec, 15, 15, 99); // refused: same kernel edge as the span's end
        expect(point).toBeNull();
        expect(sectionStrips(state, sec).length).toBe(1);
    });

    test("createStrip refuses a zero-length span — the min-extent guard (points retire)", () => {
        // Points retire: the minimum extent is one overridden edge, so a
        // zero-length span collapses to `start === end` (both ends round to the same
        // edge boundary) and is refused by the min-extent guard in `createStrip` —
        // not by the overlap check. Two zero-length spans at the
        // same station are both refused, so no duplicate can land.
        const { state, sec } = track();
        convertSection(state, sec);
        const p1 = createStrip(state, sec, 10, 10, 1);
        expect(p1).toBeNull(); // refused: zero-length span covers no edge
        const p2 = createStrip(state, sec, 10, 10, 2);
        expect(p2).toBeNull(); // also refused
        expect(sectionStrips(state, sec).length).toBe(0);
    });

    test("setStrip refuses an overlapping move (keeps start/end) and still lands the value write; a non-colliding move lands both", () => {
        // red before the guard existed: setStrip unconditionally wrote start/end, so dragging
        // one strip onto another silently produced two overlapping ranges.
        const { state, sec } = track();
        convertSection(state, sec);
        const a = createStrip(state, sec, 0, 5, 4) as number;
        createStrip(state, sec, 10, 15, 8);
        setStrip(state, a, 8, 12, 9); // would overlap [10, 15)
        let row = sectionStrips(state, sec).find((r) => r.id === a);
        expect(row?.start).toBe(0); // refused — position unchanged
        expect(row?.end).toBe(5);
        expect(row?.value).toBe(9); // value still lands

        setStrip(state, a, 5.5, 9.5, 3); // clear of the neighbour
        row = sectionStrips(state, sec).find((r) => r.id === a);
        expect(row?.start).toBe(5.5);
        expect(row?.end).toBe(9.5);
        expect(row?.value).toBe(3);
    });

    test("stripOverlapped is self-excluding (a strip never collides with itself)", () => {
        const { state, sec } = track();
        convertSection(state, sec);
        const a = createStrip(state, sec, 5, 15, 8) as number;
        expect(stripOverlapped(state, sec, 5, 15, a)).toBe(false);
        expect(stripOverlapped(state, sec, 5, 15, -1)).toBe(true); // any OTHER caller collides
    });

    test("sectionStrips sorts by start; stripAt resolves by stable id", () => {
        const { state, sec } = track();
        convertSection(state, sec);
        const b = createStrip(state, sec, 10, 15, 1) as number;
        const a = createStrip(state, sec, 0, 5, 2) as number;
        const rows = sectionStrips(state, sec);
        expect(rows.map((r) => r.id)).toEqual([a, b]);
        expect(Strip.id.get(stripAt(state, a) as number)).toBe(a);
    });

    test("destroyStrip removes it; a stripState snapshot round-trips through restoreStrip byte-identical", () => {
        const { state, sec } = track();
        convertSection(state, sec);
        const id = createStrip(state, sec, 2, 6, 5) as number;
        const st = stripState(state, id);
        if (!st) throw new Error("no strip state");
        destroyStrip(state, id);
        expect(sectionStrips(state, sec).length).toBe(0);
        spawnStrip(state, st.section, st.id, st.start, st.end, st.value);
        expect(stripState(state, id)).toEqual(st);
        restoreStrip(state, { ...st, start: 3, end: 7, value: 9 });
        const after = stripState(state, id);
        expect(after?.start).toBe(3);
        expect(after?.end).toBe(7);
        expect(after?.value).toBe(9);
    });

    test("snapshotSection/restoreSection round-trip strips byte-identical", () => {
        const { state, sec } = track();
        convertSection(state, sec);
        createStrip(state, sec, 0, 5, 4);
        createStrip(state, sec, 10, 15, 8);
        const snap = snapshotSection(state, sec);
        expect(snap.strips.length).toBe(2);
        for (const st of sectionStrips(state, sec)) destroyStrip(state, st.id);
        expect(sectionStrips(state, sec).length).toBe(0);
        restoreSection(state, snap);
        const restored = sectionStrips(state, sec).map((r) => ({
            id: r.id,
            start: r.start,
            end: r.end,
            value: r.value,
        }));
        expect(restored).toEqual(
            snap.strips.map((s) => ({ id: s.id, start: s.start, end: s.end, value: s.value })),
        );
    });

    test("a strip participates in bakeHash/authoredHash — a value edit forces a re-bake", () => {
        // red before the hash included strips: `bakeOut.hash` stayed unchanged after
        // `setStrip`, so `bakeLive`-gated re-bakes never fired.
        const { state, eid, sec } = track();
        convertSection(state, sec);
        state.step(0);
        const id = createStrip(state, sec, 2, 6, 5) as number;
        state.step(0);
        const withStrip = bakeOut.get(eid)?.hash;
        setStrip(state, id, 2, 6, 9); // value edit only
        state.step(0);
        const afterEdit = bakeOut.get(eid)?.hash;
        expect(afterEdit).not.toBe(withStrip);
        // undoing the edit (byte-identical restore) reproduces the earlier hash exactly.
        restoreStrip(state, { section: sec, id, start: 2, end: 6, value: 5 });
        state.step(0);
        expect(bakeOut.get(eid)?.hash).toBe(withStrip);
    });

    test("edgeStrips resolves a station to its nearest edge boundary, both endpoints, an interior span", () => {
        // a uniform 10-edge grid at ds = 1 (edges 0..10, cum = [0,1,...,10]).
        const ds = new Float32Array(10).fill(1);
        const out = edgeStrips(ds, 10, [{ start: 3.4, end: 7.6, value: 5 }]);
        expect(out).toBeDefined();
        expect(out?.[0].start).toBe(3); // nearest boundary to 3.4
        expect(out?.[0].end).toBe(8); // nearest boundary to 7.6
        // a point resolves both its own start and end to the same boundary.
        const point = edgeStrips(ds, 10, [{ start: 5, end: 5, value: 1 }]);
        expect(point?.[0].start).toBe(5);
        expect(point?.[0].end).toBe(5);
        // out-of-range clamps to the section's own edges.
        const clamp = edgeStrips(ds, 10, [{ start: -3, end: 50, value: 1 }]);
        expect(clamp?.[0].start).toBe(0);
        expect(clamp?.[0].end).toBe(10);
        expect(edgeStrips(ds, 10, [])).toBeUndefined();
    });

    // ── the wrong-granularity headline: an INTERIOR-start, INTERIOR-end strip on a force
    // section, checked under both ruler domains — a strip's edge range is arclength-resolved
    // regardless of `Track.domain` (S6: the domain is a display lens, never a second march),
    // so the two arms must land on the identical edge range. A whole-section-spanning strip
    // would pass even a broken edge-index conversion, since a boundary landing at 0 or `edges`
    // is a degenerate case every off-by-one bug also gets right.
    for (const domain of [Domain.Distance, Domain.Time] as const) {
        test(`an interior force strip forces v to its stored value across its own edge range, ${Domain[domain]} domain`, () => {
            const state = new State();
            state.addSystem(BakeSystem);
            const eid = createTrack(state);
            setTrackDomain(state, domain);
            const length = 20; // meters, always — the active domain never changes storage
            const sec = createSection(state, 0, SectionKind.Force, length);
            // a non-flat authored profile — F_n = 1.3g curves the path, so v naturally
            // DIFFERS from the strip's stamped value; without the override it wouldn't hold.
            createForcePoint(state, sec, 0, 1.3);
            createForcePoint(state, sec, length, 1.3);
            const start = length * 0.25;
            const end = length * 0.75;
            const value = 4; // well off the entry speed (V0 = 10) and off the natural march
            createStrip(state, sec, start, end, value);
            state.step(0);

            const info = sectionInfo.get(sec);
            if (!info) throw new Error("no bake");
            const out = bakeOut.get(eid);
            if (!out) throw new Error("no bakeOut");
            const step = DS_NOMINAL;
            const startEdge = Math.round(start / step);
            const endEdge = Math.round(end / step);
            // an edge's override lands on the SAMPLE it exits into (edge k forces v at
            // sample k + 1) — `startEdge` itself is still the entering (natural) sample.
            for (let i = startEdge + 1; i <= endEdge; i++) {
                expect(out.v[info.startSample + i]).toBeCloseTo(value, 4);
            }
            // outside the strip (entry sample), v is NOT forced to `value` — the strip is
            // interior, not whole-section, so the natural march still governs there.
            expect(out.v[info.startSample]).not.toBeCloseTo(value, 2);
        });
    }

    test("an interior geo strip forces v to its stored value across its own edge range", () => {
        // geo's own axis is arclength — edge-index resolution runs through `geoChordDs`'s
        // fresh chord sample rather than a uniform step (the geo/force asymmetry this stage
        // has to bridge).
        const { state, eid, sec } = track(); // flat 2-node, length EXTEND_DIST = 24
        addNode(state, sec, EXTEND_DIST, 10); // a bend, off-axis — v would naturally curve
        const value = 3;
        createStrip(state, sec, 8, 16, value); // interior, well off both node endpoints
        state.step(0);
        const info = sectionInfo.get(sec);
        const out = bakeOut.get(eid);
        if (!info || !out) throw new Error("no bake");
        // walk the section's own baked samples and confirm every one inside [8, 16) reads
        // the strip's value — read off the section's own arclength via cumulative `out.ds`.
        let cum = 0;
        let sawInside = false;
        let sawOutside = false;
        for (let i = info.startSample; i < info.endSample; i++) {
            const mid = cum + out.ds[i] / 2;
            if (mid >= 8 && mid < 16) {
                expect(out.v[i + 1]).toBeCloseTo(value, 3);
                sawInside = true;
            } else if (mid < 6) {
                expect(out.v[i + 1]).not.toBeCloseTo(value, 1);
                sawOutside = true;
            }
            cum += out.ds[i];
        }
        expect(sawInside).toBe(true);
        expect(sawOutside).toBe(true);
    });

    test("stripsForStep resolves the section's own strips at an already-resolved Step, purely (no bake read)", () => {
        const { state, sec } = track();
        convertSection(state, sec); // → force, extent EXTEND_DIST
        createStrip(state, sec, 6, 18, 5);
        const step = { edges: 48, ds: EXTEND_DIST / 48 };
        const specs = stripsForStep(state, sec, step);
        expect(specs).toBeDefined();
        expect(specs?.[0].start).toBe(Math.round(6 / step.ds));
        expect(specs?.[0].end).toBe(Math.round(18 / step.ds));
        expect(specs?.[0].value).toBe(5);
    });

    // ── T2: value in the graph — keyframed velocity curves on strips ─────────────

    test("constant-when-no-keyframes: a strip with no keyframes holds v constant at its value", () => {
        // RED-FIRST WITNESS: before T2, `stripOverride` returned `value * value` for every
        // edge — this test pins that the constant path still holds when `values` is absent.
        // A strip with keyframes would evaluate a curve; without keyframes the constant
        // `value` is the After Effects stopwatch reading (no keyframes = one constant).
        const { state, eid, sec } = track();
        convertSection(state, sec);
        createForcePoint(state, sec, 0, 1.3);
        createForcePoint(state, sec, EXTEND_DIST, 1.3);
        const value = 4;
        createStrip(state, sec, 6, 18, value);
        state.step(0);
        const info = sectionInfo.get(sec);
        const out = bakeOut.get(eid);
        if (!info || !out) throw new Error("no bake");
        const step = DS_NOMINAL;
        const startEdge = Math.round(6 / step);
        const endEdge = Math.round(18 / step);
        for (let i = startEdge + 1; i <= endEdge; i++) {
            expect(out.v[info.startSample + i]).toBeCloseTo(value, 4);
        }
    });

    test("a strip with keyframes evaluates a velocity curve across its extent, Distance domain", () => {
        // The wrong-granularity headline arm for T2: an interior-start, interior-end strip
        // on a force section in the Distance domain, WITH keyframes — the curve is evaluated
        // per-edge from the keyframes on the force-curve machinery (profile.sampleForce).
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        const length = 20;
        const sec = createSection(state, 0, SectionKind.Force, length);
        createForcePoint(state, sec, 0, 1.3);
        createForcePoint(state, sec, length, 1.3);
        const start = 5;
        const end = 15;
        const stripId = createStrip(state, sec, start, end, 4) as number;
        // two keyframes: a ramp from 3 to 7 m/s across the strip
        createStripKeyframe(state, stripId, start, 3);
        createStripKeyframe(state, stripId, end, 7);
        state.step(0);
        const info = sectionInfo.get(sec);
        const out = bakeOut.get(eid);
        if (!info || !out) throw new Error("no bake");
        const step = DS_NOMINAL;
        const startEdge = Math.round(start / step);
        const endEdge = Math.round(end / step);
        // inside the strip, v should follow the keyframed curve, NOT the constant value
        // the curve ramps from 3 to 7; check endpoints match keyframe values and the
        // curve spans a range (not flat at the constant 4)
        expect(out.v[info.startSample + startEdge + 1]).toBeCloseTo(3, 0);
        expect(out.v[info.startSample + endEdge]).toBeCloseTo(7, 0);
        const interiorVs: number[] = [];
        for (let i = startEdge + 1; i <= endEdge; i++) {
            interiorVs.push(out.v[info.startSample + i]);
        }
        const minV = Math.min(...interiorVs);
        const maxV = Math.max(...interiorVs);
        expect(maxV - minV).toBeGreaterThan(2);
    });

    test("a strip with keyframes evaluates a velocity curve across its extent, Time-view track", () => {
        // The wrong-granularity headline arm for T2: an interior-start, interior-end strip
        // on a force section, checked with the ruler in the Time domain — a view lens only
        // (S6), so the underlying edge resolution is identical to the Distance arm above.
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        setTrackDomain(state, Domain.Time);
        const length = 20;
        const sec = createSection(state, 0, SectionKind.Force, length);
        createForcePoint(state, sec, 0, 1.3);
        createForcePoint(state, sec, length, 1.3);
        const start = 5;
        const end = 15;
        const stripId = createStrip(state, sec, start, end, 4) as number;
        createStripKeyframe(state, stripId, start, 3);
        createStripKeyframe(state, stripId, end, 7);
        state.step(0);
        const info = sectionInfo.get(sec);
        const out = bakeOut.get(eid);
        if (!info || !out) throw new Error("no bake");
        const step = DS_NOMINAL;
        const startEdge = Math.round(start / step);
        const endEdge = Math.round(end / step);
        // the curve ramps from 3 to 7; check that the endpoints match the keyframe values
        // and that the curve is NOT flat at the constant (it varies across the span)
        expect(out.v[info.startSample + startEdge + 1]).toBeCloseTo(3, 0);
        expect(out.v[info.startSample + endEdge]).toBeCloseTo(7, 0);
        // collect interior velocities and confirm they span a range (not flat at 4)
        const interiorVs: number[] = [];
        for (let i = startEdge + 1; i <= endEdge; i++) {
            interiorVs.push(out.v[info.startSample + i]);
        }
        const minV = Math.min(...interiorVs);
        const maxV = Math.max(...interiorVs);
        expect(maxV - minV).toBeGreaterThan(2); // the curve spans from ~3 to ~7
    });

    test("clip-to-extent: a keyframe placed outside the strip's extent is clamped to it", () => {
        const { state, sec } = track();
        convertSection(state, sec);
        const start = 6;
        const end = 18;
        const stripId = createStrip(state, sec, start, end, 4) as number;
        // a keyframe before the strip's start should be clamped to `start`
        const kfBefore = createStripKeyframe(state, stripId, 2, 3);
        const stBefore = stripKeyframeState(state, kfBefore);
        expect(stBefore?.s).toBe(start);
        // a keyframe after the strip's end should be clamped to `end`
        const kfAfter = createStripKeyframe(state, stripId, 30, 7);
        const stAfter = stripKeyframeState(state, kfAfter);
        expect(stAfter?.s).toBe(end);
        // a keyframe inside the strip stays put
        const kfInside = createStripKeyframe(state, stripId, 12, 5);
        const stInside = stripKeyframeState(state, kfInside);
        expect(stInside?.s).toBe(12);
    });

    test("strip keyframes round-trip through snapshotSection/restoreSection byte-identical", () => {
        const { state, sec } = track();
        convertSection(state, sec);
        const stripId = createStrip(state, sec, 4, 16, 5) as number;
        createStripKeyframe(state, stripId, 6, 3);
        createStripKeyframe(state, stripId, 14, 7);
        const snap = snapshotSection(state, sec);
        expect(snap.strips[0].keyframes.length).toBe(2);
        // destroy everything and restore
        for (const st of sectionStrips(state, sec)) destroyStrip(state, st.id);
        expect(sectionStrips(state, sec).length).toBe(0);
        restoreSection(state, snap);
        const kfs = stripKeyframes(state, stripId);
        expect(kfs.length).toBe(2);
        expect(kfs[0].s).toBe(6);
        expect(kfs[0].v).toBe(3);
        expect(kfs[1].s).toBe(14);
        expect(kfs[1].v).toBe(7);
    });

    test("strip keyframes participate in bakeHash — a keyframe edit forces a re-bake", () => {
        const { state, eid, sec } = track();
        convertSection(state, sec);
        createForcePoint(state, sec, 0, 1.3);
        createForcePoint(state, sec, EXTEND_DIST, 1.3);
        const stripId = createStrip(state, sec, 6, 18, 4) as number;
        state.step(0);
        const before = bakeOut.get(eid)?.hash;
        createStripKeyframe(state, stripId, 10, 3);
        state.step(0);
        const after = bakeOut.get(eid)?.hash;
        expect(after).not.toBe(before);
    });

    // R4: addStripKeyframe's create path clamps s to [start, end], but the redo callback
    // passed the UNCLAMPED s to spawnStripKeyframe (which does not clamp). This arm
    // constructs an out-of-extent s (30, far past end=18), creates via the history wrapper,
    // undoes, then redoes — the redo must land the keyframe at the clamped position (18),
    // not at the raw input (30).
    // RED-FIRST WITNESS: before the fix, the redo callback used the unclamped `s` (30), so
    // after redo the keyframe's `s` read 30 instead of 18 — the arm reds at 30 !== 18.
    // VACUITY (measured, both directions FALSE): the arm FAILS at the pre-repair ref and
    // FAILS with the repaired code deleted — in both, the redo lands at s=30 where the arm
    // asserts s=18 (strip start=6 / end=18). It is a proper red-first witness, not vacuous:
    // the redo path is exactly what the fix repairs, and deleting the fix reverts to the
    // unclamped redo (re-measured here: redo reads 30, expected 18).
    test("addStripKeyframe redo clamps s to the strip extent (R4: clamp asymmetry)", () => {
        const { state, sec } = track();
        convertSection(state, sec);
        const start = 6;
        const end = 18;
        const stripId = createStrip(state, sec, start, end, 4) as number;
        const h = createHistory();
        // construct an out-of-extent s (30, far past end=18)
        const outOfExtent = 30;
        const id = addStripKeyframe(h, state, stripId, outOfExtent, 3);
        // the live keyframe is clamped by createStripKeyframe
        const liveState = stripKeyframeState(state, id);
        expect(liveState?.s).toBe(end); // clamped to 18
        // undo removes it
        undo(h, state);
        expect(stripKeyframeState(state, id)).toBeUndefined();
        // redo re-spawns — must use the CLAMPED s, not the raw input
        redo(h, state);
        const redoState = stripKeyframeState(state, id);
        expect(redoState?.s).toBe(end); // must be 18, not 30
    });
});

describe("extent law: a section trim is non-destructive to strips (S2)", () => {
    test("trim below a strip's end: the bake clips at the extent, matching a strip authored at exactly that clipped end", () => {
        const { state, sec } = track();
        convertSection(state, sec); // → force, default extent EXTEND_DIST = 24
        const value = 4; // well off V0 = 10 and off the natural march
        createStrip(state, sec, 5, 20, value);
        setSectionLength(state, sec, 12); // trim below the strip's own end (20), above its start (5)
        state.step(0);
        const eid = trackEntity(state) as number;
        const out = bakeOut.get(eid);
        const info = sectionInfo.get(sec);
        if (!out || !info) throw new Error("no bake");
        // the strip's own edge range on the CLIPPED 12 m grid — edge k's override lands on the
        // sample it exits into (`k + 1`), the same convention the interior-strip test above uses.
        const startEdge = Math.round(5 / DS_NOMINAL);
        for (let i = info.startSample + startEdge + 1; i < info.endSample; i++) {
            expect(out.v[i]).toBeCloseTo(value, 3); // still forced, all the way to the clipped end
        }

        // control: a FRESH section authored directly at the clipped length, same strip start,
        // end clamped to the trimmed extent — the trimmed track's bake must equal this exactly.
        const control = new State();
        control.addSystem(BakeSystem);
        const cEid = createTrack(control);
        const cSec = createSection(control, 0, SectionKind.Force, 12);
        createStrip(control, cSec, 5, 12, value); // end clamped to the control's own extent
        control.step(0);
        const cOut = bakeOut.get(cEid);
        const cInfo = sectionInfo.get(cSec);
        if (!cOut || !cInfo) throw new Error("no control bake");
        expect(info.endSample - info.startSample).toBe(cInfo.endSample - cInfo.startSample);
        for (let i = 0; i < info.endSample - info.startSample; i++) {
            expect(out.v[info.startSample + i]).toBeCloseTo(cOut.v[cInfo.startSample + i], 4);
        }
    });

    test("trim below a strip's start: the strip goes inert, never displaced onto the preceding edge", () => {
        // RED-FIRST: before the `edgeStrips` fix, a strip wholly past the trimmed extent
        // collapsed BOTH ends to `edges` under `boundary()`'s clamp — the point convention then
        // re-mapped that degenerate point onto the section's own LAST live edge (`[edges-1,
        // edges)`), corrupting the bake within the surviving extent instead of leaving the
        // strip inert. Confirmed red by reverting `edgeStrips`'s `live` filter (dropping straight
        // to `rows.map`): `out.v` at the last surviving edge read the strip's stalled value (4)
        // instead of the natural march (~10, V0-driven on a flat profile).
        const { state, sec } = track();
        convertSection(state, sec); // → force, default extent EXTEND_DIST = 24
        const value = 4;
        createStrip(state, sec, 18, 22, value);
        setSectionLength(state, sec, 10); // trim entirely below the strip's own start (18)
        state.step(0);
        const eid = trackEntity(state) as number;
        const out = bakeOut.get(eid);
        const info = sectionInfo.get(sec);
        if (!out || !info) throw new Error("no bake");

        // control: the SAME trim, no strip at all — strip-absent, not a displaced override.
        const control = new State();
        control.addSystem(BakeSystem);
        const cEid = createTrack(control);
        const cSec = createSection(control, 0, SectionKind.Force, 10);
        control.step(0);
        const cOut = bakeOut.get(cEid);
        const cInfo = sectionInfo.get(cSec);
        if (!cOut || !cInfo) throw new Error("no control bake");
        expect(info.endSample - info.startSample).toBe(cInfo.endSample - cInfo.startSample);
        for (let i = 0; i < info.endSample - info.startSample; i++) {
            expect(out.v[info.startSample + i]).toBeCloseTo(cOut.v[cInfo.startSample + i], 4);
        }
        // and NOT the strip's own stalled value, at the last surviving edge — the displaced-
        // onto-the-preceding-edge bug this test guards against.
        expect(out.v[info.endSample]).not.toBeCloseTo(value, 2);
    });

    test("re-lengthening restores the strip byte-identical — the trim never mutates strip data", () => {
        const { state, sec } = track();
        convertSection(state, sec);
        createStrip(state, sec, 5, 20, 4);
        const before = stripState(state, sectionStrips(state, sec)[0].id);
        setSectionLength(state, sec, 8); // trim below the strip's own start — goes inert
        setSectionLength(state, sec, EXTEND_DIST); // re-lengthen back to the original extent
        const after = stripState(state, sectionStrips(state, sec)[0].id);
        expect(after).toEqual(before); // never touched — non-destructive by construction
    });
});

describe("width floor: the min-extent guard also requires the span's own raw width (S2, roadmap fold)", () => {
    test("spanCoversOneEdge refuses a narrow span straddling an edge's MIDPOINT, even though its two ends round to different boundaries", () => {
        // RED-FIRST: before the width conjunct, the straddle test alone (`specs[0].end >
        // specs[0].start`) accepted this — the two ends round to DIFFERENT edge boundaries
        // (0 and 1) because they straddle edge 0's own MIDPOINT (0.25), not its own boundary.
        // Confirmed red by reverting to `return specs[0].end > specs[0].start`: this span passed.
        const ds = new Float32Array(20).fill(0.5); // 10 m / 0.5 m nominal, uniform
        expect(spanCoversOneEdge(ds, 20, 0.24, 0.26)).toBe(false); // 0.02 m wide, roadmap's measure
        expect(spanCoversOneEdge(ds, 20, 0, 0.5)).toBe(true); // the full edge width still passes
    });

    test("createStrip refuses the roadmap's measured 0.020 m straddle strip; the full edge width at the same station still lands", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        const sec = createSection(state, 0, SectionKind.Force, 10); // 10 m / 0.5 m nominal -> ds = 0.5 exactly
        expect(createStrip(state, sec, 0.24, 0.26, 5)).toBeNull();
        expect(sectionStrips(state, sec).length).toBe(0);
        expect(createStrip(state, sec, 0, 0.5, 5)).not.toBeNull();
    });
});

describe("validStripValue routing: createStrip's seed and setStrip's value (S2, roadmap fold)", () => {
    test("validStripValue refuses non-finite, zero, and negative; accepts any positive finite", () => {
        expect(validStripValue(5)).toBe(true);
        expect(validStripValue(0)).toBe(false); // a stall, not a controlled span
        expect(validStripValue(-1)).toBe(false);
        expect(validStripValue(Number.NaN)).toBe(false);
        expect(validStripValue(Number.POSITIVE_INFINITY)).toBe(false);
    });

    test("createStrip refuses a stalled (0) or negative seed value — nothing written", () => {
        // RED-FIRST: before routing, `createStrip` wrote `value` unconditionally
        // (`Strip.value.set(eid, value)`, no guard) — confirmed red by reverting the
        // `validStripValue` check: both calls below returned a non-null id.
        const { state, sec } = track();
        convertSection(state, sec);
        expect(createStrip(state, sec, 5, 15, 0)).toBeNull();
        expect(createStrip(state, sec, 5, 15, -3)).toBeNull();
        expect(sectionStrips(state, sec).length).toBe(0);
        expect(createStrip(state, sec, 5, 15, 3)).not.toBeNull();
    });

    test("setStrip refuses an invalid value write, keeping the strip's current value — position still lands independently", () => {
        // RED-FIRST: before routing, `setStrip` wrote `Strip.value.set(eid, value)`
        // unconditionally — confirmed red by reverting the guard: the row's value read 0.
        const { state, sec } = track();
        convertSection(state, sec);
        const id = createStrip(state, sec, 5, 15, 4) as number;
        setStrip(state, id, 6, 16, 0); // invalid value: refused, old value kept
        const row = sectionStrips(state, sec).find((r) => r.id === id);
        expect(row?.value).toBe(4);
        expect(row?.start).toBe(6); // position still writes independently of the value refusal
        expect(row?.end).toBe(16);
    });
});

/** the roadmap's OWN witness property, decoupled from the width floor's stricter conjunct
 *  (`spanCoversOneEdge` now ALSO requires the raw width — a separately-tested fix, above): does
 *  the span straddle two DIFFERENT edge boundaries under `edgeStrips`'s own round-to-nearest map
 *  — the property whose failure is the degenerate `start === end` the point convention displaces
 *  onto the preceding edge. Two adjacent min-extent strips can legitimately end up too narrow for
 *  the STRICTER width floor once a join re-quantizes onto a coarser grid (the same "floor vs.
 *  no-overlap clamp" tradeoff the deleted `landDomain` code accepted — "the clamp wins"), so the
 *  join floor's own guarantee is straddle-only: never displaced, not necessarily edge-clean. */
function coversStraddleOnly(
    ds: ArrayLike<number>,
    edges: number,
    start: number,
    end: number,
): boolean {
    const specs = edgeStrips(ds, edges, [{ start, end, value: 0 }]);
    return !!specs && specs.length > 0 && specs[0].end > specs[0].start;
}

describe("joinNext — min-extent strip floor across a coarser joined grid (S2, roadmap fold)", () => {
    test("RED-FIRST WITNESS: 2.28 m + 2.26 m force sections — join re-floors both halves' min-extent strips instead of collapsing one onto the preceding edge", () => {
        // measured on the roadmap: joining these two exact lengths, each carrying a min-extent
        // strip at its own tail/head edge, re-quantizes onto a COARSER joined grid (5 + 5 edges
        // -> 9, not 10) — B's rebased strip collapses to `start === end` (confirmed directly
        // against `edgeStrips`: pre-floor, B's [2.28, 2.732) resolves to `{start: 5, end: 5}` on
        // the joined grid), which the point convention then displaces onto the PRECEDING edge,
        // landing dead on A's own surviving strip instead of covering nothing. Confirmed red by
        // reverting the `refloorStrips` calls in `joinNext`.
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        const a = createSection(state, 0, SectionKind.Force, 2.28);
        const b = createSection(state, 1, SectionKind.Force, 2.26);
        state.step(0);
        const aExtent = stripMinExtentAt(state, a, 2.27); // A's own last edge
        const bExtent = stripMinExtentAt(state, b, 0.01); // B's own first edge
        if (!aExtent || !bExtent) throw new Error("no resolvable edge structure");
        const aId = createStrip(state, a, aExtent.start, aExtent.end, 5);
        const bId = createStrip(state, b, bExtent.start, bExtent.end, 7);
        expect(aId).not.toBeNull();
        expect(bId).not.toBeNull();

        expect(joinNext(state, a)).toBe(true);
        state.step(0);

        const strips = sectionStrips(state, a).sort((x, y) => x.start - y.start);
        expect(strips.length).toBe(2);
        const joinedStep = resolveStep(2.28 + 2.26, DS_NOMINAL);
        const joinedDs = new Float32Array(joinedStep.edges).fill(joinedStep.ds);
        for (let i = 0; i < strips.length; i++) {
            expect(
                coversStraddleOnly(joinedDs, joinedStep.edges, strips[i].start, strips[i].end),
            ).toBe(true);
            if (i + 1 < strips.length)
                expect(strips[i].end).toBeLessThanOrEqual(strips[i + 1].start); // no overlap
        }
        // the floor extends `end`; it never rewrites the authored value.
        expect(strips.find((r) => r.id === aId)?.value).toBe(5);
        expect(strips.find((r) => r.id === bId)?.value).toBe(7);
    });

    test("swept-grid probe: across a (headLen, tailLen, station) grid, a single min-extent strip on B's side survives the join straddling ≥1 edge, never displaced (the roadmap's own red-first witness — 12/400 combos read displaced before the fix, 0/400 after)", () => {
        // `station` is B's OWN distance from the join boundary — a THIRD swept dimension
        // independent of the two lengths, matching the roadmap's own (headLen, tailLen,
        // station) grid. One strip per join (not two abutting ones — that pathological
        // double-boxed construction runs into the SAME "floor vs. no-overlap clamp" tradeoff
        // the deleted `landDomain` code accepted for two strips squeezed with zero slack; the
        // roadmap's own measured witness names "a minimum-extent velocity strip", singular).
        const headLens = [2.1, 2.28, 3.4, 5.05, 8.02, 1.5, 6.7, 9.9, 12.3, 3.0];
        const tailLens = [1.9, 2.26, 3.6, 4.95, 7.98, 2.5, 5.1, 10.4, 8.8, 4.0];
        const stations = [0.01, 0.1, 0.3, 0.7];
        let checked = 0;
        for (const headLen of headLens) {
            for (const tailLen of tailLens) {
                for (const station of stations) {
                    if (station >= tailLen) continue;
                    const state = new State();
                    state.addSystem(BakeSystem);
                    createTrack(state);
                    const a = createSection(state, 0, SectionKind.Force, headLen);
                    const b = createSection(state, 1, SectionKind.Force, tailLen);
                    state.step(0);
                    const bExtent = stripMinExtentAt(state, b, station);
                    if (!bExtent) continue;
                    createStrip(state, b, bExtent.start, bExtent.end, 7);
                    expect(joinNext(state, a)).toBe(true);
                    state.step(0);
                    const strips = sectionStrips(state, a);
                    expect(strips.length).toBe(1);
                    const joinedStep = resolveStep(headLen + tailLen, DS_NOMINAL);
                    const joinedDs = new Float32Array(joinedStep.edges).fill(joinedStep.ds);
                    checked++;
                    expect(
                        coversStraddleOnly(
                            joinedDs,
                            joinedStep.edges,
                            strips[0].start,
                            strips[0].end,
                        ),
                    ).toBe(true);
                }
            }
        }
        expect(checked).toBeGreaterThan(300);
    });

    test("geo join: an existing straddling min-extent strip and a fresh cross-join one both still cover ≥1 edge of the merged chain (no regression from the force-side floor)", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        const a = createSection(state, 0, SectionKind.Geo, 0);
        addNode(state, a, 0, 0);
        addNode(state, a, 20, 0);
        const b = createSection(state, 1, SectionKind.Geo, 0);
        addNode(state, b, 0, 0);
        addNode(state, b, 20, 0);
        state.step(0);
        const bExtent = stripMinExtentAt(state, b, 0.01);
        if (!bExtent) throw new Error("no resolvable edge structure");
        const bId = createStrip(state, b, bExtent.start, bExtent.end, 6);
        expect(bId).not.toBeNull();

        expect(joinNext(state, a)).toBe(true);
        state.step(0);

        const strips = sectionStrips(state, a);
        expect(strips.length).toBe(1);
        expect(strips[0].end).toBeGreaterThan(strips[0].start);
        expect(strips[0].value).toBe(6);
    });
});

// PASS-5 (3): App.svelte's canCut geo pre-check must evaluate geoSplitStripsRefused on the
// `t >= 1` landmark branch (which `splitGeoAt` reduces to `splitGeo(j+1)`), using `j+1` as
// the node order — not `j`. At `bb9e638` the condition `ctx.cut.t === undefined || ctx.cut.t <= 0`
// skipped the `t >= 1` branch entirely, and `ctx.cut.at` was `j` (wrong: should be `j+1`).
// No data loss (the internal guard still refuses), but T1's "grayed before the click" claim
// was false for that branch. This arm tests the underlying predicate: a cut at `t >= 1`
// (node `j+1`) that would split a straddling strip into sub-edge halves must read
// `geoSplitStripsRefused === true` at `j+1` and `geoSplitAtStripsRefused === true` at `(j, 1)`.
test("geoSplitStripsRefused at j+1 catches a t>=1 landmark cut that the old canCut skipped (pass-5 deliverable 3)", () => {
    const state = new State();
    state.addSystem(BakeSystem);
    createTrack(state);
    const sec = createSection(state, 0, SectionKind.Geo, 0);
    addNode(state, sec, 0, 0);
    addNode(state, sec, 12, 0);
    addNode(state, sec, 24, 0);
    state.step(0);
    // strip straddling node 1 (the segment boundary at 12 m) — a cut at node 1 splits it
    createStrip(state, sec, 11.9, 12.6, 5);
    state.step(0);
    // a cut at t >= 1 of segment 0 reduces to splitGeo(j+1) = splitGeo(1)
    // the old canCut checked geoSplitStripsRefused(ecs, sec, 0) (j, wrong) → false (not refused)
    expect(geoSplitStripsRefused(state, sec, 0)).toBe(false); // j = 0: not a split point for this strip
    // the fix checks geoSplitStripsRefused(ecs, sec, 1) (j+1, correct) → true (refused)
    expect(geoSplitStripsRefused(state, sec, 1)).toBe(true);
    // geoSplitAtStripsRefused delegates t >= 1 to geoSplitStripsRefused(j+1)
    expect(geoSplitAtStripsRefused(state, sec, 0, 1)).toBe(true);
    // and the actual split is refused (no mutation)
    const nodesBefore = sectionHandles(state, sec).length;
    const h = createHistory();
    expect(splitSection(h, state, sec, 0, 1)).toBeNull();
    expect(sectionHandles(state, sec).length).toBe(nodesBefore);
    expect(h.undo.length).toBe(0);
});

// PASS-5 (3b): App.svelte's canCut geo pre-check must call geoSplitAtStripsRefused on the
// interior branch (0 < t < 1), not just the landmark branches. At `f1ed612` the interior
// branch fell through to `return true`, so T1's "grayed before the click" claim was false
// for the interior case — the one the geoSplitAtStripsRefused pre-check exists for. The
// testable seam is geoSplitAtStripsRefused itself (canCut is a Svelte $derived, not directly
// testable). RED-FIRST: before the fix, canCut returned true for interior; after, it calls
// geoSplitAtStripsRefused and grays.
test("geoSplitAtStripsRefused catches an interior cut on a straddling strip (pass-5 deliverable 3b)", () => {
    const state = new State();
    state.addSystem(BakeSystem);
    createTrack(state);
    const sec = createSection(state, 0, SectionKind.Geo, 0);
    addNode(state, sec, 0, 0);
    addNode(state, sec, 24, 0);
    state.step(0);
    // strip straddling the interior cut point at ~12 m — a cut at t=0.5 of segment 0
    // places the new node at ~12 m, splitting [11.9, 12.6) into a 0.1 m head and a 0.6 m
    // tail. The head [11.9, 12.0) is sub-edge on the ~0.5 m grid (both endpoints map to
    // edge 24), so the split is refused.
    createStrip(state, sec, 11.9, 12.6, 5);
    state.step(0);
    // the interior pre-check reads true (refused) — canCut now calls this and grays
    expect(geoSplitAtStripsRefused(state, sec, 0, 0.5)).toBe(true);
    // and the actual split is refused (no mutation)
    const nodesBefore = sectionHandles(state, sec).length;
    const h = createHistory();
    expect(splitSection(h, state, sec, 0, 0.5)).toBeNull();
    expect(sectionHandles(state, sec).length).toBe(nodesBefore);
    expect(h.undo.length).toBe(0);
});

// LAZY TAIL: the tail sampleChain in geoSplitAtStripsRefused is built lazily — only
// when a strip straddles the cut AND its head half passes spanCoversOneEdge. Three
// measured truths frame these arms:
//
// (a) At most one strip can straddle a cut, because createStrip refuses overlap
//     (stripOverlapped, src/track.ts). So the tail is built at most once by
//     construction, and the "reused for every later straddling strip" path is
//     reachable only for a pre-guard document restored through spawnStrip (which
//     bypasses the overlap guard deliberately, for byte-identical undo/redo).
// (b) What the laziness actually buys is zero tail work on the no-strip,
//     non-straddling and head-fail paths — the common case, since a geo section
//     usually carries no strips.
// (c) These arms pin verdicts, not laziness — they pass at 3f15da1^ too (where the
//     tail was built unconditionally). The laziness itself (one sampleChain for the
//     straddling path, zero for the others) is not directly witnessable without a
//     spy on the pure sampleChain import.
test("geoSplitAtStripsRefused reaches the tail check when the head half passes (head passes → tail built → tail check)", () => {
    const state = new State();
    state.addSystem(BakeSystem);
    createTrack(state);
    const sec = createSection(state, 0, SectionKind.Geo, 0);
    addNode(state, sec, 0, 0);
    addNode(state, sec, 24, 0);
    state.step(0);
    // one strip straddling the interior cut at ~12 m (t=0.5 of segment 0). The head
    // half [11.0, 12.0) is 1.0 m — wider than the ~0.5 m grid — so spanCoversOneEdge
    // passes and the tail is genuinely sampled (the lazy build fires). The tail
    // [0, 0.1) is sub-edge, so the tail check refuses. Measured verdict: true.
    // This is the branch 3f15da1 changed (head passes → tail built lazily → tail
    // check runs) and no arm in the suite covered it before.
    createStrip(state, sec, 11.0, 12.1, 5);
    state.step(0);
    expect(geoSplitAtStripsRefused(state, sec, 0, 0.5)).toBe(true);
});

test("geoSplitAtStripsRefused with zero strips returns false for interior t (no tail work)", () => {
    const state = new State();
    state.addSystem(BakeSystem);
    createTrack(state);
    const sec = createSection(state, 0, SectionKind.Geo, 0);
    addNode(state, sec, 0, 0);
    addNode(state, sec, 24, 0);
    state.step(0);
    // no strips → nothing to refuse
    expect(geoSplitAtStripsRefused(state, sec, 0, 0.5)).toBe(false);
});

test("geoSplitAtStripsRefused with a non-straddling strip returns false for interior t", () => {
    const state = new State();
    state.addSystem(BakeSystem);
    createTrack(state);
    const sec = createSection(state, 0, SectionKind.Geo, 0);
    addNode(state, sec, 0, 0);
    addNode(state, sec, 24, 0);
    state.step(0);
    // strip entirely on one side of the cut at ~12 m — does not straddle
    createStrip(state, sec, 0, 5, 5);
    state.step(0);
    expect(geoSplitAtStripsRefused(state, sec, 0, 0.5)).toBe(false);
});
