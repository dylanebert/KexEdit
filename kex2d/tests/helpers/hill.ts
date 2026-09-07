/** the airtime-hill scenario — the Stage-1 sparse-variable solve gate's draft
 *  (spec `kex/specs/kex2d-force-targets.md`). a hand-drawn hill: flat lead, rise
 *  over a crest, fall, flat out. built through the exact `track.ts addNode`
 *  authoring walk (`withThetas`: node 0 the flat anchor, every later heading the
 *  circular-arc reflection of its predecessor), so the draft is a curve the
 *  editor could actually produce. the crest carries a mild positive F_n in the
 *  draft; the demand "hold 0g over the crest" is what the solve must reshape it
 *  to meet. `v0` clears the crest with margin (v² well above 0 throughout). */

import type { Node } from "../../src/spline";
import { withThetas } from "./chain";

export interface HillDraft {
    nodes: Node[];
    v0: number;
    /** node index of the crest (top of the hill). */
    crest: number;
}

export function hillDraft(): HillDraft {
    const pts = [
        { x: 0, y: 0 }, // 0 flat anchor
        { x: 20, y: 0 }, // 1 lead
        { x: 38, y: 7 }, // 2 rise
        { x: 56, y: 11 }, // 3 crest
        { x: 74, y: 7 }, // 4 fall
        { x: 92, y: 0 }, // 5 out
        { x: 112, y: 0 }, // 6 tail
    ];
    return { nodes: withThetas(pts), v0: 22, crest: 3 };
}

/** the same hill with the crest region subdivided (extra rise/fall nodes) — a
 *  denser control net over the airtime span, for the "at what node count" leg
 *  of the representability measurement. crest is node 4. */
export function denseHillDraft(): HillDraft {
    const pts = [
        { x: 0, y: 0 }, // 0 flat anchor
        { x: 20, y: 0 }, // 1 lead
        { x: 38, y: 7 }, // 2 rise
        { x: 47, y: 9.4 }, // 3 rise
        { x: 56, y: 11 }, // 4 crest
        { x: 65, y: 9.4 }, // 5 fall
        { x: 74, y: 7 }, // 6 fall
        { x: 92, y: 0 }, // 7 out
        { x: 112, y: 0 }, // 8 tail
    ];
    return { nodes: withThetas(pts), v0: 22, crest: 4 };
}
