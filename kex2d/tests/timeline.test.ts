import { describe, expect, test } from "bun:test";
import {
    clampView,
    marginSec,
    mirrorTangent,
    niceStep,
    pxToSec,
    secToPx,
    ticks,
    type View,
    yFit,
    type YFit,
    yGrow,
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

describe("yFit — stable default frame that expands to fit", () => {
    const isClean = (s: number, m: number): boolean => {
        const r = Math.log10(s / m);
        return Math.abs(r - Math.round(r)) < 1e-9;
    };

    test("bounds are nice 1-2-5 multiples and bracket the data + base", () => {
        const f = yFit(0.2, 4.4, 1);
        expect([1, 2, 5].some((m) => isClean(f.step, m))).toBe(true);
        expect(f.lo).toBeLessThanOrEqual(0.2);
        expect(f.hi).toBeGreaterThanOrEqual(4.4);
        expect(f.lo).toBeLessThanOrEqual(1); // base (1g) always in range
        expect(f.hi).toBeGreaterThanOrEqual(1);
    });

    test("a gentle near-1g curve shows the same stable frame regardless of small data", () => {
        // the whole point: zero vs one keyframe near 1g must NOT rescale the axis.
        const flat = yFit(1, 1, 1); // no spread (e.g. no pins)
        const tiny = yFit(0.8, 1.3, 1); // a small authored bump
        expect(tiny.lo).toBe(flat.lo);
        expect(tiny.hi).toBe(flat.hi);
        expect(flat.lo).toBeLessThan(0); // a calm window, not a hug of [1,1]
        expect(flat.hi).toBeGreaterThan(2);
    });

    test("data beyond the frame expands the view (never clips)", () => {
        expect(yFit(1, 6, 1).hi).toBeGreaterThanOrEqual(6); // strong positive g shown
        expect(yFit(-2.5, 1, 1).lo).toBeLessThanOrEqual(-2.5); // airtime shown
    });

    test("always includes the base even when data sits away from it", () => {
        expect(yFit(4, 6, 1).lo).toBeLessThanOrEqual(1);
    });
});

describe("yGrow — edge-triggered grow-to-follow", () => {
    const Cap: [number, number] = [-3, 7];
    const Top = 34;
    const Bot = 174; // 140px chart
    const Rate = 0.2;
    const view: YFit = { lo: 0.4, hi: 1.4, step: 0.2 };

    test("a cursor anywhere inside the chart leaves the range unchanged (grab is stable)", () => {
        expect(yGrow(view, (Top + Bot) / 2, Top, Bot, Rate, Cap)).toBe(view); // middle
        expect(yGrow(view, Top, Top, Bot, Rate, Cap)).toBe(view); // resting AT the top edge
        expect(yGrow(view, Bot, Top, Bot, Rate, Cap)).toBe(view); // resting AT the bottom edge
    });

    test("dragging below the bottom edge grows lo downward, hi fixed", () => {
        const g = yGrow(view, Bot + 20, Top, Bot, Rate, Cap);
        expect(g).not.toBe(view);
        expect(g.lo).toBeLessThan(view.lo);
        expect(g.hi).toBe(view.hi);
    });

    test("dragging above the top edge grows hi upward, lo fixed", () => {
        const g = yGrow(view, Top - 20, Top, Bot, Rate, Cap);
        expect(g.hi).toBeGreaterThan(view.hi);
        expect(g.lo).toBe(view.lo);
    });

    test("further past the edge grows faster (speed ∝ distance outside)", () => {
        const shallow = yGrow(view, Bot + 5, Top, Bot, Rate, Cap);
        const deep = yGrow(view, Bot + 40, Top, Bot, Rate, Cap);
        expect(view.lo - deep.lo).toBeGreaterThan(view.lo - shallow.lo);
    });

    test("never grows past the cap", () => {
        const atCap: YFit = { lo: Cap[0], hi: Cap[1], step: 2 };
        expect(yGrow(atCap, Bot + 20, Top, Bot, Rate, Cap)).toBe(atCap); // lo already at cap
        // a huge single step still clamps to the cap, never beyond
        const g = yGrow({ lo: -2.9, hi: 1, step: 1 }, Bot + 20, Top, Bot, 100, Cap);
        expect(g.lo).toBe(Cap[0]);
    });
});

describe("mirrorTangent — auto/continuous handle", () => {
    test("opposite direction, same length (collinear through the keyframe)", () => {
        const m = mirrorTangent(3, 4, 10); // dragged vec (3,4) len 5; other length 10
        expect(m).not.toBeNull();
        if (!m) return;
        expect(Math.hypot(m.x, m.y)).toBeCloseTo(10, 9); // preserves the other length
        expect(3 * m.y - 4 * m.x).toBeCloseTo(0, 9); // cross product 0 → collinear
        expect(3 * m.x + 4 * m.y).toBeLessThan(0); // dot < 0 → opposite side of the pin
    });
    test("null when the dragged vector has no direction", () => {
        expect(mirrorTangent(0, 0, 5)).toBeNull();
    });
});
