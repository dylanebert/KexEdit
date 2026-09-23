// Re-marching a sampled trajectory as a ride: its start state and the input table that reproduces it.

import type { Input, State } from "./integrator";
import { tickAt, type Trajectory } from "./trajectory";

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
