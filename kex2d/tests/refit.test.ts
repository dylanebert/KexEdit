import { describe, expect, test } from "bun:test";
import { REFIT_TOL, refit } from "../src/refit";
import { type Node, sampleChain } from "../src/spline";

const DS = 0.5;
const MAX = 4096;

function sample(nodes: Node[]): { x: Float64Array; y: Float64Array; n: number } {
    const px = new Float32Array(MAX);
    const py = new Float32Array(MAX);
    const ds = new Float32Array(MAX - 1);
    const r = sampleChain(nodes, DS, px, py, ds, MAX);
    const n = r.edges + 1;
    return { x: Float64Array.from(px.subarray(0, n)), y: Float64Array.from(py.subarray(0, n)), n };
}

function maxDev(
    ax: Float64Array,
    ay: Float64Array,
    an: number,
    bx: Float64Array,
    by: Float64Array,
    bn: number,
): number {
    let max = 0;
    for (let i = 0; i < an; i++) {
        let best = Number.POSITIVE_INFINITY;
        for (let j = 0; j < bn - 1; j++) {
            const ex = bx[j + 1] - bx[j];
            const ey = by[j + 1] - by[j];
            const ee = ex * ex + ey * ey;
            let u = ee > 0 ? ((ax[i] - bx[j]) * ex + (ay[i] - by[j]) * ey) / ee : 0;
            u = Math.max(0, Math.min(1, u));
            best = Math.min(best, Math.hypot(ax[i] - (bx[j] + u * ex), ay[i] - (by[j] + u * ey)));
        }
        max = Math.max(max, best);
    }
    return max;
}

/** cumulative-arclength fractions of each node on its own sampled chain. */
function nodeFracs(nodes: Node[]): number[] {
    const px = new Float32Array(MAX);
    const py = new Float32Array(MAX);
    const ds = new Float32Array(MAX - 1);
    const r = sampleChain(nodes, DS, px, py, ds, MAX);
    let total = 0;
    for (let i = 0; i < r.edges; i++) total += ds[i];
    const fracs: number[] = [];
    for (const off of r.offsets) {
        let acc = 0;
        for (let i = 0; i < off; i++) acc += ds[i];
        fracs.push(acc / total);
    }
    return fracs;
}

describe("refit", () => {
    test("roundtrip: a chain-generated spine refits to the same curve within tol", () => {
        // the valley-demo chain — the relax verb's real input shape.
        const nodes: Node[] = [
            { x: -60, y: 0, theta: 0 },
            { x: -20, y: -20, theta: -0.35 },
            { x: 12, y: -20, theta: 0.32 },
            { x: 40, y: -4, theta: 0.45 },
            { x: 72, y: 4, theta: 0.1 },
        ];
        const spine = sample(nodes);
        const fit = refit(spine.x, spine.y, spine.n, nodeFracs(nodes), DS);
        const refitted = sample(fit);
        expect(maxDev(spine.x, spine.y, spine.n, refitted.x, refitted.y, refitted.n)).toBeLessThan(
            REFIT_TOL,
        );
        // the flat-anchor invariant survives the fit.
        expect(fit[0].theta).toBe(0);
    });

    test("insertion: a spine the given fractions cannot hit gains nodes", () => {
        // a deep S-curve spine offered only its two endpoints: a 2-node
        // Hermite cannot follow it, so the fit must insert interior nodes to
        // reach the tolerance.
        const n = 161;
        const x = new Float64Array(n);
        const y = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            const s = (i / (n - 1)) * 80;
            x[i] = s - 40;
            y[i] = 8 * Math.sin((2 * Math.PI * s) / 40);
        }
        const fit = refit(x, y, n, [0, 1], DS);
        expect(fit.length).toBeGreaterThan(2);
        const refitted = sample(fit);
        expect(maxDev(x, y, n, refitted.x, refitted.y, refitted.n)).toBeLessThan(REFIT_TOL);
    });
});
