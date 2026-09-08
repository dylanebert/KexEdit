/** the app's boot document, headless.
 *
 *  `run({ plugins: [TrackPlugin, …] })` registers the `Track` component and the `BakeSystem`; it
 *  creates no entity. So the boot itself owns the document: `ensureTrack` allocates the one empty
 *  `Track` entity every track-scalar read resolves through (`track.ts trackEntity`), and until a
 *  file surface exists that empty track is what a non-DEV boot shows — an empty timeline over a
 *  live end handle, not a dead panel with no entity behind it.
 *
 *  `bootTrack` adds the DEV fixture on top: ONE mixed track authored through `applyOp`, the same
 *  op vocabulary the CLI drives, so this is not a second authoring path. It is the S4 mixed
 *  track, and the surface the person's check-in reads. Never ships: kex2d is a `defaults:false`
 *  prototype with a DEV branch only.
 *
 *  Both live here rather than in `main.ts` so a check can drive the real boot path against a
 *  fresh `State` without importing Svelte. Per `kex2d/AGENTS.md`, component storage is
 *  module-scoped: never hold two live `State`s with overlapping eids around one call. */

import type { State } from "@dylanebert/shallot";
import { applyOp, type Op } from "./commands";
import type { History } from "./history";
import { createTrack, Track } from "./track";

/** the dev boot track, as ops: a 20 m pitch rise, a force span carrying its tail past it, a
 *  velocity prescription over the head, and the end left following the longest lane. */
export const BOOT_OPS: readonly Op[] = [
    { type: "start-speed", value: 16 },
    { type: "record-add", lane: "geo", start: 0, end: 20, ease: 1, entry: 0, exit: 0.35 },
    { type: "record-add", lane: "force", start: 14, end: 54, ease: 0, entry: 1, exit: 2.5 },
    { type: "record-add", lane: "velocity", start: 4, end: 14, ease: 1, entry: 18, exit: 24 },
];

/** the one empty `Track` entity, allocated if the world has none. Idempotent: a world that
 *  already carries a track (a loaded document) keeps it. */
export function ensureTrack(ecs: State): number {
    for (const eid of ecs.query([Track])) return eid;
    return createTrack(ecs);
}

/** the DEV boot: the empty document plus `BOOT_OPS`. The fixture is the document's starting
 *  state, not an edit, so undo has nothing before it. Returns the track entity. */
export function bootTrack(ecs: State, h: History): number {
    const track = ensureTrack(ecs);
    for (const op of BOOT_OPS) applyOp(ecs, h, op);
    h.undo.length = 0;
    h.redo.length = 0;
    return track;
}
