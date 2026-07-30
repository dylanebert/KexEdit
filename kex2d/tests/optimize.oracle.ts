import { describe, expect, test } from "bun:test";
import { V_FLOOR } from "../src/forward";
import { computeExit, derivedTol, solveOptimize } from "../src/optimize";
import { forceProfile, type ForcePoint } from "../src/profile";
import { type Entry, evalForce } from "../src/section";

// the corpus-scale optimize gate (`kex2d-optimize-mode` stage 3, full tier): the universal
// claims over the lab's scenario set — every feasible single-key edit solves and its replayed
// exit meets the DERIVED floor (never an absolute number); every stalling edit certifies
// `"unreachable"/"stall"` at invoke; the continuation ladder holds the drift ramp the lab
// measured (`tests/optimize.lab.ts` §5b). Fast-tier sentinels for the same laws live in
// `tests/optimize.test.ts` (stage-3 describe block + the golden fixture).

const DS = 0.5;
const ENTRY: Entry = { x: 0, y: 0, theta: 0, v: 20 };

interface Scenario {
    name: string;
    points: ForcePoint[];
    length: number;
    entry: Entry;
}

function corpus(): Scenario[] {
    const hill = (scale: number): ForcePoint[] => [
        { s: 0 * scale, g: 1 },
        { s: 10 * scale, g: 1.5 },
        { s: 20 * scale, g: 1 },
        { s: 30 * scale, g: 0.8 },
        { s: 40 * scale, g: 1 },
    ];
    return [
        { name: "gentle hill (L=40)", points: hill(1), length: 40, entry: ENTRY },
        {
            name: "big swing (L=25)",
            length: 25,
            entry: ENTRY,
            points: [
                { s: 0, g: 1 },
                { s: 5, g: 3 },
                { s: 10, g: -1 },
                { s: 15, g: 3 },
                { s: 20, g: 1 },
                { s: 25, g: 1 },
            ],
        },
        {
            name: "hill x4 (L=160)",
            points: hill(4),
            length: 160,
            entry: { x: 0, y: 0, theta: 0, v: 30 },
        },
        {
            name: "hill x10 (L=400)",
            points: hill(10),
            length: 400,
            entry: { x: 0, y: 0, theta: 0, v: 40 },
        },
    ];
}

function vMin(sc: Scenario, points: ForcePoint[]): number {
    const r = evalForce(sc.entry, forceProfile(points, sc.length, DS), DS, undefined);
    let m = Infinity;
    for (let i = 0; i < r.v.length; i++) m = Math.min(m, r.v[i]);
    return m;
}

describe("optimize corpus: every single-key ±0.2 g edit resolves honestly", () => {
    for (const sc of corpus()) {
        test(sc.name, () => {
            const stamp = computeExit(sc.entry, sc.points, sc.length, DS);
            const floor = derivedTol(stamp, sc.length, DS);
            for (let k = 0; k < sc.points.length; k++) {
                for (const sign of [1, -1]) {
                    const edited = sc.points.map((p, i) => ({
                        ...p,
                        g: i === k ? p.g + sign * 0.2 : p.g,
                    }));
                    const r = solveOptimize({
                        entry: sc.entry,
                        points: edited,
                        locked: new Set(),
                        length: sc.length,
                        ds: DS,
                        stamp,
                    });
                    const where = `${sc.name} key ${k} ${sign > 0 ? "+" : "−"}0.2`;
                    if (vMin(sc, edited) <= V_FLOOR) {
                        // a stalling edit must certify at invoke, never grind the budget
                        expect(`${where}: ${r.outcome}/${r.reason}`).toBe(
                            `${where}: unreachable/stall`,
                        );
                        expect(r.iters).toBe(0);
                    } else {
                        expect(`${where}: ${r.outcome}`).toBe(`${where}: solved`);
                        const back = computeExit(sc.entry, r.points, sc.length, DS);
                        expect(Math.abs(back.x - stamp.x)).toBeLessThan(floor.pos);
                        expect(Math.abs(back.y - stamp.y)).toBeLessThan(floor.pos);
                        expect(Math.abs(back.theta - stamp.theta)).toBeLessThan(floor.angle);
                    }
                    // refusal shape: a reason exists iff the outcome is unreachable
                    expect(r.reason !== undefined).toBe(r.outcome === "unreachable");
                }
            }
        });
    }
});

describe("optimize corpus: the continuation ladder holds the measured drift ramp", () => {
    // lab §5b post-change: every feasible ramp drift through +6 g solves (gentle hill's +2 g
    // stalls the march — non-monotone in the drift, the +3 g draft loops fast enough to keep
    // its speed — and must certify, not grind).
    for (const sc of corpus().slice(0, 2)) {
        test(sc.name, () => {
            const stamp = computeExit(sc.entry, sc.points, sc.length, DS);
            const floor = derivedTol(stamp, sc.length, DS);
            for (const dg of [0.5, 1, 2, 3, 4, 6]) {
                const edited = sc.points.map((p, i) => ({
                    ...p,
                    g: i === 1 ? p.g + dg : p.g,
                }));
                const r = solveOptimize({
                    entry: sc.entry,
                    points: edited,
                    locked: new Set(),
                    length: sc.length,
                    ds: DS,
                    stamp,
                });
                if (vMin(sc, edited) <= V_FLOOR) {
                    expect(`+${dg}g: ${r.outcome}/${r.reason}`).toBe(`+${dg}g: unreachable/stall`);
                    continue;
                }
                expect(`+${dg}g: ${r.outcome}`).toBe(`+${dg}g: solved`);
                const back = computeExit(sc.entry, r.points, sc.length, DS);
                expect(Math.abs(back.x - stamp.x)).toBeLessThan(floor.pos);
                expect(Math.abs(back.y - stamp.y)).toBeLessThan(floor.pos);
                expect(Math.abs(back.theta - stamp.theta)).toBeLessThan(floor.angle);
            }
        });
    }
});
