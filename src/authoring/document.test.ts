import { expect, test } from "bun:test";
import { evaluateRide } from "../trajectory/ride";
import { tickAt } from "../trajectory/trajectory";
import { openRide, resolveRide, saveRide, solveRide } from "./document";

const text = await Bun.file(new URL("./straight.ride.json", import.meta.url)).text();

function reverseMembers(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reverseMembers);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseMembers(item)]));
    }
    return value;
}

test("the saved straight opens and saves to canonical bytes regardless of member order", () => {
    expect(saveRide(openRide(JSON.stringify(reverseMembers(JSON.parse(text)))))).toBe(text);
});

test("opening rejects malformed authored data, not physical refusals", () => {
    const invalid: [string, (doc: ReturnType<typeof openRide>) => void][] = [
        ["version", doc => Object.assign(doc, { version: 2 })],
        ["initial", doc => Object.assign(doc.initial, { distance: 0 })],
        ["rotation", doc => { doc.initial.rotation = [0, 0, 0, 2]; }],
        ["mass", doc => { doc.constants.mass = 0; }],
        ["spans", doc => { doc.spans = []; }],
        ["start", doc => { doc.spans[0].start = 1; }],
        ["end", doc => { doc.spans[0].end = 1.5; }],
        ["normal", doc => { doc.spans[0].normal = []; }],
        ["tick", doc => { doc.spans[0].normal[0].tick = 1; }],
        ["tick", doc => { doc.spans[0].normal.push({ tick: 101, value: 1, ease: "hold" }); }],
        ["tick", doc => { doc.spans[0].normal.push({ ...doc.spans[0].normal[0] }); }],
        ["ease", doc => Object.assign(doc.spans[0].normal[0], { ease: "spline" })],
        ["value", doc => { doc.spans[0].accel[0].value = -1; }],
    ];
    expect(() => openRide("{")).toThrow("ride document JSON");
    expect(() => openRide(text.replace('"speed": 6', '"speed": 1e400'))).toThrow("speed");
    for (const [field, mutate] of invalid) {
        const doc = openRide(text);
        mutate(doc);
        expect(() => openRide(JSON.stringify(doc)), field).toThrow(field);
    }
    const refused = solveRide(openRide(text.replace('"speed": 6', '"speed": 4')));
    expect(refused.refusal).toMatchObject({ tick: 0, reason: "unsatisfiable", quantity: "speed magnitude" });
});

test("open rejects initial states that cannot publish at tick zero without changing valid source values", () => {
    expect(() => openRide(text.replace('"speed": 6', '"speed": 1e40'))).toThrow("initial.speed");
    const doc = openRide(text);
    doc.initial.position = [1e40, 0, 0];
    expect(() => openRide(JSON.stringify(doc))).toThrow("initial.position");
    doc.initial.position = [0, 0, 0];
    doc.initial.rotation = [0, 0, 0, 1.00009999];
    expect(() => openRide(JSON.stringify(doc))).toThrow("initial.rotation");
    doc.initial.rotation = [0, 0, 0, 1.00001];
    doc.initial.position = [0.1, 0, 0];
    doc.initial.speed = 6.1;
    expect(openRide(saveRide(doc)).initial).toEqual(doc.initial);
});

test("keys take effect at their ticks and an end key shapes but never owns the seam", () => {
    const doc = openRide(text);
    const span = doc.spans[0];
    span.end = 4;
    span.normal.push({ tick: 2, value: 3, ease: "linear" }, { tick: 4, value: 9, ease: "hold" });
    span.target.push({ tick: 1, value: 8, ease: "linear" });
    span.accel.push({ tick: 3, value: 2, ease: "hold" });
    const next = openRide(text).spans[0];
    next.start = 4;
    next.end = 6;
    for (const keys of [next.normal, next.lateral, next.roll, next.target, next.accel]) keys[0].tick = 4;
    doc.spans.push(next);
    const { length, intents } = resolveRide(openRide(saveRide(doc)));
    expect(length).toBe(6);
    expect(intents.map(({ shape }) => shape)).toEqual([1, 1, 3, 6, 1, 1].map(normal => ({
        kind: "forces", normal, lateral: 0, roll: 0,
    })));
    expect(intents.map(({ energy }) => energy)).toEqual([
        [6, 1], [8, 1], [8, 1], [8, 2], [6, 1], [6, 1],
    ].map(([target, accel]) => ({ kind: "driven", target, accel })));
});

test("the saved force/driven straight matches dense evaluation and ends six metres forward", () => {
    const solved = solveRide(openRide(text));
    const direct = evaluateRide({
        length: 100, rate: 100,
        initial: { position: [0, 0, 0], rotation: [0, 0, 0, 1], speed: 6, distance: 0 },
        constants: { g: 9.81, heartToCom: -0.9, mass: 500, friction: 0.03, drag: 2e-5 },
        intents: Array.from({ length: 100 }, () => ({
            shape: { kind: "forces", normal: 1, lateral: 0, roll: 0 },
            energy: { kind: "driven", target: 6, accel: 1 },
        })),
    });
    expect(solved.length).toBe(100);
    expect(solved.refusal).toBeUndefined();
    expect(solved.trajectory.header).toMatchObject({ endReason: "complete", endTick: 100, rate: 100 });
    const end = tickAt(solved.trajectory, 100);
    expect(end.position[0]).toBeCloseTo(0, 5);
    expect(end.position[1]).toBeCloseTo(0, 5);
    expect(end.position[2]).toBeCloseTo(-6, 5);
    expect(end.speed).toBeCloseTo(6, 5);
    expect(solved.trajectory).toEqual(direct.trajectory);
});
