// Stage-3 collocation solver observability (spec `kex/specs/kex2d-collocation.md`).
// Console-only, not a `bun test` gate — the numbers the solver tests assert
// against, laid out to read. Mirrors `geometry.lab.ts`.
//
//   0. cross-check header — solved-vs-circle shape Δ, solved-vs-F* force Δ, forward vs rk4
//   1. convergence history — ‖r‖, ‖g‖, μ, step per iteration
//   2. O(ds²) — shape recovery + forward-oracle drift halving with ds
//   3. rank-deficiency — the data-only JᵀJ is singular; μI (LM) makes it SPD;
//      achievable-target residual → 0 (the optimizer reaches the true min)
//
// The recovery metric is the parametrization-invariant *shape* distance (a node's
// distance to the analytic circle), because force is the flat output up to
// reparametrization — it determines shape, not where nodes sit along it.
//
// Run: bun tests/collocate.lab.ts

import { bandFactor, bandStore } from "../src/banded";
import { collocate, normalBand } from "../src/collocate";
import { forces64 } from "../src/force";
import { forward64 } from "./helpers/forward64";
import { rk4 } from "./oracles/rk4";

const G = 9.80665;
const R = 12; // arc centered at (0, R), radius R
const V0 = 30;

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

/** perturb interior nodes in the local arc normal by amp·sin(2π s/Λ). */
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

/** max distance of any interior node to the analytic circle (shape metric). */
function shapeDev(x: Float64Array, y: Float64Array) {
    let m = 0;
    for (let i = 1; i < x.length - 1; i++)
        m = Math.max(m, Math.abs(Math.hypot(x[i], y[i] - R) - R));
    return m;
}

/** forward the solved force through an oracle; endpoint drift from the solve. */
function oracleDrift(res: { x: Float64Array; y: Float64Array }, N: number, ds: number) {
    const f = forces64(res.x, res.y, N, V0).fN;
    const fn = (s: number) => f[Math.round(s / ds)];
    const fwd = forward64(res.x[0], res.y[0], 0, V0, N, ds, fn);
    const ork = rk4(res.x[0], res.y[0], 0, V0, N, ds, fn);
    return {
        euler: Math.hypot(fwd[N - 1][0] - res.x[N - 1], fwd[N - 1][1] - res.y[N - 1]),
        oracle: Math.hypot(fwd[N - 1][0] - ork[N - 1][0], fwd[N - 1][1] - ork[N - 1][1]),
    };
}

// ── panel 0 + 1: primary solve on the continuum circle target ──
{
    const ds = 0.25;
    const N = Math.floor(15 / ds) + 1;
    const { x: ax, y: ay, fStar } = arc(N, ds);
    const { px, py } = perturb(ax, ay, ds, 0.1, 6);
    const res = collocate({ fTarget: fStar, x0: px, y0: py, ds, v0: V0 });

    const dev = shapeDev(res.x, res.y);
    const { fN } = forces64(res.x, res.y, N, V0);
    let fErr = 0;
    for (let i = 1; i < N - 1; i++) fErr = Math.max(fErr, Math.abs(fN[i] - fStar[i]));
    const drift = oracleDrift(res, N, ds);

    console.log("panel 0 — cross-check (continuum circle target, ds=0.25)");
    console.log(
        `  shape Δ=${dev.toExponential(3)} m   force Δ=${fErr.toExponential(3)} g` +
            `   forward64-vs-rk4=${drift.oracle.toExponential(3)} m`,
    );
    console.log(
        `  converged=${res.converged} iters=${res.iters} residual=${res.residual.toExponential(3)}` +
            ` grad=${res.grad.toExponential(3)} minPivot=${res.minPivot.toExponential(3)}\n`,
    );

    console.log("panel 1 — convergence history");
    console.log("   it        ‖r‖            ‖g‖            μ            step");
    res.history.forEach((h, k) => {
        console.log(
            `  ${`${k}`.padStart(3)}   ${h.residual.toExponential(3)}    ${h.grad.toExponential(3)}` +
                `    ${h.mu.toExponential(2)}    ${h.step.toExponential(3)}`,
        );
    });
    console.log("");
}

// ── panel 2: O(ds²) shape recovery + oracle drift ──
{
    console.log("panel 2 — shape recovery + forward-oracle drift vs ds (expect ~4×/halving)");
    console.log("    ds        shape Δ (m)      ratio     oracle drift (m)   ratio");
    let ps = 0;
    let pd = 0;
    for (const ds of [0.5, 0.25, 0.125]) {
        const N = Math.floor(15 / ds) + 1;
        const { x: ax, y: ay, fStar } = arc(N, ds);
        const { px, py } = perturb(ax, ay, ds, 0.1, 6);
        const res = collocate({ fTarget: fStar, x0: px, y0: py, ds, v0: V0 });
        const dev = shapeDev(res.x, res.y);
        const drift = oracleDrift(res, N, ds).euler;
        console.log(
            `  ${ds.toFixed(3)}     ${dev.toExponential(3)}       ${ps ? (ps / dev).toFixed(2) : "  —"}` +
                `      ${drift.toExponential(3)}        ${pd ? (pd / drift).toFixed(2) : "  —"}`,
        );
        ps = dev;
        pd = drift;
    }
    console.log("");
}

// ── panel 3: rank-deficiency + achievable target ──
{
    const ds = 0.25;
    const N = Math.floor(15 / ds) + 1;
    const { x: ax, y: ay } = arc(N, ds);
    const { px, py } = perturb(ax, ay, ds, 0.1, 6);

    // factor the data-only JᵀJ (no μ): the tangential null space => singular.
    const sys = normalBand(px, py, N, ds, V0, new Float64Array(N), 1);
    const L = bandStore(sys.n, 5);
    const d = new Float64Array(sys.n);
    bandFactor(sys.band, sys.n, 5, L, d);
    let bad = 0;
    let minPiv = Number.POSITIVE_INFINITY;
    for (let k = 0; k < sys.n; k++) {
        if (!(d[k] > 0)) bad++;
        else minPiv = Math.min(minPiv, d[k]);
    }

    // achievable target: forces64 of the exact arc — residual should reach ~0.
    const fAch = forces64(ax, ay, N, V0).fN;
    const res = collocate({ fTarget: fAch, x0: px, y0: py, ds, v0: V0 });

    console.log("panel 3 — rank-deficiency (data-only JᵀJ) + achievable target");
    console.log(
        `  data-only factor: ${bad}/${sys.n} non-positive pivots (singular; LM's μI fixes it)`,
    );
    console.log(
        `  achievable target: residual=${res.residual.toExponential(3)} grad=${res.grad.toExponential(3)}` +
            ` converged=${res.converged} minPivot=${res.minPivot.toExponential(3)}\n`,
    );
}
