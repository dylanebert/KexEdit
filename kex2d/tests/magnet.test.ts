import { afterEach, describe, expect, test } from "bun:test";
import { chordForIncline, inclineOf, snapAngle, snapGrid, snapLength } from "../src/magnet";
import {
    ANGLE_STEP_DEFAULT as ANGLE_STEP,
    LENGTH_STEP_DEFAULT,
    setSnapAngle,
    setSnapLength,
} from "../src/settings";

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

// the interior chord axes' quantizer (kex2d-node-move-ux stage 2, the adversarial-pass fix): the
// SAME whole-metre grid as `snapLength`, but with NO floor — a signed 1D coordinate legitimately
// passes through 0 and negative (unlike a chord, which would leave `polarFrame` with no direction
// at 0). Reusing `snapLength` here was the original (buggy) shape: its `Math.max(LENGTH_MIN, q)`
// floor forced a snapped slide/offset near 0 to jump to ±1, and clamped every negative value to
// +1 outright unless the caller restored the sign by hand.
describe("grid snap (whole-metre grid, NO floor)", () => {
    test("snap on: quantizes to the nearest whole metre, same grid as snapLength", () => {
        expect(snapGrid(3.1, true)).toEqual({ meters: 3, snapped: true });
        expect(snapGrid(3.9, true)).toEqual({ meters: 4, snapped: true });
    });

    test("snap off (Ctrl bypass): continuous, passes the raw value through", () => {
        const res = snapGrid(3.1, false);
        expect(res.snapped).toBe(false);
        expect(res.meters).toBeCloseTo(3.1, 12);
    });

    test("quantizes straight through 0 — no floor pushes a near-zero value to ±1", () => {
        expect(snapGrid(0.2, true)).toEqual({ meters: 0, snapped: true });
        expect(snapGrid(-0.2, true)).toEqual({ meters: 0, snapped: true });
        expect(snapGrid(0, true)).toEqual({ meters: 0, snapped: true });
    });

    test("negative values quantize and keep their sign — never clamped positive", () => {
        expect(snapGrid(-3.1, true)).toEqual({ meters: -3, snapped: true });
        expect(snapGrid(-0.6, true)).toEqual({ meters: -1, snapped: true });
        expect(snapGrid(-3.1, false).meters).toBeCloseTo(-3.1, 12);
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

// the two increments are per-user settings (`settings.ts`), read LIVE per quantize — an edited
// value takes effect on the next drag with nothing to re-wire. one input, two grids, two answers.
describe("configurable increments", () => {
    const deg = (d: number): number => (d * Math.PI) / 180;

    afterEach(() => {
        setSnapAngle(ANGLE_STEP);
        setSnapLength(LENGTH_STEP_DEFAULT);
    });

    test("the angle increment decides what an angle snaps to", () => {
        expect(snapAngle(deg(2.6))).toBeCloseTo(deg(5), 9); // default 5° grid: up to 5°
        setSnapAngle(deg(2));
        expect(snapAngle(deg(2.6))).toBeCloseTo(deg(2), 9); // 2° grid: down to 2°
        expect(snapAngle(deg(7))).toBeCloseTo(deg(8), 9);
    });

    test("the length increment decides what a chord snaps to", () => {
        expect(snapLength(3.3, true).meters).toBeCloseTo(3, 12); // default 1 m grid
        setSnapLength(0.5);
        expect(snapLength(3.3, true).meters).toBeCloseTo(3.5, 12); // half-metre grid
        expect(snapLength(3.2, true).meters).toBeCloseTo(3, 12);
    });

    test("the 1 m chord floor is a separate quantity — a fine grid doesn't lower it", () => {
        setSnapLength(0.1);
        expect(snapLength(0.24, true).meters).toBe(1); // quantizes to 0.2, still floored to 1
    });

    test("the Ctrl bypass stays continuous whatever the increment is", () => {
        setSnapLength(5);
        expect(snapLength(3.3, false).meters).toBeCloseTo(3.3, 12);
    });
});
