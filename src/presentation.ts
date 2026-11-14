import { MeshMaterial, type Plugin, type System } from "@dylanebert/shallot";
import type { MaterialHandle } from "@dylanebert/shallot/standard/rendering";
import { MotionPlugin, TrainSystem } from "./playback";
import { readRide, Train } from "./ride";
import { PathPlugin } from "./path/view";

export const TrainAppearance = { create: () => ({
    normal: undefined as MaterialHandle | undefined,
    held: undefined as MaterialHandle | undefined,
}) };

const TrainAppearanceSystem: System = {
    name: "KexEditTrainAppearance", group: "simulation", after: [TrainSystem],
    update(world) {
        const trains = world.storage(Train);
        const handles = world.resource(TrainAppearance);
        for (const eid of world.query([Train, MeshMaterial])) {
            const rideEid = trains.ride.get(eid);
            if (!world.exists(rideEid)) continue;
            const ride = readRide(world, rideEid);
            const held = ride.header.endReason !== "complete" && ride.transport.playhead > ride.header.endTick;
            const material = held ? handles.held : handles.normal;
            if (material) {
                const fields = world.storage(MeshMaterial);
                if (fields.material.get(eid) !== material.material || fields.type.get(eid) !== material.type)
                    world.add(eid, MeshMaterial, material);
            }
        }
    },
};

/** Stopgap box appearance and retained path drawing, separate from playback. */
export const PresentationPlugin: Plugin = {
    name: "KexEditPresentation", dependencies: [MotionPlugin, PathPlugin], systems: [TrainAppearanceSystem],
};
