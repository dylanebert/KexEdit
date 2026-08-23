/** the track-global domain, as an editor command — the ruler-menu pick.
 *
 * `Track.domain` says what unit the ruler, every readout, the chart's x-positions and the
 * Time-view gestures DISPLAY a force section's keyframes and extent in. It is a **view**, not a
 * document conversion: every force keyframe, extent, strip and strip keyframe is stored in
 * meters of arclength always (`track.ts`'s `Force`/`Strip`/`StripKeyframe` columns), and a Time
 * reading is a lens over the live bake's s↔t table (`timeline.ts`'s `dToU`/`uToD`, the same seam
 * geo nodes already project through). A flip therefore writes exactly one column
 * (`Track.domain`) and nothing else: it changes no authored component and no bake hash, in
 * either direction, forever.
 *
 * Proven reference: a DAW's tempo map (Ableton/Logic) — clips stored in beats, the seconds ruler
 * derived, a tempo change moves the seconds positions and never the music. Here arclength is the
 * beat grid and `v(s)` is the tempo map.
 *
 * This replaces the prior document-conversion op (`carryForce`/`resolutionFloor`/
 * `storeQuantum`/`Force.carried`, the tagged-subdivision carry that rewrote every keyframe's
 * stored number on a flip): a cubic in (s, g) was never carried exactly to a cubic in (t, g)
 * under the nonlinear arc↔time map, so that scheme subdivided to a resolution-floor tolerance
 * and the extent didn't round-trip at all (25.37 → 99.53 m, 3.36 → 5927.96 s on one tagged
 * flip). Storing one canonical parameter and reading the other off the bake is exact by
 * construction instead of exact to a tolerance. */

import type { State } from "@dylanebert/shallot";
import { type History, landDomain } from "./history";
import type { Domain } from "./section";
import { bakeLive, SectionKind, sectionInfo, sections, trackDomain } from "./track";

/** whether `convertDomain` can run at all. A flip is a pure view write now — it never touches
 * the store — but the ruler menu still grays a row it cannot honor: with no live bake, or a
 * force section placed past the sample budget (its own baked range degenerate, `start === end`),
 * there is nothing yet to READ the picked domain through (a Time reading needs the live bake's
 * s↔t table, and a section off the bake has no station on it), so the row stays disabled until
 * every force section has one. Geo sections are position-authored in either domain and never
 * gate this.
 *
 * @example if (!convertible(ecs)) return; // nothing to display through yet
 */
export function convertible(ecs: State): boolean {
    if (!bakeLive(ecs)) return false;
    for (const sec of sections(ecs)) {
        if (sec.kind !== SectionKind.Force) continue;
        const info = sectionInfo.get(sec.id);
        if (!info || info.endSample <= info.startSample) return false;
    }
    return true;
}

/** whether the ruler menu's row for `target` is enabled — the ONE enablement rule, pure and
 *  unit-tested (`editor-ui.md`: enablement is a predicate, not a per-menu special case).
 *
 *  The ACTIVE row is always enabled: picking it is a no-op by the menu law, and graying the row
 *  that says what the chart already reads would read as a fault. Every other row is enabled
 *  exactly when a live bake exists to read it through (`convertible`).
 *
 * @example { label: "Seconds", enabled: pickable(ecs, Domain.Time) }
 */
export function pickable(ecs: State, target: Domain): boolean {
    return trackDomain(ecs) === target || convertible(ecs);
}

/** the readout for a domain pick that failed, plus the raw detail for the console —
 * `editor.solveFailed`'s shape. A flip is now a single column write with nothing left to throw
 * on, so this exists only as the surface's error-shape contract; kept so a caller doesn't need
 * two different failure idioms depending on which command it invoked.
 *
 * @example const { notice, detail } = convertFailed(e); console.error(detail); notify("error", notice)
 */
export function convertFailed(e: unknown): { notice: string; detail: string } {
    return {
        notice: "The units could not be switched. Nothing changed.",
        detail: e instanceof Error ? (e.stack ?? e.message) : String(e),
    };
}

/** flip the track-global domain — the ruler-menu pick, as one undoable entry. Writes
 * `Track.domain` alone: every force keyframe, extent, strip and strip keyframe stays in meters
 * of arclength, so the flip changes no authored component and no bake hash.
 *
 * Returns false, having written nothing and recorded nothing, when the target domain is already
 * active (the ruler menu's active row is a no-op) or when `convertible` reads false (no live
 * bake to read the picked domain through yet). Otherwise returns true.
 *
 * @example convertDomain(history, ecs, Domain.Time) // → true, one undo entry
 */
export function convertDomain(h: History, ecs: State, target: Domain): boolean {
    if (trackDomain(ecs) === target) return false;
    if (!convertible(ecs)) return false;
    landDomain(h, ecs, target);
    return true;
}
