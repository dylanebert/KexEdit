<script lang="ts">
import type { State } from "@dylanebert/shallot";
import { onMount } from "svelte";
import { applyOp, flatRecordArgs, type LaneName } from "./commands";
import { cartArc, cartState, holdForGesture, parkAtArc, parkFromTime, releaseGesture } from "./cart";
import { COLOR_GUIDE_RAY, COLOR_HATCH, HATCH_GAP, laneTone } from "./colors";
import { editor, beginDrag, clearSelection, endDrag, selectRecord, toggleRecord } from "./editor";
import { beginBody, beginEdge, beginEnd, beginHandle, beginRecordEnd, cancel, commit, history, redo, removeRecord, setEase, setOrder, undo } from "./history";
import { Lane, RECORD_FLOOR } from "./lanes";
import { BINDINGS, bound, fitMenu } from "./menu";
import Menu from "./Menu.svelte";
import { EASING_GLYPHS, spanMenu } from "./menus";
import Popover from "./Popover.svelte";
import { nudgeAct, timelineKeyAct } from "./keys";
import type { Easing } from "./profile";
import { editorFits, type ScreenBox, fitAttachedStatus, fitEditor, recoveredAt, bakeStations, clampSpanDrag, COLUMN_W, clampView, drivenSpans, endHandle, type FieldSpec, frameAll, hitEndHandle, hitRows, laneRows, laneMembers, marginArc, nudgeQuantum, recordEntry, reorderDrop, reordered, type RowHit, ROW_H, S_GRID, snapAxis, spanBoxes, spanCurve, spanResidualDetail, spanTargets, ticks, uToPx, pxToU, type View, zoomAt } from "./timeline";
import { bakeOut, endColumn, lanesOf, laneOrderOf, recordOf, samples, setEnd, setRecordHandle, setRecordSpan, Track, trackEndOf, type LaneWrite } from "./track";
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
let feedbackAnchor: ScreenBox | null = $state(null);
let feedbackSize = $state({ w: 0, h: 0 });
let resultStation: number | null | undefined = $state(undefined);
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
let ripple = $state(false);
let rippleSubject: number | null = null;
let menu = $state<{ x: number; y: number; above: number; items: ReturnType<typeof spanMenu> } | null>(null);
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
function pick(id: number, box?: ScreenBox): void {
    selectRecord(id);
    if (rippleSubject !== id) { rippleSubject = id; ripple = false; }
    peeled = false;
    focusKey = null;
    resultStation = undefined;
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
        pick(g.id, { x: g.x, y: g.top + rows.find((r) => r.lane === g.lane)!.top, w: 0, h: ROW_H });
        focusKey = g.which === "body" ? null : g.which!;
        focusRequest++;
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
            pick(g.id!, { x: g.x, y: g.top + rows.find((r) => r.lane === g.lane)!.top, w: 0, h: ROW_H });
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
    if (px > COLUMN_W + chartW) return;
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
    feedbackAnchor = { x: e.clientX, y: rect.top + (g.lane === undefined ? py : rows.find((r) => r.lane === g.lane)!.top), w: 0, h: g.lane === undefined ? 0 : ROW_H };
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
    hover = onEnd || px > COLUMN_W + chartW ? null : hitRows(rows, clamped, px, py, COLUMN_W);
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
function peel(): void { focusKey = null; resultStation = undefined; }
function summon(key: "exit" | "entry" | "start" | "end", invoker: ScreenBox): void {
    menu = null;
    if (!subject) return;
    status = "";
    invocation = { id: subject.id, box: invoker, frame: screenBox(canvas) };
    resultStation = undefined;
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
            begin: () => { if (key === "end") updater = beginRecordEnd(ecs, p.id, ripple); else beginEdge(ecs, p.id); },
            write: (v) => message(updater ? updater(v) : setRecordSpan(ecs, p.id, v, p.row.end)),
            commit: () => commit(history), cancel,
        });
    };
    const out: FieldSpec[] = [];
    const entry = recordEntry(doc!.lanes, p.lane, p.row);
    out.push(handle("exit", p.row.exit), handle("entry", entry ?? NaN), stationField("start"), stationField("end"));
    return out;
});
const residual = $derived.by(() => {
    const p = subject;
    if (!p || eid === null || !driven.some((d) => d.id === p.id)) return null;
    const out = bakeOut.get(eid), sm = samples.get(eid), n = Track.count.get(eid);
    if (!out || !sm) return "Residual unavailable";
    const value = spanResidualDetail({ station: bakeStations(out.ds, n), value: p.lane === Lane.Force ? out.fN : sm.theta, n: p.lane === Lane.Force ? n - 1 : n }, p.row, recordEntry(doc!.lanes, p.lane, p.row));
    return value === undefined ? "Residual unavailable" : `≈ ${(value.value * unit(p.lane).scale).toFixed(unit(p.lane).precision)} ${unit(p.lane).name} recovered − demanded · worst sampled @ ${value.station.toFixed(2)} m`;
});
const entrySummary = $derived.by(() => {
    if (!subject || !doc) return "";
    const entry = recordEntry(doc.lanes, subject.lane, subject.row), u = unit(subject.lane);
    return entry === undefined ? "Unresolved entry · prescription unavailable" : `${subject.row.entry === undefined ? "Inherited" : "Owned"} start · ${(entry * u.scale).toFixed(u.precision)} ${u.name}`;
});
const result = $derived.by(() => {
    void tick;
    if (resultStation === undefined || !subject || !doc) return null;
    const p = subject, at = resultStation, u = unit(p.lane);
    const out = eid === null ? undefined : bakeOut.get(eid), sm = eid === null ? undefined : samples.get(eid);
    const count = eid === null ? 0 : Track.count.get(eid);
    const unavailable = at === null || at < p.row.start || at >= p.row.end || recordEntry(doc.lanes, p.lane, p.row) === undefined;
    const value = unavailable || !out || !sm ? undefined : recoveredAt({ station: bakeStations(out.ds, count), value: p.lane === Lane.Force ? out.fN : p.lane === Lane.Geo ? sm.theta : out.v, n: p.lane === Lane.Force ? count - 1 : count }, at!, p.lane === Lane.Force);
    return `Recovered ${value === undefined ? `unavailable ${u.name}` : `≈ ${(value * u.scale).toFixed(u.precision)} ${u.name}`} @ ${at === null ? "unavailable" : `${at.toFixed(2)} m`}${residual ? ` · ${residual}` : ""}`;
});
function changeEntry(): string {
    if (!subject || editor.dragging) return "An edit is already active";
    const result = applyOp(ecs, history, { type: "record-handle", id: subject.id, which: "entry" });
    status = result.refusals.map((r) => r.message).join("; ");
    if (!status && subject.lane === Lane.Velocity && recordEntry(lanesOf(ecs), subject.lane, recordOf(ecs, subject.id)!.row) === undefined) status = "Unresolved entry · prescription unavailable";
    return status;
}
function actions(invoker: ScreenBox, at: number | null): void {
    if (!subject || editor.dragging || gesture || !anchor) return;
    const id = subject.id;
    menu = { x: invoker.x, y: invoker.y + invoker.h + 8, above: invoker.y - 8, items: spanMenu({ ease: subject.row.ease as Easing, presetGlyph: (ease) => EASING_GLYPHS[ease], canDelete: true, entry: { owned: subject.row.entry !== undefined, summary: entrySummary } }, {
        field: (key) => summon(key, invoker),
        inherit: () => { menu = null; changeEntry(); },
        inspect: () => { menu = null; focusKey = null; resultStation = at; invocation = { id, box: invoker, frame: screenBox(canvas) }; },
        setEase: (ease) => { menu = null; report(setEase(history, ecs, id, ease)); },
        remove: () => { menu = null; report(removeRecord(history, ecs, id)); },
    }) };
}
function chartMenu(e: MouseEvent): void {
    e.preventDefault();
    if (editor.dragging || gesture) return;
    const r = canvas.getBoundingClientRect();
    if (e.clientX - r.left > COLUMN_W + chartW) return;
    const hit = hitRows(rows, clamped, e.clientX - r.left, e.clientY - r.top, COLUMN_W);
    menu = null;
    if (hit?.kind !== "body" && hit?.kind !== "edge") return;
    const found = recordOf(ecs, hit.id);
    if (!found) return;
    const invoker = { x: e.clientX, y: r.top + rows.find((row) => row.lane === hit.lane)!.top, w: 0, h: ROW_H };
    pick(hit.id, invoker);
    actions(invoker, pxToU(clamped, e.clientX - r.left - COLUMN_W));
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
            else if (focusKey !== null || resultStation !== undefined) peel();
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
            else if (act === "toggleSnap") snapping = !snapping;
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
        ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ROWS_TOP + 3 * ROW_H + 4); ctx.stroke();
    }
}
$effect(() => {
    void tick; void revision; void clamped; void rows; void hover; void onEnd; void selected; void driven; void playhead; void ripple; void guide;
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
const feedback = $derived.by(() => {
    void revision;
    const g = gesture;
    if (g?.kind === "add") return `${g.start.toFixed(2)}–${g.end.toFixed(2)} m · ${(g.end - g.start).toFixed(2)} m · ${status || "Valid"}`;
    if (g?.kind === "span" && g.moved && g.id !== undefined) { const r = recordOf(ecs, g.id)?.row; if (r) return `${r.start.toFixed(2)}–${r.end.toFixed(2)} m · ${(r.end - r.start).toFixed(2)} m${ripple && g.which !== "end" ? " · Independent" : ""}${status ? ` · ${status}` : ""}`; }
    return status;
});
const liveResult = $derived.by(() => { void revision; return gesture?.kind === "span" && gesture.moved ? feedback : result; });
const feedbackPop = $derived.by(() => feedbackAnchor && feedback && !subject ? fitEditor(feedbackSize, { w: window.innerWidth, h: window.innerHeight }, player && tools ? [screenBox(player), screenBox(tools)] : [], feedbackAnchor) : null);
</script>

<div class="tool-strip" bind:this={tools} role="group" aria-label="Timeline tools" style="bottom: {DOCK_INSET}px; height: {DOCK_HEIGHT}px; width: {TOOL_STRIP_W}px">
    <button type="button" aria-label="Select ({BINDINGS.selectTool.hint})" aria-pressed={tool === "select"} disabled={busy} title="Select ({BINDINGS.selectTool.hint})" onclick={() => switchTool("select")}><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M3 1.5v12l3.3-3.3 2.4 4.3 2-1.1-2.4-4.2H13Z" /></svg></button>
    <button type="button" aria-label="Add Segment ({BINDINGS.addTool.hint})" aria-pressed={tool === "add"} disabled={busy} title="Add Segment ({BINDINGS.addTool.hint})" onclick={() => switchTool("add")}><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M2 4v8m0-4h7m0-4v8m3-10v6m-3-3h6" /></svg></button>
</div>
<div class="dock" bind:this={dock} style="bottom: {DOCK_INSET}px; height: {DOCK_HEIGHT}px; left: {DOCK_INSET + TOOL_STRIP_W + TOOL_GAP}px" tabindex="-1" role="group" aria-label="Timeline"
    onpointerenter={() => (editor.hover = "timeline")}
    onpointerleave={() => { editor.hover = "viewport"; hover = null; onEnd = false; }}>
    <canvas class="chart" bind:this={canvas} bind:clientWidth={dockW} bind:clientHeight={chartH} data-view={JSON.stringify(clamped)} data-rows={JSON.stringify(rows.map((r) => ({ lane: laneKey(r.lane), top: r.top, height: r.height, records: r.records.map(({ id, start, end }) => ({ id, start, end })) })))} style:cursor onpointerdown={chartDown} onpointermove={chartMove} oncontextmenu={chartMenu}></canvas>
</div>
{#if subject && pop}
    {#key `${subject.id}/${focusKey ?? "exit"}/${resultStation === undefined ? "field" : "result"}`}
            <Popover x={pop.x} y={pop.y} record={subject.id} field={fields.find((f) => f.name === (focusKey ?? "exit"))!} focus={focusKey !== null} {focusRequest} {ripple} {busy} result={liveResult} notice={liveResult === feedback ? "" : status}
                onmeasure={(w, h) => { if (panelSize.w !== w || panelSize.h !== h) panelSize = { w, h }; }}
                usable={(box) => editorFits(box, { w: window.innerWidth, h: window.innerHeight }, anchor ? [anchor, ...obstacles] : obstacles)}
                statusFit={(size, panel) => {
                    if (!anchor) return null;
                    const position = fitAttachedStatus(size, { w: window.innerWidth, h: window.innerHeight }, obstacles, panel, anchor);
                    if (!position) return null;
                    const box = { ...position, ...size };
                    return editorFits(box, { w: window.innerWidth, h: window.innerHeight }, [anchor, ...obstacles]) ? position : null;
                }}
                onactions={(button) => actions(screenBox(button), playhead)}
                onripple={(v) => { if (!editor.dragging) ripple = v; }} onpeel={peel} />
    {/key}
{/if}
{#if feedbackPop}<div class="feedback" role="status" bind:clientWidth={feedbackSize.w} bind:clientHeight={feedbackSize.h} style="left: {feedbackPop.x}px; top: {feedbackPop.y}px">{feedback}</div>{/if}
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
    .tool-strip { left: 16px; z-index: 3; flex-direction: column; padding-top: 4px; background: var(--bg-solid); border-radius: 6px; }
    .tool-strip button { width: 28px; height: 28px; padding: 6px; display: grid; place-items: center; }
    .tool-strip svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linejoin: round; }
    button:hover:not(:disabled) { color: var(--fg); background: var(--neutral-soft); }
    button:focus-visible { outline: 1px solid var(--muted); outline-offset: 2px; }
    .player { transform: translateX(-50%); }
    button { font: inherit; color: inherit; background: var(--bg-solid); border: 1px solid var(--border); border-radius: 4px; padding: 5px 8px; cursor: pointer; }
    button[aria-pressed="true"] { color: var(--fg); background: var(--neutral-soft); border-color: var(--muted); }
    button:disabled { opacity: .5; cursor: default; }
    .scrub { width: 160px; height: 6px; background: var(--border); cursor: pointer; touch-action: none; }
    .fill { height: 100%; background: var(--fg); pointer-events: none; }
    .feedback { position: fixed; z-index: 6; max-width: 310px; padding: 3px 5px; overflow-wrap: anywhere; font: 10px/14px "JetBrains Mono", monospace; color: var(--fg); background: var(--bg-solid); pointer-events: none; }
    .menu-anchor { position: fixed; z-index: 8; }
</style>
