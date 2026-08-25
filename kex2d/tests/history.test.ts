import { State } from "@dylanebert/shallot";
import { beforeEach, expect, test } from "bun:test";
import {
    editor,
    enterTangentEdit,
    openNodeMenu,
    select,
    selectForce,
    selectionHook,
    selectNodes,
    selectSection,
    selectStart,
} from "../src/editor";
import {
    appendSection,
    addOneShot,
    addStrip,
    beginForceMove,
    beginForceMoves,
    beginLength,
    beginMove,
    beginMoves,
    beginStripMove,
    beginStripKeyframeMove,
    beginStripKeyframeMoves,
    commit,
    commitChord,
    commitLength,
    convertSection,
    createForce,
    createHistory,
    addStripKeyframe,
    deleteForces,
    deleteOneShot,
    deleteStrips,
    deleteStripKeyframes,
    extendTrack,
    joinSections,
    redo,
    removeSections,
    resetSection,
    resetNodes,
    resetNodesBulk,
    setForcesEase,
    setSelectionHook,
    setTangentModes,
    solveForce,
    trimSuffix,
    trimTrack,
    undo,
} from "../src/history";

// the app injects the editor's selection snapshot into the history stack at boot; the tests do the
// same so undo/redo re-resolve the (shared, module-singleton) editor selection. clear it before each
// test so a prior test's leftover selection can't leak into a `pre` snapshot.
setSelectionHook(selectionHook);
beforeEach(() => {
    select(null);
    selectSection(null);
    selectStart(false);
    editor.force = null;
    editor.strip = null;
    editor.nodeMenu = null;
});
import { stitchNode } from "../src/tangents";
import {
    addNode,
    authoredHash,
    BakeSystem,
    createForcePoint,
    createSection,
    createStrip,
    createTrack,
    entryOneShot,
    entrySpeed,
    EXTEND_DIST,
    forceEase,
    Handle,
    handleAt,
    handleTangent,
    extend,
    MIN_FORCE_LEN,
    nodeSnapshot,
    readProvenance,
    reheadOnDrag,
    removeTrailingHandle,
    resetTangent,
    sameNodes,
    SectionKind,
    sectionForces,
    sectionHandles,
    sectionInfo,
    sections,
    allStrips,
    seedTangent,
    setForcePoint,
    setSectionLength,
    setStartSpeed,
    setStickyLen,
    setStrip,
    setStripKeyframe,
    setTangent,
    snapshotSection,
    stampProvenance,
    stickyLen,
    stripKeyframes,
    stripMinExtentAt,
    Track,
    V0,
} from "../src/track";
import { editTangent, TangentMode } from "../src/spline";
import { Easing } from "../src/profile";

// track undo/redo, addressed by stable id/order. a fresh device-free State per test
// (no GPU — history mutates the ECS directly, never bakes), one geo section with the
// flat two-node seed (node 0 pinned at the local origin).
function nodes(): { state: State; eid: number; sec: number } {
    const state = new State();
    const eid = createTrack(state);
    const sec = createSection(state, 0, SectionKind.Geo, 0);
    addNode(state, sec, 0, 0);
    addNode(state, sec, EXTEND_DIST, 0);
    return { state, eid, sec };
}

// kex2d-provenance stage 1: a solve landing stamps provenance off `sectionInfo.entry`, which only
// exists once `BakeSystem` has run — unlike the bare `nodes()` seed above (history mutates the ECS
// directly and never bakes on its own), a stamp test needs one real bake first.
function bakedNodes(): { state: State; eid: number; sec: number } {
    const { state, eid, sec } = nodes();
    state.addSystem(BakeSystem);
    state.step(0);
    return { state, eid, sec };
}

const orders = (s: State, sec: number) => sectionHandles(s, sec).map((e) => Handle.order.get(e));
function poseOf(s: State, sec: number, order: number) {
    const e = handleAt(s, sec, order);
    if (e === null) throw new Error(`no node at order ${order}`);
    return { x: Handle.pos.x.get(e), y: Handle.pos.y.get(e), theta: Handle.theta.get(e) };
}
const points = (s: State, sec: number) =>
    sectionForces(s, sec).map((p) => ({ id: p.id, s: p.s, g: p.g }));

test("extend: undo removes the new node, redo restores it verbatim", () => {
    const { state, sec } = nodes();
    const h = createHistory();

    const eid = extendTrack(h, state, sec);
    const order = Handle.order.get(eid);
    const pose = poseOf(state, sec, order);
    expect(orders(state, sec)).toEqual([0, 1, 2]);

    undo(h, state);
    expect(orders(state, sec)).toEqual([0, 1]);
    expect(handleAt(state, sec, 2)).toBeNull();

    redo(h, state);
    expect(orders(state, sec)).toEqual([0, 1, 2]);
    expect(poseOf(state, sec, order)).toEqual(pose); // same pos + heading
});

test("trim: undo restores the removed node; the promoted tip's heading never moves", () => {
    // stage 7b flip: this test pinned the trim's re-head round-trip. deletion no
    // longer re-heads at all (an Auto node's theta is authored by its own move; a
    // neighbor's delete touches nothing), so the heading holds through trim AND undo.
    const { state, sec } = nodes();
    addNode(state, sec, 40, 0); // node 2 (the tip); node 1 is now interior, heading frozen
    // shove interior node 1 off its chord — a re-head would visibly change its heading.
    Handle.pos.set(handleAt(state, sec, 1) as number, 16, 30);
    const h = createHistory();

    const tipBefore = Handle.theta.get(handleAt(state, sec, 1) as number);
    const removed = poseOf(state, sec, 2);

    expect(trimTrack(h, state, sec)).toBe(true);
    expect(orders(state, sec)).toEqual([0, 1]);
    expect(Handle.theta.get(handleAt(state, sec, 1) as number)).toBe(tipBefore); // untouched

    undo(h, state);
    expect(orders(state, sec)).toEqual([0, 1, 2]);
    expect(poseOf(state, sec, 2)).toEqual(removed); // node back verbatim
    expect(Handle.theta.get(handleAt(state, sec, 1) as number)).toBe(tipBefore);

    redo(h, state);
    expect(orders(state, sec)).toEqual([0, 1]);
    expect(Handle.theta.get(handleAt(state, sec, 1) as number)).toBe(tipBefore);
});

test("trim: the promoted tip's authored tangent rides undo/redo byte-identical", () => {
    // deleting the trailing node promotes the once-interior node with its authored
    // tangent whole (a neighbor's delete never discards authored state), and the
    // trim's snapshot pair carries it verbatim through undo and redo.
    const { state, sec } = nodes();
    addNode(state, sec, 40, 0); // node 2 tip; node 1 interior
    const seed = seedTangent(state, sec, 1, TangentMode.Aligned);
    if (!seed) throw new Error("seed");
    setTangent(state, sec, 1, editTangent(seed, "out", 8, 8)); // author node 1's tangent
    const authored = handleTangent(state, sec, 1); // the f32-stored value
    const h = createHistory();

    expect(trimTrack(h, state, sec)).toBe(true);
    expect(handleTangent(state, sec, 1)).toEqual(authored); // promoted tip keeps it

    undo(h, state);
    expect(orders(state, sec)).toEqual([0, 1, 2]); // node 2 back
    expect(handleTangent(state, sec, 1)).toEqual(authored); // interior tangent verbatim

    redo(h, state);
    expect(handleTangent(state, sec, 1)).toEqual(authored); // preserved again
});

test("trim refuses at the two-node floor and records nothing", () => {
    const { state, sec } = nodes();
    const h = createHistory();
    expect(trimTrack(h, state, sec)).toBe(false);
    expect(h.undo.length).toBe(0);
    expect(orders(state, sec)).toEqual([0, 1]);
});

test("a node drag collapses to one entry; undo restores the pose and the reheaded tip", () => {
    const { state, sec } = nodes();
    addNode(state, sec, 30, 0); // node 2 is the tip
    const h = createHistory();

    const beforeTip = poseOf(state, sec, 2);
    const beforeMid = poseOf(state, sec, 1);

    beginMove(state, sec);
    const tip = handleAt(state, sec, 2) as number;
    Handle.pos.set(tip, 30, 10); // live preview frames — not recorded individually
    reheadOnDrag(state, tip);
    Handle.pos.set(tip, 30, 25);
    reheadOnDrag(state, tip);
    commit(h);

    expect(h.undo.length).toBe(1); // the whole drag → one entry
    expect(poseOf(state, sec, 2).y).toBe(25);
    expect(poseOf(state, sec, 2).theta).not.toBe(beforeTip.theta); // the tip reheaded
    const dragged = poseOf(state, sec, 2);

    undo(h, state);
    expect(poseOf(state, sec, 2)).toEqual(beforeTip); // pos + heading restored
    expect(poseOf(state, sec, 1)).toEqual(beforeMid);

    redo(h, state);
    expect(poseOf(state, sec, 2)).toEqual(dragged); // replays to the dragged pose
});

test("a no-move node click records nothing", () => {
    const { state, sec } = nodes();
    const h = createHistory();
    beginMove(state, sec);
    commit(h); // released without moving
    expect(h.undo.length).toBe(0);
});

// ── force points — addressed by stable `id`, the same undo substrate ──

test("createForce: undo removes the point, redo re-spawns it verbatim", () => {
    const { state, sec } = nodes();
    const h = createHistory();
    const id = createForce(h, state, sec, 12, 0.5);
    expect(points(state, sec)).toEqual([{ id, s: 12, g: 0.5 }]);

    undo(h, state);
    expect(points(state, sec)).toEqual([]);

    redo(h, state);
    expect(points(state, sec)).toEqual([{ id, s: 12, g: 0.5 }]); // same id + values
});

test("deleteForces: a size-1 set undoes re-spawning the removed point verbatim", () => {
    const { state, sec } = nodes();
    const h = createHistory();
    const id = createForce(h, state, sec, 7, 0.2);
    deleteForces(h, state, [id]);
    expect(points(state, sec)).toEqual([]);

    undo(h, state);
    expect(points(state, sec)).toEqual([{ id, s: 7, g: 0.2 }]);
});

test("a force-point drag collapses to one entry; undo restores s/g", () => {
    const { state, sec } = nodes();
    const h = createHistory();
    const id = createForce(h, state, sec, 10, 1);

    beginForceMove(state, id);
    setForcePoint(state, id, 14, 1.5); // live preview frames — not recorded
    setForcePoint(state, id, 18, 2);
    commit(h);

    expect(h.undo.length).toBe(2); // create + the whole drag → one entry each
    expect(points(state, sec)).toEqual([{ id, s: 18, g: 2 }]);

    undo(h, state); // undo the drag
    expect(points(state, sec)).toEqual([{ id, s: 10, g: 1 }]);
});

test("a no-move force-point release records nothing", () => {
    const { state, sec } = nodes();
    const h = createHistory();
    const id = createForce(h, state, sec, 5, 1);
    beginForceMove(state, id);
    commit(h); // released without moving
    expect(h.undo.length).toBe(1); // only the create
});

// ── force bulk ops (stage 3: timeline multiselect) — the shared-delta move, the one-entry bulk
// delete, and bulk easing on non-terminal members. the pure rigid-clamp math is in timeline.test.ts;
// these pin the history contract (one entry, undo restores the set + track state).

test("beginForceMoves: a shared-delta bulk move collapses to one entry, offsets preserved, undo restores all", () => {
    const { state, sec } = nodes();
    const h = createHistory();
    const a = createForce(h, state, sec, 5, 1);
    const b = createForce(h, state, sec, 10, 2);

    // the whole set moves by ONE shared (Δs, Δg) = (+3, +0.5) — what the drag/nudge write.
    beginForceMoves(state, [a, b]);
    setForcePoint(state, a, 8, 1.5);
    setForcePoint(state, b, 13, 2.5);
    commit(h);

    expect(h.undo.length).toBe(3); // two creates + the whole bulk move → one entry
    expect(points(state, sec)).toEqual([
        { id: a, s: 8, g: 1.5 },
        { id: b, s: 13, g: 2.5 },
    ]);
    // relative offset preserved exactly (5 m apart before and after).
    expect(points(state, sec)[1].s - points(state, sec)[0].s).toBe(5);

    undo(h, state);
    expect(points(state, sec)).toEqual([
        { id: a, s: 5, g: 1 },
        { id: b, s: 10, g: 2 },
    ]);
});

test("a no-move bulk release records nothing (every member unchanged)", () => {
    const { state, sec } = nodes();
    const h = createHistory();
    const a = createForce(h, state, sec, 5, 1);
    const b = createForce(h, state, sec, 10, 2);
    beginForceMoves(state, [a, b]);
    commit(h); // released without moving either member
    expect(h.undo.length).toBe(2); // only the two creates
});

test("deleteForces: the whole set deletes in ONE entry; undo restores every point and the selection set", () => {
    clearSelection();
    const { state, sec } = nodes();
    const h = createHistory();
    const a = createForce(h, state, sec, 5, 1);
    const b = createForce(h, state, sec, 10, 2);
    const c = createForce(h, state, sec, 15, 0.5);

    // a shift-click set of all three, c active.
    selectForce(a);
    selectForce(b, "toggle");
    selectForce(c, "toggle");
    expect(editor.forces.ids.size).toBe(3);

    deleteForces(h, state, [a, b, c]);
    expect(points(state, sec)).toEqual([]);
    expect(h.undo.length).toBe(4); // three creates + ONE bulk delete

    undo(h, state);
    // track state restored verbatim…
    expect(points(state, sec)).toEqual([
        { id: a, s: 5, g: 1 },
        { id: b, s: 10, g: 2 },
        { id: c, s: 15, g: 0.5 },
    ]);
    // …and the selection SET restored (undo restores both, per the SelectionHook).
    expect([...editor.forces.ids].sort((x, y) => x - y)).toEqual([a, b, c].sort((x, y) => x - y));
});

test("setForcesEase: applies to the selected NON-terminal keyframes only, one entry, undo restores", () => {
    const { state, sec } = nodes();
    const h = createHistory();
    // A → B → C in one section: A and B govern a following segment (non-terminal), C is terminal.
    const a = createForce(h, state, sec, 5, 1);
    const b = createForce(h, state, sec, 10, 2);
    const c = createForce(h, state, sec, 15, 1);
    // all three start at the default ease (Cubic) — distinct from Linear so the write is observable.
    expect(forceEase(state, a)).toBe(Easing.Cubic);
    expect(forceEase(state, c)).toBe(Easing.Cubic);

    setForcesEase(h, state, [a, b, c], Easing.Linear);
    expect(forceEase(state, a)).toBe(Easing.Linear); // non-terminal → eased
    expect(forceEase(state, b)).toBe(Easing.Linear); // non-terminal → eased
    expect(forceEase(state, c)).toBe(Easing.Cubic); // terminal → governs no segment, untouched
    expect(h.undo.length).toBe(4); // three creates + ONE bulk ease

    undo(h, state);
    expect(forceEase(state, a)).toBe(Easing.Cubic);
    expect(forceEase(state, b)).toBe(Easing.Cubic);
});

test("setForcesEase on an all-terminal set records nothing (no applicable keyframe)", () => {
    const { state, sec } = nodes();
    const h = createHistory();
    const only = createForce(h, state, sec, 5, 1); // the section's sole point — terminal
    setForcesEase(h, state, [only], Easing.Linear);
    expect(h.undo.length).toBe(1); // only the create; nothing to ease
    expect(forceEase(state, only)).toBe(Easing.Cubic);
});

// ── velocity strips — the same undo substrate as force points (`addStrip`/`deleteStrips`/
// `beginStripMove`, C3's shape), driven directly rather than only through `domain.test.ts`'s
// indirect undo byte-identity arm (the Residue: real gestures are exactly when these wrappers
// first get driven by something other than a test calling them straight).

test("addStrip: undo removes it, redo re-spawns it verbatim", () => {
    const { state } = nodes();
    const h = createHistory();
    const id = addStrip(h, state, 5, 10, 12) as number;
    expect(id).not.toBeNull();
    expect(allStrips(state)).toEqual([
        { eid: expect.any(Number), id, start: 5, end: 10, value: 12 },
    ]);

    undo(h, state);
    expect(allStrips(state)).toEqual([]);

    redo(h, state);
    expect(
        allStrips(state).map((r) => ({
            id: r.id,
            start: r.start,
            end: r.end,
            value: r.value,
        })),
    ).toEqual([{ id, start: 5, end: 10, value: 12 }]);
});

test("addStrip refuses an overlapping span — no record, nothing lands", () => {
    const { state } = nodes();
    const h = createHistory();
    addStrip(h, state, 5, 15, 8);
    const before = h.undo.length;
    const refused = addStrip(h, state, 10, 20, 4); // overlaps [5, 15)
    expect(refused).toBeNull();
    expect(h.undo.length).toBe(before); // nothing recorded for the refusal
    expect(allStrips(state).length).toBe(1);
});

test("deleteStrips: a size-1 set undoes re-spawning the removed strip verbatim", () => {
    const { state } = nodes();
    const h = createHistory();
    const id = addStrip(h, state, 2, 6, 7) as number;
    deleteStrips(h, state, [id]);
    expect(allStrips(state)).toEqual([]);

    undo(h, state);
    expect(
        allStrips(state).map((r) => ({
            id: r.id,
            start: r.start,
            end: r.end,
            value: r.value,
        })),
    ).toEqual([{ id, start: 2, end: 6, value: 7 }]);
});

test("deleteStrips: the whole set deletes in ONE entry; undo restores every strip", () => {
    const { state } = nodes();
    const h = createHistory();
    const a = addStrip(h, state, 0, 4, 3) as number;
    const b = addStrip(h, state, 6, 10, 5) as number;
    deleteStrips(h, state, [a, b]);
    expect(allStrips(state)).toEqual([]);
    expect(h.undo.length).toBe(3); // two adds + ONE bulk delete

    undo(h, state);
    const rows = allStrips(state).map((r) => ({
        id: r.id,
        start: r.start,
        end: r.end,
        value: r.value,
    }));
    expect(rows).toEqual([
        { id: a, start: 0, end: 4, value: 3 },
        { id: b, start: 6, end: 10, value: 5 },
    ]);
});

test("deleteStrips on an empty set records nothing", () => {
    const { state } = nodes();
    const h = createHistory();
    deleteStrips(h, state, []);
    expect(h.undo.length).toBe(0);
});

// ── strip keyframes — `deleteStripKeyframes`, `deleteForces`' strip-keyframe twin
// (`kex2d-event-lane` S4's booked multi-select: Delete acts on the whole selected set). ──

test("deleteStripKeyframes: a size-1 set undoes re-spawning the removed keyframe verbatim", () => {
    const { state } = nodes();
    const h = createHistory();
    const stripId = addStrip(h, state, 2, 6, 7) as number;
    const seeded = stripKeyframes(state, stripId);
    const id = seeded[0].id;
    deleteStripKeyframes(h, state, [id]);
    expect(stripKeyframes(state, stripId).map((k) => k.id)).not.toContain(id);

    undo(h, state);
    const restored = stripKeyframes(state, stripId).find((k) => k.id === id);
    expect(restored).toMatchObject({ id, s: seeded[0].s, v: seeded[0].v });
});

test("deleteStripKeyframes: the whole set deletes in ONE entry; undo restores every keyframe", () => {
    const { state } = nodes();
    const h = createHistory();
    const stripId = addStrip(h, state, 0, 10, 8) as number;
    const extraId = addStripKeyframe(h, state, stripId, 5, 12);
    const before = stripKeyframes(state, stripId);
    expect(before.length).toBe(3); // the seeded start/end pair + the extra
    const ids = before.map((k) => k.id);
    const undoLenBefore = h.undo.length;
    deleteStripKeyframes(h, state, ids);
    expect(stripKeyframes(state, stripId)).toEqual([]);
    expect(h.undo.length).toBe(undoLenBefore + 1); // ONE bulk delete entry, not three

    undo(h, state);
    const restoredIds = stripKeyframes(state, stripId)
        .map((k) => k.id)
        .sort((a, b) => a - b);
    expect(restoredIds).toEqual([...ids].sort((a, b) => a - b));
    expect(extraId).toBeGreaterThan(0);
});

test("deleteStripKeyframes on an empty set records nothing", () => {
    const { state } = nodes();
    const h = createHistory();
    deleteStripKeyframes(h, state, []);
    expect(h.undo.length).toBe(0);
});

test("beginStripMove: a drag (resize + reposition) collapses to one entry; undo restores start/end/value", () => {
    const { state } = nodes();
    const h = createHistory();
    const id = addStrip(h, state, 5, 10, 8) as number;

    beginStripMove(state, id);
    setStrip(state, id, 6, 11, 9); // live preview frame — not recorded on its own
    setStrip(state, id, 7, 12, 10);
    commit(h);

    expect(h.undo.length).toBe(2); // the add + the whole drag → one entry
    expect(allStrips(state)[0]).toMatchObject({ start: 7, end: 12, value: 10 });

    undo(h, state);
    expect(allStrips(state)[0]).toMatchObject({ start: 5, end: 10, value: 8 });
});

test("a no-move strip-gesture release records nothing", () => {
    const { state } = nodes();
    const h = createHistory();
    const id = addStrip(h, state, 5, 10, 8) as number;
    beginStripMove(state, id);
    commit(h); // released without moving
    expect(h.undo.length).toBe(1); // only the add
});

test("convert geo→force undoes byte-identical to the shaped geo track", () => {
    const { state, sec } = nodes();
    addNode(state, sec, 40, 6); // shape it: a third off-axis node
    const before = sectionHandles(state, sec).map((e) => ({
        order: Handle.order.get(e),
        x: Handle.pos.x.get(e),
        y: Handle.pos.y.get(e),
        theta: Handle.theta.get(e),
    }));
    const h = createHistory();

    convertSection(h, state, sec);
    expect(sections(state)[0].kind).toBe(SectionKind.Force);
    expect(sectionHandles(state, sec).length).toBe(0); // nodes cleared (destructive)

    undo(h, state);
    expect(sections(state)[0].kind).toBe(SectionKind.Geo);
    const after = sectionHandles(state, sec).map((e) => ({
        order: Handle.order.get(e),
        x: Handle.pos.x.get(e),
        y: Handle.pos.y.get(e),
        theta: Handle.theta.get(e),
    }));
    expect(after).toEqual(before); // the geo chain restored exactly
});

// kex2d-idioms stage 2: the Reset row's wrapper — `convertSection`'s `snapshotSection`-pair
// shape over the kind-held `track.resetSection`, so a reset is ONE undoable entry and undo
// restores the pre-reset payload byte-identical (the safety that replaces a confirm).

test("resetSection on a geo section is ONE entry and undoes byte-identical", () => {
    const { state, sec } = nodes();
    addNode(state, sec, 40, 6); // shape it: a third off-axis node
    const h = createHistory();
    const before = snapshotSection(state, sec);

    resetSection(h, state, sec);
    expect(h.undo.length).toBe(1);
    expect(sectionHandles(state, sec).length).toBe(2); // the flat two-node seed
    const seeded = snapshotSection(state, sec);
    expect(seeded.kind).toBe(SectionKind.Geo); // the kind held

    undo(h, state);
    expect(snapshotSection(state, sec)).toEqual(before); // byte-identical restore
    redo(h, state);
    expect(snapshotSection(state, sec)).toEqual(seeded); // and forward again
});

test("resetSection on a force section is ONE entry and undoes byte-identical", () => {
    const { state, sec } = bakedNodes(); // a real bake: the force seed reads the entry force
    const h = createHistory();
    convertSection(h, state, sec); // → force (the two seed keyframes)
    state.step(0);
    createForce(h, state, sec, 12, 2); // author it away from the seed
    setSectionLength(state, sec, 60);
    const before = snapshotSection(state, sec);
    const depth = h.undo.length;

    resetSection(h, state, sec);
    expect(h.undo.length).toBe(depth + 1);
    expect(sectionForces(state, sec).length).toBe(2); // reseeded
    const seeded = snapshotSection(state, sec);
    expect(seeded.kind).toBe(SectionKind.Force); // the kind held

    undo(h, state);
    expect(snapshotSection(state, sec)).toEqual(before); // byte-identical restore
    redo(h, state);
    expect(snapshotSection(state, sec)).toEqual(seeded);
});

// ── section bulk ops (shift-click set — Premiere multi-clip) ─────────────────────

test("removeSections: a SET of sections deletes in ONE entry; undo restores all sections + the selection set", () => {
    clearSelection();
    const { state, sec: a } = nodes(); // one geo section, order 0
    const h = createHistory();
    const b = appendSection(h, state, SectionKind.Geo); // order 1
    const c = appendSection(h, state, SectionKind.Geo); // order 2
    expect(sections(state).map((s) => s.id)).toEqual([a, b, c]);

    // a shift-click set of two of the three, b active.
    selectSection(a);
    selectSection(b, "toggle");
    expect(editor.sections.ids.size).toBe(2);

    expect(removeSections(h, state, [a, b])).toBe(true);
    expect(sections(state).map((s) => s.id)).toEqual([c]);
    expect(h.undo.length).toBe(3); // two appends + ONE bulk delete

    undo(h, state);
    expect(
        sections(state)
            .map((s) => s.id)
            .sort((x, y) => x - y),
    ).toEqual([a, b, c].sort((x, y) => x - y));
    // the selection SET restored (undo restores both, per the SelectionHook).
    expect([...editor.sections.ids].sort((x, y) => x - y)).toEqual([a, b].sort((x, y) => x - y));
});

test("removeSections refuses (records nothing) when the set is EVERY section — the last-section floor", () => {
    clearSelection();
    const { state, sec: a } = nodes();
    const h = createHistory();
    const b = appendSection(h, state, SectionKind.Geo);
    expect(removeSections(h, state, [a, b])).toBe(false); // would leave zero
    expect(sections(state).length).toBe(2); // untouched
    expect(h.undo.length).toBe(1); // only the append — the refused delete recorded nothing
});

test("joinSections: a contiguous same-kind SET joins into ONE entry; undo restores every section + the selection set byte-identical", () => {
    clearSelection();
    const { state, sec: a } = nodes(); // one geo section, order 0
    const h = createHistory();
    const b = appendSection(h, state, SectionKind.Geo); // order 1
    const c = appendSection(h, state, SectionKind.Geo); // order 2
    expect(sections(state).map((s) => s.id)).toEqual([a, b, c]);
    // the stable (non-eid) fields — `restoreAll` respawns fresh eids on undo (the allocator
    // recycles LIFO), so `eid` itself is never part of a byte-identity claim; `id`/`order`/`kind`/
    // `length` are the authored payload the restore must reproduce exactly.
    const stable = (s: { id: number; order: number; kind: SectionKind; length: number }) => ({
        id: s.id,
        order: s.order,
        kind: s.kind,
        length: s.length,
    });
    const beforeSnapshot = sections(state).map(stable);

    // a shift-click set of the first two, b active.
    selectSection(a);
    selectSection(b, "toggle");
    expect(editor.sections.ids.size).toBe(2);

    expect(joinSections(h, state, [a, b])).toBe(a); // the head (lowest order) survives
    expect(sections(state).map((s) => s.id)).toEqual([a, c]);
    expect(h.undo.length).toBe(3); // two appends + ONE bulk join

    undo(h, state);
    expect(sections(state).map(stable)).toEqual(beforeSnapshot); // byte-identical (stable fields)
    // the selection SET restored (undo restores both, per the SelectionHook).
    expect([...editor.sections.ids].sort((x, y) => x - y)).toEqual([a, b].sort((x, y) => x - y));

    redo(h, state);
    expect(sections(state).map((s) => s.id)).toEqual([a, c]);
});

test("joinSections refuses (records nothing) on a NON-CONTIGUOUS set — a gap in the run", () => {
    clearSelection();
    const { state, sec: a } = nodes();
    const h = createHistory();
    const b = appendSection(h, state, SectionKind.Geo);
    const c = appendSection(h, state, SectionKind.Geo);
    expect(joinSections(h, state, [a, c])).toBeNull(); // b sits between — not a run
    expect(sections(state).map((s) => s.id)).toEqual([a, b, c]); // untouched
    expect(h.undo.length).toBe(2); // only the two appends
});

test("joinSections refuses (records nothing) ACROSS kinds", () => {
    clearSelection();
    const { state, sec: a } = nodes(); // geo
    const h = createHistory();
    const b = appendSection(h, state, SectionKind.Force);
    expect(joinSections(h, state, [a, b])).toBeNull();
    expect(sections(state).length).toBe(2); // untouched
    expect(h.undo.length).toBe(1); // only the append
});

test("joinSections refuses (records nothing) on a set smaller than 2 — nothing to join", () => {
    clearSelection();
    const { state, sec: a } = nodes();
    const h = createHistory();
    expect(joinSections(h, state, [a])).toBeNull();
    expect(joinSections(h, state, [])).toBeNull();
    expect(h.undo.length).toBe(0);
});

test(
    "joinSections keeps BOTH boundary keyframes when two independently-authored neighbors " +
        "disagree in value (the value guard, at the joinSections layer — `ops.test.ts`'s " +
        "`joinNext` pin is the substrate-layer twin; this is the bulk op stage 5 adds and wires " +
        "to the UI, never exercised through it before)",
    () => {
        clearSelection();
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        const a = createSection(state, 0, SectionKind.Force, 20);
        createForcePoint(state, a, 10, 1);
        createForcePoint(state, a, 20, 3); // A's own boundary keyframe: g=3
        const b = createSection(state, 1, SectionKind.Force, 20);
        createForcePoint(state, b, 0, 5); // B's own boundary keyframe: g=5 — DISAGREES
        createForcePoint(state, b, 10, 2);
        const h = createHistory();

        expect(joinSections(h, state, [a, b])).toBe(a);

        const after = sectionForces(state, a).map((p) => ({ s: p.s, g: p.g }));
        // both boundary keyframes survive, at the same s (20) — nothing merged.
        expect(after).toEqual([
            { s: 10, g: 1 },
            { s: 20, g: 3 },
            { s: 20, g: 5 },
            { s: 30, g: 2 },
        ]);
    },
);

test("joinSections refuses (records nothing) on a stale id", () => {
    clearSelection();
    const { state, sec: a } = nodes();
    const h = createHistory();
    const b = appendSection(h, state, SectionKind.Geo);
    expect(joinSections(h, state, [a, b, 99999])).toBeNull();
    expect(sections(state).map((s) => s.id)).toEqual([a, b]); // untouched
    expect(h.undo.length).toBe(1); // only the append
});

// ── sticky append length, per section kind ──────────────
// session-level module state in track.ts, not ECS/undo: a freshly appended piece starts at the
// last length COMMITTED by hand for its kind — a force section's extent trim, a geo section's
// chord (the polar length manipulator). Both start at EXTEND_DIST. reset before each test — it's
// process-shared, not per-track — so one test's commit can't leak into the next.
beforeEach(() => {
    setStickyLen(SectionKind.Force, EXTEND_DIST);
    setStickyLen(SectionKind.Geo, EXTEND_DIST);
});

test("a fresh append gets EXTEND_DIST (DEFAULT_FORCE_LEN) before anything has committed", () => {
    const { state } = nodes();
    const h = createHistory();
    const force = appendSection(h, state, SectionKind.Force);
    expect(sections(state).find((s) => s.id === force)?.length).toBe(EXTEND_DIST);
});

test("a committed extent-trim becomes the next append's default length", () => {
    const { state } = nodes();
    const h = createHistory();
    const force = appendSection(h, state, SectionKind.Force); // length EXTEND_DIST (24)
    beginLength(state, force);
    setSectionLength(state, force, 40); // live drag write (repeatable, as a real drag would do)
    commitLength(h, state, force, true); // the gesture COMMITS, armed — this is the one update site
    expect(stickyLen(SectionKind.Force)).toBe(40);

    const force2 = appendSection(h, state, SectionKind.Force);
    expect(sections(state).find((s) => s.id === force2)?.length).toBe(40);
});

test("undoing the append that used the sticky value doesn't roll the sticky value back", () => {
    const { state } = nodes();
    const h = createHistory();
    const force = appendSection(h, state, SectionKind.Force);
    beginLength(state, force);
    setSectionLength(state, force, 40);
    commitLength(h, state, force, true);
    expect(stickyLen(SectionKind.Force)).toBe(40);

    const force2 = appendSection(h, state, SectionKind.Force);
    undo(h, state); // undoes the SECOND append (restoreAll) — the section is gone
    expect(sections(state).some((s) => s.id === force2)).toBe(false);
    expect(stickyLen(SectionKind.Force)).toBe(40); // module state, untouched by undo

    const force3 = appendSection(h, state, SectionKind.Force); // still echoes the committed trim
    expect(sections(state).find((s) => s.id === force3)?.length).toBe(40);
});

test("a degenerate committed extent floors at MIN_FORCE_LEN, never poisoning the next append", () => {
    const { state } = nodes();
    const h = createHistory();
    const force = appendSection(h, state, SectionKind.Force);
    beginLength(state, force);
    setSectionLength(state, force, 0); // a drag past the floor — the setter clamps the section…
    commitLength(h, state, force, true);
    expect(stickyLen(SectionKind.Force)).toBe(MIN_FORCE_LEN); // …and the committed value carries the clamp through

    const force2 = appendSection(h, state, SectionKind.Force);
    expect(sections(state).find((s) => s.id === force2)?.length).toBe(MIN_FORCE_LEN);

    // the sticky store holds the floor on its own too, not just by inheriting `setSectionLength`'s
    // clamp: it's the value the NEXT append is seeded from, so it can never go sub-floor.
    setStickyLen(SectionKind.Force, 0.1);
    expect(stickyLen(SectionKind.Force)).toBe(MIN_FORCE_LEN);
});

// the geo half of the same mechanism: the authored length is a node's CHORD, committed by the
// polar length manipulator (drag or arrow nudge, both through `commitChord`), and it seeds the
// next appended segment — `extend`'s reach and a fresh geo section's seed node alike.
test("a committed length adjust becomes the next appended segment's chord", () => {
    const { state, sec } = nodes();
    const h = createHistory();
    const tip = handleAt(state, sec, 1);
    if (tip === null) throw new Error("no tip");
    beginMove(state, sec);
    Handle.pos.set(tip, 30, 0); // the manipulator's live write, landing a 30 m chord
    commitChord(h, state, tip, true); // the gesture COMMITS, armed — the one geo update site
    expect(stickyLen(SectionKind.Geo)).toBe(30);

    const added = extendTrack(h, state, sec);
    expect(Handle.pos.x.get(added)).toBeCloseTo(60, 6); // 30 m past the 30 m tip, straight on
});

test("the sticky chord also seeds a freshly appended geo section", () => {
    const { state, sec } = nodes();
    const h = createHistory();
    const tip = handleAt(state, sec, 1);
    if (tip === null) throw new Error("no tip");
    beginMove(state, sec);
    Handle.pos.set(tip, 30, 0);
    commitChord(h, state, tip, true);

    const geo = appendSection(h, state, SectionKind.Geo);
    expect(poseOf(state, geo, 1).x).toBeCloseTo(30, 6); // its seed node, not EXTEND_DIST
});

test("an angle adjust leaves the sticky chord alone — it commits bare", () => {
    const { state, sec } = nodes();
    const h = createHistory();
    const tip = handleAt(state, sec, 1);
    if (tip === null) throw new Error("no tip");
    beginMove(state, sec);
    Handle.pos.set(tip, 0, EXTEND_DIST); // same chord, rotated a quarter turn
    commit(h); // the angle axis commits bare (controls.ts) — nothing to record
    expect(stickyLen(SectionKind.Geo)).toBe(EXTEND_DIST);
});

test("node 0 has no chord to remember — commitChord still records the undo entry", () => {
    const { state, sec } = nodes();
    const h = createHistory();
    const anchor = handleAt(state, sec, 0);
    if (anchor === null) throw new Error("no anchor");
    beginMove(state, sec);
    Handle.pos.set(anchor, 0, 3);
    commitChord(h, state, anchor, true);
    expect(stickyLen(SectionKind.Geo)).toBe(EXTEND_DIST); // untouched
    expect(h.undo.length).toBe(1); // but the move is undoable
});

test("a geo convert resets to the literal seed, never the sticky chord", () => {
    const { state, sec } = nodes();
    const h = createHistory();
    const tip = handleAt(state, sec, 1);
    if (tip === null) throw new Error("no tip");
    beginMove(state, sec);
    Handle.pos.set(tip, 30, 0);
    commitChord(h, state, tip, true);

    const force = appendSection(h, state, SectionKind.Force);
    convertSection(h, state, force); // force → geo: the destructive reset, no append to echo
    expect(poseOf(state, force, 1).x).toBeCloseTo(EXTEND_DIST, 6);
});

test("a solve landing does NOT update the sticky value", () => {
    const { state, sec: geo } = nodes();
    const h = createHistory();
    solveForce(h, state, geo, {
        points: [
            { s: 0, g: 1 },
            { s: 77, g: 1 },
        ],
        length: 77,
    });
    expect(sections(state).find((s) => s.id === geo)?.length).toBe(77); // the solve DID land
    expect(stickyLen(SectionKind.Force)).toBe(EXTEND_DIST); // but the sticky default is untouched

    const force = appendSection(h, state, SectionKind.Force);
    expect(sections(state).find((s) => s.id === force)?.length).toBe(EXTEND_DIST); // not 77
});

// kex2d-provenance stage 1: `solveForce` stamps provenance off the pre-solve snapshot it already
// captures — a same-session reverse convert (stage 2/3) will consult it, not landed here.
test("solveForce stamps provenance: payload is the pre-solve section, token matches the landed state", () => {
    const { state, sec: geo } = bakedNodes();
    const h = createHistory();
    const before = snapshotSection(state, geo);

    solveForce(h, state, geo, {
        points: [
            { s: 0, g: 1 },
            { s: 77, g: 1 },
        ],
        length: 77,
    });

    const prov = readProvenance(geo);
    expect(prov).toBeDefined();
    expect(prov?.payload).toEqual(before); // the pre-solve geo section, not the landed force one
    expect(prov?.entry).toEqual(sectionInfo.get(geo)?.entry);

    // token matches the LANDED state: re-baking with no further edit and re-stamping (a second
    // solve landing would do this) reproduces the same token — the honest re-hash of what's live.
    state.step(0);
    const after = snapshotSection(state, geo);
    stampProvenance(state, geo, after);
    expect(readProvenance(geo)?.token).toBe(prov?.token);
});

test("a section edit after a solve landing breaks its stamped token", () => {
    const { state, sec: geo } = bakedNodes();
    const h = createHistory();
    solveForce(h, state, geo, {
        points: [
            { s: 0, g: 1 },
            { s: 77, g: 1 },
        ],
        length: 77,
    });
    const stamped = readProvenance(geo)?.token;

    setSectionLength(state, geo, 40); // an edit to the landed section's own content
    state.step(0);
    stampProvenance(state, geo, snapshotSection(state, geo));
    expect(readProvenance(geo)?.token).not.toBe(stamped);
});

test("a Track.domain flip after a solve landing does NOT break its stamped token (S6: domain is a display lens)", () => {
    // `Track.domain` used to ride the token because a flip converted the section's own stored
    // numbers — S6 retired that conversion entirely, so a flip changes no authored component
    // and the token stays stable across one.
    const { state, eid, sec: geo } = bakedNodes();
    const h = createHistory();
    solveForce(h, state, geo, {
        points: [
            { s: 0, g: 1 },
            { s: 77, g: 1 },
        ],
        length: 77,
    });
    const stamped = readProvenance(geo)?.token;

    Track.domain.set(eid, 1); // Domain.Time — raw write, same as domain.ts's own
    state.step(0);
    stampProvenance(state, geo, snapshotSection(state, geo));
    expect(readProvenance(geo)?.token).toBe(stamped);
});

test("solveForce's stamp never changes authoredHash — no-churn", () => {
    const { state, sec: geo } = bakedNodes();
    const h = createHistory();
    solveForce(h, state, geo, {
        points: [
            { s: 0, g: 1 },
            { s: 77, g: 1 },
        ],
        length: 77,
    });
    const withStamp = authoredHash(state);

    // an identical solve on a fresh, un-stamped track lands the same document — proves the stamp
    // recorded alongside it contributed nothing to the hash.
    const fresh = bakedNodes();
    const h2 = createHistory();
    solveForce(h2, fresh.state, fresh.sec, {
        points: [
            { s: 0, g: 1 },
            { s: 77, g: 1 },
        ],
        length: 77,
    });
    // section/point ids are per-run allocator artifacts (`nextSectionId`/`nextForceId`), not
    // authored content — normalize them out before comparing, same as the bake-hash pin above.
    const norm = (s: string) => s.replace(/\|S\d+:/g, "|S:").replace(/,\d+=/g, ",p=");
    expect(norm(authoredHash(fresh.state))).toBe(norm(withStamp));
});

// the sticky-commit gate (kex2d-gesture-residue stage 1): a gesture that lands its live writes
// without ever clearing the drag dead-zone latch — a click-vs-drag release the caller resolves as
// `armed=false` — must not stamp the sticky default. It still commits the entry: the live writes
// already happened (a click-and-release-elsewhere scrub, or a nudge that lands off the latch), so
// history still owes an undoable record, just no sticky update. Both directions mirror each other
// (`Timeline.svelte`'s extent trim and the geo length manipulator's `commitChord`).

test("commitLength armed=false leaves the sticky value untouched but still commits the entry", () => {
    const { state } = nodes();
    const h = createHistory();
    const force = appendSection(h, state, SectionKind.Force); // length EXTEND_DIST
    beginLength(state, force);
    setSectionLength(state, force, 40); // the live write landed regardless of arming
    commitLength(h, state, force, false); // not armed — the trim's dead-zone latch never cleared
    expect(stickyLen(SectionKind.Force)).toBe(EXTEND_DIST); // untouched, not stamped to 40
    expect(sections(state).find((s) => s.id === force)?.length).toBe(40); // the entry still committed

    undo(h, state);
    expect(sections(state).find((s) => s.id === force)?.length).toBe(EXTEND_DIST); // undoable
});

test("commitChord armed=false leaves the sticky value untouched but still commits the entry", () => {
    const { state, sec } = nodes();
    const h = createHistory();
    const tip = handleAt(state, sec, 1);
    if (tip === null) throw new Error("no tip");
    beginMove(state, sec);
    Handle.pos.set(tip, 30, 0); // the live write landed regardless of arming
    commitChord(h, state, tip, false); // not armed
    expect(stickyLen(SectionKind.Geo)).toBe(EXTEND_DIST); // untouched, not stamped to 30
    expect(poseOf(state, sec, 1).x).toBe(30); // the move still committed

    undo(h, state);
    expect(poseOf(state, sec, 1).x).toBeCloseTo(EXTEND_DIST, 6); // undoable
});

// ── track initial speed (v0, S3) — DERIVED from the track-start one-shot, its own
// structurally distinct point kind (never a `Strip`): `addOneShot`/`deleteOneShot`
// (`history.ts`) are its create/delete undo entries — there is no drag gesture (fixed at
// `d = 0`, no keyframe curve to sample) ──────────────────────────────────

test("with no one-shot, the derived entry speed falls back to V0", () => {
    const { state } = nodes();
    expect(entrySpeed(state)).toBe(V0);
});

test("addOneShot authors the one-shot and records an undoable create; undo/redo carry the derived entry speed", () => {
    const { state } = nodes();
    const h = createHistory();
    const id = addOneShot(h, state, 18);
    expect(entryOneShot(state)?.id).toBe(id);
    expect(entrySpeed(state)).toBe(18);
    expect(h.undo.length).toBe(1);

    undo(h, state);
    expect(entryOneShot(state)).toBeUndefined();
    expect(entrySpeed(state)).toBeCloseTo(V0, 6);

    redo(h, state);
    expect(entryOneShot(state)?.id).toBe(id);
    expect(entrySpeed(state)).toBeCloseTo(18, 6);
});

test("a no-move keyframe-drag release records nothing", () => {
    const { state } = nodes();
    const h = createHistory();
    const ext = stripMinExtentAt(state, 0);
    if (!ext) throw new Error("no min extent");
    const stripId = createStrip(state, ext.start, ext.end, V0);
    if (stripId === null) throw new Error("strip refused");
    const kf = stripKeyframes(state, stripId)[0];
    beginStripKeyframeMove(state, kf.id);
    commit(h); // released without moving the keyframe
    expect(h.undo.length).toBe(0);
});

// B2: a multi-member nudge whose members are exactly one grid step (0.1) apart leapfrogs on
// undo when the restore writer refuses overlaps (`setStripKeyframe`, `track.ts:1039`) — member
// B's post-nudge station lands exactly on member A's PRE-nudge station, so restoring A first
// (still live-writing) sees B "already there" and refuses A's restore. `restoreStripKeyframe`
// (B2's fix, `track.ts`, mirroring `restoreForcePoint`) bypasses the guard for undo, matching
// the force side.
test("beginStripKeyframeMoves: undo restores byte-identical when a nudge leapfrogs members exactly one grid step apart (B2)", () => {
    const { state } = nodes();
    const h = createHistory();
    const stripId = addStrip(h, state, 0, 10, 8) as number;
    const a = addStripKeyframe(h, state, stripId, 5, 3); // members 0.1 apart —
    const b = addStripKeyframe(h, state, stripId, 5.1, 4); // the arm's own grid step

    // the shared-delta nudge: both members step back by exactly the grid quantum (-0.1), so
    // b's post-nudge station (5.0) lands exactly on a's PRE-nudge station (5).
    beginStripKeyframeMoves(state, [a, b]);
    setStripKeyframe(state, a, 4.9, 3);
    setStripKeyframe(state, b, 5.0, 4);
    commit(h);

    const byId = (id: number) => stripKeyframes(state, stripId).find((k) => k.id === id);
    expect(byId(a)?.s).toBeCloseTo(4.9, 6);
    expect(byId(b)?.s).toBeCloseTo(5.0, 6);

    undo(h, state);
    // byte-identical restore: BOTH members land back on their pre-nudge stations, never one
    // stuck at its nudged position because the other was "in the way" mid-restore.
    expect(byId(a)?.s).toBeCloseTo(5, 6); // this is the assertion the live-writer restore reds
    expect(byId(b)?.s).toBeCloseTo(5.1, 6);
});

test("deleteOneShot falls the derived entry speed back to V0; undo restores it", () => {
    const { state } = nodes();
    const h = createHistory();
    const id = addOneShot(h, state, 18);
    expect(entrySpeed(state)).toBe(18);

    deleteOneShot(h, state, id);
    expect(entryOneShot(state)).toBeUndefined();
    expect(entrySpeed(state)).toBe(V0);

    undo(h, state);
    expect(entryOneShot(state)?.id).toBe(id);
    expect(entrySpeed(state)).toBe(18);
});

test("setStartSpeed floors a zero/negative speed off zero", () => {
    const { state } = nodes();
    setStartSpeed(state, 0);
    expect(entrySpeed(state)).toBeGreaterThan(0); // never a zero/infinite-time start
    setStartSpeed(state, -5);
    expect(entrySpeed(state)).toBeGreaterThan(0);
});

test("convert force→geo undoes byte-identical to the authored force points", () => {
    const { state, sec } = nodes();
    const h = createHistory();
    convertSection(h, state, sec); // → force (clears the seed nodes)
    createForce(h, state, sec, 8, 1.5);
    createForce(h, state, sec, 16, 0.3);
    const before = points(state, sec);

    convertSection(h, state, sec); // → geo (clears the points)
    expect(sections(state)[0].kind).toBe(SectionKind.Geo);
    expect(points(state, sec)).toEqual([]);

    undo(h, state);
    expect(sections(state)[0].kind).toBe(SectionKind.Force);
    expect(points(state, sec)).toEqual(before); // the points restored exactly
});

test("tangent edit: the move gesture captures it, undo/redo restore mode + vectors", () => {
    const { state, sec } = nodes();
    const h = createHistory();
    addNode(state, sec, 40, 0); // node 1 interior (Auto — no stamp), node 2 the tip
    expect(handleTangent(state, sec, 2)).toBeUndefined(); // the tip is Auto to start

    // a no-op gesture (no edit) records nothing — the sameTangent path.
    beginMove(state, sec);
    commit(h);
    expect(h.undo.length).toBe(0);

    // edit the tip's tangent inside a move gesture — nodeSnapshot captures it, so commit
    // records one entry (the existing history mechanism, unchanged).
    const tan = { mode: TangentMode.Free, inX: 5, inY: -2, outX: 3, outY: 6 };
    beginMove(state, sec);
    setTangent(state, sec, 2, tan);
    commit(h);
    expect(h.undo.length).toBe(1);
    expect(handleTangent(state, sec, 2)).toEqual(tan);

    undo(h, state);
    expect(handleTangent(state, sec, 2)).toBeUndefined(); // reverted to Auto

    redo(h, state);
    expect(handleTangent(state, sec, 2)).toEqual(tan); // restored verbatim
});

test("resetTangent: the move gesture makes it undoable (clears an interior + the tip to live)", () => {
    const { state, sec } = nodes();
    const h = createHistory();
    addNode(state, sec, 40, 12); // node 1 interior (Auto), node 2 the tip
    addNode(state, sec, 70, 4); // node 2 now interior (Auto), node 3 the tip

    // author a Free corner on interior node 1, then Reset inside a move gesture → cleared back to
    // live (Auto), undoable as one entry.
    setTangent(state, sec, 1, { mode: TangentMode.Free, inX: 2, inY: 9, outX: 9, outY: -2 });
    const before1 = handleTangent(state, sec, 1);
    beginMove(state, sec);
    resetTangent(state, sec, 1);
    commit(h);
    expect(h.undo.length).toBe(1);
    expect(handleTangent(state, sec, 1)).toBeUndefined(); // cleared to live

    undo(h, state);
    expect(handleTangent(state, sec, 1)).toEqual(before1); // the Free corner restored verbatim
    redo(h, state);
    expect(handleTangent(state, sec, 1)).toBeUndefined();

    // Reset the tip (node 3): it clears back to live (Auto), undoable.
    setTangent(state, sec, 3, { mode: TangentMode.Free, inX: 5, inY: 5, outX: 5, outY: 5 });
    beginMove(state, sec);
    resetTangent(state, sec, 3);
    commit(h);
    expect(handleTangent(state, sec, 3)).toBeUndefined(); // live again

    undo(h, state);
    expect(handleTangent(state, sec, 3)?.mode).toBe(TangentMode.Free); // the authored tip restored
});

// ── selection across undo/redo (the injected selectionHook, feel round 9) ──
// a command snapshots the selection bracketing it: undo restores the PRE-command selection, redo the
// POST. a node is snapshotted by its stable (section, order) — restoreSection/restoreAll recycle the
// eid allocator LIFO, so a raw eid would remap to a DIFFERENT node after an undo — and re-resolved on
// restore. force/section snapshot by stable id, the START by a flag. a selection change alone is never
// a command. the hook is set at the top of this file, as the app injects it at boot.

/** clear the shared editor singleton (also cleared in beforeEach; kept explicit for readability). */
function clearSelection(): void {
    select(null);
}

test("undo re-resolves the pre-command node selection by (section, order), not raw eid", () => {
    // select an interior node, trim the tip (a DIFFERENT node), undo. the pre-trim selection (the
    // interior node) is restored, re-resolved to its new eid across the LIFO recycle.
    clearSelection();
    const { state, sec } = nodes(); // orders 0, 1
    addNode(state, sec, 40, 0); // order 2
    addNode(state, sec, 60, 0); // order 3 (the tip a trim removes)
    const h = createHistory();

    select(handleAt(state, sec, 2) as number); // an interior node
    trimTrack(h, state, sec); // removes order 3
    undo(h, state); // restoreSection respawns 0..3 — eids recycle

    const r = editor.selection;
    expect(r).not.toBeNull();
    expect(Handle.section.get(r as number)).toBe(sec);
    expect(Handle.order.get(r as number)).toBe(2); // same identity, new eid
});

test("tangent-edit sub-mode rides the restored selection across a trim-undo", () => {
    clearSelection();
    const { state, sec } = nodes();
    addNode(state, sec, 40, 0); // order 2
    addNode(state, sec, 60, 0); // order 3 (tip)
    const h = createHistory();

    enterTangentEdit(handleAt(state, sec, 2) as number); // a node whose eid recycles across the restore
    trimTrack(h, state, sec);
    undo(h, state);

    const r = editor.selection;
    expect(r).not.toBeNull();
    expect(Handle.order.get(r as number)).toBe(2);
    expect(editor.tangentEdit).toBe(r); // sub-mode re-resolved onto the same node
});

test("the pre-selection re-resolves across a whole-track (restoreAll) undo", () => {
    clearSelection();
    const { state, sec } = nodes();
    addNode(state, sec, 40, 0); // order 2
    const h = createHistory();

    select(handleAt(state, sec, 1) as number);
    appendSection(h, state, SectionKind.Geo); // undo → restoreAll(before), respawns every node
    undo(h, state);

    const r = editor.selection;
    expect(r).not.toBeNull();
    expect(Handle.section.get(r as number)).toBe(sec);
    expect(Handle.order.get(r as number)).toBe(1);
});

test("an open node menu closes across an undo (its contents go stale)", () => {
    clearSelection();
    const { state, sec } = nodes();
    addNode(state, sec, 40, 0); // order 2
    const h = createHistory();
    const eid = extendTrack(h, state, sec); // order 3 — the eid recycles across the restore

    openNodeMenu(10, 20, eid); // menu targeting the tip (checked mode + enablement computed now)
    expect(editor.nodeMenu).not.toBeNull();

    undo(h, state);
    expect(editor.nodeMenu).toBeNull(); // closed on restore rather than left retargeting a recycled eid
});

// the delete-then-undo repro: delete the tip (the previous auto-selects, done by the controls OUTSIDE
// history), undo → the RESTORED tip is selected, not the previous. RED before the fix — the old
// reconcile kept the CURRENT (previous) selection across the restore instead of the pre-delete tip.
test("delete tip → undo selects the restored tip, not the auto-selected previous; redo re-selects previous", () => {
    clearSelection();
    const { state, sec } = nodes();
    addNode(state, sec, 40, 0); // order 2
    addNode(state, sec, 60, 0); // order 3 (the tip)
    const h = createHistory();

    select(handleAt(state, sec, 3) as number); // the user picks the tip to delete
    trimTrack(h, state, sec); // removes order 3
    select(handleAt(state, sec, 2) as number); // the controls auto-select the promoted tip (previous)
    expect(Handle.order.get(editor.selection as number)).toBe(2); // the repro: previous now selected

    undo(h, state); // ← the fix: restores the PRE-delete selection (the tip, re-created as order 3)
    expect(editor.selection).not.toBeNull();
    expect(Handle.order.get(editor.selection as number)).toBe(3); // the restored tip, not the previous

    redo(h, state); // re-delete → the POST-delete selection (the previous, order 2)
    expect(Handle.order.get(editor.selection as number)).toBe(2);
});

test("a command executed with nothing selected round-trips selection cleanly (stays empty)", () => {
    clearSelection();
    const { state, sec } = nodes();
    const h = createHistory();
    expect(editor.selection).toBeNull();

    extendTrack(h, state, sec); // pre = nothing selected (the controls don't select here)
    undo(h, state);
    expect(editor.selection).toBeNull(); // pre (null) restored
    redo(h, state);
    expect(editor.selection).toBeNull(); // post (also null) restored
});

// the substrate is a per-kind SET (single-select the size-1 case), so the hook snapshots the whole
// set by stable form and re-resolves each member across the eid recycle — the same recycle-safety
// law the scalar snapshot followed, now over a set. active rides along by its own stable form.
test("a multi-node selection set restores by (section, order) across an eid recycle, active preserved", () => {
    clearSelection();
    const { state, sec } = nodes(); // orders 0, 1
    addNode(state, sec, 40, 0); // order 2
    addNode(state, sec, 60, 0); // order 3
    const h = createHistory();

    // a shift-click set of three nodes, the last toggled-in active.
    select(handleAt(state, sec, 1) as number);
    select(handleAt(state, sec, 2) as number, "toggle");
    select(handleAt(state, sec, 3) as number, "toggle");
    expect(editor.nodes.ids.size).toBe(3);
    expect(Handle.order.get(editor.nodes.active as number)).toBe(3);

    // a whole-track structural op — restoreAll on undo respawns every node, so eids recycle LIFO.
    appendSection(h, state, SectionKind.Geo);
    undo(h, state);

    // the SET restored, each member re-resolved to its new eid by stable (section, order).
    const restored = [...editor.nodes.ids]
        .map((e) => Handle.order.get(e as number))
        .sort((a, b) => a - b);
    expect(restored).toEqual([1, 2, 3]);
    expect(editor.nodes.active).not.toBeNull();
    expect(Handle.order.get(editor.nodes.active as number)).toBe(3); // active preserved by stable form
});

// when the snapshotted active can't be re-resolved on restore (its node was deleted), rebuild
// (editor.ts) promotes the LAST-inserted survivor, not the oldest. driven straight through the hook's
// snapshot → delete-the-active → restore: a genuine undo/redo always restores a track consistent with
// its own snapshot, so the active-drop branch is reached by removing the active between capture and
// restore. ≥2 survivors, so a regression to first-survivor is caught (order 1 vs the promoted 2).
test("restore promotes the last-inserted survivor when the snapshotted active didn't survive", () => {
    clearSelection();
    const { state, sec } = nodes(); // orders 0, 1
    addNode(state, sec, 40, 0); // order 2
    addNode(state, sec, 60, 0); // order 3 (the active tip)
    const h = createHistory();

    // a three-node set, the tip active, insertion order [1, 2, 3].
    select(handleAt(state, sec, 1) as number);
    select(handleAt(state, sec, 2) as number, "toggle");
    select(handleAt(state, sec, 3) as number, "toggle");
    const snap = selectionHook.snapshot(state);

    trimTrack(h, state, sec); // delete the active (order 3) — it can no longer be re-resolved
    expect(handleAt(state, sec, 3)).toBeNull();

    selectionHook.restore(state, snap);
    const restored = [...editor.nodes.ids].map((e) => Handle.order.get(e)).sort((a, b) => a - b);
    expect(restored).toEqual([1, 2]); // the dead active dropped, the two survivors kept
    expect(editor.nodes.active).not.toBeNull();
    expect(Handle.order.get(editor.nodes.active as number)).toBe(2); // last-inserted survivor, not order 1
});

// the boundary Reset (kex2d-geo-ux stage 1; re-create semantics kex2d-idioms stage 9): a geo→geo
// boundary is one node at the UI — the upstream tip + the coincident downstream section's node 0.
// Reset on that one node RE-CREATES the tip (the authorable half: default-chord continuation,
// tangent Auto) and clears the downstream node-0 half, in ONE undoable entry. the downstream
// node 0 stays pinned at its local origin — the downstream section rides the moved exit rigidly
// (the rigid-placement invariant), so the boundary coincidence holds by construction.
test("boundary Reset re-creates the tip and clears the stitched downstream node-0, one undo", () => {
    const state = new State();
    createTrack(state);
    const a = createSection(state, 0, SectionKind.Geo, 0);
    addNode(state, a, 0, 0);
    addNode(state, a, 24, 0);
    const b = createSection(state, 1, SectionKind.Geo, 0);
    addNode(state, b, 0, 0);
    addNode(state, b, 24, 0);

    const tipA = handleAt(state, a, 1);
    const node0B = handleAt(state, b, 0);
    if (tipA === null || node0B === null) throw new Error("setup missing");
    expect(stitchNode(state, tipA)).toBe(node0B); // the boundary is one node, stitched

    // author both halves: MOVE the tip off its creation pose, tangent it, and author the
    // downstream node-0 entry handle.
    Handle.pos.set(tipA, 30, 10);
    Handle.theta.set(tipA, 0.5);
    setTangent(state, a, 1, { mode: TangentMode.Free, inX: 3, inY: 9, outX: 9, outY: -3 });
    setTangent(state, b, 0, { mode: TangentMode.Free, inX: 1, inY: 0, outX: 8, outY: 4 });
    const beforeA = nodeSnapshot(state, a);
    const beforeB = nodeSnapshot(state, b);

    const h = createHistory();
    resetNodes(h, state, tipA, stitchNode(state, tipA));
    // the tip re-created: back at the continuation along node 0's exit (θ = 0) at EXTEND_DIST,
    // heading re-seeded flat, tangent cleared; the downstream half cleared, its position pinned.
    expect(Handle.pos.x.get(tipA)).toBeCloseTo(EXTEND_DIST, 5);
    expect(Handle.pos.y.get(tipA)).toBeCloseTo(0, 5);
    expect(Handle.theta.get(tipA)).toBeCloseTo(0, 6);
    expect(handleTangent(state, a, 1)).toBeUndefined();
    expect(handleTangent(state, b, 0)).toBeUndefined();
    expect(Handle.pos.x.get(node0B)).toBe(0);
    expect(h.undo.length).toBe(1);

    // one Ctrl+Z restores BOTH halves byte-identical (the single-transaction requirement).
    undo(h, state);
    expect(sameNodes(nodeSnapshot(state, a), beforeA)).toBe(true);
    expect(sameNodes(nodeSnapshot(state, b), beforeB)).toBe(true);
});

// the non-boundary path: with no stitch (the START node 0, an interior node, a final tip), Reset
// re-creates exactly the one node, one entry; undo is byte-identical (the snapshot mechanism).
test("single-node Reset (no stitch) re-creates just that node; undo round-trips byte-identical", () => {
    const { state, sec } = nodes();
    addNode(state, sec, 40, 15); // [0,1,2]
    const n1 = handleAt(state, sec, 1);
    if (n1 === null) throw new Error("node missing");
    Handle.pos.set(n1, 31, 17); // author: move node 1 off its creation pose + tangent it
    setTangent(state, sec, 1, { mode: TangentMode.Free, inX: 3, inY: 9, outX: 9, outY: -3 });
    const before = nodeSnapshot(state, sec);

    const h = createHistory();
    resetNodes(h, state, n1, null);
    // re-created: the default-chord continuation along node 0's flat exit, tangent Auto.
    expect(Handle.pos.x.get(n1)).toBeCloseTo(EXTEND_DIST, 5);
    expect(Handle.pos.y.get(n1)).toBeCloseTo(0, 5);
    expect(handleTangent(state, sec, 1)).toBeUndefined();
    expect(h.undo.length).toBe(1);
    undo(h, state);
    expect(sameNodes(nodeSnapshot(state, sec), before)).toBe(true); // byte-identical round trip
});

// a reset that changes nothing records no undo entry — a fresh node already sits at its
// creation state, so the `sameNodes` no-op guard keeps the stack clean (Reset's enablement is
// no longer gated on "has something to clear", so the guard is what a stray click leans on).
test("no-op Reset (node already at creation state) records nothing", () => {
    const { state, sec } = nodes(); // the fresh seed: node 1 at (EXTEND_DIST, 0), Auto, θ = 0
    const n1 = handleAt(state, sec, 1);
    if (n1 === null) throw new Error("node missing");
    const h = createHistory();
    resetNodes(h, state, n1, null);
    expect(h.undo.length).toBe(0);
});

// the bulk suffix reset ≡ deleting the suffix and re-extending fresh: members apply in
// ASCENDING order, each re-created against its already-reset predecessor, and the placement
// body is shared with `extend` — so the two paths land byte-equivalent node state (sticky at
// its default: Reset always uses the named default `EXTEND_DIST`, never the sticky length).
test("bulk suffix reset ≡ delete suffix + re-extend fresh, byte-equivalent", () => {
    setStickyLen(SectionKind.Geo, EXTEND_DIST); // pin sticky at the default for the twin
    const author = (state: State, sec: number): void => {
        // move nodes 2 + 3 off their creation poses and tangent node 2 — identical authoring
        // applied to both twins.
        const n2 = handleAt(state, sec, 2);
        const n3 = handleAt(state, sec, 3);
        if (n2 === null || n3 === null) throw new Error("setup missing");
        Handle.pos.set(n2, 55, 13);
        Handle.theta.set(n2, 0.4);
        setTangent(state, sec, 2, { mode: TangentMode.Free, inX: 2, inY: 9, outX: 9, outY: -2 });
        Handle.pos.set(n3, 80, -6);
        Handle.theta.set(n3, -0.3);
    };

    const twinA = fourNodes();
    author(twinA.state, twinA.sec);
    const h = createHistory();
    resetNodesBulk(h, twinA.state, [
        { section: twinA.sec, order: 3 }, // deliberately descending input — the op sorts ascending
        { section: twinA.sec, order: 2 },
    ]);
    expect(h.undo.length).toBe(1);
    // materialize A's snapshot BEFORE building the twin: component columns are module-level,
    // so a second State's identical eids overwrite the first's column data.
    const snapA = nodeSnapshot(twinA.state, twinA.sec);

    const twinB = fourNodes();
    author(twinB.state, twinB.sec);
    removeTrailingHandle(twinB.state, twinB.sec);
    removeTrailingHandle(twinB.state, twinB.sec);
    extend(twinB.state, twinB.sec);
    extend(twinB.state, twinB.sec);

    expect(sameNodes(snapA, nodeSnapshot(twinB.state, twinB.sec))).toBe(true);
});

// ── multiselect bulk ops (stage 4) ─────────────────────────────────────────────────
// the geo group move (`beginMoves`) and multi-delete (`trimSuffix`) each collapse to ONE undo entry
// over the affected section set; undo restores geometry AND the selection set (re-resolved by stable
// (section, order)). the selection hook is wired at module load, so a snapshot walks `editor.nodes`.

function fourNodes(): { state: State; sec: number; e: number[] } {
    const { state, sec } = nodes(); // orders 0,1
    addNode(state, sec, 2 * EXTEND_DIST, 0); // order 2
    addNode(state, sec, 3 * EXTEND_DIST, 0); // order 3 (the tip)
    const e = [0, 1, 2, 3].map((o) => handleAt(state, sec, o) as number);
    return { state, sec, e };
}

test("bulk move: a multi-node gesture is ONE undo entry; undo restores geometry, selection kept", () => {
    const { state, sec, e } = fourNodes();
    const h = createHistory();
    selectNodes([e[1], e[2]], e[2]); // a 2-node set (orders 1,2), active order 2
    const before1 = poseOf(state, sec, 1);
    const before2 = poseOf(state, sec, 2);

    // the gesture: open over the affected section, write both nodes' new local positions, commit.
    beginMoves(state, [sec]);
    Handle.pos.set(e[1], before1.x + 5, before1.y + 3);
    Handle.pos.set(e[2], before2.x + 5, before2.y + 3);
    commit(h);
    expect(h.undo.length).toBe(1); // one entry for the whole group move

    expect(poseOf(state, sec, 1).x).toBeCloseTo(before1.x + 5, 9);
    undo(h, state);
    expect(poseOf(state, sec, 1)).toEqual(before1); // geometry restored
    expect(poseOf(state, sec, 2)).toEqual(before2);
    // a move destroys no node, so the selection eids stay valid and are untouched by undo.
    expect(editor.nodes.ids).toEqual(new Set([e[1], e[2]]));
    expect(editor.nodes.active).toBe(e[2]);
});

test("bulk move: a no-op gesture (no node moved) records nothing", () => {
    const { state, sec, e } = fourNodes();
    const h = createHistory();
    selectNodes([e[1], e[2]], e[2]);
    beginMoves(state, [sec]);
    commit(h); // no writes between begin and commit
    expect(h.undo.length).toBe(0);
});

test("bulk delete (trimSuffix): k trims are ONE entry; undo restores geometry + the selection set", () => {
    const { state, sec, e } = fourNodes();
    const h = createHistory();
    selectNodes([e[2], e[3]], e[3]); // the suffix run {2,3}
    const pose2 = poseOf(state, sec, 2);
    const pose3 = poseOf(state, sec, 3);

    expect(trimSuffix(h, state, sec, 2)).toBe(true);
    select(handleAt(state, sec, 1)); // the handler prunes the selection to the surviving tip
    expect(orders(state, sec)).toEqual([0, 1]);
    expect(h.undo.length).toBe(1); // one entry for both trims

    undo(h, state);
    expect(orders(state, sec)).toEqual([0, 1, 2, 3]); // geometry restored
    expect(poseOf(state, sec, 2)).toEqual(pose2);
    expect(poseOf(state, sec, 3)).toEqual(pose3);
    // the selection set is restored by stable (section, order) → the re-spawned eids.
    const restored = [...editor.nodes.ids].map((eid) => Handle.order.get(eid)).sort();
    expect(restored).toEqual([2, 3]);
    expect(Handle.order.get(editor.nodes.active as number)).toBe(3); // active re-anchored
});

test("bulk delete: trimSuffix never re-heads the promoted tip (stage 7b — same rule as single)", () => {
    // trimSuffix loops removeTrailingHandle, the one delete site; the promoted tip's
    // frozen heading survives a bulk trim exactly as a single delete's.
    const { state, sec } = fourNodes();
    const node1 = handleAt(state, sec, 1) as number;
    Handle.pos.set(node1, 16, 30); // off the chord — a re-head would move the heading
    const frozen = Handle.theta.get(node1);
    const h = createHistory();
    expect(trimSuffix(h, state, sec, 2)).toBe(true); // 0,1,2,3 → 0,1
    expect(orders(state, sec)).toEqual([0, 1]);
    expect(Handle.theta.get(node1)).toBe(frozen);
});

test("bulk delete: trimSuffix floors at 2 nodes even when asked for more", () => {
    const { state, sec, e } = fourNodes();
    const h = createHistory();
    selectNodes([e[1], e[2], e[3]], e[3]);
    // asking to trim 3 (down to node 0) stops at the 2-node floor — 2 removed, not 3.
    expect(trimSuffix(h, state, sec, 3)).toBe(true);
    expect(orders(state, sec)).toEqual([0, 1]);
});

test("bulk reset: clears every selected member's tangent in one entry; undo restores them", () => {
    const { state, sec, e } = fourNodes();
    const h = createHistory();
    // author explicit tangents on nodes 1 and 2 (Free), so the reset has something to clear.
    for (const o of [1, 2]) {
        const seed = seedTangent(state, sec, o, TangentMode.Free);
        if (seed) setTangent(state, sec, o, seed);
    }
    expect(handleTangent(state, sec, 1)).not.toBeUndefined();
    resetNodesBulk(h, state, [
        { section: sec, order: 1 },
        { section: sec, order: 2 },
    ]);
    expect(handleTangent(state, sec, 1)).toBeUndefined(); // cleared to Auto
    expect(handleTangent(state, sec, 2)).toBeUndefined();
    expect(h.undo.length).toBe(1);
    undo(h, state);
    expect(handleTangent(state, sec, 1)).not.toBeUndefined(); // restored
    expect(handleTangent(state, sec, 2)).not.toBeUndefined();
    void e;
});

test("bulk reset: a set already at creation state records nothing", () => {
    // `fourNodes` lays every node at the default-chord continuation with no tangent, so a bulk
    // Reset re-creates each one exactly where it already sits — the `sameNodes` no-op guard is
    // what keeps a stray click off the stack (enablement is no longer gated on "has something
    // to clear").
    const { state, sec } = fourNodes();
    const h = createHistory();
    resetNodesBulk(h, state, [
        { section: sec, order: 1 },
        { section: sec, order: 2 },
    ]);
    expect(h.undo.length).toBe(0);
});

test("bulk tangent-mode: sets every member's mode in one entry; picking Aligned on live is a no-op", () => {
    const { state, sec } = fourNodes();
    const h = createHistory();
    // Free on both interior/tip members → both turn explicit Free.
    setTangentModes(
        h,
        state,
        [
            { section: sec, order: 1 },
            { section: sec, order: 2 },
        ],
        TangentMode.Free,
    );
    expect(handleTangent(state, sec, 1)?.mode).toBe(TangentMode.Free);
    expect(handleTangent(state, sec, 2)?.mode).toBe(TangentMode.Free);
    expect(h.undo.length).toBe(1);

    // Aligned on an all-live set is a no-op (inference already displays Aligned — no stamp).
    const { state: s2, sec: sec2 } = fourNodes();
    const h2 = createHistory();
    setTangentModes(h2, s2, [{ section: sec2, order: 1 }], TangentMode.Aligned);
    expect(h2.undo.length).toBe(0);
    expect(handleTangent(s2, sec2, 1)).toBeUndefined();
});
