import { check } from "@dylanebert/shallot/harness/check";
import { type Curve, frameQuat, rotate, type Vec3 } from "../path/path";
import { helixCurve } from "../path/helix.fixture";
import { straightCurve } from "../path/straight.fixture";
import { constants, HELIX_C, HELIX_R, helix, RATE, SPEED, TURN_R, turnCurve } from "./fixtures.fixture";
import { type Input, march, type State, step } from "./integrator";
import { TICK_FLOATS, TICK_LANES, tickAt } from "./trajectory";

const EXACT = 1e-9;
const HELIX_K2 = HELIX_R * HELIX_R + HELIX_C * HELIX_C;

const gap = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const start = (curve: Curve, speed: number): State => ({
    position: curve.position(0),
    rotation: frameQuat(curve.forward(0), curve.up(0)),
    speed,
    distance: 0,
});

/** Step `input` along `curve` for `steps` ticks; `arclength(t)` is the closed-form distance at time t. */
function worstGap(curve: Curve, input: Input, speed: number, steps: number, arclength: (t: number) => number): string {
    const dt = 1 / RATE;
    let state = start(curve, speed);
    let worst = 0;
    let where = "";
    for (let i = 1; i <= steps; i++) {
        state = step(state, input, dt);
        const t = i * dt;
        const s = arclength(t);
        const errors: Record<string, number> = {
            position: gap(state.position, curve.position(s)),
            forward: gap(rotate(state.rotation, [0, 0, -1]), curve.forward(s)),
            up: gap(rotate(state.rotation, [0, 1, 0]), curve.up(s)),
            distance: Math.abs(state.distance - s),
            speed: Math.abs(state.speed - (speed + input.a * t)),
        };
        for (const [name, e] of Object.entries(errors)) {
            if (!(e <= worst)) {
                worst = e;
                where = `${name} ${e} at tick ${i}`;
            }
        }
    }
    return worst <= EXACT ? "" : where;
}

const ticksAlong = (curve: Curve) => Math.floor((curve.length * RATE) / SPEED);

check(
    "the constant-speed helix integrates exactly at 100 Hz",
    { claim: "the integrator step departs from the constant-ω helix at 100 Hz", budget: 250 },
    () => {
        const input: Input = { omega: [0, (SPEED * HELIX_R) / HELIX_K2, (SPEED * HELIX_C) / HELIX_K2], a: 0 };
        const steps = ticksAlong(helixCurve);
        if (steps < 400) throw new Error(`helix population is ${steps} ticks`);
        const where = worstGap(helixCurve, input, SPEED, steps, (t) => SPEED * t);
        if (where) throw new Error(`helix departs beyond ${EXACT}: ${where}`);
    },
);

check(
    "the constant-speed circle integrates exactly at 100 Hz",
    { claim: "the integrator step departs from the constant-yaw circle at 100 Hz", budget: 250 },
    () => {
        const steps = ticksAlong(turnCurve);
        const where = worstGap(turnCurve, { omega: [0, SPEED / TURN_R, 0], a: 0 }, SPEED, steps, (t) => SPEED * t);
        if (where) throw new Error(`circle departs beyond ${EXACT}: ${where}`);
    },
);

check(
    "straights at constant speed and constant acceleration integrate exactly",
    { claim: "the integrator step departs from a straight at constant v or constant a", budget: 250 },
    () => {
        const cruise = worstGap(straightCurve, { omega: [0, 0, 0], a: 0 }, SPEED, ticksAlong(straightCurve), (t) => SPEED * t);
        if (cruise) throw new Error(`constant-v straight departs beyond ${EXACT}: ${cruise}`);
        const v0 = 4;
        const a = 3;
        const launch = worstGap(straightCurve, { omega: [0, 0, 0], a }, v0, 250, (t) => v0 * t + 0.5 * a * t * t);
        if (launch) throw new Error(`constant-a straight departs beyond ${EXACT}: ${launch}`);
    },
);

check(
    "march stores each f64 step in f32 with the input that produced it",
    { claim: "march drops, rounds wrongly, or misattributes a stepped state or its input", budget: 250 },
    () => {
        const inputs: Input[] = Array.from({ length: 120 }, (_, i) => ({
            omega: [0.4 * Math.sin(i / 7), 0.9 * Math.cos(i / 11), -0.6 * Math.sin(i / 5)],
            a: 2 * Math.cos(i / 13),
        }));
        const initial = start(helixCurve, SPEED);
        const trajectory = march(initial, inputs, RATE, constants);
        const { header, ticks } = trajectory;
        if (header.count !== inputs.length + 1 || header.endReason !== "complete" || header.rate !== RATE) {
            throw new Error(`header ${JSON.stringify(header)}`);
        }
        let state = initial;
        for (let i = 0; i < header.count; i++) {
            if (i > 0) state = step(state, inputs[i - 1], 1 / RATE);
            const input = inputs[Math.max(i - 1, 0)];
            const expected = new Float32Array(TICK_FLOATS);
            expected.set(state.position, TICK_LANES.position);
            expected.set(state.rotation, TICK_LANES.rotation);
            expected[TICK_LANES.speed] = state.speed;
            expected[TICK_LANES.distance] = state.distance;
            expected.set(input.omega, TICK_LANES.omega);
            expected[TICK_LANES.a] = input.a;
            const stored = ticks.subarray(i * TICK_FLOATS, (i + 1) * TICK_FLOATS);
            for (let k = 0; k < TICK_FLOATS; k++) {
                if (!Object.is(stored[k], expected[k])) {
                    throw new Error(`tick ${i} float ${k}: stored ${stored[k]}, stepped ${expected[k]}`);
                }
            }
        }
    },
);

check(
    "the marched helix matches the closed-form helix trajectory",
    { claim: "the marched helix trajectory departs from the S1 closed-form helix fixture", budget: 250 },
    () => {
        const input: Input = { omega: [0, (SPEED * HELIX_R) / HELIX_K2, (SPEED * HELIX_C) / HELIX_K2], a: 0 };
        const marched = march(start(helixCurve, SPEED), new Array(helix.header.count - 1).fill(input), RATE, constants);
        if (marched.header.count !== helix.header.count) {
            throw new Error(`marched ${marched.header.count} ticks, fixture ${helix.header.count}`);
        }
        for (let i = 0; i < helix.header.count; i++) {
            const m = tickAt(marched, i);
            const f = tickAt(helix, i);
            const q = m.rotation;
            const sign = q[0] * f.rotation[0] + q[1] * f.rotation[1] + q[2] * f.rotation[2] + q[3] * f.rotation[3] < 0 ? -1 : 1;
            const errors = [
                gap(m.position, f.position),
                Math.hypot(...q.map((x, j) => sign * x - f.rotation[j])),
                Math.abs(m.speed - f.speed),
                Math.abs(m.distance - f.distance),
                gap(m.omega, f.omega),
                Math.abs(m.a - f.a),
            ];
            if (errors.some((e) => !(e <= 1e-4))) throw new Error(`tick ${i} errors ${errors.join(", ")}`);
        }
    },
);
