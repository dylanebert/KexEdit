/** The track-global domain conversion, as an editor command — the ONE place a force section's
 * stored numbers change unit.
 *
 * `Track.domain` says what unit every force keyframe's `s` and every force section's extent are
 * stored in (meters of section-local arclength, or seconds of section-local time). The ruler-menu
 * pick is therefore not a view change: it is a **document conversion op**, one history entry
 * that flips the domain and rewrites the whole store through the live bake's arc↔time table. That
 * is what makes editing in the time domain time-CONSTRAINED — a keyframe's stored t is its position by
 * construction, so no edit anywhere can slide it.
 *
 * **The table is the conversion.** `cart.trackMapping` is the per-sample arclength↔time table over
 * the display bake; `track.sectionInfo` gives each section its sample range in it. A section's own
 * window of that table — entry/exit distance and time, plus its first and last interval's speed —
 * is everything a conversion needs: an interior position interpolates the table, and one past the
 * section's baked span extrapolates at THAT section's own boundary speed. Nothing here re-derives
 * the physics.
 *
 * **Per-section windows, not one track-wide clamp.** A keyframe can sit past its own section's span
 * (a trimmed extent keeps its keyframes; a truncated chain bakes a prefix) while other sections
 * continue downstream. Converting it against the track's end would run it through the downstream
 * sections' speeds — a different ride. It extrapolates on its own section's exit speed instead, and
 * the same speed serves both directions, so the extrapolated branch round-trips exactly as an
 * interior one does.
 *
 * **No live bake, no conversion.** The table only exists for a bake that IS the authored state
 * (`track.bakeLive`), so the op rejects and writes nothing otherwise — the invoking surface grays
 * the row on the same reading.
 *
 * **The document is touched once.** The conversion is a pure transform of the whole-track snapshot;
 * `history.landDomain` applies the result in a single `restoreAll` and records the entry. So a
 * conversion that throws part-way writes nothing, and there is no partial state to roll back.
 *
 * Solves stay distance-internal (`refine.ts` / `geofit.ts` work in arclength). No per-section
 * baking step is stored (`kex2d-correctness-fixes` stage 4/5): a solved section's step was
 * always `resolveStep(length, nominal)` by construction, so nothing here needs releasing one on
 * a flip. */

import type { State } from "@dylanebert/shallot";
import { V_FLOOR } from "./bake";
import { trackMapping } from "./cart";
import { type History, landDomain } from "./history";
import { Domain } from "./section";
import { arcToTime, type Mapping, timeToArc } from "./timeline";
import {
    bakeLive,
    type ForceTangent,
    minForceExtent,
    SectionKind,
    sectionInfo,
    sections,
    type SectionSnapshot,
    type SolvedForce,
    snapshotAll,
    trackDomain,
    trackEntity,
} from "./track";

/** one section's window on the arc↔time table: where it starts and ends on each axis, and the
 *  speed its first and last baked interval carry — the boundary speeds a past-span position
 *  extrapolates on. Read straight off the table at the section's own sample indices, so the
 *  entry/exit values are exact stations rather than interpolations. */
interface Window {
    entryD: number;
    exitD: number;
    entryT: number;
    exitT: number;
    entryV: number;
    exitV: number;
}

/** the speed (`dArc/dt`) the table carries over interval `i`.
 *
 *  This is the interval's own v̄, which `track.computeTime` already floors at `V_FLOOR` wherever it
 *  DERIVES the time — so the `max` here resolves exactly one case: a frozen cart, where `ds` is
 *  EXACTLY 0 (a stalled time-domain march, `ds_i = v_i·Δt` with `v_i == 0`). Resolving it at the
 *  same `V_FLOOR` both directions agree on is what keeps positions past a stall distinct — a bare 0
 *  slope collapses every one of them onto the stall point. */
function slopeOf(m: Mapping, i: number): number {
    const dt = m.t[i + 1] - m.t[i];
    return Math.max(dt > 0 ? (m.arc[i + 1] - m.arc[i]) / dt : 0, V_FLOOR);
}

/** the interval bracketing global distance `d`. Searched over the whole table, not the owning
 *  section's slice: speed is continuous across a section boundary by construction (C0/C1 join), so
 *  a boundary value's own interval and its neighbour's agree to within the bake's noise. What must
 *  be the section's own is the BOUNDARY speed a past-span position extrapolates on, and `Window`
 *  reads those by sample index rather than by search. */
function intervalAt(m: Mapping, d: number): number {
    let lo = 0;
    let hi = m.n - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (m.arc[mid] <= d) lo = mid;
        else hi = mid;
    }
    return Math.min(lo, m.n - 2);
}

/** a force section's window, or null when it isn't on the current bake.
 *
 *  The finiteness check is not a formality: the flat SoA is capped at `MAX_SAMPLES`, and a chain
 *  that overruns it still reports its would-be sample count, so a section placed past the cap gets
 *  a `sectionInfo` range addressing samples that were never written — the table reads NaN there.
 *  Rejecting on that is what keeps a NaN out of the store (it would poison every keyframe in the
 *  section); the ruler menu grays the row on the same reading. */
function windowOf(m: Mapping, sectionId: number): Window | null {
    const info = sectionInfo.get(sectionId);
    if (!info) return null;
    const start = info.startSample;
    const end = Math.min(info.endSample, m.n - 1);
    if (end <= start) return null; // no baked edge — nothing to convert through
    const w = {
        entryD: m.arc[start],
        exitD: m.arc[end],
        entryT: m.t[start],
        exitT: m.t[end],
        entryV: slopeOf(m, start),
        exitV: slopeOf(m, end - 1),
    };
    return Object.values(w).every(Number.isFinite) ? w : null;
}

/** a converted position plus the local slope there — the pair a keyframe, an extent, and a handle
 *  Δ all read. Both directions share the window's boundary speeds, so their past-span branches are
 *  exact inverses of each other. */
interface Converted {
    value: number;
    slope: number;
}

/** section-local arclength → section-local time.
 *
 *  The two boundaries return the window's own stations instead of interpolating to them. That is
 *  not a shortcut: `interpMono` resolves a tie to the LAST tied index, so a position landing
 *  exactly on the exit would read through a stall plateau that reaches past the section's exit
 *  sample (a frozen cart is a fixed point, so the section downstream is frozen too) and absorb
 *  that whole stall into this section's duration. The boundary slopes match the past-span
 *  branches for the same reason — a frozen interval's own slope is the `V_FLOOR` resolution,
 *  which is the entry/exit speed the window already carries. */
function toTime(m: Mapping, w: Window, s: number): Converted {
    const d = w.entryD + s;
    if (d > w.exitD) return { value: w.exitT - w.entryT + (d - w.exitD) / w.exitV, slope: w.exitV };
    if (d < w.entryD) return { value: (d - w.entryD) / w.entryV, slope: w.entryV };
    if (d === w.exitD) return { value: w.exitT - w.entryT, slope: w.exitV };
    if (d === w.entryD) return { value: 0, slope: w.entryV };
    return {
        value: arcToTime(m, d) - w.entryT,
        slope: slopeOf(m, intervalAt(m, d)),
    };
}

/** section-local time → section-local arclength, `toTime`'s inverse — stations included, so the
 *  two are exact inverses at both boundaries. The time axis carries no plateau of its own (a
 *  derived `dt = ds/v̄` vanishes only where `ds` does, so a t-tie is an arc-tie), so here the
 *  station return is the structural guarantee rather than a fix for absorption. */
function toDist(m: Mapping, w: Window, t: number): Converted {
    const dur = w.exitT - w.entryT;
    if (t > dur) return { value: w.exitD - w.entryD + (t - dur) * w.exitV, slope: w.exitV };
    if (t < 0) return { value: t * w.entryV, slope: w.entryV };
    if (t === dur) return { value: w.exitD - w.entryD, slope: w.exitV };
    if (t === 0) return { value: 0, slope: w.entryV };
    const d = timeToArc(m, w.entryT + t);
    return { value: d - w.entryD, slope: slopeOf(m, intervalAt(m, d)) };
}

/** scale an explicit handle pair's Δs; Δg and the mode are unit-relative and pass through. */
function scaleHandles(tan: ForceTangent | undefined, scale: number): ForceTangent | undefined {
    if (!tan) return undefined;
    const out: ForceTangent = { mode: tan.mode };
    if (tan.in) out.in = { ds: tan.in.ds * scale, dg: tan.in.dg };
    if (tan.out) out.out = { ds: tan.out.ds * scale, dg: tan.out.dg };
    return out;
}

/** the live table plus every force section's window on it, or null when the store cannot be
 *  converted right now: no live bake, no table, or a force section that isn't on the bake (a
 *  trimmed chain, a `MAX_SAMPLES` truncation). Resolving every window BEFORE anything converts is
 *  what makes the op atomic — a section missing from the bake rejects the whole conversion rather
 *  than passing through in the wrong unit — and it is the same reading the ruler menu grays its
 *  inactive row on, so the menu can never offer a pick that would silently no-op. */
function resolve(ecs: State): { m: Mapping; windows: Map<number, Window> } | null {
    if (!bakeLive(ecs)) return null;
    const trackEid = trackEntity(ecs);
    if (trackEid === null) return null;
    const m = trackMapping(trackEid);
    if (!m) return null;
    const windows = new Map<number, Window>();
    for (const sec of sections(ecs)) {
        if (sec.kind !== SectionKind.Force) continue;
        const w = windowOf(m, sec.id);
        if (!w) return null;
        windows.set(sec.id, w);
    }
    return { m, windows };
}

/** whether `convertDomain` can run at all: a live bake, a table, and every force section on it.
 *
 * @example if (!convertible(ecs)) return; // nothing to convert through
 */
export function convertible(ecs: State): boolean {
    return resolve(ecs) !== null;
}

/** whether the ruler menu's row for `target` is enabled — the ONE enablement rule, pure and
 *  unit-tested (`editor-ui.md`: enablement is a predicate, not a per-menu special case).
 *
 *  The ACTIVE row is always enabled: picking it is a no-op by the menu law, and graying the row
 *  that says what the chart already reads would read as a fault. Every other row is the one that
 *  would CONVERT, so it's enabled exactly when the conversion can run and grays otherwise
 *  (`editor-ui.md`'s "gray a row whose preconditions fail") — an unbaked or truncated track shows
 *  the pick as blocked instead of offering a row that writes nothing.
 *
 * @example { label: "Seconds", enabled: pickable(ecs, Domain.Time) }
 */
export function pickable(ecs: State, target: Domain): boolean {
    return trackDomain(ecs) === target || convertible(ecs);
}

/** flip the track-global domain and convert the whole force store into the target unit, as ONE
 * undoable entry: every force keyframe's position, every force section's extent, and every explicit
 * easing handle's Δs (scaled by the local slope `dt/ds = 1/v` at its keyframe). Geo sections pass
 * through untouched — they are position-authored in either domain.
 *
 * Returns false, having written nothing and recorded nothing, when the target domain is already
 * active (the ruler menu's active row is a no-op) or when `convertible` reads false. Otherwise
 * returns true.
 *
 * A round trip (Meters → Seconds → Meters) is **never** bit-identical, and how close it lands is a
 * property of the ride, not of this op. The conversion itself is an exact inverse — both directions
 * interpolate the same piecewise-linear table — but flipping re-bakes each force section under the
 * other march (`Δt = trackDs/V0` where the distance bake used `Δs = trackDs` — the two readings of
 * the one `track.forceNominal` seam), so the flip back
 * converts through a table that moved. The drift is exactly the two marches' disagreement at equal
 * time: sub-quantum on a gentle ride (measured 0.12 m over a 40 m dive-and-recover section), but
 * tens of percent on a ride whose θ/v system is sensitive — a sustained multi-g pull. A stall is
 * lossier still, and by construction: the cart doesn't move, so every keyframe inside a stalled
 * stretch converts to the SAME arclength. Undo is the byte-identical way back, and the only one.
 *
 * **A SINGLE flip moves the exit too, by the same mechanism and inside the same bound.** Every
 * keyframe lands exactly where the table says it should — the conversion IS that table, so a
 * converted position is only ever a lookup. What moves is the authored curve BETWEEN keys: a cubic
 * bezier authored in `(s, g)` is not carried to a cubic bezier in `(t, g)` by this nonlinear
 * arc↔time map, so the segment genuinely reshapes across a flip, by an amount growing with segment
 * span and with the map's curvature over that span. The Δs scale on an explicit handle above is
 * only the map's first-order correction to that reshape, not a full carry of it. Measured on a
 * 40 m dive-and-recover section (`tests/domain.test.ts`'s "single flip" suite): the exit moves
 * 0.20 m, and the two-bakes-at-equal-time disagreement this same section's round trip already
 * derives bounds it at 0.25 m — the flip is two independent marches of one authored ride, landing
 * inside a bound the round trip already accepts, not a defect of its own.
 *
 * @example convertDomain(history, ecs, Domain.Time) // → true, one undo entry
 */
export function convertDomain(h: History, ecs: State, target: Domain): boolean {
    if (trackDomain(ecs) === target) return false;
    const res = resolve(ecs);
    if (!res) return false;
    const { m, windows } = res;
    const snaps = snapshotAll(ecs);
    const at = target === Domain.Time ? toTime : toDist;
    const floor = minForceExtent(target);
    const converted: SectionSnapshot[] = snaps.map((snap) => {
        const w = windows.get(snap.id);
        if (!w) return snap;
        return {
            ...snap,
            length: Math.max(floor, at(m, w, snap.length).value),
            points: snap.points.map((p) => {
                const { value, slope } = at(m, w, p.s);
                // an explicit handle's Δs rides the axis: dt/ds = 1/v to time, ds/dt = v back.
                const scale = target === Domain.Time ? 1 / slope : slope;
                return { ...p, s: value, tangent: scaleHandles(p.tangent, scale) };
            }),
        };
    });

    landDomain(h, ecs, target, converted);
    return true;
}

/** convert an invoked solve's distance-internal output into the track's active domain — the
 * landing seam `geoforce.convertGeo` passes its answer through, the same conversion the ruler
 * pick applies to the whole store.
 *
 * Solves run in meters (`refine.ts` / `geofit.ts` work in arclength, and their goldens are frozen
 * there), so a landing into a `Time`-domain track would otherwise write meters into a seconds
 * store. It converts through the section's OWN window on the live table — the section is still
 * the geo shape the solve reproduced, so its arc↔time window IS the ride the answer describes.
 *
 * A `Distance`-domain track gets `solved` back by identity, with no bake required — the landing
 * path there is byte-identical to before this seam existed. Returns null, having computed
 * nothing, when there is no live table or the section isn't on it; the caller drops the answer
 * rather than landing it in the wrong unit.
 *
 * @example const landed = convertSolve(ecs, sectionId, result) ?? throwStale()
 */
export function convertSolve(
    ecs: State,
    sectionId: number,
    solved: SolvedForce,
): SolvedForce | null {
    if (trackDomain(ecs) !== Domain.Time) return solved;
    const trackEid = trackEntity(ecs);
    if (trackEid === null) return null;
    const m = trackMapping(trackEid);
    if (!m) return null;
    const w = windowOf(m, sectionId);
    if (!w) return null;
    return {
        points: solved.points.map((p) => ({ s: toTime(m, w, p.s).value, g: p.g })),
        length: Math.max(minForceExtent(Domain.Time), toTime(m, w, solved.length).value),
    };
}
