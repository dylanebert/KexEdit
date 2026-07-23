import { describe, expect, test } from "bun:test";
import {
    DEFAULT_G,
    Easing,
    type ForcePoint,
    forceProfile,
    sampleForce,
    segmentControls,
    segmentSeed,
} from "../src/profile";

// the force-authoring layer (kex2d/CLAUDE.md, force authoring): authored force
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
    test("edge count is round(length/ds), sampled at the source σ_i = i·ds", () => {
        const pts: ForcePoint[] = [
            { s: 0, g: 1 },
            { s: 10, g: 3 },
        ];
        const ds = 0.5;
        const length = 10;
        const fN = forceProfile(pts, length, ds);
        expect(fN.length).toBe(20); // 10 / 0.5
        // the marched profile equals the from-scratch point query at every σ_i.
        for (let i = 0; i < fN.length; i++) expect(fN[i]).toBeCloseTo(sampleForce(pts, i * ds), 6);
        expect(fN[0]).toBe(1); // σ = 0 → the first keyframe, held
        expect(fN[10]).toBeCloseTo(2, 5); // σ = 5, the symmetric midpoint of Cubic
    });

    test("the march matches the point query under explicit handles too", () => {
        const pts: ForcePoint[] = [
            { s: 0, g: 1, out: { ds: 3, dg: 0.5 } },
            { s: 8, g: 2, in: { ds: -2, dg: 0.3 } },
            { s: 16, g: 0, ease: Easing.Quintic },
        ];
        const ds = 0.25;
        const fN = forceProfile(pts, 16, ds);
        for (let i = 0; i < fN.length; i++) {
            expect(fN[i]).toBeCloseTo(sampleForce(pts, i * ds), 5);
        }
    });

    test("an empty profile of any length is a flat DEFAULT_G", () => {
        const fN = forceProfile([], 8, 0.5);
        expect(fN.length).toBe(16);
        for (const v of fN) expect(v).toBe(DEFAULT_G);
    });

    test("a zero-length section still integrates one edge (floored at 1)", () => {
        expect(forceProfile([], 0, 0.5).length).toBe(1);
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
        const linear = forceProfile([a, b], 12, 0.1);
        const custom = forceProfile([aCustom, bCustom], 12, 0.1);
        expect(custom).toEqual(linear);
    });
});
