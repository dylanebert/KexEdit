/** node-chain refit for the relax verb (spec `kex/specs/kex2d-unified-solver.md`,
 *  stage 6): after a relax commits the solved spine as the new authored P°,
 *  the Hermite node chain must generate it again so node-dragging keeps
 *  working — the chain stays the single authored truth (one source of truth;
 *  a dense-spine override would fork it). pure and framework-free like
 *  `spline.ts`. */

import { type Node, reflect, sampleChain } from "./spline";

/** refit error tolerance (m): one worst-case viewport pixel — a chain that
 *  misses the spine by less is indistinguishable from it. */
export const REFIT_TOL = 0.15;

const MAX_SAMPLES = 4096;
const MAX_INSERT = 16;

const bufX = new Float32Array(MAX_SAMPLES);
const bufY = new Float32Array(MAX_SAMPLES);
const bufDs = new Float32Array(MAX_SAMPLES - 1);

/** point at arclength fraction `t` of the polyline, plus the local tangent
 *  angle (central difference). */
function at(
    x: Float64Array,
    y: Float64Array,
    s: Float64Array,
    n: number,
    t: number,
): { x: number; y: number; theta: number } {
    const target = t * s[n - 1];
    let j = 0;
    let hi = n - 1;
    while (hi - j > 1) {
        const mid = (j + hi) >> 1;
        if (s[mid] <= target) j = mid;
        else hi = mid;
    }
    const du = s[j + 1] - s[j];
    const u = du > 0 ? (target - s[j]) / du : 0;
    const j0 = Math.max(0, j - 1);
    const j2 = Math.min(n - 1, j + 2);
    return {
        x: x[j] + u * (x[j + 1] - x[j]),
        y: y[j] + u * (y[j + 1] - y[j]),
        theta: Math.atan2(y[j2] - y[j0], x[j2] - x[j0]),
    };
}

/** worst distance from any spine point to the chain's sampled polyline, and
 *  the spine fraction where it happens. */
function deviation(
    x: Float64Array,
    y: Float64Array,
    s: Float64Array,
    n: number,
    cx: Float32Array,
    cy: Float32Array,
    m: number,
): { max: number; frac: number } {
    let max = 0;
    let frac = 0;
    for (let i = 0; i < n; i++) {
        let best = Number.POSITIVE_INFINITY;
        for (let j = 0; j < m - 1; j++) {
            const ex = cx[j + 1] - cx[j];
            const ey = cy[j + 1] - cy[j];
            const ee = ex * ex + ey * ey;
            let u = ee > 0 ? ((x[i] - cx[j]) * ex + (y[i] - cy[j]) * ey) / ee : 0;
            u = Math.max(0, Math.min(1, u));
            best = Math.min(best, Math.hypot(x[i] - (cx[j] + u * ex), y[i] - (cy[j] + u * ey)));
        }
        if (best > max) {
            max = best;
            frac = s[i] / s[n - 1];
        }
    }
    return { max, frac };
}

/** fit a Hermite node chain to a dense spine: nodes sit ON the spine at the
 *  given arclength fractions, headings from the spine's local tangent —
 *  except the model's invariants (node 0 is the flat anchor θ=0; the last
 *  node is the circular-arc reflection of its predecessor). where the chain
 *  misses the spine by more than `tol`, a node is inserted at the worst
 *  fraction and the fit repeats (bounded). returns the node poses in chain
 *  order. */
export function refit(
    x: Float64Array,
    y: Float64Array,
    n: number,
    fracs: number[],
    dsNominal: number,
    tol = REFIT_TOL,
): Node[] {
    const s = new Float64Array(n);
    for (let i = 0; i < n - 1; i++) s[i + 1] = s[i] + Math.hypot(x[i + 1] - x[i], y[i + 1] - y[i]);

    let t = [...new Set(fracs.map((f) => Math.max(0, Math.min(1, f))))].sort((a, b) => a - b);
    if (t.length < 2 || t[0] > 1e-9 || t[t.length - 1] < 1 - 1e-9) {
        t = [0, ...t.filter((v) => v > 1e-9 && v < 1 - 1e-9), 1];
    }

    for (let round = 0; round <= MAX_INSERT; round++) {
        const nodes: Node[] = t.map((f) => at(x, y, s, n, f));
        nodes[0].theta = 0; // the flat-anchor invariant
        const last = nodes.length - 1;
        const chord = Math.atan2(
            nodes[last].y - nodes[last - 1].y,
            nodes[last].x - nodes[last - 1].x,
        );
        nodes[last].theta = reflect(nodes[last - 1].theta, chord);

        const r = sampleChain(nodes, dsNominal, bufX, bufY, bufDs, MAX_SAMPLES);
        if (r.valid) {
            const dev = deviation(x, y, s, n, bufX, bufY, r.edges + 1);
            if (dev.max <= tol || round === MAX_INSERT) return nodes;
            // insert a node at the worst miss; when that hugs an existing
            // node (the peak sits at a segment end), split the containing
            // interval at its midpoint instead.
            let f = Math.max(0.01, Math.min(0.99, dev.frac));
            if (t.some((v) => Math.abs(v - f) < 0.01)) {
                let j = 0;
                while (j < t.length - 2 && t[j + 1] <= f) j++;
                f = (t[j] + t[j + 1]) / 2;
                if (t.some((v) => Math.abs(v - f) < 0.005)) return nodes;
            }
            t = [...t, f].sort((a, b) => a - b);
        } else {
            return nodes; // degenerate sampling — hand back the best-effort fit
        }
    }
    throw new Error("unreachable");
}
