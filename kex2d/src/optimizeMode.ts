/** Optimize mode as an editor command — the seam between `optimize.ts`'s masked-collocation
 *  kernel and the document, mirroring `geoforce.ts`/`forcegeo.ts`'s shape for the two kind
 *  conversions: this module hands the kernel the document's own live state and lands its answer
 *  back as one undo entry. Nothing here decides anything about the solve.
 *
 *  **The mode is continuous history** (the stage-5 rewrite, superseding the stage-4 bracket).
 *  Mode entry is itself an undoable action ({@link enterOptimizeMode} — the entry command carries
 *  the stamp), every in-mode edit is a normal history entry, and a landed `Solve` is a normal
 *  entry that also closes the mode (`history.solveOptimize`'s mode closures). Undo/redo run
 *  through the whole process: undoing past the entry exits the mode, redoing back in re-enters it
 *  with the mode state restored. {@link exitOptimizeMode} (Exit/Esc) is history navigation — it
 *  rewinds to the entry mark and leaves, so the rewound edits stay redoable; nothing is
 *  destroyed. A cancelled or `"diverged"` solve still writes nothing (the façade is pure).
 *
 *  **The target is always the CURRENT draft.** Every `Solve` invocation reads the section's live
 *  keyframes fresh — never the mode-entry snapshot the ghost was taken from — per the locked
 *  decision: in-mode edits are intent, so solving toward mode-entry would fight them. */

import type { State } from "@dylanebert/shallot";
import { beginOptimize, editor, endOptimize, type OptimizeSession } from "./editor";
import { type History, record, solveOptimize as landOptimize, undo } from "./history";
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

// the live mode's entry command — the mark `exitOptimizeMode` rewinds to. one mode at a time,
// so a module variable suffices; identity against the stack tells whether the mark still exists
// (MAX_UNDO can evict it under 256+ in-mode edits, the one degraded case).
let entryCmd: { apply(): void; reverse(): void } | null = null;

/** Enter optimize mode on a force section AS AN UNDOABLE ACTION (continuous history): stamps the
 *  exit + ghost ({@link enterOptimize}), opens the mode, and records the entry — undoing it exits
 *  the mode, redoing it re-enters with the same stamp. Returns false (recording nothing) when the
 *  section isn't a live force section.
 *
 * @example
 * if (enterOptimizeMode(history, ecs, sectionId)) { ... in the mode ... }
 */
export function enterOptimizeMode(h: History, ecs: State, sectionId: number): boolean {
    if (editor.optimizing !== null) return false; // one mode at a time (the row grays too)
    const session = enterOptimize(ecs, sectionId);
    if (!session) return false;
    beginOptimize(session);
    entryCmd = {
        apply: () => beginOptimize(session),
        reverse: () => endOptimize(),
    };
    record(h, entryCmd);
    return true;
}

/** Exit/Esc: rewind history to the mode's entry mark and leave the mode — pure history
 *  navigation, so every rewound step (the entry included) lands on the redo stack and stays
 *  redoable. The loop's sentinel is the mode state itself: undoing the entry command closes the
 *  mode. When the entry mark was evicted (MAX_UNDO under 256+ in-mode edits) a full rewind no
 *  longer exists, so the mode closes in place rather than draining unrelated history. */
export function exitOptimizeMode(h: History, ecs: State): void {
    if (editor.optimizing === null) return;
    const marked = entryCmd !== null && h.undo.some((e) => e.cmd === entryCmd);
    if (marked) {
        while (editor.optimizing !== null && h.undo.length > 0) undo(h, ecs);
    }
    endOptimize(); // a no-op after a marked rewind; the honest close when the mark was evicted
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
 * in the document as one undo entry (`history.solveOptimize`) that ALSO closed the mode — Solve
 * is the confirmation; `"unreachable"`/`"diverged"` resolve too, but write nothing and stay in
 * the mode — the caller surfaces the outcome.
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
            // solve left exactly where it was.
            const writes = ids
                .map((id, k) => ({ id, g: result.points[k].g }))
                .filter((_, k) => result.deltaG[k] !== 0);
            // the landing ALWAYS records — even a zero-drift Solve closes the mode, and that
            // transition must be an entry or undo/redo couldn't reproduce the mode state
            // (continuous history). idempotence holds trivially now: a landed Solve closed the
            // mode, so there is no second press. `relock` restores the lock set when undo walks
            // back INTO the mode through this entry; cloned per enter, since `endOptimize`
            // clears the live set in place.
            const relock = new Set(locked);
            landOptimize(h, ecs, sectionId, writes, {
                enter: () => {
                    beginOptimize(session);
                    editor.locked = new Set(relock);
                },
                exit: () => endOptimize(),
            });
        }
        return result;
    } finally {
        solving.delete(sectionId);
    }
}
