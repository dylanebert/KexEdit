import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COLOR_VELOCITY, DIM_WASH, dimmed, hexToOklch, hovered, selected } from "../src/colors";
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

describe("hover outline lift — a glyph's ink stroke joins its hovered tone (kex2d-idioms 10b)", () => {
    test("render.ts derives every glyph hover stroke through hovered(), never a literal", () => {
        // the color channel is hover's ONE channel: on hover a viewport glyph's dark ink stroke
        // lifts to the same hovered() tone its fill wears — silhouette contrast without a size
        // change. force markers resolve through the helper; the boundary anchor's own lift is
        // now proven behaviorally (`tests/render.test.ts` reads the actual `strokeStyle` off a
        // recorded draw call, not this source text — kex2d-followups follow-up 9).
        const render = readFileSync(new URL("../src/render.ts", import.meta.url), "utf8");
        // presence, never an occurrence COUNT: a count breaks on a legitimate hoist into a local
        // and passes on a tone computed and never used. What the lift DOES is pinned honestly by
        // the harness ray-run off the real canvas (`harness/force.pw.ts` step 4b) — this only
        // pins that the tone comes from the shared helper rather than a hand-written literal.
        expect(render.includes("hovered(COLOR_FORCE)")).toBe(true);
        // the grow channel is OUT (user feel verdict): no hover radius scaling anywhere.
        expect(render.includes("HOVER_GROW")).toBe(false);
    });

    test("Timeline.svelte lifts both glyph strokes to the selection token at base width", () => {
        // the rung below selection: hover borrows selection's stroke token (--fg) but at the
        // base 1px width and without the accent fill — selected keeps 1.4px + accent, so the
        // two registers stay distinguishable by weight and fill, never by a size change.
        const tl = readFileSync(new URL("../src/Timeline.svelte", import.meta.url), "utf8");
        // per-glyph presence, not a rule count. The `.fmarker` lift is behavior-pinned by the
        // harness computed-style probe (`harness/force.pw.ts` step 4c). Its `.tknob` twin (the
        // summoned force-handle knob) left with the explicit per-keyframe force handles it
        // rendered, `kex2d-segment-removal` S3.
        const lifted = (sel: RegExp): boolean =>
            new RegExp(`${sel.source}\\s*\\{[^}]*stroke: var\\(--fg\\)`, "s").test(tl);
        expect(lifted(/\.fpt:hover[^{]*\.fmarker/)).toBe(true);
        // no geometry channel remains: no grow var, no hover scale transform.
        expect(tl.includes("--hover-grow")).toBe(false);
        expect(tl.includes("scale(var(--hover-grow))")).toBe(false);
    });
});

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
describe("Timeline.svelte's unselected strip fill is dimmed, in-palette (S4, finding 4)", () => {
    test("fillStyle derives dimmed(COLOR_VELOCITY) for the base (unselected, unhovered) rung", () => {
        const tl = readFileSync(new URL("../src/Timeline.svelte", import.meta.url), "utf8");
        expect(tl).toContain("dimmed(COLOR_VELOCITY)");
    });
});

// S3 (Affordances): the header band's hit zone used to carry a comment claiming the trim/
// body-drag cursor was "set programmatically via `canvas.style.cursor` in the pointermove
// handler" — no such handler exists anywhere in the file (`cursorSites()` below finds no
// `canvas.style.cursor` assignment in `Timeline.svelte`, and the S3 premise correction in the
// spec's Live log names this as the false claim it is). The declared-registry CSS classes
// (`.hbandzone.body-hover`/`.edge-hover`) carry the affordance instead, alongside the
// hover-rung fill/stroke lift, never a canvas-set style. Source-text arm, the same idiom as
// the cursor allowlist below: the claim has no cheap behavioral read.
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
// nav-window pan edge, the classifier-published segment edge, and the velocity-strip span edge).
const CURSOR_ALLOWLIST: CursorSite[] = [
    { file: "App.svelte", selector: ".pinpanel button", value: "pointer" },
    { file: "App.svelte", selector: ".convert .cancel", value: "pointer" },
    { file: "App.svelte", selector: ":global(.menu-item)", value: "pointer" },
    { file: "App.svelte", selector: ".vtip .key", value: "ew-resize" },
    { file: "Timeline.svelte", selector: ".rail-tool", value: "pointer" },
    { file: "Timeline.svelte", selector: ".body.panning, .body.panning *", value: "grabbing" },
    { file: "Timeline.svelte", selector: ".nav-window", value: "grab" },
    { file: "Timeline.svelte", selector: ".nav-window:active", value: "grabbing" },
    { file: "Timeline.svelte", selector: ".nav-edge", value: "ew-resize" },
    { file: "Timeline.svelte", selector: ".clip", value: "pointer" },
    { file: "Timeline.svelte", selector: ".chartzone.edge-hover", value: "ew-resize" },
    { file: "Timeline.svelte", selector: ".chartzone.knob-hover", value: "grab" },
    { file: "Timeline.svelte", selector: ".clip-add", value: "pointer" },
    { file: "Timeline.svelte", selector: ".play", value: "pointer" },
    { file: "Timeline.svelte", selector: ".scrub", value: "pointer" },
    { file: "Timeline.svelte", selector: ".fld .key", value: "ew-resize" },
    { file: "Timeline.svelte", selector: ".hbandzone.body-hover", value: "pointer" },
    { file: "Timeline.svelte", selector: ".hbandzone.edge-hover", value: "ew-resize" },
    { file: "controls.ts", selector: "canvas.style.cursor", value: "grabbing" },
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

// ── disabled-affordance registry (S10, kex2d-event-substrate F8): "a field that cannot be
// edited owes a disabled APPEARANCE, not just a disabled attribute" (the taste ledger's own
// generalizing rule) — the `.fld` stylesheet carried no `:disabled` rule at all before this
// stage, so the always-locked one-shot position field and the pin-mode-locked value field
// rendered identically to a live one. `cursor`/`opacity` has no cheap behavioral read (the same
// reason the cursor allowlist above is a SOURCE pin, editor-ui.md Menus' declared-registry law),
// so this is a source pin too — same shape, both directions, a positive control per direction,
// and the scanner-level control the cursor allowlist's own bug earned (an independent raw count
// over the same corpus, so a block parser gone blind on a shape it doesn't handle can't pass by
// shrinking both sides of the diff together).

interface DisabledSite {
    file: string;
    selector: string;
    // the rule's own declared property names, sorted + joined — the treatment's shape, standing
    // in for `cursorKey`'s single `value` (a disabled treatment sets more than one property).
    props: string;
}

// today's population, enumerated FROM THE SOURCE (`disabledSites()` below): the pre-existing
// grayed-row/grayed-button treatment (menu rows, the pinpanel buttons, the append tail) plus
// this stage's own addition — the `.fld` input itself (dimmed, default cursor, the same
// treatment) and the label/unit siblings a disabled input drags down with it, reached through
// `:has()` rather than a second flag threaded from script.
const DISABLED_ALLOWLIST: DisabledSite[] = [
    {
        file: "App.svelte",
        selector: ".pinpanel button:not(:disabled):hover",
        props: "background,border-color,color",
    },
    { file: "App.svelte", selector: ".pinpanel button:disabled", props: "cursor,opacity" },
    {
        file: "App.svelte",
        selector: ":global(.menu-item:not(:disabled):hover)",
        props: "background,color",
    },
    { file: "App.svelte", selector: ":global(.menu-item:disabled)", props: "cursor,opacity" },
    { file: "Timeline.svelte", selector: ".clip-add:disabled", props: "cursor,opacity" },
    { file: "Timeline.svelte", selector: ".clip-add:disabled:hover", props: "background,color" },
    { file: "Timeline.svelte", selector: ".fld input:disabled", props: "cursor,opacity" },
    { file: "Timeline.svelte", selector: ".fld:has(input:disabled) .key", props: "cursor" },
    {
        file: "Timeline.svelte",
        selector: ".fld:has(input:disabled) .key:hover",
        props: "background,color",
    },
    { file: "Timeline.svelte", selector: ".fld:has(input:disabled) .unit", props: "opacity" },
];

/** walk every scanned `.svelte` file's `<style>` block (the same corpus `cursorSites()` reads)
 *  and collect every rule whose selector text mentions `:disabled` — a real block parse, not a
 *  per-line grep, so a rule spanning several lines still resolves to the one selector that owns
 *  it. `props` is the rule body's own declared property names, sorted, so two rules setting the
 *  same properties in a different order still key identically. */
function disabledSites(): DisabledSite[] {
    const out: DisabledSite[] = [];
    for (const { file, text } of scannedFiles()) {
        if (!file.endsWith(".svelte")) continue;
        const style = text.match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? "";
        const blocks = style.match(/[^{}]+\{[^{}]*\}/g) ?? [];
        for (const b of blocks) {
            const open = b.indexOf("{");
            const selector = b
                .slice(0, open)
                .replace(/\/\*[\s\S]*?\*\//g, "")
                .trim()
                .replace(/\s+/g, " ");
            if (!selector.includes(":disabled")) continue;
            const body = b.slice(open + 1, b.lastIndexOf("}"));
            const props = [...body.matchAll(/([a-z-]+)\s*:/g)]
                .map((m) => m[1])
                .sort()
                .join(",");
            out.push({ file, selector, props });
        }
    }
    return out;
}

const disabledKey = (s: DisabledSite): string => `${s.file}::${s.selector}::${s.props}`;

describe("disabled-affordance registry — every `:disabled`-scoped rule declared, both directions (S10, F8)", () => {
    test("the glob reaches at least one disabled-scoped rule", () => {
        expect(disabledSites().length).toBeGreaterThan(0);
    });

    test("every found disabled-scoped rule is declared in the registry", () => {
        const declared = new Set(DISABLED_ALLOWLIST.map(disabledKey));
        const undeclared = disabledSites().filter((s) => !declared.has(disabledKey(s)));
        expect(undeclared).toEqual([]);
    });

    test("every registry entry corresponds to a real disabled-scoped rule in source", () => {
        const found = new Set(disabledSites().map(disabledKey));
        const orphans = DISABLED_ALLOWLIST.filter((s) => !found.has(disabledKey(s)));
        expect(orphans).toEqual([]);
    });

    // the positive control, both directions (the source-pin law, editor-ui.md Menus): an
    // undeclared rule and an orphan registry entry must each be CAUGHT.
    test("an undeclared disabled-scoped rule is caught (positive control)", () => {
        const bogus: DisabledSite = {
            file: "Fake.svelte",
            selector: ".bogus:disabled",
            props: "color",
        };
        const found = [...disabledSites(), bogus];
        const declared = new Set(DISABLED_ALLOWLIST.map(disabledKey));
        expect(found.some((s) => !declared.has(disabledKey(s)))).toBe(true);
    });

    test("an orphan registry entry is caught (positive control)", () => {
        const bogus: DisabledSite = {
            file: "Fake.svelte",
            selector: ".bogus:disabled",
            props: "color",
        };
        const registry = [...DISABLED_ALLOWLIST, bogus];
        const found = new Set(disabledSites().map(disabledKey));
        expect(registry.some((s) => !found.has(disabledKey(s)))).toBe(true);
    });

    // the SCANNER-level control (the cursor allowlist's own bug, above): the two directions prove
    // the set-difference LOGIC, never the block parser — an independent raw count of `:disabled`
    // occurrences inside `<style>` text must equal the parsed site count, since each of today's
    // rules names exactly one selector carrying exactly one `:disabled` token.
    test("scanner-level control: raw `:disabled`-in-style occurrences match the parsed site count", () => {
        const raw = scannedFiles().reduce((n, { file, text }) => {
            if (!file.endsWith(".svelte")) return n;
            const style = text.match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? "";
            return n + (style.match(/:disabled/g) ?? []).length;
        }, 0);
        expect(raw).toBe(disabledSites().length);
    });
});
