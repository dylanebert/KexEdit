/** the refine loop — the conversion tier's discrete outer refinement (`src/refine.ts`).
 *
 *  The corpus sweep is the expensive gate, so it runs ONCE at module scope and every
 *  assertion below reads that one result. Two measurement caveats carry over from the
 *  spike's verdict: violence numbers are ds-dependent (compare only at the same
 *  `scenario.ds`), and a census is a final-frame reading. */

import { describe, expect, test } from "bun:test";
import { authoringFloor, spine, violence } from "../src/polish";
import { collinear, forceProfile } from "../src/profile";
import { refine, type RefineResult } from "../src/refine";
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
 *  bake by arclength — never the solver's own spine, which would be taking its word. */
function reference(c: Case): number {
    const { points, length, ds } = c.r.final;
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
    "hill-auto": { base: 13, refined: 9 },
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
        // the solver's spine is f64 and its own state variable; this is the geometry a force
        // section actually integrates. They agree to well under the floor everywhere.
        for (const c of CORPUS) {
            expect(reference(c)).toBeLessThanOrEqual(c.r.floor);
            expect(Math.abs(reference(c) - c.r.final.deviation)).toBeLessThan(1e-3);
        }
    });

    test("key counts at or under the stage-2 baseline", () => {
        for (const c of CORPUS) {
            const k = KEYS[c.name];
            expect(c.r.final.keys).toBe(k.refined);
            expect(c.r.final.keys).toBeLessThanOrEqual(k.base);
            expect(c.r.knots.length).toBe(c.r.final.keys);
        }
        // the tier's authorability headline: 138 keys across the corpus become 95.
        const base = Object.values(KEYS).reduce((a, k) => a + k.base, 0);
        const refined = CORPUS.reduce((a, c) => a + c.r.final.keys, 0);
        expect(base).toBe(138);
        expect(refined).toBe(95);
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
            "parabola-hill": 0.21,
            "full-loop": 0.0,
            "s-curve": 0.2,
            "straight-fillet": 0.29,
            "hill-auto": 0.01,
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

    test("split and prune cannot hand work back to each other", () => {
        // the hysteresis, structurally: a prune is accepted only from a counterfactual that
        // HOLDS the floor, and a split fires only while it is VIOLATED, so no split can
        // follow a prune. Also pins the phase order the loop is written in.
        for (const c of CORPUS) {
            const kinds = c.r.events.map((e) => e.kind);
            expect(kinds[0]).toBe("init");
            const firstPrune = kinds.indexOf("prune");
            if (firstPrune >= 0)
                expect(kinds.slice(firstPrune).every((k) => k === "prune")).toBe(true);
        }
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
        // measured 36 s over the 10 scenarios (2026-07-26, WSL2). The ceiling is a regression
        // tripwire for the loop's solve count — the split phase costs about one unregularized
        // probe per key and the prune phase one per candidate — not a machine-speed bar, so
        // it sits well clear of the measurement.
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
