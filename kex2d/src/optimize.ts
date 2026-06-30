import type { Plugin, State, System } from "@dylanebert/shallot";
import { recoveryRows } from "./anchor";
import { replay, resampleByTime, V_FLOOR, V_WARN } from "./bake";
import { pinRev, pinsOf } from "./pins";
import {
    type Anchor,
    DEFAULT_ANCHOR_WEIGHT,
    DEFAULT_BAND,
    DEFAULT_BAND_WEIGHT,
    DEFAULT_PIN_WEIGHT,
    DEFAULT_SMOOTH,
    type PointCon,
    solve,
} from "./solve";
import { bakeOut, samples, Track } from "./track";

/** draft-time DOF resolution for the solved force / realized track. matches the
 *  timeline so the solved line and the baked dots share an x-axis. */
export const OPT_GRID = 256;

/** the realized (ridden) track: the convex F_n optimizer solved on the draft-time
 *  grid, then forward-integrated from the draft's launch. this is what the cart
 *  rides — `forward(solved F_n)` — distinct from the dotted position draft it
 *  peels off. `fN` is the solved force on the draft-time grid (the timeline line);
 *  `posX`/`posY`/`theta`/`v` are the realized per-sample state; `t` is the
 *  realized cumulative time (the cart's own pacing, from the realized velocity,
 *  not the draft's); `firstInfeasible` is the first realized sample below V_WARN
 *  (-1 if none). `gate` is the bake hash plus the pin revision — a miss (the bake
 *  moved or a pin changed) re-solves. */
export const solveOut = new Map<
    number,
    {
        count: number;
        fN: Float32Array;
        posX: Float32Array;
        posY: Float32Array;
        theta: Float32Array;
        v: Float32Array;
        t: Float32Array;
        tTotal: number;
        firstInfeasible: number;
        gate: string;
    }
>();

function computeSolve(trackEid: number): void {
    const out = bakeOut.get(trackEid);
    const s = samples.get(trackEid);
    if (!out || !s) return;
    const count = Track.count.get(trackEid);
    if (count < 2 || out.tTotal <= 0) {
        solveOut.delete(trackEid);
        return;
    }
    const N = OPT_GRID;

    // the position-draft prior: baked F_n resampled onto the uniform draft-time
    // grid — the optimizer's DOF (same resample as the timeline's draft dots).
    const prior = resampleByTime(out.fN, out.t, count, N, out.tTotal);

    // each draft-time grid point owns the draft arclength interval to the next;
    // riding the solved force over those intervals is the realized geometry. σ is
    // the per-sample arclength (prefix sum of per-edge ds). built before the solve
    // because the recovery anchor linearizes the ride about the draft over it.
    const sigma = new Float64Array(count);
    for (let i = 1; i < count; i++) sigma[i] = sigma[i - 1] + out.ds[i - 1];
    const dsGrid = new Float32Array(N - 1);
    let cur = 0;
    let sigPrev = 0;
    for (let g = 0; g < N - 1; g++) {
        const tau = ((g + 1) / (N - 1)) * out.tTotal;
        while (cur < count - 2 && out.t[cur + 1] < tau) cur++;
        const denom = out.t[cur + 1] - out.t[cur];
        const a = denom > 1e-9 ? (tau - out.t[cur]) / denom : 0;
        const sig = sigma[cur] + a * (sigma[cur + 1] - sigma[cur]);
        dsGrid[g] = Math.max(sig - sigPrev, 0);
        sigPrev = sig;
    }

    // authored force pins → point constraints + one endpoint recovery anchor.
    // with no pins the solve is byte-identical to the unconstrained path (con +
    // anchors stay empty). a pin pulls the solved F_n toward its value at a fixed
    // grid index; the unbalanced bump swings the whole downstream geometry, so the
    // anchor pins the rollout's (x, y, θ) at the endpoint back to the draft — three
    // DOF at one point fix the rigid downstream transform, healing the full tail.
    // single-shoot endpoint anchoring is the prototype regime (multiple-shooting
    // is the deferred scale fix; see scratch.md "Optimizer design").
    const pins = pinsOf(trackEid);
    let con: PointCon[] | undefined;
    let anchors: Anchor[] | undefined;
    if (pins.length > 0) {
        con = pins.map((p) => ({
            index: Math.min(Math.max(p.index, 0), N - 1),
            value: p.value,
            weight: DEFAULT_PIN_WEIGHT,
        }));
        // the draft rollout is the anchor's linearization point.
        const dX = new Float32Array(N);
        const dY = new Float32Array(N);
        const dT = new Float32Array(N);
        const dV = new Float32Array(N);
        replay(dX, dY, dT, dV, prior, dsGrid, s.posX[0], s.posY[0], s.theta[0], s.v[0], N);
        const rows = recoveryRows(Float64Array.from(dT), Float64Array.from(dV), dsGrid, N - 1);
        anchors = [
            { row: rows.x, weight: DEFAULT_ANCHOR_WEIGHT },
            { row: rows.y, weight: DEFAULT_ANCHOR_WEIGHT },
            { row: rows.theta, weight: DEFAULT_ANCHOR_WEIGHT },
        ];
    }

    const { fN } = solve(prior, {
        smooth: DEFAULT_SMOOTH,
        band: DEFAULT_BAND,
        bandWeight: DEFAULT_BAND_WEIGHT,
        con,
        anchors,
    });

    const posX = new Float32Array(N);
    const posY = new Float32Array(N);
    const theta = new Float32Array(N);
    const v = new Float32Array(N);
    replay(posX, posY, theta, v, fN, dsGrid, s.posX[0], s.posY[0], s.theta[0], s.v[0], N);

    // realized cumulative time + feasibility, over the realized velocity profile
    // (mirrors track.ts computeTime but on the ridden track, not the draft).
    const t = new Float32Array(N);
    let firstInfeasible = Math.abs(v[0]) >= V_WARN ? -1 : 0;
    for (let g = 0; g < N - 1; g++) {
        const vA = Math.max(Math.abs(v[g]), V_FLOOR);
        const vB = Math.max(Math.abs(v[g + 1]), V_FLOOR);
        t[g + 1] = t[g] + dsGrid[g] / (0.5 * (vA + vB));
        if (firstInfeasible < 0 && Math.abs(v[g + 1]) < V_WARN) firstInfeasible = g + 1;
    }

    solveOut.set(trackEid, {
        count: N,
        fN,
        posX,
        posY,
        theta,
        v,
        t,
        tTotal: t[N - 1],
        firstInfeasible,
        gate: `${out.hash}|${pinRev()}`,
    });
}

/** re-solve each track's realized curve when its bake or pins change (the bake
 *  hash plus the pin revision). runs after BakeSystem, before the cart reads the
 *  result. */
export const SolveSystem: System = {
    update(ecs: State): void {
        for (const trackEid of ecs.query([Track])) {
            const out = bakeOut.get(trackEid);
            if (!out) continue;
            const cur = solveOut.get(trackEid);
            if (cur && cur.gate === `${out.hash}|${pinRev()}`) continue;
            computeSolve(trackEid);
        }
    },
};

export const OptimizePlugin: Plugin = {
    name: "Optimize",
    systems: [SolveSystem],
};
