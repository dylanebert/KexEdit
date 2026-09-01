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
 * **The input is the bake's own call.** `evalGeo(entry, geoNodes, step, budget, friction,
 * resistance)` with the section's live entry frame, the step it bakes at, the sample budget left
 * at its place in the chain, and the track's own authored dissipative coefficients — the same
 * arguments `BakeSystem`'s `geoPayload` threads through `chain`, so the solve targets exactly
 * the shape on screen, truncation included — `friction`/`resistance` thread through here too,
 * so authoring either has the same effect on what a conversion targets as it does on the live bake.
 *
 * **The solve stays distance-internal; so does the store.** The conversion tier works in meters
 * (its goldens are frozen there), and every force keyframe/extent is stored in meters of
 * arclength always (`Track.domain` is a display lens, `domain.ts`) — so the answer lands
 * unconverted. */

import type { State } from "@dylanebert/shallot";
import { convert, type ConvertOpts } from "./convert";
import { type History, restoreProvenance, solveForce } from "./history";
import type { ForcePoint } from "./profile";
import type { ConvertResult, RefineOutcome } from "./refine";
import type { Entry } from "./section";
import { evalGeo } from "./section";
import {
    authoredHash,
    bakeLive,
    consultProvenance,
    geoNodes,
    MAX_SAMPLES,
    Section,
    sectionAt,
    sectionInfo,
    SectionKind,
    trackDs,
    trackFriction,
    trackResistance,
} from "./track";

/** `convertGeo`'s own outcome vocabulary: `refine.RefineOutcome` plus `"restored"`
 *  (kex2d-provenance stage 3) — the section's stamped provenance (its own force→geo fit's
 *  pre-solve payload, `history.solveGeo`) verified exact against the live document, so it
 *  landed VERBATIM instead of running the conversion tier at all. */
export type ConvertGeoOutcome = RefineOutcome | "restored";

/** `ConvertResult` with `convertGeo`'s own widened outcome. */
export interface ConvertGeoResult extends Omit<ConvertResult, "outcome"> {
    outcome: ConvertGeoOutcome;
}

/** the short-circuit itself (kex2d-provenance stage 3), `forcegeo.ts`'s `tryRestore` mirrored the
 *  other direction: `track.consultProvenance` runs the certification core (readProvenance → live
 *  row → a fresh `sectionToken` compare → `entryExact` against the live entry anchor, both
 *  f32-exact) over the pre-fit FORCE payload a force→geo landing (`history.solveGeo`) stamped —
 *  shared with `forcegeo.tryRestore`. A miss returns `undefined` (no restore — the caller falls
 *  through to the conversion tier); a hit lands the stamp's own pre-fit payload verbatim
 *  (`history.restoreProvenance`) and returns the caller's result, so the worker pool
 *  (`convert.ts`) never spawns. */
function tryRestore(
    h: History,
    ecs: State,
    sectionId: number,
    entry: Entry,
): ConvertGeoResult | undefined {
    const payload = consultProvenance(ecs, sectionId, entry);
    if (!payload) return undefined;

    restoreProvenance(h, ecs, sectionId, payload);
    const points: ForcePoint[] = payload.points.map((p) => ({
        s: p.s,
        g: p.g,
        ease: p.ease,
    }));
    return {
        points,
        ds: 0, // no solve ran — nothing here computed a realized step, matching `edges: 0`
        length: payload.length,
        edges: 0,
        keys: points.length,
        knots: [],
        outcome: "restored",
        floor: 0,
        deviation: 0,
        probes: 0,
    };
}

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
 * **Before any of that runs**, an untouched section short-circuits (kex2d-provenance stage 3,
 * {@link tryRestore}): if this section's own reverse fit (`forcegeo.convertForce`) stamped it
 * and nothing the stamp covers has moved since, its exact pre-fit force payload lands verbatim,
 * no worker pool — the outcome reads `"restored"`.
 *
 * Otherwise resolves with the solve's `ConvertResult` — points/length are already in the
 * document, and the rest (outcome, floor, deviation, probes, ds) is the caller's transient
 * readout, never stored. A `"diverged"` answer resolves too, but writes nothing: the caller
 * surfaces it.
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
): Promise<ConvertGeoResult> {
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

    // kex2d-provenance stage 3: the short-circuit. Exactness, not a budget — two comparisons
    // against the section's own stamp (`history.solveGeo`'s landing), so this runs inline before
    // the worker pool spawns, no modal wait. A miss on EITHER falls straight through to the
    // conversion tier below, untouched: the kernel seam never sees provenance.
    const restored = tryRestore(h, ecs, sectionId, info.entry);
    if (restored) return restored;

    const step = trackDs(ecs);
    const authored = authoredHash(ecs);
    converting.add(sectionId);
    try {
        const result = await convert(
            evalGeo(
                info.entry,
                geoNodes(ecs, sectionId),
                step,
                MAX_SAMPLES - info.startSample,
                trackFriction(ecs),
                trackResistance(ecs),
            ),
            info.entry,
            step,
            opts,
        );
        const live = sectionAt(ecs, sectionId);
        if (live === null || Section.kind.get(live) !== SectionKind.Geo)
            throw new StaleConvert(sectionId);
        if (authoredHash(ecs) !== authored) throw new StaleConvert(sectionId);
        if (result.outcome !== "diverged") {
            // the solve is distance-internal and so is the store (`Track.domain` is a display
            // lens, `domain.ts`), so the answer lands as-is.
            solveForce(h, ecs, sectionId, result);
        }
        return result;
    } finally {
        converting.delete(sectionId);
    }
}
