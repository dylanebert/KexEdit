import { f32, type Plugin, sparse, type State, type System, u32, vec2 } from "@dylanebert/shallot";
import { V_FLOOR, V_WARN } from "./bake";
import type { GeofitBake } from "./geofit";
import { LENGTH_MIN } from "./magnet";
import {
    DEFAULT_G,
    Easing,
    type ForcePoint,
    forceProfile,
    resolveStep,
    sampleForce,
    type Step,
} from "./profile";
import { rebuildRunProjection } from "./projection";
import {
    chain,
    Domain,
    type Entry,
    evalForce,
    localize,
    type Section as SectionSpec,
    SectionKind,
    type Strip as StripSpec,
} from "./section";
import {
    autoTangent,
    type Node,
    reflect,
    sampleChain,
    type Tangent,
    type TangentMode,
} from "./spline";

/** the kind enum is defined with the substrate that gives it meaning (`section.ts`);
 *  it is re-exported here because `Section.kind` is where the document stores it, and
 *  every ECS-side consumer already reaches for it through this module. */
export { SectionKind } from "./section";

/** per-track scalars. `count` is the total sample count over the whole chain (bake
 *  output, varies with the authored payload). `ds` is the nominal target spacing —
 *  one value shared by every section (per-edge actual ds lives in `bakeOut.ds`).
 *  the initial speed (m/s) at the track start is no longer stored here (S5): it is
 *  DERIVED, {@link entrySpeed} — the track-start one-shot's own `value` (S3, its own
 *  structurally distinct point kind, `OneShot`), or `V0` when none exists. the
 *  per-section kind + extent live on `Section`, not here.
 *
 *  `domain` is the track-global `Domain` (`section.ts`) — a VIEW, not a second
 *  storage unit: every force section's keyframes and extent are stored in meters of
 *  section-local arclength always (`Distance` or `Time`, whichever is picked, reads
 *  through the same store). It is authored state, in the bake hash, and one
 *  track-global fact, not per-section (rejected at feel: no per-section flip row).
 *  Nothing converts on a flip: `domain.convertDomain` writes this one column and
 *  nothing else, so a Time reading projects through the live bake's s↔t table
 *  (`timeline.ts`'s `dToU`/`uToD`) rather than changing any stored number. Geo
 *  sections are position-authored in either domain; only `evalForce`'s step rule and
 *  the force-section extent/keyframe display axis read this. */
export const Track = {
    count: sparse(u32),
    ds: sparse(f32),
    domain: sparse(u32),
    /** Coulomb friction coefficient, threaded to `forward.loss` beside
     *  `resistance`. New-track default `DEFAULT_FRICTION`; an absent field (an old save)
     *  restores 0, the kernel's own neutral default (`TrackPlugin.traits`). */
    friction: sparse(f32),
    /** quadratic-drag coefficient [1/m], threaded to `forward.loss` beside
     *  `friction`. New-track default `DEFAULT_RESISTANCE`; an absent field restores 0. */
    resistance: sparse(f32),
};

/** one section in the track's chain. `id` is the stable identity undo/redo and
 *  node/point membership address (eids recycle across a delete→undo; ids never do
 *  — the `Handle.order` convention). `order` is its position along the chain
 *  (0 = first), reassigned by the structural ops (append/split/delete). `kind`
 *  is the `SectionKind`. `length` is a FORCE section's extent — the span the force
 *  profile covers, in METERS OF ARCLENGTH always (`Track.domain` is a display lens, not a
 *  second unit); unused (0) for a geo section, whose extent is its node chain.
 *  Every section bakes at the domain's nominal quantum (the per-section step resolver
 *  removed, `kex2d-correctness-fixes` stage 5) — there is no per-section step to carry.
 *  a section's entry anchor is derived (the prior section's exit, or `START` for the
 *  first); it is never stored. */
export const Segment = {
    id: sparse(u32),
    order: sparse(u32),
    kind: sparse(u32),
    length: sparse(f32),
    /** @temporary S3–S7 — stable evaluator payload partition, seeded from section identity. */
    run: sparse(u32),
    /** @temporary S3–S7 — this member's conserved entry station in its evaluator run. */
    runStation: sparse(f32),
    /** @temporary S3–S7 — conserved run extent; authoritative on the run's first member. */
    runExtent: sparse(f32),
};

/** Canonical predecessor-less boundary for segment zero. Channel payload ownership moves
 * here in later data stages; S2a establishes its stable structural identity. */
export const TrackStart = { id: sparse(u32) };

/** @temporary S7 — section-facing readers are a compatibility projection over Segment. */
export const Section = Segment;

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
const handleSegment = sparse(u32);
export const Handle = {
    /** Stable canonical segment id. */
    segment: handleSegment,
    /** @temporary S7 — legacy section-facing membership projection. */
    section: handleSegment,
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
 *  safe); `s` its position measured from the section entry, in meters of arclength
 *  always (`Track.domain` is a display lens, never a second unit the store holds);
 *  `g` the demanded normal force (g). the timeline places, drags, and deletes these;
 *  the bake gathers each section's points (sorted by s) into a dense profile
 *  (`profile.forceProfile`). `ease` is the keyframe's `Easing` tag (the convenient
 *  middle layer) — it governs the *following* segment's derived flat tangents
 *  (default `Easing.Cubic`, the "no stored state" convention). Every segment is
 *  NAMED (`profile.ts`'s derived-flat-tangent shape); explicit per-keyframe force
 *  handles left with `kex2d-segment-removal` S3 (`ForceTangent`, the stored
 *  `Force.tin`/`tout` offsets, and the Custom provenance they implied). */
const forceSegment = sparse(u32);
/** Authored value at a force station's terminating boundary.  Stations remain on
 * `Force.s` until S2b3 unions them into the segment chain; value and leading-key
 * easing have one boundary owner now. */
export const ForceBoundary = {
    g: sparse(f32),
    ease: sparse(u32),
};
export const Force = {
    /** Stable canonical segment id. */
    segment: forceSegment,
    /** @temporary S7 — legacy section-facing membership projection. */
    section: forceSegment,
    id: sparse(u32),
    s: sparse(f32),
    /** @temporary S7 — compatibility reads; authored by ForceBoundary. */
    g: ForceBoundary.g,
    /** @temporary S7 — compatibility reads; authored by ForceBoundary. */
    ease: ForceBoundary.ease,
};

/** the easing tag a fresh force keyframe gets — the FVD++/Planet-Coaster S-transition
 *  feel, and the "no stored state" default (`profile.ts` reads an absent tag as this). */
const FORCE_EASE_DEFAULT = Easing.Cubic;

/** an authored velocity strip — track-global, span-blind to sections (person's verdict,
 *  2026-08-25): a velocity span controls the velocity over its own extent regardless of
 *  section type, may overlap multiple sections, and persists through segment resize and
 *  structural ops (split/delete/convert never touch it). `id` is the strip's own
 *  stable identity (undo/redo address, eid-recycle safe). `start`/`end` are the span's
 *  boundaries in TRACK-GLOBAL arclength `d` (meters from track start — the `toGlobal`/
 *  `toLocal` seam's own coordinate, R's lock 2026-08-25), and `value` is the constant
 *  speed (m/s) the strip holds, the same unit `Entry.v` carries. A **point** is the
 *  degenerate `start === end` case (`section.ts`'s own edge convention). All three are
 *  stored constants, never derived from the live march (`kex2d-map.md`'s
 *  authored-control exception). */
export const Strip = {
    id: sparse(u32),
    start: sparse(f32),
    end: sparse(f32),
    value: sparse(f32),
};

/** a velocity-strip keyframe — a child entity on a strip, the `Force`-to-`Section`
 *  pattern applied to the strip's own velocity curve (T2, "keyframes on the force-curve
 *  machinery"). `strip` is the owning strip's stable `Strip.id`; `id` is the keyframe's
 *  own stable identity (undo/redo address, eid-recycle safe). `s` is the keyframe's
 *  position in TRACK-GLOBAL arclength `d` — the SAME axis `Strip.start`/`end` are stored
 *  in — clipped to the strip's `[start, end]` extent. `v` is the velocity (m/s) the curve
 *  holds at that station, the same unit `Entry.v` carries. When a strip has no
 *  keyframes, the constant `Strip.value` is used (the After Effects stopwatch reading:
 *  no keyframes means one constant across the span). */
export const StripKeyframe = {
    strip: sparse(u32),
    id: sparse(u32),
    s: sparse(f32),
    v: sparse(f32),
};

export interface StripKeyframeRow {
    eid: number;
    strip: number;
    id: number;
    s: number;
    v: number;
}

export interface StripRow {
    eid: number;
    id: number;
    start: number;
    end: number;
    value: number;
}

/** every velocity strip, track-wide, sorted by `start` — the order the bake's edge
 *  conversion and the overlap guard both read. Strips carry no section ownership
 *  (Locked decision): there is no per-section filter to apply. */
export function allStrips(ecs: State): StripRow[] {
    const rows: StripRow[] = [];
    for (const eid of ecs.query([Strip])) {
        rows.push({
            eid,
            id: Strip.id.get(eid),
            start: Strip.start.get(eid),
            end: Strip.end.get(eid),
            value: Strip.value.get(eid),
        });
    }
    rows.sort((a, b) => a.start - b.start);
    return rows;
}

/** resolve a strip by its stable `id` to its eid, or null. */
export function stripAt(ecs: State, id: number): number | null {
    for (const eid of ecs.query([Strip])) {
        if (Strip.id.get(eid) === id) return eid;
    }
    return null;
}

// monotone id source — never reused, even after a delete (the section/force-id rationale).
let nextStripId = 0;

/** the edge-index half-open range `[lo, hi)` a strip `[start, end)` claims —
 *  `stripOverride`'s (`section.ts`) own convention, not the symmetric span math: a
 *  span claims edges `[start, end)`, but a degenerate point at station `p` reaches
 *  BACKWARD to the edge arriving at it, `[p−1, p)`, never forward. Overlap has to be
 *  tested in THIS coordinate, not station space — two candidates overlap iff they'd
 *  claim the same kernel edge, and a point at a span's `end` claims that span's own
 *  last edge (the same edge), even though the two stations only abut. */
function stripEdgeRange(start: number, end: number): [number, number] {
    return start === end ? [start - 1, start] : [start, end];
}

/** whether a candidate `[start, end)` span overlaps another strip, track-wide (strips
 *  carry no section ownership, Locked decision) — tested at the edge-index level
 *  (`stripEdgeRange`), the coordinate `stripOverride` (`section.ts`) actually resolves
 *  against, not station space: two ranges overlap iff `aLo < bHi && bLo < aHi` over their
 *  edge ranges. `exceptId` excludes the strip asking (a strip never collides with itself,
 *  `stationTaken`'s own self-exclusion shape) — pass -1 from a create (no existing strip
 *  to except). A degenerate point (`start === end`) claims the single edge arriving at
 *  its station, `[start−1, start)` — so it overlaps a span at its OWN start boundary
 *  (their edge ranges are disjoint: `[start−1,start)` vs `[start,end)`) but collides at
 *  the span's END boundary (both claim the span's own last edge) — one guard, correct in
 *  both directions, matching `stripOverride` exactly. */
export function stripOverlapped(ecs: State, start: number, end: number, exceptId: number): boolean {
    const [aLo, aHi] = stripEdgeRange(start, end);
    for (const row of allStrips(ecs)) {
        if (row.id === exceptId) continue;
        const [bLo, bHi] = stripEdgeRange(row.start, row.end);
        if (aLo < bHi && bLo < aHi) return true;
    }
    return false;
}

/** the section's own per-edge `ds` array — the same edge structure the live bake uses
 *  (`geoChordDs` for a geo section, the uniform resolved step for a force section), a PURE
 *  derivation from the section's own authored payload, never a bake read (the pin
 *  invariant's own structural requirement, `enterPin`'s docblock) — this is what lets
 *  {@link sectionWindows} compute a section's track-global entry offset without reading
 *  `bakeOut`. Returns null when the section has no resolvable edge structure (no track, an
 *  empty geo section). */
export function sectionEdgeDs(
    ecs: State,
    sectionId: number,
): { ds: ArrayLike<number>; edges: number } | null {
    const eid = sectionAt(ecs, sectionId);
    if (eid === null) return null;
    const kind = Section.kind.get(eid);
    const dsNom = trackDs(ecs);
    if (kind === SectionKind.Force) {
        const length = Section.length.get(eid);
        const resolved = resolveStep(length, dsNom);
        return { ds: new Float32Array(resolved.edges).fill(resolved.ds), edges: resolved.edges };
    }
    return geoChordDs(ecs, sectionId, dsNom);
}

/** whether a continuous-coordinate span `[start, end)` covers at least one edge of the
 *  current bake at that station — the minimum-extent floor. Two conjuncts: the span's two
 *  ends must round to DIFFERENT edge boundaries under `edgeStrips`'s round-to-nearest
 *  `boundary()` map (i.e. the span straddles an edge midpoint, so it maps to at least one
 *  overridden edge — a sub-edge span whose ends round together collapses to `start === end`,
 *  which the point convention re-maps to the PRECEDING edge `[start−1, start)`, genuinely
 *  inert only at station 0 where `lo = −1`); AND the span's own raw width must be at least
 *  the edge it lands in (`ds` at that station) — the straddle test alone passes for an
 *  arbitrarily narrow span sitting near an edge's MIDPOINT (not its boundary), which is a
 *  legal but unhittable strip (measured 0.020 m wide on a 0.5 m grid) — the width floor
 *  every existing min-extent call site already satisfies. Uses {@link edgeStrips}'s own
 *  boundary mapping, so the check is against exactly the edge-index resolution the bake
 *  would see. */
/** check whether a span `[start, end)` covers at least one edge, given a raw edge
 *  structure (the `ds` array + edge count a section's bake resolves to) — the
 *  min-extent floor's own core, factored so a split can check a *would-be* tail section
 *  that doesn't exist yet in the ECS. */
export function spanCoversOneEdge(
    ds: ArrayLike<number>,
    edges: number,
    start: number,
    end: number,
): boolean {
    const specs = edgeStrips(ds, edges, [{ start, end, value: 0 }]);
    if (!specs || specs.length === 0) return false;
    if (specs[0].end <= specs[0].start) return false;
    return end - start >= ds[Math.min(specs[0].start, edges - 1)];
}

/** one section's place on the track-global edge axis: the entry offset (the cumulative
 *  arclength of every upstream section's OWN resolved extent) plus its own per-edge `ds`
 *  array — computed PURELY from the live authored document via {@link sectionEdgeDs}
 *  (chord sums for geo, resolved step for force), never a bake read. This is the ONE seam
 *  both the chain bake (`geoPayload`/`forcePayload`, windowing a track-global strip
 *  against a section's in-pass window per the Locked decision) and the pin invariant's
 *  stamp/ghost construction (`enterPin`, "no bake-read anywhere in the override
 *  construction path") window a track-global strip through — and what lets a strip be
 *  authored before any bake has ever run (`seed`'s own initial-velocity strip). Offsets
 *  are strip-independent: a section's own resolved extent (chord length, authored
 *  `Section.length`) never depends on a velocity strip, only on geometry. */
export interface SectionWindow {
    id: number;
    offset: number;
    ds: ArrayLike<number>;
    edges: number;
    len: number;
}

const EMPTY_DS = new Float32Array(0);

export function sectionWindows(ecs: State, secs?: SectionRow[]): SectionWindow[] {
    const rows =
        secs ??
        rebuildRunProjection(ecs).map((run) => ({
            eid: run.eid,
            id: run.id,
            order: run.order,
            kind: run.kind as SectionKind,
            length: run.length,
        }));
    const out: SectionWindow[] = [];
    let cum = 0;
    for (const row of rows) {
        let edge: { ds: ArrayLike<number>; edges: number } | null;
        if (row.kind === SectionKind.Force) {
            const step = resolveStep(row.length, trackDs(ecs));
            edge = { ds: new Float32Array(step.edges).fill(step.ds), edges: step.edges };
        } else {
            edge = sectionEdgeDs(ecs, row.id);
        }
        const ds = edge?.ds ?? EMPTY_DS;
        const edges = edge?.edges ?? 0;
        let len = 0;
        for (let i = 0; i < edges; i++) len += ds[i];
        out.push({ id: row.id, offset: cum, ds, edges, len });
        cum += len;
    }
    return out;
}

/** the whole track's per-edge `ds` array + edge count, concatenated from every section's
 *  own pure {@link sectionEdgeDs} via {@link sectionWindows} — the edge structure a
 *  track-global strip's authoring guards (min-extent, default-extent, overlap) validate
 *  against. Bake-read-free (unlike reading `bakeOut` directly), so a strip can be created
 *  before the first bake ever runs. Returns null when the track has no resolvable edges. */
function trackEdgeArray(ecs: State): { ds: ArrayLike<number>; edges: number } | null {
    const windows = sectionWindows(ecs);
    let edges = 0;
    for (const w of windows) edges += w.edges;
    if (edges === 0) return null;
    const ds = new Float32Array(edges);
    let o = 0;
    for (const w of windows) for (let i = 0; i < w.edges; i++) ds[o++] = w.ds[i];
    return { ds, edges };
}

/** whether a track-global span `[start, end)` covers at least one edge of the current
 *  bake — the minimum-extent guard, tested against the whole track's own edge structure
 *  (strips are section-blind, Locked decision). */
export function stripCoversOneEdge(ecs: State, start: number, end: number): boolean {
    const edge = trackEdgeArray(ecs);
    if (edge === null) return false;
    return spanCoversOneEdge(edge.ds, edge.edges, start, end);
}

/** the minimum-extent span at a track-global station — the one edge of the current bake
 *  that the station falls on. Returns null when there's no live bake. This is the span
 *  the summoned-creation menu creates a strip at: the strip appears at the clicked
 *  station at minimum extent, selected, curve flattened and solid (Locked decision). */
export function stripMinExtentAt(ecs: State, d: number): { start: number; end: number } | null {
    const edge = trackEdgeArray(ecs);
    if (edge === null) return null;
    let cum = 0;
    for (let i = 0; i < edge.edges; i++) {
        const next = cum + edge.ds[i];
        if (d < next || i === edge.edges - 1) return { start: cum, end: next };
        cum = next;
    }
    return null;
}

/** the span a summoned strip creation authors at a track-global station:
 *  {@link stripMinExtentAt}'s edge span, grown toward {@link STRIP_DEFAULT_LEN} and
 *  clamped so it neither overlaps a neighboring strip nor runs past the track's own
 *  live extent — the min-extent span is the floor (never shrinks below it), the track's
 *  own end and the next strip's start are the ceiling. Returns null under the same
 *  condition {@link stripMinExtentAt} does. */
export function stripDefaultExtentAt(ecs: State, d: number): { start: number; end: number } | null {
    const minExtent = stripMinExtentAt(ecs, d);
    if (minExtent === null) return null;
    const edge = trackEdgeArray(ecs);
    let trackLen = minExtent.end;
    if (edge !== null) {
        trackLen = 0;
        for (let i = 0; i < edge.edges; i++) trackLen += edge.ds[i];
    }
    let end = Math.min(minExtent.start + STRIP_DEFAULT_LEN, trackLen);
    for (const st of allStrips(ecs)) {
        if (st.start > minExtent.start && st.start < end) end = st.start;
    }
    return { start: minExtent.start, end: Math.max(end, minExtent.end) };
}

/** author a new track-global velocity strip over `[start, end)` at `value` — the create
 *  path, guarded by {@link stripOverlapped} (the ONE guard every write inherits: create,
 *  drag, nudge, and typed-field writes all route through this module's writers), by the
 *  minimum-extent guard ({@link stripCoversOneEdge}: a span whose two ends round to the
 *  same edge boundary collapses to `start === end`, which the point convention displaces to
 *  the preceding edge rather than going inert — the guard refuses this collapse so a stored
 *  strip always covers ≥ 1 edge of the current bake), and by {@link validStripValue} (a
 *  summoned creation's seed reads the live bake's `v` unclamped, exactly 0 at a true stall —
 *  not a controlled span, so creation there is refused rather than authoring a stalled strip).
 *  Seeds two keyframes at `start` and `end`, both at `value` (S4, `seedForceKeyframes`'s own
 *  append/convert idiom) — a bare span offers nothing to grab, so the graph's editability was
 *  invisible; two equal keys bake identically to the no-key constant path (both derive a flat
 *  zero-slope tangent, `autoTangent`), so this changes nothing the constant path already drew.
 *  Returns the new strip's stable id, or `null` when the span would overlap an existing strip,
 *  the span covers no edge, or the value isn't a controlled speed (refused, nothing written). */
export function createStrip(ecs: State, start: number, end: number, value: number): number | null {
    if (stripOverlapped(ecs, start, end, -1)) return null;
    if (!stripCoversOneEdge(ecs, start, end)) return null;
    if (!validStripValue(value)) return null;
    const eid = ecs.create();
    ecs.add(eid, Strip);
    const id = nextStripId++;
    Strip.id.set(eid, id);
    Strip.start.set(eid, start);
    Strip.end.set(eid, end);
    Strip.value.set(eid, value);
    createStripKeyframe(ecs, id, start, value);
    createStripKeyframe(ecs, id, end, value);
    return id;
}

/** re-create a strip at an *exact* id / start / end / value — undo of a delete, redo of a
 *  create, or a snapshot restore. no id allocation, so it round-trips byte-identical;
 *  bypasses {@link stripOverlapped} on purpose (a snapshot restore must be byte-identical
 *  even for a document authored before the guard existed). */
export function spawnStrip(
    ecs: State,
    id: number,
    start: number,
    end: number,
    value: number,
): void {
    const eid = ecs.create();
    ecs.add(eid, Strip);
    Strip.id.set(eid, id);
    Strip.start.set(eid, start);
    Strip.end.set(eid, end);
    Strip.value.set(eid, value);
}

/** destroy a velocity strip by stable id (no-op if already gone). Also destroys
 *  the strip's keyframes — they are child entities that cannot survive their parent. */
export function destroyStrip(ecs: State, id: number): void {
    const eid = stripAt(ecs, id);
    if (eid !== null) ecs.destroy(eid);
    destroyStripKeyframes(ecs, id);
}

// ── the track-start one-shot (S3, Locked decision: "one-shot events are a structurally
// distinct kind") ────────────────────────────────────────────────────────────────────

/** the track's initial-velocity one-shot event — a POINT, structurally distinct from
 *  `Strip` (Locked decision, finding 6: FMOD markers vs regions, Unity signals vs clips —
 *  no surveyed tool models a point as a degenerate span). Always anchored at track-global
 *  `d = 0` (person's verdict, 2026-08-23: track start only — mid-track one-shot is out of
 *  scope, so there is no station column to store); `id` is the stable identity (undo/redo
 *  address, eid-recycle safe, `Strip.id`'s own convention), `value` the entry speed (m/s,
 *  `Entry.v`'s own unit). At most one entity ever carries this component — `seed` creates
 *  it, a delete can remove it, {@link setStartSpeed}'s no-one-shot branch re-creates it. */
export const OneShot = {
    id: sparse(u32),
    value: sparse(f32),
};

export interface OneShotRow {
    eid: number;
    id: number;
    value: number;
}

let nextOneShotId = 0;

/** the track's one-shot, or undefined when none exists (deleted, or a document authored
 *  before `seed` ran). At most one entity ever carries `OneShot` (above), so the first hit
 *  is the only one. */
export function entryOneShot(ecs: State): OneShotRow | undefined {
    for (const eid of ecs.query([OneShot])) {
        return { eid, id: OneShot.id.get(eid), value: OneShot.value.get(eid) };
    }
    return undefined;
}

/** resolve the one-shot by its stable `id` to its eid, or null. */
export function oneShotAt(ecs: State, id: number): number | null {
    for (const eid of ecs.query([OneShot])) {
        if (OneShot.id.get(eid) === id) return eid;
    }
    return null;
}

/** author the one-shot at `value` (floored at `MIN_V0`, {@link setStartSpeed}'s own floor)
 *  — the create path, undo-recorded by `history.addOneShot`. Returns the new stable id. At
 *  most one is ever meant to exist; a caller that creates a second while one already lives
 *  produces two entities (no guard) — `entryOneShot`'s "first hit wins" reading, and
 *  {@link setStartSpeed} never takes this branch when one already exists, so a real UI
 *  gesture never exercises the two-entity case. */
export function createOneShot(ecs: State, value: number): number {
    const eid = ecs.create();
    ecs.add(eid, OneShot);
    const id = nextOneShotId++;
    OneShot.id.set(eid, id);
    OneShot.value.set(eid, Math.max(MIN_V0, value));
    return id;
}

/** re-create the one-shot at an *exact* id/value — undo of a delete, redo of a create, or
 *  a snapshot restore. No id allocation, so it round-trips byte-identical. Mirrors
 *  {@link spawnStrip}. */
export function spawnOneShot(ecs: State, id: number, value: number): void {
    const eid = ecs.create();
    ecs.add(eid, OneShot);
    OneShot.id.set(eid, id);
    OneShot.value.set(eid, value);
}

/** bump the module-private stable-id counters (`nextSectionId`/`nextForceId`/`nextStripId`/
 *  `nextStripKfId`/`nextOneShotId`) past every id a just-spawned batch used, so the NEXT
 *  `create*` call can't re-issue one already on the board. `spawn*` (undo/redo's own respawn,
 *  and now {@link module:doc}'s document load) never advances these counters itself — safe
 *  within one process, since every id it ever spawns was already `< next*Id` at the moment it
 *  was destroyed. A document loaded into a FRESH process (`doc.ts`'s `loadDocument`, the future
 *  CLI's own entry point) has no such guarantee — its ids come from whatever counter state the
 *  authoring session was at, which a fresh process's counters (reset to 0) know nothing about —
 *  so `doc.ts` calls this once after every load. No-op for a same-session save→load (the ids it
 *  names are already covered). */
export function reserveIds(ids: {
    section?: Iterable<number>;
    force?: Iterable<number>;
    strip?: Iterable<number>;
    stripKeyframe?: Iterable<number>;
    oneShot?: Iterable<number>;
}): void {
    for (const id of ids.section ?? []) nextSectionId = Math.max(nextSectionId, id + 1);
    for (const id of ids.force ?? []) nextForceId = Math.max(nextForceId, id + 1);
    for (const id of ids.strip ?? []) nextStripId = Math.max(nextStripId, id + 1);
    for (const id of ids.stripKeyframe ?? []) nextStripKfId = Math.max(nextStripKfId, id + 1);
    for (const id of ids.oneShot ?? []) nextOneShotId = Math.max(nextOneShotId, id + 1);
}

/** destroy the one-shot by stable id (no-op if already gone). Mirrors {@link destroyStrip}
 *  minus the child-keyframe cleanup — a one-shot carries no keyframes. */
export function destroyOneShot(ecs: State, id: number): void {
    const eid = oneShotAt(ecs, id);
    if (eid !== null) ecs.destroy(eid);
}

/** the one-shot's live-authoring value writer (F5: the value popover's inline field edit)
 *  — `setForcePoint`/`setStripKeyframe`'s single-scalar twin, floored at `MIN_V0` like
 *  {@link setStartSpeed}. There is no position write here on purpose: the one-shot's axis
 *  is LOCKED (Locked decision F5) — it lives at `d = 0`, `entryOneShot`'s own invariant —
 *  so unlike a force point or a strip keyframe there is no `s` this writer could move. */
export function setOneShotValue(ecs: State, id: number, value: number): void {
    const eid = oneShotAt(ecs, id);
    if (eid === null) return;
    OneShot.value.set(eid, Math.max(MIN_V0, value));
}

/** a strip's undoable state, keyed by stable id — the drag/nudge/typed-field gesture
 *  snapshots this (`ForcePointState`'s own shape). `kfs` carries every child keyframe's
 *  `(id, s, v)`: a strip's keyframes never move through {@link setStrip} (S3, non-sticking),
 *  so a strip-move gesture's own restore is a no-op over them today, but a delete/undo still
 *  has to respawn the strip's now-default-seeded keyframes rather than losing them. */
export interface StripState {
    id: number;
    start: number;
    end: number;
    value: number;
    kfs: { id: number; s: number; v: number }[];
}

/** snapshot one strip by id, or undefined if it's gone (the gesture opens nothing). */
export function stripState(ecs: State, id: number): StripState | undefined {
    const eid = stripAt(ecs, id);
    if (eid === null) return undefined;
    return {
        id,
        start: Strip.start.get(eid),
        end: Strip.end.get(eid),
        value: Strip.value.get(eid),
        kfs: stripKeyframes(ecs, id).map((k) => ({ id: k.id, s: k.s, v: k.v })),
    };
}

/** write a strip's full state back (the gesture restore / undo path, symmetric with
 *  {@link stripState}) — bypasses the overlap guard, like {@link spawnStrip}: a restore
 *  reproduces exactly what was there, never re-validated against the live document. Also
 *  writes back every keyframe named in `kfs` — a keyframe id absent from the live document
 *  (already deleted by something else) is skipped rather than resurrected here;
 *  `restoreSection`/`spawnStripKeyframe` own that. */
export function restoreStrip(ecs: State, st: StripState): void {
    const eid = stripAt(ecs, st.id);
    if (eid === null) return;
    Strip.start.set(eid, st.start);
    Strip.end.set(eid, st.end);
    Strip.value.set(eid, st.value);
    for (const k of st.kfs) {
        const kfEid = stripKeyframeAt(ecs, k.id);
        if (kfEid === null) continue;
        StripKeyframe.s.set(kfEid, k.s);
        StripKeyframe.v.set(kfEid, k.v);
    }
}

/** write a strip's `start`/`end`/`value` (live drag preview + gesture restore) — the
 *  position writer, mirroring {@link setForcePoint}'s per-axis refusal shape: a span that
 *  would overlap a neighbour is REFUSED (the strip keeps its current `start`/`end`), and
 *  `value` is refused the same way when it isn't a controlled speed ({@link validStripValue}
 *  — the strip keeps its current value). The refusal is what "the guard lives inside the
 *  write op" (Locked decision) means for C3 — an actual drag CLAMPING at the neighbour's
 *  boundary is C5's gesture, built on top of this refusal (it computes a clamped target
 *  and calls this op with that instead), not a second guard here. Non-sticking on a RESIZE
 *  (S3): a keyframe never follows an edge it happens to sit on — every keyframe, boundary
 *  included, holds its station through a `start`/`end` resize, the same as a force keyframe
 *  never stalks a `Section.length` trim. S4's boundary-ride (a keyframe riding the moved edge)
 *  is deleted, not extended: a strip that wants its edge's value tracked keeps a keyframe
 *  there through explicit authoring, same as force. **A BODY drag is the one exception (S5,
 *  F1): the whole strip translates, so every keyframe on it carries with it by the SAME Δd**
 *  — "the container carries its contents," the feel-gate's own generalizing rule — applied by
 *  the caller (`Timeline.svelte`'s `bandMove`) alongside this write, never inside `setStrip`
 *  itself (this op only ever writes `start`/`end`/`value`). */
export function setStrip(ecs: State, id: number, start: number, end: number, value: number): void {
    const eid = stripAt(ecs, id);
    if (eid === null) return;
    if (!stripOverlapped(ecs, start, end, id) && stripCoversOneEdge(ecs, start, end)) {
        Strip.start.set(eid, start);
        Strip.end.set(eid, end);
    }
    if (validStripValue(value)) Strip.value.set(eid, value);
}

/** whether a typed strip value is one the field may commit — finite and STRICTLY positive (a
 *  held speed of 0 is not a controlled span, it's a stall — `validCoefficient`'s own shape,
 *  `>` rather than `>=`). The two real writers of a strip's value route through it:
 *  {@link createStrip} (whose seed, `stripSeedValue`, returns `bakeOut.v` lerped — unclamped,
 *  so exactly 0 at a true stall) refuses the whole creation, and {@link setStrip} refuses just
 *  the value write, keeping the strip's current one. */
export function validStripValue(v: number): boolean {
    return Number.isFinite(v) && v > 0;
}

/** the neighbour-clamp bounds a strip's `start`/`end` may not cross, read at a reference
 *  station `at` (the edge being moved, or the create-drag anchor) — the gesture-side half
 *  of the Locked decision's "drags clamp at the neighbour's boundary": `track.setStrip`'s own
 *  guard only ever REFUSES an overlapping write (`kex2d-map.md`), so every drag/nudge/typed-
 *  field write computes its target through this first and calls `setStrip` with an already-
 *  legal span. `setStrip` also carries the min-extent guard (`stripCoversOneEdge`), which
 *  `bandMove` does NOT pre-compute — so a trim that crosses the one-edge floor is refused by
 *  `setStrip` itself, not by the bounds here. `lo` is the nearest OTHER strip's `end` at or
 *  before `at` (default 0, the track's own start); `hi` is the nearest OTHER strip's `start`
 *  at or after `at` (default `trackLength`, the track's own live exit). `excludeId` is the
 *  strip being moved (-1 for a create, nothing to exclude). Two calls — one at the moving
 *  strip's original `start`, one at its original `end` — cover a body drag (which needs both
 *  ends' bounds at once); a single call at the moved edge's own original position covers a
 *  resize; a call at the anchor covers create. */
export function stripBoundsAt(
    ecs: State,
    excludeId: number,
    trackLength: number,
    at: number,
): { lo: number; hi: number } {
    let lo = 0;
    let hi = trackLength;
    for (const row of allStrips(ecs)) {
        if (row.id === excludeId) continue;
        if (row.end <= at && row.end > lo) lo = row.end;
        if (row.start >= at && row.start < hi) hi = row.start;
    }
    return { lo, hi };
}

/** a new strip's seed value — "seeded at creation from the published bake's `v` at its first
 *  station" (Locked decision), a UI act reading the CURRENT bake, never a kernel mechanism. `d`
 *  is track-global arclength — resolved to its owning section (`toLocal`) and then read off
 *  `bakeOut.v` at that section-local station (`forceSample`'s own address, the same seam a
 *  force keyframe's world position reads), lerped between the bracketing samples. Falls back
 *  to `V0` when there's no live bake to read (an empty track, a placed-past-budget section, a
 *  `d` past the live extent) — the same neutral default an unauthored track's initial speed
 *  carries. */
export function stripSeedValue(ecs: State, d: number): number {
    const trackEid = trackEntity(ecs);
    if (trackEid === null) return V0;
    const out = bakeOut.get(trackEid);
    if (!out) return V0;
    const loc = toLocal(sectionSpans(ecs, trackEid), d);
    if (loc === null) return V0;
    const info = sectionInfo.get(loc.section);
    if (!info) return V0;
    const last = Math.max(0, Track.count.get(trackEid) - 1);
    // `s` is arclength always (S6): `forceSample` has one table now, no `time` branch.
    const addr = forceSample(out, info, last, loc.s);
    if (!addr) return V0;
    const j = Math.min(addr.index + 1, last);
    return out.v[addr.index] + addr.frac * (out.v[j] - out.v[addr.index]);
}

// ── velocity-strip keyframes (T2: value in the graph) ──────────────────────────

/** every keyframe on a strip, sorted by `s` — the order the curve evaluation reads. */
export function stripKeyframes(ecs: State, stripId: number): StripKeyframeRow[] {
    const rows: StripKeyframeRow[] = [];
    for (const eid of ecs.query([StripKeyframe])) {
        if (StripKeyframe.strip.get(eid) !== stripId) continue;
        rows.push({
            eid,
            strip: stripId,
            id: StripKeyframe.id.get(eid),
            s: StripKeyframe.s.get(eid),
            v: StripKeyframe.v.get(eid),
        });
    }
    rows.sort((a, b) => a.s - b.s);
    return rows;
}

/** resolve a strip keyframe by its stable `id` to its eid, or null. */
export function stripKeyframeAt(ecs: State, id: number): number | null {
    for (const eid of ecs.query([StripKeyframe])) {
        if (StripKeyframe.id.get(eid) === id) return eid;
    }
    return null;
}

/** the stable id of the strip that owns a strip keyframe — the per-member containment read
 *  ("which strip owns this keyframe"), or null when the keyframe doesn't resolve (a stale id
 *  across a delete). the Delete path answers ancestor containment through this read's set
 *  form (`owningStrips`), while `controls.ts`'s nudge member resolver reads the same
 *  `StripKeyframe.strip` relation inline. the replace-select sweep instead stores the owner
 *  supplied by the click's hit data on `Member` in editor.ts. */
export function owningStrip(ecs: State, kfId: number): number | null {
    const kfEid = stripKeyframeAt(ecs, kfId);
    return kfEid === null ? null : StripKeyframe.strip.get(kfEid);
}

/** the set of strip ids that own the given keyframes — `owningStrip`'s set form. the Delete
 *  path's own containment read: a strip that owns a selected keyframe is an ANCESTOR of the
 *  set, not a sibling, and survives where the co-selected siblings delete. */
export function owningStrips(ecs: State, kfIds: Iterable<number>): Set<number> {
    const owners = new Set<number>();
    for (const kfId of kfIds) {
        const owner = owningStrip(ecs, kfId);
        if (owner !== null) owners.add(owner);
    }
    return owners;
}

let nextStripKfId = 0;

/** author a new velocity keyframe on a strip at section-local `s` with velocity `v`.
 *  The position is clamped to the strip's `[start, end]` extent (clip-to-extent, the
 *  Locked decision). Returns the new keyframe's stable id. */
export function createStripKeyframe(ecs: State, stripId: number, s: number, v: number): number {
    const stripEid = stripAt(ecs, stripId);
    if (stripEid === null) return -1;
    const start = Strip.start.get(stripEid);
    const end = Strip.end.get(stripEid);
    const cs = Math.max(start, Math.min(end, s));
    const eid = ecs.create();
    ecs.add(eid, StripKeyframe);
    const id = nextStripKfId++;
    StripKeyframe.strip.set(eid, stripId);
    StripKeyframe.id.set(eid, id);
    StripKeyframe.s.set(eid, cs);
    StripKeyframe.v.set(eid, v);
    return id;
}

/** re-create a strip keyframe at an exact strip / id / s / v — undo of a delete, redo
 *  of a create, or a snapshot restore. No id allocation, so it round-trips byte-identical. */
export function spawnStripKeyframe(
    ecs: State,
    stripId: number,
    id: number,
    s: number,
    v: number,
): void {
    const eid = ecs.create();
    ecs.add(eid, StripKeyframe);
    StripKeyframe.strip.set(eid, stripId);
    StripKeyframe.id.set(eid, id);
    StripKeyframe.s.set(eid, s);
    StripKeyframe.v.set(eid, v);
}

/** destroy a strip keyframe by stable id (no-op if already gone). Also destroys all
 *  keyframes on a strip when the strip itself is destroyed. */
export function destroyStripKeyframe(ecs: State, id: number): void {
    const eid = stripKeyframeAt(ecs, id);
    if (eid !== null) ecs.destroy(eid);
}

/** destroy all keyframes on a strip (called when the strip is destroyed). */
export function destroyStripKeyframes(ecs: State, stripId: number): void {
    for (const eid of [...ecs.query([StripKeyframe])]) {
        if (StripKeyframe.strip.get(eid) === stripId) ecs.destroy(eid);
    }
}

/** a strip keyframe's undoable state, keyed by stable id. */
export interface StripKeyframeState {
    strip: number;
    id: number;
    s: number;
    v: number;
}

/** snapshot one strip keyframe by id, or undefined if it's gone. */
export function stripKeyframeState(ecs: State, id: number): StripKeyframeState | undefined {
    const eid = stripKeyframeAt(ecs, id);
    if (eid === null) return undefined;
    return {
        strip: StripKeyframe.strip.get(eid),
        id,
        s: StripKeyframe.s.get(eid),
        v: StripKeyframe.v.get(eid),
    };
}

/** whether a station another keyframe in this strip already holds — the strip-keyframe
 *  twin of {@link stationTaken}. Equality is at f32 via `Math.fround`, matching the force
 *  keyframe guard: `StripKeyframe.s` is `sparse(f32)` and a grid-quantized drag lands on the
 *  same grid its neighbours sit on. Self-excluding (`exceptId`), so a key never collides
 *  with itself. */
export function stripKeyframeTaken(
    ecs: State,
    stripId: number,
    s: number,
    exceptId: number,
): boolean {
    const want = Math.fround(s);
    for (const row of stripKeyframes(ecs, stripId))
        if (row.id !== exceptId && Math.fround(row.s) === want) return true;
    return false;
}

/** the Δd-cap overlap refusal both keyframe kinds ride — one named path (S1's substrate law,
 *  S5b's Locked decision). `ownerId` is the section id for force keyframes, the strip id for
 *  strip keyframes.
 *
 *  **Directional room, never an equality test.** Pre-S5b this dispatched to
 *  {@link stationTaken}/{@link stripKeyframeTaken} — a bit-exact `Math.fround` collision test
 *  that only ever fired by accident, when the (now-deleted) extent clamp saturated a group
 *  drag to exactly a boundary sibling's station. With that clamp gone (F2), discrete pointer
 *  sampling sweeps past the collision value and equality refusal is unreachable. This reads
 *  the nearest OCCUPIED sibling station in the direction `dir` from `s0` and returns the
 *  distance to it (`Infinity` when nothing occupies that direction) — the caller caps the
 *  group's shared Δd strictly short of the tightest member's room, so the write never lands
 *  ON a sibling in the first place. `exceptIds` excludes the WHOLE dragged group (never just
 *  the asking member) — a member never caps against its own group-mate; only a sibling
 *  outside the group can bound the drag. */
export function keyframeRoom(
    ecs: State,
    kind: "force" | "strip",
    ownerId: number,
    s0: number,
    exceptIds: ReadonlySet<number>,
    dir: 1 | -1,
): number {
    const rows = kind === "force" ? sectionForces(ecs, ownerId) : stripKeyframes(ecs, ownerId);
    let room = Infinity;
    for (const row of rows) {
        if (exceptIds.has(row.id)) continue;
        const d = dir > 0 ? row.s - s0 : s0 - row.s;
        if (d >= 0 && d < room) room = d;
    }
    return room;
}

/** write a strip keyframe's position and value (live drag preview + gesture restore).
 *
 *  A station another key in this strip already holds is REFUSED ({@link stripKeyframeTaken}):
 *  the key keeps its current `s` and the `v` write still lands, so a drag crossing a
 *  neighbour slides in v while s pauses on the occupied slot and resumes past it — the
 *  same per-axis refusal {@link setForcePoint} uses.
 *
 *  **No extent clamp (S5, F2).** A keyframe drags freely outside its strip's `[start, end]`
 *  — the write is unclamped, matching {@link setForcePoint}'s own shape exactly (that writer
 *  never clamped to its section's window either). The one shared interaction path (S1) is
 *  what enforces — or doesn't — a container bound; a per-kind clamp inside the pure writer
 *  is the twin this stage retires. `createStripKeyframe`'s own clip-to-extent is unrelated:
 *  that's the CREATE path's deliberate floor, never this LIVE-drag writer's. */
export function setStripKeyframe(ecs: State, id: number, s: number, v: number): void {
    const eid = stripKeyframeAt(ecs, id);
    if (eid === null) return;
    const stripId = StripKeyframe.strip.get(eid);
    const lands = !stripKeyframeTaken(ecs, stripId, s, id);
    if (lands) StripKeyframe.s.set(eid, s);
    StripKeyframe.v.set(eid, v);
}

/** write a strip keyframe's full state back — position and value, direct, bypassing
 *  {@link stripKeyframeTaken} (the gesture restore / undo path, symmetric with
 *  {@link stripKeyframeState}, mirroring {@link restoreForcePoint}). **This is the
 *  snapshot-restore writer only** — `setStripKeyframe` refuses a station another key in
 *  the strip already holds, which is correct for LIVE authoring (a drag pauses at the
 *  occupied slot) but wrong for undo: a multi-member gesture's restore can legitimately
 *  re-park a member back onto a station another member is mid-transit through (or has
 *  already vacated), and a refusal there silently drops that member's position from the
 *  restore, so a multi-member undo is no longer byte-identical to the pre-gesture state.
 *  A snapshot taken from the live document is by construction never in conflict with
 *  itself, so bypassing the guard here never re-creates a coincidence the store didn't
 *  already hold. */
export function restoreStripKeyframe(ecs: State, st: StripKeyframeState): void {
    const eid = stripKeyframeAt(ecs, st.id);
    if (eid === null) return;
    StripKeyframe.s.set(eid, st.s);
    StripKeyframe.v.set(eid, st.v);
}

/** convert a section's authored strips from its own domain coordinate into the kernel's
 *  edge-index coordinate (`section.Strip`, "the SAME indexing `fN`/`ds` already carry") —
 *  the ONE seam between the ECS's domain-coordinate storage and the substrate's edge
 *  addressing, read by both the live bake (`geoPayload`/`forcePayload`/`forceBake`) and pin
 *  mode's stamp/ghost (`pin.ts`). `ds` is the section's own per-edge step array (uniform
 *  for a force section's resolved {@link Step}, the adaptive Hermite chord array for a geo
 *  section) — a PURE derivation from the caller's own already-resolved step, never a bake
 *  read: this is what keeps pin mode's override construction structurally bake-read-free.
 *  Each boundary resolves to its NEAREST edge boundary (ties toward the earlier edge), the
 *  same round-to-nearest reading `evalForce`'s own σ sampling uses for a uniform grid,
 *  generalized to geo's non-uniform one. Returns `undefined` when the section has no strips, so an
 *  unauthored section threads no override (byte-identical to before strips existed).
 *
 *  A row wholly past the current extent (`r.start >= total` — a trim that shrank the section
 *  below the strip's own start, or a wholly-outside strip surviving a rebase) is dropped before
 *  the boundary map runs, rather than threaded through it: `boundary` would clamp BOTH its ends
 *  to `edges`, collapsing to the degenerate `start === end` case the point convention re-maps to
 *  the PRECEDING edge `[edges−1, edges)` — displacing the inert strip's override onto the
 *  section's own last live edge instead of leaving it inert (the extent law's non-destructive
 *  contract: a strip past the extent draws clipped and bakes clipped, never displaced). A row
 *  straddling the extent (`start < total <= end`) is untouched here — its `end` already clamps to
 *  `edges` through `boundary`, which is the clip the extent law asks for. */
export function edgeStrips(
    ds: ArrayLike<number>,
    edges: number,
    rows: readonly {
        start: number;
        end: number;
        value: number;
        keyframes?: { s: number; v: number }[];
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
            // pre-evaluate the keyframed curve per-edge using the force-curve machinery
            // (profile.sampleForce): the keyframes are {s, v} in domain coordinates,
            // evaluated as {s, g: v} ForcePoints with default Cubic easing. The per-edge
            // v² is stored in `values`, indexed [0, end − lo), so stripOverride is a
            // lookup, not a curve evaluation.
            const points = r.keyframes.map((k) => ({ s: k.s, g: k.v }));
            const values = new Float32Array(end - lo);
            for (let k = lo; k < end; k++) {
                // a station-0 degenerate strip has lo = -1, so cum[-1] is undefined;
                // sampleForce with its single boundary-pinned keyframe short-circuits
                // past sigma today, but the ?? 0 keeps that inertness an invariant
                // rather than a coincidence of the current branch order.
                const sigma = cum[k] ?? 0;
                const v = sampleForce(points, sigma);
                values[k - lo] = v * v;
            }
            return { start, end, value: r.value, values };
        }
        return { start, end, value: r.value };
    });
}

/** the section's own baked per-edge chord array, sampled fresh off its LIVE geo nodes —
 *  chord length is frame-invariant (rigid placement preserves distance), so no entry/
 *  placement is needed. The pre-bake reading a structural op (a geo strip's edge-index
 *  resolution) needs before a real bake exists to read
 *  `bakeOut`/`sectionInfo` from — reusing this instead of a bake read is what keeps a
 *  structural op honest about NOT depending on stale bake output. */
function geoChordDs(
    ecs: State,
    sectionId: number,
    dsNominal: number,
): { ds: Float32Array; edges: number; offsets: number[] } {
    const nodes = geoNodes(ecs, sectionId);
    const posX = new Float32Array(MAX_SAMPLES);
    const posY = new Float32Array(MAX_SAMPLES);
    const dsArr = new Float32Array(Math.max(1, MAX_SAMPLES - 1));
    const r = sampleChain(nodes, dsNominal, posX, posY, dsArr, MAX_SAMPLES);
    return { ds: dsArr, edges: r.edges, offsets: r.offsets };
}

type Samples = {
    posX: Float32Array;
    posY: Float32Array;
    theta: Float32Array;
};

/** SoA sample buffers per track, sized once to MAX_SAMPLES. only indices
 *  `[0, Track.count)` carry valid data. */
export const samples = new Map<number, Samples>();

/** baked per-edge state for each track. `fN` is force in g (per-edge, length
 *  MAX_SAMPLES − 1). `ds` is per-edge actual spacing. `v` is the recovered
 *  speed (m/s, per-sample, length MAX_SAMPLES) — `forces`' own output,
 *  `ChainResult.v` threaded straight through `chain()`; the timeline's
 *  velocity channel reads it (`cart.velocityCurve`), `cart.forceCurve`'s
 *  twin. `t` is per-sample cumulative time `t[i] = Σ_{k<i} ds_k / v_safe_k`,
 *  length MAX_SAMPLES — the cart and the timeline read from it. `tTotal =
 *  t[count − 1]`. `feasible[i]` is 1 when `|v[i]| ≥ V_WARN`, 0 otherwise —
 *  drives the red track / red handle / warning banner UX. `firstInfeasible`
 *  is the first sample below V_WARN, or -1 if the whole chain is feasible.
 *  `hash` is the input state that produced the current bake; a miss triggers
 *  a full re-bake.
 *
 *  OWED: this is a module-level `Map` keyed by entity id, so two `State()` instances collide
 *  — both start id counting at 0, so a test constructing two independent states silently reads
 *  the wrong bake. Whichever stage next needs two states owns the fix. */
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

/** @temporary S3–S7 — evaluator metadata keyed by stable run identity. */
export const runInfo = new Map<number, SectionInfo>();

export const MAX_SAMPLES = 4096;

/** the track's nominal sampling step (m) — what every section bakes at. */
export const DS_NOMINAL = 0.5;

/** the fallback initial speed (m/s) when no one-shot exists (`entrySpeed`'s own `else` —
 *  the same idiom `bakeEntryForce` uses for `DEFAULT_G`). `seed` authors a one-shot at
 *  this value, so a fresh document's own entry speed reads `V0` through the ordinary
 *  one-shot path, not this fallback; the fallback fires once that one-shot is deleted.
 *  matches kexedit / FVD. */
export const V0 = 10;

/** the slowest the track-start one-shot's authored speed can be set — a positive floor so
 *  the start is never zero/negative (which would make a level track take infinite time).
 *  exported for `doc.ts`'s document-boundary invariant check (`checkDocInvariants`) — a
 *  hand-authored one-shot below this floor loads silently otherwise, since {@link
 *  setStartSpeed}/{@link setOneShotValue} clamp rather than refuse. */
export const MIN_V0 = 0.1;

/** a fresh track's default Coulomb friction coefficient — ported verbatim from the incumbent
 *  core's `DEFAULT_FRICTION` (`packages/core/src/track/dispatch.rs`), independently grounded:
 *  0.021 sits mid-range for polyurethane wheels on steel rail (~0.01–0.03), the actual coaster
 *  contact pair. Nonzero and physical, unlike the
 *  kernel's own zero-coefficient default (`forward.ts`'s `friction`/`resistance` params) — the
 *  kernel default is what an ABSENT `Track.friction` restores to (`TrackPlugin.traits`,
 *  below), never this. */
export const DEFAULT_FRICTION = 0.021;

/** a fresh track's default quadratic-drag coefficient (1/m), derived (not ported) from
 *  `c = ρ·C_d·A/2m` with ρ = 1.225, C_d = 1.0, A = 2.5 m², m = 6000 kg — a 24-rider train's
 *  open bluff-body drag, rounded up from 2.55e-4 (erring high is the safe direction — a layout
 *  that clears in the sim clears in reality). ~13× the incumbent core's undocumented `2e-5`, whose implied
 *  terminal velocity (700 m/s) has no physical grounding. */
export const DEFAULT_RESISTANCE = 2.5e-4;

/** how far `extend` lays the next node past the chain end, along the last edge's
 *  direction. it's a starting point you then drag, not a fixed length. */
export const EXTEND_DIST = 24;

/** the extent (m) a summoned strip creation grows to, from the station's min-extent edge
 *  span up to a velocity-strip-typical length (feel-gate F3, person's verdict 2026-08-26: ~10 m,
 *  meters because meters are the store) — an independent literal, not derived from
 *  `EXTEND_DIST`: a velocity strip and a fresh section answer different questions ("how far does
 *  the speed control run" vs. "how long is a section before someone resizes it"), and the two
 *  happened to share a value only by construction of the substrate this stage retires. */
export const STRIP_DEFAULT_LEN = 10;

/** the track's initial anchor for a given initial speed: the entry to the first
 *  section, a level start at the origin. world position is cosmetic in this 2D
 *  prototype (the view auto-frames), so it's fixed — the authored variable is the
 *  derived initial speed `v` ({@link entrySpeed}), which this threads into the entry
 *  frame. */
function startEntry(v0: number): Entry {
    return { x: 0, y: 0, theta: 0, v: v0 };
}

/** the extent (m) a fresh force section gets — an append or a geo→force convert
 *  resets to this (the extent is the force section's own authored property, not a
 *  leftover of the pre-convert geo shape). matches the geo seed's length, so a fresh
 *  geo and a fresh force section start the same size; the end handle then resizes it. */
const DEFAULT_FORCE_LEN = EXTEND_DIST;

/** the extent a fresh force section gets — what a destructive geo→force convert resets to
 *  (an append takes the sticky instead). */
function defaultForceExtent(): number {
    return DEFAULT_FORCE_LEN;
}

/** the shortest a force section can be dragged — a couple of edges, so the profile
 *  never collapses below what `forceProfile` can sample. */
export const MIN_FORCE_LEN = 2;

/** the shortest a force section's extent can be — always meters of arclength.
 *  `domain` is accepted (and ignored) so the Time-view callers `minForceExtent` still
 *  serves (the ruler snap floor) keep compiling unchanged; it no longer selects a
 *  second, seconds-native floor. */
export function minForceExtent(_domain: Domain = Domain.Distance): number {
    return MIN_FORCE_LEN;
}

/** minimum legal authored extent for the evaluator run containing `segmentId`. */
export function minRunForceExtent(
    ecs: State,
    segmentId: number,
    domain: Domain = trackDomain(ecs),
): number {
    const run = rebuildRunProjection(ecs).find((row) => row.segmentIds.includes(segmentId));
    if (!run) throw new Error(`minRunForceExtent: no segment ${segmentId}`);
    return minForceExtent(domain);
}

/** the session's sticky append length — what a freshly APPENDED piece starts at, echoing the
 *  last length the author committed by hand. Each kind's length is its own authoring quantum:
 *  a **force** section's is its extent (the clip's right-edge trim), a **geo** section's is the
 *  chord `extend` lays down (the polar length manipulator). Updated only when such a gesture
 *  COMMITS (`setStickyLen`, from `history.commitLength` / `history.commitChord`), never by a
 *  solve landing (a converted section's realized extent is the solve's own answer, not an
 *  authored trim) and never by a destructive convert (which resets to the literal default —
 *  its shape has no "previous append" to echo). Session-level module state: not persisted
 *  across reloads, not threaded through undo, so undoing an append never rolls it back. Both
 *  kinds are one scalar in meters — force carries no domain either, since the store is
 *  domain-invariant. */
let stickyGeoChord = EXTEND_DIST;
let stickyForceExtent = DEFAULT_FORCE_LEN;

/** read the session's current sticky append length for a section kind. `domain` is accepted
 *  (and ignored) for the same reason `minForceExtent` still takes it: the view callers pass
 *  `trackDomain(ecs)` and this stays a drop-in. */
export function stickyLen(kind: SectionKind, _domain: Domain = Domain.Distance): number {
    return kind === SectionKind.Geo ? stickyGeoChord : stickyForceExtent;
}

/** record a committed length gesture as that kind's new sticky append default, clamped to the
 *  floor its own gesture holds — `LENGTH_MIN` for a geo chord, `MIN_FORCE_LEN` for an extent
 *  trim — so a degenerate commit can't poison the next append. A non-finite value is ignored
 *  (a degenerate frame has no length to remember). `domain` is accepted (and ignored) so
 *  callers passing `trackDomain(ecs)` still compile. */
export function setStickyLen(
    kind: SectionKind,
    length: number,
    _domain: Domain = Domain.Distance,
): void {
    if (!Number.isFinite(length)) return;
    if (kind === SectionKind.Geo) stickyGeoChord = Math.max(LENGTH_MIN, length);
    else stickyForceExtent = Math.max(MIN_FORCE_LEN, length);
}

/** allocate an empty track entity + its sample / bake-output buffers, sized once
 *  to MAX_SAMPLES. no sections — callers (the demo seed, tests) add their own. friction/
 *  resistance start at the kernel's own neutral 0 (an unauthored track's march is
 *  byte-identical to before the coefficient existed, the same law `forward.ts`'s own
 *  defaulted params hold) — `DEFAULT_FRICTION`/`DEFAULT_RESISTANCE` are `seed`'s to apply, the
 *  one place a genuinely NEW authored track (as opposed to this bare entity every test also
 *  builds on) comes from. returns the track eid. */
export function createTrack(ecs: State): number {
    const trackEid = ecs.create();
    ecs.add(trackEid, Track);
    ecs.add(trackEid, TrackStart);
    TrackStart.id.set(trackEid, 0);
    Track.count.set(trackEid, 0);
    Track.ds.set(trackEid, DS_NOMINAL);
    Track.domain.set(trackEid, Domain.Distance);
    Track.friction.set(trackEid, 0);
    Track.resistance.set(trackEid, 0);
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

// ── sections ─────────────────────────────────────────────────────────────────

// monotone id source — never reused, even after a delete: history can re-spawn any
// deleted section, so a scan-the-live-set allocator would alias a fresh section
// with a restorable one (the eid-recycling bug one level up).
let nextSectionId = 0;

/** a section read off the ECS: eid + its stable id, chain order, kind, and force
 *  extent. */
export interface SectionRow {
    eid: number;
    id: number;
    order: number;
    kind: SectionKind;
    length: number;
}

/** every section, sorted by chain order — the sequence the bake threads and the
 *  UI walks. */
export function segments(ecs: State): SectionRow[] {
    const rows: SectionRow[] = [];
    for (const eid of ecs.query([Section])) {
        rows.push({
            eid,
            id: Section.id.get(eid),
            order: Section.order.get(eid),
            kind: Section.kind.get(eid) as SectionKind,
            length: Section.length.get(eid),
        });
    }
    rows.sort((a, b) => a.order - b.order);
    return rows;
}

/** @temporary S7 — legacy section reader projected from the canonical segment chain. */
export const sections = segments;

/** resolve a canonical segment by its stable id to its eid, or null. */
export function segmentAt(ecs: State, id: number): number | null {
    for (const eid of ecs.query([Segment])) {
        if (Segment.id.get(eid) === id) return eid;
    }
    return null;
}

/** @temporary S7 — legacy section lookup projected from stable segment identity. */
export const sectionAt = segmentAt;

/** a section's place on the track-global arclength axis: the distance `d` at the section's
 *  entry (the cumulative baked arclength of every upstream section) and its own baked
 *  arclength, so it occupies the d-interval `[offset, offset + len]`. Geometry lives here — a
 *  geo node's landing, the cart's park, the viewport, and (S6) every force keyframe/extent/strip
 *  too, since arclength is the one canonical parameter every authored component stores.
 *
 *  There is no second, Time-domain axis here (S6 retired the `Track.domain`-carried switch a
 *  force keyframe's stored `s` used to need — arclength always). A Time-domain DISPLAY reading
 *  is a separate projection through the live bake's s↔t table (`timeline.ts`'s `dToU`/`uToD`),
 *  never a second address space, so this type carries `offset`/`len` alone (S3 retired the
 *  `entryU`/`lenU` reading that used to shadow them). */
export interface SectionSpan {
    id: number;
    offset: number;
    len: number;
}

/** one section's `(entry, extent)` — the pair the affine and its inverse resolve over. */
type Axis = (sp: SectionSpan) => { entry: number; extent: number };

const arcAxis: Axis = (sp) => ({ entry: sp.offset, extent: sp.len });

/** the coordinate lens — the ONE seam between the author-facing track-global arclength and the
 *  section-local `s` the substrate stores. `sectionSpans` is its table (one accumulating pass
 *  over the baked ds), and `toGlobal`/`toLocal` are the affine `global = entry + local` and its
 *  inverse over it. every readout — timeline clips/boundaries, force-keyframe placement, cart
 *  park — derives here; nothing walks the cumulative ds itself. sections are contiguous (each
 *  shares its entry sample with the prior exit), so one pass suffices. */
export function sectionSpans(ecs: State, eid: number): SectionSpan[] {
    const out = bakeOut.get(eid);
    if (!out) return [];
    const last = Math.max(0, Track.count.get(eid) - 1);
    const res: SectionSpan[] = [];
    let cum = 0;
    for (const run of rebuildRunProjection(ecs)) {
        const info = runInfo.get(run.id);
        if (!info) continue;
        const offset = cum;
        // clamped to the PUBLISHED buffer: a section placed past the sample budget has a range
        // pointing at edges that were never written, and summing those would put NaN into every
        // span downstream of it. Its extent reads 0 there — which is what it has on the bake —
        // so the strip and the guides describe the baked prefix honestly.
        for (let i = info.startSample; i < Math.min(info.endSample, last); i++) cum += out.ds[i];
        res.push({ id: run.id, offset, len: cum - offset });
    }
    return res;
}

function toGlobalOn(axis: Axis, spans: SectionSpan[], section: number, s: number): number | null {
    const sp = spans.find((x) => x.id === section);
    return sp ? axis(sp).entry + s : null;
}

function toLocalOn(
    axis: Axis,
    spans: SectionSpan[],
    x: number,
): { section: number; s: number } | null {
    if (spans.length === 0) return null;
    for (const sp of spans) {
        const { entry, extent } = axis(sp);
        if (x <= entry + extent) return { section: sp.id, s: Math.max(0, x - entry) };
    }
    const last = axis(spans[spans.length - 1]);
    return { section: spans[spans.length - 1].id, s: last.extent };
}

/** section-local arclength `(section, s)` → track-global distance `d = offset + s`. null when the
 *  section isn't on the current bake. */
export function toGlobal(spans: SectionSpan[], section: number, s: number): number | null {
    return toGlobalOn(arcAxis, spans, section, s);
}

/** track-global distance `d` → the section-local arclength address `(section, s)`. boundary
 *  policy: a `d` on a shared section boundary resolves to the UPSTREAM (earlier) section — the
 *  first span whose exit reaches `d` wins (left/upstream-inclusive spans), matching the clip
 *  strip's boundary guides and the cart's park resolution. out-of-range `d` resolves to the
 *  nearest end of the track. null when there's no bake. */
export function toLocal(spans: SectionSpan[], d: number): { section: number; s: number } | null {
    return toLocalOn(arcAxis, spans, d);
}

/** the baked sample address of a section-local arclength coordinate — where a force
 *  keyframe's stored `s` lands on the flat SoA. Walks the bake's own per-edge `out.ds` within
 *  the section's published range (never a chord re-derivation, never the cart's arc↔time
 *  detour), so a zero-length edge (the pin freeze's gap) is stepped over rather than divided
 *  by. Returns the flat sample index plus the fraction toward `index + 1` (an exit landing
 *  reads `{endSample, 0}`), clamped to the section's range at both ends; null when the section
 *  published no edges (placed past the sample budget). */
export function forceSample(
    out: { ds: Float32Array },
    info: { startSample: number; endSample: number },
    last: number,
    s: number,
): { index: number; frac: number } | null {
    const start = info.startSample;
    const end = Math.min(info.endSample, last);
    if (start >= end) return null; // an empty published range — nothing to place on
    let cum = 0;
    for (let i = start; i < end; i++) {
        const d = out.ds[i];
        if (cum + d >= s) {
            return { index: i, frac: d > 0 ? Math.min(Math.max((s - cum) / d, 0), 1) : 0 };
        }
        cum += d;
    }
    return { index: end, frac: 0 };
}

/** a force keyframe's world position on the baked track — the viewport marker substrate
 *  (`kindSegments`'s force-point sibling): stable id, owning section, and the world point its
 *  stored native-axis `s` lands at (`forceSample` over the bake's own tables, lerped between
 *  the bracketing samples). Skips a section with no published edges, and skips a key whose
 *  `s` exceeds the section's extent — a trimmed-past key has no track position (the
 *  non-destructive trim law: re-lengthening restores it), so clamping it onto the exit
 *  seed would draw a position that isn't the key's. Read by the render's ForceDrawSystem
 *  and the controls' pick — display + select only, never a drag target. */
export interface ForceMarker {
    id: number;
    section: number;
    x: number;
    y: number;
}

export function forceMarkers(ecs: State): ForceMarker[] {
    const res: ForceMarker[] = [];
    const trackEid = trackEntity(ecs);
    if (trackEid === null) return res;
    const s = samples.get(trackEid);
    const out = bakeOut.get(trackEid);
    if (!s || !out) return res;
    const last = Math.max(0, Track.count.get(trackEid) - 1);
    for (const run of rebuildRunProjection(ecs)) {
        if (run.kind !== SectionKind.Force) continue;
        const info = runInfo.get(run.id);
        if (!info) continue;
        for (let member = 0; member < run.segmentIds.length; member++) {
            const segmentId = run.segmentIds[member]!;
            const offset = run.stations[member]!;
            const memberExtent = run.stations[member + 1]! - offset;
            for (const p of sectionForces(ecs, segmentId)) {
                if (p.s > memberExtent) continue;
                const addr = forceSample(out, info, last, offset + p.s);
                if (!addr) continue;
                const j = Math.min(addr.index + 1, last);
                res.push({
                    id: p.id,
                    section: segmentId,
                    x: s.posX[addr.index] + addr.frac * (s.posX[j] - s.posX[addr.index]),
                    y: s.posY[addr.index] + addr.frac * (s.posY[j] - s.posY[addr.index]),
                });
            }
        }
    }
    return res;
}

/** create a section at `order` with a fresh stable id — the append/seed path.
 *  returns the id (undo/redo, membership, and selection address by id). */
export function createSection(
    ecs: State,
    order: number,
    kind: SectionKind,
    length: number,
): number {
    const eid = ecs.create();
    ecs.add(eid, Section);
    const id = nextSectionId++;
    Section.id.set(eid, id);
    Section.order.set(eid, order);
    Section.kind.set(eid, kind);
    Section.length.set(eid, length);
    Segment.run.set(eid, id);
    Segment.runStation.set(eid, 0);
    Segment.runExtent.set(eid, length);
    return id;
}

/** re-create a section at an *exact* id / order / kind / length — undo of a delete, redo of
 *  a create, or a snapshot restore. no id allocation, so it round-trips byte-identical.
 *  its nodes/points are respawned separately. */
function spawnSection(
    ecs: State,
    id: number,
    order: number,
    kind: SectionKind,
    length: number,
): void {
    const eid = ecs.create();
    ecs.add(eid, Section);
    Section.id.set(eid, id);
    Section.order.set(eid, order);
    Section.kind.set(eid, kind);
    Section.length.set(eid, length);
    Segment.run.set(eid, id);
    Segment.runStation.set(eid, 0);
    Segment.runExtent.set(eid, length);
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
        Handle.theta.set(eid, creationTheta(prev, x, y));
        // the old tip becomes interior but stays live (`Auto`) — the default add/drag flow stores
        // NO tangents and shapes exactly like the pre-handles editor (frozen interior heading,
        // chord-scaled length, tip reflection). a node turns concrete bezier only when authored
        // (a handle drag or a mode set), never at append.
    }
    return eid;
}

/** the heading a node is born with at section-local `(x, y)`: the circular-arc reflection of
 *  its predecessor's exit about their chord — `addNode`'s own seed, shared with `resetNode` so
 *  re-creation can't drift from creation (placed straight along the exit, the reflection
 *  returns the exit heading exactly). */
function creationTheta(prev: number, x: number, y: number): number {
    const chord = Math.atan2(y - Handle.pos.y.get(prev), x - Handle.pos.x.get(prev));
    return reflect(exitHeading(prev), chord);
}

/** the creation placement past `prev`: `chord` metres straight along its exit heading — where
 *  `extend` lays a fresh node and where `resetNode` returns one. one shared body so append and
 *  Reset can't drift (the resetToForce/resetToGeo factoring precedent). */
function continuation(prev: number, chord: number): { x: number; y: number } {
    const th = exitHeading(prev);
    return {
        x: Handle.pos.x.get(prev) + Math.cos(th) * chord,
        y: Handle.pos.y.get(prev) + Math.sin(th) * chord,
    };
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

/** the tip's arc-rule heading: the circular-arc reflection of its predecessor's
 *  heading about their chord. re-derived only on the tip's OWN move (`reheadOnDrag`)
 *  and on a user Reset (`resetTangent`) — never by a neighbor's op: `theta` is
 *  authored substrate state (append seeds it, a polar move sets it), so a delete's
 *  promotion touches nothing. takes the section's sorted handles; no-op below two
 *  nodes. */
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

/** the tangent-clear half of Reset: clear a node's explicit tangent back to live (`Auto`
 *  inference resumes). the user-facing node Reset is `resetNode` (re-create — it delegates
 *  here for node 0, whose position isn't authorable: the entry anchor returns to the `Auto`
 *  C1 exit along the entry heading); this stays the bare clear for the boundary stitch's
 *  node-0 half and the tip re-track. does not itself record history — a gesture
 *  (`beginMove`/`commit`) wraps it, `nodeSnapshot` captures the tangent + theta for undo. */
export function resetTangent(ecs: State, sectionId: number, order: number): void {
    const handles = sectionHandles(ecs, sectionId);
    if (handles.length === 0) return;
    const eid = handleAt(ecs, sectionId, order);
    if (eid === null) return;
    writeTangent(eid, undefined); // clear to live
    if (eid === handles[handles.length - 1]) headLast(handles); // the tip re-tracks its predecessor
}

/** the Reset action for a node past order 0: RE-CREATE it — return it to the state a fresh
 *  append would have given it (the Reset idiom law: the state a fresh author would get).
 *  position = the continuation along its PREDECESSOR's exit heading at the default chord
 *  `EXTEND_DIST` (the named default — the session-sticky length is unknowable creation-time
 *  state), tangent cleared to `Auto`, heading re-seeded by the same arc-rule reflection
 *  `addNode` writes at creation (`creationTheta`) — one formula for tip and interior alike,
 *  since every node was the tip when it was created (placed on the exit ray, the reflection
 *  returns the exit heading exactly). Reset is the node's OWN action, so the tip re-head is
 *  sanctioned by the tip law; a neighbor's heading is never touched. node 0 (the pinned
 *  entry — position not authorable) keeps the tangent clear (`resetTangent`). does not
 *  itself record history — a command wraps it (`history.resetNodes`). */
export function resetNode(ecs: State, sectionId: number, order: number): void {
    if (order === 0) {
        resetTangent(ecs, sectionId, order);
        return;
    }
    const eid = handleAt(ecs, sectionId, order);
    const prev = handleAt(ecs, sectionId, order - 1);
    if (eid === null || prev === null) return;
    const p = continuation(prev, EXTEND_DIST);
    Handle.pos.set(eid, p.x, p.y);
    writeTangent(eid, undefined);
    Handle.theta.set(eid, creationTheta(prev, p.x, p.y));
}

/** refresh headings after a node is dragged. the **last** (heading) node re-heads
 *  only on its OWN move — node 0 (the flat anchor) and every **interior** node
 *  (including the one just before the tip) keep their heading frozen. the arc
 *  contract can't hold on both of an interior node's segments at once, so a stable
 *  heading beats one that thrashes, and re-heading on a neighbor's move swings the
 *  last segment visibly (the misfeature this scoping removes — uniform with every
 *  other interior node staying frozen). a drag only changes the last node's own
 *  heading, so the edit stays local; tangent lengths re-proportion automatically. */
export function reheadOnDrag(ecs: State, eid: number): void {
    const sectionId = Handle.section.get(eid);
    const handles = sectionHandles(ecs, sectionId);
    const last = handles.length - 1;
    if (last < 1) return;
    const idx = handles.indexOf(eid);
    if (idx === last) headLast(handles);
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
    const p = continuation(last, stickyLen(SectionKind.Geo));
    return addNode(ecs, sectionId, p.x, p.y);
}

/** remove the trailing (highest-order) node on a section — never below the two
 *  nodes a geo section needs (node 0 the entry + one shape node). promotion touches
 *  nothing — authored state is never implicitly destroyed, and a neighbor's delete
 *  is not the tip's own move (the re-head list is own move + append only): an
 *  explicit promoted tip keeps its tangent whole, an `Auto` one keeps its frozen
 *  `theta` (authored by the node's own polar move, exactly as the tangent record
 *  is), so the surviving segment holds byte-identical and the tip exits along
 *  what it displayed before the delete (`exitHeading`: the authored out-vector,
 *  else `theta`). returns true when a node was removed. */
export function removeTrailingHandle(ecs: State, sectionId: number): boolean {
    const last = lastHandle(ecs, sectionId);
    if (last === null) return false;
    if (sectionHandles(ecs, sectionId).length <= 2) return false;
    ecs.destroy(last);
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

/** mint a force-keyframe id without creating the entity. Ids are monotone and never
 *  reused, so an id minted for a transform that then rejects is simply skipped.
 *
 * @example const id = allocForceId(); // then plant it through `spawnForce` */
export function allocForceId(): number {
    return nextForceId++;
}

/** author a new force point on a section at `(s, g)` with a fresh stable id — the
 *  create path. returns the id (undo/redo addresses points by id, not eid). `ease`
 *  defaults to the "no stored state" convention (a fresh keyframe). */
export function createForcePoint(
    ecs: State,
    sectionId: number,
    s: number,
    g: number,
    ease: Easing = FORCE_EASE_DEFAULT,
): number {
    const eid = ecs.create();
    ecs.add(eid, Force);
    ecs.add(eid, ForceBoundary);
    const id = allocForceId();
    Force.section.set(eid, sectionId);
    Force.id.set(eid, id);
    Force.s.set(eid, s);
    ForceBoundary.g.set(eid, g);
    ForceBoundary.ease.set(eid, ease);
    return id;
}

/** re-create a force point at an *exact* section / id / s / g / easing tag — undo of
 *  a delete, redo of a create, or a snapshot restore. no id allocation, so it
 *  round-trips byte-identical. */
export function spawnForce(
    ecs: State,
    sectionId: number,
    id: number,
    s: number,
    g: number,
    ease: Easing = FORCE_EASE_DEFAULT,
): void {
    const eid = ecs.create();
    ecs.add(eid, Force);
    ecs.add(eid, ForceBoundary);
    Force.section.set(eid, sectionId);
    Force.id.set(eid, id);
    Force.s.set(eid, s);
    ForceBoundary.g.set(eid, g);
    ForceBoundary.ease.set(eid, ease);
}

/** destroy a force point by stable id (no-op if already gone). */
export function destroyForce(ecs: State, id: number): void {
    const eid = forceAt(ecs, id);
    if (eid !== null) ecs.destroy(eid);
}

/** a force point's undoable state, keyed by stable id: its position (`s`/`g`) and its easing
 *  tag. `section` records which section owns the point;
 *  `restoreForcePoint` addresses the existing point by id and does NOT rewrite `Force.section`
 *  — a point changes section only inside a structural op, which snapshots the whole track. the
 *  drag/field/easing gestures snapshot this. */
export interface ForcePointState {
    section: number;
    id: number;
    s: number;
    g: number;
    ease: Easing;
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
    };
}

/** field-wise equality on a force keyframe's undoable state — the gesture no-op test for every
 *  surface that writes a force point, `sameNodes`'s per-key twin.
 *
 *  **Exhaustive by type, deliberately.** The comparator is a table keyed on `keyof ForcePointState`,
 *  so adding a column to that interface without deciding how the gesture compares it fails
 *  `bun check` rather than silently widening the no-op class. That is the defect this shape exists
 *  to prevent: the predicate was hand-written as `a.s === b.s && a.g === b.g` while `setForcePoint`
 *  mutated a third field (`carried`), so a drag returning to its origin cleared the provenance bit,
 *  moved `authoredHash`, and recorded NOTHING — an un-undoable document mutation.
 *
 * @example if (sameForcePoint(prev, next)) return; // a click, or a nudge back to start */
export function sameForcePoint(a: ForcePointState, b: ForcePointState): boolean {
    for (const eq of Object.values(FORCE_POINT_EQ)) if (!eq(a, b)) return false;
    return true;
}

/** one predicate per `ForcePointState` column — see {@link sameForcePoint} for why it is a keyed
 *  table rather than a conjunction. `section` is compared too: a point changes section only inside a
 *  structural op, so a gesture seeing it move is a real change, never a no-op. */
const FORCE_POINT_EQ: {
    [K in keyof Required<ForcePointState>]: (a: ForcePointState, b: ForcePointState) => boolean;
} = {
    section: (a, b) => a.section === b.section,
    id: (a, b) => a.id === b.id,
    s: (a, b) => a.s === b.s,
    g: (a, b) => a.g === b.g,
    ease: (a, b) => a.ease === b.ease,
};

/** whether another keyframe in `sectionId` already occupies the station `s` — `exceptId` being
 *  the key asking (a key never collides with itself).
 *
 *  **Two keyframes of one property at one station are degenerate**, the invariant every keyframe
 *  editor holds (AE / Premiere / Unity all refuse it): the pair spans a zero-width segment, which
 *  `profile.segment` resolves as a vertical step in the authored profile, and the two diamonds
 *  draw at one point so only the later-painted one is clickable. The INSERT path has always read
 *  it this way — `Timeline.svelte`'s `chartCreate` drops force points from its snap pool because
 *  "an occupied s is degenerate" — and this is the same rule on the WRITE path, so the drag, the
 *  arrow nudge, and the popover's typed field inherit it by construction rather than each carrying
 *  its own guard (`editor-ui.md`'s consent-boundary law).
 *
 *  **Section-scoped, never track-global.** Two keys in DIFFERENT sections may share a station: a
 *  cut plants exactly that pair at the boundary by design, so a track-global check would refuse
 *  the document's own structural op.
 *
 *  Equality is at f32 via `Math.fround`, which is COARSER than the store: `Force.s` is
 *  `sparse(f32)` but the columns do not round on set (a stored 0.9 reads back 0.9, while
 *  `Math.fround(0.9)` is 0.8999999761581421), so the guard's `Math.fround` comparison is
 *  slightly wider than exact stored-value equality — two values the store would keep
 *  distinct can be refused because they f32-round to the same value. That is what "the same
 *  station" means in practice, and it is the reachable collision rather than a sub-ulp
 *  coincidence: `S_GRID`/`T_GRID` quantize a snapped drag onto the same grid its neighbours
 *  already sit on. A continuous (Ctrl-bypassed) drag can still park a key arbitrarily close
 *  to a neighbour without landing on it — near-coincidence is legal, distinct under a fine
 *  drag, and not what this refuses. */
export function stationTaken(ecs: State, sectionId: number, s: number, exceptId: number): boolean {
    const want = Math.fround(s);
    for (const row of sectionForces(ecs, sectionId))
        if (row.id !== exceptId && Math.fround(row.s) === want) return true;
    return false;
}

/** write a force point's `s`/`g` (live drag preview + gesture restore). the position
 *  writer only — easing/handles are untouched (a position drag leaves them).
 *
 *  A station another key in this section already holds is REFUSED ({@link stationTaken}): the key
 *  keeps its current `s` and the `g` write still lands, so a drag crossing a neighbour slides in g
 *  while s pauses on the occupied slot and resumes past it — the drag passes through naturally
 *  instead of stacking. The refusal is per-axis deliberately; refusing the whole write would
 *  freeze a diagonal drag against a neighbour it isn't trying to land on.
 *
 *  **This is the live-authoring writer only.** `restoreForcePoint`/`spawnForce` bypass it on
 *  purpose: a snapshot restore must be byte-identical, and a document that already holds a
 *  coincident pair (authored before this guard, or planted by a structural op) has to
 *  round-trip through undo unchanged rather than being silently repaired mid-history. */
export function setForcePoint(ecs: State, id: number, s: number, g: number): void {
    const eid = forceAt(ecs, id);
    if (eid === null) return;
    const lands = !stationTaken(ecs, Force.section.get(eid), s, id);
    if (lands) Force.s.set(eid, s);
    ForceBoundary.g.set(eid, g);
}

/** write a force point's full state back — position and easing tag (the gesture
 *  restore / undo path, symmetric with `forcePointState`). */
export function restoreForcePoint(ecs: State, st: ForcePointState): void {
    const eid = forceAt(ecs, st.id);
    if (eid === null) return;
    Force.s.set(eid, st.s);
    ForceBoundary.g.set(eid, st.g);
    ForceBoundary.ease.set(eid, st.ease);
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
    if (eid === null) return;
    if (ForceBoundary.ease.get(eid) === ease) return; // the tag it already carries: nothing written
    ForceBoundary.ease.set(eid, ease);
}

/** the next force keyframe after `id` in its own section (ascending s), or null when
 *  `id` is the section's last — the trailing bound of the segment a bulk Easing pick on
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
    const run = rebuildRunProjection(ecs).find((row) => row.segmentIds.includes(id));
    if (!run) return;
    const terminal = run.segmentIds[run.segmentIds.length - 1]!;
    const eid = sectionAt(ecs, terminal)!;
    const terminalIndex = run.segmentIds.length - 1;
    const prefix = run.stations[terminalIndex]!;
    const nextExtent = Math.max(minRunForceExtent(ecs, id), length);
    Section.length.set(eid, nextExtent - prefix);
    const first = sectionAt(ecs, run.segmentIds[0]!)!;
    Segment.runExtent.set(first, nextExtent);
}

// ── track initial speed (v0, S3: derived from the track-start one-shot) ─────────────

/** the track's derived entry speed (m/s): the track-start one-shot's own `value`
 *  ({@link entryOneShot}), or `V0` when none exists — the same fallback idiom as an
 *  emptied force profile falling to `DEFAULT_G` (`bakeEntryForce`). The old sparse
 *  per-track speed field is retired (S5); this is its replacement. S3 retired the S5-era
 *  "value of the strip covering station 0" reading (a real span OR a degenerate `[0, 0)`
 *  point strip) — the one-shot is a structurally distinct kind now (Locked decision,
 *  finding 6), never a `Strip` row, so there is no keyframe curve to sample here: a point
 *  event carries one scalar, not a curve. */
export function entrySpeed(ecs: State): number {
    const os = entryOneShot(ecs);
    return os ? os.value : V0;
}

/** author the track's initial speed by writing the track-start one-shot's `value` — moves
 *  its existing value when one already exists ({@link entryOneShot}), or authors a new
 *  one-shot at `value` (floored at `MIN_V0`) when none does — `seed`'s own shape, or this
 *  helper's own prior call, or a real pointer delete having removed it. Callers: test/lab
 *  setup, the `__kex` dev hook; the ordinary authoring path is `seed`'s own creation
 *  (a real, undo-recorded `history.addOneShot`/`deleteOneShot` reach the same writers this
 *  does — this function is the direct-write, no-undo-entry twin, like `setSectionLength`
 *  is to a trim gesture). No march side effect: the one-shot carries no `Strip` row, so
 *  `stripOverride`/`edgeStrips` never see it — it feeds only {@link entrySpeed}'s own
 *  `v0` into `startEntry` (the bake's own march seed). */
export function setStartSpeed(ecs: State, v: number): void {
    const clamped = Math.max(MIN_V0, v);
    const os = entryOneShot(ecs);
    if (os) {
        OneShot.value.set(os.eid, clamped);
        return;
    }
    createOneShot(ecs, clamped);
}

// ── friction / drag ────────────────────────────────────────────────────────────

/** whether the track-global coefficients (friction/resistance) may be EDITED right now — the
 *  same per-subject rule `sectionEditable` (`acts.ts`) applies to every other non-subject edit
 *  surface, at its track-global sentinel (`acts.ts`'s `section: -1`, the same reading v0 is
 *  documented against): editable with no pin session open, never editable once one is (a
 *  track-global write has no "the pinning section" case to except). Reimplemented off
 *  `bakeFreeze` rather than importing `sectionEditable` — `acts.ts` sits above `track.ts`
 *  in the dependency graph. */
export function trackEditable(): boolean {
    return bakeFreeze === null;
}

/** the track's authored Coulomb friction coefficient, or 0 for an empty world — the kernel's
 *  own neutral default, never `DEFAULT_FRICTION` (that's a NEW-track authoring default, read
 *  only at `createTrack`). */
export function trackFriction(ecs: State): number {
    const t = trackEntity(ecs);
    return t === null ? 0 : Track.friction.get(t);
}

/** the track's authored quadratic-drag coefficient, or 0 for an empty world (`trackFriction`'s
 *  twin). */
export function trackResistance(ecs: State): number {
    const t = trackEntity(ecs);
    return t === null ? 0 : Track.resistance.get(t);
}

/** the track's undoable friction coefficient — the START handle's scrub/type gesture
 *  snapshots this. `undefined` when the track is gone or the in-mode lockdown is up
 *  (`trackEditable`) — the gesture-open guard `beginFriction` refuses to open on. */
export interface TrackFrictionState {
    friction: number;
}

export function trackFrictionState(trackEid: number): TrackFrictionState | undefined {
    if (!trackEditable()) return undefined;
    return { friction: Track.friction.get(trackEid) };
}

/** whether a typed coefficient is one the field may commit — finite and non-negative. the
 *  kernel itself carries no such guard (`forward.loss` takes `|fMag|` unvalidated), so this is
 *  purely the field's own refusal, shared by both coefficient fields'
 *  onchange handlers (`App.svelte`) rather than duplicated per field. */
export function validCoefficient(v: number): boolean {
    return Number.isFinite(v) && v >= 0;
}

/** set the track's friction coefficient — the field/scrub write + gesture restore. refuses
 *  (no-op) under the in-mode lockdown (`trackEditable`) — the write-side belt to
 *  `beginFriction`'s gesture-open suspenders. no floor: the kernel's own no-guard convention
 *  (`forward.loss` takes `|fMag|`, never validates its coefficients), so a negative/NaN
 *  refusal is `validCoefficient`'s job, checked by the field before this write is ever called,
 *  not this write. re-bakes on the next tick (friction is in the bake hash). */
export function setTrackFriction(trackEid: number, friction: number): void {
    if (!trackEditable()) return;
    Track.friction.set(trackEid, friction);
}

/** `TrackFrictionState`'s drag-coefficient twin. */
export interface TrackResistanceState {
    resistance: number;
}

export function trackResistanceState(trackEid: number): TrackResistanceState | undefined {
    if (!trackEditable()) return undefined;
    return { resistance: Track.resistance.get(trackEid) };
}

/** `setTrackFriction`'s drag-coefficient twin. */
export function setTrackResistance(trackEid: number, resistance: number): void {
    if (!trackEditable()) return;
    Track.resistance.set(trackEid, resistance);
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

/** one section's full undoable state: its identity/order, kind, force extent, its geo
 *  nodes, and its force points. a destructive convert (or a structural op) snapshots
 *  this before/after so undo is byte-identical. Carries no strips: strips are
 *  track-global and span-blind (Locked decision, S2) — a section's own convert/reset/
 *  structural op never touches them, so they are outside this snapshot's own identity. */
export interface SegmentSnapshot {
    id: number;
    order: number;
    kind: SectionKind;
    length: number;
    nodes: NodeState[];
    points: {
        id: number;
        s: number;
        g: number;
        ease: Easing;
    }[];
}

/** capture a section (both kinds' payloads — one is empty). a force point carries its
 *  easing tag, so a convert/structural-op undo restores it. */
export function snapshotSegment(ecs: State, sectionId: number): SegmentSnapshot {
    const eid = sectionAt(ecs, sectionId);
    if (eid === null) throw new Error(`snapshotSection: no section ${sectionId}`);
    return {
        id: sectionId,
        order: Section.order.get(eid),
        kind: Section.kind.get(eid) as SectionKind,
        length: Section.length.get(eid),
        nodes: nodeSnapshot(ecs, sectionId),
        points: sectionForces(ecs, sectionId).map((p) => ({
            id: p.id,
            s: p.s,
            g: p.g,
            ease: Force.ease.get(p.eid) as Easing,
        })),
    };
}

/** clear a section's payload and rebuild it verbatim from a snapshot — restores a
 *  convert (either direction) or a structural op byte-identical. the Section entity
 *  is assumed to exist (its order/kind/length are rewritten); nodes respawn by
 *  order, points by id, so eids recycle but identities don't. Strips are untouched
 *  (track-global, outside this snapshot's identity). */
export function restoreSegment(ecs: State, snap: SegmentSnapshot): void {
    const eid = sectionAt(ecs, snap.id);
    if (eid === null) throw new Error(`restoreSection: no section ${snap.id}`);
    for (const h of sectionHandles(ecs, snap.id)) ecs.destroy(h);
    for (const p of sectionForces(ecs, snap.id)) ecs.destroy(p.eid);
    Section.order.set(eid, snap.order);
    Section.kind.set(eid, snap.kind);
    Section.length.set(eid, snap.length);
    for (const n of snap.nodes) spawnNode(ecs, snap.id, n.order, n.x, n.y, n.theta, n.tangent);
    for (const p of snap.points) spawnForce(ecs, snap.id, p.id, p.s, p.g, p.ease);
}

/** ordered, run-local structural capture. It deliberately carries no track-global state. */
export interface RunSnapshot {
    id: number;
    members: SegmentSnapshot[];
}

/** capture the complete evaluator run containing `segmentId`, in canonical member order. */
export function snapshotRun(ecs: State, segmentId: number): RunSnapshot {
    const run = rebuildRunProjection(ecs).find((row) => row.segmentIds.includes(segmentId));
    if (!run) throw new Error(`snapshotRun: no segment ${segmentId}`);
    return { id: run.id, members: run.segmentIds.map((id) => snapshotSegment(ecs, id)) };
}

/** restore one run without replacing any surviving member entity. Missing members alone respawn. */
export function restoreRun(ecs: State, snap: RunSnapshot): void {
    for (const member of snap.members) {
        let eid = sectionAt(ecs, member.id);
        if (eid === null) {
            bumpOrders(ecs, member.order, 1);
            spawnSection(ecs, member.id, member.order, member.kind, member.length);
            eid = sectionAt(ecs, member.id)!;
        }
        Segment.run.set(eid, snap.id);
        restoreSegment(ecs, member);
    }
}

/** a run content token is the ordered concatenation of its members' content. */
export function runToken(ecs: State, segmentId: number): string {
    const snap = snapshotRun(ecs, segmentId);
    return snap.members
        .map((member) => {
            const row = sections(ecs).find((candidate) => candidate.id === member.id)!;
            return sectionContentHash(ecs, row);
        })
        .join("|");
}

/** @temporary S7 — legacy single-member compatibility names. */
export type SectionSnapshot = SegmentSnapshot;
/** @temporary S7 */
export const snapshotSection = snapshotSegment;
/** @temporary S7 */
export const restoreSection = restoreSegment;

// ── provenance sidecar (kex2d-provenance) ──────────────────────────────────────

/** one section's stamped provenance: `payload` is the pre-solve snapshot a same-session reverse
 *  convert restores verbatim (stage 2/3, not yet consulted here); `token` and `entry` are the two
 *  checks a later reverse-invoke certifies exactness against.
 *
 *  **The honest claim is "bake-identity is sufficient, not necessary" — never "nothing the bake
 *  reads has changed."** The token deliberately excludes the track-global `Track.ds`: a first
 *  section's entry anchor is ds-invariant (it's `START`, untouched by the nominal spacing), so a
 *  global ds change between the stamp and the reverse-invoke still passes both checks — benign,
 *  because the restore lands `payload`'s own pre-trip rows VERBATIM, and those rows don't depend
 *  on ds at all. An untouched section's live bake being bit-identical to the stamp is the
 *  sufficient case this unit was built for, but it isn't what certification actually tests; a
 *  benign ds change can pass too, and the restore is still authored-exact either way. Don't "fix"
 *  this by folding `Track.ds` into the token — that would only convert benign restores into fits
 *  (kex2d-provenance close-out). */
export interface Provenance {
    /** @temporary S6 compatibility payload for conversion façades. */
    payload: SegmentSnapshot;
    runPayload: RunSnapshot;
    token: string;
    entry: Entry;
}

/** module-level cache, keyed by stable section id — a droppable cache of previously authored
 *  state with a validity condition, not document truth. Deliberately NOT `bakeHash`/`authoredHash`
 *  (stamping must not invalidate the live bake or trip `StaleConvert`'s re-read), NOT
 *  `SectionSnapshot`/undo, NOT serialized: dropping it just degrades to today's always-fit
 *  behavior (locked decision, `specs/kex2d-provenance.md`). */
const provenance = new Map<number, Provenance>();

/** stamp a section's provenance at an invoked solve's landing. `payload` is the caller's own
 *  pre-solve `snapshotSection` (the same one `history.landSolve` already captures as the undo
 *  "before" — this is its second consumer, not a new capture); the token is computed over the
 *  LANDED (post-solve) section's own content (`sectionToken` — kind + length + rows, NOT
 *  `order`) and the entry is the section's own entry anchor at landing (`sectionInfo.entry`,
 *  f32-exact reproduction on an unchanged upstream). No-ops when the section hasn't baked yet
 *  (no `sectionInfo` entry to read an anchor from, or no live `Section` row) — there is nothing
 *  yet to certify a later reverse-invoke against. */
export function stampProvenance(ecs: State, sectionId: number, payload: SegmentSnapshot): void {
    const info = sectionInfo.get(sectionId);
    if (info === undefined) return;
    const row = sections(ecs).find((s) => s.id === sectionId);
    if (row === undefined) return;
    provenance.set(sectionId, {
        payload,
        runPayload: snapshotRun(ecs, sectionId),
        token: sectionToken(ecs, row),
        entry: { x: info.entry.x, y: info.entry.y, theta: info.entry.theta, v: info.entry.v },
    });
}

/** read a section's stamped provenance, or `undefined` if none was ever landed. A bare lookup —
 *  validity (token + entry match against the live state) is the reverse-invoke's own job
 *  (stage 2/3), not this read. */
export function readProvenance(sectionId: number): Provenance | undefined {
    return provenance.get(sectionId);
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

// ── the downstream freeze (kex2d-optimize-mode stage 7, the sandbox contract) ─────────
// while an pin mode is open, sections AFTER the pinning one hold their mode-entry
// placement: the bake splits into two chains, the second seeded with the frozen entry (the
// pinning section's recovered exit at mode entry) instead of the live exit. downstream
// payloads can't change in-mode (the editing lockdown), so the frozen part re-bakes
// byte-identical every pass — no snapshot needed, just the entry. the seam between the two
// parts is a GAP, not an edge: the live exit and the frozen entry are two distinct samples
// (the visible residual, the drop-line's truth), and no section's range covers the edge
// between them, so the kind-color stroke never bridges it. module state like `stickyLen`
// (a mode is ephemeral editor state, not authored track state — it stays out of `bakeHash`);
// `freezeInvalid` forces one bake on any toggle, since the toggle itself changes how the
// bake is computed while the authored hash stands still.
let bakeFreeze: { section: number; entry: Entry } | null = null;
let freezeInvalid = false;

/** set (or clear, null) the downstream freeze — called by the pin mode's open/close
 *  (`editor.beginPin`/`endPin`), never by authoring code. */
export function setBakeFreeze(f: { section: number; entry: Entry } | null): void {
    bakeFreeze = f;
    freezeInvalid = true;
}

// ── the landing display override (kex2d-idioms stage 4) ──────────────────────────
// while a landed Solve's paced landing runs, the WHOLE display rides it: `forceDense`
// substitutes the landing's interpolated g for the landed section's keyframes — the one seam
// where keyframes become bake input — so the curve, the viewport geometry, the force markers,
// and the cart all glide with the chart's diamonds instead of snapping. the downstream freeze
// HOLDS through the window (the same two-part chain, seeded at the session's frozen entry): as
// the interpolated exit converges to the stamp the frozen gap closes continuously, and the
// end-of-window release is invisible up to the solve's converged residual. cosmetic only — the
// document landed atomically before this state exists. `setBakeFreeze`'s pattern: module-level
// editor-owned state outside `bakeHash`, invalidated via `freezeInvalid`; while the override is
// live the gate bakes EVERY frame, since the interpolant moves while the authored hash stands
// still.
export interface BakeLanding {
    /** the landed section — the only one whose keyframes read through `g`. */
    section: number;
    /** the downstream hold: the pin session's frozen entry, held until the override
     *  clears (the freeze the landing's mode close would otherwise have released). */
    entry: Entry;
    /** the display g for a keyframe id right now, or null where the landing doesn't cover it
     *  (or has expired) — consulted per bake, so each frame reads the live interpolant. */
    g: (id: number) => number | null;
}

let bakeLanding: BakeLanding | null = null;

/** whether a landing display override is live — `BakeSystem`'s per-frame gate bypass and
 *  `bakeLive`'s contamination consult both read it. */
function landingLive(): boolean {
    return bakeLanding !== null;
}

/** set (or clear, null) the landing display override — called by the paced landing's open/skip
 *  (`editor.beginLanding`/`skipLanding`), never by authoring code. clearing forces the one final
 *  bake that releases the hold onto the document's own values; a clear with no live override is
 *  a no-op (the skip paths call unconditionally). */
export function setBakeLanding(l: BakeLanding | null): void {
    if (l === null && bakeLanding === null) return;
    bakeLanding = l;
    freezeInvalid = true;
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

/** reset a section's payload to the FORCE default: both row kinds cleared, the two
 *  continuation keyframes seeded at the recovered entry force (a flat continuation over the
 *  default extent). the ONE body behind `convertSection`'s geo → force flip and
 *  `resetSection`'s force-held reset, so the two seeds can't drift apart. */
function resetToForce(ecs: State, eid: number, sectionId: number): void {
    // recover the entry force from the current bake before the reset — the seed continues
    // the incoming force, stamped at creation.
    const info = sectionInfo.get(sectionId);
    const gEntry = info ? bakeEntryForce(ecs, info.startSample) : DEFAULT_G;
    for (const h of sectionHandles(ecs, sectionId)) ecs.destroy(h);
    for (const p of sectionForces(ecs, sectionId)) ecs.destroy(p.eid);
    Section.kind.set(eid, SectionKind.Force);
    const extent = defaultForceExtent();
    Section.length.set(eid, extent); // reset to the default extent, not inherited
    seedForceKeyframes(ecs, sectionId, extent, gEntry);
}

/** reset a section's payload to the GEO default: both row kinds cleared, the flat two-node
 *  seed. `resetToForce`'s twin — one body behind `convertSection`'s force → geo flip and
 *  `resetSection`'s geo-held reset. */
function resetToGeo(ecs: State, eid: number, sectionId: number): void {
    for (const h of sectionHandles(ecs, sectionId)) ecs.destroy(h);
    for (const p of sectionForces(ecs, sectionId)) ecs.destroy(p.eid);
    Section.kind.set(eid, SectionKind.Geo);
    Section.length.set(eid, 0);
    addNode(ecs, sectionId, 0, 0);
    addNode(ecs, sectionId, EXTEND_DIST, 0);
}

/** destructively flip a section's kind to its opposite, resetting to that kind's
 *  default: geo → force clears the nodes and seeds the two continuation keyframes at
 *  the recovered entry force (a flat continuation over the default extent); force →
 *  geo clears the points for the flat two-node seed. undo (a `snapshotSection` pair)
 *  makes it safe, so there's no confirmation. does not itself record history —
 *  `history.convertSection` wraps it. */
export function convertSection(ecs: State, sectionId: number): void {
    const run = rebuildRunProjection(ecs).find((row) => row.segmentIds.includes(sectionId));
    if (!run) return;
    for (const id of run.segmentIds) {
        const eid = sectionAt(ecs, id)!;
        if (run.kind === SectionKind.Geo) resetToForce(ecs, eid, id);
        else resetToGeo(ecs, eid, id);
    }
}

/** destructively reset a section to its OWN kind's default — `convertSection`'s bodies with
 *  the kind held (the Reset idiom: the state a fresh author would get, one click, no confirm —
 *  byte-identical undo is the safety). a force section reseeds the two continuation keyframes
 *  at the bake-recovered entry force, so its enablement wants a live bake
 *  (`sectionResettable`, below); a geo section reads no bake at all. like `convertSection`, neither
 *  stamps nor consults the provenance sidecar. does not itself record history —
 *  `history.resetSection` wraps it. */
export function resetSection(ecs: State, sectionId: number): void {
    const run = rebuildRunProjection(ecs).find((row) => row.segmentIds.includes(sectionId));
    if (!run) return;
    for (const id of run.segmentIds) {
        const eid = sectionAt(ecs, id)!;
        if (run.kind === SectionKind.Geo) resetToGeo(ecs, eid, id);
        else resetToForce(ecs, eid, id);
    }
}

/** whether the section menu's Reset row may fire: exactly ONE section, and — force only — a
 *  bake that IS the authored state (`bakeLive`), since the force seed's entry force is
 *  recovered from it (a stale bake would stamp a force that isn't on screen). a geo reset
 *  reads no bake. `sectionSolvable`'s shape; the caller pairs it with
 *  `controls.sectionOpsAllowed` (the pin-mode consent boundary), like every
 *  section-structure row.
 *  pure — device-free, unit-tested. the row grays out otherwise (never hidden). */
export function sectionResettable(
    selected: number,
    kind: SectionKind | null,
    live: boolean,
): boolean {
    return selected === 1 && kind !== null && (kind === SectionKind.Geo || live);
}

/** the force→geo fit's own invoke ceiling (dense bake edges): the largest input the modal's
 *  designed budget can absorb, derived from the fit's own measured cost, never tuned
 *  (`coding.md` tolerance discipline).
 *
 *  The modal's own budget is the harness's completion wait (`harness/section.pw.ts`'s
 *  `timeout: 30_000` — the concrete number "tens of seconds" grounds to), read as **browser**
 *  wall time — the fit runs in a browser worker.
 *
 *  The fit's own cost is superlinear in edge count AND cliff-shaped near a profile's own
 *  feasibility limit (a profile that nearly stalls the cart makes the fit saturate toward one
 *  node per dense sample instead of converging — `main.ts`'s `seedForceStress` comment), so a
 *  clean power-law extrapolation from a couple of anchors isn't trustworthy near the boundary —
 *  the safe ceiling has to come from an already-measured point, not a fitted curve. `seedForceStress`
 *  IS that point: its own tuning notes record a 1200 m section (2400 edges at the track-nominal
 *  `DS_NOMINAL` = 0.5 m step) at ~1.9 s under bun, ~12 s in the browser worker (the ~7× ratio the
 *  same comment measures) — comfortably inside the 30 s budget (2.5× margin) — while the next size
 *  tried, 2000 m (4000 edges), "overshot the completion wait". The true boundary sits somewhere
 *  between those two, unmeasured; 2400 is the largest edge count this codebase has actually run
 *  and timed inside the modal's budget, so it's the ceiling — not extrapolated past what's known. */
export const MAX_FIT_EDGES = 2400;

/** whether an invoked solve is available on a section selection: exactly ONE section of the
 *  direction's own `target` kind, and a bake that IS the authored state. All three are the
 *  invoking command's own guards, which *throw* (`convertGeo`'s geo/live checks, `convertForce`'s
 *  force/live twin) — the solve reads the bake's entry frame, so a stale bake would hand it a
 *  shape that isn't on screen, and a set has no single subject to solve. `target` parameterizes
 *  the direction (`SectionKind.Geo` for "Convert to force", `SectionKind.Force` for "Convert to
 *  geo") rather than a second cloned predicate — the menu's ONE conversion row resolves its target
 *  from the section's kind and asks this once. `edges` is the force→geo direction's own density
 *  guard (`MAX_FIT_EDGES`, above) — the section's dense bake edge count (`endSample −
 *  startSample`, cheap to read off `sectionInfo`, no fit invoked to check); the geo→force
 *  direction's input is small authored nodes (already progress/cancel-designed), so `edges` is
 *  inert there — optional, defaulting to 0 so a geo→force call site never has to supply it. The
 *  row grays out otherwise (never hidden). Pure — device-free, unit-tested. */
export function sectionSolvable(
    selected: number,
    kind: SectionKind | null,
    live: boolean,
    target: SectionKind,
    edges = 0,
): boolean {
    return (
        selected === 1 &&
        kind === target &&
        live &&
        (target !== SectionKind.Force || edges <= MAX_FIT_EDGES)
    );
}

/** an invoked solve's authored output: the keyframes it emitted, and the extent they were
 *  solved for. the conversion tier's `ConvertResult` (`refine.ts`) satisfies this structurally,
 *  so the document layer reads a solve without depending on the solver — the invoked atoms stay
 *  off this module's graph.
 *
 *  **In meters of arclength**, like every other authored number here — solves run
 *  distance-internal and the store never varies by `Track.domain` (a display lens, `domain.ts`),
 *  so the landing needs no conversion. */
export interface SolvedForce {
    points: readonly { s: number; g: number }[];
    length: number;
}

/** land an invoked geo→force solve's output on its section — the conversion's whole document
 *  write. the shape nodes go, the kind flips, and the section takes the solve's REALIZED
 *  extent (the march that closes the exit the solve pinned — `refine.ts`), then its `{s, g}`
 *  keyframes spawn: every one default-Cubic with no handles, which is the narrow dialect the
 *  conversion emits by construction. nothing else of a solve persists — outcome/floor/deviation/
 *  probes are the caller's transient readout, never document state.
 *
 *  distinct from `convertSection`: that one is the destructive *reset* to the kind's default
 *  (the two continuation keyframes at the default extent); this one replaces the section with a
 *  solved shape-preserving profile. does not itself record history — `history.solveForce`
 *  wraps it. destroys a cleared strip's keyframes too (S5, red-first witnessed): every other
 *  section-payload clearer in this file (`resetToForce`/`resetToGeo`/`restoreSection`) already
 *  does, but this one left the keyframe entities orphaned (tagged with the destroyed strip's
 *  id, `stripAt` no longer resolving it) — invisible before a section-0 strip was routine, since
 *  `restoreSection`'s own undo respawn then created a SECOND keyframe sharing that id, sitting
 *  beside the still-live orphan. Strips are untouched (S2: track-global, span-blind — a
 *  section's own convert never reaches them, so the old S5 entry-speed-preservation wrapper
 *  this function used is retired: there is no strip to lose). */
export function applyConvert(ecs: State, sectionId: number, solved: SolvedForce): void {
    const run = rebuildRunProjection(ecs).find((row) => row.segmentIds.includes(sectionId));
    if (!run) throw new Error(`applyConvert: no section ${sectionId}`);
    setSectionLength(ecs, sectionId, solved.length);
    const members = run.segmentIds.map((id) => {
        const eid = sectionAt(ecs, id)!;
        for (const h of sectionHandles(ecs, id)) ecs.destroy(h);
        for (const p of sectionForces(ecs, id)) ecs.destroy(p.eid);
        Section.kind.set(eid, SectionKind.Force);
        return { id, length: Section.length.get(eid) };
    });
    let offset = 0;
    for (const member of members) {
        const end = offset + member.length;
        for (const point of solved.points) {
            if (point.s >= offset && (point.s < end || member === members[members.length - 1]))
                createForcePoint(ecs, member.id, point.s - offset, point.g);
        }
        offset = end;
    }
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
 *  exactly. every emitted node is Auto (no explicit tangent) — the locked output dialect. does
 *  not itself record history — `history.solveGeo` wraps it. */
export function applyConvertGeo(
    ecs: State,
    sectionId: number,
    solved: SolvedGeo,
    entry: Entry,
): void {
    const run = rebuildRunProjection(ecs).find((row) => row.segmentIds.includes(sectionId));
    if (!run) throw new Error(`applyConvertGeo: no section ${sectionId}`);
    for (const id of run.segmentIds) {
        const eid = sectionAt(ecs, id)!;
        for (const h of sectionHandles(ecs, id)) ecs.destroy(h);
        for (const p of sectionForces(ecs, id)) ecs.destroy(p.eid);
        Section.kind.set(eid, SectionKind.Geo);
        Section.length.set(eid, 0);
        if (id !== run.segmentIds[0]) {
            spawnNode(ecs, id, 0, 0, 0, 0);
            spawnNode(ecs, id, 1, EXTEND_DIST, 0, 0);
        }
    }
    const first = run.segmentIds[0]!;
    solved.nodes.forEach((n, i) => {
        if (i === 0) spawnNode(ecs, first, 0, 0, 0, 0);
        else {
            const local = localize(entry, n);
            spawnNode(ecs, first, i, local.x, local.y, local.theta);
        }
    });
}

// ── structural ops (append / split / delete) ──────────────────────────
// each mutates the section chain directly; `history` wraps it in a whole-track
// snapshot pair so undo is byte-identical. geo split re-expresses nodes rigidly
// in the boundary frame (`localize`, exact to f32 round-off); force
// split partitions + rebases points in meters of arclength (lossless).

/** shift every section at or past `threshold` order by `delta` — makes room to
 *  insert (delta +1) or closes a gap after a remove (delta −1). */
function bumpOrders(ecs: State, threshold: number, delta: number): void {
    for (const eid of ecs.query([Section])) {
        const o = Section.order.get(eid);
        if (o >= threshold) Section.order.set(eid, o + delta);
    }
}

/** the track-global strip layer of a whole-track snapshot — {@link snapshotAll}'s own
 *  strip half, kept separate from `SectionSnapshot` because strips carry no section
 *  ownership (S2, Locked decision). */
export interface StripSnapshot {
    id: number;
    start: number;
    end: number;
    value: number;
    keyframes: { id: number; s: number; v: number }[];
}

/** capture every track-global strip, keyframes included. */
function snapshotStrips(ecs: State): StripSnapshot[] {
    return allStrips(ecs).map((st) => ({
        id: st.id,
        start: st.start,
        end: st.end,
        value: st.value,
        keyframes: stripKeyframes(ecs, st.id).map((k) => ({ id: k.id, s: k.s, v: k.v })),
    }));
}

/** the track-start one-shot layer of a whole-track snapshot — {@link snapshotAll}'s own
 *  one-shot half, one row (or none) since at most one `OneShot` entity ever exists. */
export interface OneShotSnapshot {
    id: number;
    value: number;
}

/** capture the track's one-shot, or an empty array when none exists. */
function snapshotOneShot(ecs: State): OneShotSnapshot[] {
    const os = entryOneShot(ecs);
    return os ? [{ id: os.id, value: os.value }] : [];
}

/** the structural-op undo unit: every section (order/kind/length, nodes, points) plus
 *  every track-global strip plus the track-start one-shot — a snapshot pair round-trips
 *  byte-identical (respawns the stored f32 verbatim), which is what makes the ops safely
 *  reversible. */
export interface TrackSnapshot {
    segments: SegmentSnapshot[];
    strips: StripSnapshot[];
    oneShot: OneShotSnapshot[];
}

/** capture the whole track through the canonical segment surface. */
export function snapshotAll(ecs: State): TrackSnapshot {
    return {
        segments: segments(ecs).map((s) => snapshotSegment(ecs, s.id)),
        strips: snapshotStrips(ecs),
        oneShot: snapshotOneShot(ecs),
    };
}

/** clear the whole track and rebuild it from a snapshot (structural-op undo/redo). */
export function restoreAll(ecs: State, snap: TrackSnapshot): void {
    for (const e of [...ecs.query([Section])]) ecs.destroy(e);
    for (const e of [...ecs.query([Handle])]) ecs.destroy(e);
    for (const e of [...ecs.query([Force])]) ecs.destroy(e);
    for (const e of [...ecs.query([Strip])]) ecs.destroy(e);
    for (const e of [...ecs.query([StripKeyframe])]) ecs.destroy(e);
    for (const e of [...ecs.query([OneShot])]) ecs.destroy(e);
    for (const s of snap.segments) {
        spawnSection(ecs, s.id, s.order, s.kind, s.length);
        for (const n of s.nodes) spawnNode(ecs, s.id, n.order, n.x, n.y, n.theta, n.tangent);
        for (const p of s.points) spawnForce(ecs, s.id, p.id, p.s, p.g, p.ease);
    }
    for (const st of snap.strips) {
        spawnStrip(ecs, st.id, st.start, st.end, st.value);
        for (const k of st.keyframes) spawnStripKeyframe(ecs, st.id, k.id, k.s, k.v);
    }
    for (const os of snap.oneShot) spawnOneShot(ecs, os.id, os.value);
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

/** delete a section and its payload; downstream sections close the gap and rebase
 *  rigidly (their nodes are section-local, so the bake re-places them at the new
 *  upstream exit). refuses to remove the last remaining section. returns true when
 *  deleted. Strips are untouched (S2, Locked decision): they're track-global and
 *  span-blind, so deleting the section under a span leaves its stored rows in place —
 *  the next bake's in-pass window resolution drives whatever now occupies that global
 *  window. */
/** delete the complete evaluator run containing `segmentId`. */
export function deleteRun(ecs: State, segmentId: number): boolean {
    const run = rebuildRunProjection(ecs).find((row) => row.segmentIds.includes(segmentId));
    if (!run || run.segmentIds.length >= sections(ecs).length) return false;
    for (const id of [...run.segmentIds].reverse()) deleteSectionMember(ecs, id);
    return true;
}

function deleteSectionMember(ecs: State, sectionId: number): boolean {
    const secEid = sectionAt(ecs, sectionId);
    if (secEid === null) return false;
    if (sections(ecs).length <= 1) return false; // keep at least one section
    const order = Section.order.get(secEid);
    for (const h of sectionHandles(ecs, sectionId)) ecs.destroy(h);
    for (const p of sectionForces(ecs, sectionId)) ecs.destroy(p.eid);
    ecs.destroy(secEid);
    provenance.delete(sectionId);
    bumpOrders(ecs, order + 1, -1);
    return true;
}

export function deleteSection(ecs: State, sectionId: number): boolean {
    return deleteRun(ecs, sectionId);
}

function seed(ecs: State): void {
    const trackEid = createTrack(ecs);
    // a genuinely NEW authored track gets the physically-grounded nonzero coefficients —
    // `createTrack` itself stays at the kernel's neutral
    // 0 (every test's own fixture), so this is the one place the authoring default applies.
    Track.friction.set(trackEid, DEFAULT_FRICTION);
    Track.resistance.set(trackEid, DEFAULT_RESISTANCE);
    // one geo section: node 0 at the local origin (the fixed start anchor) + a flat
    // extension-length shape node. the whole track launches level from `START`.
    const id = createSection(ecs, 0, SectionKind.Geo, 0);
    addNode(ecs, id, 0, 0);
    addNode(ecs, id, EXTEND_DIST, 0);
    // the initial velocity IS the track-start one-shot (S3, Locked decision — a
    // structurally distinct point kind, never a span): deleting it falls the derived
    // entry speed back to `V0` (`entrySpeed`'s own fallback), so this authors the same
    // starting value the retired per-track speed field used to default to, just as a
    // selectable, deletable point.
    createOneShot(ecs, V0);
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
 *  bakes at. the substrate places them rigidly at the running chain entry. Strips are
 *  track-global (S2, Locked decision) — every strip converts to section-local by
 *  subtracting `offset` (the section's own track-global entry, `sectionWindows`) and
 *  threads through the section's OWN chord array (`geoChordDs`, the same sampling
 *  `evalGeo` will redo internally — chord length is entry-invariant, so the redundant
 *  pass agrees exactly) into edge-index form (`edgeStrips`); a strip wholly outside this
 *  section's window collapses to an inert `{0,0}` spec or is dropped past the extent
 *  (`edgeStrips`'s own boundary clamp), so passing every strip to every section is
 *  correct, not just convenient. */
function geoPayload(ecs: State, sectionId: number, ds: number, offset: number): SectionSpec {
    const strips = allStrips(ecs);
    let edgeSpecs: StripSpec[] | undefined;
    if (strips.length > 0) {
        const { ds: chordDs, edges } = geoChordDs(ecs, sectionId, ds);
        edgeSpecs = edgeStrips(
            chordDs,
            edges,
            strips.map((st) => ({
                start: st.start - offset,
                end: st.end - offset,
                value: st.value,
                keyframes: stripKeyframes(ecs, st.id).map((k) => ({ s: k.s - offset, v: k.v })),
            })),
        );
    }
    return {
        kind: "geo",
        nodes: geoNodes(ecs, sectionId),
        ds,
        strips: edgeSpecs,
    };
}

/** Materialize an evaluator run's held edge values without changing its sampled profile.
 * The returned copy makes the payload boundary explicit: an empty run holds `DEFAULT_G`, while
 * an interior-only profile owns its own first/last values instead of borrowing across a run. */
export function materializeRunForceClamps(
    points: readonly ForcePoint[],
    runLength: number,
): ForcePoint[] {
    const clamped = points.slice();
    const startG = sampleForce(points, 0);
    const endG = sampleForce(points, runLength);
    if (clamped.length === 0 || clamped[0].s > 0)
        clamped.unshift({ s: 0, g: startG, ease: Easing.Linear });
    if (clamped.length === 1 || clamped[clamped.length - 1].s < runLength)
        clamped.push({ s: runLength, g: endG, ease: Easing.Linear });
    return clamped;
}

/** a force section's authored points gathered into the dense per-edge F_n(σ) profile over its
 *  extent — the one place a section's keyframes become the substrate's input. Takes the
 *  RESOLVED {@link Step} (its own callers, `forcePayload`/`forceBake`, each conform through
 *  {@link resolveStep} before calling here) — `forceProfile` requires the pair as one value, so
 *  this is a consumer of an already-conformed step, never a second pairing of its own. */
export function forceDense(
    ecs: State,
    segmentIds: readonly number[],
    stations: readonly number[],
    runLength: number,
    step: Step,
): Float32Array {
    const points: ForcePoint[] = [];
    for (let i = 0; i < segmentIds.length; i++) {
        const segmentId = segmentIds[i];
        const offset = stations[i]!;
        const land =
            bakeLanding !== null && bakeLanding.section === segmentId ? bakeLanding.g : null;
        for (const p of sectionForces(ecs, segmentId)) {
            points.push({
                s: offset + p.s,
                g: land?.(p.id) ?? p.g,
                ease: ForceBoundary.ease.get(p.eid) as Easing,
            });
        }
    }
    // The run is the old evaluator payload boundary. Materialize its two clamps so
    // a keyless run holds DEFAULT_G and interior-only keys cannot borrow a value
    // from an adjacent run. Exact splits inside the run remain invisible.
    return forceProfile(materializeRunForceClamps(points, runLength), step);
}

/** a force section's payload: its dense profile + the step it bakes at (its own or the
 *  nominal), which sets both the edge count and the integrator's march. `step` conforms
 *  through {@link resolveStep} before either the profile or the payload's own `Step` sees
 *  it, so `forceDense`'s σ grid and `evalForce`'s march (which reads this payload's `step`
 *  in `chain`) always agree on the same exact pair — the pairing seam, applied once, here. */
function forcePayload(
    ecs: State,
    segmentIds: readonly number[],
    stations: readonly number[],
    length: number,
    step: number,
    offset: number,
): SectionSpec {
    const resolved = resolveStep(length, step);
    return {
        kind: "force",
        fN: forceDense(ecs, segmentIds, stations, length, resolved),
        step: resolved,
        strips: stripsForStep(ecs, offset, resolved),
    };
}

/** every track-global strip, resolved into the kernel's edge-index form ({@link edgeStrips})
 *  at a section's own RESOLVED {@link Step} — a force section's edges are uniform in its
 *  native axis, so the per-edge `ds` array is just `step.ds` repeated `step.edges` times,
 *  never a bake read. `offset` is the section's own track-global entry
 *  ({@link sectionWindows}), a PURE derivation from the live document, never a bake read
 *  (the pin invariant's own structural requirement) — so a strip converts to section-local
 *  by subtracting it. This is the ONE seam pin mode's override construction (`pin.ts`)
 *  shares with the live bake (`forcePayload`/`forceBake`): both call this with their own
 *  already-resolved `Step` and `offset`, so the strip data behind the pin invariant is read
 *  directly off ECS state. */
export function stripsForStep(ecs: State, offset: number, step: Step): StripSpec[] | undefined {
    const rows = allStrips(ecs);
    if (rows.length === 0) return undefined;
    const ds = new Float32Array(step.edges).fill(step.ds);
    return edgeStrips(
        ds,
        step.edges,
        rows.map((st) => ({
            start: st.start - offset,
            end: st.end - offset,
            value: st.value,
            keyframes: stripKeyframes(ecs, st.id).map((k) => ({ s: k.s - offset, v: k.v })),
        })),
    );
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
    const run = rebuildRunProjection(ecs).find((row) => row.segmentIds.includes(sectionId));
    if (!run) throw new Error(`forceBake: no section ${sectionId}`);
    const info = runInfo.get(run.id);
    if (!info) throw new Error(`forceBake: no bake for section ${sectionId}`);
    if (run.kind !== SectionKind.Force)
        throw new Error(`forceBake: section ${sectionId} is not force`);
    const length = run.length;
    const step = trackDs(ecs);
    // conform once (the pairing seam) so the dense profile's σ grid and evalForce's march
    // below agree on the same exact step, exactly what `forcePayload` does for the live bake.
    const resolved = resolveStep(length, step);
    const dense = forceDense(ecs, run.segmentIds, run.stations, length, resolved);
    const avail = Math.max(1, MAX_SAMPLES - 1 - info.startSample);
    // a truncated dense array no longer matches `resolved.edges`, so evalForce's own length
    // check would throw on the clipped prefix — thread a step whose `edges` matches what's
    // actually handed in, `resolved.ds` unchanged (the same per-edge step, fewer edges).
    const clipped = dense.length > avail ? dense.subarray(0, avail) : dense;
    const clippedStep: Step = { edges: clipped.length, ds: resolved.ds };
    // this section's own track-global entry offset, the same PURE (bake-read-free) reading
    // `forcePayload`'s own chain-bake caller uses — strips resolved at the FULL resolved
    // step, then clamped to the clipped edge count — a strip past the clipped prefix has no
    // track position, the same non-destructive-trim law `forceMarkers` already applies to a
    // keyframe past its section's baked span.
    const offset = sectionWindows(ecs).find((w) => w.id === run.id)?.offset ?? 0;
    const strips = stripsForStep(ecs, offset, resolved)?.map((s) => ({
        start: Math.min(s.start, clippedStep.edges),
        end: Math.min(s.end, clippedStep.edges),
        value: s.value,
    }));
    const r = evalForce(
        info.entry,
        clipped,
        clippedStep,
        trackFriction(ecs),
        trackResistance(ecs),
        strips,
    );
    return { x: r.posX, y: r.posY, fN: r.fN, ds: r.ds, edges: r.edges };
}

/** one section's OWN content — kind, and its authored payload (a geo section's node poses, a
 *  force section's extent + points). Deliberately excludes `order`: chain position isn't
 *  content, so a reorder (a split, a reindex) doesn't change it. Deliberately excludes
 *  strips too (S2): they're track-global, span-blind to any one section (Locked decision),
 *  so they fold into {@link bakeHash} once, track-wide (`stripsHash`), never per section.
 *  Factored out of `bakeHash`'s per-section loop so the bake gate and the provenance token
 *  (`sectionToken`, below) read this ONE reading of "has this section's own content
 *  changed" — `bakeHash` folds `order` back in itself, since a reorder still has to force a
 *  re-bake. */
function sectionContentHash(ecs: State, sec: SectionRow): string {
    let h = `${sec.kind}`;
    if (sec.kind === SectionKind.Force) {
        h += `:L${sec.length}`;
        for (const p of sectionForces(ecs, sec.id)) {
            h += `,${p.id}=${p.s}:${p.g}:${Force.ease.get(p.eid)}`;
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
    return h;
}

/** every track-global strip's own content, folded once (S2) rather than per section — a
 *  velocity control changes what the bake produces regardless of which section(s) it
 *  overlaps (`kex2d-map.md`'s Velocity strips), and a section-blind span may overlap none,
 *  one, or several, so keying it to any one section's hash would miss or duplicate an edit. */
function stripsHash(ecs: State): string {
    let h = "";
    for (const st of allStrips(ecs)) {
        h += `,V${st.id}=${st.start}:${st.end}:${st.value}`;
        for (const k of stripKeyframes(ecs, st.id)) {
            h += `;${k.id}=${k.s}:${k.v}`;
        }
    }
    return h;
}

/** the track-start one-shot's own content, folded once (S3) — it feeds `bake`'s `v0` seed
 *  directly (`entrySpeed`), not through any section or strip, so a value edit needs its own
 *  hash term or the bake's own gate never sees it move (`bakeHash`'s own miss condition). */
function oneShotHash(ecs: State): string {
    const os = entryOneShot(ecs);
    return os ? `,O${os.id}=${os.value}` : "";
}

/** input-state hash that gates the bake: the shared ds + coefficients, every section in
 *  order (its id/order/kind, and its authored payload — a geo section's node poses, a force
 *  section's extent + points), every track-global strip + strip keyframe once (`stripsHash`),
 *  then the track-start one-shot's own value (`oneShotHash`, S3). BakeSystem re-bakes on a
 *  miss (anything moved, added, removed, reordered, or a coefficient edited), skips
 *  otherwise. `friction`/`resistance` fold in unconditionally, NOT because every track is
 *  nonzero (`createTrack` itself stays at the kernel's neutral 0; only `seed`'s genuinely NEW
 *  documents get `DEFAULT_FRICTION`/`DEFAULT_RESISTANCE`, so a zero-coefficient track is
 *  still the common case, every test fixture included). `Track.domain` never folds in: it is
 *  a display lens over this same bake, never a second march, so flipping it must leave the
 *  hash — and therefore the bake — untouched. */
function bakeHash(ecs: State, trackEid: number, secs: SectionRow[]): string {
    let h = `ds${Track.ds.get(trackEid)}mu${Track.friction.get(trackEid)}c${Track.resistance.get(trackEid)}`;
    for (const sec of secs) {
        h += `|S${sec.id}:${sec.order}:${sectionContentHash(ecs, sec)}`;
    }
    h += stripsHash(ecs);
    h += oneShotHash(ecs);
    return h;
}

/** a section's content-hash TOKEN (kex2d-provenance): `sectionContentHash` alone —
 *  `Track.domain` is a display lens, never a second unit the store holds, so it plays no part
 *  in what "unchanged since the stamp" means. Deliberately excludes the track-global `Track.ds`
 *  too (`Provenance`'s doc has the why — a ds change is benign, not a certification gap). */
export function sectionToken(ecs: State, sec: SectionRow): string {
    return runToken(ecs, sec.id);
}

/** f32-exact entry-anchor equality — the provenance consult's other half (`sectionToken` is the
 *  content half), shared by `forcegeo.tryRestore`/`geoforce.tryRestore` so the four-field
 *  comparison has one home. `!==` on either side fails closed on NaN (self-inequal), which is the
 *  wanted behavior: an entry that failed to reproduce never certifies a restore. */
export function entryExact(a: Entry, b: Entry): boolean {
    return a.x === b.x && a.y === b.y && a.theta === b.theta && a.v === b.v;
}

/** the provenance consult's certification core (kex2d-provenance close-out) — the validity block
 *  `forcegeo.tryRestore`/`geoforce.tryRestore` each ran inline: `readProvenance` → the live section
 *  row → a fresh `sectionToken` compare → `entryExact` against the live entry, in ONE place. Each
 *  direction keeps only its own restore call + result shaping (building a `GeofitNode[]` vs a
 *  `ForcePoint[]` from the payload is direction-specific, so it stays with the caller). Returns the
 *  stamped payload only when both checks pass; a miss on either — no stamp, a since-edited section,
 *  a moved upstream — returns `undefined` and the caller falls through to the fit/solve. A future
 *  validity input lands here once, both directions. */
export function consultProvenance(
    ecs: State,
    sectionId: number,
    entry: Entry,
): SectionSnapshot | undefined {
    const prov = readProvenance(sectionId);
    if (!prov) return undefined;
    const row = sections(ecs).find((s) => s.id === sectionId);
    if (!row) return undefined;
    if (sectionToken(ecs, row) !== prov.token) return undefined;
    if (!entryExact(entry, prov.entry)) return undefined;
    return prov.payload;
}

/** the bake gate's input reading for the whole authored track, computed from the LIVE authored
 *  state instead of read off the last bake — so it is the honest answer between ticks too. an
 *  invoked tool holds it across its solve to notice the document moved underneath. */
export function authoredHash(ecs: State): string {
    const t = trackEntity(ecs);
    return t === null ? "" : bakeHash(ecs, t, sections(ecs));
}

/** whether the current bake IS the current authored state — the liveness anything reading
 *  `sectionInfo` as truth needs first. a bake that never ran, one invalidated since (the `""`
 *  sentinel), and one the two-node floor made `bake` early-return from all fail here, and each
 *  leaves `sectionInfo` describing a shape that is no longer on screen. a live landing override
 *  fails too: its bake carries the display interpolant yet is stamped with the AUTHORED hash,
 *  so without this consult the window would certify a contaminated bake as authored truth. */
export function bakeLive(ecs: State): boolean {
    if (landingLive()) return false;
    const t = trackEntity(ecs);
    if (t === null) return false;
    const out = bakeOut.get(t);
    return out !== undefined && out.hash === authoredHash(ecs);
}

type BakeOut = NonNullable<ReturnType<typeof bakeOut.get>>;

/** per-sample cumulative time plus the diagnostic feasibility flag. Arclength is the one
 *  march (`Track.domain` is a display lens, never a second march), so a sample's duration is
 *  always DERIVED from the distance march: `ds_i / v̄_i`, v̄ floored at `V_FLOOR` so
 *  energy-depleted regions take long-but-finite time rather than dividing by zero. This IS
 *  the `dToU`/`uToD` table's own source (`timeline.ts`) — the seam the Time-view ruler and
 *  readouts read through, and geo already projects through unchanged.
 *
 *  `feasible[i] = |v[i]| ≥ V_WARN` drives the red-track UX (warning threshold above the
 *  numerical floor). */
function computeTime(out: BakeOut, count: number): void {
    out.t[0] = 0;
    out.feasible[0] = Math.abs(out.v[0]) >= V_WARN ? 1 : 0;
    let firstBad = out.feasible[0] === 0 ? 0 : -1;
    for (let i = 0; i < count - 1; i++) {
        const vA = Math.max(Math.abs(out.v[i]), V_FLOOR);
        const vB = Math.max(Math.abs(out.v[i + 1]), V_FLOOR);
        const dt = out.ds[i] / (0.5 * (vA + vB));
        out.t[i + 1] = out.t[i] + dt;
        const f = Math.abs(out.v[i + 1]) >= V_WARN ? 1 : 0;
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
function bake(
    ecs: State,
    trackEid: number,
    s: Samples,
    out: BakeOut,
    segments: SectionRow[],
): void {
    const ds = Track.ds.get(trackEid);
    const v0 = entrySpeed(ecs);
    const start = startEntry(v0);
    const friction = Track.friction.get(trackEid);
    const resistance = Track.resistance.get(trackEid);

    // a geo section needs ≥2 nodes to bake; if any is short, keep the prior bake
    // rather than half-render the chain.
    for (const segment of segments) {
        if (segment.kind === SectionKind.Geo && sectionHandles(ecs, segment.id).length < 2) return;
    }

    const byId = new Map(segments.map((segment) => [segment.id, segment]));
    const runs = rebuildRunProjection(ecs).map((run) => ({
        ...run,
        kind: run.kind as SectionKind,
        segments: run.segmentIds.map((id) => byId.get(id)!),
    }));
    const windows: SectionWindow[] = [];
    let runOffset = 0;
    for (const run of runs) {
        const edge =
            run.kind === SectionKind.Force
                ? (() => {
                      const step = resolveStep(run.length, ds);
                      return {
                          ds: new Float32Array(step.edges).fill(step.ds),
                          edges: step.edges,
                      };
                  })()
                : sectionEdgeDs(ecs, run.segmentIds[0]);
        const runDs = edge?.ds ?? EMPTY_DS;
        const edges = edge?.edges ?? 0;
        let len = 0;
        for (let i = 0; i < edges; i++) len += runDs[i];
        windows.push({ id: run.id, offset: runOffset, ds: runDs, edges, len });
        runOffset += len;
    }
    const payloads = runs.map((run, i) =>
        run.kind === SectionKind.Geo
            ? geoPayload(ecs, run.segmentIds[0], ds, windows[i].offset)
            : forcePayload(ecs, run.segmentIds, run.stations, run.length, ds, windows[i].offset),
    );
    runInfo.clear();
    // the downstream freeze (stage 7): with a live freeze on a non-terminal section, the chain
    // runs in TWO parts — start..pinning live, downstream seeded at the FROZEN entry — so
    // downstream holds its mode-entry placement while the pinning exit wanders. one part
    // (today's whole-chain bake, byte-identical) everywhere else.
    // …and the landing HOLD (stage 4): a live landing keeps downstream seeded at the session's
    // frozen entry after the mode close released `bakeFreeze`, so the frozen gap closes
    // continuously with the interpolated exit instead of snapping at the close.
    const fz = bakeFreeze ?? bakeLanding;
    const fzIdx = fz === null ? -1 : runs.findIndex((run) => run.segmentIds.includes(fz.section));
    const split = fzIdx >= 0 && fzIdx < runs.length - 1 ? fzIdx + 1 : -1;

    // `chain` keeps counting edges past the sample budget (a force section's own extent/step can ask
    // for more than the flat SoA has left at its place in the chain, and those writes land past the
    // buffer end and are dropped), so its count is a would-be count. What the SoA HAS is the budget,
    // and publishing more than that hands every consumer — the arc↔time table, `forceCurve`,
    // `sectionSpans`, the cart — indices that were never written: they read `undefined` and NaN
    // propagates into the chart's own axis total, unmounting the timeline. So the count is the truth
    // of the buffer. A section placed entirely past the budget still carries a `sectionInfo` range
    // out there, which is what `domain.windowOf` rejects a conversion on.
    interface Part {
        at: number; // first section index this part bakes
        entry: Entry; // the part's seed (the live start, or the frozen downstream entry)
        c: ReturnType<typeof chain>;
        count: number;
        offset: number; // where the part's samples land in the merged SoA
    }
    const parts: Part[] = [];
    if (split < 0) {
        const c = chain(start, payloads, MAX_SAMPLES, friction, resistance);
        parts.push({ at: 0, entry: start, c, count: Math.min(c.count, MAX_SAMPLES), offset: 0 });
    } else if (fz !== null) {
        const cA = chain(start, payloads.slice(0, split), MAX_SAMPLES, friction, resistance);
        const countA = Math.min(cA.count, MAX_SAMPLES);
        parts.push({ at: 0, entry: start, c: cA, count: countA, offset: 0 });
        const budget = MAX_SAMPLES - countA;
        if (budget >= 2) {
            const cB = chain(fz.entry, payloads.slice(split), budget, friction, resistance);
            parts.push({
                at: split,
                entry: fz.entry,
                c: cB,
                count: Math.min(cB.count, budget),
                offset: countA,
            });
        } else {
            // downstream has no budget at all — reachable only on a track ALREADY past
            // MAX_SAMPLES (the truncation-degraded regime the unfrozen bake warns about).
            // publish empty past-buffer ranges rather than leaving PRIOR-bake info standing:
            // stale info lies, an empty range degrades honestly (consumers reject it like any
            // past-budget section). `fz.entry` is exact for the first downstream section and
            // the best available stand-in for later ones — nothing baked to say otherwise.
            for (let k = split; k < runs.length; k++) {
                const empty = {
                    entry: fz.entry,
                    startSample: countA,
                    endSample: countA,
                    bakedNodes: 0,
                };
                runInfo.set(runs[k].id, empty);
                for (const id of runs[k].segmentIds) sectionInfo.set(id, empty);
            }
        }
    }
    const count = parts.reduce((n, p) => n + p.count, 0);
    if (count < 2) return; // fully degenerate first section — keep the prior bake

    let truncatedAny = false;
    for (const p of parts) {
        for (let k = 0; k < p.c.results.length; k++) {
            const sk = p.at + k;
            const r = p.c.results[k];
            const range = p.c.ranges[k];
            const entry = k === 0 ? p.entry : p.c.exits[k - 1];
            const run = runs[sk];

            if (run.kind === SectionKind.Geo) {
                const hs = sectionHandles(ecs, run.segmentIds[0]);
                for (let n = 0; n < r.offsets.length; n++) {
                    Handle.sample.set(hs[n], range.start + r.offsets[n] + p.offset);
                }
            }
            const info = {
                entry,
                startSample: range.start + p.offset,
                endSample: range.end + p.offset,
                bakedNodes: r.offsets.length,
            };
            runInfo.set(run.id, info);
            for (const id of run.segmentIds) sectionInfo.set(id, info);
            if (r.truncated) truncatedAny = true;
        }
    }
    if (truncatedAny) {
        console.warn(
            `kex2d: track ${trackEid} hit MAX_SAMPLES=${MAX_SAMPLES}; trailing nodes dropped`,
        );
    }

    for (const p of parts) {
        s.posX.set(p.c.posX.subarray(0, p.count), p.offset);
        s.posY.set(p.c.posY.subarray(0, p.count), p.offset);
        s.theta.set(p.c.theta.subarray(0, p.count), p.offset);
        out.v.set(p.c.v.subarray(0, p.count), p.offset);
        out.fN.set(p.c.fN.subarray(0, Math.max(0, p.count - 1)), p.offset);
        out.ds.set(p.c.ds.subarray(0, Math.max(0, p.count - 1)), p.offset);
    }
    if (parts.length === 2) {
        // the SEAM between the parts is a gap, not an edge: zero length with the prior edge's
        // force held so the chart shows no invented spike. no section's range covers this edge
        // index, so the kind-color stroke never draws a bridge across the gap.
        const gi = parts[0].count - 1;
        out.ds[gi] = 0;
        out.fN[gi] = gi > 0 ? out.fN[gi - 1] : DEFAULT_G;
    }
    out.hash = bakeHash(ecs, trackEid, segments);
    Track.count.set(trackEid, count);
    computeTime(out, count);
}

export const BakeSystem: System = {
    update(ecs: State): void {
        for (const trackEid of ecs.query([Track])) {
            const s = samples.get(trackEid);
            const out = bakeOut.get(trackEid);
            if (!s || !out) continue;
            const secs = sections(ecs);
            if (secs.length === 0) continue;
            // a freeze toggle changes how the bake is COMPUTED while the authored hash stands
            // still (mode open/close is editor state, not authored state), so it forces one pass
            // through the gate. a live landing override moves the interpolant every frame with
            // the hash equally still, so it bypasses the gate for its whole window (the accepted
            // cost: one bake per frame for LANDING_MS, what a live drag pays per pointermove).
            if (!freezeInvalid && !landingLive() && bakeHash(ecs, trackEid, secs) === out.hash)
                continue;
            freezeInvalid = false;
            bake(ecs, trackEid, s, out, secs);
        }
    },
};

export const TrackPlugin: Plugin = {
    name: "Track",
    components: { Track, Section, Handle, Force, Strip, StripKeyframe },
    traits: {
        Track: {
            defaults: () => ({
                count: 0,
                ds: 0,
                domain: Domain.Distance,
                // absent-in-a-document restores the KERNEL default (0, `forward.ts`'s own
                // `friction`/`resistance` params), never `DEFAULT_FRICTION`/`DEFAULT_RESISTANCE`
                // (a NEW-track authoring default, `createTrack` only) — an old save with no
                // coefficients authored never changes shape.
                friction: 0,
                resistance: 0,
            }),
        },
        Section: { defaults: () => ({ id: 0, order: 0, kind: 0, length: 0 }) },
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
        Strip: {
            defaults: () => ({ section: 0, id: 0, start: 0, end: 0, value: 0 }),
        },
        StripKeyframe: {
            defaults: () => ({ strip: 0, id: 0, s: 0, v: 0 }),
        },
    },
    initialize(ecs) {
        seed(ecs);
    },
    systems: [BakeSystem],
};

/** Canonical structural writer surface; section names remain temporary compatibility aliases. */
export const createSegment = createSection;
export const appendSegment = appendSection;
export const deleteSegment = deleteSection;
export const setSegmentExtent = setSectionLength;
