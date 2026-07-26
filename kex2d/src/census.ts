/** the VOCABULARY CENSUS: which tangent-mode shape a force keyframe's two handles form.
 *
 *  the editor's handle vocabulary is discrete (`editor-ui.md` Tangent editing: Mirror |
 *  Aligned | Free), so "how authorable is this profile" is a count over that vocabulary,
 *  not a continuous score — a key whose two sides are *almost* collinear still reads Free
 *  in the menu and still draws as a kink. This module is the instrument that counts it,
 *  pure and framework-free so the fit lab's overlay and the solver's authorability
 *  asserts make the identical judgment (extracted from `fitlab.ts`, which drew it first).
 *
 *  **the judgment is made in SCREEN space**, which is where it lives: the (s, g) axes
 *  carry different units, so an angle in data space would be a made-up number, while half
 *  a CSS pixel of break is a break nobody can see. That makes the surface's scale part of
 *  the judgment, not a nuisance parameter — a bend legible on a zoomed-in chart is not one
 *  on a zoomed-out chart, and both readings are correct for their surface. Only the
 *  MAGNITUDES of `Scale` matter, so a flipped axis (canvas y grows down) classifies
 *  identically. */

import type { ForcePoint } from "./profile";

/** a handle pair reads as collinear when the off-line tip sits within half a CSS pixel of
 *  the other side's ray. Derived from the display, which is where the judgment lives: a
 *  sub-pixel break is not a break anyone can see. */
export const ALIGN_PX = 0.5;

/** how a keyframe's two handles sit relative to each other — the editor's tangent-mode
 *  vocabulary, read off the drawn geometry. */
export type HandleState = "mirror" | "aligned" | "broken" | "single";

export interface HandleStats {
    mirror: number;
    aligned: number;
    broken: number;
    /** a keyframe carrying fewer than two explicit handles: a chain end, or a key still
     *  on its derived easing tangents. There is no second side to break against. */
    single: number;
}

/** the surface's px per unit on each axis — `s` metres of arclength, `g` of force. */
export interface Scale {
    s: number;
    g: number;
}

/** classify one keyframe's handles: collinear-through-the-key within `ALIGN_PX`, and
 *  mirrored when the two screen lengths match too. A side pointing the same way as the
 *  other (a cusp) is broken by construction, as is a side too short on the surface to
 *  carry a direction at all. */
export function handleState(p: ForcePoint, sc: Scale): HandleState {
    if (!(sc.s > 0) || !(sc.g > 0) || !Number.isFinite(sc.s) || !Number.isFinite(sc.g))
        throw new Error(`census: scale must be finite and > 0, got ${sc.s}, ${sc.g}`);
    if (!p.in || !p.out) return "single";
    const ux = p.in.ds * sc.s;
    const uy = p.in.dg * sc.g;
    const wx = p.out.ds * sc.s;
    const wy = p.out.dg * sc.g;
    const lu = Math.hypot(ux, uy);
    const lw = Math.hypot(wx, wy);
    if (lu < ALIGN_PX || lw < ALIGN_PX) return "broken"; // a collapsed side has no direction
    if (ux * wx + uy * wy >= 0) return "broken"; // a cusp: both sides reach the same way
    if (Math.abs(ux * wy - uy * wx) / Math.min(lu, lw) > ALIGN_PX) return "broken";
    return Math.abs(lu - lw) <= ALIGN_PX ? "mirror" : "aligned";
}

/** the whole profile's census — one count per vocabulary state, summing to the keyframe
 *  count. `broken` is the authorability number: keys an author would meet as `Free`. */
export function census(points: readonly ForcePoint[], sc: Scale): HandleStats {
    const stats: HandleStats = { mirror: 0, aligned: 0, broken: 0, single: 0 };
    for (const p of points) stats[handleState(p, sc)]++;
    return stats;
}
