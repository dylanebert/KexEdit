// Conditioning probe (roadmap "kex2d Phase 2" / scratch "Optimizer design").
//
// Question: does single-shoot recovery-anchoring ill-condition on long tracks?
// The anchor linearizes endpoint geometry about the draft, and the lever arm
// ∂endpoint/∂F_n grows with track length. Probe how the largest singular value
// of the endpoint-position-from-F_n Jacobian grows with N:
//   ~linear      ⇒ single-shoot + anchor scales (multiple-shooting stays optional)
//   super-linear ⇒ names the length where multiple-shooting becomes structural.
//
// Method: central finite differences on the f64 forward integrator (forward.ts's
// math, clean precision), endpoint output (x,y) — the worst-case lever (earliest
// force → far end). Position Jacobian is 2×M, so σ_max is the exact larger
// eigenvalue of the 2×2 JJᵀ; no SVD dependency. Heading row-norm ‖∂θ_end/∂F‖ is
// the mechanism diagnostic. Cross-checked against the RK4 oracle.
//
// Run: bun tests/conditioning.lab.ts

import { forward64, type SampleState } from "./helpers/forward64";
import { rk4 } from "./oracles/rk4";

const DS = 0.5; // arclength step (m)
const LAMBDA = 20; // force-oscillation wavelength (m) — fixed per-length shape
const AMP = 0.3; // force amplitude (g) — gentle washboard, no net turning
const V0 = 25; // launch speed (m/s) — high enough that v stays far from the floor at any N
const EPS = 1e-5; // central-FD step in F (g)

const NS = [16, 32, 64, 128, 256, 512, 1024, 2048];

/** gentle washboard draft: small force oscillation about a near-flat track. v
 * stays well above the floor at any N (no net turning, no energy drift), so the
 * per-length dynamics are fixed and only the lever-arm length scales with N. */
function draftF(N: number): Float64Array {
    const F = new Float64Array(Math.max(N - 1, 1));
    for (let i = 0; i < F.length; i++) {
        F[i] = 1 + AMP * Math.sin((2 * Math.PI * (i * DS)) / LAMBDA);
    }
    return F;
}

const sampler = (F: Float64Array) => (sigma: number) =>
    F[Math.min(Math.round(sigma / DS), F.length - 1)];

function trajectory(F: Float64Array, N: number): SampleState[] {
    return forward64(0, 0, 0, V0, N, DS, sampler(F));
}

function endpoint(F: Float64Array, N: number): SampleState {
    return trajectory(F, N)[N - 1];
}

function minSpeed(traj: SampleState[]): number {
    let m = Infinity;
    for (const s of traj) m = Math.min(m, s[3]);
    return m;
}

interface Row {
    n: number;
    len: number;
    vMin: number;
    sigPosMax: number;
    sigPosMin: number;
    sigTheta: number;
}

function probe(N: number): Row {
    const F = draftF(N);
    const M = F.length;
    const baseTraj = trajectory(F, N);

    // JJᵀ for the (x,y) endpoint = [[a,b],[b,c]]; sum of squared ∂θ_end/∂F for heading.
    let a = 0;
    let b = 0;
    let c = 0;
    let sumTheta2 = 0;
    for (let i = 0; i < M; i++) {
        const fp = Float64Array.from(F);
        const fm = Float64Array.from(F);
        fp[i] += EPS;
        fm[i] -= EPS;
        const ep = endpoint(fp, N);
        const em = endpoint(fm, N);
        const jx = (ep[0] - em[0]) / (2 * EPS);
        const jy = (ep[1] - em[1]) / (2 * EPS);
        const jt = (ep[2] - em[2]) / (2 * EPS);
        a += jx * jx;
        c += jy * jy;
        b += jx * jy;
        sumTheta2 += jt * jt;
    }
    const tr = a + c;
    const det = a * c - b * b;
    const disc = Math.sqrt(Math.max((tr * tr) / 4 - det, 0));
    return {
        n: N,
        len: N * DS,
        vMin: minSpeed(baseTraj),
        sigPosMax: Math.sqrt(Math.max(tr / 2 + disc, 0)),
        sigPosMin: Math.sqrt(Math.max(tr / 2 - disc, 0)),
        sigTheta: Math.sqrt(sumTheta2),
    };
}

/** log-log least-squares slope of y vs x over the given rows (asymptotic exponent). */
function slope(xs: number[], ys: number[]): number {
    const n = xs.length;
    const lx = xs.map(Math.log);
    const ly = ys.map(Math.log);
    const mx = lx.reduce((s, v) => s + v, 0) / n;
    const my = ly.reduce((s, v) => s + v, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
        num += (lx[i] - mx) * (ly[i] - my);
        den += (lx[i] - mx) ** 2;
    }
    return num / den;
}

// --- RK4 cross-check: forward64 endpoint vs the independent oracle at a moderate N ---
{
    const N = 128;
    const F = draftF(N);
    const f = endpoint(F, N);
    const o = rk4(0, 0, 0, V0, N, DS, sampler(F))[N - 1];
    const dx = Math.hypot(f[0] - o[0], f[1] - o[1]);
    console.log(
        `RK4 cross-check (N=${N}): forward64 endpoint vs oracle Δpos=${dx.toExponential(2)} m, ` +
            `Δθ=${Math.abs(f[2] - o[2]).toExponential(2)} rad\n`,
    );
}

const rows = NS.map(probe);

console.log("   N      L(m)   v_min    σ_pos_max    σ_pos_min    σ_theta");
for (const r of rows) {
    console.log(
        `${String(r.n).padStart(5)} ${r.len.toFixed(0).padStart(7)} ${r.vMin.toFixed(2).padStart(7)} ` +
            `${r.sigPosMax.toExponential(3).padStart(12)} ${r.sigPosMin.toExponential(3).padStart(12)} ` +
            `${r.sigTheta.toExponential(3).padStart(12)}`,
    );
}

// asymptotic growth exponents over the upper half (large N)
const tail = rows.slice(Math.floor(rows.length / 2));
const ns = tail.map((r) => r.n);
console.log(
    `\nasymptotic log-log slope (N≥${tail[0].n}):` +
        `  σ_pos_max ~ N^${slope(
            ns,
            tail.map((r) => r.sigPosMax),
        ).toFixed(2)}` +
        `   σ_theta ~ N^${slope(
            ns,
            tail.map((r) => r.sigTheta),
        ).toFixed(2)}`,
);
console.log(
    `condition spread σ_pos_max/σ_pos_min at N=${rows.at(-1)!.n}: ` +
        `${(rows.at(-1)!.sigPosMax / rows.at(-1)!.sigPosMin).toExponential(2)}`,
);
