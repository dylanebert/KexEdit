---
paths:
    - "kex2d/src/**/*"
    - "kex2d/tests/**/*"
---

# kex2d Code Map

Read `kex2d/AGENTS.md`. Paths are kex2d-relative; code owns APIs. Interaction: `editor-ui.md`; capture: `kex2d-harness.md`.

## Physics

`section.ts` evaluates geo/force payloads and chains recovered exits. Geo nodes are placed rigidly in the entry frame; upstream edits carry downstream geometry, not world-frame force invariance. Payloads share a boundary sample. `projection.ts` derives evaluator runs from the lanes: the higher shape lane in `track.order` cuts, and a stretch neither shape lane covers is a force run dwelling at the last exit.

`forward.ts` integrates demanded normal force with squared-speed energy updates; `bake.ts` recovers displayed force from geometry using continuous, unwrapped chord-bisector headings. `invertRange` is validation-only: its alternating tangent mode forbids using it for display recovery. Force payload exits use the recovered state too. Zero-length edges carry orientation and recover the stationary-cart force without division by zero.

Friction/drag make speed path-dependent; height-only conservation holds only at zero coefficients. `forward.loss` uses module `G` even when its caller accepts a gravity parameter: preserve its documented signature constraint. Authored velocity prescriptions override natural dissipation, reading stored station/curve values, never recapturing live march speed. `section.stripOverride` owns half-open edge ranges and the preceding-edge point convention; `tests/section.test.ts` pins per-field prefix causality.

`profile.resolveStep` pairs edges/ds (`Step`) for `forceProfile`/`evalForce`; the latter rejects mismatched arrays. Extent conforms unless budget-clipped; no per-section quantum is stored. Arclength consumers sum published `bakeOut.ds`, never position chords: a pin freeze can publish a zero-length edge over a real spatial gap.

## Geometry

`spline.ts`: Hermite interpolation and tangents. Auto tangents remain inferred, explicit vectors absolute. A node edit affects only its adjacent segments. Re-head the tip only on its own default move or append, never neighbor movement/deletion; role changes preserve authored headings and tangents. Read `exitHeading`, not stale Auto `theta`, when an explicit tangent controls direction. Reset returns creation state; node zero stays pinned.

`track.ts`: the lane store, its refusing setters, snapshots and bake publication; stations are f64, not f32. `lanes.ts`: the pure laws (exclusivity, entry inference, the record floor, the end rule). Flat v4 `doc.ts` stores lane records verbatim and never fits on save; stable ids and exact emission (negative zero included) round-trip.

## Velocity strips

Velocity is track-global: preserve values across structural edits, allow abutting/run-crossing spans, refuse overlap. Each `edgeStrips` row keeps its seam; restore admits migrated sub-floor records. `entrySpeed` reads `Track.v0`. `domain.ts` is display-only; `timeline.ts` holds gesture projections with matched extrapolating inverses.

## Invoked tools and history

`force.ts`, `banded.ts`, `collocate.ts`, `fit.ts`, `polish.ts`, `refine.ts`: invoked optimization atoms. Conversion uses its own fixed quantum, never per-user snapping preferences. `convert.ts` consumes pool answers in ask order; cancellation terminates workers. Playback observes without re-solving; `census.ts` measures vocabulary at the caller's screen scale.

`geofit.ts` scores the candidate's actual adaptive document bake on absolute arclength over both station sets, never normalized spans. Keep invoke/landing runaway bounds at their owning constants. 

`optimize.ts`: only unlocked force ordinates change; pin `(x,y,theta)`, never exit speed as a fourth DOF. A stall certificate does not certify the landing: `finalize` checks landed energy injection against its derived rounding floor, and an awaited answer needs the live authored hash.

`history.ts` owns recording and injected stable-selection restore, never imports `editor`. Continuous `begin*`/update/commit coalesces; cancel restores opening, including raw absent columns. `beginRecordEnd` freezes records and ripple: `planRecordEnd` validates the whole candidate, `publishRecordSpans` publishes synchronously. Replay admits legal legacy sub-floor neighbors; resize floors only the subject. `tests/history.test.ts` pins one-vs-N and exact replay.

## Hard gotchas

`controls.ts` owns lifecycle; `editor.ts` owns selection. `menus.ts`/`keys.ts` describe; `Menu.svelte` renders. `Popover.svelte` owns one stable-id field/history; `timeline.ts` reads published bake stations. Fit actual invoker/handle/player/tool boxes; flip menus above/below. Preserve full canvas and a non-transforming overlay root; only backing/transform scales by DPR.

Keep substrate/selection, purity/writer and module tests. Physics authority: analytics, `tests/oracles/rk4.ts`, `tests/helpers/forward64.ts`, not self-consistency. Exactness reads whole pre-op state, not counts/boundaries.

Run affected `./tests/*.oracle.ts` by path; fast sentinels remain in the default suite. Goldens are field-wise and platform-stamp matched where required; missing stamps fail, never skip. Quiet flows/watched reds, not helpers, prove DOM wiring. Keep one shared keyframe interaction path, not per-kind twins. Labs (`tests/*.lab.ts`, `*-lab.html`) run explicitly.
