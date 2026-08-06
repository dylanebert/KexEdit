import type { GeofitOutcome } from "../../src/geofit";
import type { PolishResult } from "../../src/polish";
import type { RefineOutcome } from "../../src/refine";
import { scenarios } from "../../src/scenarios";
import { evalGeo } from "../../src/section";
import convertGolden from "../fixtures/convert-golden.json";
import forcegeoGolden from "../fixtures/forcegeo-golden.json";
import polishGolden from "../fixtures/polish-golden.json";
import type { FieldRegistry } from "./compare";

/** a corpus scenario's bake input by name — the same call `BakeSystem` makes. */
export function bakeOf(name: string) {
    const scenario = scenarios.find((candidate) => candidate.name === name);
    if (!scenario) throw new Error(`missing scenario ${name}`);
    const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };
    return { scenario, entry, bake: evalGeo(entry, scenario.nodes, scenario.ds) };
}

/** this process's platform stamp — `${platform} ${arch}`, the same string
 *  `convert-golden.json`'s top-level namespace keys a refine golden under
 *  (`kex2d-golden-reproducibility` 3e/3g: the refine solve holds a different fixed point per
 *  platform, so structure is a same-machine, stamp-matched question — never a cross-machine
 *  one). */
export const PLATFORM_STAMP = `${process.platform} ${process.arch}`;

/** the declared registry of platform stamps `convert-golden.json`'s top-level namespace may
 *  carry — the two devices this unit's Approach names (Mac, where the drift was found; WSL,
 *  where the goldens were originally frozen, confirmed). One level above the per-scenario
 *  `FieldRegistry` below: `registryClosure` closes a scenario record's own fields; this closes
 *  which platforms may own a record at all (`compare.test.ts`). */
export const KNOWN_STAMPS = ["darwin arm64", "linux x64"] as const;

/** the stamp every forcegeo/geofit fixture consumer builds its INPUT bake from, regardless of
 *  which platform is running — never the running platform's own stamp. Geofit's own kernel
 *  reproduces cross-machine bit-identically on a FIXED input (the f32 quantization barrier,
 *  `kex2d-map.md`'s `geofit.ts` entry), but refine's knot placement does not (3e's full-corpus
 *  inventory), so feeding geofit each platform's own freshly-solved `convert-golden.json` entry
 *  would make `forcegeo-golden.json` platform-sensitive too — contradicting its measured 10/10
 *  cross-machine cleanliness, which is exactly why it stays a single, unstamped golden. Fixed at
 *  the platform the goldens were originally frozen on. */
export const FORCEGEO_SOURCE_STAMP: (typeof KNOWN_STAMPS)[number] = "linux x64";

const MINT_COMMAND = "bun run tests/mint-goldens.ts";

/** `ConvertResult`'s frozen-fixture shape, as `narrow` produces it (`refine.ts`) — kept
 *  explicit rather than a `Record<string, unknown>` index type, so `convertAt`'s spread return
 *  preserves concrete field names for every caller instead of erasing them to `unknown`. */
interface RawConvertRecord {
    knots: number[];
    outcome: string;
    floor: number;
    probes: number;
    keys: number;
    edges: number;
    length: number;
    ds: number;
    deviation: number;
    points: { s: number; g: number }[];
}

type ConvertGoldenFile = Record<string, Record<string, RawConvertRecord> | undefined>;

/** `convert-golden.json[stamp][name]`, hard-failing and naming the mint command when `stamp`
 *  has no entry at all — never silently skipping a gate a missing golden can't run
 *  (`kex2d-golden-reproducibility` 3g). */
function convertAt(stamp: string, name: string) {
    const platforms = convertGolden as unknown as ConvertGoldenFile;
    const record = platforms[stamp];
    if (!record)
        throw new Error(
            `convert-golden.json has no entry for platform "${stamp}" — mint one with \`${MINT_COMMAND}\`.`,
        );
    const want = record[name];
    if (!want) throw new Error(`convert-golden.json["${stamp}"] is missing scenario "${name}"`);
    return { ...want, outcome: want.outcome as RefineOutcome };
}

/** the frozen conversion answer for a scenario, on THIS platform's own stamp. Hard-fails naming
 *  the mint command when this platform never minted one, rather than skipping. */
export const GOLDEN = (name: string) => convertAt(PLATFORM_STAMP, name);

/** the frozen conversion answer any forcegeo/geofit fixture consumer builds its force-bake
 *  INPUT from — always `FORCEGEO_SOURCE_STAMP`, never the running platform's own (see above). */
export const FORCEGEO_SOURCE = (name: string) => convertAt(FORCEGEO_SOURCE_STAMP, name);

/** The corpus-wide count of scenarios whose NOMINAL replay (unconformed `ds`) misses the floor
 *  `refine.oracle.ts` holds the realized replay to — a discrete, structural fact about the fresh
 *  solve on the running platform (`refine.ts`'s knot placement diverges cross-machine, 3e), not a
 *  continuous quantity a tolerance can absorb. `linux x64`'s `loop-explicit` miss was hardcoded
 *  directly in `refine.oracle.ts` pre-3g — a stamp-matched structural claim living outside the
 *  fixture/registry discipline the rest of this unit applies. Declared per-stamp here instead,
 *  same discipline as `convert-golden.json`'s own stamps: hard-fail naming the mint command on an
 *  unknown stamp, closed both directions against `KNOWN_STAMPS` (`compare.test.ts`). Not produced
 *  by `mint-goldens.ts` (it's a derived statistic over the corpus, not a fixture field) — measured
 *  by hand alongside a mint and recorded here. `minRatio`/`maxRatio` are `Infinity`/`-Infinity`
 *  when `count` is 0 (`Math.min`/`Math.max` over an empty array), matching what the test's own
 *  computation produces so the two can be compared directly. */
export interface NominalMissRecord {
    count: number;
    scenarios: string[];
    minRatio: number;
    maxRatio: number;
}

export const NOMINAL_MISS: Record<string, NominalMissRecord> = {
    "linux x64": {
        count: 1,
        scenarios: ["loop-explicit"],
        minRatio: 1.0762891844739062,
        maxRatio: 1.0762891844739062,
    },
    // measured 2026-08-06 on darwin arm64: the fresh corpus solve's nominal replay misses NO
    // scenario's floor — `loop-explicit`'s own realized/nominal gap on this platform's knot
    // placement doesn't cross it, unlike `linux x64`'s. A structural fact about this platform's
    // solve, not a narrower tolerance on the same one.
    "darwin arm64": {
        count: 0,
        scenarios: [],
        minRatio: Infinity,
        maxRatio: -Infinity,
    },
};

/** `NOMINAL_MISS[stamp]`, hard-failing and naming the mint command when `stamp` has no declared
 *  record — the same discipline as `convertAt`. */
export function nominalMissAt(stamp: string): NominalMissRecord {
    const record = NOMINAL_MISS[stamp];
    if (!record)
        throw new Error(
            `NOMINAL_MISS has no entry for platform "${stamp}" — measure it fresh (run the ` +
                `corpus solve, per \`refine.oracle.ts\`) and add it to helpers/golden.ts. ` +
                `\`${MINT_COMMAND}\` mints the fixture goldens but not this derived record.`,
        );
    return record;
}

/** `convert-golden.json`'s per-scenario field → bucket → bound contract
 *  (`kex2d-golden-reproducibility.md`, "The contract"). `knots`/`outcome`/`probes`/`keys`/
 *  `edges` are structural — a different answer, not a drifted one. `length`/`ds`/`points[].s`
 *  are exact but not structural: they are inherited from the f32 barrier (bit-identical on this
 *  machine pair) rather than authored, so they carry no bound of their own. `floor`/`deviation`/
 *  `points[].g` are the fields whose producer crosses an implementation-defined `Math` call with
 *  nothing quantizing it afterward — `floor`/`deviation` bounded at the max measured
 *  structure-conditional cross-machine spread (relative, rounded to the next decade);
 *  `points[].g` in the MIXED form (`atol + rtol·|want|`, 3g), since it can approach zero.
 *
 *  Each limb of the mixed form is derived over the population that limb gates, and the two
 *  populations genuinely differ. Measured on the full corpus (`darwin arm64` fresh solve vs the
 *  `linux x64` golden): 10 scenarios visited, 3 skipped as structurally divergent, 55 point rows.
 *  `rel` = 1e-8, the next decade above the 5.328e-9 max relative error over the 51 rows whose
 *  `|want|` is not near zero — near-zero rows are excluded because a relative error against a
 *  degenerate denominator is undefined, not merely large, which is the whole reason for the
 *  mixed form. `atol` = 1e-9, the next decade above the 6.262e-10 max ABSOLUTE error over the 4
 *  near-zero rows, which are the rows `atol` actually governs. The limbs ADD, so `atol` never has
 *  to cover a large-magnitude row on its own: `valley-explicit[2]` carries the corpus-max absolute
 *  error of 6.793e-9 at `|want|` = 14.1, where `rel·|want|` alone is 1.41e-7, over 20× the error.
 *  Deriving `atol` from that row instead gives 1e-8 and was measured to hold, but it is a decade
 *  looser than its own population supports and leaves the two limbs at wildly different margins
 *  (16× against 1.9×); at 1e-9 both sit near 1.7–1.9×, which is the declared rule applied
 *  consistently. Verified by sweep: `atol` at 1e-8 and 1e-9 both give 0 violations across all 55
 *  rows, 1e-10 gives 2 — so 1e-9 is the tightest decade the corpus admits. */
export const CONVERT_REGISTRY: FieldRegistry = {
    knots: { kind: "structural" },
    outcome: { kind: "structural" },
    probes: { kind: "structural" },
    keys: { kind: "structural" },
    edges: { kind: "structural" },
    length: { kind: "exact" },
    ds: { kind: "exact" },
    floor: { kind: "bounded", rel: 1e-14 },
    deviation: { kind: "bounded", rel: 1e-8 },
    points: { array: { s: { kind: "exact" }, g: { kind: "mixed", atol: 1e-9, rel: 1e-8 } } },
};

/** the frozen force→geo fit answer for a scenario, in `forcegeo-golden.json`'s own shape (not
 *  `GeofitResult` — the fixture omits `geoBudget`/`forceBudget` chrome the fit resolves
 *  internally). Not platform-stamped: 10/10 structurally clean cross-machine (3e). */
export const FORCEGEO_GOLDEN = (name: string) => {
    const want = forcegeoGolden[name as keyof typeof forcegeoGolden];
    return { ...want, outcome: want.outcome as GeofitOutcome };
};

/** `forcegeo-golden.json`'s field → bucket → bound contract. `nodes[].x`/`.y`/`.theta` and
 *  `forceError` are exact — `Float32Array`-stored (or built from exact IEEE reductions over
 *  f32-sourced values) behind the f32 quantization barrier. `outcome` is structural. `deviation`
 *  is the one field with no store after it: a single `hypot` over a bit-identical f32 table, so
 *  the bound is tight-by-construction at 1 ulp of its own magnitude rather than a measured
 *  relative spread — an ABSOLUTE bound, unlike every `bounded` row above. */
export const FORCEGEO_REGISTRY: FieldRegistry = {
    outcome: { kind: "structural" },
    forceError: { kind: "exact" },
    deviation: { kind: "ulp" },
    nodes: {
        array: { x: { kind: "exact" }, y: { kind: "exact" }, theta: { kind: "exact" } },
    },
};

const POLISH_MINT_COMMAND = "bun run tests/mint-goldens.ts";

/** `polish.oracle.ts`'s frozen full-free-family record — 19 fields, stamp-keyed like
 *  `convert-golden.json` (the same solve's structural half is not cross-machine reproducible;
 *  `kex2d-golden-reproducibility` 3c). `narrowPolish` is the one place a live `PolishResult`
 *  becomes this JSON-safe shape: every typed array (`deviations`, `snapshots[].fN`,
 *  `spine.x`/`.y`/`.theta`) round-trips through `JSON.stringify`/`parse`, the same
 *  normalization the committed fixture itself already went through, so `got` and `want` compare
 *  as the same concrete types. `points` carries all five `ForcePoint` members
 *  (`src/profile.ts:135-141`): `ease` (never set by the full-free family's own fit — `fit.ts`
 *  never stores it, every side carries an explicit handle instead — but declared for closure
 *  regardless of what today's corpus happens to exercise), `in`/`out` (the free family's OWN
 *  solved DOF: `readDof`/`applyDof`, `polish.ts:251-252`, read/write `.dg` as solver state
 *  — this IS what makes it the full-free oracle rather than the flat-family `refine` path, so
 *  dropping them was wrong; corrected from 3c's first pass, which called them
 *  "solver-internal bookkeeping" and was not). `snapshots` carries a SHA256 DIGEST of its own
 *  subtree (`compare.ts`'s `digest` bucket + `digestOf`), not the raw trajectory — see
 *  `POLISH_REGISTRY`'s own doc for why that isn't the single-hash relapse it resembles. */
export interface PolishRecord {
    name: string;
    family: string;
    keys: number;
    edges: number;
    length: number;
    ds: number;
    spine: unknown;
    converged: boolean;
    iters: number;
    outers: number;
    rho: number;
    at: number;
    snapshots: unknown;
    feasibility: number;
    deviation: number;
    peakG: number;
    maxDg: number;
    deviations: number[];
    exit: { dx: number; dy: number; dtheta: number; dist: number };
    points: {
        s: number;
        g: number;
        ease: number | null;
        in?: { ds: number; dg: number };
        out?: { ds: number; dg: number };
    }[];
}

/** `PolishResult` → the JSON-safe `PolishRecord`. `snapshots` is left as the RAW trajectory here
 *  (not yet a digest) — a live comparison's `got` side hashes it on the fly through
 *  `compare.ts`'s `digest` bucket, and `mint-goldens.ts` is the one place that pre-hashes it
 *  before writing the fixture, so the committed JSON never carries the raw 7 MB subtree. */
export function narrowPolish(name: string, result: PolishResult): PolishRecord {
    return JSON.parse(
        JSON.stringify({
            name,
            family: result.family,
            keys: result.keys,
            edges: result.edges,
            length: result.length,
            ds: result.ds,
            spine: result.spine,
            converged: result.converged,
            iters: result.iters,
            outers: result.outers,
            rho: result.rho,
            at: result.at,
            snapshots: result.snapshots,
            feasibility: result.feasibility,
            deviation: result.deviation,
            peakG: result.peakG,
            maxDg: result.maxDg,
            deviations: Array.from(result.deviations),
            exit: result.exit,
            points: result.points.map((p) => ({
                s: p.s,
                g: p.g,
                // `?? null`, not bare `p.ease`: JSON.stringify DROPS an `undefined` property
                // entirely, and the full-free family's own fit never stores an ease tag
                // (`fit.ts`'s own docs: "no easing tag is stored… every side… carries an explicit
                // handle") — so a bare `p.ease` would leave `ease` absent as a KEY on every real
                // record, permanently orphaning its registry declaration (`registryClosure`'s
                // per-element check reads real keys, and there would never be one). `null` keeps
                // the key present and closure-checkable while still meaning "no tag stored".
                ease: p.ease ?? null,
                in: p.in,
                out: p.out,
            })),
        }),
    ) as PolishRecord;
}

type PolishGoldenFile = Record<string, Record<string, PolishRecord> | undefined>;

function polishAt(stamp: string, name: string): PolishRecord {
    const platforms = polishGolden as unknown as PolishGoldenFile;
    const record = platforms[stamp];
    if (!record)
        throw new Error(
            `polish-golden.json has no entry for platform "${stamp}" — mint one with \`${POLISH_MINT_COMMAND}\`.`,
        );
    const want = record[name];
    if (!want) throw new Error(`polish-golden.json["${stamp}"] is missing scenario "${name}"`);
    return want;
}

/** the frozen full-free polish answer for a scenario, on THIS platform's own stamp — same
 *  hard-fail-naming-the-mint-command discipline as `GOLDEN` above, never a silent skip. */
export const POLISH_GOLDEN = (name: string) => polishAt(PLATFORM_STAMP, name);

/** `polish.oracle.ts`'s field → bucket → bound contract
 *  (`kex2d-golden-reproducibility.md`, "polish.oracle.ts's record"). `keys`/`edges`/`length`/
 *  `ds`/`points[].s`/`points[].g` mirror `CONVERT_REGISTRY` exactly — same producers.
 *  `converged` is structural (hard fail): `feas < TOL_FEAS`, never flipped across N=24
 *  aggregate-libm trials on any of the 10 corpus scenarios (measured 2026-08-06, this platform).
 *  `iters`/`outers`/`rho`/`at` are diagnostic members pinned EXACT on a stamp-matched run
 *  (same-machine trajectory facts — iteration count itself diverges cross-machine).
 *
 *  **`spine`/`snapshots` are `digest`, not `exact`, and that is NOT the single-hash relapse this
 *  unit's own Residue warns about ("a golden pinned as a single hash cannot be loosened").** The
 *  sha256 this file replaced hashed the WHOLE 19-field record — a knot flip, a bounded
 *  `deviation` drift, and a trajectory change were all the same one bit, so nothing could be
 *  loosened without losing everything. A `digest` bucket scoped to ONE declared-`exact` field
 *  blocks nothing else in the record: every other field still rides its own bucket, bounded
 *  fields still loosen independently, and only the two fields whose own contract already says
 *  EXACT (no bound to loosen in the first place) collapse to 64 hex chars each instead of their
 *  raw form. `spine` (`.x`/`.y`/`.theta`, one entry per baked edge — 151 KiB of the record, 67.5%
 *  of its committed content even with `snapshots` fixed) is a pure lerp over the f32 bake with no
 *  implementation-defined call in `spine()`, so it was already asserted bit-for-bit; hashing it
 *  changes nothing about what's checked. `snapshots` (`Snapshot[]`, each carrying a
 *  `Float32Array` `fN` plus a full `ForcePoint[]` per accepted LM step) is the dominant cost by
 *  two orders of magnitude — 3c's first pass minted `polish-golden.json` at 17.7 MB before this
 *  was caught, 99% of it `snapshots` alone. `mint-goldens.ts` hashes both fields (via `digestOf`,
 *  `helpers/compare.ts`) before writing the fixture; `narrowPolish` leaves them raw so a live
 *  comparison's `got` side hashes on the fly against the pre-hashed `want`. Final committed size:
 *  156,852 bytes / ~153 KiB (down from 17.7 MB pre-fix, 449,609 bytes with `snapshots` alone
 *  fixed) — under the ~250 KiB target. The remainder is mostly `points`/`deviations` — real
 *  per-scenario numeric data with no bulk-trajectory shape to hash away.
 *
 *  `points[].ease` is exact (a discrete tag, always `undefined` for the full-free family's own
 *  fit — `fit.ts` never stores one). `points[].in`/`.out` are OPTIONAL nested objects
 *  (`{ds, dg}`) — absent on the two `ForcePoint`s at either end of the chain, present on every
 *  interior point; a presence mismatch is checked in the STRUCTURAL pass, ahead of any bounded
 *  field (`compare.ts`'s `compareGolden`, corrected from 3c's first pass — see that file's own
 *  header note). `.ds` is exact (a cumulative sum of `bake.ds`, the f32-barrier argument —
 *  measured 0 spread).
 *
 *  **`.dg` is EXACT, not the `mixed` bound 3c first shipped, and the correction is upstream of
 *  the arithmetic.** 3c derived `rel = 1e-1` from the closed 3a' aggregate probe (a worst-case
 *  synthetic ±1-ulp-on-every-call model), the same class of evidence that produced `floor`/
 *  `deviation`/`points[].g` before 3g tightened THOSE against a real cross-machine fixture. The
 *  architectural review found the derivation sound but the METHOD wrong for this field: 3a' models
 *  cross-machine libm drift, and 3e's per-platform verdict already established `polish-golden.json`
 *  is compared ONLY own-stamp (`POLISH_GOLDEN` resolves through `PLATFORM_STAMP`) — there is no
 *  cross-machine comparison for this bound to protect against. The reviewer measured the
 *  question that actually matters: the full corpus solved three times is byte-identical, and a
 *  live run matches the committed golden on EVERY field, 0 mismatches across all 10 scenarios,
 *  including every `.dg` — the difference this bound is ever evaluated against is exactly zero,
 *  always. Applying a cross-machine noise model to decide a same-machine, deterministic
 *  bucket is exactly what Residue already names as unsafe: *"safe for magnitudes, unsafe for
 *  decisions."* So the bucket is DERIVED, not observed: own-stamp comparison + a deterministic
 *  solve ⟹ exact, full stop — no measured spread enters it.
 *
 *  At `rel = 1e-1` the bound was so loose it passed a uniform 5% error on every interior handle's
 *  `dg`, all 10 scenarios (`dg * 1.05` mutated into `polish.ts`'s return path) — `polish.oracle.ts`
 *  stayed 2/0. It takes ×1.5 to fail. `exact` catches the ×1.05 mutation (verified below).
 *
 *  **Provisional pending 3f.** 3f mints the `linux x64` stamp — the first real cross-machine data
 *  point this fixture will ever have. If it finds genuine drift on `.dg` (plausible: `.dg` is a
 *  segment TANGENT derivative, one differentiation more sensitive to a libm difference than the
 *  keyframe value itself, and `loop-explicit`'s dense near-singular Jacobian blocks are
 *  independently flagged elsewhere in this unit — 3e's structural-divergence inventory — as the
 *  corpus's worst-conditioned scenario), 3f re-buckets `.dg` to a MEASURED mixed bound the way 3g
 *  re-derived `points[].g` against the real `linux x64` pair, rather than trusting a synthetic
 *  probe again. **The identical argument applies to every bounded field on both stamp-matched
 *  fixtures** (`convert-golden.json`'s `floor`/`deviation`/`points[].g`, this file's `feasibility`/
 *  `peakG`/`maxDg`/`deviations`/`exit.*`) — left un-re-derived here on the orchestrator's explicit
 *  instruction, filed for the architectural pass as a contract-table-wide question, not a
 *  per-field fix. The inconsistency (this one field re-argued, the rest not) is deliberate and
 *  visible, not an oversight.
 *
 *  The six ⧗ cells this stage owns, derived by re-running the CLOSED 3a' instrument
 *  (`wrapAllPerturbed`, `tests/helpers/libm.ts`) against THIS record's own producer — the
 *  full-free `fit`+`polish` path, not the flat-family `refine` path 3a' measured — over the
 *  FULL 10-scenario corpus (N=24 trials/scenario, every implementation-defined call bumped a
 *  random ±1 ulp). Structure (`keys`, `converged`) never flipped in any trial on any scenario,
 *  so every scenario's continuous spread is admissible with no conditioning exclusion needed.
 *  This is the same worst-case-aggregate-probe class of evidence 3a' produced for `floor`/
 *  `deviation`/`points[].g` before those were later tightened at 3g against a REAL cross-machine
 *  fixture; no such fixture exists yet for `polish.oracle.ts` (this is its first stamped
 *  golden), so the aggregate probe is the derivation of record, not a placeholder — deliberately
 *  conservative, all rounded to the next decade above the measured max:
 *
 *  - `feasibility` — **bounded**, rel 1e-5. Max relative spread 6.450e-6 (valley-explicit).
 *    Never near zero (native range 1.07e-7–9.83e-7 across the corpus), so a plain relative bound
 *    is well-conditioned.
 *  - `peakG` — **bounded**, rel 1e-6. Max relative spread 5.565e-7 (hill-auto); zero on 8/10
 *    scenarios (an argmax the perturbation didn't reach), nonzero on 2 — genuinely bounded, not
 *    exact, so it doesn't get the barrier's zero-spread promotion.
 *  - `maxDg` — **bounded**, rel 1e-4. Max relative spread 1.211e-5 (loop-explicit).
 *  - `deviations` — **mixed** (vector), atol 1e-8 + rel 1e-8. Same underlying `hypot` reduction
 *    as the scalar `deviation` before its max is taken (`devProfile` in `polish.ts`), so it
 *    inherits `deviation`'s own reused rel bound; `atol` covers the array's structurally-zero
 *    entry (index 0, the pinned entry) and any sample near the spine, derived from the measured
 *    max absolute spread 2.225e-9 (loop-explicit), next decade.
 *  - `exit.dx`/`.dy`/`.dist` — **mixed**, atol 1e-12 + rel 1e-6. Position-equivalent residuals
 *    that can sit near zero at a well-pinned exit (three corpus rows have `|want| < 1e-9`); atol
 *    from the max absolute spread on those near-zero rows (1.025e-13, next decade), rel from the
 *    max relative spread elsewhere (7.14e-7, next decade).
 *  - `exit.dtheta` — **mixed**, atol 1e-14 + rel 0 (a pure absolute bound — `rel: 0` collapses
 *    the mixed form to `atol` alone). Every corpus row's native value already sits at
 *    1e-11–1e-16 — the heading pin's own noise floor — so no row supports a meaningful relative
 *    reading; atol from the max absolute spread (2.665e-15), next decade. */
export const POLISH_REGISTRY: FieldRegistry = {
    name: { kind: "exact" },
    family: { kind: "exact" },
    keys: { kind: "exact" },
    edges: { kind: "exact" },
    length: { kind: "exact" },
    ds: { kind: "exact" },
    spine: { kind: "digest" },
    converged: { kind: "structural" },
    iters: { kind: "exact" },
    outers: { kind: "exact" },
    rho: { kind: "exact" },
    at: { kind: "exact" },
    snapshots: { kind: "digest" },
    feasibility: { kind: "bounded", rel: 1e-5 },
    peakG: { kind: "bounded", rel: 1e-6 },
    maxDg: { kind: "bounded", rel: 1e-4 },
    deviations: { vector: { kind: "mixed", atol: 1e-8, rel: 1e-8 } },
    exit: {
        object: {
            dx: { kind: "mixed", atol: 1e-12, rel: 1e-6 },
            dy: { kind: "mixed", atol: 1e-12, rel: 1e-6 },
            dtheta: { kind: "mixed", atol: 1e-14, rel: 0 },
            dist: { kind: "mixed", atol: 1e-12, rel: 1e-6 },
        },
    },
    deviation: { kind: "bounded", rel: 1e-8 },
    points: {
        array: {
            s: { kind: "exact" },
            g: { kind: "mixed", atol: 1e-9, rel: 1e-8 },
            ease: { kind: "exact" },
            in: { object: { ds: { kind: "exact" }, dg: { kind: "exact" } } },
            out: { object: { ds: { kind: "exact" }, dg: { kind: "exact" } } },
        },
    },
};
