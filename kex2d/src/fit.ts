/** dense recovered F_n → a SPARSE force profile in `profile.ts`'s representation
 *  (keyframes + explicit per-side tangents), so the fit is loadable as a force
 *  section. the full-free oracle's sparse initialization. pure and framework-free,
 *  f64 — kernel-atom family (`force.ts`, `collocate.ts`), NOT on the live path.
 *
 *  **this step alone is not a valid convert.** force error integrates twice (force →
 *  heading → position), so a profile that tracks the dense force curve to a fraction
 *  of a g can still swing the downstream geometry by meters. it is the warm start the
 *  constrained polish corrects.
 *
 *  the algorithm is standard curve fitting: error-driven knot placement (Schneider,
 *  Graphics Gems 1990 — split the worst piece at its max-error sample, top-down) over
 *  a per-piece linear least squares, then removal-counterfactual pruning (Lyche–Mørken
 *  1987 — drop a knot iff refitting its two neighbours as one piece still holds the
 *  tolerance). discrete split/merge with the counterfactual evaluated directly: the
 *  target is a known dense curve at ≤ tens of keyframes, so enumeration is cheap and
 *  the answer deterministic.
 *
 *  two structural choices make the fit linear and the round-trip exact:
 *
 *  - **every handle reaches exactly a third of its piece's span in s.** then `s(t)` is
 *    linear in the bezier parameter, so `g` is an ordinary cubic in `s` (the per-piece
 *    fit is a linear least squares in the Bernstein basis, no reparametrization loop),
 *    and the two reaches sum to ⅔ of the span, so `profile.segment`'s x-monotonicity
 *    clamp never fires — the production evaluator reproduces the fitted cubic verbatim.
 *  - **keyframes interpolate the dense curve**: a knot sits on a dense sample and takes
 *    its value, leaving only the two interior control points free per piece. so a piece's
 *    fit is local — nothing couples across a knot, and the removal counterfactual is one
 *    refit. per-side tangents stay independent (no C1 coupling): a recovered-force spike
 *    at an Auto↔explicit tangent boundary is a genuine kink, and `profile.ts` stores
 *    `in`/`out` per side anyway (the `Free` shape).
 *
 *  **the s-frame is the dense curve's own cumulative chord arclength**, σ_i = Σ_{k<i} ds_k
 *  — NOT `forceProfile`'s uniform σ_i = i·ds. on a geo bake the per-edge chords are only
 *  nominally ds (`sampleChain`'s adaptive counts: 0.214–0.664 m against a 0.5 nominal at
 *  the corpus's explicit-tangent nodes), so the two frames drift apart by up to ~1.2 m
 *  cumulatively and by ~20 g element-wise where the curve is steep. cumulative-chord σ is
 *  the deliberate choice: it places each keyframe at the arclength its force was actually
 *  recovered at, and re-integrating the fit through `evalForce` tracks the original
 *  geometry far better for it (loop-explicit: metres of deviation against tens of metres
 *  for a uniform-σ fit). the consequence is that resampling onto a force section's uniform
 *  grid shifts values — expected, and stage 3's business, since the polish measures
 *  geometry after integration rather than force element-wise.
 *
 *  no easing tag is stored — every side that drives a piece carries an explicit handle,
 *  so the tag never reaches `segment()`. This independent-handle fit is the full-free
 *  oracle's warm start. Shipping conversion instead calls `fitKnots` only for fixed-s
 *  initial values, strips every handle, and solves directly in the g-only flat family. */

import type { ForcePoint } from "./profile";

/** a fitted sparse profile + what the fit cost. `points.length` is the keyframe count. */
export interface Fit {
    /** ascending in s; the first keyframe sits at s = 0, the last at the final dense
     *  sample's arclength (`length` − the last edge's ds). values hold flat beyond
     *  either end, per `profile.sampleForce`. */
    points: ForcePoint[];
    /** the dense input's total arclength (m) — the section extent this profile spans. */
    length: number;
    /** max |fitted − dense| over every dense edge (g). */
    maxError: number;
    /** the dense edge index `maxError` sits at — −1 when no edge is off at all (an exact
     *  fit, or an empty input). */
    at: number;
    /** one entry per structural decision, in order: the opening single piece, then each
     *  accepted split, then each accepted prune. Empty only for an empty input. The LAST
     *  entry is the answer — `points`, `maxError`, and `at` are read off it, and `points`
     *  is that step's array by identity, so the trace can never disagree with the fit it
     *  traces. Treat the whole result as read-only: editing a returned keyframe in place
     *  would silently rewrite the trace's final frame. Copy before authoring on it. */
    steps: FitStep[];
}

/** which pass produced a step: the opening piece, a knot added, a knot removed. */
export type FitPhase = "init" | "split" | "prune";

/** the fit's state after one structural decision — what the pipeline playback draws. */
export interface FitStep {
    phase: FitPhase;
    /** dense sample indices of the knots, ascending; first 0, last `n − 1`. The knot's
     *  identity — `points[i]` is the same knot expressed in the profile representation. */
    knots: number[];
    /** the profile those knots fit, built exactly as the final answer is. */
    points: ForcePoint[];
    /** max |fitted − dense| over every dense edge at this step (g). */
    maxError: number;
    /** the dense edge index that error sits at; −1 when nothing is off. */
    at: number;
}

/** the fit's s-frame: the cumulative chord arclength of each dense sample, `σ_i =
 *  Σ_{k<i} ds_k`, length `ds.length`. The frame every `ForcePoint.s` this module emits is
 *  expressed in, and the one a caller placing its own knots addresses them by (`fitKnots`).
 *  Note the last entry is `length − ds[n−1]`, not `length` — a dense edge carries the force
 *  recovered at its LEADING sample, so the final knot sits one edge short of the extent and
 *  the profile holds flat over the remainder (`profile.sampleForce`).
 *
 * @example
 * const sigma = arclength(bake.ds);
 * const s = sigma[knot];
 */
export function arclength(ds: ArrayLike<number>): Float64Array {
    return sigmaOf("arclength", ds);
}

/** `arclength`, reporting under the caller's own name — so `fit`'s chord guard still says
 *  `fit:` rather than naming a helper the caller never called. */
function sigmaOf(who: string, ds: ArrayLike<number>): Float64Array {
    const n = ds.length;
    const sigma = new Float64Array(n);
    let total = 0;
    for (let i = 0; i < n; i++) {
        if (!(ds[i] > 0) || !Number.isFinite(ds[i]))
            throw new Error(`${who}: ds[${i}] is ${ds[i]}`);
        sigma[i] = total;
        total += ds[i];
    }
    return sigma;
}

const EPS = 1e-12;

/** singularity test for the 2×2 normal matrix: a rank-deficient pair's computed
 *  determinant is a cancellation residue of order EPSILON·a11·a22, and the few
 *  rounding steps that produce it keep it under 16× that. */
const DET_TOL = 16 * Number.EPSILON;

/** one fitted piece between two knots (dense indices `a` → `b`): its two interior
 *  control g's and the worst dense sample it leaves behind. */
interface Piece {
    a: number;
    b: number;
    p1g: number;
    p2g: number;
    err: number;
    at: number;
}

function bez(g0: number, p1g: number, p2g: number, g1: number, t: number): number {
    const u = 1 - t;
    return u * u * u * g0 + 3 * u * u * t * p1g + 3 * u * t * t * p2g + t * t * t * g1;
}

/** the least-squares interior control g's over dense indices [a, b], with the endpoints
 *  pinned to the data and both handles reaching span/3 in s (so t is (s−s_a)/span and the
 *  basis is Bernstein). three regimes, by how many interior samples constrain the pair:
 *  **none** → the chord (both controls on the straight line, an exactly linear g(s));
 *  **one** → the underdetermined system's minimum-norm correction to that chord, which
 *  INTERPOLATES the lone sample, so a two-edge piece is always exact and never splits;
 *  **two or more** → the normal equations, with the chord as the singular-matrix fallback. */
function lsq(fN: ArrayLike<number>, sigma: Float64Array, a: number, b: number): [number, number] {
    const ga = fN[a];
    const gb = fN[b];
    const span = sigma[b] - sigma[a];
    const chord: [number, number] = [ga + (gb - ga) / 3, gb - (gb - ga) / 3];
    if (b - a < 2 || span <= EPS) return chord;

    if (b - a === 2) {
        // one sample, two unknowns: among the corrections that hit it, take the one of
        // least norm — δ = y·(B1, B2)/(B1² + B2²), the pseudoinverse solution. measuring
        // the residual off the CHORD (not off zero) is what makes "least" mean "closest
        // to the straight line" instead of "closest to g = 0".
        const t = (sigma[a + 1] - sigma[a]) / span;
        const u = 1 - t;
        const b1 = 3 * u * u * t;
        const b2 = 3 * u * t * t;
        const q = b1 * b1 + b2 * b2;
        if (q <= EPS) return chord;
        // chord controls make g linear in t, so the chord's value at t is exact.
        const y = fN[a + 1] - (ga + (gb - ga) * t);
        return [chord[0] + (y * b1) / q, chord[1] + (y * b2) / q];
    }

    let a11 = 0;
    let a12 = 0;
    let a22 = 0;
    let r1 = 0;
    let r2 = 0;
    for (let j = a + 1; j < b; j++) {
        const t = (sigma[j] - sigma[a]) / span;
        const u = 1 - t;
        const b1 = 3 * u * u * t;
        const b2 = 3 * u * t * t;
        const y = fN[j] - u * u * u * ga - t * t * t * gb;
        a11 += b1 * b1;
        a12 += b1 * b2;
        a22 += b2 * b2;
        r1 += b1 * y;
        r2 += b2 * y;
    }
    const det = a11 * a22 - a12 * a12;
    if (!(Math.abs(det) > DET_TOL * a11 * a22)) return chord;
    return [(r1 * a22 - r2 * a12) / det, (r2 * a11 - r1 * a12) / det];
}

/** fit the piece over [a, b] and measure it: the max |fitted − dense| over its interior
 *  samples and where that sits (`at` = −1 when nothing is off). the knots themselves are
 *  exact by construction, so a nonzero error implies an interior sample and `at` is
 *  strictly inside — which is what makes the split loop terminate. */
function piece(fN: ArrayLike<number>, sigma: Float64Array, a: number, b: number): Piece {
    const [p1g, p2g] = lsq(fN, sigma, a, b);
    const span = sigma[b] - sigma[a];
    let err = 0;
    let at = -1;
    if (span > EPS) {
        for (let j = a + 1; j < b; j++) {
            const e = Math.abs(bez(fN[a], p1g, p2g, fN[b], (sigma[j] - sigma[a]) / span) - fN[j]);
            if (e > err) {
                err = e;
                at = j;
            }
        }
    }
    return { a, b, p1g, p2g, err, at };
}

/** the dense input validated into its s-frame — the one place `fit` and `fitKnots` agree on
 *  what a well-formed dense force curve is. */
function frame(
    who: string,
    fN: ArrayLike<number>,
    ds: ArrayLike<number>,
): { n: number; sigma: Float64Array; length: number } {
    const n = fN.length;
    if (ds.length !== n) throw new Error(`${who}: ${n} forces against ${ds.length} chords`);
    for (let i = 0; i < n; i++)
        if (!Number.isFinite(fN[i])) throw new Error(`${who}: fN[${i}] is ${fN[i]}`);
    const sigma = sigmaOf(who, ds);
    let length = 0;
    for (let i = 0; i < n; i++) length += ds[i];
    return { n, sigma, length };
}

/** the current piece list expressed as a step: the knots, the profile they fit, and the
 *  worst dense sample any piece leaves behind. Every side that drives a piece carries an
 *  explicit handle reaching span/3, so the profile is `profile.segment`-exact. */
function step(
    fN: ArrayLike<number>,
    sigma: Float64Array,
    pieces: readonly Piece[],
    phase: FitPhase,
): FitStep {
    const knots = [pieces[0].a];
    const points: ForcePoint[] = [{ s: sigma[pieces[0].a], g: fN[pieces[0].a] }];
    let maxError = 0;
    let at = -1;
    for (const p of pieces) {
        const reach = (sigma[p.b] - sigma[p.a]) / 3;
        points[points.length - 1].out = { ds: reach, dg: p.p1g - fN[p.a] };
        points.push({ s: sigma[p.b], g: fN[p.b], in: { ds: -reach, dg: p.p2g - fN[p.b] } });
        knots.push(p.b);
        if (p.err > maxError) {
            maxError = p.err;
            at = p.at;
        }
    }
    return { phase, knots, points, maxError, at };
}

/**
 * fit a sparse force profile to the dense per-edge force `fN` with per-edge chords `ds`
 * (a section bake's `fN`/`ds` — edge `i` carries the force recovered at its leading
 * sample, at arclength `σ_i = Σ_{k<i} ds_k`). every dense edge ends up within `tol` g of
 * the returned profile, at the fewest keyframes the split+prune pass reaches. throws on
 * an input the fit can't mean anything over: mismatched lengths, a negative or NaN `tol`,
 * a non-finite force, a non-finite or non-positive chord.
 *
 * @example
 * const r = evalGeo({ x: 0, y: 0, theta: 0, v: 20 }, nodes, 0.5);
 * const f = fit(r.fN, r.ds, 0.05);
 * // load it as a force section: the resample lands on the UNIFORM σ = i·ds a force
 * // section integrates, a different frame from the fit's cumulative chords, so expect
 * // the shift — never compare `dense` against `r.fN` element-wise.
 * const dense = forceProfile(f.points, f.length, 0.5);
 */
export function fit(fN: ArrayLike<number>, ds: ArrayLike<number>, tol: number): Fit {
    if (fN.length !== ds.length)
        throw new Error(`fit: ${fN.length} forces against ${ds.length} chords`);
    if (!(tol >= 0)) throw new Error(`fit: tol must be >= 0, got ${tol}`);
    const { n, sigma, length } = frame("fit", fN, ds);
    if (n === 0) return { points: [], length: 0, maxError: 0, at: -1, steps: [] };
    if (n === 1) {
        const points: ForcePoint[] = [{ s: 0, g: fN[0] }];
        const only: FitStep = {
            phase: "init",
            knots: [0],
            points,
            maxError: 0,
            at: -1,
        };
        return { points, length, maxError: 0, at: -1, steps: [only] };
    }

    // top-down: split the worst piece at its max-error sample until every dense edge
    // is within tol. a split touches only its own piece (knots interpolate the data,
    // sides are independent), and each half is strictly shorter, so the loop lands at
    // worst on a knot per dense sample.
    const pieces: Piece[] = [piece(fN, sigma, 0, n - 1)];
    const steps: FitStep[] = [step(fN, sigma, pieces, "init")];
    for (;;) {
        let worst = 0;
        for (let j = 1; j < pieces.length; j++) if (pieces[j].err > pieces[worst].err) worst = j;
        const p = pieces[worst];
        if (p.err <= tol) break;
        pieces.splice(worst, 1, piece(fN, sigma, p.a, p.at), piece(fN, sigma, p.at, p.b));
        steps.push(step(fN, sigma, pieces, "split"));
    }

    // removal counterfactual: drop the knot whose two pieces refit as one within tol,
    // cheapest first. greedy per pass because removals interact — refitting a merged
    // pair changes what its neighbours can absorb.
    for (;;) {
        let best = -1;
        let merged: Piece | null = null;
        for (let j = 0; j + 1 < pieces.length; j++) {
            const m = piece(fN, sigma, pieces[j].a, pieces[j + 1].b);
            if (m.err <= tol && (!merged || m.err < merged.err)) {
                best = j;
                merged = m;
            }
        }
        if (!merged) break;
        pieces.splice(best, 2, merged);
        steps.push(step(fN, sigma, pieces, "prune"));
    }

    const last = steps[steps.length - 1];
    return { points: last.points, length, maxError: last.maxError, at: last.at, steps };
}

/**
 * fit the same per-piece least squares at a PRESCRIBED knot set instead of searching for
 * one — the warm-start builder for a caller that owns knot placement itself (`refine.ts`,
 * whose split/prune loop chooses knots against the integrated geometry rather than against
 * the dense force). `knots` are dense sample indices, ascending, opening at 0 and closing
 * at `fN.length − 1`; the returned profile is built exactly as `fit`'s answer is, so it
 * lands in the span/3 reach family `polish` requires.
 *
 * Throws on the inputs `fit` throws on, plus a knot list that isn't a strictly ascending
 * run of in-range integers spanning the whole dense curve.
 *
 * @example
 * const f = fitKnots(bake.fN, bake.ds, [0, 40, bake.fN.length - 1]);
 * const p = polish({ bake, entry, points: f.points, ds });
 */
export function fitKnots(
    fN: ArrayLike<number>,
    ds: ArrayLike<number>,
    knots: readonly number[],
): Fit {
    if (fN.length !== ds.length)
        throw new Error(`fitKnots: ${fN.length} forces against ${ds.length} chords`);
    const { n, sigma, length } = frame("fitKnots", fN, ds);
    if (n < 2) throw new Error(`fitKnots: need >= 2 dense samples, got ${n}`);
    if (knots.length < 2) throw new Error(`fitKnots: need >= 2 knots, got ${knots.length}`);
    if (knots[0] !== 0 || knots[knots.length - 1] !== n - 1)
        throw new Error(
            `fitKnots: knots must span [0, ${n - 1}], got [${knots[0]}, ${knots[knots.length - 1]}]`,
        );
    for (let j = 0; j < knots.length; j++) {
        if (!Number.isInteger(knots[j])) throw new Error(`fitKnots: knot ${j} is ${knots[j]}`);
        if (j > 0 && !(knots[j] > knots[j - 1]))
            throw new Error(`fitKnots: knots must ascend, got ${knots[j - 1]} then ${knots[j]}`);
    }
    const pieces: Piece[] = [];
    for (let j = 0; j + 1 < knots.length; j++)
        pieces.push(piece(fN, sigma, knots[j], knots[j + 1]));
    const only = step(fN, sigma, pieces, "init");
    return { points: only.points, length, maxError: only.maxError, at: only.at, steps: [only] };
}
