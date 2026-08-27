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
    joinSections,
    removeSection,
    removeSections,
    resetNodes,
    resetNodesBulk,
    resetSection,
    setTangentModes,
    splitSection,
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
 *  whole-section selection, either Convert direction on ANY section, Cut (any of its three
 *  landing surfaces), and the ruler's domain switch — may run right now. False while ANY pin
 *  session is open (`editor.pinning`), not just on the session's own section: convert/delete/
 *  cut/join aren't available inside the mode (the locked decision's consent-boundary law).
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

/** a Cut's resolved landing point — `at` is the target's own coordinate for a landmark call (a
 *  node's `order`, a keyframe's `s`); `t` is the geo free-position parameter within segment `at`
 *  (the cursor-anchored section row's own case — `editor-ui.md`'s toLocal lens resolves
 *  it, the no-proximity-magnet locked decision), omitted or `≤ 0` for every landmark call (the
 *  reduction `track.splitGeoAt` and `history.splitSection` already carry). Ignored on a force
 *  section — `splitForce` is exact at any interior `s` since stage 1, landmark or free alike. */
export type CutPosition = { at: number; t?: number };

/** the ONE structural Cut body shared by the section, node, and keyframe menu triples
 *  (`editor-ui.md` Menus' key-act seam) — one `history.splitSection` call, its own kind-fitted
 *  dispatch (`track.splitGeoAt` for geo, `track.splitForce` for force) and its own undo entry, so
 *  the three rows can't drift onto three bodies. **The `sectionOpsAllowed` consent-boundary
 *  guard lives HERE, not at each of the three call sites** — the stage-4 review found the
 *  boundary re-broken by a hand-written guard missing from one surface, and stage 6's review
 *  found it broken again by a hand-written ENABLEMENT predicate on a fourth surface (the
 *  keyframe row/key) disagreeing with this guard. Three independently-maintained copies of the
 *  same check is the defect class, not any one omission; putting the guard in the one function
 *  every surface already funnels through makes a future surface inherit it for free rather than
 *  needing to remember it. Returns the new tail section id, or null (a non-interior point, or the
 *  guard). */
export function cutSection(ecs: State, section: number, position: CutPosition): number | null {
    if (!sectionOpsAllowed(editor.pinning)) return null;
    return splitSection(history, ecs, section, position.at, position.t);
}

/** whether a landmark node `order` (in a chain of `count` nodes) is a valid Cut point —
 *  `splitGeo`'s own interior bound (1 ≤ order ≤ count − 2): never the entry node, never the chain
 *  end (both a no-op there — the locked decision's "a cut invoked from a node menu lands on that
 *  landmark", never a boundary already reached). */
export function nodeCuttable(order: number, count: number): boolean {
    return order > 0 && order < count - 1;
}

/** whether a landmark force keyframe at local `s` (in a section of `length`) is a valid Cut
 *  point — `splitForce`'s own interior bound (0 < s < length): never the entry, never the exit. */
export function keyframeCuttable(s: number, length: number): boolean {
    return s > 0 && s < length;
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
function stripEditableAtEcs(ecs: State, d: number): boolean {
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

    // strips — guard: each strip's station is editable
    if (editor.strips.ids.size > 0) {
        let allEditable = true;
        for (const id of editor.strips.ids) {
            const sEid = stripAt(ecs, id);
            if (sEid === null || !stripEditableAtEcs(ecs, Strip.start.get(sEid))) {
                allEditable = false;
                break;
            }
        }
        if (allEditable) {
            for (const id of editor.strips.ids)
                if (stripAt(ecs, id) !== null) ops.push(() => destroyStrip(ecs, id));
            delStrip = true;
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

/** the section context menu's document acts (`remove`/`removeSet`/`reset`/`pinExit`/`cutAt`/
 *  `join`) — the chrome-free half of `SectionMenuActions`. `solve`/`solveShape`/`pinSolve`/
 *  `pinEnter` stay in `App.svelte` (each closes over the modal gate + abort controller — chrome,
 *  not document writes). `reset` and `pinExit` close their summoning context menu INSIDE the body
 *  (the locked decision: `closeContext` is an `editor` write like any other, and it's a no-op
 *  from the keyboard, where the deciders that reach these acts already return null while a menu
 *  is open). `remove`/`removeSet`/`join` dismiss by subject death (or survivor promotion) instead
 *  — the menu derives null once the section is gone, so they carry no close.
 *
 *  `position` is Cut's own resolved landing point — genuinely CALLER-local (the menu's own screen
 *  cursor resolved through `editor-ui.md`'s toLocal lens, or `controls.ts`'s own read of
 *  the playhead through `cart.playheadPosition` + the same `sectionCutAt` seam — two different
 *  resolutions of the same `CutPosition` shape), so it rides in as a third constructor argument
 *  rather than being derivable from `subject` alone the way a node's order or a keyframe's `s` is.
 *  `null` (the default — no caller has resolved a position yet) makes `cutAt` a safe no-op; the
 *  row's own `enabled` and the keyboard decider's own `cuttable` are the real gates
 *  (`editor-ui.md`'s grays-never-hides law), and `cutSection` carries the `sectionOpsAllowed`
 *  consent-boundary guard itself (below). Named `cutAt`, not `cut` — `nodeActs`/`keyframeActs`
 *  bind `C` to `cut` on a NODE/keyframe landmark; this is a different act on a different subject
 *  that happens to share the same binding on ITS surface (`keys.ts sectionKeyAct`), and the two
 *  must stay apart by NAME for `Acts` (`tests/menu.test.ts`) to tell them apart — `append`/`add`'s
 *  own precedent, two acts colliding only in English.
 *
 *  `join` is the set-lifted Join (stage 5): it reads the selected set exactly like `removeSet`
 *  does, carries the SAME `sectionOpsAllowed` guard every structural row here does (Join reaches
 *  past its subject to destroy a neighbor — squarely the consent boundary Cut joined at stage 4),
 *  and re-selects the merge's survivor (`history.joinSections`' own return) rather than clearing
 *  the selection the way a delete must. */
export function sectionActs(
    ecs: State,
    subject: number,
    position: CutPosition | null = null,
): Pick<SectionMenuActions, "remove" | "removeSet" | "reset" | "pinExit" | "cutAt" | "join"> {
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
        cutAt: () => {
            // `cutSection` itself carries the `sectionOpsAllowed` guard now — the one shared
            // enforcement point, not a fourth hand-written copy of it here.
            if (position === null) return;
            cutSection(ecs, subject, position);
        },
        join: () => {
            if (!sectionOpsAllowed(editor.pinning)) return;
            const survivor = joinSections(history, ecs, [...editor.sections.ids]);
            if (survivor !== null) selectSection(survivor);
        },
    };
}

/** the node context menu's document acts — the FULL `NodeMenuActions` (none of the nine is
 *  chrome: every one is an ECS + `history` write on the target node or its selection set). `cut`
 *  is the landmark case (`t` omitted): the clicked node's own `order` reduces `track.splitGeoAt`
 *  to today's `splitGeo`, no subdivision, no `Custom` demotion (the locked decision's "a cut
 *  invoked from a node menu stays in the named-easing layer"). It's a structural op like
 *  `sectionActs`' remove/reset — Cut is barred while ANY pin session is open, on any section, not
 *  just the pinning one (the widened consent boundary above) — but unlike those, it carries no
 *  guard of its OWN here: `cutSection` enforces `sectionOpsAllowed` itself (above), the one shared
 *  point every Cut surface funnels through. */
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
        cut: () => {
            cutSection(ecs, Handle.section.get(eid), { at: Handle.order.get(eid) });
        },
    };
}

/** the force-keyframe context menu's document acts (`remove`/`toggleLock`/`cut`) — the chrome-free
 *  half of `KeyframeMenuActions`. `setEase`/`chooseCustom`/`pickMode` stay in `Timeline.svelte`
 *  (chart-pixel couplings and the bulk-easing member set are its own deriveds). `remove` is the
 *  GUARDED body (`deleteSelectedForce`'s): a keyboard mutation skips a live landing first (deleting
 *  a moved key mid-window would leave the override easing a dead id) and refuses on a mixed-
 *  editability set (all-or-nothing, like every bulk row) — the menu row used to run the unguarded
 *  delete directly, the standing drift this hoist fixes. `cut` is single-subject (the ACTIVE
 *  keyframe, like `chooseCustom`'s own Custom row) — the landmark case (`t` omitted): the
 *  keyframe's own stored `s` is already the exact boundary value, so `track.splitForce` duplicates
 *  it verbatim, no subdivision, no `Custom` demotion. Cut is barred while ANY pin session is open,
 *  on any section (the widened consent boundary above) — enforced by `cutSection` itself, not a
 *  guard here (this surface has no partial-set shape to refuse into first the way `remove` does,
 *  so there's nothing this body needs to check before delegating). */
export function keyframeActs(
    ecs: State,
): Pick<KeyframeMenuActions, "remove" | "toggleLock" | "cut"> {
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
        cut: () => {
            if (editor.force === null) return;
            const eid = forceAt(ecs, editor.force);
            if (eid === null) return;
            cutSection(ecs, Force.section.get(eid), { at: Force.s.get(eid) });
        },
    };
}
