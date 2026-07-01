import { State } from "@dylanebert/shallot";
import { expect, test } from "bun:test";
import {
    beginMove,
    beginPin,
    cancel,
    commit,
    createHistory,
    drop,
    erase,
    extendTrack,
    redo,
    trimTrack,
    undo,
} from "../src/history";
import { clearPins, findPin, pinsOf, setHandle, setPin } from "../src/pins";
import {
    addNode,
    createTrack,
    Handle,
    handleAt,
    lastHandle,
    reheadOnDrag,
    sortedHandles,
} from "../src/track";

// undo/redo over the pin store. each test uses a distinct trackEid + a fresh
// History; the pin store is a module singleton so we clear the track first.

function fresh(eid: number) {
    clearPins(eid);
    return createHistory();
}

const snap = (eid: number) => pinsOf(eid).map((p) => ({ index: p.index, value: p.value }));

test("undo of a drop removes the pin; redo restores it (same id, position)", () => {
    const eid = 200;
    const h = fresh(eid);
    const pin = drop(h, eid, 10, 2);
    expect(snap(eid)).toEqual([{ index: 10, value: 2 }]);
    expect(h.undo.length).toBe(1);

    undo(h);
    expect(pinsOf(eid)).toEqual([]);
    expect(h.redo.length).toBe(1);

    redo(h);
    expect(pinsOf(eid).map((p) => p.id)).toEqual([pin.id]); // same stable id
    expect(snap(eid)).toEqual([{ index: 10, value: 2 }]);
});

test("a drag gesture collapses to one undo entry", () => {
    const eid = 201;
    const h = fresh(eid);
    const pin = drop(h, eid, 10, 2); // entry 1

    beginPin(eid, pin.id);
    setPin(eid, pin.id, 12, 2.5); // live preview frames — not recorded individually
    setPin(eid, pin.id, 18, 4);
    setPin(eid, pin.id, 22, 5);
    commit(h); // entry 2 (the whole drag)

    expect(snap(eid)).toEqual([{ index: 22, value: 5 }]);
    expect(h.undo.length).toBe(2);

    undo(h); // undoes the whole drag at once → back to the drop state
    expect(snap(eid)).toEqual([{ index: 10, value: 2 }]);
});

test("cancel restores the pre-gesture state and records nothing", () => {
    const eid = 202;
    const h = fresh(eid);
    const pin = drop(h, eid, 10, 2);
    const before = h.undo.length;

    beginPin(eid, pin.id);
    setPin(eid, pin.id, 30, 6); // dragged away
    cancel();

    expect(snap(eid)).toEqual([{ index: 10, value: 2 }]); // restored
    expect(h.undo.length).toBe(before); // no new entry
});

test("a no-move gesture (a click) records nothing", () => {
    const eid = 203;
    const h = fresh(eid);
    const pin = drop(h, eid, 10, 2);
    const before = h.undo.length;
    beginPin(eid, pin.id);
    commit(h); // released without moving
    expect(h.undo.length).toBe(before);
});

test("undo of an erase restores the pin at its prior position", () => {
    const eid = 204;
    const h = fresh(eid);
    const a = drop(h, eid, 5, 1);
    const b = drop(h, eid, 15, 2);
    const c = drop(h, eid, 25, 3);

    erase(h, eid, b.id); // remove the middle pin
    expect(pinsOf(eid).map((p) => p.id)).toEqual([a.id, c.id]);

    undo(h);
    expect(pinsOf(eid).map((p) => p.id)).toEqual([a.id, b.id, c.id]); // back in place
});

test("a new edit clears the redo branch", () => {
    const eid = 205;
    const h = fresh(eid);
    drop(h, eid, 10, 2);
    undo(h);
    expect(h.redo.length).toBe(1);
    drop(h, eid, 40, 5); // a fresh edit
    expect(h.redo.length).toBe(0); // the prior redo branch is gone
});

test("a handle-drag gesture collapses to one undo entry; undo/redo restore the handle", () => {
    const eid = 206;
    const h = fresh(eid);
    const pin = drop(h, eid, 10, 2); // entry 1

    beginPin(eid, pin.id);
    setHandle(eid, pin.id, "r", 0.5, 1); // live preview frames — not recorded individually
    setHandle(eid, pin.id, "r", 0.7, 2.5);
    commit(h); // entry 2 (the whole handle drag)

    expect(h.undo.length).toBe(2);
    expect(findPin(eid, pin.id)?.hr).toEqual({ dx: 0.7, dy: 2.5 });

    undo(h); // back to the default handle
    expect(findPin(eid, pin.id)?.hr).toEqual({ dx: 1 / 3, dy: 0 });
    redo(h);
    expect(findPin(eid, pin.id)?.hr).toEqual({ dx: 0.7, dy: 2.5 });
});

test("commit records a pure-handle change (index/value unchanged)", () => {
    const eid = 207;
    const h = fresh(eid);
    const pin = drop(h, eid, 10, 2);
    const before = h.undo.length;

    beginPin(eid, pin.id);
    setHandle(eid, pin.id, "l", 0.2, -1); // only a handle moved
    commit(h);

    expect(h.undo.length).toBe(before + 1); // the four-field compare caught it
});

test("cancel restores both handles to their pre-gesture state", () => {
    const eid = 208;
    const h = fresh(eid);
    const pin = drop(h, eid, 10, 2);
    const before = h.undo.length;

    beginPin(eid, pin.id);
    setHandle(eid, pin.id, "r", 0.9, 4); // dragged
    cancel();

    expect(findPin(eid, pin.id)?.hr).toEqual({ dx: 1 / 3, dy: 0 }); // restored
    expect(h.undo.length).toBe(before); // nothing recorded
});

test("the captured prev does not alias the live pin (deep-copy guard)", () => {
    const eid = 209;
    const h = fresh(eid);
    const pin = drop(h, eid, 10, 2);

    beginPin(eid, pin.id); // snapshots the default handle
    setHandle(eid, pin.id, "r", 0.8, 3); // mutate after begin — must not bleed into prev
    commit(h);

    undo(h); // if prev aliased the pin, this would restore the *mutated* state
    expect(findPin(eid, pin.id)?.hr).toEqual({ dx: 1 / 3, dy: 0 });
});

// ── track nodes: the same history stack, addressed by stable `order`. a fresh
// device-free State per test (no GPU — history mutates Handle directly, never
// bakes), the same flat two-node seed as track.test.ts.
function nodes(): { state: State; eid: number } {
    const state = new State();
    const eid = createTrack(state);
    addNode(state, -16, 0);
    addNode(state, 16, 0);
    return { state, eid };
}

const orders = (s: State) => sortedHandles(s).map((e) => Handle.order.get(e));
function poseOf(s: State, order: number) {
    const e = handleAt(s, order);
    if (e === null) throw new Error(`no node at order ${order}`);
    return { x: Handle.pos.x.get(e), y: Handle.pos.y.get(e), theta: Handle.theta.get(e) };
}

test("extend: undo removes the new node, redo restores it verbatim", () => {
    const { state } = nodes();
    const h = createHistory();

    const eid = extendTrack(h, state);
    const order = Handle.order.get(eid);
    const pose = poseOf(state, order);
    expect(orders(state)).toEqual([0, 1, 2]);

    undo(h);
    expect(orders(state)).toEqual([0, 1]);
    expect(handleAt(state, 2)).toBeNull();

    redo(h);
    expect(orders(state)).toEqual([0, 1, 2]);
    expect(poseOf(state, order)).toEqual(pose); // same pos + heading
});

test("trim: undo restores the removed node and the promoted tip's pre-trim heading", () => {
    const { state } = nodes();
    addNode(state, 40, 0); // node 2 (the tip); node 1 is now interior, heading frozen
    // shove interior node 1 off its chord so a trim's rehead of the promoted tip
    // actually changes its stored heading (guards the rehead round-trip).
    Handle.pos.set(handleAt(state, 1) as number, 16, 30);
    const h = createHistory();

    const tipBefore = Handle.theta.get(handleAt(state, 1) as number);
    const removed = poseOf(state, 2);

    expect(trimTrack(h, state)).toBe(true);
    expect(orders(state)).toEqual([0, 1]);
    const tipAfter = Handle.theta.get(handleAt(state, 1) as number);
    expect(tipAfter).not.toBe(tipBefore); // headLast reheaded the promoted tip

    undo(h);
    expect(orders(state)).toEqual([0, 1, 2]);
    expect(poseOf(state, 2)).toEqual(removed); // node back verbatim
    expect(Handle.theta.get(handleAt(state, 1) as number)).toBe(tipBefore); // heading restored

    redo(h);
    expect(orders(state)).toEqual([0, 1]);
    expect(Handle.theta.get(handleAt(state, 1) as number)).toBe(tipAfter);
});

test("trim refuses at the two-node floor and records nothing", () => {
    const { state } = nodes();
    const h = createHistory();
    expect(trimTrack(h, state)).toBe(false);
    expect(h.undo.length).toBe(0);
    expect(orders(state)).toEqual([0, 1]);
});

test("a node drag collapses to one entry; undo restores the pose and the reheaded tip", () => {
    const { state } = nodes();
    addNode(state, 30, 0); // node 2 is the tip
    const h = createHistory();

    const beforeTip = poseOf(state, 2);
    const beforeMid = poseOf(state, 1);

    beginMove(state);
    const tip = handleAt(state, 2) as number;
    Handle.pos.set(tip, 30, 10); // live preview frames — not recorded individually
    reheadOnDrag(state, tip);
    Handle.pos.set(tip, 30, 25);
    reheadOnDrag(state, tip);
    commit(h);

    expect(h.undo.length).toBe(1); // the whole drag → one entry
    expect(poseOf(state, 2).y).toBe(25);
    expect(poseOf(state, 2).theta).not.toBe(beforeTip.theta); // the tip reheaded
    const dragged = poseOf(state, 2);

    undo(h);
    expect(poseOf(state, 2)).toEqual(beforeTip); // pos + heading restored
    expect(poseOf(state, 1)).toEqual(beforeMid);

    redo(h);
    expect(poseOf(state, 2)).toEqual(dragged); // replays to the dragged pose
});

test("a no-move node click records nothing", () => {
    const { state } = nodes();
    const h = createHistory();
    beginMove(state);
    commit(h); // released without moving
    expect(h.undo.length).toBe(0);
});

test("node and pin edits share one undo stack, undone in strict reverse order", () => {
    const { state, eid } = nodes();
    clearPins(eid);
    const h = createHistory();

    extendTrack(h, state); // entry 1: node 2 appended at (40, 0)
    beginMove(state);
    const tip = handleAt(state, 2) as number;
    Handle.pos.set(tip, 40, 8);
    reheadOnDrag(state, tip);
    commit(h); // entry 2: the drag
    drop(h, eid, 10, 2); // entry 3: a force pin

    expect(h.undo.length).toBe(3);

    undo(h); // pin
    expect(pinsOf(eid)).toEqual([]);
    expect(orders(state)).toEqual([0, 1, 2]); // nodes untouched

    undo(h); // drag
    expect(poseOf(state, 2).y).toBe(0);

    undo(h); // extend
    expect(orders(state)).toEqual([0, 1]);
    expect(lastHandle(state)).toBe(handleAt(state, 1));
});
