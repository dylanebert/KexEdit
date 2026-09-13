import { check } from "@dylanebert/shallot/harness/check";
import { frameQuat, rotate, type Vec3 } from "../path/path";
import { constants, RATE } from "./fixtures.fixture";
import type { Input, State } from "./integrator";
import { FORCE_FLOOR, type History, type Intent, LOSSES, policyWith, run } from "./policies";
import { roll, type RideConstants } from "./trajectory";

const G = constants.g;
const deg = (d: number) => (d * Math.PI) / 180;

/** Heart at the origin heading along -Z pitched up by `pitch`, banked right-side-down by `bank`. */
function start(speed: number, pitch = 0, bank = 0): State {
    const forward: Vec3 = [0, Math.sin(pitch), -Math.cos(pitch)];
    const level: Vec3 = [0, Math.cos(pitch), Math.sin(pitch)];
    const right: Vec3 = [1, 0, 0];
    const up: Vec3 = [
        Math.cos(bank) * level[0] + Math.sin(bank) * right[0],
        Math.cos(bank) * level[1] + Math.sin(bank) * right[1],
        Math.cos(bank) * level[2] + Math.sin(bank) * right[2],
    ];
    return { position: [0, 0, 0], rotation: frameQuat(forward, up), speed, distance: 0 };
}

const cruise = (speed: number) => ({ kind: "driven", target: speed, accel: 1 }) as const;

check(
    "a vertical loop at authored COM normal g closes on its analytic radius",
    { claim: "the force closure or its heart-to-COM term departs from the analytic constant-speed loop", budget: 250 },
    () => {
        const v = 15;
        const R = 12;
        const h = constants.heartToCom;
        const w = v / R;
        const ticks = Math.floor((2 * Math.PI * R * RATE) / v);
        // the COM rides radius R - h, so its centripetal specific force is w²(R - h); gravity adds cos(pitch)
        const intents: Intent[] = Array.from({ length: ticks }, (_, i) => ({
            shape: { kind: "forces", normal: (w * w * (R - h)) / G + Math.cos((w * i) / RATE), lateral: 0, roll: 0 },
            energy: cruise(v),
        }));
        const { trajectory, history } = run(start(v), intents, RATE, constants);
        if (trajectory.header.endReason !== "complete") throw new Error(`loop ended ${trajectory.header.endReason}`);
        history.states.forEach((s, i) => {
            const r = Math.hypot(s.position[1] - R, s.position[2]);
            if (!(Math.abs(r - R) <= 1e-6 && Math.abs(s.position[0]) <= 1e-9)) {
                throw new Error(`tick ${i} radius ${r}, x ${s.position[0]}`);
            }
        });
    },
);

check(
    "a banked turn at zero COM lateral g is the analytic level circle",
    { claim: "the force closure's lateral or heart-to-COM term departs from the analytic coordinated turn", budget: 250 },
    () => {
        const bank = deg(40);
        const R = 30;
        const h = constants.heartToCom;
        // the COM sits h sin(bank) toward the centre; zero lateral means tan(bank) = W² (R - h sin bank) / g
        const comRadius = R - h * Math.sin(bank);
        const W2 = (G * Math.tan(bank)) / comRadius;
        const v = Math.sqrt(W2) * R;
        const normal = Math.hypot(G, W2 * comRadius) / G;
        const ticks = Math.floor((Math.PI * R * RATE) / v);
        const intents: Intent[] = new Array(ticks).fill({
            shape: { kind: "forces", normal, lateral: 0, roll: 0 },
            energy: cruise(v),
        });
        const { trajectory, history } = run(start(v, 0, bank), intents, RATE, constants);
        if (trajectory.header.endReason !== "complete") throw new Error(`turn ended ${trajectory.header.endReason}`);
        history.states.forEach((s, i) => {
            // a right-side-down bank turns right, about the centre at +X
            const r = Math.hypot(s.position[0] - R, s.position[2]);
            const b = roll({ ...s, omega: [0, 0, 0], a: 0 });
            if (!(Math.abs(r - R) <= 1e-6 && Math.abs(s.position[1]) <= 1e-9 && Math.abs(b - bank) <= 1e-9)) {
                throw new Error(`tick ${i} radius ${r}, height ${s.position[1]}, bank ${b}`);
            }
        });
    },
);

const coast = (ticks: number): Intent[] => new Array(ticks).fill({ shape: { kind: "rates", omega: [0, 0, 0] }, energy: { kind: "free" } });

check(
    "a coast down a known slope follows the energy balance",
    { claim: "free roll departs from gravity, Coulomb loss or drag on a constant slope", budget: 250 },
    () => {
        const slope = deg(-30);
        const v0 = 5;
        const along = G * (Math.sin(-slope) - constants.friction * Math.cos(slope));
        const frictionOnly: RideConstants = { ...constants, drag: 0 };
        const exact = run(start(v0, slope), coast(400), RATE, frictionOnly).history;
        exact.states.forEach((s, i) => {
            const t = i / RATE;
            const d = v0 * t + 0.5 * along * t * t;
            const errors = [s.speed - (v0 + along * t), s.distance - d, s.position[1] + d * Math.sin(-slope)];
            if (errors.some((e) => !(Math.abs(e) <= 1e-9 * Math.max(1, d)))) throw new Error(`tick ${i} errors ${errors}`);
        });
        // drag k = drag / mass: dv/dt = along - k v², v = vt tanh(atanh(v0 / vt) + k vt t)
        const dragged: RideConstants = { ...constants, drag: 50 };
        const k = dragged.drag / dragged.mass;
        const vt = Math.sqrt(along / k);
        // drag's v0 v1 stand-in is second order, so the 4 s error must quarter per doubling of rate
        const errors = [RATE, 2 * RATE, 4 * RATE].map((rate) => {
            const { states } = run(start(v0, slope), coast(4 * rate), rate, dragged).history;
            return Math.max(...states.map((s, i) => Math.abs(s.speed - vt * Math.tanh(Math.atanh(v0 / vt) + (k * vt * i) / rate))));
        });
        const orders = [Math.log2(errors[0] / errors[1]), Math.log2(errors[1] / errors[2])];
        if (!(errors[2] > 1e-9 && orders.every((p) => p >= 1.8 && p <= 2.2))) {
            throw new Error(`drag errors ${errors.join(", ")} give orders ${orders.join(", ")}`);
        }
    },
);

const identical = (a: History, b: History): string => {
    if (a.states.length !== b.states.length) return `lengths ${a.states.length}, ${b.states.length}`;
    for (let i = 0; i < a.states.length; i++) {
        const x = a.states[i];
        const y = b.states[i];
        const fx = [...x.position, ...x.rotation, x.speed, x.distance];
        const fy = [...y.position, ...y.rotation, y.speed, y.distance];
        if (!fx.every((f, j) => Object.is(f, fy[j]))) return `state ${i}`;
    }
    for (let i = 0; i < a.inputs.length; i++) {
        const x: Input = a.inputs[i];
        const y: Input = b.inputs[i];
        if (!Object.is(x.a, y.a) || !x.omega.every((f, j) => Object.is(f, y.omega[j]))) return `input ${i}`;
    }
    return "";
};

/** A drop over a crest and into a dive, so rotation, COM offset and felt forces all move the balance. */
const ride: Intent[] = Array.from({ length: 900 }, (_, i) => ({
    shape: { kind: "rates", omega: [i < 300 ? -0.15 : i < 600 ? 0.1 : 0, 0.05, i < 450 ? 0.3 : -0.3] },
    energy: { kind: "free" },
}));

check(
    "lossless free roll conserves speed against COM height over a rotating ride",
    { claim: "free roll drifts from the energy balance or drops the heart-to-COM height", budget: 250 },
    () => {
        const lossless: RideConstants = { ...constants, friction: 0, drag: 0 };
        const h = lossless.heartToCom;
        const { states } = run(start(8, deg(10)), ride, RATE, lossless).history;
        if (states.length !== ride.length + 1) throw new Error(`ride population is ${states.length} ticks`);
        const energy = (s: State) => 0.5 * s.speed * s.speed + G * (s.position[1] + h * rotate(s.rotation, [0, 1, 0])[1]);
        const e0 = energy(states[0]);
        states.forEach((s, i) => {
            if (!(Math.abs(energy(s) - e0) <= 1e-9 * e0)) throw new Error(`tick ${i} energy ${energy(s)}, start ${e0}`);
        });
    },
);

check(
    "a driven ramp reaches its target at the authored rate and holds it, backwards from rest",
    { claim: "the driven policy overshoots, undershoots or mis-signs its ramp", budget: 250 },
    () => {
        const intents: Intent[] = new Array(400).fill({
            shape: { kind: "rates", omega: [0, 0.2, 0] },
            energy: { kind: "driven", target: -8, accel: 4 },
        });
        const { states } = run(start(0, deg(20)), intents, RATE, constants).history;
        states.forEach((s, i) => {
            const v = Math.max(-8, (-4 * i) / RATE);
            if (!(Math.abs(s.speed - v) <= 1e-12)) throw new Error(`tick ${i} speed ${s.speed}, ramp ${v}`);
        });
    },
);

check(
    "zero dissipation coefficients march byte-identical to dissipation absent",
    { claim: "a zero friction or drag coefficient perturbs the free-roll march", budget: 250 },
    () => {
        const zero: RideConstants = { ...constants, friction: 0, drag: 0 };
        const lossy = run(start(8, deg(10)), ride, RATE, zero, policyWith(LOSSES)).history;
        const absent = run(start(8, deg(10)), ride, RATE, zero, policyWith([])).history;
        if (lossy.states.length !== ride.length + 1) throw new Error(`ride population is ${lossy.states.length} ticks`);
        const where = identical(lossy, absent);
        if (where) throw new Error(`zero-coefficient march differs from dissipation absent at ${where}`);
    },
);

check(
    "mass moves free roll only through drag, measured at the prototype's coefficients",
    { claim: "mass reaches free roll outside drag, or drag's mass effect vanishes or inverts", budget: 250 },
    () => {
        const at = (mass: number, drag: number) =>
            run(start(5, deg(-30)), coast(1000), RATE, { ...constants, friction: 0.03, drag, mass }).history;
        const where = identical(at(500, 0), at(50000, 0));
        if (where) throw new Error(`mass changed a drag-free march at ${where}`);
        const light = at(500, 2e-5);
        const heavy = at(50000, 2e-5);
        const vLight = light.states[1000].speed;
        const vHeavy = heavy.states[1000].speed;
        console.log(`mass effect over a 10 s coast down 30° from 5 m/s: ${vLight} m/s at 500 kg, ${vHeavy} m/s at 50000 kg, Δ ${vHeavy - vLight}`);
        if (!(vHeavy > vLight)) throw new Error(`heavier train is not faster: ${vHeavy} vs ${vLight}`);
    },
);

check(
    "free roll ends stalled at the tick whose step would reverse",
    { claim: "free roll carries speed through zero or ends before it must", budget: 250 },
    () => {
        const { trajectory, history } = run(start(10, deg(60)), coast(400), RATE, { ...constants, drag: 0, heartToCom: 0 });
        const { header } = trajectory;
        const end = history.states[header.endTick];
        const decel = G * (Math.sin(deg(60)) + constants.friction * Math.cos(deg(60)));
        if (header.endReason !== "stalled") throw new Error(`climb ended ${header.endReason} at ${header.endTick}`);
        if (!(end.speed > 0 && end.speed - decel / RATE <= 0)) throw new Error(`stalled at speed ${end.speed}`);
        if (!history.states.every((s) => s.speed > 0)) throw new Error("an emitted speed is not positive");
    },
);

/** Authored normal minus the normal realized over each tick: midpoint speed times ωx plus the mean lift. */
const departures = (history: History, normal: number) =>
    history.inputs.map((input, i) => {
        const s0 = history.states[i];
        const s1 = history.states[i + 1];
        const lift = (rotate(s0.rotation, [0, 1, 0])[1] + rotate(s1.rotation, [0, 1, 0])[1]) / 2;
        const realized = (((s0.speed + s1.speed) / 2) * input.omega[0] + G * lift) / G;
        return { speed: Math.abs(s0.speed), departure: Math.abs(realized - normal) };
    });

check(
    "a force-held climb that runs out of speed ends unsatisfiable at the measured floor",
    { claim: "the force closure runs below its validity floor, or the floor is looser than its measurement", budget: 250 },
    () => {
        const held: RideConstants = { ...constants, heartToCom: 0 };
        const intents: Intent[] = new Array(400).fill({
            shape: { kind: "forces", normal: 0, lateral: 0, roll: 0 },
            energy: { kind: "free" },
        });
        const climb = start(15, deg(76.5));
        const { trajectory, history } = run(climb, intents, RATE, held);
        const { header } = trajectory;
        if (header.endReason !== "unsatisfiable") throw new Error(`climb ended ${header.endReason}`);
        const speeds = history.states.map((s) => Math.abs(s.speed));
        if (!(speeds[header.endTick] < FORCE_FLOOR && speeds.slice(0, -1).every((v) => v >= FORCE_FLOOR))) {
            throw new Error(`ended at speed ${speeds[header.endTick]} after ${speeds.slice(0, -1).at(-1)}`);
        }
        const worst = Math.max(...departures(history, 0).map((d) => d.departure));
        if (!(worst <= 0.01)) throw new Error(`above the floor a tick departs ${worst} g`);
        const looser = run(climb, intents, RATE, held, policyWith(LOSSES, FORCE_FLOOR - 0.5)).history;
        if (!departures(looser, 0).some((d) => d.departure > 0.01)) {
            throw new Error(`a floor of ${FORCE_FLOOR - 0.5} m/s still holds 0.01 g, so the floor is not the measurement`);
        }
    },
);
