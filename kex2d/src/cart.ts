import type { Plugin, State, System } from "@dylanebert/shallot";
import { resampleByTime } from "./bake";
import { bakeOut, samples, Track } from "./track";

/** per-track cart state: cumulative time `t` (mod tTotal), the last wall-clock
 *  reading the advance loop saw, and `held` — set while the playhead is scrubbed
 *  or playback is paused, so the advance loop yields ownership of `t`. plain Map —
 *  purely transient, not part of the canonical bake state, so it lives outside ECS. */
export const cartState = new Map<number, { t: number; lastClock: number; held: boolean }>();

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
            let st = cartState.get(trackEid);
            if (!st) {
                st = { t: 0, lastClock: now, held: false };
                cartState.set(trackEid, st);
                continue;
            }
            const dt = Math.min(MAX_DT, (now - st.lastClock) / 1000);
            st.lastClock = now; // refresh even when held, so release doesn't replay the gap
            if (st.held) continue;
            // the cart rides the baked track, paced by its recovered velocity profile.
            const out = bakeOut.get(trackEid);
            if (!out || Track.count.get(trackEid) < 2) continue;
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
 *  the timeline queries arbitrary t. */
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

/** interpolate the cart pose at time `t` on the baked track — the authored
 *  geometry the cart rides. null until the bake has a chain. */
export function cartPose(
    trackEid: number,
    t: number,
): { x: number; y: number; theta: number } | null {
    const out = bakeOut.get(trackEid);
    const s = samples.get(trackEid);
    const count = Track.count.get(trackEid);
    if (!out || !s || count < 2) return null;
    const i = findInterval(out.t, count, t);
    const denom = out.t[i + 1] - out.t[i];
    const alpha = denom > 1e-9 ? (t - out.t[i]) / denom : 0;
    return {
        x: s.posX[i] + alpha * (s.posX[i + 1] - s.posX[i]),
        y: s.posY[i] + alpha * (s.posY[i + 1] - s.posY[i]),
        theta: s.theta[i] + alpha * (s.theta[i + 1] - s.theta[i]),
    };
}

/** sample F_n on a uniform time grid of `N` points (`resampleByTime`, linearly
 *  interpolated). used for the timeline — equal-spacing in t is what the
 *  rider experiences, not equal-spacing in arclength. */
export function sampleFNOverTime(trackEid: number, N: number): Float32Array | null {
    const out = bakeOut.get(trackEid);
    if (!out) return null;
    const count = Track.count.get(trackEid);
    if (count < 2 || out.tTotal <= 0) return null;
    return resampleByTime(out.fN, out.t, count, N, out.tTotal);
}

export const CartPlugin: Plugin = {
    name: "Cart",
    systems: [CartSystem],
};
