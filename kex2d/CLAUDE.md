# kex2d

2D coaster prototype. Shallot + Svelte + canvas2D. The exploration harness for the
**sections-of-atoms** track model: a track is a chain
of **sections**, each one either a **geo** section (author positions → recover force) or a
**force** section (author F_n → integrate geometry), joined by anchor propagation — the
original KexEdit section contract, in 2D. Mouse-driven and direct, parallel to `app/` (the
eventual Shallot port). Whether it replaces / augments / coexists with the 3D editor decides
once it earns its place.

The **live app** is a **multi-section chain**: a track is a sequence of sections, each one geo or
force, joined by anchor propagation. Both atomic idioms author within a section:

- **geo** — free-drag nodes in the viewport → stored-heading cubic Hermite → physical F_n force
  curve, shown live in the timeline.
- **force** — place force points on the timeline curve (filled-diamond keyframes) → linear-interp
  dense F_n(s) → integrate the swept geometry → the *recovered* force curve, shown live.

The bidirectional shape↔force integration is validated exact and oracle-gated (RK4) — the
foundation everything builds on. A section's geo↔force flip is a **destructive convert**: it
resets to that kind's default (force → the empty 1g profile at the default extent; geo
→ the flat two-node seed), made safe by byte-identical undo — no confirm dialog. **Structural ops**
build the chain: append (geo/force at the end), split (a geo section at an interior node, a force
section at an arclength s), join (adjacent same-kind), delete (downstream closes the gap + rebases
rigidly). One open chain — no branching, circuit closure, or mid-chain insertion.

**The track start is a fixed-position anchor**, not a node (`START = {0,0,0,v0}`): what's really
there is an initial-velocity anchor. Its position is fixed (the origin), but the **initial speed
`v0` is authored** — the START diamond is selectable and carries a v0 field popover (m/s), stored
per-track as `Track.v0` (default `V0`, in the bake hash). Not draggable — it draws as a diamond,
distinct from the gold shape handles.

**A unified solver is NOT the model.** Three dogfood rounds proved that a solver responsible for
arbitrating authoring intent almost never does what's intended — the author fights it. The
architecture is two deterministic, legible
atoms — force→geometry and geometry→force — with authoring layers on top; optimization returns
later only as a **scoped, invoked tool** over the atoms (the deferred "conversion/optimization
tier"). The kernel atoms that tier will use — `force.ts`, `banded.ts`, `collocate.ts` + their
tests + the lab pages — stay in-tree, oracle-gated, as its reference; they are NOT on the live
path.

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

## Model (geo authoring)

Free-drag authoring, mouse-driven. The **control scheme** and the **representation** are separate:
the controls place free node positions, dragged directly; the canonical representation is the F_n
curve. Each node carries a **section-local** position (dragged) **and a stored local heading θ**, never
directly authored — derived from position by the circular-arc reflection (below). **Node 0 is the
section entry** — pinned at the local origin `{0,0,0}`, not draggable (the chain seeds it from the
prior section's exit, or `START` for the first). Its world pose = `place(entry, {0,0,0})` = the
entry; the shape hangs off it in the entry frame.

- **Interpolate.** `sampleChain` (`spline.ts`) samples a cubic Hermite curve through every node, the
  tangent **direction** read from each node's stored heading and the tangent **length** scaled by the
  live chord (`|T| = chord·sec²(φ/2)`, the cubic best-fit to a circular arc). Strict local support: a
  drag moves **only the two segments that share the dragged node**. The **last** (heading) node
  carries a standing invariant — its angle is always the reflection of its predecessor's heading — so
  its segment stays a clean arc and its angle never goes stale. It re-derives (`headLast`) whenever
  the tail changes. The **first** node is a fixed flat anchor and **interior** nodes keep their
  heading frozen (the arc contract can't hold on both of an interior node's segments at once, so a
  stable heading beats one that thrashes). A frozen interior heading dragged far off its chord
  bulges — the accepted misshaping.
- **Recover force.** `forces` (`bake.ts`) reads the sampled positions → per-sample tangent θ (the
  curve's local tangent, bisector of adjacent chords) → v (energy) → `F_n = κ·v²/g + cos θ`, the
  physical normal force a cart riding the curve feels. This per-sample θ is recovered from the
  geometry, distinct from the node headings that shape the curve.

The baked force curve is canonical and terminal — the timeline shows exactly what `forces` recovers,
no smoothing or solve on top. The cart rides the baked geometry directly. Lossy bake
(Houdini/Blender modifier-stack analogue): parametric authoring is one-shot, canonical state lives
in the dense baked form.

## Model (force authoring)

The mirror idiom: author the force, integrate the geometry. `Force` points (`{id, s, g}` ECS
entities, stable-id addressed for undo like `Handle.order`) are placed, dragged, and deleted on the
timeline curve. The authoring layer is deliberately minimal: **linear interpolation** between
points, an empty profile is a constant 1g, and the first/last value holds flat beyond it
(`profile.ts sampleForce`). The bake samples this into a dense per-edge F_n(σ) (`forceProfile`, σ =
i·ds source convention) and integrates it (`section.evalForce`) from the section entry.

- **Points are keyframes, not constraints**. Filled diamonds, no drop-line, no driving/driven —
  they're authored *input*, not optimization targets (`editor-ui.md`'s constraints-not-keyframes
  rule governs the deferred optimization tier, not this). The displayed curve is the
  geometry-RECOVERED force (the one-display-path law), so a diamond sits O(ds) off the curve — the authored handle vs the
  recovered display, expected.
- **Extent is the section's own authored length** (`Section.length`, m — distance is the only authoring domain),
  NOT inherited from the geo shape a convert came from: a convert (or an append) **resets** it to
  `DEFAULT_FORCE_LEN`. It's then editable — the **force clip's right edge** in the timeline marker
  lane (`ew-resize`) resizes the profile (`setSectionLength`, floored at `MIN_FORCE_LEN`, one undo
  entry via `history.beginLength`). Shortening below a point's s just stops
  sampling there (non-destructive — the point persists, re-lengthening restores it).

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
validation only, NOT the bake (Hard gotchas).

Constants: `V_FLOOR` = 0.01 in `forward.ts`; `V_WARN` = 1.0 (diagnostic infeasibility threshold) in
`bake.ts`; `MAX_U_PER_EDGE` = π/24 in `spline.ts`; `MAX_SAMPLES` = 4096 in `track.ts`; `V0` = 10
(the DEFAULT initial speed — now authored per-track as `Track.v0`) in `track.ts`.

## Authoring API — the substrate is the agent surface

Authored state — everything that *defines* the track — lives in ECS components in `track.ts`, and
only there. The UI reads it through the per-RAF tick and writes it only through the `track.ts`
setters, each wrapped in a `history` gesture. That is the purity contract, and it is the surface a
future authoring agent drives — the same one the capture harness pokes through `__kex`.

**The authored components (the one source of truth):** `Track` (`count`, `ds`, `v0`), `Section`
(`id`, `order`, `kind`, `length`), `Handle` (geo node: `section`, `order`, section-local
`pos`/`theta`), `Force` (keyframe: `section`, `id`, section-local `s`, `g`). Everything else is
derived or ephemeral: `samples`/`bakeOut`/`sectionInfo` are `BakeSystem` output (recomputed, never
authored); `editor.ts` holds selection + context-menu state; the Svelte `$state` (view pan/zoom,
drag-in-flight, flyouts) is view state. `render.ts` and `cart.ts` read, never write.

**Write only through the setters, only inside a history gesture.** `history` is one undo/redo stack
(`begin`/`commit`/`cancel`; one gesture at a time, so a live drag collapses to one entry). Two
disciplines:

- *Structural / one-shot* ops snapshot internally — call them bare: `appendSection`, `removeSection`,
  `convertSection`, `extendTrack`, `trimTrack`, `createForce`, `deleteForce`.
- *Continuous* edits (drags, label scrubs, typed fields) bracket by hand — `begin*` → `set*`
  (repeated) → `commit(history)`, `cancel()` on interrupt: `beginMove`+`Handle.pos.set`,
  `beginForceMove`+`setForcePoint`, `beginLength`+`setSectionLength`, `beginV0`+`setTrackV0`.

Never mutate an authored component from a Svelte component or a read/render path — that divorces the
edit from undo and from the single source of truth. The one deliberate exception is the DEV-only
`__kex` hook (`main.ts`, never ships), whose `nudge`/`seedHill` poke components raw as test *setup*,
not authoring.

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
  topology). `reflect` (circular-arc exit heading `2·chord − prev`), `MAX_U_PER_EDGE`.
- `bake.ts` — `forces` (the bake path: positions → smooth tangent θ → v → physical `F_n`,
  per-edge ds). `invertRange`/`invert` (the exact reflection inverse, round-trip validation only —
  see Hard gotchas), `replay` (forward-integrate F_n back to positions). `V_WARN` + re-exports
  `forward`'s `V_FLOOR`.
- `profile.ts` — the FORCE authoring primitive (the force analogue of `spline.ts`): `sampleForce`
  (linear interp of points, held endpoints, `DEFAULT_G` empty) + `forceProfile` (dense per-edge
  F_n(σ), σ = i·ds, `edges = round(length/ds)`). Opinion-free: the substrate consumes dense
  F_n, this builds it from authored points. Unit-tested in `tests/profile.test.ts`.

**Kernel atoms (future optimization tier's reference — NOT on the live path):**

- `force.ts` — the geometry-primal force atoms, f64. `forces64` (parametrization-invariant
  geometry→force: Menger κ + neighbor-chord tangent + raw unclamped v²) + `forceJacobian` (analytic
  banded ∂F/∂P). Invariance is load-bearing (a fixed-ds difference scheme was measurably gamed).
  Distinct from `bake.ts forces` (f32, the display bake): same chord family, different consumers.
- `banded.ts` — general symmetric-banded LDLᵀ, cross-validated ≤1e-10 against the dense Cholesky
  reference (`tests/helpers/dense.ts`).
- `collocate.ts` — the dense-spine solver kernel (LM Gauss-Newton, PHR augmented-Lagrangian band).
  Kept as reference for the deferred optimization tier; the live path does not call it.

**ECS + UI layer (the live app):**

- `track.ts` — `BakeSystem` walks `sections()` (by `Section.order`) → per-section payload → one
  `chain(startEntry(v0), payloads)` → the `samples`/`bakeOut` SoA + the `sectionInfo` map; skips on a
  `bakeHash` match (over every section, ds + v0). Components: `Track` (`count`, `ds`, `v0`), `Section` (`id` stable,
  `order`, `kind` `SectionKind.Geo`/`Force`, `length` = force extent), `Handle` (`section`, per-section
  `order`, `sample`, section-local `pos`/`theta`), `Force` (`section`, `id` stable, `s` local, `g`).
  `bakeOut`: per-edge `fN`+`ds`, per-sample `t`/`feasible`, `firstInfeasible`, `hash`. `sectionInfo`
  (by id): `entry`, `startSample`/`endSample`, `bakedNodes` (orphan cutoff). Section helpers:
  `sections`/`sectionAt`/`createSection`. Geo: `addNode`/`extend`/`reheadOnDrag`/`removeTrailingHandle`/
  `sectionHandles`/`lastHandle`/`handleAt`/`spawnNode`/`nodeSnapshot`/`restoreNodes`/`sameNodes`. Force:
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
  one clears the others). Plain singleton, read by Svelte via the per-RAF tick.
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
  teardown. `pickNode` (skips order-0 anchors) then `pickSection` (nearest span); a node drag
  `localize`s the pointer into the section frame then `reheadOnDrag`. Right-click a section span opens
  the context menu (`openContext`). Keys: `Enter` extend / `Del` trim (node end); `a`/`A` append
  geo/force; `Del` delete (selected section). All edits route through `history`.
- `timeline.ts` — pure transform + tick math for the force-curve timeline (no Svelte/DOM/track
  state). The chart's x-axis is **distance** (meters). `View`, `sToPx`/`pxToS`, `zoomAt`, `clampView`,
  `frameAll`, `niceStep`, `ticks`, the navigator math (`navWindow`/`navDragView`/`marginArc`), and
  `Mapping` + `timeToArc`/`arcToTime` (the arc↔time table `cart.trackMapping` builds). `yFit`/`YFit`
  (auto-fit g-range) + the edge-scroll grow-to-follow: `yGrow` (value drag) and `xGrow` (pan). Unit-
  tested in `timeline.test.ts`.
- `Timeline.svelte` — the always-present bottom dock: the **F_n force-curve readout + scrub +
  zoom/pan navigation**, the floating **media player**, and the **section clip strip** in the marker
  lane (one clip per section, kind-colored/labeled; click selects `editor.section`; a `+` tail flyout
  appends geo/force; a force clip's right edge is its **extent trim**; right-click a clip opens the
  context menu). The chart draws the baked F_n curve over arclength + **section boundary guides**
  (dashed verticals); the **ruler** is the scrub zone; wheel zooms, shift+wheel pans; a **navigator**
  minimap pans/zooms. The chart is a **whole-track force-authoring surface**: it draws every force
  section's points (`forcePts`), and a double-click over a force section's arc adds a point there —
  authoring is **by cursor position**, no "active section" (an empty-chart click deselects). Both a
  keyframe drag and the extent trim freeze the view (`yGrow`/`xGrow` edge-scroll past the chart edge,
  resume on release). Conventions: `kexedit/.claude/rules/editor-ui.md`. Takes `ecs`; routes edits
  through `history`.
- `App.svelte` / `render.ts` / `view.ts` — Svelte shell + canvas2D render: grid, the **track**
  polyline (solid feasible blue / dashed infeasible red), section-entry **anchor diamonds**, the
  selected-section accent overlay, the node handles (selected/orphan/infeasible), the cart, the
  **Timeline** dock, and the radial extend/delete buttons around the selected chain end.
- `main.ts` — boots `run({ defaults: false })` + mounts App. The DEV-only `__kex` hook exposes
  geo state (`nodeCount`/`undoDepth`/`tTotal`/`poses`/`selectEnd`/`seedHill`/`nudge`), force state
  (`kind`/`forceCount`/`forces`/`convert`/`placeForce`/`seedForceBump`), and the multi-section ops
  (`sectionCount`/`sectionKinds`/`append`/`splitAt`/`joinAt`/`deleteAt`/`convertAt`) the capture
  harness drives; never ships.

## Editing model

A track is a chain of sections; each is geo or force, authored by its idiom (below). Direct
manipulation, no sub-tools. Four mutually-exclusive selections (`editor.ts`): a node, a force
point, a whole section, or the START anchor (the initial-speed handle) — selecting one clears the
others, so a key press never fights over its target. Section selection is a **highlight + the context-menu target only**; it never gates
authoring (force points are added by cursor position, nodes dragged in the viewport).

**Geo authoring** (within a geo section) — author the shape in the viewport. Click a node to select
+ drag it freely (`localize`d into the section frame); click empty space to deselect. A drag
reshapes exactly the two segments sharing the dragged node. Node 0 is the pinned entry anchor — not
pickable.

- **Free drag** (any non-anchor node): pointerdown picks the nearest node within `PICK_R`, drags it
  with a grab offset, then `reheadOnDrag` refreshes the last node's heading (node 0 + interior stay frozen).
- **Extend / Delete** (radial buttons around the selected chain end): Extend (＋, along the heading,
  also `Enter`) lays a node continuing the last edge by `EXTEND_DIST`; Delete (🗑, also `Del`) removes
  the trailing node, never below the two nodes a section needs, re-heading the promoted tip.

**Force authoring** (on the timeline chart, whole-track) — the chart draws every force section's
points at once. Double-click over a force section's arc places a point at the authored profile's
value (insertion never bends the curve; the section is resolved from the cursor arclength, no
selection needed); drag a diamond in both axes (horizontal = s, vertical = g; `Shift` locks the
dominant axis); `Del` removes, `Esc` deselects; the popover at the selected diamond types or scrubs
its s/g. Points are authored section-local (s from the section entry) but drawn at their section's
whole-track cumulative offset. Keyframes, not constraints. Interaction conventions: `editor-ui.md`.

**Section ops** (the multi-section chain) — select a section by clicking its **clip** in the timeline
marker lane (or its viewport polyline span); a force clip's right edge is its extent trim, and a `+`
tail after the last clip appends (geo/force flyout, also `a`/`A`). **Right-click a clip or span** for
the context menu: Convert (destructive geo↔force, undoable) + Delete (`Del`). Split and join left the
editor — deferred to the conversion/optimization tier (the substrate `splitGeo`/`splitForce`/
`joinNext` + tests stay in-tree as its reference). Boundary anchors draw as viewport diamonds + chart
vertical guides. One open chain — no branching, circuit closure, or mid-chain insertion. All ops undo
via a whole-track snapshot pair (byte-identical).

## Hard gotchas

- **Input is wired in `onMount`, not a system.** `attachControls(canvas, ecs)` binds the
  canvas/keyboard listeners and returns a teardown App calls on unmount. Don't move this back to a
  `System` with a module-level `attached` flag — that goes stale across a remount (a fresh canvas
  keeps the old flag and never re-binds, so input silently dies).
- **Two window-keydown handlers, disambiguated by selection.** `controls.ts` (node + section keys)
  and `Timeline.svelte` (force-point Del/Esc) both listen on `window`. They don't check kind — each
  guards on its OWN live selection (`editor.selection` / `editor.section` / `editor.force`), which are
  mutually exclusive (`editor.ts` clears the others on select). Keep that guard: a kind check instead
  could double-fire.
- **A single force point holds its value everywhere** (endpoint hold), so one point can't make a
  *dip* — it's a constant. A localized airtime bump needs three (1g shoulders + the crest). The empty
  profile is a flat `DEFAULT_G` (1g), so a fresh geo→force convert is a straight level track.
- **The track start is a fixed-position `startEntry` anchor at the origin** (initial speed
  `Track.v0`, default `V0`; authored via the selectable START diamond's popover), not a node — a
  geo→force convert carries no geo start position (the convert is destructive; position is cosmetic). The force
  **extent resets** to `DEFAULT_FORCE_LEN` on convert/append (not inherited from the geo arclength),
  then editable via the end handle.
- **The bake uses `forces`, not `invertRange`.** `invertRange` is the *exact* reflection inverse of
  the forward integrator (`θ_{i+1} = 2·m_i − θ_i`). It carries a leapfrog "computational mode": a
  marginally-stable ±(−1)^i tangent oscillation. On positions the integrator itself produced it
  cancels to zero (round-trip exact), but on a varying-curvature curve the mode is excited and **F_n
  sawtooths sample-to-sample**. `forces` recovers θ as the chord bisector instead, which has no such
  mode. Don't switch `BakeSystem` (or `section.evalGeo`/`evalForce`'s recovery) to `invertRange`.
- **`forces` accumulates a *continuous* chord angle.** It unwraps the per-edge chord angle before
  taking the tangent bisector, so θ stays continuous across the ±π atan2 branch cut. The cart lerps θ
  for its orientation, so a raw-`atan2` θ would spin the cart a full turn when the heading crosses
  ±π. A `bake.test.ts` test guards this.
- **Node headings (`Handle.theta`) are stored authored state — keep them out of the bake.** The
  bake's per-sample θ is a separate quantity, recovered from the sampled geometry (chord bisector).
  Don't (a) make the bake read `Handle.theta`; (b) reintroduce a `Track.theta0` entry angle — node 0's
  flat anchor *is* the entry (and in the substrate, the section entry); (c) switch `sampleChain` back
  to inferring tangents from neighbor positions each bake (Catmull-Rom) — that breaks two-segment
  locality.
- **`sampleChain` per-edge ds is the exact chord.** `dsArr[i] = |P_{i+1} − P_i|`. A near-coincident
  segment or `MAX_SAMPLES` truncation commits the prefix + orphans trailing nodes.
- **A force section's exit is the geometry-RECOVERED state, not the integrator's.** `evalForce`
  integrates, then re-runs `forces` and reads the exit off THAT — so a force section joins the next
  section at the visible-tangent heading, matching a geo section. Don't thread the raw integrator
  `theta`/`v` as the exit (it would introduce an O(ds) heading kink at the boundary).
- **Chain sections share the boundary sample.** `chain` copies each section's points `1..edges`
  (point 0 is the prior section's exit, already written). The shared index carries the prior exit
  state, which is exactly this section's placement — C0/C1 by construction. Don't double-write it.
- **Forward clamps are non-differentiable.** `vSafe` / `sqrt` kink at the boundary. The floor is
  tiny, so coasting past an infeasible region behaves like "cart paused at peak then continued."
- **Quaternion DOF (when 3D lands).** Unit-norm constraint. Use the log-map (axis-angle delta) as the
  local update variable, matching `sim/curvature.rs::angular_delta_from`.

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
  user constraints; a reference for the deferred optimization tier.

## Verify

```bash
cd kex2d && bun check && bun test
cd kex2d && bun run capture   # UI screenshots → harness/shots/ (display-gated)
```

f64 mirror for tests: `tests/helpers/forward64.ts`. Independent physics check: `tests/oracles/rk4.ts`
(time-parameterized RK4 — a different scheme + parameterization). Physics is gated against the
oracle, not self-consistency.

Investigation labs (run explicitly, not part of `bun test`) — the kernel-atom / future-tier
reference: `tests/geometry.lab.ts`, `tests/collocate.lab.ts`, `tests/loop.lab.ts`,
`tests/conditioning.lab.ts`, `tests/fvd.lab.ts`, `tests/hill.lab.ts`. Visual counterparts
`geometry-lab.html` + `collocate-lab.html` + `loop-lab.html` + `fvd-lab.html` (canvas2D, captured by
the harness).

The ECS + substrate layers are covered device-free: `tests/section.test.ts` (the substrate),
`tests/track.test.ts` + `tests/cart.test.ts` (`BakeSystem`, cart on a bare `State` via the
scheduler). The `tests/setup.ts` enum-shim preload (`bunfig.toml`) lets them import the shallot barrel
with no GPU device; the unit suite is canvas2D + device-free, no real-GPU leg.

`harness/` — Playwright harness (`bun run capture` → `harness/shots/`, gitignored). The `geo authoring
flow` test drives the real UI (seed → extend → undo → reshape) and the `force authoring flow` test
(seed → real mode-toggle convert → author a bump by points → convert back → undo) assert
`window.__kex` state via `expect.poll` (no sleeps); the lab tests screenshot the atom pages. Self-contained sub-package outside
the project `tsconfig`/`biome`. Drives the host's **real-GPU Chrome via the WSL→Windows bridge**
(shallot's `run()` acquires a WebGPU device even though kex2d is canvas2D). Display-gated.
