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

/** wraps every implementation-defined `Math` fn so EVERY call returns its true result bumped by
 *  a randomly-signed `magnitudeUlps`-ulp perturbation, drawn from `rng` in call order (so a fixed
 *  `rng` seed reproduces the exact same per-call sign sequence on rerun). `magnitudeUlps` is 1 by
 *  default (ECMAScript's own declared latitude); the upward probe (below) raises it only if the
 *  1-ulp spread reads exactly zero, per the spec's non-vacuity clause.
 *
 *  Zero is special-cased: `bumpBy`'s bit-pattern arithmetic underflows a negative BigInt when the
 *  true result is exactly 0 and the drawn sign is −1 (`sin(0)` is a real value on this solve's
 *  entry heading), so a `0` result always bumps toward +Infinity regardless of the draw — the
 *  same "smallest possible perturbation" contract `bumpBy`'s own docs describe, just sign-pinned
 *  at the one value where bit-pattern subtraction has no lower neighbor. */
function wrapAllPerturbed(rng: () => number, magnitudeUlps = 1): AllPerturbed {
    let count = 0;
    const originals = WRAPPED.map((fn) => [fn, Math[fn]] as const);
    const patched = Math as unknown as Record<WrappedFn, (...args: number[]) => number>;
    for (const [fn, original] of originals) {
        patched[fn] = (...args: number[]) => {
            const raw = (original as (...a: number[]) => number)(...args);
            count++;
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
    points: { s: number; g: number }[];
}

function continuousFields(result: RefineResult): ContinuousFields {
    return {
        floor: result.floor,
        deviation: result.final.deviation,
        length: result.final.length,
        ds: result.final.ds,
        feasibility: result.final.feasibility,
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
    perPoint: { s: number; g: number }[];
} {
    const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
    const pointCount = trials[0]?.points.length ?? 0;
    const perPoint = Array.from({ length: pointCount }, (_, k) => ({
        s: spread(trials.map((t) => t.points[k].s)),
        g: spread(trials.map((t) => t.points[k].g)),
    }));
    return {
        floor: spread(trials.map((t) => t.floor)),
        deviation: spread(trials.map((t) => t.deviation)),
        length: spread(trials.map((t) => t.length)),
        ds: spread(trials.map((t) => t.ds)),
        feasibility: spread(trials.map((t) => t.feasibility)),
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
