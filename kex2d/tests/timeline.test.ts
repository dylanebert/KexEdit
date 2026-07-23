import { describe, expect, test } from "bun:test";
import {
    arcToTime,
    clampView,
    creationTargets,
    frameAll,
    G_GRID,
    type Mapping,
    marginArc,
    MAX_PX_PER_M,
    navDragView,
    navWindow,
    niceStep,
    nodeTickPx,
    pxToS,
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
