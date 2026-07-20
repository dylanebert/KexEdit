import { describe, expect, test } from "bun:test";
import { SELECT_MIX, selected } from "../src/colors";

// the test's own #rrggbb reader, independent of the implementation under test.
function rgb(hex: string): [number, number, number] {
    const n = Number.parseInt(hex.slice(1), 16);
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

describe("selected", () => {
    test("brightens every sub-255 channel toward white", () => {
        for (const base of ["#78a5d6", "#d49560", "#112233"]) {
            const [br, bg, bb] = rgb(base);
            const [sr, sg, sb] = rgb(selected(base));
            expect(sr).toBeGreaterThan(br);
            expect(sg).toBeGreaterThan(bg);
            expect(sb).toBeGreaterThan(bb);
        }
    });

    test("white is a fixed point (the mix target)", () => {
        expect(selected("#ffffff")).toBe("#ffffff");
    });

    test("mixes toward white by SELECT_MIX — matches the CSS color-mix twin", () => {
        // color-mix(in srgb, #000000, white SELECT_MIX) lifts each 0-channel to round(255·t).
        const expected = Math.round(255 * SELECT_MIX);
        expect(rgb(selected("#000000"))).toEqual([expected, expected, expected]);
    });

    test("returns a well-formed lowercase 6-digit hex", () => {
        expect(selected("#010203")).toMatch(/^#[0-9a-f]{6}$/);
    });
});
