import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "../src/doc";
import { FORCE_BUDGET, GEO_BUDGET } from "../src/geofit";
import { type BakeSamples, compareBakes, fitPitch, type PitchTarget } from "../src/pitchfit";
import { Easing } from "../src/profile";
import { evalPitch } from "../src/section";

// the migration fit (spec `kex2d-segment-gestures` Validation 9): `pitchfit.ts` re-expresses one
// baked geo run as pitch-lane records under `geofit.ts`'s dual budget, and `migrations[3]`
// refuses — never widens a budget — when it cannot. Device-free: pure arrays and pure documents.
//
// Every fit number here is read through `migrate` (`parseDocument` on a frozen v3 file), never
// through a payload builder on a raw v3 document: a raw document carries no `track.v0`, so the
// start speed defaults to `V0` and the whole run bakes at the wrong energy — the misreading the
// stage's first numbers came out of (spec architect Answer, 2026-09-07).

/** a frozen v3 fixture, migrated. */
function migrated(rel: string) {
    return parseDocument(readFileSync(join(import.meta.dir, "fixtures", "v3", rel), "utf8"));
}

// ── the budget observable itself ─────────────────────────────────────────────────────────────

describe("compareBakes: the station-tolerant force observable", () => {
    /** a straight run along +x with a STEP in the recovered force at `at` metres. Positions are
     *  identical on every variant, so every reading below is a reading of the force axis alone. */
    function stepped(ds: number, length: number, at: number, lo = 1, hi = 2): BakeSamples {
        const edges = Math.round(length / ds);
        const x = new Float32Array(edges + 1);
        const y = new Float32Array(edges + 1);
        const fN = new Float32Array(edges);
        for (let i = 0; i <= edges; i++) x[i] = i * ds;
        for (let k = 0; k < edges; k++) fN[k] = k * ds >= at ? hi : lo;
        return { x, y, fN, ds: new Float32Array(edges).fill(ds), edges };
    }

    const landed = 0.5;
    const coarse = stepped(landed, 20, 10);

    test("a level error is never forgiven, at any station tolerance", () => {
        // the shift the tolerance must NOT buy: a curve 0.6 g too high everywhere agrees with
        // nothing inside any window, because no window changes a level.
        const lifted = stepped(landed, 20, 10, 1.6, 2.6);
        expect(compareBakes(coarse, lifted, landed).force).toBeCloseTo(0.6, 6);
        expect(compareBakes(coarse, lifted, landed).force).toBeGreaterThan(FORCE_BUDGET);
        // and it stays a breach however wide the window gets — the tolerance is a grid, not a
        // budget dial.
        expect(compareBakes(coarse, lifted, 5).force).toBeGreaterThan(FORCE_BUDGET);
    });

    test("a sub-cell station shift of the same step passes", () => {
        // the reading the tolerance exists for: two grids placing one curvature step 0.4 m
        // apart while agreeing on its level. Pointwise this reads as the whole 1 g height.
        const fine = stepped(0.1, 20, 10.4);
        expect(compareBakes(coarse, fine, landed).force).toBeCloseTo(0, 6);
        expect(compareBakes(coarse, fine, landed).force).toBeLessThan(FORCE_BUDGET);
        expect(compareBakes(coarse, fine, 0).force).toBeGreaterThan(0.9);
    });

    test("a two-cell station shift fails", () => {
        // …and the tolerance is exactly one landed edge, so a step a whole metre out of place on
        // a 0.5 m grid is a real disagreement, not a phase difference.
        const fine = stepped(0.1, 20, 11);
        expect(compareBakes(coarse, fine, landed).force).toBeGreaterThan(FORCE_BUDGET);
    });

    test("a corner station is unread for force, and still read for position", () => {
        // a spike confined to one landed edge either side of station 10 — the shape an authored
        // C0 corner takes, where the continuum force is unbounded and the two bakes spread it
        // over different numbers of edges.
        const spiked = stepped(landed, 20, 10);
        for (let k = 0; k < spiked.edges; k++)
            if (Math.abs(k * landed - 10) <= landed) (spiked.fN as Float32Array)[k] += 5;
        expect(compareBakes(coarse, spiked, landed).force).toBeCloseTo(5, 4);
        expect(compareBakes(coarse, spiked, landed, [10]).force).toBeCloseTo(0, 6);
        // position is never forgiven at a corner: displace one bake and the deviation is seen.
        const moved = stepped(landed, 20, 10);
        for (let i = 0; i <= moved.edges; i++) (moved.y as Float32Array)[i] = 3;
        expect(compareBakes(coarse, moved, landed, [10]).position).toBeCloseTo(3, 4);
    });
});

// ── the fit's own laws, on a synthetic target ────────────────────────────────────────────────

/** a pitch run baked from `points`, handed back in the shape {@link fitPitch} fits against — a
 *  target the fit can reach exactly, so what an arm below reads is the fit's decision rather
 *  than an unreachable残 residual. */
function targetOf(points: { s: number; g: number; ease: Easing }[], length: number): PitchTarget {
    const ds = 0.5;
    const edges = Math.round(length / ds);
    const entry = { x: 0, y: 0, theta: 0, v: 25 };
    const r = evalPitch(entry, points, { edges, ds }, points[0]!.ease);
    return {
        x: r.posX,
        y: r.posY,
        theta: r.theta,
        fN: r.fN,
        ds: r.ds,
        edges: r.edges,
        entry,
    };
}

describe("fitPitch outcomes", () => {
    test("a reachable target fits inside both budgets and reports `budget`", () => {
        const target = targetOf(
            [
                { s: 0, g: 0, ease: Easing.Linear },
                { s: 30, g: 0.5, ease: Easing.Linear },
            ],
            30,
        );
        const fit = fitPitch(target, [0, 30]);
        expect(fit.outcome).toBe("budget");
        expect(fit.deviation).toBeLessThanOrEqual(GEO_BUDGET);
        expect(fit.forceError).toBeLessThanOrEqual(FORCE_BUDGET);
        expect(fit.records[0]!.entry).toBeCloseTo(0, 3);
    });

    test("a budget shrunk below what any record floor can reach is REFUSED, never shipped", () => {
        // the synthetic refusal arm: the same reachable target under a budget no fit can hold.
        // There is no outcome that ships a breach — a flagged best-effort fit would be a waiver
        // ledger, and every consumer downstream would inherit it.
        const target = targetOf(
            [
                { s: 0, g: 0, ease: Easing.Linear },
                { s: 20, g: 1.2, ease: Easing.Cubic },
                { s: 40, g: -0.4, ease: Easing.Quintic },
            ],
            40,
        );
        const fit = fitPitch(target, [0, 20, 40], { geo: 1e-6, force: 1e-6 });
        expect(fit.outcome).not.toBe("budget");
        expect(["floor", "refused"]).toContain(fit.outcome);
        // and the refusal is REAL: the residual it reports is genuinely outside the budget it
        // was asked for, so this is not an outcome label with nothing behind it.
        expect(Math.max(fit.deviation, fit.forceError)).toBeGreaterThan(1e-6);
    });

    test("`budget` is reported exactly when both budgets hold, never as a default", () => {
        // the `refused` branch's own witness, isolated from the record floor: with refinement
        // given no rounds at all the fit converges immediately, so the ONLY thing deciding the
        // outcome is whether the residual holds. It must not read `budget` on a breach.
        const target = targetOf(
            [
                { s: 0, g: 0, ease: Easing.Linear },
                { s: 20, g: 1.2, ease: Easing.Cubic },
                { s: 40, g: -0.4, ease: Easing.Quintic },
            ],
            40,
        );
        const tight = fitPitch(target, [0, 20, 40], { geo: 1e-9, force: 1e-9, maxRounds: 0 });
        expect(tight.outcome).toBe("refused");
        expect(Math.max(tight.deviation, tight.forceError)).toBeGreaterThan(1e-9);
        // the safe direction: the same call under the real budgets reports `budget`, so the
        // branch above is a reading of the residual and not a constant.
        const reachable = targetOf(
            [
                { s: 0, g: 0, ease: Easing.Linear },
                { s: 30, g: 0.5, ease: Easing.Linear },
            ],
            30,
        );
        const loose = fitPitch(reachable, [0, 30], { maxRounds: 0 });
        expect(loose.outcome).toBe("budget");
    });

    test("easing selection holds the force budget, not the position reading alone", () => {
        // a target whose best-position tag and best-force tag differ: the fit must not take a
        // decimetre of position while pushing |ΔfN| out of budget (spec architect Answer,
        // 2026-09-07, S2d, blocker (a)).
        const target = targetOf(
            [
                { s: 0, g: 0, ease: Easing.Linear },
                { s: 24, g: 0.8, ease: Easing.Linear },
            ],
            24,
        );
        const fit = fitPitch(target, [0, 24]);
        expect(fit.forceError).toBeLessThanOrEqual(FORCE_BUDGET);
        // the tag the fit chose reproduces the target: Linear, the tag the target was built at.
        expect(fit.records.map((r) => r.ease)).toEqual([Easing.Linear]);
    });

    test("a corner station mints a successor-owned entry, not one interpolated across it", () => {
        const target = targetOf(
            [
                { s: 0, g: 0, ease: Easing.Linear },
                { s: 20, g: 0.6, ease: Easing.Linear },
                { s: 20, g: -0.6, ease: Easing.Linear },
                { s: 40, g: 0, ease: Easing.Linear },
            ],
            40,
        );
        const fit = fitPitch(target, [0, 20, 40], {}, undefined, [20]);
        const step = fit.records.findIndex((r) => r.start === 20);
        expect(step).toBeGreaterThan(0);
        const before = fit.records[step - 1]!;
        const after = fit.records[step]!;
        expect(after.entry).toBeDefined();
        // the two sides of the corner disagree, which is the whole content of "discontinuity":
        // a single interpolated handle there would sit between them and belong to neither.
        expect(Math.abs((after.entry as number) - before.exit)).toBeGreaterThan(0.5);
    });
});

// ── the corpus, through `migrate` ────────────────────────────────────────────────────────────

describe("every geo-bearing fixture migrates within both budgets", () => {
    /** the geo-bearing corpus: the ten frozen v3 CLI scenarios plus the golden, minus the named
     *  refusal witness, and the four v2 fixtures whose chains carry a geo run. Fourteen — the
     *  population Validation 2 pins its geo-bearing half at. */
    const v3Geo = [
        "cli/circular-arc.kex",
        "cli/double-hump.kex",
        "cli/full-loop.kex",
        "cli/hill-auto.kex",
        "cli/hill-explicit.kex",
        "cli/parabola-hill.kex",
        "cli/s-curve.kex",
        "cli/straight-fillet.kex",
        "cli/valley-explicit.kex",
        "hill-explicit-golden.kex",
    ];
    const v2Geo = [
        "force/all-easings.kex",
        "force/force-first.kex",
        "invariants/valid-green.kex",
        "velocity/interior-geo-edge.kex",
    ];

    test("the population is the fourteen geo-bearing documents", () => {
        expect(v3Geo.length + v2Geo.length).toBe(14);
    });

    for (const name of v3Geo) {
        test(`v3/${name} migrates to a non-empty pitch lane`, () => {
            // reaching a migrated document at all IS the budget statement: `doc.fitGeoRun`
            // refuses every outcome but `budget`, so a lane here cannot carry a breach. The
            // magnitudes themselves are read whole-bake by `tests/bake-identity.oracle.ts`.
            const doc = migrated(name);
            expect(doc.lanes.geo.length).toBeGreaterThan(0);
            for (const r of doc.lanes.geo) {
                expect(Number.isFinite(r.exit)).toBe(true);
                expect(r.end).toBeGreaterThan(r.start);
            }
            // the lane is contiguous over the run — abutting records, no gap the author never
            // authored.
            for (let i = 1; i < doc.lanes.geo.length; i++)
                expect(doc.lanes.geo[i]!.start).toBe(doc.lanes.geo[i - 1]!.end);
        });
    }

    for (const name of v2Geo) {
        test(`${name} migrates to a non-empty pitch lane`, () => {
            const text = readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
            const doc = parseDocument(text);
            expect(doc.lanes.geo.length).toBeGreaterThan(0);
        });
    }

    test("cli/circular-arc: an Auto-reflect arc fits one Linear record per node pair", () => {
        const lanes = migrated("cli/circular-arc.kex").lanes;
        expect(lanes.geo.map((r) => r.ease)).toEqual([Easing.Linear, Easing.Linear]);
    });

    test("cli/hill-explicit: an explicit-tangent group fits within budget by SPLIT", () => {
        // the node landings alone do not hold the budget on this chain, so the fit must cut —
        // more records than the chain has node pairs is the observable, not a count for its own
        // sake.
        const lanes = migrated("cli/hill-explicit.kex").lanes;
        expect(lanes.geo.length).toBeGreaterThan(4);
    });

    test("cli/valley-explicit: the C0 corner is minted as an authored discontinuity", () => {
        const lanes = migrated("cli/valley-explicit.kex").lanes;
        // the corner sits at 37.28 m on this chain (a Free tangent whose in and out directions
        // differ by 0.927 rad), and a record boundary must land exactly on it.
        const at = lanes.geo.findIndex((r) => Math.abs(r.start - 37.277) < 0.01);
        expect(at).toBeGreaterThan(0);
        const before = lanes.geo[at - 1]!;
        const after = lanes.geo[at]!;
        expect(after.entry).toBeDefined();
        expect(after.entry).not.toBe(before.exit);
    });
});

// ── the live refusal witness ─────────────────────────────────────────────────────────────────

test("v3/cli/loop-explicit.kex is refused with a remedy naming the retired build", () => {
    // the one document in the corpus the record floor cannot fit: its Mirror tangents are stored
    // at the Bezier control offset where `hermite` reads a velocity, so the claimed circle bakes
    // ~1 m-radius near-cusps at every quadrant node — a sub-quantum feature no ≥1 m record
    // represents. Refused with a named remedy rather than shipped as a best-effort fit.
    expect(() => migrated("cli/loop-explicit.kex")).toThrow(/retired\/pose-ux/);
    expect(() => migrated("cli/loop-explicit.kex")).toThrow(/cannot be fitted to pitch records/);
    // and the refusal names the budgets it could not hold, so the message is diagnosable.
    expect(() => migrated("cli/loop-explicit.kex")).toThrow(/0\.5 m and 0\.5 g/);
});
