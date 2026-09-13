// The trajectory contract: the integrator's output and the resampler's input.
//
// A trajectory is a CPU header and a tick stream. Tick `i` is the state at time `i / rate` together
// with the integrator input that produced it, so felt forces and roll are pure reads and every tick
// carries its cause. Felt forces are not stored.
//
// Frame law is the path's, for every signed quantity: right-handed, -Z forward along the ride, +Y up
// through the rider's head, +X to the rider's right; `rotation` is a unit quaternion (x, y, z, w)
// rotating the local frame into world. The integrated point is the heart. `omega` is the body angular
// rate in rad/s as (pitch about +X, yaw about +Y, roll about -Z): positive pitch lifts the nose,
// positive yaw turns it left, positive roll banks the right side down. `speed` is signed m/s,
// `distance` is signed m, and `a` is the speed derivative in m/s². No referent's sign survives.
//
// `w` and `reserved` are zero. The stride is read from the schema; a second hand-authored stride is
// layout drift. `omega` is a three-float array rather than a vec3f so it packs at the lane after
// `distance` instead of the next vec3 alignment.

import * as d from "typegpu/data";
import { type Curve, frameQuat, type Quat, rotate, UNIT_TOLERANCE, type Vec3 } from "../path/path";

export const Tick = d.struct({
    position: d.vec3f,
    w: d.f32,
    rotation: d.vec4f,
    speed: d.f32,
    distance: d.f32,
    omega: d.arrayOf(d.f32, 3),
    a: d.f32,
    reserved: d.vec2f,
});

export const TICK_BYTES = d.sizeOf(Tick);
export const TICK_FLOATS = TICK_BYTES / Float32Array.BYTES_PER_ELEMENT;

const floatOffset = (bytes: number) => bytes / Float32Array.BYTES_PER_ELEMENT;
export const TICK_LANES = {
    position: floatOffset(d.memoryLayoutOf(Tick, (t) => t.position).offset),
    w: floatOffset(d.memoryLayoutOf(Tick, (t) => t.w).offset),
    rotation: floatOffset(d.memoryLayoutOf(Tick, (t) => t.rotation).offset),
    speed: floatOffset(d.memoryLayoutOf(Tick, (t) => t.speed).offset),
    distance: floatOffset(d.memoryLayoutOf(Tick, (t) => t.distance).offset),
    omega: floatOffset(d.memoryLayoutOf(Tick, (t) => t.omega).offset),
    a: floatOffset(d.memoryLayoutOf(Tick, (t) => t.a).offset),
    reserved: floatOffset(d.memoryLayoutOf(Tick, (t) => t.reserved).offset),
} as const;

export type Lane = keyof typeof TICK_LANES;

/** Float widths of each lane, keyed as `TICK_LANES`; the contract test checks them against the schema. */
export const LANE_WIDTHS: Record<Lane, number> = {
    position: 3,
    w: 1,
    rotation: 4,
    speed: 1,
    distance: 1,
    omega: 3,
    a: 1,
    reserved: 2,
};

/** The lane holding float `k` of a tick. */
export function laneOf(k: number): Lane {
    for (const lane of Object.keys(TICK_LANES) as Lane[]) {
        if (k >= TICK_LANES[lane] && k < TICK_LANES[lane] + LANE_WIDTHS[lane]) return lane;
    }
    throw new Error(`trajectory lane: float ${k} is outside the tick`);
}

export const TRAJECTORY_VERSION = 1;

export const END_REASONS = ["complete", "stalled", "unsatisfiable"] as const;
export type EndReason = (typeof END_REASONS)[number];

/** Ride constants the policies read. The integrator reads none of them. */
export interface RideConstants {
    /** Gravitational acceleration, m/s², > 0. */
    g: number;
    /** Heart to centre of mass along local +Y, m. Negative puts the COM below the heart. */
    heartToCom: number;
    /** Train mass, kg, > 0. Only drag reads it. */
    mass: number;
    /** Coulomb rolling loss coefficient, >= 0. */
    friction: number;
    /** Quadratic drag coefficient, >= 0. */
    drag: number;
}

export interface TrajectoryHeader {
    version: number;
    count: number;
    /** Ticks per second. */
    rate: number;
    endReason: EndReason;
    /** Index of the last emitted tick; `count === endTick + 1`. */
    endTick: number;
    constants: RideConstants;
}

export interface Trajectory {
    header: TrajectoryHeader;
    ticks: Float32Array;
}

const refuse = (field: string, message: string): never => {
    throw new Error(`trajectory ${field}: ${message}`);
};

/** Validate a trajectory before any consumer reads it. Refusals name the field or lane. */
export function readTrajectory(trajectory: Trajectory): Trajectory {
    const { header, ticks } = trajectory;
    if (header.version !== TRAJECTORY_VERSION) {
        refuse("version", `expected ${TRAJECTORY_VERSION}, got ${header.version}`);
    }
    if (!Number.isInteger(header.count) || header.count < 1) {
        refuse("count", `expected a positive integer, got ${header.count}`);
    }
    if (!(header.rate > 0 && Number.isFinite(header.rate))) {
        refuse("rate", `expected a finite rate > 0, got ${header.rate}`);
    }
    if (!(END_REASONS as readonly string[]).includes(header.endReason)) {
        refuse("endReason", `expected one of ${END_REASONS.join(", ")}, got ${header.endReason}`);
    }
    if (header.endTick !== header.count - 1) {
        refuse("endTick", `expected the last emitted tick ${header.count - 1}, got ${header.endTick}`);
    }
    const c = header.constants;
    if (!(c.g > 0 && Number.isFinite(c.g))) refuse("g", `expected finite > 0, got ${c.g}`);
    if (!Number.isFinite(c.heartToCom)) refuse("heartToCom", `expected finite, got ${c.heartToCom}`);
    if (!(c.mass > 0 && Number.isFinite(c.mass))) refuse("mass", `expected finite > 0, got ${c.mass}`);
    if (!(c.friction >= 0 && Number.isFinite(c.friction))) {
        refuse("friction", `expected finite >= 0, got ${c.friction}`);
    }
    if (!(c.drag >= 0 && Number.isFinite(c.drag))) refuse("drag", `expected finite >= 0, got ${c.drag}`);
    if (!(ticks instanceof Float32Array)) refuse("ticks", "expected a Float32Array");
    if (ticks.length !== header.count * TICK_FLOATS) {
        refuse("ticks", `expected ${header.count * TICK_FLOATS} floats for count ${header.count}, got ${ticks.length}`);
    }
    for (let i = 0; i < header.count; i++) {
        const o = i * TICK_FLOATS;
        for (let k = 0; k < TICK_FLOATS; k++) {
            if (!Number.isFinite(ticks[o + k])) refuse(laneOf(k), `tick ${i} float ${k} is ${ticks[o + k]}`);
        }
        const r = o + TICK_LANES.rotation;
        const norm = Math.hypot(ticks[r], ticks[r + 1], ticks[r + 2], ticks[r + 3]);
        if (!(Math.abs(norm - 1) <= UNIT_TOLERANCE)) {
            refuse("rotation", `tick ${i} quaternion norm ${norm} is not unit`);
        }
        if (ticks[o + TICK_LANES.w] !== 0) refuse("w", `tick ${i} reserved w is ${ticks[o + TICK_LANES.w]}`);
        const z = o + TICK_LANES.reserved;
        if (ticks[z] !== 0 || ticks[z + 1] !== 0) {
            refuse("reserved", `tick ${i} reserved lanes are ${ticks[z]}, ${ticks[z + 1]}`);
        }
    }
    return trajectory;
}

export interface TickState {
    position: Vec3;
    rotation: Quat;
    speed: number;
    distance: number;
    omega: Vec3;
    a: number;
}

export function tickAt(trajectory: Trajectory, i: number): TickState {
    const f = trajectory.ticks;
    const o = i * TICK_FLOATS;
    const p = o + TICK_LANES.position;
    const r = o + TICK_LANES.rotation;
    const w = o + TICK_LANES.omega;
    return {
        position: [f[p], f[p + 1], f[p + 2]],
        rotation: [f[r], f[r + 1], f[r + 2], f[r + 3]],
        speed: f[o + TICK_LANES.speed],
        distance: f[o + TICK_LANES.distance],
        omega: [f[w], f[w + 1], f[w + 2]],
        a: f[o + TICK_LANES.a],
    };
}

const conjugate = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

/**
 * Felt specific force at the heart (body acceleration minus gravity) in the rider frame, in units of
 * g, with the sign the math gives: each component is along its local axis, no rider-side flip.
 */
export interface FeltForces {
    /** Along local +X (right). A flat left turn reads negative. */
    lateral: number;
    /** Along local +Y (head); 1 at rest on level track. */
    normal: number;
    /** Along forward (-Z); a forward-accelerating train reads positive. */
    longitudinal: number;
}

/**
 * With body velocity (0, 0, -v) and body rate (ωx, ωy, ωz) where ωz = -roll, the body-frame
 * acceleration is (0, 0, -a) + ω × (0, 0, -v) = (-v ωy, v ωx, -a); roll rate does not enter.
 */
export function feltForces(tick: TickState, constants: RideConstants): FeltForces {
    const { speed: v, omega, a, rotation } = tick;
    const lift = rotate(conjugate(rotation), [0, constants.g, 0]);
    return {
        lateral: (-v * omega[1] + lift[0]) / constants.g,
        normal: (v * omega[0] + lift[1]) / constants.g,
        longitudinal: (a - lift[2]) / constants.g,
    };
}

/**
 * Bank about forward (-Z), radians in (-π, π]: zero when local +X is horizontal and +Y points up;
 * positive lowers the right side, the sense of `omega`'s roll lane. Undefined when forward is vertical.
 */
export function roll(tick: TickState): number {
    const right = rotate(tick.rotation, [1, 0, 0]);
    const up = rotate(tick.rotation, [0, 1, 0]);
    return Math.atan2(-right[1], up[1]);
}

/** A closed-form motion: a curve driven at constant speed with its body rate at arclength `s`. */
export interface Motion {
    curve: Curve;
    speed: number;
    omega(s: number): Vec3;
}

/** Sample a constant-speed motion at `i / rate` for every tick inside the curve's length. */
export function sampleMotion(motion: Motion, rate: number, constants: RideConstants): Trajectory {
    const { curve, speed } = motion;
    const count = Math.floor((curve.length * rate) / speed) + 1;
    const ticks = new Float32Array(count * TICK_FLOATS);
    for (let i = 0; i < count; i++) {
        const s = (i * speed) / rate;
        const o = i * TICK_FLOATS;
        ticks.set(curve.position(s), o + TICK_LANES.position);
        ticks.set(frameQuat(curve.forward(s), curve.up(s)), o + TICK_LANES.rotation);
        ticks[o + TICK_LANES.speed] = speed;
        ticks[o + TICK_LANES.distance] = s;
        ticks.set(motion.omega(s), o + TICK_LANES.omega);
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
