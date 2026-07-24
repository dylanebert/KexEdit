/** ephemeral editor state — the current selection. lives outside ECS because it
 *  doesn't persist (no save/load, no replay). plain mutable singleton; Svelte reads
 *  it via the per-RAF tick pattern in App.
 *
 *  there are no tools or modes: you select a node and drag it in the viewport, a
 *  force point on the timeline curve, a whole section, or the track START anchor —
 *  four mutually-exclusive selections (below), so a contextual action never fights
 *  over its target. */

import type { State } from "@dylanebert/shallot";
import { forceAt, Handle, handleAt, sectionAt } from "./track";

/** the editor surface the pointer is over — the router for surface-scoped keys
 *  (the Blender/Unity hovered-surface model). */
export type Surface = "viewport" | "timeline";

/** a per-kind selection: a set of members with the last-selected one active. single-select is the
 *  size-1 case (the substrate, not a parallel path). the node kind holds live eids (resolved fresh
 *  each pick); the force and section kinds hold stable ids (`Force.id` / `Section.id`), per the
 *  stable-form recycle-safety law. members are insertion-ordered (JS Set), so toggling out the active
 *  member promotes the most-recently-added survivor deterministically. */
export interface Selection {
    /** the selected members — eids (node kind) or stable ids (force/section kind). */
    ids: Set<number>;
    /** the active (last-selected) member: the single subject the readout, popover, manipulator ring,
     *  and snap resolution anchor to. null iff `ids` is empty; otherwise always a member of `ids`. */
    active: number | null;
}

function emptySel(): Selection {
    return { ids: new Set(), active: null };
}

/** the last member in insertion order, or null — the active-promotion pick when the active is
 *  toggled out (the most-recently-added survivor). */
export function lastMember(ids: Set<number>): number | null {
    let last: number | null = null;
    for (const id of ids) last = id;
    return last;
}

/** replace a selection with a single member, or clear it (null) — the size-1 (or size-0) case that
 *  makes single-select the default form. */
export function setMember(sel: Selection, id: number | null): void {
    sel.ids.clear();
    if (id !== null) sel.ids.add(id);
    sel.active = id;
}

/** toggle `id` in a selection (shift-click semantics): add it and make it active, or remove it —
 *  promoting the most-recently-added survivor active when the removed member was the active one. */
export function toggleMember(sel: Selection, id: number): void {
    if (sel.ids.delete(id)) {
        if (sel.active === id) sel.active = lastMember(sel.ids);
    } else {
        sel.ids.add(id);
        sel.active = id;
    }
}

function clearSel(sel: Selection): void {
    sel.ids.clear();
    sel.active = null;
}

interface EditorState {
    /** the selected geo nodes (a set + active member). ids are live eids, resolved fresh each pick
     *  and re-resolved by stable (section, order) across an undo (the eid recycles). */
    nodes: Selection;
    /** the selected force keyframes (set + active), addressed by stable `Force.id`. */
    forces: Selection;
    /** the selected sections (set + active), addressed by stable `Section.id`. */
    sections: Selection;
    /** the active geo node eid, or null — the single-subject accessor over `nodes` (its active
     *  member). reading it is "the one subject" (readout, ring, manipulator, snap); assigning it is
     *  a replace-select (`select`). readers wanting the whole set read `nodes` directly. */
    selection: number | null;
    /** the active force keyframe id, or null — the single-subject accessor over `forces`. */
    force: number | null;
    /** the active section id, or null — the single-subject accessor over `sections`. */
    section: number | null;
    /** eid of the node in tangent-edit mode (its handles are summoned), or null — a
     *  sub-mode layered on node selection: `tangentEdit !== null` implies the node set is exactly
     *  `{tangentEdit}` with it active. entered by double-clicking a node (Figma vector edit);
     *  any selection change to a different subject (or the set growing past it), Esc, or click-away
     *  exits it. NOT a fifth mutually-exclusive selection — a refinement of the node-selection state. */
    tangentEdit: number | null;
    /** stable id of the force keyframe in handle-edit sub-mode (its in/out handles are
     *  summoned), or null — the force analogue of `tangentEdit`, layered on force selection:
     *  `forceEdit !== null` implies the force set is exactly `{forceEdit}` with it active. entered by
     *  double-clicking a keyframe (the diamond hit beats insertion); a different selection, Esc, or
     *  click-away exits it. NOT a fifth mutually-exclusive selection. */
    forceEdit: number | null;
    /** which handle of the keyframe in handle-edit sub-mode is selected — `"in"`, `"out"`, or
     *  null when the keyframe itself holds the readout. a refinement layered on `forceEdit`
     *  (`forceHandle !== null` implies `forceEdit === force`): clicking a handle knob selects
     *  it, swapping the contextual readout from the keyframe to the handle's (Δs, Δg) offset;
     *  re-selecting the keyframe (or Esc) clears it back. NOT a mutually-exclusive selection. */
    forceHandle: "in" | "out" | null;
    /** whether the track START anchor is selected. there's one START per track, so a
     *  boolean; selecting it summons the initial-speed (v0) field popover. */
    start: boolean;
    /** the section right-click menu (Convert / Delete): screen position + target
     *  section id, or null when closed. shared so both the clip strip and the viewport
     *  span open the same menu, rendered once at the app root. */
    context: { x: number; y: number; section: number } | null;
    /** the node context menu (`Handles` toggle + a `Tangents ▸` submenu): screen position +
     *  the target node eid, or null when closed. opened by right-click on any pickable node
     *  (any mode) — the same shared menu language as `context`, rendered once at the app root. */
    nodeMenu: { x: number; y: number; eid: number } | null;
    /** the force keyframe right-click menu (Delete / Easing ▸ / Handles / Reset): screen
     *  position + the target point's stable id, or null when closed. the force analogue of
     *  `nodeMenu`, the same shared menu language. */
    forceMenu: { x: number; y: number; id: number } | null;
    /** the snapping magnet toggle (AE model): a persistent editor preference, default
     *  on, `S` toggles it, and holding Ctrl/Cmd momentarily inverts it (`snapActive`).
     *  ephemeral like the rest of `editor` — a view preference, not authored track state. */
    snap: boolean;
    /** whether a pointer drag is in flight (any gesture routed through `beginDrag`). App
     *  projects it as `data-dragging` on the app root; a CSS rule then suppresses `:hover`
     *  on the chrome under the cursor. ephemeral, read via the per-RAF tick. */
    dragging: boolean;
    /** which surface the pointer is over — routes the surface-scoped keys (`F` frames it,
     *  arrows act on it), ending the viewport-nudge vs timeline-playhead double-fire.
     *  defaults to the viewport, so keys route there before the pointer visits the dock;
     *  the dock's enter/leave is the only thing that flips it (the rest is the viewport). */
    hover: Surface;
}

export const editor: EditorState = {
    nodes: emptySel(),
    forces: emptySel(),
    sections: emptySel(),
    get selection(): number | null {
        return this.nodes.active;
    },
    set selection(v: number | null) {
        select(v);
    },
    get force(): number | null {
        return this.forces.active;
    },
    set force(v: number | null) {
        selectForce(v);
    },
    get section(): number | null {
        return this.sections.active;
    },
    set section(v: number | null) {
        selectSection(v);
    },
    tangentEdit: null,
    forceEdit: null,
    forceHandle: null,
    start: false,
    context: null,
    nodeMenu: null,
    forceMenu: null,
    snap: true,
    dragging: false,
    hover: "viewport",
};

// ── drag gesture substrate ──
// every pointer drag routes through `beginDrag`. it (1) takes pointer capture — for event
// routing and, more importantly, so hit-testing bypasses the dragged surface, which the
// hover-suppression CSS below marks `pointer-events: none`; and (2) sets `editor.dragging`,
// which App reflects as `data-dragging` on the app root. that attribute drives one CSS rule
// (`pointer-events: none` on the hoverable chrome), the ONLY thing that stops `:hover`
// firing on chrome under the cursor mid-drag — CSS `:hover` ignores pointer capture in both
// Chromium and Firefox, so capture alone can't fix it.
//
// `beginDrag`'s own listeners are the SOLE release authority: they clear the flag + capture
// on `pointerup`/`pointercancel`, keyed on the captured pointerId so a superseded drag's
// late release can't clear a newer one (a new `beginDrag` supersedes a stale one). they
// listen on `window`, not the captured element, so a missed or failed capture still catches
// the release (window sees every pointer event). the per-gesture handlers do NOT clear the
// flag; only the unmount teardowns call `endDrag()` directly, for a drag torn down without a
// release event.
let dragEl: Element | null = null;
let dragId = -1;

/** open a drag gesture on `el` for `pointerId`: take pointer capture and raise the drag
 *  flag; both clear on the pointer's `pointerup`/`pointercancel`. re-entrant safe. */
export function beginDrag(el: Element, pointerId: number): void {
    if (dragEl) endDrag(); // a prior drag whose release was missed — clear before claiming
    dragEl = el;
    dragId = pointerId;
    editor.dragging = true;
    try {
        el.setPointerCapture(pointerId);
    } catch {
        // capture is best-effort (a detached element throws); the window listeners below
        // still catch the release and the flag still drives suppression
    }
    window.addEventListener("pointerup", onDragRelease);
    window.addEventListener("pointercancel", onDragRelease);
    el.addEventListener("lostpointercapture", onDragRelease);
}

function onDragRelease(e: Event): void {
    // ignore a stale listener firing for a pointer that isn't the active drag's
    if (e instanceof PointerEvent && e.pointerId !== dragId) return;
    endDrag();
}

/** clear the drag flag + release capture (idempotent). driven by `beginDrag`'s own release
 *  listeners; also called directly by the unmount teardowns for a drag with no release. */
export function endDrag(): void {
    if (!dragEl) return;
    const el = dragEl;
    const id = dragId;
    dragEl = null;
    dragId = -1;
    editor.dragging = false;
    window.removeEventListener("pointerup", onDragRelease);
    window.removeEventListener("pointercancel", onDragRelease);
    el.removeEventListener("lostpointercapture", onDragRelease);
    try {
        if (el.hasPointerCapture(id)) el.releasePointerCapture(id);
    } catch {
        // already released / detached
    }
}

/** flip the snapping magnet (the `S` key). */
export function toggleSnap(): void {
    editor.snap = !editor.snap;
}

/** whether snapping is active for a gesture, given whether the Ctrl/Cmd bypass modifier
 *  is held: the persistent toggle XOR the momentary modifier (the AE magnet — hold to
 *  invert, so a bypass turns it off while on and summons it while off). */
export const snapActive = (mod: boolean): boolean => editor.snap !== mod;

// the four selection kinds are mutually exclusive — selecting into one clears the others, so the
// contextual actions (node extend/trim, force field popover, section ops, v0 popover) never fight
// over which target a key press means. each `select*` grows a `mode`: "replace" (the default, and
// today's single-select behavior — collapse the kind to one member) and "toggle" (shift-click
// membership: add-and-activate, or remove-and-promote). the edit sub-modes stay single-subject —
// entering one collapses its kind to that one member (`enter*Edit` route through the replace form).

/** the two selection forms: "replace" (collapse the kind to one member — today's behavior) and
 *  "toggle" (shift-click add/remove membership). */
export type SelectMode = "replace" | "toggle";

/** clear the non-node kinds — the mutual-exclusion sweep a node select runs (switching to / staying
 *  in the node kind). leaves `nodes` and `tangentEdit` for the caller. */
function exclusiveNode(): void {
    clearSel(editor.forces);
    clearSel(editor.sections);
    editor.forceEdit = null;
    editor.forceHandle = null;
    editor.start = false;
}

function exclusiveForce(): void {
    clearSel(editor.nodes);
    clearSel(editor.sections);
    editor.tangentEdit = null;
    editor.start = false;
}

function exclusiveSection(): void {
    clearSel(editor.nodes);
    clearSel(editor.forces);
    editor.tangentEdit = null;
    editor.forceEdit = null;
    editor.forceHandle = null;
    editor.start = false;
}

/** drop tangent edit unless the node selection is exactly its subject (a set that grew past one, or
 *  whose active moved off it, leaves the single-subject sub-mode). */
function reconcileTangent(): void {
    if (
        editor.tangentEdit !== null &&
        (editor.nodes.ids.size !== 1 || editor.nodes.active !== editor.tangentEdit)
    )
        editor.tangentEdit = null;
}

/** drop force handle-edit unless the force selection is exactly its subject. */
function reconcileForceEdit(): void {
    if (
        editor.forceEdit !== null &&
        (editor.forces.ids.size !== 1 || editor.forces.active !== editor.forceEdit)
    )
        editor.forceEdit = null;
}

/** select a geo node. "replace" (default) collapses the node set to `eid` (or clears it when null) —
 *  today's behavior; "toggle" adds/removes `eid` (shift-click). either non-clearing form sweeps the
 *  other kinds. a select to a different subject exits tangent edit; re-selecting the edited node (as
 *  the sole member) keeps it, so grabbing its own handle or nudging it doesn't drop the mode. */
export function select(eid: number | null, mode: SelectMode = "replace"): void {
    if (eid === null || mode === "replace") {
        setMember(editor.nodes, eid);
        if (eid !== null) exclusiveNode();
    } else {
        exclusiveNode();
        toggleMember(editor.nodes, eid);
    }
    reconcileTangent();
}

/** replace the node selection with a computed set (the marquee's atomic write): members `ids`,
 *  `active` active, the other kinds swept when non-empty. the set-valued analog of `select` — one
 *  write of a whole merged hit set, same exclusivity + reconcile. an empty set clears the node kind
 *  only (the caller sweeps the rest for a full deselect, matching empty-click). */
export function selectNodes(ids: number[], active: number | null): void {
    rebuild(editor.nodes, ids, active);
    if (ids.length) exclusiveNode();
    reconcileTangent();
}

/** replace the force selection with a computed set (the marquee's atomic write) — the force
 *  analog of `selectNodes`. */
export function selectForces(ids: number[], active: number | null): void {
    rebuild(editor.forces, ids, active);
    if (ids.length) exclusiveForce();
    editor.forceHandle = null;
    reconcileForceEdit();
}

/** enter tangent-edit mode on a node — the summon (double-click). collapses the node selection to
 *  this one subject (clearing the other kinds) and layers the edit sub-mode on it, so its handles
 *  render and grab. node 0 (the entry anchor) is editable too — it exposes its single out-handle
 *  (the entry handle), reached at the START diamond or, at a geo→geo boundary, stitched onto its
 *  coincident upstream tip. */
export function enterTangentEdit(eid: number): void {
    select(eid);
    editor.tangentEdit = eid;
}

/** exit tangent-edit mode, keeping the node selected (Esc's first peel). */
export function exitTangentEdit(): void {
    editor.tangentEdit = null;
}

/** select a force keyframe by stable id. "replace" (default) collapses the force set to `id` (or
 *  clears it when null); "toggle" adds/removes it (shift-click). either non-clearing form sweeps the
 *  other kinds and resets the handle sub-selection (the keyframe itself holds the readout). a select
 *  to a different subject exits handle edit; re-selecting the edited point (sole member) keeps it. */
export function selectForce(id: number | null, mode: SelectMode = "replace"): void {
    if (id === null || mode === "replace") {
        setMember(editor.forces, id);
        if (id !== null) exclusiveForce();
    } else {
        exclusiveForce();
        toggleMember(editor.forces, id);
    }
    editor.forceHandle = null; // selecting the point itself shows the keyframe readout
    reconcileForceEdit();
}

/** enter handle-edit mode on a force keyframe — the summon (double-click). collapses the force
 *  selection to this one subject (clearing the other kinds) and layers the edit sub-mode on it, so
 *  its in/out handles render and grab. mirrors geo's `enterTangentEdit`. */
export function enterForceEdit(id: number): void {
    selectForce(id);
    editor.forceEdit = id;
}

/** select a summoned handle of the edited keyframe (`"in"`/`"out"`, or null to clear back to
 *  the keyframe readout) — the click-select that swaps the contextual popover to the handle's
 *  (Δs, Δg). only meaningful inside handle-edit (`forceEdit` set). */
export function selectForceHandle(side: "in" | "out" | null): void {
    editor.forceHandle = side;
}

/** exit force handle-edit mode, keeping the point selected (Esc's first peel). */
export function exitForceEdit(): void {
    editor.forceEdit = null;
    editor.forceHandle = null;
}

/** select a section by stable id. "replace" (default) collapses the section set to `id` (or clears
 *  it when null); "toggle" adds/removes it (shift-click). either non-clearing form sweeps the
 *  other kinds. */
export function selectSection(id: number | null, mode: SelectMode = "replace"): void {
    if (id === null || mode === "replace") {
        setMember(editor.sections, id);
        if (id !== null) exclusiveSection();
    } else {
        exclusiveSection();
        toggleMember(editor.sections, id);
    }
}

/** select (or clear) the track START anchor — the initial-speed handle. */
export function selectStart(on: boolean): void {
    editor.start = on;
    if (on) {
        clearSel(editor.nodes);
        clearSel(editor.forces);
        clearSel(editor.sections);
        editor.tangentEdit = null;
        editor.forceEdit = null;
        editor.forceHandle = null;
    }
}

/** open the section context menu at a screen point, targeting a section (also selects
 *  it, so the target reads highlighted). */
export function openContext(x: number, y: number, section: number): void {
    selectSection(section);
    editor.context = { x, y, section };
}

/** close the section context menu. */
export function closeContext(): void {
    editor.context = null;
}

/** open the node context menu at a screen point, targeting a pickable node. */
export function openNodeMenu(x: number, y: number, eid: number): void {
    editor.nodeMenu = { x, y, eid };
}

/** close the node context menu. */
export function closeNodeMenu(): void {
    editor.nodeMenu = null;
}

/** open the force keyframe context menu at a screen point, targeting a point (also selects
 *  it, so the target reads highlighted). */
export function openForceMenu(x: number, y: number, id: number): void {
    selectForce(id);
    editor.forceMenu = { x, y, id };
}

/** close the force keyframe context menu. */
export function closeForceMenu(): void {
    editor.forceMenu = null;
}

// ── history selection hook ────────────────────────────────────────────────────────
// the editor's snapshot/restore for undo/redo, injected into `history` at boot (`setSelectionHook`)
// so the coupling points inward — history calls this, never imports editor. the whole selection SET
// is snapshotted: a NODE by its stable (section, order), not its eid (`restoreSection`/`restoreAll`
// recycle the allocator LIFO, so a raw eid would remap to a DIFFERENT node after an undo), force and
// section by stable id, the START by a flag; the active member rides along in the same form. undo
// restores each command's pre-selection, redo its post; a selection change alone is never a command.

interface NodeRef {
    section: number;
    order: number;
}
type SelSnapshot =
    | { kind: "node"; members: NodeRef[]; active: NodeRef; editing: boolean }
    | { kind: "force"; ids: number[]; active: number; editing: boolean }
    | { kind: "section"; ids: number[]; active: number }
    | { kind: "start" }
    | null;

/** rebuild a selection set from restored members, re-anchoring the active (or promoting the
 *  most-recently-added survivor when the snapshotted active didn't survive the restore). */
function rebuild(sel: Selection, ids: number[], active: number | null): void {
    sel.ids.clear(); // mutate in place (like setMember/toggleMember) so no held reference goes stale
    for (const id of ids) sel.ids.add(id);
    sel.active = active !== null && sel.ids.has(active) ? active : lastMember(sel.ids);
}

/** the `SelectionHook` (`history.ts`) the app injects at boot: capture the current selection set in a
 *  restorable form + restore it. history holds the snapshot opaquely. */
export const selectionHook = {
    snapshot(ecs: State): SelSnapshot {
        const n = editor.nodes;
        if (n.active !== null && ecs.has(n.active, Handle)) {
            const members: NodeRef[] = [];
            for (const eid of n.ids)
                if (ecs.has(eid, Handle))
                    members.push({
                        section: Handle.section.get(eid),
                        order: Handle.order.get(eid),
                    });
            const active = {
                section: Handle.section.get(n.active),
                order: Handle.order.get(n.active),
            };
            return { kind: "node", members, active, editing: editor.tangentEdit === n.active };
        }
        if (editor.forces.active !== null)
            return {
                kind: "force",
                ids: [...editor.forces.ids],
                active: editor.forces.active,
                editing: editor.forceEdit === editor.forces.active,
            };
        if (editor.sections.active !== null)
            return {
                kind: "section",
                ids: [...editor.sections.ids],
                active: editor.sections.active,
            };
        if (editor.start) return { kind: "start" };
        return null;
    },
    restore(ecs: State, snap: unknown): void {
        editor.nodeMenu = null; // its rows (checked mode, enablement) went stale when the document changed
        editor.forceMenu = null; // same — the force keyframe menu's rows go stale on any restore
        const s = snap as SelSnapshot;
        if (s === null) {
            clearSel(editor.nodes); // clears the selection + (below) the tangent-edit sub-mode
            clearSel(editor.forces);
            clearSel(editor.sections);
            editor.tangentEdit = null;
            editor.forceEdit = null;
            editor.forceHandle = null;
            editor.start = false;
            return;
        }
        switch (s.kind) {
            case "node": {
                const ids: number[] = [];
                for (const m of s.members) {
                    const eid = handleAt(ecs, m.section, m.order); // re-resolve across the eid recycle
                    if (eid !== null) ids.push(eid); // drop a member that didn't survive
                }
                const active = handleAt(ecs, s.active.section, s.active.order);
                rebuild(editor.nodes, ids, active);
                exclusiveNode();
                editor.tangentEdit =
                    s.editing && editor.nodes.ids.size === 1 ? editor.nodes.active : null;
                break;
            }
            case "force":
                // prune ids whose point didn't survive the restore, matching the node path — a
                // dropped active then promotes the last survivor via rebuild's has-check
                rebuild(
                    editor.forces,
                    s.ids.filter((id) => forceAt(ecs, id) !== null),
                    s.active,
                );
                exclusiveForce();
                editor.forceHandle = null;
                editor.forceEdit =
                    s.editing && editor.forces.ids.size === 1 ? editor.forces.active : null;
                break;
            case "section":
                rebuild(
                    editor.sections,
                    s.ids.filter((id) => sectionAt(ecs, id) !== null),
                    s.active,
                );
                exclusiveSection();
                break;
            case "start":
                selectStart(true);
                break;
        }
    },
};
