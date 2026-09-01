import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Domain } from "../src/section";
import {
    arcToTime,
    clampDelta,
    clampView,
    creationTargets,
    dToU,
    dToUExtend,
    fmt,
    frameAll,
    G_GRID,
    type Mapping,
    marginArc,
    marginFloor,
    MAX_PX_PER_U,
    navDragView,
    navWindow,
    niceStep,
    nodeArc,
    nudgeKeyframes,
    pxToU,
    S_GRID,
    snap,
    snapAxis,
    SNAP_PX,
    stallClampU,
    uToPx,
    T_GRID,
    ticks,
    timeToArc,
    trimTargets,
    uToD,
    uToDExtend,
    type View,
    xGrow,
    yEase,
    yFit,
    type YFit,
    yGrow,
    zoomAt,
} from "../src/timeline";
import { V0 } from "../src/track";
import { keyframeRoom, setForcePoint, setStripKeyframe } from "../src/track";
import { State } from "@dylanebert/shallot";
import {
    BakeSystem,
    createForcePoint,
    createSection,
    createStrip,
    createStripKeyframe,
    createTrack,
    destroyStripKeyframe,
    SectionKind,
    sectionForces,
    stripKeyframes,
} from "../src/track";
import { deselectAll, editor, selectForce, selectStripKf } from "../src/editor";

// the distance-domain lead-out floor — most of these tests exercise the pure math over a
// generic axis unit, so they pass this in wherever `floor` used to default to `MARGIN_M`.
const M = marginFloor(Domain.Distance);

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

describe("uToPx / pxToU — affine roundtrip", () => {
    const views: View[] = [
        { pan: 0, pxPerU: 100 },
        { pan: 250, pxPerU: 37.5 },
        { pan: -80, pxPerU: 1000 },
    ];
    test("pxToU ∘ uToPx is identity", () => {
        for (const v of views) {
            for (const t of [0, 0.5, 3.2, 12.75]) {
                expect(pxToU(v, uToPx(v, t))).toBeCloseTo(t, 9);
            }
        }
    });
    test("uToPx ∘ pxToU is identity", () => {
        for (const v of views) {
            for (const px of [0, 17, 480, 1000]) {
                expect(uToPx(v, pxToU(v, px))).toBeCloseTo(px, 9);
            }
        }
    });
});

describe("nodeArc — read-only geo node tick arclength", () => {
    // a 4-edge section, entry at sample 10, a uniform 2m/edge chord — the
    // partial-sum-of-ds shape a real bake produces for an evenly-spaced segment.
    const ds = Float32Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 2]); // edges 10..13
    const startSample = 10;

    test("sums ds from the section entry to the node's landing sample", () => {
        // node at sample 12 — 2 edges in, 2+2 = 4 m of local arc. the caller adds the
        // section's own span offset and projects the sum onto the chart's axis.
        expect(nodeArc(ds, startSample, 12)).toBeCloseTo(4, 9);
    });

    test("a node landing on the entry sample (order 0) sums to zero — sits at the span offset", () => {
        expect(nodeArc(ds, startSample, startSample)).toBe(0);
    });

    test("single-segment section: no interior node exists, but the degenerate 2-sample span still resolves at its two ends", () => {
        // a 2-node section (one edge, samples [startSample, startSample+1]) has no
        // interior order to tick — the caller skips it — but the math itself must not
        // blow up on the narrowest possible range.
        const oneEdge = Float32Array.from([3]);
        expect(nodeArc(oneEdge, 0, 0)).toBe(0);
        expect(nodeArc(oneEdge, 0, 1)).toBeCloseTo(3, 9);
    });

    test("degenerate ds (zero-length / near-coincident edges) contribute nothing to the sum", () => {
        expect(nodeArc(Float32Array.from([0, 0, 0]), 0, 3)).toBe(0);
    });

    test("an empty range (sample <= startSample) never reads past the array — sums to zero", () => {
        expect(nodeArc(ds, startSample, startSample - 1)).toBe(0);
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
        expect(marginArc(10, M)).toBe(50);
        expect(marginArc(0, M)).toBe(50);
    });
    test("long tracks keep the proportional lead-out past the floor", () => {
        expect(marginArc(1000, M)).toBeCloseTo(120, 9);
    });
});

describe("clampView — pan clamp, no forced zoom", () => {
    const W = 1000;
    const T = 10;
    // the x-axis is a DOCUMENT axis: clampView clamps pan but NEVER forces a zoom. it used
    // to floor pxPerU at the whole-track fit; that made a content edit rescale the ruler.
    test("a zoomed-OUT view is left as-is (no min-scale floor)", () => {
        const fit = W / (T + marginArc(T, M)); // the padded fit scale, for reference
        expect(clampView({ pan: 0, pxPerU: fit / 2 }, W, T, M).pxPerU).toBeCloseTo(fit / 2, 9);
        expect(clampView({ pan: 0, pxPerU: 1 }, W, T, M).pxPerU).toBe(1);
    });
    test("zoom-in is still capped at MAX_PX_PER_U", () => {
        expect(clampView({ pan: 0, pxPerU: MAX_PX_PER_U * 3 }, W, T, M).pxPerU).toBe(MAX_PX_PER_U);
    });
    test("shrinking the track leaves pxPerU and the visible window unchanged", () => {
        // the no-rescale-on-shrink law: a content edit that shortens the track (here 20m →
        // 8m, while still overflowing the zoomed-in view) never rescales the ruler and never
        // repans the window — the author keeps looking at exactly the same [2, 7]m.
        const v: View = { pan: 400, pxPerU: 200 }; // shows [2, 7]m
        const long = clampView(v, W, 20, M);
        const short = clampView(v, W, 8, M);
        expect(short.pxPerU).toBe(long.pxPerU); // no rescale
        expect(pxToU(short, 0)).toBeCloseTo(pxToU(long, 0), 9); // window held
        expect(pxToU(short, W)).toBeCloseTo(pxToU(long, W), 9);
    });
    test("frameAll frames [0, sTotal+padding] exactly, left anchored (any length)", () => {
        const Tlong = 200;
        const m = marginArc(Tlong, M);
        const v = frameAll(W, Tlong, M);
        expect(pxToU(v, 0)).toBeCloseTo(0, 6); // no negative distance before launch
        expect(pxToU(v, W)).toBeCloseTo(Tlong + m, 6);
    });
    test("frameAll frames a short track at sTotal+padding, not a floor span", () => {
        // the always-padded axis: the addressable span is ALWAYS sTotal + padding (the same
        // proportional lead-out at every length), so a short track frames [0, sTotal+padding]
        // — a tiny window, not the old arbitrary min-span floor snap.
        const Tshort = 4;
        const m = marginArc(Tshort, M); // the same padding definition, floored at MARGIN_M
        const v = frameAll(W, Tshort, M);
        expect(v.pxPerU).toBeCloseTo(W / (Tshort + m), 9);
        expect(v.pan).toBe(0); // left-anchored at the launch
        expect(pxToU(v, 0)).toBeCloseTo(0, 6);
        expect(pxToU(v, W)).toBeCloseTo(Tshort + m, 6); // the window spans exactly the padded track
    });
    test("pan never reveals distance before the launch (s=0) or past the lead-out", () => {
        const m = marginArc(T, M);
        const zoomed: View = { pan: 1e6, pxPerU: 400 }; // pan way past the right edge
        const c = clampView(zoomed, W, T, M);
        expect(pxToU(c, 0)).toBeGreaterThanOrEqual(-1e-6); // left can't cross 0
        expect(pxToU(c, W)).toBeLessThanOrEqual(T + m + 1e-6);
        // panning hard left holds at s=0, not negative
        const left = clampView({ pan: -1e6, pxPerU: 400 }, W, T, M);
        expect(pxToU(left, 0)).toBeCloseTo(0, 6);
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
        const v = frameAll(W, Tlong, M); // fitted, content fills the width
        const anchor = W / 2;
        const before = pxToU(v, anchor);
        const z = zoomAt(v, anchor, 2, W, Tlong, M);
        expect(z.pxPerU).toBeGreaterThan(v.pxPerU);
        expect(pxToU(z, anchor)).toBeCloseTo(before, 6);
    });
    test("zoom-out from a zoomed-in view returns toward the fit", () => {
        // frameAll frames the padded span [0, sTotal+padding] and a zoom-out floors right back
        // to that scale — for any track length now that the axis is always padded.
        const Tlong = 200;
        const fitted = frameAll(W, Tlong, M);
        const inView = zoomAt(fitted, W / 2, 4, W, Tlong, M);
        const out = zoomAt(inView, W / 2, 0.001, W, Tlong, M); // clamps to the fit scale
        expect(out.pxPerU).toBeCloseTo(fitted.pxPerU, 6);
    });
    test("zoom-out from a below-fit view stays put (never snaps UP to the fit)", () => {
        // after a content shrink the view can sit BELOW the padded framing fit. a wheel
        // zoom-out from there must NOT floor the scale up to the fit — that was the
        // inversion bug: a zoom-OUT tick pushing the scale IN. the floor is min(current,
        // fit), so a zoom-out below fit is a no-op instead. `fit` is the padded framing
        // scale (frameAll's), the same floor a zoom-out returns to.
        const fit = frameAll(W, T, M).pxPerU; // the padded fit scale
        const belowFit: View = { pan: 0, pxPerU: fit / 2 };
        const out = zoomAt(belowFit, W / 2, 0.5, W, T, M); // zoom OUT further
        expect(out.pxPerU).toBeCloseTo(belowFit.pxPerU, 9); // held, not snapped up
        expect(out.pxPerU).toBeLessThan(fit); // stays below fit
    });
    test("zoom-out returns to the padded initial framing on a short track", () => {
        // the zoom floor incorporates the padding: zoom in on a short track, then zoom back
        // out — the floor is the padded framing scale, so the visible span returns to exactly
        // sTotal + padding (the initial frame), not the tighter bare-content extent.
        const Tshort = 8;
        const padded = Tshort + marginArc(Tshort, M);
        const framed = frameAll(W, Tshort, M);
        const zoomedIn = zoomAt(framed, W / 2, 4, W, Tshort, M);
        expect(zoomedIn.pxPerU).toBeGreaterThan(framed.pxPerU);
        const out = zoomAt(zoomedIn, W / 2, 0.001, W, Tshort, M); // floor
        expect(out.pxPerU).toBeCloseTo(framed.pxPerU, 6);
        // the padded window is reachable again — the visible span is the padded frame.
        expect(pxToU(out, W) - pxToU(out, 0)).toBeCloseTo(padded, 4);
    });
});

describe("navWindow — overview bracket fractions", () => {
    const W = 1000;
    const T = 10; // total = T + margin = 60
    test("the fitted view fills the whole bar", () => {
        const fitted = frameAll(W, T, M);
        const win = navWindow(fitted, W, T, M);
        expect(win.l).toBeCloseTo(0, 6);
        expect(win.r).toBeCloseTo(1, 6);
    });
    test("a zoomed-in view is a sub-span", () => {
        const zoomed: View = clampView({ pan: 2 * (W / 3), pxPerU: W / 3 }, W, T, M); // shows [2,5]m
        const win = navWindow(zoomed, W, T, M);
        const total = T + marginArc(T, M);
        expect(win.l).toBeCloseTo(2 / total, 6);
        expect(win.r).toBeCloseTo(5 / total, 6);
    });
});

describe("navDragView — overview drag", () => {
    const W = 1000;
    const T = 10;
    const zoomed: View = clampView({ pan: 2 * (W / 3), pxPerU: W / 3 }, W, T, M); // shows [2,5]m
    test("pan slides the window and preserves the span", () => {
        const lo = pxToU(zoomed, 0);
        const out = navDragView(zoomed, W, T, "pan", lo + 1, 0, M); // grab=0 → newLo = cur
        expect(pxToU(out, 0)).toBeCloseTo(3, 6);
        expect(pxToU(out, W)).toBeCloseTo(6, 6);
        expect(out.pxPerU).toBeCloseTo(zoomed.pxPerU, 6); // zoom unchanged
    });
    test("left-edge drag anchors the right edge (a zoom)", () => {
        const out = navDragView(zoomed, W, T, "l", 1, 0, M); // pull left edge to 1m
        expect(pxToU(out, 0)).toBeCloseTo(1, 6);
        expect(pxToU(out, W)).toBeCloseTo(5, 6); // right edge held
    });
    test("right-edge drag anchors the left edge (a zoom)", () => {
        const out = navDragView(zoomed, W, T, "r", 8, 0, M); // push right edge to 8m
        expect(pxToU(out, 0)).toBeCloseTo(2, 6); // left edge held
        expect(pxToU(out, W)).toBeCloseTo(8, 6);
    });
    test("an edge can't cross the opposite one — span floors at the zoom ceiling", () => {
        const out = navDragView(zoomed, W, T, "r", 2, 0, M); // collapse right onto left (2m)
        expect(pxToU(out, W)).toBeGreaterThan(pxToU(out, 0)); // never inverts
        expect(out.pxPerU).toBeCloseTo(MAX_PX_PER_U, 6); // capped at max zoom-in
    });
});

describe("ticks — visible 1-2-5 grid", () => {
    test("ticks are step-spaced and cover the viewport", () => {
        const v: View = { pan: 0, pxPerU: 100 }; // 10m of track in 1000px → step ~ 1m
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
        expect(ticks({ pan: 0, pxPerU: 0 }, 1000)).toHaveLength(0);
        expect(ticks({ pan: 0, pxPerU: 100 }, 0)).toHaveLength(0);
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
    const view: View = { pan: 120, pxPerU: 10 };

    test("a cursor anywhere inside the chart leaves the view unchanged (grab is stable)", () => {
        expect(xGrow(view, (Left + Right) / 2, Left, Right, Rate)).toBe(view);
        expect(xGrow(view, Left, Left, Right, Rate)).toBe(view); // resting AT the left edge
        expect(xGrow(view, Right, Left, Right, Rate)).toBe(view); // resting AT the right edge
    });

    test("dragging past the right edge pans right (reveals more distance), zoom fixed", () => {
        const g = xGrow(view, Right + 30, Left, Right, Rate);
        expect(g.pan).toBeCloseTo(view.pan + 30 * Rate, 6);
        expect(g.pxPerU).toBe(view.pxPerU); // no zoom under the drag
    });

    test("further past the edge pans faster (speed ∝ overshoot)", () => {
        const shallow = xGrow(view, Right + 5, Left, Right, Rate);
        const deep = xGrow(view, Right + 50, Left, Right, Rate);
        expect(deep.pan - view.pan).toBeGreaterThan(shallow.pan - view.pan);
    });

    test("dragging past the left edge pans left but floors at pan 0 (no negative distance)", () => {
        const g = xGrow({ pan: 8, pxPerU: 10 }, Left - 40, Left, Right, Rate);
        expect(g.pan).toBe(0); // 8 − 40·0.4 < 0 → clamped to 0
        // already at 0 → unchanged by identity
        expect(xGrow({ pan: 0, pxPerU: 10 }, Left - 40, Left, Right, Rate)).toEqual({
            pan: 0,
            pxPerU: 10,
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

    // kex2d-geoforce-editor stage 5b: a realistic pool exactly like applyKeyframeDrag's `sTargets`/
    // `gTargets` composition — a section boundary (incl. the origin), another keyframe, the
    // parked playhead, and (on the g-axis) the 1g baseline — every value-landmark kind at once,
    // all within reach of the raw px. Under the bypass NONE may fire; only a start landmark that
    // is itself in range does.
    test("bypass disables every value-landmark kind at once — none fire, continuous passthrough", () => {
        const raw = 15; // off the S_GRID quantum
        const boundary0 = 15.5; // "section boundary" — within SNAP_PX
        const otherKeyframe = 14.4; // "another keyframe" — within SNAP_PX
        const playhead = 15.9; // "the parked playhead" — within SNAP_PX
        const pool = [boundary0, otherKeyframe, playhead];
        const startFarAway = 60; // the gesture-start magnet, deliberately out of reach
        const r = snapAxis(false, raw, raw, pool, S_GRID, id, startFarAway);
        expect(r.value).toBe(raw); // no landmark, no grid quantization
        expect(r.guide).toBeNull();
    });

    test("bypass keeps only the in-reach start magnet even with every other landmark kind competing", () => {
        const startVal = 15; // the gesture-start s/g — the one magnet that survives Ctrl/Cmd
        const raw = startVal + 3; // within SNAP_PX of the start, off the grid
        const boundary0 = raw - 1; // "section boundary" — also within SNAP_PX of raw
        const otherKeyframe = raw + 1; // "another keyframe" — closer to raw than the start
        const playhead = raw + 0.5; // "the parked playhead"
        const pool = [boundary0, otherKeyframe, playhead];
        const r = snapAxis(false, raw, raw, pool, S_GRID, id, startVal);
        expect(r.value).toBe(startVal); // the start magnet wins — it's the only candidate at all
        expect(r.guide).toBe(startVal);
    });

    test("active mode: the grid is disabled the instant a value landmark of ANY kind is in reach", () => {
        // the 1g baseline reads through gTargets as a plain numeric landmark like any other —
        // snapAxis treats every value landmark uniformly, so a landmark planted at the baseline's
        // px proves the same path the "other keyframe"/"playhead"/"boundary" cases above cover.
        const baseline = 0; // stand-in for the baseline's resolved px
        const r = snapAxis(true, baseline + 2, baseline + 2, [baseline], G_GRID, id, null);
        expect(r.value).toBe(baseline); // the landmark wins over the G_GRID round
        expect(r.guide).toBe(baseline);
    });
});

describe("trimTargets — extent-trim landmark set", () => {
    // the feel-check-in verdict: the extent trim snaps to content landmarks only — the
    // section's own force points and the parked playhead — never to ruler ticks. the set
    // membership IS the behavior; the projection is `uToPx` (tested above).
    const v: View = { pan: 0, pxPerU: 10 }; // 10px per meter, no pan

    test("own force points and the playhead, each projected to px", () => {
        const out = trimTargets(v, [4, 12], 8);
        expect(out).toEqual([uToPx(v, 4), uToPx(v, 12), uToPx(v, 8)]);
    });
    test("only own points when the playhead is absent (playing / unset)", () => {
        // no ruler tick sneaks in even at a wide zoom-out where ticks would be dense:
        // the set is exactly the section's own points, nothing else.
        const out = trimTargets({ pan: 0, pxPerU: 0.5 }, [4, 12], null);
        expect(out).toHaveLength(2);
        expect(out).toEqual([
            uToPx({ pan: 0, pxPerU: 0.5 }, 4),
            uToPx({ pan: 0, pxPerU: 0.5 }, 12),
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
    const v: View = { pan: 0, pxPerU: 10 };

    test("origin, interior boundaries, track end, and the parked playhead", () => {
        expect(creationTargets(v, [10, 20], 30, 15)).toEqual([
            uToPx(v, 0),
            uToPx(v, 10),
            uToPx(v, 20),
            uToPx(v, 30),
            uToPx(v, 15),
        ]);
    });
    test("drops the playhead while playing / unset", () => {
        expect(creationTargets(v, [10, 20], 30, null)).toEqual([
            uToPx(v, 0),
            uToPx(v, 10),
            uToPx(v, 20),
            uToPx(v, 30),
        ]);
    });
    test("origin + track end even with no interior boundaries (a single section)", () => {
        expect(creationTargets(v, [], 24, null)).toEqual([uToPx(v, 0), uToPx(v, 24)]);
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

describe("nudgeKeyframes — arrow-nudge writes for the selected keyframe set (force and strip kinds)", () => {
    test("single-select rounds the ABSOLUTE result to the field grid (pre-multiselect semantics)", () => {
        // an off-grid s (1.007) nudged right by 0.1 re-quantizes onto the 0.1 grid; v rounds to 0.01.
        expect(nudgeKeyframes([{ id: 1, s: 1.007, v: 2, len: 10 }], 0.1, 0)).toEqual([
            { id: 1, s: 1.1, v: 2 }, // 1.007 + 0.1 = 1.107 → round to 0.1 → 1.1
        ]);
        expect(nudgeKeyframes([{ id: 1, s: 3, v: 1.007, len: 10 }], 0, 0.05)).toEqual([
            { id: 1, s: 3, v: 1.06 }, // 1.007 + 0.05 = 1.057 → round to 0.01 → 1.06
        ]);
    });

    test("multi: the clamp binds off the nudge grid — offsets preserved exactly, no member past its extent", () => {
        // B sits 0.05 from its upper bound (a non-grid amount); a +0.1 nudge must move the block by
        // exactly that 0.05 (the rigid clamp, applied LAST) — NOT a rounded 0.1 that clamps B alone.
        const members = [
            { id: 1, s: 2, v: 1, len: 10 },
            { id: 2, s: 9.95, v: 1, len: 10 },
        ];
        const w = nudgeKeyframes(members, 0.1, 0);
        expect(w[0].s).toBeCloseTo(2.05, 10); // A rode the clamped 0.05
        expect(w[1].s).toBeCloseTo(10, 10); // B reached its extent, not past
        expect(w[1].s).toBeLessThanOrEqual(members[1].len); // hard [0, len] invariant holds
        expect(w[1].s - w[0].s).toBeCloseTo(members[1].s - members[0].s, 10); // offset preserved
    });
});

describe("dToU / uToD — arclength → chart-axis projection", () => {
    // the same non-uniform monotone table as the timeToArc/arcToTime suite above (speed
    // varies, so equal arcs don't cover equal times).
    const m: Mapping = {
        arc: Float64Array.from([0, 1, 3, 6, 10]),
        t: Float64Array.from([0, 0.5, 1, 2, 4]),
        n: 5,
    };
    // a stalled/v-floor bake: arc plateaus (2, 2, 2) while time keeps advancing.
    const stalled: Mapping = {
        arc: Float64Array.from([0, 2, 2, 2, 5]),
        t: Float64Array.from([0, 1, 2, 3, 5]),
        n: 5,
    };

    test("the Distance domain is the identity, mapping or not", () => {
        for (const mapping of [m, null]) {
            for (const d of [0, 2.5, 7, 10]) {
                expect(dToU(mapping, Domain.Distance, d)).toBe(d);
                expect(uToD(mapping, Domain.Distance, d)).toBe(d);
            }
        }
    });

    test("the Time domain roundtrips at the sample knots", () => {
        for (let i = 0; i < m.n; i++) {
            expect(dToU(m, Domain.Time, m.arc[i])).toBeCloseTo(m.t[i], 9);
            expect(uToD(m, Domain.Time, m.t[i])).toBeCloseTo(m.arc[i], 9);
        }
    });

    test("the Time domain projects through the live arc↔time table between knots", () => {
        expect(dToU(m, Domain.Time, 4.5)).toBeCloseTo(1.5, 9);
        expect(uToD(m, Domain.Time, 1.5)).toBeCloseTo(4.5, 9);
    });

    test("no-bake fallback: a null mapping reads Distance (identity) even when Time is requested", () => {
        for (const d of [0, 3, 42]) {
            expect(dToU(null, Domain.Time, d)).toBe(d);
            expect(uToD(null, Domain.Time, d)).toBe(d);
        }
    });

    test("a stall plateau resolves to the last tied index — deterministic, not a divide-by-zero", () => {
        // arc=2 is a whole plateau of tied samples (t=1,2,3); the tie resolves to the LAST
        // tied index (t=3) — matching `interpMono`'s `span <= 0` branch, and its inverse
        // (t=3 read back through uToD) resolves to that same representative arc=2.
        expect(dToU(stalled, Domain.Time, 2)).toBe(3);
        expect(uToD(stalled, Domain.Time, 3)).toBe(2);
        // a distance query approaching the tied arc value from either side stays on the
        // plateau's own time span — the tie never leaks into a neighboring segment.
        expect(dToU(stalled, Domain.Time, 1.999999)).toBeCloseTo(1, 4);
        expect(dToU(stalled, Domain.Time, 2.000001)).toBeGreaterThanOrEqual(3);
    });
});

describe("uToDExtend — the extent trim's extrapolation past the bake's own end", () => {
    const m: Mapping = {
        arc: Float64Array.from([0, 1, 3, 6, 10]),
        t: Float64Array.from([0, 0.5, 1, 2, 4]),
        n: 5,
    };

    test("within the bake's covered range it is uToD exactly, at any vExit", () => {
        for (const u of [0, 0.5, 1.5, 4]) {
            expect(uToDExtend(m, Domain.Time, u, 3)).toBeCloseTo(uToD(m, Domain.Time, u), 9);
            expect(uToDExtend(m, Domain.Time, u, 30)).toBeCloseTo(uToD(m, Domain.Time, u), 9);
        }
    });

    test("past the last finite t, arclength advances at vExit — s_end + v_exit·Δt", () => {
        // t_end = 4, arc_end = 10; 1.5 s past the end at vExit = 4 m/s lands at 10 + 6 = 16.
        expect(uToDExtend(m, Domain.Time, 5.5, 4)).toBeCloseTo(16, 9);
        // right at the knot the two formulas agree (Δt = 0).
        expect(uToDExtend(m, Domain.Time, 4, 4)).toBeCloseTo(10, 9);
    });

    test("clamped uToD would instead pin to arc_end — the defect this function exists to fix", () => {
        expect(uToD(m, Domain.Time, 5.5)).toBeCloseTo(10, 9); // the clamp, NOT the extrapolation
        expect(uToDExtend(m, Domain.Time, 5.5, 4)).not.toBeCloseTo(10, 1);
    });

    test("Distance is the identity, mapping or vExit notwithstanding", () => {
        for (const mapping of [m, null]) {
            expect(uToDExtend(mapping, Domain.Distance, 42, 4)).toBe(42);
        }
    });

    test("no-bake fallback reads Distance (identity) even when Time is requested", () => {
        expect(uToDExtend(null, Domain.Time, 42, 4)).toBe(42);
    });

    test("a near-zero vExit still extrapolates finite -- the caller's job to floor it, not this function's", () => {
        expect(uToDExtend(m, Domain.Time, 5, 0)).toBeCloseTo(10, 9);
    });
});

// finding 9 (kex2d-event-lane S1): a force-section lengthen not visualizing in Time view. The
// architectural pass's suspected mechanism, CONFIRMED by this witness: `Timeline.svelte`'s clip
// strip drew its right edge through the plain `dToU` (`uOf`) while a lengthen gesture's WRITE
// (`applyLen`) went through the extrapolating `uToDExtend` — so once the gesture's frozen table
// can no longer realize the growing authored extent (past `mapping.t[n-1]`), the write keeps
// landing further out (`Section.length` genuinely grows) while `dToU`'s own clamp pins the SAME
// frozen table's projection at its last sample forever: the store advances, the pixel doesn't,
// for the gesture's entire remaining duration (not just one frame — the freeze holds until
// `gestureMapping` releases at gesture end and a fresh bake runs). Landed law, replacing the
// story's own working title ("the drawn extent is the bake's, the authored extent is the
// store's"): an in-flight extend's reader owes the SAME extrapolating projection its writer
// used — `dToUExtend` is `uToDExtend`'s exact inverse — so store and draw never diverge for the
// gesture's own duration; outside a gesture (no growing table underfoot) `dToUExtend` coincides
// with plain `dToU` exactly, since `d` never exceeds the live bake's own arc range there.
describe("dToUExtend — the drawn edge's own extrapolating projection (finding 9 witness + fix)", () => {
    const m: Mapping = {
        arc: Float64Array.from([0, 1, 3, 6, 10]),
        t: Float64Array.from([0, 0.5, 1, 2, 4]),
        n: 5,
    };
    const vExit = 4;

    test("witness: a store that keeps growing past the frozen table's end draws STATIC through plain dToU", () => {
        // the write side, exactly as `applyLen` computes it: a cursor held at three increasing
        // chart positions past the frozen table's own end (u=4) lands at three DISTINCT,
        // increasing authored extents -- the store genuinely advances.
        const d1 = uToDExtend(m, Domain.Time, 4.5, vExit);
        const d2 = uToDExtend(m, Domain.Time, 5.5, vExit);
        const d3 = uToDExtend(m, Domain.Time, 6.5, vExit);
        expect(d2).toBeGreaterThan(d1);
        expect(d3).toBeGreaterThan(d2);
        // the pre-fix reader (plain dToU, what `clips`' u1 used to compute): all three land on
        // the SAME clamped pixel -- the invisible lengthen, reproduced.
        expect(dToU(m, Domain.Time, d1)).toBeCloseTo(4, 9);
        expect(dToU(m, Domain.Time, d2)).toBeCloseTo(4, 9);
        expect(dToU(m, Domain.Time, d3)).toBeCloseTo(4, 9);
    });

    test("the fix: dToUExtend recovers three DISTINCT, increasing chart positions for the same three stores", () => {
        const d1 = uToDExtend(m, Domain.Time, 4.5, vExit);
        const d2 = uToDExtend(m, Domain.Time, 5.5, vExit);
        const d3 = uToDExtend(m, Domain.Time, 6.5, vExit);
        const u1 = dToUExtend(m, Domain.Time, d1, vExit);
        const u2 = dToUExtend(m, Domain.Time, d2, vExit);
        const u3 = dToUExtend(m, Domain.Time, d3, vExit);
        expect(u2).toBeGreaterThan(u1);
        expect(u3).toBeGreaterThan(u2);
        expect(u1).toBeCloseTo(4.5, 9);
        expect(u2).toBeCloseTo(5.5, 9);
        expect(u3).toBeCloseTo(6.5, 9);
    });

    test("law: dToUExtend is uToDExtend's exact inverse, both directions, past the bake's end", () => {
        for (const u of [4, 4.5, 6, 20]) {
            const d = uToDExtend(m, Domain.Time, u, vExit);
            expect(dToUExtend(m, Domain.Time, d, vExit)).toBeCloseTo(u, 9);
        }
        for (const d of [10, 12, 16, 40]) {
            const u = dToUExtend(m, Domain.Time, d, vExit);
            expect(uToDExtend(m, Domain.Time, u, vExit)).toBeCloseTo(d, 9);
        }
    });

    test("within the bake's covered range it is dToU exactly, at any vExit — no gesture in flight", () => {
        for (const d of [0, 1, 3, 6, 10]) {
            expect(dToUExtend(m, Domain.Time, d, 3)).toBeCloseTo(dToU(m, Domain.Time, d), 9);
            expect(dToUExtend(m, Domain.Time, d, 30)).toBeCloseTo(dToU(m, Domain.Time, d), 9);
        }
    });

    test("Distance is the identity, mapping or vExit notwithstanding", () => {
        for (const mapping of [m, null]) {
            expect(dToUExtend(mapping, Domain.Distance, 42, 4)).toBe(42);
        }
    });

    test("no-bake fallback reads Distance (identity) even when Time is requested", () => {
        expect(dToUExtend(null, Domain.Time, 42, 4)).toBe(42);
    });
});

describe("T_GRID — the time domain's snap quantum", () => {
    test("derived as S_GRID / V0, not a separately-tuned constant", () => {
        expect(T_GRID).toBeCloseTo(S_GRID / V0, 12);
    });
});

describe("ticks — domain-aware readout suffix, same grid either way", () => {
    const v: View = { pan: 0, pxPerU: 100 };

    test("the Distance domain (default) prints the meter suffix", () => {
        const t = ticks(v, 1000);
        expect(t.length).toBeGreaterThan(0);
        for (const tick of t) expect(tick.label.endsWith("m")).toBe(true);
    });

    test("the Time domain prints the second suffix, same tick positions", () => {
        const dist = ticks(v, 1000, Domain.Distance);
        const time = ticks(v, 1000, Domain.Time);
        expect(time.length).toBe(dist.length);
        for (let i = 0; i < time.length; i++) {
            expect(time[i].label.endsWith("s")).toBe(true);
            expect(time[i].px).toBeCloseTo(dist[i].px, 9); // the suffix is the ONLY branch
            expect(time[i].s).toBeCloseTo(dist[i].s, 9);
        }
    });
});

describe("marginFloor — the lead-out floor in the active domain", () => {
    test("Distance is the 50 m absolute lead-out; Time is its twin at V0", () => {
        expect(marginFloor(Domain.Distance)).toBe(marginArc(0, M)); // the floor dominates at total 0
        expect(marginFloor(Domain.Time)).toBeCloseTo(marginFloor(Domain.Distance) / V0, 12);
    });

    test("a short ride frames the same PROPORTION of lead-out in either domain", () => {
        // 100 m at V0 is 10 s: both are floor-dominated, and the floor is the same ride length,
        // so the framed window covers the same stretch of track either way.
        const span = (total: number, d: Domain): number => total + marginArc(total, marginFloor(d));
        expect(span(10, Domain.Time) / 10).toBeCloseTo(span(100, Domain.Distance) / 100, 9);
    });

    test("the floor is the ONLY dimensional input: the proportional branch is unit-free", () => {
        // past the floor's reach the 12% fraction takes over and the domain stops mattering.
        expect(marginArc(1000, marginFloor(Domain.Distance))).toBeCloseTo(120, 9);
        expect(marginArc(1000, marginFloor(Domain.Time))).toBeCloseTo(120, 9);
    });

    test("threaded through every view op: the lead-out a frame includes follows the floor", () => {
        const w = 500;
        const fitD = frameAll(w, 10, marginFloor(Domain.Distance)); // 10 + 50 m of span
        const fitT = frameAll(w, 10, marginFloor(Domain.Time)); // 10 + 5 s of span
        expect(pxToU(fitD, w)).toBeCloseTo(60, 6);
        expect(pxToU(fitT, w)).toBeCloseTo(15, 6);
        // and the pan clamp agrees with the frame it produced (the right edge is reachable, no more)
        expect(
            clampView({ pan: 1e6, pxPerU: fitT.pxPerU }, w, 10, marginFloor(Domain.Time)).pan,
        ).toBeCloseTo(0, 6);
    });
});

describe("stallClampU — the Time lens never stretches toward t→∞ past a stall (S2, finding 13)", () => {
    test("Time domain, a stall present: clamps to the stall's own time plus the SAME lead-out floor every other axis reuses", () => {
        // a ballooning raw reading (a long crawl-through tail at the velocity floor) — this is
        // exactly what the person's own read named: the un-clamped `uOf(sTotal)` a caller would
        // otherwise pass in.
        const raw = 5000;
        const stallU = 12;
        const margin = marginFloor(Domain.Time);
        expect(stallClampU(raw, Domain.Time, stallU, margin)).toBeCloseTo(stallU + margin, 9);
    });

    test("the clamp only BINDS when the raw reading actually exceeds it — never widens a short reading", () => {
        const stallU = 12;
        const margin = marginFloor(Domain.Time);
        const shortRaw = stallU + margin - 1; // already inside the bound
        expect(stallClampU(shortRaw, Domain.Time, stallU, margin)).toBe(shortRaw);
    });

    test("Distance domain passes uTotal through unclamped — a stall's arclength position never bounds arclength itself", () => {
        expect(stallClampU(5000, Domain.Distance, 12, marginFloor(Domain.Time))).toBe(5000);
    });

    test("no stall (stallU null): the full reading passes through in either domain — nothing to bound", () => {
        expect(stallClampU(5000, Domain.Time, null, marginFloor(Domain.Time))).toBe(5000);
        expect(stallClampU(5000, Domain.Distance, null, marginFloor(Domain.Time))).toBe(5000);
    });
});

// S2 (kex2d-event-substrate): strips are track-global and section-blind (Locked decision),
// so the band's own clamp domain is no longer any one section's extent (`Clip.extent`,
// kex2d-event-lane S3's fix for the section-owned model) — it's the TRACK's own live extent,
// derived once (`trackLen`) and threaded through every strip the same way (`BandStrip.len`),
// never re-derived per section or per strip. Source-text arm, `colors.test.ts`'s own idiom for
// a Svelte-only surface with no unit-testable runtime seam: the real invariant (the bake clips
// a strip past the track's own extent, and a strip wholly past it is inert) is pinned in
// `track.test.ts` against `edgeStrips` directly.
describe("Timeline.svelte's strip band clamp reads ONE value for the track's own live extent (S2)", () => {
    test("trackLen derives the track's own live extent off the span table's last offset+len — the ONE place the clamp domain is computed", () => {
        const src = readFileSync(new URL("../src/Timeline.svelte", import.meta.url), "utf8");
        expect(src).toContain("function trackLen(spanTable: SectionSpan[]): number {");
    });

    test("computeBandStrips reads every strip's clamp domain straight off trackLen(spanTable), never re-deriving it per strip", () => {
        const src = readFileSync(new URL("../src/Timeline.svelte", import.meta.url), "utf8");
        expect(src).toContain("const len = trackLen(spanTable);");
    });
});

// kex2d-event-substrate S1: the behavior-parity oracle (Validation's locked standard).
// For each of the five behaviors, one arm drives a force keyframe AND a strip keyframe through
// the SAME named function and asserts the SAME observable. The call path is the assertion —
// presence-matching of names is banned. Each previously-missing behavior was witnessed red
// first (the numbers recorded in the arm's docblock).
//
// The five behaviors: snap, deselect, modifier-extend (shift-click), overlap refusal, nudge.
// The shared functions: snapAxis (timeline.ts), selectStripKf (editor.ts), toggleMember
// (editor.ts), keyframeRoom (track.ts), nudgeKeyframes (timeline.ts).
describe("kex2d-event-substrate S1: behavior arms — both keyframe kinds ride one named path per behavior", () => {
    // ── snap ── both kinds resolve snapping through `snapAxis` (timeline.ts).
    // RED before fix: the strip keyframe drag (`stripKfMove`) never called `snapAxis` — a
    // strip keyframe dragged near a grid line or landmark passed through unsnapped. After the
    // fix, `applyKeyframeDrag` calls `snapAxis` for both kinds (kind-specific targets, same
    // function). The arm constructs a real force keyframe and a real strip keyframe and calls
    // `snapAxis` with the kind-specific landmark targets the production handler passes — the
    // force side snaps to a force-keyframe landmark, the strip side to a strip-keyframe landmark.
    // The capture harness (section.pw.ts "velocity strip keyframe drag origin flow") pins the
    // production call path through `applyKeyframeDrag`; this arm pins the shared function's
    // behavior with real ECS state and kind-specific inputs (not identical — the tautology shape
    // is banned).
    // Witnessed red: mutated `snapAxis` to return `{ value: rawVal, guide: null }` unconditionally
    // (no snap) → `forceSnap.value` was 9.7 not 10, `stripSnap.value` was 4.8 not 5 → exit 1.
    test("snap: `snapAxis` snaps a force keyframe to a force landmark and a strip keyframe to a strip landmark", () => {
        // force keyframe: grid 0.1, landmark at px 100 (another force keyframe's station), 10 px/unit
        const forceGrid = 0.1;
        const forceTargets = [100]; // px — a force-keyframe landmark
        const forceFromPx = (px: number) => px / 10;
        const forceSnap = snapAxis(true, 97, 9.7, forceTargets, forceGrid, forceFromPx, null);
        // snaps to the landmark at px 100 → val 10
        expect(forceSnap.value).toBe(10);
        expect(forceSnap.guide).toBe(100);

        // strip keyframe: grid 0.5, landmark at px 50 (another strip keyframe's station), 10 px/unit
        // — DIFFERENT grid and DIFFERENT landmark from the force side, so the arm is not a
        // tautology: if `snapAxis` stopped snapping, the force and strip results would diverge
        // from their respective expected values.
        const stripGrid = 0.5;
        const stripTargets = [50]; // px — a strip-keyframe landmark
        const stripFromPx = (px: number) => px / 10;
        const stripSnap = snapAxis(true, 47, 4.7, stripTargets, stripGrid, stripFromPx, null);
        // snaps to the landmark at px 50 → val 5
        expect(stripSnap.value).toBe(5);
        expect(stripSnap.guide).toBe(50);
    });

    // ── deselect ── both kinds deselect through `selectStripKf(null)` (editor.ts), the fix
    // added to `marqueeUp` (Timeline.svelte). The previous arm armed `deselectAll`, which
    // already cleared `stripKf` at base — removing the fix (the `selectStripKf(null)` call in
    // `marqueeUp`) did not red it. The repaired arm arms the actual fix function: set a strip
    // keyframe selection, call `selectStripKf(null)`, verify it clears. The capture harness
    // (section.pw.ts "strip keyframe deselect on empty chart click") pins the production call
    // path through `marqueeUp`.
    // Witnessed red: mutated `selectStripKf` to no-op when `id === null` (skip the
    // `setMember` call) → `editor.stripKf` stayed 7 → exit 1.
    test("deselect: `selectStripKf(null)` clears the strip keyframe selection (the `marqueeUp` fix)", () => {
        try {
            // set up a strip keyframe selection directly
            selectStripKf(7, "replace", 1);
            expect(editor.stripKf).toBe(7);
            // the actual fix: `marqueeUp` calls `selectStripKf(null)` to clear the sub-selection
            selectStripKf(null);
            expect(editor.stripKf).toBeNull();
            // the force side: `marqueeUp` also calls `selectForce(null)` — same observable
            selectForce(42);
            expect(editor.force).toBe(42);
            // `selectForce(null)` is the force-side twin (already existed at base)
            editor.force = null;
            expect(editor.force).toBeNull();
        } finally {
            // cleanup runs regardless of failure — the editor singleton is module-global
            deselectAll();
        }
    });

    // ── modifier-extend (shift-click) ── the fix is multi-member drag in `keyframeDown`
    // (Timeline.svelte): shift-click toggles into the set, then the drag moves ALL members
    // by one shared delta with offsets preserved (`clampDelta` + `nudgeKeyframes`). The
    // previous arm armed `toggleMember`, which already worked — removing the fix did not red
    // it. The repaired arm constructs a real multi-member set for both a force and a strip
    // keyframe and drives the shared delta through `clampDelta` + `nudgeKeyframes`, verifying
    // offsets are preserved for both kinds. The strip side passes `lo: start` (the strip’s
    // own lower bound, not 0) — the `lo` parameter was added to `clampDelta` in this branch.
    // The capture harness (section.pw.ts "strip keyframe multi-member drag") pins the
    // production call path through `keyframeDown`.
    // Witnessed red: mutated `clampDelta` to use `0` instead of `mLo` (revert the `lo` fix)
    // → strip member clamped to `s=0` instead of `s=start` → exit 1.
    test("modifier-extend: multi-member drag preserves offsets for both force and strip keyframe sets", () => {
        try {
            // force: two members at s=3 and s=7, len=10, lo=0 (force keyframes clamp to [0, len])
            const forceMembers = [
                { id: 1, s: 3, v: 1, len: 10, lo: 0 },
                { id: 2, s: 7, v: 1, len: 10, lo: 0 },
            ];
            // a +5 delta clamps to +3 (member at s=7 hits len=10)
            const forceResult = nudgeKeyframes(forceMembers, 5, 0);
            expect(forceResult[0].s).toBe(6); // 3 + 3
            expect(forceResult[1].s).toBe(10); // 7 + 3, clamped
            // offset preserved: both moved by the same delta (3)
            expect(forceResult[1].s - forceResult[0].s).toBe(4); // original offset 7-3=4

            // strip: two members at s=8 and s=12, len=15, lo=5 (strip keyframes clamp to [start, end])
            // — the `lo` parameter is the fix: strip keyframes have a non-zero lower bound (`start`).
            const stripMembers = [
                { id: 10, s: 8, v: 3, len: 15, lo: 5 },
                { id: 11, s: 12, v: 5, len: 15, lo: 5 },
            ];
            // a -5 delta clamps to -3 (member at s=8 hits lo=5)
            const stripResult = nudgeKeyframes(stripMembers, -5, 0);
            expect(stripResult[0].s).toBe(5); // 8 - 3, clamped to lo=5
            expect(stripResult[1].s).toBe(9); // 12 - 3
            // offset preserved: both moved by the same delta (-3)
            expect(stripResult[1].s - stripResult[0].s).toBe(4); // original offset 12-8=4
        } finally {
            // cleanup runs regardless of failure — the editor singleton is module-global
            deselectAll();
        }
    });

    // ── overlap refusal ── both kinds read directional room through `keyframeRoom` (track.ts,
    // S5b's Δd cap — the block-level drag mechanism this arm pins). The per-write exact-equality
    // guard `setForcePoint`/`setStripKeyframe` carry internally (`stationTaken`/
    // `stripKeyframeTaken`) is a SEPARATE, still-live safety net for a non-drag write (the typed
    // field) — a station a person types in can land bit-exact on purpose, unlike a drag's
    // continuous sampling, so that guard is asserted too, unchanged.
    // RED before the S5b fix: `keyframeRoom` did not exist — the block-level drag check called
    // `keyframeTaken`'s bit-exact equality test, unreachable once F2 deleted the extent clamp
    // that used to saturate a drag onto a boundary sibling's exact station.
    test("overlap refusal: `keyframeRoom` reads directional room for both force and strip kinds", () => {
        // force: two keyframes in one section at s=5 and s=10
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        const sec = createSection(state, 0, SectionKind.Force, 20);
        const f0 = createForcePoint(state, sec, 5, 1);
        createForcePoint(state, sec, 10, 1);
        state.step(0);
        // force: the room ahead of f0 (s=5) is 5 (the other key sits at s=10); nothing behind
        expect(keyframeRoom(state, "force", sec, 5, new Set([f0]), 1)).toBe(5);
        expect(keyframeRoom(state, "force", sec, 5, new Set([f0]), -1)).toBe(Infinity);
        // setForcePoint's own exact-equality guard: refuses the s write but lands the g
        setForcePoint(state, f0, 10, 2.5);
        const fRow = sectionForces(state, sec).find((r) => r.id === f0);
        expect(fRow?.s).toBe(5); // s held: overlap refused
        expect(fRow?.g).toBe(2.5); // g still landed

        // strip: two keyframes on one strip at s=8 and s=12
        const _sec2 = createSection(state, 1, SectionKind.Force, 20);
        const strip = createStrip(state, 5, 15, 8) as number;
        // createStrip seeds two keyframes at start/end; clear them for a clean setup
        const seeded = stripKeyframes(state, strip);
        for (const s of seeded) destroyStripKeyframe(state, s.id);
        // re-create with known positions
        const sk0 = createStripKeyframe(state, strip, 8, 3);
        createStripKeyframe(state, strip, 12, 5);
        state.step(0);
        // strip: the room ahead of sk0 (s=8) is 4 (the other key sits at s=12); nothing behind
        expect(keyframeRoom(state, "strip", strip, 8, new Set([sk0]), 1)).toBe(4);
        expect(keyframeRoom(state, "strip", strip, 8, new Set([sk0]), -1)).toBe(Infinity);
        // setStripKeyframe's own exact-equality guard: refuses the s write but lands the v
        setStripKeyframe(state, sk0, 12, 7);
        const skRow = stripKeyframes(state, strip).find((r) => r.id === sk0);
        expect(skRow?.s).toBe(8); // s held: overlap refused
        expect(skRow?.v).toBe(7); // v still landed
    });

    // ── nudge ── both kinds nudge through `nudgeKeyframes` (timeline.ts).
    // RED before fix: `nudgeForces` existed but was force-only (field name `g`, lower bound
    // hard-coded to 0); no strip keyframe nudge existed at all — the keyboard handler’s `return`
    // after the strip block blocked nudge from ever being reached. The fix renamed to
    // `nudgeKeyframes` and added the `lo` parameter so strip keyframes clamp to `[start, end]`
    // not `[0, end]`. The previous arm called `nudgeKeyframes` twice with byte-identical inputs
    // (a tautology) and its recorded red was a compile-time missing-export (disqualified per
    // `checks.md`). The repaired arm constructs a real force keyframe (lo=0) and a real strip
    // keyframe (lo=start=5) and nudges both by a delta that would cross the strip’s lower bound
    // — the strip side clamps to `lo`, the force side does not. The capture harness pins the
    // production call path through the keyboard handler.
    // Witnessed red: mutated `nudgeKeyframes` to use `0` instead of `lo` (revert the `lo` fix)
    // → strip member clamped to `s=0` instead of `s=5` → exit 1.
    test("nudge: `nudgeKeyframes` nudges a force keyframe (lo=0) and a strip keyframe (lo=start) by the same delta", () => {
        // force: s=1.007, v=2, len=10, lo=0 — nudge +0.1 rounds to grid → s=1.1
        const forceMembers = [{ id: 1, s: 1.007, v: 2, len: 10, lo: 0 }];
        const forceResult = nudgeKeyframes(forceMembers, 0.1, 0);
        expect(forceResult[0].s).toBe(1.1); // 1.007 + 0.1 → round to 0.1 → 1.1
        expect(forceResult[0].v).toBe(2);

        // strip: s=5.007, v=3, len=15, lo=5 (the strip’s start) — nudge -0.2 would cross lo=5,
        // so it clamps to 5 (the strip-specific lower bound the fix added)
        const stripMembers = [{ id: 10, s: 5.007, v: 3, len: 15, lo: 5 }];
        const stripResult = nudgeKeyframes(stripMembers, -0.2, 0);
        expect(stripResult[0].s).toBe(5); // clamped to lo=5, not 0
        expect(stripResult[0].v).toBe(3);

        // the force side with the same delta does NOT clamp to 5 (its lo=0), proving the
        // inputs are not identical — the arm is not a tautology
        const forceMembers2 = [{ id: 1, s: 5.007, v: 2, len: 15, lo: 0 }];
        const forceResult2 = nudgeKeyframes(forceMembers2, -0.2, 0);
        expect(forceResult2[0].s).toBe(4.8); // 5.007 - 0.2 → round to 0.1 → 4.8, no lo clamp
    });
});

// kex2d-event-lane S5 (Locked decision findings 7, 4/5/6, 2, 11-near). Source-text arms —
// `colors.test.ts`'s idiom for a Svelte-only claim with no unit-testable runtime seam; the real
// rendered pixels/cursor are the capture flow's own job (`affordance.pw.ts`).
describe("kex2d-event-lane S5: lane label retirement, default strip length, edge cursor, m/s unit (Validation's oracle)", () => {
    // finding 7 (S5) retired the "vel" lane label in favor of a general "events" label; S4,
    // finding 4 retires the LABEL ITSELF — the lane has no label at all, typing living entirely
    // on the item (the strip's own kind color below, and the "v" unit on its selected readout).
    // Both the old typed word and its S5 replacement must be gone.
    test('neither the retired "vel" lane label nor its S5 "events" replacement survives (S4)', () => {
        const src = readFileSync(new URL("../src/Timeline.svelte", import.meta.url), "utf8");
        expect(src).not.toContain('fillText("vel"');
        expect(src).not.toContain('fillText("events"');
    });

    // F3 (feel-gate round 1, person's verdict 2026-08-26): default created strip length shrinks
    // to ~10 m, an independent literal decoupled from EXTEND_DIST (`tests/track.test.ts`'s
    // `stripDefaultExtentAt` describe block is the behavioral pin — the readback through the
    // real creation path, never source presence); the summoned-creation path (`createStripAt`)
    // is what carries it, `canCreateAt` stays on the bare min extent (W7's own overlap gate,
    // unchanged by this stage).
    test("createStripAt authors the grown default extent, not the bare min extent", () => {
        const src = readFileSync(new URL("../src/Timeline.svelte", import.meta.url), "utf8");
        expect(src).toContain("function createStripAt(d: number): void {");
        expect(src).toContain("const extent = stripDefaultExtentAt(ecs, d);");
    });

    // finding 2: an edge hit zone names the trim with a cursor — kept ALONGSIDE the hover-rung
    // treatment (`bandHit`'s endpoint stroke), never instead of it. `colors.test.ts`'s cursor
    // allowlist is the registry gate for the declared class + value; this pins the reactive
    // binding that drives it off the same classifier the press path uses.
    test("the band's edge cursor is driven by the same bandHit classifier the press/hover paths use", () => {
        const src = readFileSync(new URL("../src/Timeline.svelte", import.meta.url), "utf8");
        expect(src).toContain('class:edge-hover={bandHit.kind === "endpoint"}');
        expect(src).toContain(".hbandzone.edge-hover {");
    });

    // finding 11, near half: a selected strip keyframe's velocity readout carries its unit —
    // the position field's own `.unit` span shape, matching `posUnit` two lines up. The far
    // half (a second unit axis) is out of scope — untouched here.
    test("the selected strip keyframe's v field carries the m/s unit", () => {
        const src = readFileSync(new URL("../src/Timeline.svelte", import.meta.url), "utf8");
        expect(src).toContain('aria-label="Keyframe velocity (m/s)"');
        expect(src).toContain('<span class="unit">m/s</span>');
    });
});

// S4, finding 5 (Locked decision): the old S3 arm pinned `STRIP_H == GAP_H` — the 20px
// CONTAINER band, never what actually painted. The segment clip the person sees renders at
// `GAP_H − 2·CLIP_PAD` = 16px; the strip fill drifted from it, drawing the full container
// height instead. The re-pin asserts the RENDERED rect quantity — one derived constant
// (`CLIP_H`) both the segment clip and the strip fill draw at — rather than a numeric equality
// between two container-band literals. Source-text arm, `colors.test.ts`'s own idiom for a
// Svelte-only numeric layout constant with no unit-testable runtime seam (the real rendered
// height is the capture flow's own job, `affordance.pw.ts`); `HBAND_H`'s harness mirror stays
// a CONTAINER-band constant (hit-test click targeting, unaffected by this stage) and is not
// re-pinned here.
describe("Timeline.svelte's velocity strip fill renders at the segment clip's own rect height, not the container band (S4, finding 5)", () => {
    test("CLIP_H derives from GAP_H and CLIP_PAD, not an independent literal", () => {
        const src = readFileSync(new URL("../src/Timeline.svelte", import.meta.url), "utf8");
        expect(src).toContain("const CLIP_H = GAP_H - 2 * CLIP_PAD;");
    });

    // the segment clip (`.clip` — the section marker lane) and the strip fill (the canvas-drawn
    // velocity strip) both draw at `CLIP_H`, never STRIP_H/GAP_H directly — one source of truth
    // for the rendered quantity, so either drifting independently reds this.
    test("the segment clip's SVG rect renders at CLIP_H", () => {
        const src = readFileSync(new URL("../src/Timeline.svelte", import.meta.url), "utf8");
        // the `.clip` rect block: from its own `class="clip …"` opening tag to its `/>` close —
        // sliced rather than pattern-spanned, so a reordered attribute list can't defeat the read.
        const start = src.indexOf('class="clip {isF');
        expect(start).toBeGreaterThan(-1);
        const block = src.slice(start, src.indexOf("/>", start));
        expect(block).toContain("height={CLIP_H}");
    });

    test("the strip fill's canvas fillRect renders at CLIP_H, inset CLIP_PAD from the band top", () => {
        const src = readFileSync(new URL("../src/Timeline.svelte", import.meta.url), "utf8");
        expect(src).toContain("ctx.fillRect(cx0, RULER_H + GAP_H + CLIP_PAD, cw, CLIP_H);");
    });

    // negative control: the strip fill's own draw call may not still be pinned against the
    // container band's full height (STRIP_H) — the old fill call this stage replaced. `STRIP_H`
    // legitimately survives elsewhere (the container band's own background fill, the hit-zone
    // rect, the one-shot glyph's vertical center), so this checks the specific call site rather
    // than the constant's absence from the file.
    test("the strip fill's draw call no longer renders at the container band's full STRIP_H", () => {
        const src = readFileSync(new URL("../src/Timeline.svelte", import.meta.url), "utf8");
        expect(src).not.toContain("ctx.fillRect(cx0, RULER_H + GAP_H, cw, STRIP_H);");
    });
});
