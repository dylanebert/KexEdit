<script lang="ts">
import type { State } from "@dylanebert/shallot";
import { onMount, untrack } from "svelte";
import {
    cartState,
    forceCurve,
    parkAtArc,
    parkFromTime,
    playheadPosition,
    trackMapping,
    velocityCurve,
} from "./cart";
import { COLOR_VELOCITY, kindSegments } from "./colors";
import Menu from "./Menu.svelte";
import { BINDINGS, bound, fitMenu, type MenuItem } from "./menu";
import { appendMenu, keyframeMenu, rulerMenu } from "./menus";
import {
    activateForce,
    beginDrag,
    closeForceMenu,
    closeRulerMenu,
    editor,
    endDrag as endDragGesture,
    enterForceEdit,
    exitForceEdit,
    landingG,
    lockLabel,
    modeChromeSection,
    openContext,
    skipLanding,
    openForceMenu,
    openRulerMenu,
    selectForce,
    selectForceHandle,
    selectForces,
    selectSection,
    snapActive,
    toggleSnap,
} from "./editor";
import {
    appendSection,
    beginForceMove,
    beginForceMoves,
    beginForceTangent,
    beginLength,
    cancel,
    commit,
    commitLength,
    createForce,
    history,
    materializeCustom,
    setForcesEase,
    setForceTangentMode,
} from "./history";
import { forceKeyAct } from "./keys";
import { redoRouted, undoRouted } from "./pin";
import { convertDomain, pickable } from "./domain";
import { Domain } from "./section";
import {
    clampDelta,
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
    nudgeForces,
    pxToU,
    S_GRID,
    snap,
    snapAxis,
    snapCutToPlayhead,
    uToPx,
    T_GRID,
    ticks,
    timeToArc,
    trimTargets,
    uToD,
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
import { autoTangent, Easing, type ForcePoint, type Offset, sampleForce, segmentControls, segmentSeed } from "./profile";
import { TangentMode } from "./spline";
import {
    bakeOut,
    forceEase,
    type ForceTangent,
    forceTangent,
    Handle,
    minForceExtent,
    SectionKind,
    sectionCutAt,
    sectionForces,
    sectionHandles,
    sectionInfo,
    sections,
    sectionSpans,
    setForcePoint,
    setForceTangent,
    setSectionLength,
    stationTaken,
    toGlobalU,
    trackDomain,
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
// the chart's axis IS the track's own domain (`Track.domain`) — the unit the force store is
// written in, so there is no view copy to disagree with it and no fallback: whatever unit the
// keyframes hold is the unit the chart must read. Tick-derived, so it lags the document by a frame
// — which is why the pick's own re-frame is deferred to the frame this re-derives in (`pickDomain`)
// instead of writing `view` live.
//
// The pick flips it (`domain.convertDomain`), converting the store in the same entry, and the bake
// re-runs on the same frame (`Track.domain` is in `bakeHash`), so a frame drawing the new unit
// against the pre-flip time table is coherent either way: that table is the one the conversion
// itself ran through, so every converted keyframe, extent, and section entry agrees with it.
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
const TOP = RULER_H + GAP_H; // chart top
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
const NODE_TICK_R = 3; // px; a geo section's read-only node-tick circle radius (visual)
const FHIT_R = 12; // px; the invisible grab/hover radius around a force point (fat pick zone)
const TIP_HALF = 52; // px; half the popover's width — clamps a knob/point-centred popover inside the chart
const TIP_FLIP = 64; // px; a point nearer than this to the chart top flips the popover below
const TIP_W = 108; // px; the popover's full width — the handle popover's horizontal dodge flips outward side when it would clip
const TIP_GAP = 12; // px; the popover's offset from its anchor (the same gap the point popover uses vertically)
const TIP_VHALF = 28; // px; half the popover height — the vertical clamp for a side-dodged handle popover
const TIP_H = 2 * TIP_VHALF; // px; the popover's full height — the vertical fit test for the above/below default
// arrow-nudge steps for the selected force point (AE): position in the track domain's unit
// (metres or seconds — `Force.s` is whatever the store holds), g in g, Shift coarse. The position
// steps are the same NUMBERS in either domain, deliberately: a nudge steps the popover field's own
// displayed precision (one decimal, `fmt(…, 1)`), which is what makes every press visible in the
// readout, and 10× that with Shift. So a fine step is 0.1 m of arclength or 0.1 s — the latter is
// exactly one `T_GRID` placement quantum, the former a tenth of `S_GRID`'s.
const NUDGE_S = 0.1;
const NUDGE_S_COARSE = 1;
const NUDGE_G = 0.05;
const NUDGE_G_COARSE = 0.5;
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
// the chart's x is the coordinate `u` on the track's own axis: global distance d in
// `Domain.Distance`, global march time t in `Domain.Time`. The force store is written on THAT
// axis, so every force path — placement, drag, extent, field — is native here and reads `u`
// directly through the lens's affine (`track.toGlobalU`, `entryU + s`), with no projection at all.
// What projects is the other kind of subject: a quantity authored in ARCLENGTH shown on a time
// axis — the recovered force curve, a geo section's node ticks, the cart's park (`uOf`/`dOf`,
// identity in the distance domain). Nothing downstream branches on the domain again, bar the
// sanctioned constant picks (the `GRID` quantum, the `mFloor` lead-out, the unit suffix).
const uOf = (d: number): number => dToU(mapping, domain, d);
const dOf = (u: number): number => uToD(mapping, domain, u);
// the addressable span's end and the lead-out floor, both in axis units.
const uTotal = $derived(uOf(sTotal));
const mFloor = $derived(marginFloor(domain));
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
        if (dragForce !== null || draggingLen || dragTan !== null) {
            yHeld = true;
            if (dragForce !== null) growValueAxis(dragCy, applyDrag);
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
    convertDomain(history, ecs, target); // rejects (writing nothing) on the active row and with
    // nothing convertible — the same reading the row is grayed on
}
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
// `history`. force points are authored section-local (s from the section entry, in the track
// domain's unit), and the chart's x-axis is that same unit whole-track, so a point draws at its
// section's entry + its local s — the lens's affine (`track.toGlobalU`), never a projection.
//
// the coordinate lens's span table (track.ts): each section's entry + extent on BOTH axes —
// arclength (the geometry readouts) and the track's native unit (the force store's own). the ONE
// source for every global readout on the chart — boundaries, clips, and force-keyframe placement
// all derive from it, none re-walks the baked ds.
const spans = $derived.by(() => {
    void tick;
    return eid === null ? [] : sectionSpans(ecs, eid);
});
// the interior section boundaries on the chart's own axis — drawn as chart guides, and the
// landmarks every s-axis snap resolves against. each non-last span's native exit
// (`entryU + lenU`), so a boundary needs no projection in either domain.
const bounds = $derived.by((): number[] => spans.slice(0, -1).map((sp) => sp.entryU + sp.lenU));
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
    u0: number; // the section entry on the CHART's axis (`entryU`) — where its clip and its
    u1: number; // keyframes are placed, and its exit (`entryU + lenU`)
    len: number; // authored extent (force `Section.length`, in the track domain's unit) — the
    // clamp domain for its keyframes and the subject of the extent trim
}
const clips = $derived.by((): Clip[] => {
    void tick;
    const byId = new Map(spans.map((sp) => [sp.id, sp]));
    const res: Clip[] = [];
    for (const sec of sections(ecs)) {
        const sp = byId.get(sec.id);
        if (!sp) continue;
        res.push({
            id: sec.id,
            kind: sec.kind,
            s0: sp.offset,
            s1: sp.offset + sp.len,
            u0: sp.entryU,
            u1: sp.entryU + sp.lenU,
            len: sec.length,
        });
    }
    return res;
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
    s: number; // section-local position, in the track domain's unit (metres or seconds)
    g: number;
    u: number; // its global coordinate on the chart's axis — the lens's own affine
    startU: number; // the section's entry on that axis (the base the drag/field arithmetic uses)
    len: number; // the section's authored extent (drag/field clamp domain), same unit as `s`
}
const forcePts = $derived.by((): ForcePt[] => {
    void tick;
    if (eid === null) return [];
    const res: ForcePt[] = [];
    for (const c of clips) {
        if (c.kind !== SectionKind.Force) continue;
        for (const p of sectionForces(ecs, c.id)) {
            const u = toGlobalU(spans, c.id, p.s);
            // unreachable today (`clips` is built from the same `spans`), but a stale span
            // dropping a point for one frame beats painting it at NaN.
            if (u === null) continue;
            res.push({ id: p.id, section: c.id, s: p.s, g: p.g, u, startU: c.u0, len: c.len });
        }
    }
    return res;
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
$effect(() => {
    if (editor.force !== null && selPoint === null) selectForce(null);
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
// a force keyframe's chart x — its global axis coordinate, straight off the lens's affine.
const ptX = (p: ForcePt): number => uPx(p.u);

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
// because a station one of them occupies is a landing the write refuses (`track.stationTaken`),
// and a gesture never snaps to a target it can't reach (editor-ui.md Snapping — the same law
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
    const s = clamp(u - c.u0, 0, c.len); // (snapped) global → section-local, both native
    selectForce(createForce(history, ecs, c.id, s, sampleForce(sectionForces(ecs, c.id), s)));
}

// drag a diamond in both axes (horizontal = s, vertical = g), one undo entry. the
// last cursor position is kept in canvas space so the per-frame edge-grow (the
// yView effect's drag branch) can re-map it through a grown axis. Shift is a no-op on a
// force-keyframe drag: the per-axis gesture-start magnet is the "change just one axis"
// affordance, so a dominant-axis lock is redundant here (removed 2026-07-23).
let dragForce: number | null = $state(null); // the ANCHOR point id (snap resolves on it)
// the cursor's axis coordinate at pointerdown — the origin the anchor's position is measured
// DELTA-FROM (`s = s0 + (u − u0)`), so grabbing a diamond off-centre doesn't jump it and a gesture
// returned to its grab pixel writes its start value back bit-exactly. The store is on this same
// axis, so the arithmetic is exact: there is no projection to lose an ulp in.
let dragU0 = 0;
let dragStartU = 0; // the ANCHOR's section entry on the axis (fixed during the drag)
let dragSection = -1; // the ANCHOR's section — the scope its own keys are unreachable within
let dragLen = 0; // the ANCHOR's section extent (the anchor's own s clamp domain)
let dragCx = 0; // last cursor, canvas-local px
let dragCy = 0;
let dragMod = false; // Ctrl/Cmd held (live) — the snap bypass modifier
let dragS0 = 0; // the grab s / g — each axis's gesture-start landmark (always-on magnet)
let dragG0 = 0;
// the dragged SET, captured at gesture start: every selected member's start s/g + its own section
// extent (the rigid-clamp bounds). single-select is the size-1 case (just the anchor). the whole
// set moves by ONE shared (Δs, Δg) — relative offsets preserved exactly — resolved on the anchor.
let dragMembers: { id: number; s0: number; g0: number; len: number; section: number }[] = [];
// the last shared Δs that LANDED — what the block holds at when the next step would put a member
// on an occupied station, so the group stops as one instead of tearing (the rigid-clamp law).
let dragLastDs = 0;
let dragMemberSet: Set<number> = new Set(); // the member ids, so the snap excludes every moving point
function applyDrag(): void {
    if (dragForce === null) return;
    // both axes clamp the cursor to the chart: the view never moves under a drag,
    // so past an edge the point rides it (y follows only as the edge-grow expands).
    const cx = clamp(dragCx, LEFT_GUT, Math.max(LEFT_GUT, w));
    // resolve the ANCHOR through the snap first (grid + landmarks + the gesture-start axis magnet),
    // exactly as a single drag does — the shared delta then derives from where the anchor lands and
    // the OTHER members follow it. the cursor's axis delta from the grab origin IS the anchor's
    // delta (one axis, one unit), clamped to the anchor's own [0, len].
    let sAnchor = clamp(dragS0 + (uAtPx(cx) - dragU0), 0, dragLen);
    let gAnchor = yToG(clamp(dragCy, TOP, h - BOT_PAD));
    snapX = null;
    snapY = null;
    const active = snapActive(dragMod);
    {
        // the candidate and every landmark resolve on the chart's axis, so the grid quantum is the
        // domain's own (`GRID` — metres of arclength, or `T_GRID` seconds), and the winning value
        // is already in the store's unit: `− startU` is the whole write path.
        const uAnchor = dragStartU + sAnchor;
        const targets = sTargets({
            exclude: dragMemberSet,
            sameSection: dragSection,
            playhead: true,
            trackEnd: true,
        });
        const startPx = uToPx(clamped, dragStartU + dragS0); // gesture-start landmark
        const r = snapAxis(active, uToPx(clamped, uAnchor), uAnchor, targets, GRID, (px) =>
            pxToU(clamped, px), startPx);
        if (r.guide !== null) {
            // the gesture-start magnet resolves to the GRAB VALUE, never a px round-trip: the
            // round-trip drops the last ulp, so a gesture returned to its start has to land on
            // exactly the s it began at — else a zero-delta drag writes a difference and records
            // an undo entry.
            const local = r.guide === startPx ? dragS0 : r.value - dragStartU;
            // a landmark: only latch one the anchor can actually reach in its own section
            if (local >= 0 && local <= dragLen) {
                sAnchor = local;
                snapX = r.guide;
            }
        } else {
            // grid (or bypass) — quantized in the active domain, kept in the section
            sAnchor = clamp(r.value - dragStartU, 0, dragLen);
        }
    }
    {
        const targets = gTargets(dragMemberSet);
        const startPy = yOf(dragG0); // gesture-start landmark
        const r = snapAxis(active, yOf(gAnchor), gAnchor, targets, G_GRID, (py) => yToG(py), startPy);
        // the same exact-grab rule as the s axis above: the start magnet resolves to the grabbed
        // g, not `yToG(yOf(g))` — that round-trip loses the last ulp, so a gesture returned to its
        // start wrote a g one ulp off its own and recorded an undo entry for a no-op.
        gAnchor = r.guide === startPy ? dragG0 : r.value;
        snapY = r.guide;
    }
    // the shared delta from the anchor's resolved position, then the RIGID group clamp: Δs shrinks
    // so every member stays in its own [0, len] (the tightest binds — AE comp-start block). when the
    // clamp overrides the anchor's own s-snap the block has hit a wall, so drop the guide. g is
    // unbounded, so its shared delta and guide pass through. the single-member case never clamps
    // (the anchor already sits in its own bounds), so it stays byte-identical to today.
    const dsRaw = sAnchor - dragS0;
    const dg = gAnchor - dragG0;
    const ds = clampDelta(
        dragMembers.map((m) => ({ s: m.s0, len: m.len })),
        dsRaw,
    );
    if (ds !== dsRaw) snapX = null;
    // the station refusal, applied to the BLOCK: `setForcePoint` refuses a taken station per key,
    // which would tear a multi-drag apart (one member holding while the rest move breaks the
    // offsets-preserved-exactly law). So the whole step is tested first and the block holds at the
    // last landed Δs — the tightest member stops the block, exactly as the rigid clamp does. A
    // single-member drag degenerates to the same thing: its one member IS the tightest.
    const landed = dragMembers.every(
        (m) => !stationTaken(ecs, m.section, clamp(m.s0 + ds, 0, m.len), m.id),
    );
    if (landed) dragLastDs = ds;
    else snapX = null; // the block is against an occupied slot, not on a landmark
    const dsWrite = landed ? ds : dragLastDs;
    for (const m of dragMembers)
        setForcePoint(ecs, m.id, clamp(m.s0 + dsWrite, 0, m.len), m.g0 + dg);
}
// double-press detection for the diamond summon: a keyframe drag captures the pointer on
// pointerdown, which retargets the compatibility `dblclick` off the diamond (onto the canvas),
// so the summon is detected here by timing on the second press — the diamond hit beats the
// chart's insertion double-click. mirrors geo's double-click tangent-edit summon.
const FDBL_MS = 300;
let lastFdownT = 0;
let lastFdownId = -1;
function forceDown(e: PointerEvent, p: ForcePt): void {
    if (e.button !== 0) return; // left-only drag; right opens the keyframe menu
    e.preventDefault();
    e.stopPropagation(); // don't also deselect via the chartzone below
    // shift-click TOGGLES set membership (the consensus grammar) — a selection gesture, not a drag.
    if (e.shiftKey) {
        selectForce(p.id, "toggle");
        return;
    }
    if (lastFdownId === p.id && e.timeStamp - lastFdownT < FDBL_MS) {
        lastFdownT = 0;
        lastFdownId = -1;
        // second press on the same diamond → summon its handles (single-subject). handle edit
        // is an editing surface, so the lockdown gates the summon like every other edit.
        if (sectionEditable(editor.pinning, p.section)) enterForceEdit(p.id);
        return;
    }
    lastFdownT = e.timeStamp;
    lastFdownId = p.id;
    // grabbing a MEMBER of a multi-set keeps the set and drags the whole block (p becomes the active
    // anchor); grabbing a non-member replace-selects just it (single drag) — the standard
    // clicked-selected-vs-unselected rule.
    if (editor.forces.ids.has(p.id)) activateForce(p.id);
    else selectForce(p.id);
    // the lockdown: another section's keys still SELECT (selection is a read) but never drag.
    if (!sectionEditable(editor.pinning, p.section)) return;
    // the drag set: every selected member's start s/g + its own extent (size-1 for a single drag).
    const set = editor.forces.ids;
    const members = set.size > 1 ? forcePts.filter((fp) => set.has(fp.id)) : [p];
    dragMembers = members.map((fp) => ({
        id: fp.id,
        s0: fp.s,
        g0: fp.g,
        len: fp.len,
        section: fp.section,
    }));
    dragLastDs = 0;
    dragMemberSet = new Set(dragMembers.map((m) => m.id));
    const rect = canvas.getBoundingClientRect();
    dragCx = e.clientX - rect.left;
    dragCy = e.clientY - rect.top;
    dragMod = e.ctrlKey || e.metaKey;
    dragS0 = p.s; // the anchor's start s/g — each axis's gesture-start magnet
    dragG0 = p.g;
    dragStartU = p.startU; // the anchor's section is fixed while its s is dragged inside it
    dragSection = p.section;
    dragLen = p.len;
    // the grab origin: the cursor's axis coordinate read through the SAME chart clamp `applyDrag`
    // resolves against, so returning to the grab pixel subtracts one value from itself exactly —
    // a diamond sitting past the addressable span (its fat hit zone reaches `FHIT_R` outside the
    // chart) would otherwise start the gesture with a phantom delta.
    dragU0 = uAtPx(clamp(dragCx, LEFT_GUT, Math.max(LEFT_GUT, w)));
    beginForceMoves(
        ecs,
        dragMembers.map((m) => m.id),
    );
    dragForce = p.id;
    beginDrag(canvas, e.pointerId);
    window.addEventListener("pointermove", forceMove);
    window.addEventListener("pointerup", forceUp);
    // a real pointercancel (system gesture takeover) must finalize the gesture the same
    // way a pointerup does — else the open history gesture never commits and corrupts undo
    // grouping. beginDrag recovers the `dragging` flag on its own; this is the history close.
    window.addEventListener("pointercancel", forceUp);
}
function forceMove(e: PointerEvent): void {
    if (dragForce === null) return;
    const rect = canvas.getBoundingClientRect();
    dragCx = e.clientX - rect.left;
    dragCy = e.clientY - rect.top;
    dragMod = e.ctrlKey || e.metaKey; // live: bypass can be toggled mid-drag
    applyDrag();
}
function forceUp(): void {
    if (dragForce === null) return;
    dragForce = null;
    snapX = null;
    snapY = null;
    commit(history); // one drag → one entry; a no-move click drops via the `same` guard
    window.removeEventListener("pointermove", forceMove);
    window.removeEventListener("pointerup", forceUp);
    window.removeEventListener("pointercancel", forceUp);
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
function marqueeUp(): void {
    if (!marqueeStart) return;
    const armed = marqueeArmed;
    const rect = marqueeRect;
    const shift = marqueeShift;
    marqueeCancel(); // detach listeners + clear rect/state
    if (!armed || !rect) {
        if (!shift) {
            selectForce(null); // a plain click on empty chart deselects (shift-click preserves)
            selectSection(null);
        }
        return;
    }
    const cand = forcePts.map((p) => ({ id: p.id, x: ptX(p), y: yOf(p.g) }));
    const res = merge(editor.forces, hits(rect, cand), shift ? "toggle" : "replace");
    if (!shift && res.ids.length === 0) {
        selectForce(null);
        selectSection(null);
    } else {
        selectForces(res.ids, res.active);
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
    // the dragged side's raw (Δs, Δg) from the latched cursor, both in OFFSET space (the store's
    // own position unit and g from the keyframe — the space the readout prints).
    let ds = uAtPx(clamp(cx, LEFT_GUT, Math.max(LEFT_GUT, w))) - pt.u;
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
    // a handle's Δs is stored in the same unit as the keyframe's own s (the domain conversion
    // scales it with the axis), so the Aligned/Mirror coupling's screen-collinearity test reads it
    // through the axis scale itself — no per-keyframe linearization.
    return composeTangent(side, ds, dg, prevS, pt.s, nextS, forceTangent(ecs, id), clamped.pxPerU, pyPerG);
}
function tanUp(): void {
    if (dragTan === null) return;
    dragTan = null;
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
let lenStartU = 0; // the dragged section's entry on the chart's axis (fixed during the drag)
let lenCx = 0; // last length-drag cursor, canvas-local px (drives the per-frame edge-pan)
let lenX0 = 0; // grab-point cursor px (fixed) — the dead-zone origin `lenArmed` measures from
let lenArmed = false; // the standard DRAG_PX dead-zone latch (`armDrag`) — gates the sticky-commit
let lenMod = false; // Ctrl/Cmd held (live) during the extent drag — snap bypass
const EDGE_PAN = 0.4; // px pan per px past the chart edge, per frame — a by-eye feel constant
// resolve the held cursor to a section extent through the *current* view (recomputed
// inline so an edge-pan this frame is already reflected — the edge never lags the pan).
// snaps the trimmed edge (the AE magnet) to content landmarks that are BOTH stable under
// the resize AND reachable (editor-ui.md): the section's own force points (section-local,
// so fixed while its extent changes) and the playhead (the Premiere trim-to-playhead
// idiom, only while parked). ruler ticks are excluded — the zoom-dependent 1-2-5 raster
// is display, not content. section boundaries are excluded too — the dragged section's
// own exit and every downstream boundary MOVE with the resize (self-snap), and upstream
// boundaries are unreachable (they'd floor the length). the reach guard (the domain's own
// `minForceExtent` floor) skips a snap the floor won't honor, so no guide flashes on an edge
// that can't get there — matching applyDrag's reach guard.
//
// The extent is the section's authored length in the track domain's unit, so in `Domain.Time`
// this same gesture trims a DURATION: the edge reads the chart's axis directly, with no
// projection between the cursor and the write.
function applyLen(): void {
    if (lenId === null) return;
    const cv = clampView(view, chartW, uFrozen ?? uTotal, mFloor);
    let cumU = pxToU(cv, lenCx - LEFT_GUT);
    snapX = null;
    if (snapActive(lenMod)) {
        const ownU: number[] = [];
        for (const p of forcePts) if (p.section === lenId) ownU.push(p.u);
        const targets = trimTargets(cv, ownU, paused && cartS !== null ? uOf(cartS) : null);
        const hit = snap(lenCx - LEFT_GUT, targets);
        if (hit !== null) {
            const cand = pxToU(cv, hit);
            if (cand - lenStartU >= minForceExtent(domain)) {
                cumU = cand; // only latch a target the extent floor will actually honor
                snapX = hit;
            }
        }
    }
    setSectionLength(ecs, lenId, cumU - lenStartU); // global edge − section entry → its extent
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
    selectSection(c.id); // grabbing the edge selects the section (one object, two surfaces)
    beginLength(ecs, c.id);
    lenId = c.id;
    uFrozen = uTotal; // freeze the pan-clamp span so the view holds still under the drag
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

// ── the selected point's typed s/g fields ──
// each field commits one undo entry through the drag gesture (begin → set → commit).
function fieldEdit(s: number, g: number): void {
    const p = selPoint;
    if (p === null || !Number.isFinite(s) || !Number.isFinite(g)) return; // guard a cleared field
    if (!sectionEditable(editor.pinning, p.section)) return; // the lockdown (fields disabled too)
    // a keyboard-committed mutation skips a live landing first, like undo/redo (`onKey`): the
    // pointer paths skip via App's capture listener, but Enter reaches here with no pointerdown.
    skipLanding();
    beginForceMove(ecs, p.id);
    setForcePoint(ecs, p.id, clamp(s, 0, p.len), g);
    commit(history);
}
// the position field speaks the track's own domain (global d, or global t — label and unit follow,
// `posLabel`/`posUnit`), the same unit the store holds, so the write is the lens's affine inverted:
// s = u − the section's entry. fieldEdit clamps into [0, len].
function onFieldPos(e: Event): void {
    if (!selPoint) return;
    const u = Number.parseFloat((e.currentTarget as HTMLInputElement).value);
    fieldEdit(u - selPoint.startU, selPoint.g);
}
function onFieldG(e: Event): void {
    if (!selPoint) return;
    fieldEdit(selPoint.s, Number.parseFloat((e.currentTarget as HTMLInputElement).value));
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
    skipLanding(); // keyboard-committed keyframe mutation: same routing as fieldEdit above
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
        // entry speed) — and inverts through the lens's affine for the write.
        labelScrub(e, {
            seed: p.u,
            rate: timeDomain ? SCRUB_T : SCRUB_S,
            lo: p.startU,
            hi: p.startU + p.len,
            round: 10,
            write: (v) => setForcePoint(ecs, p.id, clamp(v - p.startU, 0, p.len), p.g),
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
    if (dragForce === null) return;
    dragForce = null;
    snapX = null;
    snapY = null;
    cancel(); // interrupted (unmount mid-drag): revert to the pre-gesture s/g
    window.removeEventListener("pointermove", forceMove);
    window.removeEventListener("pointerup", forceUp);
    window.removeEventListener("pointercancel", forceUp);
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
    }

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
    resize(canvas, ctx);
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
    cancelForceDrag(); // and any in-flight force-point drag
    marqueeCancel(); // and any in-flight chart marquee (its listeners live on window)
    cancelTanDrag(); // and any in-flight handle drag
    cancelLenDrag(); // and any in-flight extent drag
    cancelLabelScrub(); // and any in-flight label scrub (its listeners live on the label, not window)
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
                    // under the rigid clamp, offsets preserved (`nudgeForces`, timeline.ts). Shift
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
                    for (const w of nudgeForces(members, ds, dg))
                        setForcePoint(ecs, w.id, w.s, w.g);
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
            k.xView = (): [number, number] => [view.pan, view.pxPerU];
            // the domain the chart READS (`Track.domain`, tick-derived so a flow polls it), and
            // every keyframe's coordinate on that axis — paired with the stored `s` the flow
            // asserts held, since the time-constrained assertion is exactly "every other
            // keyframe's stored t AND its drawn position unchanged" across an edit. `section` +
            // `g` (kex2d-structural-editing stage 9) let a multi-section flow read a Cut's TWO
            // halves apart — `main.ts`'s `forces()` only ever reads section 0 (`sec()`), so it
            // can't see a split's tail — without re-deriving `forcePts`' own grouping by hand.
            k.domain = (): string => (domain === Domain.Time ? "time" : "distance");
            k.forceU = (): { id: number; section: number; s: number; g: number; u: number }[] =>
                forcePts.map((p) => ({ id: p.id, section: p.section, s: p.s, g: p.g, u: p.u }));
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
                delete k.xView;
                delete k.domain;
                delete k.forceU;
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
        <canvas bind:this={canvas}></canvas>
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
                 moves the playhead (the distance ruler is the scrubber). -->
            {#if eid !== null && sTotal > 0}
                <rect
                    class="rulerzone"
                    x="0"
                    y="0"
                    width={w}
                    height={TOP}
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
                                height={GAP_H - 2 * CLIP_PAD}
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
                                    height={GAP_H - 2 * CLIP_PAD}
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
                                    height={GAP_H - 2 * CLIP_PAD}
                                    onpointerdown={(e) => lenDown(e, c)}
                                    role="presentation"
                                    aria-label="Resize force section"
                                />
                            {/if}
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
                                onpointerdown={(e) => forceDown(e, p)}
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
                    class:dragging={dragForce !== null}
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
                            onchange={onFieldPos}
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
                            onchange={onFieldG}
                            onfocus={(e) => e.currentTarget.select()}
                            onkeydown={(e) => fieldKeydown(e, gText)}
                            aria-label="Point force (g)"
                        />
                        <span class="unit">g</span>
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
