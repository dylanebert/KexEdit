# kex2d

Shallot + Svelte + canvas2D prototype. Read the parent entry and rules: `kex2d-map.md` for physics/state/tests, `editor-ui.md` for interaction, `kex2d-harness.md` for capture.

## Model and landed boundary

Three independent **lanes** (velocity, force, geo) hold two-handle segments under one track end. Each changes one parameter over `[start, end)` arclength with named easing, owned exit and optional owned entry. Spans abut, never overlap; gaps infer.

`lanes.ts` holds the laws, `track.ts` the store (`LaneRecord`, `Track.end`/`order`/`v0`), `projection.ts` the derived run partition: lane order is priority, the higher shape lane cuts.

`ADAPTERS.md` is the test-read adapter inventory; it is empty.

Pose UX stays at `retired/pose-ux`: pin mode, canvas authoring, conversion. Timeline: left Select (V)/Add (A) icons, precise handles, Target/unit/easing, disclosed entry/range/diagnostics; no expansion/row Add. `menus.ts`/`keys.ts` share actions. Canvas is read-only; optimize unwired.

Override uses field history; Inherit disowns. Ripple is end-only/same-lane, off per subject. Fields hold measured screen boxes/playhead, not bake; invalidating reflow cancels before refit.

Geo authors PITCH — an absolute unwrapped world heading in radians — over an authored span, the same scalar record shape force uses; both allow arbitrary density, and rates are derived or invoked-fit views, never geometry storage.

The bake is derived, never authored. Cart and timeline share published `ds` stations and unwrapped heading; one recovered reading per lane follows hover, else playhead. Missing coverage/unresolved entries read unavailable; targets stay absolute. Direct authoring is deterministic; optimization is invoked.

The start position is fixed at the origin. Initial speed is the authored `Track.v0` column, falling back to `V0` when absent. Every lane record's stations are track-global arclength and f64; the derived runs carry the run-local frames. `Track.domain` is an undoable display lens: it changes no positions, extents or bake hash.

## Authoring API

`track.ts` alone writes authored lanes: finite stations, origin, overlap and pin guards refuse before writes. Stable ids survive restore; entity ids do not. Legacy neighbors below the authoring floor remain legal.

`history.ts` owns undo: `begin*`/update/commit-or-cancel. `beginRecordEnd` freezes the updater: `record-end {id,end,ripple?}` is independent unless true shifts later same-lane spans atomically. Pin/other lanes hold; refusal keeps the last candidate, cancel restores opening, release records once at most. Stable selection also returns.

`commands.ts`/`cli.ts`: `bun run cli -- new|edit|validate|stats|dump|fmt`. `record-add` requires lane/start/end/exit; omitted entry is unowned, ease Linear. `flatRecordArgs` seeds owned entry=exit without ease, never from bake. `record-handle` entry without value inherits; finite value overrides, exit requires value. `Track.v0` seeds creation, not unresolved velocity entries.

`doc.ts` validates before replacing ECS state; geometry-dependent guards use exact in-place rollback. A refused load leaves the document untouched; a successful load clears undo. Loading owns ECS, not interactive selection: an interactive load must reconcile that too. Never create two live `State`s with overlapping eids: module-scoped component storage aliases. `checkDocumentSemantics` assumes one document per process.

Load/rollback and DEV-only `__kex` fixture setup are not authoring precedents. `tests/purity.test.ts` catches direct `.set` writes, not helper-mediated mutations. `__kex.nudge` uses commands; setup hooks never ship.

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

Unit tests are device-free; run affected `./tests/*.oracle.ts` by path. Quiet composition: `KEX_QUIET=1 bun run capture -- --list -g '<selection>'`, then omit `--list` with a fresh `--out DIR`. This is headless, not native/taste evidence. Automate quietly; native stays human. Follow the capture rule.
