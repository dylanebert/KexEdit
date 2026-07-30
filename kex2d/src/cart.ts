import type { Plugin, State, System } from "@dylanebert/shallot";
import { arcToTime, type Mapping, timeToArc } from "./timeline";
import { bakeOut, samples, sectionSpans, toLocal, Track } from "./track";

/** a content-anchored park position: the section (stable id) the parked playhead is
 *  glued to, and its `offset` within that section — section-local arclength (m). the
 *  park stays arclength-anchored regardless of `Track.domain`: it's a geometric feature
 *  of the ride (where on the curve the cart sits), projected onto the chart's own axis
 *  through `dToU` like any other arclength-authored subject — not a per-section-domain
 *  quantity. the parked cart is derived from this through the live bake, so an edit
 *  re-times the ride but the playhead holds its track feature. */
export interface Park {
    section: number;
    offset: number;
}

/** per-track cart state. `held` picks which of two owners drives the clock:
 *  - **playing** (`held` false): `t` (cumulative time, mod loopTime) advances and IS
 *    the truth; `park` is ignored.
 *  - **parked** (`held` true): the truth is the content anchor `park`, and `t` is
 *    *derived* from it through the current bake on every re-bake (live during a drag),
 *    so a re-time slides the ride under a stationary playhead, not the reverse.
 *  `lastClock` is the last wall-clock the advance loop saw; `parkS` is the last
 *  cumulative arclength `park` derived to (re-resolves the anchor if its section is
 *  deleted, and backs the `__kex` cart-arclength read); `parkHash` is the `bakeOut`
 *  hash `t` was last derived against, so a static park skips the per-frame re-derive.
 *  plain Map — purely transient, not canonical bake state, so it lives outside ECS. */
interface CartState {
    t: number;
    lastClock: number;
    held: boolean;
    park: Park | null;
    parkS: number;
    parkHash: string;
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
                st = { t: 0, lastClock: now, held: false, park: null, parkS: 0, parkHash: "" };
                cartState.set(trackEid, st);
                continue;
            }
            const dt = Math.min(MAX_DT, (now - st.lastClock) / 1000);
            st.lastClock = now; // refresh even when held, so release doesn't replay the gap
            const out = bakeOut.get(trackEid);
            if (!out || Track.count.get(trackEid) < 2) continue;
            if (st.held) {
                // parked: the content anchor owns the clock. re-derive `t` from `park`
                // only when the bake changed (a keyframe drag, a convert), so a static
                // park doesn't rebuild the mapping every frame.
                if (st.park && st.parkHash !== out.hash) applyPark(ecs, trackEid, st, out);
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

/** cumulative arclength (the global distance `d`) → a content anchor `{section, offset}`:
 *  the coordinate lens's `toLocal`, re-shaped into the cart's Park (offset = the local s).
 *  clamps to the track ends. null with no baked sections. */
export function resolvePark(ecs: State, eid: number, cumS: number): Park | null {
    const loc = toLocal(sectionSpans(ecs, eid), cumS);
    return loc ? { section: loc.section, offset: loc.s } : null;
}

/** the parked anchor's cumulative arclength on the current bake: its section's live
 *  span, with the offset clamped into it (a trim/convert may have shortened the section
 *  under a fixed offset — so this is the lens's `toGlobal` plus the park's own reach
 *  clamp). null when the anchor section is gone (a delete / undo-of-append) — the caller
 *  re-resolves from the last cumulative s (`parkS`). */
export function parkArc(ecs: State, eid: number, park: Park): number | null {
    const sp = sectionSpans(ecs, eid).find((x) => x.id === park.section);
    if (!sp) return null;
    return sp.offset + Math.min(park.offset, sp.len);
}

/** derive the parked cart time from its anchor through the current bake and record the
 *  cumulative s + the hash it derived against. re-resolves the anchor onto whatever
 *  section now holds `parkS` if the anchored section is gone. used by the per-frame
 *  re-derive and by every gesture that captures a park. */
function applyPark(ecs: State, eid: number, st: CartState, out: BakeOut): void {
    if (!st.park) return;
    let cumS = parkArc(ecs, eid, st.park);
    if (cumS === null) {
        st.park = resolvePark(ecs, eid, st.parkS);
        cumS = st.park ? parkArc(ecs, eid, st.park) : null;
    }
    st.parkHash = out.hash; // mark this bake handled even if there's nothing to derive to
    if (cumS === null) return;
    const m = trackMapping(eid);
    if (!m) return;
    st.t = clamp(arcToTime(m, cumS), 0, out.tTotal);
    st.parkS = cumS;
}

/** park the cart at a cumulative arclength — the ruler scrub, native to the chart's
 *  distance axis. captures the content anchor and the derived time. */
export function parkAtArc(ecs: State, eid: number, cumS: number): void {
    const st = cartState.get(eid);
    const out = bakeOut.get(eid);
    if (!st || !out) return;
    st.park = resolvePark(ecs, eid, cumS);
    st.parkS = cumS;
    applyPark(ecs, eid, st, out);
}

/** capture the park anchor from the cart's current time — for a gesture that works in
 *  time (the player slider, arrow step, Space-pause): project `t` → cumulative s →
 *  `{section, offset}`. */
export function parkFromTime(ecs: State, eid: number): void {
    const st = cartState.get(eid);
    const out = bakeOut.get(eid);
    const m = trackMapping(eid);
    if (!st || !out || !m) return;
    const cumS = timeToArc(m, st.t);
    st.park = resolvePark(ecs, eid, cumS);
    st.parkS = cumS;
    applyPark(ecs, eid, st, out);
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
    const s = new Float64Array(count);
    const f = new Float32Array(count);
    for (let i = 1; i < count; i++) s[i] = s[i - 1] + out.ds[i - 1];
    for (let i = 0; i < count; i++) f[i] = out.fN[Math.min(i, count - 2)];
    return { s, f, n: count };
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
    const arc = new Float64Array(n);
    for (let i = 1; i < n; i++)
        arc[i] = arc[i - 1] + Math.hypot(s.posX[i] - s.posX[i - 1], s.posY[i] - s.posY[i - 1]);
    const t = new Float64Array(n);
    for (let i = 0; i < n; i++) t[i] = out.t[i];
    return { arc, t, n };
}

export const CartPlugin: Plugin = {
    name: "Cart",
    systems: [CartSystem],
};
