/** the CONSTRAINED POLISH: a sparse force profile whose *integrated* geometry matches
 *  the geometry it came from, with the exit pinned. the geo→force spike's stage 3
 *  (`specs/kex2d-geoforce-spike.md`) — pure, framework-free, f64, kernel-atom family
 *  (`force.ts`, `banded.ts`, `collocate.ts`), NOT on the live path.
 *
 *  stage 2 (`fit.ts`) fits force to the dense recovered curve. That is not a convert:
 *  force error integrates twice, so a 0.033 g fit can land 39.7 m off. This step closes
 *  the geometry instead, in the ALL-LOCAL (collocation) formulation.
 *
 *  **variables.** the sparse profile's continuous DOF — every keyframe's `g` plus every
 *  handle's `dg`, `3K − 2` of them — AND a dense state spine `(x_j, y_j, θ_j)`,
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
 *  plus the hard exit equality on the LAST state (x, y, θ — v follows from y). That is
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
 *  (half-bandwidth 5 — a defect touches two adjacent 3-var blocks, the same width
 *  `collocate.ts` assembles), and the profile block is small, so one Schur complement
 *  over the state band solves it. Both factorizations are `banded.ts` — the state band
 *  at b = 5, the P×P Schur block at b = P−1 (a general dense LDLᵀ). No new linear
 *  algebra.
 *
 *  **the v² barrier.** the model divides by the raw `v²` (smooth, the differentiability
 *  win — `force.ts` makes the same choice) where the shipped integrator clamps
 *  `vSafe = max(|v|, V_FLOOR)`. A trial step that drives `v²` under that floor is
 *  REJECTED (Φ = ∞) rather than clamped: the clamp is non-differentiable, and a coaster
 *  that stalls is not a geometry the polish should be exploring. */

import { bandFactor, bandSolve, bandStore } from "./banded";
import { V_FLOOR } from "./forward";
import { type ForcePoint, sampleForce } from "./profile";
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

/** one playback frame: the spine, the profile, and the residuals at an accepted step. */
export interface Snapshot {
    /** accepted-step index (frames are decimated, so these are not contiguous). */
    step: number;
    /** AL outer round the step belongs to. */
    outer: number;
    /** the spine geometry (m), length `edges + 1`. */
    x: Float32Array;
    y: Float32Array;
    /** the profile at this step. */
    points: ForcePoint[];
    /** the dense force it drives (g), length `edges`. */
    fN: Float32Array;
    /** worst constraint violation, position-equivalent m. */
    feasibility: number;
    /** exit gap |P_E − P*_E| (m). */
    exit: number;
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
    /** accepted LM steps, total across outers. */
    iters: number;
    /** AL outer rounds run. */
    outers: number;
    /** the contract: worst constraint violation < `tol`. */
    converged: boolean;
    /** worst constraint violation, position-equivalent m. */
    feasibility: number;
    /** exit residual on the solved spine: position gap (m) and heading gap (rad). */
    exit: { dx: number; dy: number; dtheta: number; dist: number };
    /** max |spine − target| over the samples (m), and where. */
    deviation: number;
    at: number;
    /** final penalty after any escalation. */
    rho: number;
    /** the target the loss and the pin were measured against. */
    spine: Spine;
    snapshots: Snapshot[];
}

export interface PolishOpts {
    bake: Bake;
    /** the entry the bake was evaluated from; state 0 is pinned here. */
    entry: Entry;
    /** stage-2's `fit().points` — the warm start. Every segment's two sides must carry
     *  explicit handles (the fit's own shape). */
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
}

/** feasibility default, position-equivalent m. The live f32 `evalForce` path rounds each
 *  position by ~6e-8·|coord| ≈ 1e-5 m at coaster scale, so a defect at 1e-6 m is already
 *  below what any f32 integration can express — the spine and the true integration of the
 *  same profile agree to within float noise. Derived from the reference path's resolution,
 *  not tuned to the corpus. */
export const TOL_FEAS = 1e-6;

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

/** the profile with every value zeroed and every handle's Δs kept — the shell the DOF
 *  are read into and probed through. */
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

/** DOF layout: `g_k` (k = 0..K−1), then `out_k.dg` (k = 0..K−2), then `in_k.dg`
 *  (k = 1..K−1). `3K − 2` in all. */
function poke(pts: ForcePoint[], keys: number, p: number, val: number): void {
    if (p < keys) pts[p].g = val;
    else if (p < 2 * keys - 1) (pts[p - keys].out as { dg: number }).dg = val;
    else (pts[p - (2 * keys - 2)].in as { dg: number }).dg = val;
}

function peek(pts: readonly ForcePoint[], keys: number, p: number): number {
    if (p < keys) return pts[p].g;
    if (p < 2 * keys - 1) return (pts[p - keys].out as { dg: number }).dg;
    return (pts[p - (2 * keys - 2)].in as { dg: number }).dg;
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

    const sp = spine(bake, opts.ds);
    const E = sp.edges;
    const h = sp.ds;
    const L = sp.length;
    const P = 3 * K - 2;
    const ns = 3 * E;
    const B = 5; // half-bandwidth of the state block: a defect spans two 3-var blocks
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

    // the profile→force map, PROBED through the production evaluator: column p is the
    // dense force a unit DOF p drives, and F = A·dof exactly (linear in the DOF once s
    // is fixed). `rowDofs` is the ≤4-wide stencil per edge; `supp` its transpose.
    const probeShell = shell(pts);
    const A: Float64Array[] = [];
    for (let p = 0; p < P; p++) {
        poke(probeShell, K, p, 1);
        const col = new Float64Array(E);
        for (let j = 0; j < E; j++) col[j] = sampleForce(probeShell, j * h);
        poke(probeShell, K, p, 0);
        A.push(col);
    }
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

    // ---- variables: z = [x_1,y_1,θ_1, …, x_E,y_E,θ_E, dof_0..dof_{P−1}] ----
    const n = ns + P;
    const z = new Float64Array(n);
    for (let j = 1; j <= E; j++) {
        z[3 * (j - 1)] = sp.x[j];
        z[3 * (j - 1) + 1] = sp.y[j];
        z[3 * (j - 1) + 2] = sp.theta[j];
    }
    for (let p = 0; p < P; p++) z[ns + p] = peek(pts, K, p);

    // a state's column in the normal system, −1 for the pinned entry (state 0 is a
    // constant, so its columns are dropped), and the matching value accessors.
    const colX = (j: number): number => (j === 0 ? -1 : 3 * (j - 1));
    const colY = (j: number): number => (j === 0 ? -1 : 3 * (j - 1) + 1);
    const colT = (j: number): number => (j === 0 ? -1 : 3 * (j - 1) + 2);
    const xAt = (zz: Float64Array, j: number): number => (j === 0 ? entry.x : zz[3 * (j - 1)]);
    const yAt = (zz: Float64Array, j: number): number => (j === 0 ? entry.y : zz[3 * (j - 1) + 1]);
    const thAt = (zz: Float64Array, j: number): number =>
        j === 0 ? entry.theta : zz[3 * (j - 1) + 2];

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
        C[3 * E + 2] = lam * (thAt(zz, E) - sp.theta[E]);
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
            addRow(cols.slice(0, w), jac.slice(0, w), rho, C[3 * j + 2] + mult[3 * j + 2] / rho);
        }

        addRow([colX(E)], [1], rho, C[3 * E] + mult[3 * E] / rho);
        addRow([colY(E)], [1], rho, C[3 * E + 1] + mult[3 * E + 1] / rho);
        addRow([colT(E)], [lam], rho, C[3 * E + 2] + mult[3 * E + 2] / rho);

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
        const x = new Float32Array(E + 1);
        const y = new Float32Array(E + 1);
        for (let j = 0; j <= E; j++) {
            x[j] = xAt(z, j);
            y[j] = yAt(z, j);
        }
        const st = constrain(z);
        const fN = new Float32Array(E);
        for (let j = 0; j < E; j++) fN[j] = fBuf[j];
        const { dev } = deviate(z);
        return {
            step: stepIdx,
            outer,
            x,
            y,
            points: profile(),
            fN,
            feasibility: st.feas,
            exit: Math.hypot(C[3 * E], C[3 * E + 1]),
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
        const out = shell(pts);
        for (let p = 0; p < P; p++) poke(out, K, p, z[ns + p]);
        return out;
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
    const { dev, at } = deviate(z);
    // playback must end on the answer. Normally the loop leaves room (it decimates AT the
    // cap, so it exits below it), but at `maxSnapshots` = 1 there is no room — then the
    // final frame REPLACES the last recorded one rather than overflowing the cap.
    if (snapshots.length === 0 || snapshots[snapshots.length - 1].step !== stepIdx - 1) {
        const final = frame(outer, phiOf(z), 0);
        if (snapshots.length >= maxSnaps) snapshots[snapshots.length - 1] = final;
        else snapshots.push(final);
    }
    return {
        points: profile(),
        length: L,
        ds: h,
        edges: E,
        keys: K,
        iters,
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
        rho,
        spine: sp,
        snapshots,
    };
}
