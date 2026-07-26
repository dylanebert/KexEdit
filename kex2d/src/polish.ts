/** the CONSTRAINED POLISH: a sparse force profile whose *integrated* geometry matches
 *  the geometry it came from, with the exit pinned. the geo→force spike's stage 3
 *  (`specs/kex2d-geoforce-spike.md`) — pure, framework-free, f64, kernel-atom family
 *  (`force.ts`, `banded.ts`, `collocate.ts`), NOT on the live path.
 *
 *  stage 2 (`fit.ts`) fits force to the dense recovered curve. That is not a convert:
 *  force error integrates twice, so a 0.033 g fit can land 39.7 m off. This step closes
 *  the geometry instead, in the ALL-LOCAL (collocation) formulation.
 *
 *  **variables.** the sparse profile's continuous DOF — every keyframe's `g` plus its
 *  shaping, `3K − 2` of them in the free family and `2K` in the authorable one
 *  (`HandleDof`) — AND a dense state spine `(x_j, y_j, θ_j)`,
 *  `j = 1..E`, over the uniform grid a force section integrates on. Speed is not a
 *  variable: the integrator's energy step telescopes exactly, so `v²_j = v₀² − 2g(y_j −
 *  y₀)` is an identity, not a constraint. Keyframe **s stays fixed** — placement is
 *  authoring vocabulary (discrete, snapped), shaping is continuous (the easing-layering
 *  law). Fixing s is also what makes the profile→force map linear (below).
 *
 *  **constraints, all local.** one forward-integrator step per edge, as a defect:
 *
 *    C_x,j = x_{j+1} − x_j − h·cos ½(θ_j + θ_{j+1})
 *    C_y,j = y_{j+1} − y_j − h·sin ½(θ_j + θ_{j+1})
 *    C_θ,j = Λ·(θ_{j+1} − θ_j − (F_j − cos θ_j)·g·h / v²_j)
 *
 *  plus the hard exit equality on the LAST state (x, y, θ — v follows from y). The heading
 *  half of that equality is written in the RECOVERED convention, not the integrator's, so
 *  it pins the quantity a downstream section actually consumes (`exitTheta` below). That is
 *  what the formulation buys: "the exit depends recursively on everything before it"
 *  becomes one rule on one variable, and the spine's warm start is the TARGET GEOMETRY
 *  itself, so a warm start that shoots 39.7 m away never appears — its error lives in
 *  the θ defects at the spike, which the AL drives out. There is no shooting anywhere in
 *  the loop (`tests/conditioning.lab.ts`: σ(∂P/∂F) ~ N^1.54 through the integrator vs
 *  N^0.00 for positions).
 *
 *  **Λ = the section length.** a heading defect δ at step j rotates everything after it,
 *  displacing the exit by up to L·δ, while a position defect displaces it by exactly
 *  itself — so scaling the heading defect by L puts every constraint in
 *  position-equivalent metres under ONE ρ and ONE tolerance. Derived from the defects'
 *  downstream reach, not tuned.
 *
 *  **loss = geometry tracking**, `½ Σ h·|P_j − P*_j|²` against the ORIGINAL BAKED
 *  positions resampled at uniform arclength (`spine`). Never against force: stage 2
 *  measured that most of a fit's geometry error is the representation round-trip
 *  (cumulative-chord σ vs `forceProfile`'s uniform grid, 0.04–7.02 m even at a keyframe
 *  per sample), and a geometry loss absorbs that by construction instead of chasing it.
 *  `h` is the interval measure, so the discrete loss approximates one continuum integral
 *  at any grid resolution (`collocate.ts`'s weight semantics).
 *
 *  **the profile→force map is exactly linear and measured, not re-derived.** Fixing every
 *  `s` is the whole reason: a dense sample's bracketing segment, its bezier parameter `t`,
 *  and `segment`'s x-monotonicity clamp factors (`d1`/`d2`/`f`/`sc1`/`sc2`) are ALL
 *  functions of the s-coordinates alone, and the values enter as `p1g = g_a + sc1·Δg_a`,
 *  `p2g = g_b + sc2·Δg_b` inside a bezier that is linear in its control values. So `F_j`
 *  is a linear form in the DOF whichever branch of the clamp fires — a clamped or
 *  backward-pointing handle is just a different constant scale factor, never a
 *  nonlinearity. (The clamp staying cold on this corpus is a property `fit.ts` hands us,
 *  not a precondition of anything here.) The matrix is built by PROBING
 *  `profile.sampleForce` with one unit DOF at a time, so the solver's force model IS the
 *  production evaluator (it cannot drift from it) and the bezier algebra is written once,
 *  in `profile.ts`.
 *
 *  **solver: LM Gauss-Newton inside a PHR augmented Lagrangian** — `collocate.ts`'s
 *  pattern with equality constraints in place of its band hinge (shift `λ/ρ`, update
 *  `λ ← λ + ρ·C`, ρ escalates only on a stalled outer). Exact feasibility at finite ρ;
 *  a plain penalty would have to be cranked until the normal system stiffened. The
 *  normal system is `[H_ss H_sp; H_spᵀ H_pp]`: the state block is symmetric banded
 *  (half-bandwidth 6 — a defect touches two adjacent 3-var blocks, which is the 5
 *  `collocate.ts` assembles, and the recovered exit heading reaches one block further
 *  back), and the profile block is small, so one Schur complement over the state band
 *  solves it. Both factorizations are `banded.ts` — the state band at b = 6, the P×P
 *  Schur block at b = P−1 (a general dense LDLᵀ). No new linear algebra.
 *
 *  **the v² barrier.** the model divides by the raw `v²` (smooth, the differentiability
 *  win — `force.ts` makes the same choice) where the shipped integrator clamps
 *  `vSafe = max(|v|, V_FLOOR)`. A trial step that drives `v²` under that floor is
 *  REJECTED (Φ = ∞) rather than clamped: the clamp is non-differentiable, and a coaster
 *  that stalls is not a geometry the polish should be exploring.
 *
 *  ---
 *
 *  **two independent axes.** `handles` picks the DOF family the solve lives in — the free
 *  independent-handle one or the authorable aligned one (`HandleDof`, which is where that
 *  choice is argued). `mode` picks the stopping rule and the prior. They are orthogonal on
 *  purpose: holding one fixed while flipping the other is how a change in the output's
 *  violence or its vocabulary census gets attributed to the right cause.
 *
 *  **two modes.** `"exact"` (the default) drives the geometry to the numeric floor — it
 *  is the oracle that proves the formulation reaches f32 resolution, and nothing about it
 *  changes when calm mode is asked for. But the last decade of that descent buys geometry
 *  no author can see and pays for it in violent handles: the inverse problem is ill-posed
 *  near the floor, many profiles draw the same shape to within f32, and a pure tracking
 *  loss has no reason to prefer the calm one. `"calm"` is the standard fix, both halves of
 *  it (Hansen, *Discrete Inverse Problems*, ch. 4–5):
 *
 *  **(i) discrepancy-principle stopping.** The tracking target loosens from the numeric
 *  floor to `authoringFloor` — the discretization mismatch the integrator cannot remove
 *  (a calibrated proxy, see `chordDeficit`) plus the 0.05 m the readout resolves to. Below
 *  that the geometry residual is mostly noise, and Morozov says stop rather than fit it.
 *
 *  **(ii) a fairing seminorm on the profile.** `½·λ·∫(F″)² ds` — the smoothing-spline
 *  penalty (Green & Silverman, *Nonparametric Regression and Generalized Linear Models*,
 *  ch. 2), the standard roughness operator for a curve over fixed knots, and here an exact
 *  closed-form quadratic in the DOF (`fairRows`). It replaced a flat `Σ Δg² → 0` Tikhonov
 *  block, which was a cruder statement of the same wish and priced the wrong thing: a zero
 *  Δg is a FLAT tangent, so that prior pulled every segment toward one named tag
 *  (`Easing.Cubic` at the fit's span/3 reach) and 4 of the 10 corpus scenarios saturated
 *  to all-Cubic — an artifact of the operator, not of the curves wanting flatness. The
 *  fairing seminorm penalizes CURVATURE, so its null space is the profiles that are
 *  piecewise-linear in s: a ramp, a hold, and every straight transition between them cost
 *  nothing, and only genuine bending is priced. It is also the right operator rather than
 *  distance-from-the-observed-dense-curve: the observation IS the violent thing on a spike
 *  scenario (valley-explicit's dense recovered curve peaks at 38 g), so pulling toward it
 *  pulls toward the spike. F is linear in the DOF in EITHER family, so the penalty is
 *  exactly quadratic — two residual rows per SEGMENT, landing in the existing
 *  `H_pp`/`rhsP` blocks. No new linear algebra, no cross terms, no change to the state band.
 *
 *  **λ by the discrepancy principle**, never a constant: log-bisection over a FIXED bracket
 *  for the largest λ whose solve still holds the floor, keeping only solves verified
 *  against it — deviation(λ) is only *approximately* monotone here (the problem is
 *  nonlinear), and a non-monotone blip then costs optimality of λ, never the contract.
 *  Read `lambda` with the bracket in mind: `LAM_MAX` means the search saturated (the whole
 *  handle family is already inside the floor) and `0` means it found no slack at all —
 *  neither is a located discrepancy point. `heldFloor` is the field that says whether the
 *  answer actually reached the target. The exit pin stays HARD in both modes: closing the
 *  exit is cheap, and the violence never came from it. */

import { bandFactor, bandSolve, bandStore } from "./banded";
import { V_FLOOR } from "./forward";
import { type ForcePoint, forceProfile, type Offset, sampleForce } from "./profile";
import type { Entry } from "./section";

const G = 9.80665;

/** the geo bake the polish tracks — a `section.SectionResult` satisfies it. */
export interface Bake {
    posX: ArrayLike<number>;
    posY: ArrayLike<number>;
    theta: ArrayLike<number>;
    ds: ArrayLike<number>;
    edges: number;
}

/** the bake resampled onto the UNIFORM arclength grid a force section integrates on —
 *  the polish's tracking target and its hard exit pin. */
export interface Spine {
    /** edge count of the uniform grid, `round(length/dsNominal)`. */
    edges: number;
    /** the realized edge step `length/edges` (m). */
    ds: number;
    /** the bake's total arclength (m) — the force section's extent. */
    length: number;
    /** target positions + heading, length `edges + 1`; index 0 is the entry, `edges` the
     *  exit pin. */
    x: Float64Array;
    y: Float64Array;
    theta: Float64Array;
}

/** one playback frame: the profile and the residuals at an accepted step. Deliberately
 *  carries NO geometry — the lab draws each frame's shape by re-integrating that frame's
 *  profile through the live f32 `evalForce` path, which is the thing worth looking at, so
 *  a copy of the solver's own f64 spine would only be a second answer to the same
 *  question. Read `deviation`/`feasibility` for how the spine stands. */
export interface Snapshot {
    /** accepted-step index (frames are decimated, so these are not contiguous). */
    step: number;
    /** AL outer round the step belongs to. */
    outer: number;
    /** the profile at this step. */
    points: ForcePoint[];
    /** the dense force it drives (g), length `edges`. */
    fN: Float32Array;
    /** worst constraint violation, position-equivalent m. */
    feasibility: number;
    /** max |P_j − P*_j| over the spine (m). */
    deviation: number;
    phi: number;
    mu: number;
    rho: number;
}

export interface PolishResult {
    /** the polished sparse profile — load it as a force section with
     *  `forceProfile(points, length, ds)` + `evalForce(entry, …, ds)`. */
    points: ForcePoint[];
    length: number;
    /** the uniform edge step the profile was solved at (`length/edges`). */
    ds: number;
    edges: number;
    /** keyframe count (unchanged from the warm start — the polish moves values, not
     *  placement). */
    keys: number;
    /** accepted LM steps — total across outers AND across every λ the discrepancy search
     *  tried, so it reads as the call's whole cost. `solves` is how many solves that was. */
    iters: number;
    /** how many full solves ran: 1 in exact mode; in calm mode the two bracket probes plus
     *  either the λ = 0 fallback or the `LAM_STEPS` bisection, so at most `LAM_STEPS + 2`. */
    solves: number;
    /** AL outer rounds run by the solve that produced this answer. */
    outers: number;
    /** the contract: worst constraint violation < `tol`. */
    converged: boolean;
    /** worst constraint violation, position-equivalent m. */
    feasibility: number;
    /** exit residual on the solved spine: position gap (m) and heading gap (rad). The
     *  heading is the RECOVERED exit — the bisector-tangent quantity `evalForce` hands the
     *  next section — not the integrator's own θ_E, so this reads the same gap a downstream
     *  section would see. */
    exit: { dx: number; dy: number; dtheta: number; dist: number };
    /** max |spine − target| over the samples (m), and where. */
    deviation: number;
    at: number;
    /** the whole deviation profile the max was taken over, `|P_j − P*_j|` at every spine
     *  sample (m), length `edges + 1`. Index 0 is the pinned entry, so it is exactly 0.
     *  `deviation` is its max and `at` its argmax; this is the same reading resolved per
     *  sample, which is what a refinement loop needs to decide WHERE the residual sits
     *  rather than only how big it is (`refine.ts`). */
    deviations: Float64Array;
    /** final penalty after any escalation. */
    rho: number;
    /** which mode produced this. */
    mode: PolishMode;
    /** which DOF family it was solved in. `"aligned"` output is collinear at every key by
     *  construction (`profile.collinear`, the scale-free claim); it censuses 0 broken on
     *  any surface that draws its handles at a legible size, since `census` also calls a
     *  side too short to show a direction broken. */
    handles: HandleDof;
    /** the keys solved with a broken slope (`Corners`); empty unless the caller asked. Every
     *  one of them censuses `broken` on purpose — that is the discrete state, not a defect. */
    corners: number[];
    /** the fairing weight the answer was solved at. 0 in exact mode; in calm mode, 0 means
     *  the search found no slack at all and fell back — a clip, not a located discrepancy
     *  point. `LAM_MAX` is the clip at the other end, and it is a FREE-family outcome: no
     *  aligned solve on this corpus reaches it (`LAM_MAX`'s note). */
    lambda: number;
    /** the deviation target the discrepancy principle stopped against (m). Reported in
     *  exact mode too, where it is informational — exact stops at the numeric floor. */
    floor: number;
    /** whether `deviation` actually reached `floor`. Calm mode's fallback returns the
     *  tightest geometry available (the λ = 0 solve) when no λ holds the floor, and that
     *  solve can itself miss it — a coarse fit over a bendy shape has nothing below the
     *  floor to return. Check this before reading a calm answer as on-target. */
    heldFloor: boolean;
    /** how violent the answer is, the authoring cost the calm mode trades against. */
    peakG: number;
    maxDg: number;
    /** the target the loss and the pin were measured against. */
    spine: Spine;
    snapshots: Snapshot[];
}

/** `"exact"` drives geometry to the numeric floor (the oracle baseline); `"calm"` stops at
 *  the derived authoring floor and spends the slack on a quiet profile. */
export type PolishMode = "exact" | "calm";

export interface PolishOpts {
    bake: Bake;
    /** the entry the bake was evaluated from; state 0 is pinned here. */
    entry: Entry;
    /** stage-2's `fit().points` — the warm start. Every segment's two sides must carry
     *  explicit handles reaching exactly `span/3` in s (the fit's own shape): that is the
     *  family the fairing prior is closed-form on, and it is enforced (`fairRows`). */
    points: readonly ForcePoint[];
    /** nominal edge step (m); the realized step is `length/round(length/ds)`. */
    ds: number;
    /** feasibility tolerance, position-equivalent m (default `TOL_FEAS`). */
    tol?: number;
    /** AL outer cap (default 24). */
    outers?: number;
    /** LM inner cap per outer (default 60). */
    maxIters?: number;
    /** AL penalty schedule — a schedule parameter, not a tolerance. ρ₀ defaults to
     *  `1e3·ds` (three decades of feasibility priority over the tracking rows, whose
     *  weight is `ds`), escalating by `escalate` on a stalled outer, capped at 1e6·ρ₀. */
    rho0?: number;
    escalate?: number;
    /** playback frame cap (default 120, floor 1); frames past it are decimated by halving. */
    maxSnapshots?: number;
    /** `"exact"` (default) or `"calm"`. */
    mode?: PolishMode;
    /** which DOF the solve carries: `"free"` (default) or the authorable `"aligned"`. */
    handles?: HandleDof;
    /** the keys carrying a broken slope (`Corners`) — aligned mode only, ascending and
     *  interior. Default none, which is the plain aligned family column for column. */
    corners?: Corners;
    /** override the derived authoring floor (m) calm mode stops against; finite and > 0.
     *  For probing the discrepancy principle — at the numeric floor calm mode degenerates
     *  to exact. */
    floor?: number;
    /** skip the λ search and solve calm mode at this fairing weight; finite and >= 0. For
     *  probing the regularizer — at 0 calm mode degenerates to exact. Exact mode ignores
     *  the value but still validates it. */
    lambda?: number;
}

/** feasibility default, position-equivalent m. The live f32 `evalForce` path rounds each
 *  position by ~6e-8·|coord| ≈ 1e-5 m at coaster scale, so a defect at 1e-6 m is already
 *  below what any f32 integration can express — the spine and the true integration of the
 *  same profile agree to within float noise. Derived from the reference path's resolution,
 *  not tuned to the corpus. */
export const TOL_FEAS = 1e-6;

/** the scale at which a geometry error stops being legible on the authoring surface, m —
 *  the perceptual half of the discrepancy level. Every length the editor reports funnels
 *  through `controls.formatLen`, which prints ONE decimal, so the surface resolves lengths
 *  on a 0.1 m quantum and half of one is the coarsest error it could even represent. The
 *  same argument `EXIT_TOL` uses for its ceiling, and no stronger: a half-quantum error
 *  straddling a rounding boundary does move the printed digit, so this is the resolution
 *  of the readout, not a proof of invisibility. Derived from the readout rather than the
 *  manipulator grids, which are per-user configurable (`settings.ts`) and so are not a
 *  floor anything can rest on. */
export const AUTHOR_EPS = 0.05;

/** the chord deficit of a target spine, m: `Σ (ds − |P_{j+1} − P_j|)`.
 *
 *  The geo bake is a polyline with VARIABLE chords (`sampleChain`: 0.214–0.664 m at a 0.5
 *  nominal) and the spine resamples it at uniform ARCLENGTH, so consecutive spine points
 *  sit less than `ds` apart in a straight line wherever the polyline bends between them.
 *  The forward integrator can only lay edges of exact chord `ds`, so that per-edge
 *  shortfall is length it must put somewhere the target never had it.
 *
 *  **Read this as a calibrated proxy, not a bound.** It is EXTENSIVE — a sum over edges,
 *  growing with length and curvature — while the deviation it stands in for is a max over
 *  samples, so the two are related empirically, not by derivation: stage 3 measured the
 *  deficit at 9e-5 m (circular-arc) to 5.4e-2 m (valley-explicit) and found it tracked the
 *  achieved deviation within ~4× across three orders of magnitude. That calibration is
 *  what `authoringFloor` leans on, and on the bendiest corpus scenario the term carries
 *  ~52% of the resulting floor — so a shape far outside the corpus's length/curvature range
 *  is where this would first mislead. */
export function chordDeficit(sp: Spine): number {
    let deficit = 0;
    for (let j = 0; j < sp.edges; j++)
        deficit += sp.ds - Math.hypot(sp.x[j + 1] - sp.x[j], sp.y[j + 1] - sp.y[j]);
    return deficit;
}

/** the deviation target calm mode stops against (m) — the discrepancy level, from two
 *  independent reasons a residual below it carries little information: the discretization
 *  mismatch the integrator cannot remove (`chordDeficit`, a proxy calibrated on stage 3's
 *  measurements — see its caveat) and the resolution of the surface that would show it
 *  (`AUTHOR_EPS`, derived outright). Independent error sources, so they add. No term is
 *  fitted to a target deviation, but the deficit term's SCALE is corpus-calibrated. */
export function authoringFloor(sp: Spine): number {
    return chordDeficit(sp) + AUTHOR_EPS;
}

/** how violent a profile is to author: the peak of the dense force it drives (g) and the
 *  largest handle offset in it (g). The dense peak is the one that catches INTER-KEY
 *  overshoot — valley-explicit's polished keys span [−6.5, 2.6] g while the curve between
 *  them reaches 40 g, invisible in the diamonds. */
export function violence(
    points: readonly ForcePoint[],
    length: number,
    ds: number,
): { peakG: number; maxDg: number } {
    const fN = forceProfile(points, length, ds);
    let peakG = 0;
    for (let j = 0; j < fN.length; j++) peakG = Math.max(peakG, Math.abs(fN[j]));
    let maxDg = 0;
    for (const p of points) {
        if (p.in) maxDg = Math.max(maxDg, Math.abs(p.in.dg));
        if (p.out) maxDg = Math.max(maxDg, Math.abs(p.out.dg));
    }
    return { peakG, maxDg };
}

/** how far a handle's s-reach may sit from `span/3` and still count as the family the
 *  fairing energy is closed-form on, RELATIVE to the span. `fit.ts` builds each reach as
 *  `(s_b − s_a)/3` out of the same two f64 s-values this check subtracts, so a warm start
 *  from there matches bit-exactly; the slack is for a caller that reached the same number
 *  by a different route. Eight f64 roundings — each ≤ ½ ulp — is a generous count for any
 *  such route, and the nearest reach anyone would actually author sits span/12 away (a
 *  quarter-span handle), fourteen orders above this bar. So the guard can neither fire on
 *  rounding nor miss a real departure. */
const REACH_EPS = 8 * Number.EPSILON;

/** the λ bracket the discrepancy search bisects, in the units `lambda` carries (m⁶/g²: a
 *  profile of rms curvature `c` g/m² costs as much as `√λ·c` metres of rms deviation). The
 *  span is deliberately wide of the interesting decade at both ends — this corpus accepts λ
 *  between 2e-6 and 8e+1, the two DOF families several decades apart, since the aligned
 *  family's much smaller null space (one slope serving both of a key's segments) makes a
 *  given λ bite harder. `LAM_MIN` is weaker than any regularization worth the name.
 *
 *  `LAM_MAX` is argued safe-by-construction for the FREE family, and only there: it reaches
 *  that family's seminorm NULL SPACE — four free-mode scenarios clip at the top with their
 *  roughness at or below 1e-7 of the warm start's, and a seminorm cannot go under zero, so
 *  a wider top would buy nothing. The aligned family has no such argument. Its null space is
 *  2-D (one slope per key, so only a globally straight profile is free), which no aligned
 *  solve can reach while holding the floor: the largest λ this corpus accepts there is
 *  8.4e+1, 1.1 decades short of the top, pinned in `polish.test.ts`. If an aligned solve
 *  ever did clip, its λ would be a bracket artifact and the top would need re-arguing. */
const LAM_MIN = 1e-9;
const LAM_MAX = 1e3;

/** log-bisection steps inside the bracket. 12 decades halved 8 times leaves λ located to
 *  0.047 decades — 11%, well inside the precision the discrepancy principle means. */
const LAM_STEPS = 8;

/** resample a bake onto the uniform arclength grid a force section integrates on. The
 *  bake IS a polyline, so linear interpolation along its chords is exact — no smoothing
 *  and no drift. The grid spans the bake's arclength EXACTLY (`ds = length/edges` rather
 *  than the nominal step) because the exit pin is meaningless otherwise: a section that
 *  ends `round(L/ds)·ds − L` short of the shape it reproduces is being asked to end
 *  somewhere the original never was. */
export function spine(bake: Bake, dsNominal: number): Spine {
    const eb = bake.edges;
    if (!(eb >= 2)) throw new Error(`spine: need >= 2 baked edges, got ${eb}`);
    if (!(dsNominal > 0) || !Number.isFinite(dsNominal))
        throw new Error(`spine: ds must be > 0, got ${dsNominal}`);
    const sigma = new Float64Array(eb + 1);
    for (let i = 0; i < eb; i++) {
        const d = bake.ds[i];
        if (!(d > 0) || !Number.isFinite(d)) throw new Error(`spine: ds[${i}] is ${d}`);
        sigma[i + 1] = sigma[i] + d;
    }
    for (let i = 0; i <= eb; i++) {
        if (!Number.isFinite(bake.posX[i]) || !Number.isFinite(bake.posY[i]))
            throw new Error(`spine: bake position ${i} is not finite`);
        if (!Number.isFinite(bake.theta[i]))
            throw new Error(`spine: bake theta ${i} is not finite`);
    }
    const length = sigma[eb];
    const edges = Math.max(1, Math.round(length / dsNominal));
    const ds = length / edges;
    const x = new Float64Array(edges + 1);
    const y = new Float64Array(edges + 1);
    const theta = new Float64Array(edges + 1);
    let i = 0;
    for (let j = 0; j <= edges; j++) {
        const a = j === edges ? length : j * ds;
        while (i < eb - 1 && sigma[i + 1] < a) i++;
        const span = sigma[i + 1] - sigma[i];
        const t = span > 0 ? Math.min(1, Math.max(0, (a - sigma[i]) / span)) : 0;
        x[j] = bake.posX[i] + t * (bake.posX[i + 1] - bake.posX[i]);
        y[j] = bake.posY[i] + t * (bake.posY[i + 1] - bake.posY[i]);
        theta[j] = bake.theta[i] + t * (bake.theta[i + 1] - bake.theta[i]);
    }
    return { edges, ds, length, x, y, theta };
}

/** which continuous DOF the solve carries per keyframe.
 *
 *  `"free"` (the default) is the full independent-handle family — `3K − 2`: every
 *  keyframe's `g`, then every handle's Δg. The vocabulary `fit.ts` warm-starts in, and
 *  the one that reaches the numeric floor, so it stays the oracle baseline.
 *
 *  `"aligned"` is the AUTHORABLE family — `2K`: every keyframe's `g`, then ONE SLOPE `m`
 *  per key, both sides' offsets derived as `Δg = m·Δs` (each side's Δs is fixed by the
 *  warm start, as every `s` in this solve is). The two handles are then collinear through
 *  the key by construction, so a BROKEN key — the editor's `Free` shape, the ugliness the
 *  spike's check-in could see but not name — is *unrepresentable* rather than penalized.
 *  A soft alignment penalty would not do: "almost aligned" still censuses and still reads
 *  broken in the menu, because the vocabulary is discrete. Broken stays expressible, as an
 *  explicit per-key corner the refine loop introduces — never something a continuous
 *  solve wanders into.
 *
 *  The reparameterization is LINEAR, so `F = A·dof` and every piece of machinery below
 *  carries over untouched; only the matrix's columns change. */
export type HandleDof = "free" | "aligned";

/** the CORNER set: which keys carry a broken (per-side independent) slope inside the
 *  aligned family — the explicit discrete state the vocabulary reserves for a genuine
 *  slope discontinuity, and the one `HandleDof` calls unrepresentable by the continuous
 *  solve. Entries are key indices, strictly ascending, and INTERIOR (0 and `K − 1` carry
 *  one side each, so there is nothing there to break).
 *
 *  A corner adds exactly one DOF: the key's `out` side keeps the base slope `m_k` and its
 *  `in` side gets its own, appended after the `2K` base DOF in corner order. So an empty
 *  corner set reproduces the plain aligned layout column for column — the refine loop's
 *  discrete state cannot perturb a fixed-knot solve that has no corners.
 *
 *  Free mode takes no corners: its handles are already independent per side. */
export type Corners = readonly number[];

/** which DOF drives each key's `in`/`out` handle in the aligned family. `out` is always the
 *  key's own base slope; `in` is the same slope unless the key is a corner, in which case
 *  it is that corner's appended DOF. */
function slopeSlots(keys: number, corners: Corners): { inSlot: Int32Array; outSlot: Int32Array } {
    const inSlot = new Int32Array(keys);
    const outSlot = new Int32Array(keys);
    for (let k = 0; k < keys; k++) {
        inSlot[k] = keys + k;
        outSlot[k] = keys + k;
    }
    for (let r = 0; r < corners.length; r++) inSlot[corners[r]] = 2 * keys + r;
    return { inSlot, outSlot };
}

function dofCount(keys: number, handles: HandleDof, corners: Corners = []): number {
    return handles === "aligned" ? 2 * keys + corners.length : 3 * keys - 2;
}

/** the profile with every value zeroed and every handle's Δs kept — the shell a DOF
 *  vector is written into and probed through. */
function shell(pts: readonly ForcePoint[]): ForcePoint[] {
    const out: ForcePoint[] = [];
    for (const p of pts) {
        const q: ForcePoint = { s: p.s, g: 0 };
        if (p.in) q.in = { ds: p.in.ds, dg: 0 };
        if (p.out) q.out = { ds: p.out.ds, dg: 0 };
        out.push(q);
    }
    return out;
}

/** the DOF vector a warm start reads as. Free mode copies its values out (layout: `g_k`,
 *  k = 0..K−1, then `out_k.dg`, k = 0..K−2, then `in_k.dg`, k = 1..K−1).
 *
 *  Aligned mode (layout: `g_k` then `m_k`, both k = 0..K−1) has to PROJECT: a fit's two
 *  sides are independent and generally not collinear, so each key's slope is the
 *  least-squares fit `m = Σ Δs·Δg / Σ Δs²` over the sides that SHARE it — Δg measured in
 *  the metric the fairing rows carry, so the warm start is the closest profile the aligned
 *  family holds rather than an arbitrary one. A corner's two sides no longer share a slope,
 *  so each projects alone and the projection is exact there. A slot whose sides all have
 *  Δs = 0 carries no shape in this vocabulary at all: its `m` is unidentifiable, starts at
 *  0, and the LM damping leaves it there. */
export function readDof(
    pts: readonly ForcePoint[],
    handles: HandleDof,
    corners: Corners = [],
): Float64Array {
    const K = pts.length;
    const P = dofCount(K, handles, corners);
    const dof = new Float64Array(P);
    for (let k = 0; k < K; k++) dof[k] = pts[k].g;
    if (handles === "free") {
        for (let k = 0; k + 1 < K; k++) dof[K + k] = pts[k].out?.dg ?? 0;
        for (let k = 1; k < K; k++) dof[2 * K - 1 + (k - 1)] = pts[k].in?.dg ?? 0;
        return dof;
    }
    const { inSlot, outSlot } = slopeSlots(K, corners);
    const num = new Float64Array(P);
    const den = new Float64Array(P);
    for (let k = 0; k < K; k++)
        for (const [side, p] of [
            [pts[k].in, inSlot[k]],
            [pts[k].out, outSlot[k]],
        ] as [Offset | undefined, number][]) {
            if (!side) continue;
            num[p] += side.ds * side.dg;
            den[p] += side.ds * side.ds;
        }
    for (let p = K; p < P; p++) dof[p] = den[p] > 0 ? num[p] / den[p] : 0;
    return dof;
}

/** the profile a DOF vector materializes, in `profile.ts`'s representation — the inverse
 *  of `readDof`, and the ONE place the aligned family's `Δg = m·Δs` construction lives. A
 *  side the warm start left absent stays absent, so the returned profile carries exactly
 *  the shape the warm start's handles did. */
export function applyDof(
    pts: readonly ForcePoint[],
    handles: HandleDof,
    dof: ArrayLike<number>,
    corners: Corners = [],
): ForcePoint[] {
    const K = pts.length;
    const need = dofCount(K, handles, corners);
    if (dof.length !== need)
        throw new Error(`applyDof: ${handles} over ${K} keys takes ${need} dof, got ${dof.length}`);
    const out = shell(pts);
    for (let k = 0; k < K; k++) out[k].g = dof[k];
    if (handles === "free") {
        for (let k = 0; k + 1 < K; k++) if (out[k].out) (out[k].out as Offset).dg = dof[K + k];
        for (let k = 1; k < K; k++)
            if (out[k].in) (out[k].in as Offset).dg = dof[2 * K - 1 + (k - 1)];
        return out;
    }
    const { inSlot, outSlot } = slopeSlots(K, corners);
    for (let k = 0; k < K; k++) {
        const i = out[k].in;
        const o = out[k].out;
        if (i) i.dg = dof[inSlot[k]] * i.ds;
        if (o) o.dg = dof[outSlot[k]] * o.ds;
    }
    return out;
}

/** the profile→force map, PROBED through the production evaluator: column `p` is the
 *  dense force one unit of DOF `p` drives on the uniform grid, so `F = A·dof` exactly
 *  (linear in the DOF once every `s` is fixed — see the module note). Probing rather than
 *  re-deriving is what makes the solver's force model BE the shipped evaluator, so the two
 *  cannot drift; the bezier algebra is written once, in `profile.ts`. */
export function forceMatrix(
    pts: readonly ForcePoint[],
    handles: HandleDof,
    edges: number,
    ds: number,
    corners: Corners = [],
): Float64Array[] {
    const P = dofCount(pts.length, handles, corners);
    const unit = new Float64Array(P);
    const A: Float64Array[] = [];
    for (let p = 0; p < P; p++) {
        unit[p] = 1;
        const probe = applyDof(pts, handles, unit, corners);
        unit[p] = 0;
        const col = new Float64Array(edges);
        for (let j = 0; j < edges; j++) col[j] = sampleForce(probe, j * ds);
        A.push(col);
    }
    return A;
}

/** one row of the fairing seminorm's square root: the DOF the row reads (`p`) and their
 *  coefficients (`c`), so the row's value is `Σ c·dof[p]` and the sum of the rows' squares
 *  is the seminorm itself. */
export interface FairRow {
    p: number[];
    c: number[];
}

/** the FAIRING SEMINORM as rows: `∫(F″)² ds` written as a sum of squared linear forms in
 *  the DOF, two rows per segment, closed-form and derived rather than tuned.
 *
 *  **The energy.** Over one segment the profile is the cubic bezier `profile.segment`
 *  resolves, and the fit family's handles reach exactly `span/3` in s (`fit.ts`), so `s(t)`
 *  is linear in the bezier parameter and F is an ordinary cubic in s. In the Bernstein
 *  basis with controls `P₀ = g_a`, `P₁ = g_a + Δg_out`, `P₂ = g_b + Δg_in`, `P₃ = g_b`,
 *  writing `x = (s − s_a)/span`:
 *
 *    span²·F″ = 6[(1 − x)·A + x·B],   A = P₀ − 2P₁ + P₂,   B = P₁ − 2P₂ + P₃
 *    ∫₀^span (F″)² ds = span^(−3)·∫₀¹ 36[(1 − x)A + xB]² dx = 12·(A² + AB + B²)/span³
 *
 *  and `A² + AB + B² = ¾(A + B)² + ¼(A − B)²` — the exact Cholesky of `[[1, ½], [½, 1]]`,
 *  so the segment's energy is a sum of two squares and lands as two Gauss-Newton residual
 *  rows. Substituting `A + B = −(Δg_out + Δg_in)` and `A − B = 2(g_b − g_a) −
 *  3(Δg_out − Δg_in)`, with `c = √(12/span³)`:
 *
 *    r_sum   = c·(√3/2)·(Δg_out + Δg_in)
 *    r_chord = c·((g_b − g_a) − 1.5·(Δg_out − Δg_in))
 *
 *  **What it prices.** `r_chord` vanishes exactly when both handles lie along the segment's
 *  chord and `r_sum` when they oppose; both vanish together iff F″ ≡ 0 there. So the null
 *  space is the profiles that are LINEAR in s on each segment — a ramp, a hold, and any
 *  straight transition are free, and only bending is paid for (Green & Silverman's
 *  unbiased-for-the-linear-trend property). That is the whole point of replacing the flat
 *  `Δg → 0` block, whose null space was a single named tag.
 *
 *  In the ALIGNED family the null space is far smaller: one slope serves both of a key's
 *  segments, so a piecewise-linear profile with a slope break at a key is unrepresentable
 *  and only a globally straight one costs nothing.
 *
 *  **Both families, one price.** `∂Δg/∂dof` is 1 in the free family (a Δg IS a DOF) and
 *  that side's Δs in the aligned one (`Δg = m·Δs`, chain rule), so λ prices the same
 *  function of the PROFILE either way — which is what lets a metric change be attributed to
 *  the DOF restriction rather than to a silently different prior.
 *
 *  **DOMAIN: the span/3 reach family, and nothing else.** A handle that reaches something
 *  other than `span/3` makes `s(t)` nonlinear, F(s) non-polynomial, and this form prices
 *  the chord-parameterized cubic through the same four control values instead of the true
 *  `∫(F″)² ds`. It stays a valid PSD roughness prior on the same DOF — it just no longer
 *  measures the quantity its name claims, and it does so silently: measured under-price of
 *  several-fold at a span/10 reach, and a strictly straight `Easing.Linear` segment (reach
 *  0, chord-aligned Δg) priced as bent. `polish` REFUSES an off-family warm start at the
 *  boundary for that reason (`REACH_EPS`); a caller outside the family — stage 4's
 *  quantizer, whose named tags leave it by construction — must integrate `(F″)²`
 *  numerically instead of calling this. A side the warm start left absent carries no DOF
 *  term: `segment` substitutes a flat derived tangent there, Δg = 0. */
export function fairRows(
    pts: readonly ForcePoint[],
    handles: HandleDof,
    corners: Corners = [],
): FairRow[] {
    const K = pts.length;
    const { inSlot, outSlot } = slopeSlots(K, corners);
    const rows: FairRow[] = [];
    for (let k = 0; k + 1 < K; k++) {
        const a = pts[k];
        const b = pts[k + 1];
        const span = b.s - a.s;
        if (!(span > 0)) continue;
        const c = Math.sqrt(12 / (span * span * span));
        const sum: FairRow = { p: [], c: [] };
        const chord: FairRow = { p: [k, k + 1], c: [-c, c] };
        // `coef` is ∂Δg/∂dof for that side: 1 where a Δg IS the DOF, that side's Δs where
        // a slope drives it. A corner routes only its `in` side to a different slope, so
        // the price of the SAME profile is unchanged — a corner buys freedom, not a
        // discount.
        if (a.out) {
            const coef = handles === "free" ? 1 : a.out.ds;
            const p = handles === "free" ? K + k : outSlot[k];
            sum.p.push(p);
            sum.c.push(c * (Math.sqrt(3) / 2) * coef);
            chord.p.push(p);
            chord.c.push(-1.5 * c * coef);
        }
        if (b.in) {
            const coef = handles === "free" ? 1 : b.in.ds;
            const p = handles === "free" ? 2 * K - 1 + k : inSlot[k + 1];
            sum.p.push(p);
            sum.c.push(c * (Math.sqrt(3) / 2) * coef);
            chord.p.push(p);
            chord.c.push(1.5 * c * coef);
        }
        rows.push(sum, chord);
    }
    return rows;
}

/** the seminorm at a DOF vector: `∫(F″)² ds` over the whole profile, the quantity λ
 *  prices. It is a function of the PROFILE — a collinear profile costs the same read as
 *  free handles or as slopes, because the rows carry the reparameterization's chain rule.
 *  `Φ_fair = ½·wFair·fairNorm`.
 *
 * @example
 * const rows = fairRows(points, "aligned");
 * const roughness = fairNorm(rows, readDof(points, "aligned"));
 */
export function fairNorm(rows: readonly FairRow[], dof: ArrayLike<number>): number {
    let sum = 0;
    for (const r of rows) {
        let v = 0;
        for (let i = 0; i < r.p.length; i++) v += r.c[i] * dof[r.p[i]];
        sum += v * v;
    }
    return sum;
}

/**
 * polish a stage-2 fit until the geometry its dense force integrates into matches the
 * bake, with the exit held exactly. Throws on an input the formulation can't mean
 * anything over: a bad entry, fewer than two keyframes, non-ascending s, a segment side
 * with no explicit handle, a degenerate bake, or a bake the cart cannot reach.
 *
 * Gravity is deliberately not an option: the production consumer (`section.evalForce` →
 * `forward.step`) hard-codes G, so a profile solved at any other g is one the shipped
 * integrator would not reproduce.
 *
 * @example
 * const entry = { x: 0, y: 0, theta: 0, v: 20 };
 * const r = evalGeo(entry, nodes, 0.5);
 * const f = fit(r.fN, r.ds, 0.05);
 * const p = polish({ bake: r, entry, points: f.points, ds: 0.5 });
 * const out = evalForce(entry, forceProfile(p.points, p.length, p.ds), p.ds);
 */
export function polish(opts: PolishOpts): PolishResult {
    const { bake, entry } = opts;
    const pts = opts.points;
    const K = pts.length;
    if (!Number.isFinite(entry.x) || !Number.isFinite(entry.y) || !Number.isFinite(entry.theta))
        throw new Error("polish: entry position/heading is not finite");
    if (!(entry.v > 0) || !Number.isFinite(entry.v))
        throw new Error(`polish: entry speed must be > 0, got ${entry.v}`);
    if (K < 2) throw new Error(`polish: need >= 2 keyframes, got ${K}`);
    for (let k = 0; k < K; k++) {
        if (!Number.isFinite(pts[k].s) || !Number.isFinite(pts[k].g))
            throw new Error(`polish: keyframe ${k} is not finite`);
        if (k > 0 && !(pts[k].s > pts[k - 1].s))
            throw new Error(`polish: keyframe s must ascend, got ${pts[k - 1].s} then ${pts[k].s}`);
        if (k < K - 1 && !pts[k].out) throw new Error(`polish: keyframe ${k} has no out handle`);
        if (k > 0 && !pts[k].in) throw new Error(`polish: keyframe ${k} has no in handle`);
    }
    // the span/3 reach precondition, refused for the same reason as the guards above: off
    // that family `fairRows` is no longer `∫(F″)² ds` (its note), and it mis-prices
    // SILENTLY — the form stays PSD, the solve still converges, and the answer comes back
    // regularized against a roughness nobody asked for. Measured both ways in
    // `polish.test.ts`: a span/10 reach is under-priced several-fold, and an
    // `Easing.Linear` segment (reach 0, chord-aligned Δg) draws a strictly straight line
    // that the closed form charges for. A caller outside the family must price its
    // profiles by numerical integration instead.
    for (let k = 0; k + 1 < K; k++) {
        const span = pts[k + 1].s - pts[k].s;
        const want = span / 3;
        const bar = REACH_EPS * span;
        // both sides are present: the loop above refused a segment missing either.
        const out = pts[k].out as Offset;
        const inn = pts[k + 1].in as Offset;
        if (!(Math.abs(out.ds - want) <= bar))
            throw new Error(
                `polish: keyframe ${k} out handle reaches ${out.ds} in s, not the span/3 ` +
                    `(${want}) the fairing energy is closed-form on`,
            );
        if (!(Math.abs(inn.ds + want) <= bar))
            throw new Error(
                `polish: keyframe ${k + 1} in handle reaches ${inn.ds} in s, not the span/3 ` +
                    `(${-want}) the fairing energy is closed-form on`,
            );
    }
    // the mode options, refused at the boundary for the same reason the warm-start guards
    // above exist: each of these silently produces a solve that LOOKS answered. An unknown
    // mode string falls through to calm; a non-positive floor makes every λ miss and lands
    // on the fallback; a λ of Infinity or NaN poisons Φ so every trial step is rejected and
    // the untouched warm start comes back wearing converged diagnostics.
    if (opts.mode !== undefined && opts.mode !== "exact" && opts.mode !== "calm")
        throw new Error(`polish: mode must be "exact" or "calm", got ${JSON.stringify(opts.mode)}`);
    if (opts.handles !== undefined && opts.handles !== "free" && opts.handles !== "aligned")
        throw new Error(
            `polish: handles must be "free" or "aligned", got ${JSON.stringify(opts.handles)}`,
        );
    if (opts.floor !== undefined && (!(opts.floor > 0) || !Number.isFinite(opts.floor)))
        throw new Error(`polish: floor must be a finite number > 0, got ${opts.floor}`);
    if (opts.lambda !== undefined && (!(opts.lambda >= 0) || !Number.isFinite(opts.lambda)))
        throw new Error(`polish: lambda must be a finite number >= 0, got ${opts.lambda}`);

    const handles = opts.handles ?? "free";
    // the corner set, refused at the boundary like every other option here: a corner
    // outside the aligned family, at an endpoint, or out of order would silently produce a
    // DOF layout whose columns no longer mean what `slopeSlots` says they mean.
    const corners = opts.corners ?? [];
    if (corners.length > 0) {
        if (handles !== "aligned")
            throw new Error(`polish: corners are an aligned-family state, not ${handles}`);
        for (let r = 0; r < corners.length; r++) {
            const c = corners[r];
            if (!Number.isInteger(c) || c < 1 || c > K - 2)
                throw new Error(
                    `polish: corner ${c} is not an interior key index in [1, ${K - 2}]`,
                );
            if (r > 0 && !(c > corners[r - 1]))
                throw new Error(`polish: corners must ascend, got ${corners[r - 1]} then ${c}`);
        }
    }
    const sp = spine(bake, opts.ds);
    const E = sp.edges;
    const h = sp.ds;
    const L = sp.length;
    const P = dofCount(K, handles, corners);
    const ns = 3 * E;
    // half-bandwidth of the state block: a defect spans two 3-var blocks (5), and the
    // recovered exit heading reads three consecutive θ (6).
    const B = 6;
    const lam = L; // the heading defect's position-equivalent scale
    const v0sq = entry.v * entry.v;
    const y0 = entry.y;

    // the warm start IS the target geometry, so an unreachable target is an infeasible
    // START: Φ(z₀) = ∞, every trial step is rejected, and the AL would burn its outers and
    // hand back the untouched warm start wearing a converged solve's diagnostics
    // (deviation 0, exit 0 — the spine has not moved off the target it was seeded at). This
    // is a real authored input, not a corner case: it is exactly the geometry the live
    // editor draws red-dashed past `bake.V_WARN`. Refuse it at the boundary instead.
    for (let j = 0; j <= E; j++) {
        const v2 = v0sq - 2 * G * (sp.y[j] - y0);
        if (!(v2 > V_FLOOR * V_FLOOR))
            throw new Error(
                `polish: the bake is unreachable at sample ${j}/${E} — v² = ${v2.toFixed(3)} ` +
                    `climbing ${(sp.y[j] - y0).toFixed(3)} m from v0 = ${entry.v}`,
            );
    }

    const tol = opts.tol ?? TOL_FEAS;
    const maxOuters = opts.outers ?? 24;
    const maxIters = opts.maxIters ?? 60;
    const escalate = opts.escalate ?? 10;
    const rho0 = opts.rho0 ?? 1e3 * h;
    const rhoCap = 1e6 * rho0;
    const maxSnaps = Math.max(1, Math.floor(opts.maxSnapshots ?? 120));

    // the probed profile→force map (`forceMatrix`). `rowDofs` is the ≤4-wide stencil per
    // edge — a dense sample lies in one segment, so its force reads the two bounding keys'
    // values and their two facing handles, whichever family those handles come from —
    // and `supp` is its transpose.
    const A = forceMatrix(pts, handles, E, h, corners);
    const rowDofs: number[][] = [];
    for (let j = 0; j < E; j++) rowDofs.push([]);
    const supp: number[][] = [];
    for (let p = 0; p < P; p++) {
        const s: number[] = [];
        for (let j = 0; j < E; j++)
            if (A[p][j] !== 0) {
                s.push(j);
                rowDofs[j].push(p);
            }
        supp.push(s);
    }

    const mode = opts.mode ?? "exact";
    const floor = opts.floor ?? authoringFloor(sp);
    const dof0 = readDof(pts, handles, corners);
    // the fairing rows, plus their columns in the normal system (`ns + p`) built once —
    // the rows are a function of the s-coordinates alone, which this solve holds fixed.
    const fair = fairRows(pts, handles, corners);
    const fairCols = fair.map((r) => r.p.map((p) => ns + p));
    // every λ the search tries is part of what this call cost, so the answer reports the
    // running totals rather than the winning solve's own counts.
    let totalIters = 0;
    let solves = 0;
    const finish = (r: PolishResult): PolishResult => ({ ...r, iters: totalIters, solves });

    if (mode === "exact") return finish(solve(0));
    if (opts.lambda !== undefined) return finish(solve(opts.lambda));

    // ---- the discrepancy principle: the LARGEST λ whose solve still holds the floor ----
    // Probe the strong end first: on a smooth shape the calmest profile in the family
    // (every handle flat) already tracks inside the floor, and the search is over in two
    // solves. Otherwise bracket [LAM_MIN, LAM_MAX] and log-bisect, keeping only solves
    // verified against the floor — so the answer holds it whether or not deviation(λ) is
    // exactly monotone.
    const holds = (r: PolishResult): boolean => r.converged && r.deviation <= floor;
    let best = solve(LAM_MAX);
    if (!holds(best)) {
        let hi = Math.log(LAM_MAX);
        const bot = solve(LAM_MIN);
        // no λ in the bracket holds the floor: there is no slack to spend, so fall back to
        // the tightest geometry the family has, the unregularized solve. That solve may
        // MISS the floor itself — a coarse fit over a bendy shape has nothing below it to
        // return — so this path is not "calm mode is exact mode"; `heldFloor` is what
        // separates the two, and λ = 0 marks the fallback.
        if (!holds(bot)) return finish(solve(0));
        best = bot;
        let lo = Math.log(LAM_MIN);
        for (let i = 0; i < LAM_STEPS; i++) {
            const mid = 0.5 * (lo + hi);
            const r = solve(Math.exp(mid));
            if (holds(r)) {
                best = r;
                lo = mid;
            } else hi = mid;
        }
    }
    return finish(best);

    function solve(lambda: number): PolishResult {
        solves++;
        // the fairing weight. Φ_fair = ½·λ·∫(F″)² ds = ½·λ·L·⟨(F″)²⟩ against a tracking loss
        // of ½·L·⟨dev²⟩ (that loss carries total weight Σh = L), so a profile of rms
        // curvature `c` costs as much as √λ·c metres of rms deviation and λ stays comparable
        // across scenarios of different length and keyframe count — the same reading the
        // Δg prior's λ·L/nH had, over a different operator. λ's UNITS moved with the operator
        // (m⁶/g² against that prior's m²/g²), so read `LAM_MIN`/`LAM_MAX` in the new ones.
        const wFair = lambda;

        // ---- variables: z = [x_1,y_1,θ_1, …, x_E,y_E,θ_E, dof_0..dof_{P−1}] ----
        const n = ns + P;
        const z = new Float64Array(n);
        for (let j = 1; j <= E; j++) {
            z[3 * (j - 1)] = sp.x[j];
            z[3 * (j - 1) + 1] = sp.y[j];
            z[3 * (j - 1) + 2] = sp.theta[j];
        }
        for (let p = 0; p < P; p++) z[ns + p] = dof0[p];

        // a state's column in the normal system, −1 for the pinned entry (state 0 is a
        // constant, so its columns are dropped), and the matching value accessors.
        const colX = (j: number): number => (j === 0 ? -1 : 3 * (j - 1));
        const colY = (j: number): number => (j === 0 ? -1 : 3 * (j - 1) + 1);
        const colT = (j: number): number => (j === 0 ? -1 : 3 * (j - 1) + 2);
        const xAt = (zz: Float64Array, j: number): number => (j === 0 ? entry.x : zz[3 * (j - 1)]);
        const yAt = (zz: Float64Array, j: number): number =>
            j === 0 ? entry.y : zz[3 * (j - 1) + 1];
        const thAt = (zz: Float64Array, j: number): number =>
            j === 0 ? entry.theta : zz[3 * (j - 1) + 2];

        // ---- the exit heading, in the RECOVERED convention ----
        // The target `sp.theta[E]` is the geo bake's RECOVERED exit (`bake.forces`: the
        // chord bisector), and the recovered exit is also what `evalForce` hands the next
        // section. Pinning the integrator's own θ_E instead would leave the quantity
        // downstream consumes free by the gap between the two conventions,
        // ¼(θ_{E−2} − 2θ_{E−1} + θ_E) = O(ds²·κ′) — and measured, that gap WAS the whole
        // live-path heading error: θ_E landed within 5.3e-6 rad of target at every λ while
        // the recovered exit missed by up to 3.6e-3 rad (0.21°, twice the readout quantum).
        //
        // At feasibility the position defects say each chord angle is m_j = ½(θ_j + θ_{j+1}),
        // and `forces` extrapolates its free end as θ_rec = 1.5·m_{E−1} − 0.5·m_{E−2}, which
        // substitutes to the stencil below (its M = 1 branch is the bare bisector instead).
        // Linear in the states, so this is one more linear equality with a constant
        // Jacobian; away from feasibility the two forms differ by the defects themselves,
        // which is under `tol` wherever the answer lives.
        const exitAt = E >= 2 ? [E - 2, E - 1, E] : [0, 1];
        const exitW = E >= 2 ? [-0.25, 0.5, 0.75] : [0.5, 0.5];
        const exitCols = exitAt.map(colT);
        const exitJac = exitW.map((w) => lam * w);
        const exitTheta = (zz: Float64Array): number => {
            let t = 0;
            for (let i = 0; i < exitAt.length; i++) t += exitW[i] * thAt(zz, exitAt[i]);
            return t;
        };

        // ---- constraints: 3 per edge (x, y, θ defects), then the 3 exit rows ----
        const nc = 3 * E + 3;
        const C = new Float64Array(nc);
        const mult = new Float64Array(nc);
        const fBuf = new Float64Array(E);

        /** fill `C` (and `fBuf`) at `zz`; returns the worst |C| and whether the geometry
         *  stayed above the integrator's velocity floor. */
        const constrain = (zz: Float64Array): { feas: number; ok: boolean } => {
            for (let j = 0; j < E; j++) {
                let f = 0;
                for (const p of rowDofs[j]) f += A[p][j] * zz[ns + p];
                fBuf[j] = f;
            }
            let feas = 0;
            let ok = true;
            for (let j = 0; j < E; j++) {
                const t0 = thAt(zz, j);
                const t1 = thAt(zz, j + 1);
                const m = 0.5 * (t0 + t1);
                const v2 = v0sq - 2 * G * (yAt(zz, j) - y0);
                if (!(v2 > V_FLOOR * V_FLOOR)) ok = false;
                const cx = xAt(zz, j + 1) - xAt(zz, j) - h * Math.cos(m);
                const cy = yAt(zz, j + 1) - yAt(zz, j) - h * Math.sin(m);
                const ct = lam * (t1 - t0 - ((fBuf[j] - Math.cos(t0)) * G * h) / v2);
                C[3 * j] = cx;
                C[3 * j + 1] = cy;
                C[3 * j + 2] = ct;
                feas = Math.max(feas, Math.abs(cx), Math.abs(cy), Math.abs(ct));
            }
            C[3 * E] = xAt(zz, E) - sp.x[E];
            C[3 * E + 1] = yAt(zz, E) - sp.y[E];
            C[3 * E + 2] = lam * (exitTheta(zz) - sp.theta[E]);
            for (let k = 3 * E; k < nc; k++) feas = Math.max(feas, Math.abs(C[k]));
            return { feas, ok };
        };

        /** max |spine − target| over the samples (m) and where. */
        const deviate = (zz: Float64Array): { dev: number; at: number } => {
            let dev = 0;
            let at = 0;
            for (let j = 1; j <= E; j++) {
                const d = Math.hypot(xAt(zz, j) - sp.x[j], yAt(zz, j) - sp.y[j]);
                if (d > dev) {
                    dev = d;
                    at = j;
                }
            }
            return { dev, at };
        };

        /** the same reading resolved per sample — built once, for the answer only, so the
         *  playback frames stay allocation-free. */
        const devProfile = (zz: Float64Array): Float64Array => {
            const out = new Float64Array(E + 1);
            for (let j = 1; j <= E; j++)
                out[j] = Math.hypot(xAt(zz, j) - sp.x[j], yAt(zz, j) - sp.y[j]);
            return out;
        };

        /** Φ = tracking + the shifted-quadratic AL term. Mirrors `assemble` exactly. */
        let rho = rho0;
        const phiOf = (zz: Float64Array): number => {
            const { ok } = constrain(zz);
            if (!ok) return Number.POSITIVE_INFINITY;
            let phi = 0;
            for (let j = 1; j < E; j++) {
                const dx = xAt(zz, j) - sp.x[j];
                const dy = yAt(zz, j) - sp.y[j];
                phi += 0.5 * h * (dx * dx + dy * dy);
            }
            if (wFair > 0) phi += 0.5 * wFair * fairNorm(fair, zz.subarray(ns));
            for (let k = 0; k < nc; k++) {
                const r = C[k] + mult[k] / rho;
                phi += 0.5 * rho * r * r;
            }
            return phi;
        };

        // ---- normal system: [H_ss H_sp; H_spᵀ H_pp], state block banded at b = 5 ----
        const band = bandStore(ns, B);
        const cross: Float64Array[] = [];
        for (let p = 0; p < P; p++) cross.push(new Float64Array(ns));
        // the state rows a DOF column can touch: only the θ-defect rows of its support.
        const crossRows: number[][] = [];
        for (let p = 0; p < P; p++) {
            const seen = new Set<number>();
            for (const j of supp[p])
                for (const c of [colY(j), colT(j), colT(j + 1)]) if (c >= 0) seen.add(c);
            crossRows.push([...seen].sort((a, b) => a - b));
        }
        const pp = new Float64Array(P * P);
        const rhsS = new Float64Array(ns);
        const rhsP = new Float64Array(P);

        const addRow = (cols: number[], jac: number[], w: number, r: number): void => {
            for (let a = 0; a < cols.length; a++) {
                const ca = cols[a];
                if (ca < 0) continue;
                if (ca < ns) rhsS[ca] -= w * jac[a] * r;
                else rhsP[ca - ns] -= w * jac[a] * r;
                for (let b = 0; b <= a; b++) {
                    const cb = cols[b];
                    if (cb < 0) continue;
                    const val = w * jac[a] * jac[b];
                    if (ca < ns && cb < ns) {
                        const hi = Math.max(ca, cb);
                        band[hi - Math.min(ca, cb)][hi] += val;
                    } else if (ca >= ns && cb >= ns) {
                        const i = ca - ns;
                        const k = cb - ns;
                        pp[Math.max(i, k) * P + Math.min(i, k)] += val;
                    } else {
                        const st = ca < ns ? ca : cb;
                        const df = (ca < ns ? cb : ca) - ns;
                        cross[df][st] += val;
                    }
                }
            }
        };

        const cols = new Array<number>(8);
        const jac = new Array<number>(8);
        const assemble = (zz: Float64Array): { feas: number; grad: number } => {
            for (const d of band) d.fill(0);
            for (let p = 0; p < P; p++) for (const r of crossRows[p]) cross[p][r] = 0;
            pp.fill(0);
            rhsS.fill(0);
            rhsP.fill(0);
            const { feas } = constrain(zz);

            for (let j = 1; j < E; j++) {
                addRow([colX(j)], [1], h, xAt(zz, j) - sp.x[j]);
                addRow([colY(j)], [1], h, yAt(zz, j) - sp.y[j]);
            }

            // the fairing block: two residual rows per segment, each r = Σ c·dof, so ∂r/∂dof
            // is the row's own coefficients. Lands in H_pp + rhsP alone — it touches no
            // state, so the band and the Schur shape are untouched.
            if (wFair > 0)
                for (let r = 0; r < fair.length; r++) {
                    const row = fair[r];
                    let v = 0;
                    for (let i = 0; i < row.p.length; i++) v += row.c[i] * zz[ns + row.p[i]];
                    addRow(fairCols[r], row.c, wFair, v);
                }

            for (let j = 0; j < E; j++) {
                const t0 = thAt(zz, j);
                const t1 = thAt(zz, j + 1);
                const m = 0.5 * (t0 + t1);
                const sm = Math.sin(m);
                const cm = Math.cos(m);
                addRow(
                    [colX(j), colT(j), colX(j + 1), colT(j + 1)],
                    [-1, 0.5 * h * sm, 1, 0.5 * h * sm],
                    rho,
                    C[3 * j] + mult[3 * j] / rho,
                );
                addRow(
                    [colY(j), colT(j), colY(j + 1), colT(j + 1)],
                    [-1, -0.5 * h * cm, 1, -0.5 * h * cm],
                    rho,
                    C[3 * j + 1] + mult[3 * j + 1] / rho,
                );
                // C_θ = Λ(θ_{j+1} − θ_j − dθ), dθ = (F − cos θ_j)·g·h/v²:
                //   ∂dθ/∂θ_j = sin θ_j · D,  ∂dθ/∂y_j = dθ·2g/v²  (v² = v₀² − 2g·Δy),
                //   ∂dθ/∂dof_p = D·A[p][j].
                const v2 = v0sq - 2 * G * (yAt(zz, j) - y0);
                const D = (G * h) / v2;
                const dth = (fBuf[j] - Math.cos(t0)) * D;
                let w = 0;
                cols[w] = colT(j);
                jac[w++] = lam * (-1 - Math.sin(t0) * D);
                cols[w] = colY(j);
                jac[w++] = -lam * dth * ((2 * G) / v2);
                cols[w] = colT(j + 1);
                jac[w++] = lam;
                for (const p of rowDofs[j]) {
                    cols[w] = ns + p;
                    jac[w++] = -lam * D * A[p][j];
                }
                addRow(
                    cols.slice(0, w),
                    jac.slice(0, w),
                    rho,
                    C[3 * j + 2] + mult[3 * j + 2] / rho,
                );
            }

            addRow([colX(E)], [1], rho, C[3 * E] + mult[3 * E] / rho);
            addRow([colY(E)], [1], rho, C[3 * E + 1] + mult[3 * E + 1] / rho);
            addRow(exitCols, exitJac, rho, C[3 * E + 2] + mult[3 * E + 2] / rho);

            let grad = 0;
            for (let k = 0; k < ns; k++) grad = Math.max(grad, Math.abs(rhsS[k]));
            for (let k = 0; k < P; k++) grad = Math.max(grad, Math.abs(rhsP[k]));
            return { feas, grad };
        };

        // ---- LM step by Schur complement over the state band ----
        const damped = new Float64Array(ns);
        const Lb = bandStore(ns, B);
        const Db = new Float64Array(ns);
        const scr = new Float64Array(ns);
        const U: Float64Array[] = [];
        for (let p = 0; p < P; p++) U.push(new Float64Array(ns));
        const w0 = new Float64Array(ns);
        const Sb = P > 1 ? P - 1 : 0;
        const Sband = bandStore(P, Sb);
        const Sl = bandStore(P, Sb);
        const Sd = new Float64Array(P);
        const Sscr = new Float64Array(P);
        const Sy = new Float64Array(P);
        const dp = new Float64Array(P);
        const tmp = new Float64Array(ns);
        const dsv = new Float64Array(ns);
        const delta = new Float64Array(n);

        /** the damped step `(H + μI)δ = rhs`; false when the damped system is not SPD. */
        const step = (mu: number): boolean => {
            for (let k = 0; k < ns; k++) damped[k] = band[0][k] + mu;
            const work = [damped, ...band.slice(1)];
            bandFactor(work, ns, B, Lb, Db);
            for (let k = 0; k < ns; k++) if (!(Db[k] > 0)) return false;
            for (let p = 0; p < P; p++) bandSolve(Lb, Db, ns, B, cross[p], U[p], scr);
            bandSolve(Lb, Db, ns, B, rhsS, w0, scr);
            for (let i = 0; i < P; i++) {
                for (let k = 0; k <= i; k++) {
                    let s = pp[i * P + k];
                    for (const r of crossRows[i]) s -= cross[i][r] * U[k][r];
                    Sband[i - k][i] = s + (i === k ? mu : 0);
                }
            }
            bandFactor(Sband, P, Sb, Sl, Sd);
            for (let k = 0; k < P; k++) if (!(Sd[k] > 0)) return false;
            for (let i = 0; i < P; i++) {
                let s = rhsP[i];
                for (const r of crossRows[i]) s -= cross[i][r] * w0[r];
                Sscr[i] = s;
            }
            bandSolve(Sl, Sd, P, Sb, Sscr, dp, Sy);
            tmp.set(rhsS);
            for (let p = 0; p < P; p++) {
                if (dp[p] === 0) continue;
                for (const r of crossRows[p]) tmp[r] -= cross[p][r] * dp[p];
            }
            bandSolve(Lb, Db, ns, B, tmp, dsv, scr);
            delta.set(dsv);
            for (let p = 0; p < P; p++) delta[ns + p] = dp[p];
            return true;
        };

        // ---- playback frames: every accepted step, decimated by halving to `maxSnaps` ----
        const snapshots: Snapshot[] = [];
        let stride = 1;
        let stepIdx = 0;
        const frame = (outer: number, phi: number, mu: number): Snapshot => {
            const st = constrain(z);
            const fN = new Float32Array(E);
            for (let j = 0; j < E; j++) fN[j] = fBuf[j];
            const { dev } = deviate(z);
            return {
                step: stepIdx,
                outer,
                points: profile(),
                fN,
                feasibility: st.feas,
                deviation: dev,
                phi,
                mu,
                rho,
            };
        };
        const record = (outer: number, phi: number, mu: number): void => {
            if (stepIdx % stride === 0) {
                snapshots.push(frame(outer, phi, mu));
                // decimate at the cap, not past it: the loop stays one frame short so the
                // final answer's frame (pushed after the AL exits) still fits under `maxSnaps`.
                if (snapshots.length >= maxSnaps) {
                    let w = 0;
                    for (let i = 0; i < snapshots.length; i += 2) snapshots[w++] = snapshots[i];
                    snapshots.length = w;
                    stride *= 2;
                }
            }
            stepIdx++;
        };

        /** the current DOF as a profile in `profile.ts`'s representation. */
        function profile(): ForcePoint[] {
            return applyDof(pts, handles, z.subarray(ns), corners);
        }

        // ---- PHR augmented Lagrangian: LM inners, λ update + stall escalation between ----
        let iters = 0;
        let outer = 0;
        let prevFeas = Number.POSITIVE_INFINITY;
        let feas = constrain(z).feas;
        for (; outer < maxOuters; outer++) {
            let phi = phiOf(z);
            let mu = 0;
            {
                assemble(z);
                let mx = 0;
                for (let k = 0; k < ns; k++) mx = Math.max(mx, band[0][k]);
                for (let k = 0; k < P; k++) mx = Math.max(mx, pp[k * P + k]);
                mu = 1e-6 * (mx > 0 ? mx : 1);
            }
            let nu = 2;
            let grad0 = 0;
            for (let it = 0; it < maxIters; it++) {
                const { grad } = assemble(z);
                if (it === 0) grad0 = grad;
                if (grad <= 1e-12 * (1 + grad0)) break;
                let taken = false;
                let stop = false;
                for (let inner = 0; inner < 40; inner++) {
                    if (!step(mu)) {
                        mu *= nu;
                        nu *= 2;
                        continue;
                    }
                    let dd = 0;
                    let rd = 0;
                    let stepNorm = 0;
                    for (let k = 0; k < n; k++) {
                        dd += delta[k] * delta[k];
                        rd += (k < ns ? rhsS[k] : rhsP[k - ns]) * delta[k];
                        stepNorm = Math.max(stepNorm, Math.abs(delta[k]));
                    }
                    const zt = Float64Array.from(z);
                    for (let k = 0; k < n; k++) zt[k] += delta[k];
                    const phit = phiOf(zt);
                    const predicted = 0.5 * (mu * dd + rd);
                    const ratio =
                        predicted > 0 && Number.isFinite(phit) ? (phi - phit) / predicted : -1;
                    if (ratio > 0) {
                        z.set(zt);
                        phi = phit;
                        mu *= Math.max(1 / 3, 1 - (2 * ratio - 1) ** 3);
                        nu = 2;
                        taken = true;
                        iters++;
                        record(outer, phi, mu);
                        let scale = 0;
                        for (let k = 0; k < n; k++) scale = Math.max(scale, Math.abs(z[k]));
                        if (stepNorm < 1e-14 * (1 + scale)) stop = true;
                        break;
                    }
                    mu *= nu;
                    nu *= 2;
                }
                if (!taken || stop) break;
            }

            feas = constrain(z).feas;
            if (feas < tol) {
                outer++;
                break;
            }
            for (let k = 0; k < nc; k++) mult[k] += rho * C[k];
            if (feas > prevFeas / 4) rho = Math.min(rho * escalate, rhoCap);
            prevFeas = feas;
        }

        feas = constrain(z).feas;
        totalIters += iters;
        const { dev, at } = deviate(z);
        const points = profile();
        const { peakG, maxDg } = violence(points, L, h);
        // playback must end on the answer. Normally the loop leaves room (it decimates AT the
        // cap, so it exits below it), but at `maxSnapshots` = 1 there is no room — then the
        // final frame REPLACES the last recorded one rather than overflowing the cap.
        if (snapshots.length === 0 || snapshots[snapshots.length - 1].step !== stepIdx - 1) {
            const final = frame(outer, phiOf(z), 0);
            if (snapshots.length >= maxSnaps) snapshots[snapshots.length - 1] = final;
            else snapshots.push(final);
        }
        return {
            points,
            length: L,
            ds: h,
            edges: E,
            keys: K,
            iters,
            solves,
            outers: outer,
            converged: feas < tol,
            feasibility: feas,
            exit: {
                dx: C[3 * E],
                dy: C[3 * E + 1],
                dtheta: C[3 * E + 2] / lam,
                dist: Math.hypot(C[3 * E], C[3 * E + 1]),
            },
            deviation: dev,
            at,
            deviations: devProfile(z),
            rho,
            mode,
            handles,
            corners: [...corners],
            lambda,
            floor,
            heldFloor: dev <= floor,
            peakG,
            maxDg,
            spine: sp,
            snapshots,
        };
    }
}
