// Policies: authored intent and the emitted history to integrator input; the march is their composition.
//
// A policy is causal and pure over the emitted prefix: `policy(history, intent)` reads the f64 states and
// inputs emitted so far and returns the next tick's input or the reason the march ends there. These
// policies read only the last tick. Shape and energy compose: the shape policy picks ω from the tick-start
// state, then the energy policy picks a knowing ω.
//
// Shape. Rates pass ω through and have no floor. Forces solve the felt specific force at the centre of
// mass, which sits `heartToCom` along local +Y. With body velocity (0, 0, -v) and body rate
// ω = (ωx, ωy, ωz) where ωz = -roll, the heart accelerates (-v ωy, v ωx, -a) in the body and the COM adds
// ω × (ω × r) = h (ωx ωy, -(ωx² + ωz²), ωy ωz); ω̇ × r is dropped because input is constant over a tick.
// With lift = gravity's opposite in the body:
//   g N_normal  = v ωx - h (ωx² + ωz²) + lift_y   → the root of h ωx² - v ωx + (g N - lift_y + h ωz²) = 0 near (gN - lift_y) / v
//   g N_lateral = -ωy (v - h ωx) + lift_x          → ωy = (lift_x - g N_lateral) / (v - h ωx)
// The closure divides by v. Below FORCE_FLOOR, or when no real root exists, the march ends `unsatisfiable`.
//
// FORCE_FLOOR is measured, not chosen. The closure holds the tick-start lift, so the normal realized over
// a tick (midpoint speed times ωx plus the mean lift) departs from the authored one, growing as 1/|v|.
// The running-out fixture climbs at authored 0 g from 15 m/s under friction 0.03 and drag 2e-5 until the
// nose falls over near zero speed. With no floor, start pitches 30° to 89.95° were swept for the highest
// speed at which a tick departs by more than 0.01 g: none below 75°, peaking at 4.93 m/s from 76.5°. At
// 100 Hz the floor is therefore 5 m/s; it scales with dt.
//
// Energy. Driven ramps speed toward a target at no more than `accel`. Free roll is an energy balance over
// the tick's travel T, exact for gravity at any step: ½(v1² - v0²) = a T = -g Δy_com - losses, with
// Δy_com = rise T + h Δup_y from the rotation the step produces, and v1 = 2 T / dt - v0. Coulomb rolling
// loss is friction · g · |felt force across the track| at the heart per metre; mass cancels. Drag is
// drag · v0 v1 / mass per metre, a second-order stand-in for v² that keeps the balance quadratic in T;
// mass appears nowhere else. Each loss adds to the quadratic's coefficients, so a zero coefficient adds a
// signed zero and the march is byte-identical to one with the loss absent. Free roll ends `stalled` at the
// tick whose step would carry v through zero; nothing clamps.
//
// Mass effect measured at friction 0.03 and drag 2e-5: a 10 s coast down 30° from 5 m/s ends at
// 51.4850 m/s at 500 kg and 51.4854 m/s at 50,000 kg, Δ 3.9e-4 m/s. At these coefficients mass is negligible.

import { type Quat, rotate, type Vec3 } from "../path/path";
import { type Input, type State, step, writeTick } from "./integrator";
import {
    type EndReason,
    feltForces,
    type RideConstants,
    readTrajectory,
    TICK_FLOATS,
    type Trajectory,
    TRAJECTORY_VERSION,
} from "./trajectory";

export interface History {
    rate: number;
    constants: RideConstants;
    /** f64 state of every emitted tick; the last is the tick about to step. */
    states: readonly State[];
    /** `inputs[i]` took `states[i]` to `states[i + 1]`. */
    inputs: readonly Input[];
}

export type ShapeIntent =
    | { kind: "rates"; omega: Vec3 }
    /** Felt g at the COM along local +Y and +X, and the roll lane in rad/s. */
    | { kind: "forces"; normal: number; lateral: number; roll: number };

export type EnergyIntent = { kind: "driven"; target: number; accel: number } | { kind: "free" };

export interface Intent {
    shape: ShapeIntent;
    energy: EnergyIntent;
}

export type Refusal = Exclude<EndReason, "complete">;
export type Policy = (history: History, intent: Intent) => Input | Refusal;

/** |v| in m/s below which the force closure is unsatisfiable at 100 Hz; see the header. */
export const FORCE_FLOOR = 5;

const last = (history: History): State => history.states[history.states.length - 1];
const conjugate = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

export function forces(
    history: History,
    intent: Extract<ShapeIntent, { kind: "forces" }>,
    floor: number,
): Vec3 | "unsatisfiable" {
    const { g, heartToCom: h } = history.constants;
    const { speed: v, rotation } = last(history);
    if (!(Math.abs(v) >= floor)) return "unsatisfiable";
    const lift = rotate(conjugate(rotation), [0, g, 0]);
    const wz = -intent.roll;
    const c = g * intent.normal - lift[1] + h * wz * wz;
    const disc = v * v - 4 * h * c;
    if (!(disc >= 0)) return "unsatisfiable";
    const pitch = (2 * c) / (v + Math.sign(v) * Math.sqrt(disc));
    const across = v - h * pitch;
    if (!(across * v > 0)) return "unsatisfiable";
    return [pitch, (lift[0] - g * intent.lateral) / across, intent.roll];
}

export function driven(history: History, intent: Extract<EnergyIntent, { kind: "driven" }>): number {
    const gap = intent.target - last(history).speed;
    return Math.sign(gap) * Math.min(intent.accel, Math.abs(gap) * history.rate);
}

/** A dissipation term: coefficients added to T² and T in the free-roll balance, given the sign of travel. */
export type Loss = (history: History, omega: Vec3, sign: number) => readonly [number, number];

export const coulomb: Loss = (history, omega, sign) => {
    const { friction, g } = history.constants;
    const felt = feltForces({ ...last(history), omega, a: 0 }, history.constants);
    return [0, sign * friction * g * Math.hypot(felt.normal, felt.lateral)];
};

export const drag: Loss = (history, _omega, sign) => {
    const k = history.constants.drag / history.constants.mass;
    const v0 = last(history).speed;
    return [2 * k * Math.abs(v0) * history.rate, -sign * k * v0 * v0];
};

export const LOSSES: readonly Loss[] = [coulomb, drag];

export function freeRoll(history: History, omega: Vec3, losses: readonly Loss[]): number | "stalled" {
    const { g, heartToCom: h } = history.constants;
    const { rate } = history;
    const state = last(history);
    const probe = step({ position: [0, 0, 0], rotation: state.rotation, speed: 1, distance: 0 }, { omega, a: 0 }, 1 / rate);
    const rise = probe.position[1] * rate;
    const offset = h * (rotate(probe.rotation, [0, 1, 0])[1] - rotate(state.rotation, [0, 1, 0])[1]);
    const v0 = state.speed;
    const sign = v0 !== 0 ? Math.sign(v0) : -Math.sign(rise);
    if (sign === 0) return "stalled";
    let A = 2 * rate * rate;
    let B = g * rise - 2 * v0 * rate;
    for (const loss of losses) {
        const [dA, dB] = loss(history, omega, sign);
        A += dA;
        B += dB;
    }
    const C = g * offset;
    const disc = B * B - 4 * A * C;
    if (!(disc >= 0)) return "stalled";
    const travel = -(B + (B >= 0 ? 1 : -1) * Math.sqrt(disc)) / (2 * A);
    const v1 = 2 * travel * rate - v0;
    if (!(v1 * sign > 0)) return "stalled";
    return (v1 - v0) * rate;
}

export function policyWith(losses: readonly Loss[] = LOSSES, floor = FORCE_FLOOR): Policy {
    return (history, intent) => {
        const { shape, energy } = intent;
        const omega = shape.kind === "rates" ? shape.omega : forces(history, shape, floor);
        if (typeof omega === "string") return omega;
        const a = energy.kind === "driven" ? driven(history, energy) : freeRoll(history, omega, losses);
        if (typeof a === "string") return a;
        return { omega, a };
    };
}

export const policy: Policy = policyWith();

const REST: Input = { omega: [0, 0, 0], a: 0 };

/**
 * March `intents` from `initial` through `compose` until the authored end or an end reason. Tick layout is
 * `march`'s; the end tick is the one the policy refused, and a march refused at tick 0 carries no input.
 */
export function run(
    initial: State,
    intents: readonly Intent[],
    rate: number,
    constants: RideConstants,
    compose: Policy = policy,
): { trajectory: Trajectory; history: History } {
    if (intents.length === 0) throw new Error("run intents: expected at least one intent");
    const states: State[] = [initial];
    const inputs: Input[] = [];
    const history: History = { rate, constants, states, inputs };
    let endReason: EndReason = "complete";
    for (const intent of intents) {
        const input = compose(history, intent);
        if (typeof input === "string") {
            endReason = input;
            break;
        }
        inputs.push(input);
        states.push(step(states[states.length - 1], input, 1 / rate));
    }
    const count = states.length;
    const ticks = new Float32Array(count * TICK_FLOATS);
    for (let i = 0; i < count; i++) writeTick(ticks, i, states[i], inputs[Math.max(i - 1, 0)] ?? REST);
    const trajectory = readTrajectory({
        header: { version: TRAJECTORY_VERSION, count, rate, endReason, endTick: count - 1, constants },
        ticks,
    });
    return { trajectory, history };
}
