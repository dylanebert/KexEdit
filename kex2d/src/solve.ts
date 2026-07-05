/** the invoked scoped solver — pure, framework-free (mirrors `spline.ts` /
 *  `force.ts`), so it's directly `bun test`-able; only the ECS edge
 *  (`targets.ts`) imports the shallot barrel.
 *
 *  the decision variables are the authored node parameters — freed nodes'
 *  `(x, y, θ)`, arc-rule tangent lengths staying derived — NOT the dense spine
 *  (spec `kex/specs/kex2d-force-targets.md` §2). a scoped op frees ~3–10 nodes
 *  ⇒ ≤30 DOF, so the problem is tiny and a dense LM suffices; `banded.ts` is
 *  not needed at this size.
 *
 *  the map: node params → **frozen-topology** `sampleAt` → `forces64` → F_n. the
 *  per-segment edge counts freeze at solve start (`chainCounts` run once by the
 *  caller), so the residual dimension is constant and the finite-difference
 *  Jacobian is clean. residuals: one force row per point target (at the sample
 *  nearest its arclength) + a weak draft prior (pull freed params toward their
 *  drafted values — the degeneracy regularizer and the "minimum deformation of
 *  what the author drew" intent) + a node-spacing term (adjacent freed chord vs
 *  draft — suppresses tangential bunching). LM with Marquardt diagonal scaling
 *  (the mixed-unit x/y/θ DOF want per-column scaling, unlike the dense kernel's
 *  μI). Validated the evidence gate in `tests/hill.lab.ts`; promoted here. */

import { forces64 } from "./force";
import { chainCounts, type Node, sampleAt } from "./spline";

const MAX = 4096;

// solve-local scratch for the frozen bake. the solve is synchronous and
// single-threaded (residual + FD-Jacobian evals all run inline), so one shared
// buffer set is safe and avoids per-eval allocation.
const bx = new Float64Array(MAX);
const by = new Float64Array(MAX);
const bds = new Float64Array(MAX);

export interface Baked {
    /** normal force in g, length n; interior chord-based, ends extrapolated. */
    fN: Float64Array;
    /** speed² (m²/s²), length n (raw, may go negative if infeasible). */
    v2: Float64Array;
    /** sampled positions, length n. */
    x: Float64Array;
    y: Float64Array;
    /** sample index each node lands on; length = baked node count. */
    offsets: number[];
    /** interior sample count. */
    n: number;
}

/** sample a node chain at given (frozen) per-segment edge counts and recover
 *  the f64 force profile — the solver's forward map. */
export function bakeNodes(nodes: readonly Node[], counts: readonly number[], v0: number): Baked {
    const { offsets, edges } = sampleAt(nodes, counts, bx, by, bds);
    const n = edges + 1;
    const x = bx.slice(0, n);
    const y = by.slice(0, n);
    const { fN, v2 } = forces64(x, y, n, v0);
    return { fN, v2, x, y, offsets, n };
}

/** per-sample cumulative arclength (m) over the frozen samples. */
export function sampleArc(b: Baked): Float64Array {
    const arc = new Float64Array(b.n);
    for (let i = 1; i < b.n; i++)
        arc[i] = arc[i - 1] + Math.hypot(b.x[i] - b.x[i - 1], b.y[i] - b.y[i - 1]);
    return arc;
}

const clampInterior = (i: number, n: number): number => Math.max(1, Math.min(n - 2, i));

/** nearest interior sample index to arclength `s`. */
export function sampleAtArc(arc: Float64Array, n: number, s: number): number {
    let best = 1;
    let bestD = Number.POSITIVE_INFINITY;
    for (let i = 1; i < n - 1; i++) {
        const d = Math.abs(arc[i] - s);
        if (d < bestD) {
            bestD = d;
            best = i;
        }
    }
    return clampInterior(best, n);
}

/** a point force target in the SOLVER domain: demand `g` at interior sample
 *  index `i`, at fixed weight `w`. `targets.ts` converts the authored arclength
 *  point into this against the frozen bake. */
export interface PointTarget {
    i: number;
    g: number;
    w: number;
}

/** the §5 auto-scope rule: node indices whose segments overlap [from,to] plus
 *  one neighbor each side, excluding the flat anchor (node 0). */
function autoScope(nNodes: number, from: number, to: number): number[] {
    const lo = Math.max(1, from - 1);
    const hi = Math.min(nNodes - 1, to + 1);
    const out: number[] = [];
    for (let i = lo; i <= hi; i++) out.push(i);
    return out;
}

/** the freed-node set for an arclength point `s`: the two nodes of the segment
 *  containing it, widened one neighbor each side (`autoScope`, spec §5). the
 *  working set the stage-1 evidence gate validated — segment nodes plus one is
 *  what reaches the force-error budget. a point past either end clamps to the
 *  first/last segment. */
export function scopeForPoint(b: Baked, arc: Float64Array, s: number): number[] {
    const nNode = b.offsets.length;
    if (nNode < 2) return [];
    let k = nNode - 2;
    for (let i = 0; i < nNode - 1; i++) {
        if (s < arc[b.offsets[i + 1]]) {
            k = i;
            break;
        }
    }
    return autoScope(nNode, k, k + 1);
}

/** what a point target actually achieves on baked geometry: the held force at
 *  its sample (the achieved-vs-target readout) and the gap (the drift). */
export function pointResidual(b: Baked, t: PointTarget): { achieved: number; err: number } {
    const achieved = b.fN[t.i];
    return { achieved, err: Math.abs(achieved - t.g) };
}

// ── the LM solve over node parameters ────────────────────────────────────────

/** weights for the auxiliary residual terms. `wPos`/`wTheta` are the draft
 *  prior (position/heading pull toward the draft — keep weak, w≈0.1: at w≥1 it
 *  biases the target); `wSpace` is the node-spacing tie-breaker. */
export interface Weights {
    wPos: number;
    wTheta: number;
    wSpace: number;
}

export const DEFAULT_WEIGHTS: Weights = { wPos: 0.1, wTheta: 0.1, wSpace: 0.3 };

interface Problem {
    base: Node[];
    freed: number[];
    counts: readonly number[];
    v0: number;
    targets: readonly PointTarget[];
    w: Weights;
    p0: Float64Array;
    /** draft chord for each adjacent freed pair (k,k+1); NaN if not adjacent. */
    spaceRef: number[];
}

function pack(nodes: readonly Node[], freed: readonly number[]): Float64Array {
    const p = new Float64Array(freed.length * 3);
    freed.forEach((idx, k) => {
        p[k * 3] = nodes[idx].x;
        p[k * 3 + 1] = nodes[idx].y;
        p[k * 3 + 2] = nodes[idx].theta;
    });
    return p;
}

function unpack(base: readonly Node[], freed: readonly number[], p: Float64Array): Node[] {
    const nodes = base.map((n) => ({ ...n }));
    freed.forEach((idx, k) => {
        nodes[idx] = { x: p[k * 3], y: p[k * 3 + 1], theta: p[k * 3 + 2] };
    });
    return nodes;
}

function residual(prob: Problem, p: Float64Array): Float64Array {
    const nodes = unpack(prob.base, prob.freed, p);
    const b = bakeNodes(nodes, prob.counts, prob.v0);
    const rows: number[] = [];
    for (const t of prob.targets) rows.push(t.w * (b.fN[t.i] - t.g));
    prob.freed.forEach((_, k) => {
        rows.push(prob.w.wPos * (p[k * 3] - prob.p0[k * 3]));
        rows.push(prob.w.wPos * (p[k * 3 + 1] - prob.p0[k * 3 + 1]));
        rows.push(prob.w.wTheta * (p[k * 3 + 2] - prob.p0[k * 3 + 2]));
    });
    if (prob.w.wSpace > 0)
        prob.freed.forEach((idx, k) => {
            if (Number.isNaN(prob.spaceRef[k])) return;
            const a = nodes[idx];
            const c = nodes[idx + 1];
            rows.push(prob.w.wSpace * (Math.hypot(c.x - a.x, c.y - a.y) - prob.spaceRef[k]));
        });
    return Float64Array.from(rows);
}

/** central-difference Jacobian; the frozen topology keeps every column the same
 *  length. positions step 1e-4 m, headings 1e-5 rad. */
function jacobian(prob: Problem, p: Float64Array, rLen: number): Float64Array {
    const K = p.length;
    const J = new Float64Array(rLen * K);
    for (let j = 0; j < K; j++) {
        const h = j % 3 === 2 ? 1e-5 : 1e-4;
        const pp = Float64Array.from(p);
        const pm = Float64Array.from(p);
        pp[j] += h;
        pm[j] -= h;
        const rp = residual(prob, pp);
        const rm = residual(prob, pm);
        for (let i = 0; i < rLen; i++) J[i * K + j] = (rp[i] - rm[i]) / (2 * h);
    }
    return J;
}

function cost(prob: Problem, p: Float64Array): number {
    const r = residual(prob, p);
    let c = 0;
    for (let i = 0; i < r.length; i++) c += r[i] * r[i];
    return 0.5 * c;
}

/** dense SPD solve via in-place Cholesky (LLᵀ) — the K≤~30 DOF makes dense
 *  trivial; the banded factorization is not needed here. mirrors the reference
 *  the kernel's `banded.ts` is cross-validated against. */
function solveSpd(M: Float64Array, b: Float64Array, K: number): Float64Array {
    for (let j = 0; j < K; j++) {
        let dsum = M[j * K + j];
        for (let k = 0; k < j; k++) dsum -= M[j * K + k] * M[j * K + k];
        const ljj = Math.sqrt(dsum);
        M[j * K + j] = ljj;
        for (let i = j + 1; i < K; i++) {
            let s = M[i * K + j];
            for (let k = 0; k < j; k++) s -= M[i * K + k] * M[j * K + k];
            M[i * K + j] = s / ljj;
        }
    }
    const x = new Float64Array(K);
    for (let i = 0; i < K; i++) {
        let s = b[i];
        for (let k = 0; k < i; k++) s -= M[i * K + k] * x[k];
        x[i] = s / M[i * K + i];
    }
    for (let i = K - 1; i >= 0; i--) {
        let s = x[i];
        for (let k = i + 1; k < K; k++) s -= M[k * K + i] * x[k];
        x[i] = s / M[i * K + i];
    }
    return x;
}

export interface SolveResult {
    /** the full node chain with the freed nodes updated to the solution. */
    nodes: Node[];
    iters: number;
    /** LM reached a local minimum (a stall or a below-tol step) before
     *  exhausting `maxIters`. NOT a health signal — read `pointResidual` for
     *  whether the demand was met. */
    converged: boolean;
}

/**
 * the LM solve as a resumable **stepwise session** (spec §8): it yields the
 * current node chain after each accepted iteration and returns the `SolveResult`
 * on completion. `solveTargets` is the synchronous drain — the tests and every
 * non-animated caller use it; the animated driver advances this per frame and
 * live-writes each yielded iterate. one source of truth: the two share this body,
 * so the drained final chain is byte-identical to the last stepped iterate.
 *
 * assembles every target's force row over the freed-node union in one system (the
 * coupled/composition case is one assembled problem, not per-target). `base` is
 * the **draft**: it anchors the draft prior (the "minimum deformation of what's
 * there now" pull, re-anchored to current geometry at each explicit invocation —
 * spec §3) and the node-spacing reference; it is never modified.
 */
export function* lmSession(
    base: readonly Node[],
    freed: readonly number[],
    counts: readonly number[],
    v0: number,
    targets: readonly PointTarget[],
    w: Weights = DEFAULT_WEIGHTS,
    maxIters = 120,
    stepTol = 1e-7,
): Generator<Node[], SolveResult> {
    // `base` is both the starting iterate and the anchor the prior + spacing
    // pull toward (minimum deformation of what's there now). the fixpoint outer
    // loop re-anchors by passing each round's current chain as `base` — see
    // `fixpointSession`.
    const p0 = pack(base, freed);
    const spaceRef = freed.map((idx, k) => {
        if (k + 1 >= freed.length || freed[k + 1] !== idx + 1) return Number.NaN;
        const a = base[idx];
        const c = base[idx + 1];
        return Math.hypot(c.x - a.x, c.y - a.y);
    });
    const prob: Problem = {
        base: base.map((n) => ({ ...n })),
        freed: [...freed],
        counts,
        v0,
        targets,
        w,
        p0,
        spaceRef,
    };

    let p = Float64Array.from(p0);
    const K = p.length;
    let mu = -1;
    let nu = 2;
    let iters = 0;
    let converged = false;
    for (; iters < maxIters; iters++) {
        const r = residual(prob, p);
        const R = r.length;
        const J = jacobian(prob, p, R);

        // JᵀJ (K×K) and Jᵀr (K).
        const JtJ = new Float64Array(K * K);
        const Jtr = new Float64Array(K);
        for (let a = 0; a < K; a++) {
            for (let c = a; c < K; c++) {
                let s = 0;
                for (let i = 0; i < R; i++) s += J[i * K + a] * J[i * K + c];
                JtJ[a * K + c] = s;
                JtJ[c * K + a] = s;
            }
            let g = 0;
            for (let i = 0; i < R; i++) g += J[i * K + a] * r[i];
            Jtr[a] = g;
        }
        if (mu < 0) {
            let mx = 0;
            for (let a = 0; a < K; a++) mx = Math.max(mx, JtJ[a * K + a]);
            mu = 1e-3 * mx;
        }

        // (JᵀJ + μ·diag) δ = −Jᵀr, retry with larger μ on rejection (Marquardt
        // diagonal scaling — the x/y/θ mixed-unit DOF want per-column scaling).
        let accepted = false;
        let step = 0;
        for (let tries = 0; tries < 30 && !accepted; tries++) {
            const A = Float64Array.from(JtJ);
            for (let a = 0; a < K; a++) A[a * K + a] += mu * JtJ[a * K + a];
            const neg = new Float64Array(K);
            for (let a = 0; a < K; a++) neg[a] = -Jtr[a];
            const delta = solveSpd(A, neg, K);
            const pNew = Float64Array.from(p);
            for (let a = 0; a < K; a++) pNew[a] += delta[a];
            if (cost(prob, pNew) < cost(prob, p)) {
                p = pNew;
                accepted = true;
                mu *= 1 / 3;
                nu = 2;
                for (let a = 0; a < K; a++) step = Math.max(step, Math.abs(delta[a]));
            } else {
                mu *= nu;
                nu *= 2;
            }
        }
        // no improving step or a below-tol step means a local minimum — LM
        // convergence. only exhausting maxIters is a non-converged stop.
        if (!accepted || step < stepTol) {
            converged = true;
            iters++;
            break;
        }
        // yield the accepted iterate — the animated driver writes it this frame.
        // (unreachable on the terminal iteration, which breaks above.)
        yield unpack(prob.base, prob.freed, p);
    }

    return { nodes: unpack(prob.base, prob.freed, p), iters, converged };
}

/**
 * synchronous drain of `lmSession` — one LM pass to a local minimum over the
 * frozen `counts`. see `lmSession` for the problem it solves; `converged` marks
 * LM reaching a local minimum, NOT a health signal (read `pointResidual`).
 */
export function solveTargets(
    base: readonly Node[],
    freed: readonly number[],
    counts: readonly number[],
    v0: number,
    targets: readonly PointTarget[],
    w: Weights = DEFAULT_WEIGHTS,
    maxIters = 120,
    stepTol = 1e-7,
): SolveResult {
    const gen = lmSession(base, freed, counts, v0, targets, w, maxIters, stepTol);
    let r = gen.next();
    while (!r.done) r = gen.next();
    return r.value;
}

// ── the fixpoint outer loop (one Solve invocation, spec §3) ───────────────────

/** a force demand in the AUTHORED domain: `g` at arclength `s` (m), weight `w`.
 *  the outer loop re-maps `s` to the nearest sample each round (the grid moves
 *  under the nodes), so it holds arclength, not a frozen sample index. */
export interface ArcTarget {
    s: number;
    g: number;
    w: number;
}

export interface FixpointResult {
    /** the best-iterate chain (min measured drift across the rounds). */
    nodes: Node[];
    /** outer rounds run. */
    rounds: number;
    /** max active drift (g) at the returned chain — the health surface. */
    maxDrift: number;
    /** the returned chain meets every demand within `driftTol`. */
    converged: boolean;
}

/** per-round node-move threshold (m for x/y, rad for θ) below which re-freezing
 *  the grid no longer changes the LM solution — the grid is self-consistent and
 *  the outer loop has reached its fixpoint. round-off scale on a ~100 m track,
 *  far below any real reshaping; a convergence test, not a physics tolerance. */
const POSE_EPS = 1e-6;

function poseDelta(a: readonly Node[], b: readonly Node[]): number {
    let mx = 0;
    for (let i = 0; i < a.length; i++)
        mx = Math.max(
            mx,
            Math.abs(a[i].x - b[i].x),
            Math.abs(a[i].y - b[i].y),
            Math.abs(a[i].theta - b[i].theta),
        );
    return mx;
}

/**
 * one Solve invocation as the §3 outer loop, as a resumable **stepwise session**
 * (spec §8): it delegates to `lmSession` each round (so every inner LM iterate is
 * re-yielded to the animated driver) and returns the `FixpointResult`.
 * `solveToFixpoint` is the synchronous drain — the tests and every non-animated
 * caller use it, and its final chain is byte-identical to the last stepped
 * iterate (the two share this body).
 *
 * the loop: freeze the sampling grid on the current chain, map each demand's
 * arclength to its nearest sample, run the LM, then re-freeze on the moved nodes
 * and re-measure the drift at the authored arclength — repeat to the fixpoint.
 *
 * why a loop and not one LM pass: a single pass converges essentially exactly
 * *on its frozen grid*, but node motion redistributes arclength under that grid,
 * so the frozen sample index no longer sits at the authored `s` — the re-baked
 * drift there can be worse than the start (the measured 0.60 g regression). the
 * loop drives that staleness out: it stops when the max active drift is within
 * `driftTol`, or the chain stops moving between rounds (an infeasible fixpoint),
 * keeping the best iterate.
 *
 * the prior re-anchors to each round's current chain (`lmSession`'s `base`).
 * measured: anchoring once to the invocation-start draft puts the draft-attractor
 * in tension with the grid re-freeze and the iteration limit-cycles (0.60 ↔ 0.19
 * g, never converges); re-anchoring lets the prior self-satisfy as the chain
 * settles, so the iteration is contractive and reaches the true fixpoint.
 * idempotent: a chain already within `driftTol` yields nothing and returns
 * unchanged at 0 rounds.
 */
export function* fixpointSession(
    chain: readonly Node[],
    freed: readonly number[],
    ds: number,
    v0: number,
    targets: readonly ArcTarget[],
    w: Weights = DEFAULT_WEIGHTS,
    driftTol = 0.05,
    maxRounds = 8,
): Generator<Node[], FixpointResult> {
    // max active drift at each demand's arclength on a fresh (re-frozen) bake.
    const measure = (nodes: readonly Node[]): number => {
        const { counts } = chainCounts(nodes, ds, MAX);
        const b = bakeNodes(nodes, counts, v0);
        const arc = sampleArc(b);
        let mx = 0;
        for (const t of targets)
            mx = Math.max(mx, Math.abs(b.fN[sampleAtArc(arc, b.n, t.s)] - t.g));
        return mx;
    };

    let current = chain.map((n) => ({ ...n }));
    let best = current.map((n) => ({ ...n }));
    let bestDrift = measure(current);
    let rounds = 0;
    while (bestDrift >= driftTol && rounds < maxRounds) {
        const { counts } = chainCounts(current, ds, MAX);
        const b = bakeNodes(current, counts, v0);
        const arc = sampleArc(b);
        const points: PointTarget[] = targets.map((t) => ({
            i: sampleAtArc(arc, b.n, t.s),
            g: t.g,
            w: t.w,
        }));
        // yield* re-yields every inner LM iterate and evaluates to the SolveResult.
        const solved = (yield* lmSession(current, freed, counts, v0, points, w)).nodes;
        const d = measure(solved);
        if (d < bestDrift) {
            best = solved;
            bestDrift = d;
        }
        rounds++;
        if (poseDelta(solved, current) < POSE_EPS) break; // grid self-consistent
        current = solved;
    }
    return { nodes: best, rounds, maxDrift: bestDrift, converged: bestDrift < driftTol };
}

/** synchronous drain of `fixpointSession` — the §3 Solve invocation run to its
 *  fixpoint in one call. the tests and non-animated callers use this. */
export function solveToFixpoint(
    chain: readonly Node[],
    freed: readonly number[],
    ds: number,
    v0: number,
    targets: readonly ArcTarget[],
    w: Weights = DEFAULT_WEIGHTS,
    driftTol = 0.05,
    maxRounds = 8,
): FixpointResult {
    const gen = fixpointSession(chain, freed, ds, v0, targets, w, driftTol, maxRounds);
    let r = gen.next();
    while (!r.done) r = gen.next();
    return r.value;
}
