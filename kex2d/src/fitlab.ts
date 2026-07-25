// The geo→force fit research app (spec `kex/specs/kex2d-geoforce-spike.md` stage 4). A
// standalone canvas2D + DOM page — no shallot, no GPU, no Svelte — over the pure kernel
// (`scenarios.ts` → `section.evalGeo` → `fit.ts` → `polish.ts` → `section.evalForce`):
//
//   1. the VIEWPORT overlay — the original baked geo polyline, the geometry the stage-2
//      warm start integrates into, and the geometry the current frame's profile really
//      integrates into through the live f32 `evalForce` path, both exits marked;
//   2. the FORCE graph — the dense recovered F_n the fit chased, the stage-2 warm start,
//      the current sparse profile's dense force, and its keyframe diamonds. The y-range
//      spans every playback frame, so inter-key overshoot (valley-explicit reaches 40 g
//      between keys at −6.5 and 2.6 g) is never clipped out of the picture;
//   3. the METRICS table — the whole corpus, solved on load: keys, iterations, wall time,
//      the reference exit gap, geometry deviation warm → polished, and the dense peak
//      against the keyframe peak (their gap IS the overshoot).
//
// Read-only: nothing here authors. The scenario flipper and the iteration scrubber walk
// what the kernel already decided — frame 0 is the warm start, frames 1.. the solver's
// accepted steps — so the smoothing tradeoff can be judged by eye before the verdict stage.
//
// Served by vite at /fit-lab.html; captured by the Playwright harness, which drives the
// `window.__fitlab` hook below (auto-run completion, scenario flip, frame scrub).

import { fit } from "./fit";
import { polish, type PolishResult } from "./polish";
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
const MONO = "10px 'JetBrains Mono', monospace";

const PANEL_W = 620;
const PANEL_H = 340;
/** playback pace: one accepted-step frame per ~14 fps — fast enough to read as motion,
 *  slow enough that a 120-frame solve does not flash past. */
const FRAME_MS = 70;

/** one scenario's row in the corpus table. */
interface Row {
    name: string;
    /** sparse keyframes the fit landed on. */
    keys: number;
    /** dense edges of the geo bake — `dense/keys` is the compression. */
    dense: number;
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
}

/** one playback frame. Frame 0 is the STAGE-2 WARM START itself — `polish` records its
 *  first snapshot after the first accepted step, so without this the scrubber would start
 *  mid-solve and the delta the spike is about (a 0.03 g fit landing 40 m off) would never
 *  be on screen. Frames 1.. are the solver's accepted steps. */
interface Frame {
    label: string;
    points: readonly ForcePoint[];
    /** the dense force this frame's profile drives, on the uniform integration grid. */
    fN: ArrayLike<number>;
    /** the solver's dense spine at this step; null on the warm-start frame. */
    snap: PolishResult["snapshots"][number] | null;
}

/** everything one scenario's panels draw from. */
interface Solve {
    scenario: Scenario;
    entry: Entry;
    bake: SectionResult;
    /** the bake's cumulative chord arclength, length `bake.edges + 1`. */
    sigma: Float64Array;
    out: PolishResult;
    /** max |fitted − dense| the stage-2 fit left behind (g). */
    fitError: number;
    /** the warm start's dense force on the polish's uniform grid. */
    warmDense: Float32Array;
    /** the geometry the warm start integrates into — the static "fit alone" reference. */
    warmGeom: SectionResult;
    frames: Frame[];
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

/** bake → fit → polish → the reference round-trip, for one scenario. */
function run(scenario: Scenario): Solve {
    const entry = entryOf(scenario.v0);
    const t0 = performance.now();
    const bake = evalGeo(entry, scenario.nodes, scenario.ds);
    const f = fit(bake.fN, bake.ds, FIT_TOL);
    const out = polish({ bake, entry, points: f.points, ds: scenario.ds });
    const ms = performance.now() - t0;

    const sigma = new Float64Array(bake.edges + 1);
    for (let i = 0; i < bake.edges; i++) sigma[i + 1] = sigma[i] + bake.ds[i];

    const warmDense = forceProfile(f.points, out.length, out.ds);
    const finalDense = forceProfile(out.points, out.length, out.ds);
    const warm = evalForce(entry, warmDense, out.ds);
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
    sweep(warmDense);
    sweep(finalDense);
    for (const s of out.snapshots) sweep(s.fN);
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

    const frames: Frame[] = [
        { label: "warm start", points: f.points, fN: warmDense, snap: null },
        ...out.snapshots.map((snap) => ({
            label: `iter ${snap.step}`,
            points: snap.points,
            fN: snap.fN,
            snap,
        })),
    ];

    const solvedM = measure(bake, sigma, solved, out.ds);
    const row: Row = {
        name: scenario.name,
        keys: out.keys,
        dense: bake.edges,
        iters: out.iters,
        outers: out.outers,
        converged: out.converged,
        ms,
        exit: solvedM.exit,
        warmDev: measure(bake, sigma, warm, out.ds).dev,
        dev: solvedM.dev,
        peak,
        keyPeak,
    };

    return {
        scenario,
        entry,
        bake,
        sigma,
        out,
        fitError: f.maxError,
        warmDense,
        warmGeom: warm,
        frames,
        row,
        gLo: gLo - gPad,
        gHi: gHi + gPad,
        bounds: { minX, maxX, minY, maxY },
        geom: frames.map(() => null),
    };
}

/** the geometry frame `i`'s profile really integrates into — the live f32 `evalForce`
 *  path, not the solver's spine. Memoized per frame. */
function geometryAt(s: Solve, i: number): SectionResult {
    const hit = s.geom[i];
    if (hit) return hit;
    const points = s.frames[i].points;
    const res = evalForce(s.entry, forceProfile(points, s.out.length, s.out.ds), s.out.ds);
    s.geom[i] = res;
    return res;
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
const playBtn = el("button", undefined, bar);
playBtn.textContent = "Play";
const scrub = el("input", undefined, bar);
scrub.type = "range";
scrub.min = "0";
scrub.max = "0";
scrub.step = "1";
scrub.value = "0";
const frameLabel = el("span", "mono", bar);
const headLine = el("div", "mono", controls);
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
        `The dense recovered F_n the fit chased (blue), stage 2's warm start (faint), and this frame's sparse profile (gold) with its keyframes as diamonds. The y-range spans every frame, so nothing clips: where the gold curve leaves the diamonds far below it, that is <code>inter-key overshoot</code> — force the keyframes never show. The dense curve's s is the bake's cumulative chord, the profile's is the uniform integration grid; the two frames drift by up to ~1.2 m, expected.`,
    ),
    PANEL_W,
    PANEL_H,
);
const tablePanel = panel(
    "corpus",
    `Every scenario solved on load. <code>dev warm</code> → <code>dev polished</code> is what the constrained polish buys over the fit alone; <code>peak</code> vs <code>key peak</code> is what the keyframes hide. Click a row to flip the panels to it.`,
);
tablePanel.className = "panel wide";
const table = el("table", undefined, tablePanel);

// ── state ──

const solves: (Solve | null)[] = scenarios.map(() => null);
const attempted: boolean[] = scenarios.map(() => false);
const errors: string[] = [];
let selected = 0;
let frame = 0;
let playing = false;
let ready = false;
let elapsed = 0;

function current(): Solve | null {
    return solves[selected];
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
        ctx.fillText(`solving ${scenarios[selected].name}…`, 16, 24);
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
    stroke(s.warmGeom.posX, s.warmGeom.posY, s.warmGeom.edges, FAINT, [3, 3], 1.5);
    stroke(live.posX, live.posY, live.edges, GOLD, [6, 4], 2);

    // the exits: the pin closing is these two markers meeting.
    const ex = s.bake.edges;
    ctx.strokeStyle = BLUE;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(tx(s.bake.posX[ex]), ty(s.bake.posY[ex]), 6, 0, 2 * Math.PI);
    ctx.stroke();
    const lx = tx(live.posX[live.edges]);
    const ly = ty(live.posY[live.edges]);
    ctx.strokeStyle = GOLD;
    ctx.beginPath();
    ctx.moveTo(lx - 5, ly - 5);
    ctx.lineTo(lx + 5, ly + 5);
    ctx.moveTo(lx - 5, ly + 5);
    ctx.lineTo(lx + 5, ly - 5);
    ctx.stroke();
    ctx.fillStyle = TEXT;
    ctx.beginPath();
    ctx.arc(tx(s.bake.posX[0]), ty(s.bake.posY[0]), 3, 0, 2 * Math.PI);
    ctx.fill();

    ctx.font = "11px 'JetBrains Mono', monospace";
    ctx.fillStyle = BLUE;
    ctx.fillText("baked geo", 12, 16);
    ctx.fillStyle = FAINT;
    ctx.fillText("fit alone", 92, 16);
    ctx.fillStyle = GOLD;
    ctx.fillText("integrated (f32)", 168, 16);
}

// ── panel 2: the force graph ──

function drawForce(): void {
    const ctx = forceCtx;
    ctx.clearRect(0, 0, PANEL_W, PANEL_H);
    const s = current();
    if (!s) {
        ctx.font = MONO;
        ctx.fillStyle = TEXT;
        ctx.fillText(`solving ${scenarios[selected].name}…`, 16, 24);
        return;
    }
    const padL = 46;
    const padB = 34;
    const padT = 26;
    const padR = 14;
    const length = s.out.length;
    const px = (sv: number): number => padL + (sv / length) * (PANEL_W - padL - padR);
    const py = (g: number): number =>
        PANEL_H - padB - ((g - s.gLo) / (s.gHi - s.gLo)) * (PANEL_H - padB - padT);

    // gridlines: the g raster the eye reads spikes against.
    ctx.font = MONO;
    const gStep = niceStep((s.gHi - s.gLo) / 6);
    ctx.lineWidth = 1;
    for (let g = Math.ceil(s.gLo / gStep) * gStep; g <= s.gHi; g += gStep) {
        ctx.strokeStyle = GRID;
        ctx.beginPath();
        ctx.moveTo(padL, py(g));
        ctx.lineTo(PANEL_W - padR, py(g));
        ctx.stroke();
        ctx.fillStyle = TEXT;
        ctx.fillText(fmt(g, gStep >= 1 ? 0 : 2), 8, py(g) + 3);
    }
    const sStep = niceStep(length / 6);
    for (let sv = 0; sv <= length + 1e-9; sv += sStep) {
        ctx.strokeStyle = GRID;
        ctx.beginPath();
        ctx.moveTo(px(sv), padT);
        ctx.lineTo(px(sv), PANEL_H - padB);
        ctx.stroke();
        ctx.fillStyle = TEXT;
        ctx.fillText(`${sv.toFixed(0)}`, px(sv) - 6, PANEL_H - padB + 14);
    }
    // the 1 g physical baseline — the landmark airtime and heavy g's are read against.
    if (s.gLo < 1 && s.gHi > 1) {
        ctx.strokeStyle = FAINT;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(padL, py(1));
        ctx.lineTo(PANEL_W - padR, py(1));
        ctx.stroke();
        ctx.setLineDash([]);
    }
    ctx.fillStyle = TEXT;
    ctx.fillText("s (m) →", PANEL_W - padR - 46, PANEL_H - padB + 26);
    ctx.save();
    ctx.translate(12, padT + 10);
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
    line(s.bake.fN, (i) => s.sigma[i], BLUE, [], 1.5);
    line(s.warmDense, uniform, FAINT, [3, 3], 1.5);
    line(fr.fN, uniform, GOLD, [], 2);

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

    ctx.font = "11px 'JetBrains Mono', monospace";
    ctx.fillStyle = BLUE;
    ctx.fillText("dense recovered", padL, 16);
    ctx.fillStyle = FAINT;
    ctx.fillText("warm start", padL + 110, 16);
    ctx.fillStyle = GOLD;
    ctx.fillText("solving", padL + 190, 16);
}

// ── panel 3: the corpus table ──

const COLUMNS = [
    "scenario",
    "keys",
    "dense",
    "iters",
    "outers",
    "ms",
    "exit (m)",
    "dev warm (m)",
    "dev polished (m)",
    "peak (g)",
    "key peak (g)",
];

function drawTable(): void {
    table.textContent = "";
    const head = el("tr", undefined, table);
    for (const c of COLUMNS) el("th", undefined, head).textContent = c;
    for (let i = 0; i < scenarios.length; i++) {
        const s = solves[i];
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
            const failed = attempted[i];
            for (let k = 1; k < COLUMNS.length; k++) cell(failed ? "—" : "…", failed ? RED : TEXT);
            continue;
        }
        const r = s.row;
        cell(`${r.keys}`);
        cell(`${r.dense}`);
        cell(`${r.iters}`);
        cell(`${r.outers}`);
        cell(r.ms.toFixed(0));
        cell(fmt(r.exit), r.converged ? undefined : RED);
        cell(fmt(r.warmDev));
        cell(fmt(r.dev));
        cell(fmt(r.peak, 1));
        cell(fmt(r.keyPeak, 1), r.peak > 1.5 * Math.max(r.keyPeak, 1e-6) ? RED : undefined);
    }
}

// ── the text lines ──

function drawLines(): void {
    const s = current();
    const name = scenarios[selected].name;
    if (!s) {
        headLine.textContent = attempted[selected]
            ? `${name} — solve failed`
            : `${name} — solving…`;
        diagLine.textContent = "";
        frameLabel.textContent = "";
        return;
    }
    const r = s.row;
    headLine.textContent =
        `${name} · ${r.keys} keys / ${r.dense} dense edges (${(r.dense / r.keys).toFixed(1)}×)` +
        ` · ${r.iters} iters / ${r.outers} outers · ${r.converged ? "converged" : "NOT CONVERGED"}` +
        ` · ${r.ms.toFixed(0)} ms · fit ${fmt(s.fitError, 3)} g`;
    const fr = s.frames[frame];
    const m = measure(s.bake, s.sigma, geometryAt(s, frame), s.out.ds);
    const solver = fr.snap
        ? `outer ${fr.snap.outer} · feasibility ${fmt(fr.snap.feasibility)} m` +
          ` · spine dev ${fmt(fr.snap.deviation)} m · Φ ${fmt(fr.snap.phi)}` +
          ` · μ ${fmt(fr.snap.mu)} · ρ ${fmt(fr.snap.rho)}`
        : "stage-2 fit, unpolished";
    diagLine.textContent = `${fr.label} · integrated dev ${fmt(m.dev)} m · integrated exit ${fmt(m.exit)} m · ${solver}`;
    frameLabel.textContent = `frame ${frame + 1}/${s.frames.length}`;
}

function draw(): void {
    drawView();
    drawForce();
    drawLines();
}

function status(): void {
    const done = solves.filter((s) => s !== null).length;
    statusLine.className = errors.length ? "mono err" : "mono";
    statusLine.textContent = errors.length
        ? `solved ${done}/${scenarios.length} · ${errors.join(" · ")}`
        : `solved ${done}/${scenarios.length} in ${elapsed.toFixed(0)} ms` +
          (ready ? " · corpus complete" : "");
}

// ── controls ──

function setFrame(i: number): void {
    const s = current();
    const n = s ? s.frames.length : 1;
    frame = Math.max(0, Math.min(n - 1, Math.round(i)));
    scrub.value = `${frame}`;
    draw();
}

function select(name: string): void {
    const i = scenarios.findIndex((s) => s.name === name);
    if (i < 0) throw new Error(`no scenario named ${name}`);
    selected = i;
    picker.value = name;
    ensure(i);
    const s = current();
    scrub.max = `${(s ? s.frames.length : 1) - 1}`;
    pause();
    setFrame(s ? s.frames.length - 1 : 0); // land on the answer; scrub back for the story
    drawTable();
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
scrub.oninput = (): void => {
    pause();
    setFrame(Number(scrub.value));
};
window.addEventListener("keydown", (e) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "SELECT") return;
    if (e.key === "ArrowRight") setFrame(frame + 1);
    else if (e.key === "ArrowLeft") setFrame(frame - 1);
    else if (e.key === " ") {
        e.preventDefault();
        toggle();
    }
});

// ── auto-run: the whole corpus, chunked so the page stays responsive ──

/** solve scenario `i` if it hasn't been. A throw is RECORDED, not swallowed: the row goes
 *  dashed-red and the status line carries the message, so a corpus that stops solving can't
 *  read as a green page. */
function ensure(i: number): void {
    if (solves[i] || attempted[i]) return;
    attempted[i] = true;
    try {
        solves[i] = run(scenarios[i]);
        elapsed += solves[i]?.row.ms ?? 0;
    } catch (e) {
        errors.push(`${scenarios[i].name}: ${e instanceof Error ? e.message : String(e)}`);
    }
}

function pump(): void {
    const next = attempted.findIndex((a) => !a);
    if (next < 0) {
        ready = true;
        status();
        return;
    }
    ensure(next);
    if (next === selected) select(scenarios[next].name);
    else drawTable();
    status();
    setTimeout(pump, 0);
}

picker.value = scenarios[0].name;
draw();
drawTable();
status();
setTimeout(pump, 0);

/** the harness hook (the `__kex` pattern, `main.ts`): read-only diagnostics plus the two
 *  controls a capture flow drives — flip a scenario, scrub a frame. `ready()` is the
 *  auto-run gate; `errors()` must be empty for a run to mean anything. */
(window as unknown as { __fitlab: unknown }).__fitlab = {
    scenarios: (): string[] => scenarios.map((s) => s.name),
    ready: (): boolean => ready,
    solved: (): number => solves.filter((s) => s !== null).length,
    errors: (): string[] => [...errors],
    current: (): string => scenarios[selected].name,
    select,
    frames: (): number => current()?.frames.length ?? 0,
    frame: (): number => frame,
    setFrame,
    playing: (): boolean => playing,
    play,
    pause,
    rows: (): Row[] => solves.filter((s): s is Solve => s !== null).map((s) => s.row),
    metrics: (name?: string): Row | null =>
        (name === undefined ? current() : solves[scenarios.findIndex((s) => s.name === name)])
            ?.row ?? null,
    points: (): ForcePoint[] => current()?.out.points ?? [],
};
