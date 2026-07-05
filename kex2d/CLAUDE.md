# kex2d

2D coaster prototype. Shallot + Svelte + canvas2D. The exploration harness for the
**sections-of-atoms** track model (spec `kex/specs/kex2d-sections.md`): a track is a chain
of **sections**, each one either a **geo** section (author positions → recover force) or a
**force** section (author F_n → integrate geometry), joined by anchor propagation — the
original KexEdit section contract, in 2D. Mouse-driven and direct, parallel to `app/` (the
eventual Shallot port). Whether it replaces / augments / coexists with the 3D editor decides
once it earns its place.

The **live app right now** is geo authoring: free-drag nodes → stored-heading cubic Hermite →
physical F_n force curve, shown live in the timeline. The bidirectional shape↔force integration
is validated exact and oracle-gated (RK4) — the foundation everything builds on. Force authoring
(points on the curve) and multi-section editing are staged next (`kex2d-sections.md` C/D).

**A unified solver is NOT the model.** Three dogfood rounds proved that a solver responsible for
arbitrating authoring intent almost never does what's intended — the author fights it
(`memory/project_kex2d_solver_verdict.md`). The architecture is two deterministic, legible
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
  to entry position — §4), sampled to a Hermite curve (`sampleChain`), then the physical force is
  recovered from the geometry (`forces`, `v0 = entry.v`).
- **`evalForce(entry, fN, ds)`** — force → geometry. Seed sample 0 from the entry, `integrate` the
  authored per-edge F_n into the swept geometry, then **re-recover** the display force from that
  geometry.
- **`chain(entry0, sections)`** — thread the sections: each is placed at the prior section's exit,
  its samples appended to one flat SoA, sharing the boundary point (a section's last sample IS the
  next's first). Returns the flat buffers + per-section index `ranges` + `exits`.

Two design laws carried from the original core (both pinned in `tests/section.test.ts`):

- **The force curve is ALWAYS geometry-recovered, even for a force section** (§2). A force section
  integrates the authored F_n, then re-recovers the display force from the swept geometry — so
  there is ONE display path regardless of section kind (mirrors `nodes/force.rs`: integrate from
  targets, store the `Curvature::from_frames`-recovered force). The recovered force sits O(ds) off
  the authored input — the source-vs-centered convention gap (`fvd.lab.ts` panel 3), a derived
  gap, not a bug. `evalForce`'s exit uses the recovered state too, so it matches a geo section's
  recovery exactly.
- **Rigid entry-frame placement** (§4). Geo nodes live in section-local coordinates and the
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

**Wiring status (stage B):** `track.BakeSystem` bakes the live track through `chain([one geo
section])`. The entry is node 0's world pose (the fixed flat launch anchor, `V0` speed); the handles
are localized into it, so `evalGeo` reproduces their world positions exactly — behavior-identical to
the old direct bake, the proof the substrate carries the live product. Stage C adds a force-section
kind; stage D adds the multi-section data contract.

## Model (geo authoring)

Free-drag authoring, mouse-driven. The **control scheme** and the **representation** are separate:
the controls place free node positions, dragged directly; the canonical representation is the F_n
curve. Each node carries a position (dragged) **and a stored heading θ**, never directly authored —
derived from position by the circular-arc reflection (below). The **first node is a fixed flat
anchor** (θ = 0): the track always launches horizontally. (Generalized by the substrate: node 0 *is*
the section entry.)

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
(launch speed) in `track.ts`.

## Code map

**Substrate + physics atoms (pure, framework-free, `bun test`-able):**

- `section.ts` — the section substrate (above): `Entry`, `SectionResult`, `Section`, `place` /
  `localize` (the §4 rigid-transform pair), `evalGeo`, `evalForce`, `chain`. f32; consumes
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

**Kernel atoms (future optimization tier's reference — NOT on the live path):**

- `force.ts` — the geometry-primal force atoms, f64. `forces64` (parametrization-invariant
  geometry→force: Menger κ + neighbor-chord tangent + raw unclamped v²) + `forceJacobian` (analytic
  banded ∂F/∂P). Invariance is load-bearing (a fixed-ds difference scheme was measurably gamed).
  Distinct from `bake.ts forces` (f32, the display bake): same chord family, different consumers.
- `banded.ts` — general symmetric-banded LDLᵀ, cross-validated ≤1e-10 against the dense Cholesky
  reference (`tests/helpers/dense.ts`).
- `collocate.ts` — the dense-spine solver kernel (LM Gauss-Newton, PHR augmented-Lagrangian band).
  Kept as reference for the deferred optimization tier; the live path does not call it.

**ECS + UI layer (the live geo app):**

- `track.ts` — `BakeSystem` bakes through the substrate: gather node positions + headings from
  sorted handles, derive the entry from node 0, localize the handles into it, `section.chain([one
  geo section])`, copy the flat SoA into `samples`/`bakeOut` and sync each node's `Handle.sample`
  from the section's `offsets`; skip on a hash match. `Handle` carries `order`, `sample`, `pos` (free
  authored position; the curve passes through it exactly), `theta` (exit heading). `bakeOut` carries
  per-edge `fN`+`ds`, per-sample cumulative `t`, `feasible`, `firstInfeasible`, `lastBakedOrder`,
  `hash`. `createTrack` / `addNode` / `extend` / `reheadOnDrag` + `headLast` / `removeTrailingHandle`
  / `sortedHandles` / `lastHandle`. Undo/redo primitives (composed by `history.ts`): `handleAt`,
  `spawnNode`, `nodeSnapshot`/`restoreNodes`/`sameNodes`. `V0` (launch speed), `MAX_SAMPLES`.
- `cart.ts` — looping cart animation on the *baked* track. `cartState[trackEid]` (`t`, `held`),
  `cartPose` (interps the baked geometry for the box renderer), `forceCurve` (baked F_n as per-sample
  `(s, f)` over cumulative arclength — the chart's distance x-axis), `loopTime`, and **`trackMapping`**
  (the per-sample arclength↔time table over the display bake — the cart's `t`↔chart-`s` projection;
  the cart rides in time, the chart is distance).
- `editor.ts` — ephemeral UI state: node `selection` + `select`. No tools, modes, or target state.
  Plain singleton, read by Svelte via the per-RAF tick.
- `history.ts` — **one undo/redo stack for the whole editor** (mirrors shallot's editor
  `document/index.ts`): a `Command {apply, reverse}` dual stack (`MAX_UNDO=256`) + a generic
  `begin`/`commit`/`cancel` snapshot gesture parameterized by closures (one gesture at a time, so a
  live drag collapses to one entry). The track nodes are the recording surface (addressed by stable
  `Handle.order`): `extendTrack`/`trimTrack` + `beginMove`. `history` singleton for the app;
  `createHistory` for tests.
- `controls.ts` — `attachControls(canvas, ecs)` wires canvas pointer + window keyboard, returns a
  teardown (called from App's `onMount`). `pickNode`; pointerdown picks + drags a node (or deselects
  on empty), drag sets `Handle.pos` with a grab offset then `reheadOnDrag`; `Enter` extends, `Del`
  trims when the end is selected. All edits route through `history`.
- `timeline.ts` — pure transform + tick math for the force-curve timeline (no Svelte/DOM/track
  state). The chart's x-axis is **distance** (meters). `View`, `sToPx`/`pxToS`, `zoomAt`, `clampView`,
  `frameAll`, `niceStep`, `ticks`, the navigator math (`navWindow`/`navDragView`/`marginArc`), and
  `Mapping` + `timeToArc`/`arcToTime` (the arc↔time table `cart.trackMapping` builds — the cart
  playhead/scrub projection). `yFit`/`YFit` (the auto-fit g-range). Unit-tested in `timeline.test.ts`.
- `Timeline.svelte` — the always-present bottom dock: the **F_n force-curve readout + scrub +
  zoom/pan navigation**, plus the floating **media player** (play/pause · global scrub · timecode).
  The chart draws the baked F_n curve over arclength (canvas2D); the top **ruler** is the scrub zone
  (click/drag positions the playhead, parks paused on release); wheel zooms, shift+wheel pans; a
  **distance navigator** minimap below the chart pans/zooms the view. Y auto-fits with a sticky
  asymmetric ease. Reads only `cart`/`history`/`track`/`timeline` — no ECS, no target state. (Force
  authoring on the curve returns in stage C.)
- `App.svelte` / `render.ts` / `view.ts` — Svelte shell + canvas2D render: grid, the **track**
  polyline (solid feasible blue / dashed infeasible red), the node handles (selected highlighted,
  orphan/infeasible red), the cart, the **Timeline** dock, and the radial extend/delete buttons
  around the selected chain end.
- `main.ts` — boots `run({ defaults: false })` + mounts App. The DEV-only `__kex` hook exposes
  geo-authoring state (`nodeCount`/`undoDepth`/`tTotal`/`poses`/`selectEnd`/`seedHill`/`nudge`) the
  capture harness drives; never ships.

## Editing model

No tools, no modes — just selection. Click a node to select + drag it freely; click empty space to
deselect. A drag reshapes exactly the two segments sharing the dragged node, no cascade.

- **Free drag** (any node): pointerdown picks the nearest node within `PICK_R` and drags it with a
  grab offset, then `reheadOnDrag` refreshes the last node's heading (first + interior stay frozen).
- **Extend / Delete** (radial buttons around the selected chain end): Extend (＋, along the heading,
  also `Enter`) lays a node continuing the last edge by `EXTEND_DIST`; Delete (🗑, also `Del`) removes
  the trailing node, never below the two nodes a chain needs, re-heading the promoted tip.
- **No insert-on-curve, no interior insertion.** Append/drag/delete only.

## Hard gotchas

- **Input is wired in `onMount`, not a system.** `attachControls(canvas, ecs)` binds the
  canvas/keyboard listeners and returns a teardown App calls on unmount. Don't move this back to a
  `System` with a module-level `attached` flag — that goes stale across a remount (a fresh canvas
  keeps the old flag and never re-binds, so input silently dies).
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
  replay `evalGeo`'s §4 placement mirrors, `sim/curvature.rs::from_frames` is quaternion-log curvature
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
flow` test drives the real UI (seed → extend → undo → reshape) and asserts `window.__kex` state via
`expect.poll` (no sleeps); the lab tests screenshot the atom pages. Self-contained sub-package outside
the project `tsconfig`/`biome`. Drives the host's **real-GPU Chrome via the WSL→Windows bridge**
(shallot's `run()` acquires a WebGPU device even though kex2d is canvas2D). Display-gated.
