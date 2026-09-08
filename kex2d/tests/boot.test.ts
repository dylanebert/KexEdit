// The boot arm: `src/boot.ts` is the app's OWN document path, so this drives it — not a
// hand-assembled fixture. The defect it holds: `run({ plugins: [TrackPlugin, …] })` creates no
// `Track` entity (TrackPlugin's `initialize` went at S2e-i), so a boot that only iterated
// `ecs.query([Track])` applied no boot op and the app came up with an empty timeline, a greyed
// transport and `__kex.track === -1`. Removing `ensureTrack`'s `createTrack` call reds every
// arm below.
//
// `main.ts` itself imports Svelte and cannot be imported here, so the composition arm reads its
// boot line: that the DEV branch binds `bootTrack(ecs, history)`, the non-DEV branch
// `ensureTrack(ecs)`, and that no query-only boot survives.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { State } from "@dylanebert/shallot";
import { BOOT_OPS, bootTrack, ensureTrack } from "../src/boot";
import { createHistory } from "../src/history";
import { BakeSystem, bakeOut, lanesOf, Track, trackEntity } from "../src/track";

/** a fresh world with the bake system registered — what `run(…)` hands `main.ts`, minus the
 *  render/cart plugins nothing here reads. One live `State` at a time: component storage is
 *  module-scoped (`kex2d/AGENTS.md`), so each arm builds and drops its own. */
function world(): State {
    const ecs = new State();
    ecs.addSystem(BakeSystem);
    return ecs;
}

/** every entity carrying `Track`, so an arm can pin the COUNT and not just "at least one". */
function trackEids(ecs: State): number[] {
    return [...ecs.query([Track])];
}

describe("boot document", () => {
    test("a bare plugin world carries no track, which is the defect's premise", () => {
        const ecs = world();
        expect(trackEids(ecs)).toHaveLength(0);
        expect(trackEntity(ecs)).toBeNull();
    });

    test("ensureTrack allocates exactly one track and is idempotent", () => {
        const ecs = world();
        const first = ensureTrack(ecs);
        expect(trackEids(ecs)).toEqual([first]);
        expect(ensureTrack(ecs)).toBe(first);
        expect(trackEids(ecs)).toEqual([first]);
    });

    test("the non-DEV boot leaves a live, empty document — not a dead panel", () => {
        const ecs = world();
        const track = ensureTrack(ecs);
        ecs.step(0);
        const lanes = lanesOf(ecs);
        expect([lanes.velocity, lanes.force, lanes.geo].map((rows) => rows.length)).toEqual([
            0, 0, 0,
        ]);
        expect(Track.count.get(track)).toBe(0);
        expect(bakeOut.get(track)).toBeDefined();
    });

    test("the DEV boot authors one record per lane over one track", () => {
        const ecs = world();
        const track = bootTrack(ecs, createHistory());

        expect(trackEids(ecs)).toEqual([track]);

        const lanes = lanesOf(ecs);
        expect([lanes.velocity, lanes.force, lanes.geo].map((rows) => rows.length)).toEqual([
            1, 1, 1,
        ]);
        expect(lanes.velocity.length + lanes.force.length + lanes.geo.length).toBe(
            BOOT_OPS.filter((op) => op.type === "record-add").length,
        );
    });

    test("the DEV boot bakes to a track with real extent and duration", () => {
        const ecs = world();
        const track = bootTrack(ecs, createHistory());
        ecs.step(0);
        expect(Track.count.get(track)).toBeGreaterThan(0);
        expect(bakeOut.get(track)?.tTotal).toBeGreaterThan(0);
    });

    test("the DEV fixture is the document's starting state, not an edit", () => {
        const h = createHistory();
        bootTrack(world(), h);
        expect(h.undo).toHaveLength(0);
        expect(h.redo).toHaveLength(0);
    });

    test("bootTrack reuses a track the world already carries rather than adding a second", () => {
        const ecs = world();
        const existing = ensureTrack(ecs);
        expect(bootTrack(ecs, createHistory())).toBe(existing);
        expect(trackEids(ecs)).toEqual([existing]);
    });
});

describe("main.ts boot composition", () => {
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

    test("the boot binds boot.ts on both branches", () => {
        expect(main).toContain(
            "const track = import.meta.env.DEV ? bootTrack(ecs, history) : ensureTrack(ecs);",
        );
        expect(main).toContain('import { bootTrack, ensureTrack } from "./boot";');
    });

    test("no query-only boot survives, and the ops live in boot.ts alone", () => {
        expect(main).not.toContain("ecs.query([Track])");
        expect(main).not.toContain("applyOp");
        expect(main).not.toContain("BOOT_OPS");
    });
});
