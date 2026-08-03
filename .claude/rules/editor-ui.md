---
paths:
    - "**/*.svelte"
    - "**/*.css"
    - "app/**/*.ts"
    - "kex2d/**/*.ts"
---

# Editor UI

Applies to all editor UI in kexedit, wherever it lives — today the kex2d prototype, migrating into
`app/` and beyond. The `.svelte`/`.css` globs catch components anywhere; as the editor frontend
grows into a new TS root, add it to the `paths` above so its controllers and stores pick this up
too. The posture, gates, surface, field, and motion laws are the kex root ruleset
(`kex/.claude/rules/ui.md`); this file is its kexedit child — it adds the project's earned bends
and worked examples, never restates root. kex2d is the worked model of root gate 3 (on the object
first): no tools, no modes — click a node to select it, move it through the polar length/angle
knobs on its summoned ring, force keyframes authored on the timeline curve itself, their typed
fields in a popover at the point.

## Layered expressiveness

Two commitments, held together:

1. **Full arbitrary expressiveness at the inner layer, accessible.** The substrate never caps what
   a determined author can express — the solver takes arbitrary weighted residuals, the node chain
   is free-form. Power is reachable, not fenced off.
2. **Deliberately constrained upper layers.** The default authoring surface is *intentionally* less
   expressive than the substrate — the constraint is the feature, not a compromise: inferred
   arc-rule tangents instead of exposed bezier handles (the Planet Coaster lesson), a constant
   target band before a keyframed profile. Upper layers optimize author strain, iteration speed,
   and attention (root's gates); each step down toward the substrate is summoned, never default.

Corollary for feature requests: users steeped in a traditional tool ask for its *mechanism* (a
force/geometry mode switch, manual split/edit/reconnect surgery), which is usually the workaround
their old tool required, not the want. Translate to the want — "edit the derived graph directly,"
"local force edits that don't destroy the surroundings" — and serve it through the layers.
Traditional FVD's vocabulary (piecewise section durations + easing types) is not the expressiveness
ceiling; don't inherit its shape out of deference.

## The kexedit bend: the force curve earns persistence

A coaster's canonical representation is its **F_n force curve**, not the node positions you drag to
shape it. So the force-curve timeline is *always-present critical information* — you author against
it continuously, the way a DAW keeps its waveform docked. That's the one spot kexedit bends gate 1
toward a persistent dock — the earned bend root `ui.md` sanctions.

The bend is bounded, not a license for a cockpit: the timeline is the **only** earned permanent
dock. It still clears gates 2–5 — the track shows a clean curve, not empty controls; every edit
re-bakes live and undoes (pins drop and drag on the curve itself, gate 3). A new surface is a
popover or a viewport affordance summoned in context, never a second docked region.

**Playback is the player; authoring is the timeline — one clock, two scopes.** The ride plays
continuously (no play/edit *mode*); the transport is a separate surface (a *global* full-track
scrub player) isolated from the on-curve authoring controls, over the timeline's *zoomed-local*
view of the same clock — the After Effects comp-vs-timeline relationship. So: don't reintroduce the
old Unity playback/edit *mode* split, and don't add a second video frame — in 2D the viewport
already *is* the playback. A separate playback render earns its place only for a different **camera**
(a rider POV), a 3D `app/` concern, not 2D kex2d.

## Document axis vs value axis

Every chart axis is one or the other, and the distinction decides what may rescale it (earned by
the kex2d timeline feel bug; the NLE reference: AE/Premiere never rezoom the timeline when a layer
shortens):

- **A value axis displays.** Auto-fit freely — the y g-range fits like the AE/Unity curve editors.
- **A document axis addresses.** It's the spatial home of every clip, keyframe, and guide, so
  content edits never rescale it — pan/zoom change only by explicit navigation (wheel, navigator,
  `F`, initial framing). Enforce as two paths: the content-edit clamp is pan-only; the fit floor
  lives only in the explicit-navigation ops (kex2d: `clampView` vs `zoomAt`/`frameAll`). A shrunk
  track leaves empty ruler on the right; it doesn't rezoom.
- **The lead-out is part of the addressable span, always framed.** `span = content + margin`, the
  margin floored at a substantial absolute length (kex2d: 50 m) so a short document still frames
  zoomed out with room to build into. One fit scale serves the initial frame, `F`, and the
  zoom-out floor. Content edits never move the view — append included: the framed lead-out is
  where new content appears, so there is no reveal-pan.
- **Keys route by the hovered surface** (the Blender/Unity model): `F` frames only the surface
  under the pointer; arrows act on it. One key never fires on two surfaces.

## Snapping

The AE magnet model. kex2d stage E (2026-07-19) is the worked example; any later editor surface
copies this shape:

- Persistent toggle, default **on**; `S` toggles; holding Ctrl/Cmd inverts while held (the
  AE/Figma temporary bypass — XOR with the toggle, not a plain disable).
- **The toggle's home is a tool rail on the timeline dock's left edge** — thin, icon-only, the
  Premiere vertical tool-strip. The rail is anatomy of the one earned dock, not a second region,
  and it holds only persistent *global* authoring toggles (a keyboard twin + a quiet state). A
  rail that needs grouping or scrolling has become a cockpit — something leaves. The viewport
  itself carries zero standing chrome.
- A pure per-axis resolver in screen px; nearest target within threshold wins. The threshold is a
  design constant (kex2d `SNAP_PX` = 8), zoom-independent, never a tuned tolerance.
- **Targets are content landmarks or the domain's semantic quantum — never display artifacts.**
  Landmarks: other keyframes, section boundaries, the playhead, physical baselines (1g). A raster
  earns targethood only when the domain has a real quantum (video frames, musical beats — the
  Blender/DAW case). A **force keyframe** has one: it *demands* a value, so 1 m on s and 0.1 g on
  its force are its authoring vocabulary — a keyframe drag is grid-by-default + landmarks. The
  per-axis **gesture-start** landmark (the grab s / g) is a *direction-intent affordance, not a
  snap target*: it magnetizes in **every** mode, so a mostly-single-axis drag snaps the other axis
  back to exactly where it started (the "change just one axis" affordance) even under the bypass.
  Grid steps are named constants (kex2d `S_GRID` / `G_GRID`, `timeline.ts`), the merge is
  landmark-over-grid (a landmark within `SNAP_PX` wins its radius, else the grid quantizes — the
  viewport geo-grid precedent), and only a landmark flashes a guide (the grid is ambient — the axis
  magnet is a landmark, so it keeps its flash). The timeline's *non-authoring* axes stay
  landmarks-only — the extent trim and the playhead scrub place no value, so they're the AE/Premiere
  case (nothing to quantize). **One modifier, Ctrl/Cmd, frees values but never direction:** it
  zeroes the grid + value landmarks (continuous values), while the gesture-start axis magnet keeps
  firing — there is deliberately no fully-free mode. **There is no Shift dominant-axis lock on a
  force-keyframe drag** (the per-axis start magnet already serves single-axis intent, so a lock is
  redundant); Shift is a no-op there.
  The shaping viewport carries one too: the building vocabulary is the quantum, and **snap quantizes what
  the piece does** — a pure grid, snap-by-default, forked by node role. A **tip** snaps polar length
  and angle on the per-user configurable increments (defaults 1 m / 5°; the 1 m `LENGTH_MIN` chord
  floor is a separate quantity), the angle snapping its exit-tangent *incline* (the chord that
  yields it, `incline = 2·chord − tangent`). An **interior** node has **no angle grid**: it edits on
  two signed 1D axes in the frozen prev→next chord frame (slide ∥, offset ⊥), both on the plain
  length grid through the floorless `snapGrid` — an axis whose zero is legitimate never wears
  `snapLength`'s `LENGTH_MIN` floor (a chord-degeneracy guard, meaningless on a signed coordinate);
  offset is signed, 0 and negative are real values. **A frame's axis orientation is never picked
  from the state the gesture itself moves** — a per-move sign-pick flips the readout the instant
  the drag crosses the chord. Ctrl/Cmd bypasses to continuous either way. A node whose neighbors
  coincide has a degenerate chord frame — knobs and nudge withdraw; the tangent-edit free drag or a
  neighbor move is the escape hatch. A zoom-dependent ruler tick or a nice-number gridline
  is display, not content. If nice-value targeting is ever wanted, it's a separate
  explicitly-enabled grid (the Figma split), never folded into the default magnet.
- **Manipulator quanta are per-user configurable; timeline grids stay fixed** (the Figma split:
  configure the quanta users vary, fix the rest — `S_GRID`/`G_GRID` remain named constants). The
  increment fields live in a popover summoned by right-click on the snap toggle itself (the
  Blender/Godot attachment; the app's context-menu language), persist per-user (localStorage),
  and clamp at **both ends** — floors 1° / 0.1 m, ceilings 180° / 100 m — because a persisted
  extreme collapses the control across reloads; the ceiling's job is recoverability, not
  precision. The field always displays the resolved live value (a rejected or clamped entry
  writes back), and the bypass modifier stays independent of the configured value. A popover's
  dismissal exemption targets the *invoker*, never its rail — a class-wide exemption silently
  breaks when a second rail tool arrives.
- **Node movement is per-axis 1D controls in the content's own frame** — tip = polar around the
  previous node, interior = the neighbor-chord frame — never free-2D **on the default surface** or
  world-absolute. Absolute align-x/y families fight the angle quantum and don't generalize to 3D.
  The summoned tangent-edit layer is the sanctioned free-gesture surface: there the edited node's
  body drags freely, unsnapped, through the same dead-zone/undo/blur machinery. The kex2d
  manipulator is the 3D port's template: a pure device-free module owns each axis's locus (chord
  ray, tangential arc; chord-parallel and -perpendicular lines) and its exact screen↔value
  inverses — values world-space, the y-flip folded inside, no consumer negation — with one grid
  quantizer per axis, and the frame IS the fork (a discriminated frame union, never a node-kind
  flag threaded beside it). A 1D gesture needs no pool competition, co-fire, or Shift constrain
  (those dissolved with the free drag). In 3D the angle control becomes pitch, joined by turn/roll
  rings, length unchanged; interior slide is unchanged and offset becomes the two axes in the
  plane ⊥ the chord; the free body drag becomes a view-plane drag inside the summoned layer. New
  capability is another 1D control on the ring, never restructured input.
- **Targets must be stable under the gesture and reachable.** A gesture never snaps to geometry it
  is itself moving (the extent-trim self-snap lesson) or to a target the drag can't reach.
- A snapped axis flashes a guide line (the Figma feedback); the guide clears with the gesture.
  **All guides wear one neutral gray** — a guide informs, it never alarms; the stateful color split
  is retired.
- **The selected node carries a live metrics readout** (the Figma selected-object dimensions
  idiom): floated below the node, offset past any summoned radial controls *by derivation from
  their geometry* (never a tuned gap), flipping above near the dock. It shows live values at rest
  and mid-drag; an engaged snap feeds the same readout its snapped values. Never floating chips at
  the drag point (they collide with summoned controls), never a fixed far corner (too far from the
  action).
- **The readout reports authored quantities, and shows exactly what the snap lands.** At rest:
  world exit heading + chord to the previous node, for every node. Mid-drag it reports the engaged
  control's own quantity — a tip drag the authored heading + chord (drag == rest, exactly); an
  interior drag the ∥/⊥ metres the write resolves through, both axes shown. Never a bake
  re-derivation (it drifts with resampling) and never a gesture-local value (a dragged handle's
  own angle/length is not what the author is placing). The snap must quantize the same quantity
  the readout shows and the write lands, or drag ≠ rest by the gap between the two spaces.
- **A pointerdown becomes a drag only past a dead-zone** (kex2d `DRAG_PX` = 4, the Figma/Blender
  click-vs-drag threshold); below it, release is a plain click. Window blur cancels an in-flight
  gesture completely — revert the bracketed edit, clear guides and capture. No guide may exist
  without a live, threshold-crossed drag. **Esc cancels a live gesture as its own dismissal rung**
  (revert + clear, one press peels one layer, before any mode/selection rung), and destructive
  keys (Delete/Backspace) no-op while `editor.dragging` — a structural edit never fires
  mid-gesture; the one live-gesture flag is the guard, not an enumerated drag list.

## Multiselect

The consensus grammar, compiled from Figma / Blender / AE / Unity / Premiere / Godot official
behavior (2026-07). kex2d is the worked example; any editor surface with selection copies this
shape:

- **Shift-click = toggle membership**, on every selectable target on every surface. Click empty =
  deselect all. Delete acts on the whole selection. **Ctrl/Cmd stays unbound for selection** — it's
  the snap-bypass modifier, and the reference camps disagree incompatibly on what a Ctrl-click
  should mean (add vs deep-select vs interpolation-toggle).
- **Marquee = bare left-drag on empty space** (pan never lives on left-drag; free the gesture the
  way every reference does). Shift+marquee toggles each hit. Point-in-rect over the *authoring
  atoms* only (draggable nodes, keyframe diamonds — never pinned anchors, START, or section spans);
  crosses section boundaries freely; below `DRAG_PX` the press stays a click. **A gesture sharing a
  surface with a dblclick handler takes pointer capture only past the dead zone** — capture at
  pointerdown retargets the compatibility click stream and silently kills two-click accumulation.
- **Set + active member** (Blender's active object; Unity's `activeGameObject`): selection is a
  per-kind set with the last-selected member active; single-select is the size-1 case — one
  substrate, never a parallel multi path beside scalar selections. Kinds stay mutually exclusive.
  Edit sub-modes (tangent/handle edit) collapse the selection to their one subject on entry.
  Removing the active promotes the **last-inserted survivor**. Scalar accessors read the active.
- **Promote vs replace**: a click, grab, or right-click on a set member keeps the set and promotes
  the member to active; on a non-member it replace-selects. One rule across menus and drag anchors.
- **Multi context UI** (settled by hand across four feel rounds): the viewport shows **no
  contextual controls** on a multi-set — ring, knobs, and readout all hide; single-select context on
  a multi selection is invalid. The timeline's typed-field popover is single-keyframe context too,
  so it hides on a multi-set exactly as the viewport ring does — standard multi-select shows no
  single-keyframe context, on any surface. No shared-delta readout, no count chip, no Mixed
  sentinel — AE shows nothing extra for a multi-keyframe selection; the members' highlight with the
  active set apart is the multi feedback.
- **Inapplicable bulk rows gray, never hide** (`MenuItem.enabled`); enablement is a pure,
  unit-tested predicate. Esc clears the whole set as one dismissal rung, not N.
- **Multi-drag = one shared delta, offsets preserved exactly** (universal, all keyframe editors).
  Snap resolves on the grabbed anchor first; the **rigid group clamp applies last and wins** (the
  tightest in-bounds member stops the block; a member already out of its own bounds is excluded
  from the binding set and rides its own outer clamp). A clamp that overrides the anchor's snap
  drops the snap guide. Every member writes from its gesture-start snapshot — never accumulate
  increments.
- **Geo group move = the same Δlength/Δangle applied per node in its own polar frame** (Blender's
  Individual Origins), the snap quantizing the *delta*, Ctrl bypassing. Ascending chain walk with a
  running-prev anchor inside one pass; the gesture **reads from a frozen gesture-start chain
  snapshot and writes live** — re-reading moved positions under cumulative-from-start deltas
  compounds the delta and runs away. Angle delta is chord rotation, not incline (no single incline
  reference exists across a set), and the group move stays polar Δlength/Δangle regardless of node
  kind — the chord axes are single-select controls. The section tip re-heads only when it is
  itself in the moved set. Reached by arrow-nudge only, per the context-UI law above.
- **History**: one undo entry per bulk op or gesture; single-op gestures generalize to sets; the
  selection hook snapshots the whole set by stable forms plus the active, and restores across
  entity-id recycle.

## Tangent editing

The worked example of the layered-expressiveness contract's summoned inner layer (kex2d
`tangents.ts` + tangent-edit mode); any surface exposing spline handles copies this shape:

- **Inference is the default and never a lesser mode.** The default authoring flow stores no
  tangents and is byte-identical with the handle feature absent. Handles are additive — authoring
  one never changes the default feel elsewhere. (Stamping inferred tangents concrete at append
  time was tried and reverted: it froze the live feel.)
- **The mode taxonomy is Figma's mirroring set**: `Mirror` | `Aligned` | `Free`. An inferred node
  displays as `Aligned` checked — inference is aligned-shaped, there is never a no-mode state, and
  re-picking the checked mode is a no-op.
- **The surface is summoned**: double-click enters tangent edit (handles visible only there;
  Esc/click-away exits); the node context menu carries the Handles toggle and the mode submenu.
  Mere selection shows nothing.
- **Reset returns the node to creation state** — tangents re-infer *and* the position returns to
  the default-chord continuation past the predecessor (the full law: Menus). The way back up the
  layers is one click, from anywhere. On the
  force chart that click is picking an easing preset (Easing ▸ subsumes Reset — choosing the
  layer is the reset; no separate Reset row, and the Tangents ▸ mode submenu appears only while
  explicit handles exist).
- **Handle drags are free gestures** — no raster, no guides. The one landmark is the grab ray: the
  angle latches to the grab direction while the tip stays within a perpendicular screen-px corridor
  (the angular window derived from it, never authored in degrees), so pulling out lengthens without
  bumping the angle; deviate and return and it re-latches (stateless, no monotonic release). On the
  default surface node moves snap the grid; inside tangent edit the edited node's body is a free
  gesture too (unsnapped, no guides) — the whole summoned layer expresses. And that body drag is
  **authoring**: it concretizes the subject's tangents (lazy-stamped at drag start, seeded
  jump-free from the live arc rule, riding the move's one undo entry) and never re-heads.
- **The force chart bends free-gesture on the value axis only.** A handle's Δg snaps the g-grid in
  offset space (the space the readout prints — a snapped transition reads "+0.5 g"); Δs stays
  continuous: a keyframe's s is *placement* (authoring vocabulary, snapped), a handle's Δs is
  *curvature shaping* (inherently continuous). Ctrl frees Δg; the grab-ray latch is unchanged.
- **A section boundary is one node, stitched at the UI.** A geo→geo boundary is two coincident
  entities (upstream tip + downstream node 0, the rigid-placement invariant). Tangent-editing the
  tip additionally summons the downstream node-0 out-handle — a single free entry handle (no mode
  submenu, no cross-section Mirror/Aligned coupling); dragging it writes the downstream section's
  tangent through its own gesture. Reset on the boundary clears both halves in one undo entry.
- **Role transitions never touch authored state — and deletion never re-heads.** An `Auto`
  node's `theta` is authored substrate state (set by the node's own move) exactly as an explicit
  node's tangent record is, so a structural op that removes a node's out-segment reconciles
  nothing: the promoted tip keeps its state whole — explicit tangent and frozen `Auto` heading
  alike — the surviving segment holds byte-identical, and the exit heading is what the node
  displayed before the delete (the authored out-vector, else the frozen `theta`). Re-head is own
  move + append only; only a user Reset clears authored state. **A demotion preserves** (undo
  restores the authored interior state). A split's boundary tip keeps its tangent, since it
  still shapes the downstream first segment under the one-node view. A join carries the authored
  out-half the other way: an explicit downstream node 0 is authored intent on the forward side, so
  it rotates into the upstream frame and stamps the merged tip (`in` = the tip's own in-half, `out`
  = the rotated downstream out), the tip's mode surviving only if the merged pair still satisfies
  it. An `Auto` node 0 stamps nothing — its stored `theta` is placement bookkeeping. The cost is
  deliberate: an `Auto` upstream tip merging against an explicit node 0 does get concretized,
  losing its live chord rescale, because the author's forward gesture outranks the tip's
  inference.
- **The explicit/inferred fork is a glyph channel only where it names a layer.** In the viewport a
  node's tangent being stored or still inferred is not a state the author picks (inferred is simply
  pre-first-drag, and it already displays `Aligned` checked), so every knob draws identically. On
  the force chart the same fork DOES name a layer — an explicit handle is what makes the segment
  Custom instead of its named easing — so the ghost knob stays hollow there. Don't harmonize them.

## Affordance typing

When two adds coexist, the glyphs are op-shaped: add-node is a segment-with-a-dot in the viewport,
add-section a plain `+` on the clip tail — the surface carries the rest (a 16px clip-in-a-box was
unreadable, and the inverted assignment was tried first). And one gesture means one thing: append is
the button, `Enter`, or the menu; double-click is tangent edit, never append.

- **The cursor is not an affordance channel.** Every direct-manipulation glyph keeps the arrow and
  states hover through color (the hover rung): viewport nodes, ring chrome and its manipulator
  knobs, chart keyframes, and their bezier handles alike. Grab hands mean pannable surfaces and
  nothing else — a hand over canvas-adjacent chrome reads as a link. (kex2d shed `.rbtn`,
  `.rbtn.manip`, and `.thit`'s cursors in one pass.)

## Menus

One menu substrate (kex2d `menu.ts` + `menus.ts` + `Menu.svelte` is the worked example): a menu is
pure `MenuItem` data — label, `group`, `checked`, `enabled`, `shortcut`, `danger`, `separator`,
`children` (a submenu flyout) — rendered by one recursive renderer. Every menu is an instance of
it, never a bespoke component.

**The grammar below is a gate, not a convention, and the lift is what makes it one.** Every row
array is a pure `(state, actions) => MenuItem[]` builder in its own module (kex2d `menus.ts`),
taking an explicit state descriptor and reaching no ECS, editor, or DOM, so a grammar oracle can
run every builder across its full state matrix (`tests/menu.test.ts`). That is the transferable
part for any surface adopting this: **a law over UI data embedded in component closures is a
convention; the lift to pure builders is what makes it a rule.** kex2d's menus drifted for exactly
as long as their rows lived inside `$derived.by` closures no pure test could reach.

The lift is itself pinned, because a lifted grammar decays the moment the next menu is authored
outside it. Two source pins (kex2d `tests/menu.test.ts`, beside the module-graph walk) reject a
`group:` row literal outside the builder module and the row markup outside the one renderer. A
source pin must prove it reached its input: walk the tree recursively (a non-recursive `readdirSync`
is blind to `src/ui/Menu2.svelte`) and carry a positive control, or a production spelling that drifts
makes the pattern match nothing anywhere and the pin passes forever.

**A declared registry is the general law; state it once.** Four instances share this shape —
`checked`, authored separators (below), `MenulessBindings` (kex2d `tests/menu.test.ts`), and the
cursor allowlist (`tests/colors.test.ts`) — so it lands here rather than re-derived at each site:
enumerate the population **from source**, walk the tree **recursively**, assert **both
directions** (an undeclared instance fails; an orphan declaration fails), and carry a **positive
control per direction**. A registry that ships **empty** — nothing today needs it — makes the
positive controls the whole deliverable: there is nothing else proving the machinery works. And
the clause the cursor allowlist's own bug earned: **the control must exercise the scanner, not
just the set comparison.** A control that reconstructs the assertion inline (fabricate an unlisted
site, assert it reads as unlisted) proves the diff logic and never the enumerator — a scanner gone
blind on a brace shape or a dialect it doesn't parse still passes every existing control. The
cursor allowlist shipped exactly this: its glob covered `.svelte` only and missed `controls.ts`'s
`style.cursor = "grabbing"`, the most on-point instance of the law, while every check stayed
green. The fix that generalizes: assert a raw, structure-free match count over all scanned text
equals the parsed site count — an independent read that can't miss what the real parser misses.

**Enumerate a keyboard population from a decider layer, not by hand.** `MenulessBindings` is the
law's one instance whose population is a *reachability* claim, and a hand-authored (binding → act)
table doesn't enumerate it from source. The close is a **key-act seam**: a pure `keys.ts` that is
the keyboard twin of `menus.ts` — one decider per `BINDINGS` home, `(key, stateDescriptor) →
actName | null`, returning a name from the same act vocabulary the menu builders' actions record
uses (type it `Extract<keyof XMenuActions, …>`, so a rename in the record fails the decider at
compile time). Each keydown handler becomes `const act = xKeyAct(e.key, {…}); if (act !== null) {
e.preventDefault(); acts[act](); }`; the guard predicates stay where they live and the decider
takes their results. The test drives every decider across its state space and asserts
`Acts[act] === binding`, so `MenulessBindings` covers only what no decider emits — empty, by
derivation. Two limits are the seam's stated edge, not defects: the deciders' *wiring* into the
handlers is gated by the capture flows alone (a perfect decider nobody calls passes every unit
check), and act **bodies** stay per-surface, so the seam unifies act names, not behavior. A
descriptor whose fields are read on only one branch is a discriminated union, not a boolean
product — the union deletes the unread field and narrows the return per call site.

**A descriptor field costing a full-document walk is a getter, and the gate asserts the cheap fork
reads none of them.** The pure-builder lift replaces a closure that could read the live document
lazily with an eagerly-built descriptor, which turns a menu open into whole-document work. Lazy
getters restore the laziness; nothing gates them, so a counting descriptor does — per-field counters,
a declared list of the walking fields, and an assert that the fork not needing them reads zero
(kex2d: `sectionMenu` with `inMode: true` touches none of `canSolve`, `canSolveShape`, `canPin`,
`canReset`). The out-of-mode fork is the positive control proving the counters aren't blind.

- Right-click context menus are the app's menu language; a summoned menu never covers its invoker;
  functional menus animate minimally.
- **Rows sort by group, then by frequency within the group.** Three groups, canonical order, each
  with a membership test that classifies a new row:

  | group | test | members today |
  |---|---|---|
  | `create` | the document gains an object | Add, the append flyout's Geo/Force |
  | `modify` | changes the subject that summoned the menu, or enters / acts in / leaves a mode scoped to it | Convert, Pin, Solve, Exit, Handles, Tangents ▸, Easing ▸, Lock/Unlock, Meters/Seconds |
  | `lifecycle` | the subject ends at its creation state or gone | Reset, then Delete |

  `modify` is the residual class, defined as such honestly. `danger` implies the terminal row of
  the whole menu. Frequency survives only as the *within-group* tiebreaker: as a free-form
  whole-menu rule it was a per-menu judgment call, unenforceable, and it is why node Delete led
  its menu while section Delete trailed.

  The membership tests are written about the subject, which is enough for every row shipped today
  because every row's object *is* its subject. The first op whose object is a neighbor breaks that:
  `joinNext` modifies the subject and destroys the section beside it, so the written test files it
  under `modify` while `split` files under `create`, and the pair that reads as one thought lands at
  opposite ends of the menu. Resolve this when the structural editing tier scopes, not by widening
  `lifecycle` (that still splits the pair) but by deciding whether a fourth `structure` group lands
  between `modify` and `lifecycle`. Four groups were tried once and rejected, but that rejection
  does not transfer: it was argued against splitting `mode` out of `modify`, which gave the four-row
  section menu three separators. `structure` gives a six-row section menu two.

  `GROUPS` in kex2d `src/menu.ts` is the source of truth for the group set and its canonical order;
  the table above is its prose mirror.
- **Separators derive from group boundaries.** The renderer emits a divider wherever the group
  changes (kex2d `menuRows`); builders author none. One escape hatch survives — an explicit
  `separator` is legal as a WITHIN-group divider, and the oracle constrains it to positions no
  derived boundary can occupy (never first or last, never straddling a group change). Its one
  sanctioned use is `Easing ▸`, dividing the preset picks from `Custom` (which materializes handles
  and steps into handle edit: a different kind of row, the same group). An authored divider landing
  at a boundary collapses with the derived one rather than doubling.

  Position-legal is only a floor — the oracle can say where a divider may sit, never what it
  divides — so every authored `separator` is backed by the declared-registry law above, naming
  what it separates. A label-less row has only its position as a handle, so the key is the
  containing menu's `▸` path plus the row's index in the AUTHORED array (kex2d's one member:
  `keyframeMenu ▸ Easing #3`). Reordering a submenu is then a deliberate registry edit, not silent
  breakage.
- **Rows are terse.** A context menu is summoned *on* its subject, so the row names the verb alone
  — `Delete`, not `Delete node` (the noun restates what the invoker already said, the naming rule's
  module-scope-is-context).
- **`checked` means exactly one thing: this row's state is in effect now.** Never "recently used",
  never "this is the default". Backed by the declared-registry law above — a row may light up iff
  its path is listed with the state it reports. kex2d declares 13 row paths in six families:
  `Handles`, the node `Tangents ▸` modes, the keyframe `Tangents ▸` modes, the `Easing ▸` presets,
  `Easing ▸ Custom`, and the ruler's Meters/Seconds.
- **Toggle labeling follows set-valuedness.** A toggle over a **single subject** keeps a stable
  label and carries `checked` (`Handles`). A toggle over a **set whose members can disagree** flips
  its label to name the act the press performs, and carries no check (`Lock`/`Unlock`) — a
  checkmark cannot express a mix. The two labels are one row wearing two names, never two rows.
- **`shortcut` appears iff a keyboard binding invokes that row's action**, and it names the
  ACTION, not the row's live enablement: a disabled `Add` still shows `Enter`, the way a locked-down
  `Delete` keeps `Del`. A pointer gesture is not a shortcut (`Handles` is double-click and
  advertises nothing). The bindings are a production table both ends read (kex2d `BINDINGS` in
  `menu.ts` — the handler matches its `keys`, the row prints its `hint`), so a rebind moves the hint
  with it. A table living in the test instead stays green through a rebind, which is how `L` → `Q`
  would have gone unnoticed.

  The oracle derives each row's act rather than hand-mapping it (kex2d `tests/menu.test.ts`): it
  invokes the row's own `action` against the corpus recorder and reads the logged name, then maps
  act → binding through a table censused against the recorder's full act list. A hand-typed
  `menu ▸ label` → binding map was tried and deleted — a row that IS bound but whose entry nobody
  wrote passes on `undefined === undefined`, the exact hole the derivation closes. An action-less
  row (a permanently-disabled twin like the multi-select `Add`) resolves through the same path's
  act elsewhere in the corpus, so it still owes its binding's hint; a path with no action anywhere
  is a true submenu parent and owes nothing.
- **Gray a row whose preconditions fail; omit one its subject rules out.** Graying keeps an
  applicable-but-blocked row discoverable (no live bake, a multi-set — the bulk-row law above). A
  row that could never fire on this subject is different: a section is exactly one kind, so the
  menu carries ONE conversion row whose ACTION fits that kind (kex2d `Convert` — the subject's
  kind implies the direction, so the label stays the verb alone), not one live row beside a
  permanently dead twin. Two rows for two directions spend the menu's space on a row the subject
  can never reach. **Mode-scoped state refines the same split**: a row whose subject state
  doesn't EXIST outside a mode is hidden outside it, not grayed — kex2d's keyframe Lock/Unlock
  row appears only inside pin mode (lock is mode-scoped; there is nothing to lock in normal
  editing), while the in-mode `Convert` row grays (convert exists, the mode temporarily bars
  it). Gray = "blocked action you know from elsewhere"; hidden = "state that isn't a thing
  here".
- **Reset returns its subject to the state a fresh author would get** — one click back up the
  layers, from anywhere, no confirm (byte-identical undo is the safety). Every context menu
  carries Reset as a top-level row (section, node, node 0), normal color — undo makes it
  non-destructive in spirit, so it doesn't wear Delete's danger red; gated like its neighbors,
  never on "has something to clear". A **node** reset that changes nothing records no undo entry
  (`sameNodes`); a **section** reset re-seeds its payload by destroy-and-respawn, so it always
  records.
  Node Reset re-creates: the continuation past its predecessor at the default chord
  (`EXTEND_DIST`, never the session-sticky length — unknowable creation-time state), tangents
  back to `Auto`; node 0's is the tangent clear (its position isn't authorable).
  A submenu row doesn't read as available (the buried `Tangents ▸ Reset` was moved out).
  Keyframes are the one exception: picking an easing preset subsumes Reset — choosing the
  layer is the reset. Like a destructive convert, a reset neither stamps nor consults the
  provenance sidecar.
- Flyouts fit the viewport on all four edges: flip the preferred side, clamp the rest.
- **The positioned menu box is never `overflow: hidden`** — that clips an out-of-box flyout from
  paint *and* hit-testing. The rounded-corner row-wash clip lives on an inner rows wrapper;
  flyouts mount as its sibling.
- **Menu flows are verified pointer-true**: real hover, coordinate clicks, and an
  `elementFromPoint` reachability assert. A selector-targeted `.click()` fires handlers on
  clipped, humanly-unreachable elements — a green selector test proves nothing about
  reachability. The same walk cross-checks the rendered rows against the builders themselves
  (labels, `data-group`, derived dividers), so the renderer is proven to TRANSMIT the grammar the
  oracle proves the builders obey — never against a hand-typed sequence, which a matching hand-edit
  would keep green (kex2d `kex2d-harness.md`, Verifier integrity).

## Kind color

Geo = cool blue, force = accent gold, on every surface that shows a section — clip strip, viewport
span, chart curve, navigator. One resolver produces the colored spans (kex2d `kindSegments` in
`colors.ts`); surfaces project it, never re-derive. Selection is a **brightened analog of the
element's own color** (the Ableton/Premiere clip idiom), derived by one mix-toward-white helper
over the kind token, never a flat accent recolor — flat accent over force gold reads as no
selection at all. **Hover is the rung below selection**, one meaning on one
channel — color — calibrated per element class: an *area* (clip, span, curve) lifts its fill one
`hovered()` rung (kex2d `HOVER_STEP`, derived from the clip strip's composited hover-fill step,
never tuned); a *point glyph* (keyframe diamond, node, anchor, tangent knob) lifts its
ink outline, and its fill where it has one to lift (a hollow knob's outline carries the whole
read) — the stroke joins the hovered tone (canvas glyphs through the same `hovered()`
helper; timeline glyphs to selection's own stroke token at the base width, one rung below its
selected weight) — silhouette contrast without a size change. When languages stack, priority is infeasible-red >
selection (brightened kind) > hover > kind color, enforced by feasibility-skip in every color
pass rather than draw order; dash carries not-authored-truth, red its infeasible rung (Mode
vocabulary, below). Hover's boundaries travel
with the rung: suppressed for the whole of any gesture (guard on the one live-gesture flag),
invisible on an already-selected element (selection is the stronger read of the same span), and
no cross-surface hover sync — a clip's CSS hover and the viewport span stay local to their own
surfaces.

## Mode vocabulary

Every visual channel carries exactly one meaning, on every surface that shows the state. A new
state reuses its meaning's channel; a channel with no meaning here doesn't ship — add the row
first or don't add the chrome. Earned by kex2d's pin mode (2026-08-01), where the timeline
and viewport had drifted to different dialects of the same states.

- **Pin vs Lock** — both mean hold-fixed, on different objects and at different roles. A **pin** is
  an *end*: the state a solve must restore (kex2d stamps a section's exit at mode entry). A **lock**
  is a *means*: a DOF the solver may not move (kex2d `Q`, per keyframe). Goal versus frozen
  variable. Two words because they are two things; don't collapse them.

- **Kind color** = section kind, everywhere (Kind color, above). Selection brightens it, hover is
  the rung below — one channel (color), calibrated per element class: areas lift fill, point
  glyphs lift their ink outline (and their fill where they have one) — states modulate the
  element's own color, never recolor it.
- **Accent hatch** = the mode's subject: what this mode is operating on.
- **Dim wash** (kex2d `rgba(22,20,19,0.55)`) = out-of-scope under a mode. One meaning, both
  surfaces: when a mode dims the timeline's non-subjects, the viewport dims the same spans. The
  wash is a *mode* channel and sits above the whole feasibility/selection stack — an out-of-scope
  section's infeasible-red dims with the rest (red outranks everything *within* scope; scope
  outranks red).
- **Dashed + faded** = not authored truth, with *color* carrying which kind: red dash =
  infeasible (a stable achieved-vs-demanded shortfall, Constraint-solver UX); neutral/kind-faded
  dash = shown-but-not-authored (a ghost preview, a driven/locked target, the freeze gap). Dash
  is never decoration, and infeasible-red outranks every other in-scope language (Kind color's
  priority order; the mode dim above sits over even red). Guide dashes (baseline, boundary,
  drop-lines) are the same shown-but-not-authored axis in the guide register — their one-gray
  law lives in Snapping.
- **Hollow vs filled** = target vs keyframe: constraints wear the ring, authored diamonds fill
  (Constraint-solver UX).
- **Motion** = one shared easing token (root `ui.md`): every UI transition names it, and
  `landingG`'s cubic ease-out is the same named curve — pacing reads as one hand.

The rail stays bounded to global authoring toggles; per-mode chrome (borders, cursors, badges)
is exactly the channel-without-a-meaning this table exists to refuse.

## Keyframe / curve-editor conventions

The proven-reference set for any keyframe-on-a-chart surface (worked example: kex2d
`Timeline.svelte`). Feel changes here get the hands-on check-in (`kex` `ui.md`).

- **Insert on the curve.** Double-click creates a keyframe at the authored profile's value there
  (the DAW/AE envelope-insertion identity: insertion never bends the curve), never at the cursor's
  y-value.
- **Nothing moves under its own gesture** (root `ui.md` "Surfaces hold still"). Chart addition:
  both axes clamp the cursor to the chart during a keyframe drag. Camera / document-axis
  navigation is a no-op while any gesture is live — a mid-gesture view change corrupts
  screen-space grabs — guarded on the *one* live-gesture flag (kex2d `editor.dragging`) so the
  rule can't go stale as gestures are added. Wheel and `F` are both closed. The 3D `app/`
  viewport faces the identical hazard.
- **Arrow cursor over keyframes** (AE/Unity/Blender) — the shared law, Affordance typing. Hover
  affordance is the marker's fill change.
- **Numeric fields are summoned at the object.** A selected keyframe's fields float in a popover
  at the point (root gate 3), the live readout during a drag (pointer-inert then). The field
  surface + behavior is root `ui.md` "Fields".
- **Dismissal is layered** (root `ui.md` "Surfaces hold still"): keyframe selection is the
  transient layer between the focused field and the surface.
- **No dominant-axis lock on a keyframe drag.** The per-axis gesture-start magnet (Snapping, above)
  already snaps the near-still axis back to its start, so a Shift lock is redundant; Shift is a
  no-op on a keyframe drag. Single-axis intent is the magnet's job, not a modifier's.
- **Easing lives on the leading keyframe** (the Blender F-curve convention) and governs its
  following segment. The curve span between two keyframes is a *hit-target addressing the leading
  keyframe*, never a selectable object — right-click the curve to change that transition, without
  adding a new selection kind. The terminal keyframe carries no Easing submenu.
- **The easing middle layer is a small named menu, never a scalar.** The layers trade one decision
  degree per step for strictly more expressiveness: default (zero decisions) → named eases (one
  categorical pick — Linear | Cubic | Quintic, the FVD++ ladder vocabulary) → handles (the full
  manifold). A continuous knob between menu and handles inverts the trade (AE's keyframe-velocity
  influence dialog is the cautionary case); asymmetry and overshoot live in the handle layer.
- **Custom is derived provenance — and a choice.** The Easing menu's Custom row is checked iff
  explicit tangents bound the addressed segment (this keyframe's out + the next one's in), never a
  stored flag. Choosing Custom materializes the current derived tangents in place (no curve jump);
  choosing a preset clears those two sides back to it. Presets and handles are one bezier family
  resolved at one seam — there is no second evaluator.
- **Scaffolding controls float as satellite surfaces.** A control a staged design will remove
  (the whole-track geo/force toggle before per-section kinds) floats as its own small opaque
  surface OUTSIDE the content it governs; overlapping it reads as a bug, and a docked row would
  have to be given back later.

## Constraint-solver UX

Earned by the kex2d force-target dogfoods (2026-07-05); applies to any authored-constraint +
invoked-solve surface, 2D or 3D.

- **Author in the solver's invariant domain.** The axis a constraint is placed on must be one the
  solver holds fixed. A derived display domain stretches under the tool's own operations
  (kex2d's time axis over a Distance-domain store was the worked failure — the honest-slide
  rejection); authoring on an axis requires the store to hold that axis's unit fixed (the
  track-global domain conversion is how kex2d earns it).
- **Constraints are not keyframes.** An optimization target gets the constraint idiom, not the
  keyframe diamond: a distinct (hollow/ring) glyph, the residual made visible (a dotted drop-line
  from demand to achieved), and the CAD-sketcher **driving vs driven** states — activation is a
  persistent authored flag (driven = dashed + faded, still measures, never moves geometry), never
  ephemeral selection, which evaporates on the next empty-space click.
- **An invoked solve is idempotent.** One press reaches the fixpoint; a second press is a no-op.
  If internal state (a frozen grid, a linearization) goes stale as the solution moves, iterate it
  *inside* the invocation. A demand still unmet after convergence displays as stable infeasibility
  (achieved-vs-demanded), never as "press again for more effect".

## Sandbox-mode UX

Earned by kex2d's pin mode (three feel iterations, 2026-07-30 — a transactional bracket and
a continuous-history model were both built and superseded by hand); applies to any mode whose
point is an experiment the user confirms or abandons — an invoked-solve workspace, a preview
edit, a what-if.

- **The mode's state is temporary: nothing applies until the confirming action.** In-mode edits
  live in the mode's own history stack (a sandbox), not the document's. In-mode undo/redo walk
  that stack alone; pre-mode history is unreachable from inside; **undo at the sandbox's start
  exits the mode** — the undo key never "runs out" into unrelated document history.
- **Dismissal discards without trace.** Exit/Esc reverts every in-mode edit and leaves the outer
  undo AND redo stacks byte-identical to before entry — a user who backs out was never there.
- **The confirming action lands ONE outer entry carrying the whole experiment.** Undoing that
  entry reopens the mode with the experiment resumed (draft, mode settings, and the in-mode
  undo/redo stacks all restored); redoing it re-lands and closes. The entry is the mode's single
  footprint in document history.
- **The mode is a consent boundary — an editing lockdown.** Only the mode's subject is editable
  while it's open; everything else grays (or hides, per the menus law's mode-scoped clause). The
  lockdown is also what makes the mode's cached readings (a stamped target, a frozen seed)
  stable without re-derivation.
- **Derived state downstream of the subject freezes at mode entry** rather than live-updating
  through transient in-mode states that can never survive: the gap that opens between the
  subject and its frozen downstream IS the residual, the same truth a drop-line shows. Any close
  (confirm or discard) repropagates.
- **A refusal is not an exit.** A confirming action that can't complete reports tersely on the
  app's shared status surface and stays in the mode with the draft untouched.

## Surface and motion

kexedit owns its own visual identity (FVD, its own palette) — don't import Shallot's gold. The
principles (reduce to earn, opaque surfaces, one easing token) are root `ui.md`. The kex2d
`Timeline` dock is the worked example: opaque, no resize, persistent transport.
