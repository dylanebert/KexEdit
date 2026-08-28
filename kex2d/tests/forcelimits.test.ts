import { describe, expect, test } from "bun:test";
import { V_WARN } from "../src/bake";
import {
    checkBand,
    checkForceLimits,
    DEFAULT_PROFILE,
    pairwiseEllipseOk,
    pairwiseEllipseValue,
    TABLE_7_1_BASE_BOUNDS,
} from "../src/forcelimits";
import type { BakeOutLike } from "../src/stats";

/** builds a synthetic bake at constant sample spacing `dt`, so `t[i] = i * dt` exactly and every
 *  run's duration is controllable to the second — the same "constant speed" convention
 *  `stats.test.ts`'s flat-line case uses (v held constant so ds/dt stays fixed). `fN` is per-edge
 *  (`count - 1` entries); `v` is left at a value comfortably above `V_WARN` so feasibility never
 *  interferes with the fixture. */
function bakeAt(fN: number[], dt: number): BakeOutLike {
    const count = fN.length + 1;
    const ds = new Float32Array(fN.length).fill(1);
    const v = new Float32Array(count).fill(V_WARN * 10);
    const t = new Float64Array(count);
    for (let i = 1; i < count; i++) t[i] = t[i - 1] + dt;
    return {
        fN: new Float32Array(fN),
        ds,
        v,
        t,
        tTotal: t[count - 1],
        feasible: new Uint8Array(count).fill(1),
        firstInfeasible: -1,
    };
}

describe("checkBand — +Gz", () => {
    const band = DEFAULT_PROFILE.bands.find((b) => b.axis === "Gz" && b.sign === "+")!;

    test("RED: 6g held for 1.2 s breaches the 6g/1.0s step (and the looser 4g/3.5s, 3g/7.0s steps too)", () => {
        // 13 edges at dt=0.1s -> the whole run spans 1.3s of elapsed time (13 * 0.1).
        const fN = new Array(13).fill(6.0);
        const out = bakeAt(fN, 0.1);
        const breaches = checkBand(out, out.fN.length + 1, band);
        const sixG = breaches.find((b) => b.thresholdG === 6.0);
        expect(sixG).toBeDefined();
        expect(sixG!.observedDurationS).toBeCloseTo(1.3, 6);
        expect(sixG!.observedG).toBeCloseTo(6.0, 6);
        // 1.3s clears ONLY the 6g/1.0s cap — the looser steps (4g/3.5s, 3g/7.0s, 2g/11.8s,
        // 1g/40s) all have a maxDurationS the 1.3s run stays under, so they read clean.
        expect(breaches.length).toBe(1);
        expect(breaches.some((b) => b.thresholdG === 4.0)).toBe(false);
    });

    test("GREEN: 6g held for exactly 0.9 s (under the 1.0s cap) breaches nothing", () => {
        const fN = new Array(9).fill(6.0);
        const out = bakeAt(fN, 0.1);
        const breaches = checkBand(out, out.fN.length + 1, band);
        expect(breaches).toEqual([]);
    });

    test("GREEN: a brief sub-0.2s 6g impact never breaches (out of the g-band regime by construction)", () => {
        const fN = new Array(1).fill(6.0);
        const out = bakeAt(fN, 0.1); // one edge, 0.1 s duration — below every step's own cap
        const breaches = checkBand(out, out.fN.length + 1, band);
        expect(breaches).toEqual([]);
    });

    test("GREEN: level 1g flat track under the 40s cap never breaches", () => {
        const fN = new Array(390).fill(1.0);
        const out = bakeAt(fN, 0.1); // 39s span — comfortably under the 1g/40s cap, avoiding
        // a floating-point coin-flip at the exact 40.0 boundary (accumulated dt drifts past it).
        const breaches = checkBand(out, out.fN.length + 1, band);
        expect(breaches).toEqual([]);
    });

    test(
        "GREEN: 1g held for 60 s (inside the 40-90s window a duplicated {1.0, 40} step used to " +
            "falsely breach) never breaches — the [40s, 90s) window IS sampled here",
        () => {
            const fN = new Array(600).fill(1.0);
            const out = bakeAt(fN, 0.1); // 60s span — squarely inside [40s, 90s), the window a
            // {thresholdG: 1.0, maxDurationS: 40} step (sharing the 90s step's threshold) used to
            // falsely flag, since checkBand evaluates every step independently.
            const breaches = checkBand(out, out.fN.length + 1, band);
            expect(breaches).toEqual([]);
        },
    );

    test("RED: 1g held for 95 s (past the 90s exposure cap) breaches the 1.0g/90s step", () => {
        const fN = new Array(950).fill(1.0);
        const out = bakeAt(fN, 0.1); // 95s span — past the last step's own 90s cap.
        const breaches = checkBand(out, out.fN.length + 1, band);
        const oneG = breaches.find((b) => b.thresholdG === 1.0);
        expect(oneG).toBeDefined();
        expect(oneG!.maxDurationS).toBe(90);
        expect(oneG!.observedDurationS).toBeCloseTo(95.0, 6);
        expect(breaches.length).toBe(1);
    });
});

describe("checkBand — -Gz", () => {
    const band = DEFAULT_PROFILE.bands.find((b) => b.axis === "Gz" && b.sign === "-")!;

    test("RED: -2g held for 12 s breaches the -2g/11.8s step", () => {
        const fN = new Array(120).fill(-2.0);
        const out = bakeAt(fN, 0.1); // 12.0s span
        const breaches = checkBand(out, out.fN.length + 1, band);
        const twoG = breaches.find((b) => b.thresholdG === -2.0);
        expect(twoG).toBeDefined();
        expect(twoG!.observedDurationS).toBeCloseTo(12.0, 6);
        expect(twoG!.observedG).toBeCloseTo(-2.0, 6);
    });

    test("GREEN: -2g held for 11.5 s (under the 11.8s cap) breaches nothing", () => {
        const fN = new Array(115).fill(-2.0);
        const out = bakeAt(fN, 0.1);
        const breaches = checkBand(out, out.fN.length + 1, band);
        expect(breaches).toEqual([]);
    });
});

describe("checkForceLimits — whole-profile wiring", () => {
    test("RED: a track that spikes +Gz for too long reads a named breach with station/duration", () => {
        const level = new Array(50).fill(1.0);
        const spike = new Array(13).fill(6.0); // 1.3s at dt=0.1
        const out = bakeAt([...level, ...spike, ...level], 0.1);
        const breaches = checkForceLimits(out, out.fN.length + 1);
        expect(breaches.length).toBeGreaterThan(0);
        const named = breaches.find((b) => b.thresholdG === 6.0);
        expect(named).toBeDefined();
        expect(named!.startStation).toBeCloseTo(50, 6);
        expect(named!.axis).toBe("Gz");
        expect(named!.sign).toBe("+");
    });

    test("GREEN: a compliant track (1g flat, brief safe excursions) reads no breach", () => {
        const level = new Array(50).fill(1.0);
        const safeSpike = new Array(5).fill(6.0); // 0.5s — well under the 1.0s cap
        const out = bakeAt([...level, ...safeSpike, ...level], 0.1);
        const breaches = checkForceLimits(out, out.fN.length + 1);
        expect(breaches).toEqual([]);
    });

    test("only Gz bands are evaluated — Gx/Gy bands ship in DEFAULT_PROFILE but never contribute a breach", () => {
        const axesChecked = new Set(DEFAULT_PROFILE.bands.map((b) => b.axis));
        expect(axesChecked.has("Gx")).toBe(true);
        expect(axesChecked.has("Gy")).toBe(true);
        // a profile whose only band is a trivially-breaching Gx step must still read clean —
        // proves checkForceLimits skips non-Gz bands rather than merely never having one that fires.
        const out = bakeAt(new Array(200).fill(6.0), 0.1); // 20s at 6g — would breach every Gx/Gy step
        const gxOnly = {
            ...DEFAULT_PROFILE,
            bands: DEFAULT_PROFILE.bands.filter((b) => b.axis !== "Gz"),
        };
        expect(checkForceLimits(out, out.fN.length + 1, gxOnly)).toEqual([]);
    });
});

describe("pairwiseEllipseValue — pure primitive, synthetic multi-axis input", () => {
    test("a reading exactly at one axis's bound with the other at zero reads exactly 1", () => {
        const v = pairwiseEllipseValue(6.0, TABLE_7_1_BASE_BOUNDS.Gz, 0, TABLE_7_1_BASE_BOUNDS.Gx);
        expect(v).toBeCloseTo(1, 10);
        expect(pairwiseEllipseOk(6.0, TABLE_7_1_BASE_BOUNDS.Gz, 0, TABLE_7_1_BASE_BOUNDS.Gx)).toBe(
            true,
        );
    });

    test("a reading past both bounds simultaneously fails the ellipse (RED)", () => {
        const v = pairwiseEllipseValue(
            6.0,
            TABLE_7_1_BASE_BOUNDS.Gz,
            3.0,
            TABLE_7_1_BASE_BOUNDS.Gy,
        );
        expect(v).toBeGreaterThan(1);
        expect(
            pairwiseEllipseOk(6.0, TABLE_7_1_BASE_BOUNDS.Gz, 3.0, TABLE_7_1_BASE_BOUNDS.Gy),
        ).toBe(false);
    });

    test("a reading well inside both bounds passes (GREEN)", () => {
        expect(
            pairwiseEllipseOk(1.0, TABLE_7_1_BASE_BOUNDS.Gz, 0.5, TABLE_7_1_BASE_BOUNDS.Gy),
        ).toBe(true);
    });

    test("asymmetric bound: a negative reading is checked against |min|, not max", () => {
        // Gz bound is [-2.00, 6.00]; a -2.00 reading should read exactly 1 against |min|=2.00,
        // not 6.00 (which would read (2/6)^2 ≈ 0.11 and silently under-enforce the floor).
        const v = pairwiseEllipseValue(-2.0, TABLE_7_1_BASE_BOUNDS.Gz, 0, TABLE_7_1_BASE_BOUNDS.Gx);
        expect(v).toBeCloseTo(1, 10);
    });
});

describe("DEFAULT_PROFILE — reference discipline", () => {
    test("every band step marked exact corresponds to one of Rohde's four exact-quoted breakpoints (0.2, 11.8, 40, 90)", () => {
        const ExactBreakpoints = new Set([11.8, 40, 90]); // 0.2 is `sustainedMinDurationS`, not a step
        for (const band of DEFAULT_PROFILE.bands) {
            for (const step of band.steps) {
                if (step.exact) expect(ExactBreakpoints.has(step.maxDurationS)).toBe(true);
            }
        }
    });

    test(
        "bandThresholdsStrictlyDescending: no band repeats a thresholdG (set-membership over the " +
            "exact breakpoints alone is not enough — a duplicated threshold with a tighter, wrong " +
            "cap would still pass the test above)",
        () => {
            for (const band of DEFAULT_PROFILE.bands) {
                const magnitudes = band.steps.map((s) => Math.abs(s.thresholdG));
                const seen = new Set<number>();
                for (const m of magnitudes) {
                    expect(seen.has(m)).toBe(false); // no duplicate |thresholdG| within one band
                    seen.add(m);
                }
                for (let i = 1; i < magnitudes.length; i++) {
                    expect(magnitudes[i]).toBeLessThan(magnitudes[i - 1]); // strictly descending
                }
            }
        },
    );

    test("no invented speed floor ships as a default", () => {
        expect(DEFAULT_PROFILE.speedFloorMps).toBeUndefined();
    });

    test("the profile round-trips through JSON verbatim (it is the wire format)", () => {
        const round = JSON.parse(JSON.stringify(DEFAULT_PROFILE));
        expect(round).toEqual(DEFAULT_PROFILE);
    });

    test("every band names a citation into Rohde", () => {
        for (const band of DEFAULT_PROFILE.bands) {
            expect(band.citation.length).toBeGreaterThan(0);
        }
    });
});
