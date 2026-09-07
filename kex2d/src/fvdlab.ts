// Visual observability for the Stage-3 FVD-limit de-risk (spec
// `kex/specs/kex2d-unified-solver.md`). A standalone canvas2D page — no shallot,
// no GPU — rendering the money-shots the text lab (`tests/fvd.lab.ts`) prints
// as numbers:
//
//   1. the FVD limit on the loop — sketch draft in, oracle-tracking solve out
//   2. tracking across aggressiveness — max dev + force err per profile
//   3. warm-start cost per target edit — the RTI budget preview
//
// Served by vite at /fvd-lab.html; captured by the Playwright harness.

import { collocate, type CollocateResult, type Terms } from "./collocate";
import { forces64 } from "./force";

const G = 9.80665;
const BLUE = "#5aa0d0";
const GOLD = "#e0a24a";
const FAINT = "#5a5248";
const GRID = "#2b261e";
const TEXT = "#9a9188";

interface Profile {
    name: string;
    fT: Float64Array;
    n: number;
    ds: number;
    v0: number;
}

function hills(A: number, ds = 0.5, S = 60, lambda = 30, v0 = 30): Profile {
    const N = Math.round(S / ds) + 1;
    const fT = new Float64Array(N);
    for (let i = 0; i < N; i++) fT[i] = 1 + A * Math.sin((2 * Math.PI * i * ds) / lambda);
    return { name: `hills A=${A}`, fT, n: N, ds, v0 };
}

function loopProfile(R = 10, ds = 0.5, lead = 15): Profile {
    const sLoop = 2 * Math.PI * R;
    const N = Math.round((2 * lead + sLoop) / ds) + 1;
    const v0 = Math.sqrt(5 * G * R);
    const fT = new Float64Array(N);
    for (let i = 0; i < N; i++) {
        const s = i * ds;
        if (s < lead || s >= lead + sLoop) {
            fT[i] = 1;
        } else {
            const phi = (s - lead) / R;
            fT[i] = (v0 * v0 - 2 * G * R * (1 - Math.cos(phi))) / (R * G) + Math.cos(phi);
        }
    }
    return { name: "0g loop", fT, n: N, ds, v0 };
}

/** f64 forward integration of the profile — the FVD oracle (mirrors
 *  `tests/helpers/forward64.ts`, inlined: labs don't import from tests/). */
function oracle(p: Profile): { x: Float64Array; y: Float64Array } {
    const x = new Float64Array(p.n);
    const y = new Float64Array(p.n);
    let theta = 0;
    let v = p.v0;
    for (let i = 0; i < p.n - 1; i++) {
        const dTheta = ((p.fT[i] - Math.cos(theta)) * G * p.ds) / (v * v);
        const mid = theta + 0.5 * dTheta;
        x[i + 1] = x[i] + p.ds * Math.cos(mid);
        y[i + 1] = y[i] + p.ds * Math.sin(mid);
        v = Math.sqrt(Math.max(v * v - 2 * G * (y[i + 1] - y[i]), 0));
        theta += dTheta;
    }
    return { x, y };
}

function sketch(p: Profile, o: { x: Float64Array; y: Float64Array }, amp = 1.5) {
    const lambda = 0.4 * (p.n - 1) * p.ds;
    const wx = Float64Array.from(o.x);
    const wy = Float64Array.from(o.y);
    for (let i = 1; i < p.n - 1; i++) {
        const tx = o.x[i + 1] - o.x[i - 1];
        const ty = o.y[i + 1] - o.y[i - 1];
        const len = Math.hypot(tx, ty) || 1;
        const w = amp * Math.sin((2 * Math.PI * i * p.ds) / lambda);
        wx[i] += (w * -ty) / len;
        wy[i] += (w * tx) / len;
    }
    return { x: wx, y: wy };
}

function dev(sx: Float64Array, sy: Float64Array, ox: Float64Array, oy: Float64Array): number {
    const N = sx.length;
    let max = 0;
    for (let i = 1; i < N - 1; i++) {
        let best = Number.POSITIVE_INFINITY;
        for (let j = 0; j < N - 1; j++) {
            const ex = ox[j + 1] - ox[j];
            const ey = oy[j + 1] - oy[j];
            const ee = ex * ex + ey * ey;
            let t = ee > 0 ? ((sx[i] - ox[j]) * ex + (sy[i] - oy[j]) * ey) / ee : 0;
            t = Math.max(0, Math.min(1, t));
            best = Math.min(best, Math.hypot(sx[i] - (ox[j] + t * ex), sy[i] - (oy[j] + t * ey)));
        }
        max = Math.max(max, best);
    }
    return max;
}

const STD: Terms = { shape: { w: 0.1 }, chord: { w: 1 } };

function solve(
    p: Profile,
    draft: { x: Float64Array; y: Float64Array },
    init?: CollocateResult,
): { res: CollocateResult; ms: number } {
    const t0 = performance.now();
    const res = collocate({
        fTarget: p.fT,
        x0: draft.x,
        y0: draft.y,
        ds: p.ds,
        v0: p.v0,
        wData: p.ds,
        terms: STD,
        xInit: init?.x,
        yInit: init?.y,
        maxIters: 200,
    });
    return { res, ms: performance.now() - t0 };
}

function forceErr(p: Profile, res: CollocateResult): number {
    const { fN } = forces64(res.x, res.y, p.n, p.v0);
    let m = 0;
    for (let i = 1; i < p.n - 1; i++) m = Math.max(m, Math.abs(fN[i] - p.fT[i]));
    return m;
}

function panel(title: string, desc: string, w: number, h: number): CanvasRenderingContext2D {
    const el = document.createElement("div");
    el.className = "panel";
    el.innerHTML = `<h2>${title}</h2><p>${desc}</p>`;
    const canvas = document.createElement("canvas");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    el.appendChild(canvas);
    document.getElementById("lab")?.appendChild(el);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    ctx.scale(dpr, dpr);
    return ctx;
}

function polyline(
    ctx: CanvasRenderingContext2D,
    xs: Float64Array,
    ys: Float64Array,
    px: (v: number) => number,
    py: (v: number) => number,
    style: string,
    dash: number[] = [],
): void {
    ctx.strokeStyle = style;
    ctx.setLineDash(dash);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < xs.length; i++) {
        if (i === 0) ctx.moveTo(px(xs[i]), py(ys[i]));
        else ctx.lineTo(px(xs[i]), py(ys[i]));
    }
    ctx.stroke();
    ctx.setLineDash([]);
}

// ── panel 1: the FVD limit on the loop ──
{
    const p = loopProfile();
    const o = oracle(p);
    const draft = sketch(p, o);
    const { res } = solve(p, draft);
    const d = dev(res.x, res.y, o.x, o.y);

    const w = 480;
    const h = 360;
    const pad = 30;
    const ctx = panel(
        "the FVD limit: sketch in, oracle out",
        `The 0g-loop F(σ) profile as a full-curve target. Sketch draft (dotted, warped 1.5 m off) → solved (gold) lands on the forward-integrated oracle (blue) to ${d.toFixed(2)} m — the conditioning-envelope gap, O(ds). Force achieved to ${forceErr(p, res).toExponential(1)} g. One solver, no modes.`,
        w,
        h,
    );
    let xMin = Number.POSITIVE_INFINITY;
    let xMax = Number.NEGATIVE_INFINITY;
    let yMax = 0;
    for (let i = 0; i < p.n; i++) {
        xMin = Math.min(xMin, o.x[i], res.x[i], draft.x[i]);
        xMax = Math.max(xMax, o.x[i], res.x[i], draft.x[i]);
        yMax = Math.max(yMax, o.y[i], res.y[i], draft.y[i]);
    }
    const scale = Math.min((w - 2 * pad) / (xMax - xMin), (h - 2 * pad) / yMax);
    const px = (v: number) => pad + (v - xMin) * scale;
    const py = (v: number) => h - pad - v * scale;

    ctx.strokeStyle = GRID;
    ctx.beginPath();
    ctx.moveTo(pad, py(0));
    ctx.lineTo(w - pad, py(0));
    ctx.stroke();
    polyline(ctx, draft.x, draft.y, px, py, FAINT, [3, 3]);
    polyline(ctx, o.x, o.y, px, py, BLUE);
    polyline(ctx, res.x, res.y, px, py, GOLD);
    ctx.font = "10px 'JetBrains Mono', monospace";
    ctx.fillStyle = FAINT;
    ctx.fillText("sketch", pad + 4, 16);
    ctx.fillStyle = BLUE;
    ctx.fillText("FVD oracle", pad + 52, 16);
    ctx.fillStyle = GOLD;
    ctx.fillText("solved", pad + 132, 16);
}

// ── panel 2: tracking across aggressiveness ──
{
    const profiles = [hills(0.25), hills(0.5), hills(1.0), hills(2.0), loopProfile()];
    const rows = profiles.map((p) => {
        const o = oracle(p);
        const { res } = solve(p, sketch(p, o));
        return { name: p.name, dev: dev(res.x, res.y, o.x, o.y), err: forceErr(p, res) };
    });

    const w = 520;
    const h = 300;
    const padL = 56;
    const padB = 40;
    const padT = 24;
    const ctx = panel(
        "tracking across aggressiveness",
        "Max deviation to the oracle (gold, m) and achieved-force error (blue, g), log scale, gentle hills → the 0g loop. Deviation stays centimeter-scale on hills and inside the conditioning envelope on the loop; force error never exceeds ~1e-3 g.",
        w,
        h,
    );
    const vals = rows.flatMap((r) => [r.dev, r.err]);
    const lo = Math.floor(Math.log10(Math.min(...vals)));
    const hi = Math.ceil(Math.log10(Math.max(...vals)));
    const py = (v: number) => h - padB - ((Math.log10(v) - lo) / (hi - lo)) * (h - padB - padT);
    const px = (i: number) => padL + ((i + 0.5) / rows.length) * (w - padL - 16);

    ctx.font = "10px 'JetBrains Mono', monospace";
    for (let e = lo; e <= hi; e++) {
        const yy = py(10 ** e);
        ctx.strokeStyle = GRID;
        ctx.beginPath();
        ctx.moveTo(padL, yy);
        ctx.lineTo(w - 16, yy);
        ctx.stroke();
        ctx.fillStyle = TEXT;
        ctx.fillText(`1e${e}`, 8, yy + 3);
    }
    for (const [key, color] of [
        ["dev", GOLD],
        ["err", BLUE],
    ] as const) {
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.beginPath();
        rows.forEach((r, i) => {
            const yy = py(r[key]);
            if (i === 0) ctx.moveTo(px(i), yy);
            else ctx.lineTo(px(i), yy);
        });
        ctx.stroke();
        rows.forEach((r, i) => {
            ctx.beginPath();
            ctx.arc(px(i), py(r[key]), 3, 0, 2 * Math.PI);
            ctx.fill();
        });
    }
    ctx.fillStyle = TEXT;
    rows.forEach((r, i) => {
        ctx.save();
        ctx.translate(px(i), h - padB + 12);
        ctx.rotate(-0.35);
        ctx.fillText(r.name, -24, 8);
        ctx.restore();
    });
    ctx.fillStyle = GOLD;
    ctx.fillText("max dev (m)", padL + 8, padT - 8);
    ctx.fillStyle = BLUE;
    ctx.fillText("force err (g)", padL + 108, padT - 8);
}

// ── panel 3: warm-start cost per target edit ──
{
    const cases: {
        name: string;
        cold: { iters: number; ms: number };
        warm: { iters: number; ms: number };
    }[] = [];

    {
        const p0 = hills(1.0);
        const o0 = oracle(p0);
        const draft = sketch(p0, o0);
        const base = solve(p0, draft);
        const p1 = hills(1.1);
        const cold = solve(p1, draft);
        const warm = solve(p1, draft, base.res);
        cases.push({
            name: "hills A 1.0→1.1",
            cold: { iters: cold.res.iters, ms: cold.ms },
            warm: { iters: warm.res.iters, ms: warm.ms },
        });
    }
    {
        const p0 = loopProfile();
        const o0 = oracle(p0);
        const draft = sketch(p0, o0);
        const base = solve(p0, draft);
        const p1: Profile = { ...p0, fT: Float64Array.from(p0.fT) };
        const apex = Math.round((15 + Math.PI * 10) / p0.ds);
        for (let k = -10; k <= 10; k++) p1.fT[apex + k] -= 0.3 * Math.exp(-(k * k) / 32);
        const cold = solve(p1, draft);
        const warm = solve(p1, draft, base.res);
        cases.push({
            name: "loop apex −0.3g",
            cold: { iters: cold.res.iters, ms: cold.ms },
            warm: { iters: warm.res.iters, ms: warm.ms },
        });
    }

    const w = 460;
    const h = 260;
    const padL = 30;
    const padB = 34;
    const padT = 20;
    const ctx = panel(
        "warm-start cost per target edit",
        "LM iterations to re-converge after editing the force target: cold (faint) vs warm-started from the previous solution (gold), milliseconds labeled. The warm path is the per-frame RTI budget the wire stage schedules against.",
        w,
        h,
    );
    const maxIt = Math.max(...cases.flatMap((c) => [c.cold.iters, c.warm.iters]), 1);
    const py = (v: number) => h - padB - (v / maxIt) * (h - padB - padT);
    const groupW = (w - padL - 16) / cases.length;
    ctx.font = "10px 'JetBrains Mono', monospace";
    cases.forEach((c, i) => {
        const x0 = padL + i * groupW + groupW * 0.18;
        const bw = groupW * 0.24;
        ctx.fillStyle = FAINT;
        ctx.fillRect(x0, py(c.cold.iters), bw, h - padB - py(c.cold.iters));
        ctx.fillStyle = GOLD;
        ctx.fillRect(x0 + bw + 8, py(c.warm.iters), bw, h - padB - py(c.warm.iters));
        ctx.fillStyle = TEXT;
        ctx.fillText(`${c.cold.iters}it/${c.cold.ms.toFixed(0)}ms`, x0 - 6, py(c.cold.iters) - 5);
        ctx.fillStyle = GOLD;
        ctx.fillText(
            `${c.warm.iters}it/${c.warm.ms.toFixed(0)}ms`,
            x0 + bw + 4,
            py(c.warm.iters) - 5,
        );
        ctx.fillStyle = TEXT;
        ctx.fillText(c.name, x0 - 4, h - padB + 16);
    });
}
