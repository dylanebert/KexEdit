import { describe, expect, test } from "bun:test";
import {
    classifyKfHit,
    type KfHitCandidate,
    type KfPointCandidate,
    type KfSpanCandidate,
} from "../src/kf-hit";

const point = (kind: "force" | "strip", id: number, x: number, y: number): KfPointCandidate => ({
    kind,
    id,
    x,
    y,
});
const span = (id: number, x0: number, x1: number): KfSpanCandidate => ({ id, x0, x1 });
const candidates = (overrides: Partial<KfHitCandidate> = {}): KfHitCandidate => ({
    knobs: [],
    points: [],
    spans: [],
    ...overrides,
});

describe("classifyKfHit", () => {
    test("empty chart is explicit", () => {
        expect(classifyKfHit(20, 40, candidates(), 12)).toEqual({ kind: "empty" });
    });

    test("nearest point wins independent of list order", () => {
        const far = point("force", 1, 20, 20);
        const near = point("force", 2, 24, 20);
        expect(classifyKfHit(25, 20, candidates({ points: [far, near] }), 12)).toEqual({
            kind: "point",
            pointKind: "force",
            id: 2,
        });
        expect(classifyKfHit(25, 20, candidates({ points: [near, far] }), 12)).toEqual({
            kind: "point",
            pointKind: "force",
            id: 2,
        });
    });

    test("point radius is circular and inclusive", () => {
        expect(classifyKfHit(9, 9, candidates({ points: [point("force", 1, 0, 0)] }), 12)).toEqual({
            kind: "empty",
        });
        expect(classifyKfHit(12, 0, candidates({ points: [point("force", 1, 0, 0)] }), 12)).toEqual(
            {
                kind: "point",
                pointKind: "force",
                id: 1,
            },
        );
    });

    test("strip breaks an exact point tie but a nearer force point wins", () => {
        const force = point("force", 1, 20, 20);
        const strip = point("strip", 2, 20, 20);
        expect(classifyKfHit(20, 20, candidates({ points: [force, strip] }), 12)).toEqual({
            kind: "point",
            pointKind: "strip",
            id: 2,
        });
        expect(
            classifyKfHit(20, 20, candidates({ points: [force, { ...strip, x: 26 }] }), 12),
        ).toEqual({ kind: "point", pointKind: "force", id: 1 });
    });

    test("knob has precedence over a coincident point and boundary", () => {
        expect(
            classifyKfHit(
                20,
                20,
                candidates({
                    knobs: [{ id: 7, edge: "end", x: 20, y: 20 }],
                    points: [point("strip", 2, 20, 20)],
                    spans: [span(7, 0, 20)],
                }),
                12,
            ),
        ).toEqual({ kind: "knob", id: 7, edge: "end" });
    });

    test("a coincident velocity point is more specific than a member boundary", () => {
        expect(
            classifyKfHit(
                20,
                60,
                candidates({ points: [point("strip", 4, 20, 60)], spans: [span(7, 0, 20)] }),
                12,
            ),
        ).toEqual({ kind: "point", pointKind: "strip", id: 4 });
    });

    test("boundary precedes body and nearest boundary wins", () => {
        expect(
            classifyKfHit(21, 60, candidates({ spans: [span(1, 0, 20), span(2, 20, 50)] }), 12),
        ).toEqual({ kind: "boundary", id: 1 });
    });

    test("span body and outside-chart space are distinguished", () => {
        const input = candidates({ spans: [span(9, 10, 30)] });
        expect(classifyKfHit(20, 60, input, 4)).toEqual({ kind: "body", id: 9 });
        expect(classifyKfHit(40, 60, input, 4)).toEqual({ kind: "empty" });
    });
});
