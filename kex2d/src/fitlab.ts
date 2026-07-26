// The geo→force fit research app (spec `kex/specs/kex2d-geoforce-spike.md` stages 4 + 4b). A
// standalone canvas2D + DOM page — no shallot, no GPU, no Svelte — over the pure kernel
// (`scenarios.ts` → `section.evalGeo` → `fit.ts` → `polish.ts` → `section.evalForce`):
//
//   1. the VIEWPORT overlay — the original baked geo polyline, the geometry the stage-2
//      warm start integrates into, and the geometry the current frame's profile really
//      integrates into through the live f32 `evalForce` path, both exits marked;
//   2. the FORCE graph — the dense recovered F_n the fit chased, the stage-2 warm start,
//      the current sparse profile's dense force, its keyframe diamonds, and every
//      keyframe's BEZIER HANDLES colored by whether the two sides are collinear through
//      the key. The y-range spans every playback frame, so inter-key overshoot
//      (valley-explicit reaches 40 g between keys at −6.5 and 2.6 g) is never clipped out;
//   3. the METRICS table — the whole corpus, solved exact on load: keys, iterations, wall
//      time, the reference exit gap, geometry deviation warm → polished, the dense peak
//      against the keyframe peak (their gap IS the overshoot), and the calm-mode violence
//      columns once the calm corpus is solved.
//
// The scrubber is ONE timeline across the whole pipeline, phase-segmented: the dense
// recovery it starts from, the fit (knots appearing under the split pass, then pruning
// away), then the polish iterations. Frames are what the kernel already decided —
// `fit().steps` and `polish().snapshots` — never a re-derivation here.
//
// Two things the second human check-in asked for, and why they are drawn the way they are:
//
//   - **handles, always visible.** The check-in could see the solved curve was ugly but not
//     WHY. A fitted keyframe carries independent per-side tangents (`fit.ts`: no C1
//     coupling), and the polish moves them independently too, so most keys end up BROKEN —
//     neither mirrored nor aligned, the editor's `Free` shape. Drawing them, red when
//     broken, makes the authorability cost of a geometrically-right answer legible.
//   - **exact vs calm, toggled** (`M`), with the other mode's final curve drawn as a ghost
//     once both exist. Calm mode's whole claim is that it buys a quiet profile for geometry
//     nobody can see, and that claim is a comparison, not a number.
//
// Read-only: nothing here authors. Served by vite at /fit-lab.html; captured by the
// Playwright harness, which drives the `window.__fitlab` hook below.

import { type FitStep, fit } from "./fit";
import { polish, type PolishMode, type PolishResult } from "./polish";
import { type ForcePoint, forceProfile } from "./profile";
import { type Scenario, scenarios } from "./scenarios";
import { type Entry, evalForce, evalGeo, type SectionResult } from "./section";
import { niceStep } from "./timeline";

/** the fit tolerance the spike locked: half the timeline's g authoring quantum
 *  (`fit.test.ts` — G_GRID/2), so a fitted curve is within half a grid step of the dense
 *  one everywhere. */
const FIT_TOL = 0.05;

const BLUE = "#5aa0d0";
const GOLD = "#e0a24a";
const FAINT = "#5a5248";
const GRID = "#2b261e";
const TEXT = "#9a9188";
const RED = "#d06a5a";
const GREEN = "#7fa87a";
/** the other mode's final curve. Violet because the graph's other four registers are
 *  taken: blue is the dense observation, gold the frame, red/green the handle states. */
const GHOST = "#9b7fc0";
const MONO = "10px 'JetBrains Mono', monospace";

const PANEL_W = 620;
const PANEL_H = 340;
/** playback pace: one frame per ~20 fps — fast enough to read as motion, slow enough that
 *  a 150-frame pipeline does not flash past. */
const FRAME_MS = 50;

/** a handle pair reads as collinear when the off-line tip sits within half a CSS pixel of
 *  the other side's ray. Derived from the display, which is where the judgment lives: a
 *  sub-pixel break is not a break anyone can see, and the (s, g) axes carry different
 *  units, so an angle in data space would be a made-up number. */
const ALIGN_PX = 0.5;

type Phase = "recover" | "fit" | "polish";

/** how a keyframe's two handles sit relative to each other — the editor's tangent-mode
 *  vocabulary (`editor-ui.md` Tangent editing), read off the drawn geometry. */
type HandleState = "mirror" | "aligned" | "broken" | "single";

interface HandleStats {
    mirror: number;
    aligned: number;
    broken: number;
    /** a chain end: one side only, so there is nothing to break. */
    single: number;
}

/** one scenario's row in the corpus table. */
interface Row {
    name: string;
    /** sparse keyframes the fit landed on. */
    keys: number;
    /** dense edges of the geo bake — `dense/keys` is the compression. */
    dense: number;
    /** structural decisions the fit made: splits + prunes + the opening piece. */
    steps: number;
    iters: number;
    outers: number;
    converged: boolean;
    /** wall time of fit + polish (ms). */
    ms: number;
    /** exit gap of the polished profile through the live f32 path (m). */
    exit: number;
    /** max geometry deviation of the WARM START through the live path (m). */
    warmDev: number;
    /** …and of the polished profile (m). */
    dev: number;
    /** max |F_n| the polished dense profile reaches (g). */
    peak: number;
    /** max |g| over its keyframes — under `peak` by exactly the inter-key overshoot. */
    keyPeak: number;
    /** the violence pins the authorability comparison turns on. */
    maxDg: number;
    mode: PolishMode;
    /** calm mode only: the Tikhonov weight, and whether the derived floor actually held. */
    lambda: number;
    heldFloor: boolean;
}

/** one playback frame. Frame 0 is the DENSE RECOVERY — the spiky observed curve, before any
 *  profile exists. Then one frame per `fit().steps` entry (the split pass adding knots, the
 *  prune pass taking them away; the last of them IS the warm start), then one per accepted
 *  polish step. Without the fit frames the scrubber would start mid-solve and the delta the
 *  spike is about (a 0.03 g fit landing 40 m off) would never be on screen. */
interface Frame {
    phase: Phase;
    label: string;
    /** null on the recovery frame — no profile exists there yet. */
    points: readonly ForcePoint[] | null;
    /** the dense force this frame's profile drives, on the uniform integration grid. */
    fN: ArrayLike<number> | null;
    /** the solver's dense spine at this step; null outside the polish phase. */
    snap: PolishResult["snapshots"][number] | null;
    /** the fit's own diagnostics at this step; null outside the fit phase. */
    step: FitStep | null;
}

/** a contiguous run of frames belonging to one pipeline phase — the segmented scrub bar. */
interface Segment {
    phase: Phase;
    label: string;
    start: number;
    end: number;
}

/** everything one scenario's panels draw from, for ONE polish mode. */
interface Solve {
    scenario: Scenario;
    mode: PolishMode;
    entry: Entry;
    bake: SectionResult;
    /** the bake's cumulative chord arclength, length `bake.edges + 1`. */
    sigma: Float64Array;
    out: PolishResult;
    /** max |fitted − dense| the stage-2 fit left behind (g). */
    fitError: number;
    /** the warm start's dense force on the polish's uniform grid. */
    warmDense: ArrayLike<number>;
    /** the geometry the warm start integrates into — the static "fit alone" reference. */
    warmGeom: SectionResult;
    /** the dense force of the FINAL profile — what the other mode draws as its ghost. */
    finalDense: Float32Array;
    frames: Frame[];
    segments: Segment[];
    /** index of the warm-start frame (the fit's last step). */
    warm: number;
    row: Row;
    /** force-graph range, over every frame (never re-fit per frame). */
    gLo: number;
    gHi: number;
    /** viewport bounds, over the bake and the polished geometry. */
    bounds: { minX: number; maxX: number; minY: number; maxY: number };
    /** per-frame integrated geometry through the live f32 path, filled on demand. */
    geom: (SectionResult | null)[];
}

function entryOf(v0: number): Entry {
    return { x: 0, y: 0, theta: 0, v: v0 };
}

/** THE REFERENCE MEASUREMENT: an integrated section against the original bake, by
 *  arclength. The bake is a polyline, so its point at arclength `a` is the linear
 *  interpolation along the chord containing `a` — the same check `tests/polish.test.ts`
 *  runs, recomputed here so the picture never takes the solver's word for the geometry it
 *  was aiming at. */
function measure(
    bake: SectionResult,
    sigma: Float64Array,
    res: SectionResult,
    ds: number,
): { dev: number; exit: number } {
    const total = sigma[bake.edges];
    let dev = 0;
    let i = 0;
    for (let j = 0; j <= res.edges; j++) {
        const a = Math.min(j * ds, total);
        while (i < bake.edges - 1 && sigma[i + 1] < a) i++;
        const span = sigma[i + 1] - sigma[i];
        const t = span > 0 ? Math.min(1, Math.max(0, (a - sigma[i]) / span)) : 0;
        const x = bake.posX[i] + t * (bake.posX[i + 1] - bake.posX[i]);
        const y = bake.posY[i] + t * (bake.posY[i + 1] - bake.posY[i]);
        dev = Math.max(dev, Math.hypot(res.posX[j] - x, res.posY[j] - y));
    }
    const exit = Math.hypot(
        res.posX[res.edges] - bake.posX[bake.edges],
        res.posY[res.edges] - bake.posY[bake.edges],
    );
    return { dev, exit };
}

/** bake → fit → polish → the reference round-trip, for one scenario in one mode. */
function run(scenario: Scenario, mode: PolishMode): Solve {
    const entry = entryOf(scenario.v0);
    const t0 = performance.now();
    const bake = evalGeo(entry, scenario.nodes, scenario.ds);
    const f = fit(bake.fN, bake.ds, FIT_TOL);
    const out = polish({ bake, entry, points: f.points, ds: scenario.ds, mode });
    const ms = performance.now() - t0;

    const sigma = new Float64Array(bake.edges + 1);
    for (let i = 0; i < bake.edges; i++) sigma[i + 1] = sigma[i] + bake.ds[i];

    // one frame per pipeline decision. The fit frames' dense arrays are built eagerly (a
    // `forceProfile` per step: ≤ 57 steps × ≤ 433 edges on the corpus, ~40 ms across all
    // ten against 1.3 s of solve) because the y-range below has to span them — a range
    // fitted to a subset would clip exactly the early wild pieces worth seeing.
    const frames: Frame[] = [
        {
            phase: "recover",
            label: "dense recovered F_n",
            points: null,
            fN: null,
            snap: null,
            step: null,
        },
    ];
    f.steps.forEach((step, i) => {
        frames.push({
            phase: "fit",
            label:
                i === 0
                    ? `fit · first piece · ${step.knots.length} keys`
                    : `fit · ${step.phase} ${i} · ${step.knots.length} keys`,
            points: step.points,
            fN: forceProfile(step.points, out.length, out.ds),
            snap: null,
            step,
        });
    });
    const warm = frames.length - 1;
    const warmDense = frames[warm].fN;
    if (!warmDense) throw new Error("fit produced no steps");
    for (const snap of out.snapshots) {
        frames.push({
            phase: "polish",
            label: `polish · iter ${snap.step}`,
            points: snap.points,
            fN: snap.fN,
            snap,
            step: null,
        });
    }

    const segments: Segment[] = [];
    frames.forEach((fr, i) => {
        const tail = segments[segments.length - 1];
        if (tail && tail.phase === fr.phase) tail.end = i;
        else segments.push({ phase: fr.phase, label: fr.phase, start: i, end: i });
    });
    for (const seg of segments) {
        const n = seg.end - seg.start + 1;
        seg.label =
            seg.phase === "recover"
                ? "recover"
                : seg.phase === "fit"
                  ? `fit · split → prune (${n})`
                  : `polish · ${mode} (${n})`;
    }

    const finalDense = forceProfile(out.points, out.length, out.ds);
    const warmGeom = evalForce(entry, warmDense, out.ds);
    const solved = evalForce(entry, finalDense, out.ds);

    let peak = 0;
    for (const g of finalDense) peak = Math.max(peak, Math.abs(g));
    let keyPeak = 0;
    for (const p of out.points) keyPeak = Math.max(keyPeak, Math.abs(p.g));

    // the force range spans EVERY frame plus both reference curves, so no panel ever clips
    // a spike the eye is here to see.
    let gLo = Number.POSITIVE_INFINITY;
    let gHi = Number.NEGATIVE_INFINITY;
    const sweep = (vals: ArrayLike<number>): void => {
        for (let i = 0; i < vals.length; i++) {
            gLo = Math.min(gLo, vals[i]);
            gHi = Math.max(gHi, vals[i]);
        }
    };
    sweep(bake.fN);
    sweep(finalDense);
    for (const fr of frames) if (fr.fN) sweep(fr.fN);
    const gPad = 0.06 * Math.max(gHi - gLo, 1e-3);

    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    const box = (xs: ArrayLike<number>, ys: ArrayLike<number>, n: number): void => {
        for (let i = 0; i <= n; i++) {
            minX = Math.min(minX, xs[i]);
            maxX = Math.max(maxX, xs[i]);
            minY = Math.min(minY, ys[i]);
            maxY = Math.max(maxY, ys[i]);
        }
    };
    box(bake.posX, bake.posY, bake.edges);
    box(solved.posX, solved.posY, solved.edges);

    const solvedM = measure(bake, sigma, solved, out.ds);
    const row: Row = {
        name: scenario.name,
        keys: out.keys,
        dense: bake.edges,
        steps: f.steps.length,
        iters: out.iters,
        outers: out.outers,
        converged: out.converged,
        ms,
        exit: solvedM.exit,
        warmDev: measure(bake, sigma, warmGeom, out.ds).dev,
        dev: solvedM.dev,
        peak,
        keyPeak,
        maxDg: out.maxDg,
        mode,
        lambda: out.lambda,
        heldFloor: out.heldFloor,
    };

    return {
        scenario,
        mode,
        entry,
        bake,
        sigma,
        out,
        fitError: f.maxError,
        warmDense,
        warmGeom,
        finalDense,
        frames,
        segments,
        warm,
        row,
        gLo: gLo - gPad,
        gHi: gHi + gPad,
        bounds: { minX, maxX, minY, maxY },
        geom: frames.map(() => null),
    };
}

/** the geometry frame `i`'s profile really integrates into — the live f32 `evalForce`
 *  path, not the solver's spine. Memoized per frame; null on the recovery frame, which has
 *  no profile to integrate. */
function geometryAt(s: Solve, i: number): SectionResult | null {
    const hit = s.geom[i];
    if (hit) return hit;
    const points = s.frames[i].points;
    if (!points) return null;
    const res = evalForce(s.entry, forceProfile(points, s.out.length, s.out.ds), s.out.ds);
    s.geom[i] = res;
    return res;
}

// ── the force graph's transform, shared by the drawing and the handle diagnostics ──

interface Chart {
    px: (s: number) => number;
    py: (g: number) => number;
    lo: number;
    hi: number;
}

const PAD_L = 46;
const PAD_B = 34;
const PAD_T = 26;
const PAD_R = 14;

/** the force graph's transform. The g-range is the UNION of the two modes' ranges whenever
 *  both are solved: the ghost is another solve's curve, outside this one's sweep (calm's
 *  range cuts exact's 50.6 g peak off the top of loop-explicit's panel otherwise), and a
 *  shared axis is what makes the two pictures comparable at all — the point of drawing them
 *  against each other. Solving the second mode therefore widens the first's axis; that is
 *  the comparison arriving, not the picture drifting. */
function chart(s: Solve, alt: Solve | null): Chart {
    const length = s.out.length;
    const lo = alt ? Math.min(s.gLo, alt.gLo) : s.gLo;
    const hi = alt ? Math.max(s.gHi, alt.gHi) : s.gHi;
    return {
        px: (sv) => PAD_L + (sv / length) * (PANEL_W - PAD_L - PAD_R),
        py: (g) => PANEL_H - PAD_B - ((g - lo) / (hi - lo)) * (PANEL_H - PAD_B - PAD_T),
        lo,
        hi,
    };
}

/** the live chart for the selected scenario + mode — one source for the drawing, the
 *  handle census, and the harness hook, so a count can never be measured against a
 *  different transform than the one on screen. */
function chartNow(): Chart | null {
    const s = current();
    return s ? chart(s, other()) : null;
}

/** classify a keyframe's handles in SCREEN space: collinear-through-the-key within
 *  `ALIGN_PX`, and mirrored when the two screen lengths match too. A side pointing the same
 *  way as the other (a cusp) is broken by construction. */
function handleState(
    kx: number,
    ky: number,
    a: { x: number; y: number } | null,
    b: { x: number; y: number } | null,
): HandleState {
    if (!a || !b) return "single";
    const ux = a.x - kx;
    const uy = a.y - ky;
    const wx = b.x - kx;
    const wy = b.y - ky;
    const lu = Math.hypot(ux, uy);
    const lw = Math.hypot(wx, wy);
    if (lu < ALIGN_PX || lw < ALIGN_PX) return "broken"; // a collapsed side has no direction
    if (ux * wx + uy * wy >= 0) return "broken";
    const cross = Math.abs(ux * wy - uy * wx);
    if (cross / Math.min(lu, lw) > ALIGN_PX) return "broken";
    return Math.abs(lu - lw) <= ALIGN_PX ? "mirror" : "aligned";
}

function tipsOf(
    p: ForcePoint,
    c: Chart,
): [{ x: number; y: number } | null, { x: number; y: number } | null] {
    return [
        p.in ? { x: c.px(p.s + p.in.ds), y: c.py(p.g + p.in.dg) } : null,
        p.out ? { x: c.px(p.s + p.out.ds), y: c.py(p.g + p.out.dg) } : null,
    ];
}

function handleStats(points: readonly ForcePoint[], c: Chart): HandleStats {
    const stats: HandleStats = { mirror: 0, aligned: 0, broken: 0, single: 0 };
    for (const p of points) {
        const [a, b] = tipsOf(p, c);
        stats[handleState(c.px(p.s), c.py(p.g), a, b)]++;
    }
    return stats;
}

// ── the page shell ──

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls?: string,
    parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    (parent ?? document.body).appendChild(node);
    return node;
}

const root = document.getElementById("lab");
if (!root) throw new Error("#lab missing");
const lab: HTMLElement = root;

const controls = el("div", "controls", lab);
const bar = el("div", "row", controls);
const picker = el("select", undefined, bar);
for (const s of scenarios) {
    const opt = el("option", undefined, picker);
    opt.value = s.name;
    opt.textContent = s.name;
}
const modeBtn = el("button", "modebtn", bar);
const playBtn = el("button", undefined, bar);
playBtn.textContent = "Play";
const calmBtn = el("button", undefined, bar);
calmBtn.textContent = "Solve calm corpus";
const handlesLabel = el("label", "mono check", bar);
const handlesBox = el("input", undefined, handlesLabel);
handlesBox.type = "checkbox";
handlesBox.checked = true;
handlesLabel.appendChild(document.createTextNode(" handles"));
const frameLabel = el("span", "mono", bar);
const phaseBar = el("div", "phases", controls);
const scrub = el("input", "scrub", controls);
scrub.type = "range";
scrub.min = "0";
scrub.max = "0";
scrub.step = "1";
scrub.value = "0";
const headLine = el("div", "mono", controls);
const cmpLine = el("div", "mono", controls);
const diagLine = el("div", "mono", controls);
const statusLine = el("div", "mono", controls);

function panel(title: string, desc: string): HTMLDivElement {
    const node = el("div", "panel", lab);
    node.innerHTML = `<h2>${title}</h2><p>${desc}</p>`;
    return node;
}

function canvasIn(parent: HTMLElement, w: number, h: number): CanvasRenderingContext2D {
    const canvas = el("canvas", undefined, parent);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    ctx.scale(dpr, dpr);
    return ctx;
}

const viewCtx = canvasIn(
    panel(
        "geometry: the shape, the fit alone, and what this frame really draws",
        `The original baked geo polyline (blue), the geometry stage 2's warm start integrates into (faint — the fit alone is <code>not</code> a valid convert; on valley-explicit it leaves the panel entirely), and the geometry this frame's sparse profile integrates into through the live f32 <code>evalForce</code> path (gold). The ring is the bake's exit, the cross the integrated one: the pin closing IS those two markers meeting. The framing spans the bake and the polished result and never moves, so the frames are comparable by eye.`,
    ),
    PANEL_W,
    PANEL_H,
);
const forceCtx = canvasIn(
    panel(
        "force: dense recovered, warm start, and the profile being solved",
        `The dense recovered F_n the fit chased (blue), stage 2's warm start (faint), and this frame's sparse profile (gold) with its keyframes as diamonds and their bezier handles drawn: <code>green</code> where the two sides are collinear through the key (aligned; filled tips = mirrored), <code>red</code> where they are broken — the ugliness the second check-in could see but not diagnose. The y-range spans every frame, so nothing clips: where the gold curve leaves the diamonds far below it, that is <code>inter-key overshoot</code>. The dense curve's s is the bake's cumulative chord, the profile's is the uniform integration grid; the two frames drift by up to ~1.2 m, expected.`,
    ),
    PANEL_W,
    PANEL_H,
);
const tablePanel = panel(
    "corpus",
    `Every scenario solved exact on load; the calm columns fill in on <code>Solve calm corpus</code> (calm costs 5.1× exact's wall time — measured — so it is never in the auto-run). <code>dev warm</code> → <code>dev</code> is what the constrained polish buys over the fit alone; <code>peak</code> vs <code>key peak</code> is what the keyframes hide; <code>maxΔg</code> exact vs calm is the authorability trade. Click a row to flip the panels to it.`,
);
tablePanel.className = "panel wide";
const table = el("table", undefined, tablePanel);

// ── state ──

const MODES: PolishMode[] = ["exact", "calm"];
const solves: Record<PolishMode, (Solve | null)[]> = {
    exact: scenarios.map(() => null),
    calm: scenarios.map(() => null),
};
const attempted: Record<PolishMode, boolean[]> = {
    exact: scenarios.map(() => false),
    calm: scenarios.map(() => false),
};
const errors: string[] = [];
let mode: PolishMode = "exact";
let selected = 0;
let frame = 0;
let playing = false;
let ready = false;
let calmPumping = false;
let elapsed = 0;

function current(): Solve | null {
    return solves[mode][selected];
}

function other(): Solve | null {
    return solves[mode === "exact" ? "calm" : "exact"][selected];
}

function fmt(x: number, digits = 3): string {
    if (!Number.isFinite(x)) return `${x}`;
    if (x === 0) return "0";
    return Math.abs(x) >= 1e-3 && Math.abs(x) < 1e5 ? x.toFixed(digits) : x.toExponential(1);
}

// ── panel 1: the geometry overlay ──

function drawView(): void {
    const ctx = viewCtx;
    ctx.clearRect(0, 0, PANEL_W, PANEL_H);
    const s = current();
    if (!s) {
        ctx.font = MONO;
        ctx.fillStyle = TEXT;
        ctx.fillText(`solving ${scenarios[selected].name} (${mode})…`, 16, 24);
        return;
    }
    const pad = 24;
    const { minX, maxX, minY, maxY } = s.bounds;
    const k = Math.min(
        (PANEL_W - 2 * pad) / Math.max(maxX - minX, 1e-6),
        (PANEL_H - 2 * pad) / Math.max(maxY - minY, 1e-6),
    );
    const tx = (x: number): number =>
        pad + (x - minX) * k + 0.5 * (PANEL_W - 2 * pad - (maxX - minX) * k);
    const ty = (y: number): number =>
        PANEL_H - pad - (y - minY) * k - 0.5 * (PANEL_H - 2 * pad - (maxY - minY) * k);

    const stroke = (
        xs: ArrayLike<number>,
        ys: ArrayLike<number>,
        n: number,
        color: string,
        dash: number[],
        width: number,
    ): void => {
        ctx.beginPath();
        ctx.setLineDash(dash);
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        for (let i = 0; i <= n; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, tx(xs[i]), ty(ys[i]));
        ctx.stroke();
        ctx.setLineDash([]);
    };

    const live = geometryAt(s, frame);
    stroke(s.bake.posX, s.bake.posY, s.bake.edges, BLUE, [], 2);
    if (live) {
        stroke(s.warmGeom.posX, s.warmGeom.posY, s.warmGeom.edges, FAINT, [3, 3], 1.5);
        stroke(live.posX, live.posY, live.edges, GOLD, [6, 4], 2);
    }

    // the exits: the pin closing is these two markers meeting.
    const ex = s.bake.edges;
    ctx.strokeStyle = BLUE;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(tx(s.bake.posX[ex]), ty(s.bake.posY[ex]), 6, 0, 2 * Math.PI);
    ctx.stroke();
    if (live) {
        const lx = tx(live.posX[live.edges]);
        const ly = ty(live.posY[live.edges]);
        ctx.strokeStyle = GOLD;
        ctx.beginPath();
        ctx.moveTo(lx - 5, ly - 5);
        ctx.lineTo(lx + 5, ly + 5);
        ctx.moveTo(lx - 5, ly + 5);
        ctx.lineTo(lx + 5, ly - 5);
        ctx.stroke();
    }
    ctx.fillStyle = TEXT;
    ctx.beginPath();
    ctx.arc(tx(s.bake.posX[0]), ty(s.bake.posY[0]), 3, 0, 2 * Math.PI);
    ctx.fill();

    ctx.font = "11px 'JetBrains Mono', monospace";
    ctx.fillStyle = BLUE;
    ctx.fillText("baked geo", 12, 16);
    if (live) {
        ctx.fillStyle = FAINT;
        ctx.fillText("fit alone", 92, 16);
        ctx.fillStyle = GOLD;
        ctx.fillText("integrated (f32)", 168, 16);
    } else {
        ctx.fillStyle = TEXT;
        ctx.fillText("no profile yet — the dense recovery is the input", 92, 16);
    }
}

// ── panel 2: the force graph ──

function drawForce(): void {
    const ctx = forceCtx;
    ctx.clearRect(0, 0, PANEL_W, PANEL_H);
    const s = current();
    if (!s) {
        ctx.font = MONO;
        ctx.fillStyle = TEXT;
        ctx.fillText(`solving ${scenarios[selected].name} (${mode})…`, 16, 24);
        return;
    }
    const c = chart(s, other());
    const { px, py, lo, hi } = c;
    const length = s.out.length;

    // gridlines: the g raster the eye reads spikes against.
    ctx.font = MONO;
    const gStep = niceStep((hi - lo) / 6);
    ctx.lineWidth = 1;
    for (let g = Math.ceil(lo / gStep) * gStep; g <= hi; g += gStep) {
        ctx.strokeStyle = GRID;
        ctx.beginPath();
        ctx.moveTo(PAD_L, py(g));
        ctx.lineTo(PANEL_W - PAD_R, py(g));
        ctx.stroke();
        ctx.fillStyle = TEXT;
        ctx.fillText(fmt(g, gStep >= 1 ? 0 : 2), 8, py(g) + 3);
    }
    const sStep = niceStep(length / 6);
    for (let sv = 0; sv <= length + 1e-9; sv += sStep) {
        ctx.strokeStyle = GRID;
        ctx.beginPath();
        ctx.moveTo(px(sv), PAD_T);
        ctx.lineTo(px(sv), PANEL_H - PAD_B);
        ctx.stroke();
        ctx.fillStyle = TEXT;
        ctx.fillText(`${sv.toFixed(0)}`, px(sv) - 6, PANEL_H - PAD_B + 14);
    }
    // the 1 g physical baseline — the landmark airtime and heavy g's are read against.
    if (lo < 1 && hi > 1) {
        ctx.strokeStyle = FAINT;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(PAD_L, py(1));
        ctx.lineTo(PANEL_W - PAD_R, py(1));
        ctx.stroke();
        ctx.setLineDash([]);
    }
    ctx.fillStyle = TEXT;
    ctx.fillText("s (m) →", PANEL_W - PAD_R - 46, PANEL_H - PAD_B + 26);
    ctx.save();
    ctx.translate(12, PAD_T + 10);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("F_n (g)", -30, 0);
    ctx.restore();

    // the dense recovered curve rides the bake's cumulative chords; the profiles ride the
    // uniform integration grid.
    const line = (
        vals: ArrayLike<number>,
        at: (i: number) => number,
        color: string,
        dash: number[],
        width: number,
    ): void => {
        ctx.beginPath();
        ctx.setLineDash(dash);
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        for (let i = 0; i < vals.length; i++)
            (i ? ctx.lineTo : ctx.moveTo).call(ctx, px(at(i)), py(vals[i]));
        ctx.stroke();
        ctx.setLineDash([]);
    };
    const uniform = (i: number): number => i * s.out.ds;
    const fr = s.frames[frame];
    const alt = other();
    // clip to the plot rect. Bezier CONTROL points are not curve values, so no sweep can
    // range over them — loop-explicit's tips reach 273 px above a 340 px canvas — and
    // unclipped they draw over the axis labels and the legend. Clipping truncates the
    // handle at the plot edge, which reads as "it goes off up there"; not clipping reads
    // as a rendering bug.
    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD_L, PAD_T, PANEL_W - PAD_L - PAD_R, PANEL_H - PAD_B - PAD_T);
    ctx.clip();
    line(s.bake.fN, (i) => s.sigma[i], BLUE, [], 1.5);
    if (alt) line(alt.finalDense, (i) => i * alt.out.ds, GHOST, [2, 3], 1.5);
    if (fr.phase === "polish") line(s.warmDense, uniform, FAINT, [3, 3], 1.5);
    if (fr.fN) line(fr.fN, uniform, GOLD, [], 2);

    if (fr.points) {
        if (handlesBox.checked) {
            for (const p of fr.points) {
                const kx = px(p.s);
                const ky = py(p.g);
                const [a, b] = tipsOf(p, c);
                const state = handleState(kx, ky, a, b);
                ctx.strokeStyle = state === "broken" ? RED : GREEN;
                ctx.fillStyle = ctx.strokeStyle;
                ctx.lineWidth = 1;
                for (const tip of [a, b]) {
                    if (!tip) continue;
                    ctx.beginPath();
                    ctx.moveTo(kx, ky);
                    ctx.lineTo(tip.x, tip.y);
                    ctx.stroke();
                    ctx.beginPath();
                    ctx.rect(tip.x - 2, tip.y - 2, 4, 4);
                    if (state === "mirror") ctx.fill();
                    else ctx.stroke();
                }
            }
        }
        ctx.fillStyle = GOLD;
        for (const p of fr.points) {
            const x = px(p.s);
            const y = py(p.g);
            ctx.beginPath();
            ctx.moveTo(x, y - 4);
            ctx.lineTo(x + 4, y);
            ctx.lineTo(x, y + 4);
            ctx.lineTo(x - 4, y);
            ctx.closePath();
            ctx.fill();
        }
    }
    ctx.restore();

    ctx.font = "11px 'JetBrains Mono', monospace";
    ctx.fillStyle = BLUE;
    ctx.fillText("dense recovered", PAD_L, 16);
    if (fr.phase === "polish") {
        ctx.fillStyle = FAINT;
        ctx.fillText("warm start", PAD_L + 110, 16);
    }
    ctx.fillStyle = GOLD;
    ctx.fillText(fr.phase === "recover" ? "(no profile)" : fr.phase, PAD_L + 190, 16);
    if (alt) {
        ctx.fillStyle = GHOST;
        ctx.fillText(`${alt.mode} final`, PAD_L + 250, 16);
    }
    ctx.fillStyle = GREEN;
    ctx.fillText("aligned", PANEL_W - PAD_R - 100, 16);
    ctx.fillStyle = RED;
    ctx.fillText("broken", PANEL_W - PAD_R - 46, 16);
}

// ── panel 3: the corpus table ──

const COLUMNS = [
    "scenario",
    "keys",
    "dense",
    "steps",
    "iters",
    "ms",
    "exit (m)",
    "dev warm (m)",
    "dev (m)",
    "peak (g)",
    "key peak (g)",
    "maxΔg",
    "calm dev (m)",
    "calm peak (g)",
    "calm maxΔg",
    "λ",
];

function drawTable(): void {
    table.textContent = "";
    const head = el("tr", undefined, table);
    for (const c of COLUMNS) el("th", undefined, head).textContent = c;
    for (let i = 0; i < scenarios.length; i++) {
        const s = solves.exact[i];
        const tr = el("tr", i === selected ? "sel" : undefined, table);
        tr.style.cursor = "pointer";
        tr.onclick = (): void => select(scenarios[i].name);
        const cell = (text: string, color?: string): void => {
            const td = el("td", undefined, tr);
            td.textContent = text;
            if (color) td.style.color = color;
        };
        cell(scenarios[i].name);
        if (!s) {
            const failed = attempted.exact[i];
            for (let k = 1; k < COLUMNS.length; k++) cell(failed ? "—" : "…", failed ? RED : TEXT);
            continue;
        }
        const r = s.row;
        cell(`${r.keys}`);
        cell(`${r.dense}`);
        cell(`${r.steps}`);
        cell(`${r.iters}`);
        cell(r.ms.toFixed(0));
        cell(fmt(r.exit), r.converged ? undefined : RED);
        cell(fmt(r.warmDev));
        cell(fmt(r.dev));
        cell(fmt(r.peak, 1));
        cell(fmt(r.keyPeak, 1), r.peak > 1.5 * Math.max(r.keyPeak, 1e-6) ? RED : undefined);
        cell(fmt(r.maxDg, 1));
        const c = solves.calm[i];
        if (!c) {
            const failed = attempted.calm[i];
            for (let k = 0; k < 4; k++) cell(failed ? "—" : "…", failed ? RED : TEXT);
            continue;
        }
        cell(fmt(c.row.dev), c.row.heldFloor ? undefined : RED);
        cell(fmt(c.row.peak, 1));
        cell(fmt(c.row.maxDg, 1), c.row.maxDg < r.maxDg ? GREEN : undefined);
        cell(fmt(c.row.lambda, 1));
    }
}

// ── the text lines ──

function drawPhases(): void {
    phaseBar.textContent = "";
    const s = current();
    if (!s) return;
    for (const seg of s.segments) {
        const span = el(
            "span",
            frame >= seg.start && frame <= seg.end ? "on" : undefined,
            phaseBar,
        );
        span.textContent = seg.label;
        span.style.flexGrow = `${seg.end - seg.start + 1}`;
        span.onclick = (): void => {
            pause();
            setFrame(seg.start);
        };
    }
}

function drawLines(): void {
    const s = current();
    const name = scenarios[selected].name;
    if (!s) {
        headLine.textContent = attempted[mode][selected]
            ? `${name} · ${mode} — solve failed`
            : `${name} · ${mode} — solving…`;
        cmpLine.textContent = "";
        diagLine.textContent = "";
        frameLabel.textContent = "";
        return;
    }
    const r = s.row;
    headLine.textContent =
        `${name} · ${mode} · ${r.keys} keys / ${r.dense} dense edges (${(r.dense / r.keys).toFixed(1)}×)` +
        ` · ${r.steps} fit steps · ${r.iters} iters / ${r.outers} outers` +
        ` · ${r.converged ? "converged" : "NOT CONVERGED"} · ${r.ms.toFixed(0)} ms` +
        ` · fit ${fmt(s.fitError, 3)} g` +
        (mode === "calm"
            ? ` · λ ${fmt(r.lambda, 1)} · ${r.heldFloor ? "floor held" : "FLOOR MISSED"}`
            : "");

    const alt = other();
    const brief = (x: Solve): string =>
        `${x.mode}: dev ${fmt(x.row.dev)} m · peak ${fmt(x.row.peak, 1)} g · maxΔg ${fmt(x.row.maxDg, 1)}`;
    cmpLine.textContent = alt
        ? `${brief(s)}    ‖    ${brief(alt)}`
        : `${brief(s)}    ‖    ${mode === "exact" ? "calm" : "exact"} not solved — press M`;

    const fr = s.frames[frame];
    const live = geometryAt(s, frame);
    const geo = live
        ? (() => {
              const m = measure(s.bake, s.sigma, live, s.out.ds);
              return `integrated dev ${fmt(m.dev)} m · exit ${fmt(m.exit)} m`;
          })()
        : "no profile yet";
    const detail = fr.snap
        ? `outer ${fr.snap.outer} · feasibility ${fmt(fr.snap.feasibility)} m` +
          ` · spine dev ${fmt(fr.snap.deviation)} m · Φ ${fmt(fr.snap.phi)}` +
          ` · μ ${fmt(fr.snap.mu)} · ρ ${fmt(fr.snap.rho)}`
        : fr.step
          ? `fit error ${fmt(fr.step.maxError, 3)} g vs tol ${FIT_TOL} g` +
            (frame === s.warm ? " · this frame IS the warm start" : "")
          : "the observation the fit chases";
    const hs = fr.points ? handleStats(fr.points, chart(s, other())) : null;
    const handles = hs
        ? ` · handles ${hs.mirror} mirrored / ${hs.aligned} aligned / ${hs.broken} broken` +
          ` / ${hs.single} one-sided`
        : "";
    diagLine.textContent = `${fr.label} · ${geo} · ${detail}${handles}`;
    frameLabel.textContent = `frame ${frame + 1}/${s.frames.length}`;
}

function draw(): void {
    drawView();
    drawForce();
    drawPhases();
    drawLines();
    modeBtn.textContent = `mode: ${mode}`;
}

function status(): void {
    const done = solves.exact.filter((s) => s !== null).length;
    const calm = solves.calm.filter((s) => s !== null).length;
    statusLine.className = errors.length ? "mono err" : "mono";
    statusLine.textContent = errors.length
        ? `solved ${done}/${scenarios.length} exact · ${errors.join(" · ")}`
        : `solved ${done}/${scenarios.length} exact in ${elapsed.toFixed(0)} ms` +
          (ready ? " · corpus complete" : "") +
          (calm ? ` · ${calm}/${scenarios.length} calm` : "");
}

// ── controls ──

function setFrame(i: number): void {
    const s = current();
    const n = s ? s.frames.length : 1;
    frame = Math.max(0, Math.min(n - 1, Math.round(i)));
    scrub.value = `${frame}`;
    draw();
}

/** re-sync the scrubber to the live solve and land on the answer; scrub back for the
 *  story. Shared by scenario flips and mode flips, which both swap the frame list. */
function reframe(): void {
    const s = current();
    scrub.max = `${(s ? s.frames.length : 1) - 1}`;
    pause();
    setFrame(s ? s.frames.length - 1 : 0);
    drawTable();
}

function select(name: string): void {
    const i = scenarios.findIndex((s) => s.name === name);
    if (i < 0) throw new Error(`no scenario named ${name}`);
    selected = i;
    picker.value = name;
    ensure(i, mode);
    reframe();
}

/** flip the panels between the exact baseline and the calm answer, solving the calm side on
 *  demand — the corpus auto-run stays exact (calm is 5.1× its wall time, measured). */
function setMode(m: PolishMode): void {
    if (!MODES.includes(m)) throw new Error(`no such mode ${m}`);
    if (m === mode) return;
    mode = m;
    ensure(selected, m);
    reframe();
    status();
}

function play(): void {
    const s = current();
    if (!s || playing) return;
    const end = s.frames.length - 1;
    if (frame >= end) setFrame(0);
    playing = true;
    playBtn.textContent = "Pause";
    let last = performance.now();
    const tick = (now: number): void => {
        if (!playing) return;
        if (now - last >= FRAME_MS) {
            last = now;
            if (frame >= end) {
                pause();
                return;
            }
            setFrame(frame + 1);
        }
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
}

function pause(): void {
    playing = false;
    playBtn.textContent = "Play";
}

function toggle(): void {
    if (playing) pause();
    else play();
}

picker.onchange = (): void => select(picker.value);
playBtn.onclick = toggle;
modeBtn.onclick = (): void => setMode(mode === "exact" ? "calm" : "exact");
calmBtn.onclick = (): void => pumpCalm();
handlesBox.onchange = (): void => draw();
scrub.oninput = (): void => {
    pause();
    setFrame(Number(scrub.value));
};
window.addEventListener("keydown", (e) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "SELECT") return;
    if (e.key === "ArrowRight") setFrame(frame + 1);
    else if (e.key === "ArrowLeft") setFrame(frame - 1);
    else if (e.key === "m" || e.key === "M") setMode(mode === "exact" ? "calm" : "exact");
    else if (e.key === "h" || e.key === "H") {
        handlesBox.checked = !handlesBox.checked;
        draw();
    } else if (e.key === " ") {
        e.preventDefault();
        toggle();
    }
});

// ── auto-run: the whole corpus, chunked so the page stays responsive ──

/** solve scenario `i` in mode `m` if it hasn't been. A throw is RECORDED, not swallowed:
 *  the row goes dashed-red and the status line carries the message, so a corpus that stops
 *  solving can't read as a green page. */
function ensure(i: number, m: PolishMode): void {
    if (solves[m][i] || attempted[m][i]) return;
    attempted[m][i] = true;
    try {
        solves[m][i] = run(scenarios[i], m);
        if (m === "exact") elapsed += solves[m][i]?.row.ms ?? 0;
    } catch (e) {
        errors.push(`${scenarios[i].name} (${m}): ${e instanceof Error ? e.message : String(e)}`);
    }
}

function pump(): void {
    const next = attempted.exact.findIndex((a) => !a);
    if (next < 0) {
        ready = true;
        status();
        return;
    }
    ensure(next, "exact");
    if (next === selected && mode === "exact") select(scenarios[next].name);
    else drawTable();
    status();
    setTimeout(pump, 0);
}

/** the calm corpus, on demand: the before/after violence table the verdict reads. Chunked
 *  like the auto-run so a ~6.7 s sweep doesn't lock the page. */
function pumpCalm(): void {
    if (calmPumping) return;
    calmPumping = true;
    calmBtn.disabled = true;
    const step = (): void => {
        const next = attempted.calm.findIndex((a) => !a);
        if (next < 0) {
            calmPumping = false;
            calmBtn.textContent = "Calm corpus solved";
            status();
            return;
        }
        ensure(next, "calm");
        drawTable();
        draw();
        status();
        setTimeout(step, 0);
    };
    setTimeout(step, 0);
}

picker.value = scenarios[0].name;
draw();
drawTable();
status();
setTimeout(pump, 0);

/** the harness hook (the `__kex` pattern, `main.ts`): read-only diagnostics plus the
 *  controls a capture flow drives — flip a scenario, flip a mode, scrub a frame. `ready()`
 *  is the EXACT auto-run's gate (calm is never auto-run); `errors()` must be empty for a
 *  run to mean anything. */
(window as unknown as { __fitlab: unknown }).__fitlab = {
    scenarios: (): string[] => scenarios.map((s) => s.name),
    ready: (): boolean => ready,
    solved: (): number => solves.exact.filter((s) => s !== null).length,
    errors: (): string[] => [...errors],
    current: (): string => scenarios[selected].name,
    select,
    mode: (): PolishMode => mode,
    setMode,
    frames: (): number => current()?.frames.length ?? 0,
    frame: (): number => frame,
    setFrame,
    /** the frame index of the warm start — the fit's last step, the story frame where a
     *  0.03 g fit is still 40 m off. */
    warmFrame: (): number => current()?.warm ?? 0,
    phases: (): { phase: Phase; start: number; end: number }[] =>
        (current()?.segments ?? []).map((s) => ({ phase: s.phase, start: s.start, end: s.end })),
    /** how the current frame's keyframes carry their handles. */
    handles: (): HandleStats => {
        const c = chartNow();
        const points = current()?.frames[frame].points;
        return c && points
            ? handleStats(points, c)
            : { mirror: 0, aligned: 0, broken: 0, single: 0 };
    },
    /** keyframes on THIS frame — what `handles()` censuses. Not `points().length`, which is
     *  the final polished profile: the two agree only because the polish holds the count
     *  fixed, and a check should not lean on a coincidence from another module. */
    frameKeys: (): number => current()?.frames[frame].points?.length ?? 0,
    playing: (): boolean => playing,
    play,
    pause,
    solveCalm: pumpCalm,
    rows: (m: PolishMode = "exact"): Row[] =>
        solves[m].filter((s): s is Solve => s !== null).map((s) => s.row),
    metrics: (name?: string): Row | null =>
        (name === undefined ? current() : solves[mode][scenarios.findIndex((s) => s.name === name)])
            ?.row ?? null,
    points: (): ForcePoint[] => current()?.out.points ?? [],
};
