import { V_FLOOR } from "./forward";

/**
 * position-space collocation solver — the kex2d realized track (roadmap "kex2d
 * Phase 3").
 *
 * the decision variable is the **geometry** (the sample positions), not the
 * force. the force is *read off* the geometry, so the objectives couple only
 * nearby samples:
 *
 *   θ_i  = chord-bisector tangent               (local; mirrors `bake.forces`)
 *   v_i² = v0² − 2g·y_i                          (energy; linear in height)
 *   F_i  = (θ_{i+1} − θ_i)·v_i²/(g·ds_i) + cosθ  (= κ·v²/g + cosθ; local)
 *
 * minimizing, over positions P (with P_0 pinned at the launch),
 *
 *   L = w_shape·Σ‖P_i − P_i°‖²                       identity match to the draft
 *     + w_band·Σ hinge(F_i; [lo,hi])²                soft force-limit band
 *     + Σ_c w_c·(F_{k_c} − v_c)²                      authored force pins
 *     + w_jerk·Σ‖P_{i+2}−3P_{i+1}+3P_i−P_{i−1}‖²      geometric jerk (smoothness)
 *     + w_h·Σ max(0, y_i − v0²/2g)²                   feasibility (no stall/NaN)
 *     + w_l·(θ_0 − θ_launch)²                          flat-launch anchor
 *
 * every residual is a *local* function of nearby positions, so the Gauss-Newton
 * normal equations JᵀJ are **banded** (half-bandwidth 7 in the interleaved
 * (x_i,y_i) ordering) with N-independent conditioning — the property the
 * F_n-space solver lacked (force→geometry integrates; σ_pos grew ~N^1.56,
 * `tests/conditioning.lab.ts`). solved by a banded-Cholesky Gauss-Newton step
 * with a backtracking line search (validated in `tests/collocation.lab.ts`; a LM
 * that inflates λ corrupts the step direction on the 1/ds² curvature stiffness
 * and stalls, so the direction is kept and only the length is searched).
 *
 * the solved geometry IS the realized track — the force is read off it for the
 * timeline, the ride can't diverge from the draft it optimizes. reference:
 * direct collocation / direct transcription (Hargraves & Paris 1987; Betts;
 * Kelly 2017). the arclength-parameterized, force-as-derived formulation is
 * kex2d-specific.
 */

const G = 9.80665;

/** soft force-limit band in g — airtime floor / sustained-high-g ceiling. */
export const DEFAULT_BAND: readonly [number, number] = [-2, 6];

/** loss weights against the unit shape term (only ratios matter). geometry
 *  residuals are in metres, force residuals in g, so the band/pin weights carry
 *  the cross-unit scaling — by-eye, validated by the `collocate.test.ts` band /
 *  pin tests, not yet visually settled. */
export const DEFAULT_BAND_WEIGHT = 300;
export const DEFAULT_SMOOTH = 0.05;
export const DEFAULT_HEIGHT_WEIGHT = 300;
export const DEFAULT_LAUNCH_WEIGHT = 10;
/** an authored pin's force-target weight — large so the solved force nearly hits
 *  the pinned value against the unit shape term. */
export const DEFAULT_PIN_WEIGHT = 400;

/** an authored force pin: pull the derived force at grid edge `index` toward
 *  `value` (g). a soft least-squares target on the geometry-derived force. */
export interface ForceTarget {
    index: number;
    value: number;
    weight: number;
}

export interface CollocateOpts {
    /** [lo, hi] soft force-limit band in g. */
    band?: readonly [number, number];
    /** band hinge stiffness (0 disables the limit). */
    bandWeight?: number;
    /** geometric-jerk smoothness weight. */
    smooth?: number;
    /** feasibility (height-ceiling) penalty weight. */
    heightWeight?: number;
    /** flat-launch anchor weight. */
    launchWeight?: number;
    /** the launch heading θ_0 the anchor pulls toward (radians). */
    theta0?: number;
    /** authored force pins. */
    targets?: ForceTarget[];
    /** warm seed geometry (previous solve) — else the draft is the seed. */
    seedX?: Float64Array;
    seedY?: Float64Array;
    /** Gauss-Newton iteration cap. */
    maxIters?: number;
    /** convergence tolerance on the max coordinate step (m). */
    stepTol?: number;
}

export interface CollocateResult {
    /** solved sample positions, length `n`. */
    x: Float64Array;
    /** solved sample positions, length `n`. */
    y: Float64Array;
    /** Gauss-Newton iterations run. */
    iters: number;
}

function wrap(a: number): number {
    return ((((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
}

/**
 * recover the physical normal force + per-sample (θ, v) from a position curve —
 * the f64 mirror of `bake.forces`: chord-bisector tangent (continuous/unwrapped
 * so θ never jumps the ±π branch cut), energy velocity, `F = κ·v²/g + cosθ`.
 * `fN` is length n−1 (per-edge); θ, v are length n. used for the solved track's
 * timeline output and as the contract `forceLocal` matches per edge.
 */
export function forces64(
    x: Float64Array,
    y: Float64Array,
    n: number,
    v0: number,
    g: number = G,
): { theta: Float64Array; v: Float64Array; fN: Float64Array } {
    const m = n - 1;
    const theta = new Float64Array(n);
    const v = new Float64Array(n);
    const fN = new Float64Array(m);
    const edge = (k: number) => Math.atan2(y[k + 1] - y[k], x[k + 1] - x[k]);

    if (m === 1) {
        theta[0] = edge(0);
        theta[1] = edge(0);
    } else {
        let prev = edge(0);
        let cur = prev + wrap(edge(1) - prev);
        theta[0] = prev - 0.5 * (cur - prev);
        theta[1] = 0.5 * (prev + cur);
        for (let k = 2; k < m; k++) {
            prev = cur;
            cur = prev + wrap(edge(k) - prev);
            theta[k] = 0.5 * (prev + cur);
        }
        theta[m] = cur + 0.5 * (cur - prev);
    }

    v[0] = v0;
    for (let k = 0; k < m; k++) {
        const vSq = v[k] * v[k] - 2 * g * (y[k + 1] - y[k]);
        v[k + 1] = Math.sqrt(Math.max(vSq, 0));
    }
    for (let k = 0; k < m; k++) {
        const ds = Math.hypot(x[k + 1] - x[k], y[k + 1] - y[k]);
        const vSafe = Math.max(Math.abs(v[k]), V_FLOOR);
        fN[k] = ((theta[k + 1] - theta[k]) * vSafe * vSafe) / (g * ds) + Math.cos(theta[k]);
    }
    return { theta, v, fN };
}

/**
 * the physical force at edge `k`, computed from *only* the local positions the
 * edge depends on — value-identical to `forces64().fN[k]` (a global 2π offset in
 * θ cancels in both the turn `θ_{k+1}−θ_k` and `cos θ_k`). this locality is what
 * makes the Gauss-Newton system banded; the per-edge FD in the solver perturbs a
 * single coordinate and re-reads this. `edgeStencil` lists the samples it reads.
 */
export function forceLocal(
    x: Float64Array,
    y: Float64Array,
    n: number,
    k: number,
    v0: number,
    g = G,
): number {
    const m = n - 1;
    const eAng = (j: number) => Math.atan2(y[j + 1] - y[j], x[j + 1] - x[j]);
    const ds = Math.hypot(x[k + 1] - x[k], y[k + 1] - y[k]);
    const vSq = v0 * v0 - 2 * g * y[k];
    const vSafe = Math.max(Math.sqrt(Math.max(vSq, 0)), V_FLOOR);

    let thetaK: number;
    let thetaK1: number;
    if (m === 1) {
        thetaK = eAng(0);
        thetaK1 = eAng(0);
    } else if (k === 0) {
        const m0 = eAng(0);
        const m1 = m0 + wrap(eAng(1) - m0);
        thetaK = m0 - 0.5 * (m1 - m0);
        thetaK1 = 0.5 * (m0 + m1);
    } else if (k === m - 1) {
        const m0 = eAng(k - 1);
        const m1 = m0 + wrap(eAng(k) - m0);
        thetaK = 0.5 * (m0 + m1);
        thetaK1 = m1 + 0.5 * (m1 - m0);
    } else {
        const m0 = eAng(k - 1);
        const m1 = m0 + wrap(eAng(k) - m0);
        const m2 = m1 + wrap(eAng(k + 1) - m1);
        thetaK = 0.5 * (m0 + m1);
        thetaK1 = 0.5 * (m1 + m2);
    }
    return ((thetaK1 - thetaK) * vSafe * vSafe) / (g * ds) + Math.cos(thetaK);
}

/** the samples force edge `k` reads (its FD stencil), n≥4. */
function edgeStencil(n: number, k: number): number[] {
    const m = n - 1;
    if (k === 0) return [0, 1, 2];
    if (k === m - 1) return [k - 1, k, k + 1];
    return [k - 1, k, k + 1, k + 2];
}

// variable packing: P_0 fixed at the launch; free vars = (x_i, y_i), i=1..n−1.
const VX = (i: number) => 2 * (i - 1);
const VY = (i: number) => 2 * (i - 1) + 1;

const FD = 1e-6; // central-FD step for the per-edge force Jacobian (m)

/**
 * banded Cholesky of a symmetric positive-definite `A` (dense row-major n×n,
 * only the band |i−j|≤bw is read) into lower `L` (overwrites `A`'s lower band),
 * then solve `A x = b`. O(n·bw²). a tiny diagonal floor keeps it definite in the
 * near-degenerate gauge directions.
 */
export function bandedSolve(A: Float64Array, b: Float64Array, n: number, bw: number): Float64Array {
    for (let i = 0; i < n; i++) {
        const lo = Math.max(0, i - bw);
        for (let j = lo; j <= i; j++) {
            let s = A[i * n + j];
            for (let k = Math.max(lo, j - bw); k < j; k++) s -= A[i * n + k] * A[j * n + k];
            if (i === j) A[i * n + i] = Math.sqrt(Math.max(s, 1e-12));
            else A[i * n + j] = s / A[j * n + j];
        }
    }
    const yv = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let s = b[i];
        for (let k = Math.max(0, i - bw); k < i; k++) s -= A[i * n + k] * yv[k];
        yv[i] = s / A[i * n + i];
    }
    const xv = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
        let s = yv[i];
        for (let k = i + 1; k <= Math.min(n - 1, i + bw); k++) s -= A[k * n + i] * xv[k];
        xv[i] = s / A[i * n + i];
    }
    return xv;
}

const BW = 7; // JᵀJ half-bandwidth (force/jerk stencils span 4 samples → 7 vars)

/** the resolved loss configuration (opts with defaults applied). */
interface Loss {
    band: readonly [number, number];
    bandWeight: number;
    smooth: number;
    heightWeight: number;
    launchWeight: number;
    theta0: number;
    targets: ForceTarget[];
}

/** total least-squares cost ½‖r‖² at the current geometry. */
function cost(
    x: Float64Array,
    y: Float64Array,
    n: number,
    v0: number,
    dx: Float64Array,
    dy: Float64Array,
    o: Loss,
): number {
    let c = 0;
    const [lo, hi] = o.band;
    const yMax = (v0 * v0) / (2 * G) - 0.05;
    for (let i = 1; i < n; i++) {
        c += (x[i] - dx[i]) ** 2 + (y[i] - dy[i]) ** 2; // shape (w=1)
        const over = y[i] - yMax;
        if (over > 0) c += o.heightWeight * over * over;
    }
    for (let k = 0; k < n - 1; k++) {
        const f = forceLocal(x, y, n, k, v0);
        c += o.bandWeight * (Math.max(0, f - hi) ** 2 + Math.max(0, lo - f) ** 2);
    }
    for (const t of o.targets) {
        const f = forceLocal(x, y, n, t.index, v0);
        c += t.weight * (f - t.value) ** 2;
    }
    for (let i = 1; i <= n - 3; i++) {
        c += o.smooth * (x[i + 2] - 3 * x[i + 1] + 3 * x[i] - x[i - 1]) ** 2;
        c += o.smooth * (y[i + 2] - 3 * y[i + 1] + 3 * y[i] - y[i - 1]) ** 2;
    }
    const th0 = forceLaunchTheta(x, y, n);
    c += o.launchWeight * (th0 - o.theta0) ** 2;
    return 0.5 * c;
}

/** the derived launch heading θ_0 (the `bake.forces` start extrapolation). */
function forceLaunchTheta(x: Float64Array, y: Float64Array, n: number): number {
    if (n < 3) return Math.atan2(y[1] - y[0], x[1] - x[0]);
    const m0 = Math.atan2(y[1] - y[0], x[1] - x[0]);
    const m1 = m0 + wrap(Math.atan2(y[2] - y[1], x[2] - x[1]) - m0);
    return m0 - 0.5 * (m1 - m0);
}

/**
 * solve for the geometry that matches the draft while honoring the force band /
 * pins. `draftX`/`draftY` (length `n`, P_0 the fixed launch) are both the shape
 * target and the default seed. returns the solved positions — the realized track.
 *
 * @example
 * const { x, y } = collocate(draftX, draftY, n, 10, { targets: pins });
 */
export function collocate(
    draftX: Float64Array,
    draftY: Float64Array,
    n: number,
    v0: number,
    opts: CollocateOpts = {},
): CollocateResult {
    const o: Loss = {
        band: opts.band ?? DEFAULT_BAND,
        bandWeight: opts.bandWeight ?? DEFAULT_BAND_WEIGHT,
        smooth: opts.smooth ?? DEFAULT_SMOOTH,
        heightWeight: opts.heightWeight ?? DEFAULT_HEIGHT_WEIGHT,
        launchWeight: opts.launchWeight ?? DEFAULT_LAUNCH_WEIGHT,
        theta0: opts.theta0 ?? 0,
        targets: opts.targets ?? [],
    };
    const [lo, hi] = o.band;
    const yMax = (v0 * v0) / (2 * G) - 0.05;
    const maxIters = opts.maxIters ?? 200;
    const stepTol = opts.stepTol ?? 1e-6;

    const x = Float64Array.from(opts.seedX ?? draftX);
    const y = Float64Array.from(opts.seedY ?? draftY);
    x[0] = draftX[0];
    y[0] = draftY[0];

    if (n < 4) return { x, y, iters: 0 }; // nothing to reshape below a real span

    const nv = 2 * (n - 1);
    const A = new Float64Array(nv * nv); // JᵀJ (dense storage, banded access)
    const g = new Float64Array(nv); // Jᵀr
    // force-target lookup per edge (band is implicit on every edge).
    const pinAt = new Map<number, ForceTarget[]>();
    for (const t of o.targets) {
        const k = Math.min(Math.max(t.index, 0), n - 2);
        const list = pinAt.get(k);
        if (list) list.push({ ...t, index: k });
        else pinAt.set(k, [{ ...t, index: k }]);
    }

    let c = cost(x, y, n, v0, draftX, draftY, o);
    let iters = 0;
    for (let it = 1; it <= maxIters; it++) {
        A.fill(0);
        g.fill(0);
        const add = (a: number, b: number, val: number) => {
            A[a * nv + b] += val;
            if (a !== b) A[b * nv + a] += val;
        };

        // shape (w=1) + height feasibility — diagonal, linear.
        for (let i = 1; i < n; i++) {
            const jx = VX(i);
            const jy = VY(i);
            add(jx, jx, 1);
            g[jx] += x[i] - draftX[i];
            add(jy, jy, 1);
            g[jy] += y[i] - draftY[i];
            const over = y[i] - yMax;
            if (over > 0) {
                add(jy, jy, o.heightWeight);
                g[jy] += o.heightWeight * over;
            }
        }

        // jerk (geometric third difference) — linear, banded stencil [−1,3,−3,1].
        const Js = [-1, 3, -3, 1];
        for (let i = 1; i <= n - 3; i++) {
            const sx = [i - 1, i, i + 1, i + 2];
            let rx = 0;
            let ry = 0;
            for (let a = 0; a < 4; a++) {
                rx += Js[a] * x[sx[a]];
                ry += Js[a] * y[sx[a]];
            }
            for (let a = 0; a < 4; a++) {
                if (sx[a] === 0) continue;
                const ax = VX(sx[a]);
                const ay = VY(sx[a]);
                g[ax] += o.smooth * Js[a] * rx;
                g[ay] += o.smooth * Js[a] * ry;
                for (let b = a; b < 4; b++) {
                    if (sx[b] === 0) continue;
                    add(ax, VX(sx[b]), o.smooth * Js[a] * Js[b]);
                    add(ay, VY(sx[b]), o.smooth * Js[a] * Js[b]);
                }
            }
        }

        // band + pins — nonlinear force residuals. FD ∂F_k/∂var once per edge,
        // then Gauss-Newton rank-1 scatter per residual (∂r/∂u = (dr/dF)·∂F/∂u).
        for (let k = 0; k < n - 1; k++) {
            const stencil = edgeStencil(n, k).filter((s) => s >= 1);
            const vars: number[] = [];
            for (const s of stencil) {
                vars.push(VX(s), VY(s));
            }
            const f0 = forceLocal(x, y, n, k, v0);
            const dF = new Float64Array(vars.length);
            for (let vi = 0; vi < vars.length; vi++) {
                const s = stencil[vi >> 1];
                const isX = (vi & 1) === 0;
                const arr = isX ? x : y;
                const save = arr[s];
                arr[s] = save + FD;
                const fp = forceLocal(x, y, n, k, v0);
                arr[s] = save - FD;
                const fm = forceLocal(x, y, n, k, v0);
                arr[s] = save;
                dF[vi] = (fp - fm) / (2 * FD);
            }
            // residuals on this edge: band hinge (hi, lo) + any pins.
            const scatter = (coef: number, resid: number) => {
                for (let a = 0; a < vars.length; a++) {
                    const ga = coef * dF[a];
                    g[vars[a]] += ga * resid;
                    for (let b = a; b < vars.length; b++) add(vars[a], vars[b], ga * coef * dF[b]);
                }
            };
            if (f0 - hi > 0) scatter(Math.sqrt(o.bandWeight), Math.sqrt(o.bandWeight) * (f0 - hi));
            if (lo - f0 > 0) scatter(-Math.sqrt(o.bandWeight), Math.sqrt(o.bandWeight) * (lo - f0));
            const pins = pinAt.get(k);
            if (pins)
                for (const t of pins)
                    scatter(Math.sqrt(t.weight), Math.sqrt(t.weight) * (f0 - t.value));
        }

        // launch anchor — θ_0 depends on P_1, P_2 (P_0 fixed). FD.
        {
            const th0 = forceLaunchTheta(x, y, n);
            const svars = [VX(1), VY(1), VX(2), VY(2)];
            const samp = [1, 1, 2, 2];
            const isX = [true, false, true, false];
            const dth = new Float64Array(4);
            for (let vi = 0; vi < 4; vi++) {
                const arr = isX[vi] ? x : y;
                const save = arr[samp[vi]];
                arr[samp[vi]] = save + FD;
                const tp = forceLaunchTheta(x, y, n);
                arr[samp[vi]] = save - FD;
                const tm = forceLaunchTheta(x, y, n);
                arr[samp[vi]] = save;
                dth[vi] = (tp - tm) / (2 * FD);
            }
            const coef = Math.sqrt(o.launchWeight);
            const resid = coef * (th0 - o.theta0);
            for (let a = 0; a < 4; a++) {
                const ga = coef * dth[a];
                g[svars[a]] += ga * resid;
                for (let b = a; b < 4; b++) add(svars[a], svars[b], ga * coef * dth[b]);
            }
        }
        // SPD floor, then the Gauss-Newton descent direction (banded solve).
        // a direct solve is exact regardless of conditioning, so the 1/ds²
        // stiffness doesn't corrupt the direction; the backtracking line search
        // handles the force nonlinearity by shortening the step. (Marquardt
        // diagonal damping is wrong here — it suppresses the high-curvature
        // directions that carry the band correction.)
        for (let i = 0; i < nv; i++) A[i * nv + i] += 1e-9 * (A[i * nv + i] + 1);
        const dir = bandedSolve(A, g, nv, BW);

        const xc = Float64Array.from(x);
        const yc = Float64Array.from(y);
        let alpha = 1;
        let improved = false;
        let step = 0;
        for (let bt = 0; bt < 30; bt++) {
            for (let i = 1; i < n; i++) {
                x[i] = xc[i] - alpha * dir[VX(i)];
                y[i] = yc[i] - alpha * dir[VY(i)];
            }
            const ct = cost(x, y, n, v0, draftX, draftY, o);
            if (Number.isFinite(ct) && ct < c - 1e-12) {
                c = ct;
                improved = true;
                for (let i = 0; i < nv; i++) step = Math.max(step, Math.abs(alpha * dir[i]));
                break;
            }
            alpha *= 0.5;
        }
        iters = it;
        if (!improved) {
            x.set(xc);
            y.set(yc);
            break;
        }
        if (step < stepTol) break;
    }

    return { x, y, iters };
}
