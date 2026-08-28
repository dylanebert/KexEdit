/** the force-limit PROFILE (data) and a VALIDATOR over `stats.ts`'s bake readback — S5 of
 *  `kex2d-cli`. Every default here cites Rohde, "Some Details About the Development of
 *  Acceleration Limits for Amusement Rides," 2nd ed., March 2024 (vdv-freizeittechnologie.de),
 *  the G-Force Task Group's own reproduction of ASTM F2291-23b §7 Figs 6-8 / EN 13814-2019's
 *  harmonized appendix — full readings in `scratch/kex2d-cli/force-limit-brief.md`. Naming: this
 *  is NOT `profile.ts` (the force-authoring primitive, keyframes → dense F_n(s) — a different
 *  concept sharing the word "profile"); this module never imports it.
 *
 *  ONE FORCE AXIS TODAY. kex2d is a 2D vertical-plane substrate: `bake.ts`/`forward.ts` emit a
 *  single signed `fN` (g), the seat-normal magnitude — `forward.ts`'s own `loss` docblock says so
 *  explicitly ("a 3D caller's own frame has more than one perpendicular component (√(fN² +
 *  fLat²))... 2D callers here pass |fN|"). `fN` is the Gz (vertical) axis in Rohde's frame; there
 *  is no Gx (longitudinal) or Gy (lateral) channel to read. So `DEFAULT_PROFILE` carries bands
 *  for all three axes (a caller migrating to 3D data gets them for free), `checkForceLimits`
 *  below evaluates ONLY the Gz+/Gz- bands against real `fN`, and the pairwise combined-axis
 *  ellipse check is shipped as a pure, axis-agnostic primitive (`pairwiseEllipseValue`) proven
 *  against Rohde's stated formula on synthetic multi-axis input — it has no real second channel
 *  to wire against until a 3D kernel exists.
 *
 *  DURATION MODEL. Each axis's band is a table of (thresholdG, maxDurationS) steps: "you may
 *  sustain fN at or beyond thresholdG for at most maxDurationS". A breach is a contiguous run
 *  where fN is at-or-beyond a step's threshold for LONGER than that step's cap — the same
 *  contiguous-run shape `stats.airtimeMoments` already uses, generalized to an arbitrary
 *  threshold and comparison direction. This shape gives the sub-0.2s "impact" exemption for
 *  free: a run's duration can only exceed a cap that is itself ≥ some positive number, so a run
 *  shorter than every cap in the table (impossible to construct below the tightest one, 0.2s+ε)
 *  never breaches — no separate impact-regime branch needed. `sustainedMinDurationS` (0.2) and
 *  `exposureCapS` (90) are carried on the profile for documentation and for a future caller that
 *  wants to flag "beyond the validated envelope" rather than silently trusting the last step past
 *  `exposureCapS` (this module does not extrapolate past it — the last step's own `maxDurationS`
 *  IS `exposureCapS` on every axis below, by construction, so a run past 90s DOES breach; there is
 *  no unvalidated silent-pass region). */

import type { BakeOutLike } from "./stats";
import { cumulativeArclength } from "./stats";

/** true iff the researcher brief's own "exact-quoted breakpoints" list (S5 researcher brief
 *  §Gaps/cautions #3: 0.2 s, 11.8 s, 40 s, 90 s) names this step's `maxDurationS` — false means
 *  graph-read off a source figure (marked `~` in the brief's tables). Note: the brief's p.26
 *  prose quote also states "1 second" verbatim, but its own gaps list excludes 1.0 s from the
 *  exact set — this module follows the gaps list, the brief's more conservative statement, and
 *  marks the 1.0 s/3.5 s/7.0 s/2.0 s/4.5 s breakpoints below `exact: false`. */
export interface DurationLimitStep {
    /** g level (signed) this step's cap applies at-or-beyond, in the band's own direction
     *  (positive band: fN ≥ thresholdG; negative band: fN ≤ thresholdG). */
    thresholdG: number;
    /** the longest duration (s) a contiguous run at-or-beyond `thresholdG` may sustain. */
    maxDurationS: number;
    exact: boolean;
}

export type AxisName = "Gz" | "Gx" | "Gy";
export type BandSign = "+" | "-";

export interface AxisBand {
    axis: AxisName;
    sign: BandSign;
    /** ascending by `thresholdG` magnitude descending, i.e. the tightest (highest-magnitude,
     *  shortest-duration) step first — `checkForceLimits` reports every step a run breaches, not
     *  just the tightest, so ordering here is documentation, not a search precondition. */
    steps: DurationLimitStep[];
    /** the brief section/table this band's numbers came from. */
    citation: string;
}

export interface ForceLimitProfile {
    name: string;
    source: string;
    /** s — below this, an excursion is an "impact" event outside the g-band regime (S5 brief
     *  §Regime; F2291 Annex X11, no pinnable g-number). Carried for documentation; the duration
     *  model above enforces it structurally (see module docblock). */
    sustainedMinDurationS: number;
    /** s — sustained limits are only validated up to this exposure (S5 brief §Regime, p.8). */
    exposureCapS: number;
    bands: AxisBand[];
    /** OPTIONAL, uncited. S5 researcher brief §Gaps/cautions #1: no published minimum-speed /
     *  rollback number exists in the pinned source (F2291's own text unrecovered). Never
     *  defaulted — a caller sets it, or it stays undefined and no speed-floor check runs. */
    speedFloorMps?: number;
}

/** Table 7.1 (S5 brief, p.37) consolidated admissible bounds, BASE-RESTRAINT row only — the
 *  prone (x: -3.50..6.00) and extended-Gz/bungee (z: -2.80..6.00, F2291-only) rows are excluded,
 *  matching the Approach's pinned-bands scope note ("bungee-scoped — exclude"). Used by
 *  `pairwiseEllipseValue` below; not consumed by `checkForceLimits` (no x/y channel yet). */
export const TABLE_7_1_BASE_BOUNDS: Record<AxisName, { min: number; max: number }> = {
    Gx: { min: -2.0, max: 6.0 },
    Gy: { min: -3.0, max: 3.0 },
    Gz: { min: -2.0, max: 6.0 },
};

/** the shipped defaults, built ONLY from the pinned bands in the spec's Approach S5 bullet /
 *  the researcher brief. `+Gz`/`-Gz` are the two bands `checkForceLimits` actually evaluates
 *  (kex2d's one real channel); `Gx`/`Gy` ship as data for a future 3D caller and are exercised
 *  only by this module's own synthetic tests. */
export const DEFAULT_PROFILE: ForceLimitProfile = {
    name: "rohde-2024-astm-f2291-en13814",
    source: 'Rohde, "Some Details About the Development of Acceleration Limits for Amusement Rides," 2nd ed., March 2024 (vdv-freizeittechnologie.de) — G-Force Task Group summary of ASTM F2291-23b §7 Figs 6-8 / EN 13814-2019 harmonized appendix.',
    sustainedMinDurationS: 0.2,
    exposureCapS: 90,
    bands: [
        {
            axis: "Gz",
            sign: "+",
            citation:
                'S5 brief §Gz table (p.26 Fig 7.4) + prose quote p.26: "6 g … 1 second, after a transition 4 g, followed by 3 g, after 12 seconds 2 g, after 40 seconds 1 g."',
            steps: [
                { thresholdG: 6.0, maxDurationS: 1.0, exact: false },
                { thresholdG: 4.0, maxDurationS: 3.5, exact: false },
                { thresholdG: 3.0, maxDurationS: 7.0, exact: false },
                { thresholdG: 2.0, maxDurationS: 11.8, exact: true },
                { thresholdG: 1.0, maxDurationS: 40, exact: true },
                { thresholdG: 1.0, maxDurationS: 90, exact: true },
            ],
        },
        {
            axis: "Gz",
            sign: "-",
            citation:
                'Approach S5 pinned bands (spec): "−Gz −2g @0.2 s → −1.1g @11.8 s" — the extended F2291-only −2.8g bungee tier and EN 13814\'s exclusion of it are out of scope here.',
            steps: [
                { thresholdG: -2.0, maxDurationS: 11.8, exact: true },
                { thresholdG: -1.1, maxDurationS: 40, exact: true },
                { thresholdG: -1.1, maxDurationS: 90, exact: true },
            ],
        },
        {
            axis: "Gx",
            sign: "+",
            citation:
                "S5 brief §Gx table (p.19-22 Fig 7.2), base/OTSR restraint column only (prone excluded).",
            steps: [
                { thresholdG: 6.0, maxDurationS: 2.0, exact: false },
                { thresholdG: 4.0, maxDurationS: 4.5, exact: false },
                { thresholdG: 3.0, maxDurationS: 11.8, exact: true },
                { thresholdG: 2.5, maxDurationS: 90, exact: true },
            ],
        },
        {
            axis: "Gx",
            sign: "-",
            citation:
                'Approach S5 pinned bands (spec): "−Gx −2g flat (base restraint)" — flat ceiling, no duration-varying tier.',
            steps: [{ thresholdG: -2.0, maxDurationS: 90, exact: true }],
        },
        {
            axis: "Gy",
            sign: "+",
            citation: "S5 brief §Gy table (p.18 Fig 7.1), both standards.",
            steps: [
                { thresholdG: 3.5, maxDurationS: 2.0, exact: false },
                { thresholdG: 2.0, maxDurationS: 90, exact: true },
            ],
        },
        {
            axis: "Gy",
            sign: "-",
            citation: "S5 brief §Gy table (p.18 Fig 7.1), both standards.",
            steps: [
                { thresholdG: -3.5, maxDurationS: 2.0, exact: false },
                { thresholdG: -2.0, maxDurationS: 90, exact: true },
            ],
        },
    ],
};

export interface BandBreach {
    axis: AxisName;
    sign: BandSign;
    /** the breached step. */
    thresholdG: number;
    maxDurationS: number;
    /** the run's own observed duration (s) — always > `maxDurationS`. */
    observedDurationS: number;
    /** the most extreme fN value reached inside the run (max for `+`, min for `-`). */
    observedG: number;
    startStation: number;
    endStation: number;
    startTime: number;
    endTime: number;
    startIndex: number;
    endIndex: number;
}

/** contiguous edge runs `[startIndex, endIndex)` where `fN` sits at-or-beyond `thresholdG` in
 *  `direction` — the same shape as `stats.airtimeMoments`'s run-grouping, generalized to a
 *  signed threshold and comparison direction instead of a fixed `< 0` airtime crossing. */
function runsAtOrBeyond(
    fN: ArrayLike<number>,
    count: number,
    thresholdG: number,
    direction: BandSign,
): { startIndex: number; endIndex: number }[] {
    const edges = count - 1;
    if (edges <= 0) return [];
    const runs: { startIndex: number; endIndex: number }[] = [];
    let runStart = -1;
    const closeRun = (endEdgeExclusive: number): void => {
        if (runStart < 0) return;
        runs.push({ startIndex: runStart, endIndex: endEdgeExclusive });
        runStart = -1;
    };
    for (let i = 0; i < edges; i++) {
        const beyond = direction === "+" ? fN[i] >= thresholdG : fN[i] <= thresholdG;
        if (beyond && runStart < 0) runStart = i;
        else if (!beyond && runStart >= 0) closeRun(i);
    }
    closeRun(edges);
    return runs;
}

/** checks ONE band (a `+`/`-` `Gz`/`Gx`/`Gy` step table) against a real `fN`/`ds`/`t` triple.
 *  Reports every step a run breaches independently — a single sustained excursion typically
 *  breaches more than one step in the table (e.g. 7g held 5s breaches both the 6g/1.0s and
 *  4g/3.5s steps), which is intentional: each breach names the specific rule violated, and a
 *  caller wanting one verdict per excursion can group by `[startIndex, endIndex)`. */
export function checkBand(
    out: Pick<BakeOutLike, "fN" | "ds" | "t">,
    count: number,
    band: AxisBand,
    station?: ArrayLike<number>,
): BandBreach[] {
    const edges = count - 1;
    if (edges <= 0) return [];
    const s = station ?? cumulativeArclength(out.ds, count);
    const breaches: BandBreach[] = [];
    for (const step of band.steps) {
        const runs = runsAtOrBeyond(out.fN, count, step.thresholdG, band.sign);
        for (const run of runs) {
            const durationS = out.t[run.endIndex] - out.t[run.startIndex];
            if (durationS <= step.maxDurationS) continue;
            let extreme = out.fN[run.startIndex];
            for (let i = run.startIndex + 1; i < run.endIndex; i++) {
                const v = out.fN[i];
                if (band.sign === "+" ? v > extreme : v < extreme) extreme = v;
            }
            breaches.push({
                axis: band.axis,
                sign: band.sign,
                thresholdG: step.thresholdG,
                maxDurationS: step.maxDurationS,
                observedDurationS: durationS,
                observedG: extreme,
                startStation: s[run.startIndex],
                endStation: s[run.endIndex],
                startTime: out.t[run.startIndex],
                endTime: out.t[run.endIndex],
                startIndex: run.startIndex,
                endIndex: run.endIndex,
            });
        }
    }
    return breaches;
}

/** the whole-profile check kex2d's `validate` CLI verb (S4) wires in: evaluates ONLY the `Gz`
 *  bands (`+`/`-`) against real `fN` — see module docblock for why `Gx`/`Gy` stay unevaluated
 *  (no channel). Returns every breach across both bands, station-ordered within each band. */
export function checkForceLimits(
    out: BakeOutLike,
    count: number,
    profile: ForceLimitProfile = DEFAULT_PROFILE,
): BandBreach[] {
    const s = cumulativeArclength(out.ds, count);
    const breaches: BandBreach[] = [];
    for (const band of profile.bands) {
        if (band.axis !== "Gz") continue; // no Gx/Gy channel in a 2D bake — see module docblock
        breaches.push(...checkBand(out, count, band, s));
    }
    return breaches;
}

/** the admissible bound `Table 7.1` applies for a reading's OWN sign — the "adm" in Rohde's
 *  `(a/adm)² ≤ 1` formula is asymmetric per axis (e.g. Gz: −2.00 / +6.00), so a negative reading
 *  is bounded by `|min|`, a non-negative reading by `max`. */
function admissibleBound(value: number, bound: { min: number; max: number }): number {
    return value >= 0 ? bound.max : Math.abs(bound.min);
}

/** the pairwise combined-axis "egg" check (S5 brief §Combined-axis "eggs", p.36-38; S5 Approach
 *  pinned bands): `(a1/adm1)² + (a2/adm2)² `, checked against `≤ 1` by the caller
 *  (`pairwiseEllipseOk`). A PURE, axis-agnostic primitive — proven against Rohde's stated formula
 *  on synthetic multi-axis input in this module's own tests, not wired to `checkForceLimits`
 *  (kex2d has one real channel, `fN`/Gz; no x/y reading exists to pair it with). The 3-axis sum
 *  form (all three terms in one sum) is Rohde's own extrapolation, NOT published in either
 *  standard — this module ships only the pairwise form the brief marks as the standard's own. */
export function pairwiseEllipseValue(
    a1: number,
    bound1: { min: number; max: number },
    a2: number,
    bound2: { min: number; max: number },
): number {
    const adm1 = admissibleBound(a1, bound1);
    const adm2 = admissibleBound(a2, bound2);
    return (a1 / adm1) ** 2 + (a2 / adm2) ** 2;
}

export function pairwiseEllipseOk(
    a1: number,
    bound1: { min: number; max: number },
    a2: number,
    bound2: { min: number; max: number },
): boolean {
    return pairwiseEllipseValue(a1, bound1, a2, bound2) <= 1;
}
