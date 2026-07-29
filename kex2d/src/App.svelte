<script lang="ts">
import type { State } from "@dylanebert/shallot";
import { onMount } from "svelte";
import {
    attachControls,
    manipKnobs,
    nodeMembers,
    sectionSolvable,
    sectionsDeletable,
    selectedMetrics,
    suffixRun,
} from "./controls";
import {
    beginConvert,
    beginDrag,
    closeContext,
    closeNodeMenu,
    convertProgress,
    dismissNotice,
    editor,
    endConvert,
    enterTangentEdit,
    exitTangentEdit,
    notify,
    select,
    selectSection,
    selectStart,
    solveDone,
    solveFailed,
} from "./editor";
import { convertGeo } from "./geoforce";
import {
    beginMove,
    beginV0,
    commit,
    convertSection,
    convertSections,
    extendTrack,
    history,
    removeSection,
    removeSections,
    resetTangents,
    resetTangentsBulk,
    setTangentModes,
    trimSuffix,
    trimTrack,
} from "./history";
import Menu from "./Menu.svelte";
import { fitMenu, type MenuItem } from "./menu";
import { RADIAL_R, RadialSlot, ringBase, ringSlot } from "./radial";
import { alignTangent, mirrorTangent, TangentMode } from "./spline";
import { stitchNode } from "./tangents";
import Timeline from "./Timeline.svelte";
import {
    bakeLive,
    bakeOut,
    exitWorld,
    Handle,
    handleTangent,
    lastHandle,
    samples,
    SectionKind,
    sectionAt,
    sectionHandles,
    sectionInfo,
    sections,
    seedTangent,
    setTangent,
    setTrackV0,
    Track,
} from "./track";
import {
    attachCanvas2D,
    DOCK_RESERVE,
    dragReadout,
    readoutFit,
    snapGuides,
    viewTransform,
} from "./view";

const { ecs }: { ecs: State } = $props();
let canvas: HTMLCanvasElement;

let trackEid = $state<number | null>(null);
let tick = $state(0);

// the pointer/keyboard controller (`attachControls`): `detach` on unmount, `startManip` the seam the
// DOM manipulator knob buttons call on pointerdown to enter the drag gesture.
let controls: ReturnType<typeof attachControls> | undefined;

onMount(() => {
    attachCanvas2D(canvas);
    controls = attachControls(canvas, ecs);
    for (const eid of ecs.query([Track])) {
        trackEid = eid;
        break;
    }
    let raf = 0;
    const loop = (): void => {
        tick++;
        raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
        controls?.detach();
        cancelAnimationFrame(raf);
    };
});

// ── the invoked geo→force solve ────────────────────────────────────────────────────
// the section menu's solve row runs `convertGeo` (geoforce.ts) behind a MODAL: the answer is only
// valid against the shape the solve was handed, so for its whole duration the progress surface is
// the only live control. blocking is two mechanisms, and it takes both:
//
// 1. `inert` on the whole app content while the gate is open (the markup below). That is the
//    STRUCTURAL half — pointer, focus, and activation in one attribute: nothing behind the scrim
//    can be tabbed to, so no background button can take an Enter/Space that turns into a real
//    `click` no key handler ever sees. A scrim alone only stops the pointer.
// 2. this capture-phase key swallow, for the WINDOW-level listeners (controls.ts, Timeline), which
//    `inert` doesn't touch — they're bound to `window`, not to any inert element. Escape is the
//    one key that acts: it cancels, exactly like the Cancel button.
//
// the listener is PERMANENT and gates on the live `editor.converting` — the dismissal standard
// every menu here wears (AGENTS.md: a tick-derived lifetime outlives the state change by a frame,
// and a capture-phase swallow that outlives its own layer eats the next key). it's registered
// before the two menu Escape handlers below, so the gate wins the key while it's up.
let solveAbort: AbortController | null = null;
onMount(() => {
    const onKey = (e: KeyboardEvent): void => {
        if (editor.converting === null) return;
        // stop the app's own handlers, never the browser's: `preventDefault` here would take the
        // page's reload/find keys hostage for the length of a solve, which a modal has no business
        // doing. Nothing in this app scrolls on a key, so there is no default worth cancelling.
        e.stopImmediatePropagation();
        if (e.key === "Escape") cancelSolve();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
});

// cancel the live solve — the Cancel button, Escape, and nothing else. `convertGeo` rejects with
// this reason, and the façade terminates its pool; the document was never written, so a cancel
// closes the modal and says nothing (the author asked for it).
function cancelSolve(): void {
    solveAbort?.abort(new Error("cancelled"));
}

// the readout's auto-dismiss (root ui.md: a transient outcome is a toast). re-raised per solve, so
// a new solve's readout replaces the previous one's remaining time instead of stacking.
const NOTICE_MS = 6000;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
function raise(n: { kind: "done" | "error"; text: string }): void {
    notify(n.kind, n.text);
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(dismissNotice, NOTICE_MS);
}

// run the solve on a section, modal for its duration. the document is written once, inside
// `convertGeo`, at resolution — so every path out of here (cancel, diverged, a worker failure, an
// answer that expired) leaves the track exactly as it was and only the readout differs.
async function solve(section: number): Promise<void> {
    if (editor.converting !== null) return; // one at a time (the gate's own reentrancy guard)
    const controller = new AbortController();
    solveAbort = controller;
    beginConvert();
    try {
        raise(solveDone(await convertGeo(history, ecs, section, {
            signal: controller.signal,
            onProgress: convertProgress,
        })));
    } catch (e) {
        const { notice, detail } = solveFailed(e, controller.signal.aborted);
        if (detail !== null) console.error(detail); // the internals go here, never to the readout
        if (notice !== null) raise(notice);
    } finally {
        solveAbort = null;
        endConvert();
    }
}

// whether the node selection is a multi-set. the CANVAS shows NO contextual controls over one
// (editor-ui.md multi law, user-locked after three feel rounds): the whole node-action ring — both
// manipulator knobs and the extend button — and the metrics readout all hide, because every one of
// them is single-subject and a multi selection has no single subject. The group move survives as the
// arrow-nudge (controls.ts), capability without chrome. Single-select is the size-1 case, unchanged.
//
// a plain function, NOT a `$derived`: `editor` is a plain singleton, so a derived over it has no
// invalidation signal of its own and only re-runs on `tick` — and one tick-driven derived reading
// another goes stale within a frame (the readout vanished at rest after a manipulator drag, capture-
// caught). Every caller below is already inside a `void tick` derived, so the read is live there.
const nodeMulti = (): boolean => editor.nodes.ids.size > 1;

// the snap readout text (the Blender modal-transform / SketchUp measurements-box precedent): a
// node's live metrics (° and/or m), read through the per-RAF tick. ONE readout, ONE source
// (`selectedMetrics` — the node's authored exit heading + chord to prev, the Figma selected-object
// dimensions idiom), keyed by three cases in precedence: a live tangent-handle drag reads the
// DRAGGED node's metrics (feel round 14 — a handle drag reports the node's quantities, never the
// handle's own angle/length; the out-vector rewrite updates exitWorld live); else a live manipulator
// drag shows the values that gesture publishes (`snapGuides`, seeded at the knob grab so one source
// owns it); else at rest the SELECTED node's metrics. null when there's no target node, so the
// readout is absent then. Rendered centered below the node (below), offset clear of the ring buttons.
const snapText = $derived.by((): string | null => {
    void tick;
    if (nodeMulti()) return null; // no contextual chrome on a multi-set (the multi law, above)
    let angle: string | null;
    let length: string | null;
    if (dragReadout.node !== null) {
        // a live tangent-handle drag: the dragged node's authored metrics (keyed to the handle's
        // node, so a boundary-stitch drag reports the downstream node-0). null → no readout (node 0
        // has no chord, matching its resting readout), never a fall-through to the selection.
        const m = selectedMetrics(ecs, dragReadout.node);
        if (m === null) return null;
        angle = m.angleLabel;
        length = m.lengthLabel;
    } else if (snapGuides.angleLabel !== null || snapGuides.lengthLabel !== null) {
        // a live manipulator drag: the values that gesture publishes per move.
        angle = snapGuides.angleLabel;
        length = snapGuides.lengthLabel;
    } else {
        // at rest: the selected node's authored metrics (exit heading + chord).
        const eid = editor.selection;
        const m = eid === null ? null : selectedMetrics(ecs, eid);
        if (m === null) return null;
        angle = m.angleLabel;
        length = m.lengthLabel;
    }
    const parts: string[] = [];
    if (angle) parts.push(angle);
    if (length) parts.push(length);
    return parts.length > 0 ? parts.join(" · ") : null;
});

const infeasible = $derived.by((): boolean => {
    void tick;
    if (trackEid === null) return false;
    const out = bakeOut.get(trackEid);
    return !!out && out.firstInfeasible >= 0;
});
// reflect the drag flag as `data-dragging` on the app root — the CSS hook a drag uses to
// suppress `:hover` on the chrome under the cursor (both this component's and the dock's).
// read through the per-RAF tick like the rest of the projected editor state.
const dragging = $derived.by((): boolean => {
    void tick;
    return editor.dragging;
});
$effect(() => {
    document.getElementById("app")?.toggleAttribute("data-dragging", dragging);
});
// the snap readout hangs below the selected node, centered, clear of the manipulator knob ring BY
// CONSTRUCTION: a knob center orbits at RADIAL_R and its far edge reaches RADIAL_R + RADIAL_BTN_R,
// so the readout starts a gap past that — it can't overlap a knob wherever the heading swings the
// ring. Derived from the ring geometry, not a tuned number.
const RADIAL_BTN_R = 15; // `.rbtn` is 30px square → 15px radius (CSS)
const READOUT_GAP = 8; // clearance between the ring's far edge and the readout
const READOUT_OFFSET = RADIAL_R + RADIAL_BTN_R + READOUT_GAP; // node center → readout top (or bottom, flipped)

// append (extend the chain by a node) + trim (remove the trailing node). append is also the ring's
// extend button and Enter; trim is also Del. both are chain-end-only, so the node menu gates their
// enablement on the node being the chain end.
function doAdd(eid: number): void {
    select(extendTrack(history, ecs, Handle.section.get(eid)));
}
function doTrim(eid: number): void {
    const section = Handle.section.get(eid);
    if (trimTrack(history, ecs, section)) select(lastHandle(ecs, section));
}

// the two polar manipulator knobs — real DOM `.rbtn` buttons on the node-action ring (feel round 6),
// peers of the extend button they flank: the length knob (measure/ruler) at −60° off the heading, the
// angle knob (pitch/↕) at +60°. shown on EVERY singly-selected node (not just the chain end), hidden
// in tangent edit (its handles own the surface) and on a multi-set (the multi law). positions come
// from `manipKnobs` (controls.ts), the one home for the knob geometry, so a button sits exactly where
// its drag axis is anchored.
const manip = $derived.by(
    (): { length: { x: number; y: number }; angle: { x: number; y: number } } | null => {
        void tick;
        const eid = editor.selection;
        if (!canvas || eid === null || trackEid === null || editor.tangentEdit === eid) return null;
        if (nodeMulti()) return null;
        const s = samples.get(trackEid);
        if (!s) return null;
        const knobs = manipKnobs(ecs, s, viewTransform(canvas), eid);
        if (!knobs) return null;
        const length = knobs.find((k) => k.axis === "length");
        const angle = knobs.find((k) => k.axis === "angle");
        if (!length || !angle) return null;
        return { length: { x: length.x, y: length.y }, angle: { x: angle.x, y: angle.y } };
    },
);

// a knob button press enters the manipulator drag gesture (a drag, not a click — `startManip`
// captures the pointer on the canvas so the canvas's move/up handlers run it). preventDefault so the
// button doesn't steal focus or fire a click; a press-release without a drag moves nothing (the
// dead-zone). the drag itself — inverses, snap, readout — is unchanged.
function onManip(e: PointerEvent, axis: "length" | "angle"): void {
    if (e.button !== 0) return; // left button only — a right-click over a knob is a context menu, not a drag
    e.preventDefault();
    controls?.startManip(e, axis);
}

// the extend (add-node) button — a real DOM `.rbtn` on the ring's front slot (along the heading, where
// the next piece lays; feel round 12 restored it — double-clicking to append wasn't discoverable).
// shown only on the selected CHAIN-END node (append is chain-end-only, like the Enter key), hidden in
// tangent edit. positioned through the shared radial ring (`radial.ts`), the same one the knobs use.
const extendBtn = $derived.by((): { x: number; y: number } | null => {
    void tick;
    const eid = editor.selection;
    if (!canvas || eid === null || trackEid === null || editor.tangentEdit === eid) return null;
    if (nodeMulti()) return null; // the whole ring goes on a multi-set (Add stays, grayed, in the menu)
    if (Handle.order.get(eid) === 0) return null; // the entry anchor never extends
    const section = Handle.section.get(eid);
    if (eid !== lastHandle(ecs, section)) return null; // the chain end alone extends
    const s = samples.get(trackEid);
    if (!s || !sectionInfo.get(section)) return null; // unbaked section: no sample to anchor on
    const tx = viewTransform(canvas);
    const i = Handle.sample.get(eid);
    const base = ringBase(exitWorld(eid), tx.sx, tx.sy);
    const off = ringSlot(base, RadialSlot.Extend);
    return { x: tx.ox + s.posX[i] * tx.sx + off.x, y: tx.oy + s.posY[i] * tx.sy + off.y };
});

// the extend button click → append a node at the chain end (Enter's twin), selecting the new node.
function onExtend(): void {
    const eid = editor.selection;
    if (eid !== null) doAdd(eid);
}

// the readout follows the selected node (the dragged node during a drag — a drag selects what it
// drags). its baked screen point (the same node→sample→screen path the radial cluster reads) is the
// anchor. null whenever there's no readout text, so the readout is absent then.
let readoutEl = $state<HTMLDivElement | undefined>(undefined);
let readoutXY = $state<{ x: number; y: number } | null>(null);
const readoutAnchor = $derived.by((): { x: number; y: number } | null => {
    void tick;
    if (snapText === null || !canvas || trackEid === null) return null;
    const eid = editor.selection;
    if (eid === null) return null;
    const s = samples.get(trackEid);
    if (!s) return null;
    const tx = viewTransform(canvas);
    const i = Handle.sample.get(eid);
    return { x: tx.ox + s.posX[i] * tx.sx, y: tx.oy + s.posY[i] * tx.sy };
});
// clamp/flip the rendered readout into the viewport (measured size → readoutFit), mirroring
// Menu.svelte's flyout fit: centered below the node, flipped above near the bottom, slid in at the
// left/right edges. an $effect (not a $derived) because it reads the element's box — a DOM size
// outside the reactive graph. the position it writes never changes that intrinsic size (nowrap),
// so there's no feedback loop.
$effect(() => {
    if (readoutAnchor === null || !readoutEl || !canvas) {
        readoutXY = null;
        return;
    }
    readoutXY = readoutFit(
        readoutAnchor,
        READOUT_OFFSET,
        { w: readoutEl.offsetWidth, h: readoutEl.offsetHeight },
        { w: canvas.clientWidth, h: canvas.clientHeight },
        DOCK_RESERVE,
    );
});

// the NODE context menu (Handles toggle + a Tangents ▸ submenu), opened by right-click on any
// pickable node (controls.ts → editor.openNodeMenu). its visibility DERIVES from the node still
// existing — like the section context menu derives from its subject — so any death path (undo,
// a delete, a programmatic edit) dismisses it, no per-path close call.
const nmenu = $derived.by((): { x: number; y: number; eid: number } | null => {
    void tick;
    const m = editor.nodeMenu;
    if (m === null || !nodeAlive(m.eid)) return null;
    return m;
});
$effect(() => {
    // clear the dangling target once the subject is gone (deriving stays side-effect-free).
    if (editor.nodeMenu !== null && nmenu === null) closeNodeMenu();
});
// whether the menu's target node is still a live handle (its subject exists).
function nodeAlive(eid: number): boolean {
    for (const e of ecs.query([Handle])) if (e === eid) return true;
    return false;
}
// the target node's displayed mode: a stored tangent's own mode, or `Aligned` for an inferred
// node (inference is aligned-shaped — collinear in/out — and there is never a no-mode state).
const nodeMode = $derived.by((): TangentMode => {
    void tick;
    const m = editor.nodeMenu;
    if (m === null) return TangentMode.Aligned;
    const tan = handleTangent(ecs, Handle.section.get(m.eid), Handle.order.get(m.eid));
    return tan ? tan.mode : TangentMode.Aligned;
});
// whether the target node carries a stored tangent — Reset's enablement (it's a no-op on a
// live-inferred node), the same structural move as the context menu's derived Delete. at a geo→geo
// boundary the tip and the coincident downstream node 0 are one node, so Reset is live when EITHER
// half carries a tangent (it clears both).
const nodeHasTangent = $derived.by((): boolean => {
    void tick;
    const m = editor.nodeMenu;
    if (m === null) return false;
    if (handleTangent(ecs, Handle.section.get(m.eid), Handle.order.get(m.eid)) !== undefined)
        return true;
    const stitch = stitchNode(ecs, m.eid);
    return stitch !== null && handleTangent(ecs, Handle.section.get(stitch), 0) !== undefined;
});
// whether the target node's handles are summoned (in tangent edit) — the Handles toggle's check.
const nodeEditing = $derived.by((): boolean => {
    void tick;
    const m = editor.nodeMenu;
    return m !== null && editor.tangentEdit === m.eid;
});
// whether the target node is its section's chain end (append + trim act only there — the Enter/Del
// keys' guard). the menu's Add/Delete items derive their enablement from this.
const nodeIsEnd = $derived.by((): boolean => {
    void tick;
    const m = editor.nodeMenu;
    return m !== null && m.eid === lastHandle(ecs, Handle.section.get(m.eid));
});
// whether the target chain-end node can be trimmed — a section keeps at least the two nodes it needs.
const nodeCanTrim = $derived.by((): boolean => {
    void tick;
    const m = editor.nodeMenu;
    return nodeIsEnd && m !== null && sectionHandles(ecs, Handle.section.get(m.eid)).length > 2;
});
// `nodeMulti()` (above) is the menu's multi fork too — a right-click keeps the set (openNodeMenu
// promotes the target to active), so Delete + the Tangents ▸ rows act on the whole set, single-subject
// rows (Add, Handles) gray out. single-select is the size-1 case (today's menu).
// whether the set is a Delete-able suffix run — a contiguous suffix of ONE section, excluding node 0,
// leaving ≥ 2 (the enablement predicate). the bulk Delete row grays out otherwise (never hidden).
const nodeSuffixOk = $derived.by((): boolean => {
    void tick;
    return suffixRun(nodeMembers(ecs), (sec) => sectionHandles(ecs, sec).length) !== null;
});
// whether ANY selected member carries a stored tangent — the bulk Reset's enablement (a no-op on an
// all-live set), the set analogue of `nodeHasTangent`.
const nodeSetHasTangent = $derived.by((): boolean => {
    void tick;
    for (const m of nodeMembers(ecs))
        if (handleTangent(ecs, m.section, m.order) !== undefined) return true;
    return false;
});
// the node menu as data (the shared MenuItem language): Add node / Delete node (chain-end-only, so
// enablement-gated — the menu is Delete's only pointer path, the ring carries no trash button), then
// a Handles toggle over a Tangents submenu (the three modes carry their `checked`; Reset carries its
// derived enablement, after a separator). node 0 (the entry anchor) is the exception — never
// appendable/trimmable, and its handle is a single free entry handle (no coupled in-side), so it
// carries NO Add/Delete and NO mode submenu: just Handles + Reset (back to the Auto C1 exit).
const nodeItems = $derived.by((): MenuItem[] => {
    const m = editor.nodeMenu;
    if (m === null) return [];
    const eid = m.eid;
    // a multi-selection: the bulk rows (the gray-never-hide law). Delete acts on the whole set iff
    // it's a valid suffix run (else grayed); Add + Handles are single-subject, so they gray out;
    // Tangents ▸ modes + Reset apply to every member in one entry. the mode `checked` reflects the
    // ACTIVE member (Blender active-only).
    if (nodeMulti()) {
        return [
            {
                label: "Delete",
                shortcut: "Del",
                danger: true,
                enabled: nodeSuffixOk,
                action: doDeleteSet,
            },
            { label: "Add", shortcut: "Enter", enabled: false },
            { separator: true },
            { label: "Handles", enabled: false },
            {
                label: "Tangents",
                children: [
                    {
                        label: "Mirror",
                        checked: nodeMode === TangentMode.Mirror,
                        action: () => pickModeSet(TangentMode.Mirror),
                    },
                    {
                        label: "Aligned",
                        checked: nodeMode === TangentMode.Aligned,
                        action: () => pickModeSet(TangentMode.Aligned),
                    },
                    {
                        label: "Free",
                        checked: nodeMode === TangentMode.Free,
                        action: () => pickModeSet(TangentMode.Free),
                    },
                    { separator: true },
                    { label: "Reset", enabled: nodeSetHasTangent, action: doResetSet },
                ],
            },
        ];
    }
    if (Handle.order.get(eid) === 0) {
        return [
            { label: "Handles", checked: nodeEditing, action: () => toggleHandles(eid) },
            { separator: true },
            { label: "Reset", enabled: nodeHasTangent, action: () => doReset(eid) },
        ];
    }
    return [
        {
            label: "Delete",
            shortcut: "Del",
            danger: true,
            enabled: nodeCanTrim,
            action: () => doTrim(eid),
        },
        { label: "Add", shortcut: "Enter", enabled: nodeIsEnd, action: () => doAdd(eid) },
        { separator: true },
        { label: "Handles", checked: nodeEditing, action: () => toggleHandles(eid) },
        {
            label: "Tangents",
            children: [
                {
                    label: "Mirror",
                    checked: nodeMode === TangentMode.Mirror,
                    action: () => pickMode(TangentMode.Mirror, eid),
                },
                {
                    label: "Aligned",
                    checked: nodeMode === TangentMode.Aligned,
                    action: () => pickMode(TangentMode.Aligned, eid),
                },
                {
                    label: "Free",
                    checked: nodeMode === TangentMode.Free,
                    action: () => pickMode(TangentMode.Free, eid),
                },
                { separator: true },
                { label: "Reset", enabled: nodeHasTangent, action: () => doReset(eid) },
            ],
        },
    ];
});

// Handles: the double-click tangent-edit toggle, reached from the menu — summon the node's
// handles, or peel them if already summoned.
function toggleHandles(eid: number): void {
    if (editor.tangentEdit === eid) exitTangentEdit();
    else enterTangentEdit(eid);
}

// set the target node's tangent mode as one undo entry (the move gesture's node snapshot carries
// the tangent). picking the checked mode on an inferred node is a no-op (it already displays as
// Aligned — no stamp). otherwise a live node is seeded from the arc rule first (continuous, no
// jump); Mirror/Aligned re-collinearize the vectors to honor the mode, Free just relabels.
function pickMode(target: TangentMode, eid: number): void {
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
}

// Reset: clear the node's tangent back to live (Auto inference resumes). one undo entry. at a
// geo→geo boundary tip the coincident downstream node-0 tangent is cleared in the same entry (the
// stitched "one node" view); everywhere else the stitch is null and it's a plain single-node reset.
function doReset(eid: number): void {
    resetTangents(history, ecs, eid, stitchNode(ecs, eid));
}

// the bulk node-menu actions over the whole selection set (one undo entry each). Delete trims the
// suffix run then prunes the selection to the surviving tip (the live-pruner answer — the destroyed
// eids leave the set here). Reset + the mode picks apply per member across the affected sections.
function doDeleteSet(): void {
    const run = suffixRun(nodeMembers(ecs), (sec) => sectionHandles(ecs, sec).length);
    if (run !== null && trimSuffix(history, ecs, run.section, run.k))
        select(lastHandle(ecs, run.section));
}
function doResetSet(): void {
    resetTangentsBulk(history, ecs, nodeMembers(ecs));
}
function pickModeSet(mode: TangentMode): void {
    setTangentModes(history, ecs, nodeMembers(ecs), mode);
}

// dismiss the node menu on any outside press or Escape (clicks on the menu pass through so
// its items act first). Escape peels just this menu layer (capture + stop, so controls.ts
// doesn't also exit tangent edit) — root ui.md's one-layer dismissal.
//
// the listeners are PERMANENT and gate on the live `editor.nodeMenu`, never on the reactive
// `nmenu`: `nmenu` derives through the per-RAF `tick`, so a lifetime bound to it outlives the
// logical close by at least a frame — and a capture-phase swallow that outlives its own layer
// eats the next Escape (the one meant to deselect the node) from a menu already closed.
onMount(() => {
    const onDown = (e: PointerEvent): void => {
        if (editor.nodeMenu === null) return;
        if ((e.target as HTMLElement | null)?.closest(".nodemenu")) return;
        closeNodeMenu();
    };
    const onEsc = (e: KeyboardEvent): void => {
        if (editor.nodeMenu === null || e.key !== "Escape") return;
        e.stopImmediatePropagation();
        closeNodeMenu();
    };
    window.addEventListener("pointerdown", onDown, { capture: true });
    window.addEventListener("keydown", onEsc, { capture: true });
    return () => {
        window.removeEventListener("pointerdown", onDown, { capture: true });
        window.removeEventListener("keydown", onEsc, { capture: true });
    };
});

// the section context menu (Convert / Delete), summoned by right-click on a clip or a
// viewport span (both call editor.openContext). rendered once here at the app root so it
// can float over both the viewport and the dock; positioned at the cursor (screen px).
// a summoned surface lives only as long as its subject (root ui.md): the menu's visibility
// DERIVES from its target section still existing, so any death path — Del, undo, a programmatic
// edit — dismisses it by derivation, no per-path close call. the effect below clears the stale
// target id once the subject is gone, so an undo that restores the same id can't resurrect it.
const ctx = $derived.by((): { x: number; y: number; section: number } | null => {
    void tick;
    const c = editor.context;
    if (c === null || sectionAt(ecs, c.section) === null) return null;
    return c;
});
$effect(() => {
    // kept out of the derivation (deriving stays side-effect-free): once the subject is gone,
    // clear the dangling target so a later reappearance of the id doesn't re-open the menu.
    if (editor.context !== null && ctx === null) closeContext();
});
const ctxKind = $derived.by((): SectionKind | null => {
    void tick;
    if (ctx === null) return null;
    return sections(ecs).find((s) => s.id === ctx.section)?.kind ?? null;
});
// the kind the convert flips TO — the label names the destination, not the toggle. single-subject
// (a mixed-kind SET has no shared destination, so the bulk row below is unlabeled).
const ctxTarget = $derived(ctxKind === SectionKind.Force ? "Geo" : "Force");
// whether the section selection is a multi-set — a right-click keeps the set (`openContext`
// promotes the target to active), so Delete + Convert act on the whole set. single-select is the
// size-1 case (today's menu).
const sectionMulti = $derived.by((): boolean => {
    void tick;
    return editor.sections.ids.size > 1;
});
// Delete is impossible when the set is EVERY section (the chain keeps at least one —
// `sectionsDeletable`, controls.ts, lifts `deleteSection`'s per-call floor to the set).
// enablement DERIVES from that state, the same structural move as the menu's visibility deriving
// from its subject existing: the disabled render is the UI truth, the handler guard is just
// defense in depth. the single-section case (`selected` = 1) reduces to today's `total > 1`.
const canDelete = $derived.by((): boolean => {
    void tick;
    return sectionsDeletable(editor.sections.ids.size, sections(ecs).length);
});
// whether the invoked solve is available on this selection (`sectionSolvable`, controls.ts): one
// geo section with a live bake. `convertGeo` THROWS on each of those, so this enablement is the
// gate, not a hint — and it grays rather than hides (the bulk-row law), so the row is discoverable
// on a force section and on a multi-set alike.
const canSolve = $derived.by((): boolean => {
    void tick;
    return sectionSolvable(editor.sections.ids.size, ctxKind, bakeLive(ecs));
});
// the context menu as data: one array of MenuItems, rendered by the shared menu language.
// single-select: Convert names the destination kind (today's row), Solve force is the invoked
// geo→force tool beside it (`canSolve`), Delete last. multi-select (Premiere multi-clip): Convert
// flips EVERY selected section's own kind — there's no shared destination to converge on
// (`convertSection` has no direction parameter, it just swaps a section's own kind), so the row
// reads generic; Solve force grays (a set has no single subject to solve); Delete carries the
// set-lifted enablement.
const ctxItems = $derived.by((): MenuItem[] => {
    if (ctx === null) return [];
    if (sectionMulti) {
        return [
            { label: "Convert", action: ctxConvertSet },
            { label: "Solve force", enabled: false },
            {
                label: "Delete",
                shortcut: "Del",
                danger: true,
                enabled: canDelete,
                action: ctxDeleteSet,
            },
        ];
    }
    return [
        { label: `Convert to ${ctxTarget}`, action: ctxConvert },
        { label: "Solve force", enabled: canSolve, action: ctxSolve },
        { label: "Delete", shortcut: "Del", danger: true, enabled: canDelete, action: ctxDelete },
    ];
});
function ctxConvert(): void {
    if (ctx === null) return;
    convertSection(history, ecs, ctx.section); // destructive, undoable
    closeContext();
}
// the ADDITIVE row beside it: solve this geo shape into the force section that reproduces it
// (`geoforce.ts`). the destructive Convert above is untouched — it stays the "reset to this kind's
// default" affordance, and this is the invoked tool. the menu closes first: the solve is modal, and
// its own surface owns the screen from here.
function ctxSolve(): void {
    if (ctx === null) return;
    const section = ctx.section;
    closeContext();
    void solve(section);
}
function ctxDelete(): void {
    if (ctx === null) return;
    // no explicit close: removing the section makes `ctx` derive null, so the menu dismisses
    // by subject existence (one mechanism) and the $effect clears the stale target id.
    if (removeSection(history, ecs, ctx.section)) selectSection(null);
}
// the bulk context-menu actions over the whole section set (one undo entry each) — the
// `doDeleteSet`/`doResetSet` analogue for sections.
function ctxConvertSet(): void {
    convertSections(history, ecs, [...editor.sections.ids]);
    closeContext();
}
function ctxDeleteSet(): void {
    if (removeSections(history, ecs, [...editor.sections.ids])) selectSection(null);
}
// dismiss the menu on any outside press or Escape (clicks on the menu itself pass through
// so its items can act before it closes). Escape peels just this menu layer (capture + stop,
// so controls.ts doesn't also clear the section selection the menu was summoned on) — root
// ui.md's one-layer dismissal, the same shape the node and force menus wear.
//
// the listeners are PERMANENT and gate on the live `editor.context`, never on the reactive
// `ctx`: `ctx` derives through the per-RAF `tick`, so a lifetime bound to it outlives the
// logical close by at least a frame — and a capture-phase swallow that outlives its own layer
// eats the next Escape (the one meant to deselect the section) from a menu already closed.
onMount(() => {
    const onDown = (e: PointerEvent): void => {
        if (editor.context === null) return;
        if ((e.target as HTMLElement | null)?.closest(".ctxmenu")) return;
        closeContext();
    };
    const onEsc = (e: KeyboardEvent): void => {
        if (editor.context === null || e.key !== "Escape") return;
        e.stopImmediatePropagation();
        closeContext();
    };
    window.addEventListener("pointerdown", onDown, { capture: true });
    window.addEventListener("keydown", onEsc, { capture: true });
    return () => {
        window.removeEventListener("pointerdown", onDown, { capture: true });
        window.removeEventListener("keydown", onEsc, { capture: true });
    };
});

// the modal's projected state, read through the per-RAF tick like the rest of `editor`. TWO
// PRIMITIVES, not the object: `editor.converting` is mutated in place per progress report, so a
// derived handing back that same reference compares `===` equal and the surface would never update.
// A string re-renders exactly when the text changes.
const solving = $derived.by((): boolean => {
    void tick;
    return editor.converting !== null;
});
const solveText = $derived.by((): string => {
    void tick;
    const c = editor.converting;
    // no total — the refinement discovers how many probes it needs, so a denominator would be
    // invented (convert.ts). the counts climbing IS the liveness signal.
    return c === null ? "" : `${c.phase} · ${c.keys} keys · ${c.probes} probes`;
});
// the transient readout, the same way: its text, and whether it's the failure register.
const noticeText = $derived.by((): string => {
    void tick;
    return editor.notice?.text ?? "";
});
const noticeBad = $derived.by((): boolean => {
    void tick;
    return editor.notice?.kind === "error";
});
// focus the dialog when it mounts, so `aria-modal` is honest and the first Tab lands inside it
// (the content is `inert`, so Cancel is the only thing left to reach). the element ref is what
// says it's mounted; nothing else writes focus while the gate is open.
let dialogEl = $state<HTMLDivElement | undefined>(undefined);
$effect(() => {
    dialogEl?.focus();
});

// the track START anchor (initial-speed handle): selectable in the viewport, it summons
// a v0 field popover at its screen point — the world origin under the camera. the anchor
// recomputes per tick (`startPos`), so it tracks a viewport pan/zoom; it holds still
// during the v0 scrub only because that gesture never moves the camera (root ui.md
// "nothing moves under its own gesture"), so no anchor-freeze is needed here.
const startSel = $derived.by((): boolean => {
    void tick;
    return editor.start;
});
const v0 = $derived.by((): number => {
    void tick;
    return trackEid === null ? 0 : Track.v0.get(trackEid);
});
const startPos = $derived.by((): { x: number; y: number } | null => {
    void tick;
    if (!canvas || trackEid === null) return null;
    const tx = viewTransform(canvas);
    return { x: tx.ox, y: tx.oy }; // the world origin's screen point (the START diamond)
});

const V0_SCRUB = 0.1; // m/s per px — the START field's label-scrub rate
// the v₀ field: a scrub handle (drag the label) + a typed input, each committing one
// undo entry (begin → set → commit). the label scrub rounds to the field's precision so
// the number never shows jitter.
function v0ScrubStart(e: PointerEvent): void {
    if (trackEid === null) return;
    const te = trackEid;
    e.preventDefault();
    const label = e.currentTarget as HTMLElement;
    beginDrag(label, e.pointerId);
    beginV0(te);
    let acc = Track.v0.get(te);
    const move = (ev: PointerEvent): void => {
        acc = Math.max(0, acc + ev.movementX * V0_SCRUB);
        setTrackV0(te, Math.round(acc * 10) / 10);
    };
    const up = (): void => {
        label.removeEventListener("pointermove", move);
        label.removeEventListener("pointerup", up);
        label.removeEventListener("pointercancel", up);
        commit(history);
    };
    label.addEventListener("pointermove", move);
    label.addEventListener("pointerup", up);
    // a cancelled pointer must still close the gesture (one gesture at a time).
    label.addEventListener("pointercancel", up);
}
function onV0Field(e: Event): void {
    if (trackEid === null) return;
    const val = Number.parseFloat((e.currentTarget as HTMLInputElement).value);
    if (!Number.isFinite(val)) return; // guard a cleared field
    beginV0(trackEid);
    setTrackV0(trackEid, val);
    commit(history);
}
// field keys: Enter commits (blur fires change); Escape reverts and blurs. after blur the
// window handler (controls.ts, skips inputs) takes the NEXT Escape to deselect the START.
function v0Keydown(e: KeyboardEvent, reset: string): void {
    const input = e.currentTarget as HTMLInputElement;
    if (e.key === "Enter") input.blur();
    else if (e.key === "Escape") {
        input.value = reset;
        input.blur();
    }
}
// dismiss the v0 popover on an outside press. canvas clicks route through controls (which
// re-picks the START or deselects); popover clicks keep it open.
$effect(() => {
    if (!startSel) return;
    const onDown = (e: PointerEvent): void => {
        const t = e.target as HTMLElement | null;
        if (t?.closest(".vtip") || t === canvas) return;
        selectStart(false);
    };
    window.addEventListener("pointerdown", onDown, { capture: true });
    return () => window.removeEventListener("pointerdown", onDown, { capture: true });
});
</script>

<!-- everything the modal blocks lives in here. `display: contents` so it adds no box and the
     layout is exactly as if the wrapper weren't there; `inert` while a solve runs takes pointer,
     focus, and activation from the whole subtree at once (the scrim below is its sibling, so it
     stays live). -->
<div class="content" inert={solving}>
    <!-- the shaping viewport. `.viewport` is its stable hook: the harness drives it by class, not
         by depth under `#app`, so wrapping it (the inert content) can't silently unhook it. -->
    <canvas class="viewport" bind:this={canvas}></canvas>

    <!-- the snap readout: the selected node's live metrics — its authored world exit heading (°) + the
         chord to the previous node (m), uniformly for a tip and an interior alike; a live drag feeds the
         same two through the gesture's own source (the Blender modal-transform readout). shown whenever a
         node is selected, centered below it, offset clear of the node-action ring's buttons by construction.
         rendered off-screen for one measure pass until `readoutFit` places it from the measured box. -->
    {#if readoutAnchor}
        <div
            class="snap-readout"
            bind:this={readoutEl}
            style={readoutXY
                ? `left: ${readoutXY.x}px; top: ${readoutXY.y}px;`
                : "left: -9999px; top: -9999px;"}
        >
            {snapText}
        </div>
    {/if}

    <!-- the two status surfaces, top-center: the standing infeasibility banner, and BELOW IT the
         transient readout a finished solve raises. each is anchored on its own (the readout's row is
         reserved, held whether or not the banner is up), so neither one appearing or clearing moves
         the other in either direction. -->
    {#if infeasible}
        <div class="warning" role="alert">
            <svg viewBox="0 0 16 16" aria-hidden="true">
                <path
                    d="M8 1 L15 14 L1 14 Z"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linejoin="round"
                />
                <path
                    d="M8 6 L8 10 M8 11.8 L8 12.3"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linecap="round"
                />
            </svg>
            <span>Insufficient velocity</span>
        </div>
    {/if}
    {#if noticeText}
        <div class="notice" class:bad={noticeBad} role="status">{noticeText}</div>
    {/if}

    <!-- the extend (add-node) button on the ring's front slot (feel round 12): a real `.rbtn` at the
         selected chain end, along the heading where the next piece lays. a click appends (Enter's twin);
         delete stays off the ring (Del key + node menu). -->
    {#if extendBtn}
        <button
            type="button"
            class="rbtn extend"
            title="Add node (Enter)"
            aria-label="Add node"
            style="left: {extendBtn.x}px; top: {extendBtn.y}px;"
            onclick={onExtend}
        >
            <!-- add node: a segment stub laying a new node (the filled dot) at the growing end. -->
            <svg viewBox="0 0 14 14" aria-hidden="true">
                <path
                    d="M2.5 11.5 L8.4 5.6"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                />
                <circle cx="10.3" cy="3.7" r="2.7" fill="currentColor" />
            </svg>
        </button>
    {/if}

    <!-- the two polar manipulator knobs — real `.rbtn` buttons on the node-action ring flanking the
         extend button (measure at −60°, pitch at +60°). a press enters the drag gesture (onManip →
         startManip), not a click. positioned absolutely at the shared-ring screen points, so
         hover/active/cursor come for free. -->
    {#if manip}
        <button
            type="button"
            class="rbtn manip manip-length"
            title="Length"
            aria-label="Length"
            style="left: {manip.length.x}px; top: {manip.length.y}px;"
            onpointerdown={(e) => onManip(e, "length")}
        >
            <!-- length: a ruler (bar + edge ticks) — drag to set the chord length to the previous node. -->
            <svg viewBox="0 0 14 14" aria-hidden="true">
                <rect
                    x="1.5"
                    y="4.4"
                    width="11"
                    height="5.2"
                    rx="0.6"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.4"
                />
                <path
                    d="M4.3 4.4 L4.3 6.6 M7 4.4 L7 6.6 M9.7 4.4 L9.7 6.6"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linecap="round"
                />
            </svg>
        </button>
        <button
            type="button"
            class="rbtn manip manip-angle"
            title="Pitch"
            aria-label="Pitch"
            style="left: {manip.angle.x}px; top: {manip.angle.y}px;"
            onpointerdown={(e) => onManip(e, "angle")}
        >
            <!-- angle/pitch: a double-headed vertical arrow (↕) — drag to rotate the node about the previous. -->
            <svg viewBox="0 0 14 14" aria-hidden="true">
                <path
                    d="M7 1.6 L7 12.4 M4.3 4.3 L7 1.6 L9.7 4.3 M4.3 9.7 L7 12.4 L9.7 9.7"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                />
            </svg>
        </button>
    {/if}

    <!-- the node context menu (Handles toggle + a Tangents ▸ submenu): summoned by right-click on
         any pickable node, an instance of the shared menu language (Menu.svelte) placed at the cursor
         by `fitMenu` — its top-left at the point (never covering the invoker), flipping up/left to
         stay in the viewport near an edge — the same look + placement as the section context menu. -->
    {#if nmenu}
        <div class="nodemenu menu" use:fitMenu={{ x: nmenu.x, y: nmenu.y }} role="menu" aria-label="Node">
            <Menu items={nodeItems} onclose={closeNodeMenu} />
        </div>
    {/if}

    <!-- the section context menu (Convert / Delete): summoned by right-click on a clip or a
         viewport section span; occasional destructive ops, so hidden until summoned. Convert
         is a single contextual item naming the target kind (a section is one of two kinds, so
         the flip is unambiguous) — one click, no submenu. -->
    {#if ctx}
        <div class="ctxmenu menu" use:fitMenu={{ x: ctx.x, y: ctx.y }} role="menu">
            <Menu items={ctxItems} onclose={closeContext} />
        </div>
    {/if}

    <!-- the track START anchor's initial-speed field: a popover summoned AT the diamond (on
         the object). one row — the v₀ label doubles as a scrub handle, the input types it;
         each edit is one undo entry. -->
    {#if startSel && startPos}
        {@const vText = v0.toFixed(1)}
        <div class="vtip" style="left: {startPos.x}px; top: {startPos.y}px">
            <div class="fld">
                <span class="key" onpointerdown={v0ScrubStart} role="presentation">v₀</span>
                <input
                    type="number"
                    step="0.5"
                    min="0"
                    value={vText}
                    onchange={onV0Field}
                    onfocus={(e) => e.currentTarget.select()}
                    onkeydown={(e) => v0Keydown(e, vText)}
                    aria-label="Initial speed (m/s)"
                />
                <span class="unit">m/s</span>
            </div>
        </div>
    {/if}

    <Timeline {ecs} eid={trackEid} {tick} />
</div>

<!-- the conversion modal, OUTSIDE the inert wrapper: up for the whole solve, and the only live
     control while it is. the scrim takes every pointer (it covers the canvas AND the dock) and
     swallows the native context menu; keys and focus are handled in the script / by `inert`. the
     counts climb per probe — no bar, because the refinement has no total to divide by. -->
{#if solving}
    <div class="scrim" role="presentation" oncontextmenu={(e) => e.preventDefault()}>
        <!-- `aria-live="off"`: a probe lands several times a second and hundreds of times at
             stress scale, so announcing each one would be a stream, not information. The dialog's
             own label carries the state. -->
        <div
            class="convert"
            role="dialog"
            aria-modal="true"
            aria-label="Solving force"
            tabindex="-1"
            bind:this={dialogEl}
        >
            <div class="title">Solving force</div>
            <div class="stat" aria-live="off">{solveText}</div>
            <button type="button" class="cancel" title="Cancel (Esc)" onclick={cancelSolve}>
                Cancel
            </button>
        </div>
    </div>
{/if}

<style>
    :root,
    :global(:root) {
        --bg-solid: #161413;
        --fg: #f0ece8;
        --muted: #a09890;
        --accent: #d49560;
        --accent-soft: rgba(212, 149, 96, 0.18);
        --geo: #78a5d6; /* geo-section kind color (viewport polyline + clip strip); force's is --accent */
        /* selection = a brighter, still-saturated OKLCH variant of the element's own kind
           color (the Ableton/Premiere clip idiom); the relative-color twin of colors.ts
           `selected()` — lift L, boost C, hold hue (an sRGB white-mix would drain chroma). */
        --geo-sel: oklch(from var(--geo) calc(l + 0.14) calc(c * 1.15) h);
        --accent-sel: oklch(from var(--accent) calc(l + 0.14) calc(c * 1.15) h);
        --pin: #ece8e3; /* authored force-pin marker (light, not accent) */
        --neutral: #b8b1a8; /* chrome: player icon, slider fill/thumb */
        --neutral-soft: rgba(255, 255, 255, 0.1);
        --danger: #e26d5c;
        --danger-soft: rgba(226, 109, 92, 0.16);
        --guide: #9aa0a6; /* snap-guide neutral gray (timeline + viewport); mirrors colors.ts COLOR_GUIDE_RAY */
        --border: rgba(255, 255, 255, 0.08);
        --shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
    }

    /* the modal's inert subject. `display: contents` generates no box, so it is neither a
       containing block nor a layout participant — every child positions exactly as it did before
       the wrapper existed. */
    .content {
        display: contents;
    }

    canvas {
        display: block;
        width: 100%;
        height: 100%;
        cursor: default;
    }

    /* hover suppression while a drag is in flight (see Timeline.svelte): `data-dragging` on
       the app root kills pointer-events on this component's hoverable chrome too, so a node
       drag sweeping over the radial buttons / a summoned menu doesn't flash their `:hover`.
       the dragged surface holds pointer capture, so it's unaffected. */
    :global([data-dragging]) .rbtn,
    :global([data-dragging]) .ctxmenu,
    :global([data-dragging]) .nodemenu,
    :global([data-dragging]) .vtip {
        pointer-events: none;
        user-select: none;
    }

    /* the snap readout: the selected node's live metrics, positioned per-frame below the node by
       `readoutFit` (left/top set inline). shown whenever a node is selected; JetBrains Mono over the
       same opaque chrome as the cluster, the neutral text at `--fg`. pointer-inert — a readout,
       never a target. */
    .snap-readout {
        position: absolute;
        z-index: 2;
        padding: 3px 8px;
        background: var(--bg-solid);
        border: 1px solid var(--border);
        border-radius: 5px;
        box-shadow: var(--shadow);
        font-family: "JetBrains Mono", ui-monospace, monospace;
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        color: var(--fg);
        white-space: nowrap;
        pointer-events: none;
    }
    /* the two status surfaces are anchored INDEPENDENTLY, top-center: the banner on the first row,
       the transient readout on a reserved second row (`NOTICE_TOP` = the banner's own height plus
       the gap). Stacking them in one flow column would have made the banner appearing shove a
       readout mid-sentence — status shifts nothing beside it, in either direction (root ui.md). */
    .warning {
        position: absolute;
        top: 16px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 4;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        background: rgba(226, 109, 92, 0.12);
        border: 1px solid rgba(226, 109, 92, 0.5);
        border-radius: 999px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(6px);
        font-family: "Outfit", system-ui, sans-serif;
        font-size: 12px;
        color: #f0bdb1;
        user-select: none;
        pointer-events: none;
    }
    .warning svg {
        width: 14px;
        height: 14px;
        color: #e26d5c;
    }
    /* the transient solve readout (root ui.md's transient outcome): the same opaque chrome as the
       rest, auto-dismissed, on its own reserved row under the banner. It carries a SENTENCE on a
       failure, so it wraps inside a bounded width rather than running off both viewport edges —
       and a wrapped pill reads broken, hence the plain radius. `.bad` is the failure register,
       the one semantic color, matching the banner. */
    .notice {
        position: absolute;
        top: 57px; /* 16px inset + the banner's 27px box + an 8px gap and + 6px vertical padding */
        left: 50%;
        transform: translateX(-50%);
        z-index: 4;
        max-width: min(520px, 80vw);
        padding: 6px 12px;
        background: var(--bg-solid);
        border: 1px solid var(--border);
        border-radius: 6px;
        box-shadow: var(--shadow);
        font-family: "Outfit", system-ui, sans-serif;
        font-size: 12px;
        text-align: center;
        color: var(--fg);
        user-select: none;
        pointer-events: none;
        animation: fade-in 120ms ease;
    }
    .notice.bad {
        border-color: rgba(226, 109, 92, 0.5);
        color: #f0bdb1;
    }
    /* the shared entrance for the surfaces that just appear (readout, scrim) — no travel, so it
       reads as arriving rather than sliding. */
    @keyframes fade-in {
        from {
            opacity: 0;
        }
    }

    /* the conversion modal. the scrim is the pointer half of the input block (the key half is the
       capture-phase swallow in the script): it covers the canvas and the dock, so nothing under it
       is reachable while a solve runs. */
    .scrim {
        position: fixed;
        inset: 0;
        z-index: 20;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.45);
        animation: fade-in 120ms ease;
    }
    .convert {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        min-width: 240px;
        padding: 16px 20px;
        background: var(--bg-solid);
        border: 1px solid var(--border);
        border-radius: 6px;
        box-shadow: var(--shadow);
        font-family: "Outfit", system-ui, sans-serif;
        user-select: none;
    }
    .convert .title {
        font-size: 12px;
        color: var(--fg);
    }
    /* the live counts: monospace + tabular figures so a climbing probe count doesn't jitter the
       row's width. */
    .convert .stat {
        font-family: "JetBrains Mono", ui-monospace, monospace;
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        color: var(--muted);
    }
    .convert .cancel {
        all: unset;
        box-sizing: border-box;
        padding: 5px 14px;
        border: 1px solid var(--border);
        border-radius: 4px;
        font-size: 11px;
        color: var(--muted);
        cursor: pointer;
        transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
    }
    .convert .cancel:hover {
        background: var(--accent-soft);
        border-color: var(--accent);
        color: var(--fg);
    }

    /* the round `.rbtn` button — the dark shell every ring affordance wears (the two manipulator
       knobs + the extend button). positioned absolutely at its ring screen point (left/top
       inline). */
    .rbtn {
        all: unset;
        position: absolute;
        left: 0;
        top: 0;
        box-sizing: border-box;
        width: 30px;
        height: 30px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        background: var(--bg-solid);
        border: 1px solid var(--border);
        box-shadow: var(--shadow);
        cursor: pointer;
        pointer-events: auto;
        transition: background 120ms ease, border-color 120ms ease;
    }
    .rbtn svg {
        width: 14px;
        height: 14px;
    }
    /* the extend (add-node) button: a `.rbtn` at the ring's front slot, positioned absolutely
       (left/top inline) and centered on it. accent-lit with a hover wash — a click, so the default
       pointer cursor. */
    .rbtn.extend {
        color: var(--accent);
        transform: translate(-50%, -50%);
    }
    .rbtn.extend:hover {
        background: var(--accent-soft);
        border-color: var(--accent);
    }
    /* the two polar manipulator knobs: `.rbtn` shells positioned absolutely at their ring screen
       point (left/top inline) and centered on it. accent-lit, with a hover wash — the hover/active
       states the canvas-drawn knobs lacked (feel round 6). the grab affordance is a move cursor:
       these initiate a drag. */
    .rbtn.manip {
        color: var(--accent);
        transform: translate(-50%, -50%);
        cursor: grab;
        touch-action: none; /* the pointerdown drives a pointer drag, not a scroll/zoom gesture */
    }
    .rbtn.manip:hover {
        background: var(--accent-soft);
        border-color: var(--accent);
    }
    .rbtn.manip:active {
        cursor: grabbing;
    }
    /* the node context menu: an instance of the shared `.menu` language at the cursor (the same
       fixed-position context-menu placement as .ctxmenu). min-width so the rows + check + the
       submenu marker don't jostle; its own entrance fade, matched to the section context menu. */
    .nodemenu {
        position: fixed;
        z-index: 10;
        min-width: 132px;
        animation: ctx-in 120ms ease;
    }
    /* the current-mode row: accent-lit like every other active state; the trailing check is the
       colorblind-safe second channel (shape, not color alone — root ui.md). */
    :global(.menu-item.checked),
    :global(.menu-item.checked:hover) {
        color: var(--accent);
    }
    :global(.menu-item .tick) {
        color: var(--accent);
        font-size: 10px;
    }

    /* the shared menu language (root ui.md one-language): the append flyout's standard menu
       look, lifted to a global class so the section context menu and the flyout are two
       instances of ONE style — opaque surface, quiet muted rows, an accent-soft hover wash.
       each instance adds only its own position, width, and entrance animation.
       `overflow: visible` so a submenu flyout (a child positioned at left:100%) can escape the
       box; the rounded-corner row-wash clip is restored on the inner `.menu-rows` wrapper
       (Menu.svelte), which the flyout is hoisted out of. */
    :global(.menu) {
        display: flex;
        flex-direction: column;
        background: var(--bg-solid);
        border: 1px solid var(--border);
        border-radius: 5px;
        box-shadow: var(--shadow);
        overflow: visible;
        font-family: "Outfit", system-ui, sans-serif;
        font-size: 11px;
        user-select: none;
        -webkit-user-select: none;
    }
    :global(.menu-item) {
        all: unset;
        box-sizing: border-box;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 5px 10px;
        color: var(--muted);
        cursor: pointer;
        transition: background 120ms ease, color 120ms ease;
    }
    :global(.menu-item:not(:disabled):hover) {
        background: var(--accent-soft);
        color: var(--fg);
    }
    /* a disabled row: its action isn't possible right now (enablement derived from editor
       state). standard menu UX — still visible, dimmed, default cursor, no hover wash. the
       opacity dims label, shortcut, and any danger tint uniformly. */
    :global(.menu-item:disabled) {
        opacity: 0.4;
        cursor: default;
    }
    /* the destructive row: a red text tint (the danger token, the only semantic color), held
       on hover while the row wash matches every other item. */
    :global(.menu-item.danger),
    :global(.menu-item.danger:hover) {
        color: var(--danger);
    }
    /* an inline shortcut hint, right-aligned by the row's space-between. */
    :global(.menu-item .sk) {
        font-family: "JetBrains Mono", ui-monospace, monospace;
        font-size: 10px;
        color: var(--muted);
    }

    /* the section context menu: an instance of `.menu` at the cursor — only its fixed
       position, width, and entrance are its own. */
    .ctxmenu {
        position: fixed;
        z-index: 10;
        min-width: 132px;
        animation: ctx-in 120ms ease;
    }
    @keyframes ctx-in {
        from {
            opacity: 0;
            transform: translateY(-2px);
        }
    }

    /* the START anchor's initial-speed popover: the same floating-field surface as the
       timeline point popover (opaque, one row — scrub-handle key · value · unit, no boxed
       input), anchored above the START diamond. */
    .vtip {
        position: absolute;
        z-index: 3;
        display: flex;
        flex-direction: column;
        padding: 3px 0;
        background: var(--bg-solid);
        border: 1px solid var(--border);
        border-radius: 5px;
        box-shadow: var(--shadow);
        overflow: hidden; /* the focus wash clips to the rounded corners */
        transform: translate(-50%, calc(-100% - 12px));
        font-family: "JetBrains Mono", ui-monospace, monospace;
        animation: vtip-in 120ms ease;
    }
    @keyframes vtip-in {
        from {
            opacity: 0;
        }
    }
    .vtip .fld {
        display: grid;
        grid-template-columns: 18px 44px auto;
        align-items: center;
        gap: 6px;
        padding: 4px 9px;
        font-size: 11px;
        transition: background 120ms ease;
    }
    .vtip .fld:focus-within {
        background: rgba(255, 255, 255, 0.04);
    }
    /* the key doubles as the scrub handle (the shallot cell-handle treatment): a
       full-row-height cell whose hit area extends left to the row edge, ew-resize + wash on
       hover. the label centers within that whole extended box (no padding), so the glyph sits
       at the wash's centre rather than reading as right-aligned when hovered. */
    .vtip .key {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        align-self: stretch;
        margin: -4px 0 -4px -9px;
        padding: 4px 0;
        color: var(--muted);
        cursor: ew-resize;
        user-select: none;
        -webkit-user-select: none;
        touch-action: none;
        transition: color 120ms ease, background 120ms ease;
    }
    .vtip .key:hover {
        color: var(--fg);
        background: rgba(255, 255, 255, 0.05);
    }
    .vtip .fld:focus-within .key {
        color: var(--fg);
    }
    .vtip .unit {
        color: var(--muted);
    }
    .vtip input {
        width: 44px;
        box-sizing: border-box;
        padding: 0;
        background: none;
        border: none;
        outline: none;
        color: var(--fg);
        font: inherit;
        font-variant-numeric: tabular-nums;
        text-align: right;
        appearance: textfield; /* no native spinner chrome; arrow keys still step */
    }
    .vtip input::-webkit-outer-spin-button,
    .vtip input::-webkit-inner-spin-button {
        -webkit-appearance: none;
        margin: 0;
    }
    .vtip input::selection {
        background: var(--accent-soft);
    }

</style>
