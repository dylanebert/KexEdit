# kex2d

2D coaster prototype. Shallot + Svelte + canvas2D. The exploration harness for the
**sections-of-atoms** track model: a track is a chain of **sections**, each one either a **geo**
section (author positions → recover force) or a **force** section (author F_n → integrate
geometry), joined by anchor propagation — the original KexEdit section contract, in 2D.
Mouse-driven and direct, parallel to `app/` (the eventual Shallot port). Whether it replaces /
augments / coexists with the 3D editor decides once it earns its place. Both atomic idioms author
within a section:

- **geo** — author node positions in the viewport (per-node 1D manipulators: polar at the tip,
  chord slide/offset interior) →
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
section at an arclength s), delete (downstream closes the gap + rebases
rigidly). One open chain — no branching, circuit closure, or mid-chain insertion.

**The track start is a fixed-position anchor**, not a node (`START = {0,0,0,v0}`): what's really
there is an initial-velocity anchor. Its position is fixed (the origin), and the **initial speed
is derived, not a separate field**: `seed()` authors a real, section-0 minimum-extent velocity
strip, and `entrySpeed` reads the value of whichever strip covers station 0 (or `V0` when none
does) — authored through the ordinary strip/keyframe gestures, not a popover on the anchor. The
START diamond is selectable and still carries the dissipation-coefficient (μ/c) popover. Not
draggable — it draws as a diamond, distinct from the gold shape handles.

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
the controls place node positions through two snapped 1D controls in the node's own frame — the
**tip** polar around the previous node (length on a 1 m grid with a 1 m floor, angle on a 5° grid —
both increments per-user configurable, `settings.ts`), an **interior** node on the frozen prev→next
chord's slide (∥) and offset (⊥) axes, both on the plain length grid with **no floor and no angle
grid** (offset is signed; 0 = on the chord is legitimate); Ctrl bypasses to continuous either way;
a body click only selects (except inside tangent edit — below); the canonical
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
  on its **own** move and on append — that is the whole re-head list. Never on a neighbor's move
  (dragging the node before the tip preserves the tip's heading, single drag and group move
  alike), and never on a **delete**: a neighbor's delete is not the tip's own move, so promotion
  touches nothing — an explicit promoted tip keeps its tangent whole (it exits along the authored
  out-vector; an explicit node's `theta` is dead), and an `Auto` promoted tip keeps its frozen
  `theta` (authored substrate state, set by the node's own move exactly as a tangent record is) —
  the surviving segment holds byte-identical either way; node 0 and **interior**
  `Auto` nodes keep a frozen heading (stable beats thrashing — dragged far off its chord it
  bulges, the accepted misshaping). A node turns concrete bezier **only** when
  explicitly authored — a handle drag or a mode set (seeded from the live arc-rule vectors via
  `seedTangent`, no jump). Handles are additive; they never change the default feel.
- **Explicit tangent modes** — the Figma mirroring taxonomy `Mirror` | `Aligned` | `Free`, an
  inferred node displaying as `Aligned` (there is never a no-mode state; the laws live in
  `editor-ui.md` Tangent editing). `setTangent`/`handleTangent` (`track.ts`) are the read/write
  surface; **Reset** (`resetNode`) re-creates — continuation past the predecessor at the default
  chord, tangents back to live `Auto` inference (the Reset idiom law, `editor-ui.md` Menus).
  Node 0 (position pinned) carries a single **free** out-handle — the entry handle; its Reset is
  the tangent clear (`resetTangent`), restoring the `Auto` C1 exit along the entry heading.
- **Summoned, not default.** Handles render only in **tangent-edit mode**, entered by
  double-clicking a node (`editor.tangentEdit`, layered on node selection — Esc or click-away
  exits); mere selection shows nothing (`editor-ui.md`'s layered-expressiveness contract). A handle
  drag is a **free** direct-manipulation gesture with one landmark, the grab-ray angle latch
  (`latchAngle`). The **node context menu** (right-click any pickable node, any mode — the app's
  context-menu language, `menu.ts`), in the grammar's canonical order: `Add` (chain-end,
  enablement-gated), a `Handles` toggle (≡ the double-click summon) over a `Tangents ▸` submenu
  (Mirror | Aligned | Free), then `Reset` and `Delete`. Node 0 is reachable: right-click or double-click at the START diamond
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
- **Extent is the section's own authored length** (`Section.length`, in meters of arclength
  always — `Track.domain` picks only what unit it DISPLAYS as), NOT inherited from the geo shape
  a convert came from: convert **resets** it to
  the domain's default; append gets its kind's (and domain's) **sticky** length — the last committed
  extent-trim (`track.setStickyLen`; a solve never touches it). Editable via the **force clip's
  right edge** (`ew-resize`, `setSectionLength`, floored at `minForceExtent`, one undo entry via
  `history.beginLength`). Shortening below a point's s just stops sampling there (non-destructive —
  re-lengthening restores it). **The bake conforms to the authored length exactly, via
  `profile.resolveStep`** (the resolver's math lives in `kex2d-map.md`'s `profile.ts` entry).

## Authoring API — the substrate is the agent surface

Authored state — everything that *defines* the track — lives in ECS components in `track.ts`, and
only there. The UI reads it through the per-RAF tick and writes it only through the `track.ts`
setters, each wrapped in a `history` gesture. That's the purity contract, and it's the surface the
CLI (`src/cli.ts`) drives headlessly through `src/commands.ts`'s typed op
vocabulary — the demonstrated agent surface: stateless `stats`/`dump`/`edit`/`fmt`/`new`/`validate`
subcommands over the `.kex` text form, dispatching to the SAME setters inside the SAME gestures the
UI uses, so an agent edits a document exactly the way a person dragging a keyframe does. The
capture harness's own `__kex` hook (below) is a narrower, DEV-only surface for driving the live UI
under test, not the authoring surface itself.

**The authored components (the one source of truth):** `Track` (`ds`, `domain`, `friction`, `resistance` — no `v0`, derived, see `entrySpeed`; `count` is bake OUTPUT, not authored — `BakeSystem` writes it from the derived sample count, `track.ts`'s own `bake()`, so the document format (`doc.ts`) never carries it), `Section` (`id`, `order`, `kind`, `length`), `Handle` (geo node: `section`, `order`, section-local `pos`/`theta`), `Force` (keyframe: `section`, `id`, section-local `s`, `g`, `tmode`/`tin`/`tout`), `Strip` (velocity span: `section`, `id`, `start`/`end`/`value`), `StripKeyframe` (strip curve: `strip`, `id`, `s`/`v`), `OneShot` (the track-start entry-speed value: `id`, `value` — at most one entity carries it). Everything else is derived or ephemeral: `samples`/`bakeOut`/`sectionInfo` are `BakeSystem` output (recomputed, never authored); `editor.ts` holds selection + menu state; the Svelte `$state` (view pan/zoom, drag-in-flight, flyouts) is view state. `render.ts` and `cart.ts` read, never write.

**Write only through the setters, only inside a history gesture.** `history` is one undo/redo stack
(`begin`/`commit`/`cancel`; one gesture at a time, so a live drag collapses to one entry). Two
disciplines:

- *Structural / one-shot* ops snapshot internally — call them bare: `appendSection`, `removeSection`,
  `convertSection`, `extendTrack`, `trimTrack`, `createForce`, `deleteForce`.
- *Continuous* edits (drags, label scrubs, typed fields) bracket by hand — `begin*` → `set*`
  (repeated) → `commit(history)`, `cancel()` on interrupt: `beginMove`+`Handle.pos.set`,
  `beginForceMove`+`setForcePoint`, `beginLength`+`setSectionLength`,
  `beginStripMove`+`setStrip`, `beginStripKeyframeMove`+`setStripKeyframe` (initial speed is
  authored through these — the start strip's own gestures — with no field-specific pair of its
  own).

Never mutate an authored component from a Svelte component or a read/render path — that divorces the
edit from undo and from the single source of truth. Two sanctioned exceptions, only one of them
proven by a write-site census over every `src/` module (`tests/purity.test.ts`): `doc.ts`'s
whole-document load/rollback (`loadDocument`'s own in-place restore on a geometry refusal) writes
every authored field raw, with no `history` bracket — a fresh or reverted document is not an edit
to undo past — and the census's own exemption set pins exactly this one. The DEV-only `__kex` hook
(`main.ts`, never ships) is sanctioned in prose only: its `nudge` member delegates to
`commands.applyOp`'s `node-move` — the command layer, gesture and all — everywhere the mapping is
1:1, but `seedHill`'s bulk rebuild has no single op to delegate to, so it still bypasses `history`
through `track.ts`'s own `addNode`/`ecs.destroy` rather than a direct `.set(` on an authored field —
below the census's `.set(`-only signature, invisible to the walk rather than exempted by it. The
census walks the authored-component write sites outside `track.ts`/`history.ts` and reds if a NEW
one appears un-gestured and outside `doc.ts`.

**Two coordinate frames, one lens.** Position-along-track has two names for two jobs:

- **`s` — section-local** (from the section entry), in meters of arclength ALWAYS — the
  *storage and kernel* frame: `Force.s`, force extents, `Strip`/`StripKeyframe`, geo `Handle`
  locals. Keyframes are addressed relative to their owning section, so they **ride with it** — an
  upstream edit shifts everything downstream, but never rewrites a downstream section's stored
  `s`: the sections-of-atoms self-containment invariant.
- **track-global** (from the track start, the ruler's axis): distance `d` in meters, or time `t`
  in seconds — every position readout and the agent contract address.

The seam is the lens in `track.ts` (`sectionSpans` + `toGlobal`/`toLocal`, on arclength always —
the `toGlobalU`/`toLocalU` alias names retired at event-lane S3): a
section's `offset` is the cumulative baked arclength upstream, `global = entry + local`, inverted
back to `(section, local)` (a shared boundary resolves **upstream**). Every readout derives here
— nothing re-walks the baked `ds`. **The domain pick IS a view change, exactly**:
`domain.convertDomain` writes `Track.domain` alone as one undoable entry — no keyframe, extent, or
handle write — so a Time reading is a display projection through the live bake's s↔t table
(`timeline.ts`'s `dToU`/`uToD`, frozen per gesture) rather than a document conversion. A flip
changes no authored component and no bake hash, in either direction, forever — a round trip IS
bit-identical, because there's nothing stored to round-trip. Time-domain editing is no longer
time-constrained (a keyframe held at t=3s when upstream speed changed under the old carry; under
the lens it stays at its metre — the give-up is recorded, not silently dropped). Invoked solves
stay distance-internal and land with nothing to convert (their goldens are frozen in meters).

**The document format** (`src/doc.ts`, `.kex` extension, JSON inside) is this authored surface's
canonical text form — a canonically-emitted `Kex2dDocument` capturing the four `Track` scalars
above plus every section/node/force-point/strip/strip-keyframe/one-shot, `version`-stamped with a
forward-only migration seam. `saveDocument(ecs)` / `loadDocument(ecs, text)` are the boundary: save
throws only on a non-finite scalar in the live ECS (`numLit`'s guard — an ECS-integrity bug, not a
file case), load parses + validates the WHOLE file before touching the ECS (a refused load
leaves the live document untouched) and clears the undo stack, since a load is a new document, not
an edit to undo past. Module detail, the emitter's ordering/idempotence discipline, and the f32
exactness argument: `.claude/rules/kex2d-map.md`'s `doc.ts` entry.

## Code map

The per-file map — what each module owns, its seams and test homes, module by module — plus the
external references: `.claude/rules/kex2d-map.md`. It groups `src/` in three layers: the pure
substrate + physics atoms (`section.ts` and friends), the invoked conversion/optimization atoms,
NOT on the live editor path (`convert.ts`, `refine.ts`, `polish.ts` …), and the ECS + UI layer that
IS the app (`track.ts`, `history.ts`, `geoforce.ts`, `App.svelte`/`Timeline.svelte` …).

## Editing model

A track is a chain of sections; each is geo or force, authored by its idiom (below). Direct
manipulation, no sub-tools. One selection container (`editor.ts`): a unified ordered set of
`{kind, id}` members — a node, a force point, a whole section, a velocity strip, a strip
keyframe, the START anchor, or the track-start one-shot — plus one active member whose kind
routes the keydown handlers (the Blender active-vs-selected split). A plain click
replace-selects (clearing every member of every kind); shift/marquee extend across kinds, so
a selection can span a force keyframe and a strip keyframe at once. A key press never
double-fires because only the active kind's handler guard passes, not because the containers
are mutually exclusive (they are one container now). **The mixed-set drag axis law:** station
moves every member; value moves only when the set is single-domain — a gesture channel whose
meaning is not defined for every member of the set carries no meaning for that gesture, so a
drag spanning both keyframe domains (force and strip) moves station for all and value for none.
Single-domain multi-select keeps its full vertical channel. Section selection is a **highlight +
the context-menu target only**; it never gates authoring (force points are added by cursor
position, nodes dragged in the viewport).

**Geo authoring** (within a geo section) — author the shape in the viewport. Click a node to select
it; click empty space to deselect. Movement on the default surface is the two manipulators, never a
free body drag; inside tangent edit the edited node's body drags freely (unsnapped — the summoned
layer's idiom).

- **The manipulators** (the two knobs on the selected node's ring — the per-node frames above; tip
  = polar length/angle, interior = chord slide/offset on the same two slots):
  dragged (pointerdown on the knob captures the pointer, past the `DRAG_PX` dead zone) or
  arrow-nudged (left/right = angle-role, up/down = length-role, forked by node kind). A **drag** is
  purely snapped — the
  configurable grids, Ctrl/Cmd bypasses to continuous. A **nudge** steps a fixed screen-px
  increment instead (`NUDGE_PX`, `NUDGE_PX_COARSE` with Shift) through the camera zoom, so the
  keyboard moves a constant on-screen distance at any snap setting. The tip re-heads only on its
  own move (node 0 + interior stay frozen; a neighbor's move never swings the tip). A body drag
  outside tangent edit does nothing but select.
- **Append / Delete**: append lays a node continuing the last edge by the **sticky**
  chord — the last committed length adjust (`history.commitChord`, `EXTEND_DIST` until one
  lands; the geo half of the per-kind sticky store) — the ring's
  extend button (slot 0, chain-end only), `Enter`, or the node menu's `Add`; delete removes the
  trailing node — `Del`/`Backspace` or the node menu's `Delete`, never below the two nodes a
  section needs; deletion never re-heads — the promoted tip keeps its state whole, explicit
  tangent and frozen `Auto` heading alike (the tip re-head law above: re-head is own move +
  append only).
- **Tangent edit**: double-click summons; the manipulator knobs hide while it's open. Model +
  substrate: `Model (geo authoring)` above.

**Force authoring** (on the timeline chart, whole-track) — the chart draws every force section's
points at once. Double-click over a force section's arc places a point at the authored profile's
value (insertion never jumps the VALUE there — the new keyframe's own default-eased tangents
still reshape the curve locally; the section
resolves from the cursor arclength, no selection needed); drag a diamond in both axes (horizontal =
s, vertical = g); `Del` removes,
`Esc` deselects; the popover at the selected diamond types or scrubs its s/g. Points are authored
section-local (s from the section entry) but drawn at their section's whole-track cumulative
offset. Keyframes, not constraints. They also **display + select on the viewport track** (the same
entity, the same glyph, at the world point their `s` bakes to) but are **never draggable there** —
one authoring surface per quantity, and g has no viewport axis. Snap + interaction conventions:
`editor-ui.md`.

**Section ops** (the multi-section chain) — select a section by clicking its **clip** in the timeline
marker lane (or its viewport polyline span); a force clip's right edge is its extent trim, and a `+`
tail after the last clip appends (geo/force flyout). **Right-click a clip or span** for
the context menu: ONE conversion row, labeled **`Convert`** (the section's kind implies the
direction — menus law), its action fitted to the kind: `geoforce.ts` on geo, `forcegeo.ts` on
force. It grays (never hides) where the kind fits but the invoke
can't run (no live bake, a multi-set), behind one **modal** (title + an indeterminate spinner —
in-flight narration was feel-cut; Cancel or Esc, every other input blocked, then a transient
outcome readout), and Delete (`Del`). Boundary anchors draw as
viewport diamonds + chart guides. One open chain — no branching, circuit closure, or mid-chain
insertion; no split or join op (`kex2d-segment-removal`) — the chain only grows or shrinks at its
end, or shrinks by whole-section delete. All ops undo via a byte-identical whole-track snapshot pair.

**Pin mode** (endpoint-preserving force edits) — entered from a force section's context menu
(`Pin`): the section's current exit `(x, y, θ)` is **stamped** as the pin, the author retunes
force keyframes with the normal idiom (add keys, drag, trim length — slack is authored, never
inferred), and an invoked **Solve** adjusts only un-locked keys' `g` to restore the stamp — s,
length, structure, easing, and locked keys land byte-identical. **The solver optimizes, the mode
pins**, and that line is where the naming splits: `pin.ts` is the mode, while `optimize.ts` /
`optimize-async.ts` / `optimize-worker.ts` keep their names because they genuinely are a
constrained minimization the author never sees. Pin and Lock are also two things, not a collision:
the pin is the *end* the solve must restore, a lock is a *means* the solve may not move
(`editor-ui.md` Mode vocabulary). All keys are free by default;
**`Q`** toggles lock on the selected set (the keyframe menu's mode-only Lock/Unlock row is the
mouse path), locked keys wear the driven (dashed/faded) styling. The mode is a **sandbox**: its
state is temporary — every in-mode edit records into the mode's own history (nothing
touches the outer stacks), in-mode undo/redo walk that sandbox alone, undo at its start acts as
Exit, and Exit/Esc discards it without trace. A landed Solve is **one outer undo entry carrying
the whole experiment** — undoing it reopens the mode with draft, locks, and in-mode undo/redo
restored; redoing it re-lands and closes. The paced landing that plays after Solve is the mode's
**exit transition**: the modal chrome (panel in a disabled settling state, dim wash, subject hatch)
holds through the window and releases in ONE moment at expiry or skip. A refusal (terse notice,
top-center) stays in-mode with the draft untouched. While the mode is open the track is under an **editing lockdown** (only the
pinning section is editable — no section add/remove, convert, domain switch, or other-section
edits — the initial speed is a strip on its own section, so it's covered by that rule, not a
listed exception) and **downstream sections freeze** at their mode-entry placement: the
boundary gap that opens while editing IS the residual (the drop-line's truth), and any close
repropagates. Five modules: `optimize.ts` (the masked exit-restore kernel), `pin.ts` (the
document seam), `optimize-async.ts`/`optimize-worker.ts` (the one-shot worker façade), the
sandbox + record-redirect seam (`editor.ts`/`history.ts`), and the downstream freeze
(`track.setBakeFreeze`). Detail per module: `.claude/rules/kex2d-map.md`.

## Hard gotchas

- **Input is wired in `onMount`, not a system.** `attachControls(canvas, ecs)` binds the
  canvas/keyboard listeners and returns a teardown App calls on unmount. Don't move this back to a
  `System` with a module-level `attached` flag — that goes stale across a remount (a fresh canvas
  keeps the old flag and never re-binds, so input silently dies).
- **Selection keys route off `activeKind()`, never off which per-kind accessor is non-null** —
  each accessor falls back to its own kind's last member, so several read non-null at once.
  `controls.ts` (node + section keys) and `Timeline.svelte` (force/strip/stripKf/oneShot keys)
  are the two selection-reading handlers on `window`; only one handler's guard passes on a mixed
  selection, so a key press never double-fires. **The class is every
  `window.addEventListener("keydown")` under `kex2d/src` plus every reader treating a
  single-kind accessor as "the selection" — enumerate it by that query, never from a count
  written here** (a remembered count of two is what made this unit miss `App.svelte`'s
  listeners twice). The observable (one key
  event = one edit) is pinned by this routing; the old mechanism (per-kind containers that
  were mutually exclusive) is gone, replaced by one unified member set + `activeKind()`.
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
  DERIVED, `entrySpeed` — the strip covering station 0, else `V0`; authored through the ordinary
  strip/keyframe gestures, not the START diamond's own popover), not a node — a
  geo→force convert carries no geo start position (destructive; position is cosmetic). Force
  extent's convert-vs-append default: Model (force authoring), above.
- **Two `State`s alias silently.** `track.ts` component storage is module-scoped and eid-indexed
  with no per-`State` bank, so two live `State`s allocating overlapping eids clobber each other's
  rows — `loadDocument` validates geometry in-place with rollback and `checkDocumentSemantics`'s
  scratch `State` is safe only one-document-per-process for exactly this reason. The 3D remake
  keys component storage per `State`; do not copy this substrate shape.

Per-module hazards live beside their module in `.claude/rules/kex2d-map.md` (Hard gotchas): the
bake/recovery traps (`forces` vs `invertRange`, the continuous chord angle, `Handle.theta` out of
the bake and its drift from the recovered exit), the substrate's boundary + clamp laws, pin
mode's sandbox invariants, and the tick-lag dismissal standard every menu copies.

## Verify

```bash
cd kex2d && bun check && bun test   # the default gate (~12s); corpus oracles + labs run by path
cd kex2d && bun run capture   # UI screenshots → harness/shots/ (display-gated)
```

**Toolchain pin:** `typescript` 6.0.3 + `svelte-check` 4.7.3 — svelte-check crashes on TypeScript 7
(the native Go port lacks the `ts.sys` API it needs). Revisit when it ships TS7 support.

Physics is gated against an independent oracle, not self-consistency; the ECS + substrate layers
are covered device-free, so the unit suite has no real-GPU leg. Tiers, the f64 mirror + RK4
oracle, and the investigation labs (run explicitly, never part of `bun test`):
`.claude/rules/kex2d-map.md` (Test tiers, Labs). `bun run capture` drives the real UI on the
host's GPU Chrome through the WSL→Windows bridge; the harness's structure, its sub-package
install story, and its flow-authoring + verifier-integrity laws:
`.claude/rules/kex2d-harness.md`.
