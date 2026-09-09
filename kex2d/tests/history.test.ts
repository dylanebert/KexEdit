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
    beginRecordEnd,
    beginV0,
    cancel,
    commit,
    createHistory,
    type History,
    history as appHistory,
    redo,
    removeRecord,
    setEase,
    setOrder,
    setSelectionHook,
    undo,
} from "../src/history";
import { saveDocument } from "../src/doc";
import { Lane, type LaneSegment } from "../src/lanes";
import { nudgeAct } from "../src/keys";
import { Easing } from "../src/profile";
import { clampSpanDrag, nudgeQuantum, S_GRID } from "../src/timeline";
import {
    BakeSystem,
    createRecord,
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

describe("record-end frozen gesture", () => {
    for (const lane of [Lane.Velocity, Lane.Force, Lane.Geo]) {
        test(`${lane}: one versus N, reversal, refusal, cancel, replay and selection`, () => {
            const { ecs } = fixture();
            const h = appHistory;
            h.undo.length = 0;
            h.redo.length = 0;
            for (const [id, start, end, ease, entry, exit] of [
                [101, 0, 10, 0, 12, 13],
                [102, 10, 20, 1, undefined, 14],
                [103, 23, 28, 2, 15, 16],
            ] as const)
                expect(
                    createRecord(ecs, lane, { id, start, end, ease, entry, exit }).refusals,
                ).toEqual([]);
            expect(
                createRecord(ecs, lane === Lane.Geo ? Lane.Force : Lane.Geo, {
                    id: 104,
                    start: 8,
                    end: 17,
                    ease: 0,
                    entry: 0,
                    exit: 0,
                }).refusals,
            ).toEqual([]);
            expect(setEnd(ecs, 30)).toEqual([]);
            let selection = [101, 104];
            setSelectionHook({
                snapshot: () => [...selection],
                restore: (_ecs, snap) => {
                    selection = snap as number[];
                },
            });
            try {
                const before = saveDocument(ecs);
                let update = beginRecordEnd(ecs, 101, true);
                expect(update(12).refusals).toEqual([]);
                const once = saveDocument(ecs);
                cancel();
                expect(saveDocument(ecs)).toEqual(before);
                expect(update(11).id).toBeNull();
                update = beginRecordEnd(ecs, 101, true);
                for (const end of [11, 8, 10, 10.1, 8.2, 11.3, 12]) {
                    expect(update(end).refusals).toEqual([]);
                    expect(h.undo).toHaveLength(0);
                }
                expect(saveDocument(ecs)).toEqual(once);
                expect(update(13).id).toBeNull();
                expect(saveDocument(ecs)).toEqual(once);
                expect(update(9).refusals).toEqual([]);
                expect(update(12).refusals).toEqual([]);
                commit(h);
                expect(h.undo).toHaveLength(1);
                selection = [103];
                undo(h, ecs);
                expect(saveDocument(ecs)).toEqual(before);
                expect(selection).toEqual([101, 104]);
                redo(h, ecs);
                expect(saveDocument(ecs)).toEqual(once);
                expect(selection).toEqual([103]);
                update = beginRecordEnd(ecs, 101, true);
                expect(update(11).refusals).toEqual([]);
                expect(update(12).refusals).toEqual([]);
                commit(h);
                expect(h.undo).toHaveLength(1);
                update = beginRecordEnd(ecs, 101, true);
                expect(update(0.5).id).toBeNull();
                commit(h);
                expect(h.undo).toHaveLength(1);
            } finally {
                cancel();
                setSelectionHook(null);
                h.undo.length = 0;
                h.redo.length = 0;
            }
        });
    }
});

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
        expect(removeRecord(h, ecs, id).id).toBe(id);
        expect(h.undo).toHaveLength(2);
        expect(lanesOf(ecs).force).toEqual([]);
        undo(h, ecs);
        expect(row(ecs, id)).toEqual(before);
        expect(row(ecs, id).entry).toBeUndefined();
    });

    // RED (reviewer note 2): return a bare boolean again and `commands.ts` names `recordNotFound`
    // on BOTH false paths — this arm asserts the guard the verb itself reports, so the id-less
    // case is distinguishable from a store refusal on a record that IS there.
    test("removeRecord on a missing id reports recordNotFound and records nothing", () => {
        const { ecs, h } = fixture();
        const out = removeRecord(h, ecs, 99);
        expect(out.id).toBeNull();
        expect(out.refusals.map((r) => r.guard)).toEqual(["recordNotFound"]);
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

// ── the replay guard (reviewer note 4) ──────────────────────────────────────────────────────
// A setter refusal on the live authoring path is an outcome the caller reports; the same refusal
// inside an `apply`/`reverse` is a stack that no longer matches the document. `addRecord` used to
// discard its redo's outcome (`void createRecord(...)`), so a redo the document had since made
// illegal landed nothing and left every later entry addressing a record that is not there.
describe("the replay guard — a command's own apply/reverse must land", () => {
    // RED: restore `apply: () => void createRecord(ecs, lane, landed)` and this redo silently
    // lands nothing — `h.undo` grows by one, the record is absent, and the next arm's read of it
    // throws far from the cause instead of here.
    test("a redo the document has made illegal throws rather than silently landing nothing", () => {
        const { ecs, h } = fixture();
        const id = addForce(ecs, h, 0, 10);
        undo(h, ecs); // the record leaves
        expect(recordOf(ecs, id)).toBeUndefined();
        // an overlapping record takes the room the undo freed. Written through the SETTER, not
        // the verb: a new authoring entry would clear the redo branch, and the branch is exactly
        // what this arm needs standing.
        expect(
            createRecord(ecs, Lane.Force, { start: 5, end: 15, ease: Easing.Linear, exit: 1 }).id,
        ).not.toBeNull();
        expect(() => redo(h, ecs)).toThrow(/segmentOverlapped/);
    });

    test("an undo whose delete cannot land throws rather than banking a wrong reverse", () => {
        const { ecs, h } = fixture();
        const id = addForce(ecs, h, 0, 10);
        removeRecord(h, ecs, id); // the record is gone, its delete entry on the stack
        undo(h, ecs); // which restores it
        expect(recordOf(ecs, id)).not.toBeUndefined();
        redo(h, ecs); // and deletes it again — the replay landed both directions
        expect(recordOf(ecs, id)).toBeUndefined();
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

    // RED (reviewer note 3): drop `setEase`'s `pre` snapshot and this arm reads `undefined` —
    // the entry lands in the GESTURE form, which tells undo to leave the selection alone. An
    // easing pick is not a gesture: it is one write from a menu row or a popover field, so the
    // selection it was made under is part of what undo owes back.
    test("the entry carries the pre-command selection, not the gesture form", () => {
        const { ecs, h } = fixture();
        const id = addForce(ecs, h, 0, 10);
        const seen: unknown[] = [];
        setSelectionHook({
            snapshot: () => ({ marker: seen.length }),
            restore: (_e, snap) => void seen.push(snap),
        });
        try {
            setEase(h, ecs, id, Easing.Quintic);
            const entry = h.undo[h.undo.length - 1];
            expect(entry.pre).not.toBeUndefined();
            undo(h, ecs);
            expect(seen).toHaveLength(1); // undo restored the entry's own pre-selection
        } finally {
            setSelectionHook(null);
        }
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

// ── the failed open (reviewer finding, Validation 3, 2026-09-07) ────────────────────────────
//
// `begin` on a gone subject opens nothing; what it must ALSO do is close whatever was open, or a
// gesture opened on a record deleted mid-drag survives its own subject and the next `commit`
// lands it. Unreachable from the CLI (every op brackets its own `begin`…`commit`) and reachable
// from S3's lane rows, which is why it lands here with the timeline.
describe("begin — a failed open closes the standing gesture", () => {
    // RED: restore the bare `if (prev === undefined) return;` → the stale span gesture survives
    // the failed open, `commit` reads the record's moved span against the pre-drag snapshot, and
    // `h.undo` grows by one entry the author never released.
    test("a begin on a gone record clears the open gesture, so the next commit records nothing", () => {
        const { ecs, h } = fixture();
        const a = addForce(ecs, h, 0, 10);
        const b = addForce(ecs, h, 20, 30);
        const depth = h.undo.length;

        beginEdge(ecs, a); // a drag opens on record a
        setRecordSpan(ecs, a, 0, 12); // and writes a frame of it
        removeRecord(h, ecs, b); // meanwhile the OTHER record goes away
        beginEdge(ecs, b); // the drag re-opens on the record that is now gone
        commit(h); // the release must land nothing

        expect(h.undo).toHaveLength(depth + 1); // the delete alone, not a second entry
        expect(row(ecs, a).end).toBe(12); // the live write stands; only the entry is refused
    });
});

// ── S3c: the popover's fields and the nudge keys land the SAME entries the drags do ───────────
// Both surfaces write through the verbs above rather than through a second path, so what is at
// stake is the identity: one commit, one entry, and an undo that puts the record back exactly.
describe("the popover's fields — one gesture, one entry, per field", () => {
    // RED: land a field's write without the `begin`/`commit` bracket (a bare setter call) and the
    // typed edit lands NO entry — the value moves and undo takes back somebody else's edit.
    test("each value field commits one entry and undoes to the pre-edit number", () => {
        const { ecs, h } = fixture();
        const id = addForce(ecs, h, 0, 10, 1);
        const depth = h.undo.length;

        // the exit field: `beginHandle` → setter → `commit`, exactly what `Popover.svelte` calls.
        beginHandle(ecs, id, "exit");
        setRecordHandle(ecs, id, "exit", 2.5);
        commit(h);
        expect(h.undo).toHaveLength(depth + 1);
        expect(row(ecs, id).exit).toBe(2.5);
        undo(h, ecs);
        expect(row(ecs, id).exit).toBe(1);
        redo(h, ecs);
        expect(row(ecs, id).exit).toBe(2.5);

        // the entry field, over the same lifecycle and its own column.
        beginHandle(ecs, id, "entry");
        setRecordHandle(ecs, id, "entry", 0.4);
        commit(h);
        expect(h.undo).toHaveLength(depth + 2);
        undo(h, ecs);
        expect(row(ecs, id).entry).toBe(1);
    });

    // RED: drop the label scrub's intermediate frames from the gesture (open a fresh gesture per
    // frame) and one drag lands one entry PER FRAME — the coalescing the field law promises
    // ("one undo") is exactly what a scrub tests.
    test("a label scrub's many live frames coalesce into ONE entry", () => {
        const { ecs, h } = fixture();
        const id = addForce(ecs, h, 0, 10, 1);
        const depth = h.undo.length;
        beginHandle(ecs, id, "exit");
        for (const v of [1.1, 1.4, 1.9, 2.2]) setRecordHandle(ecs, id, "exit", v);
        commit(h);
        expect(h.undo).toHaveLength(depth + 1);
        undo(h, ecs);
        expect(row(ecs, id).exit).toBe(1);
    });

    // RED: commit on Escape instead of cancelling and a reverted field lands the abandoned value
    // as an entry — the field law's Escape stops meaning anything.
    test("Escape reverts a field: the pre-edit value returns and nothing is recorded", () => {
        const { ecs, h } = fixture();
        const id = addForce(ecs, h, 0, 10, 1);
        const depth = h.undo.length;
        beginHandle(ecs, id, "exit");
        setRecordHandle(ecs, id, "exit", 3);
        cancel();
        expect(row(ecs, id).exit).toBe(1);
        expect(h.undo).toHaveLength(depth);
    });

    // RED: open the two station fields on `beginBody` rather than `beginEdge` and a `start` edit
    // restores BOTH columns from a body snapshot — the same two columns here, but the arm pins
    // that the far edge holds, which is what a start field means.
    test("the start and end fields move their own station and hold the other", () => {
        const { ecs, h } = fixture();
        const id = addForce(ecs, h, 4, 14, 1);
        const depth = h.undo.length;
        beginEdge(ecs, id);
        const span = clampSpanDrag("start", 6, 14);
        setRecordSpan(ecs, id, span.start, span.end);
        commit(h);
        expect(row(ecs, id)).toMatchObject({ start: 6, end: 14 });
        expect(h.undo).toHaveLength(depth + 1);
        undo(h, ecs);
        expect(row(ecs, id)).toMatchObject({ start: 4, end: 14 });
    });

    // RED: drop `setEase`'s own `record` call and the easing picker changes the curve with no
    // entry behind it — the one field that is a single write rather than a gesture.
    test("the easing picker lands one entry and undoes to the previous tag", () => {
        const { ecs, h } = fixture();
        const id = addForce(ecs, h, 0, 10, 1);
        const depth = h.undo.length;
        expect(setEase(h, ecs, id, Easing.Quintic).id).toBe(id);
        expect(h.undo).toHaveLength(depth + 1);
        expect(row(ecs, id).ease).toBe(Easing.Quintic);
        undo(h, ecs);
        expect(row(ecs, id).ease).toBe(Easing.Linear);
    });
});

describe("the nudge keys — the in-place tweak's own undo identity", () => {
    /** the timeline's own applier, in the shape `Timeline.svelte` runs it: one gesture bracket
     *  around one setter write, with the station channel floored at the origin exactly as a body
     *  drag is. Driven through `nudgeAct` so the arm reads the real decision, not a hand-picked
     *  direction. */
    function press(
        ecs: State,
        h: History,
        id: number,
        lane: Lane,
        key: string,
        mods: { shift?: boolean; alt?: boolean } = {},
    ): void {
        const r = row(ecs, id);
        const act = nudgeAct(
            { key },
            {
                dragging: false,
                selected: true,
                shift: mods.shift ?? false,
                alt: mods.alt ?? false,
                ownsEntry: r.entry !== undefined,
            },
        );
        if (act === null) return;
        if (act.kind === "station") {
            const shift = act.sign * S_GRID;
            const span = clampSpanDrag("body", r.start + shift, r.end + shift);
            beginBody(ecs, id);
            setRecordSpan(ecs, id, span.start, span.end);
            commit(h);
            return;
        }
        const base = act.which === "entry" ? r.entry : r.exit;
        if (base === undefined) return;
        beginHandle(ecs, id, act.which);
        setRecordHandle(ecs, id, act.which, base + act.sign * nudgeQuantum(lane));
        commit(h);
    }

    // RED: drop the `commit` after the setter write and each arrow press leaves the gesture open —
    // the next press coalesces into it and one undo takes back every nudge at once.
    test("one press is one entry, on both channels", () => {
        const { ecs, h } = fixture();
        const id = addForce(ecs, h, 4, 14, 1);
        const depth = h.undo.length;
        press(ecs, h, id, Lane.Force, "ArrowRight");
        expect(row(ecs, id)).toMatchObject({ start: 5, end: 15 });
        press(ecs, h, id, Lane.Force, "ArrowUp", { shift: true });
        expect(row(ecs, id).exit).toBeCloseTo(1 + nudgeQuantum(Lane.Force), 6);
        expect(h.undo).toHaveLength(depth + 2);
        undo(h, ecs);
        expect(row(ecs, id).exit).toBe(1);
        undo(h, ecs);
        expect(row(ecs, id)).toMatchObject({ start: 4, end: 14 });
    });

    // RED: skip `clampSpanDrag` in the station channel and an arrow walks the span below 0, where
    // `lanes.segmentBeforeOrigin` refuses it — the setter declines every frame and the key goes
    // dead instead of sliding the span to the wall (the origin law, landed S3a).
    test("the station nudge slides to the origin with its length held, never below it", () => {
        const { ecs, h } = fixture();
        const id = addForce(ecs, h, 0.5, 10.5, 1);
        press(ecs, h, id, Lane.Force, "ArrowLeft");
        expect(row(ecs, id)).toMatchObject({ start: 0, end: 10 });
        const depth = h.undo.length;
        press(ecs, h, id, Lane.Force, "ArrowLeft"); // already at the wall: nothing moves
        expect(row(ecs, id)).toMatchObject({ start: 0, end: 10 });
        expect(h.undo).toHaveLength(depth); // a no-change gesture records nothing
    });

    // RED: nudge the entry without the ownership guard and an inferred entry becomes an OWNED one
    // as a side effect of an arrow press — a different document from the one the person had.
    test("the Alt form leaves an inferred entry alone rather than minting ownership", () => {
        const { ecs, h } = fixture();
        addForce(ecs, h, 0, 10, 1);
        const w = createRecord(ecs, Lane.Force, {
            start: 10,
            end: 20,
            ease: Easing.Linear,
            exit: 2,
        });
        if (w.id === null) throw new Error("refused");
        const depth = h.undo.length;
        press(ecs, h, w.id, Lane.Force, "ArrowUp", { shift: true, alt: true });
        expect(row(ecs, w.id).entry).toBeUndefined();
        expect(h.undo).toHaveLength(depth);
        // the exit form still lands on the same record — the guard is the ENTRY's, not the key's.
        press(ecs, h, w.id, Lane.Force, "ArrowUp", { shift: true });
        expect(h.undo).toHaveLength(depth + 1);
    });
});
