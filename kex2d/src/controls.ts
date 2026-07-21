import type { State } from "@dylanebert/shallot";
import {
    beginDrag,
    editor,
    endDrag as endDragGesture,
    enterTangentEdit,
    exitTangentEdit,
    openContext,
    openNodeMenu,
    select,
    selectSection,
    selectStart,
    snapActive,
    toggleSnap,
} from "./editor";
import {
    beginMove,
    cancel,
    commit,
    extendTrack,
    history,
    removeSection,
    trimTrack,
} from "./history";
import { type Guide, resolveSnap, type SnapInput } from "./magnet";
import { localize } from "./section";
import { editTangent, TangentMode } from "./spline";
import { editHandleSets, localTipAt, type TangentSide } from "./tangents";
import {
    Handle,
    handleAt,
    handleTangent,
    lastHandle,
    reheadOnDrag,
    samples,
    SectionKind,
    sectionInfo,
    sections,
    seedTangent,
    setTangent,
    Track,
} from "./track";
import {
    camera,
    clearGuides,
    frameContent,
    panCamera,
    pointerToCanvas,
    screenToWorld,
    setCamera,
    snapGuides,
    viewTransform,
    type ViewTx,
    zoomAt,
} from "./view";

const PICK_R = 16;
const SECTION_PICK_R = 12;
const START_PICK_R = 12;
// tangent-handle grab radius (px). smaller than the node radius, and the selected node's
// handles are checked before the node itself, so grabbing a handle beats a node under it.
const TANGENT_PICK_R = 11;

// wheel zoom rate: screen-px-independent, exp(−deltaY·rate) so scaling is symmetric
// (in then out returns to the same zoom) and reads the same for wheel + trackpad pinch
// (which arrives as ctrl+wheel, the browser convention).
const WHEEL_ZOOM_RATE = 0.0015;

// arrow-nudge steps, in screen px (converted to world through the live zoom, so the nudge
// is a fixed on-screen distance at any zoom — the AE convention). Shift is the coarse step.
const NUDGE_PX = 2;
const NUDGE_PX_COARSE = 20;

// click-vs-drag dead-zone (screen px): a node grab becomes a drag only once the pointer travels
// this far from the grab point — the Figma/Blender threshold that keeps a plain click (select)
// from moving or snapping the node. below it there is no drag, so no magnet and no guide; this is
// also what stops a stray sync-move (a refocus click after a window blur) from flashing a guide.
export const DRAG_PX = 4;

/** whether a pointer displacement (screen px, from the grab point) clears the click-vs-drag
 *  dead-zone — the point a grab becomes a real drag. */
export function beyondDeadZone(dx: number, dy: number): boolean {
    return dx * dx + dy * dy >= DRAG_PX * DRAG_PX;
}

/** the dead-zone latch: a drag arms when it first clears `beyondDeadZone` and stays armed for the
 *  rest of the gesture (crossing back inside doesn't disarm it — the Figma/Blender feel). */
export function armDrag(armed: boolean, dx: number, dy: number): boolean {
    return armed || beyondDeadZone(dx, dy);
}

// the tangent-handle angle-latch corridor (screen px). a handle drag starts locked to the
// direction it grabbed at, so pulling the handle out lengthens the tangent without bumping its
// angle (the AutoCAD/SketchUp polar-tracking feel). the tip stays on the start ray while within
// this perpendicular half-width of it — so the angular window is DERIVED (px ÷ tip radius, wider
// near the node, tighter far out), never a hardcoded degree count, the `SNAP_PX` design-constant
// precedent (`editor-ui.md` Snapping).
export const LATCH_PX = 8;

/** the tangent-handle angle latch (a polar-tracking corridor). `tipX/tipY` is the candidate handle
 *  tip relative to its node in screen px; `rayX/rayY` the **unit** start-ray direction captured at
 *  grab; `latched` whether the latch is still live. While the tip stays within `LATCH_PX` of the ray
 *  (perpendicular screen distance) the angle locks to the start direction and only length varies —
 *  the returned tip is the projection onto the ray. Once it clearly leaves, the latch releases and
 *  the raw tip passes through. Monotonic: once released it stays released for the gesture (the
 *  `armDrag` dead-zone idiom, opposite polarity — a one-way transition that sticks), so a drift back
 *  onto the ray does not re-lock the angle. */
export function latchAngle(
    tipX: number,
    tipY: number,
    rayX: number,
    rayY: number,
    latched: boolean,
): { x: number; y: number; latched: boolean } {
    if (!latched) return { x: tipX, y: tipY, latched: false };
    const perp = tipX * rayY - tipY * rayX; // signed perpendicular screen distance from the ray
    if (Math.abs(perp) > LATCH_PX) return { x: tipX, y: tipY, latched: false };
    const along = tipX * rayX + tipY * rayY; // projection onto the ray = the latched length
    return { x: along * rayX, y: along * rayY, latched: true };
}

let dragNode: number | null = null;
// whether the node drag has crossed the click-vs-drag dead-zone (DRAG_PX from the grab point).
// false until it does — below the threshold a release is a plain select, so no node move, magnet,
// or guide runs. sticks true for the rest of the gesture (armDrag).
let dragArmed = false;
// the tangent handle under drag (the selected node's in/out handle), or null. mutually
// exclusive with `dragNode` + `panning` — one gesture at a time.
let dragTangent: { eid: number; side: TangentSide } | null = null;
// screen offset knob−cursor captured at grab, so the handle tracks the cursor relatively.
let grabHX = 0;
let grabHY = 0;
// the angle latch for the live tangent drag: `latchLive` is true while the tip is locked to the
// start ray (`latchRayX/Y`, the unit node→knob direction captured at grab). goes false the first
// time the pointer clearly leaves the corridor and stays false (the monotonic `latchAngle` idiom).
let latchLive = false;
let latchRayX = 0;
let latchRayY = 0;
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

/** nearest **draggable** node to the screen point, within the pick radius, or null. node 0 of
 *  every section is the entry anchor (pinned) — never draggable, so it's skipped here. it stays
 *  *pickable* (selectable + tangent-editable) through the two paths that reach it without the
 *  coincidence ambiguity a plain `pickNode` would hit at a boundary (node 0 sits under either the
 *  START diamond or the upstream tip): the START fall-through (the first section's node 0,
 *  `startNode0`) and the boundary stitch (an interior node 0 summoned by tangent-editing its
 *  coincident tip, `editHandleSets`). */
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

/** the tangent-edited node's handle nearest the screen point (within the grab radius), or
 *  null — the summoned inner layer: only the node in tangent-edit mode exposes handles
 *  (explicit ones solid, a live tip's arc-rule ghosts), and they're picked before the node so
 *  a handle over its node still grabs. at a geo→geo boundary the set also carries the downstream
 *  node-0's out-handle (the stitch); a grab there returns that node's eid, so the drag writes the
 *  downstream section's tangent. */
function pickTangentHandle(
    ecs: State,
    tx: ViewTx,
    sx: number,
    sy: number,
): { eid: number; side: TangentSide; x: number; y: number } | null {
    const sel = editor.tangentEdit;
    if (sel === null) return null;
    const s = trackSamples(ecs);
    if (!s) return null;
    let best: { eid: number; side: TangentSide; x: number; y: number } | null = null;
    let bestD2 = TANGENT_PICK_R * TANGENT_PICK_R;
    for (const set of editHandleSets(ecs, s, tx, sel)) {
        for (const h of set.handles) {
            const dx = sx - h.x;
            const dy = sy - h.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2) {
                bestD2 = d2;
                best = { eid: set.eid, side: h.side, x: h.x, y: h.y };
            }
        }
    }
    return best;
}

/** node 0 of the first section (the one at order 0) when it is geo, else null — the START
 *  diamond and this node 0 are coincident at the world origin, so a plain click selects the
 *  START (its v0 popover) while a double-click / right-click reaches node 0 for its entry
 *  handle. null when the first section is force (no geo node 0 to edit). */
function startNode0(ecs: State): number | null {
    const rows = sections(ecs);
    const first = rows[0]; // order 0
    if (!first || first.kind !== SectionKind.Geo) return null;
    return handleAt(ecs, first.id, 0);
}

/** true when the selection is its section's chain end — the node `extend` / `delete`
 *  act on. */
function endSelected(ecs: State): boolean {
    const sel = editor.selection;
    if (sel === null) return false;
    return sel === lastHandle(ecs, Handle.section.get(sel));
}

/** the screen point a baked sample lands at. */
function sampleScreen(
    s: NonNullable<ReturnType<typeof samples.get>>,
    tx: ViewTx,
    i: number,
): { x: number; y: number } {
    return { x: tx.ox + s.posX[i] * tx.sx, y: tx.oy + s.posY[i] * tx.sy };
}

/** assemble the magnet resolver's input for a node drag: the raw screen point (shift-lock
 *  already folded in) and the polar frame relative to the previous node — for the growth TIP,
 *  the previous node's exit incline (the tip incline family snaps against it); an interior drag
 *  leaves it null (a frozen heading has no incline to snap). */
function magnetInput(
    ecs: State,
    tx: ViewTx,
    dragEid: number,
    rawSX: number,
    rawSY: number,
    lock: "x" | "y" | null,
): SnapInput {
    const inp: SnapInput = {
        px: rawSX,
        py: rawSY,
        prev: null,
        tangent: null,
        pxPerMeter: Math.abs(tx.sx),
        lock,
    };
    const s = trackSamples(ecs);
    if (!s) return inp;
    const section = Handle.section.get(dragEid);
    const order = Handle.order.get(dragEid);
    const prevEid = handleAt(ecs, section, order - 1);
    if (prevEid === null) return inp;
    const pi = Handle.sample.get(prevEid);
    inp.prev = sampleScreen(s, tx, pi);
    // the exit incline family fires only for the tip: its incline snaps against the previous
    // node's exit incline, read from that node's flanking samples (centered where it can be,
    // one-sided at a chain end). an interior node's heading is frozen — no incline to snap.
    if (dragEid === lastHandle(ecs, section)) {
        let count = 0;
        for (const t of ecs.query([Track])) count = Track.count.get(t);
        const lo = Math.max(0, pi - 1);
        const hi = Math.min(count - 1, pi + 1);
        if (hi > lo) {
            const a = sampleScreen(s, tx, lo);
            const b = sampleScreen(s, tx, hi);
            inp.tangent = Math.atan2(b.y - a.y, b.x - a.x);
        }
    }
    return inp;
}

// float-noise band for the integer-degree readout. absorbs the f64 conversion of an exact
// π/12-raster multiple (a few ULP of ~180, ≪ 1e-9°) while staying far below any genuine
// fractional incline a continuation landmark produces.
const DEG_EPS = 1e-6;

/** wrap a degree value into (−180, 180]. */
export function normDeg(d: number): number {
    const w = ((((d + 180) % 360) + 360) % 360) - 180;
    return w === -180 ? 180 : w; // the wrap lands 180° on −180; the readout wants 180
}

/** format a snapped incline (degrees) for the snap readout: an integer when within float
 *  noise of a whole degree (a raster multiple cancels clean), else one decimal (a continuation
 *  landmark is a raw atan2 over baked samples). */
export function formatDeg(d: number): string {
    const n = normDeg(d);
    const r = Math.round(n);
    return `${Math.abs(n - r) < DEG_EPS ? r : n.toFixed(1)}°`;
}

/** a selected node's live readout metrics. `lengthLabel` is always present (the chord length to the
 *  previous node); `angleLabel` is the exit-tangent incline, present only for a growth tip. */
export interface NodeMetrics {
    angleLabel: string | null;
    lengthLabel: string;
}

/** derive a node's readout metrics from baked geometry (device-free — the caller passes the world
 *  points). the same quantities the magnet reads: the chord `|node − prev|` to the previous node,
 *  and — for a growth tip only — the exit-tangent incline, the flanking-sample tangent (`exit` = the
 *  node's two flanking sample points; null for an interior node, whose frozen heading has no incline
 *  to snap). formatted like the snap readout (`formatDeg`, integer metres). */
export function nodeMetrics(
    prev: { x: number; y: number },
    node: { x: number; y: number },
    exit: [{ x: number; y: number }, { x: number; y: number }] | null,
): NodeMetrics {
    const chord = Math.hypot(node.x - prev.x, node.y - prev.y);
    const angleLabel =
        exit === null
            ? null
            : formatDeg((Math.atan2(exit[1].y - exit[0].y, exit[1].x - exit[0].x) * 180) / Math.PI);
    return { angleLabel, lengthLabel: `${Math.round(chord)} m` };
}

/** the selected node's live metrics for the resting snap readout (the Figma selected-object
 *  dimensions idiom): reads the baked world samples and defers to `nodeMetrics`. the exit incline
 *  shows for a section's growth tip — the same `lastHandle` split the magnet's incline family uses,
 *  flanking the node's sample (one-sided at a chain end); an interior node gets the chord length
 *  only. null when the selection has no previous node — node 0 (the entry anchor, now selectable
 *  for its entry handle) has no chord back into its own section, so this keeps the chord/incline
 *  readout off it (a load-bearing guard, not defensive). world-space, so no view transform. */
export function selectedMetrics(ecs: State, eid: number): NodeMetrics | null {
    const s = trackSamples(ecs);
    if (!s) return null;
    const section = Handle.section.get(eid);
    const order = Handle.order.get(eid);
    const prevEid = handleAt(ecs, section, order - 1);
    if (prevEid === null) return null;
    const prev = nodeWorld(s, prevEid);
    const node = nodeWorld(s, eid);
    let exit: [{ x: number; y: number }, { x: number; y: number }] | null = null;
    if (eid === lastHandle(ecs, section)) {
        let count = 0;
        for (const t of ecs.query([Track])) count = Track.count.get(t);
        const i = Handle.sample.get(eid);
        const lo = Math.max(0, i - 1);
        const hi = Math.min(count - 1, i + 1);
        if (hi > lo)
            exit = [
                { x: s.posX[lo], y: s.posY[lo] },
                { x: s.posX[hi], y: s.posY[hi] },
            ];
    }
    return nodeMetrics(prev, node, exit);
}

/** flash the fired magnet guides (the render pass reads `snapGuides.ray`; the App readout reads the
 *  labels). the angle guide draws a tangent ray AT the dragged node along the snapped exit incline
 *  (the screen angle inverts to world, the y-flip) and sets the degree readout string; a snapped
 *  length sets a metre readout string. the numbers show in the DOM snap readout centered below the
 *  dragged node, so they carry no world anchor of their own. `snapped` is the resolved drag point
 *  in world coords — the ray origin. */
function applyGuides(guides: Guide[], tx: ViewTx, snapped: { x: number; y: number }): void {
    for (const g of guides) {
        if (g.kind === "angle") {
            snapGuides.ray = { x: snapped.x, y: snapped.y, angle: -g.value };
            snapGuides.angleLabel = formatDeg((-g.value * 180) / Math.PI);
        } else if (g.kind === "length") {
            snapGuides.lengthLabel = `${Math.round(g.value / Math.abs(tx.sx))} m`;
        }
    }
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
    setCamera(frameContent(canvas.clientWidth, canvas.clientHeight, { minX, minY, maxX, maxY }));
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

/** advance a tangent-handle drag: fold in the grab offset, map to world, and write the edited
 *  tangent. handle drags do NOT snap — a bezier handle is a free direct-manipulation gesture, no
 *  raster, no guides. the first move of an `Auto` node's ghost handle seeds the explicit tangent
 *  from the arc rule (the direct-manipulation summon — continuous, no jump) before editing. */
function dragTangentTo(ecs: State, canvas: HTMLCanvasElement, e: PointerEvent): void {
    if (!dragTangent) return;
    const s = trackSamples(ecs);
    if (!s) return;
    const { eid, side } = dragTangent;
    const section = Handle.section.get(eid);
    const order = Handle.order.get(eid);
    const tx = viewTransform(canvas);
    const { x: cx, y: cy } = pointerToCanvas(canvas, e);
    // the angle latch (a polar-tracking corridor): while the tip stays near the start ray, lock
    // the angle and let only length vary, so lengthening the handle doesn't bump its direction.
    // apply it in screen space (the corridor is screen px) against the node's baked screen point.
    const nsx = tx.ox + s.posX[Handle.sample.get(eid)] * tx.sx;
    const nsy = tx.oy + s.posY[Handle.sample.get(eid)] * tx.sy;
    const latch = latchAngle(cx + grabHX - nsx, cy + grabHY - nsy, latchRayX, latchRayY, latchLive);
    latchLive = latch.latched;
    const { x: worldX, y: worldY } = screenToWorld(tx, nsx + latch.x, nsy + latch.y);

    // summon explicit on the first move of an Auto ghost (seed both sides from the arc rule so
    // the coupled side keeps its natural length), then edit the dragged side. node 0 (the entry
    // anchor) is a single **free** handle — it drives only its out-segment, so there is no in-side
    // to couple; an interior node seeds Aligned (the collinear default).
    let tan = handleTangent(ecs, section, order);
    if (tan === undefined) {
        const mode = order === 0 ? TangentMode.Free : TangentMode.Aligned;
        const seed = seedTangent(ecs, section, order, mode);
        if (!seed) return;
        setTangent(ecs, section, order, seed);
        tan = seed;
    }
    const [ox, oy] = localTipAt(s, eid, worldX, worldY);
    setTangent(ecs, section, order, editTangent(tan, side, ox, oy));
}

/** wire canvas pointer + window keyboard handling, returning a teardown. tied to
 *  the canvas lifecycle (called from App's onMount) so listeners attach with the
 *  element and detach with it — no module-flag staleness across reloads. */
export function attachControls(canvas: HTMLCanvasElement, ecs: State): () => void {
    const onContextMenu = (e: MouseEvent): void => {
        e.preventDefault(); // suppress the browser menu; ours takes over
        const { x: cx, y: cy } = pointerToCanvas(canvas, e);
        const tx = viewTransform(canvas);
        // right-click ON a pickable node (any mode) opens the NODE context menu: Handles +
        // Tangents. `pickNode` skips the order-0 entry anchors — but the first section's node 0
        // (coincident with the START diamond) IS reachable here: with no draggable node under the
        // cursor, a right-click at the START opens node 0's own menu (Handles + Reset). selecting
        // the node reads it highlighted.
        const node = pickNode(ecs, tx, cx, cy);
        if (node !== null) {
            select(node);
            openNodeMenu(e.clientX, e.clientY, node);
            return;
        }
        if (pickStart(ecs, tx, cx, cy)) {
            const n0 = startNode0(ecs);
            if (n0 !== null) {
                select(n0);
                openNodeMenu(e.clientX, e.clientY, n0);
                return;
            }
        }
        const sec = pickSection(ecs, tx, cx, cy);
        if (sec !== null) openContext(e.clientX, e.clientY, sec); // right-click a section span → menu
    };

    const onPointerDown = (e: PointerEvent): void => {
        // middle-drag pans the viewport — the same gesture the timeline uses (one
        // vocabulary). left picks/drags; right owns the section context menu. pan and
        // node-drag are mutually exclusive: refuse to start one while the other is live,
        // so a second button press can't leak pointer capture or an open history gesture.
        if (e.button === 1) {
            if (dragNode !== null || dragTangent !== null) return;
            e.preventDefault();
            const { x, y } = pointerToCanvas(canvas, e);
            panning = true;
            panX = x;
            panY = y;
            canvas.style.cursor = "grabbing"; // grab affordance while panning (Blender/AE)
            beginDrag(canvas, e.pointerId);
            return;
        }
        if (e.button !== 0 || panning) return;
        const { x: cx, y: cy } = pointerToCanvas(canvas, e);
        const tx = viewTransform(canvas);
        const { x: wx, y: wy } = screenToWorld(tx, cx, cy);

        // the selected node's tangent handle wins first — a summoned handle sitting over its
        // node must still grab (the vector-editor priority).
        const th = pickTangentHandle(ecs, tx, cx, cy);
        if (th !== null) {
            dragTangent = { eid: th.eid, side: th.side };
            grabHX = th.x - cx;
            grabHY = th.y - cy;
            // arm the angle latch: the start ray is the node→knob direction in screen px at grab.
            // a degenerate (node-coincident) handle has no ray, so it never latches — free drag.
            const s = trackSamples(ecs);
            const w = s ? nodeWorld(s, th.eid) : null;
            const rx = w ? th.x - (tx.ox + w.x * tx.sx) : 0;
            const ry = w ? th.y - (tx.oy + w.y * tx.sy) : 0;
            const rl = Math.hypot(rx, ry);
            if (rl > 1e-6) {
                latchRayX = rx / rl;
                latchRayY = ry / rl;
                latchLive = true;
            } else {
                latchLive = false;
            }
            beginMove(ecs, Handle.section.get(th.eid)); // one gesture; the node snapshot carries the tangent
            beginDrag(canvas, e.pointerId);
            return;
        }

        // a node to drag takes priority; else select the section under the click; else
        // deselect (Figma-style).
        const eid = pickNode(ecs, tx, cx, cy);
        if (eid !== null) {
            select(eid);
            dragNode = eid;
            dragArmed = false; // a fresh grab starts inside the dead-zone — a select until it moves
            const s = trackSamples(ecs);
            const w = s ? nodeWorld(s, eid) : { x: wx, y: wy };
            grabX = w.x - wx;
            grabY = w.y - wy;
            grabCX = cx;
            grabCY = cy;
            grabWX = w.x;
            grabWY = w.y;
            beginMove(ecs, Handle.section.get(eid)); // open the drag gesture; commit/cancel on release
            beginDrag(canvas, e.pointerId);
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

    // double-click a node → enter tangent edit (Figma's vector-edit summon): its handles
    // appear (the same toggle as the node menu's Handles item). `pickNode` skips the order-0
    // anchors, but a double-click at the START (no draggable node there) reaches the first
    // section's node 0 for its entry handle; at an interior geo→geo boundary the double-click
    // lands on the coincident tip, whose tangent edit stitches in node 0's out-handle. an empty
    // double-click does nothing (single-click already deselects). the two constituent clicks each
    // select the node; this fires after, so the final state is the node selected + in edit.
    const onDblClick = (e: MouseEvent): void => {
        if (e.button !== 0) return;
        const { x: cx, y: cy } = pointerToCanvas(canvas, e);
        const tx = viewTransform(canvas);
        const eid = pickNode(ecs, tx, cx, cy);
        if (eid !== null) {
            enterTangentEdit(eid);
            return;
        }
        if (pickStart(ecs, tx, cx, cy)) {
            const n0 = startNode0(ecs);
            if (n0 !== null) enterTangentEdit(n0);
        }
    };

    const onPointerMove = (e: PointerEvent): void => {
        if (panning) {
            const { x, y } = pointerToCanvas(canvas, e);
            Object.assign(camera, panCamera(camera, x - panX, y - panY));
            panX = x;
            panY = y;
            return;
        }
        if (dragTangent !== null) {
            dragTangentTo(ecs, canvas, e);
            return;
        }
        if (dragNode === null) return;
        const { x: cx, y: cy } = pointerToCanvas(canvas, e);
        // the click-vs-drag dead-zone: until the pointer travels DRAG_PX from the grab point this
        // stays a select — no move, no magnet, no guide. this is what keeps a stray sync-move (a
        // refocus click after a window blur) from flashing a guide on a plain click.
        dragArmed = armDrag(dragArmed, cx - grabCX, cy - grabCY);
        if (!dragArmed) return;
        const tx = viewTransform(canvas);
        const { x: wx, y: wy } = screenToWorld(tx, cx, cy);
        let tgtX = wx + grabX;
        let tgtY = wy + grabY;
        // Shift constrains to the dominant axis since the grab (the AE/Photoshop rule,
        // already live for timeline force points); the held axis snaps back to the grab
        // pose. re-evaluated live — no hysteresis.
        let lock: "x" | "y" | null = null;
        if (e.shiftKey) {
            if (Math.abs(cx - grabCX) >= Math.abs(cy - grabCY)) {
                tgtY = grabWY;
                lock = "y";
            } else {
                tgtX = grabWX;
                lock = "x";
            }
        }
        // the magnet: resolve the raw drag point (shift-lock folded in) against every target
        // family in screen px — neighbor alignment plus the polar rasters + landmarks relative
        // to the previous node — and flash whatever fires. Ctrl/Cmd bypasses (snapActive).
        clearGuides();
        if (snapActive(e.ctrlKey || e.metaKey)) {
            const inp = magnetInput(
                ecs,
                tx,
                dragNode,
                tx.ox + tgtX * tx.sx,
                tx.oy + tgtY * tx.sy,
                lock,
            );
            const res = resolveSnap(inp);
            const w = screenToWorld(tx, res.px, res.py);
            tgtX = w.x;
            tgtY = w.y;
            applyGuides(res.guides, tx, { x: tgtX, y: tgtY });
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

    // the drag flag + capture clear via beginDrag's own window pointerup/cancel listener; these
    // handlers own only the gesture's own state (pan flag / node + history).
    const endDrag = (): void => {
        if (panning) {
            panning = false;
            canvas.style.cursor = "";
            return;
        }
        if (dragTangent !== null) {
            dragTangent = null;
            clearGuides();
            commit(history); // one handle drag → one undo entry (a no-move grab records nothing)
            return;
        }
        if (dragNode === null) return;
        dragNode = null;
        dragArmed = false;
        clearGuides();
        commit(history); // one drag → one undo entry (a no-move click records nothing)
    };

    const cancelDrag = (): void => {
        if (panning) {
            panning = false;
            canvas.style.cursor = "";
            return;
        }
        if (dragTangent !== null) {
            dragTangent = null;
            clearGuides();
            cancel();
            return;
        }
        if (dragNode === null) return;
        dragNode = null;
        dragArmed = false;
        clearGuides();
        cancel(); // interrupted drag: restore the pre-gesture pose
    };

    // a window blur mid-gesture never delivers the pointerup/pointercancel that would end the drag,
    // so without this the gesture resumes stale on refocus — a guide left on screen, the drag
    // reattaching to the old node on the next move. tear it down like a pointercancel: revert the
    // bracketed edit, drop the drag/pan state (cancelDrag), and clear the capture flag (endDrag).
    const onBlur = (): void => {
        if (dragNode === null && dragTangent === null && !panning) return;
        cancelDrag();
        endDragGesture();
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
        // nothing is selected — but only while the pointer is over the viewport (the
        // hovered-surface router), so `F` frames the viewport OR the timeline, never both.
        // guard Ctrl/Cmd+F (the browser find reflex) and mid-drag.
        if (
            (e.key === "f" || e.key === "F") &&
            !e.ctrlKey &&
            !e.metaKey &&
            editor.hover === "viewport"
        ) {
            e.preventDefault();
            if (dragNode === null && !panning) frameViewport(ecs, canvas);
            return;
        }

        // arrow-nudge the selected node (AE): a fixed on-screen step in world space, Shift
        // for the coarse step. one press = one undo entry (holding auto-repeats to many).
        // gated on the viewport hover (the hovered-surface router) so it can't also fire
        // while the pointer is over the timeline — that cross-surface collision with the
        // playhead/force-point step is the double-fire this routing ends.
        if (
            editor.selection !== null &&
            editor.hover === "viewport" &&
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

        if (e.key === "Escape") {
            // dismissal peels one layer: exit tangent edit first (keep the node selected), else
            // clear the selection. the node menu is inside App and takes Escape first (capture),
            // so it closes before this handler sees the key.
            if (editor.tangentEdit !== null) {
                e.preventDefault();
                exitTangentEdit();
            } else if (editor.selection !== null || editor.section !== null || editor.start) {
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
    canvas.addEventListener("dblclick", onDblClick);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", cancelDrag);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);

    return () => {
        canvas.removeEventListener("contextmenu", onContextMenu);
        canvas.removeEventListener("mousedown", onMouseDown);
        canvas.removeEventListener("dblclick", onDblClick);
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerup", endDrag);
        canvas.removeEventListener("pointercancel", cancelDrag);
        canvas.removeEventListener("wheel", onWheel);
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("blur", onBlur);
        canvas.style.cursor = ""; // detaching mid-pan must not leave a stuck grabbing cursor
        clearGuides(); // detaching mid-drag must not leave a stuck guide for the remount
        endDragGesture(); // detaching mid-drag must not leave the drag flag stuck on
    };
}
