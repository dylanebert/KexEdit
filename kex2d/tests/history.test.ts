import { State } from "@dylanebert/shallot";
import { beforeEach, expect, test } from "bun:test";
import {
    editor,
    enterTangentEdit,
    openNodeMenu,
    select,
    selectionHook,
    selectSection,
    selectStart,
} from "../src/editor";
import {
    appendSection,
    beginForceMove,
    beginMove,
    beginV0,
    commit,
    convertSection,
    createForce,
    createHistory,
    deleteForce,
    extendTrack,
    redo,
    resetTangents,
    setSelectionHook,
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
    Handle,
    handleAt,
    handleTangent,
    reheadOnDrag,
    resetTangent,
    SectionKind,
    sectionForces,
    sectionHandles,
    sections,
    setForcePoint,
    setTangent,
    setTrackV0,
    Track,
    V0,
} from "../src/track";
import { TangentMode } from "../src/spline";

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

test("deleteForce: undo re-spawns the removed point verbatim", () => {
    const { state, sec } = nodes();
    const h = createHistory();
    const id = createForce(h, state, sec, 7, 0.2);
    deleteForce(h, state, id);
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
