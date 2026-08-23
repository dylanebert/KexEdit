/** Pin mode as an editor command — the seam between `optimize.ts`'s masked exit-restore
 *  kernel and the document, mirroring `geoforce.ts`/`forcegeo.ts`'s shape for the two kind
 *  conversions: this module hands the kernel the document's own live state and lands its answer
 *  back as one undo entry. Nothing here decides anything about the solve.
 *
 *  **The mode is a SANDBOX** (feel iteration 3, superseding both the stage-4 bracket and the
 *  stage-5 continuous-history walk). The pin state is temporary: every in-mode recording
 *  lands in the mode's own sandbox history (`editor.sandbox()`, wired structurally through
 *  `history.redirectHistory`), so nothing applies to the outer stacks until Solve. In-mode
 *  undo/redo ({@link undoRouted}/{@link redoRouted}) operate over the sandbox only — pre-mode
 *  history is unreachable from inside, and undo at the sandbox's start EXITS the mode (acts as
 *  Exit). {@link exitPinMode} (Exit/Esc) reverts the sandbox and discards it — no trace in
 *  outer history, redo branch included. A landed Solve is ONE outer entry that carries the
 *  sandbox frozen at solve time: undoing it reopens the mode with the experiment resumed (draft,
 *  locks, and in-mode undo/redo all restored), redoing it re-lands and closes. A cancelled or
 *  `"diverged"` solve still writes nothing (the façade is pure).
 *
 *  **The target is always the CURRENT draft.** Every `Solve` invocation reads the section's live
 *  keyframes fresh — never the mode-entry snapshot the ghost was taken from — per the locked
 *  decision: in-mode edits are intent, so solving toward mode-entry would fight them. */

import type { State } from "@dylanebert/shallot";
import {
    beginPin,
    editor,
    endPin,
    type PinSession,
    restoreSandbox,
    sandbox,
    skipLanding,
} from "./editor";
import {
    type History,
    markResumedLanding,
    redo,
    resumedLanding,
    solvePin as landPin,
    undo,
} from "./history";
import type { OptimizeOpts, OptimizeResult } from "./optimize";
import { type OptimizeRunOpts, runOptimize } from "./optimize-async";
import { type Entry, evalForce } from "./section";
import { forceProfile, type ForcePoint, resolveStep, type Step } from "./profile";
import {
    authoredHash,
    bakeLive,
    forceEase,
    forceTangent,
    Section,
    sectionAt,
    SectionKind,
    sectionForces,
    sectionInfo,
    stripsForStep,
    trackDs,
    trackFriction,
    trackResistance,
} from "./track";

/** the section's own realized baking parameters — the same reading `BakeSystem`'s `forcePayload`
 *  and `forceBake` derive, so the mode targets exactly what's on screen. `friction`/`resistance`
 *  are the track's own authored coefficients (threaded into `enterPin`'s stamp): the stamp/ghost and
 *  every solve must run the SAME dissipation the live document bakes with, or the stamp disagrees
 *  with what's on screen the moment either coefficient is nonzero (the substrate's own residue
 *  class, the additive-substrate law, `kex2d-map.md`). */
interface SectionSpec {
    entry: Entry;
    length: number;
    step: Step;
    friction: number;
    resistance: number;
}

function sectionSpec(ecs: State, sectionId: number): SectionSpec | null {
    const eid = sectionAt(ecs, sectionId);
    if (eid === null || Section.kind.get(eid) !== SectionKind.Force) return null;
    const info = sectionInfo.get(sectionId);
    if (!info) return null;
    const length = Section.length.get(eid);
    // the pairing seam: conform once here so every downstream use of this spec's `step`
    // (this module's own `forceProfile`/`evalForce` call below, and `optimize.ts`'s kernel,
    // which reads `spec.step.ds` through `OptimizeOpts`) marches at the same exact step the
    // mode stamps its exit at.
    const step = resolveStep(length, trackDs(ecs));
    return {
        entry: info.entry,
        length,
        step,
        friction: trackFriction(ecs),
        resistance: trackResistance(ecs),
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

/** enter pin mode on a force section: stamp its current exit `(x, y, θ)` and freeze a ghost
 *  of its current shape, both computed in the ONE `evalForce` call that also is the exact
 *  production integrator (`section.ts`) — so the stamp a later `Solve` targets is the same
 *  computation its own residual check reads. Returns `null` when the section isn't a live force
 *  section (the invoking surface's enablement should already have gated this).
 *
 * @example
 * const session = enterPin(ecs, sectionId);
 * if (session) beginPin(session);
 */
export function enterPin(ecs: State, sectionId: number): PinSession | null {
    if (!bakeLive(ecs)) return null;
    const spec = sectionSpec(ecs, sectionId);
    if (!spec) return null;
    const { points } = sectionPoints(ecs, sectionId);
    const dense = forceProfile(points, spec.step);
    // strips resolve through `stripsForStep` — a PURE function of the section's own stored
    // {start, end, value} rows and the already-resolved `spec.step` (itself derived from
    // authored `Section.length`/`Track.ds`, never a bake read): the pin invariant's own
    // structural requirement, "no bake-read anywhere in the override construction path".
    const strips = stripsForStep(ecs, sectionId, spec.step);
    const r = evalForce(spec.entry, dense, spec.step, spec.friction, spec.resistance, strips);
    // the session carries only the stamp + ghost + the downstream freeze seed (all frozen at
    // mode entry); the section's baking parameters are NOT cached here — `runPinSection`
    // re-reads them live off `sectionSpec` at every invoke, same as any other invoked command
    // (`editor.PinSession`).
    return {
        section: sectionId,
        stamp: { x: r.exit.x, y: r.exit.y, theta: r.exit.theta, v: r.exit.v },
        ghost: { x: r.posX, y: r.posY },
        freeze: { x: r.exit.x, y: r.exit.y, theta: r.exit.theta, v: r.exit.v },
    };
}

/** Enter pin mode on a force section: stamps the exit + ghost + freeze seed
 *  ({@link enterPin}) and opens the mode — which opens the SANDBOX (`editor.beginPin`:
 *  a fresh in-mode history, the record redirect, the downstream freeze). Entering touches the
 *  outer history not at all: the pin state is temporary until Solve lands. Returns false
 *  when the section isn't a live force section (or a mode is already open).
 *
 * @example
 * if (enterPinMode(ecs, sectionId)) { ... in the mode ... }
 */
export function enterPinMode(ecs: State, sectionId: number): boolean {
    if (editor.pinning !== null) return false; // one mode at a time (the row grays too)
    const session = enterPin(ecs, sectionId);
    if (!session) return false;
    beginPin(session);
    return true;
}

/** Exit/Esc: DISCARD the sandbox — revert every in-mode edit (each entry's own reverse is a
 *  snapshot restore) and close the mode, leaving no trace in the outer history: outer undo AND
 *  redo are byte-identical to before entry. Nothing is destroyed that was ever committed —
 *  everything discarded was sandbox state. */
export function exitPinMode(ecs: State): void {
    if (editor.pinning === null) return;
    skipLanding(); // never leave a landing easing toward values the discard erases
    const sb = sandbox();
    if (sb) while (sb.undo.length > 0) undo(sb, ecs);
    endPin();
}

/** the editor-level undo: routed to the SANDBOX while an pin mode is open (in-mode undo
 *  operates over in-mode edits only — pre-mode history is unreachable from inside), where an
 *  undo at the sandbox's start EXITS the mode (acts as Exit — the sandbox contract); the outer
 *  history otherwise. */
export function undoRouted(h: History, ecs: State): void {
    const sb = sandbox();
    if (sb !== null) {
        if (sb.undo.length === 0) exitPinMode(ecs);
        else undo(sb, ecs);
        return;
    }
    undo(h, ecs);
}

/** the editor-level redo, `undoRouted`'s twin: the sandbox while a mode is open — with ONE
 *  fall-through: in a session RESUMED by undoing a landed Solve, a redo at the sandbox's end
 *  pops the outer redo instead, which IS that landing — it re-lands and closes (the sandbox
 *  contract's "redo re-lands"). the fall-through exists only while `resumedLanding` holds (a
 *  new in-mode edit forks and clears it), so pre-mode redo stays unreachable from inside a
 *  fresh session. */
export function redoRouted(h: History, ecs: State): void {
    const sb = sandbox();
    if (sb !== null) {
        if (sb.redo.length === 0 && resumedLanding() && h.redo.length > 0) redo(h, ecs);
        else redo(sb, ecs);
        return;
    }
    redo(h, ecs);
}

/** the document moved while the solve was running — mirrors `geoforce.ts`'s own class (`name`,
 *  not `instanceof`, is the tell a caller reads it by, the direction-neutral convention). */
export class StalePin extends Error {
    constructor(sectionId: number) {
        super(`runPinSection: section ${sectionId} changed during the solve`);
        this.name = "StalePin";
    }
}

const solving = new Set<number>();

/** Run the masked exit-restore solve on a section's CURRENT draft and land it, off the main
 * thread. Only free (un-locked, by keyframe id) keys' `g` moves; `s`, length, structure, easing,
 * explicit handles, and every locked key's `g` land byte-identical to what was already there —
 * the kernel's own mask (`optimize.ts`), asserted structurally in `tests/optimize.test.ts`.
 *
 * Resolves with `solveOptimize`'s own `OptimizeResult` either way. A `"solved"` answer is already
 * in the document as one undo entry (`history.solvePin`) that ALSO closed the mode — Solve
 * is the confirmation; `"unreachable"`/`"diverged"` resolve too, but write nothing and stay in
 * the mode — the caller surfaces the outcome.
 *
 * Rejects, having written nothing, when: the section is missing, isn't force, or has no live
 * bake; a solve is already running on it; the signal aborts (with `signal.reason`); or the
 * document changed during the solve ({@link StalePin}).
 *
 * @example
 * const controller = new AbortController();
 * const result = await runPinSection(history, ecs, session, locked, {
 *     signal: controller.signal,
 * });
 */
export async function runPinSection(
    h: History,
    ecs: State,
    session: PinSession,
    locked: ReadonlySet<number>,
    opts: OptimizeRunOpts = {},
): Promise<OptimizeResult> {
    const sectionId = session.section;
    if (solving.has(sectionId))
        throw new Error(`runPinSection: section ${sectionId} is already solving`);
    const spec = sectionSpec(ecs, sectionId);
    if (!spec) throw new Error(`runPinSection: no live force section ${sectionId}`);
    if (!bakeLive(ecs)) throw new Error(`runPinSection: section ${sectionId} has no live bake`);

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
        ds: spec.step.ds,
        stamp: session.stamp,
        friction: spec.friction,
        resistance: spec.resistance,
    };

    const authored = authoredHash(ecs);
    // the lock ledger, frozen AT INVOKE (review finding B): `locked` is by-reference (the live
    // `editor.locked`), and `endPin` clears that Set IN PLACE — a capture after the await
    // would read whatever a mid-flight close (or any other in-place mutation) left behind.
    const relock = new Set(locked);
    solving.add(sectionId);
    try {
        const result = await runOptimize(kernelOpts, opts);
        // the mode may have closed — or closed and REOPENED as a new session — while the solve
        // was in flight (review finding A): the sandbox contract's no-trace guarantee is a
        // MODULE invariant, so a result may only land while the very session that invoked it is
        // still the open one. `authoredHash` below can't catch this (Exit restores the draft
        // byte-identically, so the hash matches); session identity is the check.
        if (editor.pinning !== session) throw new StalePin(sectionId);
        const live = sectionAt(ecs, sectionId);
        if (live === null || Section.kind.get(live) !== SectionKind.Force)
            throw new StalePin(sectionId);
        if (authoredHash(ecs) !== authored) throw new StalePin(sectionId);
        if (result.outcome === "solved") {
            // `deltaG` is 0 at every locked index BY CONSTRUCTION (the kernel's own mask), so
            // filtering on it alone already excludes them — and also excludes a free key the
            // solve left exactly where it was.
            const writes = ids
                .map((id, k) => ({ id, g: result.points[k].g }))
                .filter((_, k) => result.deltaG[k] !== 0);
            // the landing ALWAYS records — even a zero-drift Solve closes the mode, and that
            // transition must be an entry or undo/redo couldn't reproduce the mode state.
            // idempotence holds trivially: a landed Solve closed the mode, so there is no second
            // press. the entry carries the whole EXPERIMENT frozen at solve time (the sandbox
            // contract): `relock` the lock set, `frozenU`/`frozenR` the sandbox stacks — undoing
            // the landing reopens the mode with the experiment resumed (draft, locks, in-mode
            // undo/redo all intact), redoing it re-lands and closes. cloned at capture AND at
            // restore (`restoreSandbox` copies), so repeated undo/redo cycles and further edits
            // in a reopened session can never mutate the entry's frozen state. `relock` was
            // frozen at invoke, above (finding B).
            const sb = sandbox();
            const frozenU = sb ? [...sb.undo] : [];
            const frozenR = sb ? [...sb.redo] : [];
            landPin(h, ecs, sectionId, writes, {
                enter: () => {
                    beginPin(session);
                    editor.locked = new Set(relock);
                    restoreSandbox(frozenU, frozenR);
                    markResumedLanding(); // redo at the resumed sandbox's end re-lands (contract)
                },
                exit: () => endPin(),
            });
        }
        return result;
    } finally {
        solving.delete(sectionId);
    }
}
