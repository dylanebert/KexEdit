import type { State } from "@dylanebert/shallot";
import {
    type CutPosition,
    nodeActs,
    nodeCuttable,
    sectionActs,
    sectionEditable,
    sectionOpsAllowed,
} from "./acts";
import {
    beginDrag,
    clearHover,
    editor,
    endDrag as endDragGesture,
    enterTangentEdit,
    exitTangentEdit,
    type Hover,
    openContext,
    openForceMenu,
    openNodeMenu,
    select,
    selectForce,
    selectNodes,
    selectSection,
    selectStart,
    selectStrip,
    snapActive,
    toggleSnap,
    writeHover,
} from "./editor";
import { hits, merge, normRect } from "./marquee";
import { beginMove, beginMoves, cancel, commit, commitChord, history } from "./history";
import {
    angleControl,
    angleToPoint,
    type ChainNode,
    chordFrame,
    type ChordFrame,
    chordNudge,
    offsetControl,
    offsetToPoint,
    polarDelta,
    polarFrame,
    lengthControl,
    lengthToPoint,
    slideControl,
    slideToPoint,
    type Frame,
} from "./manipulator";
import { playheadPosition } from "./cart";
import { nodeKeyAct, sectionKeyAct } from "./keys";
import { LENGTH_MIN } from "./magnet";
import { BINDINGS, bound } from "./menu";
import { RadialSlot, ringBase, ringSlot } from "./radial";
import { localize } from "./section";
import { editTangent, TangentMode } from "./spline";
import { editHandleSets, localTipAt, type TangentSide } from "./tangents";
import {
    exitWorld,
    forceMarkers,
    bakeLive,
    Handle,
    handleAt,
    handleTangent,
    lastHandle,
    reheadOnDrag,
    samples,
    SectionKind,
    sectionCutAt,
    sectionHandles,
    sectionInfo,
    sectionResettable,
    sections,
    sectionSpans,
    seedTangent,
    setTangent,
    Track,
    trackEntity,
} from "./track";
import { fmt } from "./timeline";
import {
    camera,
    clearGuides,
    dragReadout,
    frameContent,
    marquee,
    panCamera,
    pointerToCanvas,
    screenToWorld,
    setCamera,
    snapGuides,
    viewTransform,
    type ViewTx,
    zoomAt,
} from "./view";

export const PICK_R = 16;
const SECTION_PICK_R = 12;
const START_PICK_R = 12;
// force-marker pick radius (px) — the anchor-diamond scale, under the node radius: a node
// within reach still wins (markers slot BETWEEN node and START in pick priority).
const FORCE_PICK_R = 12;
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
// the tangent-edit free node-body drag (kex2d-node-move-ux stage 3): grabbing the tangent-edited
// node's own body moves it directly — the summoned inner layer's own unsnapped idiom (mirrors
// `dragTangent`'s no-raster/no-guide feel), distinct from `dragManip` (the default surface's
// polar knobs; the body stays select-only there). mutually exclusive with `dragManip` +
// `dragTangent` + `panning` — one gesture at a time; the tangent-handle grab (below) still wins
// pick priority over the node body.
let dragNode: number | null = null;
// the dead-zone latch + grab-offset state, the same shape as `dragManip`'s (`manipArmed`/
// `manipDX`/`manipDY`/`manipCX`/`manipCY`).
let nodeArmed = false;
let nodeDX = 0;
let nodeDY = 0;
let nodeCX = 0;
let nodeCY = 0;

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

// marquee (box-select) state: a left-drag begun on empty viewport space (after the pick
// fall-through finds nothing). mutually exclusive with the manip/tangent/pan gestures — it
// starts only when none of them grabbed. `armed` follows the shared dead-zone latch: below
// DRAG_PX the press stays a plain click (the existing deselect-on-empty-click), and only past it
// does a rect appear and the merge fire on release. `shift` (captured at grab) picks replace vs
// toggle. no history gesture — a selection change is not an undoable command.
let dragMarquee = false;
let marqueeArmed = false;
let marqueeX0 = 0;
let marqueeY0 = 0;
let marqueeShift = false;

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

/** a node's AUTHORED section-local position (`Handle.pos`) — the live write target, one frame
 *  ahead of the bake. the polar nudge resolves its chord/angle geometry from this, not `nodeWorld`:
 *  the bake's node→sample map rebuilds a frame after a write lands, so a fast double-nudge reading
 *  `nodeWorld` twice inside one frame both read the same stale sample and the second overwrites the
 *  first (`kex2d-harness.md`'s bake-readiness law). Sufficient because of rigid entry-frame
 *  placement (`section.ts`): a section-local chord equals its world chord exactly, and the nudged
 *  node's own previous node shares the same local frame — so the polar geometry round-trips
 *  entirely in local coordinates, with no `place`/`localize` needed. */
function nodeLocal(eid: number): { x: number; y: number } {
    return { x: Handle.pos.x.get(eid), y: Handle.pos.y.get(eid) };
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

/** the force marker nearest the screen point (within the pick radius), or its stable
 *  keyframe id — kex2d-idioms stage 3: the viewport markers are pickable (select + the
 *  keyframe context menu) but never draggable (s/g authoring stays on the chart). slots
 *  between the node pick and the START anchor in every sweep — a node within reach wins,
 *  a marker beats the diamond/section under it. exported for the pick tests. */
export function pickForce(ecs: State, tx: ViewTx, sx: number, sy: number): number | null {
    return nearestForce(ecs, tx, sx, sy)?.id ?? null;
}

/** the nearest force marker within the pick radius plus its screen distance² — the core
 *  `pickForce` and the START tie-break (`pickForceOrStart`) share. */
function nearestForce(
    ecs: State,
    tx: ViewTx,
    sx: number,
    sy: number,
): { id: number; d2: number } | null {
    let best: { id: number; d2: number } | null = null;
    let bestD2 = FORCE_PICK_R * FORCE_PICK_R;
    for (const m of forceMarkers(ecs)) {
        const dx = sx - (tx.ox + m.x * tx.sx);
        const dy = sy - (tx.oy + m.y * tx.sy);
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
            bestD2 = d2;
            best = { id: m.id, d2 };
        }
    }
    return best;
}

/** the screen distance² to the track START anchor when within its pick radius, else null.
 *  START is the first section's entry — sample 0, the world origin the diamond draws at
 *  (`AnchorDrawSystem`) — regardless of the section's kind. */
function startD2(ecs: State, tx: ViewTx, sx: number, sy: number): number | null {
    const s = trackSamples(ecs);
    if (!s) return null;
    const dx = sx - (tx.ox + s.posX[0] * tx.sx);
    const dy = sy - (tx.oy + s.posY[0] * tx.sy);
    const d2 = dx * dx + dy * dy;
    return d2 < START_PICK_R * START_PICK_R ? d2 : null;
}

/** true when the screen point hits the track START anchor (the dblclick path's read). */
function pickStart(ecs: State, tx: ViewTx, sx: number, sy: number): boolean {
    return startD2(ecs, tx, sx, sy) !== null;
}

/** the force-marker vs START resolution every pointer sweep shares. Both pick at r = 12 and
 *  a force-first section's s = 0 seed keyframe sits exactly ON the START diamond, so a fixed
 *  force-before-START order would leave START — the only path to the v0 popover —
 *  permanently unclickable. Nearest wins; an exact tie goes to START (the coincident seed
 *  stays reachable on the chart). Node priority stays above both — callers pick nodes first.
 *  exported for the pick tests. */
export function pickForceOrStart(
    ecs: State,
    tx: ViewTx,
    sx: number,
    sy: number,
): { kind: "force"; id: number } | { kind: "start" } | null {
    return forceOrStart(nearestForce(ecs, tx, sx, sy), startD2(ecs, tx, sx, sy));
}

/** the tie rule itself, over readings already taken — so a caller that needs the nearest
 *  marker for its own fallback (the contextmenu's force-first START branch) resolves it once
 *  and asks this, instead of walking `forceMarkers` a second time. */
function forceOrStart(
    f: { id: number; d2: number } | null,
    s: number | null,
): { kind: "force"; id: number } | { kind: "start" } | null {
    if (s !== null && (f === null || s <= f.d2)) return { kind: "start" };
    return f !== null ? { kind: "force", id: f.id } : null;
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

/** the pointermove hover sweep, pure and DOM-free — the four pickers run in the same PICK
 *  order `onPointerDown` grabs by (a summoned knob wins first, then its node, then a force
 *  marker, else the section span), so exactly one of the four reads lights: a handle over its
 *  node still reads as the knob, matching what a click would take. `onPointerMove` is the only
 *  caller; factored out so the wiring is unit-testable without a canvas. */
export function pickHover(ecs: State, tx: ViewTx, sx: number, sy: number): Hover {
    const th = pickTangentHandle(ecs, tx, sx, sy);
    const knob = th !== null ? { eid: th.eid, side: th.side } : null;
    const node = th === null ? pickNode(ecs, tx, sx, sy) : null;
    const fs = th === null && node === null ? pickForceOrStart(ecs, tx, sx, sy) : null;
    const force = fs !== null && fs.kind === "force" ? fs.id : null;
    const section =
        th === null && node === null && force === null ? pickSection(ecs, tx, sx, sy) : null;
    return { knob, node, force, section };
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

/** a selected node's manipulation frame, screen px — the polar frame for a growth tip (`kind:
 *  "polar"`), the neighbor-chord frame for an interior node (`kind: "chord"`, kex2d-node-move-ux
 *  stage 2). the discriminant is what forks `dragManipTo`/`manipKnobs`'s degenerate gate, never a
 *  node-kind flag threaded separately — the frame IS the fork. */
export type NodeFrame = { kind: "polar"; frame: Frame } | { kind: "chord"; frame: ChordFrame };

/** the selected node's manipulation frame, or null when it has no previous node (node 0, the entry
 *  anchor) or its frame is degenerate (a coincident neighbor). rebuilt each pointermove against the
 *  live baked positions (the per-move-snapshot contract, `manipulator.ts`): a tip's `polarFrame`
 *  rides the live chord (the incline snap window tracks the drag); an interior node's `chordFrame`
 *  rides `prev`/`next`, which never move (frozen neighbors) — only its own `slide0`/`offset0` track
 *  the live position. the tip carries the previous node's AUTHORED exit heading in **world** radians
 *  (`exitWorld` — no screen y-flip, the manipulator convention) as its incline reference. */
export function nodeFrame(
    ecs: State,
    s: NonNullable<ReturnType<typeof samples.get>>,
    tx: ViewTx,
    eid: number,
): NodeFrame | null {
    const section = Handle.section.get(eid);
    const order = Handle.order.get(eid);
    const prevEid = handleAt(ecs, section, order - 1);
    if (prevEid === null) return null; // node 0 (the entry anchor) has no polar origin
    const prev = sampleScreen(s, tx, Handle.sample.get(prevEid));
    const sel = sampleScreen(s, tx, Handle.sample.get(eid));
    if (eid === lastHandle(ecs, section)) {
        // the incline-snap reference is the previous node's AUTHORED exit heading (`exitWorld`) — the
        // SAME quantity the write re-heads the tip against (`headLast`: `reflect(exitHeading(prev),
        // chord)` = 2·chord − exitHeading(prev)), and the same one the resting readout reports. so the
        // snapped incline shown while dragging equals the resting `exitWorld` after release, EXACTLY.
        // (feel round 8: reading a flanking-sample re-derivation here diverged by the recovered-vs-
        // authored heading gap — a −30° drag rested at −32.3° — the round-3 law violated at the write
        // end. the resting readout already reports the authored quantity, so the snap must too.)
        const f = polarFrame(prev, sel, Math.abs(tx.sx), exitWorld(prevEid));
        return f.degenerate ? null : { kind: "polar", frame: f };
    }
    // interior: both neighbors exist and stay frozen — the chord frame anchors on prev→next
    // instead of orbiting the dragged node (kex2d-node-move-ux stage 2, retiring the interior
    // chord-angle-snap law: an interior node no longer drags a polar frame at all).
    const nextEid = handleAt(ecs, section, order + 1);
    if (nextEid === null) return null; // unreachable: `lastHandle` above already caught the tip
    const next = sampleScreen(s, tx, Handle.sample.get(nextEid));
    // screen-built (y grows downward) — `chordFrame` folds the handedness so +offset lands on the
    // same world side `chordNudge`'s local-space build reads (the cross-space adversarial finding).
    const f = chordFrame(prev, next, sel, Math.abs(tx.sx), true);
    return f.degenerate ? null : { kind: "chord", frame: f };
}

/** a manipulator knob in screen px — which RING SLOT (`"length"` the slot nearer the extend button,
 *  `"angle"` the far one) and its knob's screen point. the slot identity is stable across node
 *  kind — an interior node's `"length"` slot drags SLIDE, its `"angle"` slot drags OFFSET
 *  (kex2d-node-move-ux stage 2's knob remap: same two ring buttons, `dragManipTo` resolves which
 *  control each drives off `nodeFrame`'s discriminant). */
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

/** whether Delete is valid on a section SET — the last-section floor (`deleteSection`'s own guard,
 *  lifted to the set): a set smaller than the total section count, never every section (one must
 *  survive). the single-section case (`selected` = 1) reduces to `total > 1`, today's enablement.
 *  pure — device-free, unit-tested; the bulk row grays out otherwise (never hidden). */
export function sectionsDeletable(selected: number, total: number): boolean {
    return selected > 0 && selected < total;
}

/** whether a selected section SET is Join-able — a contiguous run of ≥2 sections, all one
 *  KIND (`joinNext`'s own same-kind guard, lifted to the set): every id resolves to a row,
 *  sorted by chain order the run is unbroken (no gap, no cross-run pick — a skipped section
 *  in the middle disqualifies the whole set), and every row shares one `kind`. pure —
 *  device-free, unit-tested; the bulk row grays out otherwise (never hidden), mirroring
 *  `sectionsDeletable`. `history.joinSections` guards its own copy of this law reading the
 *  LIVE section table (the `removeSections`/`sectionsDeletable` precedent — the op and the
 *  UI predicate stay two small guards rather than one importing the other, since `history.ts`
 *  can't reach back into `controls.ts`). deduped the same way `joinSections` dedupes its own
 *  `ids` (a `Set`) — the two laws read the same input shape, so a duplicated id can't make
 *  them disagree at that edge (not reachable today, since `editor.sections.ids` is itself a
 *  `Set`, but the two copies must still agree on paper). */
export function sectionsJoinable(
    ids: readonly number[],
    sections: readonly { id: number; order: number; kind: SectionKind }[],
): boolean {
    const targets = new Set(ids);
    if (targets.size < 2) return false;
    const rows: { order: number; kind: SectionKind }[] = [];
    for (const id of targets) {
        const row = sections.find((s) => s.id === id);
        if (!row) return false; // a stale id — not a valid run
        rows.push(row);
    }
    rows.sort((a, b) => a.order - b.order);
    const kind = rows[0].kind;
    for (let i = 0; i < rows.length; i++) {
        if (rows[i].kind !== kind) return false;
        if (i > 0 && rows[i].order !== rows[i - 1].order + 1) return false;
    }
    return true;
}

/** wrap a degree value into (−180, 180]. */
export function normDeg(d: number): number {
    const w = ((((d + 180) % 360) + 360) % 360) - 180;
    return w === -180 ? 180 : w; // the wrap lands 180° on −180; the readout wants 180
}

/** format a degree value for the readout — the one degree seam every source funnels through, so a
 *  value formats identically regardless of source (`App.svelte`'s precedence). one decimal with an
 *  exact `.0` dropped (`fmt`, the shared trim, `5°` not `5.0°` but `5.5°` stays). */
export function formatDeg(d: number): string {
    return `${fmt(normDeg(d), 1)}°`;
}

/** format a chord length (metres) for the readout — the one length seam every source funnels
 *  through, the same rule as `formatDeg` (one decimal, `.0` dropped): a whole-metre length reads
 *  `5 m`, a continuous (Ctrl-bypass) length `5.3 m`. */
export function formatLen(m: number): string {
    return `${fmt(m, 1)} m`;
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

/** the distinct sections the selected node set spans — what one group-move undo entry covers, and
 *  the grouping the per-section delta application walks. */
function sectionsOf(ecs: State, ids: Iterable<number>): number[] {
    const out: number[] = [];
    for (const eid of ids) {
        if (!ecs.has(eid, Handle)) continue;
        const sec = Handle.section.get(eid);
        if (!out.includes(sec)) out.push(sec);
    }
    return out;
}

/** a group move's frozen start snapshot for one section: the full section-local chain at gesture
 *  start (`ChainNode[]`) + the selected orders within it. `applyMultiDelta` reads start positions
 *  from here so a cumulative-from-start delta lands absolute, not accumulated. */
interface FrozenSection {
    chain: ChainNode[];
    selected: Set<number>;
}

/** freeze each affected section's section-local chain + its selected orders at group-move start.
 *  production passes `editor.nodes.ids`; a test passes an explicit id set. the chain reads the LIVE
 *  positions once, at the freeze — every subsequent `applyMultiDelta` reads back from the frozen
 *  copy, so it's the delta's fixed zero for the whole gesture. */
export function freezeChains(ecs: State, ids: Iterable<number>): Map<number, FrozenSection> {
    const out = new Map<number, FrozenSection>();
    for (const eid of ids) {
        if (!ecs.has(eid, Handle)) continue;
        const sec = Handle.section.get(eid);
        let fs = out.get(sec);
        if (!fs) {
            fs = {
                chain: sectionHandles(ecs, sec).map((h) => ({
                    order: Handle.order.get(h),
                    x: Handle.pos.x.get(h),
                    y: Handle.pos.y.get(h),
                })),
                selected: new Set<number>(),
            };
            out.set(sec, fs);
        }
        fs.selected.add(Handle.order.get(eid));
    }
    return out;
}

/** apply one shared polar `delta` to a group move's FROZEN start snapshot — per section, run its
 *  frozen start chain + selected orders through `polarDelta` (ascending order, running-prev anchor —
 *  each node in its own polar frame) and write each moved node's local position to LIVE `Handle.pos`,
 *  then rehead the section tip when it is itself in the moved set. the contract is reads
 *  come from the frozen start, writes go to live: so a cumulative-from-start delta lands absolute —
 *  applying `d` then `d'` from the same snapshot equals a single application of `d'`, no accumulation
 *  (the positions a previous frame moved are never re-read as the next frame's start). */
export function applyMultiDelta(
    ecs: State,
    chains: Map<number, FrozenSection>,
    axis: "length" | "angle",
    delta: number,
): void {
    for (const [sec, fs] of chains) {
        const targets = polarDelta(fs.chain, fs.selected, axis, delta, LENGTH_MIN);
        for (const eid of sectionHandles(ecs, sec)) {
            const p = targets.get(Handle.order.get(eid));
            if (p) Handle.pos.set(eid, p.x, p.y);
        }
        const tip = lastHandle(ecs, sec);
        // the tip re-heads only on its OWN move (reheadOnDrag's single-drag law): polarDelta moves
        // only selected nodes, so an unselected tip stayed put and re-heading it would swing the
        // last segment under a gesture that never touched it.
        if (tip !== null && fs.selected.has(Handle.order.get(tip))) reheadOnDrag(ecs, tip);
    }
}

/** advance a manipulator drag: rebuild the node's frame from the live positions, resolve the
 *  grabbed ring slot through its **kind-appropriate** control — a tip's `"length"`/`"angle"` slots
 *  drive `lengthControl`/`angleControl` over its `polarFrame` (length along the chord ray, angle
 *  along the tangential arc); an interior node's SAME two slots drive `slideControl`/`offsetControl`
 *  over its `chordFrame` instead (kex2d-node-move-ux stage 2's knob remap — the ring buttons don't
 *  move, only what they resolve to). the dead-zone latch keeps a sub-DRAG_PX grab a plain click; no
 *  Shift constrain — each gesture is already 1-DOF. snap-by-default (the two configured grids,
 *  `settings.ts`, defaults 1 m / 5° for the tip; a plain 1 m grid both axes for an interior node —
 *  there is no angle grid on it any more), Ctrl/Cmd bypasses. The readout is fed per-control through
 *  the one formatting seam into the magnet-labels source — the source `startManip` seeded, so it
 *  owns the gesture start-to-end (no mid-gesture switch); a tip angle snap also flashes the guide ray
 *  (world radians — `SnapGuideSystem` maps it to screen, no consumer negation); an interior drag
 *  flashes none (no incline to display, same as its old frozen-heading behavior). */
function dragManipTo(ecs: State, canvas: HTMLCanvasElement, e: PointerEvent): void {
    const sel = editor.selection;
    if (sel === null || dragManip === null) return;
    const s = trackSamples(ecs);
    if (!s) return;
    const { x: cx, y: cy } = pointerToCanvas(canvas, e);
    manipArmed = armDrag(manipArmed, cx - manipCX, cy - manipCY);
    if (!manipArmed) return;
    const tx = viewTransform(canvas);
    const nf = nodeFrame(ecs, s, tx, sel); // rebuilt per move (live radius — the per-move snapshot)
    if (!nf) return;
    // the grab-corrected node target screen point (grabbing a knob off-center doesn't jump the node).
    const ntx = cx + manipDX;
    const nty = cy + manipDY;
    const snap = snapActive(e.ctrlKey || e.metaKey);
    clearGuides();
    if (nf.kind === "chord") {
        const f = nf.frame;
        // interior: the ring's "length" slot drags SLIDE (∥), "angle" drags OFFSET (⊥) — both
        // through the same 1 m grid, sign preserved on offset. mid-drag readout shows both axes'
        // CURRENT metres (the one just resolved, plus the frame's own anchor for the other) —
        // plain wording, a feel-round knob; the resting readout stays heading + chord, untouched.
        if (dragManip === "length") {
            const res = slideControl(f, ntx, nty, snap);
            const p = slideToPoint(f, res.meters);
            const w = screenToWorld(tx, p.x, p.y);
            dragTo(ecs, sel, w.x, w.y);
            snapGuides.lengthLabel = `∥ ${formatLen(res.meters)}`;
            snapGuides.angleLabel = `⊥ ${formatLen(f.offset0)}`;
        } else {
            const res = offsetControl(f, ntx, nty, snap);
            const p = offsetToPoint(f, res.meters);
            const w = screenToWorld(tx, p.x, p.y);
            dragTo(ecs, sel, w.x, w.y);
            snapGuides.angleLabel = `⊥ ${formatLen(res.meters)}`;
            snapGuides.lengthLabel = `∥ ${formatLen(f.slide0)}`;
        }
        return;
    }
    const f = nf.frame;
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
        // the resting readout shows, so drag == rest for a tip (feel round 9). the write re-heads to
        // the snapped incline, so this IS the snapped value. the chord length is constant during an
        // angle drag, shown for continuity.
        snapGuides.angleLabel = formatDeg((exitWorld(sel) * 180) / Math.PI);
        snapGuides.lengthLabel = formatLen(f.radius / f.pxPerMeter);
        if (res.snapped && res.incline !== null) {
            snapGuides.ray = { x: w.x, y: w.y, angle: res.incline };
        }
    }
}

/** the marquee's candidate points: every **draggable** geo node in screen px — the same set
 *  `pickNode` grabs (order-0 entry anchors excluded), so the box selects the authoring atoms and
 *  never node 0 / START / a section span (the locked decision). */
function nodeCandidates(
    ecs: State,
    s: NonNullable<ReturnType<typeof samples.get>>,
    tx: ViewTx,
): { id: number; x: number; y: number }[] {
    const out: { id: number; x: number; y: number }[] = [];
    for (const eid of ecs.query([Handle])) {
        if (Handle.order.get(eid) === 0) continue; // the entry anchor is not an authoring atom
        const w = nodeWorld(s, eid);
        out.push({ id: eid, x: tx.ox + w.x * tx.sx, y: tx.oy + w.y * tx.sy });
    }
    return out;
}

/** advance a marquee drag: arm past the dead zone, then publish the normalized rect for the render
 *  overlay (screen px — the camera never moves mid-marquee, so no view transform is needed). below
 *  the dead zone there is no rect (the press is still a plain click). */
function dragMarqueeTo(canvas: HTMLCanvasElement, e: PointerEvent): void {
    const { x: cx, y: cy } = pointerToCanvas(canvas, e);
    marqueeArmed = armDrag(marqueeArmed, cx - marqueeX0, cy - marqueeY0);
    marquee.rect = marqueeArmed ? normRect(marqueeX0, marqueeY0, cx, cy) : null;
}

/** finish a marquee on release: an un-armed press was a plain click (the existing deselect-on-empty
 *  behavior; shift-click preserves the selection). an armed one collects the hits under the rect,
 *  merges them into the node set (replace, or toggle under shift), and applies — an empty plain
 *  marquee deselecting all, like an empty click. clears the rect + drag state either way. */
function finishMarquee(ecs: State, canvas: HTMLCanvasElement): void {
    const armed = marqueeArmed;
    const rect = marquee.rect;
    const shift = marqueeShift;
    dragMarquee = false;
    marqueeArmed = false;
    marquee.rect = null;
    if (!armed || !rect) {
        if (!shift) {
            select(null);
            selectForce(null); // markers select in the viewport now, so empty-click clears them too
            selectSection(null);
            selectStart(false);
            selectStrip(null); // the header band's own selection, cleared by every other surface's empty-click
        }
        return;
    }
    const s = trackSamples(ecs);
    if (!s) return;
    const tx = viewTransform(canvas);
    const res = merge(
        editor.nodes,
        hits(rect, nodeCandidates(ecs, s, tx)),
        shift ? "toggle" : "replace",
    );
    if (!shift && res.ids.length === 0) {
        select(null);
        selectForce(null); // an empty plain marquee deselects all, like an empty click
        selectSection(null);
        selectStart(false);
        selectStrip(null);
    } else {
        selectNodes(res.ids, res.active);
    }
}

/** cancel a marquee (Esc / blur / pointercancel) — drop the rect + drag state, no selection change. */
function cancelMarquee(): void {
    dragMarquee = false;
    marqueeArmed = false;
    marquee.rect = null;
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
 *  against the node's section entry (identity for the first section). returns false
 *  with no live entry (nothing written). */
function placeNode(eid: number, worldX: number, worldY: number): boolean {
    const entry = sectionInfo.get(Handle.section.get(eid))?.entry;
    if (!entry) return false;
    const local = localize(entry, { x: worldX, y: worldY, theta: 0 });
    Handle.pos.set(eid, local.x, local.y);
    return true;
}

/** the default surface's node write: place, then refresh the tip re-head (the tip
 *  re-heads on its own move — `reheadOnDrag`'s law). the manipulator drags land here. */
function dragTo(ecs: State, eid: number, worldX: number, worldY: number): void {
    if (placeNode(eid, worldX, worldY)) reheadOnDrag(ecs, eid);
}

/** write a tangent-edit free node-body drag's target — the summoned inner layer's node write,
 *  `dragTo`'s twin. inside tangent edit the subject's body drag is AUTHORING: the first armed
 *  move lazy-stamps the still-`Auto` node's tangents concrete (seeded from the live arc rule via
 *  `seedTangent` — visually continuous, so no jump; `beginMove`'s grab snapshot already carries
 *  the pre-stamp state, so the stamp rides the move's one undo entry), and the write never
 *  re-heads — `dragTo` → `reheadOnDrag` would swing the displayed ghost handle to the
 *  circular-arc reflection every pointermove. Aligned is the seed mode: node 0 never reaches the
 *  body drag (`pickNode` skips it), so there is no Free entry-handle case here. */
export function dragFreeTo(ecs: State, eid: number, worldX: number, worldY: number): void {
    const section = Handle.section.get(eid);
    const order = Handle.order.get(eid);
    if (handleTangent(ecs, section, order) === undefined) {
        const seed = seedTangent(ecs, section, order, TangentMode.Aligned);
        if (seed) setTangent(ecs, section, order, seed);
    }
    placeNode(eid, worldX, worldY);
}

/** advance a tangent-edit free node-body drag: fold in the grab offset, map to world, and write
 *  through `dragFreeTo` — unsnapped, no raster, no guides (the summoned inner layer's idiom,
 *  `dragTangentTo`'s twin). the dead-zone latch still gates a plain click from moving the node. */
function dragNodeTo(ecs: State, canvas: HTMLCanvasElement, e: PointerEvent): void {
    if (dragNode === null) return;
    const { x: cx, y: cy } = pointerToCanvas(canvas, e);
    nodeArmed = armDrag(nodeArmed, cx - nodeCX, cy - nodeCY);
    if (!nodeArmed) return;
    const tx = viewTransform(canvas);
    const w = screenToWorld(tx, cx + nodeDX, cy + nodeDY);
    dragFreeTo(ecs, dragNode, w.x, w.y);
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
            // openNodeMenu promotes a right-clicked SET member to active (keeping the set — the bulk
            // rows act on it) and replace-selects a non-member (today's single-select), so the menu
            // never collapses a multi-selection on a right-click (the Blender active-object grammar).
            openNodeMenu(e.clientX, e.clientY, node);
            return;
        }
        // a force marker (kex2d-idioms stage 3) opens the KEYFRAME context menu — the same
        // menu, rows, and promote-vs-replace law as the chart diamond (`openForceMenu`
        // promotes a right-clicked set member to active, replace-selects a non-member).
        // marker vs START resolves nearest-wins (`pickForceOrStart`); a winning START
        // reaches node 0's menu on a geo-first track, and a force-first track has no node 0,
        // so the coincident seed keyframe's menu opens instead.
        const near = nearestForce(ecs, tx, cx, cy); // the one marker walk both branches read
        const fs = forceOrStart(near, startD2(ecs, tx, cx, cy));
        if (fs !== null) {
            if (fs.kind === "force") {
                openForceMenu(e.clientX, e.clientY, fs.id);
                return;
            }
            const n0 = startNode0(ecs);
            if (n0 !== null) {
                openNodeMenu(e.clientX, e.clientY, n0);
                return;
            }
            if (near !== null) {
                openForceMenu(e.clientX, e.clientY, near.id);
                return;
            }
        }
        // right-click a section span → the menu (Convert/Pin/Reset/Delete), Cut OMITTED: the
        // canvas is a spatial view, and a position-along-arclength op has no honest home there
        // (`editor-ui.md` Menus, the surface axis — the viewport picking lens that used to resolve a
        // cut point here, `pickSectionArc`/`pickCut`, is gone). `cutSurface` defaults to `false`,
        // so `openContext` needs no third/fourth argument here.
        const sec = pickSection(ecs, tx, cx, cy);
        if (sec !== null) openContext(e.clientX, e.clientY, sec);
    };

    const onPointerDown = (e: PointerEvent): void => {
        // middle-drag pans the viewport — the same gesture the timeline uses (one
        // vocabulary). left picks/drags; right owns the section context menu. pan and
        // node-drag are mutually exclusive: refuse to start one while the other is live,
        // so a second button press can't leak pointer capture or an open history gesture.
        if (e.button === 1) {
            if (dragManip !== null || dragTangent !== null || dragNode !== null) return;
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
        if (th !== null && sectionEditable(editor.pinning, Handle.section.get(th.eid))) {
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
            select(eid, e.shiftKey ? "toggle" : "replace"); // shift-click toggles the set
            // free move inside tangent edit (kex2d-node-move-ux stage 3): the summoned inner layer
            // is already an unsnapped, no-guide gesture surface (handle drags) — a body grab on
            // its OWN tangent-edited node moves it freely instead of staying select-only. re-reads
            // `editor.tangentEdit` AFTER `select` (a shift-toggle that just dropped this node from
            // the set exits tangent edit too, and must not also start a drag). node 0 never reaches
            // here (`pickNode` skips it); `sectionEditable` mirrors the same in-mode guard every
            // other grab on this node's section carries (`dragTangent`, `startManip`).
            if (
                editor.tangentEdit === eid &&
                sectionEditable(editor.pinning, Handle.section.get(eid))
            ) {
                const s = trackSamples(ecs);
                if (s) {
                    dragNode = eid;
                    nodeArmed = false;
                    nodeCX = cx;
                    nodeCY = cy;
                    const ns = sampleScreen(s, tx, Handle.sample.get(eid));
                    nodeDX = ns.x - cx;
                    nodeDY = ns.y - cy;
                    beginMove(ecs, Handle.section.get(eid));
                    beginDrag(canvas, e.pointerId);
                }
            }
            return;
        }
        // a force marker (kex2d-idioms stage 3): select only — same entity as the timeline
        // diamond, so the selection routes through the one selectForce (shift-click toggles the
        // set, the multiselect grammar). NO drag: s/g authoring stays on the chart (one
        // authoring surface per quantity), so a grab here is a plain click whatever it does next.
        // marker vs the START anchor (initial-speed handle) resolves nearest-wins
        // (`pickForceOrStart` — ties to START, so a force-first seed can't occlude the v0
        // popover); both beat the section span they sit on — the on-object handle wins.
        const fs = pickForceOrStart(ecs, tx, cx, cy);
        if (fs !== null) {
            if (fs.kind === "force") selectForce(fs.id, e.shiftKey ? "toggle" : "replace");
            else selectStart(true);
            return;
        }
        const sec = pickSection(ecs, tx, cx, cy);
        if (sec !== null) {
            selectSection(sec, e.shiftKey ? "toggle" : "replace"); // shift-click toggles the set
            return;
        }
        // truly empty space: arm a marquee (box-select). the deselect an empty CLICK does is
        // deferred to release — below DRAG_PX the press is still a click (existing behavior).
        // shift = toggle. no history gesture (a selection change is not an undoable command).
        dragMarquee = true;
        marqueeArmed = false;
        marqueeX0 = cx;
        marqueeY0 = cy;
        marqueeShift = e.shiftKey;
        marquee.rect = null;
        beginDrag(canvas, e.pointerId);
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
            // the lockdown (kex2d-optimize-mode stage 5): tangent edit is an editing surface, so
            // in-mode it only opens on the pinning section — which owns no geo nodes, so this
            // is a plain in-mode bar; the general predicate keeps it one law.
            if (sectionEditable(editor.pinning, Handle.section.get(eid))) enterTangentEdit(eid);
            return;
        }
        if (pickStart(ecs, tx, cx, cy)) {
            const n0 = startNode0(ecs);
            if (n0 !== null && sectionEditable(editor.pinning, Handle.section.get(n0)))
                enterTangentEdit(n0);
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
        if (dragMarquee) {
            dragMarqueeTo(canvas, e);
            return;
        }
        if (dragTangent !== null) {
            dragTangentTo(ecs, canvas, e);
            return;
        }
        if (dragNode !== null) {
            dragNodeTo(ecs, canvas, e);
            return;
        }
        if (dragManip !== null) {
            dragManipTo(ecs, canvas, e);
            return;
        }
        // no gesture under way: track what's under the pointer, in PICK order (a knob picks
        // before its node, a node before its section — hover must match what a click would
        // take), so exactly one of the four hover reads is lit: the knob or node the render
        // brightens one rung, else the marker, else the section span drawn one kind-color rung
        // up (`hovered`, colors.ts). `editor.dragging` catches a gesture owned by ANOTHER
        // surface sweeping over the canvas (a timeline drag); the viewport's own gestures
        // returned above, and each cleared the flag via `beginDrag`. `pickHover` is the pure
        // sweep, unit-tested directly against the same priority `onPointerDown` grabs by.
        if (editor.dragging) return;
        const { x: cx, y: cy } = pointerToCanvas(canvas, e);
        const tx = viewTransform(canvas);
        writeHover(pickHover(ecs, tx, cx, cy));
    };

    // the pointer leaving the canvas clears the hover (no move fires outside it).
    const onPointerLeave = (): void => {
        clearHover();
    };

    // wheel = zoom-at-cursor; trackpad pinch arrives as ctrl+wheel (browser convention)
    // and zooms the same way. preventDefault stops the page from scrolling/zooming under
    // it (needs a non-passive listener). deltaY is normalized to px — Firefox reports
    // line/page deltas (deltaMode 1/2), which would otherwise zoom imperceptibly.
    //
    // and it is a NO-OP while a gesture is live (`ui.md` "nothing moves under its own gesture").
    // Every gesture caches screen px at grab — the manipulator's cursor→node offset
    // (`manipDX/manipDY`), a tangent drag's knob offset + latch ray, a marquee's anchor corner —
    // and the camera is the map those px resolve through, so moving it mid-gesture resolves the
    // rest of the drag against a map the grab never saw: the manip/tangent drags write a wrong
    // pose on the next move, and the marquee's box slides across the content under the pointer
    // (its rect and its release hit-test both re-read the live camera, so what's drawn stays what's
    // picked — the anchor is what drifts). One rule, no per-gesture exceptions — zoom-during-pan is
    // eaten too. The predicate is `editor.dragging`, the ONE flag every gesture on either surface
    // raises through `beginDrag` (editor.ts), so it can't go stale as gestures are added, and it
    // reads the live field (not a tick projection, which would lag a frame). The event is still
    // swallowed: dropping preventDefault would hand a ctrl+wheel to the browser's own page zoom
    // mid-drag. `F` (`frameViewport`, the key handler below) guards on the same flag.
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

    // the drag flag + capture clear via beginDrag's own window pointerup/cancel listener; these
    // handlers own only the gesture's own state (pan flag / manipulator / tangent + history).
    const endDrag = (): void => {
        if (panning) {
            panning = false;
            canvas.style.cursor = "";
            return;
        }
        if (dragMarquee) {
            finishMarquee(ecs, canvas);
            return;
        }
        if (dragTangent !== null) {
            dragTangent = null;
            clearGuides();
            commit(history); // one handle drag → one undo entry (a no-move grab records nothing)
            return;
        }
        if (dragNode !== null) {
            dragNode = null;
            nodeArmed = false;
            clearGuides();
            commit(history); // one free move → one undo entry (a no-move grab records nothing)
            return;
        }
        if (dragManip === null) return;
        const axis = dragManip;
        const armed = manipArmed; // captured before the reset below — the sticky-commit gate
        dragManip = null;
        manipArmed = false;
        clearGuides();
        // one drag → one undo entry (a no-move click records nothing). a LENGTH drag also
        // records its landed chord as the sticky append length, so the next extend opens there —
        // but only when the gesture actually armed (cleared the dead-zone latch); a sub-DRAG_PX
        // click-release must not stamp the sticky value with an unmoved chord.
        const sel = editor.selection;
        if (axis === "length" && sel !== null) commitChord(history, ecs, sel, armed);
        else commit(history);
    };

    const cancelDrag = (): void => {
        if (panning) {
            panning = false;
            canvas.style.cursor = "";
            return;
        }
        if (dragMarquee) {
            cancelMarquee();
            return;
        }
        if (dragTangent !== null) {
            dragTangent = null;
            clearGuides();
            cancel();
            return;
        }
        if (dragNode !== null) {
            dragNode = null;
            nodeArmed = false;
            clearGuides();
            cancel(); // interrupted drag: restore the pre-gesture pose
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
        if (
            dragManip === null &&
            dragTangent === null &&
            dragNode === null &&
            !panning &&
            !dragMarquee
        )
            return;
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
        // guard Ctrl/Cmd+F (the browser find reflex) and mid-gesture, on `editor.dragging`,
        // the ONE live-gesture flag every gesture raises through `beginDrag` (same guard as
        // `onWheel`, above) — not the old per-flag `dragManip`/`panning` check, which missed
        // tangent, marquee, and other-surface gestures.
        if (
            (e.key === "f" || e.key === "F") &&
            !e.ctrlKey &&
            !e.metaKey &&
            editor.hover === "viewport"
        ) {
            e.preventDefault();
            if (!editor.dragging) frameViewport(ecs, canvas);
            return;
        }

        // arrow-nudge the selected node (the manipulators' keyboard twin): left/right rotate,
        // up/down translate — a fixed on-screen step (Shift = coarse), one press = one undo entry
        // (holding auto-repeats to many). gated on the viewport hover (the hovered-surface router)
        // so it can't also fire over the timeline — that cross-surface playhead/force-point
        // collision. (the mapping is the spec's proposal; the feel check-in decides it.) a
        // single-node nudge forks by node kind, mirroring the drag: a tip steps its polar
        // length/angle (`polarNudge`); an interior node steps its chord slide/offset (`chordNudge`,
        // kex2d-node-move-ux stage 2) — same up/down = length-role, left/right = angle-role key
        // mapping either way, so the fork is invisible at the keyboard. the MULTI-select group move
        // stays polar length/angle regardless of node kind (the multi law, `editor-ui.md`) — out of
        // this stage's scope.
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
            // the lockdown: geo nodes are never the pinning section's, so no nudge in-mode.
            if (!sectionEditable(editor.pinning, Handle.section.get(eid))) return;
            if (!(camera.zoom > 0)) return; // pre-framing: no scale to convert px through
            const prevEid = handleAt(ecs, Handle.section.get(eid), Handle.order.get(eid) - 1);
            if (prevEid === null) return; // a non-anchor node always has a previous node
            e.preventDefault();
            const step = (e.shiftKey ? NUDGE_PX_COARSE : NUDGE_PX) / camera.zoom;
            const lengthKey = e.key === "ArrowUp" || e.key === "ArrowDown";
            const dir = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : -1;
            if (editor.nodes.ids.size > 1) {
                // a multi-selection: one shared delta from the active node (length = a metre step;
                // angle = the step's arc at the active radius) applied to the whole set, one entry.
                // this is the ONLY group-move path — a multi-set shows no ring, so the capability
                // lives on the keyboard alone (Blender's gizmo-less move; editor-ui.md multi law).
                const axis = lengthKey ? "length" : "angle";
                let delta = dir * step;
                if (axis === "angle") {
                    const p = nodeLocal(prevEid);
                    const n = nodeLocal(eid);
                    const r = Math.hypot(n.x - p.x, n.y - p.y);
                    delta = r > 1e-9 ? (dir * step) / r : 0;
                }
                beginMoves(ecs, sectionsOf(ecs, editor.nodes.ids));
                // each keypress is a whole begin→apply→commit, so re-freeze from the just-committed
                // live positions — the delta's zero is this press's start, not the gesture's.
                applyMultiDelta(ecs, freezeChains(ecs, editor.nodes.ids), axis, delta);
                commit(history);
                return;
            }
            if (eid === lastHandle(ecs, Handle.section.get(eid))) {
                const axis = lengthKey ? "length" : "angle";
                const t = polarNudge(
                    nodeLocal(prevEid),
                    nodeLocal(eid),
                    axis,
                    dir,
                    step,
                    LENGTH_MIN,
                );
                beginMove(ecs, Handle.section.get(eid));
                // written straight to the authored local position — no world round trip (`nodeLocal`'s
                // rigid-placement note): back-to-back presses read each other's write immediately, not
                // last frame's bake.
                Handle.pos.set(eid, t.x, t.y);
                reheadOnDrag(ecs, eid);
                // the nudge is the keyboard twin of the manipulator drag, sticky length included —
                // always armed, since a nudge always moves.
                if (lengthKey) commitChord(history, ecs, eid, true);
                else commit(history);
                return;
            }
            // interior: the chord-frame axes (slide ∥ / offset ⊥), neighbors frozen — no re-head
            // (the frozen-heading law) and no sticky append memory (that's the tip's own
            // append-continuity, meaningless mid-chain).
            const nextEid = handleAt(ecs, Handle.section.get(eid), Handle.order.get(eid) + 1);
            if (nextEid === null) return; // unreachable: the tip check above already caught it
            const axis = lengthKey ? "slide" : "offset";
            const t = chordNudge(
                nodeLocal(prevEid),
                nodeLocal(nextEid),
                nodeLocal(eid),
                axis,
                dir,
                step,
            );
            beginMove(ecs, Handle.section.get(eid));
            Handle.pos.set(eid, t.x, t.y);
            commit(history);
            return;
        }

        if (e.key === "Escape") {
            // a marquee in flight is the topmost dismissal rung — cancel it clean (no selection
            // change, rect gone, capture released) before the selection ladder below.
            if (dragMarquee) {
                e.preventDefault();
                cancelMarquee();
                endDragGesture();
                return;
            }
            // a live free node-body drag (kex2d-node-move-ux stage 3) is the next rung: Escape
            // cancels the in-flight move (revert + clear capture, the same teardown as a blur)
            // and does NOT also exit tangent edit in the same press — one press peels one layer,
            // so a second Escape reaches the tangent-edit rung below. (`dragManip`/`dragTangent`
            // have no equivalent live-gesture Escape rung today — a pre-existing gap this leaves
            // alone; only the new `dragNode` path needs one, since Esc is tangent edit's own
            // dismissal key and would otherwise close the handles out from under a live drag.)
            if (dragNode !== null) {
                e.preventDefault();
                cancelDrag();
                endDragGesture();
                return;
            }
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

        // a live gesture never fires a structural Delete mid-flight: a drag can hold a raw eid
        // (`dragNode`/`dragTangent`) or an open history bracket (`beginMove`), and destroying or
        // committing over that entity mid-gesture is exactly the stale-eid hazard `AGENTS.md`'s
        // "never hold a raw eid across a snapshot restore" gotcha warns about. the arrow-nudge
        // handler above guards only the node-move gestures it directly competes with
        // (`dragManip`/`panning`); a destructive op needs the wider net — `editor.dragging`, the
        // ONE flag every gesture raises through `beginDrag` (the same guard `onWheel`/`F` use).
        if (bound(BINDINGS.remove, e.key) && editor.dragging) return;

        // a whole section (or section SET) selected: delete it (Del; also the context-menu action).
        // a multi-set deletes as ONE entry, guarded at the last-section floor (`removeSections`); the
        // size-1 case is `removeSection`. Guarded on `editor.pinning`: convert/delete/join aren't
        // available inside pin mode (the locked decision's consent-boundary law) — deleting the
        // section under a live session would strand `editor.pinning` on a dead id (the mode's own
        // Exit lives only on that section's own context menu, so nothing could ever reach it again).
        // routed through `keys.ts`'s `sectionKeyAct` (the keyboard twin of `menus.sectionMenu`'s
        // `remove`/`removeSet`/`Cut` rows) — the guards stay here, the decider only reads their
        // results. `position` is `C`'s own resolution: the playhead's own stored position
        // (`cart.playheadPosition`, never a cursor reading — the locked decision's "the keyboard
        // cuts at the playhead... with no threshold") run through the SAME `sectionCutAt` seam
        // the clip-strip menu row resolves a cursor through, scoped to THIS section — null off
        // the track (no bake) or off the section (the playhead sits outside it), either of which
        // makes `C` a no-op here exactly like a non-interior click would.
        if (editor.section !== null) {
            const section = editor.section;
            const trackEid = trackEntity(ecs);
            let position: CutPosition | null = null;
            if (trackEid !== null) {
                const ph = playheadPosition(trackEid);
                if (ph !== null)
                    position = sectionCutAt(ecs, section, sectionSpans(ecs, trackEid), ph.d, ph.u);
            }
            const act = sectionKeyAct(e.key, {
                opsAllowed: sectionOpsAllowed(editor.pinning),
                multi: editor.sections.ids.size > 1,
                joinable: sectionsJoinable([...editor.sections.ids], sections(ecs)),
                cuttable: position !== null,
                // Reset (`R`) is a plain document act (`acts.sectionActs` already returns it), so
                // — unlike Convert/Pin — it's computed fresh HERE, off the keydown's own subject
                // (`editor.section`), never off a menu's tick-derived reading: the exact shape
                // `computeCanSolve`/`computeCanSolveShape`/`computeCanPin` (`App.svelte`) landed
                // for stage 3, after the stage-3 defect where the menu's `ctx.section`-derived
                // enablement silently starved the keyboard path.
                canReset: sectionResettable(
                    editor.sections.ids.size,
                    sections(ecs).find((s) => s.id === section)?.kind ?? null,
                    bakeLive(ecs),
                ),
                // Convert/Pin never reach this decider call — no `canSolve`/`canSolveShape`/
                // `canPin` supplied, so `D`/`P` fall through as `null` here; App.svelte's own
                // permanent listener owns them (`solve`/`solveShape`/`pinEnter` are chrome, and
                // this module reaches only `acts.ts` — `editor-ui.md` Menus, no act crosses a
                // module boundary). The narrow below is a static reflection of that split, not a
                // runtime branch this call site can actually take.
            });
            if (act === "solve" || act === "solveShape" || act === "pinEnter") return;
            if (act !== null) {
                e.preventDefault();
                const acts = sectionActs(ecs, section, position);
                acts[act]();
            }
            return;
        }

        // a node selected: extend, or trim the chain end.
        if (editor.selection === null) return;
        const sel = editor.selection;

        // a MULTI node set: Delete acts on the whole set iff it's a valid suffix run (a contiguous
        // suffix of one section, excluding node 0, leaving ≥ 2) — trimmed as ONE undo entry, then the
        // selection prunes to the surviving tip (the live-pruner answer: the destroyed eids leave the
        // set here, never lingering to alias a recycled entity). anything else is a no-op (the menu
        // grays the row). Enter/extend is single-subject, so a multi-set doesn't extend. routed
        // through `keys.ts`'s `nodeKeyAct`, same as the chain-end rung below — the record indexes
        // through `nodeActs` like its siblings, not as an inline special case.
        if (editor.nodes.ids.size > 1) {
            const act = nodeKeyAct(e.key, {
                editable: sectionEditable(editor.pinning, Handle.section.get(sel)),
                multi: true,
            });
            if (act !== null) {
                e.preventDefault();
                const acts = nodeActs(ecs, sel);
                acts[act]();
            }
            return;
        }

        const section = Handle.section.get(sel);
        const act = nodeKeyAct(e.key, {
            editable: sectionEditable(editor.pinning, section),
            multi: false,
            endSelected: endSelected(ecs),
            cuttable: nodeCuttable(Handle.order.get(sel), sectionHandles(ecs, section).length),
        });
        if (act !== null) {
            e.preventDefault();
            const acts = nodeActs(ecs, sel);
            acts[act]();
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
        if (!sectionEditable(editor.pinning, Handle.section.get(sel))) return; // the lockdown
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
    canvas.addEventListener("pointerleave", onPointerLeave);
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
        canvas.removeEventListener("pointerleave", onPointerLeave);
        canvas.removeEventListener("pointerup", endDrag);
        canvas.removeEventListener("pointercancel", cancelDrag);
        canvas.removeEventListener("wheel", onWheel);
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("blur", onBlur);
        canvas.style.cursor = ""; // detaching mid-pan must not leave a stuck grabbing cursor
        clearHover(); // nor a lit span/node/marker/knob the remount has no pointer over
        clearGuides(); // detaching mid-drag must not leave a stuck guide for the remount
        cancelMarquee(); // detaching mid-marquee must not leave a stuck rect for the remount
        endDragGesture(); // detaching mid-drag must not leave the drag flag stuck on
    };

    return { detach, startManip };
}
