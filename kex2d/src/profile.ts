/** the force-authoring primitive: authored force points → a dense per-edge F_n(σ)
 *  profile the substrate integrates (kex/specs/kex2d-sections.md §6). the force
 *  analogue of `spline.ts`'s `sampleChain` — a pure, framework-free authoring layer
 *  the ECS bake feeds into `section.evalForce`. the atoms stay opinion-free: they
 *  consume dense per-edge force and know nothing about points or interpolation.
 *
 *  §6 semantics: linear interpolation between points, an empty profile is a constant
 *  DEFAULT_G, and the first/last point's value is held flat beyond it (the original
 *  core's empty-track-→-default + endpoint-hold). points are input handles authored
 *  on the s-axis; the displayed curve is re-recovered from the swept geometry (§2),
 *  so it sits O(ds) off these values — expected, not a bug. */

/** a force keyframe: a demanded normal force `g` at arclength `s` (m). */
export interface ForcePoint {
    s: number;
    g: number;
}

/** the force an empty profile holds — level 1g gravity, a flat straight track. */
export const DEFAULT_G = 1;

/** the authored force at arclength `s`: linear interpolation between the two
 *  bracketing points, held flat before the first / after the last, DEFAULT_G when
 *  there are none (§6). `points` MUST be sorted by `s` (the ECS layer sorts on
 *  gather); coincident-s points collapse to the earlier value (zero-width span). */
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
    const span = points[hi].s - points[lo].s;
    const f = span > 1e-12 ? (s - points[lo].s) / span : 0;
    return points[lo].g + f * (points[hi].g - points[lo].g);
}

/** the dense per-edge force over a section of `length` meters at edge step `ds`:
 *  edge `i` is driven by the force at its leading sample `σ_i = i·ds` (the source-σ
 *  convention `section.evalForce` / the forward integrator use). `edges =
 *  round(length/ds)`, floored at 1 so a zero-length section still integrates one
 *  step. `points` sorted by s. */
export function forceProfile(
    points: readonly ForcePoint[],
    length: number,
    ds: number,
): Float32Array {
    const edges = Math.max(1, Math.round(length / ds));
    const fN = new Float32Array(edges);
    for (let i = 0; i < edges; i++) fN[i] = sampleForce(points, i * ds);
    return fN;
}
