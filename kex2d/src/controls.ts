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
import {
    angleControl,
    angleToPoint,
    type Frame,
    lengthControl,
    lengthToPoint,
    polarFrame,
} from "./manipulator";
import { LENGTH_MIN } from "./magnet";
import { RadialSlot, ringBase, ringSlot } from "./radial";
import { localize } from "./section";
import { editTangent, TangentMode } from "./spline";
import { editHandleSets, localTipAt, type TangentSide } from "./tangents";
import {
    exitWorld,
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
    dragReadout,
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

/** the tangent-handle angle snap (a polar-tracking landmark). `tipX/tipY` is the candidate handle
 *  tip relative to its node in screen px; `rayX/rayY` the **unit** start-ray direction captured at
 *  grab (zero when degenerate — never snaps). The grab angle is a persistent landmark: whenever the
 *  tip sits within `LATCH_PX` of the ray (perpendicular screen distance) the angle snaps to the
 *  start direction and only length varies — the returned tip is the projection onto the ray;
 *  outside the corridor the raw tip passes through. Stateless: deviating and returning re-snaps
 *  (the magnet-target model, not the one-way `armDrag` latch). */
export function latchAngle(
    tipX: number,
    tipY: number,
    rayX: number,
    rayY: number,
): { x: number; y: number; snapped: boolean } {
    if (rayX === 0 && rayY === 0) return { x: tipX, y: tipY, snapped: false };
    const perp = tipX * rayY - tipY * rayX; // signed perpendicular screen distance from the ray
    if (Math.abs(perp) > LATCH_PX) return { x: tipX, y: tipY, snapped: false };
    const along = tipX * rayX + tipY * rayY; // projection onto the ray = the snapped length
    return { x: along * rayX, y: along * rayY, snapped: true };
}

// the manipulator axis under drag — the selected node's length knob (chord) or angle knob (arc),
// or null. node body drag is select-only now: movement runs only through these polar knobs (the
// stage-4 inverses). mutually exclusive with `dragTangent` + `panning` — one gesture at a time.
let dragManip: "length" | "angle" | null = null;
// whether the manipulator drag has crossed the click-vs-drag dead-zone (DRAG_PX from the grab
// point). false until it does — below the threshold a knob grab is a plain click (the node is
// already selected, so nothing moves). sticks true for the rest of the gesture (armDrag).
let manipArmed = false;
// the node-screen − pointer-screen offset captured at the knob grab, so grabbing a knob off-center
// tracks the node relatively (no jump). the grab screen point below is the dead-zone origin.
let manipDX = 0;
let manipDY = 0;
let manipCX = 0;
let manipCY = 0;
// the tangent handle under drag (the selected node's in/out handle), or null. mutually
// exclusive with `dragManip` + `panning` — one gesture at a time.
let dragTangent: { eid: number; side: TangentSide } | null = null;
// screen offset knob−cursor captured at grab, so the handle tracks the cursor relatively.
let grabHX = 0;
let grabHY = 0;
// the angle-snap landmark for the live tangent drag: the unit node→knob direction captured at
// grab (`latchRayX/Y`; zero when the grab was node-coincident — no landmark). persists for the
// whole gesture — `latchAngle` re-snaps whenever the tip returns to the corridor.
let latchRayX = 0;
let latchRayY = 0;

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

/** the polar manipulation frame for a selected node in screen px, or null when it has no previous
 *  node (node 0, the entry anchor) or the chord is degenerate (coincident with its previous node).
 *  rebuilt each pointermove against the live baked positions (the per-move-snapshot contract,
 *  `manipulator.ts`): the radius rides the live chord, so the incline snap window tracks the drag.
 *  the tip carries the previous node's AUTHORED exit heading in **world** radians (`exitWorld` — no
 *  screen y-flip, the manipulator convention) as its incline reference; an interior node leaves it
 *  null (a frozen heading has no incline quantum). */
export function nodeFrame(
    ecs: State,
    s: NonNullable<ReturnType<typeof samples.get>>,
    tx: ViewTx,
    eid: number,
): Frame | null {
    const section = Handle.section.get(eid);
    const order = Handle.order.get(eid);
    const prevEid = handleAt(ecs, section, order - 1);
    if (prevEid === null) return null; // node 0 (the entry anchor) has no polar origin
    const prev = sampleScreen(s, tx, Handle.sample.get(prevEid));
    const sel = sampleScreen(s, tx, Handle.sample.get(eid));
    let tangent: number | null = null;
    if (eid === lastHandle(ecs, section)) {
        // the incline-snap reference is the previous node's AUTHORED exit heading (`exitWorld`) — the
        // SAME quantity the write re-heads the tip against (`headLast`: `reflect(exitHeading(prev),
        // chord)` = 2·chord − exitHeading(prev)), and the same one the resting readout reports. so the
        // snapped incline shown while dragging equals the resting `exitWorld` after release, EXACTLY.
        // (feel round 8: reading a flanking-sample re-derivation here diverged by the recovered-vs-
        // authored heading gap — a −30° drag rested at −32.3° — the round-3 law violated at the write
        // end. the resting readout already reports the authored quantity, so the snap must too.)
        tangent = exitWorld(prevEid);
    }
    const f = polarFrame(prev, sel, Math.abs(tx.sx), tangent);
    return f.degenerate ? null : f;
}

/** a manipulator knob in screen px — which control axis, and its knob's screen point. */
export interface ManipKnob {
    axis: "length" | "angle";
    x: number;
    y: number;
}

/** where a node's two polar-control knobs sit in screen px — on the node-action ring, flanking the
 *  extend button — or null when the node carries no manipulator (node 0 or a degenerate chord). the
 *  one home for the knob geometry (App positions its `.rbtn` buttons from it), the manipulator
 *  analogue of `tangents.ts`'s `tangentHandles`. the drag *loci* are chord-relative and live in
 *  `dragManipTo`; this places only the idle affordance. */
export function manipKnobs(
    ecs: State,
    s: NonNullable<ReturnType<typeof samples.get>>,
    tx: ViewTx,
    eid: number,
): ManipKnob[] | null {
    // gate on a manipulable node — the same condition the drag uses (`nodeFrame`: has a previous
    // node, non-degenerate chord). node 0 and a coincident node get no knobs.
    if (!nodeFrame(ecs, s, tx, eid)) return null;
    // the idle buttons slot into the node-action ring (the shared radial substrate, flanking the
    // extend button at ∓60°). the base angle is the node's AUTHORED exit heading — the same quantity
    // `extend()` lays the next node along, so the extend button points where the append lands even
    // on a node carrying an explicit out-vector (`Handle.theta` is dead there). the drag LOCI stay
    // chord-relative in `dragManipTo` — only where the idle button sits is placed here.
    const base = ringBase(exitWorld(eid), tx.sx, tx.sy);
    const node = sampleScreen(s, tx, Handle.sample.get(eid));
    const len = ringSlot(base, RadialSlot.Length);
    const ang = ringSlot(base, RadialSlot.Angle);
    return [
        { axis: "length", x: node.x + len.x, y: node.y + len.y },
        { axis: "angle", x: node.x + ang.x, y: node.y + ang.y },
    ];
}

/** the polar arrow-nudge target (the manipulators' keyboard twin): step a node around its previous
 *  node — `length` moves it along the chord by `step` world metres, `angle` rotates it around the
 *  previous node by a fixed on-screen arc (`step` metres at the current radius → `step/radius`
 *  radians). `dir` is ±1. the length floor keeps the chord from collapsing onto the previous node.
 *  pure — unit-tested. (the left/right = angle, up/down = length mapping is the spec's proposal; the
 *  feel check-in decides it.) */
export function polarNudge(
    prev: { x: number; y: number },
    node: { x: number; y: number },
    axis: "length" | "angle",
    dir: 1 | -1,
    step: number,
    minChord: number,
): { x: number; y: number } {
    const rx = node.x - prev.x;
    const ry = node.y - prev.y;
    const r = Math.hypot(rx, ry);
    const ang = Math.atan2(ry, rx);
    if (axis === "length") {
        const nr = Math.max(minChord, r + dir * step);
        return { x: prev.x + Math.cos(ang) * nr, y: prev.y + Math.sin(ang) * nr };
    }
    const dA = r > 1e-9 ? (dir * step) / r : 0;
    const na = ang + dA;
    return { x: prev.x + Math.cos(na) * r, y: prev.y + Math.sin(na) * r };
}

/** wrap a degree value into (−180, 180]. */
export function normDeg(d: number): number {
    const w = ((((d + 180) % 360) + 360) % 360) - 180;
    return w === -180 ? 180 : w; // the wrap lands 180° on −180; the readout wants 180
}

/** round to one decimal, then strip an exact trailing `.0` (feel round 11: `5°` not `5.0°`, but
 *  `5.5°` stays). the strip is DETERMINISTIC post-rounding — the string is derived from the
 *  already-rounded value, so `4.999` rounds to `5.0` → displays `5`, with no epsilon window and no
 *  integer↔decimal flicker (unlike the round-10-era pre-rounding branch). normalizes `-0.0` → `0`. */
function oneDecimal(x: number): string {
    const dec = x.toFixed(1);
    const norm = dec === "-0.0" ? "0.0" : dec;
    return norm.endsWith(".0") ? norm.slice(0, -2) : norm;
}

/** format a degree value for the readout — the one degree seam every source funnels through, so a
 *  value formats identically regardless of source (`App.svelte`'s precedence). one decimal with an
 *  exact `.0` dropped. */
export function formatDeg(d: number): string {
    return `${oneDecimal(normDeg(d))}°`;
}

/** format a chord length (metres) for the readout — the one length seam every source funnels
 *  through, the same rule as `formatDeg` (one decimal, `.0` dropped): a whole-metre length reads
 *  `5 m`, a continuous (Ctrl-bypass) length `5.3 m`. */
export function formatLen(m: number): string {
    return `${oneDecimal(m)} m`;
}

/** a selected node's live readout metrics. `lengthLabel` is always present (the chord length to the
 *  previous node); `angleLabel` is the node's world exit heading, present for every node that has a
 *  previous node (interior + tip), null only for a node with none. */
export interface NodeMetrics {
    angleLabel: string | null;
    lengthLabel: string;
}

/** a node's readout metrics from its world position + authored exit heading (device-free — the
 *  caller passes the world points and the world heading). the chord `|node − prev|` to the previous
 *  node is the length; `heading` (world radians, the authored exit direction, or null when there is
 *  none) becomes the angle. formatted like the snap readout (`formatDeg`, integer metres). */
export function nodeMetrics(
    prev: { x: number; y: number },
    node: { x: number; y: number },
    heading: number | null,
): NodeMetrics {
    const chord = Math.hypot(node.x - prev.x, node.y - prev.y);
    const angleLabel = heading === null ? null : formatDeg((heading * 180) / Math.PI);
    return { angleLabel, lengthLabel: formatLen(chord) };
}

/** the selected node's live metrics for the resting snap readout (the Figma selected-object
 *  dimensions idiom): the chord to the previous node + the node's **authored world exit heading**
 *  (`exitWorld` — an explicit out-vector else the stored `Auto` heading, rotated into world by the
 *  section entry frame). every node with a previous node has a real heading — interior nodes read it
 *  too (a frozen heading is still a heading; display is not the snap quantum). null when the
 *  selection has no previous node — node 0 (the entry anchor) has no chord back into its own section,
 *  so the readout stays off it (a load-bearing guard, not defensive). world-space, no view
 *  transform. reports the authored quantity, so it never drifts with a bake re-derivation. */
export function selectedMetrics(ecs: State, eid: number): NodeMetrics | null {
    const s = trackSamples(ecs);
    if (!s) return null;
    const section = Handle.section.get(eid);
    const order = Handle.order.get(eid);
    const prevEid = handleAt(ecs, section, order - 1);
    if (prevEid === null) return null;
    const prev = nodeWorld(s, prevEid);
    const node = nodeWorld(s, eid);
    return nodeMetrics(prev, node, exitWorld(eid));
}

/** advance a manipulator drag: rebuild the polar frame from the live positions, resolve the grabbed
 *  1D control (length along the chord ray, angle along the tangential arc) through the stage-4
 *  inverse, and write the node's new world position. the dead-zone latch keeps a sub-DRAG_PX grab a
 *  plain click; no Shift constrain — each gesture is already 1-DOF. snap-by-default (integer metres /
 *  5° grid), Ctrl/Cmd bypasses. the readout is fed per-control through the one formatting seam
 *  (`formatDeg`/`formatLen`) into the magnet-labels source — the source `startManip` seeded, so it
 *  owns the gesture start-to-end (no mid-gesture switch); a tip angle snap also flashes the guide ray
 *  (world radians — `SnapGuideSystem` maps it to screen, no consumer negation). */
function dragManipTo(ecs: State, canvas: HTMLCanvasElement, e: PointerEvent): void {
    const sel = editor.selection;
    if (sel === null || dragManip === null) return;
    const s = trackSamples(ecs);
    if (!s) return;
    const { x: cx, y: cy } = pointerToCanvas(canvas, e);
    manipArmed = armDrag(manipArmed, cx - manipCX, cy - manipCY);
    if (!manipArmed) return;
    const tx = viewTransform(canvas);
    const f = nodeFrame(ecs, s, tx, sel); // rebuilt per move (live radius — the per-move snapshot)
    if (!f) return;
    // the grab-corrected node target screen point (grabbing a knob off-center doesn't jump the node).
    const ntx = cx + manipDX;
    const nty = cy + manipDY;
    const snap = snapActive(e.ctrlKey || e.metaKey);
    clearGuides();
    if (dragManip === "length") {
        const res = lengthControl(f, ntx, nty, snap); // floored at 1 m inside the resolver
        const p = lengthToPoint(f, res.meters);
        const w = screenToWorld(tx, p.x, p.y);
        dragTo(ecs, sel, w.x, w.y);
        // the chord readout is the authored quantity; the angle readout keeps showing the node's
        // exit heading (continuity with the resting readout — a length drag doesn't touch the angle).
        snapGuides.lengthLabel = formatLen(res.meters);
        snapGuides.angleLabel = formatDeg((exitWorld(sel) * 180) / Math.PI);
    } else {
        const res = angleControl(f, ntx, nty, snap);
        const p = angleToPoint(f, res.angle);
        const w = screenToWorld(tx, p.x, p.y);
        dragTo(ecs, sel, w.x, w.y);
        // the readout reports the AUTHORED exit heading (`exitWorld`, post-write) — the exact quantity
        // the resting readout shows, so drag == rest for a tip AND an interior node (feel round 9, one
        // consistent quantity). at the tip the write re-heads to the snapped incline, so this IS the
        // snapped value; at an interior node the heading is frozen, so the displayed angle stays put
        // while the chord rotates (the accepted tradeoff — the knob snaps the chord, the readout
        // reports the heading). the chord length is constant during an angle drag, shown for continuity.
        snapGuides.angleLabel = formatDeg((exitWorld(sel) * 180) / Math.PI);
        snapGuides.lengthLabel = formatLen(f.radius / f.pxPerMeter);
        if (res.snapped && res.incline !== null) {
            snapGuides.ray = { x: w.x, y: w.y, angle: res.incline };
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
    const latch = latchAngle(cx + grabHX - nsx, cy + grabHY - nsy, latchRayX, latchRayY);
    const { x: worldX, y: worldY } = screenToWorld(tx, nsx + latch.x, nsy + latch.y);

    // the readout reports the dragged node's OWN authored quantities (exit heading + chord to prev),
    // not the handle's angle/length — the same quantities the resting readout shows, re-derived from
    // `selectedMetrics` after the write below (feel round 14). keyed to the dragged handle's node
    // (not the selection), so a boundary-stitch drag reports the downstream node-0. no guide ray: a
    // handle drag expresses, it doesn't snap.
    dragReadout.node = eid;

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

/** wire canvas pointer + window keyboard handling, returning `{ detach, startManip }`. tied to the
 *  canvas lifecycle (called from App's onMount) so listeners attach with the element and detach with
 *  it — no module-flag staleness across reloads. `startManip` is the seam the DOM manipulator knob
 *  buttons (App.svelte) call on pointerdown to enter the drag gesture (captures on the canvas, so the
 *  canvas's own move/up handlers run it). */
export function attachControls(
    canvas: HTMLCanvasElement,
    ecs: State,
): { detach: () => void; startManip: (e: PointerEvent, axis: "length" | "angle") => void } {
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
            if (dragManip !== null || dragTangent !== null) return;
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

        // the selected node's tangent handle wins first — a summoned handle sitting over its
        // node must still grab (the vector-editor priority).
        const th = pickTangentHandle(ecs, tx, cx, cy);
        if (th !== null) {
            dragTangent = { eid: th.eid, side: th.side };
            grabHX = th.x - cx;
            grabHY = th.y - cy;
            // capture the angle-snap landmark: the start ray is the node→knob direction in screen
            // px at grab. a degenerate (node-coincident) handle has no ray, so it never snaps.
            const s = trackSamples(ecs);
            const w = s ? nodeWorld(s, th.eid) : null;
            const rx = w ? th.x - (tx.ox + w.x * tx.sx) : 0;
            const ry = w ? th.y - (tx.oy + w.y * tx.sy) : 0;
            const rl = Math.hypot(rx, ry);
            latchRayX = rl > 1e-6 ? rx / rl : 0;
            latchRayY = rl > 1e-6 ? ry / rl : 0;
            beginMove(ecs, Handle.section.get(th.eid)); // one gesture; the node snapshot carries the tangent
            beginDrag(canvas, e.pointerId);
            return;
        }

        // the manipulator knobs are real DOM `.rbtn` buttons now (App.svelte), so a knob press is a
        // pointerdown on the button → `startManip` (below), not a canvas pick. the canvas sees only
        // the node body, which is select-only:

        // a node body click selects it (movement is via the summoned polar manipulator buttons — no
        // body drag); else select the section under the click; else deselect (Figma-style).
        const eid = pickNode(ecs, tx, cx, cy);
        if (eid !== null) {
            select(eid);
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

    // double-click a node → enter tangent edit (Figma's vector-edit summon; feel round 12 restored
    // this from Alt-click — it's more discoverable). its in/out handles appear (the same toggle as
    // the node menu's Handles item). works on any pickable node — chain-end, interior, and node 0 at
    // the START diamond (a double-click there, no draggable node, reaches the first section's node 0
    // for its entry handle; at a geo→geo boundary the double-click lands on the coincident tip, whose
    // tangent edit stitches in node 0's out-handle). the two constituent clicks each select the node;
    // this fires after, so the final state is the node selected + in edit. append is the ring's extend
    // button, Enter, or the node menu — not double-click.
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
        if (dragManip !== null) {
            dragManipTo(ecs, canvas, e);
            return;
        }
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
    // handlers own only the gesture's own state (pan flag / manipulator / tangent + history).
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
        if (dragManip === null) return;
        dragManip = null;
        manipArmed = false;
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
        if (dragManip === null) return;
        dragManip = null;
        manipArmed = false;
        clearGuides();
        cancel(); // interrupted drag: restore the pre-gesture pose
    };

    // a window blur mid-gesture never delivers the pointerup/pointercancel that would end the drag,
    // so without this the gesture resumes stale on refocus — a guide left on screen, the drag
    // reattaching to the old node on the next move. tear it down like a pointercancel: revert the
    // bracketed edit, drop the drag/pan state (cancelDrag), and clear the capture flag (endDrag).
    const onBlur = (): void => {
        if (dragManip === null && dragTangent === null && !panning) return;
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
            if (dragManip === null && !panning) frameViewport(ecs, canvas);
            return;
        }

        // arrow-nudge the selected node in the polar frame around its previous node (the
        // manipulators' keyboard twin): left/right rotate the chord angle, up/down change the chord
        // length — a fixed on-screen step (Shift = coarse), one press = one undo entry (holding
        // auto-repeats to many). gated on the viewport hover (the hovered-surface router) so it can't
        // also fire over the timeline — that cross-surface playhead/force-point collision. (the
        // mapping is the spec's proposal; the feel check-in decides it.)
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
            if (dragManip !== null || panning || Handle.order.get(eid) === 0 || !s) return;
            if (!(camera.zoom > 0)) return; // pre-framing: no scale to convert px through
            const prevEid = handleAt(ecs, Handle.section.get(eid), Handle.order.get(eid) - 1);
            if (prevEid === null) return; // a non-anchor node always has a previous node
            e.preventDefault();
            const step = (e.shiftKey ? NUDGE_PX_COARSE : NUDGE_PX) / camera.zoom;
            const axis = e.key === "ArrowUp" || e.key === "ArrowDown" ? "length" : "angle";
            const dir = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : -1;
            const t = polarNudge(
                nodeWorld(s, prevEid),
                nodeWorld(s, eid),
                axis,
                dir,
                step,
                LENGTH_MIN,
            );
            beginMove(ecs, Handle.section.get(eid));
            dragTo(ecs, eid, t.x, t.y);
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

    // begin a manipulator drag from a pointerdown on a DOM knob button (App.svelte). the buttons are
    // real `.rbtn` elements now (feel round 6, for hover/active/cursor for free), so the gesture
    // enters HERE rather than through a canvas pick: capture the pointer ON THE CANVAS (`beginDrag`),
    // so every subsequent move/up routes through the canvas's own `onPointerMove`/`endDrag` — the
    // exact same pipeline the drag used before (dead-zone latch, inverses, readout, snap guide, blur
    // teardown all unchanged). the dead-zone keeps a press-release-without-drag a plain click (no
    // move). seed the readout so ONE source owns the gesture start-to-end (no flicker, feel round 6).
    const startManip = (e: PointerEvent, axis: "length" | "angle"): void => {
        const sel = editor.selection;
        if (sel === null || panning || dragTangent !== null) return;
        const s = trackSamples(ecs);
        if (!s) return;
        const { x: cx, y: cy } = pointerToCanvas(canvas, e);
        const tx = viewTransform(canvas);
        dragManip = axis;
        manipArmed = false;
        manipCX = cx;
        manipCY = cy;
        const ns = sampleScreen(s, tx, Handle.sample.get(sel));
        manipDX = ns.x - cx;
        manipDY = ns.y - cy;
        const m = selectedMetrics(ecs, sel); // seed the magnet-labels source (owns the gesture)
        if (m) {
            snapGuides.angleLabel = m.angleLabel;
            snapGuides.lengthLabel = m.lengthLabel;
        }
        beginMove(ecs, Handle.section.get(sel)); // open the drag gesture; commit/cancel on release
        beginDrag(canvas, e.pointerId); // capture on the canvas → its move/up handlers run the drag
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

    const detach = (): void => {
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

    return { detach, startManip };
}
