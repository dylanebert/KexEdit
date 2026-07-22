import { describe, expect, test } from "bun:test";
import {
    angleControl,
    angleToPoint,
    lengthControl,
    lengthToPoint,
    polarFrame,
    screenToAngle,
    screenToLength,
} from "../src/manipulator";
import { ANGLE_STEP } from "../src/magnet";

// the manipulator works entirely in screen px (the caller projects world→screen at the boundary),
// so a test builds the previous + selected node's screen points directly. the previous node is the
// polar origin; angles are screen-radians, lengths screen px converted through `pxPerMeter`.

const PREV = { x: 100, y: 100 };
const SEL = { x: 300, y: 175 }; // 200 px right, 75 px down → radius 213.6 px, angle atan2(75,200)
const PX_PER_METER = 50;

describe("polar frame", () => {
    test("captures the chord direction and radius", () => {
        const f = polarFrame(PREV, SEL, PX_PER_METER, 0.2);
        expect(f.degenerate).toBe(false);
        expect(f.radius).toBeCloseTo(Math.hypot(200, 75), 9);
        expect(Math.hypot(f.ux, f.uy)).toBeCloseTo(1, 12); // unit screen direction
        expect(f.ux).toBeCloseTo(200 / f.radius, 12);
        expect(f.tangent).toBe(0.2); // world radians, carried through
    });

    test("a coincident previous/selected node is degenerate (guarded)", () => {
        const f = polarFrame(PREV, PREV, PX_PER_METER, 0);
        expect(f.degenerate).toBe(true);
        expect(f.radius).toBe(0);
        expect(f.ux).toBe(1); // a defined fallback direction, never NaN
        expect(f.uy).toBe(0);
    });
});

describe("length inverse round-trips", () => {
    const f = polarFrame(PREV, SEL, PX_PER_METER, 0);
    for (const m of [0.5, 3, 4.27, 12]) {
        test(`length ${m} m → point on the ray → back to ${m} m`, () => {
            const p = lengthToPoint(f, m);
            // the point sits on the chord ray.
            const perp = (p.x - PREV.x) * f.uy - (p.y - PREV.y) * f.ux;
            expect(perp).toBeCloseTo(0, 9);
            expect(screenToLength(f, p.x, p.y)).toBeCloseTo(m, 9);
        });
    }

    test("a point off the ray reads its projected length (signed)", () => {
        // a point at the 4 m station but pushed perpendicular still reads 4 m (the projection).
        const p = lengthToPoint(f, 4);
        const off = { x: p.x - f.uy * 30, y: p.y + f.ux * 30 };
        expect(screenToLength(f, off.x, off.y)).toBeCloseTo(4, 9);
    });

    test("a non-positive scale reads 0 (degenerate guard, no divide-by-zero)", () => {
        const dgn = polarFrame(PREV, SEL, 0, 0);
        expect(screenToLength(dgn, SEL.x, SEL.y)).toBe(0);
    });
});

describe("angle inverse round-trips", () => {
    const f = polarFrame(PREV, SEL, PX_PER_METER, 0);
    for (const a of [-2.5, -0.4, 0, 0.4, 1.2, 3.0]) {
        test(`world angle ${a} rad → point on the arc → back to ${a} rad`, () => {
            const p = angleToPoint(f, a);
            // the point sits on the reference-radius arc.
            expect(Math.hypot(p.x - PREV.x, p.y - PREV.y)).toBeCloseTo(f.radius, 9);
            expect(screenToAngle(f, p.x, p.y)).toBeCloseTo(a, 9);
        });
    }

    test("a point on the previous node reads angle 0 (degenerate guard, no NaN)", () => {
        expect(screenToAngle(f, PREV.x, PREV.y)).toBe(0);
    });
});

describe("length control (whole-metre grid, min 1)", () => {
    const f = polarFrame(PREV, SEL, PX_PER_METER, 0);
    test("snap on: quantizes the drag to the nearest whole metre", () => {
        const raw = lengthToPoint(f, 3.1);
        const res = lengthControl(f, raw.x, raw.y, true);
        expect(res.snapped).toBe(true);
        expect(res.meters).toBeCloseTo(3, 9);
    });

    test("snap off (Ctrl bypass): continuous, passes the raw length through", () => {
        const raw = lengthToPoint(f, 3.1);
        const res = lengthControl(f, raw.x, raw.y, false);
        expect(res.snapped).toBe(false);
        expect(res.meters).toBeCloseTo(3.1, 9);
    });

    test("floors at 1 m either way (a sub-metre drag can't collapse the chord)", () => {
        const raw = lengthToPoint(f, 0.3);
        expect(lengthControl(f, raw.x, raw.y, true).meters).toBeCloseTo(1, 9);
        expect(lengthControl(f, raw.x, raw.y, false).meters).toBeCloseTo(1, 9);
    });
});

describe("angle control (5° grid, uniform tip + interior)", () => {
    test("a growth tip snaps the exit incline to the 5° grid", () => {
        // tangent 0 → incline = 2·chord; a chord near 5° gives incline near 10°. snap on quantizes
        // the INCLINE to the grid and maps back to the chord (incline/2 at tangent 0).
        const f = polarFrame(PREV, SEL, PX_PER_METER, 0);
        const raw = angleToPoint(f, ANGLE_STEP + 0.002); // exit incline just past 2·5° = 10°
        const res = angleControl(f, raw.x, raw.y, true);
        expect(res.snapped).toBe(true);
        expect(res.incline).toBeCloseTo(2 * ANGLE_STEP, 6); // the incline lands on 10°
        expect(res.angle).toBeCloseTo(ANGLE_STEP, 6); // chord = incline/2 at tangent 0
    });

    test("an INTERIOR node snaps the chord angle to the 5° grid too (no free-rotate asymmetry)", () => {
        // the round-6 change: an interior node (tangent null) also snaps — its chord angle to the
        // grid — rather than rotating free. incline stays null (no incline to display).
        const f = polarFrame(PREV, SEL, PX_PER_METER, null);
        const raw = angleToPoint(f, 2 * ANGLE_STEP + 0.002); // chord just past 10°
        const res = angleControl(f, raw.x, raw.y, true);
        expect(res.incline).toBeNull();
        expect(res.snapped).toBe(true);
        expect(res.angle).toBeCloseTo(2 * ANGLE_STEP, 6); // the chord snaps to 10°
    });

    test("snap off (Ctrl bypass) is continuous — tip incline and interior chord alike", () => {
        const f = polarFrame(PREV, SEL, PX_PER_METER, 0);
        const chord = 0.4;
        const raw = angleToPoint(f, chord);
        const res = angleControl(f, raw.x, raw.y, false);
        expect(res.snapped).toBe(false);
        expect(res.incline).toBeCloseTo(2 * chord, 9); // incline = 2·chord − tangent, tangent 0

        const fi = polarFrame(PREV, SEL, PX_PER_METER, null);
        const rawi = angleToPoint(fi, chord);
        const resi = angleControl(fi, rawi.x, rawi.y, false);
        expect(resi.snapped).toBe(false);
        expect(resi.incline).toBeNull();
        expect(resi.angle).toBeCloseTo(chord, 9);
    });

    test("emits WORLD-space incline (a chord rising on screen → positive world incline)", () => {
        // screen y points down; a chord going UP on screen (toward smaller y) is a POSITIVE world
        // incline — the same convention `nodeMetrics` (world samples) reads, so a readout consumer
        // never negates. build a raw point up-and-right of the previous node, tangent 0 (a
        // horizontal exit). the screen atan2 here is negative; the world output must be positive.
        const f = polarFrame(PREV, SEL, PX_PER_METER, 0); // tangent 0 (world)
        const rising = { x: PREV.x + 100, y: PREV.y - 50 }; // up-right on screen
        const res = angleControl(f, rising.x, rising.y, false);
        expect(res.angle).toBeGreaterThan(0); // world chord angle
        expect(res.incline).toBeGreaterThan(0); // world exit incline (2·chord − tangent)
    });
});
