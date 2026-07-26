import { type Entry, evalGeo, type SectionResult } from "../../src/section";
import { type Node, reflect, type Tangent, TangentMode } from "../../src/spline";

/** a sharp V with a `Free` tangent at the trough — a genuine slope discontinuity in the
 *  target, which is what a CORNER is for. The conversion tier's one fixture that needs the
 *  broken-key state: the corpus needs no corner at its derived floor, so the corner path
 *  (and everything downstream of it — `quantize`'s corner exclusion) is only reachable here.
 *
 *  Compact on purpose, and driven by an explicit `floor`: this shape's own derived floor is
 *  0.26 m (the chord deficit of a 98 g spike is large), far looser than the resolution where
 *  a corner starts paying. Shared by `refine.test.ts` and `quantize.test.ts` so the two read
 *  the same shape rather than each re-authoring it.
 *
 * @example
 * const fx = sharpValley();
 * const r = refine({ ...fx, floor: 0.12 }); // 6 keys, corners [1, 2, 3]
 */
export function sharpValley(): { bake: SectionResult; entry: Entry; ds: number } {
    const t: Tangent = { mode: TangentMode.Free, inX: 5, inY: -6, outX: 5, outY: 10 };
    const dip: Node = { x: 14, y: -5, theta: 0, tangent: t };
    const exit = Math.atan2(t.outY, t.outX);
    const p3 = { x: 30, y: -3 };
    const nodes: Node[] = [
        { x: 0, y: 0, theta: 0 },
        dip,
        { ...p3, theta: reflect(exit, Math.atan2(p3.y - dip.y, p3.x - dip.x)) },
    ];
    const entry: Entry = { x: 0, y: 0, theta: 0, v: 14 };
    return { bake: evalGeo(entry, nodes, 0.5), entry, ds: 0.5 };
}
