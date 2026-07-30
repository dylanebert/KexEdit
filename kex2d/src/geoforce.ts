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
 * the solve targets exactly the shape on screen, truncation included.
 *
 * **The solve stays distance-internal; the landing converts.** The conversion tier works in
 * meters (its goldens are frozen there), so on a `Time`-domain track the answer passes through
 * `domain.convertSolve` on its way into the document — inside the one landing entry, through the
 * same table the ruler pick converts the whole store through. */

import type { State } from "@dylanebert/shallot";
import { convert, type ConvertOpts } from "./convert";
import { convertSolve } from "./domain";
import { type History, restoreProvenance, solveForce } from "./history";
import type { ForcePoint } from "./profile";
import type { ConvertResult, RefineOutcome } from "./refine";
import type { Entry } from "./section";
import { evalGeo } from "./section";
import {
    authoredHash,
    bakeLive,
    geoNodes,
    MAX_SAMPLES,
    readProvenance,
    Section,
    sectionAt,
    sectionInfo,
    SectionKind,
    sections,
    sectionStep,
    sectionToken,
    trackDomain,
    trackDs,
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

/** the short-circuit itself (kex2d-provenance stage 3), `forcegeo.ts`'s `tryRestore` mirrored
 *  the other direction: a section's stamped provenance (`track.readProvenance`) — here the
 *  pre-fit FORCE payload a force→geo landing (`history.solveGeo`) stamped — certified against
 *  the LIVE document by the same two comparisons (`sectionToken` recomputed fresh over the live
 *  section, and the live entry anchor, both f32-exact). Either miss returns `undefined` (no
 *  restore — the caller falls through to the conversion tier); a hit lands the stamp's own
 *  pre-fit payload verbatim (`history.restoreProvenance`) and returns the caller's result, so the
 *  worker pool (`convert.ts`) never spawns.
 *
 *  **Domain seam**: the payload is a `snapshotSection` taken straight off the live ECS columns
 *  at the force→geo landing, already in whatever unit `Track.domain` was in at that moment — NOT
 *  the conversion tier's distance-internal output that the normal landing passes through
 *  `domain.convertSolve` before it reaches the document. `sectionToken` folds `Track.domain`
 *  into the stamp, so a restore only ever fires with the domain unchanged since the stamp — the
 *  payload's unit and the live store's unit already agree, and running it through
 *  `convertSolve` a second time would convert an already-native value. */
function tryRestore(
    h: History,
    ecs: State,
    sectionId: number,
    entry: Entry,
): ConvertGeoResult | undefined {
    const prov = readProvenance(sectionId);
    if (!prov) return undefined;
    const row = sections(ecs).find((s) => s.id === sectionId);
    if (!row) return undefined;
    const token = sectionToken(ecs, row, trackDomain(ecs));
    if (token !== prov.token) return undefined;
    if (
        entry.x !== prov.entry.x ||
        entry.y !== prov.entry.y ||
        entry.theta !== prov.entry.theta ||
        entry.v !== prov.entry.v
    )
        return undefined;

    restoreProvenance(h, ecs, sectionId, prov.payload);
    const points: ForcePoint[] = prov.payload.points.map((p) => ({
        s: p.s,
        g: p.g,
        ease: p.ease,
        in: p.tangent?.in,
        out: p.tangent?.out,
    }));
    return {
        points,
        ds: prov.payload.ds,
        length: prov.payload.length,
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
 * Otherwise resolves with the solve's `ConvertResult` — points/length/`ds` are already in the
 * document, and the rest (outcome, floor, deviation, probes) is the caller's transient readout,
 * never stored. A `"diverged"` answer resolves too, but writes nothing: the caller surfaces it.
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
        if (result.outcome !== "diverged") {
            // the solve is distance-internal; a Time-domain track stores seconds, so the answer
            // converts through the section's own window on the live table before it lands
            // (`domain.convertSolve` — the same seam the ruler pick applies to the whole store).
            const landed = convertSolve(ecs, sectionId, result);
            // defense in depth, not a live path: the `bakeLive` gate above and the `authoredHash`
            // re-read just now already guarantee the table and this section's window exist, so
            // this branch has never been observed. It stays because the alternative to throwing
            // is landing metres into a seconds store.
            if (!landed) throw new StaleConvert(sectionId);
            solveForce(h, ecs, sectionId, landed);
        }
        return result;
    } finally {
        converting.delete(sectionId);
    }
}
