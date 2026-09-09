---
paths:
    - "kex2d/harness/**/*"
    - "kex2d/tests/harness.test.ts"
---

# kex2d Capture Harness

`kex2d/`: capture defaults headed. `KEX_QUIET=1 bun run capture -- -g '<selection>'`: headless, no display preflight/reference/trend append. Runtime/adapter/CSS+DPR aren't native appearance. Occupied ports refuse; only owned children stop.

Playwright deps: `harness/package.json`/`bun.lock`, frozen by `check`; app wiring: entry Verify. Missing required display/adapter or software: incomplete.

## Verifier integrity

`args.ts`/`capture.ts` own CLI/knobs/verdicts; `tests/harness.test.ts` pins guards. Validate before destruction; mirrors stay identical/reached. Bound calls; `globalTimeout` clears healthy full runs, spawn ceiling above it.

Full/quiet: `--list` accounting, no skips/truncation, `forbidOnly`. Quiet requires nonempty/all-pass; refuses overrides/PWDEBUG. `RUN.json`: counts/titles/provenance. Wipe only absent/empty/`RUN.json` dirs; malformed `--out`/non-directory refuses. Listing touches no shots/stamp.

`capture.ts`'s `suite.files`: `flow.ts`, all `*.pw.ts`, config. `boot` prints adapter, refuses software. Loaded files: no local imports. Mirrored constants cite sources. Use `kexCall`, typed batched reads.

Page imports must be module-graph pure, no second app state. `flow.ts` compares menus to real builders: plain descriptors, in-page enum-name resolution, stubbed functions; no copied expectations.

## Flow-authoring laws

Prefer extending flows. Poll conditions; only `SHOT_MS` immediately before screenshots is a fixed wait. `frames` requires no readable condition and a call-site reason. Counts aren't bake-readiness: await changed bake output. Respawn: `nodePoint`; in-place restore: poll expected position within 1px. No boxes cached across edits/undo; knobs require exact orbit, not reach radius. App ops read authored geometry, never need between-op bake waits.

Negatives need positive controls. Before Escape, prove upper rung off, intended rung on. Assert geometry/values, not counts alone. `boot` listens for pageerror before navigation, fails at teardown; keep first `geo.pw.ts` expected-failure injection pin, not console-noise checks.

Handler/key criteria need authored/history capture arms and handler-branch mutations, not helper-only units. Product retirement retains affected composition coverage. Keep live regressions.

## Ship protocol

Default: full capture. Quiet: scoped selection; native stays human. Unrelated multi-flow reds: rerun once; recurrence keeps `RUN.json`/reporter output. Single-flow reds are owned defects: targeted repro; green is inconclusive, take same-pass base full run, never inherited attribution. Read `bun run trend`, fix or declare with owner/first-seen evidence. No paired N-run escalation.

## Recorded distribution

`declared.ts` tolerates only declared full-run reds, never stamps them reference; selective reds fail. Empty set retires no contracts. Evidence moves entries; dead owners/titles fail corpus checks. Reference needs full default-knob green. Iterate `bun run capture -- -g "pattern" --out DIR` separately; selective merges demote reference.

`trend.ts` owns schema/windows/unit-keyed roster/removal summons. History is machine-stable outside checkouts; don't pool hosts. Only non-quiet `RUN.json` runs append. Missing/malformed fields fail loud. Serialize unlocked appends; never mask torn lines or add a lock instead. Duration isn't a test/check gate; removal summons never latches/fails.
