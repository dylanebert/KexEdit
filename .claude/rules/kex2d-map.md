---
paths:
    - "kex2d/src/**/*"
    - "kex2d/tests/**/*"
---

# kex2d Code Map

Model internals + per-file map for `kex2d/`: the section substrate, the physics, what each module
owns, and the external references. The behavioral contract (authoring models, authoring API,
editing model, hard gotchas, verify) is `kex2d/AGENTS.md` — read it first.

## The section substrate

`section.ts` — the proven original-KexEdit contract (`packages/core`), in 2D. Every section takes
an **entry** anchor (a full state point `{x, y, θ, v}`) and produces sampled points; its last
point IS the next section's entry. Two atomic idioms wrap the oracle-gated physics:

- **`evalGeo(entry, localNodes, dsNominal)`** — geometry → force. The local nodes (node 0 at the
  local origin, heading 0) are placed **rigidly** at the entry frame (rotate by entry θ, translate
  to entry position), sampled to a Hermite curve (`sampleChain`), then the physical force is
  recovered from the geometry (`forces`, `v0 = entry.v`).
- **`evalForce(entry, fN, ds)`** — force → geometry. Seed sample 0 from the entry, `integrate` the
  authored per-edge F_n into the swept geometry, then **re-recover** the display force from that
  geometry.
- **`chain(entry0, sections)`** — thread the sections: each is placed at the prior section's exit,
  its samples appended to one flat SoA, sharing the boundary point (a section's last sample IS the
  next's first). Returns the flat buffers + per-section index `ranges` + `exits`.

Two design laws carried from the original core (both pinned in `tests/section.test.ts`):

- **The force curve is ALWAYS geometry-recovered, even for a force section**. A force section
  integrates the authored F_n, then re-recovers the display force from the swept geometry — so
  there is ONE display path regardless of section kind (mirrors `nodes/force.rs`: integrate from
  targets, store the `Curvature::from_frames`-recovered force). The recovered force sits O(ds) off
  the authored input — the source-vs-centered convention gap (`fvd.lab.ts` panel 3), a derived
  gap, not a bug. `evalForce`'s exit uses the recovered state too, so it matches a geo section's
  recovery exactly.
- **Rigid entry-frame placement**. Geo nodes live in section-local coordinates and the
  substrate places them rigidly at the entry. When an upstream edit moves the anchor, the
  downstream shape translates+rotates rigidly — C1 join guaranteed, shaping preserved. The geometry
  is affine-equivariant (exact to f32); physics (fN) is NOT frame-invariant (gravity picks a world
  frame), so the rigid-invariance test pins positions only.

The section entry is a full world state; a geo section's nodes are **section-local** (node 0 at the
local origin, heading 0). `localize` (the exact inverse of `place`) expresses a world point in the
entry frame — the ECS layer authors handles in world space, so the bake localizes them against the
entry before evaluating. `place(entry, localize(entry, p)) === p`.

f32 throughout — these atoms ARE the realized-track display path, so they use the display recovery
(`bake.forces`), not the f64 solver atoms (`force.ts`).

**Wiring status (stage D):** `track.BakeSystem` walks `sections()` (sorted by `Section.order`),
builds a per-section payload (geo: its section-local nodes; force: `profile.forceProfile` over its
points + extent), and threads them through ONE `chain(START, payloads)` call. It writes the flat
`samples`/`bakeOut` SoA + a per-section `sectionInfo` map (entry, sample range, arclength, orphan
cutoff) the drag/render/convert read. **Geo nodes are stored section-local** (the rigid entry-frame law): `Handle.pos` is
the local coord, node 0 pinned at `{0,0,0}` = the section entry; the bake `place()`s them, so an
upstream edit rigidly carries downstream (the substrate does it — no imperative rebase). Render/pick
read the baked world sample (`samples[Handle.sample]`); only the drag converts world→local
(`localize` against the section entry, identity for the first section). The cart/render/timeline are
kind- and count-agnostic (they read the flat SoA).

## Physics — forward integrator + force recovery

Per-sample state `(x, y, θ, v)`. Semi-implicit Euler in arclength, source-σ convention (F_n sampled
at `σ_i = i·Δs` drives step i → i+1):

```
dθ       = (F_n(σ_i) − cos θ_i) · g · Δs / v_i²
θ_{i+1}  = θ_i + dθ
midθ     = ½(θ_i + θ_{i+1})
x_{i+1}  = x_i + Δs · cos(midθ)
y_{i+1}  = y_i + Δs · sin(midθ)
v_{i+1}² = v_i² − 2g · (y_{i+1} − y_i)
```

Velocity uses the energy-delta (squared) form to avoid catastrophic cancellation. Clamps:
`vSafe = max(|v|, V_FLOOR)` in the dθ formula, `v_next = sqrt(max(v_next², 0))`.

**Force recovery** (`bake.ts forces`, the bake path): positions → per-sample tangent θ → v → F_n.

- `m_i = atan2(y_{i+1} − y_i, x_{i+1} − x_i)` — edge (chord) angle, accumulated *continuously*
  (unwrapped) so θ stays continuous across the ±π branch cut (the cart lerps θ for its orientation)
- `θ_i = ½(m_{i−1} + m_i)` — the curve's local tangent; free ends extrapolate the bisector trend
- `v_i² = v_0² − 2g·(y_i − y_0)` — energy conservation; `v_i = sqrt(max(0, v_i²))`
- `F_n[i] = (θ_{i+1} − θ_i)·vSafe_i² / (g·Δs) + cos(θ_i)` = κ·v²/g + cos θ

`invertRange` (`θ_{i+1} = 2·m_i − θ_i`) is the integrator's exact reflection inverse — round-trip
validation only, NOT the bake (`kex2d/AGENTS.md` Hard gotchas).

Constants: `V_FLOOR` = 0.01 in `forward.ts`; `V_WARN` = 1.0 (diagnostic infeasibility threshold) in
`bake.ts`; `MAX_U_PER_EDGE` = π/24 in `spline.ts`; `MAX_SAMPLES` = 4096 in `track.ts`; `V0` = 10
(the DEFAULT initial speed — now authored per-track as `Track.v0`) in `track.ts`.

## Code map

**Substrate + physics atoms (pure, framework-free, `bun test`-able):**

- `section.ts` — the section substrate (above): `Entry`, `SectionResult`, `Section`, `place` /
  `localize` (the rigid-transform pair), `evalGeo`, `evalForce`, `chain`. f32; consumes
  `sampleChain`/`forces`/`integrate`. `SectionResult.offsets` is the section-local node→sample map
  (geo: node landings; force: the two boundary anchors); `chain` returns per-section `results` too,
  so a caller reads each section's `offsets`/`valid`/`truncated` off the flat SoA. Tested device-free
  in `tests/section.test.ts` (localize↔place inverse, RK4 carry, O(ds) round-trip convergence, rigid
  invariance, chain C0/C1 continuity + energy).
- `forward.ts` — `step` + `integrate`, the forward integrator (F_n → positions). Index 0 pre-set,
  writes `1..count−1`. Drives round-trip validation; not on the geo bake path (that goes the other
  direction, geometry → force). `evalForce` wraps `integrate`.
- `spline.ts` — Hermite interpolation (no shallot import). `sampleChain` (nodes with stored headings
  → positions + per-edge chord `dsArr` + node `offsets`), split into `chainCounts` (adaptive
  per-segment edge-count rule) + `sampleAt` (sample at *given* counts — freezes the sampling
  topology). `reflect` (circular-arc exit heading `2·chord − prev`), `MAX_U_PER_EDGE`. `handle()` is
  the one seam where a node's tangent enters the curve — `Auto` (the arc rule) or `Node.tangent`
  (`TangentMode.Mirror`/`Aligned`/`Free`, an explicit `Tangent`'s stored `in`/`out` vectors) — so
  `Auto` stays byte-identical while an explicit node substitutes its own vector there.
  `autoTangent` exposes the arc-rule vector for the explicit-summon seed; `handleTip`/`editTangent`
  are the handle-drag geometry's forward/inverse (`tangents.ts`'s seam); `alignTangent`/
  `mirrorTangent` re-collinearize a tangent on a mode switch.
- `bake.ts` — `forces` (the bake path: positions → smooth tangent θ → v → physical `F_n`,
  per-edge ds). `invertRange`/`invert` (the exact reflection inverse, round-trip validation only —
  see `kex2d/AGENTS.md` Hard gotchas), `replay` (forward-integrate F_n back to positions). `V_WARN` + re-exports
  `forward`'s `V_FLOOR`.
- `profile.ts` — the FORCE authoring primitive (the force analogue of `spline.ts`): per-segment
  cubic-bezier eval at the handle-resolution seam (`segment`: easing-tag-derived flat tangents via
  the influence table ?? explicit stored; `autoTangent`/`segmentSeed`/`segmentControls` shared
  with the UI), Blender-style x-monotonicity clamp, `sampleForce` (held endpoints, `DEFAULT_G`
  empty) + `forceProfile` (dense per-edge F_n(σ), σ = i·ds, `edges = round(length/ds)`,
  warm-started t-march). Opinion-free: the substrate consumes dense F_n, this builds it from
  authored points. Unit-tested in `tests/profile.test.ts`.

**Invoked conversion/optimization atoms (NOT on the live editor path):**

- `force.ts` — the geometry-primal force atoms, f64. `forces64` (parametrization-invariant
  geometry→force: Menger κ + neighbor-chord tangent + raw unclamped v²) + `forceJacobian` (analytic
  banded ∂F/∂P). Invariance is load-bearing (a fixed-ds difference scheme was measurably gamed).
  Distinct from `bake.ts forces` (f32, the display bake): same chord family, different consumers.
- `banded.ts` — general symmetric-banded LDLᵀ, cross-validated ≤1e-10 against the dense Cholesky
  reference (`tests/helpers/dense.ts`).
- `collocate.ts` — the dense-spine solver kernel (LM Gauss-Newton, PHR augmented-Lagrangian band).
  Kept as reference for general optimization tools; the live path does not call it.
- `fit.ts` — dense recovered force → sparse independent-handle warm start. `fit` supplies the
  full-free oracle; `fitKnots` also supplies fixed-s g values to a flat probe, whose handles are
  stripped before solving. Its cumulative variable-chord frame is `arclength(bake.ds)`.
- `polish.ts` — fixed-knot geometry collocation in two unregularized families. `free` keeps every
  independent handle as the bit-identical numeric-floor oracle. `flat` carries exactly one g DOF
  per key and materializes only `{s,g}`, so every segment is default named Cubic by construction.
  It owns the solve and structural `chordDeficit` reading, not conversion policy.
- `refine.ts` — the **discrete outer refinement** around `polish`: choose WHERE the keys go
  by solving, reading the residual, and moving the knots there, instead of inheriting the
  warm-start fit's (which places knots against the dense force — the wrong target, since
  force error integrates twice). Every warm start is flattened. The loop opens at the two
  endpoints, splits at residual-equidistribution sites until the floor holds, then exhaustively
  probes every interior single-key removal and greedily commits the holding candidate with the
  most slack (lowest key index on a tie). No other structural state exists. Split-while-violated
  against prune-only-while-held is the hysteresis; the loop is deterministic and parameter-free.
  Its shipping geometry constraint is `chordDeficit(spine) + 0.5·LENGTH_STEP_DEFAULT`; the fixed
  default, not the live user preference, keeps conversions deterministic. No shape price or
  continuous authorability mode participates.
  A probe is guarded on a **readable** residual profile, not on convergence — an unconverged
  opening is a waypoint, while any NaN/Inf candidate terminates immediately as `"diverged"` and
  its actual failed knots/profile are logged. `"budget"` instead means no admissible split site
  remains, the sanctioned narrow-feature outcome. Each `RefineEvent` carries the flat probe
  profile of the state it reports, so playback never re-solves a decision.
  **A converted section must carry the solve's own `ds`** (`length/edges`, what `spine` chose so
  the section spans the bake exactly) — a force section stores its own step. Marching
  loop-explicit's same profile at nominal 0.5 m misses the pinned exit by 0.247 m, while the
  realized step closes within 3.1e-5 m (`refine.test.ts`). The locked corpus is 80 keys.
- `census.ts` — the **vocabulary census**: which tangent-mode shape (`mirror`/`aligned`/`broken`/
  `single`) a force keyframe's two handles form. The editor's handle vocabulary is discrete, so
  authorability is a COUNT over it, not a score — and the judgment is screen-space (the `(s, g)`
  axes carry different units, so a data-space angle would be a made-up number), which makes the
  surface's `Scale` part of it. The CLASSIFIER is shared by the fit lab's overlay and the
  conversion tier's oracle asserts; the `Scale` is each caller's own, so a census is a reading of
  a surface and two are comparable only at the same scale. The scale-free question (are a key's
  two handles one line) is `profile.collinear` — a collinear profile still censuses `broken`
  wherever its handles draw under `ALIGN_PX`. Unit-tested in `census.test.ts`.
- `playback.ts` — the fit lab's **playback timeline**: the pipeline's decisions turned into
  frames a scrubber walks (`fitlab.ts` draws them; this decides what they are). Not a kernel
  atom — it solves nothing — but it lives with them because what it asserts is a
  correspondence with what the kernel decided: shipping playback is dense recovery followed by
  exactly one frame and one rendered chip per flat init/split/prune/terminal event, with the final
  event marked as the answer. The `baseline` timeline stays beside it for the full-free
  recover→fit→polish oracle. Force plotting preserves the bake's cumulative variable-chord
  abscissa while solver/frame arrays use their uniform realized step. Unit-tested in
  `playback.test.ts`; the DOM chip order is captured in the fit-lab harness flow.

**ECS + UI layer (the live app):**

- `track.ts` — `BakeSystem` walks `sections()` (by `Section.order`) → per-section payload → one
  `chain(startEntry(v0), payloads)` → the `samples`/`bakeOut` SoA + the `sectionInfo` map; skips on a
  `bakeHash` match (over every section, ds + v0). Components: `Track` (`count`, `ds`, `v0`), `Section` (`id` stable,
  `order`, `kind` `SectionKind.Geo`/`Force`, `length` = force extent), `Handle` (`section`, per-section
  `order`, `sample`, section-local `pos`/`theta`), `Force` (`section`, `id` stable, `s` local, `g`).
  `bakeOut`: per-edge `fN`+`ds`, per-sample `t`/`feasible`, `firstInfeasible`, `hash`. `sectionInfo`
  (by id): `entry`, `startSample`/`endSample`, `bakedNodes` (orphan cutoff). Section helpers:
  `sections`/`sectionAt`/`createSection`. Coordinate lens (section-local `s` ↔ track-global `d`):
  `sectionSpans` (the one offset table) + `toGlobal`/`toLocal` — the single seam every d readout derives from. Geo: `addNode`/`extend`/`reheadOnDrag`/`removeTrailingHandle`/
  `sectionHandles`/`lastHandle`/`handleAt`/`spawnNode`/`nodeSnapshot`/`restoreNodes`/`sameNodes`.
  Tangent: `handleTangent`/`setTangent` (read/write the explicit `Tangent`, `undefined` = `Auto`),
  `seedTangent` (the arc-rule vector at a node, for the explicit-summon seed), `resetTangent`
  (clear a node's tangent back to live; the tip re-heads; skips node 0). No append-time stamping —
  the default flow stores no tangents (`exitHeading` still resolves the append/reflect seed against
  an explicit tip's out-vector). Force:
  `sectionForces`/`forceAt`/`createForcePoint`/`spawnForce`/`destroyForce`/`forcePointState`/
  `setForcePoint`; extent `sectionLengthState`/`setSectionLength`. Kind + structure: `convertSection`,
  `appendSection`/`splitGeo`/`splitForce`/`joinNext`/`deleteSection`, `snapshotSection`/`restoreSection`
  + whole-track `snapshotAll`/`restoreAll`. Initial speed: `trackV0State`/`setTrackV0` (`Track.v0`).
  `startEntry`, `V0`, `EXTEND_DIST`, `MAX_SAMPLES`.
- `cart.ts` — looping cart animation on the *baked* track. `cartState[trackEid]` (`t`, `held`),
  `cartPose` (interps the baked geometry for the box renderer), `forceCurve` (baked F_n as per-sample
  `(s, f)` over cumulative arclength — the chart's distance x-axis), `loopTime`, and **`trackMapping`**
  (the per-sample arclength↔time table over the display bake — the cart's `t`↔chart-`s` projection;
  the cart rides in time, the chart is distance).
- `editor.ts` — ephemeral UI state: `selection` (node), `force` (point id), `section` (id), `start`
  (the track START anchor / v0 handle) + their setters. The four are **mutually exclusive** (selecting
  one clears the others). `tangentEdit` (eid or null) is a sub-mode layered on node selection, NOT a
  fifth exclusive state — entered by double-clicking a node (`enterTangentEdit`, summons its
  handles); a different-subject select, Esc, or click-away exits it (`exitTangentEdit`). Two
  right-click menus: `context` (section Convert/Delete) and `nodeMenu` (the node context menu —
  Handles toggle + Tangents submenu — opened on any pickable node, any mode) — both `{x, y, …}` or
  null, rendered once at the app root. Also the `snap` magnet toggle (`toggleSnap`/`snapActive` — persistent, default on, `S` toggles, Ctrl/Cmd
  bypasses per-gesture) and `hover` (`Surface`, `"viewport" | "timeline"`) — the pointer's current
  surface, routing the surface-scoped keys (`F` frames it, arrows act on it), ending the
  viewport-nudge vs timeline-playhead double-fire. `hoverSection` (a stable `Section.id` or null) is
  the viewport's own hover read — written per pointermove by `controls.pickSection`, drawn one
  kind-color rung up by the track overlay, cleared on pointer leave and for the whole of any gesture
  (`beginDrag`, the one suppression point); viewport-local, never synced with the clip strip's CSS
  hover. Plain singleton, read by Svelte via the per-RAF tick.
- `history.ts` — **one undo/redo stack for the whole editor** (mirrors shallot's editor
  `document/index.ts`): a `Command {apply, reverse}` dual stack (`MAX_UNDO=256`) + a generic
  `begin`/`commit`/`cancel` snapshot gesture (one at a time, so a live drag collapses to one entry).
  Node: `extendTrack`/`trimTrack`/`beginMove`. Force: `createForce`/`deleteForce`/`beginForceMove` +
  `beginLength` (the extent drag). Initial speed: `beginV0` (the v0 field gesture). Kind:
  `convertSection` (per-section, a `snapshotSection` pair).
  Structural: `appendSection`/`splitSection`/`joinSection`/`removeSection` — each a whole-track
  `snapshotAll`/`restoreAll` pair (they reorder sections + move nodes across them). `history` singleton;
  `createHistory` for tests.
- `controls.ts` — `attachControls(canvas, ecs)` wires canvas pointer + window keyboard, returns a
  teardown. `pickNode` (order-0 anchors are pickable, not draggable) then `pickSection` (nearest
  span); a node body click **selects only** — movement enters through `startManip` (the DOM knob
  seam, button 0 only) → `dragManipTo` through the `manipulator.ts` inverses, plus the polar
  arrow-nudge (`polarNudge`, pure: left/right = angle, up/down = length). Right-click a section span
  opens the context menu (`openContext`). Keys: `Enter` extend / `Del` trim (node end); `Del` delete
  (selected section). All edits route through `history`. Also the readout metric seam: `nodeMetrics`
  (pure: node → `{angleLabel?, lengthLabel}`, over the authored `exitWorld` heading + chord) +
  `selectedMetrics` (the impure glue over the baked samples) + the shared formatters
  (`formatDeg`/`formatLen`, one decimal always, −0 normalized, trailing `.0` stripped — the geo
  readout's degree/length funnel, sharing `timeline.ts`'s `fmt` trim, the force readout's funnel).
- `magnet.ts` — the two grid quantizers a manipulator drag resolves through (`snapLength`,
  `snapSteps.length` grid + the `LENGTH_MIN` 1 m floor; `snapAngle`, the `snapSteps.angle` grid) plus
  the incline algebra
  (`inclineOf`/`chordForIncline`) a tip's exit-tangent snap needs. Grid, not magnet: the screen-px
  target pool, `COMBINE_DOT` co-fire, and shift-lock dissolved with the free 2D drag (each gesture
  is 1D now). The name is legacy; fold it into `manipulator.ts` when the 3D port touches it. No
  shallot, no DOM — unit-tested in `magnet.test.ts`.
- `settings.ts` — the **per-user preference home**: load / clamp / save over `localStorage` (one JSON
  object under `SNAP_KEY`), since the prototype has no document to hold a preference. Today the two
  manipulator snap quanta — `snapSteps` (`angle` rad, default 5°, range [1°, 180°]; `length` m,
  default 1, range [0.1, 100]) read LIVE by `magnet.ts`, written by the rail magnet's popover, loaded once in
  `main.ts`. Storage failure is swallowed (a denied `localStorage` never breaks authoring) and every
  read resolves through the clamps — which bound BOTH ends, since a persisted extreme would otherwise
  collapse the control across reloads (recoverability, not precision). Deliberately NOT configurable: the timeline's `S_GRID`/`G_GRID`
  force grids (fixed constants) and `LENGTH_MIN` (the chord floor, a different quantity).
  Unit-tested in `settings.test.ts`.
- `manipulator.ts` — the **polar control substrate**, and the 3D port's template. Pure and
  device-free: the polar frame around the previous node (`polarFrame`, degenerate-chord guarded)
  and the exact screen↔polar inverses each drag resolves through — `screenToLength` projects onto
  the chord ray, `screenToAngle` sweeps the tangential arc (the two control loci; nothing draws
  them, so they're geometry the inverses carry, not their own accessors). The `Frame` is a
  **per-pointermove snapshot** (the incline
  window derives from the live chord radius — freezing it at gesture start diverges from the feel);
  the angle control emits **world-space** radians, the y-flip folded inside, so no consumer negates.
  Unit-tested in `manipulator.test.ts`.
- `radial.ts` — the one home for the summoned ring's geometry (`ringBase`/`ringSlot`/`RadialSlot`):
  a three-button 60° fan off the heading's screen angle — measure (length) −60° · extend 0° · pitch
  (angle) +60°. `App.svelte`'s `.rbtn` buttons and the knob positions both derive from it, so DOM
  and canvas can't drift. Pins in `radial.test.ts`.
- `tangents.ts` — the tangent-handle geometry render and controls share: where a node's in/out
  handles land in screen px (`tangentHandles` — an explicit node's stored vectors, or a selected
  `Auto` node's live arc-rule ghost) and the inverse a handle drag feeds `spline.editTangent`
  (`localTipAt`, the exact inverse of the entry-frame rotation `tangentHandles` applies). A handle
  shows only for a side that drives a segment (no out-handle at a chain end, no handle on node 0) —
  one home for the section-frame convention so render and controls can't drift apart.
- `timeline.ts` — pure transform + tick math for the force-curve timeline (no Svelte/DOM/track
  state). The chart's x-axis is **distance** (meters). `View`, `sToPx`/`pxToS`, `zoomAt`, `clampView`,
  `frameAll`, `niceStep`, `ticks`, the navigator math (`navWindow`/`navDragView`/`marginArc`), and
  `Mapping` + `timeToArc`/`arcToTime` (the arc↔time table `cart.trackMapping` builds). `yFit`/`YFit`
  (auto-fit g-range) + the edge-scroll grow-to-follow: `yGrow` (value drag) and `xGrow` (pan). `snap`
  is the timeline's own axis-aligned resolver for a force-keyframe drag (`Timeline.svelte`); the 2D
  viewport's node/tangent drag has its own polar resolver (`magnet.ts`) — `niceStep` (the 1-2-5 grid
  step) is the piece still shared between them, imported by `render.ts` for the viewport grid.
  Unit-tested in `timeline.test.ts`.
- `Timeline.svelte` — the always-present bottom dock (a flex row: a thin **tool rail** on the left
  edge, then the timeline content column): the **F_n force-curve readout + scrub +
  zoom/pan navigation**, the floating **media player**, and the **section clip strip** in the marker
  lane (one clip per section, kind-colored/labeled; click selects `editor.section`; a `+` tail flyout
  appends geo/force; a force clip's right edge is its **extent trim**; right-click a clip opens the
  context menu). A geo clip also carries **read-only interior-node ticks** (small circles via pure
  `nodeTickPx` partial-`ds` sums, the selected node's highlighted, `pointer-events: none` — entry
  and exit nodes are excluded, they coincide with the clip edges) and **washes** when it owns the
  selected node (the cross-surface context read; a ticked clip's label fades so the two don't
  collide). A node's arclength is derived, so a tick displays and never drags. The **tool rail** (`.tool-rail`) is the snap magnet toggle's home — an icon-only vertical
  strip on the dock's left edge (the Premiere tool-strip precedent), anatomy of the one earned dock,
  bounded to persistent global authoring toggles with a keyboard twin (`toggleSnap`, `S`; today just
  the magnet). **Right-clicking the magnet** summons its increments popover (`.snap-pop`) — the two
  manipulator quanta (angle °, length m) as fields in the shared idiom, written straight to
  `settings.ts` (no history entry: a per-user preference, not track state). It's inside the dock's
  DOM, so it's the timeline surface for `editor.hover`. The chart
  draws the baked F_n curve over arclength + **section boundary guides**
  (dashed verticals); the **ruler** is the scrub zone; wheel zooms, shift+wheel pans; a **navigator**
  minimap pans/zooms. The chart is a **whole-track force-authoring surface**: it draws every force
  section's points (`forcePts`), and a double-click over a force section's arc adds a point there —
  authoring is **by cursor position**, no "active section" (an empty-chart click deselects). Both a
  keyframe drag and the extent trim freeze the view (`yGrow`/`xGrow` edge-scroll past the chart edge,
  resume on release). Conventions: `kexedit/.claude/rules/editor-ui.md`. Takes `ecs`; routes edits
  through `history`.
- `menu.ts` + `Menu.svelte` — `MenuItem` is the shared row-language a menu renders as pure data:
  label, `checked` (a selectable row's accent-lit state, e.g. the current tangent mode), `enabled`
  (derived from editor state, a disabled row dimmed + inert), `shortcut`/`danger`, plus the standard
  shapes `separator` (a divider row) and `children` (a `Tangents ▸` submenu — a hover/click flyout,
  positioned to never cover its parent row and to flip in-viewport). `Menu.svelte` is the ONE
  renderer (recursive for submenus); every menu is an instance of it inside a positioned `.menu`
  wrapper — the section context menu + the node context menu (`App.svelte`) and the timeline's
  append flyout (`Timeline.svelte`). Enablement, separators, and submenus are per-item properties,
  not per-menu special cases.
- `App.svelte` / `render.ts` / `view.ts` — Svelte shell + canvas2D render: grid, the **track**
  polyline (solid feasible blue / dashed infeasible red), section-entry **anchor diamonds**, the
  hover + selected-section span overlays (each in the section's OWN kind color — one rung up under
  the pointer (`hovered`), brightened when selected (`selected`); priority infeasible-red >
  selection > hover > kind, all three stroked through one `strokeFeasible`), the node handles
  (selected/orphan/infeasible), the cart, the
  **Timeline** dock, and the three-button radial ring around the selected node (`radial.ts`: the
  two manipulator knobs flanking extend, the extend button chain-end-only, all hidden in tangent
  edit). In
  tangent-edit mode (`editor.tangentEdit`): `TangentDrawSystem` (`render.ts`) draws the edited
  node's handles (solid = explicit, hollow = `Auto` ghost); right-click any node opens the node
  context menu (`Handles` toggle + a `Tangents ▸` submenu of Mirror | Aligned | Free / Reset, a
  `Menu` over `editor.nodeMenu`, the same shared `.menu` look + cursor placement as the section
  context menu). Snap-guide feedback: the viewport draws the incline **ray** in the shared neutral
  gray (`COLOR_GUIDE_RAY`), the one register every snap guide wears (the timeline's `.snapguide`
  too); the numeric **°/m readout** is DOM — App's `.snap-readout`, the Blender modal-transform
  readout, shown **whenever a node is selected** (the Figma selected-object dimensions idiom): every
  node with a previous node shows its **authored** world exit heading (`exitWorld`, °) + the chord
  (m) to the previous node — the same quantities at rest and mid-drag, never a bake re-derivation
  and never the dragged handle's own geometry. One readout, a three-case precedence: the drag feed
  (`dragReadout`, the dragged node's eid — `App.svelte` re-derives its metrics per RAF post-write,
  so a stitch drag reports the downstream node authoritatively) > the engaged snap labels
  (`snapGuides`) > the resting `selectedMetrics`. It's **centered below the node**, offset by
  `READOUT_OFFSET` (`RADIAL_R + RADIAL_BTN_R + gap`) so it clears the radial ring
  **by construction** — a button center orbits at `RADIAL_R`, its far edge at `RADIAL_R +
  RADIAL_BTN_R`, so the readout starts a gap past that wherever the heading swings the ring. Pure
  `readoutFit` (`view.ts`) places it: centered-then-clamped horizontally, flipped above the node
  near the bottom so it never lands under the timeline dock. (Earlier tries: a chip AT the drag
  point overlapped the buttons; a fixed top-left line read too far from the action.)
- `main.ts` — boots `run({ defaults: false })` + mounts App, and wires the editor's `SelectionHook`
  into `history` (the one place the two meet). The DEV-only `__kex` hook exposes geo state
  (`nodeCount`/`undoDepth`/`tTotal`/`poses`/`selectEnd`/`selectNode`/`selectedOrder`/`nodeAt`/
  `startAt`/`seedHill`/`nudge`), tangent state (`tangent`/`mode`/`inX`/`inY`/`outX`/`outY`/
  `tangentHandles`/`editing`), force state (`kind`/`forceCount`/`forces`/`convert`/`placeForce`/
  `seedForceBump`), the multi-section ops (`sectionCount`/`sectionKinds`/`append`/`deleteAt`/
  `convertAt`), and the read-only VIEW observables a behavior with no honest DOM assert needs —
  `cam` (the whole `[zoom, ox, oy]`, the wheel-guard flow's contract) and `guides` (whether the
  canvas-drawn incline ray is up, plus the two readout labels) — all driven by the capture harness;
  never ships. Screen-space affordances are driven
  pointer-true through the real DOM (`.rbtn`, `.manip-length`, `.manip-angle`), not through hooks.

## References

- **kexedit forward integrator** — `packages/core/src/sim/`. The 3D physics reference. `forward.ts`
  is the 2D forward direction (F_n → positions); `invertRange` is its reverse. Core's node model:
  `nodes/force.rs` is F_n-driven, `nodes/geometric.rs` rate-driven, `track/dispatch.rs::finalize` is
  the section entry-propagation contract `section.ts` mirrors, `copy_path.rs` is the rigid-transform
  replay `evalGeo`'s placement mirrors, `sim/curvature.rs::from_frames` is quaternion-log curvature
  for the 3D port.
- **Houdini / Blender modifier stack** — analogue for lossy bake from parametric authoring into
  canonical dense state.
- **Witkin & Kass 1988, Spacetime Constraints** — parameter-space trajectory optimization with sparse
  user constraints; a reference for later general optimization tools.
