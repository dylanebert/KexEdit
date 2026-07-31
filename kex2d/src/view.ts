import type { Rect } from "./marquee";

interface Canvas2DRef {
    element: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
}

export const Canvas2D: Canvas2DRef = {} as Canvas2DRef;

/** the live viewport marquee (box-select) rect in screen px, or null when no marquee drag is
 *  armed — the render pass draws it in the neutral guide register (`MarqueeDrawSystem`). set each
 *  pointermove once the drag clears the dead zone, cleared on release / cancel / teardown. a
 *  transient like `snapGuides`, kept separate so it's independent of a manipulator drag's guides. */
export const marquee: { rect: Rect | null } = { rect: null };

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
 *  the track's launch. also the floor the drag snap readout keeps clear of (`readoutFit`). */
export const DOCK_RESERVE = DOCK_HEIGHT + DOCK_INSET;
/** the media player's geometry above the dock — like `DOCK_HEIGHT`/`DOCK_INSET`, the single
 *  source `Timeline.svelte` styles the player from, shared so a surface docking ABOVE the
 *  player (the optimize-mode panel, App.svelte) derives its anchor instead of mirroring. */
export const PLAYER_GAP = 32;
export const PLAYER_H = 36;
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

/** where the drag snap readout lands so it stays whole in the viewport — centered under the
 *  dragged node and clear of the radial ring by the caller's `offset` (root ui.md "summoned
 *  panels fit the viewport"). Pure so it's testable device-free; App feeds it the node's screen
 *  point + the readout's measured size. Returns the readout's top-left in screen px.
 *
 * - horizontally centered on the node, then clamped so neither end runs off the viewport — a
 *   node near the left/right edge slides the readout in (it stops being centered there).
 * - below the node by `offset` (node center → readout top). Flips ABOVE when below would land
 *   under the dock band or off the bottom edge. `offset` clears the radial ring on either side
 *   by construction, so the flip never overlaps a ring button. `dock` is the px
 *   reserved at the bottom for the timeline dock (`DOCK_RESERVE`).
 *
 * @example readoutFit({ x: 640, y: 300 }, 69, { w: 90, h: 18 }, { w: 1280, h: 800 }, 256)
 */
export function readoutFit(
    node: { x: number; y: number },
    offset: number,
    size: { w: number; h: number },
    viewport: { w: number; h: number },
    dock: number,
    margin = 8,
): { x: number; y: number } {
    const x = Math.max(margin, Math.min(node.x - size.w / 2, viewport.w - margin - size.w));
    const belowTop = node.y + offset;
    const floor = viewport.h - dock - margin; // the readout's bottom can't cross into the dock
    const y = belowTop + size.h <= floor ? belowTop : node.y - offset - size.h;
    return { x, y };
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

/** the transient feedback a live viewport manipulator drag publishes. `ray` is world-space — a
 *  line through the dragged node at the snapped exit incline the render pass draws in the viewport
 *  (the Figma alignment-guide flash), set only while the angle control is actually snapped. `angleLabel`
 *  (e.g. "30°") and `lengthLabel` (e.g. "3 m") are the numeric readout strings: rendered in the DOM
 *  snap readout centered below the dragged node (the Blender modal-transform readout), offset far
 *  enough below to clear the node-action ring's buttons by construction — an earlier chip AT the
 *  drag point overlapped them, and a fixed top-left line read too far from the action. `readoutFit`
 *  places it. both labels are seeded at the knob grab and rewritten every move, so ONE source owns
 *  a gesture start to end (no mid-gesture switch); all three fields are null at rest. mutated in
 *  place by the drag controls, read by the render pass (`ray`) and the App readout (the labels),
 *  cleared on release. */
export interface SnapGuides {
    ray: { x: number; y: number; angle: number } | null;
    angleLabel: string | null;
    lengthLabel: string | null;
}

export const snapGuides: SnapGuides = {
    ray: null,
    angleLabel: null,
    lengthLabel: null,
};

/** the tangent-handle drag readout target: the eid of the node whose handle is being dragged, or
 *  null when no handle drag is live. a handle drag reports the SAME quantities the resting readout
 *  shows for that node (its authored exit heading + chord to prev), never gesture-local handle
 *  values — one readout rule with no per-gesture exception (feel round 14). the App reads
 *  `selectedMetrics(this node)`, which updates live as the drag rewrites the out-vector. keyed to
 *  the dragged node, not the selection, so a boundary-stitch drag (writing the downstream node-0's
 *  tangent while the upstream tip is selected) reports the downstream node. distinct from
 *  `snapGuides` — a handle drag shows no guide ray (`editor-ui.md`: node drags snap, handle drags
 *  express). set on each move of a live handle drag, cleared with the gesture (`clearGuides`). */
export const dragReadout: { node: number | null } = {
    node: null,
};

/** clear every snap guide + the drag readout target (drag release / teardown). */
export function clearGuides(): void {
    snapGuides.ray = null;
    snapGuides.angleLabel = null;
    snapGuides.lengthLabel = null;
    dragReadout.node = null;
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
