import type { Plugin, State, System } from "@dylanebert/shallot";
import { cartPose, cartState } from "./cart";
import { COLOR_ACCENT, COLOR_INFEASIBLE, kindSegments } from "./colors";
import { niceStep } from "./timeline";
import { bakeOut, samples, Track } from "./track";
import { Canvas2D, resize, viewTransform } from "./view";

const _HANDLE_R = 6;
const _HANDLE_R_SEL = 9;
const _ANCHOR_R = 5;
const CART_W = 14;
const CART_H = 7;
const _COLOR_ANCHOR = "#9aa0a6";

// target on-screen spacing between minor gridlines (px); the world step snaps to a
// 1-2-5 nice number that lands nearest this under the current zoom, so the grid stays
// legible at any zoom instead of a fixed pixel pitch that ignores the camera.
const GRID_PX = 40;

const GridSystem: System = {
    group: "draw",
    update(): void {
        const { element: canvas, ctx } = Canvas2D;
        if (!ctx) return;
        resize(canvas, ctx);

        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        const { sx, sy, ox, oy } = viewTransform(canvas);

        ctx.fillStyle = "#0e0d0c";
        ctx.fillRect(0, 0, w, h);

        // gridlines at world multiples of `step`, transformed by the camera. the origin
        // lines (k=0) draw brighter as the world axes.
        const step = niceStep(GRID_PX / sx);
        const kx0 = Math.floor((0 - ox) / sx / step);
        const kx1 = Math.ceil((w - ox) / sx / step);
        // world y at the top/bottom edges (sy < 0, so the top edge is the larger world y).
        const wyTop = (0 - oy) / sy;
        const wyBot = (h - oy) / sy;
        const ky0 = Math.floor(Math.min(wyTop, wyBot) / step);
        const ky1 = Math.ceil(Math.max(wyTop, wyBot) / step);

        ctx.strokeStyle = "#1f1e1d";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let k = kx0; k <= kx1; k++) {
            if (k === 0) continue;
            const x = ox + k * step * sx;
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
        }
        for (let k = ky0; k <= ky1; k++) {
            if (k === 0) continue;
            const y = oy + k * step * sy;
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
        }
        ctx.stroke();

        // the world axes (x=0, y=0) — brighter, drawn only when on-screen.
        ctx.strokeStyle = "#363534";
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (oy >= 0 && oy <= h) {
            ctx.moveTo(0, oy);
            ctx.lineTo(w, oy);
        }
        if (ox >= 0 && ox <= w) {
            ctx.moveTo(ox, 0);
            ctx.lineTo(ox, h);
        }
        ctx.stroke();
    },
};

// scratch buffers for screen-space track polyline. grow as needed but never
// shrink, so re-bakes that shorten the chain reuse the existing capacity
// instead of allocating per-frame.
let screenXs = new Float32Array(0);
let screenYs = new Float32Array(0);

/** stroke the FEASIBLE sub-paths of a sample range — the one move behind the kind, hover, and
 *  selection passes: an edge draws only when both its endpoints baked feasible, so the dashed-red
 *  pass owns the rest alone and the priority stack holds however the passes stack up. */
function strokeFeasible(
    ctx: CanvasRenderingContext2D,
    xs: Float32Array,
    ys: Float32Array,
    feasible: Uint8Array,
    from: number,
    to: number,
): void {
    ctx.beginPath();
    let inPath = false;
    for (let i = from; i < to; i++) {
        if (feasible[i] === 1 && feasible[i + 1] === 1) {
            if (!inPath) {
                ctx.moveTo(xs[i], ys[i]);
                inPath = true;
            }
            ctx.lineTo(xs[i + 1], ys[i + 1]);
        } else {
            inPath = false;
        }
    }
    ctx.stroke();
}

/** one contiguous infeasible extent on the document's arclength axis: `start`/`end` are the
 *  bounding samples' own `s` values (never a sample index — the caller projects to a screen or
 *  document coordinate, never re-derives one). */
export interface InfeasibleSpan {
    start: number;
    end: number;
}

/** the ghost strip's own reader — the header band's sibling to `strokeFeasible`: same bad-edge
 *  walk (an edge is bad when either endpoint fails V_WARN), but it returns arclength extents
 *  instead of stroking a canvas, so it's pure and DOM-free. `s`/`feasible`/`count` are a bake's
 *  own arrays (`cart.forceCurve`/`velocityCurve`'s `s`, `bakeOut.feasible`) — never re-derived.
 *  Contiguity is measured, not assumed (S3): a per-edge walk is sufficient, no coalescing rule.
 *  **A `start === end` span is real, not a bug**: the downstream freeze publishes a zero-length
 *  gap edge (`ds = 0`) over a real position jump, and a single bad edge landing exactly there
 *  produces a zero-width extent — the caller is responsible for keeping a degenerate span visible
 *  on screen (a pixel-space minimum width), since this reader stays exact in document space. */
export function infeasibleSpans(
    s: Float64Array,
    feasible: Uint8Array,
    count: number,
): InfeasibleSpan[] {
    const spans: InfeasibleSpan[] = [];
    let start = -1;
    for (let i = 0; i < count - 1; i++) {
        const bad = feasible[i] === 0 || feasible[i + 1] === 0;
        if (bad) {
            if (start === -1) start = i;
        } else if (start !== -1) {
            spans.push({ start: s[start], end: s[i] });
            start = -1;
        }
    }
    if (start !== -1) spans.push({ start: s[start], end: s[count - 1] });
    return spans;
}

const TrackDrawSystem: System = {
    group: "draw",
    update(ecs: State): void {
        const { element: canvas, ctx } = Canvas2D;
        if (!ctx) return;
        const { sx, sy, ox, oy } = viewTransform(canvas);

        for (const trackEid of ecs.query([Track])) {
            const count = Track.count.get(trackEid);
            const s = samples.get(trackEid);
            const out = bakeOut.get(trackEid);
            if (!s || !out || count < 2) continue;

            // draw the feasible polyline (solid, per-section kind color) then the
            // infeasible polyline (dashed red) over it. every edge belongs to exactly
            // one of the two — feasible-by-default unless either endpoint is below
            // V_WARN.
            if (screenXs.length < count) {
                screenXs = new Float32Array(count);
                screenYs = new Float32Array(count);
            }
            const xs = screenXs;
            const ys = screenYs;
            for (let i = 0; i < count; i++) {
                xs[i] = ox + s.posX[i] * sx;
                ys[i] = oy + s.posY[i] * sy;
            }

            const segs = kindSegments(ecs);
            ctx.save();
            // the realized track (the baked geometry the cart rides) — solid, one pass
            // per section in its kind color (geo cool blue / force accent gold, the same
            // language the clip strip uses). infeasible-red, the hovered span, and the
            // selected-section overlay overdraw this in the passes below (priority:
            // infeasible > selection > hover > kind).
            ctx.lineWidth = 2;
            for (const seg of segs) {
                ctx.strokeStyle = seg.color;
                strokeFeasible(ctx, xs, ys, out.feasible, seg.startSample, seg.endSample);
            }

            // infeasible pass — dashed red
            ctx.strokeStyle = COLOR_INFEASIBLE;
            ctx.setLineDash([5, 4]);
            ctx.beginPath();
            let inPath = false;
            for (let i = 0; i < count - 1; i++) {
                const bad = out.feasible[i] === 0 || out.feasible[i + 1] === 0;
                if (bad) {
                    if (!inPath) {
                        ctx.moveTo(xs[i], ys[i]);
                        inPath = true;
                    }
                    ctx.lineTo(xs[i + 1], ys[i + 1]);
                } else {
                    inPath = false;
                }
            }
            ctx.stroke();

            ctx.restore();
        }
    },
};

const CartDrawSystem: System = {
    group: "draw",
    update(ecs: State): void {
        const { element: canvas, ctx } = Canvas2D;
        if (!ctx) return;
        const tx = viewTransform(canvas);

        for (const trackEid of ecs.query([Track])) {
            const cart = cartState.get(trackEid);
            if (!cart) continue;
            const pose = cartPose(trackEid, cart.t);
            if (!pose) continue;
            const cx = tx.ox + pose.x * tx.sx;
            const cy = tx.oy + pose.y * tx.sy;

            ctx.save();
            ctx.translate(cx, cy);
            // world theta is CCW from +x in world Y-up; the view flips Y
            // (sy < 0), so a screen-space rotation of −θ aligns the box's
            // local +x with the world tangent direction.
            ctx.rotate(-pose.theta);
            ctx.fillStyle = "#f0ece8";
            ctx.strokeStyle = "#0e0d0c";
            ctx.lineWidth = 1;
            ctx.fillRect(-CART_W / 2, -CART_H / 2, CART_W, CART_H);
            ctx.strokeRect(-CART_W / 2, -CART_H / 2, CART_W, CART_H);
            // direction marker: small triangle at the leading edge so the
            // cart's orientation is unambiguous even when the box is square.
            ctx.beginPath();
            ctx.moveTo(CART_W / 2, 0);
            ctx.lineTo(CART_W / 2 - 4, -CART_H / 2 + 1);
            ctx.lineTo(CART_W / 2 - 4, CART_H / 2 - 1);
            ctx.closePath();
            ctx.fillStyle = COLOR_ACCENT;
            ctx.fill();
            ctx.restore();
        }
    },
};

/** the viewport snap-guide flash: the incline tangent ray for the fired magnet family, drawn over
 *  the track and cleared by the controls on release — a full-extent line through the dragged node
 *  along the snapped exit incline, in the shared neutral guide gray (the timeline's snap guides
 *  wear the same gray now, feel round 3). `L` spans any framed view; the canvas clips the overshoot.
 *  The numeric °/m readout is DOM, not canvas — it renders in the snap readout centered below the
 *  dragged node (App's `.snap-readout`, the Blender modal-transform readout), offset clear of the
 *  node-action ring's buttons. */
export const RenderPlugin: Plugin = {
    name: "Render",
    systems: [GridSystem, TrackDrawSystem, CartDrawSystem],
};
