import { describe, expect, test } from "bun:test";
import { ANGLE_STEP, LENGTH_STEP, resolveSnap, type SnapInput } from "../src/magnet";
import { SNAP_PX } from "../src/timeline";

// the resolver works entirely in screen px, so a test builds a raw drag point and target
// families directly in that space — no camera. the previous node is the polar origin; angles
// are screen-radians, lengths screen px converted through `pxPerMeter`.

const PREV = { x: 100, y: 100 };

function input(over: Partial<SnapInput>): SnapInput {
    return {
        px: 0,
        py: 0,
        prev: null,
        tangent: null,
        incoming: null,
        alignX: [],
        alignY: [],
        pxPerMeter: 50,
        lock: null,
        ...over,
    };
}

/** a screen point at `r` px and screen-angle `a` from the previous node. */
const polar = (r: number, a: number): { px: number; py: number } => ({
    px: PREV.x + r * Math.cos(a),
    py: PREV.y + r * Math.sin(a),
});

const angleOf = (r: { px: number; py: number }): number => Math.atan2(r.py - PREV.y, r.px - PREV.x);
const radiusOf = (r: { px: number; py: number }): number =>
    Math.hypot(r.px - PREV.x, r.py - PREV.y);

describe("cartesian neighbor alignment", () => {
    test("nearest-in-px wins among same-axis targets, one guide", () => {
        // two vertical-alignment targets; only the nearer (3px) latches — the other (10px)
        // shares its DOF, so it never co-fires.
        const res = resolveSnap(input({ px: 200, py: 100, alignX: [197, 190] }));
        expect(res.px).toBeCloseTo(197, 6);
        expect(res.py).toBe(100); // the free y axis is untouched
        expect(res.guides).toEqual([{ kind: "alignX", value: 197 }]);
    });

    test("orthogonal x + y align co-fire (their intersection)", () => {
        const res = resolveSnap(input({ px: 200, py: 100, alignX: [197], alignY: [104] }));
        expect(res.px).toBeCloseTo(197, 6);
        expect(res.py).toBeCloseTo(104, 6);
        expect(res.guides.map((g) => g.kind).sort()).toEqual(["alignX", "alignY"]);
    });

    test("nothing beyond SNAP_PX latches — the point is unchanged", () => {
        const res = resolveSnap(input({ px: 200, py: 100, alignX: [220], alignY: [130] }));
        expect(res.px).toBe(200);
        expect(res.py).toBe(100);
        expect(res.guides).toEqual([]);
        // the threshold boundary: 8px away is in range, 9px is not.
        expect(
            resolveSnap(input({ px: 200, py: 100, alignX: [200 + SNAP_PX] })).guides,
        ).toHaveLength(1);
        expect(
            resolveSnap(input({ px: 200, py: 100, alignX: [200 + SNAP_PX + 1] })).guides,
        ).toHaveLength(0);
    });
});

describe("chord-angle raster (15°)", () => {
    test("15° is the quantum", () => {
        expect(ANGLE_STEP).toBeCloseTo((15 * Math.PI) / 180, 12);
    });

    test("snaps the chord angle to the nearest 15° multiple", () => {
        // 2px-worth off the 15° ray at r=250 (perp = 250·sin(0.02) ≈ 5px, in range); the
        // radius (1.25 m at 200 px/m) sits far from any integer meter, so only the angle fires.
        const raw = polar(250, ANGLE_STEP + 0.02);
        const res = resolveSnap(input({ ...raw, prev: PREV, pxPerMeter: 200 }));
        expect(res.guides).toHaveLength(1);
        expect(res.guides[0].kind).toBe("angle");
        expect(res.guides[0].value).toBeCloseTo(ANGLE_STEP, 9);
        expect(angleOf(res)).toBeCloseTo(ANGLE_STEP, 6);
    });
});

describe("chord-length raster (1 m)", () => {
    test("1 m is the quantum", () => {
        expect(LENGTH_STEP).toBe(1);
    });

    test("snaps the chord length to the nearest integer meter", () => {
        // 3.1 m at 50 px/m = 155 px (floor 3 m = 150 px is 5px away, in range); the angle sits
        // exactly between two 15° multiples (7.5° off, perp ≈ 20px), so only the length fires.
        const raw = polar(3.1 * 50, ANGLE_STEP / 2);
        const res = resolveSnap(input({ ...raw, prev: PREV, pxPerMeter: 50 }));
        expect(res.guides).toHaveLength(1);
        expect(res.guides[0].kind).toBe("length");
        expect(res.guides[0].value).toBeCloseTo(150, 9); // 3 m × 50 px/m
        expect(radiusOf(res)).toBeCloseTo(150, 6);
    });
});

describe("angle landmarks", () => {
    test("continuation: snaps to the tangent heading, beating the raster", () => {
        // tangent 0.2 rad — not a 15° multiple; drag sits on it. the nearest raster (15°) is
        // also in range but farther, so continuation wins and the guide reads 0.2, not 15°.
        const raw = polar(100, 0.2);
        const res = resolveSnap(input({ ...raw, prev: PREV, tangent: 0.2, pxPerMeter: 70 }));
        expect(res.guides).toHaveLength(1);
        expect(res.guides[0].kind).toBe("angle");
        expect(res.guides[0].value).toBeCloseTo(0.2, 9);
        expect(angleOf(res)).toBeCloseTo(0.2, 6);
    });

    test("reflection: snaps to 2·tangent − incoming", () => {
        // tangent 0.2, incoming 0.5 → reflection −0.1. no 15° multiple is in range there, so
        // the reflection landmark is the sole target.
        const raw = polar(100, -0.1);
        const res = resolveSnap(
            input({ ...raw, prev: PREV, tangent: 0.2, incoming: 0.5, pxPerMeter: 70 }),
        );
        expect(res.guides).toHaveLength(1);
        expect(res.guides[0].kind).toBe("angle");
        expect(res.guides[0].value).toBeCloseTo(-0.1, 9);
        expect(angleOf(res)).toBeCloseTo(-0.1, 6);
    });
});

describe("polar grid — angle and length co-fire", () => {
    test("snaps both the angle and the radius (their intersection)", () => {
        // r = 200 px = exactly 1 m at 200 px/m (length latches, 0px); the angle is ~3px off the
        // 15° ray. orthogonal families, so both fire.
        const raw = polar(200, ANGLE_STEP + 0.015);
        const res = resolveSnap(input({ ...raw, prev: PREV, pxPerMeter: 200 }));
        expect(res.guides.map((g) => g.kind).sort()).toEqual(["angle", "length"]);
        expect(angleOf(res)).toBeCloseTo(ANGLE_STEP, 5);
        expect(radiusOf(res)).toBeCloseTo(200, 1);
    });
});

describe("shift axis-lock owns its axis", () => {
    test("y-locked: only x-compatible families fire; the locked axis is preserved", () => {
        // y locked → the drag moves horizontally. a vertical alignment line (align-x) is
        // reachable and fires; a horizontal one (align-y) is parallel to the movement — an
        // incompatible family — and never fires, even 3px away.
        const res = resolveSnap(
            input({ px: 200, py: 100, alignX: [203], alignY: [103], lock: "y" }),
        );
        expect(res.py).toBe(100); // the locked axis holds
        expect(res.px).toBeCloseTo(203, 6);
        expect(res.guides).toEqual([{ kind: "alignX", value: 203 }]);
    });

    test("x-locked: mirror — only y-compatible families fire", () => {
        const res = resolveSnap(
            input({ px: 200, py: 100, alignX: [203], alignY: [104], lock: "x" }),
        );
        expect(res.px).toBe(200); // the locked axis holds
        expect(res.py).toBeCloseTo(104, 6);
        expect(res.guides).toEqual([{ kind: "alignY", value: 104 }]);
    });

    test("a lock with nothing reachable leaves the point unchanged", () => {
        // only a parallel (incompatible) target is present under the lock.
        const res = resolveSnap(input({ px: 200, py: 100, alignY: [103], lock: "y" }));
        expect(res.px).toBe(200);
        expect(res.py).toBe(100);
        expect(res.guides).toEqual([]);
    });
});
