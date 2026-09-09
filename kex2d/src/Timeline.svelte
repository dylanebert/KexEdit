<script lang="ts">
import type { State } from "@dylanebert/shallot";
import { onMount } from "svelte";
import { applyOp, flatRecordArgs, type LaneName } from "./commands";
import { cartArc, cartState, holdForGesture, parkAtArc, parkFromTime, releaseGesture } from "./cart";
import { COLOR_GUIDE_RAY, COLOR_HATCH, HATCH_GAP, laneTone } from "./colors";
import { editor, beginDrag, clearSelection, endDrag, selectRecord, toggleRecord } from "./editor";
import { beginBody, beginEdge, beginEnd, beginHandle, beginRecordEnd, cancel, commit, history, redo, removeRecord, setEase, setOrder, undo } from "./history";
import { Lane, RECORD_FLOOR, laneName } from "./lanes";
import { BINDINGS, bound, fitMenu } from "./menu";
import Menu from "./Menu.svelte";
import { spanMenu } from "./menus";
import Popover from "./Popover.svelte";
import { nudgeAct, timelineKeyAct } from "./keys";
import { type Easing, sampleForce } from "./profile";
import { bakeStations, clampSpanDrag, COLUMN_W, clampView, drivenSpans, endHandle, type FieldSpec, frameAll, hitEndHandle, hitRows, laneRows, laneMembers, marginArc, nudgeQuantum, recordEntry, reorderDrop, reordered, type RowHit, ROW_H, S_GRID, snapAxis, spanBoxes, spanCurve, spanResidual, spanTargets, ticks, uToPx, pxToU, type View, zoomAt } from "./timeline";
import { bakeOut, endColumn, lanesOf, laneOrderOf, recordOf, samples, setEnd, setRecordHandle, setRecordSpan, Track, trackEndOf, type LaneWrite } from "./track";
import { DOCK_HEIGHT, DOCK_INSET, PLAYER_GAP, PLAYER_H, resize } from "./view";

const { ecs, eid, tick }: { ecs: State; eid: number | null; tick: number } = $props();
const RULER_H = 26;
const ROWS_TOP = 32;
const DEAD_ZONE = 4;
let canvas: HTMLCanvasElement;
let dock: HTMLDivElement;
let dockW = $state(0);
let view = $state<View>({ pan: 0, pxPerU: 0 });
let framed = false;
let hover = $state<RowHit>(null);
let onEnd = $state(false);
let tool = $state<"select" | "add">("select");
let snapping = $state(true);
let peeled = $state(false);
let focusKey = $state<string | null>(null);
let ripple = $state(false);
let rippleSubject: number | null = null;
let menu = $state<{ x: number; y: number; items: ReturnType<typeof spanMenu> } | null>(null);
let status = $state("");
let guide = $state<number | null>(null);
let revision = $state(0);
const chartW = $derived(Math.max(0, dockW - COLUMN_W));
const doc = $derived.by(() => {
    void tick;
    return eid === null ? null : { lanes: lanesOf(ecs), order: laneOrderOf(ecs), end: endColumn(ecs), total: trackEndOf(ecs) };
});
const total = $derived(doc?.total ?? 0);
const clamped = $derived(clampView(view, chartW, total, marginArc(total, 50)));
const rows = $derived(doc ? laneRows(doc.lanes, doc.order, ROWS_TOP) : []);
const endH = $derived(doc ? endHandle(doc.lanes, doc.end, clamped, COLUMN_W) : null);
const selected = $derived.by(() => { void tick; return editor.records.ids; });
const busy = $derived.by(() => { void tick; void revision; return editor.dragging; });
const playhead = $derived.by(() => { void tick; return eid === null ? null : cartArc(eid); });
const playing = $derived.by(() => { void tick; return eid !== null && !(cartState.get(eid)?.held ?? true); });
const seconds = $derived.by(() => { void tick; return eid === null ? 0 : (cartState.get(eid)?.t ?? 0); });
const duration = $derived.by(() => { void tick; return eid === null ? 0 : (bakeOut.get(eid)?.tTotal ?? 0); });
const driven = $derived(doc ? drivenSpans(doc.lanes, doc.end, doc.order) : []);
const laneKey = (lane: Lane): LaneName => lane === Lane.Geo ? "geo" : lane === Lane.Force ? "force" : "velocity";
const xOf = (s: number): number => COLUMN_W + uToPx(clamped, s);
const message = (w: LaneWrite): string => w.refusals.map((r) => r.message).join("; ");
const report = (w: LaneWrite): void => { status = message(w); };
function unit(lane: Lane) {
    const scale = lane === Lane.Geo ? 180 / Math.PI : 1;
    return { name: lane === Lane.Geo ? "°" : lane === Lane.Force ? "g" : "m/s", scale, precision: lane === Lane.Geo ? 1 : 2 };
}
function pick(id: number): void {
    selectRecord(id);
    if (rippleSubject !== id) { rippleSubject = id; ripple = false; }
    peeled = false;
    focusKey = null;
}
function switchTool(next: "select" | "add"): void {
    if (editor.dragging || gesture) return;
    tool = next;
    menu = null;
    status = "";
    dock.focus();
}
function hold(): void { if (eid !== null) holdForGesture(eid); }
function release(): void { if (eid !== null) releaseGesture(eid); }

// One lifecycle owns every timeline pointer. The opening projection, snap targets and
// ripple updater remain fixed even when writes change the bake or follow-end extent.
type Gesture = {
    kind: "span" | "add" | "end" | "reorder" | "pan" | "scrub" | "slider";
    pointer: number; x: number; y: number; left: number; top: number;
    frame: View; targets: number[]; pin: number; moved: boolean; opened: boolean;
    id?: number; which?: "start" | "end" | "body"; start: number; end: number;
    lane?: Lane; from?: number; to?: number;
    update?: (end: number) => LaneWrite;
};
let gesture: Gesture | null = null;
function station(g: Gesture, x: number): number { return pxToU(g.frame, x - g.left - COLUMN_W); }
function snap(g: Gesture, value: number, e: PointerEvent): number {
    const result = snapAxis((e.ctrlKey || e.metaKey) ? !snapping : snapping,
        COLUMN_W + uToPx(g.frame, value), value, g.targets, S_GRID,
        (px) => pxToU(g.frame, px - COLUMN_W), null);
    guide = result.guide;
    return result.value;
}
function previewError(g: Gesture): string {
    if (!doc || g.lane === undefined) return "No lane";
    if (g.end - g.start < RECORD_FLOOR) return `Drag at least ${RECORD_FLOOR} m`;
    if (g.start < 0 || (g.pin > 0 && g.end > g.pin)) return "Outside the track bounds";
    if (laneMembers(doc.lanes, g.lane).some((r) => g.start < r.end && g.end > r.start)) return "Overlaps a segment in this lane";
    return "";
}
function finishPointer(land = false): void {
    const g = gesture;
    if (!g) return;
    gesture = null;
    guide = null;
    if (g.opened) {
        if (land) commit(history); else cancel();
    }
    endDrag();
    release();
    if (g.kind === "add") {
        if (!land) { tool = "select"; status = ""; }
        else if (g.moved && !previewError(g)) {
            const result = applyOp(ecs, history, flatRecordArgs(ecs, laneKey(g.lane!), g.start, g.end));
            status = result.refusals.map((r) => r.message).join("; ");
            if (result.id !== undefined && result.id !== null && !result.refusals.length) { pick(result.id); tool = "select"; }
        } else status = previewError(g);
    } else if (land && g.kind === "span" && !g.moved && g.id !== undefined) {
        pick(g.id);
        focusKey = g.which === "body" ? null : g.which!;
    } else if (land && g.kind === "reorder" && doc && g.moved) {
        setOrder(history, ecs, reordered(doc.order, g.from!, g.to!));
    }
    revision++;
}
function pointerMove(e: PointerEvent): void {
    const g = gesture;
    if (!g || e.pointerId !== g.pointer) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.moved && Math.hypot(dx, dy) < DEAD_ZONE) return;
    if (!g.moved) {
        g.moved = true;
        if (g.kind === "span") {
            pick(g.id!);
            if (g.which === "end") g.update = beginRecordEnd(ecs, g.id!, ripple);
            else if (g.which === "body") beginBody(ecs, g.id!);
            else beginEdge(ecs, g.id!);
            g.opened = true;
            hold();
        }
    }
    const raw = station(g, e.clientX);
    if (g.kind === "span") {
        if (!recordOf(ecs, g.id!)) { finishPointer(); return; }
        const which = g.which!;
        if (which === "body") {
            const shift = snap(g, g.start + raw - station(g, g.x), e) - g.start;
            const span = clampSpanDrag(which, g.start + shift, g.end + shift, g.pin);
            report(setRecordSpan(ecs, g.id!, span.start, span.end));
        } else {
            const s = snap(g, raw, e);
            // Ripple is an exact whole-candidate request, never a clamped substitute.
            const span = clampSpanDrag(which, which === "start" ? s : g.start, which === "end" ? s : g.end, g.update && ripple ? 0 : g.pin);
            report(g.update ? g.update(span.end) : setRecordSpan(ecs, g.id!, span.start, span.end));
        }
    } else if (g.kind === "add") {
        const end = snap(g, raw, e);
        const from = g.from!;
        g.start = Math.max(0, Math.min(from, end));
        g.end = Math.max(0, Math.max(from, end));
        status = previewError(g);
    } else if (g.kind === "end") {
        const errors = setEnd(ecs, Math.max(0, snap(g, raw, e)));
        status = errors.map((r) => r.message).join("; ");
    } else if (g.kind === "reorder") g.to = reorderDrop(rows, e.clientY - g.top);
    else if (g.kind === "pan") view = clampView({ pan: g.frame.pan - dx, pxPerU: g.frame.pxPerU }, chartW, total, marginArc(total, 50));
    else if (g.kind === "scrub" && eid !== null) parkAtArc(ecs, eid, Math.max(0, Math.min(total, raw)));
    else if (g.kind === "slider" && eid !== null) {
        const st = cartState.get(eid);
        if (st) { st.t = Math.max(0, Math.min(1, (e.clientX - g.left) / g.end)) * g.start; parkFromTime(ecs, eid); }
    }
    revision++;
}
function chartDown(e: PointerEvent): void {
    if ((e.button !== 0 && e.button !== 1) || eid === null || !doc || editor.dragging || gesture) return;
    e.preventDefault();
    dock.focus();
    menu = null;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const hit = hitRows(rows, clamped, px, py, COLUMN_W);
    const g: Gesture = { kind: "span", pointer: e.pointerId, x: e.clientX, y: e.clientY,
        left: rect.left, top: rect.top, frame: { ...clamped }, targets: [], pin: doc.end,
        moved: false, opened: false, start: 0, end: 0 };
    if (e.button === 1) g.kind = "pan";
    else if (py < RULER_H && px >= COLUMN_W) {
        if (endH && hitEndHandle(endH, px)) { g.kind = "end"; beginEnd(ecs); g.opened = true; }
        else { g.kind = "scrub"; parkAtArc(ecs, eid, Math.max(0, Math.min(total, station(g, e.clientX)))); }
        hold();
    } else if (hit?.kind === "column") { g.kind = "reorder"; g.from = hit.index; g.to = hit.index; }
    else if (hit?.kind === "gap") {
        clearSelection();
        focusKey = null;
        if (tool !== "add") return;
        g.kind = "add"; g.lane = hit.lane; g.start = g.end = Math.max(0, hit.d); hold();
    } else if (hit?.kind === "body" || hit?.kind === "edge") {
        if (tool === "add") return;
        if (e.shiftKey) { toggleRecord(hit.id); focusKey = null; peeled = true; return; }
        const found = recordOf(ecs, hit.id);
        if (!found) return;
        g.id = hit.id; g.lane = hit.lane; g.which = hit.kind === "edge" ? hit.which : "body";
        g.start = found.row.start; g.end = found.row.end;
    } else { clearSelection(); focusKey = null; return; }
    g.targets = spanTargets(doc.lanes, playhead, doc.end, g.id).map((s) => COLUMN_W + uToPx(g.frame, s));
    if (g.kind === "add") g.start = g.end = g.from = Math.max(0, snap(g, g.start, e));
    gesture = g;
    beginDrag(canvas, e.pointerId);
    status = "";
    revision++;
}
function chartMove(e: PointerEvent): void {
    if (gesture || editor.dragging) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    onEnd = endH !== null && py < RULER_H && hitEndHandle(endH, px);
    hover = onEnd ? null : hitRows(rows, clamped, px, py, COLUMN_W);
}
const cursor = $derived.by(() => {
    void revision;
    if (gesture?.kind === "span") return gesture.which === "body" ? "grabbing" : "ew-resize";
    if (gesture?.kind === "pan") return "grabbing";
    if (tool === "add") return "crosshair";
    if (onEnd || hover?.kind === "edge") return "ew-resize";
    return hover?.kind === "body" || hover?.kind === "column" ? "grab" : "default";
});

const subject = $derived.by(() => {
    void tick;
    if (peeled || selected.size !== 1 || editor.record === null) return null;
    const found = recordOf(ecs, editor.record);
    return found ? { id: editor.record, ...found } : null;
});
$effect(() => {
    void tick;
    if (rippleSubject !== editor.record) { rippleSubject = editor.record; ripple = false; focusKey = null; }
    if (gesture?.id !== undefined && !recordOf(ecs, gesture.id)) finishPointer();
});
// S3f's temporary field shell sits above the dock, outside its clip. S3g owns the
// compact measured/disclosed presentation; the shell already holds screen x/y per edit.
const pop = $derived.by(() => {
    void tick;
    if (!subject || !dock) return null;
    const r = dock.getBoundingClientRect();
    return { x: Math.min(Math.max(6, r.left + xOf(subject.row.end) - 135), Math.max(6, window.innerWidth - 276)), y: Math.max(6, r.top - 230) };
});
const fields = $derived.by((): FieldSpec[] => {
    const p = subject;
    if (!p) return [];
    const u = unit(p.lane);
    const wrap = (f: FieldSpec): FieldSpec => ({ ...f,
        begin: () => { if (editor.dragging || gesture) return false; hold(); editor.dragging = true; f.begin(); return true; },
        commit: () => { f.commit(); editor.dragging = false; release(); },
        cancel: () => { f.cancel(); editor.dragging = false; release(); },
    });
    const handle = (which: "entry" | "exit", value: number, readonly = false): FieldSpec => wrap({
        key: which, value: value * u.scale, unit: u.name, precision: u.precision,
        rate: nudgeQuantum(p.lane) * u.scale / 4, readonly,
        begin: () => beginHandle(ecs, p.id, which),
        write: (v) => message(setRecordHandle(ecs, p.id, which, v / u.scale)),
        commit: () => commit(history), cancel,
    });
    const stationField = (key: "start" | "end"): FieldSpec => {
        let updater: ((end: number) => LaneWrite) | undefined;
        return wrap({ key, unit: "m", value: p.row[key], precision: 2, rate: S_GRID / 4,
            begin: () => { if (key === "end") updater = beginRecordEnd(ecs, p.id, ripple); else beginEdge(ecs, p.id); },
            write: (v) => message(updater ? updater(v) : setRecordSpan(ecs, p.id, v, p.row.end)),
            commit: () => commit(history), cancel,
        });
    };
    const out: FieldSpec[] = [];
    const entry = recordEntry(doc!.lanes, p.lane, p.row);
    if (entry !== undefined) out.push(handle("entry", entry, p.row.entry === undefined));
    out.push(handle("exit", p.row.exit), stationField("start"), stationField("end"));
    return out;
});
const residual = $derived.by(() => {
    const p = subject;
    if (!p || eid === null || !driven.some((d) => d.id === p.id)) return null;
    const out = bakeOut.get(eid), sm = samples.get(eid), n = Track.count.get(eid);
    if (!out || !sm) return null;
    const value = spanResidual({ station: bakeStations(out.ds, n), value: p.lane === Lane.Force ? out.fN : sm.theta, n: p.lane === Lane.Force ? n - 1 : n }, p.row, recordEntry(doc!.lanes, p.lane, p.row));
    return value === undefined ? null : `${(value * unit(p.lane).scale).toFixed(2)} ${unit(p.lane).name} recovered − demanded`;
});
function presetGlyph(ease: Easing): string {
    const pts: string[] = [];
    for (let i = 0; i <= 8; i++) {
        const f = i / 8, g = sampleForce([{ s: 0, g: 0, ease }, { s: 1, g: 1, ease }], f);
        pts.push(`${3 + f * 16} ${12 - g * 10}`);
    }
    return `M${pts.join(" L")}`;
}
function chartMenu(e: MouseEvent): void {
    e.preventDefault();
    if (editor.dragging || gesture) return;
    const r = canvas.getBoundingClientRect();
    const hit = hitRows(rows, clamped, e.clientX - r.left, e.clientY - r.top, COLUMN_W);
    menu = null;
    if (hit?.kind !== "body" && hit?.kind !== "edge") return;
    const found = recordOf(ecs, hit.id);
    if (!found) return;
    pick(hit.id);
    menu = { x: e.clientX, y: e.clientY, items: spanMenu({ ease: found.row.ease as Easing, presetGlyph, canDelete: true }, {
        setEase: (ease) => report(setEase(history, ecs, hit.id, ease)),
        remove: () => report(removeRecord(history, ecs, hit.id)),
    }) };
}
function togglePlay(): void {
    if (eid === null || editor.dragging) return;
    const st = cartState.get(eid);
    if (!st) return;
    st.held = !st.held;
    if (st.held) parkFromTime(ecs, eid);
}
function sliderDown(e: PointerEvent): void {
    if (e.button !== 0 || eid === null || editor.dragging || gesture) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement, rect = el.getBoundingClientRect();
    hold();
    gesture = { kind: "slider", pointer: e.pointerId, x: e.clientX, y: e.clientY,
        left: rect.left, top: rect.top, frame: { ...clamped }, targets: [], pin: 0,
        moved: true, opened: false, start: duration, end: rect.width };
    beginDrag(el, e.pointerId);
    pointerMove(e);
}
function nudge(act: NonNullable<ReturnType<typeof nudgeAct>>): void {
    if (editor.record === null) return;
    const id = editor.record, p = recordOf(ecs, id);
    if (!p) return;
    hold();
    if (act.kind === "station") {
        const delta = act.sign * S_GRID;
        const span = clampSpanDrag("body", p.row.start + delta, p.row.end + delta, doc?.end ?? 0);
        beginBody(ecs, id); report(setRecordSpan(ecs, id, span.start, span.end));
    } else {
        beginHandle(ecs, id, "exit"); report(setRecordHandle(ecs, id, "exit", p.row.exit + act.sign * nudgeQuantum(p.lane)));
    }
    commit(history); release();
}
onMount(() => {
    const up = (e: PointerEvent): void => { if (gesture?.pointer === e.pointerId) finishPointer(true); };
    const abort = (): void => finishPointer();
    const wheel = (e: WheelEvent): void => {
        e.preventDefault();
        if (editor.dragging || gesture || menu) return;
        const x = e.clientX - canvas.getBoundingClientRect().left - COLUMN_W;
        view = e.shiftKey ? clampView({ pan: clamped.pan + e.deltaY, pxPerU: clamped.pxPerU }, chartW, total, marginArc(total, 50)) : zoomAt(clamped, x, Math.exp(-e.deltaY / 200), chartW, total, marginArc(total, 50));
    };
    const key = (e: KeyboardEvent): void => {
        const target = e.target as HTMLElement | null;
        if (e.defaultPrevented || target?.matches("input, textarea, select") || target?.isContentEditable) return;
        if (bound(BINDINGS.exitMode, e.key)) {
            if (gesture) finishPointer();
            else if (editor.dragging) return;
            else if (menu) menu = null;
            else if (tool === "add") tool = "select";
            else if (subject) { peeled = true; focusKey = null; }
            else if (selected.size) clearSelection();
            else return;
            e.preventDefault(); return;
        }
        if (editor.dragging || gesture || menu) return;
        if (e.code === "Space") { e.preventDefault(); togglePlay(); return; }
        const local = editor.hover === "timeline" || !!target?.closest(".dock, .tool-strip");
        const act = timelineKeyAct(e.key, { dragging: false, selected: editor.record !== null, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, local });
        if (act) {
            e.preventDefault();
            if (act === "selectTool" || act === "addTool") switchTool(act === "selectTool" ? "select" : "add");
            else if (act === "undo") undo(history, ecs);
            else if (act === "redo") redo(history, ecs);
            else if (act === "toggleSnap") snapping = !snapping;
            else if (editor.record !== null) report(removeRecord(history, ecs, editor.record));
            return;
        }
        if (e.ctrlKey || e.metaKey) return;
        const a = nudgeAct(e, { dragging: false, selected: editor.record !== null, shift: e.shiftKey, alt: e.altKey, ownsEntry: false });
        if (a) { e.preventDefault(); nudge(a); }
    };
    const dismiss = (e: PointerEvent): void => { if (menu && !(e.target as HTMLElement)?.closest(".menu-anchor")) menu = null; };
    window.addEventListener("pointermove", pointerMove);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", abort);
    window.addEventListener("blur", abort);
    window.addEventListener("resize", abort);
    window.addEventListener("keydown", key);
    window.addEventListener("pointerdown", dismiss);
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => {
        finishPointer();
        window.removeEventListener("pointermove", pointerMove);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", abort);
        window.removeEventListener("blur", abort);
        window.removeEventListener("resize", abort);
        window.removeEventListener("keydown", key);
        window.removeEventListener("pointerdown", dismiss);
        canvas.removeEventListener("wheel", wheel);
    };
});

function render(ctx: CanvasRenderingContext2D): void {
    ctx.clearRect(0, 0, dockW, DOCK_HEIGHT);
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textBaseline = "middle";
    ctx.save(); ctx.beginPath(); ctx.rect(COLUMN_W, 0, chartW, DOCK_HEIGHT); ctx.clip();
    ctx.fillStyle = "rgba(255,255,255,.04)"; ctx.fillRect(COLUMN_W, 0, chartW, RULER_H);
    ctx.fillStyle = "#a09890"; ctx.textAlign = "center";
    for (const t of ticks(clamped, chartW)) ctx.fillText(t.label, COLUMN_W + t.px, 12);
    ctx.restore();
    for (const row of rows) {
        ctx.fillStyle = "rgba(0,0,0,.24)"; ctx.fillRect(COLUMN_W, row.top, chartW, ROW_H);
        ctx.fillStyle = laneTone(row.lane, "base"); ctx.textAlign = "left"; ctx.fillText(row.name, 10, row.top + ROW_H / 2);
        ctx.save(); ctx.beginPath(); ctx.rect(COLUMN_W, row.top, chartW, ROW_H); ctx.clip();
        const boxes = spanBoxes(row, clamped, COLUMN_W);
        for (const box of boxes) {
            const rec = row.records.find((r) => r.id === box.id)!;
            const tone = selected.has(box.id) ? "selected" : hover?.kind === "body" && hover.id === box.id ? "hover" : "base";
            const color = laneTone(row.lane, tone);
            ctx.fillStyle = color; ctx.globalAlpha = tone === "base" ? .34 : .5;
            ctx.fillRect(box.x0, box.y0, box.x1 - box.x0, ROW_H); ctx.globalAlpha = 1;
            ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath();
            const pts = spanCurve(rec, recordEntry(doc!.lanes, row.lane, rec), box, 4);
            for (let i = 0; i < pts.length; i++) { const p = pts[i]!; if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }
            ctx.stroke();
        }
        // Hatch qualifies the body; handles are painted in the final pass above it.
        for (const d of driven) {
            if (d.lane !== row.lane) continue;
            ctx.save(); ctx.beginPath(); ctx.rect(xOf(d.start), row.top, xOf(d.end) - xOf(d.start), ROW_H); ctx.clip();
            ctx.globalAlpha = .5; ctx.strokeStyle = COLOR_HATCH; ctx.lineWidth = 1; ctx.beginPath();
            for (let x = xOf(d.start) - ROW_H; x < xOf(d.end); x += HATCH_GAP) { ctx.moveTo(x, row.top + ROW_H); ctx.lineTo(x + ROW_H, row.top); }
            ctx.stroke(); ctx.restore();
        }
        for (const box of boxes) for (const which of ["start", "end"] as const) {
            const active = gesture?.kind === "span" && gesture.id === box.id && gesture.which === which;
            const hot = hover?.kind === "edge" && hover.id === box.id && hover.which === which;
            const x = which === "start" ? box.x0 : box.x1 - 2;
            ctx.fillStyle = laneTone(row.lane, active ? "selected" : hot ? "hover" : "base");
            ctx.fillRect(x, box.y0, 2, ROW_H);
            if (active || hot) { ctx.strokeStyle = active ? "#fff" : "#d8d4ce"; ctx.lineWidth = 1; ctx.strokeRect(x + .5, box.y0 + .5, 1, ROW_H - 1); }
            if (which === "end" && ripple && rippleSubject === box.id) { ctx.fillStyle = laneTone(row.lane, "selected"); ctx.textAlign = "right"; ctx.fillText("Ripple end", box.x1 - 5, box.y0 + 9); }
        }
        if (gesture?.kind === "add" && gesture.lane === row.lane) {
            ctx.fillStyle = previewError(gesture) ? "#e87878" : laneTone(row.lane, "selected"); ctx.globalAlpha = .3;
            ctx.fillRect(xOf(gesture.start), row.top, xOf(gesture.end) - xOf(gesture.start), ROW_H); ctx.globalAlpha = 1;
            ctx.strokeStyle = previewError(gesture) ? "#e87878" : laneTone(row.lane, "selected");
            ctx.strokeRect(xOf(gesture.start), row.top + .5, xOf(gesture.end) - xOf(gesture.start), ROW_H - 1);
        }
        ctx.restore();
    }
    if (endH) { ctx.strokeStyle = endH.pinned ? "#ece8e3" : "#898580"; ctx.lineWidth = onEnd ? 2 : 1; ctx.beginPath(); ctx.moveTo(endH.px, 0); ctx.lineTo(endH.px, 24); ctx.stroke(); }
    for (const [x, color] of [[guide, COLOR_GUIDE_RAY], [playhead === null ? null : xOf(playhead), "#f0ece8"]] as const) {
        if (x === null || x < COLUMN_W) continue;
        ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, DOCK_HEIGHT - 8); ctx.stroke();
    }
}
$effect(() => {
    void tick; void revision; void clamped; void rows; void hover; void onEnd; void selected; void driven; void playhead; void ripple; void guide;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (ctx) { resize(canvas, ctx, dockW, DOCK_HEIGHT); render(ctx); }
});
$effect(() => { if (!framed && chartW > 0 && total > 0) { framed = true; view = frameAll(chartW, total, marginArc(total, 50)); } });
const feedback = $derived.by(() => {
    void revision;
    const g = gesture;
    if (g?.kind === "add") return `${g.start.toFixed(2)}–${g.end.toFixed(2)} m · ${(g.end - g.start).toFixed(2)} m · ${status || "Valid"}`;
    if (g?.kind === "span" && g.moved && g.id !== undefined) { const r = recordOf(ecs, g.id)?.row; if (r) return `${r.start.toFixed(2)}–${r.end.toFixed(2)} m · ${(r.end - r.start).toFixed(2)} m${status ? ` · ${status}` : ""}`; }
    return status;
});
</script>

<div class="tool-strip" role="group" aria-label="Timeline tools" style="bottom: {DOCK_INSET + DOCK_HEIGHT + PLAYER_GAP}px">
    <button type="button" aria-pressed={tool === "select"} disabled={busy} title="Select ({BINDINGS.selectTool.hint})" onclick={() => switchTool("select")}>Select ({BINDINGS.selectTool.hint})</button>
    <button type="button" aria-pressed={tool === "add"} disabled={busy} title="Add Segment ({BINDINGS.addTool.hint})" onclick={() => switchTool("add")}>Add Segment ({BINDINGS.addTool.hint})</button>
</div>
<div class="dock" bind:this={dock} bind:clientWidth={dockW} style="bottom: {DOCK_INSET}px; height: {DOCK_HEIGHT}px" tabindex="-1" role="group" aria-label="Timeline"
    onpointerenter={() => (editor.hover = "timeline")}
    onpointerleave={() => { editor.hover = "viewport"; hover = null; onEnd = false; }}>
    <canvas class="chart" bind:this={canvas} data-view={JSON.stringify(clamped)} data-rows={JSON.stringify(rows.map((r) => ({ lane: laneKey(r.lane), top: r.top, height: r.height, records: r.records.map(({ id, start, end }) => ({ id, start, end })) })))} style:cursor onpointerdown={chartDown} onpointermove={chartMove} oncontextmenu={chartMenu}></canvas>
    {#if feedback}<div class="feedback" role="status">{feedback}</div>{/if}
</div>
{#if subject && pop}
    {#key subject.id}
            <Popover x={pop.x} y={pop.y} title={laneName(subject.lane)} {fields} ease={subject.row.ease as Easing}
                onease={(v) => report(setEase(history, ecs, subject.id, v))} {residual} {focusKey} {ripple} {busy}
                onripple={(v) => { if (!editor.dragging) ripple = v; }} onpeel={() => { peeled = true; focusKey = null; }} />
    {/key}
{/if}
{#if menu}<div class="menu-anchor menu" role="menu" use:fitMenu={{ x: menu.x, y: menu.y }}><Menu items={menu.items} onclose={() => (menu = null)} /></div>{/if}
<div class="player" role="group" aria-label="Playback" style="bottom: {DOCK_INSET + DOCK_HEIGHT + PLAYER_GAP}px; height: {PLAYER_H}px">
    <button type="button" onclick={togglePlay} disabled={busy} aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause (Space)" : "Play (Space)"}>{playing ? "Ⅱ" : "▶"}</button>
    <div class="scrub" role="slider" tabindex="0" aria-label="Playback position" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={seconds} onpointerdown={sliderDown}>
        <div class="fill" style="width: {duration > 0 ? seconds / duration * 100 : 0}%"></div>
    </div>
    <span>{seconds.toFixed(2)} / {duration.toFixed(2)} s</span>
</div>
<style>
    .dock { position: absolute; left: 50%; transform: translateX(-50%); width: calc(100% - 32px); max-width: 1280px; background: var(--bg-solid); border: 1px solid var(--border); border-radius: 6px; box-shadow: var(--shadow); overflow: hidden; outline: none; }
    .chart { display: block; width: 100%; height: 100%; touch-action: none; }
    .tool-strip, .player { position: absolute; display: flex; align-items: center; gap: 6px; font: 11px "JetBrains Mono", monospace; color: var(--fg); }
    .tool-strip { left: 16px; z-index: 3; }
    .player { right: 16px; }
    button { font: inherit; color: inherit; background: var(--bg-solid); border: 1px solid var(--border); border-radius: 4px; padding: 5px 8px; cursor: pointer; }
    button[aria-pressed="true"] { color: var(--accent); border-color: var(--accent); }
    button:disabled { opacity: .5; cursor: default; }
    .scrub { width: 160px; height: 6px; background: var(--border); cursor: pointer; touch-action: none; }
    .fill { height: 100%; background: var(--fg); pointer-events: none; }
    .feedback { position: absolute; bottom: 4px; left: 80px; font: 10px "JetBrains Mono", monospace; color: var(--fg); background: var(--bg-solid); pointer-events: none; }
    .menu-anchor { position: fixed; z-index: 8; }
</style>
