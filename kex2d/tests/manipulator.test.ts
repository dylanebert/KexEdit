import { describe, expect, test } from "bun:test";
import {
    angleControl,
    angleToPoint,
    type ChainNode,
    lengthControl,
    lengthToPoint,
    polarDelta,
    polarFrame,
    screenToAngle,
    screenToLength,
} from "../src/manipulator";
import { ANGLE_STEP_DEFAULT as ANGLE_STEP } from "../src/settings";

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

// the per-node polar delta (the multiselect group move): ONE shared Δlength/Δangle applies to every
// selected node in its OWN polar frame around its previous node (Blender Individual Origins), walked
// ascending so a consecutive selected run carries rigidly (the chord VECTOR transform reads START
// positions, the ANCHOR reads the running prev — the live-frame rebuild). section-local coords.
describe("polarDelta — the group move", () => {
    // a straight chain along +x, chord 10 m each: node0 the entry anchor, 1..3 shape nodes.
    const chain: ChainNode[] = [
        { order: 0, x: 0, y: 0 },
        { order: 1, x: 10, y: 0 },
        { order: 2, x: 20, y: 0 },
        { order: 3, x: 30, y: 0 },
    ];

    test("length: the same Δ grows each selected chord; a consecutive run carries rigidly", () => {
        const out = polarDelta(chain, new Set([1, 2, 3]), "length", 5, 1);
        // ascending + live anchor: node1 +5 along its chord → 15; node2 anchors on the MOVED node1
        // (30), node3 on the moved node2 (45) — each chord is start(10) + 5, the run scaled out.
        expect(out.get(1)).toEqual({ x: 15, y: 0 });
        expect(out.get(2)).toEqual({ x: 30, y: 0 });
        expect(out.get(3)).toEqual({ x: 45, y: 0 });
    });

    test("length: a consecutive pair anchors the later on the MOVED earlier (live rebuild)", () => {
        // if node2 anchored on node1's START (10,0) it would land at 25; the live rebuild anchors it
        // on node1's NEW position (15,0), so it lands at 30 — the geometry proves the ascending walk.
        const out = polarDelta(chain, new Set([1, 2]), "length", 5, 1);
        expect(out.get(1)).toEqual({ x: 15, y: 0 });
        expect(out.get(2)).toEqual({ x: 30, y: 0 });
        expect(out.has(3)).toBe(false); // unselected — not returned
    });

    test("single-node degenerates to today's polar move (its own chord, its own frame)", () => {
        // one selected node with an UNSELECTED prev: it just slides Δ along its own start chord —
        // exactly what a single-node nudge/drag does. neighbours untouched.
        const out = polarDelta(chain, new Set([2]), "length", 5, 1);
        expect(out.get(2)).toEqual({ x: 25, y: 0 }); // node1 (10,0) + 15 along +x
        expect(out.has(1)).toBe(false);
        expect(out.has(3)).toBe(false);
    });

    test("angle: the same Δθ rotates each chord CCW in its own frame (whole run rotates)", () => {
        const out = polarDelta(chain, new Set([1, 2, 3]), "angle", Math.PI / 2, 1);
        // +90° CCW: the horizontal run becomes vertical, each node anchored on the rotated prev.
        expect(out.get(1)?.x).toBeCloseTo(0, 9);
        expect(out.get(1)?.y).toBeCloseTo(10, 9);
        expect(out.get(2)?.x).toBeCloseTo(0, 9);
        expect(out.get(2)?.y).toBeCloseTo(20, 9);
        expect(out.get(3)?.x).toBeCloseTo(0, 9);
        expect(out.get(3)?.y).toBeCloseTo(30, 9);
    });

    test("angle: a gapped set rotates each in its OWN frame (Individual Origins, not a group pivot)", () => {
        // select {1, 3} — node2 unselected. node1 rotates about node0, node3 about its own
        // (unchanged) node2. a group pivot would rotate node3 about node0; Individual Origins does not.
        const out = polarDelta(chain, new Set([1, 3]), "angle", Math.PI / 2, 1);
        expect(out.get(1)?.x).toBeCloseTo(0, 9);
        expect(out.get(1)?.y).toBeCloseTo(10, 9);
        expect(out.get(3)?.x).toBeCloseTo(20, 9); // anchored on node2 (20,0), chord rot 90 → (0,10)
        expect(out.get(3)?.y).toBeCloseTo(10, 9);
        expect(out.has(2)).toBe(false); // unselected node2 stays at (20,0)
    });

    test("length: a shrink past the floor clamps each chord at minChord, never collapsing", () => {
        // chord 10 with Δ −20 would be −10; the floor holds it at 1 m along the chord direction.
        const out = polarDelta(chain, new Set([1]), "length", -20, 1);
        expect(out.get(1)).toEqual({ x: 1, y: 0 }); // node0 + 1 m along +x
    });

    test("a quantized delta yields quantized geometry (the snap acts on the delta)", () => {
        // the caller snaps the delta (1 m / 5°) before applying; a whole-metre delta grows each chord
        // by exactly a metre, a 5° delta rotates each by exactly 5° — grid in, grid out.
        const byM = polarDelta(chain, new Set([1]), "length", 1, 1);
        expect(byM.get(1)).toEqual({ x: 11, y: 0 }); // 10 + 1
        const byDeg = polarDelta(chain, new Set([1]), "angle", ANGLE_STEP, 1);
        expect(byDeg.get(1)?.x).toBeCloseTo(10 * Math.cos(ANGLE_STEP), 9);
        expect(byDeg.get(1)?.y).toBeCloseTo(10 * Math.sin(ANGLE_STEP), 9);
        // the length-delta snap the caller applies is Math.round(raw / 1) * 1.
        expect(Math.round(2.4)).toBe(2);
        expect(Math.round(2.6)).toBe(3);
    });

    test("the result is independent of the set's iteration order (deterministic, sorted walk)", () => {
        const a = polarDelta(chain, new Set([3, 1, 2]), "length", 5, 1);
        const b = polarDelta(chain, new Set([1, 2, 3]), "length", 5, 1);
        for (const k of [1, 2, 3]) expect(a.get(k)).toEqual(b.get(k));
    });
});
