// The comparison seam's own tests (`kex2d-golden-reproducibility` stage 3b), not the physics'.
// Three claims, each per the spec's Validation section: the field registry is closed both
// directions against the REAL fixtures (never a hand-typed key list), the bounded comparison
// actually discriminates (red at 10x its bound, green at 0.1x), and a structural mismatch hard
// fails before any bounded field is even read.
import { describe, expect, test } from "bun:test";
import type { Bucket } from "./helpers/compare";
import { compareGolden, registryClosure, setClosure } from "./helpers/compare";
import convertGolden from "./fixtures/convert-golden.json";
import forcegeoGolden from "./fixtures/forcegeo-golden.json";
import {
    CONVERT_REGISTRY,
    FORCEGEO_GOLDEN,
    FORCEGEO_REGISTRY,
    FORCEGEO_SOURCE_STAMP,
    GOLDEN,
    KNOWN_STAMPS,
    NOMINAL_MISS,
} from "./helpers/golden";

const CONVERT_SAMPLE = convertGolden[FORCEGEO_SOURCE_STAMP]["circular-arc"];
const FORCEGEO_SAMPLE = forcegeoGolden["circular-arc"];

describe("platform stamp closure — convert-golden.json's top-level namespace", () => {
    // every stamp the fixture actually carries is declared, and every declared stamp is
    // present — the declared-registry law (`editor-ui.md`) one level above `registryClosure`'s
    // per-scenario field check, since 3g's platform stamp is a new key at the fixture's TOP
    // level, not inside any one scenario's record.
    test("convert-golden.json's stamps are exactly the declared KNOWN_STAMPS", () => {
        expect(setClosure(Object.keys(convertGolden), KNOWN_STAMPS)).toEqual({
            missing: [],
            orphan: [],
        });
    });

    // positive control, direction 1: an undeclared stamp key must be caught.
    test("an undeclared stamp key fails closure", () => {
        const { missing } = setClosure([...Object.keys(convertGolden), "bogus os"], KNOWN_STAMPS);
        expect(missing).toContain("bogus os");
    });

    // positive control, direction 2: a declared stamp missing from the fixture must be caught.
    test("a declared stamp missing from the fixture fails closure", () => {
        const remaining = Object.keys(convertGolden).filter((key) => key !== "linux x64");
        const { orphan } = setClosure(remaining, KNOWN_STAMPS);
        expect(orphan).toContain("linux x64");
    });
});

describe("platform stamp closure — NOMINAL_MISS", () => {
    // `NOMINAL_MISS` (`helpers/golden.ts`) is a second stamp-keyed registry, same discipline as
    // `convert-golden.json`'s top-level namespace: every stamp it declares must be a known one,
    // and every known stamp must have a record (`refine.oracle.ts`'s nominal-replay claim
    // hard-fails, never skips, on a platform with no recorded miss data).
    test("NOMINAL_MISS's stamps are exactly the declared KNOWN_STAMPS", () => {
        expect(setClosure(Object.keys(NOMINAL_MISS), KNOWN_STAMPS)).toEqual({
            missing: [],
            orphan: [],
        });
    });

    // positive control, direction 1: an undeclared stamp key must be caught.
    test("an undeclared NOMINAL_MISS stamp key fails closure", () => {
        const { missing } = setClosure([...Object.keys(NOMINAL_MISS), "bogus os"], KNOWN_STAMPS);
        expect(missing).toContain("bogus os");
    });

    // positive control, direction 2: a declared stamp missing from NOMINAL_MISS must be caught.
    test("a declared stamp missing from NOMINAL_MISS fails closure", () => {
        const remaining = Object.keys(NOMINAL_MISS).filter((key) => key !== "darwin arm64");
        const { orphan } = setClosure(remaining, KNOWN_STAMPS);
        expect(orphan).toContain("darwin arm64");
    });
});

describe("field registry closure — declared-registry law", () => {
    // every real fixture key resolves to exactly one bucket, read via `Object.keys` on the
    // actual fixture record, never a re-typed list that could drift from it.
    test("convert-golden.json's registry is closed both directions", () => {
        expect(registryClosure(CONVERT_SAMPLE, CONVERT_REGISTRY)).toEqual({
            missing: [],
            orphan: [],
        });
    });

    test("forcegeo-golden.json's registry is closed both directions", () => {
        expect(registryClosure(FORCEGEO_SAMPLE, FORCEGEO_REGISTRY)).toEqual({
            missing: [],
            orphan: [],
        });
    });

    // positive control, direction 1: a key on the fixture with no bucket must be caught.
    test("an undeclared fixture key fails closure", () => {
        const withExtra = { ...CONVERT_SAMPLE, family: "flat" };
        const { missing } = registryClosure(withExtra, CONVERT_REGISTRY);
        expect(missing).toContain("family");
    });

    // positive control, direction 2: a bucket naming a key the fixture doesn't have must be
    // caught — the exact failure mode the law exists to prevent (`family` was once bucketed by
    // omission in a different fixture's registry, per the spec).
    test("an orphan registry declaration fails closure", () => {
        const withOrphan: Record<string, Bucket> = {
            ...CONVERT_REGISTRY,
            ghost: { kind: "exact" },
        };
        const { orphan } = registryClosure(CONVERT_SAMPLE, withOrphan);
        expect(orphan).toContain("ghost");
    });

    // and the same two controls read on the nested `points[]`/`nodes[]` member keys, not just
    // the top level.
    test("an undeclared points[] member key fails closure", () => {
        const withExtra = {
            ...CONVERT_SAMPLE,
            points: CONVERT_SAMPLE.points.map((p) => ({ ...p, extra: 0 })),
        };
        const { missing } = registryClosure(withExtra, CONVERT_REGISTRY);
        expect(missing).toContain("points[].extra");
    });

    test("an orphan points[] member declaration fails closure", () => {
        const withOrphan: Record<string, Bucket | { array: Record<string, Bucket> }> = {
            ...CONVERT_REGISTRY,
            points: {
                array: {
                    s: { kind: "exact" },
                    g: { kind: "bounded", rel: 1e-8 },
                    ghost: { kind: "exact" },
                },
            },
        };
        const { orphan } = registryClosure(CONVERT_SAMPLE, withOrphan);
        expect(orphan).toContain("points[].ghost");
    });
});

/** perturb one top-level field of a real golden record by `factor` × its declared relative
 *  bound — additive, not multiplicative, so the delta stays well above the field's own ulp at
 *  every factor this file uses and the measured error tracks `factor * rel` cleanly. */
function perturbRel(name: string, field: string): (factor: number) => Record<string, unknown> {
    const want = GOLDEN(name) as unknown as Record<string, unknown>;
    const bucket = CONVERT_REGISTRY[field] as { kind: "bounded"; rel: number };
    const base = want[field] as number;
    return (factor: number) => ({ ...want, [field]: base + bucket.rel * factor * Math.abs(base) });
}

const G_BUCKET = (CONVERT_REGISTRY.points as { array: Record<string, Bucket> }).array.g as {
    kind: "mixed";
    atol: number;
    rel: number;
};

/** perturb `circular-arc`'s first point's `g` (≈1.9, well away from zero) by `factor` × its
 *  declared REL bound — at this magnitude `atol` is negligible next to `rel * |g|`, so this
 *  exercises the mixed form's rel-dominated limb (the same limb `perturbRel` above exercises
 *  for `floor`/`deviation`). */
function perturbPointG(name: string, factor: number): Record<string, unknown> {
    const want = GOLDEN(name) as unknown as Record<string, unknown>;
    const points = want.points as { s: number; g: number }[];
    const perturbed = points.map((p, i) =>
        i === 0 ? { ...p, g: p.g + G_BUCKET.rel * factor * Math.abs(p.g) } : p,
    );
    return { ...want, points: perturbed };
}

/** the mixed form's OTHER limb: a `g` near zero, where `rel * |want|` is negligible and `atol`
 *  alone carries the comparison — the exact shape `double-hump`/`valley-explicit`'s
 *  zero-crossing points broke the plain-relative bound on (3e). `withPointG` swaps only
 *  `circular-arc`'s first point's `g`, keeping every structural field (knots, outcome, …)
 *  untouched so only the bounded comparison is under test. */
function withPointG(g: number): Record<string, unknown> {
    const want = GOLDEN("circular-arc") as unknown as Record<string, unknown>;
    const points = (want.points as { s: number; g: number }[]).map((p, i) =>
        i === 0 ? { ...p, g } : p,
    );
    return { ...want, points };
}

describe("the bounded comparison discriminates — red at 10x, green at 0.1x", () => {
    for (const field of ["floor", "deviation"] as const) {
        test(`convert-golden.json's ${field} fails at 10x its bound`, () => {
            const perturb = perturbRel("circular-arc", field);
            const outcome = compareGolden(perturb(10), GOLDEN("circular-arc"), CONVERT_REGISTRY);
            expect(outcome.ok).toBe(false);
        });

        test(`convert-golden.json's ${field} passes at 0.1x its bound`, () => {
            const perturb = perturbRel("circular-arc", field);
            const outcome = compareGolden(perturb(0.1), GOLDEN("circular-arc"), CONVERT_REGISTRY);
            expect(outcome.ok).toBe(true);
        });
    }

    test("convert-golden.json's points[].g fails at 10x its bound", () => {
        const outcome = compareGolden(
            perturbPointG("circular-arc", 10),
            GOLDEN("circular-arc"),
            CONVERT_REGISTRY,
        );
        expect(outcome.ok).toBe(false);
    });

    test("convert-golden.json's points[].g passes at 0.1x its bound", () => {
        const outcome = compareGolden(
            perturbPointG("circular-arc", 0.1),
            GOLDEN("circular-arc"),
            CONVERT_REGISTRY,
        );
        expect(outcome.ok).toBe(true);
    });

    // the mixed form's `atol` limb — a `g` near zero, so `rel * |want|` contributes nothing and
    // `atol` alone must gate it (kex2d-golden-reproducibility 3g's re-derivation).
    test("convert-golden.json's points[].g (near zero) fails at 10x atol", () => {
        const want = withPointG(1e-12);
        const got = withPointG(1e-12 + G_BUCKET.atol * 10);
        expect(compareGolden(got, want, CONVERT_REGISTRY).ok).toBe(false);
    });

    test("convert-golden.json's points[].g (near zero) passes at 0.1x atol", () => {
        const want = withPointG(1e-12);
        const got = withPointG(1e-12 + G_BUCKET.atol * 0.1);
        expect(compareGolden(got, want, CONVERT_REGISTRY).ok).toBe(true);
    });

    // the mixed form's `rel` limb, isolated at a magnitude where `atol` is negligible by
    // construction (rel*|want| >> atol) — the same claim `perturbPointG` above makes at
    // circular-arc's own scale, restated at a scale where the dominance is unambiguous.
    test("convert-golden.json's points[].g (large) fails at 10x its rel-implied error", () => {
        const want = withPointG(1e6);
        const got = withPointG(1e6 + G_BUCKET.rel * 1e6 * 10);
        expect(compareGolden(got, want, CONVERT_REGISTRY).ok).toBe(false);
    });

    test("convert-golden.json's points[].g (large) passes at 0.1x its rel-implied error", () => {
        const want = withPointG(1e6);
        const got = withPointG(1e6 + G_BUCKET.rel * 1e6 * 0.1);
        expect(compareGolden(got, want, CONVERT_REGISTRY).ok).toBe(true);
    });

    // The two limbs must ADD, not compete. Every test above isolates one limb by making the
    // other negligible, so at those points `atol + rel*|want|` and `max(atol, rel*|want|)` are
    // numerically indistinguishable and a `+` → `Math.max` mutation survives all of them
    // (measured: the mutant passed 26/26). The discriminating point is the crossover, where the
    // two terms are exactly equal — derived, not chosen: `rel*|want| == atol` at
    // `|want| == atol/rel`. There the additive bound is `2*atol` and the max bound is `atol`, so
    // an error of 1.5x atol separates them. Both directions, so neither case is vacuous.
    const crossover = G_BUCKET.atol / G_BUCKET.rel;

    test("convert-golden.json's points[].g passes at 1.5x atol where the two limbs are equal", () => {
        const want = withPointG(crossover);
        const got = withPointG(crossover + G_BUCKET.atol * 1.5);
        expect(compareGolden(got, want, CONVERT_REGISTRY).ok).toBe(true);
    });

    test("convert-golden.json's points[].g fails at 2.5x atol where the two limbs are equal", () => {
        const want = withPointG(crossover);
        const got = withPointG(crossover + G_BUCKET.atol * 2.5);
        expect(compareGolden(got, want, CONVERT_REGISTRY).ok).toBe(false);
    });

    // `forcegeo-golden.json`'s `deviation` is bounded at 1 ULP of its own magnitude, not a
    // relative spread — a quantized, not continuous, tolerance. 10 ulps off is 10x the bound and
    // must fail; a fractional ulp is not representable in a double (it rounds back to the exact
    // value), so the 0.1x case degenerates to the zero-error identity — the strictest possible
    // instance of "well inside the bound", and it must pass.
    test("forcegeo-golden.json's deviation fails at 10 ulps", () => {
        const want = FORCEGEO_GOLDEN("circular-arc");
        const buf = new Float64Array([want.deviation]);
        new BigUint64Array(buf.buffer)[0] += 10n;
        const outcome = compareGolden({ ...want, deviation: buf[0] }, want, FORCEGEO_REGISTRY);
        expect(outcome.ok).toBe(false);
    });

    test("forcegeo-golden.json's deviation passes at 0 ulps (a fractional ulp rounds away)", () => {
        const want = FORCEGEO_GOLDEN("circular-arc");
        const outcome = compareGolden(
            { ...want, deviation: want.deviation },
            want,
            FORCEGEO_REGISTRY,
        );
        expect(outcome.ok).toBe(true);
    });
});

/** the fields `compareGolden` may have looked at before it hit `field` in registry order —
 *  every registry key up to and including `field`, since pass 1 walks structural fields in
 *  declaration order and returns the instant one fails. Used to prove the bounded fields never
 *  got read: their names must not appear among the results at all. */
const BOUNDED_FIELDS = ["floor", "deviation", "points"];

describe("a structural mismatch hard-fails ahead of any bound", () => {
    test("a changed knot set fails as structure, before any bounded field is read", () => {
        const want = GOLDEN("circular-arc");
        const got = { ...want, knots: [...want.knots, 999] };
        const outcome = compareGolden(got, want, CONVERT_REGISTRY);
        expect(outcome.ok).toBe(false);
        // the ordering claim: `compareGolden` returns the instant a structural field fails, so
        // none of the bounded fields (`floor`, `deviation`, `points[].g`) ever get compared —
        // a coincidentally-in-bound continuous field can't paper over a structural break.
        expect(outcome.results.some((r) => BOUNDED_FIELDS.some((f) => r.field.startsWith(f)))).toBe(
            false,
        );
        expect(outcome.results.at(-1)).toMatchObject({
            ok: false,
            structural: true,
            field: "knots",
        });
    });

    test("a changed outcome fails as structure even when every continuous field still matches", () => {
        const want = GOLDEN("circular-arc");
        const got = { ...want, outcome: "diverged" as const };
        const outcome = compareGolden(got, want, CONVERT_REGISTRY);
        expect(outcome.ok).toBe(false);
        expect(outcome.results.some((r) => BOUNDED_FIELDS.some((f) => r.field.startsWith(f)))).toBe(
            false,
        );
        expect(outcome.results.at(-1)).toMatchObject({
            ok: false,
            structural: true,
            field: "outcome",
        });
    });
});
