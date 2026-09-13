import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { check } from "@dylanebert/shallot/harness/check";
import * as d from "typegpu/data";
import { type Curve, rotate, type Vec3 } from "../path/path";
import { helixCurve } from "../path/helix.fixture";
import { hillCurve } from "../path/hill.fixture";
import { straightCurve } from "../path/straight.fixture";
import {
    constants,
    corkscrew,
    corkscrewCurve,
    HELIX_C,
    HELIX_R,
    HILL_R,
    helix,
    hill,
    ROLL_RATE,
    SPEED,
    straight,
    TURN_R,
    turn,
    turnCurve,
} from "./fixtures.fixture";
import {
    feltForces,
    LANE_WIDTHS,
    readTrajectory,
    roll,
    TICK_BYTES,
    TICK_FLOATS,
    TICK_LANES,
    Tick,
    type TickState,
    type Trajectory,
    type TrajectoryHeader,
    TRAJECTORY_VERSION,
    tickAt,
} from "./trajectory";

const DIR = import.meta.dir;

check(
    "the tick stride and lanes are the schema's",
    { claim: "the trajectory tick stride or lane order drifts from its typegpu schema", budget: 250 },
    () => {
        if (d.sizeOf(Tick) !== 64) throw new Error(`Tick schema is ${d.sizeOf(Tick)} bytes`);
        if (TICK_BYTES !== d.sizeOf(Tick) || TICK_FLOATS !== 16) throw new Error(`stride ${TICK_BYTES}/${TICK_FLOATS}`);
        const order = ["position", "w", "rotation", "speed", "distance", "omega", "a", "reserved"] as const;
        let next = 0;
        for (const key of order) {
            const offset = d.memoryLayoutOf(Tick, (t) => t[key]).offset;
            if (TICK_LANES[key] * Float32Array.BYTES_PER_ELEMENT !== offset) {
                throw new Error(`lane ${key} disagrees with memoryLayoutOf`);
            }
            if (TICK_LANES[key] !== next) throw new Error(`lane ${key} at ${TICK_LANES[key]}, expected ${next}`);
            next += LANE_WIDTHS[key];
        }
        if (next !== TICK_FLOATS) throw new Error(`lanes cover ${next} of ${TICK_FLOATS} floats`);
        const sources = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
        if (!sources.includes("trajectory.ts")) throw new Error("trajectory.ts not scanned");
        for (const file of sources) {
            if (/\b64\b/.test(readFileSync(resolve(DIR, file), "utf8"))) {
                throw new Error(`hand-typed stride 64 in src/trajectory/${file}`);
            }
        }
    },
);

function refuses(label: string, field: string, run: () => unknown): void {
    let message: string | null = null;
    try {
        run();
    } catch (error) {
        message = (error as Error).message;
    }
    if (message === null) throw new Error(`${label}: readTrajectory accepted it`);
    if (!message.startsWith(`trajectory ${field}:`)) {
        throw new Error(`${label}: refusal "${message}" is not by field ${field}`);
    }
}

const withHeader = (h: Partial<TrajectoryHeader>): Trajectory => ({ ...helix, header: { ...helix.header, ...h } });
const withConstant = (c: Partial<TrajectoryHeader["constants"]>): Trajectory =>
    withHeader({ constants: { ...helix.header.constants, ...c } });
const withFloat = (tick: number, lane: number, value: number): Trajectory => {
    const ticks = helix.ticks.slice();
    ticks[tick * TICK_FLOATS + lane] = value;
    return { ...helix, ticks };
};

check(
    "readTrajectory refuses each malformed header field by name",
    { claim: "readTrajectory admits a trajectory with a malformed header field", budget: 250 },
    () => {
        readTrajectory(helix);
        const count = helix.header.count;
        const rows: [string, string, Trajectory][] = [
            ["version", "version", withHeader({ version: TRAJECTORY_VERSION + 1 })],
            ["fractional count", "count", withHeader({ count: 1.5 })],
            ["zero count", "count", withHeader({ count: 0, endTick: -1 })],
            ["zero rate", "rate", withHeader({ rate: 0 })],
            ["infinite rate", "rate", withHeader({ rate: Infinity })],
            ["end reason", "endReason", withHeader({ endReason: "clamped" as TrajectoryHeader["endReason"] })],
            ["end tick before the last tick", "endTick", withHeader({ endTick: count - 2 })],
            ["count past the end tick", "endTick", withHeader({ endTick: count })],
            ["g", "g", withConstant({ g: 0 })],
            ["heart to COM", "heartToCom", withConstant({ heartToCom: Number.NaN })],
            ["mass", "mass", withConstant({ mass: 0 })],
            ["friction", "friction", withConstant({ friction: -0.01 })],
            ["drag", "drag", withConstant({ drag: -1e-6 })],
        ];
        for (const [label, field, t] of rows) refuses(label, field, () => readTrajectory(t));
    },
);

check(
    "readTrajectory refuses each broken lane invariant by name",
    { claim: "readTrajectory admits a tick stream that breaks a lane invariant", budget: 250 },
    () => {
        const last = helix.header.count - 1;
        const floats = Array.from(helix.ticks);
        const skewed = helix.ticks.slice();
        skewed[last * TICK_FLOATS + TICK_LANES.rotation + 3] *= 1.01;
        const rows: [string, string, Trajectory][] = [
            ["short stream", "ticks", { ...helix, ticks: helix.ticks.subarray(TICK_FLOATS) }],
            ["Float64Array", "ticks", { ...helix, ticks: new Float64Array(floats) as unknown as Float32Array }],
            ["non-unit rotation", "rotation", { ...helix, ticks: skewed }],
            ["reserved w", "w", withFloat(last, TICK_LANES.w, 1)],
            ["reserved lane", "reserved", withFloat(last, TICK_LANES.reserved + 1, 1)],
            ["infinite position", "position", withFloat(last, TICK_LANES.position + 2, -Infinity)],
            ["NaN speed", "speed", withFloat(last, TICK_LANES.speed, Number.NaN)],
            ["NaN distance", "distance", withFloat(last, TICK_LANES.distance, Number.NaN)],
            ["infinite omega", "omega", withFloat(0, TICK_LANES.omega + 2, Infinity)],
            ["NaN a", "a", withFloat(last, TICK_LANES.a, Number.NaN)],
        ];
        for (const [label, field, t] of rows) refuses(label, field, () => readTrajectory(t));
    },
);

const near = (label: string, got: number, want: number, tol: number) => {
    if (!(Math.abs(got - want) <= tol)) throw new Error(`${label}: got ${got}, want ${want}`);
};

// ω in the stored sense from the stream's own rotations: body rate 2·vec(q_i⁻¹ q_{i+1}) · rate over
// one tick, with the third component negated because roll is about -Z.
function streamRate(t: Trajectory, i: number): Vec3 {
    const [x, y, z, w] = tickAt(t, i).rotation;
    const [px, py, pz, pw] = tickAt(t, i + 1).rotation;
    const k = 2 * t.header.rate;
    return [
        k * (w * px - pw * x - (y * pz - z * py)),
        k * (w * py - pw * y - (z * px - x * pz)),
        -k * (w * pz - pw * z - (x * py - y * px)),
    ];
}

const FIXTURES: [string, Trajectory, Curve][] = [
    ["straight", straight, straightCurve],
    ["hill", hill, hillCurve],
    ["helix", helix, helixCurve],
    ["turn", turn, turnCurve],
    ["corkscrew", corkscrew, corkscrewCurve],
];

check(
    "fixture ticks match their closed-form curves and their own rotation stream",
    { claim: "a trajectory fixture's stored state or ω disagrees with its curve or its rotations", budget: 250 },
    () => {
        for (const [name, t, curve] of FIXTURES) {
            const count = t.header.count;
            if (count < 3) throw new Error(`${name} has ${count} ticks`);
            for (const i of [0, 1, Math.floor(count / 2), count - 2]) {
                const tick = tickAt(t, i);
                const s = (i * SPEED) / t.header.rate;
                if (s > curve.length) throw new Error(`${name} tick ${i} past the curve`);
                near(`${name} ${i} distance`, tick.distance, s, 1e-4);
                near(`${name} ${i} speed`, tick.speed, SPEED, 0);
                near(`${name} ${i} a`, tick.a, 0, 0);
                const p = curve.position(s);
                for (const k of [0, 1, 2]) near(`${name} ${i} position ${k}`, tick.position[k], p[k], 1e-4);
                const rate = streamRate(t, i);
                for (const k of [0, 1, 2]) near(`${name} ${i} omega ${k}`, tick.omega[k], rate[k], 2e-3);
            }
        }
    },
);

const forwardOf = (tick: TickState) => rotate(tick.rotation, [0, 0, -1]);
const rightOf = (tick: TickState) => rotate(tick.rotation, [1, 0, 0]);

check(
    "each signed lane and read has Shallot's sign, fixed by geometry",
    { claim: "an ω component, lateral, normal or roll carries a referent's sign instead of Shallot's frame", budget: 250 },
    () => {
        const mid = (t: Trajectory) => Math.floor(t.header.count / 2);
        const pair = (t: Trajectory) => [tickAt(t, mid(t)), tickAt(t, mid(t) + 1)] as const;
        // pitch: the hill's nose drops, so pitch about +X is negative
        const [h0, h1] = pair(hill);
        if (!(forwardOf(h1)[1] < forwardOf(h0)[1])) throw new Error("hill fixture nose does not drop");
        if (!(h0.omega[0] < 0)) throw new Error(`hill pitch ${h0.omega[0]} is not negative for a dropping nose`);
        // yaw: the turn goes left toward -X, so yaw about +Y is positive
        const [t0, t1] = pair(turn);
        const [a, b] = [forwardOf(t0), forwardOf(t1)];
        if (!(a[2] * b[0] - a[0] * b[2] > 0)) throw new Error("turn fixture does not turn left about +Y");
        if (!(t0.omega[1] > 0)) throw new Error(`turn yaw ${t0.omega[1]} is not positive for a left turn`);
        // roll: the corkscrew lowers the right side, so roll about -Z and the roll read are positive
        const [c0, c1] = pair(corkscrew);
        if (!(rightOf(c1)[1] < rightOf(c0)[1])) throw new Error("corkscrew right side does not go down");
        if (!(c0.omega[2] > 0)) throw new Error(`corkscrew roll rate ${c0.omega[2]} is not positive`);
        if (!(roll(c1) > roll(c0) && roll(c0) > 0)) throw new Error(`corkscrew roll ${roll(c0)} -> ${roll(c1)}`);
        near("corkscrew roll", roll(c0), (mid(corkscrew) * ROLL_RATE) / corkscrew.header.rate, 1e-5);
        // lateral: a flat left turn's specific force points at the centre, -X
        near("turn lateral", feltForces(t0, constants).lateral, -(SPEED * SPEED) / (TURN_R * constants.g), 1e-5);
        near("turn normal", feltForces(t0, constants).normal, 1, 1e-5);
        // helix: turning left banked left side down, so roll is negative and roll rate about -Z positive
        const x = tickAt(helix, 40);
        near("helix roll", roll(x), -Math.PI / 2, 1e-5);
        if (!(x.omega[2] > 0)) throw new Error(`helix roll rate ${x.omega[2]} is not positive`);
    },
);

check(
    "feltForces and roll read the fixtures' closed forms",
    { claim: "feltForces or roll misread a tick's state and input", budget: 250 },
    () => {
        const g = constants.g;
        const K = Math.hypot(HELIX_R, HELIX_C);
        near("straight normal", feltForces(tickAt(straight, 5), constants).normal, 1, 1e-6);
        near("straight roll", roll(tickAt(straight, 5)), 0, 1e-6);
        // the crest sits between two ticks, where pitch is ±v / (2 · rate · R)
        const crest = tickAt(hill, Math.round(hill.header.count / 2) - 1);
        const felt = feltForces(crest, constants);
        near("hill crest normal", felt.normal, 1 - (SPEED * SPEED) / (HILL_R * g), 2e-3);
        near("hill crest lateral", felt.lateral, 0, 1e-6);
        near("hill crest longitudinal", felt.longitudinal, 0, SPEED / (2 * hill.header.rate * HILL_R) + 1e-3);
        const spiral = feltForces(tickAt(helix, 40), constants);
        near("helix lateral", spiral.lateral, HELIX_R / K, 1e-5);
        near("helix normal", spiral.normal, (SPEED * SPEED * HELIX_R) / (K * K * g), 1e-5);
        near("helix longitudinal", spiral.longitudinal, HELIX_C / K, 1e-5);
        const braking = { ...tickAt(straight, 0), a: -g / 2 };
        near("braking longitudinal", feltForces(braking, constants).longitudinal, -0.5, 1e-6);
    },
);
