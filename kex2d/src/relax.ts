import type { State } from "@dylanebert/shallot";
import { type History, record } from "./history";
import { refit } from "./refit";
import { relaxSolve, solveState } from "./solve";
import { Handle, type NodeState, nodeSnapshot, spawnNode, Track } from "./track";

/** the relax verb (spec `kex/specs/kex2d-unified-solver.md`, stage 6):
 *  re-baseline the authored spine toward what the solve wants. NOT a
 *  reweighting — solve the live problem once with the shape prior scaled
 *  down by `strength`, then COMMIT the result as the new authored truth by
 *  refitting the Hermite node chain to the relaxed spine (node-dragging
 *  keeps working; the chain stays the single source of truth). one undoable
 *  history entry; the ongoing solve continues warm and the ghost draft
 *  collapses onto the track. this is the ONLY path that writes solver output
 *  back into authored state — always explicit, never implicit. */

/** default relax strength: the prior at a tenth of its weight — enough for
 *  the shape to follow the forces, not enough to abandon the sketch. */
export const RELAX_STRENGTH = 0.1;

/** replace the whole chain (a relax may change the node COUNT — insertion —
 *  so pose restoration by order isn't enough; the chain is rebuilt). */
function rebuildChain(ecs: State, snap: NodeState[]): void {
    const old: number[] = [];
    for (const eid of ecs.query([Handle])) old.push(eid);
    for (const eid of old) ecs.destroy(eid);
    for (const s of snap) spawnNode(ecs, s.order, s.x, s.y, s.theta);
}

/** relax the track: solve under the reduced prior, refit the node chain to
 *  the relaxed spine, record one undo entry. returns false when there is no
 *  live solve to relax. callers should clear the selection — the rebuild
 *  recycles node eids. */
export function relaxTrack(
    h: History,
    ecs: State,
    trackEid: number,
    strength = RELAX_STRENGTH,
): boolean {
    const st = solveState.get(trackEid);
    if (!st || st.suspended) return false;
    const relaxed = relaxSolve(ecs, trackEid, strength);
    if (!relaxed) return false;

    const before = nodeSnapshot(ecs);
    const fracs = st.nodeFracs.length >= 2 ? st.nodeFracs : [0, 1];
    const nodes = refit(relaxed.x, relaxed.y, relaxed.n, fracs, Track.ds.get(trackEid));
    const after: NodeState[] = nodes.map((nd, k) => ({
        order: k,
        x: nd.x,
        y: nd.y,
        theta: nd.theta,
    }));

    rebuildChain(ecs, after);
    record(h, {
        apply: () => rebuildChain(ecs, after),
        reverse: () => rebuildChain(ecs, before),
    });
    return true;
}
