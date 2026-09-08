/** the authored track's STORE: three lanes of two-handle segments over one track-level end
 *  (spec `kex2d-segment-gestures` Locked decision, "a segment is one change of one parameter
 *  over one span").
 *
 *  Nothing here is a chain. The evaluator's run partition is DERIVED — `deriveRuns` reads the
 *  lanes and emits the payloads `section.chain` bakes — so the only authored state is:
 *
 *   - one {@link LaneRecord} entity per segment, in one of the three lanes;
 *   - `Track.end` (0 = follow the longest lane), `Track.order` (lane priority) and `Track.v0`
 *     (the start speed), beside the track's `ds`, `domain` and the two loss coefficients.
 *
 *  The setters below are the only authored writers, and every one of them refuses through the
 *  `lanes.ts` laws: a candidate lane is assembled, the laws the edited record introduces are
 *  read over it, and either every guard passes and the write lands or nothing is written at
 *  all. Refusals are
 *  STRUCTURAL — an overlapping edit is declined, never clamped into legality (Locked decision).
 *
 *  **Stations are f64.** A lane record's `start`/`end`/`entry`/`exit` are authored numbers on a
 *  metre ruler, not display samples, so they are stored through {@link f64} rather than the
 *  `f32` the bake's SoA publishes. A save must round-trip its own text byte-identically, and an
 *  f32 column cannot promise that for a hand-authored station. */

import {
    f32,
    type Plugin,
    sparse,
    type State,
    type System,
    type Type,
    u32,
} from "@dylanebert/shallot";
import { V_FLOOR, V_WARN } from "./bake";
import {
    entryValue,
    Lane,
    type LaneSegment,
    type Lanes,
    endPinnable,
    laneOrder,
    ordered,
    RECORD_FLOOR,
    trackEnd,
} from "./lanes";
import {
    type Easing,
    type ForcePoint,
    forceProfile,
    resolveStep,
    sampleForce,
    type Step,
} from "./profile";
import { DEFAULT_ORDER, type DerivedRun, deriveRuns } from "./projection";
import {
    chain,
    Domain,
    type Entry,
    type Section as SectionSpec,
    SectionKind,
    type Strip as StripSpec,
} from "./section";

/** the kind enum is defined with the substrate that gives it meaning (`section.ts`); it is
 *  re-exported here because a derived run's kind is what every ECS-side consumer reaches for. */
export { SectionKind } from "./section";

/** a 64-bit float field.
 *
 *  `sparse`'s scalar storage is a `Map<number, number>` holding the JS number verbatim — a
 *  stride-1 field never allocates its `ctor` — so this descriptor is the honest NAME for a
 *  column that must not round to f32, and `wgsl: null` says it has no GPU mirror to round it
 *  later. `tests/track.test.ts` pins the claim on a station f32 cannot represent. */
const f64 = {
    ctor: Float64Array,
    lanes: 1,
    name: "f64",
    wgsl: null,
} as unknown as Type<Float32Array> & { readonly lanes: 1 };

/** per-track scalars.
 *
 *  `count` is the published sample count of the whole bake. `ds` is the nominal target spacing
 *  every run resolves its own step from. `domain` is the track-global display lens
 *  (`section.Domain`) — a VIEW, never a second storage unit, so it stays out of the bake hash.
 *  `friction`/`resistance` are the two loss coefficients threaded to `forward.loss`.
 *
 *  Three columns are the authored track-level state the lanes do not carry:
 *
 *   - `end` — the authored track end in metres. `0` means FOLLOW: the end is the longest lane's
 *     last exit, Animate's own rule (`lanes.trackEnd`).
 *   - `order` — the lane priority, packed as `top*16 + mid*4 + bottom` over {@link Lane} values.
 *     `0` is not a permutation, so it reads as ABSENT and the default `[Geo, Force, Velocity]`
 *     governs (`projection.DEFAULT_ORDER`).
 *   - `v0` — the start speed (m/s) the bake's march is seeded with. `0` reads as absent and
 *     falls back to {@link V0}. */
export const Track = {
    count: sparse(u32),
    ds: sparse(f32),
    domain: sparse(u32),
    friction: sparse(f32),
    resistance: sparse(f32),
    end: sparse(f64),
    order: sparse(u32),
    v0: sparse(f64),
};

/** one authored segment: a `[start, end)` span in one lane with two handles and an easing
 *  between them (`lanes.LaneSegment`, the pure record this column set stores).
 *
 *  `id` is the stable identity undo, the wire and every setter address a record by — never an
 *  eid, which recycles. `hasEntry` is 0 when the record owns no entry handle, in which case
 *  `entry` is unread and the entry law resolves it (`lanes.entryValue`). */
export const LaneRecord = {
    lane: sparse(u32),
    id: sparse(u32),
    start: sparse(f64),
    end: sparse(f64),
    ease: sparse(u32),
    hasEntry: sparse(u32),
    entry: sparse(f64),
    exit: sparse(f64),
};

/** a refusal a setter declines on — the same `{guard, message}` shape `lanes.laneRefusals` and
 *  `doc.checkDocInvariants` speak, so one vocabulary covers the document boundary and the live
 *  setters (spec S2e-i punch list item 2). */
export interface LaneRefusal {
    guard: string;
    message: string;
}

// monotone record-id source — never reused, even after a delete: history re-spawns deleted
// records, so a scan-the-live-set allocator would alias a fresh record with a restorable one.
let nextRecordId = 0;

/** raise the id floor above every id a loaded document already used, so a `createRecord` right
 *  after a load cannot collide with one. */
export function reserveIds(ids: { record?: Iterable<number> }): void {
    for (const id of ids.record ?? []) nextRecordId = Math.max(nextRecordId, id + 1);
}

/** allocate a fresh stable record id. */
export function allocRecordId(): number {
    return nextRecordId++;
}

// ── the store ────────────────────────────────────────────────────────────────

/** the entity carrying record `id`, or null. */
export function recordAt(ecs: State, id: number): number | null {
    for (const eid of ecs.query([LaneRecord])) if (LaneRecord.id.get(eid) === id) return eid;
    return null;
}

/** one entity's record, as the pure `LaneSegment` every law reads. */
function rowOf(eid: number): LaneSegment {
    const entry = LaneRecord.hasEntry.get(eid) === 1 ? LaneRecord.entry.get(eid) : undefined;
    return {
        id: LaneRecord.id.get(eid),
        start: LaneRecord.start.get(eid),
        end: LaneRecord.end.get(eid),
        ease: LaneRecord.ease.get(eid),
        ...(entry === undefined ? {} : { entry }),
        exit: LaneRecord.exit.get(eid),
    };
}

/** one record and the lane it lives in, addressed by stable id — the read every gesture opens
 *  on (`history.ts` snapshots the row, writes through the setters, restores the row). */
export function recordOf(ecs: State, id: number): { lane: Lane; row: LaneSegment } | undefined {
    const eid = recordAt(ecs, id);
    if (eid === null) return undefined;
    return { lane: LaneRecord.lane.get(eid) as Lane, row: rowOf(eid) };
}

/** one lane's records, in span order (`lanes.ordered`). */
export function laneRows(ecs: State, lane: Lane): LaneSegment[] {
    const rows: LaneSegment[] = [];
    for (const eid of ecs.query([LaneRecord]))
        if (LaneRecord.lane.get(eid) === lane) rows.push(rowOf(eid));
    return ordered(rows);
}

/** the whole authored track as the pure lane substrate — the ONE projection from the ECS onto
 *  `lanes.Lanes`, so the bake, the save and `deriveRuns` all read the same rows. */
export function lanesOf(ecs: State): Lanes {
    return {
        velocity: laneRows(ecs, Lane.Velocity),
        force: laneRows(ecs, Lane.Force),
        geo: laneRows(ecs, Lane.Geo),
    };
}

/** the track's authored `end` column (0 = follow), raw. {@link trackEndOf} resolves it. */
export function endColumn(ecs: State): number {
    const t = trackEntity(ecs);
    return t === null ? 0 : Track.end.get(t);
}

/** the track's resolved end station (m) — the pinned value, or the longest lane's last exit. */
export function trackEndOf(ecs: State): number {
    return trackEnd(lanesOf(ecs), endColumn(ecs));
}

/** the track's authored `order` column (0 = absent, the default governs), raw. {@link laneOrderOf}
 *  resolves it; the gestures snapshot THIS, so undoing a swap restores absence rather than
 *  writing the default out as an explicit permutation. */
export function orderColumn(ecs: State): number {
    const t = trackEntity(ecs);
    return t === null ? 0 : Track.order.get(t);
}

/** the track's lane priority, top to bottom — the default when the column is absent or is not
 *  a permutation. */
export function laneOrderOf(ecs: State): Lane[] {
    const t = trackEntity(ecs);
    const packed = t === null ? 0 : Track.order.get(t);
    if (packed === 0) return [...DEFAULT_ORDER];
    return laneOrder([(packed >> 4) & 3, (packed >> 2) & 3, packed & 3]) ?? [...DEFAULT_ORDER];
}

/** pack a lane order into the `Track.order` column's one u32. */
function packOrder(order: readonly Lane[]): number {
    return (order[0]! << 4) | (order[1]! << 2) | order[2]!;
}

/** the track's start speed (m/s) — the authored `v0` column, or {@link V0} when absent. */
export function entrySpeed(ecs: State): number {
    const t = trackEntity(ecs);
    const v = t === null ? 0 : Track.v0.get(t);
    return v > 0 ? v : V0;
}

// ── the setters — the only authored writers ──────────────────────────────────
//
// Every one assembles the CANDIDATE lane and reads the laws the EDITED record introduces over
// it, writing only when that record is clean. Structural refusal, never a clamp.

function laneNameOf(lane: Lane): string {
    return lane === Lane.Velocity ? "velocity" : lane === Lane.Force ? "force" : "geo";
}

/** every law the EDITED record introduces into `candidate` — its own span (degenerate, or under
 *  the record floor) and the overlaps it itself takes part in. The one gate every setter passes
 *  through.
 *
 *  Scoped to the edited record on purpose (spec S2f punch list item 1): a setter refuses what
 *  the gesture introduces, never a violation the document already carried. Reading the WHOLE
 *  candidate lane instead froze every span edit on a lane holding a legal-but-sub-floor record
 *  — `force/sub-min-spacing.kex` loads legally, because the record floor is a setter law and
 *  not a document one, and then refused moving record 2 for record 1's floor, a violation the
 *  gesture neither made nor could clear. The laws themselves are unchanged and stay the
 *  `lanes.ts` vocabulary (`segmentDegenerate`, `segmentOverlapped`); only their subject
 *  narrows. A duplicate id is not read here — ids are unique across the whole document, not per
 *  lane, so `createRecord` refuses that one against the live document itself. */
function refuse(lane: Lane, candidate: readonly LaneSegment[], edited: number): LaneRefusal[] {
    const row = candidate.find((r) => r.id === edited);
    // a delete introduces nothing: the candidate is the lane minus one record, and every law
    // here is a law about a record that is present.
    if (!row) return [];
    const name = laneNameOf(lane);
    const out: LaneRefusal[] = [];
    if (!(row.start < row.end))
        out.push({
            guard: "segmentDegenerate",
            message: `${name} segment ${row.id} spans [${row.start}, ${row.end}), which is not a positive half-open span`,
        });
    else if (row.end - row.start < RECORD_FLOOR)
        out.push({
            guard: "segmentDegenerate",
            message: `${name} segment ${row.id} spans ${row.end - row.start} m, below the ${RECORD_FLOOR} m record floor`,
        });
    for (const other of ordered(candidate)) {
        if (other.id === edited) continue;
        if (other.start < row.end && row.start < other.end)
            out.push({
                guard: "segmentOverlapped",
                message: `${name} segment ${row.id} [${row.start}, ${row.end}) overlaps segment ${other.id} [${other.start}, ${other.end})`,
            });
    }
    return out;
}

/** the candidate lane produced by replacing (or adding, or dropping) one record. */
function candidateOf(
    rows: readonly LaneSegment[],
    id: number,
    next: LaneSegment | undefined,
): LaneSegment[] {
    const out = rows.filter((r) => r.id !== id);
    if (next) out.push(next);
    return out;
}

/** write one record's columns onto `eid`. */
function writeRow(eid: number, lane: Lane, row: LaneSegment): void {
    LaneRecord.lane.set(eid, lane);
    LaneRecord.id.set(eid, row.id);
    LaneRecord.start.set(eid, row.start);
    LaneRecord.end.set(eid, row.end);
    LaneRecord.ease.set(eid, row.ease);
    LaneRecord.hasEntry.set(eid, row.entry === undefined ? 0 : 1);
    LaneRecord.entry.set(eid, row.entry ?? 0);
    LaneRecord.exit.set(eid, row.exit);
}

/** the outcome of a setter: the record's id on a landed write, or the refusals that declined
 *  it. Never both, and never a partial write. */
export type LaneWrite = { id: number; refusals: [] } | { id: null; refusals: LaneRefusal[] };

const landed = (id: number): LaneWrite => ({ id, refusals: [] });
const declined = (refusals: LaneRefusal[]): LaneWrite => ({ id: null, refusals });

/** author a new record in `lane`. `id` is allocated unless the caller supplies one (a restore
 *  respawning a deleted record keeps its identity). */
export function createRecord(
    ecs: State,
    lane: Lane,
    row: Omit<LaneSegment, "id"> & { id?: number },
): LaneWrite {
    const id = row.id ?? allocRecordId();
    const next: LaneSegment = { ...row, id };
    // ids are unique across the WHOLE document, not per lane, so the collision check cannot go
    // through the candidate lane — `candidateOf` drops the row it is replacing, which is exactly
    // the row a create must refuse to shadow.
    if (recordAt(ecs, id) !== null)
        return declined([
            { guard: "duplicateId", message: `a lane record already holds id ${id}` },
        ]);
    const refusals = refuse(lane, candidateOf(laneRows(ecs, lane), id, next), id);
    if (refusals.length > 0) return declined(refusals);
    const eid = ecs.create();
    ecs.add(eid, LaneRecord);
    writeRow(eid, lane, next);
    nextRecordId = Math.max(nextRecordId, id + 1);
    return landed(id);
}

/** move or resize one record's span. */
export function setRecordSpan(ecs: State, id: number, start: number, end: number): LaneWrite {
    const eid = recordAt(ecs, id);
    if (eid === null) return declined([{ guard: "recordNotFound", message: `no record ${id}` }]);
    const lane = LaneRecord.lane.get(eid) as Lane;
    const next = { ...rowOf(eid), start, end };
    const refusals = refuse(lane, candidateOf(laneRows(ecs, lane), id, next), id);
    if (refusals.length > 0) return declined(refusals);
    writeRow(eid, lane, next);
    return landed(id);
}

/** write one of a record's two handles. `entry` with `undefined` DISOWNS the entry handle, which
 *  is a real authoring outcome (the record then reads its predecessor's exit or the lane's
 *  inferred value, `lanes.entryValue`) and not a missing value. */
export function setRecordHandle(
    ecs: State,
    id: number,
    which: "entry" | "exit",
    value: number | undefined,
): LaneWrite {
    const eid = recordAt(ecs, id);
    if (eid === null) return declined([{ guard: "recordNotFound", message: `no record ${id}` }]);
    const lane = LaneRecord.lane.get(eid) as Lane;
    const row = rowOf(eid);
    if (which === "exit") {
        if (value === undefined || !Number.isFinite(value))
            return declined([
                { guard: "validHandle", message: `record ${id}'s exit must be a finite number` },
            ]);
        writeRow(eid, lane, { ...row, exit: value });
        return landed(id);
    }
    if (value !== undefined && !Number.isFinite(value))
        return declined([
            { guard: "validHandle", message: `record ${id}'s entry must be a finite number` },
        ]);
    const next: LaneSegment = { ...row };
    if (value === undefined) delete next.entry;
    else next.entry = value;
    writeRow(eid, lane, next);
    return landed(id);
}

/** write one record's easing tag. */
export function setRecordEase(ecs: State, id: number, ease: Easing): LaneWrite {
    const eid = recordAt(ecs, id);
    if (eid === null) return declined([{ guard: "recordNotFound", message: `no record ${id}` }]);
    writeRow(eid, LaneRecord.lane.get(eid) as Lane, { ...rowOf(eid), ease });
    return landed(id);
}

/** delete one record. Returns true when one was there. */
export function deleteRecord(ecs: State, id: number): boolean {
    const eid = recordAt(ecs, id);
    if (eid === null) return false;
    ecs.destroy(eid);
    return true;
}

/** pin (or unpin, with 0) the track's end. Refuses any pin below a lane's content — the end
 *  handle never drops frames out from under a span (`lanes.endPinnable`). */
export function setEnd(ecs: State, end: number): LaneRefusal[] {
    const t = trackEntity(ecs);
    if (t === null) return [{ guard: "noTrack", message: "no track to set an end on" }];
    if (!endPinnable(lanesOf(ecs), end))
        return [
            {
                guard: "endBelowContent",
                message: `an end at ${end} m sits below the track's own content (${trackEnd(lanesOf(ecs), 0)} m)`,
            },
        ];
    Track.end.set(t, end);
    return [];
}

/** write the lane priority, or CLEAR it with `null` — the order's own follow rule, mirroring
 *  `setEnd(0)`: a cleared column means the default `[Geo, Force, Velocity]` governs and nothing
 *  is authored, which is not the same document as the default written out explicitly. Refuses
 *  anything that is not a permutation of the three lanes (`lanes.laneOrder`) — a partial order
 *  silently leaves one lane unranked. */
export function setOrder(ecs: State, order: readonly number[] | null): LaneRefusal[] {
    const t = trackEntity(ecs);
    if (t === null) return [{ guard: "noTrack", message: "no track to order" }];
    if (order === null) {
        Track.order.set(t, 0);
        return [];
    }
    const resolved = laneOrder(order);
    if (!resolved)
        return [
            {
                guard: "laneOrder",
                message: `[${order.join(", ")}] is not a permutation of the three lanes`,
            },
        ];
    Track.order.set(t, packOrder(resolved));
    return [];
}

/** write the track's start speed, refusing anything below {@link MIN_V0} — a zero or negative
 *  start makes a level track take infinite time. */
export function setV0(ecs: State, v: number): LaneRefusal[] {
    const t = trackEntity(ecs);
    if (t === null) return [{ guard: "noTrack", message: "no track to set a start speed on" }];
    if (!(Number.isFinite(v) && v >= MIN_V0))
        return [
            {
                guard: "minStartSpeed",
                message: `a start speed of ${v} m/s is below the ${MIN_V0} m/s floor`,
            },
        ];
    Track.v0.set(t, v);
    return [];
}

// ── constants ────────────────────────────────────────────────────────────────

export const MAX_SAMPLES = 4096;

/** the track's nominal sampling step (m) — what every run resolves its own step from. */
export const DS_NOMINAL = 0.5;

/** the fallback start speed (m/s) when the `v0` column is absent. Matches kexedit / FVD. */
export const V0 = 10;

/** the slowest authored start speed — a positive floor, so a level track never takes infinite
 *  time. Read by {@link setV0} and by `doc.checkDocInvariants`. */
export const MIN_V0 = 0.1;

/** a fresh track's default Coulomb friction coefficient — 0.021 sits mid-range for polyurethane
 *  wheels on steel rail (~0.01–0.03), the actual coaster contact pair. Nonzero and physical,
 *  unlike the kernel's own zero-coefficient default, which is what an ABSENT column restores. */
export const DEFAULT_FRICTION = 0.021;

/** a fresh track's default quadratic-drag coefficient (1/m), derived from `c = ρ·C_d·A/2m` with
 *  ρ = 1.225, C_d = 1.0, A = 2.5 m², m = 6000 kg — a 24-rider train's open bluff-body drag,
 *  rounded up from 2.55e-4 (erring high is the safe direction). */
export const DEFAULT_RESISTANCE = 2.5e-4;

/** the span a freshly authored record covers when nothing else says otherwise (m). */
export const EXTEND_DIST = 24;

/** the span a summoned velocity record grows to (m) — feel-gate F3, person's verdict
 *  2026-08-26. An independent literal, not derived from {@link EXTEND_DIST}: a speed control and
 *  a shape span answer different questions. */
export const STRIP_DEFAULT_LEN = 10;

/** the track's initial anchor: a level start at the origin. World position is cosmetic in this
 *  2D prototype (the view auto-frames); the authored variable is the start speed. */
function startEntry(v0: number): Entry {
    return { x: 0, y: 0, theta: 0, v: v0 };
}

// ── bake output ──────────────────────────────────────────────────────────────

type Samples = {
    posX: Float32Array;
    posY: Float32Array;
    theta: Float32Array;
};

/** SoA sample buffers per track, sized once to MAX_SAMPLES. Only `[0, Track.count)` is valid.
 *
 *  OWED: a module-level `Map` keyed by entity id, so two `State()` instances collide — both
 *  start counting at 1, so a test holding two independent states silently reads the wrong bake
 *  (`AGENTS.md` Hard gotchas). Whichever stage next needs two live states owns the fix. */
export const samples = new Map<number, Samples>();

/** baked per-edge state per track. `fN` is force in g (per-edge), `ds` per-edge spacing, `v` the
 *  recovered speed (per-sample), `t` per-sample cumulative time with `tTotal = t[count − 1]`,
 *  `feasible[i]` 1 when `|v[i]| ≥ V_WARN`, `firstInfeasible` the first sample below it or −1.
 *  `hash` is the authored state that produced this bake; a miss triggers a re-bake. */
export const bakeOut = new Map<
    number,
    {
        fN: Float32Array;
        ds: Float32Array;
        v: Float32Array;
        t: Float32Array;
        tTotal: number;
        feasible: Uint8Array;
        firstInfeasible: number;
        hash: string;
    }
>();

/** per-run realized metadata the flat SoA drops — keyed by derived run id, written by
 *  `BakeSystem`, read by the render (boundary markers at `entry`) and the timeline (run
 *  boundaries and the cumulative-s offset via the sample range). */
export interface RunInfo {
    /** the run's entry anchor (world) — the frame the run's samples were placed at. */
    entry: Entry;
    /** global sample index of the run's first point. */
    startSample: number;
    /** global sample index of the run's last point. */
    endSample: number;
    /** how many authored control points landed on a sample. */
    bakedNodes: number;
}

export const runInfo = new Map<number, RunInfo>();

/** allocate an empty track entity plus its sample / bake-output buffers, sized once. */
export function createTrack(ecs: State): number {
    const trackEid = ecs.create();
    ecs.add(trackEid, Track);
    Track.count.set(trackEid, 0);
    Track.ds.set(trackEid, DS_NOMINAL);
    Track.domain.set(trackEid, Domain.Distance);
    Track.friction.set(trackEid, 0);
    Track.resistance.set(trackEid, 0);
    Track.end.set(trackEid, 0);
    Track.order.set(trackEid, 0);
    Track.v0.set(trackEid, 0);
    samples.set(trackEid, {
        posX: new Float32Array(MAX_SAMPLES),
        posY: new Float32Array(MAX_SAMPLES),
        theta: new Float32Array(MAX_SAMPLES),
    });
    bakeOut.set(trackEid, {
        fN: new Float32Array(MAX_SAMPLES - 1),
        ds: new Float32Array(MAX_SAMPLES - 1),
        v: new Float32Array(MAX_SAMPLES),
        t: new Float32Array(MAX_SAMPLES),
        tTotal: 0,
        feasible: new Uint8Array(MAX_SAMPLES),
        firstInfeasible: -1,
        hash: "",
    });
    return trackEid;
}

// ── velocity framing ─────────────────────────────────────────────────────────

/** resolve authored spans into the kernel's EDGE-INDEX form (`section.Strip`).
 *
 *  The convention is the point one: `start`/`end` are station boundaries snapped to the nearest
 *  edge boundary, and a degenerate `start === end` re-maps to the preceding edge, "a point at
 *  station k overrides exactly edge (k−1→k)'s result".
 *
 *  A row wholly past the current extent (`start >= total`) is DROPPED before the boundary map
 *  runs rather than threaded through it: `boundary` would clamp both its ends to `edges`,
 *  collapsing to the degenerate case and displacing the inert row's override onto the run's own
 *  last live edge instead of leaving it inert. A row straddling the extent is untouched — its
 *  `end` already clamps, which is the clip the extent law asks for. */
export function edgeStrips(
    ds: ArrayLike<number>,
    edges: number,
    rows: readonly {
        start: number;
        end: number;
        value: number;
        keyframes?: { s: number; v: number; ease?: number }[];
    }[],
): StripSpec[] | undefined {
    if (rows.length === 0) return undefined;
    const cum = new Float32Array(edges + 1);
    for (let i = 0; i < edges; i++) cum[i + 1] = cum[i] + ds[i];
    const total = cum[edges];
    const live = rows.filter((r) => r.start < total);
    if (live.length === 0) return undefined;
    const boundary = (s: number): number => {
        if (!(s > 0)) return 0;
        if (s >= total) return edges;
        let i = 0;
        while (i < edges && cum[i] < s) i++;
        if (i === 0) return 0;
        return s - cum[i - 1] <= cum[i] - s ? i - 1 : i;
    };
    return live.map((r) => {
        const start = boundary(r.start);
        const end = boundary(r.end);
        const lo = start === end ? start - 1 : start;
        if (r.keyframes && r.keyframes.length > 0) {
            // pre-evaluate the span's curve per edge on the force-curve machinery
            // (`profile.sampleForce`), so `stripOverride` is a lookup, not an evaluation.
            const points = r.keyframes.map((k) => ({ s: k.s, g: k.v, ease: k.ease }));
            const values = new Float32Array(end - lo);
            for (let k = lo; k < end; k++) {
                // a station-0 degenerate row has lo = −1, so `cum[-1]` is undefined; the `?? 0`
                // keeps that inertness an invariant rather than a coincidence of branch order.
                const sigma = cum[k] ?? 0;
                const v = sampleForce(points, sigma);
                values[k - lo] = v * v;
            }
            return { start, end, value: r.value, values };
        }
        return { start, end, value: r.value };
    });
}

/** the velocity lane in one run's own edge-index frame.
 *
 *  ONE ROW PER RECORD (spec S2e-i punch list item 2): each record is a two-handle span, and a
 *  span's own curve is determined by its two handles, so splitting an abutting group into its
 *  records reproduces the group's curve exactly while keeping two ABUTTING records with
 *  different handles from merging into one row that averages across the seam.
 *
 *  A record whose entry law resolves to nothing has no prescription to publish and is skipped —
 *  the velocity lane dissipates under physics across a gap (`lanes.inferredEntry`), which is not
 *  a value the march may be handed.
 *
 *  `offset` is the run's own track-global entry, a PURE derivation from the live document, never
 *  a bake read — so a record converts to run-local by subtracting it. */
export function stripsForStep(ecs: State, offset: number, step: Step): StripSpec[] | undefined {
    const rows = laneRows(ecs, Lane.Velocity);
    if (rows.length === 0) return undefined;
    const ds = new Float32Array(step.edges).fill(step.ds);
    return edgeStrips(ds, step.edges, velocityRows(rows, offset));
}

/** the velocity lane as {@link edgeStrips} rows, run-local by `offset`. Pure, so the document's
 *  own save path and the live bake read one rule. */
export function velocityRows(
    rows: readonly LaneSegment[],
    offset: number,
): {
    start: number;
    end: number;
    value: number;
    keyframes: { s: number; v: number; ease?: number }[];
}[] {
    const out: {
        start: number;
        end: number;
        value: number;
        keyframes: { s: number; v: number; ease?: number }[];
    }[] = [];
    for (const r of ordered(rows)) {
        const entry = entryValue(Lane.Velocity, rows, r) as number | undefined;
        if (entry === undefined) continue;
        out.push({
            start: r.start - offset,
            end: r.end - offset,
            value: entry,
            // the record's own tag governs its span, exactly as a force record's governs `g`:
            // `profile.segment` reads the LEADING key's `ease` (missing = Cubic).
            keyframes: [
                { s: r.start - offset, v: entry, ease: r.ease },
                { s: r.end - offset, v: r.exit },
            ],
        });
    }
    return out;
}

/** Materialize a run's held edge values without changing its sampled profile. The returned copy
 *  makes the payload boundary explicit: an empty run holds `DEFAULT_G`, while an interior-only
 *  profile owns its own first/last values instead of borrowing across a run. */
export function materializeRunForceClamps(
    points: readonly ForcePoint[],
    runLength: number,
): ForcePoint[] {
    const clamped = points.slice();
    const startG = sampleForce(points, 0);
    const endG = sampleForce(points, runLength);
    if (clamped.length === 0 || clamped[0]!.s > 0)
        clamped.unshift({ s: 0, g: startG, ease: 0 as Easing });
    if (clamped.length === 1 || clamped[clamped.length - 1]!.s < runLength)
        clamped.push({ s: runLength, g: endG, ease: 0 as Easing });
    return clamped;
}

// ── the derived partition ────────────────────────────────────────────────────

/** the evaluator's run partition, derived from the live lanes — the ONE reader every consumer
 *  goes through, so nothing rebuilds the partition on its own rule. */
export function runsOf(ecs: State): DerivedRun[] {
    return deriveRuns(lanesOf(ecs), endColumn(ecs), laneOrderOf(ecs));
}

/** one derived run as an evaluator payload, at the step its own length resolves. */
function payloadOf(ecs: State, run: DerivedRun, ds: number, offset: number): SectionSpec {
    const step = resolveStep(run.length, ds);
    const strips = stripsForStep(ecs, offset, step);
    return run.kind === SectionKind.Geo
        ? { kind: "pitch", points: run.points, step, openEase: run.openEase, strips }
        : {
              kind: "force",
              fN: forceProfile(materializeRunForceClamps(run.points, run.length), step),
              step,
              strips,
          };
}

// ── the arclength lens ───────────────────────────────────────────────────────

/** one run's published place on the whole-track arclength axis. */
export interface RunSpan {
    id: number;
    offset: number;
    len: number;
}

/** the coordinate lens — the ONE seam between track-global arclength and the run-local `s` the
 *  payloads march in. One accumulating pass over the baked `ds`; runs are contiguous (each
 *  shares its entry sample with the prior exit), so one pass suffices. */
export function runSpans(ecs: State, eid: number): RunSpan[] {
    const out = bakeOut.get(eid);
    if (!out) return [];
    const last = Math.max(0, Track.count.get(eid) - 1);
    const res: RunSpan[] = [];
    let cum = 0;
    for (const run of runsOf(ecs)) {
        const info = runInfo.get(run.id);
        if (!info) continue;
        const offset = cum;
        // clamped to the PUBLISHED buffer: a run placed past the sample budget points at edges
        // that were never written, and summing those would put NaN into every span downstream.
        for (let i = info.startSample; i < Math.min(info.endSample, last); i++) cum += out.ds[i]!;
        res.push({ id: run.id, offset, len: cum - offset });
    }
    return res;
}

/** run-local arclength `(run, s)` → track-global distance. null when the run isn't on the bake. */
export function toGlobal(spans: RunSpan[], run: number, s: number): number | null {
    const sp = spans.find((x) => x.id === run);
    return sp ? sp.offset + s : null;
}

/** track-global distance → the run-local address `(run, s)`. A `d` on a shared boundary
 *  resolves UPSTREAM (the first span whose exit reaches `d` wins); out-of-range `d` resolves to
 *  the nearest end. null when there is no bake. */
export function toLocal(spans: RunSpan[], d: number): { run: number; s: number } | null {
    if (spans.length === 0) return null;
    for (const sp of spans)
        if (d <= sp.offset + sp.len) return { run: sp.id, s: Math.max(0, d - sp.offset) };
    const last = spans[spans.length - 1]!;
    return { run: last.id, s: last.len };
}

// ── snapshots ────────────────────────────────────────────────────────────────

/** one authored record, lane included — the undo unit's own row. */
export interface RecordSnapshot extends LaneSegment {
    lane: Lane;
}

/** the whole authored track: every lane record plus the four track-level authored scalars. A
 *  snapshot pair round-trips byte-identically, which is what makes an op reversible. */
export interface TrackSnapshot {
    records: RecordSnapshot[];
    end: number;
    order: number;
    v0: number;
}

/** capture the whole authored track. */
export function snapshotAll(ecs: State): TrackSnapshot {
    const t = trackEntity(ecs);
    const records: RecordSnapshot[] = [];
    for (const lane of [Lane.Velocity, Lane.Force, Lane.Geo])
        for (const row of laneRows(ecs, lane)) records.push({ ...row, lane });
    return {
        records,
        end: t === null ? 0 : Track.end.get(t),
        order: t === null ? 0 : Track.order.get(t),
        v0: t === null ? 0 : Track.v0.get(t),
    };
}

/** force the next `BakeSystem` pass to bake, whatever the authored state hashes to. Authored
 *  content that round-trips inside one frame (an op and its undo, a load of the document already
 *  live) hashes exactly like the last bake, so the gate would skip forever while `Track.count`
 *  sat at whatever the restore left it. `bakeHash` never produces `""`, so this cannot collide
 *  with a real state. */
function invalidateBake(ecs: State): void {
    for (const t of ecs.query([Track])) {
        const out = bakeOut.get(t);
        if (out) out.hash = "";
    }
}

/** clear the authored track and rebuild it from a snapshot. Respawns the stored numbers
 *  verbatim — the laws are the SETTERS' gate, not the restore's: a snapshot is by construction a
 *  state the setters already accepted, and re-refusing here would make undo lossy. */
export function restoreAll(ecs: State, snap: TrackSnapshot): void {
    for (const e of [...ecs.query([LaneRecord])]) ecs.destroy(e);
    invalidateBake(ecs);
    for (const row of snap.records) {
        const eid = ecs.create();
        ecs.add(eid, LaneRecord);
        writeRow(eid, row.lane, row);
        nextRecordId = Math.max(nextRecordId, row.id + 1);
    }
    const t = trackEntity(ecs);
    if (t === null) return;
    Track.end.set(t, snap.end);
    Track.order.set(t, snap.order);
    Track.v0.set(t, snap.v0);
    invalidateBake(ecs);
}

// ── the bake ─────────────────────────────────────────────────────────────────

/** the bake gate's input reading: the shared `ds` and coefficients, then every lane row, the
 *  authored end, the lane order and the start speed. `Track.domain` never folds in — it is a
 *  display lens over this same bake, never a second march, so flipping it must leave the hash,
 *  and therefore the bake, untouched. */
function bakeHash(ecs: State, trackEid: number): string {
    let h = `ds${Track.ds.get(trackEid)}mu${Track.friction.get(trackEid)}c${Track.resistance.get(trackEid)}`;
    h += `|end${Track.end.get(trackEid)}|order${Track.order.get(trackEid)}|v0${Track.v0.get(trackEid)}`;
    for (const lane of [Lane.Velocity, Lane.Force, Lane.Geo]) {
        h += `|L${lane}`;
        for (const r of laneRows(ecs, lane))
            h += `,${r.id}=${r.start}:${r.end}:${r.ease}:${r.entry ?? "-"}:${r.exit}`;
    }
    return h;
}

/** the bake gate's reading for the whole authored track, computed from the LIVE authored state
 *  rather than read off the last bake — so it is the honest answer between ticks too. */
export function authoredHash(ecs: State): string {
    const t = trackEntity(ecs);
    return t === null ? "" : bakeHash(ecs, t);
}

/** whether the current bake IS the current authored state — the liveness anything reading
 *  {@link runInfo} as truth needs first. A bake that never ran, and one invalidated since (the
 *  `""` sentinel), both fail here, and each leaves `runInfo` describing a shape that is no
 *  longer on screen. */
export function bakeLive(ecs: State): boolean {
    const t = trackEntity(ecs);
    if (t === null) return false;
    const out = bakeOut.get(t);
    return out !== undefined && out.hash === authoredHash(ecs);
}

type BakeOut = NonNullable<ReturnType<typeof bakeOut.get>>;

/** per-sample cumulative time plus the diagnostic feasibility flag. Arclength is the one march
 *  (`Track.domain` is a display lens, never a second march), so a sample's duration is DERIVED
 *  from the distance march: `ds_i / v̄_i`, v̄ floored at `V_FLOOR` so energy-depleted regions take
 *  long-but-finite time rather than dividing by zero. */
function computeTime(out: BakeOut, count: number): void {
    out.t[0] = 0;
    out.feasible[0] = Math.abs(out.v[0]!) >= V_WARN ? 1 : 0;
    let firstBad = out.feasible[0] === 0 ? 0 : -1;
    for (let i = 0; i < count - 1; i++) {
        const vA = Math.max(Math.abs(out.v[i]!), V_FLOOR);
        const vB = Math.max(Math.abs(out.v[i + 1]!), V_FLOOR);
        const dt = out.ds[i]! / (0.5 * (vA + vB));
        out.t[i + 1] = out.t[i]! + dt;
        const f = Math.abs(out.v[i + 1]!) >= V_WARN ? 1 : 0;
        out.feasible[i + 1] = f;
        if (firstBad < 0 && f === 0) firstBad = i + 1;
    }
    out.tTotal = count > 0 ? out.t[count - 1]! : 0;
    out.firstInfeasible = firstBad;
}

/** the bake: derive the run partition from the lanes, thread it from the start anchor into one
 *  flat SoA plus per-run metadata. Writes `samples` + `bakeOut` and records {@link runInfo}. */
function bake(ecs: State, trackEid: number, s: Samples, out: BakeOut, runs: DerivedRun[]): void {
    const ds = Track.ds.get(trackEid);
    const start = startEntry(entrySpeed(ecs));
    const friction = Track.friction.get(trackEid);
    const resistance = Track.resistance.get(trackEid);

    const payloads: SectionSpec[] = [];
    let offset = 0;
    for (const run of runs) {
        payloads.push(payloadOf(ecs, run, ds, offset));
        const step = resolveStep(run.length, ds);
        // the live bake measures a run's window by summing its published per-edge steps, f32
        // values and all, never by trusting the authored extent.
        const grid = new Float32Array(step.edges).fill(step.ds);
        for (let i = 0; i < step.edges; i++) offset += grid[i]!;
    }

    const c = chain(start, payloads, MAX_SAMPLES, friction, resistance);
    // `chain` keeps counting edges past the sample budget, so its count is a would-be count.
    // What the SoA HAS is the budget, and publishing more than that hands every consumer indices
    // that were never written.
    const count = Math.min(c.count, MAX_SAMPLES);
    if (count < 2) return; // fully degenerate — keep the prior bake

    runInfo.clear();
    let truncatedAny = false;
    for (let k = 0; k < c.results.length; k++) {
        const r = c.results[k]!;
        const range = c.ranges[k]!;
        runInfo.set(runs[k]!.id, {
            entry: k === 0 ? start : c.exits[k - 1]!,
            startSample: range.start,
            endSample: range.end,
            bakedNodes: r.offsets.length,
        });
        if (r.truncated) truncatedAny = true;
    }
    if (truncatedAny)
        console.warn(
            `kex2d: track ${trackEid} hit MAX_SAMPLES=${MAX_SAMPLES}; trailing samples dropped`,
        );

    s.posX.set(c.posX.subarray(0, count), 0);
    s.posY.set(c.posY.subarray(0, count), 0);
    s.theta.set(c.theta.subarray(0, count), 0);
    out.v.set(c.v.subarray(0, count), 0);
    out.fN.set(c.fN.subarray(0, Math.max(0, count - 1)), 0);
    out.ds.set(c.ds.subarray(0, Math.max(0, count - 1)), 0);
    out.hash = bakeHash(ecs, trackEid);
    Track.count.set(trackEid, count);
    computeTime(out, count);
}

export const BakeSystem: System = {
    update(ecs: State): void {
        for (const trackEid of ecs.query([Track])) {
            const s = samples.get(trackEid);
            const out = bakeOut.get(trackEid);
            if (!s || !out) continue;
            const runs = runsOf(ecs);
            if (runs.length === 0) continue;
            if (bakeHash(ecs, trackEid) === out.hash) continue;
            bake(ecs, trackEid, s, out, runs);
        }
    },
};

export const TrackPlugin: Plugin = {
    name: "Track",
    components: { Track, LaneRecord },
    traits: {
        Track: {
            defaults: () => ({
                count: 0,
                ds: DS_NOMINAL,
                domain: Domain.Distance,
                friction: 0,
                resistance: 0,
                end: 0,
                order: 0,
                v0: 0,
            }),
        },
    },
    systems: [BakeSystem],
};

// ── track-level scalars ──────────────────────────────────────────────────────

/** the track entity, or null on an empty world — the one resolver every track-scalar read uses. */
export function trackEntity(ecs: State): number | null {
    for (const t of ecs.query([Track])) return t;
    return null;
}

/** the track's nominal spacing (the bake's `ds`). */
export function trackDs(ecs: State): number {
    const t = trackEntity(ecs);
    return t === null ? DS_NOMINAL : Track.ds.get(t);
}

/** the track-global display domain. `Distance` for a track with no `Track` entity, so a bare
 *  read is never a surprise unit. */
export function trackDomain(ecs: State): Domain {
    const t = trackEntity(ecs);
    return t === null ? Domain.Distance : (Track.domain.get(t) as Domain);
}

/** write the track-global domain. **The stored numbers are NOT converted here** — this is the
 *  raw column write; flipping the domain re-interprets nothing, because every station is stored
 *  in metres of arclength always. */
export function setTrackDomain(ecs: State, domain: Domain): void {
    const t = trackEntity(ecs);
    if (t !== null) Track.domain.set(t, domain);
}

/** the track's authored Coulomb friction coefficient, or 0 for an empty world — the kernel's own
 *  neutral default, never {@link DEFAULT_FRICTION} (that is a NEW-track authoring default). */
export function trackFriction(ecs: State): number {
    const t = trackEntity(ecs);
    return t === null ? 0 : Track.friction.get(t);
}

/** {@link trackFriction}'s quadratic-drag twin. */
export function trackResistance(ecs: State): number {
    const t = trackEntity(ecs);
    return t === null ? 0 : Track.resistance.get(t);
}

/** whether a typed coefficient is one a field may commit — finite and non-negative. The kernel
 *  itself carries no such guard (`forward.loss` takes `|fMag|` unvalidated), so this is purely
 *  the field's own refusal. */
export function validCoefficient(v: number): boolean {
    return Number.isFinite(v) && v >= 0;
}

/** the track's undoable friction coefficient — the scrub/type gesture snapshots this. */
export interface TrackFrictionState {
    friction: number;
}

export function trackFrictionState(trackEid: number): TrackFrictionState | undefined {
    return { friction: Track.friction.get(trackEid) };
}

/** set the track's friction coefficient. No floor: the kernel's own no-guard convention, so a
 *  negative/NaN refusal is {@link validCoefficient}'s job, checked before this write is called. */
export function setTrackFriction(trackEid: number, friction: number): void {
    Track.friction.set(trackEid, friction);
}

/** {@link TrackFrictionState}'s drag-coefficient twin. */
export interface TrackResistanceState {
    resistance: number;
}

export function trackResistanceState(trackEid: number): TrackResistanceState | undefined {
    return { resistance: Track.resistance.get(trackEid) };
}

/** {@link setTrackFriction}'s drag-coefficient twin. */
export function setTrackResistance(trackEid: number, resistance: number): void {
    Track.resistance.set(trackEid, resistance);
}

export { Lane, RECORD_FLOOR } from "./lanes";
export type { LaneSegment, Lanes } from "./lanes";
