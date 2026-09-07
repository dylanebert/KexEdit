/** Mints the ten v4 `.kex` fixtures, invoked by path
 *  (`bun run tests/mint-cli-fixtures.ts`, no `package.json` script — `coding.md` Suite speed,
 *  `tests/mint-goldens.ts`'s own precedent).
 *
 *  **`serialize(parse(v3 twin))`, and no ECS at all** (spec S2e-i punch list item 4). Each
 *  fixture's frozen `tests/fixtures/v3/` twin is the authored input; `parseDocument` migrates it
 *  to v4 through `migrations[3]` and `serializeDocument` writes the canonical text. That is a
 *  pure function of committed bytes, so minting on any machine reproduces the same file and
 *  re-running over a clean tree must leave `git diff` empty — the same reproducibility contract
 *  `mint-goldens.ts` owes its own fixtures.
 *
 *  `cli/loop-explicit.kex` mints nothing: its Mirror tangents sit at the bezier control offset
 *  where `spline.hermite` reads a velocity, so the claimed circle bakes ~1 m near-cusps that no
 *  ≥1 m pitch record represents and `migrations[3]` refuses it at the record floor (spec
 *  Validation 2 and 9). Its frozen v3 file stays under `tests/fixtures/v3/cli/` as the live
 *  refusal witness, and the scenario itself stays in `scenarios.ts` for the locked goldens. */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseDocument, serializeDocument } from "../src/doc";

const fixtures = join(import.meta.dir, "fixtures");
const v3 = join(fixtures, "v3");

/** the one v3 fixture `migrations[3]` refuses, so it mints no v4 twin. */
const REFUSED = "cli/loop-explicit.kex";

/** every frozen v3 fixture, path-relative to `fixtures/v3/`. */
function v3Corpus(): string[] {
    const out: string[] = [];
    const walk = (dir: string, prefix: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
            a.name.localeCompare(b.name),
        )) {
            if (e.isDirectory()) walk(join(dir, e.name), `${prefix}${e.name}/`);
            else if (e.name.endsWith(".kex")) out.push(`${prefix}${e.name}`);
        }
    };
    walk(v3, "");
    return out;
}

for (const name of v3Corpus()) {
    if (name === REFUSED) {
        console.log(`skipped ${name} (refused by migrations[3] at the record floor)`);
        continue;
    }
    const text = await Bun.file(join(v3, name)).text();
    await Bun.write(join(fixtures, name), serializeDocument(parseDocument(text)));
    console.log(`minted ${name}`);
}
