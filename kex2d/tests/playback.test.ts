/** the fit lab's playback timeline (`src/playback.ts`) — the pipeline's decisions turned
 *  into frames.
 *
 *  Two tiers, deliberately. The label/corner rules are pure functions of ONE event, so they
 *  are tested against hand-built events, including the kinds this corpus never produces
 *  (`budget`, `diverged`). The timeline SHAPE is tested against real solves, because what it
 *  claims is a correspondence with what the kernel decided — a synthetic `RefineResult`
 *  would only restate the assembly code. `circular-arc` is the cheapest corpus scenario
 *  (~0.6 s refine + quantize, measured) and `sharpValley` is the one fixture that reaches
 *  the corner state at all. */

import { describe, expect, test } from "bun:test";
import { arclength, fit } from "../src/fit";
import { baseline, cornerKeys, eventLabel, pipeline, segments } from "../src/playback";
import { polish } from "../src/polish";
import { collinear } from "../src/profile";
import { quantize } from "../src/quantize";
import { refine, type RefineEvent, type RefineEventKind } from "../src/refine";
import { scenarios } from "../src/scenarios";
import { type Entry, evalGeo } from "../src/section";
import { sharpValley } from "./helpers/valley";

/** a full LM/PHR solve is the unit here as in `refine.test.ts`; same argument, same
 *  constant. */
const SOLVE_MS = 30_000;

const FIT_TOL = 0.05;

function scenario(name: string): { bake: ReturnType<typeof evalGeo>; entry: Entry; ds: number } {
    const s = scenarios.find((x) => x.name === name);
    if (!s) throw new Error(`no scenario ${name}`);
    const entry: Entry = { x: 0, y: 0, theta: 0, v: s.v0 };
    return { bake: evalGeo(entry, s.nodes, s.ds), entry, ds: s.ds };
}

function event(kind: RefineEventKind, over: Partial<RefineEvent> = {}): RefineEvent {
    return {
        kind,
        knots: [0, 20, 40],
        corners: [],
        at: -1,
        deviation: 0.25,
        points: [
            { s: 0, g: 1 },
            { s: 10, g: 2 },
            { s: 20, g: 1 },
        ],
        ...over,
    };
}

const SIGMA = Float64Array.from({ length: 41 }, (_, i) => 0.5 * i);

describe("event labels", () => {
    test("each decision says what it did, where, and where that left the residual", () => {
        const at = { at: 20, deviation: 0.312 };
        expect(eventLabel(event("split", at), SIGMA)).toBe(
            "refine · split @ 10.0 m · 3 keys · dev 0.312 m",
        );
        expect(eventLabel(event("prune", at), SIGMA)).toBe(
            "refine · prune @ 10.0 m · 3 keys · dev 0.312 m",
        );
        expect(eventLabel(event("init", { deviation: 1.5 }), SIGMA)).toBe(
            "refine · open · 3 keys · dev 1.500 m",
        );
    });

    test("a corner is counted in the state it leaves behind", () => {
        expect(eventLabel(event("corner", { at: 20, corners: [20] }), SIGMA)).toBe(
            "refine · corner @ 10.0 m · 3 keys / 1 corner · dev 0.250 m",
        );
    });

    test("a stall names its number as the rejected trial's", () => {
        // the one event whose `deviation` describes a state its own `knots` do NOT: the
        // frame draws what stalled, the number is the split that did not happen. A label
        // that read like every other event's would quietly mislabel the picture.
        expect(eventLabel(event("stall", { at: 20 }), SIGMA)).toBe(
            "refine · stall @ 10.0 m · trial rejected at dev 0.250 m",
        );
    });

    test("the two terminal kinds read as different things", () => {
        // `budget` is the sanctioned un-authorable outcome, `diverged` is a defect to
        // surface (`refine.RefineOutcome`). The corpus reaches neither, so the labels have
        // no other check on them.
        expect(eventLabel(event("budget"), SIGMA)).toBe(
            "refine · budget · no admissible site · dev 0.250 m",
        );
        expect(eventLabel(event("diverged"), SIGMA)).toBe("refine · diverged · dev 0.250 m");
    });
});

describe("corner keys", () => {
    test("dense knots resolve to key indices", () => {
        // `polish` takes corners as KEY indices while the refine stream carries them as
        // dense knots; a frame drawn against the wrong frame marks the wrong diamond.
        expect(cornerKeys(event("corner", { knots: [0, 20, 40], corners: [20] }))).toEqual([1]);
        expect(
            cornerKeys(event("corner", { knots: [0, 8, 20, 33, 40], corners: [8, 33] })),
        ).toEqual([1, 3]);
        expect(cornerKeys(event("init"))).toEqual([]);
    });

    test("a corner outside its own knot set is a defect, not a silent skip", () => {
        expect(() => cornerKeys(event("corner", { corners: [7] }))).toThrow(/not in the event/);
    });
});

describe("the conversion timeline", () => {
    const c = scenario("circular-arc");
    const r = refine(c);
    const q = quantize({ ...c, answer: r.final });
    const frames = pipeline(r, q, arclength(c.bake.ds));
    const segs = segments(frames, "calm λ-search");

    test(
        "one frame per refine decision, in the loop's own order",
        () => {
            const events = frames.filter((f) => f.event !== null);
            expect(events.length).toBe(r.events.length);
            expect(events.map((f) => f.event?.kind)).toEqual(r.events.map((e) => e.kind));
            // the profile drawn at an event is the one that event's state actually held —
            // it comes off the stream, never re-derived here.
            for (let i = 0; i < events.length; i++)
                expect(events[i].points).toBe(r.events[i].points);
        },
        SOLVE_MS,
    );

    test("the four phases run in order and cover every frame", () => {
        expect(segs.map((s) => s.phase)).toEqual(["recover", "refine", "polish", "quantize"]);
        expect(segs[0].start).toBe(0);
        expect(segs[segs.length - 1].end).toBe(frames.length - 1);
        for (let i = 1; i < segs.length; i++) expect(segs[i].start).toBe(segs[i - 1].end + 1);
        expect(frames[0].points).toBeNull(); // the dense recovery, before any profile exists
    });

    test("each solve phase ends on its ANSWER, not on the last surviving step", () => {
        // `snapshots` are decimated accepted steps, and calm mode's answer comes out of a λ
        // search that ran several solves — so the last snapshot is not the answer, and a
        // timeline that stopped there would draw a curve the corpus table does not report.
        const polished = frames.filter((f) => f.phase === "polish");
        expect(polished[polished.length - 1].points).toBe(r.final.points);
        const quantized = frames.filter((f) => f.phase === "quantize");
        expect(quantized[quantized.length - 1].points).toBe(q.final.points);
        expect(frames[frames.length - 1].points).toBe(q.final.points);
    });

    test("a quantize that named nothing is one frame, not a re-solve", () => {
        // circular-arc names 0 of its 2 segments (measured), and `quantize` signals that by
        // handing its input back by identity. The phase is then the answer frame alone.
        expect(q.final).toBe(r.final);
        expect(q.named).toEqual([]);
        const quantized = frames.filter((f) => f.phase === "quantize");
        expect(quantized.length).toBe(1);
        expect(quantized[0].label).toBe("quantize · nothing named");
    });

    test("the segment labels carry the decision counts", () => {
        const refineSeg = segs[1];
        const splits = r.events.filter((e) => e.kind === "split").length;
        expect(splits).toBeGreaterThan(0);
        expect(refineSeg.label).toContain(`${splits} split`);
        expect(refineSeg.label).toContain(`(${r.events.length})`);
        expect(segs[2].label).toContain("calm λ-search");
    });
});

describe("the corner state on the timeline", () => {
    test(
        "corner events mark their keys, and the answer keeps them broken",
        () => {
            // the corpus needs no corner at its derived floor, so this fixture is the only
            // reachable path — and the lab has to draw the one deliberate broken-handle
            // state as such (`refine.test.ts` pins 6 keys + 3 corners at floor 0.12).
            const fx = sharpValley();
            const r = refine({ ...fx, floor: 0.12 });
            const q = quantize({ ...fx, answer: r.final, floor: 0.12 });
            const frames = pipeline(r, q, arclength(fx.bake.ds));
            expect(r.cornerKnots.length).toBeGreaterThan(0);

            const cornerEvents = frames.filter((f) => f.event?.kind === "corner");
            expect(cornerEvents.length).toBe(r.cornerKnots.length);
            for (const f of cornerEvents) {
                expect(f.corners.length).toBeGreaterThan(0);
                // a marked key is one whose two handles really are broken through it.
                for (const k of f.corners) {
                    const p = f.points?.[k];
                    expect(p).toBeDefined();
                    if (p) expect(collinear(p.in, p.out)).toBe(false);
                }
            }
            const answer = frames[frames.length - 1];
            expect([...answer.corners]).toEqual(q.final.corners);
            expect(answer.points?.filter((p) => !collinear(p.in, p.out)).length).toBe(
                q.final.corners.length,
            );
        },
        SOLVE_MS,
    );
});

describe("the legacy fit→polish timeline", () => {
    test(
        "still recover → fit → polish, one frame per fit step",
        () => {
            // the `exact` oracle baseline the spike's numbers were taken on. The shipping
            // path does not use the fit's knot placement, but the comparison does.
            const c = scenario("circular-arc");
            const f = fit(c.bake.fN, c.bake.ds, FIT_TOL);
            const out = polish({ bake: c.bake, entry: c.entry, points: f.points, ds: c.ds });
            const frames = baseline(f.steps, out);
            const segs = segments(frames, "exact");
            expect(segs.map((s) => s.phase)).toEqual(["recover", "fit", "polish"]);
            expect(frames.filter((fr) => fr.step !== null).length).toBe(f.steps.length);
            expect(frames[frames.length - 1].points).toBe(out.points);
            expect(segs[2].label).toContain("exact");
        },
        SOLVE_MS,
    );

    test("a fit that produced no steps is a defect, not an empty timeline", () => {
        expect(() => baseline([], {} as never)).toThrow(/no steps/);
    });
});
