/** easing-tag quantization — the conversion tier's vocabulary snap (`src/quantize.ts`).
 *
 *  The corpus sweep runs the refine loop AND the quantizer once at module scope, and every
 *  assertion below reads that one result. Two measurement caveats carry over: violence
 *  numbers are ds-dependent (compare only at the same `scenario.ds`), and a census is a
 *  final-frame reading. */

import { describe, expect, test } from "bun:test";
import { census, type Scale } from "../src/census";
import { arclength } from "../src/fit";
import { forceRange, panelScale, pipeline } from "../src/playback";
import { fairNorm, fairRows, polish, readDof, violence } from "../src/polish";
import { collinear, custom, Easing, type ForcePoint, forceProfile } from "../src/profile";
import { flatten, namedSegments, quantize, type QuantizeResult } from "../src/quantize";
import { refine, type RefineResult } from "../src/refine";
import { scenarios } from "../src/scenarios";
import { type Entry, evalForce, evalGeo, type SectionResult } from "../src/section";
import { sharpValley } from "./helpers/valley";

// A single real solve's budget (ms) — refine.test.ts's constant, same argument: this
// file's unit is a full LM/PHR solve and `bun test` runs the suite files concurrently.
const SOLVE_MS = 30_000;

interface Case {
    name: string;
    bake: SectionResult;
    entry: Entry;
    ds: number;
    r: RefineResult;
    q: QuantizeResult;
}

const t0 = performance.now();
const CORPUS: Case[] = scenarios.map((s) => {
    const entry: Entry = { x: 0, y: 0, theta: 0, v: s.v0 };
    const bake = evalGeo(entry, s.nodes, s.ds);
    const r = refine({ bake, entry, ds: s.ds });
    return {
        name: s.name,
        bake,
        entry,
        ds: s.ds,
        r,
        q: quantize({ bake, entry, ds: s.ds, answer: r.final }),
    };
});
const CORPUS_MS = performance.now() - t0;

const pick = (name: string): Case => {
    const c = CORPUS.find((x) => x.name === name);
    if (!c) throw new Error(`no scenario ${name}`);
    return c;
};

/** the answer re-integrated through the LIVE f32 `evalForce` path, measured against the
 *  solve's own target spine — the state variable is then the shipped integrator's, and the
 *  profile is loaded exactly as a converted force section would load it. */
function reference(c: Case, pts: readonly ForcePoint[] = c.q.final.points): number {
    const { length, ds, spine } = c.q.final;
    const out = evalForce(c.entry, forceProfile(pts, length, ds), ds);
    let dev = 0;
    for (let j = 0; j <= spine.edges; j++)
        dev = Math.max(dev, Math.hypot(out.posX[j] - spine.x[j], out.posY[j] - spine.y[j]));
    return dev;
}

/** THE CENSUS, per scenario: how many of the settled answer's segments the vocabulary snap
 *  recovers to a named easing. Pinned as MEASURED, and the headline is how small it is —
 *  5 of 84 segments, on 4 of the 10 scenarios. That is not a defect in the search (which is
 *  exhaustive and re-solves every candidate); it is what the vocabulary can express. A
 *  named segment demands `F′ = 0` at BOTH its keys — the easing ladder is a hold-to-hold
 *  transition language — while a geo→force profile ramps: over these 94 settled keys |m|
 *  runs 7.3e-3 to 84.7 g/m (median 0.29) with none near zero, so naming is available only
 *  where the target force genuinely turns over. `quantize.ts`'s note carries the argument; this table carries the number, so
 *  a change in either direction is visible rather than silent. */
const NAMED: Record<string, number[]> = {
    "circular-arc": [],
    "parabola-hill": [],
    "full-loop": [5],
    "s-curve": [2, 13],
    "straight-fillet": [],
    "hill-auto": [],
    "hill-explicit": [],
    "loop-explicit": [7],
    "double-hump": [],
    "valley-explicit": [6],
};

describe("quantize — the corpus contract", () => {
    test("every scenario still holds the authoring floor", () => {
        for (const c of CORPUS) {
            expect(c.q.final.converged).toBe(true);
            expect(c.q.final.heldFloor).toBe(true);
            expect(c.q.final.deviation).toBeLessThanOrEqual(c.q.floor);
            expect(c.q.floor).toBe(c.r.floor);
        }
    });

    test("the quantized profile holds the floor through the live f32 path too", () => {
        // the admissibility criterion IS the floor, and this is the criterion measured
        // where the author meets it: the shipped f32 integrator, at the step the solve
        // targeted (`spine`'s length/edges, the ds a converted section must store).
        for (const c of CORPUS) {
            expect(reference(c)).toBeLessThanOrEqual(c.q.floor);
            expect(Math.abs(reference(c) - c.q.final.deviation)).toBeLessThan(1e-3);
        }
    });

    test("the exit stays pinned in the recovered convention", () => {
        // stage 2's contract, re-asserted on the profile stage 7 actually emits: the snap
        // re-solves, so the exit pin has to survive it. It is the quantity `chain()` hands
        // downstream (the recovered bisector heading, not the integrator's own θ), three
        // decades under the 0.1 deg readout quantum.
        for (const c of CORPUS) {
            expect(Math.abs(c.q.final.exit.dtheta)).toBeLessThan(1e-5);
            expect(c.q.final.exit.dist).toBeLessThan(1e-5);
        }
    });

    test("the named-easing census, per scenario", () => {
        let named = 0;
        let segments = 0;
        for (const c of CORPUS) {
            expect(c.q.named).toEqual(NAMED[c.name]);
            // the result's own list and the profile's derived provenance are two readings
            // of one fact (`profile.custom` — never a stored flag), so they must agree.
            expect(namedSegments(c.q.final.points)).toEqual(NAMED[c.name]);
            named += c.q.named.length;
            segments += c.q.final.keys - 1;
        }
        expect(named).toBe(5);
        expect(segments).toBe(84);
    });

    test("a named segment is handle-free at both ends, and the rest keep theirs", () => {
        for (const c of CORPUS) {
            const pts = c.q.final.points;
            for (const k of c.q.named) {
                expect(pts[k].out).toBeUndefined();
                expect(pts[k + 1].in).toBeUndefined();
                expect(custom(pts[k], pts[k + 1])).toBe(false);
                // and no tag is stored: Cubic is the absent-value default, and it is the
                // only rung the closed-form fairing family reaches (`quantize.ts`).
                expect(pts[k].ease).toBeUndefined();
            }
            // a flat key is exactly a named segment's end — nothing is flattened for free.
            for (const k of c.q.flats) {
                expect(pts[k].in ?? pts[k].out).toBeUndefined();
                expect(c.q.named.includes(k) || c.q.named.includes(k - 1)).toBe(true);
            }
            for (let k = 0; k + 1 < pts.length; k++)
                if (!c.q.named.includes(k)) expect(custom(pts[k], pts[k + 1])).toBe(true);
        }
    });

    test("quantization introduces no broken key", () => {
        // the tier's vocabulary claim has to survive the snap: a flat key is ALIGNED (both
        // sides on one zero slope), not broken, so the corpus stays at zero broken keys —
        // the same reading `refine.test.ts` takes of the un-quantized answer.
        for (const c of CORPUS) {
            expect(c.q.final.points.filter((p) => !collinear(p.in, p.out))).toEqual([]);
            expect(c.r.cornerKnots).toEqual([]);
        }
    });

    test("the census moves keys out of `aligned`, never into `broken`", () => {
        // the reading an author meets on the surface (`census.ts` is screen-space, so this
        // is a reading OF a panel — one scale for both censuses, or the two are not
        // comparable). A flattened key draws no handles at all, so it leaves `aligned` for
        // `single`; `broken` must stay empty on both sides of the snap.
        const sc: Scale = { s: 8, g: 40 };
        let moved = 0;
        for (const c of CORPUS) {
            const before = census(c.r.final.points, sc);
            const after = census(c.q.final.points, sc);
            expect(before.broken).toBe(0);
            expect(after.broken).toBe(0);
            // only an INTERIOR key moves: a chain end carries one side, so `census` already
            // reads it `single` and flattening it changes no count. Two of the ten flats
            // this corpus spends land on a terminal key (the last segment is a natural
            // naming candidate — the profile holds flat past it), which is why the census
            // delta is not the flat count.
            const interior = c.q.flats.filter((k) => k > 0 && k + 1 < c.q.final.keys).length;
            expect(after.single - before.single).toBe(interior);
            expect(before.aligned - after.aligned).toBe(interior);
            moved += interior;
        }
        expect(moved).toBe(8);
    });

    test("the profile the LAB DISPLAYS censuses 0 broken, on every scenario", () => {
        // One rung up from the test above, and the claim the stage-6 check-in rests on: not a
        // scale chosen for a test, but the PANEL's own — `panelScale` over the range the force
        // graph actually fits (`forceRange` across every playback frame of the shipping
        // pipeline). A screen-space census is a reading OF a surface, so a hand-built scale
        // answers a question about no picture; and the panel's g-range spans the refine loop's
        // early wild states, which stretches the axis and makes every later handle draw
        // SHORTER than it would on a scale fitted to the answer alone. That is the direction
        // that matters: `census` calls a side too short to carry a direction `broken`, so the
        // displayed scale is the harder reading, not the easier one.
        for (const c of CORPUS) {
            const frames = pipeline(c.r, c.q, arclength(c.bake.ds));
            const dense = forceProfile(c.q.final.points, c.q.final.length, c.q.final.ds);
            const { lo, hi } = forceRange(frames, [c.bake.fN, dense]);
            const stats = census(c.q.final.points, panelScale(c.q.final.length, lo, hi));
            expect(stats.broken, `${c.name} draws a broken key`).toBe(c.q.final.corners.length);
            expect(stats.broken).toBe(0);
            expect(stats.mirror + stats.aligned + stats.broken + stats.single).toBe(c.q.final.keys);
        }
    });

    test("nothing named is a no-op, by identity", () => {
        // THE NEGATIVE CONTROL. Six of ten scenarios name nothing, and those must come back
        // as the answer that went in — not a re-solve of it, which would move the profile by
        // float noise for no reason and make "did the quantizer do anything" unanswerable.
        const quiet = CORPUS.filter((c) => c.q.named.length === 0);
        expect(quiet.length).toBe(6);
        for (const c of quiet) {
            expect(c.q.final).toBe(c.r.final);
            expect(c.q.flats).toEqual([]);
            expect(c.q.solves).toBe(c.q.probes);
        }
    });

    test("the snap alone is not the mechanism — the re-solve is", () => {
        // THE MECHANISM CONTROL, the reason this module re-solves instead of rounding the
        // handles where they sit. Take a segment the quantizer DID name and apply the same
        // snap to the un-quantized answer without re-solving: the geometry misses the floor
        // by multiples. Naming is a constraint the profile has to be re-projected onto, not
        // a rounding of the answer in place.
        const worst = CORPUS.filter((c) => c.q.named.length > 0).map((c) => {
            const k = c.q.named[0];
            const raw = flatten(c.r.final.points, new Set([k, k + 1]));
            return reference(c, raw) / c.q.floor;
        });
        expect(worst.length).toBe(4);
        for (const over of worst) expect(over).toBeGreaterThan(2);
        expect(Math.max(...worst)).toBeGreaterThan(50);
    });

    test("the answer stays inside the family the fairing energy is exact on", () => {
        // the DOMAIN LAW, as an invariant rather than as a comment: every reach in the
        // quantized profile is still span/3 (an absent side resolves to the Cubic tag's own
        // tangent), so `fairRows` still IS ∫(F″)² ds here and the tier never has to price a
        // profile it cannot price. `polish` re-accepting the answer is the proof — it
        // refuses anything off that family at its boundary.
        for (const c of CORPUS) {
            const pts = c.q.final.points;
            for (let k = 0; k + 1 < pts.length; k++) {
                const want = (pts[k + 1].s - pts[k].s) / 3;
                if (pts[k].out) expect(pts[k].out?.ds).toBeCloseTo(want, 9);
                if (pts[k + 1].in) expect(pts[k + 1].in?.ds).toBeCloseTo(-want, 9);
            }
            expect(() =>
                polish({
                    bake: c.bake,
                    entry: c.entry,
                    points: pts,
                    ds: c.ds,
                    handles: "aligned",
                    mode: "calm",
                    lambda: 0,
                    outers: 1,
                    maxIters: 1,
                    maxSnapshots: 1,
                }),
            ).not.toThrow();
        }
    });

    test("a named tag is paid for in violence, and the price is bounded", () => {
        // the tier's two violence readings, before and after (the metric law: peak dense g
        // and the fairing seminorm — maxDg measures nothing here). Naming is NOT free and
        // does not calm the profile: zeroing a key's slope is locally the quietest thing it
        // could do, but the neighbouring segments then absorb the shape it was carrying, and
        // on balance both readings RISE. Measured worst on loop-explicit: 1.07x the dense
        // peak and 1.27x the roughness for one named segment out of twelve.
        //
        // The ceilings are MEASURED and provisional, like every violence pin in this tier —
        // less is an improvement and passes, more is a regression. The seminorm is readable
        // here at all only because the snap never leaves the span/3 family (the test above);
        // an off-family quantizer would have to integrate (F″)² numerically instead.
        const rough = (pts: readonly ForcePoint[], corners: readonly number[] = []): number =>
            fairNorm(fairRows(pts, "aligned", corners), readDof(pts, "aligned", corners));
        for (const c of CORPUS) {
            const before = violence(c.r.final.points, c.r.final.length, c.r.final.ds);
            const after = violence(c.q.final.points, c.q.final.length, c.q.final.ds);
            expect(after.peakG).toBeLessThan(1.1 * before.peakG);
            expect(rough(c.q.final.points)).toBeLessThan(1.35 * rough(c.r.final.points));
            // the ceilings only mean something where something was named; a quiet scenario
            // returns the same object, which the identity test above already pins.
            if (c.q.named.length === 0) expect(c.q.final).toBe(c.r.final);
        }
    });

    test(
        "same answer in, same tags out",
        () => {
            const c = pick("valley-explicit");
            const again = quantize({ bake: c.bake, entry: c.entry, ds: c.ds, answer: c.r.final });
            expect(again.named).toEqual(c.q.named);
            expect(again.flats).toEqual(c.q.flats);
            expect(again.probes).toBe(c.q.probes);
            expect(again.final.points).toEqual(c.q.final.points);
            expect(again.final.lambda).toBe(c.q.final.lambda);
        },
        SOLVE_MS,
    );

    test("the quantizer stays inside its measured budget", () => {
        // THE COST TRIPWIRE, in PROBES — a machine-independent count of the search's own
        // decisions. Each round scans every remaining segment (exhaustively, for `refine`'s
        // reason: an ordering proxy would decide which segment gets named), so the count is
        // the segments times one more than the rounds that named something.
        const Probes: Record<string, number> = {
            "circular-arc": 2,
            "parabola-hill": 10,
            "full-loop": 11,
            "s-curve": 39,
            "straight-fillet": 4,
            "hill-auto": 7,
            "hill-explicit": 8,
            "loop-explicit": 23,
            "double-hump": 13,
            "valley-explicit": 15,
        };
        for (const c of CORPUS) expect(c.q.probes).toBeLessThanOrEqual(Probes[c.name]);
        // the wall clock is a SANITY CEILING only — a hang detector. Measured 71 s for the
        // ten refinements plus their quantization (the quantizer's own share is 17 s); the
        // bar sits at 180 s so machine speed and suite contention can never make it the
        // thing that fails.
        expect(CORPUS_MS).toBeLessThan(180_000);
    });
});

describe("quantize — corners and the floor", () => {
    // the corpus needs no corner at its derived floor, so the tier's two discrete per-key
    // states never meet there. This fixture is where they do.
    const fx = sharpValley();
    const broken = refine({ ...fx, floor: 0.12 });
    const plain = refine({ ...fx, floor: 0.3 });
    const q = (r: RefineResult, floor: number): QuantizeResult =>
        quantize({ bake: fx.bake, entry: fx.entry, ds: fx.ds, answer: r.final, floor });

    test(
        "a corner key is never flattened — the two discrete states are exclusive",
        () => {
            // a corner BREAKS a key's slope in two and a flat REMOVES it, so a key cannot
            // carry both and a segment touching one is not a naming candidate. `polish`
            // refuses the contradiction outright; this pins that `quantize` never builds it.
            expect(broken.final.corners).toEqual([1, 2, 3]);
            const out = q(broken, 0.12);
            for (const k of out.flats) expect(broken.final.corners).not.toContain(k);
            for (const seg of out.named) {
                expect(broken.final.corners).not.toContain(seg);
                expect(broken.final.corners).not.toContain(seg + 1);
            }
            // 6 keys with 1, 2, 3 broken leaves segment 4 (keys 4→5) as the only candidate,
            // so the exhaustive scan spends exactly one probe and the corner set survives.
            expect(out.probes).toBe(1);
            expect(out.final.corners).toEqual(broken.final.corners);
        },
        SOLVE_MS,
    );

    test(
        "a looser floor names strictly more — the tolerance IS the floor",
        () => {
            // THE TOLERANCE ORACLE, and the cheapest one available: nothing in this module
            // is tuned, so the only thing that can move the recovery is the constraint
            // itself. Same shape, same keys-per-solve machinery, a floor 2.5x looser — and
            // segments that were inadmissible become admissible.
            expect(plain.cornerKnots).toEqual([]);
            const tight = q(plain, 0.12);
            const loose = q(plain, 0.3);
            expect(loose.named.length).toBeGreaterThan(tight.named.length);
            expect(loose.floor).toBe(0.3);
            expect(loose.final.heldFloor).toBe(true);
            expect(loose.final.deviation).toBeLessThanOrEqual(0.3);
            // and the snap really is the floor's own reading: every named segment holds it
            // through the live f32 path too, at the step the solve targeted.
            const out = evalForce(
                fx.entry,
                forceProfile(loose.final.points, loose.final.length, loose.final.ds),
                loose.final.ds,
            );
            let dev = 0;
            for (let j = 0; j <= loose.final.spine.edges; j++)
                dev = Math.max(
                    dev,
                    Math.hypot(
                        out.posX[j] - loose.final.spine.x[j],
                        out.posY[j] - loose.final.spine.y[j],
                    ),
                );
            expect(dev).toBeLessThanOrEqual(0.3);
        },
        SOLVE_MS,
    );
});

describe("quantize — the atom", () => {
    /** a three-key profile in the span/3 family, slope 1 at every key. */
    const profile = (): ForcePoint[] => [
        { s: 0, g: 1, out: { ds: 4, dg: 4 } },
        { s: 12, g: 2, in: { ds: -4, dg: -4 }, out: { ds: 4, dg: 4 } },
        { s: 24, g: 3, in: { ds: -4, dg: -4 } },
    ];

    test("flatten removes exactly the keys it is given, and copies the rest", () => {
        const pts = profile();
        const out = flatten(pts, new Set([1]));
        expect(out[1].in).toBeUndefined();
        expect(out[1].out).toBeUndefined();
        expect(out[1].g).toBe(pts[1].g);
        expect(out[1].s).toBe(pts[1].s);
        expect(out[0].out).toEqual({ ds: 4, dg: 4 });
        expect(out[2].in).toEqual({ ds: -4, dg: -4 });
        // the offsets are copies: a solve writing into the returned profile must not reach
        // back into the answer it was derived from.
        expect(out[0].out).not.toBe(pts[0].out);
        expect(pts[1].in).toEqual({ ds: -4, dg: -4 });
    });

    test("a segment is named only when NEITHER bounding side is explicit", () => {
        // derived provenance, both directions (`profile.custom`): one side is enough to
        // keep a segment Custom, which is why the snap is a per-KEY state and a named
        // segment needs both of its ends.
        const pts = profile();
        expect(namedSegments(pts)).toEqual([]);
        expect(namedSegments(flatten(pts, new Set([1])))).toEqual([]);
        expect(namedSegments(flatten(pts, new Set([0, 1])))).toEqual([0]);
        expect(namedSegments(flatten(pts, new Set([0, 1, 2])))).toEqual([0, 1]);
        expect(custom(pts[0], pts[1])).toBe(true);
        expect(custom({ s: 0, g: 1 }, { s: 1, g: 1 })).toBe(false);
        expect(custom({ s: 0, g: 1, out: { ds: 0.3, dg: 0 } }, { s: 1, g: 1 })).toBe(true);
        expect(custom({ s: 0, g: 1 }, { s: 1, g: 1, in: { ds: -0.3, dg: 0 } })).toBe(true);
    });

    test("rejects an answer the vocabulary is not defined over", () => {
        const c = pick("circular-arc");
        const free = polish({
            bake: c.bake,
            entry: c.entry,
            points: c.r.final.points,
            ds: c.ds,
            outers: 1,
            maxIters: 1,
            maxSnapshots: 1,
        });
        expect(free.handles).toBe("free");
        const base = { bake: c.bake, entry: c.entry, ds: c.ds };
        expect(() => quantize({ ...base, answer: free })).toThrow(/aligned-family state/);
        expect(() => quantize({ ...base, answer: c.r.final, floor: 0 })).toThrow(
            /floor must be a finite number > 0/,
        );
        expect(() => quantize({ ...base, answer: c.r.final, floor: Number.NaN })).toThrow(
            /floor must be a finite number > 0/,
        );
    });

    test("the ladder's other rungs are unreachable, and that is a derivation", () => {
        // Linear (reach 0) and Quintic (7/15) leave the span/3 family the fairing energy is
        // closed-form on, so the tier cannot re-solve against them — `polish` refuses the
        // tag at its boundary, which is what keeps a mis-priced profile from ever reaching
        // the solver. Pinned here because it is the reason `quantize` stores no tag at all.
        const c = pick("circular-arc");
        const tagged = flatten(c.r.final.points, new Set([0, 1])).map((p, k) =>
            k === 0 ? { ...p, ease: Easing.Quintic } : p,
        );
        expect(() =>
            polish({
                bake: c.bake,
                entry: c.entry,
                points: tagged,
                ds: c.ds,
                handles: "aligned",
                outers: 1,
                maxIters: 1,
                maxSnapshots: 1,
            }),
        ).toThrow(/carries ease/);
    });
});
