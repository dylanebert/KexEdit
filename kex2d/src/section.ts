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
import { integrate, step } from "./forward";
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

/** the unit a force section's section-local coordinate is authored in: **distance**
 *  (keyframes at arclength s, extent in meters) or **time** (keyframes at time t,
 *  extent in seconds; the swept geometry is emergent). the domain is a *step rule*
 *  on the atom (`evalForce`), never a rework — everything downstream (chain, force
 *  recovery, the flat SoA) already consumes per-edge variable `ds`, so no other code
 *  learns about time. it is one TRACK-GLOBAL fact, stored on `Track.domain` (the ECS
 *  layer) and converted at one seam (`domain.convertDomain`); `Distance` is the
 *  default so every existing caller and track stays byte-identical. */
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
}

/** a section's authored payload. geo carries local nodes (node 0 at the local
 *  origin, heading 0) + nominal spacing (m); force carries a per-edge F_n
 *  profile (g) + its edge step in its `domain`'s own unit (m for `Distance`, s
 *  for `Time`). */
export type Section =
    | { kind: "geo"; nodes: readonly Node[]; ds: number }
    | { kind: "force"; fN: ArrayLike<number>; ds: number; domain?: Domain };

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
 * with `valid`/`truncated` set (mirrors `sampleChain`).
 */
export function evalGeo(
    entry: Entry,
    nodes: readonly Node[],
    dsNominal: number,
    maxSamples = MAX,
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
    forces(posX, posY, theta, v, fN, dsArr, 0, edges, entry.v, entry.theta);
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
    };
}

/**
 * FORCE atom: seed sample 0 from `entry`, integrate the authored per-edge force
 * into the swept geometry, then RE-recover the display force from that geometry
 * (one display path). the recovered force overwrites the integrator's
 * `theta`/`v`, so the exit and the chart match a geo section's recovery exactly.
 *
 * `domain` is a step rule, not a rework: **Distance** (default, byte-identical
 * to the original path) steps `Δs = ds` and samples `fN` at the source
 * convention `σ_i = i·ds`, so every forward step advances exactly `ds` along
 * its mid-angle (the per-edge chord IS `ds`, the recovery's `dsArr`).
 * **Time** steps `Δt = ds` and samples `fN` at `t_i = i·Δt` (the same source
 * convention, time's twin); each edge advances `ds_i = v_i·Δt` along
 * arclength — a *variable* per-edge chord, read off the live integrator `v`
 * before it is overwritten by the recovery below (`forces` already accepts a
 * non-uniform `dsArr`, the geo path's own shape). A stalled `v_i` is EXACTLY 0
 * — the energy form is `sqrt(max(v², 0))`, and `V_FLOOR` floors only the dθ
 * denominator inside `step` — so `ds_i` is exactly 0 and the frozen cart is a
 * fixed point: samples pile on one place and the section's realized arclength
 * collapses. Accepted, no new clamp: the plateau is exact by design, which is
 * what lets `domain.ts` resolve it at one agreed slope in both directions.
 * A zero-length edge has no chord, so the recovery below resolves it as the
 * stationary cart it is — the previous chord angle carried across (a frozen
 * cart's orientation doesn't change) and `F_n = cos θ`, gravity's track-normal
 * term with no centripetal demand (`bake.forces`). The entry heading is passed
 * for the case where a whole section marches frozen and no chord exists at all.
 */
export function evalForce(
    entry: Entry,
    fN: ArrayLike<number>,
    ds: number,
    domain: Domain = Domain.Distance,
): SectionResult {
    const edges = fN.length;
    const n = edges + 1;
    const posX = new Float32Array(n);
    const posY = new Float32Array(n);
    const theta = new Float32Array(n);
    const v = new Float32Array(n);
    posX[0] = entry.x;
    posY[0] = entry.y;
    theta[0] = entry.theta;
    v[0] = entry.v;

    const dsArr = new Float32Array(edges);
    if (domain === Domain.Time) {
        for (let i = 0; i < edges; i++) {
            const dsi = v[i] * ds; // ds_i = v_i · Δt
            dsArr[i] = dsi;
            step(posX, posY, theta, v, i, i + 1, fN[i], dsi);
        }
    } else {
        integrate(posX, posY, theta, v, n, ds, (sigma) => fN[Math.round(sigma / ds)]);
        dsArr.fill(ds);
    }

    const outF = new Float32Array(edges);
    forces(posX, posY, theta, v, outF, dsArr, 0, edges, entry.v, entry.theta);
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
export function chain(entry0: Entry, sections: readonly Section[], maxSamples = MAX): ChainResult {
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
                ? evalGeo(entry, sec.nodes, sec.ds, maxSamples - off)
                : evalForce(entry, sec.fN, sec.ds, sec.domain);
        const start = off;
        // copy points 1..edges; point 0 duplicates the shared boundary already
        // written by the prior section (or the seed), so leave it — it carries the
        // prior section's exit state, which is exactly this section's placement.
        for (let k = 1; k <= r.edges; k++) {
            posX[off + k] = r.posX[k];
            posY[off + k] = r.posY[k];
            theta[off + k] = r.theta[k];
            v[off + k] = r.v[k];
        }
        for (let k = 0; k < r.edges; k++) {
            fN[off + k] = r.fN[k];
            ds[off + k] = r.ds[k];
        }
        off += r.edges;
        ranges.push({ start, end: off });
        exits.push(r.exit);
        results.push(r);
        entry = r.exit;
    }

    const count = Math.min(off + 1, maxSamples);
    return { posX, posY, theta, v, fN, ds, count, ranges, exits, results };
}
