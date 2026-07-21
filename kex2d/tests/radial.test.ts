import { describe, expect, test } from "bun:test";
import { RADIAL_R, RadialSlot, ringBase, ringSlot } from "../src/radial";

// the shared node-action ring: the add/delete buttons + the two manipulator knobs all slot into one
// ring so they can't drift apart (feel round 5, the fix for the length knob floating behind the add
// button). the load-bearing invariants: the base angle is the node's heading mapped world→screen
// (the y-flip that the chord-relative placement got wrong), and the length + angle knobs sit on
// OPPOSITE sides of the ring.

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

describe("ring slots (the even 60° fan)", () => {
    test("a slot sits RADIAL_R px from the node at base + slot·60°", () => {
        const base = 0.3;
        const ext = ringSlot(base, RadialSlot.Extend);
        expect(Math.hypot(ext.x, ext.y)).toBeCloseTo(RADIAL_R, 9);
        expect(Math.atan2(ext.y, ext.x)).toBeCloseTo(base, 9); // extend is along the heading
    });

    test("length and angle knobs flank extend symmetrically at ±60°", () => {
        // the round-6 layout: measure (−60°) · extend (0°) · pitch (+60°). the two knobs mirror
        // across the extend ray — equal-and-opposite offsets from it.
        const base = 0.3;
        const len = ringSlot(base, RadialSlot.Length);
        const ang = ringSlot(base, RadialSlot.Angle);
        const ext = ringSlot(base, RadialSlot.Extend);
        const dl = Math.atan2(len.y, len.x) - Math.atan2(ext.y, ext.x);
        const da = Math.atan2(ang.y, ang.x) - Math.atan2(ext.y, ext.x);
        expect(dl).toBeCloseTo(-da, 9); // mirror across extend
        expect(da).toBeCloseTo(Math.PI / 3, 9); // +60°
    });

    test("delete sits one slot past the angle knob (+120°)", () => {
        const base = 0.3;
        const del = ringSlot(base, RadialSlot.Delete);
        const ext = ringSlot(base, RadialSlot.Extend);
        const dd = Math.atan2(del.y, del.x) - Math.atan2(ext.y, ext.x);
        expect(dd).toBeCloseTo((2 * Math.PI) / 3, 9); // +120°
    });
});
