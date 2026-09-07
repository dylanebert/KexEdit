/** the human-read artifact `kex2d-serialization` S2's Validation names: save → two isolated
 *  setter edits → save, diffed — proof a document diff reads as the edits made, not as a
 *  reshuffled file. Run: `bun run tests/two-edit-diff.ts` (no `package.json` script, same
 *  invoked-by-path convention as `tests/mint-goldens.ts`, `coding.md` Suite speed).
 *
 *  The two edits are deliberately unrelated fields on unrelated entities — a `Track` authored
 *  scalar (`friction`) and a one-shot's `value` — so a correct diff shows exactly two changed
 *  lines and nothing else moves (stable id ordering, `doc.ts`'s own Locked-decision emitter
 *  discipline: a value edit is a one-line diff). */

import { State } from "@dylanebert/shallot";
import { saveDocument } from "../src/doc";
import {
    BakeSystem,
    createOneShot,
    createSection,
    createTrack,
    SectionKind,
    setOneShotValue,
    spawnNode,
    Track,
} from "../src/track";
import { scenarios } from "../src/scenarios";

function unifiedDiff(before: string, after: string): string {
    const a = before.split("\n");
    const b = after.split("\n");
    const out: string[] = [];
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) {
        if (a[i] === b[i]) continue;
        if (a[i] !== undefined) out.push(`-${a[i]}`);
        if (b[i] !== undefined) out.push(`+${b[i]}`);
    }
    return out.join("\n");
}

const s = scenarios.find((x) => x.name === "hill-explicit");
if (!s) throw new Error("scenario not found");

const state = new State();
state.addSystem(BakeSystem);
const eid = createTrack(state);
Track.ds.set(eid, s.ds);
const sec = createSection(state, 0, SectionKind.Geo, 0);
s.nodes.forEach((n, i) => {
    spawnNode(state, sec, i, n.x, n.y, n.theta, n.tangent);
});
const oneShotId = createOneShot(state, s.v0);
state.step(0);

const before = saveDocument(state);

// edit 1 — a Track authored scalar.
Track.friction.set(eid, 0.04);
// edit 2 — an unrelated one-shot's value, through its own setter (not a raw component write).
setOneShotValue(state, oneShotId, 25);
state.step(0);

const after = saveDocument(state);

console.log(unifiedDiff(before, after));
