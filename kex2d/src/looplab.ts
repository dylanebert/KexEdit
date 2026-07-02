// Visual observability for the Stage-2 loop solve (spec
// `kex/specs/kex2d-unified-solver.md`). A standalone canvas2D page — no shallot,
// no GPU — rendering the money-shots the text lab (`tests/loop.lab.ts`) prints
// as numbers:
//
//   1. draft vs solved geometry — the circle reshapes under the comfort band
//   2. force curves — F(draft) breaking the band, F(solved) inside it, the pin hit
//   3. the losing constraint — an infeasible pin compromises AT the band floor,
//      its residual the legible "this constraint is losing" signal
//
// Served by vite at /loop-lab.html; captured by the Playwright harness.

import { collocateAL } from "./collocate";
import { forces64 } from "./force";

const G = 9.80665;
const BLUE = "#5aa0d0";
const GOLD = "#e0a24a";
const RED = "#d06a5a";
const FAINT = "#5a5248";
const GRID = "#2b261e";
const TEXT = "#9a9188";

const R = 10;
const DS = 0.5;
const LEAD = 15;
const LO = -1;
const HI = 4;

// the 0g-loop draft: straight lead, full circle, straight exit; v0 = √(5gR)
// gives the classic profile (0g apex, 6g bottom, 1g leads).
const sLoop = 2 * Math.PI * R;
const N = Math.round((2 * LEAD + sLoop) / DS) + 1;
const APEX = Math.round((LEAD + Math.PI * R) / DS);
const V0 = Math.sqrt(5 * G * R);
const dx = new Float64Array(N);
const dy = new Float64Array(N);
for (let i = 0; i < N; i++) {
    const s = i * DS;
    if (s < LEAD) {
        dx[i] = s - LEAD;
        dy[i] = 0;
    } else if (s < LEAD + sLoop) {
        const phi = (s - LEAD) / R;
        dx[i] = R * Math.sin(phi);
        dy[i] = R * (1 - Math.cos(phi));
    } else {
        dx[i] = s - LEAD - sLoop;
        dy[i] = 0;
    }
}

function solve(fPin: number) {
    const wF = new Float64Array(N);
    wF[APEX] = 100;
    const fTarget = new Float64Array(N);
    fTarget[APEX] = fPin;
    return collocateAL(
        {
            fTarget,
            x0: dx,
            y0: dy,
            ds: DS,
            v0: V0,
            wData: 0,
            terms: {
                wF,
                band: { lo: LO, hi: HI, w: 50 },
                shape: { w: 0.1 },
                chord: { w: 1 },
            },
            maxIters: 15,
        },
        { tol: 1e-3, outers: 40 },
    );
}

const teardrop = solve(-0.3);
const infeasible = solve(-5);
const draftF = forces64(dx, dy, N, V0).fN;
const tearF = forces64(teardrop.x, teardrop.y, N, V0).fN;
const infF = forces64(infeasible.x, infeasible.y, N, V0).fN;

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

// ── panel 1: draft vs solved geometry ──
{
    const w = 460;
    const h = 340;
    const pad = 30;
    const ctx = panel(
        "the loop reshapes under the band",
        `Draft circle (dotted) vs solved (gold): comfort band [−1, 4]g caps the bottom's 6g, so the bottom widens (κ×0.6) while the apex pin <code>F*=−0.3</code> holds the top. Real reshaping — the force map is parametrization-invariant, so it cannot be satisfied by sliding samples.`,
        w,
        h,
    );
    let xMin = Number.POSITIVE_INFINITY;
    let xMax = Number.NEGATIVE_INFINITY;
    let yMax = 0;
    for (let i = 0; i < N; i++) {
        xMin = Math.min(xMin, dx[i], teardrop.x[i]);
        xMax = Math.max(xMax, dx[i], teardrop.x[i]);
        yMax = Math.max(yMax, dy[i], teardrop.y[i]);
    }
    const scale = Math.min((w - 2 * pad) / (xMax - xMin), (h - 2 * pad) / yMax);
    const px = (v: number) => pad + (v - xMin) * scale;
    const py = (v: number) => h - pad - v * scale;

    ctx.strokeStyle = GRID;
    ctx.beginPath();
    ctx.moveTo(pad, py(0));
    ctx.lineTo(w - pad, py(0));
    ctx.stroke();
    polyline(ctx, dx, dy, px, py, FAINT, [3, 3]);
    polyline(ctx, teardrop.x, teardrop.y, px, py, GOLD);
    ctx.fillStyle = BLUE;
    ctx.beginPath();
    ctx.arc(px(teardrop.x[APEX]), py(teardrop.y[APEX]), 3.5, 0, 2 * Math.PI);
    ctx.fill();
    ctx.font = "10px 'JetBrains Mono', monospace";
    ctx.fillStyle = TEXT;
    ctx.fillText("draft", pad + 4, 16);
    ctx.fillStyle = GOLD;
    ctx.fillText("solved", pad + 44, 16);
    ctx.fillStyle = BLUE;
    ctx.fillText("pin F*=−0.3", pad + 96, 16);
}

// ── panel 2: force curves vs the band ──
{
    const w = 560;
    const h = 300;
    const pad = 36;
    const ctx = panel(
        "the force curve enters the band",
        `F per sample: draft (dotted — 6g at the loop bottom, band broken) vs solved (gold — inside [−1, 4]g everywhere, apex exactly −0.3). The independent f32 bake agrees to the node-vs-edge centering gap.`,
        w,
        h,
    );
    const fLo = -1.6;
    const fHi = 6.4;
    const px = (i: number) => pad + (i / (N - 1)) * (w - 1.4 * pad);
    const py = (f: number) => h - pad - ((f - fLo) / (fHi - fLo)) * (h - 1.5 * pad);

    // band region
    ctx.fillStyle = "rgba(90, 160, 208, 0.07)";
    ctx.fillRect(pad, py(HI), w - 1.4 * pad, py(LO) - py(HI));
    for (const [f, label] of [
        [HI, `${HI}g`],
        [LO, `${LO}g`],
        [0, "0"],
        [1, "1g"],
        [6, "6g"],
    ] as const) {
        ctx.strokeStyle = GRID;
        ctx.beginPath();
        ctx.moveTo(pad, py(f));
        ctx.lineTo(w - 0.4 * pad, py(f));
        ctx.stroke();
        ctx.fillStyle = TEXT;
        ctx.font = "10px 'JetBrains Mono', monospace";
        ctx.fillText(label, 8, py(f) + 3);
    }
    const idx = Float64Array.from({ length: N }, (_, i) => i);
    polyline(ctx, idx, draftF, px, py, FAINT, [3, 3]);
    polyline(ctx, idx, tearF, px, py, GOLD);
    ctx.fillStyle = BLUE;
    ctx.beginPath();
    ctx.arc(px(APEX), py(-0.3), 3.5, 0, 2 * Math.PI);
    ctx.fill();
}

// ── panel 3: the losing constraint ──
{
    const w = 560;
    const h = 300;
    const pad = 36;
    const ctx = panel(
        "an infeasible pin loses loudly",
        `Pin <code>F*=−5</code> fights band lo=−1: the hard AL band wins and the apex lands ON the floor (−1.0 exactly). The gap between the pin target (blue) and the achieved force (gold) is the pin's residual — the per-constraint "this one is losing, by 4g" readout the authoring UI surfaces. Finite everywhere, no NaN.`,
        w,
        h,
    );
    const fLo = -5.6;
    const fHi = 6.4;
    const px = (i: number) => pad + (i / (N - 1)) * (w - 1.4 * pad);
    const py = (f: number) => h - pad - ((f - fLo) / (fHi - fLo)) * (h - 1.5 * pad);

    ctx.fillStyle = "rgba(90, 160, 208, 0.07)";
    ctx.fillRect(pad, py(HI), w - 1.4 * pad, py(LO) - py(HI));
    for (const [f, label] of [
        [HI, `${HI}g`],
        [LO, `${LO}g`],
        [0, "0"],
        [-5, "−5g"],
    ] as const) {
        ctx.strokeStyle = GRID;
        ctx.beginPath();
        ctx.moveTo(pad, py(f));
        ctx.lineTo(w - 0.4 * pad, py(f));
        ctx.stroke();
        ctx.fillStyle = TEXT;
        ctx.font = "10px 'JetBrains Mono', monospace";
        ctx.fillText(label, 8, py(f) + 3);
    }
    const idx = Float64Array.from({ length: N }, (_, i) => i);
    polyline(ctx, idx, infF, px, py, GOLD);
    // the pin target and its residual gap
    ctx.fillStyle = BLUE;
    ctx.beginPath();
    ctx.arc(px(APEX), py(-5), 3.5, 0, 2 * Math.PI);
    ctx.fill();
    ctx.strokeStyle = RED;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(px(APEX), py(-5));
    ctx.lineTo(px(APEX), py(infF[APEX]));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = RED;
    ctx.font = "10px 'JetBrains Mono', monospace";
    ctx.fillText(`residual ${(infF[APEX] - -5).toFixed(1)}g`, px(APEX) + 8, py(-3));
}
