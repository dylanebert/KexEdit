/** Mints the CLI's committed `.kex` fixture corpus (spec `kex2d-cli` S3), invoked by path
 *  (`bun run tests/mint-cli-fixtures.ts`, no `package.json` script — `coding.md` Suite speed,
 *  `tests/mint-goldens.ts`'s own precedent). Every fixture is a geo section carrying one
 *  `scenarios.ts` node list, exactly `tests/doc.test.ts`'s own `scenarioTrack` shape — authored
 *  literals only (node positions/thetas/tangents, `ds`, the entry-speed one-shot), never a bake
 *  result, so unlike the physics goldens this corpus is platform-independent: minting on any
 *  machine reproduces the same bytes (`saveDocument`'s canonical emitter is a pure function of
 *  the authored ECS state). Re-running this script over a clean tree must leave `git diff`
 *  empty — the same reproducibility contract `mint-goldens.ts` owes its own fixtures. */

import { State } from "@dylanebert/shallot";
import { saveDocument } from "../src/doc";
import { scenarios } from "../src/scenarios";
import {
    BakeSystem,
    createOneShot,
    createSection,
    createTrack,
    SectionKind,
    spawnNode,
    Track,
} from "../src/track";

function scenarioDocument(s: (typeof scenarios)[number]): string {
    const state = new State();
    state.addSystem(BakeSystem);
    const eid = createTrack(state);
    Track.ds.set(eid, s.ds);
    const sec = createSection(state, 0, SectionKind.Geo, 0);
    s.nodes.forEach((n, i) => {
        spawnNode(state, sec, i, n.x, n.y, n.theta, n.tangent);
    });
    createOneShot(state, s.v0);
    state.step(0);
    return saveDocument(state);
}

for (const s of scenarios) {
    const path = new URL(`./fixtures/cli/${s.name}.kex`, import.meta.url);
    await Bun.write(path, scenarioDocument(s));
    console.log(`minted ${s.name}.kex`);
}
