// Visual observability for the geometry→force atoms (spec
// `kex/specs/kex2d-collocation.md`, Stage 2). A standalone canvas2D page — no
// shallot, no GPU — rendering the three atom "money-shots" the text lab
// (`tests/geometry.lab.ts`) prints as numbers:
//
//   1. the banded ∂F/∂P sparsity heatmap — force is local
//   2. the round-trip overlay — draft P° vs forward(forces64(P°))
//   3. the conditioning plot — σ(∂F/∂P) flat vs σ(∂P/∂F) ~ N^1.56
//
// Served by vite at /geometry-lab.html; captured by the Playwright harness.

import { type ForceJac, forceJacobian, forces64 } from "./force";

const G = 9.80665;
const BLUE = "#5aa0d0";
const GOLD = "#e0a24a";
const GRID = "#2b261e";
const TEXT = "#9a9188";

/** f64 forward integrator (semi-implicit Euler in arclength) — inlined so the
 *  lab page stays self-contained (the test mirror lives in tests/helpers). */
function forward(
    F: Float64Array,
    N: number,
    ds: number,
    v0: number,
): { x: Float64Array; y: Float64Array } {
    const x = new Float64Array(N);
    const y = new Float64Array(N);
    let theta = 0;
    let v = v0;
    for (let i = 0; i < N - 1; i++) {
        const fN = F[Math.min(N - 1, i)];
        const dTheta = ((fN - Math.cos(theta)) * G * ds) / (v * v);
        const tNext = theta + dTheta;
        const mid = 0.5 * (theta + tNext);
        x[i + 1] = x[i] + ds * Math.cos(mid);
        y[i + 1] = y[i] + ds * Math.sin(mid);
        v = Math.sqrt(Math.max(v * v - 2 * G * (y[i + 1] - y[i]), 0));
        theta = tNext;
    }
    return { x, y };
}

function washboard(N: number, ds: number): Float64Array {
    const F = new Float64Array(N);
    for (let i = 0; i < N; i++) F[i] = 1 + 0.3 * Math.sin((2 * Math.PI * (i * ds)) / 20);
    return F;
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

// ── panel 1: ∂F/∂P sparsity heatmap ──
function sparsity(): void {
    const N = 26;
    const ds = 0.5;
    const v0 = 25;
    const p = forward(washboard(N, ds), N, ds, v0);
    const J: ForceJac = forceJacobian(p.x, p.y, N, v0);
    const rows = N - 2;
    const cols = 2 * N;
    const colOf = (r: number, t: number): number =>
        2 * [r, r, r + 1, r + 1, r + 2, r + 2][t] + (t % 2);

    let mx = 0;
    for (const v of J.entries) mx = Math.max(mx, Math.abs(v));

    const cell = 15;
    const pad = 8;
    const ctx = panel(
        "∂F/∂P is banded",
        `Each force row has 6 nonzeros in a 3-node window, so the Jacobian is banded — force is a <code>local</code> function of position. This locality is what makes the normal equations solvable exactly (JᵀJ half-bandwidth 5).`,
        cols * cell + 2 * pad,
        rows * cell + 2 * pad,
    );
    for (let r = 0; r < rows; r++) {
        for (let t = 0; t < 6; t++) {
            const c = colOf(r, t);
            const a = Math.min(1, (Math.log10(Math.abs(J.entries[r * 6 + t]) / mx) + 3) / 3);
            if (a <= 0) continue;
            // heat: dark → gold.
            ctx.fillStyle = `rgba(224, 162, 74, ${0.15 + 0.85 * a})`;
            ctx.fillRect(pad + c * cell + 1, pad + r * cell + 1, cell - 2, cell - 2);
        }
    }
}

// ── panel 2: round-trip overlay ──
function roundTrip(): void {
    const N = 150;
    const ds = 0.5;
    const v0 = 30;
    // a shaped draft (a rolling hill) so the track has visible form — the gentle
    // washboard is nearly straight and shows nothing.
    const F = new Float64Array(N);
    for (let i = 0; i < N; i++) F[i] = 1 + 0.9 * Math.sin((2 * Math.PI * (i * ds)) / 34);
    const draft = forward(F, N, ds, v0);
    const { fN } = forces64(draft.x, draft.y, N, v0);
    const recon = forward(fN, N, ds, v0);

    const w = 480;
    const h = 200;
    const pad = 20;
    const ctx = panel(
        "round-trip: draft vs forward(forces64(P°))",
        `Recover force from the drawn geometry, integrate it back. Geometry→force→geometry nearly reproduces the draft; the small end drift is the <code>ill-conditioned</code> inverse (force→geometry, σ~N^1.56) — exactly why the solver keeps geometry as the control, never force.`,
        w,
        h,
    );
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < N; i++) {
        minX = Math.min(minX, draft.x[i], recon.x[i]);
        maxX = Math.max(maxX, draft.x[i], recon.x[i]);
        minY = Math.min(minY, draft.y[i], recon.y[i]);
        maxY = Math.max(maxY, draft.y[i], recon.y[i]);
    }
    const s = Math.min((w - 2 * pad) / (maxX - minX), (h - 2 * pad) / (maxY - minY));
    const tx = (x: number) => pad + (x - minX) * s;
    const ty = (y: number) => h - pad - (y - minY) * s;
    const stroke = (px: Float64Array, py: Float64Array, color: string, dash: number[]) => {
        ctx.beginPath();
        ctx.setLineDash(dash);
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        for (let i = 0; i < N; i++) (i ? ctx.lineTo : ctx.moveTo).call(ctx, tx(px[i]), ty(py[i]));
        ctx.stroke();
    };
    stroke(draft.x, draft.y, BLUE, []);
    stroke(recon.x, recon.y, GOLD, [5, 4]);
    ctx.setLineDash([]);
    ctx.font = "11px 'JetBrains Mono', monospace";
    ctx.fillStyle = BLUE;
    ctx.fillText("draft P°", pad, 16);
    ctx.fillStyle = GOLD;
    ctx.fillText("forward(forces64(P°))", pad + 66, 16);
}

// ── panel 3: conditioning log-log ──
function conditioning(): void {
    const ds = 0.5;
    const v0 = 25;
    const Eps = 1e-5;
    const Ns = [32, 64, 128, 256, 512];

    const sigmaFP = (J: ForceJac): number => {
        const cols = 2 * J.n;
        const M = J.n - 2;
        const colOf = (r: number, t: number) => 2 * [r, r, r + 1, r + 1, r + 2, r + 2][t] + (t % 2);
        let v = new Float64Array(cols);
        for (let k = 0; k < cols; k++) v[k] = Math.sin(1.7 * k + 0.3);
        let sig = 0;
        for (let it = 0; it < 60; it++) {
            const wv = new Float64Array(M);
            for (let r = 0; r < M; r++)
                for (let t = 0; t < 6; t++) wv[r] += J.entries[r * 6 + t] * v[colOf(r, t)];
            const u = new Float64Array(cols);
            for (let r = 0; r < M; r++)
                for (let t = 0; t < 6; t++) u[colOf(r, t)] += J.entries[r * 6 + t] * wv[r];
            let nrm = 0;
            for (const uk of u) nrm += uk * uk;
            nrm = Math.sqrt(nrm);
            sig = Math.sqrt(nrm);
            v = new Float64Array(cols);
            for (let k = 0; k < cols; k++) v[k] = u[k] / nrm;
        }
        return sig;
    };
    const sigmaPF = (N: number): number => {
        const F = washboard(N, ds);
        let a = 0;
        let b = 0;
        let c = 0;
        for (let i = 0; i < N - 1; i++) {
            const fp = Float64Array.from(F);
            const fm = Float64Array.from(F);
            fp[i] += Eps;
            fm[i] -= Eps;
            const ep = forward(fp, N, ds, v0);
            const em = forward(fm, N, ds, v0);
            const jx = (ep.x[N - 1] - em.x[N - 1]) / (2 * Eps);
            const jy = (ep.y[N - 1] - em.y[N - 1]) / (2 * Eps);
            a += jx * jx;
            c += jy * jy;
            b += jx * jy;
        }
        const disc = Math.sqrt(Math.max((a + c) ** 2 / 4 - (a * c - b * b), 0));
        return Math.sqrt((a + c) / 2 + disc);
    };

    const fp = Ns.map((N) => {
        const p = forward(washboard(N, ds), N, ds, v0);
        return sigmaFP(forceJacobian(p.x, p.y, N, v0));
    });
    const pf = Ns.map(sigmaPF);

    const w = 460;
    const h = 260;
    const pad = 40;
    const ctx = panel(
        "conditioning: geometry→force is flat",
        `σ_max of each direction vs track length N. force→geometry blows up (~N^1.56, the wall the F_n solver hit); geometry→force is <code>flat</code> — the well-conditioned control the whole rebuild rests on.`,
        w,
        h,
    );
    const all = [...fp, ...pf];
    const lxN = Ns.map(Math.log);
    const lo = Math.log(Math.min(...all));
    const hi = Math.log(Math.max(...all));
    const px = (n: number) =>
        pad + ((Math.log(n) - lxN[0]) / (lxN.at(-1)! - lxN[0])) * (w - 1.6 * pad);
    const py = (s: number) => h - pad - ((Math.log(s) - lo) / (hi - lo)) * (h - 1.6 * pad);

    // axes
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
    for (const n of Ns) ctx.fillText(`${n}`, px(n) - 8, h - pad + 14);
    ctx.fillText("N →", w - 0.6 * pad - 4, h - pad + 26);
    ctx.save();
    ctx.translate(12, pad);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("σ_max (log)", -30, 0);
    ctx.restore();

    const line = (series: number[], color: string, label: string, ly: number) => {
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        for (let i = 0; i < Ns.length; i++)
            (i ? ctx.lineTo : ctx.moveTo).call(ctx, px(Ns[i]), py(series[i]));
        ctx.stroke();
        for (let i = 0; i < Ns.length; i++) {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(px(Ns[i]), py(series[i]), 3, 0, 2 * Math.PI);
            ctx.fill();
        }
        ctx.fillStyle = color;
        ctx.fillText(label, lx, ly);
    };
    // legend in the empty lower-right, on a backing so it never fights a line.
    const lx = w - 0.6 * pad - 216;
    ctx.fillStyle = "#100d08";
    ctx.fillRect(lx - 8, h - pad - 40, 224, 34);
    line(pf, GOLD, "∂P/∂F  force→geometry  ~N^1.56", h - pad - 24);
    line(fp, BLUE, "∂F/∂P  geometry→force  flat", h - pad - 10);
}

sparsity();
roundTrip();
conditioning();
