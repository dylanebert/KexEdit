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
- **Reset always re-infers** — the way back up the layers is one click, from anywhere. On the
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
- **Role transitions reconcile role-dependent state.** The tip heading has one source of truth, so
  a structural op that removes a node's out-segment must reconcile its tangent: **a promotion
  resets** (delete clears the promoted tip's explicit tangent to `Auto`, then re-heads — the result
  is indistinguishable from authoring the shorter chain directly), **a demotion preserves** (undo
  restores the authored interior state). Snapshot for undo *after* reconciling. The law fires when
  the out-segment is removed — a split's boundary tip keeps its tangent, since it still shapes the
  downstream first segment under the one-node view.

## Affordance typing

When two adds coexist, the glyphs are op-shaped: add-node is a segment-with-a-dot in the viewport,
add-section a plain `+` on the clip tail — the surface carries the rest (a 16px clip-in-a-box was
unreadable, and the inverted assignment was tried first). And one gesture means one thing: append is
the button, `Enter`, or the menu; double-click is tangent edit, never append.

## Menus

One menu substrate (kex2d `menu.ts` + `Menu.svelte` is the worked example): a menu is pure
`MenuItem` data — label, `checked`, `enabled`, `shortcut`, `danger`, `separator`, `children` (a
submenu flyout) — rendered by one recursive renderer. Every menu is an instance of it, never a
bespoke component.

- Right-click context menus are the app's menu language; a summoned menu never covers its invoker;
  functional menus animate minimally.
- **Rows are terse and frequency-ordered.** A context menu is summoned *on* its subject, so the row
  names the verb alone — `Delete`, not `Delete node` (the noun restates what the invoker already
  said, the naming rule's module-scope-is-context). Order by how often a row is reached, not by
  safety or by the order the features were built; `danger` marks the destructive row, so a
  frequently-used delete leads without reading as a trap.
- **Gray a row whose preconditions fail; omit one its subject rules out.** Graying keeps an
  applicable-but-blocked row discoverable (no live bake, a multi-set — the bulk-row law above). A
  row that could never fire on this subject is different: a section is exactly one kind, so the
  menu carries ONE conversion row whose ACTION fits that kind (kex2d `Convert` — the subject's
  kind implies the direction, so the label stays the verb alone), not one live row beside a
  permanently dead twin. Two rows for two directions spend the menu's space on a row the subject
  can never reach. **Mode-scoped state refines the same split**: a row whose subject state
  doesn't EXIST outside a mode is hidden outside it, not grayed — kex2d's keyframe Lock/Unlock
  row appears only inside optimize mode (lock is mode-scoped; there is nothing to lock in normal
  editing), while the in-mode `Convert` row grays (convert exists, the mode temporarily bars
  it). Gray = "blocked action you know from elsewhere"; hidden = "state that isn't a thing
  here".
- **Reset returns its subject to the state a fresh author would get** — one click back up the
  layers, from anywhere, no confirm (byte-identical undo is the safety). The section menu's
  Reset row (normal color — undo makes it non-destructive in spirit, so it doesn't wear Delete's
  danger red; gated like its neighbors) is the section-level instance; node and keyframe
  resets keep their existing idioms (`Tangents ▸ Reset`; picking an easing preset subsumes
  Reset) — adding rows there would duplicate, not unify. Like a destructive convert, a reset
  neither stamps nor consults the provenance sidecar.
- Flyouts fit the viewport on all four edges: flip the preferred side, clamp the rest.
- **The positioned menu box is never `overflow: hidden`** — that clips an out-of-box flyout from
  paint *and* hit-testing. The rounded-corner row-wash clip lives on an inner rows wrapper;
  flyouts mount as its sibling.
- **Menu flows are verified pointer-true**: real hover, coordinate clicks, and an
  `elementFromPoint` reachability assert. A selector-targeted `.click()` fires handlers on
  clipped, humanly-unreachable elements — a green selector test proves nothing about
  reachability.

## Kind color

Geo = cool blue, force = accent gold, on every surface that shows a section — clip strip, viewport
span, chart curve, navigator. One resolver produces the colored spans (kex2d `kindSegments` in
`colors.ts`); surfaces project it, never re-derive. Selection is a **brightened analog of the
element's own color** (the Ableton/Premiere clip idiom), derived by one mix-toward-white helper
over the kind token, never a flat accent recolor — flat accent over force gold reads as no
selection at all. **Hover is the rung below selection**, a `hovered()` variant of the element's
own kind color with one derived knob (kex2d `HOVER_STEP`, derived from the clip strip's
composited hover-fill step, never tuned). When languages stack, priority is infeasible-red >
selection (brightened kind) > hover > kind color, enforced by feasibility-skip in every color
pass rather than draw order; dash stays reserved for infeasibility. Hover's boundaries travel
with the rung: suppressed for the whole of any gesture (guard on the one live-gesture flag),
invisible on an already-selected element (selection is the stronger read of the same span), and
no cross-surface hover sync — a clip's CSS hover and the viewport span stay local to their own
surfaces.

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
- **Arrow cursor over keyframes** (AE/Unity/Blender); grab hands mean pannable surfaces. Hover
  affordance is the marker's fill change, not the cursor.
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

Earned by kex2d's optimize mode (three feel iterations, 2026-07-30 — a transactional bracket and
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
