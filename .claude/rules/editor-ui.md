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
too. The editors are Shallot apps and inherit Shallot's editor posture: the full engine-editor
treatment is `shallot/.claude/rules/editor-ui.md` + `visual-identity.md`, and this file is the
kexedit-framed version. Where they overlap, they agree — keep them that way.

## Posture: the track, not the cockpit

The viewport is the product. The track fills the screen; chrome is contextual and minimal — a
*canvas* (Figma, Linear), not a *cockpit* (classic Blender) where every panel is docked and loud
at once. The cockpit's failure isn't having panels, it's that they all claim attention equally and
continuously, so nothing is foreground. Attention is the scarce resource, not screen space.

## The gates

Every UI decision clears these.

1. **Earn its place.** Monitored continuously → persistent. Acted on occasionally → summoned
   (contextual button, popover), never docked.
2. **Quiet when silent.** Nothing relevant to show → empty, dimmed, or collapsed, not loud. A
   persistent *location* is fine; loud-while-irrelevant *contents* are not.
3. **On the object first.** If it can be manipulated in the viewport (drag a node, a handle), it
   belongs there, not in a panel. A panel control justifies itself only when the data has no
   spatial form. kex2d is the model: no tools, no modes — click a node and drag it, radial
   extend/delete buttons summoned at the selected chain end, force pins authored on the
   timeline curve, position pins on the track itself.
4. **Low floor, high ceiling.** A newcomer drags nodes and sees the track react; an expert reaches
   it faster through the keyboard (Enter extends, Del trims, Space plays). Capability is summoned,
   not displayed.
5. **Instant and reversible.** Edits re-bake and show immediately, no apply step, and
   undo cleanly (`history.ts`).

## Layered expressiveness

Two commitments, held together:

1. **Full arbitrary expressiveness at the inner layer, accessible.** The substrate never caps what
   a determined author can express — the solver takes arbitrary weighted residuals, the node chain
   is free-form. Power is reachable, not fenced off.
2. **Deliberately constrained upper layers.** The default authoring surface is *intentionally* less
   expressive than the substrate — the constraint is the feature, not a compromise: inferred
   arc-rule tangents instead of exposed bezier handles (the Planet Coaster lesson), a constant
   target band before a keyframed profile. Upper layers optimize author strain, iteration speed,
   and attention (the gates above); each step down toward the substrate is summoned, never default.

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
toward a persistent dock, exactly as Shallot's editor keeps an inspector that a pure canvas tool
wouldn't need.

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
*principles* carry over:

- **Reduce to earn.** Every border, divider, shadow earns its place. Reach for spacing and surface
  color shifts before lines; distinguish regions by background step, not borders.
- **Opaque docked + floating surfaces.** A docked surface (the timeline) and any floating one
  (menu, popover, picker) is opaque and, when docked, fixed — never a translucent fill over the
  live viewport, where it hurts legibility. Elevation comes from border + shadow. The kex2d
  `Timeline` dock is the worked example: opaque, no resize, persistent transport.
- **Instant feedback motion.** Transitions use one shared easing token (`--ease-out`), ~150ms
  default, ~100ms for interactive active states; buttons get a subtle scale + wash on `:active`.
