import type { State } from "@dylanebert/shallot";
import {
    editor,
    openContext,
    select,
    selectSection,
    selectStart,
    snapActive,
    toggleSnap,
} from "./editor";
import {
    appendSection,
    beginMove,
    cancel,
    commit,
    extendTrack,
    history,
    removeSection,
    trimTrack,
} from "./history";
import { localize } from "./section";
import { snap } from "./timeline";
import {
    Handle,
    lastHandle,
    reheadOnDrag,
    samples,
    SectionKind,
    sectionInfo,
    sections,
    Track,
} from "./track";
import {
    camera,
    frameContent,
    panCamera,
    pointerToCanvas,
    screenToWorld,
    snapGuides,
    viewTransform,
    type ViewTx,
    zoomAt,
} from "./view";

const PICK_R = 16;
const SECTION_PICK_R = 12;
const START_PICK_R = 12;

// wheel zoom rate: screen-px-independent, exp(−deltaY·rate) so scaling is symmetric
// (in then out returns to the same zoom) and reads the same for wheel + trackpad pinch
// (which arrives as ctrl+wheel, the browser convention).
const WHEEL_ZOOM_RATE = 0.0015;

// arrow-nudge steps, in screen px (converted to world through the live zoom, so the nudge
// is a fixed on-screen distance at any zoom — the AE convention). Shift is the coarse step.
const NUDGE_PX = 2;
const NUDGE_PX_COARSE = 20;

let dragNode: number | null = null;
// grab offset (world): the node−under−cursor delta captured at pointerdown, so the
// node tracks the cursor relatively (grabbing slightly off-center doesn't snap it).
let grabX = 0;
let grabY = 0;
// the grab anchor for the drag: the cursor screen point + the node's world pose at
// pointerdown. the screen point measures the dominant axis for a Shift constrain; the
// world pose is the value the held (constrained) axis snaps back to.
let grabCX = 0;
let grabCY = 0;
let grabWX = 0;
let grabWY = 0;

// middle-drag pan state: the last canvas point, so each move pans by its screen delta.
let panning = false;
let panX = 0;
let panY = 0;

/** the single track's sample buffers (one track in this prototype). */
function trackSamples(ecs: State): ReturnType<typeof samples.get> {
    for (const trackEid of ecs.query([Track])) return samples.get(trackEid);
    return undefined;
}

/** a node's world position — the baked sample it lands on (nodes are stored
 *  section-local; the bake places them, so world lives in `samples`). */
function nodeWorld(
    s: NonNullable<ReturnType<typeof samples.get>>,
    eid: number,
): {
    x: number;
    y: number;
} {
    const i = Handle.sample.get(eid);
    return { x: s.posX[i], y: s.posY[i] };
}

/** nearest **draggable** node to the screen point, within the pick radius, or null.
 *  node 0 of every section is the entry anchor (pinned), so it isn't pickable. */
function pickNode(ecs: State, tx: ViewTx, sx: number, sy: number): number | null {
    const s = trackSamples(ecs);
    if (!s) return null;
    let bestEid: number | null = null;
    let bestD2 = PICK_R * PICK_R;
    for (const eid of ecs.query([Handle])) {
        if (Handle.order.get(eid) === 0) continue; // the entry anchor is not draggable
        const w = nodeWorld(s, eid);
        const dx = sx - (tx.ox + w.x * tx.sx);
        const dy = sy - (tx.oy + w.y * tx.sy);
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
            bestD2 = d2;
            bestEid = eid;
        }
    }
    return bestEid;
}

/** the section whose baked polyline passes nearest the screen point (within the pick
 *  radius), or null — clicking the track between nodes selects its section (the
 *  whole-section handle for convert / delete). */
function pickSection(ecs: State, tx: ViewTx, sx: number, sy: number): number | null {
    const s = trackSamples(ecs);
    if (!s) return null;
    let best: number | null = null;
    let bestD2 = SECTION_PICK_R * SECTION_PICK_R;
    for (const sec of sections(ecs)) {
        const info = sectionInfo.get(sec.id);
        if (!info) continue;
        for (let i = info.startSample; i <= info.endSample; i++) {
            const dx = sx - (tx.ox + s.posX[i] * tx.sx);
            const dy = sy - (tx.oy + s.posY[i] * tx.sy);
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2) {
                bestD2 = d2;
                best = sec.id;
            }
        }
    }
    return best;
}

/** true when the screen point hits the track START anchor. START is the first
 *  section's entry — sample 0, the world origin the diamond draws at (`AnchorDrawSystem`)
 *  — so this tests the pick radius against that sample regardless of the section's kind. */
function pickStart(ecs: State, tx: ViewTx, sx: number, sy: number): boolean {
    const s = trackSamples(ecs);
    if (!s) return false;
    const dx = sx - (tx.ox + s.posX[0] * tx.sx);
    const dy = sy - (tx.oy + s.posY[0] * tx.sy);
    return dx * dx + dy * dy < START_PICK_R * START_PICK_R;
}

/** true when the selection is its section's chain end — the node `extend` / `delete`
 *  act on. */
function endSelected(ecs: State): boolean {
    const sel = editor.selection;
    if (sel === null) return false;
    return sel === lastHandle(ecs, Handle.section.get(sel));
}

/** the screen-space x and y of every OTHER node (all sections' handles + entry anchors),
 *  the neighbor-axis alignment targets for a node drag — snap the dragged node's screen x
 *  to a neighbor's x, its y to a neighbor's y (the Figma alignment magnet). */
function neighborTargets(ecs: State, tx: ViewTx, dragEid: number): { xs: number[]; ys: number[] } {
    const xs: number[] = [];
    const ys: number[] = [];
    const s = trackSamples(ecs);
    if (!s) return { xs, ys };
    for (const eid of ecs.query([Handle])) {
        if (eid === dragEid) continue;
        const i = Handle.sample.get(eid);
        xs.push(tx.ox + s.posX[i] * tx.sx);
        ys.push(tx.oy + s.posY[i] * tx.sy);
    }
    return { xs, ys };
}

/** the baked-sample range `F` frames: the selected section (or the selected node's
 *  section) if there is a selection, else the whole track — the Blender frame-content
 *  rule (frame the selection, or everything when nothing is selected). */
function frameRange(ecs: State): [number, number] | null {
    const secId =
        editor.section ?? (editor.selection !== null ? Handle.section.get(editor.selection) : null);
    if (secId !== null) {
        const info = sectionInfo.get(secId);
        if (info) return [info.startSample, info.endSample];
    }
    for (const trackEid of ecs.query([Track])) {
        const count = Track.count.get(trackEid);
        if (count >= 1) return [0, count - 1];
    }
    return null;
}

/** frame the viewport camera to the selection (or the whole track) — the `F` key. */
function frameViewport(ecs: State, canvas: HTMLCanvasElement): void {
    const s = trackSamples(ecs);
    const range = frameRange(ecs);
    if (!s || !range) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = range[0]; i <= range[1]; i++) {
        if (s.posX[i] < minX) minX = s.posX[i];
        if (s.posX[i] > maxX) maxX = s.posX[i];
        if (s.posY[i] < minY) minY = s.posY[i];
        if (s.posY[i] > maxY) maxY = s.posY[i];
    }
    if (!Number.isFinite(minX)) return;
    Object.assign(
        camera,
        frameContent(canvas.clientWidth, canvas.clientHeight, { minX, minY, maxX, maxY }),
    );
}

/** write a dragged node's section-local position from a world target — `localize`
 *  against the node's section entry (identity for the first section). */
function dragTo(ecs: State, eid: number, worldX: number, worldY: number): void {
    const entry = sectionInfo.get(Handle.section.get(eid))?.entry;
    if (!entry) return;
    const local = localize(entry, { x: worldX, y: worldY, theta: 0 });
    Handle.pos.set(eid, local.x, local.y);
    reheadOnDrag(ecs, eid);
}

/** wire canvas pointer + window keyboard handling, returning a teardown. tied to
 *  the canvas lifecycle (called from App's onMount) so listeners attach with the
 *  element and detach with it — no module-flag staleness across reloads. */
export function attachControls(canvas: HTMLCanvasElement, ecs: State): () => void {
    const onContextMenu = (e: MouseEvent): void => {
        e.preventDefault(); // suppress the browser menu; ours takes over
        const { x: cx, y: cy } = pointerToCanvas(canvas, e);
        const tx = viewTransform(canvas);
        const sec = pickSection(ecs, tx, cx, cy);
        if (sec !== null) openContext(e.clientX, e.clientY, sec); // right-click a section span → menu
    };

    const onPointerDown = (e: PointerEvent): void => {
        // middle-drag pans the viewport — the same gesture the timeline uses (one
        // vocabulary). left picks/drags; right owns the section context menu. pan and
        // node-drag are mutually exclusive: refuse to start one while the other is live,
        // so a second button press can't leak pointer capture or an open history gesture.
        if (e.button === 1) {
            if (dragNode !== null) return;
            e.preventDefault();
            const { x, y } = pointerToCanvas(canvas, e);
            panning = true;
            panX = x;
            panY = y;
            canvas.style.cursor = "grabbing"; // grab affordance while panning (Blender/AE)
            canvas.setPointerCapture(e.pointerId);
            return;
        }
        if (e.button !== 0 || panning) return;
        const { x: cx, y: cy } = pointerToCanvas(canvas, e);
        const tx = viewTransform(canvas);
        const { x: wx, y: wy } = screenToWorld(tx, cx, cy);

        // a node to drag takes priority; else select the section under the click; else
        // deselect (Figma-style).
        const eid = pickNode(ecs, tx, cx, cy);
        if (eid !== null) {
            select(eid);
            dragNode = eid;
            const s = trackSamples(ecs);
            const w = s ? nodeWorld(s, eid) : { x: wx, y: wy };
            grabX = w.x - wx;
            grabY = w.y - wy;
            grabCX = cx;
            grabCY = cy;
            grabWX = w.x;
            grabWY = w.y;
            beginMove(ecs, Handle.section.get(eid)); // open the drag gesture; commit/cancel on release
            canvas.setPointerCapture(e.pointerId);
            return;
        }
        // the START anchor (initial-speed handle) before the section span it sits on —
        // both pass through the origin, so the on-object handle wins.
        if (pickStart(ecs, tx, cx, cy)) {
            selectStart(true);
            return;
        }
        const sec = pickSection(ecs, tx, cx, cy);
        if (sec !== null) {
            selectSection(sec);
            return;
        }
        select(null);
        selectSection(null);
        selectStart(false);
    };

    const onPointerMove = (e: PointerEvent): void => {
        if (panning) {
            const { x, y } = pointerToCanvas(canvas, e);
            Object.assign(camera, panCamera(camera, x - panX, y - panY));
            panX = x;
            panY = y;
            return;
        }
        if (dragNode === null) return;
        const { x: cx, y: cy } = pointerToCanvas(canvas, e);
        const tx = viewTransform(canvas);
        const { x: wx, y: wy } = screenToWorld(tx, cx, cy);
        let tgtX = wx + grabX;
        let tgtY = wy + grabY;
        // Shift constrains to the dominant axis since the grab (the AE/Photoshop rule,
        // already live for timeline force points); the held axis snaps back to the grab
        // pose. re-evaluated live — no hysteresis.
        let lockX = false;
        let lockY = false;
        if (e.shiftKey) {
            if (Math.abs(cx - grabCX) >= Math.abs(cy - grabCY)) {
                tgtY = grabWY;
                lockY = true;
            } else {
                tgtX = grabWX;
                lockX = true;
            }
        }
        // neighbor-axis alignment magnet (Figma): snap each free axis to a neighboring
        // node's screen x / y within SNAP_PX, flashing a world-axis guide at the hit.
        snapGuides.x = null;
        snapGuides.y = null;
        if (snapActive(e.ctrlKey || e.metaKey)) {
            const { xs, ys } = neighborTargets(ecs, tx, dragNode);
            if (!lockX) {
                const hit = snap(tx.ox + tgtX * tx.sx, xs);
                if (hit !== null) {
                    tgtX = (hit - tx.ox) / tx.sx;
                    snapGuides.x = tgtX;
                }
            }
            if (!lockY) {
                const hit = snap(tx.oy + tgtY * tx.sy, ys);
                if (hit !== null) {
                    tgtY = (hit - tx.oy) / tx.sy;
                    snapGuides.y = tgtY;
                }
            }
        }
        dragTo(ecs, dragNode, tgtX, tgtY);
    };

    // wheel = zoom-at-cursor; trackpad pinch arrives as ctrl+wheel (browser convention)
    // and zooms the same way. preventDefault stops the page from scrolling/zooming under
    // it (needs a non-passive listener). deltaY is normalized to px — Firefox reports
    // line/page deltas (deltaMode 1/2), which would otherwise zoom imperceptibly.
    const onWheel = (e: WheelEvent): void => {
        e.preventDefault();
        const { x, y } = pointerToCanvas(canvas, e);
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1;
        Object.assign(camera, zoomAt(camera, x, y, Math.exp(-e.deltaY * unit * WHEEL_ZOOM_RATE)));
    };

    // suppress the middle-click autoscroll ring (fired on mousedown, not the pointer event).
    const onMouseDown = (e: MouseEvent): void => {
        if (e.button === 1) e.preventDefault();
    };

    const endDrag = (e: PointerEvent): void => {
        if (panning) {
            panning = false;
            canvas.style.cursor = "";
            if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
            return;
        }
        if (dragNode === null) return;
        dragNode = null;
        snapGuides.x = null;
        snapGuides.y = null;
        commit(history); // one drag → one undo entry (a no-move click records nothing)
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };

    const cancelDrag = (e: PointerEvent): void => {
        if (panning) {
            panning = false;
            canvas.style.cursor = "";
            if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
            return;
        }
        if (dragNode === null) return;
        dragNode = null;
        snapGuides.x = null;
        snapGuides.y = null;
        cancel(); // interrupted drag: restore the pre-gesture pose
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };

    const onKeyDown = (e: KeyboardEvent): void => {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

        // toggle the snapping magnet — a global editor preference (the AE `S` key). guard
        // the modifier case: Ctrl/Cmd is the snap BYPASS modifier everywhere else, and
        // Ctrl/Cmd+S is the browser save reflex — neither should flip the toggle.
        if ((e.key === "s" || e.key === "S") && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            toggleSnap();
            return;
        }

        // frame content (Unity/Blender `F`): fit the selection, or the whole track when
        // nothing is selected. guard Ctrl/Cmd+F (the browser find reflex) and mid-drag.
        if ((e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            if (dragNode === null && !panning) frameViewport(ecs, canvas);
            return;
        }

        // arrow-nudge the selected node (AE): a fixed on-screen step in world space, Shift
        // for the coarse step. one press = one undo entry (holding auto-repeats to many).
        if (
            editor.selection !== null &&
            (e.key === "ArrowLeft" ||
                e.key === "ArrowRight" ||
                e.key === "ArrowUp" ||
                e.key === "ArrowDown")
        ) {
            const eid = editor.selection;
            const s = trackSamples(ecs);
            if (dragNode !== null || panning || Handle.order.get(eid) === 0 || !s) return;
            if (!(camera.zoom > 0)) return; // pre-framing: no scale to convert px through
            e.preventDefault();
            const d = (e.shiftKey ? NUDGE_PX_COARSE : NUDGE_PX) / camera.zoom;
            const w = nodeWorld(s, eid);
            const x = w.x + (e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0);
            const y = w.y + (e.key === "ArrowUp" ? d : e.key === "ArrowDown" ? -d : 0); // world Y-up
            beginMove(ecs, Handle.section.get(eid));
            dragTo(ecs, eid, x, y);
            commit(history);
            return;
        }

        // append a section at the chain end — always available (a = geo, A = force).
        if (e.key === "a") {
            e.preventDefault();
            selectSection(appendSection(history, ecs, SectionKind.Geo));
            return;
        }
        if (e.key === "A") {
            e.preventDefault();
            selectSection(appendSection(history, ecs, SectionKind.Force));
            return;
        }
        if (e.key === "Escape") {
            if (editor.selection !== null || editor.section !== null || editor.start) {
                e.preventDefault();
                select(null);
                selectSection(null);
                selectStart(false);
            }
            return;
        }

        // a whole section selected: delete it (Del; also the context-menu action).
        if (editor.section !== null) {
            if (e.key === "Delete" || e.key === "Backspace") {
                e.preventDefault();
                if (removeSection(history, ecs, editor.section)) selectSection(null);
            }
            return;
        }

        // a node selected: extend, or trim the chain end.
        if (editor.selection === null) return;
        const section = Handle.section.get(editor.selection);
        if (!endSelected(ecs)) return;
        if (e.key === "Enter") {
            e.preventDefault();
            select(extendTrack(history, ecs, section)); // lay a node, select it
        } else if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            if (trimTrack(history, ecs, section)) select(lastHandle(ecs, section));
        }
    };

    canvas.addEventListener("contextmenu", onContextMenu);
    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", cancelDrag);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);

    return () => {
        canvas.removeEventListener("contextmenu", onContextMenu);
        canvas.removeEventListener("mousedown", onMouseDown);
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerup", endDrag);
        canvas.removeEventListener("pointercancel", cancelDrag);
        canvas.removeEventListener("wheel", onWheel);
        window.removeEventListener("keydown", onKeyDown);
        canvas.style.cursor = ""; // detaching mid-pan must not leave a stuck grabbing cursor
        snapGuides.x = null; // detaching mid-drag must not leave a stuck guide for the remount
        snapGuides.y = null;
    };
}
