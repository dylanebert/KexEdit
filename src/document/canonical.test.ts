import { expect } from "bun:test";
import { check } from "@dylanebert/shallot/harness/check";
import { emitCanonical, type Json } from "./canonical";

check(
    "canonical emitter bytes are idempotent and independent of key order",
    { claim: "canonical emitter bytes are idempotent and independent of key order" },
    () => {
        const forward: Json = {
            version: 1,
            channels: { roll: { extrapolation: "constant", keys: [{ co: [0, 0.5] }] } },
            name: "a",
        };
        const reversed: Json = {
            name: "a",
            channels: { roll: { keys: [{ co: [0, 0.5] }], extrapolation: "constant" } },
            version: 1,
        };
        const first = emitCanonical(forward);
        expect(emitCanonical(forward)).toBe(first);
        expect(emitCanonical(reversed)).toBe(first);
        expect(first).toBe(
            '{"channels":{"roll":{"extrapolation":"constant","keys":[{"co":[0,0.5]}]}},"name":"a","version":1}\n',
        );
    },
);
