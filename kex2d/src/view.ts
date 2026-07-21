interface Canvas2DRef {
    element: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
}

export const Canvas2D: Canvas2DRef = {} as Canvas2DRef;

/** default framing: half the world-meters shown across the canvas width (the initial
 *  zoom fits ±this many meters horizontally). */
const VIEW_HALF_X = 280;
/** the timeline dock's layout — the single source of truth `Timeline.svelte` styles the
 *  dock element from (its rendered `height` and the `bottom` inset it floats above the
 *  canvas edge). the viewport reserves their sum below (`DOCK_RESERVE`); nothing else
 *  hardcodes the dock size. */
export const DOCK_HEIGHT = 240;
export const DOCK_INSET = 16;
/** screen px kept clear at the bottom for the timeline dock. the default view centers the
 *  world origin ABOVE this band, not at the canvas center — the dock would otherwise cover
 *  the track's launch. */
const DOCK_RESERVE = DOCK_HEIGHT + DOCK_INSET;
/** zoom limits (px per world meter). the affine viewport is an infinite canvas — pan is
 *  unclamped — but the scale is bounded so the track can't blow up or vanish. */
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 200;
/** world-meter breathing room `frameContent` leaves around framed geometry, floored so a
 *  short section (or a single point) still frames with margin instead of filling edge to
 *  edge. */
const MIN_FRAME_PAD = 2;

/** the viewport camera: a uniform 2D affine over world space. `zoom` is px per world
 *  meter (uniform, no rotation); `ox`/`oy` are the screen px the world origin lands at.
 *  world → screen is `screen = origin + world·(zoom, −zoom)` (Y-up world, Y-down screen). */
export interface Camera {
    zoom: number;
    ox: number;
    oy: number;
}

export interface ViewTx {
    sx: number;
    sy: number;
    ox: number;
    oy: number;
}

const clampZoom = (z: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** the HUD-aware default framing for a canvas of the given size: initial zoom fits
 *  ±`VIEW_HALF_X` meters across the width, origin centered horizontally and vertically
 *  centered in the region above the dock. */
export function defaultCamera(width: number, height: number): Camera {
    const zoom = width > 0 ? width / (2 * VIEW_HALF_X) : 1;
    return { zoom: clampZoom(zoom), ox: width / 2, oy: (height - DOCK_RESERVE) / 2 };
}

/** a world-space axis-aligned box (the extent of framed content). */
export interface Box {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

/** frame the camera so a world box fits the region above the dock, centered — the
 *  `F` frame-content target (Unity/Blender). the box grows by a proportional pad (floored
 *  at `MIN_FRAME_PAD`) so content never touches the edges and a degenerate point still
 *  frames sanely; the fit zoom is clamped to the zoom limits. */
export function frameContent(width: number, height: number, box: Box): Camera {
    const availW = Math.max(1, width);
    const availH = Math.max(1, height - DOCK_RESERVE);
    const ex = box.maxX - box.minX;
    const ey = box.maxY - box.minY;
    const bw = ex + 2 * Math.max(ex * 0.1, MIN_FRAME_PAD);
    const bh = ey + 2 * Math.max(ey * 0.1, MIN_FRAME_PAD);
    const zoom = clampZoom(Math.min(availW / bw, availH / bh));
    const cx = (box.minX + box.maxX) / 2;
    const cy = (box.minY + box.maxY) / 2;
    return { zoom, ox: availW / 2 - cx * zoom, oy: availH / 2 + cy * zoom };
}

/** pan by a screen-space delta (drag): the world slides under the cursor. */
export function panCamera(cam: Camera, dx: number, dy: number): Camera {
    return { zoom: cam.zoom, ox: cam.ox + dx, oy: cam.oy + dy };
}

/** geometric zoom by `factor` anchored at screen (`px`, `py`): the world point under the
 *  cursor stays fixed across the scale change. zoom is clamped *before* deriving the new
 *  origin, so the anchor holds exactly even at the zoom limits. */
export function zoomAt(cam: Camera, px: number, py: number, factor: number): Camera {
    const z = clampZoom(cam.zoom * factor);
    const wx = (px - cam.ox) / cam.zoom;
    const wy = (py - cam.oy) / -cam.zoom;
    return { zoom: z, ox: px - wx * z, oy: py + wy * z };
}

/** the render-consumer transform for a camera — world → screen affine. */
export function cameraTx(cam: Camera): ViewTx {
    return { sx: cam.zoom, sy: -cam.zoom, ox: cam.ox, oy: cam.oy };
}

/** the live viewport camera — a module singleton (mirrors `Canvas2D`/`editor`), mutated in
 *  place by the pan/zoom controls and read every frame by the render systems + App anchors. */
export const camera: Camera = { zoom: 0, ox: 0, oy: 0 };
let framed = false;

/** transient world-space snap guides flashed while a viewport drag latches a magnet target
 *  (the Figma alignment-guide flash, one per fired family). the cartesian pair are world axes:
 *  `x` the world x of an active vertical guide, `y` the world y of a horizontal one. `ray`
 *  hangs off the previous node — a line through it at the snapped chord angle. a snapped angle
 *  or length also flashes a numeric label (Figma's measurement pattern): `angleLabel` (e.g.
 *  "30°") and `lengthLabel` (e.g. "3 m"), each a world anchor at the drag point + text the render
 *  pass projects to screen and offsets below-right onto a chip (so the cursor never covers it).
 *  each field is null when its family isn't firing. mutated in place by the drag controls, read by
 *  the render pass, cleared on release — the viewport twin of the timeline's snap guide. */
export interface SnapGuides {
    x: number | null;
    y: number | null;
    ray: { x: number; y: number; angle: number } | null;
    angleLabel: { x: number; y: number; text: string } | null;
    lengthLabel: { x: number; y: number; text: string } | null;
}

export const snapGuides: SnapGuides = {
    x: null,
    y: null,
    ray: null,
    angleLabel: null,
    lengthLabel: null,
};

/** clear every snap guide (drag release / teardown). */
export function clearGuides(): void {
    snapGuides.x = null;
    snapGuides.y = null;
    snapGuides.ray = null;
    snapGuides.angleLabel = null;
    snapGuides.lengthLabel = null;
}

/** frame the camera to the default view for a canvas size (also the reset target). */
export function frameCamera(width: number, height: number): void {
    Object.assign(camera, defaultCamera(width, height));
    framed = true;
}

/** apply an explicitly-computed camera (e.g. `frameContent`) and latch `framed`, so the
 *  next `viewTransform` doesn't re-default over it — the same latch `frameCamera` sets. */
export function setCamera(cam: Camera): void {
    Object.assign(camera, cam);
    framed = true;
}

export function attachCanvas2D(element: HTMLCanvasElement): void {
    const ctx = element.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    Object.assign(Canvas2D, { element, ctx });
}

/** the view transform for the current frame. lazily frames the camera to the canvas the
 *  first time it's laid out (a persistent camera: a later resize doesn't reframe — the
 *  standard NLE/Figma convention). pre-layout (width 0) returns a transient transform
 *  without locking, so the first real frame does the framing. */
export function viewTransform(canvas: HTMLCanvasElement): ViewTx {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!framed) {
        if (w <= 0) return cameraTx(defaultCamera(w, h));
        frameCamera(w, h);
    }
    return cameraTx(camera);
}

export function screenToWorld(tx: ViewTx, sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - tx.ox) / tx.sx, y: (sy - tx.oy) / tx.sy };
}

export function pointerToCanvas(
    canvas: HTMLCanvasElement,
    e: MouseEvent,
): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

export function resize(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
}
