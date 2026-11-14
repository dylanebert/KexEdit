import { type Plugin, type System, Transform, TransformPlugin } from "@dylanebert/shallot";
import { RideExecutions, readRide, RideHeader, RidePlugin, Train, Transport } from "./ride";
import { advance, placeAt } from "./trajectory/transport";

/** World-owned tick advancement; presentation and UI observation run after placement. */
export const TransportSystem: System = {
    name: "KexEditTransport", group: "simulation",
    update(world) {
        const transport = world.storage(Transport);
        for (const eid of world.query([RideHeader, Transport])) {
            const ride = readRide(world, eid);
            const next = advance(ride.transport, ride.header, world.time.deltaTime);
            transport.playhead.set(eid, next.playhead);
            transport.playing.set(eid, +next.playing);
        }
    },
};

/** Place at the discrete transport tick, holding the last good pose beyond a refusal. */
export const TrainSystem: System = {
    name: "KexEditTrain", group: "simulation", after: [TransportSystem],
    update(world) {
        const trains = world.storage(Train), transforms = world.storage(Transform);
        for (const eid of world.query([Train, Transform])) {
            const rideEid = trains.ride.get(eid);
            const record = world.resource(RideExecutions).get(rideEid);
            if (!record || !world.exists(rideEid)) continue;
            const ride = readRide(world, rideEid);
            const { position, rotation } = placeAt(record.ride.trajectory(), ride.transport.playhead, trains.offset.get(eid));
            transforms.translation.set(eid, ...position);
            transforms.rotation.set(eid, ...rotation);
        }
    },
};

export const MotionPlugin: Plugin = {
    name: "KexEditMotion", dependencies: [RidePlugin, TransformPlugin], systems: [TransportSystem, TrainSystem],
};
