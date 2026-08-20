import type { SampleState } from "../helpers/forward64";

const G = 9.80665;

export interface RK4Options {
    /** sub-step in time. RK4 truncation error per step is O(dt⁵); default 1e-4
     * keeps cumulative error well below f64 noise on the trajectories tests
     * exercise. Smaller dt buys nothing once dominated by f64. */
    dt?: number;
    /** safety cap on total substeps. Default 10⁷ — enough for any realistic
     * trajectory with default dt; trips early on a stuck integration (e.g. v→0
     * outside the differentiable regime). */
    maxSubsteps?: number;
}

/**
 * RK4 oracle of the cart-on-track ODE, parameterized by time. Integrates
 *
 *   dx/dt = v · cos θ
 *   dy/dt = v · sin θ
 *   dθ/dt = (F_n(σ) − cos θ) · g / v
 *   dv/dt = −g · sin θ − μ·g·|F_n(σ)| − c·v²    (continuum form of `forward.loss`)
 *   dσ/dt = v
 *
 * with substeps of `dt`, shrinking the last substep before each σ = i · Δs
 * crossing to land on the grid (σ snapped to suppress drift). Independent
 * cross-validation for `src/forward.ts`, extended with `friction`/`resistance`
 * (both defaulted 0 — byte-identical to the pre-friction oracle) for
 * `kex2d-friction`'s convergence-order arm: `dv/dt` gains the dissipative
 * terms directly (not `dv²/dt`, since this oracle integrates `v`, not `v²`;
 * `d(v²)/dt = 2v·dv/dt`, so `2v·(−μg|F_n|−cv²)/v = −2μg|F_n| − 2cv²` matches
 * `forward.loss`'s v² form exactly once the chain rule is undone). Caller
 * must keep v strictly positive — no v_min clamp; throws via `maxSubsteps` if
 * the regime breaks.
 */
export function rk4(
    x0: number,
    y0: number,
    theta0: number,
    v0: number,
    N: number,
    ds: number,
    fN: (sigma: number) => number,
    g: number = G,
    options: RK4Options = {},
    friction = 0,
    resistance = 0,
): SampleState[] {
    const dt = options.dt ?? 1e-4;
    const maxSubsteps = options.maxSubsteps ?? 10_000_000;

    const out: SampleState[] = new Array(N);
    out[0] = [x0, y0, theta0, v0];

    let x = x0;
    let y = y0;
    let theta = theta0;
    let v = v0;
    let sigma = 0;
    let next = 1;

    const deriv = (th: number, vv: number, sg: number) => {
        const c = Math.cos(th);
        const s = Math.sin(th);
        const fMag = Math.abs(fN(sg));
        const dv = -g * s - friction * g * fMag - resistance * vv * vv;
        return [vv * c, vv * s, ((fN(sg) - c) * g) / vv, dv, vv] as const;
    };

    const rk4Step = (h: number): void => {
        const k1 = deriv(theta, v, sigma);
        const k2 = deriv(theta + 0.5 * h * k1[2], v + 0.5 * h * k1[3], sigma + 0.5 * h * k1[4]);
        const k3 = deriv(theta + 0.5 * h * k2[2], v + 0.5 * h * k2[3], sigma + 0.5 * h * k2[4]);
        const k4 = deriv(theta + h * k3[2], v + h * k3[3], sigma + h * k3[4]);

        x += (h / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
        y += (h / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
        theta += (h / 6) * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]);
        v += (h / 6) * (k1[3] + 2 * k2[3] + 2 * k3[3] + k4[3]);
        sigma += (h / 6) * (k1[4] + 2 * k2[4] + 2 * k3[4] + k4[4]);
    };

    for (let step = 0; step < maxSubsteps && next < N; step++) {
        const target = next * ds;
        const remaining = target - sigma;
        // v ≤ 0 or remaining ≤ 0 → skip landing and dt-step; maxSubsteps catches runaway.
        if (v > 0 && remaining > 0 && remaining / v <= dt) {
            rk4Step(remaining / v);
            sigma = target;
            out[next] = [x, y, theta, v];
            next++;
        } else {
            rk4Step(dt);
        }
    }

    if (next < N) {
        throw new Error(
            `rk4 did not reach sample ${next}/${N} after ${maxSubsteps} substeps ` +
                `(σ=${sigma}, v=${v}). Caller likely left the differentiable regime.`,
        );
    }

    return out;
}

/**
 * RK4 oracle of the same cart-on-track ODE as `rk4`, landed on the **time**
 * grid `t = i·Δt` instead of the arclength grid `rk4` lands on — the exact
 * oracle for `section.evalForce`'s `Domain.Time` path. `F_n` is queried at
 * elapsed time directly (`t_i = i·Δt`, the source-σ convention's time twin),
 * so unlike `rk4` no extra state variable is needed to track the query
 * argument: time already IS the ODE's independent variable, so the query at
 * any RK4 sub-stage is just the elapsed time plus that sub-stage's own time
 * offset (`sigma` needed its own `dσ/dt = v` integration; elapsed time does
 * not). `friction`/`resistance` (both defaulted 0) extend `dv/dt` the same
 * way as `rk4`. Caller must keep v strictly positive — no v_min clamp; throws
 * via `maxSubsteps` if the regime breaks.
 */
export function rk4Time(
    x0: number,
    y0: number,
    theta0: number,
    v0: number,
    N: number,
    dt: number,
    fN: (t: number) => number,
    g: number = G,
    options: RK4Options = {},
    friction = 0,
    resistance = 0,
): SampleState[] {
    const subDt = options.dt ?? 1e-4;
    const maxSubsteps = options.maxSubsteps ?? 10_000_000;

    const out: SampleState[] = new Array(N);
    out[0] = [x0, y0, theta0, v0];

    let x = x0;
    let y = y0;
    let theta = theta0;
    let v = v0;
    let elapsed = 0;
    let next = 1;

    const deriv = (th: number, vv: number, t: number) => {
        const c = Math.cos(th);
        const s = Math.sin(th);
        const fMag = Math.abs(fN(t));
        const dv = -g * s - friction * g * fMag - resistance * vv * vv;
        return [vv * c, vv * s, ((fN(t) - c) * g) / vv, dv] as const;
    };

    const rk4Step = (h: number): void => {
        const k1 = deriv(theta, v, elapsed);
        const k2 = deriv(theta + 0.5 * h * k1[2], v + 0.5 * h * k1[3], elapsed + 0.5 * h);
        const k3 = deriv(theta + 0.5 * h * k2[2], v + 0.5 * h * k2[3], elapsed + 0.5 * h);
        const k4 = deriv(theta + h * k3[2], v + h * k3[3], elapsed + h);

        x += (h / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
        y += (h / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
        theta += (h / 6) * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]);
        v += (h / 6) * (k1[3] + 2 * k2[3] + 2 * k3[3] + k4[3]);
        elapsed += h;
    };

    for (let step = 0; step < maxSubsteps && next < N; step++) {
        const target = next * dt;
        const remaining = target - elapsed;
        if (remaining > 0 && remaining <= subDt) {
            rk4Step(remaining);
            elapsed = target;
            out[next] = [x, y, theta, v];
            next++;
        } else {
            rk4Step(subDt);
        }
    }

    if (next < N) {
        throw new Error(
            `rk4Time did not reach sample ${next}/${N} after ${maxSubsteps} substeps ` +
                `(t=${elapsed}, v=${v}).`,
        );
    }

    return out;
}
