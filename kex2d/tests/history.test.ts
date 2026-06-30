import { expect, test } from "bun:test";
import { begin, cancel, commit, createHistory, drop, erase, redo, undo } from "../src/history";
import { clearPins, pinsOf, setPin } from "../src/pins";

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

    begin(eid, pin.id);
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

    begin(eid, pin.id);
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
    begin(eid, pin.id);
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
