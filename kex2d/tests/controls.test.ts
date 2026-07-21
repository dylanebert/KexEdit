import { expect, test } from "bun:test";
import { formatDeg, nodeMetrics, normDeg } from "../src/controls";
import { ANGLE_STEP } from "../src/magnet";

// the snap readout: a 15°-raster incline cancels to a clean integer through the radian→degree
// round-trip, while a continuation landmark is a raw atan2 over baked samples — a fractional
// incline. one formatter serves both: integer within float noise, else one decimal.

test("a raster-multiple incline reads as a clean integer despite the radian→degree round-trip", () => {
    // the magnet's angle guide carries the incline in radians (k·ANGLE_STEP); the caller converts
    // it the way applyGuides does (screen→world y-flip, rad→deg).
    for (let k = -6; k <= 6; k++) {
        const incline = k * ANGLE_STEP;
        const label = formatDeg((-incline * 180) / Math.PI);
        expect(label).toBe(`${-k * 15}°`);
    }
});

test("a continuation landmark's raw incline keeps one decimal", () => {
    // a real atan2-over-samples value that must not spill its full f64 expansion into the readout.
    expect(formatDeg(-22.126334809373247)).toBe("-22.1°");
    expect(formatDeg(37.049999999999997)).toBe("37.0°");
});

test("normDeg wraps into (−180, 180] — 180 stays 180, matching the doc", () => {
    expect(normDeg(180)).toBe(180);
    expect(normDeg(-180)).toBe(180);
    expect(normDeg(540)).toBe(180);
    expect(normDeg(0)).toBe(0);
    expect(normDeg(-90)).toBe(-90);
    expect(normDeg(270)).toBe(-90);
});

// the resting readout metrics: a growth tip reports its exit-tangent incline + the chord to the
// previous node; an interior node has no incline to snap, so only the chord. one formatter feeds
// both readout sources (`formatDeg` for degrees, integer metres for length).

test("a growth tip reports its exit incline and the chord to the previous node", () => {
    // node 3 m right + 3 m up from the previous → chord = hypot(3,3) ≈ 4.24 → "4 m". the flanking
    // samples rise at 45° in world → +45° (a clean integer through formatDeg).
    const m = nodeMetrics({ x: 0, y: 0 }, { x: 3, y: 3 }, [
        { x: 2, y: 2 },
        { x: 4, y: 4 },
    ]);
    expect(m.angleLabel).toBe("45°");
    expect(m.lengthLabel).toBe("4 m");
});

test("an interior node has no exit incline — chord length only", () => {
    const m = nodeMetrics({ x: 0, y: 0 }, { x: 5, y: 0 }, null);
    expect(m.angleLabel).toBeNull();
    expect(m.lengthLabel).toBe("5 m");
});

test("the tip incline routes through formatDeg (a fractional flank keeps one decimal)", () => {
    // flank rising at atan2(1, 2) ≈ 26.565° → formatDeg's one-decimal path, "26.6°".
    const exit: [{ x: number; y: number }, { x: number; y: number }] = [
        { x: 0, y: 0 },
        { x: 2, y: 1 },
    ];
    const deg = (Math.atan2(1, 2) * 180) / Math.PI;
    expect(nodeMetrics({ x: 0, y: 0 }, { x: 2, y: 1 }, exit).angleLabel).toBe(formatDeg(deg));
    expect(nodeMetrics({ x: 0, y: 0 }, { x: 2, y: 1 }, exit).angleLabel).toBe("26.6°");
});
