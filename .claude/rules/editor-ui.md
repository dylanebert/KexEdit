---
paths:
    - "**/*.svelte"
    - "kex2d/**/*.ts"
---

# Editor UI

## Layered expressiveness

Direct, live, undoable authoring; summon depth, never cap expressiveness. Infer tangents; translate mechanisms into wants. `kex2d/AGENTS.md` owns segment model/unfinished gesture migration. Display geometry-recovered forces, never demanded/smoothed substitutes; readouts name authored quantities.

## The kexedit bend: the force curve earns persistence

Only force timeline docks: opaque, fixed, quiet. On-object controls; scaffolding outside content. No standing viewport chrome. Icon rail: global toggles/keyboard twins only; grouping/scrolling means something leaves. Own palette, not Shallot's.

One clock, global transport/local authoring, no play/edit split. Read playhead, never move it; scrub never edits. Another render requires another camera.

## Document axis vs value axis

Content never pans/zooms, append included. Navigation fits lead-out (50 m floor). Value axes fit at rest; only overshoot grows held display, only anchor channel. One gesture flag blocks navigation/destructive keys.

## Snapping

`magnet.ts`/`timeline.ts` and tests own quanta/resolvers. S toggles default-on; Ctrl/Cmd inverts. Stable reachable landmarks/semantic quanta, not display artifacts. Start magnets survive bypass; Shift does nothing. Guides neutral gray; trim/scrub landmarks-only.

`manipulator.ts`: content-frame 1D, never world-axis/free-2D. 3D adds pitch/turn/roll, perpendicular offsets; view-plane body drag only in tangent edit.

User increments at snap-toggle right-click, fixed timeline grids. Resolved fields; invoker-only dismissal exemption. Readouts follow ring geometry, match authored snap/write, never bake values/cursor chips.

4 px dead-zone; delay capture for double-click. Blur reverts/clears capture/guides; Esc cancels gesture before mode/selection. Guides require live drag.

## Multiselect

`editor.ts` owns one typed set/active, promotion/containment. Stable-address history. Shift toggles, empty clears, Ctrl/Cmd isn't selection. Left marquee selects atoms, never pans. Keys: active kind then hover, never twice.

Multi context UI counts siblings, not owner+child. No rings/knobs/readouts/popovers/count/Mixed/delta chrome; highlight members/active. Esc clears set; submodes collapse to subject; blocked bulk rows gray.

Snapshot delta preserves offsets; snap then rigid clamp. Mixed force/velocity moves station only; cross-surface nudge scopes to hovered active kind. Geo bulk nudge: frozen-chain polar, only moved tip re-heads. One undo. `controls.test.ts`/`timeline.test.ts` own cases.

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

`colors.ts`/tests own palette and priority: red > brightened own-color selection > hover > kind. Hover lifts ink/fill, never size; selected bodies suppress, resize handles don't. Foreign gestures suppress, own-surface retains; no cross-surface sync.

## Mode vocabulary

One meaning/channel, no decorative mode chrome. Pin goal, lock DOF. Hatch subject; dim out-of-scope on both surfaces above red. Dash/fade not authored; red infeasible. Velocity across kinds: recovered dashed/faded, authored solid/bright. Hollow targets, filled keys; shared easing including landing.

## Keyframe / curve-editor conventions

Insert profile value, not cursor y; easing may reshape. Leading key owns easing menu, not curve hits; terminal has none. Named easing, not scalar. On-point fields, inert during drag; dismissal peels field then selection.

Press-relative value offset survives scale growth; never rebase press/reuse pixel gap. `timeline.ts`/`track.ts` tests own collisions: refuse, not overwrite/order-clamp; value moves, crossing resumes. Restore never repairs history.

## Constraint-solver UX

Invariant arclength; time is frozen-per-gesture projection. Targets use persistent driving/driven flags, not selection; driven measures only. Show demand/achieved residual. Solve reaches fixpoint in one press; shortfall is stable infeasibility.

## Sandbox-mode UX

Subject-only editing, separate history; undo at start exits. Exit/Esc preserves outer stacks byte-identically. Confirm: one entry, undo reopens draft/settings/stacks, redo re-lands. Downstream freezes until close. Refusal reports shared status, keeps draft.
