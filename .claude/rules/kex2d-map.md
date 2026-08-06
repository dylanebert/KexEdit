---
paths:
    - "kex2d/src/**/*"
    - "kex2d/tests/**/*"
---

# kex2d Code Map

Model internals + per-file map for `kex2d/`: the section substrate, the physics, what each module
owns, its per-module hazards, the test tiers + labs, and the external references. The behavioral
contract (authoring models, authoring API, editing model) is `kex2d/AGENTS.md` — read it first.

## The section substrate

`section.ts` — the proven original-KexEdit contract (`packages/core`), in 2D. Every section takes
an **entry** anchor (a full state point `{x, y, θ, v}`) and produces sampled points; its last
point IS the next section's entry. Two atomic idioms wrap the oracle-gated physics:

- **`evalGeo(entry, localNodes, dsNominal)`** — geometry → force. The local nodes (node 0 at the
  local origin, heading 0) are placed **rigidly** at the entry frame (rotate by entry θ, translate
  to entry position), sampled to a Hermite curve (`sampleChain`), then the physical force is
  recovered from the geometry (`forces`, `v0 = entry.v`).
- **`evalForce(entry, fN, step, domain)`** — force → geometry. Takes `profile.ts`'s resolved
  `Step` (`{edges, ds}`) as one value — never a bare `ds` — and throws if `fN.length !== step.edges`
  (the pair-as-one-value law, `kex2d-correctness-fixes` stage 1). Seed sample 0 from the entry,
  `integrate` the authored per-edge F_n into the swept geometry, then **re-recover** the display
  force from that geometry.
- **`chain(entry0, sections)`** — thread the sections: each is placed at the prior section's exit,
  its samples appended to one flat SoA, sharing the boundary point (a section's last sample IS the
  next's first). Returns the flat buffers + per-section index `ranges` + `exits`.

Two design laws carried from the original core (both pinned in `tests/section.test.ts`):

- **The force curve is ALWAYS geometry-recovered, even for a force section**. A force section
  integrates the authored F_n, then re-recovers the display force from the swept geometry — so
  there is ONE display path regardless of section kind (mirrors `nodes/force.rs`: integrate from
  targets, store the `Curvature::from_frames`-recovered force). The recovered force sits O(ds) off
  the authored input — the source-vs-centered convention gap (`fvd.lab.ts` panel 3), a derived
  gap, not a bug. `evalForce`'s exit uses the recovered state too, so it matches a geo section's
  recovery exactly.
- **Rigid entry-frame placement**. Geo nodes live in section-local coordinates and the
  substrate places them rigidly at the entry. When an upstream edit moves the anchor, the
  downstream shape translates+rotates rigidly — C1 join guaranteed, shaping preserved. The geometry
  is affine-equivariant (exact to f32); physics (fN) is NOT frame-invariant (gravity picks a world
  frame), so the rigid-invariance test pins positions only.

The section entry is a full world state; a geo section's nodes are **section-local** (node 0 at the
local origin, heading 0). `localize` (the exact inverse of `place`) expresses a world point in the
entry frame — the ECS layer authors handles in world space, so the bake localizes them against the
entry before evaluating. `place(entry, localize(entry, p)) === p`.

f32 throughout — these atoms ARE the realized-track display path, so they use the display recovery
(`bake.forces`), not the f64 solver atoms (`force.ts`).

**Wiring status (stage D):** `track.BakeSystem` walks `sections()` (sorted by `Section.order`),
builds a per-section payload (geo: its section-local nodes; force: `profile.forceProfile` over its
points + extent), and threads them through ONE `chain(START, payloads)` call. It writes the flat
`samples`/`bakeOut` SoA + a per-section `sectionInfo` map (entry, sample range, arclength, orphan
cutoff) the drag/render/convert read. **Geo nodes are stored section-local** (the rigid entry-frame law): `Handle.pos` is
the local coord, node 0 pinned at `{0,0,0}` = the section entry; the bake `place()`s them, so an
upstream edit rigidly carries downstream (the substrate does it — no imperative rebase). Render/pick
read the baked world sample (`samples[Handle.sample]`); only the drag converts world→local
(`localize` against the section entry, identity for the first section). The cart/render/timeline are
kind- and count-agnostic (they read the flat SoA).

## Physics — forward integrator + force recovery

Per-sample state `(x, y, θ, v)`. Semi-implicit Euler in arclength, source-σ convention (F_n sampled
at `σ_i = i·Δs` drives step i → i+1):

```
dθ       = (F_n(σ_i) − cos θ_i) · g · Δs / v_i²
θ_{i+1}  = θ_i + dθ
midθ     = ½(θ_i + θ_{i+1})
x_{i+1}  = x_i + Δs · cos(midθ)
y_{i+1}  = y_i + Δs · sin(midθ)
v_{i+1}² = v_i² − 2g · (y_{i+1} − y_i)
```

Velocity uses the energy-delta (squared) form to avoid catastrophic cancellation. Clamps:
`vSafe = max(|v|, V_FLOOR)` in the dθ formula, `v_next = sqrt(max(v_next², 0))`.

**Force recovery** (`bake.ts forces`, the bake path): positions → per-sample tangent θ → v → F_n.

- `m_i = atan2(y_{i+1} − y_i, x_{i+1} − x_i)` — edge (chord) angle, accumulated *continuously*
  (unwrapped) so θ stays continuous across the ±π branch cut (the cart lerps θ for its orientation)
- `θ_i = ½(m_{i−1} + m_i)` — the curve's local tangent; free ends extrapolate the bisector trend
- `v_i² = v_0² − 2g·(y_i − y_0)` — energy conservation; `v_i = sqrt(max(0, v_i²))`
- `F_n[i] = (θ_{i+1} − θ_i)·vSafe_i² / (g·Δs) + cos(θ_i)` = κ·v²/g + cos θ
- **a degenerate (Δs == 0) edge is the stationary cart**: it has no chord, so it carries `m_{i−1}`
  across (a frozen cart's orientation doesn't change) and its `F_n` is `cos(θ_i)` — no arc is
  traversed, so there is no centripetal term to divide by a zero chord. A chain with no chord at
  all recovers the caller's entry heading (`theta0`). Only a Time-domain march reaches this
  (`ds_i = v_i·Δt` is exactly 0 at a stall), and the branch keeps the Distance path bit-identical

`invertRange` (`θ_{i+1} = 2·m_i − θ_i`) is the integrator's exact reflection inverse — round-trip
validation only, NOT the bake (Hard gotchas, below).

**The clamp-gradient law** (pin-mode stage-3 conditioning lab): the forward clamps
(`vSafe`, `sqrt`) make the exit map non-differentiable at a stall, and the cliff is
**derivative-inaccessible** — no draft-property read (a vMin march scan, a closed-form
`G·L/V_WARN²` bound) can certify it; both were tried and removed as unsound. The one honest
stall certificate is the **θ-row one-sided sign opposition** read off the invoke's own FD pass
(a smooth map's one-sided slopes stay same-signed; the clamp cliff flips them), measured to
separate every floor-touching corpus draft from every smooth one, threshold-free.

**The conservative-energy law**: speed is a strict function of height. The integrator advances
`v²_{i+1} = v²_i − 2g·Δy` and the recovery reads `v²_i = v²_0 − 2g·(y_i − y_0)`, so `F_n` reaches
`v` only through `dθ` → `y`. Normal force does no work, and that is a property of the physics
rather than of any solver: **an optimizer whose DOF are force ordinates cannot move exit `v`
except by moving exit `y`.** Pin mode's three-row exit stamp is therefore already a full
four-state pin (measured 2026-08-01: landed `exit.v` matches the energy-derived value to
1e-5 m/s across flat / gentle-hill / airtime-dip / steep-climb drafts, and a length change
doesn't touch it — stamped at L = 60 and re-solved at 65 / 75 it holds, while short lengths
refuse on geometric reach instead). A fourth residual row on `v` is refused for cause: linearly
dependent with the `y` row, it would make a well-posed problem read as rank-deficient under the
`"conditioning"` certificate.

The identity survives *authored* energy input. A launch or brake at a fixed station adds a known
term, and `v_exit` stays a function of `y_exit` plus constants no DOF reaches. What breaks it is
**path-dependent dissipation** — friction, drag, or a control acting over a time window — where
the loss integrates `F_n` along the path and the DOF finally couples to the energy. Until that
exists, a speed row is chrome for a state that doesn't exist.

**The one breach today is the velocity clamp.** `step` and `forces` both take
`v = sqrt(max(v², 0))`, so a march that runs out of energy has energy *injected* at the clamp and
`v_exit` stops following `y_exit` (measured 1.4–5.1 m/s above the derived value). Invoke-time
certificates do not cover the landed state: a draft that passes the stall certificate can still
wander into a stalled iterate mid-solve (measured at L = 90, `vmin` 0, `vErr` 0.45 m/s, refused
as `"diverged"`). The landed state is covered by an **acceptance gate, not a fourth residual row**:
`finalize` (`optimize.ts`) compares `|v_land² − v_stamp²|` — reported as `OptimizeResult.vSqResidual`
— against `exitTol(tol)` and downgrades `"solved"` → `"diverged"`. The bound is exact, not a
linearization: `v² = v₀² − 2g(y−y₀)` and `|Δy| ≤ tol` give `exitTol = 2·G·tol` algebraically, so
`V_FLOOR` never enters it. Read the tolerance through `exitTol`; a caller comparing `vSqResidual`
against `tol` is comparing a squared gap to a linear one. The gate is a **belt, and its evidence is
empirical**: a 110-draft stall-neighborhood sweep found 0 breaches (closest solved `gap/exitTol`
0.795), so the corpus cannot currently produce a user-visible one. That is a measurement, not a
proof — there is no bound on the injection. `vSafe` floors only the `dθ` denominator; the energy
update clamps `sqrt(max(v², 0))` with no floor at all, so the injection is `−min(v²,0)/2` per
clamped sample and unbounded above.

**The ds-convention law**: anything needing arclength sums the bake's own per-edge `out.ds`,
never re-derives from chord distance. The two agree to f32 rounding on a normal chain, but the
pin mode's downstream freeze publishes a **zero-length gap edge over a real position jump**
(the residual made visible), so a chord walk diverges from the chart axis by the whole gap.
`forceCurve`, `sectionSpans`, and `cart.trackMapping` all speak `out.ds`; so must any new
consumer (and `tests/domain.test.ts`'s independent-table oracle).

Constants: `G` = 9.80665 and `V_FLOOR` = 0.01 in `forward.ts` (the integrator owns both; `bake.ts`
and `optimize.ts` import `G` rather than redeclaring it); `V_WARN` = 1.0 (diagnostic infeasibility
threshold) in `bake.ts`; `MAX_U_PER_EDGE` = π/24 in `spline.ts`; `MAX_SAMPLES` = 4096 in `track.ts`; `V0` = 10
(the DEFAULT initial speed — now authored per-track as `Track.v0`) in `track.ts`.

## Code map

**Substrate + physics atoms (pure, framework-free, `bun test`-able):**

- `section.ts` — the section substrate (above): `Entry`, `SectionResult`, `Section`, `place` /
  `localize` (the rigid-transform pair), `evalGeo`, `evalForce`, `chain`. f32; consumes
  `sampleChain`/`forces`/`integrate`. `SectionResult.offsets` is the section-local node→sample map
  (geo: node landings; force: the two boundary anchors); `chain` returns per-section `results` too,
  so a caller reads each section's `offsets`/`valid`/`truncated` off the flat SoA. Tested device-free
  in `tests/section.test.ts` (localize↔place inverse, RK4 carry, O(ds) round-trip convergence, rigid
  invariance, chain C0/C1 continuity + energy).
- `forward.ts` — `step` + `integrate`, the forward integrator (F_n → positions). Index 0 pre-set,
  writes `1..count−1`. Drives round-trip validation; not on the geo bake path (that goes the other
  direction, geometry → force). `evalForce` wraps `integrate`.
- `spline.ts` — Hermite interpolation (no shallot import). `sampleChain` (nodes with stored headings
  → positions + per-edge chord `dsArr` + node `offsets`), split into `chainCounts` (adaptive
  per-segment edge-count rule) + `sampleAt` (sample at *given* counts — freezes the sampling
  topology). `reflect` (circular-arc exit heading `2·chord − prev`), `MAX_U_PER_EDGE`. `handle()` is
  the one seam where a node's tangent enters the curve — `Auto` (the arc rule) or `Node.tangent`
  (`TangentMode.Mirror`/`Aligned`/`Free`, an explicit `Tangent`'s stored `in`/`out` vectors) — so
  `Auto` stays byte-identical while an explicit node substitutes its own vector there.
  `autoTangent` exposes the arc-rule vector for the explicit-summon seed; `handleTip`/`editTangent`
  are the handle-drag geometry's forward/inverse (`tangents.ts`'s seam); `alignTangent`/
  `mirrorTangent` re-collinearize a tangent on a mode switch.
- `bake.ts` — `forces` (the bake path: positions → smooth tangent θ → v → physical `F_n`,
  per-edge ds). `invertRange`/`invert` (the exact reflection inverse, round-trip validation only —
  see Hard gotchas, below), `replay` (forward-integrate F_n back to positions). `V_WARN` + re-exports
  `forward`'s `V_FLOOR`.
- `profile.ts` — the FORCE authoring primitive (the force analogue of `spline.ts`): per-segment
  cubic-bezier eval at the handle-resolution seam (`segment`: easing-tag-derived flat tangents via
  the influence table ?? explicit stored; `autoTangent`/`segmentSeed`/`segmentControls` shared
  with the UI), Blender-style x-monotonicity clamp, `sampleForce` (held endpoints, `DEFAULT_G`
  empty) + `forceProfile` (dense per-edge F_n(σ), σ = i·ds, warm-started t-march). **The
  authored `length` is truth and the bake conforms to it**: `resolveStep(length, step)` is the
  ONE seam that pairs a force section's realized edge count with its per-edge step:
  `edges = max(1, round(length/step))`, `ds = length/edges`. So `edges·ds === length` to f32
  accumulation instead of leaving a rounding-residual gap between the authored extent and the
  realized one — within the sample budget: a
  `MAX_SAMPLES`-clipped chain, and `forceBake` (`track.ts:2532`, which clips deliberately),
  truncate the march short of `edges`, so the identity is conditional on nothing having clipped.
  The conformed `ds` is a fixed point of this same rounding, so re-resolving an already-conforming
  step (a converted section's stored `Section.ds`) preserves the same `edges` — what survives
  re-resolution is the EDGE COUNT, not the `ds` value bit-for-bit: the returned `ds` is re-derived
  in f64 and may differ from a stored f32 step by up to one f32 ulp, a strict improvement over the
  stored value rather than a no-op.

  **Pairing is a source-of-truth law, enforced structurally, not by convention.** `resolveStep`
  returns a `Step` interface (`{edges, ds}`) — one value, not two — and `forceProfile(points,
  step)` / `evalForce(entry, fN, step, domain)` take it as their ONE argument, never a bare `ds`
  positional. There is no signature left to hand a caller's own, unconformed `ds` into: splitting
  the pair (destructuring `edges` alone and marching on some OTHER `ds`, the way `optimize.ts`
  shipped it latently for a whole stage, `kex2d-section-extent`) is a type error at the call site,
  not a runtime latent bug a lexical scan has to catch after the fact — demonstrated by handing
  `forceProfile`/`evalForce` a destructured `ds: number` directly: `tsc` refuses with "Argument of
  type 'number' is not assignable to parameter of type 'Step'." `evalForce` additionally throws at
  runtime when `fN.length !== step.edges`, closing the half the type alone can't: a caller handing
  a matched `Step` alongside a STALE dense array (built against a different, earlier step).
  `section.ts` reaches `Step` by a type-only import, so the substrate's runtime module graph gains
  no edge to `profile.ts`.

  Every production pairing of a force section's edge count with its step goes through
  `resolveStep` — seven sites in four modules: `track.ts` `forcePayload` + `forceBake`, `pin.ts`
  `sectionSpec`, `optimize.ts` `computeExit` + `derivedTol` + the Gram matrix build, `polish.ts`
  `spine`. `track.ts`'s `forceDense`, `pin.ts`'s `enterPin`, and `polish.ts`'s `violence` are
  CONSUMERS of an already-conformed `Step`, not pairing sites of their own — each takes `Step` as
  a typed parameter, conformed once upstream by its own caller. Before the signature change these
  three needed a declared, name-keyed exemption in `tests/profile.test.ts` (`CrossFunctionConsumers`)
  because a lexical, per-call-site scanner couldn't trace `ds` across a function boundary; the
  signature now makes that boundary-crossing unrepresentable — `forceProfile`/`evalForce` take the
  pair as one argument, so there is no call site left where `edges` and `ds` could have arrived
  from two different resolutions — so the exemption table — and the whole per-call-site
  scanning apparatus it existed for (`unboundUses`, block-scope binding visibility, three
  conforming-form regexes) — is retired, not merely deleted. **What the type does NOT enforce:**
  internal `edges`↔`ds` consistency within one `Step` value. TypeScript is structural, so a
  hand-built `{edges, ds}` literal typechecks anywhere a `Step` is expected regardless of whether
  `ds` actually equals `length/edges` — `evalForce`'s only runtime check is `fN.length ===
  step.edges`, which says nothing about `ds`. That gap is real, not closable by branding `Step`
  nominal: `track.forceBake`'s `clippedStep` (`{edges: clipped.length, ds: resolved.ds}`) is a
  legitimate constructor outside `resolveStep` — carrying the same per-edge `ds` over a truncated
  edge count is correct, not a violation — and a nominal escape hatch for that one site would
  reopen the hole everywhere else while claiming to have closed it. What remains in
  `tests/profile.test.ts` is a file-level census (a recursive source-tree walk asserting, both
  directions with a positive control per direction, that no module outside `profile.ts`
  hand-rolls the rounded-quotient edge-count shape, and that every caller of
  `forceProfile`/`evalForce` is one of `track.ts`/`pin.ts`/`optimize.ts`/`polish.ts` — which call
  `resolveStep` themselves — or a declared exemption consuming an already-conformed `Step`:
  `playback.ts`/`fitlab.ts` (off a landed solve's answer), `fit.ts` (a JSDoc `@example` only), and
  `section.ts` (`chain()`'s `evalForce` call consumes `sec.step`, traced through
  `forcePayload`/`forceBake` to `resolveStep` upstream — a conformed `Step`, not a second
  independent pairing).
  Opinion-free: the substrate consumes dense F_n, this builds it from authored points.
  Unit-tested in `tests/profile.test.ts`.

**Invoked conversion/optimization atoms (NOT on the live editor path):**

- `force.ts` — the geometry-primal force atoms, f64. `forces64` (parametrization-invariant
  geometry→force: Menger κ + neighbor-chord tangent + raw unclamped v²) + `forceJacobian` (analytic
  banded ∂F/∂P). Invariance is load-bearing (a fixed-ds difference scheme was measurably gamed).
  Distinct from `bake.ts forces` (f32, the display bake): same chord family, different consumers.
- `banded.ts` — general symmetric-banded LDLᵀ, cross-validated ≤1e-10 against the dense Cholesky
  reference (`tests/helpers/dense.ts`).
- `collocate.ts` — the dense-spine solver kernel (LM Gauss-Newton, PHR augmented-Lagrangian band).
  Kept as reference for general optimization tools; the live path does not call it.
- `fit.ts` — dense recovered force → sparse independent-handle warm start. `fit` supplies the
  full-free oracle; `fitKnots` also supplies fixed-s g values to a flat probe, whose handles are
  stripped before solving. Its cumulative variable-chord frame is `arclength(bake.ds)`.
- `polish.ts` — fixed-knot geometry collocation in two unregularized families. `free` keeps every
  independent handle as the bit-identical numeric-floor oracle. `flat` carries exactly one g DOF
  per key and materializes only `{s,g}`, so every segment is default named Cubic by construction.
  It owns the solve and structural `chordDeficit` reading, not conversion policy.
- `refine.ts` — the **discrete outer refinement** around `polish`: choose WHERE the keys go
  by solving, reading the residual, and moving the knots there, instead of inheriting the
  warm-start fit's (which places knots against the dense force — the wrong target, since
  force error integrates twice). Every warm start is flattened. The loop opens at the two
  endpoints, splits at residual-equidistribution sites until the floor holds, then exhaustively
  probes every interior single-key removal and greedily commits the holding candidate with the
  most slack (lowest key index on a tie). No other structural state exists. Split-while-violated
  against prune-only-while-held is the hysteresis; the loop is deterministic and parameter-free.
  Its shipping geometry constraint is `chordDeficit(spine) + 0.5·CONVERT_STEP` — the conversion
  core's OWN 1 m quantum, deliberately not `settings.ts`'s identically-defaulted manipulator grid:
  what a document converts to is a frozen contract, so moving a live per-user preference must
  never move it, and `localStorage` stays out of the worker bundle's graph (`refine.test.ts` pins
  the constant AND walks the module graph, with `magnet.ts` as its positive control). No shape
  price or continuous authorability mode participates.
  A probe is guarded on a **readable** residual profile, not on convergence — an unconverged
  opening is a waypoint, while any NaN/Inf candidate terminates immediately as `"diverged"` and
  its actual failed knots/profile are logged. `"budget"` instead means no admissible split site
  remains, the sanctioned narrow-feature outcome. Each `RefineEvent` carries the flat probe
  profile of the state it reports, so playback never re-solves a decision.
  **A converted section must carry the solve's own `ds`** (`length/edges`, what `spine` chose so
  the section spans the bake exactly) — a force section stores its own step. Marching
  loop-explicit's same profile at nominal 0.5 m misses the pinned exit by 0.247 m, while the
  realized step closes within 3.1e-5 m (`refine.test.ts`). The locked corpus is 80 keys, and its
  structural output — knots, outcome, probes, keys, edges — is frozen in
  `tests/fixtures/convert-golden.json` and hard-fails on any mismatch, ahead of any value
  comparison; every continuous field — `floor`, `deviation`, `points[].g` alongside `length`,
  `ds`, and `points[].s` — is **exact**, because the fixture is stamp-matched: **a bucket is a
  claim about a comparison, not about a field**, and own-stamp against a deterministic solve
  presents zero spread, so the derived bound is zero. A bound belongs where a fixture is genuinely
  shared, which here is `forcegeo-golden.json` alone (below) at 1 ulp, the unit's only one. Every
  golden here is **field-wise**, because a golden pinned as a single hash cannot be loosened
  without a structural rewrite; a *per-field* digest is the loosenable form of the same primitive,
  and pinning one already-exact field that way (`polish-golden.json`'s 7 MiB `snapshots`) blocks
  nothing else from moving. That golden is the gate on any change that claims
  to leave conversion output alone (a perf change above all). What the human check approved was
  the `linux x64` output as an authoring surface; a stamped golden minted on another machine is a
  regression tripwire, not an inherited authoring verdict, and leaning on one as a verdict means
  taking that verdict fresh. **Bit-identity itself is a same-machine, stamp-matched property, not
  a cross-machine one**: ECMAScript leaves `sin`/`cos`/`atan2`/`hypot` implementation-defined and
  Apple's libm and glibc differ by up to 1 ulp on bit-identical arguments,
  and the refine solve holds two different fixed points on different platforms, so the fixture
  carries a platform stamp and the gate runs against the golden for the machine running it,
  hard-failing and naming the mint command (`bun run tests/mint-goldens.ts`) when none matches —
  never silently skipping. `tests/fixtures/forcegeo-golden.json` (the geofit path, below) needs
  none of this: it reproduces structurally exact across platforms and stays single-golden. Same
  libm dependency, two different outcomes — refine's iteration count itself diverges across
  machines (measured 583,358 vs 727,614 calls on the two committed reference platforms), while
  geofit's f32 stores quantize the drift away before it surfaces: every state variable
  round-trips through a `Float32Array` store once per sample, so a cross-machine difference
  introduced mid-step either quantizes away there or it doesn't, and either way the next sample
  starts bit-identical.
  **`ConvertResult` (+ `narrow`) is the boundary payload** — points, realized `ds`, length, edges,
  keys, knots, outcome, floor, deviation, probes, exactly the golden's shape: plain numbers and
  `{s,g}`, so it structured-clones, and ~50× smaller than a `RefineResult` (0.36 KB vs 22 KB on
  double-hump, which carries the spine, the per-sample deviation profile, and the playback
  events). `playback: false` builds none of that freight — `refine` skips its events and passes
  `maxSnapshots: 0` to `polish`. Recording is pure observation, so the answer is bit-identical
  either way (pinned at both layers); it buys the boundary and the garbage, not wall time
  (measured 0.3% over five scenarios, inside run-to-run noise).
  The loop itself is a **coroutine over probes** (`plan`): it yields the solve it needs and
  resumes on the answer, so ONE loop drives both the in-process `refine` and the pool, and the
  probe body (`warm` + `solve`) has one home. Each `Ask` carries the rest of its prune round
  (`ahead`) — the probes the loop is certain to want next, in this order — as a prefetch hint a
  pool fans out.
- `convert.ts` — the **async façade**: `convert(bake, entry, ds, {signal, onProgress, workers})`
  → `Promise<ConvertResult>`, the shape an invoked editor command calls. `plan`'s orchestration
  (residual analysis, split placement, prune selection — sub-ms) stays on the caller's thread;
  only `polish` probes cross into a lazily-grown worker pool (`hardwareConcurrency − 1`, floor 1,
  never more than the live fan-out — the serial split phase uses exactly one). **Determinism
  under concurrency is by construction**: answers are consumed strictly in ask order, so pool
  size and completion order are unobservable — never a sort or a tie-break after the fact
  (`convert.test.ts` pins size 1 ≡ size 8 ≡ the golden, proven red by consuming in completion
  order). Cancellation is pool termination, not "stop asking" — an in-flight probe is up to a
  second, and the façade writes nothing, so an abort needs no rollback (measured settle ≪ one
  probe). Progress reports `{phase, keys, probes}` with no total: the refinement discovers how
  many probes it needs. `convertPlayback` is the same drive with the lab's freight kept.
- `convert-worker.ts` — the pool's worker: `refine.solve` per message and nothing else. The bake
  crosses once at `init`, then each message is a knot set; no refinement state, no policy, no
  decisions live here.
- `optimize.ts` — pin mode's **masked exit-restore kernel**, f64: a small constrained
  Gauss-Newton (dense KKT, damped backtrack with SOC retry + restoration fallback, adaptive
  re-anchored continuation for large drift) whose only DOF are the FREE keys' g-ordinates — s,
  length, structure, easing, and locked keys are invariant by construction. Objective = exact
  Gram-matrix L2 force-curve deviation from the current draft (the dense response is globally
  affine in g under frozen s). Residual/Jacobian evaluations run the production integrator
  (`section.evalForce`); exit Jacobian is central FD at `JAC_H = 2^-8` (derived — 1e-4 sat below
  the f32 integrator's noise floor and stalled every real solve). Refusals: `"unreachable"` only
  from three Jacobian-read certificates at invoke (free-count < `MIN_FREE` = 3;
  σmin/σmax below the FD's own relative accuracy; the θ-row sign-opposition stall certificate —
  the clamp-gradient law above), everything else `"did not converge"`; convergence floor is
  relative (`3·ε_f32·√N·scale`, the f32 replay floor), never absolute. `computeExit` is the
  stamp's own computation. Invariant floor + refusal taxonomy + trip-proven golden in
  `tests/optimize.test.ts` / `tests/optimize.oracle.ts`.
- `optimize-async.ts` + `optimize-worker.ts` — the one-shot worker façade, `geofit-async.ts`'s
  twin: `runOptimize(opts, {signal})` spawns a dedicated worker, posts once, resolves once;
  cancellation is `Worker.terminate()`, the façade writes nothing, `liveOptimizeWorkers()` makes
  teardown observable.
- `census.ts` — the **vocabulary census**: which tangent-mode shape (`mirror`/`aligned`/`broken`/
  `single`) a force keyframe's two handles form. The editor's handle vocabulary is discrete, so
  authorability is a COUNT over it, not a score — and the judgment is screen-space (the `(s, g)`
  axes carry different units, so a data-space angle would be a made-up number), which makes the
  surface's `Scale` part of it. The CLASSIFIER is shared by the fit lab's overlay and the
  conversion tier's oracle asserts; the `Scale` is each caller's own, so a census is a reading of
  a surface and two are comparable only at the same scale. The scale-free question (are a key's
  two handles one line) is `profile.collinear` — the `Offset`-shaped wrapper over the one shared
  numeric core, `spline.collinearVec` (direction-agnostic; the sign clause belongs to each domain's
  own caller, `kex2d-followups` Locked decision). `census.classify` deliberately stays OUT of that
  fold: it answers a different, screen-space question against an absolute `ALIGN_PX`, so a
  collinear profile still censuses `broken` wherever its handles draw under that pixel threshold.
  Unit-tested in `census.test.ts`.
- `playback.ts` — the fit lab's **playback timeline**: the pipeline's decisions turned into
  frames a scrubber walks (`fitlab.ts` draws them; this decides what they are). Not a kernel
  atom — it solves nothing — but it lives with them because what it asserts is a
  correspondence with what the kernel decided: shipping playback is dense recovery followed by
  exactly one frame and one rendered chip per flat init/split/prune/terminal event, with the final
  event marked as the answer. The `baseline` timeline stays beside it for the full-free
  recover→fit→polish oracle. Force plotting preserves the bake's cumulative variable-chord
  abscissa while solver/frame arrays use their uniform realized step. Unit-tested in
  `playback.test.ts`; the DOM chip order is captured in the fit-lab harness flow.

**ECS + UI layer (the live app):**

- `track.ts` — `BakeSystem` walks `sections()` (by `Section.order`) → per-section payload → one
  `chain(startEntry(v0), payloads)` → the `samples`/`bakeOut` SoA + the `sectionInfo` map; skips on a
  `bakeHash` match (over every section, ds + v0 + the track domain). Components: `Track` (`count`, `ds`,
  `v0`, `domain`), `Section` (`id` stable,
  `order`, `kind` `SectionKind.Geo`/`Force`, `length` = force extent, `ds` = its own baking step), `Handle` (`section`, per-section
  `order`, `sample`, section-local `pos`/`theta`), `Force` (`section`, `id` stable, `s` local, `g`).
  `bakeOut`: per-edge `fN`+`ds`, per-sample `t`/`feasible`, `firstInfeasible`, `hash`. `sectionInfo`
  (by id): `entry`, `startSample`/`endSample`, `bakedNodes` (orphan cutoff). Section helpers:
  `sections`/`sectionAt`/`createSection`, plus the session's per-kind **sticky append length**
  (`stickyLen`/`setStickyLen`: a force section's extent, a geo section's `extend` chord — module
  state, updated only from `history.commitLength`/`commitChord`, never by a solve or a convert). Coordinate lens (section-local `s` ↔ the track-global axes):
  `sectionSpans` (the one span table — each section's arclength `offset`/`len` plus its native
  `entryU`/`lenU`, the latter read off the baked `t` table in the `Time` domain) + `toGlobal`/`toLocal`
  on arclength and `toGlobalU`/`toLocalU` on the domain's own axis — the single seam every global
  readout derives from. The force store is addressed on the native axis (`Force.s` and
  `Section.length` are in `Track.domain`'s unit, converted only at `domain.convertDomain` and at a
  solve's landing, `domain.convertSolve`); geometry stays on arclength. Geo: `addNode`/`extend`/`reheadOnDrag`/`removeTrailingHandle`/
  `sectionHandles`/`lastHandle`/`handleAt`/`spawnNode`/`nodeSnapshot`/`restoreNodes`/`sameNodes` +
  `geoNodes` (the ONE projection of a section's ECS columns onto `spline.Node`s — the bake payload
  and an invoked solve's input both read it, so a conversion solves what's displayed).
  Tangent: `handleTangent`/`setTangent` (read/write the explicit `Tangent`, `undefined` = `Auto`),
  `seedTangent` (the arc-rule vector at a node, for the explicit-summon seed), `resetNode`
  (re-create: continuation at the default chord via the shared `creationTheta`/`continuation`
  bodies, tangent cleared; order 0 delegates to `resetTangent`, the tangent-clear half). No
  append-time stamping —
  the default flow stores no tangents (`exitHeading` still resolves the append/reflect seed against
  an explicit tip's out-vector). Force:
  `sectionForces`/`forceAt`/`createForcePoint`/`spawnForce`/`destroyForce`/`forcePointState`/
  `setForcePoint`; extent `sectionLengthState`/`setSectionLength`. Where a keyframe lands on the
  baked track: `forceSample` (a stored native-axis `s` → flat sample index + fraction, walked over
  the bake's own tables within the section's published range — per-edge `out.ds` on Distance, the
  per-sample march clock `out.t` on Time; the ds-convention law's newest consumer, so a zero-length
  edge is stepped over rather than divided by) and `forceMarkers` (those addresses lerped to world
  points — the viewport marker substrate, `kindSegments`'s force-point sibling, read by
  `render.ForceDrawSystem` and the controls' pick; a key past its section's extent is skipped, since
  a trimmed-past key has no track position at all — the non-destructive trim law). Kind + structure:
  `convertSection` + `resetSection` (the same reset with the kind HELD — both run the shared
  `resetToForce`/`resetToGeo` bodies, so flip and Reset can't drift apart) with `sectionResettable`
  its enablement predicate (exactly one section; force additionally wants a live bake, since its
  seed's entry force is bake-recovered — a geo reset reads no bake), `applyConvert` (land an
  invoked solve: destroy the nodes, flip the kind, take the answer's extent + step, spawn its
  `{s,g}` keys — all default-Cubic by construction; typed on the structural `SolvedForce`, so the
  invoked tier stays off this module's graph. Its numbers arrive in the TRACK DOMAIN's unit, so a
  distance-internal solve is converted first, above this module, at `domain.convertSolve`) and its reverse `applyConvertGeo` (land an
  invoked force→geo fit: destroy both row kinds, flip the kind, `localize` the fit's world nodes
  into the section's own entry frame with node 0 pinned at `{0,0,0}` exactly, step back to the
  nominal sentinel; typed on `SolvedGeo`), `forceBake` (a force section's dense bake as `geofit`
  reads it — `evalForce` at the section's own step, clipped to the sample budget `chain` leaves it,
  so the fit's input is the displayed prefix),
  `appendSection`/`splitGeo`/`splitForce`/`joinNext`/`deleteSection`, `snapshotSection`/`restoreSection`
  + whole-track `snapshotAll`/`restoreAll`. **Cut's position resolvers** sit one layer above the
  splits: `splitGeoAt` (de Casteljau-subdivide segment `j` at bezier `t`, so the authored curve
  survives exactly — the stated cost is that subdivision produces explicit tangents, so both new
  boundary keys read `Custom` instead of their named easing), `geoCutAt` (a node order, or a
  `(j, t)` landing, → `splitGeo`) and `sectionCutAt` (a native-axis `s` → `splitForce`).
  **The cut/join boundary-keyframe law.** A cut duplicates the landmark it lands on into both
  halves, so `joinNext`'s collapse is what makes the round trip lossless — and it dedupes on
  position *and* value, never position alone: a section boundary is a documented snap landmark, so
  two independently-authored neighbors routinely hold keys there, and collapsing is lossless exactly
  when the two agree in `g`. Where they disagree the join is reconciling a real discontinuity and
  both keys stay. The collapse **carries the departing key's ease** (`bHead`'s, not `aTail`'s):
  `profile.segment` derives a segment's tangents from the *leading* keyframe's ease, and a collapse
  changes which keyframe leads — `aTail`'s ease is inert pre-join (last key of its section, the
  profile holds flat past it) while `bHead`'s governs the tail's opening segment. General form:
  **a structural op that undoes another op must test for the shape, not the position** — position
  alone is provenance guesswork, and snapping makes the false positive routine. Initial speed: `trackV0State`/`setTrackV0` (`Track.v0`).
  `startEntry`, `V0`, `EXTEND_DIST`, `MAX_SAMPLES`, `DS_NOMINAL`. Bake liveness: `authoredHash`
  (the gate's reading computed from the LIVE authored state, not read off the last bake) +
  `bakeLive` (whether the current bake IS that state) — what anything treating `sectionInfo` as
  truth checks first, since a never-run, invalidated (`hash === ""`), or two-node-floor-skipped
  bake leaves it describing a shape that is no longer on screen.
  **The per-section step** (`Section.ds`, resolved by `sectionStep`): a section bakes at its own
  step, `0` meaning the track-nominal `DS_NOMINAL`. Only an invoked solve writes one — a converted
  section carries the solve's realized `length/edges` so its profile spans the section exactly.
  **What that carry buys is now an open question.** It used to be what closed the pinned exit:
  replaying at the nominal quantum missed by metres-scale fractions, because the nominal replay
  wasn't conformed. Under `resolveStep` both replays conform to the same exact step and land
  **bit-identical** (`tests/track.test.ts` pins the identity, still
  guarding the old `shortfall > 0.2` so it can't go vacuous). The step's remaining unique claim is
  recording the solve's *chosen edge count* against a `length` or nominal step that later drifts out
  from under it. Re-justify it on that basis or remove it; until then the carry is unexplained, not
  load-bearing. It's authored
  input, so it's in `bakeHash` (written only when set, so the sentinel leaves an authored track's
  hash byte-identical) and in `snapshotSection`/`restoreSection`/`spawnSection`. Three op rules:
  **a convert resets it** (the destructive reset discards the payload the step belonged to), **a
  split gives both halves the step** (the partition keeps each half's density; it doesn't re-solve),
  and **a join takes the upstream's** — the joined section spans neither solve any more, so the
  neighbor's step has no claim on it. Pinned in `tests/ops.test.ts`.
  **The provenance sidecar** (an untouched conversion round trip is the identity — restore, never
  re-fit): a module-level `Map<sectionId, {payload, token, entry}>`, deliberately NOT in
  `bakeHash`/`authoredHash`, snapshots, or serialization — a droppable cache of previously authored
  state (dropping it degrades to today's always-fit). `stampProvenance` (called by both
  `history.landSolve` landings; payload = the landing's own pre-solve `snapshotSection`) /
  `readProvenance` / `consultProvenance` — the ONE certification core both invoked converts call: a
  fresh `sectionToken` must equal the stamp's, and the live `sectionInfo.entry` must match
  **bit-exact** on all four fields (`entryExact`, plain `!==`, NaN fails closed). `sectionToken` =
  `sectionContentHash` (kind + own ds + rows, NOT `order` — factored out of `bakeHash`, which folds
  `order` back in itself) + `Track.domain` (a ruler pick converts a force store without touching
  rows — the one silent-corruption path). Global `Track.ds` is deliberately excluded: a first
  section's entry is ds-invariant, so it restores across a global ds change — benign, the restore
  returns authored-exact rows; don't fold ds in (it only converts benign restores into fits).
  Destroy paths (`deleteSection`/`joinNext`) evict; ids never recycle, so a stale entry can't
  alias; a future document-load path must wipe the map (nothing else clears it). A restore never
  re-stamps. `convertSection` (the destructive flip) neither stamps nor consults.
  **The downstream freeze** (`setBakeFreeze`, pin mode): while set, `bake()` runs TWO chains
  — start..the pinning section live, downstream seeded at the FROZEN entry (the session's
  recovered exit), so downstream holds its mode-entry placement while the live exit wanders.
  Downstream payloads can't change in-mode (the lockdown), so the frozen part re-bakes
  byte-identical with no snapshot. The seam is a zero-length GAP edge over a real position jump
  (`ds = 0`, prior edge's force carried; no section range covers it, so the kind stroke never
  bridges the gap — the ds-convention law above). A freeze toggle forces one bake through the
  hash gate (`freezeInvalid` — mode open/close is editor state, not authored state); budget-less
  downstream (a track already past `MAX_SAMPLES`) publishes empty past-buffer ranges rather than
  stale prior-bake info. Tested in `tests/track.test.ts` + the mode-level freeze suite in
  `tests/pin.test.ts`.
  **The landing display override** (`setBakeLanding`/`BakeLanding`, the paced landing's
  whole-display half): while a landed Solve's landing runs, `forceDense` substitutes the landing's
  interpolated `g` for the landed section's keyframes — the ONE seam where keyframes become bake
  input, so curve, viewport geometry, markers, and cart glide with the chart's diamonds instead of
  snapping. `bakeFreeze ?? bakeLanding` holds the downstream freeze through the window (the mode
  already closed, so nothing else would), and the hash gate is bypassed while `landingLive()` — the
  interpolant moves while the authored hash stands still, so the window bakes every frame.
  `setBakeFreeze`'s pattern throughout: module-level editor-owned state outside `bakeHash`,
  invalidated through `freezeInvalid`. What makes "cosmetic only" true **at the seam** rather than
  by convention is `bakeLive` returning false in-window: the override's bake carries display values
  under the authored hash, so everything that certifies bake truth (Reset, Convert, Solve) grays for
  the window instead of reading a contaminated bake as authored state.
- `cart.ts` — looping cart animation on the *baked* track. `cartState[trackEid]` (`t`, `held`),
  `cartPose` (interps the baked geometry for the box renderer), `forceCurve` (baked F_n as per-sample
  `(s, f)` over cumulative arclength — the chart's distance x-axis), `loopTime`, and **`trackMapping`**
  (the per-sample arclength↔time table over the display bake — the cart's `t`↔chart-`s` projection;
  the cart rides in time, the chart is distance). `cartArc` reads the playhead's own arclength off
  the current bake; `playheadPosition` wraps it with the SAME axis pair (`d` and the track's
  native `u`, `dToU`-projected) — the ONE resolution every playhead-anchored Cut reads, never a
  pixel- or table-derived reading (`editor-ui.md`'s transport-read clause, `kex2d-structural-
  editing` stage 8): `controls.ts`'s keyboard path (`keys.ts sectionKeyAct`'s playhead-exact
  `cutAt`) AND `Timeline.svelte`'s `clipMenu` (the menu's cursor→playhead snap, `timeline.ts
  snapCutToPlayhead`) both call it directly — one call site, not two paths that happen to agree.
- `editor.ts` — ephemeral UI state: `selection` (node), `force` (point id), `section` (id), `start`
  (the track START anchor / v0 handle) + their setters. The four are **mutually exclusive** (selecting
  one clears the others). `tangentEdit` (eid or null) is a sub-mode layered on node selection, NOT a
  fifth exclusive state — entered by double-clicking a node (`enterTangentEdit`, summons its
  handles); a different-subject select, Esc, or click-away exits it (`exitTangentEdit`). Two
  right-click menus: `context` (the section menu — the ONE kind-fitted `Convert` row, `Pin` on a
  force section, then `Reset` and `Delete`; inside a live pin session on that section
  it becomes Solve + Exit instead), `nodeMenu` (the node context menu — Add, a Handles
  toggle, a Tangents ▸ submenu holding the three modes, then Reset and Delete — opened on any
  pickable node, any mode),
  and `rulerMenu` (the ruler's Meters/Seconds domain picker, `openRulerMenu`/`closeRulerMenu` — no
  target subject, the ruler addresses the whole timeline; a row's pick is a document conversion op,
  so no basis view-state lives here — the chart reads `Track.domain`) — all `{x, y, …}` or
  null, rendered once at the app root. Also the rail's one toggle — `snap` (`toggleSnap`/`snapActive`
  — persistent, default on, `S` toggles, Ctrl/Cmd bypasses per-gesture) — and
  `hover` (`Surface`, `"viewport" | "timeline"`) — the pointer's current
  surface, routing the surface-scoped keys (`F` frames it, arrows act on it), ending the
  viewport-nudge vs timeline-playhead double-fire. `hoverSection` (a stable `Section.id` or null) is
  the viewport's own hover read — written per pointermove by `controls.pickHover` (the DOM-free
  sweep, unit-tested directly against the pick order `onPointerDown` grabs by), drawn one
  kind-color rung up by the track overlay, cleared on pointer leave and for the whole of any gesture
  (`beginDrag`, the one suppression point); viewport-local, never synced with the clip strip's CSS
  hover. `hoverNode` is its node-level twin (a node picks before its section, so exactly one of
  the two is lit — hover matches what a click would take; the node draw lifts it one rung).
  `hoverForce` is the force-marker twin, written by the same sweep and mutually exclusive with both.
  `hoverKnob` (`{eid, side}` or null) is the tangent-knob twin, live only in tangent edit and
  written FIRST in the sweep — a summoned knob over its own node reads as the knob, the priority a
  click takes. All four land through one seam, `editor.writeHover`/`clearHover` — a caller can't
  write three of the four fields and miss the fourth — and clear together at three sites: pointer
  leave, remount teardown, and `beginDrag` for the whole of any gesture.
  The invoked-solve gate lives here too: `converting` (`{phase, keys, probes}` or
  null — while it's set the modal is up and every other input is blocked; the fields are gate
  state, not display — the modal shows a spinner, not the counts) with
  `beginConvert`/`convertProgress`/`endConvert`, and `notice` (the transient outcome text) with
  `notify`/`dismissNotice`. It carries no `section` id: the surface that opened the modal owns
  that, and a copy here would be a second truth. `convertProgress` DROPS a report that lands after the gate closed — a
  cancelled solve's in-flight probe would otherwise raise the modal back with no cancel path left.
  The gate is pure state; the `AbortController` and the await live with the surface that opened it
  (`App.svelte`). Pin-mode state lives here too: `pinning` (the session — stamp, ghost,
  downstream-freeze seed), `locked`, `pinSolving` (the mode's own blocking gate), `landing`
  (the paced-landing display override, cosmetic only), and the SANDBOX — `beginPin`/
  `endPin` are the only open/close choke points (every path goes through them), creating/
  discarding the sandbox history, setting/clearing `history.redirectHistory` and
  `track.setBakeFreeze`; `sandbox()`/`restoreSandbox` are the landing's capture/restore seam.
  `Landing` carries the landed session's `section`, which is what makes `modeChromeSection()`
  (`pinning ?? landing`) possible — the modal chrome's subject, CHROME ONLY: the panel, the dim
  wash, and the subject hatch key on it so the landing reads as the mode's exit transition, while
  enablement and consent predicates keep reading `editor.pinning`. `easeOut` is the one shared
  easing curve (`landingG`'s interpolant and App's `--ease-out` token, pinned equal in
  `colors.test.ts`). Plain singleton, read by Svelte via the per-RAF tick.
- `history.ts` — **one undo/redo stack for the whole editor** (mirrors shallot's editor
  `document/index.ts`): a `Command {apply, reverse}` dual stack (`MAX_UNDO=256`) + a generic
  `begin`/`commit`/`cancel` snapshot gesture (one at a time, so a live drag collapses to one entry).
  Node: `extendTrack`/`trimTrack`/`beginMove`. Force: `createForce`/`deleteForce`/`beginForceMove` +
  `beginLength` (the extent drag). Initial speed: `beginV0` (the v0 field gesture). Kind:
  `convertSection` (per-section, a `snapshotSection` pair) + the two invoked-solve landings over
  one shared `landSolve` (the same pair, the direction supplying its own write): `solveForce`
  (geo→force, `applyConvert`) and `solveGeo` (force→geo, `applyConvertGeo` — it also takes the
  section's entry frame, the frame the fit's world-space nodes localize against). Named
  direction-explicitly: `solveSection` was ambiguous once two directions existed. Both landings
  stamp the provenance sidecar (`landSolve`'s `stamp` flag, the pre-solve `before` snapshot as
  payload); `restoreProvenance` is `landSolve`'s twin without a solve — lands a stamped payload
  verbatim (current `order` kept, no re-stamp) as one undoable entry, the `"restored"` outcome's
  write path for both directions' `tryRestore`.
  Structural: `appendSection`/`splitSection`/`joinSection`/`removeSection` — each a whole-track
  `snapshotAll`/`restoreAll` pair (they reorder sections + move nodes across them). Pin-mode
  seams: `redirectHistory` (while set, EVERY `record` lands in the sandbox — structural
  containment, and the redirect target is exempt from `MAX_UNDO` eviction: Exit replays and the
  landing freezes whole stacks, so eviction would silently break byte-identity), `recordOuter`
  (the redirect bypass the Solve landing uses), `resumedLanding`/`markResumedLanding` (the
  reopened session's redo-at-end re-land offer, cleared by a forking record), and `solvePin`
  (the landing: free-key g writes + the mode transition in one outer entry whose reverse restores
  the draft AND reopens the mode via injected enter/exit closures — this module still never
  imports editor). `history` singleton; `createHistory` for tests.
- `domain.ts` — the **track-global domain conversion**, and the ONE place a force section's stored
  numbers change unit. `convertDomain(history, ecs, target)` is the ruler pick as a document op: a
  pure transform of the whole-track snapshot (every keyframe's position, every extent, every explicit
  handle's Δs scaled by the local `dt/ds`) landed by `history.landDomain` as one entry, so a
  conversion that throws part-way writes nothing. The table IS the conversion — `cart.trackMapping`
  windowed per section by `track.sectionInfo` (`entryD`/`exitD`/`entryT`/`exitT` + the boundary
  speeds), so an interior position interpolates and one past the section's own baked span
  extrapolates on THAT section's exit speed. The two boundaries return their exact stations rather
  than interpolating: `interpMono` resolves a tie to the last tied index, and a stall plateau
  reaching past a section's exit sample would otherwise absorb the whole downstream stall.
  `convertible(ecs)` is that precondition as a predicate — a live bake, a table, and every force
  section on it (a section past the `MAX_SAMPLES` cap reads NaN stations, so it rejects) — and
  `pickable(ecs, target)` wraps it as the ruler menu's ONE row-enablement rule (the active row
  always, a converting row only when it can run), so a blocked pick can't click through to a silent
  no-op or a NaN store. A round
  trip is NOT bit-identical — sub-quantum on a gentle ride, tens of percent on a sensitive one, and
  a stall collapses distinct times onto one arclength by construction; undo is the only way back.
  `convertSolve(ecs, sectionId, solved)` is the landing seam for the same math: invoked solves stay
  distance-internal (their goldens are frozen in meters), so `geoforce.convertGeo` passes its answer
  through it inside the landing entry, releasing the realized step to the sentinel the way a flip
  does. Device-free tests in `tests/domain.test.ts` (guards, the forward conversion against an
  independently rebuilt table, the derived round-trip bound, undo byte-identity, the plateau and
  past-span degeneracies, the window boundaries).
- `geoforce.ts` — the **invoked geo→force command**, and the only place the conversion tier and
  the document meet: `convertGeo(history, ecs, sectionId, opts)` drives `convert.ts`'s façade with
  the bake's OWN input (`evalGeo(sectionInfo.entry, geoNodes(…), sectionStep(…), MAX_SAMPLES −
  startSample)` — the same call `BakeSystem` makes, budget included, so the solve targets exactly
  what's displayed) and lands the answer through `history.solveForce`. **The document is written
  once, at resolution**: the façade is pure, so a cancel, a `"diverged"` answer, or a stale one
  leaves the track byte-identical and no rollback path exists to get wrong. What that shape needs
  instead is that the document still BE the one the answer describes, so the invoke holds a
  per-section in-flight lock (a second invoke rejects — two solves would each snapshot the other's
  output as their "before") and re-reads `authoredHash` before writing (a mid-solve edit rejects as
  `StaleConvert`, its own type so a UI tells it from a cancel). The caller is modal; the guards are
  the backstop, not a license to author underneath a running solve. Nothing of `ConvertResult`
  persists past points / length / realized `ds` — outcome, floor, deviation, probes are transient
  readout. `tryRestore` runs the provenance short-circuit inline before the façade ever spawns
  (`track.consultProvenance` → `history.restoreProvenance`, a `"restored"` outcome on
  `ConvertGeoResult`); a verbatim restore is already in the track domain's unit, so it never
  crosses `domain.convertSolve` — safe by construction, the token folds `Track.domain`.
  Device-free tests in `tests/geoforce.test.ts` (apply+undo byte-identity, downstream
  continuity at the 1e-3 exit bound, cancel / diverged / stale / re-entrant all leaving the
  track byte-identical, and the reverse-direction provenance suite).
- `geofit.ts` — the **force→geo fit kernel**, the observation-space twin of `refine.ts`: a dense
  force-section bake (`x`/`y`/`fN`/`ds`) + the entry speed + a dual budget → a sparse `Auto` node
  chain `{x, y, theta}`. Pure and framework-free (no ECS, no editor, no shallot) like `spline.ts`
  / `bake.ts`. A node is a literal PICK of a dense sample, its heading the target's own
  `bake.forces`-recovered theta (the unwrapped chord bisector — a wrapped atan2 breaks the arc
  rule past ±π on a loop), so the chain interpolates the target exactly at every node and the tail
  node carries the recovered exit heading. Split-then-prune mirroring `refine`'s shape: open at the
  two endpoints, split at the worst-|ΔfN| site (geometric fallback when it isn't admissible), then
  greedily drop the interior node leaving the most slack (normalized per budget, lowest index on a
  tie) — deterministic and parameter-free. **A candidate is scored on its OWN adaptive bake**
  (`chainCounts` + `sampleAt` + `forces`, exactly `evalGeo`'s path), because that is what the
  document bakes once the fit lands; scoring at frozen target-matched counts under-reports wherever
  the per-segment edge-count rule inflates the landed density (measured 0.40 g reported vs 1.19 g
  displayed). The two bakes have different sample counts, so both budgets are compared
  on **absolute arclength from the section entry** — the timeline's own station axis — over the
  UNION of both curves' stations, so neither side's extremes are stepped over, with each per-edge
  `fN` read at its LEFT sample (`bake.forces`'s own attribution). Normalizing each node-to-node
  span by its own length is the refuted alternative: the fitted chain cuts corners and runs
  systematically short, and per-span normalization divides that shortfall out (measured 0.48 g
  reported vs 1.57 g displayed on valley-explicit, 4/10 corpus scenarios over budget).
  `GeofitParams` therefore carries the LANDED section's
  sampling (`dsNominal`, `maxSamples`) alongside the two budgets, and `GeofitResult` carries the
  resolved budgets back so a readout prints the bound the fit actually ran. Unit + corpus oracle in
  `tests/geofit.test.ts`, the corpus-wide document-metric gate in `tests/forcegeo.test.ts`; sweep
  + timing in `tests/forcegeo.lab.ts`.
- `geofit-async.ts` + `geofit-worker.ts` — the **one-shot async wrapper**: `runGeofit(bake, v0,
  {signal, params})` spawns a dedicated worker, posts one message, resolves once. `convert.ts`'s
  façade minus everything `refine`'s multi-probe search needed — no pool, no fan-out, and no
  progress to report (a fit has no internal phase, so the modal shows an indeterminate wait).
  Cancellation is `Worker.terminate()`; the façade writes no document state, so an abort needs no
  rollback. `liveFitWorkers()` makes teardown independently observable.
- `forcegeo.ts` — the **invoked force→geo command**, `geoforce.ts`'s twin and the only place the
  fit and the document meet: `convertForce(history, ecs, sectionId, opts)` hands `runGeofit` the
  bake's own input (`track.forceBake`, budget-clipped the same way `chain` clips it) plus the
  sampling the LANDED geo section will bake at (the track nominal step, the remaining sample
  budget), and lands the answer through `history.solveGeo`. Same once-at-resolution shape as the
  geo→force direction, same guards: a per-section in-flight lock, and an `authoredHash` re-read
  before the write (a mid-fit edit rejects as `StaleConvert`, named identically so
  `editor.solveFailed` reads both directions through one check). Nothing of `GeofitResult`
  persists past the nodes. A `budget` outcome denser than `MAX_LANDED_NODES` = 212 resolves as the
  refusing `dense` outcome (transient readout, document untouched) — the landing-side runaway
  refusal; derivation on the constant (authoring scale via `attribution.lab.ts`'s floor sweep,
  never wall time). `tryRestore` runs the provenance short-circuit inline before the worker spawns
  (`track.consultProvenance` → `history.restoreProvenance`, a `"restored"` outcome on
  `ConvertForceResult`) — the only path that brings explicit tangents back, since the fit emits
  Auto-only by locked dialect. Device-free tests in `tests/forcegeo.test.ts` — apply+undo
  byte-identity, downstream continuity, the guard paths, plus the **document-layer fidelity**
  oracle (the landed section's baked `fN` vs the pre-convert bake, arclength-aligned) and the
  round trip back to the originating geo scenario's own shape. The untouched-trip identity is
  swept universally at the document layer: `tests/roundtrip.oracle.ts` (full tier — 10-scenario
  corpus + hill seed, both directions, every trip must land `"restored"`) over
  `tests/helpers/roundtrip-doc.ts`, with the fast-tier hill sentinel `tests/roundtrip.test.ts`;
  `tests/roundtrip.lab.ts` stays the kernel-seam yardstick and never sees provenance.
- `pin.ts` — the **pin-mode document seam** (`geoforce.ts`'s sibling), and the
  sandbox's routing layer. The mode is the pin, the kernel it drives is the optimizer — which is
  the whole naming split (`kex2d/AGENTS.md`, Pin mode). `enterPin` stamps the section's current
  exit + freezes the ghost
  and the downstream-freeze seed in ONE `evalForce` call (the same computation the solve's own
  residual reads); `enterPinMode` opens the mode (which opens the sandbox — outer history
  untouched). `runPinSection` re-reads the section's live baking parameters per invoke,
  freezes the lock ledger AT INVOKE, translates stable keyframe ids to kernel indices, and lands
  a `"solved"` answer through `history.solvePin` as the ONE outer entry (always — a
  zero-drift Solve still closes the mode, and the transition must sit on the stack). Guards:
  per-section in-flight lock, post-await SESSION IDENTITY (`editor.pinning === session` — a
  late-resolving Solve after Exit discards as `StalePin`; the no-trace guarantee is a module
  invariant), then `authoredHash`. `undoRouted`/`redoRouted` are the editor-level undo/redo: the
  sandbox while a mode is open (undo at its start = Exit; a redo at a RESUMED sandbox's end falls
  through to the outer re-land, offer cleared by a forking edit), the outer history otherwise.
  `exitPinMode` discards: replay every sandbox reverse, close. Sandbox/boundary tests in
  `tests/pin.test.ts` (mutation-proven guards), which also carries the grep sentinel pinning that
  no mode identifier drifts back into the solver set.
- `controls.ts` — `attachControls(canvas, ecs)` wires canvas pointer + window keyboard, returns a
  teardown. Pick priority is node → force/START → section: `pickNode` (order-0 anchors are
  pickable, not draggable), then `pickForceOrStart` (the middle rung, resolved **nearest-wins** with
  an exact tie to START — a force-first section's `s = 0` seed sits exactly on the START diamond, so
  a fixed order would leave one of the two permanently unreachable; `pickForce` is the marker-only
  read), then `pickSection` (nearest span). The node write splits three ways: `placeNode` (world →
  section-local, the bare write), `dragTo` (place + `reheadOnDrag` — the default surface's), and
  `dragFreeTo` (place only, plus the lazy `Aligned` stamp at the first armed move: the tangent-edit
  body drag is authoring, so it never re-heads).
  A node body click **selects only** — except inside tangent edit, where grabbing the
  edited node's body starts a free unsnapped move (`dragNode`, same dead-zone/undo/blur machinery;
  Esc cancels it as its own dismissal rung, Delete/Backspace no-op on `editor.dragging`) —
  movement otherwise enters through `startManip` (the DOM knob
  seam, button 0 only) → `dragManipTo`, forked on `nodeFrame`'s discriminated `NodeFrame` (tip →
  polar, interior → chord slide/offset), plus the arrow-nudge fork (`polarNudge`/`chordNudge`,
  pure: left/right = angle-role, up/down = length-role). Right-click a section span
  opens the context menu (`openContext`). Keys: `Enter` extend / `Del` trim (node end); `Del` delete
  (selected section). All edits route through `history`. Also the readout metric seam: `nodeMetrics`
  (pure: node → `{angleLabel?, lengthLabel}`, over the authored `exitWorld` heading + chord) +
  `selectedMetrics` (the impure glue over the baked samples) + the shared formatters
  (`formatDeg`/`formatLen`, one decimal always, −0 normalized, trailing `.0` stripped — the geo
  readout's degree/length funnel, sharing `timeline.ts`'s `fmt` trim, the force readout's funnel).
- `magnet.ts` — the three grid quantizers a manipulator drag resolves through (`snapLength`,
  `snapSteps.length` grid + the `LENGTH_MIN` 1 m floor; `snapAngle`, the `snapSteps.angle` grid;
  `snapGrid`, the floorless signed grid the interior slide/offset axes use — −0 normalized at the
  source, since 0 is a real reading there) plus
  the incline algebra
  (`inclineOf`/`chordForIncline`) a tip's exit-tangent snap needs. Grid, not magnet: the screen-px
  target pool, `COMBINE_DOT` co-fire, and shift-lock dissolved with the free 2D drag (each gesture
  is 1D now). The name is legacy; fold it into `manipulator.ts` when the 3D port touches it. No
  shallot, no DOM — unit-tested in `magnet.test.ts`.
- `settings.ts` — the **per-user preference home**: load / clamp / save over `localStorage` (one JSON
  object under `SNAP_KEY`), since the prototype has no document to hold a preference. Today the two
  manipulator snap quanta — `snapSteps` (`angle` rad, default 5°, range [1°, 180°]; `length` m,
  default 1, range [0.1, 100]) read LIVE by `magnet.ts`, written by the rail magnet's popover, loaded once in
  `main.ts`. Storage failure is swallowed (a denied `localStorage` never breaks authoring) and every
  read resolves through the clamps — which bound BOTH ends, since a persisted extreme would otherwise
  collapse the control across reloads (recoverability, not precision). Deliberately NOT configurable: the timeline's `S_GRID`/`G_GRID`
  force grids (fixed constants) and `LENGTH_MIN` (the chord floor, a different quantity).
  Unit-tested in `settings.test.ts`.
- `manipulator.ts` — the **node-manipulation substrate**, and the 3D port's template. Pure and
  device-free, two frames: the tip's polar frame around the previous node (`polarFrame`,
  degenerate-chord guarded) with the exact screen↔polar inverses — `screenToLength` projects onto
  the chord ray, `screenToAngle` sweeps the tangential arc (the control loci; nothing draws
  them, so they're geometry the inverses carry, not their own accessors) — and the interior
  neighbor-chord frame (`chordFrame`: u = normalized(next−prev), v = u's fixed +90° in WORLD
  orientation, never sign-picked from the node's side — a per-move sign-pick flips the readout
  when the drag crosses the chord; offset signed, 0 legitimate; exact
  `screenToSlide`/`slideToPoint`/`screenToOffset`/`offsetToPoint` inverses; `chordNudge` the
  keyboard twin; degenerate-flagged on coincident neighbors; neighbors frozen, so only
  `slide0`/`offset0` track the drag). The `Frame` is a
  **per-pointermove snapshot** (the incline
  window derives from the live chord radius — freezing it at gesture start diverges from the feel);
  every control emits **world-space** values, the y-flip folded inside, so no consumer negates.
  Unit-tested in `manipulator.test.ts`.
- `radial.ts` — the one home for the summoned ring's geometry (`ringBase`/`ringSlot`/`RadialSlot`):
  a three-button 60° fan off the heading's screen angle — measure (length) −60° · extend 0° · pitch
  (angle) +60°. `App.svelte`'s `.rbtn` buttons and the knob positions both derive from it, so DOM
  and canvas can't drift. Pins in `radial.test.ts`.
- `tangents.ts` — the tangent-handle geometry render and controls share: where a node's in/out
  handles land in screen px (`tangentHandles` — an explicit node's stored vectors, or a selected
  `Auto` node's live arc-rule ghost) and the inverse a handle drag feeds `spline.editTangent`
  (`localTipAt`, the exact inverse of the entry-frame rotation `tangentHandles` applies). A handle
  shows only for a side that drives a segment (no out-handle at a chain end, no handle on node 0) —
  one home for the section-frame convention so render and controls can't drift apart.
- `timeline.ts` — pure transform + tick math for the force-curve timeline (no Svelte/DOM/track
  state). The chart's x-axis is a coordinate `u` on one of two global axes (distance `d` in meters,
  or march time `t` in seconds), and which one is `Track.domain` itself — the chart's axis and the
  force store's unit are one fact (there is no `Basis` enum and no view copy). So the force store
  needs no projection at all: it reaches the chart through the lens's affine (`track.toGlobalU`) and
  every gesture on it resolves in its own unit. `dToU`/`uToD` are the ONE seam for the other kind of
  subject — a quantity authored in ARCLENGTH shown on a time axis (the recovered force curve, a geo
  node tick, the cart's park): identity on distance, the live bake's arc↔time table on time,
  identity again with no live bake. `T_GRID` (= `S_GRID / V0`)
  and `marginFloor` are the two axis-picked constants (the snap quantum, the lead-out floor), and
  `ticks` picks the unit suffix.
  Everything else reads the resulting coordinate `u` with no further branching: `View`,
  `sToPx`/`pxToS`, `zoomAt`, `clampView`, `frameAll`, `niceStep`, `ticks`, the navigator math
  (`navWindow`/`navDragView`/`marginArc`, each taking the axis's margin floor), `nodeArc` (a geo
  node tick's partial-`ds` arclength, projected by the caller), and `Mapping` +
  `timeToArc`/`arcToTime` (the arc↔time table `cart.trackMapping` builds). `yFit`/`YFit`
  (auto-fit g-range) + the edge-scroll grow-to-follow: `yGrow` (value drag) and `xGrow` (pan). `snap`
  is the timeline's own axis-aligned resolver for a force-keyframe drag (`Timeline.svelte`); the 2D
  viewport's node/tangent drag has its own polar resolver (`magnet.ts`) — `niceStep` (the 1-2-5 grid
  step) is the piece still shared between them, imported by `render.ts` for the viewport grid.
  Unit-tested in `timeline.test.ts`.
- `Timeline.svelte` — the always-present bottom dock (a flex row: a thin **tool rail** on the left
  edge, then the timeline content column): the **F_n force-curve readout + scrub +
  zoom/pan navigation**, the floating **media player**, and the **section clip strip** in the marker
  lane (one clip per section, kind-colored/labeled; click selects `editor.section`; a `+` tail flyout
  appends geo/force; a force clip's right edge is its **extent trim**; right-click a clip opens the
  context menu). A geo clip also carries **read-only interior-node ticks** (small circles via pure
  `nodeArc` partial-`ds` sums, the selected node's highlighted, `pointer-events: none` — entry
  and exit nodes are excluded, they coincide with the clip edges) and **washes** when it owns the
  selected node (the cross-surface context read; a ticked clip's label fades so the two don't
  collide). A node's arclength is derived, so a tick displays and never drags. The **tool rail** (`.tool-rail`) is the snap magnet's home — a magnet-only icon-only vertical
  strip on the dock's left edge (the Premiere tool-strip precedent), anatomy of the one earned dock,
  bounded to persistent global authoring toggles with a keyboard twin: `.rail-snap`/`toggleSnap`/`S`.
  **Right-clicking the magnet** summons its increments popover (`.snap-pop`) — the two
  manipulator quanta (angle °, length m) as fields in the shared idiom, written straight to
  `settings.ts` (no history entry: a per-user preference, not track state); its click-away exemption
  names the invoker (`.rail-snap`), never the rail. It's inside the dock's
  DOM, so it's the timeline surface for `editor.hover`. **The track domain (Meters/Seconds) is
  picked on the RULER's own context menu** (`rulerCtx` → `openRulerMenu`, right-clicking
  `.rulerzone` — the Premiere/REAPER/Cubase reference: time-display format is the ruler's, not a
  standing rail toggle): flat rows (no `Units ▸` submenu — nothing else lives in this menu),
  `checked` reading `Track.domain` (the store's own unit, so a lit row can't lie about what the
  chart reads), the INACTIVE row grayed by `domain.pickable`, no keyboard shortcut (the second
  feel check-in's call). `pickDomain` lands a row: `convertDomain` converts the store as one
  undoable entry, and the visible window carries across as a fraction of the addressable span so
  the ruler reads as re-labelled rather than jumped. Every FORCE path on the chart is native to that
  axis — keyframe placement (`track.toGlobalU`), the drag (delta-from-grab in the store's own unit,
  so a returned gesture writes bit-exact zero), the extent trim (a duration trim in the `Time`
  domain), the popover fields and the label scrub, the `GRID` quantum (`S_GRID` / `T_GRID`) — while
  arclength-authored subjects (the curve, geo node ticks, the cart's park) project through
  `dToU`/`uToD`. The chart
  draws the baked F_n curve + **section boundary guides**
  (dashed verticals); the **ruler** is the scrub zone; wheel zooms, shift+wheel pans; a **navigator**
  minimap pans/zooms. The chart is a **whole-track force-authoring surface**: it draws every force
  section's points (`forcePts`), and a double-click over a force section's arc adds a point there —
  authoring is **by cursor position**, no "active section" (an empty-chart click deselects). Both a
  keyframe drag and the extent trim freeze the view (`yGrow`/`xGrow` edge-scroll past the chart edge,
  resume on release). Conventions: `kexedit/.claude/rules/editor-ui.md`. Takes `ecs`; routes edits
  through `history`.
- `menu.ts` + `menus.ts` + `Menu.svelte` — the menu substrate, in three parts. `menu.ts` holds the
  language: `MenuItem` (label, `group`, `checked`, `enabled`, `shortcut`/`danger`, `separator`,
  `children`), the `GROUPS` taxonomy the ordering law is written in, `BINDINGS` (the keyboard
  table both the handlers and the rows advertising a hint read — `bound(binding, key)` is the
  handler half), `menuRows` (the rendered sequence: the builder's rows with a divider derived at
  every group change, an authored within-group divider collapsing with a derived one rather than
  doubling), and the two pure fit solvers `menuFit`/`flyoutFit`. `menus.ts` holds every row array
  as a PURE builder — `sectionMenu`, `nodeMenu`, `keyframeMenu`, `rulerMenu`, `appendMenu`, each
  `(state, actions) => MenuItem[]` over an explicit descriptor — and is module-graph pure (it
  reaches only `menu`/`profile`/`section`/`spline`; the graph is walked as a test). That purity is
  the point: the rows used to live in `$derived.by` closures no test could read, and the grammar
  over them was a convention until the lift made it gateable. `Menu.svelte` is the ONE renderer
  (recursive for submenus), rendering `menuRows(items)` inside a positioned `.menu` wrapper and
  publishing each row's `data-group` so the capture harness can cross-check the DOM against the
  same builders. Consumers: the section + node context menus (`App.svelte`), the keyframe, ruler,
  and append menus (`Timeline.svelte`). The grammar itself (groups, ordering, separators,
  `checked`, toggle labels, `shortcut`) is `editor-ui.md` Menus; the oracle over every builder ×
  its full state matrix is `tests/menu.test.ts`.
- `keys.ts` + `acts.ts` — the menu triple's other two members (`menus.ts` is the rows). `keys.ts`
  is the pure keyboard twin of `menus.ts`: one decider per `BINDINGS` home, `(key,
  stateDescriptor) → actName | null`, typed `Extract<keyof XMenuActions, …>` and reaching only
  `menu.ts` at runtime, so `tests/menu.test.ts` drives every decider across its state matrix with
  no shim. `acts.ts` is the ONE impure member: `sectionActs(ecs, subject)` / `nodeActs(ecs, eid)` /
  `keyframeActs(ecs)` each return the `Pick<>` of their surface's actions record holding the
  **document** acts — ECS + `history` + `editor` writes — and both the menu builder and the keydown
  home consume it, so a row and its bound key can't run different bodies. Chrome acts (a modal
  drive, a worker façade, a chart-pixel coupling) stay in the `.svelte` home; the membership test,
  and the spread-last law that keeps a re-forked key from shadowing a hoisted body, are
  `editor-ui.md` Menus. A factory **closes over and computes nothing at construction** — the menu
  builder calls it inside a `$derived.by` that rebuilds on every open, and a test constructs one
  against a bare `State`. It also owns the act-layer predicates the guards read:
  `sectionOpsAllowed`/`sectionEditable`/`suffixRun`/`nodeMembers` moved off `controls.ts` (which
  imports `sectionOpsAllowed`/`sectionEditable` back for its own drag guards), while
  `forceSetEditable`/`lockCandidates` are new — lifted off `Timeline.svelte`'s local
  re-derivations. Structural ops enter through `cutSection(ecs, section, position)`, with
  `CutPosition = { at, t? }` resolved by the CALLER (a menu's cursor read, a key's playhead read)
  and the consent guard living **inside** the op, so every surface inherits it by construction;
  `nodeCuttable`/`keyframeCuttable` are the row-enablement predicates that must agree with that
  guard (`editor-ui.md` Menus, the consent-boundary law). The edge is one-way, `acts.ts` never
  imports `controls.ts`. Tests:
  `tests/acts.test.ts` (every act driven on a real ECS track), plus `tests/menu.test.ts`'s
  naming→behavior bridge and the homes census.
- `App.svelte` / `render.ts` / `view.ts` — Svelte shell + canvas2D render: grid, the **track**
  polyline (solid feasible blue / dashed infeasible red), section-entry **anchor diamonds**, the
  hover + selected-section span overlays (each in the section's OWN kind color — one rung up under
  the pointer (`hovered`), brightened when selected (`selected`); priority infeasible-red >
  selection > hover > kind, all three stroked through one `strokeFeasible`), the pin-mode
  **out-of-scope dim** (every non-subject span, plus its anchors/nodes/markers, washed topmost in
  `colors.DIM_WASH` — the viewport half of the timeline's `.mode-dim` wash; one channel, both
  surfaces, `editor-ui.md` Mode vocabulary; all four passes keyed on `editor.modeChromeSection()`,
  so the wash holds through the paced landing and releases with it in one moment), the **force
  keyframe markers** (`ForceDrawSystem`, ordered between the anchor and handle passes — the
  timeline diamond's viewport twin over `track.forceMarkers`: same entity, same glyph, the kind-color
  ladder plus the driven register for a locked key in pin mode; display + select only, nothing
  drags), the node handles
  (selected/orphan/infeasible), the cart, the
  **Timeline** dock, and the three-button radial ring around the selected node (`radial.ts`: the
  two manipulator knobs flanking extend, the extend button chain-end-only, all hidden in tangent
  edit). In
  tangent-edit mode (`editor.tangentEdit`): `TangentDrawSystem` (`render.ts`) draws the edited
  node's handles — one accent knob, authored and inferred alike, since inferred is the
  initialization rather than a state the author picks; right-click any node opens the node
  context menu (`menus.nodeMenu` rendered by a `Menu` over `editor.nodeMenu`, the same shared
  `.menu` look + cursor placement as the section context menu). Snap-guide feedback: the viewport draws the incline **ray** in the shared neutral
  gray (`COLOR_GUIDE_RAY`), the one register every snap guide wears (the timeline's `.snapguide`
  too); the numeric **°/m readout** is DOM — App's `.snap-readout`, the Blender modal-transform
  readout, shown **whenever a node is selected** (the Figma selected-object dimensions idiom): every
  node with a previous node shows its **authored** world exit heading (`exitWorld`, °) + the chord
  (m) to the previous node — the same quantities at rest and mid-drag, never a bake re-derivation
  and never the dragged handle's own geometry. One readout, a three-case precedence: the drag feed
  (`dragReadout`, the dragged node's eid — `App.svelte` re-derives its metrics per RAF post-write,
  so a stitch drag reports the downstream node authoritatively) > the engaged snap labels
  (`snapGuides`) > the resting `selectedMetrics`. It's **centered below the node**, offset by
  `READOUT_OFFSET` (`RADIAL_R + RADIAL_BTN_R + gap`) so it clears the radial ring
  **by construction** — a button center orbits at `RADIAL_R`, its far edge at `RADIAL_R +
  RADIAL_BTN_R`, so the readout starts a gap past that wherever the heading swings the ring. Pure
  `readoutFit` (`view.ts`) places it: centered-then-clamped horizontally, flipped above the node
  near the bottom so it never lands under the timeline dock. (Earlier tries: a chip AT the drag
  point overlapped the buttons; a fixed top-left line read too far from the action.)
  It also owns the **invoked convert**: the section menu's ONE conversion row — labeled `Convert`
  (the kind implies the direction), its action and enablement resolved
  from the target's kind through the one `track.sectionSolvable` predicate (that kind, one
  section, a live bake, and — force→geo only — a bake within `MAX_FIT_EDGES` = 2400 edges, the
  invoke-side runaway refusal; derivation on the constant in `track.ts`, beside its twin
  `sectionResettable` — both pure device-free section predicates: the largest edge count
  actually measured inside the modal's 30 s completion budget, never extrapolated. Grayed
  otherwise, never hidden — the opposite direction is absent, since a
  section is only ever one kind),
  the `solve()` drive around `geoforce.convertGeo` (one `AbortController`, progress folded into
  `editor.converting`, `editor.solveDone`/`solveFailed` mapping each exit to the readout — cancel
  says nothing, and a raw thrown message goes to `console.error`, never to the surface), and the
  **modal** it renders. Blocking input takes two mechanisms: **`inert`** on the whole app content
  (`.content`, `display: contents`, so it adds no box) — pointer, focus, and activation at once, so
  no background control can be tabbed to and Enter'd into a real `click` — plus a permanent
  capture-phase key swallow gated on the live `editor.converting`, for the WINDOW-level listeners
  (`controls.ts`/`Timeline`) that `inert` doesn't reach (Escape alone acts: it cancels). The
  `.scrim` is the modal's own surface and suppresses the native context menu; the dialog takes
  focus on mount, so `aria-modal` is honest. The infeasibility banner and the transient readout are
  anchored **independently** top-center, the readout on a reserved second row, so neither moves the
  other in either direction.
- `main.ts` — boots `run({ defaults: false })` + mounts App, and wires the editor's `SelectionHook`
  into `history` (the one place the two meet). The DEV-only `__kex` hook exposes geo state
  (`nodeCount`/`undoDepth`/`tTotal`/`poses`/`selectEnd`/`selectNode`/`selectedOrder`/`nodeAt`/
  `startAt`/`seedHill`/`seedTwinHill`/`nudge`), tangent state (`tangent`/`mode`/`inX`/`inY`/`outX`/`outY`/
  `tangentHandles`/`editing`), force state (`kind`/`forceCount`/`forces`/`convert`/`placeForce`/
  `seedForceBump`), the multi-section ops (`sectionCount`/`sectionKinds`/`append`/`deleteAt`/
  `convertAt`), and the read-only VIEW observables a behavior with no honest DOM assert needs —
  `cam` (the whole `[zoom, ox, oy]`, the wheel-guard flow's contract) and `guides` (whether the
  canvas-drawn incline ray is up, plus the two readout labels) — all driven by the capture harness;
  never ships. Screen-space affordances are driven
  pointer-true through the real DOM (`.rbtn`, `.manip-length`, `.manip-angle`), not through hooks.

## Hard gotchas

Per-module hazards. The app-level ones (input wiring, the two keydown handlers, holding an eid
across a restore, the force-profile endpoint hold, the START anchor) live in `kex2d/AGENTS.md`.

- **The bake uses `forces`, not `invertRange`.** `invertRange` is the *exact* reflection inverse of
  the forward integrator (`θ_{i+1} = 2·m_i − θ_i`). It carries a leapfrog "computational mode": a
  marginally-stable ±(−1)^i tangent oscillation. On positions the integrator itself produced it
  cancels to zero (round-trip exact), but on a varying-curvature curve the mode is excited and **F_n
  sawtooths sample-to-sample**. `forces` recovers θ as the chord bisector instead, which has no such
  mode. Don't switch `BakeSystem` (or `section.evalGeo`/`evalForce`'s recovery) to `invertRange`.
- **`forces` accumulates a *continuous* chord angle.** It unwraps the per-edge chord angle before
  taking the tangent bisector, so θ stays continuous across the ±π atan2 branch cut. The cart lerps θ
  for its orientation, so a raw-`atan2` θ would spin the cart a full turn when the heading crosses
  ±π. A `bake.test.ts` test guards this.
- **Node headings (`Handle.theta`) are stored authored state — keep them out of the bake.** The
  bake's per-sample θ is a separate quantity, recovered from the sampled geometry (chord bisector).
  Don't (a) make the bake read `Handle.theta`; (b) reintroduce a `Track.theta0` entry angle — node 0's
  flat anchor *is* the entry (and in the substrate, the section entry); (c) switch `sampleChain` back
  to inferring tangents from neighbor positions each bake (Catmull-Rom) — that breaks two-segment
  locality.
- **Stored `Handle.theta` ≠ the recovered curve heading once a node carries an explicit tangent.**
  `Handle.theta` only drives the `Auto` arc rule; an explicit tangent's own vector governs the curve
  instead, and nothing re-derives `theta` to track it. An op that needs the curve's actual
  *direction* — the append/reflect seed, a split/join section boundary — must read the real exit
  (`exitHeading` for append/extend, `headExit` for split/join: the section's recovered geometric
  exit, `evalGeo(...).exit`), never `Handle.theta`, or it re-frames the downstream shape by however
  far the two have drifted apart (`tests/ops.test.ts`'s split/join world-curve pins guard this).
- **`sampleChain` per-edge ds is the exact chord.** `dsArr[i] = |P_{i+1} − P_i|`. A near-coincident
  segment or `MAX_SAMPLES` truncation commits the prefix + orphans trailing nodes.
- **A force section's exit is the geometry-RECOVERED state, not the integrator's.** `evalForce`
  integrates, then re-runs `forces` and reads the exit off THAT — so a force section joins the next
  section at the visible-tangent heading, matching a geo section. Don't thread the raw integrator
  `theta`/`v` as the exit (it would introduce an O(ds) heading kink at the boundary).
- **Chain sections share the boundary sample.** `chain` copies each section's points `1..edges`
  (point 0 is the prior section's exit, already written). The shared index carries the prior exit
  state, which is exactly this section's placement — C0/C1 by construction. Don't double-write it.
- **Forward clamps are non-differentiable.** `vSafe` / `sqrt` kink at the boundary. The floor is
  tiny, so coasting past an infeasible region behaves like "cart paused at peak then continued."
  What may and may not certify that cliff: the clamp-gradient law, above.
- **While pin mode is open, every `history.record` redirects into the mode's sandbox** —
  by design (the sandbox contract: nothing applies to the outer stacks until Solve). The ONE
  outer write, the Solve landing, goes through `history.recordOuter`; don't "simplify" it back to
  `record`, and don't rely on call ordering to land outer. The sandbox is also **exempt from
  `MAX_UNDO` eviction** — Exit discards by replaying every entry's reverse and the landing
  freezes the stacks whole, so evicting one silently breaks both byte-identity guarantees; it's
  bounded by the mode's lifetime instead.
- **A Solve result may only land while its own session is still open.** `runPinSection`
  checks `editor.pinning === session` after the await and discards as `StalePin`
  otherwise — the no-trace guarantee is this module invariant, not the UI's inert/Escape paths.
  Same family: the lock ledger is frozen at invoke (`endPin` clears the live Set in place).
- **Tick-derived `editor.*` reads lag a frame.** Svelte components read the plain `editor`
  singleton through `$derived` of the per-RAF `tick` prop, so an `$effect` gated on such a value
  outlives the real state change by up to a frame. Where the lagging listener *swallows*
  (capture-phase + `stopImmediatePropagation`) or is non-idempotent, that lag is a defect: make
  the listener permanent (`onMount`) and early-return on the live `editor.*` field. All three
  menus (node, section ctx, Timeline force) wear this shape — it's the dismissal standard a new
  menu copies, and the solve modal's key gate (`editor.converting`) is the fourth instance. A
  lagging listener that only re-calls an idempotent close is tolerable. Its twin on the read side:
  a tick-derived read must hand back PRIMITIVES, never a mutated object — the modal's progress is
  rewritten in place, so a `$derived` returning that same reference compares `===` equal and the
  surface never updates.

## Test tiers

`bun test` is the whole default gate (~14 s, 1454 tests) and it runs every time. The corpus-scale
`.oracle.ts` files sit outside it and are **run explicitly by path, exactly like the labs** — no
`package.json` script, no composite. Run the one whose kernel you touched:

| oracle | gates | cost |
|---|---|---|
| `bun test ./tests/roundtrip.oracle.ts` | the document layer: `geoforce.ts` + `forcegeo.ts` round trips | ~28 s |
| `bun test ./tests/refine.oracle.ts` | `refine.ts` — geo→force, corpus-wide | ~23 s |
| `bun test ./tests/convert.oracle.ts` | `convert.ts` — the worker pool driven over the corpus | ~20 s |
| `bun test ./tests/forcegeo.oracle.ts` | `geofit.ts` — the force→geo dual-budget fit | ~2 s |
| `bun test ./tests/polish.oracle.ts` | `polish.ts` / `fit.ts` — full-free corpus, field-wise against a stamp-matched golden | ~1 s |
| `bun test ./tests/optimize.oracle.ts` | `optimize.ts` — the corpus-scale solve claims | <1 s |

The `./` prefix is load-bearing — a bare path is a name filter to bun and silently matches nothing.

All six cost ~74 s against the default gate's 14 s, so they are never a routine pre-commit sweep.
**Every oracle has a fast-tier sentinel sibling** (`convert.test.ts`, `refine.test.ts`,
`roundtrip.test.ts`, …) hitting the same kernel on a mini-corpus against the same frozen fixture, so
a kernel edit still fails in seconds without the oracle; the oracle confirms the corpus-wide claim,
and only its own kernel's edit can move it. A commit touching menus, UI, or the ECS layer runs
`bun test` alone. Physics is gated against an **independent** oracle, not self-consistency:
`tests/oracles/rk4.ts` is a time-parameterized RK4 (a different scheme *and* parameterization),
and `tests/helpers/forward64.ts` is the f64 mirror the f32 path is measured against.

The ECS + substrate layers are covered device-free — `tests/section.test.ts` (the substrate),
`tests/track.test.ts` + `tests/cart.test.ts` (`BakeSystem`, cart on a bare `State`). The
`tests/setup.ts` enum-shim preload (`bunfig.toml`) lets them import the shallot barrel with no GPU
device; the unit suite is canvas2D + device-free, with no real-GPU leg. The real-GPU leg is the
capture harness alone (`.claude/rules/kex2d-harness.md`).

**A test touching a structural or domain op re-resolves its sections by stable `order`, never by a
held eid.** `convertDomain` lands through a whole-track snapshot restore, so an eid captured before
it addresses nothing after; a test that held one read `Section.length` as 0 and looked like a physics
bug. Same for split/join/delete, which renumber the chain.

`render.ts` is covered the same device-free way through `tests/helpers/recording-ctx.ts` — a
recording `CanvasRenderingContext2D` double that snapshots `strokeStyle`/`fillStyle`/`lineWidth`/
`globalAlpha` at the instant each draw method fires, with a real `save()`/`restore()` style stack.
It pins style at the draw call, never geometry — a knob drawn at the wrong position with the right
color is invisible to it, and that stays the capture harness's job. The convention it implies:
draw systems export from `render.ts` so the harness can reach them (`AnchorDrawSystem`,
`TangentDrawSystem` today). `tests/render.test.ts` is its first consumer.

**A structural op's exactness pin samples the pre-op observable across the whole extent**, never
the op's own helper at one boundary. Two mutants proved the boundary-only form vacuous on Cut: the
op's inverse-facing half is the untested half, and the pre-op bake is the only independent truth.
Same family as `coding.md`'s "a check that re-derives the rule it checks." The shape that holds:
sample both halves' authored profile across the ORIGINAL extent and assert f32-identity to the
pre-cut sample. On baked geometry the bound is the two discretizations' own disagreement, derived
from `ds` and the extent (each half resolves its own `(edges, ds)` from its own length through
`profile.resolveStep`, so the halves' σ grids restart at the cut on a step of their own), never an
absolute number. The vacuity has a second face: a dedupe test that
asserts the authored `{s, g}` list and never the sampled profile misses everything the payload
doesn't carry, which is how the join's ease defect stayed green through every gate.

**Two suites split by what they import, not by feature.** `tests/optimize.test.ts` is the KERNEL
suite — it reaches `optimize.ts`/`profile`/`section` only. `tests/pin.test.ts` is the mode's
**document-seam** suite (`State`, `editor`, `history`): `runPinSection`'s guards, the lock toggle,
the sandbox, the downstream freeze, and the grep sentinel over the Pin/solver naming boundary. They
shared a filename until the rename found the seam; keep a new test on the side its imports put it.
`tests/menu.test.ts` is the menus' whole gate — the per-builder characterization pins, the grammar
oracle over every builder × its full state matrix, the `checked` registry and binding tables, the
naming→behavior bridge against the production factory records, the `acts.ts` homes census, and the
`menus.ts` module-graph walk. `tests/acts.test.ts` is the act layer's own suite — every factory act
driven on a real ECS track, guards included; it tests the record's entry, not the `history` op
underneath (that's `history.test.ts`/`ops.test.ts`).

## Labs

Run explicitly, never part of `bun test` — the kernel-atom / future-tier reference:
`tests/{geometry,collocate,loop,conditioning,fvd,hill,attribution,forcegeo,perf,pool,roundtrip,optimize}.lab.ts`.
Visual counterparts are the canvas2D atom pages the harness captures: `geometry-lab.html`,
`collocate-lab.html`, `loop-lab.html`, `fvd-lab.html`, `fit-lab.html`. `fit-lab.html` is the
conversion tier's own page — it plays back the pipeline's decisions (`playback.ts`) and is where
the tier's output is judged as an authoring surface; its corpus stays a focused test, so the page
solves only the selected scenario. The annotated labs:

- `tests/attribution.lab.ts` — the flat conversion tier's authoring-floor sweep; its own header
  carries the readings.
- `tests/forcegeo.lab.ts` — the force→geo fit's own sweep + timing.
- `tests/perf.lab.ts` — the conversion perf baseline: probe counts + wall time over the corpus
  plus `tests/helpers/stress.ts`'s scenarios — deliberately not corpus members, so the 80-key
  lock is untouched.
- `tests/pool.lab.ts` — the stress scenarios through the worker pool: sync vs pooled wall time
  and cancel latency, each row checked against the golden.
- `tests/optimize.lab.ts` — the optimize solver's conditioning + norm lab (cost re-baseline,
  the f32 replay floor the relative TOL derives from, attainable tolerance, scaled-Jacobian
  conditioning on the pre-named suspects, uniform-vs-Gram distribution) — the evidence base for
  the refusal certificates and the derived floor.
- `tests/conditioning.lab.ts` — the older single-shoot anchoring probe (endpoint-Jacobian growth
  vs track length), kept as the conditioning reference the optimize lab extends.
- `tests/roundtrip.lab.ts` — the geo→force→geo KERNEL-seam yardstick: node inflation, force
  flip-density, max force divergence per corpus scenario; its baseline reproduces the 2026-07-29
  check-in's hand readings, so the metric is what any dialect change is judged against. It never
  sees provenance (the document-layer identity sweep is `tests/roundtrip.oracle.ts`, above).

## References

- **kexedit forward integrator** — `packages/core/src/sim/`. The 3D physics reference. `forward.ts`
  is the 2D forward direction (F_n → positions); `invertRange` is its reverse. Core's node model:
  `nodes/force.rs` is F_n-driven, `nodes/geometric.rs` rate-driven, `track/dispatch.rs::finalize` is
  the section entry-propagation contract `section.ts` mirrors, `copy_path.rs` is the rigid-transform
  replay `evalGeo`'s placement mirrors, `sim/curvature.rs::from_frames` is quaternion-log curvature
  for the 3D port.
- **Houdini / Blender modifier stack** — analogue for lossy bake from parametric authoring into
  canonical dense state.
- **Witkin & Kass 1988, Spacetime Constraints** — parameter-space trajectory optimization with sparse
  user constraints; a reference for later general optimization tools.
