---
paths:
    - "kex2d/harness/**/*"
    - "kex2d/tests/harness.test.ts"
---

# kex2d Capture Harness

From `kex2d/`, `bun run capture`: headed local Chrome, never headless. Serialize across ports/worktrees; no host kills/interactive servers.

Playwright: `harness/package.json`/`bun.lock`; `check` provisions only harness deps, frozen. App install/Shallot wiring: `kex2d/AGENTS.md` Verify. No display or software adapter: incomplete, never green.

## Verifier integrity

`args.ts`/`capture.ts` own CLI/knobs/verdicts, pinned by `tests/harness.test.ts`. Validate before destruction; mirrored guards stay identical/reached. Bound host calls/timeouts; derive `globalTimeout` from healthy full runs, spawn ceiling above it.

Full runs: complete `--list` accounting, no skips/truncation, `forbidOnly`. `RUN.json` records counts, failed titles/provenance. Wipe only absent, empty or `RUN.json`-bearing dirs; reject malformed `--out`/non-directories. Listing touches no shots/stamp.

Declared suite: `capture.ts`'s `suite.files` names `flow.ts`, every `*.pw.ts`, config; `boot` prints `adapter.info`, fails software names. No local imports in loaded files. Mirrored constants name sources. Use `kexCall`, typed casts for batched reads.

Page imports must be module-graph pure, no second app state. `flow.ts` compares menus to real builders: plain descriptors, in-page enum-name resolution, stubbed functions; no copied expectations.

## Flow-authoring laws

Prefer extending flows. Poll conditions; only `SHOT_MS` immediately before screenshots is a fixed wait. `frames` requires no readable condition and a call-site reason. Counts aren't bake-readiness: await changed bake output. Respawn: `nodePoint`; in-place restore: poll expected position within 1px. No boxes cached across edits/undo; knobs require exact orbit, not reach radius. App ops read authored geometry, never need between-op bake waits.

Negatives need positive controls. Before Escape, prove upper rung off, intended rung on. Assert geometry/values, not counts alone. `boot` listens for pageerror before navigation, fails at teardown; keep first `geo.pw.ts` expected-failure injection pin, not console-noise checks.

Handler/key criteria need capture edit-count arms (authored/history), handler-branch mutations, not helper-only units. Product retirement runs display coverage that stage. Keep live regressions.

## Ship protocol

Confirm with one full branch capture. Unrelated multi-flow reds: rerun once; recurrence keeps `RUN.json`/reporter output. Single-flow reds are owned defects: targeted repro; green is inconclusive, take same-pass base full run, never inherited attribution. Read `bun run trend`, fix or declare with owner/first-seen evidence. No paired N-run escalation.

## Recorded distribution

`declared.ts` tolerates only declared full-run reds, never stamps them reference; selective reds fail. Empty set retires no contracts. Evidence moves entries; dead owners/titles fail corpus checks. Reference needs full default-knob green. Iterate `bun run capture -- -g "pattern" --out DIR` separately; selective merges demote reference.

`trend.ts` owns schema/windows/unit-keyed roster/removal summons. History is machine-stable outside checkouts; don't pool hosts. Only runs reaching `RUN.json` append; early failures aren't measured. Missing/malformed fields fail loud. Serialize unlocked appends; never mask torn lines or add a lock instead. Duration isn't a test/check gate; removal summons never latches/fails.
