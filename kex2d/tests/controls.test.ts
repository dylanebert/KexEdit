import { expect, test } from "bun:test";
import {
    armDrag,
    beyondDeadZone,
    DRAG_PX,
    formatDeg,
    latchAngle,
    LATCH_PX,
    nodeMetrics,
    normDeg,
} from "../src/controls";
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

// the click-vs-drag dead-zone: a node grab stays a select until the pointer travels DRAG_PX from
// the grab point. below the threshold no drag runs — no node move, no magnet, no guide (the fix for
// a refocus click flashing a snap guide on a plain click after a window blur).

test("a sub-threshold displacement stays inside the dead-zone (a click, not a drag)", () => {
    expect(beyondDeadZone(0, 0)).toBe(false);
    expect(beyondDeadZone(DRAG_PX - 1, 0)).toBe(false);
    expect(beyondDeadZone(0, DRAG_PX - 1)).toBe(false);
});

test("reaching DRAG_PX clears the dead-zone — the grab becomes a drag", () => {
    expect(beyondDeadZone(DRAG_PX, 0)).toBe(true);
    expect(beyondDeadZone(0, DRAG_PX)).toBe(true);
    // Euclidean boundary: a diagonal reaches the radius before either axis alone (3²+3²=18 ≥ 4²)
    expect(beyondDeadZone(3, 3)).toBe(true);
});

test("the dead-zone latches — once armed it stays armed even back inside", () => {
    // a fresh sub-threshold move doesn't arm
    expect(armDrag(false, 1, 0)).toBe(false);
    // crossing the threshold arms it
    expect(armDrag(false, DRAG_PX, 0)).toBe(true);
    // sticky: an armed drag stays armed at zero displacement (no disarm on a cross-back)
    expect(armDrag(true, 0, 0)).toBe(true);
});

// the tangent-handle angle snap (a polar-tracking landmark): the direction a handle drag grabbed
// at persists for the whole gesture, so pulling the tip out lengthens the tangent without bumping
// its angle — and a deviated tip re-snaps whenever it returns within LATCH_PX (perpendicular
// screen px) of the start ray (stateless, the magnet-target model — not the one-way armDrag
// latch). the ray argument is a unit direction (zero = no landmark); tip is screen px from the node.

test("an on-ray tip passes its length through — angle unchanged", () => {
    // ray along +x; a tip straight out the ray reports its length, no perpendicular deflection.
    expect(latchAngle(20, 0, 1, 0)).toEqual({ x: 20, y: 0, snapped: true });
    // pulling further out only grows the length — still exactly on the ray.
    expect(latchAngle(35, 0, 1, 0)).toEqual({ x: 35, y: 0, snapped: true });
});

test("a within-corridor deviation snaps — the angle locks, only length survives", () => {
    // tip 5 px off the ray (perp = 5 < LATCH_PX): the angle snaps back to the ray, the projected
    // length (the along component) is what's kept.
    expect(latchAngle(20, 5, 1, 0)).toEqual({ x: 20, y: 0, snapped: true });
});

test("the corridor half-width is LATCH_PX — at the edge it snaps, just past it is free", () => {
    // exactly LATCH_PX perpendicular still snaps (≤, the boundary is inclusive)…
    expect(latchAngle(20, LATCH_PX, 1, 0)).toEqual({ x: 20, y: 0, snapped: true });
    // …a hair past it is free and the raw tip passes through (free rotation).
    const r = latchAngle(20, LATCH_PX + 0.001, 1, 0);
    expect(r.snapped).toBe(false);
    expect(r.x).toBeCloseTo(20, 10);
    expect(r.y).toBeCloseTo(LATCH_PX + 0.001, 10);
});

test("the corridor is measured perpendicular in screen px, independent of ray angle", () => {
    // ray at (0.6, 0.8): a tip 10 along the ray plus 5 px perpendicular projects back to 10·ray.
    const tipX = 6 - 0.8 * 5; // (6,8) is 10·ray; (−0.8, 0.6) is the unit perpendicular
    const tipY = 8 + 0.6 * 5;
    const r = latchAngle(tipX, tipY, 0.6, 0.8);
    expect(r.snapped).toBe(true);
    expect(r.x).toBeCloseTo(6, 10);
    expect(r.y).toBeCloseTo(8, 10);
});

test("the landmark persists — a tip that deviated re-snaps on returning to the corridor", () => {
    // well outside the corridor: free rotation, raw tip through.
    expect(latchAngle(20, 15, 1, 0)).toEqual({ x: 20, y: 15, snapped: false });
    // the same gesture drifting back within LATCH_PX: the start angle re-engages as a landmark.
    expect(latchAngle(20, 5, 1, 0)).toEqual({ x: 20, y: 0, snapped: true });
});

test("a degenerate (zero) ray never snaps — no landmark to favor", () => {
    expect(latchAngle(20, 0, 0, 0)).toEqual({ x: 20, y: 0, snapped: false });
});
