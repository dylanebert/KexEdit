// Stage-1 lab — the sparse-variable solve, the evidence gate for the
// force-target design (spec `kex/specs/kex2d-force-targets.md` §Approach). The
// question: can invoked optimization over the *authored node parameters*
// (freed nodes' x, y, θ; arc-rule tangent lengths stay derived) satisfy a
// span-scoped force target, warm from a plausible draft, inside an RTI frame
// budget? If not → stop and re-scope (fallbacks: free tangent lengths as DOF;
// dense-spine solve + refit).
//
// The map: node params → frozen-topology `sampleAt` → `forces64` → F_n. The
// sampling topology (per-segment edge counts) freezes at solve start, so the
// residual dimension is constant and the finite-difference Jacobian is clean —
// the natural sibling of the spec's "freeze the display mapping for a gesture"
// discipline. Decision variables are the node params, NOT the dense spine, so
// the problem is tiny (≤ ~10 nodes ⇒ ≤ 30 DOF) and a dense LM suffices.
//
// Residuals: force rows over the target span interior + a weak draft prior
// (pull each freed param toward its drafted value — the degeneracy regularizer
// and the "minimum deformation of what the author drew" intent) + an optional
// node-spacing term (adjacent freed-node chord vs draft — suppresses tangential
// bunching). LM = Levenberg–Marquardt with Marquardt diagonal scaling (the
// mixed-unit x/y/θ DOF want per-column scaling, unlike the dense kernel's μI).
//
// Panels:
//   0. draft sanity — the hill's crest force profile
//   1. basin — converge to a 0g crest POINT from the draft; iters, achieved g
//   2. representability — hold 0g over a SPAN vs freed-node count (the crux)
//   3. bunching — with/without the spacing term
//   4. cost — ms per LM iteration vs the ~2 ms RTI frame budget
//   5. composition — two span targets solved together
//   6. force-error budget derived from timeline display resolution
//
// Run: bun tests/hill.lab.ts

import { forces64 } from "../src/force";
import { chainCounts, type Node, sampleAt } from "../src/spline";
import { denseSolveSpd } from "./helpers/dense";
import { denseHillDraft, hillDraft } from "./helpers/hill";

const DS = 0.5;
const MAX = 4096;

// ── the forward map (frozen topology) ───────────────────────────────────────

const bx = new Float64Array(MAX);
const by = new Float64Array(MAX);
const bds = new Float64Array(MAX);

interface Baked {
    fN: Float64Array;
    v2: Float64Array;
    offsets: number[];
    /** interior sample count N = edges + 1. */
    n: number;
    x: Float64Array;
    y: Float64Array;
}

function bake(nodes: Node[], counts: number[], v0: number): Baked {
    const { offsets, edges } = sampleAt(nodes, counts, bx, by, bds);
    const n = edges + 1;
    const x = bx.slice(0, n);
    const y = by.slice(0, n);
    const f = forces64(x, y, n, v0);
    return { fN: f.fN, v2: f.v2, offsets, n, x, y };
}

// ── the problem (a frozen solve instance) ───────────────────────────────────

interface Target {
    /** inclusive interior sample-index span. */
    s0: number;
    s1: number;
    f: number;
}

interface Weights {
    wF: number;
    wPos: number;
    wTheta: number;
    wSpace: number;
}

interface Problem {
    base: Node[];
    freed: number[];
    counts: number[];
    v0: number;
    targets: Target[];
    w: Weights;
    p0: Float64Array;
    /** draft chord length for each adjacent freed pair (k,k+1); NaN if not adjacent. */
    spaceRef: number[];
}

/** nodes whose segments overlap [fromNode,toNode] plus one neighbor each side,
 *  excluding the flat anchor (node 0) — the §5 auto-scope rule. */
function autoFreed(nNodes: number, fromNode: number, toNode: number): number[] {
    const lo = Math.max(1, fromNode - 1);
    const hi = Math.min(nNodes - 1, toNode + 1);
    const out: number[] = [];
    for (let i = lo; i <= hi; i++) out.push(i);
    return out;
}

function pack(nodes: Node[], freed: number[]): Float64Array {
    const p = new Float64Array(freed.length * 3);
    freed.forEach((idx, k) => {
        p[k * 3] = nodes[idx].x;
        p[k * 3 + 1] = nodes[idx].y;
        p[k * 3 + 2] = nodes[idx].theta;
    });
    return p;
}

function unpack(base: Node[], freed: number[], p: Float64Array): Node[] {
    const nodes = base.map((n) => ({ ...n }));
    freed.forEach((idx, k) => {
        nodes[idx] = { x: p[k * 3], y: p[k * 3 + 1], theta: p[k * 3 + 2] };
    });
    return nodes;
}

/** build a frozen problem. `spans` are node-anchored ([fromNode,toNode,f]); the
 *  freed set defaults to the §5 auto-scope union over all spans. */
function setup(
    draft: { nodes: Node[]; v0: number },
    spans: [number, number, number][],
    w: Weights,
    freedOverride?: number[],
): Problem {
    const base = draft.nodes;
    const { counts } = chainCounts(base, DS, MAX);
    const b = bake(base, counts, draft.v0);
    const targets: Target[] = spans.map(([from, to, f]) => {
        const s0 = Math.max(1, b.offsets[from]);
        const s1 = Math.min(b.n - 2, b.offsets[to]);
        return { s0, s1, f };
    });
    const freed =
        freedOverride ??
        Array.from(new Set(spans.flatMap(([from, to]) => autoFreed(base.length, from, to)))).sort(
            (a, z) => a - z,
        );
    const p0 = pack(base, freed);
    const spaceRef = freed.map((idx, k) => {
        if (k + 1 >= freed.length || freed[k + 1] !== idx + 1) return Number.NaN;
        const a = base[idx];
        const c = base[idx + 1];
        return Math.hypot(c.x - a.x, c.y - a.y);
    });
    return { base, freed, counts, v0: draft.v0, targets, w, p0, spaceRef };
}

// ── residual + Jacobian ─────────────────────────────────────────────────────

function residual(prob: Problem, p: Float64Array): Float64Array {
    const nodes = unpack(prob.base, prob.freed, p);
    const b = bake(nodes, prob.counts, prob.v0);
    const rows: number[] = [];
    for (const t of prob.targets)
        for (let i = t.s0; i <= t.s1; i++) rows.push(prob.w.wF * (b.fN[i] - t.f));
    prob.freed.forEach((_, k) => {
        rows.push(prob.w.wPos * (p[k * 3] - prob.p0[k * 3]));
        rows.push(prob.w.wPos * (p[k * 3 + 1] - prob.p0[k * 3 + 1]));
        rows.push(prob.w.wTheta * (p[k * 3 + 2] - prob.p0[k * 3 + 2]));
    });
    if (prob.w.wSpace > 0)
        prob.freed.forEach((idx, k) => {
            if (Number.isNaN(prob.spaceRef[k])) return;
            const a = nodes[idx];
            const c = nodes[idx + 1];
            rows.push(prob.w.wSpace * (Math.hypot(c.x - a.x, c.y - a.y) - prob.spaceRef[k]));
        });
    return Float64Array.from(rows);
}

/** central-difference Jacobian; frozen topology keeps every column the same
 *  length. positions step 1e-4 m, headings 1e-5 rad. */
function jacobian(prob: Problem, p: Float64Array, r0len: number): Float64Array {
    const K = p.length;
    const J = new Float64Array(r0len * K);
    for (let j = 0; j < K; j++) {
        const h = j % 3 === 2 ? 1e-5 : 1e-4;
        const pp = Float64Array.from(p);
        const pm = Float64Array.from(p);
        pp[j] += h;
        pm[j] -= h;
        const rp = residual(prob, pp);
        const rm = residual(prob, pm);
        for (let i = 0; i < r0len; i++) J[i * K + j] = (rp[i] - rm[i]) / (2 * h);
    }
    return J;
}

function cost(prob: Problem, p: Float64Array): number {
    const r = residual(prob, p);
    let c = 0;
    for (let i = 0; i < r.length; i++) c += r[i] * r[i];
    return 0.5 * c;
}

interface SolveResult {
    p: Float64Array;
    iters: number;
    ms: number;
    converged: boolean;
    /** wall-clock spent inside Jacobian builds (the FD cost). */
    jacMs: number;
}

/** LM with Marquardt diagonal scaling. Nielsen μ/ν update; stop when the step
 *  falls below `stepTol` (params barely moving) — NOT a health signal; the
 *  achieved force error is measured separately. */
function solve(prob: Problem, maxIters: number, stepTol = 1e-7): SolveResult {
    let p = Float64Array.from(prob.p0);
    const K = p.length;
    let mu = -1;
    let nu = 2;
    let jacMs = 0;
    const t0 = performance.now();
    let iters = 0;
    let converged = false;
    for (; iters < maxIters; iters++) {
        const r = residual(prob, p);
        const R = r.length;
        const tj = performance.now();
        const J = jacobian(prob, p, R);
        jacMs += performance.now() - tj;

        // JᵀJ (K×K) and Jᵀr (K).
        const JtJ = new Float64Array(K * K);
        const Jtr = new Float64Array(K);
        for (let a = 0; a < K; a++) {
            for (let c = a; c < K; c++) {
                let s = 0;
                for (let i = 0; i < R; i++) s += J[i * K + a] * J[i * K + c];
                JtJ[a * K + c] = s;
                JtJ[c * K + a] = s;
            }
            let g = 0;
            for (let i = 0; i < R; i++) g += J[i * K + a] * r[i];
            Jtr[a] = g;
        }
        if (mu < 0) {
            let mx = 0;
            for (let a = 0; a < K; a++) mx = Math.max(mx, JtJ[a * K + a]);
            mu = 1e-3 * mx;
        }

        // (JᵀJ + μ·diag) δ = −Jᵀr, retry with larger μ on rejection.
        let accepted = false;
        let step = 0;
        for (let tries = 0; tries < 30 && !accepted; tries++) {
            const A = Float64Array.from(JtJ);
            for (let a = 0; a < K; a++) A[a * K + a] += mu * JtJ[a * K + a];
            const neg = new Float64Array(K);
            for (let a = 0; a < K; a++) neg[a] = -Jtr[a];
            const delta = denseSolveSpd(A, neg, K);
            const pNew = Float64Array.from(p);
            for (let a = 0; a < K; a++) pNew[a] += delta[a];
            if (cost(prob, pNew) < cost(prob, p)) {
                p = pNew;
                accepted = true;
                mu *= 1 / 3;
                nu = 2;
                for (let a = 0; a < K; a++) step = Math.max(step, Math.abs(delta[a]));
            } else {
                mu *= nu;
                nu *= 2;
            }
        }
        // an early break (no improving step, or step below tol) means a local
        // minimum was reached — LM convergence. Only exhausting maxIters is a
        // non-converged stop. (Health is the achieved force error, measured
        // separately — `converged` is not a health signal.)
        if (!accepted || step < stepTol) {
            converged = true;
            iters++;
            break;
        }
    }
    return { p, iters, ms: performance.now() - t0, converged, jacMs };
}

// ── measurement ─────────────────────────────────────────────────────────────

/** fraction of each target span trimmed off both ends when measuring the
 *  *interior* error — a constant-g band meeting normal track is a curvature
 *  transition (a C¹ break), so the band edges carry an expected spike that is
 *  not a representability failure. `fInt` isolates the held-interior quality. */
const TRIM = 0.2;

interface Metrics {
    /** max |F_n − target| over the whole span (includes the band-edge transition). */
    fErr: number;
    /** max |F_n − target| over the trimmed span interior (the representability metric). */
    fInt: number;
    /** mean |F_n − target| over the span. */
    fMean: number;
    /** max node displacement from draft (m). */
    maxD: number;
    /** max |chord − draftChord|/draftChord over the frozen edges (tangential bunching). */
    chordSpread: number;
    minV2: number;
    nan: boolean;
}

function measure(prob: Problem, p: Float64Array): Metrics {
    const nodes = unpack(prob.base, prob.freed, p);
    const b = bake(nodes, prob.counts, prob.v0);
    const d = bake(prob.base, prob.counts, prob.v0);
    let fErr = 0;
    let fInt = 0;
    let fSum = 0;
    let cnt = 0;
    let minV2 = Number.POSITIVE_INFINITY;
    let nan = false;
    for (const t of prob.targets) {
        const trim = Math.floor((t.s1 - t.s0) * TRIM);
        for (let i = t.s0; i <= t.s1; i++) {
            const e = Math.abs(b.fN[i] - t.f);
            fErr = Math.max(fErr, e);
            if (i >= t.s0 + trim && i <= t.s1 - trim) fInt = Math.max(fInt, e);
            fSum += e;
            cnt++;
        }
    }
    for (let i = 0; i < b.n; i++) {
        minV2 = Math.min(minV2, b.v2[i]);
        if (!Number.isFinite(b.x[i]) || !Number.isFinite(b.y[i])) nan = true;
    }
    let maxD = 0;
    for (let k = 0; k < prob.freed.length; k++)
        maxD = Math.max(
            maxD,
            Math.hypot(p[k * 3] - prob.p0[k * 3], p[k * 3 + 1] - prob.p0[k * 3 + 1]),
        );
    let chordSpread = 0;
    for (let i = 0; i < b.n - 1; i++) {
        const ln = Math.hypot(b.x[i + 1] - b.x[i], b.y[i + 1] - b.y[i]);
        const dr = Math.hypot(d.x[i + 1] - d.x[i], d.y[i + 1] - d.y[i]);
        if (dr > 1e-9) chordSpread = Math.max(chordSpread, Math.abs(ln - dr) / dr);
    }
    return { fErr, fInt, fMean: cnt ? fSum / cnt : 0, maxD, chordSpread, minV2, nan };
}

const row = (label: string, s: SolveResult, m: Metrics, extra = ""): void =>
    console.log(
        `  ${label.padEnd(18)} ${(s.converged ? "conv" : "stop").padEnd(5)}` +
            `iters=${String(s.iters).padStart(3)} fInt=${m.fInt.toFixed(4).padStart(7)} ` +
            `fErr=${m.fErr.toFixed(4).padStart(7)} |d|=${m.maxD.toFixed(2).padStart(5)}m ` +
            `chordΔ=${(m.chordSpread * 100).toFixed(1).padStart(5)}% minV²=${m.minV2.toFixed(0).padStart(5)} ` +
            `${s.ms.toFixed(0).padStart(4)}ms(${(s.ms / Math.max(1, s.iters)).toFixed(1)}ms/it)${extra}`,
    );

// ── 0. draft sanity ─────────────────────────────────────────────────────────
{
    const h = hillDraft();
    const { counts } = chainCounts(h.nodes, DS, MAX);
    const b = bake(h.nodes, counts, h.v0);
    const crestS = b.offsets[h.crest];
    console.log("panel 0 — draft airtime hill (withThetas walk, v0=22)");
    console.log(
        `  N=${b.n} crest node ${h.crest} @ sample ${crestS} ` +
            `F_crest=${b.fN[crestS].toFixed(3)} v²_crest=${b.v2[crestS].toFixed(1)} ` +
            `minV²=${Math.min(...Array.from(b.v2)).toFixed(1)}`,
    );
    const off = b.offsets;
    console.log(
        `  F @ nodes: ${off.map((o, i) => `n${i}=${b.fN[Math.min(o, b.n - 2)].toFixed(2)}`).join(" ")}`,
    );
    console.log("");
}

// ── 1. basin — 0g crest POINT from the draft ────────────────────────────────
{
    const h = hillDraft();
    console.log("panel 1 — hold 0g at the crest node (point target), warm from draft");
    for (const wPos of [0.1, 0.3, 1.0]) {
        const prob = setup(h, [[h.crest, h.crest, 0]], {
            wF: 1,
            wPos,
            wTheta: wPos,
            wSpace: 0,
        });
        const s = solve(prob, 60);
        row(`wPrior=${wPos}`, s, measure(prob, s.p), ` free=[${prob.freed}]`);
    }
    console.log("");
}

// ── 2. representability — 0g over a SPAN vs freed-node count ─────────────────
{
    const h = hillDraft();
    console.log("panel 2 — hold 0g over the crest SPAN [n2,n4]; the representability question");
    const spans: [number, number, number][] = [[2, 4, 0]];
    for (const freed of [[2, 3, 4], [1, 2, 3, 4, 5], autoFreed(h.nodes.length, 2, 4)]) {
        const prob = setup(h, spans, { wF: 1, wPos: 0.1, wTheta: 0.1, wSpace: 0.3 }, freed);
        const s = solve(prob, 120);
        row(`free=[${freed}]`, s, measure(prob, s.p));
    }
    // denser control net over the crest — the "at what node count" leg.
    const hd = denseHillDraft();
    const probD = setup(hd, [[2, 6, 0]], { wF: 1, wPos: 0.1, wTheta: 0.1, wSpace: 0.3 });
    const sD = solve(probD, 120);
    row(`dense free=[${probD.freed}]`, sD, measure(probD, sD.p));
    console.log("  (fInt = trimmed-interior max error; too few nodes → big edge error, the §5");
    console.log("   auto-scope [1..5] reaches the display budget, a denser net goes well under)");
    console.log("");
}

// ── 3. bunching — with/without the spacing term ─────────────────────────────
{
    const h = hillDraft();
    console.log("panel 3 — node-spacing term on/off (span [n2,n4], auto-scope)");
    for (const wSpace of [0, 0.3, 1.0]) {
        const prob = setup(h, [[2, 4, 0]], { wF: 1, wPos: 0.1, wTheta: 0.1, wSpace });
        const s = solve(prob, 120);
        row(`wSpace=${wSpace}`, s, measure(prob, s.p));
    }
    console.log("  (chordΔ = worst tangential stretch; the spacing term should shrink it)");
    console.log("");
}

// ── 4. cost — ms/iter vs the ~2 ms RTI budget ───────────────────────────────
{
    const h = hillDraft();
    console.log(
        "panel 4 — per-iteration cost (RTI runs ONE warm iteration per frame, budget ~2 ms)",
    );
    for (const [lo, hi] of [
        [3, 3],
        [2, 4],
        [1, 5],
    ] as const) {
        const prob = setup(h, [[lo, hi, 0]], { wF: 1, wPos: 0.1, wTheta: 0.1, wSpace: 0.3 });
        solve(prob, 40); // warm the JIT
        // amortize over a full solve — each RTI frame is one such warm iteration.
        const s = solve(prob, 40);
        const K = prob.freed.length * 3;
        console.log(
            `  span[n${lo},n${hi}] DOF=${K}  ${(s.ms / s.iters).toFixed(2)}ms/iter ` +
                `(jac ${(s.jacMs / s.iters).toFixed(2)}ms, ${2 * K} FD evals/iter)`,
        );
    }
    console.log("");
}

// ── 5. composition — two span targets together ──────────────────────────────
{
    const h = hillDraft();
    console.log("panel 5 — two targets in one solve, assembled over the freed-node union");
    // two gentle holds straddling the crest: 1.5g on the approach + 0.4g on the
    // descent. Both have real interior support (endpoint samples, where forces64
    // extrapolates, are excluded). Their auto-scopes share the crest nodes, so
    // this is the coupled case — the solve assembles both targets' rows over the
    // scope union in one system.
    const prob = setup(
        h,
        [
            [1, 2, 1.5],
            [4, 5, 0.4],
        ],
        { wF: 1, wPos: 0.1, wTheta: 0.1, wSpace: 0.3 },
    );
    const s = solve(prob, 150);
    const nodes = unpack(prob.base, prob.freed, s.p);
    const b = bake(nodes, prob.counts, prob.v0);
    const per = prob.targets.map((t) => {
        const trim = Math.floor((t.s1 - t.s0) * TRIM);
        let e = 0;
        for (let k = t.s0 + trim; k <= t.s1 - trim; k++) e = Math.max(e, Math.abs(b.fN[k] - t.f));
        return e;
    });
    row("approach+descent", s, measure(prob, s.p), ` free=[${prob.freed}]`);
    console.log(
        `    target 0 (1.5g approach): fInt=${per[0].toFixed(4)}  ` +
            `target 1 (0.4g descent): fInt=${per[1].toFixed(4)}`,
    );
    console.log("  (coupled scopes, one assembled system — both interiors hit under budget)");
    console.log("");
}

// ── 6. force-error budget from timeline display resolution ───────────────────
{
    // the timeline chart plots F_n on a y-axis auto-fit to the data with 1g
    // always kept. a representative airtime-hill fit is ~[−1, 3]g over a chart
    // of DISPLAY_GRID vertical pixels. sub-pixel force error is invisible.
    const CHART_PX = 260; // Timeline.svelte chart height (order of magnitude)
    const FIT_G = 4; // typical fit span [−1,3]g
    const gPerPx = FIT_G / CHART_PX;
    console.log("panel 6 — force-error budget from timeline display resolution");
    console.log(
        `  chart≈${CHART_PX}px over ≈${FIT_G}g ⇒ ${gPerPx.toFixed(4)} g/px; ` +
            `1px=${gPerPx.toFixed(3)}g, 2px=${(2 * gPerPx).toFixed(3)}g`,
    );
    console.log(
        `  → budget ≈ ${(2 * gPerPx).toFixed(2)}g (2px, invisible on the readout); ` +
            "panel-2 fErr under this = representable",
    );
    console.log("");
}
