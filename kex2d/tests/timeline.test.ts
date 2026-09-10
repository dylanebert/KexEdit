import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { State } from "@dylanebert/shallot";
import { addRecord, beginEnd, commit, createHistory } from "../src/history";
import { Lane, type LaneSegment, type Lanes } from "../src/lanes";
import { Easing } from "../src/profile";
import { DEFAULT_ORDER } from "../src/projection";
import { Domain } from "../src/section";
import { BakeSystem, createTrack, endColumn, lanesOf, setEnd } from "../src/track";
import {
    arcToTime,
    authoredPolylines,
    bakeStations,
    chartY,
    clampSpanDrag,
    clampView,
    COLUMN_W,
    drivenSpans,
    dToU,
    dToUExtend,
    dragAxis,
    endDragTarget,
    endHandle,
    fmt,
    frameAll,
    G_GRID,
    fitLaneValue,
    hitEndHandle,
    hitRows,
    KNOT_PX,
    laneMembers,
    laneRows,
    laneValueAxis,
    type Mapping,
    marginArc,
    marginFloor,
    MAX_PX_PER_U,
    navDragView,
    navWindow,
    niceStep,
    nodeArc,
    knotPoints,
    nudgeQuantum,
    popoverFit,
    recoveredPolyline,
    recoveredAt,
    fitAttachedStatus,
    fitEditor,
    editorFits,
    reorderDrop,
    reordered,
    rowChart,
    spanResidual,
    ROW_GAP,
    ROW_H,
    pxToU,
    S_GRID,
    snap,
    snapAxis,
    SNAP_PX,
    spanBoxes,
    spanCurve,
    spanTargets,
    stallClampU,
    uToPx,
    T_GRID,
    ticks,
    timeToArc,
    trimTargets,
    uToD,
    uToDExtend,
    V_GRID,
    type View,
    xGrow,
    yEase,
    yFit,
    type YFit,
    yGrow,
    valueChart,
    zoomAt,
} from "../src/timeline";
import { V0 } from "../src/track";
import { snapSteps } from "../src/settings";

// the distance-domain lead-out floor — most of these tests exercise the pure math over a
// generic axis unit, so they pass this in wherever `floor` used to default to `MARGIN_M`.
const M = marginFloor(Domain.Distance);

describe("S3f handle arbitration and rigid pointer bounds", () => {
    test("all lanes: shared boundary picks preceding end, thin midpoint picks start", () => {
        for (const lane of [Lane.Geo, Lane.Force, Lane.Velocity]) {
            const record = (id: number, start: number, end: number): LaneSegment => ({
                id,
                start,
                end,
                entry: 1,
                exit: 1,
                ease: 0,
            });
            const records = [record(9, 0, 10), record(2, 10, 10.2)];
            const lanes: Lanes = { geo: [], force: [], velocity: [] };
            lanes[lane === Lane.Geo ? "geo" : lane === Lane.Force ? "force" : "velocity"] = records;
            const rows = laneRows(lanes, [lane], 0),
                v = { pan: 0, pxPerU: 10 };
            expect(hitRows(rows, v, 100, 10)).toEqual({ kind: "edge", lane, id: 9, which: "end" });
            expect(hitRows(rows, v, 100.5, 10)).toEqual({
                kind: "edge",
                lane,
                id: 2,
                which: "start",
            });
            expect(hitRows(rows, v, 101.5, 10)).toEqual({
                kind: "edge",
                lane,
                id: 2,
                which: "end",
            });
            expect(hitRows(rows, v, 50, 10)).toEqual({ kind: "body", lane, id: 9 });
        }
    });
    test("pin and origin clamp body rigidly; each edge holds the other station", () => {
        expect(clampSpanDrag("body", 18, 28, 20)).toEqual({ start: 10, end: 20 });
        expect(clampSpanDrag("body", -4, 6, 20)).toEqual({ start: 0, end: 10 });
        expect(clampSpanDrag("start", -5, 18, 20)).toEqual({ start: 0, end: 18 });
        expect(clampSpanDrag("end", 4, 28, 20)).toEqual({ start: 4, end: 20 });
    });
});

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
});

// ── S3 item 1: the lane-row press grammar (Validation 4) ────────────────────────────────────
//
// The headless resolvers `Timeline.svelte` presses through: rows in `track.order` on the shared
// arclength ruler, span geometry from the records, one hit answer per press (edge, body, chip,
// gap), the end handle in both its states plus its refusal, expand/collapse, and the driven
// overlay switching rows on an order swap. Pure — plain lane records and a `View` in — except the
// end-handle refusal arm, which drives the real `history.beginEnd` gesture so the model's answer
// and the setter's are read against each other rather than restated.
describe("S3 lane rows — layout, press grammar, end handle, driven overlay (Validation 4)", () => {
    const seg = (id: number, start: number, end: number, exit = 1): LaneSegment => ({
        id,
        start,
        end,
        ease: Easing.Linear,
        entry: exit,
        exit,
    });
    // one document: a geo record over [0, 20), a force record over [10, 30) under it, and a
    // velocity record over [0, 12). The geo/force overlap is what the driven overlay reads.
    const doc = (): Lanes => ({
        velocity: [seg(1, 0, 12, 15)],
        force: [seg(2, 10, 30, 2)],
        geo: [seg(3, 0, 20, 0.1)],
    });
    // 10 px per metre, no pan — a station's px is ten times its metre.
    const view: View = { pan: 0, pxPerU: 10 };
    const Top = 30;

    // RED: `laneRows` reading `DEFAULT_ORDER` instead of its `order` argument → the swapped call
    // still reads geo, force, velocity and this arm fails on the first lane.
    test("rows follow `track.order`, top to bottom, each carrying its own lane's records", () => {
        const rows = laneRows(doc(), [Lane.Force, Lane.Geo, Lane.Velocity], Top);
        expect(rows.map((r) => r.lane)).toEqual([Lane.Force, Lane.Geo, Lane.Velocity]);
        expect(rows.map((r) => r.index)).toEqual([0, 1, 2]);
        expect(rows.map((r) => r.records.map((s) => s.id))).toEqual([[2], [3], [1]]);
        expect(rows[0].top).toBe(Top);
        expect(rows[1].top).toBe(Top + ROW_H + ROW_GAP);
        expect(rows[2].top).toBe(Top + 2 * (ROW_H + ROW_GAP));
    });

    // RED: `spanBoxes` projecting `r.start`/`r.end` without `uToPx` (raw metres) → x1 reads 20,
    // not 200, and the box no longer covers the pressed pixel.
    test("span geometry projects the record's own stations through the view", () => {
        const rows = laneRows(doc(), DEFAULT_ORDER, Top);
        const geo = spanBoxes(rows[0], view, 40);
        expect(geo).toHaveLength(1);
        expect(geo[0]).toEqual({ id: 3, x0: 40, x1: 240, y0: Top, y1: Top + ROW_H });
    });

    // RED: drop `hitRows`'s edge branch (return `body` for every in-span press) → the two edge
    // presses read `body` and the arm fails on `kind`.
    test("press grammar: column, edge, body and gap each resolve on their own pixel", () => {
        const rows = laneRows(doc(), DEFAULT_ORDER, Top);
        const mid = Top + 4; // inside the geo row — the span fills it, there is no chip band
        // the geo span is [0, 20) → px [0, 200] at 10 px/m.
        expect(hitRows(rows, view, 1, mid)).toEqual({
            kind: "edge",
            lane: Lane.Geo,
            id: 3,
            which: "start",
        });
        expect(hitRows(rows, view, 199, mid)).toEqual({
            kind: "edge",
            lane: Lane.Geo,
            id: 3,
            which: "end",
        });
        expect(hitRows(rows, view, 100, mid)).toEqual({ kind: "body", lane: Lane.Geo, id: 3 });
        // past the geo record's own end: empty lane, so the press names its station.
        expect(hitRows(rows, view, 250, mid)).toEqual({ kind: "gap", lane: Lane.Geo, d: 25 });
        // and the row below answers for its own lane, not geo's.
        const forceMid = Top + ROW_H + ROW_GAP + 4;
        expect(hitRows(rows, view, 150, forceMid)).toEqual({
            kind: "body",
            lane: Lane.Force,
            id: 2,
        });
        expect(hitRows(rows, view, 150, 4)).toBeNull(); // the ruler band above every row
    });

    // RED (the person's check-in two, points 2/4/10): drop `hitRows`'s `px < left` branch and a
    // press on the column falls through to the chart's own hit, so the name cell answers `gap`
    // at a NEGATIVE station — the lane column stops being a target at all.
    test("the lane column answers for its whole inset, and names its row's own quantity", () => {
        const rows = laneRows(doc(), DEFAULT_ORDER, Top);
        expect(rows.map((r) => r.name)).toEqual(["geo", "force", "velocity"]);
        expect(hitRows(rows, view, 10, Top + 4, COLUMN_W)).toEqual({
            kind: "column",
            lane: Lane.Geo,
            index: 0,
        });
        // one pixel past the inset is the chart again — the geo span's own start edge.
        expect(hitRows(rows, view, COLUMN_W + 1, Top + 4, COLUMN_W)).toMatchObject({
            kind: "edge",
            lane: Lane.Geo,
        });
        // the row below answers for ITS lane, not the one above it.
        expect(hitRows(rows, view, 10, Top + ROW_H + ROW_GAP + 4, COLUMN_W)).toEqual({
            kind: "column",
            lane: Lane.Force,
            index: 1,
        });
    });

    // RED: drop the `which === "body"` length-preserving branch (floor `start` alone) and the
    // body drag lands [0, 17) — the span SHRINKS into the wall instead of stopping at it.
    test("the view's origin clamp: a body drag holds its length at 0, a start edge floors there", () => {
        expect(clampSpanDrag("body", -3, 17)).toEqual({ start: 0, end: 20 });
        expect(clampSpanDrag("body", 4, 24)).toEqual({ start: 4, end: 24 }); // untouched above 0
        expect(clampSpanDrag("start", -3, 20)).toEqual({ start: 0, end: 20 });
        expect(clampSpanDrag("start", 5, 20)).toEqual({ start: 5, end: 20 });
        // an end edge cannot reach the origin without crossing its own start, which the setter
        // refuses as degenerate — so the clamp leaves it alone rather than inventing a second law.
        expect(clampSpanDrag("end", 5, -1)).toEqual({ start: 5, end: -1 });
    });

    // RED: drop the origin and the end from `spanTargets`' pool and the two landmarks the person
    // drags to most (the wall and the track's own end) stop pulling; drop the `exclude` and a span
    // snaps to where it already is.
    test("the snap pool is every other record's stations across the lanes, plus the playhead, the end and 0", () => {
        const lanes = doc();
        expect(spanTargets(lanes, 7, 0).sort((a, b) => a - b)).toEqual([
            0, 0, 0, 7, 10, 12, 20, 30, 30,
        ]);
        // the dragged record's own two stations leave the pool — a span never snaps to itself.
        expect(spanTargets(lanes, null, 0, 3)).not.toContain(20);
        // a pinned end is the landmark, not the content extent.
        expect(spanTargets(lanes, null, 46, 3)).toContain(46);
    });

    // RED: read the record's `exit` for both handles and every span draws level — the shape the
    // chips were replaced by conveys nothing (check-in two, point 11).
    test("the miniature curve samples the record's own easing, normalized into its box", () => {
        const rec: LaneSegment = {
            id: 4,
            start: 0,
            end: 10,
            ease: Easing.Linear,
            entry: 0,
            exit: 2,
        };
        const box = { id: 4, x0: 100, x1: 200, y0: 10, y1: 36 };
        const pts = spanCurve(rec, 0, box, 3);
        expect(pts[0]).toEqual({ x: 100, y: 33 }); // the entry sits at the box's floor
        expect(pts[pts.length - 1]).toEqual({ x: 200, y: 13 }); // the exit at its ceiling
        // Linear rises straight: a quarter along the span is a quarter of the way up. A Cubic
        // over the same two handles is NOT — smoothstep is flat at its entry — so the tag really
        // governs the drawn curve. (The MIDPOINT is a poor foil: both families are symmetric and
        // read exactly half there, which is why this samples a quarter in.)
        const quarter = pts[(pts.length - 1) / 4];
        expect(quarter.y).toBeCloseTo(28, 1);
        const cubic = spanCurve({ ...rec, ease: Easing.Cubic }, 0, box, 3);
        expect(cubic[(pts.length - 1) / 4].y).toBeCloseTo(29.875, 1);
        // a flat record (equal handles) draws a level line down the middle, never a divide by 0.
        const flat = spanCurve({ ...rec, exit: 0 }, 0, box, 3);
        expect(flat.map((p) => p.y)).toEqual([23, 23]);
        // An unresolved entry has no authored curve. The span/target still exists.
        expect(spanCurve(rec, undefined, box, 3)).toEqual([]);
    });

    // RED: return `G_GRID` for every lane and the pitch nudge quantizes a heading in radians to
    // a tenth of a g — a unit the lane does not hold.
    test("each lane nudges its handle by its own value quantum", () => {
        expect(nudgeQuantum(Lane.Velocity)).toBe(V_GRID);
        expect(nudgeQuantum(Lane.Force)).toBe(G_GRID);
        expect(nudgeQuantum(Lane.Geo)).toBe(snapSteps.angle); // the person's own configured grid
    });

    // RED: mint the record at a fixed 1 g and the gap drag-out steps the force lane at the seam —
    // adding a span would change the bake before any handle is touched.
    // Creation defaults moved to commands.test.ts's flatRecordArgs all-lane/v0/CLI parity
    // witnesses. The production Add handler is covered in adapter.pw.ts; no second owner remains.

    // RED: `hitRows` taking the fixed `EDGE_PX` grip instead of half the span's width → a 6 px
    // span's two grips overlap, the `end` edge is unreachable, and this arm reads `start` twice.
    test("a span narrower than two grips still resolves both edges", () => {
        const thin: Lanes = { velocity: [], force: [], geo: [seg(9, 0, 0.6)] };
        const rows = laneRows(thin, DEFAULT_ORDER, Top);
        const mid = Top + 4;
        expect(hitRows(rows, view, 1, mid)).toMatchObject({ kind: "edge", which: "start" });
        expect(hitRows(rows, view, 5, mid)).toMatchObject({ kind: "edge", which: "end" });
    });

    // RED: `endHandle` reading `trackEnd(lanes, 0)` for `pinned` too (ignoring the raw column) →
    // the unpinned document reads `pinned: true` and the arm fails.
    test("the end handle reads pinned and unpinned off the raw `end` column", () => {
        const lanes = doc();
        const follow = endHandle(lanes, 0, view);
        expect(follow).toEqual({ d: 30, px: 300, pinned: false }); // the longest lane's last exit
        const pinned = endHandle(lanes, 46, view, 40);
        expect(pinned).toEqual({ d: 46, px: 500, pinned: true });
        expect(hitEndHandle(follow, 302)).toBe(true);
        expect(hitEndHandle(follow, 320)).toBe(false);
    });

    // RED: `endDragTarget` clamping to `trackEnd(lanes, 0)` instead of refusing → the below-content
    // drag returns 30 rather than null, and `setEnd` below still refuses it, so the model and the
    // setter disagree.
    test("the end handle refuses a pin below content — the model's answer is the setter's", () => {
        const lanes = doc();
        expect(endDragTarget(lanes, 40)).toBe(40);
        expect(endDragTarget(lanes, 30)).toBe(30); // exactly at content is legal
        expect(endDragTarget(lanes, 29.5)).toBeNull();

        // the live gesture: `beginEnd` opens on the raw column, the setter declines the illegal
        // write, and the release records nothing.
        const ecs = new State();
        ecs.addSystem(BakeSystem);
        createTrack(ecs);
        const h = createHistory();
        for (const lane of [Lane.Geo, Lane.Force, Lane.Velocity]) {
            for (const r of laneMembers(lanes, lane)) {
                const w = addRecord(h, ecs, lane, r);
                if (w.id === null) throw new Error(`refused: ${JSON.stringify(w.refusals)}`);
            }
        }
        const depth = h.undo.length;
        beginEnd(ecs);
        expect(setEnd(ecs, 29.5).map((r) => r.guard)).toEqual(["endBelowContent"]);
        commit(h);
        expect(h.undo).toHaveLength(depth); // a refused write is no entry
        expect(endColumn(ecs)).toBe(0);

        beginEnd(ecs);
        expect(setEnd(ecs, 40)).toEqual([]);
        commit(h);
        expect(h.undo).toHaveLength(depth + 1);
        expect(endHandle(lanesOf(ecs), endColumn(ecs), view)).toMatchObject({
            d: 40,
            pinned: true,
        });
    });

    test("lane layout has no expansion state; every span keeps its band", () => {
        const rows = laneRows(doc(), DEFAULT_ORDER, Top);
        expect(rows.map((r) => r.height)).toEqual([ROW_H, ROW_H, ROW_H]);
        expect(rows[1].top).toBe(Top + ROW_H + ROW_GAP);
        expect(rows[1].records.map((r) => r.id)).toEqual([2]);
        expect(spanBoxes(rows[0], view)[0].y1).toBe(Top + ROW_H);
    });

    // RED: `drivenSpans` marking a record driven under a run of its OWN kind → geo reads itself
    // driven over [0, 10) and the arm fails on the default order.
    test("the driven overlay follows lane order, and an order swap moves it to the other row", () => {
        const lanes = doc();
        // default order: geo drives, so the force record is driven where geo covers it — [10, 20).
        expect(drivenSpans(lanes, 0)).toEqual([{ lane: Lane.Force, id: 2, start: 10, end: 20 }]);
        // swap: force drives, so the GEO record is the driven one over the same overlap.
        expect(drivenSpans(lanes, 0, [Lane.Force, Lane.Geo, Lane.Velocity])).toEqual([
            { lane: Lane.Geo, id: 3, start: 10, end: 20 },
        ]);
        // velocity never competes for shape: its position in the order changes nothing.
        expect(drivenSpans(lanes, 0, [Lane.Velocity, Lane.Geo, Lane.Force])).toEqual(
            drivenSpans(lanes, 0),
        );
    });
});

describe("S3c — the driven residual, the step-in curve view, the popover anchor and the reorder drop (Validation 4)", () => {
    const rec = (over: Partial<LaneSegment> = {}): LaneSegment => ({
        id: 1,
        start: 0,
        end: 10,
        ease: Easing.Linear,
        entry: 1,
        exit: 2,
        ...over,
    });
    const view: View = { pan: 0, pxPerU: 10 };

    // RED: sum `ds` from index 0 into `station[0]` and every sample reads one edge ahead — the
    // whole bake slides half a cell against the ruler and every residual below is measured at the
    // wrong station.
    test("bake stations are the running sum of the per-edge `ds`, opening at 0", () => {
        expect([...bakeStations([2, 3, 5], 4)]).toEqual([0, 2, 5, 10]);
        expect([...bakeStations([], 0)]).toEqual([]);
        expect([...bakeStations([1], 1)]).toEqual([0]); // one sample, no edge to sum
    });

    // RED: return the residual at the LAST station inside the span rather than the worst one, and
    // a miss that peaks in the middle of the span reads as whatever the ends happen to agree on —
    // 0 here, so the arm fails on a record that is visibly not achieved.
    test("the residual is recovered minus demanded, signed, at the worst station of the span", () => {
        // a record demanding a Linear 1 → 2 over [0, 10); the bake recovers a flat 1.5, so the
        // miss is +0.5 at the start and −0.5 at the end, and the WORST is either of those.
        const station = [0, 2, 4, 6, 8, 10];
        const flat = [1.5, 1.5, 1.5, 1.5, 1.5, 1.5];
        const r = spanResidual({ station, value: flat, n: 6 }, rec(), 1);
        expect(r).toBeCloseTo(0.5, 6);
        // a bake that peaks INSIDE the span: demanded 1.4 at s=4, recovered 2.4 there, and the
        // ends agree exactly — a last-station reading would report 0.
        const peak = [1, 1.2, 2.4, 1.6, 1.8, 2];
        expect(spanResidual({ station, value: peak, n: 6 }, rec(), 1)).toBeCloseTo(1.0, 6);
        // the sign is RECOVERED minus DEMANDED, so an under-achieving bake reads negative.
        const under = [1, 1.2, 0.4, 1.6, 1.8, 2];
        expect(spanResidual({ station, value: under, n: 6 }, rec(), 1)).toBeCloseTo(-1.0, 6);
        // Unresolved demand cannot produce a residual, even with valid recovered samples.
        expect(
            spanResidual({ station, value: flat, n: 6 }, rec({ entry: undefined }), undefined),
        ).toBeUndefined();
    });

    // RED: report 0 where the bake covers none of the span and a missing premise becomes a
    // perfect fit — `checks.md`'s own rule, in the reading itself.
    test("a span the bake does not cover reads `undefined`, never a zero miss", () => {
        const read = { station: [0, 2, 4], value: [1, 1, 1], n: 3 };
        expect(spanResidual(read, rec({ start: 20, end: 30 }), 1)).toBeUndefined();
        expect(spanResidual({ station: [], value: [], n: 0 }, rec(), 1)).toBeUndefined();
    });

    // RED: fit the chart to the AUTHORED handles alone and a recovered curve that overshoots them
    // draws outside the box — the one thing the step-in exists to let a person see.
    test("an expanded row's chart fits every authored handle AND the recovered reading", () => {
        const rows = laneRows(
            { velocity: [], force: [rec({ id: 2, entry: 1, exit: 2 })], geo: [] },
            [Lane.Force, Lane.Geo, Lane.Velocity],
            30,
        );
        const chart = rowChart({ ...rows[0], height: 132 }, [1], [0.5, 3.5]);
        expect(chart.lo).toBe(0.5);
        expect(chart.hi).toBe(3.5);
        expect(chart.top).toBeLessThan(chart.bottom);
        expect(chart.bottom).toBeLessThanOrEqual(rows[0].top + 132);
        // value UP is pixel-y DOWN, and the two bounds land on the two edges.
        expect(chartY(chart, chart.hi)).toBe(chart.top);
        expect(chartY(chart, chart.lo)).toBe(chart.bottom);
        expect(chartY(chart, (chart.lo + chart.hi) / 2)).toBeCloseTo(
            (chart.top + chart.bottom) / 2,
            6,
        );
        // a lane with no spread at all still gets a finite window rather than dividing by zero.
        const flatRows = laneRows(
            { velocity: [], force: [rec({ id: 3, entry: 2, exit: 2 })], geo: [] },
            [Lane.Force, Lane.Geo, Lane.Velocity],
            30,
        );
        const flat = rowChart({ ...flatRows[0], height: 132 }, [2]);
        expect(flat.hi - flat.lo).toBeGreaterThan(0);
        expect(Number.isFinite(chartY(flat, 2))).toBe(true);
    });

    // RED: draw ONE polyline across the lane instead of one per record and the line runs through
    // a gap — claiming an authored value where the lane authored nothing.
    test("the authored curve is one polyline PER record, so a gap is never drawn through", () => {
        const lanes: Lanes = {
            velocity: [],
            force: [rec({ id: 1, start: 0, end: 10 }), rec({ id: 2, start: 20, end: 30 })],
            geo: [],
        };
        const rows = laneRows(lanes, [Lane.Force, Lane.Geo, Lane.Velocity], 30);
        const chart = rowChart({ ...rows[0], height: 132 }, [1, 1]);
        const lines = authoredPolylines(rows[0], [1, 1], chart, view, 40);
        expect(lines).toHaveLength(2);
        expect(lines[0][0].x).toBe(40); // the first record opens at its own start
        expect(lines[0].at(-1)!.x).toBe(140);
        expect(lines[1][0].x).toBe(240); // and the second at ITS start, across the gap
        // each polyline rises with its own record: entry 1 at the floor, exit 2 at the ceiling.
        expect(lines[0][0].y).toBeCloseTo(chartY(chart, 1), 6);
        expect(lines[0].at(-1)!.y).toBeCloseTo(chartY(chart, 2), 6);
    });

    // RED: project the recovered curve through the record's own local frame instead of the
    // ruler's absolute stations and the dashed line no longer sits under the solid one.
    test("the recovered curve projects the bake's own stations through the same view", () => {
        const rows = laneRows(
            { velocity: [], force: [rec()], geo: [] },
            [Lane.Force, Lane.Geo, Lane.Velocity],
            30,
        );
        const chart = rowChart({ ...rows[0], height: 132 }, [1], [1, 2]);
        const pts = recoveredPolyline(
            { station: [0, 5, 10], value: [1, 1.5, 2], n: 3 },
            chart,
            view,
            40,
        );
        expect(pts.map((p) => p.x)).toEqual([40, 90, 140]);
        expect(pts[0].y).toBeCloseTo(chartY(chart, 1), 6);
        expect(pts[2].y).toBeCloseTo(chartY(chart, 2), 6);
    });

    // RED: drop the flip and a span near the dock's floor opens its popover off the bottom edge —
    // the panel the person just summoned is unreadable (`ui.md`: opaque panels flip and clamp).
    test("the popover opens below its span, flips above at the floor, and clamps inside the dock", () => {
        const dock = { w: 600, h: 240 };
        const size = { w: 180, h: 132 };
        const mid = { id: 1, x0: 200, x1: 300, y0: 40, y1: 66 };
        const below = popoverFit(mid, size, dock);
        expect(below.flipped).toBe(false);
        expect(below.y).toBe(72); // a gap under the span's band
        expect(below.x).toBe(160); // centred on the span
        // a span low in the dock: opening down would clip, and there is room above.
        const low = { id: 1, x0: 200, x1: 300, y0: 190, y1: 216 };
        const flipped = popoverFit(low, size, dock);
        expect(flipped.flipped).toBe(true);
        expect(flipped.y).toBe(190 - 6 - 132);
        // and the horizontal clamp keeps the whole panel on both walls.
        expect(popoverFit({ ...mid, x0: 0, x1: 20 }, size, dock).x).toBe(6);
        expect(popoverFit({ ...mid, x0: 580, x1: 600 }, size, dock).x).toBe(600 - 6 - 180);
    });

    test("context reading uses accumulated ds, unwrapped samples and edge holds without extrapolation", () => {
        const station = bakeStations([2, 3, 5], 4);
        const read = { station, value: [6, 8, 11, 16], n: 4 };
        expect(recoveredAt(read, 3)).toBe(9);
        expect(recoveredAt(read, 10)).toBe(16);
        expect(recoveredAt({ ...read, n: 3 }, 3, true)).toBe(8);
        expect(recoveredAt({ ...read, n: 3 }, 10, true)).toBe(11);
        for (const s of [-1, 10.001, NaN, Infinity]) expect(recoveredAt(read, s)).toBeUndefined();
        expect(recoveredAt({ ...read, value: [6, NaN, 11, 16] }, 3)).toBeUndefined();
        expect(recoveredAt({ ...read, value: [] }, 0)).toBeUndefined();
        expect(recoveredAt({ ...read, station: bakeStations([2], 4) }, 3)).toBeUndefined();
        expect(recoveredAt({ station: [], value: [], n: 0 }, 0)).toBeUndefined();
        // Chord lengths [1,1,1] and wrapping heading would both return a different value.
        expect(recoveredAt({ ...read, station: bakeStations([1, 1, 1], 4) }, 3)).not.toBe(9);
    });

    test("measured editor stays adjacent to its invoker, flips and clamps at viewport edges", () => {
        for (const viewport of [
            { w: 1280, h: 720 },
            { w: 800, h: 600 },
        ])
            for (const h of [160, 320])
                for (const x of [0, viewport.w / 2, viewport.w]) {
                    const size = { w: 270, h };
                    const dock = { x: 16, y: viewport.h - 200, w: viewport.w - 32, h: 180 };
                    const invoker = { x, y: dock.y + 32, w: 2, h: 32 };
                    const fit = fitEditor(size, viewport, [], invoker);
                    expect(fit.x).toBeGreaterThanOrEqual(8);
                    expect(fit.x + size.w).toBeLessThanOrEqual(viewport.w - 8);
                    expect(fit.y).toBeGreaterThanOrEqual(8);
                    expect(fit.y + size.h).toBe(invoker.y - 8);
                }
        expect(
            fitEditor({ w: 270, h: 160 }, { w: 800, h: 600 }, [], { x: 400, y: 20, w: 2, h: 32 }).y,
        ).toBe(60);
    });

    test("attached status stays outside held controls across invoker, handle, player, tool and viewport edges", () => {
        const basic = fitAttachedStatus(
            { w: 220, h: 28 },
            { w: 800, h: 600 },
            [],
            { x: 300, y: 300, w: 180, h: 40 },
            { x: 380, y: 240, w: 2, h: 26 },
        );
        expect(basic).toEqual({ x: 280, y: 348 });
        const viewports = [
            { w: 800, h: 600 },
            { w: 1280, h: 720 },
        ];
        const panels = [
            { x: 8, y: 8, w: 180, h: 40 },
            { x: 612, y: 8, w: 180, h: 40 },
            { x: 8, y: 552, w: 180, h: 40 },
            { x: 612, y: 552, w: 180, h: 40 },
            { x: 300, y: 300, w: 180, h: 40 },
        ];
        const invokers = [
            { x: 10, y: 80, w: 2, h: 26 }, // left handle
            { x: 788, y: 80, w: 2, h: 26 }, // right handle
            { x: 380, y: 240, w: 2, h: 26 }, // above/invoker
            { x: 380, y: 574, w: 2, h: 18 }, // below/invoker
        ];
        for (const viewport of viewports) {
            for (const panel of panels) {
                if (panel.x + panel.w > viewport.w || panel.y + panel.h > viewport.h) continue;
                for (const invoker of invokers) {
                    if (invoker.x > viewport.w || invoker.y > viewport.h) continue;
                    const size = { w: 220, h: 28 };
                    const obstacles = [
                        { x: viewport.w / 2 - 80, y: viewport.h - 188, w: 160, h: 36 }, // player
                        { x: 16, y: viewport.h - 156, w: 36, h: 140 }, // tool strip
                    ];
                    const fit = fitAttachedStatus(size, viewport, obstacles, panel, invoker);
                    if (fit) {
                        expect(
                            editorFits({ ...fit, ...size }, viewport, [
                                panel,
                                invoker,
                                ...obstacles,
                            ]),
                        ).toBe(true);
                    }
                }
            }
        }
    });

    test("attached status growth re-solves independently and refuses when every measured side is blocked", () => {
        const viewport = { w: 800, h: 600 };
        const panel = { x: 300, y: 300, w: 180, h: 40 };
        const invoker = { x: 380, y: 240, w: 2, h: 26 };
        const player = { x: 260, y: 420, w: 280, h: 36 };
        const tool = { x: 16, y: 444, w: 36, h: 140 };
        const opening = fitAttachedStatus(
            { w: 120, h: 14 },
            viewport,
            [player, tool],
            panel,
            invoker,
        );
        expect(opening).not.toBeNull();
        expect(
            editorFits({ ...opening!, w: 120, h: 14 }, viewport, [panel, invoker, player, tool]),
        ).toBe(true);
        // The refusal grew in the same observation window as an external obstacle moved into its
        // first side. The panel's held rectangle is unchanged; only the complete measured status
        // box is re-solved, never folded into the controls' sizing flow.
        const expanded = fitAttachedStatus(
            { w: 280, h: 40 },
            viewport,
            [player, tool, { x: 280, y: 348, w: 240, h: 56 }],
            panel,
            invoker,
        );
        expect(expanded).not.toBeNull();
        expect(
            editorFits({ ...expanded!, w: 280, h: 40 }, viewport, [
                panel,
                invoker,
                player,
                tool,
                { x: 280, y: 348, w: 240, h: 56 },
            ]),
        ).toBe(true);
        expect(
            fitAttachedStatus(
                { w: 220, h: 28 },
                viewport,
                [{ x: 0, y: 0, w: 800, h: 600 }],
                panel,
                invoker,
            ),
        ).toBeNull();
    });

    // RED: resolve the drop off the pointer's own row only (return `from`) and a drag can never
    // move a row at all — `history.setOrder` is never called with anything new.
    test("the reorder drop reads the row band under the pointer, and clamps at both ends", () => {
        const rows = laneRows({ velocity: [], force: [], geo: [] }, DEFAULT_ORDER, 30);
        expect(reorderDrop(rows, 0)).toBe(0); // above the first row
        expect(reorderDrop(rows, 35)).toBe(0);
        expect(reorderDrop(rows, 30 + ROW_H + ROW_GAP + 4)).toBe(1);
        expect(reorderDrop(rows, 9999)).toBe(2); // below the last row
        expect(reorderDrop([], 40)).toBe(0);
    });

    // RED: splice without lifting first (insert before removing) and a downward move lands one
    // row short; return a fresh array for a no-move and the caller records an entry that changes
    // nothing (`history.setOrder` writes the resolved default over an absent column).
    test("a reorder lifts and re-inserts, and returns the SAME array when nothing moves", () => {
        const order = [Lane.Geo, Lane.Force, Lane.Velocity] as const;
        expect(reordered(order, 0, 2)).toEqual([Lane.Force, Lane.Velocity, Lane.Geo]);
        expect(reordered(order, 2, 0)).toEqual([Lane.Velocity, Lane.Geo, Lane.Force]);
        expect(reordered(order, 1, 0)).toEqual([Lane.Force, Lane.Geo, Lane.Velocity]);
        expect(reordered(order, 1, 1)).toBe(order); // identity: the caller skips
        expect(reordered(order, 0, 5)).toBe(order); // out of range is no move, never a throw
        expect(reordered(order, -1, 0)).toBe(order);
    });
});

describe("S3j lane value axis and knot arbitration", () => {
    const record = (over: Partial<LaneSegment> = {}): LaneSegment => ({
        id: 7,
        start: 0,
        end: 10,
        ease: Easing.Linear,
        entry: 1,
        exit: 2,
        ...over,
    });

    test("resting bases and frames are independent of authored boot values", () => {
        expect(laneValueAxis(Lane.Force)).toEqual({ base: 1, frame: [-2, 6], cap: [-20, 20] });
        expect(laneValueAxis(Lane.Geo).base).toBe(0);
        expect(laneValueAxis(Lane.Geo).frame).toEqual([-Math.PI, Math.PI]);
        const velocity = laneValueAxis(Lane.Velocity, 37);
        expect(velocity.base).toBe(37);
        expect(velocity.frame).toEqual([29, 45]);
        expect(velocity.frame).not.toContain(18);
    });

    test("the lane fit includes authored handles and selected recovery, then grows only past its frame", () => {
        const rows = laneRows({ velocity: [], force: [record()], geo: [] }, [Lane.Force], 10);
        const entries = [1];
        const resting = fitLaneValue(Lane.Force, rows[0].records, entries);
        expect(resting).toEqual({ lo: -2, hi: 6, step: 2 });
        const recovered = fitLaneValue(Lane.Force, rows[0].records, entries, [9]);
        expect(recovered.lo).toBe(-2);
        expect(recovered.hi).toBeGreaterThanOrEqual(9);
        const chart = valueChart(rows[0], resting);
        expect(chart.top).toBe(rows[0].top + 3);
        expect(chart.bottom).toBe(rows[0].top + ROW_H - 3);
    });

    test("spanCurve uses the shared value axis, so equal station geometry can show a value change", () => {
        const rows = laneRows({ velocity: [], force: [record()], geo: [] }, [Lane.Force], 10);
        const view = { pan: 0, pxPerU: 10 };
        const chart = valueChart(rows[0], { lo: 0, hi: 4, step: 1 });
        const low = spanCurve(record({ exit: 2 }), 1, spanBoxes(rows[0], view, 0)[0]!, chart);
        const high = spanCurve(record({ exit: 4 }), 1, spanBoxes(rows[0], view, 0)[0]!, chart);
        expect(low.map((p) => p.y)).not.toEqual(high.map((p) => p.y));
        expect(high.at(-1)!.y).toBeLessThan(low.at(-1)!.y);
    });

    test("exit knot wins over the body while the neighbouring edge keeps horizontal ownership", () => {
        const lanes: Lanes = { velocity: [], force: [record()], geo: [] };
        const rows = laneRows(lanes, [Lane.Force], 10);
        const view = { pan: 0, pxPerU: 10 };
        const chart = valueChart(rows[0], { lo: 0, hi: 4, step: 1 });
        const points = knotPoints(rows[0], [1], chart, view);
        const exit = points.find((p) => p.which === "exit")!;
        expect(hitRows(rows, view, exit.x, exit.y, 0, points)).toEqual({
            kind: "knot",
            lane: Lane.Force,
            id: 7,
            which: "exit",
        });
        expect(
            hitRows(rows, view, exit.x - KNOT_PX - 1, rows[0].top + ROW_H / 2, 0, points),
        ).toMatchObject({
            kind: "edge",
            which: "end",
        });
        expect(hitRows(rows, view, 50, rows[0].top + ROW_H / 2, 0, points)).toEqual({
            kind: "body",
            lane: Lane.Force,
            id: 7,
        });
    });

    test("the dead-zone crossing chooses an axis once and value snapping honors the lane quantum", () => {
        expect(dragAxis(1, 1)).toBeNull();
        expect(dragAxis(2, 5)).toBe("value");
        expect(dragAxis(5, 2)).toBe("station");
        expect(dragAxis(20, 1)).toBe("station");
        expect(dragAxis(1, 20)).toBe("value");
    });

    test("recoveredPolyline is unavailable for missing coverage or unresolved entry, never zero", () => {
        const chart = { top: 0, bottom: 20, lo: 0, hi: 2 };
        const view = { pan: 0, pxPerU: 10 };
        const read = { station: [0, 5, 10], value: [1, 1.5, 2], n: 3 };
        expect(
            recoveredPolyline(read, chart, view, 0, { start: 0, end: 10, available: true }),
        ).toHaveLength(3);
        expect(
            recoveredPolyline(read, chart, view, 0, { start: 0, end: 10, available: false }),
        ).toEqual([]);
        expect(
            recoveredPolyline({ ...read, value: [1, NaN, 2] }, chart, view, 0, {
                start: 0,
                end: 10,
                available: true,
            }),
        ).toEqual([]);
    });

    test("retired standing surfaces have no live Timeline or Popover referents", () => {
        const timeline = readFileSync(new URL("../src/Timeline.svelte", import.meta.url), "utf8");
        const popover = readFileSync(new URL("../src/Popover.svelte", import.meta.url), "utf8");
        const corpus = `${timeline}\n${popover}`;
        expect(corpus).not.toContain(".feedback");
        expect(corpus).not.toContain("Segment actions");
        expect(corpus).not.toContain(".read-station");
        expect(corpus).not.toContain('class="result"');
        expect(corpus).toContain("drag-value-label");
        expect(corpus).toContain("data-value-windows");
    });

    test("every UI record-end opener explicitly requests ripple false", () => {
        const timeline = readFileSync(new URL("../src/Timeline.svelte", import.meta.url), "utf8");
        const calls = [...timeline.matchAll(/beginRecordEnd\(([^)]*)\)/g)].map((match) => match[0]);
        expect(calls).toHaveLength(3);
        expect(calls.every((call) => /,\s*false\s*\)$/.test(call))).toBe(true);
        expect(timeline).not.toContain("ripple");
    });

    test("the solid tool strip uses muted resting ink and no button border", () => {
        const timeline = readFileSync(new URL("../src/Timeline.svelte", import.meta.url), "utf8");
        const rule = (selector: string): string =>
            timeline.match(new RegExp(`${selector} \\{([^}]*)\\}`))?.[1] ?? "";
        const resting = rule("\\.tool-strip button");
        const hover = rule("\\.tool-strip button:hover:not\\(:disabled\\)");
        const pressed = rule('\\.tool-strip button\\[aria-pressed=\\"true\\"\\]');
        expect(resting).toContain("color: var(--muted)");
        expect(resting).toContain("background: transparent");
        expect(resting).toContain("border: 0");
        expect(hover).toContain("color: var(--fg)");
        expect(hover).toContain("background: transparent");
        expect(pressed).toContain("color: var(--fg)");
        expect(pressed).toContain("background: var(--neutral-soft)");
        expect(pressed).toContain("border: 0");
    });
});
