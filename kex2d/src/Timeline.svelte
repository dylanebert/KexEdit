<script lang="ts">
import type { State } from "@dylanebert/shallot";
import { onMount, untrack } from "svelte";
import type { SelectMode, Selection } from "./editor";
import {
    cartState,
    forceCurve,
    parkAtArc,
    parkFromTime,
    playheadPosition,
    trackMapping,
    velocityCurve,
} from "./cart";
import { COLOR_VELOCITY, dimmed, hovered, kindSegments } from "./colors";
import Menu from "./Menu.svelte";
import { BINDINGS, bound, fitMenu, type MenuItem } from "./menu";
import { appendMenu, keyframeMenu, rulerMenu, stripMenu } from "./menus";
import {
    activateForce,
    activateStripKf,
    beginDrag,
    closeForceMenu,
    closeRulerMenu,
    closeStripMenu,
    deselectAll,
    dismissNotice,
    editor,
    endDrag as endDragGesture,
    enterForceEdit,
    exitForceEdit,
    landingG,
    lockLabel,
    modeChromeSection,
    openContext,
    skipLanding,
    notify,
    openForceMenu,
    openRulerMenu,
    openStripMenu,
    selectForce,
    selectForceHandle,
    selectForces,
    selectOneShot,
    selectSection,
    selectStrip,
    selectStripKf,
    selectStripKfs,
    snapActive,
    toggleSnap,
} from "./editor";
import {
    appendSection,
    addOneShot,
    addStrip,
    addStripKeyframe,
    beginForceMove,
    beginForceMoves,
    beginForceTangent,
    beginLength,
    beginOneShotMove,
    beginStripMove,
    beginStripKeyframeMove,
    beginStripKeyframeMoves,
    cancel,
    commit,
    commitLength,
    createForce,
    deleteOneShot,
    deleteStrips,
    deleteStripKeyframes,
    history,
    materializeCustom,
    setForcesEase,
    setForceTangentMode,
} from "./history";
import { forceKeyAct } from "./keys";
import { classifyOneShotHit, classifyStripHit, type StripHit, type StripHitCandidate } from "./strip-hit";
import { V_FLOOR } from "./bake";
import { redoRouted, undoRouted } from "./pin";
import { convertDomain, convertFailed, pickable } from "./domain";
import { Domain } from "./section";
import {
    clampView,
    composeTangent,
    creationTargets,
    dToU,
    fmt,
    frameAll,
    G_GRID,
    type Mapping,
    marginArc,
    marginFloor,
    navDragView,
    navWindow,
    nodeArc,
    nudgeKeyframes,
    pxToU,
    S_GRID,
    snap,
    snapAxis,
    snapCutToPlayhead,
    stallClampU,
    uToPx,
    T_GRID,
    ticks,
    timeToArc,
    trimTargets,
    uToD,
    uToDExtend,
    dToUExtend,
    type View,
    xGrow,
    yEase,
    yFit,
    type YFit,
    yGrow,
    zoomAt,
} from "./timeline";
import {
    forceSetEditable,
    keyframeActs,
    keyframeCuttable,
    lockCandidates,
    sectionEditable,
    sectionOpsAllowed,
} from "./acts";
import { armDrag, DRAG_PX, latchAngle } from "./controls";
import {
    ANGLE_STEP_MAX,
    ANGLE_STEP_MIN,
    LENGTH_STEP_MAX,
    LENGTH_STEP_MIN,
    setSnapAngle,
    setSnapLength,
    snapSteps,
} from "./settings";
import { hits, merge, normRect, type Rect } from "./marquee";
import { infeasibleSpans } from "./render";
import { autoTangent, Easing, type ForcePoint, type Offset, sampleForce, segmentControls, segmentSeed } from "./profile";
import { TangentMode } from "./spline";
import {
    bakeOut,
    entryOneShot,
    forceEase,
    type ForceTangent,
    forceTangent,
    Handle,
    minForceExtent,
    SectionKind,
    type SectionSpan,
    sectionCutAt,
    sectionForces,
    sectionHandles,
    sectionInfo,
    sections,
    sectionSpans,
    allStrips,
    setForcePoint,
    setForceTangent,
    setOneShotValue,
    setSectionLength,
    setStrip,
    setStripKeyframe,
    keyframeRoom,
    stripAt,
    Strip,
    stripBoundsAt,
    stripDefaultExtentAt,
    stripKeyframes,
    stripMinExtentAt,
    stripOverlapped,
    stripSeedValue,
    toGlobal,
    toLocal,
    trackDomain,
    validStripValue,
    V0,
} from "./track";
import { DOCK_HEIGHT, DOCK_INSET, PLAYER_GAP, PLAYER_H, resize } from "./view";

const { ecs, eid, tick }: { ecs: State; eid: number | null; tick: number } = $props();

// the snap magnet's persistent state (read through the per-RAF tick) — the tool rail
// toggle's lit/quiet state. the magnet is global (viewport node drag + timeline keyframe
// snap); its home is the rail on the dock's left edge (below).
const snapOn = $derived.by((): boolean => {
    void tick;
    return editor.snap;
});
// the manipulator snap QUANTA (settings.ts) — a per-user preference, not track state. read through
// the same per-RAF tick as the toggle, so the popover's fields display the live values and a clamped
// write shows its clamp. the angle lives in radians and is authored in degrees, converted here.
const snapDeg = $derived.by((): number => {
    void tick;
    return (snapSteps.angle * 180) / Math.PI;
});
const snapLen = $derived.by((): number => {
    void tick;
    return snapSteps.length;
});
// the chart's axis is a LENS over `Track.domain` (S6): every force keyframe, extent, strip and
// strip keyframe stays in arclength always, so this is a display pick, never a store unit. A
// gesture in progress (drag/scrub/trim) freezes its OWN s↔t table snapshot (`gestureMapping`)
// rather than reading this live, so a domain flip mid-gesture is display-only and never rescales
// an open drag underneath it. Tick-derived, so it lags the document by a frame — which is why the
// pick's own re-frame is deferred to the frame this re-derives in (`pickDomain`) instead of
// writing `view` live.
//
// The pick flips ONE column (`domain.convertDomain`) — no re-bake needed since `Track.domain`
// never enters `bakeHash` (S6), and no keyframe/extent/strip moves. What DOES change on this
// frame is every reader that projects through `uOf`/`dOf` (the ruler, the readouts, every
// keyframe's drawn x), since `domain` itself just flipped.
const domain = $derived.by((): Domain => {
    void tick;
    return trackDomain(ecs);
});
const timeDomain = $derived(domain === Domain.Time);
// the position field's key + unit follow the domain (the readout suffix the ruler's ticks wear too).
const posLabel = $derived(timeDomain ? "t" : "d");
const posUnit = $derived(timeDomain ? "s" : "m");

// the timeline shows the baked F_n force curve the realized track produces, plus
// scrub + zoom/pan navigation. it's also the force-authoring surface: over any force
// section's arc, points are placed, dragged, and deleted on the curve, while the chart
// keeps displaying the geometry-recovered curve. geo sections stay read-only here (the
// shape is authored in the viewport). the clip strip in the marker lane selects sections.

// timeline bands, top → bottom: a scrubbable RULER (ticks + labels + playhead
// handle, the dedicated scrub zone), a demarcating GAP the playhead passes through,
// then the curve chart. The After Effects / animation-timeline / kexedit-main layout
// (time ruler on top, click-anywhere-to-scrub), not a plot with a bottom axis.
const RULER_H = 26; // top scrub band: ticks, labels, playhead handle
const GAP_H = 20; // marker lane between ruler and chart — the section clip strip
const CLIP_PAD = 2; // px; vertical inset of a section clip inside the marker lane
// the rendered rect height ONE clip language shares (S4, finding 5): the section clip and the
// velocity strip fill both draw at this height, inset `CLIP_PAD` from their own band's top and
// bottom — never the container band's full height, which is a drift the old `STRIP_H == GAP_H`
// pin let stand (that pinned the BAND, never what actually painted).
const CLIP_H = GAP_H - 2 * CLIP_PAD;
// the velocity-strip band: band carries extent, graph carries and edits value (Locked
// decision, superseding "header carries extent, chart carries value"). Authored strips
// draw here as solid fills (the velocity hue, selected brightens); the red ghost spans
// (contiguous infeasible extents) draw inside it too. S3 (Affordances): a lane at the
// clip lane's own height, not a bare visual minimum — root ui.md gate 3's "a lane visibly
// present even when empty" reads as a container, and an 8px sliver under the clip strip
// didn't earn that read.
const STRIP_H = GAP_H;
const TOP = RULER_H + GAP_H + STRIP_H; // chart top
const BOT_PAD = 8; // chart inset, bottom
const LEFT_GUT = 44; // left gutter: the g-axis labels live here; the chart insets past it
// PLAYER_GAP/PLAYER_H (view.ts) — the player's geometry above the dock, shared with the
// pin panel's anchor (App.svelte).
const LABEL_HALF = 5; // px; half a g-label's height — hide a label nearer than this to the plot edge
// reference comfort limits (g) — drawn as faint lines to read the force curve against, and the
// value axis's RESTING frame: the window the view sits in whenever the data fits inside it (the
// seed before any data arrives, and the minimum `yFit` expands from). One constant, no ladder.
const BAND: [number, number] = [-2, 6];
// the velocity channel's own resting frame: 0 is always shown (a coaster's speed floor,
// the m/s twin of the g-axis's 1g baseline) up to a comfortable cruise ceiling; `yFit`
// grows it past this whenever the baked curve's range needs more.
const V_BAND: [number, number] = [0, 20];
const V_BASE = 0; // the velocity axis's always-shown baseline (0 m/s), not `Y_BASE`'s 1g
// the ceiling on edge-drag growth: the band with 1 g of headroom on each side — the original
// bound, restored after uncapped growth proved unusable (compounding per-frame growth runs to
// extreme g almost instantly). Derived from BAND, so the band stays the one authored constant.
const GROW_HEADROOM = 1;
const GROW_CAP: [number, number] = [BAND[0] - GROW_HEADROOM, BAND[1] + GROW_HEADROOM];
const Y_BASE = 1; // gravity baseline (1g)
const ZOOM_DIV = 200; // wheel-delta → geometric zoom rate
const FMARKER_R = 5; // px; the force-point diamond's half-diagonal (visual)
// the track-start one-shot's own glyph half-diagonal (S3, its own structurally distinct point
// kind, `track.OneShot`) — `FMARKER_R`'s own size, so the one-shot marker reads at the same
// visual weight as the force-point diamond it sits beside in the same band, not a bespoke size.
const STRIP_GLYPH_R = FMARKER_R;
const NODE_TICK_R = 3; // px; a geo section's read-only node-tick circle radius (visual)
const FHIT_R = 12; // px; the invisible grab/hover radius around a force point (fat pick zone)
const TIP_HALF = 52; // px; half the popover's width — clamps a knob/point-centred popover inside the chart
const TIP_FLIP = 64; // px; a point nearer than this to the chart top flips the popover below
const TIP_W = 108; // px; the popover's full width — the handle popover's horizontal dodge flips outward side when it would clip
const TIP_GAP = 12; // px; the popover's offset from its anchor (the same gap the point popover uses vertically)
const TIP_VHALF = 28; // px; half the popover height — the vertical clamp for a side-dodged handle popover
const TIP_H = 2 * TIP_VHALF; // px; the popover's full height — the vertical fit test for the above/below default
// arrow-nudge steps for the selected force point (AE): position in ARCLENGTH ALWAYS (S6 --
// `Force.s`'s own unit, regardless of what the ruler is showing), g in g, Shift coarse. Unlike
// the chart-axis gestures (drag/scrub/field), a nudge never touches `uOf`/`dOf`: it's a pure
// arclength step, a tenth of `S_GRID`'s own quantum, 10× that with Shift.
const NUDGE_S = 0.1;
const NUDGE_S_COARSE = 1;
const NUDGE_G = 0.05;
const NUDGE_G_COARSE = 0.5;
// the velocity twin of NUDGE_G — the same step size (0.05 m/s, 0.5 with Shift), so a strip
// keyframe nudge moves the same on-screen distance as a force keyframe nudge.
const NUDGE_V = 0.05;
const NUDGE_V_COARSE = 0.5;
// the velocity-axis snap grid — the v-twin of G_GRID (0.1), so a strip keyframe drag snaps
// to the same resolution as a force keyframe drag.
const V_GRID = 0.1;
const THANDLE_R = 4; // px; the summoned tangent-handle knob radius (visual)
const THIT_R = 10; // px; the invisible grab radius around a handle knob (fat pick zone)

let host: HTMLDivElement;
let canvas: HTMLCanvasElement;
let navCanvas: HTMLCanvasElement | undefined = $state();
let w = $state(0);
let h = $state(0);
// the user's view intent; `clamped` re-fits it to the live width/track length, so a
// resize or a track edit never writes back into `view` (which would loop the effect).
let view: View = $state({ pan: 0, pxPerU: 10 });
let framed = false;
// while the section-end handle drags, the chart's addressable span FREEZES at its
// high-water mark (in axis units) so the pan clamp never shifts the view under the cursor
// during a shorten (the same "nothing moves under its own gesture" law as the keyframe y-fit
// freeze). captured at drag start, cleared on release. the x-scale never re-fits — that
// is clampView's job now, not the freeze's.
let uFrozen: number | null = $state(null);

const clamp = (x: number, lo: number, hi: number): number => Math.min(Math.max(x, lo), hi);

type TipMode = "above" | "below" | "left" | "right";
// place the handle popover: vertical-primary, matching the keyframe popover's above/below
// reading. the box sits above or below the knob, horizontally centred on it, the vertical side
// chosen AWAY from the diamond (an up-pointing handle → above the knob). only when the chart edge
// forces the flip toward the diamond (the workspace) does it dodge horizontally OUTWARD instead
// (out → right, in → left — the F3b direction): the box then clears the knob, arm, diamond, and
// other knob, all of which sit on the diamond side. the side position is that collision fallback,
// never the default. the returned (x, y) is the knob-anchor; the CSS transform offsets the box by
// mode. `dy` is the diamond (keyframe) screen-centre y.
function handleTip(
    kx: number,
    ky: number,
    dy: number,
    side: "in" | "out",
    w: number,
    h: number,
): { x: number; y: number; mode: TipMode } {
    const bot = h - BOT_PAD;
    // the vertical side away from the diamond: knob at or above the diamond → the popover goes
    // above the knob (a flat handle defaults above, its diamond is off to the side either way).
    const preferAbove = dy >= ky;
    const aboveFits = ky - TIP_GAP - TIP_H >= TOP;
    const belowFits = ky + TIP_GAP + TIP_H <= bot;
    if (preferAbove ? aboveFits : belowFits) {
        return {
            x: clamp(kx, LEFT_GUT + TIP_HALF, Math.max(LEFT_GUT + TIP_HALF, w - TIP_HALF)),
            y: clamp(ky, TOP, bot),
            mode: preferAbove ? "above" : "below",
        };
    }
    // collision fallback: the edge would flip the box back over the workspace, so dodge the knob
    // horizontally outward; flip inward only if the outward side would itself clip (the deep edge).
    const rightFits = kx + TIP_GAP + TIP_W <= w;
    const leftFits = kx - TIP_GAP - TIP_W >= LEFT_GUT;
    const goRight = side === "out" ? rightFits || !leftFits : !leftFits && rightFits;
    return {
        x: clamp(kx, LEFT_GUT, Math.max(LEFT_GUT, w)),
        y: clamp(ky, TOP + TIP_VHALF, Math.max(TOP + TIP_VHALF, bot - TIP_VHALF)),
        mode: goRight ? "right" : "left",
    };
}

// the baked F_n force curve as per-sample (arclength, force) points — the chart data
// and the source of the distance domain. no time resample: the x-axis is distance.
const curve = $derived.by((): { s: Float64Array; f: Float32Array; n: number } | null => {
    void tick;
    return eid === null ? null : forceCurve(eid);
});
// the baked recovered-speed curve — `curve`'s twin. Always
// present alongside `curve` (both come from the same bake), drawn on its OWN auto-fit
// value scale (`vTarget`/`vView` below) over the same shared document x-axis — never the
// force axis, whose g-range means nothing for m/s.
const vCurve = $derived.by((): { s: Float64Array; v: Float32Array; n: number } | null => {
    void tick;
    return eid === null ? null : velocityCurve(eid);
});
// total track arclength (m) — the chart's X-axis domain.
const sTotal = $derived(curve ? curve.s[curve.n - 1] : 0);
// total track seconds — the *player* transport's domain (the media player stays in
// time; only the chart is distance).
const tTotal = $derived.by((): number => {
    void tick;
    if (eid === null) return 0;
    return bakeOut.get(eid)?.tTotal ?? 0;
});
// the cart↔chart projection AND the arclength→time table: the cart rides in time, and a
// `Domain.Time` chart reads its x on that same clock.
const mapping = $derived.by((): Mapping | null => {
    void tick;
    return eid === null ? null : trackMapping(eid);
});

// ── the axis, and the ONE projection into it (timeline.ts `dToU`/`uToD`) ──
// the chart's x is the coordinate `u` on the track's own axis: global arclength `d`, always —
// projected through the live bake's s↔t table into global march time when `Domain.Time` is
// showing (S6: "arclength is canonical, time is a lens"). `Force.s`/`Section.length`/strip
// keyframes are stored in arclength ALWAYS (never a second, domain-native unit), so every force
// path — placement, drag, extent, field — WRITES arclength and must convert a chart-axis (u)
// quantity back to it through `dOf` before touching the store; nothing here is native to `u`
// the way it used to claim. `uOf`/`dOf` are identity in the distance domain, and project through
// `dToU`/`uToD` (the same seam a geo section's node ticks and the cart's park already read)
// otherwise.
//
// **Frozen at gesture start.** A live drag/scrub/trim reads the bake's s↔t table on every
// pointermove, and that SAME edit changes the bake underneath it (the dragged point's own g/s
// feeds back into v(s)) — so an unfrozen table would drift under its own gesture, the same
// class of problem `uFrozen` already solves for the x-pan-clamp span. `gestureMapping` holds
// the table snapshot taken at gesture start (a `Mapping` object is immutable, so holding the
// reference IS the freeze); every writer below sets it in its own `*Down`/`begin` and clears it
// in its own release/cancel path. `uOf`/`dOf` read it first, live `mapping` only when no gesture
// owns it.
let gestureMapping: Mapping | null = $state(null);
const uOf = (d: number): number => dToU(gestureMapping ?? mapping, domain, d);
const dOf = (u: number): number => uToD(gestureMapping ?? mapping, domain, u);
// the bake's own exit speed — floored at V_FLOOR exactly like `computeTime`'s march — the extent
// trim's extrapolation rate past the bake's own end (S6b: lengthening a section past its current
// profile is a legitimate author intent, not a stall, so the trim keeps advancing rather than
// clamping to the last finite sample). A plain function, not a `$derived`: it reads through
// `curve`/`bakeOut` at call time, so `lenDown` can snapshot it once at gesture start (`lenVExit`,
// the same live-feedback hazard `gestureMapping` freezes) and the `dOfTrim` capture-harness bridge
// can read the identical live value a gesture-about-to-start would freeze — the same convention
// `dOf`/`uOf` already serve as their own pre-gesture oracle.
function exitSpeed(): number {
    if (eid === null || curve === null) return V0;
    const out = bakeOut.get(eid);
    return out ? Math.max(Math.abs(out.v[Math.max(0, curve.n - 1)]), V_FLOOR) : V0;
}
const mFloor = $derived(marginFloor(domain));
// the first-infeasible sample's own Time-axis reading (`bakeOut.t`, the SAME array `cart.ts`
// `loopTime` reads) — null off a fully feasible bake. Distance-domain callers never read this
// (`stallClampU`'s own no-op branch), so it's cheap to derive unconditionally.
const stallU = $derived.by((): number | null => {
    void tick;
    if (eid === null) return null;
    const out = bakeOut.get(eid);
    return out && out.firstInfeasible >= 0 ? out.t[out.firstInfeasible] : null;
});
// the addressable span's end, in axis units — bounded past a stall so the Time lens never
// stretches toward t→∞ (S2, finding 13: `stallClampU`'s own docblock has the derivation).
const uTotal = $derived(stallClampU(uOf(sTotal), domain, stallU, mFloor));
// the x-axis placement quantum for a keyframe drag: metres of arclength, or seconds (`T_GRID`,
// derived from `S_GRID` at the default entry speed).
const GRID = $derived(timeDomain ? T_GRID : S_GRID);
// the chart insets past the left g-gutter; the axis affine lives in [LEFT_GUT, w], so every
// timeline.ts call takes `chartW` and screen-X adds/subtracts LEFT_GUT.
const chartW = $derived(Math.max(0, w - LEFT_GUT));
const clamped = $derived(clampView(view, chartW, uFrozen ?? uTotal, mFloor));
const tickList = $derived(ticks(clamped, chartW, domain));
// the cart's time on the baked track's clock (the player transport's readout).
const cartSec = $derived.by((): number | null => {
    void tick;
    if (eid === null) return null;
    return cartState.get(eid)?.t ?? null;
});
// the cart's arclength — its `t` projected onto the chart's distance axis.
const cartS = $derived.by((): number | null => {
    if (cartSec === null || mapping === null) return null;
    return timeToArc(mapping, cartSec);
});
const playPx = $derived.by((): number | null => {
    if (cartS === null) return null;
    const x = markerX(cartS); // the cart's arclength, projected
    return x < LEFT_GUT || x > w ? null : x;
});
const paused = $derived.by((): boolean => {
    void tick;
    return eid === null ? false : (cartState.get(eid)?.held ?? false);
});
// the player slider's fill — the cart's global fraction of the whole track. distinct
// from the timeline playhead (`playPx`), which is local to the zoomed view.
const frac = $derived.by((): number => {
    if (cartSec === null || tTotal <= 0) return 0;
    return clamp(cartSec / tTotal, 0, 1);
});

// the auto-fit g-range *target*: scans the baked force curve. always keeps 1g;
// `yView` (below) eases toward this — the target itself is never drawn.
const yTarget = $derived.by((): YFit => {
    void tick;
    let lo = Y_BASE;
    let hi = Y_BASE;
    const c = curve;
    if (c) {
        for (let i = 0; i < c.n; i++) {
            if (c.f[i] < lo) lo = c.f[i];
            if (c.f[i] > hi) hi = c.f[i];
        }
    }
    // include the edited keyframe's EXPLICIT handle endpoints in the content extent, through the
    // one place handle endpoints are computed (`editHandles`), so a released handle drag never
    // leaves a knob outside the visible range — the accommodate keyframes get through the curve
    // scan, extended to the drawn control points. a derived (ghost) handle stays within the curve
    // hull, so only a stored offset can overshoot it; only those count.
    const eh = editHandles;
    if (eh) {
        for (const hnd of eh.handles) {
            if (hnd.ghost) continue;
            const g = eh.pt.g + hnd.dg;
            if (g < lo) lo = g;
            if (g > hi) hi = g;
        }
    }
    return yFit(lo, hi, Y_BASE, BAND);
});

// the *displayed* g-range. `yTarget` is the resting BAND expanded to fit data (it never hugs
// tight), and `yView` approaches it ASYMMETRICALLY: it grows fast and contracts lazily — the
// AE/Unity "grow when content needs it, never snap back" feel, smoothed for the web.
let yView: YFit = $state({ lo: BAND[0], hi: BAND[1], step: 1 });
let yInit = false;
const Y_OUT = 0.3; // per-frame approach when EXPANDING the view (snappy)
const Y_IN = 0.05; // per-frame approach when CONTRACTING (lazy — no snap-back)
const EDGE_RATE = 0.2; // edge-scroll speed (∝ px past the edge); a by-eye feel constant
// a gesture holds the axis (below) and grows it at the edge (up to GROW_CAP), so the frame a
// release leaves behind is the gesture's, not the content's. `yReturn` marks the re-fit that follows: it runs at
// the EXPANSION rate, so the room a drag borrowed comes back in ~0.35 s however far it was grown,
// instead of oozing for ~2.5 s — long enough that the next gesture re-freezes it and the grown axis
// just stands. A contraction with no gesture behind it (a delete, an undo) keeps the lazy rate:
// THAT is the "content shrank, don't snap back" case.
let yHeld = false;
let yReturn = false;
$effect(() => {
    void tick; // the ONLY dependency: one run per animation frame
    // untracked: the body reads + writes yView, so a tracked read would make the
    // effect depend on its own write and loop. tick alone paces it.
    untrack(() => {
        const t = yTarget;
        if (!yInit) {
            yView = t; // first valid range appears instantly, no ease-in from the seed
            yInit = true;
            return;
        }
        // drag mode: the axis HOLDS during a keyframe or handle drag — the live re-bake must
        // never re-fit the view under the held cursor — until the cursor is dragged PAST the
        // chart edge, where the shared edge-grow (growValueAxis) scrolls the value axis to
        // follow. auto-fit resumes on release and eases to the new curve's range.
        if (dragKf !== null || draggingLen || dragTan !== null) {
            yHeld = true;
            if (dragKf !== null) growValueAxis(dragKfCy, applyKeyframeDrag);
            // a handle drag edge-pans through the SAME mechanism (F3d) — only once it's a real
            // drag (tanMoved), so a mere handle click, whose tanCx/tanCy are unset, never pans.
            else if (dragTan !== null && tanMoved)
                growValueAxis(tanCy, () => applyTan(tanCx, tanCy));
            // (a length resize holds the y-axis with no edge-grow — it authors no g value)
            return;
        }
        if (yHeld) {
            yHeld = false;
            yReturn = true;
        }
        const eased = yEase(yView, t, Y_OUT, yReturn ? Y_OUT : Y_IN);
        if (eased.lo === t.lo && eased.hi === t.hi) yReturn = false; // the borrowed room is back
        if (eased !== yView) yView = eased;
    });
});

// the velocity channel's own auto-fit target — `yTarget`'s twin, scanning `vCurve` instead
// of `curve`, resting on `V_BAND`/`V_BASE`. Display-only (no keyframes, no drag), so unlike
// `yTarget` it has no handle-endpoint accommodation to fold in.
const vTarget = $derived.by((): YFit => {
    void tick;
    let lo = V_BASE;
    let hi = V_BASE;
    const c = vCurve;
    if (c) {
        for (let i = 0; i < c.n; i++) {
            if (c.v[i] < lo) lo = c.v[i];
            if (c.v[i] > hi) hi = c.v[i];
        }
    }
    return yFit(lo, hi, V_BASE, V_BAND);
});
// the *displayed* velocity range — `yView`'s twin. No drag ever holds it (the channel is
// display-only, never authored), so it always eases straight toward `vTarget`, at the same
// asymmetric grow-fast/shrink-lazy rates as the g-axis.
let vView: YFit = $state({ lo: V_BAND[0], hi: V_BAND[1], step: 1 });
let vInit = false;
$effect(() => {
    void tick;
    untrack(() => {
        const t = vTarget;
        if (!vInit) {
            vView = t;
            vInit = true;
            return;
        }
        const eased = yEase(vView, t, Y_OUT, Y_IN);
        if (eased !== vView) vView = eased;
    });
});

// pick the track domain (the ruler menu's Meters/Seconds rows — no keyboard twin, the second feel
// check-in's call). This is a DOCUMENT conversion, not a view change: `convertDomain` converts every
// force keyframe, extent, and handle Δs into the target unit as one undoable entry, and a round trip
// is not bit-identical — undo is the way back.
function pickDomain(target: Domain): void {
    if (editor.dragging) return; // a live gesture holds the document axis still (editor-ui.md)
    // the consent boundary (kex2d-optimize-mode): a domain switch is a lossy track-wide rewrite,
    // so it can't land inside an open pin session — the rows gray on the same
    // predicate; this is the action-layer half of the pair (delete's belt-and-suspenders shape).
    if (!sectionOpsAllowed(editor.pinning)) return;
    // `convertDomain` rejects (writing nothing) on the active row and with nothing convertible — the
    // same reading the row is grayed on. It can also THROW: the carry's resolution-floor guard is
    // fail-loud by design, and its throw is a document-level refusal (the conversion is a pure
    // transform landed in one entry, so nothing is written when it fires). Refusing is this module's
    // established answer to a pick that cannot land — every other path here returns false and grays
    // the row — so the guard is caught HERE rather than softened in `domain.ts`, which would trade a
    // named fail-loud deliverable for a silent no-op everywhere including the tests.
    //
    // Refusing VISIBLY is the other half, and it is what every other unlandable pick in this module
    // does: the rows that cannot land are grayed, so the person is told before they click. This one
    // cannot be predicted from a predicate — `pickable` would have to run the whole carry — so the
    // row stays enabled and the refusal has to arrive after the click. It arrives as the app's ONE
    // status surface, the transient notice (`domain.convertFailed`, `editor.solveFailed`'s shape):
    // a plain sentence for the person, and the raw message — which names functions and prints g
    // residuals — to the console, never to the readout. A caught throw with no notice was silent to
    // the person AND to every gate (it also stopped reaching the capture harness's `pageerror`
    // watch), which is a fail-loud deliverable spending itself on nothing.
    try {
        convertDomain(history, ecs, target);
    } catch (e) {
        const { notice, detail } = convertFailed(e);
        console.error(detail);
        notify("error", notice);
        // the transient's own auto-dismiss (root `ui.md`: a transient outcome is a toast). `App`
        // carries the same timer for the solve readouts it raises; nothing exports one, and the
        // readout has no other dismissal, so a refusal raised here owns its own.
        clearTimeout(refusalTimer);
        refusalTimer = setTimeout(dismissNotice, NOTICE_MS);
    }
}
const NOTICE_MS = 6000; // OWED: duplicated in `App.svelte`; the clean close exports a raise/dismiss
// helper from `editor.ts`.
let refusalTimer: ReturnType<typeof setTimeout> | undefined;
// …and the view follows the DOMAIN, not the pick: `view.pan`/`pxPerU` are axis-unit quantities, so
// whenever the unit changes the window is re-expressed to hold the same stretch of ride — the ruler
// reads as re-labelled rather than jumped. Watching the domain (rather than re-framing inside
// `pickDomain`) is what makes an UNDO and a redo of the conversion land the same way, which is the
// only way back per the locked decision; and it lands on the frame the tick re-derives the domain
// in, so the chart never paints old-unit coordinates against a new-unit scale.
//
// The window is carried as FRACTIONS of the addressable span — `navWindow`'s own representation,
// the one already placing the navigator bracket — recomputed every frame the domain holds, so the
// frame it changes still has the pre-change reading. Carrying two RIDE positions instead is the
// wrong move and not reversible: the lead-out past the track end has no image under the projection
// (the ride's clock stops at its last sample, so every distance beyond it maps to the same
// `tTotal`), so a window reaching into the lead-out would collapse and never come back.
let winFrac: { l: number; r: number } | null = null;
let lastDomain: Domain | null = null;
$effect(() => {
    void tick;
    untrack(() => {
        if (chartW <= 0 || sTotal <= 0) return; // nothing framed yet — the initial frame will run
        // a live gesture holds the document axis still (editor-ui.md): rescaling it under a drag
        // would corrupt the screen-space grab the gesture resolves against. Returning here freezes
        // the BOOKKEEPING too, not just the write — `lastDomain` and `winFrac` keep their
        // pre-gesture readings, so a domain change that lands mid-gesture is deferred to the frame
        // after release rather than dropped.
        if (editor.dragging) return;
        if (lastDomain !== null && lastDomain !== domain && winFrac !== null) {
            const span = uTotal + marginArc(uTotal, mFloor);
            const pxPerU = chartW / Math.max(1e-6, (winFrac.r - winFrac.l) * span);
            view = clampView({ pan: winFrac.l * span * pxPerU, pxPerU }, chartW, uTotal, mFloor);
        }
        lastDomain = domain;
        // off the freshly-written `view` (the `clamped` derived is a frame behind inside untrack).
        const v = clampView(view, chartW, uFrozen ?? uTotal, mFloor);
        winFrac = navWindow(v, chartW, uTotal, mFloor);
    });
});

// edge-scroll grow-to-follow, shared by keyframe and handle drags (the standard drag
// auto-scroll rule): while the dragged cursor `cy` is held past the top/bottom chart edge,
// grow the value axis toward it (yGrow, timeline.ts) and re-map the held drag through the
// grown axis via `reapply` so the dragged element follows. the document (x) axis never pans
// under a content edit (editor-ui.md), so this is value-axis only. runs per frame from the
// yView effect; a within-chart cursor leaves the axis unchanged (yGrow returns it by identity).
function growValueAxis(cy: number, reapply: () => void): void {
    const grown = yGrow(yView, cy, TOP, h - BOT_PAD, EDGE_RATE, GROW_CAP);
    if (grown === yView) return;
    yView = grown;
    reapply();
}

const yOf = (val: number): number =>
    TOP + (1 - (val - yView.lo) / (yView.hi - yView.lo)) * (h - BOT_PAD - TOP);
// the velocity channel's own value→pixel projection, over `vView` — the same chart rows
// (TOP..h-BOT_PAD) as `yOf`, a DIFFERENT scale (m/s, not g). Never fed a g value or vice
// versa: the two axes share only the x-axis and the pixel band, not a unit.
const vOf = (val: number): number =>
    TOP + (1 - (val - vView.lo) / (vView.hi - vView.lo)) * (h - BOT_PAD - TOP);
// the inverse of yOf — a chart-local pixel y back to a g value, for placing/dragging
// force points against the displayed axis.
const yToG = (py: number): number => {
    const inner = Math.max(1, h - BOT_PAD - TOP);
    return yView.lo + (1 - (py - TOP) / inner) * (yView.hi - yView.lo);
};
// px-per-g magnitude for the g-axis (y grows downward, so a +Δg is −Δpy) — the vertical
// counterpart of `clamped.pxPerU` (px per metre on s). the tangent-handle geometry maps
// (Δs, Δg) handle offsets through both scales.
const pyPerG = $derived.by((): number => {
    const inner = Math.max(1, h - BOT_PAD - TOP);
    return inner / Math.max(1e-6, yView.hi - yView.lo);
});

// ── force authoring: points on the curve, the keyframe idiom ──
// filled diamonds at (s, g), authored INPUT (not optimization targets), so no drop-line
// and no driving/driven. the chart is a WHOLE-TRACK view: it draws every force section's
// points at once, and authoring is by cursor position — a double-click over a force
// section's arc adds a point there (no section pre-selection). all edits route through
// `history`. force points are authored section-local (s from the section entry, arclength
// ALWAYS — S6), so a point's chart position is its GLOBAL arclength projected onto the
// chart's own axis (`uOf`), identity in Distance and through the live s↔t table in Time.
//
// the coordinate lens's span table (track.ts): each section's entry + extent in arclength
// (`sectionSpans` — `offset`/`len`, no second axis, S3 retired the `entryU`/`lenU` alias
// reading) — the ONE source for every global readout on the chart — boundaries, clips, and
// force-keyframe placement all derive from it, none re-walks the baked ds.
const spans = $derived.by(() => {
    void tick;
    return eid === null ? [] : sectionSpans(ecs, eid);
});
// the interior section boundaries on the chart's own axis — drawn as chart guides, and the
// landmarks every s-axis snap resolves against. each non-last span's native exit
// (`offset + len`), so a boundary needs no projection in either domain. Reads through `uOfLen`
// (below `clips`, same reasoning) rather than plain `uOf`: an upstream lengthen crossing the
// gesture-frozen table's end shifts every downstream boundary exactly like it shifts a downstream
// clip's edges (finding 9's mechanism gap) — same seam, same fix.
const bounds = $derived.by((): number[] => spans.slice(0, -1).map((sp) => uOfLen(sp.offset + sp.len)));
// ── section clip strip (the marker lane): one clip per section over its cumulative
// arclength span, kind-colored + labeled, selecting `editor.section` — the SAME
// selection as the viewport span (one object, two surfaces). clip edges align with the
// chart's boundary guides (both are arclength). a force clip's right edge is its extent
// trim (below).
interface Clip {
    id: number;
    kind: SectionKind;
    s0: number; // cumulative arclength at the section entry (the geometry axis — node ticks, curve)
    s1: number; // cumulative arclength at the section exit
    u0: number; // the section entry projected onto the CHART's own axis (`uOf(s0)`) — where its
    u1: number; // clip and its keyframes draw, and its exit (`uOf(s1)`); identity in Distance
    len: number; // authored extent (force `Section.length`, arclength ALWAYS) — the extent trim's
    // own subject, kept distinct from `extent` below (finding 9: the two can disagree while the
    // bake truncates) — never read as a clamp domain directly, that's what `extent` is for.
    // the strip/keyframe clamp domain — a force section's AUTHORED extent (`len`, the same
    // constant `setSectionLength` writes) or a geo section's BAKED span (`s1 − s0`, which has no
    // authored twin). Two values that must agree travel as one (`coding.md`): every clamp-domain
    // reader takes `extent`, not `len`/`s1 − s0` re-derived per call site (`bandStrips`' own
    // former inline ternary collapses into this ONE place a strip keyframe's clamp bound reads
    // too, S3's substrate unification).
    extent: number;
}
// every clip edge, while a lengthen gesture is live, reads through the SAME extrapolating
// projection `applyLen`'s write used (`uToDExtend`'s inverse, `dToUExtend` — finding 9's fix):
// once the gesture's frozen table can no longer realize the growing authored extent, plain
// `dToU` pins a clip edge at the frozen table's last sample while `sectionSpans`' fresh per-tick
// bake keeps advancing the offset underneath it — the invisible lengthen. That's not only the
// DRAGGED clip's own exit — `sectionSpans` accumulates every DOWNSTREAM section's `offset` from
// the same live bake, so a downstream clip's edges cross the frozen table's end too and freeze in
// lockstep (the mechanism gap the adversarial pass on 0f6335a caught: gating this on `sec.id ===
// lenId` alone left every downstream clip on the plain, clamping path). So every clip's `u0`/`u1`
// routes through the gesture's own frozen table + exit speed for the gesture's whole duration —
// one gesture, one frozen basis, covering every `d` past the table end regardless of which
// section owns it. Outside a gesture (`lenId === null`) this is `uOf` exactly, since `dToUExtend`
// coincides with plain `dToU` wherever `d` never exceeds the live bake's own arc range.
const uOfLen = (d: number): number =>
    lenId !== null && gestureMapping ? dToUExtend(gestureMapping, domain, d, lenVExit) : uOf(d);
// One projection for section clips from the ECS — the shared computation both the `clips`
// `$derived` (paced by `void tick` for the render) and the `forceU`/`stripKfPx` `__kex` hooks
// call. The hooks call it directly for freshness: a capture flow that creates a keyframe via a
// synchronous ECS write and immediately reads pixel positions must not read a stale `$derived`
// that hasn't re-evaluated this frame. `spans` is also a `$derived` behind `void tick`, and a
// strip move/widen changes the bake (which changes `sectionSpans`), so the cached `spans` can
// be stale after such a write — the hook passes a FRESH `sectionSpans(ecs, eid)` call's result
// instead. `uOfLen` reads `$state` (`lenId`/`gestureMapping`), not a `$derived`, so it is always
// current — no frame-bound quantity enters this computation.
function computeClips(spanTable: SectionSpan[], world: State): Clip[] {
    const byId = new Map(spanTable.map((sp) => [sp.id, sp]));
    const res: Clip[] = [];
    for (const sec of sections(world)) {
        const sp = byId.get(sec.id);
        if (!sp) continue;
        res.push({
            id: sec.id,
            kind: sec.kind,
            s0: sp.offset,
            s1: sp.offset + sp.len,
            u0: uOfLen(sp.offset),
            u1: uOfLen(sp.offset + sp.len),
            len: sec.length,
            extent: sec.kind === SectionKind.Force ? sec.length : sp.len,
        });
    }
    return res;
}
const clips = $derived.by((): Clip[] => {
    void tick;
    return computeClips(spans, ecs);
});
// ── geo node ticks (read-only, kex2d-geo-ux stage 2): a small circle in the marker
// lane per INTERIOR node of a geo section, positioned via the section's own span
// offset (`Clip.s0`) plus the partial-sum arclength from `bakeOut.ds` up to the
// node's landing sample (`nodeArc`, timeline.ts), projected onto the chart's axis like
// every other arclength-authored landmark. Display + selection-highlight
// only — no hit-testing, no drag: a node's timeline position is DERIVED from
// geometry, and dragging it on this axis is the rejected inverse problem (spec
// `kex2d-geo-ux.md`'s locked decision). Node 0 (the entry) and the section's last
// baked node (the exit) sit exactly at the clip's own edges — already drawn by the
// clip strip and the boundary guides — so only orders `[1, bakedNodes-2]` tick; an
// orphan node past `bakedNodes` (a truncated bake, stale `.sample`) is excluded too.
interface NodeTick {
    eid: number;
    x: number; // canvas px (the projected `markerX`)
    sel: boolean;
    sec: number; // owning section id — the clips whose label fades when it carries ticks
}
const nodeTicks = $derived.by((): NodeTick[] => {
    void tick;
    if (eid === null) return [];
    const out = bakeOut.get(eid);
    if (!out) return [];
    const sel = editor.selection;
    const res: NodeTick[] = [];
    for (const c of clips) {
        if (c.kind !== SectionKind.Geo) continue;
        const info = sectionInfo.get(c.id);
        if (!info) continue;
        const handles = sectionHandles(ecs, c.id);
        for (let order = 1; order < info.bakedNodes - 1; order++) {
            const heid = handles[order];
            if (heid === undefined) continue;
            const d = c.s0 + nodeArc(out.ds, info.startSample, Handle.sample.get(heid));
            res.push({ eid: heid, x: markerX(d), sel: heid === sel, sec: c.id });
        }
    }
    return res;
});
// the geo sections currently showing interior ticks — their "Geo" word label fades so the
// ticks (content, drawn over it) read cleanly instead of colliding with the centered text
// (stage-2 label/tick note): once a section is shaped, its ticks carry its identity.
const tickedSections = $derived(new Set(nodeTicks.map((t) => t.sec)));
// every force section's points, flattened across the whole track — each carries its global axis
// coordinate, its section's entry (`startU`), and the authored extent (`len`) so the chart draws,
// picks, and clamps it without a per-section "active" selection.
interface ForcePt {
    id: number;
    section: number;
    s: number; // section-local position, arclength ALWAYS (`Force.s`'s own unit -- S6)
    g: number;
    u: number; // its GLOBAL arclength projected onto the chart's axis (`uOf`) -- pixel math
    // ONLY; never combine with `s`/`len`/`startD` (arclength) without going through `uOf`/`dOf`.
    startU: number; // the section's entry, likewise projected (`Clip.u0`)
    startD: number; // the section's entry in arclength (`Clip.s0`) -- the base every WRITE
    // (drag/field/scrub) adds a `dOf`-converted delta to; never mix with `startU`.
    len: number; // the section's authored extent, arclength ALWAYS (the typed-field's own
    // clamp domain, `kfFieldEdit` -- NOT the drag's: a grab drags freely past it, S5 F2)
}
// One projection for force-keyframe points from the ECS — the shared computation both the
// `forcePts` `$derived` (paced by `void tick` for the render) and the `forceU` `__kex` hook
// call. The hook calls it with FRESH `computeClips`/`sectionSpans` results (not the stale
// `$derived` values) so the keyframe positions are projected against the current bake's span
// table. A keyframe create alone does not change the clip set or span table, but a strip
// move/widen DOES change the bake (which changes `sectionSpans`), so the cached `$derived`
// values can be stale after such a write — the hook passes fresh values to avoid a
// mixed-freshness snapshot. `sectionForces(world, c.id)` is always a direct ECS query.
function computeForcePts(
    clipList: Clip[],
    spanTable: SectionSpan[],
    world: State,
): ForcePt[] {
    if (eid === null) return [];
    const res: ForcePt[] = [];
    for (const c of clipList) {
        if (c.kind !== SectionKind.Force) continue;
        for (const p of sectionForces(world, c.id)) {
            const d = toGlobal(spanTable, c.id, p.s);
            // unreachable today (`clips` is built from the same `spans`), but a stale span
            // dropping a point for one frame beats painting it at NaN.
            if (d === null) continue;
            res.push({
                id: p.id,
                section: c.id,
                s: p.s,
                g: p.g,
                // finding 9's mechanism gap (adversarial round 2): `d` is a DOWNSTREAM section's
                // own keyframe position, which shifts rigidly with an upstream lengthen exactly
                // like a downstream clip's own edges do — same live-bake `spans` source, same
                // frozen-table clamp risk. `uOfLen`, not plain `uOf` (`clips`' own fix, above).
                u: uOfLen(d),
                startU: c.u0,
                startD: c.s0,
                len: c.len,
            });
        }
    }
    return res;
}
const forcePts = $derived.by((): ForcePt[] => {
    void tick;
    return computeForcePts(clips, spans, ecs);
});
// the whole selected section SET (membership, for the clip highlight) — single-select is the
// size-1 case. read through the tick like the rest of `editor`; the per-frame `clips` rebuild
// re-evaluates the `.has` in the render loop (the `selForceSet` pattern above).
const selSections = $derived.by((): Set<number> => {
    void tick;
    return editor.sections.ids;
});
// the geo section that OWNS the selected node — its clip gets a quiet context wash (which
// clip the selection lives in). node and section selection are mutually exclusive
// (editor.ts), so a washed clip is never also the selected clip; the wash stays the quieter
// register — the node is the accent, the clip is context.
const washSection = $derived.by((): number | null => {
    void tick;
    const sel = editor.selection;
    return sel === null ? null : Handle.section.get(sel);
});
// the selected point's id (read through the per-RAF tick; editor is plain state).
const selForce = $derived.by((): number | null => {
    void tick;
    return editor.force;
});
// the whole selected force SET (membership, for the diamond highlight) — single-select is the
// size-1 case. read through the tick like the rest of `editor`; the per-frame `forcePts` rebuild
// re-evaluates the `.has` in the render loop. active is `selForce` above (the single subject).
const selForceSet = $derived.by((): Set<number> => {
    void tick;
    return editor.forces.ids;
});
// the live pin session's own clip (kex2d-optimize-mode stage 4), or null — the timeline's
// one read of the mode: the focus dim brackets its span, the striped clip marks it, and the
// driven keyframe styling keys off its section.
const optClip = $derived.by((): Clip | null => {
    void tick;
    const s = editor.pinning;
    if (s === null) return null;
    return clips.find((c) => c.id === s.section) ?? null;
});
// the modal-chrome clip (kex2d-idioms stage 8): the subject clip while the mode OR its exit
// transition (the paced landing) is live — `modeChromeSection`, the one chrome predicate. The
// hatch and the focus dim key HERE, so the modal presentation holds through the landing
// window and releases in one moment at expiry or skip. Enablement (`clip-add`) and the driven
// keyframe styling keep reading `optClip` — document truth (the lock ledger dies with the
// session anyway).
const chromeClip = $derived.by((): Clip | null => {
    void tick;
    const s = modeChromeSection();
    if (s === null) return null;
    return clips.find((c) => c.id === s) ?? null;
});
// locked force-keyframe ids for the live pin session (kex2d-optimize-mode stage 1) — read
// through the tick like `selForceSet`, so a diamond's driven styling stays live across a toggle.
const lockedSet = $derived.by((): Set<number> => {
    void tick;
    return editor.locked;
});
// the paced landing (kex2d-optimize-mode stage 5): while one runs, a moved diamond DRAWS at
// its interpolated g — the one cosmetic display override (the document already landed
// atomically; `editor.landing` clears on expiry/skip). per-RAF via the tick, like everything
// here, so the interpolation advances every frame.
const landing = $derived.by(() => {
    void tick;
    return editor.landing;
});
const dispG = (p: ForcePt): number =>
    landing === null ? p.g : (landingG(landing, p.id, performance.now()) ?? p.g);
const selPoint = $derived.by((): ForcePt | null => {
    if (selForce === null) return null;
    return forcePts.find((p) => p.id === selForce) ?? null;
});
// the point popover lives only as long as its subject (root ui.md): `selPoint` already
// derives null when the point is gone, but clear the dangling selection id too, so an
// undo/redo (or any path) that restores the same id can't resurrect the popover. one
// mechanism for every death path — no per-mutation deselect.
// the point popover lives only as long as its subject (root ui.md): `selPoint` already
// derives null when the point is gone, but clear the dangling selection id too, so an
// undo/redo (or any path) that restores the same id can't resurrect the popover. one
// mechanism for every death path — no per-mutation deselect.
//
// the dormant-$effect defect (Residue): `editor.force` is a plain getter over a non-reactive
// singleton, so reading it registers no dependency; `selPoint` is the one `$derived` that would.
// the original `if (editor.force !== null && selPoint === null)` short-circuits on the common
// initial-mount state (`editor.force === null`), never reads `selPoint`, and the effect never
// runs again — permanently dormant. reading `selPoint` unconditionally registers the dependency
// every evaluation, so the effect re-runs when `selPoint` later changes to null.
$effect(() => {
    const sp = selPoint;
    if (editor.force !== null && sp === null) selectForce(null);
});
// whether the selection is a multi-set — a right-click keeps the set, so Delete + Easing act on it,
// while the single-subject rows (Custom) gray out. The typed-field popover is single-keyframe
// context too, and hides on a multi-set exactly as the viewport ring does (editor-ui.md multi law):
// standard multi-select shows no single-keyframe context. Read `tick` directly (not through
// `selForceSet`): `editor.forces.ids` is mutated IN PLACE (`rebuild`/`toggleMember`/`setMember`
// never reassign the Set), so a derived layered on top of `selForceSet`'s reference never sees a
// changed value to invalidate on — only a derived reading the mutable size straight off `tick`
// re-evaluates every frame.
const multiForce = $derived.by((): boolean => {
    void tick;
    return editor.forces.ids.size > 1;
});
// whether the selected keyframe sits OUTSIDE the live lockdown (kex2d-optimize-mode stage 5) —
// its popover fields disable (grayed affordance; the write paths guard on the same predicate).
const selLocked = $derived.by((): boolean => {
    void tick;
    const p = selPoint;
    return p !== null && !sectionEditable(editor.pinning, p.section);
});

// the axis pair: a coordinate on the chart's own axis ↔ its canvas x. Every native subject (a
// force keyframe, a handle, an extent, a boundary) goes straight through these.
const uPx = (u: number): number => LEFT_GUT + uToPx(clamped, u);
const uAtPx = (px: number): number => pxToU(clamped, px - LEFT_GUT);
// the PROJECTED pair, for an arclength-authored subject (the recovered curve, a geo node tick,
// the cart's park): global distance `d` → canvas x, and back.
const markerX = (d: number): number => uPx(uOf(d));
const dAtPx = (px: number): number => dOf(uAtPx(px));

// the red ghost strip's own extents, screen-projected: `render.infeasibleSpans` walks
// `bakeOut.feasible` (the exact bad-edge test the viewport's dashed-red pass uses) into arclength
// spans; `markerX` is the SAME arclength→px projection the recovered curve draws through, so the
// band lands under the exact stretch the chart already reads as infeasible. Render-derived only —
// no entity, no persistence, no hit-test (render-derived only; the authored surface is the band's strip fills, not this).
const ghostSpans = $derived.by((): { x0: number; x1: number }[] => {
    void tick;
    if (eid === null || !curve) return [];
    const out = bakeOut.get(eid);
    if (!out) return [];
    return infeasibleSpans(curve.s, out.feasible, curve.n).map((sp) => ({
        x0: markerX(sp.start),
        x1: markerX(sp.end),
    }));
});

// ── velocity strips (T1, the header band's own authoring surface): every strip is
// track-global and section-blind (S2, Locked decision — may overlap multiple sections,
// persists through segment resize and structural ops), so this projects EVERY strip once,
// never per-clip. `u0`/`u1` are the strip's `start`/`end` projected onto the chart's own
// axis (`uOfLen` — finding 9's own extrapolating projection, so a strip drawn past a live
// lengthen gesture's frozen table still tracks) -- pixel math only; `start`/`end` stay
// track-global arclength (`Strip.start`/`.end`'s own unit), the coordinate every WRITE
// (`bandMove`) computes its target in directly via `dOf`. A strip wholly past the track's
// own live extent (`st.start >= len`) is skipped entirely (the extent law's "inert, never
// displaced onto the preceding edge" — the bake's own `edgeStrips` mirrors this).
interface BandStrip {
    id: number;
    start: number; // track-global, arclength ALWAYS
    end: number;
    value: number;
    u0: number; // global chart axis (pixel math only)
    u1: number;
    // the track's own live extent (the last span's `offset + len`) — the clamp domain's
    // outer bound every strip shares, since a span is section-blind.
    len: number;
}
// the track's own live extent off a span table — 0 with no live bake.
function trackLen(spanTable: SectionSpan[]): number {
    if (spanTable.length === 0) return 0;
    const last = spanTable[spanTable.length - 1];
    return last.offset + last.len;
}
// One projection for strip bands from the ECS — the shared computation both the `bandStrips`
// `$derived` (paced by `void tick` for the render) and the `stripKfPx`/`stripPx` `__kex` hooks
// call. The hooks call it directly for freshness: a capture flow that widens or moves a strip
// via a synchronous ECS write and then creates a keyframe and reads pixel positions must not
// read a stale `$derived` that hasn't re-evaluated this frame — the strip layout (`bandStrips`)
// and the span table (`spans`) are both `$derived` behind `void tick`, and a strip move/widen
// changes the bake (which changes `sectionSpans`), so their cached values can be stale. The
// hook passes a FRESH `sectionSpans` result instead, so strips and keyframes are projected
// against the SAME fresh snapshot — never one fresh and one stale.
function computeBandStrips(spanTable: SectionSpan[], world: State): BandStrip[] {
    if (eid === null) return [];
    const len = trackLen(spanTable);
    const res: BandStrip[] = [];
    for (const st of allStrips(world)) {
        if (st.start >= len) continue; // wholly past the track's own live extent — inert
        res.push({
            id: st.id,
            start: st.start,
            end: st.end,
            value: st.value,
            u0: uOfLen(st.start),
            u1: uOfLen(Math.min(st.end, len)), // drawn clipped
            len,
        });
    }
    return res;
}
const bandStrips = $derived.by((): BandStrip[] => {
    void tick;
    return computeBandStrips(spans, ecs);
});
// boundary ticks: the disambiguator for two abutting strips (Locked decision) — a strip's start
// exactly equal to another's end, drawn as a small notch so the shared boundary reads as two
// controlled spans meeting, not one. `allStrips` is already start-sorted, so adjacent members
// are adjacent in station order.
const stripTicks = $derived.by((): number[] => {
    void tick;
    if (eid === null) return [];
    const res: number[] = [];
    const strips = allStrips(ecs);
    for (let i = 1; i < strips.length; i++) {
        if (strips[i].start !== strips[i - 1].end) continue;
        res.push(uPx(uOfLen(strips[i].start)));
    }
    return res;
});
// the selected strip, its position live — `selPoint`'s own shape.
const selStrip = $derived.by((): BandStrip | null => {
    void tick;
    const id = editor.strip;
    if (id === null) return null;
    return bandStrips.find((s) => s.id === id) ?? null;
});
// every strip's keyframes, projected to screen coordinates — the value-surface diamonds
// drawn in the velocity channel (T2: value in the graph), for every strip (Locked decision
// "Visibility": solid where a strip AUTHORS it, not where one is selected). Each keyframe
// carries its track-global `s`, its velocity `v`, and its global chart-axis `u` (for the x
// pixel), plus the id of the strip it belongs to (`strip`) — the selected strip's own
// keyframes brighten in the markup below, the same rung force keyframes use.
interface StripKfPt {
    id: number;
    strip: number;
    // the REPRESENTATIVE section the owning strip's own `start` resolves to
    // (`stripEditableAt`'s own reading) — strips carry no section ownership (S2, Locked
    // decision), so this is a read for the pin-lockdown gate alone, not storage identity.
    section: number;
    s: number; // track-global, arclength ALWAYS
    v: number; // velocity (m/s)
    u: number; // GLOBAL arclength projected onto the chart's axis (`uOf`) -- pixel math only
    startU: number; // always `uOf(0)` now (S2: strips store global `d` directly, no
    // section-entry offset to project) -- kept as a field so the shared force/strip drag and
    // typed-field write paths (`ForcePt.startU`'s own twin) stay one shape.
    startD: number; // always 0 (S2's own write-base retirement, `ForcePt.startD`'s twin)
    start: number; // the strip's start (track-global, arclength)
    end: number; // the strip's end (track-global, arclength)
}
// One projection for strip-keyframe points from the ECS — the shared computation both the
// `stripKfPts` `$derived` (paced by `void tick` for the render) and the `stripKfPx` `__kex`
// hook call. The hook calls it with FRESH `computeBandStrips`/`computeClips`/`sectionSpans`
// results (not the stale `$derived` values) so strips and keyframes are projected against the
// SAME fresh span table. A keyframe create alone does not change the strip set or span table,
// but a strip move/widen DOES change the bake (which changes `sectionSpans`), so the cached
// `$derived` values can be stale after such a write — the previous shape (passing the stale
// `bandStrips`/`spans` `$derived`) read fresh keyframes projected against a stale strip
// layout, a mixed-freshness snapshot where the returned pixel was not where the diamond was
// drawn. `stripKeyframes(world, s.id)` is always a direct ECS query.
function computeStripKfPts(
    strips: BandStrip[],
    spanTable: SectionSpan[],
    world: State,
): StripKfPt[] {
    const out: StripKfPt[] = [];
    for (const s of strips) {
        // the REPRESENTATIVE section for the pin-lockdown gate (`stripEditableAt`'s own
        // reading) — computed once per strip, not per keyframe.
        const section = toLocal(spanTable, s.start)?.section ?? -1;
        for (const k of stripKeyframes(world, s.id)) {
            out.push({
                id: k.id,
                strip: s.id,
                section,
                s: k.s,
                v: k.v,
                // `k.s` is track-global already (S2: no section-entry offset to project
                // through) -- `uOfLen`'s own extrapolating projection, matching `bandStrips`.
                u: uOfLen(k.s),
                startU: uOf(0),
                startD: 0,
                start: s.start,
                end: s.end,
            });
        }
    }
    return out;
}
const stripKfPts = $derived.by((): StripKfPt[] => {
    void tick;
    return computeStripKfPts(bandStrips, spans, ecs);
});
// every strip's own authored velocity curve, sampled over its extent for the solid draw —
// either the constant `value` (no keyframes) or the keyframed curve (profile.sampleForce),
// drawn for every strip (Locked decision "Visibility"). `sel` marks the selected strip's own
// curve so the render can brighten it, the header band's own selected/unselected split
// (`bandStrips` render, above).
interface StripCurve {
    id: number;
    sel: boolean;
    points: { x: number; y: number }[];
}
const stripCurves = $derived.by((): StripCurve[] => {
    void tick;
    const selId = editor.strip;
    return bandStrips.map((s) => {
        const kfs = stripKeyframes(ecs, s.id);
        const x0 = uPx(s.u0);
        const x1 = uPx(s.u1);
        // `u0`/`u1` are already clipped to the section's extent (`bandStrips`); the curve
        // sample's own `localS` range clips the same way, so the drawn width (x0..x1) and
        // the sampled station range agree — a raw `s.end` past the extent would otherwise
        // squish the visible portion of the curve into a fraction of the pixel span.
        const clippedEnd = Math.min(s.end, s.len);
        let points: { x: number; y: number }[];
        if (kfs.length === 0) {
            // no keyframes: one constant across the span (the AE stopwatch reading)
            const y = vOf(s.value);
            points = [
                { x: x0, y },
                { x: x1, y },
            ];
        } else {
            // keyframed curve: evaluate sampleForce at each pixel across the extent
            const pts = kfs.map((k) => ({ s: k.s, g: k.v }));
            const res: { x: number; y: number }[] = [];
            const n = Math.max(2, Math.floor(x1 - x0));
            for (let i = 0; i <= n; i++) {
                const frac = i / n;
                const localS = s.start + frac * (clippedEnd - s.start);
                const v = sampleForce(pts, localS);
                res.push({ x: x0 + frac * (x1 - x0), y: vOf(v) });
            }
            points = res;
        }
        return { id: s.id, sel: s.id === selId, points };
    });
});
// the popover lives only as long as its subject, `selPoint`'s own law: an undo/redo restoring
// the same id can't resurrect a dangling selection. `void tick` first (not `selStrip`'s own
// shape): `editor.strip` is a plain, untracked property read, so a bare `editor.strip !== null
// && …` short-circuits away the ONE tracked read (`selStrip`) whenever the effect's most recent
// run started from a null selection — leaving the effect with no tracked dependency at all,
// permanently dormant (the same defect `selPoint`'s own $effect had, fixed above). Reading
// `tick` unconditionally re-runs it every frame regardless.
$effect(() => {
    void tick;
    if (editor.strip !== null && selStrip === null) selectStrip(null);
});
// strip-keyframe dismissal: clear a stale ACTIVE keyframe selection when it's gone (undo/delete)
// — `selPoint`'s own pattern (only the active member, never a live prune of the whole set: a
// bulk delete already clears the set through its own caller). Uses `void tick` (the strip
// dismissal's own pattern) to avoid the dormant-`selPoint`-`$effect` defect — `editor.stripKf`
// is a plain property on a non-reactive singleton, so reading it registers no dependency;
// `void tick` re-runs every frame regardless, and `stripKfPts` (a `$derived`) provides the
// tracked read.
$effect(() => {
    void tick;
    if (editor.stripKf !== null && !stripKfPts.some((k) => k.id === editor.stripKf)) {
        selectStripKf(null);
    }
});
// the selected strip keyframe's own point — `selPoint`'s twin (S3, findings 10/3: value shown
// on selection is part of the shared substrate, not just selectability); active is `editor.stripKf`
// (the single subject, `editor.stripKfs`' own active member) — the popover binds to it exactly
// like `selPoint` binds to `selForce`.
const selStripKfPt = $derived.by((): StripKfPt | null => {
    void tick;
    if (editor.stripKf === null) return null;
    return stripKfPts.find((k) => k.id === editor.stripKf) ?? null;
});
// whether the strip-keyframe selection is a multi-set (S4's booked multi-select) — `multiForce`'s
// twin: the single-keyframe popover hides on a multi-set exactly as the force keyframe's does
// (editor-ui.md multi law). read `tick` directly, not `editor.stripKfs.ids` (`multiForce`'s own
// in-place-mutation note applies identically here).
const multiStripKf = $derived.by((): boolean => {
    void tick;
    return editor.stripKfs.ids.size > 1;
});
// the whole selected strip-keyframe SET (membership, for the diamond highlight) — `selForceSet`'s
// twin. read through the tick like the rest of `editor`; the per-frame `stripKfPts` rebuild
// re-evaluates the `.has` in the render loop.
const selStripKfSet = $derived.by((): Set<number> => {
    void tick;
    return editor.stripKfs.ids;
});
// `selLocked`'s own twin — the pin-mode lockdown gates a strip keyframe's fields exactly like
// a force keyframe's (`keyframeDown`'s own `sectionEditable` guard on the drag path).
const selStripKfLocked = $derived.by((): boolean => {
    void tick;
    const k = selStripKfPt;
    return k !== null && !sectionEditable(editor.pinning, k.section);
});
// the selected one-shot's own typed v field (F5) — `selPoint`/`selStripKfPt`'s point-kind
// twin, but scalar-valued: a one-shot carries no keyframe curve, one number (S3), and its
// position axis is LOCKED (Locked decision F5: it lives at `d = 0`, `entryOneShot`'s own
// invariant), so unlike the other two this shape carries no `u`/position field at all — only
// the id and the value the popover's `v` field reads/writes. Read straight off `entryOneShot`
// (not a `bandStrips`-style RAF-projected list, `selPoint`'s own pattern) since the one-shot
// has no `spans`-projected geometry to wait on.
const selOneShotPt = $derived.by((): { id: number; value: number } | null => {
    void tick;
    if (!editor.oneShot) return null;
    const os = entryOneShot(ecs);
    return os ?? null;
});
// `stripEditableAt(0)`'s own reading — the pin-mode lockdown gates the one-shot's value field
// exactly like `selLocked`/`selStripKfLocked` gate theirs (`deleteSelectedOneShot`'s own guard,
// the same station).
const selOneShotLocked = $derived.by((): boolean => {
    void tick;
    return selOneShotPt !== null && !stripEditableAt(0);
});
// a force keyframe's chart x — its global axis coordinate, straight off the lens's affine.
const ptX = (p: ForcePt | StripKfPt): number => uPx(p.u);

// ── snapping (the AE magnet): a snap resolves in chart-local px (the `snap` resolver,
// timeline.ts), so `snapX`/`snapY` are the guide flashes to draw when an axis latches.
// chart-local px (past the g-gutter subtracted); LEFT_GUT is re-added when rendered.
let snapX: number | null = $state(null); // an active s-axis snap: vertical guide px
let snapY: number | null = $state(null); // an active g-axis snap: horizontal guide py

// the clip-strip Cut's snap tell has no drag to clear it FROM (`clipMenu`, above) — the summoned
// context menu's own lifetime stands in for the gesture: the guide clears the moment the menu
// that snapped it closes, by whatever means (an action, click-away, Esc). `editor` is a plain
// singleton, not a `$state` rune, so an `$effect` reading `editor.context` directly has ZERO
// tracked dependencies — it fires once at mount and never again, the exact defect this codebase
// already routes around everywhere else (App.svelte's `ctx`/its own effect: every reactive read
// of `editor.*` goes through a tick-gated `$derived.by` first, and the effect depends on THAT).
// Same shape here: derive the live boolean off the per-RAF `tick`, then the effect tracks it.
const ctxOpen = $derived.by((): boolean => {
    void tick;
    return editor.context !== null;
});
$effect(() => {
    if (!ctxOpen) snapX = null;
});

// the s-axis snap targets in chart-local px (the horizontal magnet): content landmarks
// only (editor-ui.md) — section boundaries (0, interior boundaries, optionally the track
// end), other force points, and — only while parked, so a live-playing playhead isn't a
// moving magnet — the playhead. no ruler ticks: they're the zoom-dependent 1-2-5 raster,
// display not content. the caller excludes the dragged point and picks whether its own
// moving edge (the track end) is a target.
// `sameSection` names the dragged anchor's own section: its keys are dropped from the pool
// because a station one of them occupies is a landing the Δd cap holds short of
// (`track.keyframeRoom`, S5b), and a gesture never snaps to a target it can't reach (editor-ui.md Snapping — the same law
// that keeps the extent trim off its own moving edge). Keys in OTHER sections stay: a boundary
// coincidence is legal and is exactly what a cut plants, so they remain reachable landmarks.
function sTargets(opts: {
    exclude?: Set<number>;
    sameSection?: number | null;
    playhead: boolean;
    trackEnd: boolean;
}): number[] {
    const v = clamped;
    const out: number[] = [uToPx(v, 0)];
    for (const b of bounds) out.push(uToPx(v, b));
    if (opts.trackEnd) out.push(uToPx(v, uTotal));
    for (const p of forcePts) {
        if (opts.exclude?.has(p.id)) continue;
        if (opts.sameSection != null && p.section === opts.sameSection) continue;
        out.push(uToPx(v, p.u));
    }
    // the cart rides in arclength, so the playhead is the one landmark here that projects.
    if (opts.playhead && paused && cartS !== null) out.push(uToPx(v, uOf(cartS)));
    return out;
}
// the g-axis snap targets in chart py (the vertical magnet): content landmarks only
// (editor-ui.md) — the 1g baseline (the physical gravity landmark) + every other point's
// g. no integer-g gridline raster: 1g survives as a physical baseline, not as a gridline.
function gTargets(exclude?: Set<number>): number[] {
    const out: number[] = [yOf(Y_BASE)];
    for (const p of forcePts) if (!exclude?.has(p.id)) out.push(yOf(p.g));
    return out;
}
// the v-axis snap targets in chart py (the vertical magnet for strip keyframes): content
// landmarks only — the 0 m/s baseline (V_BASE, the velocity twin of Y_BASE) + every other
// strip keyframe's v. the v-twin of `gTargets`.
function vTargets(exclude?: Set<number>): number[] {
    const out: number[] = [vOf(V_BASE)];
    for (const k of stripKfPts) if (!exclude?.has(k.id)) out.push(vOf(k.v));
    return out;
}
// the s-axis snap targets for a strip-keyframe drag: section boundaries + other strip
// keyframes (excluding the dragged set and the same strip's keys — a station one of them
// occupies is a landing the write refuses). the s-twin of `sTargets` for strip keyframes.
function stripKfSTargets(opts: {
    exclude?: Set<number>;
    sameStrip?: number | null;
    playhead: boolean;
    trackEnd: boolean;
}): number[] {
    const v = clamped;
    const out: number[] = [uToPx(v, 0)];
    for (const b of bounds) out.push(uToPx(v, b));
    if (opts.trackEnd) out.push(uToPx(v, uTotal));
    for (const k of stripKfPts) {
        if (opts.exclude?.has(k.id)) continue;
        if (opts.sameStrip != null && k.strip === opts.sameStrip) continue;
        out.push(uToPx(v, k.u));
    }
    if (opts.playhead && paused && cartS !== null) out.push(uToPx(v, uOf(cartS)));
    return out;
}

// the pointer's AXIS coordinate (clamped to the addressable span) — where every native gesture
// reads the cursor: a grab origin, an insertion, a trim candidate.
function chartU(e: MouseEvent): number {
    const rect = canvas.getBoundingClientRect();
    return clamp(uAtPx(e.clientX - rect.left), 0, uTotal);
}

// double-click the chart drops a force point at that s, in whatever force section the
// cursor is over (resolved on the chart's native axis — no section pre-selection), ON the authored
// profile (g = the profile's value there — the DAW/AE envelope-insertion identity: a
// new point never bends the curve, and drags from a known start). over a geo section
// (or empty), it's a no-op.
function chartCreate(e: MouseEvent): void {
    let u = chartU(e);
    // T2: if a strip is selected and the double-click is over the strip's extent,
    // create a velocity keyframe on the strip's curve (the force-curve machinery).
    // Reads the strip directly from the ECS (not a tick-gated `$derived`) so the
    // double-click fires on the same frame the selection landed.
    const stripId = editor.strip;
    if (stripId !== null) {
        const stripEid = stripAt(ecs, stripId);
        if (stripEid !== null) {
            const stripStart = Strip.start.get(stripEid);
            const stripEnd = Strip.end.get(stripEid);
            // strips are track-global (S2): `stripStart`/`stripEnd` ARE the storage
            // coordinate, no section to resolve. a create has no gesture to freeze a table
            // for — `dOf`/`uOf` read the LIVE mapping here, same as `gestureMapping` would
            // fall back to outside a drag.
            const u0 = uOf(stripStart);
            const u1 = uOf(stripEnd);
            if (u >= u0 && u <= u1) {
                if (!stripEditableAt(stripStart)) return;
                const rect = canvas.getBoundingClientRect();
                const cy = clamp(e.clientY - rect.top, TOP, Math.max(TOP, h - BOT_PAD));
                const v = vView.lo + (1 - (cy - TOP) / (h - BOT_PAD - TOP)) * (vView.hi - vView.lo);
                const d = clamp(dOf(u), stripStart, stripEnd);
                addStripKeyframe(history, ecs, stripId, d, Math.max(V_FLOOR, v));
                return;
            }
        }
    }
    // snap the placement through the same landmark resolver the drags use (toggle, Ctrl/Cmd
    // bypass, and SNAP_PX all apply) — the AE insert-at-CTI idiom — before resolving the value.
    // creation targets exclude force points (an occupied s is degenerate) but keep boundaries,
    // origin, track end, and the parked playhead. no guide flash: a double-click has no gesture
    // to clear one, and the resolver's guide is a drag-lifetime affordance.
    if (snapActive(e.ctrlKey || e.metaKey)) {
        const targets = creationTargets(
            clamped,
            bounds,
            uTotal,
            paused && cartS !== null ? uOf(cartS) : null,
        );
        const hit = snap(uToPx(clamped, u), targets);
        if (hit !== null) u = clamp(pxToU(clamped, hit), 0, uTotal);
    }
    const c = clips.find((x) => x.kind === SectionKind.Force && u >= x.u0 && u <= x.u1);
    if (!c) return; // not over a force section
    // the lockdown (kex2d-optimize-mode stage 5): in-mode, keys are added only on the
    // pinning section (the sanctioned way to create give) — other sections are read-only.
    if (!sectionEditable(editor.pinning, c.id)) return;
    // value = the authored profile at the SNAPPED section-local s (insert-on-curve: the new
    // point never bends the curve), so both position and value derive from the snapped place.
    // `u` is the chart's own axis (seconds-scaled in Time view); `dOf` (the live table -- a
    // create has no gesture to freeze one) projects it back to the arclength the store holds.
    const s = clamp(dOf(u) - c.s0, 0, c.len);
    selectForce(createForce(history, ecs, c.id, s, sampleForce(sectionForces(ecs, c.id), s)));
}

// ── keyframe drag (unified: force and strip keyframes ride ONE code path — S1's substrate law).
// drag a diamond in both axes (horizontal = s, vertical = g or v), one undo entry. the
// last cursor position is kept in canvas space so the per-frame edge-grow (the yView/vView
// effect's drag branch) can re-map it through a grown axis. Shift is a no-op on a keyframe
// drag: the per-axis gesture-start magnet is the "change just one axis" affordance, so a
// dominant-axis lock is redundant here.
type KfKind = "force" | "strip";
// every keyframe kind, in declaration order — the marquee's own resolve loop (S9) iterates
// this so a third kind never needs its own copy of the deselect/marquee-merge call.
const KF_KINDS: readonly KfKind[] = ["force", "strip"];
// the Δd-cap overlap refusal's "strictly short" margin (S5b) — small against `S_GRID = 1`
// (a whole grid step), far above f32 station-precision noise at drag-reachable magnitudes, so
// a capped landing never round-trips onto the occupied station it was held short of.
const OVERLAP_CAP_EPS = 1e-3;
let dragKf: { kind: KfKind; id: number } | null = $state(null); // the ANCHOR keyframe
// the cursor's axis coordinate at pointerdown -- the grab origin the anchor's arclength is
// measured DELTA-FROM, projected through the GESTURE-FROZEN s↔t table (`s = s0 + (dOf(u) -
// dOf(u0))`, never a raw axis delta -- that is seconds-scaled in Time view and would corrupt
// this metres store, S6). `dOf` is identity in Distance, so a return-to-grab-pixel drag still
// writes its start value back bit-exactly there.
let dragKfU0 = 0;
let dragKfStartD = 0; // the ANCHOR's section entry in arclength -- the WRITE base
let dragKfSection = -1; // the ANCHOR's section — the scope its own keys are unreachable within
let dragKfStrip = -1; // the ANCHOR's strip id (strip kind only — for overlap check scope)
let dragKfCx = 0; // last cursor, canvas-local px
let dragKfCy = 0;
let dragKfMod = false; // Ctrl/Cmd held (live) — the snap bypass modifier
let dragKfS0 = 0; // the grab s / v — each axis's gesture-start landmark (always-on magnet)
let dragKfV0 = 0;
// the dragged SET, captured at gesture start: every selected member's start s/v. single-select
// is the size-1 case (just the anchor). the whole set moves by ONE shared (Δs, Δv) — relative
// offsets preserved exactly, unbounded by any strip/segment extent (S5, F2: no rigid-clamp
// bounds carried here anymore — a keyframe drags freely past its container).
let dragKfMembers: { id: number; s0: number; v0: number; section: number }[] = [];
let dragKfMemberSet: Set<number> = new Set();
// the v-to-pixel and pixel-to-v projections, kind-specific: force uses yOf/yToG (g axis),
// strip uses vOf/its inverse (v axis). set at drag start.
let dragKfValToY: (v: number) => number = yOf;
let dragKfYToVal: (py: number) => number = yToG;
let dragKfVGrid = G_GRID;
let dragKfValFloor: number | null = null; // null for force, V_FLOOR for strip
// the write, kind-specific: `setForcePoint`/`setStripKeyframe` share one `(ecs, id, s, v)`
// signature — the descriptor's own "setter" facet (`kfDesc`, S9), set at drag start alongside
// the other per-kind config so this write loop needs no `kind` branch of its own.
let dragKfSetter: (ecs: State, id: number, s: number, v: number) => void = setForcePoint;
function applyKeyframeDrag(): void {
    if (dragKf === null) return;
    const kind = dragKf.kind;
    // both axes clamp the cursor to the chart
    const cx = clamp(dragKfCx, LEFT_GUT, Math.max(LEFT_GUT, w));
    // s-axis: same projection for both kinds (arclength through the gesture-frozen table).
    // NO extent clamp (S5, F2): a keyframe grab never snaps back into its strip/segment
    // window — the container bound retired everywhere along this one shared path, both
    // kinds, so a keyframe left outside its container by a resize stays exactly where the
    // cursor puts it.
    let sAnchor = dragKfS0 + (dOf(uAtPx(cx)) - dOf(dragKfU0));
    // v-axis: kind-specific mapping
    let vAnchor = dragKfYToVal(clamp(dragKfCy, TOP, h - BOT_PAD));
    snapX = null;
    snapY = null;
    const active = snapActive(dragKfMod);
    // s-axis snap — same `snapAxis` call for both kinds, kind-specific targets
    {
        const uAnchor = uOf(dragKfStartD + sAnchor);
        const targets = kind === "force"
            ? sTargets({ exclude: dragKfMemberSet, sameSection: dragKfSection, playhead: true, trackEnd: true })
            : stripKfSTargets({ exclude: dragKfMemberSet, sameStrip: dragKfStrip, playhead: true, trackEnd: true });
        const startPx = uToPx(clamped, uOf(dragKfStartD + dragKfS0));
        const r = snapAxis(active, uToPx(clamped, uAnchor), uAnchor, targets, GRID, (px) =>
            pxToU(clamped, px), startPx);
        if (r.guide !== null) {
            sAnchor = r.guide === startPx ? dragKfS0 : dOf(r.value) - dragKfStartD;
            snapX = r.guide;
        } else {
            sAnchor = dOf(r.value) - dragKfStartD;
        }
    }
    // v-axis snap — same `snapAxis` call, kind-specific targets and grid
    {
        const targets = kind === "force" ? gTargets(dragKfMemberSet) : vTargets(dragKfMemberSet);
        const startPy = dragKfValToY(dragKfV0);
        const r = snapAxis(active, dragKfValToY(vAnchor), vAnchor, targets, dragKfVGrid, dragKfYToVal, startPy);
        vAnchor = r.guide === startPy ? dragKfV0 : r.value;
        snapY = r.guide;
    }
    // shared delta — no rigid group clamp against a container bound (S5, F2): the whole
    // set moves by the SAME Δs regardless of any member's own strip/segment extent.
    const ds = sAnchor - dragKfS0;
    const dv = vAnchor - dragKfV0;
    // Δd-cap overlap refusal (S5b, Locked decision), applied to the BLOCK: `keyframeRoom`
    // reads each member's own directional room to the nearest sibling station NOT in the
    // dragged group, and the shared Δd is capped strictly short of the tightest member's
    // room — never an equality test (the pre-S5b `keyframeTaken` block check only ever fired
    // by accident, off the now-deleted extent clamp; discrete pointer sampling sweeps past a
    // bare equality target). `dir` is the sign of the desired move; a zero `ds` caps to
    // itself either way.
    const owner = kind === "force" ? -1 : dragKfStrip;
    const dir: 1 | -1 = ds < 0 ? -1 : 1;
    let cap = Infinity;
    for (const m of dragKfMembers) {
        const room = keyframeRoom(
            ecs,
            kind,
            kind === "force" ? m.section : owner,
            m.s0,
            dragKfMemberSet,
            dir,
        );
        if (room < cap) cap = room;
    }
    const capped = Math.max(0, cap - OVERLAP_CAP_EPS); // hold STRICTLY short of the room
    const dsWrite = dir > 0 ? Math.min(ds, capped) : Math.max(ds, -capped);
    if (dsWrite !== ds) snapX = null; // the cap engaged: the snap guide would point past it
    for (const m of dragKfMembers) {
        const s = m.s0 + dsWrite;
        const v = m.v0 + dv;
        dragKfSetter(ecs, m.id, s, dragKfValFloor !== null ? Math.max(dragKfValFloor, v) : v);
    }
}
// double-press detection for the diamond summon: a keyframe drag captures the pointer on
// pointerdown, which retargets the compatibility `dblclick` off the diamond (onto the canvas),
// so the summon is detected here by timing on the second press — the diamond hit beats the
// chart's insertion double-click. mirrors geo's double-click tangent-edit summon.
const FDBL_MS = 300;
let lastFdownT = 0;
let lastFdownId = -1;
// the per-kind descriptor keyframeDown (and applyKeyframeDrag's own setter) branch on: the
// selection container, its select/multi-write/activate triad, the value mapping, grid, floor,
// and setter (S9, F7 — round 2's own standard). Declared ONCE so the clicked-selected-vs-
// unselected rule, the shift-toggle, and the multi-member drag-set build below run through a
// SINGLE path for both kinds, closing the twin `if`/`else` limbs the round-2 feel gate found:
// a shared function NAME over two per-kind CODE paths is still a twin (Locked decision,
// feel-gate round 2). Snap-target queries (`sTargets`/`stripKfSTargets`, `gTargets`/`vTargets`)
// stay their own per-kind data queries in `applyKeyframeDrag` — genuinely different candidate
// pools, not a duplicated selection/deselect/toggle rule, so S9's letter (the descriptor's six
// named facets) doesn't require folding them in here.
interface KfDesc {
    sel: Selection;
    pts: (ForcePt | StripKfPt)[];
    select: (id: number | null, mode?: SelectMode) => void;
    selectMany: (ids: number[], active: number | null) => void;
    activate: (id: number) => void;
    val: (p: ForcePt | StripKfPt) => number; // value mapping: which field is "the value" (g or v)
    valToY: (v: number) => number;
    yToVal: (py: number) => number;
    grid: number;
    floor: number | null;
    setter: (ecs: State, id: number, s: number, v: number) => void;
}
function kfDesc(kind: KfKind): KfDesc {
    if (kind === "force")
        return {
            sel: editor.forces,
            pts: forcePts,
            select: selectForce,
            selectMany: selectForces,
            activate: activateForce,
            val: (p) => (p as ForcePt).g,
            valToY: yOf,
            yToVal: yToG,
            grid: G_GRID,
            floor: null,
            setter: setForcePoint,
        };
    return {
        sel: editor.stripKfs,
        // scoped to the CURRENTLY selected strip: a strip keyframe's own sub-selection is
        // layered on strip selection (`editor.stripKfs.ids` non-empty implies `editor.strip !==
        // null`, `editor.ts`'s own invariant), so a candidate pool spanning every strip on the
        // chart would let a marquee (or a multi-drag) build a set spanning two strips at once,
        // which nothing else in the substrate models. `keyframeDown` already selects the owning
        // strip before reaching this descriptor (`if (editor.strip !== k.strip) selectStrip
        // (k.strip)`), so this filter is a no-op there; it's load-bearing for `marqueeUp`
        // (S9, F7 finding (a)), where the rect is checked against whichever strip is selected.
        pts: stripKfPts.filter((k) => k.strip === editor.strip),
        select: selectStripKf,
        selectMany: selectStripKfs,
        activate: activateStripKf,
        val: (p) => (p as StripKfPt).v,
        valToY: vOf,
        yToVal: (py) => vView.lo + (1 - (py - TOP) / (h - BOT_PAD - TOP)) * (vView.hi - vView.lo),
        grid: V_GRID,
        floor: V_FLOOR,
        setter: setStripKeyframe,
    };
}
// the unified keyframe pointerdown — both force and strip keyframes ride this one path (S1;
// S9 closes F7 by routing the selection grammar itself through `kfDesc` too, not just the
// drag). No clamp domain (S5, F2): a grabbed keyframe drags freely past its strip/segment
// extent, both kinds, through this one shared path.
function keyframeDown(e: PointerEvent, kind: KfKind, pt: ForcePt | StripKfPt): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (kind === "strip") {
        const k = pt as StripKfPt;
        // lockdown up front for strip keyframes — a locked section's keys don't even select
        // (force's own lockdown, below the shift/double-click grammar, SELECTS but never
        // drags: a pre-existing per-kind ORDERING divergence, not one of S9's three enumerated
        // findings, left as-is). a keyframe draws for every strip, so grabbing one owned by an
        // unselected strip must select that strip first (its diamonds are drawn).
        if (!sectionEditable(editor.pinning, k.section)) return;
        if (editor.strip !== k.strip) selectStrip(k.strip);
    }
    const desc = kfDesc(kind);
    // shift-click TOGGLES set membership — a selection gesture, not a drag. ONE path, both
    // kinds (S9 closes F7: the twin `if`/`else` limbs collapse to this single call).
    if (e.shiftKey) {
        desc.select(pt.id, "toggle");
        return;
    }
    if (kind === "force") {
        const p = pt as ForcePt;
        // double-click → summon handles (force-only; strip keyframes have no tangent handles).
        if (lastFdownId === p.id && e.timeStamp - lastFdownT < FDBL_MS) {
            lastFdownT = 0;
            lastFdownId = -1;
            if (sectionEditable(editor.pinning, p.section)) enterForceEdit(p.id);
            return;
        }
        lastFdownT = e.timeStamp;
        lastFdownId = p.id;
    }
    // clicked-selected-vs-unselected rule — ONE path, both kinds.
    if (desc.sel.ids.has(pt.id)) desc.activate(pt.id);
    else desc.select(pt.id);
    // lockdown: another section's force keys SELECT but never drag (strip already returned
    // above when locked).
    if (kind === "force" && !sectionEditable(editor.pinning, pt.section)) return;
    // drag set: every selected member (multi-member support) — ONE path, both kinds.
    const set = desc.sel.ids;
    const members = set.size > 1 ? desc.pts.filter((m) => set.has(m.id)) : [pt];
    dragKfMembers = members.map((m) => ({ id: m.id, s0: m.s, v0: desc.val(m), section: m.section }));
    dragKfS0 = pt.s;
    dragKfV0 = desc.val(pt);
    dragKfStartD = pt.startD;
    dragKfSection = pt.section;
    dragKfStrip = kind === "force" ? -1 : (pt as StripKfPt).strip;
    dragKfValToY = desc.valToY;
    dragKfYToVal = desc.yToVal;
    dragKfVGrid = desc.grid;
    dragKfValFloor = desc.floor;
    dragKfSetter = desc.setter;
    // common drag setup
    dragKfMemberSet = new Set(dragKfMembers.map((m) => m.id));
    const rect = canvas.getBoundingClientRect();
    dragKfCx = e.clientX - rect.left;
    dragKfCy = e.clientY - rect.top;
    dragKfMod = e.ctrlKey || e.metaKey;
    // freeze the s↔t table for the whole gesture (S6)
    gestureMapping = mapping;
    // the grab origin
    dragKfU0 = uAtPx(clamp(dragKfCx, LEFT_GUT, Math.max(LEFT_GUT, w)));
    // begin the history gesture (kind-specific)
    if (kind === "force")
        beginForceMoves(ecs, dragKfMembers.map((m) => m.id));
    else
        beginStripKeyframeMoves(ecs, dragKfMembers.map((m) => m.id));
    dragKf = { kind, id: dragKfMembers[0].id };
    beginDrag(canvas, e.pointerId);
    window.addEventListener("pointermove", keyframeMove);
    window.addEventListener("pointerup", keyframeUp);
    window.addEventListener("pointercancel", keyframeUp);
}
function keyframeMove(e: PointerEvent): void {
    if (dragKf === null) return;
    const rect = canvas.getBoundingClientRect();
    dragKfCx = e.clientX - rect.left;
    dragKfCy = e.clientY - rect.top;
    dragKfMod = e.ctrlKey || e.metaKey;
    applyKeyframeDrag();
}
function keyframeUp(): void {
    if (dragKf === null) return;
    dragKf = null;
    snapX = null;
    snapY = null;
    gestureMapping = null;
    commit(history);
    window.removeEventListener("pointermove", keyframeMove);
    window.removeEventListener("pointerup", keyframeUp);
    window.removeEventListener("pointercancel", keyframeUp);
}
function cancelKfDrag(): void {
    if (dragKf === null) return;
    dragKf = null;
    snapX = null;
    snapY = null;
    gestureMapping = null;
    cancel();
    window.removeEventListener("pointermove", keyframeMove);
    window.removeEventListener("pointerup", keyframeUp);
    window.removeEventListener("pointercancel", keyframeUp);
}

// ── marquee (box-select) on the chart: a left-drag begun on empty chart space (the chartzone,
// after the diamonds' own grab). the targets are the force keyframe diamonds — the box does not
// cross into the marker/clip lane (it only ever hits diamonds). below DRAG_PX the press stays a
// plain click (the existing deselect-on-empty-chart), and only past it does a rect appear and the
// merge fire on release. shift = toggle. no history gesture (a selection change is not a command).
//
// the gesture arms with ZERO side effects at pointerdown — the pointer capture (`beginDrag`) is
// taken only once the dead zone is crossed. capture retargets the whole pointer stream, including
// the compatibility mouse events, to the captured canvas, which breaks the browser's two-click
// dblclick accumulation on the chartzone rect — so capturing on every plain press silently killed
// `chartCreate` (double-click authoring). a click and a dblclick must reach the rect untouched.
let marqueeStart: { x: number; y: number } | null = null;
let marqueeRect: Rect | null = $state(null); // canvas-local px; drawn as the SVG box
let marqueeArmed = false; // past the dead zone → the rect is live AND the canvas holds capture
let marqueeShift = false;
let marqueePointer = -1; // the pressed pointer, captured on arm (not on down)
function marqueeDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    // layered dismissal: a chart click while a popover field is focused only blurs it (the
    // browser's own focus change), never arms a marquee or deselects — the NEXT click does.
    const ae = document.activeElement;
    if (ae instanceof HTMLElement && (ae.closest(".ptip") || ae.closest(".snap-pop"))) return;
    const rect = canvas.getBoundingClientRect();
    marqueeStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    marqueeRect = null;
    marqueeArmed = false;
    marqueeShift = e.shiftKey;
    marqueePointer = e.pointerId;
    window.addEventListener("pointermove", marqueeMove);
    window.addEventListener("pointerup", marqueeUp);
    window.addEventListener("pointercancel", marqueeCancel);
    window.addEventListener("keydown", marqueeEsc, { capture: true });
}
function marqueeMove(e: PointerEvent): void {
    if (!marqueeStart) return;
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    if (!marqueeArmed && Math.hypot(cx - marqueeStart.x, cy - marqueeStart.y) >= DRAG_PX) {
        marqueeArmed = true;
        beginDrag(canvas, marqueePointer); // capture + the drag flag, only now that it IS a drag
    }
    // clamp the moving corner to the chart: the rect paints under `fclip`, so an unclamped drag
    // into the gutter/ruler would select diamonds the clip hides (a panned-off point). the drawn
    // box and the hit box must be the same box.
    marqueeRect = marqueeArmed
        ? normRect(
              marqueeStart.x,
              marqueeStart.y,
              clamp(cx, LEFT_GUT, Math.max(LEFT_GUT, w)),
              clamp(cy, TOP, Math.max(TOP, h - BOT_PAD)),
          )
        : null;
}
// clear every keyframe kind's own selection — the shared form marqueeUp's plain-click
// deselect needs from each kind (S9 closes F7's finding (b) here too: a bare `selectForce(null)`
// beside a bare `selectStripKf(null)` is two hand-paired calls that silently omit a third kind
// later; one loop over `kfDesc` can't). Each kind's own `null` form already skips the
// exclusive-sweep (mirroring `selectForce(null)`'s existing shape), so calling both in either
// order is safe — neither disturbs the other, `editor.strip`, or `editor.sections`.
function deselectKfKinds(): void {
    for (const kind of KF_KINDS) kfDesc(kind).select(null);
}
function marqueeUp(): void {
    if (!marqueeStart) return;
    const armed = marqueeArmed;
    const rect = marqueeRect;
    const shift = marqueeShift;
    marqueeCancel(); // detach listeners + clear rect/state
    if (!armed || !rect) {
        // a plain click on empty chart deselects the force/strip-keyframe/section kinds
        // (shift-click preserves) — the ORIGINAL, narrower deselect, kept narrow on purpose:
        // the chart is not one of the S4 transition table's rows (`kex2d-event-lane`
        // Validation names {segment, span, keyframe, empty-ruler, empty-lane} only), and a
        // strip must SURVIVE this click — `chartCreate`'s T2 branch (double-click a strip's
        // own curve to drop a velocity keyframe) reads `editor.strip` on the SECOND click of
        // the pair, after this handler already ran once on the first. Widening this to
        // `deselectAll()` silently broke that create path (discovered via `bun run capture`,
        // section.pw.ts's own strip-keyframe flows reading 2 rows where 3 were expected).
        if (!shift) {
            selectSection(null);
            deselectKfKinds();
        }
        return;
    }
    // ONE resolve loop reaches both keyframe kinds (S9 closes F7's finding (a): before, the
    // candidate pool was built from `forcePts` alone — `Timeline.svelte:1789` — so a rubber-
    // band never took a strip keyframe, with or without shift). Each kind's own hit set merges
    // against ITS OWN current selection and writes through ITS OWN multi-write, so a marquee
    // that only catches one kind's diamonds leaves the other kind exactly as it was — matching
    // a plain click's own per-kind exclusivity (`exclusiveForce`/`exclusiveStripKf`).
    //
    // CROSS-KIND TIE-BREAK (reachable — force and strip keyframes share this same y-pixel
    // band, `yOf`/`vOf`'s own comment): a single rect that hits BOTH a force keyframe and a
    // strip keyframe on the currently-selected strip resolves in `KF_KINDS` DECLARATION ORDER
    // ALONE, with no other priority signal. `KF_KINDS` lists "force" before "strip", so the
    // force branch runs first: `desc.selectMany` → `exclusiveForce()` clears `editor.strips`,
    // nulling `editor.strip`. The strip branch's own candidate pool (`kfDesc("strip").pts`,
    // filtered on `k.strip === editor.strip`) is computed AFTER that clear, in the SAME
    // synchronous pass — so it reads empty and the strip branch never fires at all. The
    // outcome is therefore FORCE-WINS: the force keyframe selects, the strip keyframe is
    // silently dropped from the candidate pool it would otherwise have joined (measured
    // directly: a marquee spanning a force point and a same-band strip keyframe leaves
    // `forceSelIds` populated and `stripKfSelIds` empty). Reversing `KF_KINDS`'s declared
    // order would not flip this — `exclusiveForce` unconditionally clears `strips`/`stripKfs`
    // whichever position it runs from, so "force wins when both hit" is closer to a property
    // of `exclusiveForce`'s own unconditional clear than of iteration order in general, but the
    // ORDER is still what decides WHICH branch's clear gets to run against a still-populated
    // sibling pool. This is a deliberate exclusivity model requiring some deterministic
    // choice — not one of S9's three enumerated findings, and not fixed here.
    let anyHits = false;
    for (const kind of KF_KINDS) {
        const desc = kfDesc(kind);
        const cand = desc.pts.map((p) => ({ id: p.id, x: ptX(p), y: desc.valToY(desc.val(p)) }));
        const hitIds = hits(rect, cand);
        if (hitIds.length === 0) continue;
        anyHits = true;
        const res = merge(desc.sel, hitIds, shift ? "toggle" : "replace");
        desc.selectMany(res.ids, res.active);
    }
    if (!shift && !anyHits) {
        selectSection(null);
        deselectKfKinds();
    }
}
function marqueeCancel(): void {
    const captured = marqueeArmed; // only an armed marquee ever took the capture
    marqueeStart = null;
    marqueeRect = null;
    marqueeArmed = false;
    marqueePointer = -1;
    window.removeEventListener("pointermove", marqueeMove);
    window.removeEventListener("pointerup", marqueeUp);
    window.removeEventListener("pointercancel", marqueeCancel);
    window.removeEventListener("keydown", marqueeEsc, { capture: true });
    // release the drag flag + capture (a mid-gesture Esc/blur has no pointerup). guarded: an
    // un-armed press holds no capture, so ending here would clear some other gesture's flag.
    if (captured) endDragGesture();
}
function marqueeEsc(e: KeyboardEvent): void {
    if (e.key !== "Escape" || !marqueeStart) return;
    e.stopImmediatePropagation(); // the marquee is the topmost dismissal rung while active
    e.preventDefault();
    marqueeCancel();
}

// ── force keyframe handle edit: the summoned inner layer (the force analogue of geo's
// tangent edit). double-clicking a diamond enters handle-edit sub-mode (editor.forceEdit),
// rendering the keyframe's in/out handles; a derived keyframe shows the FLAT ghost tangents
// (Linear 0 · Cubic 1/3 · Quintic 7/15 of the segment span), an explicit one its stored
// offsets. a handle drag is a free gesture constrained only by the x-monotonicity clamp
// (Blender's rule: handle Δs stays within the segment span so g(s) is a function); dragging
// the first side of a derived keyframe seeds both from the flat tangents (no jump), Aligned
// keeping the other side collinear on the chart. easing lives on the LEADING keyframe.
interface FHandle {
    side: "in" | "out";
    x: number; // knob screen point (canvas-local px)
    y: number;
    ds: number; // the handle's (Δs, Δg) offset from the keyframe — the selected-handle readout
    dg: number;
    ghost: boolean; // a derived (flat) tangent shown as a hollow affordance, vs an explicit solid one
}
// the keyframe currently in handle edit + its rendered handles (in needs a previous
// keyframe, out a following one — a chain-end keyframe shows one, mirroring geo).
const editHandles = $derived.by((): { pt: ForcePt; handles: FHandle[] } | null => {
    void tick;
    const id = editor.forceEdit;
    if (id === null) return null;
    const pt = forcePts.find((p) => p.id === id);
    if (!pt) return null;
    const pts = forcePts.filter((p) => p.section === pt.section).sort((a, b) => a.s - b.s);
    const idx = pts.findIndex((p) => p.id === id);
    const prev = idx > 0 ? pts[idx - 1] : null;
    const next = idx < pts.length - 1 ? pts[idx + 1] : null;
    const tan = forceTangent(ecs, id);
    const handles: FHandle[] = [];
    if (prev) {
        // each side is independently explicit-or-derived: a stored offset shows solid, an
        // absent one shows the derived flat ghost (the segment-scoped Custom model).
        const off = tan?.in ?? derivedIn(pt, prev);
        handles.push({ side: "in", x: uPx(pt.u + off.ds), y: yOf(pt.g + off.dg), ds: off.ds, dg: off.dg, ghost: tan?.in === undefined });
    }
    if (next) {
        const off = tan?.out ?? derivedOut(pt, next);
        handles.push({ side: "out", x: uPx(pt.u + off.ds), y: yOf(pt.g + off.dg), ds: off.ds, dg: off.dg, ghost: tan?.out === undefined });
    }
    return { pt, handles };
});
// the selected handle (within handle-edit): its live (Δs, Δg) offset + screen anchor — the
// contextual readout swaps to it (from the keyframe) while it's picked. derives null when no
// handle is selected or the edited keyframe is gone (the popover dismisses by subject).
const selHandle = $derived.by((): { pt: ForcePt; side: "in" | "out"; ds: number; dg: number; x: number; y: number } | null => {
    void tick;
    const side = editor.forceHandle;
    const eh = editHandles;
    if (side === null || !eh) return null;
    const hnd = eh.handles.find((hh) => hh.side === side);
    if (!hnd) return null;
    return { pt: eh.pt, side, ds: hnd.ds, dg: hnd.dg, x: hnd.x, y: hnd.y };
});
// the derived ghost tangent offsets shown for an un-customized handle side — the SAME shape a
// Custom-materialize would seed (`segmentSeed`), so grabbing a ghost never jumps. a preset-eased
// segment's ghost is the flat tangent (dg = 0) at the tag's influence; a **Linear** segment's
// ghost is chord-aligned at influence 1/3 (its flat tangent is zero-length — a dot on the diamond —
// so it draws along the chord instead, grabbable). the OUT handle reaches forward over the
// FOLLOWING segment (governed by this keyframe's ease); the IN handle backward over the PRECEDING
// segment (governed by the previous keyframe's ease).
function derivedOut(pt: ForcePt, next: ForcePt): Offset {
    return segmentSeed(toProfilePoint(pt), toProfilePoint(next), "out");
}
function derivedIn(pt: ForcePt, prev: ForcePt): Offset {
    return segmentSeed(toProfilePoint(prev), toProfilePoint(pt), "in");
}

let dragTan: { id: number; side: "in" | "out" } | null = $state(null);
let tanGrabDx = 0; // knob screen x − cursor x at grab (relative tracking, no jump)
let tanGrabDy = 0;
const THDRAG_PX = 4; // click-vs-drag dead zone on a handle knob (the Figma/Blender threshold)
let tanDownX = 0; // grab client coords — the dead-zone origin for the click-vs-drag test
let tanDownY = 0;
let tanCx = 0; // last applyTan args (canvas-local, grab offset folded in) — the per-frame
let tanCy = 0; // edge-grow re-maps the held handle through the grown axis (the keyframe-drag mirror)
let tanMoved = false; // the gesture crossed the dead zone → a drag, not a select-click
let tanMod = false; // Ctrl/Cmd held (live) — frees the offset-space grid snap (the keyframe-drag bypass)
// the unit keyframe→knob screen ray captured at grab — the gesture-start axis magnet
// (the geo tangent-handle mechanism, `latchAngle`): while the dragged tip stays within
// LATCH_PX perpendicular of it the drag latches to the start direction, so a flat ghost
// stays flat and a single-axis pull keeps the other axis pinned. zero when the grab was
// keyframe-coincident (a zero-length Linear ghost) — no magnet then, matching geo.
let tanRayX = 0;
let tanRayY = 0;
function tanDown(e: PointerEvent, hnd: FHandle, pt: ForcePt): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation(); // beat the diamond's own drag under the knob
    const rect = canvas.getBoundingClientRect();
    tanGrabDx = hnd.x - (e.clientX - rect.left);
    tanGrabDy = hnd.y - (e.clientY - rect.top);
    const rx = hnd.x - uPx(pt.u);
    const ry = hnd.y - yOf(pt.g);
    const rl = Math.hypot(rx, ry);
    tanRayX = rl > 1e-6 ? rx / rl : 0;
    tanRayY = rl > 1e-6 ? ry / rl : 0;
    // any interaction addresses the handle (the Blender rule — the last-touched control is the
    // active one): selecting on pointerdown swaps the readout to this handle for both a click and
    // a drag. the dead zone keeps its one job below — gating the WRITE, not the selection — so a
    // jittery click still selects but never materializes a tangent.
    selectForceHandle(hnd.side);
    tanDownX = e.clientX;
    tanDownY = e.clientY;
    tanMoved = false;
    tanMod = e.ctrlKey || e.metaKey;
    beginForceTangent(ecs, pt.id);
    dragTan = { id: pt.id, side: hnd.side };
    // freeze the s↔t table for the whole gesture (S6) -- see `keyframeDown`'s own note; a handle
    // reshapes the curve between keys, which feeds back into v(s) same as a keyframe drag does.
    gestureMapping = mapping;
    beginDrag(canvas, e.pointerId);
    window.addEventListener("pointermove", tanMove);
    window.addEventListener("pointerup", tanUp);
    window.addEventListener("pointercancel", tanUp); // finalize the history gesture on cancel too
}
function tanMove(e: PointerEvent): void {
    if (dragTan === null) return;
    tanMod = e.ctrlKey || e.metaKey; // live: the grid bypass can be toggled mid-drag
    if (!tanMoved && Math.hypot(e.clientX - tanDownX, e.clientY - tanDownY) > THDRAG_PX)
        tanMoved = true;
    // the dead zone gates the WRITE, not just the release verdict: a sub-threshold jitter
    // during a click must not write a tangent (materializing a ghost to explicit + recording
    // a stray history entry). no `applyTan` until the gesture is a real drag; below it, tanUp
    // resolves the release as a select-click.
    if (!tanMoved) return;
    const rect = canvas.getBoundingClientRect();
    tanCx = e.clientX - rect.left + tanGrabDx;
    tanCy = e.clientY - rect.top + tanGrabDy;
    applyTan(tanCx, tanCy);
}
function applyTan(cx: number, cy: number): void {
    if (dragTan === null) return;
    const { id, side } = dragTan;
    const pt = forcePts.find((p) => p.id === id);
    if (!pt) return;
    // gesture-start axis magnet: latch the candidate knob onto the grab ray while it
    // stays within the corridor (the geo tangent-handle `latchAngle`), so a mostly-
    // single-axis drag keeps the other axis at its start — a flat ghost drags flat.
    const kx = uPx(pt.u);
    const ky = yOf(pt.g);
    const latch = latchAngle(cx - kx, cy - ky, tanRayX, tanRayY);
    cx = kx + latch.x;
    cy = ky + latch.y;
    // the dragged side's raw (Δs, Δg) from the latched cursor, both in OFFSET space (the
    // store's own arclength unit and g from the keyframe — the space the readout prints). `cx`
    // is the chart's own axis (seconds-scaled in Time view); `dOf` (the gesture-frozen table)
    // projects it to arclength before subtracting the keyframe's own global arclength position
    // (`pt.startD + pt.s`) -- never `pt.u`, which is that SAME position on the chart's axis
    // (S6 fix: this used to difference two axis-space values and store the result as arclength).
    let ds = dOf(uAtPx(clamp(cx, LEFT_GUT, Math.max(LEFT_GUT, w)))) - (pt.startD + pt.s);
    let dg = yToG(clamp(cy, TOP, h - BOT_PAD)) - pt.g;
    // Δg grid-quantizes to the force vocabulary (G_GRID), so a snapped handle reads as
    // vocabulary ("+0.5 g"); Ctrl/Cmd frees it to continuous. Δs stays CONTINUOUS (F3d): a
    // keyframe's s is a placement on the axis (vocabulary), but a handle's Δs is curvature
    // shaping — inherently continuous — so it is never quantized. the gesture-start axis magnet
    // already fired above (latchAngle) on both axes; this is the grid path of the shared
    // `snapAxis` resolver (empty targets, no value landmark) — magnet, THEN the Δg grid, then
    // composeTangent's x-clamp last, since the clamp is the hard invariant that must win.
    const active = snapActive(tanMod);
    dg = snapAxis(active, 0, dg, [], G_GRID, (x) => x, null).value;
    const tan = tangentFor(id, side, ds, dg);
    if (tan) setForceTangent(ecs, id, tan);
}
// resolve a keyframe's full explicit tangent by feeding the pure `composeTangent` (timeline.ts)
// this keyframe's neighbours and the live axis scales — the write both the handle drag and the
// typed handle field go through. null when the point is gone (the gesture opens nothing).
function tangentFor(id: number, side: "in" | "out", ds: number, dg: number): ForceTangent | null {
    const pt = forcePts.find((p) => p.id === id);
    if (!pt) return null;
    const pts = forcePts.filter((p) => p.section === pt.section).sort((a, b) => a.s - b.s);
    const idx = pts.findIndex((p) => p.id === id);
    const prevS = idx > 0 ? pts[idx - 1].s : null;
    const nextS = idx < pts.length - 1 ? pts[idx + 1].s : null;
    // a handle's Δs is stored in arclength always (S6, `Force.tin`/`tout`'s own unit — never a
    // second unit the domain conversion used to scale it into), so the Aligned/Mirror coupling's
    // screen-collinearity test still needs the axis scale (`pxPerU`) to read it on screen; the
    // Δs VALUE itself is arclength either way.
    return composeTangent(side, ds, dg, prevS, pt.s, nextS, forceTangent(ecs, id), clamped.pxPerU, pyPerG);
}
function tanUp(): void {
    if (dragTan === null) return;
    dragTan = null;
    gestureMapping = null; // release the gesture-frozen table
    // selection already happened on pointerdown (the Blender rule — any interaction addresses the
    // handle); nothing to decide on release. the popover re-anchors clear of the workspace, so a
    // drag leaving the handle selected no longer overlaps the diamond it addresses.
    commit(history); // one handle drag → one entry; a no-move grab records nothing
    window.removeEventListener("pointermove", tanMove);
    window.removeEventListener("pointerup", tanUp);
    window.removeEventListener("pointercancel", tanUp);
}
function cancelTanDrag(): void {
    if (dragTan === null) return;
    dragTan = null;
    gestureMapping = null; // release the gesture-frozen table
    cancel(); // interrupted (unmount mid-drag): revert to the pre-gesture handles
    window.removeEventListener("pointermove", tanMove);
    window.removeEventListener("pointerup", tanUp);
    window.removeEventListener("pointercancel", tanUp);
}

// right-click a diamond → the force keyframe menu at the cursor.
function forceCtx(e: MouseEvent, p: ForcePt): void {
    e.preventDefault();
    e.stopPropagation();
    openForceMenu(e.clientX, e.clientY, p.id);
}
// the chart's only right-click subject is a keyframe diamond (`forceCtx`, on the marker's own
// rect, above) — round 8 retired both the free-position Cut this graph never gets (Locked
// decision: a right-click in empty chart space names no object, so opening the section menu
// there reads as the click having hit something it didn't) and the pre-existing curve-span→
// leading-keyframe convention (a right-click on a non-keyframe point on the force curve used to
// address the keyframe before it — "I wouldn't expect that", the round-8 verdict: a right-click
// addresses what's under the cursor or nothing, never a nearby landmark). So the chartzone
// itself carries no `oncontextmenu` at all; the outer `.body` wrapper's own handler
// (`e.preventDefault()`) is what keeps a miss from opening the browser's menu, and a right-click
// there changes no selection because nothing here writes one.

// ── the force keyframe context menu (Delete / Easing ▸ / Handles / Reset), an instance of
// the shared menu language rendered at the app root over both surfaces. its visibility
// DERIVES from the target point still existing (like the section menu), so any death path
// dismisses it; the effect clears the dangling id so an undo can't resurrect it.
const fmenu = $derived.by((): { x: number; y: number; id: number } | null => {
    void tick;
    const m = editor.forceMenu;
    if (m === null || !forcePts.some((p) => p.id === m.id)) return null;
    return m;
});
$effect(() => {
    if (editor.forceMenu !== null && fmenu === null) closeForceMenu();
});
// the target keyframe's stored easing tag (governs the following segment).
const fmenuEase = $derived.by((): Easing => {
    void tick;
    const m = editor.forceMenu;
    return m === null ? Easing.Cubic : forceEase(ecs, m.id);
});
// whether the following segment is Custom — bounded by an explicit handle on either
// SIDE of the segment (this keyframe's out or the next keyframe's in), never the far
// sides (this keyframe's in / the next's out, which belong to the neighbouring segments).
// DERIVED provenance, per-side, never a stored flag — agrees exactly with what a preset
// pick on this keyframe clears (setForcesEase's segment-scoped clear).
const fmenuCustom = $derived.by((): boolean => {
    void tick;
    const m = editor.forceMenu;
    if (m === null) return false;
    const pt = forcePts.find((p) => p.id === m.id);
    if (!pt) return false;
    if (forceTangent(ecs, m.id)?.out !== undefined) return true;
    const pts = forcePts.filter((p) => p.section === pt.section).sort((a, b) => a.s - b.s);
    const idx = pts.findIndex((p) => p.id === m.id);
    const next = idx < pts.length - 1 ? pts[idx + 1] : null;
    return next !== null && forceTangent(ecs, next.id)?.in !== undefined;
});
// whether the target keyframe holds explicit handles (any presence bit set) — a derived-only
// keyframe has no tangent mode to edit, so it shows no Tangents ▸ submenu.
const fmenuHasHandles = $derived.by((): boolean => {
    void tick;
    const m = editor.forceMenu;
    return m !== null && forceTangent(ecs, m.id) !== undefined;
});
// the target keyframe's tangent mode — a stored tangent's own mode (Aligned when derived, though
// the submenu that reads this only shows when a tangent is stored).
const fmenuMode = $derived.by((): TangentMode => {
    void tick;
    const m = editor.forceMenu;
    return (m !== null && forceTangent(ecs, m.id)?.mode) || TangentMode.Aligned;
});
// whether the target keyframe is the last in its section — it governs no following
// segment, so its menu carries no Easing ▸ entry (nothing to ease). its in-handle is still
// reachable by double-clicking it (the preceding segment addresses the keyframe before it).
const fmenuTerminal = $derived.by((): boolean => {
    void tick;
    const m = editor.forceMenu;
    if (m === null) return false;
    const pt = forcePts.find((p) => p.id === m.id);
    if (!pt) return false;
    const pts = forcePts.filter((p) => p.section === pt.section).sort((a, b) => a.s - b.s);
    return pts[pts.length - 1]?.id === m.id;
});
// the selected keyframes that GOVERN a following segment (non-terminal) — the bulk Easing targets
// (AE/Unity bulk interpolation). a terminal keyframe (last in its section) eases nothing, so it's
// excluded; when the set has none applicable the Easing ▸ row grays out (never hides — the
// enablement law). single-select is the size-1 case (`[active]` when the active is non-terminal).
const bulkEaseIds = $derived.by((): number[] => {
    void tick;
    if (editor.forceMenu === null) return []; // only the open menu reads this (`fmenuTerminal`'s guard)
    const ids = editor.forces.ids;
    const res: number[] = [];
    for (const p of forcePts) {
        if (!ids.has(p.id)) continue;
        const secPts = forcePts.filter((q) => q.section === p.section).sort((a, b) => a.s - b.s);
        if (secPts[secPts.length - 1]?.id !== p.id) res.push(p.id); // not the section's last → non-terminal
    }
    return res;
});
// the keyframe menu's rows are built by the pure `menus.keyframeMenu` (the row law lives with it);
// this assembles its state descriptor from the deriveds above and binds the actions to the active
// keyframe + the live member sets.
const fmenuItems = $derived.by((): MenuItem[] => {
    const m = editor.forceMenu;
    if (m === null) return [];
    const id = m.id; // the active member (openForceMenu promotes the right-clicked one) — single subject
    // the lockdown (kex2d-optimize-mode stage 5): bulk rows need the whole SET editable, the
    // single-subject rows the active member — grayed, never hidden (the enablement law).
    const setOk = forceSetEditable(ecs);
    const pt = forcePts.find((p) => p.id === id);
    const activeOk = pt !== undefined && sectionEditable(editor.pinning, pt.section);
    // Cut's OWN consent-boundary gate — stricter than `activeOk` above (which is `true` inside a
    // pin session on the active keyframe's OWN section, exactly the case Cut must still bar).
    const opsAllowed = sectionOpsAllowed(editor.pinning);
    // the Lock/Unlock row's member set — resolved by `acts.lockCandidates`, the same read the
    // toggle itself acts on: the label and the act are one row wearing two names (`editor-ui.md`'s
    // toggle-labeling law), so they must not derive the set twice.
    const lockIds = lockCandidates(ecs);
    const lock = pt === undefined ? null : lockLabel(editor.pinning, pt.section, lockIds, editor.locked);
    // the Easing ▸ and Tangents ▸ fields are GETTERS: each is guarded by a builder branch, and
    // `easeTargets`/`custom` walk the whole force store while `customGlyph` re-solves the addressed
    // segment's bezier. a terminal single keyframe shows Delete alone, so it must pay for none of
    // them. a getter runs synchronously inside this `$derived.by` when the builder reads it, so the
    // reactive dependency still registers.
    return keyframeMenu(
        {
            setOk,
            activeOk,
            opsAllowed,
            lock,
            multi: multiForce,
            terminal: fmenuTerminal,
            get easeTargets() {
                return bulkEaseIds.length;
            },
            get custom() {
                return fmenuCustom;
            },
            get ease() {
                return fmenuEase;
            },
            hasHandles: fmenuHasHandles,
            get mode() {
                return fmenuMode;
            },
            presetGlyph,
            get customGlyph() {
                return customGlyph(id);
            },
            // the landmark Cut's own interior bound (`acts.keyframeCuttable`) — no cursor lens
            // needed, unlike the section menu's free-position `canCut` (the keyframe under the
            // menu already names the exact cut point). `keyframeMenu`'s own `opsAllowed` folds in
            // the lockdown separately, so this stays the bare interior predicate.
            canCut: pt !== undefined && keyframeCuttable(pt.s, pt.len),
        },
        {
            // the chrome keys first, the factory spread LAST (`editor-ui.md` Menus): a re-forked
            // `remove` here would otherwise shadow the hoisted body for the menu while `Del` kept
            // the factory's — the exact drift this seam deletes.
            setEase: (e) => setForcesEase(history, ecs, bulkEaseIds, e),
            chooseCustom: () => chooseCustom(id),
            pickMode: (mode) => pickForceMode(id, mode),
            ...keyframeActs(ecs),
        },
    );
});
// set the addressed keyframe's tangent mode as one undo entry (the geo `pickMode` analogue),
// reconciling the handle pair in chart pixels so it stays jump-consistent with the drag coupling.
function pickForceMode(id: number, mode: TangentMode): void {
    setForceTangentMode(history, ecs, id, mode, clamped.pxPerU, pyPerG);
}
// choose Custom on the addressed segment (this keyframe → the next): step into handle edit on
// this keyframe and materialize the segment's two bounding sides — this keyframe's out and the
// next keyframe's in — from their current derived shape (no curve jump; a Linear segment seeds
// chord-aligned so the handles are grabbable), as one undoable entry (`materializeCustom`). an
// already-explicit side is left as-is.
function chooseCustom(id: number): void {
    enterForceEdit(id);
    materializeCustom(history, ecs, id);
}
// ── easing-row curve glyphs (the Blender F-curve convention): each row draws its real curve
// in a 0 0 22 14 viewBox, so the icon is the family it names and can't drift. a preset draws a
// normalized flat-tangent S at the tag's influence (Linear degenerates to the chord); Custom
// draws the addressed keyframe's actual following segment, fit to its own bounding box.
const GLYPH_PAD = 3;
const GLYPH_W = 22;
const GLYPH_H = 14;
const glyphX = (u: number): number => GLYPH_PAD + u * (GLYPH_W - 2 * GLYPH_PAD);
const glyphY = (u: number): number => GLYPH_H - GLYPH_PAD - u * (GLYPH_H - 2 * GLYPH_PAD);
function presetGlyph(ease: Easing): string {
    const i = autoTangent(ease, 1, "out").ds; // the influence fraction (0 | 1/3 | 7/15)
    return `M${glyphX(0)} ${glyphY(0)} C${glyphX(i)} ${glyphY(0)} ${glyphX(1 - i)} ${glyphY(1)} ${glyphX(1)} ${glyphY(1)}`;
}
// build the profile ForcePoint (ease + explicit handles) for a UI force point.
function toProfilePoint(p: ForcePt): ForcePoint {
    const t = forceTangent(ecs, p.id);
    return { s: p.s, g: p.g, ease: forceEase(ecs, p.id), in: t?.in, out: t?.out };
}
function customGlyph(id: number): string {
    const pt = forcePts.find((p) => p.id === id);
    if (!pt) return presetGlyph(forceEase(ecs, id));
    const pts = forcePts.filter((p) => p.section === pt.section).sort((a, b) => a.s - b.s);
    const idx = pts.findIndex((p) => p.id === id);
    const next = idx < pts.length - 1 ? pts[idx + 1] : null;
    if (!next) return presetGlyph(forceEase(ecs, id)); // no following segment — fall back
    const cps = segmentControls(toProfilePoint(pt), toProfilePoint(next));
    let minS = Infinity;
    let maxS = -Infinity;
    let minG = Infinity;
    let maxG = -Infinity;
    for (const c of cps) {
        minS = Math.min(minS, c.s);
        maxS = Math.max(maxS, c.s);
        minG = Math.min(minG, c.g);
        maxG = Math.max(maxG, c.g);
    }
    const spanS = maxS - minS;
    const spanG = maxG - minG;
    const nx = (s: number): number => glyphX(spanS > 1e-9 ? (s - minS) / spanS : 0.5);
    const ny = (g: number): number => (spanG > 1e-9 ? glyphY((g - minG) / spanG) : GLYPH_H / 2);
    return `M${nx(cps[0].s)} ${ny(cps[0].g)} C${nx(cps[1].s)} ${ny(cps[1].g)} ${nx(cps[2].s)} ${ny(cps[2].g)} ${nx(cps[3].s)} ${ny(cps[3].g)}`;
}
// dismiss the force menu on any outside press or Escape (clicks on the menu pass through so
// its items act first). Escape peels just this layer (capture + stop, so the window handler
// below doesn't also deselect the point) — root ui.md's one-layer dismissal.
//
// the listeners are PERMANENT and gate on the live `editor.forceMenu`, never on the reactive
// `fmenu`: `fmenu` derives through the per-RAF `tick`, so a lifetime bound to it outlives the
// logical close by at least a frame — and a capture-phase swallow that outlives its own layer
// eats the next Escape (the one meant to deselect the keyframe) from a menu already closed.
onMount(() => {
    const onDown = (e: PointerEvent): void => {
        if (editor.forceMenu === null) return;
        if ((e.target as HTMLElement | null)?.closest(".fmenu")) return;
        closeForceMenu();
    };
    const onEsc = (e: KeyboardEvent): void => {
        if (editor.forceMenu === null || e.key !== "Escape") return;
        e.stopImmediatePropagation();
        closeForceMenu();
    };
    window.addEventListener("pointerdown", onDown, { capture: true });
    window.addEventListener("keydown", onEsc, { capture: true });
    return () => {
        window.removeEventListener("pointerdown", onDown, { capture: true });
        window.removeEventListener("keydown", onEsc, { capture: true });
    };
});

// ── the ruler context menu (Meters / Seconds — the track domain picker), summoned by
// right-clicking the ruler scrub zone (`rulerCtx`). visibility reads through the tick, like
// every other editor-state surface (`editor.rulerMenu` is replaced wholesale on open/close, never
// mutated in place, so this simple derived is safe — the `converting` progress object's in-place
// rewrite is the case that ISN'T).
const rmenu = $derived.by((): { x: number; y: number } | null => {
    void tick;
    return editor.rulerMenu;
});
// the ruler menu's rows are built by the pure `menus.rulerMenu` (the row law lives with it); this
// resolves the two enablement predicates and the live domain it checks against.
// `pickable` is the per-row half: the active row is always pickable (its pick is a no-op), a
// converting row only when the conversion can actually run. `sectionOpsAllowed` is the consent
// boundary and grays BOTH rows — the active one included, since a lit-enabled row over a blocked
// surface would misread as available — while an pin session is open.
const rulerMenuItems = $derived.by((): MenuItem[] => {
    void tick;
    if (editor.rulerMenu === null) return [];
    const allowed = sectionOpsAllowed(editor.pinning);
    return rulerMenu(
        {
            domain,
            metersEnabled: pickable(ecs, Domain.Distance) && allowed,
            secondsEnabled: pickable(ecs, Domain.Time) && allowed,
        },
        { pick: pickDomain },
    );
});
// dismissal mirrors the force menu's exactly: permanent listeners gated on the live
// `editor.rulerMenu`, never the tick-lagging `rmenu` (`kex2d/AGENTS.md`'s tick-derived-read
// gotcha — the standard every menu here wears).
onMount(() => {
    const onDown = (e: PointerEvent): void => {
        if (editor.rulerMenu === null) return;
        if ((e.target as HTMLElement | null)?.closest(".rmenu")) return;
        closeRulerMenu();
    };
    const onEsc = (e: KeyboardEvent): void => {
        if (editor.rulerMenu === null || e.key !== "Escape") return;
        e.stopImmediatePropagation();
        closeRulerMenu();
    };
    window.addEventListener("pointerdown", onDown, { capture: true });
    window.addEventListener("keydown", onEsc, { capture: true });
    return () => {
        window.removeEventListener("pointerdown", onDown, { capture: true });
        window.removeEventListener("keydown", onEsc, { capture: true });
    };
});

// the velocity-strip band context menu (T1): summoned creation + deletion. The menu's
// position and target ride on `editor.stripMenu`; the rows are built by the pure
// `menus.stripMenu` builder. Dismissal mirrors the ruler menu's shape.
const smenu = $derived.by((): { x: number; y: number } | null => {
    void tick;
    return editor.stripMenu;
});
const stripMenuItems = $derived.by((): MenuItem[] => {
    void tick;
    if (editor.stripMenu === null) return [];
    const { d, strip } = editor.stripMenu;
    return stripMenu(
        {
            strip,
            editable: stripEditableAt(d),
            canCreate: canCreateAt(d),
            oneShotExists: entryOneShot(ecs) !== undefined,
        },
        {
            addStrip: () => {
                createStripAt(d);
                closeStripMenu();
            },
            remove: () => {
                deleteStrips(history, ecs, [...editor.strips.ids]);
                closeStripMenu();
            },
            addOneShot: () => {
                createOneShotAt();
                closeStripMenu();
            },
            removeOneShot: () => {
                deleteSelectedOneShot();
                closeStripMenu();
            },
        },
    );
});
$effect(() => {
    const onDown = (e: PointerEvent): void => {
        if (editor.stripMenu === null) return;
        if ((e.target as HTMLElement | null)?.closest(".smenu")) return;
        closeStripMenu();
    };
    const onEsc = (e: KeyboardEvent): void => {
        if (editor.stripMenu === null || e.key !== "Escape") return;
        e.stopImmediatePropagation();
        closeStripMenu();
    };
    window.addEventListener("pointerdown", onDown, { capture: true });
    window.addEventListener("keydown", onEsc, { capture: true });
    return () => {
        window.removeEventListener("pointerdown", onDown, { capture: true });
        window.removeEventListener("keydown", onEsc, { capture: true });
    };
});

// select a section by clicking its clip (the same `editor.sections` set the viewport span
// selects — one object, two surfaces). pointerdown so it feels immediate. shift-click toggles
// membership (Premiere multi-clip); no clip marquee (the marker lane's own boundary — a chart
// marquee only ever hits diamonds).
function selectClip(e: PointerEvent, c: Clip): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation(); // don't also scrub via the ruler zone beneath
    selectSection(c.id, e.shiftKey ? "toggle" : "replace");
}
// right-click a clip → the section context menu (Convert / Delete) at the cursor.
// Cut's free-position resolution off a clip right-click — the chart's own x-axis IS the
// native domain coordinate by construction (`Timeline`'s whole point, `editor-ui.md`), so `u`
// is a direct pixel read; `d` (the geo-side arc reading `track.sectionCutAt` wants) projects
// through the SAME `dOf`/`uOf` seam the curve and every arclength-authored subject on this
// chart already go through — `track.geoCutAt` never sees a raw pixel. `cutSurface: true` — the
// clip strip is Cut's SOLE surface (`editor-ui.md` Menus, the surface axis).
//
// within `SNAP_PX` of the parked playhead the cursor reading SNAPS to it — the reused landmark
// resolver (`timeline.snapCutToPlayhead`, `editor-ui.md` Snapping's playhead landmark, already
// named there), never a second snap vocabulary. "exact, not near": the resolver lands on the
// playhead's OWN stored `(d, u)`, read through `cart.playheadPosition` — the SAME resolution
// `controls.ts`'s keyboard Cut reads (`kex2d-map.md`'s "the ONE resolution" claim, true by
// construction: one call site, not two paths that happen to agree today) — never a pixel read
// back through `dOf`/`uOf`, so a snapped cut carries no px-quantization error at all. "read-only":
// `playheadPosition` only READS `cartState` — the resolver itself takes plain numbers, so neither
// can move the playhead (`editor-ui.md`'s transport-read clause). Only while PARKED (`paused`) is
// the playhead a snap target — `sTargets`' own precedent, a live-playing playhead isn't a stable
// magnet — and the toggle/bypass read the SAME `snapActive` every other magnet reads. The visible
// tell (round 8's own ask): a landmark hit flashes the shared guide channel (`snapX`, Snapping's
// "only a landmark flashes a guide"), cleared when the menu closes (below) — there's no drag to
// clear it FROM, so the menu's own lifetime is the tell's.
function clipMenu(e: MouseEvent, c: Clip): void {
    e.preventDefault();
    e.stopPropagation();
    const rect = canvas.getBoundingClientRect();
    const rawU = uAtPx(e.clientX - rect.left);
    const rawD = dOf(rawU);
    const rawPx = uToPx(clamped, rawU);
    let resolved: { d: number; u: number; guide: number | null } = {
        d: rawD,
        u: rawU,
        guide: null,
    };
    if (snapActive(e.ctrlKey || e.metaKey) && paused && eid !== null) {
        const ph = playheadPosition(eid);
        if (ph !== null) {
            const playheadPx = uToPx(clamped, ph.u);
            resolved = snapCutToPlayhead(rawPx, rawD, rawU, ph.d, ph.u, playheadPx);
        }
    }
    snapX = resolved.guide;
    const cut = sectionCutAt(ecs, c.id, spans, resolved.d, resolved.u);
    openContext(e.clientX, e.clientY, c.id, cut, true);
}

// ── the append tail: a `+` after the last clip opens a two-choice geo/force flyout —
// the one append affordance (a keyboard append would return as part of the toolbar item's
// deliberate keyboard-vocabulary pass, not a bare letter key).
// the flyout root-mounts (out of the dock's `overflow: hidden`, which clipped it from paint AND
// hit-testing near the right edge), so its anchor is the `+` button's screen rect, captured on
// open and fed to `fitMenu` (the same viewport-flip the cursor menus get). null = closed.
let appendAnchor: { x: number; y: number } | null = $state(null);
function toggleAppend(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    // the lockdown: no section add while an pin session is open (the button grays too).
    if (!sectionOpsAllowed(editor.pinning)) return;
    if (appendAnchor) {
        appendAnchor = null;
        return;
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    appendAnchor = { x: r.left - 3, y: r.bottom + 2 }; // open just below the button, its left edge
}
function append(kind: SectionKind): void {
    appendAnchor = null;
    selectSection(appendSection(history, ecs, kind));
}
const appendItems: MenuItem[] = appendMenu({ append });
// appending never moves the view: the x-axis is a document axis, and the always-framed
// lead-out (`marginArc`, floored at 50 m) is where a new section lands — visible without
// any auto-pan. an append while zoomed in elsewhere stays put; `F` or the navigator reaches
// the new clip.
// click-away closes the flyout (clicks inside the control keep it open — the choice
// buttons close it themselves via append()).
$effect(() => {
    if (!appendAnchor) return;
    const close = (ev: PointerEvent): void => {
        const t = ev.target as HTMLElement | null;
        // the flyout is root-mounted, not a child of `.clip-append`, so both are kept open.
        if (t?.closest(".clip-append") || t?.closest(".clip-flyout")) return;
        appendAnchor = null;
    };
    window.addEventListener("pointerdown", close, { capture: true });
    return () => window.removeEventListener("pointerdown", close, { capture: true });
});

// ── the snap-increment popover: right-click the rail's magnet for the two manipulator quanta
// (angle °, length m) as fields in the shared idiom. The increments hang off the snap control
// itself — Blender's snap popover and Godot's Configure Snap dialog both do, and right-click is
// this app's summon language. They're per-user preferences (settings.ts): live on write, persisted,
// no history entry. Root-mounted + `fitMenu` like the append flyout, so the dock's `overflow:
// hidden` can't clip it and it flips up off the bottom edge; anchored just right of the button, so
// it never covers its invoker.
const ANGLE_MIN_DEG = Math.round(((ANGLE_STEP_MIN * 180) / Math.PI) * 100) / 100;
const ANGLE_MAX_DEG = Math.round(((ANGLE_STEP_MAX * 180) / Math.PI) * 100) / 100;
let snapPop: { x: number; y: number } | null = $state(null);
const degText = $derived(fmt(snapDeg, 2));
const lenText = $derived(fmt(snapLen, 2));
function toggleSnapPop(e: MouseEvent): void {
    e.preventDefault(); // the app's own summoned surface replaces the browser context menu
    e.stopPropagation();
    if (snapPop) {
        snapPop = null;
        return;
    }
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    snapPop = { x: r.right + 6, y: r.top };
}
// a typed value is clamped (1° / 0.1 m floors), so the field must be written back from the RESOLVED
// setting, not left showing what the author typed: Svelte skips a DOM write when the derived text
// didn't change, so a rejected (cleared field) or re-clamped entry would otherwise leave the input
// disagreeing with the live grid.
function onSnapDeg(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    const deg = Number.parseFloat(input.value);
    if (Number.isFinite(deg)) setSnapAngle((deg * Math.PI) / 180);
    input.value = fmt((snapSteps.angle * 180) / Math.PI, 2);
}
function onSnapLen(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    const m = Number.parseFloat(input.value);
    if (Number.isFinite(m)) setSnapLength(m);
    input.value = fmt(snapSteps.length, 2);
}
// the key label is the field idiom's scrub handle (root ui.md "Fields"): slide to revise, rounded to
// the displayed precision. no history gesture — a preference isn't authored track state — and the
// accumulator clamps to the setting's own range, so a slide held past either end banks no distance
// to undo on the way back.
const SCRUB_DEG = 0.25; // ° per px
// the snap-length preference's own scrub rate — NOT `SCRUB_S` (the keyframe/handle arclength
// rate below): borrowing that constant tied a preference field's feel to an unrelated track-
// authoring rate. Value kept identical to the prior (borrowed) behavior.
const SCRUB_LEN = 0.05; // m per px
function snapScrub(e: PointerEvent, axis: "angle" | "length"): void {
    if (axis === "angle") {
        labelScrub(e, {
            seed: (snapSteps.angle * 180) / Math.PI, // settings themselves, not the tick display (lags a frame)
            rate: SCRUB_DEG,
            lo: ANGLE_MIN_DEG,
            hi: ANGLE_MAX_DEG,
            round: 100,
            write: (v) => setSnapAngle((v * Math.PI) / 180),
        });
    } else {
        labelScrub(e, {
            seed: snapSteps.length,
            rate: SCRUB_LEN,
            lo: LENGTH_STEP_MIN,
            hi: LENGTH_STEP_MAX,
            round: 100,
            write: setSnapLength,
        });
    }
}
// click-away closes it; a press on the popover or on the rail button itself is kept (the button
// toggles it, and a field press must not dismiss the surface it's in).
$effect(() => {
    if (!snapPop) return;
    const close = (ev: PointerEvent): void => {
        const t = ev.target as HTMLElement | null;
        // the exemption names the INVOKER (`.rail-snap`), never the rail — a class-wide
        // `.rail-tool` exemption would silently break if a second rail tool ever arrives
        // (editor-ui.md's snapping law).
        if (t?.closest(".snap-pop") || t?.closest(".rail-snap")) return;
        snapPop = null;
    };
    window.addEventListener("pointerdown", close, { capture: true });
    return () => window.removeEventListener("pointerdown", close, { capture: true });
});

// ── force-section extent: drag a force clip's RIGHT EDGE (in the strip) to resize the
// profile. the extent is the force section's own authored length, independent of
// the geo shape a convert came from — a convert resets it to a default, this sets it.
// reuses the keyframe-drag freeze machinery: uFrozen holds the chart's span so the
// pan clamp holds the view still under the drag (the x-scale never rescales — that's
// clampView's law), and xGrow edge-pans when the cursor is held past the chart edge. one
// undo entry per drag.
let lenId: number | null = $state(null); // the force section being resized, or null
const draggingLen = $derived(lenId !== null);
let lenStartU = 0; // the dragged section's entry, projected -- pixel/snap-target math only
let lenStartD = 0; // the dragged section's entry in arclength (fixed during the drag) -- the WRITE base
let lenCx = 0; // last length-drag cursor, canvas-local px (drives the per-frame edge-pan)
let lenX0 = 0; // grab-point cursor px (fixed) — the dead-zone origin `lenArmed` measures from
let lenArmed = false; // the standard DRAG_PX dead-zone latch (`armDrag`) — gates the sticky-commit
let lenMod = false; // Ctrl/Cmd held (live) during the extent drag — snap bypass
// `exitSpeed()`'s own snapshot, taken at gesture start alongside `gestureMapping` -- this drag's
// own write extends the bake (a longer section publishes more samples), which would move
// `curve.n`'s "end" out from under a LIVE read mid-drag.
let lenVExit = V0;
const EDGE_PAN = 0.4; // px pan per px past the chart edge, per frame — a by-eye feel constant
// resolve the held cursor to a section extent through the *current* view (recomputed
// inline so an edge-pan this frame is already reflected — the edge never lags the pan).
// snaps the trimmed edge (the AE magnet) through the SAME shared resolver a keyframe drag
// rides (`snapAxis`, F4) to content landmarks that are BOTH stable under the resize AND
// reachable (editor-ui.md): the section's own force points (section-local, so fixed while
// its extent changes) and the playhead (the Premiere trim-to-playhead idiom, only while
// parked). ruler ticks are excluded — the zoom-dependent 1-2-5 raster is display, not
// content. section boundaries are excluded too — the dragged section's own exit and every
// downstream boundary MOVE with the resize (self-snap), and upstream boundaries are
// unreachable (they'd floor the length). the reach guard (the domain's own `minForceExtent`
// floor) skips a landmark the floor won't honor, falling back to the grid quantum instead
// of the raw cursor value (F4: the trim gesture snaps to increments the same as a keyframe
// drag whenever no reachable landmark is in range) — matching applyKeyframeDrag's reach
// guard, generalized past a guide-flash cosmetic.
//
// The extent is the section's authored length, arclength ALWAYS (S6) -- so in `Domain.Time`
// this same gesture reads a cursor position on the PROJECTED (seconds) chart axis and must
// convert it back through the gesture-frozen table (`dOf`) before writing; the edge no longer
// reads the chart's axis directly into the store (S6 fix -- that would trim a metres extent by
// a seconds-scaled amount).
function applyLen(): void {
    if (lenId === null) return;
    const cv = clampView(view, chartW, uFrozen ?? uTotal, mFloor);
    const rawPx = lenCx - LEFT_GUT;
    const rawU = pxToU(cv, rawPx);
    snapX = null;
    const active = snapActive(lenMod);
    const ownU: number[] = [];
    for (const p of forcePts) if (p.section === lenId) ownU.push(p.u);
    const targets = trimTargets(cv, ownU, paused && cartS !== null ? uOf(cartS) : null);
    const r = snapAxis(active, rawPx, rawU, targets, GRID, (px) => pxToU(cv, px), null);
    let cumU = r.value;
    if (r.guide !== null && dOf(cumU) - lenStartD < minForceExtent(domain)) {
        // the floor won't honor this landmark — fall back to the grid quantum (matching
        // snapAxis's own empty-target grid branch) rather than the raw cursor value.
        cumU = active ? Math.round(rawU / GRID) * GRID : rawU;
    } else if (r.guide !== null) {
        snapX = r.guide;
    }
    // the extent trim is the one place a chart-axis cursor legitimately reads PAST the bake's
    // own end (the lead-out margin sits right there): `uToDExtend`, not `dOf`, so lengthening a
    // section past its current profile extrapolates at the frozen exit speed instead of pinning
    // to the bake's last finite sample (S6b).
    const d = uToDExtend(gestureMapping ?? mapping, domain, cumU, lenVExit);
    setSectionLength(ecs, lenId, d - lenStartD); // arclength edge − arclength entry
}
function lenDown(e: PointerEvent, c: Clip): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    // the lockdown: in-mode only the pinning section's extent trims (length is authored
    // slack — the author's own DOF); other sections are read-only.
    if (!sectionEditable(editor.pinning, c.id)) return;
    const rect = canvas.getBoundingClientRect();
    lenCx = e.clientX - rect.left;
    lenX0 = lenCx;
    lenArmed = false;
    lenMod = e.ctrlKey || e.metaKey;
    lenStartU = c.u0; // upstream is unchanged by this resize, so the entry is fixed
    lenStartD = c.s0; // the arclength twin -- the write base
    selectSection(c.id); // grabbing the edge selects the section (one object, two surfaces)
    beginLength(ecs, c.id);
    lenId = c.id;
    uFrozen = uTotal; // freeze the pan-clamp span so the view holds still under the drag
    // freeze the s↔t table for the whole gesture (S6) -- see `keyframeDown`'s own note.
    gestureMapping = mapping;
    // freeze the extrapolation's own exit speed at the SAME instant -- see `exitSpeed`'s own note.
    lenVExit = exitSpeed();
    beginDrag(canvas, e.pointerId);
    window.addEventListener("pointermove", lenMove);
    window.addEventListener("pointerup", lenUp);
    window.addEventListener("pointercancel", lenUp); // finalize the history gesture on cancel too
}
function lenMove(e: PointerEvent): void {
    if (lenId === null) return;
    const rect = canvas.getBoundingClientRect();
    lenCx = e.clientX - rect.left;
    lenArmed = armDrag(lenArmed, lenCx - lenX0, 0); // the standard DRAG_PX dead-zone latch
    lenMod = e.ctrlKey || e.metaKey; // live: bypass can be toggled mid-drag
    applyLen();
}
function lenUp(): void {
    if (lenId === null) return;
    const id = lenId;
    const armed = lenArmed;
    lenId = null;
    lenArmed = false;
    uFrozen = null; // release the in-drag freeze; the zoom never re-fits (no release refit) —
    snapX = null;
    gestureMapping = null; // release the gesture-frozen table
    // commitLength coalesces the drag (one undo entry) AND, when armed, records the landed
    // extent as the session's new sticky append default — the one call site that updates it. a
    // sub-DRAG_PX click release (armed=false) still commits (a no-move release records nothing
    // regardless, per `commit`'s own no-op check) but never stamps the sticky value.
    commitLength(history, ecs, id, armed); // clampView now only re-clamps pan to the live extent, never rescales
    window.removeEventListener("pointermove", lenMove);
    window.removeEventListener("pointerup", lenUp);
    window.removeEventListener("pointercancel", lenUp);
}
function cancelLenDrag(): void {
    if (lenId === null) return;
    lenId = null;
    lenArmed = false;
    uFrozen = null;
    snapX = null;
    gestureMapping = null; // release the gesture-frozen table
    cancel();
    window.removeEventListener("pointermove", lenMove);
    window.removeEventListener("pointerup", lenUp);
    window.removeEventListener("pointercancel", lenUp);
}
// per-frame edge-scroll for the length drag: hold the frozen fit-total at its
// high-water mark (shortening never zooms in; an extending handle grows panMax so the
// scroll can reveal it) and pan to follow a cursor held past the chart edge, re-mapping
// the extent through the panned view each frame (the x-mirror of the keyframe yGrow).
$effect(() => {
    void tick;
    untrack(() => {
        if (!draggingLen) return;
        if (uFrozen === null || uTotal > uFrozen) uFrozen = uTotal;
        const grown = xGrow(view, lenCx, LEFT_GUT, w, EDGE_PAN);
        if (grown !== view) {
            view = grown;
            applyLen();
        }
    });
});

// ── velocity strips: the header band's own authoring surface (T1). Trim-cursor-at-edge,
// body-drag, and clamp survive from C5 — the one part prior art endorses. Empty band space is
// INERT (no create-drag, no modifier-drag, no standing mode toggle — the rescope that retired
// C5's rejected idiom). Creation is a summoned, named act: right-click → context menu → row.
// The pure hit classifier (`strip-hit.ts`) decides what a press means; ONE band-wide hit rect
// routes through it instead of one DOM element per strip per affordance.
const STRIP_HIT_R = 6; // px — the endpoint-vs-body split radius

function bandCandidates(): StripHitCandidate[] {
    return bandStrips.map((s) => ({ id: s.id, x0: uPx(s.u0), x1: uPx(s.u1) }));
}

// S3 (Affordances): the band's own hover read, canvas-local like `bandDown`'s own `px` (the
// same `classifyStripHit` the press path uses, so the affordance and the gesture agree by
// construction — never a second, hand-tuned hover geometry). Component-local, not the
// viewport's `editor.hoverForce`/`hoverNode` seam (`editor.ts`): those are the controls'
// pointermove sweep over VIEWPORT pick targets; the band is a canvas surface with no DOM
// element per strip for CSS `:hover` to land on, so it needs its own read, the same way
// `stripDrag` below is this band's own gesture state rather than a viewport one.
let bandHoverX: number | null = $state(null);
function bandHoverMove(e: PointerEvent): void {
    const rect = canvas.getBoundingClientRect();
    bandHoverX = e.clientX - rect.left;
}
function bandHoverLeave(): void {
    bandHoverX = null;
}
// suppressed for the whole of any OTHER gesture (editor-ui.md Kind color: "Hover's boundaries
// travel with the rung ... suppressed for the whole of any gesture") — a foreign drag captures
// the pointer on `canvas`, not this band's own hit rect, so `bandHoverX` would otherwise read
// stale. The band's OWN drag (`stripDrag !== null`) is exempt: `bandMove` keeps `bandHoverX`
// live during it (below), and showing the active edge/body read while it's being dragged is
// the affordance, not staleness.
const bandHit = $derived.by((): StripHit => {
    if (eid === null) return { kind: "empty" };
    if (editor.dragging && stripDrag === null) return { kind: "empty" };
    if (bandHoverX === null) return { kind: "empty" };
    return classifyStripHit(bandHoverX, bandCandidates(), STRIP_HIT_R);
});
// the track-start one-shot's own glyph x (S3) — always `uPx(uOf(0))`, independent of whether
// the one-shot currently exists (a right-click there offers "Add initial velocity" when it
// doesn't, "Delete" when it does — `bandContext`'s own routing). A plain function, not
// `$derived`, matching `bandCandidates`' own shape: called fresh from event handlers and the
// canvas `render()` pass alike, never cached behind the RAF tick.
function oneShotGlyphX(): number {
    return uPx(uOf(0));
}
// F6 (feel-gate round 1): the ONE band-wide hit rect (`.hbandzone`, Locked decision — never
// per-strip DOM hit-testing) starts at `LEFT_GUT`, so at minimum pan `d = 0`'s own station
// (`oneShotGlyphX()`, always `>= LEFT_GUT`, clamped equal there) leaves the glyph's LEFT half
// — a real hit radius, `STRIP_HIT_R`, not just the visual diamond — sitting past the rect's own
// left edge: a click lands on nothing there today, and where a strip ALSO starts at `d = 0` its
// coincident edge is the only thing left in that dead zone for the pointer to land on. Widen the
// rect's own left edge to cover the glyph's full hit radius instead of adding a second DOM
// element (the Locked-decision "ONE hit rect" stands) — precedence itself stays JS-side
// (`classifyOneShotHit` checked first in `bandDown`/`bandContext`, S3); this is what makes that
// check REACHABLE for the glyph's own left half at all. Bounded by construction: `Math.min`
// only widens when the glyph is actually flush against `LEFT_GUT` (visible at minimum pan) —
// panned off-screen (`gx < LEFT_GUT`, not drawn, `render()`'s own gate) or clear of the dead
// zone (`gx - STRIP_HIT_R >= LEFT_GUT`) both fall through to the unwidened `LEFT_GUT`.
function bandZoneX0(): number {
    if (!entryOneShot(ecs)) return LEFT_GUT;
    const gx = oneShotGlyphX();
    if (gx < LEFT_GUT) return LEFT_GUT;
    return Math.min(LEFT_GUT, gx - STRIP_HIT_R);
}
// the one-shot glyph's own hover read — `bandHit`'s point-kind twin, checked FIRST wherever
// both could coincide (a real strip authored to start exactly at `d = 0` would otherwise share
// screen space with the glyph): the one-shot is a distinct kind, so it gets its own hit-test
// pass rather than folding into `classifyStripHit`'s candidate list (`strip-hit.ts`'s own
// Locked-decision split).
const oneShotHover = $derived.by((): boolean => {
    if (eid === null) return false;
    if (editor.dragging && stripDrag === null) return false;
    if (bandHoverX === null) return false;
    return classifyOneShotHit(bandHoverX, oneShotGlyphX(), STRIP_HIT_R);
});
// removing the unknown state rather than managing it: the theorized failure was a FOREIGN
// gesture capturing the pointer on `canvas` so `.hbandzone`'s own `onpointermove`/
// `onpointerleave` never fire when it ends off the band, leaving `bandHoverX` stale at its
// pre-gesture position to re-derive into a hover the instant `editor.dragging` drops (`bandHit`'s
// guard above only suppresses WHILE dragging is true). Investigated with a debug hook across two
// real repros (a force-keyframe drag, and a middle-click pan starting AT the hovered position,
// both captured on `canvas` via `beginDrag`): in this Chromium/Playwright environment
// `onpointerleave` fired correctly regardless of capture in both cases, so `bandHoverX` was
// already `null` well before `editor.dragging` dropped — the theorized staleness window never
// opened, and no repro was found that leaves it stale. Kept anyway as a zero-cost hardening
// (nulling on every falling edge, band's-own-drag included, costs nothing visible there: `bandUp`
// leaves the strip selected, and both hover reads above already gate `!sel`) rather than a
// demonstrated fix — there is no red-first check for this one.
$effect(() => {
    if (!editor.dragging) bandHoverX = null;
});

interface StripDrag {
    id: number;
    mode: "start" | "end" | "body";
    lo: number;
    hi: number;
    origStart: number;
    origEnd: number;
    origValue: number;
    grabStation: number;
    // every keyframe on the strip, captured at gesture start (S5, F1: a BODY drag carries them
    // — same Δd applied to each). Empty for "start"/"end" (an edge resize is non-sticking, S3/
    // S4's own law: a keyframe never follows an edge it happens to sit on).
    kfs: { id: number; s: number; v: number }[];
}
let stripDrag: StripDrag | null = $state(null);
let bandMod = false; // Ctrl/Cmd held (live) during a strip move/resize — snap bypass (F4)

/** whether the section a track-global station currently resolves to is editable (not under
 *  a pin-session lockdown, `sectionEditable`) — strips are track-global and span-blind (S2,
 *  Locked decision), so there's no single owning section to gate on; this resolves the
 *  REPRESENTATIVE section the station currently lands in (`toLocal`), the same edit-lockdown
 *  reading a force keyframe's own `.section` gives. A span straddling a pin session's
 *  boundary is gated by its OWN queried station — the common case (a strip wholly inside or
 *  outside the session) is exact; a straddling span during an open pin session is residue
 *  this stage doesn't fully resolve (out of S2's own footprint). No live bake (`loc === null`)
 *  reads editable, matching "nothing to lock against". */
function stripEditableAt(d: number): boolean {
    const loc = toLocal(spans, d);
    return loc === null || sectionEditable(editor.pinning, loc.section);
}

// resolves the RESULTING position (an edge's own station, or a body drag's own rigidly-
// translated start) through the SAME shared resolver a keyframe drag rides (`snapAxis`, F4)
// — snap the candidate write, not the raw cursor, the same order `applyKeyframeDrag`'s own
// anchor snap uses. Landmarks: the nearest sibling strip's flush boundary for an edge resize
// (`lo`/`hi`, already the drag's own room), the parked playhead for every mode; the grid
// quantum otherwise. Ctrl/Cmd bypasses exactly like every other drag on this chart.
function bandMove(e: PointerEvent): void {
    if (stripDrag === null) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    // pointer capture during this drag targets `canvas` (`beginDrag`), not the band's own hit
    // rect, so its `onpointermove` never fires -- keep the hover read live from here instead
    // (S3's own edge/body affordance while the gesture is in flight).
    bandHoverX = px;
    bandMod = e.ctrlKey || e.metaKey; // live: bypass can be toggled mid-drag
    const { mode, lo, hi, origStart, origEnd, origValue, id, kfs, grabStation } = stripDrag;
    snapX = null;
    const active = snapActive(bandMod);
    const playheadU = paused && cartS !== null ? uOf(cartS) : null;
    const width = origEnd - origStart;
    // through the gesture-frozen table -- track-global arclength (strips are track-global,
    // S2), never a raw (seconds-scaled in Time view) axis delta (S6 fix).
    const rawStation = dOf(uAtPx(px));
    const candidate =
        mode === "body"
            ? clamp(origStart + (rawStation - grabStation), lo, hi - width)
            : clamp(rawStation, lo, hi);
    const edgeTarget = mode === "start" ? lo : mode === "end" ? hi : null;
    const targets = trimTargets(clamped, edgeTarget !== null ? [uOf(edgeTarget)] : [], playheadU);
    const candidateU = uOf(candidate);
    const r = snapAxis(
        active,
        uToPx(clamped, candidateU),
        candidateU,
        targets,
        GRID,
        (p) => pxToU(clamped, p),
        null,
    );
    if (r.guide !== null) snapX = r.guide;
    if (mode === "start") {
        setStrip(ecs, id, clamp(dOf(r.value), lo, hi), origEnd, origValue);
    } else if (mode === "end") {
        setStrip(ecs, id, origStart, clamp(dOf(r.value), lo, hi), origValue);
    } else {
        const ns = clamp(dOf(r.value), lo, hi - width);
        setStrip(ecs, id, ns, ns + width, origValue);
        // S5, F1: a BODY drag carries its keyframes — the SAME Δd the strip's own edges just
        // moved by, applied to every keyframe's gesture-start `s`. Relative order is preserved
        // exactly (rigid translation), so this never collides with a sibling member of the
        // SAME strip; `setStripKeyframe`'s own overlap refusal still guards it regardless.
        const dd = ns - origStart;
        for (const k of kfs) setStripKeyframe(ecs, k.id, k.s + dd, k.v);
    }
}
function bandUp(): void {
    if (stripDrag === null) return;
    stripDrag = null;
    snapX = null;
    gestureMapping = null; // release the gesture-frozen table
    window.removeEventListener("pointermove", bandMove);
    window.removeEventListener("pointerup", bandUp);
    window.removeEventListener("pointercancel", bandUp);
    commit(history);
}
function cancelStripDrag(): void {
    if (stripDrag === null) return;
    stripDrag = null;
    snapX = null;
    gestureMapping = null; // release the gesture-frozen table
    window.removeEventListener("pointermove", bandMove);
    window.removeEventListener("pointerup", bandUp);
    window.removeEventListener("pointercancel", bandUp);
    cancel();
}
// the band's own right-click: on empty band → the strip creation menu; on an existing strip →
// the strip deletion menu. Empty band space is inert for left-click — no create-drag, no
// modifier-drag (Locked decision, the rescope). Right-click-on-empty is Unity Timeline's
// documented "quickest method" and matches kex2d's existing right-click menu grammar.
function bandContext(e: MouseEvent): void {
    if (eid === null) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    // the one-shot glyph takes precedence (S3): checked first, at its own fixed station,
    // regardless of where on the band the click landed — it's only present when the
    // one-shot already exists (`entryOneShot`'s own "delete-only glyph" law; the empty-band
    // "Add initial velocity" row below is the create path).
    if (entryOneShot(ecs) && classifyOneShotHit(px, oneShotGlyphX(), STRIP_HIT_R)) {
        if (!stripEditableAt(0)) return;
        selectOneShot(true);
        openStripMenu(e.clientX, e.clientY, 0, -2);
        return;
    }
    const hit = classifyStripHit(px, bandCandidates(), STRIP_HIT_R);
    if (hit.kind === "empty") {
        // a create has no gesture to freeze a table for -- `dOf` reads the live mapping.
        // strips are track-global (S2): the click's own station IS the storage coordinate,
        // no section to resolve.
        const d = dOf(uAtPx(px));
        if (!stripEditableAt(d)) return;
        openStripMenu(e.clientX, e.clientY, d, -1);
    } else {
        const s = bandStrips.find((b) => b.id === hit.id);
        if (!s) return;
        if (!stripEditableAt(s.start)) return;
        selectStrip(s.id);
        openStripMenu(e.clientX, e.clientY, s.start, s.id);
    }
}
// left-click on the band: select + trim/body-drag. Empty space is inert for creation (no
// create-drag, `bandContext`'s own law) but not for selection — a plain click deselects
// everything (`kex2d-event-lane` S4's "one selection model", the empty-ruler/empty-lane law);
// shift-click preserves (the chart's own empty-click precedent, `marqueeUp`).
function bandDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    if (eid === null) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    // the one-shot glyph takes precedence (S3), select-only — it has no extent to trim/drag
    // (fixed at `d = 0`, no drag-out; that machinery retired with the point-as-span model).
    if (entryOneShot(ecs) && classifyOneShotHit(px, oneShotGlyphX(), STRIP_HIT_R)) {
        if (!stripEditableAt(0)) return;
        e.preventDefault();
        e.stopPropagation();
        selectOneShot(true);
        return;
    }
    const hit = classifyStripHit(px, bandCandidates(), STRIP_HIT_R);
    if (hit.kind === "empty") {
        if (!e.shiftKey) deselectAll();
        return; // inert — no create-drag, no modifier-drag
    }
    const s = bandStrips.find((b) => b.id === hit.id);
    if (!s) return;
    if (!stripEditableAt(s.start)) return;
    e.preventDefault();
    e.stopPropagation();
    // shift-click TOGGLES set membership (`keyframeDown`'s own grammar, generalized to spans) — a
    // selection gesture, not a drag.
    if (e.shiftKey) {
        selectStrip(s.id, "toggle");
        return;
    }
    selectStrip(s.id);
    bandMod = e.ctrlKey || e.metaKey;
    // freeze the s↔t table for the whole gesture (S6) -- see `keyframeDown`'s own note.
    gestureMapping = mapping;
    if (hit.kind === "endpoint") {
        const edge = hit.edge;
        const at = edge === "start" ? s.start : s.end;
        const b = stripBoundsAt(ecs, s.id, s.len, at);
        stripDrag = {
            id: s.id,
            mode: edge,
            lo: edge === "start" ? b.lo : s.start,
            hi: edge === "end" ? b.hi : s.end,
            origStart: s.start,
            origEnd: s.end,
            origValue: s.value,
            grabStation: at,
            kfs: [], // an edge resize is non-sticking (S3/S4) -- no keyframe to carry
        };
    } else {
        const loB = stripBoundsAt(ecs, s.id, s.len, s.start);
        const hiB = stripBoundsAt(ecs, s.id, s.len, s.end);
        stripDrag = {
            id: s.id,
            mode: "body",
            lo: loB.lo,
            hi: hiB.hi,
            origStart: s.start,
            origEnd: s.end,
            origValue: s.value,
            grabStation: dOf(uAtPx(px)),
            // S5, F1: every keyframe's gesture-start position, carried rigidly with the body.
            kfs: stripKeyframes(ecs, s.id).map((k) => ({ id: k.id, s: k.s, v: k.v })),
        };
    }
    beginStripMove(ecs, s.id);
    beginDrag(canvas, e.pointerId);
    window.addEventListener("pointermove", bandMove);
    window.addEventListener("pointerup", bandUp);
    window.addEventListener("pointercancel", bandUp);
}
// summoned creation: the menu row's action — a strip appears at the clicked station, selected,
// curve flattened and solid (Locked decision), sized to a brake-section-typical span
// (`stripDefaultExtentAt`, S5 findings 4/5/6) rather than the bare min-extent edge — the
// overridden edge (`stripMinExtentAt`) is still the floor a degenerate section falls back to,
// so the strip is never silently inert.
// W7: `canCreateAt` gates the menu row's `enabled` off the MIN extent, not the grown default —
// a station whose min-extent span overlaps an existing strip (a neighbour's boundary sits
// mid-edge) would produce a silently inert `createStrip` return, so the row is grayed instead;
// the grown span only ever widens what the min extent already cleared.
function canCreateAt(d: number): boolean {
    const minExtent = stripMinExtentAt(ecs, d);
    if (minExtent === null) return false;
    return !stripOverlapped(ecs, minExtent.start, minExtent.end, -1);
}
function createStripAt(d: number): void {
    const extent = stripDefaultExtentAt(ecs, d);
    if (extent === null) return;
    const value = stripSeedValue(ecs, extent.start);
    const id = addStrip(history, ecs, extent.start, extent.end, value);
    if (id !== null) selectStrip(id);
}
// summoned creation, the one-shot's own twin (S3): always seeds at `V0` — a distinct point
// kind carries no curve to read a live bake `v` from, unlike `stripSeedValue`'s station read.
function createOneShotAt(): void {
    addOneShot(history, ecs, V0);
    selectOneShot(true); // there's only ever one — `selectOneShot`'s own boolean shape
}
// Delete removes the selected strip; Escape clears the selection.
function deleteSelectedStrip(): void {
    if (editor.strip === null) return;
    // read the strip directly from the ECS — `selStrip` is a `$derived` behind `bandStrips`
    // behind the RAF `void tick`, so a Delete pressed before the tick sees null and no-ops
    // (section.pw.ts:1582). `stripAt` + `Strip.start.get` are synchronous.
    const eid = stripAt(ecs, editor.strip);
    if (eid === null) return;
    if (!stripEditableAt(Strip.start.get(eid))) return;
    deleteStrips(history, ecs, [...editor.strips.ids]);
}
// Delete removes the one-shot; Escape clears the selection (`deleteSelectedStrip`'s own
// point-kind twin).
function deleteSelectedOneShot(): void {
    if (!editor.oneShot) return;
    if (!stripEditableAt(0)) return;
    const os = entryOneShot(ecs);
    if (!os) return;
    deleteOneShot(history, ecs, os.id);
    selectOneShot(false);
}
// Delete removes the WHOLE selected strip-keyframe SET (S4's booked multi-select, `deleteForces`'
// own bulk shape); the strip stays selected (the force keyframe's own pattern — Delete acts on
// the innermost selection, not the strip). single-select is the size-1 case.
function deleteSelectedStripKf(): void {
    if (editor.stripKf === null) return;
    // read the owning strip directly from the ECS — `selStrip` is a `$derived` behind
    // `bandStrips` behind the RAF `void tick`, so a Delete pressed before the tick sees null and
    // no-ops (the same F1 race `deleteSelectedStrip` above already repairs). `editor.strip !==
    // null` is `stripKfs`'s own invariant (a non-empty sub-selection implies an owning strip);
    // `stripAt` + `Strip.start.get` are synchronous.
    if (editor.strip === null) return;
    const eid = stripAt(ecs, editor.strip);
    if (eid === null) return;
    if (!stripEditableAt(Strip.start.get(eid))) return;
    deleteStripKeyframes(history, ecs, [...editor.stripKfs.ids]);
    selectStripKf(null);
}

// ── the selected keyframe's typed s/v fields (unified — force and strip ride one path) ──
// each field commits one undo entry through the drag gesture (begin → set → commit).
function kfFieldEdit(s: number, v: number): void {
    const p = selPoint;
    const k = selStripKfPt;
    if (p === null && k === null) return;
    if (!Number.isFinite(s) || !Number.isFinite(v)) return;
    if (p !== null) {
        if (!sectionEditable(editor.pinning, p.section)) return;
        skipLanding();
        beginForceMove(ecs, p.id);
        setForcePoint(ecs, p.id, clamp(s, 0, p.len), v);
        commit(history);
    } else if (k !== null) {
        if (!sectionEditable(editor.pinning, k.section)) return;
        skipLanding();
        beginStripKeyframeMove(ecs, k.id);
        setStripKeyframe(ecs, k.id, clamp(s, k.start, k.end), Math.max(V_FLOOR, v));
        commit(history);
    }
}
// the position field speaks the chart's own domain (global d, or global t — label and unit
// follow, `posLabel`/`posUnit`), never the store's (arclength ALWAYS -- S6), so the write goes
// through `dOf` (identity in Distance) before subtracting the section's arclength entry.
function onFieldKfS(e: Event): void {
    const p = selPoint;
    const k = selStripKfPt;
    if (p !== null) {
        const u = Number.parseFloat((e.currentTarget as HTMLInputElement).value);
        kfFieldEdit(dOf(u) - p.startD, p.g);
    } else if (k !== null) {
        const u = Number.parseFloat((e.currentTarget as HTMLInputElement).value);
        kfFieldEdit(dOf(u) - k.startD, k.v);
    }
}
function onFieldKfV(e: Event): void {
    const p = selPoint;
    const k = selStripKfPt;
    if (p !== null) {
        kfFieldEdit(p.s, Number.parseFloat((e.currentTarget as HTMLInputElement).value));
    } else if (k !== null) {
        kfFieldEdit(k.s, Number.parseFloat((e.currentTarget as HTMLInputElement).value));
    }
}
// the one-shot's own typed v field (F5) — `kfFieldEdit`'s single-scalar twin: no position
// write, since the axis is LOCKED (`setOneShotValue`'s own docblock). Same gesture shape
// (begin → set → commit) and the same pin-mode guard `deleteSelectedOneShot` uses.
function oneShotFieldEdit(v: number): void {
    const os = selOneShotPt;
    if (os === null || !Number.isFinite(v)) return;
    if (!stripEditableAt(0)) return;
    skipLanding();
    beginOneShotMove(ecs, os.id);
    setOneShotValue(ecs, os.id, v);
    commit(history);
}
function onFieldOneShotV(e: Event): void {
    oneShotFieldEdit(Number.parseFloat((e.currentTarget as HTMLInputElement).value));
}
// ── the selected handle's typed (Δs, Δg) fields ── mirrors the keyframe fields, but the
// commit goes through the shared tangent write path (composeTangent — x-clamp + Aligned
// coupling), history-bracketed as one entry. a typed value on a still-derived handle
// materializes the explicit tangent (the un-edited side seeds from the derived shape).
function handleFieldEdit(ds: number, dg: number): void {
    const h = selHandle;
    if (h === null || !Number.isFinite(ds) || !Number.isFinite(dg)) return; // guard a cleared field
    if (!sectionEditable(editor.pinning, h.pt.section)) return; // the lockdown
    const tan = tangentFor(h.pt.id, h.side, ds, dg);
    if (!tan) return;
    skipLanding(); // keyboard-committed keyframe mutation: same routing as kfFieldEdit above
    beginForceTangent(ecs, h.pt.id);
    setForceTangent(ecs, h.pt.id, tan);
    commit(history);
}
function onHandleS(e: Event): void {
    if (!selHandle) return;
    handleFieldEdit(Number.parseFloat((e.currentTarget as HTMLInputElement).value), selHandle.dg);
}
function onHandleG(e: Event): void {
    if (!selHandle) return;
    handleFieldEdit(selHandle.ds, Number.parseFloat((e.currentTarget as HTMLInputElement).value));
}
// label scrub (the shallot inspector idiom): pointer-capture the key label and slide
// horizontally to revise its value — one history gesture per scrub, rounded to the
// field's displayed precision so the number never shows scrub jitter.
const SCRUB_S = 0.05; // m per px
// `SCRUB_S`'s time twin (s per px), derived at the default entry speed exactly like
// `T_GRID`, so the position scrub covers the same ground per px in either domain.
const SCRUB_T = SCRUB_S / V0;
const SCRUB_G = 0.01; // g per px
// while a label scrubs, the popover's anchor FREEZES at its gesture-start position —
// a surface never moves under its own gesture (the point moves, the control stays
// put; it re-anchors to the point on release). also holds the popover visible if
// the scrub carries the diamond out of view.
let scrubFreeze: { x: number; y: number; mode?: TipMode } | null = $state(null);
interface ScrubOpts {
    seed: number; // the starting accumulator, read from the live value (not the tick display)
    rate: number; // value units per px of horizontal movement
    lo: number; // clamp bounds, applied to the accumulator every move — [-Infinity, Infinity]
    hi: number; // for an unbounded axis (g, Δg)
    round: number; // the displayed-precision multiplier (10 = one decimal, 100 = two)
    write: (v: number) => void; // the rounded value's write — may itself be a no-op (handleScrub's
    // tangentFor can return null on a degenerate composeTangent input)
    freeze?: { x: number; y: number; mode?: TipMode }; // the popover's frozen anchor, when this
    // scrub drives one (absent for a preference scrub, which anchors nothing)
    begin?: () => void; // the history-gesture opener; its presence is also the commit-on-release
    // switch (a preference scrub passes neither — it's not track state)
}
// the active label-scrub's teardown, so `cancelAll` (window blur) can close a scrub whose
// move/up/pointercancel listeners live on the LABEL, not window — a blur mid-scrub delivers
// neither event, so without this hook the closure survives: a second scrub on the same label
// then attaches a SECOND listener set (double-accumulating movementX), and the stale up() still
// fires on the next pointerup, committing a spurious extra history entry. Mirrors
// `cancelForceDrag`/`cancelTanDrag`/`cancelLenDrag`'s own cancel-path shape.
let scrubCancel: (() => void) | null = null;
// the one label-scrub body: guard, `beginDrag`, the movementX accumulator, and move/up/
// pointercancel wiring — the three call sites below (`scrubStart`/`handleScrub`/`snapScrub`)
// differ only in seed/rate/clamp/round/write plus the two optional hooks.
function labelScrub(e: PointerEvent, opts: ScrubOpts): void {
    if (e.button !== 0) return; // right-press opens the context menu; a scrub must not open too
    e.preventDefault();
    const label = e.currentTarget as HTMLElement;
    beginDrag(label, e.pointerId);
    if (opts.freeze !== undefined) scrubFreeze = opts.freeze;
    opts.begin?.();
    let acc = opts.seed;
    const move = (ev: PointerEvent): void => {
        acc = clamp(acc + ev.movementX * opts.rate, opts.lo, opts.hi);
        opts.write(Math.round(acc * opts.round) / opts.round);
    };
    const detach = (): void => {
        label.removeEventListener("pointermove", move);
        label.removeEventListener("pointerup", up);
        label.removeEventListener("pointercancel", up);
        scrubCancel = null;
        if (opts.freeze !== undefined) scrubFreeze = null; // re-anchor to the live subject
        gestureMapping = null; // release the gesture-frozen table (S6, harmless if unset)
    };
    const up = (): void => {
        detach();
        if (opts.begin) commit(history);
    };
    // registered so `cancelAll` can close this scrub from outside the closure (a window blur).
    scrubCancel = (): void => {
        detach();
        if (opts.begin) cancel(); // interrupted mid-scrub: revert to the pre-gesture value
    };
    label.addEventListener("pointermove", move);
    label.addEventListener("pointerup", up);
    // a cancelled pointer must still close the gesture — a left-open one would
    // swallow the next edit (one gesture at a time).
    label.addEventListener("pointercancel", up);
}
function cancelLabelScrub(): void {
    scrubCancel?.();
}
function scrubStart(e: PointerEvent, axis: "s" | "g"): void {
    const p = selPoint;
    if (p === null) return;
    if (!sectionEditable(editor.pinning, p.section)) return; // the lockdown
    const freeze = {
        x: clamp(ptX(p), LEFT_GUT + TIP_HALF, Math.max(LEFT_GUT + TIP_HALF, w - TIP_HALF)),
        y: clamp(yOf(p.g), TOP, h - BOT_PAD),
    };
    if (axis === "s") {
        // the position scrub slides the value the field DISPLAYS — the active domain, so its rate
        // and its rounding are that domain's own (`SCRUB_T` is `SCRUB_S`'s time twin at the default
        // entry speed) — and inverts through the GESTURE-FROZEN table for the write (`dOf`,
        // identity in Distance; S6 fix -- `v`/`p.startU` are the chart's own axis, never the
        // metres store directly).
        gestureMapping = mapping; // freeze -- see `keyframeDown`'s own note
        labelScrub(e, {
            seed: p.u,
            rate: timeDomain ? SCRUB_T : SCRUB_S,
            lo: p.startU,
            hi: uOf(p.startD + p.len),
            round: 10,
            write: (v) => setForcePoint(ecs, p.id, clamp(dOf(v) - p.startD, 0, p.len), p.g),
            freeze,
            begin: () => beginForceMove(ecs, p.id),
        });
    } else {
        labelScrub(e, {
            seed: p.g,
            rate: SCRUB_G,
            lo: -Infinity,
            hi: Infinity,
            round: 100,
            write: (v) => setForcePoint(ecs, p.id, p.s, v),
            freeze,
            begin: () => beginForceMove(ecs, p.id),
        });
    }
}
// handle field scrub — the same shallot-inspector affordance as the keyframe d/F fields, on the
// tangent (Δs, Δg) inputs. slides the offset; the write goes through the shared tangent path
// (composeTangent — x-monotonicity clamp + Aligned coupling), one history entry. Δs clamps to its
// monotonicity span (the keyframe-s scrub clamps to [0, len] the same way); Δg is unbounded.
function handleScrub(e: PointerEvent, axis: "s" | "g"): void {
    const sh = selHandle;
    if (sh === null) return;
    // the popover anchor FREEZES at gesture start — the knob rides a Δs/Δg scrub, but the
    // control stays put (a surface never moves under its own gesture). the mode freezes too, so a
    // scrub that carries the knob toward an edge never re-dodges mid-gesture.
    const tip = handleTip(sh.x, sh.y, yOf(sh.pt.g), sh.side, w, h);
    const freeze = { x: tip.x, y: tip.y, mode: tip.mode };
    const id = sh.pt.id;
    const side = sh.side;
    // the x-monotonicity span for Δs, fixed for the gesture (neighbour s don't move) — mirrors
    // composeTangent's clamp so the accumulator can't run past it.
    const pts = forcePts.filter((p) => p.section === sh.pt.section).sort((a, b) => a.s - b.s);
    const idx = pts.findIndex((p) => p.id === id);
    const prev = idx > 0 ? pts[idx - 1] : null;
    const next = idx < pts.length - 1 ? pts[idx + 1] : null;
    const dsLo = side === "out" ? 0 : prev ? -(sh.pt.s - prev.s) : 0;
    const dsHi = side === "out" ? (next ? next.s - sh.pt.s : 0) : 0;
    if (axis === "s") {
        const dg = sh.dg; // fixed for this gesture — only ds moves
        labelScrub(e, {
            seed: sh.ds,
            rate: SCRUB_S,
            lo: dsLo,
            hi: dsHi,
            round: 10,
            write: (v) => {
                const tan = tangentFor(id, side, v, dg);
                if (tan) setForceTangent(ecs, id, tan);
            },
            freeze,
            begin: () => beginForceTangent(ecs, id),
        });
    } else {
        const ds = sh.ds; // fixed for this gesture — only dg moves
        labelScrub(e, {
            seed: sh.dg,
            rate: SCRUB_G,
            lo: -Infinity,
            hi: Infinity,
            round: 100,
            write: (v) => {
                const tan = tangentFor(id, side, ds, v);
                if (tan) setForceTangent(ecs, id, tan);
            },
            freeze,
            begin: () => beginForceTangent(ecs, id),
        });
    }
}
// field keys: Enter commits (blur fires change); Escape reverts the edit and blurs
// without committing (the standard numeric-field escape). the window handler skips
// inputs, so the NEXT Escape deselects the keyframe — layered dismissal.
function fieldKeydown(e: KeyboardEvent, reset: string): void {
    const input = e.currentTarget as HTMLInputElement;
    if (e.key === "Enter") input.blur();
    else if (e.key === "Escape") {
        input.value = reset;
        input.blur();
    }
}
function cancelForceDrag(): void {
    cancelKfDrag();
}

// ── middle-button drag pans the view. intercepted at the host's capture phase so it
// fires before the pointer-events:all SVG rects; the ruler handler also routes a
// middle press here as a backstop.
let panning = $state(false); // reactive so the body shows a grabbing cursor while panning
let panX0 = 0;
let pan0 = 0;
function panDown(e: PointerEvent): void {
    if (eid === null) return;
    e.preventDefault();
    panning = true;
    panX0 = e.clientX;
    pan0 = clamped.pan;
    beginDrag(canvas, e.pointerId);
    window.addEventListener("pointermove", panMove);
    window.addEventListener("pointerup", panUp);
    window.addEventListener("pointercancel", panUp); // mirror release on cancel (no leaked listeners)
}
function panMove(e: PointerEvent): void {
    if (!panning) return; // drag content right → reveal earlier distance → pan decreases
    view = clampView(
        { pan: pan0 - (e.clientX - panX0), pxPerU: clamped.pxPerU },
        chartW,
        uTotal,
        mFloor,
    );
}
function panUp(): void {
    panning = false;
    window.removeEventListener("pointermove", panMove);
    window.removeEventListener("pointerup", panUp);
    window.removeEventListener("pointercancel", panUp);
}

// ── distance navigator: a full-track overview below the chart, drawn as a preview
// minimap (see renderNav). a window-bracket marks the portion the chart shows; drag the
// body to pan, drag an edge to zoom (the opposite edge anchored). the bar spans
// [0, sTotal + lead-out], so framing the whole track fills it.
let navEl: HTMLDivElement | undefined = $state();
const navWin = $derived(
    eid === null || sTotal <= 0 || chartW <= 0
        ? null
        : navWindow(clamped, chartW, uTotal, mFloor),
);
let navDrag: { mode: "pan" | "l" | "r"; grab: number } | null = null;
function navSAt(clientX: number): number {
    const rect = navEl!.getBoundingClientRect();
    const total = uTotal + marginArc(uTotal, mFloor);
    return clamp(((clientX - rect.left) / Math.max(1, rect.width)) * total, 0, total);
}
function navDown(e: PointerEvent, mode: "pan" | "l" | "r"): void {
    if (eid === null || sTotal <= 0) return;
    e.preventDefault();
    e.stopPropagation(); // an edge press must not also start a window pan
    navDrag = { mode, grab: navSAt(e.clientX) - pxToU(clamped, 0) };
    beginDrag(canvas, e.pointerId);
    window.addEventListener("pointermove", navMove);
    window.addEventListener("pointerup", navUp);
    window.addEventListener("pointercancel", navUp); // mirror release on cancel (no leaked listeners)
}
function navMove(e: PointerEvent): void {
    if (!navDrag) return;
    view = navDragView(
        clamped,
        chartW,
        uTotal,
        navDrag.mode,
        navSAt(e.clientX),
        navDrag.grab,
        mFloor,
    );
}
function navUp(): void {
    navDrag = null;
    window.removeEventListener("pointermove", navMove);
    window.removeEventListener("pointerup", navUp);
    window.removeEventListener("pointercancel", navUp);
}

function render(ctx: CanvasRenderingContext2D): void {
    ctx.clearRect(0, 0, w, h);
    ctx.font = "9px 'JetBrains Mono', ui-monospace, monospace";

    // ruler + gap bands: a lighter scrub strip over a darker channel, demarcating the
    // scrub zone from the curve chart (a 1px seam marks the chart top).
    ctx.fillStyle = "rgba(255, 255, 255, 0.04)";
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
    ctx.fillRect(0, RULER_H, w, GAP_H);

    // the velocity-strip HEADER band (the event rack): a demarcated lane of its own, between the
    // clip strip and the chart. It draws authored strips only (solid, below) — the infeasible
    // register moved to the segment bar itself (S2, finding 13: the person's own read named this
    // band as the wrong surface for it; the SVG `.ghost-span` overlay in the clip strip carries
    // the dashed-red treatment now, `ghostSpans` below still the one derivation both would read).
    // An all-feasible bake leaves the band showing only authored strips, same as before.
    ctx.fillStyle = "rgba(0, 0, 0, 0.18)";
    ctx.fillRect(0, RULER_H + GAP_H, w, STRIP_H);
    // the lane carries no label (S4, Locked decision finding 4: "events" retires with nothing
    // in its place — typing lives on the item, the strip's own fill color below and the "v"
    // unit on its selected readout, never a per-lane word).

    // authored velocity strips — solid fill, the strip's own kind color (the velocity hue,
    // `COLOR_VELOCITY`). Selected strips brighten. Boundary ticks disambiguate abutting strips.
    // The strip's value curve is flattened and solid over its extent (Locked decision: creation
    // seeds the constant from the published bake's `v` at the strip's first station, so a new
    // strip visibly flattens velocity the moment it exists). The value surface (keyframed curve
    // editing in the graph) is T2's — T1 carries only the lifecycle (create, select, trim,
    // body-drag, delete).
    for (const s of bandStrips) {
        const x0 = uPx(s.u0);
        const x1 = uPx(s.u1);
        if (x1 < LEFT_GUT || x0 > w) continue;
        const sel = editor.strip === s.id;
        // clamp the drawn width to ≥ 1px — a min-extent strip (the only kind the menu makes)
        // can draw sub-pixel or zero-width when zoomed out, the same clamp the ghost loop
        // above carries (S3's disclosed gap; the downstream freeze's own zero-length edge).
        const cx0 = Math.max(LEFT_GUT, x0);
        const cw = Math.max(1, Math.min(w, x1) - cx0);
        // canvas 2D ignores `var(--…)` CSS custom properties — a `fillStyle`/`strokeStyle`
        // string is resolved once, at the value's own construction, never against a live
        // cascade, so the CSS token had no effect and every unselected strip drew invisible
        // (S1 Visibility fix). `dimmed(COLOR_VELOCITY)` + `globalAlpha` is the canvas-side twin
        // of the same selected/unselected split the CSS token would have driven — the base fill
        // sits one rung DOWN from the raw hue (S4, finding 4: dimmer, in-palette — the same
        // OKLCH move `hovered` makes upward, `colors.ts`), selection returning it to the full hue.
        // S3 (Affordances): the hover rung, in kex2d's own channel — color, never the cursor
        // (editor-ui.md Affordance typing). An AREA lifts its fill one `hovered()` rung
        // (editor-ui.md Kind color); never on a stronger register (selection already reads
        // brighter, the same `.fpt:hover:not(.sel)` precedence force keyframes use).
        const bodyHover = !sel && bandHit.kind === "body" && bandHit.id === s.id;
        ctx.globalAlpha = sel ? 0.85 : 0.55;
        ctx.fillStyle = bodyHover
            ? hovered(COLOR_VELOCITY)
            : sel
              ? COLOR_VELOCITY
              : dimmed(COLOR_VELOCITY);
        // rendered rect height: the clip's own (S4, finding 5) — `CLIP_H`, never the container
        // band's full `STRIP_H`, so the fill reads as one rect language with the section clip
        // above it rather than a taller, ungrounded sliver.
        ctx.fillRect(cx0, RULER_H + GAP_H + CLIP_PAD, cw, CLIP_H);
        ctx.globalAlpha = 1;
        if (sel) {
            ctx.strokeStyle = COLOR_VELOCITY;
            ctx.lineWidth = 1;
            ctx.strokeRect(cx0 + 0.5, RULER_H + GAP_H + CLIP_PAD + 0.5, cw - 1, CLIP_H - 1);
        }
        // the RESIZE affordance: a hovered endpoint reads apart from a hovered body by which
        // STROKE it takes, never a cursor swap (the S3 premise correction — no `ew-resize` here,
        // `editor-ui.md`'s field-row scrub idiom stays `.fld .key`'s own). A bright edge line at
        // exactly the boundary, the force clip-trim's own hover-brightens-the-handle shape
        // (`.clip-trim:hover`) read onto a canvas-drawn edge instead of a DOM one. `!sel` for the
        // same reason `bodyHover` carries it: hover is invisible on an already-selected element
        // (editor-ui.md Kind color) — unconditional, no exemption for the edge case. Spans the
        // fill's own rendered height (`CLIP_H`), the same inset the fill itself draws at.
        if (!sel && bandHit.kind === "endpoint" && bandHit.id === s.id) {
            const ex = bandHit.edge === "start" ? cx0 : cx0 + cw;
            ctx.strokeStyle = hovered(COLOR_VELOCITY);
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(ex, RULER_H + GAP_H + CLIP_PAD);
            ctx.lineTo(ex, RULER_H + GAP_H + CLIP_PAD + CLIP_H);
            ctx.stroke();
        }
    }
    // boundary ticks: the abutment disambiguator between two same-section strips sharing an
    // edge — spans the fill's own rendered height (`CLIP_H`), the same inset the fill draws at.
    for (const tx of stripTicks) {
        if (tx < LEFT_GUT || tx > w) continue;
        ctx.strokeStyle = "rgba(0, 0, 0, 0.5)";
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(tx, RULER_H + GAP_H + CLIP_PAD);
        ctx.lineTo(tx, RULER_H + GAP_H + CLIP_PAD + CLIP_H);
        ctx.stroke();
    }

    // the track-start one-shot (S3, Locked decision — its own structurally distinct point
    // kind, never a degenerate `Strip`): one glyph, always at `d = 0`, independent of
    // `bandStrips` — a small diamond at the track's own start station, `FMARKER_R`'s own
    // size so it reads at the force-point diamond's weight. No body fill, no resize-edge
    // stroke: it has no extent to resize (fixed at `d = 0`, no drag-out — S3 retires that
    // machinery along with the point-as-span model).
    if (entryOneShot(ecs)) {
        const gx = oneShotGlyphX();
        if (gx >= LEFT_GUT && gx <= w) {
            const cy = RULER_H + GAP_H + STRIP_H / 2;
            const selOs = editor.oneShot;
            const glyphHover = !selOs && oneShotHover;
            ctx.globalAlpha = selOs ? 0.95 : 0.7;
            ctx.fillStyle = glyphHover ? hovered(COLOR_VELOCITY) : COLOR_VELOCITY;
            ctx.beginPath();
            ctx.moveTo(gx, cy - STRIP_GLYPH_R);
            ctx.lineTo(gx + STRIP_GLYPH_R, cy);
            ctx.lineTo(gx, cy + STRIP_GLYPH_R);
            ctx.lineTo(gx - STRIP_GLYPH_R, cy);
            ctx.closePath();
            ctx.fill();
            ctx.globalAlpha = 1;
            if (selOs) {
                ctx.strokeStyle = COLOR_VELOCITY;
                ctx.lineWidth = 1;
                ctx.stroke();
            }
        }
    }

    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, TOP + 0.5);
    ctx.lineTo(w, TOP + 0.5);
    ctx.stroke();

    for (const tk of tickList) {
        const x = LEFT_GUT + tk.px; // tick px is chart-local; the chart insets past the gutter
        if (x < LEFT_GUT - 1 || x > w + 1) continue;
        // faint gridline through the chart — read the curve against distance
        ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, TOP);
        ctx.lineTo(x, h - BOT_PAD);
        ctx.stroke();
        // tick mark + label in the ruler
        ctx.strokeStyle = "rgba(160, 152, 144, 0.5)";
        ctx.beginPath();
        ctx.moveTo(x, RULER_H - 5);
        ctx.lineTo(x, RULER_H);
        ctx.stroke();
        ctx.fillStyle = "rgba(160, 152, 144, 0.8)";
        ctx.textBaseline = "top";
        ctx.textAlign = "center";
        ctx.fillText(tk.label, x, 8);
    }

    // g gridlines + left-gutter labels, on the displayed range's nice step. labels
    // round to the step's decimals (a raw float prints 0.6000…1, which clips).
    const { lo, hi, step } = yView;
    const dec = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let g = Math.ceil(lo / step) * step; g <= hi + step * 1e-6; g += step) {
        const gv = Math.abs(g) < step * 1e-6 ? 0 : g; // snap fp drift to a clean 0
        const y = yOf(gv);
        ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(LEFT_GUT, y);
        ctx.lineTo(w, y);
        ctx.stroke();
        // skip a label that would bleed past the plot band (the extreme top/bottom
        // gridlines) rather than cram it inward — the interior labels carry the scale.
        if (y >= TOP + LABEL_HALF && y <= h - BOT_PAD - LABEL_HALF) {
            ctx.fillStyle = "rgba(160, 152, 144, 0.7)";
            ctx.fillText(`${fmt(gv, dec)}g`, LEFT_GUT - 6, y);
        }
    }

    // reference comfort limits — drawn only when within the visible range
    ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
    ctx.lineWidth = 1;
    for (const lim of BAND) {
        if (lim < lo || lim > hi) continue;
        ctx.beginPath();
        ctx.moveTo(LEFT_GUT, yOf(lim));
        ctx.lineTo(w, yOf(lim));
        ctx.stroke();
    }

    // 1g gravity baseline — neutral (accent is reserved for the result curve)
    ctx.strokeStyle = "rgba(205, 197, 188, 0.45)";
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(LEFT_GUT, yOf(Y_BASE));
    ctx.lineTo(w, yOf(Y_BASE));
    ctx.stroke();
    ctx.setLineDash([]);
    // on-surface naming (N1's identification repair): a person read the 1 g gravity baseline as
    // "an unexplained yellow dotted line at zero" (taste ledger verdict 2). Naming the channels
    // on the surface is the fix — a small label at the line's left end, in the same neutral tone.
    // Left-aligned (reset from the g-axis loop's `right` above) and in the app's mono face (reset
    // from the `sans-serif` that replaced it), so the label sits at the line's left end, not
    // colliding leftward with the g-axis label column.
    ctx.textAlign = "left";
    ctx.font = "9px 'JetBrains Mono', ui-monospace, monospace";
    ctx.fillStyle = "rgba(205, 197, 188, 0.6)";
    ctx.textBaseline = "bottom";
    ctx.fillText("1 g", LEFT_GUT + 3, yOf(Y_BASE) - 2);

    // section boundaries: a vertical guide at each interior boundary — the chart counterpart of
    // the viewport's boundary anchor diamonds. On the chart's own axis, like the clip edges.
    for (const bs of bounds) {
        const x = uPx(bs);
        if (x < LEFT_GUT - 1 || x > w + 1) continue;
        ctx.strokeStyle = "rgba(154, 160, 166, 0.45)";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, TOP);
        ctx.lineTo(x, h - BOT_PAD);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // clip the data series to the inner chart rect: a panned/zoomed curve must not
    // paint over the left g-gutter labels or bleed past the ruler / bottom inset.
    ctx.save();
    ctx.beginPath();
    ctx.rect(LEFT_GUT, TOP, w - LEFT_GUT, h - BOT_PAD - TOP);
    ctx.clip();

    // the baked F_n force curve — kind-colored per section (the timeline's mirror of
    // the viewport polyline's kind color, `colors.ts`): a geo section's span of the
    // whole-track curve reads cool blue, a force section's reads accent gold, the
    // same language the clip strip and boundary guides above use. drawn per-sample
    // over arclength (the chart's x-axis is distance). the curve carries no
    // infeasibility/selection overlay of its own, so no priority layering is needed
    // here (unlike the viewport polyline).
    if (curve) {
        ctx.lineWidth = 1.6;
        for (const seg of kindSegments(ecs)) {
            ctx.strokeStyle = seg.color;
            ctx.beginPath();
            for (let i = seg.startSample; i <= seg.endSample; i++) {
                const x = markerX(curve.s[i]);
                const y = yOf(curve.f[i]);
                if (i === seg.startSample) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
        }
    }

    // the recovered-speed curve — one hue, always dashed and faded: it is
    // never authored (`editor-ui.md` Mode vocabulary's dashed + faded, shown-but-not-authored
    // meaning), so unlike the force curve above it carries no kind-color split and no toggle.
    // Own auto-fit scale (`vOf`/`vView`), same shared document x-axis (`markerX`).
    if (vCurve) {
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = COLOR_VELOCITY;
        ctx.setLineDash([5, 4]);
        ctx.globalAlpha = 0.25;
        ctx.beginPath();
        for (let i = 0; i < vCurve.n; i++) {
            const x = markerX(vCurve.s[i]);
            const y = vOf(vCurve.v[i]);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
        // on-surface naming: the velocity channel's label, in the same faded tone as the curve.
        // Left-aligned and in the app's mono face (reset from the g-axis loop's `right` and the
        // `sans-serif` that replaced it above), matching the 1 g label.
        ctx.textAlign = "left";
        ctx.font = "9px 'JetBrains Mono', ui-monospace, monospace";
        ctx.globalAlpha = 0.4;
        ctx.fillStyle = COLOR_VELOCITY;
        ctx.textBaseline = "bottom";
        ctx.fillText("v", LEFT_GUT + 3, vOf(vCurve.v[0]) - 2);
        ctx.globalAlpha = 1;
    }

    // every strip's AUTHORED velocity curve — solid over its extent (T2: value in the graph),
    // drawn for every strip (Locked decision "Visibility"): solid where a strip AUTHORS it,
    // not where one is selected. The recovered-speed channel above is always dashed/faded
    // (display-only); an authored curve is solid, selection brightening it exactly as the
    // header band does (0.55 → 0.85 alpha) rather than a flat accent recolor. When a strip
    // has no keyframes this is a flat line at its constant `value`; with keyframes it's the
    // evaluated curve. Clipped to the chart by the clip rect above.
    ctx.lineWidth = 2;
    ctx.strokeStyle = COLOR_VELOCITY;
    ctx.setLineDash([]);
    for (const sc of stripCurves) {
        if (sc.points.length < 2) continue;
        ctx.globalAlpha = sc.sel ? 0.85 : 0.55;
        ctx.beginPath();
        for (let i = 0; i < sc.points.length; i++) {
            if (i === 0) ctx.moveTo(sc.points[i].x, sc.points[i].y);
            else ctx.lineTo(sc.points[i].x, sc.points[i].y);
        }
        ctx.stroke();
    }
    ctx.globalAlpha = 1;

    ctx.restore();
}

// the navigator preview (VSCode-minimap / DAW-overview style): a faint miniature of
// the whole F_n force curve across the full track, so the viewport bracket reads
// against the curve's shape. y-range tracks the chart's `yView`; x is arclength over
// [0, sTotal + lead-out], so the curve occupies only [0, sTotal] (the margin stays empty).
function renderNav(nav: CanvasRenderingContext2D, cw: number, ch: number): void {
    nav.clearRect(0, 0, cw, ch);
    const data = curve;
    if (!data || data.n < 2 || sTotal <= 0) return;
    const total = uTotal + marginArc(uTotal, mFloor); // the bar spans the track + lead-out
    const { lo, hi } = yView;
    const span = Math.max(1e-6, hi - lo);
    const pad = 2; // vertical inset so the curve doesn't touch the lane edges
    const ny = (val: number): number =>
        pad + (1 - (clamp(val, lo, hi) - lo) / span) * (ch - 2 * pad);
    // kind-colored per section, same as the chart above — dimmed to the nav's existing
    // low-attention treatment (the same 0.55 alpha the flat accent line used to carry).
    nav.lineWidth = 1;
    nav.globalAlpha = 0.55;
    for (const seg of kindSegments(ecs)) {
        nav.strokeStyle = seg.color;
        nav.beginPath();
        for (let i = seg.startSample; i <= seg.endSample; i++) {
            const x = (uOf(data.s[i]) / total) * cw;
            const y = ny(data.f[i]);
            if (i === seg.startSample) nav.moveTo(x, y);
            else nav.lineTo(x, y);
        }
        nav.stroke();
    }
    nav.globalAlpha = 1;
}

$effect(() => {
    // frame the whole track once, when width + a track first exist.
    if (!framed && chartW > 0 && sTotal > 0) {
        view = frameAll(chartW, uTotal, mFloor);
        framed = true;
    }
});

$effect(() => {
    // render() reads view/data/size synchronously, so the effect tracks them.
    const ctx = canvas?.getContext("2d");
    if (!ctx) return;
    // `w`/`h` explicitly — not a DOM re-read — closes the resize-flicker race (S2, `view.ts`
    // `resize`'s own docblock): the canvas's pixel buffer and this frame's draw math must size
    // off the exact same reactive value, or a mid-resize frame can size one off the new box and
    // the other off the stale one.
    resize(canvas, ctx, w, h);
    render(ctx);
    const nav = navCanvas;
    const nctx = nav?.getContext("2d");
    if (nav && nctx) {
        resize(nav, nctx);
        renderNav(nctx, nav.clientWidth, nav.clientHeight);
    }
});

// ── ruler scrub: click/drag anywhere in the top band positions the playhead. it
// freezes playback while held and *parks* on release — never auto-resumes (the After
// Effects / animation-timeline convention: scrubbing sets time, play is separate).
let scrubbing = false;
function scrubTo(e: PointerEvent): void {
    if (eid === null || !scrubbing) return;
    const rect = canvas.getBoundingClientRect();
    // the ruler is distance — park at the picked cumulative arclength directly (the
    // scrub's native domain), which also derives the display time. snapping parks
    // exactly on a track feature (boundary / keyframe / tick) — the AE convention that
    // the current-time indicator latches to keyframes and markers; the playhead line is
    // its own indicator so no extra guide flashes. Ctrl/Cmd bypasses for a fine scrub.
    let s = clamp(dAtPx(e.clientX - rect.left), 0, sTotal);
    if (snapActive(e.ctrlKey || e.metaKey)) {
        const hit = snap(uToPx(clamped, uOf(s)), sTargets({ playhead: false, trackEnd: true }));
        if (hit !== null) s = clamp(dOf(pxToU(clamped, hit)), 0, sTotal);
    }
    parkAtArc(ecs, eid, s);
}
function endScrub(): void {
    scrubbing = false; // leave st.held true — parked + paused, no auto-resume
    window.removeEventListener("pointermove", scrubTo);
    window.removeEventListener("pointerup", endScrub);
    window.removeEventListener("pointercancel", endScrub);
}
function startScrub(e: PointerEvent): void {
    if (eid === null) return;
    if (e.button === 1) {
        panDown(e);
        return;
    }
    if (e.button !== 0) return; // left-only scrub; right suppressed by the host
    const st = cartState.get(eid);
    if (!st) return;
    // the ruler holds no selectable objects — every press is an empty-space click, so it
    // deselects everything (`kex2d-event-lane` S4's "one selection model"); shift-click
    // preserves (the chart/band's own empty-click precedent).
    if (!e.shiftKey) deselectAll();
    e.preventDefault();
    scrubbing = true;
    st.held = true; // freeze playback while scrubbing
    beginDrag(canvas, e.pointerId);
    scrubTo(e);
    window.addEventListener("pointermove", scrubTo);
    window.addEventListener("pointerup", endScrub);
    window.addEventListener("pointercancel", endScrub); // mirror release on cancel (no leaked listeners)
}

// right-click the ruler → the domain menu (Meters / Seconds) at the cursor — the Premiere/REAPER/
// Cubase reference: time-display format lives on the ruler's own context menu, not a standing
// rail toggle. no target selection (the ruler addresses the whole timeline, not a track element).
function rulerCtx(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    openRulerMenu(e.clientX, e.clientY);
}

function togglePlay(): void {
    if (eid === null) return;
    const st = cartState.get(eid);
    if (!st) return;
    st.held = !st.held;
    if (st.held) parkFromTime(ecs, eid); // pausing parks at the cart's current place
}

// ── player slider: the full-track scrubber. drag maps screen-X → track fraction →
// time (global, not view-relative). holding while dragging freezes the cart; release
// restores the pre-grab play state (grab while paused stays paused — the media-player
// convention).
let scrubEl: HTMLDivElement;
let sliding = false;
let sliderResume = false;
function sliderTo(e: PointerEvent): void {
    if (eid === null || !sliding) return;
    const rect = scrubEl.getBoundingClientRect();
    const f = rect.width > 0 ? clamp((e.clientX - rect.left) / rect.width, 0, 1) : 0;
    const st = cartState.get(eid);
    if (!st) return;
    st.t = f * tTotal;
    parkFromTime(ecs, eid); // project the dragged time onto the content anchor
}
function sliderUp(): void {
    if (!sliding) return; // not dragging → nothing to restore (cleanup no-op)
    sliding = false;
    if (eid !== null) {
        const st = cartState.get(eid);
        if (st) st.held = sliderResume;
    }
    window.removeEventListener("pointermove", sliderTo);
    window.removeEventListener("pointerup", sliderUp);
    window.removeEventListener("pointercancel", sliderUp);
}
function sliderDown(e: PointerEvent): void {
    if (eid === null || tTotal <= 0) return;
    const st = cartState.get(eid);
    if (!st) return;
    e.preventDefault();
    sliderResume = st.held; // resume playing only if it was playing before the grab
    sliding = true;
    st.held = true;
    beginDrag(scrubEl, e.pointerId);
    sliderTo(e);
    window.addEventListener("pointermove", sliderTo);
    window.addEventListener("pointerup", sliderUp);
    window.addEventListener("pointercancel", sliderUp); // mirror release on cancel (no leaked listeners)
}
// arrow-step the playhead — shared by both scrub controls (the ruler and the slider).
// bound to the focused scrub element, so it also honors the hovered-surface router: the
// playhead steps only while the pointer is over the timeline (else a focused ruler would
// step the playhead as the viewport arrow-nudges a node — the double-fire), and defers to
// a selected force point so one timeline arrow press is one action (nudge, not both).
function stepKey(e: KeyboardEvent): void {
    if (editor.hover !== "timeline" || editor.force !== null) return;
    if (eid === null || tTotal <= 0) return;
    const st = cartState.get(eid);
    if (!st) return;
    const step = e.shiftKey ? 1 : 0.1; // seconds; shift = coarse
    const d = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
    if (d === 0) return;
    e.preventDefault();
    st.held = true; // stepping pauses, like a frame-step
    st.t = clamp((cartSec ?? 0) + d, 0, tTotal);
    parkFromTime(ecs, eid); // anchor the stepped time to the content under it
}
// tear down every in-flight Timeline gesture — the unmount cleanup set, factored so a window
// blur (below) can run the exact same teardown. a blur mid-gesture never delivers the
// pointerup/pointercancel that would end a drag (the `controls.ts` `onBlur` mirror), so without
// this a keyframe/handle/extent/marquee drag resumes stale on refocus and `editor.dragging` (the
// one live-gesture flag) sticks, eating wheel zoom and hover until the next completed drag.
function cancelAll(): void {
    endScrub(); // drop any in-flight ruler scrub
    sliderUp(); // and any in-flight player-slider drag
    panUp(); // and any in-flight middle-drag pan
    navUp(); // and any in-flight navigator drag
    cancelForceDrag(); // and any in-flight keyframe drag (unified — force or strip)
    marqueeCancel(); // and any in-flight chart marquee (its listeners live on window)
    cancelTanDrag(); // and any in-flight handle drag
    cancelLenDrag(); // and any in-flight extent drag
    cancelLabelScrub(); // and any in-flight label scrub (its listeners live on the label, not window)
    cancelStripDrag(); // and any in-flight strip resize/body drag
    endDragGesture(); // clear the drag flag (no release event tore it down)
}
onMount(() => {
    // a no-op while a gesture is live — the viewport's rule, on this surface (`controls.ts`
    // `onWheel` carries the why: one rule, `editor.dragging` as the one live-gesture flag, the
    // event still swallowed). Here it holds the DOCUMENT axis still under a keyframe drag, an
    // extent trim, a handle drag, or a chart marquee, each of which reads the cursor against
    // the live `view`.
    const onWheel = (e: WheelEvent): void => {
        e.preventDefault();
        if (editor.dragging) return;
        const x = e.clientX - canvas.getBoundingClientRect().left - LEFT_GUT; // chart-local anchor
        // curve-editor standard (Unity/AE): plain wheel zooms, shift+wheel pans.
        // a trackpad's horizontal axis pans too; pinch arrives as ctrl+wheel → zoom.
        const panH = e.shiftKey || (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaX) > Math.abs(e.deltaY));
        if (panH) {
            const dx = e.shiftKey ? e.deltaY : e.deltaX;
            view = clampView(
                { pan: clamped.pan + dx, pxPerU: clamped.pxPerU },
                chartW,
                uTotal,
                mFloor,
            );
        } else {
            view = zoomAt(clamped, x, 2 ** (-e.deltaY / ZOOM_DIV), chartW, uTotal, mFloor);
        }
    };
    // undo/redo drive the shared history (track-node edits); Space toggles playback.
    const onKey = (e: KeyboardEvent): void => {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        if (e.ctrlKey || e.metaKey) {
            // …but never MID-GESTURE (`editor.dragging`, the one live-gesture flag — the same guard
            // `onWheel` and `F` wear). A live drag owns the open history gesture (one at a time), so
            // an undo underneath it would pop an unrelated entry and then have the drag's own commit
            // land on top; worse, a `Track.domain` entry would flip the store's unit under a grab
            // resolved in the other one. The gesture ends first — release or Escape — then undo.
            if (editor.dragging) return;
            const k = e.key.toLowerCase();
            if (k === "z") {
                e.preventDefault();
                // history navigation invalidates a live paced landing FIRST — its frozen moves
                // would otherwise keep easing diamonds toward values the undo just erased
                // (adversarial finding 2; the same skip pointerdown/Esc and Exit apply).
                skipLanding();
                // routed (stage 7): the SANDBOX while an pin mode is open — in-mode
                // undo/redo never reach the outer stacks, and undo at the sandbox's start exits.
                if (e.shiftKey) redoRouted(history, ecs);
                else undoRouted(history, ecs);
            } else if (k === "y") {
                e.preventDefault();
                skipLanding();
                redoRouted(history, ecs);
            }
            return;
        }
        if (e.code === "Space") {
            e.preventDefault();
            togglePlay();
            return;
        }
        // frame content (Unity/Blender `F`): frames the whole track (frameAll), the
        // x-mirror of the viewport's F — but only when the pointer is over the timeline
        // (the hovered-surface router), so `F` frames one surface, not both at once. guard
        // Ctrl/Cmd+F (browser find) and mid-gesture, on `editor.dragging`, the ONE
        // live-gesture flag every gesture raises through `beginDrag` (same guard as
        // `onWheel`, above) — a mid-gesture reframe would move the document axis under a
        // live keyframe drag, extent trim, handle drag, or chart marquee.
        if (
            (e.key === "f" || e.key === "F") &&
            !e.ctrlKey &&
            !e.metaKey &&
            !editor.dragging &&
            editor.hover === "timeline"
        ) {
            if (chartW > 0 && sTotal > 0) {
                e.preventDefault();
                view = frameAll(chartW, uTotal, mFloor);
            }
            return;
        }
        if (appendAnchor && e.key === "Escape") {
            e.preventDefault();
            appendAnchor = null;
            return;
        }
        if (snapPop && e.key === "Escape") {
            e.preventDefault();
            snapPop = null;
            return;
        }
        // the track-start one-shot's own select/delete — Escape/Delete only, `editor.strip`'s
        // point-kind twin (S3): no drag, no keyframe sub-selection to peel first.
        if (editor.oneShot) {
            if (e.key === "Escape") {
                e.preventDefault();
                selectOneShot(false);
            } else if (bound(BINDINGS.remove, e.key)) {
                e.preventDefault();
                deleteSelectedOneShot();
            }
            return;
        }
        // velocity-strip select/delete — Escape/Delete only (a strip has no handle/tangent
        // sub-mode to peel, unlike a force keyframe's Escape ladder above). A selected
        // strip keyframe (a sub-selection layered on the strip) peels first: Delete removes
        // the keyframe (not the strip), and Escape clears the keyframe selection before
        // the strip's — the force keyframe's own Escape ladder.
        if (editor.strip !== null) {
            if (e.key === "Escape") {
                e.preventDefault();
                if (editor.stripKf !== null) selectStripKf(null);
                else selectStrip(null);
            } else if (bound(BINDINGS.remove, e.key)) {
                e.preventDefault();
                if (editor.stripKf !== null) deleteSelectedStripKf();
                else deleteSelectedStrip();
            } else if (
                editor.stripKf !== null &&
                editor.hover === "timeline" &&
                (e.key === "ArrowLeft" ||
                    e.key === "ArrowRight" ||
                    e.key === "ArrowUp" ||
                    e.key === "ArrowDown")
            ) {
                // arrow-nudge the selected strip-keyframe set — the force keyframe's own path
                // through `nudgeKeyframes` (S1: both kinds ride one nudge function). only while a
                // strip keyframe is selected and the pointer is over the timeline. Shift coarse;
                // one press = one undo entry.
                //
                // read the strip + its keyframes from the ECS directly, not `stripKfPts` (a
                // `$derived` behind the RAF `void tick`, same class `deleteSelectedStrip`'s own
                // note documents and the GEO nudge's `nodeLocal` already fixed, `controls.ts`):
                // a second nudge fired before `tick` has advanced since the first nudge's write
                // reads the PRE-write `s` as its base, rounds to the same grid point one step
                // short, and commits a wrong value (section.pw.ts:2344, witnessed:
                // `toBeCloseTo` Expected 11.1, Received 11 with no frame between the two
                // presses). `stripAt`/`stripKeyframes` are synchronous ECS queries.
                const stripEid = stripAt(ecs, editor.strip);
                if (stripEid === null) return;
                const members = stripKeyframes(ecs, editor.strip).filter((k) =>
                    editor.stripKfs.ids.has(k.id),
                );
                if (members.length === 0) return;
                if (!stripEditableAt(Strip.start.get(stripEid))) return;
                e.preventDefault();
                skipLanding();
                const stepS = e.shiftKey ? NUDGE_S_COARSE : NUDGE_S;
                const stepV = e.shiftKey ? NUDGE_V_COARSE : NUDGE_V;
                const ds = e.key === "ArrowLeft" ? -stepS : e.key === "ArrowRight" ? stepS : 0;
                const dv = e.key === "ArrowUp" ? stepV : e.key === "ArrowDown" ? -stepV : 0;
                const lo = Strip.start.get(stripEid);
                const len = Strip.end.get(stripEid);
                beginStripKeyframeMoves(
                    ecs,
                    members.map((m) => m.id),
                );
                for (const w of nudgeKeyframes(
                    members.map((m) => ({ id: m.id, s: m.s, v: m.v, len, lo })),
                    ds,
                    dv,
                ))
                    setStripKeyframe(ecs, w.id, w.s, Math.max(V_FLOOR, w.v));
                commit(history);
            }
            return;
        }
        // force-point select/delete/nudge — guarded on a live force selection so geo-node
        // Esc/Del/arrows (controls.ts) stay unambiguous (the selections are mutually exclusive).
        // Delete and `Q` route through `keys.ts`'s `forceKeyAct` (the keyboard twin of
        // `menus.keyframeMenu`'s `Delete`/Lock-Unlock rows); Escape and the arrow-nudge are
        // nobody's menu row and stay raw.
        if (editor.force !== null) {
            if (e.key === "Escape") {
                // dismissal peels one layer: deselect the handle first (back to the keyframe
                // readout), then exit handle edit (keep the point selected), then clear the
                // selection. the force menu takes Escape before this (capture).
                e.preventDefault();
                if (editor.forceHandle !== null) selectForceHandle(null);
                else if (editor.forceEdit !== null) exitForceEdit();
                else selectForce(null);
            } else {
                // Cut's own landmark guard — the interior bound (`keyframeCuttable`, no cursor
                // lens needed); the consent-boundary check is `pinning` itself (`!s.pinning` inside
                // `forceKeyAct`, `acts.sectionOpsAllowed`'s own shape) — the same field the lock
                // toggle already reads, not a second `sectionEditable` reading (the stage-6 review's
                // finding: that field reads true on the pinning session's own keyframe).
                const activePt = forcePts.find((p) => p.id === editor.force);
                const act = forceKeyAct(e.key, {
                    pinning: editor.pinning !== null,
                    size: editor.forces.ids.size,
                    cuttable: activePt !== undefined && keyframeCuttable(activePt.s, activePt.len),
                });
                if (act !== null) {
                    e.preventDefault();
                    // `Q` = the lock/free toggle (kex2d stage 6 — reachability is the criterion:
                    // left-hand top row, one hand on the keyboard while the other mouses; the old
                    // `L` was unreachable that way and is removed, not aliased), restricted to the
                    // pinning section's own keys (a lock on another section's key would be dead
                    // state — the solve never reads it). the mode-only menu row is the mouse path
                    // to the same toggle.
                    keyframeActs(ecs)[act]();
                } else if (
                    editor.hover === "timeline" &&
                    (e.key === "ArrowLeft" ||
                        e.key === "ArrowRight" ||
                        e.key === "ArrowUp" ||
                        e.key === "ArrowDown")
                ) {
                    // arrow-nudge the selected force set — only while the pointer is over the
                    // timeline (the hovered-surface router — a node nudge in the viewport must not
                    // also move a force point). single-select rounds the absolute result to the
                    // field grid (pre-multiselect semantics); a multi-set moves by one shared delta
                    // under the rigid clamp, offsets preserved (`nudgeKeyframes`, timeline.ts). Shift
                    // coarse; one press = one undo entry.
                    const members = forcePts.filter((fp) => editor.forces.ids.has(fp.id));
                    if (members.length === 0) return;
                    if (!forceSetEditable(ecs)) return; // the lockdown — all-or-nothing, like Del
                    e.preventDefault();
                    skipLanding(); // keyboard mutation mid-window: same routing as undo/redo above
                    const stepS = e.shiftKey ? NUDGE_S_COARSE : NUDGE_S;
                    const stepG = e.shiftKey ? NUDGE_G_COARSE : NUDGE_G;
                    const ds = e.key === "ArrowLeft" ? -stepS : e.key === "ArrowRight" ? stepS : 0;
                    const dg = e.key === "ArrowUp" ? stepG : e.key === "ArrowDown" ? -stepG : 0;
                    beginForceMoves(
                        ecs,
                        members.map((m) => m.id),
                    );
                    for (const w of nudgeKeyframes(
                        members.map((m) => ({ id: m.id, s: m.s, v: m.g, len: m.len })),
                        ds,
                        dg,
                    ))
                        setForcePoint(ecs, w.id, w.s, w.v);
                    commit(history);
                }
            }
        }
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", cancelAll);
    // DEV-only harness reads: the displayed value-axis (g) range and the document axis's stored
    // view. Both are component-local view state — never authored, so they're off the main.ts
    // `__kex` authoring surface; the timeline augments the hook here. The edge-pan flow reads
    // `gRange` to assert a held handle drag grows the range and a release accommodates the handle
    // endpoint; the wheel-guard flow reads `xView` (the viewport `cam` twin) to assert a
    // mid-gesture wheel wrote nothing. `xView` is `view` itself — what the wheel writes — not the
    // `clamped` projection the chart draws, which folds in `chartW`/`sTotal` the wheel never touches.
    if (import.meta.env.DEV) {
        const k = (window as unknown as { __kex?: Record<string, unknown> }).__kex;
        if (k) {
            k.gRange = (): [number, number] => [yView.lo, yView.hi];
            k.vRange = (): [number, number] => [vView.lo, vView.hi];
            k.xView = (): [number, number] => [view.pan, view.pxPerU];
            // the domain the chart READS (`Track.domain`, tick-derived so a flow polls it), and
            // every keyframe's coordinate on that axis — paired with the stored `s` (S6: the
            // lens read, never a second unit the store holds). `section` + `g`
            // (kex2d-structural-editing stage 9) let a multi-section flow read a Cut's TWO
            // halves apart — `main.ts`'s `forces()` only ever reads section 0 (`sec()`), so it
            // can't see a split's tail — without re-deriving `forcePts`' own grouping by hand.
            k.domain = (): string => (domain === Domain.Time ? "time" : "distance");
            // `forceU` computes its whole snapshot fresh from the ECS: a FRESH `sectionSpans`
            // call (not the stale `spans` `$derived`) feeds a FRESH `computeClips` call (not the
            // stale `clips` `$derived`), so the keyframe positions are projected against the
            // current bake's span table — never a mix of fresh keyframes and stale clips/spans.
            // A strip move/widen changes the bake (which changes `sectionSpans`), so the cached
            // `$derived` values can be stale after such a write.
            k.forceU = (): { id: number; section: number; s: number; g: number; u: number }[] => {
                const freshSpans = eid === null ? [] : sectionSpans(ecs, eid);
                const freshClips = computeClips(freshSpans, ecs);
                return computeForcePts(freshClips, freshSpans, ecs).map((p) => ({ id: p.id, section: p.section, s: p.s, g: p.g, u: p.u }));
            };
            // the chart's axis<->arclength lens, both directions, at the LIVE (or, mid-gesture,
            // gesture-frozen) s↔t table — S6's own oracle: a capture flow calls these BEFORE
            // starting a drag to read the table the gesture will freeze, so it can verify a write
            // landed at `s0 + (dOf(u) - dOf(u0))` against the SAME snapshot the gesture used.
            k.dOf = (u: number): number => dOf(u);
            k.uOf = (d: number): number => uOf(d);
            // the extent trim's own extrapolating projection (S6b) -- `uToDExtend` at the LIVE
            // exit speed (`exitSpeed`), the value a `lenDown` about to start would freeze into
            // `lenVExit`. Read BEFORE the trim gesture, same convention as `dOf`/`uOf` above.
            k.dOfTrim = (u: number): number =>
                uToDExtend(gestureMapping ?? mapping, domain, u, exitSpeed());
            // the red ghost strip's own screen px, view-projected exactly as drawn (`ghostSpans`
            // above) — the capture flow's pixel probe reads a point INSIDE one of these rather
            // than re-deriving the arclength→px projection a second time (the ctxCut precedent).
            k.ghostPx = (): { x0: number; x1: number }[] => ghostSpans;
            // the selected strip's keyframe diamonds' screen px, projected exactly as drawn
            // (the capture flow's pixel probe reads these to drive real pointer events). Computes
            // its WHOLE snapshot fresh from the ECS: a FRESH `sectionSpans` call feeds FRESH
            // `computeClips` and `computeBandStrips` calls, so strips and keyframes are projected
            // against the SAME fresh span table — never one fresh and one stale. The previous
            // shape (calling `computeStripKfPts` with the stale `bandStrips`/`spans` `$derived`)
            // read fresh keyframes projected against a stale strip layout — a mixed-freshness
            // snapshot where the returned pixel was not where the diamond was drawn after a strip
            // move/widen changed the bake.
            k.stripKfPx = (): { id: number; x: number; y: number }[] => {
                const rect = canvas.getBoundingClientRect();
                const freshSpans = eid === null ? [] : sectionSpans(ecs, eid);
                const freshStrips = computeBandStrips(freshSpans, ecs);
                return computeStripKfPts(freshStrips, freshSpans, ecs).map((k) => ({
                    id: k.id,
                    x: rect.left + uPx(k.u),
                    y: rect.top + vOf(k.v),
                }));
            };
            // every strip's header-band screen x0/x1, canvas-local like `ghostPx` (not
            // page-absolute like `stripKfPx`) — S3's own capture flow reads these to drive a
            // REAL pointer at a strip's edge/body without re-deriving `uPx`'s projection.
            // Computes fresh from the ECS (same shared `computeBandStrips` call as `stripKfPx`)
            // so a capture flow that just moved/widened a strip reads the current layout, not
            // the stale `$derived`.
            k.stripPx = (): { id: number; x0: number; x1: number }[] => {
                const freshSpans = eid === null ? [] : sectionSpans(ecs, eid);
                return computeBandStrips(freshSpans, ecs).map((s) => ({ id: s.id, x0: uPx(s.u0), x1: uPx(s.u1) }));
            };
            // the track-start one-shot's own glyph screen x (S3), canvas-local like `stripPx` —
            // the capture flow's pixel probe reads this to drive a REAL pointer at the glyph
            // without re-deriving `uPx(uOf(0))`. Always defined regardless of whether the
            // one-shot currently exists (`oneShotGlyphX`'s own reading), so a flow can drive a
            // right-click "Add initial velocity" at the same screen point a later "Delete"
            // right-click lands on.
            k.oneShotPx = (): number => oneShotGlyphX();
            k.oneShotSelected = (): boolean => editor.oneShot;
            // the header band's own hit-classification reads (S3 on-surface naming's own hover
            // partition), exposed so a capture flow can await the geometric PARTITION a pointer
            // move resolves to — never rendered pixels — before probing the fill it paints. Both
            // are plain functions computed fresh from the live `$derived.by` values, not cached
            // behind a settle: `bandHit`'s own kind ("endpoint"/"body"/"empty") is what
            // `render()` reads to choose the fill, so polling THIS is the condition that
            // determines when the paint has anything new to show, immune to a later
            // colour/height re-scheme of the paint itself.
            k.bandHit = (): StripHit => bandHit;
            // the chart's own addressable-span end, on the ACTIVE axis (bounded past a stall in
            // Time, S2, finding 13) — distinct from `tTotal` (main.ts, the bake's unbounded
            // total) precisely so a flow can assert the chart clamps where the bake doesn't.
            k.uTotal = (): number => uTotal;
            // the first-infeasible sample's own axis reading, or null off a feasible bake — the
            // stall the Time lens clamps against (`stallClampU`).
            k.stallU = (): number | null => stallU;
        }
    }
    return () => {
        host.removeEventListener("wheel", onWheel);
        window.removeEventListener("keydown", onKey);
        window.removeEventListener("blur", cancelAll);
        if (import.meta.env.DEV) {
            const k = (window as unknown as { __kex?: Record<string, unknown> }).__kex;
            if (k) {
                delete k.gRange;
                delete k.vRange;
                delete k.xView;
                delete k.domain;
                delete k.forceU;
                delete k.dOf;
                delete k.uOf;
                delete k.dOfTrim;
                delete k.ghostPx;
                delete k.stripKfPx;
                delete k.stripPx;
                delete k.oneShotPx;
                delete k.oneShotSelected;
                delete k.bandHit;
                delete k.uTotal;
                delete k.stallU;
            }
        }
        cancelAll(); // drop any in-flight gesture if we unmount mid-drag
    };
});
</script>

<aside
    class="dock"
    style="height: {DOCK_HEIGHT}px; bottom: {DOCK_INSET}px;"
    onpointerenter={() => (editor.hover = "timeline")}
    onpointerleave={() => (editor.hover = "viewport")}
>
    <!-- the tool rail: a thin icon-only strip on the dock's LEFT edge (the Premiere vertical
         tool-strip precedent) — anatomy of the one earned dock, not a second docked region.
         magnet-only: the snap toggle (lit when on / default, dimmed when off; `S` also toggles,
         Ctrl/Cmd bypasses per-gesture) is the one persistent global authoring toggle with a
         keyboard twin the rail holds. it sits inside the dock's DOM, so it counts as the timeline
         surface for `editor.hover` (the aside's enter/leave already fired). right-click summons
         the magnet's own increments popover (below) — the setting lives on the control it
         governs. The track domain (Meters/Seconds) is picked on the RULER's own context menu, not
         here (the Premiere/REAPER/Cubase reference: time-display format is the ruler's, not a
         standing rail toggle). -->
    <div class="tool-rail" aria-label="Timeline tools">
        <button
            class="rail-tool rail-snap"
            class:on={snapOn}
            class:open={snapPop !== null}
            type="button"
            onclick={toggleSnap}
            oncontextmenu={toggleSnapPop}
            title="Snapping (S)"
            aria-label="Snapping"
            aria-pressed={snapOn}
        >
            <svg viewBox="0 0 16 16" aria-hidden="true">
                <path
                    d="M4 2 L4 8 a4 4 0 0 0 8 0 L12 2 L9.5 2 L9.5 8 a1.5 1.5 0 0 1 -3 0 L6.5 2 Z"
                    fill="currentColor"
                    fill-rule="evenodd"
                />
                <rect x="4" y="2" width="2.5" height="2.2" fill="var(--danger)" />
                <rect x="9.5" y="2" width="2.5" height="2.2" fill="var(--geo)" />
            </svg>
        </button>
    </div>
    <div class="dock-main">
    <div
        class="body"
        class:panning
        bind:this={host}
        bind:clientWidth={w}
        bind:clientHeight={h}
        onpointerdowncapture={(e) => {
            if (e.button === 1) {
                panDown(e);
                e.stopPropagation();
            }
        }}
        oncontextmenu={(e) => e.preventDefault()}
        role="presentation"
    >
        <canvas class="chart" bind:this={canvas}></canvas>
        <svg class="overlay" width={w} height={h}>
            <defs>
                <!-- clip the force diamonds to the inner chart rect so a panned/off-
                     scale point doesn't paint over the ruler or the g-gutter. -->
                <clipPath id="fclip">
                    <rect
                        x={LEFT_GUT}
                        y={TOP}
                        width={Math.max(0, w - LEFT_GUT)}
                        height={Math.max(0, h - BOT_PAD - TOP)}
                    />
                </clipPath>
                <!-- clip the section strip to the marker lane so a panned clip doesn't
                     paint over the g-gutter or past the chart edges. -->
                <clipPath id="laneclip">
                    <rect x={LEFT_GUT} y={RULER_H} width={Math.max(0, w - LEFT_GUT)} height={GAP_H} />
                </clipPath>
                <!-- the pin-mode stripes: the diagonal hatch the pinned section's clip
                     wears while the mode is open (kex2d-optimize-mode stage 5 — the salient
                     in-mode treatment; the old guide ring read as a mystery glyph). -->
                <pattern
                    id="modestripe"
                    width="7"
                    height="7"
                    patternUnits="userSpaceOnUse"
                    patternTransform="rotate(-45)"
                >
                    <line x1="0" y1="0" x2="0" y2="7" class="mode-stripe-line" />
                </pattern>
            </defs>
            <!-- the scrub zone: the whole ruler + gap band. click/drag anywhere here
                 moves the playhead (the distance ruler is the scrubber). height was `TOP`
                 (ruler + gap + the velocity band too, a drift from this comment's own stated
                 scope) until S3 grew the band — a default-centered click then intercepted on
                 the clip strip underneath, so the rect's height now matches the comment it
                 already carried. The velocity band has its own hit surface, `.hbandzone`. -->
            {#if eid !== null && sTotal > 0}
                <rect
                    class="rulerzone"
                    x="0"
                    y="0"
                    width={w}
                    height={RULER_H + GAP_H}
                    onpointerdown={startScrub}
                    onkeydown={stepKey}
                    oncontextmenu={rulerCtx}
                    role="slider"
                    tabindex="0"
                    aria-label="Scrub playhead"
                    aria-valuemin={0}
                    aria-valuemax={Math.round(uTotal * 100) / 100}
                    aria-valuenow={Math.round(uOf(cartS ?? 0) * 100) / 100}
                />
            {/if}
            <!-- the chart is the force-authoring surface (whole-track): double-click over
                 a force section's arc drops a point at that (s, g); a bare click on empty
                 chart deselects. authoring is by cursor position — no section selection
                 needed. the diamonds sit above it. -->
            {#if eid !== null && sTotal > 0}
                <rect
                    class="chartzone"
                    x={LEFT_GUT}
                    y={TOP}
                    width={Math.max(0, w - LEFT_GUT)}
                    height={Math.max(0, h - BOT_PAD - TOP)}
                    ondblclick={chartCreate}
                    onpointerdown={marqueeDown}
                    role="presentation"
                />
            {/if}
            <!-- the section clip strip: one clip per section in the marker lane, kind-
                 colored + labeled, selecting editor.section (the same selection as the
                 viewport span). a force clip's right edge is its extent trim (below). -->
            {#if eid !== null && sTotal > 0}
                <g class="clips" clip-path="url(#laneclip)">
                    {#each clips as c (c.id)}
                        {@const x0 = uPx(c.u0)}
                        {@const x1 = uPx(c.u1)}
                        {@const cw = x1 - x0}
                        {#if x1 >= LEFT_GUT && x0 <= w}
                            {@const isF = c.kind === SectionKind.Force}
                            <rect
                                class="clip {isF ? 'force' : 'geo'}"
                                class:sel={selSections.has(c.id)}
                                class:wash={c.id === washSection}
                                x={x0 + 0.5}
                                y={RULER_H + CLIP_PAD}
                                width={Math.max(1, cw - 1)}
                                height={CLIP_H}
                                rx="2"
                                onpointerdown={(e) => selectClip(e, c)}
                                oncontextmenu={(e) => clipMenu(e, c)}
                                role="button"
                                tabindex="-1"
                                aria-label="{isF ? 'Force' : 'Geo'} section"
                            />
                            {#if cw >= 40}
                                <text
                                    class="clip-label"
                                    class:dim={!isF && tickedSections.has(c.id)}
                                    x={(x0 + x1) / 2}
                                    y={RULER_H + GAP_H / 2}
                                >
                                    {isF ? "Force" : "Geo"}
                                </text>
                            {/if}
                            {#if chromeClip !== null && chromeClip.id === c.id}
                                <!-- the mode's own clip wears the stripes (pointer-inert: a
                                     treatment, not a control — the clip beneath still picks);
                                     held through the landing window (stage 8: chromeClip). -->
                                <rect
                                    class="clip-stripes"
                                    x={x0 + 0.5}
                                    y={RULER_H + CLIP_PAD}
                                    width={Math.max(1, cw - 1)}
                                    height={CLIP_H}
                                    rx="2"
                                />
                            {/if}
                            {#if isF}
                                <rect
                                    class="clip-trim"
                                    class:active={lenId === c.id}
                                    x={x1 - 5}
                                    y={RULER_H + CLIP_PAD}
                                    width="10"
                                    height={CLIP_H}
                                    onpointerdown={(e) => lenDown(e, c)}
                                    role="presentation"
                                    aria-label="Resize force section"
                                />
                            {/if}
                        {/if}
                    {/each}
                </g>
            {/if}
            <!-- the infeasible-speed treatment (S2, finding 13): drawn on the SEGMENT BAR itself,
                 not the event rack below (the person's own read named the rack as the wrong
                 surface) — over the clips, so it reads as a property of the section it falls in.
                 `ghostSpans` is the SAME arclength→px projection the (retired) rack paint and the
                 viewport's own dashed-red pass both read; drawn here as DOM so the dashed stroke
                 comes free of a canvas dash-phase reset per span. Pointer-inert (a treatment, not
                 a control — the clip beneath still picks), like `.clip-stripes`. -->
            {#if eid !== null && sTotal > 0 && ghostSpans.length > 0}
                <g class="ghost-spans" clip-path="url(#laneclip)">
                    {#each ghostSpans as g, i (i)}
                        {@const lo = Math.min(g.x0, g.x1)}
                        {@const hi = Math.max(g.x0, g.x1)}
                        {#if hi >= LEFT_GUT - 1 && lo <= w}
                            {@const gx0 = Math.max(LEFT_GUT, lo)}
                            {@const gw = Math.max(1, Math.min(w, hi) - gx0)}
                            <rect
                                class="ghost-span"
                                x={gx0 + 0.5}
                                y={RULER_H + CLIP_PAD}
                                width={Math.max(1, gw - 1)}
                                height={CLIP_H}
                                rx="2"
                            />
                        {/if}
                    {/each}
                </g>
            {/if}
            <!-- geo node ticks: a small read-only circle per interior node, over the
                 clip strip. no hit-testing (pointer-events off in CSS) — display +
                 selection-highlight only, per the locked decision above. -->
            {#if eid !== null && sTotal > 0 && nodeTicks.length > 0}
                <g class="node-ticks" clip-path="url(#laneclip)">
                    {#each nodeTicks as nt (nt.eid)}
                        {@const x = nt.x}
                        {#if x >= LEFT_GUT - NODE_TICK_R && x <= w + NODE_TICK_R}
                            <circle
                                class="node-tick"
                                class:sel={nt.sel}
                                cx={x}
                                cy={RULER_H + GAP_H / 2}
                                r={NODE_TICK_R}
                            />
                        {/if}
                    {/each}
                </g>
            {/if}
            <!-- the velocity-strip header band (T1): the strip's own body/resize/hit surface.
                 ONE band-wide hit rect routes every press through the pure hit classifier
                 (`bandDown`, `strip-hit.ts`) rather than per-strip DOM hit-testing; the visual
                 strip rects are drawn on the canvas above. Right-click summons the context menu
                 (`bandContext`); left-click on a strip selects + trims/drags; empty space is
                 inert (no create-drag — the rescope that retired C5's rejected idiom). Its own
                 left edge widens past `LEFT_GUT` when the one-shot glyph is flush against it
                 (F6, `bandZoneX0`) — the glyph's hit priority IS this widen, not a JS ordering
                 check alone: `classifyOneShotHit`'s own precedence in `bandDown`/`bandContext`
                 (S3) was already correct but unreachable for the glyph's left half until the
                 rect covering it existed. -->
            {#if eid !== null && sTotal > 0}
                {@const bandX0 = bandZoneX0()}
                <rect
                    class="hbandzone"
                    class:edge-hover={bandHit.kind === "endpoint"}
                    class:body-hover={bandHit.kind === "body"}
                    x={bandX0}
                    y={RULER_H + GAP_H}
                    width={Math.max(0, w - bandX0)}
                    height={STRIP_H}
                    onpointerdown={bandDown}
                    onpointermove={bandHoverMove}
                    onpointerleave={bandHoverLeave}
                    oncontextmenu={bandContext}
                    role="presentation"
                    aria-label="Velocity strips"
                />
            {/if}
            <!-- playhead: a handle in the ruler + a line down through the gap and
                 chart. visual only — the rulerzone above owns the scrub interaction. -->
            {#if playPx !== null}
                <line class="playhead" x1={playPx} x2={playPx} y1={RULER_H} y2={h - BOT_PAD} />
                <polygon
                    class="grip"
                    points="{playPx - 5},{RULER_H - 10} {playPx + 5},{RULER_H - 10} {playPx},{RULER_H}"
                />
            {/if}
            <!-- snap guide flash (Figma alignment guide): a thin line at the axis a drag
                 latched to — vertical for an s-axis snap, horizontal for a g-axis snap.
                 clipped to the chart, shown only while an axis is actively snapped. -->
            <g clip-path="url(#fclip)">
                {#if snapX !== null}
                    <line class="snapguide" x1={LEFT_GUT + snapX} x2={LEFT_GUT + snapX} y1={TOP} y2={h - BOT_PAD} />
                {/if}
                {#if snapY !== null}
                    <line class="snapguide" x1={LEFT_GUT} x2={w} y1={snapY} y2={snapY} />
                {/if}
                <!-- the marquee (box-select) rect: a left-drag over empty chart space, clipped to
                     the chart so it never paints into the marker lane (its targets are the diamonds
                     only). the neutral guide register — a faint fill + a thin border. -->
                {#if marqueeRect}
                    <rect
                        class="marquee"
                        x={marqueeRect.minX}
                        y={marqueeRect.minY}
                        width={marqueeRect.maxX - marqueeRect.minX}
                        height={marqueeRect.maxY - marqueeRect.minY}
                    />
                {/if}
            </g>
            <!-- force points across every force section: a filled diamond at (s, g) —
                 the KEYFRAME idiom (authored input), no drop-line, no driving/driven.
                 an invisible fat hit circle (FHIT_R) carries the grab + hover so the 5px
                 diamond isn't a pixel-hunt (the AE/Unity fat-pick-zone). the visible
                 diamond is inert; the chartzone owns creation. -->
            <g class="fmarkers" clip-path="url(#fclip)">
                {#each forcePts as p (p.id)}
                    {@const mx = ptX(p)}
                    {#if mx >= LEFT_GUT - FHIT_R && mx <= w + FHIT_R}
                        {@const my = yOf(dispG(p))}
                        <!-- in-mode lock styling (kex2d-optimize-mode stage 4): a locked key wears
                             the CAD driven idiom — dashed + faded, still measures (it stays a
                             keyframe the profile reads; the solve just never moves it). free keys
                             keep the normal diamond. -->
                        <g
                            class="fpt"
                            class:sel={selForceSet.has(p.id)}
                            class:active={p.id === selForce}
                            class:driven={optClip !== null &&
                                optClip.id === p.section &&
                                lockedSet.has(p.id)}
                        >
                            <circle
                                class="fhit"
                                cx={mx}
                                cy={my}
                                r={FHIT_R}
                                onpointerdown={(e) => keyframeDown(e, "force", p)}
                                oncontextmenu={(e) => forceCtx(e, p)}
                                role="button"
                                tabindex="-1"
                                aria-label="Force point"
                            />
                            <polygon
                                class="fmarker"
                                points="{mx},{my - FMARKER_R} {mx + FMARKER_R},{my} {mx},{my + FMARKER_R} {mx - FMARKER_R},{my}"
                            />
                        </g>
                    {/if}
                {/each}
            </g>
            <!-- velocity-strip keyframes (T2: value in the graph): diamonds in the velocity
                 channel, drawn for every strip (Locked decision "Visibility"), the selected
                 strip's own keyframes brightening per the same `.sel` rung force keyframes use.
                 `.active` marks the ONE individually-selected keyframe (`editor.stripKf`) —
                 `selForceSet`/`selForce`'s own `.sel`/`.active` split, S3's parity fix (findings
                 10/3): before, every keyframe on the selected strip read `.sel` alike, with no
                 rung distinguishing the one actually grabbed. `.msel` is S4's own addition — a
                 non-active member of the multi-select set (`editor.stripKfs`) bumped one rung
                 over the strip-context `.sel`, so a shift-click block reads distinctly from the
                 rest of the strip's diamonds. Same diamond idiom as force keyframes but on the
                 v-axis (vOf, not yOf). Clipped to the chart. -->
            <g class="fmarkers" clip-path="url(#fclip)">
                {#each stripKfPts as k (k.id)}
                    {@const mx = uPx(k.u)}
                    {#if mx >= LEFT_GUT - FHIT_R && mx <= w + FHIT_R}
                        {@const my = vOf(k.v)}
                        <g
                            class="fpt"
                            class:sel={selStrip !== null && k.strip === selStrip.id}
                            class:active={selStripKfPt !== null && k.id === selStripKfPt.id}
                            class:msel={selStripKfSet.has(k.id) &&
                                (selStripKfPt === null || k.id !== selStripKfPt.id)}
                        >
                            <circle
                                class="fhit"
                                cx={mx}
                                cy={my}
                                r={FHIT_R}
                                onpointerdown={(e) => keyframeDown(e, "strip", k)}
                                role="button"
                                tabindex="-1"
                                aria-label="Velocity keyframe"
                            />
                            <polygon
                                class="fmarker"
                                points="{mx},{my - FMARKER_R} {mx + FMARKER_R},{my} {mx},{my + FMARKER_R} {mx - FMARKER_R},{my}"
                            />
                        </g>
                    {/if}
                {/each}
            </g>
            <!-- the summoned tangent handles of the force keyframe in handle-edit mode: a
                 thin arm from the diamond to each knob (solid = explicit stored offset,
                 hollow = the derived flat ghost). the wide invisible .thit carries the grab;
                 a drag authors the explicit tangent (the force analogue of geo tangent edit). -->
            {#if editHandles}
                {@const eh = editHandles}
                {@const px = ptX(eh.pt)}
                {@const py = yOf(eh.pt.g)}
                <g class="thandles" clip-path="url(#fclip)">
                    {#each eh.handles as hnd (hnd.side)}
                        <line class="tarm" x1={px} y1={py} x2={hnd.x} y2={hnd.y} />
                    {/each}
                    {#each eh.handles as hnd (hnd.side)}
                        <circle
                            class="thit"
                            cx={hnd.x}
                            cy={hnd.y}
                            r={THIT_R}
                            onpointerdown={(e) => tanDown(e, hnd, eh.pt)}
                            role="button"
                            tabindex="-1"
                            aria-label="{hnd.side} handle"
                        />
                        <circle class="tknob" class:ghost={hnd.ghost} cx={hnd.x} cy={hnd.y} r={THANDLE_R} />
                    {/each}
                </g>
            {/if}
            <!-- pin-mode focus (kex2d-optimize-mode stage 4, the standard focus/mode
                 convention): everything outside the pinned section's span dims — lane, curve,
                 and markers alike (the dim is topmost) — while the span itself stays
                 full-strength. pointer-inert: focus is a read. the section's own timeline
                 identity is the striped clip (above); the stamped exit's constraint ring +
                 residual drop-line live in the viewport (render.ts) — the timeline guide's
                 little ring read as noise (the stage-5 feel verdict) and is gone. keyed on
                 chromeClip (stage 8): the dim holds through the landing window. -->
            {#if chromeClip}
                {@const dimY = RULER_H}
                {@const dimH = Math.max(0, h - BOT_PAD - RULER_H)}
                {@const dx0 = Math.min(Math.max(uPx(chromeClip.u0), LEFT_GUT), w)}
                {@const dx1 = Math.min(Math.max(uPx(chromeClip.u1), LEFT_GUT), w)}
                <g class="mode-dim">
                    {#if dx0 > LEFT_GUT}
                        <rect x={LEFT_GUT} y={dimY} width={dx0 - LEFT_GUT} height={dimH} />
                    {/if}
                    {#if dx1 < w}
                        <rect x={dx1} y={dimY} width={w - dx1} height={dimH} />
                    {/if}
                </g>
            {/if}
        </svg>
        <!-- the selected handle's typed (Δs, Δg) fields: the SAME popover surface, summoned at
             the handle knob when a handle is picked (the readout swaps from the keyframe to the
             handle). inert while the handle drags (it's the live readout then). commits go
             through the tangent write path (x-clamp + Aligned coupling). -->
        {#if selHandle}
            <!-- anchored at the SELECTED KNOB, above/below primary — the keyframe popover's
                 reading (`handleTip`): centred on the knob, on the vertical side away from the
                 diamond (an up-pointing handle → above the knob). only an edge that would flip it
                 back over the workspace dodges it horizontally outward instead — the collision
                 fallback, never the default. attention lives where the drag just ended (F3's
                 diamond anchor pulled the eye off the drag; F3b's horizontal side read as a
                 different surface kind than the keyframe popover). frozen during a field scrub. -->
            {@const tip = scrubFreeze?.mode
                ? { x: scrubFreeze.x, y: scrubFreeze.y, mode: scrubFreeze.mode }
                : handleTip(selHandle.x, selHandle.y, yOf(selHandle.pt.g), selHandle.side, w, h)}
            {@const sText = fmt(selHandle.ds, 2)}
            {@const hgText = fmt(selHandle.dg, 2)}
            <div
                class="ptip"
                class:below={tip.mode === "below"}
                class:side-right={tip.mode === "right"}
                class:side-left={tip.mode === "left"}
                class:dragging={dragTan !== null}
                style="left: {tip.x}px; top: {tip.y}px"
            >
                <div class="fld">
                    <span
                        class="key"
                        onpointerdown={(e) => handleScrub(e, "s")}
                        role="presentation">Δs</span
                    >
                    <input
                        type="number"
                        step="0.1"
                        value={sText}
                        onchange={onHandleS}
                        onfocus={(e) => e.currentTarget.select()}
                        onkeydown={(e) => fieldKeydown(e, sText)}
                        aria-label="Handle s offset (m)"
                    />
                    <span class="unit">m</span>
                </div>
                <div class="fld">
                    <span
                        class="key"
                        onpointerdown={(e) => handleScrub(e, "g")}
                        role="presentation">Δg</span
                    >
                    <input
                        type="number"
                        step="0.1"
                        value={hgText}
                        onchange={onHandleG}
                        onfocus={(e) => e.currentTarget.select()}
                        onkeydown={(e) => fieldKeydown(e, hgText)}
                        aria-label="Handle g offset (g)"
                    />
                    <span class="unit">g</span>
                </div>
            </div>
        <!-- the selected point's typed s/g fields: a popover summoned AT the diamond
             (on the object, not a docked row). it follows a live drag as the value
             readout, pointer-inert so it never fights the drag; flips below the point
             near the chart top; clamps inside the chart horizontally. On a MULTI set it
             shows NO single-keyframe context, same as the viewport ring (editor-ui.md
             multi law) — standard multi-select carries no single-subject popover. -->
        {:else if selPoint && !multiForce}
            {@const mx = ptX(selPoint)}
            {#if scrubFreeze !== null || (mx >= LEFT_GUT - FHIT_R && mx <= w + FHIT_R)}
                {@const ax =
                    scrubFreeze?.x ??
                    clamp(mx, LEFT_GUT + TIP_HALF, Math.max(LEFT_GUT + TIP_HALF, w - TIP_HALF))}
                {@const ay = scrubFreeze?.y ?? clamp(yOf(selPoint.g), TOP, h - BOT_PAD)}
                {@const posText = fmt(selPoint.u, 1)}
                {@const gText = fmt(selPoint.g, 2)}
                <div
                    class="ptip"
                    class:below={ay < TOP + TIP_FLIP}
                    class:dragging={dragKf !== null}
                    style="left: {ax}px; top: {ay}px"
                >
                    <div class="fld">
                        <span
                            class="key"
                            onpointerdown={(e) => scrubStart(e, "s")}
                            role="presentation">{posLabel}</span
                        >
                        <input
                            type="number"
                            step={timeDomain ? 0.1 : 1}
                            min={selPoint.startU}
                            value={posText}
                            disabled={selLocked}
                            onchange={onFieldKfS}
                            onfocus={(e) => e.currentTarget.select()}
                            onkeydown={(e) => fieldKeydown(e, posText)}
                            aria-label={timeDomain ? "Point time (s)" : "Point distance (m)"}
                        />
                        <span class="unit">{posUnit}</span>
                    </div>
                    <div class="fld">
                        <span
                            class="key"
                            onpointerdown={(e) => scrubStart(e, "g")}
                            role="presentation">F</span
                        >
                        <input
                            type="number"
                            step="0.1"
                            value={gText}
                            disabled={selLocked}
                            onchange={onFieldKfV}
                            onfocus={(e) => e.currentTarget.select()}
                            onkeydown={(e) => fieldKeydown(e, gText)}
                            aria-label="Point force (g)"
                        />
                        <span class="unit">g</span>
                    </div>
                </div>
            {/if}
        <!-- the selected STRIP keyframe's own typed s/v popover — `selPoint`'s twin (S3, findings
             10/3): selection alone isn't the whole substrate parity, the value has to be SHOWN
             too. No scrub-drag on the labels (force's `scrubStart`); `v` carries its m/s unit
             (S5, Locked decision finding 11 near half) the same `.unit` span the position field
             wears, never a second axis (that's the far half, out of scope). -->
        {:else if selStripKfPt && !multiStripKf}
            {@const mx = uPx(selStripKfPt.u)}
            {#if mx >= LEFT_GUT - FHIT_R && mx <= w + FHIT_R}
                {@const ax = clamp(mx, LEFT_GUT + TIP_HALF, Math.max(LEFT_GUT + TIP_HALF, w - TIP_HALF))}
                {@const ay = clamp(vOf(selStripKfPt.v), TOP, h - BOT_PAD)}
                {@const posText = fmt(selStripKfPt.u, 1)}
                {@const vText = fmt(selStripKfPt.v, 2)}
                <div
                    class="ptip"
                    class:below={ay < TOP + TIP_FLIP}
                    class:dragging={dragKf !== null && dragKf.kind === "strip"}
                    style="left: {ax}px; top: {ay}px"
                >
                    <div class="fld">
                        <span class="key" role="presentation">{posLabel}</span>
                        <input
                            type="number"
                            step={timeDomain ? 0.1 : 1}
                            min={selStripKfPt.startU}
                            value={posText}
                            disabled={selStripKfLocked}
                            onchange={onFieldKfS}
                            onfocus={(e) => e.currentTarget.select()}
                            onkeydown={(e) => fieldKeydown(e, posText)}
                            aria-label={timeDomain ? "Keyframe time (s)" : "Keyframe distance (m)"}
                        />
                        <span class="unit">{posUnit}</span>
                    </div>
                    <div class="fld">
                        <span class="key" role="presentation">v</span>
                        <input
                            type="number"
                            step="0.1"
                            value={vText}
                            disabled={selStripKfLocked}
                            onchange={onFieldKfV}
                            onfocus={(e) => e.currentTarget.select()}
                            onkeydown={(e) => fieldKeydown(e, vText)}
                            aria-label="Keyframe velocity (m/s)"
                        />
                        <span class="unit">m/s</span>
                    </div>
                </div>
            {/if}
        <!-- the one-shot's own typed v popover (F5, Locked decision): the value axis reads/
             edits through the SAME popover surface a strip keyframe uses (one substrate — the
             `.ptip`/`.fld` markup and the begin/set/commit gesture shape, never a parallel
             twin), with the POSITION axis locked: the one-shot lives at `d = 0`
             (`entryOneShot`'s own invariant), so the position field shows the fixed station,
             always `disabled` (never conditioned on `sectionEditable`/pin-mode — locked is
             locked) and carries no `onchange` at all, so a rejected keystroke has nothing to
             route to even if the `disabled` attribute were somehow bypassed. Anchored at the
             glyph's own fixed screen position (`oneShotGlyphX`/`cy`, Timeline's canvas draw) —
             a one-shot has no value-axis curve to project onto, unlike a force/strip keyframe. -->
        {:else if selOneShotPt}
            {@const gx = oneShotGlyphX()}
            {#if gx >= LEFT_GUT - FHIT_R && gx <= w + FHIT_R}
                {@const ax = clamp(gx, LEFT_GUT + TIP_HALF, Math.max(LEFT_GUT + TIP_HALF, w - TIP_HALF))}
                {@const ay = RULER_H + GAP_H + STRIP_H / 2}
                {@const posText = fmt(uOf(0), 1)}
                {@const vText = fmt(selOneShotPt.value, 2)}
                <div class="ptip" class:below={ay < TOP + TIP_FLIP} style="left: {ax}px; top: {ay}px">
                    <div class="fld">
                        <span class="key" role="presentation">{posLabel}</span>
                        <input
                            type="number"
                            value={posText}
                            disabled
                            aria-label={timeDomain
                                ? "One-shot time (locked at track start)"
                                : "One-shot distance (locked at track start)"}
                        />
                        <span class="unit">{posUnit}</span>
                    </div>
                    <div class="fld">
                        <span class="key" role="presentation">v</span>
                        <input
                            type="number"
                            step="0.1"
                            value={vText}
                            disabled={selOneShotLocked}
                            onchange={onFieldOneShotV}
                            onfocus={(e) => e.currentTarget.select()}
                            onkeydown={(e) => fieldKeydown(e, vText)}
                            aria-label="Initial velocity (m/s)"
                        />
                        <span class="unit">m/s</span>
                    </div>
                </div>
            {/if}
        {/if}
        <!-- the append tail: a `+` just past the last clip. clicking opens a two-choice
             geo/force flyout — the one append affordance. hidden when the track end scrolls
             off-screen. -->
        {#if eid !== null && sTotal > 0}
            {@const ax = markerX(sTotal)}
            {#if ax >= LEFT_GUT && ax <= w - 22}
                <div class="clip-append" style="left: {ax + 6}px; top: {RULER_H + GAP_H / 2}px">
                    <button
                        class="clip-add"
                        class:open={appendAnchor !== null}
                        type="button"
                        disabled={optClip !== null}
                        onpointerdown={toggleAppend}
                        title="Append section"
                        aria-label="Append section"
                    >
                        <!-- add section: a plain "+" — the clip-in-a-box mark was unreadable at
                             16px; delineation from add-node comes from the viewport side's
                             segment-and-dot glyph. -->
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                            <path
                                d="M8 3.5 L8 12.5 M3.5 8 L12.5 8"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="1.4"
                                stroke-linecap="round"
                            />
                        </svg>
                    </button>
                </div>
            {/if}
        {/if}
    </div>
    <!-- the time navigator: a full-track overview below the chart (Premiere placement)
         rendered as a preview minimap (VSCode / DAW-overview style) — a miniature of the
         F_n curve with the viewport as a draggable, edge-resizable window. the inner
         track insets by LEFT_GUT so its time axis aligns with the chart above. -->
    <div class="nav" class:idle={navWin === null}>
        <div class="nav-track" bind:this={navEl} style="margin-left: {LEFT_GUT}px">
            <canvas class="nav-canvas" bind:this={navCanvas}></canvas>
            {#if navWin}
                <div
                    class="nav-window"
                    style="left: {navWin.l * 100}%; width: {(navWin.r - navWin.l) * 100}%"
                    onpointerdown={(e) => navDown(e, "pan")}
                    role="presentation"
                >
                    <div class="nav-edge l" onpointerdown={(e) => navDown(e, "l")} role="presentation"></div>
                    <div class="nav-edge r" onpointerdown={(e) => navDown(e, "r")} role="presentation"></div>
                </div>
            {/if}
        </div>
    </div>
    </div>
</aside>

<!-- the player: a standard media transport (play/pause · global scrub · timecode)
     floated as its own surface below the timeline. the slider is the *full-track*
     scrubber — global scope, distinct from the timeline's zoomed-local playhead
     (the After Effects comp-vs-timeline split). controls the cart. -->
<!-- the player floats detached above the dock, but its scrub slider is a timeline-domain
     control (it binds `stepKey`), so it counts as the timeline surface for key routing —
     else its own arrow stepping would break while hovered. -->
<div
    class="player"
    class:idle={eid === null || tTotal <= 0}
    style="bottom: {DOCK_INSET + DOCK_HEIGHT + PLAYER_GAP}px; height: {PLAYER_H}px;"
    onpointerenter={() => (editor.hover = "timeline")}
    onpointerleave={() => (editor.hover = "viewport")}
    role="group"
    aria-label="Playback"
>
    <button
        class="play"
        type="button"
        onclick={togglePlay}
        title={paused ? "Play (Space)" : "Pause (Space)"}
        aria-label={paused ? "Play" : "Pause"}
    >
        {#if paused}
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3 L13 8 L5 13 Z" fill="currentColor" /></svg>
        {:else}
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3 L5.5 13 M10.5 3 L10.5 13" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
        {/if}
    </button>
    <div
        class="scrub"
        bind:this={scrubEl}
        onpointerdown={sliderDown}
        onkeydown={stepKey}
        role="slider"
        tabindex="0"
        aria-label="Playback position"
        aria-valuemin={0}
        aria-valuemax={Math.round(tTotal * 100) / 100}
        aria-valuenow={Math.round((cartSec ?? 0) * 100) / 100}
    >
        <div class="rail"></div>
        <div class="fill" style="width: {frac * 100}%"></div>
        <div class="thumb" style="left: {frac * 100}%"></div>
    </div>
    <span class="time">
        {(cartSec ?? 0).toFixed(2)}<span class="sep">/</span><span class="total">{tTotal.toFixed(2)}s</span>
    </span>
</div>

<!-- the force keyframe context menu (Delete / Easing ▸ / Handles / Reset): summoned by a
     right-click on a diamond (the chart's only right-click subject, `forceCtx`), an instance of
     the shared menu language (Menu.svelte) at the cursor. rendered at the component root so it
     floats over the dock; the same look + placement as the section context menu. -->
{#if fmenu}
    <div class="fmenu menu" use:fitMenu={{ x: fmenu.x, y: fmenu.y }} role="menu" aria-label="Force keyframe">
        <Menu items={fmenuItems} onclose={closeForceMenu} />
    </div>
{/if}

<!-- the ruler context menu (Meters / Seconds — the track domain), summoned by right-clicking
     the ruler scrub zone: the same shared menu language, at the cursor. -->
{#if rmenu}
    <div class="rmenu menu" use:fitMenu={{ x: rmenu.x, y: rmenu.y }} role="menu" aria-label="Track domain">
        <Menu items={rulerMenuItems} onclose={closeRulerMenu} />
    </div>
{/if}

<!-- the velocity-strip band context menu (T1): Add on empty band, Delete on an existing strip. -->
{#if smenu}
    <div class="smenu menu" use:fitMenu={{ x: smenu.x, y: smenu.y }} role="menu" aria-label="Velocity strips">
        <Menu items={stripMenuItems} onclose={closeStripMenu} />
    </div>
{/if}

<!-- the append flyout: the `+`-button's two-choice geo/force menu, root-mounted (out of the
     dock's overflow clip) and viewport-fitted by `fitMenu`, anchored just below the button. -->
{#if appendAnchor}
    <div class="clip-flyout menu" use:fitMenu={appendAnchor} role="menu" aria-label="Append section">
        <Menu items={appendItems} onclose={() => (appendAnchor = null)} />
    </div>
{/if}

<!-- the snap increments: the two manipulator quanta as fields in the shared idiom, summoned by
     right-click on the rail's magnet (Blender's snap popover / Godot's Configure Snap — the
     increments live on the snap control). the `S` toggle and the Ctrl bypass are independent of the
     configured values. root-mounted + `fitMenu` so the dock's clip can't swallow it near the
     bottom edge; the fields commit no undo entry (a per-user preference, not track state). -->
{#if snapPop}
    <div class="snap-pop menu" use:fitMenu={snapPop} role="group" aria-label="Snap increments">
        <!-- the rows clip to the rounded corners on their own wrapper, never on the `.menu` box
             (Menu.svelte's `.menu-rows` split — a clipped menu box swallows a flyout from paint AND
             hit-testing, so the trap doesn't get primed here). -->
        <div class="snap-rows">
            <div class="fld">
                <span class="key" onpointerdown={(e) => snapScrub(e, "angle")} role="presentation">∠</span>
                <input
                    type="number"
                    step="1"
                    min={ANGLE_MIN_DEG}
                    max={ANGLE_MAX_DEG}
                    value={degText}
                    onchange={onSnapDeg}
                    onfocus={(e) => e.currentTarget.select()}
                    onkeydown={(e) => fieldKeydown(e, degText)}
                    aria-label="Snap angle increment (degrees)"
                />
                <span class="unit">°</span>
            </div>
            <div class="fld">
                <span class="key" onpointerdown={(e) => snapScrub(e, "length")} role="presentation">L</span>
                <input
                    type="number"
                    step="0.1"
                    min={LENGTH_STEP_MIN}
                    max={LENGTH_STEP_MAX}
                    value={lenText}
                    onchange={onSnapLen}
                    onfocus={(e) => e.currentTarget.select()}
                    onkeydown={(e) => fieldKeydown(e, lenText)}
                    aria-label="Snap length increment (m)"
                />
                <span class="unit">m</span>
            </div>
        </div>
    </div>
{/if}

<style>
    /* `height` and `bottom` are inline-styled from the DOCK_HEIGHT / DOCK_INSET constants
       (view.ts, the single source the viewport camera also reserves from) — not set here. */
    .dock {
        position: absolute;
        left: 50%;
        transform: translateX(-50%);
        width: calc(100% - 32px);
        max-width: 1280px;
        display: flex;
        flex-direction: row;
        background: var(--bg-solid);
        border: 1px solid var(--border);
        border-radius: 6px;
        box-shadow: var(--shadow);
        font-family: "Outfit", system-ui, sans-serif;
        user-select: none;
        -webkit-user-select: none;
        overflow: hidden;
    }
    /* the timeline content column (ruler/chart + navigator) sits right of the rail; it takes
       the remaining width, and `min-width: 0` lets the canvas body shrink so the rail never
       forces an overflow. the chart/ruler/navigator all size to this column's width. */
    .dock-main {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
    }
    /* the tool rail: a thin icon-only strip on the dock's left edge (the Premiere vertical
       tool-strip precedent). same opaque surface as the dock (its background carries through);
       a right border in the dock's own token demarcates it from the content (one language).
       a column, so a second rail tool would stack under the magnet. */
    .tool-rail {
        flex: none;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
        padding: 6px 4px;
        border-right: 1px solid var(--border);
    }
    /* a rail tool: quiet muted icon by default, accent-lit when on — a persistent editor
       preference, not a loud control (the former viewport-cluster toggle's look). */
    .rail-tool {
        all: unset;
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        border-radius: 4px;
        color: var(--muted);
        cursor: pointer;
        opacity: 0.6;
        transition: opacity 120ms var(--ease-out), color 120ms var(--ease-out), background 120ms var(--ease-out);
    }
    .rail-tool:hover {
        opacity: 0.9;
        background: rgba(255, 255, 255, 0.06);
    }
    .rail-tool.on {
        color: var(--accent);
        opacity: 1;
    }
    /* its increments popover is open: the same held wash the append `+` wears while its flyout is
       up, so the summoned surface reads as belonging to this button. */
    .rail-tool.open {
        opacity: 1;
        background: rgba(255, 255, 255, 0.1);
    }
    .rail-tool svg {
        width: 15px;
        height: 15px;
    }

    /* the selected point's popover: one opaque floating surface anchored to the
       diamond — two field ROWS on a shared column grid (key · value · unit), not
       boxed inputs inside a box (a nested border reads as double chrome). the
       inputs are transparent; focus is a row wash (the floating-input pattern: the
       surface is the field). the key label is the scrub handle (drag to slide, the
       shallot inspector idiom). sits above the point, flips below near the chart
       top; pointer-inert while the point drags (it's the live value readout then,
       not an input surface). */
    .ptip {
        position: absolute;
        z-index: 2;
        display: flex;
        flex-direction: column;
        padding: 3px 0;
        background: var(--bg-solid);
        border: 1px solid var(--border);
        border-radius: 5px;
        box-shadow: var(--shadow);
        overflow: hidden; /* the focus wash clips to the rounded corners */
        transform: translate(-50%, calc(-100% - 12px));
        animation: tip-in 120ms var(--ease-out);
    }
    .ptip.below {
        transform: translate(-50%, 12px);
    }
    /* the handle popover's horizontal DODGE (the collision fallback only): out → right, in →
       left, vertically centred, when an edge would flip the default above/below back over the
       workspace. the default above/below reuse the point popover's `.ptip` / `.ptip.below`. */
    .ptip.side-right {
        transform: translate(12px, -50%);
    }
    .ptip.side-left {
        transform: translate(calc(-100% - 12px), -50%);
    }
    .ptip.dragging {
        pointer-events: none;
    }
    @keyframes tip-in {
        from {
            opacity: 0;
        }
    }
    .fld {
        display: grid;
        grid-template-columns: 16px 48px 12px;
        align-items: center;
        gap: 6px;
        padding: 4px 9px;
        font-family: "JetBrains Mono", ui-monospace, monospace;
        font-size: 11px;
        transition: background 120ms var(--ease-out);
    }
    .fld:focus-within {
        background: rgba(255, 255, 255, 0.04);
    }
    /* the key doubles as the scrub handle (the shallot cell-handle treatment): a
       full-row-height cell whose hit area extends left to the row's edge (the negative
       margin), ew-resize + brighten/wash on hover. the label centers within that whole
       extended box (content-box == border-box, no padding), so the glyph sits at the wash's
       centre — a padding-left offset would keep the glyph at the cell centre but leave the
       hover wash bulging left of it, reading as right-aligned. */
    .fld .key {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        align-self: stretch;
        margin: -4px 0 -4px -9px;
        padding: 4px 0;
        color: var(--muted);
        cursor: ew-resize;
        user-select: none;
        -webkit-user-select: none;
        touch-action: none;
        transition: color 120ms var(--ease-out), background 120ms var(--ease-out);
    }
    .fld .key:hover {
        color: var(--fg);
        background: rgba(255, 255, 255, 0.05);
    }
    .fld:focus-within .key {
        color: var(--fg);
    }
    .fld .unit {
        color: var(--muted);
    }
    .fld input {
        width: 42px;
        box-sizing: border-box;
        padding: 0;
        background: none;
        border: none;
        outline: none;
        color: var(--fg);
        font: inherit;
        font-variant-numeric: tabular-nums;
        text-align: right;
        appearance: textfield; /* no native spinner chrome (it truncates the value); arrow keys still step */
    }
    .fld input::-webkit-outer-spin-button,
    .fld input::-webkit-inner-spin-button {
        -webkit-appearance: none;
        margin: 0;
    }
    .fld input::selection {
        background: var(--accent-soft);
    }

    .body {
        position: relative;
        flex: 1;
        min-height: 0;
    }
    /* grab affordance while middle-drag panning (Blender/AE) — overrides the ruler/chart
       default cursor on the whole body for the duration of the pan. */
    .body.panning,
    .body.panning * {
        cursor: grabbing;
    }

    /* hover suppression while any drag is in flight: `data-dragging` is set on the app root
       (App.svelte) whenever a gesture routes through `beginDrag`. one rule kills
       `pointer-events` on the dock's hoverable chrome, so `:hover` can't fire on a clip /
       button / diamond the cursor sweeps over mid-drag (CSS `:hover` ignores pointer
       capture, so this is the only thing that stops it). the surface actually being dragged
       is unaffected: its gesture listens on `window` and holds pointer capture, which
       bypasses hit-testing. */
    :global([data-dragging]) .clip,
    :global([data-dragging]) .clip-trim,
    :global([data-dragging]) .clip-add,
    :global([data-dragging]) .clip-flyout,
    :global([data-dragging]) .fhit,
    :global([data-dragging]) .thit,
    :global([data-dragging]) .fmenu,
    :global([data-dragging]) .rmenu,
    :global([data-dragging]) .smenu,
    :global([data-dragging]) .nav-window,
    :global([data-dragging]) .ptip,
    :global([data-dragging]) .snap-pop,
    :global([data-dragging]) .play,
    :global([data-dragging]) .rail-tool,
    :global([data-dragging]) .scrub {
        pointer-events: none;
        user-select: none;
    }

    /* time navigator: a preview-minimap overview strip below the chart. dims only
       when there's no track (nothing to preview). */
    .nav {
        flex: none;
        padding: 2px 0 6px;
        transition: opacity 150ms var(--ease-out);
    }
    .nav.idle {
        opacity: 0.4;
    }
    .nav-track {
        position: relative;
        height: 22px;
        background: rgba(0, 0, 0, 0.28);
        border-radius: 3px;
    }
    .nav-canvas {
        position: absolute;
        inset: 0;
        display: block;
        width: 100%;
        height: 100%;
        border-radius: 3px; /* clips the preview curve to the lane's rounded corners */
    }
    /* the viewport window: a translucent highlight over the preview (VSCode-minimap
       style), not a solid block — the curve reads through it. */
    .nav-window {
        position: absolute;
        top: 0;
        bottom: 0;
        min-width: 8px;
        background: rgba(255, 255, 255, 0.07);
        border: 1px solid rgba(255, 255, 255, 0.22);
        border-radius: 3px;
        cursor: grab;
        transition: background 120ms var(--ease-out);
    }
    .nav-window:hover {
        background: rgba(255, 255, 255, 0.12);
    }
    .nav-window:active {
        cursor: grabbing;
    }
    .nav-edge {
        position: absolute;
        top: -2px;
        bottom: -2px;
        width: 7px;
        cursor: ew-resize;
    }
    .nav-edge.l {
        left: -3px;
    }
    .nav-edge.r {
        right: -3px;
    }

    canvas {
        display: block;
        width: 100%;
        height: 100%;
    }

    .overlay {
        position: absolute;
        inset: 0;
        pointer-events: none;
        overflow: visible;
    }

    .playhead {
        stroke: var(--neutral);
        stroke-width: 1.2;
        opacity: 0.9;
    }

    .grip {
        fill: var(--neutral); /* matches the player knob; accent is reserved for the result curve */
        pointer-events: none; /* visual handle; the rulerzone owns the scrub */
    }

    /* the snap guide flash: a thin alignment line at a latched axis (the Figma idiom), in the
       shared snap-guide neutral gray (--guide) — the same register the viewport magnet's
       incline ray wears (feel round 3 retired the magenta stateful/neutral split). */
    .snapguide {
        stroke: var(--guide);
        stroke-width: 1;
        opacity: 0.9;
        pointer-events: none;
    }

    /* the marquee (box-select) rect: the neutral guide register — a faint fill + a thin border,
       the same gray the snap guide wears. visual only; the chartzone owns the gesture. */
    .marquee {
        fill: color-mix(in srgb, var(--guide) 12%, transparent);
        stroke: var(--guide);
        stroke-width: 1;
        pointer-events: none;
    }

    /* the scrub zone: the whole top ruler + gap band. click/drag anywhere here moves
       the playhead. the body keeps the DEFAULT cursor — the editor-ruler convention
       (After Effects / animation-timeline: the ruler is default, not a resize edge). */
    .rulerzone {
        fill: transparent;
        pointer-events: all;
        cursor: default;
    }
    /* keyboard focus rings the playhead grip, not a full-width box on the ruler
       (mirrors the player slider's thumb focus ring). Reset on plain `:focus`, not
       `:focus-visible`: a pointer-triggered focus (a click, a right-click) matches
       `:focus` but NOT `:focus-visible` in Chromium, so a rule scoped to
       `:focus-visible` alone never fires for it — the UA default ring (`outline:
       auto`) then shows regardless, which is the border a right-click was drawing.
       Resetting on `:focus` covers both triggers; the grip ring stays gated on
       `:focus-visible` so only keyboard-driven focus lights it. */
    .rulerzone:focus {
        outline: none;
    }
    .rulerzone:focus-visible ~ .grip {
        stroke: var(--neutral-soft);
        stroke-width: 4;
        paint-order: stroke;
    }

    /* the whole-track force-authoring chart surface: double-click places a point, a bare
       click clears the selection. default cursor (the diamonds carry their own move cursor). */
    .chartzone {
        fill: transparent;
        pointer-events: all;
        cursor: default;
    }

    /* force points: a filled diamond (the keyframe idiom — authored input), light so it
       reads over the accent curve, selected turns accent with a fitted ring. the diamond
       is visual-only; an invisible fat circle around it (FHIT_R) carries the grab + hover
       so the small marker isn't a pixel-hunt. plain arrow cursor — the desktop curve-
       editor convention (AE/Unity/Blender keep the default over keyframes; grab hands are
       for pannable surfaces, the navigator). */
    .fhit {
        fill: transparent;
        pointer-events: all;
        cursor: default;
        outline: none; /* pointer-only (tabindex -1); no browser focus ring on click */
    }
    .fmarker {
        fill: var(--pin);
        stroke: #0e0d0c;
        stroke-width: 1;
        pointer-events: none; /* the fat hit circle owns the interaction */
        transition:
            fill 100ms var(--ease-out),
            stroke 100ms var(--ease-out);
    }
    /* the glyph outline lift (kex2d-idioms 10b): hover keeps the fill lift and lifts the ink
       outline to selection's own stroke token — at the BASE 1px width, where selected wears it
       at 1.4px over the accent fill, so hover reads exactly one rung below (editor-ui.md Kind
       color). never on a stronger register: a selected member keeps the brightened fill, a
       driven key its dash — the lift marks exactly what a plain click would newly take. */
    .fpt:hover:not(.sel):not(.driven) .fmarker {
        fill: #fff;
        stroke: var(--fg);
    }
    .fpt.sel .fmarker {
        fill: var(--accent);
        stroke: var(--fg);
        stroke-width: 1.4;
    }
    /* the ACTIVE member of a multi-selection — the single subject the single-selection popover
       (single selection only; the popover hides on a multi-set) and the single-subject menu rows
       bind to (Blender's active-object model). a brighter ring over the shared selected fill so
       which diamond is active reads at a glance. */
    .fpt.active .fmarker {
        stroke: #fff;
        stroke-width: 1.8;
    }
    /* a non-active member of a strip-keyframe multi-select (S4) — one rung over the strip-context
       `.sel` fill so a shift-clicked block reads distinctly from the rest of the strip's diamonds,
       below `.active`'s brighter ring. */
    .fpt.msel .fmarker {
        stroke: var(--fg);
        stroke-width: 1.6;
    }
    /* the pin-mode locked keyframe (kex2d-optimize-mode stage 4) — the CAD driven idiom
       (editor-ui.md constraint vocabulary): dashed + faded, still measures. the neutral guide
       gray, never accent or a kind color (both already mean something else). selection still
       reads on a locked key (the brightened stroke below), the dash stays — "selected AND
       held". */
    .fpt.driven .fmarker {
        fill: color-mix(in srgb, var(--pin) 25%, transparent);
        stroke: #9aa0a6;
        stroke-dasharray: 2 2;
    }
    .fpt.driven.sel .fmarker {
        fill: color-mix(in srgb, var(--accent) 40%, transparent);
        stroke: var(--fg);
        stroke-dasharray: 2 2;
    }
    /* the pin-mode focus dim: the standard focus convention — outside the pinned span
       everything steps back one rung. a wash of the dock's own background, topmost, inert. */
    .mode-dim rect {
        fill: var(--dim);
        pointer-events: none;
    }
    /* the pin-mode clip stripes: the diagonal hatch the pinned section's clip wears
       while the mode is open — the salient timeline identity of the mode (the accent register,
       since the mode's subject is always a force section). pointer-inert: a treatment, not a
       control. the pattern lives in the svg defs (`#modestripe`). */
    .clip-stripes {
        fill: url(#modestripe);
        pointer-events: none;
    }
    .mode-stripe-line {
        stroke: var(--accent);
        stroke-width: 2.5;
        opacity: 0.55;
    }

    /* the summoned tangent handles on the edited force keyframe (the force analogue of the
       geo tangent-edit handles): a thin accent arm to each knob, a filled knob when the
       handle is explicit / hollow when it's the derived (ghost) flat tangent. the wide
       invisible .thit carries the grab. no cursor change: a handle states hover through color
       (`editor-ui.md`'s hover rung), the same as every other point glyph. */
    .tarm {
        stroke: var(--accent);
        stroke-width: 1;
        opacity: 0.65;
        pointer-events: none;
    }
    .thit {
        fill: transparent;
        pointer-events: all;
        outline: none; /* pointer-only (tabindex -1); no browser focus ring on click */
    }
    .tknob {
        fill: var(--accent);
        stroke: #0e0d0c;
        stroke-width: 1;
        pointer-events: none; /* the fat hit circle owns the interaction */
        transition: stroke 100ms var(--ease-out);
    }
    /* the knob is pickable through its fat .thit sibling, so it wears the same outline lift
       every pickable glyph does (kex2d-idioms 10b). knobs carry no fill lift — the outline
       lift alone is their hover read (the ghost knob's accent stroke lifts the same way). */
    .thit:hover + .tknob {
        stroke: var(--fg);
    }
    .tknob.ghost {
        fill: transparent;
        stroke: var(--accent);
        stroke-width: 1.4;
    }

    /* the section clip strip: one clip per section in the marker lane, kind-colored
       (geo = cool blue `--geo`, force = accent gold `--accent` — the same kind-color
       language the viewport track polyline draws, `colors.ts` on the canvas side).
       hover brightens the fill; the selected clip fills + strokes a brightened analog of
       its own kind color (`--geo-sel`/`--accent-sel`, the color-mix twin of colors.ts
       `selected()`) — the Ableton/Premiere selected-clip idiom, not a flat accent recolor. */
    .clip {
        pointer-events: all;
        cursor: pointer;
        stroke: transparent;
        stroke-width: 1;
        outline: none; /* pointer-only (tabindex -1); no browser focus ring on click */
        transition: fill 120ms var(--ease-out), stroke 120ms var(--ease-out);
    }
    .clip.geo {
        fill: color-mix(in srgb, var(--geo) 28%, transparent);
    }
    .clip.force {
        fill: color-mix(in srgb, var(--accent) 28%, transparent);
    }
    .clip.geo:hover {
        fill: color-mix(in srgb, var(--geo) 42%, transparent);
    }
    .clip.force:hover {
        fill: color-mix(in srgb, var(--accent) 42%, transparent);
    }
    .clip.geo.sel {
        fill: color-mix(in srgb, var(--geo-sel) 60%, transparent);
        stroke: var(--geo-sel);
    }
    .clip.force.sel {
        fill: color-mix(in srgb, var(--accent-sel) 60%, transparent);
        stroke: var(--accent-sel);
    }
    /* the owning-section context wash: when a node is selected, its section's clip lifts to
       a quiet standing highlight — the section-context read (which clip the selection lives
       in), a step below the selected-clip state (a lighter fill, no stroke): the node is the
       accent, the clip is context. `:not(:hover)` yields to hover feedback. geo-only in
       practice — nodes live in geo sections. */
    .clip.geo.wash:not(:hover) {
        fill: color-mix(in srgb, var(--geo) 44%, transparent);
    }
    /* the infeasible-speed treatment (S2, finding 13): a dashed red border over a translucent
       red wash, on the segment bar itself — `--danger` (#e26d5c) IS `colors.ts`'s
       `COLOR_INFEASIBLE`, the canvas-side register the viewport's own dashed-red pass uses, so
       this is the same red read on both surfaces. pointer-inert, over the clip fills. */
    .ghost-span {
        fill: color-mix(in srgb, var(--danger) 32%, transparent);
        stroke: var(--danger);
        stroke-width: 1.5;
        stroke-dasharray: 4 3;
        pointer-events: none;
    }
    /* geo node ticks: a small circle per interior node, distinct from the force
       diamond's shape (circle vs. polygon) AND its kind color (geo blue vs. accent
       gold — the same kind-color language `.clip.geo`/`.clip.force` above use).
       read-only: no pointer-events, so it can never be hit-tested or dragged (the
       locked decision — a node's arclength is derived from geometry). the selected
       node's tick lifts to `--geo-sel`, the same brightened-own-color idiom the
       selected clip uses (`colors.ts` `selected()`), never a flat accent recolor. */
    .node-tick {
        fill: var(--geo);
        stroke: #0e0d0c;
        stroke-width: 1;
        pointer-events: none;
    }
    .node-tick.sel {
        fill: var(--geo-sel);
        stroke: var(--fg);
        stroke-width: 1.4;
    }
    .clip-label {
        fill: var(--fg);
        opacity: 0.72;
        font-family: "Outfit", system-ui, sans-serif;
        font-size: 10px;
        text-anchor: middle;
        dominant-baseline: central;
        pointer-events: none;
        user-select: none;
    }
    /* a shaped geo clip's ticks carry its identity, so its word label fades to a faint
       kind-hint instead of colliding with the ticks drawn over the same centered spot
       (stage-2 note). */
    .clip-label.dim {
        opacity: 0.3;
    }
    /* a force clip's right edge is its extent trim: a wide invisible hit strip over the
       boundary carrying the ew-resize affordance and a faint accent wash on hover/drag. */
    .clip-trim {
        fill: transparent;
        pointer-events: all;
        cursor: ew-resize;
        transition: fill 100ms var(--ease-out);
    }
    .clip-trim:hover,
    .clip-trim.active {
        fill: color-mix(in srgb, var(--accent) 40%, transparent);
    }

    /* the velocity-strip header band hit zone (T1): transparent, captures pointer events for
       the band-wide hit classifier. The visual strips are drawn on the canvas. Cursor stays
       `default` over empty band space (deliberately inert, no create-drag). A span BODY gets
       the same pointer affordance a segment clip carries (S4, finding 1: the declared-registry
       extension, below) alongside the hover-rung fill highlight, never instead of it —
       `body-hover` mirrors `bandHit.kind === "body"` live. A span EDGE carries its own
       affordance too (S5, finding 2), `.clip-trim`'s own treatment on the force-section extent
       trim — `edge-hover` mirrors `bandHit.kind === "endpoint"`. */
    .hbandzone {
        fill: transparent;
        pointer-events: all;
        cursor: default;
    }
    .hbandzone.body-hover {
        cursor: pointer;
    }
    .hbandzone.edge-hover {
        cursor: ew-resize;
    }

    /* the append tail: a small `+` past the last clip that opens a two-choice geo/force
       flyout (the same opaque floating-surface treatment as the popover). */
    .clip-append {
        position: absolute;
        z-index: 3;
        transform: translateY(-50%);
    }
    .clip-add {
        all: unset;
        box-sizing: border-box;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        border-radius: 3px;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid var(--border);
        color: var(--muted);
        cursor: pointer;
        transition: background 120ms var(--ease-out), color 120ms var(--ease-out);
    }
    .clip-add svg {
        width: 12px;
        height: 12px;
    }
    .clip-add:hover,
    .clip-add.open {
        background: rgba(255, 255, 255, 0.12);
        color: var(--fg);
    }
    /* grayed under the lockdown (no section add while an pin session is open) — the
       standard disabled affordance, matching the menu rows. */
    .clip-add:disabled {
        opacity: 0.4;
        cursor: default;
    }
    .clip-add:disabled:hover {
        background: rgba(255, 255, 255, 0.06);
        color: var(--muted);
    }
    /* the append flyout: an instance of the shared `.menu` language, root-mounted and placed by
       `fitMenu` (left/top written by the action) — the same fixed-position, viewport-flipping
       treatment as the force keyframe menu, so the dock's `overflow: hidden` can't clip it. */
    .clip-flyout {
        position: fixed;
        min-width: 62px;
        z-index: 10;
        animation: tip-in 120ms var(--ease-out);
    }

    /* the snap-increment popover: the shared `.menu` surface hosting two `.fld` rows (the field
       idiom — key · value · unit, transparent inputs, a focus row wash), root-mounted and fixed
       like the append flyout so the dock's clip can't swallow it. */
    .snap-pop {
        position: fixed;
        z-index: 10;
        animation: tip-in 120ms var(--ease-out);
    }
    /* the rows carry the corner clip (so the focus wash rounds) and the surface's own inner pad —
       the `.menu` box above stays `overflow: visible`, per the menus law. */
    .snap-rows {
        padding: 3px 0;
        border-radius: inherit;
        overflow: hidden;
    }
    /* the `.menu` surface suppresses selection for menu rows; a field's number is text the author
       drags across and retypes, so it opts back in. */
    .snap-pop input {
        user-select: text;
        -webkit-user-select: text;
    }

    /* the force keyframe context menu: an instance of the shared `.menu` language at the
       cursor (the same fixed-position placement as the section context menu). min-width so
       the rows + check + the submenu marker don't jostle; its own entrance fade. */
    .fmenu {
        position: fixed;
        z-index: 10;
        min-width: 132px;
        animation: tip-in 120ms var(--ease-out);
    }

    /* the ruler context menu (Meters / Seconds): the same instance, narrower — two flat rows,
       no submenu marker to leave room for. */
    .rmenu {
        position: fixed;
        z-index: 10;
        min-width: 104px;
        animation: tip-in 120ms var(--ease-out);
    }
    .smenu {
        position: fixed;
        z-index: 10;
        min-width: 120px;
        animation: tip-in 120ms var(--ease-out);
    }

    /* the player: a media transport (play · global scrub · timecode) floated as its
       own opaque surface above the timeline — narrower than the dock and clearly
       detached, a player over its scrubber-timeline. elevation from border + shadow. */
    /* `bottom` is inline-styled from DOCK_INSET + DOCK_HEIGHT + PLAYER_GAP (it floats a
       fixed gap above the dock's top edge) — the same dock constants, one source. */
    .player {
        position: absolute;
        left: 50%;
        transform: translateX(-50%);
        width: min(calc(100% - 32px), 560px);
        box-sizing: border-box;
        /* height inline-styled from PLAYER_H (view.ts) */
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 0 14px 0 7px;
        background: var(--bg-solid);
        border: 1px solid var(--border);
        border-radius: 6px;
        box-shadow: var(--shadow);
        font-family: "Outfit", system-ui, sans-serif;
        user-select: none;
        -webkit-user-select: none;
    }
    /* no track → the player goes quiet, not loud (gate 2) */
    .player.idle {
        opacity: 0.45;
        pointer-events: none;
    }

    .play {
        all: unset;
        box-sizing: border-box;
        width: 26px;
        height: 26px;
        flex: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        color: var(--neutral);
        cursor: pointer;
        transition: background 120ms var(--ease-out), transform 80ms var(--ease-out);
    }
    .play:hover {
        background: var(--neutral-soft);
    }
    .play:active {
        background: var(--neutral-soft);
        transform: scale(0.94);
    }
    .play svg {
        width: 15px;
        height: 15px;
    }

    /* global scrubber: a thin rail + neutral fill + grabbable thumb. the 26px-tall
       row is a fat hit area over a 3px rail. */
    .scrub {
        position: relative;
        flex: 1;
        height: 26px;
        display: flex;
        align-items: center;
        cursor: pointer;
        touch-action: none;
    }
    .rail,
    .fill {
        position: absolute;
        top: 50%;
        height: 3px;
        border-radius: 999px;
        transform: translateY(-50%);
        pointer-events: none;
    }
    .rail {
        left: 0;
        right: 0;
        background: rgba(255, 255, 255, 0.12);
    }
    .fill {
        left: 0;
        background: var(--neutral);
    }
    .thumb {
        position: absolute;
        top: 50%;
        width: 11px;
        height: 11px;
        border-radius: 50%;
        background: var(--neutral);
        border: 2px solid var(--bg-solid);
        transform: translate(-50%, -50%);
        transition: transform 100ms var(--ease-out);
        pointer-events: none;
    }
    .scrub:hover .thumb,
    .scrub:active .thumb {
        transform: translate(-50%, -50%) scale(1.3);
    }
    .scrub:focus-visible {
        outline: none;
    }
    .scrub:focus-visible .thumb {
        box-shadow: 0 0 0 3px var(--neutral-soft);
    }

    .time {
        flex: none;
        font-family: "JetBrains Mono", ui-monospace, monospace;
        font-size: 11px;
        letter-spacing: -0.02em;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        color: var(--fg);
    }
    .time .sep {
        color: var(--muted);
        margin: 0 0.4em; /* breathing room around the slash */
    }
    .time .total {
        color: var(--muted);
    }
</style>
