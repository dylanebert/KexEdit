import { type Quat, UNIT_TOLERANCE, type Vec3 } from "../path/path";
import type { Intent } from "../trajectory/policies";
import { evaluateRide, type RideSource } from "../trajectory/ride";
import type { RideConstants } from "../trajectory/trajectory";

const RATE = 100;
// Only the parameters of the v1 force/driven witness, not a motion channel registry.
const parameters = ["normal", "lateral", "roll", "target", "accel"] as const;
export type Parameter = typeof parameters[number];

export function isParameter(value: string): value is Parameter {
    return parameters.some(name => name === value);
}

export interface RideKey {
    tick: number;
    value: number;
    /** Outgoing interpolation to the next key; the last value holds. */
    ease: "hold" | "linear";
}

export type RideSpan = { start: number; end: number } & Record<Parameter, RideKey[]>;

/** v1 authors force/driven motion at 100 Hz. Spans own [start, end) input ticks. */
export interface RideDocument {
    version: 1;
    initial: { position: Vec3; rotation: Quat; speed: number };
    constants: RideConstants;
    spans: RideSpan[];
}

function invalid(field: string, message: string): never {
    throw new Error(`ride document ${field}: ${message}`);
}

function object(value: unknown, field: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field, "expected an object");
    return value as Record<string, unknown>;
}

function fields(value: unknown, field: string, names: readonly string[]) {
    const record = object(value, field);
    for (const key of Object.keys(record)) {
        if (!names.includes(key)) invalid(`${field}.${key}`, "unknown member");
    }
    for (const key of names) {
        if (!Object.hasOwn(record, key)) invalid(`${field}.${key}`, "missing member");
    }
    return record;
}

function finite(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) invalid(field, "expected a finite number");
    return value;
}

function tuple(value: unknown, size: number, field: string): number[] {
    if (!Array.isArray(value) || value.length !== size) invalid(field, `expected ${size} components`);
    return Array.from(value, (item, i) => finite(item, `${field}[${i}]`));
}

function tick(value: unknown, field: string): number {
    const n = finite(value, field);
    if (!Number.isSafeInteger(n) || n < 0) invalid(field, "expected a nonnegative safe integer tick");
    return n;
}

function keys(value: unknown, field: string, start: number, end: number, parameter: Parameter): RideKey[] {
    if (!Array.isArray(value) || value.length === 0) invalid(field, "expected at least one key");
    let previous = start - 1;
    return Array.from(value, (item, i) => {
        const at = `${field}[${i}]`;
        const key = fields(item, at, ["tick", "value", "ease"]);
        const time = tick(key.tick, `${at}.tick`);
        if (i === 0 && time !== start) invalid(`${at}.tick`, "first key must be at the span start");
        if (time <= previous || time > end) invalid(`${at}.tick`, "keys must increase through the span end at most");
        previous = time;
        const number = finite(key.value, `${at}.value`);
        if (parameter === "accel" && number < 0) invalid(`${at}.value`, "acceleration limit must be nonnegative");
        const { ease } = key;
        if (ease !== "hold" && ease !== "linear") invalid(`${at}.ease`, "expected hold or linear");
        return { tick: time, value: number, ease };
    });
}

function readV1(value: unknown): RideDocument {
    const doc = fields(value, "root", ["version", "initial", "constants", "spans"]);
    const init = fields(doc.initial, "initial", ["position", "rotation", "speed"]);
    const position = tuple(init.position, 3, "initial.position") as unknown as Vec3;
    const rotation = tuple(init.rotation, 4, "initial.rotation") as unknown as Quat;
    if (Math.abs(Math.hypot(...rotation) - 1) > UNIT_TOLERANCE) invalid("initial.rotation", "expected a unit quaternion");
    const speed = finite(init.speed, "initial.speed");
    // Tick zero is checked after Float32 packing. Check that representation too,
    // but preserve the authored doubles; this says nothing about later solved rows.
    if (!position.every(n => Number.isFinite(Math.fround(n))))
        invalid("initial.position", "expected finite Float32 components");
    if (!Number.isFinite(Math.fround(speed))) invalid("initial.speed", "expected a finite Float32 value");
    if (Math.abs(Math.hypot(...rotation.map(Math.fround)) - 1) > UNIT_TOLERANCE)
        invalid("initial.rotation", "expected a unit quaternion after Float32 packing");
    const c = fields(doc.constants, "constants", ["g", "heartToCom", "mass", "friction", "drag"]);
    const constants = {
        g: finite(c.g, "constants.g"), heartToCom: finite(c.heartToCom, "constants.heartToCom"),
        mass: finite(c.mass, "constants.mass"), friction: finite(c.friction, "constants.friction"),
        drag: finite(c.drag, "constants.drag"),
    };
    for (const name of ["g", "mass"] as const) {
        if (constants[name] <= 0) invalid(`constants.${name}`, "expected a positive number");
    }
    for (const name of ["friction", "drag"] as const) {
        if (constants[name] < 0) invalid(`constants.${name}`, "expected a nonnegative number");
    }
    if (!Array.isArray(doc.spans) || doc.spans.length === 0) invalid("spans", "expected at least one span");
    let nextStart = 0;
    const spans = Array.from(doc.spans, (item, i): RideSpan => {
        const at = `spans[${i}]`;
        const span = fields(item, at, ["start", "end", ...parameters]);
        const start = tick(span.start, `${at}.start`);
        const end = tick(span.end, `${at}.end`);
        if (start !== nextStart) invalid(`${at}.start`, `expected ${nextStart}`);
        if (end <= start) invalid(`${at}.end`, "expected end after start");
        nextStart = end;
        const read = (name: Parameter) => keys(span[name], `${at}.${name}`, start, end, name);
        return { start, end, normal: read("normal"), lateral: read("lateral"), roll: read("roll"),
            target: read("target"), accel: read("accel") };
    });
    return { version: 1, initial: { position, rotation, speed }, constants, spans };
}

/** Validate authored data and return a document in canonical member order. */
export function validateRide(value: unknown): RideDocument {
    switch (object(value, "root").version) {
        case 1: return readV1(value);
        default: return invalid("version", "unsupported version; expected 1");
    }
}

/** Open JSON text and validate its authored schema without running any motion policies. */
export function openRide(text: string): RideDocument {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        invalid("JSON", "malformed JSON text");
    }
    return validateRide(value);
}

/** Validate and serialize only authored data, in schema order with two-space indent and final LF. */
export function saveRide(document: RideDocument): string {
    return `${JSON.stringify(validateRide(document), null, 2)}\n`;
}

// Called at increasing ticks inside one span. A key at end can be the right endpoint only.
function sampler(keys: readonly RideKey[]) {
    let i = 0;
    return (tick: number) => {
        while (keys[i + 1]?.tick <= tick) i++;
        const a = keys[i];
        const b = keys[i + 1];
        if (a.ease === "hold" || !b || tick === a.tick) return a.value;
        const t = (tick - a.tick) / (b.tick - a.tick);
        return (1 - t) * a.value + t * b.value;
    };
}

/** Resolve a validated document to one existing policy intent per owned tick. */
export function resolveRide(document: RideDocument): RideSource {
    const intents: Intent[] = [];
    for (const span of document.spans) {
        const [normal, lateral, roll, target, accel] = parameters.map(name => sampler(span[name]));
        for (let tick = span.start; tick < span.end; tick++) {
            intents.push({
                shape: { kind: "forces", normal: normal(tick), lateral: lateral(tick), roll: roll(tick) },
                energy: { kind: "driven", target: target(tick), accel: accel(tick) },
            });
        }
    }
    return { length: intents.length, intents, initial: { ...document.initial, distance: 0 },
        constants: document.constants, rate: RATE };
}

/** Solve a validated document through the existing scene-free evaluator. */
export function solveRide(document: RideDocument) {
    return evaluateRide(resolveRide(document));
}
