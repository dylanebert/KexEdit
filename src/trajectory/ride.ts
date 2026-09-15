// Ride entity data: authored length and policy output are published once, while the execution memory stays
// in a side table. The length is authored data; the marched count and end state are derived from it in one
// direction and never inferred from the trajectory back into the header.

import { entity, f32, type State, sparse, u8, u32 } from "@dylanebert/shallot/ecs";
import { DEFAULT_SPACING } from "./resample";
import { CHUNK, createRide, type Ride as ExecutionRide } from "./execution";
import { type Intent, type Refusal, run } from "./policies";
import type { State as MotionState } from "./integrator";
import { END_REASONS, type EndReason, type RideConstants, type Trajectory } from "./trajectory";

/** Ride data attached to an entity. `endTick` is the last tick in the marched prefix. */
export const RideHeader = {
    length: sparse(u32),
    count: sparse(u32),
    rate: sparse(f32),
    endReason: sparse(u8),
    endTick: sparse(u32),
    generation: sparse(u32),
};

/** Playback state in authored ticks. Rates are unitless, with 1 meaning real time. */
export const Transport = {
    playhead: sparse(f32),
    playing: sparse(u8),
    rate: sparse(f32),
    loop: sparse(u8),
};

/** A train is an entity in the ride's simulation domain, offset in ticks from its playhead. */
export const Train = {
    ride: sparse(entity),
    offset: sparse(f32),
};

/** The execution memory owned by each ride entity, keyed like Shallot's `Views` side tables. */
export const rides = new Map<number, ExecutionRide>();
const refusals = new Map<number, Refusal>();

export interface RideSource {
    /** Authored intent-row count. This is the only source of the ride's length. */
    length: number;
    intents: readonly Intent[];
    initial: MotionState;
    rate: number;
    constants: RideConstants;
    spacing?: number;
}

export interface RideHeaderValue {
    length: number;
    count: number;
    rate: number;
    endReason: EndReason;
    endTick: number;
    generation: number;
}

export interface TransportValue {
    playhead: number;
    playing: boolean;
    rate: number;
    loop: boolean;
}

export interface RideEntity {
    eid: number;
    header: RideHeaderValue;
    transport: TransportValue;
    ride: ExecutionRide;
    trajectory: Trajectory;
    refusal?: Refusal;
}

const reasonCode = (reason: EndReason): number => END_REASONS.indexOf(reason);
const reasonFromCode = (code: number): EndReason => {
    const reason = END_REASONS[code];
    if (!reason) throw new Error(`ride header: unknown end reason code ${code}`);
    return reason;
};

function validateSource(source: RideSource): void {
    if (!Number.isInteger(source.length) || source.length < 1) {
        throw new Error(`ride source: length must be a positive integer, got ${source.length}`);
    }
    if (source.intents.length !== source.length) {
        throw new Error(`ride source: ${source.intents.length} intent rows for length ${source.length}`);
    }
    if (!(source.rate > 0 && Number.isFinite(source.rate))) {
        throw new Error(`ride source: rate must be finite and > 0, got ${source.rate}`);
    }
}

/** March an authored ride on the calling thread and attach its data to a new ECS entity. */
export function createRideEntity(state: State, source: RideSource): number {
    validateSource(source);
    const marched = run(source.initial, source.intents, source.rate, source.constants);
    const { trajectory, history, refusal } = marched;
    const spacing = source.spacing ?? DEFAULT_SPACING;
    const length = Math.abs(history.states[history.states.length - 1].distance);
    const ride = createRide({
        ticks: Math.ceil((source.length + 1) / CHUNK),
        poses: Math.max(1, Math.ceil((length / spacing + 2) / CHUNK)),
        rate: source.rate,
        constants: source.constants,
        spacing,
    });
    ride.setInitial(source.initial);
    ride.setInputs(history.inputs, trajectory.header.endReason, trajectory.header.endTick);
    ride.pass();

    const eid = state.create();
    state.add(eid, RideHeader);
    state.add(eid, Transport);
    RideHeader.length.set(eid, source.length);
    RideHeader.count.set(eid, trajectory.header.count);
    RideHeader.rate.set(eid, source.rate);
    RideHeader.endReason.set(eid, reasonCode(trajectory.header.endReason));
    RideHeader.endTick.set(eid, trajectory.header.endTick);
    RideHeader.generation.set(eid, 0);
    Transport.playhead.set(eid, 0);
    Transport.playing.set(eid, 0);
    Transport.rate.set(eid, 1);
    // Reserved compatibility data: playback is unconditionally looping in the timeline surface.
    Transport.loop.set(eid, 1);
    rides.set(eid, ride);
    if (refusal) refusals.set(eid, refusal);
    return eid;
}

/** Read the entity components and its side-table execution memory as one ride record. */
export function readRide(state: State, eid: number): RideEntity {
    if (!state.exists(eid) || !state.has(eid, RideHeader) || !state.has(eid, Transport)) {
        throw new Error(`ride ${eid}: expected a live entity with RideHeader and Transport`);
    }
    const ride = rides.get(eid);
    if (!ride) throw new Error(`ride ${eid}: no execution memory`);
    const endReason = reasonFromCode(RideHeader.endReason.get(eid));
    const trajectory = ride.trajectory();
    return {
        eid,
        header: {
            length: RideHeader.length.get(eid),
            count: RideHeader.count.get(eid),
            rate: RideHeader.rate.get(eid),
            endReason,
            endTick: RideHeader.endTick.get(eid),
            generation: RideHeader.generation.get(eid),
        },
        transport: {
            playhead: Transport.playhead.get(eid),
            playing: Transport.playing.get(eid) !== 0,
            rate: Transport.rate.get(eid),
            loop: Transport.loop.get(eid) !== 0,
        },
        ride,
        trajectory,
        refusal: refusals.get(eid),
    };
}
