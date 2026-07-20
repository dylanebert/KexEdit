import { describe, expect, test } from "bun:test";
import {
    arcToTime,
    clampView,
    frameAll,
    type Mapping,
    marginArc,
    MAX_PX_PER_M,
    mirrorTangent,
    navDragView,
    navWindow,
    niceStep,
    pxToS,
    sToPx,
    ticks,
    timeToArc,
    type View,
    xGrow,
    yFit,
    type YFit,
    yGrow,
    zoomAt,
} from "../src/timeline";

describe("timeToArc / arcToTime — display mapping", () => {
    // a non-uniform monotone table (arc accelerates while time is even): the
    // shape of a real bake, where speed varies so equal times cover unequal arc.
    const m: Mapping = {
        arc: Float64Array.from([0, 1, 3, 6, 10]),
        t: Float64Array.from([0, 0.5, 1, 2, 4]),
        n: 5,
    };
    test("roundtrips at the sample knots", () => {
        for (let i = 0; i < m.n; i++) {
            expect(timeToArc(m, m.t[i])).toBeCloseTo(m.arc[i], 9);
            expect(arcToTime(m, m.arc[i])).toBeCloseTo(m.t[i], 9);
        }
    });
    test("interpolates linearly between knots", () => {
        // midway in time between t=1 (arc 3) and t=2 (arc 6) → arc 4.5, and back.
        expect(timeToArc(m, 1.5)).toBeCloseTo(4.5, 9);
        expect(arcToTime(m, 4.5)).toBeCloseTo(1.5, 9);
    });
    test("clamps outside the range to the ends", () => {
        expect(timeToArc(m, -1)).toBe(0);
        expect(timeToArc(m, 99)).toBe(10);
        expect(arcToTime(m, -1)).toBe(0);
        expect(arcToTime(m, 99)).toBe(4);
    });
});

describe("sToPx / pxToS — affine roundtrip", () => {
    const views: View[] = [
        { pan: 0, pxPerM: 100 },
        { pan: 250, pxPerM: 37.5 },
        { pan: -80, pxPerM: 1000 },
    ];
    test("pxToS ∘ sToPx is identity", () => {
        for (const v of views) {
            for (const t of [0, 0.5, 3.2, 12.75]) {
                expect(pxToS(v, sToPx(v, t))).toBeCloseTo(t, 9);
            }
        }
    });
    test("sToPx ∘ pxToS is identity", () => {
        for (const v of views) {
            for (const px of [0, 17, 480, 1000]) {
                expect(sToPx(v, pxToS(v, px))).toBeCloseTo(px, 9);
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

describe("clampView — pan clamp, no forced zoom", () => {
    const W = 1000;
    const T = 10;
    // the x-axis is a DOCUMENT axis: clampView clamps pan but NEVER forces a zoom. it used
    // to floor pxPerM at the whole-track fit; that made a content edit rescale the ruler.
    test("a zoomed-OUT view is left as-is (no min-scale floor)", () => {
        const min = W / (T + marginArc(T)); // the old fit floor
        expect(clampView({ pan: 0, pxPerM: min / 2 }, W, T).pxPerM).toBeCloseTo(min / 2, 9);
        expect(clampView({ pan: 0, pxPerM: 1 }, W, T).pxPerM).toBe(1);
    });
    test("zoom-in is still capped at MAX_PX_PER_M", () => {
        expect(clampView({ pan: 0, pxPerM: MAX_PX_PER_M * 3 }, W, T).pxPerM).toBe(MAX_PX_PER_M);
    });
    test("shrinking the track leaves pxPerM and the visible window unchanged", () => {
        // the no-rescale-on-shrink law: a content edit that shortens the track (here 20m →
        // 8m, while still overflowing the zoomed-in view) never rescales the ruler and never
        // repans the window — the author keeps looking at exactly the same [2, 7]m.
        const v: View = { pan: 400, pxPerM: 200 }; // shows [2, 7]m
        const long = clampView(v, W, 20);
        const short = clampView(v, W, 8);
        expect(short.pxPerM).toBe(long.pxPerM); // no rescale
        expect(pxToS(short, 0)).toBeCloseTo(pxToS(long, 0), 9); // window held
        expect(pxToS(short, W)).toBeCloseTo(pxToS(long, W), 9);
    });
    test("frameAll shows exactly [0, sTotal+margin] — left anchored at the launch", () => {
        const m = marginArc(T);
        const v = frameAll(W, T);
        expect(pxToS(v, 0)).toBeCloseTo(0, 6); // no negative distance before launch
        expect(pxToS(v, W)).toBeCloseTo(T + m, 6);
    });
    test("pan never reveals distance before the launch (s=0) or past the lead-out", () => {
        const m = marginArc(T);
        const zoomed: View = { pan: 1e6, pxPerM: 400 }; // pan way past the right edge
        const c = clampView(zoomed, W, T);
        expect(pxToS(c, 0)).toBeGreaterThanOrEqual(-1e-6); // left can't cross 0
        expect(pxToS(c, W)).toBeLessThanOrEqual(T + m + 1e-6);
        // panning hard left holds at s=0, not negative
        const left = clampView({ pan: -1e6, pxPerM: 400 }, W, T);
        expect(pxToS(left, 0)).toBeCloseTo(0, 6);
    });
});

describe("zoomAt — cursor-anchored", () => {
    const W = 1000;
    const T = 10;
    test("the meter under the cursor is fixed across a zoom-in (interior anchor)", () => {
        const v = frameAll(W, T); // fitted
        const anchor = W / 2;
        const before = pxToS(v, anchor);
        const z = zoomAt(v, anchor, 2, W, T);
        expect(z.pxPerM).toBeGreaterThan(v.pxPerM);
        expect(pxToS(z, anchor)).toBeCloseTo(before, 6);
    });
    test("zoom-out from a zoomed-in view returns toward the fit", () => {
        const fitted = frameAll(W, T);
        const inView = zoomAt(fitted, W / 2, 4, W, T);
        const out = zoomAt(inView, W / 2, 0.001, W, T); // clamps to min scale
        expect(out.pxPerM).toBeCloseTo(fitted.pxPerM, 6);
    });
});

describe("navWindow — overview bracket fractions", () => {
    const W = 1000;
    const T = 10; // total = T + margin = 11.2
    test("the fitted view fills the whole bar", () => {
        const fitted = frameAll(W, T);
        const win = navWindow(fitted, W, T);
        expect(win.l).toBeCloseTo(0, 6);
        expect(win.r).toBeCloseTo(1, 6);
    });
    test("a zoomed-in view is a sub-span", () => {
        const zoomed: View = clampView({ pan: 2 * (W / 3), pxPerM: W / 3 }, W, T); // shows [2,5]m
        const win = navWindow(zoomed, W, T);
        const total = T + marginArc(T);
        expect(win.l).toBeCloseTo(2 / total, 6);
        expect(win.r).toBeCloseTo(5 / total, 6);
    });
});

describe("navDragView — overview drag", () => {
    const W = 1000;
    const T = 10;
    const zoomed: View = clampView({ pan: 2 * (W / 3), pxPerM: W / 3 }, W, T); // shows [2,5]m
    test("pan slides the window and preserves the span", () => {
        const lo = pxToS(zoomed, 0);
        const out = navDragView(zoomed, W, T, "pan", lo + 1, 0); // grab=0 → newLo = cur
        expect(pxToS(out, 0)).toBeCloseTo(3, 6);
        expect(pxToS(out, W)).toBeCloseTo(6, 6);
        expect(out.pxPerM).toBeCloseTo(zoomed.pxPerM, 6); // zoom unchanged
    });
    test("left-edge drag anchors the right edge (a zoom)", () => {
        const out = navDragView(zoomed, W, T, "l", 1, 0); // pull left edge to 1m
        expect(pxToS(out, 0)).toBeCloseTo(1, 6);
        expect(pxToS(out, W)).toBeCloseTo(5, 6); // right edge held
    });
    test("right-edge drag anchors the left edge (a zoom)", () => {
        const out = navDragView(zoomed, W, T, "r", 8, 0); // push right edge to 8m
        expect(pxToS(out, 0)).toBeCloseTo(2, 6); // left edge held
        expect(pxToS(out, W)).toBeCloseTo(8, 6);
    });
    test("an edge can't cross the opposite one — span floors at the zoom ceiling", () => {
        const out = navDragView(zoomed, W, T, "r", 2, 0); // collapse right onto left (2m)
        expect(pxToS(out, W)).toBeGreaterThan(pxToS(out, 0)); // never inverts
        expect(out.pxPerM).toBeCloseTo(MAX_PX_PER_M, 6); // capped at max zoom-in
    });
});

describe("ticks — visible 1-2-5 grid", () => {
    test("ticks are step-spaced and cover the viewport", () => {
        const v: View = { pan: 0, pxPerM: 100 }; // 10m of track in 1000px → step ~ 1m
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
        expect(ticks({ pan: 0, pxPerM: 0 }, 1000)).toHaveLength(0);
        expect(ticks({ pan: 0, pxPerM: 100 }, 0)).toHaveLength(0);
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

describe("xGrow — horizontal edge-scroll pan-to-follow", () => {
    const Left = 44;
    const Right = 800;
    const Rate = 0.4;
    const view: View = { pan: 120, pxPerM: 10 };

    test("a cursor anywhere inside the chart leaves the view unchanged (grab is stable)", () => {
        expect(xGrow(view, (Left + Right) / 2, Left, Right, Rate)).toBe(view);
        expect(xGrow(view, Left, Left, Right, Rate)).toBe(view); // resting AT the left edge
        expect(xGrow(view, Right, Left, Right, Rate)).toBe(view); // resting AT the right edge
    });

    test("dragging past the right edge pans right (reveals more distance), zoom fixed", () => {
        const g = xGrow(view, Right + 30, Left, Right, Rate);
        expect(g.pan).toBeCloseTo(view.pan + 30 * Rate, 6);
        expect(g.pxPerM).toBe(view.pxPerM); // no zoom under the drag
    });

    test("further past the edge pans faster (speed ∝ overshoot)", () => {
        const shallow = xGrow(view, Right + 5, Left, Right, Rate);
        const deep = xGrow(view, Right + 50, Left, Right, Rate);
        expect(deep.pan - view.pan).toBeGreaterThan(shallow.pan - view.pan);
    });

    test("dragging past the left edge pans left but floors at pan 0 (no negative distance)", () => {
        const g = xGrow({ pan: 8, pxPerM: 10 }, Left - 40, Left, Right, Rate);
        expect(g.pan).toBe(0); // 8 − 40·0.4 < 0 → clamped to 0
        // already at 0 → unchanged by identity
        expect(xGrow({ pan: 0, pxPerM: 10 }, Left - 40, Left, Right, Rate)).toEqual({
            pan: 0,
            pxPerM: 10,
        });
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
