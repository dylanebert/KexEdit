import { step, V_FLOOR } from "./forward";

// V_FLOOR is owned by `forward` (the integrator that clamps `vSafe`); the
// inversion below must use the same value, so re-export it from one source.
export { V_FLOOR };

const G = 9.80665;

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
 * writes theta[offset..offset+M], v[offset..offset+M], fN[offset..offset+M−1]
 * given posX/posY[offset..offset+M] already laid out and a per-edge `dsArr`.
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
    g: number = G,
    vMin: number = V_FLOOR,
): void {
    const edge = (k: number): number =>
        Math.atan2(
            posY[offset + k + 1] - posY[offset + k],
            posX[offset + k + 1] - posX[offset + k],
        );

    // per-sample tangent θ: the bisector of the chord angles either side of the
    // sample, over a *continuous* (unwrapped) chord-angle sweep so θ stays
    // continuous across the ±π atan2 branch cut — the cart lerps θ for its
    // orientation, so a jump there would spin it. the free ends have one
    // neighbor, so extrapolate the bisector trend (exact for constant
    // curvature, second-order otherwise).
    if (M === 1) {
        theta[offset] = edge(0);
        theta[offset + 1] = edge(0);
    } else {
        let prev = edge(0); // running continuous chord angle, cont[k−1]
        let cur = prev + wrap(edge(1) - prev); // cont[k]
        theta[offset] = prev - 0.5 * (cur - prev); // extrapolate the start tangent
        theta[offset + 1] = 0.5 * (prev + cur);
        for (let k = 2; k < M; k++) {
            prev = cur;
            cur = prev + wrap(edge(k) - prev);
            theta[offset + k] = 0.5 * (prev + cur);
        }
        theta[offset + M] = cur + 0.5 * (cur - prev); // extrapolate the end tangent
    }

    // velocity from energy conservation — same form as the forward step.
    v[offset] = v0;
    for (let k = 0; k < M; k++) {
        const i = offset + k;
        const vSq = v[i] * v[i] - 2 * g * (posY[i + 1] - posY[i]);
        v[i + 1] = Math.sqrt(Math.max(vSq, 0));
    }

    for (let k = 0; k < M; k++) {
        const i = offset + k;
        const vSafe = Math.max(Math.abs(v[i]), vMin);
        // θ is continuous, so the per-edge turn is the bare difference.
        fN[i] = ((theta[i + 1] - theta[i]) * vSafe * vSafe) / (g * dsArr[i]) + Math.cos(theta[i]);
    }
}

/**
 * recover F_n + per-sample (θ, v) over a range starting at `offset`, the exact
 * algebraic inverse of the forward integrator's staggered midpoint step:
 * sample θ via chord-angle propagation `θ_{i+1} = 2·atan2(dy,dx) − θ_i` from
 * `theta0`, v via the energy delta `v_{i+1}² = v_i² − 2g·(y_{i+1} − y_i)`.
 *
 * this is the integrator's matched inverse (used for round-trip validation and
 * the future F_n optimizer), NOT the app bake — see `forces` above for why
 * (the reflection's leapfrog mode oscillates on arbitrary curves).
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
): void {
    theta[offset] = theta0;
    v[offset] = v0;
    for (let k = 0; k < M; k++) {
        const i = offset + k;
        const midAngle = Math.atan2(posY[i + 1] - posY[i], posX[i + 1] - posX[i]);
        // chord-angle propagation `θ_{i+1} = 2·midAngle − θ_i`, with the
        // per-edge delta wrapped into (-π, π] so the atan2 branch cut at ±π
        // doesn't jump theta by 2π when the chain rotates past it.
        let dtheta = 2 * midAngle - 2 * theta[i];
        dtheta = ((((dtheta + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
        theta[i + 1] = theta[i] + dtheta;
        const dy = posY[i + 1] - posY[i];
        const vSq = v[i] * v[i] - 2 * g * dy;
        v[i + 1] = Math.sqrt(Math.max(vSq, 0));
    }
    for (let k = 0; k < M; k++) {
        const i = offset + k;
        const vSafe = Math.max(Math.abs(v[i]), vMin);
        const dtheta = theta[i + 1] - theta[i];
        fN[i] = (dtheta * vSafe * vSafe) / (g * dsArr[i]) + Math.cos(theta[i]);
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
): void {
    const dsArr = new Float32Array(count - 1).fill(ds);
    invertRange(posX, posY, theta, v, fN, dsArr, 0, count - 1, theta0, v0, g, vMin);
}

/** forward-integrate from (x0, y0, theta0, v0) with the given F_n and per-edge
 *  `dsArr`. exists for round-trip tests + any path wanting the integrator-exact
 *  positions. reads the first `count` SoA slots + `count − 1` fN / ds slots.
 *  per-edge ds because the forward build stores the exact chord per edge. */
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
): void {
    posX[0] = x0;
    posY[0] = y0;
    theta[0] = theta0;
    v[0] = v0;
    for (let i = 0; i < count - 1; i++) {
        step(posX, posY, theta, v, i, i + 1, fN[i], dsArr[i]);
    }
}
