import { describe, expect, test } from "bun:test";
import {
    angleControl,
    angleToPoint,
    chordRay,
    lengthControl,
    lengthToPoint,
    polarFrame,
    screenToAngle,
    screenToLength,
    tangentArc,
} from "../src/manipulator";
import { ANGLE_STEP } from "../src/magnet";
import { SNAP_PX } from "../src/timeline";

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

describe("control loci", () => {
    test("the chord ray runs from the previous node along the chord", () => {
        const f = polarFrame(PREV, SEL, PX_PER_METER, 0);
        const ray = chordRay(f);
        expect(ray.x).toBe(PREV.x);
        expect(ray.y).toBe(PREV.y);
        expect(ray.dx).toBeCloseTo(f.ux, 12);
        expect(ray.dy).toBeCloseTo(f.uy, 12);
        // the selected node lies on the ray (its perpendicular distance is ~0).
        const perp = (SEL.x - ray.x) * ray.dy - (SEL.y - ray.y) * ray.dx;
        expect(perp).toBeCloseTo(0, 9);
    });

    test("the tangential arc is centered on the previous node through the selected node", () => {
        const f = polarFrame(PREV, SEL, PX_PER_METER, 0);
        const arc = tangentArc(f);
        expect(arc.cx).toBe(PREV.x);
        expect(arc.cy).toBe(PREV.y);
        // the selected node lies on the arc (its distance from the center is the radius).
        expect(Math.hypot(SEL.x - arc.cx, SEL.y - arc.cy)).toBeCloseTo(arc.r, 9);
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

describe("length control (whole-metre snap)", () => {
    const f = polarFrame(PREV, SEL, PX_PER_METER, 0);
    test("snaps a near-integer drag to the whole metre", () => {
        // a point 3.1 m out along the chord (5 px past 3 m at 50 px/m) snaps to 3 m.
        const raw = lengthToPoint(f, 3.1);
        const res = lengthControl(f, raw.x, raw.y, true);
        expect(res.snapped).toBe(true);
        expect(res.meters).toBeCloseTo(3, 9);
    });

    test("snap off passes the raw length through", () => {
        const raw = lengthToPoint(f, 3.1);
        const res = lengthControl(f, raw.x, raw.y, false);
        expect(res.snapped).toBe(false);
        expect(res.meters).toBeCloseTo(3.1, 9);
    });
});

describe("angle control (incline at the tip, free interior)", () => {
    test("a growth tip snaps the exit incline to the 15° raster", () => {
        // tangent 0 → incline = 2·chord; a chord near 7.5° at a radius that admits the pull snaps
        // the incline to 15°. build the raw point on the arc at that chord angle.
        const f = polarFrame(PREV, SEL, PX_PER_METER, 0);
        const raw = angleToPoint(f, ANGLE_STEP / 2 + 0.002);
        const res = angleControl(f, raw.x, raw.y, true);
        expect(res.snapped).toBe(true);
        expect(res.incline).toBeCloseTo(ANGLE_STEP, 6); // the exit incline lands on 15°
        expect(res.angle).toBeCloseTo(ANGLE_STEP / 2, 6); // chord = incline/2 at tangent 0
    });

    test("an interior node (tangent null) rotates free — no incline, never snaps", () => {
        // the same off-raster point that snapped at the tip is left free at an interior node: the
        // chord angle passes through, incline is null, snapped false, even with snap on.
        const f = polarFrame(PREV, SEL, PX_PER_METER, null);
        const raw = angleToPoint(f, ANGLE_STEP / 2 + 0.002);
        const res = angleControl(f, raw.x, raw.y, true);
        expect(res.incline).toBeNull();
        expect(res.snapped).toBe(false);
        expect(res.angle).toBeCloseTo(ANGLE_STEP / 2 + 0.002, 9);
    });

    test("snap off at a tip carries the raw incline, unsnapped", () => {
        const f = polarFrame(PREV, SEL, PX_PER_METER, 0);
        const chord = 0.4;
        const raw = angleToPoint(f, chord);
        const res = angleControl(f, raw.x, raw.y, false);
        expect(res.snapped).toBe(false);
        expect(res.incline).toBeCloseTo(2 * chord, 9); // incline = 2·chord − tangent, tangent 0
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

// SNAP_PX is a shared design constant — reference it so a change to the pull width is a deliberate,
// visible edit, not a silent drift (mirrors the magnet suite).
test("the pull width is the shared SNAP_PX constant", () => {
    expect(SNAP_PX).toBe(8);
});
