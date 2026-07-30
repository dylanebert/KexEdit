/** Optimize mode as an editor command — the seam between `optimize.ts`'s masked-collocation
 *  kernel and the document, mirroring `geoforce.ts`/`forcegeo.ts`'s shape for the two kind
 *  conversions: this module hands the kernel the document's own live state and lands its answer
 *  back as one undo entry. Nothing here decides anything about the solve.
 *
 *  **Entering the mode is a read, not a write.** `enterOptimize` stamps the section's CURRENT
 *  exit and freezes a ghost of its CURRENT shape — both live only in `editor.optimizing`
 *  (`editor.beginOptimize`), so entering/exiting the mode never touches history. Only a `Solve`
 *  that lands writes anything, and it writes once, at resolution, exactly like the two conversion
 *  commands: the façade (`optimize-async.ts`) is pure, so a cancelled or `"diverged"` solve leaves
 *  the track byte-identical.
 *
 *  **The target is always the CURRENT draft.** Every `Solve` invocation reads the section's live
 *  keyframes fresh — never the mode-entry snapshot the ghost was taken from — per the locked
 *  decision: in-mode edits are intent, so solving toward mode-entry would fight them. */

import type { State } from "@dylanebert/shallot";
import type { OptimizeSession } from "./editor";
import { type History, solveOptimize as landOptimize } from "./history";
import type { OptimizeOpts, OptimizeResult } from "./optimize";
import { type OptimizeRunOpts, runOptimize } from "./optimize-async";
import { Domain, type Entry, evalForce } from "./section";
import { forceProfile, type ForcePoint } from "./profile";
import {
    authoredHash,
    bakeLive,
    DT_NOMINAL,
    forceEase,
    forceTangent,
    Section,
    sectionAt,
    SectionKind,
    sectionForces,
    sectionInfo,
    sectionStep,
    trackDomain,
    trackDs,
} from "./track";

/** the section's own realized baking parameters — the same reading `BakeSystem`'s `forcePayload`
 *  and `forceBake` derive, so the mode targets exactly what's on screen. */
interface SectionSpec {
    entry: Entry;
    length: number;
    ds: number;
    domain: Domain;
}

function sectionSpec(ecs: State, sectionId: number): SectionSpec | null {
    const eid = sectionAt(ecs, sectionId);
    if (eid === null || Section.kind.get(eid) !== SectionKind.Force) return null;
    const info = sectionInfo.get(sectionId);
    if (!info) return null;
    const domain = trackDomain(ecs);
    const nominal = domain === Domain.Time ? DT_NOMINAL : trackDs(ecs);
    return {
        entry: info.entry,
        length: Section.length.get(eid),
        ds: sectionStep(Section.ds.get(eid), nominal),
        domain,
    };
}

/** the section's authored keyframes as `ForcePoint`s, sorted by `s` (`sectionForces`'s own
 *  order) alongside their stable ids in the same order — the mapping a solve's answer scatters
 *  back onto by index. */
function sectionPoints(ecs: State, sectionId: number): { ids: number[]; points: ForcePoint[] } {
    const rows = sectionForces(ecs, sectionId);
    const ids = rows.map((r) => r.id);
    const points: ForcePoint[] = rows.map((r) => {
        const tan = forceTangent(ecs, r.id);
        return { s: r.s, g: r.g, ease: forceEase(ecs, r.id), in: tan?.in, out: tan?.out };
    });
    return { ids, points };
}

/** enter optimize mode on a force section: stamp its current exit `(x, y, θ)` and freeze a ghost
 *  of its current shape, both computed in the ONE `evalForce` call that also is the exact
 *  production integrator (`section.ts`) — so the stamp a later `Solve` targets is the same
 *  computation its own residual check reads. Returns `null` when the section isn't a live force
 *  section (the invoking surface's enablement should already have gated this).
 *
 * @example
 * const session = enterOptimize(ecs, sectionId);
 * if (session) beginOptimize(session);
 */
export function enterOptimize(ecs: State, sectionId: number): OptimizeSession | null {
    if (!bakeLive(ecs)) return null;
    const spec = sectionSpec(ecs, sectionId);
    if (!spec) return null;
    const { points } = sectionPoints(ecs, sectionId);
    const dense = forceProfile(points, spec.length, spec.ds);
    const r = evalForce(spec.entry, dense, spec.ds, spec.domain);
    // the session carries only the stamp + ghost (both frozen at mode entry); the section's
    // baking parameters are NOT cached here — `runOptimizeSection` re-reads them live off
    // `sectionSpec` at every invoke, same as any other invoked command (`editor.OptimizeSession`).
    return {
        section: sectionId,
        stamp: { x: r.exit.x, y: r.exit.y, theta: r.exit.theta },
        ghost: { x: r.posX, y: r.posY },
    };
}

/** the document moved while the solve was running — mirrors `geoforce.ts`'s own class (`name`,
 *  not `instanceof`, is the tell a caller reads it by, the direction-neutral convention). */
export class StaleOptimize extends Error {
    constructor(sectionId: number) {
        super(`runOptimizeSection: section ${sectionId} changed during the solve`);
        this.name = "StaleOptimize";
    }
}

const solving = new Set<number>();

/** Run the masked-collocation solve on a section's CURRENT draft and land it, off the main
 * thread. Only free (un-locked, by keyframe id) keys' `g` moves; `s`, length, structure, easing,
 * explicit handles, and every locked key's `g` land byte-identical to what was already there —
 * the kernel's own mask (`optimize.ts`), asserted structurally in `tests/optimize.test.ts`.
 *
 * Resolves with `solveOptimize`'s own `OptimizeResult` either way. A `"solved"` answer is already
 * in the document (one undo entry, `history.solveOptimize`); `"unreachable"`/`"diverged"` resolve
 * too, but write nothing — the caller surfaces the outcome.
 *
 * Rejects, having written nothing, when: the section is missing, isn't force, or has no live
 * bake; a solve is already running on it; the signal aborts (with `signal.reason`); or the
 * document changed during the solve ({@link StaleOptimize}).
 *
 * @example
 * const controller = new AbortController();
 * const result = await runOptimizeSection(history, ecs, session, locked, {
 *     signal: controller.signal,
 * });
 */
export async function runOptimizeSection(
    h: History,
    ecs: State,
    session: OptimizeSession,
    locked: ReadonlySet<number>,
    opts: OptimizeRunOpts = {},
): Promise<OptimizeResult> {
    const sectionId = session.section;
    if (solving.has(sectionId))
        throw new Error(`runOptimizeSection: section ${sectionId} is already solving`);
    const spec = sectionSpec(ecs, sectionId);
    if (!spec) throw new Error(`runOptimizeSection: no live force section ${sectionId}`);
    if (!bakeLive(ecs))
        throw new Error(`runOptimizeSection: section ${sectionId} has no live bake`);

    const { ids, points } = sectionPoints(ecs, sectionId);
    // the kernel masks by INDEX into `points` (its own DOF space); the caller locks by stable
    // keyframe id (what persists across the drags/edits between solves) — translate once, here.
    const lockedIdx = new Set<number>();
    ids.forEach((id, k) => {
        if (locked.has(id)) lockedIdx.add(k);
    });

    const kernelOpts: OptimizeOpts = {
        entry: spec.entry,
        points,
        locked: lockedIdx,
        length: spec.length,
        ds: spec.ds,
        domain: spec.domain,
        stamp: session.stamp,
    };

    const authored = authoredHash(ecs);
    solving.add(sectionId);
    try {
        const result = await runOptimize(kernelOpts, opts);
        const live = sectionAt(ecs, sectionId);
        if (live === null || Section.kind.get(live) !== SectionKind.Force)
            throw new StaleOptimize(sectionId);
        if (authoredHash(ecs) !== authored) throw new StaleOptimize(sectionId);
        if (result.outcome === "solved") {
            // `deltaG` is 0 at every locked index BY CONSTRUCTION (the kernel's own mask), so
            // filtering on it alone already excludes them — and also excludes a free key the
            // solve left exactly where it was. An invoked solve is idempotent (`editor-ui.md`'s
            // constraint-solver law): the zero-drift short-circuit means a second press on an
            // already-restored draft has NOTHING to write, so it must not land a no-op undo entry.
            const writes = ids
                .map((id, k) => ({ id, g: result.points[k].g }))
                .filter((_, k) => result.deltaG[k] !== 0);
            if (writes.length > 0) landOptimize(h, ecs, sectionId, writes);
        }
        return result;
    } finally {
        solving.delete(sectionId);
    }
}
