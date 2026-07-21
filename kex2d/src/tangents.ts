/** the tangent-handle geometry the viewport UI shares: where a node's in/out handles land
 *  in screen px (render draws the arms + knobs there, controls picks and drags against them),
 *  and the world→local inversion a drag feeds `spline.editTangent`. one home for the
 *  section-frame convention so render and controls can't drift.
 *
 *  a handle shows only for a side that drives a segment — the in-handle needs an arriving
 *  segment (a previous node), the out-handle a departing one (a next node) — so a chain end
 *  shows no out-handle and node 0 (the entry anchor) never shows any. an *explicit* node draws
 *  its stored vectors; a *selected `Auto`* node draws its live arc-rule tangents as a ghost
 *  affordance, the direct-manipulation summon (a drag pulls it into an explicit tangent). */

import type { State } from "@dylanebert/shallot";
import { autoTangent, handleTip } from "./spline";
import { Handle, handleAt, handleTangent, sectionInfo } from "./track";
import type { ViewTx } from "./view";

export type TangentSide = "in" | "out";

/** a node's visible tangent handle in screen px: which side, and its knob's screen point. */
export interface TangentHandle {
    side: TangentSide;
    x: number;
    y: number;
}

type Samples = { posX: Float32Array; posY: Float32Array };

const EPS = 1e-9;

/** the segment-local visual offset of a node's in/out handle from the node, or null for a
 *  side with no segment (a chain end's out-handle, node 0's in-handle) or a degenerate chord.
 *  an explicit node reads its stored vector (`handleTip`); a selected `Auto` node computes the
 *  arc-rule vector from the live chord — the same value the bake uses, so the ghost handle sits
 *  exactly where the curve leaves the node. */
function localTip(
    ecs: State,
    sectionId: number,
    order: number,
    side: TangentSide,
): [number, number] | null {
    const eid = handleAt(ecs, sectionId, order);
    if (eid === null) return null;
    // segment existence gates the handle: a side driving no curve shows nothing, even when an
    // explicit vector is stored for it.
    const neighbor = handleAt(ecs, sectionId, side === "in" ? order - 1 : order + 1);
    if (neighbor === null) return null;

    const tan = handleTangent(ecs, sectionId, order);
    if (tan) return handleTip(tan, side);

    // Auto ghost: the arc-rule vector along the live chord to the neighbor.
    const nx = Handle.pos.x.get(eid);
    const ny = Handle.pos.y.get(eid);
    const th = Handle.theta.get(eid);
    const dx = side === "in" ? nx - Handle.pos.x.get(neighbor) : Handle.pos.x.get(neighbor) - nx;
    const dy = side === "in" ? ny - Handle.pos.y.get(neighbor) : Handle.pos.y.get(neighbor) - ny;
    const cl = Math.hypot(dx, dy);
    if (cl < EPS) return null;
    const [vx, vy] = autoTangent(th, Math.atan2(dy, dx), cl);
    // the in-handle draws on the opposite side (its stored vector is the forward arrival
    // velocity), matching `handleTip`.
    return side === "in" ? [-vx, -vy] : [vx, vy];
}

/** the visible tangent handles of a node in screen px. the pivot is the node's baked world
 *  sample; the local offset rotates into world by the section entry heading (a free vector —
 *  rotation only) then projects to screen. */
export function tangentHandles(ecs: State, s: Samples, tx: ViewTx, eid: number): TangentHandle[] {
    const sectionId = Handle.section.get(eid);
    const order = Handle.order.get(eid);
    const info = sectionInfo.get(sectionId);
    if (!info) return [];
    const i = Handle.sample.get(eid);
    const nwx = s.posX[i];
    const nwy = s.posY[i];
    const c = Math.cos(info.entry.theta);
    const sn = Math.sin(info.entry.theta);
    const out: TangentHandle[] = [];
    for (const side of ["in", "out"] as TangentSide[]) {
        const lt = localTip(ecs, sectionId, order, side);
        if (!lt) continue;
        const wx = c * lt[0] - sn * lt[1];
        const wy = sn * lt[0] + c * lt[1];
        out.push({ side, x: tx.ox + (nwx + wx) * tx.sx, y: tx.oy + (nwy + wy) * tx.sy });
    }
    return out;
}

/** invert a world point to the segment-local visual offset from a node — the `editTangent`
 *  input. the inverse of the entry-frame rotation `tangentHandles` applies. */
export function localTipAt(
    s: Samples,
    eid: number,
    worldX: number,
    worldY: number,
): [number, number] {
    const info = sectionInfo.get(Handle.section.get(eid));
    const i = Handle.sample.get(eid);
    const dx = worldX - s.posX[i];
    const dy = worldY - s.posY[i];
    const th = info ? info.entry.theta : 0;
    const c = Math.cos(th);
    const sn = Math.sin(th);
    return [c * dx + sn * dy, -sn * dx + c * dy];
}
