import { f32, type Plugin, sparse, type State, type System, u32, vec2 } from "@dylanebert/shallot";
import { V_FLOOR, V_WARN } from "./bake";
import type { GeofitBake } from "./geofit";
import { LENGTH_MIN } from "./magnet";
import { DEFAULT_G, Easing, type ForcePoint, forceProfile, type Offset } from "./profile";
import {
    chain,
    Domain,
    type Entry,
    evalForce,
    evalGeo,
    localize,
    place,
    type Section as SectionSpec,
} from "./section";
import { autoTangent, type Node, reflect, type Tangent, type TangentMode } from "./spline";

/** whether a section is authored as GEOMETRY (drag nodes in the viewport, recover
 *  the force) or FORCE (place points on the force curve, integrate the geometry) —
 *  the two atomic idioms of the section substrate.
 *  a track is a chain of sections, each with its own kind. stored on `Section.kind`
 *  as its numeric value. */
export enum SectionKind {
    Geo = 0,
    Force = 1,
}

/** per-track scalars. `count` is the total sample count over the whole chain (bake
 *  output, varies with the authored payload). `ds` is the nominal target spacing —
 *  one value shared by every section (per-edge actual ds lives in `bakeOut.ds`).
 *  `v0` is the authored initial speed (m/s) at the track start (the START handle's
 *  field; default `V0`, in the bake hash). the per-section kind + extent live on
 *  `Section`, not here.
 *
 *  `domain` is the track-global `Domain` (`section.ts`) — the unit EVERY force
 *  section's keyframes and extent are stored in: meters of section-local arclength
 *  (`Distance`, the default) or seconds of section-local time (`Time`). It is
 *  authored state, in the bake hash, and one track-global fact — not per-section
 *  (rejected at feel: no per-section flip row). Nothing converts implicitly: the
 *  stored numbers ARE the active domain's unit, and the ONE place they change unit
 *  is the ruler-menu pick, a document conversion op (`domain.convertDomain`). Geo
 *  sections are position-authored in either domain; only `evalForce`'s step rule and
 *  the force-section extent/keyframe axis read this. */
export const Track = {
    count: sparse(u32),
    ds: sparse(f32),
    v0: sparse(f32),
    domain: sparse(u32),
};

/** one section in the track's chain. `id` is the stable identity undo/redo and
 *  node/point membership address (eids recycle across a delete→undo; ids never do
 *  — the `Handle.order` convention). `order` is its position along the chain
 *  (0 = first), reassigned by the structural ops (append/split/join/delete). `kind`
 *  is the `SectionKind`. `length` is a FORCE section's extent — the span the force
 *  profile covers, in the TRACK-GLOBAL domain's own unit (`Track.domain`: meters of
 *  arclength, or seconds); unused (0) for a geo section, whose extent is its node chain.
 *  `ds` is the section's own baking step (in that same domain unit), **0 = bake at the
 *  domain's nominal quantum** — the sentinel every hand-authored section carries. An invoked solve
 *  writes its realized step here (`length/edges`) so the section spans its solve
 *  exactly; replaying that profile at the nominal quantum misses the pinned exit
 *  (`refine.ts`, and the ECS pin in `tests/track.test.ts`).
 *  a section's entry anchor is derived (the prior section's exit, or `START` for the
 *  first); it is never stored. */
export const Section = {
    id: sparse(u32),
    order: sparse(u32),
    kind: sparse(u32),
    length: sparse(f32),
    ds: sparse(f32),
};

/** a node on a geo section. `section` is the owning section's stable id. `order`
 *  is the node's position within that section (0 = the section entry, pinned at
 *  local origin). `pos` is the node's **section-local** position; the substrate
 *  places it rigidly at the section's entry frame, so world = `place(entry, pos)`
 *  (the bake writes the world sample; the drag localizes the world pointer back).
 *  `theta` is the node's section-local exit heading — set when appended (via
 *  `reflect`) and refreshed by `reheadOnDrag`: the *last* node tracks its
 *  predecessor, node 0 is a fixed local flat anchor (θ = 0), interior nodes stay
 *  frozen. only the last node's heading changes on a drag, so the edit reshapes
 *  only the two segments sharing the dragged node. `sample` is the global sample
 *  index this node lands on (synced by BakeSystem).
 *  `tmode` is the node's `TangentMode` (0 = Auto, the default: derive tangents
 *  from `theta` via the arc rule). when it isn't Auto, `tin`/`tout` hold the
 *  explicit in/out tangent vectors (section-local, absolute) the bake honors in
 *  place of the arc rule — the summoned inner layer (`Aligned` / `Free`). */
export const Handle = {
    section: sparse(u32),
    order: sparse(u32),
    sample: sparse(u32),
    pos: sparse(vec2),
    theta: sparse(f32),
    tmode: sparse(u32),
    tin: sparse(vec2),
    tout: sparse(vec2),
};

/** the numeric value stored on `Handle.tmode` for an `Auto` node (no explicit
 *  tangent). the `TangentMode` enum starts at 1, so 0 is the third, default state. */
const TANGENT_AUTO = 0;

/** read a node's explicit tangent, or undefined when it's `Auto` — the projection
 *  onto the pure `spline.Node.tangent`. */
function readTangent(eid: number): Tangent | undefined {
    const mode = Handle.tmode.get(eid);
    if (mode === TANGENT_AUTO) return undefined;
    return {
        mode: mode as TangentMode,
        inX: Handle.tin.x.get(eid),
        inY: Handle.tin.y.get(eid),
        outX: Handle.tout.x.get(eid),
        outY: Handle.tout.y.get(eid),
    };
}

/** write a node's tangent onto its columns; undefined resets it to `Auto` (zeroed
 *  vectors). the one place `Handle.tmode`/`tin`/`tout` are written together. */
function writeTangent(eid: number, tan: Tangent | undefined): void {
    if (tan) {
        Handle.tmode.set(eid, tan.mode);
        Handle.tin.set(eid, tan.inX, tan.inY);
        Handle.tout.set(eid, tan.outX, tan.outY);
    } else {
        Handle.tmode.set(eid, TANGENT_AUTO);
        Handle.tin.set(eid, 0, 0);
        Handle.tout.set(eid, 0, 0);
    }
}

/** an authored force keyframe on a FORCE section. `section` is the owning section's
 *  stable id; `id` is the point's stable identity (undo/redo address, eid-recycle
 *  safe); `s` its position measured from the section entry, in the TRACK-GLOBAL
 *  domain's unit (`Track.domain`: meters of arclength, or seconds of time — the field
 *  name stays `s`, since the unit rides the track, not the name); `g` the demanded
 *  normal force (g). the timeline places, drags, and deletes these; the bake gathers
 *  each section's points (sorted by s) into a dense profile (`profile.forceProfile`).
 *  `ease` is the keyframe's `Easing` tag (the convenient middle layer) — it governs
 *  the *following* segment's derived flat tangents (default `Easing.Cubic`, the "no
 *  stored state" convention). `tmode` mirrors geo's `Handle.tmode`: 0 = no explicit
 *  handles (derive from `ease`), else a `TangentMode` for the summoned inner layer, in
 *  which case `tin`/`tout` hold the explicit in/out handle **offsets** ((Δs, Δg) as
 *  x/y) the bake substitutes for the derived tangents. */
export const Force = {
    section: sparse(u32),
    id: sparse(u32),
    s: sparse(f32),
    g: sparse(f32),
    ease: sparse(u32),
    tmode: sparse(u32),
    tin: sparse(vec2),
    tout: sparse(vec2),
};

/** the easing tag a fresh force keyframe gets — the FVD++/Planet-Coaster S-transition
 *  feel, and the "no stored state" default (`profile.ts` reads an absent tag as this). */
const FORCE_EASE_DEFAULT = Easing.Cubic;

/** `Force.tmode` bits. the low two bits hold the `TangentMode` (1/2/3); the two flag
 *  bits mark which sides carry an explicit handle. a keyframe's two sides are
 *  **independently optional** (per-side, per the segment-scoped Custom model): the
 *  segment X→X+1 is Custom iff X's OUT or X+1's IN holds an explicit handle, so a
 *  preset/Custom on one segment must clear/materialize one side without touching the
 *  keyframe's far side (which belongs to the neighbouring segment). 0 (no flags) = the
 *  derived-from-`ease` default. */
const TIN_PRESENT = 1 << 2;
const TOUT_PRESENT = 1 << 3;

/** a force keyframe's explicit handles — the summoned inner layer, mirroring geo's
 *  `Tangent`. `mode` is the `TangentMode` (which handle drag rotates/mirrors the other);
 *  `in`/`out` are the stored (Δs, Δg) handle offsets `profile.segment` consumes. each
 *  side is **independently optional**: an absent side derives from `ease`, a present one
 *  overrides it verbatim. the whole record is undefined only when both sides derive. */
export interface ForceTangent {
    mode: TangentMode;
    in?: Offset;
    out?: Offset;
}

/** read a force keyframe's explicit handles, or undefined when both sides derive from
 *  `ease` — the projection onto `profile.ForcePoint`'s `in`/`out`. mirrors geo's
 *  `readTangent`; each side is present only when its flag bit is set. */
function readForceTangent(eid: number): ForceTangent | undefined {
    const raw = Force.tmode.get(eid);
    const inOn = (raw & TIN_PRESENT) !== 0;
    const outOn = (raw & TOUT_PRESENT) !== 0;
    if (!inOn && !outOn) return undefined;
    const tan: ForceTangent = { mode: (raw & 0b11) as TangentMode };
    if (inOn) tan.in = { ds: Force.tin.x.get(eid), dg: Force.tin.y.get(eid) };
    if (outOn) tan.out = { ds: Force.tout.x.get(eid), dg: Force.tout.y.get(eid) };
    return tan;
}

/** write a force keyframe's explicit handles onto its columns; undefined (or a record
 *  with neither side) clears them back to the derived-from-`ease` default (zeroed). the
 *  one place `Force.tmode`/`tin`/`tout` are written together. mirrors geo's `writeTangent`.
 *  the absent side stores zeroes so an undo round-trip is byte-identical. */
function writeForceTangent(eid: number, tan: ForceTangent | undefined): void {
    if (tan && (tan.in || tan.out)) {
        let raw = tan.mode & 0b11;
        if (tan.in) {
            raw |= TIN_PRESENT;
            Force.tin.set(eid, tan.in.ds, tan.in.dg);
        } else Force.tin.set(eid, 0, 0);
        if (tan.out) {
            raw |= TOUT_PRESENT;
            Force.tout.set(eid, tan.out.ds, tan.out.dg);
        } else Force.tout.set(eid, 0, 0);
        Force.tmode.set(eid, raw);
    } else {
        Force.tmode.set(eid, 0);
        Force.tin.set(eid, 0, 0);
        Force.tout.set(eid, 0, 0);
    }
}

/** whether two (Δs, Δg) offsets are equal (both absent = equal). */
function sameOffset(a?: Offset, b?: Offset): boolean {
    if (!a || !b) return !a && !b;
    return a.ds === b.ds && a.dg === b.dg;
}

/** whether two explicit force handles are equal (both absent = equal, per-side) — the
 *  gesture no-op test the handle-drag/reset history wrappers use. */
export function sameForceTangent(a?: ForceTangent, b?: ForceTangent): boolean {
    if (!a || !b) return !a && !b;
    return a.mode === b.mode && sameOffset(a.in, b.in) && sameOffset(a.out, b.out);
}

type Samples = {
    posX: Float32Array;
    posY: Float32Array;
    theta: Float32Array;
    v: Float32Array;
};

/** SoA sample buffers per track, sized once to MAX_SAMPLES. only indices
 *  `[0, Track.count)` carry valid data. */
export const samples = new Map<number, Samples>();

/** baked per-edge state for each track. `fN` is force in g (per-edge, length
 *  MAX_SAMPLES − 1). `ds` is per-edge actual spacing. `t` is per-sample
 *  cumulative time `t[i] = Σ_{k<i} ds_k / v_safe_k`, length MAX_SAMPLES —
 *  the cart and the timeline read from it. `tTotal = t[count − 1]`.
 *  `feasible[i]` is 1 when `|v[i]| ≥ V_WARN`, 0 otherwise — drives the red
 *  track / red handle / warning banner UX. `firstInfeasible` is the first
 *  sample below V_WARN, or -1 if the whole chain is feasible. `hash` is the
 *  input state that produced the current bake; a miss triggers a full re-bake. */
export const bakeOut = new Map<
    number,
    {
        fN: Float32Array;
        ds: Float32Array;
        t: Float32Array;
        tTotal: number;
        feasible: Uint8Array;
        firstInfeasible: number;
        hash: string;
    }
>();

/** per-section realized metadata the flat SoA drops — keyed by stable section id,
 *  written by BakeSystem, read by the drag (localize against `entry`), the render
 *  (boundary markers at `entry`, orphan nodes past `bakedNodes`), and the timeline
 *  (section boundaries + cumulative-s offset via the sample range). */
export interface SectionInfo {
    /** the section's entry anchor (world) — `START` for the first, the prior
     *  section's exit otherwise. the frame a geo node localizes against. */
    entry: Entry;
    /** global sample index of the section's first point (its entry, shared with the
     *  prior section's last point). */
    startSample: number;
    /** global sample index of the section's last point (its exit). */
    endSample: number;
    /** geo: how many nodes landed (a degenerate/truncated segment bakes a prefix, so
     *  nodes past this are orphans). force: 2 (the boundary anchors). */
    bakedNodes: number;
}

export const sectionInfo = new Map<number, SectionInfo>();

export const MAX_SAMPLES = 4096;

/** the track's nominal sampling step (m) — what every section bakes at unless it
 *  carries its own (`Section.ds`). */
export const DS_NOMINAL = 0.5;

/** the DEFAULT initial speed (m/s) a fresh track's start anchor gets. it's now
 *  authored per-track (`Track.v0`, set via the START handle's field); this is only
 *  the seed until the user (or some upstream idiom — a launch, a lift hill) sets it.
 *  matches kexedit / FVD. */
export const V0 = 10;

/** the slowest the authored initial speed can be set — a positive floor so the start
 *  is never zero/negative (which would make a level track take infinite time). */
const MIN_V0 = 0.1;

/** the nominal sampling step (s) a force section bakes at in the `Time` domain when it
 *  carries no step of its own — `Section.ds`'s sentinel-0 contract in the domain's own
 *  unit. derived, not tuned: `ds = v·dt`, so at the DEFAULT entry speed `V0` a time
 *  section samples at the same spatial density a distance section does at `DS_NOMINAL`
 *  (`dt = ds/v`).
 *
 *  it is deliberately derived from the `V0` **constant**, not from the track's authored
 *  `Track.v0`, matching `DS_NOMINAL`'s own constancy: an authored-v0-dependent quantum
 *  would make a section's edge count move whenever v0 is scrubbed. Accepted cost: a time
 *  section's realized SPATIAL density scales with the ride's actual speed, so a fast
 *  stretch samples coarser than `DS_NOMINAL` and a slow one finer. */
export const DT_NOMINAL = DS_NOMINAL / V0;

/** how far `extend` lays the next node past the chain end, along the last edge's
 *  direction. it's a starting point you then drag, not a fixed length. */
export const EXTEND_DIST = 24;

/** the track's initial anchor for a given initial speed: the entry to the first
 *  section, a level start at the origin. world position is cosmetic in this 2D
 *  prototype (the view auto-frames), so it's fixed — the authored variable is the
 *  initial speed `v` (`Track.v0`), which this threads into the entry frame. */
function startEntry(v0: number): Entry {
    return { x: 0, y: 0, theta: 0, v: v0 };
}

/** the extent (m) a fresh force section gets — an append or a geo→force convert
 *  resets to this (the extent is the force section's own authored property, not a
 *  leftover of the pre-convert geo shape). matches the geo seed's length, so a fresh
 *  geo and a fresh force section start the same size; the end handle then resizes it. */
const DEFAULT_FORCE_LEN = EXTEND_DIST;

/** the extent (s) a fresh force section gets in the `Time` domain — `DEFAULT_FORCE_LEN`'s
 *  time twin, derived the same way `DT_NOMINAL` is: the time a `V0`-speed cart takes to
 *  cover `DEFAULT_FORCE_LEN` meters, so a fresh time append spans the same edge count at
 *  `DT_NOMINAL` that a fresh distance append spans at `DS_NOMINAL`. */
const DEFAULT_FORCE_DUR = DEFAULT_FORCE_LEN / V0;

/** the extent a fresh force section gets in `domain` — what a destructive geo→force convert
 *  resets to (an append takes the domain's sticky instead). */
function defaultForceExtent(domain: Domain): number {
    return domain === Domain.Time ? DEFAULT_FORCE_DUR : DEFAULT_FORCE_LEN;
}

/** the shortest a force section can be dragged — a couple of edges, so the profile
 *  never collapses below what `forceProfile` can sample. */
export const MIN_FORCE_LEN = 2;

/** `MIN_FORCE_LEN`'s time twin — the same couple-of-edges floor at `DT_NOMINAL` instead of
 *  `DS_NOMINAL`, which reduces to the identical `/V0` scaling. */
const MIN_FORCE_DUR = MIN_FORCE_LEN / V0;

/** the shortest a force section's extent can be, in a given domain's own unit. */
export function minForceExtent(domain: Domain): number {
    return domain === Domain.Time ? MIN_FORCE_DUR : MIN_FORCE_LEN;
}

/** the session's sticky append length — what a freshly APPENDED piece starts at, echoing the
 *  last length the author committed by hand. Each kind's length is its own authoring quantum:
 *  a **force** section's is its extent (the clip's right-edge trim), a **geo** section's is the
 *  chord `extend` lays down (the polar length manipulator). Updated only when such a gesture
 *  COMMITS (`setStickyLen`, from `history.commitLength` / `history.commitChord`), never by a
 *  solve landing (a converted section's realized extent is the solve's own answer, not an
 *  authored trim) and never by a destructive convert (which resets to the literal defaults —
 *  its shape has no "previous append" to echo). Session-level module state: not persisted
 *  across reloads, not threaded through undo, so undoing an append never rolls it back.
 *
 *  **Geo carries no domain** (it is position-authored in either), so it is one scalar in
 *  meters; force holds one slot per `Domain`, in that domain's own unit, so a time append never
 *  inherits a meters sticky or vice versa — each starts at its own literal default
 *  (`DEFAULT_FORCE_LEN` / `DEFAULT_FORCE_DUR`) until a commit in THAT domain lands. A domain
 *  flip never rewrites them: the sticky is a session memory of a gesture, not document state
 *  the conversion op owns. */
let stickyGeoChord = EXTEND_DIST;
const stickyForceExtent: Record<Domain, number> = {
    [Domain.Distance]: DEFAULT_FORCE_LEN,
    [Domain.Time]: DEFAULT_FORCE_DUR,
};

/** read the session's current sticky append length for a section kind — force in `domain`'s own
 *  unit, geo in meters (its `domain` argument is ignored, it has none). */
export function stickyLen(kind: SectionKind, domain: Domain = Domain.Distance): number {
    return kind === SectionKind.Geo ? stickyGeoChord : stickyForceExtent[domain];
}

/** record a committed length gesture as that kind's (and, for force, that domain's) new sticky
 *  append default, clamped to the floor its own gesture holds — `LENGTH_MIN` for a geo chord,
 *  `minForceExtent` for an extent trim — so a degenerate commit can't poison the next append. A
 *  non-finite value is ignored (a degenerate frame has no length to remember). */
export function setStickyLen(
    kind: SectionKind,
    length: number,
    domain: Domain = Domain.Distance,
): void {
    if (!Number.isFinite(length)) return;
    if (kind === SectionKind.Geo) stickyGeoChord = Math.max(LENGTH_MIN, length);
    else stickyForceExtent[domain] = Math.max(minForceExtent(domain), length);
}

/** allocate an empty track entity + its sample / bake-output buffers, sized once
 *  to MAX_SAMPLES. no sections — callers (the demo seed, tests) add their own.
 *  returns the track eid. */
export function createTrack(ecs: State): number {
    const trackEid = ecs.create();
    ecs.add(trackEid, Track);
    Track.count.set(trackEid, 0);
    Track.ds.set(trackEid, DS_NOMINAL);
    Track.v0.set(trackEid, V0);
    Track.domain.set(trackEid, Domain.Distance);
    samples.set(trackEid, {
        posX: new Float32Array(MAX_SAMPLES),
        posY: new Float32Array(MAX_SAMPLES),
        theta: new Float32Array(MAX_SAMPLES),
        v: new Float32Array(MAX_SAMPLES),
    });
    bakeOut.set(trackEid, {
        fN: new Float32Array(MAX_SAMPLES - 1),
        ds: new Float32Array(MAX_SAMPLES - 1),
        t: new Float32Array(MAX_SAMPLES),
        tTotal: 0,
        feasible: new Uint8Array(MAX_SAMPLES),
        firstInfeasible: -1,
        hash: "",
    });
    return trackEid;
}

// ── sections ─────────────────────────────────────────────────────────────────

// monotone id source — never reused, even after a delete: history can re-spawn any
// deleted section, so a scan-the-live-set allocator would alias a fresh section
// with a restorable one (the eid-recycling bug one level up).
let nextSectionId = 0;

/** a section read off the ECS: eid + its stable id, chain order, kind, force
 *  extent, and its own baking step (0 = the track-nominal `Track.ds`). */
export interface SectionRow {
    eid: number;
    id: number;
    order: number;
    kind: SectionKind;
    length: number;
    ds: number;
}

/** every section, sorted by chain order — the sequence the bake threads and the
 *  UI walks. */
export function sections(ecs: State): SectionRow[] {
    const rows: SectionRow[] = [];
    for (const eid of ecs.query([Section])) {
        rows.push({
            eid,
            id: Section.id.get(eid),
            order: Section.order.get(eid),
            kind: Section.kind.get(eid) as SectionKind,
            length: Section.length.get(eid),
            ds: Section.ds.get(eid),
        });
    }
    rows.sort((a, b) => a.order - b.order);
    return rows;
}

/** resolve a section by its stable id to its eid, or null. */
export function sectionAt(ecs: State, id: number): number | null {
    for (const eid of ecs.query([Section])) {
        if (Section.id.get(eid) === id) return eid;
    }
    return null;
}

/** a section's place on the global distance axis: its stable id, its `offset` (the
 *  track-global distance `d` at its entry = the cumulative baked arclength of every
 *  upstream section), and its `len` (its own baked arclength). the section occupies the
 *  d-interval `[offset, offset + len]`. */
export interface SectionSpan {
    id: number;
    offset: number;
    len: number;
}

/** the coordinate lens — the ONE seam between the author-facing track-global distance
 *  `d` (meters, the timeline ruler) and the section-local arclength `s` the substrate
 *  stores. `sectionSpans` is its table (one accumulating pass over the baked ds), and
 *  `toGlobal`/`toLocal` are the affine `d = offset + s` and its inverse. every d readout
 *  — timeline clips/boundaries, force-point placement, cart park — derives here; nothing
 *  walks the cumulative ds itself. sections are contiguous (each shares its entry sample
 *  with the prior exit), so one pass suffices. */
export function sectionSpans(ecs: State, eid: number): SectionSpan[] {
    const out = bakeOut.get(eid);
    if (!out) return [];
    const res: SectionSpan[] = [];
    let cum = 0;
    for (const sec of sections(ecs)) {
        const info = sectionInfo.get(sec.id);
        if (!info) continue;
        const offset = cum;
        for (let i = info.startSample; i < info.endSample; i++) cum += out.ds[i];
        res.push({ id: sec.id, offset, len: cum - offset });
    }
    return res;
}

/** section-local `(section, s)` → track-global distance `d = offset + s`. null when the
 *  section isn't on the current bake. */
export function toGlobal(spans: SectionSpan[], section: number, s: number): number | null {
    const sp = spans.find((x) => x.id === section);
    return sp ? sp.offset + s : null;
}

/** track-global distance `d` → the section-local address `(section, s)`. boundary policy:
 *  a `d` on a shared section boundary resolves to the UPSTREAM (earlier) section — the
 *  first span whose exit reaches `d` wins (left/upstream-inclusive spans), matching the
 *  clip strip's boundary guides and the cart's park resolution. out-of-range `d` resolves
 *  to the nearest end of the track. null when there's no bake. */
export function toLocal(spans: SectionSpan[], d: number): { section: number; s: number } | null {
    if (spans.length === 0) return null;
    for (const sp of spans) {
        if (d <= sp.offset + sp.len) return { section: sp.id, s: Math.max(0, d - sp.offset) };
    }
    const last = spans[spans.length - 1];
    return { section: last.id, s: last.len };
}

/** create a section at `order` with a fresh stable id — the append/seed path.
 *  `ds` is its baking step, defaulting to the track-nominal sentinel 0 (only an
 *  invoked solve's output carries its own step).
 *  returns the id (undo/redo, membership, and selection address by id). */
export function createSection(
    ecs: State,
    order: number,
    kind: SectionKind,
    length: number,
    ds = 0,
): number {
    const eid = ecs.create();
    ecs.add(eid, Section);
    const id = nextSectionId++;
    Section.id.set(eid, id);
    Section.order.set(eid, order);
    Section.kind.set(eid, kind);
    Section.length.set(eid, length);
    Section.ds.set(eid, ds);
    return id;
}

/** re-create a section at an *exact* id / order / kind / length — undo of a delete,
 *  redo of a create, or a snapshot restore. no id allocation, so it round-trips
 *  byte-identical. its nodes/points are respawned separately. */
function spawnSection(
    ecs: State,
    id: number,
    order: number,
    kind: SectionKind,
    length: number,
    ds: number,
): void {
    const eid = ecs.create();
    ecs.add(eid, Section);
    Section.id.set(eid, id);
    Section.order.set(eid, order);
    Section.kind.set(eid, kind);
    Section.length.set(eid, length);
    Section.ds.set(eid, ds);
}

// ── geo nodes (section-local) ────────────────────────────────────────────────

/** collect every node on a section, sorted by `Handle.order`. ECS query order
 *  isn't guaranteed; the bake and the heading walk need deterministic order. */
export function sectionHandles(ecs: State, sectionId: number): number[] {
    const eids: number[] = [];
    for (const eid of ecs.query([Handle])) {
        if (Handle.section.get(eid) === sectionId) eids.push(eid);
    }
    eids.sort((a, b) => Handle.order.get(a) - Handle.order.get(b));
    return eids;
}

/** highest-order node on a section, or null when empty. */
export function lastHandle(ecs: State, sectionId: number): number | null {
    let best: number | null = null;
    let bestOrder = -1;
    for (const eid of ecs.query([Handle])) {
        if (Handle.section.get(eid) !== sectionId) continue;
        const o = Handle.order.get(eid);
        if (o > bestOrder) {
            bestOrder = o;
            best = eid;
        }
    }
    return best;
}

/** append a node at the section's end (order = maxOrder + 1) at **section-local**
 *  `(x, y)`. the new node's heading is the circular-arc exit from its predecessor's
 *  heading (`reflect`): placed straight ahead it continues straight, off-axis it
 *  bends one arc. node 0 (local origin, the section entry) is a fixed flat anchor
 *  (θ = 0) — the section always leaves its entry along the entry heading, and node 1
 *  reflects that. */
export function addNode(ecs: State, sectionId: number, x: number, y: number): number {
    const prev = lastHandle(ecs, sectionId);
    const order = prev === null ? 0 : Handle.order.get(prev) + 1;
    const eid = ecs.create();
    ecs.add(eid, Handle);
    Handle.section.set(eid, sectionId);
    Handle.order.set(eid, order);
    Handle.sample.set(eid, 0);
    Handle.pos.set(eid, x, y);
    writeTangent(eid, undefined); // a fresh node is Auto — the arc rule (the live growth tip)
    invalidateBake(ecs);
    if (prev === null) {
        Handle.theta.set(eid, 0); // node 0 is a fixed local flat anchor (the entry)
    } else {
        const chord = Math.atan2(y - Handle.pos.y.get(prev), x - Handle.pos.x.get(prev));
        Handle.theta.set(eid, reflect(exitHeading(prev), chord));
        // the old tip becomes interior but stays live (`Auto`) — the default add/drag flow stores
        // NO tangents and shapes exactly like the pre-handles editor (frozen interior heading,
        // chord-scaled length, tip reflection). a node turns concrete bezier only when authored
        // (a handle drag or a mode set), never at append.
    }
    return eid;
}

/** a node's exit heading — the direction its curve leaves along. an explicit node exits along
 *  its stored out-vector (the departure tangent); an `Auto` node exits along its stored heading
 *  `theta` (the arc rule points the handle exactly there). the append direction and the `reflect`
 *  seed derive from this, so an explicit tip appends along the visible curve, not a stale
 *  `Handle.theta` (which explicit tangents decouple from the recovered heading). */
function exitHeading(eid: number): number {
    const tan = readTangent(eid);
    return tan ? Math.atan2(tan.outY, tan.outX) : Handle.theta.get(eid);
}

/** a node's exit heading in **world** space — its section-local `exitHeading` rotated into world
 *  by the section entry frame (the same rotation `tangents.ts` applies to place a handle). the
 *  authored exit direction the selected-node readout reports: an explicit out-vector else the
 *  stored `Auto` heading, both section-local, carried to world here. never a bake re-derivation, so
 *  it holds constant while a handle drags along an engaged angle-snap ray. one source with
 *  `exitHeading` (the append/reflect reader) — the readout doesn't invent a third. */
export function exitWorld(eid: number): number {
    const info = sectionInfo.get(Handle.section.get(eid));
    return exitHeading(eid) + (info ? info.entry.theta : 0);
}

/** resolve a node by its section + stable `order` to its eid, or null. undo/redo
 *  address nodes by (section, order) — a stable identity for the append/delete-
 *  trailing chain (an interior node's order never changes), so a recycled eid across
 *  a delete→undo can't alias the wrong node. */
export function handleAt(ecs: State, sectionId: number, order: number): number | null {
    for (const eid of ecs.query([Handle])) {
        if (Handle.section.get(eid) === sectionId && Handle.order.get(eid) === order) return eid;
    }
    return null;
}

/** re-create a node at an *exact* section / order / position / heading (+ optional
 *  explicit tangent) — no `reflect`, no rehead. restores a node deleted by a trim
 *  (undo) or re-adds one dropped by an extend (redo); the saved state is replayed
 *  verbatim so the bake reproduces the same curve. an absent `tan` is `Auto`. */
export function spawnNode(
    ecs: State,
    sectionId: number,
    order: number,
    x: number,
    y: number,
    theta: number,
    tan?: Tangent,
): number {
    const eid = ecs.create();
    ecs.add(eid, Handle);
    Handle.section.set(eid, sectionId);
    Handle.order.set(eid, order);
    Handle.sample.set(eid, 0);
    Handle.pos.set(eid, x, y);
    Handle.theta.set(eid, theta);
    writeTangent(eid, tan);
    invalidateBake(ecs);
    return eid;
}

/** a node's undoable pose — section-local position + stored heading + its explicit
 *  tangent (absent = Auto), keyed by stable order within its section. */
export interface NodeState {
    order: number;
    x: number;
    y: number;
    theta: number;
    tangent?: Tangent;
}

/** snapshot every node's pose on a section (a handful of nodes). the move gesture
 *  captures this before/after a drag; a drag never adds or removes a node, so the
 *  two snapshots share the same order set. */
export function nodeSnapshot(ecs: State, sectionId: number): NodeState[] {
    const snap: NodeState[] = [];
    for (const eid of sectionHandles(ecs, sectionId)) {
        snap.push({
            order: Handle.order.get(eid),
            x: Handle.pos.x.get(eid),
            y: Handle.pos.y.get(eid),
            theta: Handle.theta.get(eid),
            tangent: readTangent(eid),
        });
    }
    return snap;
}

/** whether two explicit tangents are equal (both absent = equal). */
function sameTangent(a?: Tangent, b?: Tangent): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return (
        a.mode === b.mode &&
        a.inX === b.inX &&
        a.inY === b.inY &&
        a.outX === b.outX &&
        a.outY === b.outY
    );
}

/** whether two node snapshots are pose-identical (matched by stable order),
 *  including the explicit tangent. the gesture no-op test for any surface that
 *  moves nodes or edits their tangents. */
export function sameNodes(a: NodeState[], b: NodeState[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const bi = b.find((n) => n.order === a[i].order);
        if (!bi || bi.x !== a[i].x || bi.y !== a[i].y || bi.theta !== a[i].theta) return false;
        if (!sameTangent(bi.tangent, a[i].tangent)) return false;
    }
    return true;
}

/** write a node snapshot back onto a section's live nodes by order (move undo/redo
 *  and gesture cancel). pose + explicit tangent are restored; the node set is
 *  unchanged. */
export function restoreNodes(ecs: State, sectionId: number, snap: NodeState[]): void {
    for (const s of snap) {
        const eid = handleAt(ecs, sectionId, s.order);
        if (eid === null) continue;
        Handle.pos.set(eid, s.x, s.y);
        Handle.theta.set(eid, s.theta);
        writeTangent(eid, s.tangent);
    }
}

/** a node's explicit tangent, or undefined when it's `Auto` — the read for the
 *  tangent-handle UI and tests. */
export function handleTangent(ecs: State, sectionId: number, order: number): Tangent | undefined {
    const eid = handleAt(ecs, sectionId, order);
    return eid === null ? undefined : readTangent(eid);
}

/** seed an explicit tangent from a node's current `Auto` arc-rule tangents, so summoning
 *  explicit (the popover mode control or a handle pull) starts from exactly what the arc
 *  rule draws — the Auto→explicit conversion is visually continuous (`spline.autoTangent`
 *  reproduces the bake's own tangent). the in-vector reads the live section-local chord
 *  from the previous node, the out-vector the chord to the next; a chain end with no
 *  outgoing segment mirrors the incoming length forward along the heading. returns a
 *  `Tangent` in `mode` (the two vectors share direction `theta`, so it's a valid `Aligned`
 *  seed and bit-continuous with the Auto bake). */
export function seedTangent(
    ecs: State,
    sectionId: number,
    order: number,
    mode: TangentMode,
): Tangent | null {
    const eid = handleAt(ecs, sectionId, order);
    if (eid === null) return null;
    const nx = Handle.pos.x.get(eid);
    const ny = Handle.pos.y.get(eid);
    const th = Handle.theta.get(eid);

    const prev = handleAt(ecs, sectionId, order - 1);
    let inVec: [number, number];
    if (prev !== null) {
        const dx = nx - Handle.pos.x.get(prev);
        const dy = ny - Handle.pos.y.get(prev);
        inVec = autoTangent(th, Math.atan2(dy, dx), Math.hypot(dx, dy));
    } else {
        inVec = [Math.cos(th), Math.sin(th)]; // no incoming segment (order 0 — not summonable)
    }

    const next = handleAt(ecs, sectionId, order + 1);
    let outVec: [number, number];
    if (next !== null) {
        const dx = Handle.pos.x.get(next) - nx;
        const dy = Handle.pos.y.get(next) - ny;
        outVec = autoTangent(th, Math.atan2(dy, dx), Math.hypot(dx, dy));
    } else {
        // a chain end drives no outgoing segment; mirror the incoming length forward so the
        // out-handle has a sensible (invisible) value for the Aligned coupling.
        const inLen = Math.hypot(inVec[0], inVec[1]);
        outVec = [inLen * Math.cos(th), inLen * Math.sin(th)];
    }

    return { mode, inX: inVec[0], inY: inVec[1], outX: outVec[0], outY: outVec[1] };
}

/** set (or clear, with null) a node's explicit tangent — the programmatic tangent
 *  setter the summon/handle-drag gestures (and tests) write through. `null` reverts
 *  the node to `Auto`. does not itself record history — a gesture (`beginMove` /
 *  a discrete command) wraps it, and `nodeSnapshot` captures the tangent for undo. */
export function setTangent(
    ecs: State,
    sectionId: number,
    order: number,
    tan: Tangent | null,
): void {
    const eid = handleAt(ecs, sectionId, order);
    if (eid !== null) writeTangent(eid, tan ?? undefined);
}

/** the standing invariant: the last (heading) node's angle is the circular-arc
 *  reflection of its predecessor's heading about their chord. re-derived whenever
 *  the chain's tail changes so the tip's angle is never stale. takes the section's
 *  sorted handles; no-op below two nodes. */
function headLast(handles: number[]): void {
    const n = handles.length;
    if (n < 2) return;
    const last = handles[n - 1];
    const prev = handles[n - 2];
    const chord = Math.atan2(
        Handle.pos.y.get(last) - Handle.pos.y.get(prev),
        Handle.pos.x.get(last) - Handle.pos.x.get(prev),
    );
    Handle.theta.set(last, reflect(exitHeading(prev), chord));
}

/** the Reset action: clear a node's explicit tangent back to live (`Auto` inference resumes).
 *  meaningful for any node: an interior re-uses its frozen arc-rule heading, the growth tip
 *  re-tracks its predecessor (its heading re-derived), and node 0 (the entry anchor, editable via
 *  its out-handle) returns to the `Auto` C1 exit along the entry heading. does not itself record
 *  history — a gesture (`beginMove`/`commit`) wraps it, `nodeSnapshot` captures the tangent + theta
 *  for undo. node 0 is never the chain tip, so it never triggers the tip re-head. */
export function resetTangent(ecs: State, sectionId: number, order: number): void {
    const handles = sectionHandles(ecs, sectionId);
    if (handles.length === 0) return;
    const eid = handleAt(ecs, sectionId, order);
    if (eid === null) return;
    writeTangent(eid, undefined); // clear to live
    if (eid === handles[handles.length - 1]) headLast(handles); // the tip re-tracks its predecessor
}

/** refresh headings after a node is dragged. the **last** (heading) node always
 *  tracks its predecessor (re-derives when it or the node before it moves); node 0
 *  (the flat anchor) and **interior** nodes keep their heading frozen — the arc
 *  contract can't hold on both of an interior node's segments at once, so a stable
 *  heading beats one that thrashes. a drag only changes the last node's heading, so
 *  the edit stays local; tangent lengths re-proportion automatically. */
export function reheadOnDrag(ecs: State, eid: number): void {
    const sectionId = Handle.section.get(eid);
    const handles = sectionHandles(ecs, sectionId);
    const last = handles.length - 1;
    if (last < 1) return;
    const idx = handles.indexOf(eid);
    if (idx === last || idx === last - 1) headLast(handles);
}

/** lay a new node past a section's end, continuing straight along the last node's
 *  exit heading by the session's sticky chord (`stickyLen(Geo)` — the last committed
 *  length adjust, `EXTEND_DIST` until one lands), in the section-local frame — the
 *  "extend" gesture. placing it along the heading makes `reflect` return the same heading, so
 *  the new segment opens straight. returns the new node. */
export function extend(ecs: State, sectionId: number): number {
    const last = lastHandle(ecs, sectionId);
    if (last === null) return addNode(ecs, sectionId, 0, 0);
    // continue along the tip's actual exit — its explicit out-vector when authored, else its
    // stored heading (the arc rule exits exactly along `theta`). placing straight along the exit
    // makes `reflect` return it, so the new segment opens straight.
    const th = exitHeading(last);
    const lx = Handle.pos.x.get(last);
    const ly = Handle.pos.y.get(last);
    const chord = stickyLen(SectionKind.Geo);
    return addNode(ecs, sectionId, lx + Math.cos(th) * chord, ly + Math.sin(th) * chord);
}

/** remove the trailing (highest-order) node on a section — never below the two
 *  nodes a geo section needs (node 0 the entry + one shape node). the promoted tip
 *  is reconciled to a well-formed tip: its explicit tangent is cleared to `Auto`
 *  and its heading re-derived (`headLast`) — the same reset a tip gets from
 *  `resetTangent`. returns true when a node was removed. */
export function removeTrailingHandle(ecs: State, sectionId: number): boolean {
    const last = lastHandle(ecs, sectionId);
    if (last === null) return false;
    if (sectionHandles(ecs, sectionId).length <= 2) return false;
    ecs.destroy(last);
    const handles = sectionHandles(ecs, sectionId);
    // the promoted node was authored as an interior node: its out-vector shaped the segment we
    // just deleted, so that vector is now ghost state pointing at where the trailing node stood.
    // an explicit node's `Handle.theta` is dead (`exitHeading`/the bake read the out-vector), so
    // `headLast` alone would silently no-op and the tip would report/extend along the stale
    // out-vector. clear to `Auto` first so `headLast` actually governs — a delete now yields the
    // same tip regardless of the promoted node's mode, indistinguishable from having authored the
    // shorter chain directly. undo restores the tangent (`trimTrack` snapshots after this).
    writeTangent(handles[handles.length - 1], undefined);
    headLast(handles); // the promoted tip re-derives its heading from its new predecessor
    return true;
}

// ── force points ─────────────────────────────────────────────────────────────

/** an authored force keyframe read off the ECS: eid + section, stable `id`,
 *  arclength `s` (from the section entry), and demanded force `g`. */
export interface ForceRow {
    eid: number;
    section: number;
    id: number;
    s: number;
    g: number;
}

/** every force point on a section, sorted by arclength — the order `forceProfile`
 *  and the timeline both consume. */
export function sectionForces(ecs: State, sectionId: number): ForceRow[] {
    const rows: ForceRow[] = [];
    for (const eid of ecs.query([Force])) {
        if (Force.section.get(eid) !== sectionId) continue;
        rows.push({
            eid,
            section: sectionId,
            id: Force.id.get(eid),
            s: Force.s.get(eid),
            g: Force.g.get(eid),
        });
    }
    rows.sort((a, b) => a.s - b.s);
    return rows;
}

/** resolve a force point by its stable `id` to its eid, or null (ids are globally
 *  unique — undo/redo never holds eids, so a recycled eid can't alias). */
export function forceAt(ecs: State, id: number): number | null {
    for (const eid of ecs.query([Force])) {
        if (Force.id.get(eid) === id) return eid;
    }
    return null;
}

// monotone id source — never reused, even after a delete (the section-id rationale).
let nextForceId = 0;

/** author a new force point on a section at `(s, g)` with a fresh stable id — the
 *  create path. returns the id (undo/redo addresses points by id, not eid). */
export function createForcePoint(ecs: State, sectionId: number, s: number, g: number): number {
    const eid = ecs.create();
    ecs.add(eid, Force);
    const id = nextForceId++;
    Force.section.set(eid, sectionId);
    Force.id.set(eid, id);
    Force.s.set(eid, s);
    Force.g.set(eid, g);
    Force.ease.set(eid, FORCE_EASE_DEFAULT); // a fresh keyframe is the default ease, no handles
    writeForceTangent(eid, undefined);
    return id;
}

/** re-create a force point at an *exact* section / id / s / g (+ easing tag and
 *  optional explicit handles) — undo of a delete, redo of a create, or a snapshot
 *  restore. no id allocation, so it round-trips byte-identical. an absent `tan`
 *  derives from `ease`. */
export function spawnForce(
    ecs: State,
    sectionId: number,
    id: number,
    s: number,
    g: number,
    ease: Easing = FORCE_EASE_DEFAULT,
    tan?: ForceTangent,
): void {
    const eid = ecs.create();
    ecs.add(eid, Force);
    Force.section.set(eid, sectionId);
    Force.id.set(eid, id);
    Force.s.set(eid, s);
    Force.g.set(eid, g);
    Force.ease.set(eid, ease);
    writeForceTangent(eid, tan);
}

/** destroy a force point by stable id (no-op if already gone). */
export function destroyForce(ecs: State, id: number): void {
    const eid = forceAt(ecs, id);
    if (eid !== null) ecs.destroy(eid);
}

/** a force point's undoable state, keyed by stable id: its position (`s`/`g`), its easing
 *  tag, and its explicit handles. `section` records which section owns the point;
 *  `restoreForcePoint` addresses the existing point by id and does NOT rewrite `Force.section`
 *  — a point changes section only inside a structural op, which snapshots the whole track. the
 *  drag/field/easing gestures snapshot this. */
export interface ForcePointState {
    section: number;
    id: number;
    s: number;
    g: number;
    ease: Easing;
    tangent?: ForceTangent;
}

/** snapshot one force point by id, or undefined if it's gone (the gesture opens
 *  nothing). */
export function forcePointState(ecs: State, id: number): ForcePointState | undefined {
    const eid = forceAt(ecs, id);
    if (eid === null) return undefined;
    return {
        section: Force.section.get(eid),
        id,
        s: Force.s.get(eid),
        g: Force.g.get(eid),
        ease: Force.ease.get(eid) as Easing,
        tangent: readForceTangent(eid),
    };
}

/** write a force point's `s`/`g` (live drag preview + gesture restore). the position
 *  writer only — easing/handles are untouched (a position drag leaves them). */
export function setForcePoint(ecs: State, id: number, s: number, g: number): void {
    const eid = forceAt(ecs, id);
    if (eid === null) return;
    Force.s.set(eid, s);
    Force.g.set(eid, g);
}

/** write a force point's full state back — position, easing tag, and explicit handles
 *  (the gesture restore / undo path, symmetric with `forcePointState`). */
export function restoreForcePoint(ecs: State, st: ForcePointState): void {
    const eid = forceAt(ecs, st.id);
    if (eid === null) return;
    Force.s.set(eid, st.s);
    Force.g.set(eid, st.g);
    Force.ease.set(eid, st.ease);
    writeForceTangent(eid, st.tangent);
}

/** a force keyframe's explicit handles by stable id, or undefined when it derives
 *  from `ease` — the read for the handle UI and tests (mirrors geo's `handleTangent`). */
export function forceTangent(ecs: State, id: number): ForceTangent | undefined {
    const eid = forceAt(ecs, id);
    return eid === null ? undefined : readForceTangent(eid);
}

/** a force keyframe's easing tag by stable id (default `Easing.Cubic`). */
export function forceEase(ecs: State, id: number): Easing {
    const eid = forceAt(ecs, id);
    return eid === null ? FORCE_EASE_DEFAULT : (Force.ease.get(eid) as Easing);
}

/** set a force keyframe's easing tag (the convenient middle layer). the raw writer a
 *  history one-shot wraps; does not itself record history. */
export function setForceEase(ecs: State, id: number, ease: Easing): void {
    const eid = forceAt(ecs, id);
    if (eid !== null) Force.ease.set(eid, ease);
}

/** set (or clear, with null) a force keyframe's explicit handles — the summon / handle-
 *  drag writer. `null` reverts to the `ease`-derived tangents. does not itself record
 *  history (a gesture wraps it; `forcePointState` captures the handles for undo). */
export function setForceTangent(ecs: State, id: number, tan: ForceTangent | null): void {
    const eid = forceAt(ecs, id);
    if (eid !== null) writeForceTangent(eid, tan ?? undefined);
}

/** clear ONE side (in/out) of a force keyframe's explicit handles back to derived,
 *  keeping the other side. the segment-scoped Reset: choosing a preset on the leading
 *  keyframe clears the addressed segment's two bounding sides — this keyframe's out and
 *  the next keyframe's in — never the far sides, which belong to the neighbouring
 *  segments. no-op when the side is already derived. */
export function clearForceTangentSide(ecs: State, id: number, side: "in" | "out"): void {
    const eid = forceAt(ecs, id);
    if (eid === null) return;
    const tan = readForceTangent(eid);
    if (!tan) return;
    if (side === "in") tan.in = undefined;
    else tan.out = undefined;
    writeForceTangent(eid, tan);
}

/** the next force keyframe after `id` in its own section (ascending s), or null when
 *  `id` is the section's last — the trailing bound of the segment a preset/Custom on
 *  `id` addresses. */
export function nextForce(ecs: State, id: number): number | null {
    const eid = forceAt(ecs, id);
    if (eid === null) return null;
    const rows = sectionForces(ecs, Force.section.get(eid));
    const idx = rows.findIndex((r) => r.id === id);
    return idx >= 0 && idx < rows.length - 1 ? rows[idx + 1].id : null;
}

// ── force-section extent ──────────────────────────────────────────────────────

/** a force section's undoable extent, keyed by stable id — the end-handle drag
 *  gesture snapshots this. */
export interface SectionLengthState {
    id: number;
    length: number;
}

/** snapshot a section's extent by id, or undefined if it's gone. */
export function sectionLengthState(ecs: State, id: number): SectionLengthState | undefined {
    const eid = sectionAt(ecs, id);
    return eid === null ? undefined : { id, length: Section.length.get(eid) };
}

/** set a force section's extent, in the track's active domain unit, floored at that
 *  domain's minimum (`minForceExtent`) — the end-handle drag + gesture restore. re-bakes on
 *  the next tick (the extent is in the bake hash). */
export function setSectionLength(ecs: State, id: number, length: number): void {
    const eid = sectionAt(ecs, id);
    if (eid === null) return;
    Section.length.set(eid, Math.max(minForceExtent(trackDomain(ecs)), length));
}

// ── track initial speed (v0) ───────────────────────────────────────────────────

/** the track's undoable initial speed (m/s) — the START handle's scrub/type gesture
 *  snapshots this. */
export interface TrackV0State {
    v0: number;
}

/** snapshot a track's authored initial speed. */
export function trackV0State(trackEid: number): TrackV0State {
    return { v0: Track.v0.get(trackEid) };
}

/** set the track's initial speed (m/s), floored at MIN_V0 — the field/scrub write +
 *  gesture restore. re-bakes on the next tick (v0 is in the bake hash). */
export function setTrackV0(trackEid: number, v0: number): void {
    Track.v0.set(trackEid, Math.max(MIN_V0, v0));
}

// ── track domain ───────────────────────────────────────────────────────────────

/** the track entity, or null on an empty world — the one resolver every track-scalar read uses,
 *  so `trackDs` / `trackDomain` / a caller needing the eid can't disagree about WHICH track
 *  (there is one; a second would be a chain, not a track). */
export function trackEntity(ecs: State): number | null {
    for (const t of ecs.query([Track])) return t;
    return null;
}

/** the track-global domain every force section's keyframes and extent are stored in
 *  (`Track.domain`). `Distance` for a track with no `Track` entity, so a bare read is never a
 *  surprise unit. */
export function trackDomain(ecs: State): Domain {
    const t = trackEntity(ecs);
    return t === null ? Domain.Distance : (Track.domain.get(t) as Domain);
}

/** write the track-global domain. **The stored numbers are NOT converted here** — this is the
 *  raw column write; flipping the domain without converting the store re-interprets every
 *  keyframe in the new unit. The one sanctioned caller is `history.landDomain`, which pairs it
 *  with the converted document and the undo entry. */
export function setTrackDomain(ecs: State, domain: Domain): void {
    const t = trackEntity(ecs);
    if (t !== null) Track.domain.set(t, domain);
}

// ── per-section kind + conversion ─────────────────────────────────────────────

/** one section's full undoable state: its identity/order, kind, force extent, its
 *  geo nodes, and its force points. a destructive convert (or a structural op)
 *  snapshots this before/after so undo is byte-identical. */
export interface SectionSnapshot {
    id: number;
    order: number;
    kind: SectionKind;
    length: number;
    ds: number;
    nodes: NodeState[];
    points: { id: number; s: number; g: number; ease: Easing; tangent?: ForceTangent }[];
}

/** capture a section (both kinds' payloads — one is empty). a force point carries its
 *  easing tag + explicit handles, so a convert/structural-op undo restores them. */
export function snapshotSection(ecs: State, sectionId: number): SectionSnapshot {
    const eid = sectionAt(ecs, sectionId);
    if (eid === null) throw new Error(`snapshotSection: no section ${sectionId}`);
    return {
        id: sectionId,
        order: Section.order.get(eid),
        kind: Section.kind.get(eid) as SectionKind,
        length: Section.length.get(eid),
        ds: Section.ds.get(eid),
        nodes: nodeSnapshot(ecs, sectionId),
        points: sectionForces(ecs, sectionId).map((p) => ({
            id: p.id,
            s: p.s,
            g: p.g,
            ease: Force.ease.get(p.eid) as Easing,
            tangent: readForceTangent(p.eid),
        })),
    };
}

/** clear a section's payload and rebuild it verbatim from a snapshot — restores a
 *  convert (either direction) or a structural op byte-identical. the Section entity
 *  is assumed to exist (its order/kind/length are rewritten); nodes respawn by
 *  order, points by id, so eids recycle but identities don't. */
export function restoreSection(ecs: State, snap: SectionSnapshot): void {
    const eid = sectionAt(ecs, snap.id);
    if (eid === null) throw new Error(`restoreSection: no section ${snap.id}`);
    for (const h of sectionHandles(ecs, snap.id)) ecs.destroy(h);
    for (const p of sectionForces(ecs, snap.id)) ecs.destroy(p.eid);
    Section.order.set(eid, snap.order);
    Section.kind.set(eid, snap.kind);
    Section.length.set(eid, snap.length);
    Section.ds.set(eid, snap.ds);
    for (const n of snap.nodes) spawnNode(ecs, snap.id, n.order, n.x, n.y, n.theta, n.tangent);
    for (const p of snap.points) spawnForce(ecs, snap.id, p.id, p.s, p.g, p.ease, p.tangent);
}

/** write a domain conversion's converted force store in place: each force section's extent and
 *  step, and each keyframe's position and explicit handles, addressed by stable id. Deliberately
 *  narrow — **no entity is created or destroyed**, so a live selection (which addresses a geo node
 *  by eid) survives a domain flip, and geo payloads are never touched. Everything a conversion
 *  leaves alone (`g`, the easing tag, orders, identities) is simply not written. Its input is
 *  already fully computed, so the write cannot fail part-way; `history.landDomain` is the one
 *  caller, and undo/redo goes back through the whole-track `restoreAll` pair instead. */
export function applyDomain(ecs: State, snaps: readonly SectionSnapshot[]): void {
    for (const snap of snaps) {
        if (snap.kind !== SectionKind.Force) continue;
        const eid = sectionAt(ecs, snap.id);
        if (eid === null) continue;
        Section.length.set(eid, snap.length);
        Section.ds.set(eid, snap.ds);
        for (const p of snap.points) {
            const pointEid = forceAt(ecs, p.id);
            if (pointEid === null) continue;
            Force.s.set(pointEid, p.s);
            writeForceTangent(pointEid, p.tangent);
        }
    }
}

/** force the next `BakeSystem` pass to bake, whatever the authored state hashes to.
 *  called by the two node creators (`addNode`/`spawnNode`), so ANY respawn invalidates:
 *  a fresh node's `Handle.sample` is 0, and authored content that round-trips inside one
 *  frame hashes exactly like the live bake (an op and its undo, a geo→force→geo convert, a
 *  trim then extend) — the hash gate would then skip forever and leave the node→sample map
 *  reading the track origin, so `pickNode`/`nodeAt` see every node stacked at sample 0.
 *  `bakeHash` never produces "", so this can't collide with a real state. */
function invalidateBake(ecs: State): void {
    for (const t of ecs.query([Track])) {
        const out = bakeOut.get(t);
        if (out) out.hash = "";
    }
}

/** the recovered force (g) arriving at a boundary sample from the current bake — the
 *  edge leading into `entrySample` (`fN[entrySample − 1]`). `DEFAULT_G` at the track
 *  start (sample 0) or with no bake. seeds a fresh force section so it continues the
 *  incoming force, *stamped* at creation: an absolute authored value, never a live
 *  endpoint (a live endpoint would let an upstream edit rewrite authored force —
 *  the hidden-global-support failure mode). */
function bakeEntryForce(ecs: State, entrySample: number): number {
    if (entrySample < 1) return DEFAULT_G;
    for (const t of ecs.query([Track])) {
        const out = bakeOut.get(t);
        if (out && entrySample < Track.count.get(t)) return out.fN[entrySample - 1];
    }
    return DEFAULT_G;
}

/** seed a fresh force section with the two continuation keyframes: (0, g) at the
 *  entry and (length, g) at the exit, both holding the recovered entry force `g`. the
 *  starting profile is a flat continuation of the incoming force, then authored from
 *  there (deletion down to empty stays legal — the `DEFAULT_G` fallback remains). */
function seedForceKeyframes(ecs: State, sectionId: number, length: number, g: number): void {
    createForcePoint(ecs, sectionId, 0, g);
    createForcePoint(ecs, sectionId, length, g);
}

/** destructively flip a section's kind to its opposite, resetting to that kind's
 *  default: geo → force clears the nodes and seeds the two continuation keyframes at
 *  the recovered entry force (a flat continuation over the default extent); force →
 *  geo clears the points for the flat two-node seed. the baking step resets to the
 *  nominal sentinel with them — a stored step belongs to the solve that produced the
 *  payload, and this discards that payload. undo (a `snapshotSection` pair)
 *  makes it safe, so there's no confirmation. does not itself record history —
 *  `history.convertSection` wraps it. */
export function convertSection(ecs: State, sectionId: number): void {
    const eid = sectionAt(ecs, sectionId);
    if (eid === null) return;
    Section.ds.set(eid, 0);
    const kind = Section.kind.get(eid);
    if (kind === SectionKind.Geo) {
        // recover the entry force from the current (pre-convert, geo) bake before the
        // reset — the seed continues the incoming force, stamped at creation.
        const info = sectionInfo.get(sectionId);
        const gEntry = info ? bakeEntryForce(ecs, info.startSample) : DEFAULT_G;
        for (const h of sectionHandles(ecs, sectionId)) ecs.destroy(h);
        Section.kind.set(eid, SectionKind.Force);
        // the default extent in the TRACK's active domain — a literal meters constant would be
        // a 24-second, 480-edge section on a Time-domain track.
        const extent = defaultForceExtent(trackDomain(ecs));
        Section.length.set(eid, extent); // reset to the default extent, not inherited
        seedForceKeyframes(ecs, sectionId, extent, gEntry);
    } else {
        for (const p of sectionForces(ecs, sectionId)) ecs.destroy(p.eid);
        Section.kind.set(eid, SectionKind.Geo);
        Section.length.set(eid, 0);
        addNode(ecs, sectionId, 0, 0);
        addNode(ecs, sectionId, EXTEND_DIST, 0);
    }
}

/** an invoked solve's authored output: the keyframes it emitted, and the extent + step they
 *  were solved for. the conversion tier's `ConvertResult` (`refine.ts`) satisfies this
 *  structurally, so the document layer reads a solve without depending on the solver — the
 *  invoked atoms stay off this module's graph. */
export interface SolvedForce {
    points: readonly { s: number; g: number }[];
    length: number;
    ds: number;
}

/** land an invoked geo→force solve's output on its section — the conversion's whole document
 *  write. the shape nodes go, the kind flips, and the section takes the solve's REALIZED
 *  extent and step (`length/edges`, the march that closes the exit the solve pinned —
 *  `refine.ts`), then its `{s, g}` keyframes spawn: every one default-Cubic with no handles,
 *  which is the narrow dialect the conversion emits by construction. nothing else of a solve
 *  persists — outcome/floor/deviation/probes are the caller's transient readout, never
 *  document state.
 *
 *  distinct from `convertSection`: that one is the destructive *reset* to the kind's default
 *  (the two continuation keyframes at the default extent, step back to the sentinel); this one
 *  replaces the section with a solved shape-preserving profile. does not itself record history
 *  — `history.solveForce` wraps it. */
export function applyConvert(ecs: State, sectionId: number, solved: SolvedForce): void {
    const eid = sectionAt(ecs, sectionId);
    if (eid === null) throw new Error(`applyConvert: no section ${sectionId}`);
    for (const h of sectionHandles(ecs, sectionId)) ecs.destroy(h);
    for (const p of sectionForces(ecs, sectionId)) ecs.destroy(p.eid);
    Section.kind.set(eid, SectionKind.Force);
    Section.length.set(eid, solved.length);
    Section.ds.set(eid, solved.ds);
    for (const p of solved.points) createForcePoint(ecs, sectionId, p.s, p.g);
}

/** an invoked force→geo fit's authored output: the sparse Auto node chain `geofit` emitted, in
 *  the bake's own (world) frame — the observation-space twin of `SolvedForce`. `geofit.GeofitResult`
 *  satisfies this structurally (its `deviation`/`forceError`/`outcome` are the caller's transient
 *  readout, never document state), so the document layer reads a fit without depending on the
 *  solver — the invoked atoms stay off this module's graph. */
export interface SolvedGeo {
    nodes: readonly { x: number; y: number; theta: number }[];
}

/** land an invoked force→geo fit's output on its section — the reverse of `applyConvert`. the
 *  force points go, the kind flips, and the fit's nodes localize into the section's own frame
 *  (`localize`, the exact inverse of the rigid `place` the bake applies) — `entry` is the
 *  section's own entry anchor at invoke time, the exact frame `geofit`'s target bake was placed
 *  in (`forceBake`/`evalForce`), so `place∘localize` telescopes and the shape is preserved.
 *  node 0 is pinned at the local origin with heading 0 EXACTLY (the rigid-placement law every
 *  geo section carries, `addNode`'s own invariant) rather than trusting `localize`'s numeric
 *  residual there — the fit's own node 0 sits at the bake's first sample, which is `entry`
 *  itself, but its recovered heading is a geometry-derived tangent, not necessarily bit-identical
 *  to `entry.theta` (the same source-vs-centered gap `section.ts` documents), and a stray local
 *  theta on node 0 would reopen an O(ds) heading kink at the join `place` is meant to close
 *  exactly. every emitted node is Auto (no explicit tangent) — the locked output dialect. the
 *  step resets to the nominal sentinel (the standing convert rule: geo bakes adaptively, there is
 *  no realized-`ds` carry in this direction). does not itself record history — `history.solveGeo`
 *  wraps it. */
export function applyConvertGeo(
    ecs: State,
    sectionId: number,
    solved: SolvedGeo,
    entry: Entry,
): void {
    const eid = sectionAt(ecs, sectionId);
    if (eid === null) throw new Error(`applyConvertGeo: no section ${sectionId}`);
    // both row kinds go, mirroring `applyConvert`: a force section carries no nodes, so the
    // handle sweep is defensive parity, not a live path — and the template is what a reader
    // checks this against.
    for (const h of sectionHandles(ecs, sectionId)) ecs.destroy(h);
    for (const p of sectionForces(ecs, sectionId)) ecs.destroy(p.eid);
    Section.kind.set(eid, SectionKind.Geo);
    Section.length.set(eid, 0);
    Section.ds.set(eid, 0);
    solved.nodes.forEach((n, i) => {
        if (i === 0) {
            spawnNode(ecs, sectionId, 0, 0, 0, 0);
        } else {
            const local = localize(entry, n);
            spawnNode(ecs, sectionId, i, local.x, local.y, local.theta);
        }
    });
}

// ── structural ops (append / split / join / delete) ──────────────────────────
// each mutates the section chain directly; `history` wraps it in a whole-track
// snapshot pair so undo is byte-identical. geo split/join re-express nodes rigidly
// in the boundary frame (`place`/`localize`, exact to f32 round-off); force
// split/join partition + rebase points by arclength (lossless).

/** shift every section at or past `threshold` order by `delta` — makes room to
 *  insert (delta +1) or closes a gap after a remove (delta −1). */
function bumpOrders(ecs: State, threshold: number, delta: number): void {
    for (const eid of ecs.query([Section])) {
        const o = Section.order.get(eid);
        if (o >= threshold) Section.order.set(eid, o + delta);
    }
}

/** the section immediately after `sectionId` in the chain, or null at the end. */
function nextSection(ecs: State, sectionId: number): SectionRow | null {
    const secs = sections(ecs);
    const i = secs.findIndex((s) => s.id === sectionId);
    return i >= 0 && i + 1 < secs.length ? secs[i + 1] : null;
}

/** capture the whole track — every section (order/kind/length) with its nodes and
 *  points. the structural-op undo unit: a snapshot pair round-trips byte-identical
 *  (respawns the stored f32 verbatim), which is what makes the ops safely reversible. */
export function snapshotAll(ecs: State): SectionSnapshot[] {
    return sections(ecs).map((s) => snapshotSection(ecs, s.id));
}

/** clear the whole track and rebuild it from a snapshot (structural-op undo/redo). */
export function restoreAll(ecs: State, snaps: SectionSnapshot[]): void {
    for (const e of [...ecs.query([Section])]) ecs.destroy(e);
    for (const e of [...ecs.query([Handle])]) ecs.destroy(e);
    for (const e of [...ecs.query([Force])]) ecs.destroy(e);
    for (const snap of snaps) {
        spawnSection(ecs, snap.id, snap.order, snap.kind, snap.length, snap.ds);
        for (const n of snap.nodes) spawnNode(ecs, snap.id, n.order, n.x, n.y, n.theta, n.tangent);
        for (const p of snap.points) spawnForce(ecs, snap.id, p.id, p.s, p.g, p.ease, p.tangent);
    }
}

/** append a new section of `kind` at the end of the chain. geo gets the flat
 *  two-node seed (its entry is the prior exit, so it opens straight along the
 *  running heading); force gets the two continuation keyframes — at `(0, F_entry)` and
 *  `(extent, F_entry)` in the track's active domain unit — at the recovered
 *  entry force (the prior section's exit-edge force from the current bake). Both start at
 *  the session's sticky append length for their kind (`stickyLen` — the last committed
 *  extent-trim / length adjust in THAT domain, the literal defaults until one lands; geo
 *  reads its one `Distance` slot, being position-authored in either domain). returns the id. */
export function appendSection(ecs: State, kind: SectionKind): number {
    const secs = sections(ecs);
    const order = secs.length;
    const len = kind === SectionKind.Force ? stickyLen(kind, trackDomain(ecs)) : stickyLen(kind);
    const id = createSection(ecs, order, kind, kind === SectionKind.Force ? len : 0);
    if (kind === SectionKind.Geo) {
        addNode(ecs, id, 0, 0);
        addNode(ecs, id, len, 0);
    } else {
        // the new section's entry is the current last section's exit — seed from the
        // force arriving there (its exit edge in the current bake), stamped.
        const prev = secs[secs.length - 1];
        const info = prev ? sectionInfo.get(prev.id) : undefined;
        const gEntry = info ? bakeEntryForce(ecs, info.endSample) : DEFAULT_G;
        seedForceKeyframes(ecs, id, len, gEntry);
    }
    return id;
}

/** the track's nominal spacing (the bake's `ds`) — read from the Track component so
 *  a re-frame samples at the same density the bake does. */
export function trackDs(ecs: State): number {
    const t = trackEntity(ecs);
    return t === null ? DS_NOMINAL : Track.ds.get(t);
}

/** the recovered exit state of a geo section's head chain `[0..k]`, in the section's
 *  local frame — the exact frame the bake places the downstream tail at (`evalGeo` →
 *  `exitOf`). split/join must re-express against THIS heading, not the boundary node's
 *  stored `Handle.theta`: an explicit tangent decouples `Handle.theta` from the curve's
 *  recovered tangent, so a stored-theta frame rotates the whole downstream section. the
 *  recovered exit IS the bake's downstream entry, so `place∘localize` telescopes and the
 *  shape is preserved. (`v` is geometry-irrelevant — `place`/`localize` are pure rigid
 *  transforms; the recovered heading/position are v-independent.) */
function headExit(ecs: State, handles: readonly number[], k: number): Entry {
    const nodes: Node[] = [];
    for (let i = 0; i <= k; i++) {
        nodes.push({
            x: Handle.pos.x.get(handles[i]),
            y: Handle.pos.y.get(handles[i]),
            theta: Handle.theta.get(handles[i]),
            tangent: readTangent(handles[i]),
        });
    }
    return evalGeo({ x: 0, y: 0, theta: 0, v: V0 }, nodes, trackDs(ecs)).exit;
}

/** split a geo section at an interior node (order `k`, 1 ≤ k ≤ n−1): the head keeps
 *  nodes [0..k], a new section takes [k..n] re-expressed in the head's recovered
 *  boundary frame (rigid — its node 0 becomes {0,0,0} at heading 0 only when the
 *  boundary is Auto; an explicit-tangent boundary carries a nonzero node-0 heading
 *  that compensates the recovered-vs-stored gap). node k stays the head's new tip.
 *  no-op at the entry or last node. returns the new (tail) section id, or null. */
export function splitGeo(ecs: State, sectionId: number, k: number): number | null {
    const secEid = sectionAt(ecs, sectionId);
    if (secEid === null || Section.kind.get(secEid) !== SectionKind.Geo) return null;
    const handles = sectionHandles(ecs, sectionId);
    const n = handles.length - 1;
    if (k < 1 || k >= n) return null;

    // re-frame against the head's RECOVERED exit (the bake's downstream entry), not the
    // boundary node's stored heading — see `headExit`.
    const frame = headExit(ecs, handles, k);
    const order = Section.order.get(secEid);
    bumpOrders(ecs, order + 1, +1);
    const bId = createSection(ecs, order + 1, SectionKind.Geo, 0, Section.ds.get(secEid));
    for (let i = k; i <= n; i++) {
        const bl = localize(frame, {
            x: Handle.pos.x.get(handles[i]),
            y: Handle.pos.y.get(handles[i]),
            theta: Handle.theta.get(handles[i]),
            tangent: readTangent(handles[i]),
        });
        spawnNode(ecs, bId, i - k, bl.x, bl.y, bl.theta, bl.tangent);
    }
    for (let i = k + 1; i <= n; i++) ecs.destroy(handles[i]); // trim the head to [0..k]
    return bId;
}

/** split a force section at arclength `s` (0 < s < length): the head keeps extent
 *  [0, s] and its points there; a new section takes extent [s, length] with the
 *  remaining points rebased to its entry (a lossless partition). **both halves
 *  inherit the baking step** (as a geo split does): a split partitions the profile at
 *  its own density, it doesn't re-solve it. no-op outside
 *  the interior. returns the new (tail) section id, or null. */
export function splitForce(ecs: State, sectionId: number, s: number): number | null {
    const secEid = sectionAt(ecs, sectionId);
    if (secEid === null || Section.kind.get(secEid) !== SectionKind.Force) return null;
    const len = Section.length.get(secEid);
    if (s <= 0 || s >= len) return null;

    const order = Section.order.get(secEid);
    bumpOrders(ecs, order + 1, +1);
    const bId = createSection(ecs, order + 1, SectionKind.Force, len - s, Section.ds.get(secEid));
    for (const p of sectionForces(ecs, sectionId)) {
        if (p.s >= s) {
            Force.section.set(p.eid, bId);
            Force.s.set(p.eid, p.s - s);
        }
    }
    Section.length.set(secEid, s);
    return bId;
}

/** join a section with the next one in the chain (same-kind only). geo appends the
 *  neighbor's shape nodes re-expressed in the head's tip frame (exact inverse of a
 *  geo split); force concatenates the extents and rebases the neighbor's points. the
 *  neighbor is removed and downstream orders close up. **the upstream baking step
 *  wins** — the joined section spans neither solve any more, so the neighbor's step
 *  has no claim on it (the head keeps its own; nothing to write). returns true when
 *  joined. */
export function joinNext(ecs: State, sectionId: number): boolean {
    const aEid = sectionAt(ecs, sectionId);
    const b = nextSection(ecs, sectionId);
    if (aEid === null || b === null) return false;
    const aKind = Section.kind.get(aEid) as SectionKind;
    if (aKind !== b.kind) return false;

    if (aKind === SectionKind.Geo) {
        const aHandles = sectionHandles(ecs, sectionId);
        const aN = aHandles.length - 1;
        // place B against A's RECOVERED exit (the bake's downstream entry, the exact
        // inverse of a geo split), not A's stored tip heading — see `headExit`.
        const frame = headExit(ecs, aHandles, aN);
        const bHandles = sectionHandles(ecs, b.id);
        // skip B node 0 (== the shared boundary, already A's tip); append B[1..m].
        for (let j = 1; j < bHandles.length; j++) {
            const w = place(frame, {
                x: Handle.pos.x.get(bHandles[j]),
                y: Handle.pos.y.get(bHandles[j]),
                theta: Handle.theta.get(bHandles[j]),
                tangent: readTangent(bHandles[j]),
            });
            spawnNode(ecs, sectionId, aN + j, w.x, w.y, w.theta, w.tangent);
        }
        for (const h of bHandles) ecs.destroy(h);
    } else {
        const aLen = Section.length.get(aEid);
        for (const p of sectionForces(ecs, b.id)) {
            Force.section.set(p.eid, sectionId);
            Force.s.set(p.eid, p.s + aLen);
        }
        Section.length.set(aEid, aLen + b.length);
    }
    ecs.destroy(b.eid);
    bumpOrders(ecs, b.order + 1, -1);
    return true;
}

/** delete a section and its payload; downstream sections close the gap and rebase
 *  rigidly (their nodes are section-local, so the bake re-places them at the new
 *  upstream exit). refuses to remove the last remaining section. returns true
 *  when deleted. */
export function deleteSection(ecs: State, sectionId: number): boolean {
    const secEid = sectionAt(ecs, sectionId);
    if (secEid === null) return false;
    if (sections(ecs).length <= 1) return false; // keep at least one section
    const order = Section.order.get(secEid);
    for (const h of sectionHandles(ecs, sectionId)) ecs.destroy(h);
    for (const p of sectionForces(ecs, sectionId)) ecs.destroy(p.eid);
    ecs.destroy(secEid);
    bumpOrders(ecs, order + 1, -1);
    return true;
}

function seed(ecs: State): void {
    createTrack(ecs);
    // one geo section: node 0 at the local origin (the fixed start anchor) + a flat
    // extension-length shape node. the whole track launches level from `START`.
    const id = createSection(ecs, 0, SectionKind.Geo, 0);
    addNode(ecs, id, 0, 0);
    addNode(ecs, id, EXTEND_DIST, 0);
}

// ── bake ─────────────────────────────────────────────────────────────────────

/** a geo section's authored shape as pure `spline.Node`s — section-local, node 0 at
 *  {0,0,0}, in chain order. the ONE projection from the ECS columns onto the substrate's
 *  node list: the bake's payload and an invoked solve's input both read it, so what a
 *  conversion solves is bit-identical to what's displayed. */
export function geoNodes(ecs: State, sectionId: number): Node[] {
    return sectionHandles(ecs, sectionId).map((eid) => ({
        x: Handle.pos.x.get(eid),
        y: Handle.pos.y.get(eid),
        theta: Handle.theta.get(eid),
        tangent: readTangent(eid),
    }));
}

/** a geo section's payload: its section-local nodes (node 0 at {0,0,0}) + the step it
 *  bakes at. the substrate places them rigidly at the running chain entry. */
function geoPayload(ecs: State, sectionId: number, ds: number): SectionSpec {
    return { kind: "geo", nodes: geoNodes(ecs, sectionId), ds };
}

/** the step a section bakes at: its own when set, else the track-nominal `ds` (0 is
 *  the sentinel every hand-authored section carries). an invoked solve stores its
 *  realized step, and the profile only spans the section — closing the exit the solve
 *  pinned — when it's replayed at that step, not at the nominal quantum. */
export function sectionStep(stored: number, nominal: number): number {
    return stored > 0 ? stored : nominal;
}

/** the nominal step a force section's sentinel-0 `ds` resolves to, in the track's active
 *  domain unit: the track-nominal `trackDs` for `Distance`, `DT_NOMINAL` for `Time` — a time
 *  march's nominal is never the track's meters quantum (`trackDs` is a distance scalar, not a
 *  step in seconds). geo is position-authored in either domain, so its callers pass `trackDs`
 *  straight through without this. */
function forceNominal(domain: Domain, trackDs: number): number {
    return domain === Domain.Time ? DT_NOMINAL : trackDs;
}

/** a force section's authored points gathered into the dense per-edge F_n(σ) profile over its
 *  extent — the one place a section's keyframes become the substrate's input. */
function forceDense(ecs: State, sectionId: number, length: number, ds: number): Float32Array {
    const points: ForcePoint[] = sectionForces(ecs, sectionId).map((p) => {
        const tan = readForceTangent(p.eid);
        return {
            s: p.s,
            g: p.g,
            ease: Force.ease.get(p.eid) as Easing,
            in: tan?.in,
            out: tan?.out,
        };
    });
    return forceProfile(points, length, ds);
}

/** a force section's payload: its dense profile + the step it bakes at (its own or the
 *  nominal), which sets both the edge count and the integrator's march, and the track's
 *  `domain` — the step rule `evalForce` (`section.ts`) consults. */
function forcePayload(
    ecs: State,
    sectionId: number,
    length: number,
    ds: number,
    domain: Domain,
): SectionSpec {
    return { kind: "force", fN: forceDense(ecs, sectionId, length, ds), ds, domain };
}

/** a force section's dense bake, as `geofit` reads it: its own recovered positions + display
 *  force per edge, re-evaluated fresh (`evalForce`) — the same call `BakeSystem`'s
 *  `forcePayload` threads through `chain`, so the fit targets exactly the shape on screen (the
 *  `evalGeo` precedent an invoked geo→force solve's input reads, `geoforce.ts`), **truncation
 *  included**: a force section's own extent/step can ask for more edges than the flat SoA has
 *  left at its place in the chain, and `chain` silently drops the overflow (the writes land past
 *  the buffer end), so what's on screen is the prefix. clipping the dense profile to the same
 *  budget is what makes the fit's input that prefix rather than a longer shape nothing draws. */
export function forceBake(ecs: State, sectionId: number): GeofitBake {
    const eid = sectionAt(ecs, sectionId);
    if (eid === null) throw new Error(`forceBake: no section ${sectionId}`);
    const info = sectionInfo.get(sectionId);
    if (!info) throw new Error(`forceBake: no bake for section ${sectionId}`);
    if (Section.kind.get(eid) !== SectionKind.Force)
        throw new Error(`forceBake: section ${sectionId} is not force`);
    const domain = trackDomain(ecs);
    const step = sectionStep(Section.ds.get(eid), forceNominal(domain, trackDs(ecs)));
    const dense = forceDense(ecs, sectionId, Section.length.get(eid), step);
    const avail = Math.max(1, MAX_SAMPLES - 1 - info.startSample);
    const r = evalForce(
        info.entry,
        dense.length > avail ? dense.subarray(0, avail) : dense,
        step,
        domain,
    );
    return { x: r.posX, y: r.posY, fN: r.fN, ds: r.ds, edges: r.edges };
}

/** input-state hash that gates the bake: the shared ds + initial speed, then every
 *  section in order — its id/order/kind, its own baking step when it carries one, and
 *  its authored payload (a geo section's node poses, a force section's extent +
 *  points). BakeSystem re-bakes on a miss (anything moved, added, removed, converted,
 *  reordered, restepped, re-domained, or the v0 retimed), skips otherwise. the step is
 *  written only when set, and the track `domain` only when it isn't the default `Distance`,
 *  so every existing authored track's hash stays byte-identical. */
function bakeHash(ecs: State, secs: SectionRow[], ds: number, v0: number, domain: Domain): string {
    let h = `ds${ds}v0${v0}`;
    if (domain !== Domain.Distance) h += `^${domain}`;
    for (const sec of secs) {
        h += `|S${sec.id}:${sec.order}:${sec.kind}`;
        if (sec.ds > 0) h += `@${sec.ds}`;
        if (sec.kind === SectionKind.Force) {
            h += `:L${sec.length}`;
            for (const p of sectionForces(ecs, sec.id)) {
                h += `,${p.id}=${p.s}:${p.g}:${Force.ease.get(p.eid)}`;
                const mode = Force.tmode.get(p.eid);
                if (mode !== 0) {
                    h += `~${mode}:${Force.tin.x.get(p.eid)}:${Force.tin.y.get(p.eid)}:${Force.tout.x.get(p.eid)}:${Force.tout.y.get(p.eid)}`;
                }
            }
        } else {
            for (const eid of sectionHandles(ecs, sec.id)) {
                h += `,${Handle.pos.x.get(eid)}:${Handle.pos.y.get(eid)}:${Handle.theta.get(eid)}`;
                const mode = Handle.tmode.get(eid);
                if (mode !== TANGENT_AUTO) {
                    h += `~${mode}:${Handle.tin.x.get(eid)}:${Handle.tin.y.get(eid)}:${Handle.tout.x.get(eid)}:${Handle.tout.y.get(eid)}`;
                }
            }
        }
    }
    return h;
}

/** the bake gate's input reading for the whole authored track, computed from the LIVE authored
 *  state instead of read off the last bake — so it is the honest answer between ticks too. an
 *  invoked tool holds it across its solve to notice the document moved underneath. */
export function authoredHash(ecs: State): string {
    for (const t of ecs.query([Track])) {
        return bakeHash(
            ecs,
            sections(ecs),
            Track.ds.get(t),
            Track.v0.get(t),
            Track.domain.get(t) as Domain,
        );
    }
    return "";
}

/** whether the current bake IS the current authored state — the liveness anything reading
 *  `sectionInfo` as truth needs first. a bake that never ran, one invalidated since (the `""`
 *  sentinel), and one the two-node floor made `bake` early-return from all fail here, and each
 *  leaves `sectionInfo` describing a shape that is no longer on screen. */
export function bakeLive(ecs: State): boolean {
    for (const t of ecs.query([Track])) {
        const out = bakeOut.get(t);
        return out !== undefined && out.hash === authoredHash(ecs);
    }
    return false;
}

type BakeOut = NonNullable<ReturnType<typeof bakeOut.get>>;

/** per-sample cumulative time plus the diagnostic feasibility flag.
 *
 *  **A section that MARCHED in time owns its own time.** `marched[i]` is the Δt an edge was
 *  integrated with (a `Time`-domain force section: its step); 0 means the edge has no marched
 *  time and its duration is derived instead, `ds_i / v̄_i` with v̄ floored at `V_FLOOR` so
 *  energy-depleted regions take long-but-finite time — the geo and `Distance`-domain path, and
 *  the original behaviour byte-for-byte. Deriving a marched edge's time would be a SECOND truth
 *  that diverges without bound at a stall (`ds → 0` and `v̄ → V_FLOOR` disagree wildly with the
 *  Δt actually integrated), and a `Time`-domain keyframe's stored `t` IS accumulated march time
 *  by construction — so the table, `evalForce`'s sampling, and the conversion op must all read
 *  the march.
 *
 *  `feasible[i] = |v[i]| ≥ V_WARN` drives the red-track UX (warning threshold above the
 *  numerical floor). */
function computeTime(s: Samples, out: BakeOut, count: number, marched: Float64Array): void {
    out.t[0] = 0;
    out.feasible[0] = Math.abs(s.v[0]) >= V_WARN ? 1 : 0;
    let firstBad = out.feasible[0] === 0 ? 0 : -1;
    for (let i = 0; i < count - 1; i++) {
        let dt = marched[i];
        if (!(dt > 0)) {
            const vA = Math.max(Math.abs(s.v[i]), V_FLOOR);
            const vB = Math.max(Math.abs(s.v[i + 1]), V_FLOOR);
            dt = out.ds[i] / (0.5 * (vA + vB));
        }
        out.t[i + 1] = out.t[i] + dt;
        const f = Math.abs(s.v[i + 1]) >= V_WARN ? 1 : 0;
        out.feasible[i + 1] = f;
        if (firstBad < 0 && f === 0) firstBad = i + 1;
    }
    out.tTotal = count > 0 ? out.t[count - 1] : 0;
    out.firstInfeasible = firstBad;
}

/** the bake: thread the section chain from `START` into one flat SoA + per-section
 *  metadata. each geo section contributes its local nodes (placed rigidly at the
 *  running entry — an upstream edit rigidly carries downstream); each force
 *  section its integrated-then-recovered profile. writes `samples` + `bakeOut`,
 *  syncs each geo node's global sample index, and records `sectionInfo` (entry,
 *  range, arclength, orphan cutoff) the drag/render read. skips (keeps the prior
 *  bake) when a geo section is below its two-node floor or the chain degenerates. */
function bake(ecs: State, trackEid: number, s: Samples, out: BakeOut, secs: SectionRow[]): void {
    const ds = Track.ds.get(trackEid);
    const v0 = Track.v0.get(trackEid);
    const domain = Track.domain.get(trackEid) as Domain;
    const start = startEntry(v0);

    // a geo section needs ≥2 nodes to bake; if any is short, keep the prior bake
    // rather than half-render the chain.
    for (const sec of secs) {
        if (sec.kind === SectionKind.Geo && sectionHandles(ecs, sec.id).length < 2) return;
    }

    // per section: its payload, and the Δt its edges MARCH with (0 = derive the time from ds/v̄
    // — geo, and every Distance-domain force section). `computeTime` reads the latter.
    const marchedStep = new Float64Array(secs.length);
    const payloads = secs.map((sec, k) => {
        if (sec.kind === SectionKind.Geo) return geoPayload(ecs, sec.id, sectionStep(sec.ds, ds));
        const step = sectionStep(sec.ds, forceNominal(domain, ds));
        if (domain === Domain.Time) marchedStep[k] = step;
        return forcePayload(ecs, sec.id, sec.length, step, domain);
    });
    const c = chain(start, payloads, MAX_SAMPLES);
    const count = c.count;
    if (count < 2) return; // fully degenerate first section — keep the prior bake

    let truncatedAny = false;
    const marched = new Float64Array(Math.max(1, count - 1));
    for (let k = 0; k < secs.length; k++) {
        const r = c.results[k];
        const range = c.ranges[k];
        const entry = k === 0 ? start : c.exits[k - 1];
        if (marchedStep[k] > 0) {
            for (let i = range.start; i < Math.min(range.end, count - 1); i++)
                marched[i] = marchedStep[k];
        }

        if (secs[k].kind === SectionKind.Geo) {
            const hs = sectionHandles(ecs, secs[k].id);
            for (let n = 0; n < r.offsets.length; n++) {
                Handle.sample.set(hs[n], range.start + r.offsets[n]);
            }
        }
        sectionInfo.set(secs[k].id, {
            entry,
            startSample: range.start,
            endSample: range.end,
            bakedNodes: r.offsets.length,
        });
        if (r.truncated) truncatedAny = true;
    }
    if (truncatedAny) {
        console.warn(
            `kex2d: track ${trackEid} hit MAX_SAMPLES=${MAX_SAMPLES}; trailing nodes dropped`,
        );
    }

    s.posX.set(c.posX.subarray(0, count));
    s.posY.set(c.posY.subarray(0, count));
    s.theta.set(c.theta.subarray(0, count));
    s.v.set(c.v.subarray(0, count));
    out.fN.set(c.fN.subarray(0, count - 1));
    out.ds.set(c.ds.subarray(0, count - 1));
    out.hash = bakeHash(ecs, secs, ds, v0, domain);
    Track.count.set(trackEid, count);
    computeTime(s, out, count, marched);
}

export const BakeSystem: System = {
    update(ecs: State): void {
        for (const trackEid of ecs.query([Track])) {
            const s = samples.get(trackEid);
            const out = bakeOut.get(trackEid);
            if (!s || !out) continue;
            const secs = sections(ecs);
            if (secs.length === 0) continue;
            const hash = bakeHash(
                ecs,
                secs,
                Track.ds.get(trackEid),
                Track.v0.get(trackEid),
                Track.domain.get(trackEid) as Domain,
            );
            if (hash === out.hash) continue; // nothing changed — reuse the bake
            bake(ecs, trackEid, s, out, secs);
        }
    },
};

export const TrackPlugin: Plugin = {
    name: "Track",
    components: { Track, Section, Handle, Force },
    traits: {
        Track: { defaults: () => ({ count: 0, ds: 0, v0: V0, domain: Domain.Distance }) },
        Section: { defaults: () => ({ id: 0, order: 0, kind: 0, length: 0, ds: 0 }) },
        Handle: {
            defaults: () => ({
                section: 0,
                order: 0,
                sample: 0,
                pos: [0, 0],
                theta: 0,
                tmode: TANGENT_AUTO,
                tin: [0, 0],
                tout: [0, 0],
            }),
        },
        Force: {
            defaults: () => ({
                section: 0,
                id: 0,
                s: 0,
                g: 0,
                ease: FORCE_EASE_DEFAULT,
                tmode: 0,
                tin: [0, 0],
                tout: [0, 0],
            }),
        },
    },
    initialize(ecs) {
        seed(ecs);
    },
    systems: [BakeSystem],
};
