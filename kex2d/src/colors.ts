import type { State } from "@dylanebert/shallot";
import { SectionKind, sectionInfo, sections } from "./track";

/** the kind color language (`ui.md`): geo = cool blue, force = accent gold. Same values
 *  as App.svelte's `--geo`/`--accent`/`--guide` CSS custom properties (the clip strip's
 *  colors, Timeline.svelte) — this is the canvas-side home for every color the render
 *  systems draw. One hue, two surfaces. */
export const COLOR_GEO = "#78a5d6"; // rgb(120, 165, 214)
/** the primary editor accent — the selection highlight + the cart direction marker. */
export const COLOR_ACCENT = "#d49560"; // rgb(212, 149, 96)
/** the force-section kind color. it borrows the primary accent (force = accent gold), but
 *  is a distinct concept: a re-hue of one must not silently drag the other. */
export const COLOR_FORCE = COLOR_ACCENT;
/** the snap-guide neutral — every snap guide's color, viewport and timeline alike (feel round
 *  3 retired the magenta stateful/neutral split: one guide is one register). The viewport
 *  incline ray and the timeline's s/g snap lines all wear this quiet gray (the app's anchor
 *  gray). Mirrors App.svelte's `--guide` CSS custom property (Timeline.svelte's `.snapguide`).
 *  The numeric °/m readout is DOM now (the snap readout centered below the dragged node, styled
 *  off the `--fg` token), so no canvas label color lives here. */
export const COLOR_GUIDE_RAY = "#9aa0a6";

/** the out-of-scope dim wash (`editor-ui.md` Mode vocabulary): while a mode is open,
 *  everything outside its subject steps back one rung under this wash — one meaning, both
 *  surfaces. Mirrors App.svelte's `--dim` CSS custom property (Timeline.svelte's `.mode-dim`
 *  rects); pinned equal in colors.test.ts. On the canvas it is drawn OVER the element's own
 *  shapes (the timeline's topmost-rect compositing, per element), never a recolor. */
export const DIM_WASH = "rgba(22, 20, 19, 0.55)";

export function kindColor(kind: SectionKind): string {
    return kind === SectionKind.Force ? COLOR_FORCE : COLOR_GEO;
}

/** the selection tone-variant knobs — how a selected element's own color brightens (the
 *  Ableton/Premiere selected-clip idiom). derived in OKLCH so the variant stays vivid: an
 *  sRGB mix toward white drains chroma (white has none), reading washed out. lift lightness,
 *  boost chroma, hold hue. both feel-provisional. the CSS twin is the relative-color
 *  `oklch(from var(--token) calc(l + 0.14) calc(c * 1.15) h)` over the same kind tokens
 *  (App.svelte `--geo-sel`/`--accent-sel`), the same two numbers. */
export const SELECT_L_LIFT = 0.14; // OKLCH lightness added (0–1 scale)
export const SELECT_C_BOOST = 1.15; // OKLCH chroma multiplier

/** an element's selection color: its own base color as a brighter, still-saturated OKLCH
 *  variant (lightness lifted, chroma boosted, hue held) — never a flat accent recolor, which
 *  reads as no-selection on a force span's own gold. derived over the hex so the canvas
 *  render systems get a concrete value, gamut-clamped back into sRGB. */
export function selected(base: string): string {
    const { l, c, h } = hexToOklch(base);
    return oklchToHex(l + SELECT_L_LIFT, c * SELECT_C_BOOST, h);
}

/** the hover rung's share of the selection step. derived from the clip strip, where both rungs
 *  already exist over one background (`Timeline.svelte`: base fill 28% → hover 42% of the kind
 *  token, selected `--geo-sel`/`--accent-sel` at 60%): composite those three over the dock surface
 *  and hover's OKLCH lightness step is 0.29 of the selection's — 0.288 to 0.297 across both kind
 *  colors and every surface tone the clips sit on. so the canvas twin sits at the same relative
 *  height in the stack instead of copying an alpha that means nothing to an opaque stroke. */
export const HOVER_STEP = 0.3;

/** an element's hover color: its own base color one rung up — the same OKLCH move `selected`
 *  makes, at `HOVER_STEP` of its size, hue held. the canvas twin of the clip strip's hover fill,
 *  a step below the selection lift, and one knob so a feel round retunes the rung alone. */
export function hovered(base: string): string {
    const { l, c, h } = hexToOklch(base);
    return oklchToHex(
        l + SELECT_L_LIFT * HOVER_STEP,
        c * (1 + (SELECT_C_BOOST - 1) * HOVER_STEP),
        h,
    );
}

// ── OKLab / OKLCH (Björn Ottosson): sRGB hex ⇆ OKLCH, the perceptual space the selection
// tone-variant derives in — a uniform white-mix in sRGB desaturates; OKLCH holds chroma. ──

const srgbToLinear = (v: number): number =>
    v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const linearToSrgb = (v: number): number =>
    v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;

/** sRGB hex (`#rrggbb`) → OKLCH: `l` in 0–1, `c` ≥ 0, `h` in radians. */
export function hexToOklch(hex: string): { l: number; c: number; h: number } {
    const n = Number.parseInt(hex.slice(1), 16);
    const lr = srgbToLinear(((n >> 16) & 0xff) / 255);
    const lg = srgbToLinear(((n >> 8) & 0xff) / 255);
    const lb = srgbToLinear((n & 0xff) / 255);
    const p = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const q = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const t = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    const okl = 0.2104542553 * p + 0.793617785 * q - 0.0040720468 * t;
    const oka = 1.9779984951 * p - 2.428592205 * q + 0.4505937099 * t;
    const okb = 0.0259040371 * p + 0.7827717662 * q - 0.808675766 * t;
    return { l: okl, c: Math.hypot(oka, okb), h: Math.atan2(okb, oka) };
}

/** OKLCH → linear sRGB (may fall outside [0,1] when the color leaves the gamut). */
function oklchToLinear(l: number, c: number, h: number): [number, number, number] {
    const a = c * Math.cos(h);
    const b = c * Math.sin(h);
    const p = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const q = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const t = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
        4.0767416621 * p - 3.3077115913 * q + 0.2309699292 * t,
        -1.2684380046 * p + 2.6097574011 * q - 0.3413193965 * t,
        -0.0041960863 * p - 0.7034186147 * q + 1.707614701 * t,
    ];
}

const inGamut = (rgb: [number, number, number]): boolean =>
    rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/** OKLCH → sRGB hex, hue-preservingly gamut-mapped: hold `l` and `h`, reduce chroma by
 *  bisection until the color is in the sRGB gamut. matches how a browser resolves the CSS
 *  `oklch(from …)` twin (CSS Color 4 maps by chroma reduction, not per-channel clamp), so the
 *  canvas value and the clip-strip token land on the same color. */
function oklchToHex(l: number, c: number, h: number): string {
    let ch = c;
    if (!inGamut(oklchToLinear(l, ch, h))) {
        let lo = 0;
        let hi = c;
        for (let i = 0; i < 24; i++) {
            const mid = (lo + hi) / 2;
            if (inGamut(oklchToLinear(l, mid, h))) lo = mid;
            else hi = mid;
        }
        ch = lo;
    }
    const [r, g, b] = oklchToLinear(l, ch, h);
    const to = (v: number): number => Math.round(Math.min(1, Math.max(0, linearToSrgb(v))) * 255);
    return `#${((to(r) << 16) | (to(g) << 8) | to(b)).toString(16).padStart(6, "0")}`;
}

/** one span per baked section, in chain order: its stable id, kind, resolved kind
 *  color, and its sample range on the flat baked SoA (`sectionInfo`). Skips a section
 *  with no bake info yet (mid-bake / just-created). The shared substrate behind every
 *  kind-colored surface — the viewport polyline (render.ts), the timeline chart curve
 *  and navigator minimap (Timeline.svelte) — each walks these segments and does its
 *  own projection (screen xs/ys, chart `uToPx`/`yOf`, the nav's own mapping) and any
 *  surface-specific overlay (the viewport's infeasible/selection passes); this
 *  function is the one place that loops sections and resolves kind → color. */
export interface KindSegment {
    id: number;
    kind: SectionKind;
    color: string;
    startSample: number;
    endSample: number;
}

export function kindSegments(ecs: State): KindSegment[] {
    const segs: KindSegment[] = [];
    for (const sec of sections(ecs)) {
        const info = sectionInfo.get(sec.id);
        if (!info) continue;
        segs.push({
            id: sec.id,
            kind: sec.kind,
            color: kindColor(sec.kind),
            startSample: info.startSample,
            endSample: info.endSample,
        });
    }
    return segs;
}
