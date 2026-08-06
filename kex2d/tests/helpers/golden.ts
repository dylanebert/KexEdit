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

/** `convert-golden.json[stamp]`, hard-failing and naming the mint command when `stamp` has no
 *  entry at all — never silently skipping a gate a missing golden can't run
 *  (`kex2d-golden-reproducibility` 3g). The one place that null-check lives: `convertAt` calls
 *  through it for a single scenario, and `refine.oracle.ts`'s corpus-membership check calls it
 *  directly for the whole record's key set — before this it read `convertGolden[stamp]` raw and
 *  died as `Object.keys(undefined)` on an unminted stamp instead of this named error
 *  (`kex2d-golden-reproducibility` 4). */
export function convertRecordAt(stamp: string): Record<string, RawConvertRecord> {
    const platforms = convertGolden as unknown as ConvertGoldenFile;
    const record = platforms[stamp];
    if (!record)
        throw new Error(
            `convert-golden.json has no entry for platform "${stamp}" — mint one with \`${MINT_COMMAND}\`.`,
        );
    return record;
}

/** `convert-golden.json[stamp][name]` — `convertRecordAt` plus the per-scenario lookup. */
function convertAt(stamp: string, name: string) {
    const record = convertRecordAt(stamp);
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

/** `convert-golden.json`'s per-scenario field → bucket contract
 *  (`kex2d-golden-reproducibility.md`, "The contract"). `knots`/`outcome`/`probes`/`keys`/
 *  `edges` are structural — a different answer, not a drifted one.
 *
 *  **Every other field is `exact`, derived from the COMPARISON this fixture runs, not from an
 *  observed spread.** `GOLDEN` resolves through `PLATFORM_STAMP` (`convertAt`), so every
 *  comparison here is own-stamp against a deterministic solve, which presents zero spread — a
 *  bucket is a claim about the comparison, not the field (`kex2d-golden-reproducibility` 4, "The
 *  close's verdict"). `length`/`ds`/`points[].s` were always exact this way (inherited from the
 *  f32 quantization barrier, never authored). `floor`/`deviation`/`points[].g` shipped
 *  bounded/mixed through 3g, derived against a cross-machine spread the own-stamp comparison
 *  never runs — 3f then measured the real cross-machine pair and found the bound wrong in BOTH
 *  directions at once (unfirable where it ran: own-stamp difference always zero; invalid where it
 *  was aimed: `deviation` at 4.9× its declared 1e-8 bound, `points[].g` five decades past its
 *  declared `atol`/`rel`), which is what forces the re-derivation rather than merely permits it.
 *  The superseded relative-spread and mixed-limb derivations aren't repeated here — they're the
 *  spec's contract-table record, kept for whoever re-derives a bound after a future decision
 *  reintroduces a genuinely shared comparison for one of these fields. */
export const CONVERT_REGISTRY: FieldRegistry = {
    knots: { kind: "structural" },
    outcome: { kind: "structural" },
    probes: { kind: "structural" },
    keys: { kind: "structural" },
    edges: { kind: "structural" },
    length: { kind: "exact" },
    ds: { kind: "exact" },
    floor: { kind: "exact" },
    deviation: { kind: "exact" },
    points: { array: { s: { kind: "exact" }, g: { kind: "exact" } } },
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
 *  relative spread. It is an ABSOLUTE bound, and after stage 4 it is the unit's ONLY bound: every
 *  row on the two own-stamp registries is `exact`, because a bound belongs where a fixture is
 *  genuinely shared and nowhere else (`kex2d-golden-reproducibility` 4, "The close's verdict"). */
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

/** `polish.oracle.ts`'s field → bucket contract
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
 *  blocks nothing else in the record: every other field still rides its own bucket, any field
 *  could still be loosened independently, and only the two fields whose own contract already says
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
 *  interior point; a presence mismatch is checked in the STRUCTURAL pass, ahead of any value
 *  comparison (`compare.ts`'s `compareGolden`, corrected from 3c's first pass — see that file's own
 *  header note). `.ds` is exact (a cumulative sum of `bake.ds`, the f32-barrier argument —
 *  measured 0 spread).
 *
 *  **`.dg` is EXACT, not the `mixed` bound 3c first shipped, and the correction is upstream of
 *  the arithmetic — it's the general derivation every other continuous field in this file now
 *  follows.** 3c derived `rel = 1e-1` from the closed 3a' aggregate probe (a worst-case synthetic
 *  ±1-ulp-on-every-call model), the same class of evidence that produced `floor`/`deviation`/
 *  `points[].g` before 3g tightened THOSE against a real cross-machine fixture. The architectural
 *  review found the derivation sound but the METHOD wrong for this field: 3a' models cross-machine
 *  libm drift, and 3e's per-platform verdict already established `polish-golden.json` is compared
 *  ONLY own-stamp (`POLISH_GOLDEN` resolves through `PLATFORM_STAMP`) — there is no cross-machine
 *  comparison for this bound to protect against. The full corpus solved three times is
 *  byte-identical, and a live run matches the committed golden on EVERY field, 0 mismatches
 *  across all 10 scenarios — the difference `.dg`'s bound is ever evaluated against is exactly
 *  zero, always. Applying a cross-machine noise model to decide a same-machine, deterministic
 *  bucket is exactly what Residue already names as unsafe: *"safe for magnitudes, unsafe for
 *  decisions."* So the bucket is DERIVED, not observed: own-stamp comparison + a deterministic
 *  solve ⟹ exact, full stop — no measured spread enters it. At `rel = 1e-1` the bound was so loose
 *  it passed a uniform 5% error on every interior handle's `dg`, all 10 scenarios (`dg * 1.05`
 *  mutated into `polish.ts`'s return path) — `polish.oracle.ts` stayed 2/0. It takes ×1.5 to fail.
 *  `exact` catches the ×1.05 mutation (`compare.test.ts`).
 *
 *  **Stage 4 extends the identical argument to every other bounded/mixed field on both
 *  stamp-matched fixtures** (`convert-golden.json`'s `floor`/`deviation`/`points[].g`; this
 *  file's `feasibility`/`peakG`/`maxDg`/`deviations`/`exit.*`/`deviation`/`points[].g`) — filed
 *  provisionally at 3c pending 3f's real cross-machine pair, then taken at the architectural
 *  pass on that pair's own measurement (`kex2d-golden-reproducibility` 4, "The close's verdict").
 *  3f's pair split three ways and the split doesn't matter to the verdict: `exit.*`, `deviations`,
 *  `feasibility`, `peakG`, and `maxDg` all measured WITHIN their declared bound (six derivations
 *  made without a pair, surviving one), while scalar `deviation` (4.9× its declared 1e-8) and
 *  `points[].g` (five decades past `atol`/`rel`) measured outside it — but a bound holding on one
 *  measured pair doesn't validate it as a general claim, and a bound this fixture's own comparison
 *  never evaluates against anything but zero can't be validated OR invalidated by a comparison it
 *  doesn't run. Every one of the eight fields is `exact` for the same reason `.dg` is: own-stamp
 *  comparison + a deterministic solve. */
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
    feasibility: { kind: "exact" },
    peakG: { kind: "exact" },
    maxDg: { kind: "exact" },
    deviations: { vector: { kind: "exact" } },
    exit: {
        object: {
            dx: { kind: "exact" },
            dy: { kind: "exact" },
            dtheta: { kind: "exact" },
            dist: { kind: "exact" },
        },
    },
    deviation: { kind: "exact" },
    points: {
        array: {
            s: { kind: "exact" },
            g: { kind: "exact" },
            ease: { kind: "exact" },
            in: { object: { ds: { kind: "exact" }, dg: { kind: "exact" } } },
            out: { object: { ds: { kind: "exact" }, dg: { kind: "exact" } } },
        },
    },
};
