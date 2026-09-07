// Geometry→force atom observability (spec `kex/specs/kex2d-collocation.md`,
// Stage 2). Console-only, not a `bun test` gate — the numbers the atom tests
// assert against, laid out to read. Three panels:
//
//   1. round-trip error vs ds — the O(ds²)-vs-continuum / O(ds)-vs-integrator split
//   2. the banded ∂F/∂P sparsity map — locality, made visible
//   3. the conditioning thesis — σ(∂F/∂P) flat vs σ(∂P/∂F) ~ N^1.56, side by side
//
// This is "geometry as the control", measured: force→geometry is the ill-posed
// inverse (super-linear), geometry→force differentiates (banded, flat).
//
// Run: bun tests/geometry.lab.ts

import { type ForceJac, forceJacobian, forces64 } from "../src/force";
import { forward64, type SampleState } from "./helpers/forward64";
import { rk4 } from "./oracles/rk4";

const G = 9.80665;

function rollout(F: Float64Array, N: number, ds: number, v0: number): SampleState[] {
    return forward64(0, 0, 0, v0, N, ds, (s) => F[Math.min(N - 1, Math.round(s / ds))]);
}
function positions(traj: SampleState[]): { x: Float64Array; y: Float64Array } {
    return {
        x: Float64Array.from(traj, (p) => p[0]),
        y: Float64Array.from(traj, (p) => p[1]),
    };
}
function washboard(N: number, ds: number): Float64Array {
    const F = new Float64Array(N);
    for (let i = 0; i < N; i++) F[i] = 1 + 0.3 * Math.sin((2 * Math.PI * (i * ds)) / 20);
    return F;
}

/** log-log least-squares slope (asymptotic exponent). */
function slope(xs: number[], ys: number[]): number {
    const lx = xs.map(Math.log);
    const ly = ys.map(Math.log);
    const mx = lx.reduce((s, v) => s + v, 0) / lx.length;
    const my = ly.reduce((s, v) => s + v, 0) / ly.length;
    let num = 0;
    let den = 0;
    for (let i = 0; i < xs.length; i++) {
        num += (lx[i] - mx) * (ly[i] - my);
        den += (lx[i] - mx) ** 2;
    }
    return num / den;
}

// ── panel 0: RK4 cross-check (forces64 on the analytic circle vs the oracle) ──
{
    const R = 12;
    const ds = 0.25;
    const v0 = 30;
    const N = Math.floor(15 / ds) + 1;
    const x = new Float64Array(N);
    const y = new Float64Array(N);
    for (let i = 0; i < N; i++) {
        x[i] = R * Math.sin((i * ds) / R);
        y[i] = R * (1 - Math.cos((i * ds) / R));
    }
    const { fN } = forces64(x, y, N, v0);
    let m = 0;
    for (let i = 1; i < N - 1; i++) {
        const v2 = v0 * v0 - 2 * G * y[i];
        m = Math.max(m, Math.abs(fN[i] - (v2 / R / G + Math.cos((i * ds) / R))));
    }
    // and the forward integrator vs the independent RK4 oracle on a washboard.
    const Fw = washboard(N, ds);
    const f = rollout(Fw, N, ds, v0)[N - 1];
    const o = rk4(0, 0, 0, v0, N, ds, (s) => Fw[Math.min(N - 1, Math.round(s / ds))])[N - 1];
    console.log(
        `cross-check: forces64 vs analytic circle F (ds=${ds}) max Δ=${m.toExponential(2)} g` +
            `   forward64 vs RK4 endpoint Δpos=${Math.hypot(f[0] - o[0], f[1] - o[1]).toExponential(2)} m\n`,
    );
}

// ── panel 1: round-trip error vs ds ──
console.log("round-trip error vs ds  (geometry→force, feasible curves)");
console.log("    ds     vs continuum (O ds²)    ratio     vs integrator (O ds)   ratio");
{
    const R = 12;
    const arcCont = 15;
    const arcInt = 40;
    const v0c = 30;
    const v0i = 25;
    let prevC = 0;
    let prevI = 0;
    for (const ds of [0.5, 0.25, 0.125, 0.0625]) {
        // continuum: analytic circle
        const Nc = Math.floor(arcCont / ds) + 1;
        const x = new Float64Array(Nc);
        const y = new Float64Array(Nc);
        for (let i = 0; i < Nc; i++) {
            x[i] = R * Math.sin((i * ds) / R);
            y[i] = R * (1 - Math.cos((i * ds) / R));
        }
        const fc = forces64(x, y, Nc, v0c).fN;
        let ec = 0;
        for (let i = 1; i < Nc - 1; i++) {
            const v2 = v0c * v0c - 2 * G * y[i];
            ec = Math.max(ec, Math.abs(fc[i] - (v2 / R / G + Math.cos((i * ds) / R))));
        }
        // integrator: washboard forward → forces64, vs the source force
        const Ni = Math.floor(arcInt / ds) + 1;
        const F = washboard(Ni, ds);
        const p = positions(rollout(F, Ni, ds, v0i));
        const fi = forces64(p.x, p.y, Ni, v0i).fN;
        let ei = 0;
        for (let i = 2; i < Ni - 2; i++) ei = Math.max(ei, Math.abs(fi[i] - F[i]));

        const rc = prevC ? (prevC / ec).toFixed(2) : "  — ";
        const ri = prevI ? (prevI / ei).toFixed(2) : "  — ";
        console.log(
            `  ${ds.toFixed(4)}     ${ec.toExponential(3)}          ${rc}      ` +
                `${ei.toExponential(3)}         ${ri}`,
        );
        prevC = ec;
        prevI = ei;
    }
    console.log("  (continuum ~4×/halving = 2nd order; integrator ~2×/halving = 1st order)\n");
}

// ── panel 2: the banded ∂F/∂P sparsity map ──
{
    const N = 10;
    const ds = 0.5;
    const v0 = 25;
    const p = positions(rollout(washboard(N, ds), N, ds, v0));
    const J = forceJacobian(p.x, p.y, N, v0);
    const cols = 2 * N;
    const colOf = (r: number, t: number): number => {
        const i = r + 1;
        return 2 * [i - 1, i - 1, i, i, i + 1, i + 1][t] + (t % 2);
    };
    // largest magnitude for the bucket scale.
    let mx = 0;
    for (const v of J.entries) mx = Math.max(mx, Math.abs(v));
    console.log(`∂F/∂P sparsity — ${N - 2} rows × ${cols} cols (interleaved x₀y₀x₁y₁…), N=${N}`);
    console.log(`    cols: ${Array.from({ length: N }, (_, i) => `${i}`.padStart(2)).join(" ")}`);
    console.log("          " + "x y ".repeat(N).trimEnd());
    for (let r = 0; r < N - 2; r++) {
        const dense = new Float64Array(cols);
        for (let t = 0; t < 6; t++) dense[colOf(r, t)] = J.entries[r * 6 + t];
        const cells = Array.from(dense, (v) => {
            const a = Math.abs(v) / mx;
            return a === 0 ? "·" : a > 0.3 ? "#" : a > 0.03 ? "+" : ":";
        }).join(" ");
        console.log(`  F${`${r + 1}`.padStart(2)}   ${cells}`);
    }
    console.log(
        "  each row: 6 nonzeros in a 3-node window ⇒ half-bandwidth 1/coord (JᵀJ band 5)\n",
    );
}

// ── panel 3: the conditioning thesis ──
{
    const ds = 0.5;
    const v0 = 25;
    const EPS = 1e-5;
    const Ns = [32, 64, 128, 256, 512, 1024];

    // σ_max(∂F/∂P): power iteration on JᵀJ (matrix-free over the banded rows).
    function sigmaFP(J: ForceJac): number {
        const cols = 2 * J.n;
        const M = J.n - 2;
        const colOf = (r: number, t: number): number => {
            const i = r + 1;
            return 2 * [i - 1, i - 1, i, i, i + 1, i + 1][t] + (t % 2);
        };
        let v = new Float64Array(cols);
        for (let k = 0; k < cols; k++) v[k] = Math.sin(1.7 * k + 0.3);
        let sig = 0;
        for (let it = 0; it < 60; it++) {
            const w = new Float64Array(M);
            for (let r = 0; r < M; r++)
                for (let t = 0; t < 6; t++) w[r] += J.entries[r * 6 + t] * v[colOf(r, t)];
            const u = new Float64Array(cols);
            for (let r = 0; r < M; r++)
                for (let t = 0; t < 6; t++) u[colOf(r, t)] += J.entries[r * 6 + t] * w[r];
            let nrm = 0;
            for (const uk of u) nrm += uk * uk;
            nrm = Math.sqrt(nrm);
            sig = Math.sqrt(nrm);
            v = new Float64Array(cols);
            for (let k = 0; k < cols; k++) v[k] = u[k] / nrm;
        }
        return sig;
    }

    // σ_max(∂P/∂F): endpoint-position Jacobian via central FD (conditioning.lab).
    function sigmaPF(N: number): number {
        const F = washboard(N, ds);
        let a = 0;
        let b = 0;
        let c = 0;
        for (let i = 0; i < N - 1; i++) {
            const fp = Float64Array.from(F);
            const fm = Float64Array.from(F);
            fp[i] += EPS;
            fm[i] -= EPS;
            const ep = rollout(fp, N, ds, v0)[N - 1];
            const em = rollout(fm, N, ds, v0)[N - 1];
            const jx = (ep[0] - em[0]) / (2 * EPS);
            const jy = (ep[1] - em[1]) / (2 * EPS);
            a += jx * jx;
            c += jy * jy;
            b += jx * jy;
        }
        const disc = Math.sqrt(Math.max((a + c) ** 2 / 4 - (a * c - b * b), 0));
        return Math.sqrt((a + c) / 2 + disc);
    }

    console.log("conditioning:  σ_max(∂F/∂P) geometry→force   vs   σ_max(∂P/∂F) force→geometry");
    console.log("     N       σ(∂F/∂P)        σ(∂P/∂F)");
    const fp: number[] = [];
    const pf: number[] = [];
    for (const N of Ns) {
        const p = positions(rollout(washboard(N, ds), N, ds, v0));
        const sFP = sigmaFP(forceJacobian(p.x, p.y, N, v0));
        const sPF = sigmaPF(N);
        fp.push(sFP);
        pf.push(sPF);
        console.log(
            `  ${`${N}`.padStart(5)}    ${sFP.toExponential(3).padStart(12)}    ${sPF
                .toExponential(3)
                .padStart(12)}`,
        );
    }
    console.log(
        `\n  slopes:  σ(∂F/∂P) ~ N^${slope(Ns, fp).toFixed(2)} (flat/banded — the control)` +
            `   σ(∂P/∂F) ~ N^${slope(Ns, pf).toFixed(2)} (ill-posed inverse)`,
    );
}
