import { describe, expect, test } from "bun:test";
import { classifyStripHit, type StripHitCandidate } from "../src/strip-hit";

// the header band's pure hit-test classifier (`src/strip-hit.ts`) — driven directly with
// hand-built screen-px candidates, off-DOM, per the Locked decision's "by interval membership,
// never rendered pixels."
const R = 6;

describe("classifyStripHit", () => {
    test("empty band with no strips", () => {
        expect(classifyStripHit(50, [], R)).toEqual({ kind: "empty" });
    });

    test("a point strictly inside a strip's body reads as body", () => {
        const strips: StripHitCandidate[] = [{ id: 1, x0: 20, x1: 80 }];
        expect(classifyStripHit(50, strips, R)).toEqual({ kind: "body", id: 1 });
    });

    test("outside every strip's span reads as empty", () => {
        const strips: StripHitCandidate[] = [{ id: 1, x0: 20, x1: 80 }];
        expect(classifyStripHit(100, strips, R)).toEqual({ kind: "empty" });
    });

    test("within radius of the start edge reads as the start endpoint, even inside the body", () => {
        const strips: StripHitCandidate[] = [{ id: 1, x0: 20, x1: 80 }];
        expect(classifyStripHit(23, strips, R)).toEqual({ kind: "endpoint", id: 1, edge: "start" });
    });

    test("within radius of the end edge reads as the end endpoint", () => {
        const strips: StripHitCandidate[] = [{ id: 1, x0: 20, x1: 80 }];
        expect(classifyStripHit(76, strips, R)).toEqual({ kind: "endpoint", id: 1, edge: "end" });
    });

    // the exact boundary of the radius is admitted (`<=`), one past it is not — pins the
    // classifier's own threshold rather than an approximate "near" reading.
    test("radius boundary is inclusive; one px past it falls back to body", () => {
        const strips: StripHitCandidate[] = [{ id: 1, x0: 20, x1: 80 }];
        expect(classifyStripHit(26, strips, R)).toEqual({ kind: "endpoint", id: 1, edge: "start" });
        expect(classifyStripHit(27, strips, R)).toEqual({ kind: "body", id: 1 });
    });

    test("a degenerate zero-length point strip hits as an endpoint (its own edge), not a body", () => {
        const strips: StripHitCandidate[] = [{ id: 1, x0: 40, x1: 40 }];
        expect(classifyStripHit(40, strips, R)).toEqual({ kind: "endpoint", id: 1, edge: "start" });
        // still no body hit either side of the point beyond the radius
        expect(classifyStripHit(50, strips, R)).toEqual({ kind: "empty" });
    });

    test("two abutting strips: the shared boundary resolves to whichever is listed first", () => {
        const strips: StripHitCandidate[] = [
            { id: 1, x0: 0, x1: 40 },
            { id: 2, x0: 40, x1: 80 },
        ];
        expect(classifyStripHit(40, strips, R)).toEqual({ kind: "endpoint", id: 1, edge: "end" });
        // reordering the input flips the tie — deterministic on draw order, not a hidden rule
        expect(classifyStripHit(40, [strips[1], strips[0]], R)).toEqual({
            kind: "endpoint",
            id: 2,
            edge: "start",
        });
    });

    test("two strips with a gap: a point between them, past both radii, is empty", () => {
        const strips: StripHitCandidate[] = [
            { id: 1, x0: 0, x1: 20 },
            { id: 2, x0: 60, x1: 80 },
        ];
        expect(classifyStripHit(40, strips, R)).toEqual({ kind: "empty" });
    });
});
