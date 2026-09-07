/** the bake-identity oracle (spec `kex2d-segment-gestures` Validation 2), run by path
 *  (`bun test ./tests/bake-identity.oracle.ts` — `coding.md` Suite speed, `kex2d-map.md`'s
 *  by-path oracle convention).
 *
 *  The claim it holds: re-keying the authored track onto lanes changes what is STORED, never
 *  what is BAKED. So for every committed document that loads, the cycle
 *
 *      load → bake → save → load → bake
 *
 *  must publish byte-identical `bakeOut`/`samples` on both bakes, and the second save must equal
 *  the first (the wire is a fixed point). The save in the middle is the point: it forces the
 *  authored state through the v4 wire, so anything the lane records cannot carry shows up here as
 *  a moved sample rather than as a silently narrowed round-trip.
 *
 *  This reads the LIVE tree only. The cross-tree half of Validation 2 — the same corpus baked on
 *  the pre-cutover tree — is a one-off comparison recorded in the stage's fold, not a standing
 *  check: the retired tree is a commit, not a dependency. */

import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { State } from "@dylanebert/shallot";
import { loadDocument, saveDocument } from "../src/doc";
import { bakeOut, BakeSystem, samples, Track, trackEntity } from "../src/track";

/** every committed `.kex` fixture outside the frozen `v2`/`v3` migration inputs and the
 *  deliberately malformed `invariants/*-red` corpus — the documents that actually load. */
function corpus(): string[] {
    const root = join(import.meta.dir, "fixtures");
    const out: string[] = [];
    for (const dir of ["", "cli", "force", "invariants", "velocity"]) {
        const abs = dir === "" ? root : join(root, dir);
        if (!existsSync(abs)) continue;
        for (const name of readdirSync(abs)) {
            if (!name.endsWith(".kex") || name.endsWith("-red.kex")) continue;
            out.push(dir === "" ? name : `${dir}/${name}`);
        }
    }
    return out.sort();
}

/** the whole published bake of one track as plain numbers — every SoA the display, the cart and
 *  the timeline read, clipped to the published sample count. */
function baked(eid: number) {
    const count = Track.count.get(eid);
    const s = samples.get(eid);
    const out = bakeOut.get(eid);
    if (!s || !out) throw new Error("track buffers missing");
    const edges = Math.max(0, count - 1);
    return {
        count,
        posX: Array.from(s.posX.subarray(0, count)),
        posY: Array.from(s.posY.subarray(0, count)),
        theta: Array.from(s.theta.subarray(0, count)),
        v: Array.from(out.v.subarray(0, count)),
        t: Array.from(out.t.subarray(0, count)),
        fN: Array.from(out.fN.subarray(0, edges)),
        ds: Array.from(out.ds.subarray(0, edges)),
    };
}

/** load `text` into a fresh state, bake it, and return the published bake plus the canonical
 *  save. One `State` per call, read out before the next is built: `samples`/`bakeOut` are
 *  module-level maps keyed by raw entity id and two fresh `State`s both start at 1, so a second
 *  state built first would alias the slot and make the comparison vacuous (`doc.test.ts` names
 *  the same hazard). */
function cycle(text: string): { bake: ReturnType<typeof baked>; save: string } {
    const state = new State();
    state.addSystem(BakeSystem);
    loadDocument(state, text);
    state.step(0);
    const eid = trackEntity(state);
    if (eid === null) throw new Error("no track after load");
    return { bake: baked(eid), save: saveDocument(state) };
}

const names = corpus();

test("the corpus is whole", () => {
    // pin the population: a narrowed or empty scan must not read as a clean sweep.
    expect(names.length).toBeGreaterThanOrEqual(24);
});

for (const name of names) {
    test(`${name}: load → bake → save → load → bake is byte-identical`, () => {
        const text = readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
        const first = cycle(text);
        const second = cycle(first.save);
        expect(second.bake).toEqual(first.bake);
        // the wire is a fixed point, so the identity above is not bought by a save that keeps
        // drifting toward whatever the loader happens to accept.
        expect(second.save).toBe(first.save);
        // and a real bake happened — an empty one would satisfy every equality above.
        expect(first.bake.count).toBeGreaterThan(1);
    });
}
