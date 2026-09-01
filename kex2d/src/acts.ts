import type { State } from "@dylanebert/shallot";
import {
    closeContext,
    editor,
    enterTangentEdit,
    exitTangentEdit,
    type PinSession,
    select,
    selectForce,
    selectOneShot,
    selectSection,
    selectStrip,
    selectStripKf,
    skipLanding,
    toggleLockedSet,
} from "./editor";
import {
    beginMove,
    commit,
    deleteForces,
    deleteMembers,
    extendTrack,
    history,
    removeSection,
    removeSections,
    resetNodes,
    resetNodesBulk,
    resetSection,
    setTangentModes,
    trimSuffix,
    trimTrack,
} from "./history";
import type { KeyframeMenuActions, NodeMenuActions, SectionMenuActions } from "./menus";
import { exitPinMode } from "./pin";
import { alignTangent, mirrorTangent, TangentMode } from "./spline";
import { stitchNode } from "./tangents";
import {
    deleteSection as deleteSectionTrack,
    destroyForce,
    sectionAt,
    destroyOneShot,
    destroyStrip,
    destroyStripKeyframe,
    entryOneShot,
    Force,
    forceAt,
    Handle,
    handleTangent,
    lastHandle,
    removeTrailingHandle,
    sectionForces,
    sectionHandles,
    sectionSpans,
    seedTangent,
    sections,
    setTangent,
    owningStrips,
    Strip,
    stripAt,
    StripKeyframe,
    stripKeyframeAt,
    toLocal,
    trackEntity,
} from "./track";

/**
 * The third member of the menu triple (`menus.ts` rows / `keys.ts` names / this module's bodies) —
 * the ONE impure one. `menus.ts` builds rows from a state descriptor, `keys.ts` decides an act name
 * from a key; this builds the bodies those names address: ECS + `history` + `editor` writes. It
 * deliberately never enters `menus.ts`'s module-graph purity walk (`tests/menu.test.ts`), and it
 * never imports `controls.ts` — `controls.ts` imports these factories back for its own drag guards,
 * never the reverse.
 *
 * A factory returns only chrome-free document acts (`editor-ui.md`'s onion line): an act that
 * mutates the document or the editor singleton lives here; an act that opens a modal, drives a
 * worker façade, or reads a component-local `$derived` stays in its `.svelte` home.
 */

/** the consent boundary's one predicate: whether the section-structure surface — Delete on a
 *  whole-section selection, either Convert direction on ANY section, and the ruler's domain
 *  switch — may run right now. False while ANY pin session is open (`editor.pinning`), not
 *  just on the session's own section: convert/delete aren't available inside the mode (the
 *  locked decision's consent-boundary law).
 *  Deleting the session's own section would strand
 *  `editor.pinning` on a dead id; a convert would land a track rewrite INSIDE the open
 *  session — an upstream convert silently rebases what the stamp means. The domain switch
 *  stays behind the same gate as mode hygiene even though a flip is a pure view write now
 *  (arclength canonical, `Track.domain` a lens): the bar is on churn inside the mode, not on
 *  data loss. */
export function sectionOpsAllowed(pinning: PinSession | null): boolean {
    return pinning === null;
}

/** the editing lockdown's per-subject predicate (kex2d-optimize-mode stage 5): while a pin
 *  session is open, ONLY the pinning section is editable — every edit surface addressing any
 *  other section (geo nodes, other force sections' keys/extents) grays its affordance and
 *  guards its action on this. `sectionOpsAllowed` (above) stays the stricter structural gate:
 *  add/remove/convert/domain are barred even on the pinning section. `section` is the
 *  subject's own section id; the -1 track-global convention retired with the track-global v0 field (entry
 *  speed is a section-0 strip now, an ordinary per-section subject). */
export function sectionEditable(pinning: PinSession | null, section: number): boolean {
    return pinning === null || pinning.section === section;
}

/** whether a selected node set is a Delete-able **suffix run** — a contiguous suffix of ONE section's
 *  chain, excluding node 0, that leaves ≥ 2 nodes (the enablement the user named: end-of-geo yes,
 *  intermediate no). `members` are the selected nodes' (section, order); `count(section)` yields that
 *  section's node count. returns the section and the number of trailing nodes to trim (`k`), or null
 *  when the set spans two sections, has a gap, includes node 0, or would leave < 2 nodes. pure —
 *  device-free, unit-tested. the size-1 case is a single tip (today's trim). */
export function suffixRun(
    members: readonly { section: number; order: number }[],
    count: (section: number) => number,
): { section: number; k: number } | null {
    if (members.length === 0) return null;
    const section = members[0].section;
    for (const m of members) if (m.section !== section) return null; // spans two sections
    const orders = [...new Set(members.map((m) => m.order))].sort((a, b) => a - b);
    if (orders.length !== members.length) return null; // a duplicate order (never expected)
    if (orders[0] === 0) return null; // excludes node 0 (the entry anchor)
    const k = orders.length;
    const n = count(section);
    if (orders[k - 1] !== n - 1) return null; // must reach the chain tip (a suffix, not interior)
    for (let i = 1; i < k; i++) if (orders[i] !== orders[i - 1] + 1) return null; // contiguous
    if (n - k < 2) return null; // a section keeps ≥ 2 nodes
    return { section, k };
}

/** the selected node set as stable (section, order) members — the suffix-run enablement + the bulk
 *  tangent ops read this (a raw eid can't cross a snapshot restore). */
export function nodeMembers(ecs: State): { section: number; order: number }[] {
    const out: { section: number; order: number }[] = [];
    for (const eid of editor.nodes.ids)
        if (ecs.has(eid, Handle))
            out.push({ section: Handle.section.get(eid), order: Handle.order.get(eid) });
    return out;
}

/** whether EVERY selected force keyframe's section is editable under the live lockdown — the
 *  action-layer guard the Del key and the menu's bulk rows share (all-or-nothing: bulk ops act
 *  on the whole set, so a mixed set grays rather than acting on a silent subset). re-derives each
 *  id's section from the ECS (`forceAt`/`Force.section`), so the guard is testable and the same
 *  one every force path reads — never a component-local `$derived`. */
export function forceSetEditable(ecs: State): boolean {
    for (const id of editor.forces.ids) {
        const eid = forceAt(ecs, id);
        if (eid === null) return false;
        if (!sectionEditable(editor.pinning, Force.section.get(eid))) return false;
    }
    return true;
}

/** the strip/oneShot edit-lockdown gate, re-derived from the ECS rather than a component-local
 *  `$derived` (`Timeline.svelte`'s own `stripEditableAt` closes over `spans`; this is the shared
 *  twin `mixedSetDelete` reads). resolves station `d` to its section via `toLocal`/`sectionSpans`
 *  and checks `sectionEditable` — the same consent-boundary reading a force keyframe's own
 *  `.section` gives. */
export function stripEditableAtEcs(ecs: State, d: number): boolean {
    const trackEid = trackEntity(ecs);
    const spanTable = trackEid !== null ? sectionSpans(ecs, trackEid) : [];
    const loc = toLocal(spanTable, d);
    return loc === null || sectionEditable(editor.pinning, loc.section);
}

/** the general mixed-set Delete (S3 repair): one Delete over a mixed set removes, in ONE history
 *  entry, every selected member whose own kind's structural guard permits removal. A kind whose
 *  guard refuses is left selected and alive and does not block the other kinds' removal — one
 *  undo restores everything the gesture removed. Iterates over the member set by kind, checking
 *  each kind's existing guard (`forceSetEditable`, `suffixRun`, `sectionOpsAllowed`,
 *  `stripEditableAtEcs`), and composes the destruction into one `deleteMembers` call — not a
 *  pairwise switch. The whole-track `snapshotAll`/`restoreAll` capture (`history.deleteMembers`)
 *  is what makes the composition safe: per-kind captures overlap (`snapshotSection` includes
 *  forces, `snapshotAll` includes everything), so a whole-track snapshot is the one capture that
 *  composes without duplicating on restore. */
export function mixedSetDelete(ecs: State): boolean {
    const ops: (() => void)[] = [];
    let delForce = false;
    let delStripKf = false;
    let delNode = false;
    let delSection = false;
    let delStrip = false;
    let delOneShot = false;

    // force keyframes — guard: forceSetEditable (all-or-nothing on the pin lockdown)
    if (editor.forces.ids.size > 0 && forceSetEditable(ecs)) {
        for (const id of editor.forces.ids)
            if (forceAt(ecs, id) !== null) ops.push(() => destroyForce(ecs, id));
        delForce = true;
    }

    // strip keyframes — guard: each member's owning strip is editable
    if (editor.stripKfs.ids.size > 0) {
        let allEditable = true;
        for (const id of editor.stripKfs.ids) {
            const kfEid = stripKeyframeAt(ecs, id);
            if (kfEid === null) continue;
            const sId = StripKeyframe.strip.get(kfEid);
            const sEid = stripAt(ecs, sId);
            if (sEid === null || !stripEditableAtEcs(ecs, Strip.start.get(sEid))) {
                allEditable = false;
                break;
            }
        }
        if (allEditable) {
            for (const id of editor.stripKfs.ids)
                if (stripKeyframeAt(ecs, id) !== null)
                    ops.push(() => destroyStripKeyframe(ecs, id));
            delStripKf = true;
        }
    }

    // nodes — guard: suffixRun (a valid contiguous suffix, excluding node 0, leaving >= 2)
    //   plus sectionEditable (the pin lockdown on the suffix's section)
    if (editor.nodes.ids.size > 0) {
        const run = suffixRun(nodeMembers(ecs), (sec) => sectionHandles(ecs, sec).length);
        if (run !== null && sectionEditable(editor.pinning, run.section)) {
            for (let i = 0; i < run.k; i++) ops.push(() => removeTrailingHandle(ecs, run.section));
            delNode = true;
        }
    }

    // sections — guard: sectionOpsAllowed (no pin session) plus the last-section floor
    //   (the set is smaller than the total section count — one must survive)
    if (editor.sections.ids.size > 0 && sectionOpsAllowed(editor.pinning)) {
        const total = sections(ecs).length;
        if (editor.sections.ids.size < total) {
            for (const id of editor.sections.ids)
                if (sectionAt(ecs, id) !== null) ops.push(() => deleteSectionTrack(ecs, id));
            delSection = true;
        }
    }

    // strips — guard: each strip's station is editable. SKIP a strip only when it is the
    //   OWNER of a selected strip keyframe (the containment edge: stripKfs non-empty ⇒
    //   strip non-empty, so deleting the owning strip would break the invariant and destroy
    //   non-selected keyframes on it). A non-owning strip co-selected by shift-click on the
    //   band is a sibling, not an ancestor — it deletes. The sweep law's ancestor-keep
    //   applies to Delete the same way it applies to replace-select.
    if (editor.strips.ids.size > 0) {
        // resolve the set of strip ids that own a selected strip keyframe through
        // `owningStrips`/track.ts, so Delete can distinguish ancestors from siblings
        const owners = owningStrips(ecs, editor.stripKfs.ids);
        const deletable = [...editor.strips.ids].filter((id) => !owners.has(id));
        if (deletable.length > 0) {
            let allEditable = true;
            for (const id of deletable) {
                const sEid = stripAt(ecs, id);
                if (sEid === null || !stripEditableAtEcs(ecs, Strip.start.get(sEid))) {
                    allEditable = false;
                    break;
                }
            }
            if (allEditable) {
                for (const id of deletable)
                    if (stripAt(ecs, id) !== null) ops.push(() => destroyStrip(ecs, id));
                delStrip = true;
            }
        }
    }

    // oneShot — guard: stripEditableAtEcs(0) (the track-start station)
    if (editor.oneShot && stripEditableAtEcs(ecs, 0)) {
        const os = entryOneShot(ecs);
        if (os) {
            ops.push(() => destroyOneShot(ecs, os.id));
            delOneShot = true;
        }
    }

    if (ops.length === 0) return false;

    skipLanding();
    deleteMembers(history, ecs, ops);

    if (delForce) selectForce(null);
    if (delStripKf) selectStripKf(null);
    if (delNode) select(null);
    if (delSection) selectSection(null);
    if (delStrip) selectStrip(null);
    if (delOneShot) selectOneShot(false);

    return true;
}

/** the lock toggle's member set: the selected force keyframes that lie on the PINNING section —
 *  a lock on another section's key would be dead state, since the solve never reads it. One
 *  resolution, read by both halves of the row: `keyframeActs.toggleLock` acts on it, and the
 *  menu's Lock/Unlock label is computed over it (`editor-ui.md`'s toggle-labeling law makes those
 *  one row wearing two names, so they must not derive the set twice). Empty outside a session. */
export function lockCandidates(ecs: State): number[] {
    if (editor.pinning === null) return [];
    return sectionForces(ecs, editor.pinning.section)
        .filter((r) => editor.forces.ids.has(r.id))
        .map((r) => r.id);
}

/** the section context menu's document acts (`remove`/`removeSet`/`reset`/`pinExit`)
 *  — the chrome-free half of `SectionMenuActions`. `solve`/`solveShape`/`pinSolve`/
 *  `pinEnter` stay in `App.svelte` (each closes over the modal gate + abort controller — chrome,
 *  not document writes). `reset` and `pinExit` close their summoning context menu INSIDE the body
 *  (the locked decision: `closeContext` is an `editor` write like any other, and it's a no-op
 *  from the keyboard, where the deciders that reach these acts already return null while a menu
 *  is open). `remove`/`removeSet` dismiss by subject death instead
 *  — the menu derives null once the section is gone, so they carry no close. */
export function sectionActs(
    ecs: State,
    subject: number,
): Pick<SectionMenuActions, "remove" | "removeSet" | "reset" | "pinExit"> {
    return {
        remove: () => {
            if (!sectionOpsAllowed(editor.pinning)) return;
            if (removeSection(history, ecs, subject)) selectSection(null);
        },
        removeSet: () => {
            if (!sectionOpsAllowed(editor.pinning)) return;
            if (removeSections(history, ecs, [...editor.sections.ids])) selectSection(null);
        },
        reset: () => {
            if (!sectionOpsAllowed(editor.pinning)) return;
            closeContext();
            resetSection(history, ecs, subject);
        },
        pinExit: () => {
            closeContext();
            exitPinMode(ecs);
        },
    };
}

/** the node context menu's document acts — the FULL `NodeMenuActions` (every one is an ECS +
 *  `history` write on the target node or its selection set). */
export function nodeActs(ecs: State, eid: number): NodeMenuActions {
    return {
        add: () => select(extendTrack(history, ecs, Handle.section.get(eid))),
        remove: () => {
            const section = Handle.section.get(eid);
            if (trimTrack(history, ecs, section)) select(lastHandle(ecs, section));
        },
        removeSet: () => {
            const run = suffixRun(nodeMembers(ecs), (sec) => sectionHandles(ecs, sec).length);
            if (run !== null && trimSuffix(history, ecs, run.section, run.k))
                select(lastHandle(ecs, run.section));
        },
        toggleHandles: () => {
            if (editor.tangentEdit === eid) exitTangentEdit();
            else enterTangentEdit(eid);
        },
        pickMode: (target: TangentMode) => {
            const section = Handle.section.get(eid);
            const order = Handle.order.get(eid);
            const cur = handleTangent(ecs, section, order);
            if (cur === undefined && target === TangentMode.Aligned) return; // inferred already shows Aligned
            beginMove(ecs, section);
            const base = cur ?? seedTangent(ecs, section, order, target);
            if (base) {
                const next =
                    target === TangentMode.Mirror
                        ? mirrorTangent(base)
                        : target === TangentMode.Aligned
                          ? alignTangent(base)
                          : { ...base, mode: TangentMode.Free };
                setTangent(ecs, section, order, next);
            }
            commit(history);
        },
        pickModeSet: (mode: TangentMode) => {
            setTangentModes(history, ecs, nodeMembers(ecs), mode);
        },
        reset: () => {
            resetNodes(history, ecs, eid, stitchNode(ecs, eid));
        },
        resetSet: () => {
            resetNodesBulk(history, ecs, nodeMembers(ecs));
        },
    };
}

/** the force-keyframe context menu's document acts (`remove`/`toggleLock`) — the chrome-free
 *  half of `KeyframeMenuActions`. `setEase` stays in `Timeline.svelte` (the bulk-easing member
 *  set is its own derived). `remove` is the
 *  GUARDED body (`deleteSelectedForce`'s): a keyboard mutation skips a live landing first (deleting
 *  a moved key mid-window would leave the override easing a dead id) and refuses on a mixed-
 *  editability set (all-or-nothing, like every bulk row) — the menu row used to run the unguarded
 *  delete directly, the standing drift this hoist fixes. */
export function keyframeActs(ecs: State): Pick<KeyframeMenuActions, "remove" | "toggleLock"> {
    return {
        remove: () => {
            if (editor.force === null) return; // active is null iff the set is empty
            if (!forceSetEditable(ecs)) return;
            skipLanding();
            deleteForces(history, ecs, [...editor.forces.ids]);
        },
        toggleLock: () => {
            toggleLockedSet(lockCandidates(ecs));
        },
    };
}
