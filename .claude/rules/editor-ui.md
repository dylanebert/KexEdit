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
  its force are its authoring vocabulary — a keyframe drag is grid-by-default + landmarks, with a
  per-axis **gesture-start** landmark (the grab s / g) so a mostly-single-axis drag snaps the other
  axis back to exactly where it started (the "change just one axis" affordance). Grid steps are
  named constants (kex2d `S_GRID` / `G_GRID`, `timeline.ts`), the merge is landmark-over-grid (a
  landmark within `SNAP_PX` wins its radius, else the grid quantizes — the viewport geo-grid
  precedent), and only a landmark flashes a guide (the grid is ambient). The timeline's
  *non-authoring* axes stay landmarks-only — the extent trim and the playhead scrub place no value,
  so they're the AE/Premiere case (nothing to quantize). Ctrl/Cmd bypasses all of it.
  The shaping viewport carries one too: the building vocabulary is the quantum, and **snap quantizes what
  the piece does** — a pure grid, snap-by-default: chord length to whole meters (1 m floor), angle
  to a 5° grid, uniform tip + interior. A tip snaps its exit-tangent *incline* (the chord that
  yields it, `incline = 2·chord − tangent`), an interior node its chord angle; the old tip-only
  asymmetry existed only because a proximity quantum couldn't reach a frozen heading — a plain grid
  needs none. Ctrl/Cmd bypasses to continuous. A zoom-dependent ruler tick or a nice-number gridline
  is display, not content. If nice-value targeting is ever wanted, it's a separate
  explicitly-enabled grid (the Figma split), never folded into the default magnet.
- **Node movement is per-axis 1D controls in the content's own polar frame** (the previous node,
  the piece being built), never free-2D or world-absolute. Absolute align-x/y families fight the
  angle quantum and don't generalize to 3D. The kex2d polar manipulator is the 3D port's template:
  a pure device-free module owns each axis's locus (chord ray, tangential arc) and its exact
  screen↔value inverses — values world-space, the y-flip folded inside, no consumer negation —
  with one grid quantizer per axis. A 1D gesture needs no pool competition, co-fire, or Shift
  constrain (those dissolved with the free drag). In 3D the angle control becomes pitch, joined by
  turn/roll rings; length unchanged. New capability is another 1D control on the ring, never
  restructured input.
- **Targets must be stable under the gesture and reachable.** A gesture never snaps to geometry it
  is itself moving (the extent-trim self-snap lesson) or to a target the drag can't reach.
- Snap never fires on a Shift-locked axis — the constraint owns it.
- A snapped axis flashes a guide line (the Figma feedback); the guide clears with the gesture.
  **All guides wear one neutral gray** — a guide informs, it never alarms; the stateful color split
  is retired.
- **The selected node carries a live metrics readout** (the Figma selected-object dimensions
  idiom): floated below the node, offset past any summoned radial controls *by derivation from
  their geometry* (never a tuned gap), flipping above near the dock. It shows live values at rest
  and mid-drag; an engaged snap feeds the same readout its snapped values. Never floating chips at
  the drag point (they collide with summoned controls), never a fixed far corner (too far from the
  action).
- **The readout reports the node's authored quantities** — its world exit heading and the chord to
  the previous node — the same value mid-drag and at rest, exactly. Never a bake re-derivation (it
  drifts with resampling) and never a gesture-local value (a dragged handle's own angle/length is
  not what the author is placing). The snap must quantize the same authored quantity the write
  re-heads to, or drag ≠ rest by the gap between the two spaces.
- **A pointerdown becomes a drag only past a dead-zone** (kex2d `DRAG_PX` = 4, the Figma/Blender
  click-vs-drag threshold); below it, release is a plain click. Window blur cancels an in-flight
  gesture completely — revert the bracketed edit, clear guides and capture. No guide may exist
  without a live, threshold-crossed drag.

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
- **Reset always re-infers** — the way back up the layers is one click, from anywhere.
- **Handle drags are free gestures** — no raster, no guides. The one landmark is the grab ray: the
  angle latches to the grab direction while the tip stays within a perpendicular screen-px corridor
  (the angular window derived from it, never authored in degrees), so pulling out lengthens without
  bumping the angle; deviate and return and it re-latches (stateless, no monotonic release). Node
  moves snap the grid; handle drags express.
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
selection at all. When languages stack, priority is infeasible-red > selection (brightened kind)
> kind color, and dash stays reserved for infeasibility.

## Keyframe / curve-editor conventions

The proven-reference set for any keyframe-on-a-chart surface (worked example: kex2d
`Timeline.svelte`). Feel changes here get the hands-on check-in (`kex` `ui.md`).

- **Insert on the curve.** Double-click creates a keyframe at the authored profile's value there
  (the DAW/AE envelope-insertion identity: insertion never bends the curve), never at the cursor's
  y-value.
- **Nothing moves under its own gesture** (root `ui.md` "Surfaces hold still"). Chart addition:
  both axes clamp the cursor to the chart during a keyframe drag.
- **Arrow cursor over keyframes** (AE/Unity/Blender); grab hands mean pannable surfaces. Hover
  affordance is the marker's fill change, not the cursor.
- **Numeric fields are summoned at the object.** A selected keyframe's fields float in a popover
  at the point (root gate 3), the live readout during a drag (pointer-inert then). The field
  surface + behavior is root `ui.md` "Fields".
- **Dismissal is layered** (root `ui.md` "Surfaces hold still"): keyframe selection is the
  transient layer between the focused field and the surface.
- **Shift constrains a two-axis drag** to the dominant axis since the grab (the AE/Photoshop
  rule), re-evaluated live mid-drag. No hysteresis; the escalation if it flickers is explicit
  Blender-style axis keys, not a tuned threshold.
- **Scaffolding controls float as satellite surfaces.** A control a staged design will remove
  (the whole-track geo/force toggle before per-section kinds) floats as its own small opaque
  surface OUTSIDE the content it governs; overlapping it reads as a bug, and a docked row would
  have to be given back later.

## Constraint-solver UX

Earned by the kex2d force-target dogfoods (2026-07-05); applies to any authored-constraint +
invoked-solve surface, 2D or 3D.

- **Author in the solver's invariant domain.** The axis a constraint is placed on must be one the
  solver holds fixed. A *derived* display domain (kex2d: time, `t = Σ ds/v`) stretches under the
  tool's own operations, so anchors authored there slide around during solves and unrelated edits.
  Display the derived domain as a secondary read-only view if it's wanted, never as the authoring
  axis.
- **Constraints are not keyframes.** An optimization target gets the constraint idiom, not the
  keyframe diamond: a distinct (hollow/ring) glyph, the residual made visible (a dotted drop-line
  from demand to achieved), and the CAD-sketcher **driving vs driven** states — activation is a
  persistent authored flag (driven = dashed + faded, still measures, never moves geometry), never
  ephemeral selection, which evaporates on the next empty-space click.
- **An invoked solve is idempotent.** One press reaches the fixpoint; a second press is a no-op.
  If internal state (a frozen grid, a linearization) goes stale as the solution moves, iterate it
  *inside* the invocation. A demand still unmet after convergence displays as stable infeasibility
  (achieved-vs-demanded), never as "press again for more effect".

## Surface and motion

kexedit owns its own visual identity (FVD, its own palette) — don't import Shallot's gold. The
principles (reduce to earn, opaque surfaces, one easing token) are root `ui.md`. The kex2d
`Timeline` dock is the worked example: opaque, no resize, persistent transport.
