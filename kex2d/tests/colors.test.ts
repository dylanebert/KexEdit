import { describe, expect, test } from "bun:test";
import { hexToOklch, hovered, selected } from "../src/colors";

// an independent sRGB #rrggbb reader (not the module under test).
function rgb(hex: string): [number, number, number] {
    const n = Number.parseInt(hex.slice(1), 16);
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}
// the OLD sRGB derivation `selected` replaced: a 35% mix toward white. the regression
// baseline — the OKLCH variant must stay more saturated than this washed-out result.
function whiteMix(hex: string): string {
    const up = (c: number): number => Math.round(c + (255 - c) * 0.35);
    const [r, g, b] = rgb(hex);
    return `#${((up(r) << 16) | (up(g) << 8) | up(b)).toString(16).padStart(6, "0")}`;
}

describe("selected — OKLCH tone variant", () => {
    // the two kind colors the selection derives from (geo blue, force gold).
    const kinds = ["#78a5d6", "#d49560"];

    test("brightens (OKLCH lightness rises)", () => {
        for (const base of kinds) {
            expect(hexToOklch(selected(base)).l).toBeGreaterThan(hexToOklch(base).l);
        }
    });

    test("preserves hue", () => {
        for (const base of kinds) {
            expect(hexToOklch(selected(base)).h).toBeCloseTo(hexToOklch(base).h, 1);
        }
    });

    test("stays vivid — more chroma than the sRGB white-mix it replaces", () => {
        for (const base of kinds) {
            expect(hexToOklch(selected(base)).c).toBeGreaterThan(hexToOklch(whiteMix(base)).c);
        }
    });

    test("white is a fixed point (no chroma to lift)", () => {
        expect(selected("#ffffff")).toBe("#ffffff");
    });

    test("returns a well-formed lowercase 6-digit hex", () => {
        expect(selected("#010203")).toMatch(/^#[0-9a-f]{6}$/);
    });
});

describe("hovered — the rung below selection", () => {
    const kinds = ["#78a5d6", "#d49560"];

    test("lifts lightness, but strictly less than selection does", () => {
        for (const base of kinds) {
            const l = hexToOklch(base).l;
            expect(hexToOklch(hovered(base)).l).toBeGreaterThan(l);
            expect(hexToOklch(hovered(base)).l).toBeLessThan(hexToOklch(selected(base)).l);
        }
    });

    test("preserves hue", () => {
        for (const base of kinds) {
            expect(hexToOklch(hovered(base)).h).toBeCloseTo(hexToOklch(base).h, 1);
        }
    });

    test("keeps its chroma — the modest rung stays inside sRGB", () => {
        // the gamut map reduces chroma to fit, so a lift can silently drain the color: it's why
        // `selected`, lifting further, lands BELOW this rung's chroma on both kind colors.
        for (const base of kinds) {
            expect(hexToOklch(hovered(base)).c).toBeGreaterThan(hexToOklch(base).c);
        }
    });
});
