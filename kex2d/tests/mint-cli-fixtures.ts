/** Mints the CLI's committed `.kex` fixture corpus, invoked by path
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
    spliceGeoMembers,
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
    spliceGeoMembers(state, sec);
    createOneShot(state, s.v0);
    state.step(0);
    return saveDocument(state);
}

/** the one scenario that mints no committed v4 fixture: its Mirror tangents sit at the bezier
 *  control offset where `spline.hermite` reads a velocity, so the claimed circle bakes ~1 m
 *  near-cusps that no ≥1 m pitch record represents and `migrations[3]` refuses it at the record
 *  floor (spec `kex2d-segment-gestures` Validation 2 and 9). Its frozen v3 file stays under
 *  `tests/fixtures/v3/cli/` as the live refusal witness, and the scenario itself stays in
 *  `scenarios.ts` for the locked goldens. */
const REFUSED = "loop-explicit";

for (const s of scenarios) {
    if (s.name === REFUSED) {
        console.log(`skipped ${s.name}.kex (refused by migrations[3] at the record floor)`);
        continue;
    }
    const path = new URL(`./fixtures/cli/${s.name}.kex`, import.meta.url);
    await Bun.write(path, scenarioDocument(s));
    console.log(`minted ${s.name}.kex`);
}
