import { describe, expect, test } from "bun:test";
import { classifyKfHit, type KfHitCandidate } from "../src/kf-hit";

// the force chart's keyframe hit classifier, tested off-DOM (`strip-hit.test.ts`'s own shape).
// The projection is the caller's job, so every candidate here is already in canvas-local px.

const force = (id: number, x: number, y: number): KfHitCandidate => ({ kind: "force", id, x, y });
const strip = (id: number, x: number, y: number): KfHitCandidate => ({ kind: "strip", id, x, y });

describe("classifyKfHit", () => {
    test("nothing in range reads null — the caller's empty-surface grammar", () => {
        expect(classifyKfHit(0, 0, [force(1, 100, 100)], 12)).toBeNull();
        expect(classifyKfHit(0, 0, [], 12)).toBeNull();
    });

    test("a press on a diamond's centre hits it", () => {
        expect(classifyKfHit(100, 50, [force(7, 100, 50)], 12)).toEqual({ kind: "force", id: 7 });
        expect(classifyKfHit(100, 50, [strip(7, 100, 50)], 12)).toEqual({ kind: "strip", id: 7 });
    });

    test("the radius is a circle, not a box — a corner press at the box's edge misses", () => {
        // (9, 9) is inside a 12px BOX but outside the 12px circle (hypot 12.7).
        expect(classifyKfHit(9, 9, [force(1, 0, 0)], 12)).toBeNull();
        // straight out along one axis at the same 9px is comfortably inside.
        expect(classifyKfHit(9, 0, [force(1, 0, 0)], 12)).toEqual({ kind: "force", id: 1 });
    });

    test("the radius is inclusive at exactly `radius` px", () => {
        expect(classifyKfHit(12, 0, [force(1, 0, 0)], 12)).toEqual({ kind: "force", id: 1 });
        expect(classifyKfHit(13, 0, [force(1, 0, 0)], 12)).toBeNull();
    });

    test("nearest wins over list order, in both directions", () => {
        const far = force(1, 100, 0);
        const near = force(2, 104, 0);
        expect(classifyKfHit(105, 0, [far, near], 12)).toEqual({ kind: "force", id: 2 });
        expect(classifyKfHit(105, 0, [near, far], 12)).toEqual({ kind: "force", id: 2 });
    });

    test("an exact distance tie resolves to strip — the kind that was drawn on top", () => {
        const both: KfHitCandidate[] = [force(1, 100, 0), strip(2, 100, 0)];
        expect(classifyKfHit(100, 0, both, 12)).toEqual({ kind: "strip", id: 2 });
        // and the same answer with the list order reversed: the tie-break is on kind, not order.
        expect(classifyKfHit(100, 0, [both[1], both[0]], 12)).toEqual({ kind: "strip", id: 2 });
    });

    test("a nearer force keyframe still beats a farther strip one — kind only breaks exact ties", () => {
        expect(classifyKfHit(100, 0, [force(1, 100, 0), strip(2, 106, 0)], 12)).toEqual({
            kind: "force",
            id: 1,
        });
    });

    test("both axes are read — a keyframe at the same x but a far y is not a hit", () => {
        expect(classifyKfHit(100, 0, [force(1, 100, 40)], 12)).toBeNull();
    });
});
