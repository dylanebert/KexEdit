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
 * per-edge dissipative loss, in v² units: Coulomb friction on the actual
 * normal-force MAGNITUDE plus quadratic drag — `2·(μ·g·|fMag| + c·v²)·ds`
 * (`kex2d-map.md`'s path-energy law; the model, `kex2d-friction`'s Locked
 * decision). One named function beside `step` so the arithmetic lands once —
 * `step`/`integrate` (the march) and `bake.forces` (the recovery) are its two
 * call sites today; a booked time-domain ride sim and the 3D kernel this one
 * seeds are its next two, unchanged.
 *
 * `fMag` is the track-perpendicular constraint-force MAGNITUDE in g (`|N| =
 * m·g·fMag`) — deliberately not a signed 2D `fN`: a 3D caller's own frame has
 * more than one perpendicular component (`√(fN² + fLat²)`, side and upstop
 * wheels both gripping), and only the magnitude survives that copy-forward.
 * 2D callers here pass `|fN|`; this function re-abs's it defensively so the
 * loss is correct even handed a raw signed value. `vSq` is the edge's ENTRY
 * v² (the value the loss is subtracted from — `v_k²` in the Locked decision's
 * notation, matching the incumbent Rust core's own previous-velocity drag
 * term, `physics.rs update_velocity`). `ds` is the edge's arclength (zero on
 * a stalled Time-domain edge, which correctly zeroes the loss too — no
 * distance travelled, nothing lost). `friction`/`resistance` default 0, so an
 * unauthored track's loss is 0 everywhere it's called from.
 */
export function loss(
    fMag: number,
    vSq: number,
    ds: number,
    friction: number = 0,
    resistance: number = 0,
): number {
    return 2 * (friction * G * Math.abs(fMag) + resistance * vSq) * ds;
}

/**
 * advance one sample by Δs along arclength, reading from `src` and writing to
 * `dst`. force-driven via `fN` (units of g). semi-implicit: angle updates
 * first, position uses midpoint angle, velocity from energy delta minus this
 * edge's dissipative `loss` (`friction`/`resistance`, both defaulted 0 —
 * byte-identical to the pre-friction kernel on an unauthored track).
 *
 * `vSqOverride`, when given, REPLACES the (now dissipative) `natural` v² for
 * this edge — the per-edge v²-modification channel an authored speed control
 * rides. The dissipative value is computed either way and handed to the
 * caller as `vSqOverride`'s argument, so an ADDITIVE consumer could ride the
 * same seam without recomputing the march's own kinematics (`dy` depends on
 * this step's mid-heading, internal here) — a prescribed-ramp consumer just
 * ignores the argument and returns its own value (prescription beats
 * dissipation: inside a controlled span the actuator absorbs the losses,
 * `kex2d-friction`'s Locked decision). `undefined` (the default) takes the
 * dissipative value, so an uncontrolled march is byte-identical to before the
 * channel existed. Geometry (θ, x, y) is unaffected — only the velocity this
 * edge lands on is substituted, mirroring the original core's
 * `update_velocity` folding a known energy term into exactly this line
 * (`kexedit/packages/core/src/sim/physics.rs:49`).
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
    friction: number = 0,
    resistance: number = 0,
    vSqOverride?: (natural: number) => number | undefined,
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
    const conserved = vs * vs - 2 * g * dy;
    const natural = conserved - loss(fN, vs * vs, ds, friction, resistance);
    const override = vSqOverride?.(natural);
    const vSq = override !== undefined ? override : natural;
    const vNext = Math.sqrt(Math.max(vSq, 0));

    posX[dst] = xNext;
    posY[dst] = yNext;
    theta[dst] = tNext;
    v[dst] = vNext;
}

/**
 * walk `count` samples along arclength. index 0 is assumed pre-set; writes
 * indices `1 .. count−1` in place. F_n is sampled at `σ_i = i · ds`
 * (source convention, driving step i → i+1). `vSqOverride(i, natural)`, when
 * it returns a number, substitutes edge `i`'s v² — `natural` is that edge's
 * unmodified conserved value (`step`'s channel, above), so an additive
 * consumer can read it without re-deriving the march. `undefined` per-edge or
 * omitted entirely leaves that edge/march byte-identical to the unmodified
 * integrator. `friction`/`resistance` (both defaulted 0) thread straight to
 * `step`'s own `loss` term, same convention.
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
    friction: number = 0,
    resistance: number = 0,
    vSqOverride?: (i: number, natural: number) => number | undefined,
): void {
    for (let i = 0; i < count - 1; i++) {
        step(
            posX,
            posY,
            theta,
            v,
            i,
            i + 1,
            fNCurve(i * ds),
            ds,
            g,
            vMin,
            friction,
            resistance,
            vSqOverride && ((natural) => vSqOverride(i, natural)),
        );
    }
}
