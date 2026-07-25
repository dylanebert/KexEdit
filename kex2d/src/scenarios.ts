/** evalGeo-ready scenario corpus for the geo→force fit spike
 *  (`specs/kex2d-geoforce-spike.md` stage 1). pure, framework-free — no DOM/Svelte, no
 *  shallot import. each scenario is a section-local node list (node 0 at the local
 *  origin, heading 0 — the rigid entry-frame law, `section.ts`) ready to feed
 *  `evalGeo({ x: 0, y: 0, theta: 0, v: v0 }, nodes, ds)`.
 *
 *  synthetic scenarios each exercise one geometric primitive (arc, parabola, loop, S,
 *  fillet); the "real authored" scenarios are hills and loops shaped the way an author
 *  places them, covering both tangent idioms — arc-rule `Auto` (theta-only nodes) and
 *  explicit stored tangents (`Tangent`: Mirror | Aligned | Free). ds and v0 are chosen so
 *  v stays above `V_WARN` through the shape — verified against the bake, not guessed
 *  (`tests/scenarios.test.ts`). */

import { reflect, TangentMode, type Node, type Tangent } from "./spline";

export interface Scenario {
    name: string;
    nodes: Node[];
    ds: number;
    v0: number;
}

/** author a reflect-chain: node 0 is the flat anchor (θ = 0); every later node's heading
 *  is the circular-arc reflection of its predecessor's — the exact `track.ts addNode` walk
 *  (mirrors `tests/helpers/chain.ts withThetas`, duplicated here so this stays a
 *  standalone src module with no test-tree import). */
function reflectChain(pts: readonly { x: number; y: number }[]): Node[] {
    const nodes: Node[] = pts.map((p) => ({ ...p, theta: 0 }));
    for (let i = 1; i < nodes.length; i++) {
        const chordAngle = Math.atan2(nodes[i].y - nodes[i - 1].y, nodes[i].x - nodes[i - 1].x);
        nodes[i].theta = reflect(nodes[i - 1].theta, chordAngle);
    }
    return nodes;
}

/** the reflect-chain walk continued from an already-placed node (an explicit-tangent
 *  node's stored heading isn't meaningful to reflect off, so its actual exit direction —
 *  its out-vector's angle — seeds the walk instead). */
function chainAfter(
    prevTheta: number,
    prevPoint: { x: number; y: number },
    pts: readonly { x: number; y: number }[],
): Node[] {
    const nodes: Node[] = [];
    let theta = prevTheta;
    let prev = prevPoint;
    for (const p of pts) {
        const chordAngle = Math.atan2(p.y - prev.y, p.x - prev.x);
        theta = reflect(theta, chordAngle);
        nodes.push({ x: p.x, y: p.y, theta });
        prev = p;
    }
    return nodes;
}

/** a point on a circle of radius `r`, parametrized so `t = 0` sits at `(x0, y0)` heading 0
 *  (tangent +x) and the circle's center is `r` above `(x0, y0)` — the exact tangent-heading
 *  assignment `handle()`'s `k = sec²(φ/2)` cubic fits well (φ = 0 at every node here, so
 *  `Auto` reproduces the circle closely with modest per-segment turning). */
function circleNode(x0: number, y0: number, r: number, t: number): Node {
    return { x: x0 + r * Math.sin(t), y: y0 + r * (1 - Math.cos(t)), theta: t };
}

function circularArc(): Scenario {
    // a single 30° climbing arc (a hill-crest or valley-bottom's constant-curvature
    // primitive), then a straight continuation along the exit tangent.
    const r = 50;
    const arc = [circleNode(0, 0, r, 0), circleNode(0, 0, r, Math.PI / 6)];
    const last = arc[arc.length - 1];
    const tail = {
        x: last.x + 20 * Math.cos(last.theta),
        y: last.y + 20 * Math.sin(last.theta),
        theta: last.theta,
    };
    return { name: "circular-arc", nodes: [...arc, tail], ds: 0.5, v0: 20 };
}

function parabolaHill(): Scenario {
    const h = 15;
    const span = 90;
    const xs = [0, 15, 30, 45, 60, 75, 90];
    const pts = xs.map((x) => ({ x, y: h * (1 - ((x - span / 2) / (span / 2)) ** 2) }));
    return { name: "parabola-hill", nodes: reflectChain(pts), ds: 0.5, v0: 20 };
}

function fullLoop(): Scenario {
    // a vertical loop authored as 8 arc-rule (Auto) nodes around the circle — each
    // node's theta is the exact circle-tangent heading there, so the arc-rule cubic
    // fits the true circle closely (45° per segment, well inside the docstring's
    // "exact to ~3e-4·R at a quarter turn" claim).
    const r = 10;
    const leadIn = 10;
    const tailLen = 20;
    const cx = leadIn; // loop-start x, after the straight lead
    const segs = 8;
    const nodes: Node[] = [
        { x: 0, y: 0, theta: 0 }, // entry
        { x: leadIn, y: 0, theta: 0 }, // straight lead end / loop start
    ];
    for (let k = 1; k <= segs; k++) nodes.push(circleNode(cx, 0, r, (k * 2 * Math.PI) / segs));
    nodes.push({ x: cx + tailLen, y: 0, theta: 2 * Math.PI }); // straight tail past closure
    return { name: "full-loop", nodes, ds: 0.5, v0: Math.sqrt(5 * 9.80665 * r) };
}

function sCurve(): Scenario {
    // vertical S: a hill, then a dip below the baseline, then level out — the sign of
    // curvature flips twice, the S-curve's defining trait.
    const pts = [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 40, y: 8 },
        { x: 60, y: 8 },
        { x: 80, y: 0 },
        { x: 95, y: -5 },
        { x: 115, y: -5 },
        { x: 135, y: 0 },
        { x: 155, y: 0 },
    ];
    return { name: "s-curve", nodes: reflectChain(pts), ds: 0.5, v0: 18 };
}

function straightFillet(): Scenario {
    // flat, then a rounded (filleted) transition into a straight climb — the arc-rule
    // chain rounds the bend on its own, no explicit handles needed.
    const pts = [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 35, y: 8 },
        { x: 60, y: 8 },
    ];
    return { name: "straight-fillet", nodes: reflectChain(pts), ds: 0.5, v0: 18 };
}

function hillAuto(): Scenario {
    // an airtime hill the way an author drags it in the viewport — arc-rule Auto
    // throughout, no explicit tangents.
    const pts = [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 38, y: 7 },
        { x: 56, y: 11 },
        { x: 74, y: 7 },
        { x: 92, y: 0 },
        { x: 112, y: 0 },
    ];
    return { name: "hill-auto", nodes: reflectChain(pts), ds: 0.5, v0: 22 };
}

function hillExplicit(): Scenario {
    // the same hill, but the crest is explicitly tangent-edited flat (`Aligned`, the
    // Figma/Blender handle idiom) — an author widening the float instead of taking the
    // arc-rule's default crest. the chain past the crest continues from its actual
    // (flat) exit direction, not its stored (unused-under-explicit) theta.
    const lead = reflectChain([
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 38, y: 7 },
    ]);
    const crestTangent: Tangent = { mode: TangentMode.Aligned, inX: 9, inY: 0, outX: 9, outY: 0 };
    const crest: Node = { x: 56, y: 11, theta: 0, tangent: crestTangent };
    const exitHeading = Math.atan2(crestTangent.outY, crestTangent.outX);
    const tail = chainAfter(exitHeading, { x: crest.x, y: crest.y }, [
        { x: 74, y: 7 },
        { x: 92, y: 0 },
        { x: 112, y: 0 },
    ]);
    return { name: "hill-explicit", nodes: [...lead, crest, ...tail], ds: 0.5, v0: 22 };
}

function loopExplicit(): Scenario {
    // a vertical loop authored with explicit `Mirror` tangents at the standard
    // cubic-bezier circle-approximation length (`4/3·tan(π/8)·r`) — 4 quadrant segments
    // reach near-exact circularity, the explicit-bezier counterpart to `fullLoop`'s
    // 8-segment arc-rule version.
    const r = 10;
    const len = (4 / 3) * Math.tan(Math.PI / 8) * r;
    // the straight lead/tail chords match the quadrant tangent length itself — a
    // mismatched chord (a longer straight run) leaves the Auto neighbor's own
    // chord-scaled tangent much longer than the explicit quadrant tangent it joins,
    // spiking the recovered force right at that shared node (an early draft with a
    // 15 m lead spiked to ~38g there; matching the scale keeps the join gentle).
    const leadIn = len;
    const tailLen = len;
    const cx = leadIn;
    const quad = (t: number): Node => {
        const p = circleNode(cx, 0, r, t);
        const tangent: Tangent = {
            mode: TangentMode.Mirror,
            inX: len * Math.cos(t),
            inY: len * Math.sin(t),
            outX: len * Math.cos(t),
            outY: len * Math.sin(t),
        };
        return { ...p, tangent };
    };
    const nodes: Node[] = [
        { x: 0, y: 0, theta: 0 }, // entry
        quad(0), // loop start
        quad(Math.PI / 2),
        quad(Math.PI),
        quad((3 * Math.PI) / 2),
        quad(2 * Math.PI), // closes back to the loop-start position
        { x: cx + tailLen, y: 0, theta: 2 * Math.PI }, // straight tail, Auto
    ];
    return { name: "loop-explicit", nodes, ds: 0.5, v0: Math.sqrt(5 * 9.80665 * r) };
}

function doubleHump(): Scenario {
    // two `hillAuto`-shaped humps back to back, sharing a flat valley — the same
    // spacing-to-height ratio already proven not to overshoot (a tighter alternation
    // tried first bulged the Hermite curve to nearly 3x the authored crest height).
    const pts = [
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 38, y: 7 },
        { x: 56, y: 11 },
        { x: 74, y: 7 },
        { x: 92, y: 0 },
        { x: 112, y: 0 },
        { x: 130, y: 7 },
        { x: 148, y: 11 },
        { x: 166, y: 7 },
        { x: 184, y: 0 },
        { x: 204, y: 0 },
    ];
    return { name: "double-hump", nodes: reflectChain(pts), ds: 0.5, v0: 22 };
}

function valleyExplicit(): Scenario {
    // a dip authored with an explicit `Free` tangent at the bottom (independent in/out
    // direction — the sharper "V" trough a corner-capable handle expresses, distinct
    // from the smooth Mirror/Aligned shapes elsewhere in the corpus).
    const lead = reflectChain([
        { x: 0, y: 0 },
        { x: 20, y: 0 },
    ]);
    // magnitude ~ the incoming chord's own arc-scaled tangent (~18), so the join with
    // the Auto lead stays gentle (an earlier, shorter-handled draft spiked to ~71g there).
    const dipTangent: Tangent = { mode: TangentMode.Free, inX: 16, inY: -8, outX: 16, outY: 8 };
    const dip: Node = { x: 35, y: -8, theta: 0, tangent: dipTangent };
    const exitHeading = Math.atan2(dipTangent.outY, dipTangent.outX);
    const tail = chainAfter(exitHeading, { x: dip.x, y: dip.y }, [
        { x: 55, y: -6 },
        { x: 75, y: 0 },
        { x: 95, y: 0 },
    ]);
    return { name: "valley-explicit", nodes: [...lead, dip, ...tail], ds: 0.5, v0: 14 };
}

export const scenarios: Scenario[] = [
    circularArc(),
    parabolaHill(),
    fullLoop(),
    sCurve(),
    straightFillet(),
    hillAuto(),
    hillExplicit(),
    loopExplicit(),
    doubleHump(),
    valleyExplicit(),
];
