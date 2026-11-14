import { DEFAULT_SPACING } from "./resample";
import { CHUNK, createRide } from "./execution";
import { type Intent, run } from "./policies";
import type { State as MotionState } from "./integrator";
import type { RideConstants } from "./trajectory";

export interface RideSource {
    length: number;
    intents: readonly Intent[];
    initial: MotionState;
    rate: number;
    constants: RideConstants;
    spacing?: number;
}
/** Evaluate sequential motion and publish its last-good prefix in shared execution memory.
 * Tick-zero refusals retain the execution API's empty-input error; no path can be published.
 */
export function evaluateRide(source: RideSource) {
    if (!Number.isInteger(source.length) || source.length < 1 || source.intents.length !== source.length)
        throw new Error("ride source: expected one intent per authored tick and a positive integer length");
    if (!(source.rate > 0 && Number.isFinite(source.rate))) throw new Error("ride source: expected finite positive rate");
    const { trajectory, history, refusal } = run(source.initial, source.intents, source.rate, source.constants);
    const spacing = source.spacing ?? DEFAULT_SPACING;
    const length = Math.abs(history.states[history.states.length - 1].distance);
    const ride = createRide({
        ticks: Math.ceil((source.length + 1) / CHUNK),
        poses: Math.max(1, Math.ceil((length / spacing + 2) / CHUNK)),
        rate: source.rate, constants: source.constants, spacing,
    });
    ride.setInitial(source.initial);
    ride.setInputs(history.inputs, trajectory.header.endReason, trajectory.header.endTick);
    ride.pass();
    return { ride, trajectory, refusal, length: source.length };
}

