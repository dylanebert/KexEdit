import type { State } from "@dylanebert/shallot";
import { editor, openContext, select, selectSection } from "./editor";
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
import { pointerToCanvas, screenToWorld, viewTransform, type ViewTx } from "./view";

const PICK_R = 16;
const SECTION_PICK_R = 12;

let dragNode: number | null = null;
// grab offset (world): the node−under−cursor delta captured at pointerdown, so the
// node tracks the cursor relatively (grabbing slightly off-center doesn't snap it).
let grabX = 0;
let grabY = 0;

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
 *  node 0 of every section is the entry anchor (pinned — §4), so it isn't pickable. */
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
 *  whole-section handle for convert / split / join / delete). */
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

/** true when the selection is its section's chain end — the node `extend` / `delete`
 *  act on. */
function endSelected(ecs: State): boolean {
    const sel = editor.selection;
    if (sel === null) return false;
    return sel === lastHandle(ecs, Handle.section.get(sel));
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
        if (e.button !== 0) return;
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
            beginMove(ecs, Handle.section.get(eid)); // open the drag gesture; commit/cancel on release
            canvas.setPointerCapture(e.pointerId);
            return;
        }
        const sec = pickSection(ecs, tx, cx, cy);
        if (sec !== null) {
            selectSection(sec);
            return;
        }
        select(null);
        selectSection(null);
    };

    const onPointerMove = (e: PointerEvent): void => {
        if (dragNode === null) return;
        const { x: cx, y: cy } = pointerToCanvas(canvas, e);
        const tx = viewTransform(canvas);
        const { x: wx, y: wy } = screenToWorld(tx, cx, cy);
        dragTo(ecs, dragNode, wx + grabX, wy + grabY);
    };

    const endDrag = (e: PointerEvent): void => {
        if (dragNode === null) return;
        dragNode = null;
        commit(history); // one drag → one undo entry (a no-move click records nothing)
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };

    const cancelDrag = (e: PointerEvent): void => {
        if (dragNode === null) return;
        dragNode = null;
        cancel(); // interrupted drag: restore the pre-gesture pose
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };

    const onKeyDown = (e: KeyboardEvent): void => {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

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
            if (editor.selection !== null || editor.section !== null) {
                e.preventDefault();
                select(null);
                selectSection(null);
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
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", cancelDrag);
    window.addEventListener("keydown", onKeyDown);

    return () => {
        canvas.removeEventListener("contextmenu", onContextMenu);
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerup", endDrag);
        canvas.removeEventListener("pointercancel", cancelDrag);
        window.removeEventListener("keydown", onKeyDown);
    };
}
