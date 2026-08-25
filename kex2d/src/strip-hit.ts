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
 *  deterministic, not "correct" about which of two coincident edges wins.
 *
 *  A strip is never degenerate (S3, Locked decision: one-shot events are their own structurally
 *  distinct point kind, `track.OneShot` — the old `[0, 0)` point-as-span convention retired), so
 *  every candidate here has a real `x0 < x1` span. The track-start one-shot's own glyph hit-test
 *  is {@link classifyOneShotHit}, a separate function over a single point — never a
 *  `StripHitCandidate`, since it carries no `id` set to search. */

export interface StripHitCandidate {
    id: number;
    x0: number; // the strip's start edge, screen px
    x1: number; // the strip's end edge, screen px
}

export type StripHit =
    | { kind: "endpoint"; id: number; edge: "start" | "end" }
    | { kind: "body"; id: number }
    | { kind: "empty" };

/** classify a band-local pointer x against a set of already-projected strips, within a pixel
 *  `radius` of an endpoint. `strips` need not be sorted — the caller's own draw order picks the
 *  tie when two candidates' hit zones overlap. */
export function classifyStripHit(
    bandX: number,
    strips: readonly StripHitCandidate[],
    radius: number,
): StripHit {
    for (const s of strips) {
        if (Math.abs(bandX - s.x0) <= radius) return { kind: "endpoint", id: s.id, edge: "start" };
        if (Math.abs(bandX - s.x1) <= radius) return { kind: "endpoint", id: s.id, edge: "end" };
    }
    for (const s of strips) {
        if (bandX >= s.x0 && bandX <= s.x1) return { kind: "body", id: s.id };
    }
    return { kind: "empty" };
}

/** classify a band-local pointer x against the track-start one-shot's own glyph x (S3) — a
 *  single point, never a span: no endpoint/body split, just within-`radius` or not. Takes
 *  the glyph's projected x directly (not a `StripHitCandidate[]`) because there is at most
 *  one one-shot per track, so there's no set to search — mirrors `classifyStripHit`'s
 *  radius convention exactly (same `STRIP_HIT_R` the caller passes both functions). */
export function classifyOneShotHit(bandX: number, glyphX: number, radius: number): boolean {
    return Math.abs(bandX - glyphX) <= radius;
}
