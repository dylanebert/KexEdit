---
paths:
    - "**/*.svelte"
    - "kex2d/**/*.ts"
---

# Editor UI

## Layered expressiveness

Live/undoable; disclose depth, never cap it. Infer tangents; translate mechanisms into wants. `kex2d/AGENTS.md` owns segments. Name authored quantities; never substitute demand/smoothing for recovered forces.

## The kexedit bend: the force curve earns persistence

140px dock, 26px rows. Left Select (V)/Add (A): 40px strip/8px gap, 32px buttons/16px glyphs, hover names. Logical CSS; only canvas backing/transform scales by DPR. Global rail: toggles/key twins.

One clock: global transport/local authoring, no play/edit split. Authoring holds playhead; scrub never edits. Another render needs another camera.

## Document axis vs value axis

Content never pans/zooms, append included. Navigation fits lead-out (50 m floor). Value axes fit at rest; only overshoot grows held display, only anchor channel. One gesture flag blocks navigation/destructive keys.

## Snapping

`magnet.ts`/`timeline.ts` and tests own quanta/resolvers. S toggles default-on; Ctrl/Cmd inverts. Stable reachable landmarks/semantic quanta, not display artifacts. Start magnets survive bypass; Shift does nothing. Guides neutral gray; trim/scrub landmarks-only.

`manipulator.ts`: content-frame 1D, never world-axis/free-2D. 3D adds pitch/turn/roll, perpendicular offsets; view-plane body drag only in tangent edit.

User increments at snap-toggle right-click, fixed timeline grids. Resolved fields; invoker-only dismissal exemption. Targets use authored units; aligned recovery reads bake `ds` at hover, else playhead. Missing coverage/unresolved entry: unavailable, never exit.

4 px: edge click opens station field, drag resizes; no double-click act. Cancel/blur/deletion/teardown revert/release; up commits. Guides only while dragging. Fields own keys: Enter once, Escape/blur revert.

## Multiselect

`editor.ts`: one stable-id set/active. Shift toggles, empty clears, not Ctrl/Cmd. Multi highlights only, no fields/bulk edit; plain drag edits its subject.

Select gaps clear; Add previews/creates one lane/undo then Select; refusal stays Add, Escape cancels. V/A: local focus/hover, never typing/menu/gesture. Escape peels field/gesture, menu, Add, editor, selection.

Nudges: station left/right, target Shift+up/down; no Alt entry binding.

## Tangent editing

Double-click/Handles, not selection. Mirror/Aligned/Free; inferred Aligned, identical glyphs. `tangents.ts`/`track.ts`/`history.ts` and tests own free drags/stitching/Reset. Role changes preserve authored state; re-head only own move/append, never tangent-edit body drag.

## Affordance typing

Add-node: segment-with-dot; add-member: tail +. Append button/Enter/menu, never double-click. Glyphs keep arrow; hands mean pan.

## Menus

`menu.ts`/`menus.ts`/`keys.ts`/`acts.ts` and `tests/menu.test.ts` own grammar. Hoist document/editor acts; name local dependencies. Factories spread last, only close over; walking descriptors are getters. Ops own consent; keys/menus land together. Census isn't wiring proof; pointer-true flows are.

Terse verbs, group then frequency, danger terminal. Dormant structure returns for neighbor-reaching acts, not mode subgroup. Dividers derive; exceptions declare meaning/position. Checked means current state; mixed-capable toggles name action without check. Gray blocked; omit impossible subject/mode/surface actions. Surface-dependent builders require explicit surface.

Shortcuts: repeated use, nameable position (include playhead), one verb/key, mnemonic before reach; reach-only letters unclaimed across reference tools. Bare letters; document modifiers. Sandbox reuse needs lockdown/registry; taste rebindings amend law/exemption. Registries: recursive source census, both ways, scanner controls even empty; match shape not names, independently verify parser reach.

Reset: top-level, normal color, no confirm, creation state; keyframes pick easing instead. No provenance sidecar. Right-click names only what's under it. Menus avoid invoker; flyouts stay reachable outside inner row clip.

## Kind color

`colors.ts`/tests: red > brightened kind selection > hover > kind. Hover lifts ink/fill, not size; selected bodies suppress, handles don't. Timeline: ew-resize, handles above hatch, same shared-edge hover/press hit. Foreign gestures suppress; own-surface retains; no cross-surface sync.

## Mode vocabulary

One meaning/channel, no decorative mode chrome. Pin goal, lock DOF. Hatch subject; dim out-of-scope on both surfaces above red. Dash/fade not authored; red infeasible. Velocity across kinds: recovered dashed/faded, authored solid/bright. Hollow targets, filled keys; shared easing including landing.

## Keyframe / curve-editor conventions

Insert profile value, not cursor y; easing may reshape. Leading key owns easing menu, not curve hits; terminal has none. Compact Target/unit and named shared easing disclose entry/range/residual. Override explicitly; inherited starts are summary-only. End-only ripple has no shortcut; disable its checkbox during edits.

Measure overlays; clear dock/handles. Hold screen x/y through edits; invalidating layout cancels before refit. Bake stays live.

Hold press-relative offsets through scale growth; never rebase/reuse pixel gap. Timeline/store tests pin collision refusal, not overwrite/order-clamp; crossing resumes. Restore never repairs history.

## Constraint-solver UX

Invariant arclength; freeze time projection per gesture. Lane order/overlap derives driving, never selection/stored flags; disclose demand/achieved residual. Invoked solve reaches fixpoint; shortfall is stable infeasibility.

## Sandbox-mode UX

Subject-only editing, separate history; undo at start exits. Exit/Esc preserves outer stacks byte-identically. Confirm: one entry, undo reopens draft/settings/stacks, redo re-lands. Downstream freezes until close. Refusal reports shared status, keeps draft.
