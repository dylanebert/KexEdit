import { describe, expect, test } from "bun:test";
import { ALIGN_PX, census, type HandleState, handleState, type Scale } from "../src/census";
import type { ForcePoint } from "../src/profile";

// the vocabulary census (src/census.ts): which tangent-mode shape a keyframe's two
// handles form, judged on the surface that shows them. Extracted out of `fitlab.ts` so
// the solver's authorability asserts and the lab's overlay are the same judgment.
//
// The scale below is 10 px per unit on both axes, so every offset in this file reads as
// px directly: an `in` of {ds: −1, dg: −2} is a handle 10 px left and 20 px down.
const SC: Scale = { s: 10, g: 10 };

function key(inn: [number, number] | null, out: [number, number] | null): ForcePoint {
    const p: ForcePoint = { s: 10, g: 1 };
    if (inn) p.in = { ds: inn[0], dg: inn[1] };
    if (out) p.out = { ds: out[0], dg: out[1] };
    return p;
}

describe("handle census — the vocabulary classifier", () => {
    test("collinear sides of equal screen length are mirrored", () => {
        expect(handleState(key([-1, -2], [1, 2]), SC)).toBe("mirror");
    });

    test("collinear sides of different length are aligned, not mirrored", () => {
        // same ray through the key, twice the reach on the out side.
        expect(handleState(key([-1, -2], [2, 4]), SC)).toBe("aligned");
    });

    test("a cusp is broken: both sides reach the same way", () => {
        // the in handle points FORWARD, so the curve doubles back through the key.
        expect(handleState(key([1, 1], [1, 1]), SC)).toBe("broken");
        // …and perpendicular sides, which are broken too. This does NOT pin the cusp
        // test's `>= 0` boundary — perpendicular is also nowhere near collinear, so the
        // collinearity check below would catch it either way. It pins the verdict, not
        // the branch that reaches it.
        expect(handleState(key([0, -1], [1, 0]), SC)).toBe("broken");
    });

    test("a visible break is broken", () => {
        expect(handleState(key([-1, 0], [1, 1]), SC)).toBe("broken");
    });

    test("the break tolerance is half a screen pixel, and it bites on both sides", () => {
        // u = (−10, 0), w = (10, δ·10): |cross| / min(|u|, |w|) ≈ δ·10 px of break.
        const under = 0.04; // 0.4 px — under ALIGN_PX, and short enough to read mirrored
        const over = 0.06; // 0.6 px — over it
        expect(ALIGN_PX).toBe(0.5);
        expect(handleState(key([-1, 0], [1, under]), SC)).not.toBe("broken");
        expect(handleState(key([-1, 0], [1, over]), SC)).toBe("broken");
    });

    test("a keyframe missing a side is single — there is nothing to break", () => {
        expect(handleState(key(null, [1, 2]), SC)).toBe("single");
        expect(handleState(key([-1, -2], null), SC)).toBe("single");
        expect(handleState(key(null, null), SC)).toBe("single");
    });

    test("a side too short to show a direction is broken", () => {
        // 0.1 px of handle: the ray it would be collinear with is not on the surface.
        expect(handleState(key([-0.01, 0], [1, 0]), SC)).toBe("broken");
    });

    test("the judgment is the SURFACE's, so the scale is part of it", () => {
        // a genuinely collinear pair reads non-broken wherever it is legible…
        const collinear = key([-1, -2], [1, 2]);
        for (const sc of [
            { s: 1, g: 1 },
            { s: 10, g: 10 },
            { s: 400, g: 4 },
        ] as Scale[])
            expect(handleState(collinear, sc)).not.toBe("broken");
        // …and a break that shrinks under half a pixel stops being one, which is the
        // point of judging on the surface rather than in data space.
        const bent = key([-1, 0], [1, 0.06]);
        expect(handleState(bent, { s: 10, g: 10 })).toBe("broken");
        expect(handleState(bent, { s: 1, g: 1 })).not.toBe("broken");
    });

    test("rejects a scale it could not judge anything on", () => {
        // a zero or negative axis collapses every handle onto the key, so EVERY keyframe
        // would census as broken — a silently unanimous verdict, the worst kind.
        for (const sc of [
            { s: 0, g: 1 },
            { s: 1, g: 0 },
            { s: -1, g: 1 },
            { s: 1, g: Number.NaN },
            { s: Number.POSITIVE_INFINITY, g: 1 },
        ] as Scale[])
            expect(() => handleState(key([-1, -2], [1, 2]), sc)).toThrow(
                /scale must be finite and > 0/,
            );
    });

    test("the census counts every keyframe exactly once", () => {
        const points = [
            key(null, [1, 2]), // single
            key([-1, -2], [1, 2]), // mirror
            key([-1, -2], [2, 4]), // aligned
            key([-1, 0], [1, 1]), // broken
            key([-1, -2], null), // single
        ];
        const stats = census(points, SC);
        expect(stats).toEqual({ mirror: 1, aligned: 1, broken: 1, single: 2 });
        const total = stats.mirror + stats.aligned + stats.broken + stats.single;
        expect(total).toBe(points.length);
        // and every state the classifier can return is one of the four counted.
        const states: HandleState[] = ["mirror", "aligned", "broken", "single"];
        for (const p of points) expect(states).toContain(handleState(p, SC));
    });

    test("an empty profile censuses to zeros", () => {
        expect(census([], SC)).toEqual({ mirror: 0, aligned: 0, broken: 0, single: 0 });
    });
});
