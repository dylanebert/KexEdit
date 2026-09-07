/** Authoring-scale stress scenarios for the conversion perf baseline.
 *
 * Deliberately NOT corpus members: `src/scenarios.ts` carries the locked 80-key
 * authorability contract, and adding to it would move that lock. These exist only to bound
 * how a conversion scales past the corpus, so they live in the test tree.
 *
 * "Worst credible authored section" is one geo section an author could plausibly build
 * without splitting the chain. Three axes past `double-hump` (12 nodes, 204 m, the biggest
 * corpus scenario), each holding its shapes inside the corpus's own violence range:
 * roughly twice its span, twice its feature count at a comparable span, and both tangent
 * idioms in one long run.
 */

import type { Scenario } from "../../src/scenarios";
import { type Node, type Tangent, TangentMode, reflect } from "../../src/spline";
import { withThetas } from "./chain";

/** the reflect-chain walk continued from an already-placed node — an explicit-tangent
 *  node's stored heading is not meaningful to reflect off, so its out-vector's angle
 *  seeds the walk instead (`src/scenarios.ts chainAfter`). */
function chainAfter(
    prevTheta: number,
    prevPoint: { x: number; y: number },
    pts: readonly { x: number; y: number }[],
): Node[] {
    const nodes: Node[] = [];
    let theta = prevTheta;
    let prev = prevPoint;
    for (const p of pts) {
        const chord = Math.atan2(p.y - prev.y, p.x - prev.x);
        theta = reflect(theta, chord);
        nodes.push({ x: p.x, y: p.y, theta });
        prev = p;
    }
    return nodes;
}

function quadHump(): Scenario {
    // `double-hump` doubled: four `hill-auto` humps over one flat baseline, 388 m of span.
    // The length axis — the same per-feature shape the corpus already proved authorable,
    // twice as much of it as any single corpus section.
    const pts: { x: number; y: number }[] = [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
    ];
    for (let hump = 0; hump < 4; hump++) {
        const x0 = 20 + hump * 92;
        pts.push(
            { x: x0 + 18, y: 7 },
            { x: x0 + 36, y: 11 },
            { x: x0 + 54, y: 7 },
            { x: x0 + 72, y: 0 },
            { x: x0 + 92, y: 0 },
        );
    }
    return { name: "quad-hump", nodes: withThetas(pts), ds: 0.5, v0: 22 };
}

function wiggleRun(): Scenario {
    // seven alternating crests and dips over 320 m — the feature-density axis, against
    // `double-hump`'s two humps. The ±3 m amplitude on an 80 m wavelength keeps the
    // recovered force under 3.7 g, inside the corpus's own band.
    const pts = [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
    ];
    for (let k = 1; k <= 14; k++) {
        const y = k % 2 === 0 ? 0 : k % 4 === 1 ? 3 : -3;
        pts.push({ x: 20 + k * 20, y });
    }
    pts.push({ x: 320, y: 0 });
    return { name: "wiggle-run", nodes: withThetas(pts), ds: 0.5, v0: 20 };
}

function longMixed(): Scenario {
    // the worst credible single section: a 340 m run carrying both tangent idioms — an
    // explicit `Free` trough (`valley-explicit`'s corner, widened until its recovered peak
    // sits under that scenario's own 38 g), two arc-rule humps, an explicit `Aligned` flat
    // crest (`hill-explicit`'s widened float), and a closing dip.
    const lead = withThetas([
        { x: 0, y: 0 },
        { x: 20, y: 0 },
    ]);
    const troughTangent: Tangent = { mode: TangentMode.Free, inX: 18, inY: -5, outX: 18, outY: 5 };
    const trough: Node = { x: 35, y: -8, theta: 0, tangent: troughTangent };
    const humps = chainAfter(Math.atan2(troughTangent.outY, troughTangent.outX), trough, [
        { x: 55, y: -6 },
        { x: 75, y: 0 },
        { x: 95, y: 0 },
        { x: 113, y: 5 },
        { x: 131, y: 8 },
        { x: 149, y: 5 },
        { x: 167, y: 0 },
        { x: 187, y: 0 },
        { x: 205, y: 5 },
    ]);
    const crestTangent: Tangent = { mode: TangentMode.Aligned, inX: 9, inY: 0, outX: 9, outY: 0 };
    const crest: Node = { x: 223, y: 8, theta: 0, tangent: crestTangent };
    const tail = chainAfter(Math.atan2(crestTangent.outY, crestTangent.outX), crest, [
        { x: 241, y: 5 },
        { x: 259, y: 0 },
        { x: 279, y: 0 },
        { x: 295, y: -5 },
        { x: 315, y: -5 },
        { x: 340, y: 0 },
    ]);
    return {
        name: "long-mixed",
        nodes: [...lead, trough, ...humps, crest, ...tail],
        ds: 0.5,
        v0: 20,
    };
}

export const stress: Scenario[] = [quadHump(), wiggleRun(), longMixed()];
