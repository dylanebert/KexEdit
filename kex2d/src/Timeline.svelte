<script lang="ts">
import type { State } from "@dylanebert/shallot";
import { onMount } from "svelte";
import { applyOp, flatRecordArgs, type LaneName } from "./commands";
import { cartArc, cartState, holdForGesture, parkAtArc, parkFromTime, releaseGesture } from "./cart";
import { COLOR_GUIDE_RAY, COLOR_HATCH, HATCH_GAP, laneColor, laneTone } from "./colors";
import { editor, beginDrag, clearSelection, endDrag, selectRecord, toggleRecord } from "./editor";
import { beginBody, beginEdge, beginEnd, beginHandle, beginRecordEnd, cancel, commit, history, redo, removeRecord, setEase, setOrder, undo } from "./history";
import { Lane, RECORD_FLOOR } from "./lanes";
import { BINDINGS, bound, fitMenu } from "./menu";
import Menu from "./Menu.svelte";
import { EASING_GLYPHS, spanMenu } from "./menus";
import Popover from "./Popover.svelte";
import { nudgeAct, timelineKeyAct } from "./keys";
import type { Easing } from "./profile";
import { editorFits, type ScreenBox, fitAttachedStatus, fitEditor, recoveredAt, bakeStations, clampSpanDrag, COLUMN_W, clampView, drivenSpans, endHandle, dragAxis, type FieldSpec, fitLaneValue, frameAll, hitEndHandle, hitRows, knotPoints, laneRows, laneMembers, laneValueAxis, marginArc, nudgeQuantum, recordEntry, recoveredPolyline, reorderDrop, reordered, type BakeRead, type RowHit, ROW_H, S_GRID, snapAxis, spanBoxes, spanCurve, spanTargets, ticks, uToPx, pxToU, type View, valueChart, type YFit, yEase, yGrow, zoomAt } from "./timeline";
import { bakeOut, endColumn, lanesOf, laneOrderOf, recordOf, samples, setEnd, setRecordHandle, setRecordSpan, Track, trackEndOf, type LaneWrite, V0 } from "./track";
import { DOCK_HEIGHT, DOCK_INSET, PLAYER_GAP, PLAYER_H, ROWS_TOP, TOOL_STRIP_W, TOOL_GAP, resize } from "./view";

const { ecs, eid, tick }: { ecs: State; eid: number | null; tick: number } = $props();
const RULER_H = 26;
const DEAD_ZONE = 4;
let canvas: HTMLCanvasElement;
let dock: HTMLDivElement;
let dockW = $state(0);
let chartH = $state(0);
let panelSize = $state({ w: 0, h: 0 });
let invocation: { id: number; box: ScreenBox; frame: ScreenBox } | null = $state(null);
let gestureAnchor: ScreenBox | null = $state(null);
let statusSize = $state({ w: 0, h: 0 });
let player: HTMLDivElement;
let tools: HTMLDivElement;
let playerCenter = $state(0);
let layoutRevision = $state(0);
let view = $state<View>({ pan: 0, pxPerU: 0 });
let framed = false;
let hover = $state<RowHit>(null);
let onEnd = $state(false);
let tool = $state<"select" | "add">("select");
let snapping = $state(true);
let peeled = $state(false);
let focusKey = $state<string | null>(null);
let focusRequest = $state(0);
let menu = $state<{ x: number; y: number; above: number; items: ReturnType<typeof spanMenu> } | null>(null);
let status = $state("");
let guide = $state<number | null>(null);
let revision = $state(0);
let valueWindows = $state<Record<LaneName, YFit | null>>({ geo: null, force: null, velocity: null });
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
const velocityBase = $derived(V0);
const VALUE_GROW_RATE = 0.2;
const VALUE_RETURN_GROW = 0.3;
const VALUE_RETURN_SHRINK = 0.25;

type ValueRow = {
    row: ReturnType<typeof laneRows>[number];
    entries: (number | undefined)[];
    target: YFit;
    chart: ReturnType<typeof valueChart>;
    read: BakeRead | null;
};

function valueRead(lane: Lane): BakeRead | null {
    if (eid === null) return null;
    const out = bakeOut.get(eid), count = Track.count.get(eid), sm = samples.get(eid);
    if (!out || !sm || count < 1) return null;
    const station = bakeStations(out.ds, count);
    if (lane === Lane.Force)
        return { station, value: out.fN, n: Math.max(0, count - 1), edge: true };
    if (lane === Lane.Geo) return { station, value: sm.theta, n: count };
    return { station, value: out.v, n: count };
}

function valuesForRecord(read: BakeRead | null, record: { start: number; end: number }, entry: number | undefined): number[] {
    if (!read || entry === undefined) return [];
    const edge = read.edge === true;
    if (recoveredAt(read, record.start, edge) === undefined || recoveredAt(read, record.end, edge) === undefined) return [];
    const out: number[] = [];
    for (let i = 0; i < read.n; i++) {
        const station = read.station[i], value = read.value[i];
        if (station !== undefined && value !== undefined && station >= record.start && station <= record.end && Number.isFinite(value)) out.push(value);
    }
    const start = recoveredAt(read, record.start, edge), end = recoveredAt(read, record.end, edge);
    if (start !== undefined) out.push(start);
    if (end !== undefined) out.push(end);
    return out;
}

const valueRows = $derived.by((): ValueRow[] => {
    void tick; void selected; void revision;
    if (!doc) return [];
    return rows.map((row) => {
        const entries = row.records.map((record) => recordEntry(doc.lanes, row.lane, record));
        const read = valueRead(row.lane);
        const recovered = row.records.flatMap((record, i) => selected.has(record.id) ? valuesForRecord(read, record, entries[i]) : []);
        const target = fitLaneValue(row.lane, row.records, entries, recovered, velocityBase);
        const current = valueWindows[laneKey(row.lane)];
        return { row, entries, target, chart: valueChart(row, current ?? target), read };
    });
});
function valueRow(lane: Lane): ValueRow | undefined { return valueRows.find((item) => item.row.lane === lane); }
const knots = $derived.by(() => valueRows.flatMap((item) => knotPoints(item.row, item.entries, item.chart, clamped, COLUMN_W)));
$effect(() => {
    void valueRows;
    for (const item of valueRows) {
        const key = laneKey(item.row.lane), current = valueWindows[key];
        if (current === null) valueWindows[key] = item.target;
        else if (!(gesture?.kind === "value" && gesture.lane === item.row.lane)) {
            const next = yEase(current, item.target, VALUE_RETURN_GROW, VALUE_RETURN_SHRINK);
            if (next !== current) valueWindows[key] = next;
        }
    }
});
const xOf = (s: number): number => COLUMN_W + uToPx(clamped, s);
const message = (w: LaneWrite): string => w.refusals.map((r) => r.message).join("; ");
const report = (w: LaneWrite): void => { status = message(w); };
function unit(lane: Lane) {
    const scale = lane === Lane.Geo ? 180 / Math.PI : 1;
    return { name: lane === Lane.Geo ? "°" : lane === Lane.Force ? "g" : "m/s", scale, precision: lane === Lane.Geo ? 1 : 2 };
}
function pick(id: number, box?: ScreenBox): void {
    selectRecord(id);
    peeled = false;
    focusKey = null;
    invocation = box ? { id, box, frame: screenBox(canvas) } : null;
    status = "";
}
function switchTool(next: "select" | "add"): void {
    if (editor.dragging || gesture) return;
    tool = next;
    menu = null;
    status = "";
    dock.focus();
}
function toggleSnapping(): void {
    if (editor.dragging || gesture) return;
    snapping = !snapping;
}
function hold(): void { if (eid !== null) holdForGesture(eid); }
function release(): void { if (eid !== null) releaseGesture(eid); }

// One lifecycle owns every timeline pointer. The opening projection and snap targets remain fixed
// even when writes change the bake or follow-end extent.
type Gesture = {
    kind: "span" | "knot" | "value" | "add" | "end" | "reorder" | "pan" | "scrub" | "slider";
    pointer: number; x: number; y: number; left: number; top: number;
    frame: View; targets: number[]; pin: number; moved: boolean; opened: boolean; axis?: "value" | "station";
    id?: number; which?: "start" | "end" | "body" | "entry" | "exit"; start: number; end: number;
    value?: number; rate?: number;
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
function valueSnap(value: number, lane: Lane, e: PointerEvent): number {
    const active = (e.ctrlKey || e.metaKey) ? !snapping : snapping;
    if (!active) return value;
    const quantum = nudgeQuantum(lane);
    return Math.round(value / quantum) * quantum;
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
        pick(g.id, { x: g.x, y: g.top + rows.find((r) => r.lane === g.lane)!.top, w: 0, h: ROW_H });
        focusKey = g.which === "body" ? null : g.which!;
        focusRequest++;
    } else if (land && g.kind === "knot" && !g.moved && g.id !== undefined) {
        pick(g.id, { x: g.x, y: g.top + rows.find((r) => r.lane === g.lane)!.top, w: 0, h: ROW_H });
        if (g.which === "exit") { focusKey = "exit"; focusRequest++; }
    } else if (land && g.kind === "reorder" && doc && g.moved) {
        setOrder(history, ecs, reordered(doc.order, g.from!, g.to!));
    }
    if (!status) gestureAnchor = null;
    revision++;
}
function pointerMove(e: PointerEvent): void {
    const g = gesture;
    if (!g || e.pointerId !== g.pointer) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.moved && Math.hypot(dx, dy) < DEAD_ZONE) return;
    if (!g.moved) {
        if (g.kind === "knot") {
            // The dead-zone crossing chooses the axis once. A later diagonal change cannot turn a
            // value edit into a station edit or vice versa.
            g.axis = dragAxis(dx, dy, DEAD_ZONE)!;
            if (g.axis === "value") {
                g.kind = "value";
                g.moved = true;
                if (g.which === "exit" && g.lane !== undefined) {
                    const info = valueRow(g.lane), found = g.id === undefined ? undefined : recordOf(ecs, g.id);
                    if (info && found) {
                        g.value = found.row.exit;
                        g.rate = (info.chart.hi - info.chart.lo) / Math.max(1, info.chart.bottom - info.chart.top);
                        beginHandle(ecs, g.id!, "exit");
                        g.opened = true;
                        hold();
                        pick(g.id!, { x: g.x, y: g.top + info.row.top, w: 0, h: ROW_H });
                    }
                }
            } else {
                g.kind = "span";
                g.moved = true;
                if (g.id !== undefined) {
                    pick(g.id, { x: g.x, y: g.top + rows.find((r) => r.lane === g.lane)!.top, w: 0, h: ROW_H });
                    if (g.which === "end") g.update = beginRecordEnd(ecs, g.id, false);
                    else if (g.which === "body") beginBody(ecs, g.id);
                    else beginEdge(ecs, g.id);
                    g.opened = true;
                    hold();
                }
            }
        } else {
            g.moved = true;
            if (g.kind === "span") {
                pick(g.id!, { x: g.x, y: g.top + rows.find((r) => r.lane === g.lane)!.top, w: 0, h: ROW_H });
                if (g.which === "end") g.update = beginRecordEnd(ecs, g.id!, false);
                else if (g.which === "body") beginBody(ecs, g.id!);
                else beginEdge(ecs, g.id!);
                g.opened = true;
                hold();
            }
        }
    }
    const raw = station(g, e.clientX);
    if (g.kind === "value") {
        guide = null;
        if (g.which === "exit" && g.id !== undefined && g.lane !== undefined && g.rate !== undefined && g.value !== undefined) {
            const info = valueRow(g.lane);
            if (info) {
                const current = valueWindows[laneKey(g.lane)] ?? info.target;
                const axis = laneValueAxis(g.lane, velocityBase);
                const next = yGrow(current, e.clientY - g.top, info.chart.top, info.chart.bottom, VALUE_GROW_RATE, axis.cap);
                if (next !== current) valueWindows[laneKey(g.lane)] = next;
                report(setRecordHandle(ecs, g.id, "exit", valueSnap(g.value - (e.clientY - g.y) * g.rate, g.lane, e)));
            }
        }
    } else if (g.kind === "span") {
        if (!recordOf(ecs, g.id!)) { finishPointer(); return; }
        const which = g.which as "start" | "end" | "body";
        if (which === "body") {
            const shift = snap(g, g.start + raw - station(g, g.x), e) - g.start;
            const span = clampSpanDrag(which, g.start + shift, g.end + shift, g.pin);
            report(setRecordSpan(ecs, g.id!, span.start, span.end));
        } else {
            const s = snap(g, raw, e);
            const span = clampSpanDrag(which, which === "start" ? s : g.start, which === "end" ? s : g.end, g.pin);
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
    if (px > COLUMN_W + chartW) return;
    const hit = hitRows(rows, clamped, px, py, COLUMN_W, knots);
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
    } else if (hit?.kind === "body" || hit?.kind === "edge" || hit?.kind === "knot") {
        if (tool === "add") return;
        if (e.shiftKey) { toggleRecord(hit.id); focusKey = null; peeled = true; return; }
        const found = recordOf(ecs, hit.id);
        if (!found) return;
        g.kind = hit.kind === "knot" ? "knot" : "span";
        g.id = hit.id; g.lane = hit.lane; g.which = hit.kind === "body" ? "body" : hit.which;
        g.start = found.row.start; g.end = found.row.end;
    } else { clearSelection(); focusKey = null; return; }
    gestureAnchor = { x: e.clientX, y: rect.top + (g.lane === undefined ? py : rows.find((r) => r.lane === g.lane)!.top), w: 0, h: g.lane === undefined ? 0 : ROW_H };
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
    hover = onEnd || px > COLUMN_W + chartW ? null : hitRows(rows, clamped, px, py, COLUMN_W, knots);
}
const cursor = $derived.by(() => {
    void revision;
    if (gesture?.kind === "value") return "ns-resize";
    if (gesture?.kind === "knot") return "ns-resize";
    if (gesture?.kind === "span") return gesture.which === "body" ? "grabbing" : "ew-resize";
    if (gesture?.kind === "pan") return "grabbing";
    if (tool === "add") return "crosshair";
    if (onEnd || hover?.kind === "edge") return "ew-resize";
    if (hover?.kind === "knot") return "ns-resize";
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
    if (gesture?.id !== undefined && !recordOf(ecs, gesture.id)) finishPointer();
    if (gesture && gesture.kind !== "slider" && canvas) {
        const rect = canvas.getBoundingClientRect();
        if (rect.left !== gesture.left || rect.top !== gesture.top) finishPointer();
    }
});
function screenBox(el: HTMLElement): ScreenBox {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
}
const anchor = $derived.by((): ScreenBox | null => {
    void tick; void layoutRevision;
    if (!subject || !canvas) return null;
    const c = screenBox(canvas), row = rows.find((r) => r.lane === subject.lane)!;
    const left = Math.max(c.x + COLUMN_W, c.x + xOf(subject.row.start));
    const right = Math.min(c.x + COLUMN_W + chartW, c.x + xOf(subject.row.end));
    if (left > right) return null;
    return invocation?.id === subject.id ? { ...invocation.box, x: invocation.box.x + c.x - invocation.frame.x, y: invocation.box.y + c.y - invocation.frame.y } : { x: (left + right) / 2, y: c.y + row.top, w: 0, h: ROW_H };
});
const obstacles = $derived.by((): ScreenBox[] => {
    void tick; void layoutRevision;
    if (!subject || !canvas || !player || !tools) return [];
    const c = screenBox(canvas), row = rows.find((r) => r.lane === subject.lane)!;
    return [screenBox(player), screenBox(tools), ...[subject.row.start, subject.row.end].map((s) => ({ x: c.x + xOf(s) - 2, y: c.y + row.top, w: 4, h: ROW_H }))];
});
const pop = $derived(anchor ? fitEditor(panelSize, { w: window.innerWidth, h: window.innerHeight }, obstacles, anchor) : null);
function peel(): void { focusKey = null; invocation = null; gestureAnchor = null; }
function summon(key: "exit" | "entry" | "start" | "end", invoker: ScreenBox): void {
    menu = null;
    if (!subject) return;
    status = "";
    invocation = { id: subject.id, box: invoker, frame: screenBox(canvas) };
    focusKey = key;
    focusRequest++;
}
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
        name: which, value: value * u.scale, unit: u.name, precision: u.precision,
        rate: nudgeQuantum(p.lane) * u.scale / 4, readonly,
        begin: () => beginHandle(ecs, p.id, which),
        write: (v) => message(setRecordHandle(ecs, p.id, which, v / u.scale)),
        commit: () => commit(history), cancel,
    });
    const stationField = (key: "start" | "end"): FieldSpec => {
        let updater: ((end: number) => LaneWrite) | undefined;
        return wrap({ name: key, unit: "m", value: p.row[key], precision: 2, rate: S_GRID / 4,
            begin: () => { if (key === "end") updater = beginRecordEnd(ecs, p.id, false); else beginEdge(ecs, p.id); },
            write: (v) => message(updater ? updater(v) : setRecordSpan(ecs, p.id, v, p.row.end)),
            commit: () => commit(history), cancel,
        });
    };
    const out: FieldSpec[] = [];
    const entry = recordEntry(doc!.lanes, p.lane, p.row);
    out.push(handle("exit", p.row.exit), handle("entry", entry ?? NaN), stationField("start"), stationField("end"));
    return out;
});
function changeEntry(): string {
    if (!subject || editor.dragging) return "An edit is already active";
    const result = applyOp(ecs, history, { type: "record-handle", id: subject.id, which: "entry" });
    status = result.refusals.map((r) => r.message).join("; ");
    if (!status && subject.lane === Lane.Velocity && recordEntry(lanesOf(ecs), subject.lane, recordOf(ecs, subject.id)!.row) === undefined) status = "Unresolved entry · prescription unavailable";
    return status;
}
function actions(invoker: ScreenBox): void {
    if (!subject || editor.dragging || gesture || !anchor) return;
    const id = subject.id;
    menu = { x: invoker.x, y: invoker.y + invoker.h + 8, above: invoker.y - 8, items: spanMenu({ ease: subject.row.ease as Easing, presetGlyph: (ease) => EASING_GLYPHS[ease], canDelete: true, entry: { owned: subject.row.entry !== undefined } }, {
        field: (key) => summon(key, invoker),
        inherit: () => { menu = null; changeEntry(); },
        setEase: (ease) => { menu = null; report(setEase(history, ecs, id, ease)); },
        remove: () => { menu = null; report(removeRecord(history, ecs, id)); },
    }) };
}
function chartMenu(e: MouseEvent): void {
    e.preventDefault();
    if (editor.dragging || gesture) return;
    const r = canvas.getBoundingClientRect();
    if (e.clientX - r.left > COLUMN_W + chartW) return;
    const hit = hitRows(rows, clamped, e.clientX - r.left, e.clientY - r.top, COLUMN_W, knots);
    menu = null;
    if (hit?.kind !== "body" && hit?.kind !== "edge" && hit?.kind !== "knot") return;
    const found = recordOf(ecs, hit.id);
    if (!found) return;
    const invoker = { x: e.clientX, y: r.top + rows.find((row) => row.lane === hit.lane)!.top, w: 0, h: ROW_H };
    pick(hit.id, invoker);
    actions(invoker);
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
    const viewport = document.querySelector<HTMLCanvasElement>("canvas.viewport");
    const measureLayout = (): void => {
        if (viewport) { const r = viewport.getBoundingClientRect(); playerCenter = r.left + viewport.clientLeft + viewport.clientWidth / 2; }
        layoutRevision++;
    };
    const observer = new ResizeObserver(measureLayout);
    if (viewport) observer.observe(viewport);
    observer.observe(dock);
    measureLayout();
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
            else if (focusKey !== null) peel();
            else if (selected.size) clearSelection();
            else return;
            e.preventDefault(); return;
        }
        if (editor.dragging || gesture || menu) return;
        if (e.code === "Space" && !target?.closest("button")) { e.preventDefault(); togglePlay(); return; }
        const local = editor.hover === "timeline" || !!target?.closest(".dock, .tool-strip");
        const act = timelineKeyAct(e.key, { dragging: false, selected: editor.record !== null, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, local });
        if (act) {
            e.preventDefault();
            if (act === "selectTool" || act === "addTool") switchTool(act === "selectTool" ? "select" : "add");
            else if (act === "undo") undo(history, ecs);
            else if (act === "redo") redo(history, ecs);
            else if (act === "toggleSnap") toggleSnapping();
            else if (editor.record !== null) report(removeRecord(history, ecs, editor.record));
            return;
        }
        if (e.ctrlKey || e.metaKey) return;
        const a = nudgeAct(e, { dragging: false, selected: editor.record !== null, shift: e.shiftKey, alt: e.altKey, ownsEntry: false });
        if (a) { e.preventDefault(); nudge(a); }
    };
    const dismiss = (e: PointerEvent): void => {
        if ((e.target as HTMLElement)?.closest(".menu-anchor, .popover")) return;
        menu = null;
        if (!editor.dragging && !gesture) peel();
    };
    window.addEventListener("pointermove", pointerMove);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", abort);
    window.addEventListener("blur", abort);
    window.addEventListener("resize", abort);
    window.addEventListener("keydown", key);
    window.addEventListener("pointerdown", dismiss);
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => {
        observer.disconnect();
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
    ctx.clearRect(0, 0, dockW, chartH);
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textBaseline = "middle";
    ctx.save(); ctx.beginPath(); ctx.rect(COLUMN_W, 0, chartW, chartH); ctx.clip();
    ctx.fillStyle = "rgba(255,255,255,.04)"; ctx.fillRect(COLUMN_W, 0, chartW, RULER_H);
    ctx.fillStyle = "#a09890"; ctx.textAlign = "center";
    for (const t of ticks(clamped, chartW)) ctx.fillText(t.label, t.s === 0 ? Math.max(COLUMN_W + ctx.measureText(t.label).width / 2 + 2, COLUMN_W + t.px) : COLUMN_W + t.px, 12);
    ctx.restore();
    for (const row of rows) {
        const value = valueRow(row.lane);
        ctx.fillStyle = "rgba(0,0,0,.24)"; ctx.fillRect(COLUMN_W, row.top, chartW, ROW_H);
        ctx.save(); ctx.beginPath(); ctx.rect(COLUMN_W, row.top, chartW, ROW_H); ctx.clip();
        const boxes = spanBoxes(row, clamped, COLUMN_W);
        if (value) for (const box of boxes) {
            const rec = row.records.find((r) => r.id === box.id)!;
            if (!selected.has(box.id) || !value.read) continue;
            const entry = value.entries[row.records.indexOf(rec)];
            const edge = value.read.edge === true;
            const available = entry !== undefined && recoveredAt(value.read, rec.start, edge) !== undefined && recoveredAt(value.read, rec.end, edge) !== undefined;
            const pts = recoveredPolyline(value.read, value.chart, clamped, COLUMN_W, { start: rec.start, end: rec.end, available });
            if (pts.length > 1) {
                ctx.save(); ctx.globalAlpha = .42; ctx.strokeStyle = laneTone(row.lane, "selected"); ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.beginPath();
                for (let i = 0; i < pts.length; i++) { const p = pts[i]!; if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }
                ctx.stroke(); ctx.restore();
            }
        }
        for (const box of boxes) {
            const rec = row.records.find((r) => r.id === box.id)!;
            const tone = selected.has(box.id) ? "selected" : (hover?.kind === "body" || hover?.kind === "knot") && hover.id === box.id ? "hover" : "base";
            const color = laneTone(row.lane, tone);
            ctx.fillStyle = color; ctx.globalAlpha = tone === "base" ? .34 : .5;
            ctx.fillRect(box.x0, box.y0, box.x1 - box.x0, ROW_H); ctx.globalAlpha = 1;
            ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath();
            const entry = value?.entries[row.records.indexOf(rec)] ?? recordEntry(doc!.lanes, row.lane, rec);
            const pts = spanCurve(rec, entry, box, value?.chart ?? 4);
            for (let i = 0; i < pts.length; i++) { const p = pts[i]!; if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); }
            ctx.stroke();
        }
        // Hatch qualifies the body; handles and value knots are painted in the final pass above it.
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
        }
        if (value) for (const point of knotPoints(row, value.entries, value.chart, clamped, COLUMN_W)) {
            const rec = row.records.find((item) => item.id === point.id)!;
            const active = gesture?.kind === "value" && gesture.id === point.id && point.which === "exit";
            const hot = hover?.kind === "knot" && hover.id === point.id && hover.which === point.which;
            const tone = active || selected.has(point.id) ? "selected" : hot ? "hover" : "base";
            const owned = point.which === "exit" || rec.entry !== undefined;
            ctx.beginPath(); ctx.arc(point.x, point.y, active || hot ? 4 : 3, 0, Math.PI * 2);
            ctx.lineWidth = 1;
            ctx.strokeStyle = laneTone(row.lane, tone);
            if (owned) { ctx.fillStyle = laneTone(row.lane, tone); ctx.fill(); }
            ctx.stroke();
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
        ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ROWS_TOP + 3 * ROW_H + 4); ctx.stroke();
    }
}
$effect(() => {
    void tick; void revision; void clamped; void rows; void valueRows; void knots; void valueWindows; void hover; void onEnd; void selected; void driven; void playhead; void guide;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (ctx) { resize(canvas, ctx, dockW, chartH); render(ctx); }
});
$effect(() => {
    // An empty production boot still owns a live Track and must offer an addressable timeline
    // before the first segment exists. Frame the lead-out-only extent once; authored content then
    // follows the ordinary no-rescale clamp as it grows.
    if (!framed && chartW > 0 && eid !== null) {
        framed = true;
        view = frameAll(chartW, total, marginArc(total, 50));
    }
});
const gestureMessage = $derived.by(() => {
    void revision;
    const g = gesture;
    if (g?.kind === "add") return `${g.start.toFixed(2)}–${g.end.toFixed(2)} m · ${(g.end - g.start).toFixed(2)} m · ${status || "Valid"}`;
    if (g?.kind === "span" && g.moved && g.id !== undefined) { const r = recordOf(ecs, g.id)?.row; if (r) return `${r.start.toFixed(2)}–${r.end.toFixed(2)} m · ${(r.end - r.start).toFixed(2)} m${status ? ` · ${status}` : ""}`; }
    return status;
});
const statusPop = $derived.by(() => gestureAnchor && gestureMessage ? fitEditor(statusSize, { w: window.innerWidth, h: window.innerHeight }, player && tools ? [screenBox(player), screenBox(tools)] : [], gestureAnchor) : null);
const dragValueLabel = $derived.by(() => {
    void revision;
    const g = gesture;
    if (g?.kind !== "value" || !g.moved || g.id === undefined || g.lane === undefined || !canvas) return null;
    const info = valueRow(g.lane), found = recordOf(ecs, g.id);
    if (!info || !found) return null;
    const point = knotPoints(info.row, info.entries, info.chart, clamped, COLUMN_W).find((item) => item.id === g.id && item.which === "exit");
    if (!point) return null;
    const u = unit(g.lane), r = canvas.getBoundingClientRect();
    return { x: r.left + point.x, y: r.top + point.y, text: `${(found.row.exit * u.scale).toFixed(u.precision)} ${u.name}` };
});
</script>

<div class="tool-strip" bind:this={tools} role="group" aria-label="Timeline tools" style="bottom: {DOCK_INSET}px; height: {DOCK_HEIGHT}px; width: {TOOL_STRIP_W}px">
    <div class="tool-group" role="group" aria-label="Authoring tools">
        <button type="button" aria-label="Select ({BINDINGS.selectTool.hint})" aria-pressed={tool === "select"} disabled={busy} title="Select ({BINDINGS.selectTool.hint})" onclick={() => switchTool("select")}><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M3 1.5v12l3.3-3.3 2.4 4.3 2-1.1-2.4-4.2H13Z" /></svg></button>
        <button type="button" aria-label="Add Segment ({BINDINGS.addTool.hint})" aria-pressed={tool === "add"} disabled={busy} title="Add Segment ({BINDINGS.addTool.hint})" onclick={() => switchTool("add")}><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M2 4v8m0-4h7m0-4v8m3-10v6m-3-3h6" /></svg></button>
    </div>
    <div class="tool-group" role="group" aria-label="Snapping controls">
        <button type="button" aria-label="Snapping (S)" aria-pressed={snapping} disabled={busy} title="Snapping (S) · Ctrl/Cmd temporarily inverts" onclick={toggleSnapping}><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M4 2v6a4 4 0 0 0 8 0V2M6.5 2v6a1.5 1.5 0 0 0 3 0V2M2.5 2h11M2.5 14h11" /></svg></button>
    </div>
</div>
<div class="dock" bind:this={dock} style="bottom: {DOCK_INSET}px; height: {DOCK_HEIGHT}px; left: {DOCK_INSET + TOOL_STRIP_W + TOOL_GAP}px" tabindex="-1" role="group" aria-label="Timeline"
    onpointerenter={() => (editor.hover = "timeline")}
    onpointerleave={() => { editor.hover = "viewport"; hover = null; onEnd = false; }}>
    <canvas class="chart" bind:this={canvas} bind:clientWidth={dockW} bind:clientHeight={chartH} data-view={JSON.stringify(clamped)} data-rows={JSON.stringify(rows.map((r) => ({ lane: laneKey(r.lane), top: r.top, height: r.height, records: r.records.map(({ id, start, end }) => ({ id, start, end })) })))} data-value-windows={JSON.stringify(valueRows.map((item) => ({ lane: laneKey(item.row.lane), lo: item.chart.lo, hi: item.chart.hi, base: laneValueAxis(item.row.lane, velocityBase).base })))} style:cursor onpointerdown={chartDown} onpointermove={chartMove} oncontextmenu={chartMenu}></canvas>
    <div class="lane-column" aria-label="Lane priority and reorder">
        {#each rows as row (row.lane)}
            <div class="lane-label" role="img" data-lane={laneKey(row.lane)} data-priority={row.index + 1} aria-label="Priority {row.index + 1}: {row.name}; drag to reorder" title="Priority {row.index + 1}: {row.name} · Drag to reorder" style="top: {row.top}px; height: {row.height}px; color: {laneColor(row.lane)}">
                <span class="lane-name">{row.name}</span>
                <span class="lane-rank">P{row.index + 1}</span>
                <svg class="lane-grip" viewBox="0 0 12 16" aria-hidden="true"><circle cx="3" cy="4" r="1" /><circle cx="9" cy="4" r="1" /><circle cx="3" cy="8" r="1" /><circle cx="9" cy="8" r="1" /><circle cx="3" cy="12" r="1" /><circle cx="9" cy="12" r="1" /></svg>
            </div>
        {/each}
    </div>
</div>
{#if subject && focusKey !== null && pop}
    {#key `${subject.id}/${focusKey}`}
            <Popover x={pop.x} y={pop.y} record={subject.id} field={fields.find((f) => f.name === focusKey)!} focus={focusKey !== null} {focusRequest} notice={status}
                onmeasure={(w, h) => { if (panelSize.w !== w || panelSize.h !== h) panelSize = { w, h }; }}
                usable={(box) => editorFits(box, { w: window.innerWidth, h: window.innerHeight }, anchor ? [anchor, ...obstacles] : obstacles)}
                statusFit={(size, panel) => {
                    if (!anchor) return null;
                    const position = fitAttachedStatus(size, { w: window.innerWidth, h: window.innerHeight }, obstacles, panel, anchor);
                    if (!position) return null;
                    const box = { ...position, ...size };
                    return editorFits(box, { w: window.innerWidth, h: window.innerHeight }, [anchor, ...obstacles]) ? position : null;
                }}
                onpeel={peel} />
    {/key}
{/if}
{#if statusPop}<div class="gesture-status" role="status" bind:clientWidth={statusSize.w} bind:clientHeight={statusSize.h} style="left: {statusPop.x}px; top: {statusPop.y}px">{gestureMessage}</div>{/if}
{#if dragValueLabel}<div class="drag-value-label" aria-hidden="true" style="left: {dragValueLabel.x}px; top: {dragValueLabel.y}px">{dragValueLabel.text}</div>{/if}
{#if menu}<div class="menu-anchor menu" role="menu" use:fitMenu={{ x: menu.x, y: menu.y, above: menu.above }}><Menu items={menu.items} onclose={() => (menu = null)} /></div>{/if}
<div class="player" bind:this={player} role="group" aria-label="Playback" style="left: {playerCenter}px; bottom: {DOCK_INSET + DOCK_HEIGHT + PLAYER_GAP}px; height: {PLAYER_H}px">
    <button type="button" onclick={togglePlay} disabled={busy} aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause (Space)" : "Play (Space)"}>{playing ? "Ⅱ" : "▶"}</button>
    <div class="scrub" role="slider" tabindex="0" aria-label="Playback position" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={seconds} onpointerdown={sliderDown}>
        <div class="fill" style="width: {duration > 0 ? seconds / duration * 100 : 0}%"></div>
    </div>
    <span>{seconds.toFixed(2)} / {duration.toFixed(2)} s</span>
</div>
<style>
    .dock { position: absolute; right: 16px; background: var(--bg-solid); border: 1px solid var(--border); border-radius: 6px; box-shadow: var(--shadow); overflow: hidden; outline: none; }
    .chart { display: block; width: 100%; height: 100%; touch-action: none; }
    .tool-strip, .player { position: absolute; display: flex; align-items: center; gap: 6px; font: 11px "JetBrains Mono", monospace; color: var(--fg); }
    .tool-strip { left: 16px; z-index: 3; flex-direction: column; gap: 0; padding-top: 4px; background: var(--bg-solid); border-radius: 6px; }
    .tool-group { display: flex; flex-direction: column; align-items: center; gap: 2px; }
    .tool-group + .tool-group { margin-top: 8px; }
    .tool-strip button { width: 28px; height: 28px; padding: 6px; display: grid; place-items: center; color: var(--muted); background: transparent; border: 0; border-radius: 3px; }
    .tool-strip button:hover:not(:disabled) { color: var(--fg); background: transparent; }
    .tool-strip button[aria-pressed="true"] { color: var(--fg); background: var(--neutral-soft); border: 0; }
    .tool-strip button:focus-visible { outline: 1px solid var(--muted); outline-offset: 2px; }
    .tool-strip svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linejoin: round; }
    .player { transform: translateX(-50%); }
    button { font: inherit; color: inherit; background: var(--bg-solid); border: 1px solid var(--border); border-radius: 4px; padding: 5px 8px; cursor: pointer; }
    button:hover:not(:disabled) { color: var(--fg); background: var(--neutral-soft); }
    button:focus-visible { outline: 1px solid var(--muted); outline-offset: 2px; }
    button[aria-pressed="true"] { color: var(--fg); background: var(--neutral-soft); border-color: var(--muted); }
    button:disabled { opacity: .5; cursor: default; }
    .scrub { width: 160px; height: 6px; background: var(--border); cursor: pointer; touch-action: none; }
    .fill { height: 100%; background: var(--fg); pointer-events: none; }
    .lane-column { position: absolute; inset: 0 auto 0 0; width: 76px; z-index: 2; pointer-events: none; }
    .lane-label { position: absolute; left: 0; width: 100%; box-sizing: border-box; display: flex; align-items: center; gap: 4px; padding: 0 5px 0 10px; font: 10px "JetBrains Mono", monospace; }
    .lane-name { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lane-rank { color: var(--muted); font-size: 9px; }
    .lane-grip { width: 9px; height: 14px; flex: none; fill: var(--muted); }
    .gesture-status { position: fixed; z-index: 6; max-width: 310px; padding: 3px 5px; overflow-wrap: anywhere; font: 10px/14px "JetBrains Mono", monospace; color: var(--fg); background: var(--bg-solid); pointer-events: none; }
    .drag-value-label { position: fixed; z-index: 7; transform: translate(-50%, -100%); padding: 2px 4px; font: 10px "JetBrains Mono", monospace; color: var(--fg); background: var(--bg-solid); white-space: nowrap; pointer-events: none; }
    .menu-anchor { position: fixed; z-index: 8; }
</style>
