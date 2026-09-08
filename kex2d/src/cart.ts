import type { Plugin, State, System } from "@dylanebert/shallot";
import { arcToTime, type Mapping, timeToArc } from "./timeline";
import { cumulativeArclength } from "./stats";
import { bakeOut, samples, Track } from "./track";

/** per-track cart state. `held` picks which of two owners drives the clock:
 *  - **playing** (`held` false): `t` (cumulative time, mod loopTime) advances and IS
 *    the truth; `parkS` is ignored.
 *  - **parked** (`held` true): the truth is the ABSOLUTE ARCLENGTH `parkS`, and `t` is
 *    *derived* from it through the current bake on every re-bake (live during a drag),
 *    so a re-time slides the ride under a stationary playhead, not the reverse.
 *
 *  `parkS` is absolute arclength on the ruler and nothing else. It used to be a content anchor
 *  `{section, offset}` glued to a DERIVED run — and a derived run is not content: its id is the
 *  opening record's or synthetic (`projection.ts`), so a body drag on the record that opens it
 *  carried the playhead along with it (parked at 10 m, the geo record moved [0, 20) → [3, 23),
 *  the playhead read 13 m; probed 2026-09-07, the person's check-in two point 8). The ruler is
 *  the park's frame, the same frame every record's `start` is authored in.
 *
 *  `lastClock` is the last wall-clock the advance loop saw; `parkHash` is the `bakeOut` hash `t`
 *  was last derived against, so a static park skips the per-frame re-derive; `resume` is the
 *  playing state a gesture hold captured, restored on release ({@link holdForGesture}).
 *  plain Map — purely transient, not canonical bake state, so it lives outside ECS. */
interface CartState {
    t: number;
    lastClock: number;
    held: boolean;
    parkS: number;
    parkHash: string;
    resume: boolean;
}
export const cartState = new Map<number, CartState>();

const clamp = (x: number, lo: number, hi: number): number => Math.min(Math.max(x, lo), hi);

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

export const CartSystem: System = {
    update(ecs: State): void {
        const now = performance.now();
        for (const trackEid of ecs.query([Track])) {
            let st = cartState.get(trackEid);
            if (!st) {
                st = { t: 0, lastClock: now, held: false, parkS: 0, parkHash: "", resume: false };
                cartState.set(trackEid, st);
                continue;
            }
            const dt = Math.min(MAX_DT, (now - st.lastClock) / 1000);
            st.lastClock = now; // refresh even when held, so release doesn't replay the gap
            const out = bakeOut.get(trackEid);
            if (!out || Track.count.get(trackEid) < 2) continue;
            if (st.held) {
                // parked: the ruler station owns the clock. re-derive `t` from `parkS`
                // only when the bake changed (a span drag, a re-time), so a static
                // park doesn't rebuild the mapping every frame.
                if (st.parkHash !== out.hash) applyPark(trackEid, st, out);
                continue;
            }
            // playing — the cart rides the baked track, paced by its recovered velocity.
            const loopT = loopTime(out);
            if (loopT <= 0) {
                st.t = 0;
                continue;
            }
            st.t = (st.t + dt) % loopT;
        }
    },
};

type BakeOut = NonNullable<ReturnType<typeof bakeOut.get>>;

/** derive the parked cart time from its ruler station through the current bake, and record the
 *  hash it derived against. The station is clamped into the bake's own extent — a shortened track
 *  pulls the playhead back to its end rather than leaving it past the last sample — and the clamp
 *  is written BACK to `parkS`, so the park is the place the cart actually sits and a later
 *  lengthening does not teleport it forward to a station it was never left at. Used by the
 *  per-frame re-derive and by every gesture that captures a park. */
function applyPark(eid: number, st: CartState, out: BakeOut): void {
    st.parkHash = out.hash; // mark this bake handled even if there's nothing to derive to
    const m = trackMapping(eid);
    if (!m) return;
    const s = clamp(st.parkS, 0, m.arc[m.n - 1] ?? 0);
    st.parkS = s;
    st.t = clamp(arcToTime(m, s), 0, out.tTotal);
}

/** park the cart at an absolute arclength — the ruler scrub, native to the chart's distance
 *  axis, and the one write that names the park's truth. */
export function parkAtArc(ecs: State, eid: number, cumS: number): void {
    const st = cartState.get(eid);
    const out = bakeOut.get(eid);
    if (!st || !out) return;
    void ecs;
    st.parkS = cumS;
    applyPark(eid, st, out);
}

/** capture the park station from the cart's current time — for a gesture that works in time (the
 *  player slider, Space-pause): project `t` → absolute arclength. */
export function parkFromTime(ecs: State, eid: number): void {
    const st = cartState.get(eid);
    const out = bakeOut.get(eid);
    const m = trackMapping(eid);
    if (!st || !out || !m) return;
    void ecs;
    st.parkS = timeToArc(m, st.t);
    applyPark(eid, st, out);
}

/** hold the cart at its own ruler station for the duration of one authoring gesture, remembering
 *  whether it was playing. A live span or end gesture must not re-time the ride under itself: the
 *  cart boots PLAYING (`CartSystem` mints `held: false`) and a playing cart is time-truth, so a
 *  velocity drag moved it in arclength while the person watched (one `t` read 20.09 m before and
 *  18.30 m after; probed 2026-09-07). This is `editor-ui.md`'s "time is frozen-per-gesture
 *  projection", and it is the player slider's own `sliderResume` pattern, hoisted here so every
 *  gesture shares one. Idempotent: a second hold inside one gesture keeps the FIRST capture, so a
 *  nested open can't record `held: true` as the state to resume to. */
export function holdForGesture(eid: number): void {
    const st = cartState.get(eid);
    const out = bakeOut.get(eid);
    if (!st || !out) return;
    if (st.held) return; // already parked — its own station is already the truth
    const m = trackMapping(eid);
    st.resume = true; // it was playing, so the release resumes it
    if (m) st.parkS = timeToArc(m, st.t);
    st.held = true;
    applyPark(eid, st, out);
}

/** release a gesture's hold, restoring the playing state {@link holdForGesture} captured. A cart
 *  that was already parked when the gesture opened stays parked (`resume` was never set), so a
 *  scrub-then-drag never starts playback the person didn't ask for. */
export function releaseGesture(eid: number): void {
    const st = cartState.get(eid);
    if (!st) return;
    if (st.resume) st.held = false;
    st.resume = false;
}

/** the cart's current arclength on the bake — its `t` projected onto the distance axis.
 *  the capture flow reads this to assert a parked playhead holds its track position
 *  under a re-timing edit. null below the two-node floor. */
export function cartArc(eid: number): number | null {
    const st = cartState.get(eid);
    const m = trackMapping(eid);
    if (!st || !m) return null;
    return timeToArc(m, st.t);
}

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

/** the baked F_n force curve as per-sample points over arclength — the timeline's
 *  x-axis is distance, so the curve is read natively (no time resample):
 *  `s[i]` is sample i's cumulative arclength (Σ ds), `f[i]` its force. the per-edge
 *  `fN` (length count−1) carries force at its leading sample, so the last sample
 *  repeats the last edge's value to reach the track end. null before the bake has a
 *  chain. */
export function forceCurve(
    trackEid: number,
): { s: Float64Array; f: Float32Array; n: number } | null {
    const out = bakeOut.get(trackEid);
    const count = Track.count.get(trackEid);
    if (!out || count < 2) return null;
    const s = cumulativeArclength(out.ds, count);
    const f = new Float32Array(count);
    for (let i = 0; i < count; i++) f[i] = out.fN[Math.min(i, count - 2)];
    return { s, f, n: count };
}

/** the baked recovered-speed curve as per-sample points over arclength — `forceCurve`'s
 *  twin, same shape: `s[i]` is sample i's cumulative arclength (Σ ds, the ds-convention
 *  law), `v[i]` its speed. Unlike `fN` (per-edge), `v` is already per-sample (`bakeOut.v`,
 *  `ChainResult.v` threaded through `chain()`), so no leading-sample repeat is needed.
 *  Always-inferred, never authored — the timeline draws it dashed unconditionally, no
 *  toggle (`editor-ui.md` Mode vocabulary). null before the bake has a chain. */
export function velocityCurve(
    trackEid: number,
): { s: Float64Array; v: Float32Array; n: number } | null {
    const out = bakeOut.get(trackEid);
    const count = Track.count.get(trackEid);
    if (!out || count < 2) return null;
    const s = cumulativeArclength(out.ds, count);
    return { s, v: out.v.subarray(0, count), n: count };
}

/** the per-sample arclength↔time table over the display bake (`samples` +
 *  `bakeOut`, the realized track the timeline draws). the chart's x-axis is
 *  distance, but the cart rides the track in time, so the playhead projects the
 *  cart's `t` to a chart s through this, and a ruler scrub maps the picked s back
 *  to a cart `t`. null below the two-node floor. */
export function trackMapping(trackEid: number): Mapping | null {
    const s = samples.get(trackEid);
    const out = bakeOut.get(trackEid);
    if (!s || !out) return null;
    const n = Track.count.get(trackEid);
    if (n < 2) return null;
    // `cumulativeArclength` sums the bake's OWN per-edge ds, never a chord re-derive: the two
    // agree to f32 rounding on a normal chain, but the downstream freeze's seam is a
    // zero-length gap EDGE over a real position jump (track.ts, stage 7) — a chord walk would
    // offset every downstream park from the chart's own axis (`forceCurve`/`sectionSpans` both
    // sum `out.ds`) by the residual gap.
    const arc = cumulativeArclength(out.ds, n);
    const t = new Float64Array(n);
    for (let i = 0; i < n; i++) t[i] = out.t[i];
    return { arc, t, n };
}

export const CartPlugin: Plugin = {
    name: "Cart",
    systems: [CartSystem],
};
