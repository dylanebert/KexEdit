import { expect, test } from "bun:test";
import { addPin, findPin, insertPin, pinRev, pinsOf, removePin, setPin } from "../src/pins";

// the pin store is a module singleton (canonical per-track authoring data); each
// test uses a distinct trackEid and asserts relative behavior (ids increase, rev
// advances), never absolute ids — they're monotonic across the whole file.

test("addPin appends a pin with a fresh stable id and bumps rev", () => {
    const eid = 100;
    const r0 = pinRev();
    const a = addPin(eid, 10, 2);
    const b = addPin(eid, 50, -1);
    expect(b.id).toBeGreaterThan(a.id); // ids strictly increase, never reused
    expect(pinsOf(eid)).toEqual([a, b]); // insertion order
    expect(pinRev()).toBeGreaterThan(r0); // each mutation advances rev
});

test("setPin updates index + value by id and bumps rev", () => {
    const eid = 101;
    const p = addPin(eid, 10, 2);
    const r0 = pinRev();
    setPin(eid, p.id, 20, 3.5);
    expect(findPin(eid, p.id)).toMatchObject({ index: 20, value: 3.5 });
    expect(pinRev()).toBeGreaterThan(r0);
});

test("removePin drops the pin by id and reports its position", () => {
    const eid = 102;
    const a = addPin(eid, 5, 1);
    const b = addPin(eid, 15, 2);
    const at = removePin(eid, a.id);
    expect(at).toBe(0); // a was first
    expect(pinsOf(eid)).toEqual([b]);
    expect(findPin(eid, a.id)).toBeUndefined();
    expect(removePin(eid, 99999)).toBe(-1); // absent id
});

test("insertPin restores a removed pin at its prior position (undo of remove)", () => {
    const eid = 103;
    const a = addPin(eid, 5, 1);
    const b = addPin(eid, 15, 2);
    const c = addPin(eid, 25, 3);
    const at = removePin(eid, b.id); // remove the middle one
    expect(at).toBe(1);
    insertPin(eid, b, at); // put it back where it was
    expect(pinsOf(eid)).toEqual([a, b, c]); // exact prior order restored
});

test("a fresh track has no pins", () => {
    expect(pinsOf(999)).toEqual([]);
});
