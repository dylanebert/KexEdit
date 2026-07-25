import { describe, expect, test } from "bun:test";
import { V_WARN } from "../src/bake";
import { evalGeo, type Entry } from "../src/section";
import { scenarios } from "../src/scenarios";

// the geo→force fit spike's fixed corpus (kex/specs/kex2d-geoforce-spike.md stage 1):
// every scenario must bake deterministic + finite + feasible (v stays above V_WARN
// through the shape), and its recovered F_n is snapshotted so a corpus edit's effect on
// downstream fitting is visible in the diff, not silent.

function bakeOf(name: string) {
    const s = scenarios.find((x) => x.name === name);
    if (!s) throw new Error(`no scenario named ${name}`);
    const entry: Entry = { x: 0, y: 0, theta: 0, v: s.v0 };
    return { s, r: evalGeo(entry, s.nodes, s.ds) };
}

describe("scenario corpus", () => {
    test("every scenario name is unique", () => {
        const names = scenarios.map((s) => s.name);
        expect(new Set(names).size).toBe(names.length);
    });

    for (const s of scenarios) {
        describe(s.name, () => {
            test("bakes deterministic: two bakes are byte-identical", () => {
                const entry: Entry = { x: 0, y: 0, theta: 0, v: s.v0 };
                const a = evalGeo(entry, s.nodes, s.ds);
                const b = evalGeo(entry, s.nodes, s.ds);
                expect(a.edges).toBe(b.edges);
                for (let i = 0; i <= a.edges; i++) {
                    expect(b.posX[i]).toBe(a.posX[i]);
                    expect(b.posY[i]).toBe(a.posY[i]);
                    expect(b.v[i]).toBe(a.v[i]);
                }
                for (let i = 0; i < a.edges; i++) expect(b.fN[i]).toBe(a.fN[i]);
            });

            test("bakes finite: no NaN/Inf in positions or recovered F_n", () => {
                const { r } = bakeOf(s.name);
                for (let i = 0; i <= r.edges; i++) {
                    expect(Number.isFinite(r.posX[i])).toBe(true);
                    expect(Number.isFinite(r.posY[i])).toBe(true);
                    expect(Number.isFinite(r.v[i])).toBe(true);
                }
                for (let i = 0; i < r.edges; i++) expect(Number.isFinite(r.fN[i])).toBe(true);
            });

            test("is valid and not truncated (every node landed)", () => {
                const { r } = bakeOf(s.name);
                expect(r.valid).toBe(true);
                expect(r.truncated).toBe(false);
                expect(r.offsets.length).toBe(s.nodes.length);
            });

            test("v stays feasible (above V_WARN) through the whole shape", () => {
                const { r } = bakeOf(s.name);
                let minV = Number.POSITIVE_INFINITY;
                for (let i = 0; i <= r.edges; i++) minV = Math.min(minV, r.v[i]);
                expect(minV).toBeGreaterThan(V_WARN);
            });
        });
    }

    // snapshot: recovered F_n at 5 evenly spaced edges (0%, 25%, 50%, 75%, ~100%) per
    // scenario — a corpus edit that reshapes a scenario (or a substrate regression that
    // changes recovery) shows up here as a failing number, not silently.
    const Snapshot: Record<string, number[]> = {
        "circular-arc": [1.8153, 1.7356, 1.5001, 0.866, 0.8661],
        "parabola-hill": [3.2994, -0.2396, -0.0185, 2.3766, -2.4669],
        "full-loop": [1, 3.733, 0.3538, 5.8245, 1],
        "s-curve": [1, 1.3823, 2.1108, 2.3585, 1.497],
        "straight-fillet": [1, 1, 2.0174, 0.7263, -0.4432],
        "hill-auto": [1, 2.6676, 0.7731, -0.0839, 3.671],
        "hill-explicit": [1, 2.6862, 0.7797, 1.2328, 2.4455],
        "loop-explicit": [1, 3.2801, 9.4988, 3.1876, 1],
        "double-hump": [1, -0.3918, 4.1752, -0.3934, 1],
        "valley-explicit": [1, -0.5138, 0.0105, 2.0438, -0.7147],
    };
    const Fracs = [0, 0.25, 0.5, 0.75, 0.999];

    test("every scenario has a pinned snapshot", () => {
        for (const s of scenarios) expect(Snapshot[s.name]).toBeDefined();
    });

    for (const s of scenarios) {
        test(`${s.name}: recovered F_n matches its pinned snapshot`, () => {
            const { r } = bakeOf(s.name);
            const expected = Snapshot[s.name];
            Fracs.forEach((f, k) => {
                const i = Math.min(r.edges - 1, Math.floor(f * r.edges));
                expect(r.fN[i]).toBeCloseTo(expected[k], 3);
            });
        });
    }
});
