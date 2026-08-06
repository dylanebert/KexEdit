import type { GeofitOutcome } from "../../src/geofit";
import type { RefineOutcome } from "../../src/refine";
import { scenarios } from "../../src/scenarios";
import { evalGeo } from "../../src/section";
import convertGolden from "../fixtures/convert-golden.json";
import forcegeoGolden from "../fixtures/forcegeo-golden.json";
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
