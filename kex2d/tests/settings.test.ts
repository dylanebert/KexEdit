import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    ANGLE_STEP_DEFAULT,
    ANGLE_STEP_MIN,
    clampAngleStep,
    clampLengthStep,
    LENGTH_STEP_DEFAULT,
    LENGTH_STEP_MIN,
    loadSnapSteps,
    setSnapAngle,
    setSnapLength,
    SNAP_KEY,
    snapSteps,
} from "../src/settings";

// settings.ts is the per-user preference home: pure clamps over one impure storage edge. bun has no
// `localStorage`, so the persistence tests install a minimal in-memory Storage — one stub, at the
// module's real boundary (the same API a browser hands it).

const deg = (d: number): number => (d * Math.PI) / 180;

let store: Map<string, string>;

function installStorage(): void {
    store = new Map();
    (globalThis as { localStorage?: unknown }).localStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
        key: (i: number) => [...store.keys()][i] ?? null,
        get length() {
            return store.size;
        },
    };
}

beforeEach(installStorage);

afterEach(() => {
    // leave the live singleton at the defaults — it's module state every other suite reads
    setSnapAngle(ANGLE_STEP_DEFAULT);
    setSnapLength(LENGTH_STEP_DEFAULT);
    delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("snap-step clamps", () => {
    test("angle floors at 1° and falls back to the default when non-finite", () => {
        expect(clampAngleStep(deg(0.5))).toBeCloseTo(ANGLE_STEP_MIN, 12);
        expect(clampAngleStep(0)).toBeCloseTo(ANGLE_STEP_MIN, 12);
        expect(clampAngleStep(-deg(10))).toBeCloseTo(ANGLE_STEP_MIN, 12);
        expect(clampAngleStep(Number.NaN)).toBeCloseTo(ANGLE_STEP_DEFAULT, 12);
        expect(clampAngleStep(Number.POSITIVE_INFINITY)).toBeCloseTo(ANGLE_STEP_DEFAULT, 12);
        // an in-range value passes through untouched
        expect(clampAngleStep(deg(12))).toBeCloseTo(deg(12), 12);
    });

    test("length floors at 0.1 m and falls back to the default when non-finite", () => {
        expect(clampLengthStep(0.02)).toBeCloseTo(LENGTH_STEP_MIN, 12);
        expect(clampLengthStep(0)).toBeCloseTo(LENGTH_STEP_MIN, 12);
        expect(clampLengthStep(Number.NaN)).toBeCloseTo(LENGTH_STEP_DEFAULT, 12);
        expect(clampLengthStep(2.5)).toBeCloseTo(2.5, 12);
    });

    test("the setters clamp what they write to the live values", () => {
        setSnapAngle(deg(0.25));
        expect(snapSteps.angle).toBeCloseTo(ANGLE_STEP_MIN, 12);
        setSnapLength(-3);
        expect(snapSteps.length).toBeCloseTo(LENGTH_STEP_MIN, 12);
    });
});

describe("snap-step persistence", () => {
    test("a set value round-trips through storage into the live singleton", () => {
        setSnapAngle(deg(10));
        setSnapLength(2.5);
        expect(JSON.parse(store.get(SNAP_KEY) ?? "null")).toEqual({
            angle: deg(10),
            length: 2.5,
        });

        // scramble the live values, then load them back from storage
        snapSteps.angle = 99;
        snapSteps.length = 99;
        loadSnapSteps();
        expect(snapSteps.angle).toBeCloseTo(deg(10), 12);
        expect(snapSteps.length).toBeCloseTo(2.5, 12);
    });

    test("nothing stored loads the defaults", () => {
        snapSteps.angle = 99;
        snapSteps.length = 99;
        loadSnapSteps();
        expect(snapSteps.angle).toBeCloseTo(ANGLE_STEP_DEFAULT, 12);
        expect(snapSteps.length).toBeCloseTo(LENGTH_STEP_DEFAULT, 12);
    });

    test("a corrupt or wrong-shaped stored value loads the defaults", () => {
        for (const raw of ["{oops", "null", "42", '{"angle":"5deg"}', '{"angle":null}']) {
            store.set(SNAP_KEY, raw);
            snapSteps.angle = 99;
            snapSteps.length = 99;
            loadSnapSteps();
            expect(snapSteps.angle).toBeCloseTo(ANGLE_STEP_DEFAULT, 12);
            expect(snapSteps.length).toBeCloseTo(LENGTH_STEP_DEFAULT, 12);
        }
    });

    test("an out-of-range stored value loads clamped, not defaulted", () => {
        store.set(SNAP_KEY, JSON.stringify({ angle: 0, length: 0 }));
        loadSnapSteps();
        expect(snapSteps.angle).toBeCloseTo(ANGLE_STEP_MIN, 12);
        expect(snapSteps.length).toBeCloseTo(LENGTH_STEP_MIN, 12);
    });

    test("a storage that THROWS on read or write can't break the editor", () => {
        // blocked storage in an embedded context throws on access, not just on write — and
        // `loadSnapSteps` runs at boot, so an escaping exception would abort before the app mounts
        (globalThis as { localStorage?: unknown }).localStorage = {
            getItem: () => {
                throw new Error("access denied");
            },
            setItem: () => {
                throw new Error("access denied");
            },
        };
        snapSteps.angle = 99;
        expect(() => loadSnapSteps()).not.toThrow();
        expect(snapSteps.angle).toBeCloseTo(ANGLE_STEP_DEFAULT, 12);
        expect(() => setSnapLength(3)).not.toThrow();
        expect(snapSteps.length).toBeCloseTo(3, 12); // the live value still takes
    });

    test("no storage at all: the live values still take, load leaves the defaults", () => {
        delete (globalThis as { localStorage?: unknown }).localStorage;
        setSnapAngle(deg(20)); // no throw — storage is the edge, the session still holds the value
        expect(snapSteps.angle).toBeCloseTo(deg(20), 12);
        loadSnapSteps();
        expect(snapSteps.angle).toBeCloseTo(ANGLE_STEP_DEFAULT, 12);
        expect(snapSteps.length).toBeCloseTo(LENGTH_STEP_DEFAULT, 12);
    });
});
