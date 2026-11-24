import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { poseAt } from "../path/path";
import { evaluateRide, type RideSource } from "./ride";
import { tickAt } from "./trajectory";
import { run, type Intent } from "./policies";
import { createRide, CHUNK } from "./execution";
import { RIDE_CONSTANTS, RIDE_INTENTS, RIDE_INTENTS_STALLED, RIDE_RATE, RIDE_START } from "./ride.fixture";

const force: Intent = { shape: { kind: "forces", normal: 6, lateral: 0, roll: 0 }, energy: { kind: "free" } };
for (const [reason, intents, initial] of [
    ["complete", RIDE_INTENTS, RIDE_START],
    ["stalled", RIDE_INTENTS_STALLED, RIDE_START],
    ["unsatisfiable", new Array<Intent>(400).fill(force), { ...RIDE_START, speed: 15 }],
] as const) test(`scene-free ${reason} preserves policy and publication evidence`, () => {
    const source = { length: intents.length, intents, initial, rate: RIDE_RATE, constants: RIDE_CONSTANTS };
    const expected = run(initial, intents, RIDE_RATE, RIDE_CONSTANTS);
    const actual = evaluateRide(source);
    expect(actual.length).toBe(intents.length);
    expect(actual.refusal).toEqual(expected.refusal);
    expect(actual.trajectory).toEqual(expected.trajectory);
    expect(actual.trajectory.header.endReason).toBe(reason);
    const independent = createRide({ ticks: Math.ceil((intents.length + 1) / CHUNK), poses: 100, rate: RIDE_RATE, constants: RIDE_CONSTANTS });
    independent.setInitial(initial);
    independent.setInputs(expected.history.inputs, expected.trajectory.header.endReason, expected.trajectory.header.endTick);
    independent.pass();
    if (!actual.ride) throw new Error(`expected ${reason} fixture to publish a path`);
    expect(actual.ride.trajectory()).toEqual(independent.trajectory());
    expect(actual.ride.path()).toEqual(independent.path());
    expect(actual.ride.memory.buffer).toBeInstanceOf(SharedArrayBuffer);
});

const straight: RideSource = {
    length: 100, rate: RIDE_RATE, constants: RIDE_CONSTANTS,
    initial: { ...RIDE_START, speed: 6 },
    intents: new Array<Intent>(100).fill({
        shape: { kind: "forces", normal: 1, lateral: 0, roll: 0 },
        energy: { kind: "driven", target: 6, accel: 1 },
    }),
};

test("level driven straight travels six metres in one second", () => {
    const { ride, trajectory, refusal } = evaluateRide(straight);
    expect(ride).toBeDefined();
    expect(refusal).toBeUndefined();
    expect(trajectory.header).toMatchObject({ endReason: "complete", endTick: 100, count: 101 });
    const last = tickAt(trajectory, 100);
    expect(last.position).toEqual([0, 0, -6]);
    expect(last.speed).toBe(6);
});

test("level driven straight below the force floor refuses at tick zero without publication", () => {
    const { ride, trajectory, refusal, length } = evaluateRide({ ...straight, initial: { ...straight.initial, speed: 2 } });
    expect(ride).toBeUndefined();
    expect(length).toBe(100);
    expect(refusal).toEqual({
        reason: "unsatisfiable", lane: "forces", tick: 0, quantity: "speed magnitude", need: 5, have: 2,
    });
    expect(trajectory.header).toMatchObject({ endReason: "unsatisfiable", endTick: 0, count: 1 });
    expect(tickAt(trajectory, 0)).toMatchObject({ position: [0, 0, 0], rotation: [0, 0, 0, 1], speed: 2, distance: 0 });
});

test("negative normal discriminant refuses row 25 and publishes only the solved straight", () => {
    const intents = straight.intents.slice();
    intents[25] = { ...intents[25], shape: { kind: "forces", normal: -1, lateral: 0, roll: 0 } };
    const { ride, trajectory, refusal, length } = evaluateRide({ ...straight, intents });
    expect(length).toBe(100);
    expect(refusal).toMatchObject({
        reason: "unsatisfiable", lane: "forces", tick: 25, quantity: "normal discriminant", need: 0,
    });
    expect(refusal?.have).toBeCloseTo(-34.632, 9);
    const end = { endReason: "unsatisfiable", endTick: 25, count: 26 };
    const pose: ReturnType<typeof poseAt> = { position: [0, 0, -1.5], rotation: [0, 0, 0, 1] };
    expect(trajectory.header).toMatchObject(end);
    expect(tickAt(trajectory, 25)).toMatchObject({ ...pose, speed: 6, distance: 1.5 });
    if (!ride) throw new Error("expected a published prefix");
    const published = ride.trajectory();
    expect(published.header).toMatchObject(end);
    expect(tickAt(published, 25)).toMatchObject({ ...pose, speed: 6, distance: 1.5 });
    const { path } = ride.path();
    expect(path.header.length).toBeCloseTo(1.5, 6);
    expect(poseAt(path, path.header.count - 1)).toEqual(pose);
});

test("malformed source is rejected rather than returned as a policy refusal", () => {
    expect(() => evaluateRide({ ...straight, intents: [] }))
        .toThrow("ride source: expected one intent per authored tick and a positive integer length");
});

test("motion entry and headless example import only motion, path data and TypeGPU schemas", () => {
    const root = resolve(import.meta.dir, "..");
    const allowed = new Set(["path/path.ts"]);
    const seen = new Set<string>();
    function visit(file: string) {
        if (seen.has(file)) return;
        seen.add(file);
        const text = readFileSync(file, "utf8");
        for (const match of text.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)) {
            const spec = match[1];
            if (!spec.startsWith(".")) { expect(spec).toBe("typegpu/data"); continue; }
            const target = resolve(dirname(file), `${spec}.ts`);
            expect(target.startsWith(`${root}/trajectory/`) || allowed.has(target.slice(root.length + 1))).toBe(true);
            visit(target);
        }
    }
    visit(resolve(import.meta.dir, "ride.ts"));
    visit(resolve(import.meta.dir, "headless.example.ts"));
});
