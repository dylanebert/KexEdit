// The train on the clock: pure reads the view uses to place a train from a trajectory at scheduler
// time, and the intent table that re-marches a sampled trajectory as a ride.
//
// The clock tick is the last tick at or before `elapsed` at the header rate, wrapped over the
// trajectory so the train runs round. The placed pose is that tick's heart position and rotation,
// read as stored; nothing interpolates between ticks.

import type { Quat, Vec3 } from "../path/path";
import type { Input, State } from "./integrator";
import { tickAt, type Trajectory } from "./trajectory";

// scheduler time accumulates frame deltas, so k / rate can land a hair under k
const CLOCK_EPSILON = 1e-6;

/** The tick the clock names at `elapsed` seconds, wrapped over the trajectory's count. */
export function clockTick(trajectory: Trajectory, elapsed: number): number {
    const { rate, count } = trajectory.header;
    const tick = Math.floor(elapsed * rate + CLOCK_EPSILON);
    return ((tick % count) + count) % count;
}

export interface TrainPose {
    tick: number;
    position: Vec3;
    rotation: Quat;
}

/** The pose the view places the train at for scheduler time `elapsed`. */
export function placeTrain(trajectory: Trajectory, elapsed: number): TrainPose {
    const tick = clockTick(trajectory, elapsed);
    const { position, rotation } = tickAt(trajectory, tick);
    return { tick, position, rotation };
}

/** Tick 0's state: the start a re-march of `trajectory` begins from. */
export function initialState(trajectory: Trajectory): State {
    const { position, rotation, speed, distance } = tickAt(trajectory, 0);
    return { position, rotation, speed, distance };
}

/** The input table whose march reproduces `trajectory`: row `t` is the input stored on tick `t + 1`. */
export function intentTable(trajectory: Trajectory): Input[] {
    return Array.from({ length: trajectory.header.count - 1 }, (_, t) => {
        const { omega, a } = tickAt(trajectory, t + 1);
        return { omega, a };
    });
}
