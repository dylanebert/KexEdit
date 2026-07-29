import { describe, expect, test } from "bun:test";
import {
    FORCE_BUDGET,
    GEO_BUDGET,
    type GeofitBake,
    type GeofitOutcome,
    geofit,
} from "../src/geofit";
import { forceProfile } from "../src/profile";
import { scenarios } from "../src/scenarios";
import { evalForce, evalGeo } from "../src/section";
import { withThetas } from "./helpers/chain";
import golden from "./fixtures/convert-golden.json";
import forcegeoGolden from "./fixtures/forcegeo-golden.json";

function bakeOf(
    x: ArrayLike<number>,
    y: ArrayLike<number>,
    fN: ArrayLike<number>,
    ds: ArrayLike<number>,
): GeofitBake {
    return { x, y, fN, ds, edges: fN.length };
}

describe("geofit", () => {
    test("determinism: two runs are bit-identical", () => {
        const scenario = scenarios[1]; // parabola-hill
        const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };
        const bake = evalGeo(entry, scenario.nodes, scenario.ds);
        const target = bakeOf(bake.posX, bake.posY, bake.fN, bake.ds);
        const a = geofit(target, entry.v);
        const b = geofit(target, entry.v);
        expect(b).toEqual(a);
    });

    test("both budgets hold on the output", () => {
        const scenario = scenarios[3]; // s-curve
        const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };
        const bake = evalGeo(entry, scenario.nodes, scenario.ds);
        const target = bakeOf(bake.posX, bake.posY, bake.fN, bake.ds);
        const result = geofit(target, entry.v);
        expect(result.outcome).toBe("floor");
        expect(result.deviation).toBeLessThanOrEqual(GEO_BUDGET);
        expect(result.forceError).toBeLessThanOrEqual(FORCE_BUDGET);
    });

    test("loop content fits without heading-wrap artifacts", () => {
        const scenario = scenarios.find((s) => s.name === "full-loop");
        if (!scenario) throw new Error("full-loop scenario missing");
        const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };
        const bake = evalGeo(entry, scenario.nodes, scenario.ds);
        const target = bakeOf(bake.posX, bake.posY, bake.fN, bake.ds);
        const result = geofit(target, entry.v);
        expect(result.outcome).toBe("floor");
        expect(result.deviation).toBeLessThanOrEqual(GEO_BUDGET);
        expect(result.forceError).toBeLessThanOrEqual(FORCE_BUDGET);
        // a wrapped (non-continuous) heading would show up as a large jump between
        // consecutive node thetas relative to the loop's own gentle per-node turning.
        for (let i = 1; i < result.nodes.length; i++) {
            const d = Math.abs(result.nodes[i].theta - result.nodes[i - 1].theta);
            expect(d).toBeLessThan(Math.PI);
        }
    });

    test("the tail node's theta is the target's recovered exit heading", () => {
        const scenario = scenarios[0]; // circular-arc
        const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };
        const bake = evalGeo(entry, scenario.nodes, scenario.ds);
        const target = bakeOf(bake.posX, bake.posY, bake.fN, bake.ds);
        const result = geofit(target, entry.v);
        expect(result.nodes.at(-1)?.theta).toBe(bake.exit.theta);
    });

    test("degenerate: a two-sample section fits at the minimal two nodes", () => {
        const bake = bakeOf(
            new Float32Array([0, 10]),
            new Float32Array([0, 0]),
            new Float32Array([1]),
            new Float32Array([10]),
        );
        const result = geofit(bake, 20);
        expect(result.outcome).toBe("floor");
        expect(result.nodes.length).toBe(2);
        expect(result.deviation).toBeCloseTo(0, 6);
        expect(result.forceError).toBeCloseTo(0, 6);
    });

    test("degenerate: a constant-g straight section converges at minimal node count", () => {
        const pts = Array.from({ length: 40 }, (_, i) => ({ x: i * 0.5, y: 0 }));
        const nodes = withThetas([pts[0], pts[pts.length - 1]]);
        const entry = { x: 0, y: 0, theta: 0, v: 20 };
        const bake = evalGeo(entry, nodes, 0.5);
        const target = bakeOf(bake.posX, bake.posY, bake.fN, bake.ds);
        const result = geofit(target, entry.v);
        expect(result.outcome).toBe("floor");
        expect(result.nodes.length).toBe(2);
        expect(result.deviation).toBeLessThanOrEqual(GEO_BUDGET);
        expect(result.forceError).toBeLessThanOrEqual(FORCE_BUDGET);
    });

    test("degenerate budgets throw instead of silently disabling the prune", () => {
        const bake = bakeOf(
            new Float32Array([0, 10]),
            new Float32Array([0, 0]),
            new Float32Array([1]),
            new Float32Array([10]),
        );
        expect(() => geofit(bake, 20, { geo: 0 })).toThrow();
        expect(() => geofit(bake, 20, { force: -1 })).toThrow();
        expect(() => geofit(bake, 20, { geo: Number.NaN })).toThrow();
        expect(() => geofit(bake, 20, { force: Number.POSITIVE_INFINITY })).toThrow();
    });

    describe("corpus: the 10 golden-derived force sections", () => {
        const Golden = golden as Record<
            string,
            { points: { s: number; g: number }[]; length: number; ds: number }
        >;
        const Corpus = scenarios.map((scenario) => {
            const g = Golden[scenario.name];
            const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };
            const profile = forceProfile(g.points, g.length, g.ds);
            const bake = evalForce(entry, profile, g.ds);
            const target = bakeOf(bake.posX, bake.posY, bake.fN, bake.ds);
            return { scenario, result: geofit(target, entry.v) };
        });

        for (const { scenario, result } of Corpus) {
            test(scenario.name, () => {
                expect(result.outcome).toBe("floor");
                expect(result.deviation).toBeLessThanOrEqual(GEO_BUDGET);
                expect(result.forceError).toBeLessThanOrEqual(FORCE_BUDGET);
                // hard fallback ceiling (spec): per-scenario <= 18. the de-risk table
                // (direct-fit against the scenario's own geo bake) is the softer
                // reference — this fit instead targets the golden-derived FORCE
                // section, so a modest excess over that number is expected, not a bug.
                expect(result.nodes.length).toBeLessThanOrEqual(18);
            });
        }

        test("total corpus node count stays within the fallback ceiling", () => {
            const total = Corpus.reduce((sum, { result }) => sum + result.nodes.length, 0);
            expect(total).toBeLessThanOrEqual(89);
        });

        // the frozen-contract gate any later perf change answers to (mirrors
        // `convert-golden.json`'s bit-identity role for `refine`/`polish`): every
        // emitted node, the outcome, and both reported errors, exactly, for every
        // scenario. `toBe` per number, not `toEqual` on the object — a structural
        // match that quietly widened a field (an extra key, a reordered array)
        // would still pass `toEqual`; `toBe` on each leaf can't.
        const Frozen = forcegeoGolden as Record<
            string,
            {
                nodes: { x: number; y: number; theta: number }[];
                outcome: GeofitOutcome;
                deviation: number;
                forceError: number;
            }
        >;

        for (const { scenario, result } of Corpus) {
            test(`${scenario.name} reproduces the frozen golden bit-identically`, () => {
                const want = Frozen[scenario.name];
                expect(result.outcome).toBe(want.outcome);
                expect(result.deviation).toBe(want.deviation);
                expect(result.forceError).toBe(want.forceError);
                expect(result.nodes.length).toBe(want.nodes.length);
                for (let i = 0; i < want.nodes.length; i++) {
                    expect(result.nodes[i].x).toBe(want.nodes[i].x);
                    expect(result.nodes[i].y).toBe(want.nodes[i].y);
                    expect(result.nodes[i].theta).toBe(want.nodes[i].theta);
                }
            });
        }
    });
});
