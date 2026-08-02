import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DIM_WASH, hexToOklch, hovered, selected } from "../src/colors";
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
        // Globbed, not a hardcoded file list — a new component must not escape the pin. Every
        // `transition:`/`animation:` shorthand is read whole, so the keyword is caught in EITHER
        // order (`120ms ease`, `ease 120ms`) and anywhere in the value, and the whole bare family
        // counts (`ease-in`, `ease-out`, `ease-in-out`) — `var(--ease-out)` is exempt by the
        // leading `-`, which the boundary rejects.
        // The one sanctioned non-token timing is `linear` (the modal spinner's infinite
        // rotation): a constant-rate loop is not an eased transition, and no `ease*` keyword
        // appears in it, so it needs no carve-out here.
        const src = fileURLToPath(new URL("../src", import.meta.url));
        const files = [...new Bun.Glob("**/*.svelte").scanSync(src)];
        expect(files.length).toBeGreaterThan(0); // the glob reaches the components at all
        for (const f of files) {
            const css = readFileSync(`${src}/${f}`, "utf8");
            const decls = css.match(/\b(?:transition|animation)\s*:[^;}]*/g) ?? [];
            const sites = decls.filter((d) =>
                /(?<![-\w])ease(?:-in|-out|-in-out)?(?![-\w])/.test(d),
            );
            expect({ file: f, sites }).toEqual({ file: f, sites: [] });
        }
    });
});

describe("hover outline lift — a glyph's ink stroke joins its hovered tone (kex2d-idioms 10b)", () => {
    test("render.ts derives every glyph hover stroke through hovered(), never a literal", () => {
        // the color channel is hover's ONE channel: on hover a viewport glyph's dark ink stroke
        // lifts to the same hovered() tone its fill wears — silhouette contrast without a size
        // change. force markers + boundary anchors both resolve through the helper.
        const render = readFileSync(new URL("../src/render.ts", import.meta.url), "utf8");
        // presence, never an occurrence COUNT: a count breaks on a legitimate hoist into a local
        // and passes on a tone computed and never used. What the lift DOES is pinned honestly by
        // the harness ray-run off the real canvas (`harness/force.pw.ts` step 4b) — this only
        // pins that the tone comes from the shared helper rather than a hand-written literal.
        expect(render.includes("hovered(COLOR_FORCE)")).toBe(true);
        expect(/hov\s*\?\s*hovered\(COLOR_ANCHOR\)/.test(render)).toBe(true);
        // the grow channel is OUT (user feel verdict): no hover radius scaling anywhere.
        expect(render.includes("HOVER_GROW")).toBe(false);
    });

    test("Timeline.svelte lifts both glyph strokes to the selection token at base width", () => {
        // the rung below selection: hover borrows selection's stroke token (--fg) but at the
        // base 1px width and without the accent fill — selected keeps 1.4px + accent, so the
        // two registers stay distinguishable by weight and fill, never by a size change.
        const tl = readFileSync(new URL("../src/Timeline.svelte", import.meta.url), "utf8");
        // per-glyph presence, not a rule count. The `.fmarker` lift is behavior-pinned by the
        // harness computed-style probe (`harness/force.pw.ts` step 4c); `.tknob`'s has no probe
        // yet, so this is the only thing holding it — one assert each, so a missing rule names
        // its own glyph instead of reading as "1 ≠ 2".
        const lifted = (sel: RegExp): boolean =>
            new RegExp(`${sel.source}\\s*\\{[^}]*stroke: var\\(--fg\\)`, "s").test(tl);
        expect(lifted(/\.fpt:hover[^{]*\.fmarker/)).toBe(true);
        expect(lifted(/\.thit:hover \+ \.tknob/)).toBe(true);
        // no geometry channel remains: no grow var, no hover scale transform.
        expect(tl.includes("--hover-grow")).toBe(false);
        expect(tl.includes("scale(var(--hover-grow))")).toBe(false);
    });
});

describe("tangent knob — one appearance, ink outline at rest, hover lifts both channels (kex2d-burndown feel fix)", () => {
    test("TangentDrawSystem draws every knob with the point-glyph hover calibration — no explicit/ghost fork", () => {
        // the authored/inferred distinction the old ghost fork encoded is not a state the user
        // ever chooses (inferred is simply pre-first-drag) — not worth a visual channel, so every
        // knob draws identically. But identical still needs the point-glyph calibration
        // (editor-ui.md Kind color): an ink outline at rest, hover lifting BOTH the fill and the
        // outline to the hovered tone — silhouette contrast without a size change. A collapse
        // that set both channels to the same resting tone (accent stroke on accent fill) loses
        // the hover read entirely, which is the regression this pins against.
        const render = readFileSync(new URL("../src/render.ts", import.meta.url), "utf8");
        const start = render.indexOf("const TangentDrawSystem");
        const end = render.indexOf("const CartDrawSystem");
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        const body = render.slice(start, end);
        // the retired ghost-outline constant has no caller left.
        expect(body.includes("TANGENT_GHOST")).toBe(false);
        // no explicit/ghost fork remains — `explicit` is dead once the branch is gone.
        expect(body.includes("if (explicit)")).toBe(false);
        expect(body.includes("const explicit")).toBe(false);
        // rest state: ink outline, accent fill. hover: both lift to hovered(COLOR_ACCENT).
        expect(body.includes('ctx.strokeStyle = hov ? hovered(COLOR_ACCENT) : "#0e0d0c";')).toBe(
            true,
        );
        expect(body.includes("ctx.fillStyle = hov ? hovered(COLOR_ACCENT) : COLOR_ACCENT;")).toBe(
            true,
        );
        // fill is unconditional: exactly one `ctx.fill()` call in the knob loop, set every
        // iteration alongside the stroke, both through the shared hover helper.
        expect((body.match(/ctx\.fill\(\);/g) ?? []).length).toBe(1);
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

// ── cursor allowlist (kex2d-followups follow-up 6): `cursor: grab | grabbing | pointer` is a
// real affordance channel (editor-ui.md Affordance typing — grab hands mean a pannable surface
// and nothing else; a direct-manipulation glyph keeps the arrow, `.rbtn`/`.thit` shed theirs
// already), so a new occurrence anywhere in the tree is either a genuine pannable/clickable
// chrome affordance or a regression sneaking the cursor channel onto a glyph it doesn't belong
// on. CSS `cursor` has no cheap behavioral read, so this stays a SOURCE pin by design (the
// spec's locked decision) — the strongest mechanism available, not a stand-in for one. A
// declared registry, asserted BOTH directions like the `checked`/separator registries (an
// undeclared cursor site and an orphan registry entry each fail), walked recursively (`Bun.Glob`,
// not `readdirSync` — the source-pin law, editor-ui.md Menus) so a new component can't escape it.

interface CursorSite {
    file: string;
    selector: string;
    value: "grab" | "grabbing" | "pointer";
}

// today's population, enumerated FROM THE SOURCE (`cursorSites()` below) — not hand-guessed: the
// panning pair (`.nav-window` grab/grabbing, `.body.panning` grabbing while the drag is live) and
// every plain clickable affordance that carries `cursor: pointer` (the rail's snap toggle, the
// section clip strip, its append tail, the transport play button, the global scrubber, the two
// modal buttons, and the shared menu-item class every context menu renders through).
const CURSOR_ALLOWLIST: CursorSite[] = [
    { file: "App.svelte", selector: ".pinpanel button", value: "pointer" },
    { file: "App.svelte", selector: ".convert .cancel", value: "pointer" },
    { file: "App.svelte", selector: ":global(.menu-item)", value: "pointer" },
    { file: "Timeline.svelte", selector: ".rail-tool", value: "pointer" },
    { file: "Timeline.svelte", selector: ".body.panning, .body.panning *", value: "grabbing" },
    { file: "Timeline.svelte", selector: ".nav-window", value: "grab" },
    { file: "Timeline.svelte", selector: ".nav-window:active", value: "grabbing" },
    { file: "Timeline.svelte", selector: ".clip", value: "pointer" },
    { file: "Timeline.svelte", selector: ".clip-add", value: "pointer" },
    { file: "Timeline.svelte", selector: ".play", value: "pointer" },
    { file: "Timeline.svelte", selector: ".scrub", value: "pointer" },
];

/** walk every `.svelte` file recursively and collect every `cursor: grab|grabbing|pointer`
 *  declaration paired with its rule's own selector — a real (if simple) CSS parse over
 *  non-nested rule blocks, not a per-line grep, so a multi-selector list or a doc comment sitting
 *  just above the rule still resolves to the one selector that owns the declaration. */
function cursorSites(): CursorSite[] {
    const src = fileURLToPath(new URL("../src", import.meta.url));
    const files = [...new Bun.Glob("**/*.svelte").scanSync(src)];
    const out: CursorSite[] = [];
    for (const f of files) {
        const text = readFileSync(`${src}/${f}`, "utf8");
        const style = text.match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? "";
        const blocks = style.match(/[^{}]+\{[^{}]*\}/g) ?? [];
        for (const b of blocks) {
            const m = b.match(/cursor:\s*(grab|grabbing|pointer)\s*;/);
            if (!m) continue;
            const selector = b
                .slice(0, b.indexOf("{"))
                .replace(/\/\*[\s\S]*?\*\//g, "") // strip a doc comment sitting right above the rule
                .trim()
                .replace(/\s+/g, " ");
            out.push({ file: f, selector, value: m[1] as CursorSite["value"] });
        }
    }
    return out;
}

const cursorKey = (s: CursorSite): string => `${s.file}::${s.selector}::${s.value}`;

describe("cursor allowlist — grab/grabbing/pointer only in a declared registry", () => {
    test("the glob reaches the components at all", () => {
        expect(cursorSites().length).toBeGreaterThan(0);
    });

    test("every found cursor:grab/grabbing/pointer site is declared in the registry", () => {
        const declared = new Set(CURSOR_ALLOWLIST.map(cursorKey));
        const undeclared = cursorSites().filter((s) => !declared.has(cursorKey(s)));
        expect(undeclared).toEqual([]);
    });

    test("every registry entry corresponds to a real cursor declaration in source", () => {
        const found = new Set(cursorSites().map(cursorKey));
        const orphans = CURSOR_ALLOWLIST.filter((s) => !found.has(cursorKey(s)));
        expect(orphans).toEqual([]);
    });

    // the positive control, both directions (the source-pin law, editor-ui.md Menus): an
    // undeclared cursor site and an orphan registry entry must each be CAUGHT.
    test("an undeclared cursor site is caught (positive control)", () => {
        const bogus: CursorSite = { file: "Fake.svelte", selector: ".bogus", value: "pointer" };
        const found = [...cursorSites(), bogus];
        const declared = new Set(CURSOR_ALLOWLIST.map(cursorKey));
        expect(found.some((s) => !declared.has(cursorKey(s)))).toBe(true);
    });

    test("an orphan registry entry is caught (positive control)", () => {
        const bogus: CursorSite = { file: "Fake.svelte", selector: ".bogus", value: "pointer" };
        const registry = [...CURSOR_ALLOWLIST, bogus];
        const found = new Set(cursorSites().map(cursorKey));
        expect(registry.some((s) => !found.has(cursorKey(s)))).toBe(true);
    });
});
