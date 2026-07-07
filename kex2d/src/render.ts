import type { Plugin, State, System } from "@dylanebert/shallot";
import { cartPose, cartState } from "./cart";
import { editor } from "./editor";
import { bakeOut, Handle, samples, sectionInfo, sections, Track } from "./track";
import { Canvas2D, resize, viewTransform } from "./view";

const HANDLE_R = 6;
const HANDLE_R_SEL = 9;
const ANCHOR_R = 5;
const CART_W = 14;
const CART_H = 7;
const COLOR_TRACK = "#cce5ff";
const COLOR_INFEASIBLE = "#e26d5c";
const COLOR_ANCHOR = "#9aa0a6";

const GridSystem: System = {
    group: "draw",
    update(): void {
        const { element: canvas, ctx } = Canvas2D;
        if (!ctx) return;
        resize(canvas, ctx);

        const w = canvas.clientWidth;
        const h = canvas.clientHeight;

        ctx.fillStyle = "#0e0d0c";
        ctx.fillRect(0, 0, w, h);

        const spacing = 40;
        ctx.strokeStyle = "#1f1e1d";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = (w / 2) % spacing; x < w; x += spacing) {
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
        }
        for (let y = (h / 2) % spacing; y < h; y += spacing) {
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
        }
        ctx.stroke();

        ctx.strokeStyle = "#363534";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, h / 2);
        ctx.lineTo(w, h / 2);
        ctx.moveTo(w / 2, 0);
        ctx.lineTo(w / 2, h);
        ctx.stroke();
    },
};

// scratch buffers for screen-space track polyline. grow as needed but never
// shrink, so re-bakes that shorten the chain reuse the existing capacity
// instead of allocating per-frame.
let screenXs = new Float32Array(0);
let screenYs = new Float32Array(0);

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

            // draw two passes: feasible polyline (solid blue) + infeasible
            // polyline (dashed red). every edge belongs to exactly one pass
            // — feasible-by-default unless either endpoint is below V_WARN.
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

            ctx.save();
            // the realized track (the baked geometry the cart rides) — solid.
            ctx.lineWidth = 2;
            ctx.strokeStyle = COLOR_TRACK;
            ctx.beginPath();
            let inPath = false;
            for (let i = 0; i < count - 1; i++) {
                const ok = out.feasible[i] === 1 && out.feasible[i + 1] === 1;
                if (ok) {
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

            // infeasible pass — dashed red
            ctx.strokeStyle = COLOR_INFEASIBLE;
            ctx.setLineDash([5, 4]);
            ctx.beginPath();
            inPath = false;
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

            // selected-section overlay: overdraw its span in the accent so the
            // whole-section handle (convert / delete target) reads.
            if (editor.section !== null) {
                const info = sectionInfo.get(editor.section);
                if (info) {
                    ctx.setLineDash([]);
                    ctx.strokeStyle = "#d49560";
                    ctx.lineWidth = 3;
                    ctx.beginPath();
                    ctx.moveTo(xs[info.startSample], ys[info.startSample]);
                    for (let i = info.startSample + 1; i <= info.endSample; i++) {
                        ctx.lineTo(xs[i], ys[i]);
                    }
                    ctx.stroke();
                }
            }
            ctx.restore();
        }
    },
};

/** the section-entry anchors: node 0 of every section (the start + interior
 *  boundaries), drawn at the baked sample they pin to. distinct from the draggable
 *  shape handles — an anchor is derived (the entry), not authored. */
const AnchorDrawSystem: System = {
    group: "draw",
    update(ecs: State): void {
        const { element: canvas, ctx } = Canvas2D;
        if (!ctx) return;
        const { sx, sy, ox, oy } = viewTransform(canvas);

        for (const trackEid of ecs.query([Track])) {
            const s = samples.get(trackEid);
            if (!s) continue;
            for (const sec of sections(ecs)) {
                const info = sectionInfo.get(sec.id);
                if (!info) continue;
                const cx = ox + s.posX[info.startSample] * sx;
                const cy = oy + s.posY[info.startSample] * sy;
                // the first section's entry IS the track START — the selectable
                // initial-speed handle; a soft ring marks it when selected.
                if (sec.order === 0 && editor.start) {
                    ctx.save();
                    ctx.strokeStyle = "rgba(255, 209, 102, 0.45)";
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.arc(cx, cy, ANCHOR_R + 4, 0, Math.PI * 2);
                    ctx.stroke();
                    ctx.restore();
                }
                ctx.fillStyle = "#0e0d0c";
                ctx.strokeStyle = sec.order === 0 && editor.start ? "#f0ece8" : COLOR_ANCHOR;
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                // a diamond: entry anchors read as boundaries, not draggable nodes.
                ctx.moveTo(cx, cy - ANCHOR_R);
                ctx.lineTo(cx + ANCHOR_R, cy);
                ctx.lineTo(cx, cy + ANCHOR_R);
                ctx.lineTo(cx - ANCHOR_R, cy);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
            }
        }
    },
};

const HandleDrawSystem: System = {
    group: "draw",
    update(ecs: State): void {
        const { element: canvas, ctx } = Canvas2D;
        if (!ctx) return;
        const { sx, sy, ox, oy } = viewTransform(canvas);
        const sel = editor.selection;

        // pre-compute the red set: nodes at/past the chain's first infeasibility
        // (energy-out reachable) plus orphan nodes (their section's segment failed to
        // bake, so per-section order ≥ bakedNodes — `.sample` is stale there).
        const badHandles = new Set<number>();
        const s0 = ((): NonNullable<ReturnType<typeof samples.get>> | undefined => {
            for (const trackEid of ecs.query([Track])) return samples.get(trackEid);
            return undefined;
        })();
        let firstInfeasible = -1;
        for (const trackEid of ecs.query([Track])) {
            firstInfeasible = bakeOut.get(trackEid)?.firstInfeasible ?? -1;
            break;
        }
        for (const eid of ecs.query([Handle])) {
            if (Handle.order.get(eid) === 0) continue; // anchors aren't shape handles
            const info = sectionInfo.get(Handle.section.get(eid));
            if (info && Handle.order.get(eid) >= info.bakedNodes) {
                badHandles.add(eid);
            } else if (firstInfeasible >= 0 && Handle.sample.get(eid) >= firstInfeasible) {
                badHandles.add(eid);
            }
        }

        for (const eid of ecs.query([Handle])) {
            if (Handle.order.get(eid) === 0) continue; // the entry anchor draws separately
            if (!s0) continue;
            const i = Handle.sample.get(eid);
            const cx = ox + s0.posX[i] * sx;
            const cy = oy + s0.posY[i] * sy;
            const highlighted = eid === sel;
            const bad = badHandles.has(eid);

            if (highlighted) {
                ctx.save();
                ctx.strokeStyle = "rgba(255, 209, 102, 0.45)";
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(cx, cy, HANDLE_R_SEL + 3, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
            }
            if (bad) {
                ctx.save();
                ctx.strokeStyle = COLOR_INFEASIBLE;
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(cx, cy, HANDLE_R + 4, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
            }

            ctx.fillStyle = bad ? "#5a2c25" : "#ffd166";
            ctx.strokeStyle = bad ? COLOR_INFEASIBLE : highlighted ? "#f0ece8" : "#8a6a2a";
            ctx.lineWidth = highlighted ? 2 : 1.5;
            ctx.beginPath();
            ctx.arc(cx, cy, HANDLE_R, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
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
            ctx.fillStyle = "#d49560";
            ctx.fill();
            ctx.restore();
        }
    },
};

export const RenderPlugin: Plugin = {
    name: "Render",
    systems: [GridSystem, TrackDrawSystem, CartDrawSystem, AnchorDrawSystem, HandleDrawSystem],
};
