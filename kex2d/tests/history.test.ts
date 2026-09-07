/** the lane gestures' own suite (spec `kex2d-segment-gestures` S2e-ii punch list item 2): the
 *  authored verbs `history.ts` declares over the S2e-i setters, one arm per gesture class.
 *
 *  What each arm reads is the UNDO CONTRACT, not the setter's: the setters have their own suite
 *  (`track.test.ts`), so what is at stake here is that a gesture lands exactly ONE entry, that
 *  undo puts back the state the gesture opened on, and that a refused or no-op write records
 *  nothing at all — an entry over a write that never landed would undo somebody else's edit.
 *  Every arm is red-proven by a mutation to the verb it names, recorded beside it. Device-free. */

import { describe, expect, test } from "bun:test";
import { State } from "@dylanebert/shallot";
import {
    addRecord,
    beginBody,
    beginEdge,
    beginEnd,
    beginHandle,
    beginV0,
    cancel,
    commit,
    createHistory,
    type History,
    redo,
    removeRecord,
    setEase,
    setOrder,
    undo,
} from "../src/history";
import { Lane, type LaneSegment } from "../src/lanes";
import { Easing } from "../src/profile";
import {
    BakeSystem,
    createTrack,
    endColumn,
    entrySpeed,
    laneOrderOf,
    lanesOf,
    orderColumn,
    recordOf,
    setEnd,
    setRecordHandle,
    setRecordSpan,
    setV0,
    trackEndOf,
    V0,
} from "../src/track";

function fixture(): { ecs: State; h: History } {
    const ecs = new State();
    ecs.addSystem(BakeSystem);
    createTrack(ecs);
    return { ecs, h: createHistory() };
}

/** one force record over `[start, end)` owning both handles, landed through the gesture. */
function addForce(ecs: State, h: History, start: number, end: number, g = 1): number {
    const w = addRecord(h, ecs, Lane.Force, {
        start,
        end,
        ease: Easing.Linear,
        entry: g,
        exit: g,
    });
    if (w.id === null) throw new Error(`refused: ${JSON.stringify(w.refusals)}`);
    return w.id;
}

function row(ecs: State, id: number): LaneSegment {
    const found = recordOf(ecs, id);
    if (!found) throw new Error(`no record ${id}`);
    return found.row;
}

describe("addRecord / removeRecord — the structural verbs", () => {
    // RED: drop `addRecord`'s `record(...)` call → the record lands but undo has nothing to pop,
    // so the record survives the undo and this arm fails on the length assertion.
    test("addRecord lands one entry; undo removes the record, redo re-spawns it", () => {
        const { ecs, h } = fixture();
        const id = addForce(ecs, h, 0, 10, 1.5);
        expect(h.undo).toHaveLength(1);
        expect(lanesOf(ecs).force).toHaveLength(1);
        undo(h, ecs);
        expect(lanesOf(ecs).force).toEqual([]);
        redo(h, ecs);
        // the SAME stable id, not an allocator-fresh one: a selection snapshot and every later
        // edit address the record by id, so a redo that re-keyed it would alias.
        expect(lanesOf(ecs).force.map((r) => r.id)).toEqual([id]);
    });

    // RED: record the entry BEFORE reading the setter's outcome (drop the `if (write.id === null)
    // return write` guard) → the refused create still pushes an entry and `h.undo` reads 1.
    test("a refused addRecord records nothing", () => {
        const { ecs, h } = fixture();
        addForce(ecs, h, 0, 10);
        const refused = addRecord(h, ecs, Lane.Force, {
            start: 5,
            end: 15,
            ease: Easing.Linear,
            entry: 1,
            exit: 1,
        });
        expect(refused.id).toBeNull();
        expect(refused.refusals.map((r) => r.guard)).toEqual(["segmentOverlapped"]);
        expect(h.undo).toHaveLength(1); // the landed create alone
        expect(lanesOf(ecs).force).toHaveLength(1);
    });

    // RED: reverse `removeRecord` with a fresh-id create (drop `row` from the closure and pass
    // `{...row, id: undefined}`) → the restored record's id differs and this arm fails.
    test("removeRecord lands one entry; undo restores the record verbatim", () => {
        const { ecs, h } = fixture();
        const id = addForce(ecs, h, 0, 10, 2);
        setRecordHandle(ecs, id, "entry", undefined); // an unowned entry must survive the trip
        const before = row(ecs, id);
        expect(removeRecord(h, ecs, id)).toBe(true);
        expect(h.undo).toHaveLength(2);
        expect(lanesOf(ecs).force).toEqual([]);
        undo(h, ecs);
        expect(row(ecs, id)).toEqual(before);
        expect(row(ecs, id).entry).toBeUndefined();
    });

    test("removeRecord on a missing id is false and records nothing", () => {
        const { ecs, h } = fixture();
        expect(removeRecord(h, ecs, 99)).toBe(false);
        expect(h.undo).toEqual([]);
    });
});

describe("beginHandle — the value chips", () => {
    // RED: snapshot only the NUMBER (return `found.row.exit` for both sides) → the disown arm
    // below restores `0` instead of putting the ownership back, and `entry` reads a number.
    test("an exit edit lands one entry and undo restores the value", () => {
        const { ecs, h } = fixture();
        const id = addForce(ecs, h, 0, 10, 1);
        beginHandle(ecs, id, "exit");
        setRecordHandle(ecs, id, "exit", 3);
        setRecordHandle(ecs, id, "exit", 4.5); // a drag writes every frame; one entry lands
        commit(h);
        expect(h.undo).toHaveLength(2);
        expect(row(ecs, id).exit).toBe(4.5);
        undo(h, ecs);
        expect(row(ecs, id).exit).toBe(1);
    });

    test("disowning an entry undoes back to OWNERSHIP, not to a value", () => {
        const { ecs, h } = fixture();
        const id = addForce(ecs, h, 0, 10, 2);
        beginHandle(ecs, id, "entry");
        setRecordHandle(ecs, id, "entry", undefined);
        commit(h);
        expect(row(ecs, id).entry).toBeUndefined();
        undo(h, ecs);
        expect(row(ecs, id).entry).toBe(2);
    });

    // RED: drop `commit`'s `same` short-circuit → a click with no move records an entry, so the
    // next undo eats the CREATE instead of doing nothing and the record disappears.
    test("a no-change release records nothing", () => {
        const { ecs, h } = fixture();
        const id = addForce(ecs, h, 0, 10, 1);
        beginHandle(ecs, id, "exit");
        setRecordHandle(ecs, id, "exit", 1);
        commit(h);
        expect(h.undo).toHaveLength(1);
    });

    test("a gesture on a gone record opens nothing", () => {
        const { ecs, h } = fixture();
        beginHandle(ecs, 404, "exit");
        commit(h);
        expect(h.undo).toEqual([]);
    });
});

describe("beginEdge / beginBody — the span gestures", () => {
    // RED: snapshot only `start` in `beginSpan` → the move arm restores the start but leaves the
    // dragged `end` at 22, so the restored span is [0, 22) and the arm fails.
    test("a body move lands one entry and undo restores BOTH columns", () => {
        const { ecs, h } = fixture();
        const id = addForce(ecs, h, 0, 10);
        beginBody(ecs, id);
        setRecordSpan(ecs, id, 12, 22);
        commit(h);
        expect(row(ecs, id)).toMatchObject({ start: 12, end: 22 });
        undo(h, ecs);
        expect(row(ecs, id)).toMatchObject({ start: 0, end: 10 });
    });

    test("an edge resize lands one entry and undo restores the span", () => {
        const { ecs, h } = fixture();
        const id = addForce(ecs, h, 0, 10);
        beginEdge(ecs, id);
        setRecordSpan(ecs, id, 0, 17);
        commit(h);
        expect(h.undo).toHaveLength(2);
        undo(h, ecs);
        expect(row(ecs, id)).toMatchObject({ start: 0, end: 10 });
    });

    // RED: make `cancel` a no-op (drop its `restore` call) → the dragged span survives the abort.
    test("cancel reverts the live writes and records nothing", () => {
        const { ecs, h } = fixture();
        const id = addForce(ecs, h, 0, 10);
        beginBody(ecs, id);
        setRecordSpan(ecs, id, 30, 40);
        cancel();
        expect(row(ecs, id)).toMatchObject({ start: 0, end: 10 });
        expect(h.undo).toHaveLength(1);
    });

    // the setter refuses mid-drag, so the live state never moves and the release is a no-op —
    // the gesture never needs a refusal branch of its own.
    test("a drag into an overlap refuses at the setter and records nothing", () => {
        const { ecs, h } = fixture();
        addForce(ecs, h, 0, 10);
        const b = addForce(ecs, h, 20, 30);
        beginBody(ecs, b);
        const w = setRecordSpan(ecs, b, 5, 15);
        expect(w.refusals.map((r) => r.guard)).toEqual(["segmentOverlapped"]);
        commit(h);
        expect(h.undo).toHaveLength(2);
        expect(row(ecs, b)).toMatchObject({ start: 20, end: 30 });
    });
});

describe("setEase — the easing chip", () => {
    // RED: record unconditionally (drop the `before === ease` short-circuit) → re-picking the
    // tag a record already carries banks an entry and `h.undo` reads 2.
    test("a tag change lands one entry; re-picking the same tag records nothing", () => {
        const { ecs, h } = fixture();
        const id = addForce(ecs, h, 0, 10);
        setEase(h, ecs, id, Easing.Quintic);
        expect(row(ecs, id).ease).toBe(Easing.Quintic);
        expect(h.undo).toHaveLength(2);
        setEase(h, ecs, id, Easing.Quintic);
        expect(h.undo).toHaveLength(2);
        undo(h, ecs);
        expect(row(ecs, id).ease).toBe(Easing.Linear);
    });

    test("setEase on a missing record refuses and records nothing", () => {
        const { ecs, h } = fixture();
        expect(setEase(h, ecs, 404, Easing.Cubic).refusals.map((r) => r.guard)).toEqual([
            "recordNotFound",
        ]);
        expect(h.undo).toEqual([]);
    });
});

describe("beginEnd — the ruler's end handle", () => {
    // RED: snapshot `trackEndOf` (the RESOLVED end) instead of `endColumn` → undoing the FIRST
    // pin writes the followed 40 into the column, so the track comes back pinned at its content
    // instead of following it, and `endColumn` reads 40 instead of 0.
    test("undoing a pin restores FOLLOW, and undoing an unpin restores the number", () => {
        const { ecs, h } = fixture();
        addForce(ecs, h, 0, 40);
        expect(endColumn(ecs)).toBe(0); // following its content
        beginEnd(ecs);
        setEnd(ecs, 60);
        commit(h);
        expect(endColumn(ecs)).toBe(60);
        beginEnd(ecs);
        setEnd(ecs, 0);
        commit(h);
        expect(endColumn(ecs)).toBe(0);
        undo(h, ecs);
        expect(endColumn(ecs)).toBe(60);
        undo(h, ecs);
        expect(endColumn(ecs)).toBe(0);
        expect(trackEndOf(ecs)).toBe(40);
    });

    test("a pin below content is refused at the setter, so the release records nothing", () => {
        const { ecs, h } = fixture();
        addForce(ecs, h, 0, 40);
        beginEnd(ecs);
        expect(setEnd(ecs, 30).map((r) => r.guard)).toEqual(["endBelowContent"]);
        commit(h);
        expect(h.undo).toHaveLength(1);
        expect(endColumn(ecs)).toBe(0);
    });
});

describe("setOrder — the lane priority", () => {
    // RED: read `before` AFTER the write → both sides of the entry hold the new order and undo
    // leaves the swapped order in place.
    test("an order swap lands one entry and undo restores the priority", () => {
        const { ecs, h } = fixture();
        const before = laneOrderOf(ecs);
        expect(setOrder(h, ecs, [Lane.Force, Lane.Geo, Lane.Velocity])).toEqual([]);
        expect(laneOrderOf(ecs)).toEqual([Lane.Force, Lane.Geo, Lane.Velocity]);
        expect(h.undo).toHaveLength(1);
        undo(h, ecs);
        expect(laneOrderOf(ecs)).toEqual(before);
    });

    // an ABSENT column and the default written out are different documents, so writing the
    // default over absence is a real edit; writing an order the column already carries is not.
    // RED: snapshot `laneOrderOf` instead of `orderColumn` → the first write reads as a no-op,
    // and undoing a later swap writes the default out where the document had nothing.
    test("writing the default over an absent column records, and undo restores absence", () => {
        const { ecs, h } = fixture();
        expect(orderColumn(ecs)).toBe(0);
        expect(setOrder(h, ecs, laneOrderOf(ecs))).toEqual([]);
        expect(h.undo).toHaveLength(1);
        expect(orderColumn(ecs)).not.toBe(0);
        expect(setOrder(h, ecs, laneOrderOf(ecs))).toEqual([]);
        expect(h.undo).toHaveLength(1); // the same order again is no edit
        undo(h, ecs);
        expect(orderColumn(ecs)).toBe(0);
    });

    test("a non-permutation is refused and records nothing", () => {
        const { ecs, h } = fixture();
        const refusals = setOrder(h, ecs, [Lane.Force, Lane.Force, Lane.Velocity]);
        expect(refusals.map((r) => r.guard)).toEqual(["laneOrder"]);
        expect(h.undo).toEqual([]);
    });
});

describe("beginV0 — the start speed", () => {
    // RED: restore through `Track.v0.set` instead of `setV0` — or snapshot nothing — and the
    // undo below leaves 25 in place.
    test("a start-speed edit lands one entry and undo restores it", () => {
        const { ecs, h } = fixture();
        beginV0(ecs);
        setV0(ecs, 25);
        commit(h);
        expect(entrySpeed(ecs)).toBe(25);
        expect(h.undo).toHaveLength(1);
        undo(h, ecs);
        expect(entrySpeed(ecs)).toBe(V0);
    });

    test("a below-floor start speed is refused at the setter and records nothing", () => {
        const { ecs, h } = fixture();
        beginV0(ecs);
        expect(setV0(ecs, 0).map((r) => r.guard)).toEqual(["minStartSpeed"]);
        commit(h);
        expect(h.undo).toEqual([]);
        expect(entrySpeed(ecs)).toBe(V0);
    });
});
