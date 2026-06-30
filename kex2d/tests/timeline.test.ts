import { describe, expect, test } from "bun:test";
import {
    clampView,
    marginSec,
    niceStep,
    pxToSec,
    secToPx,
    ticks,
    type View,
    zoomAt,
} from "../src/timeline";

describe("secToPx / pxToSec — affine roundtrip", () => {
    const views: View[] = [
        { pan: 0, pxPerSec: 100 },
        { pan: 250, pxPerSec: 37.5 },
        { pan: -80, pxPerSec: 1000 },
    ];
    test("pxToSec ∘ secToPx is identity", () => {
        for (const v of views) {
            for (const t of [0, 0.5, 3.2, 12.75]) {
                expect(pxToSec(v, secToPx(v, t))).toBeCloseTo(t, 9);
            }
        }
    });
    test("secToPx ∘ pxToSec is identity", () => {
        for (const v of views) {
            for (const px of [0, 17, 480, 1000]) {
                expect(secToPx(v, pxToSec(v, px))).toBeCloseTo(px, 9);
            }
        }
    });
});

describe("niceStep — 1-2-5×10ⁿ", () => {
    test("every result is a 1, 2, or 5 times a power of ten", () => {
        for (let raw = 0.013; raw < 5000; raw *= 1.17) {
            const s = niceStep(raw);
            expect([1, 2, 5].some((m) => isClean(s, m))).toBe(true);
        }
    });
    test("picks the near 1-2-5 neighbour", () => {
        expect(niceStep(1)).toBe(1);
        expect(niceStep(1.4)).toBe(1);
        expect(niceStep(1.6)).toBe(2);
        expect(niceStep(3)).toBe(2);
        expect(niceStep(4)).toBe(5);
        expect(niceStep(8)).toBe(10);
        expect(niceStep(0.13)).toBeCloseTo(0.1, 12);
        expect(niceStep(0.4)).toBeCloseTo(0.5, 12);
        expect(niceStep(230)).toBe(200);
    });
});

function isClean(step: number, m: number): boolean {
    const ratio = step / m;
    const log = Math.log10(ratio);
    return Math.abs(log - Math.round(log)) < 1e-9;
}

describe("clampView — extent + margin", () => {
    const W = 1000;
    const T = 10;
    test("never zooms out past the whole-track fit", () => {
        const fitted = clampView({ pan: 0, pxPerSec: 0 }, W, T);
        const min = W / (T + marginSec(T)); // one-sided lead-out
        expect(fitted.pxPerSec).toBeCloseTo(min, 9);
        // a request to zoom further out is held at the fit
        expect(clampView({ pan: 0, pxPerSec: min / 2 }, W, T).pxPerSec).toBeCloseTo(min, 9);
    });
    test("the fitted view shows exactly [0, tTotal+margin] — left anchored at the launch", () => {
        const m = marginSec(T);
        const v = clampView({ pan: -Number.MAX_VALUE, pxPerSec: 0 }, W, T);
        expect(pxToSec(v, 0)).toBeCloseTo(0, 6); // no negative time before launch
        expect(pxToSec(v, W)).toBeCloseTo(T + m, 6);
    });
    test("pan never reveals time before the launch (t=0) or past the lead-out", () => {
        const m = marginSec(T);
        const zoomed: View = { pan: 1e6, pxPerSec: 400 }; // pan way past the right edge
        const c = clampView(zoomed, W, T);
        expect(pxToSec(c, 0)).toBeGreaterThanOrEqual(-1e-6); // left can't cross 0
        expect(pxToSec(c, W)).toBeLessThanOrEqual(T + m + 1e-6);
        // panning hard left holds at t=0, not negative
        const left = clampView({ pan: -1e6, pxPerSec: 400 }, W, T);
        expect(pxToSec(left, 0)).toBeCloseTo(0, 6);
    });
});

describe("zoomAt — cursor-anchored", () => {
    const W = 1000;
    const T = 10;
    test("the second under the cursor is fixed across a zoom-in (interior anchor)", () => {
        const v = clampView({ pan: -Number.MAX_VALUE, pxPerSec: 0 }, W, T); // fitted
        const anchor = W / 2;
        const before = pxToSec(v, anchor);
        const z = zoomAt(v, anchor, 2, W, T);
        expect(z.pxPerSec).toBeGreaterThan(v.pxPerSec);
        expect(pxToSec(z, anchor)).toBeCloseTo(before, 6);
    });
    test("zoom-out from a zoomed-in view returns toward the fit", () => {
        const fitted = clampView({ pan: -Number.MAX_VALUE, pxPerSec: 0 }, W, T);
        const inView = zoomAt(fitted, W / 2, 4, W, T);
        const out = zoomAt(inView, W / 2, 0.001, W, T); // clamps to min scale
        expect(out.pxPerSec).toBeCloseTo(fitted.pxPerSec, 6);
    });
});

describe("ticks — visible 1-2-5 grid", () => {
    test("ticks are step-spaced and cover the viewport", () => {
        const v: View = { pan: 0, pxPerSec: 100 }; // 10s of track in 1000px → step ~ 1s
        const t = ticks(v, 1000);
        expect(t.length).toBeGreaterThan(2);
        const dpx = t[1].px - t[0].px;
        for (let i = 2; i < t.length; i++) {
            expect(t[i].px - t[i - 1].px).toBeCloseTo(dpx, 6);
        }
        // a tick exists at or just left of x=0 and at or just right of x=width
        expect(t[0].px).toBeLessThanOrEqual(0 + 1e-6);
        expect(t[t.length - 1].px).toBeGreaterThanOrEqual(1000 - dpx);
    });
    test("empty when degenerate", () => {
        expect(ticks({ pan: 0, pxPerSec: 0 }, 1000)).toHaveLength(0);
        expect(ticks({ pan: 0, pxPerSec: 100 }, 0)).toHaveLength(0);
    });
});
