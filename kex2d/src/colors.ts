import type { State } from "@dylanebert/shallot";
import { SectionKind, sectionInfo, sections } from "./track";

/** the kind color language (`ui.md`): geo = cool blue, force = accent gold. Same values
 *  as App.svelte's `--geo`/`--accent`/`--snap` CSS custom properties (the clip strip's
 *  colors, Timeline.svelte) — this is the canvas-side home for every color the render
 *  systems draw. One hue, two surfaces. */
export const COLOR_GEO = "#78a5d6"; // rgb(120, 165, 214)
/** the primary editor accent — the selection highlight + the cart direction marker. */
export const COLOR_ACCENT = "#d49560"; // rgb(212, 149, 96)
/** the force-section kind color. it borrows the primary accent (force = accent gold), but
 *  is a distinct concept: a re-hue of one must not silently drag the other. */
export const COLOR_FORCE = COLOR_ACCENT;
/** the snap alignment-guide flash (timeline + viewport magnet feedback), distinct from
 *  kind / infeasible / selection. */
export const COLOR_SNAP = "#e879b0";

export function kindColor(kind: SectionKind): string {
    return kind === SectionKind.Force ? COLOR_FORCE : COLOR_GEO;
}

/** one span per baked section, in chain order: its stable id, kind, resolved kind
 *  color, and its sample range on the flat baked SoA (`sectionInfo`). Skips a section
 *  with no bake info yet (mid-bake / just-created). The shared substrate behind every
 *  kind-colored surface — the viewport polyline (render.ts), the timeline chart curve
 *  and navigator minimap (Timeline.svelte) — each walks these segments and does its
 *  own projection (screen xs/ys, chart `sToPx`/`yOf`, the nav's own mapping) and any
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
