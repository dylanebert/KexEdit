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
    beginForceMove,
    beginForceMoves,
    beginLength,
    beginMove,
    beginMoves,
    beginV0,
    commit,
    commitLength,
    convertSection,
    convertSections,
    createForce,
    createHistory,
    deleteForces,
    extendTrack,
    redo,
    removeSections,
    resetTangents,
    resetTangentsBulk,
    setForcesEase,
    setSelectionHook,
    setTangentModes,
    solveSection,
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
    editor.nodeMenu = null;
});
import { stitchNode } from "../src/tangents";
import {
    addNode,
    createSection,
    createTrack,
    EXTEND_DIST,
    forceEase,
    Handle,
    handleAt,
    handleTangent,
    MIN_FORCE_LEN,
    reheadOnDrag,
    resetTangent,
    SectionKind,
    sectionForces,
    sectionHandles,
    sections,
    seedTangent,
    setForcePoint,
    setSectionLength,
    setStickyLen,
    setTangent,
    setTrackV0,
    stickyLen,
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

test("trim: undo restores the removed node and the promoted tip's pre-trim heading", () => {
    const { state, sec } = nodes();
    addNode(state, sec, 40, 0); // node 2 (the tip); node 1 is now interior, heading frozen
    // shove interior node 1 off its chord so a trim's rehead of the promoted tip
    // actually changes its stored heading (guards the rehead round-trip).
    Handle.pos.set(handleAt(state, sec, 1) as number, 16, 30);
    const h = createHistory();

    const tipBefore = Handle.theta.get(handleAt(state, sec, 1) as number);
    const removed = poseOf(state, sec, 2);

    expect(trimTrack(h, state, sec)).toBe(true);
    expect(orders(state, sec)).toEqual([0, 1]);
    const tipAfter = Handle.theta.get(handleAt(state, sec, 1) as number);
    expect(tipAfter).not.toBe(tipBefore); // headLast reheaded the promoted tip

    undo(h, state);
    expect(orders(state, sec)).toEqual([0, 1, 2]);
    expect(poseOf(state, sec, 2)).toEqual(removed); // node back verbatim
    expect(Handle.theta.get(handleAt(state, sec, 1) as number)).toBe(tipBefore); // heading restored

    redo(h, state);
    expect(orders(state, sec)).toEqual([0, 1]);
    expect(Handle.theta.get(handleAt(state, sec, 1) as number)).toBe(tipAfter);
});

test("trim: undo restores the authored interior tangent the trim reset on promotion", () => {
    // deleting the trailing node resets the promoted (once-interior) node to Auto. undo must
    // restore its authored tangent verbatim — the reconciliation is captured in the trim's
    // after-snapshot, so the before-snapshot carries the original tangent.
    const { state, sec } = nodes();
    addNode(state, sec, 40, 0); // node 2 tip; node 1 interior
    const seed = seedTangent(state, sec, 1, TangentMode.Aligned);
    if (!seed) throw new Error("seed");
    setTangent(state, sec, 1, editTangent(seed, "out", 8, 8)); // author node 1's tangent
    const authored = handleTangent(state, sec, 1); // the f32-stored value undo must restore
    const h = createHistory();

    expect(trimTrack(h, state, sec)).toBe(true);
    expect(handleTangent(state, sec, 1)).toBeUndefined(); // promoted tip reset to Auto

    undo(h, state);
    expect(orders(state, sec)).toEqual([0, 1, 2]); // node 2 back
    expect(handleTangent(state, sec, 1)).toEqual(authored); // interior tangent restored verbatim

    redo(h, state);
    expect(handleTangent(state, sec, 1)).toBeUndefined(); // reset again
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

test("convertSections: flips EVERY section in a SET in ONE entry, regardless of its own kind (no shared destination)", () => {
    clearSelection();
    const { state, sec: a } = nodes(); // geo
    const h = createHistory();
    const b = appendSection(h, state, SectionKind.Force); // a mixed-kind chain: geo, force
    expect(sections(state).map((s) => s.kind)).toEqual([SectionKind.Geo, SectionKind.Force]);

    convertSections(h, state, [a, b]);
    // each section flipped its OWN kind independently — convert has no direction parameter to
    // converge on, so a mixed set stays mixed (just swapped), never collapsing to one kind.
    expect(sections(state).map((s) => s.kind)).toEqual([SectionKind.Force, SectionKind.Geo]);
    expect(h.undo.length).toBe(2); // the append + ONE bulk convert

    undo(h, state);
    expect(sections(state).map((s) => s.kind)).toEqual([SectionKind.Geo, SectionKind.Force]);
});

// ── sticky appended-section length (kex2d-geoforce-editor stage 5c) ──────────────
// session-level module state in track.ts, not ECS/undo: a freshly appended force section's
// default extent echoes the last COMMITTED extent-trim this session, starting at
// DEFAULT_FORCE_LEN (== EXTEND_DIST). reset before each test — it's process-shared, not
// per-track — so one test's commit can't leak into the next.
beforeEach(() => setStickyLen(EXTEND_DIST));

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
    commitLength(h, state, force); // the gesture COMMITS — this is the one update site
    expect(stickyLen()).toBe(40);

    const force2 = appendSection(h, state, SectionKind.Force);
    expect(sections(state).find((s) => s.id === force2)?.length).toBe(40);
});

test("undoing the append that used the sticky value doesn't roll the sticky value back", () => {
    const { state } = nodes();
    const h = createHistory();
    const force = appendSection(h, state, SectionKind.Force);
    beginLength(state, force);
    setSectionLength(state, force, 40);
    commitLength(h, state, force);
    expect(stickyLen()).toBe(40);

    const force2 = appendSection(h, state, SectionKind.Force);
    undo(h, state); // undoes the SECOND append (restoreAll) — the section is gone
    expect(sections(state).some((s) => s.id === force2)).toBe(false);
    expect(stickyLen()).toBe(40); // module state, untouched by undo

    const force3 = appendSection(h, state, SectionKind.Force); // still echoes the committed trim
    expect(sections(state).find((s) => s.id === force3)?.length).toBe(40);
});

test("a degenerate committed extent floors at MIN_FORCE_LEN, never poisoning the next append", () => {
    const { state } = nodes();
    const h = createHistory();
    const force = appendSection(h, state, SectionKind.Force);
    beginLength(state, force);
    setSectionLength(state, force, 0); // a drag past the floor — the setter clamps the section…
    commitLength(h, state, force);
    expect(stickyLen()).toBe(MIN_FORCE_LEN); // …and the committed value carries the clamp through

    const force2 = appendSection(h, state, SectionKind.Force);
    expect(sections(state).find((s) => s.id === force2)?.length).toBe(MIN_FORCE_LEN);

    // the sticky store holds the floor on its own too, not just by inheriting `setSectionLength`'s
    // clamp: it's the value the NEXT append is seeded from, so it can never go sub-floor.
    setStickyLen(0.1);
    expect(stickyLen()).toBe(MIN_FORCE_LEN);
});

test("a solve landing does NOT update the sticky value", () => {
    const { state, sec: geo } = nodes();
    const h = createHistory();
    solveSection(h, state, geo, {
        points: [
            { s: 0, g: 1 },
            { s: 77, g: 1 },
        ],
        length: 77,
        ds: 0.3,
    });
    expect(sections(state).find((s) => s.id === geo)?.length).toBe(77); // the solve DID land
    expect(stickyLen()).toBe(EXTEND_DIST); // but the sticky default is untouched

    const force = appendSection(h, state, SectionKind.Force);
    expect(sections(state).find((s) => s.id === force)?.length).toBe(EXTEND_DIST); // not 77
});

// ── track initial speed (v0) — a per-track scalar on the same gesture substrate ──

test("v0 scrub collapses to one entry; undo restores the speed, redo replays", () => {
    const { state, eid } = nodes();
    const h = createHistory();
    expect(Track.v0.get(eid)).toBe(V0); // the default seed

    beginV0(eid);
    setTrackV0(eid, 14); // live preview frames — not recorded individually
    setTrackV0(eid, 18);
    commit(h);

    expect(h.undo.length).toBe(1); // the whole scrub → one entry
    expect(Track.v0.get(eid)).toBe(18);

    undo(h, state);
    expect(Track.v0.get(eid)).toBe(V0);

    redo(h, state);
    expect(Track.v0.get(eid)).toBe(18);
});

test("a no-change v0 release records nothing", () => {
    const { eid } = nodes();
    const h = createHistory();
    beginV0(eid);
    commit(h); // released without changing the speed
    expect(h.undo.length).toBe(0);
});

test("setTrackV0 floors a zero/negative speed off zero", () => {
    const { eid } = nodes();
    setTrackV0(eid, 0);
    expect(Track.v0.get(eid)).toBeGreaterThan(0); // never a zero/infinite-time start
    setTrackV0(eid, -5);
    expect(Track.v0.get(eid)).toBeGreaterThan(0);
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

// the boundary Reset (kex2d-geo-ux stage 1): a geo→geo boundary is one node at the UI — the
// upstream tip + the coincident downstream section's node 0. Reset on the tip's node menu clears
// BOTH halves back to Auto in ONE undoable entry (each through its own section's reset path), so a
// single undo restores both. `resetTangents(tip, stitch)` is that grouping; `stitch === null`
// elsewhere is the plain single-node reset.
test("boundary Reset clears both the tip and the stitched downstream node-0 tangent, one undo", () => {
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

    // author both halves: the tip's own tangent AND the downstream node-0 entry handle.
    setTangent(state, a, 1, { mode: TangentMode.Free, inX: 3, inY: 9, outX: 9, outY: -3 });
    setTangent(state, b, 0, { mode: TangentMode.Free, inX: 1, inY: 0, outX: 8, outY: 4 });

    const h = createHistory();
    resetTangents(h, state, tipA, stitchNode(state, tipA));
    // both halves cleared back to live (Auto), one undo entry for the pair.
    expect(handleTangent(state, a, 1)).toBeUndefined();
    expect(handleTangent(state, b, 0)).toBeUndefined();
    expect(h.undo.length).toBe(1);

    // one Ctrl+Z restores BOTH halves (the single-transaction requirement).
    undo(h, state);
    expect(handleTangent(state, a, 1)).toBeDefined();
    expect(handleTangent(state, b, 0)).toBeDefined();
});

// the non-boundary path: with no stitch (the START node 0, an interior node, a final tip), Reset
// clears exactly the one node, one entry.
test("single-node Reset (no stitch) clears just that node", () => {
    const { state, sec } = nodes();
    addNode(state, sec, 40, 15); // [0,1,2]
    setTangent(state, sec, 1, { mode: TangentMode.Free, inX: 3, inY: 9, outX: 9, outY: -3 });
    const tip = handleAt(state, sec, 1);
    if (tip === null) throw new Error("node missing");

    const h = createHistory();
    resetTangents(h, state, tip, null);
    expect(handleTangent(state, sec, 1)).toBeUndefined();
    expect(h.undo.length).toBe(1);
    undo(h, state);
    expect(handleTangent(state, sec, 1)).toBeDefined();
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
    resetTangentsBulk(h, state, [
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

test("bulk reset: an all-live set records nothing (no tangent to clear)", () => {
    const { state, sec } = fourNodes();
    const h = createHistory();
    resetTangentsBulk(h, state, [
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
