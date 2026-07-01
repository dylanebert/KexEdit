// Position-space collocation validation experiment (roadmap "kex2d Phase 3").
//
// De-risks the novel formulation BEFORE the solve.ts/optimize.ts rewrite. The
// F_n-space solver hit a conditioning wall: force→geometry integrates, so its
// endpoint Jacobian σ_pos grows ~N^1.56 with TRACK LENGTH at fixed resolution
// (tests/conditioning.lab.ts), and a near-correct force curve rides into a
// spiraling-to-NaN geometry on a loop. Phase 3 flips the decision variable to
// the GEOMETRY (sample positions) and reads the force off it — geometry→force
// *differentiates* (local in nearby positions), so the Gauss-Newton system is
// banded. This lab tests, on the exact failing case (a 2π loop whose own forces
// leave the band):
//   1. conditioning vs TRACK LENGTH at fixed ds — the apples-to-apples axis the
//      force-space σ_pos~N^1.56 lived on. Flat here ⇒ the integral ill-
//      conditioning is gone.
//   2. conditioning vs RESOLUTION (shrinking ds) — a SEPARATE axis: curvature is
//      a 2nd position-difference, so ∂F/∂P ~ 1/ds². Reported to keep the two
//      effects from being conflated.
//   3. (a) converges from the draft, (b) honors the band where feasible while
//      matching the shape elsewhere, (c) never NaNs (the height bound + energy
//      clamp keep v² ≥ 0 throughout).
//
// Formulation. Variables = free sample positions P_i=(x_i,y_i), P_0 pinned at
// the origin. Everything the loss needs is a LOCAL function of nearby positions:
//   θ_i  = chord-bisector tangent          (mirrors bake.ts `forces`)
//   v_i² = v0² − 2g·y_i                     (energy; linear in height)
//   F_i  = (θ_{i+1}−θ_i)·v_i²/(g·ds) + cosθ (κ·v²/g + cosθ; local)
// Residuals (cost = ½‖r‖²), solved by Gauss-Newton + backtracking line search:
//   shape   √w·(P_i − P_i^draft)            identity term — the trivial match
//   band    √w·hinge(F_i; [LO,HI])          soft force limit on the derived force
//   jerk    √w·(P_{i+2}−3P_{i+1}+3P_i−P_{i−1})  geometric smoothness
//   height  √w·max(0, y_i − v0²/2g)         feasibility (no stall/NaN), linear
//   launch  √w·θ_0                           flat anchor at the start
//
// Run: bun tests/collocation.lab.ts

const G = 9.80665;
const V_FLOOR = 0.01; // mirrors forward.ts (the vSafe clamp in the F_n formula)

// force band (g) and loss weights — by-eye, fixed across N so the conditioning
// slope is a fair geometry-vs-N comparison (not polluted by weight scaling).
const LO = -2;
const HI = 6;
const W_SHAPE = 1;
const W_BAND = 300;
const W_JERK = 0.05;
const W_HEIGHT = 300;
const W_LAUNCH = 10;

function wrap(a: number): number {
    return ((((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
}

interface Draft {
    x: Float64Array;
    y: Float64Array;
    count: number;
    v0: number;
}

/** A vertical loop draft whose own forces leave the band and whose heading
 * sweeps 2π — the conditioning.lab failing regime. Flat lead-in, a full circle
 * of radius R tangent to the horizontal at its bottom (heading 0→2π), flat
 * lead-out. v0 set so the bottom force ≈ v0²/(gR)+1 ≫ HI (out of band) while the
 * top stays feasible (v0² > 4gR). Sampled at uniform arclength `ds`; `Lin`/`Lout`
 * grow the track at FIXED resolution (the honest N-scaling axis). */
function buildDraft(ds: number, Lin = 6, Lout = 6): Draft {
    const R = 6;
    const v0 = Math.sqrt(10 * G * R); // bottom F_n ≈ 11 g
    const xs: number[] = [];
    const ys: number[] = [];

    const nIn = Math.round(Lin / ds);
    for (let i = 0; i < nIn; i++) {
        xs.push((i * Lin) / nIn);
        ys.push(0);
    }
    const nLoop = Math.round((2 * Math.PI * R) / ds);
    for (let i = 0; i < nLoop; i++) {
        const phi = (2 * Math.PI * i) / nLoop;
        xs.push(Lin + R * Math.sin(phi));
        ys.push(R - R * Math.cos(phi));
    }
    const nOut = Math.round(Lout / ds);
    for (let i = 0; i <= nOut; i++) {
        xs.push(Lin + (i * Lout) / nOut);
        ys.push(0);
    }
    return { x: Float64Array.from(xs), y: Float64Array.from(ys), count: xs.length, v0 };
}

interface Recovered {
    theta: Float64Array; // length N
    v: Float64Array; // length N
    fN: Float64Array; // length N−1
    ds: Float64Array; // length N−1 (per-edge chord)
}

/** force recovery from positions — f64 mirror of bake.ts `forces`: chord-bisector
 * tangent (continuous/unwrapped), energy velocity, F_n = κ·v²/g + cosθ. */
function recover(x: Float64Array, y: Float64Array, N: number, v0: number): Recovered {
    const M = N - 1;
    const theta = new Float64Array(N);
    const v = new Float64Array(N);
    const F = new Float64Array(M);
    const ds = new Float64Array(M);
    for (let k = 0; k < M; k++) ds[k] = Math.hypot(x[k + 1] - x[k], y[k + 1] - y[k]);

    const edge = (k: number) => Math.atan2(y[k + 1] - y[k], x[k + 1] - x[k]);
    if (M === 1) {
        theta[0] = edge(0);
        theta[1] = edge(0);
    } else {
        let prev = edge(0);
        let cur = prev + wrap(edge(1) - prev);
        theta[0] = prev - 0.5 * (cur - prev);
        theta[1] = 0.5 * (prev + cur);
        for (let k = 2; k < M; k++) {
            prev = cur;
            cur = prev + wrap(edge(k) - prev);
            theta[k] = 0.5 * (prev + cur);
        }
        theta[M] = cur + 0.5 * (cur - prev);
    }

    v[0] = v0;
    for (let k = 0; k < M; k++) {
        const vSq = v[k] * v[k] - 2 * G * (y[k + 1] - y[k]);
        v[k + 1] = Math.sqrt(Math.max(vSq, 0));
    }
    for (let k = 0; k < M; k++) {
        const vSafe = Math.max(Math.abs(v[k]), V_FLOOR);
        F[k] = ((theta[k + 1] - theta[k]) * vSafe * vSafe) / (G * ds[k]) + Math.cos(theta[k]);
    }
    return { theta, v, fN: F, ds };
}

// --- variable packing: P_0 fixed at origin, free vars = (x_i,y_i) for i=1..N−1 ---
const vx = (i: number) => 2 * (i - 1);
const vy = (i: number) => 2 * (i - 1) + 1;

function unpack(vars: Float64Array, N: number): { x: Float64Array; y: Float64Array } {
    const x = new Float64Array(N);
    const y = new Float64Array(N);
    for (let i = 1; i < N; i++) {
        x[i] = vars[vx(i)];
        y[i] = vars[vy(i)];
    }
    return { x, y };
}

function seed(draft: Draft): Float64Array {
    const vars = new Float64Array(2 * (draft.count - 1));
    for (let i = 1; i < draft.count; i++) {
        vars[vx(i)] = draft.x[i];
        vars[vy(i)] = draft.y[i];
    }
    return vars;
}

/** per-component sum-of-squares of the residual (for a legible cost breakdown). */
interface CostParts {
    shape: number;
    band: number;
    jerk: number;
    height: number;
    launch: number;
    total: number;
}

function costParts(vars: Float64Array, draft: Draft): CostParts {
    const { count: N, v0 } = draft;
    const { x, y } = unpack(vars, N);
    const { theta, fN: F } = recover(x, y, N, v0);
    const yMax = (v0 * v0) / (2 * G) - 1;
    let shape = 0;
    let band = 0;
    let jerk = 0;
    let height = 0;
    for (let i = 1; i < N; i++) {
        shape += W_SHAPE * ((x[i] - draft.x[i]) ** 2 + (y[i] - draft.y[i]) ** 2);
        height += W_HEIGHT * Math.max(0, y[i] - yMax) ** 2;
    }
    for (let k = 0; k < N - 1; k++)
        band += W_BAND * (Math.max(0, F[k] - HI) ** 2 + Math.max(0, LO - F[k]) ** 2);
    for (let i = 1; i <= N - 3; i++)
        jerk +=
            W_JERK *
            ((x[i + 2] - 3 * x[i + 1] + 3 * x[i] - x[i - 1]) ** 2 +
                (y[i + 2] - 3 * y[i + 1] + 3 * y[i] - y[i - 1]) ** 2);
    const launch = W_LAUNCH * theta[0] ** 2;
    const total = 0.5 * (shape + band + jerk + height + launch);
    return { shape, band, jerk, height, launch, total };
}

/** the least-squares residual vector r(vars); cost = ½‖r‖². */
function residual(vars: Float64Array, draft: Draft): Float64Array {
    const { count: N, v0 } = draft;
    const { x, y } = unpack(vars, N);
    const { theta, fN: F } = recover(x, y, N, v0);
    const yMax = (v0 * v0) / (2 * G) - 1;

    const r: number[] = [];
    const sShape = Math.sqrt(W_SHAPE);
    const sBand = Math.sqrt(W_BAND);
    const sJerk = Math.sqrt(W_JERK);
    const sHeight = Math.sqrt(W_HEIGHT);

    for (let i = 1; i < N; i++) {
        r.push(sShape * (x[i] - draft.x[i]));
        r.push(sShape * (y[i] - draft.y[i]));
    }
    for (let k = 0; k < N - 1; k++) {
        r.push(sBand * Math.max(0, F[k] - HI));
        r.push(sBand * Math.max(0, LO - F[k]));
    }
    for (let i = 1; i <= N - 3; i++) {
        r.push(sJerk * (x[i + 2] - 3 * x[i + 1] + 3 * x[i] - x[i - 1]));
        r.push(sJerk * (y[i + 2] - 3 * y[i + 1] + 3 * y[i] - y[i - 1]));
    }
    for (let i = 1; i < N; i++) r.push(sHeight * Math.max(0, y[i] - yMax));
    r.push(Math.sqrt(W_LAUNCH) * theta[0]);
    return Float64Array.from(r);
}

const cost = (r: Float64Array) => 0.5 * r.reduce((s, v) => s + v * v, 0);

/** central-FD columns of the residual Jacobian. */
function jacCols(vars: Float64Array, draft: Draft, r0: Float64Array): Float64Array[] {
    const n = vars.length;
    const h = 1e-6;
    const m = r0.length;
    const cols: Float64Array[] = new Array(n);
    for (let j = 0; j < n; j++) {
        const vp = Float64Array.from(vars);
        const vm = Float64Array.from(vars);
        vp[j] += h;
        vm[j] -= h;
        const rp = residual(vp, draft);
        const rm = residual(vm, draft);
        const col = new Float64Array(m);
        for (let i = 0; i < m; i++) col[i] = (rp[i] - rm[i]) / (2 * h);
        cols[j] = col;
    }
    return cols;
}

function normalEqs(
    cols: Float64Array[],
    r0: Float64Array,
): { ata: Float64Array[]; g: Float64Array } {
    const n = cols.length;
    const m = r0.length;
    const ata: Float64Array[] = Array.from({ length: n }, () => new Float64Array(n));
    const g = new Float64Array(n);
    for (let a = 0; a < n; a++) {
        for (let b = a; b < n; b++) {
            let s = 0;
            for (let i = 0; i < m; i++) s += cols[a][i] * cols[b][i];
            ata[a][b] = s;
            ata[b][a] = s;
        }
        let gg = 0;
        for (let i = 0; i < m; i++) gg += cols[a][i] * r0[i];
        g[a] = gg;
    }
    return { ata, g };
}

/** Cholesky factor of an SPD matrix (lower L). A tiny diagonal floor keeps it
 * SPD against f64 roundoff in the near-singular null directions. */
function cholesky(A: Float64Array[]): Float64Array[] {
    const n = A.length;
    const L: Float64Array[] = Array.from({ length: n }, () => new Float64Array(n));
    for (let i = 0; i < n; i++) {
        for (let j = 0; j <= i; j++) {
            let s = A[i][j];
            for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
            if (i === j) L[i][j] = Math.sqrt(Math.max(s, 1e-12));
            else L[i][j] = s / L[j][j];
        }
    }
    return L;
}

function cholSolve(L: Float64Array[], b: Float64Array): Float64Array {
    const n = L.length;
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let s = b[i];
        for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
        y[i] = s / L[i][i];
    }
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
        let s = y[i];
        for (let k = i + 1; k < n; k++) s -= L[k][i] * x[k];
        x[i] = s / L[i][i];
    }
    return x;
}

/** σmax of the raw force Jacobian ∂F/∂P (no hinge) — the direct geometry→force
 * conditioning, the inverse-direction contrast to conditioning.lab's σ_pos. */
function forceJacSigmaMax(vars: Float64Array, draft: Draft): number {
    const { count: N, v0 } = draft;
    const n = vars.length;
    const M = N - 1;
    const h = 1e-6;
    const cols: Float64Array[] = new Array(n);
    for (let j = 0; j < n; j++) {
        const vp = Float64Array.from(vars);
        const vm = Float64Array.from(vars);
        vp[j] += h;
        vm[j] -= h;
        const { x: xp, y: yp } = unpack(vp, N);
        const { x: xm, y: ym } = unpack(vm, N);
        const fp = recover(xp, yp, N, v0).fN;
        const fm = recover(xm, ym, N, v0).fN;
        const col = new Float64Array(M);
        for (let k = 0; k < M; k++) col[k] = (fp[k] - fm[k]) / (2 * h);
        cols[j] = col;
    }
    const u = new Float64Array(n).fill(1);
    let lam = 0;
    for (let it = 0; it < 120; it++) {
        const gu = new Float64Array(M);
        for (let j = 0; j < n; j++) for (let k = 0; k < M; k++) gu[k] += cols[j][k] * u[j];
        const w = new Float64Array(n);
        for (let j = 0; j < n; j++) {
            let s = 0;
            for (let k = 0; k < M; k++) s += cols[j][k] * gu[k];
            w[j] = s;
        }
        const nrm = Math.hypot(...w);
        if (nrm === 0) return 0;
        lam = nrm;
        for (let j = 0; j < n; j++) u[j] = w[j] / nrm;
    }
    return Math.sqrt(lam);
}

/** cond(A)=λmax/λmin via power iteration (λmax) and inverse-power on L (λmin). */
function condEst(A: Float64Array[]): number {
    const n = A.length;
    const matvec = (v: Float64Array) => {
        const o = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            let s = 0;
            for (let j = 0; j < n; j++) s += A[i][j] * v[j];
            o[i] = s;
        }
        return o;
    };
    const u = new Float64Array(n).fill(1);
    let lmax = 0;
    for (let it = 0; it < 150; it++) {
        const w = matvec(u);
        const nrm = Math.hypot(...w);
        lmax = nrm;
        for (let i = 0; i < n; i++) u[i] = w[i] / nrm;
    }
    const L = cholesky(A);
    const z = new Float64Array(n).fill(1);
    let linv = 0;
    for (let it = 0; it < 150; it++) {
        const w = cholSolve(L, z);
        const nrm = Math.hypot(...w);
        linv = nrm;
        for (let i = 0; i < n; i++) z[i] = w[i] / nrm;
    }
    return lmax * linv;
}

function logSlope(xs: number[], ys: number[]): number {
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

const oob = (F: Float64Array) => {
    let m = 0;
    for (const f of F) m = Math.max(m, f - HI, LO - f);
    return m;
};

// ===================== 1. conditioning vs TRACK LENGTH (fixed ds) =====================
// the apples-to-apples axis: grow lead-in/out at fixed ds=0.5 (one out-of-band
// loop in the middle). Flat σmax(∂F/∂P) and cond(JᵀJ) ⇒ the integral ill-
// conditioning (force-space σ_pos~N^1.56) is GONE.

console.log("=== 1. conditioning vs TRACK LENGTH (fixed ds=0.5) ===");
console.log("   N    L_lead   σmax(∂F/∂P)   cond(JᵀJ)");
const lenRows: { n: number; sigF: number; cond: number }[] = [];
for (const L of [3, 8, 16, 30, 50]) {
    const draft = buildDraft(0.5, L, L);
    const s = seed(draft);
    const sigF = forceJacSigmaMax(s, draft);
    const r0 = residual(s, draft);
    const { ata: A } = normalEqs(jacCols(s, draft, r0), r0);
    const cond = condEst(A);
    lenRows.push({ n: draft.count, sigF, cond });
    console.log(
        `${String(draft.count).padStart(5)} ${L.toFixed(0).padStart(7)} ` +
            `${sigF.toExponential(3).padStart(13)} ${cond.toExponential(3).padStart(12)}`,
    );
}
const lenNs = lenRows.map((r) => r.n);
console.log(
    `slope vs N:  σmax(∂F/∂P) ~ N^${logSlope(
        lenNs,
        lenRows.map((r) => r.sigF),
    ).toFixed(2)}   cond(JᵀJ) ~ N^${logSlope(
        lenNs,
        lenRows.map((r) => r.cond),
    ).toFixed(2)}   (force-space σ_pos ~ N^1.56)\n`,
);

// ===================== 2. conditioning vs RESOLUTION (fixed length) =====================
// a SEPARATE axis: curvature is a 2nd position-difference, so ∂F/∂P ~ 1/ds².
// reported so the refinement effect is not mistaken for the N-scaling above.

console.log("=== 2. conditioning vs RESOLUTION (fixed length, shrinking ds) ===");
console.log("   N      ds     σmax(∂F/∂P)   cond(JᵀJ)");
const resRows: { n: number; ds: number; sigF: number; cond: number }[] = [];
for (const ds of [1.2, 0.9, 0.6, 0.45, 0.3]) {
    const draft = buildDraft(ds);
    const s = seed(draft);
    const sigF = forceJacSigmaMax(s, draft);
    const r0 = residual(s, draft);
    const { ata: A } = normalEqs(jacCols(s, draft, r0), r0);
    const cond = condEst(A);
    resRows.push({ n: draft.count, ds, sigF, cond });
    console.log(
        `${String(draft.count).padStart(5)} ${ds.toFixed(2).padStart(6)} ` +
            `${sigF.toExponential(3).padStart(13)} ${cond.toExponential(3).padStart(12)}`,
    );
}
console.log(
    `slope vs (1/ds):  σmax(∂F/∂P) ~ (1/ds)^${logSlope(
        resRows.map((r) => 1 / r.ds),
        resRows.map((r) => r.sigF),
    ).toFixed(2)}   cond(JᵀJ) ~ (1/ds)^${logSlope(
        resRows.map((r) => 1 / r.ds),
        resRows.map((r) => r.cond),
    ).toFixed(2)}\n`,
);

// ===================== 3. convergence (Gauss-Newton + line search) =====================
// from the draft seed at a representative resolution. each GN step is an EXACT
// banded direct solve (conditioning irrelevant to a direct solve); a backtracking
// line search handles the force/hinge nonlinearity. report the cost breakdown so
// it is clear whether the band term is actually being driven down.

console.log("=== 3. Gauss-Newton + line-search convergence (ds=0.6 loop) ===");
const draft = buildDraft(0.6);
let vars = seed(draft);
const rSeed = recover(draft.x, draft.y, draft.count, draft.v0);
const p0 = costParts(vars, draft);
console.log(`N=${draft.count}  v0=${draft.v0.toFixed(2)} m/s  vars=${vars.length}`);
console.log(
    `seed cost ${p0.total.toExponential(3)}  [shape ${(0.5 * p0.shape).toExponential(2)}  ` +
        `band ${(0.5 * p0.band).toExponential(2)}  jerk ${(0.5 * p0.jerk).toExponential(2)}  ` +
        `height ${(0.5 * p0.height).toExponential(2)}]`,
);
console.log(`iter   cost          step      band-cost     worst-oob`);

let c = cost(residual(vars, draft));
const cInit = c;
let iters = 0;
let lastStep = 1;
for (let it = 1; it <= 200; it++) {
    const r0 = residual(vars, draft);
    const cols = jacCols(vars, draft, r0);
    const { ata: A, g } = normalEqs(cols, r0);
    const n = A.length;
    for (let i = 0; i < n; i++) A[i][i] += 1e-9 * (A[i][i] + 1); // SPD floor
    const L = cholesky(A);
    const dir = cholSolve(L, g); // descent direction (subtract)

    // backtracking line search
    let alpha = 1;
    let improved = false;
    for (let bt = 0; bt < 25; bt++) {
        const trial = Float64Array.from(vars);
        for (let i = 0; i < n; i++) trial[i] -= alpha * dir[i];
        const ct = cost(residual(trial, draft));
        if (Number.isFinite(ct) && ct < c - 1e-12) {
            vars = trial;
            c = ct;
            improved = true;
            lastStep = alpha * Math.max(...Array.from(dir, Math.abs));
            break;
        }
        alpha *= 0.5;
    }
    iters = it;
    if (!improved) {
        console.log(`${String(it).padStart(4)}   line search stalled (local min reached)`);
        break;
    }
    if (it <= 6 || it % 10 === 0) {
        const p = costParts(vars, draft);
        const { x, y } = unpack(vars, draft.count);
        const F = recover(x, y, draft.count, draft.v0).fN;
        console.log(
            `${String(it).padStart(4)}   ${c.toExponential(4)}   ${lastStep.toExponential(2)}   ` +
                `${(0.5 * p.band).toExponential(3).padStart(11)}   ${oob(F).toFixed(2)}g`,
        );
    }
    if (lastStep < 1e-6) break;
}

// ===================== validation =====================
const { x: xf, y: yf } = unpack(vars, draft.count);
const recF = recover(xf, yf, draft.count, draft.v0);
const yMax = (draft.v0 * draft.v0) / (2 * G) - 1;

let finite = true;
let maxY = -Infinity;
let minVsq = Infinity;
for (let i = 0; i < draft.count; i++) {
    if (!Number.isFinite(xf[i]) || !Number.isFinite(yf[i])) finite = false;
    maxY = Math.max(maxY, yf[i]);
    minVsq = Math.min(minVsq, recF.v[i] * recF.v[i]);
}

const oobBefore = oob(rSeed.fN);
const oobAfter = oob(recF.fN);
let inBand = 0;
for (const f of recF.fN) if (f <= HI + 0.05 && f >= LO - 0.05) inBand++;

// shape drift over edges whose SEED force was already in band (the region the
// solver should leave alone — the loop itself is expected to deform).
let sse = 0;
let cnt = 0;
for (let i = 1; i < draft.count - 1; i++) {
    if (rSeed.fN[i] <= HI && rSeed.fN[i] >= LO) {
        sse += (xf[i] - draft.x[i]) ** 2 + (yf[i] - draft.y[i]) ** 2;
        cnt++;
    }
}
const shapeRms = Math.sqrt(sse / Math.max(cnt, 1));

console.log(`\n=== validation ===`);
console.log(
    `(a) converged:  ${iters} iters, cost ${cInit.toExponential(3)} → ${c.toExponential(3)}`,
);
console.log(
    `(b) band:       worst out-of-band ${oobBefore.toFixed(2)}g → ${oobAfter.toFixed(2)}g` +
        `   in-band edges ${inBand}/${draft.count - 1}   shape-match rms (in-band seed) ${shapeRms.toFixed(3)} m`,
);
console.log(
    `(c) no NaN:     finite=${finite}  maxY=${maxY.toFixed(2)}m (ceiling ${yMax.toFixed(1)}m)  min v²=${minVsq.toFixed(1)} (floor 0)`,
);

const lenFlat =
    Math.abs(
        logSlope(
            lenNs,
            lenRows.map((r) => r.cond),
        ),
    ) < 0.5;
const passB = oobAfter < oobBefore - 1 && oobAfter < HI;
const passC = finite && maxY < yMax && minVsq > 0;
console.log(
    `\nVERDICT: (cond flat vs length) ${lenFlat ? "PASS" : "FAIL"}  ` +
        `(b) honors band ${passB ? "PASS" : "FAIL"}  ` +
        `(c) no NaN / feasible ${passC ? "PASS" : "FAIL"}`,
);
