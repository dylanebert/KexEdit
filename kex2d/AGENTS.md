# kex2d

Shallot + Svelte + canvas2D prototype. Read the parent entry and rules: `kex2d-map.md` for physics/state/tests, `editor-ui.md` for interaction, `kex2d-harness.md` for capture.

## Model and landed boundary

The authored track is three independent **lanes** — velocity, force, geo — of two-handle segments over one track-level end. A segment is one change of one parameter over a `[start, end)` arclength span with a named easing; it owns its exit always and its entry only when the record carries one. Spans abut but never overlap; a gap is the lane's inferred value.

`lanes.ts` holds the laws, `track.ts` the store (`LaneRecord`, `Track.end`/`order`/`v0`), `projection.ts` the derived run partition: lane order is priority, the higher shape lane cuts.

`ADAPTERS.md` is the test-read adapter inventory; it is empty.

The store, the v4 wire, the derived partition and the VERBS have landed; the timeline rebuild has not.

The pose UX is retired to the kexedit tag `retired/pose-ux`: pin mode, canvas control wiring, the conversion UI and every capture flow. Authoring is headless through `commands.ts`/`cli.ts`. `Timeline.svelte` and the canvas draw the bake read-only; `controls.ts` is pan/zoom; `menus.ts`, `keys.ts` and `optimize.ts` are unwired libraries for the lane rebuild. Read the tag, never a copy.

Geo authors PITCH — an absolute unwrapped world heading in radians — over an authored span, the same scalar record shape force uses; both allow arbitrary density, and rates are derived or invoked-fit views, never geometry storage.

The dense bake is **derived display**, never authored state. Both kinds display geometry-recovered force, not demanded force; cart and timeline read the same bake. Direct authoring is deterministic, not an intent-arbitrating solver; optimization is a scoped, invoked tool.

The start position is fixed at the origin. Initial speed is the authored `Track.v0` column, falling back to `V0` when absent. Every lane record's stations are track-global arclength and f64; the derived runs carry the run-local frames. `Track.domain` is an undoable display lens: it changes no positions, extents or bake hash.

## Authoring API

`track.ts` owns authored state; its lane setters are the ONLY authored writers and refuse structurally — an overlap is declined, never clamped. Stable ids survive restore; raw entity ids do not.

`history.ts` owns the verbs: add/delete per lane, handle, edge, body, ease, end, order, start speed. Use the setters inside gestures, never write authored columns from read paths. Structural helpers bracket internally; continuous edits use `begin*`, setter, then `commit` or `cancel`; a declined write records nothing. Read signatures.

`src/cli.ts` drives `src/commands.ts` over `.kex` JSON: `bun run cli -- new|edit|validate|stats|dump|fmt ...`. Ops name a record by the stable id `dump` reports; `record-add` names its lane. `new` migrates the boot seed from v3. Derive payloads from the command types and CLI help. Commands share UI setters/history and report refusals.

`doc.ts` validates before replacing ECS state; geometry-dependent guards use exact in-place rollback. A refused load leaves the document untouched; a successful load clears undo. Loading owns ECS, not interactive selection: an interactive load must reconcile that too. Never create two live `State`s with overlapping eids: module-scoped component storage aliases. `checkDocumentSemantics` assumes one document per process.

`doc.ts` load/rollback and DEV-only `__kex` bulk fixture setup are exceptions to ordinary edit gestures, not authoring precedents. `tests/purity.test.ts` catches direct component `.set` writes, not every helper-mediated mutation. `__kex.nudge` uses the command path; setup hooks never ship.

One selection set plus active member lives in `editor.ts`; per-kind accessors are derived, not separate storage. Preserve byte-identical undo, including selection re-resolution and sandbox restoration.

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
