/** the authored store's own suite: the lane setters, their refusals, the snapshot round trip,
 *  the bake gate, and the track-level columns (spec `kex2d-segment-gestures` S2e-i punch list
 *  item 2).
 *
 *  Every write in the store goes through one of the setters below, and every setter refuses the
 *  same way: assemble the candidate lane, read the laws over it, write nothing if any law is
 *  violated. So each refusal arm here is red-proven by DELETING the guard it names — the
 *  mutation is recorded beside the arm — rather than by a mutation that never reaches the
 *  predicate. Device-free: no GPU, no canvas. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { State } from "@dylanebert/shallot";
import { loadDocument, saveDocument } from "../src/doc";
import { beginBody, commit, createHistory } from "../src/history";
import { Lane, RECORD_FLOOR, trackEnd } from "../src/lanes";
import { Easing } from "../src/profile";
import { DEFAULT_ORDER } from "../src/projection";
import { Domain, SectionKind } from "../src/section";
import {
    authoredHash,
    bakeLive,
    bakeOut,
    BakeSystem,
    createRecord,
    createTrack,
    deleteRecord,
    endColumn,
    entrySpeed,
    laneOrderOf,
    laneRows,
    lanesOf,
    MIN_V0,
    recordAt,
    restoreAll,
    runsOf,
    samples,
    setEnd,
    setOrder,
    setRecordEase,
    setRecordHandle,
    setRecordSpan,
    setTrackDomain,
    setV0,
    snapshotAll,
    stripsForStep,
    Track,
    trackDomain,
    trackEndOf,
    V0,
} from "../src/track";
import { resolveStep } from "../src/profile";

/** a bare track with no records — every fixture below authors up from here. */
function track(): { state: State; eid: number } {
    const state = new State();
    state.addSystem(BakeSystem);
    const eid = createTrack(state);
    return { state, eid };
}

/** author one record, asserting it landed; returns its stable id. */
function author(state: State, lane: Lane, row: Parameters<typeof createRecord>[2]): number {
    const w = createRecord(state, lane, row);
    expect(w.refusals).toEqual([]);
    if (w.id === null) throw new Error("record refused");
    return w.id;
}

describe("the lane readers", () => {
    test("lanesOf returns each lane's records in span order, ties broken by id", () => {
        const { state } = track();
        const b = author(state, Lane.Force, { start: 20, end: 30, ease: 0, entry: 1, exit: 1 });
        const a = author(state, Lane.Force, { start: 0, end: 10, ease: 0, entry: 1, exit: 1 });
        author(state, Lane.Velocity, { start: 2, end: 8, ease: 0, entry: 12, exit: 12 });
        expect(lanesOf(state).force.map((r) => r.id)).toEqual([a, b]);
        expect(lanesOf(state).velocity).toHaveLength(1);
        expect(lanesOf(state).geo).toEqual([]);
        // the lane a record lives in is the only thing that says which lane it is.
        expect(laneRows(state, Lane.Geo)).toEqual([]);
    });

    test("a record's OWNED entry survives the read; a disowned one is absent, not zero", () => {
        const { state } = track();
        const id = author(state, Lane.Force, { start: 0, end: 10, ease: 0, entry: 1.5, exit: 2 });
        expect(lanesOf(state).force[0]!.entry).toBe(1.5);
        setRecordHandle(state, id, "entry", undefined);
        expect("entry" in lanesOf(state).force[0]!).toBe(false);
    });

    test("stations are f64: a value f32 cannot hold survives the store and a snapshot", () => {
        const { state } = track();
        const hostile = 40.12345678901234;
        expect(Math.fround(hostile)).not.toBe(hostile);
        const id = author(state, Lane.Force, {
            start: 0,
            end: hostile,
            ease: 0,
            entry: 1,
            exit: 1,
        });
        expect(lanesOf(state).force[0]!.end).toBe(hostile);
        const snap = snapshotAll(state);
        restoreAll(state, snap);
        expect(lanesOf(state).force[0]!.end).toBe(hostile);
        expect(recordAt(state, id)).not.toBeNull();
    });
});

describe("direct writer bounds", () => {
    for (const lane of [Lane.Force, Lane.Geo, Lane.Velocity]) {
        for (const pin of [0, 20]) {
            test(`lane ${lane}, pin ${pin}: create/span refuse before any authored write`, () => {
                const { state } = track();
                const h = createHistory();
                const id = author(state, lane, { start: 0, end: 10, ease: 0, entry: 1, exit: 1 });
                expect(setEnd(state, pin)).toEqual([]);
                const before = {
                    doc: saveDocument(state),
                    hash: authoredHash(state),
                    snap: snapshotAll(state),
                    history: structuredClone(h),
                };
                const bad = [
                    [-1, 5],
                    [10, 10],
                    [10, 10.5],
                    [NaN, 15],
                    [10, Infinity],
                    [-Infinity, 15],
                    [10, NaN],
                ];
                if (pin) bad.push([21, 24]);
                for (const [start, end] of bad) {
                    expect(
                        createRecord(state, lane, { start: start!, end: end!, ease: 0, exit: 1 })
                            .id,
                    ).toBeNull();
                    beginBody(state, id);
                    expect(setRecordSpan(state, id, start!, end!).id).toBeNull();
                    commit(h);
                    expect({
                        doc: saveDocument(state),
                        hash: authoredHash(state),
                        snap: snapshotAll(state),
                        history: h,
                    }).toEqual(before);
                }
                if (pin) {
                    beginBody(state, id);
                    expect(setRecordSpan(state, id, 0, 25).id).toBeNull();
                    commit(h);
                    expect({
                        doc: saveDocument(state),
                        hash: authoredHash(state),
                        snap: snapshotAll(state),
                        history: h,
                    }).toEqual(before);
                }
                expect(setRecordSpan(state, id, 0, pin || 25).refusals).toEqual([]);
                expect(setRecordSpan(state, id, 0, 10).refusals).toEqual([]);
                author(state, lane, { start: 10, end: pin || 30, ease: 0, exit: 1 });
                const abutting = saveDocument(state);
                expect(setRecordSpan(state, id, 0, 11).id).toBeNull();
                expect(
                    createRecord(state, lane, { start: 9, end: 12, ease: 0, exit: 1 }).id,
                ).toBeNull();
                expect(saveDocument(state)).toBe(abutting);
            });
        }
    }
});

describe("the setters refuse structurally", () => {
    // RED (createRecord's overlap arm): delete the `refuse(...)` call in `createRecord` and
    // return `landed(id)` unconditionally → the overlapping record lands, the lane holds two
    // rows, and both assertions below fail (exit 1).
    test("createRecord refuses an overlapping span and writes nothing", () => {
        const { state } = track();
        author(state, Lane.Force, { start: 0, end: 20, ease: 0, entry: 1, exit: 1 });
        const w = createRecord(state, Lane.Force, {
            start: 10,
            end: 30,
            ease: 0,
            entry: 1,
            exit: 1,
        });
        expect(w.id).toBeNull();
        expect(w.refusals.map((r) => r.guard)).toEqual(["segmentOverlapped"]);
        expect(laneRows(state, Lane.Force)).toHaveLength(1);
    });

    test("abutting is legal — the half-open span makes `a.end === b.start` no overlap", () => {
        const { state } = track();
        author(state, Lane.Force, { start: 0, end: 20, ease: 0, entry: 1, exit: 1 });
        const w = createRecord(state, Lane.Force, { start: 20, end: 30, ease: 0, exit: 1.5 });
        expect(w.refusals).toEqual([]);
        expect(laneRows(state, Lane.Force)).toHaveLength(2);
    });

    // RED (the record floor): delete `refuse`'s floor branch → a 0.5 m span lands
    // and the length assertion below fails (exit 1).
    test("createRecord refuses a span below the record floor", () => {
        const { state } = track();
        const w = createRecord(state, Lane.Force, {
            start: 0,
            end: RECORD_FLOOR / 2,
            ease: 0,
            exit: 1,
        });
        expect(w.id).toBeNull();
        expect(w.refusals.map((r) => r.guard)).toEqual(["segmentDegenerate"]);
        expect(laneRows(state, Lane.Force)).toHaveLength(0);
    });

    test("createRecord refuses a non-positive span", () => {
        const { state } = track();
        const w = createRecord(state, Lane.Force, { start: 10, end: 10, ease: 0, exit: 1 });
        expect(w.id).toBeNull();
        expect(w.refusals.map((r) => r.guard)).toContain("segmentDegenerate");
    });

    test("createRecord refuses a duplicate id and leaves the live record alone", () => {
        const { state } = track();
        const id = author(state, Lane.Force, { start: 0, end: 20, ease: 0, entry: 1, exit: 1 });
        const w = createRecord(state, Lane.Force, {
            id,
            start: 30,
            end: 40,
            ease: 0,
            exit: 1,
        });
        expect(w.id).toBeNull();
        expect(w.refusals.map((r) => r.guard)).toContain("duplicateId");
        expect(laneRows(state, Lane.Force)).toHaveLength(1);
    });

    // RED (setRecordSpan's overlap arm): delete its `refuse(...)` check → the span write lands
    // over its neighbour and the `start`/`end` assertions below fail (exit 1).
    test("setRecordSpan refuses an overlap and leaves BOTH ends untouched", () => {
        const { state } = track();
        const a = author(state, Lane.Force, { start: 0, end: 20, ease: 0, entry: 1, exit: 1 });
        author(state, Lane.Force, { start: 20, end: 40, ease: 0, exit: 1 });
        const w = setRecordSpan(state, a, 0, 25);
        expect(w.id).toBeNull();
        expect(w.refusals.map((r) => r.guard)).toEqual(["segmentOverlapped"]);
        const row = laneRows(state, Lane.Force)[0]!;
        expect([row.start, row.end]).toEqual([0, 20]);
    });

    // the origin law (spec Locked decision "the ruler starts at 0", S3a punch list item 1).
    // Before it, `setRecordSpan(id, -5, 15)` landed with no refusal at all and `deriveRuns`
    // clipped the record to a run over [0, 15) the document never authored.
    //
    // RED: delete `refuse`'s `row.start < 0` branch → both setters land, `w.id` is the record
    // and the span/length assertions below fail (exit 1).
    test("setRecordSpan refuses a start before the origin and leaves BOTH ends untouched", () => {
        const { state } = track();
        const id = author(state, Lane.Force, { start: 0, end: 20, ease: 0, entry: 1, exit: 1 });
        const w = setRecordSpan(state, id, -5, 15);
        expect(w.id).toBeNull();
        expect(w.refusals.map((r) => r.guard)).toEqual(["segmentBeforeOrigin"]);
        const row = laneRows(state, Lane.Force)[0]!;
        expect([row.start, row.end]).toEqual([0, 20]);
    });

    test("createRecord refuses a negative start and writes nothing", () => {
        const { state } = track();
        const w = createRecord(state, Lane.Velocity, {
            start: -5,
            end: 15,
            ease: 0,
            entry: 20,
            exit: 20,
        });
        expect(w.id).toBeNull();
        expect(w.refusals.map((r) => r.guard)).toEqual(["segmentBeforeOrigin"]);
        expect(laneRows(state, Lane.Velocity)).toHaveLength(0);
    });

    test("a span starting AT the origin is legal — 0 is on the ruler", () => {
        const { state } = track();
        const w = createRecord(state, Lane.Velocity, { start: 0, end: 15, ease: 0, exit: 20 });
        expect(w.refusals).toEqual([]);
        expect(laneRows(state, Lane.Velocity)).toHaveLength(1);
    });

    test("a setter addressed at a record that isn't there refuses by name", () => {
        const { state } = track();
        expect(setRecordSpan(state, 99, 0, 10).refusals.map((r) => r.guard)).toEqual([
            "recordNotFound",
        ]);
        expect(setRecordHandle(state, 99, "exit", 1).refusals.map((r) => r.guard)).toEqual([
            "recordNotFound",
        ]);
        expect(setRecordEase(state, 99, Easing.Cubic).refusals.map((r) => r.guard)).toEqual([
            "recordNotFound",
        ]);
        expect(deleteRecord(state, 99)).toBe(false);
    });

    // RED (the handle validity guard): delete `setRecordHandle`'s `Number.isFinite` check →
    // `NaN` lands on the exit and the read below is NaN, not 2 (exit 1).
    test("setRecordHandle refuses a non-finite handle", () => {
        const { state } = track();
        const id = author(state, Lane.Force, { start: 0, end: 20, ease: 0, entry: 1, exit: 2 });
        expect(setRecordHandle(state, id, "exit", Number.NaN).refusals.map((r) => r.guard)).toEqual(
            ["validHandle"],
        );
        expect(lanesOf(state).force[0]!.exit).toBe(2);
    });

    test("setRecordEase writes the tag and nothing else", () => {
        const { state } = track();
        const id = author(state, Lane.Geo, { start: 0, end: 20, ease: 0, entry: 0, exit: 0.2 });
        setRecordEase(state, id, Easing.Quintic);
        expect(lanesOf(state).geo[0]).toEqual({
            id,
            start: 0,
            end: 20,
            ease: Easing.Quintic,
            entry: 0,
            exit: 0.2,
        });
    });

    test("deleteRecord removes exactly its own record", () => {
        const { state } = track();
        const a = author(state, Lane.Force, { start: 0, end: 20, ease: 0, entry: 1, exit: 1 });
        const b = author(state, Lane.Force, { start: 20, end: 40, ease: 0, exit: 1 });
        expect(deleteRecord(state, a)).toBe(true);
        expect(laneRows(state, Lane.Force).map((r) => r.id)).toEqual([b]);
        expect(recordAt(state, a)).toBeNull();
    });
});

describe("the track-level columns", () => {
    test("an absent end FOLLOWS the longest lane; a pinned one is the answer", () => {
        const { state } = track();
        author(state, Lane.Force, { start: 0, end: 20, ease: 0, entry: 1, exit: 1 });
        author(state, Lane.Velocity, { start: 10, end: 46, ease: 0, entry: 12, exit: 12 });
        expect(endColumn(state)).toBe(0);
        expect(trackEndOf(state)).toBe(46);
        expect(setEnd(state, 60)).toEqual([]);
        expect(trackEndOf(state)).toBe(60);
        expect(setEnd(state, 0)).toEqual([]);
        expect(trackEndOf(state)).toBe(46);
    });

    // RED (the end floor): delete `setEnd`'s `endPinnable` check → the end pins at 30, below the
    // velocity lane's own 46 m of content, and the assertions below fail (exit 1).
    test("setEnd refuses an end below any lane's content", () => {
        const { state } = track();
        author(state, Lane.Force, { start: 0, end: 20, ease: 0, entry: 1, exit: 1 });
        author(state, Lane.Velocity, { start: 10, end: 46, ease: 0, entry: 12, exit: 12 });
        expect(setEnd(state, 30).map((r) => r.guard)).toEqual(["endBelowContent"]);
        expect(endColumn(state)).toBe(0);
        expect(trackEndOf(state)).toBe(46);
    });

    test("an absent order is the default; a permutation writes and reads back", () => {
        const { state } = track();
        expect(laneOrderOf(state)).toEqual([...DEFAULT_ORDER]);
        expect(setOrder(state, [Lane.Force, Lane.Geo, Lane.Velocity])).toEqual([]);
        expect(laneOrderOf(state)).toEqual([Lane.Force, Lane.Geo, Lane.Velocity]);
    });

    // RED (the order guard): delete `setOrder`'s `laneOrder` check and pack the raw list → a
    // repeat lands, `laneOrderOf` reads a lane twice, and the assertions below fail (exit 1).
    test("setOrder refuses anything that is not a permutation", () => {
        const { state } = track();
        setOrder(state, [Lane.Force, Lane.Geo, Lane.Velocity]);
        for (const bad of [
            [Lane.Geo, Lane.Geo, Lane.Force],
            [Lane.Geo, Lane.Force],
            [0, 1, 2, 2],
        ])
            expect(setOrder(state, bad).map((r) => r.guard)).toEqual(["laneOrder"]);
        expect(laneOrderOf(state)).toEqual([Lane.Force, Lane.Geo, Lane.Velocity]);
    });

    // RED (the start-speed floor): delete `setV0`'s floor check → 0.01 lands and `entrySpeed`
    // reads it back instead of holding 22 (exit 1).
    test("setV0 refuses below the floor; an absent v0 falls back to V0", () => {
        const { state } = track();
        expect(entrySpeed(state)).toBe(V0);
        expect(setV0(state, 22)).toEqual([]);
        expect(entrySpeed(state)).toBe(22);
        expect(setV0(state, MIN_V0 / 2).map((r) => r.guard)).toEqual(["minStartSpeed"]);
        expect(setV0(state, Number.NaN).map((r) => r.guard)).toEqual(["minStartSpeed"]);
        expect(entrySpeed(state)).toBe(22);
    });

    test("the domain column is a display lens: it writes, and the bake never reads it", () => {
        const { state, eid } = track();
        author(state, Lane.Force, { start: 0, end: 20, ease: 0, entry: 1, exit: 1 });
        state.step(0);
        const hash = bakeOut.get(eid)?.hash;
        expect(trackDomain(state)).toBe(Domain.Distance);
        setTrackDomain(state, Domain.Time);
        expect(trackDomain(state)).toBe(Domain.Time);
        expect(authoredHash(state)).toBe(hash as string);
    });
});

describe("snapshot identity", () => {
    test("a snapshot pair round-trips every record and every track column", () => {
        const { state } = track();
        setV0(state, 18);
        setOrder(state, [Lane.Force, Lane.Geo, Lane.Velocity]);
        author(state, Lane.Geo, { start: 0, end: 24, ease: Easing.Cubic, entry: 0, exit: 0.4 });
        author(state, Lane.Force, { start: 24, end: 44, ease: 0, exit: 1.6 });
        author(state, Lane.Velocity, { start: 4, end: 14, ease: 0, entry: 22, exit: 18 });
        setEnd(state, 50);

        const before = snapshotAll(state);
        restoreAll(state, before);
        expect(snapshotAll(state)).toEqual(before);
        expect(entrySpeed(state)).toBe(18);
        expect(laneOrderOf(state)).toEqual([Lane.Force, Lane.Geo, Lane.Velocity]);
        expect(endColumn(state)).toBe(50);
    });

    test("a restore RESPAWNS: a record deleted since the snapshot comes back with its id", () => {
        const { state } = track();
        const id = author(state, Lane.Force, { start: 0, end: 20, ease: 0, entry: 1, exit: 1 });
        const before = snapshotAll(state);
        deleteRecord(state, id);
        expect(laneRows(state, Lane.Force)).toHaveLength(0);
        restoreAll(state, before);
        expect(laneRows(state, Lane.Force).map((r) => r.id)).toEqual([id]);
    });

    test("a restore does NOT re-read the setter guards — undo is never lossy", () => {
        // a snapshot is by construction a state the setters already accepted, but a MIGRATED
        // document may carry a record below the record floor (spec: the floor is a gesture
        // refusal, not a document law). A restore that re-refused would silently drop it.
        const { state } = track();
        restoreAll(state, {
            records: [
                { lane: Lane.Force, id: 0, start: 0, end: 0.1, ease: 0, entry: 1, exit: 1 },
                { lane: Lane.Force, id: 1, start: 0.1, end: 20, ease: 0, exit: 1 },
            ],
            end: 0,
            order: 0,
            v0: 0,
        });
        expect(laneRows(state, Lane.Force)).toHaveLength(2);
        expect(laneRows(state, Lane.Force)[0]!.end).toBe(0.1);
    });
});

describe("the bake gate", () => {
    test("the bake runs off the lanes and publishes samples", () => {
        const { state, eid } = track();
        setV0(state, 20);
        author(state, Lane.Force, { start: 0, end: 20, ease: 0, entry: 1, exit: 1 });
        state.step(0);
        expect(Track.count.get(eid)).toBeGreaterThan(1);
        expect(samples.get(eid)?.posX[0]).toBe(0);
        expect(bakeLive(state)).toBe(true);
    });

    // RED (each hash term): delete a term from `bakeHash`'s row loop (say `r.exit`) → the edit
    // below leaves the hash unchanged, the gate skips, and the assertion fails (exit 1).
    test("every authored column moves the hash; the domain lens does not", () => {
        const { state } = track();
        const id = author(state, Lane.Force, { start: 0, end: 20, ease: 0, entry: 1, exit: 1 });
        const seen = new Set<string>([authoredHash(state)]);
        const moved = (): boolean => {
            const h = authoredHash(state);
            const isNew = !seen.has(h);
            seen.add(h);
            return isNew;
        };
        setRecordHandle(state, id, "exit", 1.4);
        expect(moved()).toBe(true);
        setRecordSpan(state, id, 0, 24);
        expect(moved()).toBe(true);
        setRecordEase(state, id, Easing.Quintic);
        expect(moved()).toBe(true);
        setV0(state, 21);
        expect(moved()).toBe(true);
        setEnd(state, 40);
        expect(moved()).toBe(true);
        setOrder(state, [Lane.Force, Lane.Geo, Lane.Velocity]);
        expect(moved()).toBe(true);
        author(state, Lane.Velocity, { start: 2, end: 12, ease: 0, entry: 12, exit: 12 });
        expect(moved()).toBe(true);
        setTrackDomain(state, Domain.Time);
        expect(moved()).toBe(false);
    });

    test("bakeLive is false before the first bake and after an edit", () => {
        const { state } = track();
        author(state, Lane.Force, { start: 0, end: 20, ease: 0, entry: 1, exit: 1 });
        expect(bakeLive(state)).toBe(false);
        state.step(0);
        expect(bakeLive(state)).toBe(true);
        setV0(state, 25);
        expect(bakeLive(state)).toBe(false);
    });

    // COVERAGE: the interim `seedTrack` arm retires with the function (S2e-ii punch list item
    // 3). Its property — a freshly seeded document bakes into a live track — is now `cli new`'s,
    // which seeds the retired boot track as a v3 document and migrates it (`tests/cli.test.ts`).
});

describe("the derived partition and the velocity framing", () => {
    test("runsOf cuts at the driving shape lane's groups", () => {
        const { state } = track();
        author(state, Lane.Geo, { start: 0, end: 20, ease: 0, entry: 0, exit: 0.2 });
        author(state, Lane.Force, { start: 20, end: 40, ease: 0, entry: 1, exit: 1 });
        expect(runsOf(state).map((r) => [r.kind, r.start, r.length])).toEqual([
            [SectionKind.Geo, 0, 20],
            [SectionKind.Force, 20, 20],
        ]);
        // lane order is priority: with force above, the force group takes the overlap.
        deleteRecord(state, laneRows(state, Lane.Force)[0]!.id);
        author(state, Lane.Force, { start: 0, end: 40, ease: 0, entry: 1, exit: 1 });
        setOrder(state, [Lane.Force, Lane.Geo, Lane.Velocity]);
        expect(runsOf(state).map((r) => r.kind)).toEqual([SectionKind.Force]);
    });

    // RED (the entry-law skip in `velocityRows`): drop the `entry === undefined` continue → a
    // record with no resolvable entry publishes a row and the framed count below rises (exit 1).
    test("stripsForStep frames ONE row per velocity record, in run-local edges", () => {
        const { state } = track();
        author(state, Lane.Force, { start: 0, end: 40, ease: 0, entry: 1, exit: 1 });
        author(state, Lane.Velocity, { start: 4, end: 12, ease: 0, entry: 20, exit: 24 });
        author(state, Lane.Velocity, { start: 12, end: 20, ease: 0, entry: 24, exit: 16 });
        const step = resolveStep(40, 0.5);
        const framed = stripsForStep(state, 0, step);
        expect(framed).toHaveLength(2);
        // the two records do NOT merge: abutting rows with different handles stay separate, so
        // no row averages across the seam.
        expect(framed?.map((r) => [r.start, r.end])).toEqual([
            [8, 24],
            [24, 40],
        ]);
        // and each row carries its own pre-evaluated per-edge curve.
        expect(framed?.[0]?.values).toBeInstanceOf(Float32Array);
    });

    test("a velocity record whose entry law resolves to nothing publishes no row", () => {
        const { state } = track();
        author(state, Lane.Force, { start: 0, end: 40, ease: 0, entry: 1, exit: 1 });
        // no owned entry, no abutting predecessor: velocity dissipates across the gap, so the
        // lane prescribes nothing at this record's start and the march owns it.
        author(state, Lane.Velocity, { start: 10, end: 20, ease: 0, exit: 18 });
        expect(stripsForStep(state, 0, resolveStep(40, 0.5))).toBeUndefined();
    });

    test("the record floor is one number, read from lanes.ts", () => {
        expect(RECORD_FLOOR).toBe(1);
        // and the pure law reads the same lanes the store publishes.
        const { state } = track();
        author(state, Lane.Force, { start: 0, end: 20, ease: 0, entry: 1, exit: 1 });
        expect(trackEnd(lanesOf(state), endColumn(state))).toBe(trackEndOf(state));
    });
});

describe("a setter refuses what the gesture introduces, never a violation already carried", () => {
    // `force/sub-min-spacing.kex` LOADS legally: the record floor is a setter law, not a
    // document one, so its force lane holds a legal 0.1 m record 1 at [2, 2.1). Reading the
    // whole candidate lane made that record refuse every other edit on the lane — a violation
    // the gesture neither made nor could clear (spec S2f punch list item 1; architect finding
    // from the Validation 3 dry run, 2026-09-07).
    //
    // RED: scope `refuse` back to the whole candidate lane (`laneRefusals(lane, candidate)`
    // plus the floor over every row) → the first arm's move is refused for record 1's floor and
    // the landing assertions fail (exit 1).
    function loaded(): State {
        const state = new State();
        state.addSystem(BakeSystem);
        loadDocument(
            state,
            readFileSync(join(import.meta.dir, "fixtures", "force", "sub-min-spacing.kex"), "utf8"),
        );
        return state;
    }

    test("record 2 moves to [3, 6) with the lane's carried sub-floor record untouched", () => {
        const state = loaded();
        expect(lanesOf(state).force.map((r) => [r.start, r.end])).toEqual([
            [0, 2],
            [2, 2.1],
            [2.1, 6],
        ]);
        const w = setRecordSpan(state, 2, 3, 6);
        expect(w.refusals).toEqual([]);
        expect(w.id).toBe(2);
        expect(lanesOf(state).force.map((r) => [r.id, r.start, r.end])).toEqual([
            [0, 0, 2],
            [1, 2, 2.1],
            [2, 3, 6],
        ]);
    });

    test("the same gesture is still refused when IT overlaps a neighbour", () => {
        const state = loaded();
        const w = setRecordSpan(state, 2, 2, 6);
        expect(w.id).toBeNull();
        expect(w.refusals.map((r) => r.guard)).toEqual(["segmentOverlapped"]);
        expect(lanesOf(state).force[2]).toMatchObject({ id: 2, start: 2.1, end: 6 });
    });

    test("the same gesture is still refused when IT drops under the record floor", () => {
        const state = loaded();
        const w = setRecordSpan(state, 2, 5.5, 6);
        expect(w.id).toBeNull();
        expect(w.refusals.map((r) => r.guard)).toEqual(["segmentDegenerate"]);
        expect(lanesOf(state).force[2]).toMatchObject({ start: 2.1, end: 6 });
    });

    test("a record carrying the violation may still edit its own OTHER columns", () => {
        // record 1 is the sub-floor one: its span is untouched by a handle write, so nothing
        // about the gesture introduces the floor breach.
        const state = loaded();
        expect(setRecordHandle(state, 1, "exit", 2.75).refusals).toEqual([]);
        expect(setRecordEase(state, 1, Easing.Linear).refusals).toEqual([]);
        // but record 1 cannot widen out of its own floor in place: every span that clears the
        // floor collides with a neighbour, which is a violation the gesture DOES introduce.
        expect(setRecordSpan(state, 1, 2, 2.5).refusals.map((r) => r.guard)).toEqual([
            "segmentDegenerate",
            "segmentOverlapped",
        ]);
        expect(setRecordSpan(state, 1, 1, 2.1).refusals.map((r) => r.guard)).toEqual([
            "segmentOverlapped",
        ]);
    });
});
