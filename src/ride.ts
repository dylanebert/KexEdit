import { component, entity, f32, type Plugin, type World, u8, u32 } from "@dylanebert/shallot";
import type { Ride as ExecutionRide } from "./trajectory/execution";
import type { Refusal } from "./trajectory/policies";
import { evaluateRide, type RideSource } from "./trajectory/ride";
import type { TransportValue } from "./trajectory/transport";
import { END_REASONS, type EndReason, type Trajectory } from "./trajectory/trajectory";

/** Authored tick length and derived last-good prefix, never a length inferred from geometry. */
export const RideHeader = component("KexEditRide", {
    length: u32, count: u32, rate: f32, endReason: u8, endTick: u32, generation: u32,
});
/** Playback is measured in authored ticks; rate 1 means real time. */
export const Transport = component("KexEditTransport", {
    playhead: f32, playing: u8, rate: f32, loop: u8,
}, { defaults: () => ({ playhead: 0, playing: 0, rate: 1, loop: 1 }) });
export const Train = component("KexEditTrain", { ride: entity, offset: f32 });

/** Execution memory and refusals belong to the world, including when eids coincide across apps. */
export const RideExecutions = { create(world: World) {
    const records = new Map<number, { ride: ExecutionRide; refusal?: Refusal }>();
    world.onDispose(() => records.clear());
    return records;
} };
export const RidePlugin: Plugin = { name: "KexEditRide", components: [RideHeader, Transport, Train] };

export interface RideHeaderValue {
    length: number; count: number; rate: number; endReason: EndReason; endTick: number; generation: number;
}

export interface RideEntity {
    eid: number; header: RideHeaderValue; transport: TransportValue;
    ride: ExecutionRide; trajectory: Trajectory; refusal?: Refusal;
}

/** March named motion intents and attach their execution and last-good prefix to an entity. */
export function createRideEntity(world: World, source: RideSource): number {
    const { ride, trajectory, refusal } = evaluateRide(source);
    if (!ride) throw new Error("ride inputs: expected at least one row");
    const eid = world.create();
    world.add(eid, RideHeader, {
        length: source.length, count: trajectory.header.count, rate: source.rate,
        endReason: END_REASONS.indexOf(trajectory.header.endReason), endTick: trajectory.header.endTick,
        generation: ride.generation(),
    });
    world.add(eid, Transport);
    world.resource(RideExecutions).set(eid, { ride, refusal });
    return eid;
}

export function readRide(world: World, eid: number): RideEntity {
    if (!world.exists(eid) || !world.has(eid, RideHeader) || !world.has(eid, Transport))
        throw new Error(`ride ${eid}: expected a live ride with transport`);
    const record = world.resource(RideExecutions).get(eid);
    if (!record) throw new Error(`ride ${eid}: no execution memory`);
    const h = world.storage(RideHeader), t = world.storage(Transport);
    const endReason = END_REASONS[h.endReason.get(eid)];
    if (!endReason) throw new Error(`ride ${eid}: unknown end reason`);
    return {
        eid, header: { length: h.length.get(eid), count: h.count.get(eid), rate: h.rate.get(eid),
            endReason, endTick: h.endTick.get(eid), generation: h.generation.get(eid) },
        transport: { playhead: t.playhead.get(eid), playing: t.playing.get(eid) !== 0,
            rate: t.rate.get(eid), loop: t.loop.get(eid) !== 0 },
        ride: record.ride, trajectory: record.ride.trajectory(), refusal: record.refusal,
    };
}
