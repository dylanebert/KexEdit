/** standard gravity (m/s²) — the one value every force↔geometry conversion shares. */
export const G = 9.80665;

/**
 * numerical velocity floor: `step` clamps `vSafe = max(|v|, V_FLOOR)` so the
 * dθ formula stays finite as energy depletes. the inversion (`bake.invertRange`)
 * must clamp at the same value for its algebraic-inverse property to hold, so
 * the floor is owned here (the lowest layer) and re-exported by `bake`. small
 * enough (1e-2 m/s ⇒ ½v² ≈ 5e-5 J/kg) that the energy it adds is negligible
 * against typical coaster KE.
 */
export const V_FLOOR = 0.01;

/**
 * advance one sample by Δs along arclength, reading from `src` and writing to
 * `dst`. force-driven via `fN` (units of g). semi-implicit: angle updates
 * first, position uses midpoint angle, velocity from energy delta.
 */
export function step(
    posX: Float32Array,
    posY: Float32Array,
    theta: Float32Array,
    v: Float32Array,
    src: number,
    dst: number,
    fN: number,
    ds: number,
    g: number = G,
    vMin: number = V_FLOOR,
): void {
    const px = posX[src];
    const py = posY[src];
    const t = theta[src];
    const vs = v[src];

    const vSafe = Math.max(Math.abs(vs), vMin);
    const dtheta = ((fN - Math.cos(t)) * g * ds) / (vSafe * vSafe);
    const tNext = t + dtheta;
    const midT = 0.5 * (t + tNext);
    const xNext = px + ds * Math.cos(midT);
    const yNext = py + ds * Math.sin(midT);
    const dy = yNext - py;
    const vSq = vs * vs - 2 * g * dy;
    const vNext = Math.sqrt(Math.max(vSq, 0));

    posX[dst] = xNext;
    posY[dst] = yNext;
    theta[dst] = tNext;
    v[dst] = vNext;
}

/**
 * walk `count` samples along arclength. index 0 is assumed pre-set; writes
 * indices `1 .. count−1` in place. F_n is sampled at `σ_i = i · ds`
 * (source convention, driving step i → i+1).
 */
export function integrate(
    posX: Float32Array,
    posY: Float32Array,
    theta: Float32Array,
    v: Float32Array,
    count: number,
    ds: number,
    fNCurve: (sigma: number) => number,
    g: number = G,
    vMin: number = V_FLOOR,
): void {
    for (let i = 0; i < count - 1; i++) {
        step(posX, posY, theta, v, i, i + 1, fNCurve(i * ds), ds, g, vMin);
    }
}
