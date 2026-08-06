// The comparison seam's own tests (`kex2d-golden-reproducibility` stage 3b), not the physics'.
// Three claims, each per the spec's Validation section: the field registry is closed both
// directions against the REAL fixtures (never a hand-typed key list), the bounded comparison
// actually discriminates (red at 10x its bound, green at 0.1x), and a structural mismatch hard
// fails before any bounded field is even read.
import { describe, expect, test } from "bun:test";
import type { Bucket } from "./helpers/compare";
import { compareGolden, registryClosure } from "./helpers/compare";
import convertGolden from "./fixtures/convert-golden.json";
import forcegeoGolden from "./fixtures/forcegeo-golden.json";
import { CONVERT_REGISTRY, FORCEGEO_GOLDEN, FORCEGEO_REGISTRY, GOLDEN } from "./helpers/golden";

const CONVERT_SAMPLE = convertGolden["circular-arc"];
const FORCEGEO_SAMPLE = forcegeoGolden["circular-arc"];

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

function perturbPointG(name: string, factor: number): Record<string, unknown> {
    const want = GOLDEN(name) as unknown as Record<string, unknown>;
    const points = want.points as { s: number; g: number }[];
    const bucket = (CONVERT_REGISTRY.points as { array: Record<string, Bucket> }).array.g as {
        kind: "bounded";
        rel: number;
    };
    const perturbed = points.map((p, i) =>
        i === 0 ? { ...p, g: p.g + bucket.rel * factor * Math.abs(p.g) } : p,
    );
    return { ...want, points: perturbed };
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
