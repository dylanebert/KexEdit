// Pin-mode solver conditioning + norm lab (`kex2d-optimize-mode` stage 3).
//
// Five questions, each sized to a stage-3 decision:
//   1. COST — re-baseline the solve's wall time post-JAC_H fix (it was ~5× cheaper in the
//      debug trace; measure, don't quote) → sizes the continuation wrapper's stage budget.
//   2. FLOOR — the f32 replay-noise floor of the exit map g→exit, measured as the RMS scatter
//      of the exit around an affine fit under sub-quantum g dithers, expressed in ulps of the
//      exit magnitude and against √N accumulation → derives TOL (relative, never absolute).
//   3. ATTAINABLE — the smallest tolerance (in ulp-of-scale units) the SQP loop reliably
//      converges under across the corpus perturbation sweep → checks the derived TOL is
//      actually reachable (the stage-2 stall was a floor set below reach).
//   4. CONDITIONING — scaled-Jacobian σmin/σmax on healthy corpus cases vs the pre-named
//      suspects (near-straight, clustered free keys, clamp crest, post-stall chaotic regime)
//      → checks the derived 2^-16 threshold (the FD Jacobian's own relative accuracy,
//      ε_f32^(2/3)) separates the two populations.
//   5. DISTRIBUTION + FOLD — uniform (M = I) vs Gram Δg distribution on one corpus case
//      (where do corrections land?), and a drift-magnitude ramp to find the fold where the
//      direct solve stops converging → sizes what continuation must cover.
//
// Labs inform; suites pin — every finding promoted to a law lands a committed test
// (`tests/optimize.test.ts` sentinel + corpus scale in `optimize.oracle.ts`).
//
// Run: bun tests/optimize.lab.ts

import { injectionTol, type OptimizeOpts, solveOptimize } from "../src/optimize";
import { forceProfile, type ForcePoint, resolveStep } from "../src/profile";
import { type Entry, evalForce } from "../src/section";

const ENTRY: Entry = { x: 0, y: 0, theta: 0, v: 20 };
const DS = 0.5;
const F32_EPS = 2 ** -24;
const JAC_H = 2 ** -8; // mirror of optimize.ts's derived FD step

interface Scenario {
    name: string;
    points: ForcePoint[];
    length: number;
    entry?: Entry;
}

/** the optimize test corpus (mirrors tests/optimize.test.ts) plus scaled-up variants — the
 *  relative-floor question is exactly about how the reachable tolerance grows with exit
 *  magnitude and step count, so the lab needs sections an order of magnitude longer. */
function corpus(): Scenario[] {
    const hill = (scale: number): ForcePoint[] => [
        { s: 0 * scale, g: 1 },
        { s: 10 * scale, g: 1.5 },
        { s: 20 * scale, g: 1 },
        { s: 30 * scale, g: 0.8 },
        { s: 40 * scale, g: 1 },
    ];
    return [
        { name: "gentle hill (L=40)", points: hill(1), length: 40 },
        {
            name: "big swing (L=25)",
            length: 25,
            points: [
                { s: 0, g: 1 },
                { s: 5, g: 3 },
                { s: 10, g: -1 },
                { s: 15, g: 3 },
                { s: 20, g: 1 },
                { s: 25, g: 1 },
            ],
        },
        {
            name: "hill x4 (L=160)",
            points: hill(4),
            length: 160,
            entry: { x: 0, y: 0, theta: 0, v: 30 },
        },
        {
            name: "hill x10 (L=400)",
            points: hill(10),
            length: 400,
            entry: { x: 0, y: 0, theta: 0, v: 40 },
        },
    ];
}

function exitAt(
    sc: Scenario,
    points: ForcePoint[],
): { x: number; y: number; theta: number; v: number } {
    const entry = sc.entry ?? ENTRY;
    const step = resolveStep(sc.length, DS);
    const dense = forceProfile(points, step);
    const e = evalForce(entry, dense, step, undefined).exit;
    return { x: e.x, y: e.y, theta: e.theta, v: e.v };
}

function withBump(points: ForcePoint[], k: number, dg: number): ForcePoint[] {
    return points.map((p, i) => ({ ...p, g: i === k ? p.g + dg : p.g }));
}

function scaleOf(sc: Scenario): number {
    const e = exitAt(sc, sc.points);
    return Math.max(Math.abs(e.x), Math.abs(e.y), sc.length);
}

function minSpeed(sc: Scenario, points: ForcePoint[]): number {
    const entry = sc.entry ?? ENTRY;
    const step = resolveStep(sc.length, DS);
    const dense = forceProfile(points, step);
    const r = evalForce(entry, dense, step, undefined);
    let m = Infinity;
    for (let i = 0; i < r.v.length; i++) m = Math.min(m, r.v[i]);
    return m;
}

// ── 1. COST re-baseline ─────────────────────────────────────────────────────────────

console.log("── 1. cost re-baseline (single-key ±0.2 g sweep, all keys free) ──");
for (const sc of corpus()) {
    const stamp = exitAt(sc, sc.points);
    const times: number[] = [];
    const iters: number[] = [];
    let refused = 0;
    for (let k = 0; k < sc.points.length; k++) {
        for (const sign of [1, -1]) {
            const opts: OptimizeOpts = {
                entry: sc.entry ?? ENTRY,
                points: withBump(sc.points, k, sign * 0.2),
                locked: new Set(),
                length: sc.length,
                ds: DS,
                stamp,
            };
            const t0 = performance.now();
            const r = solveOptimize(opts);
            times.push(performance.now() - t0);
            iters.push(r.iters);
            if (r.outcome !== "solved") refused++;
        }
    }
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    const max = Math.max(...times);
    console.log(
        `${sc.name}: mean ${mean.toFixed(2)} ms, max ${max.toFixed(2)} ms, ` +
            `iters ${Math.min(...iters)}–${Math.max(...iters)}, refused ${refused}/${times.length}`,
    );
}

// ── 2. FLOOR: f32 replay-noise scatter of the exit map ─────────────────────────────

console.log(
    "\n── 2. f32 replay-noise floor (RMS scatter around affine fit, sub-quantum dither) ──",
);
console.log("row = per-axis scatter in ulps of scale (ε·scale) and in ε·scale·√N units");
for (const sc of corpus()) {
    const N = Math.round(sc.length / DS);
    const scale = scaleOf(sc);
    const K = sc.points.length;
    // dither along a fixed pseudo-random direction, amplitudes far below the FD step so the
    // response is affine at f64 but staircased by the f32 state — the scatter IS the replay noise.
    const u = Array.from({ length: K }, (_, i) => Math.sin(i * 12.9898 + 4.1) % 1);
    const M = 128;
    const A = 1e-7;
    const xs: number[] = [];
    const ys: number[][] = [[], [], []];
    for (let j = 0; j < M; j++) {
        const d = (j / (M - 1)) * A;
        const pts = sc.points.map((p, i) => ({ ...p, g: p.g + d * u[i] }));
        const e = exitAt(sc, pts);
        xs.push(d);
        ys[0].push(e.x);
        ys[1].push(e.y);
        ys[2].push(e.theta * sc.length); // θ row in metres (the scaled-row frame)
    }
    const rms = ys.map((row) => {
        // least-squares affine fit y = a + b·x, residual RMS
        const n = row.length;
        const mx = xs.reduce((a, b) => a + b, 0) / n;
        const my = row.reduce((a, b) => a + b, 0) / n;
        let sxx = 0;
        let sxy = 0;
        for (let j = 0; j < n; j++) {
            sxx += (xs[j] - mx) ** 2;
            sxy += (xs[j] - mx) * (row[j] - my);
        }
        const b = sxy / sxx;
        let ss = 0;
        for (let j = 0; j < n; j++) ss += (row[j] - my - b * (xs[j] - mx)) ** 2;
        return Math.sqrt(ss / n);
    });
    const ulp = F32_EPS * scale;
    console.log(
        `${sc.name} (N=${N}, scale=${scale.toFixed(0)} m): ` +
            `x ${(rms[0] / ulp).toFixed(1)} ulp, y ${(rms[1] / ulp).toFixed(1)} ulp, ` +
            `Lθ ${(rms[2] / ulp).toFixed(1)} ulp | vs √N=${Math.sqrt(N).toFixed(1)}: ` +
            `x ${(rms[0] / (ulp * Math.sqrt(N))).toFixed(2)}, y ${(rms[1] / (ulp * Math.sqrt(N))).toFixed(2)}, ` +
            `Lθ ${(rms[2] / (ulp * Math.sqrt(N))).toFixed(2)}`,
    );
}

// ── 3. ATTAINABLE: smallest reliably-reachable tolerance in ulp units ──────────────

console.log(
    "\n── 3. attainable tolerance (ulp-of-scale multipliers; refusals per 2K-key sweep) ──",
);
console.log(
    "note: stall-certified unreachables ride in these counts (hill x10 has 4 stalling edits)",
);
for (const sc of corpus()) {
    const stamp = exitAt(sc, sc.points);
    const scale = scaleOf(sc);
    const row: string[] = [];
    for (const mult of [1, 2, 4, 8, 16, 32, 64]) {
        const tol = mult * F32_EPS * scale;
        let refused = 0;
        let total = 0;
        for (let k = 0; k < sc.points.length; k++) {
            for (const sign of [1, -1]) {
                total++;
                const r = solveOptimize({
                    entry: sc.entry ?? ENTRY,
                    points: withBump(sc.points, k, sign * 0.2),
                    locked: new Set(),
                    length: sc.length,
                    ds: DS,
                    stamp,
                    tol,
                    angleTol: tol / sc.length,
                });
                if (r.outcome !== "solved") refused++;
            }
        }
        row.push(`${mult}ulp:${refused}/${total}`);
    }
    console.log(`${sc.name} (scale ${scale.toFixed(0)} m): ${row.join("  ")}`);
}

// ── 4. CONDITIONING: scaled-J σmin/σmax, healthy vs the pre-named suspects ─────────

/** central-FD scaled exit Jacobian (rows x, y, L·θ; the kernel's own step), then the exact
 *  eigenvalue ratio of the 3×3 JJᵀ via cyclic Jacobi — σmin/σmax = sqrt(λmin/λmax). */
function condRatio(sc: Scenario, points: ForcePoint[], free: number[]): number {
    const L = sc.length;
    const J: number[][] = [[], [], []];
    for (const k of free) {
        const eP = exitAt(sc, withBump(points, k, JAC_H));
        const eM = exitAt(sc, withBump(points, k, -JAC_H));
        J[0].push((eP.x - eM.x) / (2 * JAC_H));
        J[1].push((eP.y - eM.y) / (2 * JAC_H));
        J[2].push((L * (eP.theta - eM.theta)) / (2 * JAC_H));
    }
    const A = new Float64Array(9);
    for (let a = 0; a < 3; a++)
        for (let b = 0; b < 3; b++) {
            let s = 0;
            for (let i = 0; i < free.length; i++) s += J[a][i] * J[b][i];
            A[a * 3 + b] = s;
        }
    // cyclic Jacobi on symmetric 3×3
    const m = Array.from(A);
    for (let sweep = 0; sweep < 32; sweep++) {
        let off = 0;
        for (const [p, q] of [
            [0, 1],
            [0, 2],
            [1, 2],
        ]) {
            const apq = m[p * 3 + q];
            off += apq * apq;
            if (apq === 0) continue;
            const theta = (m[q * 3 + q] - m[p * 3 + p]) / (2 * apq);
            const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
            const c = 1 / Math.sqrt(t * t + 1);
            const s = t * c;
            for (let i = 0; i < 3; i++) {
                const aip = m[i * 3 + p];
                const aiq = m[i * 3 + q];
                m[i * 3 + p] = c * aip - s * aiq;
                m[i * 3 + q] = s * aip + c * aiq;
            }
            for (let i = 0; i < 3; i++) {
                const api = m[p * 3 + i];
                const aqi = m[q * 3 + i];
                m[p * 3 + i] = c * api - s * aqi;
                m[q * 3 + i] = s * api + c * aqi;
            }
        }
        if (off < 1e-30) break;
    }
    const eigs = [m[0], m[4], m[8]].map(Math.abs);
    return Math.sqrt(Math.min(...eigs) / Math.max(...eigs));
}

/** the stall certificate's own reading (`optimize.ts`): per free key, the θ row's two one-sided
 *  differences (weighted ×L), their sign opposition above the FD noise floor (the certificate),
 *  the |fwd−bwd|/|central| ratio (informational), and the measured row against the per-key
 *  march-derived direct-channel cap Σ basis·G·ds/vSafe² — kept as the REFUTATION record for the
 *  reviewer-preferred cap route: the feedback channel legitimately exceeds the direct cap on
 *  HEALTHY drafts (gentle hill 1.05×, big swing 1.24×, hill×10 base 8.5×), so a cap-exceedance
 *  certificate over-fires on smooth solvable cases and is rejected. */
function stallRead(
    sc: Scenario,
    points: ForcePoint[],
    free: number[],
): { fires: boolean; maxRatio: number; maxCapRatio: number } {
    const L = sc.length;
    const base = exitAt(sc, points);
    const step = resolveStep(L, DS);
    const dense0 = forceProfile(points, step);
    const entry = sc.entry ?? ENTRY;
    const march = evalForce(entry, dense0, step, undefined);
    const scale = Math.max(Math.abs(base.x), Math.abs(base.y), L);
    const noise = (F32_EPS * scale) / JAC_H;
    let fires = false;
    let maxRatio = 0;
    let maxCapRatio = 0;
    for (const k of free) {
        const eP = exitAt(sc, withBump(points, k, JAC_H));
        const eM = exitAt(sc, withBump(points, k, -JAC_H));
        const cen = (L * (eP.theta - eM.theta)) / (2 * JAC_H);
        const fwd = (L * (eP.theta - base.theta)) / JAC_H;
        const bwd = (L * (base.theta - eM.theta)) / JAC_H;
        if (fwd * bwd < 0 && Math.min(Math.abs(fwd), Math.abs(bwd)) > noise) fires = true;
        maxRatio = Math.max(maxRatio, Math.abs(fwd - bwd) / Math.max(Math.abs(cen), noise));
        const bump = forceProfile(withBump(points, k, 1), step);
        let cap = 0;
        for (let e = 0; e < dense0.length; e++) {
            const vs = Math.max(Math.abs(march.v[e]), 0.01);
            cap += (Math.abs(bump[e] - dense0[e]) * 9.80665 * DS) / (vs * vs);
        }
        maxCapRatio = Math.max(maxCapRatio, Math.abs(cen) / (L * cap));
    }
    return { fires, maxRatio, maxCapRatio };
}

console.log("\n── 4. conditioning σmin/σmax (threshold candidate: ε^(2/3) = 2^-16 ≈ 1.5e-5) ──");
{
    for (const sc of corpus().slice(0, 2)) {
        const all = [...sc.points.keys()];
        console.log(`healthy — ${sc.name}: ${condRatio(sc, sc.points, all).toExponential(2)}`);
    }
    // near-straight: flat 1 g everywhere → θ ≡ 0, the x-row vanishes at first order.
    const straight: Scenario = {
        name: "near-straight",
        length: 40,
        points: [
            { s: 0, g: 1 },
            { s: 10, g: 1 },
            { s: 20, g: 1 },
            { s: 30, g: 1 },
            { s: 40, g: 1 },
        ],
    };
    console.log(
        `near-straight (flat 1 g): ${condRatio(straight, straight.points, [...straight.points.keys()]).toExponential(2)}`,
    );
    const nearStraight: Scenario = {
        ...straight,
        points: straight.points.map((p, i) => ({ ...p, g: 1 + (i % 2 === 0 ? 0.01 : -0.01) })),
    };
    console.log(
        `near-straight (±0.01 g wiggle): ${condRatio(nearStraight, nearStraight.points, [...nearStraight.points.keys()]).toExponential(2)}`,
    );
    // clustered free keys at minimum count: P = 3 with two keys 0.05 m apart.
    const clustered: Scenario = {
        name: "clustered",
        length: 40,
        points: [
            { s: 0, g: 1 },
            { s: 10, g: 1.5 },
            { s: 10.05, g: 1.5 },
            { s: 25, g: 0.8 },
            { s: 40, g: 1 },
        ],
    };
    console.log(
        `clustered pair, P=3 (both cluster keys + one): ${condRatio(clustered, clustered.points, [1, 2, 3]).toExponential(2)}`,
    );
    console.log(
        `clustered pair, all 5 free: ${condRatio(clustered, clustered.points, [...clustered.points.keys()]).toExponential(2)}`,
    );
    // clamp crest / post-stall: a climbing profile with entry v chosen near the stall speed.
    const climb: ForcePoint[] = [
        { s: 0, g: 1 },
        { s: 10, g: 2.2 },
        { s: 20, g: 0.4 },
        { s: 30, g: 1 },
        { s: 40, g: 1 },
    ];
    for (const v of [12, 10, 8, 7, 6.5, 6]) {
        const sc: Scenario = {
            name: `climb v0=${v}`,
            length: 40,
            points: climb,
            entry: { x: 0, y: 0, theta: 0, v },
        };
        const vMin = minSpeed(sc, climb);
        console.log(
            `climb v0=${v} (vMin ${vMin.toFixed(3)} m/s): ${condRatio(sc, climb, [...climb.keys()]).toExponential(2)}`,
        );
    }

    console.log(
        "\n── 4b. stall certificate: θ-row one-sided sign opposition (fires only on floor-touching; a floor-touching draft may still read consistent and solve — hill +2g) ──",
    );
    console.log(
        "cols: fires (the certificate) | disRatio |fwd−bwd|/|cen| | row/marchCap (refuted route)",
    );
    const stallCases: { name: string; sc: Scenario; points: ForcePoint[] }[] = [];
    for (const sc of corpus()) stallCases.push({ name: sc.name, sc, points: sc.points });
    const hillPts = corpus()[0].points;
    stallCases.push({
        name: "hill +3g key1 (curvature stress, smooth)",
        sc: corpus()[0],
        points: withBump(hillPts, 1, 3),
    });
    stallCases.push({
        name: "hill +2g key1 (floor-touching, SOLVES)",
        sc: corpus()[0],
        points: withBump(hillPts, 1, 2),
    });
    for (const v of [10, 8, 7, 6]) {
        stallCases.push({
            name: `climb v0=${v}${v === 10 ? " (smooth near-stall)" : v === 8 ? " (graze: 1 floor sample)" : " (deep stall)"}`,
            sc: { name: "climb", length: 40, points: climb, entry: { x: 0, y: 0, theta: 0, v } },
            points: climb,
        });
    }
    const hill10sc = corpus()[3];
    stallCases.push({
        name: "hill10 key3 +0.2 (localized stall the old L-cap missed)",
        sc: hill10sc,
        points: withBump(hill10sc.points, 3, 0.2),
    });
    for (const c of stallCases) {
        const r = stallRead(c.sc, c.points, [...c.points.keys()]);
        const vMin = minSpeed(c.sc, c.points);
        console.log(
            `${c.name} (vMin ${vMin.toFixed(2)}): fires=${r.fires} disRatio=${r.maxRatio.toFixed(2)} row/marchCap=${r.maxCapRatio.toFixed(2)}`,
        );
    }
}

// ── 5. DISTRIBUTION + FOLD ─────────────────────────────────────────────────────────

console.log("\n── 5a. uniform vs Gram Δg distribution (gentle hill, key 2 +0.6 g, lock key 0) ──");
{
    const sc = corpus()[0];
    const stamp = exitAt(sc, sc.points);
    const edited = withBump(sc.points, 2, 0.6);
    const r = solveOptimize({
        entry: ENTRY,
        points: edited,
        locked: new Set([0]),
        length: sc.length,
        ds: DS,
        stamp,
    });
    console.log(
        `gram: ${r.outcome} iters=${r.iters} Δg=[${r.deltaG.map((d) => d.toFixed(4)).join(", ")}]`,
    );
    // the uniform (M = I) alternative at first order: Δz = −Jᵀ(JJᵀ)⁻¹c at the edited draft —
    // the min-‖Δg‖₂ correction the locked decision rejected as basis-dependent. Compared at
    // first order only (a full uniform solve would need a kernel knob the objective law forbids).
    const free = [1, 2, 3, 4];
    const L = sc.length;
    const scLab: Scenario = { name: sc.name, points: edited, length: sc.length };
    const e1 = exitAt(scLab, edited);
    const c = [e1.x - stamp.x, e1.y - stamp.y, L * (e1.theta - stamp.theta)];
    const J: number[][] = [[], [], []];
    for (const k of free) {
        const eP = exitAt(scLab, withBump(edited, k, JAC_H));
        const eM = exitAt(scLab, withBump(edited, k, -JAC_H));
        J[0].push((eP.x - eM.x) / (2 * JAC_H));
        J[1].push((eP.y - eM.y) / (2 * JAC_H));
        J[2].push((L * (eP.theta - eM.theta)) / (2 * JAC_H));
    }
    // 3×3 JJᵀ, solved by Cramer (lab-only)
    const A: number[][] = [0, 1, 2].map((a) =>
        [0, 1, 2].map((b) => J[a].reduce((s, v, i) => s + v * J[b][i], 0)),
    );
    const det = (m: number[][]): number =>
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
        m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
        m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const dA = det(A);
    const lam = [0, 1, 2].map((i) => {
        const Ai = A.map((row) => [...row]);
        for (let r2 = 0; r2 < 3; r2++) Ai[r2][i] = c[r2];
        return det(Ai) / dA;
    });
    const uniform = free.map((_, i) => -(J[0][i] * lam[0] + J[1][i] * lam[1] + J[2][i] * lam[2]));
    console.log(`uniform (1st order): Δg=[0.0000, ${uniform.map((d) => d.toFixed(4)).join(", ")}]`);
}

console.log("\n── 5b. fold probe: drift ramp until the direct solve stops converging ──");
for (const sc of [corpus()[0], corpus()[1]]) {
    const stamp = exitAt(sc, sc.points);
    const marks: string[] = [];
    for (const dg of [0.2, 0.5, 1, 1.5, 2, 3, 4, 6]) {
        const r = solveOptimize({
            entry: sc.entry ?? ENTRY,
            points: withBump(sc.points, 1, dg),
            locked: new Set(),
            length: sc.length,
            ds: DS,
            stamp,
        });
        marks.push(
            `+${dg}g:${r.outcome === "solved" ? `ok(${r.iters})` : `${r.outcome}@${r.residual.toExponential(1)}`}`,
        );
    }
    console.log(`${sc.name}: ${marks.join("  ")}`);
}

// ── 6. INJECTION BREACH ─────────────────────────────────────────────────────────────
// (retired to the injection gate at its own site.) The old form of this sweep compared the landed
// draft's v² against the stamp's v² (`exitTol`) — a comparison that only made sense at μ = c = 0,
// where the path-energy law made exit v a strict function of exit y. The injection gate retires
// that comparison: the gate
// now reads `SectionResult.injection` — the sqrt-clamp's own accumulated energy injection — off
// the LANDED draft directly (`bake.forces`'s `Σ −min(v²_pre-clamp, 0)`, surfaced as
// `OptimizeResult.injection`), never a stamp comparison, so it reads correctly whether or not the
// section carries friction/drag. Sweeps the stall neighborhood: the climb profile (§4/§4b) across
// length neighbors of L = 90 and entry v0 in the floor-graze/deep-stall band, plus the named §4b
// floor-touching drafts run through the ACTUAL solve (not just the Jacobian-read stall
// certificate at invoke — this reads the LANDED state, which no invoke-time certificate covers).
// The bound is `injectionTol` — `optimize.ts`'s own exported production seam, not a
// re-derivation (module header).
console.log(
    "\n── 6. injection breach sweep (solved drafts whose landed march injects energy beyond injectionTol) ──",
);
{
    const climbBase: ForcePoint[] = [
        { s: 0, g: 1 },
        { s: 10, g: 2.2 },
        { s: 20, g: 0.4 },
        { s: 30, g: 1 },
        { s: 40, g: 1 },
    ];
    const climbScaled = (L: number): ForcePoint[] =>
        climbBase.map((p) => ({ ...p, s: (p.s * L) / 40 }));

    let breaches = 0;
    let total = 0;
    let bestSolvedRatio = 0;
    let bestSolvedRow = "";
    let worstInjectionOverall = 0;
    let worstInjectionRow = "";

    function runCase(
        label: string,
        entry: Entry,
        base: ForcePoint[],
        length: number,
        edited: ForcePoint[],
    ): void {
        total++;
        const step = resolveStep(length, DS);
        const dense = forceProfile(base, step);
        const stamp = evalForce(entry, dense, step, undefined).exit;
        const r = solveOptimize({
            entry,
            points: edited,
            locked: new Set(),
            length,
            ds: DS,
            stamp,
        });
        const vmin = minSpeed({ name: label, points: edited, length, entry }, edited);
        const bound = injectionTol(entry.v, length, step.edges);
        const breach = r.outcome === "solved" && r.injection > bound;
        if (breach) breaches++;
        if (r.outcome === "solved" && r.injection / bound > bestSolvedRatio) {
            bestSolvedRatio = r.injection / bound;
            bestSolvedRow = label;
        }
        if (r.injection > worstInjectionOverall) {
            worstInjectionOverall = r.injection;
            worstInjectionRow = label;
        }
        console.log(
            `${label}: outcome=${r.outcome} vmin=${vmin.toFixed(3)} residual=${r.residual.toExponential(2)} ` +
                `angleResidual=${r.angleResidual.toExponential(2)} injection=${r.injection.toExponential(3)} bound=${bound.toExponential(3)}` +
                `${breach ? " BREACH" : ""}`,
        );
    }

    for (const L of [75, 90, 105]) {
        const base = climbScaled(L);
        for (const v0 of [8, 7, 6.5, 6]) {
            const entry: Entry = { x: 0, y: 0, theta: 0, v: v0 };
            for (const dg of [-1, -0.5, 0.5, 1, 1.5, 2, 2.5, 3]) {
                const edited = withBump(base, 1, dg);
                runCase(
                    `climb L=${L} v0=${v0} key1${dg > 0 ? "+" : ""}${dg}`,
                    entry,
                    base,
                    L,
                    edited,
                );
            }
        }
    }

    // the named §4b floor-touching drafts, run through the real solve (not just the stall read).
    const hillPts = corpus()[0].points;
    for (const dg of [1.8, 1.9, 2, 2.1, 2.2, 3]) {
        runCase(
            `hill key1+${dg} (§4b floor-touching)`,
            ENTRY,
            hillPts,
            40,
            withBump(hillPts, 1, dg),
        );
    }
    const hill10sc = corpus()[3];
    runCase(
        "hill10 key3+0.2 (§4b localized stall)",
        hill10sc.entry ?? ENTRY,
        hill10sc.points,
        hill10sc.length,
        withBump(hill10sc.points, 3, 0.2),
    );

    // the fine boundary sweep around the hill/hill×4 stall-graze edge — the closest a solved
    // draft in this corpus is measured to get to breaching the exact bound.
    const hill4Pts = hillPts.map((p) => ({ ...p, s: p.s * 4 }));
    const entry4: Entry = { x: 0, y: 0, theta: 0, v: 30 };
    for (const dg of [1.9, 2, 2.05, 2.1, 2.2, 3, 4]) {
        runCase(
            `hillx4 key1+${dg} (fine boundary sweep)`,
            entry4,
            hill4Pts,
            160,
            withBump(hill4Pts, 1, dg),
        );
    }

    console.log(
        `\n${breaches} breaches over ${total} drafts swept. Largest solved injection/bound ratio: ` +
            `${bestSolvedRatio.toFixed(3)} (${bestSolvedRow}). Largest injection overall (any outcome): ` +
            `${worstInjectionOverall.toExponential(3)} (${worstInjectionRow}).`,
    );
}
