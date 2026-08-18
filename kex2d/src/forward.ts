/** standard gravity, m/s² — owned here (the lowest layer, the integrator that consumes it) and
 *  read by `bake.ts`/`optimize.ts`, the same one-home pattern as `V_FLOOR` (which `bake.ts` does
 *  re-export, since its own inversion needs the identical clamp value). */
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
 *
 * `vSqOverride`, when given, REPLACES the naturally-conserved `v²` for this
 * edge — the per-edge v²-modification channel an authored speed control (or a
 * future friction/drag term, `kex2d-map.md`'s conservative-energy law) rides.
 * `undefined` (the default) takes the natural value, so an uncontrolled march
 * is byte-identical to before the channel existed. Geometry (θ, x, y) is
 * unaffected — only the velocity this edge lands on is substituted, mirroring
 * the original core's `update_velocity` folding a known energy term into
 * exactly this line (`kexedit/packages/core/src/sim/physics.rs:49`).
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
    vSqOverride?: number,
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
    const vSq = vSqOverride !== undefined ? vSqOverride : vs * vs - 2 * g * dy;
    const vNext = Math.sqrt(Math.max(vSq, 0));

    posX[dst] = xNext;
    posY[dst] = yNext;
    theta[dst] = tNext;
    v[dst] = vNext;
}

/**
 * walk `count` samples along arclength. index 0 is assumed pre-set; writes
 * indices `1 .. count−1` in place. F_n is sampled at `σ_i = i · ds`
 * (source convention, driving step i → i+1). `vSqOverride(i)`, when it
 * returns a number, substitutes edge `i`'s natural v² (`step`'s channel,
 * above) — `undefined` per-edge or omitted entirely leaves that edge/march
 * byte-identical to the unmodified integrator.
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
    vSqOverride?: (i: number) => number | undefined,
): void {
    for (let i = 0; i < count - 1; i++) {
        step(posX, posY, theta, v, i, i + 1, fNCurve(i * ds), ds, g, vMin, vSqOverride?.(i));
    }
}
