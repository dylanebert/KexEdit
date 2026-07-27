import { describe, expect, test } from "bun:test";
import { custom, forceProfile, segmentControls } from "../src/profile";
import { refine } from "../src/refine";
import { scenarios } from "../src/scenarios";
import { evalGeo } from "../src/section";

const cases = new Map(
    ["straight-fillet", "circular-arc", "parabola-hill"].map((name) => {
        const scenario = scenarios.find((candidate) => candidate.name === name);
        if (!scenario) throw new Error(`missing scenario ${name}`);
        const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };
        const bake = evalGeo(entry, scenario.nodes, scenario.ds);
        return [name, refine({ bake, entry, ds: scenario.ds })] as const;
    }),
);

describe("flat conversion regressions", () => {
    test("straight-fillet cannot carry a hidden bow across a nominally flat span", () => {
        const points = cases.get("straight-fillet")?.final.points;
        if (!points) throw new Error("missing straight-fillet result");
        for (let k = 0; k + 1 < points.length; k++) {
            const controls = segmentControls(points[k], points[k + 1]);
            expect(controls[1].g).toBe(points[k].g);
            expect(controls[2].g).toBe(points[k + 1].g);
        }
    }, 30_000);

    test("arc and hill answers cannot carry sign-violating explicit tangents", () => {
        for (const name of ["circular-arc", "parabola-hill"]) {
            const points = cases.get(name)?.final.points;
            if (!points) throw new Error(`missing ${name} result`);
            for (const point of points) {
                expect(point.in).toBeUndefined();
                expect(point.out).toBeUndefined();
            }
        }
    }, 30_000);

    test("every converted segment is the default named Cubic", () => {
        for (const result of cases.values()) {
            const { points, length, ds } = result.final;
            expect(forceProfile(points, length, ds).length).toBe(result.final.edges);
            for (let k = 0; k + 1 < points.length; k++) {
                expect(points[k].ease).toBeUndefined();
                expect(custom(points[k], points[k + 1])).toBe(false);
            }
        }
    });
});
