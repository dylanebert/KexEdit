import { DEFAULT_SPACING } from "./resample";
import { CHUNK, createRide } from "./execution";
import { type Intent, run } from "./policies";
import type { State as MotionState } from "./integrator";
import type { RideConstants } from "./trajectory";

/** Plain motion input: one intent per authored tick, an initial state and physical constants.
 * Rate is ticks per second; optional spacing is the derived path's sample spacing.
 */
export interface RideSource {
    length: number;
    intents: readonly Intent[];
    initial: MotionState;
    rate: number;
    constants: RideConstants;
    spacing?: number;
}
/** Scene-free motion entry, shared by headless consumers and world attachment in `src/ride.ts`.
 * Evaluates sequential intents and publishes the last-good trajectory and resampled path in
 * caller-owned shared execution memory. No world, playback or presentation is initialized.
 * Returns the execution handle, policy trajectory, structured refusal (if any), and authored
 * tick length (not the solved prefix length). Stalled/unsatisfiable tails remain unsolved.
 * Throws for invalid authored length/rate or invalid lower-level motion/publication inputs.
 * With no solved rows, returns the initial-only trajectory and refusal without an execution handle.
 */
export function evaluateRide(source: RideSource) {
    if (!Number.isInteger(source.length) || source.length < 1 || source.intents.length !== source.length)
        throw new Error("ride source: expected one intent per authored tick and a positive integer length");
    if (!(source.rate > 0 && Number.isFinite(source.rate))) throw new Error("ride source: expected finite positive rate");
    const { trajectory, history, refusal } = run(source.initial, source.intents, source.rate, source.constants);
    if (history.inputs.length === 0) return { ride: undefined, trajectory, refusal, length: source.length };
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

