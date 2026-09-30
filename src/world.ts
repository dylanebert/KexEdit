import {
    AmbientLight,
    Camera,
    DepthPrepass,
    DirectionalLight,
    Glaze,
    Orbit,
    type Plugin,
    StandardRenderer,
    Tonemap,
    Transform,
} from "@dylanebert/shallot";
import { Grid } from "@dylanebert/shallot-grid";
import { PathFixture, PathView } from "./path/view";

export const ViewWorld: Plugin = {
    name: "ViewWorld",
    initialize(world) {
        const ambient = world.create();
        world.add(ambient, AmbientLight, { color: 0xd0dcec });
        const sun = world.create();
        world.add(sun, DirectionalLight, {
            direction: [-0.4, -1, -0.55, 0],
            color: 0xfff4e0,
            intensity: 1.1,
        });
        const grid = world.create();
        world.add(grid, Grid);
        const path = world.create();
        world.add(path, PathView, { fixture: PathFixture.Ride });
        const camera = world.create();
        world.add(camera, Camera, { clearColor: 0x171a1b, far: 10000 });
        world.add(camera, StandardRenderer);
        world.add(camera, DepthPrepass);
        world.add(camera, Glaze, { tonemap: Tonemap.None });
        world.add(camera, Transform);
        world.add(camera, Orbit, { distance: 6, yaw: 0.6, pitch: 0.35 });
    },
};
