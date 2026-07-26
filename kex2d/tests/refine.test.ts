/** the refine loop — the conversion tier's discrete outer refinement (`src/refine.ts`).
 *
 *  The corpus sweep is the expensive gate, so it runs ONCE at module scope and every
 *  assertion below reads that one result. Two measurement caveats carry over from the
 *  spike's verdict: violence numbers are ds-dependent (compare only at the same
 *  `scenario.ds`), and a census is a final-frame reading. */

import { describe, expect, test } from "bun:test";
import { authoringFloor, spine, violence } from "../src/polish";
import { collinear, forceProfile } from "../src/profile";
import {
    cornerSite,
    type Frame,
    over,
    refine,
    type RefineResult,
    residual,
    siteIn,
    splitSite,
} from "../src/refine";
import { scenarios } from "../src/scenarios";
import { type Entry, evalForce, evalGeo, type SectionResult } from "../src/section";
import { reflect, TangentMode, type Node, type Tangent } from "../src/spline";

interface Case {
    name: string;
    bake: SectionResult;
    entry: Entry;
    ds: number;
    r: RefineResult;
}

const t0 = performance.now();
const CORPUS: Case[] = scenarios.map((s) => {
    const entry: Entry = { x: 0, y: 0, theta: 0, v: s.v0 };
    const bake = evalGeo(entry, s.nodes, s.ds);
    return { name: s.name, bake, entry, ds: s.ds, r: refine({ bake, entry, ds: s.ds }) };
});
const CORPUS_MS = performance.now() - t0;

const pick = (name: string): Case => {
    const c = CORPUS.find((x) => x.name === name);
    if (!c) throw new Error(`no scenario ${name}`);
    return c;
};

/** the answer re-integrated through the LIVE f32 `evalForce` path and measured against the
 *  bake by arclength — the state variable is then the shipped integrator's, not the solver's
 *  own spine.
 *
 *  `ds` is a PARAMETER, not a detail: `polish` solves on the grid `spine` builds, whose step is
 *  `length/edges` so the section spans the bake's arclength exactly (`polish.spine` argues why
 *  — an exit pin is meaningless on a section that ends somewhere the original never was). A
 *  force section carries its own `ds` (`section.ts`'s `{ kind: "force"; fN; ds }`), so a
 *  converted section MUST store that realized step. Loading the same profile at the nominal
 *  step instead marches `edges·dsNominal ≠ length` and shifts every sample's σ — measured
 *  below, that costs up to 7× the floor. */
function reference(c: Case, ds = c.r.final.ds): number {
    const { points, length } = c.r.final;
    const out = evalForce(c.entry, forceProfile(points, length, ds), ds);
    const sigma = [0];
    for (let i = 0; i < c.bake.edges; i++) sigma.push(sigma[i] + c.bake.ds[i]);
    const total = sigma[c.bake.edges];
    let dev = 0;
    let i = 0;
    for (let j = 0; j <= out.edges; j++) {
        const a = Math.min(j * ds, total);
        while (i < c.bake.edges - 1 && sigma[i + 1] < a) i++;
        const span = sigma[i + 1] - sigma[i];
        const t = span > 0 ? Math.min(1, Math.max(0, (a - sigma[i]) / span)) : 0;
        const x = c.bake.posX[i] + t * (c.bake.posX[i + 1] - c.bake.posX[i]);
        const y = c.bake.posY[i] + t * (c.bake.posY[i + 1] - c.bake.posY[i]);
        dev = Math.max(dev, Math.hypot(out.posX[j] - x, out.posY[j] - y));
    }
    return dev;
}

/** keyframe counts, stage-2's shipping baseline (calm + aligned at the FIT's knots) against
 *  what the refine loop settles on. The baseline column is measured, not re-solved here — a
 *  second full λ-search per scenario would double this file's cost to re-derive a number
 *  stage 2 already published. Regenerate both with `tests/attribution.lab.ts`. */
const KEYS: Record<string, { base: number; refined: number }> = {
    "circular-arc": { base: 4, refined: 3 },
    "parabola-hill": { base: 12, refined: 11 },
    "full-loop": { base: 7, refined: 7 },
    "s-curve": { base: 16, refined: 15 },
    "straight-fillet": { base: 6, refined: 5 },
    "hill-auto": { base: 13, refined: 8 },
    "hill-explicit": { base: 15, refined: 9 },
    "loop-explicit": { base: 32, refined: 13 },
    "double-hump": { base: 22, refined: 14 },
    "valley-explicit": { base: 11, refined: 9 },
};

describe("refine — the corpus contract", () => {
    test("every scenario holds the authoring floor", () => {
        for (const c of CORPUS) {
            expect(c.r.final.converged).toBe(true);
            expect(c.r.final.heldFloor).toBe(true);
            expect(c.r.final.deviation).toBeLessThanOrEqual(c.r.floor);
        }
        // the one the tier was built for: valley-explicit misses by 2.78x at the fit's fixed
        // knots (0.288 m against a 0.1035 m floor, in BOTH exact and calm — stage 1's
        // finding that placement is the only lever there). It holds here.
        expect(pick("valley-explicit").r.final.deviation).toBeLessThan(0.288);
    });

    test("the answer holds the floor through the live f32 path too", () => {
        // the solver's spine is f64 and its own state variable; this integrates the profile
        // through the shipped f32 path at the step the solve targeted. They agree to well under
        // the floor everywhere. Tightest margin is parabola-hill at ~8e-7 m (relative 1.5e-5) —
        // deterministic here, but `Math.sin`/`cos`/`atan2` are not bit-identical across JS
        // engines, so read a failure at that scale as an engine difference, not a regression.
        for (const c of CORPUS) {
            const dev = reference(c);
            expect(dev).toBeLessThanOrEqual(c.r.floor);
            expect(Math.abs(dev - c.r.final.deviation)).toBeLessThan(1e-3);
        }
    });

    test("the converted section must carry the solve's own ds", () => {
        // THE STAGE-7 CONTRACT, pinned as measured. The floor is held on the grid the solve
        // targeted; the same profile marched at the nominal step is a different section, and
        // on half the corpus it misses the floor by multiples. This is not a solver defect —
        // `spine` chooses `length/edges` deliberately — but it IS a trap the conversion command
        // can fall into silently, so the cost is recorded here rather than discovered there.
        const ratios = CORPUS.map((c) => {
            expect(c.r.final.ds).toBeCloseTo(c.r.final.length / c.r.final.edges, 12);
            return { name: c.name, over: reference(c, c.ds) / c.r.floor };
        });
        // Five of ten miss by a MULTIPLE of the floor (2.7x to 7.2x); the other five sit within
        // rounding of it, so the split is read at 2x rather than at 1x where three scenarios
        // straddle the line.
        expect(
            ratios
                .filter((x) => x.over > 2)
                .map((x) => x.name)
                .sort(),
        ).toEqual(["double-hump", "full-loop", "hill-auto", "hill-explicit", "valley-explicit"]);
        expect(Math.max(...ratios.map((x) => x.over))).toBeGreaterThan(7);
    });

    test("key counts at or under the stage-2 baseline", () => {
        for (const c of CORPUS) {
            const k = KEYS[c.name];
            expect(c.r.final.keys).toBe(k.refined);
            expect(c.r.final.keys).toBeLessThanOrEqual(k.base);
            expect(c.r.knots.length).toBe(c.r.final.keys);
        }
        // the tier's authorability headline, read off the solves rather than off the table:
        // 138 baseline keys across the corpus become 94.
        const refined = CORPUS.reduce((a, c) => a + c.r.final.keys, 0);
        expect(refined).toBe(94);
    });

    test("the exit stays pinned in the recovered convention", () => {
        // stage 2's contract: the quantity `chain()` hands downstream, three decades under
        // the 0.1 deg readout quantum. The refine loop must not loosen it.
        for (const c of CORPUS) {
            expect(Math.abs(c.r.final.exit.dtheta)).toBeLessThan(1e-5);
            expect(c.r.final.exit.dist).toBeLessThan(1e-5);
        }
    });

    test("no key is broken unless it is a corner", () => {
        // the vocabulary claim, scale-free (`profile.collinear`) — the aligned family cannot
        // express a broken key, so any that appears came from the refine loop's discrete
        // state, deliberately. No corpus scenario needs one at its derived floor.
        for (const c of CORPUS) {
            const broken = c.r.final.points.filter((p) => !collinear(p.in, p.out)).length;
            expect(broken).toBe(c.r.cornerKnots.length);
            expect(c.r.cornerKnots).toEqual([]);
        }
    });

    test("the dense peak is visible in the keyframes", () => {
        // the spike's defect: valley-explicit's polished keys spanned [-6.5, 2.6] g while the
        // curve between them reached 40 g — violence invisible in the diamonds, so an author
        // could neither see nor grab it. Pinned as measured; the gap is now a fraction of a g
        // everywhere except valley-explicit, whose target geometry genuinely peaks at 38.3 g.
        const gaps: Record<string, number> = {
            "circular-arc": 0.04,
            "parabola-hill": 0.0,
            "full-loop": 0.0,
            "s-curve": 0.2,
            "straight-fillet": 0.29,
            "hill-auto": 0.44,
            "hill-explicit": 0.16,
            "loop-explicit": -0.15,
            "double-hump": 0.41,
            "valley-explicit": 3.75,
        };
        for (const c of CORPUS) {
            const { peakG } = violence(c.r.final.points, c.r.final.length, c.r.final.ds);
            const keyPeak = Math.max(...c.r.final.points.map((p) => Math.abs(p.g)));
            expect(peakG - keyPeak).toBeCloseTo(gaps[c.name], 1);
        }
    });

    test("every pruned state is one the split trigger would not fire on", () => {
        // THE HYSTERESIS, as the invariant rather than as the code's shape. Asserting that
        // prunes come last only restates that the loop is two sequential blocks and cannot
        // fail. What actually has to hold is that a prune never lands somewhere a split would
        // re-fire: split fires while the floor is VIOLATED, a prune is accepted only from a
        // counterfactual that HOLDS it, so every post-prune state must hold the floor. The two
        // rules are exact complements at one threshold, which is why the band needs no width.
        let pruned = 0;
        for (const c of CORPUS)
            for (const e of c.r.events)
                if (e.kind === "prune") {
                    expect(e.deviation).toBeLessThanOrEqual(c.r.floor);
                    pruned++;
                }
        // the assertion above is vacuous if nothing prunes, so pin that it is exercised.
        expect(pruned).toBeGreaterThan(5);
        for (const c of CORPUS) expect(c.r.events[0].kind).toBe("init");
    });

    test("same bake in, same refinement out", () => {
        const c = pick("straight-fillet");
        const again = refine({ bake: c.bake, entry: c.entry, ds: c.ds });
        expect(again.knots).toEqual(c.r.knots);
        expect(again.cornerKnots).toEqual(c.r.cornerKnots);
        expect(again.events).toEqual(c.r.events);
        expect(again.final.points).toEqual(c.r.final.points);
        expect(again.final.lambda).toBe(c.r.final.lambda);
    });

    test("the corpus refine stays inside its measured budget", () => {
        // measured 53 s over the 10 scenarios (2026-07-26, WSL2). The ceiling is a regression
        // tripwire for the loop's solve count — the split phase costs about one unregularized
        // probe per key, and the prune phase probes every candidate every round because the
        // scan is exhaustive by design — not a machine-speed bar, so it sits clear of the
        // measurement.
        expect(CORPUS_MS).toBeLessThan(150_000);
        // the cost discipline that makes it affordable: candidates are probed at lambda = 0
        // (one solve) and the full discrepancy search runs once per scenario.
        // every probe is one solve; the final search is the only multi-solve call.
        for (const c of CORPUS) expect(c.r.solves).toBe(c.r.probes + c.r.final.solves);
    });
});

// ---- the corner: the one discrete state, and the budget outcome ----

/** a sharp V with a `Free` tangent at the trough — a genuine slope discontinuity in the
 *  target, which is what a corner is for. Compact on purpose: the corner path only engages
 *  under a floor far tighter than this shape's derived one (0.26 m — the chord deficit of a
 *  98 g spike is large), so the fixture drives it with an explicit `floor`, which is exactly
 *  what that option exists for. */
function sharpValley(): { bake: SectionResult; entry: Entry; ds: number } {
    const t: Tangent = { mode: TangentMode.Free, inX: 5, inY: -6, outX: 5, outY: 10 };
    const dip: Node = { x: 14, y: -5, theta: 0, tangent: t };
    const exit = Math.atan2(t.outY, t.outX);
    const p3 = { x: 30, y: -3 };
    const nodes: Node[] = [
        { x: 0, y: 0, theta: 0 },
        dip,
        { ...p3, theta: reflect(exit, Math.atan2(p3.y - dip.y, p3.x - dip.x)) },
    ];
    const entry: Entry = { x: 0, y: 0, theta: 0, v: 14 };
    return { bake: evalGeo(entry, nodes, 0.5), entry, ds: 0.5 };
}

describe("refine — corners and the key budget", () => {
    const fx = sharpValley();
    const tight = refine({ ...fx, floor: 0.05 });

    test("a corner is introduced only by a stall", () => {
        const kinds = tight.events.map((e) => e.kind);
        expect(kinds).toContain("corner");
        // the trigger law: nothing else may precede a corner.
        for (let i = 0; i < kinds.length; i++)
            if (kinds[i] === "corner") expect(kinds[i - 1]).toBe("stall");
    });

    test("corners are interior, ascending, and reach the solve", () => {
        expect(tight.cornerKnots.length).toBeGreaterThan(0);
        for (let i = 0; i < tight.cornerKnots.length; i++) {
            const k = tight.knots.indexOf(tight.cornerKnots[i]);
            expect(k).toBeGreaterThan(0);
            expect(k).toBeLessThan(tight.knots.length - 1);
            if (i > 0) expect(tight.cornerKnots[i]).toBeGreaterThan(tight.cornerKnots[i - 1]);
        }
        expect(tight.final.corners).toEqual(tight.cornerKnots.map((c) => tight.knots.indexOf(c)));
    });

    test("only a corner key can census broken, and here every one does", () => {
        // The structural half is the vocabulary claim and holds by construction: a non-corner
        // key's two sides share one slope, so it cannot census broken. The converse is a
        // MEASURED pin, not a guarantee — a corner whose two slopes happened to converge
        // would census collinear and is not a defect. Pinned so a corner quietly collapsing
        // to a plain key across the corpus is visible.
        const broken = tight.final.points
            .map((p, i) => (collinear(p.in, p.out) ? -1 : i))
            .filter((i) => i >= 0);
        for (const i of broken) expect(tight.final.corners).toContain(i);
        expect(broken).toEqual(tight.final.corners);
    });

    test("a floor the shape cannot reach ends at the key budget, not in a loop", () => {
        const kinds = tight.events.map((e) => e.kind);
        expect(kinds[kinds.length - 1]).toBe("budget");
        expect(tight.final.heldFloor).toBe(false);
        // the sanctioned outcome: un-authorable is reported, never thrown, and the profile
        // still comes back usable. And the prune phase never runs on it — a refinement that
        // missed the floor is not thinned further.
        expect(kinds).not.toContain("prune");
        expect(tight.final.points.length).toBe(tight.knots.length);
    });

    test("at its own derived floor the same shape needs no corner", () => {
        const r = refine(fx);
        expect(r.final.heldFloor).toBe(true);
        expect(r.cornerKnots).toEqual([]);
        expect(r.floor).toBeCloseTo(authoringFloor(spine(fx.bake, fx.ds)), 12);
    });
});

// ---- the selection rule, directly ----

describe("refine — the placement rules", () => {
    // a uniform dense frame: 41 samples 1 m apart, a spine step of 1, so the observability
    // floor is 2 m and spine sample j sits at arclength j. Uniform on purpose — every quantity
    // below is then hand-computable, which is the point of testing these apart from a solve.
    const sigma = new Float64Array(41);
    for (let i = 0; i < 41; i++) sigma[i] = i;
    const f: Frame = { sigma, ds: 1, minSpan: 2 };
    /** a deviation profile that is `v` on `[lo, hi)` in spine index and 0 elsewhere. */
    const devs = (lo: number, hi: number, v: number, n = 41): Float64Array => {
        const d = new Float64Array(n);
        for (let j = lo; j < hi; j++) d[j] = v;
        return d;
    };

    test("a uniform residual splits at the midpoint", () => {
        // equidistribution on a flat residual IS bisection — the property that keeps sibling
        // spans comparable and the 1/span^3 pricing with them.
        const segs = residual(f, [0, 40], devs(1, 41, 0.5));
        expect(segs.length).toBe(1);
        expect(segs[0].worst).toBe(0.5);
        expect(segs[0].half).toBeCloseTo(20, 0);
        expect(splitSite(f, [0, 40], devs(1, 41, 0.5)).site).toBeCloseTo(20, 0);
    });

    test("a residual banked at one end still splits inside it, never against the knot", () => {
        // the whole reason equidistribution replaced peak-splitting: the peak here is at
        // arclength 2, one sample off the left knot, and a peak rule would put the knot at the
        // admissible index nearest it — index 2, leaving a 2 m sliver beside a 38 m parent.
        // Equidistribution halves the residual mass instead, so the cut lands inside the bank.
        const d = devs(1, 9, 1);
        const segs = residual(f, [0, 40], d);
        expect(segs[0].half).toBeGreaterThan(3);
        expect(segs[0].half).toBeLessThan(6);
        const { site } = splitSite(f, [0, 40], d);
        expect(site).toBeGreaterThan(2);
        expect(site).toBeLessThan(7);
    });

    test("the worst segment picks, and ties break toward the lower index", () => {
        const knots = [0, 10, 20, 40];
        // segment 1 (arclength 10..20) carries the worst residual, so it is cut.
        expect(splitSite(f, knots, devs(11, 20, 2)).seg).toBe(1);
        // an all-equal residual leaves every segment tied; the lower index wins.
        expect(splitSite(f, knots, devs(1, 41, 1)).seg).toBe(0);
    });

    test("a split never leaves either half under the observability floor", () => {
        // `minSpan` = 2 m here, so a 4 m segment admits exactly its midpoint and a 3 m one
        // admits nothing — the derived key budget, at its boundary.
        expect(siteIn(f, 0, 4, 2)).toBe(2);
        expect(siteIn(f, 0, 3, 1.5)).toBe(-1);
        expect(siteIn(f, 0, 2, 1)).toBe(-1);
        // and the preference is the nearest admissible index to the target, not the target.
        expect(siteIn(f, 0, 10, 1)).toBe(2);
        expect(siteIn(f, 0, 10, 9)).toBe(8);
        expect(siteIn(f, 0, 10, 5)).toBe(5);
    });

    test("no admissible site anywhere is the key budget", () => {
        // every segment is 2 m, so no child could keep its own sample.
        const knots = [0, 2, 4, 6];
        expect(splitSite(f, knots, devs(1, 7, 1)).site).toBe(-1);
    });

    test("a segment bracketing no sample reads 0, not a sentinel", () => {
        // `over` floors at 0, so a negative sentinel here would score an unobservable region as
        // an improvement and every split into one would look like it worked.
        const segs = residual(f, [0, 1, 40], devs(2, 41, 0.5));
        expect(segs[0].worst).toBe(0);
        expect(segs[0].half).toBeGreaterThan(0);
        expect(over(segs, 0, 0)).toBe(0);
    });

    test("over reads exactly the region it is given, and clamps to the ends", () => {
        const segs = [
            { worst: 1, half: 0 },
            { worst: 5, half: 0 },
            { worst: 2, half: 0 },
        ];
        expect(over(segs, 0, 0)).toBe(1);
        expect(over(segs, 0, 1)).toBe(5);
        expect(over(segs, 2, 2)).toBe(2);
        expect(over(segs, -3, 99)).toBe(5);
    });

    test("the tail past the last knot belongs to the last segment", () => {
        // the final knot sits one dense edge short of the extent (`fit.arclength`), so the
        // samples beyond it are the flat hold that key drives and must be attributed to it.
        const segs = residual(f, [0, 10, 20], devs(21, 41, 3));
        expect(segs.length).toBe(2);
        expect(segs[1].worst).toBe(3);
        expect(segs[0].worst).toBe(0);
    });

    test("a corner goes to the interior knot nearest the peak, skipping the ones taken", () => {
        const knots = [0, 10, 20, 30, 40];
        const d = new Float64Array(41);
        d[21] = 9;
        expect(cornerSite(f, knots, [], d)).toBe(20);
        expect(cornerSite(f, knots, [20], d)).toBe(30);
        expect(cornerSite(f, knots, [10, 20, 30], d)).toBe(-1);
        // endpoints are never corners — they carry one side each, so there is nothing to break.
        expect(cornerSite(f, [0, 40], [], d)).toBe(-1);
    });
});
