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
first): no tools, no modes — click a node and drag it, radial extend/delete buttons summoned at
the selected chain end, force keyframes authored on the timeline curve itself, their typed fields
in a popover at the point.

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
