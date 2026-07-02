import { State } from "@dylanebert/shallot";
import { expect, test } from "bun:test";
import {
    beginMove,
    commit,
    createHistory,
    extendTrack,
    redo,
    trimTrack,
    undo,
} from "../src/history";
import { addNode, createTrack, Handle, handleAt, reheadOnDrag, sortedHandles } from "../src/track";

// track-node undo/redo, addressed by stable `order`. a fresh
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
