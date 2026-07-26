// The geo→force conversion research app (spec `kex/specs/kex2d-geoforce-convert.md` stage 5,
// after the spike's stages 4 + 4b). A standalone canvas2D + DOM page — no shallot, no GPU, no
// Svelte — over the pure kernel:
//
//   1. the VIEWPORT overlay — the original baked geo polyline, the geometry the phase's
//      opening state integrates into, and the geometry the current frame's profile really
//      integrates into through the live f32 `evalForce` path, both exits marked;
//   2. the FORCE graph — the dense recovered F_n (the target), the opening reference, the
//      current sparse profile's dense force, its keyframe diamonds, and each keyframe's
//      VOCABULARY drawn as itself: bezier handles colored by collinearity, a ring on a
//      CORNER (the one deliberate break), and a hollow diamond with flat stubs on a FLAT
//      key (no explicit handles — the state a named easing is stored as). The y-range spans
//      every playback frame, so inter-key overshoot is never clipped out;
//   3. the CORPUS table — every scenario solved exact on load (the oracle baseline), with
//      the calm columns filling in on demand;
//   4. the CONVERSION table — what the real tier does per scenario: keys, corners, named
//      segments, deviation against the derived floor, violence, the refine loop's decision
//      counts and probe cost, and how it ended.
//
// **Three modes, and the shipping one is the DEFAULT.** `convert` is the tier — `refine.ts`
// opens at two keys and chooses knots against the integrated GEOMETRY, then `quantize.ts`
// snaps what it can onto the named-easing vocabulary — and it is what a scenario shows on
// open and on every flip. `exact` and `calm` are the spike's fit→polish baseline, where
// `fit.ts` places knots against the dense FORCE curve (the wrong target) and the polish then
// moves values at those fixed knots. They stay because every number the spike measured was
// taken there and because exact is the geometric oracle floor, but exact is DELIBERATELY
// DEGENERATE as an authoring surface: near the geometry floor the loss is flat in a large
// subspace, and the answer buys its last decimals with extreme broken handles (loop-explicit
// maxΔg 141, 32 keys). So it is never the default view and never an automatic overlay — `M`
// cycles the modes, and in convert mode the exact curve draws as a ghost only when the
// `oracle` box asks for it. In the baseline modes the exact↔calm ghost stays automatic:
// there the comparison IS the claim (calm buys a quiet profile for geometry nobody can see).
//
// The scrubber is ONE timeline across whichever pipeline is selected, phase-segmented —
// recover → refine → polish → quantize in convert mode, recover → fit → polish in the
// baseline. Frames are what the kernel already decided (`refine().events`,
// `polish().snapshots`, `fit().steps`), assembled by the pure `playback.ts`; nothing here
// re-derives a solve, so what plays back is deterministic and carries no wall clock.
//
// **The convert corpus is never auto-run, though it is the default VIEW.** Measured on this
// host: 70 s for all ten (refine 52 s + quantize 18 s), from 0.5 s for circular-arc to 26 s
// for double-hump — against 1.3 s for the exact baseline. So the exact corpus still
// auto-runs in the background (it fills the baseline table and gates `ready()`), the
// selected scenario's convert solve is scheduled on demand one macrotask out so the page
// paints "solving…" rather than freezing, and the whole convert corpus is a button.
//
// Read-only: nothing here authors. Served by vite at /fit-lab.html; captured by the
// Playwright harness, which drives the `window.__fitlab` hook below.

import { census, type HandleStats, handleState, type Scale } from "./census";
import { arclength, fit } from "./fit";
import {
    baseline,
    forceRange,
    type Frame,
    PANEL,
    panelScale,
    type Phase,
    pipeline,
    type Segment,
    segments,
} from "./playback";
import { polish, type PolishMode, type PolishResult } from "./polish";
import { type ForcePoint, forceProfile } from "./profile";
import { namedSegments, quantize, type QuantizeResult } from "./quantize";
import { refine, type RefineEvent, type RefineResult } from "./refine";
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

const PANEL_W = PANEL.w;
const PANEL_H = PANEL.h;
/** playback pace: one frame per ~20 fps — fast enough to read as motion, slow enough that
 *  a 150-frame pipeline does not flash past. */
const FRAME_MS = 50;

/** the three pipelines the page can show: the spike's fit→polish baseline in its two modes,
 *  and the conversion tier itself. */
type LabMode = PolishMode | "convert";

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
    /** calm mode only: the fairing weight, and whether the derived floor actually held. */
    lambda: number;
    heldFloor: boolean;
    /** the deviation target the answer was measured against (m). */
    floor: number;
    /** convert mode only — the tier's own readings; absent on a baseline row. */
    convert?: {
        /** keys carrying the deliberate broken slope. */
        corners: number;
        /** segments the vocabulary snap could name, out of how many there are. */
        named: number;
        segments: number;
        /** the refine loop's decisions, by kind. */
        splits: number;
        prunes: number;
        stalls: number;
        /** how the loop ended — `"floor"` is the answer, `"budget"` the sanctioned
         *  un-authorable one, `"diverged"` a defect. */
        outcome: string;
        /** the whole tier's cost: λ = 0 candidate probes, and total solves. */
        probes: number;
        solves: number;
    };
}

/** everything one scenario's panels draw from, for ONE pipeline. */
interface Solve {
    scenario: Scenario;
    mode: LabMode;
    entry: Entry;
    bake: SectionResult;
    /** the bake's cumulative chord arclength, length `bake.edges + 1`. */
    sigma: Float64Array;
    /** the answer: the polish result in a baseline mode, the quantized one in convert. */
    out: PolishResult;
    /** the refine loop and the vocabulary snap behind it; null in a baseline mode. */
    refined: RefineResult | null;
    quantized: QuantizeResult | null;
    /** max |fitted − dense| the stage-2 fit left behind (g); 0 in convert mode, which never
     *  fits against the dense force. */
    fitError: number;
    /** the OPENING reference's dense force on the uniform grid, and the geometry it
     *  integrates into: the fit-alone warm start in a baseline mode, the refine loop's
     *  two-key opening in convert. The static "before the solve chose anything" curve. */
    openDense: ArrayLike<number>;
    openGeom: SectionResult;
    /** what that opening is called on the panels. */
    openLabel: string;
    /** the dense force of the FINAL profile — what the other mode draws as its ghost. */
    finalDense: Float32Array;
    frames: Frame[];
    segments: Segment[];
    /** the story frame: the last state before the answering solve — the fit's last step in
     *  a baseline mode, the refine loop's settled knot set in convert. */
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

/** bake → the selected pipeline → the reference round-trip, for one scenario.
 *
 *  The frames' dense arrays are built eagerly (a `forceProfile` per structural step) because
 *  the y-range below has to span them — a range fitted to a subset would clip exactly the
 *  early wild pieces worth seeing. It is cheap beside the solves: ~40 ms across the whole
 *  baseline corpus against 1.3 s of solve. */
function run(scenario: Scenario, mode: LabMode): Solve {
    const entry = entryOf(scenario.v0);
    const t0 = performance.now();
    const bake = evalGeo(entry, scenario.nodes, scenario.ds);
    const ds = scenario.ds;

    let out: PolishResult;
    let frames: Frame[];
    let refined: RefineResult | null = null;
    let quantized: QuantizeResult | null = null;
    let fitError = 0;
    // the frame the faint "before" curve is read from, and the story frame the hook exposes.
    let open: number;
    let warm: number;
    let openLabel: string;
    let note: string;
    if (mode === "convert") {
        refined = refine({ bake, entry, ds });
        quantized = quantize({ bake, entry, ds, answer: refined.final });
        out = quantized.final;
        frames = pipeline(refined, quantized, arclength(bake.ds));
        // frame 0 is the recovery, so the refine events occupy 1..events.length: the first
        // is the two-key opening and the last is the settled knot set.
        open = 1;
        warm = refined.events.length;
        openLabel = "opening (2 keys)";
        note = "calm λ-search";
    } else {
        const f = fit(bake.fN, bake.ds, FIT_TOL);
        out = polish({ bake, entry, points: f.points, ds, mode });
        fitError = f.maxError;
        frames = baseline(f.steps, out);
        open = f.steps.length;
        warm = open;
        openLabel = "fit alone";
        note = mode;
    }
    const ms = performance.now() - t0;

    const sigma = new Float64Array(bake.edges + 1);
    for (let i = 0; i < bake.edges; i++) sigma[i + 1] = sigma[i] + bake.ds[i];

    const segs = segments(frames, note);
    const openDense = frames[open].fN;
    if (!openDense) throw new Error(`fitlab: frame ${open} carries no profile`);

    const finalDense = forceProfile(out.points, out.length, out.ds);
    const openGeom = evalForce(entry, openDense, out.ds);
    const solved = evalForce(entry, finalDense, out.ds);

    let peak = 0;
    for (const g of finalDense) peak = Math.max(peak, Math.abs(g));
    let keyPeak = 0;
    for (const p of out.points) keyPeak = Math.max(keyPeak, Math.abs(p.g));

    // the force range spans EVERY frame plus both reference curves, so no panel ever clips
    // a spike the eye is here to see. Pure, and shared with the census oracle
    // (`quantize.test.ts`), which has to judge the profile at the scale the panel draws it.
    const { lo: gLo, hi: gHi } = forceRange(frames, [bake.fN, finalDense]);

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
    const kinds = (kind: RefineEvent["kind"]): number =>
        refined ? refined.events.filter((e) => e.kind === kind).length : 0;
    const row: Row = {
        name: scenario.name,
        keys: out.keys,
        dense: bake.edges,
        steps: refined ? refined.events.length : frames.filter((fr) => fr.step !== null).length,
        iters: out.iters,
        outers: out.outers,
        converged: out.converged,
        ms,
        exit: solvedM.exit,
        warmDev: measure(bake, sigma, openGeom, out.ds).dev,
        dev: solvedM.dev,
        peak,
        keyPeak,
        maxDg: out.maxDg,
        lambda: out.lambda,
        heldFloor: out.heldFloor,
        floor: out.floor,
    };
    if (refined && quantized)
        row.convert = {
            corners: refined.cornerKnots.length,
            named: quantized.named.length,
            segments: Math.max(0, out.points.length - 1),
            splits: kinds("split"),
            prunes: kinds("prune"),
            stalls: kinds("stall"),
            outcome: refined.outcome,
            probes: refined.probes + quantized.probes,
            solves: refined.solves + quantized.solves,
        };

    return {
        scenario,
        mode,
        entry,
        bake,
        sigma,
        out,
        refined,
        quantized,
        fitError,
        openDense,
        openGeom,
        openLabel,
        finalDense,
        frames,
        segments: segs,
        warm,
        row,
        gLo,
        gHi,
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
    /** the px-per-unit of the same transform, for `census.ts` — the handle judgment is a
     *  screen-space one, and only the linear part of the mapping enters it. */
    scale: Scale;
}

const PAD_L = PANEL.padL;
const PAD_B = PANEL.padB;
const PAD_T = PANEL.padT;
const PAD_R = PANEL.padR;

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
        scale: panelScale(length, lo, hi),
    };
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
const convertBtn = el("button", undefined, bar);
convertBtn.textContent = "Solve convert corpus (~70 s)";
const handlesLabel = el("label", "mono check", bar);
const handlesBox = el("input", undefined, handlesLabel);
handlesBox.type = "checkbox";
handlesBox.checked = true;
handlesLabel.appendChild(document.createTextNode(" handles"));
/** the degenerate oracle, opt-in. The exact solve is the geometric floor and NOT an
 *  authoring surface, so in convert mode it is drawn only when asked for — otherwise the
 *  shipping profile would share its panel (and its axis) with a curve whose handles are
 *  extreme by construction. */
const oracleLabel = el("label", "mono check", bar);
const oracleBox = el("input", undefined, oracleLabel);
oracleBox.type = "checkbox";
oracleBox.checked = false;
oracleLabel.appendChild(document.createTextNode(" exact oracle (degenerate)"));
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
        "geometry: the shape, the opening state, and what this frame really draws",
        `The original baked geo polyline (blue), the geometry the pipeline's OPENING state integrates into (faint — the fit alone in a baseline mode, the refine loop's two-key opening in convert; neither is a valid convert, and on valley-explicit the fit-alone curve leaves the panel entirely), and the geometry this frame's sparse profile integrates into through the live f32 <code>evalForce</code> path (gold). The ring is the bake's exit, the cross the integrated one: the pin closing IS those two markers meeting. The framing spans the bake and the final result and never moves, so the frames are comparable by eye.`,
    ),
    PANEL_W,
    PANEL_H,
);
const forceCtx = canvasIn(
    panel(
        "force: the target, the opening state, and the profile being solved",
        `The dense recovered F_n (blue — the target), the opening state (faint), and this frame's sparse profile (gold) with its keyframes drawn as the VOCABULARY they carry: bezier handles <code>green</code> where the two sides are collinear through the key (aligned; filled tips = mirrored) and <code>red</code> where they are broken, a <code>ring</code> on a key the refine loop deliberately broke (a corner), and a <code>hollow</code> diamond with flat stubs where a key carries no explicit handles at all — the FLAT state a named easing is stored as (<code>quantize.ts</code>: a named segment stores nothing, Cubic being the absent-value default). The y-range spans every frame, so nothing clips: where the gold curve leaves the diamonds far below it, that is <code>inter-key overshoot</code>. The dense curve's s is the bake's cumulative chord, the profile's is the uniform integration grid; the two frames drift by up to ~1.2 m, expected.`,
    ),
    PANEL_W,
    PANEL_H,
);
const tablePanel = panel(
    "oracle baseline — the spike's fit→polish, NOT the shipping path",
    `Every scenario solved exact on load; the calm columns fill in on <code>Solve calm corpus</code> (calm costs 5.1× exact's wall time — measured — so it is never in the auto-run). This is the SPIKE's pipeline, kept as the geometric floor the tier is judged against, and <code>exact</code> is <code>deliberately degenerate</code> as an authoring surface: it drives geometry to the numeric floor and pays with extreme broken handles (loop-explicit: 32 keys, maxΔg 141). Read it as the oracle, never as output — the shipping answer is the conversion table below. <code>dev warm</code> → <code>dev</code> is what the constrained polish buys over the fit alone; <code>peak</code> vs <code>key peak</code> is what the keyframes hide; <code>maxΔg</code> exact vs calm is the authorability trade. Click a row to flip the panels to it.`,
);
tablePanel.className = "panel wide";
const table = el("table", undefined, tablePanel);
const convertPanel = panel(
    "conversion tier — refine → polish → quantize",
    `What the real tier does, per scenario. Never auto-run: measured 70 s for the corpus (refine 52 s + quantize 18 s), 0.5 s for circular-arc up to 26 s for double-hump — so a scenario solves when you flip it to <code>convert</code> mode, and the whole corpus on the button. <code>keys</code> is the objective (discrepancy-constrained minimal keys); <code>dev</code> against <code>floor</code> is the constraint that decides every accept; <code>named</code> is how much of the easing vocabulary the profile could be re-projected onto — structurally small, and that is the stage-4 finding, not a defect; <code>outcome</code> separates the answer (<code>floor</code>) from the sanctioned un-authorable one (<code>budget</code>) and from a defect (<code>diverged</code>).`,
);
convertPanel.className = "panel wide";
const convertTable = el("table", undefined, convertPanel);

// ── state ──

const MODES: LabMode[] = ["exact", "calm", "convert"];
const solves: Record<LabMode, (Solve | null)[]> = {
    exact: scenarios.map(() => null),
    calm: scenarios.map(() => null),
    convert: scenarios.map(() => null),
};
const attempted: Record<LabMode, boolean[]> = {
    exact: scenarios.map(() => false),
    calm: scenarios.map(() => false),
    convert: scenarios.map(() => false),
};
const errors: string[] = [];
/** the SHIPPING pipeline is what the page opens on, and what every scenario flip lands in.
 *  The baseline modes are reached deliberately (`M`), never by default. */
let mode: LabMode = "convert";
let selected = 0;
let frame = 0;
let playing = false;
let ready = false;
const pumping: Record<Exclude<LabMode, "exact">, boolean> = { calm: false, convert: false };
let elapsed = 0;

function current(): Solve | null {
    return solves[mode][selected];
}

/** the solve drawn as a ghost beside this one. exact and calm are each other's comparison —
 *  that pairing is what the spike's violence claim is read off, so it stays automatic. The
 *  shipping view's ghost is the exact oracle, which is opt-in: it is the geometric floor and
 *  a deliberately degenerate authoring surface, so it may inform the picture only when asked
 *  for. It also widens the shared axis, which is exactly why it must not arrive uninvited. */
function other(): Solve | null {
    if (mode === "convert") return oracleBox.checked ? solves.exact[selected] : null;
    return solves[mode === "exact" ? "calm" : "exact"][selected];
}

function fmt(x: number, digits = 3): string {
    if (!Number.isFinite(x)) return `${x}`;
    if (x === 0) return "0";
    return Math.abs(x) >= 1e-3 && Math.abs(x) < 1e5 ? x.toFixed(digits) : x.toExponential(1);
}

/** a FLAT key: no explicit handles on either side, so both resolve from the (absent, hence
 *  Cubic) tag at Δg = 0. The representation IS the state — `quantize.ts` names a segment by
 *  removing its two keys' handles, never by storing a tag. */
function flat(p: ForcePoint): boolean {
    return p.in === undefined && p.out === undefined;
}

/** the whole vocabulary reading of one frame: the screen-space handle census
 *  (`census.ts` — the shared classifier, at the transform the panels draw with) plus the two
 *  states that census cannot see. `flat` is a subset of the census's `single` (a flat key
 *  has no second side to break against), and `corners` come from the solve rather than from
 *  the drawing — a corner is deliberate, and no geometric reading of the handles could tell
 *  it apart from a defect. */
interface Vocab extends HandleStats {
    flat: number;
    corners: number;
    named: number;
    segments: number;
    keys: number;
}

const NO_VOCAB: Vocab = {
    mirror: 0,
    aligned: 0,
    broken: 0,
    single: 0,
    flat: 0,
    corners: 0,
    named: 0,
    segments: 0,
    keys: 0,
};

function vocab(s: Solve, i: number): Vocab {
    const fr = s.frames[i];
    const pts = fr.points;
    if (!pts) return NO_VOCAB;
    return {
        ...census(pts, chart(s, other()).scale),
        flat: pts.filter(flat).length,
        corners: fr.corners.length,
        named: namedSegments(pts).length,
        segments: Math.max(0, pts.length - 1),
        keys: pts.length,
    };
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
        stroke(s.openGeom.posX, s.openGeom.posY, s.openGeom.edges, FAINT, [3, 3], 1.5);
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
        ctx.fillText(s.openLabel, 92, 16);
        ctx.fillStyle = GOLD;
        ctx.fillText("integrated (f32)", 210, 16);
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
    if (fr.phase === "polish" || fr.phase === "quantize")
        line(s.openDense, uniform, FAINT, [3, 3], 1.5);
    if (fr.fN) line(fr.fN, uniform, GOLD, [], 2);

    if (fr.points) {
        const pts = fr.points;
        const corners = new Set(fr.corners);
        if (handlesBox.checked) {
            pts.forEach((p, k) => {
                const kx = px(p.s);
                const ky = py(p.g);
                ctx.lineWidth = 1;
                if (flat(p)) {
                    // a FLAT key stores no handles at all, and drawing nothing there would
                    // read as a key with no vocabulary rather than the one it has. What it
                    // resolves to is the Cubic tag's derived tangents: span/3 either side at
                    // Δg = 0 (`profile.segment`), which is exactly these two stubs.
                    // its own register: the legend's `○ flat` wears this neutral too, and
                    // green already means `aligned` two glyphs away.
                    ctx.strokeStyle = TEXT;
                    for (const reach of [
                        k > 0 ? -(p.s - pts[k - 1].s) / 3 : 0,
                        k + 1 < pts.length ? (pts[k + 1].s - p.s) / 3 : 0,
                    ]) {
                        if (reach === 0) continue;
                        ctx.beginPath();
                        ctx.moveTo(kx, ky);
                        ctx.lineTo(px(p.s + reach), ky);
                        ctx.stroke();
                    }
                    return;
                }
                const [a, b] = tipsOf(p, c);
                const state = handleState(p, c.scale);
                ctx.strokeStyle = state === "broken" ? RED : GREEN;
                ctx.fillStyle = ctx.strokeStyle;
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
            });
        }
        pts.forEach((p, k) => {
            const x = px(p.s);
            const y = py(p.g);
            ctx.beginPath();
            ctx.moveTo(x, y - 4);
            ctx.lineTo(x + 4, y);
            ctx.lineTo(x, y + 4);
            ctx.lineTo(x - 4, y);
            ctx.closePath();
            // hollow = no explicit handles: the same fill/stroke language the handle tips
            // already use for mirrored vs aligned.
            if (flat(p)) {
                ctx.strokeStyle = GOLD;
                ctx.stroke();
            } else {
                ctx.fillStyle = GOLD;
                ctx.fill();
            }
            // a corner is a broken key ON PURPOSE — the ring says the red handles beside it
            // are the loop's decision, not the ugliness the spike's fitted keys showed.
            if (corners.has(k)) {
                ctx.strokeStyle = RED;
                ctx.beginPath();
                ctx.arc(x, y, 7, 0, 2 * Math.PI);
                ctx.stroke();
            }
        });
    }
    ctx.restore();

    ctx.font = "11px 'JetBrains Mono', monospace";
    ctx.fillStyle = BLUE;
    ctx.fillText("target", PAD_L, 16);
    if (fr.phase === "polish" || fr.phase === "quantize") {
        ctx.fillStyle = FAINT;
        ctx.fillText(s.openLabel, PAD_L + 50, 16);
    }
    ctx.fillStyle = GOLD;
    ctx.fillText(fr.phase === "recover" ? "(no profile)" : fr.phase, PAD_L + 170, 16);
    if (alt) {
        ctx.fillStyle = GHOST;
        ctx.fillText(`${alt.mode} final`, PAD_L + 240, 16);
    }
    ctx.fillStyle = GREEN;
    ctx.fillText("aligned", PANEL_W - PAD_R - 148, 16);
    ctx.fillStyle = RED;
    ctx.fillText("broken", PANEL_W - PAD_R - 94, 16);
    ctx.fillStyle = TEXT;
    ctx.fillText("○ flat", PANEL_W - PAD_R - 46, 16);
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

// ── panel 4: the conversion table ──

const CONVERT_COLUMNS = [
    "scenario",
    "keys",
    "corners",
    "named",
    "segments",
    "dev (m)",
    "floor (m)",
    "peak (g)",
    "maxΔg",
    "λ",
    "events",
    "splits",
    "prunes",
    "stalls",
    "probes",
    "solves",
    "outcome",
    "ms",
];

function drawConvertTable(): void {
    convertTable.textContent = "";
    const head = el("tr", undefined, convertTable);
    for (const c of CONVERT_COLUMNS) el("th", undefined, head).textContent = c;
    for (let i = 0; i < scenarios.length; i++) {
        const s = solves.convert[i];
        const tr = el("tr", i === selected ? "sel" : undefined, convertTable);
        tr.style.cursor = "pointer";
        tr.onclick = (): void => select(scenarios[i].name);
        const cell = (text: string, color?: string): void => {
            const td = el("td", undefined, tr);
            td.textContent = text;
            if (color) td.style.color = color;
        };
        cell(scenarios[i].name);
        const cv = s?.row.convert;
        if (!s || !cv) {
            const failed = attempted.convert[i];
            for (let k = 1; k < CONVERT_COLUMNS.length; k++)
                cell(failed ? "—" : "…", failed ? RED : TEXT);
            continue;
        }
        const r = s.row;
        cell(`${r.keys}`);
        cell(`${cv.corners}`, cv.corners ? RED : undefined);
        cell(`${cv.named}`, cv.named ? GREEN : undefined);
        cell(`${cv.segments}`);
        cell(fmt(r.dev), r.heldFloor ? undefined : RED);
        cell(fmt(r.floor));
        cell(fmt(r.peak, 1));
        cell(fmt(r.maxDg, 1));
        cell(fmt(r.lambda, 1));
        cell(`${r.steps}`);
        cell(`${cv.splits}`);
        cell(`${cv.prunes}`);
        cell(`${cv.stalls}`);
        cell(`${cv.probes}`);
        cell(`${cv.solves}`);
        cell(cv.outcome, cv.outcome === "floor" ? undefined : RED);
        cell(r.ms.toFixed(0));
    }
}

// ── the text lines ──

/** one character per refine decision, so the strip reads as the loop's own trace. */
const EVENT_GLYPH: Record<RefineEvent["kind"], string> = {
    init: "I",
    split: "S",
    prune: "P",
    corner: "C",
    stall: "!",
    budget: "B",
    diverged: "X",
};

function drawPhases(): void {
    phaseBar.textContent = "";
    const s = current();
    if (!s) return;
    for (const seg of s.segments) {
        // the refine phase is one frame per structural DECISION, and which decisions the
        // loop made is the thing worth seeing — so it expands into its own chips rather than
        // collapsing to a count. Every other phase is a run of solver iterations, where the
        // count is all there is to say.
        if (seg.phase === "refine") {
            for (let i = seg.start; i <= seg.end; i++) {
                const e = s.frames[i].event;
                if (!e) continue;
                const chip = el("span", `ev ${e.kind}${i === frame ? " on" : ""}`, phaseBar);
                chip.textContent = EVENT_GLYPH[e.kind];
                chip.title = s.frames[i].label;
                chip.onclick = (): void => {
                    pause();
                    setFrame(i);
                };
            }
            continue;
        }
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
    const cv = r.convert;
    headLine.textContent =
        `${name} · ${mode} · ${r.keys} keys / ${r.dense} dense edges (${(r.dense / r.keys).toFixed(1)}×)` +
        (cv
            ? ` · refine ${r.steps} events (${cv.splits} split / ${cv.prunes} prune /` +
              ` ${cv.corners} corner${cv.stalls ? ` / ${cv.stalls} stall` : ""})` +
              ` · ${cv.named}/${cv.segments} named · ${cv.probes} probes / ${cv.solves} solves`
            : ` · ${r.steps} fit steps · fit ${fmt(s.fitError, 3)} g`) +
        ` · ${r.iters} iters / ${r.outers} outers` +
        ` · ${r.converged ? "converged" : "NOT CONVERGED"} · ${r.ms.toFixed(0)} ms` +
        (mode === "exact"
            ? ""
            : ` · λ ${fmt(r.lambda, 1)} · dev ${fmt(r.dev)} m (f32 round-trip)` +
              // the verdict is the SOLVE's own reading, on its f64 spine — a different
              // quantity from the f32 number beside it (they agree to ~1e-5 here, but
              // printing one and judging by the other would be a category error).
              ` · spine ${fmt(s.out.deviation)} vs floor ${fmt(r.floor)} m` +
              ` · ${r.heldFloor ? "floor held" : "FLOOR MISSED"}`) +
        (cv ? ` · outcome ${cv.outcome}` : "");

    const alt = other();
    const brief = (x: Solve): string =>
        `${x.mode}: dev ${fmt(x.row.dev)} m · peak ${fmt(x.row.peak, 1)} g · maxΔg ${fmt(x.row.maxDg, 1)}`;
    const ghost = mode === "convert" ? "exact" : mode === "exact" ? "calm" : "exact";
    // with the oracle box off there IS an exact solve, it is just not overlaid — saying
    // "not solved" would send a reader to re-solve something already in the table.
    const hidden = mode === "convert" && !oracleBox.checked && solves.exact[selected] !== null;
    cmpLine.textContent = alt
        ? `${brief(s)}    ‖    ${brief(alt)}`
        : hidden
          ? `${brief(s)}    ‖    exact oracle solved, hidden — tick the box to overlay it`
          : `${brief(s)}    ‖    ${ghost} not solved — press M`;

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
          : fr.event
            ? `probe at λ = 0${frame === s.warm ? " · the settled knot set" : ""}`
            : fr.points
              ? "the answer this phase settled on"
              : "the observation the pipeline chases";
    const v = fr.points ? vocab(s, frame) : null;
    // the census counts every key exactly once (`flat` is the subset of `single` that stores
    // no handles at all), so the four states plus the two the census cannot see are the whole
    // vocabulary reading of this frame.
    const handles = v
        ? ` · handles ${v.mirror} mirrored / ${v.aligned} aligned / ${v.broken} broken` +
          ` / ${v.single} one-sided (${v.flat} flat) · ${v.corners} corner · ` +
          `${v.named}/${v.segments} named`
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
    const conv = solves.convert.filter((s) => s !== null).length;
    statusLine.className = errors.length ? "mono err" : "mono";
    statusLine.textContent = errors.length
        ? `solved ${done}/${scenarios.length} exact · ${errors.join(" · ")}`
        : `solved ${done}/${scenarios.length} exact in ${elapsed.toFixed(0)} ms` +
          (ready ? " · corpus complete" : "") +
          (calm ? ` · ${calm}/${scenarios.length} calm` : "") +
          (conv ? ` · ${conv}/${scenarios.length} convert` : "") +
          (pending.size ? ` · solving ${[...pending].join(", ")}…` : "");
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
    drawConvertTable();
}

function select(name: string): void {
    const i = scenarios.findIndex((s) => s.name === name);
    if (i < 0) throw new Error(`no scenario named ${name}`);
    selected = i;
    picker.value = name;
    need(i, mode);
    reframe();
    status();
}

/** flip the panels between the two baseline modes and the conversion tier, solving the new
 *  side on demand — the corpus auto-run stays exact (calm is 5.1× its wall time and convert
 *  54× it, both measured). */
function setMode(m: LabMode): void {
    if (!MODES.includes(m)) throw new Error(`no such mode ${m}`);
    if (m === mode) return;
    mode = m;
    need(selected, m);
    reframe();
    status();
}

/** the next mode in the cycle — the `M` key and the mode button. */
function nextMode(): LabMode {
    return MODES[(MODES.indexOf(mode) + 1) % MODES.length];
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
modeBtn.onclick = (): void => setMode(nextMode());
calmBtn.onclick = (): void => pumpMode("calm");
convertBtn.onclick = (): void => pumpMode("convert");
handlesBox.onchange = (): void => draw();
// the oracle changes the shared axis as well as what is drawn, so the whole panel set
// re-reads rather than just the force graph.
oracleBox.onchange = (): void => {
    reframe();
    draw();
};
scrub.oninput = (): void => {
    pause();
    setFrame(Number(scrub.value));
};
window.addEventListener("keydown", (e) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "SELECT") return;
    if (e.key === "ArrowRight") setFrame(frame + 1);
    else if (e.key === "ArrowLeft") setFrame(frame - 1);
    else if (e.key === "m" || e.key === "M") setMode(nextMode());
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
function ensure(i: number, m: LabMode): void {
    if (solves[m][i] || attempted[m][i]) return;
    attempted[m][i] = true;
    try {
        solves[m][i] = run(scenarios[i], m);
        if (m === "exact") elapsed += solves[m][i]?.row.ms ?? 0;
    } catch (e) {
        errors.push(`${scenarios[i].name} (${m}): ${e instanceof Error ? e.message : String(e)}`);
    }
}

/** scenarios whose solve is scheduled but hasn't run yet — the status line's "solving…". */
const pending = new Set<string>();

/** ask for a solve the panels are about to draw. A baseline solve is fast enough to run
 *  inline (~130 ms), but a convert solve is 0.5–26 s on this corpus and JS has one thread:
 *  run it inline and the page never paints the "solving…" state it is about to sit in for
 *  half a minute. So convert is deferred one macrotask, which is the whole difference between
 *  a blank page and a page that says what it is doing. */
function need(i: number, m: LabMode): void {
    const key = `${scenarios[i].name} (${m})`;
    if (solves[m][i] || attempted[m][i] || pending.has(key)) return;
    if (m !== "convert") {
        ensure(i, m);
        return;
    }
    pending.add(key);
    setTimeout(() => {
        pending.delete(key);
        ensure(i, m);
        if (i === selected && m === mode) reframe();
        else drawConvertTable();
        status();
    }, 0);
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

/** one corpus sweep on demand, chunked so the page keeps painting between scenarios: the
 *  calm columns (the before/after violence table the verdict reads, ~6.7 s) or the whole
 *  conversion tier (~70 s measured — one scenario per macrotask, and double-hump's 26 s is
 *  one of them). */
function pumpMode(m: Exclude<LabMode, "exact">): void {
    // per SWEEP, not one shared flag: the two are independent corpora, and sharing a flag
    // makes `solveCalm()` a silent no-op for as long as a convert sweep is running.
    if (pumping[m]) return;
    pumping[m] = true;
    const btn = m === "calm" ? calmBtn : convertBtn;
    btn.disabled = true;
    const step = (): void => {
        const next = attempted[m].findIndex((a) => !a);
        if (next < 0) {
            pumping[m] = false;
            btn.textContent = `${m} corpus solved`;
            status();
            return;
        }
        ensure(next, m);
        drawTable();
        drawConvertTable();
        draw();
        status();
        setTimeout(step, 0);
    };
    setTimeout(step, 0);
}

// open on the shipping pipeline for the first scenario: `select` schedules its convert
// solve, and the exact corpus auto-run below fills the baseline table behind it.
select(scenarios[0].name);
status();
setTimeout(pump, 0);

/** the harness hook (the `__kex` pattern, `main.ts`): read-only diagnostics plus the
 *  controls a capture flow drives — flip a scenario, flip a mode, scrub a frame. `ready()`
 *  is the EXACT auto-run's gate (neither calm nor convert is ever auto-run, so a flow that
 *  wants one asks for it and polls `metrics()`); `errors()` must be empty for a run to mean
 *  anything. Additive since stage 4b: `mode()` can now answer `"convert"`, `phases()` then
 *  carries the pipeline's four phases, and `events`/`vocab`/`outcome` are new. */
(window as unknown as { __fitlab: unknown }).__fitlab = {
    scenarios: (): string[] => scenarios.map((s) => s.name),
    ready: (): boolean => ready,
    solved: (): number => solves.exact.filter((s) => s !== null).length,
    errors: (): string[] => [...errors],
    current: (): string => scenarios[selected].name,
    select,
    mode: (): LabMode => mode,
    setMode,
    frames: (): number => current()?.frames.length ?? 0,
    frame: (): number => frame,
    setFrame,
    /** the story frame: the last state before the answering solve. In a baseline mode that
     *  is the fit's last step, where a 0.03 g fit is still 40 m off; in convert it is the
     *  refine loop's settled knot set, the last frame the loop itself decided. */
    warmFrame: (): number => current()?.warm ?? 0,
    phases: (): { phase: Phase; start: number; end: number }[] =>
        (current()?.segments ?? []).map((s) => ({ phase: s.phase, start: s.start, end: s.end })),
    /** how the current frame's keyframes carry their handles. Censused through
     *  `chart(s, other())`, the transform the panels draw with: the classification is
     *  screen-space, so a count taken against any other transform would be a count of a
     *  picture nobody is looking at. */
    handles: (): HandleStats => {
        const s = current();
        const points = s?.frames[frame].points;
        return s && points
            ? census(points, chart(s, other()).scale)
            : { mirror: 0, aligned: 0, broken: 0, single: 0 };
    },
    /** the whole vocabulary reading of this frame: `handles()` plus the two states a
     *  screen-space handle census cannot see — how many keys are FLAT (no explicit handles,
     *  the state a named easing is stored as) and how many are CORNERS (broken on purpose,
     *  a decision of the refine loop rather than a property of the drawing) — plus how many
     *  segments the profile actually names. */
    vocab: (): Vocab => {
        const s = current();
        return s ? vocab(s, frame) : NO_VOCAB;
    },
    /** keyframes on THIS frame — what `handles()` censuses. Not `points().length`, which is
     *  the final polished profile: the two agree only because the polish holds the count
     *  fixed, and a check should not lean on a coincidence from another module. */
    frameKeys: (): number => current()?.frames[frame].points?.length ?? 0,
    /** the refine loop's decision stream for the current convert solve, each mapped to the
     *  frame that draws it — empty in a baseline mode, which runs no refine loop. */
    events: (): {
        kind: string;
        at: number;
        keys: number;
        corners: number;
        dev: number;
        frame: number;
    }[] =>
        (current()?.frames ?? []).flatMap((fr, i) =>
            fr.event
                ? [
                      {
                          kind: fr.event.kind,
                          at: fr.event.at,
                          keys: fr.event.knots.length,
                          corners: fr.event.corners.length,
                          dev: fr.event.deviation,
                          frame: i,
                      },
                  ]
                : [],
        ),
    /** how the refine loop ended: `"floor"` (the answer), `"budget"` (the sanctioned
     *  un-authorable outcome), `"diverged"` (a defect). Null in a baseline mode. */
    outcome: (): string | null => current()?.refined?.outcome ?? null,
    playing: (): boolean => playing,
    play,
    pause,
    solveCalm: (): void => pumpMode("calm"),
    solveConvert: (): void => pumpMode("convert"),
    rows: (m: LabMode = "exact"): Row[] =>
        solves[m].filter((s): s is Solve => s !== null).map((s) => s.row),
    metrics: (name?: string): Row | null =>
        (name === undefined ? current() : solves[mode][scenarios.findIndex((s) => s.name === name)])
            ?.row ?? null,
    points: (): ForcePoint[] => current()?.out.points ?? [],
};
