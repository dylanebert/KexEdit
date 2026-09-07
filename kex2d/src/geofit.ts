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
 *  theta verbatim; the editor's live re-head takes over from there).
 *
 *  **a candidate is scored on its OWN adaptive bake** — `chainCounts` +
 *  `sampleAt` + `forces`, the exact path `evalGeo` takes once the fit lands and
 *  the section re-bakes as geo. scoring at frozen target-matched counts
 *  (`sampleAt` at the knot gaps) measures a sampling the document never bakes:
 *  where the per-segment edge-count rule inflates the landed density, the extra
 *  edges carry force values the frozen scan never looks at, and the budget
 *  reads held while the timeline shows it blown (measured 0.40 g reported vs
 *  1.19 g displayed on an upstream-curved-hill + long force section, and a
 *  claimed `"floor"` at 0.39 g on one whose display read 6.06 g). The two
 *  bakes have different sample counts, so both budgets are compared on
 *  **absolute arclength from the section entry** — the timeline's own station
 *  axis, and the metric the document-layer fidelity oracle
 *  (`tests/forcegeo.test.ts`) reads. Normalizing each span by its own length
 *  was tried and is wrong: the fitted Hermite chain cuts corners, so it runs
 *  systematically short (~0.5 m over 100 m), and a per-span normalization
 *  divides that shortfall out — at a steep force gradient the drift IS the
 *  error (measured 0.48 g reported vs 1.57 g displayed on valley-explicit,
 *  4/10 corpus scenarios over budget).
 *
 *  split-then-prune, mirroring `refine.ts`'s shape: open at the two
 *  endpoints, split at the worst-|ΔfN| sample a split can use — not a node,
 *  not its neighbour (`splitSite`, where the adjacency exclusion and its
 *  geometric fallback are derived) — until both budgets hold, then greedily
 *  prune: each round drops the interior node whose removal leaves the most
 *  slack, normalized per budget by its bound and combined by the tighter of
 *  the two, lowest node index on a tie. Every step is a closed-form
 *  sample/scan, so there is no solver and no async facade. */

import { forces } from "./bake";
import { chainCounts, type Node as SplineNode, sampleAt } from "./spline";

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
    /** the geometric budget this fit actually ran against (m) — the resolved value, not the
     *  default constant, so a readout prints the bound the answer was judged by. */
    geoBudget: number;
    /** the force budget this fit actually ran against (g). */
    forceBudget: number;
}

/** half the 1 m authoring quantum — the same half-quantum derivation as
 *  `refine.CONVERT_STEP`'s geometry floor. */
export const GEO_BUDGET = 0.5;
/** the force-fidelity budget (g). */
export const FORCE_BUDGET = 0.5;

/** the nominal step the LANDED geo section bakes at — mirrors `track.DS_NOMINAL`. every section
 *  bakes at the track nominal unconditionally (no per-section step exists,
 *  `kex2d-correctness-fixes` stage 5), so the fitted chain does too; a caller that knows the live
 *  track passes it. */
const DS_NOMINAL = 0.5;
/** default sample-buffer ceiling — mirrors `track.MAX_SAMPLES` (and `section.MAX`). the landed
 *  section's real budget is what's left at its place in the chain; the invoking command passes
 *  that. */
const MAX = 4096;

export interface GeofitParams {
    /** max geometric deviation (m). */
    geo?: number;
    /** max recovered-force error (g). */
    force?: number;
    /** the nominal sampling step the landed geo section will bake at. */
    dsNominal?: number;
    /** the sample budget the landed section has at its place in the chain. */
    maxSamples?: number;
}

/** a scored candidate: the two budget readings, plus whether the landed chain bakes at all
 *  (`chainCounts` valid and inside the sample budget). an unusable candidate scores infinite on
 *  both budgets, so it never holds and is never committed — but it is not a divergence:
 *  splitting it further is exactly how a chain whose two endpoints happen to coincide (a closed
 *  loop) becomes bakeable. */
interface Candidate {
    usable: boolean;
    deviation: number;
    forceError: number;
}

/**
 * every buffer an `evaluate` needs, allocated once per `geofit` call and reused.
 *
 * the fit runs O(nodes²) evaluates (the prune probes every interior removal each round) and each
 * one touches both bakes end to end, so a per-evaluate allocation of ~a dozen buffers is the
 * fit's whole garbage profile — inside a worker that matters beyond the ~10% it measures on the
 * corpus (364 → 326 ms). reuse changes no arithmetic: every buffer is fully written before it is
 * read, over an explicit length, and the corpus output is bit-identical either way.
 *
 * **`devArr`/`errArr` describe the MOST RECENT evaluate only.** They are the residual profile a
 * split site is chosen from, and the split loop reads them between one evaluate and the next;
 * the prune never reads them. That ordering is the contract — a reader that needs a profile to
 * survive another evaluate must copy it.
 */
interface Scratch {
    cx: Float32Array;
    cy: Float32Array;
    cds: Float32Array;
    cTheta: Float32Array;
    cV: Float32Array;
    cFN: Float32Array;
    /** the candidate's per-sample cumulative arclength from the entry — the station axis both
     *  budgets are compared on. */
    cumC: Float64Array;
    /** the target's, same axis. Knot-independent, so it is filled once. */
    cumT: Float64Array;
    /** per-TARGET-sample deviation / force error. every measurement — including the ones taken at
     *  the candidate's own stations — is attributed to the target sample(s) bordering it, because
     *  a split site is a target sample index. */
    devArr: Float64Array;
    errArr: Float64Array;
    /** the fraction out-param of `bracket` (a returned object per station would be an allocation
     *  per sample per pass). */
    frac: { u: number };
}

function scratchFor(edges: number, maxSamples: number): Scratch {
    return {
        cx: new Float32Array(maxSamples),
        cy: new Float32Array(maxSamples),
        cds: new Float32Array(maxSamples - 1),
        cTheta: new Float32Array(maxSamples),
        cV: new Float32Array(maxSamples),
        cFN: new Float32Array(maxSamples - 1),
        cumC: new Float64Array(maxSamples),
        cumT: new Float64Array(edges + 1),
        devArr: new Float64Array(edges + 1),
        errArr: new Float64Array(edges + 1),
        frac: { u: 0 },
    };
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

/** cumulative arclength over a per-edge chord array, into `cum[0..edges]`. */
function arclength(ds: ArrayLike<number>, edges: number, cum: Float64Array): void {
    cum[0] = 0;
    for (let i = 0; i < edges; i++) cum[i + 1] = cum[i] + ds[i];
}

/** the interval of the sorted `tau` (length `n`) holding query `q`, scanned forward from
 *  `from` — queries arrive sorted, so a whole pass is one walk. the fraction into that interval
 *  lands in `frac.u`, clamped, so a query past either end reads as the end value. */
function bracket(
    tau: Float64Array,
    n: number,
    q: number,
    from: number,
    frac: { u: number },
): number {
    if (n < 2) {
        frac.u = 0;
        return 0;
    }
    let i = from;
    while (i + 1 < n - 1 && tau[i + 1] < q) i++;
    const span = tau[i + 1] - tau[i];
    frac.u = span > 0 ? Math.min(1, Math.max(0, (q - tau[i]) / span)) : 0;
    return i;
}

/** the value of `arr` at a `bracket` reading. `u === 0` reads the station itself, so a
 *  single-station series (a one-edge candidate) never touches the absent neighbour. */
function lerp(arr: ArrayLike<number>, i: number, u: number): number {
    return u === 0 ? arr[i] : arr[i] + u * (arr[i + 1] - arr[i]);
}

/** the chain a knot set picks: each node is a literal pick of a dense sample (position + the
 *  target's own recovered theta). the same construction feeds `evaluate`'s scoring bake and the
 *  emitted answer, so what was scored is what lands. */
function toNodes(bake: GeofitBake, theta: Float32Array, knots: readonly number[]): GeofitNode[] {
    return knots.map((i) => ({ x: bake.x[i], y: bake.y[i], theta: theta[i] }));
}

const UNUSABLE: Candidate = {
    usable: false,
    deviation: Number.POSITIVE_INFINITY,
    forceError: Number.POSITIVE_INFINITY,
};

/**
 * bake the chain a knot set picks the way the DOCUMENT will (`chainCounts` adaptive counts →
 * `sampleAt` → `forces`, exactly `evalGeo`'s path), then score it against the target on absolute
 * arclength from the entry.
 *
 * both budgets are measured over the UNION of the two curves' stations: each curve's own
 * stations, with the other linearly interpolated at the same arclength. one-sided scoring steps
 * over whatever the other curve carries between its neighbours — and the candidate is the denser
 * side exactly where the edge-count rule inflates it, which is where the displayed error lives.
 *
 * A per-sample deviation reads at the sample's own arclength; a per-edge `fN` reads at its LEFT
 * sample's arclength, the convention `bake.forces` computes it under (`fN[i]` is built from
 * `theta[i]`, `theta[i+1]`, `ds[i]`, and is what the timeline draws at station i).
 *
 * Writes the residual profile into `sc.devArr` / `sc.errArr` (see `Scratch`).
 */
function evaluate(
    bake: GeofitBake,
    theta: Float32Array,
    knots: readonly number[],
    v0: number,
    dsNominal: number,
    maxSamples: number,
    sc: Scratch,
): Candidate {
    const { edges } = bake;
    const nodes: SplineNode[] = toNodes(bake, theta, knots);

    const { counts, valid, truncated } = chainCounts(nodes, dsNominal, maxSamples);
    if (!valid || truncated || counts.length !== nodes.length - 1) return UNUSABLE;
    let cEdges = 0;
    for (const m of counts) cEdges += m;
    if (cEdges < 1) return UNUSABLE;

    const { cx, cy, cds, cFN, cumT, cumC, devArr, errArr, frac } = sc;
    sampleAt(nodes, counts, cx, cy, cds);
    forces(cx, cy, sc.cTheta, sc.cV, cFN, cds, 0, cEdges, v0);

    arclength(cds, cEdges, cumC);

    devArr.fill(0, 0, edges + 1);
    errArr.fill(0, 0, edges + 1);

    // pass 1 — at the target's own stations, the candidate interpolated there.
    let cursor = 0;
    for (let i = 0; i <= edges; i++) {
        const j = bracket(cumC, cEdges + 1, cumT[i], cursor, frac);
        cursor = j;
        const d = Math.hypot(bake.x[i] - lerp(cx, j, frac.u), bake.y[i] - lerp(cy, j, frac.u));
        if (d > devArr[i]) devArr[i] = d;
    }
    cursor = 0;
    for (let k = 0; k < edges; k++) {
        const j = bracket(cumC, cEdges, cumT[k], cursor, frac);
        cursor = j;
        const e = Math.abs(bake.fN[k] - lerp(cFN, j, frac.u));
        if (e > errArr[k]) errArr[k] = e;
        if (e > errArr[k + 1]) errArr[k + 1] = e;
    }

    // pass 2 — at the candidate's own stations, the target interpolated there. the measurement
    // is attributed to the target samples bracketing it.
    cursor = 0;
    for (let j = 0; j <= cEdges; j++) {
        const i = bracket(cumT, edges + 1, cumC[j], cursor, frac);
        cursor = i;
        const d = Math.hypot(cx[j] - lerp(bake.x, i, frac.u), cy[j] - lerp(bake.y, i, frac.u));
        if (d > devArr[i]) devArr[i] = d;
        const nxt = Math.min(i + 1, edges);
        if (d > devArr[nxt]) devArr[nxt] = d;
    }
    cursor = 0;
    for (let j = 0; j < cEdges; j++) {
        const i = bracket(cumT, edges, cumC[j], cursor, frac);
        cursor = i;
        const e = Math.abs(cFN[j] - lerp(bake.fN, i, frac.u));
        // the two target force stations bracketing the query carry it, so a split can land on
        // either side of the site.
        const nxt = Math.min(i + 1, edges);
        if (e > errArr[i]) errArr[i] = e;
        if (e > errArr[nxt]) errArr[nxt] = e;
    }

    let deviation = 0;
    for (let i = 0; i <= edges; i++) if (devArr[i] > deviation) deviation = devArr[i];
    let forceError = 0;
    for (let i = 0; i <= edges; i++) if (errArr[i] > forceError) forceError = errArr[i];

    return { usable: true, deviation, forceError };
}

/** the interior sample halfway through the widest remaining span — the split guidance an
 *  unusable candidate can't give from a residual profile it never produced. −1 when every span
 *  is saturated. */
function widestMid(knots: readonly number[]): number {
    let site = -1;
    let widest = 1;
    for (let k = 0; k + 1 < knots.length; k++) {
        const width = knots[k + 1] - knots[k];
        if (width > widest) {
            widest = width;
            site = knots[k] + (width >> 1);
        }
    }
    return site;
}

/**
 * the next split site: the worst-|ΔfN| sample a split can actually use, else the worst-deviation
 * one (the geometric fallback). −1 when no span has interior room left. reads the residual
 * profile of the MOST RECENT `evaluate` (`Scratch`), which is `c`'s — the split loop calls this
 * between one evaluate and the next.
 *
 * **The criterion follows the budget that is actually violated.** A candidate over only the
 * geometric budget carries a force profile that is everywhere inside its bound, so ranking those
 * values picks a site by whatever float noise separates them — the deviation profile is the one
 * carrying signal there, and it is what the geometric search below reads.
 *
 * **The force criterion skips a knot AND its two neighbours**, the lock's "already a node or
 * adjacent" exclusion. It is load-bearing under the adaptive scoring: the worst |ΔfN| routinely
 * sits at a C1 node join (the dialect's accepted ringing, and the join is where the candidate's
 * own bake is densest), and a node placed against that join just moves it — the loop then crawls
 * sample by sample without reducing anything the prune later keeps. Measured on a 1000-edge
 * oscillating section: 351 split nodes and 35 s with the neighbour admitted, 9 nodes and 0.2 s
 * without, the same 7-node answer either way.
 *
 * And it searches for the worst *usable* force site rather than testing the global worst and
 * falling through to geometry when that one is excluded — the fallback is for a span with no
 * room left, not the common path, since geometry-driven placement is ~5× worse per node at force
 * fidelity (the spec's criterion sweep). The geometric fallback keeps the wider admissibility
 * (any interior sample), so saturation still terminates.
 */
function splitSite(knots: readonly number[], c: Candidate, sc: Scratch, force: number): number {
    if (!c.usable) return widestMid(knots);
    if (c.forceError > force) {
        let worst = -1;
        let worstErr = -Infinity;
        for (let k = 0; k + 1 < knots.length; k++) {
            for (let i = knots[k] + 2; i < knots[k + 1] - 1; i++) {
                if (sc.errArr[i] > worstErr) {
                    worstErr = sc.errArr[i];
                    worst = i;
                }
            }
        }
        if (worst >= 0) return worst;
    }

    let best = -1;
    let bestDev = -Infinity;
    for (let k = 0; k + 1 < knots.length; k++) {
        for (let i = knots[k] + 1; i < knots[k + 1]; i++) {
            if (sc.devArr[i] > bestDev) {
                bestDev = sc.devArr[i];
                best = i;
            }
        }
    }
    return best;
}

function insertSorted(knots: readonly number[], site: number): number[] {
    const next = [...knots, site];
    next.sort((a, b) => a - b);
    return next;
}

export function geofit(bake: GeofitBake, v0: number, params: GeofitParams = {}): GeofitResult {
    const { edges } = bake;
    if (!(edges >= 1)) throw new Error(`geofit: need >= 1 edge, got ${edges}`);
    const geo = params.geo ?? GEO_BUDGET;
    const force = params.force ?? FORCE_BUDGET;
    if (!(geo > 0) || !(force > 0) || !Number.isFinite(geo) || !Number.isFinite(force)) {
        throw new Error(`geofit: budgets must be finite and > 0, got geo=${geo} force=${force}`);
    }
    const dsNominal = params.dsNominal ?? DS_NOMINAL;
    const maxSamples = params.maxSamples ?? MAX;
    if (!(dsNominal > 0) || !Number.isFinite(dsNominal) || !(maxSamples >= 2)) {
        throw new Error(
            `geofit: sampling must be a positive step and >= 2 samples, got dsNominal=${dsNominal} maxSamples=${maxSamples}`,
        );
    }

    const theta = recoverTheta(bake, v0);
    const sc = scratchFor(edges, maxSamples);
    arclength(bake.ds, edges, sc.cumT); // knot-independent — filled once, read by every evaluate
    const score = (knots: readonly number[]): Candidate =>
        evaluate(bake, theta, knots, v0, dsNominal, maxSamples, sc);

    let knots = [0, edges];
    let cur = score(knots);
    let outcome: GeofitOutcome = "floor";

    for (let round = 0; !held(cur, geo, force); round++) {
        if (Number.isNaN(cur.deviation) || Number.isNaN(cur.forceError) || round >= edges) {
            outcome = "diverged";
            break;
        }
        const site = splitSite(knots, cur, sc, force);
        if (site < 0) {
            outcome = cur.usable ? "budget" : "diverged";
            break;
        }
        knots = insertSorted(knots, site);
        cur = score(knots);
    }

    if (outcome === "floor")
        for (;;) {
            let bestKnots: number[] | null = null;
            let bestCandidate: Candidate | null = null;
            let bestSlack = -Infinity;
            for (let k = 1; k + 1 < knots.length; k++) {
                const next = knots.filter((_, index) => index !== k);
                const trial = score(next);
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
        geoBudget: geo,
        forceBudget: force,
    };
}
