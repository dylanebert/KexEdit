<script lang="ts">
import type { State } from "@dylanebert/shallot";
import { onMount, untrack } from "svelte";
import { cartState, forceCurve, parkAtArc, parkFromTime, trackMapping } from "./cart";
import { kindSegments } from "./colors";
import Menu from "./Menu.svelte";
import { fitMenu, type MenuItem } from "./menu";
import {
    activateForce,
    beginDrag,
    closeForceMenu,
    closeRulerMenu,
    editor,
    endDrag as endDragGesture,
    enterForceEdit,
    exitForceEdit,
    openContext,
    openForceMenu,
    openRulerMenu,
    selectForce,
    selectForceHandle,
    selectForces,
    selectSection,
    setBasis,
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
    deleteForces,
    history,
    materializeCustom,
    redo,
    setForcesEase,
    setForceTangentMode,
    undo,
} from "./history";
import {
    Basis,
    clampDelta,
    clampView,
    composeTangent,
    creationTargets,
    dToU,
    fmt,
    frameAll,
    G_GRID,
    grabD,
    type Mapping,
    marginArc,
    marginFloor,
    navDragView,
    navWindow,
    nodeArc,
    nudgeForces,
    pxToS,
    S_GRID,
    snap,
    snapAxis,
    sToPx,
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
    MIN_FORCE_LEN,
    SectionKind,
    sectionForces,
    sectionHandles,
    sectionInfo,
    sections,
    sectionSpans,
    setForcePoint,
    setForceTangent,
    setSectionLength,
    V0,
} from "./track";
import { DOCK_HEIGHT, DOCK_INSET, resize } from "./view";

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
// the timeline BASIS — picked from the ruler's context menu (no keyboard shortcut). `basis` is what
// the chart actually READS: with no live bake the seam falls back to distance identity
// (`dToU`/`uToD`), so time isn't on offer — the ruler menu's Seconds row grays in that state
// (`rulerMenuItems`) and its `checked` reads THIS value, never the raw session preference, so the
// menu can't show a lit Seconds row over a metre axis. Tick-derived like the magnet, so it lags a
// frame — which is why the flip's own re-frame is deferred to the same frame (`applyBasis`)
// instead of writing `view` live.
const basis = $derived.by((): Basis => {
    void tick;
    return mapping === null ? Basis.Distance : editor.basis;
});
const timeBasis = $derived(basis === Basis.Time);
// the position field's key + unit follow the basis (the readout suffix the ruler's ticks wear too).
const posLabel = $derived(timeBasis ? "t" : "d");
const posUnit = $derived(timeBasis ? "s" : "m");

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
const PLAYER_GAP = 32; // px the media player floats above the dock's top edge
const LABEL_HALF = 5; // px; half a g-label's height — hide a label nearer than this to the plot edge
// reference comfort limits (g) — drawn as faint lines to read the force curve against, and the
// value axis's RESTING frame: the window the view sits in whenever the data fits inside it (the
// seed before any data arrives, and the minimum `yFit` expands from). One constant, no ladder.
const BAND: [number, number] = [-2, 6];
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
// arrow-nudge steps for the selected force point (AE): s in meters, g in g, Shift coarse.
// fixed-domain steps in the STORED domain, in either basis: the nudge is a step of the authored
// quantum (`Force.s` is arclength however the chart reads), rounded to the field's displayed
// precision so it lands clean. The basis moves what the field prints, not what a nudge steps.
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
let view: View = $state({ pan: 0, pxPerM: 10 });
let framed = false;
// while the section-end handle drags, the chart's addressable span FREEZES at its
// high-water mark (in basis units) so the pan clamp never shifts the view under the cursor
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
// total track arclength (m) — the chart's X-axis domain.
const sTotal = $derived(curve ? curve.s[curve.n - 1] : 0);
// total track seconds — the *player* transport's domain (the media player stays in
// time; only the chart is distance).
const tTotal = $derived.by((): number => {
    void tick;
    if (eid === null) return 0;
    return bakeOut.get(eid)?.tTotal ?? 0;
});
// the cart↔chart projection AND the basis seam's table: the cart rides in time, and
// `Basis.Time` reads the chart's x on that same clock.
const mapping = $derived.by((): Mapping | null => {
    void tick;
    return eid === null ? null : trackMapping(eid);
});

// ── the basis seam (timeline.ts `dToU`/`uToD`) ──
// the chart's internal x is the BASIS coordinate u: global distance d in `Basis.Distance`
// (identity — today's only axis) or global time t in `Basis.Time`, projected through the live
// bake's arc↔time table. Every draw path projects d → u here (`markerX`) and every read/write
// path inverts u → d here (`dAtPx` for an absolute placement, `grabD` for a grabbed subject);
// nothing downstream branches on the basis again, bar the sanctioned constant picks (the `GRID`
// quantum, the `mFloor` lead-out, the unit suffix). With no live bake the pair is identity, so
// the toggle still works and the chart reads distance.
const uOf = (d: number): number => dToU(mapping, basis, d);
const dOf = (u: number): number => uToD(mapping, basis, u);
// the addressable span's end and the lead-out floor, both in basis units.
const uTotal = $derived(uOf(sTotal));
const mFloor = $derived(marginFloor(basis));
// the x-axis placement quantum for a keyframe drag: metres of arclength, or seconds (`T_GRID`,
// derived from `S_GRID` at the default entry speed).
const GRID = $derived(timeBasis ? T_GRID : S_GRID);
// the chart insets past the left g-gutter; the basis affine lives in [LEFT_GUT, w], so every
// timeline.ts call takes `chartW` and screen-X adds/subtracts LEFT_GUT.
const chartW = $derived(Math.max(0, w - LEFT_GUT));
const clamped = $derived(clampView(view, chartW, uFrozen ?? uTotal, mFloor));
const tickList = $derived(ticks(clamped, chartW, basis));
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
    const x = markerX(cartS); // the cart's arclength, through the basis seam
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

// set the basis (the ruler menu's Meters/Seconds rows — no keyboard twin, the second feel
// check-in's call) and re-express the view in it: the change is a free VIEW change, so it holds
// the stretch of ride the author is looking at and only restates its window in the new basis's
// units (`view.pan`/`pxPerM` are basis-unit quantities). the live `editor.basis` drives the
// projection here, not the tick-derived `basis`, which lags a frame.
let pendingWin: { l: number; r: number } | null = null;
function applyBasis(target: Basis): void {
    if (editor.dragging) return; // a live gesture holds the document axis still (editor-ui.md)
    if (editor.basis === target) return; // already there — the menu's "picking the checked row is a no-op" law
    // the window is carried as FRACTIONS of the addressable span — `navWindow`'s own
    // representation, the one already used to place the navigator bracket. Carrying its two RIDE
    // positions instead is the wrong move and not reversible: the lead-out past the track end has
    // no image under the projection (the ride's clock stops at its last sample, so every distance
    // beyond it maps to the same `tTotal`), so a window reaching into the lead-out would collapse
    // on the way out and never come back. Fractions round-trip.
    pendingWin = navWindow(clamped, chartW, uTotal, mFloor);
    setBasis(target);
}
// …and applied on the frame the tick re-derives `basis` in. `view` is live `$state` while `basis`,
// `mapping`, `uTotal` and `mFloor` are tick-derived, so writing the new scale straight from the
// handler would leave the two disagreeing for one frame and the chart would paint old-basis
// coordinates against a new-basis scale — a visible jump on every toggle. Deferring costs one
// frame and lands the whole flip at once.
$effect(() => {
    void tick;
    untrack(() => {
        const win = pendingWin;
        if (win === null) return;
        pendingWin = null;
        if (chartW <= 0 || sTotal <= 0) return; // nothing framed yet — the initial frame will run
        const span = uTotal + marginArc(uTotal, mFloor);
        const pxPerM = chartW / Math.max(1e-6, (win.r - win.l) * span);
        view = clampView({ pan: win.l * span * pxPerM, pxPerM }, chartW, uTotal, mFloor);
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
// the inverse of yOf — a chart-local pixel y back to a g value, for placing/dragging
// force points against the displayed axis.
const yToG = (py: number): number => {
    const inner = Math.max(1, h - BOT_PAD - TOP);
    return yView.lo + (1 - (py - TOP) / inner) * (yView.hi - yView.lo);
};
// px-per-g magnitude for the g-axis (y grows downward, so a +Δg is −Δpy) — the vertical
// counterpart of `clamped.pxPerM` (px per metre on s). the tangent-handle geometry maps
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
// `history`. force points are authored section-local (s from the section entry); the
// chart x-axis is whole-track cumulative arclength, so a point draws at its section's
// cumulative offset (`startS`) + its local s.
//
// the coordinate lens's span table (track.ts): each section's global-d offset + baked
// arclength. the ONE source for every cumulative-d readout on the chart — boundaries,
// clips, and force-point placement all derive from it, none re-walks the baked ds.
const spans = $derived.by(() => {
    void tick;
    return eid === null ? [] : sectionSpans(ecs, eid);
});
// the interior section boundaries in global distance d — drawn as chart guides. each
// non-last span's exit (offset + len).
const bounds = $derived.by((): number[] =>
    spans.slice(0, -1).map((sp) => sp.offset + sp.len),
);
// ── section clip strip (the marker lane): one clip per section over its cumulative
// arclength span, kind-colored + labeled, selecting `editor.section` — the SAME
// selection as the viewport span (one object, two surfaces). clip edges align with the
// chart's boundary guides (both are arclength). a force clip's right edge is its extent
// trim (below).
interface Clip {
    id: number;
    kind: SectionKind;
    s0: number; // cumulative arclength at the section entry
    s1: number; // cumulative arclength at the section exit
    len: number; // authored extent (force `Section.length`) — the clamp domain for its points
}
const clips = $derived.by((): Clip[] => {
    void tick;
    const byId = new Map(spans.map((sp) => [sp.id, sp]));
    const res: Clip[] = [];
    for (const sec of sections(ecs)) {
        const sp = byId.get(sec.id);
        if (!sp) continue;
        res.push({ id: sec.id, kind: sec.kind, s0: sp.offset, s1: sp.offset + sp.len, len: sec.length });
    }
    return res;
});
// ── geo node ticks (read-only, kex2d-geo-ux stage 2): a small circle in the marker
// lane per INTERIOR node of a geo section, positioned via the section's own span
// offset (`Clip.s0`) plus the partial-sum arclength from `bakeOut.ds` up to the
// node's landing sample (`nodeArc`, timeline.ts), projected through the basis seam like
// every other chart landmark. Display + selection-highlight
// only — no hit-testing, no drag: a node's timeline position is DERIVED from
// geometry, and dragging it on this axis is the rejected inverse problem (spec
// `kex2d-geo-ux.md`'s locked decision). Node 0 (the entry) and the section's last
// baked node (the exit) sit exactly at the clip's own edges — already drawn by the
// clip strip and the boundary guides — so only orders `[1, bakedNodes-2]` tick; an
// orphan node past `bakedNodes` (a truncated bake, stale `.sample`) is excluded too.
interface NodeTick {
    eid: number;
    x: number; // canvas px (the basis-projected `markerX`)
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
// every force section's points, flattened across the whole track — each carries its
// section's cumulative start (`startS`) and authored extent (`len`) so the chart draws,
// picks, and clamps it without a per-section "active" selection.
interface ForcePt {
    id: number;
    section: number;
    s: number; // section-local arclength
    g: number;
    startS: number; // the section's cumulative start (draw at startS + s)
    len: number; // the section's authored extent (drag/field clamp domain)
}
const forcePts = $derived.by((): ForcePt[] => {
    void tick;
    if (eid === null) return [];
    const res: ForcePt[] = [];
    for (const c of clips) {
        if (c.kind !== SectionKind.Force) continue;
        for (const p of sectionForces(ecs, c.id))
            res.push({ id: p.id, section: c.id, s: p.s, g: p.g, startS: c.s0, len: c.len });
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

// the ONE draw projection: a global distance `d` → its canvas x, through the basis seam.
const markerX = (d: number): number => LEFT_GUT + sToPx(clamped, uOf(d));
// the read twin: a canvas-local px back to a global distance. For an ABSOLUTE placement (an
// insertion, a scrub, a trim candidate) — a grabbed subject resolves through `grabD` instead,
// delta-from-grab, so its zero-delta case is exact.
const dAtPx = (px: number): number => dOf(pxToS(clamped, px - LEFT_GUT));
// a force point's chart x — its section-local s placed at its section's cumulative
// offset. points are authored local; the chart draws whole-track cumulative.
const ptX = (p: ForcePt): number => markerX(p.startS + p.s);
// px per METRE at a global distance `d` — the scale the tangent-handle geometry needs, since a
// handle's stored offsets are metres and g while the axis may read seconds. `Distance` basis IS
// the axis scale, exactly; `Time` basis linearizes the projection over one grid step around `d`,
// which is what the coupling's screen-collinearity test needs locally.
const pxPerMAt = (d: number): number => {
    if (!timeBasis || mapping === null) return clamped.pxPerM;
    const lo = Math.max(0, d - S_GRID);
    const hi = d + S_GRID;
    const du = uOf(hi) - uOf(lo);
    return du > 1e-9 ? (clamped.pxPerM * du) / (hi - lo) : clamped.pxPerM;
};

// ── snapping (the AE magnet): a snap resolves in chart-local px (the `snap` resolver,
// timeline.ts), so `snapX`/`snapY` are the guide flashes to draw when an axis latches.
// chart-local px (past the g-gutter subtracted); LEFT_GUT is re-added when rendered.
let snapX: number | null = $state(null); // an active s-axis snap: vertical guide px
let snapY: number | null = $state(null); // an active g-axis snap: horizontal guide py

// the s-axis snap targets in chart-local px (the horizontal magnet): content landmarks
// only (editor-ui.md) — section boundaries (0, interior boundaries, optionally the track
// end), other force points, and — only while parked, so a live-playing playhead isn't a
// moving magnet — the playhead. no ruler ticks: they're the zoom-dependent 1-2-5 raster,
// display not content. the caller excludes the dragged point and picks whether its own
// moving edge (the track end) is a target.
function sTargets(opts: { exclude?: Set<number>; playhead: boolean; trackEnd: boolean }): number[] {
    const v = clamped;
    const out: number[] = [sToPx(v, uOf(0))];
    for (const b of bounds) out.push(sToPx(v, uOf(b)));
    if (opts.trackEnd) out.push(sToPx(v, uOf(sTotal)));
    for (const p of forcePts)
        if (!opts.exclude?.has(p.id)) out.push(sToPx(v, uOf(p.startS + p.s)));
    if (opts.playhead && paused && cartS !== null) out.push(sToPx(v, uOf(cartS)));
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

// the pointer's global distance on the chart (clamped to the track), through the seam.
function chartS(e: MouseEvent): number {
    const rect = canvas.getBoundingClientRect();
    return clamp(dAtPx(e.clientX - rect.left), 0, sTotal);
}
// the pointer's BASIS coordinate (clamped to the addressable span) — a gesture's grab origin,
// paired with the grabbed subject's own global distance by `grabD`.
function chartU(e: MouseEvent): number {
    const rect = canvas.getBoundingClientRect();
    return clamp(pxToS(clamped, e.clientX - rect.left - LEFT_GUT), 0, uTotal);
}

// double-click the chart drops a force point at that s, in whatever force section the
// cursor is over (resolved by arclength — no section pre-selection), ON the authored
// profile (g = the profile's value there — the DAW/AE envelope-insertion identity: a
// new point never bends the curve, and drags from a known start). over a geo section
// (or empty), it's a no-op.
function chartCreate(e: MouseEvent): void {
    let cumS = chartS(e);
    // snap the placement through the same landmark resolver the drags use (toggle, Ctrl/Cmd
    // bypass, and SNAP_PX all apply) — the AE insert-at-CTI idiom — before resolving the value.
    // creation targets exclude force points (an occupied s is degenerate) but keep boundaries,
    // origin, track end, and the parked playhead. no guide flash: a double-click has no gesture
    // to clear one, and the resolver's guide is a drag-lifetime affordance.
    if (snapActive(e.ctrlKey || e.metaKey)) {
        // the landmarks are content (global distances), so they project through the seam like
        // every other draw; the resolved px inverts back to a distance for the write.
        const targets = creationTargets(
            clamped,
            bounds.map(uOf),
            uOf(sTotal),
            paused && cartS !== null ? uOf(cartS) : null,
        );
        const hit = snap(sToPx(clamped, uOf(cumS)), targets);
        if (hit !== null) cumS = clamp(dOf(pxToS(clamped, hit)), 0, sTotal);
    }
    const c = clips.find((x) => x.kind === SectionKind.Force && cumS >= x.s0 && cumS <= x.s1);
    if (!c) return; // not over a force section
    // value = the authored profile at the SNAPPED section-local s (insert-on-curve: the new
    // point never bends the curve), so both position and value derive from the snapped place.
    const s = clamp(cumS - c.s0, 0, c.len); // (snapped) cumulative → section-local
    selectForce(createForce(history, ecs, c.id, s, sampleForce(sectionForces(ecs, c.id), s)));
}

// drag a diamond in both axes (horizontal = s, vertical = g), one undo entry. the
// last cursor position is kept in canvas space so the per-frame edge-grow (the
// yView effect's drag branch) can re-map it through a grown axis. Shift is a no-op on a
// force-keyframe drag: the per-axis gesture-start magnet is the "change just one axis"
// affordance, so a dominant-axis lock is redundant here (removed 2026-07-23).
let dragForce: number | null = $state(null); // the ANCHOR point id (snap resolves on it)
// the grab pair `grabD` resolves every frame against: the ANCHOR's own global distance and the
// cursor's basis coordinate, both captured at pointerdown. In distance basis their difference IS
// the old cumulative grab offset (so grabbing off-center still doesn't jump); in time basis the
// pair is what makes the delta exact through the live mapping.
let dragD0 = 0;
let dragU0 = 0;
let dragStartS = 0; // the ANCHOR's section cumulative start (fixed during the drag)
let dragLen = 0; // the ANCHOR's section extent (the anchor's own s clamp domain)
let dragCx = 0; // last cursor, canvas-local px
let dragCy = 0;
let dragMod = false; // Ctrl/Cmd held (live) — the snap bypass modifier
let dragS0 = 0; // the grab s / g — each axis's gesture-start landmark (always-on magnet)
let dragG0 = 0;
// the dragged SET, captured at gesture start: every selected member's start s/g + its own section
// extent (the rigid-clamp bounds). single-select is the size-1 case (just the anchor). the whole
// set moves by ONE shared (Δs, Δg) — relative offsets preserved exactly — resolved on the anchor.
let dragMembers: { id: number; s0: number; g0: number; len: number }[] = [];
let dragMemberSet: Set<number> = new Set(); // the member ids, so the snap excludes every moving point
function applyDrag(): void {
    if (dragForce === null) return;
    // both axes clamp the cursor to the chart: the view never moves under a drag,
    // so past an edge the point rides it (y follows only as the edge-grow expands).
    const cx = clamp(dragCx, LEFT_GUT, Math.max(LEFT_GUT, w));
    // resolve the ANCHOR through the snap first (grid + landmarks + the gesture-start axis magnet),
    // exactly as a single drag does — the shared delta then derives from where the anchor lands and
    // the OTHER members follow it. the cursor's basis coordinate resolves DELTA-FROM-GRAB off the
    // live mapping (`grabD`) to the anchor's cumulative distance, − startS → local (clamped to the
    // anchor's own [0, len]).
    let sAnchor = clamp(
        grabD(mapping, basis, dragD0, dragU0, pxToS(clamped, cx - LEFT_GUT)) - dragStartS,
        0,
        dragLen,
    );
    let gAnchor = yToG(clamp(dragCy, TOP, h - BOT_PAD));
    snapX = null;
    snapY = null;
    const active = snapActive(dragMod);
    {
        // the candidate and every landmark resolve in BASIS units (so the grid quantum is the
        // basis's own — `GRID`), and the winner inverts back to a distance for the write.
        const uAnchor = uOf(dragStartS + sAnchor);
        const targets = sTargets({ exclude: dragMemberSet, playhead: true, trackEnd: true });
        const startPx = sToPx(clamped, uOf(dragStartS + dragS0)); // gesture-start landmark
        const r = snapAxis(active, sToPx(clamped, uAnchor), uAnchor, targets, GRID, (px) =>
            pxToS(clamped, px), startPx);
        if (r.guide !== null) {
            // the gesture-start magnet resolves to the GRAB VALUE, never a px round-trip: the
            // round-trip drops the last ulp (and the projection isn't affine in time basis), so a
            // gesture returned to its start has to land on exactly the s it began at — else a
            // zero-delta drag writes a difference and records an undo entry.
            const local = r.guide === startPx ? dragS0 : dOf(r.value) - dragStartS;
            // a landmark: only latch one the anchor can actually reach in its own section
            if (local >= 0 && local <= dragLen) {
                sAnchor = local;
                snapX = r.guide;
            }
        } else {
            // grid (or bypass) — quantized in the active basis, kept in the section
            sAnchor = clamp(dOf(r.value) - dragStartS, 0, dragLen);
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
    for (const m of dragMembers)
        setForcePoint(ecs, m.id, clamp(m.s0 + ds, 0, m.len), m.g0 + dg);
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
        enterForceEdit(p.id); // second press on the same diamond → summon its handles (single-subject)
        return;
    }
    lastFdownT = e.timeStamp;
    lastFdownId = p.id;
    // grabbing a MEMBER of a multi-set keeps the set and drags the whole block (p becomes the active
    // anchor); grabbing a non-member replace-selects just it (single drag) — the standard
    // clicked-selected-vs-unselected rule.
    if (editor.forces.ids.has(p.id)) activateForce(p.id);
    else selectForce(p.id);
    // the drag set: every selected member's start s/g + its own extent (size-1 for a single drag).
    const set = editor.forces.ids;
    const members = set.size > 1 ? forcePts.filter((fp) => set.has(fp.id)) : [p];
    dragMembers = members.map((fp) => ({ id: fp.id, s0: fp.s, g0: fp.g, len: fp.len }));
    dragMemberSet = new Set(dragMembers.map((m) => m.id));
    const rect = canvas.getBoundingClientRect();
    dragCx = e.clientX - rect.left;
    dragCy = e.clientY - rect.top;
    dragMod = e.ctrlKey || e.metaKey;
    dragS0 = p.s; // the anchor's start s/g — each axis's gesture-start magnet
    dragG0 = p.g;
    dragStartS = p.startS; // the anchor's section is fixed while its s is dragged inside it
    dragLen = p.len;
    dragD0 = p.startS + p.s; // the anchor's own global distance
    dragU0 = chartU(e); // the cursor's basis coordinate — the grab origin `grabD` measures from
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
        handles.push({ side: "in", x: markerX(pt.startS + pt.s + off.ds), y: yOf(pt.g + off.dg), ds: off.ds, dg: off.dg, ghost: tan?.in === undefined });
    }
    if (next) {
        const off = tan?.out ?? derivedOut(pt, next);
        handles.push({ side: "out", x: markerX(pt.startS + pt.s + off.ds), y: yOf(pt.g + off.dg), ds: off.ds, dg: off.dg, ghost: tan?.out === undefined });
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
    const rx = hnd.x - markerX(pt.startS + pt.s);
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
    const kx = markerX(pt.startS + pt.s);
    const ky = yOf(pt.g);
    const latch = latchAngle(cx - kx, cy - ky, tanRayX, tanRayY);
    cx = kx + latch.x;
    cy = ky + latch.y;
    // the dragged side's raw (Δs, Δg) from the latched cursor, both in OFFSET space (metres
    // and g from the keyframe — the space the readout prints).
    const cumD = dAtPx(clamp(cx, LEFT_GUT, Math.max(LEFT_GUT, w)));
    let ds = cumD - (pt.startS + pt.s);
    let dg = yToG(clamp(cy, TOP, h - BOT_PAD)) - pt.g;
    // Δg grid-quantizes to the force vocabulary (G_GRID), so a snapped handle reads as
    // vocabulary ("+0.5 g"); Ctrl/Cmd frees it to continuous. Δs stays CONTINUOUS (F3d): a
    // keyframe's s is a placement on the arclength (vocabulary), but a handle's Δs is curvature
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
    // the METRE scale at the keyframe (`pxPerMAt`), not the axis scale: a handle's offsets are
    // metres and g in either basis, and the Aligned/Mirror coupling compares them in chart px.
    return composeTangent(
        side,
        ds,
        dg,
        prevS,
        pt.s,
        nextS,
        forceTangent(ecs, id),
        pxPerMAt(pt.startS + pt.s),
        pyPerG,
    );
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
// the recovered force curve's g at a cumulative arclength — a linear interp over the baked
// per-sample series (clamped to the ends). the curve is the geometry-recovered force the
// chart draws, so a hit-test against it matches what the eye sees, not the authored profile
// (a diamond sits O(ds) off the drawn curve). used to gate a chart right-click to the span.
function curveGAt(cumS: number): number {
    const c = curve;
    if (!c || c.n === 0) return Y_BASE;
    if (cumS <= c.s[0]) return c.f[0];
    if (cumS >= c.s[c.n - 1]) return c.f[c.n - 1];
    let lo = 0;
    let hi = c.n - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (c.s[mid] <= cumS) lo = mid;
        else hi = mid;
    }
    const span = c.s[hi] - c.s[lo];
    const t = span > 0 ? (cumS - c.s[lo]) / span : 0;
    return c.f[lo] + t * (c.f[hi] - c.f[lo]);
}
// right-click the curve span between two keyframes → the LEADING keyframe's menu (the
// Blender convention: easing lives on the keyframe and governs the following segment, so
// the segment addresses the keyframe before it). the hit-target is the drawn curve span,
// NOT the whole force-section column: a right-click far above or below the curve is empty
// chart space and opens nothing. over empty/geo, or left of the first keyframe (no
// leading), it's a no-op too.
function chartCtx(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const cumS = chartS(e);
    const c = clips.find((x) => x.kind === SectionKind.Force && cumS >= x.s0 && cumS <= x.s1);
    if (!c) return;
    // the click must land within the force-point grab radius (FHIT_R — the same fat pick
    // zone a diamond carries) of the curve span vertically; a click out in empty chart space
    // addresses no keyframe (a diamond hit is handled by forceCtx, on the marker's own rect).
    if (Math.abs(e.clientY - canvas.getBoundingClientRect().top - yOf(curveGAt(cumS))) > FHIT_R)
        return;
    const localS = cumS - c.s0;
    let lead: number | null = null;
    for (const p of sectionForces(ecs, c.id)) {
        if (p.s <= localS + 1e-6) lead = p.id;
        else break;
    }
    if (lead === null) return;
    openForceMenu(e.clientX, e.clientY, lead);
}

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
// the menu as data: Delete (the whole SET, one entry — force multi-delete is unconditional), then an
// Easing ▸ submenu — Linear | Cubic | Quintic (checked by the ACTIVE keyframe's tag), a separator,
// then Custom. the preset rows apply to ALL selected non-terminal keyframes (bulkEaseIds); the row
// grays when none is applicable. each row carries its real curve glyph (drawn from the same
// influence the segment uses, so the icon can't drift). Custom is single-subject (the active): both
// the derived-provenance indicator (checked when an explicit handle bounds its segment) AND a choice
// — picking it materializes the segment's handles and steps into handle edit; picking a preset
// clears them back. a single terminal keyframe governs no segment, so it shows Delete alone.
const fmenuItems = $derived.by((): MenuItem[] => {
    const m = editor.forceMenu;
    if (m === null) return [];
    const id = m.id; // the active member (openForceMenu promotes the right-clicked one) — single subject
    const items: MenuItem[] = [
        {
            label: "Delete",
            shortcut: "Del",
            danger: true,
            action: () => deleteForces(history, ecs, [...editor.forces.ids]),
        },
    ];
    // shown whenever any easing target could exist (a multi-set, or a single non-terminal keyframe);
    // enabled only when the selection has a non-terminal member — else grayed, never hidden.
    if (multiForce || !fmenuTerminal) {
        const targets = bulkEaseIds;
        const easeRow = (label: string, e: Easing): MenuItem => ({
            label,
            glyph: presetGlyph(e),
            checked: !fmenuCustom && fmenuEase === e,
            action: () => setForcesEase(history, ecs, targets, e),
        });
        items.push({
            label: "Easing",
            enabled: targets.length > 0,
            children: [
                easeRow("Linear", Easing.Linear),
                easeRow("Cubic", Easing.Cubic),
                easeRow("Quintic", Easing.Quintic),
                { separator: true },
                // Custom is single-subject (the active) and steps into handle edit on it — a terminal
                // keyframe governs no segment, a state single-select can't reach (its whole Easing ▸ is
                // hidden), so gray Custom when the active is terminal even while non-terminal siblings
                // keep the preset rows live.
                {
                    label: "Custom",
                    enabled: !fmenuTerminal,
                    glyph: customGlyph(id),
                    checked: fmenuCustom,
                    action: () => chooseCustom(id),
                },
            ],
        });
    }
    // a keyframe with explicit handles (either side) carries a Tangents ▸ mode submenu (Mirror |
    // Aligned | Free, checked by the stored mode) — the geo node menu's convention. shown even at a
    // terminal keyframe (whose only handle is the incoming in-side). no Reset row: the way back to
    // derived is picking a preset in Easing ▸ (which clears the segment's handles).
    if (fmenuHasHandles) {
        const modeRow = (label: string, mode: TangentMode): MenuItem => ({
            label,
            checked: fmenuMode === mode,
            action: () => pickForceMode(id, mode),
        });
        items.push({
            label: "Tangents",
            children: [
                modeRow("Mirror", TangentMode.Mirror),
                modeRow("Aligned", TangentMode.Aligned),
                modeRow("Free", TangentMode.Free),
            ],
        });
    }
    return items;
});
// set the addressed keyframe's tangent mode as one undo entry (the geo `pickMode` analogue),
// reconciling the handle pair in chart pixels so it stays jump-consistent with the drag coupling.
function pickForceMode(id: number, mode: TangentMode): void {
    const pt = forcePts.find((p) => p.id === id);
    setForceTangentMode(
        history,
        ecs,
        id,
        mode,
        pxPerMAt(pt ? pt.startS + pt.s : 0),
        pyPerG,
    );
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

// ── the ruler context menu (Meters / Seconds — the timeline basis picker), summoned by
// right-clicking the ruler scrub zone (`rulerCtx`). visibility reads through the tick, like
// every other editor-state surface (`editor.rulerMenu` is replaced wholesale on open/close, never
// mutated in place, so this simple derived is safe — the `converting` progress object's in-place
// rewrite is the case that ISN'T).
const rmenu = $derived.by((): { x: number; y: number } | null => {
    void tick;
    return editor.rulerMenu;
});
// flat rows, not a `Units ▸` submenu: the menu has nothing else in it, so nesting would spend a
// click opening a submenu with no sibling rows to justify it (`editor-ui.md`'s terse-rows law —
// a menu that's only ever one submenu should just be its rows). `checked` reads `basis` (the
// tick-derived value the chart actually READS, already falling back to Distance with no live
// bake), never the raw session preference — so the menu can't show a lit Seconds row over a
// metre axis (the same lie the old rail toggle could tell). Seconds GRAYS (never hides) with no
// live bake — picking it would write a preference the chart can't honor right now
// (`editor-ui.md`'s "gray a row whose preconditions fail"); Meters has no precondition. Picking
// the already-checked row is a no-op (`applyBasis`'s equality guard). No keyboard shortcut — the
// second feel check-in's call: the basis switch doesn't warrant one.
const rulerMenuItems = $derived.by((): MenuItem[] => {
    if (editor.rulerMenu === null) return [];
    const live = mapping !== null;
    return [
        {
            label: "Meters",
            checked: basis === Basis.Distance,
            action: () => applyBasis(Basis.Distance),
        },
        {
            label: "Seconds",
            enabled: live,
            checked: basis === Basis.Time,
            action: () => applyBasis(Basis.Time),
        },
    ];
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
function clipMenu(e: MouseEvent, c: Clip): void {
    e.preventDefault();
    e.stopPropagation();
    openContext(e.clientX, e.clientY, c.id);
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
// the append flyout as data, one instance of the shared menu language. both choices are
// always possible (a chain end always accepts a geo or force section), so neither declares
// enablement — the substrate carries it, this menu just has nothing to disable.
const appendItems: MenuItem[] = [
    { label: "Geo", aria: "Append geometry section", action: () => append(SectionKind.Geo) },
    { label: "Force", aria: "Append force section", action: () => append(SectionKind.Force) },
];
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
let lenStartS = 0; // the dragged section's cumulative start arclength (fixed during the drag)
let lenU0 = 0; // the grab's basis coordinate and the distance it addressed — the pair the
let lenD0 = 0; // trimmed edge resolves delta-from-grab against (`grabD`)
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
// boundaries are unreachable (they'd floor the length). the reach guard (length
// ≥ MIN_FORCE_LEN) skips a snap the floor won't honor, so no guide flashes on an edge
// that can't get there — matching applyDrag's reach guard.
function applyLen(): void {
    if (lenId === null) return;
    const cv = clampView(view, chartW, uFrozen ?? uTotal, mFloor);
    // the trimmed edge resolves DELTA-FROM-GRAB (`grabD`) like the keyframe drag, not as a
    // projected absolute read, so no d↔t projection gap enters the written extent. the grab
    // origin is the pointer's px inside the trim strip (not the section's authored edge), so a
    // returned gesture re-writes that px's own value — pre-existing trim behavior, unchanged.
    let cumD = grabD(mapping, basis, lenD0, lenU0, pxToS(cv, lenCx - LEFT_GUT));
    snapX = null;
    if (snapActive(lenMod)) {
        const ownS: number[] = [];
        for (const p of forcePts) if (p.section === lenId) ownS.push(uOf(p.startS + p.s));
        const targets = trimTargets(cv, ownS, paused && cartS !== null ? uOf(cartS) : null);
        const hit = snap(lenCx - LEFT_GUT, targets);
        if (hit !== null) {
            const cand = dOf(pxToS(cv, hit));
            if (cand - lenStartS >= MIN_FORCE_LEN) {
                cumD = cand; // only latch a target the MIN_FORCE_LEN floor will actually honor
                snapX = hit;
            }
        }
    }
    setSectionLength(ecs, lenId, cumD - lenStartS); // cumulative − section start → local extent
}
function lenDown(e: PointerEvent, c: Clip): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = canvas.getBoundingClientRect();
    lenCx = e.clientX - rect.left;
    lenX0 = lenCx;
    lenArmed = false;
    lenMod = e.ctrlKey || e.metaKey;
    lenStartS = c.s0; // upstream is unchanged by this resize, so the start is fixed
    lenU0 = pxToS(clamped, lenCx - LEFT_GUT); // the grab origin, in basis units
    lenD0 = dOf(lenU0); // and the distance it addresses — the pair `grabD` resolves against
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
    beginForceMove(ecs, p.id);
    setForcePoint(ecs, p.id, clamp(s, 0, p.len), g);
    commit(history);
}
// the position field speaks the ACTIVE BASIS (track-global d, or t while the timeline reads
// time — label and unit follow, `posLabel`/`posUnit`); it inverts through the seam and then the
// lens (s = d − the section's offset) before writing. fieldEdit clamps into [0, len].
function onFieldPos(e: Event): void {
    if (!selPoint) return;
    const u = Number.parseFloat((e.currentTarget as HTMLInputElement).value);
    fieldEdit(dOf(u) - selPoint.startS, selPoint.g);
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
    const tan = tangentFor(h.pt.id, h.side, ds, dg);
    if (!tan) return;
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
// `SCRUB_S`'s time-basis twin (s per px), derived at the default entry speed exactly like
// `T_GRID`, so the position scrub covers the same ground per px in either basis.
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
    const freeze = {
        x: clamp(ptX(p), LEFT_GUT + TIP_HALF, Math.max(LEFT_GUT + TIP_HALF, w - TIP_HALF)),
        y: clamp(yOf(p.g), TOP, h - BOT_PAD),
    };
    if (axis === "s") {
        // the position scrub slides the value the field DISPLAYS — the active basis, so its rate
        // and its rounding are that basis's own (`SCRUB_T` is `SCRUB_S`'s time twin at the default
        // entry speed) — and inverts through the seam + the lens for the write.
        labelScrub(e, {
            seed: uOf(p.startS + p.s),
            rate: timeBasis ? SCRUB_T : SCRUB_S,
            lo: uOf(p.startS),
            hi: uOf(p.startS + p.len),
            round: 10,
            write: (v) => setForcePoint(ecs, p.id, clamp(dOf(v) - p.startS, 0, p.len), p.g),
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
function deleteSelectedForce(): void {
    if (editor.force === null) return; // active is null iff the set is empty
    // force multi-delete is UNCONDITIONAL: delete the whole selected set in ONE undo entry. no
    // explicit deselect — the popover/menu derive null once the subjects are gone and the $effect
    // above clears the stale active id (one mechanism for every death path). single-select is the
    // size-1 case.
    deleteForces(history, ecs, [...editor.forces.ids]);
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
        { pan: pan0 - (e.clientX - panX0), pxPerM: clamped.pxPerM },
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
    navDrag = { mode, grab: navSAt(e.clientX) - pxToS(clamped, 0) };
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

    // section boundaries: a vertical guide at each interior boundary's cumulative
    // arclength — the chart counterpart of the viewport's boundary anchor diamonds.
    for (const bs of bounds) {
        const x = markerX(bs);
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
        const hit = snap(sToPx(clamped, uOf(s)), sTargets({ playhead: false, trackEnd: true }));
        if (hit !== null) s = clamp(dOf(pxToS(clamped, hit)), 0, sTotal);
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

// right-click the ruler → the basis menu (Meters / Seconds) at the cursor — the Premiere/REAPER/
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
                { pan: clamped.pan + dx, pxPerM: clamped.pxPerM },
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
            const k = e.key.toLowerCase();
            if (k === "z") {
                e.preventDefault();
                if (e.shiftKey) redo(history, ecs);
                else undo(history, ecs);
            } else if (k === "y") {
                e.preventDefault();
                redo(history, ecs);
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
        if (editor.force !== null) {
            if (e.key === "Escape") {
                // dismissal peels one layer: deselect the handle first (back to the keyframe
                // readout), then exit handle edit (keep the point selected), then clear the
                // selection. the force menu takes Escape before this (capture).
                e.preventDefault();
                if (editor.forceHandle !== null) selectForceHandle(null);
                else if (editor.forceEdit !== null) exitForceEdit();
                else selectForce(null);
            } else if (e.key === "Delete" || e.key === "Backspace") {
                e.preventDefault();
                deleteSelectedForce();
            } else if (
                editor.hover === "timeline" &&
                (e.key === "ArrowLeft" ||
                    e.key === "ArrowRight" ||
                    e.key === "ArrowUp" ||
                    e.key === "ArrowDown")
            ) {
                // arrow-nudge the selected force set — only while the pointer is over the timeline (the
                // hovered-surface router — a node nudge in the viewport must not also move a force
                // point). single-select rounds the absolute result to the field grid (pre-multiselect
                // semantics); a multi-set moves by one shared delta under the rigid clamp, offsets
                // preserved (`nudgeForces`, timeline.ts). Shift coarse; one press = one undo entry.
                const members = forcePts.filter((fp) => editor.forces.ids.has(fp.id));
                if (members.length === 0) return;
                e.preventDefault();
                const stepS = e.shiftKey ? NUDGE_S_COARSE : NUDGE_S;
                const stepG = e.shiftKey ? NUDGE_G_COARSE : NUDGE_G;
                const ds = e.key === "ArrowLeft" ? -stepS : e.key === "ArrowRight" ? stepS : 0;
                const dg = e.key === "ArrowUp" ? stepG : e.key === "ArrowDown" ? -stepG : 0;
                beginForceMoves(
                    ecs,
                    members.map((m) => m.id),
                );
                for (const w of nudgeForces(members, ds, dg)) setForcePoint(ecs, w.id, w.s, w.g);
                commit(history);
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
            k.xView = (): [number, number] => [view.pan, view.pxPerM];
            // the basis the chart READS (the effective one, so it reports the no-bake fallback
            // honestly), and every keyframe's coordinate IN it — paired with the stored s the flow
            // asserts held, since the honest-slide assertion is exactly "s the same, u different"
            // across an upstream speed edit. Tick-derived, so a flow polls it.
            k.basis = (): string => (basis === Basis.Time ? "time" : "distance");
            k.forceU = (): { id: number; s: number; u: number }[] =>
                forcePts.map((p) => ({ id: p.id, s: p.s, u: uOf(p.startS + p.s) }));
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
                delete k.basis;
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
         governs. The timeline basis (Meters/Seconds) lives on the RULER's own context menu, not
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
                    oncontextmenu={chartCtx}
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
                        {@const x0 = markerX(c.s0)}
                        {@const x1 = markerX(c.s1)}
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
                        {@const my = yOf(p.g)}
                        <g class="fpt" class:sel={selForceSet.has(p.id)} class:active={p.id === selForce}>
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
                {@const dText = fmt(uOf(selPoint.startS + selPoint.s), 1)}
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
                            step={timeBasis ? 0.1 : 1}
                            min={uOf(selPoint.startS)}
                            value={dText}
                            onchange={onFieldPos}
                            onfocus={(e) => e.currentTarget.select()}
                            onkeydown={(e) => fieldKeydown(e, dText)}
                            aria-label={timeBasis ? "Point time (s)" : "Point distance (m)"}
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
    style="bottom: {DOCK_INSET + DOCK_HEIGHT + PLAYER_GAP}px;"
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
     right-click on a diamond or the curve span (the leading keyframe), an instance of the
     shared menu language (Menu.svelte) at the cursor. rendered at the component root so it
     floats over the dock; the same look + placement as the section context menu. -->
{#if fmenu}
    <div class="fmenu menu" use:fitMenu={{ x: fmenu.x, y: fmenu.y }} role="menu" aria-label="Force keyframe">
        <Menu items={fmenuItems} onclose={closeForceMenu} />
    </div>
{/if}

<!-- the ruler context menu (Meters / Seconds — the timeline basis), summoned by right-clicking
     the ruler scrub zone: the same shared menu language, at the cursor. -->
{#if rmenu}
    <div class="rmenu menu" use:fitMenu={{ x: rmenu.x, y: rmenu.y }} role="menu" aria-label="Timeline basis">
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
       a column, so the basis toggle stacks under the magnet. */
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
        transition: opacity 120ms ease, color 120ms ease, background 120ms ease;
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
        animation: tip-in 120ms ease;
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
        transition: background 120ms ease;
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
        transition: color 120ms ease, background 120ms ease;
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
        transition: opacity 150ms ease;
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
        transition: background 120ms ease;
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
        transition: fill 100ms ease;
    }
    .fpt:hover .fmarker {
        fill: #fff;
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

    /* the summoned tangent handles on the edited force keyframe (the force analogue of the
       geo tangent-edit handles): a thin accent arm to each knob, a filled knob when the
       handle is explicit / hollow when it's the derived (ghost) flat tangent. the wide
       invisible .thit carries the grab. grab cursor — a handle initiates a drag. */
    .tarm {
        stroke: var(--accent);
        stroke-width: 1;
        opacity: 0.65;
        pointer-events: none;
    }
    .thit {
        fill: transparent;
        pointer-events: all;
        cursor: grab;
        outline: none; /* pointer-only (tabindex -1); no browser focus ring on click */
    }
    .thit:active {
        cursor: grabbing;
    }
    .tknob {
        fill: var(--accent);
        stroke: #0e0d0c;
        stroke-width: 1;
        pointer-events: none; /* the fat hit circle owns the interaction */
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
        transition: fill 120ms ease, stroke 120ms ease;
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
        transition: fill 100ms ease;
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
        transition: background 120ms ease, color 120ms ease;
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
    /* the append flyout: an instance of the shared `.menu` language, root-mounted and placed by
       `fitMenu` (left/top written by the action) — the same fixed-position, viewport-flipping
       treatment as the force keyframe menu, so the dock's `overflow: hidden` can't clip it. */
    .clip-flyout {
        position: fixed;
        min-width: 62px;
        z-index: 10;
        animation: tip-in 120ms ease;
    }

    /* the snap-increment popover: the shared `.menu` surface hosting two `.fld` rows (the field
       idiom — key · value · unit, transparent inputs, a focus row wash), root-mounted and fixed
       like the append flyout so the dock's clip can't swallow it. */
    .snap-pop {
        position: fixed;
        z-index: 10;
        animation: tip-in 120ms ease;
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
        animation: tip-in 120ms ease;
    }

    /* the ruler context menu (Meters / Seconds): the same instance, narrower — two flat rows,
       no submenu marker to leave room for. */
    .rmenu {
        position: fixed;
        z-index: 10;
        min-width: 104px;
        animation: tip-in 120ms ease;
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
        height: 36px;
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
        transition: background 120ms ease, transform 80ms ease;
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
        transition: transform 100ms ease;
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
