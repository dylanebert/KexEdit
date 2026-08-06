// The comparison seam's own tests (`kex2d-golden-reproducibility` stage 3b), not the physics'.
// Three claims, each per the spec's Validation section: the field registry is closed both
// directions against the REAL fixtures (never a hand-typed key list), the bounded comparison
// actually discriminates (red at 10x its bound, green at 0.1x), and a structural mismatch hard
// fails before any bounded field is even read.
import { describe, expect, test } from "bun:test";
import type { Bucket, FieldRegistry } from "./helpers/compare";
import { compareGolden, digestOf, registryClosure, setClosure } from "./helpers/compare";
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
    POLISH_GOLDEN,
    POLISH_REGISTRY,
} from "./helpers/golden";

const CONVERT_SAMPLE = convertGolden[FORCEGEO_SOURCE_STAMP]["circular-arc"];
const FORCEGEO_SAMPLE = forcegeoGolden["circular-arc"];
const POLISH_SAMPLE = POLISH_GOLDEN("circular-arc") as unknown as Record<string, unknown>;

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

    // `POLISH_REGISTRY` is the first consumer of the `{ vector }` / `{ object }` bucket kinds
    // (`kex2d-golden-reproducibility` 3c) — closed against a REAL `PolishRecord`, same law.
    test("polish-golden.json's registry is closed both directions", () => {
        expect(registryClosure(POLISH_SAMPLE, POLISH_REGISTRY)).toEqual({
            missing: [],
            orphan: [],
        });
    });

    test("an undeclared polish record key fails closure", () => {
        const withExtra = { ...POLISH_SAMPLE, ghost: 0 };
        const { missing } = registryClosure(withExtra, POLISH_REGISTRY);
        expect(missing).toContain("ghost");
    });

    test("an orphan polish registry declaration fails closure", () => {
        const withOrphan: FieldRegistry = { ...POLISH_REGISTRY, ghost: { kind: "exact" } };
        const { orphan } = registryClosure(POLISH_SAMPLE, withOrphan);
        expect(orphan).toContain("ghost");
    });

    // and the same two controls read on `exit`'s nested `{ object }` member keys, the new
    // bucket kind's own closure path (`compare.ts`'s `registryClosure` object branch).
    test("an undeclared exit member key fails closure", () => {
        const withExtra = {
            ...POLISH_SAMPLE,
            exit: { ...(POLISH_SAMPLE.exit as object), extra: 0 },
        };
        const { missing } = registryClosure(withExtra, POLISH_REGISTRY);
        expect(missing).toContain("exit.extra");
    });

    test("an orphan exit member declaration fails closure", () => {
        const withOrphan: FieldRegistry = {
            ...POLISH_REGISTRY,
            exit: {
                object: {
                    dx: { kind: "mixed", atol: 1e-12, rel: 1e-6 },
                    dy: { kind: "mixed", atol: 1e-12, rel: 1e-6 },
                    dtheta: { kind: "mixed", atol: 1e-14, rel: 0 },
                    dist: { kind: "mixed", atol: 1e-12, rel: 1e-6 },
                    ghost: { kind: "exact" },
                },
            },
        };
        const { orphan } = registryClosure(POLISH_SAMPLE, withOrphan);
        expect(orphan).toContain("exit.ghost");
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

    // `POLISH_REGISTRY`'s own plain-`bounded` fields — each a DIFFERENT declared rel, so each
    // must be shown to discriminate on its own number, not just inherit the mechanism proof
    // `points[].g` already gave the shared `checkScalar` code path.
    for (const field of ["feasibility", "peakG", "maxDg"] as const) {
        test(`polish-golden.json's ${field} fails at 10x its bound`, () => {
            const want = POLISH_SAMPLE;
            const bucket = (POLISH_REGISTRY as Record<string, { kind: "bounded"; rel: number }>)[
                field
            ];
            const base = want[field] as number;
            const got = { ...want, [field]: base + bucket.rel * 10 * Math.abs(base) };
            expect(compareGolden(got, want, POLISH_REGISTRY).ok).toBe(false);
        });

        test(`polish-golden.json's ${field} passes at 0.1x its bound`, () => {
            const want = POLISH_SAMPLE;
            const bucket = (POLISH_REGISTRY as Record<string, { kind: "bounded"; rel: number }>)[
                field
            ];
            const base = want[field] as number;
            const got = { ...want, [field]: base + bucket.rel * 0.1 * Math.abs(base) };
            expect(compareGolden(got, want, POLISH_REGISTRY).ok).toBe(true);
        });
    }

    // the new `{ vector }` bucket kind, mechanism + POLISH_REGISTRY's own `deviations` bound.
    // Perturbed at an interior index away from 0 (index 0 is the pinned entry, always exactly 0
    // — perturbing it would trip the `atol` limb instead of the `rel` limb this pair isolates).
    const DeviationsBucket = (
        POLISH_REGISTRY.deviations as { vector: { kind: "mixed"; atol: number; rel: number } }
    ).vector;

    // circular-arc's own `deviations[]` entries (~1e-4 corpus-wide, per the full-free family's
    // own scale) sit BELOW the atol/rel crossover (`atol/rel` = 1), where `atol` dominates — so
    // isolating the rel limb needs a synthetic magnitude above it, the same move the `exit.*`
    // tests below make.
    const DeviationsRelBase = 10 * (DeviationsBucket.atol / DeviationsBucket.rel);

    test("polish-golden.json's deviations[] fails at 10x its rel-implied error", () => {
        const deviations = POLISH_SAMPLE.deviations as number[];
        const want = {
            ...POLISH_SAMPLE,
            deviations: deviations.map((v, k) => (k === 1 ? DeviationsRelBase : v)),
        };
        const got = {
            ...want,
            deviations: (want.deviations as number[]).map((v, k) =>
                k === 1 ? v + DeviationsBucket.rel * 10 * v : v,
            ),
        };
        expect(compareGolden(got, want, POLISH_REGISTRY).ok).toBe(false);
    });

    test("polish-golden.json's deviations[] passes at 0.1x its rel-implied error", () => {
        const deviations = POLISH_SAMPLE.deviations as number[];
        const want = {
            ...POLISH_SAMPLE,
            deviations: deviations.map((v, k) => (k === 1 ? DeviationsRelBase : v)),
        };
        const got = {
            ...want,
            deviations: (want.deviations as number[]).map((v, k) =>
                k === 1 ? v + DeviationsBucket.rel * 0.1 * v : v,
            ),
        };
        expect(compareGolden(got, want, POLISH_REGISTRY).ok).toBe(true);
    });

    // and the `atol` limb, isolated at a near-zero entry the way `withPointG` does for
    // `points[].g` — index 0 is always exactly 0 (the pinned entry), so it's the corpus's own
    // near-zero row rather than a synthetic one.
    test("polish-golden.json's deviations[] (near zero) fails at 10x atol", () => {
        const want = POLISH_SAMPLE;
        const got = {
            ...want,
            deviations: (want.deviations as number[]).map((v, k) =>
                k === 0 ? v + DeviationsBucket.atol * 10 : v,
            ),
        };
        expect(compareGolden(got, want, POLISH_REGISTRY).ok).toBe(false);
    });

    test("polish-golden.json's deviations[] (near zero) passes at 0.1x atol", () => {
        const want = POLISH_SAMPLE;
        const got = {
            ...want,
            deviations: (want.deviations as number[]).map((v, k) =>
                k === 0 ? v + DeviationsBucket.atol * 0.1 : v,
            ),
        };
        expect(compareGolden(got, want, POLISH_REGISTRY).ok).toBe(true);
    });

    test("polish-golden.json's deviations[] length mismatch fails as structure, ahead of any bound", () => {
        const want = POLISH_SAMPLE;
        const got = { ...want, deviations: [...(want.deviations as number[]), 0] };
        const outcome = compareGolden(got, want, POLISH_REGISTRY);
        expect(outcome.ok).toBe(false);
        expect(outcome.results.at(-1)).toMatchObject({
            ok: false,
            structural: true,
            field: "deviations.length",
        });
    });

    // the new `{ object }` bucket kind, mechanism + POLISH_REGISTRY's `exit` members. `dx`/`dy`/
    // `dist` share one atol+rel pair; `dtheta` is the pure-absolute instance (`rel: 0`).
    for (const field of ["dx", "dy", "dist"] as const) {
        const bucket = (
            POLISH_REGISTRY.exit as {
                object: Record<string, { kind: "mixed"; atol: number; rel: number }>;
            }
        ).object[field];

        // circular-arc's own exit.* values sit orders of magnitude below the atol/rel crossover
        // (~1e-6), where atol would dominate — isolate the rel limb the way `perturbPointG` does
        // for `points[].g`: build a synthetic want/got PAIR at a magnitude well above the
        // crossover, so `atol` is negligible next to `rel * |want|` on both sides.
        const base = 10 * (bucket.atol / bucket.rel);

        test(`polish-golden.json's exit.${field} fails at 10x its rel-implied error`, () => {
            const want = {
                ...POLISH_SAMPLE,
                exit: { ...(POLISH_SAMPLE.exit as object), [field]: base },
            };
            const got = {
                ...want,
                exit: { ...(want.exit as object), [field]: base + bucket.rel * 10 * base },
            };
            expect(compareGolden(got, want, POLISH_REGISTRY).ok).toBe(false);
        });

        test(`polish-golden.json's exit.${field} passes at 0.1x its rel-implied error`, () => {
            const want = {
                ...POLISH_SAMPLE,
                exit: { ...(POLISH_SAMPLE.exit as object), [field]: base },
            };
            const got = {
                ...want,
                exit: { ...(want.exit as object), [field]: base + bucket.rel * 0.1 * base },
            };
            expect(compareGolden(got, want, POLISH_REGISTRY).ok).toBe(true);
        });
    }

    // `exit.dtheta`'s `rel: 0` — a pure-absolute bound, atol alone must carry the whole
    // comparison the way `forcegeo-golden.json`'s `ulp` bucket does.
    test("polish-golden.json's exit.dtheta fails at 10x its atol (rel: 0, pure absolute)", () => {
        const want = POLISH_SAMPLE;
        const exit = want.exit as Record<string, number>;
        const got = { ...want, exit: { ...exit, dtheta: exit.dtheta + 1e-14 * 10 } };
        expect(compareGolden(got, want, POLISH_REGISTRY).ok).toBe(false);
    });

    test("polish-golden.json's exit.dtheta passes at 0.1x its atol (rel: 0, pure absolute)", () => {
        const want = POLISH_SAMPLE;
        const exit = want.exit as Record<string, number>;
        const got = { ...want, exit: { ...exit, dtheta: exit.dtheta + 1e-14 * 0.1 } };
        expect(compareGolden(got, want, POLISH_REGISTRY).ok).toBe(true);
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

    test("polish-golden.json: a flipped converged fails as structure, before any bounded field is read", () => {
        const want = POLISH_SAMPLE;
        const got = { ...want, converged: !want.converged };
        const outcome = compareGolden(got, want, POLISH_REGISTRY);
        expect(outcome.ok).toBe(false);
        expect(
            outcome.results.some((r) =>
                ["feasibility", "peakG", "maxDg", "deviation", "deviations", "exit", "points"].some(
                    (f) => r.field.startsWith(f),
                ),
            ),
        ).toBe(false);
        expect(outcome.results.at(-1)).toMatchObject({
            ok: false,
            structural: true,
            field: "converged",
        });
    });
});

// `polish-golden.json`'s two `digest` fields — the fix for the 17.7 MB fixture
// (`kex2d-golden-reproducibility` 3c review): `spine`/`snapshots` compare as a sha256 of their
// canonical JSON rather than the raw subtree, and a live "got" side hashes on the fly against the
// fixture's already-hashed "want" (`digestOf`'s string-passthrough).
describe("the digest bucket — a mutation anywhere in the subtree must be caught", () => {
    test("digestOf hashes raw data and passes a string through verbatim", () => {
        const raw = { a: 1, b: [1, 2, 3] };
        const digest = digestOf(raw);
        expect(digest).toHaveLength(64);
        expect(digestOf(digest)).toBe(digest);
        expect(digestOf({ a: 1, b: [1, 2, 4] })).not.toBe(digest);
    });

    test("polish-golden.json's snapshots passes when the live raw trajectory hashes to the stored digest", () => {
        // POLISH_SAMPLE's own `snapshots` is already the persisted digest string (what
        // `POLISH_GOLDEN` returns); a "got" side presenting the DIGEST ITSELF (as a live
        // comparison never would, but `checkScalar`'s digest branch must handle either shape)
        // passes via `digestOf`'s passthrough.
        const outcome = compareGolden(POLISH_SAMPLE, POLISH_SAMPLE, POLISH_REGISTRY);
        expect(outcome.ok).toBe(true);
    });

    test("polish-golden.json's snapshots fails when the live raw trajectory does NOT hash to the stored digest", () => {
        // the shape a real regression takes: `got.snapshots` is the RAW trajectory (a live
        // solve), `want.snapshots` is the fixture's pre-hashed digest — a one-value mutation deep
        // in the raw subtree must still be caught.
        const rawSnapshots = [
            {
                step: 0,
                outer: 0,
                points: [{ s: 0, g: 1 }],
                fN: [0.5, 0.6],
                feasibility: 1e-7,
                deviation: 1e-4,
                phi: 0,
                mu: 0,
                rho: 1,
            },
        ];
        const want = { ...POLISH_SAMPLE }; // snapshots already the persisted digest string
        const gotUnmutated = { ...want, snapshots: rawSnapshots };
        // first prove the control: a want built from the SAME raw data's own digest passes.
        const wantFromSameRaw = { ...want, snapshots: digestOf(rawSnapshots) };
        expect(compareGolden(gotUnmutated, wantFromSameRaw, POLISH_REGISTRY).ok).toBe(true);
        // then mutate one deep value (fN[1]) and confirm the comparison catches it.
        const mutatedRaw = [{ ...rawSnapshots[0], fN: [0.5, 0.6000001] }];
        const gotMutated = { ...want, snapshots: mutatedRaw };
        const outcome = compareGolden(gotMutated, wantFromSameRaw, POLISH_REGISTRY);
        expect(outcome.ok).toBe(false);
        expect(outcome.results.find((r) => r.field === "snapshots")).toMatchObject({
            ok: false,
            structural: false,
        });
    });

    test("polish-golden.json's spine fails when the live raw spine does NOT hash to the stored digest", () => {
        const rawSpine = {
            edges: 2,
            ds: 1,
            length: 2,
            x: [0, 1, 2],
            y: [0, 0, 0],
            theta: [0, 0, 0],
        };
        const want = { ...POLISH_SAMPLE, spine: digestOf(rawSpine) };
        const gotUnmutated = { ...want, spine: rawSpine };
        expect(compareGolden(gotUnmutated, want, POLISH_REGISTRY).ok).toBe(true);
        const gotMutated = { ...want, spine: { ...rawSpine, y: [0, 1e-9, 0] } };
        expect(compareGolden(gotMutated, want, POLISH_REGISTRY).ok).toBe(false);
    });
});

// `points[].in`/`.out` — pinned as the free family's own solved DOF (`readDof`/`applyDof`,
// `polish.ts:251-252`), corrected from 3c's first pass which dropped them as "solver-internal
// bookkeeping" and inherited `points[].g`'s bound by assertion for the parts it did keep.
describe("points[].in / points[].out — optional nested object member", () => {
    test("absent on both sides passes (a chain endpoint has no in/out on that side)", () => {
        const points = POLISH_SAMPLE.points as Record<string, unknown>[];
        const firstHasNoIn = points[0].in === undefined;
        expect(firstHasNoIn).toBe(true);
        const outcome = compareGolden(POLISH_SAMPLE, POLISH_SAMPLE, POLISH_REGISTRY);
        expect(outcome.ok).toBe(true);
    });

    test("present on one side only fails as STRUCTURAL, not silently ignored", () => {
        const points = POLISH_SAMPLE.points as Record<string, unknown>[];
        const want = POLISH_SAMPLE;
        const got = {
            ...want,
            points: points.map((p, i) => (i === 0 ? { ...p, in: { ds: 1, dg: 1 } } : p)),
        };
        const outcome = compareGolden(got, want, POLISH_REGISTRY);
        expect(outcome.ok).toBe(false);
        const failure = outcome.results.find((r) => r.field === "points[0].in");
        expect(failure).toMatchObject({ ok: false, structural: true });
    });

    // the ordering claim, same shape as `converged`/`outcome`'s below: a presence mismatch must
    // hard-fail AHEAD of any bounded field (`compare.ts`'s own header: "returns the instant one
    // fails… never two independent passes"). `points[0]` is the first bounded field
    // `Object.entries` would reach if the presence check ran in pass 3 (after feasibility/peakG/
    // maxDg/deviation/exit are already computed) instead of the structural pass.
    test("a points[].in presence mismatch hard-fails ahead of any bounded field", () => {
        const points = POLISH_SAMPLE.points as Record<string, unknown>[];
        const want = POLISH_SAMPLE;
        const got = {
            ...want,
            points: points.map((p, i) => (i === 0 ? { ...p, in: { ds: 1, dg: 1 } } : p)),
        };
        const outcome = compareGolden(got, want, POLISH_REGISTRY);
        expect(outcome.ok).toBe(false);
        expect(
            outcome.results.some((r) =>
                ["feasibility", "peakG", "maxDg", "deviation", "deviations", "exit"].some((f) =>
                    r.field.startsWith(f),
                ),
            ),
        ).toBe(false);
        expect(outcome.results.at(-1)).toMatchObject({
            ok: false,
            structural: true,
            field: "points[0].in",
        });
    });

    // `.dg` is EXACT, not the `mixed` bound 3c first shipped — corrected on architectural review:
    // `POLISH_GOLDEN` compares own-stamp only and the solve is deterministic (measured: 3 runs
    // byte-identical, a live run matches the committed golden on every field including every
    // `.dg`), so a cross-machine noise-model bound was deciding a same-machine question the
    // Residue already names unsafe. Provisional pending 3f (see `POLISH_REGISTRY`'s own doc).
    test("points[].in.dg passes when unchanged (the own-stamp, deterministic case)", () => {
        const outcome = compareGolden(POLISH_SAMPLE, POLISH_SAMPLE, POLISH_REGISTRY);
        expect(outcome.ok).toBe(true);
    });

    test("points[].in.dg fails on ANY drift (exact — the bound the old `rel: 1e-1` let through)", () => {
        const points = POLISH_SAMPLE.points as { in?: { ds: number; dg: number } }[];
        const i = points.findIndex((p) => p.in);
        const want = POLISH_SAMPLE;
        // the smallest representable drift — a single ulp — not a scaled fraction of some bound:
        // exact has no bound to scale against.
        const got = {
            ...want,
            points: points.map((p, k) =>
                k === i && p.in ? { ...p, in: { ...p.in, dg: p.in.dg + 1e-15 } } : p,
            ),
        };
        expect(compareGolden(got, want, POLISH_REGISTRY).ok).toBe(false);
    });

    // the reviewer's own regression: a uniform 5% error on every interior handle's `dg`, all 10
    // scenarios — the mutation `rel: 1e-1` let straight through (`polish.oracle.ts` stayed 2/0; it
    // took ×1.5 to fail). `exact` must catch it on ONE point without needing the full corpus.
    test("a uniform 5% dg drift (the reviewer's src/polish.ts mutation, modeled here) fails", () => {
        const points = POLISH_SAMPLE.points as { in?: { ds: number; dg: number } }[];
        const want = POLISH_SAMPLE;
        const got = {
            ...want,
            points: points.map((p) => (p.in ? { ...p, in: { ...p.in, dg: p.in.dg * 1.05 } } : p)),
        };
        expect(compareGolden(got, want, POLISH_REGISTRY).ok).toBe(false);
    });

    test("points[].in.ds fails at any nonzero drift (exact, the f32-barrier bucket)", () => {
        const points = POLISH_SAMPLE.points as { in?: { ds: number; dg: number } }[];
        const i = points.findIndex((p) => p.in);
        const want = POLISH_SAMPLE;
        const got = {
            ...want,
            points: points.map((p, k) =>
                k === i && p.in ? { ...p, in: { ...p.in, ds: p.in.ds + 1e-9 } } : p,
            ),
        };
        expect(compareGolden(got, want, POLISH_REGISTRY).ok).toBe(false);
    });
});
