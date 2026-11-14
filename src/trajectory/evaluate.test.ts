import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { evaluateRide } from "./ride";
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
    expect(actual.ride.trajectory()).toEqual(independent.trajectory());
    expect(actual.ride.path()).toEqual(independent.path());
    expect(actual.ride.memory.buffer).toBeInstanceOf(SharedArrayBuffer);
});

test("tick-zero force refusal retains the existing empty-input publication limitation", () => {
    const initial = { ...RIDE_START, speed: 0 };
    const result = run(initial, [force], RIDE_RATE, RIDE_CONSTANTS);
    expect(result.trajectory.header.endTick).toBe(0);
    expect(result.refusal?.reason).toBe("unsatisfiable");
    expect(() => evaluateRide({ length: 1, intents: [force], initial, rate: RIDE_RATE, constants: RIDE_CONSTANTS }))
        .toThrow("ride inputs: expected at least one row");
});

test("motion entry's transitive imports contain only motion, path data and TypeGPU schemas", () => {
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
});
