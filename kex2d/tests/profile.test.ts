import { describe, expect, test } from "bun:test";
import { DEFAULT_G, type ForcePoint, forceProfile, sampleForce } from "../src/profile";

// the force-authoring layer (kex/specs/kex2d-sections.md §6): authored force points
// → dense per-edge F_n. pure linear interp with held endpoints + an empty default,
// so the invariants are exact (no derived tolerance). the O(ds) recovered-vs-authored
// gap lives one layer up (section.test.ts evalForce) and isn't re-tested here.

describe("sampleForce", () => {
    test("an empty profile is the constant DEFAULT_G everywhere", () => {
        for (const s of [-5, 0, 10, 1e6]) expect(sampleForce([], s)).toBe(DEFAULT_G);
    });

    test("a single point holds its value flat on both sides", () => {
        const pts: ForcePoint[] = [{ s: 10, g: 2.5 }];
        expect(sampleForce(pts, 0)).toBe(2.5); // before → held
        expect(sampleForce(pts, 10)).toBe(2.5); // at
        expect(sampleForce(pts, 40)).toBe(2.5); // after → held
    });

    test("interpolates linearly between two points, holds beyond the ends", () => {
        const pts: ForcePoint[] = [
            { s: 0, g: 1 },
            { s: 10, g: 3 },
        ];
        expect(sampleForce(pts, -2)).toBe(1); // held before first
        expect(sampleForce(pts, 0)).toBe(1);
        expect(sampleForce(pts, 2.5)).toBeCloseTo(1.5, 12); // ¼ of the way → 1 + 0.25·2
        expect(sampleForce(pts, 5)).toBeCloseTo(2, 12);
        expect(sampleForce(pts, 10)).toBe(3);
        expect(sampleForce(pts, 99)).toBe(3); // held after last
    });

    test("picks the right interval among many (binary search), coincident-s collapses", () => {
        const pts: ForcePoint[] = [
            { s: 0, g: 1 },
            { s: 10, g: 2 },
            { s: 10, g: 5 }, // coincident with the previous — zero-width span
            { s: 20, g: 0 },
        ];
        expect(sampleForce(pts, 5)).toBeCloseTo(1.5, 12); // between pts[0], pts[1]
        expect(sampleForce(pts, 15)).toBeCloseTo(2.5, 12); // between pts[2] (g=5) and pts[3] (g=0)
    });
});

describe("forceProfile", () => {
    test("edge count is round(length/ds), sampled at the source σ_i = i·ds", () => {
        const pts: ForcePoint[] = [
            { s: 0, g: 1 },
            { s: 10, g: 3 },
        ];
        const ds = 0.5;
        const length = 10;
        const fN = forceProfile(pts, length, ds);
        expect(fN.length).toBe(20); // 10 / 0.5
        for (let i = 0; i < fN.length; i++) expect(fN[i]).toBeCloseTo(sampleForce(pts, i * ds), 6);
        expect(fN[0]).toBe(1); // σ = 0
        expect(fN[10]).toBeCloseTo(2, 6); // σ = 5, midway
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
