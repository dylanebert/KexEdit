import { describe, expect, test } from "bun:test";
import {
    ANGLE_STEP,
    chordForIncline,
    inclineOf,
    LENGTH_STEP,
    rasterIncline,
    snapIncline,
    snapLength,
} from "../src/magnet";
import { SNAP_PX } from "../src/timeline";

// the two polar families are per-axis 1D resolvers now: each gesture is already 1-DOF, so a test
// feeds a scalar (a chord length in metres, a chord angle in screen radians) and reads the snapped
// scalar back. no camera, no pool. the incline resolver additionally carries the exit-incline
// convention (`incline = 2·chord − tangent`).

describe("length resolver (whole-metre)", () => {
    test("1 m is the quantum", () => {
        expect(LENGTH_STEP).toBe(1);
    });

    test("snaps a raw chord length to the nearest whole metre within the pull", () => {
        // 3.1 m at 50 px/m sits 5 px past the 3 m raster (in range) → snaps to 3 m.
        const res = snapLength(3.1, 50);
        expect(res.snapped).toBe(true);
        expect(res.meters).toBeCloseTo(3, 12);
    });

    test("rounds to the NEARER metre, not down", () => {
        // 3.9 m at 50 px/m is 5 px from the 4 m raster (in range) → rounds up, not down to 3.
        const res = snapLength(3.9, 50);
        expect(res.snapped).toBe(true);
        expect(res.meters).toBeCloseTo(4, 12);
    });

    test("the pull is SNAP_PX wide (radial px from the nearest raster)", () => {
        // at 50 px/m the metre gap reads as gap·50 px. 1 px inside SNAP_PX latches; 1 px past does
        // not (the exact boundary is a derived design constant, not tuned — tested off-boundary to
        // stay clear of float equality).
        expect(snapLength(3 + (SNAP_PX - 1) / 50, 50).snapped).toBe(true);
        expect(snapLength(3 + (SNAP_PX + 1) / 50, 50).snapped).toBe(false);
    });

    test("never snaps to 0 m (the previous node itself)", () => {
        // a sub-half-metre drag rounds toward 0; 0 m is the coincident previous node, not a target.
        const res = snapLength(0.2, 50);
        expect(res.snapped).toBe(false);
        expect(res.meters).toBeCloseTo(0.2, 12);
    });

    test("a non-positive scale disables the family (degenerate)", () => {
        const res = snapLength(3.1, 0);
        expect(res.snapped).toBe(false);
        expect(res.meters).toBeCloseTo(3.1, 12);
    });
});

describe("incline resolver (exit incline at the tip)", () => {
    test("15° is the quantum", () => {
        expect(ANGLE_STEP).toBeCloseTo((15 * Math.PI) / 180, 12);
    });

    test("the exit-incline convention round-trips", () => {
        // incline = 2·chord − tangent; the chord that yields it is (incline + tangent)/2.
        const tangent = 0.2;
        const chord = 0.35;
        const incline = inclineOf(chord, tangent);
        expect(chordForIncline(incline, tangent)).toBeCloseTo(chord, 12);
    });

    test("snaps the tip's exit incline to the nearest 15° raster", () => {
        // tangent 0 → incline = 2·chord; a chord near 7.5° gives incline near 15°. r = 200 px sets
        // the pull; a near-on-raster chord latches, and the returned incline is the raster (15°),
        // the chord half of it (7.5°).
        const tangent = 0;
        const chord = ANGLE_STEP / 2 + 0.002; // exit incline just past 15°
        const res = snapIncline(chord, tangent, 200);
        expect(res.snapped).toBe(true);
        expect(res.incline).toBeCloseTo(ANGLE_STEP, 9); // the INCLINE, not the chord
        expect(res.angle).toBeCloseTo(ANGLE_STEP / 2, 9); // chord = incline/2 at tangent 0
        expect(rasterIncline(res.incline)).toBeCloseTo(res.incline, 9); // lands on the raster
    });

    test("snaps to the NEARER raster (up into the upper half of an interval, not down)", () => {
        // a chord just under ANGLE_STEP → exit incline just under 2·ANGLE_STEP (30°). the nearest
        // raster is 30°, not the 15° a floor would give; the drag sits inside the pull of 30°.
        const res = snapIncline(ANGLE_STEP - 0.01, 0, 200);
        expect(res.snapped).toBe(true);
        expect(res.incline).toBeCloseTo(2 * ANGLE_STEP, 9); // 30°, the nearer raster
    });

    test("continuation landmark beats the raster (keeps the previous exit incline)", () => {
        // tangent 0.3 (not a 15° multiple). incline = tangent → chord = 0.3 continues the previous
        // exit incline; the nearest raster (15° = 0.262) is farther, so continuation wins.
        const tangent = 0.3;
        const res = snapIncline(0.3 + 0.001, tangent, 200);
        expect(res.snapped).toBe(true);
        expect(res.incline).toBeCloseTo(0.3, 9);
        expect(res.angle).toBeCloseTo(0.3, 9); // chord = (0.3 + 0.3)/2
    });

    test("the angular pull is derived (2·SNAP_PX ÷ radius), not a degree count", () => {
        // the window on the incline is 2·SNAP_PX/radius; the incline is 2·chord, so a chord offset
        // maps to twice that on the incline. an incline offset just inside the window snaps, just
        // outside does not — pinning the window at HALF the radius (2·SNAP_PX/(radius/2) = 4·SNAP_PX/
        // radius) is a wider pull, confirming the derivation scales with radius.
        const tangent = 0;
        const rasterChord = ANGLE_STEP / 2; // yields incline = 15°
        const windowAt = (radius: number): number => (2 * SNAP_PX) / radius;
        // radius 200: incline offset (window − 5%) snaps, (window + 5%) does not.
        const w200 = windowAt(200);
        expect(snapIncline(rasterChord + (w200 * 0.95) / 2, tangent, 200).snapped).toBe(true);
        expect(snapIncline(rasterChord + (w200 * 1.05) / 2, tangent, 200).snapped).toBe(false);
        // half the radius → double the window: the (window + 5%) offset that FAILED at r=200 now
        // snaps at r=100, so the pull is radius-derived, not a fixed angle.
        expect(snapIncline(rasterChord + (w200 * 1.05) / 2, tangent, 100).snapped).toBe(true);
    });

    test("a non-positive radius disables the family", () => {
        const res = snapIncline(ANGLE_STEP / 2, 0, 0);
        expect(res.snapped).toBe(false);
    });
});
