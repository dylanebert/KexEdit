---
paths:
    - "kex2d/harness/**/*"
    - "kex2d/tests/harness.test.ts"
---

# kex2d Capture Harness

Conventions for `kex2d/harness/` (Playwright flows over the real UI, `bun run capture`). Each
law below was earned by a root-caused flake or a live defect — they are why the suite is fast
AND honest. Structure + install story: `kex2d/CLAUDE.md` "Verify".

## Iteration discipline

- Iterate selective: `bun run capture -- -g "<pattern>"` (~5s). Full suite at commit (~20s at
  the default 4 headless workers).
- One capture at a time per port: `KEX_PORT`/`KEX_STAGE` isolate a concurrent session; the
  default port is first-come.
- Prefer extending an existing flow over booting a new page (~3–5s per boot). The full suite
  stays inside the 45s budget as it grows.
- Selective iterations write to a separate `--out` dir; the reference shot set
  (`harness/shots/`, `RUN.json` `reference: true`) comes only from full default-knob runs.

## Flow-authoring laws

- **The settle idiom.** Exactly one fixed wait exists: `SHOT_MS`, on the line immediately
  before a screenshot. Everything else is a condition (`expect.poll`, locator asserts) — and
  where a value is projected by the per-RAF tick, the honest wait is awaiting *frames in the
  page* (a double-rAF per frame), not milliseconds.
- **A count is never bake-readiness.** A `__kex` poke and every snapshot restore write authored
  components synchronously, but the bake's node→sample map rebuilds on the *next* frame —
  `nodeCount` and `tTotal > 0` are satisfied pre-bake, so a gesture placed on that evidence
  reads the previous track. Wait on bake output actually changing (e.g. `nodePoint` off the
  track origin). It binds the WRITE side too: an op that *resolves* through the bake needs the
  same wait between consecutive invocations, not only before a pointer lands — two arrow-nudges
  inside one frame both read the same stale `nodeWorld` frame and the second overwrites the first
  (measured: a right-then-left pair landed a step short of where it started).
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
  every flow on an uncaught page exception at teardown (proven red by injection). Console
  errors are deliberately uncollected (lab favicon-404 noise). Moving the listener after `goto`
  silently exempts boot-time crashes — don't.
- **A multi-flow red is presumptively host-level.** Unrelated flows failing together in one
  full run (observed ~1/18; never reproduced in isolation or ×12 consecutive) is a run-level
  signature on the shared GPU bridge — re-run once before debugging any flow; if it recurs,
  keep `RUN.json` + the reporter output.

## Verifier integrity

- **The suite-count oracle.** A green suite is evidence only when `--list`-collected equals
  summary-accounted (+ `forbidOnly`); a truncated run fails, never passes with survivors green.
  Known soft spot: `skipped` counts as accounted, so a stray `test.skip` drops coverage with
  every gate green.
- **The wipe guard.** `RUN.json` is the shot set's provenance stamp AND its wipe permission
  slip: a full run refuses to wipe any `--out` that isn't absent, empty, or `RUN.json`-bearing.
- **Standalone staging.** `shot.pw.ts` + `capture.pw.config.ts` are staged to the Windows host
  as a set and may import nothing *outside the staged set*. Shared validators are duplicated
  verbatim, pinned character-identical AND pinned reached by unit tests (hand-written copies
  drifted once); mirrored app constants live in the MIRRORED block, each naming its source.
- **Growth.** Past ~30 flows, split `shot.pw.ts` into staged flow files + one staged helpers
  module (`testMatch` glob + `stage.files`) — the single file is habit, not a constraint.
