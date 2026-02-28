import type { State } from "@dylanebert/shallot";
import { editor, select } from "./editor";
import { extend, Handle, lastHandle, reheadOnDrag, removeTrailingHandle } from "./track";
import { pointerToCanvas, screenToWorld, viewTransform, type ViewTx } from "./view";

const PICK_R = 16;

let dragNode: number | null = null;
// grab offset: the node−under−cursor delta captured at pointerdown, so the node
// tracks the cursor relatively (grabbing slightly off-center doesn't snap it).
let grabX = 0;
let grabY = 0;

/** nearest node to the screen point, within the pick radius, or null. */
function pickNode(ecs: State, tx: ViewTx, sx: number, sy: number): number | null {
    let bestEid: number | null = null;
    let bestD2 = PICK_R * PICK_R;
    for (const eid of ecs.query([Handle])) {
        const hx = tx.ox + Handle.pos.x.get(eid) * tx.sx;
        const hy = tx.oy + Handle.pos.y.get(eid) * tx.sy;
        const dx = sx - hx;
        const dy = sy - hy;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
            bestD2 = d2;
            bestEid = eid;
        }
    }
    return bestEid;
}

/** true when the selection is the chain end — the node that `extend` / `delete`
 *  act on. */
function endSelected(ecs: State): boolean {
    return editor.selection !== null && editor.selection === lastHandle(ecs);
}

/** wire canvas pointer + window keyboard handling, returning a teardown. tied
 *  to the canvas lifecycle (called from App's onMount) so listeners attach with
 *  the element and detach with it — no module-flag staleness across reloads. */
export function attachControls(canvas: HTMLCanvasElement, ecs: State): () => void {
    const onContextMenu = (e: MouseEvent): void => {
        e.preventDefault(); // no context menu over the canvas
    };

    const onPointerDown = (e: PointerEvent): void => {
        if (e.button !== 0) return;
        const { x: cx, y: cy } = pointerToCanvas(canvas, e);
        const tx = viewTransform(canvas);
        const { x: wx, y: wy } = screenToWorld(tx, cx, cy);

        // pick a node to drag, or deselect on empty space (Figma-style).
        const eid = pickNode(ecs, tx, cx, cy);
        if (eid === null) {
            select(null);
            return;
        }
        select(eid);
        dragNode = eid;
        grabX = Handle.pos.x.get(eid) - wx;
        grabY = Handle.pos.y.get(eid) - wy;
        canvas.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent): void => {
        if (dragNode === null) return;
        const { x: cx, y: cy } = pointerToCanvas(canvas, e);
        const tx = viewTransform(canvas);
        const { x: wx, y: wy } = screenToWorld(tx, cx, cy);
        Handle.pos.set(dragNode, wx + grabX, wy + grabY);
        reheadOnDrag(ecs, dragNode);
    };

    const endDrag = (e: PointerEvent): void => {
        if (dragNode === null) return;
        dragNode = null;
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };

    const onKeyDown = (e: KeyboardEvent): void => {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        if (e.key === "Escape") {
            if (editor.selection !== null) {
                e.preventDefault();
                select(null);
            }
            return;
        }
        // extend / delete act on the chain end (when it's selected).
        if (!endSelected(ecs)) return;
        if (e.key === "Enter") {
            e.preventDefault();
            select(extend(ecs)); // lay a node, select it
        } else if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            if (removeTrailingHandle(ecs)) select(lastHandle(ecs));
        }
    };

    canvas.addEventListener("contextmenu", onContextMenu);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    window.addEventListener("keydown", onKeyDown);

    return () => {
        canvas.removeEventListener("contextmenu", onContextMenu);
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerup", endDrag);
        canvas.removeEventListener("pointercancel", endDrag);
        window.removeEventListener("keydown", onKeyDown);
    };
}
