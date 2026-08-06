import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
    DEFAULT_G,
    Easing,
    type ForcePoint,
    forceProfile,
    resolveStep,
    sampleForce,
    segmentControls,
    segmentSeed,
    subdivide,
} from "../src/profile";

// the force-authoring layer (kex2d/AGENTS.md, force authoring): authored force
// keyframes → dense per-edge F_n. every segment is a cubic bezier in (s, g); a
// keyframe side resolves to a derived flat tangent (from its easing tag) or an
// explicit handle. the influence ends are derived, not tuned — Linear degenerates
// to the chord (exactly linear), Cubic makes s(t) linear (exactly smoothstep), so
// their invariants are analytic. tolerances are the root-solve residual (see
// S_TOL_REL in profile.ts: the Linear/Cubic error is |Δg|·1e-13, far below the
// asserted 1e-9..1e-10). the O(ds) recovered-vs-authored gap lives one layer up
// (section.test.ts evalForce) and isn't re-tested here.

// x²(3−2x): the analytic Cubic curve. s(t) is linear in t at influence 1/3, so
// g(s) with a default-Cubic segment equals g0 + Δg·smoothstep((s−s0)/span) exactly.
const smoothstep = (x: number) => x * x * (3 - 2 * x);

describe("sampleForce — endpoints and empties", () => {
    test("an empty profile is the constant DEFAULT_G everywhere", () => {
        for (const s of [-5, 0, 10, 1e6]) expect(sampleForce([], s)).toBe(DEFAULT_G);
    });

    test("a single point holds its value flat on both sides", () => {
        const pts: ForcePoint[] = [{ s: 10, g: 2.5 }];
        expect(sampleForce(pts, 0)).toBe(2.5); // before → held
        expect(sampleForce(pts, 10)).toBe(2.5); // at
        expect(sampleForce(pts, 40)).toBe(2.5); // after → held
    });

    test("holds flat before the first / after the last keyframe", () => {
        const pts: ForcePoint[] = [
            { s: 0, g: 1 },
            { s: 10, g: 3 },
        ];
        expect(sampleForce(pts, -2)).toBe(1); // held before first
        expect(sampleForce(pts, 0)).toBe(1);
        expect(sampleForce(pts, 10)).toBe(3);
        expect(sampleForce(pts, 99)).toBe(3); // held after last
    });
});

describe("Linear tag — exactly the old linear interpolation", () => {
    // the linear-interp assertions the old stub pinned, now reached via ease:Linear
    // (zero-length handles → the bezier IS the chord → g(s) is analytically linear).
    // these values were the old sampleForce's; a Linear segment reproduces them.
    const lin = (s: number, g: number): ForcePoint => ({ s, g, ease: Easing.Linear });

    test("interpolates linearly between two points", () => {
        const pts = [lin(0, 1), lin(10, 3)];
        expect(sampleForce(pts, 2.5)).toBeCloseTo(1.5, 10); // ¼ of the way → 1 + 0.25·2
        expect(sampleForce(pts, 5)).toBeCloseTo(2, 10);
        expect(sampleForce(pts, 7.5)).toBeCloseTo(2.5, 10);
    });

    test("Linear matches an independent linear oracle across the span", () => {
        const pts = [lin(3, -1), lin(23, 4)];
        for (let s = 3; s <= 23; s += 0.37) {
            const want = -1 + ((s - 3) / 20) * 5;
            expect(sampleForce(pts, s)).toBeCloseTo(want, 9);
        }
    });

    test("picks the right interval among many, coincident-s collapses to the earlier value", () => {
        const pts = [lin(0, 1), lin(10, 2), lin(10, 5), lin(20, 0)];
        expect(sampleForce(pts, 5)).toBeCloseTo(1.5, 10); // between (0,1) and (10,2)
        expect(sampleForce(pts, 15)).toBeCloseTo(2.5, 10); // between (10,5) and (20,0)
    });
});

describe("Cubic tag (the default) — exactly smoothstep", () => {
    test("an untagged segment is smoothstep, not linear", () => {
        // the behavior change the default flip pins: at s=2.5 (t=¼) the old linear
        // stub returned 1.5; the Cubic default returns 1 + smoothstep(¼)·2 = 1.3125.
        const pts: ForcePoint[] = [
            { s: 0, g: 1 },
            { s: 10, g: 3 },
        ];
        expect(sampleForce(pts, 2.5)).toBeCloseTo(1.3125, 10);
        expect(sampleForce(pts, 2.5)).not.toBeCloseTo(1.5, 3);
    });

    test("matches g0 + Δg·smoothstep((s−s0)/span) across the span", () => {
        const s0 = 4;
        const s1 = 24;
        const g0 = 0.5;
        const g1 = 2.5;
        const pts: ForcePoint[] = [
            { s: s0, g: g0 },
            { s: s1, g: g1 },
        ];
        for (let s = s0; s <= s1; s += 0.31) {
            const want = g0 + (g1 - g0) * smoothstep((s - s0) / (s1 - s0));
            expect(sampleForce(pts, s)).toBeCloseTo(want, 10);
        }
    });

    test("explicitly tagged Cubic equals the untagged default", () => {
        const untagged: ForcePoint[] = [
            { s: 0, g: 0 },
            { s: 10, g: 1 },
        ];
        const tagged: ForcePoint[] = [
            { s: 0, g: 0, ease: Easing.Cubic },
            { s: 10, g: 1, ease: Easing.Cubic },
        ];
        for (let s = 0; s <= 10; s += 0.5) {
            expect(sampleForce(tagged, s)).toBeCloseTo(sampleForce(untagged, s), 12);
        }
    });
});

describe("Quintic tag — the quintic feel", () => {
    // influence 7/15: the two s-handles reach 7/15 and 8/15 of the span, still
    // monotone, symmetric about the center, flatter at the ends than Cubic.
    const quintic = (s: number, g: number): ForcePoint => ({ s, g, ease: Easing.Quintic });

    test("endpoints exact, center is the mean, monotone across the span", () => {
        const pts = [quintic(0, 0), quintic(10, 2)];
        expect(sampleForce(pts, 0)).toBeCloseTo(0, 12);
        expect(sampleForce(pts, 10)).toBeCloseTo(2, 12);
        expect(sampleForce(pts, 5)).toBeCloseTo(1, 10); // symmetric → the mean
        let prev = Number.NEGATIVE_INFINITY;
        for (let s = 0; s <= 10; s += 0.25) {
            const g = sampleForce(pts, s);
            expect(g).toBeGreaterThanOrEqual(prev - 1e-9);
            prev = g;
        }
    });

    test("center slope matches the true quintic (15/8), not the old influence-½ (2)", () => {
        // the derived influence 7/15 is chosen so the flat-tangent cubic bezier's
        // center slope 1/(1−i) equals the true quintic smootherstep's g'(½) = 15/8.
        // in domain units that's (Δg/span)·15/8 = (2/10)·1.875 = 0.375; the old
        // influence ½ gave 1/(1−½) = 2 → 0.4. central difference recovers it:
        // truncation O(h²·g''') ~ 1e-5 and roundoff ~1e-10 sit far under the asserted
        // 5e-4 window, while the 0.025 gap to the old value is 50× wider — red against
        // ½, green against 7/15.
        const pts = [quintic(0, 0), quintic(10, 2)];
        const h = 1e-3;
        const slope = (sampleForce(pts, 5 + h) - sampleForce(pts, 5 - h)) / (2 * h);
        expect(slope).toBeCloseTo(0.375, 3); // (Δg/span)·15/8
    });

    test("flatter lead-in than Cubic (rises later toward the target)", () => {
        const quinticPts = [quintic(0, 0), quintic(10, 1)];
        const cubicPts: ForcePoint[] = [
            { s: 0, g: 0 },
            { s: 10, g: 1 },
        ];
        // increasing g: the longer flat end keeps Quintic below Cubic early on.
        expect(sampleForce(quinticPts, 2.5)).toBeLessThan(sampleForce(cubicPts, 2.5));
    });
});

describe("leading keyframe governs the whole segment (Blender F-curve convention)", () => {
    test("A=Quintic, B=Cubic → segment A→B is symmetric Quintic, not half-and-half", () => {
        // both derived handles of the segment take the LEADING key's tag (A=Quintic),
        // so the transition is the same shape as an all-Quintic segment and B's Cubic
        // tag has no effect on the segment arriving at it.
        const mixed: ForcePoint[] = [
            { s: 0, g: 0, ease: Easing.Quintic },
            { s: 10, g: 2, ease: Easing.Cubic },
        ];
        const bothQuintic: ForcePoint[] = [
            { s: 0, g: 0, ease: Easing.Quintic },
            { s: 10, g: 2, ease: Easing.Quintic },
        ];
        const bothCubic: ForcePoint[] = [
            { s: 0, g: 0, ease: Easing.Cubic },
            { s: 10, g: 2, ease: Easing.Cubic },
        ];
        for (let s = 0; s <= 10; s += 0.25) {
            expect(sampleForce(mixed, s)).toBeCloseTo(sampleForce(bothQuintic, s), 12);
        }
        // and Quintic is genuinely distinct from Cubic (guards against a no-op change).
        expect(Math.abs(sampleForce(mixed, 2.5) - sampleForce(bothCubic, 2.5))).toBeGreaterThan(
            0.01,
        );
    });

    test("each key's tag governs its own following segment across a chain", () => {
        // A=Quintic governs A→B; B=Cubic governs B→C; C=Linear is last (governs nothing).
        // so [0,10] matches an all-Quintic segment and [10,20] matches a Cubic-leading
        // segment — the trailing key's tag never reaches back into the prior segment.
        const chain: ForcePoint[] = [
            { s: 0, g: 0, ease: Easing.Quintic },
            { s: 10, g: 2, ease: Easing.Cubic },
            { s: 20, g: 1, ease: Easing.Linear },
        ];
        const quinticSeg: ForcePoint[] = [
            { s: 0, g: 0, ease: Easing.Quintic },
            { s: 10, g: 2, ease: Easing.Quintic },
        ];
        const cubicSeg: ForcePoint[] = [
            { s: 10, g: 2, ease: Easing.Cubic },
            { s: 20, g: 1, ease: Easing.Cubic },
        ];
        for (let s = 0; s <= 10; s += 0.25) {
            expect(sampleForce(chain, s)).toBeCloseTo(sampleForce(quinticSeg, s), 11);
        }
        for (let s = 10; s <= 20; s += 0.25) {
            expect(sampleForce(chain, s)).toBeCloseTo(sampleForce(cubicSeg, s), 11);
        }
    });
});

describe("cubic-bezier evaluation — analytic oracle with explicit handles", () => {
    test("reproduces an independently-evaluated bezier at its own s(t)", () => {
        // A.out and B.in are explicit, forward+backward, combined reach 5 ≤ span 10,
        // so no monotone clamp fires. control points: P0=(0,1) P1=(2,2) P2=(7,2.5)
        // P3=(10,3). evaluate that bezier directly, then assert sampleForce recovers
        // g at each s(t) — a true differential oracle (independent computation).
        const pts: ForcePoint[] = [
            { s: 0, g: 1, out: { ds: 2, dg: 1 } },
            { s: 10, g: 3, in: { ds: -3, dg: -0.5 } },
        ];
        const bez = (a: number, b: number, c: number, d: number, t: number) => {
            const u = 1 - t;
            return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
        };
        for (let t = 0.05; t < 1; t += 0.05) {
            const s = bez(0, 2, 7, 10, t);
            const g = bez(1, 2, 2.5, 3, t);
            expect(sampleForce(pts, s)).toBeCloseTo(g, 9);
        }
    });
});

describe("subdivide — exact de Casteljau split (splitForce's exactness primitive)", () => {
    // an explicit-handle segment (a genuine cubic, not a degenerate Linear/Cubic
    // special case) — the same control points as the "cubic-bezier evaluation" oracle
    // above: P0=(0,1) P1=(2,2) P2=(7,2.5) P3=(10,3).
    const a: ForcePoint = { s: 0, g: 1, out: { ds: 2, dg: 1 } };
    const b: ForcePoint = { s: 10, g: 3, in: { ds: -3, dg: -0.5 } };

    test("the midpoint's g matches the original curve's own sample at the split target", () => {
        for (const target of [1, 3, 4, 6, 8.5]) {
            const sub = subdivide(a, b, target);
            expect(sub.g).toBeCloseTo(sampleForce([a, b], target), 9);
        }
    });

    test("the two subdivided halves reproduce the ORIGINAL curve exactly across the whole span", () => {
        const target = 4;
        const sub = subdivide(a, b, target);
        const mid: ForcePoint = { s: target, g: sub.g, in: sub.inMid, out: sub.outMid };
        const left: ForcePoint = { ...a, out: sub.outA };
        const right: ForcePoint = { ...b, in: sub.inB };
        const subdivided = [left, mid, right];

        for (let s = 0; s <= 10; s += 0.5) {
            expect(sampleForce(subdivided, s)).toBeCloseTo(sampleForce([a, b], s), 9);
        }
    });

    test("both new boundary offsets are non-degenerate (a real split, not a collapse to the endpoint)", () => {
        const sub = subdivide(a, b, 4);
        expect(Math.hypot(sub.outA.ds, sub.outA.dg)).toBeGreaterThan(0);
        expect(Math.hypot(sub.inB.ds, sub.inB.dg)).toBeGreaterThan(0);
        expect(Math.hypot(sub.inMid.ds, sub.inMid.dg)).toBeGreaterThan(0);
        expect(Math.hypot(sub.outMid.ds, sub.outMid.dg)).toBeGreaterThan(0);
    });
});

describe("C1 continuity — flat tangents at every keyframe", () => {
    test("the one-sided slopes at an interior keyframe are both ~0", () => {
        // default-Cubic keyframes have flat (Δg=0) tangents, so g'(s)=0 at each key
        // and the curve is C1. near a flat key g(s) = g_key + ½g''·(s−s_key)² + …, so
        // a one-sided finite difference is O(h): with h=1e-4 and g'' ~ 6Δg/span² the
        // slope is ~1e-4·|Δg|/span, well under the 1e-3 bound asserted.
        const pts: ForcePoint[] = [
            { s: 0, g: 1 },
            { s: 10, g: 3 },
            { s: 20, g: 0 },
        ];
        const h = 1e-4;
        for (const sKey of [10]) {
            const gKey = sampleForce(pts, sKey);
            const left = (gKey - sampleForce(pts, sKey - h)) / h;
            const right = (sampleForce(pts, sKey + h) - gKey) / h;
            expect(Math.abs(left)).toBeLessThan(1e-3);
            expect(Math.abs(right)).toBeLessThan(1e-3);
            expect(gKey).toBeCloseTo(3, 9); // the curve passes through the keyframe
        }
    });
});

describe("x-monotonicity clamp — g(s) stays a function under adversarial handles", () => {
    test("wildly overshooting handles are clamped to a monotone, single-valued curve", () => {
        // out reaches +40 in s, in reaches −40: the raw control s = [0, 40, −30, 10]
        // folds (s(t) non-monotone) and the curve would be multivalued. the clamp
        // scales both handles proportionally (sum 80 > span 10) to s = [0, 5, 5, 10],
        // g flat, so g(s) is a monotone function 0 → 1.
        const pts: ForcePoint[] = [
            { s: 0, g: 0, out: { ds: 40, dg: 0 } },
            { s: 10, g: 1, in: { ds: -40, dg: 0 } },
        ];
        let prev = Number.NEGATIVE_INFINITY;
        for (let s = 0; s <= 10; s += 0.1) {
            const g = sampleForce(pts, s);
            expect(Number.isFinite(g)).toBe(true);
            expect(g).toBeGreaterThanOrEqual(-1e-9); // within the convex hull [0,1]
            expect(g).toBeLessThanOrEqual(1 + 1e-9);
            expect(g).toBeGreaterThanOrEqual(prev - 1e-9); // monotone, no fold-back
            prev = g;
        }
        expect(sampleForce(pts, 0)).toBeCloseTo(0, 9);
        expect(sampleForce(pts, 10)).toBeCloseTo(1, 9);
    });

    test("a vertical explicit out-handle {ds:0} is kept, not flattened — steep departure, monotone", () => {
        // ds=0 with dg≠0 is a legal vertical handle (Blender keeps it): the curve
        // leaves the keyframe with an infinite slope. it does NOT over-reach (its
        // s-length is 0), so its dg survives the clamp. control points:
        // P0=(0,0) P1=(0,1) [the vertical out-handle] P2=(20/3,1) [derived Cubic in]
        // P3=(10,1). the departure is steep (g at small s far above the chord g=s/10)
        // and g(s) is monotone; s'(t) ≥ 0 still holds (p1s = s0, no backward fold).
        const pts: ForcePoint[] = [
            { s: 0, g: 0, out: { ds: 0, dg: 1 } },
            { s: 10, g: 1 },
        ];
        // steep departure: at s=0.5 the chord is only 0.05, the vertical handle lifts it far higher.
        expect(sampleForce(pts, 0.5)).toBeGreaterThan(0.3);
        // monotone across the span, endpoints exact.
        let prev = Number.NEGATIVE_INFINITY;
        for (let s = 0; s <= 10; s += 0.1) {
            const g = sampleForce(pts, s);
            expect(Number.isFinite(g)).toBe(true);
            expect(g).toBeGreaterThanOrEqual(prev - 1e-9);
            prev = g;
        }
        expect(sampleForce(pts, 0)).toBeCloseTo(0, 9);
        expect(sampleForce(pts, 10)).toBeCloseTo(1, 9);
        // analytic oracle: the exact bezier with the vertical handle preserved.
        const bez = (a: number, b: number, c: number, d: number, t: number) => {
            const u = 1 - t;
            return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
        };
        for (let t = 0.05; t < 1; t += 0.05) {
            const s = bez(0, 0, 20 / 3, 10, t);
            const g = bez(0, 1, 1, 1, t);
            expect(sampleForce(pts, s)).toBeCloseTo(g, 8);
        }
    });

    test("a backward-pointing out-handle collapses flat, staying monotone", () => {
        // out.ds < 0 points the wrong way; it clamps to zero reach (a flat endpoint),
        // never producing a backward s-fold.
        const pts: ForcePoint[] = [
            { s: 0, g: 0, out: { ds: -5, dg: 2 } },
            { s: 10, g: 1 },
        ];
        let prev = Number.NEGATIVE_INFINITY;
        for (let s = 0; s <= 10; s += 0.2) {
            const g = sampleForce(pts, s);
            expect(Number.isFinite(g)).toBe(true);
            expect(g).toBeGreaterThanOrEqual(prev - 1e-9);
            prev = g;
        }
    });
});

describe("forceProfile — dense per-edge sampling", () => {
    // edge count itself is `resolveStep`'s own contract (tested above); forceProfile takes the
    // resolved `Step` as one value and trusts its `edges`/`ds` — these pin the MARCH against
    // that step, not the rounding.
    test("marches at the resolved step, sampled at the source σ_i = i·ds", () => {
        const pts: ForcePoint[] = [
            { s: 0, g: 1 },
            { s: 10, g: 3 },
        ];
        const step = resolveStep(10, 0.5);
        const fN = forceProfile(pts, step);
        expect(fN.length).toBe(20); // 10 / 0.5
        // the marched profile equals the from-scratch point query at every σ_i.
        for (let i = 0; i < fN.length; i++)
            expect(fN[i]).toBeCloseTo(sampleForce(pts, i * step.ds), 6);
        expect(fN[0]).toBe(1); // σ = 0 → the first keyframe, held
        expect(fN[10]).toBeCloseTo(2, 5); // σ = 5, the symmetric midpoint of Cubic
    });

    test("the march matches the point query under explicit handles too", () => {
        const pts: ForcePoint[] = [
            { s: 0, g: 1, out: { ds: 3, dg: 0.5 } },
            { s: 8, g: 2, in: { ds: -2, dg: 0.3 } },
            { s: 16, g: 0, ease: Easing.Quintic },
        ];
        const step = resolveStep(16, 0.25);
        const fN = forceProfile(pts, step);
        for (let i = 0; i < fN.length; i++) {
            expect(fN[i]).toBeCloseTo(sampleForce(pts, i * step.ds), 5);
        }
    });

    test("an empty profile of any length is a flat DEFAULT_G", () => {
        const fN = forceProfile([], resolveStep(8, 0.5));
        expect(fN.length).toBe(16);
        for (const v of fN) expect(v).toBe(DEFAULT_G);
    });

    test("a zero-length section still integrates one edge (floored at 1, resolveStep's own floor)", () => {
        expect(forceProfile([], resolveStep(0, 0.5)).length).toBe(1);
    });
});

describe("segmentControls — the resolved control points for the easing glyph", () => {
    test("a preset segment resolves flat handles at its influence", () => {
        // Cubic influence = 1/3: both flat handles reach a third of the span, dg = 0.
        const a: ForcePoint = { s: 0, g: 0, ease: Easing.Cubic };
        const b: ForcePoint = { s: 12, g: 1 };
        const cps = segmentControls(a, b);
        expect(cps.length).toBe(4);
        expect(cps[0]).toEqual({ s: 0, g: 0 });
        expect(cps[3]).toEqual({ s: 12, g: 1 });
        expect(cps[1].s).toBeCloseTo(4, 6); // 1/3 · 12
        expect(cps[1].g).toBeCloseTo(0, 6);
        expect(cps[2].s).toBeCloseTo(8, 6); // 12 − 1/3 · 12
        expect(cps[2].g).toBeCloseTo(1, 6);
    });

    test("Linear collapses the handles onto the chord", () => {
        const cps = segmentControls({ s: 0, g: 0, ease: Easing.Linear }, { s: 10, g: 2 });
        expect(cps[1]).toEqual({ s: 0, g: 0 }); // p1 at the leading keyframe
        expect(cps[2]).toEqual({ s: 10, g: 2 }); // p2 at the trailing keyframe
    });

    test("an explicit out handle is reflected verbatim", () => {
        const a: ForcePoint = { s: 0, g: 0, ease: Easing.Cubic, out: { ds: 2, dg: 0.5 } };
        const cps = segmentControls(a, { s: 10, g: 1 });
        expect(cps[1].s).toBeCloseTo(2, 6);
        expect(cps[1].g).toBeCloseTo(0.5, 6);
    });
});

describe("segmentSeed — the no-jump Custom materialization seed", () => {
    // a preset segment seeds the derived flat tangent verbatim (autoTangent).
    test("a Cubic segment seeds the flat derived tangent (dg = 0)", () => {
        const a: ForcePoint = { s: 0, g: 1, ease: Easing.Cubic };
        const b: ForcePoint = { s: 12, g: 3 };
        expect(segmentSeed(a, b, "out")).toEqual({ ds: 4, dg: 0 }); // 1/3 · 12, flat
        expect(segmentSeed(a, b, "in")).toEqual({ ds: -4, dg: 0 });
    });

    // the Linear special case: a plain Linear autoTangent is zero-length (ungrabbable, sits on
    // the diamond), so a Linear segment seeds CHORD-ALIGNED at influence 1/3 — grabbable handles
    // whose control points still land on the chord, so the sampled curve is byte-identical.
    test("Custom on a Linear segment: chord-aligned seed, grabbable handles, byte-identical profile", () => {
        const a: ForcePoint = { s: 0, g: 1, ease: Easing.Linear };
        const b: ForcePoint = { s: 12, g: 3 };
        const slope = (b.g - a.g) / (b.s - a.s); // 2/12 = 1/6
        const seedOut = segmentSeed(a, b, "out");
        const seedIn = segmentSeed(a, b, "in");

        // grabbable: nonzero-length (unlike the plain Linear autoTangent), reaching 1/3 the span.
        expect(seedOut.ds).toBeCloseTo(4, 12); // 1/3 · 12
        expect(seedIn.ds).toBeCloseTo(-4, 12);
        expect(Math.hypot(seedOut.ds, seedOut.dg)).toBeGreaterThan(1);
        expect(Math.hypot(seedIn.ds, seedIn.dg)).toBeGreaterThan(1);
        // chord-aligned: dg = chordSlope · ds on both sides (both control points on the chord).
        expect(seedOut.dg).toBeCloseTo(slope * seedOut.ds, 12);
        expect(seedIn.dg).toBeCloseTo(slope * seedIn.ds, 12);

        // byte-identical: the materialized explicit-handle segment draws the exact same straight
        // line as the plain Linear tag (the profile output is unchanged), now with real handles.
        const aCustom: ForcePoint = { ...a, out: seedOut };
        const bCustom: ForcePoint = { ...b, in: seedIn };
        const step = resolveStep(12, 0.1);
        const linear = forceProfile([a, b], step);
        const custom = forceProfile([aCustom, bCustom], step);
        expect(custom).toEqual(linear);
    });
});

describe("resolveStep — the ONE seam pairing a force section's edge count with its step", () => {
    // resolveStep is f64 (plain JS numbers), not the f32 display bake — so its own
    // conforming identity (edges·ds === length) is bounded by f64 rounding: one
    // division (length/edges) then one multiplication (edges·ds) back, each within
    // Number.EPSILON relative, so 2·Number.EPSILON·length covers both roundings.
    function conformTol(length: number): number {
        return 2 * Number.EPSILON * Math.max(length, 1);
    }

    test("edges = max(1, round(length/step)) and edges·ds conforms to length (off-grid table)", () => {
        // the spec's measured table (kex2d-section-extent, Locked decision): ds against
        // off-grid lengths that land the realized extent short/long under the naive step.
        const cases: Array<{ ds: number; length: number }> = [
            { ds: 0.5, length: 24.0 },
            { ds: 0.5, length: 12.345 },
            { ds: 0.5, length: 23.7 },
            { ds: 0.25, length: 12.345 },
            { ds: 0.1, length: 12.345 },
        ];
        for (const { ds, length } of cases) {
            const { edges, ds: dsOut } = resolveStep(length, ds);
            expect(Math.abs(edges * dsOut - length)).toBeLessThan(conformTol(length));
        }
    });

    test("a conformed step is a fixed point: re-resolving it is a no-op (sweep)", () => {
        // 4 steps × ~430 off-grid lengths, mirroring the spec's measured sweep shape.
        const steps = [0.5, 0.25, 0.1, 0.05];
        let count = 0;
        for (const step of steps) {
            for (let i = 1; i <= 430; i++) {
                const length = i * 0.2371 + 0.0413; // irrational-ish increment: stays off-grid
                const first = resolveStep(length, step);
                const second = resolveStep(length, first.ds);
                expect(second.edges).toBe(first.edges);
                expect(second.ds).toBe(first.ds); // bit-identical, not just close
                // crosses the f32 `Section.ds` column the fixed-point claim is actually about
                // (a converted section's stored step) — `first.ds` alone never leaves f64.
                expect(resolveStep(length, Math.fround(first.ds)).edges).toBe(first.edges);
                count++;
            }
        }
        expect(count).toBe(steps.length * 430);
    });

    test("the max(1, …) floor: a length shorter than step still yields one edge spanning it exactly", () => {
        const { edges, ds } = resolveStep(0.3, 2.0);
        expect(edges).toBe(1);
        expect(ds).toBe(0.3); // length/1 === length, bit-identical
    });

    test("an on-grid length is untouched: the exact multiple returns the nominal step", () => {
        const { edges, ds } = resolveStep(24.0, 0.5);
        expect(edges).toBe(48);
        expect(ds).toBe(0.5);
    });
});

// `kex2d-section-extent` stage 3 — the source pin: no production module builds a force
// section's own `(edges, ds)` pair outside the `resolveStep` seam above. Declared-registry
// law (`editor-ui.md` Menus): enumerate the population FROM SOURCE, walk the tree
// RECURSIVELY, assert BOTH directions (an undeclared site fails; an orphan declaration
// fails), and carry a POSITIVE CONTROL per direction that exercises the SCANNER, not just
// the set comparison (the cursor-allowlist lesson, same file).
describe("force-payload pairing population is closed (kex2d-section-extent stage 3)", () => {
    const srcRoot = join(import.meta.dir, "..", "src");
    const src = (file: string): string => readFileSync(join(srcRoot, file), "utf8");

    // recursive — a flat `readdirSync` sees only the top level, so a future nested module
    // would be invisible to the census below while it stayed green (menu.test.ts's own clause).
    function collectSrc(dir: string, prefix = ""): string[] {
        return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) return collectSrc(join(dir, entry.name), rel);
            return entry.name.endsWith(".ts") ? [rel] : [];
        });
    }
    const srcFiles = collectSrc(srcRoot);

    // ── direction A: no OTHER module hand-rolls the ROUNDED-QUOTIENT edge-count shape
    // `resolveStep` owns. Named on the SHAPE, not on variable names: a variable-name-keyed
    // regex (`len`/`length` × `ds`/`step`) stayed green when a hand-rolled pairing was spelled
    // `Math.round(length / quantum)` — this codebase already renames this way (`polish.ts:354`'s
    // `const h = sp.ds;`). The invariant is "nobody derives an edge count by rounding a quotient
    // except `resolveStep`", so the census is name-free: any `Math.(round|ceil|floor|trunc)(...)`
    // whose argument contains a bare `/` (no nested call breaking the single-level scan — a
    // structure-free match, editor-ui.md's cursor-allowlist lesson).
    const RoundShape = /Math\.(?:round|ceil|floor|trunc)\([^()]*\/[^()]*\)/;
    // The whole population, censused against the current tree: 12 sites across 7 files.
    // `profile.ts` carries only the seam itself (`resolveStep`) now — `forceProfile` no longer
    // re-derives `edges` locally (`kex2d-correctness-fixes` stage 1: it takes the resolved
    // `Step` as one value and trusts its `edges`), so the module's own hit count dropped from 2
    // to 1. It's excluded from the outside-profile.ts check below as the seam's own home, not
    // the census.
    const RoundShapeSites: Record<string, string> = {
        "section.ts":
            "the σ-index lookup `fN[round(σ/ds)]` (the Distance closure) — an index, not a pairing",
        "spline.ts": "the geo variable-chord rule — a different domain, not a force pairing",
        "magnet.ts": "snap/grid quantizers — not edge counts",
        "timeline.ts": "snap/grid quantizers — not edge counts",
        "fvdlab.ts": "lab sample count, not production",
        "collocatelab.ts": "lab sample count, not production",
    };
    test("no module outside profile.ts hand-rolls a rounded-quotient edge-count shape", () => {
        const hits = srcFiles.filter((f) => RoundShape.test(src(f)));
        expect(hits.sort()).toEqual(["profile.ts", ...Object.keys(RoundShapeSites)].sort());
        for (const f of hits) if (f !== "profile.ts") expect(RoundShapeSites[f]).toBeDefined();
    });
    // positive control: an independent read over the SAME enumeration path (`collectSrc` +
    // `readFileSync`, not a synthetic string handed to `.test()` in isolation) — a raw,
    // structure-free match count across every scanned file's raw content must equal the
    // declared per-file count, closing editor-ui.md's declared-registry law's own lesson (a
    // control that never routes through the real scanner can't catch the scanner going blind).
    const RoundShapeCounts: Record<string, number> = {
        "profile.ts": 1,
        "section.ts": 1,
        "spline.ts": 1,
        "magnet.ts": 3,
        "timeline.ts": 4,
        "fvdlab.ts": 1,
        "collocatelab.ts": 1,
    };
    test("positive control: the raw match count over all scanned source equals the declared site count", () => {
        const global = new RegExp(RoundShape.source, "g");
        const rawTotal = srcFiles.reduce((sum, f) => sum + (src(f).match(global)?.length ?? 0), 0);
        const declaredTotal = Object.values(RoundShapeCounts).reduce((a, b) => a + b, 0);
        expect(declaredTotal).toBe(12);
        expect(rawTotal).toBe(declaredTotal);
    });

    // ── direction B: every module that pairs a step with `forceProfile`/`evalForce` (the
    // seam's two consumers) is seamed through `resolveStep` itself, or is a declared exemption
    // consuming an already-conformed `Step` from upstream. Only `profile.ts` (defines both
    // `resolveStep` and `forceProfile`) is excluded by construction, as the seam's own home.
    //
    // What used to live below this point — a lexical, per-call-site scanner tracing whether the
    // THIRD ARGUMENT at each `forceProfile`/`evalForce` call site was a `ds` bound by
    // `resolveStep` in scope — is now the type system's job. `forceProfile(points, step)` and
    // `evalForce(entry, fN, step, domain)` (`kex2d-correctness-fixes` stage 1) take the resolved
    // {@link Step} as ONE argument the callee requires: there is no positional `ds: number` slot
    // left to hand an unconformed value into, so splitting the pair — destructuring `edges` alone
    // and marching on some OTHER `ds` — is a type error, not a runtime latent bug a lexical scan
    // has to catch after the fact. That closes the per-call-site pin's whole reason to exist,
    // `CrossFunctionConsumers` included: `track.ts`'s `forceDense`, `pin.ts`'s `enterPin`, and
    // `polish.ts`'s `violence` each existed only because the old scanner couldn't see a `ds`
    // conformed in one function and threaded as a bare parameter into another — now each of them
    // takes a `Step`-typed parameter directly, so the exemption is retired, not merely deleted:
    // the file-level census below is what remains to enumerate, and its `Seamed`/`PairingExempt`
    // split still records WHY each module touches the seam, since that's a fact the type doesn't
    // carry on its own.
    const Seamed = ["track.ts", "pin.ts", "optimize.ts", "polish.ts"];
    const PairingExempt: Record<string, string> = {
        "playback.ts": "consumes an already-conformed `Step` off a landed solve's own answer",
        "fitlab.ts": "consumes an already-conformed `Step` off a landed solve's own answer",
        "fit.ts":
            "a JSDoc @example only, no runtime call — fit.ts never touches a section's baking step",
        "section.ts":
            "chain()'s evalForce call consumes sec.step, which traces through track.ts's forcePayload/forceBake to resolveStep — a conformed Step, not a second independent pairing",
    };
    // the census logic, factored out so the positive controls below exercise the SAME function
    // the real test calls (editor-ui.md's declared-registry law: a control must exercise the
    // scanner, not just re-derive its assertion) — against synthetic input, since faking an
    // undeclared or orphaned entry in the REAL source tree isn't practical to inject.
    function unaccountedCallers(
        files: readonly string[],
        contents: (file: string) => string,
        declared: ReadonlySet<string>,
    ): { undeclared: string[]; orphaned: string[] } {
        const callers = files.filter(
            (f) =>
                f !== "profile.ts" &&
                (contents(f).includes("forceProfile(") || contents(f).includes("evalForce(")),
        );
        return {
            undeclared: callers.filter((f) => !declared.has(f)),
            orphaned: [...declared].filter((f) => !callers.includes(f)),
        };
    }
    test("every caller of forceProfile/evalForce is seamed through resolveStep, or a declared exemption", () => {
        const declared = new Set([...Seamed, ...Object.keys(PairingExempt)]);
        const { undeclared, orphaned } = unaccountedCallers(srcFiles, src, declared);
        expect(undeclared).toEqual([]);
        expect(orphaned).toEqual([]);
        // a floor, not the invariant: a module can MENTION resolveStep while still handing
        // forceProfile/evalForce a Step that never went through it — the type change (stage 1)
        // is what actually closes that gap; this floor only proves the module reaches the seam.
        for (const f of Seamed) expect(src(f).includes("resolveStep(")).toBe(true);
    });
    // positive control, direction 1: a caller not in the declared set is flagged undeclared.
    test("positive control: an undeclared caller is caught", () => {
        const { undeclared } = unaccountedCallers(
            ["mystery.ts"],
            () => "forceProfile(points, step)",
            new Set(),
        );
        expect(undeclared).toEqual(["mystery.ts"]);
    });
    // positive control, direction 2: a declared entry with no real call is flagged orphaned.
    test("positive control: an orphaned declaration is caught", () => {
        const { orphaned } = unaccountedCallers([], () => "", new Set(["ghost.ts"]));
        expect(orphaned).toEqual(["ghost.ts"]);
    });
    // F4: aliased-import evasion. A raw substring scan for `forceProfile(`/`evalForce(` is
    // blind to `import { forceProfile as fp } from "./profile"` followed by `fp(...)`, or a
    // bare-reference hold (`const f = forceProfile; f(...)`). No file does this today; the check
    // closes the aliased-import half cheaply — a textual scan of import statements only, no AST.
    function hasAliasedImport(text: string): boolean {
        return text
            .split("\n")
            .filter((line) => line.trimStart().startsWith("import"))
            .some((line) => /\b(?:forceProfile|evalForce)\s+as\s+\w+/.test(line));
    }
    test("no import aliases forceProfile or evalForce (closes the aliased-import evasion)", () => {
        const aliased = srcFiles.filter((f) => hasAliasedImport(src(f)));
        expect(aliased).toEqual([]);
    });
    test("positive control: the alias detector catches an aliased import", () => {
        expect(hasAliasedImport('import { forceProfile as fp } from "./profile";')).toBe(true);
        expect(hasAliasedImport('import { evalForce as ef } from "./section";')).toBe(true);
        expect(hasAliasedImport('import { forceProfile } from "./profile";')).toBe(false);
    });
    test("positive control: the walk reaches the declared population", () => {
        for (const f of [...Seamed, ...Object.keys(PairingExempt), "profile.ts", "spline.ts"])
            expect(srcFiles).toContain(f);
        // a floor, not the exact count: the walk must be reading the whole module tree, not one
        // lucky directory entry.
        expect(srcFiles.length).toBeGreaterThan(30);
    });
});
