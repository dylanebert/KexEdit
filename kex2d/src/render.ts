import type { Plugin, State, System } from "@dylanebert/shallot";
import { cartPose, cartState } from "./cart";
import {
    COLOR_ACCENT,
    COLOR_FORCE,
    COLOR_GUIDE_RAY,
    DIM_WASH,
    hovered,
    kindSegments,
    selected,
} from "./colors";
import { editor, modeChromeSection } from "./editor";
import { niceStep } from "./timeline";
import { editHandleSets } from "./tangents";
import {
    bakeOut,
    forceMarkers,
    Handle,
    handleAt,
    handleTangent,
    samples,
    sectionInfo,
    sections,
    Track,
} from "./track";
import { Canvas2D, marquee, resize, snapGuides, viewTransform } from "./view";

const HANDLE_R = 6;
const HANDLE_R_SEL = 9;
const ANCHOR_R = 5;
const CART_W = 14;
const CART_H = 7;
const COLOR_INFEASIBLE = "#e26d5c";
const COLOR_ANCHOR = "#9aa0a6";

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

const TrackDrawSystem: System = {
    group: "draw",
    update(ecs: State): void {
        const { element: canvas, ctx } = Canvas2D;
        if (!ctx) return;
        const { sx, sy, ox, oy } = viewTransform(canvas);

        // optimize mode's whole-shape ghost (kex2d-optimize-mode stage 1): the mode-entry
        // geometry, frozen at `beginOptimize` and never re-derived — a faint dashed reference
        // so the author sees how far the current draft has drifted from where the mode's stamp
        // was taken. Drawn first (underneath the live track); the ghost never picks or hovers.
        if (editor.optimizing) {
            const { x: gx, y: gy } = editor.optimizing.ghost;
            if (gx.length >= 2) {
                ctx.save();
                ctx.strokeStyle = "rgba(240, 236, 232, 0.25)";
                ctx.lineWidth = 2;
                ctx.setLineDash([6, 4]);
                ctx.beginPath();
                for (let i = 0; i < gx.length; i++) {
                    const px = ox + gx[i] * sx;
                    const py = oy + gy[i] * sy;
                    if (i === 0) ctx.moveTo(px, py);
                    else ctx.lineTo(px, py);
                }
                ctx.stroke();
                ctx.restore();
            }
        }

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

            // hover overlay: the section span under the pointer, redrawn one rung up in its OWN
            // kind color (`hovered` in colors.ts — the canvas twin of the clip strip's hover
            // fill), at the kind pass's width, so the read is tone alone. an already-selected
            // section shows nothing: the selection rung is the stronger read of the same span.
            const hov = editor.hoverSection;
            if (hov !== null && !editor.sections.ids.has(hov)) {
                const info = sectionInfo.get(hov);
                const seg = segs.find((s) => s.id === hov);
                if (info && seg) {
                    ctx.setLineDash([]);
                    ctx.strokeStyle = hovered(seg.color);
                    ctx.lineWidth = 2;
                    strokeFeasible(ctx, xs, ys, out.feasible, info.startSample, info.endSample);
                }
            }

            // selected-section overlay: overdraw every selected section's FEASIBLE span in a
            // brightened analog of its OWN kind color (the Ableton/Premiere selected-clip idiom,
            // `selected` in colors.ts) so the whole-section handle (convert / delete target)
            // reads — a multi-set (shift-click) washes every member, single-select the size-1
            // case. an infeasible sub-segment is skipped here (same feasibility check as the
            // passes above) so it stays under the dashed-red pass instead of being painted
            // over — priority stays infeasible-red > selection (brightened kind) > hover > kind.
            for (const secId of editor.sections.ids) {
                const info = sectionInfo.get(secId);
                const seg = segs.find((s) => s.id === secId);
                if (info && seg) {
                    ctx.setLineDash([]);
                    ctx.strokeStyle = selected(seg.color);
                    ctx.lineWidth = 3;
                    strokeFeasible(ctx, xs, ys, out.feasible, info.startSample, info.endSample);
                }
            }

            // the optimize-mode out-of-scope dim (editor-ui.md Mode vocabulary): the timeline
            // dims everything outside the optimized span (`.mode-dim`); the viewport dims the
            // SAME spans — same meaning, same channel. the viewport's span is the curve, not a
            // rect, so the wash strokes over each non-subject section's own polyline, topmost
            // over every rung under it (kind, hover, selection, the dashed-red pass — the dim
            // is topmost there too). width 4 covers the widest rung below (selection, 3).
            // keyed on `modeChromeSection` (kex2d-idioms stage 8): the wash holds through the
            // landing window and releases in one moment with the panel and the hatch.
            const chromeSubj = modeChromeSection();
            if (chromeSubj !== null) {
                const subj = chromeSubj;
                ctx.setLineDash([]);
                ctx.strokeStyle = DIM_WASH;
                ctx.lineWidth = 4;
                for (const seg of segs) {
                    if (seg.id === subj) continue;
                    const to = Math.min(seg.endSample, count - 1);
                    ctx.beginPath();
                    for (let i = seg.startSample; i <= to; i++) {
                        if (i === seg.startSample) ctx.moveTo(xs[i], ys[i]);
                        else ctx.lineTo(xs[i], ys[i]);
                    }
                    ctx.stroke();
                }
            }

            // optimize mode's stamped exit — the constraint idiom (editor-ui.md), not a new
            // glyph language: a hollow ring at the stamp (the demand), and the residual made
            // visible as a dotted drop-line from the section's CURRENT baked exit (the
            // achieved) to it. the line is zero-length while the exit sits on the stamp, so
            // divergence needs no threshold — coincidence simply draws nothing visible.
            if (editor.optimizing) {
                const st = editor.optimizing.stamp;
                const rx = ox + st.x * sx;
                const ry = oy + st.y * sy;
                const info = sectionInfo.get(editor.optimizing.section);
                if (info) {
                    const i = Math.min(info.endSample, count - 1);
                    ctx.strokeStyle = COLOR_GUIDE_RAY;
                    ctx.lineWidth = 1;
                    ctx.setLineDash([2, 3]);
                    ctx.beginPath();
                    ctx.moveTo(xs[i], ys[i]);
                    ctx.lineTo(rx, ry);
                    ctx.stroke();
                    ctx.setLineDash([]);
                }
                ctx.strokeStyle = "#ece8e3";
                ctx.lineWidth = 1.6;
                ctx.beginPath();
                ctx.arc(rx, ry, 7, 0, Math.PI * 2);
                ctx.stroke();
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

        const chromeSubj = modeChromeSection();
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
                // hover, one rung up on the anchor's own color (kex2d stage 6: an order-0 anchor
                // is pickable, so it hovers like any clickable node); selection stays the
                // stronger read (the START's lit stroke wins).
                const hov =
                    editor.hoverNode !== null && editor.hoverNode === handleAt(ecs, sec.id, 0);
                ctx.fillStyle = "#0e0d0c";
                ctx.strokeStyle =
                    sec.order === 0 && editor.start
                        ? "#f0ece8"
                        : hov
                          ? hovered(COLOR_ANCHOR)
                          : COLOR_ANCHOR;
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
                // out-of-scope under optimize mode: wash the same shapes topmost (the dim
                // channel — see TrackDrawSystem, incl. the stage-8 landing hold). the
                // subject's own entry anchor stays bright, like the span boundary on the
                // timeline.
                if (chromeSubj !== null && chromeSubj !== sec.id) {
                    ctx.save();
                    ctx.fillStyle = DIM_WASH;
                    ctx.strokeStyle = DIM_WASH;
                    ctx.fill();
                    ctx.stroke();
                    if (sec.order === 0 && editor.start) {
                        ctx.lineWidth = 1.5;
                        ctx.beginPath();
                        ctx.arc(cx, cy, ANCHOR_R + 4, 0, Math.PI * 2);
                        ctx.stroke();
                    }
                    ctx.restore();
                }
            }
        }
    },
};

const FORCE_R = 5; // the marker diamond's half-diagonal (px) — Timeline.svelte's FMARKER_R

/** the viewport force markers (kex2d-idioms stage 3): every force keyframe drawn ON the baked
 *  track at its stored native-axis position — the timeline's glyph (a filled diamond, force
 *  gold), same entity, same identity on both surfaces. distinguished from boundary anchors by
 *  color (they wear the neutral anchor gray) and from nodes by shape. the kind-color ladder:
 *  selection = the brightened kind color, hover one rung below (invisible on a selected
 *  member), the active member set apart by its stroke; a locked key in optimize mode wears the
 *  CAD driven idiom (dashed + faded — the timeline's `.fpt.driven`). display + select only —
 *  s/g authoring stays on the chart, so nothing here drags. */
const ForceDrawSystem: System = {
    group: "draw",
    update(ecs: State): void {
        const { element: canvas, ctx } = Canvas2D;
        if (!ctx) return;
        const { sx, sy, ox, oy } = viewTransform(canvas);
        const members = editor.forces.ids;
        const active = editor.force;
        const opt = editor.optimizing;
        const chromeSubj = modeChromeSection();

        for (const m of forceMarkers(ecs)) {
            const cx = ox + m.x * sx;
            const cy = oy + m.y * sy;
            const member = members.has(m.id);
            const driven = opt !== null && opt.section === m.section && editor.locked.has(m.id);
            const hov = editor.hoverForce === m.id && !member && !driven;

            ctx.save();
            ctx.beginPath();
            ctx.moveTo(cx, cy - FORCE_R);
            ctx.lineTo(cx + FORCE_R, cy);
            ctx.lineTo(cx, cy + FORCE_R);
            ctx.lineTo(cx - FORCE_R, cy);
            ctx.closePath();
            if (driven) {
                // the driven register (dashed + faded): the kind color at the timeline's own
                // 25% fill over the neutral guide-gray dash. selection still reads (the
                // brightened stroke below) — "selected AND held", like the chart.
                ctx.globalAlpha = 0.25;
                ctx.fillStyle = COLOR_FORCE;
                ctx.fill();
                ctx.globalAlpha = 1;
                ctx.strokeStyle = member ? "#f0ece8" : COLOR_GUIDE_RAY;
                ctx.lineWidth = member ? 1.4 : 1;
                ctx.setLineDash([2, 2]);
                ctx.stroke();
            } else {
                ctx.fillStyle = member
                    ? selected(COLOR_FORCE)
                    : hov
                      ? hovered(COLOR_FORCE)
                      : COLOR_FORCE;
                ctx.strokeStyle = m.id === active ? "#fff" : member ? "#f0ece8" : "#0e0d0c";
                ctx.lineWidth = m.id === active ? 1.8 : member ? 1.4 : 1;
                ctx.fill();
                ctx.stroke();
            }
            // out-of-scope under optimize mode: another section's keyframe washes topmost
            // (the dim channel — see TrackDrawSystem, incl. the stage-8 landing hold); the
            // subject's own keys stay bright. driven styling above keeps reading the MODE
            // (the lock ledger dies with the session).
            if (chromeSubj !== null && chromeSubj !== m.section) {
                ctx.fillStyle = DIM_WASH;
                ctx.strokeStyle = DIM_WASH;
                ctx.lineWidth = 2;
                ctx.fill();
                ctx.stroke();
            }
            ctx.restore();
        }
    },
};

const HandleDrawSystem: System = {
    group: "draw",
    update(ecs: State): void {
        const { element: canvas, ctx } = Canvas2D;
        if (!ctx) return;
        const { sx, sy, ox, oy } = viewTransform(canvas);
        const sel = editor.selection; // the active member (the ring + readout anchor)
        const members = editor.nodes.ids; // the whole selection set (single-select is the size-1 case)
        const chromeSubj = modeChromeSection();

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
            const active = eid === sel;
            const member = members.has(eid); // a selected member (active or not)
            const bad = badHandles.has(eid);
            // hover, one rung up on the node's own color (kex2d stage 6: hover matches what's
            // clickable). invisible on a selected member (selection is the stronger read of the
            // same node) and never over the infeasible register — the standard hover priority.
            const hov = editor.hoverNode === eid && !member && !bad;

            if (member) {
                // every selected member wears the soft accent ring; the active one is set apart by
                // its brighter node stroke below (the ring + readout are active-only).
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

            ctx.fillStyle = bad ? "#5a2c25" : hov ? hovered("#ffd166") : "#ffd166";
            ctx.strokeStyle = bad
                ? COLOR_INFEASIBLE
                : active
                  ? "#f0ece8" // the active member — the brightest stroke (its ring anchors here)
                  : member
                    ? "#d8cbb0" // a non-active selected member — brighter than rest, dimmer than active
                    : hov
                      ? "#d8cbb0" // hovered — the fill + stroke lift one rung below selection
                      : "#8a6a2a";
            ctx.lineWidth = member ? 2 : 1.5;
            ctx.beginPath();
            ctx.arc(cx, cy, HANDLE_R, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            // out-of-scope under optimize mode: wash node + rings topmost (the dim channel —
            // see TrackDrawSystem, incl. the stage-8 landing hold). the subject is always a
            // force section, so every geo node dims; the section guard keeps the rule honest
            // rather than assuming that.
            if (chromeSubj !== null && chromeSubj !== Handle.section.get(eid)) {
                ctx.save();
                ctx.fillStyle = DIM_WASH;
                ctx.strokeStyle = DIM_WASH;
                ctx.fill();
                ctx.stroke();
                ctx.lineWidth = 1.5;
                if (member) {
                    ctx.beginPath();
                    ctx.arc(cx, cy, HANDLE_R_SEL + 3, 0, Math.PI * 2);
                    ctx.stroke();
                }
                if (bad) {
                    ctx.beginPath();
                    ctx.arc(cx, cy, HANDLE_R + 4, 0, Math.PI * 2);
                    ctx.stroke();
                }
                ctx.restore();
            }
        }
    },
};

const TANGENT_KNOB = 3.5; // half-size of a handle knob square (px)

/** the tangent-edited node's handles: an arm from the node to each in/out knob. an *explicit*
 *  node draws solid filled knobs (the authored inner layer); a live tip draws hollow ghost
 *  knobs — the affordance a first drag stamps into an explicit tangent. only the node in
 *  tangent-edit mode (double-clicked) shows any, so mere selection stays uncluttered. at a
 *  geo→geo boundary an extra set draws the downstream node-0's out-handle (the stitch, one node
 *  in two halves), each set colored by its OWN explicit/ghost state. */
const TangentDrawSystem: System = {
    group: "draw",
    update(ecs: State): void {
        const { element: canvas, ctx } = Canvas2D;
        if (!ctx) return;
        const sel = editor.tangentEdit;
        if (sel === null) return;
        const tx = viewTransform(canvas);
        for (const trackEid of ecs.query([Track])) {
            const s = samples.get(trackEid);
            if (!s) continue;
            for (const set of editHandleSets(ecs, s, tx, sel)) {
                if (set.handles.length === 0) continue;
                const i = Handle.sample.get(set.eid);
                const nx = tx.ox + s.posX[i] * tx.sx;
                const ny = tx.oy + s.posY[i] * tx.sy;
                const explicit =
                    handleTangent(ecs, Handle.section.get(set.eid), Handle.order.get(set.eid)) !==
                    undefined;

                ctx.save();
                // the arms — thin, subtle, drawn under the knobs.
                ctx.strokeStyle = "rgba(240, 236, 232, 0.55)";
                ctx.lineWidth = 1;
                ctx.beginPath();
                for (const h of set.handles) {
                    ctx.moveTo(nx, ny);
                    ctx.lineTo(h.x, h.y);
                }
                ctx.stroke();
                // the knobs — a small square (the bezier-handle convention, distinct from the round
                // node). explicit = filled accent; ghost = hollow light outline.
                for (const h of set.handles) {
                    ctx.beginPath();
                    ctx.rect(
                        h.x - TANGENT_KNOB,
                        h.y - TANGENT_KNOB,
                        TANGENT_KNOB * 2,
                        TANGENT_KNOB * 2,
                    );
                    if (explicit) {
                        ctx.fillStyle = COLOR_ACCENT;
                        ctx.strokeStyle = "#0e0d0c";
                        ctx.lineWidth = 1;
                        ctx.fill();
                        ctx.stroke();
                    } else {
                        ctx.fillStyle = "#0e0d0c";
                        ctx.strokeStyle = "rgba(240, 236, 232, 0.7)";
                        ctx.lineWidth = 1;
                        ctx.fill();
                        ctx.stroke();
                    }
                }
                ctx.restore();
            }
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
const SnapGuideSystem: System = {
    group: "draw",
    update(): void {
        const { element: canvas, ctx } = Canvas2D;
        if (!ctx) return;
        if (snapGuides.ray === null) return;
        const { sx, sy, ox, oy } = viewTransform(canvas);
        const { x: rx, y: ry, angle } = snapGuides.ray;
        const cx = ox + rx * sx;
        const cy = oy + ry * sy;
        const L = 1e5;
        const dx = Math.cos(angle);
        const dy = Math.sin(angle);
        ctx.save();
        ctx.strokeStyle = COLOR_GUIDE_RAY;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx + dx * L * sx, cy + dy * L * sy);
        ctx.lineTo(cx - dx * L * sx, cy - dy * L * sy);
        ctx.stroke();
        ctx.restore();
    },
};

/** the viewport marquee (box-select) rect — a screen-space overlay drawn over everything in the
 *  neutral guide register (the same gray the snap ray wears): a faint fill + a thin border. lives
 *  in `view.marquee`, set by the controls each move past the dead zone and cleared on release. */
const MarqueeDrawSystem: System = {
    group: "draw",
    update(): void {
        const { ctx } = Canvas2D;
        if (!ctx || !marquee.rect) return;
        const { minX, minY, maxX, maxY } = marquee.rect;
        ctx.save();
        ctx.fillStyle = "rgba(154, 160, 166, 0.10)"; // COLOR_GUIDE_RAY at low alpha
        ctx.strokeStyle = COLOR_GUIDE_RAY;
        ctx.lineWidth = 1;
        ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
        ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
        ctx.restore();
    },
};

export const RenderPlugin: Plugin = {
    name: "Render",
    systems: [
        GridSystem,
        TrackDrawSystem,
        CartDrawSystem,
        AnchorDrawSystem,
        ForceDrawSystem,
        HandleDrawSystem,
        TangentDrawSystem,
        SnapGuideSystem,
        MarqueeDrawSystem,
    ],
};
