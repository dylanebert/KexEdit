import { expect, test } from "bun:test";
import { forces } from "../src/bake";
import {
    bandedSolve,
    collocate,
    DEFAULT_BAND,
    DEFAULT_PIN_WEIGHT,
    forceLocal,
    forces64,
} from "../src/collocate";

const G = 9.80665;

// The position-space collocation solver (roadmap "kex2d Phase 3"). Physics is
// gated against `bake.forces` (the shipped force recovery), not solver
// self-consistency.

/** a smooth non-trivial test curve: a hill sampled with mild along-track drift so
 *  chords vary. */
function hill(n: number): { x: Float64Array; y: Float64Array } {
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const u = i / (n - 1);
        x[i] = 30 * u + 0.4 * Math.sin(3 * u);
        y[i] = 2.5 * Math.sin(Math.PI * u);
    }
    return { x, y };
}

/** the lab's failing case: a vertical loop (heading sweeps 2π) whose own bottom
 *  force ≈ 11 g leaves the band, feasible at the top (v0² > 4gR). */
function loop(ds: number): { x: Float64Array; y: Float64Array; n: number; v0: number } {
    const R = 6;
    const Lin = 6;
    const Lout = 6;
    const v0 = Math.sqrt(10 * G * R);
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
    return { x: Float64Array.from(xs), y: Float64Array.from(ys), n: xs.length, v0 };
}

const worstOob = (fN: Float64Array, band = DEFAULT_BAND) => {
    let m = 0;
    for (const f of fN) m = Math.max(m, f - band[1], band[0] - f);
    return m;
};

test("forces64 mirrors bake.forces (the shipped f32 recovery)", () => {
    const n = 40;
    const { x, y } = hill(n);
    const v0 = 12;
    const got = forces64(x, y, n, v0);

    // reference: the shipped bake, given the same per-edge chords.
    const px = Float32Array.from(x);
    const py = Float32Array.from(y);
    const theta = new Float32Array(n);
    const v = new Float32Array(n);
    const fN = new Float32Array(n - 1);
    const ds = new Float32Array(n - 1);
    for (let k = 0; k < n - 1; k++) ds[k] = Math.hypot(x[k + 1] - x[k], y[k + 1] - y[k]);
    forces(px, py, theta, v, fN, ds, 0, n - 1, v0);

    for (let k = 0; k < n - 1; k++) expect(got.fN[k]).toBeCloseTo(fN[k], 3);
    for (let i = 0; i < n; i++) expect(got.theta[i]).toBeCloseTo(theta[i], 3);
    for (let i = 0; i < n; i++) expect(got.v[i]).toBeCloseTo(v[i], 3);
});

test("forceLocal is value-identical to forces64.fN at every edge", () => {
    // the locality contract: the per-edge FD in the solver reads only local
    // positions, and must match the global recovery exactly (a 2π offset cancels).
    const n = 50;
    const { x, y } = hill(n);
    const v0 = 12;
    const full = forces64(x, y, n, v0).fN;
    for (let k = 0; k < n - 1; k++) expect(forceLocal(x, y, n, k, v0)).toBeCloseTo(full[k], 9);
});

test("bandedSolve matches a dense solve on a banded SPD system", () => {
    const n = 20;
    const bw = 7;
    // a diagonally-dominant symmetric banded matrix (SPD).
    const A = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
        for (let j = Math.max(0, i - bw); j <= i; j++) {
            const val = i === j ? 5 + i * 0.1 : Math.sin(i * 1.3 + j) * 0.3;
            A[i * n + j] = val;
            A[j * n + i] = val;
        }
    }
    const b = new Float64Array(n);
    for (let i = 0; i < n; i++) b[i] = Math.cos(i);

    const xBand = bandedSolve(Float64Array.from(A), Float64Array.from(b), n, bw);

    // dense reference: A x = b via Gaussian elimination.
    const M = Float64Array.from(A);
    const rhs = Float64Array.from(b);
    for (let c = 0; c < n; c++) {
        let piv = c;
        for (let r = c + 1; r < n; r++)
            if (Math.abs(M[r * n + c]) > Math.abs(M[piv * n + c])) piv = r;
        if (piv !== c)
            for (let j = 0; j < n; j++) {
                [M[c * n + j], M[piv * n + j]] = [M[piv * n + j], M[c * n + j]];
            }
        [rhs[c], rhs[piv]] = [rhs[piv], rhs[c]];
        for (let r = c + 1; r < n; r++) {
            const f = M[r * n + c] / M[c * n + c];
            for (let j = c; j < n; j++) M[r * n + j] -= f * M[c * n + j];
            rhs[r] -= f * rhs[c];
        }
    }
    const xDense = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
        let s = rhs[i];
        for (let j = i + 1; j < n; j++) s -= M[i * n + j] * xDense[j];
        xDense[i] = s / M[i * n + i];
    }
    for (let i = 0; i < n; i++) expect(xBand[i]).toBeCloseTo(xDense[i], 8);
});

test("a flat draft solves to a flat track at ≈1 g", () => {
    const n = 64;
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = i * 0.5;
    const { x: sx, y: sy } = collocate(x, y, n, 10);
    for (let i = 0; i < n; i++) {
        expect(sy[i]).toBeCloseTo(0, 3);
        expect(sx[i]).toBeCloseTo(x[i], 3);
    }
    const fN = forces64(sx, sy, n, 10).fN;
    for (const f of fN) expect(f).toBeCloseTo(1, 3);
});

test("an in-band hill draft is matched (shape identity, near no-op)", () => {
    // when the draft is already feasible and in-band, the solver must leave it
    // essentially untouched — the shape term is the only active one, so the solved
    // geometry coincides with the draft rather than drifting or over-smoothing.
    const n = 80;
    const v0 = 20; // fast enough that the gentle hill stays inside the band
    const { x, y } = hill(n);
    const before = forces64(x, y, n, v0).fN;
    expect(worstOob(before)).toBeLessThan(0.5);

    const { x: sx, y: sy, iters } = collocate(x, y, n, v0);
    expect(iters).toBeLessThan(200);

    let drift = 0;
    for (let i = 0; i < n; i++) drift = Math.max(drift, Math.hypot(sx[i] - x[i], sy[i] - y[i]));
    expect(drift).toBeLessThan(0.1);
});

test("the loop draft honors the band, matches the shape away from it, never NaNs", () => {
    // the exact failing case that spiraled the F_n solver to NaN. position-space
    // collocation reshapes the out-of-band loop to honor the band while holding
    // the lead-in/out, and the linear height bound keeps v² ≥ 0 throughout.
    const { x, y, n, v0 } = loop(0.6);
    const before = forces64(x, y, n, v0).fN;
    expect(worstOob(before)).toBeGreaterThan(3); // the draft is badly out of band

    const { x: sx, y: sy } = collocate(x, y, n, v0);
    const after = forces64(sx, sy, n, v0).fN;

    // (a)+(b): the band is honored where feasible (worst violation collapses).
    expect(worstOob(after)).toBeLessThan(worstOob(before) - 1);
    expect(worstOob(after)).toBeLessThan(0.3);

    // (c): finite everywhere and height held under the energy ceiling — the linear
    // height bound is what makes the spiral-to-NaN structurally impossible.
    const yMax = (v0 * v0) / (2 * G);
    for (let i = 0; i < n; i++) {
        expect(Number.isFinite(sx[i]) && Number.isFinite(sy[i])).toBe(true);
        expect(sy[i]).toBeLessThan(yMax);
    }

    // shape held on the flat lead-in (the first samples, force in band at seed).
    for (let i = 0; i < 5; i++) expect(Math.hypot(sx[i] - x[i], sy[i] - y[i])).toBeLessThan(0.5);
});

test("an authored force pin pulls the derived force toward its value", () => {
    const n = 80;
    const v0 = 20;
    const { x, y } = hill(n);
    const base = forces64(x, y, n, v0).fN;
    const k = 40;
    const target = base[k] + 1.2; // off the draft, inside the band

    const { x: sx, y: sy } = collocate(x, y, n, v0, {
        targets: [{ index: k, value: target, weight: DEFAULT_PIN_WEIGHT }],
    });
    const got = forceLocal(sx, sy, n, k, v0);
    expect(Math.abs(got - target)).toBeLessThan(0.25);
    expect(Math.abs(got - target)).toBeLessThan(Math.abs(base[k] - target) / 3);
});
