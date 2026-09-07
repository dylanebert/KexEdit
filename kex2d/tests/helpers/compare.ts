/** The one comparison seam for a golden fixture (`kex2d-golden-reproducibility` stage 3b).
 *  Structure is exact and a hard fail; a bound is only ever checked once structure has already
 *  matched — never two tolerance levels on one comparison. A bucket is a claim about the
 *  COMPARISON a field runs, not about the field itself: own-stamp against a deterministic solve
 *  presents zero spread (`exact`), a fixture genuinely shared across platforms presents the
 *  measured envelope (`ulp`/a bound). Stage 4 collapsed every own-stamp bounded/mixed field to
 *  `exact` for exactly this reason — `forcegeo-golden.json`'s `deviation` is the one field left
 *  non-exact, because it is the one field actually compared cross-machine. Each fixture declares
 *  its own `FieldRegistry` (the buckets are genuinely different per fixture); this file is
 *  generic over the registry, not a shared schema. */

export type Bucket =
    | { kind: "structural" }
    | { kind: "exact" }
    | { kind: "ulp" }
    | { kind: "digest" };

/** every `Bucket` variant EXCEPT `structural` — what a member of an `{ array }`/`{ vector }`/
 *  `{ object }` field may declare. Structure is a whole-field question (an array's length, a
 *  member's presence), checked once ahead of any per-member comparison (`compareGolden`'s pass
 *  1); a MEMBER declaring its own bucket `structural` would ask the same question twice, at the
 *  wrong granularity, so it's excluded from the type rather than left to a comment
 *  (`kex2d-golden-reproducibility` 4: "a `{array}` member declared structural is a type error"). */
export type MemberBucket = Exclude<Bucket, { kind: "structural" }>;

/** a field registry for one golden fixture's per-scenario record shape. A bare `Bucket` covers
 *  a scalar (or a whole array compared as one unit, e.g. `knots`); `{ array }` covers a field
 *  that is itself an array of records, bucketed per member key (`points[].s`/`points[].g`) — a
 *  member's own spec may itself be `{ object }` for a nested optional sub-record
 *  (`points[].in`/`.out`, `kex2d-golden-reproducibility` 3c); `{ vector }` covers a field that is
 *  an array of plain SCALARS, every element sharing one bucket (`polish.oracle.ts`'s
 *  `deviations` — the sha256 it replaces covered this element-wise and the replacement must
 *  too); `{ object }` covers a field that is itself a single nested record with per-key buckets,
 *  never an array (`polish.oracle.ts`'s `exit: {dx,dy,dtheta,dist}`, whose four members compare
 *  independently and so can't ride the whole-object `exact` bucket the way `spine` does). */
export type FieldRegistry = Record<
    string,
    | Bucket
    | { array: Record<string, MemberBucket | { object: Record<string, MemberBucket> }> }
    | { vector: MemberBucket }
    | { object: Record<string, MemberBucket> }
>;

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
          /** present only for a `ulp` miss — the tolerance and the measured error that exceeded
           *  it. Absent for a `structural`/`exact`/`digest` mismatch, which has no bound. */
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

/** hashes `value`'s canonical JSON to a sha256 hex digest — UNLESS `value` already IS a string,
 *  in which case it's treated as an already-computed digest and returned verbatim. That
 *  asymmetry is what lets a `digest` bucket compare a live record's raw field (hashed here) to a
 *  committed golden's field (pre-hashed at mint time, so the FIXTURE never carries the raw data
 *  — `kex2d-golden-reproducibility` 3c, the `snapshots` field that was 99% of a 17.7 MB fixture).
 *  Exported so `mint-goldens.ts` hashes with the exact function a live comparison will use. */
export function digestOf(value: unknown): string {
    if (typeof value === "string") return value;
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(JSON.stringify(value));
    return hasher.digest("hex");
}

function checkScalar(field: string, bucket: Bucket, got: unknown, want: unknown): FieldResult {
    if (bucket.kind === "structural" || bucket.kind === "exact")
        return Bun.deepEquals(got, want, true)
            ? { field, ok: true }
            : { field, ok: false, structural: bucket.kind === "structural", got, want };
    if (bucket.kind === "digest") {
        const gotHash = digestOf(got);
        const wantHash = digestOf(want);
        return gotHash === wantHash
            ? { field, ok: true }
            : { field, ok: false, structural: false, got: gotHash, want: wantHash };
    }
    const g = got as number;
    const w = want as number;
    // ulp: an absolute bound on the field's own magnitude, not a relative one. The only
    // remaining non-exact numeric bucket — `forcegeo-golden.json`'s `deviation`, the one field
    // this unit's close left bounded (`kex2d-golden-reproducibility` 4: a shared fixture
    // presents a real cross-machine spread; every own-stamp field above collapsed to `exact`).
    const bound = ulpOf(w);
    const error = Math.abs(g - w);
    return error <= bound
        ? { field, ok: true }
        : { field, ok: false, structural: false, got: g, want: w, bound, error };
}

/** one array member's check, dispatched on whether its own spec is a plain `Bucket` or a nested
 *  `{ object }` (`points[].in`/`.out`: OPTIONAL nested records — absent for a chain endpoint).
 *  PRESENCE is a structural question, checked earlier in `compareGolden`'s structural pass (ahead
 *  of any bounded field) — so by the time this runs, `got`/`want` are guaranteed to agree on
 *  presence: both absent (the endpoint case, nothing to compare) or both present (the interior
 *  case, compared per sub-key). This function never itself decides a presence mismatch. */
function checkMember(
    field: string,
    spec: MemberBucket | { object: Record<string, MemberBucket> },
    got: unknown,
    want: unknown,
): FieldResult[] {
    if (!("object" in spec)) return [checkScalar(field, spec, got, want)];
    if (got === undefined && want === undefined) return [{ field, ok: true }];
    const g = got as Record<string, unknown>;
    const w = want as Record<string, unknown>;
    return Object.entries(spec.object).map(([sub, subSpec]) =>
        checkScalar(`${field}.${sub}`, subSpec, g[sub], w[sub]),
    );
}

/** Compare one fixture record (`got`) against its frozen golden (`want`) through `registry`.
 *  Structural fields are checked FIRST and the function returns the instant one fails — the
 *  contract's ordering, not two independent passes. Only once every structural field matches do
 *  the exact/`ulp`/`digest` fields get read at all. */
export function compareGolden(got: object, want: object, registry: FieldRegistry): CompareOutcome {
    const g = fields(got);
    const w = fields(want);
    const results: FieldResult[] = [];

    // pass 1 — structure, hard fail.
    for (const [field, spec] of Object.entries(registry)) {
        if ("array" in spec || "vector" in spec || "object" in spec) continue;
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
    // a `vector` field's length mismatch is structural too, ahead of any bound, same reasoning
    // as an `array` field's — a shorter/longer profile is a different answer, not a drifted one.
    for (const [field, spec] of Object.entries(registry)) {
        if (!("vector" in spec)) continue;
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
    // an array member's PRESENCE, where its own spec is `{ object }` (`points[].in`/`.out`:
    // optional per element — absent at exactly one end of the chain), is structural too, ahead of
    // any bound — a different DOF shape, not a drifted value. Checked here, in the structural
    // pass, not inside `checkMember` in pass 3: that ordering bug let a presence mismatch's
    // verdict come back correct (`ok: false`) while `feasibility`/`peakG`/`maxDg`/`deviation`/
    // `exit.*` were already computed first, contradicting this function's own "returns the
    // instant one fails" contract and the spec's "a structural mismatch hard-fails ahead of any
    // bound" — caught on architectural review of `kex2d-golden-reproducibility` 3c.
    for (const [field, spec] of Object.entries(registry)) {
        if (!("array" in spec)) continue;
        const gotArr = (g[field] as Record<string, unknown>[]) ?? [];
        const wantArr = (w[field] as Record<string, unknown>[]) ?? [];
        for (const [sub, subSpec] of Object.entries(spec.array)) {
            if (!("object" in subSpec)) continue;
            for (let i = 0; i < wantArr.length; i++) {
                const gv = gotArr[i]?.[sub];
                const wv = wantArr[i]?.[sub];
                if ((gv === undefined) === (wv === undefined)) continue;
                const result: FieldResult = {
                    field: `${field}[${i}].${sub}`,
                    ok: false,
                    structural: true,
                    got: gv,
                    want: wv,
                };
                results.push(result);
                return { ok: false, results };
            }
        }
    }

    // pass 2 — exact/ulp/digest scalars, only reached once structure holds.
    for (const [field, spec] of Object.entries(registry)) {
        if ("array" in spec || "vector" in spec || "object" in spec) continue;
        if (spec.kind === "structural") continue;
        results.push(checkScalar(field, spec, g[field], w[field]));
    }

    // pass 2b — single nested-object fields, per member key (never an array: `exit`, not
    // `points[]`). A registry never declares a sub-bucket `structural` here — every object field
    // is reached only after every top-level structural field above already matched.
    for (const [field, spec] of Object.entries(registry)) {
        if (!("object" in spec)) continue;
        const gotObj = (g[field] as Record<string, unknown>) ?? {};
        const wantObj = (w[field] as Record<string, unknown>) ?? {};
        for (const [sub, subSpec] of Object.entries(spec.object))
            results.push(checkScalar(`${field}.${sub}`, subSpec, gotObj[sub], wantObj[sub]));
    }

    // pass 3 — per-member array fields.
    for (const [field, spec] of Object.entries(registry)) {
        if (!("array" in spec)) continue;
        const gotArr = (g[field] as Record<string, unknown>[]) ?? [];
        const wantArr = (w[field] as Record<string, unknown>[]) ?? [];
        for (let i = 0; i < wantArr.length; i++)
            for (const [sub, subSpec] of Object.entries(spec.array))
                results.push(
                    ...checkMember(
                        `${field}[${i}].${sub}`,
                        subSpec,
                        gotArr[i]?.[sub],
                        wantArr[i][sub],
                    ),
                );
    }

    // pass 3b — vector fields, per element, one shared bucket.
    for (const [field, spec] of Object.entries(registry)) {
        if (!("vector" in spec)) continue;
        const gotArr = (g[field] as unknown[]) ?? [];
        const wantArr = (w[field] as unknown[]) ?? [];
        for (let i = 0; i < wantArr.length; i++)
            results.push(checkScalar(`${field}[${i}]`, spec.vector, gotArr[i], wantArr[i]));
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
        if ("object" in spec) {
            const obj = s[field] as Record<string, unknown> | undefined;
            if (!obj) continue;
            const elemDeclared = new Set(Object.keys(spec.object));
            const elemActual = new Set(Object.keys(obj));
            for (const key of elemActual)
                if (!elemDeclared.has(key)) missing.push(`${field}.${key}`);
            for (const key of elemDeclared)
                if (!elemActual.has(key)) orphan.push(`${field}.${key}`);
            continue;
        }
        if (!("array" in spec)) continue;
        const arr = s[field] as Record<string, unknown>[] | undefined;
        if (!arr || arr.length === 0) continue;
        const elemDeclared = new Set(Object.keys(spec.array));
        // the UNION of keys across every element, not just `arr[0]` — a member key may be
        // OPTIONAL per element (`points[].in`/`.out`, absent at a chain endpoint), so a single
        // element's own keys under-report what the array actually carries.
        const elemActual = new Set(arr.flatMap((el) => Object.keys(el)));
        for (const key of elemActual) if (!elemDeclared.has(key)) missing.push(`${field}[].${key}`);
        for (const key of elemDeclared) if (!elemActual.has(key)) orphan.push(`${field}[].${key}`);
        // a member that is itself `{ object }` (`points[].in`/`.out`) is OPTIONAL per element —
        // close it against whichever element actually carries a value, not just `arr[0]` (the
        // first/last point in the free-family corpus always lacks one side).
        for (const [sub, subSpec] of Object.entries(spec.array)) {
            if (!("object" in subSpec)) continue;
            const sample = arr.find((el) => el[sub] !== undefined)?.[sub] as
                | Record<string, unknown>
                | undefined;
            if (!sample) continue;
            const subDeclared = new Set(Object.keys(subSpec.object));
            const subActual = new Set(Object.keys(sample));
            for (const key of subActual)
                if (!subDeclared.has(key)) missing.push(`${field}[].${sub}.${key}`);
            for (const key of subDeclared)
                if (!subActual.has(key)) orphan.push(`${field}[].${sub}.${key}`);
        }
    }

    return { missing, orphan };
}
