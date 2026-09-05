# kex2d

Shallot + Svelte + canvas2D prototype. Read the parent entry and rules: `kex2d-map.md` for physics/state/tests, `editor-ui.md` for interaction, `kex2d-harness.md` for capture.

## Model and landed boundary

The authored track is an open geo/force **segment chain**, without branching or circuit closure. A segment owns its terminating boundary; its start reads the predecessor or `TrackStart`. `track.ts` owns canonical `Segment`, geometry and force-boundary storage. `projection.ts` derives evaluator runs over contiguous members; conserved run stations and extent must not be reconstructed by summing member lengths.

`Section` and section-facing APIs remain compatibility, not a second authored model. `ADAPTERS.md` is the test-read inventory of remaining adapters.

Flat v3 serialization and canonical force command/gesture paths have landed. Geometry, velocity and section-facing interaction still include migration adapters: do not infer that every viewport/timeline gesture has migrated from the canonical wire format or from pure `segment.ts` operations. Read callers in `commands.ts`, `history.ts`, `controls.ts` or `Timeline.svelte`.

Geo authors positions and optional tangents; force authors values and named easing. Both substrates allow arbitrary density; rates are derived or invoked-fit views, never geometry storage.

The dense bake is **derived display**, never canonical authored state. Both kinds display geometry-recovered force, not demanded force or a smoothed substitute; cart and timeline read the same bake. Direct authoring is deterministic, not a unified intent-arbitrating solver. Optimization is only a scoped, invoked tool; both conversion directions exist. Destructive kind reset and fitted conversion are different operations.

The start position is fixed at the origin. Initial speed reads the track-start `OneShot`, falling back to `V0`, not a `Track.v0` field or the first strip. Velocity strips/keyframes are track-global arclength spans, independent of segment kind and structural edits. Force stations and geometry retain their run/local frames. `Track.domain` is an undoable display lens: it changes no positions, extents or bake hash. Time gestures project through a frozen arclength↔time mapping.

## Authoring API

`track.ts` owns authored ECS state; `history.ts` owns snapshot/gesture edits. Use the existing setters inside history gestures, never write authored components from render/read paths or invent a UI-local copy. Structural helpers bracket internally; continuous edits use `begin*`, setter, then `commit` or `cancel`. Read signatures. Stable ids/addresses survive restore; raw entity ids do not.

`src/cli.ts` drives `src/commands.ts` over `.kex` JSON: `bun run cli -- new|edit|validate|stats|dump|fmt ...`. Derive operation payloads from the command types and CLI help. Commands share UI setters/history and report refusals.

`doc.ts` validates before replacing ECS state; geometry-dependent guards use exact in-place rollback. A refused load leaves the document untouched; a successful load clears undo. Loading owns ECS, not interactive selection or the conversion provenance cache: an interactive load must reconcile those too. Never create two live `State`s with overlapping eids: module-scoped component storage aliases. `checkDocumentSemantics` assumes one document per process.

`doc.ts` load/rollback and DEV-only `__kex` bulk fixture setup are exceptions to ordinary edit gestures, not authoring precedents. `tests/purity.test.ts` catches direct component `.set` writes, not every helper-mediated mutation. `__kex.nudge` uses the command path; setup hooks never ship.

One selection set plus active member lives in `editor.ts`; per-kind accessors are derived, not separate storage. Route selection keys by `activeKind()`, surface keys by hover; enumerate every window keydown reader when changing routing. Mixed force/velocity sets share station motion but no value axis. Preserve byte-identical undo, including selection re-resolution and pin-mode sandbox restoration.

## Verify

From `kex2d/`, serially:

```sh
bun run test
bun run check
bun run surface-budget
```

Install app dependencies with `bun install --frozen-lockfile` when missing; inspect any locally wired Shallot package before replacing it. `check` provisions only harness dependencies, then runs `tsc`, `svelte-check` and one read-only `biome check`. `bun run format` is the separate writer.

Local `node_modules/.bin/tsc` resolves to `@typescript/native`; `svelte-check` resolves JavaScript `typescript` for compiler APIs including `ts.sys`. Keep both; inspect installed resolution/lockfile, not assumed matching patch versions.

Unit tests are device-free. Run affected `./tests/*.oracle.ts` explicitly by path, not as a blanket corpus sweep. `bun run capture` and `bun run mutate` are display-gated; follow the capture rule, serialize the display seat, never kill host processes or start an interactive verification server.
