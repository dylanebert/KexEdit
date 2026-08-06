/** The one comparison seam for a cross-machine golden fixture (`kex2d-golden-reproducibility`
 *  stage 3b). Structure is exact and a hard fail; continuous fields are bounded, and the bound
 *  is only ever checked once structure has already matched — never two tolerance levels on one
 *  comparison. Each fixture declares its own `FieldRegistry` (the buckets are genuinely
 *  different per fixture); this file is generic over the registry, not a shared schema. */

export type Bucket =
    | { kind: "structural" }
    | { kind: "exact" }
    | { kind: "bounded"; rel: number }
    | { kind: "mixed"; atol: number; rel: number }
    | { kind: "ulp" };

/** a field registry for one golden fixture's per-scenario record shape. A bare `Bucket` covers
 *  a scalar (or a whole array compared as one unit, e.g. `knots`); `{ array }` covers a field
 *  that is itself an array of records, bucketed per member key (`points[].s`/`points[].g`). */
export type FieldRegistry = Record<string, Bucket | { array: Record<string, Bucket> }>;

export type FieldResult =
    | { field: string; ok: true }
    | {
          field: string;
          ok: false;
          /** true iff this field's bucket is `structural` — the mismatch that must hard-fail
           *  ahead of any bounded check, never be absorbed into a continuous tolerance. */
          structural: boolean;
          got: unknown;
          want: unknown;
          /** present only for a `bounded`/`ulp` miss — the tolerance and the measured error
           *  that exceeded it. Absent for a `structural`/`exact` mismatch, which has no bound. */
          bound?: number;
          error?: number;
      };

export type CompareOutcome = { ok: boolean; results: FieldResult[] };

/** every field on the compare a `Record<string, unknown>` can index into — the routed test
 *  results (`ConvertResult`, `GeofitResult`, …) are plain data with no index signature of their
 *  own, so callers pass them as `object` and this narrows once at the boundary. */
function fields(value: object): Record<string, unknown> {
    return value as Record<string, unknown>;
}

/** one ulp of `x`'s own magnitude — the tick spacing of the double `x` sits on. Used for
 *  forcegeo's `deviation` bound, which is tight-by-construction (a single `hypot` over a
 *  bit-identical f32 table) rather than a measured relative spread. */
export function ulpOf(x: number): number {
    if (!Number.isFinite(x)) throw new Error(`ulpOf: not finite (${x})`);
    if (x === 0) return Number.MIN_VALUE;
    const mag = Math.abs(x);
    const buf = new Float64Array([mag]);
    const bits = new BigUint64Array(buf.buffer);
    bits[0] += 1n;
    return buf[0] - mag;
}

function checkScalar(field: string, bucket: Bucket, got: unknown, want: unknown): FieldResult {
    if (bucket.kind === "structural" || bucket.kind === "exact")
        return Bun.deepEquals(got, want, true)
            ? { field, ok: true }
            : { field, ok: false, structural: bucket.kind === "structural", got, want };
    const g = got as number;
    const w = want as number;
    if (bucket.kind === "bounded") {
        const error = Math.abs(g - w) / Math.abs(w);
        return error <= bucket.rel
            ? { field, ok: true }
            : { field, ok: false, structural: false, got: g, want: w, bound: bucket.rel, error };
    }
    if (bucket.kind === "mixed") {
        // `|got - want| <= atol + rel*|want|` — the standard `isclose` shape. A plain relative
        // bound is ill-conditioned wherever `want` can approach zero (`points[].g`,
        // `kex2d-golden-reproducibility` 3g); `atol` is the measured absolute spread's own
        // bound, so it carries the comparison exactly where a relative denominator can't.
        const error = Math.abs(g - w);
        const bound = bucket.atol + bucket.rel * Math.abs(w);
        return error <= bound
            ? { field, ok: true }
            : { field, ok: false, structural: false, got: g, want: w, bound, error };
    }
    // ulp: an absolute bound on the field's own magnitude, not a relative one.
    const bound = ulpOf(w);
    const error = Math.abs(g - w);
    return error <= bound
        ? { field, ok: true }
        : { field, ok: false, structural: false, got: g, want: w, bound, error };
}

/** Compare one fixture record (`got`) against its frozen golden (`want`) through `registry`.
 *  Structural fields are checked FIRST and the function returns the instant one fails — the
 *  contract's ordering, not two independent passes. Only once every structural field matches do
 *  the exact and bounded fields get read at all. */
export function compareGolden(got: object, want: object, registry: FieldRegistry): CompareOutcome {
    const g = fields(got);
    const w = fields(want);
    const results: FieldResult[] = [];

    // pass 1 — structure, hard fail.
    for (const [field, spec] of Object.entries(registry)) {
        if ("array" in spec) continue;
        if (spec.kind !== "structural") continue;
        const result = checkScalar(field, spec, g[field], w[field]);
        results.push(result);
        if (!result.ok) return { ok: false, results };
    }
    for (const [field, spec] of Object.entries(registry)) {
        if (!("array" in spec)) continue;
        const gotArr = g[field] as unknown[] | undefined;
        const wantArr = w[field] as unknown[] | undefined;
        if (gotArr?.length !== wantArr?.length) {
            const result: FieldResult = {
                field: `${field}.length`,
                ok: false,
                structural: true,
                got: gotArr?.length,
                want: wantArr?.length,
            };
            results.push(result);
            return { ok: false, results };
        }
    }

    // pass 2 — exact + bounded scalars, only reached once structure holds.
    for (const [field, spec] of Object.entries(registry)) {
        if ("array" in spec) continue;
        if (spec.kind === "structural") continue;
        results.push(checkScalar(field, spec, g[field], w[field]));
    }

    // pass 3 — per-member array fields.
    for (const [field, spec] of Object.entries(registry)) {
        if (!("array" in spec)) continue;
        const gotArr = (g[field] as Record<string, unknown>[]) ?? [];
        const wantArr = (w[field] as Record<string, unknown>[]) ?? [];
        for (let i = 0; i < wantArr.length; i++)
            for (const [sub, subSpec] of Object.entries(spec.array))
                results.push(
                    checkScalar(
                        `${field}[${i}].${sub}`,
                        subSpec,
                        gotArr[i]?.[sub],
                        wantArr[i][sub],
                    ),
                );
    }

    return { ok: results.every((r) => r.ok), results };
}

/** `compareGolden`, thrown as one descriptive error at the first failing field — the assertion
 *  shape every routed test wants in place of a bespoke `toEqual`/per-field loop. */
export function assertGolden(got: object, want: object, registry: FieldRegistry, label = ""): void {
    const outcome = compareGolden(got, want, registry);
    if (outcome.ok) return;
    const failure = outcome.results.find((r) => !r.ok);
    throw new Error(`golden mismatch${label ? ` (${label})` : ""}: ${JSON.stringify(failure)}`);
}

/** The declared-registry law (`editor-ui.md`), applied to a flat key set rather than a
 *  `FieldRegistry` — every actual key must be declared and every declared key must be present,
 *  both directions. Used for `convert-golden.json`'s top-level platform-stamp namespace, one
 *  level above `registryClosure`'s per-scenario field check (`helpers/golden.ts`
 *  `KNOWN_STAMPS`). */
export function setClosure(
    actual: readonly string[],
    declared: readonly string[],
): { missing: string[]; orphan: string[] } {
    const a = new Set(actual);
    const d = new Set(declared);
    return {
        missing: [...a].filter((key) => !d.has(key)),
        orphan: [...d].filter((key) => !a.has(key)),
    };
}

/** The declared-registry law (`editor-ui.md`), applied to a golden's field set: every key on a
 *  real fixture record must resolve to exactly one bucket, and every declared bucket must name a
 *  real key — checked against `sample`'s OWN keys via reflection, never a re-typed list. `sample`
 *  should be one real scenario record from the fixture (or one array element for the nested
 *  check), not a hand-built stand-in. */
export function registryClosure(
    sample: object,
    registry: FieldRegistry,
): { missing: string[]; orphan: string[] } {
    const s = fields(sample);
    const declared = new Set(Object.keys(registry));
    const actual = new Set(Object.keys(s));
    const missing = [...actual].filter((key) => !declared.has(key));
    const orphan = [...declared].filter((key) => !actual.has(key));

    for (const [field, spec] of Object.entries(registry)) {
        if (!("array" in spec)) continue;
        const arr = s[field] as Record<string, unknown>[] | undefined;
        if (!arr || arr.length === 0) continue;
        const elemDeclared = new Set(Object.keys(spec.array));
        const elemActual = new Set(Object.keys(arr[0]));
        for (const key of elemActual) if (!elemDeclared.has(key)) missing.push(`${field}[].${key}`);
        for (const key of elemDeclared) if (!elemActual.has(key)) orphan.push(`${field}[].${key}`);
    }

    return { missing, orphan };
}
