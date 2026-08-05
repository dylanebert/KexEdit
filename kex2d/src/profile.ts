/** the force-authoring primitive: authored force keyframes → a dense per-edge
 *  F_n(σ) profile the substrate integrates. the force analogue of `spline.ts`'s
 *  `sampleChain` — a pure, framework-free authoring layer the ECS bake feeds into
 *  `section.evalForce`. the atoms below stay opinion-free: they consume dense
 *  per-edge force and know nothing about keyframes, easing, or bezier handles.
 *
 *  every segment between two adjacent keyframes is a **cubic bezier in (s, g)**.
 *  presets and explicit handles meet at one handle-resolution seam (`segment`),
 *  exactly `spline.ts`'s `handle()` shape. a segment's two derived tangents come
 *  from **one** preset — the **leading** keyframe's easing tag governs the whole
 *  transition (the Blender F-curve convention: easing lives on the keyframe and
 *  shapes the following segment). an explicit stored handle overrides its own side
 *  (per-keyframe, per-side) verbatim. one sampling path evaluates both; "Custom"
 *  is derived provenance (a segment is custom iff a bounding side holds an explicit
 *  handle), never a branch flag.
 *
 *  the derived tangents are **flat** (horizontal in g) — an S-transition between
 *  held values, C1 at every keyframe by construction (both sides flat → g'(s)=0
 *  there). their length comes from the one influence table: Linear = 0 (the bezier
 *  degenerates to the chord, so g(s) is exactly linear), Cubic = 1/3 (s(t) is then
 *  linear in t, so g(s) is exactly smoothstep), Quintic = 7/15 (center slope 15/8,
 *  matched to the true quintic; slope grows as influence rises). Cubic is the
 *  default (FVD++/Planet Coaster transition feel).
 *
 *  the displayed curve is re-recovered from the swept geometry, so a keyframe sits
 *  O(ds) off these authored values — expected, not a bug (the one-display-path law). */

import { collinearVec } from "./spline";

/** a keyframe's easing tag — the convenient middle layer over the bezier
 *  substrate. each row maps to one derived-flat-tangent influence (the table
 *  below): the honest span of FVD++'s degree ladder collapsed to one axis. */
export enum Easing {
    Linear = 0,
    Cubic = 1,
    Quintic = 2,
}

/** derived-flat-tangent influence per easing tag: the fraction of the segment
 *  span each flat handle reaches along s. these are derived from the FVD++ ladder,
 *  not tuned values — LINEAR degenerates the bezier to the chord (exactly linear
 *  g(s)); CUBIC makes s(t) linear so g(s) is exactly smoothstep = x²(3−2x); QUINTIC
 *  = 7/15 matches the true quintic smootherstep (6x⁵−15x⁴+10x³): a flat-tangent
 *  cubic bezier's center slope is 1/(1−i), the quintic's is g'(½) = 15/8, so
 *  1/(1−i) = 15/8 → i = 7/15 (slope → ∞ as i → 1, so the family spans the ladder). */
const LINEAR_INFLUENCE = 0;
const CUBIC_INFLUENCE = 1 / 3;
const QUINTIC_INFLUENCE = 7 / 15;

function influence(ease: Easing): number {
    switch (ease) {
        case Easing.Linear:
            return LINEAR_INFLUENCE;
        case Easing.Quintic:
            return QUINTIC_INFLUENCE;
        default:
            return CUBIC_INFLUENCE;
    }
}

/** the derived flat-tangent offset for a keyframe `side`, given the segment's
 *  governing easing tag and its span — exactly what `segment()` computes for a
 *  side that holds no explicit stored handle, exposed for the UI's derived-ghost
 *  render and the no-jump handle-summon seed (the geo `autoTangent` analogue:
 *  `spline.ts`'s `handle()` exposed beside `sampleChain` for the same reason).
 *  the OUT side reaches forward (Δs ≥ 0) into the segment; IN reaches backward
 *  (Δs ≤ 0) — both flat (Δg = 0), the S-transition construction. */
export function autoTangent(ease: Easing, span: number, side: "in" | "out"): Offset {
    const reach = influence(ease) * span;
    return side === "out" ? { ds: reach, dg: 0 } : { ds: -reach, dg: 0 };
}

/** the offset to **materialize** a keyframe `side` with when stepping the segment
 *  between `a` (leading) and `b` (trailing) up to Custom — seeded from the segment's
 *  current derived shape so the curve never jumps. for a preset-eased segment this is
 *  exactly the derived flat tangent (`autoTangent`). the **Linear** case is special:
 *  its derived tangent is zero-length (the bezier degenerates to the chord), which draws
 *  ungrabbable handles, so a Linear segment seeds **chord-aligned at influence 1/3** —
 *  the handle points along the chord (Δg = chordSlope·Δs), reaching a third of the span.
 *  both control points then land on the chord, so the segment still draws the identical
 *  straight line, but the handles are grabbable. */
export function segmentSeed(a: ForcePoint, b: ForcePoint, side: "in" | "out"): Offset {
    const span = b.s - a.s;
    const ease = a.ease ?? Easing.Cubic;
    if (ease !== Easing.Linear) return autoTangent(ease, span, side);
    const slope = span > EPS ? (b.g - a.g) / span : 0;
    const reach = (side === "out" ? 1 : -1) * influence(Easing.Cubic) * span;
    return { ds: reach, dg: slope * reach };
}

/** an explicit bezier handle stored on a keyframe side, as a **(Δs, Δg) offset**
 *  from the keyframe — the summoned inner layer, mirroring geo's stored `Tangent`.
 *  the outgoing (`out`) handle reaches forward (Δs ≥ 0) into the following segment;
 *  the incoming (`in`) handle reaches backward (Δs ≤ 0) into the preceding one. an
 *  offset present on a side overrides that side's derived flat tangent verbatim. */
export interface Offset {
    ds: number;
    dg: number;
}

/** whether two handle offsets lie on one straight line through the keyframe — the
 *  geometric precondition for storing `TangentMode.Aligned` (angle mirrored, `Aligned ⟹
 *  collinear`). a missing side is vacuously aligned (a single-sided keyframe has nothing
 *  to diverge from). the `Offset`-shaped wrapper over `spline.collinearVec` — the bare,
 *  direction-agnostic test, with no sign clause: a force keyframe's `in`/`out` handles
 *  point AWAY from the key in opposite directions (`segment`: `p1s` forward, `p2s`
 *  backward), so an aligned pair is antiparallel by construction and a positive-dot
 *  requirement would invert this predicate (`kex2d-followups` Locked decision). */
export function collinear(a?: Offset, b?: Offset): boolean {
    if (!a || !b) return true;
    return collinearVec(a.ds, a.dg, b.ds, b.dg);
}

/** whether the segment between adjacent keyframes `a` and `b` is **Custom** — derived
 *  provenance, never a stored flag: the segment is custom iff a bounding side holds an
 *  explicit handle (`a.out` or `b.in`), since either one substitutes for the tag at the
 *  seam. Its complement is a NAMED segment, shaped by `a.ease`'s derived flat tangents
 *  alone. The flat conversion family reads this directly when asserting that every emitted
 *  segment is named; its g-only keys carry no explicit sides.
 *  The editor menu answers it separately over the ECS `ForceTangent` components, a different
 *  representation of the same law rather than a call into this.
 *
 * @example
 * const named = points.slice(0, -1).filter((p, k) => !custom(p, points[k + 1])).length;
 */
export function custom(a: ForcePoint, b: ForcePoint): boolean {
    return a.out !== undefined || b.in !== undefined;
}

/** a force keyframe: a demanded normal force `g` at arclength `s` (m). `ease`
 *  governs the *following* segment's derived flat tangents (default `Easing.Cubic`
 *  when absent — the "no stored state" convention). `in`/`out` are the summoned
 *  explicit handles; a present side substitutes its stored offset for the derived
 *  tangent at the seam, per-keyframe and per-side. */
export interface ForcePoint {
    s: number;
    g: number;
    ease?: Easing;
    in?: Offset;
    out?: Offset;
}

/** the force an empty profile holds — level 1g gravity, a flat straight track. */
export const DEFAULT_G = 1;

const EPS = 1e-12;

/** residual bound for the s(t) = target root solve, relative to the segment span.
 *  ~a few ULP of a double: the Linear-tag exactness error is |Δg|·(residual/span)
 *  = |Δg|·S_TOL_REL (see `solveT`), so at 1e-13 a Linear segment reproduces the
 *  analytic linear value to ~1e-13·|Δg|, far below the f32 display-recovery noise
 *  (~1e-7). derived from the exactness bound, not tuned to a test. */
const S_TOL_REL = 1e-13;
const MAX_ITERS = 60;

/** one bezier segment in (s, g): its four control points, resolved from the two
 *  bounding keyframes' tangents and clamped for x-monotonicity so g(s) stays a
 *  function. control point s-coords are non-decreasing (`s0 ≤ p1s ≤ p2s ≤ s1`), so
 *  s(t) is monotone on [0,1] and the root solve has a unique answer. */
interface Seg {
    s0: number;
    g0: number;
    p1s: number;
    p1g: number;
    p2s: number;
    p2g: number;
    s1: number;
    g1: number;
}

/** resolve + monotone-clamp the segment between keyframes `a` and `b`. the derived
 *  handles never trigger the clamp (forward, combined reach ≤ span for influence
 *  ≤ ½); explicit adversarial handles are clamped: each handle's forward s-reach
 *  is floored at 0 (a backward-pointing handle collapses onto its keyframe) and
 *  the pair scaled down proportionally if their combined reach would cross
 *  (Blender's `correct_bezpart`), the g-offset scaled by the same factor so the
 *  handle's slope is preserved. */
function segment(a: ForcePoint, b: ForcePoint): Seg {
    const span = b.s - a.s;
    // the leading keyframe's tag governs the whole segment: both derived flat
    // handles take `a.ease`'s influence via `autoTangent`. an explicit stored
    // handle on either side overrides its own side verbatim.
    const ease = a.ease ?? Easing.Cubic;
    const out = a.out ?? autoTangent(ease, span, "out");
    const inn = b.in ?? autoTangent(ease, span, "in");
    let p1s = a.s + out.ds;
    let p1g = a.g + out.dg;
    let p2s = b.s + inn.ds;
    let p2g = b.g + inn.dg;

    if (span > EPS) {
        // signed forward s-reach of each handle; a backward reach (< 0) clamps to 0.
        const raw1 = p1s - a.s;
        const raw2 = b.s - p2s;
        let d1 = Math.max(0, raw1);
        let d2 = Math.max(0, raw2);
        const sum = d1 + d2;
        const f = sum > span ? span / sum : 1;
        d1 *= f;
        d2 *= f;
        // scale each handle's g-offset by the same over-reach factor `f` so its slope
        // holds (Blender's correct_bezpart scales the whole vector). a *backward* reach
        // (raw < 0) is the only collapse — it flattens onto the key to kill the fold; a
        // *vertical* handle (raw ≈ 0, dg ≠ 0) is kept (its s-length is 0, so it never
        // over-reaches, and s'(t) ≥ 0 still holds — an infinite-slope departure, monotone).
        const sc1 = raw1 < -EPS ? 0 : f;
        const sc2 = raw2 < -EPS ? 0 : f;
        p1g = a.g + (p1g - a.g) * sc1;
        p2g = b.g + (p2g - b.g) * sc2;
        p1s = a.s + d1;
        p2s = b.s - d2;
    }

    return { s0: a.s, g0: a.g, p1s, p1g, p2s, p2g, s1: b.s, g1: b.g };
}

/** the four control points of the bezier segment between adjacent keyframes `a` and `b`,
 *  as absolute (s, g) points — the resolved-and-clamped shape the profile samples. exposed
 *  for the UI's easing-glyph render (drawing the row's real curve, so the icon can't drift
 *  from what the segment produces); `p1`/`p2` reflect explicit handles when present, else the
 *  leading tag's derived flat tangents. */
export function segmentControls(a: ForcePoint, b: ForcePoint): { s: number; g: number }[] {
    const seg = segment(a, b);
    return [
        { s: seg.s0, g: seg.g0 },
        { s: seg.p1s, g: seg.p1g },
        { s: seg.p2s, g: seg.p2g },
        { s: seg.s1, g: seg.g1 },
    ];
}

/** de Casteljau-subdivide the bezier segment between adjacent keyframes `a` and `b`
 *  at the arclength `target` (`a.s < target < b.s`) — the exact-cut primitive
 *  `splitForce` plants its boundary keyframe from. De Casteljau's split control
 *  points ARE the segment's own geometry, re-parented rather than re-derived, so the
 *  two resulting halves (a→mid, mid→b) trace exactly the original segment's curve,
 *  divided at `target`. Both `a`'s own `out` and `b`'s own `in` come back re-parented
 *  too — their old derived-from-`ease` sizing was scaled to the FULL span, invalid
 *  once the span splits — alongside the new midpoint's `in`/`out` half. Every
 *  returned offset is explicit: subdivision demotes the whole segment to Custom
 *  (`custom()`), the visible cost of exact mid-segment cutting. */
export function subdivide(
    a: ForcePoint,
    b: ForcePoint,
    target: number,
): { g: number; outA: Offset; inMid: Offset; outMid: Offset; inB: Offset } {
    const seg = segment(a, b);
    const t = solveT(seg, target, (target - a.s) / (b.s - a.s));
    const lerp = (x0: number, x1: number) => x0 + (x1 - x0) * t;

    // the standard cubic de Casteljau split at `t`: two rounds of control-point
    // lerps (P0..P3 → Q1..Q3 → R1..R2), the third round landing on the curve point
    // itself (M) — the left curve is [P0, Q1, R1, M], the right [M, R2, Q3, P3].
    const q1s = lerp(seg.s0, seg.p1s);
    const q1g = lerp(seg.g0, seg.p1g);
    const q2s = lerp(seg.p1s, seg.p2s);
    const q2g = lerp(seg.p1g, seg.p2g);
    const q3s = lerp(seg.p2s, seg.s1);
    const q3g = lerp(seg.p2g, seg.g1);
    const r1s = lerp(q1s, q2s);
    const r1g = lerp(q1g, q2g);
    const r2s = lerp(q2s, q3s);
    const r2g = lerp(q2g, q3g);
    const mS = lerp(r1s, r2s);
    const mG = lerp(r1g, r2g);

    return {
        g: mG,
        outA: { ds: q1s - seg.s0, dg: q1g - seg.g0 },
        inMid: { ds: r1s - mS, dg: r1g - mG },
        outMid: { ds: r2s - mS, dg: r2g - mG },
        inB: { ds: q3s - seg.s1, dg: q3g - seg.g1 },
    };
}

function bez(a0: number, a1: number, a2: number, a3: number, t: number): number {
    const u = 1 - t;
    return u * u * u * a0 + 3 * u * u * t * a1 + 3 * u * t * t * a2 + t * t * t * a3;
}

function bezDeriv(a0: number, a1: number, a2: number, a3: number, t: number): number {
    const u = 1 - t;
    return 3 * u * u * (a1 - a0) + 6 * u * t * (a2 - a1) + 3 * t * t * (a3 - a2);
}

/** the bezier parameter `t` where `s(t) = target`, on a monotone-s segment. a
 *  safeguarded Newton (bisection bracket, so a near-flat endpoint derivative can't
 *  diverge): monotone s means the root is unique and bracketed in [0, 1]. `guess`
 *  warm-starts the search — the dense march passes the previous sample's `t`, so
 *  successive ascending queries converge in a step or two (never from scratch). */
function solveT(seg: Seg, target: number, guess: number): number {
    const span = seg.s1 - seg.s0;
    const tol = Math.abs(span) * S_TOL_REL;
    let lo = 0;
    let hi = 1;
    let t = guess <= 0 ? 0 : guess >= 1 ? 1 : guess;
    for (let i = 0; i < MAX_ITERS; i++) {
        const r = bez(seg.s0, seg.p1s, seg.p2s, seg.s1, t) - target;
        if (r > 0) hi = t;
        else lo = t;
        if (Math.abs(r) <= tol) break;
        const d = bezDeriv(seg.s0, seg.p1s, seg.p2s, seg.s1, t);
        let tn = d > EPS ? t - r / d : (lo + hi) / 2;
        if (!(tn > lo && tn < hi)) tn = (lo + hi) / 2;
        if (Math.abs(tn - t) <= EPS) {
            t = tn;
            break;
        }
        t = tn;
    }
    return t;
}

/** the authored force at arclength `s`: the cubic-bezier value of the bracketing
 *  segment, held flat before the first keyframe / after the last, DEFAULT_G when
 *  there are none. `points` MUST be sorted by `s` (the ECS layer sorts on gather);
 *  a coincident-s (zero-width) span collapses to the earlier value. */
export function sampleForce(points: readonly ForcePoint[], s: number): number {
    const n = points.length;
    if (n === 0) return DEFAULT_G;
    if (s <= points[0].s) return points[0].g;
    if (s >= points[n - 1].s) return points[n - 1].g;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (points[mid].s <= s) lo = mid;
        else hi = mid;
    }
    const a = points[lo];
    const b = points[hi];
    if (b.s - a.s <= EPS) return a.g;
    const seg = segment(a, b);
    const t = solveT(seg, s, (s - a.s) / (b.s - a.s));
    return bez(seg.g0, seg.p1g, seg.p2g, seg.g1, t);
}

/** the ONE seam that pairs a force section's realized edge count with its per-edge step:
 *  `edges = max(1, round(length/step))`, floored at 1 so a zero-length section still
 *  integrates one step, and `ds = length/edges` is the EXACT per-edge step that closes the
 *  section's authored `length` bit-for-bit (`edges·ds === length` to f32 accumulation) —
 *  never `step` itself, whose rounding residual is what left `forceProfile`'s σ grid and
 *  `evalForce`'s march disagreeing with the authored extent (`kex2d-section-extent`, locked
 *  decision). The conformed `ds` is a FIXED POINT of this same rounding — re-resolving an
 *  already-conforming step (a converted section's stored `Section.ds`) reproduces the same
 *  `edges`, the quantity that actually survives; `ds` itself is re-derived in f64 and may differ
 *  from a stored f32 step by up to one f32 ulp, a strict improvement over the stored value, not a
 *  no-op. Every production pairing of a force section's edge count with its step goes through
 *  this ONE seam — never its own local `round(length/step)`, and never split (destructuring
 *  `edges` alone and marching `forceProfile`/`evalForce` on some OTHER `ds` defeats the pairing
 *  as surely as skipping the seam — `kex2d-section-extent` stage 4) — so `forceProfile`'s σ grid
 *  and `evalForce`'s march always agree on the same `ds`. */
export function resolveStep(length: number, step: number): { edges: number; ds: number } {
    const edges = Math.max(1, Math.round(length / step));
    return { edges, ds: length / edges };
}

/** the dense per-edge force over a section of `length` meters at edge step `ds`:
 *  edge `i` is driven by the force at its leading sample `σ_i = i·ds` (the source-σ
 *  convention `section.evalForce` / the forward integrator use). `edges =
 *  round(length/ds)`, floored at 1 so a zero-length section still integrates one
 *  step — a NO-OP when `ds` already comes from {@link resolveStep} (its fixed-point
 *  property), which every production caller is expected to have already applied; this
 *  function does not conform `ds` itself; see the module header. `points` sorted by s.
 *  marches the bezier `t` monotonically per segment as σ ascends (warm-started root
 *  solve), never Newton-from-scratch per sample. */
export function forceProfile(
    points: readonly ForcePoint[],
    length: number,
    ds: number,
): Float32Array {
    const edges = Math.max(1, Math.round(length / ds));
    const fN = new Float32Array(edges);
    const n = points.length;
    if (n === 0) {
        fN.fill(DEFAULT_G);
        return fN;
    }
    const first = points[0];
    const last = points[n - 1];
    let seg = -1; // index of the currently-built segment (points[seg] → points[seg+1])
    let built: Seg | null = null;
    let t = 0; // warm-start carried across ascending σ within a segment
    for (let i = 0; i < edges; i++) {
        const s = i * ds;
        if (s <= first.s) {
            fN[i] = first.g;
            continue;
        }
        if (s >= last.s) {
            fN[i] = last.g;
            continue;
        }
        // advance to the segment bracketing s: points[cursor].s ≤ s < points[cursor+1].s,
        // skipping zero-width spans. reset the warm start when the segment changes.
        let cursor = seg < 0 ? 0 : seg;
        while (cursor + 1 < n && points[cursor + 1].s <= s) cursor++;
        if (cursor !== seg) {
            seg = cursor;
            built = segment(points[seg], points[seg + 1]);
            t = 0;
        }
        const b = built as Seg;
        t = solveT(b, s, t);
        fN[i] = bez(b.g0, b.p1g, b.p2g, b.g1, t);
    }
    return fN;
}
