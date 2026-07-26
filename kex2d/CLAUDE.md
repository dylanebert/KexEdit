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

- **geo** — author node positions in the viewport (polar length/angle manipulators) →
  stored-heading cubic Hermite → physical F_n force curve, shown live in the timeline.
- **force** — place force points on the timeline curve (filled-diamond keyframes, easing-tagged,
  optional explicit handles) → per-segment cubic-bezier dense F_n(s) → integrate the swept
  geometry → the *recovered* force curve, shown live.

The bidirectional shape↔force integration is validated exact and oracle-gated (RK4) — the
foundation everything builds on. A section's geo↔force flip is a **destructive convert**: it
resets to that kind's default (force → two seed keyframes continuing the entry force, at the
default extent; geo
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

**Positions and force keyframes are the two authoring substrates** — both sparse, density
unbounded; the dense baked chain is always derived, never canonical (dense-vs-sparse is a false
dichotomy: a dense array is a keyframe list at maximum density). Rate/pitch-speed keyframes as a
geometry substrate are rejected: rates integrate, so the encoding has global support and
single-shooting conditioning (measured σ(∂P/∂F) ~ N^1.54 vs N^0.00 for positions), and every
non-graph tool would pay a fit-through-the-integrator per gesture. Graph editing of geometry is
served as a derived view or an invoked fit at the optimization tier, never as the store.

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

Manipulator authoring, mouse-driven. The **control scheme** and the **representation** are separate:
the controls place node positions through two snapped 1D polar controls around the previous node
(length on a 1 m grid with a 1 m floor, angle on a 5° grid — both increments per-user configurable,
`settings.ts`; Ctrl bypasses both to continuous), body click being select-only; the canonical representation is the F_n curve. Each node carries a
**section-local** position and a tangent — **live-inferred**
(`Auto`, the default: no stored vectors, direction from `Handle.theta` via the arc rule) or
**explicit** (stored `in`/`out` vectors, the summoned inner layer, below). **Node 0 is the section
entry** — pinned at the local origin `{0,0,0}`, not draggable (the chain seeds it from the prior
section's exit, or `START` for the first). Its world pose = `place(entry, {0,0,0})` = the entry; the
shape hangs off it in the entry frame.

- **Interpolate.** `sampleChain` (`spline.ts`) samples a cubic Hermite curve through every node —
  `handle()` reads a node's tangent: `Auto` via the arc rule (direction `Handle.theta`, length
  scaled by the live chord, `|T| = chord·sec²(φ/2)`, the cubic best-fit to a circular arc); explicit
  via its stored vector, held absolute under a node drag (the Figma/Blender bezier convention — no
  chord rescaling). Strict local support either way: a drag or a tangent edit moves **only the two
  segments that share the node**.
- **The default shaping is live everywhere — byte-identical to the pre-handles editor.** Nothing is
  stamped at append (the round-2 reversal): the default add/extend/drag flow stores **no** tangents.
  The **last** node's heading tracks its predecessor's exit (`headLast`, the reflection `2·chord −
  prev`), re-deriving whenever the tail changes, so a fresh append or drag never goes stale; node 0
  and **interior** `Auto` nodes keep a frozen heading (the arc contract can't hold on both of an
  interior node's segments at once, so a stable heading beats one that thrashes — dragged far off its
  chord it bulges, the accepted misshaping). A node turns concrete bezier **only** when explicitly
  authored — a handle drag or a mode set (seeded from the live arc-rule vectors via `seedTangent`, no
  jump). Handles are additive; they never change the default feel.
- **Explicit tangent modes** (`TangentMode`, Figma's mirroring taxonomy): `Mirror` (angle + length
  mirrored, one authored handle) | `Aligned` (angle mirrored, per-side length) | `Free` (independent
  — a corner, C0 kink, becomes expressible). An **inferred** node displays as `Aligned` (inference is
  aligned-shaped — collinear in/out — and there is never a no-mode state); re-picking `Aligned` on it
  is a no-op. `setTangent`/`handleTangent` (`track.ts`) are the read/write surface. **Reset**
  (`resetTangent`) clears back to live (`Auto` inference resumes) — meaningful for interiors too, now
  that they're live by default. Node 0 (position pinned) carries a single **free** out-handle — the
  entry handle; `resetTangent` clears it back to the `Auto` C1 exit along the entry heading.
- **Summoned, not default.** Handles render only in **tangent-edit mode**, entered by
  double-clicking a node (`editor.tangentEdit`, layered on node selection — Esc or click-away exits);
  mere selection shows nothing (`editor-ui.md`'s layered-expressiveness contract — the inner layer is
  reachable, never ambient). A handle drag is a **free** direct-manipulation gesture (no raster, no
  guides) with one landmark, the grab-ray angle latch (`latchAngle`, a `LATCH_PX` perpendicular
  corridor — pull out to lengthen without bumping the angle). The **node context menu** is a **right-click on any pickable node** (any mode, not only
  in tangent edit — the app's context-menu language, `menu.ts` `MenuItem` + `editor.nodeMenu`): the
  structural ops `Delete` then `Add` (chain-end, enablement-gated; ordered by access frequency, and
  terse because the menu is *on* the node — the noun would restate its subject), a `Handles` toggle
  (≡ the double-click tangent-edit summon) over a `Tangents ▸` submenu (Mirror | Aligned | Free, a separator, then
  Reset). Node 0 is reachable: right-click or double-click at the START diamond reaches the first
  section's node 0 (its menu is Handles + Reset only — no mode submenu, no Add/Delete); a geo→geo
  boundary's node 0 is reached by tangent-editing the coincident upstream tip (the stitch).
- **Recover force.** `forces` (`bake.ts`) reads the sampled positions → per-sample tangent θ (the
  curve's local tangent, bisector of adjacent chords) → v (energy) → `F_n = κ·v²/g + cos θ`, the
  physical normal force a cart riding the curve feels. This per-sample θ is recovered from the
  geometry, distinct from the node tangents that shape the curve.

The baked force curve is canonical and terminal — the timeline shows exactly what `forces` recovers,
no smoothing or solve on top. The cart rides the baked geometry directly. Lossy bake
(Houdini/Blender modifier-stack analogue): parametric authoring is one-shot, canonical state lives
in the dense baked form.

## Model (force authoring)

The mirror idiom: author the force, integrate the geometry. `Force` points (`{id, s, g}` + easing
tag + optional explicit per-side tangents, ECS entities, stable-id addressed for undo like
`Handle.order`) are placed, dragged, and deleted on the timeline curve. Every segment between
adjacent keyframes is a **cubic bezier in (s, g)** resolved at one seam (`profile.segment`): each
side derives flat tangents from the *leading* keyframe's easing tag (influence Linear 0 |
Cubic 1/3 | Quintic 7/15 — Cubic is exact smoothstep) unless an explicit stored tangent overrides
it; Custom is derived provenance (explicit tangents bound the segment), never a stored flag.
Append/convert **seed two keyframes continuing the recovered entry force**; deleted down to empty
falls back to constant `DEFAULT_G`, and the first/last value holds flat beyond (`profile.ts
sampleForce`). The bake samples this into a dense per-edge F_n(σ) (`forceProfile`, σ =
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

**Two coordinate frames, one lens.** Position-along-track has two names for two jobs:

- **`s` — section-local arclength** (meters from the section entry). The *storage and kernel*
  frame: `Force.s`, geo `Handle` locals, and every `ds`-integral read `s`. Keyframes are addressed
  relative to their owning section, so they **ride with it** — an upstream edit (a length change, a
  convert) re-times the ride and shifts everything downstream, but never rewrites a downstream
  section's stored `s`. This is the sections-of-atoms self-containment invariant.
- **`d` — track-global distance** (meters from the track start, the timeline ruler's axis). The
  *author-facing* frame: the force-point field, every position readout, and the agent contract
  address in `d`. A single section spans the d-interval `[offset, offset + len]`.

The one seam between them is the affine lens in `track.ts` (`sectionSpans` + `toGlobal`/`toLocal`):
a section's global `offset` is the cumulative baked arclength of every upstream section, `d = offset
+ s`, and `toLocal` inverts a global `d` back to `(section, local s)` (a shared boundary resolves to
the **upstream** section — left/exit-inclusive, matching the clip strip and cart park). Every d
readout derives here — nothing re-walks the baked `ds`. Store `s`; show and accept `d`; convert only
at the lens. `t`/time is NOT this axis (it's derived, `t = ∫ ds/v`, and stretches under solves — the
editor-ui invariant-domain rule).

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
  see Hard gotchas), `replay` (forward-integrate F_n back to positions). `V_WARN` + re-exports
  `forward`'s `V_FLOOR`.
- `profile.ts` — the FORCE authoring primitive (the force analogue of `spline.ts`): per-segment
  cubic-bezier eval at the handle-resolution seam (`segment`: easing-tag-derived flat tangents via
  the influence table ?? explicit stored; `autoTangent`/`segmentSeed`/`segmentControls` shared
  with the UI), Blender-style x-monotonicity clamp, `sampleForce` (held endpoints, `DEFAULT_G`
  empty) + `forceProfile` (dense per-edge F_n(σ), σ = i·ds, `edges = round(length/ds)`,
  warm-started t-march). Opinion-free: the substrate consumes dense F_n, this builds it from
  authored points. Unit-tested in `tests/profile.test.ts`.

**Kernel atoms (future optimization tier's reference — NOT on the live path):**

- `force.ts` — the geometry-primal force atoms, f64. `forces64` (parametrization-invariant
  geometry→force: Menger κ + neighbor-chord tangent + raw unclamped v²) + `forceJacobian` (analytic
  banded ∂F/∂P). Invariance is load-bearing (a fixed-ds difference scheme was measurably gamed).
  Distinct from `bake.ts forces` (f32, the display bake): same chord family, different consumers.
- `banded.ts` — general symmetric-banded LDLᵀ, cross-validated ≤1e-10 against the dense Cholesky
  reference (`tests/helpers/dense.ts`).
- `collocate.ts` — the dense-spine solver kernel (LM Gauss-Newton, PHR augmented-Lagrangian band).
  Kept as reference for the deferred optimization tier; the live path does not call it.
- `census.ts` — the **vocabulary census**: which tangent-mode shape (`mirror`/`aligned`/`broken`/
  `single`) a force keyframe's two handles form. The editor's handle vocabulary is discrete, so
  authorability is a COUNT over it, not a score — and the judgment is screen-space (the `(s, g)`
  axes carry different units, so a data-space angle would be a made-up number), which makes the
  surface's `Scale` part of it. The CLASSIFIER is shared by the fit lab's overlay and the
  conversion tier's oracle asserts; the `Scale` is each caller's own, so a census is a reading of
  a surface and two are comparable only at the same scale. The scale-free question (are a key's
  two handles one line) is `profile.collinear` — a collinear profile still censuses `broken`
  wherever its handles draw under `ALIGN_PX`. Unit-tested in `census.test.ts`.

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

## Editing model

A track is a chain of sections; each is geo or force, authored by its idiom (below). Direct
manipulation, no sub-tools. Four mutually-exclusive selections (`editor.ts`): a node, a force
point, a whole section, or the START anchor (the initial-speed handle) — selecting one clears the
others, so a key press never fights over its target. Section selection is a **highlight + the context-menu target only**; it never gates
authoring (force points are added by cursor position, nodes dragged in the viewport).

**Geo authoring** (within a geo section) — author the shape in the viewport. Click a node to select
it; click empty space to deselect. Movement is the two manipulators, never a free body drag; a move
reshapes exactly the two segments sharing the node. Node 0 is the pinned entry anchor — selectable
(for its entry handle), never movable.

- **The manipulators** (the two knobs on the selected node's ring): **length** along the chord from
  the previous node, **angle** along the circle through the node centered on the previous node.
  Dragged (pointerdown on the knob captures the pointer, past the `DRAG_PX` dead zone) or
  arrow-nudged (left/right = angle, up/down = length). A **drag** is purely snapped — the 5° and 1 m
  grids, both per-user configurable off the rail magnet's popover (`settings.ts`), Ctrl/Cmd bypasses
  to continuous. A **nudge** is not on those grids: it steps by a fixed screen-px increment
  (`NUDGE_PX`, `NUDGE_PX_COARSE` with Shift) converted through the camera zoom, so the keyboard moves
  by a constant on-screen distance whatever the snap increments are. Both go
  through `reheadOnDrag` refreshing the last node's heading after
  the write (node 0 + interior stay frozen). A body drag does nothing but select.
- **Append / Delete**: append lays a node continuing the last edge by `EXTEND_DIST` — the ring's
  extend button (slot 0, chain-end only), `Enter`, or the node menu's `Add`; delete removes the
  trailing node — `Del`/`Backspace` or the node menu's `Delete`, never below the two nodes a section needs,
  resetting-then-re-heading the promoted tip (the role-transition law, `editor-ui.md`).
- **Tangent edit** (double-click any handled node): summons its in/out handles (hidden on mere
  selection, and the manipulator knobs hide while it's open), dragged freely with the grab-ray angle
  latch. The **node context menu** (right-click any pickable node, any mode) carries the `Handles`
  summon toggle + a `Tangents ▸` submenu (mode Mirror/Aligned/Free + Reset). Esc or clicking away
  exits back to plain selection. Model + substrate: `Model (geo authoring)` above.

**Force authoring** (on the timeline chart, whole-track) — the chart draws every force section's
points at once. Double-click over a force section's arc places a point at the authored profile's
value (insertion never bends the curve; the section is resolved from the cursor arclength, no
selection needed); drag a diamond in both axes (horizontal = s, vertical = g — the always-on
per-axis gesture-start magnet is the single-axis affordance, so there's no `Shift` lock; `Ctrl`/`Cmd`
frees values but not that magnet); `Del` removes, `Esc` deselects; the popover at the selected diamond types or scrubs
its s/g. Points are authored section-local (s from the section entry) but drawn at their section's
whole-track cumulative offset. Keyframes, not constraints. Interaction conventions: `editor-ui.md`.

**Section ops** (the multi-section chain) — select a section by clicking its **clip** in the timeline
marker lane (or its viewport polyline span); a force clip's right edge is its extent trim, and a `+`
tail after the last clip appends (geo/force flyout). **Right-click a clip or span** for
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
- **Never hold a raw eid across a snapshot restore.** `restoreSection`/`restoreAll` destroy and
  respawn a section's nodes and the eid allocator recycles LIFO, so a held eid remaps to a
  DIFFERENT node — hold the stable `(section, order)` instead. The injected **`SelectionHook`**
  (`editor.selectionHook`, wired at boot via `setSelectionHook`) is the seam every restore flows
  through: history snapshots selection per entry (the pre-state captured by the op *before* a
  destructive mutate, the post-state lazily on first undo) and the hook re-resolves it by stable
  form, then closes the node menu (whose rows go stale on any restore). History never imports
  editor — the coupling is inverted at that seam. `withReconcile` is deleted.
- **A single force point holds its value everywhere** (endpoint hold), so one point can't make a
  *dip* — it's a constant. A localized airtime bump needs three (1g shoulders + the crest). An
  *empty* profile is a flat `DEFAULT_G` (1g), but a fresh convert/append is NOT empty: it seeds
  (0, F_entry) and (length, F_entry) from the bake's recovered entry force — a fresh geo→force
  convert continues the entry force, level only when that entry is 1g. Deleting every keyframe
  restores the 1g fallback.
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
- **Stored `Handle.theta` ≠ the recovered curve heading once a node carries an explicit tangent.**
  `Handle.theta` only drives the `Auto` arc rule; an explicit tangent's own vector governs the curve
  instead, and nothing re-derives `theta` to track it. An op that needs the curve's actual
  *direction* — the append/reflect seed, a split/join section boundary — must read the real exit
  (`exitHeading` for append/extend, `headExit` for split/join: the section's recovered geometric
  exit, `evalGeo(...).exit`), never `Handle.theta`, or it re-frames the downstream shape by however
  far the two have drifted apart (`tests/ops.test.ts`'s split/join world-curve pins guard this).
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
- **Tick-derived `editor.*` reads lag a frame.** Svelte components read the plain `editor`
  singleton through `$derived` of the per-RAF `tick` prop, so an `$effect` gated on such a value
  outlives the real state change by up to a frame. Where the lagging listener *swallows*
  (capture-phase + `stopImmediatePropagation`) or is non-idempotent, that lag is a defect: make
  the listener permanent (`onMount`) and early-return on the live `editor.*` field — the
  Timeline force-menu Escape fix is the shape. A lagging listener that only re-calls an
  idempotent close is tolerable.

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

**Toolchain pin:** `typescript` is held at 6.0.3 and `svelte-check` at 4.7.3 because svelte-check
crashes on TypeScript 7 — the native (Go) port doesn't yet expose the `ts.sys` JS API svelte-check
relies on. Revisit the pin when svelte-check ships TS7 support.

f64 mirror for tests: `tests/helpers/forward64.ts`. Independent physics check: `tests/oracles/rk4.ts`
(time-parameterized RK4 — a different scheme + parameterization). Physics is gated against the
oracle, not self-consistency.

Investigation labs (run explicitly, not part of `bun test`) — the kernel-atom / future-tier
reference: `tests/geometry.lab.ts`, `tests/collocate.lab.ts`, `tests/loop.lab.ts`,
`tests/conditioning.lab.ts`, `tests/fvd.lab.ts`, `tests/hill.lab.ts`, and
`tests/attribution.lab.ts` (the conversion tier's attribution sweep — one printed row per
corpus solve over `polish`'s mode × DOF axes, so flipping one axis attributes a metric change
to it; violence numbers are ds-dependent and censuses are final-frame only). Visual counterparts
`geometry-lab.html` + `collocate-lab.html` + `loop-lab.html` + `fvd-lab.html` (canvas2D, captured by
the harness).

The ECS + substrate layers are covered device-free: `tests/section.test.ts` (the substrate),
`tests/track.test.ts` + `tests/cart.test.ts` (`BakeSystem`, cart on a bare `State` via the
scheduler). The `tests/setup.ts` enum-shim preload (`bunfig.toml`) lets them import the shallot barrel
with no GPU device; the unit suite is canvas2D + device-free, no real-GPU leg.

`harness/` — Playwright harness (`bun run capture` → `harness/shots/`, gitignored). The `geo authoring
flow` test drives the real UI (seed → extend → undo → reshape) and the `force authoring flow` test
(seed → real mode-toggle convert → author a bump by points → convert back → undo) assert
`window.__kex` state via `expect.poll` (no sleeps); the lab tests screenshot the atom pages. Drives
the host's **real-GPU Chrome via the WSL→Windows bridge** (shallot's `run()` acquires a WebGPU
device even though kex2d is canvas2D). Display-gated.

It's a **sub-package with its own `package.json` + committed `bun.lock`** (Playwright is declared
there, not in the app). `bun check` self-provisions it — the `harness:deps` script installs
`--cwd harness --frozen-lockfile` when `harness/node_modules` is missing, so a fresh clone or
worktree type-checks without a manual step. **Never fix a missing `@playwright/test` with a root
`bun install`**: that replaces the `node_modules/@dylanebert/shallot` dev symlink with npm shallot
and the app stops mounting. Its code IS under the project `tsconfig` + `biome`, and the pure pieces
(`args.ts`'s CLI/env validators + the `--out` wipe guard, `wsl.ts`'s provisioning key) are
unit-tested in `tests/harness.test.ts`. But `capture.pw.config.ts` and `shot.pw.ts` are **staged to
the Windows host standalone** (`wsl.ts`), so they can import nothing outside the staged set — app
constants they need are mirrored at the top of the file with their source named, and the env knobs
are validated there by a verbatim copy of `args.ts`'s `intEnv`/`boolEnv`, pinned
character-identical by the unit tests. Flow-authoring laws + verifier-integrity conventions:
`.claude/rules/kex2d-harness.md` (auto-loads on harness files).
