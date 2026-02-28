# kex2d

2D coaster solver prototype. Shallot + Svelte + canvas2D. The exploration harness for a free-drag track model (free node positions → cubic Hermite interpolation → physical force recovery → F_n curve), mouse-driven and direct, parallel to `app/` (the eventual Shallot port). Whether it replaces / augments / coexists with the 3D editor decides once it earns its place.

Next steps live in `kex/roadmap.md` "kex2d"; in-flight design rationale + the unbuilt optimizer design in `kex/scratch.md` "kex2d solver".

## Model

Free-drag authoring, mouse-driven. The **control scheme** and the **representation** are separate: the controls place free node positions, dragged directly; the canonical representation is the F_n curve. Each node carries a position (dragged) **and a stored heading θ**, never directly authored — derived from position by the circular-arc reflection (below). The **first node is a fixed flat anchor** (θ = 0): the track always launches horizontally.

- **Interpolate.** `sampleChain` (`spline.ts`) samples a cubic Hermite curve through every node, the tangent **direction** read from each node's stored heading and the tangent **length** scaled by the live chord (`|T| = chord·sec²(φ/2)`, the cubic best-fit to a circular arc — `k=1` for straight, saturated for near-U-turns). Strict local support: a drag moves **only the two segments that share the dragged node** — nothing before the previous node or after the next moves. The **last** (heading) node carries a standing invariant — its angle is always the reflection of its predecessor's heading — so its segment stays a clean arc and its angle never goes stale and jumps. It re-derives (`headLast`) whenever the tail changes: a drag of the tip or the node before it, or a deletion that promotes a new tip. The **first** node is a fixed flat anchor and **interior** nodes keep their heading frozen: the arc contract can't hold on both of an interior node's segments at once, so a stable heading is chosen over one that thrashes (lengths still re-proportion to the live chord). A frozen interior heading dragged far off its chord bulges — the accepted misshaping.
- **Recover force.** `forces` (`bake.ts`) reads the sampled positions → per-sample tangent θ (the curve's local tangent, bisector of adjacent chords) → v (energy) → `F_n = κ·v²/g + cos θ`, the physical normal force a cart riding the curve feels. This per-sample θ is recovered from the geometry, distinct from the node headings that shape the curve. Deliberately *not* the algebraic inverse `invertRange` (that sawtooths — see "Hard gotchas"). A Hermite cubic's curvature varies within a span, so F_n is smoothly varying — the target shape for the optimizer, not a regression.

F_n smoothing beyond this is the optimizer's job (`roadmap.md` "kex2d"), so the bake stays geometry-only and simple.

Lossy bake (Houdini/Blender modifier-stack analogue): parametric authoring is one-shot, canonical state lives in the dense baked form, re-authoring overwrites whatever F_n was there. After the bake, F_n is canonical.

## Physics — forward integrator + force recovery

Per-sample state `(x, y, θ, v)`. Semi-implicit Euler in arclength, source-σ convention (F_n sampled at `σ_i = i·Δs` drives step i → i+1):

```
dθ       = (F_n(σ_i) − cos θ_i) · g · Δs / v_i²
θ_{i+1}  = θ_i + dθ
midθ     = ½(θ_i + θ_{i+1})
x_{i+1}  = x_i + Δs · cos(midθ)
y_{i+1}  = y_i + Δs · sin(midθ)
v_{i+1}² = v_i² − 2g · (y_{i+1} − y_i)
```

Velocity uses the energy-delta (squared) form to avoid catastrophic cancellation. Clamps: `vSafe = max(|v|, V_FLOOR)` in the dθ formula, `v_next = sqrt(max(v_next², 0))`. Both are non-differentiable — the optimizer's gradient sees kinks at the boundary, so the loss should keep the chain out of that regime.

**Force recovery** (`bake.ts forces`, the bake path): positions → per-sample tangent θ → v → F_n.

- `m_i = atan2(y_{i+1} − y_i, x_{i+1} − x_i)` — edge (chord) angle, accumulated *continuously* (unwrapped) so θ stays continuous across the ±π branch cut (the cart lerps θ for its orientation)
- `θ_i = ½(m_{i−1} + m_i)` — the curve's local tangent (bisector of adjacent chords); free ends extrapolate the bisector trend (exact for constant curvature, second-order otherwise)
- `v_i² = v_0² − 2g·(y_i − y_0)` — energy conservation; `v_i = sqrt(max(0, v_i²))` to match the forward clamp
- `F_n[i] = (θ_{i+1} − θ_i)·vSafe_i² / (g·Δs) + cos(θ_i)` = κ·v²/g + cos θ

The other recovery, `invertRange` (`θ_{i+1} = 2·m_i − θ_i`), is the integrator's exact reflection inverse — round-trip + optimizer only, not the bake (Hard gotchas).

Constants: `V_FLOOR` = 0.01 (numerical floor, ½v² ≈ 5e-5 J/kg) in `forward.ts` (the integrator owns the `vSafe` clamp; `bake.ts` re-exports it); `V_WARN` = 1.0 (diagnostic threshold for the red-track / red-handle / warning-banner UX, distinct from the floor) in `bake.ts`; `MAX_U_PER_EDGE` = π/24 (angular-cap floor on per-edge turning, keeps tight arcs sample-dense) in `spline.ts`; `MAX_SAMPLES` = 4096 in `track.ts`.

## Code map

- `forward.ts` — `step` + `integrate`. Four SoA Float32Arrays + `count`, `ds`, `fN(σ)`; index 0 pre-set, writes `1..count−1`. The forward model + the optimizer's future engine; not on the bake path.
- `spline.ts` — Hermite interpolation (pure, no shallot import). `sampleChain` (nodes with stored headings → positions + per-edge chord `dsArr` + node sample `offsets`; tangent length scaled by the live chord, edge count = arc-length spacing OR the angular-cap floor, whichever demands more). `reflect` (the circular-arc exit heading `2·chord − prev` — track.ts's authoring primitive), `MAX_U_PER_EDGE`. No neighbor-derived tangents, no `ALPHA` — headings are stored state, not inferred from positions.
- `bake.ts` — `forces` (the bake path: positions → smooth tangent θ → v → physical `F_n = κ·v²/g + cos θ`, per-edge ds). `invertRange`/`invert` (the integrator's *exact* reflection inverse, for round-trip + the optimizer, NOT the bake — see "Hard gotchas"), `replay` (forward-integrate F_n back to positions, test-only). `V_WARN` + re-exports `forward`'s `V_FLOOR`.
- `track.ts` — `BakeSystem` gathers node positions + headings from sorted handles, calls `sampleChain` then `forces`, syncs each node's `Handle.sample`. `Handle` carries `order`, `sample`, `pos` (the free authored position; the curve passes through it exactly, never written back), and `theta` (the exit heading — see Model). `bakeOut` carries per-edge `fN`+`ds`, per-sample cumulative `t`, `feasible: Uint8Array`, `firstInfeasible`, `lastBakedOrder` (orphaned nodes render red), `hash` (input-state gate = every node's pos + theta; a miss triggers a re-bake). `createTrack` (buffers) / `addNode(x, y)` (append) / `extend` (lay a node along the last heading by `EXTEND_DIST`) / `reheadOnDrag(eid)` + `headLast` (post-drag heading refresh) / `removeTrailingHandle` (undo the last node) / `sortedHandles` / `lastHandle`.
- `cart.ts` — looping cart animation. `cartState[trackEid].t` advances by real `dt`, wrapping at `loopTime(out)` — the time the cart reaches the first infeasible sample (it can't proceed past red, so it resets to the start there), or `tTotal` when the whole chain is feasible. `cartPose(trackEid, t)` interps samples for the box renderer; `sampleFNOverTime` resamples F_n onto a uniform-time grid (256 pts) for the strip.
- `editor.ts` — ephemeral UI state: just `selection`. No tools or modes. Plain singleton, read by Svelte via the per-RAF tick.
- `controls.ts` — `attachControls(canvas, ecs)` wires canvas pointer + window keyboard and returns a teardown; called from App's `onMount` so listeners live with the canvas (no module-flag staleness). `pickNode` (nearest within `PICK_R`); pointerdown picks + drags a node (or deselects on empty), drag sets `Handle.pos` to the cursor with a grab offset so grabbing off-center doesn't snap then calls `reheadOnDrag` to refresh the last node's heading (first node + interior stay frozen); `Enter` extends, `Del` removes the trailing node when the end is selected.
- `App.svelte` / `render.ts` / `view.ts` — Svelte shell + canvas2D render: grid, track polyline (feasible/infeasible passes), the node handles (selected highlighted, orphan/infeasible red), the cart, the F_n strip, and the radial extend/delete buttons (DOM, positioned around the selected chain end via `viewTransform` — extend along the heading, delete rotated off it).

## Editing model

No tools, no modes — just selection. Click a node to select + drag it freely to where you want it; click empty space to deselect. A drag reshapes exactly the two segments sharing the dragged node, no cascade either direction.

- **Free drag** (any node): pointerdown picks the nearest node within `PICK_R` and drags it; `Handle.pos` follows the cursor with a grab offset so grabbing off-center doesn't snap, then `reheadOnDrag` refreshes the heading per the Model.
- **Extend / Delete** (radial buttons around the selected chain end): Extend (＋, placed along the heading) lays a node continuing the last edge's direction by `EXTEND_DIST` + selects it (`extend`, also `Enter`); Delete (🗑, rotated off extend) removes the trailing node + selects the new end (`removeTrailingHandle`, also `Del`), re-heading the promoted tip so it doesn't jump when grabbed, never below the two nodes a chain needs.
- **No insert-on-curve, no interior insertion.** Append/drag/delete only — interior insertion is out of scope for the simple loop.

## Hard gotchas

- **Input is wired in `onMount`, not a system.** `attachControls(canvas, ecs)` binds the canvas/keyboard listeners and returns a teardown App calls on unmount. Don't move this back to a `System` with a module-level `attached` flag — that goes stale across a remount (a fresh canvas keeps the old flag and never re-binds, so input silently dies).
- **The bake uses `forces`, not `invertRange`.** `invertRange` is the *exact* reflection inverse of the forward integrator (`θ_{i+1} = 2·m_i − θ_i`). It carries a leapfrog "computational mode": a marginally-stable ±(−1)^i tangent oscillation. On positions the integrator itself produced it cancels to zero (round-trip exact, so flat/ballistic/single-step tests pass), but on a varying-curvature curve the mode is excited and **F_n sawtooths sample-to-sample** — a real reported bug. (The current per-segment near-arcs *reduce* the excitation — the reflection is exact at constant curvature — but don't eliminate it, so the guard stays.) `forces` recovers θ as the curve's local tangent (bisector of adjacent chords) instead, which has no such mode. Don't switch `BakeSystem` to `invertRange` (the `track.test.ts` smoothness test guards this).
- **`forces` accumulates a *continuous* chord angle.** It unwraps the per-edge chord angle before taking the tangent bisector, so θ stays continuous across the ±π atan2 branch cut. The cart lerps θ for its orientation, so a raw-`atan2` θ would spin the cart a full turn between two samples when the heading crosses ±π (e.g. a leftward turn). A `bake.test.ts` test guards this.
- **Node headings (`Handle.theta`) are stored authored state — keep them out of the bake.** The bake's per-sample θ is a separate quantity, recovered from the sampled geometry (chord bisector). Don't (a) make the bake read `Handle.theta`; (b) reintroduce a `Track.theta0` entry angle — node 0's flat anchor *is* the entry; (c) switch `sampleChain` back to inferring tangents from neighbor positions each bake (Catmull-Rom) — that's the bidirectional cascade the stored-heading model kills, and it breaks two-segment locality. (See Model for how headings are maintained.)
- **`sampleChain` per-edge ds is the exact chord.** `dsArr[i] = |P_{i+1} − P_i|`. A near-coincident segment or `MAX_SAMPLES` truncation commits the prefix + orphans trailing nodes.
- **Forward clamps are non-differentiable.** A future optimizer's gradient is zero through `vSafe` / `sqrt` once tripped. The floor is tiny, so coasting past an infeasible region behaves like "cart paused at peak then continued" — negligible energy perturbation.
- **Quaternion DOF (when 3D lands).** Unit-norm constraint. Use the log-map (axis-angle delta) as the local update variable, matching `sim/curvature.rs::angular_delta_from`. Per-piece scope is unchanged in 3D.

## References

- **kexedit forward integrator** — `packages/core/src/sim/`. The 3D physics reference. `forward.ts` is the 2D forward direction (F_n → positions); `invertRange` is the reverse of the same equations. Core's node model: `nodes/force.rs` is F_n-driven, `nodes/geometric.rs` rate-driven, `sim/curvature.rs::from_frames` is quaternion-log curvature for the 3D port.
- **Houdini / Blender modifier stack** — analogue for lossy bake from parametric authoring into canonical dense state.
- **Witkin & Kass 1988, Spacetime Constraints** — parameter-space trajectory optimization with sparse user constraints; local support makes the optimizer's constraint influence decay rather than propagate globally.

## Verify

```bash
cd kex2d && bun check && bun test
```

f64 mirror for tests: `tests/helpers/forward64.ts`. Independent physics check: `tests/oracles/rk4.ts` (time-parameterized RK4 — a different scheme + parameterization, catches sign/coupling bugs self-consistency tests can't). Physics is gated against the oracle, not self-consistency.

The ECS layer (`BakeSystem`, cart resampling) is covered device-free in `tests/track.test.ts` + `tests/cart.test.ts` (`BakeSystem` on a bare `State` via the scheduler). The `tests/setup.ts` enum-shim preload (`bunfig.toml`) lets them import the shallot barrel with no GPU device — see that file for why; kex2d is canvas2D, so there's no real-GPU leg.
