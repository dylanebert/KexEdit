import { G, loss, step, V_FLOOR } from "./forward";

// V_FLOOR/G are owned by `forward` (the integrator that clamps `vSafe` and drives the march);
// the inversion below must use the same values, so re-export/read them from one source.
export { V_FLOOR };

/**
 * diagnostic threshold for first-class infeasibility surfacing — distinct
 * from V_FLOOR. samples with `|v| < V_WARN` flag as infeasible and trigger
 * the red-dashed track / red-ring handles / warning banner UX. set higher
 * than V_FLOOR so the warning fires before the cart enters the
 * physics-dishonest creep zone.
 */
export const V_WARN = 1.0;

/** wrap an angle delta into (−π, π]. */
function wrap(a: number): number {
    return ((((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
}

/**
 * recover the **physical** normal force F_n + per-sample (θ, v) from a position
 * curve — the bake path the app uses. derives each sample's heading θ as the
 * curve's local tangent (the bisector of the adjacent chord angles; free ends
 * extrapolated), then `F_n[i] = (θ_{i+1} − θ_i)·v²/(g·ds) + cos θ_i` = κ·v²/g +
 * cos θ, the normal force a cart riding the sampled curve feels.
 *
 * this is deliberately NOT `invertRange` (below). that one is the exact
 * algebraic inverse of the forward integrator's staggered midpoint step, which
 * carries a leapfrog "computational mode": a marginally-stable ±(−1)^i tangent
 * oscillation. it cancels to zero on positions the integrator itself produced
 * (so the round-trip is exact), but on an arbitrary curve — a Hermite
 * spline — that mode is excited and F_n sawtooths sample-to-sample. the
 * physical force is smooth, so the bake recovers θ from the geometry directly
 * (the tangent bisector has no such mode) instead of via the reflection.
 *
 * a **degenerate** (zero-length) edge has no chord, so the geometry defines
 * neither its angle nor a curvature: it carries the running chord angle across
 * and its `F_n` is the stationary cart's own normal force, `cos θ` (the cart
 * traverses no arc, so there is no centripetal demand — the κ·v²/g term is
 * absent, not divided by zero). A chain with no chord ANYWHERE recovers
 * `theta0`, the entry heading. Only a Time-domain force march produces these:
 * `ds_i = v_i·Δt` is exactly 0 at a stall (`section.evalForce`), where the cart
 * is frozen and its orientation therefore doesn't change.
 *
 * writes theta[offset..offset+M], v[offset..offset+M], fN[offset..offset+M−1]
 * given posX/posY[offset..offset+M] already laid out and a per-edge `dsArr`.
 *
 * `vSqOverride(k, natural)`, when it returns a number for local edge `k`,
 * REPLACES the (now dissipative) `natural` v² this edge lands on —
 * `forward.step`'s channel, mirrored here because the recovery recomputes v
 * from scratch rather than trusting a march's own (an authored control must
 * land the same exit v whether the caller re-derives it from geometry or
 * reads the march). `natural` is that edge's dissipative conserved value
 * (energy delta minus `forward.loss(fN, v_k², ds, friction, resistance)`),
 * handed through so an ADDITIVE consumer doesn't have to re-derive it.
 * Omitted or returning `undefined` per-edge leaves that edge byte-identical to
 * the unmodified recovery. `friction`/`resistance` default 0.
 *
 * `fN[k]` is computed HERE, inside this same v-recovery loop, from the
 * already-laid-out θ and this edge's entry `v[k]` — collapsing what used to
 * be a separate third pass. Order-correct because `fN[k]` never depends on
 * `v[k+1]`: only `v[k]` (already known) and θ (already fully recovered
 * above), so `fN[k]` can be read off before `v[k+1]` is derived from it (the
 * loss term needs `fN[k]`'s magnitude, so it must land first).
 *
 * returns the accumulated sqrt-clamp energy injection over `[offset,
 * offset+M)` — `Σ −min(vSq_k, 0)` (v² units, the pin consequence,
 * `kex2d-map.md`): 0 wherever the march never drives a pre-clamp v²
 * negative, the case that holds everywhere but a genuine stall. The
 * defect's own site, measured directly rather than inferred from an exit-v
 * stamp — `optimize.ts`'s `finalize` gates on it (`kex2d-friction` stage 3).
 */
export function forces(
    posX: Float32Array,
    posY: Float32Array,
    theta: Float32Array,
    v: Float32Array,
    fN: Float32Array,
    dsArr: Float32Array,
    offset: number,
    M: number,
    v0: number,
    theta0 = 0,
    g: number = G,
    vMin: number = V_FLOOR,
    friction: number = 0,
    resistance: number = 0,
    vSqOverride?: (k: number, natural: number) => number | undefined,
): number {
    /** edge `k`'s chord angle, or NaN where it has no chord. */
    const chord = (k: number): number => {
        const dx = posX[offset + k + 1] - posX[offset + k];
        const dy = posY[offset + k + 1] - posY[offset + k];
        return dx === 0 && dy === 0 ? Number.NaN : Math.atan2(dy, dx);
    };
    /** the continuous sweep advanced over edge `k`: a chordless edge holds it. */
    const edge = (running: number, k: number): number => {
        const a = chord(k);
        return Number.isNaN(a) ? running : running + wrap(a - running);
    };

    // the sweep's seed: the first edge that HAS a chord, so a leading degenerate
    // run carries that angle back rather than reading atan2(0, 0) as 0. with no
    // chord at all the entry heading is the only heading there is.
    let seed = theta0;
    for (let k = 0; k < M; k++) {
        const a = chord(k);
        if (!Number.isNaN(a)) {
            seed = a;
            break;
        }
    }

    // per-sample tangent θ: the bisector of the chord angles either side of the
    // sample, over a *continuous* (unwrapped) chord-angle sweep so θ stays
    // continuous across the ±π atan2 branch cut — the cart lerps θ for its
    // orientation, so a jump there would spin it. the free ends have one
    // neighbor, so extrapolate the bisector trend (exact for constant
    // curvature, second-order otherwise).
    if (M === 1) {
        theta[offset] = seed;
        theta[offset + 1] = seed;
    } else {
        let prev = edge(seed, 0); // running continuous chord angle, cont[k−1]
        let cur = edge(prev, 1); // cont[k]
        theta[offset] = prev - 0.5 * (cur - prev); // extrapolate the start tangent
        theta[offset + 1] = 0.5 * (prev + cur);
        for (let k = 2; k < M; k++) {
            prev = cur;
            cur = edge(prev, k);
            theta[offset + k] = 0.5 * (prev + cur);
        }
        theta[offset + M] = cur + 0.5 * (cur - prev); // extrapolate the end tangent
    }

    // F_n recovery folded into the velocity pass — same form as the forward
    // step, minus this edge's dissipative loss. `vSqOverride`, when present,
    // substitutes the (dissipative) natural value (the channel).
    v[offset] = v0;
    let injection = 0;
    for (let k = 0; k < M; k++) {
        const i = offset + k;
        const ds = dsArr[i];
        if (!(ds > 0)) {
            // chordless: a stationary cart, so gravity's track-normal term alone —
            // no arc traversed, no distance to dissipate over either.
            fN[i] = Math.cos(theta[i]);
        } else {
            const vSafe = Math.max(Math.abs(v[i]), vMin);
            // θ is continuous, so the per-edge turn is the bare difference.
            fN[i] = ((theta[i + 1] - theta[i]) * vSafe * vSafe) / (g * ds) + Math.cos(theta[i]);
        }
        const conserved = v[i] * v[i] - 2 * g * (posY[i + 1] - posY[i]);
        const natural = conserved - loss(fN[i], v[i] * v[i], ds, friction, resistance);
        const override = vSqOverride?.(k, natural);
        const vSq = override !== undefined ? override : natural;
        // the sqrt clamp's own energy injection, measured at its own site (the pin
        // consequence, `kex2d-map.md`): a physically non-stalling march never drives
        // `vSq` negative, so this is 0 by construction everywhere but a genuine clamp
        // event — `-min(vSq, 0)`, accumulated in v² units, the same units `loss` uses.
        if (vSq < 0) injection -= vSq;
        v[i + 1] = Math.sqrt(Math.max(vSq, 0));
    }
    return injection;
}

/**
 * recover F_n + per-sample (θ, v) over a range starting at `offset`, the exact
 * algebraic inverse of the forward integrator's staggered midpoint step:
 * sample θ via chord-angle propagation `θ_{i+1} = 2·atan2(dy,dx) − θ_i` from
 * `theta0`, F_n solved algebraically from that θ and v[k], v via the energy
 * delta `v_{i+1}² = v_i² − 2g·(y_{i+1} − y_i)` minus this edge's dissipative
 * `loss` (`friction`/`resistance`, both defaulted 0).
 *
 * **`invertRange` mirrors the loss rather than pinning its round-trip oracle
 * to μ=c=0** (`kex2d-friction` stage 1's executor call): the θ-recovery and
 * the F_n-solve above never reference `friction`/`resistance` at all — they
 * are the exact algebraic inverse of the forward step's `dtheta` equation,
 * which the loss term does not touch — so the recovered F_n is EXACTLY the
 * one that drove the matching forward step, dissipative or not. Given that
 * same F_n, subtracting the identical `loss(fN, v_k², ds, friction,
 * resistance)` from the same energy delta reconstructs the same v_{k+1}: the
 * round trip stays exact (to f32 accumulation) as long as both directions are
 * called with the same coefficients, mirroring `forward.step`'s own shape.
 *
 * this is the integrator's matched inverse (used for round-trip validation — it
 * exactly reproduces the force that drove a forward step), NOT the app bake — see
 * `forces` above for why (the reflection's leapfrog mode oscillates on arbitrary
 * curves).
 *
 * writes theta[offset..offset+M], v[offset..offset+M], fN[offset..offset+M−1]
 * given posX/posY[offset..offset+M] already laid out and a per-edge `dsArr`.
 */
export function invertRange(
    posX: Float32Array,
    posY: Float32Array,
    theta: Float32Array,
    v: Float32Array,
    fN: Float32Array,
    dsArr: Float32Array,
    offset: number,
    M: number,
    theta0: number,
    v0: number,
    g: number = G,
    vMin: number = V_FLOOR,
    friction: number = 0,
    resistance: number = 0,
): void {
    // θ recovery is positions-only (no v/F_n dependency), so it lands as its
    // own pass first — mirrors `forces`' theta pass.
    theta[offset] = theta0;
    for (let k = 0; k < M; k++) {
        const i = offset + k;
        const midAngle = Math.atan2(posY[i + 1] - posY[i], posX[i + 1] - posX[i]);
        // chord-angle propagation `θ_{i+1} = 2·midAngle − θ_i`, with the
        // per-edge delta wrapped into (-π, π] so the atan2 branch cut at ±π
        // doesn't jump theta by 2π when the chain rotates past it.
        let dtheta = 2 * midAngle - 2 * theta[i];
        dtheta = ((((dtheta + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
        theta[i + 1] = theta[i] + dtheta;
    }
    // F_n[k] solved from θ + this edge's entry v[k] (known before v[k+1] is
    // derived from it), then v[k+1] folds in the loss — same collapse as
    // `forces`, and the same reason: F_n never depends on v[k+1].
    v[offset] = v0;
    for (let k = 0; k < M; k++) {
        const i = offset + k;
        const vSafe = Math.max(Math.abs(v[i]), vMin);
        const dtheta = theta[i + 1] - theta[i];
        fN[i] = (dtheta * vSafe * vSafe) / (g * dsArr[i]) + Math.cos(theta[i]);
        const dy = posY[i + 1] - posY[i];
        const conserved = v[i] * v[i] - 2 * g * dy;
        const vSq = conserved - loss(fN[i], v[i] * v[i], dsArr[i], friction, resistance);
        v[i + 1] = Math.sqrt(Math.max(vSq, 0));
    }
}

export function invert(
    posX: Float32Array,
    posY: Float32Array,
    theta: Float32Array,
    v: Float32Array,
    fN: Float32Array,
    count: number,
    ds: number,
    theta0: number,
    v0: number,
    g: number = G,
    vMin: number = V_FLOOR,
    friction: number = 0,
    resistance: number = 0,
): void {
    const dsArr = new Float32Array(count - 1).fill(ds);
    invertRange(
        posX,
        posY,
        theta,
        v,
        fN,
        dsArr,
        0,
        count - 1,
        theta0,
        v0,
        g,
        vMin,
        friction,
        resistance,
    );
}

/** forward-integrate from (x0, y0, theta0, v0) with the given F_n and per-edge
 *  `dsArr`. exists for round-trip tests + any path wanting the integrator-exact
 *  positions. reads the first `count` SoA slots + `count − 1` fN / ds slots.
 *  per-edge ds because the forward build stores the exact chord per edge.
 *  `friction`/`resistance` (defaulted 0) thread to the underlying `step`
 *  call — `invertRange`'s round-trip partner. */
export function replay(
    posX: Float32Array,
    posY: Float32Array,
    theta: Float32Array,
    v: Float32Array,
    fN: Float32Array,
    dsArr: Float32Array,
    x0: number,
    y0: number,
    theta0: number,
    v0: number,
    count: number,
    friction: number = 0,
    resistance: number = 0,
): void {
    posX[0] = x0;
    posY[0] = y0;
    theta[0] = theta0;
    v[0] = v0;
    for (let i = 0; i < count - 1; i++) {
        step(posX, posY, theta, v, i, i + 1, fN[i], dsArr[i], G, V_FLOOR, friction, resistance);
    }
}
