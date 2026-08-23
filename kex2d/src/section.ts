/** the section substrate — the original KexEdit section contract, in 2D. every
 *  section takes an ENTRY anchor (a full
 *  state point) and produces sampled points; its last point IS the next
 *  section's entry (`chain` propagates it). two atomic, legible idioms:
 *
 *    - GEO (`evalGeo`): geometry → force. section-local node positions placed
 *      rigidly at the entry frame, sampled to a Hermite curve, then the
 *      physical force recovered from the geometry.
 *    - FORCE (`evalForce`): force → geometry. an authored F_n(s) integrated from
 *      the entry, then the DISPLAY force RE-recovered from the swept geometry.
 *
 *  design law: the force curve is ALWAYS geometry-recovered, even for a force
 *  section (mirrors the original `nodes/force.rs` — integrate from targets, then
 *  store the `Curvature::from_frames`-recovered force). So both atoms end with the
 *  same `forces` recovery: one display path regardless of kind. The recovered
 *  force sits O(ds) off an authored input — the known source-vs-centered
 *  convention gap (`fvd.lab.ts` panel 3), not a bug.
 *
 *  pure and framework-free (mirrors spline.ts / forward.ts / bake.ts); only the
 *  ECS layer (track.ts) imports the shallot barrel. f32 throughout — these atoms
 *  ARE the realized-track display path, so they use the display recovery
 *  (`bake.forces`), not the f64 solver atoms (`force.ts`). */

import { forces } from "./bake";
import { G, integrate, V_FLOOR } from "./forward";
import type { Step } from "./profile";
import { type Node, sampleChain, type Tangent } from "./spline";

/** default sample-buffer ceiling — mirrors `track.MAX_SAMPLES`. */
const MAX = 4096;

/** whether a section is authored as GEOMETRY (drag nodes in the viewport, recover
 *  the force) or FORCE (place points on the force curve, integrate the geometry) —
 *  the two atomic idioms of the section substrate.
 *  a track is a chain of sections, each with its own kind. the ECS layer stores it
 *  on `Section.kind` as its numeric value and re-exports this enum, so a pure
 *  consumer names a kind without reaching the ECS module's graph. */
export enum SectionKind {
    Geo = 0,
    Force = 1,
}

/** the unit the ruler, readouts, and Time-view gestures DISPLAY a force section's
 *  keyframes and extent in — every keyframe, extent, strip and strip keyframe is
 *  stored in meters of arclength always (`Track.domain` is a view, not a document
 *  conversion). `Distance` shows the stored meters verbatim; `Time` reads seconds
 *  off the live bake's s↔t table (`domain.ts`/`timeline.ts`), the same seam geo
 *  nodes already project through. Stored on `Track.domain` (the ECS layer). */
export enum Domain {
    Distance = 0,
    Time = 1,
}

/** a full track state point: the anchor a section starts from and the exit it
 *  produces (its last sample). `v` is speed (m/s); the force recovery derives
 *  energy from it. */
export interface Entry {
    x: number;
    y: number;
    theta: number;
    v: number;
}

/** one section's realized output: the sampled geometry, the geometry-recovered
 *  display force per edge, and the exit state (the last point — the next
 *  section's entry). self-contained; `chain` concatenates these into the flat
 *  per-track SoA. point arrays are length `edges + 1`; per-edge arrays `edges`. */
export interface SectionResult {
    posX: Float32Array;
    posY: Float32Array;
    theta: Float32Array;
    v: Float32Array;
    fN: Float32Array;
    ds: Float32Array;
    edges: number;
    exit: Entry;
    /** section-local sample index of each authored control point — the node→sample
     *  map the ECS layer syncs onto `Handle.sample` (geo: node landings from
     *  `sampleChain`, so a degenerate/truncated chain returns only the baked prefix;
     *  force: the two boundary anchors `[0, edges]`, no interior point lands on a
     *  sample — force points are authored on the s-axis, not in space). */
    offsets: number[];
    /** geo only: every segment landed (no degenerate/truncated). force is always valid. */
    valid: boolean;
    truncated: boolean;
    /** the recovery's sqrt-clamp energy injection, accumulated over the section
     *  (`bake.forces`'s return, v² units) — 0 on a non-stalling march, the pin
     *  consequence's own measurement (`kex2d-map.md`). */
    injection: number;
}

/** an authored velocity control's stored payload — section-local edge-index
 *  coordinates, the SAME indexing `fN`/`ds` already carry (`edges` wide,
 *  0-based). overrides the recovery's v² for every edge in the half-open
 *  `[start, end)` to the constant `value` (m/s, `Entry.v`'s own unit — the
 *  kernel squares it once, at the override site, so the number stored here
 *  is the same one a person reads off the channel). A **point** is the
 *  degenerate `start === end` case: an empty range holds no edge, so it
 *  overrides the SINGLE edge landing on that station instead —
 *  `[start − 1, start)`, "a point at station k overrides exactly edge
 *  (k−1→k)'s result" (`kex2d-map.md`'s "Velocity strips" locked decision).
 *  DOF-independent: `start`/`end`/`value` are stored constants in the
 *  section's own domain coordinate, never a function of the live march
 *  (`kex2d-map.md`'s authored-control exception, the invariant strips
 *  ground). T2 generalizes the constant to a per-edge curve: when `values`
 *  is present it carries pre-evaluated v² (one per edge in `[lo, end)`,
 *  indexed `k − lo`), evaluated from the strip's keyframes on the force-curve
 *  machinery (`profile.sampleForce`). When `values` is absent (no keyframes)
 *  the constant `value` is used — the After Effects stopwatch reading (no
 *  keyframes means one constant across the span). */
export interface Strip {
    start: number;
    end: number;
    value: number;
    /** per-edge v², indexed `[0, end − lo)`. When present, overrides the
     *  constant `value` for each edge in the strip's range. Pre-evaluated
     *  from the strip's keyframes at spec-build time (`edgeStrips`), so the
     *  per-edge closure is a lookup, not a curve evaluation. */
    values?: Float32Array;
}

/** build the per-edge v² override `forward.step`/`forward.integrate`/
 *  `bake.forces` already accept from a section's strips — pure, ignoring
 *  `natural` (prescription beats dissipation: inside a controlled span the
 *  actuator absorbs the losses, `kex2d-map.md`'s path-energy law). Returns
 *  `undefined` when there are no strips, so an unauthored section threads
 *  no override at all (byte-identical to before strips existed). Same-type
 *  strips never claim the same edge by construction — the write op's own
 *  guard (`track.stripOverlapped`, C3/C5) is tested at THIS function's own
 *  edge convention, not station space, so two authored strips can never
 *  both match a given `k` here; this reads the first match, defensive only
 *  — a well-formed authored track never exercises the fallthrough. */
export function stripOverride(
    strips: readonly Strip[] | undefined,
): ((k: number, natural: number) => number | undefined) | undefined {
    if (!strips || strips.length === 0) return undefined;
    return (k: number) => {
        for (const s of strips) {
            const lo = s.start === s.end ? s.start - 1 : s.start;
            if (k >= lo && k < s.end) {
                if (s.values) return s.values[k - lo];
                return s.value * s.value;
            }
        }
        return undefined;
    };
}

/** a section's authored payload. geo carries local nodes (node 0 at the local
 *  origin, heading 0) + nominal spacing (m); force carries a per-edge F_n
 *  profile (g) + its edge step, always meters of arclength. both kinds carry an
 *  optional `strips` — the velocity-control channel (above), threaded to the
 *  recovery (and, for force, the march too) regardless of which authoring
 *  idiom produced the geometry. */
export type Section =
    | { kind: "geo"; nodes: readonly Node[]; ds: number; strips?: readonly Strip[] }
    | {
          kind: "force";
          fN: ArrayLike<number>;
          step: Step;
          strips?: readonly Strip[];
      };

/** rotate a tangent's in/out vectors by the rotation `(c, s) = (cos φ, sin φ)`.
 *  an explicit tangent is stored in the node's local frame, so re-expressing the node
 *  into another frame rotates its vectors with that frame; translation leaves a vector
 *  fixed. this keeps position, heading, and tangent consistent under the transform —
 *  but whether the *curve* is preserved depends on the caller feeding the right frame
 *  (the bake's recovered boundary heading; see `track.headExit`). */
function rotateTangent(t: Tangent, c: number, s: number): Tangent {
    return {
        mode: t.mode,
        inX: c * t.inX - s * t.inY,
        inY: s * t.inX + c * t.inY,
        outX: c * t.outX - s * t.outY,
        outY: s * t.outX + c * t.outY,
    };
}

/** place a section-local node in world space at the entry frame: rotate by the
 *  entry heading, translate to the entry position (rigid placement). node 0
 *  (local origin, local heading 0) maps to the entry exactly, so the section
 *  joins at the anchor with the same position and heading (C1). an explicit
 *  tangent rotates with the frame (it's stored in the node's local frame). */
export function place(entry: Entry, n: Node): Node {
    const c = Math.cos(entry.theta);
    const s = Math.sin(entry.theta);
    const out: Node = {
        x: entry.x + c * n.x - s * n.y,
        y: entry.y + s * n.x + c * n.y,
        theta: n.theta + entry.theta,
    };
    if (n.tangent) out.tangent = rotateTangent(n.tangent, c, s);
    return out;
}

/** express a world-frame point in a section's entry-local frame — the exact
 *  inverse of `place`. the ECS layer authors handles in world space, but a
 *  geo section's nodes are section-local (node 0 at the local origin, heading 0),
 *  so the bake localizes the world handles against the section entry before
 *  evaluating: `place(entry, localize(entry, p)) === p`. */
export function localize(
    entry: Entry,
    p: { x: number; y: number; theta: number; tangent?: Tangent },
): Node {
    const c = Math.cos(entry.theta);
    const s = Math.sin(entry.theta);
    const dx = p.x - entry.x;
    const dy = p.y - entry.y;
    const out: Node = {
        x: c * dx + s * dy,
        y: -s * dx + c * dy,
        theta: p.theta - entry.theta,
    };
    if (p.tangent) out.tangent = rotateTangent(p.tangent, c, -s); // inverse rotation (−φ)
    return out;
}

function exitOf(
    posX: Float32Array,
    posY: Float32Array,
    theta: Float32Array,
    v: Float32Array,
    edges: number,
): Entry {
    return { x: posX[edges], y: posY[edges], theta: theta[edges], v: v[edges] };
}

/**
 * GEO atom: place the local nodes rigidly at `entry`, sample the Hermite curve,
 * recover the physical force from the geometry (`v0 = entry.v`). the exit is the
 * recovered last-sample state. `maxSamples` caps the sampling (`chain` passes the
 * remaining buffer). a degenerate/truncated chain returns its partial prefix
 * with `valid`/`truncated` set (mirrors `sampleChain`). `friction`/`resistance`
 * (both defaulted 0, trailing — the substrate's positional-last convention)
 * thread to the recovery's dissipative loss (the additive-substrate law,
 * `kex2d-map.md`). `strips` (trailing, defaulted `undefined`) threads to the
 * SAME recovery via `stripOverride` — geo geometry never depends on v (no
 * march), so a strip only ever changes `v`/`fN` from its own edges onward,
 * never the sampled positions.
 */
export function evalGeo(
    entry: Entry,
    nodes: readonly Node[],
    dsNominal: number,
    maxSamples = MAX,
    friction = 0,
    resistance = 0,
    strips?: readonly Strip[],
): SectionResult {
    const world = nodes.map((n) => place(entry, n));
    const posX = new Float32Array(maxSamples);
    const posY = new Float32Array(maxSamples);
    const dsArr = new Float32Array(Math.max(1, maxSamples - 1));
    const r = sampleChain(world, dsNominal, posX, posY, dsArr, maxSamples);
    const edges = r.edges;
    const theta = new Float32Array(edges + 1);
    const v = new Float32Array(edges + 1);
    const fN = new Float32Array(edges);
    const injection = forces(
        posX,
        posY,
        theta,
        v,
        fN,
        dsArr,
        0,
        edges,
        entry.v,
        entry.theta,
        G,
        V_FLOOR,
        friction,
        resistance,
        stripOverride(strips),
    );
    return {
        posX: posX.slice(0, edges + 1),
        posY: posY.slice(0, edges + 1),
        theta,
        v,
        fN,
        ds: dsArr.slice(0, edges),
        edges,
        exit: exitOf(posX, posY, theta, v, edges),
        offsets: r.offsets,
        valid: r.valid,
        truncated: r.truncated,
        injection,
    };
}

/**
 * FORCE atom: seed sample 0 from `entry`, integrate the authored per-edge force
 * into the swept geometry, then RE-recover the display force from that geometry
 * (one display path). the recovered force overwrites the integrator's
 * `theta`/`v`, so the exit and the chart match a geo section's recovery exactly.
 *
 * `fN.length` must equal `step.edges` (thrown otherwise) — the pairing invariant
 * `resolveStep` produces and the caller must not have split.
 *
 * marches `Δs = step.ds`, sampling `fN` at the source convention `σ_i = i·ds`,
 * so every forward step advances exactly `ds` along its mid-angle (the per-edge
 * chord IS `ds`, the recovery's `dsArr`). Arclength is the section's one stored
 * axis — `Track.domain` is a display lens over the live bake's s↔t table
 * (`timeline.ts`/`domain.ts`), never a second march.
 *
 * `friction`/`resistance` (both defaulted 0, trailing) thread to BOTH the
 * march (`stepForward`/`integrate`) and the re-recovery (`forces`).
 *
 * `strips` (trailing, defaulted `undefined`) threads to BOTH the march and
 * the re-recovery too — via `stripOverride`, one closure per call so both
 * passes agree on the exact same edges. Overriding `v` during the march
 * matters beyond the recovery: `vSafe` (this integrator's own denominator,
 * `forward.step`) feeds the NEXT edge's curvature, so a strip changes the
 * swept geometry downstream of itself, same as an authored F_n would — a
 * brake or launch curve reshapes the track it authors, not just its speed
 * channel.
 */
export function evalForce(
    entry: Entry,
    fN: ArrayLike<number>,
    step: Step,
    friction = 0,
    resistance = 0,
    strips?: readonly Strip[],
): SectionResult {
    const { edges, ds } = step;
    if (fN.length !== edges) {
        throw new Error(`evalForce: fN.length (${fN.length}) does not match step.edges (${edges})`);
    }
    const n = edges + 1;
    const posX = new Float32Array(n);
    const posY = new Float32Array(n);
    const theta = new Float32Array(n);
    const v = new Float32Array(n);
    posX[0] = entry.x;
    posY[0] = entry.y;
    theta[0] = entry.theta;
    v[0] = entry.v;

    const override = stripOverride(strips);
    const dsArr = new Float32Array(edges);
    integrate(
        posX,
        posY,
        theta,
        v,
        n,
        ds,
        (sigma) => fN[Math.round(sigma / ds)],
        G,
        V_FLOOR,
        friction,
        resistance,
        override,
    );
    dsArr.fill(ds);

    const outF = new Float32Array(edges);
    const injection = forces(
        posX,
        posY,
        theta,
        v,
        outF,
        dsArr,
        0,
        edges,
        entry.v,
        entry.theta,
        G,
        V_FLOOR,
        friction,
        resistance,
        override,
    );
    return {
        posX,
        posY,
        theta,
        v,
        fN: outF,
        ds: dsArr,
        edges,
        exit: exitOf(posX, posY, theta, v, edges),
        offsets: [0, edges],
        valid: true,
        truncated: false,
        injection,
    };
}

/** the flat realized track: one SoA over every section's samples, plus the
 *  per-section index ranges and exits. `ranges[k].end` is the shared boundary
 *  sample (== `ranges[k+1].start`), so cumulative arclength is continuous across
 *  it. `exits[k]` is the entry to section `k + 1`. */
export interface ChainResult {
    posX: Float32Array;
    posY: Float32Array;
    theta: Float32Array;
    v: Float32Array;
    fN: Float32Array;
    ds: Float32Array;
    /** sample (point) count. */
    count: number;
    ranges: { start: number; end: number }[];
    exits: Entry[];
    /** each section's own result — carries the per-section metadata the flat SoA
     *  drops (`valid`/`truncated`/`offsets`). `results[k].offsets` is section-local;
     *  add `ranges[k].start` for the global sample index. */
    results: SectionResult[];
}

/**
 * evaluate a chain of sections from `entry0`: each section is placed at the prior
 * section's exit and its samples appended to the flat SoA, sharing the boundary
 * point (a section's last sample IS the next section's first — the original
 * `Section {start_index, end_index}` overlap). returns the flat buffers, the
 * per-section ranges, and the exits. an empty chain returns just the seed point.
 */
export function chain(
    entry0: Entry,
    sections: readonly Section[],
    maxSamples = MAX,
    friction = 0,
    resistance = 0,
): ChainResult {
    const posX = new Float32Array(maxSamples);
    const posY = new Float32Array(maxSamples);
    const theta = new Float32Array(maxSamples);
    const v = new Float32Array(maxSamples);
    const fN = new Float32Array(Math.max(1, maxSamples - 1));
    const ds = new Float32Array(Math.max(1, maxSamples - 1));
    const ranges: { start: number; end: number }[] = [];
    const exits: Entry[] = [];
    const results: SectionResult[] = [];

    // seed the very first sample (the initial entry point). every section then
    // reuses its start point as the prior section's shared boundary.
    posX[0] = entry0.x;
    posY[0] = entry0.y;
    theta[0] = entry0.theta;
    v[0] = entry0.v;

    let entry = entry0;
    let off = 0;
    for (const sec of sections) {
        const r =
            sec.kind === "geo"
                ? evalGeo(
                      entry,
                      sec.nodes,
                      sec.ds,
                      maxSamples - off,
                      friction,
                      resistance,
                      sec.strips,
                  )
                : evalForce(entry, sec.fN, sec.step, friction, resistance, sec.strips);
        const start = off;
        // bound the COPY at the flat buffers' remaining room. `evalGeo` already respects it —
        // it was handed `maxSamples - off` as its own budget, so `r.edges` never exceeds what's
        // left here — but `evalForce` has no budget parameter (its `fN`/`step` pair is already
        // dense and must match `step.edges` exactly, the pairing invariant this substrate closed
        // in stage 1), so a force section's realized `edges` can outrun the chain's remaining
        // room. Clipping the copy (never softening `evalForce`'s own strict length check into a
        // `min()`) is what keeps a force chain past `MAX_SAMPLES` truncating instead of writing
        // past the flat SoA's end — a typed-array write past its length is silently dropped, so
        // the old code advanced `off` by the FULL `r.edges` regardless, leaving `ranges`/`count`
        // describing samples that were never actually written.
        const budget = Math.max(0, maxSamples - 1 - off);
        const copy = Math.min(r.edges, budget);
        // copy points 1..copy; point 0 duplicates the shared boundary already
        // written by the prior section (or the seed), so leave it — it carries the
        // prior section's exit state, which is exactly this section's placement.
        for (let k = 1; k <= copy; k++) {
            posX[off + k] = r.posX[k];
            posY[off + k] = r.posY[k];
            theta[off + k] = r.theta[k];
            v[off + k] = r.v[k];
        }
        for (let k = 0; k < copy; k++) {
            fN[off + k] = r.fN[k];
            ds[off + k] = r.ds[k];
        }
        const clipped = copy < r.edges;
        // the clipped exit is the last sample actually copied — the section's own arrays are
        // still the full (unclipped) march, so read the cut point straight off them rather than
        // off `r.exit`, which describes edges this chain never wrote.
        const exit: Entry = clipped
            ? { x: r.posX[copy], y: r.posY[copy], theta: r.theta[copy], v: r.v[copy] }
            : r.exit;
        off += copy;
        ranges.push({ start, end: off });
        exits.push(exit);
        // a clipped result is re-sliced, never just re-stamped with a smaller `edges`: a
        // `{...r, edges: copy}` spread is the same split-value shape stage 1 closed, an edge
        // count disagreeing with the arrays travelling beside it.
        results.push(
            clipped
                ? {
                      ...r,
                      posX: r.posX.slice(0, copy + 1),
                      posY: r.posY.slice(0, copy + 1),
                      theta: r.theta.slice(0, copy + 1),
                      v: r.v.slice(0, copy + 1),
                      fN: r.fN.slice(0, copy),
                      ds: r.ds.slice(0, copy),
                      edges: copy,
                      exit,
                      offsets: r.offsets.filter((o) => o <= copy),
                      truncated: true,
                  }
                : r,
        );
        entry = exit;
    }

    const count = Math.min(off + 1, maxSamples);
    return { posX, posY, theta, v, fN, ds, count, ranges, exits, results };
}
