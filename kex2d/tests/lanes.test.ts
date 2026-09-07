import { describe, expect, test } from "bun:test";
import {
    type LaneSegment,
    Lane,
    endPinnable,
    laneOrder,
    entryValue,
    inferredEntry,
    laneExclusive,
    laneExit,
    laneRefusals,
    ordered,
    segmentOverlapped,
    trackEnd,
} from "../src/lanes";
import { DEFAULT_G, Easing } from "../src/profile";

// the pure lane substrate's own oracle (spec `kex2d-segment-gestures` § Validation 1). Two laws
// carry the stage: EXCLUSIVITY within a lane (half-open spans never overlap, abutting is legal,
// an overlap is refused and never clamped) and ENTRY INFERENCE across a gap (owned entry, else
// the abutting predecessor's exit, else the lane's own rule). Every case below reads the
// exported law functions directly — no ECS, no bake, no re-derivation of the rule under test.

function seg(id: number, start: number, end: number, exit: number, entry?: number): LaneSegment {
    return { id, start, end, ease: Easing.Linear, exit, ...(entry === undefined ? {} : { entry }) };
}

describe("exclusivity: overlap is refused, abutting is legal", () => {
    const lane = [seg(1, 0, 10, 5), seg(2, 20, 30, 7)];

    test("abutting spans do not overlap in either direction", () => {
        // [10, 20) closes the gap exactly: it touches both neighbours and overlaps neither.
        expect(segmentOverlapped(lane, 10, 20)).toBe(false);
        // and the same span probed from each side of a shared boundary.
        expect(segmentOverlapped([seg(1, 0, 10, 5)], 10, 15)).toBe(false);
        expect(segmentOverlapped([seg(1, 10, 20, 5)], 0, 10)).toBe(false);
    });

    test("a span crossing a boundary by any amount overlaps", () => {
        expect(segmentOverlapped(lane, 9.999_999, 20)).toBe(true);
        expect(segmentOverlapped(lane, 10, 20.000_001)).toBe(true);
        // strict containment, and containment the other way round.
        expect(segmentOverlapped(lane, 2, 3)).toBe(true);
        expect(segmentOverlapped(lane, -5, 40)).toBe(true);
        // an identical span.
        expect(segmentOverlapped(lane, 0, 10)).toBe(true);
    });

    test("a zero-length or inverted probe intersects nothing", () => {
        expect(segmentOverlapped(lane, 5, 5)).toBe(false);
        expect(segmentOverlapped(lane, 8, 2)).toBe(false);
    });

    test("exceptId excludes exactly the record a resize is replacing, and nothing else", () => {
        // segment 1 growing into its own span is legal; growing into 2's is not.
        expect(segmentOverlapped(lane, 0, 15, 1)).toBe(false);
        expect(segmentOverlapped(lane, 0, 25, 1)).toBe(true);
        // an id that matches nothing excludes nothing.
        expect(segmentOverlapped(lane, 0, 10, 99)).toBe(true);
    });

    test("laneExclusive reads the whole lane, gaps and abutment included", () => {
        expect(laneExclusive([])).toBe(true);
        expect(laneExclusive(lane)).toBe(true);
        expect(laneExclusive([seg(1, 0, 10, 5), seg(2, 10, 20, 7)])).toBe(true);
        expect(laneExclusive([seg(1, 0, 10, 5), seg(2, 9, 20, 7)])).toBe(false);
        // unsorted input is ordered before the pairwise read, so array order cannot hide an overlap.
        expect(laneExclusive([seg(2, 9, 20, 7), seg(1, 0, 10, 5)])).toBe(false);
    });

    test("laneRefusals names the overlapping pair, the degenerate span and the duplicate id", () => {
        const overlap = laneRefusals(Lane.Force, [seg(1, 0, 10, 5), seg(2, 4, 12, 7)]);
        expect(overlap.map((r) => r.guard)).toEqual(["segmentOverlapped"]);
        expect(overlap[0]!.message).toContain("force segment 2");

        expect(laneRefusals(Lane.Velocity, [seg(1, 5, 5, 12)]).map((r) => r.guard)).toEqual([
            "segmentDegenerate",
        ]);
        expect(
            laneRefusals(Lane.Geo, [seg(1, 0, 4, 0), seg(1, 8, 12, 0)]).map((r) => r.guard),
        ).toEqual(["duplicateId"]);
        // a well-formed lane refuses nothing — the permit direction of the same predicate.
        expect(laneRefusals(Lane.Force, [seg(1, 0, 10, 5), seg(2, 10, 20, 7)])).toEqual([]);
    });

    test("ordered is total and never mutates its input", () => {
        const input = [seg(3, 5, 9, 1), seg(1, 0, 4, 1), seg(2, 0, 4, 1)];
        const out = ordered(input);
        expect(out.map((s) => s.id)).toEqual([1, 2, 3]);
        expect(input.map((s) => s.id)).toEqual([3, 1, 2]);
    });
});

describe("entry inference across a gap, per lane rule", () => {
    // one shared shape across the three lanes: two segments with a real gap between them, the
    // second owning no entry, so the answer is the lane's own inference and nothing else.
    const gapped = [seg(1, 0, 10, 4.5), seg(2, 20, 30, 9)];

    test("velocity dissipates: no prescription across the gap", () => {
        expect(inferredEntry(Lane.Velocity, gapped, 20)).toBeUndefined();
        expect(entryValue(Lane.Velocity, gapped, gapped[1]!)).toBeUndefined();
        // and before anything is authored at all.
        expect(inferredEntry(Lane.Velocity, [], 0)).toBeUndefined();
    });

    test("force dwells at the last authored exit, DEFAULT_G before any", () => {
        expect(inferredEntry(Lane.Force, gapped, 20)).toBe(4.5);
        expect(entryValue(Lane.Force, gapped, gapped[1]!)).toBe(4.5);
        // strictly "at or before": a segment ending past the station is not the dwell source.
        expect(inferredEntry(Lane.Force, gapped, 5)).toBe(DEFAULT_G);
        expect(inferredEntry(Lane.Force, [], 0)).toBe(DEFAULT_G);
        expect(entryValue(Lane.Force, gapped, gapped[0]!)).toBe(DEFAULT_G);
    });

    test("geo yields to the force lane: no shape of its own across the gap", () => {
        expect(inferredEntry(Lane.Geo, gapped, 20)).toBeUndefined();
        expect(entryValue(Lane.Geo, gapped, gapped[1]!)).toBeUndefined();
    });

    test("an owned entry wins over both the predecessor and the lane rule", () => {
        const owned = seg(2, 20, 30, 9, 2.25);
        for (const lane of [Lane.Velocity, Lane.Force, Lane.Geo]) {
            expect(entryValue(lane, [gapped[0]!, owned], owned)).toBe(2.25);
        }
        // including where the predecessor abuts and would otherwise supply a different value.
        const abut = seg(2, 10, 30, 9, 2.25);
        expect(entryValue(Lane.Force, [gapped[0]!, abut], abut)).toBe(2.25);
    });

    test("an abutting predecessor's exit wins over the lane rule, in every lane", () => {
        const abut = seg(2, 10, 30, 9);
        const lane = [gapped[0]!, abut];
        expect(entryValue(Lane.Velocity, lane, abut)).toBe(4.5);
        expect(entryValue(Lane.Force, lane, abut)).toBe(4.5);
        expect(entryValue(Lane.Geo, lane, abut)).toBe(4.5);
    });

    test("a predecessor that ends short of the start does not abut", () => {
        // one metre of gap is a gap: velocity falls back to no prescription, force to the dwell
        // (the same number here, which is why the velocity leg above is the discriminating one).
        const near = seg(2, 10.000_001, 30, 9);
        expect(entryValue(Lane.Velocity, [gapped[0]!, near], near)).toBeUndefined();
    });
});

/** a geo record: its handles are PITCH angles (absolute unwrapped world heading, radians), the
 *  same scalar shape every other lane carries. */
function geoSeg(id: number, start: number, end: number): LaneSegment {
    return { id, start, end, ease: 0, exit: 0 };
}

describe("track end", () => {
    const lanes = {
        velocity: [seg(1, 0, 12, 20)],
        force: [seg(2, 0, 30, 1)],
        geo: [geoSeg(3, 0, 8)],
    };

    test("0 follows the longest lane's last exit", () => {
        expect(trackEnd(lanes, 0)).toBe(30);
        expect(laneExit(lanes.velocity)).toBe(12);
        expect(laneExit([])).toBe(0);
        expect(trackEnd({ velocity: [], force: [], geo: [] }, 0)).toBe(0);
    });

    test("a pinned end is the answer, above or below the content", () => {
        expect(trackEnd(lanes, 45)).toBe(45);
        expect(trackEnd(lanes, 5)).toBe(5);
    });

    test("the end handle refuses to move below any lane's content", () => {
        expect(endPinnable(lanes, 30)).toBe(true);
        expect(endPinnable(lanes, 31)).toBe(true);
        expect(endPinnable(lanes, 29.999_999)).toBe(false);
        expect(endPinnable(lanes, 0)).toBe(true); // follow is always legal
        expect(endPinnable(lanes, -1)).toBe(false);
        expect(endPinnable(lanes, Number.NaN)).toBe(false);
    });
});

/** `track.order` is document state that changes the bake (`projection.deriveRuns` cuts at the
 *  higher shape lane's groups), so a list that is not a PERMUTATION of the three lanes leaves a
 *  lane unranked — a different document from the one the file claims — and is refused rather
 *  than padded. Spec Locked decision "geo and force overlap: store both, lane order drives". */
describe("lane order is a permutation or nothing", () => {
    test("every permutation of the three lanes is accepted, identity included", () => {
        expect(laneOrder([Lane.Velocity, Lane.Force, Lane.Geo])).toEqual([
            Lane.Velocity,
            Lane.Force,
            Lane.Geo,
        ]);
        expect(laneOrder([Lane.Geo, Lane.Force, Lane.Velocity])).toEqual([
            Lane.Geo,
            Lane.Force,
            Lane.Velocity,
        ]);
        expect(laneOrder([Lane.Force, Lane.Geo, Lane.Velocity])).toEqual([
            Lane.Force,
            Lane.Geo,
            Lane.Velocity,
        ]);
    });

    test("a short, long, repeating or unknown-lane order is refused", () => {
        expect(laneOrder([])).toBeUndefined();
        expect(laneOrder([Lane.Geo, Lane.Force])).toBeUndefined();
        expect(laneOrder([Lane.Geo, Lane.Force, Lane.Velocity, Lane.Geo])).toBeUndefined();
        // a repeat is the case a length check alone cannot see: three entries, one lane unranked.
        expect(laneOrder([Lane.Geo, Lane.Geo, Lane.Force])).toBeUndefined();
        expect(laneOrder([Lane.Geo, Lane.Force, 3])).toBeUndefined();
        expect(laneOrder([Lane.Geo, Lane.Force, -1])).toBeUndefined();
        // and a non-number never resolves to a lane by coercion.
        expect(laneOrder([Lane.Geo, Lane.Force, "0"])).toBeUndefined();
        expect(laneOrder([Lane.Geo, Lane.Force, null])).toBeUndefined();
    });
});
