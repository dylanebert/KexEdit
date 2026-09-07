/** the pitch fit — the migration kernel that re-expresses one baked GEO run as geo-lane records
 *  (spec `kex2d-segment-gestures` Locked decision "geo is pitch as a parameter": "node-chain
 *  tracks convert to pitch segments in `migrations[3]` through `pitchfit.ts` under `geofit.ts`'s
 *  dual budget").
 *
 *  **Pure.** Plain arrays in, {@link LaneSegment} records out. Nothing here touches the ECS, a
 *  bake, or a `State`; the only substrate it calls is `section.evalPitch` (the kernel it fits
 *  FOR) and `profile.resolveStep`, so the candidate it scores is the shape the document will
 *  actually bake, not a model of it — the same law `geofit.ts` holds for the geo→force fit.
 *
 *  **The dual budget is `geofit.ts`'s, imported, not re-derived** ({@link GEO_BUDGET} 0.5 m,
 *  {@link FORCE_BUDGET} 0.5 g — half the 1 m authoring quantum, not tuned to this corpus). A fit
 *  holds only when the candidate's own bake stays inside BOTH against the node bake it replaces,
 *  measured on ABSOLUTE ARCLENGTH over both station sets (never a normalized span, never index
 *  against index: the two bakes carry different edge grids — the node bake's adaptive Hermite
 *  chords against the pitch run's uniform `resolveStep` grid — so an index-wise comparison would
 *  be reading two different stations).
 *
 *  **Knots are node landings; easing is chosen, not assumed.** The fit opens with one record per
 *  adjacent pair of baked node landings, each exit the heading the bake recovered there, the
 *  first record owning its entry. Each record's easing is then the one of Linear/Cubic/Quintic
 *  that minimizes the candidate's max position deviation, ties to Linear — an authored tag, not
 *  a curve sculpted behind the person's back. Records that still miss the budget SPLIT, and the
 *  splits (never the node landings) PRUNE back out again while the budget holds, so a fit never
 *  ships a knot it does not need. A split blocked by the record floor is a REFUSAL with a named
 *  remedy, never a silently widened budget. */

import { GEO_BUDGET, FORCE_BUDGET } from "./geofit";
import { type LaneSegment, RECORD_FLOOR } from "./lanes";
import { Easing, type ForcePoint, resolveStep, sampleForce, type Step } from "./profile";
import { type Entry, evalPitch, type Strip } from "./section";

/** the node bake one run is fitted against: its sampled geometry, the heading and display force
 *  it recovered, and the entry frame it was placed at. Mirrors `section.SectionResult`'s own
 *  field names, because that is exactly what a caller hands over. */
export interface PitchTarget {
    x: ArrayLike<number>;
    y: ArrayLike<number>;
    theta: ArrayLike<number>;
    fN: ArrayLike<number>;
    /** per-edge arclength (`edges` wide) — the adaptive Hermite chords, never assumed uniform. */
    ds: ArrayLike<number>;
    edges: number;
    /** the frame the run was placed at: `evalPitch` seeds the candidate from the same one. */
    entry: Entry;
}

export interface PitchFitParams {
    /** max position deviation (m); defaults to `geofit.GEO_BUDGET`. */
    geo?: number;
    /** max recovered-force error (g); defaults to `geofit.FORCE_BUDGET`. */
    force?: number;
    /** the nominal step the landed pitch run will bake at (`track.DS_NOMINAL`). */
    dsNominal?: number;
    /** the document's dissipation, threaded to the candidate's own recovery. */
    friction?: number;
    resistance?: number;
    /** the shortest span a SPLIT may mint (m). Node landings are never refused by it. */
    floor?: number;
    /** cap on refinement rounds, so a pathological target terminates rather than spinning. */
    maxRounds?: number;
    /** the run's velocity strips, in the CANDIDATE's own edge frame — supplied as a function of
     *  the candidate's step, because every candidate resolves its own uniform grid and an
     *  edge-index frame does not transfer between grids. Without this a run under an authored
     *  strip is scored against a candidate marching at its natural speed while the target holds
     *  a prescribed one, and the recovered `fN = κ·v²/g + cos θ` then differs by the whole
     *  prescription — a velocity reading mistaken for a shape error. Kept as a callback so this
     *  module stays free of `track.ts` (and therefore of the ECS). */
    strips?: (step: Step) => readonly Strip[] | undefined;
}

export type PitchFitOutcome = "budget" | "floor" | "refused";

export interface PitchFitResult {
    /** the fitted records in RUN-LOCAL arclength, abutting and covering `[0, length]`. */
    records: LaneSegment[];
    /** max position deviation the fitted candidate actually reaches (m). */
    deviation: number;
    /** max |ΔfN| the fitted candidate actually reaches (g). */
    forceError: number;
    /** `budget` when both budgets hold. The other two are REFUSALS, each with its own remedy:
     *  `floor` when a needed split is already inside the record floor, `refused` when refinement
     *  converged — further cuts buy nothing — with a budget still outstanding. */
    outcome: PitchFitOutcome;
    /** how many records the fit shipped. */
    count: number;
    geoBudget: number;
    forceBudget: number;
}

/** the nominal step a landed run bakes at — mirrors `track.DS_NOMINAL` (and `geofit`'s own). */
const DS_NOMINAL = 0.5;

/** cumulative arclength per sample: `cum[0] = 0`, `cum[i+1] = cum[i] + ds[i]`. */
function cumulative(ds: ArrayLike<number>, edges: number): Float64Array {
    const cum = new Float64Array(edges + 1);
    for (let i = 0; i < edges; i++) cum[i + 1] = cum[i] + ds[i];
    return cum;
}

/** a polyline sampled at arclength `s`, linearly interpolated between its bracketing samples.
 *  Both bakes are compared through this, so neither one's grid is privileged. */
function at(
    cum: Float64Array,
    x: ArrayLike<number>,
    y: ArrayLike<number>,
    edges: number,
    s: number,
): [number, number] {
    if (s <= cum[0]!) return [x[0]!, y[0]!];
    if (s >= cum[edges]!) return [x[edges]!, y[edges]!];
    let lo = 0;
    let hi = edges;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid]! <= s) lo = mid;
        else hi = mid;
    }
    const span = cum[hi]! - cum[lo]!;
    const t = span > 0 ? (s - cum[lo]!) / span : 0;
    return [x[lo]! + t * (x[hi]! - x[lo]!), y[lo]! + t * (y[hi]! - y[lo]!)];
}

/** a per-SAMPLE scalar column read at arclength `s`, linearly interpolated on the sample grid —
 *  the heading column the fit's knots take their exit values from. */
function sampleAtS(cum: Float64Array, values: ArrayLike<number>, edges: number, s: number): number {
    if (s <= cum[0]!) return values[0]!;
    if (s >= cum[edges]!) return values[edges]!;
    let lo = 0;
    let hi = edges;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid]! <= s) lo = mid;
        else hi = mid;
    }
    const span = cum[hi]! - cum[lo]!;
    const t = span > 0 ? (s - cum[lo]!) / span : 0;
    return values[lo]! + t * (values[hi]! - values[lo]!);
}

/** a per-EDGE quantity read at arclength `s`. `fN[k]` is built from `theta[k]`, `theta[k+1]` and
 *  `ds[k]`, so it belongs to the SPAN `[cum[k], cum[k+1])` — the convention `bake.forces`
 *  computes it under. Read piecewise-constant over that span, never interpolated between
 *  neighbouring edges: an edge value is what the bake says about a whole cell, and smearing a
 *  step across a cell would make a curvature step read as a ramp whose width is the grid's,
 *  which is exactly the grid artefact {@link compareBakes}'s station tolerance exists to see
 *  past. Off the ends, the terminal edge's own value stands. */
function edgeAt(cum: Float64Array, values: ArrayLike<number>, edges: number, s: number): number {
    if (edges === 0) return 0;
    if (s <= cum[0]!) return values[0]!;
    if (s >= cum[edges]!) return values[edges - 1]!;
    let lo = 0;
    let hi = edges;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid]! <= s) lo = mid;
        else hi = mid;
    }
    return values[lo]!;
}

/** the keyframe list a record chain publishes, in run-local arclength: the first record's owned
 *  entry at station 0 then every record's exit, each carrying the LEADING record's easing (the
 *  Blender F-curve convention `profile.ts` reads and `projection.lanePoints` mints).
 *
 *  **An authored discontinuity is two keys at one station, exit then entry** — the same law
 *  `projection.lanePoints` publishes, because a fit that mints a corner must produce the keys
 *  the landed document will derive, not an approximation of them. */
function pointsOf(records: readonly LaneSegment[]): ForcePoint[] {
    const out: ForcePoint[] = [];
    const first = records[0];
    if (first?.entry !== undefined)
        out.push({ s: first.start, g: first.entry, ease: first.ease as Easing });
    for (let i = 0; i < records.length; i++) {
        const r = records[i]!;
        const next = records[i + 1];
        out.push({ s: r.end, g: r.exit, ease: (next ?? r).ease as Easing });
        if (next?.entry !== undefined && next.entry !== r.exit)
            out.push({ s: next.start, g: next.entry, ease: next.ease as Easing });
    }
    return out;
}

/** one bake as this module compares it: sampled positions, the recovered display force per edge,
 *  and the per-edge arclength that places both on the absolute ruler. */
export interface BakeSamples {
    x: ArrayLike<number>;
    y: ArrayLike<number>;
    fN: ArrayLike<number>;
    /** per-edge arclength (`edges` wide) — never assumed uniform, since the node bake's is not. */
    ds: ArrayLike<number>;
    edges: number;
}

/** the deviations one bake reaches against another: max position error (m) and max recovered
 *  normal-force error (g), both on ABSOLUTE arclength over both station sets. */
export interface BakeDeviation {
    position: number;
    force: number;
}

/** **the budget observable** (spec `kex2d-segment-gestures` Locked decision, architect Answer
 *  2026-09-07, S2d) — one exported helper serving both the fit's own `score` and Validation 2's
 *  bake-identity oracle, so the number a migration accepts and the number the oracle reads are
 *  the same reading rather than two implementations of one sentence.
 *
 *  Position is pointwise: two bakes of the same track must be in the same PLACE at the same
 *  arclength, and nothing about a grid forgives that.
 *
 *  Force is **station-tolerant by one landed edge**. A curvature step — every node join — sits at
 *  one station on the node bake's adaptive Hermite chords and at another on the pitch run's
 *  uniform `resolveStep` grid, up to one cell apart, while both agree on its LEVEL. Read
 *  pointwise, that phase difference reads as the whole height of the step, which is a statement
 *  about two grids and not about the track. So a value on either bake must be matched by the
 *  other WITHIN `tolerance` metres on absolute arclength: the tolerance is the kernel's grid,
 *  never the residual, and a LEVEL error is never forgiven — no window makes a curve that is
 *  0.6 g too high anywhere agree with one that is not.
 *
 *  `corners` are absolute stations carrying an authored C0 corner, whose continuum force is
 *  UNBOUNDED: the two bakes spread it over different numbers of edges and no pointwise force
 *  observable converges there at any grid. Force is not read within `tolerance` of one. Position
 *  still is, which is what keeps a corner from hiding a shape error. */
export function compareBakes(
    a: BakeSamples,
    b: BakeSamples,
    tolerance: number,
    corners: readonly number[] = [],
): BakeDeviation {
    const ca = cumulative(a.ds, a.edges);
    const cb = cumulative(b.ds, b.edges);
    let position = 0;
    let force = 0;

    /** the range `[lo, hi]` of `side`'s force curve over the window `s ± tolerance`. The min of
     *  |v − curve| over a window is 0 when `v` is inside that range and the distance to the
     *  nearer end otherwise, which is exact for a continuous interpolant — so the range is all
     *  the search needs. */
    const range = (cum: Float64Array, side: BakeSamples, s: number): { lo: number; hi: number } => {
        let lo = Infinity;
        let hi = -Infinity;
        const read = (t: number): void => {
            const v = edgeAt(cum, side.fN, side.edges, t);
            if (v < lo) lo = v;
            if (v > hi) hi = v;
        };
        read(s - tolerance);
        read(s + tolerance);
        for (let k = 0; k < side.edges; k++) {
            const t = cum[k]!;
            if (t > s - tolerance && t < s + tolerance) read(t);
        }
        return { lo, hi };
    };

    const nearCorner = (s: number): boolean => corners.some((c) => Math.abs(c - s) <= tolerance);

    const readAt = (s: number): void => {
        const [ax, ay] = at(ca, a.x, a.y, a.edges, s);
        const [bx, by] = at(cb, b.x, b.y, b.edges, s);
        const d = Math.hypot(ax - bx, ay - by);
        if (d > position) position = d;
        if (nearCorner(s)) return;
        // both directions: a value on EITHER bake must be matched by the other.
        for (const [own, ownCum, other, otherCum] of [
            [a, ca, b, cb],
            [b, cb, a, ca],
        ] as const) {
            const v = edgeAt(ownCum, own.fN, own.edges, s);
            const { lo, hi } = range(otherCum, other, s);
            const df = v < lo ? lo - v : v > hi ? v - hi : 0;
            if (df > force) force = df;
        }
    };

    for (let i = 0; i <= a.edges; i++) readAt(ca[i]!);
    for (let i = 0; i <= b.edges; i++) readAt(cb[i]!);
    return { position, force };
}

/** score one candidate record chain against the target bake, through {@link compareBakes}: the
 *  same observable the migration accepts a fit on and the bake-identity oracle reads. */
function score(
    target: PitchTarget,
    length: number,
    records: readonly LaneSegment[],
    params: Required<Pick<PitchFitParams, "dsNominal" | "friction" | "resistance">> &
        Pick<PitchFitParams, "strips">,
    corners: readonly number[],
): { deviation: number; forceError: number } {
    const step = resolveStep(length, params.dsNominal);
    const r = evalPitch(
        target.entry,
        pointsOf(records),
        step,
        (records[0]?.ease ?? Easing.Linear) as Easing,
        params.friction,
        params.resistance,
        params.strips?.(step),
    );
    const dev = compareBakes(
        { x: target.x, y: target.y, fN: target.fN, ds: target.ds, edges: target.edges },
        { x: r.posX, y: r.posY, fN: r.fN, ds: r.ds, edges: r.edges },
        step.ds,
        corners,
    );
    return { deviation: dev.position, forceError: dev.force };
}

/** build the record chain over `knots` (ascending, `knots[0] === 0`), each exit the heading the
 *  target bake recovered at that station, the first record owning its entry. `eases` supplies
 *  each record's tag. */
function buildRecords(
    target: PitchTarget,
    targetCum: Float64Array,
    knots: readonly number[],
    eases: readonly Easing[],
    nextId: () => number,
    corners: readonly number[] = [],
): LaneSegment[] {
    // theta is a PER-SAMPLE column, so it interpolates on the sample grid exactly as the
    // positions do. Headings are stored unwrapped, so a plain lerp is the right reading.
    const headingAt = (s: number): number => sampleAtS(targetCum, target.theta, target.edges, s);

    /** the sample index the corner station `c` lands on. */
    const sampleOf = (c: number): number => {
        let best = 0;
        let gap = Infinity;
        for (let i = 0; i <= target.edges; i++) {
            const d = Math.abs(targetCum[i]! - c);
            if (d < gap) {
                gap = d;
                best = i;
            }
        }
        return best;
    };
    /** at a corner the heading is DISCONTINUOUS, so a single interpolated reading there is the
     *  average of two different headings and belongs to neither side. The predecessor exits at
     *  the last resolved heading BEFORE the node sample and the successor owns the first AFTER
     *  it, which is exactly the two-key discontinuity the derived run will publish (spec Locked
     *  decision; architect Answer, 2026-09-07, S2d). */
    const corner = new Map<number, { exit: number; entry: number }>();
    for (const c of corners) {
        const i = sampleOf(c);
        corner.set(c, {
            exit: target.theta[Math.max(0, i - 1)]!,
            entry: target.theta[Math.min(target.edges, i + 1)]!,
        });
    }

    const out: LaneSegment[] = [];
    for (let i = 0; i + 1 < knots.length; i++) {
        const start = knots[i]!;
        const end = knots[i + 1]!;
        const opening = corner.get(start);
        const closing = corner.get(end);
        const entry = i === 0 ? headingAt(start) : opening?.entry;
        out.push({
            id: nextId(),
            start,
            end,
            ease: eases[i] ?? Easing.Linear,
            ...(entry === undefined ? {} : { entry }),
            exit: closing?.exit ?? headingAt(end),
        });
    }
    return out;
}

/** each record's WORST heading error against the target, and the station it sits at.
 *
 *  This is what a split site is chosen by, not the position deviation: position deviation is an
 *  ACCUMULATED quantity — a heading that is wrong early carries its displacement to the end of
 *  the run — so cutting at the worst POSITION reading chases the symptom's tail rather than its
 *  source and barely moves the answer (measured: 39 such splits on `cli/hill-explicit.kex`
 *  bought 0.02 m). The heading error is local and is exactly what the record authors, so cutting
 *  at its worst station is what actually converges. */
function headingErrors(
    target: PitchTarget,
    targetCum: Float64Array,
    records: readonly LaneSegment[],
): { station: number; error: number }[] {
    const keys = pointsOf(records);
    const out = records.map(() => ({ station: 0, error: 0 }));
    let cursor = 0;
    for (let i = 0; i <= target.edges; i++) {
        const s = targetCum[i]!;
        while (cursor + 1 < records.length && s >= records[cursor + 1]!.start) cursor++;
        const e = Math.abs(sampleForce(keys, s) - target.theta[i]!);
        if (e > out[cursor]!.error) out[cursor] = { station: s, error: e };
    }
    return out;
}

/** the three easings, in the order ties resolve — Linear first, so a tie keeps the simplest
 *  authored shape. */
const EASINGS: readonly Easing[] = [Easing.Linear, Easing.Cubic, Easing.Quintic];

/** the band inside which two easings' position deviations count as TIED (m).
 *
 *  "Least max position deviation, ties to Linear" needs a tie band, because two easings almost
 *  never score bit-equal: on a record whose two headings are nearly equal the curve between them
 *  barely moves the geometry, and the ordering is then decided by f32 noise — which would stamp
 *  an arbitrary Cubic or Quintic tag onto what the person authored as a straight ramp. The band
 *  is derived, not tuned: sample positions are f32, so one ulp at a 100 m coordinate is ~7.6e-6 m
 *  and a few hundred accumulated edges put the noise floor near 1e-4 m. 1e-3 m sits an order of
 *  magnitude above that floor and 500× below `GEO_BUDGET`, so it can never decide whether a fit
 *  holds — only which of two indistinguishable curves gets named. */
const EASE_TIE = 1e-3;

/** fit one baked geo run as pitch-lane records.
 *
 *  `knots` are the run-local stations of the baked node landings (ascending, opening at 0 and
 *  closing at the run's own length); `corners` are the run-local stations carrying an authored
 *  C0 corner; `nextId` mints each record's stable id. The result's records are run-local — the
 *  caller offsets them onto the track's absolute ruler.
 *
 *  Three outcomes, and TWO of them are refusals: `budget` holds both budgets; `floor` means a
 *  record the fit still needed to cut is already inside the record floor; `refused` means
 *  refinement CONVERGED — every record's heading now tracks the target and further cuts buy
 *  nothing — with a residual still outside a budget. Both refusals carry their own remedy at the
 *  caller (`doc.fitGeoRun`). Shipping the second one as a flagged best-effort fit would be a
 *  waiver ledger (`doc-hygiene.md`) and would put an out-of-budget document into every consumer
 *  downstream, so the fit has no outcome that ships a breach. */
export function fitPitch(
    target: PitchTarget,
    knots: readonly number[],
    params: PitchFitParams = {},
    nextId: () => number = (() => {
        let n = 0;
        return () => n++;
    })(),
    corners: readonly number[] = [],
): PitchFitResult {
    const geoBudget = params.geo ?? GEO_BUDGET;
    const forceBudget = params.force ?? FORCE_BUDGET;
    const floor = params.floor ?? RECORD_FLOOR;
    const maxRounds = params.maxRounds ?? 24;
    const shared = {
        dsNominal: params.dsNominal ?? DS_NOMINAL,
        friction: params.friction ?? 0,
        resistance: params.resistance ?? 0,
        strips: params.strips,
    };
    const targetCum = cumulative(target.ds, target.edges);
    const length = targetCum[target.edges]!;

    // easing selection and the prune probe throwaway chains, so they mint throwaway ids; only
    // the chain that ships is numbered through the caller's own `nextId`.
    let peek = 0;
    const idPeek = () => peek++;
    const build = (rows: readonly number[], eases: readonly Easing[]) =>
        buildRecords(target, targetCum, rows, eases, idPeek, corners);
    const flat = (n: number): Easing[] => new Array(n).fill(Easing.Linear);
    const rate = (rows: readonly number[], eases: readonly Easing[]) =>
        score(target, length, build(rows, eases), shared, corners);
    const holds = (f: { deviation: number; forceError: number }) =>
        f.deviation <= geoBudget && f.forceError <= forceBudget;

    // the opening knot set: the node landings, deduplicated, clamped to the run and always
    // closing on the run's own length, with every corner station a knot — a corner is a
    // discontinuity, so a record can never span one. A run whose landings collapse (a degenerate
    // chain) still fits as one record over the whole span rather than refusing here.
    const landings = new Set<number>([0, length]);
    for (const k of [...knots, ...corners]) if (k > 0 && k < length) landings.add(k);
    let rows = [...landings].sort((a, b) => a - b);

    // ── refine: split every record whose heading error is in the worst half, halving the
    // threshold each round, so the knot set converges in rounds logarithmic in the error rather
    // than one knot per round.
    let outcome: PitchFitOutcome = "budget";
    let fit = rate(rows, flat(rows.length - 1));
    for (let round = 0; round < maxRounds; round++) {
        if (holds(fit)) break;
        const errors = headingErrors(target, targetCum, build(rows, flat(rows.length - 1)));
        // The threshold comes from the worst UNBLOCKED record, never the worst record outright:
        // a record already inside the record floor cannot be cut however badly it reads, so
        // letting it set the bar leaves every cuttable record under the threshold and the
        // refinement stalls with cuts still available (spec architect Answer, 2026-09-07, S2d).
        const splittable = (i: number): boolean => rows[i + 1]! - rows[i]! >= 2 * floor;
        let worst = 0;
        let blocked = false;
        for (let i = 0; i < errors.length; i++) {
            if (!splittable(i)) {
                if (errors[i]!.error > 0) blocked = true;
                continue;
            }
            if (errors[i]!.error > worst) worst = errors[i]!.error;
        }
        if (!(worst > 0)) {
            outcome = blocked ? "floor" : "refused";
            break;
        }
        const threshold = worst / 2;
        const cuts: number[] = [];
        for (let i = 0; i < errors.length; i++) {
            if (errors[i]!.error <= threshold || !splittable(i)) continue;
            const lo = rows[i]!;
            const hi = rows[i + 1]!;
            cuts.push(Math.min(Math.max(errors[i]!.station, lo + floor), hi - floor));
        }
        if (cuts.length === 0) {
            outcome = blocked ? "floor" : "refused";
            break;
        }
        rows = [...rows, ...cuts].sort((a, b) => a - b);
        fit = rate(rows, flat(rows.length - 1));
        if (round === maxRounds - 1) outcome = "refused";
    }
    if (outcome === "budget" && !holds(fit)) outcome = "refused";

    // ── choose each record's easing: least max position deviation, ties to Linear — but never
    // at the cost of the FORCE budget. A tag that reads a decimetre closer in position while
    // pushing |ΔfN| past its budget is not a better fit, it is a fit that ships a breach, so
    // holding both budgets outranks the position reading (spec architect Answer, 2026-09-07,
    // S2d, blocker (a)). Run once on the settled knot set — the split loop is heading-driven and
    // easing-independent, so paying 3n bakes per round would buy nothing.
    const eases = flat(rows.length - 1);
    for (let i = 0; i < eases.length; i++) {
        for (const ease of EASINGS) {
            if (ease === eases[i]) continue;
            const trial = eases.slice();
            trial[i] = ease;
            const s = rate(rows, trial);
            const better =
                holds(s) !== holds(fit) ? holds(s) : s.deviation < fit.deviation - EASE_TIE;
            if (better) {
                fit = s;
                eases[i] = ease;
            }
        }
    }
    // the easing pass can bring a chain the refinement left outside a budget back inside it, so
    // the outcome is settled HERE, after it — a `floor` reached mid-refinement is not sticky
    // once the shipped chain actually holds.
    if (holds(fit)) outcome = "budget";
    else if (outcome === "budget") outcome = "refused";

    // ── prune: drop any knot the fit does not need, node landings included — a landing that
    // buys nothing is a record the person would have to edit for no reason. Only ever accepted
    // while BOTH budgets still hold, so a prune can never trade fidelity for tidiness. A corner
    // station is never pruned: it is a discontinuity the records are defined around.
    if (holds(fit)) {
        for (let i = rows.length - 2; i >= 1; i--) {
            if (corners.includes(rows[i]!)) continue;
            const trimmed = [...rows.slice(0, i), ...rows.slice(i + 1)];
            const trialEases = [...eases.slice(0, i), ...eases.slice(i + 1)];
            const s = rate(trimmed, trialEases);
            if (holds(s)) {
                rows = trimmed;
                eases.splice(i, 1);
                fit = s;
            }
        }
    }

    return {
        records: buildRecords(target, targetCum, rows, eases, nextId, corners),
        deviation: fit.deviation,
        forceError: fit.forceError,
        outcome,
        count: rows.length - 1,
        geoBudget,
        forceBudget,
    };
}
