/** The invoked geo→force conversion, as an editor command.
 *
 * The solve itself is the conversion tier (`convert.ts` → a worker pool over `refine`'s
 * probes); this module is the thin seam that hands it the document's own state and lands its
 * answer back as one undo entry. Nothing here decides anything about the conversion.
 *
 * **The document is touched exactly once, at resolution.** The façade is pure — it writes no
 * document state — so a conversion that does not finish leaves the track byte-identical, and
 * there is deliberately no rollback path to get wrong. What the once-at-resolution shape does
 * need is that the document still be the one the answer describes, so the invoke is guarded
 * both ways: one conversion per section at a time, and a re-read of the authored state before
 * the write.
 *
 * **The input is the bake's own call.** `evalGeo(entry, geoNodes, step, budget)` with the
 * section's live entry frame, the step it bakes at, and the sample budget left at its place in
 * the chain — the same four arguments `BakeSystem`'s `geoPayload` threads through `chain`, so
 * the solve targets exactly the shape on screen, truncation included. */

import type { State } from "@dylanebert/shallot";
import { convert, type ConvertOpts } from "./convert";
import { type History, solveForce } from "./history";
import type { ConvertResult } from "./refine";
import { evalGeo } from "./section";
import {
    authoredHash,
    bakeLive,
    geoNodes,
    MAX_SAMPLES,
    Section,
    sectionAt,
    sectionInfo,
    SectionKind,
    sectionStep,
    trackDs,
} from "./track";

/** The document moved while the solve was running, so its answer describes a shape that is no
 *  longer there and is dropped. Its own type because a caller distinguishes it from a cancel
 *  (`signal.reason`) and from the guard errors: nothing went wrong, the answer just expired. */
export class StaleConvert extends Error {
    constructor(sectionId: number) {
        super(`convertGeo: section ${sectionId} changed during the solve`);
        this.name = "StaleConvert";
    }
}

/** Sections with a conversion in flight. A second solve landing on the same section would
 *  snapshot the first one's output as its own "before", so undo would walk back to a solve
 *  rather than to the authored geo shape. */
const converting = new Set<number>();

/** Solve a geo section into the force section that reproduces its shape, and land it.
 *
 * Resolves with the solve's `ConvertResult` — points/length/`ds` are already in the document,
 * and the rest (outcome, floor, deviation, probes) is the caller's transient readout, never
 * stored. A `"diverged"` answer resolves too, but writes nothing: the caller surfaces it.
 *
 * Rejects, having written nothing, when: the section is missing, isn't geo, or has no live bake
 * (the enablement the invoking surface should already be gating on); a conversion is already
 * running on it; the signal aborts (with `signal.reason`); or the document changed during the
 * solve ({@link StaleConvert}).
 *
 * **The caller blocks input for the duration.** The solve is seconds long and its answer is
 * only valid against the shape it was handed, so the invoking surface is modal — the guards
 * here are the backstop for whatever gets through anyway, not a license to author underneath
 * a running solve.
 *
 * @example
 * const controller = new AbortController();
 * const result = await convertGeo(history, ecs, section, {
 *     signal: controller.signal,
 *     onProgress: ({ phase, probes }) => status(`${phase} · ${probes}`),
 * });
 */
export async function convertGeo(
    h: History,
    ecs: State,
    sectionId: number,
    opts: ConvertOpts = {},
): Promise<ConvertResult> {
    if (converting.has(sectionId))
        throw new Error(`convertGeo: section ${sectionId} is already converting`);
    const eid = sectionAt(ecs, sectionId);
    if (eid === null) throw new Error(`convertGeo: no section ${sectionId}`);
    if (Section.kind.get(eid) !== SectionKind.Geo)
        throw new Error(`convertGeo: section ${sectionId} is not geo`);
    // the entry frame and the sample budget are bake output, so a bake that isn't the current
    // authored state has no shape to solve against — `sectionInfo` would describe an older one.
    const info = sectionInfo.get(sectionId);
    if (!info || !bakeLive(ecs))
        throw new Error(`convertGeo: section ${sectionId} has no live bake`);

    const step = sectionStep(Section.ds.get(eid), trackDs(ecs));
    const authored = authoredHash(ecs);
    converting.add(sectionId);
    try {
        const result = await convert(
            evalGeo(info.entry, geoNodes(ecs, sectionId), step, MAX_SAMPLES - info.startSample),
            info.entry,
            step,
            opts,
        );
        const live = sectionAt(ecs, sectionId);
        if (live === null || Section.kind.get(live) !== SectionKind.Geo)
            throw new StaleConvert(sectionId);
        if (authoredHash(ecs) !== authored) throw new StaleConvert(sectionId);
        if (result.outcome !== "diverged") solveForce(h, ecs, sectionId, result);
        return result;
    } finally {
        converting.delete(sectionId);
    }
}
