import { describe, expect, test } from "bun:test";
import { flyoutFit, menuFit } from "../src/menu";

describe("menuFit — root context menu viewport fit (flip up/left, clamp)", () => {
    const Vp = { w: 1280, h: 800 };
    const size = { w: 132, h: 160 };
    const pad = 4;

    test("opens down-right at the cursor when it fits", () => {
        expect(menuFit({ x: 200, y: 100 }, size, Vp)).toEqual({ x: 200, y: 100 });
    });
    test("flips UP (bottom edge at the anchor) when opening down would clip the bottom", () => {
        // y=780 → bottom 940 > 796; room above (780-160=620 ≥ 4) → open upward
        expect(menuFit({ x: 200, y: 780 }, size, Vp)).toEqual({ x: 200, y: 620 });
    });
    test("flips LEFT (right edge at the anchor) when opening right would clip the right edge", () => {
        // x=1240 → right 1372 > 1276; room left (1240-132=1108 ≥ 4) → open leftward
        expect(menuFit({ x: 1240, y: 100 }, size, Vp)).toEqual({ x: 1108, y: 100 });
    });
    test("flips BOTH axes near the bottom-right corner (the reported-bug corner)", () => {
        expect(menuFit({ x: 1240, y: 780 }, size, Vp)).toEqual({ x: 1108, y: 620 });
    });
    test("a menu taller than the viewport keeps its top-left visible, clipping the bottom", () => {
        const tall = { w: 132, h: 900 };
        // no room above (780-900 < 4) → no flip; clamp pins the top at the pad, bottom clips
        expect(menuFit({ x: 200, y: 780 }, tall, Vp)).toEqual({ x: 200, y: pad });
    });
    test("a menu wider than the viewport keeps its left edge at the pad", () => {
        const wide = { w: 1300, h: 160 };
        // no room left (1270-1300 < 4) → no flip; clamp pins x at the pad
        expect(menuFit({ x: 1270, y: 100 }, wide, Vp)).toEqual({ x: pad, y: 100 });
    });
});

describe("flyoutFit — submenu flyout viewport fit (all four edges)", () => {
    const Vp = { w: 1000, h: 800 };
    const size = { w: 128, h: 200 };
    const pad = 4;

    describe("horizontal", () => {
        test("stays on the right when the right side has room", () => {
            // parent.right = 200, right space = 1000 - 4 - 203 = 793 ≥ 128 → no flip
            expect(flyoutFit({ left: 60, right: 200, top: 100 }, size, Vp).flipX).toBe(false);
        });
        test("flips left when the right clips and the left has room", () => {
            // parent.right = 900 → right space = 1000 - 4 - 903 = 93 < 128 (clips);
            // parent.left = 760 → left space = 760 - 3 - 4 = 753 ≥ 128 → flip
            expect(flyoutFit({ left: 760, right: 900, top: 100 }, size, Vp).flipX).toBe(true);
        });
        test("takes the side with MORE room when neither side fits", () => {
            // a viewport narrower than the flyout: right space > left space → stay right
            const narrow = { w: 150, h: 800 };
            // parent right at 100 → rightSpace = 150-4-103 = 43; leftSpace = 20-3-4 = 13 → stay
            expect(flyoutFit({ left: 20, right: 100, top: 100 }, size, narrow).flipX).toBe(false);
            // parent pushed right → leftSpace > rightSpace → flip
            expect(flyoutFit({ left: 60, right: 140, top: 100 }, size, narrow).flipX).toBe(true);
        });
    });

    describe("vertical", () => {
        test("no shift when the flyout fits between the edges", () => {
            // top = 100, bottom = 300 ≤ 796, top ≥ 4 → no nudge
            expect(flyoutFit({ left: 60, right: 200, top: 100 }, size, Vp).shiftY).toBe(0);
        });
        test("nudges UP when the flyout would clip the bottom", () => {
            // top = 700 → bottom 900 > 796 → shiftY = 796 - 900 = -104; top 700-104=596 ≥ 4 ok
            const fit = flyoutFit({ left: 60, right: 200, top: 700 }, size, Vp);
            expect(fit.shiftY).toBeCloseTo(-104, 9);
            expect(700 + fit.shiftY + size.h).toBeCloseTo(Vp.h - pad, 9); // bottom sits at the pad
        });
        test("nudges DOWN when the flyout opens above the top edge", () => {
            // top = 1 (< pad) → nudge down to clear the top: shiftY = 4 - 1 = 3
            const fit = flyoutFit({ left: 60, right: 200, top: 1 }, size, Vp);
            expect(fit.shiftY).toBe(pad - 1);
            expect(1 + fit.shiftY).toBe(pad); // top sits exactly at the pad
        });
        test("a flyout taller than the viewport keeps its top visible, clipping the bottom", () => {
            const tall = { w: 128, h: 900 }; // taller than the 800 viewport
            const fit = flyoutFit({ left: 60, right: 200, top: 500 }, tall, Vp);
            // the bottom-nudge would push top far above 4, so the top clamp wins
            expect(500 + fit.shiftY).toBe(pad); // top pinned at the pad (parent connection kept)
            expect(500 + fit.shiftY + tall.h).toBeGreaterThan(Vp.h); // bottom clips, unavoidable
        });
    });
});
