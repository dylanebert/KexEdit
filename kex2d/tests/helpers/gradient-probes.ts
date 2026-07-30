/** Steep-long-gradient probe scenarios for the dialect envelope question (spec
 * `kex/specs/kex2d-roundtrip.md`, stage 3 — one of the three open product calls the geo↔force
 * close left behind, `memory/project_kex2d_geoforce_verdict.md`).
 *
 * Deliberately NOT corpus members: `src/scenarios.ts` carries the locked 80-key authorability
 * contract (`tests/helpers/stress.ts`'s own law), so these live in the test tree exactly as
 * the perf-stress trio does.
 *
 * **Construction.** Every corpus scenario's curvature features sit close together (a hill's
 * crest, a loop, a dip) — the flat-tangent join a dialect governs is always bracketed by
 * another feature within a few tangent-lengths. A "steep long gradient" is the opposite shape:
 * a SUSTAINED, near-straight run at a steep angle (so the recovered force sits well off 1g for
 * the whole run, not just at a kink) held long enough that the two flat-tangent basis's
 * differing reach (Cubic 1/3 vs Quintic 7/15 of the *segment* span) has room to diverge —
 * over a short segment the two tangents nearly coincide, so the interesting regime is
 * specifically a LONG segment between two curvature joins. Each probe is a flat lead-in,
 * a short fillet into a constant-grade run, the sustained grade itself, then a second
 * curvature feature (a symmetric fillet back to flat, or — `steepCrestRunout` — a tighter
 * crest turn) closing it out: the two joins a dialect shapes, with the sustained run between
 * them as the thing whose fit the dialect's basis is on the hook for.
 *
 * `v0` per scenario is chosen (and asserted below) so the minimum recovered speed over the
 * whole probe clears `V_WARN` with a real margin — verified against the bake, `src/scenarios.ts`'s
 * own convention, not guessed. */

import { evalGeo } from "../../src/section";
import { type Node, reflect } from "../../src/spline";
import type { Scenario } from "../../src/scenarios";

function withThetas(pts: readonly { x: number; y: number }[]): Node[] {
    const nodes: Node[] = pts.map((p) => ({ ...p, theta: 0 }));
    for (let i = 1; i < nodes.length; i++) {
        const chord = Math.atan2(nodes[i].y - nodes[i - 1].y, nodes[i].x - nodes[i - 1].x);
        nodes[i].theta = reflect(nodes[i - 1].theta, chord);
    }
    return nodes;
}

/** flat lead (20 m) → short fillet → a constant `angleDeg` grade over `run` m of horizontal
 *  span → a short fillet → flat tail (`drop` mirrors the grade below the baseline instead of
 *  above, the descending-energy counterpart). */
function steepGrade(
    name: string,
    angleDeg: number,
    run: number,
    v0: number,
    drop: boolean,
): Scenario {
    const ang = (angleDeg * Math.PI) / 180;
    const sign = drop ? -1 : 1;
    const dx = run * Math.cos(ang);
    const dy = sign * run * Math.sin(ang);
    const pts = [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 30, y: sign * 3 },
        { x: 20 + dx, y: dy },
        { x: 20 + dx + 10, y: dy + sign * 1 },
        { x: 20 + dx + 25, y: dy },
    ];
    return { name, nodes: withThetas(pts), ds: 0.5, v0 };
}

/** flat lead → fillet → a `angleDeg` climb over `run` m → a tighter crest turn (a genuine
 *  curvature feature, not a symmetric fillet) → the mirrored decline → flat tail — the
 *  sustained-grade run closed by a SHARPER join than `steepGrade`'s, the shape a launched
 *  drop's top-of-lift-hill camelback takes. */
function steepCrestRunout(name: string, angleDeg: number, run: number, v0: number): Scenario {
    const ang = (angleDeg * Math.PI) / 180;
    const dx = run * Math.cos(ang);
    const dy = run * Math.sin(ang);
    const cx = 20 + dx;
    const cy = dy;
    const pts = [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 30, y: 3 },
        { x: cx, y: cy },
        { x: cx + 10, y: cy + 2 },
        { x: cx + 20, y: cy },
        { x: cx + 20 + dx, y: cy - dy + 3 },
        { x: cx + 20 + dx + 15, y: cy - dy },
    ];
    return { name, nodes: withThetas(pts), ds: 0.5, v0 };
}

export const gradientProbes: Scenario[] = [
    steepGrade("steep-long-climb", 30, 80, 30, false),
    steepGrade("steep-long-drop", 30, 80, 14, true),
    steepCrestRunout("steep-crest-runout", 30, 70, 28),
];

/** the minimum recovered speed over a scenario's own bake — the feasibility margin each probe
 *  above is picked against (`tests/scenarios.test.ts`'s corpus convention). */
export function minSpeed(scenario: Scenario): number {
    const entry = { x: 0, y: 0, theta: 0, v: scenario.v0 };
    const bake = evalGeo(entry, scenario.nodes, scenario.ds);
    let min = Number.POSITIVE_INFINITY;
    for (let i = 0; i < bake.v.length; i++) min = Math.min(min, bake.v[i]);
    return min;
}
