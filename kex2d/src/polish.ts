/** Geometry-constrained sparse force solve.
 *
 * The full independent-handle family is retained as the numeric-floor oracle. Shipping
 * conversion uses the deliberately narrower flat family: one `g` variable per fixed key,
 * no stored handles, and therefore the default Cubic transition on every segment. Both
 * families use the same unregularized collocation solve and the same recovered-heading exit
 * equality; key placement is the only authorability lever.
 *
 * The state spine, local forward defects, live-evaluator force matrix, f32 barrier, and
 * banded Schur solve are shared. Fixing key `s` keeps the force map linear in either family:
 * `3K − 2` variables for the oracle and `K` for conversion. */

import { bandFactor, bandSolve, bandStore } from "./banded";
import { V_FLOOR } from "./forward";
import {
    type ForcePoint,
    forceProfile,
    type Offset,
    resolveStep,
    sampleForce,
    type Step,
} from "./profile";
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
    /** edge count of the uniform grid, from `profile.resolveStep` — the one seam pairing a
     *  force section's edge count with its step. */
    edges: number;
    /** the realized edge step `length/edges` (m), exact by construction (`resolveStep`). */
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
     *  `forceProfile(points, { edges, ds })` + `evalForce(entry, …, { edges, ds })`. */
    points: ForcePoint[];
    length: number;
    /** the uniform edge step the profile was solved at (`length/edges`). */
    ds: number;
    edges: number;
    /** keyframe count (unchanged from the warm start — the polish moves values, not
     *  placement). */
    keys: number;
    /** accepted LM steps across all augmented-Lagrangian rounds. */
    iters: number;
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
    /** which variable family produced this answer. */
    family: PolishFamily;
    peakG: number;
    maxDg: number;
    /** the target the loss and the pin were measured against. */
    spine: Spine;
    snapshots: Snapshot[];
}

/** `free` is the independent-handle oracle; `flat` is the shipping conversion family. */
export type PolishFamily = "free" | "flat";

export interface PolishOpts {
    bake: Bake;
    /** the entry the bake was evaluated from; state 0 is pinned here. */
    entry: Entry;
    /** Fixed-s warm start. Free-family points carry every explicit side; flat-family
     *  points carry no explicit handles or easing tag. */
    points: readonly ForcePoint[];
    /** nominal edge step (m); the realized step is `profile.resolveStep(length, ds).ds`. */
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
    /** playback frame cap (default 120); frames past it are decimated by halving. **0 records
     *  none** — the production conversion path, which reads only the answer. Recording is pure
     *  observation (it reads `z`, never writes it), so the answer is identical either way. */
    maxSnapshots?: number;
    /** Variable family. Defaults to the full-free oracle. */
    family?: PolishFamily;
}

/** feasibility default, position-equivalent m. The live f32 `evalForce` path rounds each
 *  position by ~6e-8·|coord| ≈ 1e-5 m at coaster scale, so a defect at 1e-6 m is already
 *  below what any f32 integration can express — the spine and the true integration of the
 *  same profile agree to within float noise. Derived from the reference path's resolution,
 *  not tuned to the corpus. */
export const TOL_FEAS = 1e-6;

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
 *  achieved deviation within ~4× across three orders of magnitude. On the bendiest corpus
 *  scenario the term carries ~52% of the conversion floor, so a shape far outside the
 *  corpus's length/curvature range is where this would first mislead. */
export function chordDeficit(sp: Spine): number {
    let deficit = 0;
    for (let j = 0; j < sp.edges; j++)
        deficit += sp.ds - Math.hypot(sp.x[j + 1] - sp.x[j], sp.y[j + 1] - sp.y[j]);
    return deficit;
}

/** how violent a profile is to author: the peak of the dense force it drives (g) and the
 *  largest handle offset in it (g). The dense peak is the one that catches INTER-KEY
 *  overshoot — valley-explicit's polished keys span [−6.5, 2.6] g while the curve between
 *  them reaches 40 g, invisible in the diamonds. */
export function violence(
    points: readonly ForcePoint[],
    step: Step,
): { peakG: number; maxDg: number } {
    const fN = forceProfile(points, step);
    let peakG = 0;
    for (let j = 0; j < fN.length; j++) peakG = Math.max(peakG, Math.abs(fN[j]));
    let maxDg = 0;
    for (const p of points) {
        if (p.in) maxDg = Math.max(maxDg, Math.abs(p.in.dg));
        if (p.out) maxDg = Math.max(maxDg, Math.abs(p.out.dg));
    }
    return { peakG, maxDg };
}

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
    const { edges, ds } = resolveStep(length, dsNominal);
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

function shell(points: readonly ForcePoint[], family: PolishFamily): ForcePoint[] {
    return points.map((point) => {
        const out: ForcePoint = { s: point.s, g: 0 };
        if (family === "free") {
            if (point.in) out.in = { ds: point.in.ds, dg: 0 };
            if (point.out) out.out = { ds: point.out.ds, dg: 0 };
        }
        return out;
    });
}

/** Read the solver vector from a represented profile. */
export function readDof(points: readonly ForcePoint[], family: PolishFamily): Float64Array {
    const keys = points.length;
    const dof = new Float64Array(family === "flat" ? keys : 3 * keys - 2);
    for (let k = 0; k < keys; k++) dof[k] = points[k].g;
    if (family === "free") {
        for (let k = 0; k + 1 < keys; k++) dof[keys + k] = points[k].out?.dg ?? 0;
        for (let k = 1; k < keys; k++) dof[2 * keys - 1 + (k - 1)] = points[k].in?.dg ?? 0;
    }
    return dof;
}

/** Materialize a solver vector. Flat output contains only {s,g}. */
export function applyDof(
    points: readonly ForcePoint[],
    family: PolishFamily,
    dof: ArrayLike<number>,
): ForcePoint[] {
    const keys = points.length;
    const need = family === "flat" ? keys : 3 * keys - 2;
    if (dof.length !== need)
        throw new Error(
            `applyDof: ${family} over ${keys} keys takes ${need} dof, got ${dof.length}`,
        );
    const out = shell(points, family);
    for (let k = 0; k < keys; k++) out[k].g = dof[k];
    if (family === "free") {
        for (let k = 0; k + 1 < keys; k++) (out[k].out as Offset).dg = dof[keys + k];
        for (let k = 1; k < keys; k++) (out[k].in as Offset).dg = dof[2 * keys - 1 + (k - 1)];
    }
    return out;
}

/** Dense force columns probed through the production profile evaluator. */
export function forceMatrix(
    points: readonly ForcePoint[],
    family: PolishFamily,
    edges: number,
    ds: number,
): Float64Array[] {
    const count = family === "flat" ? points.length : 3 * points.length - 2;
    const unit = new Float64Array(count);
    const matrix: Float64Array[] = [];
    for (let p = 0; p < count; p++) {
        unit[p] = 1;
        const probe = applyDof(points, family, unit);
        unit[p] = 0;
        const column = new Float64Array(edges);
        for (let j = 0; j < edges; j++) column[j] = sampleForce(probe, j * ds);
        matrix.push(column);
    }
    return matrix;
}

/**
 * polish a stage-2 fit until the geometry its dense force integrates into matches the
 * bake, with the exit held exactly. Throws on an input the formulation can't mean
 * anything over: a bad entry, fewer than two keyframes, non-ascending s, a free-family
 * key missing or carrying a malformed segment handle, a flat-family key carrying authored
 * shaping, a malformed schedule, a degenerate bake, or a bake the cart cannot reach.
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
 * const out = evalForce(entry, forceProfile(p.points, { edges: p.edges, ds: p.ds }), {
 *     edges: p.edges,
 *     ds: p.ds,
 * });
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
    }
    if (opts.family !== undefined && opts.family !== "free" && opts.family !== "flat")
        throw new Error(
            `polish: family must be "free" or "flat", got ${JSON.stringify(opts.family)}`,
        );
    const family = opts.family ?? "free";
    if (family === "free")
        for (let k = 0; k < K; k++) {
            if (k < K - 1 && !pts[k].out)
                throw new Error(`polish: keyframe ${k} has no out handle`);
            if (k > 0 && !pts[k].in) throw new Error(`polish: keyframe ${k} has no in handle`);
            for (const side of ["in", "out"] as const) {
                const handle = pts[k][side];
                if (handle && (!Number.isFinite(handle.ds) || !Number.isFinite(handle.dg)))
                    throw new Error(`polish: keyframe ${k} ${side} handle is not finite`);
            }
        }
    else
        for (let k = 0; k < K; k++)
            if (pts[k].ease !== undefined || pts[k].in !== undefined || pts[k].out !== undefined)
                throw new Error(`polish: flat keyframe ${k} carries authored shaping`);
    const sp = spine(bake, opts.ds);
    const E = sp.edges;
    const h = sp.ds;
    const L = sp.length;
    const P = family === "flat" ? K : 3 * K - 2;
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
    // is a real authored input, not an edge case: it is exactly the geometry the live
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
    if (!(tol > 0) || !Number.isFinite(tol))
        throw new Error(`polish: tol must be a finite number > 0, got ${tol}`);
    if (!Number.isInteger(maxOuters) || maxOuters < 0)
        throw new Error(`polish: outers must be a non-negative integer, got ${maxOuters}`);
    if (!Number.isInteger(maxIters) || maxIters < 0)
        throw new Error(`polish: maxIters must be a non-negative integer, got ${maxIters}`);
    if (!(escalate >= 1) || !Number.isFinite(escalate))
        throw new Error(`polish: escalate must be a finite number >= 1, got ${escalate}`);
    if (!(rho0 > 0) || !Number.isFinite(rho0) || !Number.isFinite(1e6 * rho0))
        throw new Error(`polish: rho0 must be a finite positive schedule scale, got ${rho0}`);
    if (
        opts.maxSnapshots !== undefined &&
        (!(opts.maxSnapshots >= 0) || !Number.isFinite(opts.maxSnapshots))
    )
        throw new Error(
            `polish: maxSnapshots must be a finite number >= 0, got ${opts.maxSnapshots}`,
        );
    const rhoCap = 1e6 * rho0;
    const maxSnaps = Math.floor(opts.maxSnapshots ?? 120);

    // the probed profile→force map (`forceMatrix`). `stencil` is the ≤4-wide dof list per
    // edge — a dense sample lies in one segment, so its force reads the two bounding keys'
    // values and their two facing handles, whichever family those handles come from —
    // and `supp` is its transpose.
    const A = forceMatrix(pts, family, E, h);
    const stencil: number[][] = [];
    for (let j = 0; j < E; j++) stencil.push([]);
    const supp: number[][] = [];
    for (let p = 0; p < P; p++) {
        const s: number[] = [];
        for (let j = 0; j < E; j++)
            if (A[p][j] !== 0) {
                s.push(j);
                stencil[j].push(p);
            }
        supp.push(s);
    }
    // the stencil frozen per edge, each dof's coefficient gathered beside its index: the two
    // hot passes over it (`constrain` per trial, the θ rows per assemble) read both, and
    // `A[p][j]` is a column-strided load through an array of arrays.
    const rowDofs = stencil.map((dofs) => Int32Array.from(dofs));
    const rowA = stencil.map((dofs, j) => Float64Array.from(dofs, (p) => A[p][j]));

    const dof0 = readDof(pts, family);

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
    const yAt = (zz: Float64Array, j: number): number => (j === 0 ? entry.y : zz[3 * (j - 1) + 1]);
    const thAt = (zz: Float64Array, j: number): number =>
        j === 0 ? entry.theta : zz[3 * (j - 1) + 2];

    // ---- the exit heading, in the RECOVERED convention ----
    // The target `sp.theta[E]` is the geo bake's RECOVERED exit (`bake.forces`: the
    // chord bisector), and the recovered exit is also what `evalForce` hands the next
    // section. Pinning the integrator's own θ_E instead would leave the quantity
    // downstream consumes free by the gap between the two conventions,
    // ¼(θ_{E−2} − 2θ_{E−1} + θ_E) = O(ds²·κ′) — and measured, that gap WAS the whole
    // live-path heading error: θ_E landed within 5.3e-6 rad of target in every probe while
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
            const dofs = rowDofs[j];
            const coef = rowA[j];
            let f = 0;
            for (let i = 0; i < dofs.length; i++) f += coef[i] * zz[ns + dofs[i]];
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
    const crossRows: Int32Array[] = [];
    for (let p = 0; p < P; p++) {
        const seen = new Set<number>();
        for (const j of supp[p])
            for (const c of [colY(j), colT(j), colT(j + 1)]) if (c >= 0) seen.add(c);
        crossRows.push(Int32Array.from(seen).sort());
    }
    const pp = new Float64Array(P * P);
    const rhsS = new Float64Array(ns);
    const rhsP = new Float64Array(P);

    // one weighted row of the normal system, staged in `cols`/`jac` at entries `0..len`. The
    // LM assembles five rows per spine edge on every iteration, so a row allocates nothing.
    const cols = new Array<number>(8);
    const jac = new Array<number>(8);
    const addRow = (len: number, w: number, r: number): void => {
        for (let a = 0; a < len; a++) {
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

    const assemble = (zz: Float64Array): { feas: number; grad: number } => {
        for (const d of band) d.fill(0);
        for (let p = 0; p < P; p++) {
            const rows = crossRows[p];
            const col = cross[p];
            for (let i = 0; i < rows.length; i++) col[rows[i]] = 0;
        }
        pp.fill(0);
        rhsS.fill(0);
        rhsP.fill(0);
        const { feas } = constrain(zz);

        for (let j = 1; j < E; j++) {
            jac[0] = 1;
            cols[0] = colX(j);
            addRow(1, h, xAt(zz, j) - sp.x[j]);
            cols[0] = colY(j);
            addRow(1, h, yAt(zz, j) - sp.y[j]);
        }

        for (let j = 0; j < E; j++) {
            const t0 = thAt(zz, j);
            const t1 = thAt(zz, j + 1);
            const m = 0.5 * (t0 + t1);
            const sm = Math.sin(m);
            const cm = Math.cos(m);
            cols[0] = colX(j);
            cols[1] = colT(j);
            cols[2] = colX(j + 1);
            cols[3] = colT(j + 1);
            jac[0] = -1;
            jac[1] = 0.5 * h * sm;
            jac[2] = 1;
            jac[3] = 0.5 * h * sm;
            addRow(4, rho, C[3 * j] + mult[3 * j] / rho);
            cols[0] = colY(j);
            cols[2] = colY(j + 1);
            jac[1] = -0.5 * h * cm;
            jac[3] = -0.5 * h * cm;
            addRow(4, rho, C[3 * j + 1] + mult[3 * j + 1] / rho);
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
            const dofs = rowDofs[j];
            const coef = rowA[j];
            for (let i = 0; i < dofs.length; i++) {
                cols[w] = ns + dofs[i];
                jac[w++] = -lam * D * coef[i];
            }
            addRow(w, rho, C[3 * j + 2] + mult[3 * j + 2] / rho);
        }

        jac[0] = 1;
        cols[0] = colX(E);
        addRow(1, rho, C[3 * E] + mult[3 * E] / rho);
        cols[0] = colY(E);
        addRow(1, rho, C[3 * E + 1] + mult[3 * E + 1] / rho);
        for (let i = 0; i < exitCols.length; i++) {
            cols[i] = exitCols[i];
            jac[i] = exitJac[i];
        }
        addRow(exitCols.length, rho, C[3 * E + 2] + mult[3 * E + 2] / rho);

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
    const zt = new Float64Array(n);
    // the damped band: `damped` stands in for the main diagonal, the subdiagonals are the
    // assembled band itself. The stores never move, so the view is built once.
    const work = [damped, ...band.slice(1)];

    /** the damped step `(H + μI)δ = rhs`; false when the damped system is not SPD. */
    const step = (mu: number): boolean => {
        for (let k = 0; k < ns; k++) damped[k] = band[0][k] + mu;
        bandFactor(work, ns, B, Lb, Db);
        for (let k = 0; k < ns; k++) if (!(Db[k] > 0)) return false;
        for (let p = 0; p < P; p++) bandSolve(Lb, Db, ns, B, cross[p], U[p], scr);
        bandSolve(Lb, Db, ns, B, rhsS, w0, scr);
        for (let i = 0; i < P; i++) {
            const rows = crossRows[i];
            const col = cross[i];
            for (let k = 0; k <= i; k++) {
                const Uk = U[k];
                let s = pp[i * P + k];
                for (let t = 0; t < rows.length; t++) {
                    const r = rows[t];
                    s -= col[r] * Uk[r];
                }
                Sband[i - k][i] = s + (i === k ? mu : 0);
            }
        }
        bandFactor(Sband, P, Sb, Sl, Sd);
        for (let k = 0; k < P; k++) if (!(Sd[k] > 0)) return false;
        for (let i = 0; i < P; i++) {
            const rows = crossRows[i];
            const col = cross[i];
            let s = rhsP[i];
            for (let t = 0; t < rows.length; t++) {
                const r = rows[t];
                s -= col[r] * w0[r];
            }
            Sscr[i] = s;
        }
        bandSolve(Sl, Sd, P, Sb, Sscr, dp, Sy);
        tmp.set(rhsS);
        for (let p = 0; p < P; p++) {
            if (dp[p] === 0) continue;
            const rows = crossRows[p];
            const col = cross[p];
            for (let t = 0; t < rows.length; t++) {
                const r = rows[t];
                tmp[r] -= col[r] * dp[p];
            }
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
        if (maxSnaps === 0) return;
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
        return applyDof(pts, family, z.subarray(ns));
    }

    // ---- PHR augmented Lagrangian: LM inners, multiplier update + stall escalation ----
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
                zt.set(z);
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
    const points = profile();
    const { peakG, maxDg } = violence(points, { edges: E, ds: h });
    // playback must end on the answer. Normally the loop leaves room (it decimates AT the
    // cap, so it exits below it), but at `maxSnapshots` = 1 there is no room — then the
    // final frame REPLACES the last recorded one rather than overflowing the cap.
    if (
        maxSnaps > 0 &&
        (snapshots.length === 0 || snapshots[snapshots.length - 1].step !== stepIdx - 1)
    ) {
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
        family,
        peakG,
        maxDg,
        spine: sp,
        snapshots,
    };
}
