import type { Plugin, State, System } from "@dylanebert/shallot";
import { bakeOut, samples, Track } from "./track";

/** per-track cart state: cumulative time `t` (mod tTotal) and the last
 *  wall-clock reading the advance loop saw. plain Map — purely transient,
 *  not part of the canonical bake state, so it lives outside ECS. */
export const cartState = new Map<number, { t: number; lastClock: number }>();

/** clamp per-frame Δt so a backgrounded tab returning to the foreground
 *  doesn't jump the cart by several seconds the moment focus comes back. */
const MAX_DT = 1 / 30;

/** the cart-time the loop wraps at: the moment the cart reaches the first
 *  infeasible sample — it can't proceed past red, so it resets to the start
 *  there rather than crawling the energy-depleted tail. `firstInfeasible` is the
 *  first sample below V_WARN, or -1 when the whole chain is feasible, in which
 *  case the cart loops at the full track time. */
export function loopTime(out: {
    firstInfeasible: number;
    t: Float32Array;
    tTotal: number;
}): number {
    return out.firstInfeasible >= 0 ? out.t[out.firstInfeasible] : out.tTotal;
}

const CartSystem: System = {
    update(ecs: State): void {
        const now = performance.now();
        for (const trackEid of ecs.query([Track])) {
            const out = bakeOut.get(trackEid);
            if (!out) continue;
            let st = cartState.get(trackEid);
            if (!st) {
                st = { t: 0, lastClock: now };
                cartState.set(trackEid, st);
                continue;
            }
            const dt = Math.min(MAX_DT, (now - st.lastClock) / 1000);
            st.lastClock = now;
            const loopT = loopTime(out);
            if (loopT <= 0) {
                st.t = 0;
                continue;
            }
            st.t = (st.t + dt) % loopT;
        }
    },
};

/** locate sample interval `[i, i+1]` containing time `t` on `tBuf` of length
 *  `count`. linear scan with last-index memo would be faster for the cart's
 *  monotonic progression; binary search is fine here and stays correct when
 *  the strip queries arbitrary t. */
function findInterval(tBuf: Float32Array, count: number, t: number): number {
    let lo = 0;
    let hi = count - 1;
    while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (tBuf[mid] <= t) lo = mid;
        else hi = mid;
    }
    return lo;
}

/** interpolate (x, y, θ) at cart-time `t` on the given track. linear interp
 *  on chord-mid positions matches the bake's discretization — the cart sits
 *  on the same polyline the renderer draws. */
export function cartPose(
    trackEid: number,
    t: number,
): { x: number; y: number; theta: number } | null {
    const s = samples.get(trackEid);
    const out = bakeOut.get(trackEid);
    if (!s || !out) return null;
    const count = Track.count.get(trackEid);
    if (count < 2) return null;
    const i = findInterval(out.t, count, t);
    const denom = out.t[i + 1] - out.t[i];
    const alpha = denom > 1e-9 ? (t - out.t[i]) / denom : 0;
    return {
        x: s.posX[i] + alpha * (s.posX[i + 1] - s.posX[i]),
        y: s.posY[i] + alpha * (s.posY[i + 1] - s.posY[i]),
        theta: s.theta[i] + alpha * (s.theta[i + 1] - s.theta[i]),
    };
}

/** sample F_n on a uniform time grid of `N` points. piecewise-constant
 *  reading (F_n is per-edge): grid point at time `t` returns `fN[i]` where
 *  edge `i` contains `t`. used for the time-axis strip — equal-spacing in t
 *  is what the rider experiences, not equal-spacing in arclength. */
export function sampleFNOverTime(trackEid: number, N: number): Float32Array | null {
    const out = bakeOut.get(trackEid);
    if (!out) return null;
    const count = Track.count.get(trackEid);
    if (count < 2 || out.tTotal <= 0) return null;
    const grid = new Float32Array(N);
    let cur = 0;
    for (let g = 0; g < N; g++) {
        const t = (g / Math.max(1, N - 1)) * out.tTotal;
        while (cur < count - 2 && out.t[cur + 1] < t) cur++;
        grid[g] = out.fN[cur];
    }
    return grid;
}

export const CartPlugin: Plugin = {
    name: "Cart",
    systems: [CartSystem],
};
