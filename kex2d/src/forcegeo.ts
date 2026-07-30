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
import type { GeofitNode, GeofitOutcome, GeofitResult } from "./geofit";
import { type History, restoreProvenance, solveGeo } from "./history";
import type { Entry } from "./section";
import { place } from "./section";
import {
    authoredHash,
    bakeLive,
    forceBake,
    MAX_SAMPLES,
    readProvenance,
    sectionAt,
    sectionInfo,
    sectionToken,
    Section,
    SectionKind,
    sections,
    trackDomain,
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
 *  the answer is returned for the caller to read, but nothing lands — and `"restored"`
 *  (kex2d-provenance stage 2): the section's stamped provenance verified exact against the live
 *  document, so its pre-solve payload landed VERBATIM instead of running the fit at all. */
export type ConvertForceOutcome = GeofitOutcome | "dense" | "restored";

/** `GeofitResult` with `convertForce`'s own widened outcome. */
export interface ConvertForceResult extends Omit<GeofitResult, "outcome"> {
    outcome: ConvertForceOutcome;
}

/** the short-circuit itself (kex2d-provenance stage 2): a section's stamped provenance
 *  (`track.readProvenance`), certified against the LIVE document by two comparisons —
 *  `sectionToken` recomputed fresh over the live section (kind + length + ds + rows + domain,
 *  the same reading the stamp took) and the live entry anchor (`sectionInfo.entry`), both
 *  f32-exact. Either miss returns `undefined` (no restore — the caller falls through to the fit);
 *  a hit lands the stamp's own pre-solve payload verbatim (`history.restoreProvenance`) and
 *  returns the caller's result, so nothing downstream in `convertForce` ever runs. The returned
 *  `nodes` are the landed payload's own poses, placed into world space through the same `entry`
 *  the restore just re-confirmed — a readout (`fitDone`) reads `nodes.length`, never the fit's
 *  own `GeofitResult` shape, since none ran. */
function tryRestore(
    h: History,
    ecs: State,
    sectionId: number,
    entry: Entry,
): ConvertForceResult | undefined {
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
    const nodes: GeofitNode[] = prov.payload.nodes.map((n) =>
        place(entry, { x: n.x, y: n.y, theta: n.theta }),
    );
    return {
        nodes,
        deviation: 0,
        forceError: 0,
        outcome: "restored",
        geoBudget: 0,
        forceBudget: 0,
    };
}

/** Fit a force section into the geo section that reproduces its shape, and land it.
 *
 * **Before any of that runs**, an untouched section short-circuits (kex2d-provenance stage 2,
 * {@link tryRestore}): if this section's own forward solve stamped it and nothing the stamp
 * covers has moved since, its exact pre-solve payload lands verbatim, no worker, no fit — the
 * outcome reads `"restored"`.
 *
 * Otherwise resolves with the fit's answer ({@link ConvertForceResult}) — the emitted nodes are
 * already in the document, and the rest (outcome, deviation, forceError) is the caller's
 * transient readout, never stored. A `"diverged"` answer resolves too, but writes nothing: the
 * caller surfaces it. So does a `"budget"` answer whose node count exceeds
 * {@link MAX_LANDED_NODES} — resolved with its outcome rewritten to `"dense"`, same nothing-lands
 * shape, since the chain the fit would emit is not an authoring surface.
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

    // kex2d-provenance stage 2: the short-circuit. Exactness, not a budget — two comparisons
    // against the section's own stamp (`history.solveForce`'s landing), so this runs inline
    // before the worker spawns, no modal wait. A miss on EITHER falls straight through to the
    // fit below, untouched: the kernel/fit seam never sees provenance.
    const restored = tryRestore(h, ecs, sectionId, info.entry);
    if (restored) return restored;

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
