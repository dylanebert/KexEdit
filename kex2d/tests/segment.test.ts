import { describe, expect, test } from "bun:test";
import {
    type Boundary,
    type Chain,
    type HermiteCurve,
    type Segment,
    type Vec,
    allowedSelectionActions,
    boundaryAddress,
    deleteSegment,
    insertSegment,
    isDwell,
    readEnd,
    readStart,
    resizeDuration,
    scaleGeometry,
    splitCubic,
    splitHermite,
    startBoundary,
    toggleSelectionMember,
    unionChannelBoundaries,
} from "../src/segment";

const v = (x: number, y: number): Vec => [x, y];
const end = (id: string, value: number): Boundary => ({ id, value });
const segment = (id: string, duration: number, value: number): Segment => ({
    id,
    kind: "Force",
    duration,
    easing: "Cubic",
    end: end(`${id}-end`, value),
});

function chain(...segments: Segment[]): Chain {
    return { start: startBoundary("start", 0), segments };
}

describe("pure segment chain", () => {
    test("addresses segment ends stably and followers read their predecessor", () => {
        const c = chain(segment("a", 2, 4), segment("b", 3, 9));
        expect(boundaryAddress(c, "a")).toEqual({ segmentId: "a", side: "end" });
        expect(boundaryAddress(c, "b")).toEqual({ segmentId: "b", side: "end" });
        expect(boundaryAddress(c, "b", "start")).toEqual({ segmentId: "a", side: "end" });
        expect(readEnd(c, "a")).toBe(c.segments[0].end);
        expect(readStart(c, "a")).toBe(c.start);
        expect(readStart(c, "b")).toBe(c.segments[0].end);
        expect(c.segments[0].end.value).toBe(4);
        expect(c.segments[1].end.value).toBe(9);
        expect(c.start.value).toBe(0);
    });

    test("a dwell is the uniform segment form with equal predecessor and end values", () => {
        const c = chain(segment("dwell", 2, 1));
        expect(isDwell(c, "dwell")).toBe(false);
        c.segments[0].end.value = 0;
        expect(isDwell(c, "dwell")).toBe(true);
    });

    test("insert and delete preserve a gapless chain and absolute end ownership", () => {
        const original = chain(segment("a", 2, 4), segment("b", 3, 9));
        const inserted = insertSegment(original, segment("x", 1, 7), 1);
        expect(inserted.segments.map((s) => s.id)).toEqual(["a", "x", "b"]);
        expect(inserted.segments[1].end.value).toBe(7);
        expect(deleteSegment(inserted, "x").segments.map((s) => s.id)).toEqual(["a", "b"]);
        expect(deleteSegment(inserted, "x").segments[0].end.value).toBe(7);
    });

    test("duration edits affix later boundaries and ripple their stations", () => {
        const c = chain(segment("a", 2, 4), segment("b", 3, 9), segment("c", 5, 12));
        const edited = resizeDuration(c, "b", 7);
        expect(edited.segments.map((s) => s.id)).toEqual(["a", "b", "c"]);
        expect(edited.segments.map((s) => s.end.value)).toEqual([4, 9, 12]);
        expect(edited.segments.map((s) => s.duration)).toEqual([2, 7, 5]);
        expect(edited.segments.map((s) => s.station)).toEqual([0, 2, 9]);
        expect(edited.totalDuration).toBe(14);
    });
});

describe("exact curve laws", () => {
    test("splits a cubic exactly by De Casteljau", () => {
        const curve = [0, 3, 8, 10] as const;
        const [left, right] = splitCubic(curve, 0.25);
        expect(left[0]).toBe(0);
        expect(left[3]).toBe(right[0]);
        expect(right[3]).toBe(10);
        for (const t of [0, 0.1, 0.25, 0.7, 1]) {
            const point = (p: readonly number[], u: number) =>
                (1 - u) ** 3 * p[0] +
                3 * (1 - u) ** 2 * u * p[1] +
                3 * (1 - u) * u ** 2 * p[2] +
                u ** 3 * p[3];
            const expected = point(curve, t);
            const actual = t <= 0.25 ? point(left, t / 0.25) : point(right, (t - 0.25) / 0.75);
            expect(actual).toBeCloseTo(expected, 12);
        }
    });

    test("splits Hermite curves without changing evaluated geometry", () => {
        const curve: HermiteCurve = { p0: v(0, 0), p1: v(10, 5), m0: v(6, 3), m1: v(2, -4) };
        const [left, right] = splitHermite(curve, 0.4);
        const evalHermite = (q: HermiteCurve, t: number): Vec => {
            const h00 = 2 * t ** 3 - 3 * t ** 2 + 1;
            const h10 = t ** 3 - 2 * t ** 2 + t;
            const h01 = -2 * t ** 3 + 3 * t ** 2;
            const h11 = t ** 3 - t ** 2;
            return [
                h00 * q.p0[0] + h10 * q.m0[0] + h01 * q.p1[0] + h11 * q.m1[0],
                h00 * q.p0[1] + h10 * q.m0[1] + h01 * q.p1[1] + h11 * q.m1[1],
            ];
        };
        for (const t of [0, 0.1, 0.4, 0.8, 1]) {
            const expected = evalHermite(curve, t);
            const actual =
                t <= 0.4 ? evalHermite(left, t / 0.4) : evalHermite(right, (t - 0.4) / 0.6);
            expect(actual[0]).toBeCloseTo(expected[0], 12);
            expect(actual[1]).toBeCloseTo(expected[1], 12);
        }
    });

    test("geometry scaling scales endpoint and concrete control vectors in entry frame", () => {
        const curve: HermiteCurve = { p0: v(0, 0), p1: v(4, 2), m0: v(3, 1), m1: v(2, -2) };
        expect(scaleGeometry(curve, 2)).toEqual({
            p0: [0, 0],
            p1: [8, 4],
            m0: [6, 2],
            m1: [4, -4],
        });
    });
});

describe("channel union and multiselection", () => {
    test("unioning channel boundaries preserves each channel evaluator at every cut", () => {
        const cuts = unionChannelBoundaries([
            [0, 2, 10],
            [0, 4, 10],
            [0, 3, 10],
        ]);
        const controls: readonly [readonly number[], readonly number[]] = [
            [0, 3, 8, 10],
            [4, 1, 7, 2],
        ];
        const evaluate = (curve: readonly number[], t: number): number =>
            (1 - t) ** 3 * curve[0] +
            3 * (1 - t) ** 2 * t * curve[1] +
            3 * (1 - t) * t ** 2 * curve[2] +
            t ** 3 * curve[3];
        const splitAll = (curve: readonly number[]): [number, number, readonly number[]][] => {
            const pieces: [number, number, readonly number[]][] = [];
            let from = 0;
            let current = curve;
            for (const to of cuts.slice(1, -1)) {
                const local = (to - from) / (10 - from);
                const [left, right] = splitCubic(
                    current as readonly [number, number, number, number],
                    local,
                );
                pieces.push([from, to, left]);
                current = right;
                from = to;
            }
            pieces.push([from, 10, current]);
            return pieces;
        };
        for (const curve of controls) {
            const pieces = splitAll(curve);
            for (const station of [0.5, 2, 2.5, 3.5, 5, 7, 9.5, 10]) {
                const before = evaluate(curve, station / 10);
                const piece = pieces.find(([from, to]) => station >= from && station <= to);
                if (!piece) throw new Error(`no piece at ${station}`);
                const [from, to, pieceCurve] = piece;
                const after = evaluate(pieceCurve, (station - from) / (to - from));
                expect(after).toBeCloseTo(before, 12);
            }
        }
    });

    test("a multi-selection exposes membership plus optimize and delete only", () => {
        expect(toggleSelectionMember(["a"], "b")).toEqual(["a", "b"]);
        expect(toggleSelectionMember(["a", "b"], "a")).toEqual(["b"]);
        expect(allowedSelectionActions(["a", "b"])).toEqual(["membership", "optimize", "delete"]);
    });
});
