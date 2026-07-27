import { describe, expect, test } from "bun:test";
import { arclength, fit } from "../src/fit";
import {
    baseline,
    eventLabel,
    forcePath,
    forceRange,
    PANEL,
    panelScale,
    pipeline,
    segments,
    uniformAbscissa,
} from "../src/playback";
import { polish } from "../src/polish";
import { refine, type RefineEvent } from "../src/refine";
import { scenarios } from "../src/scenarios";
import { evalGeo } from "../src/section";

const scenario = scenarios[0];
const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };
const bake = evalGeo(entry, scenario.nodes, scenario.ds);
const fitted = fit(bake.fN, bake.ds, 0.05);
const oracle = polish({ bake, entry, points: fitted.points, ds: scenario.ds });
const converted = refine({ bake, entry, ds: scenario.ds });

describe("playback correspondence", () => {
    test("the oracle timeline ends on its exact returned answer", () => {
        const frames = baseline(fitted.steps, oracle);
        expect(frames[0]).toMatchObject({ phase: "recover", points: null });
        const tail = frames.at(-1);
        expect(tail?.phase).toBe("polish");
        expect(tail?.points).toEqual(oracle.points);
        expect(tail?.snap).toBe(oracle.snapshots.at(-1));
        expect(segments(frames).map((segment) => segment.phase)).toEqual([
            "recover",
            "fit",
            "polish",
        ]);
    });

    test("the flat timeline is exactly one frame per committed refine decision", () => {
        const frames = pipeline(converted, arclength(bake.ds));
        expect(frames).toHaveLength(converted.events.length + 1);
        expect(frames[0]).toMatchObject({ phase: "recover", points: null });
        for (let i = 0; i < converted.events.length; i++) {
            expect(frames[i + 1].event).toBe(converted.events[i]);
            expect(frames[i + 1].points).toBe(converted.events[i].points);
        }
        expect(frames.at(-1)?.points).toEqual(converted.final.points);
        expect(frames.at(-1)?.label).toEndWith("· answer");
        expect(segments(frames).map((segment) => segment.phase)).toEqual(["recover", "refine"]);
    });

    test("every event kind has an honest label", () => {
        const sigma = Float64Array.from([0, 5, 10]);
        const make = (kind: RefineEvent["kind"], at = -1): RefineEvent => ({
            kind,
            knots: [0, 2],
            at,
            deviation: 0.25,
            points: [
                { s: 0, g: 1 },
                { s: 10, g: 1 },
            ],
        });
        expect(eventLabel(make("init"), sigma)).toContain("open");
        expect(eventLabel(make("split", 1), sigma)).toContain("split @ 5.0 m");
        expect(eventLabel(make("prune", 1), sigma)).toContain("prune @ 5.0 m");
        expect(eventLabel(make("budget"), sigma)).toContain("no admissible site");
        expect(eventLabel(make("diverged"), sigma)).toContain("diverged");
    });

    test("panel range and scale cover every drawn force", () => {
        const frames = pipeline(converted, arclength(bake.ds));
        const { lo, hi } = forceRange(frames, [bake.fN]);
        expect(lo).toBeLessThan(Math.min(...bake.fN));
        expect(hi).toBeGreaterThan(Math.max(...bake.fN));
        const scale = panelScale(converted.final.length, lo, hi);
        expect(scale.s).toBeGreaterThan(0);
        expect(scale.g).toBeGreaterThan(0);
        expect(() => panelScale(0, lo, hi)).toThrow(/length/);
    });

    test("the force render transform preserves a nonuniform chord abscissa", () => {
        const scale = { s: 10, g: 4 };
        const path = forcePath(
            Float32Array.from([1, 2, 3]),
            Float64Array.from([0, 0.25, 1.5]),
            scale,
            0,
        );
        expect(path.map(({ x }) => x)).toEqual([PANEL.padL, PANEL.padL + 2.5, PANEL.padL + 15]);
        expect(path.map(({ y }) => y)).toEqual([
            PANEL.h - PANEL.padB - 4,
            PANEL.h - PANEL.padB - 8,
            PANEL.h - PANEL.padB - 12,
        ]);
        expect(Array.from(uniformAbscissa(3, 0.5))).toEqual([0, 0.5, 1]);
    });
});
