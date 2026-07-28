/** Flat-only conversion refinement.
 *
 * Open at the two endpoints, split where integrated-geometry residual concentrates until
 * the fixed authoring floor holds, then exhaustively probe every single-key removal and
 * greedily prune the holding candidate with the most slack (lowest key index on a tie).
 * Every probe is the same unregularized flat-family collocation solve. */

import { arclength, fitKnots } from "./fit";
import { type Bake, chordDeficit, polish, type PolishResult, type Spine, spine } from "./polish";
import type { ForcePoint } from "./profile";
import type { Entry } from "./section";

/** The geometry-authoring step a conversion is judged against (m): a converted section must
 * reproduce its shape to within half of one, so a re-author on the grid can express the gap.
 *
 * Deliberately the conversion core's OWN constant, not `settings.ts`'s manipulator grid, which
 * happens to default to the same metre. That module is the live per-user preference home, and
 * what a document converts to is a frozen contract — moving the manipulator's default grid must
 * never silently move it. It also keeps `localStorage` out of the conversion's module graph
 * (`refine.test.ts` pins both halves). */
export const CONVERT_STEP = 1;

/** Conversion geometry floor: the discretization proxy plus half the fixed authoring step. */
export function authoringFloor(target: Spine): number {
    return chordDeficit(target) + 0.5 * CONVERT_STEP;
}

export interface Frame {
    sigma: Float64Array;
    ds: number;
    minSpan: number;
}

export interface Seg {
    worst: number;
    half: number;
}

/** Residual equidistribution per knot interval. */
export function residual(
    frame: Frame,
    knots: readonly number[],
    deviations: ArrayLike<number>,
): Seg[] {
    const segments = knots.slice(0, -1).map((_, k) => ({
        worst: 0,
        half: 0.5 * (frame.sigma[knots[k]] + frame.sigma[knots[k + 1]]),
        sum: 0,
    }));
    const segmentAt = (at: number, k: number): number => {
        while (k + 2 < knots.length && frame.sigma[knots[k + 1]] <= at) k++;
        return k;
    };
    let k = 0;
    for (let j = 1; j < deviations.length; j++) {
        k = segmentAt(j * frame.ds, k);
        segments[k].sum += deviations[j];
        segments[k].worst = Math.max(segments[k].worst, deviations[j]);
    }
    const run = segments.map(() => 0);
    k = 0;
    for (let j = 1; j < deviations.length; j++) {
        const at = j * frame.ds;
        k = segmentAt(at, k);
        if (segments[k].sum > 0 && run[k] < 0.5 * segments[k].sum) segments[k].half = at;
        run[k] += deviations[j];
    }
    return segments;
}

/** Admissible dense knot nearest arclength `at`, preserving one observable sample per side. */
export function siteIn(frame: Frame, prev: number, next: number, at: number): number {
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = prev + 1; i < next; i++) {
        if (frame.sigma[i] - frame.sigma[prev] < frame.minSpan) continue;
        if (frame.sigma[next] - frame.sigma[i] < frame.minSpan) break;
        const distance = Math.abs(frame.sigma[i] - at);
        if (distance < bestDistance) {
            bestDistance = distance;
            best = i;
        }
    }
    return best;
}

/** Worst splittable interval, cut at its residual-equidistribution point. */
export function splitSite(
    frame: Frame,
    knots: readonly number[],
    deviations: ArrayLike<number>,
): { site: number; seg: number; segs: Seg[] } {
    const segs = residual(frame, knots, deviations);
    const order = segs.map((_, index) => index);
    order.sort((a, b) => segs[b].worst - segs[a].worst || a - b);
    for (const index of order) {
        const site = siteIn(frame, knots[index], knots[index + 1], segs[index].half);
        if (site >= 0) return { site, seg: index, segs };
    }
    return { site: -1, seg: -1, segs };
}

export interface RefineBake extends Bake {
    fN: ArrayLike<number>;
}

export interface RefineOpts {
    bake: RefineBake;
    entry: Entry;
    ds: number;
    /** Test-only override; production uses `chordDeficit + 0.5 m`. */
    floor?: number;
    /** Record the fit lab's playback freight — a `RefineEvent` per decision and one solver
     *  frame per probe (default true). A production conversion reads only the answer, so it
     *  sets this false and both go unbuilt. Recording observes the solve, never steers it: the
     *  emitted conversion is bit-identical either way (`refine.test.ts`). */
    playback?: boolean;
    /** Probe seam for deterministic solver-failure coverage. */
    probe?: (points: readonly ForcePoint[], knots: readonly number[]) => PolishResult;
}

export type RefineEventKind = "init" | "split" | "prune" | "budget" | "diverged";
export type RefineOutcome = "floor" | "budget" | "diverged";

export interface RefineEvent {
    kind: RefineEventKind;
    knots: number[];
    at: number;
    deviation: number;
    points: readonly ForcePoint[];
}

export interface RefineResult {
    knots: number[];
    floor: number;
    outcome: RefineOutcome;
    final: PolishResult;
    events: RefineEvent[];
    probes: number;
}

/** What a conversion hands its caller: the authored force section it produced, plus the
 * diagnostics that say how it stands. Everything here is plain numbers and `{s,g}` objects, so
 * it survives a structured clone — this is the payload that crosses the worker boundary, and
 * the shape `tests/fixtures/convert-golden.json` freezes.
 *
 * `RefineResult`'s freight stays behind: the playback events, the solver's spine, the
 * per-sample deviation profile. A caller that wants those runs `refine` in-process. */
export interface ConvertResult {
    /** The section's force keyframes, `{s, g}` only — every segment default Cubic. */
    points: ForcePoint[];
    /** The REALIZED edge step, `length/edges` — never the nominal step the caller passed.
     *  A force section stores its own step, and marching loop-explicit's profile at nominal
     *  0.5 m misses the pinned exit by 0.247 m (`refine.test.ts`). */
    ds: number;
    /** The section's extent (m): the bake's arclength, which the exit is pinned at. */
    length: number;
    edges: number;
    keys: number;
    /** Dense-sample index per key — where the refinement put them. The placement provenance
     *  the golden pins; a section loads from `points`. */
    knots: number[];
    outcome: RefineOutcome;
    /** The geometry floor the outcome was judged against (m). */
    floor: number;
    /** Worst spine-vs-target gap in the answer (m), `<= floor` on a `"floor"` outcome. */
    deviation: number;
    /** Solves spent — the cost reading. */
    probes: number;
}

/** The narrow payload of a completed refinement. */
export function narrow(result: RefineResult): ConvertResult {
    const { final } = result;
    return {
        points: final.points.map(({ s, g }) => ({ s, g })),
        ds: final.ds,
        length: final.length,
        edges: final.edges,
        keys: final.keys,
        knots: [...result.knots],
        outcome: result.outcome,
        floor: result.floor,
        deviation: final.deviation,
        probes: result.probes,
    };
}

const flatten = (points: readonly ForcePoint[]): ForcePoint[] =>
    points.map(({ s, g }) => ({ s, g }));

const carry = (points: readonly ForcePoint[]): ForcePoint[] => points.map(({ s, g }) => ({ s, g }));

/** A finite residual profile is the only requirement for another structural decision. */
export function readable(deviations: ArrayLike<number>): boolean {
    for (let index = 0; index < deviations.length; index++)
        if (!Number.isFinite(deviations[index])) return false;
    return true;
}

export function refine(opts: RefineOpts): RefineResult {
    const { bake, entry } = opts;
    const n = bake.fN.length;
    if (bake.ds.length !== n)
        throw new Error(`refine: ${n} forces against ${bake.ds.length} chords`);
    if (bake.edges !== n) throw new Error(`refine: ${n} forces against ${bake.edges} edges`);
    if (n < 2) throw new Error(`refine: need >= 2 dense samples, got ${n}`);
    if (opts.floor !== undefined && (!(opts.floor > 0) || !Number.isFinite(opts.floor)))
        throw new Error(`refine: floor must be a finite number > 0, got ${opts.floor}`);

    const target = spine(bake, opts.ds);
    const floor = opts.floor ?? authoringFloor(target);
    const frame: Frame = {
        sigma: arclength(bake.ds),
        ds: target.ds,
        minSpan: 2 * target.ds,
    };
    const playback = opts.playback ?? true;
    let probes = 0;
    const probe = (knots: readonly number[]): PolishResult => {
        const warm = flatten(fitKnots(bake.fN, bake.ds, knots).points);
        probes++;
        if (opts.probe) return opts.probe(warm, knots);
        return polish({
            bake,
            entry,
            points: warm,
            ds: opts.ds,
            family: "flat",
            maxSnapshots: playback ? 1 : 0,
        });
    };
    const held = (answer: PolishResult): boolean =>
        readable(answer.deviations) && answer.converged && answer.deviation <= floor;

    let knots = [0, n - 1];
    let answer = probe(knots);
    let outcome: RefineOutcome = "floor";
    const events: RefineEvent[] = [];
    const log = (kind: RefineEventKind, at: number): void => {
        if (!playback) return;
        events.push({
            kind,
            knots: [...knots],
            at,
            deviation: answer.deviation,
            points: carry(answer.points),
        });
    };
    log("init", -1);

    for (let round = 0; !held(answer); round++) {
        if (!readable(answer.deviations) || round >= n) {
            outcome = "diverged";
            log("diverged", -1);
            break;
        }
        const { site } = splitSite(frame, knots, answer.deviations);
        if (site < 0) {
            outcome = "budget";
            log("budget", -1);
            break;
        }
        const next = [...knots, site].sort((a, b) => a - b);
        const trial = probe(next);
        if (!readable(trial.deviations)) {
            knots = next;
            answer = trial;
            outcome = "diverged";
            log("diverged", site);
            break;
        }
        knots = next;
        answer = trial;
        log("split", site);
    }

    if (held(answer))
        prune: for (;;) {
            let best = -1;
            let bestAnswer: PolishResult | null = null;
            for (let k = 1; k + 1 < knots.length; k++) {
                const removed = knots[k];
                const next = knots.filter((_, index) => index !== k);
                const trial = probe(next);
                if (!readable(trial.deviations)) {
                    knots = next;
                    answer = trial;
                    outcome = "diverged";
                    log("diverged", removed);
                    break prune;
                }
                if (
                    held(trial) &&
                    (bestAnswer === null || trial.deviation < bestAnswer.deviation)
                ) {
                    best = k;
                    bestAnswer = trial;
                }
            }
            if (bestAnswer === null) break;
            const removed = knots[best];
            knots = knots.filter((_, index) => index !== best);
            answer = bestAnswer;
            log("prune", removed);
        }

    return { knots, floor, outcome, final: answer, events, probes };
}
