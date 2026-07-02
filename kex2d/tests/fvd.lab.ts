// Stage-3 FVD-limit de-risk (spec `kex/specs/kex2d-unified-solver.md`).
// Console-only, not a `bun test` gate. The claim under test: a full-curve
// F(σ) target with free interior positions IS the FVD workflow inside the one
// solver — the solve should land on the geometry that forward-integrating the
// profile produces (the oracle), from a sketch-quality draft.
//
//   0. config header
//   1. aggressiveness sweep — oracle tracking from a sketch-quality draft
//   2. prior ablation — the shape prior is degeneracy insurance, not a rival
//   3. discretization — the oracle gap is the O(ds) convention gap, not failure
//   4. basin — how bad can the draft be (warp amp sweep, straight-line starts)
//   5. warm-start cost per target edit — the RTI budget preview
//   6. gauge — chord weight vs spacing spread vs tracking
//
// Config notes: the full-curve target is an *interval* term, so the data
// weight is density-scaled at the call site (`wData = ds`); the kernel folds
// ds into band/shape/chord only. The STANDARD config keeps the Stage-2 shape
// prior (roughness w=0.1) — measured here (panel 2): without it the LM can
// walk into the Menger singularities (a fold, |m|→0, or a chord collapse,
// |e|→0), stall with μ→1e21, and exit `converged` on the step-size test with
// grad ~1e7 — so the prior's FVD-limit role is regularizing the geometry OFF
// the singular set, at ~1e-2 g force cost. force dominance comes from the
// data density, not from zeroing the prior. Endpoints are pinned AT the
// oracle endpoints (the kernel pins both ends; placing the far pin from the
// oracle is legitimate for the de-risk). No band.
//
// Run: bun tests/fvd.lab.ts

import { collocate, type CollocateResult, type Terms } from "../src/collocate";
import { forces64 } from "../src/force";
import { forward64 } from "./helpers/forward64";

const G = 9.80665;

interface Profile {
    name: string;
    fT: Float64Array;
    n: number;
    ds: number;
    v0: number;
}

/** gentle-to-aggressive undulating force: F(σ) = 1 + A·sin(2πσ/Λ). */
function hills(A: number, ds = 0.5, S = 60, lambda = 30, v0 = 30): Profile {
    const N = Math.round(S / ds) + 1;
    const fT = new Float64Array(N);
    for (let i = 0; i < N; i++) fT[i] = 1 + A * Math.sin((2 * Math.PI * i * ds) / lambda);
    return { name: `hills A=${A}`, fT, n: N, ds, v0 };
}

/** the Stage-2 0g-loop profile expressed as F(σ): 1g leads, the analytic
 *  circle profile (0g apex, 6g bottom) on the loop section. */
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
            const y = R * (1 - Math.cos(phi));
            fT[i] = (v0 * v0 - 2 * G * y) / (R * G) + Math.cos(phi);
        }
    }
    return { name: "0g loop", fT, n: N, ds, v0 };
}

/** the FVD oracle: forward-integrate the profile from the flat launch. */
function oracle(p: Profile): { x: Float64Array; y: Float64Array } {
    const st = forward64(0, 0, 0, p.v0, p.n, p.ds, (s) => p.fT[Math.round(s / p.ds)]);
    const x = new Float64Array(p.n);
    const y = new Float64Array(p.n);
    for (let i = 0; i < p.n; i++) {
        x[i] = st[i][0];
        y[i] = st[i][1];
    }
    return { x, y };
}

/** sketch-quality draft: the oracle warped along its local normal by
 *  amp·sin(2πσ/Λ). a hand sketch errs at LOW frequency (proportions off, not
 *  wiggles), so the standard Λ is ~0.4 of the track length. */
function warp(
    x: Float64Array,
    y: Float64Array,
    ds: number,
    amp: number,
    lambda: number,
): { x: Float64Array; y: Float64Array } {
    const N = x.length;
    const wx = Float64Array.from(x);
    const wy = Float64Array.from(y);
    for (let i = 1; i < N - 1; i++) {
        const tx = x[i + 1] - x[i - 1];
        const ty = y[i + 1] - y[i - 1];
        const len = Math.hypot(tx, ty) || 1;
        const w = amp * Math.sin((2 * Math.PI * i * ds) / lambda);
        wx[i] += (w * -ty) / len;
        wy[i] += (w * tx) / len;
    }
    return { x: wx, y: wy };
}

/** the standard sketch draft for a profile: low-frequency warp, amp 1.5 m. */
function sketch(p: Profile, o: { x: Float64Array; y: Float64Array }, amp = 1.5) {
    return warp(o.x, o.y, p.ds, amp, 0.4 * (p.n - 1) * p.ds);
}

/** straight-line draft between the pinned endpoints. */
function line(p: Profile, o: { x: Float64Array; y: Float64Array }) {
    const x = new Float64Array(p.n);
    const y = new Float64Array(p.n);
    for (let i = 0; i < p.n; i++) {
        const u = i / (p.n - 1);
        x[i] = o.x[0] + u * (o.x[p.n - 1] - o.x[0]);
        y[i] = o.y[0] + u * (o.y[p.n - 1] - o.y[0]);
    }
    return { x, y };
}

/** parametrization-invariant tracking metric: each solved interior node's
 *  distance to the oracle polyline (sliding along the curve is the gauge —
 *  force fixes shape, not where samples sit on it). */
function dev(
    sx: Float64Array,
    sy: Float64Array,
    ox: Float64Array,
    oy: Float64Array,
): { max: number; rms: number } {
    const N = sx.length;
    let max = 0;
    let sum = 0;
    for (let i = 1; i < N - 1; i++) {
        let best = Number.POSITIVE_INFINITY;
        for (let j = 0; j < N - 1; j++) {
            const ex = ox[j + 1] - ox[j];
            const ey = oy[j + 1] - oy[j];
            const ee = ex * ex + ey * ey;
            let t = ee > 0 ? ((sx[i] - ox[j]) * ex + (sy[i] - oy[j]) * ey) / ee : 0;
            t = Math.max(0, Math.min(1, t));
            const d = Math.hypot(sx[i] - (ox[j] + t * ex), sy[i] - (oy[j] + t * ey));
            if (d < best) best = d;
        }
        max = Math.max(max, best);
        sum += best * best;
    }
    return { max, rms: Math.sqrt(sum / (N - 2)) };
}

interface Solved {
    res: CollocateResult;
    ms: number;
}

/** standard FVD-limit terms: density-scaled data, Stage-2 prior + chord. */
function stdTerms(over: Partial<Terms> = {}): Terms {
    return { shape: { w: 0.1 }, chord: { w: 1 }, ...over };
}

function solveProfile(
    p: Profile,
    draft: { x: Float64Array; y: Float64Array },
    o: {
        terms?: Terms;
        xInit?: Float64Array;
        yInit?: Float64Array;
        maxIters?: number;
    } = {},
): Solved {
    const t0 = performance.now();
    const res = collocate({
        fTarget: p.fT,
        x0: draft.x,
        y0: draft.y,
        ds: p.ds,
        v0: p.v0,
        wData: p.ds,
        terms: o.terms ?? stdTerms(),
        xInit: o.xInit,
        yInit: o.yInit,
        maxIters: o.maxIters ?? 200,
    });
    return { res, ms: performance.now() - t0 };
}

function forceErr(p: Profile, res: CollocateResult): number {
    const { fN } = forces64(res.x, res.y, p.n, p.v0);
    let m = 0;
    for (let i = 1; i < p.n - 1; i++) m = Math.max(m, Math.abs(fN[i] - p.fT[i]));
    return m;
}

function chordStats(res: CollocateResult, ds: number): { spread: number; min: number } {
    let spread = 0;
    let min = Number.POSITIVE_INFINITY;
    for (let i = 0; i < res.x.length - 1; i++) {
        const c = Math.hypot(res.x[i + 1] - res.x[i], res.y[i + 1] - res.y[i]);
        spread = Math.max(spread, Math.abs(c - ds) / ds);
        min = Math.min(min, c);
    }
    return { spread, min };
}

// ── panel 0: header ──
{
    const lp = loopProfile();
    console.log("panel 0 — FVD-limit config");
    console.log("  full-curve F(σ) target, wData=ds · shape roughness w=0.1 · chord w=1 · no band");
    console.log(
        `  hills: S=60 ds=0.5 v0=30 (N=121) · loop: R=10 lead=15 ds=0.5 v0=${lp.v0.toFixed(1)} (N=${lp.n})`,
    );
    console.log("  oracle = forward64(F(σ)); draft = low-freq sketch warp amp=1.5 Λ=0.4S\n");
}

// ── panel 1: aggressiveness sweep ──
console.log("panel 1 — oracle tracking across aggressiveness (standard config)");
console.log("  profile        max dev (m)   rms dev (m)   force err (g)   iters    ms");
for (const p of [hills(0.25), hills(0.5), hills(1.0), hills(2.0), loopProfile()]) {
    const o = oracle(p);
    const { res, ms } = solveProfile(p, sketch(p, o));
    const d = dev(res.x, res.y, o.x, o.y);
    console.log(
        `  ${p.name.padEnd(12)}   ${d.max.toExponential(3)}    ${d.rms.toExponential(3)}` +
            `    ${forceErr(p, res).toExponential(3)}      ${`${res.iters}`.padStart(3)}   ${ms.toFixed(0).padStart(4)}`,
    );
}
console.log("");

// ── panel 2: prior ablation — degeneracy insurance ──
{
    console.log("panel 2 — shape-prior ablation (loop; drafts that stall without it)");
    console.log("  the failure without the prior is a Menger singularity: a fold (|m|→0,");
    console.log("  Λ=12 draft) or a chord collapse (|e|→0, amp=2 draft); LM stalls with");
    console.log("  μ→1e21 and exits on step size — 'converged' with grad ~1e7.");
    console.log("  draft              shape w   force err (g)   max dev (m)   chord min (m)");
    const p = loopProfile();
    const o = oracle(p);
    const drafts: [string, { x: Float64Array; y: Float64Array }][] = [
        ["fold (a=1 Λ=12)", warp(o.x, o.y, p.ds, 1.0, 12)],
        ["collapse (a=2)", sketch(p, o, 2.0)],
    ];
    for (const [name, draft] of drafts) {
        for (const sw of [0, 0.1]) {
            const terms: Terms = sw > 0 ? stdTerms() : { chord: { w: 1 } };
            const { res } = solveProfile(p, draft, { terms });
            const d = dev(res.x, res.y, o.x, o.y);
            const c = chordStats(res, p.ds);
            console.log(
                `  ${name.padEnd(16)}   ${sw.toFixed(1)}       ${forceErr(p, res).toExponential(3)}` +
                    `      ${d.max.toExponential(3)}     ${c.min.toExponential(2)}`,
            );
        }
    }
    console.log("");
}

// ── panel 3: the oracle gap is discretization (O(ds) convention gap) ──
{
    console.log("panel 3 — oracle gap vs ds (hills A=1, prior OFF to isolate the mechanism;");
    console.log("  expect ~halving: forward64 samples F at the source node, forces64 centrally)");
    console.log("    ds        max dev (m)     ratio");
    let prev = 0;
    for (const ds of [0.5, 0.25, 0.125]) {
        const p = hills(1.0, ds);
        const o = oracle(p);
        const { res } = solveProfile(p, sketch(p, o), { terms: { chord: { w: 1 } } });
        const d = dev(res.x, res.y, o.x, o.y);
        console.log(
            `  ${ds.toFixed(3)}     ${d.max.toExponential(3)}      ${prev ? (prev / d.max).toFixed(2) : "  —"}`,
        );
        prev = d.max;
    }
    console.log("");
}

// ── panel 4: basin — how bad can the draft be ──
{
    console.log("panel 4 — basin of attraction (standard config)");
    console.log("  loop, low-freq sketch warp at growing amplitude:");
    console.log("    amp       max dev (m)   force err (g)   chord min   iters  conv");
    const p = loopProfile();
    const o = oracle(p);
    for (const amp of [1, 2, 3, 4]) {
        const { res } = solveProfile(p, sketch(p, o, amp));
        const d = dev(res.x, res.y, o.x, o.y);
        const c = chordStats(res, p.ds);
        console.log(
            `    ${amp.toFixed(1)}       ${d.max.toExponential(3)}    ${forceErr(p, res).toExponential(3)}` +
                `      ${c.min.toExponential(2)}     ${`${res.iters}`.padStart(3)}   ${res.converged}`,
        );
    }
    console.log("  straight-line drafts (no shape knowledge at all):");
    for (const p2 of [hills(0.5), loopProfile()]) {
        const o2 = oracle(p2);
        const { res } = solveProfile(p2, line(p2, o2));
        const d = dev(res.x, res.y, o2.x, o2.y);
        console.log(
            `    ${p2.name.padEnd(12)} max dev=${d.max.toExponential(3)} force err=${forceErr(p2, res).toExponential(3)}` +
                ` iters=${res.iters} conv=${res.converged}`,
        );
    }
    console.log("");
}

// ── panel 5: warm-start cost per target edit (the RTI budget preview) ──
console.log("panel 5 — warm re-solve after a target edit (vs cold, standard config)");
console.log("  case                          cold it/ms      warm it/ms");

// hills: amplitude bump A=1.0 → 1.1 (a global target edit).
{
    const p0 = hills(1.0);
    const o0 = oracle(p0);
    const draft = sketch(p0, o0);
    const base = solveProfile(p0, draft);
    const p1 = hills(1.1);
    const cold = solveProfile(p1, draft);
    const warm = solveProfile(p1, draft, { xInit: base.res.x, yInit: base.res.y });
    console.log(
        `  hills A 1.0→1.1 (global)      ${`${cold.res.iters}`.padStart(3)}/${cold.ms.toFixed(0).padStart(4)}` +
            `      ${`${warm.res.iters}`.padStart(3)}/${warm.ms.toFixed(0).padStart(4)}`,
    );
}

// loop: a local dip of −0.3g over ±10 samples at the apex (an FVD-style
// "make the apex floatier" edit).
{
    const p0 = loopProfile();
    const o0 = oracle(p0);
    const draft = sketch(p0, o0);
    const base = solveProfile(p0, draft);
    const p1: Profile = { ...p0, fT: Float64Array.from(p0.fT) };
    const apex = Math.round((15 + Math.PI * 10) / p0.ds);
    for (let k = -10; k <= 10; k++) p1.fT[apex + k] -= 0.3 * Math.exp(-(k * k) / 32);
    const cold = solveProfile(p1, draft);
    const warm = solveProfile(p1, draft, { xInit: base.res.x, yInit: base.res.y });
    console.log(
        `  loop apex dip −0.3g (local)   ${`${cold.res.iters}`.padStart(3)}/${cold.ms.toFixed(0).padStart(4)}` +
            `      ${`${warm.res.iters}`.padStart(3)}/${warm.ms.toFixed(0).padStart(4)}`,
    );
}
console.log("");

// ── panel 6: gauge — chord weight vs spacing vs tracking ──
{
    console.log("panel 6 — gauge behavior (loop, standard sketch draft)");
    console.log("  chord w    spread max     max dev (m)    force err (g)");
    const p = loopProfile();
    const o = oracle(p);
    const draft = sketch(p, o);
    for (const w of [0, 0.1, 1]) {
        const { res } = solveProfile(p, draft, { terms: stdTerms({ chord: { w } }) });
        const d = dev(res.x, res.y, o.x, o.y);
        console.log(
            `  ${w.toFixed(1).padStart(5)}      ${chordStats(res, p.ds).spread.toExponential(3)}` +
                `     ${d.max.toExponential(3)}     ${forceErr(p, res).toExponential(3)}`,
        );
    }
    console.log("");
}
