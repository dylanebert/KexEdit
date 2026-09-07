/** Read-only geo→force conversion lab.
 *
 * The default view is the shipping flat split→prune pipeline. The full-free fit→polish
 * result remains available as an opt-in numeric-floor oracle. Conversion solves on demand;
 * the lighter oracle corpus fills in cooperatively on load. */

import { census, type HandleStats } from "./census";
import { type ConvertProgress, convertPlayback } from "./convert";
import { arclength, fit } from "./fit";
import {
    baseline,
    forcePath,
    forceRange,
    type Frame,
    PANEL,
    panelScale,
    pipeline,
    segments,
    uniformAbscissa,
} from "./playback";
import { polish, type PolishResult } from "./polish";
import { custom, forceProfile } from "./profile";
import type { RefineResult } from "./refine";
import { type Scenario, scenarios } from "./scenarios";
import { type Entry, evalForce, evalGeo, type SectionResult } from "./section";

const FIT_TOL = 0.05;
const BLUE = "#5aa0d0";
const GOLD = "#e0a24a";
const GRID = "#2b261e";

type LabMode = "exact" | "convert";

interface Base {
    scenario: Scenario;
    entry: Entry;
    bake: SectionResult;
    sigma: Float64Array;
}

interface ExactSolve extends Base {
    mode: "exact";
    fit: ReturnType<typeof fit>;
    out: PolishResult;
    frames: Frame[];
    ms: number;
}

interface ConvertSolve extends Base {
    mode: "convert";
    refined: RefineResult;
    out: PolishResult;
    frames: Frame[];
    ms: number;
}

type Solve = ExactSolve | ConvertSolve;

const exact: (ExactSolve | null)[] = scenarios.map(() => null);
const converted: (ConvertSolve | null)[] = scenarios.map(() => null);
const failures: string[] = [];
let exactDone = false;
let selected = 0;
let mode: LabMode = "convert";
let frame = 0;
/** the scenario index a pooled solve is in flight for, or -1. */
let solving = -1;
let cancel: AbortController | null = null;
let progress: ConvertProgress = { phase: "open", keys: 0, probes: 0 };

const root = document.querySelector<HTMLDivElement>("#lab");
if (!root) throw new Error("fitlab: missing #lab");
const lab = root;

function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    parent: HTMLElement = lab,
): HTMLElementTagNameMap[K] {
    const out = document.createElement(tag);
    if (className) out.className = className;
    parent.append(out);
    return out;
}

const controls = element("section", "controls wide");
const row = element("div", "row", controls);
const chooser = element("select", undefined, row);
for (const scenario of scenarios) {
    const option = element("option", undefined, chooser);
    option.value = scenario.name;
    option.textContent = scenario.name;
}
const modeButton = element("button", undefined, row);
const status = element("span", "mono", row);
const phases = element("div", "phases", controls);
const scrub = element("input", "scrub", controls);
scrub.type = "range";
scrub.min = "0";
scrub.step = "1";
const label = element("div", "mono", controls);

const geometryPanel = element("section", "panel");
element("h2", undefined, geometryPanel).textContent = "integrated geometry";
element("p", undefined, geometryPanel).textContent =
    "Blue is the baked geo target; gold is the selected conversion/oracle frame through the live f32 force path.";
const geometry = element("canvas", undefined, geometryPanel);
geometry.width = PANEL.w;
geometry.height = PANEL.h;

const forcePanel = element("section", "panel");
element("h2", undefined, forcePanel).textContent = "force vocabulary";
element("p", undefined, forcePanel).textContent =
    "Shipping frames contain only g keys: every gold segment is the default flat-tangent Cubic.";
const force = element("canvas", undefined, forcePanel);
force.width = PANEL.w;
force.height = PANEL.h;

const corpusPanel = element("section", "panel wide");
element("h2", undefined, corpusPanel).textContent = "full-free oracle corpus";
element("p", undefined, corpusPanel).textContent =
    "The independent-handle numeric-floor negative control, solved cooperatively on load.";
const corpusTable = element("table", undefined, corpusPanel);

const convertPanel = element("section", "panel wide");
element("h2", undefined, convertPanel).textContent = "flat conversion";
element("p", undefined, convertPanel).textContent =
    "Split → exhaustive prune against chord deficit + 0.5 m. Solves on scenario flip.";
const convertTable = element("table", undefined, convertPanel);

const base = (scenario: Scenario): Base => {
    const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };
    const bake = evalGeo(entry, scenario.nodes, scenario.ds);
    return { scenario, entry, bake, sigma: arclength(bake.ds) };
};

function solveExact(index: number): ExactSolve {
    const started = performance.now();
    const item = base(scenarios[index]);
    const fitted = fit(item.bake.fN, item.bake.ds, FIT_TOL);
    const out = polish({
        bake: item.bake,
        entry: item.entry,
        points: fitted.points,
        ds: item.scenario.ds,
    });
    return {
        ...item,
        mode: "exact",
        fit: fitted,
        out,
        frames: baseline(fitted.steps, out),
        ms: performance.now() - started,
    };
}

async function solveConvert(index: number, signal: AbortSignal): Promise<ConvertSolve> {
    const started = performance.now();
    const item = base(scenarios[index]);
    const name = scenarios[index].name;
    const refined = await convertPlayback(item.bake, item.entry, item.scenario.ds, {
        signal,
        onProgress: (at) => {
            // both readouts belong to whatever the view is showing. A solve the user has
            // navigated away from keeps running (only a scenario flip cancels it), and must not
            // narrate over the surface that replaced it.
            if (index !== selected) return;
            progress = at;
            if (mode === "convert")
                status.textContent = `solving ${name}… ${at.phase} · ${at.probes} probes`;
        },
    });
    return {
        ...item,
        mode: "convert",
        refined,
        out: refined.final,
        frames: pipeline(refined, item.sigma),
        ms: performance.now() - started,
    };
}

function current(): Solve | null {
    return mode === "exact" ? exact[selected] : converted[selected];
}

/** Solve the selected scenario through the worker pool. The page keeps rendering and the status
 *  line keeps counting probes for the whole multi-second solve — flipping the scenario mid-solve
 *  cancels the stale one rather than queueing behind it. */
function scheduleConvert(): void {
    if (converted[selected] || solving === selected) return;
    cancel?.abort();
    const index = selected;
    const controller = new AbortController();
    cancel = controller;
    solving = index;
    progress = { phase: "open", keys: 0, probes: 0 };
    status.textContent = `solving ${scenarios[index].name}…`;
    solveConvert(index, controller.signal)
        .then((solve) => {
            converted[index] = solve;
        })
        .catch((error) => {
            if (!controller.signal.aborted)
                failures.push(`${scenarios[index].name} convert: ${String(error)}`);
        })
        .finally(() => {
            if (cancel !== controller) return;
            cancel = null;
            solving = -1;
            // a solve the view has moved on from lands silently: resetting the scrubber would
            // throw away the frame the author is looking at on a different scenario.
            if (index === selected) frame = 0;
            render();
        });
}

function drawPolyline(
    context: CanvasRenderingContext2D,
    x: ArrayLike<number>,
    y: ArrayLike<number>,
    color: string,
    bounds: { minX: number; maxX: number; minY: number; maxY: number },
): void {
    const sx = (PANEL.w - 50) / Math.max(1e-6, bounds.maxX - bounds.minX);
    const sy = (PANEL.h - 50) / Math.max(1e-6, bounds.maxY - bounds.minY);
    const scale = Math.min(sx, sy);
    const px = (value: number): number => 25 + (value - bounds.minX) * scale;
    const py = (value: number): number => PANEL.h - 25 - (value - bounds.minY) * scale;
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.beginPath();
    for (let i = 0; i < x.length; i++) {
        if (i === 0) context.moveTo(px(x[i]), py(y[i]));
        else context.lineTo(px(x[i]), py(y[i]));
    }
    context.stroke();
}

function geometryFrame(solve: Solve, selectedFrame: Frame): void {
    const context = geometry.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, geometry.width, geometry.height);
    const paths: { x: ArrayLike<number>; y: ArrayLike<number>; color: string }[] = [
        { x: solve.bake.posX, y: solve.bake.posY, color: BLUE },
    ];
    if (selectedFrame.points) {
        const step = { edges: solve.out.edges, ds: solve.out.ds };
        const out = evalForce(solve.entry, forceProfile(selectedFrame.points, step), step);
        paths.push({ x: out.posX, y: out.posY, color: GOLD });
    }
    const xs = paths.flatMap((path) => Array.from(path.x));
    const ys = paths.flatMap((path) => Array.from(path.y));
    const bounds = {
        minX: Math.min(...xs),
        maxX: Math.max(...xs),
        minY: Math.min(...ys),
        maxY: Math.max(...ys),
    };
    for (const path of paths) drawPolyline(context, path.x, path.y, path.color, bounds);
}

function forceFrame(solve: Solve, selectedFrame: Frame): void {
    const context = force.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, force.width, force.height);
    const { lo, hi } = forceRange(solve.frames, [solve.bake.fN]);
    const scale = panelScale(solve.out.length, lo, hi);
    const px = (s: number): number => PANEL.padL + s * scale.s;
    const py = (g: number): number => PANEL.h - PANEL.padB - (g - lo) * scale.g;
    context.strokeStyle = GRID;
    context.strokeRect(
        PANEL.padL,
        PANEL.padT,
        PANEL.w - PANEL.padL - PANEL.padR,
        PANEL.h - PANEL.padT - PANEL.padB,
    );
    const draw = (values: ArrayLike<number>, abscissa: ArrayLike<number>, color: string): void => {
        context.strokeStyle = color;
        context.lineWidth = 1.5;
        context.beginPath();
        for (const [index, point] of forcePath(values, abscissa, scale, lo).entries()) {
            if (index === 0) context.moveTo(point.x, point.y);
            else context.lineTo(point.x, point.y);
        }
        context.stroke();
    };
    draw(solve.bake.fN, solve.sigma, BLUE);
    if (!selectedFrame.points) return;
    const dense =
        selectedFrame.fN ??
        forceProfile(selectedFrame.points, { edges: solve.out.edges, ds: solve.out.ds });
    draw(dense, uniformAbscissa(dense.length, solve.out.ds), GOLD);
    context.fillStyle = GOLD;
    for (const point of selectedFrame.points) {
        const x = px(point.s);
        const y = py(point.g);
        context.beginPath();
        context.moveTo(x, y - 5);
        context.lineTo(x + 5, y);
        context.lineTo(x, y + 5);
        context.lineTo(x - 5, y);
        context.closePath();
        if (solve.mode === "convert") context.stroke();
        else context.fill();
    }
}

function table(
    target: HTMLTableElement,
    headings: string[],
    values: readonly (readonly (string | number)[])[],
): void {
    target.replaceChildren();
    const head = element("tr", undefined, target);
    for (const heading of headings) element("th", undefined, head).textContent = heading;
    for (const row of values) {
        const tr = element("tr", undefined, target);
        for (const value of row) element("td", undefined, tr).textContent = String(value);
    }
}

function renderTables(): void {
    table(
        corpusTable,
        ["scenario", "keys", "dev m", "exit m", "ms"],
        exact.flatMap((solve) =>
            solve
                ? [
                      [
                          solve.scenario.name,
                          solve.out.keys,
                          solve.out.deviation.toFixed(4),
                          solve.out.exit.dist.toExponential(1),
                          solve.ms.toFixed(0),
                      ],
                  ]
                : [],
        ),
    );
    table(
        convertTable,
        ["scenario", "keys", "dev / floor m", "probes", "outcome", "ms"],
        converted.flatMap((solve) =>
            solve
                ? [
                      [
                          solve.scenario.name,
                          solve.out.keys,
                          `${solve.out.deviation.toFixed(3)} / ${solve.refined.floor.toFixed(3)}`,
                          solve.refined.probes,
                          solve.refined.outcome,
                          solve.ms.toFixed(0),
                      ],
                  ]
                : [],
        ),
    );
}

function render(): void {
    modeButton.textContent = `mode: ${mode}`;
    const solve = current();
    if (!solve) {
        status.textContent =
            solving === selected ? `solving ${scenarios[selected].name}…` : `${mode} unavailable`;
        phases.replaceChildren();
        label.textContent = "";
        renderTables();
        return;
    }
    frame = Math.max(0, Math.min(frame, solve.frames.length - 1));
    scrub.max = String(solve.frames.length - 1);
    scrub.value = String(frame);
    status.textContent = `${solve.scenario.name} · ${solve.out.keys} keys · ${solve.ms.toFixed(0)} ms`;
    label.textContent = solve.frames[frame].label;
    phases.replaceChildren();
    const chips =
        solve.mode === "convert"
            ? solve.frames.map((item, index) => ({
                  label:
                      index === 0
                          ? "recover"
                          : `${item.event?.kind ?? "decision"}${index === solve.frames.length - 1 ? " · answer" : ""}`,
                  start: index,
                  end: index,
                  event: item.event,
              }))
            : segments(solve.frames).map((segment) => ({ ...segment, event: null }));
    for (const segment of chips) {
        const chip = element("span", undefined, phases);
        chip.textContent = segment.label;
        if (segment.event) {
            chip.classList.add("ev", segment.event.kind);
            if (segment.end === solve.frames.length - 1) chip.classList.add("terminal");
        }
        chip.classList.toggle("on", frame >= segment.start && frame <= segment.end);
        chip.onclick = () => {
            frame = segment.end;
            render();
        };
    }
    geometryFrame(solve, solve.frames[frame]);
    forceFrame(solve, solve.frames[frame]);
    renderTables();
}

chooser.onchange = () => {
    selected = scenarios.findIndex((scenario) => scenario.name === chooser.value);
    frame = 0;
    mode = "convert";
    scheduleConvert();
    render();
};
modeButton.onclick = () => {
    mode = mode === "convert" ? "exact" : "convert";
    frame = 0;
    if (mode === "convert") scheduleConvert();
    render();
};
scrub.oninput = () => {
    frame = Number(scrub.value);
    render();
};

function pumpExact(index = 0): void {
    if (index >= scenarios.length) {
        exactDone = true;
        render();
        return;
    }
    setTimeout(() => {
        try {
            exact[index] = solveExact(index);
        } catch (error) {
            failures.push(`${scenarios[index].name} exact: ${String(error)}`);
        }
        render();
        pumpExact(index + 1);
    }, 0);
}

interface Metrics {
    name: string;
    keys: number;
    heldFloor: boolean;
    ms: number;
}

const hook = {
    ready: (): boolean => exactDone,
    errors: (): string[] => [...failures],
    mode: (): LabMode => mode,
    setMode: (next: LabMode): void => {
        if (next !== "exact" && next !== "convert") throw new Error(`unknown mode ${next}`);
        mode = next;
        frame = 0;
        if (mode === "convert") scheduleConvert();
        render();
    },
    select: (name: string): void => {
        const index = scenarios.findIndex((scenario) => scenario.name === name);
        if (index < 0) throw new Error(`unknown scenario ${name}`);
        selected = index;
        chooser.value = name;
        mode = "convert";
        frame = 0;
        scheduleConvert();
        render();
    },
    rows: (which: LabMode = "exact"): unknown[] =>
        (which === "exact" ? exact : converted).flatMap((solve) =>
            solve
                ? [
                      {
                          name: solve.scenario.name,
                          keys: solve.out.keys,
                          converged: solve.out.converged,
                          ms: solve.ms,
                          heldFloor:
                              solve.mode === "exact"
                                  ? true
                                  : solve.out.deviation <= solve.refined.floor,
                      },
                  ]
                : [],
        ),
    phases: (): ReturnType<typeof segments> => {
        const solve = current();
        return solve ? segments(solve.frames) : [];
    },
    frames: (): number => current()?.frames.length ?? 0,
    warmFrame: (): number => {
        const solve = current();
        if (!solve) return -1;
        if (solve.mode === "convert") return solve.frames.length - 1;
        return segments(solve.frames).find((segment) => segment.phase === "fit")?.end ?? -1;
    },
    setFrame: (next: number): void => {
        frame = next;
        render();
    },
    frameKeys: (): number => current()?.frames[frame]?.points?.length ?? 0,
    handles: (): HandleStats => {
        const solve = current();
        const points = solve?.frames[frame]?.points;
        if (!solve || !points) return { mirror: 0, aligned: 0, broken: 0, single: 0 };
        const { lo, hi } = forceRange(solve.frames, [solve.bake.fN]);
        return census(points, panelScale(solve.out.length, lo, hi));
    },
    events: (): { kind: string; keys: number; frame: number }[] => {
        const solve = current();
        if (solve?.mode !== "convert") return [];
        return solve.frames.flatMap((item, index) =>
            item.event
                ? [{ kind: item.event.kind, keys: item.event.knots.length, frame: index }]
                : [],
        );
    },
    outcome: (): string | null => {
        const solve = current();
        return solve?.mode === "convert" ? solve.refined.outcome : null;
    },
    vocab: (): {
        mirror: number;
        aligned: number;
        broken: number;
        single: number;
        flat: number;
        named: number;
        segments: number;
        keys: number;
    } => {
        const solve = current();
        const points = solve?.frames[frame]?.points ?? [];
        const stats = hook.handles();
        const flat = points.filter(
            (point) => !point.in && !point.out && point.ease === undefined,
        ).length;
        let named = 0;
        for (let k = 0; k + 1 < points.length; k++) if (!custom(points[k], points[k + 1])) named++;
        return {
            ...stats,
            flat,
            named,
            segments: Math.max(0, points.length - 1),
            keys: points.length,
        };
    },
    /** the in-flight solve's last progress event. Polled by the capture flow together with
     *  `metrics()`: probes counted with no answer yet is a state only an off-thread solve can
     *  show — a blocking one answers the poll after it has already finished. */
    progress: (): ConvertProgress => progress,
    metrics: (): Metrics | null => {
        const solve = current();
        if (solve?.mode !== "convert") return null;
        return {
            name: solve.scenario.name,
            keys: solve.out.keys,
            heldFloor: solve.out.deviation <= solve.refined.floor,
            ms: solve.ms,
        };
    },
};

(window as unknown as { __fitlab: typeof hook }).__fitlab = hook;
pumpExact();
scheduleConvert();
render();
