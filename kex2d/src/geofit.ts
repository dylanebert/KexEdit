/** the reverse fit: a dense force section's swept geometry → a sparse `Auto`
 *  geo node chain (`{x, y, theta}`) that reproduces it under a dual budget —
 *  the observation-space twin of `refine.ts` (which fits sparse force
 *  keyframes to a dense geo bake). Pure, framework-free (mirrors `spline.ts` /
 *  `bake.ts` / `section.ts`); no ECS or editor import.
 *
 *  a candidate node is a literal PICK of a dense sample: its position is that
 *  sample's `(x, y)` and its heading is that sample's `bake.forces`-recovered
 *  theta (the unwrapped chord bisector, recovered once from the target here,
 *  never re-derived per candidate) — so the emitted chain interpolates the
 *  target exactly at every node and the last node's stored heading is the
 *  target's own recovered exit heading (`sampleChain` reads a tail node's
 *  theta verbatim; the editor's live re-head takes over from there). A
 *  candidate's own recovered force is evaluated by the same `forces()` the
 *  display bake uses, so the force budget is measured in the displayed
 *  quantity.
 *
 *  split-then-prune, mirroring `refine.ts`'s shape: open at the two
 *  endpoints, split at the worst-|ΔfN| sample (a geometric-deviation
 *  fallback when that site is already a node or has no interior room) until
 *  both budgets hold, then greedily prune — each round drops the interior
 *  node whose removal leaves the most slack, normalized per budget by its
 *  bound and combined by the tighter of the two, lowest node index on a tie.
 *  Every step is a closed-form sample/scan, so there is no solver and no
 *  async facade. */

import { forces } from "./bake";
import { type Node as SplineNode, sampleAt } from "./spline";

/** the dense force-section bake this fits against: positions + the
 *  geometry-recovered force it displays, per edge. `edges = x.length − 1 =
 *  fN.length = ds.length` (mirrors `section.SectionResult`, minus theta/v —
 *  the fit recovers its own theta from `x`/`y`, per the lock above). */
export interface GeofitBake {
    x: ArrayLike<number>;
    y: ArrayLike<number>;
    fN: ArrayLike<number>;
    ds: ArrayLike<number>;
    edges: number;
}

export interface GeofitNode {
    x: number;
    y: number;
    theta: number;
}

export type GeofitOutcome = "floor" | "budget" | "diverged";

export interface GeofitResult {
    /** the fitted chain, in the bake's own frame — node 0 lands on sample 0,
     *  the tail node on the last sample, its theta the recovered exit
     *  heading. */
    nodes: GeofitNode[];
    /** max positional deviation over every dense sample (m). */
    deviation: number;
    /** max |ΔfN| over every dense edge (g). */
    forceError: number;
    outcome: GeofitOutcome;
}

/** half the 1 m authoring quantum — the same half-quantum derivation as
 *  `refine.CONVERT_STEP`'s geometry floor. */
export const GEO_BUDGET = 0.5;
/** the force-fidelity budget (g). */
export const FORCE_BUDGET = 0.5;

interface Candidate {
    posX: Float32Array;
    posY: Float32Array;
    deviation: number;
    forceError: number;
    /** per-sample deviation, length `edges + 1`. */
    devArr: Float64Array;
    /** per-sample force error — an edge's |ΔfN| attributed to both its
     *  bordering samples — length `edges + 1`. */
    errArr: Float64Array;
}

function held(c: Candidate, geo: number, force: number): boolean {
    return (
        Number.isFinite(c.deviation) &&
        Number.isFinite(c.forceError) &&
        c.deviation <= geo &&
        c.forceError <= force
    );
}

/** recover the target's own continuous (unwrapped) heading via the same
 *  chord-bisector construction the display bake uses — never a wrapped
 *  atan2, which would break the arc rule past ±π on a loop. */
function recoverTheta(bake: GeofitBake, v0: number): Float32Array {
    const { edges } = bake;
    const posX = Float32Array.from({ length: edges + 1 }, (_, i) => bake.x[i]);
    const posY = Float32Array.from({ length: edges + 1 }, (_, i) => bake.y[i]);
    const dsArr = Float32Array.from({ length: edges }, (_, i) => bake.ds[i]);
    const theta = new Float32Array(edges + 1);
    const v = new Float32Array(edges + 1);
    const fN = new Float32Array(edges);
    forces(posX, posY, theta, v, fN, dsArr, 0, edges, v0);
    return theta;
}

/** sample the chain a knot set picks (`sampleAt`, the frozen-topology half of
 *  `sampleChain` — no arc-rule re-derivation), recover its own force, and
 *  scan both against the target at matching sample indices (each segment's
 *  edge count is frozen to exactly the target samples it spans, so index j
 *  addresses the same sample on both curves — no resampling/interpolation
 *  needed). */
function evaluate(
    bake: GeofitBake,
    theta: Float32Array,
    knots: readonly number[],
    v0: number,
): Candidate {
    const { edges } = bake;
    const nodes: SplineNode[] = knots.map((i) => ({ x: bake.x[i], y: bake.y[i], theta: theta[i] }));
    const counts = knots.slice(1).map((k, idx) => k - knots[idx]);
    const posX = new Float32Array(edges + 1);
    const posY = new Float32Array(edges + 1);
    const dsArr = new Float32Array(edges);
    sampleAt(nodes, counts, posX, posY, dsArr);

    const candTheta = new Float32Array(edges + 1);
    const candV = new Float32Array(edges + 1);
    const candFN = new Float32Array(edges);
    forces(posX, posY, candTheta, candV, candFN, dsArr, 0, edges, v0);

    const devArr = new Float64Array(edges + 1);
    let deviation = 0;
    for (let j = 0; j <= edges; j++) {
        const d = Math.hypot(bake.x[j] - posX[j], bake.y[j] - posY[j]);
        devArr[j] = d;
        if (d > deviation) deviation = d;
    }

    const errArr = new Float64Array(edges + 1);
    let forceError = 0;
    for (let k = 0; k < edges; k++) {
        const e = Math.abs(bake.fN[k] - candFN[k]);
        if (e > errArr[k]) errArr[k] = e;
        if (e > errArr[k + 1]) errArr[k + 1] = e;
        if (e > forceError) forceError = e;
    }

    return { posX, posY, deviation, forceError, devArr, errArr };
}

/** whether dense index `i` sits strictly between two consecutive knots — the
 *  only sites a split may land on. A knot itself, or a sample in a
 *  already-saturated (single-edge) span, has no such interval and is never
 *  admissible — the "already a node or adjacent" exclusion. */
function admissible(knots: readonly number[], i: number): boolean {
    for (let k = 0; k + 1 < knots.length; k++) if (knots[k] < i && i < knots[k + 1]) return true;
    return false;
}

/** the next split site: the worst-|ΔfN| sample when it's admissible, else
 *  the worst-deviation admissible sample (the geometric fallback). −1 when
 *  no admissible site remains anywhere (every span saturated). */
function splitSite(knots: readonly number[], c: Candidate): number {
    let worst = -1;
    let worstErr = -Infinity;
    for (let i = 0; i < c.errArr.length; i++) {
        if (c.errArr[i] > worstErr) {
            worstErr = c.errArr[i];
            worst = i;
        }
    }
    if (worst >= 0 && admissible(knots, worst)) return worst;

    let best = -1;
    let bestDev = -Infinity;
    for (let i = 0; i < c.devArr.length; i++) {
        if (!admissible(knots, i)) continue;
        if (c.devArr[i] > bestDev) {
            bestDev = c.devArr[i];
            best = i;
        }
    }
    return best;
}

function insertSorted(knots: readonly number[], site: number): number[] {
    const next = [...knots, site];
    next.sort((a, b) => a - b);
    return next;
}

function toNodes(bake: GeofitBake, theta: Float32Array, knots: readonly number[]): GeofitNode[] {
    return knots.map((i) => ({ x: bake.x[i], y: bake.y[i], theta: theta[i] }));
}

export function geofit(
    bake: GeofitBake,
    v0: number,
    budget: { geo?: number; force?: number } = {},
): GeofitResult {
    const { edges } = bake;
    if (!(edges >= 1)) throw new Error(`geofit: need >= 1 edge, got ${edges}`);
    const geo = budget.geo ?? GEO_BUDGET;
    const force = budget.force ?? FORCE_BUDGET;
    if (!(geo > 0) || !(force > 0) || !Number.isFinite(geo) || !Number.isFinite(force)) {
        throw new Error(`geofit: budgets must be finite and > 0, got geo=${geo} force=${force}`);
    }

    const theta = recoverTheta(bake, v0);

    let knots = [0, edges];
    let cur = evaluate(bake, theta, knots, v0);
    let outcome: GeofitOutcome = "floor";

    for (let round = 0; !held(cur, geo, force); round++) {
        if (!Number.isFinite(cur.deviation) || !Number.isFinite(cur.forceError) || round >= edges) {
            outcome = "diverged";
            break;
        }
        const site = splitSite(knots, cur);
        if (site < 0) {
            outcome = "budget";
            break;
        }
        knots = insertSorted(knots, site);
        cur = evaluate(bake, theta, knots, v0);
    }

    if (outcome === "floor")
        for (;;) {
            let bestKnots: number[] | null = null;
            let bestCandidate: Candidate | null = null;
            let bestSlack = -Infinity;
            for (let k = 1; k + 1 < knots.length; k++) {
                const next = knots.filter((_, index) => index !== k);
                const trial = evaluate(bake, theta, next, v0);
                if (!held(trial, geo, force)) continue;
                const slack = Math.min(1 - trial.deviation / geo, 1 - trial.forceError / force);
                if (slack > bestSlack) {
                    bestSlack = slack;
                    bestKnots = next;
                    bestCandidate = trial;
                }
            }
            if (bestCandidate === null || bestKnots === null) break;
            knots = bestKnots;
            cur = bestCandidate;
        }

    return {
        nodes: toNodes(bake, theta, knots),
        deviation: cur.deviation,
        forceError: cur.forceError,
        outcome,
    };
}
