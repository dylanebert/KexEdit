import { type Node, reflect } from "../../src/spline";

/** attach forward-reflection headings to a list of bare positions — the exact
 *  authoring walk `track.ts addNode` runs: node 0 is the flat anchor (θ = 0),
 *  every later node mirrors its predecessor's heading about the new chord. lets
 *  the position-only tests build realistic chains without the ECS layer. */
export function withThetas(pts: readonly { x: number; y: number }[]): Node[] {
    const nodes: Node[] = pts.map((p) => ({ ...p, theta: 0 }));
    for (let i = 1; i < nodes.length; i++) {
        const chord = Math.atan2(nodes[i].y - nodes[i - 1].y, nodes[i].x - nodes[i - 1].x);
        nodes[i].theta = reflect(nodes[i - 1].theta, chord);
    }
    return nodes;
}
