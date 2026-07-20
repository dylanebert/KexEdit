import { describe, expect, test } from "bun:test";
import {
    type Camera,
    cameraTx,
    defaultCamera,
    frameContent,
    MAX_ZOOM,
    MIN_ZOOM,
    panCamera,
    screenToWorld,
    zoomAt,
} from "../src/view";

// the world point that lands under a screen point, via the render-consumer transform —
// the invariant every camera op is checked against.
const worldAt = (cam: Camera, px: number, py: number): { x: number; y: number } =>
    screenToWorld(cameraTx(cam), px, py);

// the tolerance is float roundoff on an f64 affine (multiply + subtract over values up to
// a few thousand): ~1e-10 absolute. 1e-6 is comfortable headroom, not a tuned threshold.
const TOL = 6;

describe("defaultCamera — HUD-aware framing", () => {
    const W = 1440;
    const H = 900;
    const cam = defaultCamera(W, H);

    test("centers the origin horizontally", () => {
        expect(cam.ox).toBe(W / 2);
    });

    test("centers the origin vertically in the region above the dock", () => {
        // dock reserves 240 + 16 = 256px at the bottom; the origin sits at the middle of
        // what remains above it, not the canvas center.
        expect(cam.oy).toBe((H - 256) / 2);
        expect(cam.oy).toBeLessThan(H / 2); // lifted above center to clear the dock
    });

    test("initial zoom fits ±280m across the width", () => {
        expect(cam.zoom).toBeCloseTo(W / (2 * 280), TOL);
    });

    test("degenerate pre-layout size doesn't produce a nonpositive zoom", () => {
        expect(defaultCamera(0, 0).zoom).toBeGreaterThan(0);
    });
});

describe("zoomAt — the world point under the cursor stays fixed", () => {
    const cam = defaultCamera(1440, 900);

    test("holds the anchor across a zoom-in", () => {
        const px = 500;
        const py = 300;
        const before = worldAt(cam, px, py);
        const after = zoomAt(cam, px, py, 1.7);
        const now = worldAt(after, px, py);
        expect(now.x).toBeCloseTo(before.x, TOL);
        expect(now.y).toBeCloseTo(before.y, TOL);
        expect(after.zoom).toBeCloseTo(cam.zoom * 1.7, TOL);
    });

    test("holds the anchor across a zoom-out", () => {
        const px = 900;
        const py = 620;
        const before = worldAt(cam, px, py);
        const after = zoomAt(cam, px, py, 0.4);
        const now = worldAt(after, px, py);
        expect(now.x).toBeCloseTo(before.x, TOL);
        expect(now.y).toBeCloseTo(before.y, TOL);
    });

    test("off-origin anchor still holds under repeated zooms", () => {
        const px = 120;
        const py = 780;
        const before = worldAt(cam, px, py);
        let c = cam;
        for (const f of [1.3, 1.3, 0.6, 2.0, 0.5]) c = zoomAt(c, px, py, f);
        const now = worldAt(c, px, py);
        expect(now.x).toBeCloseTo(before.x, TOL);
        expect(now.y).toBeCloseTo(before.y, TOL);
    });
});

describe("zoomAt — zoom limits", () => {
    const cam = defaultCamera(1440, 900);

    test("clamps at MAX_ZOOM and still holds the anchor", () => {
        const px = 640;
        const py = 400;
        const before = worldAt(cam, px, py);
        const after = zoomAt(cam, px, py, 1e6);
        expect(after.zoom).toBe(MAX_ZOOM);
        const now = worldAt(after, px, py);
        expect(now.x).toBeCloseTo(before.x, TOL);
        expect(now.y).toBeCloseTo(before.y, TOL);
    });

    test("clamps at MIN_ZOOM and still holds the anchor", () => {
        const px = 640;
        const py = 400;
        const before = worldAt(cam, px, py);
        const after = zoomAt(cam, px, py, 1e-6);
        expect(after.zoom).toBe(MIN_ZOOM);
        const now = worldAt(after, px, py);
        expect(now.x).toBeCloseTo(before.x, TOL);
        expect(now.y).toBeCloseTo(before.y, TOL);
    });
});

describe("frameContent — fit a box in the region above the dock", () => {
    const W = 1000;
    const H = 800;
    const availH = H - 256; // the dock reserve, the region frameContent centers within

    test("centers the box in the region above the dock", () => {
        const cam = frameContent(W, H, { minX: 5, minY: 2, maxX: 15, maxY: 8 });
        // the box center (10, 5) lands at the region center (width/2, availH/2).
        const c = worldAt(cam, W / 2, availH / 2);
        expect(c.x).toBeCloseTo(10, TOL);
        expect(c.y).toBeCloseTo(5, TOL);
    });

    test("fits the box inside the region with symmetric padding", () => {
        const cam = frameContent(W, H, { minX: 0, minY: 0, maxX: 100, maxY: 0 });
        const tx = cameraTx(cam);
        const left = tx.ox + 0 * tx.sx;
        const right = tx.ox + 100 * tx.sx;
        // both ends land inside the width, with a margin (the pad) on each side.
        expect(left).toBeGreaterThan(0);
        expect(right).toBeLessThan(W);
        expect(left).toBeCloseTo(W - right, TOL); // symmetric about the center
    });

    test("a degenerate point clamps to MAX_ZOOM and stays centered", () => {
        const cam = frameContent(2000, 2000, { minX: 10, minY: 5, maxX: 10, maxY: 5 });
        expect(cam.zoom).toBe(MAX_ZOOM);
        const c = worldAt(cam, 2000 / 2, (2000 - 256) / 2);
        expect(c.x).toBeCloseTo(10, TOL);
        expect(c.y).toBeCloseTo(5, TOL);
    });
});

describe("panCamera — a screen delta slides the world", () => {
    const cam = defaultCamera(1440, 900);

    test("shifts a fixed world point's screen position by the drag delta", () => {
        const dx = 37;
        const dy = -21;
        const tx0 = cameraTx(cam);
        const tx1 = cameraTx(panCamera(cam, dx, dy));
        // world (5, 3): its screen point moves by exactly (dx, dy).
        const wx = 5;
        const wy = 3;
        expect(tx1.ox + wx * tx1.sx).toBeCloseTo(tx0.ox + wx * tx0.sx + dx, TOL);
        expect(tx1.oy + wy * tx1.sy).toBeCloseTo(tx0.oy + wy * tx0.sy + dy, TOL);
    });

    test("leaves the zoom untouched", () => {
        expect(panCamera(cam, 100, 100).zoom).toBe(cam.zoom);
    });
});
