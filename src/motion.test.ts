import { createApp, Transform } from "@dylanebert/shallot";
import { expect, test } from "bun:test";
import { MotionPlugin } from "./path/view";
import { createTransport } from "./transport";
import { createRideEntity, readRide, RideExecutions, Train } from "./trajectory/ride";
import { RIDE_CONSTANTS, RIDE_INTENTS_STALLED, RIDE_RATE, RIDE_START } from "./trajectory/ride.fixture";

async function straightEditor() {
    const transport = createTransport();
    let ride = -1, train = -1;
    const app = await createApp({ defaults: false, plugins: [MotionPlugin, {
        name: "AnalyticStraight", dependencies: [MotionPlugin], initialize(world) {
            ride = createRideEntity(world, { length: 100, rate: 100, constants: RIDE_CONSTANTS,
                initial: { ...RIDE_START, speed: 2 },
                intents: Array.from({ length: 100 }, () => ({ shape: { kind: "rates", omega: [0, 0, 0] },
                    energy: { kind: "driven", target: 2, accel: 1 } })),
            });
            train = world.create();
            world.add(train, Train, { ride, offset: 0 });
            world.add(train, Transform);
            transport.bind(world);
        },
    }] });
    return { ...app, ride, train, transport };
}

test("transport steps authored ticks and places a constant-speed straight analytically without a GPU", async () => {
    const app = await straightEditor();
    try {
        expect(app.world.gpuIfAvailable).toBeUndefined();
        app.transport.scrub(25);
        app.world.step(0);
        expect(Array.from(app.world.storage(Transform).translation.read(app.train, new Float32Array(4)))).toEqual([0, 0, -0.5, 0]);
        app.transport.setPlaying(true);
        app.transport.setRate(2);
        app.world.step(0.05);
        expect(app.transport.snapshot()?.playhead).toBeCloseTo(35, 4);
        expect(app.world.storage(Transform).translation.z.get(app.train)).toBeCloseTo(-0.7, 5);
        app.transport.setPlaying(false);
        app.world.step(0.05);
        expect(app.transport.snapshot()?.playhead).toBeCloseTo(35, 4);
        app.transport.scrub(99);
        app.transport.setPlaying(true);
        app.world.step(0.02);
        expect(app.transport.snapshot()?.playhead).toBeCloseTo(3, 4);
        expect(() => app.transport.setRate(-1)).toThrow();
    } finally { app.dispose(); }
});

test("coexisting editors isolate coincident eids, execution memory, transport and disposal", async () => {
    const a = await straightEditor(), b = await straightEditor();
    try {
        expect(a.ride).toBe(b.ride);
        expect(readRide(a.world, a.ride).ride.memory).not.toBe(readRide(b.world, b.ride).ride.memory);
        a.transport.scrub(30);
        expect(b.transport.snapshot()?.playhead).toBe(0);
        const records = a.world.resource(RideExecutions);
        a.dispose();
        expect(records.size).toBe(0);
        expect(a.transport.snapshot()).toBeNull();
        b.transport.scrub(60);
        b.world.step(0);
        expect(b.world.storage(Transform).translation.z.get(b.train)).toBeCloseTo(-1.2, 5);
        expect(b.transport.snapshot()?.playhead).toBe(60);
    } finally { a.dispose(); b.dispose(); }
});

test("a refused ride keeps its authored tail and holds the last good train pose", async () => {
    let ride = -1, train = -1;
    const transport = createTransport();
    const app = await createApp({ defaults: false, plugins: [MotionPlugin, {
        name: "RefusedRide", dependencies: [MotionPlugin], initialize(world) {
            ride = createRideEntity(world, { length: RIDE_INTENTS_STALLED.length, intents: RIDE_INTENTS_STALLED,
                initial: RIDE_START, rate: RIDE_RATE, constants: RIDE_CONSTANTS });
            train = world.create(); world.add(train, Train, { ride }); world.add(train, Transform);
            transport.bind(world);
        },
    }] });
    try {
        const record = readRide(app.world, ride);
        expect(record.header.endReason).toBe("stalled");
        expect(record.refusal?.lane).toBe("energy");
        transport.scrub(record.header.endTick); app.world.step(0);
        const last = app.world.storage(Transform).translation.read(train, new Float32Array(4));
        transport.scrub(record.header.length); app.world.step(0);
        expect(transport.snapshot()?.held).toBe(true);
        expect(app.world.storage(Transform).translation.read(train, new Float32Array(4))).toEqual(last);
        expect(transport.snapshot()?.length).toBe(RIDE_INTENTS_STALLED.length);
    } finally { app.dispose(); }
});
