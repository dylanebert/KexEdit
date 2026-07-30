# kex2d

2D coaster prototype. Shallot + Svelte + canvas2D. The exploration harness for the
**sections-of-atoms** track model: a track is a chain of **sections**, each one either a **geo**
section (author positions → recover force) or a **force** section (author F_n → integrate
geometry), joined by anchor propagation — the original KexEdit section contract, in 2D.
Mouse-driven and direct, parallel to `app/` (the eventual Shallot port). Whether it replaces /
augments / coexists with the 3D editor decides once it earns its place. Both atomic idioms author
within a section:

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
architecture is two deterministic, legible atoms — force→geometry and geometry→force — with
authoring layers on top. Optimization exists only as a **scoped, invoked tool** over those atoms,
and both directions are landed end to end: geo→force (lab-gated core, `convert.ts`'s cancellable
worker-pool façade, `geoforce.ts`) and force→geo (`geofit.ts`'s dual-budget fit — every candidate
scored on the adaptive bake the DOCUMENT will produce — behind `geofit-async.ts`, landed by
`forcegeo.ts`). Each lands as one byte-identically undoable entry, guarded against a stale or
concurrent invoke, behind one modal (Section ops). The kernel atoms and lab pages stay
in-tree and oracle-gated.

**Positions and force keyframes are the two authoring substrates** — both sparse, density
unbounded; the dense baked chain is always derived, never canonical (dense-vs-sparse is a false
dichotomy: a dense array is a keyframe list at maximum density). Rate/pitch-speed keyframes as a
geometry substrate are rejected: rates integrate, so the encoding has global support and
single-shooting conditioning (measured σ(∂P/∂F) ~ N^1.54 vs N^0.00 for positions), and every
non-graph tool would pay a fit-through-the-integrator per gesture. Graph editing of geometry is
served as a derived view or an invoked fit, never as the store.

## The section substrate

`section.ts` — the proven original-KexEdit contract (`packages/core`), in 2D: every section takes
an **entry** anchor (a full state point `{x, y, θ, v}`) and produces sampled points; its last
point IS the next section's entry. `evalGeo` (geometry → force), `evalForce` (force → geometry),
`chain` (thread sections into one flat SoA, sharing boundary points). Two design laws carried from
the original core govern it — **the force curve is ALWAYS geometry-recovered**, even for a force
section (one display path regardless of kind), and **rigid entry-frame placement** (geo nodes are
stored section-local, node 0 pinned at the entry, so an upstream edit carries the downstream shape
rigidly). Both are pinned in `tests/section.test.ts`.

`track.BakeSystem` threads every section through ONE `chain(START, payloads)` call → the flat
`samples`/`bakeOut` SoA + the per-section `sectionInfo` map; cart/render/timeline are kind- and
count-agnostic. f32 throughout — these atoms ARE the realized-track display path. Both laws in
full, the substrate detail, and the physics (integrator, force recovery, constants):
`.claude/rules/kex2d-map.md`.

## Model (geo authoring)

Manipulator authoring, mouse-driven. The **control scheme** and the **representation** are separate:
the controls place node positions through two snapped 1D polar controls around the previous node
(length on a 1 m grid with a 1 m floor, angle on a 5° grid — both increments per-user configurable,
`settings.ts`; Ctrl bypasses both to continuous; a body click only selects); the canonical
representation is the F_n curve. Each node carries a **section-local** position and a tangent —
**live-inferred** (`Auto`, the default: no stored vectors) or **explicit** (stored `in`/`out`
vectors, the summoned inner layer). **Node 0 is the section entry** — pinned at the local origin,
not draggable; its world pose IS the entry, and the shape hangs off it in the entry frame.

- **Interpolate.** `sampleChain` (`spline.ts`) samples a cubic Hermite curve through every node —
  `handle()` reads a node's tangent: `Auto` via the arc rule (direction `Handle.theta`, length
  scaled by the live chord, `|T| = chord·sec²(φ/2)`, the cubic best-fit to a circular arc); explicit
  via its stored vector, held absolute under a node drag (the Figma/Blender bezier convention — no
  chord rescaling). Strict local support either way: a drag or a tangent edit moves **only the two
  segments that share the node**.
- **The default shaping is live everywhere — byte-identical to the pre-handles editor.** Nothing is
  stamped at append: the default add/extend/drag flow stores **no** tangents. The **last** node's
  heading tracks its predecessor's exit (`headLast`, the reflection `2·chord − prev`), re-deriving
  whenever the tail changes, so a fresh append or drag never goes stale; node 0 and **interior**
  `Auto` nodes keep a frozen heading (stable beats thrashing — dragged far off its chord it
  bulges, the accepted misshaping). A node turns concrete bezier **only** when
  explicitly authored — a handle drag or a mode set (seeded from the live arc-rule vectors via
  `seedTangent`, no jump). Handles are additive; they never change the default feel.
- **Explicit tangent modes** — the Figma mirroring taxonomy `Mirror` | `Aligned` | `Free`, an
  inferred node displaying as `Aligned` (there is never a no-mode state; the laws live in
  `editor-ui.md` Tangent editing). `setTangent`/`handleTangent` (`track.ts`) are the read/write
  surface; **Reset** (`resetTangent`) clears back to live `Auto` inference. Node 0 (position
  pinned) carries a single **free** out-handle — the entry handle; Reset restores its `Auto` C1
  exit along the entry heading.
- **Summoned, not default.** Handles render only in **tangent-edit mode**, entered by
  double-clicking a node (`editor.tangentEdit`, layered on node selection — Esc or click-away
  exits); mere selection shows nothing (`editor-ui.md`'s layered-expressiveness contract). A handle
  drag is a **free** direct-manipulation gesture with one landmark, the grab-ray angle latch
  (`latchAngle`). The **node context menu** (right-click any pickable node, any mode — the app's
  context-menu language, `menu.ts`): `Delete` then `Add` (chain-end, enablement-gated), a `Handles`
  toggle (≡ the double-click summon) over a `Tangents ▸` submenu (Mirror | Aligned | Free, a
  separator, then Reset). Node 0 is reachable: right-click or double-click at the START diamond
  reaches the first section's node 0 (its menu is Handles + Reset only); a geo→geo boundary's
  node 0 is reached by tangent-editing the coincident upstream tip (the stitch).
- **Recover force.** `forces` (`bake.ts`) reads the sampled positions → per-sample tangent θ (the
  chord bisector) → v (energy) → `F_n = κ·v²/g + cos θ`, the normal force a cart riding the curve
  feels. That per-sample θ is recovered from the geometry, distinct from the node tangents that
  shape the curve.

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
  rule governs invoked optimization tools, not this). The displayed curve is the
  geometry-RECOVERED force (the one-display-path law), so a diamond sits O(ds) off the curve — the
  authored handle vs the recovered display, expected.
- **Extent is the section's own authored length** (`Section.length`, in the track domain's unit —
  meters or seconds), NOT inherited from the geo shape a convert came from: convert **resets** it to
  the domain's default; append gets its kind's (and domain's) **sticky** length — the last committed
  extent-trim (`track.setStickyLen`; a solve never touches it). Editable via the **force clip's
  right edge** (`ew-resize`, `setSectionLength`, floored at `minForceExtent`, one undo entry via
  `history.beginLength`). Shortening below a point's s just stops sampling there (non-destructive —
  re-lengthening restores it).

## Authoring API — the substrate is the agent surface

Authored state — everything that *defines* the track — lives in ECS components in `track.ts`, and
only there. The UI reads it through the per-RAF tick and writes it only through the `track.ts`
setters, each wrapped in a `history` gesture. That's the purity contract, and it's the surface a
future authoring agent drives — the same one the capture harness pokes through `__kex`.

**The authored components (the one source of truth):** `Track` (`count`, `ds`, `v0`, `domain`), `Section`
(`id`, `order`, `kind`, `length`, `ds`), `Handle` (geo node: `section`, `order`, section-local
`pos`/`theta`), `Force` (keyframe: `section`, `id`, section-local `s`, `g`). Everything else is
derived or ephemeral: `samples`/`bakeOut`/`sectionInfo` are `BakeSystem` output (recomputed, never
authored); `editor.ts` holds selection + menu state; the Svelte `$state` (view pan/zoom,
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

- **`s` — section-local** (from the section entry), in the unit of the track-global domain
  (`Track.domain`: meters of arclength, or seconds of time). The *storage and kernel* frame:
  `Force.s`, force extents, geo `Handle` locals. Keyframes are addressed relative to their owning
  section, so they **ride with it** — an upstream edit re-times the ride and shifts everything
  downstream, but never rewrites a downstream section's stored `s`: the sections-of-atoms
  self-containment invariant.
- **track-global** (from the track start, the ruler's axis): distance `d` in meters, or time `t` in
  seconds — every position readout and the agent contract address.

The seam is the lens in `track.ts` (`sectionSpans` + `toGlobal`/`toLocal` on arclength,
`toGlobalU`/`toLocalU` on the domain's axis): a section's `offset` is the cumulative baked arclength
upstream, `entryU` its baked entry time, `global = entry + local`, inverted back to
`(section, local)` (a shared boundary resolves **upstream**). Every readout derives here — nothing
re-walks the baked `ds`. Geo is position-authored in either domain, so it projects for display
through the timeline's d↔t seam (`dToU`/`uToD`, on a `section.Domain`). **The domain pick is not a
view change**: it's a document conversion op (`domain.convertDomain`) — one entry converting every
keyframe, extent, and handle through the live bake's arc↔time table, which makes time-domain editing
time-CONSTRAINED. A round trip isn't bit-identical; undo is the only way back. Invoked
solves stay distance-internal and convert at their landing (`domain.convertSolve`).

## Code map

The per-file map — what each module owns, its seams and test homes, module by module — plus the
external references: `.claude/rules/kex2d-map.md`. It groups `src/` in three layers: the pure
substrate + physics atoms (`section.ts` and friends), the invoked conversion/optimization atoms,
NOT on the live editor path (`convert.ts`, `refine.ts`, `polish.ts` …), and the ECS + UI layer that
IS the app (`track.ts`, `history.ts`, `geoforce.ts`, `App.svelte`/`Timeline.svelte` …).

## Editing model

A track is a chain of sections; each is geo or force, authored by its idiom (below). Direct
manipulation, no sub-tools. Four mutually-exclusive selections (`editor.ts`): a node, a force
point, a whole section, or the START anchor (the initial-speed handle) — selecting one clears the
others, so a key press never fights over its target. Section selection is a **highlight + the
context-menu target only**; it never gates authoring (force points are added by cursor position,
nodes dragged in the viewport).

**Geo authoring** (within a geo section) — author the shape in the viewport. Click a node to select
it; click empty space to deselect. Movement is the two manipulators, never a free body drag.

- **The manipulators** (the two knobs on the selected node's ring — the polar controls above):
  dragged (pointerdown on the knob captures the pointer, past the `DRAG_PX` dead zone) or
  arrow-nudged (left/right = angle, up/down = length). A **drag** is purely snapped — the
  configurable grids, Ctrl/Cmd bypasses to continuous. A **nudge** steps a fixed screen-px
  increment instead (`NUDGE_PX`, `NUDGE_PX_COARSE` with Shift) through the camera zoom, so the
  keyboard moves a constant on-screen distance at any snap setting. Both go through `reheadOnDrag` refreshing the last node's heading after the write (node 0 +
  interior stay frozen). A body drag does nothing but select.
- **Append / Delete**: append lays a node continuing the last edge by the **sticky**
  chord — the last committed length adjust (`history.commitChord`, `EXTEND_DIST` until one
  lands; the geo half of the per-kind sticky store) — the ring's
  extend button (slot 0, chain-end only), `Enter`, or the node menu's `Add`; delete removes the
  trailing node — `Del`/`Backspace` or the node menu's `Delete`, never below the two nodes a
  section needs, resetting-then-re-heading the promoted tip (the role-transition law,
  `editor-ui.md`).
- **Tangent edit**: double-click summons; the manipulator knobs hide while it's open. Model +
  substrate: `Model (geo authoring)` above.

**Force authoring** (on the timeline chart, whole-track) — the chart draws every force section's
points at once. Double-click over a force section's arc places a point at the authored profile's
value (insertion never bends the curve; the section resolves from the cursor arclength, no
selection needed); drag a diamond in both axes (horizontal = s, vertical = g); `Del` removes,
`Esc` deselects; the popover at the selected diamond types or scrubs its s/g. Points are authored
section-local (s from the section entry) but drawn at their section's whole-track cumulative
offset. Keyframes, not constraints. Snap + interaction conventions: `editor-ui.md`.

**Section ops** (the multi-section chain) — select a section by clicking its **clip** in the timeline
marker lane (or its viewport polyline span); a force clip's right edge is its extent trim, and a `+`
tail after the last clip appends (geo/force flyout). **Right-click a clip or span** for
the context menu: ONE conversion row, label and action fitted to the kind —
**Convert to force** (`geoforce.ts`) on geo, **Convert to geo** (`forcegeo.ts`) on force; the
other direction is absent, not dead. It grays (never hides) where the kind fits but the invoke
can't run (no live bake, a multi-set), behind one **modal** (live `{phase, keys, probes}`
geo→force, an indeterminate wait for the phase-less fit; Cancel or Esc, every other input
blocked, then a transient outcome readout), and Delete (`Del`). Split and join left the
editor — reserved for invoked tools (the substrate `splitGeo`/`splitForce`/`joinNext` + tests stay
in-tree as their reference). Boundary anchors draw as viewport diamonds + chart guides. One open chain — no branching, circuit closure, or mid-chain insertion. All ops undo via a
byte-identical whole-track snapshot pair.

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
  geo→force convert carries no geo start position (destructive; position is cosmetic). Force
  extent's convert-vs-append default: Model (force authoring), above.
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
- **Tick-derived `editor.*` reads lag a frame.** Svelte components read the plain `editor`
  singleton through `$derived` of the per-RAF `tick` prop, so an `$effect` gated on such a value
  outlives the real state change by up to a frame. Where the lagging listener *swallows*
  (capture-phase + `stopImmediatePropagation`) or is non-idempotent, that lag is a defect: make
  the listener permanent (`onMount`) and early-return on the live `editor.*` field. All three
  menus (node, section ctx, Timeline force) wear this shape — it's the dismissal standard a new
  menu copies, and the solve modal's key gate (`editor.converting`) is the fourth instance. A
  lagging listener that only re-calls an idempotent close is tolerable. Its twin on the read side:
  a tick-derived read must hand back PRIMITIVES, never a mutated object — the modal's progress is
  rewritten in place, so a `$derived` returning that same reference compares `===` equal and the
  surface never updates.

## Verify

```bash
cd kex2d && bun check && bun test   # fast tier (~8s); bun run test:full before commit/PR (~45s)
cd kex2d && bun run capture   # UI screenshots → harness/shots/ (display-gated)
```

**Toolchain pin:** `typescript` 6.0.3 + `svelte-check` 4.7.3 — svelte-check crashes on TypeScript 7
(the native Go port lacks the `ts.sys` API it needs). Revisit when it ships TS7 support.

f64 mirror for tests: `tests/helpers/forward64.ts`. Independent physics check: `tests/oracles/rk4.ts`
(time-parameterized RK4 — a different scheme + parameterization). Physics is gated against the
oracle, not self-consistency.

Investigation labs (run explicitly, not part of `bun test`) — the kernel-atom / future-tier
reference: `tests/geometry.lab.ts`, `tests/collocate.lab.ts`, `tests/loop.lab.ts`,
`tests/conditioning.lab.ts`, `tests/fvd.lab.ts`, `tests/hill.lab.ts`, and
`tests/attribution.lab.ts` (the flat conversion tier's authoring-floor sweep — its own header
carries the readings), `tests/forcegeo.lab.ts` (the force→geo fit's own sweep) and
`tests/perf.lab.ts` (the conversion perf baseline: probe counts +
wall time over the corpus plus `tests/helpers/stress.ts`'s scenarios — deliberately not corpus
members, so the 80-key lock is untouched) and `tests/pool.lab.ts` (the same scenarios through the
worker pool: sync vs pooled wall time and cancel latency, each row checked against the golden).
Visual counterparts
`geometry-lab.html` + `collocate-lab.html` + `loop-lab.html` + `fvd-lab.html` + `fit-lab.html`
(canvas2D, captured by the harness). `fit-lab.html` is the conversion tier's own page: it plays
back the pipeline's decisions (`playback.ts`) and is where the tier's output is judged as an
authoring surface. Its corpus stays a focused test, so the page solves only the selected
scenario.

The ECS + substrate layers are covered device-free: `tests/section.test.ts` (the substrate),
`tests/track.test.ts` + `tests/cart.test.ts` (`BakeSystem`, cart on a bare `State`). The `tests/setup.ts` enum-shim preload (`bunfig.toml`) lets them import the shallot barrel
with no GPU device; the unit suite is canvas2D + device-free, no real-GPU leg.

`harness/` — Playwright harness (`bun run capture` → `harness/shots/`, gitignored). The geo and
force authoring-flow tests drive the real UI (seed → extend/convert → author → undo) and assert
`window.__kex` state via `expect.poll` (no sleeps); the lab tests screenshot the atom pages. Drives
the host's **real-GPU Chrome via the WSL→Windows bridge** (shallot's `run()` acquires a WebGPU
device even though kex2d is canvas2D). Display-gated.

It's a **sub-package with its own `package.json` + committed `bun.lock`** (Playwright is declared
there, not in the app). `bun check` self-provisions it — the `harness:deps` script installs
`--cwd harness --frozen-lockfile` when `harness/node_modules` is missing, so a fresh clone or
worktree type-checks without a manual step. **Never fix a missing `@playwright/test` with a root
`bun install`**: that replaces the `node_modules/@dylanebert/shallot` dev symlink with npm shallot
and the app stops mounting. Its code IS under the project `tsconfig` + `biome`; the pure pieces
(`args.ts`'s CLI/env validators + the `--out` wipe guard, `wsl.ts`'s provisioning key) are
unit-tested in `tests/harness.test.ts`. `capture.pw.config.ts` + `flow.ts` + every `*.pw.ts` flow
are **staged to the Windows host standalone** (`wsl.ts`), importing nothing outside the staged set
(mirrored constants + verbatim-pinned validators, plus flow-authoring/verifier-integrity
conventions: `.claude/rules/kex2d-harness.md`).
