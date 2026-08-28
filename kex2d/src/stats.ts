/** pure readback over a track's baked output (`track.bakeOut`) — the one home for
 *  numbers derived from a bake, so the CLI's `stats` verb, the future `validate`
 *  verb, and any UI display share one derivation instead of each re-summing the
 *  bake's own arrays. Everything here reads exactly what `bakeOut` publishes
 *  (`fN`, `ds`, `v`, `t`, `tTotal`, `feasible`, `firstInfeasible`) plus the live
 *  sample count — no ECS import, no track entity, so a caller (headless CLI
 *  included) can hand in any object shaped like a bake, real or synthetic.
 *
 *  Station convention: every reading below addresses a per-edge quantity (`fN`,
 *  `ds`) at its edge's LEADING sample — the same convention `cart.forceCurve`
 *  documents (edge `i` runs `[i, i+1)` and is read at station `s[i]`). A
 *  per-sample quantity (`v`, `feasible`) addresses its own sample directly. */

/** the shape this module consumes — `track.bakeOut`'s value type, structurally
 *  (never imported from `track.ts`, so a synthetic fixture needs no ECS). */
export interface BakeOutLike {
    /** per-edge normal force, g. length ≥ count − 1. */
    readonly fN: ArrayLike<number>;
    /** per-edge arclength spacing, m. length ≥ count − 1. */
    readonly ds: ArrayLike<number>;
    /** per-sample recovered speed, m/s. length ≥ count. */
    readonly v: ArrayLike<number>;
    /** per-sample cumulative time, s (`t[0] = 0`). length ≥ count. */
    readonly t: ArrayLike<number>;
    /** `t[count - 1]` — carried separately since a synthetic fixture may not size
     *  its arrays to exactly `count`. */
    readonly tTotal: number;
    /** per-sample feasibility flag (`|v[i]| ≥ V_WARN`), 1 or 0. length ≥ count. */
    readonly feasible: ArrayLike<number>;
    /** first sample index where `feasible` reads 0, or −1 when every sample is
     *  feasible. */
    readonly firstInfeasible: number;
}

/** one scalar extremum plus where on the track it was read — the addressing a
 *  bare `number` throws away and every consumer of a g envelope needs (the
 *  station to point a marker at). */
export interface Extreme {
    value: number;
    /** cumulative arclength (m) at the reading. */
    station: number;
    /** the edge (fN) or sample (v) index the reading came from. */
    index: number;
}

export interface GEnvelope {
    min: Extreme;
    max: Extreme;
}

/** one contiguous run of edges whose `fN` sits below the airtime threshold —
 *  `[startIndex, endIndex)` in edge space (edges `startIndex..endIndex − 1`),
 *  which spans samples `startIndex..endIndex` inclusive. */
export interface AirtimeMoment {
    startIndex: number;
    endIndex: number;
    startStation: number;
    endStation: number;
    startTime: number;
    endTime: number;
    durationS: number;
    durationM: number;
}

/** one contiguous run of samples sharing a `feasible` value — `[startIndex,
 *  endIndex)` in sample space (samples `startIndex..endIndex − 1`). */
export interface FeasibilitySpan {
    feasible: boolean;
    startIndex: number;
    endIndex: number;
    startStation: number;
    endStation: number;
    startTime: number;
    endTime: number;
}

export interface TrackStats {
    length: number;
    totalTime: number;
    speedMin: number;
    speedMax: number;
    gEnvelope: GEnvelope | null;
    airtimeMoments: AirtimeMoment[];
    feasibilitySpans: FeasibilitySpan[];
}

/** the per-sample cumulative arclength table `s[i] = Σ_{k<i} ds[k]`, `s[0] = 0`
 *  — the ONE derivation every consumer of "distance so far" shares (`cart.ts`'s
 *  `forceCurve`/`velocityCurve`/`trackMapping` used to each sum this inline;
 *  they now call here). Bake's OWN per-edge `ds`, never a chord re-derive — see
 *  `cart.trackMapping`'s docblock for why that distinction matters on a bake
 *  carrying a zero-length gap edge. */
export function cumulativeArclength(ds: ArrayLike<number>, count: number): Float64Array {
    const s = new Float64Array(Math.max(0, count));
    for (let i = 1; i < count; i++) s[i] = s[i - 1] + ds[i - 1];
    return s;
}

/** total track length — the last cumulative-arclength entry, i.e. Σ over every
 *  edge `[0, count - 1)`. Equivalent to `cumulativeArclength(ds, count)[count -
 *  1]` without allocating the whole table. */
export function trackLength(ds: ArrayLike<number>, count: number): number {
    let total = 0;
    for (let i = 0; i < count - 1; i++) total += ds[i];
    return total;
}

/** min/max recovered speed over the live samples `[0, count)`. */
export function speedRange(v: ArrayLike<number>, count: number): { min: number; max: number } {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < count; i++) {
        const x = v[i];
        if (x < min) min = x;
        if (x > max) max = x;
    }
    return { min, max };
}

/** the g envelope — min/max `fN` over the live edges `[0, count - 1)`, each
 *  tagged with the station it was read at (its edge's leading sample, `s[i]`).
 *  Ties keep the FIRST index reached (stable, deterministic). `null` with fewer
 *  than 2 samples (no edges to read). `station` is `cumulativeArclength`'s
 *  output — pass it in when the caller already has one (`computeStats` does),
 *  or omit to have this derive its own. */
export function gEnvelope(
    out: Pick<BakeOutLike, "fN" | "ds">,
    count: number,
    station?: ArrayLike<number>,
): GEnvelope | null {
    const edges = count - 1;
    if (edges <= 0) return null;
    const s = station ?? cumulativeArclength(out.ds, count);
    let min: Extreme = { value: out.fN[0], station: s[0], index: 0 };
    let max: Extreme = { value: out.fN[0], station: s[0], index: 0 };
    for (let i = 1; i < edges; i++) {
        const v = out.fN[i];
        if (v < min.value) min = { value: v, station: s[i], index: i };
        if (v > max.value) max = { value: v, station: s[i], index: i };
    }
    return { min, max };
}

/** contiguous edge runs where `fN < thresholdG` — the airtime moments (the
 *  rider is weightless or lifted). `thresholdG` defaults to 0 (the physical
 *  zero-g crossing where a rider's own weight stops pressing them into the
 *  seat) — a force-limit PROFILE'S own airtime band (S5) is a separate,
 *  standard-grounded threshold layered on top, never this default. Each
 *  moment's duration reads `t`/`s` at its edge run's sample bounds (edge `i`
 *  spans samples `[i, i + 1]`), so a single-edge moment still carries a
 *  non-zero duration. */
export function airtimeMoments(
    out: Pick<BakeOutLike, "fN" | "ds" | "t">,
    count: number,
    thresholdG = 0,
    station?: ArrayLike<number>,
): AirtimeMoment[] {
    const edges = count - 1;
    if (edges <= 0) return [];
    const s = station ?? cumulativeArclength(out.ds, count);
    const moments: AirtimeMoment[] = [];
    let runStart = -1;
    const closeRun = (endEdgeExclusive: number): void => {
        if (runStart < 0) return;
        const startI = runStart;
        const endI = endEdgeExclusive; // sample index one past the run's last edge
        moments.push({
            startIndex: startI,
            endIndex: endI,
            startStation: s[startI],
            endStation: s[endI],
            startTime: out.t[startI],
            endTime: out.t[endI],
            durationS: out.t[endI] - out.t[startI],
            durationM: s[endI] - s[startI],
        });
        runStart = -1;
    };
    for (let i = 0; i < edges; i++) {
        const below = out.fN[i] < thresholdG;
        if (below && runStart < 0) runStart = i;
        else if (!below && runStart >= 0) closeRun(i);
    }
    closeRun(edges);
    return moments;
}

/** contiguous sample runs sharing a `feasible` value — the diagnostic behind
 *  the red-track/red-handle UX (`bakeOut.feasible`, `firstInfeasible`). The
 *  first infeasible span, if any, starts at `firstInfeasible` by construction
 *  (both are derived from the same `feasible` array). */
export function feasibilitySpans(
    out: Pick<BakeOutLike, "feasible" | "ds" | "t">,
    count: number,
    station?: ArrayLike<number>,
): FeasibilitySpan[] {
    if (count <= 0) return [];
    const s = station ?? cumulativeArclength(out.ds, count);
    const spans: FeasibilitySpan[] = [];
    let runStart = 0;
    let runFeasible = out.feasible[0] !== 0;
    const closeRun = (endExclusive: number): void => {
        const lastSample = endExclusive - 1;
        spans.push({
            feasible: runFeasible,
            startIndex: runStart,
            endIndex: endExclusive,
            startStation: s[runStart],
            endStation: s[lastSample],
            startTime: out.t[runStart],
            endTime: out.t[lastSample],
        });
    };
    for (let i = 1; i < count; i++) {
        const feasible = out.feasible[i] !== 0;
        if (feasible !== runFeasible) {
            closeRun(i);
            runStart = i;
            runFeasible = feasible;
        }
    }
    closeRun(count);
    return spans;
}

/** the whole readback in one pass — track length, total time, speed range, g
 *  envelope, airtime moments, and feasibility spans, over a bake shaped
 *  `BakeOutLike` at `count` live samples. `airtimeThresholdG` forwards to
 *  `airtimeMoments` (default 0). */
export function computeStats(
    out: BakeOutLike,
    count: number,
    opts: { airtimeThresholdG?: number } = {},
): TrackStats {
    if (count <= 0) {
        return {
            length: 0,
            totalTime: 0,
            speedMin: 0,
            speedMax: 0,
            gEnvelope: null,
            airtimeMoments: [],
            feasibilitySpans: [],
        };
    }
    const station = cumulativeArclength(out.ds, count);
    const { min: speedMin, max: speedMax } = speedRange(out.v, count);
    return {
        length: station[count - 1],
        totalTime: out.tTotal,
        speedMin,
        speedMax,
        gEnvelope: gEnvelope(out, count, station),
        airtimeMoments: airtimeMoments(out, count, opts.airtimeThresholdG ?? 0, station),
        feasibilitySpans: feasibilitySpans(out, count, station),
    };
}
