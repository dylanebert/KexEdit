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
 * **The keys are converted; the curve between them is CARRIED.** The table places every keyframe
 * exactly, but a cubic bezier authored in `(s, g)` is not a cubic bezier in `(t, g)` under a
 * nonlinear map, so the shape between keys would reshape. `carryForce` subdivides each segment until
 * the target-unit shape matches the source-unit shape inside the march's own resolution floor
 * (`resolutionFloor`: the largest |Δg| one nominal march edge carries — computed per section at
 * runtime, never stored), tags each inserted keyframe (`Force.carried`), and the reverse flip drops
 * the tagged keys rather than simplifying the denser store. Editing an inserted key clears its tag,
 * which makes it authored and keeps it.
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
import { type ForcePoint, forceProfile, resolveStep, sampleForce, type Step } from "./profile";
import { Domain } from "./section";
import { TangentMode } from "./spline";
import { arcToTime, type Mapping, timeToArc } from "./timeline";
import {
    allocForceId,
    bakeLive,
    forceNominal,
    type ForceTangent,
    minForceExtent,
    SectionKind,
    sectionInfo,
    sections,
    type SectionSnapshot,
    type SolvedForce,
    snapshotAll,
    trackDomain,
    trackDs,
    trackEntity,
} from "./track";

/** one force keyframe as the conversion carries it — the snapshot row `applyDomain` writes back,
 *  `carried` included (the provenance bit the reverse flip drops on). */
type KeySnap = SectionSnapshot["points"][number];

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

// ── the carry (§ Domain fidelity: carry the curve on flip, via tagged subdivision) ───────────
//
// A cubic bezier authored in (s, g) is NOT carried to a cubic bezier in (t, g) by the nonlinear
// arc↔time map, so a flip reshapes the authored curve BETWEEN keyframes even though every keyframe
// lands exactly. The fix is to add keys until the reshape is smaller than anything the march it
// feeds can see: each conversion-inserted key is tagged (`Force.carried`), the reverse flip DROPS
// the tagged ones instead of simplifying the denser store heuristically, and editing an inserted
// key clears its tag so it survives as authored.
//
// The tolerance is the march's own resolution floor, not a fitted band: the profile is sampled
// once per nominal march edge to drive the integrator, so no curve detail finer than one edge's
// own |Δg| is visible downstream. It is computed per section at runtime by `resolutionFloor` —
// never a stored number, since it is a property of the authored curve and of `Track.ds`.

/** the largest force step one nominal march edge carries — the derived carry tolerance.
 *
 *  The march reads the authored profile at one sample per edge (`profile.forceProfile`), so the
 *  finest g-detail it can resolve on THIS curve is the largest step between two neighbouring edge
 *  samples. A carry landing inside that bound is invisible to the integrator, to the recovered
 *  curve the chart draws, and therefore to the person. Zero on a constant profile — the honest
 *  reading, and why the acceptance test adds the store's own f32 quantum beside it.
 *
 * @example const tol = resolutionFloor(points, resolveStep(length, DS_NOMINAL)); // 0.0225 g */
export function resolutionFloor(points: readonly ForcePoint[], step: Step): number {
    const fN = forceProfile(points, step);
    let worst = 0;
    for (let i = 1; i < fN.length; i++) worst = Math.max(worst, Math.abs(fN[i] - fN[i - 1]));
    return worst;
}

/** the f32 quantum of the g store at this curve's own magnitude — added to `resolutionFloor` as
 *  the acceptance bound, since no subdivision can carry a shape finer than `Force.g` can hold. */
function storeQuantum(points: readonly ForcePoint[]): number {
    let mag = 1;
    for (const p of points) mag = Math.max(mag, Math.abs(p.g));
    return 8 * 2 ** -24 * mag;
}

/** a key mid-carry: its station in the SOURCE unit, the row that will be stored (target unit),
 *  and — for a conversion-inserted key — the target-unit slope its two handles encode. An
 *  authored key carries `slope: null`: its handles are the author's own (Δs-scaled) or derived
 *  from its easing tag, and the carry never rewrites them. */
interface Node {
    src: number;
    key: KeySnap;
    slope: number | null;
    /** the target-unit spans to this key's neighbours — what a carried key's handle reach is a
     *  third of, re-read whenever a split shortens one of them. */
    spanIn: number;
    spanOut: number;
}

/** the `profile.ForcePoint` view of a stored key — what `sampleForce`/`forceProfile` consume. */
function asPoint(key: KeySnap): ForcePoint {
    const p: ForcePoint = { s: key.s, g: key.g, ease: key.ease };
    if (key.tangent?.in) p.in = key.tangent.in;
    if (key.tangent?.out) p.out = key.tangent.out;
    return p;
}

/** the two collinear handles a conversion-inserted key carries: the source curve's own slope at
 *  that station, mapped into the target unit, reaching a third of each adjacent span. A third is
 *  the bezier's own influence unit (`profile.CUBIC_INFLUENCE`), and the pair can never over-reach
 *  its span, so `profile.segment`'s monotonicity clamp never fires on a carried key. */
function carriedTangent(slope: number, spanIn: number, spanOut: number): ForceTangent {
    const rIn = spanIn / 3;
    const rOut = spanOut / 3;
    return {
        mode: TangentMode.Aligned,
        in: { ds: -rIn, dg: -slope * rIn },
        out: { ds: rOut, dg: slope * rOut },
    };
}

/** carry an authored force curve across a domain flip by tagged subdivision.
 *
 *  `points` are the AUTHORED keys in the source unit (the caller has already dropped the previous
 *  flip's carried ones); `map` is the source→target station map plus the local `dArc/dt` there;
 *  `tol` the resolution-floor bound the shape must land inside; `edge` one nominal march edge in
 *  the source unit. Returns the target-unit key list — the converted authored keys plus the
 *  inserted ones, each tagged `carried`.
 *
 *  Every segment is measured on its own final geometry: the error is the target curve's g at the
 *  mapped station against the source curve's g at the source station, probed at march resolution.
 *  A segment over tolerance is split at its source midpoint, where the inserted key takes the
 *  source curve's value and its mapped slope, and both halves are re-measured. A **zero-span**
 *  target segment is left alone: that is the locked stall collapse (distinct times mapping onto one
 *  arclength), which carries no shape to preserve.
 *
 *  **Fail-loud at the resolution floor.** Subdivision stops at a source span of one nominal march
 *  edge — below that the march samples the segment at most once, so a finer split is unreadable by
 *  the very instrument the tolerance is derived from. What happens at that floor splits on the
 *  derivation's own premise, read off the probes: the resolution-floor tolerance assumes the map is
 *  itself resolved by the march grid, and the residual it then leaves is `tol · O(Δv/v)` over the
 *  segment. So a floor segment whose own speed swing is a factor of two or more (`MAP_UNRESOLVED`)
 *  is the locked stall degeneracy rather than a fit failure — the map is not a map at this
 *  resolution, the tolerance says nothing there, and the residual is accepted exactly as the stall
 *  collapse is. Below that swing the premise holds, so a partial fit is a contradiction in the
 *  derivation rather than a budget to spend quietly: it throws, and the whole conversion writes
 *  nothing (`convertDomain` is a pure transform landed in one entry). The reachable class is a map
 *  whose nonlinearity hides BETWEEN the probes — which is why nothing silent is safe here. */
export function carryForce(
    points: readonly KeySnap[],
    map: (s: number) => Converted,
    target: Domain,
    tol: number,
    edge: number,
): KeySnap[] {
    const source = points.map(asPoint);
    const bound = tol + storeQuantum(source);
    const nodes: Node[] = points.map((key) => {
        const { value, slope } = map(key.s);
        // an explicit handle's Δs rides the axis: dt/ds = 1/v to time, ds/dt = v back.
        const scale = target === Domain.Time ? 1 / slope : slope;
        return {
            src: key.s,
            key: { ...key, s: value, tangent: scaleHandles(key.tangent, scale) },
            slope: null,
            spanIn: 0,
            spanOut: 0,
        };
    });
    if (nodes.length < 2) return nodes.map((n) => n.key);

    const inserted: Node[] = [];
    const pending: [Node, Node][] = [];
    for (let i = 0; i + 1 < nodes.length; i++) pending.push([nodes[i], nodes[i + 1]]);

    while (pending.length > 0) {
        const [a, b] = pending.pop() as [Node, Node];
        const span = b.src - a.src;
        if (span <= EPS || b.key.s - a.key.s <= EPS) continue; // a coincident pair or a stall collapse
        const seg = [asPoint(a.key), asPoint(b.key)];
        // probe at march resolution, and at least `PROBES_MIN` times however short the segment is.
        const probe = Math.min(span / PROBES_MIN, edge);
        let worst = 0;
        // the map's own speed range over the segment, ENDPOINTS INCLUDED: the stall onset lands on a
        // boundary interval, so an interior-only reading sees one constant slope and calls a
        // 170× jump resolved (measured, on a re-carried store whose extent drifted into a stall).
        let vLo = Math.min(map(a.src).slope, map(b.src).slope);
        let vHi = Math.max(map(a.src).slope, map(b.src).slope);
        for (let s = a.src + probe; s < b.src - EPS; s += probe) {
            const at = map(s);
            vLo = Math.min(vLo, at.slope);
            vHi = Math.max(vHi, at.slope);
            worst = Math.max(worst, Math.abs(sampleForce(seg, at.value) - sampleForce(source, s)));
        }
        if (worst <= bound) continue;
        if (span <= edge) {
            // the two map degeneracies, both outside what the resolution floor claims: a frozen cart
            // (`V_FLOOR` is the resolution of a stall, not a speed) and a speed that swings by
            // `MAP_UNRESOLVED` inside one march edge.
            if (vLo <= V_FLOOR || vHi >= MAP_UNRESOLVED * vLo) continue;
            throw new Error(
                `carryForce: partial fit at the march resolution floor — |Δg| ${worst} > ${bound} over a ${span} span (one nominal edge is ${edge}, speed swing ${vHi / vLo})`,
            );
        }
        const mid = a.src + span / 2;
        const at = map(mid);
        const slope =
            curveSlope(source, mid, span / 2) * (target === Domain.Time ? at.slope : 1 / at.slope);
        const m: Node = {
            src: mid,
            key: {
                id: allocForceId(),
                s: at.value,
                g: sampleForce(source, mid),
                ease: a.key.ease,
                carried: true,
            },
            slope,
            spanIn: at.value - a.key.s,
            spanOut: b.key.s - at.value,
        };
        fitPair(a, m);
        fitPair(m, b);
        inserted.push(m);
        pending.push([a, m], [m, b]);
    }

    return [...nodes, ...inserted].sort((x, y) => x.src - y.src).map((n) => n.key);
}

/** publish the span a pair now shares and re-fit whichever end is a carried key — its reach is a
 *  third of its own adjacent span, so a split shortens the sides facing it. An authored key is left
 *  alone: its handles are the author's. */
function fitPair(a: Node, b: Node): void {
    const spanT = b.key.s - a.key.s;
    a.spanOut = spanT;
    b.spanIn = spanT;
    for (const n of [a, b]) {
        if (n.slope === null) continue;
        n.key = { ...n.key, tangent: carriedTangent(n.slope, n.spanIn, n.spanOut) };
    }
}

/** the source curve's own dg/du at `s`, by central difference. `reach` is the distance to the
 *  nearer neighbouring key, so the probe stays strictly inside the bracketing segment where the
 *  curve is smooth (a key station is where the slope may jump). */
function curveSlope(points: readonly ForcePoint[], s: number, reach: number): number {
    const h = Math.max(reach * 1e-3, EPS);
    return (sampleForce(points, s + h) - sampleForce(points, s - h)) / (2 * h);
}

/** the minimum number of probe intervals across a measured segment, for one shorter than a few
 *  march edges: a cubic's worst deviation is interior, so two probes cannot see it and five
 *  bracket it. Longer segments probe at march resolution instead, which is denser. */
const PROBES_MIN = 5;

/** the speed ratio across one floor-span segment at which the arc↔time map stops being resolved by
 *  the march grid at all — a factor of two, i.e. the map's own first-order term is as large as the
 *  map. That is the regime of a stall and its approach (`V_FLOOR` makes a stopped cart's edges cost
 *  `ds/V_FLOOR` each), where the resolution-floor tolerance's premise is void, so its residual is
 *  the stall's own lossiness — already locked, already lossy in both directions — rather than a
 *  carry defect. Structural, not tuned: at a ratio below this the residual is bounded by the
 *  tolerance times the swing itself. */
const MAP_UNRESOLVED = 2;
const EPS = 1e-12;

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
 * **The authored curve is CARRIED across the flip, not merely re-addressed.** Every keyframe lands
 * exactly where the table says it should — the conversion IS that table, so a converted position is
 * only ever a lookup — but a cubic bezier authored in `(s, g)` is not carried to a cubic bezier in
 * `(t, g)` by this nonlinear arc↔time map, so the curve BETWEEN keys would reshape (measured before
 * this carry: 0.0497 g on a 40 m dive-and-recover, 2.2× what the march can resolve). `carryForce`
 * closes that: the segment is subdivided until the target-unit shape matches the source-unit shape
 * inside the march's own resolution floor, the inserted keys are tagged, and the reverse flip drops
 * them. The Δs scale on an explicit handle is the map's first-order term, which the carry then
 * completes.
 *
 * What still moves is the section's baked WORLD exit — a flip is two independent marches of one
 * authored ride, and the two disagree at equal elapsed time by a ride-dependent amount (0.20 m on
 * that same section, inside the 0.25 m two-bakes bound the round trip derives). That is the marches
 * disagreeing, not the curve reshaping, and it is unaffected by the carry.
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
    // the source unit's own nominal march edge — the resolution the tolerance is derived at, and
    // the span the carry's fail-loud floor sits on.
    const sourceNominal = forceNominal(trackDomain(ecs), trackDs(ecs));
    const converted: SectionSnapshot[] = snaps.map((snap) => {
        const w = windows.get(snap.id);
        if (!w) return snap;
        // the previous flip's inserted keys are dropped rather than re-carried: the authored set is
        // what the target unit's own subdivision is computed from.
        const authored = snap.points.filter((p) => !p.carried);
        const step = resolveStep(snap.length, sourceNominal);
        const tol = resolutionFloor(authored.map(asPoint), step);
        return {
            ...snap,
            length: Math.max(floor, at(m, w, snap.length).value),
            points: carryForce(authored, (s) => at(m, w, s), target, tol, step.ds),
            // a strip's `start`/`end` are positions on the same axis a keyframe's `s` is —
            // each endpoint converts independently through the section's own window, same as a
            // keyframe. `value` (m/s) is domain-independent and rides through unconverted.
            strips: snap.strips.map((st) => ({
                ...st,
                start: at(m, w, st.start).value,
                end: at(m, w, st.end).value,
            })),
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
