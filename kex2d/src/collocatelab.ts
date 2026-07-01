// Visual observability for the Stage-3 collocation solver (spec
// `kex/specs/kex2d-collocation.md`). A standalone canvas2D page — no shallot, no
// GPU — rendering the money-shots the text lab (`tests/collocate.lab.ts`) prints
// as numbers:
//
//   1. the convergence curve — ‖r‖ vs iteration, log-y (LM actually descends)
//   2. solved-vs-analytic overlay — the perturbed guess warps onto the circle
//   3. solved force vs target force — F(P_solved) tracking F*
//
// This is "geometry-primal collocation, solved": force fixes the shape (a common
// Stage-3 finding), and LM's μI is the only regularizer.
//
// Served by vite at /collocate-lab.html; captured by the Playwright harness.

import { collocate } from "./collocate";
import { forces64 } from "./force";

const G = 9.80665;
const R = 12; // arc centered at (0, R), radius R
const V0 = 30;
const BLUE = "#5aa0d0";
const GOLD = "#e0a24a";
const FAINT = "#5a5248";
const GRID = "#2b261e";
const TEXT = "#9a9188";

function arc(N: number, ds: number) {
    const x = new Float64Array(N);
    const y = new Float64Array(N);
    const fStar = new Float64Array(N);
    for (let i = 0; i < N; i++) {
        const s = i * ds;
        x[i] = R * Math.sin(s / R);
        y[i] = R * (1 - Math.cos(s / R));
        const v2 = V0 * V0 - 2 * G * y[i];
        fStar[i] = v2 / (R * G) + Math.cos(s / R);
    }
    return { x, y, fStar };
}

function perturb(x: Float64Array, y: Float64Array, ds: number, amp: number, lambda: number) {
    const N = x.length;
    const px = Float64Array.from(x);
    const py = Float64Array.from(y);
    for (let i = 1; i < N - 1; i++) {
        const s = i * ds;
        const w = amp * Math.sin((2 * Math.PI * s) / lambda);
        px[i] += w * -Math.sin(s / R);
        py[i] += w * Math.cos(s / R);
    }
    return { px, py };
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

// one shared solve (a strong perturbation so the warp is visible).
const ds = 0.25;
const N = Math.floor(15 / ds) + 1;
const { x: ax, y: ay, fStar } = arc(N, ds);
const { px, py } = perturb(ax, ay, ds, 0.6, 6);
const res = collocate({ fTarget: fStar, x0: px, y0: py, ds, v0: V0 });
const solvedF = forces64(res.x, res.y, N, ds, V0).fN;

// ── panel 1: convergence curve (log-y) ──
function convergence(): void {
    const w = 460;
    const h = 240;
    const pad = 40;
    const ctx = panel(
        "LM converges: ‖r‖ vs iteration",
        `Levenberg-Marquardt Gauss-Newton on the pure force residual. μI is the <code>only</code> regularizer — it makes the rank-deficient JᵀJ solvable and globalizes; the force residual drops toward the O(ds²) floor.`,
        w,
        h,
    );
    const rs = res.history.map((p) => Math.max(p.residual, 1e-12));
    const lo = Math.log10(Math.min(...rs));
    const hi = Math.log10(Math.max(...rs));
    const px2 = (i: number) => pad + (i / (rs.length - 1)) * (w - 1.6 * pad);
    const py2 = (r: number) => h - pad - ((Math.log10(r) - lo) / (hi - lo)) * (h - 1.6 * pad);

    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, h - pad);
    ctx.lineTo(w - 0.6 * pad, h - pad);
    ctx.moveTo(pad, h - pad);
    ctx.lineTo(pad, 0.6 * pad);
    ctx.stroke();
    ctx.font = "10px 'JetBrains Mono', monospace";
    ctx.fillStyle = TEXT;
    ctx.fillText("iter →", w - 0.6 * pad - 4, h - pad + 20);
    ctx.save();
    ctx.translate(12, pad);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("‖r‖ (log)", -18, 0);
    ctx.restore();

    ctx.beginPath();
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 2;
    for (let i = 0; i < rs.length; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, px2(i), py2(rs[i]));
    ctx.stroke();
    for (let i = 0; i < rs.length; i++) {
        ctx.fillStyle = GOLD;
        ctx.beginPath();
        ctx.arc(px2(i), py2(rs[i]), 2.5, 0, 2 * Math.PI);
        ctx.fill();
    }
}

// ── panel 2: solved-vs-analytic overlay ──
function overlay(): void {
    const w = 480;
    const h = 220;
    const pad = 20;
    const ctx = panel(
        "solved geometry vs the analytic circle",
        `The perturbed guess (dotted) warps onto the analytic arc (blue) as the solver drives force to target. Force fixes the <code>shape</code>, not where nodes sit along it — recovery is measured as distance to the circle.`,
        w,
        h,
    );
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < N; i++) {
        minX = Math.min(minX, ax[i], px[i], res.x[i]);
        maxX = Math.max(maxX, ax[i], px[i], res.x[i]);
        minY = Math.min(minY, ay[i], py[i], res.y[i]);
        maxY = Math.max(maxY, ay[i], py[i], res.y[i]);
    }
    const s = Math.min((w - 2 * pad) / (maxX - minX), (h - 2 * pad) / (maxY - minY));
    const tx = (x: number) => pad + (x - minX) * s;
    const ty = (y: number) => h - pad - (y - minY) * s;
    const stroke = (px2: Float64Array, py2: Float64Array, color: string, dash: number[]) => {
        ctx.beginPath();
        ctx.setLineDash(dash);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        for (let i = 0; i < N; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, tx(px2[i]), ty(py2[i]));
        ctx.stroke();
    };
    stroke(px, py, FAINT, [3, 3]);
    stroke(ax, ay, BLUE, []);
    stroke(res.x, res.y, GOLD, [6, 4]);
    ctx.setLineDash([]);
    ctx.font = "11px 'JetBrains Mono', monospace";
    ctx.fillStyle = FAINT;
    ctx.fillText("guess", pad, 16);
    ctx.fillStyle = BLUE;
    ctx.fillText("analytic", pad + 44, 16);
    ctx.fillStyle = GOLD;
    ctx.fillText("solved", pad + 108, 16);
}

// ── panel 3: solved force vs target force ──
function force(): void {
    const w = 460;
    const h = 220;
    const pad = 36;
    const ctx = panel(
        "solved force vs target",
        `F(P_solved) (gold) tracks the target F* (blue) across the track. The residual floor is the O(ds²) geometry→force discretization, not optimizer error.`,
        w,
        h,
    );
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (let i = 1; i < N - 1; i++) {
        lo = Math.min(lo, fStar[i], solvedF[i]);
        hi = Math.max(hi, fStar[i], solvedF[i]);
    }
    const px2 = (i: number) => pad + ((i - 1) / (N - 3)) * (w - 1.6 * pad);
    const py2 = (f: number) => h - pad - ((f - lo) / (hi - lo)) * (h - 1.6 * pad);

    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, h - pad);
    ctx.lineTo(w - 0.6 * pad, h - pad);
    ctx.moveTo(pad, h - pad);
    ctx.lineTo(pad, 0.6 * pad);
    ctx.stroke();
    ctx.font = "10px 'JetBrains Mono', monospace";
    ctx.fillStyle = TEXT;
    ctx.fillText("node →", w - 0.6 * pad - 4, h - pad + 20);
    ctx.save();
    ctx.translate(12, pad);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("F_n (g)", -14, 0);
    ctx.restore();

    const line = (f: Float64Array, color: string, dash: number[]) => {
        ctx.beginPath();
        ctx.setLineDash(dash);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        for (let i = 1; i < N - 1; i++)
            (i > 1 ? ctx.lineTo : ctx.moveTo).call(ctx, px2(i), py2(f[i]));
        ctx.stroke();
    };
    line(fStar, BLUE, []);
    line(solvedF, GOLD, [6, 4]);
    ctx.setLineDash([]);
    ctx.fillStyle = BLUE;
    ctx.fillText("target F*", pad, 16);
    ctx.fillStyle = GOLD;
    ctx.fillText("solved", pad + 70, 16);
}

convergence();
overlay();
force();
