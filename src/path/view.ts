import {
    MeshMaterial, type Plugin, type System, Transform, TransformPlugin,
} from "@dylanebert/shallot";
import type { MaterialHandle } from "@dylanebert/shallot/standard/rendering";
import { drawLine, GizmoAsset, LinesPlugin } from "@dylanebert/shallot/extras";
import { poseAt, readPath, rotate, type Path } from "./path";
import { RideExecutions, readRide, RideHeader, RidePlugin, Train, Transport } from "../trajectory/ride";
import { advance, placeAt } from "../trajectory/transport";
import { TransportObservers } from "../transport";

export const PATH_BYTES = { chord: 0xebdbb2, lateral: 0xcc241d, normal: 0x6b9d65 } as const;

/** Retained orientation ticks and chords, expressed through the engine's world-owned line renderer. */
export function pathGizmo(source: Path, asset = new GizmoAsset()): GizmoAsset {
    const path = readPath(source);
    asset.segments.count = 0;
    for (let i = 0; i < path.header.count; i++) {
        const { position, rotation } = poseAt(path, i);
        if (i + 1 < path.header.count) drawLine(asset, position, poseAt(path, i + 1).position, PATH_BYTES.chord);
        for (const [axis, color] of [[[1, 0, 0], PATH_BYTES.lateral], [[0, 1, 0], PATH_BYTES.normal]] as const) {
            const direction = rotate(rotation, axis);
            const tip = [
                position[0] + direction[0] * path.header.spacing,
                position[1] + direction[1] * path.header.spacing,
                position[2] + direction[2] * path.header.spacing,
            ];
            drawLine(asset, position, tip, color);
        }
    }
    return asset;
}

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
        for (const publish of world.resource(TransportObservers)) publish();
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
            const handles = world.resource(TrainAppearance);
            const held = ride.header.endReason !== "complete" && ride.transport.playhead > ride.header.endTick;
            const material = held ? handles.held : handles.normal;
            if (material) {
                const fields = world.storage(MeshMaterial);
                if (fields.material.get(eid) !== material.material || fields.type.get(eid) !== material.type) {
                    fields.type.set(eid, material.type);
                    fields.material.set(eid, material.material);
                }
            }
        }
    },
};
export const TrainAppearance = { create: () => ({
    normal: undefined as MaterialHandle | undefined,
    held: undefined as MaterialHandle | undefined,
}) };

export const PathGeometry = { create: () => new Map<number, { asset: GizmoAsset; generation: number }>() };
const PathSyncSystem: System = {
    name: "KexEditPathSync", group: "simulation", after: [TrainSystem],
    update(world) {
        for (const [eid, view] of world.resource(PathGeometry)) {
            const execution = world.resource(RideExecutions).get(eid);
            if (!execution || view.generation === execution.ride.generation()) continue;
            const published = execution.ride.path();
            pathGizmo(published.path, view.asset);
            view.generation = published.generation;
            world.storage(RideHeader).generation.set(eid, published.generation);
        }
    },
};
/** CPU transport and placement can be composed without a GPU. */
export const MotionPlugin: Plugin = {
    name: "KexEditMotion", dependencies: [RidePlugin, TransformPlugin], systems: [TransportSystem, TrainSystem],
};
export const PathPlugin: Plugin = {
    name: "KexEditPath", dependencies: [MotionPlugin, LinesPlugin], systems: [PathSyncSystem],
};
