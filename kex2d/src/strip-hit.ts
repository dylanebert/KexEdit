/** the velocity-strip header band's pure hit-test classifier — "by interval
 *  membership, never rendered pixels" (Locked decision): given the pointer's band-local x and the
 *  band's strips already projected to screen x (`Timeline.svelte`'s own `uPx` lens does the
 *  projection; this module never touches a coordinate system, a canvas, or the DOM), it answers
 *  which part of which strip — or nothing — sits under the pointer. Tested directly, off-DOM
 *  (`tests/strip-hit.test.ts`), the same way `controls.pickHover`'s pieces are.
 *
 *  Endpoint beats body (the clip-trim-over-clip-body precedence `Timeline.svelte`'s force-section
 *  extent trim already uses): a hit within `radius` of either boundary reads as the RESIZE
 *  affordance even when it's also inside the strip's own span, so an endpoint near a body's edge
 *  stays reachable. Strips are tested in the order given (their own `start`-sorted order,
 *  `sectionStrips`'), so an adjacent pair's shared boundary — the abutment `stripEdgeRange`
 *  disambiguates in edge space (`track.ts`) — resolves to whichever strip's own edge the caller
 *  listed first; the boundary tick is the visual disambiguator, this classifier just has to be
 *  deterministic, not "correct" about which of two coincident edges wins. */

export interface StripHitCandidate {
    id: number;
    x0: number; // the strip's start edge, screen px
    x1: number; // the strip's end edge, screen px (equal to x0 for a degenerate point strip)
}

export type StripHit =
    | { kind: "endpoint"; id: number; edge: "start" | "end" }
    | { kind: "glyph"; id: number }
    | { kind: "body"; id: number }
    | { kind: "empty" };

/** classify a band-local pointer x against a set of already-projected strips, within a pixel
 *  `radius` of an endpoint. `strips` need not be sorted — the caller's own draw order picks the
 *  tie when two candidates' hit zones overlap. A degenerate candidate (`x0 === x1`, the point
 *  strip a section-0 convert preserves) never reads as an "endpoint" — a point has one edge, not
 *  two to resize between, and no surveyed tool drags a point into a span by grabbing an edge
 *  handle (kex2d-event-lane finding 8's research, option 1: no point events). It reads as its own
 *  kind, `"glyph"`, so the caller can render and gesture it as a marker rather than a resizable
 *  span — inert to the march (`kex2d-map.md`'s station-0 inertness), not inert to the pointer:
 *  the caller's drag-out grows it into a real span through the same guarded writer a resize
 *  already uses. */
export function classifyStripHit(
    bandX: number,
    strips: readonly StripHitCandidate[],
    radius: number,
): StripHit {
    for (const s of strips) {
        if (s.x0 === s.x1) {
            if (Math.abs(bandX - s.x0) <= radius) return { kind: "glyph", id: s.id };
            continue;
        }
        if (Math.abs(bandX - s.x0) <= radius) return { kind: "endpoint", id: s.id, edge: "start" };
        if (Math.abs(bandX - s.x1) <= radius) return { kind: "endpoint", id: s.id, edge: "end" };
    }
    for (const s of strips) {
        if (s.x0 === s.x1) continue; // a glyph has no body to hit
        if (bandX >= s.x0 && bandX <= s.x1) return { kind: "body", id: s.id };
    }
    return { kind: "empty" };
}
