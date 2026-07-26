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
 *  **Every accept is evaluated under the true objective**, never a proxy: a split trial and
 *  a removal counterfactual are each a real `polish` solve of the candidate knot set, judged
 *  on the geometry it integrates into.
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
 *  **Every trial is judged in the region it touches, not globally.** A split is a LOCAL
 *  refinement, so the question it answers is whether the residual went down where it landed.
 *  The global max is dominated by whichever segment is currently worst, which is usually not
 *  the one just refined — measured on `hill-explicit`, the global max rose 0.073 → 0.077 on
 *  a split that was working, and the very next round reached the floor. Judging globally
 *  reads that blip as a stall and gives up one round short of the answer.
 *
 *  **Corners are stall-triggered.** A broken key (`polish.Corners`) is the one discrete
 *  state the continuous solve cannot wander into, and the loop introduces it only when
 *  splitting STALLS — when the split fails to reduce the residual in its own region. That is
 *  the signature of a slope discontinuity in the target: more resolution either side of a
 *  corner buys nothing, because the aligned family cannot bend there at any density. Stall
 *  is an outcome, not a threshold — nothing is detected, measured against a bar, or tuned.
 *  The corner is then held to the same local test over the two segments it joins, so it has
 *  to do what the split could not before the vocabulary pays for it. If it cannot either,
 *  the split is taken anyway and the loop presses on: the floor is still violated, and the
 *  rule is to split while it is.
 *
 *  **Termination is the floor or the budget, never a stall.** The loop stops when the floor
 *  holds, or when no segment can carry another knot — and the latter comes back
 *  `heldFloor` false, the honest un-authorable outcome the authorability directive
 *  sanctions: a spike narrower than the authoring grid is approximated away, not chased.
 *
 *  **The key budget is derived, not set.** A segment earns a split only if BOTH halves keep
 *  at least one interior sample of the uniform grid the force is integrated on — an
 *  arclength span of `2·ds`. Under that a segment's shape drives no dense sample at all, so
 *  it is unobservable in the geometry it is supposed to be fixing, and the fairing energy's
 *  `1/span³` pricing (`polish.fairRows`) would charge its curvature by orders of magnitude
 *  more than its parent's for nothing. The budget is what that admissibility rule leaves,
 *  and the loop reports `"budget"` when it runs out.
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
 *  the residual (the corner trigger) and is followed by the `"corner"` it triggered or by
 *  `"budget"`; `"budget"` is the terminal event of a refinement that ended un-authorable. */
export type RefineEventKind = "init" | "split" | "prune" | "corner" | "stall" | "budget";

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
    if (n < 2) throw new Error(`refine: need >= 2 dense samples, got ${n}`);
    if (opts.floor !== undefined && (!(opts.floor > 0) || !Number.isFinite(opts.floor)))
        throw new Error(`refine: floor must be a finite number > 0, got ${opts.floor}`);

    const sp = spine(bake, opts.ds);
    const floor = opts.floor ?? authoringFloor(sp);
    const sigma = arclength(bake.ds);
    // the observability floor: a segment shorter than two uniform steps brackets no interior
    // sample of the grid the force is integrated on (see the module note).
    const minSpan = 2 * sp.ds;

    let probes = 0;
    let solves = 0;

    /** the key indices `polish` takes, from the knot values the loop tracks. */
    const cornerKeys = (knots: readonly number[], cornerKnots: readonly number[]): Corners =>
        cornerKnots.map((c) => knots.indexOf(c));

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

    /** per segment: the worst spine deviation inside it, and the arclength that HALVES its
     *  integrated residual. Samples past the last knot belong to the last segment — that
     *  stretch is the flat hold the final key drives (`fit.arclength`).
     *
     *  The two readings answer different questions and the split uses both. `worst` says
     *  where the discrepancy constraint BINDS, so it picks the segment. `half` says where to
     *  cut it: de Boor's equidistribution principle, the standard adaptive-mesh placement —
     *  put the knot where each child inherits half the work. Splitting at the residual PEAK
     *  instead is Schneider's rule for fitting a curve to data, and it is wrong under this
     *  prior: a peak sitting near an existing knot puts the new one right beside it, and the
     *  fairing energy's `1/span³` scaling then prices the sliver against its neighbour by the
     *  cube of their ratio. Measured on `full-loop`, peak-splitting produced 1.0 m segments
     *  beside a 35.4 m one — a 44,000× pricing disparity — and the discrepancy search
     *  collapsed λ from 1.1e-3 to 2.9e-9 to afford the slivers any curvature at all, which is
     *  no regularization anywhere: the dense peak went 6.1 → 24.2 g. Equidistribution cannot
     *  produce that, because a child can only be short where the residual it carries is
     *  concentrated enough to earn it. */
    const residual = (
        knots: readonly number[],
        devs: Float64Array,
    ): { worst: number; half: number }[] => {
        const segs = knots.slice(0, -1).map(() => ({ worst: -1, half: 0, sum: 0 }));
        const seg = (a: number, k: number): number => {
            while (k + 2 < knots.length && sigma[knots[k + 1]] <= a) k++;
            return k;
        };
        let k = 0;
        for (let j = 1; j < devs.length; j++) {
            const a = j * sp.ds;
            k = seg(a, k);
            segs[k].sum += devs[j];
            segs[k].worst = Math.max(segs[k].worst, devs[j]);
        }
        const run = segs.map(() => 0);
        k = 0;
        for (let j = 1; j < devs.length; j++) {
            const a = j * sp.ds;
            k = seg(a, k);
            if (run[k] < 0.5 * segs[k].sum) segs[k].half = a;
            run[k] += devs[j];
        }
        return segs;
    };

    /** the admissible dense index nearest arclength `a` strictly inside `(prev, next)`, or
     *  −1 when the segment is too short to carry one. */
    const siteIn = (prev: number, next: number, a: number): number => {
        let best = -1;
        let bestD = Number.POSITIVE_INFINITY;
        for (let i = prev + 1; i < next; i++) {
            if (sigma[i] - sigma[prev] < minSpan) continue;
            // sigma ascends, so once the right half is too short every later index is too.
            if (sigma[next] - sigma[i] < minSpan) break;
            const d = Math.abs(sigma[i] - a);
            if (d < bestD) {
                bestD = d;
                best = i;
            }
        }
        return best;
    };

    /** where to split: the worst segment that can carry a knot, at its own equidistribution
     *  point. `seg` is that segment's index — the region the trial is then judged in. */
    const splitSite = (
        knots: readonly number[],
        devs: Float64Array,
    ): { site: number; seg: number } => {
        const segs = residual(knots, devs);
        const order = segs.map((_, k) => k);
        order.sort((x, y) => segs[y].worst - segs[x].worst || x - y);
        for (const k of order) {
            const i = siteIn(knots[k], knots[k + 1], segs[k].half);
            if (i >= 0) return { site: i, seg: k };
        }
        return { site: -1, seg: -1 };
    };

    /** the worst residual across a run of segments — the reading a local trial moves. */
    const over = (segs: { worst: number }[], lo: number, hi: number): number => {
        let w = 0;
        for (let k = Math.max(0, lo); k <= Math.min(segs.length - 1, hi); k++)
            w = Math.max(w, segs[k].worst);
        return w;
    };

    /** where to break: the interior knot nearest the residual peak that is not one already. */
    const cornerSite = (
        knots: readonly number[],
        cornerKnots: readonly number[],
        devs: Float64Array,
    ): number => {
        let peak = -1;
        let a = 0;
        for (let j = 1; j < devs.length; j++)
            if (devs[j] > peak) {
                peak = devs[j];
                a = j * sp.ds;
            }
        let best = -1;
        let bestD = Number.POSITIVE_INFINITY;
        for (let k = 1; k + 1 < knots.length; k++) {
            if (cornerKnots.includes(knots[k])) continue;
            const d = Math.abs(sigma[knots[k]] - a);
            if (d < bestD) {
                bestD = d;
                best = knots[k];
            }
        }
        return best;
    };

    let knots = [0, n - 1];
    let cornerKnots: number[] = [];
    let cur = probe(knots, cornerKnots);
    const events: RefineEvent[] = [
        { kind: "init", knots: [...knots], corners: [], at: -1, deviation: cur.deviation },
    ];
    const log = (kind: RefineEventKind, at: number, deviation: number): void => {
        events.push({ kind, knots: [...knots], corners: [...cornerKnots], at, deviation });
    };

    // ---- split phase: grow toward the floor, breaking a key where growth stalls ----
    // every accepted split adds a knot and every accepted corner adds one to a finite set,
    // so `n` rounds is past any reachable state; it is a guard, not a schedule.
    for (let round = 0; round < n; round++) {
        if (held(cur)) break;
        const { site, seg } = splitSite(knots, cur.deviations);
        if (site < 0) {
            log("budget", -1, cur.deviation);
            break;
        }
        const next = [...knots, site].sort((x, y) => x - y);
        const trial = probe(next, cornerKnots);
        const before = residual(knots, cur.deviations);
        // the split turned segment `seg` into `seg` and `seg + 1`; the region is both halves.
        const worked =
            trial.converged &&
            over(residual(next, trial.deviations), seg, seg + 1) < before[seg].worst;
        if (!worked) {
            log("stall", site, trial.deviation);
            const broken = cornerSite(knots, cornerKnots, cur.deviations);
            const kk = broken < 0 ? -1 : knots.indexOf(broken);
            if (kk > 0) {
                const withCorner = [...cornerKnots, broken].sort((x, y) => x - y);
                const ct = probe(knots, withCorner);
                // the corner joins segments kk − 1 and kk; hold it to the same local test,
                // so the vocabulary only pays where the split could not deliver.
                if (
                    ct.converged &&
                    over(residual(knots, ct.deviations), kk - 1, kk) < over(before, kk - 1, kk)
                ) {
                    cornerKnots = withCorner;
                    cur = ct;
                    log("corner", broken, cur.deviation);
                    continue;
                }
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
            // candidates ranked cheapest-first by the MERGED PIECE's own dense-force error
            // (`FitStep.errors`) — Lyche–Mørken's knot-removal estimate, the ranking
            // `fit.ts` already prunes by. It is free next to a solve, and it orders the
            // search only: every acceptance below is still the true counterfactual, judged
            // on the geometry the candidate integrates into. A bad ranking costs an extra
            // probe, never a wrong removal.
            const rank: { k: number; est: number }[] = [];
            for (let k = 1; k + 1 < knots.length; k++) {
                const cand = knots.filter((_, i) => i !== k);
                rank.push({ k, est: fitKnots(bake.fN, bake.ds, cand).steps[0].errors[k - 1] });
            }
            rank.sort((x, y) => x.est - y.est || x.k - y.k);
            let gone = -1;
            for (const { k } of rank) {
                const cand = knots.filter((_, i) => i !== k);
                const r = probe(
                    cand,
                    cornerKnots.filter((c) => c !== knots[k]),
                );
                if (!held(r)) continue;
                gone = knots[k];
                knots = cand;
                cornerKnots = cornerKnots.filter((c) => c !== gone);
                cur = r;
                break;
            }
            if (gone < 0) break;
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
    return { knots, cornerKnots, floor, final, events, probes, solves };
}
