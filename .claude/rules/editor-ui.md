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
   extend/delete buttons summoned at the selected chain end (force pins authored on the curve
   are the planned shape of the optimization spike).
4. **Low floor, high ceiling.** A newcomer drags nodes and sees the track react; an expert reaches
   it faster through the keyboard (Enter extends, Del trims, Space plays). Capability is summoned,
   not displayed.
5. **Instant and reversible.** Edits re-bake and show immediately, no apply step, and
   undo cleanly (`history.ts`).

## The kexedit bend: the force curve earns persistence

A coaster's canonical representation is its **F_n force curve**, not the node positions you drag to
shape it. So the force-curve timeline is *always-present critical information* — you author against
it continuously, the way a DAW keeps its waveform docked. That's the one spot kexedit bends gate 1
toward a persistent dock, exactly as Shallot's editor keeps an inspector that a pure canvas tool
wouldn't need.

The bend is bounded, not a license for a cockpit: the timeline is the **only** earned permanent
dock. It still clears gates 2–5 — the track shows a clean curve, not empty controls; every edit
re-bakes live and undoes (and when the optimization spike lands, pins drop and drag on the curve
itself, gate 3). A new surface is a popover or a viewport affordance summoned in context, never a
second docked region.

**Playback is the player; authoring is the timeline — one clock, two scopes.** The ride plays
continuously (no play/edit *mode*); the transport is a separate surface (a *global* full-track
scrub player) isolated from the on-curve authoring controls, over the timeline's *zoomed-local*
view of the same clock — the After Effects comp-vs-timeline relationship. So: don't reintroduce the
old Unity playback/edit *mode* split, and don't add a second video frame — in 2D the viewport
already *is* the playback. A separate playback render earns its place only for a different **camera**
(a rider POV), a 3D `app/` concern, not 2D kex2d.

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
