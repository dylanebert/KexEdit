import { describe, expect, test } from "bun:test";
import { RADIAL_R, RadialSlot, ringBase, ringSlot } from "../src/radial";

// the shared node-action ring: the two manipulator knobs slot into it (feel round 7 stripped it to
// just these two). the load-bearing invariants: the base angle is the node's heading mapped
// world→screen (the y-flip that the chord-relative placement got wrong), the length knob sits at the
// front (along the heading), and the angle knob one slot (+60°) off it.

// a screen view scale: sx > 0, sy < 0 (world Y-up → screen Y-down).
const SX = 40;
const SY = -40;

describe("ringBase (heading → screen angle)", () => {
    test("a world heading along +x maps to screen 0 (points right)", () => {
        expect(ringBase(0, SX, SY)).toBeCloseTo(0, 9);
    });

    test("a world-up heading maps to screen-up (the view y-flip)", () => {
        // heading +π/2 is world UP; screen y points down, so screen up is −π/2. this is the flip the
        // add button applies and the chord-relative knob placement did not share.
        expect(ringBase(Math.PI / 2, SX, SY)).toBeCloseTo(-Math.PI / 2, 9);
    });
});

describe("ring slots (the three buttons)", () => {
    test("a slot sits RADIAL_R px from the node at base + slot·60°", () => {
        const base = 0.3;
        const ext = ringSlot(base, RadialSlot.Extend);
        expect(Math.hypot(ext.x, ext.y)).toBeCloseTo(RADIAL_R, 9);
        expect(Math.atan2(ext.y, ext.x)).toBeCloseTo(base, 9); // extend is at the front (the heading)
    });

    test("extend is at the front; length and angle knobs flank it symmetrically at ±60°", () => {
        // feel round 12: extend back at the front (slot 0), the two knobs mirror across it at ∓60°.
        const base = 0.3;
        const len = ringSlot(base, RadialSlot.Length);
        const ext = ringSlot(base, RadialSlot.Extend);
        const ang = ringSlot(base, RadialSlot.Angle);
        expect(Math.atan2(ext.y, ext.x)).toBeCloseTo(base, 9); // slot 0 → along the heading
        const dl = Math.atan2(len.y, len.x) - Math.atan2(ext.y, ext.x);
        const da = Math.atan2(ang.y, ang.x) - Math.atan2(ext.y, ext.x);
        expect(dl).toBeCloseTo(-da, 9); // mirror across extend
        expect(da).toBeCloseTo(Math.PI / 3, 9); // +60°
    });
});
