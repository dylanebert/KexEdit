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

describe("exit-incline raster (15°)", () => {
    test("15° is the quantum", () => {
        expect(ANGLE_STEP).toBeCloseTo((15 * Math.PI) / 180, 12);
    });

    test("snaps the tip's exit incline to the nearest 15° multiple", () => {
        // the previous node exits horizontally (tangent 0), so the tip incline is 2·chord. a
        // chord near 7.5° gives incline near 15° — snap the incline to exactly 15°, i.e. the
        // chord to 7.5°. drag ~2.5px off the target ray at r=250 (in range); the radius (1.25 m
        // at 200 px/m) sits far from any integer meter, so only the incline fires.
        const raw = polar(250, ANGLE_STEP / 2 + 0.01);
        const res = resolveSnap(input({ ...raw, prev: PREV, tangent: 0, pxPerMeter: 200 }));
        expect(res.guides).toHaveLength(1);
        expect(res.guides[0].kind).toBe("angle");
        expect(res.guides[0].value).toBeCloseTo(ANGLE_STEP, 9); // the INCLINE, not the chord
        expect(2 * angleOf(res)).toBeCloseTo(ANGLE_STEP, 5); // incline = 2·chord (tangent 0)
    });

    test("no incline family for an interior drag (tangent null)", () => {
        // an interior node's heading is frozen — no incline to snap. the same off-raster point
        // that snapped above fires nothing (only alignment + length families run there).
        const raw = polar(250, ANGLE_STEP / 2 + 0.01);
        const res = resolveSnap(input({ ...raw, prev: PREV, tangent: null, pxPerMeter: 200 }));
        expect(res.guides.some((g) => g.kind === "angle")).toBe(false);
    });
});

describe("chord-length raster (1 m)", () => {
    test("1 m is the quantum", () => {
        expect(LENGTH_STEP).toBe(1);
    });

    test("snaps the chord length to the nearest integer meter", () => {
        // 3.1 m at 50 px/m = 155 px (floor 3 m = 150 px is 5px away, in range). no tangent → no
        // incline family, so only the length fires. length is universal (tip + interior drags).
        const raw = polar(3.1 * 50, ANGLE_STEP / 2);
        const res = resolveSnap(input({ ...raw, prev: PREV, pxPerMeter: 50 }));
        expect(res.guides).toHaveLength(1);
        expect(res.guides[0].kind).toBe("length");
        expect(res.guides[0].value).toBeCloseTo(150, 9); // 3 m × 50 px/m
        expect(radiusOf(res)).toBeCloseTo(150, 6);
    });

    test("pxPerMeter 0 disables the length family (degenerate scale)", () => {
        // the resolver gates the length family on pxPerMeter > 0, so a zero scale never divides
        // by it: the same 3 m point that snapped above fires no length target and stays put.
        const raw = polar(3.1 * 50, ANGLE_STEP / 2);
        const res = resolveSnap(input({ ...raw, prev: PREV, pxPerMeter: 0 }));
        expect(res.guides.some((g) => g.kind === "length")).toBe(false);
        expect(res.px).toBeCloseTo(raw.px, 6); // the point is untouched (no length pull)
        expect(res.py).toBeCloseTo(raw.py, 6);
    });
});

describe("incline landmarks", () => {
    test("continuation: the tip keeps the previous exit incline, beating the raster", () => {
        // tangent 0.3 rad — not a 15° multiple. continuation means the tip's exit incline equals
        // the previous incline (0.3): incline = tangent → chord = (0.3 + 0.3)/2 = 0.3. drag near
        // that chord. the nearest raster (15° = 0.262) is in range but farther, so continuation
        // wins and the guide reads the incline 0.3, not 15°.
        const raw = polar(150, 0.3 + 0.01);
        const res = resolveSnap(input({ ...raw, prev: PREV, tangent: 0.3, pxPerMeter: 70 }));
        expect(res.guides).toHaveLength(1);
        expect(res.guides[0].kind).toBe("angle");
        expect(res.guides[0].value).toBeCloseTo(0.3, 9); // the INCLINE landmark
        // chord snapped to 0.3 → incline 2·chord − tangent = 0.3
        expect(2 * angleOf(res) - 0.3).toBeCloseTo(0.3, 5);
    });
});

describe("polar grid — incline and length co-fire", () => {
    test("snaps both the exit incline and the radius (their intersection)", () => {
        // tangent 0 → incline = 2·chord; a chord near 7.5° gives incline near the 15° raster.
        // r = 200 px = exactly 1 m at 200 px/m (length latches, 0px). orthogonal families (the
        // incline ray vs the radial length locus), so both fire.
        const raw = polar(200, ANGLE_STEP / 2 + 0.0075);
        const res = resolveSnap(input({ ...raw, prev: PREV, tangent: 0, pxPerMeter: 200 }));
        expect(res.guides.map((g) => g.kind).sort()).toEqual(["angle", "length"]);
        expect(2 * angleOf(res)).toBeCloseTo(ANGLE_STEP, 4); // incline snapped to 15°
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
