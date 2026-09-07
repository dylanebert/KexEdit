import type { State } from "@dylanebert/shallot";
import { beginDrag, clearHover, editor } from "./editor";
import { samples, Track } from "./track";
import { camera, frameContent, panCamera, pointerToCanvas, setCamera, zoomAt } from "./view";

// wheel zoom rate: screen-px-independent, exp(−deltaY·rate) so scaling is symmetric
// (in then out returns to the same zoom) and reads the same for wheel + trackpad pinch
// (which arrives as ctrl+wheel, the browser convention).
const WHEEL_ZOOM_RATE = 0.0015;

let panning = false;
let panX = 0;
let panY = 0;

function trackSamples(ecs: State): ReturnType<typeof samples.get> {
    for (const eid of ecs.query([Track])) return samples.get(eid);
    return undefined;
}

/** frame the viewport camera to the whole baked track — the `F` key. The canvas is a
 *  read-only view of the bake, so there is no selection to frame to. */
function frameViewport(ecs: State, canvas: HTMLCanvasElement): void {
    const s = trackSamples(ecs);
    if (!s) return;
    let count = 0;
    for (const eid of ecs.query([Track])) count = Track.count.get(eid);
    if (count < 1) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < count; i++) {
        if (s.posX[i] < minX) minX = s.posX[i];
        if (s.posX[i] > maxX) maxX = s.posX[i];
        if (s.posY[i] < minY) minY = s.posY[i];
        if (s.posY[i] > maxY) maxY = s.posY[i];
    }
    if (!Number.isFinite(minX)) return;
    setCamera(frameContent(canvas.clientWidth, canvas.clientHeight, { minX, minY, maxX, maxY }));
}

/** viewport navigation: middle-drag pan, wheel zoom-at-cursor and `F` to frame the track.
 *  Authoring gestures retired with the pose UX (`retired/pose-ux`); the canvas draws the
 *  bake and navigates over it, nothing more. Input attaches on mount with a matching
 *  teardown — never a module-level attached flag (`kex2d-map.md` Hard gotchas). */
export function attachControls(canvas: HTMLCanvasElement, ecs: State): { detach: () => void } {
    // ours suppresses the browser menu even with no menu of its own to raise, so a
    // right-click over the viewport stays inert rather than opening the page menu.
    const onContextMenu = (e: MouseEvent): void => {
        e.preventDefault();
    };

    const onPointerDown = (e: PointerEvent): void => {
        if (e.button !== 1) return;
        e.preventDefault();
        const { x, y } = pointerToCanvas(canvas, e);
        panning = true;
        panX = x;
        panY = y;
        canvas.style.cursor = "grabbing"; // grab affordance while panning (Blender/AE)
        beginDrag(canvas, e.pointerId);
    };

    const onPointerMove = (e: PointerEvent): void => {
        if (!panning) return;
        const { x, y } = pointerToCanvas(canvas, e);
        Object.assign(camera, panCamera(camera, x - panX, y - panY));
        panX = x;
        panY = y;
    };

    const onPointerLeave = (): void => {
        clearHover();
    };

    // wheel = zoom-at-cursor; trackpad pinch arrives as ctrl+wheel and zooms the same way.
    // preventDefault stops the page scrolling under it (needs a non-passive listener), and
    // deltaY is normalized to px — Firefox reports line/page deltas (deltaMode 1/2).
    // A no-op while any gesture is live: `editor.dragging` is the one flag every gesture on
    // either surface raises, and the camera is the map a gesture's cached screen px resolve
    // through (`ui.md` "nothing moves under its own gesture").
    const onWheel = (e: WheelEvent): void => {
        e.preventDefault();
        if (editor.dragging) return;
        const { x, y } = pointerToCanvas(canvas, e);
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? canvas.clientHeight : 1;
        Object.assign(camera, zoomAt(camera, x, y, Math.exp(-e.deltaY * unit * WHEEL_ZOOM_RATE)));
    };

    // suppress the middle-click autoscroll ring (fired on mousedown, not the pointer event).
    const onMouseDown = (e: MouseEvent): void => {
        if (e.button === 1) e.preventDefault();
    };

    const endPan = (): void => {
        if (!panning) return;
        panning = false;
        canvas.style.cursor = "";
    };

    // a window blur mid-pan never delivers the pointerup that would end it, so tear the pan
    // down like a pointercancel rather than resuming it stale on refocus.
    const onBlur = (): void => {
        endPan();
    };

    const onKeyDown = (e: KeyboardEvent): void => {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        // frame content (Unity/Blender `F`), only while the pointer is over the viewport (the
        // hovered-surface router), guarding Ctrl/Cmd+F (the browser find reflex) and any live
        // gesture on `editor.dragging`.
        if (
            (e.key === "f" || e.key === "F") &&
            !e.ctrlKey &&
            !e.metaKey &&
            editor.hover === "viewport"
        ) {
            e.preventDefault();
            if (!editor.dragging) frameViewport(ecs, canvas);
        }
    };

    canvas.addEventListener("contextmenu", onContextMenu);
    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("pointerup", endPan);
    canvas.addEventListener("pointercancel", endPan);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);

    const detach = (): void => {
        canvas.removeEventListener("contextmenu", onContextMenu);
        canvas.removeEventListener("mousedown", onMouseDown);
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerleave", onPointerLeave);
        canvas.removeEventListener("pointerup", endPan);
        canvas.removeEventListener("pointercancel", endPan);
        canvas.removeEventListener("wheel", onWheel);
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("blur", onBlur);
        canvas.style.cursor = ""; // detaching mid-pan must not leave a stuck grabbing cursor
        clearHover(); // nor a lit hover the remount has no pointer over
    };

    return { detach };
}
