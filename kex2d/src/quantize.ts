/** EASING-TAG QUANTIZATION: snap a solved profile's handles onto the named-easing
 *  vocabulary wherever the geometry still holds the authoring floor. The conversion tier's
 *  stage 4 (`specs/kex2d-geoforce-convert.md`) — pure, framework-free, f64, kernel-atom
 *  family (`polish.ts`, `refine.ts`), NOT on the live path.
 *
 *  **What a named tag actually demands.** The editor's easing ladder is one derived-flat
 *  -tangent influence axis (`profile.ts`: Linear 0 | Cubic 1/3 | Quintic 7/15), and *flat*
 *  is the load-bearing word — a named segment leaves both of its bounding keys with
 *  `F′ = 0`. The vocabulary is a hold-to-hold transition language, inherited from FVD's
 *  constant-target sections. So the question "can this segment be named" is not a question
 *  about handle lengths at all: it is whether the profile can be re-solved with the slope
 *  at BOTH of the segment's keys pinned to zero and still track the geometry.
 *
 *  **So the snap is a constraint, not a rounding.** Rounding the solved handles onto the
 *  ladder in place is what the name suggests, and it recovers NOTHING: measured over the
 *  whole corpus, 0 of 84 segments hold the floor when their two keys are flattened without
 *  re-solving, and the closest any of them comes is 4.0x the floor (the median miss is two
 *  orders past it). The refine loop settles at minimal keys hard against the floor, so every
 *  DOF it kept is load-bearing and removing one throws the geometry out. Pinning the two
 *  keys flat and RE-SOLVING the rest is the same move the tier already makes for corners: a
 *  discrete per-key vocabulary state chosen by an outer loop, with the continuous solve
 *  re-projecting onto it (`polish.slopeSlots` — a corner adds a slope to a key, a flat
 *  removes one). That is what turns 0 into 5.
 *
 *  Note the snap is per KEY, not per segment: flattening only the two sides that FACE each
 *  other would name the segment while leaving each of its keys with one sloped side and one
 *  flat — a slope break at a key that no `Corners` entry declares, which is the one state
 *  the vocabulary lock exists to forbid. `polish` refuses it at the boundary for that
 *  reason, so the illegal-but-cheaper snap is not available even by accident.
 *
 *  **The ceiling is structural, and it is the finding.** A geo→force profile RAMPS, and
 *  nothing in the solve pulls a key toward flat: the fairing prior's null space is the
 *  globally-linear profile, so it prices bending rather than slope. Measured over the
 *  corpus's 94 settled keys, |m| runs from 7.3e-3 to 84.7 g/m with a median of 0.29 —
 *  not one of them is near zero, and a key with a nonzero slope is Custom by definition of
 *  the vocabulary. Naming is therefore
 *  available only where the target force genuinely turns over — near its extrema and its
 *  plateaus — and no quantizer can widen that. The tier's authorability rests on the
 *  vocabulary-constrained DOF (zero broken keys) and on minimal keys; named easings are a
 *  bonus on top, not the load-bearing rung the spike implied.
 *
 *  **Minimal keys and named tags compete for one slack budget.** Both are paid for out of
 *  the same distance between the achieved deviation and the floor, and `refine`'s prune
 *  spends it first, by design (lock 4: discrepancy-constrained minimal keys). Buying a tag
 *  by giving a key back would need an exchange rate between the two, which is exactly the
 *  tuned price that lock declares the loop free of — so this module takes what the prune
 *  left and never bids against it.
 *
 *  **Only the Cubic rung is reachable, by derivation.** A pinned-flat key's derived
 *  tangents come from `profile.segment`, which resolves an absent side at the tag's
 *  influence — and only Cubic's 1/3 lands on the span/3 reach where `polish.fairRows` is
 *  exactly `∫(F″)² ds`. Linear (reach 0) and Quintic (7/15) leave that family, where the
 *  closed form silently mis-prices, so the tier cannot re-solve against them at all
 *  (the domain law, `fairRows`' note). Nor is there anything to gain post-hoc: the answer
 *  this module returns was SOLVED at the Cubic reach, so Cubic is the tag that describes
 *  its own shape, and re-tagging a segment to Linear or Quintic would move a curve the
 *  solve just fitted. A named segment therefore stores no `ease` at all — Cubic is the
 *  absent-value default (`profile.ts`'s no-stored-state convention), so the whole
 *  quantization is expressed by REMOVING handles. Nothing here ever prices an off-family
 *  profile, so the mis-pricing hazard the domain law warns about cannot arise; the guard
 *  that keeps it that way lives at `polish`'s boundary, which refuses a non-Cubic tag.
 *
 *  **The tolerance is the floor itself.** A snap is admissible iff the re-solved profile
 *  still holds the derived authoring floor (`polish.authoringFloor`) — the same constraint
 *  `refine` accepts against, so there is no quantization tolerance to tune and none exists.
 *  Candidates are probed unregularized (λ = 0), and an accepted candidate's calm answer is
 *  guaranteed to hold the floor too: the discrepancy search keeps only λs verified against
 *  it and falls back to the λ = 0 solve, which is the probe.
 *
 *  **Nothing here bounds violence.** The accept is floor-only and the tiebreak reads
 *  deviation, so a named tag can cost arbitrary dense peak and roughness — measured, it
 *  costs up to 1.07x and 1.27x on this corpus. That is deliberate: a violence PRICE would be
 *  an exchange rate between authorability and calm, which is exactly what lock 4 keeps the
 *  tier free of. The tiebreak could read violence for free, since it is declared rather than
 *  derived; it does not, so that the only thing deciding what gets named is the floor.
 *
 *  **Deterministic.** The scan is exhaustive per round, the accept is the floor's own
 *  reading, and the winner among holders is a declared tiebreak (most slack, lowest segment
 *  index on a tie) — `refine`'s prune, one rung down the vocabulary. Unlike there, the
 *  exhaustiveness is currently INERT: measured over the corpus, inverting the tiebreak to
 *  least-slack changes nothing, and taking the first holder instead of scanning changes
 *  nothing while spending ~26% fewer probes on the three scenarios that name more than one
 *  segment. The scan is kept anyway — the argument for it is that an ordering proxy must not
 *  be what decides which segment gets named, and that is about meaning rather than about
 *  this corpus — but the honest reading is that it buys nothing measurable here, and a
 *  cheaper order would be a fair trade if the search ever has to run interactively. */

import { type Bake, type Corners, polish, type PolishResult } from "./polish";
import { custom, type ForcePoint } from "./profile";
import type { Entry } from "./section";

/** the profile with the given keys' explicit handles removed — the FLAT state, whose
 *  derived Cubic tangents reach the same span/3 with Δg = 0. Pure, and the one place the
 *  snap is expressed: everything else here is search.
 *
 * @example
 * const named = flatten(answer.points, new Set([3, 4])); // segment 3 is now named
 */
export function flatten(pts: readonly ForcePoint[], flats: ReadonlySet<number>): ForcePoint[] {
    return pts.map((p, k) => {
        const q: ForcePoint = { s: p.s, g: p.g };
        // a FLATTENED key drops its tag with its handles — the state it lands in is the
        // Cubic default, which is the absent value. Every other key keeps whatever it
        // carried: this is a vocabulary snap, not a place to quietly eat authored data.
        if (flats.has(k)) return q;
        if (p.ease !== undefined) q.ease = p.ease;
        if (p.in) q.in = { ...p.in };
        if (p.out) q.out = { ...p.out };
        return q;
    });
}

/** the segments a profile carries as named easings — the complement of `profile.custom`,
 *  and the census this module reports. Segment `k` runs from key `k` to key `k + 1`.
 *
 * @example
 * const recovered = namedSegments(result.final.points).length;
 */
export function namedSegments(pts: readonly ForcePoint[]): number[] {
    const out: number[] = [];
    for (let k = 0; k + 1 < pts.length; k++) if (!custom(pts[k], pts[k + 1])) out.push(k);
    return out;
}

export interface QuantizeOpts {
    bake: Bake;
    /** the entry the bake was evaluated from. */
    entry: Entry;
    /** nominal edge step (m), as `polish` takes it. */
    ds: number;
    /** the settled answer to quantize — `refine`'s `final`, or any calm ALIGNED polish
     *  answer over the same bake. Its `points` supply the keys (placement is fixed here,
     *  as it is in `polish`) and its `corners` are carried through every re-solve. */
    answer: PolishResult;
    /** override the deviation target every snap is admitted against (m); defaults to the
     *  answer's own floor. Finite and > 0. */
    floor?: number;
}

export interface QuantizeResult {
    /** the quantized answer. `final === opts.answer` by identity when nothing could be
     *  named, so a caller can tell a no-op apart without comparing profiles. */
    final: PolishResult;
    /** segment indices now carrying a named easing, ascending. */
    named: number[];
    /** key indices pinned flat (a named segment's two ends), ascending. */
    flats: number[];
    /** the floor every snap was admitted against (m). */
    floor: number;
    /** λ = 0 candidate probes spent, and the total `polish` solves including the final
     *  calm search's own. Never zero — concluding that nothing can be named costs one probe
     *  per candidate segment — so `final === answer` is the no-op signal, not this. */
    probes: number;
    solves: number;
}

/**
 * quantize a solved force profile onto the named-easing vocabulary: name every segment
 * whose two keys can be pinned to flat tangents with the geometry still inside the
 * authoring floor. Throws on an answer the vocabulary is not defined over (a free-family
 * solve) and on the inputs `polish` throws on.
 *
 * @example
 * const r = refine({ bake, entry, ds: 0.5 });
 * const q = quantize({ bake, entry, ds: 0.5, answer: r.final });
 * // q.final.points: named segments carry no handles; Custom ones keep theirs.
 */
export function quantize(opts: QuantizeOpts): QuantizeResult {
    const { bake, entry, answer } = opts;
    if (answer.handles !== "aligned")
        throw new Error(
            `quantize: a named easing is an aligned-family state, not ${answer.handles}`,
        );
    if (opts.floor !== undefined && (!(opts.floor > 0) || !Number.isFinite(opts.floor)))
        throw new Error(`quantize: floor must be a finite number > 0, got ${opts.floor}`);

    const pts = answer.points;
    const K = pts.length;
    const floor = opts.floor ?? answer.floor;
    const corners: Corners = answer.corners;

    let probes = 0;
    let solves = 0;
    const probe = (flats: ReadonlySet<number>): PolishResult => {
        const r = polish({
            bake,
            entry,
            points: flatten(pts, flats),
            ds: opts.ds,
            mode: "calm",
            handles: "aligned",
            corners,
            lambda: 0,
            floor,
            maxSnapshots: 1,
        });
        probes++;
        solves += r.solves;
        return r;
    };
    const held = (r: PolishResult): boolean => r.converged && r.deviation <= floor;

    // A corner is the OTHER discrete state at a key — a slope broken in two — so a key
    // cannot be both, and a segment touching one is never a naming candidate.
    const corner = new Set(corners);
    const flats = new Set<number>();
    const named = new Set<number>();
    for (;;) {
        // EVERY remaining segment is probed, for `refine`'s reason: probing in some cheap
        // order and taking the first that holds would let the order decide which segment
        // gets named, and with it the state every later candidate is judged against. The
        // ACCEPT is the floor's own reading; choosing among the holders is a declared
        // TIEBREAK — most slack, lowest segment index on an exact tie — since each names
        // exactly one segment and the objective is indifferent between them.
        let best = -1;
        let bestR: PolishResult | null = null;
        for (let k = 0; k + 1 < K; k++) {
            if (named.has(k) || corner.has(k) || corner.has(k + 1)) continue;
            const r = probe(new Set([...flats, k, k + 1]));
            if (held(r) && (bestR === null || r.deviation < bestR.deviation)) {
                best = k;
                bestR = r;
            }
        }
        if (bestR === null) break;
        flats.add(best);
        flats.add(best + 1);
        named.add(best);
    }

    // nothing named: hand the answer back by identity rather than re-solving it. The
    // re-solve would be over the identical DOF set and only add float noise to a settled
    // answer, and callers use the identity as the no-op signal.
    if (named.size === 0) return { final: answer, named: [], flats: [], floor, probes, solves };

    // the answer: one full discrepancy λ-search over the settled vocabulary state. It holds
    // the floor because the accepted probe did — that search keeps only λs verified against
    // the floor and falls back to the λ = 0 solve, which is exactly that probe.
    const final = polish({
        bake,
        entry,
        points: flatten(pts, flats),
        ds: opts.ds,
        mode: "calm",
        handles: "aligned",
        corners,
        floor,
    });
    solves += final.solves;
    return {
        final,
        named: [...named].sort((a, b) => a - b),
        flats: [...flats].sort((a, b) => a - b),
        floor,
        probes,
        solves,
    };
}
