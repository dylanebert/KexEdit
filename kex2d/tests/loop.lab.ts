// Stage-2 lab — the 0g loop: force band + shape prior (spec
// `kex/specs/kex2d-unified-solver.md`). Console-only, not a `bun test` gate —
// the evidence the Stage-2 decisions cite, laid out to read.
//
//   0. draft sanity — the circle's classic profile (1g leads, 6g bottom, 0g apex)
//   1. architecture — plain hinge penalty vs PHR augmented Lagrangian (DECIDED: AL,
//      cheap inners + frequent λ updates; penalty stalls at the hinge kink at ANY weight)
//   2. roughness vs magnitude shape prior under AL — FINDING: the kinds do NOT
//      differentiate here. banding F bounds curvature, which is itself a
//      smoothness constraint, so the AL-hard force terms dominate any prior at
//      these scales and the prior only tie-breaks inside the force-feasible
//      manifold. roughness stays the default (2nd order: preserves the draft's
//      bending profile; magnitude at high weight is an authoring foot-gun that
//      forces infeasibility), but the prior-kind choice is NOT load-bearing.
//   3. the apex pin exercised (F*=−0.3 has the analytic prediction κa×0.7) +
//      the infeasible request (pin −5 vs band lo −1: loud compromise, no NaN)
//   4. ds robustness — the prior attempt's ds=0.5 stall, re-tested clean
//   5. roughness order 2 vs 3
//
// The scenario: draft circle R=10 at v0=√(5gR) (F: 0g apex, 6g bottom), comfort
// band [−1, 4]g (violated across the whole bottom half). `forces64` is
// parametrization-invariant (Menger κ + neighbor-chord tangent) — an earlier
// fixed-ds version of this lab caught the solver "satisfying" the band by
// stretching grid spacing 60–97% instead of reshaping (the bake cross-check
// showed ~10g of real violation); invariance closed that by construction, and
// the chord term (w=1) is only grid-quality. chordΔ ≈ 8% in the results below
// is REAL arclength growth of the reshaped loop absorbed by the fixed-N grid —
// harmless to force truth, resampled away at the wire stage.
//
// Run: bun tests/loop.lab.ts

import { forces } from "../src/bake";
import {
    collocate,
    collocateAL,
    type CollocateOpts,
    type CollocateResult,
    type ShapeTerm,
    type Terms,
} from "../src/collocate";
import { forces64 } from "../src/force";
import { type LoopTrack, loopTrack } from "./helpers/loop";

const LO = -1;
const HI = 4;
const W_PIN = 100;

const AL_SCHED = { tol: 1e-3, outers: 40 } as const;
const AL_INNER = 15;
const AL_RHO = 50;

function terms(
    t: LoopTrack,
    wBand: number,
    wShape: number,
    shape?: Partial<ShapeTerm>,
    pin: { at: number; f: number } | null = { at: -1, f: 0 },
): Terms {
    const wF = new Float64Array(t.n);
    if (pin) wF[pin.at < 0 ? t.apex : pin.at] = W_PIN;
    return {
        wF,
        band: { lo: LO, hi: HI, w: wBand },
        shape: { w: wShape, ...(shape ?? {}) },
        chord: { w: 1 },
    };
}

function opts(t: LoopTrack, tm: Terms, maxIters: number, fPin = 0): CollocateOpts {
    const fTarget = new Float64Array(t.n);
    fTarget[t.apex] = fPin;
    return { fTarget, x0: t.x, y0: t.y, ds: t.ds, v0: t.v0, wData: 0, terms: tm, maxIters };
}

interface Metrics {
    fApex: number;
    maxViol: number;
    bakeViol: number;
    h: number;
    kApexRatio: number;
    kBottomRatio: number;
    maxD: number;
    kink: number;
    chordSpread: number;
    minV2: number;
    nan: boolean;
}

/** solved-geometry metrics; `bakeViol` re-checks the band through the shipping
 *  f32 bake path (exact per-edge chords, bisector tangents) — an independent
 *  code path, so band satisfaction is a property of the geometry, not of the
 *  solver's own fixed-ds discretization. */
function measure(t: LoopTrack, r: CollocateResult): Metrics {
    const out = forces64(r.x, r.y, t.n, t.v0);
    const draft = forces64(t.x, t.y, t.n, t.v0);
    let maxViol = 0;
    let h = 0;
    let maxD = 0;
    let kink = 0;
    let chordSpread = 0;
    let minV2 = Number.POSITIVE_INFINITY;
    let nan = false;
    for (let i = 1; i < t.n - 1; i++) {
        maxViol = Math.max(maxViol, out.fN[i] - HI, LO - out.fN[i]);
        h = Math.max(h, r.y[i]);
        maxD = Math.max(maxD, Math.hypot(r.x[i] - t.x[i], r.y[i] - t.y[i]));
        minV2 = Math.min(minV2, out.v2[i]);
        const kx =
            (r.x[i - 1] - t.x[i - 1] - 2 * (r.x[i] - t.x[i]) + r.x[i + 1] - t.x[i + 1]) /
            (t.ds * t.ds);
        const ky =
            (r.y[i - 1] - t.y[i - 1] - 2 * (r.y[i] - t.y[i]) + r.y[i + 1] - t.y[i + 1]) /
            (t.ds * t.ds);
        kink = Math.max(kink, Math.hypot(kx, ky));
    }
    for (let i = 0; i < t.n; i++)
        if (!Number.isFinite(r.x[i]) || !Number.isFinite(r.y[i])) nan = true;
    for (let i = 0; i < t.n - 1; i++) {
        const chord = Math.hypot(r.x[i + 1] - r.x[i], r.y[i + 1] - r.y[i]);
        chordSpread = Math.max(chordSpread, Math.abs(chord - t.ds) / t.ds);
    }

    // independent re-check through the f32 bake (per-edge exact chords).
    const px = Float32Array.from(r.x);
    const py = Float32Array.from(r.y);
    const th = new Float32Array(t.n);
    const v = new Float32Array(t.n);
    const fN = new Float32Array(t.n);
    const dsArr = new Float32Array(t.n - 1);
    for (let i = 0; i < t.n - 1; i++) dsArr[i] = Math.hypot(px[i + 1] - px[i], py[i + 1] - py[i]);
    forces(px, py, th, v, fN, dsArr, 0, t.n - 1, t.v0);
    let bakeViol = 0;
    for (let i = 1; i < t.n - 1; i++) bakeViol = Math.max(bakeViol, fN[i] - HI, LO - fN[i]);

    return {
        fApex: out.fN[t.apex],
        maxViol: Math.max(0, maxViol),
        bakeViol: Math.max(0, bakeViol),
        h,
        kApexRatio: out.kappa[t.apex] / draft.kappa[t.apex],
        kBottomRatio: out.kappa[t.bottom + 2] / draft.kappa[t.bottom + 2],
        maxD,
        kink,
        chordSpread,
        minV2,
        nan,
    };
}

const row = (label: string, r: CollocateResult, m: Metrics, ms: number, extra = ""): void =>
    console.log(
        `  ${label.padEnd(16)} ${(r.converged ? "conv" : "STOP").padEnd(5)}` +
            `F_apex=${m.fApex.toFixed(4).padStart(8)} viol=${m.maxViol.toFixed(4).padStart(7)} ` +
            `bake=${m.bakeViol.toFixed(3).padStart(6)} κa×${m.kApexRatio.toFixed(2)} κb×${m.kBottomRatio.toFixed(2)} ` +
            `|d|=${m.maxD.toFixed(2).padStart(5)} kink=${m.kink.toFixed(2).padStart(5)} ` +
            `chordΔ=${(m.chordSpread * 100).toFixed(1).padStart(5)}% ${ms.toFixed(0).padStart(4)}ms${extra}`,
    );

const al = (t: LoopTrack, tm: Terms, fPin = 0) => {
    const t0 = performance.now();
    const r = collocateAL(opts(t, tm, AL_INNER, fPin), AL_SCHED);
    return { r, ms: performance.now() - t0 };
};

// ── 0. draft sanity ─────────────────────────────────────────────────────────
{
    const t = loopTrack(10, 0.5, 15);
    const f = forces64(t.x, t.y, t.n, t.v0);
    console.log("panel 0 — draft profile (R=10, ds=0.5, v0=√(5gR))");
    console.log(
        `  N=${t.n} apex=${t.apex} F_lead=${f.fN[4].toFixed(3)} ` +
            `F_bottom=${f.fN[t.bottom + 2].toFixed(3)} F_apex=${f.fN[t.apex].toFixed(4)} ` +
            `v²_apex=${f.v2[t.apex].toFixed(1)} (expect ≈1, ≈6, ≈0, >0)`,
    );
    console.log("");
}

// ── 1. architecture: penalty vs AL ──────────────────────────────────────────
{
    const t = loopTrack(10, 0.5, 15);
    console.log("panel 1 — plain hinge penalty (w sweep, 300 iters) vs PHR-AL");
    for (const wB of [100, 1000, 10000]) {
        const t0 = performance.now();
        const r = collocate(opts(t, terms(t, wB, 0.1), 300));
        row(
            `penalty ${wB}`,
            r,
            measure(t, r),
            performance.now() - t0,
            ` minPiv=${r.minPivot.toExponential(1)}`,
        );
    }
    for (const [inner, rho] of [
        [300, 10],
        [AL_INNER, AL_RHO],
    ] as const) {
        const t0 = performance.now();
        const r = collocateAL(opts(t, terms(t, rho, 0.1), inner), AL_SCHED);
        row(
            `AL ${inner}/ρ${rho}`,
            r,
            measure(t, r),
            performance.now() - t0,
            ` outers=${r.outers} ρf=${r.rho}`,
        );
    }
    console.log(
        "  → penalty: stalls at ~1.5e-2 violation at ANY weight (the hinge-kink stall, now in",
    );
    console.log(
        "    its honest form) + stiffens JᵀJ. AL: exact at finite ρ; cheap inners + frequent λ",
    );
    console.log("    updates are the efficient schedule. DECIDED: AL.");
    console.log("");
}

// ── 2. roughness vs magnitude under AL ──────────────────────────────────────
{
    const t = loopTrack(10, 0.5, 15);
    console.log("panel 2 — shape prior kind under AL (wS sweep). FINDING: no differentiation —");
    console.log(
        "  the AL-hard band dominates either prior; both reach viol≈0 with the same smooth",
    );
    console.log("  warp. (also checked at a 5× warp, band hi=3: still identical. hi=2 is length-");
    console.log(
        "  infeasible for BOTH — the fixed N·ds grid caps arclength; a wire-stage concern.)",
    );
    for (const kind of ["roughness", "magnitude"] as const) {
        for (const wS of [0.1, 1, 10, 100]) {
            const { r, ms } = al(t, terms(t, AL_RHO, wS, { kind }));
            row(`${kind} ${wS}`, r, measure(t, r), ms, ` outers=${r.outers}`);
        }
    }
    console.log("");
}

// ── 3. the pin, exercised + the infeasible request ──────────────────────────
{
    const t = loopTrack(10, 0.5, 15);
    console.log("panel 3 — apex pin F*=−0.3: prediction κa×0.70 exactly (κ_a v_a²/g = 1+F*)");
    {
        const { r, ms } = al(t, terms(t, AL_RHO, 0.1), -0.3);
        row("pin −0.3", r, measure(t, r), ms, ` outers=${r.outers}`);
    }
    console.log(
        "  infeasible: pin F*=−5 fights band lo=−1 — expect loud compromise, finite, no NaN",
    );
    {
        const { r, ms } = al(t, terms(t, AL_RHO, 0.1), -5);
        const m = measure(t, r);
        row("pin −5 (!)", r, m, ms, ` outers=${r.outers} nan=${m.nan}`);
    }
    console.log("");
}

// ── 4. ds robustness ────────────────────────────────────────────────────────
console.log("panel 4 — ds sweep (the prior ds=0.5 stall, re-tested clean; AL 15/ρ50, wS=0.1)");
for (const ds of [1.0, 0.7, 0.5, 0.35]) {
    const t = loopTrack(10, ds, 15);
    const { r, ms } = al(t, terms(t, AL_RHO, 0.1));
    row(`ds=${ds}`, r, measure(t, r), ms, ` outers=${r.outers} N=${t.n}`);
}
console.log("");

// ── 5. roughness order 2 vs 3 ───────────────────────────────────────────────
{
    const t = loopTrack(10, 0.5, 15);
    console.log("panel 5 — roughness derivative order (AL 15/ρ50, wS=0.1)");
    for (const order of [2, 3] as const) {
        const { r, ms } = al(t, terms(t, AL_RHO, 0.1, { order }));
        row(`order ${order}`, r, measure(t, r), ms, ` outers=${r.outers}`);
    }
}
