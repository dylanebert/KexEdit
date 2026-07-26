/** the UNIFIED REFINE LOOP: discrete outer refinement around the continuous polish, so the
 *  conversion tier chooses WHERE the keys go instead of inheriting them from the warm-start
 *  fit. The conversion tier's stage 3 (`specs/kex2d-geoforce-convert.md`) — pure,
 *  framework-free, f64, kernel-atom family (`fit.ts`, `polish.ts`), NOT on the live path.
 *
 *  `fit.ts` places knots against the DENSE FORCE curve, which is the wrong target: force
 *  error integrates twice, so tracking it to a fraction of a g says nothing about where the
 *  geometry needs resolution. `polish.ts` then moves values at those fixed knots, and when
 *  they are wrong for the true objective its only absorber is handle contortion. This loop
 *  closes that gap — it solves, reads where the residual actually sits, and moves the knots
 *  there.
 *
 *  **The objective: discrepancy-constrained minimal keys.** Hold the geometry deviation at
 *  or under the derived authoring floor (`polish.authoringFloor` — the discretization
 *  mismatch plus the readout's resolution) with the FEWEST keys. Not "minimize deviation":
 *  below the floor the residual carries no information an author could see, and every key
 *  spent there is authoring surface bought with nothing. The rule is parameter-free — there
 *  is no split price, no prune price, and no error-per-key exchange rate, because the floor
 *  is a constraint rather than a term.
 *
 *  **Top-down, not fit-down.** The loop opens at TWO keys (the profile's two ends) and
 *  splits toward the floor — Schneider's recursive fit-split-fit, and hp-adaptive mesh
 *  refinement's solve-coarse-estimate-refine-resolve (Betts; GPOPS-II), which is what direct
 *  collocation practice does with exactly this problem shape. Growing into the answer rather
 *  than pruning down to it is also what makes the loop affordable: nearly every solve it
 *  runs is over a handful of keys.
 *
 *  **Split, then prune, and the hysteresis between them.** A split fires only while the
 *  floor is VIOLATED; a prune is accepted only when its removal counterfactual still HOLDS
 *  the floor. The two rules read the same number from opposite sides, so an accepted prune
 *  lands in a state where the split trigger is false by construction — the phases cannot
 *  hand work back to each other, and the band needs no width to separate them. The prune
 *  phase is entered only from a state that holds the floor, so a refinement that ended
 *  un-authorable is never thinned further.
 *
 *  **Every accept is made under the true objective**, never a proxy. A split trial and a
 *  removal counterfactual are each a real `polish` solve of the candidate knot set, judged on
 *  the geometry its spine tracks; and the prune scan is exhaustive, because ordering
 *  candidates by anything cheaper would let that proxy pick which key dies, and with it every
 *  counterfactual evaluated afterwards. The prune WINNER is the one place the objective does
 *  not decide: every holding removal drops exactly one key, so minimal-keys is indifferent
 *  among them and a tiebreak has to choose. It is declared rather than derived (see the prune
 *  block), and it steers the trajectory — so the loop is greedy single-removal descent to a
 *  local minimum in keys, not a proof of the global one.
 *
 *  **The probe is unregularized, and that is the point.** A candidate evaluation asks one
 *  question — CAN this knot set reach the floor? — and the answer is the tightest geometry
 *  the family holds, which is the λ = 0 solve. So the loop probes at λ = 0 (one solve) and
 *  spends the full discrepancy λ-search (up to `LAM_STEPS + 2` solves, seconds each in the
 *  aligned family) exactly once, on the settled state. Two things fall out. The cost: a
 *  candidate costs a tenth of an answer, which is what makes the loop affordable at all.
 *  And the attribution: a λ-searched probe would confound "these knots cannot hold the
 *  floor" with "this λ is too strong", and the loop would then split to fix the regularizer.
 *  The screen leans on deviation(λ = 0) ≤ deviation(λ), which is generic rather than proven
 *  (the tracking loss is minimized at λ = 0, but `deviation` is a max over samples, not that
 *  loss) — the same approximate monotonicity `polish`'s own bisection rests on, and it costs
 *  the same thing when it blips: a knot set wrongly screened out just gets one more split,
 *  never a wrong answer, because the final search re-verifies against the floor itself.
 *
 *  **Every SPLIT is judged in the region it touches, not globally.** A split is a LOCAL
 *  refinement, so the question it answers is whether the residual went down where it landed.
 *  The global max is dominated by whichever segment is currently worst, which is usually not
 *  the one just refined, so a working split routinely leaves it flat or nudges it up — and a
 *  global test reads that as a stall and pays for a corner it does not need. Measured by
 *  running the whole corpus under the global rule (`worked = trial.deviation < cur.deviation`):
 *  4 of 10 scenarios plant a spurious corner that the local rule avoids, and two of them also
 *  spend a key for it — `double-hump` 15 keys against 14, `loop-explicit` 14 against 13.
 *
 *  **Corners are stall-TRIGGERED and peak-LOCATED, and they answer globally.** A broken key
 *  (`polish.Corners`) is the one discrete state the continuous solve cannot wander into, and
 *  the loop introduces it only when splitting STALLS — when a split fails to reduce the
 *  residual in its own region. That is the signature of a slope discontinuity in the target:
 *  more resolution either side of a corner buys nothing, because the aligned family cannot
 *  bend there at any density. Stall is an outcome, not a threshold — nothing is detected,
 *  measured against a bar, or tuned. But the stall only says resolution has stopped paying;
 *  it does not say WHERE the target breaks. That is the global residual argmax, so the corner
 *  goes to the interior knot nearest it and must lower the global deviation to be kept. This
 *  is the one place the loop reasons globally, and it is the only decision here that is about
 *  the target rather than about the mesh.
 *
 *  Both halves of that were measured on the sharp-valley fixture, whose one genuine slope
 *  break sits at arclength ~15 m. Judging the corner LOCALLY over the two segments it joins
 *  is what let it pass for free: at floor 0.05 every accepted corner cleared a local test in
 *  a region the stall never implicated, while the stalled site went on stalling round after
 *  round. Locating it in the STALLED segment instead is coherent but wrong about the shape —
 *  it spends corners wherever splitting last ran out (the flat tail, knots 45/55/61), and at
 *  floor 0.12 it never reaches the floor at all (0.131 m, 26 keys), where locating at the
 *  peak breaks the three knots bracketing the V and holds it with SIX. If no interior knot is
 *  left to break, the split is taken anyway and the loop presses on: the floor is still
 *  violated, and the rule is to split while it is.
 *
 *  **Termination is the floor or the budget, never a stall.** The loop stops when the floor
 *  holds, or when no segment can carry another knot. The second is the honest un-authorable
 *  outcome the authorability directive sanctions — a spike narrower than the authoring grid
 *  is approximated away, not chased — and it is reported as `"budget"`, kept apart from
 *  `"diverged"`, which is a probe whose residual profile came back unreadable and is a defect
 *  to surface. Both come back `heldFloor` false, so `RefineResult.outcome` is what tells them
 *  apart. `"diverged"` is DEFENSIVE: it has never been observed firing, on the corpus or on
 *  the fixtures, including deliberate attempts to provoke it.
 *
 *  **The key budget is derived, not set.** A segment earns a split only if BOTH halves keep an
 *  interior sample of the uniform grid the force is integrated on. An open interval of
 *  arclength `2·ds` contains a multiple of `ds` at ANY phase, so `2·ds` is the tight
 *  phase-free bound for that — below it whether a child brackets a sample depends on where the
 *  grid happens to fall, and a child that brackets none drives no force the geometry can see
 *  while `polish.fairRows`'s `1/span³` still prices its curvature against its parent's by the
 *  cube of their ratio. The budget is what that admissibility rule leaves, and the loop
 *  reports `"budget"` when it runs out.
 *
 *  **Deterministic.** Same bake, same answer: every argmax breaks ties toward the lower
 *  index, both sorts break ties on the index they are ordering, and `polish` carries no
 *  randomness. */

import { arclength, fitKnots } from "./fit";
import {
    authoringFloor,
    type Bake,
    type Corners,
    polish,
    type PolishResult,
    spine,
} from "./polish";
import type { Entry } from "./section";

/** the arclength frame every placement rule below reads: the dense samples' own arclengths
 *  (`fit.arclength`), the uniform spine step the deviation profile is indexed on, and the
 *  observability floor a split must clear. Bundled because the rules are pure functions of it
 *  — which is what lets them be tested without a 30-second corpus solve. */
export interface Frame {
    sigma: Float64Array;
    /** the spine's realized step, so spine sample `j` sits at arclength `j·ds`. */
    ds: number;
    /** the shortest segment a split may leave: `2·ds` (see `siteIn`). */
    minSpan: number;
}

/** one segment's residual reading. */
export interface Seg {
    /** the worst spine deviation inside the segment (m). */
    worst: number;
    /** the arclength that HALVES the segment's integrated residual. */
    half: number;
}

/** per segment: the worst spine deviation inside it, and the arclength that halves its
 *  integrated residual. Samples past the last knot belong to the last segment — that stretch
 *  is the flat hold the final key drives (`fit.arclength`).
 *
 *  The two readings answer different questions and the split uses both. `worst` says where the
 *  discrepancy constraint BINDS, so it picks the segment. `half` says where to cut it: de
 *  Boor's equidistribution principle, the standard adaptive-mesh placement — put the knot where
 *  each child inherits half the work. Splitting at the residual PEAK instead is Schneider's
 *  rule for fitting a curve to data, and it is wrong under this prior: a peak sitting near an
 *  existing knot puts the new one right beside it, and the fairing energy's `1/span³` scaling
 *  then prices the sliver against its neighbour by the cube of their ratio. Measured on
 *  `full-loop`, peak-splitting produced 1.0 m segments beside a 35.4 m one — a 44,000× pricing
 *  disparity — and the discrepancy search collapsed λ from 1.1e-3 to 2.9e-9 to afford the
 *  slivers any curvature at all, which is no regularization anywhere: the dense peak went
 *  6.1 → 24.2 g. Equidistribution cannot produce that, because a child can only be short where
 *  the residual it carries is concentrated enough to earn it.
 *
 * @example
 * const segs = residual(frame, knots, result.deviations);
 */
export function residual(f: Frame, knots: readonly number[], devs: ArrayLike<number>): Seg[] {
    // `worst` opens at 0, the honest reading for a segment bracketing no sample — a deviation
    // is never negative, and a sentinel below zero would make `over` score an unobservable
    // region as an improvement. `half` opens at the segment MIDPOINT, which is where
    // equidistribution lands when the residual is uniform and, in particular, when it is
    // identically zero: leaving it at 0 would send `siteIn` to the leftmost admissible index,
    // the sliver placement this rule exists to prevent.
    const segs = knots.slice(0, -1).map((_, k) => ({
        worst: 0,
        half: 0.5 * (f.sigma[knots[k]] + f.sigma[knots[k + 1]]),
        sum: 0,
    }));
    const seg = (a: number, k: number): number => {
        while (k + 2 < knots.length && f.sigma[knots[k + 1]] <= a) k++;
        return k;
    };
    let k = 0;
    for (let j = 1; j < devs.length; j++) {
        k = seg(j * f.ds, k);
        segs[k].sum += devs[j];
        segs[k].worst = Math.max(segs[k].worst, devs[j]);
    }
    const run = segs.map(() => 0);
    k = 0;
    for (let j = 1; j < devs.length; j++) {
        const a = j * f.ds;
        k = seg(a, k);
        if (segs[k].sum > 0 && run[k] < 0.5 * segs[k].sum) segs[k].half = a;
        run[k] += devs[j];
    }
    return segs;
}

/** the admissible dense index nearest arclength `a` strictly inside `(prev, next)`, or −1 when
 *  the segment is too short to carry one.
 *
 *  Admissible means both halves keep at least `minSpan = 2·ds` of arclength. An open interval
 *  that long contains a multiple of `ds` at ANY phase, so it is the tight phase-free bound for
 *  "each child still brackets an interior sample of the grid the force is integrated on" —
 *  derived, not chosen. Below it a child's shape drives no sample the geometry can see, and
 *  `polish.fairRows`'s `1/span³` would price its curvature against its parent's by the cube of
 *  their ratio for nothing. */
export function siteIn(f: Frame, prev: number, next: number, a: number): number {
    let best = -1;
    let bestD = Number.POSITIVE_INFINITY;
    for (let i = prev + 1; i < next; i++) {
        if (f.sigma[i] - f.sigma[prev] < f.minSpan) continue;
        // sigma ascends, so once the right half is too short every later index is too.
        if (f.sigma[next] - f.sigma[i] < f.minSpan) break;
        const d = Math.abs(f.sigma[i] - a);
        if (d < bestD) {
            bestD = d;
            best = i;
        }
    }
    return best;
}

/** where to split: the worst segment that can carry a knot, at its own equidistribution point.
 *  `seg` is that segment's index — the region the trial is then judged in — and `segs` is the
 *  residual reading it came from, so the caller need not recompute it. `site` is −1 when no
 *  segment can carry another knot, which is the derived key budget. */
export function splitSite(
    f: Frame,
    knots: readonly number[],
    devs: ArrayLike<number>,
): { site: number; seg: number; segs: Seg[] } {
    const segs = residual(f, knots, devs);
    const order = segs.map((_, k) => k);
    order.sort((x, y) => segs[y].worst - segs[x].worst || x - y);
    for (const k of order) {
        const i = siteIn(f, knots[k], knots[k + 1], segs[k].half);
        if (i >= 0) return { site: i, seg: k, segs };
    }
    return { site: -1, seg: -1, segs };
}

/** the worst residual across a run of segments — the reading a local trial has to move. */
export function over(segs: readonly Seg[], lo: number, hi: number): number {
    let w = 0;
    for (let k = Math.max(0, lo); k <= Math.min(segs.length - 1, hi); k++)
        w = Math.max(w, segs[k].worst);
    return w;
}

/** where to break: the interior knot nearest the GLOBAL residual peak that is not a corner
 *  already, or −1 when every interior knot is one.
 *
 *  Global, unlike every split rule in this module, because a corner is not a refinement — it
 *  is a claim about the TARGET, that its slope breaks somewhere, and a slope break shows up
 *  as the residual argmax of the whole profile rather than of whichever segment happened to
 *  stall. The stall only says resolution has stopped paying, so it is the trigger; the peak
 *  is the locator. And what the corner is judged against is global too, for the same reason —
 *  see `refine`. */
export function cornerSite(
    f: Frame,
    knots: readonly number[],
    cornerKnots: readonly number[],
    devs: ArrayLike<number>,
): number {
    let peak = -1;
    let a = 0;
    for (let j = 1; j < devs.length; j++)
        if (devs[j] > peak) {
            peak = devs[j];
            a = j * f.ds;
        }
    let best = -1;
    let bestD = Number.POSITIVE_INFINITY;
    for (let k = 1; k + 1 < knots.length; k++) {
        if (cornerKnots.includes(knots[k])) continue;
        const d = Math.abs(f.sigma[knots[k]] - a);
        if (d < bestD) {
            bestD = d;
            best = knots[k];
        }
    }
    return best;
}

/** the geo bake the loop refines against — `polish.Bake` plus the dense recovered force the
 *  warm start is fitted from. A `section.SectionResult` satisfies it. */
export interface RefineBake extends Bake {
    fN: ArrayLike<number>;
}

export interface RefineOpts {
    bake: RefineBake;
    /** the entry the bake was evaluated from. */
    entry: Entry;
    /** nominal edge step (m), as `polish` takes it. */
    ds: number;
    /** override the derived authoring floor (m) every accept is measured against; finite
     *  and > 0. For probing the loop — a floor at the numeric floor makes it split to the
     *  key budget. */
    floor?: number;
}

/** what one structural decision did. `"stall"` records a split trial that failed to reduce
 *  the residual in its own region (the corner trigger) and is followed by the `"corner"` it
 *  triggered, by the `"split"` taken anyway, or by a terminal event. The two terminal kinds
 *  are the ones a caller has to tell apart: `"budget"` is the SANCTIONED outcome — no
 *  segment can carry another knot, so the feature is narrower than the authoring grid and
 *  gets approximated away — while `"diverged"` is a numerical failure of the solve itself
 *  and is a defect to surface, never an authoring verdict. */
export type RefineEventKind =
    | "init"
    | "split"
    | "prune"
    | "corner"
    | "stall"
    | "budget"
    | "diverged";

/** how the loop ended: the floor held, the derived key budget ran out (sanctioned), or a
 *  probe came back with a residual profile the loop cannot read — a non-finite entry, which
 *  leaves no deterministic site to cut at. The third is a defect to surface; the profile
 *  still comes back, but nothing chose its keys. */
export type RefineOutcome = "floor" | "budget" | "diverged";

/** the loop's state after one structural decision — the refine timeline. */
export interface RefineEvent {
    kind: RefineEventKind;
    /** the knot set after the event (dense sample indices, ascending). Unchanged by a
     *  `"corner"`, `"stall"`, or `"budget"`. */
    knots: number[];
    /** the knots carrying a corner after the event (dense sample indices). */
    corners: number[];
    /** the dense knot the event acted at: the one split in, pruned out, or broken. −1 where
     *  the event names no site. */
    at: number;
    /** the probe deviation of the state the event describes (m) — for a `"stall"`, the
     *  deviation of the rejected trial. */
    deviation: number;
}

export interface RefineResult {
    /** dense sample indices of the settled knots, ascending — `arclength(bake.ds)[knot]` is
     *  the keyframe's `s`. */
    knots: number[];
    /** the settled knots carrying a corner. `final.corners` is the same set expressed as
     *  KEY indices, the frame `polish` takes. */
    cornerKnots: number[];
    /** the deviation target every accept was measured against (m). */
    floor: number;
    /** how the loop ended. `"floor"` is the answer; `"budget"` is the sanctioned
     *  un-authorable outcome (`final.heldFloor` false, and that is not an error);
     *  `"diverged"` is a solver defect to surface rather than a statement about the shape.
     *  Note a probe that merely failed to CONVERGE is neither — it is a normal waypoint the
     *  loop refines past (see `readable` in `refine`). */
    outcome: RefineOutcome;
    /** the calm λ-search over the settled state — the answer. Read `points`, `heldFloor`,
     *  `peakG`, and the census off it; a refinement that ran out of budget comes back with
     *  `heldFloor` false, which is the honest un-authorable outcome, not an error. */
    final: PolishResult;
    /** one entry per structural decision, in order, opening with `"init"`. */
    events: RefineEvent[];
    /** λ = 0 candidate probes spent (split trials, corner trials, prune counterfactuals,
     *  and the opening solve), and the total `polish` solves including the final search's
     *  own — the loop's whole cost. */
    probes: number;
    solves: number;
}

/**
 * refine a geo bake into an authorable force profile: choose the keys against the geometry
 * the profile integrates into, then solve them calm. Throws on the inputs `polish` and
 * `fitKnots` throw on, plus a bake too short to carry two keys.
 *
 * @example
 * const entry = { x: 0, y: 0, theta: 0, v: 20 };
 * const bake = evalGeo(entry, nodes, 0.5);
 * const r = refine({ bake, entry, ds: 0.5 });
 * const out = evalForce(entry, forceProfile(r.final.points, r.final.length, r.final.ds), 0.5);
 */
export function refine(opts: RefineOpts): RefineResult {
    const { bake, entry } = opts;
    const n = bake.fN.length;
    if (bake.ds.length !== n)
        throw new Error(`refine: ${n} forces against ${bake.ds.length} chords`);
    // `sigma` runs over the `ds` frame while `spine` sums only the first `edges` chords, so
    // a bake whose `edges` disagrees would put knot arclengths and spine arclengths on two
    // silently different scales. A `SectionResult` satisfies this; a hand-built SoA need not.
    if (bake.edges !== n) throw new Error(`refine: ${n} forces against ${bake.edges} edges`);
    if (n < 2) throw new Error(`refine: need >= 2 dense samples, got ${n}`);
    if (opts.floor !== undefined && (!(opts.floor > 0) || !Number.isFinite(opts.floor)))
        throw new Error(`refine: floor must be a finite number > 0, got ${opts.floor}`);

    const sp = spine(bake, opts.ds);
    const floor = opts.floor ?? authoringFloor(sp);
    // the arclength frame every placement rule reads (`Frame`), including the observability
    // floor: a segment shorter than two uniform steps brackets no interior sample of the grid
    // the force is integrated on (see the module note).
    const frame: Frame = { sigma: arclength(bake.ds), ds: sp.ds, minSpan: 2 * sp.ds };

    let probes = 0;
    let solves = 0;

    /** the key indices `polish` takes, from the knot values the loop tracks. */
    const cornerKeys = (knots: readonly number[], cornerKnots: readonly number[]): Corners =>
        cornerKnots.map((c) => {
            const k = knots.indexOf(c);
            // the loop only ever breaks a knot it holds and drops the corner with its knot,
            // so this cannot fire from here; it is the guard for a caller that hand-builds a
            // state, where the alternative is `polish` reporting a corner at key −1.
            if (k < 0) throw new Error(`refine: corner knot ${c} is not in the knot set`);
            return k;
        });

    /** one candidate evaluation: the unregularized solve of a knot set, judged on geometry. */
    const probe = (knots: readonly number[], cornerKnots: readonly number[]): PolishResult => {
        const warm = fitKnots(bake.fN, bake.ds, knots);
        const r = polish({
            bake,
            entry,
            points: warm.points,
            ds: opts.ds,
            mode: "calm",
            handles: "aligned",
            corners: cornerKeys(knots, cornerKnots),
            lambda: 0,
            floor,
            maxSnapshots: 1,
        });
        probes++;
        solves += r.solves;
        return r;
    };

    /** the discrepancy constraint: a state that holds it is authorable at these keys. */
    const held = (r: PolishResult): boolean => r.converged && r.deviation <= floor;

    /** whether a probe's residual profile can be READ — which is all the loop asks of one
     *  before splitting again. Convergence is a different question and a stricter one: a
     *  probe that ran out of AL outers still returns the real geometry of a real profile, and
     *  early in a refinement it is the NORMAL case, not a failure — measured, the two-key
     *  opening probe fails to converge on 2 of the 10 corpus scenarios (`parabola-hill`,
     *  `s-curve`) and both refine to answers that hold the floor. So convergence gates only
     *  the claim that the floor HOLDS (`held`), never whether the loop may continue. What it
     *  cannot survive is a non-finite entry: `splitSite` sorts on these numbers and a NaN
     *  makes the comparison — and with it the whole refinement — non-deterministic. */
    const readable = (r: PolishResult): boolean => {
        for (let j = 0; j < r.deviations.length; j++)
            if (!Number.isFinite(r.deviations[j])) return false;
        return true;
    };

    let knots = [0, n - 1];
    let cornerKnots: number[] = [];
    let outcome: RefineOutcome = "floor";
    let cur = probe(knots, cornerKnots);
    const events: RefineEvent[] = [
        { kind: "init", knots: [...knots], corners: [], at: -1, deviation: cur.deviation },
    ];
    const log = (kind: RefineEventKind, at: number, deviation: number): void => {
        events.push({ kind, knots: [...knots], corners: [...cornerKnots], at, deviation });
    };

    // ---- split phase: grow toward the floor, breaking a key where growth stalls ----
    // The guard is `2n`: splits are bounded by the n − 2 interior samples and corners
    // independently by the n − 2 interior knots, so the two together cannot reach it. It is a
    // guard, not a schedule — and it exits through a logged terminal event, because a loop
    // that fell out unmarked would report a refinement that never happened. The kind is
    // `"diverged"`: reaching it contradicts that counting argument, so it is a defect in the
    // loop's own bookkeeping, not a statement that the shape ran out of grid.
    //
    // The opening probe is guarded exactly like every trial below, by the same predicate:
    // `readable`, not `converged` (see the definition — an unconverged probe is a waypoint,
    // and on 2 of 10 corpus scenarios the opening one is). An unreadable profile is where the
    // loop genuinely cannot continue, because there is no deterministic site to cut at, and
    // it reports `"diverged"` rather than `"budget"` so a caller cannot read a numerical
    // failure as the sanctioned approximate-it-away outcome.
    for (let round = 0; ; round++) {
        if (!readable(cur)) {
            outcome = "diverged";
            log("diverged", -1, cur.deviation);
            break;
        }
        if (held(cur)) break;
        if (round >= 2 * n) {
            outcome = "diverged";
            log("diverged", -1, cur.deviation);
            break;
        }
        const { site, seg, segs } = splitSite(frame, knots, cur.deviations);
        if (site < 0) {
            outcome = "budget";
            log("budget", -1, cur.deviation);
            break;
        }
        const next = [...knots, site].sort((x, y) => x - y);
        const trial = probe(next, cornerKnots);
        // the split turned segment `seg` into `seg` and `seg + 1`; the region is both halves.
        const worked =
            trial.converged &&
            over(residual(frame, next, trial.deviations), seg, seg + 1) < segs[seg].worst;
        if (!worked) {
            log("stall", site, trial.deviation);
            // one of the stalled segment's two bounds, or −1 when neither can be broken (an
            // endpoint, or a corner already); `cornerSite` never returns an endpoint, so any
            // other value is a real interior key.
            const broken = cornerSite(frame, knots, cornerKnots, cur.deviations);
            if (broken >= 0) {
                const withCorner = [...cornerKnots, broken].sort((x, y) => x - y);
                const ct = probe(knots, withCorner);
                // GLOBAL, and deliberately not the local test a split gets. A split is a
                // local refinement, so it is judged where it landed; a corner is a claim that
                // the target's slope breaks, which is a property of the whole profile — it is
                // located at the global residual argmax (`cornerSite`) and it has to move
                // that same global reading to be worth a broken key. Judging it locally over
                // the two segments it joins is what let it pass for free: measured on the
                // sharp-valley fixture at floor 0.05, every corner cleared a local test in a
                // region the stall never implicated while the stalled site went on stalling.
                if (ct.converged && ct.deviation < cur.deviation) {
                    cornerKnots = withCorner;
                    cur = ct;
                    log("corner", broken, cur.deviation);
                    continue;
                }
            }
            // A trial whose residual profile is unreadable is the one thing the loop cannot
            // take: the next round would sort NaNs to choose where to cut. A trial that
            // merely failed to converge IS taken — same waypoint argument as the opening
            // probe — and so is a converged one that did not reduce anything: the floor is
            // still violated, and the rule is to split while it is.
            if (!readable(trial)) {
                outcome = "diverged";
                log("diverged", -1, cur.deviation);
                break;
            }
        }
        knots = next;
        cur = trial;
        log("split", site, cur.deviation);
    }

    // ---- prune phase: drop every key the settled state can spare ----
    // entered only from a state that holds the floor (the hysteresis), so the split trigger
    // is false here and stays false: an accepted removal is one whose own counterfactual
    // holds the floor too.
    if (held(cur))
        for (;;) {
            // EVERY candidate is probed. Probing in some cheap order and taking the first
            // that holds would be far cheaper, but the order would then decide WHICH key
            // dies, and that changes the state every later counterfactual is evaluated
            // against — measured, an ordering swap moved `hill-auto` between 9 and 8 keys.
            // So there is no ranking: the scan is exhaustive and the ACCEPT is the true
            // objective's own reading (does this removal still hold the floor?).
            //
            // Choosing among the removals that hold is a different question, and the
            // objective does not answer it: each drops exactly one key, so minimal-keys is
            // indifferent across all of them. This is a declared TIEBREAK — most slack
            // (lowest counterfactual deviation), lowest key index on an exact tie — not a
            // derivation, and it is not parameter-free in the sense the accept rule is: it
            // picks the state every later round descends from, so it steers the trajectory.
            // Measured, inverting it to max-slack moves the corpus 94 → 95 keys
            // (`valley-explicit` 9 → 10). What the loop is, then, is greedy single-removal
            // descent under a declared tiebreak: minimal keys is the objective it descends
            // toward, not a guarantee it reaches the global minimum. Exhaustive search over
            // removal SETS would be the guarantee and is not on the table — the corpus
            // already costs ~50 s at one solve per candidate per round.
            let best = -1;
            let bestR: PolishResult | null = null;
            for (let k = 1; k + 1 < knots.length; k++) {
                const r = probe(
                    knots.filter((_, i) => i !== k),
                    cornerKnots.filter((c) => c !== knots[k]),
                );
                // strict `<` keeps the lowest key index on a tie, so the scan is order-free
                // in its result as well as its cost.
                if (held(r) && (bestR === null || r.deviation < bestR.deviation)) {
                    best = k;
                    bestR = r;
                }
            }
            if (bestR === null) break;
            const gone = knots[best];
            knots = knots.filter((_, i) => i !== best);
            cornerKnots = cornerKnots.filter((c) => c !== gone);
            cur = bestR;
            log("prune", gone, cur.deviation);
        }

    // ---- the answer: one full discrepancy λ-search over the settled state ----
    const warm = fitKnots(bake.fN, bake.ds, knots);
    const final = polish({
        bake,
        entry,
        points: warm.points,
        ds: opts.ds,
        mode: "calm",
        handles: "aligned",
        corners: cornerKeys(knots, cornerKnots),
        floor,
    });
    solves += final.solves;
    return { knots, cornerKnots, floor, outcome, final, events, probes, solves };
}
