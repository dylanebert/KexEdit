import { describe, expect, test } from "bun:test";
import {
    type Camera,
    cameraTx,
    defaultCamera,
    frameContent,
    MAX_ZOOM,
    MIN_ZOOM,
    panCamera,
    readoutFit,
    resize,
    screenToWorld,
    zoomAt,
} from "../src/view";

// a stub `HTMLCanvasElement` + `CanvasRenderingContext2D`, plain objects — `resize` only reads
// `clientWidth`/`clientHeight`/`width`/`height` and calls `ctx.setTransform`, none of which need
// a real DOM (bun test runs no DOM). `devicePixelRatio` isn't defined outside a browser `window`,
// so these tests stub `globalThis.window` for the call's duration and restore it after.
function stubCanvas(clientWidth: number, clientHeight: number) {
    const setTransformCalls: number[][] = [];
    const canvas = {
        clientWidth,
        clientHeight,
        width: 0,
        height: 0,
    } as unknown as HTMLCanvasElement;
    const ctx = {
        setTransform: (...args: number[]) => setTransformCalls.push(args),
    } as unknown as CanvasRenderingContext2D;
    return { canvas, ctx, setTransformCalls };
}

function withDpr<T>(dpr: number, fn: () => T): T {
    const prev = (globalThis as { window?: { devicePixelRatio?: number } }).window;
    (globalThis as { window?: { devicePixelRatio?: number } }).window = { devicePixelRatio: dpr };
    try {
        return fn();
    } finally {
        (globalThis as { window?: unknown }).window = prev;
    }
}

describe("resize — the pixel buffer sizes off the SAME value the caller's draw math uses (S2, resize-flicker fix)", () => {
    test("no explicit w/h: falls back to a live DOM read, same as before the fix", () => {
        const { canvas, ctx } = stubCanvas(300, 150);
        withDpr(2, () => resize(canvas, ctx));
        expect(canvas.width).toBe(600);
        expect(canvas.height).toBe(300);
    });

    test("explicit w/h WINS over a stale canvas.clientWidth — the race the fix closes", () => {
        // `canvas.clientWidth`/`clientHeight` simulate the layout having already moved (the DOM
        // read is always current) while the caller's reactive `w`/`h` (passed explicitly here)
        // simulate a `ResizeObserver` binding that hasn't caught up yet. Pre-fix, `resize` read
        // `canvas.clientWidth` unconditionally — this assertion is exactly what would have failed
        // against that code (the buffer would have sized off 500, not 300).
        const { canvas, ctx } = stubCanvas(500, 260);
        withDpr(1, () => resize(canvas, ctx, 300, 150));
        expect(canvas.width).toBe(300);
        expect(canvas.height).toBe(150);
    });

    test("skips the write (and setTransform) when the buffer already matches — the existing early-out, unchanged by the fix", () => {
        const { canvas, ctx, setTransformCalls } = stubCanvas(300, 150);
        canvas.width = 300;
        canvas.height = 150;
        withDpr(1, () => resize(canvas, ctx, 300, 150));
        expect(setTransformCalls.length).toBe(0);
    });
});

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

describe("readoutFit — the snap readout stays whole in the viewport", () => {
    const Off = 69; // RADIAL_R(46) + RADIAL_BTN_R(15) + gap(8) — the App derivation
    const Size = { w: 90, h: 18 };
    const Vp = { w: 1280, h: 800 };
    const Dock = 256;
    const Margin = 8;

    test("centers below the node with room to spare", () => {
        const p = readoutFit({ x: 640, y: 300 }, Off, Size, Vp, Dock, Margin);
        expect(p.x).toBeCloseTo(640 - Size.w / 2, 9); // centered horizontally on the node
        expect(p.y).toBe(300 + Off); // hung below by the full offset (clears the ring)
    });

    test("clears the radial ring below the node", () => {
        // the readout's top starts strictly past the ring's far edge (RADIAL_R + RADIAL_BTN_R).
        const p = readoutFit({ x: 640, y: 300 }, Off, Size, Vp, Dock, Margin);
        expect(p.y - 300).toBeGreaterThan(46 + 15);
    });

    test("slides in at the left edge instead of clipping", () => {
        const p = readoutFit({ x: 4, y: 300 }, Off, Size, Vp, Dock, Margin);
        expect(p.x).toBe(Margin); // clamped to the left margin, no longer centered
    });

    test("slides in at the right edge instead of clipping", () => {
        const p = readoutFit({ x: Vp.w - 4, y: 300 }, Off, Size, Vp, Dock, Margin);
        expect(p.x).toBe(Vp.w - Margin - Size.w); // right edge sits a margin off the viewport
    });

    test("flips above the node when below would cross into the dock band", () => {
        // a node low enough that below (y + off + h) would land under the dock floor: flip up.
        const ny = Vp.h - Dock - 10;
        const p = readoutFit({ x: 640, y: ny }, Off, Size, Vp, Dock, Margin);
        expect(p.y).toBe(ny - Off - Size.h); // above the node, its bottom a full offset up
        expect(p.y + Size.h).toBeLessThanOrEqual(Vp.h - Dock - Margin); // clear of the dock
        expect(ny - p.y).toBeGreaterThan(46 + 15); // still clears the ring on the flipped side
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
