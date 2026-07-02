import type { State } from "@dylanebert/shallot";
import { PosPin } from "./constraints";
import { editor, select } from "./editor";
import {
    beginMove,
    beginPosPinEdit,
    cancel,
    commit,
    deletePosPin,
    extendTrack,
    history,
    placePosPin,
    trimTrack,
} from "./history";
import { bakeOut, Handle, lastHandle, reheadOnDrag, samples, Track } from "./track";
import { pointerToCanvas, screenToWorld, viewTransform, type ViewTx } from "./view";

const PICK_R = 16;

let dragNode: number | null = null;
let dragPosPin: number | null = null;
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

/** nearest position pin's TARGET to the screen point, within the pick
 *  radius, or null. */
function pickPosPin(ecs: State, tx: ViewTx, sx: number, sy: number): number | null {
    let bestEid: number | null = null;
    let bestD2 = PICK_R * PICK_R;
    for (const eid of ecs.query([PosPin])) {
        const px = tx.ox + PosPin.x.get(eid) * tx.sx;
        const py = tx.oy + PosPin.y.get(eid) * tx.sy;
        const d2 = (sx - px) ** 2 + (sy - py) ** 2;
        if (d2 < bestD2) {
            bestD2 = d2;
            bestEid = eid;
        }
    }
    return bestEid;
}

function isPosPin(ecs: State, eid: number): boolean {
    for (const e of ecs.query([PosPin])) if (e === eid) return true;
    return false;
}

/** nearest REALIZED track sample to the screen point, within the pick
 *  radius: the position-pin add target (pin the curve where it is, then
 *  drag). returns the sample's arclength + world position. */
function pickCurvePoint(
    ecs: State,
    tx: ViewTx,
    sx: number,
    sy: number,
): { trackEid: number; sigma: number; x: number; y: number } | null {
    for (const trackEid of ecs.query([Track])) {
        const s = samples.get(trackEid);
        const out = bakeOut.get(trackEid);
        const count = Track.count.get(trackEid);
        if (!s || !out || count < 2) continue;
        let best = -1;
        let bestD2 = PICK_R * PICK_R;
        for (let i = 0; i < count; i++) {
            const px = tx.ox + s.posX[i] * tx.sx;
            const py = tx.oy + s.posY[i] * tx.sy;
            const d2 = (sx - px) ** 2 + (sy - py) ** 2;
            if (d2 < bestD2) {
                bestD2 = d2;
                best = i;
            }
        }
        if (best < 0) continue;
        let sigma = 0;
        for (let i = 0; i < best; i++) sigma += out.ds[i];
        return { trackEid, sigma, x: s.posX[best], y: s.posY[best] };
    }
    return null;
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

        // pick a node to drag, else a position pin, else deselect (Figma-style).
        const eid = pickNode(ecs, tx, cx, cy);
        if (eid !== null) {
            select(eid);
            dragNode = eid;
            grabX = Handle.pos.x.get(eid) - wx;
            grabY = Handle.pos.y.get(eid) - wy;
            beginMove(ecs); // open the drag gesture; commit/cancel on release
            canvas.setPointerCapture(e.pointerId);
            return;
        }
        const pp = pickPosPin(ecs, tx, cx, cy);
        if (pp !== null) {
            select(pp);
            dragPosPin = pp;
            grabX = PosPin.x.get(pp) - wx;
            grabY = PosPin.y.get(pp) - wy;
            beginPosPinEdit(ecs, pp);
            canvas.setPointerCapture(e.pointerId);
            return;
        }
        select(null);
    };

    // double-click ON the realized curve pins that point in place (a
    // deliberate act); drag its marker to demand a different position.
    const onDblClick = (e: MouseEvent): void => {
        const { x: cx, y: cy } = pointerToCanvas(canvas, e);
        const tx = viewTransform(canvas);
        if (pickNode(ecs, tx, cx, cy) !== null) return; // nodes own their spot
        if (pickPosPin(ecs, tx, cx, cy) !== null) return; // don't stack a pin on a pin
        const hit = pickCurvePoint(ecs, tx, cx, cy);
        if (!hit) return;
        select(placePosPin(history, ecs, hit.trackEid, hit.sigma, hit.x, hit.y));
    };

    const onPointerMove = (e: PointerEvent): void => {
        if (dragNode === null && dragPosPin === null) return;
        const { x: cx, y: cy } = pointerToCanvas(canvas, e);
        const tx = viewTransform(canvas);
        const { x: wx, y: wy } = screenToWorld(tx, cx, cy);
        if (dragNode !== null) {
            Handle.pos.set(dragNode, wx + grabX, wy + grabY);
            reheadOnDrag(ecs, dragNode);
        } else if (dragPosPin !== null) {
            PosPin.x.set(dragPosPin, wx + grabX);
            PosPin.y.set(dragPosPin, wy + grabY);
        }
    };

    const endDrag = (e: PointerEvent): void => {
        if (dragNode === null && dragPosPin === null) return;
        dragNode = null;
        dragPosPin = null;
        commit(history); // one drag → one undo entry (a no-move click records nothing)
        if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };

    const cancelDrag = (e: PointerEvent): void => {
        if (dragNode === null && dragPosPin === null) return;
        dragNode = null;
        dragPosPin = null;
        cancel(); // interrupted drag: restore the pre-gesture pose
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
        // Del removes a selected position pin (before the chain-end guard).
        if (
            (e.key === "Delete" || e.key === "Backspace") &&
            editor.selection !== null &&
            isPosPin(ecs, editor.selection)
        ) {
            e.preventDefault();
            if (deletePosPin(history, ecs, editor.selection)) select(null);
            return;
        }
        // extend / delete act on the chain end (when it's selected).
        if (!endSelected(ecs)) return;
        if (e.key === "Enter") {
            e.preventDefault();
            select(extendTrack(history, ecs)); // lay a node, select it
        } else if (e.key === "Delete" || e.key === "Backspace") {
            e.preventDefault();
            if (trimTrack(history, ecs)) select(lastHandle(ecs));
        }
    };

    canvas.addEventListener("contextmenu", onContextMenu);
    canvas.addEventListener("dblclick", onDblClick);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", cancelDrag);
    window.addEventListener("keydown", onKeyDown);

    return () => {
        canvas.removeEventListener("contextmenu", onContextMenu);
        canvas.removeEventListener("dblclick", onDblClick);
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerup", endDrag);
        canvas.removeEventListener("pointercancel", cancelDrag);
        window.removeEventListener("keydown", onKeyDown);
    };
}
