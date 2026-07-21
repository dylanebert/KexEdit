import { expect, test } from "bun:test";
import { formatDeg, normDeg } from "../src/controls";
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
