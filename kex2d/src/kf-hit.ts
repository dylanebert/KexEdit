/** the force chart's pure keyframe hit-test classifier — `strip-hit.ts`'s own twin, one axis
 *  richer. Given the pointer's canvas-local x/y and the chart's keyframes already projected to
 *  screen px (`Timeline.svelte`'s `uPx`/`vOf`/`yOf` lenses do the projection; this module never
 *  touches a coordinate system, a canvas, or the DOM), it answers which keyframe — or nothing —
 *  sits under the pointer. Tested directly, off-DOM (`tests/kf-hit.test.ts`), the same way
 *  `classifyStripHit`'s pieces are.
 *
 *  WHY A CLASSIFIER AND NOT DOM HIT-TESTING: a per-keyframe `.fhit` circle is positioned from the
 *  tick-paced `forcePts`/`stripKfPts` `$derived`s, so a keyframe created or moved and pressed in
 *  the SAME frame is drawn at its previous position — the press lands where the diamond is *about*
 *  to be and hits no element at all. That is `bandDown`'s own defect (`freshBandStrips`' docblock)
 *  one surface over, and it takes the same fix: one chart-wide hit rect routing every press
 *  through this classifier over a FRESH projection, never per-element DOM hit-testing.
 *
 *  Nearest wins, not draw order. `classifyStripHit` resolves ties by the caller's list order
 *  because two abutting strips share a boundary *exactly* and neither is "correct"; keyframe
 *  diamonds are points with a fat radius, so overlap is a proximity question with a real answer.
 *  Kind breaks an exact-distance tie, strip over force, preserving the draw order the markup had
 *  when these were DOM circles (the strip marker group renders after the force one, so it was on
 *  top). */

export type KfKind = "force" | "strip";

export interface KfHitCandidate {
    kind: KfKind;
    id: number;
    x: number; // the diamond's centre, canvas-local px
    y: number;
}

export type KfHit = { kind: KfKind; id: number } | null;

/** classify a canvas-local pointer position against a set of already-projected keyframes, within a
 *  pixel `radius` of a diamond's centre. `candidates` need not be sorted — the nearest candidate
 *  inside the radius wins, and an exact distance tie resolves to `strip` over `force`. Returns
 *  `null` when nothing is in range, which the caller reads as "this press is not a keyframe press"
 *  and falls through to its own empty-surface grammar (the marquee/deselect path). */
export function classifyKfHit(
    x: number,
    y: number,
    candidates: readonly KfHitCandidate[],
    radius: number,
): KfHit {
    let best: KfHitCandidate | null = null;
    let bestD2 = radius * radius;
    for (const c of candidates) {
        const dx = x - c.x;
        const dy = y - c.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > bestD2) continue;
        // strictly nearer wins; an exact tie goes to `strip`, the kind that was drawn on top.
        if (best !== null && d2 === bestD2 && !(c.kind === "strip" && best.kind === "force"))
            continue;
        best = c;
        bestD2 = d2;
    }
    return best === null ? null : { kind: best.kind, id: best.id };
}
