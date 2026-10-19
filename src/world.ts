import {
    AlphaMode, Camera, DirectionalLight, GlobalAmbientLight, lookAtRotation,
    Materials, MeshInstance, MeshMaterial, type Plugin, StandardMaterial, StandardRenderer,
    Tonemapping, TonemappingMethod, Transform, unpackColor, type World,
} from "@dylanebert/shallot";
import { Gizmo, GizmoAsset, Orbit, OrbitPlugin, registerGizmo } from "@dylanebert/shallot/extras";
import { GroundGrid, GridPlugin } from "./grid";
import { PathGeometry, PathPlugin, pathGizmo, PATH_BYTES, TrainAppearance } from "./path/view";
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
            ambient.color = 0xd0dcec;
            ambient.brightness = 380;
            const sun = world.create();
            world.add(sun, Transform, { rotation: lookAtRotation(0, 0, 0, -0.4, -1, -0.55) });
            world.add(sun, DirectionalLight, { color: 0xfff4e0, illuminance: 6000 });
            const intents = stalled ? RIDE_INTENTS_STALLED : RIDE_INTENTS;
            scene.ride = createRideEntity(world, {
                length: intents.length, intents, initial: RIDE_START, rate: RIDE_RATE, constants: RIDE_CONSTANTS,
            });
            const published = readRide(world, scene.ride).ride.path();
            const asset = pathGizmo(published.path);
            scene.path = gizmo(world, asset);
            world.resource(PathGeometry).set(scene.ride, { asset, generation: published.generation });
            scene.grid = world.create();
            world.add(scene.grid, Transform, { translation: [0, -0.002, 0], scale: [20000, 0.002, 20000] });
            world.add(scene.grid, MeshInstance);
            world.add(scene.grid, MeshMaterial, world.resource(GroundGrid).add({ color: [0.045, 0.045, 0.045] }, { alphaMode: AlphaMode.Blend }));
            const { r, g, b } = unpackColor(PATH_BYTES.chord);
            const materials = world.resource(Materials);
            const appearance = world.resource(TrainAppearance);
            appearance.normal = materials.add(StandardMaterial({ baseColor: [r, g, b, 1], perceptualRoughness: 0.8 }));
            appearance.held = materials.add(StandardMaterial({ baseColor: [r, g, b, 0.34], perceptualRoughness: 0.8 }), { alphaMode: AlphaMode.Blend });
            scene.train = world.create();
            world.add(scene.train, Train, { ride: scene.ride, offset: 0 });
            world.add(scene.train, Transform, { scale: [0.6, 0.4, 1.6] });
            world.add(scene.train, MeshInstance);
            world.add(scene.train, MeshMaterial, appearance.normal);
            scene.camera = world.create();
            world.add(scene.camera, Camera, { clearColor: 0x171a1b, far: 10000 });
            world.add(scene.camera, StandardRenderer);
            world.add(scene.camera, Tonemapping, { method: TonemappingMethod.None });
            world.add(scene.camera, Transform);
            world.add(scene.camera, Orbit, { distance: 6, yaw: 0.6, pitch: 0.35 });
        },
    };
}
