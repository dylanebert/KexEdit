---
paths:
    - "kex2d/src/**/*"
    - "kex2d/tests/**/*"
---

# kex2d Code Map

Read `kex2d/AGENTS.md`. Paths are kex2d-relative; code owns APIs. Interaction: `editor-ui.md`; capture: `kex2d-harness.md`.

## Physics

`section.ts` evaluates geo/force payloads and chains recovered exits. Geo nodes are placed rigidly in the entry frame; upstream edits carry downstream geometry, not world-frame force invariance. Payloads share a boundary sample. `projection.ts` derives evaluator runs from canonical segments.

`forward.ts` integrates demanded normal force with squared-speed energy updates; `bake.ts` recovers displayed force from geometry using continuous, unwrapped chord-bisector headings. `invertRange` is validation-only: its alternating tangent mode forbids using it for display recovery. Force payload exits use the recovered state too. Zero-length edges carry orientation and recover the stationary-cart force without division by zero.

Friction/drag make speed path-dependent; height-only conservation holds only at zero coefficients. `forward.loss` uses module `G` even when its caller accepts a gravity parameter: preserve its documented signature constraint. Authored velocity prescriptions override natural dissipation, reading stored station/curve values, never recapturing live march speed. `section.stripOverride` owns half-open edge ranges and the preceding-edge point convention; `tests/section.test.ts` pins per-field prefix causality.

`profile.resolveStep` pairs edges/ds (`Step`) for `forceProfile`/`evalForce`; the latter rejects mismatched arrays. Extent conforms unless budget-clipped; no per-section quantum is stored. Arclength consumers sum published `bakeOut.ds`, never position chords: a pin freeze can publish a zero-length edge over a real spatial gap.

## Geometry

`spline.ts`: Hermite interpolation and tangents. Auto tangents remain inferred, explicit vectors absolute. A node edit affects only its adjacent segments. Re-head the tip only on its own default move or append, never neighbor movement/deletion; role changes preserve authored headings and tangents. Read `exitHeading`, not stale Auto `theta`, when an explicit tangent controls direction. Reset returns creation state; node zero stays pinned.

`track.ts`: authored ECS, setters, snapshots, bake publication. `segment.ts`: pure chain operations. Flat v3 `doc.ts` stores chain records, not caches; stable order/ids and f32-exact emission (including negative zero) round-trip. Never re-sum conserved run stations/extent from rounded members.

## Velocity strips

Velocity spans are track-global and survive structural edits without reseeding. `createStrip`/`setStrip` own overlap/minimum-edge refusal; abutting and boundary-crossing spans are legal. Clamp to neighbors rather than ripple or replace. Snapshot restore bypasses authoring guards to preserve old state exactly. `entrySpeed` reads `OneShot`; the track start is not a draggable node. `domain.ts` changes only the display lens; `timeline.ts` projects coordinates, frozen per gesture, with matched extrapolating inverses during extent growth.

## Invoked tools and history

`force.ts`, `banded.ts`, `collocate.ts`, `fit.ts`, `polish.ts`, `refine.ts`: invoked optimization atoms. Conversion uses its own fixed quantum, never per-user snapping preferences. `convert.ts` consumes pool answers in ask order; cancellation terminates workers. Playback observes without re-solving; `census.ts` measures vocabulary at the caller's screen scale.

`geoforce.ts`/`forcegeo.ts` land once through history, with concurrent/stale/cancel/refusal guards and exact undo. `geofit.ts` scores the candidate's actual adaptive document bake on absolute arclength over both station sets, never normalized spans. Keep invoke/landing runaway bounds at their owning constants. Provenance is a droppable cache: exact entry/token certification permits unchanged round-trip restore, never re-fit; destructive reset never stamps it.

`pin.ts`: sandbox; `optimize.ts`: only unlocked force ordinates change. Pin `(x,y,theta)`, never exit speed as a fourth constraint or DOF. Invoke-time Jacobian stall certificates do not certify the landing: `finalize` checks landed energy injection against its derived rounding floor. Freeze the lock ledger at invoke and require the same session plus live authored hash after await.

All in-mode records redirect to a non-evicting sandbox. Exit discards without changing outer undo/redo; Solve uses `recordOuter` for one entry whose undo reopens the draft, locks and sandbox. Downstream freezes until close. A paced landing is display-only and `bakeLive` must refuse it as authored truth. `history` never imports `editor`; injected selection hooks re-resolve stable identities after restore.

## Hard gotchas

`controls.ts` attaches input on mount with teardown, never a module-level attached flag. `editor.ts` owns one selection set/active member. Tick-derived values lag: swallowing listeners must read live state, and reactive reads return primitives rather than a mutated singleton reference. `menus.ts`/`keys.ts` are pure descriptors; `acts.ts` owns shared document acts; `Menu.svelte` renders them. `render.ts`/`cart.ts` only read the bake.

Keep `tests/substrate.test.ts` (selection), `tests/purity.test.ts` (writes/adapters) and module-named behavioral tests. Physics authority is independent convergence: `tests/oracles/rk4.ts`, analytics and `tests/helpers/forward64.ts`, not self-consistency. Structural exactness checks sample the whole pre-op observable, not just counts or boundaries.

Run affected `./tests/{roundtrip,refine,convert,forcegeo,polish,optimize}.oracle.ts` by path; fast sentinels remain in the default suite. Goldens are field-wise and platform-stamp matched where required; missing stamps fail, never skip. Capture/mutation flows, not unit helpers, prove DOM wiring. Keep one shared keyframe interaction path, not per-kind twins. Labs (`tests/*.lab.ts`, `*-lab.html`) run explicitly.
