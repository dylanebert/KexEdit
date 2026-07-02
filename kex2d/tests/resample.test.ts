import { describe, expect, test } from "bun:test";
import { collocateAL } from "../src/collocate";
import { forces64 } from "../src/force";
import { arcResample, fracResample, polylineLength } from "../src/resample";
import { loopTrack } from "./helpers/loop";

describe("arcResample", () => {
    test("circle: κ preserved, spacing uniform, endpoints exact", () => {
        // three-quarter circle R=8 at ds=0.5, resampled to a different m: the
        // Menger κ of the output must stay 1/R. Catmull-Rom's deviation from
        // a circular arc is O(h⁴/R³) per span (h=0.5, R=8 ⇒ ~1e-4·κ); the
        // resample reads it through κ at ~4e-3 relative — bound 1e-2.
        const R = 8;
        const ds = 0.5;
        const n = Math.round((1.5 * Math.PI * R) / ds) + 1;
        const x = new Float64Array(n);
        const y = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            const phi = (i * ds) / R;
            x[i] = R * Math.sin(phi);
            y[i] = R * (1 - Math.cos(phi));
        }
        const m = Math.round(n * 1.37);
        const ox = new Float64Array(m);
        const oy = new Float64Array(m);
        arcResample(x, y, n, ox, oy, m);

        expect(ox[0]).toBe(x[0]);
        expect(oy[0]).toBe(y[0]);
        expect(ox[m - 1]).toBe(x[n - 1]);
        expect(oy[m - 1]).toBe(y[n - 1]);

        // uniform spacing: every output chord within 1e-3 relative of the mean.
        const mean = polylineLength(ox, oy, m) / (m - 1);
        for (let i = 0; i < m - 1; i++) {
            const c = Math.hypot(ox[i + 1] - ox[i], oy[i + 1] - oy[i]);
            expect(Math.abs(c - mean) / mean).toBeLessThan(1e-3);
        }

        // Menger κ of the output stays 1/R (interior rows).
        const v0 = 30;
        const { kappa } = forces64(ox, oy, m, v0);
        for (let i = 1; i < m - 1; i++) {
            expect(Math.abs(Math.abs(kappa[i]) - 1 / R) * R).toBeLessThan(1e-2);
        }
    });

    test("no force kink across a re-grid of a solved loop", () => {
        // the production path: a Stage-2 solved (band-reshaped) loop is
        // re-gridded at rest. the force profile read back off the resampled
        // geometry must match the original at matched arclength — a linear
        // resample fails this (chord inscription reads as a κ blip). bound:
        // the interpolation reads κ error O(h²/R²)·κ plus the profile shift
        // of ½ sample; on the loop (R≥10, |F′|≤0.5 g/m measured) both land
        // under 0.05 g — the residual-readout threshold.
        const t = loopTrack(10, 0.5, 15);
        const wF = new Float64Array(t.n);
        const fTarget = new Float64Array(t.n);
        const r = collocateAL(
            {
                fTarget,
                x0: t.x,
                y0: t.y,
                ds: t.ds,
                v0: t.v0,
                wData: 0,
                terms: {
                    wF,
                    band: { lo: -1, hi: 4, w: 50 },
                    shape: { w: 0.1 },
                    chord: { w: 1 },
                },
                maxIters: 15,
            },
            { tol: 1e-3, outers: 40 },
        );
        expect(r.converged).toBe(true);

        const L = polylineLength(r.x, r.y, t.n);
        const m = Math.round(L / t.ds) + 1; // the rest re-grid target
        const ox = new Float64Array(m);
        const oy = new Float64Array(m);
        arcResample(r.x, r.y, t.n, ox, oy, m);

        // (a) position fidelity: every output point lies on the source curve.
        // CR's deviation from the underlying curve is O(ds²/R²)·ds; at
        // ds=0.5, R≥6 → ~3e-3 m. bound 0.01 m.
        for (let k = 0; k < m; k++) {
            let best = Number.POSITIVE_INFINITY;
            for (let j = 0; j < t.n - 1; j++) {
                const ex = r.x[j + 1] - r.x[j];
                const ey = r.y[j + 1] - r.y[j];
                const ee = ex * ex + ey * ey;
                let u = ee > 0 ? ((ox[k] - r.x[j]) * ex + (oy[k] - r.y[j]) * ey) / ee : 0;
                u = Math.max(0, Math.min(1, u));
                best = Math.min(
                    best,
                    Math.hypot(ox[k] - (r.x[j] + u * ex), oy[k] - (r.y[j] + u * ey)),
                );
            }
            expect(best).toBeLessThan(0.01);
        }

        // (b) no kink in smooth regions: compare F at matched ARCLENGTH
        // (solved chords vary ±8%, so index fraction is not arclength), and
        // exclude samples whose Menger stencil (±1 sample) reaches a segment
        // where the source profile itself steps (the AL band-riding
        // transition swings ~5 g in one sample; any resampling reads a
        // sub-sample phase there as O(|F′|·δs) — that's the step moving half
        // a sample, not an injected kink). smooth = |F′| ≤ 1 g/m on segments
        // j−1, j, j+1.
        const fBefore = forces64(r.x, r.y, t.n, t.v0).fN;
        const fAfter = forces64(ox, oy, m, t.v0).fN;
        const s = new Float64Array(t.n);
        for (let i = 0; i < t.n - 1; i++)
            s[i + 1] = s[i] + Math.hypot(r.x[i + 1] - r.x[i], r.y[i + 1] - r.y[i]);
        let worst = 0;
        let smooth = 0;
        let j = 0;
        for (let k = 1; k < m - 1; k++) {
            const sigma = (L * k) / (m - 1);
            while (j < t.n - 2 && s[j + 1] < sigma) j++;
            const du = s[j + 1] - s[j];
            const u = du > 0 ? (sigma - s[j]) / du : 0;
            const segSlope = (a: number): number => {
                const b = Math.max(0, Math.min(t.n - 2, a));
                return Math.abs(fBefore[b + 1] - fBefore[b]) / (s[b + 1] - s[b] || t.ds);
            };
            if (Math.max(segSlope(j - 1), segSlope(j), segSlope(j + 1)) > 1) continue;
            smooth++;
            const ref = fBefore[j] * (1 - u) + fBefore[j + 1] * u;
            worst = Math.max(worst, Math.abs(fAfter[k] - ref));
        }
        expect(smooth).toBeGreaterThan(m / 2); // the gate covers most of the track
        expect(worst).toBeLessThan(0.05);
    });

    test("length preserved and degenerate sizes pass through", () => {
        const R = 8;
        const ds = 0.5;
        const n = 40;
        const x = new Float64Array(n);
        const y = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            const phi = (i * ds) / R;
            x[i] = R * Math.sin(phi);
            y[i] = R * (1 - Math.cos(phi));
        }
        const m = 55;
        const ox = new Float64Array(m);
        const oy = new Float64Array(m);
        arcResample(x, y, n, ox, oy, m);
        // chord-arclength shortens by O(ds²/R²) relative per edge; both grids
        // inscribe, so the totals agree to that order.
        const l0 = polylineLength(x, y, n);
        const l1 = polylineLength(ox, oy, m);
        expect(Math.abs(l1 - l0) / l0).toBeLessThan((ds / R) ** 2);

        // n = 2 passthrough: a straight segment resamples exactly.
        const sx = Float64Array.from([0, 10]);
        const sy = Float64Array.from([0, 5]);
        const px = new Float64Array(4);
        const py = new Float64Array(4);
        arcResample(sx, sy, 2, px, py, 4);
        for (let k = 0; k < 4; k++) {
            expect(px[k]).toBeCloseTo((10 * k) / 3, 12);
            expect(py[k]).toBeCloseTo((5 * k) / 3, 12);
        }
    });
});

describe("fracResample", () => {
    test("exact on a linear ramp, any size pair", () => {
        for (const [n, m] of [
            [10, 17],
            [17, 10],
            [5, 5],
        ] as const) {
            const src = new Float64Array(n);
            for (let i = 0; i < n; i++) src[i] = 3 + 2 * (i / (n - 1));
            const out = new Float64Array(m);
            fracResample(src, n, out, m);
            for (let k = 0; k < m; k++) {
                expect(out[k]).toBeCloseTo(3 + 2 * (k / (m - 1)), 12);
            }
        }
    });
});
