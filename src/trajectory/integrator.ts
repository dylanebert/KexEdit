// The integrator: a kinematic core with four inputs and no physics.
//
// State is the heart's position, unit rotation (local into world), signed speed and signed distance, in
// f64. Input over one tick is piecewise constant: the body rate `omega` in the tick's lane order (pitch
// about +X, yaw about +Y, roll about -Z) and the speed derivative `a`. Rotation advances by the
// exponential map of the body rate, so constant ω is exact at any step. Position advances along the
// midpoint forward by the midpoint speed times dt, with the forward's part perpendicular to the rotation
// axis shortened by sin(θ/2)/(θ/2): that is the exact chord of a constant-ω arc, so a constant-speed
// circle or helix integrates exactly, and with a ≠ 0 the step is second order. No gravity, mass or g
// reaches here; policies own every force.

import { type Quat, rotate, type Vec3 } from "../path/path";
import {
    type RideConstants,
    TICK_FLOATS,
    TICK_LANES,
    type Trajectory,
    type TrajectoryHeader,
    TRAJECTORY_VERSION,
    readTrajectory,
} from "./trajectory";

export interface State {
    position: Vec3;
    rotation: Quat;
    speed: number;
    distance: number;
}

export interface Input {
    /** Body rate in rad/s, lanes (pitch about +X, yaw about +Y, roll about -Z). */
    omega: Vec3;
    /** Speed derivative, m/s². */
    a: number;
}

const FORWARD: Vec3 = [0, 0, -1];

const multiply = (p: Quat, q: Quat): Quat => [
    p[3] * q[0] + p[0] * q[3] + p[1] * q[2] - p[2] * q[1],
    p[3] * q[1] - p[0] * q[2] + p[1] * q[3] + p[2] * q[0],
    p[3] * q[2] + p[0] * q[1] - p[1] * q[0] + p[2] * q[3],
    p[3] * q[3] - p[0] * q[0] - p[1] * q[1] - p[2] * q[2],
];

/** sin(x) / x, with its series where the quotient loses digits. */
const sinc = (x: number) => (Math.abs(x) < 1e-4 ? 1 - (x * x) / 6 : Math.sin(x) / x);

/** exp of the body rotation vector `r` (radians) as a unit quaternion. */
function expMap(r: Vec3): Quat {
    const half = 0.5 * Math.hypot(r[0], r[1], r[2]);
    const k = 0.5 * sinc(half);
    return [r[0] * k, r[1] * k, r[2] * k, Math.cos(half)];
}

/** Advance one tick of `dt` seconds under piecewise-constant input. */
export function step(state: State, input: Input, dt: number): State {
    const { omega, a } = input;
    // the roll lane is the rate about -Z; the rotation vector is about the body axes
    const body: Vec3 = [omega[0], omega[1], -omega[2]];
    const theta = Math.hypot(body[0], body[1], body[2]) * dt;
    const r: Vec3 = [body[0] * dt, body[1] * dt, body[2] * dt];
    const halfTurn = rotate(expMap([r[0] / 2, r[1] / 2, r[2] / 2]), FORWARD);
    let chord = halfTurn;
    if (theta > 0) {
        const n: Vec3 = [r[0] / theta, r[1] / theta, r[2] / theta];
        const along = n[0] * FORWARD[0] + n[1] * FORWARD[1] + n[2] * FORWARD[2];
        const k = sinc(theta / 2);
        chord = [
            along * n[0] + k * (halfTurn[0] - along * n[0]),
            along * n[1] + k * (halfTurn[1] - along * n[1]),
            along * n[2] + k * (halfTurn[2] - along * n[2]),
        ];
    }
    const travel = (state.speed + 0.5 * a * dt) * dt;
    const world = rotate(state.rotation, chord);
    const q = multiply(state.rotation, expMap(r));
    const norm = Math.hypot(q[0], q[1], q[2], q[3]);
    return {
        position: [
            state.position[0] + world[0] * travel,
            state.position[1] + world[1] * travel,
            state.position[2] + world[2] * travel,
        ],
        rotation: [q[0] / norm, q[1] / norm, q[2] / norm, q[3] / norm],
        speed: state.speed + a * dt,
        distance: state.distance + travel,
    };
}

export function writeTick(ticks: Float32Array, i: number, state: State, input: Input): void {
    const o = i * TICK_FLOATS;
    ticks.set(state.position, o + TICK_LANES.position);
    ticks.set(state.rotation, o + TICK_LANES.rotation);
    ticks[o + TICK_LANES.speed] = state.speed;
    ticks[o + TICK_LANES.distance] = state.distance;
    ticks.set(input.omega, o + TICK_LANES.omega);
    ticks[o + TICK_LANES.a] = input.a;
}

/**
 * March `inputs` from `initial` at `rate` ticks per second: f64 state, f32 storage. Tick `i + 1` is the
 * state after `inputs[i]` and carries it; tick 0 is `initial` and carries `inputs[0]`, the input it
 * is about to take.
 */
export function march(initial: State, inputs: readonly Input[], rate: number, constants: RideConstants): Trajectory {
    if (inputs.length === 0) throw new Error("march inputs: expected at least one input");
    const count = inputs.length + 1;
    const ticks = new Float32Array(count * TICK_FLOATS);
    const dt = 1 / rate;
    let state = initial;
    writeTick(ticks, 0, state, inputs[0]);
    for (let i = 0; i < inputs.length; i++) {
        state = step(state, inputs[i], dt);
        writeTick(ticks, i + 1, state, inputs[i]);
    }
    const header: TrajectoryHeader = {
        version: TRAJECTORY_VERSION,
        count,
        rate,
        endReason: "complete",
        endTick: count - 1,
        constants,
    };
    return readTrajectory({ header, ticks });
}
