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
 *  Jacobian is clean — the solve's sibling of the per-gesture display-mapping
 *  freeze. residuals: force rows over each target's interior + a weak draft
 *  prior (pull freed params toward their drafted values — the degeneracy
 *  regularizer and the "minimum deformation of what the author drew" intent) +
 *  a node-spacing term (adjacent freed chord vs draft — suppresses tangential
 *  bunching). LM with Marquardt diagonal scaling (the mixed-unit x/y/θ DOF want
 *  per-column scaling, unlike the dense kernel's μI). Validated the evidence
 *  gate in `tests/hill.lab.ts`; promoted here. */

import { forces64 } from "./force";
import { type Node, sampleAt } from "./spline";

const MAX = 4096;

// solve-local scratch for the frozen bake. the solve is synchronous and
// single-threaded (residual + FD-Jacobian evals all run inline), so one shared
// buffer set is safe and avoids per-eval allocation on the RTI hot path.
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

/** a span force target in the SOLVER domain: an inclusive interior sample-index
 *  span holding constant `g`, at fixed weight `w`. `targets.ts` converts the
 *  authored arclength span into this against the frozen bake. */
export interface SpanTarget {
    i0: number;
    i1: number;
    g: number;
    w: number;
}

/** the §5 auto-scope rule: node indices whose segments overlap [from,to] plus
 *  one neighbor each side, excluding the flat anchor (node 0). */
export function autoScope(nNodes: number, from: number, to: number): number[] {
    const lo = Math.max(1, from - 1);
    const hi = Math.min(nNodes - 1, to + 1);
    const out: number[] = [];
    for (let i = lo; i <= hi; i++) out.push(i);
    return out;
}

/** the freed-node set for an arclength span [s0,s1]: the nodes whose segments
 *  overlap the span, widened one neighbor each side (`autoScope`). the working
 *  set the stage-1 evidence gate validated — segments-overlapping-plus-one is
 *  what reaches the force-error budget. */
export function scopeForArc(b: Baked, arc: Float64Array, s0: number, s1: number): number[] {
    const nNode = b.offsets.length;
    let from = nNode - 1;
    let to = 0;
    let any = false;
    for (let k = 0; k < nNode - 1; k++) {
        const a = arc[b.offsets[k]];
        const c = arc[b.offsets[k + 1]];
        if (a < s1 && c > s0) {
            from = Math.min(from, k);
            to = Math.max(to, k + 1);
            any = true;
        }
    }
    if (!any) return [];
    return autoScope(nNode, from, to);
}

/** the interior sample-index span covering arclength [s0,s1]. */
export function samplesForArc(
    b: Baked,
    arc: Float64Array,
    s0: number,
    s1: number,
): { i0: number; i1: number } {
    const a = sampleAtArc(arc, b.n, s0);
    const c = sampleAtArc(arc, b.n, s1);
    return { i0: Math.min(a, c), i1: Math.max(a, c) };
}

/** mean F_n over an interior sample-index span — the "born satisfied" value a
 *  freshly created target takes (spec §Golden path 1: zero initial loss). */
export function spanMean(b: Baked, i0: number, i1: number): number {
    let sum = 0;
    let cnt = 0;
    for (let i = Math.max(1, i0); i <= Math.min(b.n - 2, i1); i++) {
        sum += b.fN[i];
        cnt++;
    }
    return cnt ? sum / cnt : 0;
}

/** fraction of a target span trimmed off both ends when reading the *interior*
 *  residual — a constant band meeting normal track is a curvature transition
 *  (a C¹ break), so the band edges carry an expected spike that is legible, not
 *  a representability failure. */
const TRIM = 0.2;

/** what a target actually achieves on baked geometry: the mean held force over
 *  its interior (the achieved-vs-target readout) and the max interior error
 *  (the drift/residual gap). */
export function spanResidual(b: Baked, t: SpanTarget): { achieved: number; err: number } {
    const trim = Math.floor((t.i1 - t.i0) * TRIM);
    let sum = 0;
    let cnt = 0;
    let err = 0;
    for (let i = t.i0; i <= t.i1; i++) {
        if (i >= t.i0 + trim && i <= t.i1 - trim) {
            sum += b.fN[i];
            err = Math.max(err, Math.abs(b.fN[i] - t.g));
            cnt++;
        }
    }
    return { achieved: cnt ? sum / cnt : t.g, err };
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
    targets: readonly SpanTarget[];
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
    for (const t of prob.targets)
        for (let i = t.i0; i <= t.i1; i++) rows.push(t.w * (b.fN[i] - t.g));
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
     *  exhausting `maxIters`. NOT a health signal — read `spanResidual` for
     *  whether the demand was met. */
    converged: boolean;
}

/**
 * solve the freed node parameters to satisfy all `targets` over the frozen
 * `counts`. assembles every target's force rows over the freed-node union in one
 * system (the coupled/composition case is one assembled problem, not per-target).
 * returns the full chain with the freed nodes updated; `base` is unmodified.
 *
 * `base` is the **draft**: it anchors the draft prior (the "minimum deformation
 * of what the author drew" pull) and the node-spacing reference. `warm` is the
 * starting iterate, defaulting to `base`; a live RTI drag passes the previous
 * frame's already-deformed chain as `warm` while keeping `base` pinned to the
 * gesture-start draft, so the prior stays anchored to the original shape instead
 * of re-basing (and smearing) toward each frame's iterate.
 *
 * `converged` marks LM reaching a local minimum; `converged` is not a health
 * signal — the caller reads `spanResidual` for the achieved force.
 */
export function solveTargets(
    base: readonly Node[],
    freed: readonly number[],
    counts: readonly number[],
    v0: number,
    targets: readonly SpanTarget[],
    w: Weights = DEFAULT_WEIGHTS,
    maxIters = 120,
    stepTol = 1e-7,
    warm?: readonly Node[],
): SolveResult {
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

    let p = Float64Array.from(warm ? pack(warm, freed) : p0);
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
    }

    return { nodes: unpack(prob.base, prob.freed, p), iters, converged };
}
