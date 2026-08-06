import { expect, test } from "bun:test";
import { evalGeo } from "../src/section";
import { refine, type RefineResult } from "../src/refine";
import { scenarios } from "../src/scenarios";
import { bumpBy, WRAPPED, type WrappedFn } from "./helpers/libm";

/** `kex2d-golden-reproducibility` 3a'. 1c's single-site perturbation (±1..±4 ulps at ONE call)
 *  correctly killed the single-site amplification model, but a different libm never moves one
 *  call — it moves an UNKNOWN SUBSET of the ~583k calls a refine solve makes, each by up to 1
 *  ulp, with the errors accumulating along the solve's own trajectory. That aggregate has never
 *  been measured, and it's the instrument refine's still-open bound depends on: is the observed
 *  Mac↔WSL drift (`deviation` 1.7e-9 m, `floor` 1 ulp, three `points[].g` at ~4e-10) explained by
 *  ECMAScript's declared ≤1-ulp latitude on every implementation-defined call, amplified by the
 *  solve's own measured conditioning?
 *
 *  The probe: reuse 1c's wrapper machinery (`WRAPPED`, `bumpBy`, factored into
 *  `tests/helpers/libm.ts` so this lab and `libm.lab.ts` each register only their own tests —
 *  importing one `.lab.ts` from another would register and run its tests too, since bun collects
 *  `test()` calls at module load, and `libm.lab.ts`'s own suite makes ~583k wrapped calls per
 *  path), but instead of bumping ONE named call, bump EVERY implementation-defined call by a
 *  randomly-signed ±1 ulp,
 *  drawn from a per-trial seeded PRNG so a trial is exactly reproducible. Run the three MINI
 *  scenarios (`refine.test.ts`'s `circular-arc` / `straight-fillet` / `hill-explicit`, all
 *  through the shipping geo→force `refine` path — `hill-explicit` here is the REFINE drive, not
 *  1a's `hill-explicit-geofit` path) for N trials and record the spread of every continuous
 *  golden field.
 *
 *  What this is NOT: it doesn't read the Mac/WSL gap (native, unwrapped values are the only
 *  cross-trial reference), and it isn't tuned toward the observed drift — the spread is a
 *  property of ECMAScript's OWN declared latitude plus this solve's conditioning, measured once,
 *  independent of which two machines happen to be compared. */

const MINI = ["circular-arc", "straight-fillet", "hill-explicit"] as const;
const TRIALS = 24;

/** mulberry32 — a tiny deterministic PRNG, seeded per trial so a trial's exact perturbation
 *  sequence (which call gets which sign, in call order) reproduces on rerun. No dependency on
 *  `Math.random` (which this file must not perturb the meaning of, since it isn't one of the
 *  implementation-defined calls under study but IS used to drive the perturbation itself). */
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** the shipping geo→force drive for one MINI scenario — mirrors `refine.test.ts`'s `CORPUS`
 *  construction (`evalGeo` → `refine`) but as a named function so a trial can call it fresh once
 *  per scenario per trial, under whatever Math wrapper is currently patched in. */
function driveRefine(name: string): RefineResult {
    const scenario = scenarios.find((candidate) => candidate.name === name);
    if (!scenario) throw new Error(`missing scenario ${name}`);
    const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };
    const bake = evalGeo(entry, scenario.nodes, scenario.ds);
    return refine({ bake, entry, ds: scenario.ds });
}

interface AllPerturbed {
    restore: () => void;
    count: () => number;
}

/** wraps every implementation-defined `Math` fn so calls return their true result bumped by a
 *  randomly-signed `magnitudeUlps`-ulp perturbation, drawn from `rng` in call order (so a fixed
 *  `rng` seed reproduces the exact same per-call divergence/sign sequence on rerun).
 *  `magnitudeUlps` is 1 by default (ECMAScript's own declared latitude); the upward probe (below)
 *  raises it only if the 1-ulp spread reads exactly zero, per the spec's non-vacuity clause.
 *
 *  `rate` (3a‴, `kex2d-golden-reproducibility`) is the fraction of calls that actually diverge —
 *  1c/3a' always perturbed 100% of calls, a worst-case model 3a″ measured to be ~10x the REAL
 *  Mac↔WSL rate (10.55% of refine's calls). With probability `1 - rate` a call returns its TRUE
 *  result untouched; with probability `rate` it gets the ±1-ulp bump as before. `rate = 1` (the
 *  default) takes the ORIGINAL branch-free path with no extra `rng()` draw, so every
 *  already-committed 3a' trial reproduces bit-for-bit; only `rate < 1` spends the extra draw to
 *  decide divergence first. A given `(seed, rate)` is exactly reproducible either way, since the
 *  draw order for a fixed rate is deterministic.
 *
 *  Zero is special-cased: `bumpBy`'s bit-pattern arithmetic underflows a negative BigInt when the
 *  true result is exactly 0 and the drawn sign is −1 (`sin(0)` is a real value on this solve's
 *  entry heading), so a `0` result always bumps toward +Infinity regardless of the draw — the
 *  same "smallest possible perturbation" contract `bumpBy`'s own docs describe, just sign-pinned
 *  at the one value where bit-pattern subtraction has no lower neighbor. */
function wrapAllPerturbed(rng: () => number, magnitudeUlps = 1, rate = 1): AllPerturbed {
    let count = 0;
    const originals = WRAPPED.map((fn) => [fn, Math[fn]] as const);
    const patched = Math as unknown as Record<WrappedFn, (...args: number[]) => number>;
    for (const [fn, original] of originals) {
        patched[fn] = (...args: number[]) => {
            const raw = (original as (...a: number[]) => number)(...args);
            count++;
            if (rate < 1 && rng() >= rate) return raw;
            const sign = raw === 0 ? 1 : rng() < 0.5 ? -1 : 1;
            return bumpBy(raw, sign * magnitudeUlps);
        };
    }
    return {
        restore: () => {
            for (const [fn, original] of originals) patched[fn] = original;
        },
        count: () => count,
    };
}

interface ContinuousFields {
    floor: number;
    deviation: number;
    length: number;
    ds: number;
    feasibility: number;
    exit: { dx: number; dy: number; dtheta: number; dist: number };
    peakG: number;
    maxDg: number;
    deviations: number[];
    points: { s: number; g: number }[];
}

function continuousFields(result: RefineResult): ContinuousFields {
    return {
        floor: result.floor,
        deviation: result.final.deviation,
        length: result.final.length,
        ds: result.final.ds,
        feasibility: result.final.feasibility,
        exit: { ...result.final.exit },
        peakG: result.final.peakG,
        maxDg: result.final.maxDg,
        deviations: Array.from(result.final.deviations),
        points: result.final.points.map((p) => ({ s: p.s, g: p.g })),
    };
}

interface DiscreteFields {
    knots: number[];
    probes: number;
    keys: number;
    edges: number;
    outcome: string;
    converged: boolean;
}

function discreteFields(result: RefineResult): DiscreteFields {
    return {
        knots: result.knots,
        probes: result.probes,
        keys: result.final.keys,
        edges: result.final.edges,
        outcome: result.outcome,
        converged: result.final.converged,
    };
}

/** per-field diff, not a single OR — so a report can name WHICH discrete field moved rather
 *  than a bare boolean. `knots` differing includes a length mismatch (a different split/prune
 *  path picked a different number of keys, not just different positions). */
function discreteDiff(a: DiscreteFields, b: DiscreteFields) {
    return {
        knots: a.knots.length !== b.knots.length || a.knots.some((k, i) => k !== b.knots[i]),
        probes: a.probes !== b.probes,
        keys: a.keys !== b.keys,
        edges: a.edges !== b.edges,
        outcome: a.outcome !== b.outcome,
        converged: a.converged !== b.converged,
    };
}

/** max(trial) − min(trial) per scalar field, plus per-point-index s/g, over one scenario's
 *  trial set — the "spread across trials" the 3a' bullet asks for. Native/unperturbed is
 *  deliberately NOT folded into the spread band: the question is the perturbation's own
 *  response, not a distance from the unwrapped answer. */
function spreadReport(trials: ContinuousFields[]): {
    floor: number;
    deviation: number;
    length: number;
    ds: number;
    feasibility: number;
    exit: { dx: number; dy: number; dtheta: number; dist: number };
    peakG: number;
    maxDg: number;
    maxDeviationsSpread: number;
    perPoint: { s: number; g: number }[];
} {
    const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
    const pointCount = trials[0]?.points.length ?? 0;
    const perPoint = Array.from({ length: pointCount }, (_, k) => ({
        s: spread(trials.map((t) => t.points[k].s)),
        g: spread(trials.map((t) => t.points[k].g)),
    }));
    // `deviations` is the per-sample profile (length edges+1) — only comparable across trials
    // that share an edge count (structure held), which is 3a''''s only caller of this on
    // heterogeneous input; a length mismatch reads as 0 rather than throwing, since a caller
    // that filtered to structure-held trials already guarantees equal length.
    const deviationsLen = trials[0]?.deviations.length ?? 0;
    const uniformDeviationsLen = trials.every((t) => t.deviations.length === deviationsLen);
    const maxDeviationsSpread = uniformDeviationsLen
        ? Array.from({ length: deviationsLen }, (_, k) =>
              spread(trials.map((t) => t.deviations[k])),
          ).reduce((acc, v) => Math.max(acc, v), 0)
        : 0;
    return {
        floor: spread(trials.map((t) => t.floor)),
        deviation: spread(trials.map((t) => t.deviation)),
        length: spread(trials.map((t) => t.length)),
        ds: spread(trials.map((t) => t.ds)),
        feasibility: spread(trials.map((t) => t.feasibility)),
        exit: {
            dx: spread(trials.map((t) => t.exit.dx)),
            dy: spread(trials.map((t) => t.exit.dy)),
            dtheta: spread(trials.map((t) => t.exit.dtheta)),
            dist: spread(trials.map((t) => t.exit.dist)),
        },
        peakG: spread(trials.map((t) => t.peakG)),
        maxDg: spread(trials.map((t) => t.maxDg)),
        maxDeviationsSpread,
        perPoint,
    };
}

/** the observed Mac↔WSL drift (Locked decision, stage 2) — refine's failing scenario only
 *  (`circular-arc`, the path 1a/1c named). Not read by the probe; checked against it after. */
const OBSERVED_DRIFT = {
    scenario: "circular-arc",
    floorUlpDelta: 1,
    deviation: 1.7e-9,
    pointsG: 4e-10,
};

test("3a' aggregate-libm sensitivity probe — every wrapped call perturbed by a random ±1 ulp, N=24 trials, three MINI scenarios", () => {
    const native: Record<string, RefineResult> = {};
    for (const name of MINI) native[name] = driveRefine(name);

    const trialsByScenario: Record<string, ContinuousFields[]> = {};
    for (const name of MINI) trialsByScenario[name] = [];
    const discreteMovedFields: Record<
        string,
        {
            knots: boolean;
            probes: boolean;
            keys: boolean;
            edges: boolean;
            outcome: boolean;
            converged: boolean;
        }
    > = {};
    for (const name of MINI) {
        discreteMovedFields[name] = {
            knots: false,
            probes: false,
            keys: false,
            edges: false,
            outcome: false,
            converged: false,
        };
    }
    let anyPerturbed = false;

    for (let trial = 0; trial < TRIALS; trial++) {
        for (const name of MINI) {
            const rng = mulberry32(0x5eed0000 + trial * 97 + name.length);
            const wrapped = wrapAllPerturbed(rng);
            let result: RefineResult;
            try {
                result = driveRefine(name);
            } finally {
                wrapped.restore();
            }
            if (wrapped.count() > 0) anyPerturbed = true;
            trialsByScenario[name].push(continuousFields(result));
            const diff = discreteDiff(discreteFields(result), discreteFields(native[name]));
            const movedFields = discreteMovedFields[name];
            movedFields.knots ||= diff.knots;
            movedFields.probes ||= diff.probes;
            movedFields.keys ||= diff.keys;
            movedFields.edges ||= diff.edges;
            movedFields.outcome ||= diff.outcome;
            movedFields.converged ||= diff.converged;
        }
    }

    // Non-vacuity floor: the wrapper must actually have run (every MINI scenario reaches at
    // least one implementation-defined call through evalGeo → refine's own solve).
    expect(anyPerturbed).toBe(true);

    console.log(`\n=== 3a' aggregate-libm sensitivity probe (N=${TRIALS} trials) ===`);

    let allZero = true;
    for (const name of MINI) {
        const spread = spreadReport(trialsByScenario[name]);
        const maxPointSpread = spread.perPoint.reduce((acc, p) => Math.max(acc, p.s, p.g), 0);
        if (spread.floor !== 0 || spread.deviation !== 0 || maxPointSpread !== 0) {
            allZero = false;
        }
        console.log(`\n-- ${name} --`);
        console.table({
            floor: { spread: spread.floor },
            deviation: { spread: spread.deviation },
            length: { spread: spread.length },
            ds: { spread: spread.ds },
            feasibility: { spread: spread.feasibility },
            "max |points[].s|": { spread: Math.max(0, ...spread.perPoint.map((p) => p.s)) },
            "max |points[].g|": { spread: Math.max(0, ...spread.perPoint.map((p) => p.g)) },
        });
        console.log(
            `  discrete fields moved — knots: ${discreteMovedFields[name].knots}, ` +
                `probes: ${discreteMovedFields[name].probes}, keys: ${discreteMovedFields[name].keys}, ` +
                `edges: ${discreteMovedFields[name].edges}, outcome: ${discreteMovedFields[name].outcome}, ` +
                `converged: ${discreteMovedFields[name].converged}`,
        );
    }

    // Finding 2, per the 3a' bullet: does any DISCRETE field ever move under the aggregate
    // perturbation? This is reported, not asserted — a discrete move here is exactly the
    // refutation the bullet says reopens the bucket for that scenario (3a's judgment, not a
    // probe malfunction), so the lab must not fail on the finding it exists to surface.
    for (const name of MINI) {
        const moved = discreteMovedFields[name];
        const movedNames = (Object.keys(moved) as (keyof typeof moved)[]).filter(
            (key) => moved[key],
        );
        if (movedNames.length > 0) {
            console.log(
                `\nDISCRETE FIELDS MOVED on ${name}: ${movedNames.join(", ")} — the margin ` +
                    "argument bucketing that field exact does not hold on this scenario under " +
                    "the aggregate 1-ulp perturbation.",
            );
        }
    }

    // Coordinator follow-up 1: `converged`'s margin. `converged = feasibility < TOL_FEAS`
    // (`polish.ts:889`, `TOL_FEAS` = 1e-6). Report each scenario's native feasibility and its
    // ratio to TOL_FEAS, plus whether any trial flips `converged` and the measured
    // feasibility spread.
    const TolFeas = 1e-6;
    console.log("\n=== converged's margin (coordinator follow-up 1) ===");
    for (const name of MINI) {
        const feas = native[name].final.feasibility;
        const ratio = feas / TolFeas;
        const spread = spreadReport(trialsByScenario[name]).feasibility;
        const flipped = discreteMovedFields[name].converged;
        console.log(
            `  ${name}: feasibility=${feas} | ratio to TOL_FEAS=${ratio.toFixed(4)} ` +
                `(${(ratio * 100).toFixed(2)}%) | feasibility spread over trials=${spread} | ` +
                `converged flipped in any trial: ${flipped}`,
        );
        if (ratio > 0.9) {
            console.log(
                `  *** ${name} converges within 10% of TOL_FEAS — converged sits on a thin ` +
                    "margin over a drifting float and cannot be bucketed exact. ***",
            );
        }
    }

    // Coordinator follow-up 2: `edges`'s rounding margin. `edges = Math.round(length/step)`
    // via `resolveStep`. Report `length/step`, its fractional part, and the distance from
    // that fraction to the 0.5 rounding boundary, divided by the measured per-trial spread
    // in `length` — the actual safety factor on bucketing `edges` exact.
    console.log("\n=== edges's rounding margin (coordinator follow-up 2) ===");
    for (const name of MINI) {
        const scenario = scenarios.find((candidate) => candidate.name === name);
        if (!scenario) throw new Error(`missing scenario ${name}`);
        const step = scenario.ds;
        const length = native[name].final.length;
        const ratio = length / step;
        const frac = ratio - Math.floor(ratio);
        const distTo05 = Math.abs(frac - 0.5);
        const lengthSpread = spreadReport(trialsByScenario[name]).length;
        const safetyFactor =
            lengthSpread === 0 ? Number.POSITIVE_INFINITY : distTo05 / (lengthSpread / step);
        console.log(
            `  ${name}: length/step=${ratio} | frac=${frac} | distance to 0.5=${distTo05} | ` +
                `length spread over trials=${lengthSpread} | edges moved in any trial: ` +
                `${discreteMovedFields[name].edges} | safety factor (distTo05 / (spread/step))=${safetyFactor}`,
        );
    }

    // Non-vacuity clause: if the 1-ulp aggregate spread reads zero everywhere, probe upward
    // (per Residue's response-curve clause and the spec's explicit instruction) rather than
    // report a bare zero.
    if (allZero) {
        console.log(
            "\n1-ulp aggregate spread read exactly zero on every MINI scenario — probing upward " +
                "for the first magnitude that moves any continuous field.",
        );
        const Magnitudes = [10, 100, 1_000, 10_000, 100_000, 1_000_000];
        for (const magnitudeUlps of Magnitudes) {
            let movedAt: string | undefined;
            for (const name of MINI) {
                const rng = mulberry32(0x51de0000 + magnitudeUlps);
                const wrapped = wrapAllPerturbed(rng, magnitudeUlps);
                let result: RefineResult;
                try {
                    result = driveRefine(name);
                } finally {
                    wrapped.restore();
                }
                const c = continuousFields(result);
                const n = continuousFields(native[name]);
                const moved =
                    c.floor !== n.floor ||
                    c.deviation !== n.deviation ||
                    c.points.some((p, k) => p.s !== n.points[k].s || p.g !== n.points[k].g);
                if (moved) movedAt = name;
            }
            console.log(`  ±${magnitudeUlps} ulps: moved on ${movedAt ?? "nothing"}`);
            if (movedAt !== undefined) break;
        }
    }

    // Finding 3: containment. `deviation`'s 1.7e-9 m and the g-drift's ~4e-10 are absolute
    // magnitudes; the spread computed here is max−min over signed trials, so half the spread
    // is the right comparison to an absolute one-directional drift reading, but containment
    // is checked against the FULL spread (the more conservative, larger bound) rather than
    // halving it in the model's favor.
    const arcSpread = spreadReport(trialsByScenario[OBSERVED_DRIFT.scenario]);
    const arcMaxPointG = Math.max(0, ...arcSpread.perPoint.map((p) => p.g));
    console.log(
        `\n=== containment check (${OBSERVED_DRIFT.scenario}) ===\n` +
            `  observed deviation drift: ${OBSERVED_DRIFT.deviation} m | measured spread: ${arcSpread.deviation} m ` +
            `| contained: ${OBSERVED_DRIFT.deviation <= arcSpread.deviation}\n` +
            `  observed points[].g drift: ~${OBSERVED_DRIFT.pointsG} | measured max points[].g spread: ${arcMaxPointG} ` +
            `| contained: ${OBSERVED_DRIFT.pointsG <= arcMaxPointG}\n` +
            `  observed floor drift: 1 ulp | measured floor spread: ${arcSpread.floor} ` +
            `| contained: ${arcSpread.floor > 0}`,
    );
}, 120_000);

/** `kex2d-golden-reproducibility` 3a‴. 3a' perturbed every implementation-defined call at a
 *  worst-case 100% divergence rate and found straight-fillet's knot set flip. 3a″ then measured
 *  the REAL Mac↔WSL divergence rate against stage 1b's committed 256-row `linux x64` head
 *  reference: 10.55% of refine's calls diverge (27/256, ALL of them `hypot`; 27 of the 158 hypot
 *  calls in that sample, ≈17.09% of hypot calls specifically), 1.56% of geofit's, always exactly
 *  1 ulp, scattered rather than clustered. So 3a' is saturated roughly 10x relative to reality,
 *  and the one question this stage answers is whether the flip survives at a realistic rate. */

const HYPOT_REAL_RATE = 27 / 158; // 3a″: 27 of 158 hypot calls diverged in the 256-row head reference

/** wraps ONLY `Math.hypot` at a given divergence `rate` — 3a″'s second arm, since every real
 *  Mac↔WSL divergence it found was a `hypot` call. Same sign/zero/reproducibility contract as
 *  `wrapAllPerturbed`. */
function wrapHypotOnly(rng: () => number, rate: number, magnitudeUlps = 1): AllPerturbed {
    let count = 0;
    const original = Math.hypot;
    Math.hypot = (...args: number[]) => {
        const raw = original(...args);
        count++;
        if (rng() >= rate) return raw;
        const sign = raw === 0 ? 1 : rng() < 0.5 ? -1 : 1;
        return bumpBy(raw, sign * magnitudeUlps);
    };
    return {
        restore: () => {
            Math.hypot = original;
        },
        count: () => count,
    };
}

/** does EVERY discrete field match native — the "structure held" predicate the conditional
 *  continuous bound is restricted to (Locked decision, 3a': continuous fields are bounded
 *  conditional on the structure matching, since an unconditioned bound would have to swallow a
 *  structural change, which is what straight-fillet's 0.0977 `deviation` spread showed). */
function structureHeld(diff: ReturnType<typeof discreteDiff>): boolean {
    return (
        !diff.knots && !diff.probes && !diff.keys && !diff.edges && !diff.outcome && !diff.converged
    );
}

// Cut mid-session on the coordinator's instruction: the full {0.05,0.1,0.2,0.4,0.7,1.0} grid
// stalled past budget after only rate=0.05 finished (partial data: straight-fillet flipped
// 28/40 there). Reduced to the three cells that answer the open question — 0.1 (the measured
// real rate), 0.4 (one intermediate point), 1.0 (the control that must reproduce 3a') — with N
// held at 40 per `coding.md`'s "cut the rate grid before cutting N." Restore the full grid when
// runtime budget allows; nothing else about the sweep changed.
const RATE_SWEEP = [0.1, 0.4, 1.0] as const;
const SWEEP_TRIALS = 40;

test("3a‴ divergence-rate sweep — structural flip rate at a realistic (not worst-case) rate", () => {
    const native: Record<string, RefineResult> = {};
    for (const name of MINI) native[name] = driveRefine(name);

    console.log(`\n=== 3a''' divergence-rate sweep (N=${SWEEP_TRIALS} trials/cell) ===`);

    // rate ≈ 0.1 is what 3a'' measured on the real Mac↔WSL head reference (10.55% of
    // refine's calls). Flips at THIS rate, pooled across all three scenarios, are the
    // finding this stage exists to produce — tracked separately from the sweep table below.
    let flipsAtRealisticRate = 0;
    let trialsAtRealisticRate = 0;

    for (let rateIndex = 0; rateIndex < RATE_SWEEP.length; rateIndex++) {
        const rate = RATE_SWEEP[rateIndex];
        console.log(`\n-- rate=${rate} --`);
        for (const name of MINI) {
            const discreteCounts = {
                knots: 0,
                probes: 0,
                keys: 0,
                edges: 0,
                outcome: 0,
                converged: 0,
            };
            let anyDiscreteMoved = 0;
            const heldContinuous: ContinuousFields[] = [];

            for (let trial = 0; trial < SWEEP_TRIALS; trial++) {
                const rng = mulberry32(0x9a3e0000 + rateIndex * 100_003 + trial * 97 + name.length);
                const wrapped = wrapAllPerturbed(rng, 1, rate);
                let result: RefineResult;
                try {
                    result = driveRefine(name);
                } finally {
                    wrapped.restore();
                }
                const diff = discreteDiff(discreteFields(result), discreteFields(native[name]));
                if (diff.knots) discreteCounts.knots++;
                if (diff.probes) discreteCounts.probes++;
                if (diff.keys) discreteCounts.keys++;
                if (diff.edges) discreteCounts.edges++;
                if (diff.outcome) discreteCounts.outcome++;
                if (diff.converged) discreteCounts.converged++;
                const moved =
                    diff.knots ||
                    diff.probes ||
                    diff.keys ||
                    diff.edges ||
                    diff.outcome ||
                    diff.converged;
                if (moved) anyDiscreteMoved++;
                if (structureHeld(diff)) heldContinuous.push(continuousFields(result));

                if (rate === 0.1) {
                    trialsAtRealisticRate++;
                    if (moved) flipsAtRealisticRate++;
                }
            }

            const conditional =
                heldContinuous.length > 0 ? spreadReport(heldContinuous) : undefined;
            console.log(
                `  ${name}: any-discrete-diff ${anyDiscreteMoved}/${SWEEP_TRIALS} ` +
                    `(knots ${discreteCounts.knots}, probes ${discreteCounts.probes}, ` +
                    `keys ${discreteCounts.keys}, edges ${discreteCounts.edges}, ` +
                    `outcome ${discreteCounts.outcome}, converged ${discreteCounts.converged}) | ` +
                    `structure held ${heldContinuous.length}/${SWEEP_TRIALS}`,
            );
            if (conditional) {
                const maxPointSpread = conditional.perPoint.reduce(
                    (acc, p) => Math.max(acc, p.s, p.g),
                    0,
                );
                console.log(
                    "    conditional (structure-held) spread — " +
                        `floor ${conditional.floor}, deviation ${conditional.deviation}, ` +
                        `length ${conditional.length}, ds ${conditional.ds}, ` +
                        `feasibility ${conditional.feasibility}, ` +
                        `max |points[].s|/|points[].g| ${maxPointSpread}`,
                );
            } else {
                console.log(
                    "    conditional (structure-held) spread — N/A, 0 trials held structure",
                );
            }
        }
    }

    // The stated deliverable: the structural flip rate at rate ≈ 0.1, with a confidence read.
    console.log(
        "\n=== finding: structural flip rate at rate=0.1 " +
            `(N=${trialsAtRealisticRate} pooled across all MINI scenarios) ===`,
    );
    if (flipsAtRealisticRate === 0) {
        const upperBound95 = 3 / trialsAtRealisticRate; // rule of three
        console.log(
            `  0/${trialsAtRealisticRate} flips observed. Rule-of-three 95% upper bound on ` +
                `the per-trial flip probability: ${(upperBound95 * 100).toFixed(2)}%.`,
        );
    } else {
        console.log(
            `  ${flipsAtRealisticRate}/${trialsAtRealisticRate} flips observed — NONZERO at ` +
                "a realistic divergence rate. The structural half of the contract cannot " +
                'claim "any platform" at this rate.',
        );
    }
}, 900_000);

test("3a‴ hypot-only arm — perturb ONLY Math.hypot at 3a''s measured real rate (27/158 ≈ 17.09%)", () => {
    const native: Record<string, RefineResult> = {};
    for (const name of MINI) native[name] = driveRefine(name);

    let flips = 0;
    let trials = 0;
    console.log(
        `\n=== 3a''' hypot-only arm (rate=${HYPOT_REAL_RATE.toFixed(4)}, ` +
            `N=${SWEEP_TRIALS}/scenario) ===`,
    );
    for (const name of MINI) {
        let anyDiscreteMoved = 0;
        for (let trial = 0; trial < SWEEP_TRIALS; trial++) {
            const rng = mulberry32(0x11a70000 + trial * 97 + name.length);
            const wrapped = wrapHypotOnly(rng, HYPOT_REAL_RATE);
            let result: RefineResult;
            try {
                result = driveRefine(name);
            } finally {
                wrapped.restore();
            }
            const diff = discreteDiff(discreteFields(result), discreteFields(native[name]));
            const moved =
                diff.knots ||
                diff.probes ||
                diff.keys ||
                diff.edges ||
                diff.outcome ||
                diff.converged;
            if (moved) anyDiscreteMoved++;
            flips += moved ? 1 : 0;
            trials++;
        }
        console.log(`  ${name}: any-discrete-diff ${anyDiscreteMoved}/${SWEEP_TRIALS}`);
    }
    console.log(
        `\n  total: ${flips}/${trials} flips under hypot-only perturbation at the measured ` +
            "real rate.",
    );
}, 300_000);

/** `kex2d-golden-reproducibility` 3a''''. 3a''' modeled libm difference as per-call NOISE —
 *  `wrapAllPerturbed`/`wrapHypotOnly` draw a fresh random sign each call — and that noise model
 *  is refuted by an observation already in the spec: Mac and WSL agree exactly on
 *  straight-fillet's knots, where the noise model predicted a 75% flip at the realistic rate.
 *  The modeling error: a real alternate libm is a DIFFERENT DETERMINISTIC FUNCTION — `hypot(a,b)`
 *  returns the same answer for the same `(a,b)` every time — not a coin re-flipped per call. A
 *  deterministic perturbation lets the split/prune loop's near-tie comparisons and the solve's
 *  fixed-point iteration converge the way they do against a real alternate libm; a re-randomized
 *  one keeps moving the target underneath them.
 *
 *  `wrapArgKeyed` replaces the per-call coin with a hash of the ARGUMENT's own bit pattern mixed
 *  with a per-instance `seed`: the decision (and the bump's sign) is a pure function of
 *  `(seed, args)`, so the SAME argument always gets the SAME alternate answer, and a different
 *  `seed` draws a different hypothetical alternate-libm instance over the same argument
 *  population. Same magnitude (1 ulp) and same rate (3a''s measured 17.09% of `hypot` calls) as
 *  every prior instrument in this unit — only the STRUCTURE of the perturbation changes.
 *
 *  THE CONTROL RUNS FIRST AND IS MANDATORY (Locked decision, 3a''''; Residue's "an instrument is
 *  evidence only once you've seen it reproduce"). No instrument in this unit — 1c, 3a', 3a''' —
 *  was ever asked to reproduce the one real cross-machine difference this whole investigation
 *  exists to explain, though it was measured, committed, and sitting in the spec throughout. This
 *  test reproduces it or says plainly that it doesn't, and only computes the structural
 *  question + the ⧗ bound cells if the control passes — per the spec's explicit instruction to
 *  report predictions as not counting rather than reporting them anyway. */

/** MurmurHash3's 64-bit finalizer (fmix64) — a small, well-mixed avalanche function, used here
 *  only as a deterministic bit-mixer (not for its collision-resistance properties, which this
 *  application doesn't need). */
function fmix64(hIn: bigint): bigint {
    let h = BigInt.asUintN(64, hIn);
    h ^= h >> 33n;
    h = BigInt.asUintN(64, h * 0xff51afd7ed558ccdn);
    h ^= h >> 33n;
    h = BigInt.asUintN(64, h * 0xc4ceb9fe1a85ec53n);
    h ^= h >> 33n;
    return h;
}

/** hashes a `seed` + a call's argument bit pattern(s) to a uniform value in [0, 1). Deterministic
 *  — the SAME `(seed, args)` always yields the SAME value, which is the whole point: a real
 *  alternate libm decides per-argument, not per-call. `salt` draws a second, independent stream
 *  off the same `(seed, args)` pair (used for the bump's sign) without re-hashing the seed. */
function hashArgsToUnit(seed: number, args: readonly number[], salt = 0): number {
    const view = new DataView(new ArrayBuffer(8));
    let h = fmix64(BigInt(seed >>> 0) ^ (BigInt(salt >>> 0) << 32n) ^ 0x9e3779b97f4a7c15n);
    for (const a of args) {
        view.setFloat64(0, a);
        h = fmix64(h ^ view.getBigUint64(0));
    }
    return Number(BigInt.asUintN(64, h) >> 11n) / Number(1n << 53n); // top 53 bits -> [0, 1)
}

/** wraps ONE `Math` fn (`hypot`, per 3a'' — every real Mac<->WSL divergence found was `hypot`) so
 *  a call whose ARGUMENT hashes below `rate` (keyed on `seed`) returns its true result bumped by
 *  a `magnitudeUlps`-ulp perturbation whose SIGN is also argument-keyed (so the same argument
 *  perturbs the same way every time it recurs within one `seed`'s "alternate libm"). `zero`'s
 *  same-value convention as `wrapAllPerturbed`: a true `0` result always bumps toward +Infinity
 *  (no lower bit-pattern neighbor to subtract toward). */
function wrapArgKeyed(fn: WrappedFn, seed: number, rate: number, magnitudeUlps = 1): AllPerturbed {
    let count = 0;
    const original = Math[fn];
    const patched = Math as unknown as Record<WrappedFn, (...args: number[]) => number>;
    patched[fn] = (...args: number[]) => {
        const raw = (original as (...a: number[]) => number)(...args);
        count++;
        if (hashArgsToUnit(seed, args) >= rate) return raw;
        const sign = raw === 0 ? 1 : hashArgsToUnit(seed, args, 1) < 0.5 ? -1 : 1;
        return bumpBy(raw, sign * magnitudeUlps);
    };
    return {
        restore: () => {
            patched[fn] = original;
        },
        count: () => count,
    };
}

/** the signed ulp distance `b − a` for two same-sign finite doubles (both `floor`/`deviation`
 *  values here are positive) — IEEE-754's bit pattern is monotonic in value for a fixed sign, so
 *  a bare `BigInt64` subtraction of the reinterpreted bits is exact. */
function ulpDistance(a: number, b: number): number {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, a);
    const bitsA = view.getBigInt64(0);
    view.setFloat64(0, b);
    const bitsB = view.getBigInt64(0);
    return Number(bitsB - bitsA);
}

/** the seed count for BOTH the control and (if it passes) the structural/bound reading below —
 *  one N=40 run serves both questions, since they're the same experiment read two ways: does
 *  argument-keyed hypot at the real rate reproduce the known signature, and (only if so) how
 *  often does structure flip and what do the continuous fields spread to. Matches 3a'''s
 *  `SWEEP_TRIALS` and the spec's stated floor of N >= 40. */
const HASH_SEED_COUNT = 40;

/** per-seed grading against the known Mac<->WSL refine signature (Locked decision: `floor` ~1
 *  ulp, `deviation` ~1.7e-9 m, three `points[].g` ~4e-10, on `circular-arc` — `OBSERVED_DRIFT`
 *  above — with structure holding on ALL THREE MINI scenarios, per stage 2's assertion read). A
 *  different `seed` is a different hypothetical libm and won't land the exact observed number, so
 *  "reproduces" is graded to within one decade of the observed magnitude on each continuous
 *  field — the property a faithful model should get right on every draw, not the exact value. */
function reproducesSignature(
    structuralHeld: boolean,
    floorUlps: number,
    deviationDelta: number,
    maxPointsGDelta: number,
): { pass: boolean; reason: string } {
    if (!structuralHeld) return { pass: false, reason: "structure flipped on some scenario" };
    if (floorUlps === 0) return { pass: false, reason: "floor did not move" };
    if (Math.abs(floorUlps) > 10) {
        return { pass: false, reason: `floor moved ${floorUlps} ulps, too far from ~1` };
    }
    if (deviationDelta < 1e-10 || deviationDelta > 1e-8) {
        return { pass: false, reason: `deviation Δ ${deviationDelta} outside [1e-10, 1e-8]` };
    }
    if (maxPointsGDelta < 1e-11 || maxPointsGDelta > 1e-9) {
        return {
            pass: false,
            reason: `max |Δ points[].g| ${maxPointsGDelta} outside [1e-11, 1e-9]`,
        };
    }
    return { pass: true, reason: "reproduced" };
}

test("3a'''' argument-keyed hypot perturbation — control first (mandatory); structural question + ⧗ bound cells only if it passes", () => {
    const native: Record<string, RefineResult> = {};
    for (const name of MINI) native[name] = driveRefine(name);

    console.log(
        `\n=== 3a'''' control: argument-keyed hypot at the real rate ` +
            `(${(HYPOT_REAL_RATE * 100).toFixed(2)}%), N=${HASH_SEED_COUNT} seeds ===`,
    );

    interface SeedRow {
        seed: number;
        structuralHeld: boolean;
        floorUlps: number;
        deviationDelta: number;
        maxPointsGDelta: number;
        reproduced: boolean;
        reason: string;
    }
    const rows: SeedRow[] = [];
    const scenarioFlipCount: Record<string, number> = {};
    for (const name of MINI) scenarioFlipCount[name] = 0;
    // per-scenario continuous fields from seeds where THAT scenario's structure held — the
    // "conditional on structure matching" restriction the Locked decision's contract requires
    // (3a''s straight-fillet lesson: an unconditioned continuous bound has to swallow a
    // structural change, which is not a bound at all).
    const heldContinuousByScenario: Record<string, ContinuousFields[]> = {};
    for (const name of MINI) heldContinuousByScenario[name] = [];

    for (let seed = 0; seed < HASH_SEED_COUNT; seed++) {
        const wrapped = wrapArgKeyed("hypot", 0xc0de0000 + seed, HYPOT_REAL_RATE);
        const results: Record<string, RefineResult> = {};
        try {
            for (const name of MINI) results[name] = driveRefine(name);
        } finally {
            wrapped.restore();
        }

        let structuralHeld = true;
        for (const name of MINI) {
            const diff = discreteDiff(discreteFields(results[name]), discreteFields(native[name]));
            const moved =
                diff.knots ||
                diff.probes ||
                diff.keys ||
                diff.edges ||
                diff.outcome ||
                diff.converged;
            if (moved) {
                structuralHeld = false;
                scenarioFlipCount[name]++;
            } else {
                heldContinuousByScenario[name].push(continuousFields(results[name]));
            }
        }

        const arcNative = continuousFields(native["circular-arc"]);
        const arcPerturbed = continuousFields(results["circular-arc"]);
        const floorUlps = ulpDistance(arcNative.floor, arcPerturbed.floor);
        const deviationDelta = Math.abs(arcPerturbed.deviation - arcNative.deviation);
        const maxPointsGDelta = Math.max(
            0,
            ...arcPerturbed.points.map((p, i) => Math.abs(p.g - arcNative.points[i].g)),
        );

        const { pass, reason } = reproducesSignature(
            structuralHeld,
            floorUlps,
            deviationDelta,
            maxPointsGDelta,
        );
        rows.push({
            seed,
            structuralHeld,
            floorUlps,
            deviationDelta,
            maxPointsGDelta,
            reproduced: pass,
            reason,
        });
    }

    console.table(
        rows.map((r) => ({
            seed: r.seed,
            "structure held": r.structuralHeld,
            "floor Δulp": r.floorUlps,
            "deviation Δ": r.deviationDelta,
            "max |Δ points[].g|": r.maxPointsGDelta,
            reproduced: r.reproduced,
            reason: r.reason,
        })),
    );

    const reproducedCount = rows.filter((r) => r.reproduced).length;
    const totalStructuralFlips = MINI.reduce((acc, name) => acc + scenarioFlipCount[name], 0);
    const seedsWithAnyFlip = rows.filter((r) => !r.structuralHeld).length;
    console.log(
        `\n  ${reproducedCount}/${HASH_SEED_COUNT} seeds reproduce the known signature ` +
            "(structure held on all three scenarios + floor/deviation/points[].g within a " +
            `decade of observed). ${seedsWithAnyFlip}/${HASH_SEED_COUNT} seeds broke structure ` +
            "on at least one scenario.",
    );
    for (const name of MINI) {
        console.log(
            `  ${name}: structure moved on ${scenarioFlipCount[name]}/${HASH_SEED_COUNT} seeds`,
        );
    }
    const missReasons = rows.filter((r) => !r.reproduced).map((r) => r.reason);
    if (missReasons.length > 0) {
        const tally = new Map<string, number>();
        for (const reason of missReasons) {
            const bucket =
                reason.split(" ")[0] + (reason.includes("structure") ? " (structural)" : "");
            tally.set(bucket, (tally.get(bucket) ?? 0) + 1);
        }
        console.log(
            `  miss directions: ${Array.from(tally.entries())
                .map(([k, v]) => `${k} x${v}`)
                .join(", ")}`,
        );
    }

    // The gate: majority magnitude-reproduction AND zero structural flips anywhere, on any
    // scenario, at any seed. Both load-bearing — a single structural flip reopens the fork this
    // control exists to close for `knots` (Locked decision), and sub-majority magnitude
    // reproduction means the instrument's rate/magnitude model, however faithfully KEYED, isn't
    // landing where the one real pair we have landed.
    const controlPassed = totalStructuralFlips === 0 && reproducedCount >= HASH_SEED_COUNT / 2;
    console.log(
        `\n=== CONTROL VERDICT: ${controlPassed ? "REPRODUCED" : "DID NOT REPRODUCE"} ` +
            `(${totalStructuralFlips} structural flips across ${HASH_SEED_COUNT * MINI.length} ` +
            `scenario-seeds, ${reproducedCount}/${HASH_SEED_COUNT} magnitude-reproducing) ===`,
    );

    if (!controlPassed) {
        console.log(
            "\nThe control did not reproduce the known Mac<->WSL signature. Per this stage's " +
                "mandate, NONE of the structural question or the ⧗ bound cells are computed or " +
                "reported below — they would not count even if printed.",
        );
        return;
    }

    console.log(
        "\nThe control reproduced the known signature. The structural question and the ⧗ bound " +
            "cells below are read off the SAME N=40-seed run (structure-conditional, per scenario).",
    );

    console.log(
        `\n=== structural flip rate at the real rate (N=${HASH_SEED_COUNT} seeds x ` +
            `${MINI.length} scenarios = ${HASH_SEED_COUNT * MINI.length} scenario-seeds) ===`,
    );
    if (totalStructuralFlips === 0) {
        const upperBound95 = 3 / (HASH_SEED_COUNT * MINI.length); // rule of three
        console.log(
            `  0/${HASH_SEED_COUNT * MINI.length} flips observed. Rule-of-three 95% upper bound ` +
                `on the per-scenario-seed flip probability: ${(upperBound95 * 100).toFixed(3)}%.`,
        );
    } else {
        console.log(
            `  ${totalStructuralFlips}/${HASH_SEED_COUNT * MINI.length} flips observed — ` +
                "NONZERO under the faithful, argument-keyed instrument.",
        );
    }

    console.log("\n=== ⧗ bound cells: structure-conditional spread, per scenario ===");
    for (const name of MINI) {
        const held = heldContinuousByScenario[name];
        if (held.length === 0) {
            console.log(`  ${name}: N/A — 0/${HASH_SEED_COUNT} seeds held structure`);
            continue;
        }
        const spread = spreadReport(held);
        const maxPointG = Math.max(0, ...spread.perPoint.map((p) => p.g));
        console.log(`\n  -- ${name} (${held.length}/${HASH_SEED_COUNT} seeds held structure) --`);
        console.table({
            deviation: { spread: spread.deviation },
            "points[].g (max)": { spread: maxPointG },
            deviations: { spread: spread.maxDeviationsSpread },
            feasibility: { spread: spread.feasibility },
            "exit.dx": { spread: spread.exit.dx },
            "exit.dy": { spread: spread.exit.dy },
            "exit.dtheta": { spread: spread.exit.dtheta },
            "exit.dist": { spread: spread.exit.dist },
            peakG: { spread: spread.peakG },
            maxDg: { spread: spread.maxDg },
        });
    }
}, 300_000);
