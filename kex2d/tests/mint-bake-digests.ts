/** Mints `tests/fixtures/v3/bake-digests.json`, invoked by path
 *  (`bun run tests/mint-bake-digests.ts`, no `package.json` script — `coding.md` Suite speed,
 *  `tests/mint-cli-fixtures.ts`'s own precedent).
 *
 *  One sha256 per frozen v3 fixture over the whole published bake. The digests exist because the
 *  store cuts over at S2e: the node bake they record is the thing the lane bake must still
 *  reproduce afterwards, and by then the node path is gone and cannot be re-run for comparison.
 *  Minting them NOW, while `doc.v3Payloads` is proven byte-identical to the live `BakeSystem`
 *  bake (`tests/doc.test.ts`, "the pure v3 payload builder is the live bake"), is what makes
 *  them evidence rather than a snapshot of whatever the tree happened to do.
 *
 *  `cli/loop-explicit.kex` is included even though `migrations[3]` refuses it: its NODE bake
 *  still exists and is exactly what a later build would need to show it is not silently losing.
 *  Reaching it means assembling the v3 payload without migrating, which is the one place this
 *  script threads `oneShot` onto `track.v0` by hand — the start speed whose default cost the
 *  stage its first fit numbers. */

import { createHash } from "node:crypto";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DocStrip, type DocSegment, type DocTrack, v3Payloads } from "../src/doc";
import { chain } from "../src/section";
import { MAX_SAMPLES } from "../src/track";

const root = join(import.meta.dir, "fixtures", "v3");

/** every frozen v3 fixture, path-relative to `fixtures/v3/`. */
export function v3Corpus(): string[] {
    const out: string[] = [];
    const walk = (dir: string, prefix: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
            a.name.localeCompare(b.name),
        )) {
            if (e.isDirectory()) walk(join(dir, e.name), `${prefix}${e.name}/`);
            else if (e.name.endsWith(".kex")) out.push(`${prefix}${e.name}`);
        }
    };
    walk(root, "");
    return out;
}

/** the whole published bake of one v3 fixture, as a sha256 over every SoA `chain` publishes. */
export function digestOf(text: string): string {
    const raw = JSON.parse(text) as {
        track: DocTrack;
        segments: DocSegment[];
        strips: DocStrip[];
        oneShot?: { value?: number }[];
    };
    const v0 = raw.oneShot?.[0]?.value;
    const p = v3Payloads({
        track: { ...raw.track, ...(v0 === undefined ? {} : { v0 }) },
        segments: raw.segments,
        strips: raw.strips,
    });
    const c = chain(p.entry, p.sections, MAX_SAMPLES, p.friction, p.resistance);
    const count = Math.min(c.count, MAX_SAMPLES);
    const edges = Math.max(0, count - 1);
    const h = createHash("sha256");
    h.update(`count:${count}`);
    for (const [name, arr, n] of [
        ["posX", c.posX, count],
        ["posY", c.posY, count],
        ["theta", c.theta, count],
        ["v", c.v, count],
        ["fN", c.fN, edges],
        ["ds", c.ds, edges],
    ] as const) {
        h.update(name);
        h.update(new Uint8Array(arr.buffer, arr.byteOffset, n * 4));
    }
    return h.digest("hex");
}

if (import.meta.main) {
    const out: Record<string, string> = {};
    for (const name of v3Corpus()) out[name] = digestOf(await Bun.file(join(root, name)).text());
    writeFileSync(join(root, "bake-digests.json"), `${JSON.stringify(out, null, 4)}\n`);
    console.log(`minted bake-digests.json over ${Object.keys(out).length} v3 fixtures`);
}
