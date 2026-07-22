import { describe, expect, test } from "bun:test";
import { ANGLE_STEP, chordForIncline, inclineOf, snapAngle, snapLength } from "../src/magnet";

// the two snap grids are pure fixed-increment quantizers now (feel round 6, no proximity window):
// snap-by-default, the `snap` flag off (Ctrl held) bypasses to continuous. a test feeds a scalar
// and reads the snapped scalar back.

describe("length snap (whole-metre grid, min 1)", () => {
    test("snap on: quantizes to the nearest whole metre", () => {
        expect(snapLength(3.1, true)).toEqual({ meters: 3, snapped: true });
        expect(snapLength(3.9, true)).toEqual({ meters: 4, snapped: true }); // nearer, not down
    });

    test("snap off (Ctrl bypass): continuous, passes the raw length through", () => {
        const res = snapLength(3.1, false);
        expect(res.snapped).toBe(false);
        expect(res.meters).toBeCloseTo(3.1, 12);
    });

    test("the 1 m floor holds either way — a chord never collapses onto the previous node", () => {
        // snapped: a sub-half-metre drag rounds toward 0, floored to 1.
        expect(snapLength(0.2, true)).toEqual({ meters: 1, snapped: true });
        // continuous: a tiny raw length is still floored to 1.
        expect(snapLength(0.2, false)).toEqual({ meters: 1, snapped: false });
    });
});

describe("angle snap (5° grid)", () => {
    test("5° is the quantum", () => {
        expect(ANGLE_STEP).toBeCloseTo((5 * Math.PI) / 180, 12);
    });

    test("snaps an angle to the nearest 5° grid multiple", () => {
        const step = ANGLE_STEP;
        // just past 2 steps (10°) → snaps back to 10°; just under 3 steps (15°) → snaps up to 15°.
        expect(snapAngle(2 * step + 0.002)).toBeCloseTo(2 * step, 9);
        expect(snapAngle(3 * step - 0.002)).toBeCloseTo(3 * step, 9);
    });

    test("a negative angle snaps symmetrically", () => {
        expect(snapAngle(-2 * ANGLE_STEP + 0.002)).toBeCloseTo(-2 * ANGLE_STEP, 9);
    });

    test("the exit-incline convention round-trips (the tip maps incline → chord)", () => {
        // incline = 2·chord − tangent; the chord that yields it is (incline + tangent)/2.
        const tangent = 0.2;
        const chord = 0.35;
        const incline = inclineOf(chord, tangent);
        expect(chordForIncline(incline, tangent)).toBeCloseTo(chord, 12);
    });
});
