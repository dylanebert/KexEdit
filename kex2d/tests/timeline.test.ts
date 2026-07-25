import { describe, expect, test } from "bun:test";
import { TangentMode } from "../src/spline";
import {
    arcToTime,
    clampDelta,
    clampView,
    composeTangent,
    creationTargets,
    fmt,
    frameAll,
    G_GRID,
    type Mapping,
    marginArc,
    MAX_PX_PER_M,
    navDragView,
    navWindow,
    niceStep,
    nodeTickPx,
    nudgeForces,
    pxToS,
    retargetMode,
    S_GRID,
    snap,
    snapAxis,
    SNAP_PX,
    sToPx,
    ticks,
    timeToArc,
    trimTargets,
    type View,
    xGrow,
    yEase,
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

describe("nodeTickPx — read-only geo node tick position", () => {
    // a 4-edge section, entry at sample 10, a uniform 2m/edge chord — the
    // partial-sum-of-ds shape a real bake produces for an evenly-spaced segment.
    const v: View = { pan: 0, pxPerM: 10 };
    const ds = Float32Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 2]); // edges 10..13
    const startSample = 10;

    test("sums ds from the section entry to the node's landing sample, offset by the span", () => {
        // node at sample 12 (2 edges in: 2+2=4m local arc) inside a section whose own
        // span starts at global d=50 → 54m, projected through the view.
        expect(nodeTickPx(v, 50, ds, startSample, 12)).toBeCloseTo(sToPx(v, 54), 9);
    });

    test("a node landing on the entry sample (order 0) sums to zero — sits at the span offset", () => {
        expect(nodeTickPx(v, 50, ds, startSample, startSample)).toBeCloseTo(sToPx(v, 50), 9);
    });

    test("single-segment section: no interior node exists, but the degenerate 2-sample span still resolves at its two ends", () => {
        // a 2-node section (one edge, samples [startSample, startSample+1]) has no
        // interior order to tick — the caller skips it — but the math itself must not
        // blow up on the narrowest possible range.
        const oneEdge = Float32Array.from([3]);
        expect(nodeTickPx(v, 0, oneEdge, 0, 0)).toBeCloseTo(sToPx(v, 0), 9);
        expect(nodeTickPx(v, 0, oneEdge, 0, 1)).toBeCloseTo(sToPx(v, 3), 9);
    });

    test("degenerate ds (zero-length / near-coincident edges) contribute nothing to the sum", () => {
        const degenerate = Float32Array.from([0, 0, 0]);
        expect(nodeTickPx(v, 20, degenerate, 0, 3)).toBeCloseTo(sToPx(v, 20), 9);
    });

    test("an empty range (sample <= startSample) never reads past the array — sums to zero", () => {
        expect(nodeTickPx(v, 5, ds, startSample, startSample - 1)).toBeCloseTo(sToPx(v, 5), 9);
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

describe("fmt — trim trailing zeros to the cap", () => {
    test("a snapped whole value drops the fractional part entirely", () => {
        expect(fmt(1, 2)).toBe("1");
        expect(fmt(24, 1)).toBe("24");
    });
    test("a snapped grid value trims to its natural vocabulary form", () => {
        expect(fmt(3.5, 2)).toBe("3.5");
    });
    test("a Ctrl-freed value keeps its real precision up to the cap", () => {
        expect(fmt(3.47, 2)).toBe("3.47");
    });
    test("rounds to the cap before trimming, never exceeding it", () => {
        expect(fmt(3.456, 2)).toBe("3.46");
        expect(fmt(1.05, 1)).toBe("1.1");
    });
    test("-0 (and anything that rounds to it) normalizes to 0", () => {
        expect(fmt(-0, 2)).toBe("0");
        expect(fmt(-0.001, 2)).toBe("0");
    });
});

function isClean(step: number, m: number): boolean {
    const ratio = step / m;
    const log = Math.log10(ratio);
    return Math.abs(log - Math.round(log)) < 1e-9;
}

describe("marginArc — lead-out", () => {
    // the floor is a SIGNIFICANT absolute lead-out (feel check 2026-07-21): a short track
    // always frames zoomed out a bit, with real empty ruler to build into on the right.
    test("short tracks get the full absolute floor", () => {
        expect(marginArc(10)).toBe(50);
        expect(marginArc(0)).toBe(50);
    });
    test("long tracks keep the proportional lead-out past the floor", () => {
        expect(marginArc(1000)).toBeCloseTo(120, 9);
    });
});

describe("clampView — pan clamp, no forced zoom", () => {
    const W = 1000;
    const T = 10;
    // the x-axis is a DOCUMENT axis: clampView clamps pan but NEVER forces a zoom. it used
    // to floor pxPerM at the whole-track fit; that made a content edit rescale the ruler.
    test("a zoomed-OUT view is left as-is (no min-scale floor)", () => {
        const fit = W / (T + marginArc(T)); // the padded fit scale, for reference
        expect(clampView({ pan: 0, pxPerM: fit / 2 }, W, T).pxPerM).toBeCloseTo(fit / 2, 9);
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
    test("frameAll frames [0, sTotal+padding] exactly, left anchored (any length)", () => {
        const Tlong = 200;
        const m = marginArc(Tlong);
        const v = frameAll(W, Tlong);
        expect(pxToS(v, 0)).toBeCloseTo(0, 6); // no negative distance before launch
        expect(pxToS(v, W)).toBeCloseTo(Tlong + m, 6);
    });
    test("frameAll frames a short track at sTotal+padding, not a floor span", () => {
        // the always-padded axis: the addressable span is ALWAYS sTotal + padding (the same
        // proportional lead-out at every length), so a short track frames [0, sTotal+padding]
        // — a tiny window, not the old arbitrary min-span floor snap.
        const Tshort = 4;
        const m = marginArc(Tshort); // the same padding definition, floored at MARGIN_M
        const v = frameAll(W, Tshort);
        expect(v.pxPerM).toBeCloseTo(W / (Tshort + m), 9);
        expect(v.pan).toBe(0); // left-anchored at the launch
        expect(pxToS(v, 0)).toBeCloseTo(0, 6);
        expect(pxToS(v, W)).toBeCloseTo(Tshort + m, 6); // the window spans exactly the padded track
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
        // a track past the floor, so the fitted view fills the width and the pan clamp
        // doesn't left-anchor it (which would drift the cursor); the anchor-hold is the
        // property under test, independent of the framing.
        const Tlong = 200;
        const v = frameAll(W, Tlong); // fitted, content fills the width
        const anchor = W / 2;
        const before = pxToS(v, anchor);
        const z = zoomAt(v, anchor, 2, W, Tlong);
        expect(z.pxPerM).toBeGreaterThan(v.pxPerM);
        expect(pxToS(z, anchor)).toBeCloseTo(before, 6);
    });
    test("zoom-out from a zoomed-in view returns toward the fit", () => {
        // frameAll frames the padded span [0, sTotal+padding] and a zoom-out floors right back
        // to that scale — for any track length now that the axis is always padded.
        const Tlong = 200;
        const fitted = frameAll(W, Tlong);
        const inView = zoomAt(fitted, W / 2, 4, W, Tlong);
        const out = zoomAt(inView, W / 2, 0.001, W, Tlong); // clamps to the fit scale
        expect(out.pxPerM).toBeCloseTo(fitted.pxPerM, 6);
    });
    test("zoom-out from a below-fit view stays put (never snaps UP to the fit)", () => {
        // after a content shrink the view can sit BELOW the padded framing fit. a wheel
        // zoom-out from there must NOT floor the scale up to the fit — that was the
        // inversion bug: a zoom-OUT tick pushing the scale IN. the floor is min(current,
        // fit), so a zoom-out below fit is a no-op instead. `fit` is the padded framing
        // scale (frameAll's), the same floor a zoom-out returns to.
        const fit = frameAll(W, T).pxPerM; // the padded fit scale
        const belowFit: View = { pan: 0, pxPerM: fit / 2 };
        const out = zoomAt(belowFit, W / 2, 0.5, W, T); // zoom OUT further
        expect(out.pxPerM).toBeCloseTo(belowFit.pxPerM, 9); // held, not snapped up
        expect(out.pxPerM).toBeLessThan(fit); // stays below fit
    });
    test("zoom-out returns to the padded initial framing on a short track", () => {
        // the zoom floor incorporates the padding: zoom in on a short track, then zoom back
        // out — the floor is the padded framing scale, so the visible span returns to exactly
        // sTotal + padding (the initial frame), not the tighter bare-content extent.
        const Tshort = 8;
        const padded = Tshort + marginArc(Tshort);
        const framed = frameAll(W, Tshort);
        const zoomedIn = zoomAt(framed, W / 2, 4, W, Tshort);
        expect(zoomedIn.pxPerM).toBeGreaterThan(framed.pxPerM);
        const out = zoomAt(zoomedIn, W / 2, 0.001, W, Tshort); // floor
        expect(out.pxPerM).toBeCloseTo(framed.pxPerM, 6);
        // the padded window is reachable again — the visible span is the padded frame.
        expect(pxToS(out, W) - pxToS(out, 0)).toBeCloseTo(padded, 4);
    });
});

describe("navWindow — overview bracket fractions", () => {
    const W = 1000;
    const T = 10; // total = T + margin = 60
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
    // the caller's resting window: Timeline.svelte's comfort band, the axis's minimum frame.
    const Frame: [number, number] = [-2, 6];
    const isClean = (s: number, m: number): boolean => {
        const r = Math.log10(s / m);
        return Math.abs(r - Math.round(r)) < 1e-9;
    };

    test("bounds are nice 1-2-5 multiples and bracket the data + base", () => {
        const f = yFit(0.2, 9.4, 1, Frame);
        expect([1, 2, 5].some((m) => isClean(f.step, m))).toBe(true);
        expect(f.lo).toBeLessThanOrEqual(0.2);
        expect(f.hi).toBeGreaterThanOrEqual(9.4);
        expect(f.lo).toBeLessThanOrEqual(1); // base (1g) always in range
        expect(f.hi).toBeGreaterThanOrEqual(1);
    });

    test("a gentle near-1g curve shows the same stable frame regardless of small data", () => {
        // the whole point: zero vs one keyframe near 1g must NOT rescale the axis.
        const flat = yFit(1, 1, 1, Frame); // no spread (e.g. no pins)
        const tiny = yFit(0.8, 1.3, 1, Frame); // a small authored bump
        expect(tiny.lo).toBe(flat.lo);
        expect(tiny.hi).toBe(flat.hi);
        expect(flat.lo).toBeLessThan(0); // a calm window, not a hug of [1,1]
        expect(flat.hi).toBeGreaterThan(2);
    });

    test("in-band data rests EXACTLY at the frame — never wider than the data demands", () => {
        // the outward 1-2-5 rounding is for a bound the DATA pushed past; rounding the frame
        // itself wider would stand the axis off the comfort window it's meant to sit in.
        const f = yFit(0.8, 1.3, 1, Frame);
        expect(f.lo).toBe(Frame[0]);
        expect(f.hi).toBe(Frame[1]);
    });

    test("data beyond the frame expands the view (never clips), the other bound held", () => {
        const up = yFit(1, 9, 1, Frame);
        expect(up.hi).toBeGreaterThanOrEqual(9); // strong positive g shown
        expect(up.lo).toBe(Frame[0]); // the untouched bound stays at the frame
        expect(yFit(-4.5, 1, 1, Frame).lo).toBeLessThanOrEqual(-4.5); // airtime shown
    });

    test("always includes the base even when data sits away from it", () => {
        expect(yFit(4, 6, 1, Frame).lo).toBeLessThanOrEqual(1);
    });
});

describe("yEase — the displayed range's asymmetric approach to its fit", () => {
    const Target: YFit = { lo: -2, hi: 6, step: 2 };
    const Grow = 0.3;
    const Lazy = 0.05;
    const settle = (from: YFit, shrink: number): number => {
        let v = from;
        let n = 0;
        while ((v.lo !== Target.lo || v.hi !== Target.hi) && n < 10000) {
            v = yEase(v, Target, Grow, shrink);
            n++;
        }
        return n;
    };

    test("a range already at its target is returned by identity (caller skips the write)", () => {
        expect(yEase(Target, Target, Grow, Lazy)).toBe(Target);
    });

    test("an out-of-view bound expands at the grow rate, an over-wide one contracts at shrink", () => {
        const narrow = yEase({ lo: -1, hi: 4, step: 1 }, Target, Grow, Lazy);
        expect(narrow.lo).toBeCloseTo(-1 + (-2 - -1) * Grow, 9);
        const wide = yEase({ lo: -20, hi: 20, step: 10 }, Target, Grow, Lazy);
        expect(wide.lo).toBeCloseTo(-20 + (-2 - -20) * Lazy, 9);
    });

    test("the return rate decides whether a grown axis stands: lazy oozes, grow-rate snaps back", () => {
        // the g-range feel bug: an edge drag grows the axis geometrically (a ±20 range inside half
        // a second), so giving the room back at the lazy rate takes many times longer than taking
        // it — long enough that the next gesture re-freezes it and the grown view just stands.
        const grown: YFit = { lo: -20, hi: 20, step: 10 };
        const lazy = settle(grown, Lazy);
        const prompt = settle(grown, Grow);
        expect(lazy).toBeGreaterThan(100); // > 1.6 s at 60fps
        expect(prompt).toBeLessThan(30); // ~0.4 s — the same order as the growth that took it
    });

    test("both bounds converge exactly, so the approach terminates", () => {
        const v = yEase({ lo: -2.0004, hi: 6.0004, step: 2 }, Target, Grow, Lazy);
        expect(v.lo).toBe(Target.lo); // inside the ε window → snapped, not asymptotic
        expect(v.hi).toBe(Target.hi);
    });
});

describe("yGrow — edge-triggered grow-to-follow", () => {
    // the caller's growth ceiling: the comfort band ([-2, 6]) with 1 g of headroom each side.
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

    test("never grows past the cap — growth compounds, so the ceiling is what keeps it usable", () => {
        // uncapped, growth is proportional to the SPAN, so a held drag reaches absurd g almost
        // instantly (the hand check: "rapidly goes to ultra extreme"). the band ± 1 g bounds it.
        const atCap: YFit = { lo: Cap[0], hi: Cap[1], step: 2 };
        expect(yGrow(atCap, Bot + 20, Top, Bot, Rate, Cap)).toBe(atCap); // lo already at cap
        expect(yGrow(atCap, Top - 20, Top, Bot, Rate, Cap)).toBe(atCap); // hi already at cap
        // a huge single step still lands exactly on the cap, never beyond
        expect(yGrow({ lo: -2.9, hi: 1, step: 1 }, Bot + 20, Top, Bot, 100, Cap).lo).toBe(Cap[0]);
        expect(yGrow({ lo: -2, hi: 6.9, step: 1 }, Top - 20, Top, Bot, 100, Cap).hi).toBe(Cap[1]);
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

describe("snap — nearest-target magnet", () => {
    // the resolver is the whole snapping decision: given a value in px and target px, it
    // latches to the nearest target within the threshold, else returns null (no snap). the
    // threshold is a screen-px design constant (SNAP_PX), not a tuned tolerance.
    test("latches to a target within the threshold", () => {
        expect(snap(100, [104])).toBe(104); // 4px away → snaps
        expect(snap(100, [93])).toBe(93); // 7px away → snaps
    });
    test("returns null when every target is beyond the threshold", () => {
        expect(snap(100, [120, 80, 200])).toBeNull(); // nearest is 20px away
        expect(snap(0, [])).toBeNull(); // no targets
    });
    test("picks the nearest of several in-range targets", () => {
        // 105 (5px) and 103 (3px) both within 8px; the nearer, 103, wins.
        expect(snap(100, [105, 103, 96])).toBe(103); // 96 is 4px, 103 is 3px → 103
    });
    test("the threshold is inclusive at exactly SNAP_PX and defaults to SNAP_PX", () => {
        expect(snap(100, [100 + SNAP_PX])).toBe(100 + SNAP_PX); // a target at the edge snaps
        expect(snap(100, [100 + SNAP_PX + 0.001])).toBeNull(); // just past does not
    });
    test("a tighter explicit threshold rejects a target the default would catch", () => {
        expect(snap(100, [106], 8)).toBe(106); // within default
        expect(snap(100, [106], 4)).toBeNull(); // outside the tighter one
    });
    test("snaps toward negative targets symmetrically", () => {
        expect(snap(-50, [-46])).toBe(-46); // 4px away on the negative side
    });
    test("equidistant targets resolve to the last in iteration order (documented tie policy)", () => {
        // load-bearing since callers order their target sets deliberately (boundaries →
        // points → playhead): on an exact tie the later-listed target wins.
        expect(snap(100, [96, 104])).toBe(104); // both 4px away → the later one
        expect(snap(100, [104, 96])).toBe(96); // order flipped → the later one again
    });
    test("a NaN value never snaps (comparisons are false)", () => {
        expect(snap(Number.NaN, [0, 5, 10])).toBeNull();
        expect(snap(3, [Number.NaN])).toBeNull(); // a NaN target is skipped, not latched
    });
});

describe("snapAxis — landmark magnet over a domain grid", () => {
    // the force-keyframe drag resolver: a landmark within SNAP_PX px wins (owns its radius),
    // otherwise the raw value quantizes to the grid. Two landmark kinds: the `targets` (value
    // landmarks) + the grid are the value set a Ctrl/Cmd bypass zeroes; the `startPx`
    // gesture-start landmark is a direction-intent affordance that magnetizes in EVERY mode
    // (plain drag = grid + landmarks + axis magnet; Ctrl = continuous values + axis magnet;
    // no fully-free mode). only a landmark carries a guide px (the grid is ambient). fromPx
    // inverts the view affine (px → domain); tests use identity or a plain scale.
    const id = (px: number): number => px; // domain === px

    test("a landmark within the threshold wins over the grid (priority)", () => {
        // raw 10.3 grid-rounds to 10, but a landmark sits 3px away → the landmark wins,
        // and its value comes back through fromPx with the guide px flagged.
        const r = snapAxis(true, 10.3, 10.3, [13.3], S_GRID, id, null);
        expect(r.value).toBe(13.3); // fromPx(13.3), the landmark — not the grid's 10
        expect(r.guide).toBe(13.3); // a landmark flashes a guide
    });

    test("no landmark in range → quantizes to the grid, no guide", () => {
        const r = snapAxis(true, 10.3, 10.3, [40], S_GRID, id, null); // landmark 29.7px away
        expect(r.value).toBe(10); // 10.3 → nearest whole metre
        expect(r.guide).toBeNull(); // the grid is ambient, no flash
    });

    test("the grid quantizes both directions, at the G_GRID quantum too", () => {
        expect(snapAxis(true, 0.34, 0.34, [], G_GRID, id, null).value).toBeCloseTo(0.3, 10);
        expect(snapAxis(true, 0.36, 0.36, [], G_GRID, id, null).value).toBeCloseTo(0.4, 10);
        expect(snapAxis(true, -0.04, -0.04, [], G_GRID, id, null).value).toBeCloseTo(0, 10);
    });

    test("bypass frees the grid and value landmarks (only the axis pin survives)", () => {
        // a value landmark sits right at rawPx and the value is off-grid, and the start landmark
        // is out of range — so nothing fires and the raw value passes through continuous. this is
        // the Ctrl-drag contract: values freed, but the axis magnet would still have fired had
        // the start been in range (proven below).
        const r = snapAxis(false, 10.7, 10.7, [10.7], S_GRID, id, 40); // start 29.3px away
        expect(r.value).toBe(10.7); // untouched — not the value landmark, not the grid's 11
        expect(r.guide).toBeNull();
    });

    test("bypass keeps the gesture-start landmark magnetizing (Ctrl frees values, never the axis pin)", () => {
        // the reframed contract: Ctrl bypasses the grid + value landmarks but NOT the per-axis
        // gesture-start magnet. a mostly-other-axis Ctrl drag leaves this axis a hair off its
        // start; the start landmark (within SNAP_PX) still pulls it back to the exact start.
        // (under the old all-bypass semantics this returned the raw value — red then.)
        const startVal = 7.42;
        const raw = startVal + 2; // within SNAP_PX of the start
        const r = snapAxis(false, raw, raw, [], G_GRID, id, startVal);
        expect(r.value).toBe(startVal); // the axis magnet fired despite the bypass
        expect(r.guide).toBe(startVal); // the axis magnet is a landmark — it keeps its flash
    });

    test("the gesture-start landmark snaps an off-grid value back to exactly its start", () => {
        // the "change just one axis" affordance in plain drag: a mostly-other-axis drag leaves
        // this axis's raw value a hair off its off-grid start; the start landmark (within SNAP_PX)
        // pulls it back to the exact start, beating the grid it would otherwise round to.
        const startVal = 7.42; // an off-grid gesture-start
        const raw = startVal + 2; // 2px of incidental drift → within SNAP_PX of the start
        const r = snapAxis(true, raw, raw, [], S_GRID, id, startVal);
        expect(r.value).toBe(startVal); // back to the exact start, not the grid's 9
        expect(r.guide).toBe(startVal);
    });

    test("active: the start landmark competes with value landmarks, nearest wins", () => {
        // in the active mode both landmark kinds share one pool; a value landmark 1px from the
        // cursor beats the start landmark 5px away — the start doesn't get priority, just reach.
        const r = snapAxis(true, 10, 10, [11], S_GRID, id, 5);
        expect(r.value).toBe(11); // the closer value landmark
        expect(r.guide).toBe(11);
    });

    test("fromPx inverts the view affine for a landmark hit", () => {
        // domain = px / 2: a landmark at 20px is domain 10. proves the landmark value is the
        // inverted domain, not the raw px.
        const half = (px: number): number => px / 2;
        const r = snapAxis(true, 21, 10.5, [20], S_GRID, half, null);
        expect(r.value).toBe(10); // half(20)
        expect(r.guide).toBe(20); // the guide stays in px
    });
});

describe("composeTangent — force-handle write resolver", () => {
    // the chart's two axis scales (px per metre on s, px per g on the force axis) — distinct, which
    // is why the Aligned coupling is resolved in screen px, not domain units.
    const Pxm = 10;
    const Pyg = 20;

    describe("per-side materialization — only the dragged side becomes explicit", () => {
        test("an out-drag with no existing tangent leaves the IN side derived (absent)", () => {
            const t = composeTangent("out", 2, 0.3, 0, 5, 10, undefined, Pxm, Pyg);
            expect(t.out).toEqual({ ds: 2, dg: 0.3 });
            // the guarded behavior: the un-edited in side is NOT seeded. Mutating the resolver to
            // materialize both sides (e.g. `inn ??= { ds: 0, dg: 0 }`) makes this defined → red.
            expect(t.in).toBeUndefined();
        });

        test("an out-drag leaves an existing IN side EXACTLY as it was (Free — no coupling)", () => {
            const existing = { mode: TangentMode.Free, in: { ds: -1, dg: 0.1 } };
            const t = composeTangent("out", 2, 0.3, 0, 5, 10, existing, Pxm, Pyg);
            expect(t.out).toEqual({ ds: 2, dg: 0.3 });
            expect(t.in).toEqual({ ds: -1, dg: 0.1 }); // untouched: customizing out never edits in
            expect(t.mode).toBe(TangentMode.Free); // the existing mode is preserved
        });

        test("no existing tangent defaults the mode to Aligned (never a no-mode state)", () => {
            const t = composeTangent("in", -1, 0, -3, 5, 10, undefined, Pxm, Pyg);
            expect(t.mode).toBe(TangentMode.Aligned);
        });
    });

    describe("Aligned coupling — the opposite side re-collinearizes in screen px", () => {
        test("dragging OUT off-axis swings the existing IN side anti-collinear, its length kept", () => {
            // both sides start collinear along the s-axis; the out-drag goes off-axis (up in g).
            const existing = {
                mode: TangentMode.Aligned,
                in: { ds: -2, dg: 0 },
                out: { ds: 4, dg: 0 },
            };
            const t = composeTangent("out", 2, 1, 0, 5, 10, existing, Pxm, Pyg);
            expect(t.out).toEqual({ ds: 2, dg: 1 });
            if (!t.in) throw new Error("aligned coupling must keep the in side present");
            // screen-space vectors: (Δs·pxPerM, −Δg·pyPerG). Aligned ⟹ the two are anti-parallel
            // (cross ≈ 0, dot < 0), and the coupled side keeps its ORIGINAL screen length (20 px).
            const outPx = { x: t.out!.ds * Pxm, y: -t.out!.dg * Pyg };
            const inPx = { x: t.in.ds * Pxm, y: -t.in.dg * Pyg };
            const cross = outPx.x * inPx.y - outPx.y * inPx.x;
            const dot = outPx.x * inPx.x + outPx.y * inPx.y;
            expect(cross).toBeCloseTo(0, 6); // collinear
            expect(dot).toBeLessThan(0); // anti-parallel, not co-directional
            expect(Math.hypot(inPx.x, inPx.y)).toBeCloseTo(20, 6); // original in-length preserved
            // guard: delete the coupling block and the in side stays { -2, 0 } → cross ≠ 0 → red.
        });

        test("Free mode does NOT couple — the opposite side is left alone", () => {
            const existing = {
                mode: TangentMode.Free,
                in: { ds: -2, dg: 0 },
                out: { ds: 4, dg: 0 },
            };
            const t = composeTangent("out", 2, 1, 0, 5, 10, existing, Pxm, Pyg);
            expect(t.in).toEqual({ ds: -2, dg: 0 }); // unchanged under Free
        });
    });

    describe("x-monotonicity clamp — Δs stays within the segment span", () => {
        test("an OUT reach clamps to [0, nextS − s]", () => {
            expect(composeTangent("out", 100, 0, 0, 5, 8, undefined, Pxm, Pyg).out!.ds).toBe(3);
            expect(composeTangent("out", -5, 0, 0, 5, 8, undefined, Pxm, Pyg).out!.ds).toBe(0);
        });
        test("an IN reach clamps to [−(s − prevS), 0]", () => {
            expect(composeTangent("in", -100, 0, 2, 5, 8, undefined, Pxm, Pyg).in!.ds).toBe(-3);
            expect(composeTangent("in", 5, 0, 2, 5, 8, undefined, Pxm, Pyg).in!.ds).toBe(0);
        });
        test("an absent neighbour collapses the reach to 0 (a chain end / first keyframe)", () => {
            expect(composeTangent("out", 5, 0, 0, 5, null, undefined, Pxm, Pyg).out!.ds).toBe(0);
            expect(composeTangent("in", -5, 0, null, 5, 10, undefined, Pxm, Pyg).in!.ds).toBe(0);
        });
        // guard: drop the clamp and the OUT Δs stays 100 (past nextS) → g(s) no longer a function → red.
    });

    describe("Mirror coupling — the opposite side matches the dragged side's length too", () => {
        test("dragging OUT swings the IN side anti-collinear AND to the SAME screen length", () => {
            const existing = {
                mode: TangentMode.Mirror,
                in: { ds: -1, dg: 0 }, // a SHORT in side (10 px) — Mirror must grow it to the drag's length
                out: { ds: 4, dg: 0 },
            };
            const t = composeTangent("out", 2, 1, 0, 5, 10, existing, Pxm, Pyg);
            expect(t.out).toEqual({ ds: 2, dg: 1 });
            if (!t.in) throw new Error("mirror coupling must keep the in side present");
            const outPx = { x: t.out!.ds * Pxm, y: -t.out!.dg * Pyg };
            const inPx = { x: t.in.ds * Pxm, y: -t.in.dg * Pyg };
            const cross = outPx.x * inPx.y - outPx.y * inPx.x;
            const dot = outPx.x * inPx.x + outPx.y * inPx.y;
            expect(cross).toBeCloseTo(0, 6); // collinear
            expect(dot).toBeLessThan(0); // anti-parallel
            // Mirror equalizes: the in side takes the DRAGGED side's screen length, not its own.
            expect(Math.hypot(inPx.x, inPx.y)).toBeCloseTo(Math.hypot(outPx.x, outPx.y), 6);
            // guard: with Mirror excluded from the coupling branch, the in side stays {-1,0} (10 px)
            // → its length ≠ the drag's ~28 px → red.
        });
    });
});

describe("retargetMode — the Tangents ▸ mode-switch reconcile (chart pixels)", () => {
    const Pxm = 10;
    const Pyg = 20;

    test("Free just relabels — the offsets are untouched (a corner stays a corner)", () => {
        const tan = {
            mode: TangentMode.Aligned,
            in: { ds: -2, dg: 0.3 },
            out: { ds: 4, dg: -0.1 },
        };
        const t = retargetMode(tan, TangentMode.Free, Pxm, Pyg);
        expect(t).toEqual({
            mode: TangentMode.Free,
            in: { ds: -2, dg: 0.3 },
            out: { ds: 4, dg: -0.1 },
        });
    });

    test("Aligned re-collinearizes a Free corner in screen px, keeping each side's own length", () => {
        // a corner: in flat along −s, out straight up. switching to Aligned must swing the IN side
        // anti-collinear with OUT (the survivor) while KEEPING its own screen length.
        const tan = { mode: TangentMode.Free, in: { ds: -3, dg: 0 }, out: { ds: 0, dg: 2 } };
        const inLen0 = Math.hypot(-3 * Pxm, 0 * Pyg); // 30 px
        const t = retargetMode(tan, TangentMode.Aligned, Pxm, Pyg);
        expect(t.mode).toBe(TangentMode.Aligned);
        if (!t.in || !t.out) throw new Error("both sides must survive");
        // the OUT survivor is unchanged; the IN side is now anti-parallel to it in px, own length kept.
        expect(t.out.ds).toBeCloseTo(0, 6);
        expect(t.out.dg).toBeCloseTo(2, 6);
        const outPx = { x: t.out.ds * Pxm, y: -t.out.dg * Pyg };
        const inPx = { x: t.in.ds * Pxm, y: -t.in.dg * Pyg };
        expect(outPx.x * inPx.y - outPx.y * inPx.x).toBeCloseTo(0, 6); // collinear
        expect(outPx.x * inPx.x + outPx.y * inPx.y).toBeLessThan(0); // anti-parallel
        expect(Math.hypot(inPx.x, inPx.y)).toBeCloseTo(inLen0, 6); // in's OWN length preserved
        // guard: a no-op reconcile (return the tan unchanged) leaves in={-3,0} → not collinear with
        // out={0,2} (cross = (-30)(−40) − 0 ≠ 0) → red.
    });

    test("Mirror re-collinearizes AND equalizes both sides to the survivor's length", () => {
        const tan = { mode: TangentMode.Free, in: { ds: -1, dg: 0 }, out: { ds: 0, dg: 2 } };
        const outLen = Math.hypot(0 * Pxm, 2 * Pyg); // 40 px (the survivor)
        const t = retargetMode(tan, TangentMode.Mirror, Pxm, Pyg);
        if (!t.in || !t.out) throw new Error("both sides must survive");
        const outPx = { x: t.out.ds * Pxm, y: -t.out.dg * Pyg };
        const inPx = { x: t.in.ds * Pxm, y: -t.in.dg * Pyg };
        expect(outPx.x * inPx.y - outPx.y * inPx.x).toBeCloseTo(0, 6); // collinear
        expect(Math.hypot(inPx.x, inPx.y)).toBeCloseTo(outLen, 6); // in grew to the survivor's length
        expect(Math.hypot(outPx.x, outPx.y)).toBeCloseTo(outLen, 6);
    });

    test("a single-sided tangent just relabels the mode (nothing to align to)", () => {
        const tan = { mode: TangentMode.Free, out: { ds: 4, dg: 1 } };
        expect(retargetMode(tan, TangentMode.Aligned, Pxm, Pyg)).toEqual({
            mode: TangentMode.Aligned,
            out: { ds: 4, dg: 1 },
        });
    });
});

describe("trimTargets — extent-trim landmark set", () => {
    // the feel-check-in verdict: the extent trim snaps to content landmarks only — the
    // section's own force points and the parked playhead — never to ruler ticks. the set
    // membership IS the behavior; the projection is `sToPx` (tested above).
    const v: View = { pan: 0, pxPerM: 10 }; // 10px per meter, no pan

    test("own force points and the playhead, each projected to px", () => {
        const out = trimTargets(v, [4, 12], 8);
        expect(out).toEqual([sToPx(v, 4), sToPx(v, 12), sToPx(v, 8)]);
    });
    test("only own points when the playhead is absent (playing / unset)", () => {
        // no ruler tick sneaks in even at a wide zoom-out where ticks would be dense:
        // the set is exactly the section's own points, nothing else.
        const out = trimTargets({ pan: 0, pxPerM: 0.5 }, [4, 12], null);
        expect(out).toHaveLength(2);
        expect(out).toEqual([
            sToPx({ pan: 0, pxPerM: 0.5 }, 4),
            sToPx({ pan: 0, pxPerM: 0.5 }, 12),
        ]);
    });
    test("no own points and no playhead yields an empty set (nothing to snap to)", () => {
        expect(trimTargets(v, [], null)).toEqual([]);
    });
});

describe("creationTargets — keyframe-creation landmark set", () => {
    // the verdict: double-click creation snaps through the drag resolver, but its target set
    // is the drag s-set MINUS force points (occupied s is degenerate) — origin, interior
    // boundaries, track end, and the parked playhead. no force point can enter (not a param).
    const v: View = { pan: 0, pxPerM: 10 };

    test("origin, interior boundaries, track end, and the parked playhead", () => {
        expect(creationTargets(v, [10, 20], 30, 15)).toEqual([
            sToPx(v, 0),
            sToPx(v, 10),
            sToPx(v, 20),
            sToPx(v, 30),
            sToPx(v, 15),
        ]);
    });
    test("drops the playhead while playing / unset", () => {
        expect(creationTargets(v, [10, 20], 30, null)).toEqual([
            sToPx(v, 0),
            sToPx(v, 10),
            sToPx(v, 20),
            sToPx(v, 30),
        ]);
    });
    test("origin + track end even with no interior boundaries (a single section)", () => {
        expect(creationTargets(v, [], 24, null)).toEqual([sToPx(v, 0), sToPx(v, 24)]);
    });
});

describe("clampDelta — the rigid group Δs clamp (AE comp-start block)", () => {
    test("a single member degenerates to today's clamp(s + Δs, 0, len)", () => {
        const m = [{ s: 5, len: 10 }]; // its own Δs range is [−5, 5]
        expect(clampDelta(m, 3)).toBe(3); // 5 + 3 = 8, in [0, 10]
        expect(clampDelta(m, 8)).toBe(5); // upper: len − s = 5
        expect(clampDelta(m, -8)).toBe(-5); // lower: −s = −5
        expect(clampDelta(m, 0)).toBe(0);
    });

    test("the tightest member binds the whole group — both bounds", () => {
        // A wide [−5, 5]; B binds the LOWER at −1; C binds the UPPER at +1 → intersection [−1, 1].
        const members = [
            { s: 5, len: 10 }, // Δs ∈ [−5, 5]
            { s: 1, len: 9 }, // Δs ∈ [−1, 8]  ← lower bound −1
            { s: 3, len: 4 }, // Δs ∈ [−3, 1]  ← upper bound 1
        ];
        expect(clampDelta(members, 4)).toBe(1); // upper: C's len − s
        expect(clampDelta(members, -4)).toBe(-1); // lower: B's −s
        expect(clampDelta(members, 0.5)).toBe(0.5); // inside the range → unchanged
    });

    test("0 is always allowed — the start is never clamped away", () => {
        const members = [
            { s: 0, len: 3 }, // pinned at its low edge — can't go down
            { s: 3, len: 3 }, // pinned at its high edge — can't go up
        ];
        expect(clampDelta(members, 0)).toBe(0);
        expect(clampDelta(members, 1)).toBe(0);
        expect(clampDelta(members, -1)).toBe(0);
    });

    test("preserves relative offsets: every member shifts by the SAME clamped Δs", () => {
        const members = [
            { s: 2, len: 10 },
            { s: 6, len: 10 },
        ];
        const ds = clampDelta(members, 3); // both far from bounds → 3
        expect(ds).toBe(3);
        const moved = members.map((m) => m.s + ds);
        expect(moved[1] - moved[0]).toBe(members[1].s - members[0].s); // gap unchanged
    });

    test("an out-of-extent member (s > len) is excluded from the binding set — no drag at rest", () => {
        // orphan: a section shortened under a keyframe leaves s past len (setSectionLength keeps s).
        // its own interval [−s, len − s] is empty and would drag the block leftward — it's excluded.
        const members = [
            { s: 5, len: 3 }, // s > len — out of extent (orphan)
            { s: 1, len: 10 }, // in extent, own range [−1, 9]
        ];
        expect(clampDelta(members, 0)).toBe(0); // AT REST: no drag (the orphan must not pull siblings)
        expect(clampDelta(members, 2)).toBe(2); // a positive drag moves the in-bounds member normally
        expect(clampDelta(members, -5)).toBe(-1); // only the in-bounds member binds (its own −s)
    });

    test("every member out of extent → empty binding set, Δs passes through (outer clamp bounds writes)", () => {
        const members = [
            { s: 5, len: 3 },
            { s: 8, len: 4 },
        ];
        expect(clampDelta(members, 2)).toBe(2);
        expect(clampDelta(members, -2)).toBe(-2);
    });
});

describe("nudgeForces — arrow-nudge writes for the selected force set", () => {
    test("single-select rounds the ABSOLUTE result to the field grid (pre-multiselect semantics)", () => {
        // an off-grid s (1.007) nudged right by 0.1 re-quantizes onto the 0.1 grid; g rounds to 0.01.
        expect(nudgeForces([{ id: 1, s: 1.007, g: 2, len: 10 }], 0.1, 0)).toEqual([
            { id: 1, s: 1.1, g: 2 }, // 1.007 + 0.1 = 1.107 → round to 0.1 → 1.1
        ]);
        expect(nudgeForces([{ id: 1, s: 3, g: 1.007, len: 10 }], 0, 0.05)).toEqual([
            { id: 1, s: 3, g: 1.06 }, // 1.007 + 0.05 = 1.057 → round to 0.01 → 1.06
        ]);
    });

    test("multi: the clamp binds off the nudge grid — offsets preserved exactly, no member past its extent", () => {
        // B sits 0.05 from its upper bound (a non-grid amount); a +0.1 nudge must move the block by
        // exactly that 0.05 (the rigid clamp, applied LAST) — NOT a rounded 0.1 that clamps B alone.
        const members = [
            { id: 1, s: 2, g: 1, len: 10 },
            { id: 2, s: 9.95, g: 1, len: 10 },
        ];
        const w = nudgeForces(members, 0.1, 0);
        expect(w[0].s).toBeCloseTo(2.05, 10); // A rode the clamped 0.05
        expect(w[1].s).toBeCloseTo(10, 10); // B reached its extent, not past
        expect(w[1].s).toBeLessThanOrEqual(members[1].len); // hard [0, len] invariant holds
        expect(w[1].s - w[0].s).toBeCloseTo(members[1].s - members[0].s, 10); // offset preserved
    });
});
