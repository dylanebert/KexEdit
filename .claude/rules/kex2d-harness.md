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
there, not in the app. `bun check` self-provisions *that sub-package only*: the `harness:deps`
script installs `--cwd harness --frozen-lockfile` when `harness/node_modules` is missing. It does
not provision the app root — a fresh clone or worktree still has no `node_modules` there and reds
`tsc` on missing app-level type defs (`@webgpu/types`, `vite/client`) until something installs at
the `kex2d` root (witnessed twice, 2026-08-26, in fresh worktrees). A root `bun install`
resolves `@dylanebert/shallot` from npm, overwriting whatever is currently at
`node_modules/@dylanebert/shallot` — so read what's there first (`file
node_modules/@dylanebert/shallot`) rather than run it blind. A plain directory is already an
npm-resolved copy, and a root install is safe; anything else (a symlink, a junction) is a
hand-wired local checkout a root install destroys, and restoring that wiring is on whoever set it
up — this repo doesn't create it and can't tell you how to get it back.

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

## Ship protocol

Confirmation and escalation on `bun run capture`, re-priced 2026-08-26 against a measured per-run
wall clock and a measured flake rate (both readings anchored below, trunk `a0a25d4`), retiring the
arms that pre-date those measurements. Self-contained — consuming specs inherit it by reference rather than
restating it, since the spec that carried these numbers is deleted at close.

- **The gate is a boolean against a committed declared set** (`harness/declared.ts`): a full run
  whose reds are all declared exits 0 and stamps `reference: false`; a full run with any red
  outside the set exits 1 naming that title. The declared set is the punch list — one entry per
  tolerated title, each carrying an **owner** (a roadmap item, a spec slug, or a git-history slug)
  and its first-seen evidence. Declaring an entry with an owner is what clears its alarm; no
  expiry, no schedule, no clearing ritual — an entry moves only on evidence. The set cannot
  accumulate: the corpus arm reds an owner naming nothing live and a title matching no test in
  `stage.files`, and the stale-entry summons fires for an entry absent from the recent
  unit-keyed population (both below, § Recorded distribution). `reference: true` still requires a
  fully green run — a declared red stands but is never the reference set.
- **Ship confirmation is one full run, on the branch tree only.** The base-tree run moves from
  *per-ship* to *on-red, same-pass* (below) — spent once per red rather than once per ship, so
  the spend on a red tree is unchanged and the spend on a clean tree halves. The per-ship base run
  existed to stop a red being attributed to the wrong side; taking that reading in the red's own
  attribution pass, instead of in advance of knowing there is a red, protects the same thing
  without charging it to a ship that lands nothing red. The incident it guards is inheriting a
  *stale* base reading, not confirming a base reading exists per ship: an inherited roster
  attributed a red to the wrong side in both directions, measured three times at `6b88280`
  (`kex2d-event-substrate` S1).
- **The paired N=8 full-run escalation is retired outright, not narrowed — two independent
  reasons.** Its earning incident is gone: it was booked against a flake roster that emptied with
  `kex2d-capture-deflake`'s close (2026-08-25) — "any N-run ship protocol retires when the roster
  empties" (below) already names this, and this section is that retirement taking effect. And it
  is underpowered at the rate this unit measured: the chance an N-run batch reads all-green on a
  tree flaking at rate r is `(1−r)^N`. Evaluate it with the rate a fresh N-run reading actually
  produces rather than trust a quoted result here, which would itself be a frozen figure that
  drifts the moment the rate is re-read.
- **A confirmation run reddening on several unrelated flows at once is the other measured
  regime, and it runs first.** "A multi-flow red is presumptively host-level" (below) triages
  that shape — re-run once before debugging any flow — and decides whether the ladder is even
  entered. The ladder below is what a *single*-flow red enters.
- **Escalation is a ladder, cheapest instrument first, run only against the one test a
  confirmation run reddened:**
  1. **Targeted repro** — `bun run capture -- -g "<pattern>" --repeat-each=<N>` on the branch
     tree. Reproduces ⇒ it is a defect with an owner (below, "A *single*-flow red…"); fix it, no
     further run spent.
  2. **Same-pass base run** — does not reproduce ⇒ one `bun run capture` on the base tree, spent
     now rather than inherited, to place the red on a side.
  3. **Declare or fix** — the gate's boolean decides: a red inside the declared set exits 0
     (the ship is clean — the red is a known defect with an owner); a red outside the set exits 1
     (a regression or a new entry to declare). Reading the roster is part of this step: run
     `bun run trend` in the same pass — recording into a roster nobody reads is burial, not
     escalation. A roster entry is a defect with an owner, never weather (below, "A
     *single*-flow red…") — the declared set is the committed form of that ownership, and a new
     red outside it is either fixed (removing it from the run) or declared (adding it to
     `harness/declared.ts` with an owner and first-seen evidence). Escalation is by *accumulation
     across ships*, never by a batch manufactured inside one pass: the across-ship population
     grows for free with every ship's confirmation run and is strictly more powerful, run for run,
     than any within-pass N.
- **A green targeted repro is inconclusive, never an acquittal.** `section.pw.ts:2017` read
  green under `-g --repeat-each` and whole-file, and red at full cross-file, full-worker scale —
  the targeted instrument cannot see whatever surfaces only at that scale. So step 1 not
  reproducing routes to step 2, never to a clean bill.

## Cost levers

Three costs the full suite pays, recorded as derivations — the command that reads each factor and
the structural relation between them, never a frozen figure (`doc-hygiene.md` §9: a quoted count
is drift by construction; `checks.md` Measurement discipline: one run per condition, captured to a
file). `tests/harness.test.ts` reds this section on a pasted wall-clock or count, both directions
witnessed in its docblock.

- **Worker count.** `capture.pw.config.ts`'s mirrored `intEnv(process.env, "KEX_WORKERS", 4, 1,
  64)` (and `capture.ts`'s own `intEnv(..., DEFAULT_WORKERS, ...)`, the two guards pinned
  character-identical, Verifier integrity below) is the sole resolution. `fullyParallel: true`
  schedules concurrency at the TEST level, so the worker count is a real lever, and it reads
  sub-linear against the knob — don't assume a 4x-workers run resolves in a quarter of a
  1-worker run's time. The mechanism is open, not derived: "one capture at a time per port"
  (above) governs concurrent separate `bun run capture` invocations, not intra-run worker
  parallelism (every worker in one run already shares the one dev server and port), so it is
  not the explanation by itself; the WSL→Windows bridge's single real-GPU Chrome, per-test boot
  cost (Iteration discipline above already prices a page boot), WSL-side CPU contention, and the
  dev server's own concurrency are all live candidates, none confirmed against the other. Read
  the relation by timing `bun run capture` back to back against `KEX_WORKERS=1 bun run capture`
  on the same tree — the Iteration discipline bullet above already refuses a quoted figure for
  this reason; this entry adds the relation, not a number or a settled cause.
- **Aggregate `SHOT_MS` spend.** The settle idiom's one lawful fixed wait, `flow.ts`'s
  `SHOT_MS = intEnv(process.env, "KEX_SHOT_MS", 300, 0, 60_000)`, fires once per screenshot. Read
  the call-site count with `grep -c "waitForTimeout(SHOT_MS)" harness/*.pw.ts` — the same
  population the enumerator arm (Flow-authoring laws, below) already walks, so the two never
  disagree — and the resolved settle value from `KEX_SHOT_MS` (unset = the `flow.ts` default). The
  spend is that count times the settle value: a CPU-time sum, not a wall-clock one, since workers
  run screenshots concurrently — the wall-clock share divides by whatever `KEX_WORKERS` resolves
  to, same as the worker-count lever above.
- **Behavior-only gating mode.** None exists — no flag or env knob skips a screenshot while
  keeping its `expect.poll`/locator assertions. Checked: `args.ts`'s `intEnv`/`boolEnv` call
  sites, the harness's declared knob surface, name no such mode; `grep -rn "process\.env\."
  harness/*.ts harness/*.pw.ts` finds three more knobs read directly, outside that guard —
  `capture.ts`'s `KEX_STAGE`, `flow.ts`'s `KEX_OUT`, `server.ts`'s `SERVER_STARTUP_TIMEOUT_MS` —
  and none of the three gates screenshot behavior either (a stage name, an output dir, a
  server-boot timeout). Its saving ceiling IS the aggregate `SHOT_MS` spend above: a
  behavior-only mode could remove at most that total, never more, so the
  two levers are one measurement read twice, not two independent ones.

## Recorded distribution

The anti-rot instrument for both quantities the Ship protocol spends: how long a run costs, and
how often one goes red. Recorded, never gated — a wall-clock threshold gates the host and not the
artifact (`checks.md`), so nothing in `bun test`/`bun check` reds on a duration, and the tripwire's
job is to summon a person rather than to fail a run.

- **A run that reaches `RUN.json` appends one line to `runs.jsonl`** (`capture.ts`, via
  `trend.ts`'s `appendRun`): the per-phase durations it also stamps into `RUN.json`
  (`collect`/`server`/`run`/`total`), the exit code, and the failing titles. A run that dies
  before that point — a `--list` collect failure, a bad-arg usage exit, a SIGINT/SIGTERM — never
  reaches `appendRun`, so the recorded population is scoped to test-level reds only; a whole class
  of failure (host-boot, kills) never reaches this instrument. `RUN.json` alone cannot carry the
  distribution either way — it lives inside the shot set the next full run WIPES, so it records a
  run and never a distribution.
- **`bun run trend` is the reader**, and it is the consumer that makes the recorded fields
  load-bearing rather than a table nothing opens: a record missing a field the reader consumes
  fails loud, naming the field, instead of defaulting it and reporting a healthy trend off a
  column nobody is filling. The population is full default-knob runs only — a selective or
  knob-shifted run captured a different quantity.
- **The roster half is what the escalation ladder depends on.** Ship protocol step 3 declares or
  fixes a failing title rather than recording it — recording is automatic (`capture.ts` appends
  every run to `runs.jsonl`), and what step 3 decides is ownership; that roster is only readable
  because every run records its pass/fail here. A duration trend alone would read healthy while the red
  rate climbed, which is why the recorded quantity is rate as well as duration.
- **Both tripwires derive from the recorded data, never from a fitted constant.** Duration: the
  recent window's median sitting **above** the prior window's whole observed range — the suite's own
  run-to-run spread is the instrument's resolution, so the prior window's max is the bound, with no
  multiplier to tune. One-sided on purpose: this guards against rot, and a suite that got faster is
  the outcome rather than the breach — a speedup that bought its time by dropping work is the
  suite-count oracle's to catch, not this reader's. Rate: one failing title recorded on two or more
  *distinct branch-slug units* (the prefix before the first `/` in `branch`), rather than distinct
  heads — an author who commits between iterations manufactures recurrences with commits attached,
  so a recurrence must mean the red crossed a unit boundary. Dirty-tree runs and legacy
  (pre-version) records are excluded from the roster population; legacy records keep feeding the
  duration windows. The window is a sample size (`trend.ts`'s `WINDOW`), not a threshold: a median
  over it must survive the extreme readings this suite actually produces.
- **The declared set is the committed punch list the gate reads.** `harness/declared.ts` carries
  one entry per tolerated title, each with an owner (a roadmap item, a spec slug, or a
  git-history slug) and first-seen evidence. `verdict()` in `args.ts` — where every harness
  predicate lives and is unit-tested — passes a full run whose reds are all declared and refuses
  any red outside it, naming the title. The declared-set check applies only to full
  (non-selective) runs: a selective run's red is an iteration signal (`mutate.ts`'s pairings read
  coupling off exit codes), not a gate decision. `reference: true` still requires a fully green
  run — a declared red stands but is never the reference set.
- **The corpus arm reds a dead owner and a stale title.** `declaredCorpusViolations` in
  `harness/declared.ts`, on `blockedOnCorpusViolations`'s shape, checks each declared entry against
  the live corpus: an owner naming no live roadmap item, no spec, and no git-history slug reds
  (a closed spec's slug is cited as `git-history`, never as `spec`, or the arm reds it); a
  declared title matching no test in `stage.files` reds. The arm is run from `tests/harness.test.ts`
  against the real repo root, so a dead entry fails the gate rather than accumulating silently.
- **The stale-entry removal summons fires for an entry absent from the recent unit-keyed
  population.** `removalSummons` in `trend.ts` prints — not trips, so it does not cause exit 1 —
  when a declared title has not reddened in the last `WINDOW` versioned, non-dirty runs. The
  summons is silent until the population can support the judgment: the v2 population is empty or
  tiny today, so firing for every entry would rebuild the very latch this mechanism exists to
  remove. "Acknowledging" the summons means removing the entry from the declared set; once
  removed, reading the same fixture again returns no summons — the reader does not latch.
- **The history lives outside any checkout, at a machine-stable path** (`KEX2D_TREND_HISTORY`
  wins outright, else `$XDG_STATE_HOME/kex2d/runs.jsonl` — `trend.ts`'s `resolveHistory`). Not
  because it's gitignored: every unit's confirmation capture runs from its own fresh worktree,
  retired at ship, so a path resolved from the checkout (`harness/runs.jsonl`, the earlier shape)
  starts empty every time and can never accumulate the across-ship roster the escalation ladder
  depends on. `bun run capture` is also display-gated to the one GPU-bridge host, so every run in
  the population comes off the same seat regardless — a durations column pooled across two
  machines would compare hosts, not trees. **That shared path is also now a shared write target
  across every worktree on the host, and `appendRun` takes no lock**. The premise that makes that
  safe is the GPU bridge being one machine-level seat, so captures on this host never overlap at
  all — **not** "one capture at a time per port" (Iteration discipline, above), which deliberately
  *permits* a second session on another port and would put two sanctioned writers on this one file.
  Nothing enforces either. A concurrent writer would tear a line, and `parseHistory` throws loud on
  the resulting malformed line for every consumer, not just the racing pair — which is correct
  (`coding.md`: no silent swallowing), so the fix for a torn write is holding the seat premise,
  never a lock added here or a reader that skips malformed lines.

## Flow-authoring laws

- **The settle idiom.** Exactly one fixed wait exists: `SHOT_MS`, on the line immediately
  before a screenshot. Everything else is a condition (`expect.poll`, locator asserts) — and
  where a value is projected by the per-RAF tick, the honest wait is awaiting *frames in the
  page* (a double-rAF per frame), not milliseconds. Enforced: `tests/harness.test.ts`
  ("no raw waitForTimeout except the SHOT_MS settle before a screenshot") walks every staged
  flow file and reds on a `waitForTimeout` call whose argument is not exactly `SHOT_MS`.
  A `frames(page, N)` settle is itself lawful only where the awaited quantity has no readable
  condition — no `__kex` hook exposes it — and the comment at the call site must name why.
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
  the *handler's* branch, not the helper. **`bun test` has no DOM either, so a handler behind
  `window.addEventListener` inside `onMount` is invisible to it** — reverting a repaired keydown
  guard to its double-fire form left `bun test` at 1705 pass / 0 fail. A criterion whose subject
  is a key press owes a `.pw.ts` arm asserting an **edit count** (authored readback or history
  depth); a unit arm over a routing predicate is not a substitute for one.
- **A multi-flow red is presumptively host-level.** Unrelated flows failing together in one
  full run (observed ~1/18; never reproduced in isolation or ×12 consecutive) is a run-level
  signature on the shared GPU bridge — re-run once before debugging any flow; if it recurs,
  keep `RUN.json` + the reporter output.
- **A *single*-flow red recurring across runs is a defect with an owner, never weather:** triage
  by where it died (a timeout is load, an assertion is a race), then deflake by awaiting the
  condition. A per-test failure rate is a measurement of the defect, not a baseline to inherit —
  the roster it produces is a punch list, and any N-run ship protocol retires when the roster
  empties. It did, 2026-08-25 (`kex2d-capture-deflake`'s close) — Ship protocol (above) is what
  replaced it: the roster this bullet already names is now read across ships (`RUN.json`
  `failedTitles`), never rebuilt as a batch inside one pass.

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
