import { describe, expect, test } from "bun:test";
import { State } from "@dylanebert/shallot";
import { checkDocumentSemantics, loadDocument, parseDocument, saveDocument } from "../src/doc";
import { BakeSystem, snapshotAll, trackEntity } from "../src/track";

// the document-boundary invariant validation (spec `kex2d-cli` S4): `parseDocument`'s
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
    "duplicateSectionOrder",
    "sectionKind",
    "minNodeFloor",
    "nodeZeroOrigin",
    "minForceExtent",
    "stationTaken",
    "validStripValue",
    "stripKeyframeTaken",
    "validCoefficient",
    "minStartSpeed",
    "stripOverlapped",
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
            const doc = parseDocument(text);

            // the guard fires in the pure check function directly, by NAME — not just "some
            // refusal happened" (a wrong-guard false positive would still pass a bare `.toThrow()`).
            const refusals = checkDocumentSemantics(doc);
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
        expect(saveDocument(state)).toBe(text);
    });
});

describe("checkDocumentSemantics: the exported validation entry point", () => {
    test("skips the geometry pass when the doc-level pass already found something", async () => {
        // duplicateId planted on the section category would make a scratch ECS load ambiguous
        // (two entities racing for one stable id) — the geometry pass must not run over it.
        const text = await readFixture("duplicateId-red.kex");
        const doc = parseDocument(text);
        const refusals = checkDocumentSemantics(doc);
        expect(refusals).toEqual([{ guard: "duplicateId", message: expect.any(String) }]);
    });

    test("a document with no violations returns an empty refusal list", async () => {
        const text = await readFixture("valid-green.kex");
        expect(checkDocumentSemantics(parseDocument(text))).toEqual([]);
    });
});
