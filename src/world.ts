import {
    AlphaMode, Camera, DirectionalLight, GlobalAmbientLight, lookAtRotation,
    Materials, MeshInstance, MeshMaterial, type Plugin, StandardMaterial, StandardRenderer,
    Transform, type World,
} from "@dylanebert/shallot";
import { Gizmo, GizmoAsset, Orbit, OrbitPlugin, registerGizmo } from "@dylanebert/shallot/extras";
import { Grid, GridPlugin } from "@dylanebert/shallot-grid";
import { PathGeometry, PathPlugin, pathGizmo, TrainAppearance } from "./path/view";
import { createRideEntity, readRide, Train } from "./trajectory/ride";
import { RIDE_CONSTANTS, RIDE_INTENTS, RIDE_INTENTS_STALLED, RIDE_RATE, RIDE_START } from "./trajectory/ride.fixture";

export const EditorScene = { create: () => ({ camera: -1, ride: -1, train: -1, path: -1, grid: -1 }) };

function gizmo(world: World, asset: GizmoAsset): number {
    const eid = world.create();
    world.add(eid, Gizmo, { handle: registerGizmo(world, asset), width: 2 });
    world.add(eid, Transform);
    return eid;
}

/** The retained editor scene: integrated motion, frame ticks, a box train and an orbit camera. */
export function editorWorld(stalled = false): Plugin {
    return {
        name: "KexEditView", dependencies: [PathPlugin, OrbitPlugin, GridPlugin],
        initialize(world) {
            const scene = world.resource(EditorScene);
            const ambient = world.resource(GlobalAmbientLight);
            ambient.color = 0xd8e4ff;
            ambient.brightness = 380;
            const sun = world.create();
            world.add(sun, Transform, { rotation: lookAtRotation(0, 0, 0, 1, -2, -0.35) });
            world.add(sun, DirectionalLight, { color: 0xffe8cc, illuminance: 6000 });
            world.storage(DirectionalLight).shadowMapsEnabled.set(sun, 1);
            const intents = stalled ? RIDE_INTENTS_STALLED : RIDE_INTENTS;
            scene.ride = createRideEntity(world, {
                length: intents.length, intents, initial: RIDE_START, rate: RIDE_RATE, constants: RIDE_CONSTANTS,
            });
            const published = readRide(world, scene.ride).ride.path();
            const asset = pathGizmo(published.path);
            scene.path = gizmo(world, asset);
            world.resource(PathGeometry).set(scene.ride, { asset, generation: published.generation });
            scene.grid = world.create();
            world.add(scene.grid, Grid);
            const materials = world.resource(Materials);
            const appearance = world.resource(TrainAppearance);
            appearance.normal = materials.add(StandardMaterial({ baseColor: [0.72, 0.4, 0.05, 1], perceptualRoughness: 0.38 }));
            appearance.held = materials.add(StandardMaterial({ baseColor: [0.72, 0.4, 0.05, 0.34], perceptualRoughness: 0.38 }), { alphaMode: AlphaMode.Blend });
            scene.train = world.create();
            world.add(scene.train, Train, { ride: scene.ride, offset: 0 });
            world.add(scene.train, Transform, { scale: [0.6, 0.4, 1.6] });
            world.add(scene.train, MeshInstance);
            world.add(scene.train, MeshMaterial, appearance.normal);
            scene.camera = world.create();
            world.add(scene.camera, Camera, { clearColor: 0x171a1b, far: 10000 });
            world.add(scene.camera, StandardRenderer);
            world.add(scene.camera, Transform);
            world.add(scene.camera, Orbit, { distance: 6, yaw: 0.6, pitch: 0.35 });
        },
    };
}
