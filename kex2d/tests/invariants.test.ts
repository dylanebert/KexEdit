import { describe, expect, test } from "bun:test";
import { State } from "@dylanebert/shallot";
import {
    CURRENT_VERSION,
    checkDocumentSemantics,
    loadDocument,
    parseDocument,
    saveDocument,
} from "../src/doc";
import { BakeSystem, snapshotAll, trackEntity } from "../src/track";

// the document-boundary invariant validation: `parseDocument`'s
// structural pass lets through a well-SHAPED document that violates an authoring invariant the
// live setters enforce — `restoreAll`'s spawn path deliberately bypasses every one of those
// guards (in-session undo snapshots are already-validated state), so a hand-authored `.kex`
// file breaking one used to load silently. This suite is the census's own oracle: one red/green
// fixture pair per named invariant, the red side refused by NAME (not just "it threw"), the
// green side (one shared valid baseline, `valid-green.kex`) loading clean.

/** every invariant name this stage closes, matching `checkDocInvariants`/`checkGeometryInvariants`
 *  (`src/doc.ts`) guard names 1:1 — the fixture file `tests/fixtures/invariants/<name>-red.kex`
 *  is named after the guard it trips. */
const INVARIANTS = [
    "emptyTrack",
    "duplicateId",
    "segmentOverlapped",
    "segmentDegenerate",
    "laneOrder",
    "validStripValue",
    "validCoefficient",
    "minStartSpeed",
    "minExtentFloor",
] as const;

async function readFixture(name: string): Promise<string> {
    const url = new URL(`./fixtures/invariants/${name}`, import.meta.url);
    return Bun.file(url).text();
}

describe("document-boundary invariant validation: red fixtures", () => {
    for (const name of INVARIANTS) {
        test(`${name}: refused by name, live document untouched`, async () => {
            const text = await readFixture(`${name}-red.kex`);
            // every surviving guard is semantic: the v4 wire's structural pass reads shapes,
            // and the lane laws are read over the parsed document.
            const refusals = checkDocumentSemantics(parseDocument(text));
            expect(refusals.length).toBeGreaterThan(0);
            expect(refusals.map((r) => r.guard)).toContain(name);

            // and `loadDocument` refuses the same way, naming the guard in its thrown message,
            // touching an existing live document not at all (the green baseline pre-loaded).
            const state = new State();
            state.addSystem(BakeSystem);
            const green = await readFixture("valid-green.kex");
            loadDocument(state, green);
            const before = snapshotAll(state);
            const beforeEid = trackEntity(state);

            expect(() => loadDocument(state, text)).toThrow(new RegExp(name));
            expect(snapshotAll(state)).toEqual(before);
            expect(trackEntity(state)).toBe(beforeEid);
        });
    }

    test("a refused load creates no track entity in an empty ECS", async () => {
        const text = await readFixture("emptyTrack-red.kex");
        const state = new State();
        state.addSystem(BakeSystem);
        expect(() => loadDocument(state, text)).toThrow(/emptyTrack/);
        expect(trackEntity(state)).toBeNull();
    });
});

describe("document-boundary invariant validation: the shared green fixture", () => {
    test("valid-green.kex carries no violated invariant and loads clean", async () => {
        const text = await readFixture("valid-green.kex");
        const doc = parseDocument(text);
        expect(checkDocumentSemantics(doc)).toEqual([]);

        const state = new State();
        state.addSystem(BakeSystem);
        expect(() => loadDocument(state, text)).not.toThrow();
        expect(trackEntity(state)).not.toBeNull();
    });

    test("valid-green.kex round-trips (saveDocument(loadDocument(text)) === text)", async () => {
        const text = await readFixture("valid-green.kex");
        const state = new State();
        state.addSystem(BakeSystem);
        loadDocument(state, text);
        const migrated = saveDocument(state);
        expect(JSON.parse(migrated).version).toBe(CURRENT_VERSION);
        expect(JSON.parse(migrated).lanes).toBeObject();
        const state2 = new State();
        state2.addSystem(BakeSystem);
        loadDocument(state2, migrated);
        expect(saveDocument(state2)).toBe(migrated);
    });
});

describe("checkDocumentSemantics: the exported validation entry point", () => {
    test("skips the geometry pass when the doc-level pass already found something", async () => {
        // two records racing for one stable id would make a scratch ECS load ambiguous — the
        // geometry pass must not run over it, so the doc-level refusal is what comes back.
        const text = await readFixture("duplicateId-red.kex");
        const refusals = checkDocumentSemantics(parseDocument(text));
        expect(refusals.map((r) => r.guard)).toEqual(["duplicateId"]);
    });

    test("a document with no violations returns an empty refusal list", async () => {
        const text = await readFixture("valid-green.kex");
        expect(checkDocumentSemantics(parseDocument(text))).toEqual([]);
    });
});
