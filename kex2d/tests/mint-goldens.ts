/** Mints every golden fixture for the CURRENT platform in one command
 *  (`bun run tests/mint-goldens.ts`, invoked by path — no `package.json` script,
 *  `coding.md` Suite speed). `kex2d-golden-reproducibility` 3g: this is what turns the
 *  "standing two-device tax paid forever" (Locked decision, C's cost 1) into a one-time cost.
 *
 *  `convert-golden.json` is a PER-PLATFORM artifact (3e's A1 verdict): minting computes this
 *  platform's own refine corpus and merges it under this platform's stamp, leaving every OTHER
 *  platform's stamp entry untouched — a platform that never runs this script keeps whatever it
 *  last minted.
 *
 *  `forcegeo-golden.json` stays a SINGLE, unstamped golden (10/10 cross-machine clean, 3e),
 *  derived from the FIXED reference stamp's convert-golden entry
 *  (`helpers/golden.ts`'s `FORCEGEO_SOURCE_STAMP`). It is written ONLY when this script runs ON
 *  the reference stamp — running it elsewhere leaves the file byte-untouched. Not a shortcut:
 *  `forcegeo-golden.json` is the cross-machine REFERENCE `points[].g`'s 1-ulp
 *  bound compares against, so a non-reference platform re-deriving it (even from data that
 *  nominally traces back to the reference stamp) writes that platform's own libm-perturbed
 *  values over the reference — a moving target the 1-ulp bound can no longer measure anything
 *  against. Measured directly: minting on `darwin arm64` moved `hill-explicit.deviation` by
 *  exactly 1 ulp relative to the committed `linux x64`-derived value.
 *
 *  Minting over a clean tree must leave `git diff` empty — that's the gate this script owes
 *  (`kex2d-golden-reproducibility` Validation). On the reference stamp this holds for both
 *  files; on any other platform it holds for `convert-golden.json` alone, `forcegeo-golden.json`
 *  never touched. */

import { geofit, type GeofitBake, type GeofitNode, type GeofitOutcome } from "../src/geofit";
import { forceProfile } from "../src/profile";
import { narrow, refine } from "../src/refine";
import { scenarios } from "../src/scenarios";
import { evalForce, evalGeo } from "../src/section";
import { FORCEGEO_SOURCE_STAMP, KNOWN_STAMPS, PLATFORM_STAMP } from "./helpers/golden";

const CONVERT_PATH = new URL("./fixtures/convert-golden.json", import.meta.url);
const FORCEGEO_PATH = new URL("./fixtures/forcegeo-golden.json", import.meta.url);

type Json = Record<string, unknown>;

async function readJson(path: URL): Promise<Json> {
    return JSON.parse(await Bun.file(path).text()) as Json;
}

async function writeJson(path: URL, data: unknown): Promise<void> {
    await Bun.write(path, `${JSON.stringify(data, null, 4)}\n`);
}

if (!(KNOWN_STAMPS as readonly string[]).includes(PLATFORM_STAMP))
    throw new Error(
        `mint-goldens: this platform's stamp "${PLATFORM_STAMP}" is not in the declared ` +
            `KNOWN_STAMPS registry (helpers/golden.ts) — add it there first.`,
    );

// -- convert-golden.json: this platform's own refine corpus, merged under its own stamp key,
// every other platform's entry left byte-identical.
const convertGolden = await readJson(CONVERT_PATH);
const platformConvert: Json = {};
for (const scenario of scenarios) {
    const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };
    const bake = evalGeo(entry, scenario.nodes, scenario.ds);
    const result = refine({ bake, entry, ds: scenario.ds });
    platformConvert[scenario.name] = narrow(result);
}
convertGolden[PLATFORM_STAMP] = platformConvert;
await writeJson(CONVERT_PATH, convertGolden);

// -- forcegeo-golden.json: single golden, sourced from the FIXED reference stamp, written ONLY
// when THIS script is running ON that reference stamp. Every other platform leaves the file
// byte-untouched: it has no legitimate value to contribute, since its own libm perturbs the
// re-derivation by up to 1 ulp relative to the committed reference (see file header).
if (PLATFORM_STAMP !== FORCEGEO_SOURCE_STAMP) {
    console.log(
        `skipped forcegeo-golden.json: this platform ("${PLATFORM_STAMP}") is not the ` +
            `reference stamp ("${FORCEGEO_SOURCE_STAMP}") — only the reference stamp mints it.`,
    );
} else {
    const sourceConvert = convertGolden[FORCEGEO_SOURCE_STAMP] as
        | Record<string, { points: { s: number; g: number }[]; length: number; ds: number }>
        | undefined;
    if (!sourceConvert)
        throw new Error(
            `mint-goldens: convert-golden.json has no "${FORCEGEO_SOURCE_STAMP}" entry to ` +
                `source forcegeo-golden.json from.`,
        );

    const forcegeoGolden: Json = {};
    for (const scenario of scenarios) {
        const g = sourceConvert[scenario.name];
        const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };
        const bake = evalForce(entry, forceProfile(g.points, g.length, g.ds), g.ds);
        const target: GeofitBake = {
            x: bake.posX,
            y: bake.posY,
            fN: bake.fN,
            ds: bake.ds,
            edges: bake.fN.length,
        };
        const fit = geofit(target, entry.v);
        const nodes: GeofitNode[] = fit.nodes.map(({ x, y, theta }) => ({ x, y, theta }));
        const outcome: GeofitOutcome = fit.outcome;
        forcegeoGolden[scenario.name] = {
            nodes,
            outcome,
            deviation: fit.deviation,
            forceError: fit.forceError,
        };
    }
    await writeJson(FORCEGEO_PATH, forcegeoGolden);
    console.log(`minted forcegeo-golden.json (this platform is the reference stamp)`);
}

console.log(`minted convert-golden.json["${PLATFORM_STAMP}"]`);
