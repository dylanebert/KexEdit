import { createApp, MeshMaterial, Transform } from "@dylanebert/shallot";
import { expect, test } from "bun:test";
import { MotionPlugin } from "./playback";
import { TrainAppearance, TrainAppearanceSystem } from "./presentation";
import { createRideEntity, Train } from "./ride";
import { RIDE_CONSTANTS, RIDE_START } from "./trajectory/ride.fixture";

async function appearanceWorld() {
    const app = await createApp({ defaults: false, plugins: [MotionPlugin, {
        name: "CpuTrainAppearance", components: [MeshMaterial], systems: [TrainAppearanceSystem],
    }] });
    app.world.resource(TrainAppearance).normal = {
        type: 1, material: 7, alphaMode: 0, alphaCutoff: 0.5, cullMode: 0,
    };
    return app;
}

function ride(world: Awaited<ReturnType<typeof appearanceWorld>>["world"]) {
    return createRideEntity(world, { length: 1, rate: 100, constants: RIDE_CONSTANTS,
        initial: { ...RIDE_START, speed: 2 },
        intents: [{ shape: { kind: "rates", omega: [0, 0, 0] },
            energy: { kind: "driven", target: 2, accel: 1 } }],
    });
}

test("appearance skips a live ride reference without execution memory", async () => {
    const app = await appearanceWorld();
    try {
        const invalidRide = app.world.create(), train = app.world.create();
        app.world.add(train, Train, { ride: invalidRide });
        app.world.add(train, Transform);
        app.world.add(train, MeshMaterial, { material: 3 });
        expect(() => app.world.step(0)).not.toThrow();
        expect(app.world.storage(MeshMaterial).material.get(train)).toBe(3);
    } finally { app.dispose(); }
});

test("appearance gives a placed train its configured material even without MeshMaterial", async () => {
    const app = await appearanceWorld();
    try {
        const train = app.world.create();
        app.world.add(train, Train, { ride: ride(app.world) });
        app.world.add(train, Transform);
        app.world.step(0);
        expect(app.world.has(train, MeshMaterial)).toBe(true);
        expect(app.world.storage(MeshMaterial).material.get(train)).toBe(7);
    } finally { app.dispose(); }
});

test("appearance leaves trains without Transform untouched", async () => {
    const app = await appearanceWorld();
    try {
        const train = app.world.create();
        app.world.add(train, Train, { ride: ride(app.world) });
        app.world.add(train, MeshMaterial, { material: 3 });
        app.world.step(0);
        expect(app.world.storage(MeshMaterial).material.get(train)).toBe(3);
    } finally { app.dispose(); }
});
