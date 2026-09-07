/** box / marquee selection — the pure geometry + merge, device-free (no ECS, no DOM, no view
 *  transform). the two authoring surfaces feed it screen-space candidate points (viewport geo
 *  nodes / timeline force diamonds) and apply the merged result through the selection substrate
 *  (`editor.ts`). targets are points, so intersect-vs-contain is moot — point-in-rect (the locked
 *  decision: "targets are points"). */

import { type Selection, toggleMember } from "./editor";

/** a normalized axis-aligned box in screen px — `min ≤ max` on both axes, so the four drag
 *  directions all read the same (a bottom-right→top-left drag is the same rect as its reverse). */
export interface Rect {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

/** a marquee candidate: a target's stable key (a node eid or a force stable id) + its screen
 *  point. the surface builds these; the module never touches the ECS. */
export interface Candidate {
    id: number;
    x: number;
    y: number;
}

/** normalize a drag's two corners into a min/max box — any drag direction yields the same rect. */
export function normRect(x0: number, y0: number, x1: number, y1: number): Rect {
    return {
        minX: Math.min(x0, x1),
        minY: Math.min(y0, y1),
        maxX: Math.max(x0, x1),
        maxY: Math.max(y0, y1),
    };
}

/** the candidate ids whose points fall inside `rect` (boundary inclusive), in candidate order. */
export function hits(rect: Rect, candidates: Iterable<Candidate>): number[] {
    const out: number[] = [];
    for (const c of candidates)
        if (c.x >= rect.minX && c.x <= rect.maxX && c.y >= rect.minY && c.y <= rect.maxY)
            out.push(c.id);
    return out;
}

/** merge a marquee hit set into the current selection, producing the resulting members + active
 *  (does not mutate `current`). the surface applies the result atomically through the substrate.
 *
 *  - **replace** (plain marquee): the hit set becomes the selection, its last member active; an
 *    empty hit set clears it (deselect-all, consistent with click-empty).
 *  - **toggle** (shift+marquee): each hit toggles membership against the current set — reusing the
 *    substrate's `toggleMember`, so the add-and-activate / remove-and-promote rule has one home. */
export function merge(
    current: Selection,
    hitIds: number[],
    mode: "replace" | "toggle",
): { ids: number[]; active: number | null } {
    if (mode === "replace")
        return { ids: [...hitIds], active: hitIds.length ? hitIds[hitIds.length - 1] : null };
    const sel: Selection = { ids: new Set(current.ids), active: current.active };
    for (const id of hitIds) toggleMember(sel, id);
    return { ids: [...sel.ids], active: sel.active };
}
