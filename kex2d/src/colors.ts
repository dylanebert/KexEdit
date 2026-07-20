import { SectionKind } from "./track";

/** the kind color language (`ui.md`): geo = cool blue, force = accent gold. Same values
 *  as App.svelte's `--geo`/`--accent` CSS custom properties (the clip strip's colors,
 *  Timeline.svelte) — this is the canvas-side mirror for the viewport track polyline
 *  (render.ts, `strokeStyle`). One hue, two surfaces. */
export const COLOR_GEO = "#78a5d6"; // rgb(120, 165, 214)
export const COLOR_FORCE = "#d49560"; // rgb(212, 149, 96)

export function kindColor(kind: SectionKind): string {
    return kind === SectionKind.Force ? COLOR_FORCE : COLOR_GEO;
}
