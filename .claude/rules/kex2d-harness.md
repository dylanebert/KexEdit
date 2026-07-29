---
paths:
    - "kex2d/harness/**/*"
    - "kex2d/tests/harness.test.ts"
---

# kex2d Capture Harness

Conventions for `kex2d/harness/` (Playwright flows over the real UI, `bun run capture`). Each
law below was earned by a root-caused flake or a live defect — they are why the suite is fast
AND honest. Structure + install story: `kex2d/AGENTS.md` "Verify".

## Iteration discipline

- Iterate selective: `bun run capture -- -g "<pattern>"` (~5s). Full suite at commit (~20s at
  the default 4 headless workers).
- One capture at a time per port: `KEX_PORT`/`KEX_STAGE` isolate a concurrent session; the
  default port is first-come.
- Prefer extending an existing flow over booting a new page (~3–5s per boot). The full suite
  stays inside the 45s budget as it grows.
- Selective iterations write to a separate `--out` dir; the reference shot set
  (`harness/shots/`, `RUN.json` `reference: true`) comes only from full default-knob runs.
  A selective run into the default dir merges shots over the set and honestly demotes it to
  `reference: false` — re-earn the stamp with one full run.

## Flow-authoring laws

- **The settle idiom.** Exactly one fixed wait exists: `SHOT_MS`, on the line immediately
  before a screenshot. Everything else is a condition (`expect.poll`, locator asserts) — and
  where a value is projected by the per-RAF tick, the honest wait is awaiting *frames in the
  page* (a double-rAF per frame), not milliseconds.
- **A count is never bake-readiness.** A `__kex` poke and every snapshot restore write authored
  components synchronously, but the bake's node→sample map rebuilds on the *next* frame —
  `nodeCount` and `tTotal > 0` are satisfied pre-bake, so a gesture placed on that evidence
  reads the previous track. Wait on bake output actually changing (e.g. `nodePoint` off the
  track origin). Reads only: app ops resolve their geometry from authored state, never the bake,
  so a flow never needs a settle *between* invocations — a wait papering over a bake-read is a
  workaround for an app defect, not a law.
- **A negative assert needs a positive control.** A "no-op" or "revert" check against a state
  already equal to its target passes vacuously — an unguarded mid-gesture `F` against the
  boot-time frame, a revert assert on an undisplaced drag. First prove the rig detects change
  (displace the camera off its fit target, assert the drag moved the point), then assert the
  guard/revert.
- **Pin both layers before a layered dismissal.** Escape peels exactly one rung (menu → sub-mode →
  selection), so a flow that presses it must first wait the rung above OFF (`.nodemenu` count 0 — a
  menu still mounted swallows the key in capture phase) and assert the rung it means to peel is
  still ON. Neither is a formality: without the first the press is eaten, and without the second a
  green run can be peeling a rung the flow never meant to name.
- **Never drive a pointer through a box cached across an edit or undo.** After a respawning
  restore, re-locate through the bake-ready reader (`nodePoint`); after an in-place restore
  (`restoreNodes` — no respawn, so off-origin polls are vacuously true), poll the live position
  back within 1px of the cached value. A ring/knob predicate is the exact orbit
  (`|dist − RADIAL_R| < 2`), never a reach radius.
- **The pageerror gate.** The `boot` fixture attaches `pageerror` *before* navigation and fails
  every flow on an uncaught page exception at teardown. Console errors are deliberately
  uncollected (lab favicon-404 noise). The listener-before-`goto` ordering is enforced by a
  standing pin: flow 1 of `shot.pw.ts` (`test.fail` + a boot-time `addInitScript` throw) goes
  red if the listener moves after `goto` or the injection is removed. Its verdict is inverted —
  a green run prints that flow with the failure mark, and skipping it still fails the run —
  don't "fix" either.
- **A multi-flow red is presumptively host-level.** Unrelated flows failing together in one
  full run (observed ~1/18; never reproduced in isolation or ×12 consecutive) is a run-level
  signature on the shared GPU bridge — re-run once before debugging any flow; if it recurs,
  keep `RUN.json` + the reporter output.

## Verifier integrity

- **The suite-count oracle.** A green suite is evidence only when `--list`-collected equals
  summary-accounted (+ `forbidOnly`); a truncated run fails, never passes with survivors green.
  A skip also fails: a would-be reference run with `skipped > 0` exits nonzero, `reference:
  false` — a stray `test.skip` can't drop coverage silently. `RUN.json` carries per-category
  `counts` and `failedTitles` (parsed from run stdout in `args.ts`) for flake forensics.
- **The wipe guard.** `RUN.json` is the shot set's provenance stamp AND its wipe permission
  slip: a full run refuses to wipe any `--out` that isn't absent, empty, or `RUN.json`-bearing.
- **Standalone staging.** `shot.pw.ts` + `capture.pw.config.ts` are staged to the Windows host
  as a set and may import nothing *outside the staged set*. Shared validators are duplicated
  verbatim, pinned character-identical AND pinned reached by unit tests (hand-written copies
  drifted once); mirrored app constants live in the MIRRORED block, each naming its source.
- **Growth.** Past ~28 flows (the 420 s `globalTimeout` ceiling at 4 workers — the binding
  number; 25 today), split `shot.pw.ts` into staged flow files + one staged helpers
  module (`testMatch` glob + `stage.files`) — the single file is habit, not a constraint. The
  `__kex` DEV surface (~15 members on `any`) earns a typed interface at the same moment.
