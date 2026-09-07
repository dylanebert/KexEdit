/** Mints `tests/fixtures/v3/bake-digests.json`, invoked by path
 *  (`bun run tests/mint-bake-digests.ts`, no `package.json` script — `coding.md` Suite speed,
 *  `tests/mint-cli-fixtures.ts`'s own precedent).
 *
 *  One sha256 per LOADABLE fixture over the whole published bake, plus the refusal witness. The
 *  digests exist because the store cuts over at S2e-i: the node bake they record is the thing the
 *  lane bake must still reproduce afterwards, and by then the node path is gone and cannot be
 *  re-run for comparison. Minting them BEFORE any store edit, while `doc.v3Payloads` is proven
 *  byte-identical to the live `BakeSystem` bake (`tests/doc.test.ts`, "the pure v3 payload builder
 *  is the live bake"), is what makes them evidence rather than a snapshot of whatever the tree
 *  happened to do.
 *
 *  **The reference is `chain(v3Payloads(input))` and the input is never a v4 file** (spec
 *  `kex2d-segment-gestures` Validation 2, S2e form): twenty fixtures are still committed at
 *  v1–v3 and are read from their own text; the ten minted at v4 are read from their frozen
 *  `tests/fixtures/v3/` twin. That is what keeps the reference computable after `segments` and
 *  `strips` leave the v4 wire — nothing here parses a v4 document or touches an ECS.
 *
 *  `cli/loop-explicit.kex` is the thirty-first entry even though `migrations[3]` refuses it: its
 *  node bake still exists and is exactly what a later build would need to show it is not silently
 *  losing. Reaching it means assembling the v3 payload without migrating to v4, which is what
 *  every entry here does — including the hand-threaded `oneShot` → `track.v0`, the start speed
 *  whose default cost the stage its first fit numbers. */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    type DocSegment,
    type DocStrip,
    type DocTrack,
    preLaneMigrations,
    v3Payloads,
} from "../src/doc";
import { chain } from "../src/section";
import { MAX_SAMPLES } from "../src/track";

const fixtures = join(import.meta.dir, "fixtures");

/** the version the frozen migration inputs are stamped at — the shape {@link v3Payloads} reads. */
const V3 = 3;

/** the refusal witness: the one v3 CLI fixture `migrations[3]` refuses, so it mints no v4 twin
 *  and is not in the loadable corpus. It carries a digest anyway (spec Validation 2, S2e form). */
export const REFUSAL_WITNESS = "cli/loop-explicit.kex";

/** every committed `.kex` fixture outside the frozen `v2`/`v3` migration inputs and the
 *  deliberately malformed `invariants/*-red` corpus — the documents that actually load. Thirty of
 *  them; the same population `tests/bake-identity.oracle.ts` walks. */
export function loadableCorpus(): string[] {
    const out: string[] = [];
    for (const dir of ["", "cli", "force", "invariants", "velocity"]) {
        const abs = dir === "" ? fixtures : join(fixtures, dir);
        if (!existsSync(abs)) continue;
        for (const name of readdirSync(abs)) {
            if (!name.endsWith(".kex") || name.endsWith("-red.kex")) continue;
            out.push(dir === "" ? name : `${dir}/${name}`);
        }
    }
    return out.sort();
}

/** every name the digest file keys: the loadable corpus plus the refusal witness. Thirty-one. */
export function digestCorpus(): string[] {
    return [...loadableCorpus(), REFUSAL_WITNESS].sort();
}

/** the file whose text is `name`'s REFERENCE INPUT: its frozen `v3/` twin when one exists (the
 *  ten fixtures minted at v4, and the refusal witness), otherwise its own v1–v3 text. */
export function referenceInput(name: string): string {
    const twin = join(fixtures, "v3", name);
    return existsSync(twin) ? twin : join(fixtures, name);
}

/** `text` walked forward to the frozen v3 payload shape and no further, one
 *  {@link preLaneMigrations} step at a time. A text already at v3 passes through; a version this
 *  prefix cannot bridge, or one past v3, throws rather than being read as some other shape. */
function toV3(text: string): {
    track: DocTrack;
    segments: DocSegment[];
    strips: DocStrip[];
    v0: number | undefined;
} {
    let doc0 = JSON.parse(text) as Record<string, unknown>;
    const first = doc0.version;
    if (typeof first !== "number") throw new Error("reference input carries no version");
    let v: number = first;
    while (v < V3) {
        const step = preLaneMigrations[v];
        if (!step) throw new Error(`version ${v} has no migration path to v${V3}`);
        doc0 = step(doc0);
        const next = doc0.version;
        if (typeof next !== "number" || next <= v)
            throw new Error(`migration from version ${v} did not advance the version`);
        v = next;
    }
    if (v !== V3) throw new Error(`reference input is at version ${v}, not v${V3}`);
    const doc = doc0 as unknown as {
        track: DocTrack;
        segments: DocSegment[];
        strips: DocStrip[];
        oneShot?: { value?: number }[];
    };
    return {
        track: doc.track,
        segments: doc.segments,
        strips: doc.strips,
        v0: doc.oneShot?.[0]?.value,
    };
}

/** the reference bake of one input: `chain(v3Payloads(v1\u2013v3 text))`. Pure — no ECS, no v4
 *  document, no bake read — which is what keeps it computable after the store cuts over. */
export function referenceChain(text: string): ReturnType<typeof chain> {
    const { track, segments, strips, v0 } = toV3(text);
    const p = v3Payloads({
        track: { ...track, ...(v0 === undefined ? {} : { v0 }) },
        segments,
        strips,
    });
    return chain(p.entry, p.sections, MAX_SAMPLES, p.friction, p.resistance);
}

/** a sha256 over every SoA a bake publishes — the one hash the digest file records and every
 *  arm compares against, so the reference and a live bake are hashed by identical rules. */
export function digestOfChain(c: {
    count: number;
    posX: Float32Array;
    posY: Float32Array;
    theta: Float32Array;
    v: Float32Array;
    fN: Float32Array;
    ds: Float32Array;
}): string {
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

/** the reference bake digest of one input text. */
export function digestOf(text: string): string {
    return digestOfChain(referenceChain(text));
}

/** the reference bake digest of one fixture NAME, resolving its input per {@link referenceInput}. */
export async function referenceDigest(name: string): Promise<string> {
    return digestOf(await Bun.file(referenceInput(name)).text());
}

/** the reference BAKE of one fixture name, resolving its input per {@link referenceInput}. */
export async function referenceBake(name: string): Promise<ReturnType<typeof referenceChain>> {
    return referenceChain(await Bun.file(referenceInput(name)).text());
}

if (import.meta.main) {
    const out: Record<string, string> = {};
    for (const name of digestCorpus()) out[name] = await referenceDigest(name);
    writeFileSync(join(fixtures, "v3", "bake-digests.json"), `${JSON.stringify(out, null, 4)}\n`);
    console.log(`minted bake-digests.json over ${Object.keys(out).length} fixtures`);
}
