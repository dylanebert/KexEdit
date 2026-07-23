<script lang="ts">
import type { State } from "@dylanebert/shallot";
import { onMount, untrack } from "svelte";
import { cartState, forceCurve, parkAtArc, parkFromTime, trackMapping } from "./cart";
import { kindSegments } from "./colors";
import Menu from "./Menu.svelte";
import { fitMenu, type MenuItem } from "./menu";
import {
    beginDrag,
    closeForceMenu,
    editor,
    endDrag as endDragGesture,
    enterForceEdit,
    exitForceEdit,
    openContext,
    openForceMenu,
    selectForce,
    selectForceHandle,
    selectSection,
    snapActive,
    toggleSnap,
} from "./editor";
import {
    appendSection,
    beginForceMove,
    beginForceTangent,
    beginLength,
    cancel,
    commit,
    createForce,
    deleteForce,
    history,
    materializeCustom,
    redo,
    setForceEase,
    undo,
} from "./history";
import {
    clampView,
    creationTargets,
    fmt,
    frameAll,
    G_GRID,
    type Mapping,
    marginArc,
    navDragView,
    navWindow,
    niceStep,
    nodeTickPx,
    pxToS,
    S_GRID,
    snap,
    snapAxis,
    sToPx,
    ticks,
    timeToArc,
    trimTargets,
    type View,
    xGrow,
    yFit,
    type YFit,
    yGrow,
    zoomAt,
} from "./timeline";
import { latchAngle } from "./controls";
import { autoTangent, Easing, type ForcePoint, type Offset, sampleForce, segmentControls } from "./profile";
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
// reference comfort limits (g) — drawn as faint lines to read the force curve against.
const BAND: [number, number] = [-2, 6];
// the initial y-frame before real data arrives: the reference band + 1g headroom.
const Y_HEADROOM = 1;
const CAP_LO = BAND[0] - Y_HEADROOM;
const CAP_HI = BAND[1] + Y_HEADROOM;
const Y_BASE = 1; // gravity baseline (1g)
const ZOOM_DIV = 200; // wheel-delta → geometric zoom rate
const FMARKER_R = 5; // px; the force-point diamond's half-diagonal (visual)
const NODE_TICK_R = 3; // px; a geo section's read-only node-tick circle radius (visual)
const FHIT_R = 12; // px; the invisible grab/hover radius around a force point (fat pick zone)
const TIP_HALF = 52; // px; half the point popover's width — clamps it inside the chart
const TIP_FLIP = 64; // px; a point nearer than this to the chart top flips the popover below
// arrow-nudge steps for the selected force point (AE): s in meters, g in g, Shift coarse.
// fixed-domain steps (the timeline authors in the invariant distance domain), rounded to
// the field's displayed precision so a nudge lands clean.
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
// while the section-end handle drags, the chart's total arclength FREEZES at its
// high-water mark so the pan clamp never shifts the view under the cursor during a
// shorten (the same "nothing moves under its own gesture" law as the keyframe y-fit
// freeze). captured at drag start, cleared on release. the x-scale never re-fits — that
// is clampView's job now, not the freeze's.
let sFrozen: number | null = $state(null);

const clamp = (x: number, lo: number, hi: number): number => Math.min(Math.max(x, lo), hi);

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
// the chart insets past the left g-gutter; the distance affine lives in [LEFT_GUT, w],
// so every timeline.ts call takes `chartW` and screen-X adds/subtracts LEFT_GUT.
const chartW = $derived(Math.max(0, w - LEFT_GUT));
const clamped = $derived(clampView(view, chartW, sFrozen ?? sTotal));
const tickList = $derived(ticks(clamped, chartW));

// the cart↔chart projection: the cart rides in time, the chart is distance.
const mapping = $derived.by((): Mapping | null => {
    void tick;
    return eid === null ? null : trackMapping(eid);
});
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
    const x = LEFT_GUT + sToPx(clamped, cartS);
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
    return yFit(lo, hi, Y_BASE);
});

// the *displayed* g-range. `yTarget` is a stable default frame that only expands to
// fit data (it never hugs tight), and `yView` approaches it ASYMMETRICALLY: it grows
// fast and contracts lazily — the AE/Unity "grow when content needs it, never snap
// back" feel, smoothed for the web.
let yView: YFit = $state({ lo: CAP_LO, hi: CAP_HI, step: 1 });
let yInit = false;
const Y_OUT = 0.3; // per-frame approach when EXPANDING the view (snappy)
const Y_IN = 0.05; // per-frame approach when CONTRACTING (lazy — no snap-back)
const EDGE_RATE = 0.2; // edge-scroll speed (∝ px past the edge); a by-eye feel constant
$effect(() => {
    void tick; // the ONLY dependency: one run per animation frame
    // untracked: the body reads + writes yView, so a tracked read would make the
    // effect depend on its own write and loop. tick alone paces it.
    untrack(() => {
        const t = yTarget;
        const cur = yView;
        if (!yInit) {
            yView = t; // first valid range appears instantly, no ease-in from the seed
            yInit = true;
            return;
        }
        if (dragForce !== null) {
            // drag mode: the axis HOLDS during a keyframe drag — the live re-bake
            // must never re-fit the view under the held cursor — until the cursor
            // is dragged PAST the chart edge, where yGrow edge-scrolls to follow
            // (speed ∝ overshoot, per frame — the standard drag auto-scroll rule).
            // auto-fit resumes on release and eases to the new curve's range.
            const grown = yGrow(cur, dragCy, TOP, h - BOT_PAD, EDGE_RATE, [CAP_LO, CAP_HI]);
            if (grown !== cur) {
                yView = grown;
                applyDrag(); // re-map the held cursor through the grown axis → the point follows
            }
            return;
        }
        if (draggingLen) return; // a length resize holds the y-axis too (no re-fit under the drag)
        if (dragTan !== null) return; // a handle drag reshapes the curve — hold the axis under it
        // grow toward an out-of-view bound fast; ooze back from an over-wide one slow.
        const lo = cur.lo + (t.lo - cur.lo) * (t.lo < cur.lo ? Y_OUT : Y_IN);
        const hi = cur.hi + (t.hi - cur.hi) * (t.hi > cur.hi ? Y_OUT : Y_IN);
        const span = Math.max(1e-6, hi - lo);
        const nlo = Math.abs(lo - t.lo) < span * 1e-3 ? t.lo : lo; // snap when within ε
        const nhi = Math.abs(hi - t.hi) < span * 1e-3 ? t.hi : hi;
        const step = niceStep((nhi - nlo) / 5); // step from the displayed span, not the target
        if (nlo !== cur.lo || nhi !== cur.hi || step !== cur.step)
            yView = { lo: nlo, hi: nhi, step };
    });
});

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
// node's landing sample (`nodeTickPx`, timeline.ts). Display + selection-highlight
// only — no hit-testing, no drag: a node's timeline position is DERIVED from
// geometry, and dragging it on this axis is the rejected inverse problem (spec
// `kex2d-geo-ux.md`'s locked decision). Node 0 (the entry) and the section's last
// baked node (the exit) sit exactly at the clip's own edges — already drawn by the
// clip strip and the boundary guides — so only orders `[1, bakedNodes-2]` tick; an
// orphan node past `bakedNodes` (a truncated bake, stale `.sample`) is excluded too.
interface NodeTick {
    eid: number;
    px: number; // chart-local px (pre-LEFT_GUT), like markerX's internal
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
            const px = nodeTickPx(clamped, c.s0, out.ds, info.startSample, Handle.sample.get(heid));
            res.push({ eid: heid, px, sel: heid === sel, sec: c.id });
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
// the selected section id (read through the per-RAF tick; editor is plain state).
const selSection = $derived.by((): number | null => {
    void tick;
    return editor.section;
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
const markerX = (s: number): number => LEFT_GUT + sToPx(clamped, s);
// a force point's chart x — its section-local s placed at its section's cumulative
// offset. points are authored local; the chart draws whole-track cumulative.
const ptX = (p: ForcePt): number => markerX(p.startS + p.s);

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
function sTargets(opts: { exclude?: number; playhead: boolean; trackEnd: boolean }): number[] {
    const v = clamped;
    const out: number[] = [sToPx(v, 0)];
    for (const b of bounds) out.push(sToPx(v, b));
    if (opts.trackEnd) out.push(sToPx(v, sTotal));
    for (const p of forcePts) if (p.id !== opts.exclude) out.push(sToPx(v, p.startS + p.s));
    if (opts.playhead && paused && cartS !== null) out.push(sToPx(v, cartS));
    return out;
}
// the g-axis snap targets in chart py (the vertical magnet): content landmarks only
// (editor-ui.md) — the 1g baseline (the physical gravity landmark) + every other point's
// g. no integer-g gridline raster: 1g survives as a physical baseline, not as a gridline.
function gTargets(exclude?: number): number[] {
    const out: number[] = [yOf(Y_BASE)];
    for (const p of forcePts) if (p.id !== exclude) out.push(yOf(p.g));
    return out;
}

// chart-local pointer coords (px from the canvas top-left, past the g-gutter for x).
function chartS(e: MouseEvent): number {
    const rect = canvas.getBoundingClientRect();
    return clamp(pxToS(clamped, e.clientX - rect.left - LEFT_GUT), 0, sTotal);
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
        const targets = creationTargets(clamped, bounds, sTotal, paused && cartS !== null ? cartS : null);
        const hit = snap(sToPx(clamped, cumS), targets);
        if (hit !== null) cumS = clamp(pxToS(clamped, hit), 0, sTotal);
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
let dragForce: number | null = $state(null);
let grabDs = 0; // point s − cursor s, so grabbing off-center doesn't snap
let dragStartS = 0; // the dragged point's section cumulative start (fixed during the drag)
let dragLen = 0; // the dragged point's section extent (the s clamp domain)
let dragCx = 0; // last cursor, canvas-local px
let dragCy = 0;
let dragMod = false; // Ctrl/Cmd held (live) — the snap bypass modifier
let dragS0 = 0; // the grab s / g — each axis's gesture-start landmark (always-on magnet)
let dragG0 = 0;
function applyDrag(): void {
    if (dragForce === null) return;
    // both axes clamp the cursor to the chart: the view never moves under a drag,
    // so past an edge the point rides it (y follows only as the edge-grow expands).
    const cx = clamp(dragCx, LEFT_GUT, Math.max(LEFT_GUT, w));
    // cursor cumulative s + grab → the point's cumulative s, then − startS → local.
    let s = clamp(pxToS(clamped, cx - LEFT_GUT) + grabDs - dragStartS, 0, dragLen);
    let g = yToG(clamp(dragCy, TOP, h - BOT_PAD));
    // resolve each axis through the landmark-over-grid magnet (`snapAxis`, timeline.ts). Each
    // axis carries an always-on gesture-start landmark (the grab s / g, the direction-intent
    // affordance) passed as `startPx`, so it magnetizes even under the Ctrl/Cmd bypass: a plain
    // drag snaps grid + value landmarks + the axis magnet, a Ctrl drag frees values but keeps
    // the axis pin. Only a landmark flashes a guide — the grid is ambient.
    snapX = null;
    snapY = null;
    const active = snapActive(dragMod);
    {
        const cumS = dragStartS + s;
        const targets = sTargets({ exclude: dragForce, playhead: true, trackEnd: true });
        const startPx = sToPx(clamped, dragStartS + dragS0); // gesture-start s landmark
        const r = snapAxis(active, sToPx(clamped, cumS), cumS, targets, S_GRID, (px) =>
            pxToS(clamped, px), startPx);
        const local = r.value - dragStartS;
        if (r.guide !== null) {
            // a landmark: only latch one the point can actually reach in its section
            if (local >= 0 && local <= dragLen) {
                s = local;
                snapX = r.guide;
            }
        } else {
            s = clamp(local, 0, dragLen); // grid (or bypass) — quantized, kept in the section
        }
    }
    {
        const targets = gTargets(dragForce);
        const r = snapAxis(active, yOf(g), g, targets, G_GRID, (py) => yToG(py), yOf(dragG0));
        g = r.value;
        snapY = r.guide;
    }
    setForcePoint(ecs, dragForce, s, g);
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
    if (lastFdownId === p.id && e.timeStamp - lastFdownT < FDBL_MS) {
        lastFdownT = 0;
        lastFdownId = -1;
        enterForceEdit(p.id); // second press on the same diamond → summon its handles
        return;
    }
    lastFdownT = e.timeStamp;
    lastFdownId = p.id;
    const rect = canvas.getBoundingClientRect();
    dragCx = e.clientX - rect.left;
    dragCy = e.clientY - rect.top;
    dragMod = e.ctrlKey || e.metaKey;
    dragS0 = p.s;
    dragG0 = p.g;
    dragStartS = p.startS; // the point's section is fixed while its s is dragged inside it
    dragLen = p.len;
    grabDs = p.startS + p.s - chartS(e); // cumulative grab offset (point − cursor)
    beginForceMove(ecs, p.id);
    dragForce = p.id;
    selectForce(p.id);
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
// the derived flat tangent offsets (dg = 0): the OUT handle reaches forward by this
// keyframe's own easing influence over the following span; the IN handle backward by the
// PREVIOUS keyframe's influence over the preceding span (easing governs the following
// segment, so a side's flat length comes from the tag that owns its segment).
function derivedOut(pt: ForcePt, next: ForcePt): Offset {
    return autoTangent(forceEase(ecs, pt.id), next.s - pt.s, "out");
}
function derivedIn(pt: ForcePt, prev: ForcePt): Offset {
    return autoTangent(forceEase(ecs, prev.id), pt.s - prev.s, "in");
}

let dragTan: { id: number; side: "in" | "out" } | null = $state(null);
let tanGrabDx = 0; // knob screen x − cursor x at grab (relative tracking, no jump)
let tanGrabDy = 0;
const THDRAG_PX = 4; // click-vs-drag dead zone on a handle knob (the Figma/Blender threshold)
let tanDownX = 0; // grab client coords — the dead-zone origin for the click-vs-drag test
let tanDownY = 0;
let tanMoved = false; // the gesture crossed the dead zone → a drag, not a select-click
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
    // click-vs-drag: selection is decided on release (below) by whether the pointer moved past
    // the dead zone — a click selects the handle (swaps the readout to it), a drag reshapes it.
    tanDownX = e.clientX;
    tanDownY = e.clientY;
    tanMoved = false;
    beginForceTangent(ecs, pt.id);
    dragTan = { id: pt.id, side: hnd.side };
    beginDrag(canvas, e.pointerId);
    window.addEventListener("pointermove", tanMove);
    window.addEventListener("pointerup", tanUp);
    window.addEventListener("pointercancel", tanUp); // finalize the history gesture on cancel too
}
function tanMove(e: PointerEvent): void {
    if (dragTan === null) return;
    if (!tanMoved && Math.hypot(e.clientX - tanDownX, e.clientY - tanDownY) > THDRAG_PX)
        tanMoved = true;
    // the dead zone gates the WRITE, not just the release verdict: a sub-threshold jitter
    // during a click must not write a tangent (materializing a ghost to explicit + recording
    // a stray history entry). no `applyTan` until the gesture is a real drag; below it, tanUp
    // resolves the release as a select-click.
    if (!tanMoved) return;
    const rect = canvas.getBoundingClientRect();
    applyTan(e.clientX - rect.left + tanGrabDx, e.clientY - rect.top + tanGrabDy);
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
    // the dragged side's raw (Δs, Δg) from the latched cursor; composeTangent applies the
    // x-monotonicity clamp, the derived seed, and Aligned coupling — the one write path.
    const cumS = pxToS(clamped, clamp(cx, LEFT_GUT, Math.max(LEFT_GUT, w)) - LEFT_GUT);
    const ds = cumS - (pt.startS + pt.s);
    const dg = yToG(clamp(cy, TOP, h - BOT_PAD)) - pt.g;
    const tan = composeTangent(id, side, ds, dg);
    if (tan) setForceTangent(ecs, id, tan);
}
// resolve a keyframe's full explicit tangent after setting `side` to the (Δs, Δg) offset —
// the write both the handle drag and the typed handle field go through. applies (1) the
// x-monotonicity clamp (out reaches into [0, next−s], in into [−(s−prev), 0], so g(s) stays a
// function), (2) per-side materialization — only the dragged side becomes explicit, the
// un-edited side left exactly as it was (an absent side stays derived, the segment-scoped
// Custom model), and (3) Aligned coupling
// — the other side held collinear in chart pixels, keeping its own length (Blender aligned
// handles; screen px because the chart's s/g axes differ).
function composeTangent(id: number, side: "in" | "out", ds: number, dg: number): ForceTangent | null {
    const pt = forcePts.find((p) => p.id === id);
    if (!pt) return null;
    const pts = forcePts.filter((p) => p.section === pt.section).sort((a, b) => a.s - b.s);
    const idx = pts.findIndex((p) => p.id === id);
    const prev = idx > 0 ? pts[idx - 1] : null;
    const next = idx < pts.length - 1 ? pts[idx + 1] : null;
    if (side === "out") ds = clamp(ds, 0, next ? next.s - pt.s : 0);
    else ds = clamp(ds, prev ? -(pt.s - prev.s) : 0, 0);
    // per-side materialization: dragging a side makes THAT side explicit; the other side is
    // left exactly as it was (an absent side stays derived, so customizing one segment never
    // spuriously customizes the neighbour — the segment-scoped Custom model). the un-edited
    // side is seeded ONLY to feed the Aligned coupling, and coupling fires only when the other
    // side is ALSO already explicit (a derived partner has nothing to align to).
    const existing = forceTangent(ecs, id);
    const mode = existing?.mode ?? TangentMode.Aligned;
    let inn: Offset | undefined = existing?.in;
    let out: Offset | undefined = existing?.out;
    if (side === "out") out = { ds, dg };
    else inn = { ds, dg };
    if (mode === TangentMode.Aligned && inn && out) {
        const drag = side === "out" ? out : inn;
        const px = drag.ds * clamped.pxPerM;
        const py = -drag.dg * pyPerG;
        const len = Math.hypot(px, py);
        if (len > 1e-6) {
            const other = side === "out" ? inn : out;
            const olen = Math.hypot(other.ds * clamped.pxPerM, other.dg * pyPerG);
            const nx = (-px / len) * olen;
            const ny = (-py / len) * olen;
            const noff: Offset = { ds: nx / clamped.pxPerM, dg: -ny / pyPerG };
            if (side === "out") inn = noff;
            else out = noff;
        }
    }
    return { mode, in: inn, out };
}
function tanUp(): void {
    if (dragTan === null) return;
    const side = dragTan.side;
    dragTan = null;
    // a click (no dead-zone crossing) selects the handle — swaps the readout to it; a drag
    // reshaped it and leaves selection alone (so no handle popover overlaps the diamond after).
    if (!tanMoved) selectForceHandle(side);
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
// pick on this keyframe clears (setForceEase's segment-scoped clear).
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
// the menu as data: Delete, then (for a non-terminal keyframe) an Easing ▸ submenu — Linear |
// Cubic | Quintic (checked by the tag), a separator, then Custom. each row carries its real
// curve glyph (drawn from the same influence the segment uses, so the icon can't drift). Custom
// is both the derived-provenance indicator (checked when an explicit handle bounds the segment)
// AND a choice: picking it materializes the segment's handles from the derived ones and steps
// into handle edit; picking a preset clears them back to that preset — the way back up the
// layers is the list. the terminal keyframe governs no segment, so it shows Delete alone.
const fmenuItems = $derived.by((): MenuItem[] => {
    const m = editor.forceMenu;
    if (m === null) return [];
    const id = m.id;
    const del: MenuItem = { label: "Delete", shortcut: "Del", danger: true, action: () => deleteForce(history, ecs, id) };
    if (fmenuTerminal) return [del];
    const easeRow = (label: string, e: Easing): MenuItem => ({
        label,
        glyph: presetGlyph(e),
        checked: !fmenuCustom && fmenuEase === e,
        action: () => setForceEase(history, ecs, id, e),
    });
    return [
        del,
        {
            label: "Easing",
            children: [
                easeRow("Linear", Easing.Linear),
                easeRow("Cubic", Easing.Cubic),
                easeRow("Quintic", Easing.Quintic),
                { separator: true },
                { label: "Custom", glyph: customGlyph(id), checked: fmenuCustom, action: () => chooseCustom(id) },
            ],
        },
    ];
});
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
$effect(() => {
    if (fmenu === null) return;
    const onDown = (e: PointerEvent): void => {
        if ((e.target as HTMLElement | null)?.closest(".fmenu")) return;
        closeForceMenu();
    };
    const onEsc = (e: KeyboardEvent): void => {
        if (e.key === "Escape") {
            e.stopImmediatePropagation();
            closeForceMenu();
        }
    };
    window.addEventListener("pointerdown", onDown, { capture: true });
    window.addEventListener("keydown", onEsc, { capture: true });
    return () => {
        window.removeEventListener("pointerdown", onDown, { capture: true });
        window.removeEventListener("keydown", onEsc, { capture: true });
    };
});

// select a section by clicking its clip (the same `editor.section` the viewport span
// selects — one object, two surfaces). pointerdown so it feels immediate.
function selectClip(e: PointerEvent, c: Clip): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation(); // don't also scrub via the ruler zone beneath
    selectSection(c.id);
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
let appendOpen = $state(false);
function toggleAppend(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    appendOpen = !appendOpen;
}
function append(kind: SectionKind): void {
    appendOpen = false;
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
    if (!appendOpen) return;
    const close = (ev: PointerEvent): void => {
        const t = ev.target as HTMLElement | null;
        if (t?.closest(".clip-append")) return;
        appendOpen = false;
    };
    window.addEventListener("pointerdown", close, { capture: true });
    return () => window.removeEventListener("pointerdown", close, { capture: true });
});

// ── force-section extent: drag a force clip's RIGHT EDGE (in the strip) to resize the
// profile. the extent is the force section's own authored length, independent of
// the geo shape a convert came from — a convert resets it to a default, this sets it.
// reuses the keyframe-drag freeze machinery: sFrozen holds the chart's arclength so the
// pan clamp holds the view still under the drag (the x-scale never rescales — that's
// clampView's law), and xGrow edge-pans when the cursor is held past the chart edge. one
// undo entry per drag.
let lenId: number | null = $state(null); // the force section being resized, or null
const draggingLen = $derived(lenId !== null);
let lenStartS = 0; // the dragged section's cumulative start arclength (fixed during the drag)
let lenCx = 0; // last length-drag cursor, canvas-local px (drives the per-frame edge-pan)
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
    const cv = clampView(view, chartW, sFrozen ?? sTotal);
    let cumS = pxToS(cv, lenCx - LEFT_GUT);
    snapX = null;
    if (snapActive(lenMod)) {
        const ownS: number[] = [];
        for (const p of forcePts) if (p.section === lenId) ownS.push(p.startS + p.s);
        const targets = trimTargets(cv, ownS, paused && cartS !== null ? cartS : null);
        const hit = snap(lenCx - LEFT_GUT, targets);
        if (hit !== null) {
            const cand = pxToS(cv, hit);
            if (cand - lenStartS >= MIN_FORCE_LEN) {
                cumS = cand; // only latch a target the MIN_FORCE_LEN floor will actually honor
                snapX = hit;
            }
        }
    }
    setSectionLength(ecs, lenId, cumS - lenStartS); // cumulative − section start → local extent
}
function lenDown(e: PointerEvent, c: Clip): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = canvas.getBoundingClientRect();
    lenCx = e.clientX - rect.left;
    lenMod = e.ctrlKey || e.metaKey;
    lenStartS = c.s0; // upstream is unchanged by this resize, so the start is fixed
    selectSection(c.id); // grabbing the edge selects the section (one object, two surfaces)
    beginLength(ecs, c.id);
    lenId = c.id;
    sFrozen = sTotal; // freeze the pan-clamp total so the view holds still under the drag
    beginDrag(canvas, e.pointerId);
    window.addEventListener("pointermove", lenMove);
    window.addEventListener("pointerup", lenUp);
    window.addEventListener("pointercancel", lenUp); // finalize the history gesture on cancel too
}
function lenMove(e: PointerEvent): void {
    if (lenId === null) return;
    const rect = canvas.getBoundingClientRect();
    lenCx = e.clientX - rect.left;
    lenMod = e.ctrlKey || e.metaKey; // live: bypass can be toggled mid-drag
    applyLen();
}
function lenUp(): void {
    if (lenId === null) return;
    lenId = null;
    sFrozen = null; // release the in-drag freeze; the zoom never re-fits (no release refit) —
    snapX = null;
    commit(history); // clampView now only re-clamps pan to the live extent, never rescales
    window.removeEventListener("pointermove", lenMove);
    window.removeEventListener("pointerup", lenUp);
    window.removeEventListener("pointercancel", lenUp);
}
function cancelLenDrag(): void {
    if (lenId === null) return;
    lenId = null;
    sFrozen = null;
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
        if (sFrozen === null || sTotal > sFrozen) sFrozen = sTotal;
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
// the field speaks track-global d; convert back to the stored section-local s through
// the lens (s = d − the section's offset) before writing. fieldEdit clamps into [0, len].
function onFieldD(e: Event): void {
    if (!selPoint) return;
    const d = Number.parseFloat((e.currentTarget as HTMLInputElement).value);
    fieldEdit(d - selPoint.startS, selPoint.g);
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
    const tan = composeTangent(h.pt.id, h.side, ds, dg);
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
const SCRUB_G = 0.01; // g per px
// while a label scrubs, the popover's anchor FREEZES at its gesture-start position —
// a surface never moves under its own gesture (the point moves, the control stays
// put; it re-anchors to the point on release). also holds the popover visible if
// the scrub carries the diamond out of view.
let scrubFreeze: { x: number; y: number } | null = $state(null);
function scrubStart(e: PointerEvent, axis: "s" | "g"): void {
    const p = selPoint;
    if (p === null) return;
    e.preventDefault();
    const label = e.currentTarget as HTMLElement;
    beginDrag(label, e.pointerId);
    scrubFreeze = {
        x: clamp(ptX(p), LEFT_GUT + TIP_HALF, Math.max(LEFT_GUT + TIP_HALF, w - TIP_HALF)),
        y: clamp(yOf(p.g), TOP, h - BOT_PAD),
    };
    beginForceMove(ecs, p.id);
    let acc = axis === "s" ? p.s : p.g;
    const move = (ev: PointerEvent): void => {
        if (axis === "s") {
            acc = clamp(acc + ev.movementX * SCRUB_S, 0, p.len);
            setForcePoint(ecs, p.id, Math.round(acc * 10) / 10, p.g);
        } else {
            acc += ev.movementX * SCRUB_G;
            setForcePoint(ecs, p.id, p.s, Math.round(acc * 100) / 100);
        }
    };
    const up = (): void => {
        label.removeEventListener("pointermove", move);
        label.removeEventListener("pointerup", up);
        label.removeEventListener("pointercancel", up);
        scrubFreeze = null; // re-anchor to the point
        commit(history);
    };
    label.addEventListener("pointermove", move);
    label.addEventListener("pointerup", up);
    // a cancelled pointer must still close the gesture — a left-open one would
    // swallow the next edit (one gesture at a time).
    label.addEventListener("pointercancel", up);
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
    if (editor.force === null) return;
    // no explicit deselect: deleting the point makes `selPoint` derive null (the popover
    // dismisses by subject existence) and the $effect above clears the stale id. one mechanism.
    deleteForce(history, ecs, editor.force);
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
    view = clampView({ pan: pan0 - (e.clientX - panX0), pxPerM: clamped.pxPerM }, chartW, sTotal);
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
    eid === null || sTotal <= 0 || chartW <= 0 ? null : navWindow(clamped, chartW, sTotal),
);
let navDrag: { mode: "pan" | "l" | "r"; grab: number } | null = null;
function navSAt(clientX: number): number {
    const rect = navEl!.getBoundingClientRect();
    const total = sTotal + marginArc(sTotal);
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
    view = navDragView(clamped, chartW, sTotal, navDrag.mode, navSAt(e.clientX), navDrag.grab);
}
function navUp(): void {
    navDrag = null;
    window.removeEventListener("pointermove", navMove);
    window.removeEventListener("pointerup", navUp);
    window.removeEventListener("pointercancel", navUp);
}

function render(ctx: CanvasRenderingContext2D): void {
    const v = clamped;
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
        const x = LEFT_GUT + sToPx(v, bs);
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
                const x = LEFT_GUT + sToPx(v, curve.s[i]);
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
    const total = sTotal + marginArc(sTotal); // the bar spans the track + lead-out
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
            const x = (data.s[i] / total) * cw;
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
        view = frameAll(chartW, sTotal);
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
    let s = clamp(pxToS(clamped, e.clientX - rect.left - LEFT_GUT), 0, sTotal);
    if (snapActive(e.ctrlKey || e.metaKey)) {
        const hit = snap(sToPx(clamped, s), sTargets({ playhead: false, trackEnd: true }));
        if (hit !== null) s = clamp(pxToS(clamped, hit), 0, sTotal);
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
onMount(() => {
    const onWheel = (e: WheelEvent): void => {
        e.preventDefault();
        const x = e.clientX - canvas.getBoundingClientRect().left - LEFT_GUT; // chart-local anchor
        // curve-editor standard (Unity/AE): plain wheel zooms, shift+wheel pans.
        // a trackpad's horizontal axis pans too; pinch arrives as ctrl+wheel → zoom.
        const panH = e.shiftKey || (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaX) > Math.abs(e.deltaY));
        if (panH) {
            const dx = e.shiftKey ? e.deltaY : e.deltaX;
            view = clampView({ pan: clamped.pan + dx, pxPerM: clamped.pxPerM }, chartW, sTotal);
        } else {
            view = zoomAt(clamped, x, 2 ** (-e.deltaY / ZOOM_DIV), chartW, sTotal);
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
        // Ctrl/Cmd+F (browser find).
        if (
            (e.key === "f" || e.key === "F") &&
            !e.ctrlKey &&
            !e.metaKey &&
            editor.hover === "timeline"
        ) {
            if (chartW > 0 && sTotal > 0) {
                e.preventDefault();
                view = frameAll(chartW, sTotal);
            }
            return;
        }
        if (appendOpen && e.key === "Escape") {
            e.preventDefault();
            appendOpen = false;
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
                // arrow-nudge the point in its authoring domain (s = distance, g = force),
                // but only while the pointer is over the timeline (the hovered-surface
                // router — a node nudge in the viewport must not also move a force point).
                // Shift coarse; one press = one undo entry, routed through the setter.
                const p = selPoint;
                if (p === null) return;
                e.preventDefault();
                const ds = e.shiftKey ? NUDGE_S_COARSE : NUDGE_S;
                const dg = e.shiftKey ? NUDGE_G_COARSE : NUDGE_G;
                let s = p.s + (e.key === "ArrowLeft" ? -ds : e.key === "ArrowRight" ? ds : 0);
                let g = p.g + (e.key === "ArrowUp" ? dg : e.key === "ArrowDown" ? -dg : 0);
                s = Math.round(clamp(s, 0, p.len) * 10) / 10;
                g = Math.round(g * 100) / 100;
                beginForceMove(ecs, p.id);
                setForcePoint(ecs, p.id, s, g);
                commit(history);
            }
        }
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey);
    return () => {
        host.removeEventListener("wheel", onWheel);
        window.removeEventListener("keydown", onKey);
        endScrub(); // drop any in-flight scrub listeners if we unmount mid-drag
        sliderUp(); // and any in-flight player-slider drag
        panUp(); // and any in-flight middle-drag pan
        navUp(); // and any in-flight navigator drag
        cancelForceDrag(); // and any in-flight force-point drag
        cancelTanDrag(); // and any in-flight handle drag
        cancelLenDrag(); // and any in-flight extent drag
        endDragGesture(); // clear the drag flag if we tore down mid-drag (no release event)
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
         tool-strip precedent) — anatomy of the one earned dock, not a second docked region. it
         holds only persistent global authoring toggles with a keyboard twin; today just the snap
         magnet (lit when on / default, dimmed when off; `S` also toggles, Ctrl/Cmd bypasses
         per-gesture). it sits inside the dock's DOM, so it counts as the timeline surface for
         `editor.hover` (the aside's enter/leave already fired). -->
    <div class="tool-rail" aria-label="Timeline tools">
        <button
            class="rail-tool"
            class:on={snapOn}
            type="button"
            onclick={toggleSnap}
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
                    role="slider"
                    tabindex="0"
                    aria-label="Scrub playhead"
                    aria-valuemin={0}
                    aria-valuemax={Math.round(sTotal * 100) / 100}
                    aria-valuenow={Math.round((cartS ?? 0) * 100) / 100}
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
                    onpointerdown={(e) => {
                        if (e.button !== 0) return;
                        // layered dismissal: while a popover field is focused, a chart
                        // click only commits/blurs the field (the innermost transient
                        // layer, via the browser's own focus change); the NEXT click
                        // deselects the point and the section.
                        const ae = document.activeElement;
                        if (ae instanceof HTMLElement && ae.closest(".ptip")) return;
                        selectForce(null);
                        selectSection(null);
                    }}
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
                                class:sel={c.id === selSection}
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
                        {@const x = LEFT_GUT + nt.px}
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
                        <g class="fpt" class:sel={p.id === selForce}>
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
            {@const hx = clamp(selHandle.x, LEFT_GUT + TIP_HALF, Math.max(LEFT_GUT + TIP_HALF, w - TIP_HALF))}
            {@const hy = clamp(selHandle.y, TOP, h - BOT_PAD)}
            {@const sText = fmt(selHandle.ds, 2)}
            {@const hgText = fmt(selHandle.dg, 2)}
            <div
                class="ptip"
                class:below={hy < TOP + TIP_FLIP}
                class:dragging={dragTan !== null}
                style="left: {hx}px; top: {hy}px"
            >
                <div class="fld">
                    <span class="key static" role="presentation">Δs</span>
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
                    <span class="key static" role="presentation">Δg</span>
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
             near the chart top; clamps inside the chart horizontally. -->
        {:else if selPoint}
            {@const mx = ptX(selPoint)}
            {#if scrubFreeze !== null || (mx >= LEFT_GUT - FHIT_R && mx <= w + FHIT_R)}
                {@const ax =
                    scrubFreeze?.x ??
                    clamp(mx, LEFT_GUT + TIP_HALF, Math.max(LEFT_GUT + TIP_HALF, w - TIP_HALF))}
                {@const ay = scrubFreeze?.y ?? clamp(yOf(selPoint.g), TOP, h - BOT_PAD)}
                {@const dText = fmt(selPoint.startS + selPoint.s, 1)}
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
                            role="presentation">d</span
                        >
                        <input
                            type="number"
                            step="1"
                            min={selPoint.startS}
                            value={dText}
                            onchange={onFieldD}
                            onfocus={(e) => e.currentTarget.select()}
                            onkeydown={(e) => fieldKeydown(e, dText)}
                            aria-label="Point distance (m)"
                        />
                        <span class="unit">m</span>
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
                        class:open={appendOpen}
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
                    {#if appendOpen}
                        <div class="clip-flyout menu" role="menu">
                            <Menu items={appendItems} onclose={() => (appendOpen = false)} />
                        </div>
                    {/if}
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
       a column so a future global toggle stacks under the magnet. */
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
       full-row-height centered cell whose hit area extends to the row's edges (the
       negative-margin/padding pair), ew-resize + brighten/wash on hover. */
    .fld .key {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        align-self: stretch;
        margin: -4px 0 -4px -9px;
        padding: 4px 0 4px 9px;
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
    /* a static key label (the handle popover's Δs/Δg): typed entry only, no scrub — so no
       ew-resize cursor and no scrub-hover wash. */
    .fld .key.static {
        cursor: default;
    }
    .fld .key.static:hover {
        color: var(--muted);
        background: none;
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
    :global([data-dragging]) .nav-window,
    :global([data-dragging]) .ptip,
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

    /* the scrub zone: the whole top ruler + gap band. click/drag anywhere here moves
       the playhead. the body keeps the DEFAULT cursor — the editor-ruler convention
       (After Effects / animation-timeline: the ruler is default, not a resize edge). */
    .rulerzone {
        fill: transparent;
        pointer-events: all;
        cursor: default;
    }
    /* keyboard focus rings the playhead grip, not a full-width box on the ruler
       (mirrors the player slider's thumb focus ring) */
    .rulerzone:focus-visible {
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
    /* the append flyout: an instance of the shared `.menu` language (App.svelte) — only its
       anchored position, width, and entrance are its own. */
    .clip-flyout {
        position: absolute;
        top: 20px;
        left: -3px;
        min-width: 62px;
        z-index: 4;
        animation: tip-in 120ms ease;
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
