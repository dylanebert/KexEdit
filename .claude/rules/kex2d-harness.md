---
paths:
    - "kex2d/harness/**/*"
    - "kex2d/tests/harness.test.ts"
---

# kex2d Capture Harness

Conventions for `kex2d/harness/` (Playwright flows over the real UI, `bun run capture`). Each
law below was earned by a root-caused flake or a live defect — they are why the suite is fast
AND honest.

## Structure

`harness/` is the Playwright harness: `bun run capture` → `harness/shots/` (gitignored). The geo
and force authoring-flow tests drive the real UI (seed → extend/convert → author → undo) and
assert `window.__kex` state via `expect.poll` (no sleeps); the lab tests screenshot the atom
pages (`geometry-lab.html`, `collocate-lab.html`, `loop-lab.html`, `fvd-lab.html`,
`fit-lab.html`). It drives the host's **real-GPU Chrome via the WSL→Windows bridge** (shallot's
`run()` acquires a WebGPU device even though kex2d is canvas2D). Display-gated.

It's a **sub-package with its own `package.json` + committed `bun.lock`** — Playwright is declared
there, not in the app. `bun check` self-provisions it: the `harness:deps` script installs
`--cwd harness --frozen-lockfile` when `harness/node_modules` is missing, so a fresh clone or
worktree type-checks without a manual step. **Never fix a missing `@playwright/test` with a root
`bun install`**: that replaces the `node_modules/@dylanebert/shallot` dev symlink with npm shallot
and the app stops mounting.

The harness code IS under the project `tsconfig` + `biome`. Its pure pieces — `args.ts`'s CLI/env
validators and the `--out` wipe guard, `wsl.ts`'s provisioning key — are unit-tested in
`kex2d/tests/harness.test.ts`. What may cross the staging boundary is Verifier integrity's
"Standalone staging", below.

## Iteration discipline

- Iterate selective: `bun run capture -- -g "<pattern>"` (~5s). Full suite at commit runs at
  whatever `KEX_WORKERS` resolves to (default 4) — its wall clock is a function of flow count
  and worker count, so time it locally (`KEX_WORKERS=1 bun run capture` for the worst case)
  rather than trust a quoted figure, which rots as flows are added.
- One capture at a time per port: `KEX_PORT`/`KEX_STAGE` isolate a concurrent session; the
  default port is first-come.
- Prefer extending an existing flow over booting a new page (~3–5s per boot). The full suite's
  budget is the `globalTimeout` ceiling below ("Growth landed"), not a fixed wall-clock number —
  re-time it as flows grow rather than quoting one.
- Selective iterations write to a separate `--out` dir; the reference shot set
  (`harness/shots/`, `RUN.json` `reference: true`) comes only from full default-knob runs.
  A selective run into the default dir merges shots over the set and honestly demotes it to
  `reference: false` — re-earn the stamp with one full run.

## Flow-authoring laws

- **The settle idiom.** Exactly one fixed wait exists: `SHOT_MS`, on the line immediately
  before a screenshot. Everything else is a condition (`expect.poll`, locator asserts) — and
  where a value is projected by the per-RAF tick, the honest wait is awaiting *frames in the
  page* (a double-rAF per frame), not milliseconds. Enforced: `tests/harness.test.ts`
  ("no raw waitForTimeout except the SHOT_MS settle before a screenshot") walks every staged
  flow file and reds on a `waitForTimeout` call whose argument is not exactly `SHOT_MS`.
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
  standing pin: flow 1 of `geo.pw.ts` (`test.fail` + a boot-time `addInitScript` throw) goes
  red if the listener moves after `goto` or the injection is removed. Its verdict is inverted —
  a green run prints that flow with the failure mark, and skipping it still fails the run —
  don't "fix" either.
- **A flow that asserts only counts pins no behavior.** Three Cut flows passed 35/35 while force
  Cut and geo-graph Cut were both broken, because they asserted `sectionCount` and `undoDepth` —
  which a wrong-but-plausible cut satisfies exactly. Assert what the op claims: that the split
  landed at the position the menu itself resolved, that every keyframe's `(s, g)` survived. A count
  is the flow-level twin of `kex2d-map.md`'s vacuous exactness pin.
- **A stage that retires a behavior runs the display-gated suite in that stage.** The trigger is the
  retirement, not the schedule. Skipped for two stages, this suite accumulated assertions pinning
  the retired law — `force.pw.ts` still asserting the curve-span→leading-keyframe behavior that had
  been deleted, three flows still expecting a `Cut K` hint after the rebind to `C`, all of it green
  in `bun test` because none of it had met a browser since the last capture. A gate whose cost
  defers it is a gate whose *fixtures* drift, and the drift always points backward at the law the
  diff just retired.
- **A `.svelte` module has no importable export, so production handlers are reachable only from
  capture flows:** a unit arm over a shared pure helper is a legitimate pin and never discharges a
  handler-path criterion — that criterion's arm is a capture flow whose red-first witness mutates
  the *handler's* branch, not the helper.
- **A multi-flow red is presumptively host-level.** Unrelated flows failing together in one
  full run (observed ~1/18; never reproduced in isolation or ×12 consecutive) is a run-level
  signature on the shared GPU bridge — re-run once before debugging any flow; if it recurs,
  keep `RUN.json` + the reporter output.
- **A *single*-flow red recurring across runs is a defect with an owner, never weather:** triage
  by where it died (a timeout is load, an assertion is a race), then deflake by awaiting the
  condition. A per-test failure rate is a measurement of the defect, not a baseline to inherit —
  the roster it produces is a punch list, and any N-run ship protocol retires when the roster
  empties.

## Verifier integrity

- **The suite-count oracle.** A green suite is evidence only when `--list`-collected equals
  summary-accounted (+ `forbidOnly`); a truncated run fails, never passes with survivors green.
  A skip also fails: a would-be reference run with `skipped > 0` exits nonzero, `reference:
  false` — a stray `test.skip` can't drop coverage silently. `RUN.json` carries per-category
  `counts` and `failedTitles` (parsed from run stdout in `args.ts`) for flake forensics.
- **The wipe guard.** `RUN.json` is the shot set's provenance stamp AND its wipe permission
  slip: a full run refuses to wipe any `--out` that isn't absent, empty, or `RUN.json`-bearing.
- **Standalone staging.** `flow.ts` + every `*.pw.ts` flow file (the set is `capture.ts`'s
  `stage.files`, never a list quoted here) + `capture.pw.config.ts` are staged to the Windows host as a set
  and may import nothing *outside the staged set*. Shared validators are duplicated verbatim,
  pinned character-identical AND pinned reached by unit tests (hand-written copies drifted once);
  mirrored app constants live in the MIRRORED block, each naming its source. Staging is a file
  LIST now, not a glob (`capture.ts`'s `stage.files`), so `tests/harness.test.ts` walks the
  harness dir for the real staged set and pins every entry is named there — a new flow file
  landing unstaged fails that pin instead of silently missing from the Windows-side run.
- **The PAGE may import app source the staged file can't.** Staging forbids `flow.ts` importing
  `../src` — but the page it drives is served by the vite dev server, so a `page.evaluate` can
  `await import("/src/menus.ts")` and compute the expected answer from the real module at runtime.
  `flow.ts`'s own imports and `capture.ts`'s `stage.files` are untouched, so the staging law holds
  as written. This is the sanctioned way to compare rendered DOM against production data: the menu
  cross-check rebuilds each menu from `src/menus.ts` + `menuRows` and asserts the DOM's row labels,
  `data-group`s, and derived dividers against it. A hand-typed expected sequence in the harness is
  the alternative, and it makes a builder reorder plus a matching hand-edit here silently green —
  the exact drift the cross-check exists to catch. Two conditions make it free, and both must hold
  before reaching for it: the module is **module-graph pure** (`menus.ts` touches no ECS, editor, or
  DOM, gated by a walk in `tests/menu.test.ts`), and the descriptor crossing into the page stays
  plain data — enum-valued fields travel as `"<module>.<Enum>.<Member>"` strings resolved from the
  real module in the page, never as mirrored numeric literals, and function-valued fields are
  stubbed. Importing an impure module this way would boot a second copy of app state inside the
  flow.
- **A deleted flow file must not outlive the checkout.** The Windows stage dir is PERSISTENT (its
  `node_modules` is the point) and the config now collects by glob, so a staged `*.pw.ts` the repo
  no longer has keeps running there: the split's first full capture ran the pre-split `shot.pw.ts`
  beside the current set and reported a suite of REMOVED features, half green. `stage.stale`
  (`wsl.ts`) prunes any stage-root file matching it that `stage.files` no longer lists, and the
  pruning rule is a pure, unit-tested function (`stalePrune`) rather than a Windows-only side
  effect. A glob-collected suite needs both halves: the staging-list pin above (a new file reaches
  the host) and this one (an old file leaves it).
- **Growth landed.** Past ~28 flows (the 420 s `globalTimeout` ceiling at 4 workers — the binding
  number), the single `shot.pw.ts` split into `flow.ts` (the one staged helpers module: the
  MIRRORED guards/constants, the boot fixture, every shared pointer-true helper) plus the staged
  flow files grouped by area — `geo.pw.ts` (geo authoring + viewport, the boot-pin included),
  `force.pw.ts` (force authoring + the timeline), `section.pw.ts` (the section chain + invoked
  solves), `lab.pw.ts` (the atom-page labs), `affordance.pw.ts` (popover/hover/hit-zone
  affordances), `freshness.pw.ts` (the `__kex` hook's ECS-direct read freshness),
  `substrate.pw.ts` (section-boundary and split/join structural invariants) — the count lives in
  `capture.ts`'s `stage.files`, not this prose. `capture.pw.config.ts`'s `testMatch` is the `*.pw.ts`
  glob; `capture.ts`'s `stage.files` names each file explicitly (a list, not a glob, so the
  staging-list pin above is what keeps a future flow file honest). The `__kex` DEV surface got a
  typed `Kex` interface in `flow.ts` (a hand-written mirror of `src/main.ts`'s hook object +
  Timeline.svelte's `gRange`/`xView` augmentation, covering the members the flows actually call)
  and one typed accessor, `kexCall(page, method, ...args)`, that every flow calls through instead
  of an ad-hoc `(window as any).__kex.foo()` cast — the one exception is a batched in-page read
  (several `__kex` calls inside one `page.evaluate`, to save round trips), which stays a typed
  inline cast since `kexCall` is one accessor per round trip.
