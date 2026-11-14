import { type Plugin, type System } from "@dylanebert/shallot";
import { drawLine, GizmoAsset, LinesPlugin } from "@dylanebert/shallot/extras";
import { poseAt, readPath, rotate, type Path } from "./path";
import { RideExecutions, RideHeader, RidePlugin } from "../ride";

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

export const PathGeometry = { create: () => new Map<number, { asset: GizmoAsset; generation: number }>() };
export const PathSyncSystem: System = {
    name: "KexEditPathSync", group: "simulation",
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
export const PathPlugin: Plugin = {
    name: "KexEditPath", dependencies: [RidePlugin, LinesPlugin], systems: [PathSyncSystem],
};
