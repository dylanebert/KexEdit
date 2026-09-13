// Convergence of the integrator against an independent f64 oracle: classical RK4 on the continuous
// kinematic ODE (ṗ = v rotate(q, -Z), q̇ = ½ q ⊗ ω, v̇ = a, ṡ = v) with quaternion components as plain
// state, at a substep far below the tick. The march reads the same smooth intent sampled at each tick's
// midpoint. Constant-ω intent must match to 1e-9; varying intent must converge at order 2 across 100,
// 200 and 400 Hz, the rate held by `strategy/kexedit.md`.

import { check } from "@dylanebert/shallot/harness/check";
import { frameQuat, rotate, type Vec3 } from "../path/path";
import { HELIX_C, HELIX_R, SPEED } from "./fixtures.fixture";
import { type Input, type State, step } from "./integrator";

type Intent = (t: number) => Input;
type Y = number[];

function derivative(y: Y, input: Input): Y {
    const [, , , qx, qy, qz, qw, v] = y;
    const n = Math.hypot(qx, qy, qz, qw);
    const f = rotate([qx / n, qy / n, qz / n, qw / n], [0, 0, -1]);
    const [wx, wy, wz] = [input.omega[0], input.omega[1], -input.omega[2]];
    return [
        v * f[0],
        v * f[1],
        v * f[2],
        0.5 * (qw * wx + qy * wz - qz * wy),
        0.5 * (qw * wy + qz * wx - qx * wz),
        0.5 * (qw * wz + qx * wy - qy * wx),
        -0.5 * (qx * wx + qy * wy + qz * wz),
        input.a,
        v,
    ];
}

const add = (y: Y, k: Y, h: number) => y.map((x, i) => x + h * k[i]);

function oracle(initial: State, intent: Intent, duration: number, substep: number): State {
    const n = Math.round(duration / substep);
    const h = duration / n;
    let y: Y = [...initial.position, ...initial.rotation, initial.speed, initial.distance];
    for (let i = 0; i < n; i++) {
        const t = i * h;
        const k1 = derivative(y, intent(t));
        const k2 = derivative(add(y, k1, h / 2), intent(t + h / 2));
        const k3 = derivative(add(y, k2, h / 2), intent(t + h / 2));
        const k4 = derivative(add(y, k3, h), intent(t + h));
        y = y.map((x, j) => x + (h / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
    }
    const q = Math.hypot(y[3], y[4], y[5], y[6]);
    return {
        position: [y[0], y[1], y[2]],
        rotation: [y[3] / q, y[4] / q, y[5] / q, y[6] / q],
        speed: y[7],
        distance: y[8],
    };
}

function marchAt(initial: State, intent: Intent, duration: number, rate: number): State {
    let state = initial;
    const ticks = Math.round(duration * rate);
    for (let i = 0; i < ticks; i++) state = step(state, intent((i + 0.5) / rate), 1 / rate);
    return state;
}

const gap = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Worst of position, forward, up, speed and distance error. */
function error(a: State, b: State): number {
    return Math.max(
        gap(a.position, b.position),
        gap(rotate(a.rotation, [0, 0, -1]), rotate(b.rotation, [0, 0, -1])),
        gap(rotate(a.rotation, [0, 1, 0]), rotate(b.rotation, [0, 1, 0])),
        Math.abs(a.speed - b.speed),
        Math.abs(a.distance - b.distance),
    );
}

const DURATION = 2;
const SUBSTEP = 1e-4;

check(
    "the march converges to the RK4 oracle: exact on constant ω, order 2 on varying intent",
    { claim: "kexedit-integrator-convergence", budget: 250 },
    () => {
        const initial: State = {
            position: [3, 1, -2],
            rotation: frameQuat([0, 0, -1], [0, 1, 0]),
            speed: 10,
            distance: 0,
        };
        const k2 = HELIX_R * HELIX_R + HELIX_C * HELIX_C;
        const helixInput: Input = { omega: [0, (SPEED * HELIX_R) / k2, (SPEED * HELIX_C) / k2], a: 0 };
        const cruise = { ...initial, speed: SPEED };
        const exact = error(marchAt(cruise, () => helixInput, DURATION, 100), oracle(cruise, () => helixInput, DURATION, SUBSTEP));
        console.log(`constant-ω helix at 100 Hz: error ${exact.toExponential(3)}`);
        if (!(exact <= 1e-9)) throw new Error(`constant-ω helix error ${exact} exceeds 1e-9`);

        const intent: Intent = (t) => ({
            omega: [0.3 * Math.sin(2 * t), 1.2 * Math.cos(1.5 * t), 0.8 * Math.sin(3 * t + 0.4)],
            a: 2 * Math.cos(t),
        });
        const truth = oracle(initial, intent, DURATION, SUBSTEP);
        const errors = [100, 200, 400].map((rate) => error(marchAt(initial, intent, DURATION, rate), truth));
        const orders = [Math.log2(errors[0] / errors[1]), Math.log2(errors[1] / errors[2])];
        console.log(
            `varying intent errors ${errors.map((e) => e.toExponential(3)).join(", ")} at 100/200/400 Hz; orders ${orders.map((o) => o.toFixed(3)).join(", ")}`,
        );
        if (!(errors[2] > 1e-9)) throw new Error(`finest error ${errors[2]} is inside the oracle's own resolution`);
        for (const order of orders) {
            if (!(order >= 1.8 && order <= 2.2)) throw new Error(`observed order ${order} is not 2`);
        }
    },
);
