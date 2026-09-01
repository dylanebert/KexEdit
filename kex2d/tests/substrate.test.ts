import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// S1's structural oracle (kex2d-selection-substrate spec, Validation S1): a committed source
// query — NOT a behavioral sample — asserting the substrate's structural shape:
//  (a) zero `exclusive*` function definitions in `src/editor.ts` (the family is deleted, not
//      repaired — its observable preserved by replace-select clearing all members);
//  (b) exactly one `_members` Map declaration by that literal name — the unified container.
//      the arm is name-anchored: a second module-level container under any other name is NOT
//      caught, and a reintroduced per-kind *data* field typechecks cleanly (TS interfaces do
//      not distinguish accessor from data property, so the `EditorState` interface alone cannot
//      block `nodes: Selection` as storage alongside the getter). the arm enforces what a
//      literal-name source query can; the rest is a type-system gap, not a structural claim;
//  (c) the old storage primitives are gone: `emptySel`, `clearSel`, and `rebuild` are deleted,
//      so a reintroduced `nodes: emptySel()` is a compile error. the per-kind accessors are
//      getters over the unified set, not stored fields.
//
// Runs in the default `bun test` gate: a source query, not a behavioral arm.

const src = readFileSync(join(import.meta.dir, "..", "src", "editor.ts"), "utf8");

describe("kex2d-selection-substrate S1: structural oracle", () => {
    test("(a) zero `exclusive*` function definitions in editor.ts", () => {
        // the six deleted functions: exclusiveNode, exclusiveForce, exclusiveSection,
        // exclusiveStrip, exclusiveOneShot, exclusiveStripKf — each was a `function exclusive*`
        // definition. none survive.
        const exclusiveDefs = src.match(/\bfunction\s+exclusive\w+\s*\(/g);
        expect(exclusiveDefs).toBeNull();
    });

    test("(a) no `exclusive*` call sites remain in editor.ts", () => {
        // the 18 call sites are all gone too — a surviving call would be a compile error
        // (the function is deleted), but the source query closes it structurally.
        const exclusiveCalls = src.match(
            /\bexclusive(Node|Force|Section|Strip|OneShot|StripKf)\s*\(/g,
        );
        expect(exclusiveCalls).toBeNull();
    });

    test("(b) exactly one selection container declared — the unified `_members` Map", () => {
        // the unified storage: one Map<string, Member> + one _active. the five per-kind
        // Selection records (nodes/forces/sections/strips/stripKfs) are no longer storage.
        // the match is name-anchored on the literal token `_members` — a second container under
        // any other name is NOT caught (see the header comment for the honest scope).
        const memberMaps = src.match(/const\s+_members\s*=\s*new\s+Map\s*</g);
        expect(memberMaps?.length).toBe(1);
    });

    test("(b) no per-kind `Selection` storage fields initialized on the editor object", () => {
        // the old form: `nodes: emptySel(),` etc. — these are gone. the editor object
        // initializes `nodes`/`forces`/etc. as getters, not stored Selection records.
        const storedSels = src.match(
            /^\s*(nodes|forces|sections|strips|stripKfs)\s*:\s*emptySel\(\)/gm,
        );
        expect(storedSels).toBeNull();
    });

    test("(c) `emptySel` is not defined — a reintroduced per-kind container is a compile error", () => {
        // `emptySel` was the factory that initialized the per-kind Selection records. it is
        // deleted, so a reintroduced `nodes: emptySel()` fails at compile time — the type that
        // made siloing representable no longer exists as a storage initializer.
        const emptySelDef = src.match(/\bfunction\s+emptySel\s*\(/g);
        expect(emptySelDef).toBeNull();
    });

    test("(c) `clearSel` is not defined — the old exclusive-sweep primitive is gone", () => {
        // `clearSel` was the per-kind clear the `exclusive*` family called. it is deleted,
        // so the old pattern cannot be reconstructed without reintroducing it.
        const clearSelDef = src.match(/\bfunction\s+clearSel\s*\(/g);
        expect(clearSelDef).toBeNull();
    });

    test("(c) `rebuild` (the per-kind restore helper) is not defined", () => {
        // `rebuild` mutated a stored Selection in place for the selectionHook restore path.
        // it is deleted — the restore path now operates on the unified set directly.
        const rebuildDef = src.match(/\bfunction\s+rebuild\s*\(/g);
        expect(rebuildDef).toBeNull();
    });

    test("the unified `SelKind` type and `Member` interface are exported", () => {
        // the typed subject reference — the one shape a selection member takes.
        expect(src).toMatch(/export\s+type\s+SelKind\s*=/);
        expect(src).toMatch(/export\s+interface\s+Member\s*\{/);
    });

    test("the per-kind accessors are getters over the unified set, not stored fields", () => {
        // `get nodes()`, `get forces()`, etc. — derived reads, not storage.
        for (const field of ["nodes", "forces", "sections", "strips", "stripKfs"]) {
            expect(src).toMatch(new RegExp(`get\\s+${field}\\s*\\(\\s*\\)\\s*:\\s*Selection`));
        }
        // `start` and `oneShot` are getters too — derived from the unified set.
        expect(src).toMatch(/get\s+start\s*\(\s*\)\s*:\s*boolean/);
        expect(src).toMatch(/get\s+oneShot\s*\(\s*\)\s*:\s*boolean/);
    });
});
