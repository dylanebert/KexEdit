import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
    COLOR_FORCE,
    COLOR_GEO,
    COLOR_VELOCITY,
    DIM_WASH,
    dimmed,
    hexToOklch,
    hovered,
    kindColor,
    laneColor,
    laneTone,
    selected,
} from "../src/colors";
import { Lane } from "../src/lanes";
import { SectionKind } from "../src/section";
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

// canvas 2D `fillStyle`/`strokeStyle` ignores a CSS custom property (`var(--…)`) string — the
// value is a color-syntax literal resolved once, never against a live stylesheet cascade, so
// an assignment reading `var(--velocity)` silently paints nothing (the S1 Visibility bug: every
// unselected strip drew invisible). This is a SOURCE-text arm by design (kex2d's declared-
// registry law, `editor-ui.md` Menus): CSS custom properties have no cheap behavioral read from
// a canvas draw call.

/** every `.fillStyle = …` / `.strokeStyle = …` canvas assignment across a text corpus whose
 *  right-hand side contains a CSS custom property (`var(--…)`), paired with the file it came
 *  from. Walks each assignment up to its terminating `;` (not a per-line grep — a multi-line
 *  ternary, the strip band's own selected/unselected fill, spans several lines). Takes the
 *  corpus as an ARGUMENT (`scannedFiles()`'s own shape, below) rather than reading source
 *  itself, so the real arm and its positive control run the SAME function over different text —
 *  the declared-registry law: a control that reconstructs the scan inline proves only the diff
 *  logic, never the enumerator (a scanner gone blind on a shape it doesn't parse would still
 *  pass a hand-copied regex run over its own fixture). */
function styleVarHits(corpus: { file: string; text: string }[]): { file: string; text: string }[] {
    const hits: { file: string; text: string }[] = [];
    const re = /\.(fillStyle|strokeStyle)\s*=\s*([\s\S]*?);/g;
    for (const { file, text } of corpus) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text))) {
            if (m[2].includes("var(--")) hits.push({ file, text: m[0] });
        }
    }
    return hits;
}

describe("canvas fillStyle/strokeStyle never carries a CSS custom property (S1 Visibility)", () => {
    test("no `var(--` assignment anywhere under src/ (svelte + ts, recursive)", () => {
        // the whole tree (`scannedFiles()`, below — the cursor allowlist's own corpus), not just
        // Timeline.svelte: a `var(--` assignment landing in any other file must still be caught.
        expect(styleVarHits(scannedFiles())).toEqual([]);
    });

    // the positive control (editor-ui.md Menus' source-pin law, both directions): a genuine
    // `var(--` assignment must be CAUGHT, so the arm above isn't vacuously green over a scanner
    // that can't see the multi-line ternary shape the real defect took. Calls `styleVarHits`
    // itself over a hand-built corpus — never a second, hand-copied regex — so a scanner
    // regression reds BOTH this and the real arm.
    test("a var(--) assignment is caught (positive control)", () => {
        const fixture = [
            {
                file: "Fake.svelte",
                text:
                    "ctx.fillStyle = sel\n" +
                    '    ? "color-mix(in srgb, var(--velocity) 85%, transparent)"\n' +
                    '    : "color-mix(in srgb, var(--velocity) 55%, transparent)";\n' +
                    'ctx.strokeStyle = "var(--velocity)";',
            },
        ];
        const hits = styleVarHits(fixture);
        expect(hits.length).toBe(2);
        expect(hits.every((h) => h.file === "Fake.svelte")).toBe(true);
    });
});

describe("COLOR_VELOCITY — the timeline's own velocity-channel hue (editor-ui.md Mode vocabulary)", () => {
    // a new channel's whole point is to be its own meaning, not a re-hue of an existing one
    // (geo blue, force gold) — collision would read as "this is a force curve" or "this is
    // a geo section", which is exactly the drift the mode-vocabulary rule exists to catch.
    test("hue is distinct from both kind colors", () => {
        const v = hexToOklch(COLOR_VELOCITY).h;
        const geo = hexToOklch("#78a5d6").h;
        const force = hexToOklch("#d49560").h;
        const HueMin = 0.3; // radians — comfortably past perceptual hue-confusion range
        expect(Math.abs(v - geo)).toBeGreaterThan(HueMin);
        expect(Math.abs(v - force)).toBeGreaterThan(HueMin);
    });
});

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

// The glyph hover-lift source pin retired with the glyphs: `render.ts` draws the bake polyline
// and the cart at S2e-i, and force markers, node handles and tangent knobs went with the node
// substrate. What the lift DOES is still pinned behaviorally where a glyph survives
// (`tests/render.test.ts` reads a real `strokeStyle` off a recorded draw call); re-pointing a
// source-text pin at a renderer that no longer draws the glyph would pin nothing.

// the tangent-knob calibration (kex2d-burndown feel fix: one appearance, ink outline at rest,
// hover lifts both channels, no explicit/ghost fork) used to be a source-pin regex over
// `TangentDrawSystem`'s body text here. Retired (kex2d-followups follow-up 9): it re-derived
// the rule it checked (a renderer that called `hovered()` and then styled something else
// entirely still passed it). `tests/render.test.ts` now drives the real `TangentDrawSystem`
// over a recording `ctx` double and reads the actual `strokeStyle`/`fillStyle` at the knob's
// draw call, for an inferred AND an explicitly authored node both — the behavioral proof that
// no fork survives between them.

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

// kex2d-event-substrate S4, finding 4: an unselected velocity strip's fill wants a rung IN the
// palette, never a bare alpha drop or an invented hex — `dimmed`'s the same OKLCH move `hovered`
// makes, run the other way (darker, less saturated, hue held).
// ── the lane span's three rungs (S3b) ───────────────────────────────────────────────────────
// `laneTone` is the ONE seam that picks between `selected` and `hovered` for a span, so the row
// render carries no priority logic of its own and the priority is testable without a canvas.
describe("laneTone — the span's state rung, in the lane's own hue", () => {
    // RED: read `hover` before `selected` in `laneTone` and a selected span under the pointer
    // draws at the hover rung — the click stops showing on the thing it just picked.
    test("selection outranks hover, and both outrank base", () => {
        for (const lane of [Lane.Geo, Lane.Force, Lane.Velocity]) {
            const base = hexToOklch(laneTone(lane, "base")).l;
            const hover = hexToOklch(laneTone(lane, "hover")).l;
            const sel = hexToOklch(laneTone(lane, "selected")).l;
            expect(hover).toBeGreaterThan(base);
            expect(sel).toBeGreaterThan(hover);
        }
    });

    // RED: return a flat `COLOR_ACCENT` for a selected span and the force lane — whose own hue IS
    // the accent — reads as NOT selected, the exact defect the tone-variant law names.
    test("every rung holds its lane's own hue — a selected force span is not a flat accent", () => {
        for (const lane of [Lane.Geo, Lane.Force, Lane.Velocity]) {
            const h = hexToOklch(laneColor(lane)).h;
            expect(hexToOklch(laneTone(lane, "hover")).h).toBeCloseTo(h, 1);
            expect(hexToOklch(laneTone(lane, "selected")).h).toBeCloseTo(h, 1);
        }
        expect(laneTone(Lane.Force, "selected")).not.toBe(laneTone(Lane.Geo, "selected"));
        expect(laneTone(Lane.Force, "base")).toBe(laneColor(Lane.Force));
    });
});

describe("dimmed — the rung below base (S4, finding 4)", () => {
    const kinds = ["#78a5d6", "#d49560", COLOR_VELOCITY];

    test("drops lightness", () => {
        for (const base of kinds) {
            expect(hexToOklch(dimmed(base)).l).toBeLessThan(hexToOklch(base).l);
        }
    });

    test("preserves hue", () => {
        for (const base of kinds) {
            expect(hexToOklch(dimmed(base)).h).toBeCloseTo(hexToOklch(base).h, 1);
        }
    });

    test("reduces chroma too, never brightens or invents a hue", () => {
        for (const base of kinds) {
            expect(hexToOklch(dimmed(base)).c).toBeLessThan(hexToOklch(base).c);
        }
    });

    test("returns a well-formed lowercase 6-digit hex", () => {
        expect(dimmed("#010203")).toMatch(/^#[0-9a-f]{6}$/);
    });
});

// the unselected strip fill must derive through `dimmed(COLOR_VELOCITY)`, not the bare
// constant — a source-text pin, `colors.ts`'s own idiom for a canvas fillStyle with no cheap
// behavioral read (the S1 Visibility comment beside it names the same constraint).
describe("Timeline.svelte carries no false cursor-handler claim (S3)", () => {
    test("the retired `canvas.style.cursor` comment is gone", () => {
        const tl = readFileSync(new URL("../src/Timeline.svelte", import.meta.url), "utf8");
        expect(tl).not.toContain("canvas.style.cursor");
    });
});

// ── cursor allowlist (kex2d-followups follow-up 6): `cursor: grab | grabbing | pointer` is a
// real affordance channel (editor-ui.md Affordance typing — grab hands mean a pannable surface
// and nothing else; a direct-manipulation glyph keeps the arrow, `.rbtn` sheds it
// already), so a new occurrence anywhere in the tree is either a genuine pannable/clickable
// chrome affordance or a regression sneaking the cursor channel onto a glyph it doesn't belong
// on. CSS `cursor` has no cheap behavioral read, so this stays a SOURCE pin by design (the
// spec's locked decision) — the declared-registry law, editor-ui.md Menus. Two dialects wear the
// one channel: a `.svelte` CSS `cursor:` declaration, and a canvas `style.cursor = "…"`
// assignment in `.ts` (`controls.ts`'s pan-grabbing affordance — the single most on-point
// instance of the law, and the one dialect a `.svelte`-only glob would never reach).
//
// `ew-resize` joins the value set (kex2d-event-lane S5, finding 2): a trim/resize affordance
// names its axis with the cursor because nothing else does (root `ui.md` Fields — the field-row
// scrub is the same idiom), and the class already had two static instances (the field-row key
// scrub, the nav-window pan edge) plus one gesture-boundary instance (the force-section extent
// trim) before this stage added the velocity-strip span-edge trim as a fourth — an argued
// registry extension, not a widened value ad hoc: every `ew-resize` site in the tree is real
// trim/scrub chrome, none of them a regression.
//
// A span BODY joins `pointer` (kex2d-event-substrate S4, finding 1): the same mechanism as the
// `ew-resize` extension above — a genuine registry addition, argued by the class it joins
// (every other clickable/draggable body in the tree already carries `.clip`'s `cursor: pointer`)
// rather than a widened value ad hoc.

interface CursorSite {
    file: string;
    selector: string;
    value: "grab" | "grabbing" | "pointer" | "ew-resize";
}

// today's population, enumerated FROM THE SOURCE (`cursorSites()` below) — not hand-guessed: the
// panning pair (`.nav-window` grab/grabbing, `.body.panning` grabbing while the drag is live), the
// viewport's own pan-grabbing canvas assignment (`controls.ts`), every plain clickable affordance
// that carries `cursor: pointer` (the rail's snap toggle, the section clip strip, its append
// tail, the transport play button, the global scrubber, the two modal buttons, the shared
// menu-item class every context menu renders through, and the velocity-strip span body, S4), and
// every trim/scrub affordance that carries `cursor: ew-resize` (the two field-row key scrubs, the
// nav-window pan edge, the force-section extent trim, and the velocity-strip span-edge trim, S5).
const CURSOR_ALLOWLIST: CursorSite[] = [
    { file: "Timeline.svelte", selector: "button", value: "pointer" },
    { file: "Menu.svelte", selector: ".menu-item", value: "pointer" },
    { file: "Timeline.svelte", selector: ".scrub", value: "pointer" },
    { file: "controls.ts", selector: "canvas.style.cursor", value: "grabbing" },
    // the contextual popover (S3c): its dismissal button and its three easing picks are plain
    // clickable chrome, and each field's KEY is the scrub affordance the field law names — the
    // same `ew-resize` class the retired field rows carried, over the popover's own fields.
    { file: "Popover.svelte", selector: ".peel", value: "pointer" },
    { file: "Popover.svelte", selector: ".field label", value: "ew-resize" },
    { file: "Popover.svelte", selector: ".ease button", value: "pointer" },
];

/** every scanned source file's raw text — `.svelte` (CSS) and `.ts` (canvas assignments) alike,
 *  walked recursively (`Bun.Glob`, not `readdirSync` — the source-pin law, editor-ui.md Menus) —
 *  the one text corpus `cursorSites()`, its own scanner-level control, and `styleVarHits`
 *  (above) all read, so none of the three can drift over which files exist. */
function scannedFiles(): { file: string; text: string }[] {
    const src = fileURLToPath(new URL("../src", import.meta.url));
    const files = [
        ...new Bun.Glob("**/*.svelte").scanSync(src),
        ...new Bun.Glob("**/*.ts").scanSync(src),
    ];
    return files.map((f) => ({ file: f, text: readFileSync(`${src}/${f}`, "utf8") }));
}

/** walk every scanned file and collect every `cursor: grab|grabbing|pointer` CSS declaration
 *  (`.svelte` `<style>` blocks) or `style.cursor = "…"` canvas assignment (`.ts`), paired with the
 *  selector/expression that owns it — a real (if simple) CSS parse over non-nested rule blocks,
 *  not a per-line grep, so a multi-selector list or a doc comment sitting just above the rule
 *  still resolves to the one selector that owns the declaration. The CSS value regex tolerates
 *  BOTH a trailing `;` and a declaration that's last in its block (terminated by `}` instead), and
 *  an optional `!important` between the value and its terminator — a rule that closes without a
 *  semicolon, or wears `!important`, still resolves instead of going invisible to the scanner. */
function cursorSites(): CursorSite[] {
    const out: CursorSite[] = [];
    for (const { file, text } of scannedFiles()) {
        if (file.endsWith(".svelte")) {
            const style = text.match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? "";
            const blocks = style.match(/[^{}]+\{[^{}]*\}/g) ?? [];
            for (const b of blocks) {
                const m = b.match(
                    /cursor:\s*(grab|grabbing|pointer|ew-resize)\s*(?:!important)?\s*[;}]/,
                );
                if (!m) continue;
                const selector = b
                    .slice(0, b.indexOf("{"))
                    .replace(/\/\*[\s\S]*?\*\//g, "") // strip a doc comment sitting right above the rule
                    .trim()
                    .replace(/\s+/g, " ");
                out.push({ file, selector, value: m[1] as CursorSite["value"] });
            }
        } else {
            const re =
                /([A-Za-z0-9_.]+\.style\.cursor)\s*=\s*["'](grab|grabbing|pointer|ew-resize)["']/g;
            for (const m of text.matchAll(re))
                out.push({ file, selector: m[1], value: m[2] as CursorSite["value"] });
        }
    }
    return out;
}

const cursorKey = (s: CursorSite): string => `${s.file}::${s.selector}::${s.value}`;

describe("cursor allowlist — CSS declarations and canvas assignments, grab/grabbing/pointer only in a declared registry", () => {
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

    // the SCANNER-level control (kex2d-followups finding 1): the two directions above prove the
    // set-difference LOGIC, never the block parser that produced `cursorSites()` in the first
    // place — a parser that silently drops a real declaration (an unhandled brace shape, a
    // trailing-`;` regression) shrinks both sides of every diff above together and stays green. A
    // raw, structure-free regex count over the same scanned corpus is an INDEPENDENT read of the
    // same text — it can't miss what the block parser misses, so the two counts must agree.
    test("scanner-level control: raw cursor declarations match the parsed site count exactly", () => {
        const raw = scannedFiles().reduce(
            (n, { text }) =>
                n +
                (text.match(/cursor\s*[:=]\s*["']?(grab|grabbing|pointer|ew-resize)["']?/g) ?? [])
                    .length,
            0,
        );
        expect(raw).toBe(cursorSites().length);
    });
});

// ── the lane color law (S3): the authored twin of `kindColor` ──
test("laneColor: velocity green, force accent, geo blue — one color per parameter", () => {
    expect(laneColor(Lane.Velocity)).toBe(COLOR_VELOCITY);
    expect(laneColor(Lane.Force)).toBe(COLOR_FORCE);
    expect(laneColor(Lane.Geo)).toBe(COLOR_GEO);
    // the derived-run twin agrees where the two languages overlap: a pitch run draws geo blue
    // and a force run the accent, so a span and the run it derives never disagree on hue.
    expect(laneColor(Lane.Geo)).toBe(kindColor(SectionKind.Geo));
    expect(laneColor(Lane.Force)).toBe(kindColor(SectionKind.Force));
});
