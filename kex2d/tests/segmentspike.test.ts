import { describe, expect, test } from "bun:test";
import { Easing, type ForcePoint, sampleForce } from "../src/profile";
import {
    type BoundaryCandidate,
    type HitState,
    type SegmentCandidate,
    pickHit,
    rippleDuration,
    segmentKnobs,
    segments,
} from "../src/segmentspike";

// S1 of kex2d-segment-spike (specs/kex2d-segment-spike.md): the pure segment model over a local
// ForcePoint[] and the ripple duration law. C1's four arms: repeat-click cycling determinism,
// nearest-boundary preference, an arc-identity arm (no second evaluator), and ripple's three laws
// (later boundaries shift by exactly the delta, every value untouched, total length moves with it).

describe("segments — the local segment view", () => {
    test("one segment per adjacent boundary pair, in order", () => {
        const pts: ForcePoint[] = [
            { s: 0, g: 1 },
            { s: 10, g: 2 },
            { s: 25, g: 0 },
        ];
        const segs = segments(pts);
        expect(segs).toHaveLength(2);
        expect(segs[0]).toEqual({ index: 0, a: pts[0], b: pts[1] });
        expect(segs[1]).toEqual({ index: 1, a: pts[1], b: pts[2] });
    });

    test("fewer than two points → no segments", () => {
        expect(segments([])).toHaveLength(0);
        expect(segments([{ s: 0, g: 1 }])).toHaveLength(0);
    });
});

describe("segmentKnobs — trivial geometry, the boundary itself", () => {
    const pts: ForcePoint[] = [
        { s: 0, g: 1 },
        { s: 10, g: 2 },
        { s: 25, g: 0 },
    ];

    test("returns the active segment's own two boundaries", () => {
        const [k0, k1] = segmentKnobs(pts, 1);
        expect(k0).toEqual({ index: 1, s: 10, g: 2 });
        expect(k1).toEqual({ index: 2, s: 25, g: 0 });
    });

    test("throws on an out-of-range segment index rather than a partial pair", () => {
        expect(() => segmentKnobs(pts, -1)).toThrow();
        expect(() => segmentKnobs(pts, 2)).toThrow(); // only segments 0, 1 exist
    });
});

describe("pickHit — nearest-boundary preference", () => {
    // three boundaries at x = 0, 100, 200; one segment area spans the whole [0, 200] click zone.
    const boundaries: BoundaryCandidate[] = [
        { index: 0, x: 0 },
        { index: 1, x: 100 },
        { index: 2, x: 200 },
    ];
    const segs: SegmentCandidate[] = [
        { index: 0, x0: 0, x1: 100 },
        { index: 1, x0: 100, x1: 200 },
    ];

    test("a boundary within radius wins over the segment area it also sits inside", () => {
        const { hit } = pickHit(101, boundaries, segs, 5, null);
        expect(hit).toEqual({ kind: "boundary", index: 1 });
    });

    test("the nearer of two boundaries within radius wins on a fresh click", () => {
        // x=97: 3px from boundary 1 (x=100), 97px from boundary 0 — only boundary 1 is in range.
        // pick a point equidistant-ish but with two boundaries in range: widen radius.
        const { hit } = pickHit(60, boundaries, segs, 65, null); // both boundary 0 (d=60) and 1 (d=40) in range
        expect(hit).toEqual({ kind: "boundary", index: 1 }); // nearer (d=40) wins
    });

    test("no boundary in range falls through to the segment area", () => {
        const { hit } = pickHit(50, boundaries, segs, 5, null);
        expect(hit).toEqual({ kind: "segment", index: 0 });
    });

    test("neither a boundary nor a segment area → none", () => {
        const { hit } = pickHit(500, boundaries, segs, 5, null);
        expect(hit).toEqual({ kind: "none" });
    });
});

describe("pickHit — repeat-click cycling determinism", () => {
    // three boundaries tightly clustered around x=100, all within radius of a click at x=100.
    const boundaries: BoundaryCandidate[] = [
        { index: 5, x: 99 },
        { index: 6, x: 100 },
        { index: 7, x: 101 },
    ];
    const segs: SegmentCandidate[] = [];

    test("a fresh click always resolves to the nearest tied candidate", () => {
        const { hit } = pickHit(100, boundaries, segs, 5, null);
        expect(hit).toEqual({ kind: "boundary", index: 6 }); // d=0, exact
    });

    test("repeated clicks at the same x cycle deterministically through the tied set, wrapping", () => {
        // nearest-first, index-tiebroken order at x=100: d(6)=0, d(5)=1, d(7)=1 → [6, 5, 7]
        let state: HitState | null = null;
        const seen: number[] = [];
        for (let i = 0; i < 5; i++) {
            const { hit, state: next } = pickHit(100, boundaries, segs, 5, state);
            expect(hit.kind).toBe("boundary");
            if (hit.kind === "boundary") seen.push(hit.index);
            state = next;
        }
        expect(seen).toEqual([6, 5, 7, 6, 5]); // cycles and wraps
    });

    test("the same sequence of calls reproduces the same sequence of results (no hidden state)", () => {
        const run = () => {
            let state: HitState | null = null;
            const seen: number[] = [];
            for (let i = 0; i < 4; i++) {
                const { hit, state: next } = pickHit(100, boundaries, segs, 5, state);
                if (hit.kind === "boundary") seen.push(hit.index);
                state = next;
            }
            return seen;
        };
        expect(run()).toEqual(run());
    });

    test("a click at a different x resets the cycle instead of advancing it", () => {
        const first = pickHit(100, boundaries, segs, 5, null);
        expect(first.hit).toEqual({ kind: "boundary", index: 6 });
        // click elsewhere, in range of nothing here — state resets to cycle 0
        const elsewhere = pickHit(100, boundaries, segs, 5, { x: 100, cycle: 0 }); // simulate same-x, cycle 0 prior
        expect(elsewhere.hit).toEqual({ kind: "boundary", index: 5 }); // advances from cycle 0 to 1
        const differentX = pickHit(300, boundaries, segs, 5, first.state);
        expect(differentX.hit).toEqual({ kind: "none" }); // out of range at x=300, not a boundary at all
        // clicking back at x=100 with state from the x=300 click does not carry the old cycle
        const backAt100 = pickHit(100, boundaries, segs, 5, differentX.state);
        expect(backAt100.hit).toEqual({ kind: "boundary", index: 6 }); // fresh cycle, nearest again
    });
});

describe("arc-identity — the seeded model agrees with sampleForce before any edit", () => {
    // the no-second-evaluator claim: segments() builds a view over `points` without touching or
    // reordering them, so sampleForce over the seeded model's own points is byte-identical to
    // sampleForce over the section's original keys, for every s — the same array, read the same way.
    const original: ForcePoint[] = [
        { s: 0, g: 1, ease: Easing.Cubic },
        { s: 10, g: 3, ease: Easing.Linear },
        { s: 25, g: 0.5, ease: Easing.Quintic },
        { s: 40, g: 2 },
    ];

    test("segments() over the seeded points changes nothing sampleForce reads", () => {
        const view = segments(original);
        expect(view).toHaveLength(3);
        for (let s = -5; s <= 45; s += 1.3) {
            const want = sampleForce(original, s);
            const got = sampleForce(
                view.flatMap((seg, i) => (i === 0 ? [seg.a, seg.b] : [seg.b])),
                s,
            );
            expect(got).toBe(want);
        }
    });
});

describe("rippleDuration — one law, no switch", () => {
    const base: ForcePoint[] = [
        { s: 0, g: 1, ease: Easing.Linear },
        { s: 10, g: 2, ease: Easing.Cubic, out: { ds: 1, dg: 0.5 } },
        { s: 25, g: 0, ease: Easing.Quintic },
        { s: 40, g: -1 },
    ];

    test("boundaryIndex and every later boundary's s shift by exactly delta", () => {
        const out = rippleDuration(base, 2, 6); // edit the duration of segment 1 (10 -> 25)
        expect(out[0].s).toBe(0); // before the edited boundary: untouched
        expect(out[1].s).toBe(10); // before the edited boundary: untouched
        expect(out[2].s).toBe(25 + 6); // the edited boundary itself
        expect(out[3].s).toBe(40 + 6); // later boundary, shifted by the same delta
    });

    test("every boundary value (g, ease, handles) is untouched — only s moves", () => {
        const out = rippleDuration(base, 2, -4);
        for (let i = 0; i < base.length; i++) {
            expect(out[i].g).toBe(base[i].g);
            expect(out[i].ease).toBe(base[i].ease);
            expect(out[i].in).toEqual(base[i].in);
            expect(out[i].out).toEqual(base[i].out);
        }
    });

    test("the total length (the last boundary's s) moves by the same delta", () => {
        const delta = 3.5;
        const out = rippleDuration(base, 1, delta);
        const originalLength = base[base.length - 1].s;
        const newLength = out[out.length - 1].s;
        expect(newLength - originalLength).toBeCloseTo(delta, 12);
    });

    test("editing the last boundary still moves the total length by delta (it IS the total)", () => {
        const out = rippleDuration(base, base.length - 1, 9);
        expect(out[out.length - 1].s).toBe(40 + 9);
    });

    test("every later segment's own duration is unchanged — both its endpoints shift together", () => {
        const delta = 5;
        const out = rippleDuration(base, 1, delta); // edits segment 0's duration
        // segment 1 (points 1->2) and segment 2 (points 2->3) durations must survive
        const durBefore = (pts: ForcePoint[], i: number) => pts[i + 1].s - pts[i].s;
        expect(durBefore(out, 1)).toBeCloseTo(durBefore(base, 1), 12);
        expect(durBefore(out, 2)).toBeCloseTo(durBefore(base, 2), 12);
        // the edited segment's own duration changed by exactly delta
        expect(durBefore(out, 0) - durBefore(base, 0)).toBeCloseTo(delta, 12);
    });

    test("boundary 0 is not a valid duration-edit target (it terminates no segment)", () => {
        expect(() => rippleDuration(base, 0, 5)).toThrow();
    });

    test("an out-of-range boundaryIndex throws", () => {
        expect(() => rippleDuration(base, base.length, 5)).toThrow();
        expect(() => rippleDuration(base, -1, 5)).toThrow();
    });

    test("does not mutate the input array", () => {
        const copy = base.map((p) => ({ ...p }));
        rippleDuration(base, 2, 7);
        expect(base).toEqual(copy);
    });
});
