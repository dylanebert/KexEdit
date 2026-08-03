import type { State } from "@dylanebert/shallot";
import {
    closeContext,
    editor,
    enterTangentEdit,
    exitTangentEdit,
    type PinSession,
    select,
    selectSection,
    skipLanding,
    toggleLockedSet,
} from "./editor";
import {
    beginMove,
    commit,
    deleteForces,
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
    Force,
    forceAt,
    Handle,
    handleTangent,
    lastHandle,
    sectionForces,
    sectionHandles,
    seedTangent,
    setTangent,
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
 *  switch — may run right now. False while ANY pin session is open (`editor.pinning`),
 *  not just on the session's own section: convert/delete/join aren't available inside the mode
 *  (the locked decision's consent-boundary law). Deleting the session's own section would strand
 *  `editor.pinning` on a dead id; a convert or a domain switch would land a track rewrite
 *  INSIDE the open session — an upstream convert silently rebases what the stamp means, and a
 *  domain switch is a lossy whole-track rewrite of the very store the session is solving. */
export function sectionOpsAllowed(pinning: PinSession | null): boolean {
    return pinning === null;
}

/** the editing lockdown's per-subject predicate (kex2d-optimize-mode stage 5): while a pin
 *  session is open, ONLY the pinning section is editable — every edit surface addressing any
 *  other section (geo nodes, other force sections' keys/extents, the track v0) grays its
 *  affordance and guards its action on this. `sectionOpsAllowed` (above) stays the stricter
 *  structural gate: add/remove/convert/domain are barred even on the pinning section.
 *  `section` is the subject's own section id; pass -1 for a track-global subject (v0), which no
 *  session id ever equals. */
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

/** the section context menu's document acts (`remove`/`removeSet`/`reset`/`pinExit`) — the
 *  chrome-free half of `SectionMenuActions`. `solve`/`solveShape`/`pinSolve`/`pinEnter` stay in
 *  `App.svelte` (each closes over the modal gate + abort controller — chrome, not document
 *  writes). `reset` and `pinExit` close their summoning context menu INSIDE the body (the locked
 *  decision: `closeContext` is an `editor` write like any other, and it's a no-op from the
 *  keyboard, where the deciders that reach these acts already return null while a menu is open).
 *  `remove`/`removeSet` dismiss by subject death instead — the menu derives null once the section
 *  is gone, so they carry no close. */
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

/** the node context menu's document acts — the FULL `NodeMenuActions` (none of the eight is
 *  chrome: every one is an ECS + `history` write on the target node or its selection set). */
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

/** the force-keyframe context menu's document acts (`remove`/`toggleLock`) — the chrome-free half
 *  of `KeyframeMenuActions`. `setEase`/`chooseCustom`/`pickMode` stay in `Timeline.svelte` (chart-
 *  pixel couplings and the bulk-easing member set are its own deriveds). `remove` is the GUARDED
 *  body (`deleteSelectedForce`'s): a keyboard mutation skips a live landing first (deleting a moved
 *  key mid-window would leave the override easing a dead id) and refuses on a mixed-editability
 *  set (all-or-nothing, like every bulk row) — the menu row used to run the unguarded delete
 *  directly, the standing drift this hoist fixes. */
export function keyframeActs(ecs: State): Pick<KeyframeMenuActions, "remove" | "toggleLock"> {
    return {
        remove: () => {
            if (editor.force === null) return; // active is null iff the set is empty
            if (!forceSetEditable(ecs)) return;
            skipLanding();
            deleteForces(history, ecs, [...editor.forces.ids]);
        },
        toggleLock: () => {
            if (editor.pinning === null) return;
            const sid = editor.pinning.section;
            toggleLockedSet(
                sectionForces(ecs, sid)
                    .filter((r) => editor.forces.ids.has(r.id))
                    .map((r) => r.id),
            );
        },
    };
}
