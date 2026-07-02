import { f32, sparse, type State, u32 } from "@dylanebert/shallot";

/** authored force constraints — the solver's demand side. a `Pin` is authored
 *  state (spec `kex/specs/kex2d-unified-solver.md`, Locked decision §4): it
 *  lives at a fixed anchor in the track domain and the solver satisfies it
 *  where it is; when the shape resizes, moving it is the author's cheap
 *  gesture, never the solver's variable. */

/** a force pin on a track. `sigma` is the arclength anchor in meters from
 *  the track start — it survives re-grids exactly (grid index = round(σ/ds))
 *  and only drifts semantically when upstream track physically lengthens,
 *  which the residual readout surfaces. `f` is the target normal force (g);
 *  `w` the dimensionless weight (force is already in g — Betts scaling
 *  leaves pins unit-weighted by tolerance). `width` (m) is the target
 *  interval the pin covers: a single-sample pin produces a one-sample force
 *  spike (the solver's honest optimum — Stage-2 finding), so a pin demands
 *  its force over a short interval. `id` is the stable authored identity
 *  undo/redo addresses (eids recycle across a delete→undo; ids never do —
 *  the `Handle.order` convention). */
export const Pin = {
    track: sparse(u32),
    id: sparse(u32),
    sigma: sparse(f32),
    f: sparse(f32),
    w: sparse(f32),
    width: sparse(f32),
};

/** an explicit position pin: hold the track point at anchor `sigma` at the
 *  world target `(x, y)` — the position analogue of a force pin, weighted in
 *  meters. authored in the viewport (positions have spatial form; gate 3). */
export const PosPin = {
    track: sparse(u32),
    id: sparse(u32),
    sigma: sparse(f32),
    x: sparse(f32),
    y: sparse(f32),
    w: sparse(f32),
};

/** stage-2 pin weight: strong preference, still soft against the AL band. */
export const W_PIN = 100;
/** position-pin weight: meters-scale residuals, same preference tier. */
export const W_POS = 100;

/** per-track force-roughness comfort weight (the authoring "smoothness"
 *  knob, spec stage 6) — absent = off. smooths the bang-bang band-riding
 *  profile at the cost of force fidelity. */
export const comfortConfig = new Map<number, number>();
/** default pin interval (m) — 3 samples at ds=0.5: enough to suppress the
 *  single-sample spike, narrow enough not to over-claim (a constant-F window
 *  is a shape demand whose compromise grows with its length — measured
 *  residual on the valley crest: 2e-4 at 1 m, 0.13 at 2 m, 0.9 at 6 m).
 *  feel-tunable per pin. */
export const PIN_WIDTH = 1;

/** per-track comfort band `lo ≤ F ≤ hi` (g). module config until it earns
 *  authoring gestures (then it promotes to authored ECS state like `Pin`). */
export const bandConfig = new Map<number, { lo: number; hi: number }>();

export interface PinRow {
    eid: number;
    id: number;
    sigma: number;
    f: number;
    w: number;
    width: number;
}

/** every pin on the track, sorted by anchor. */
export function pinsFor(ecs: State, trackEid: number): PinRow[] {
    const rows: PinRow[] = [];
    for (const eid of ecs.query([Pin])) {
        if (Pin.track.get(eid) !== trackEid) continue;
        rows.push({
            eid,
            id: Pin.id.get(eid),
            sigma: Pin.sigma.get(eid),
            f: Pin.f.get(eid),
            w: Pin.w.get(eid),
            width: Pin.width.get(eid),
        });
    }
    rows.sort((a, b) => a.sigma - b.sigma);
    return rows;
}

/** the solver rows a pin occupies: the grid indices under its width, each at
 *  the density weight `w·ds` — a pin is a short interval force target (the
 *  same ds-density semantics as the band and the stage-7 curve targets), so
 *  its demand approximates the continuum `∫ w (F−f)² dσ` over the width at
 *  any grid resolution. a zero width still claims its one center row. */
export function pinRows(
    sigma: number,
    w: number,
    width: number,
    ds: number,
    n: number,
): { i: number; w: number }[] {
    const clampRow = (i: number): number => Math.max(1, Math.min(n - 2, i));
    const lo = clampRow(Math.round((sigma - width / 2) / ds));
    const hi = clampRow(Math.round((sigma + width / 2) / ds));
    const rows: { i: number; w: number }[] = [];
    for (let i = lo; i <= hi; i++) rows.push({ i, w: w * ds });
    return rows;
}

export interface PosPinRow {
    eid: number;
    id: number;
    sigma: number;
    x: number;
    y: number;
    w: number;
}

/** every position pin on the track, sorted by anchor. */
export function posPinsFor(ecs: State, trackEid: number): PosPinRow[] {
    const rows: PosPinRow[] = [];
    for (const eid of ecs.query([PosPin])) {
        if (PosPin.track.get(eid) !== trackEid) continue;
        rows.push({
            eid,
            id: PosPin.id.get(eid),
            sigma: PosPin.sigma.get(eid),
            x: PosPin.x.get(eid),
            y: PosPin.y.get(eid),
            w: PosPin.w.get(eid),
        });
    }
    rows.sort((a, b) => a.sigma - b.sigma);
    return rows;
}

/** whether the track has any constraint demand — the identity gate: false
 *  runs the pre-solver bake path verbatim. */
export function hasConstraints(ecs: State, trackEid: number): boolean {
    if (bandConfig.has(trackEid)) return true;
    if (comfortConfig.has(trackEid)) return true;
    for (const eid of ecs.query([Pin])) {
        if (Pin.track.get(eid) === trackEid) return true;
    }
    for (const eid of ecs.query([PosPin])) {
        if (PosPin.track.get(eid) === trackEid) return true;
    }
    return false;
}

/** constraint-state hash gating the solve pass, the way `bakeHash` gates the
 *  bake: any pin add/move/re-weight/resize/delete or band/comfort change
 *  misses. */
export function constraintRev(ecs: State, trackEid: number): string {
    let rev = "";
    for (const p of pinsFor(ecs, trackEid)) rev += `|${p.sigma}:${p.f}:${p.w}:${p.width}`;
    for (const p of posPinsFor(ecs, trackEid)) rev += `|pos ${p.sigma}:${p.x}:${p.y}:${p.w}`;
    const band = bandConfig.get(trackEid);
    if (band) rev += `|band ${band.lo}:${band.hi}`;
    const comfort = comfortConfig.get(trackEid);
    if (comfort) rev += `|comfort ${comfort}`;
    return rev;
}

/** resolve a pin by its stable authored `id`, or null (the `handleAt`
 *  convention — undo/redo never holds eids). */
export function pinAt(ecs: State, id: number): number | null {
    for (const eid of ecs.query([Pin])) {
        if (Pin.id.get(eid) === id) return eid;
    }
    return null;
}

// monotone id source — never reused, even after a delete: history can
// re-spawn any deleted id, so a scan-the-live-set allocator would alias a
// fresh pin with a restorable one (the eid-recycling bug, one level up).
let nextPinId = 0;

/** re-create a pin verbatim at an exact id/anchor/target — undo of a delete,
 *  redo of an add. returns the new eid. */
export function spawnPin(
    ecs: State,
    id: number,
    trackEid: number,
    sigma: number,
    f: number,
    w: number,
    width: number,
): number {
    nextPinId = Math.max(nextPinId, id + 1);
    const eid = ecs.create();
    ecs.add(eid, Pin);
    Pin.track.set(eid, trackEid);
    Pin.id.set(eid, id);
    Pin.sigma.set(eid, sigma);
    Pin.f.set(eid, f);
    Pin.w.set(eid, w);
    Pin.width.set(eid, width);
    return eid;
}

/** author a force pin at arclength `sigma` (m) targeting `f` (g), assigning
 *  the next stable id. `history.ts placePin` wraps this in an undo entry.
 *  returns the pin eid. */
export function addPin(
    ecs: State,
    trackEid: number,
    sigma: number,
    f: number,
    w = W_PIN,
    width = PIN_WIDTH,
): number {
    return spawnPin(ecs, nextPinId, trackEid, sigma, f, w, width);
}

/** resolve a position pin by its stable authored `id`, or null. */
export function posPinAt(ecs: State, id: number): number | null {
    for (const eid of ecs.query([PosPin])) {
        if (PosPin.id.get(eid) === id) return eid;
    }
    return null;
}

/** re-create a position pin verbatim — undo of a delete, redo of an add.
 *  shares the monotone id space with force pins. */
export function spawnPosPin(
    ecs: State,
    id: number,
    trackEid: number,
    sigma: number,
    x: number,
    y: number,
    w: number,
): number {
    nextPinId = Math.max(nextPinId, id + 1);
    const eid = ecs.create();
    ecs.add(eid, PosPin);
    PosPin.track.set(eid, trackEid);
    PosPin.id.set(eid, id);
    PosPin.sigma.set(eid, sigma);
    PosPin.x.set(eid, x);
    PosPin.y.set(eid, y);
    PosPin.w.set(eid, w);
    return eid;
}

/** author a position pin holding anchor `sigma` at world `(x, y)`.
 *  `history.ts placePosPin` wraps this in an undo entry. */
export function addPosPin(
    ecs: State,
    trackEid: number,
    sigma: number,
    x: number,
    y: number,
    w = W_POS,
): number {
    return spawnPosPin(ecs, nextPinId, trackEid, sigma, x, y, w);
}
