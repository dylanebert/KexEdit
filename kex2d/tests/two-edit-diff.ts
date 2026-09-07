/** the human-read artifact `kex2d-serialization` S2's Validation names: save → two isolated
 *  setter edits → save, diffed — proof a document diff reads as the edits made, not as a
 *  reshuffled file. Run: `bun run tests/two-edit-diff.ts` (no `package.json` script, same
 *  invoked-by-path convention as `tests/mint-goldens.ts`, `coding.md` Suite speed).
 *
 *  The two edits are deliberately unrelated fields on unrelated rows — a `Track` authored scalar
 *  (`friction`) and one lane record's exit handle — so a correct diff shows exactly two changed
 *  lines and nothing else moves (stable id ordering, `doc.ts`'s own Locked-decision emitter
 *  discipline: a value edit is a one-line diff). */

import { State } from "@dylanebert/shallot";
import { saveDocument } from "../src/doc";
import { Lane } from "../src/lanes";
import { BakeSystem, createRecord, createTrack, setRecordHandle, setV0, Track } from "../src/track";

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

const state = new State();
state.addSystem(BakeSystem);
const eid = createTrack(state);
setV0(state, 18);
const a = createRecord(state, Lane.Force, { start: 0, end: 20, ease: 0, entry: 1, exit: 1.5 });
createRecord(state, Lane.Velocity, { start: 4, end: 12, ease: 0, entry: 14, exit: 14 });
state.step(0);

const before = saveDocument(state);

// edit 1 — a Track authored scalar.
Track.friction.set(eid, 0.04);
// edit 2 — an unrelated record's exit handle, through its own setter (not a raw column write).
setRecordHandle(state, a.id as number, "exit", 2.5);
state.step(0);

const after = saveDocument(state);

console.log(unifiedDiff(before, after));
