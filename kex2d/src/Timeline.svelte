<script lang="ts">
import type { State } from "@dylanebert/shallot";
import { onMount, untrack } from "svelte";
import { cartState, forceCurve, parkAtArc, parkFromTime, trackMapping } from "./cart";
import { kindSegments } from "./colors";
import type { MenuItem } from "./menu";
import {
    beginDrag,
    editor,
    endDrag as endDragGesture,
    openContext,
    selectForce,
    selectSection,
    snapActive,
} from "./editor";
import {
    appendSection,
    beginForceMove,
    beginLength,
    cancel,
    commit,
    createForce,
    deleteForce,
    history,
    redo,
    undo,
} from "./history";
import {
    clampView,
    creationTargets,
    frameAll,
    type Mapping,
    marginArc,
    navDragView,
    navWindow,
    niceStep,
    pxToS,
    snap,
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
import { sampleForce } from "./profile";
import {
    bakeOut,
    MIN_FORCE_LEN,
    SectionKind,
    sectionForces,
    sections,
    sectionSpans,
    setForcePoint,
    setSectionLength,
} from "./track";
import { DOCK_HEIGHT, DOCK_INSET, resize } from "./view";

const { ecs, eid, tick }: { ecs: State; eid: number | null; tick: number } = $props();

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
// yView effect's drag branch) can re-map it through a grown axis. shift constrains
// to the dominant axis (the AE/Photoshop rule), measured from the grab.
let dragForce: number | null = $state(null);
let grabDs = 0; // point s − cursor s, so grabbing off-center doesn't snap
let dragStartS = 0; // the dragged point's section cumulative start (fixed during the drag)
let dragLen = 0; // the dragged point's section extent (the s clamp domain)
let dragCx = 0; // last cursor, canvas-local px
let dragCy = 0;
let dragShift = false;
let dragMod = false; // Ctrl/Cmd held (live) — the snap bypass modifier
let dragX0 = 0; // grab cursor + grab values — the shift-constrain anchor
let dragY0 = 0;
let dragS0 = 0;
let dragG0 = 0;
function applyDrag(): void {
    if (dragForce === null) return;
    // both axes clamp the cursor to the chart: the view never moves under a drag,
    // so past an edge the point rides it (y follows only as the edge-grow expands).
    const cx = clamp(dragCx, LEFT_GUT, Math.max(LEFT_GUT, w));
    // cursor cumulative s + grab → the point's cumulative s, then − startS → local.
    let s = clamp(pxToS(clamped, cx - LEFT_GUT) + grabDs - dragStartS, 0, dragLen);
    let g = yToG(clamp(dragCy, TOP, h - BOT_PAD));
    let lockS = false;
    let lockG = false;
    if (dragShift) {
        // lock to whichever axis has moved further since the grab; the other holds
        if (Math.abs(dragCx - dragX0) >= Math.abs(dragCy - dragY0)) {
            g = dragG0;
            lockG = true;
        } else {
            s = dragS0;
            lockS = true;
        }
    }
    // magnet snap each free axis to the nearest target within SNAP_PX, flashing a guide
    // at the hit (the AE magnet). a Ctrl/Cmd bypass inverts the toggle for the gesture.
    snapX = null;
    snapY = null;
    if (snapActive(dragMod)) {
        if (!lockS) {
            const hit = snap(
                sToPx(clamped, dragStartS + s),
                sTargets({ exclude: dragForce, playhead: true, trackEnd: true }),
            );
            if (hit !== null) {
                const local = pxToS(clamped, hit) - dragStartS;
                if (local >= 0 && local <= dragLen) {
                    s = local; // only latch a target the point can actually reach in its section
                    snapX = hit;
                }
            }
        }
        if (!lockG) {
            const hit = snap(yOf(g), gTargets(dragForce));
            if (hit !== null) {
                g = yToG(hit);
                snapY = hit;
            }
        }
    }
    setForcePoint(ecs, dragForce, s, g);
}
function forceDown(e: PointerEvent, p: ForcePt): void {
    e.preventDefault();
    e.stopPropagation(); // don't also deselect via the chartzone below
    const rect = canvas.getBoundingClientRect();
    dragCx = e.clientX - rect.left;
    dragCy = e.clientY - rect.top;
    dragShift = e.shiftKey;
    dragMod = e.ctrlKey || e.metaKey;
    dragX0 = dragCx;
    dragY0 = dragCy;
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
    dragShift = e.shiftKey; // live: shift can be pressed/released mid-drag
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
    fitPending = clips.length; // reveal the appended section once its re-bake lands
    selectSection(appendSection(history, ecs, kind));
}
// the append flyout as data, one instance of the shared menu language. both choices are
// always possible (a chain end always accepts a geo or force section), so neither declares
// enablement — the substrate carries it, this menu just has nothing to disable.
const appendItems: MenuItem[] = [
    { label: "Geo", aria: "Append geometry section", action: () => append(SectionKind.Geo) },
    { label: "Force", aria: "Append force section", action: () => append(SectionKind.Force) },
];
// appending adds to the chain end, off the right of the framed view. once the new
// section's re-bake lands (the section COUNT grows past the value captured at append), PAN
// — not zoom — so the new clip shows: the x-axis is a document axis, so a content edit
// never rescales it. clampView caps pan at the right-aligned track end. keying on the count
// (not an arclength delta) means a zero-length append still clears the flag, so it can't
// linger and fire a stale pan on a later unrelated edit.
let fitPending: number | null = $state(null);
$effect(() => {
    if (fitPending === null) return;
    if (chartW > 0 && sTotal > 0 && clips.length !== fitPending) {
        view = clampView({ pan: Number.MAX_VALUE, pxPerM: clamped.pxPerM }, chartW, sTotal);
        fitPending = null;
    }
});
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
            ctx.fillText(`${gv.toFixed(dec)}g`, LEFT_GUT - 6, y);
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
                if (e.shiftKey) redo(history);
                else undo(history);
            } else if (k === "y") {
                e.preventDefault();
                redo(history);
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
                e.preventDefault();
                selectForce(null);
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
                                <text class="clip-label" x={(x0 + x1) / 2} y={RULER_H + GAP_H / 2}>
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
        </svg>
        <!-- the selected point's typed s/g fields: a popover summoned AT the diamond
             (on the object, not a docked row). it follows a live drag as the value
             readout, pointer-inert so it never fights the drag; flips below the point
             near the chart top; clamps inside the chart horizontally. -->
        {#if selPoint}
            {@const mx = ptX(selPoint)}
            {#if scrubFreeze !== null || (mx >= LEFT_GUT - FHIT_R && mx <= w + FHIT_R)}
                {@const ax =
                    scrubFreeze?.x ??
                    clamp(mx, LEFT_GUT + TIP_HALF, Math.max(LEFT_GUT + TIP_HALF, w - TIP_HALF))}
                {@const ay = scrubFreeze?.y ?? clamp(yOf(selPoint.g), TOP, h - BOT_PAD)}
                {@const dText = (selPoint.startS + selPoint.s).toFixed(1)}
                {@const gText = selPoint.g.toFixed(2)}
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
                        +
                    </button>
                    {#if appendOpen}
                        <div class="clip-flyout menu" role="menu">
                            {#each appendItems as item (item.label)}
                                <button
                                    type="button"
                                    class="menu-item"
                                    class:danger={item.danger}
                                    role="menuitem"
                                    aria-label={item.aria}
                                    disabled={item.enabled === false}
                                    aria-disabled={item.enabled === false || undefined}
                                    onpointerdown={item.action}
                                >
                                    <span>{item.label}</span>
                                    {#if item.shortcut}<span class="sk">{item.shortcut}</span>{/if}
                                </button>
                            {/each}
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
        flex-direction: column;
        background: var(--bg-solid);
        border: 1px solid var(--border);
        border-radius: 6px;
        box-shadow: var(--shadow);
        font-family: "Outfit", system-ui, sans-serif;
        user-select: none;
        -webkit-user-select: none;
        overflow: hidden;
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
        grid-template-columns: 14px 48px 12px;
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
    :global([data-dragging]) .nav-window,
    :global([data-dragging]) .ptip,
    :global([data-dragging]) .play,
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

    /* the snap guide flash: a thin alignment line at a latched axis (the Figma idiom), in
       the dedicated snap color so it reads apart from kind / infeasible / selection. */
    .snapguide {
        stroke: var(--snap);
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
        font-size: 15px;
        line-height: 1;
        cursor: pointer;
        transition: background 120ms ease, color 120ms ease;
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
