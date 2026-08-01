import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DIM_WASH, HOVER_GROW, hexToOklch, hovered, selected } from "../src/colors";
import { easeOut } from "../src/editor";

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

// ── token mirrors: App.svelte's `:root` is the CSS token home; the canvas/JS twins live in
// colors.ts / editor.ts (the COLOR_GUIDE_RAY ↔ `--guide` precedent, now pinned instead of
// comment-only). A drift between the two halves is exactly the "two dialects of one channel"
// failure the Mode vocabulary exists to prevent (editor-ui.md).
const appCss = readFileSync(new URL("../src/App.svelte", import.meta.url), "utf8");

describe("token mirrors (App.svelte :root)", () => {
    test("DIM_WASH mirrors the --dim token — one out-of-scope wash, both surfaces", () => {
        const m = appCss.match(/--dim:\s*([^;]+);/);
        expect(m?.[1].trim()).toBe(DIM_WASH);
    });

    test("--ease-out is the exact bezier of editor.ts easeOut (1 − (1 − t)³)", () => {
        const m = appCss.match(/--ease-out:\s*cubic-bezier\(([^)]+)\)/);
        expect(m).not.toBeNull();
        const [x1, y1, x2, y2] = (m as RegExpMatchArray)[1].split(",").map(Number);
        // y1 = y2 = 1 makes the bezier's y-polynomial exactly 3t − 3t² + t³ = 1 − (1 − t)³,
        // and x1 = 1/3, x2 = 2/3 make x(t) = t exactly — so y(x) IS easeOut. The token prints
        // the thirds at 5 decimals, so the control-point error bound is 5e-6, not a tuned tol.
        expect(y1).toBe(1);
        expect(y2).toBe(1);
        expect(Math.abs(x1 - 1 / 3)).toBeLessThanOrEqual(5e-6);
        expect(Math.abs(x2 - 2 / 3)).toBeLessThanOrEqual(5e-6);
        for (const t of [0, 0.25, 0.5, 0.75, 1]) {
            expect(easeOut(t)).toBeCloseTo(3 * t - 3 * t ** 2 + t ** 3, 12);
        }
    });

    test("no bare `ease` keyword survives — every transition names the token", () => {
        // root ui.md Motion: transitions reference the shared token, never a bare keyword.
        // (`linear` on the modal spinner's infinite rotation is not an eased transition.)
        for (const f of ["App.svelte", "Timeline.svelte", "Menu.svelte"]) {
            const css = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
            expect({ file: f, sites: css.match(/\d+ms\s+ease\b/g) ?? [] }).toEqual({
                file: f,
                sites: [],
            });
        }
    });
});

describe("HOVER_GROW — one glyph grow ratio, both surfaces", () => {
    test("is the area-doubling step (√2 — one hover step at area scale)", () => {
        // the derivation, pinned as an invariant: a retune that leaves the area-step rationale
        // must change the comment too, not just the number.
        expect(HOVER_GROW * HOVER_GROW).toBeCloseTo(2, 12);
    });

    test("render.ts scales every pickable glyph radius by the one constant", () => {
        const render = readFileSync(new URL("../src/render.ts", import.meta.url), "utf8");
        for (const site of [
            "FORCE_R * HOVER_GROW",
            "HANDLE_R * HOVER_GROW",
            "ANCHOR_R * HOVER_GROW",
        ]) {
            expect({ site, present: render.includes(site) }).toEqual({ site, present: true });
        }
    });

    test("Timeline.svelte mirrors it as --hover-grow and both glyph rules scale by the var", () => {
        // the DIM_WASH/--dim mirror precedent: the SVG side can't import into CSS, so the
        // component wires the constant onto its root as a custom property and the hover rules
        // reference only the var — no second literal ratio can drift.
        const tl = readFileSync(new URL("../src/Timeline.svelte", import.meta.url), "utf8");
        expect(tl.includes("--hover-grow: {HOVER_GROW}")).toBe(true);
        const growRules = tl.match(/scale\(var\(--hover-grow\)\)/g) ?? [];
        expect(growRules.length).toBeGreaterThanOrEqual(2); // .fmarker + .tknob
        // no literal-ratio grow on a glyph rule beside the var (the transport thumb and the
        // button :active press are different idioms and keep their own numbers).
        expect(tl.match(/\.(?:fmarker|tknob)\s*\{[^}]*scale\(\s*[\d.]/s)).toBeNull();
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
