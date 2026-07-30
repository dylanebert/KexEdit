/** The invoked force→geo conversion, as an editor command — the observation-space twin of
 *  `geoforce.ts`.
 *
 * The fit itself is the conversion tier (`geofit.ts`, wrapped async by `geofit-async.ts`'s
 * single-invocation worker — no pool, no probe fan-out, since a fit is one closed-form
 * split-then-prune call, not a multi-probe search); this module is the thin seam that hands it
 * the section's own dense bake and lands the answer back as one undo entry. Nothing here decides
 * anything about the fit.
 *
 * **The document is touched exactly once, at resolution.** The façade is pure — it writes no
 * document state — so a fit that does not finish leaves the track byte-identical, and there is
 * deliberately no rollback path to get wrong. What the once-at-resolution shape does need is that
 * the document still be the one the answer describes, so the invoke is guarded both ways: one fit
 * per section at a time, and a re-read of the authored state before the write.
 *
 * **The input is the bake's own call.** `forceBake(ecs, sectionId)` re-runs `evalForce` with the
 * section's live entry frame, its own authored profile, and the sample budget left at its place
 * in the chain — the same call `BakeSystem`'s `forcePayload` threads through `chain`, so the fit
 * targets exactly the shape on screen, truncation included.
 *
 * **The OUTPUT's sampling is passed in too.** `geofit` scores a candidate on the bake the landed
 * geo section will produce, so it needs the step and the budget that section will bake at: the
 * track nominal (a convert resets `Section.ds` to the sentinel) and the same remaining-buffer
 * budget. Left to the kernel's mirrored defaults the fit would score a sampling the document
 * doesn't use. */

import type { State } from "@dylanebert/shallot";
import { type GeofitOpts, runGeofit } from "./geofit-async";
import type { GeofitOutcome, GeofitResult } from "./geofit";
import { type History, solveGeo } from "./history";
import {
    authoredHash,
    bakeLive,
    forceBake,
    MAX_SAMPLES,
    sectionAt,
    sectionInfo,
    Section,
    SectionKind,
    trackDs,
} from "./track";

/** The document moved while the fit was running, so its answer describes a shape that is no
 *  longer there and is dropped. Named identically to `geoforce.ts`'s own class (by `name`, not
 *  by module — `editor.solveFailed` tells a stale answer apart from a cancel by `e.name`, and
 *  that mapping is direction-neutral: it never imports either conversion tier, so both
 *  directions' stale answers read through the same one check). */
export class StaleConvert extends Error {
    constructor(sectionId: number) {
        super(`convertForce: section ${sectionId} changed during the solve`);
        this.name = "StaleConvert";
    }
}

/** sections with a fit in flight — the reentrancy guard, mirrors `geoforce.ts`'s `converting`.
 *  its own `Set`, not shared with the geo→force direction: a section is always exactly one kind,
 *  so `convertForce` (force-only) and `convertGeo` (geo-only) can never race the same id. */
const converting = new Set<number>();

/** the landing-side density guard, `MAX_FIT_EDGES`'s (`controls.ts`) twin on the OUTPUT: a
 *  `"budget"` fit still resolves and still emits a node chain, but a chain past this size stops
 *  being a document a person hand-edits (drags, tangent-edits, right-clicks node by node) —
 *  authoring scale, not wall time, so it's derived from what this codebase has actually needed to
 *  hand-author, never a wall-clock measurement. `tests/attribution.lab.ts`'s authoring-floor
 *  sweep is that evidence: at its tightest tested resolution (0.05 m half-step) the densest
 *  single scenario in the 10-scenario corpus (valley-explicit) needs 75 force keys to hold its
 *  own floor, and the full corpus combined — every demanding section this codebase has ever
 *  needed, all at once — needs 212. A landed geo node here is the observation-space mirror of one
 *  of those force keys (the same split-then-prune shape as `refine.ts`'s, just the reverse
 *  direction's own kernel, `geofit.ts`'s doc comment), so 212 carries over directly, unrounded:
 *  the densest this codebase has ever actually authored, combined, and still two orders of
 *  magnitude under the thousand-plus chains a stalled split (`round` reaching `edges` inside
 *  `geofit`, up to `MAX_FIT_EDGES` = 2400 input edges) can otherwise produce. */
export const MAX_LANDED_NODES = 212;

/** `convertForce`'s own outcome vocabulary: `geofit.GeofitOutcome` plus `"dense"` — a `"budget"`
 *  answer whose node count exceeds {@link MAX_LANDED_NODES}, caught here (not in `geofit.ts`,
 *  which has no opinion on authoring scale) and resolved the same way `"diverged"` already does:
 *  the answer is returned for the caller to read, but nothing lands. */
export type ConvertForceOutcome = GeofitOutcome | "dense";

/** `GeofitResult` with `convertForce`'s own widened outcome. */
export interface ConvertForceResult extends Omit<GeofitResult, "outcome"> {
    outcome: ConvertForceOutcome;
}

/** Fit a force section into the geo section that reproduces its shape, and land it.
 *
 * Resolves with the fit's answer ({@link ConvertForceResult}) — the emitted nodes are already in
 * the document, and the rest (outcome, deviation, forceError) is the caller's transient readout,
 * never stored. A `"diverged"` answer resolves too, but writes nothing: the caller surfaces it.
 * So does a `"budget"` answer whose node count exceeds {@link MAX_LANDED_NODES} — resolved with
 * its outcome rewritten to `"dense"`, same nothing-lands shape, since the chain the fit would
 * emit is not an authoring surface.
 *
 * Rejects, having written nothing, when: the section is missing, isn't force, or has no live bake
 * (the enablement the invoking surface should already be gating on); a fit is already running on
 * it; the signal aborts (with `signal.reason`); or the document changed during the fit
 * ({@link StaleConvert}).
 *
 * **The caller blocks input for the duration** (the stress trio measured up to 2.03 s off the
 * main thread — `kex2d-forcegeo` stage 2 — past the ~1 s bar for running inline), the same modal
 * contract as `convertGeo`.
 *
 * @example
 * const controller = new AbortController();
 * const result = await convertForce(history, ecs, section, { signal: controller.signal });
 */
export async function convertForce(
    h: History,
    ecs: State,
    sectionId: number,
    opts: GeofitOpts = {},
): Promise<ConvertForceResult> {
    if (converting.has(sectionId))
        throw new Error(`convertForce: section ${sectionId} is already converting`);
    const eid = sectionAt(ecs, sectionId);
    if (eid === null) throw new Error(`convertForce: no section ${sectionId}`);
    if (Section.kind.get(eid) !== SectionKind.Force)
        throw new Error(`convertForce: section ${sectionId} is not force`);
    // the entry frame is bake output, so a bake that isn't the current authored state has no
    // shape to fit against — `sectionInfo` would describe an older one.
    const info = sectionInfo.get(sectionId);
    if (!info || !bakeLive(ecs))
        throw new Error(`convertForce: section ${sectionId} has no live bake`);

    const bake = forceBake(ecs, sectionId);
    const entry = info.entry;
    const authored = authoredHash(ecs);
    converting.add(sectionId);
    try {
        const result = await runGeofit(bake, entry.v, {
            ...opts,
            params: {
                ...opts.params,
                dsNominal: trackDs(ecs),
                maxSamples: MAX_SAMPLES - info.startSample,
            },
        });
        const live = sectionAt(ecs, sectionId);
        if (live === null || Section.kind.get(live) !== SectionKind.Force)
            throw new StaleConvert(sectionId);
        if (authoredHash(ecs) !== authored) throw new StaleConvert(sectionId);
        // a `"budget"` answer past the authoring ceiling is not landable — same nothing-lands
        // shape as `"diverged"`, but its own outcome so the readout tells the two apart.
        const dense = result.outcome !== "diverged" && result.nodes.length > MAX_LANDED_NODES;
        if (result.outcome !== "diverged" && !dense) solveGeo(h, ecs, sectionId, result, entry);
        return dense ? { ...result, outcome: "dense" } : result;
    } finally {
        converting.delete(sectionId);
    }
}
