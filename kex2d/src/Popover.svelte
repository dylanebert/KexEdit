<script lang="ts">
import { onMount } from "svelte";
import type { FieldSpec, ScreenBox } from "./timeline";

/** One screen-held field; shared history and live bake belong to the caller. */
const { x, y, record, field, focusRequest, focus = false, onmeasure, usable, statusFit, onpeel, notice = "" }: {
    x: number; y: number; record: number; field: FieldSpec; focusRequest: number; focus?: boolean;
    onmeasure: (w: number, h: number) => void; usable: (box: ScreenBox) => boolean;
    statusFit: (size: { w: number; h: number }, panel: ScreenBox) => { x: number; y: number } | null;
    onpeel: () => void; notice?: string;
} = $props();
let panel: HTMLDivElement;
let statusEl: HTMLDivElement | undefined = $state(undefined);
let held: ScreenBox | null = $state(null);
let statusBox: ScreenBox | null = $state(null);
let edit: { field: FieldSpec; input?: HTMLInputElement; x0?: number; pointer?: number; label?: HTMLElement } | null = null;
let error = $state("");
let pending = $state(false);
let observer: ResizeObserver | null = null;
const print = (f: FieldSpec): string => Number.isFinite(f.value) ? f.value.toFixed(f.precision) : "";
const label = $derived(field.name === "exit" ? "Target" : field.name[0]!.toUpperCase() + field.name.slice(1));
const statusText = $derived(error || notice);
function finish(land = false): void {
    const g = edit;
    if (!g) return;
    edit = null;
    if (land && !error) g.field.commit(); else g.field.cancel();
    if (g.input && !land) {
        g.input.value = print(g.field);
        g.input.blur();
    }
    if (g.label && g.pointer !== undefined && g.label.hasPointerCapture(g.pointer)) g.label.releasePointerCapture(g.pointer);
    held = null;
    statusBox = null;
    error = "";
}
function cancelForLayout(): void {
    const reason = error;
    pending = false;
    finish();
    error = reason;
    onpeel();
}
function open(f: FieldSpec): boolean {
    if (f.readonly) return false;
    finish();
    error = "";
    if (f.begin() === false) return false;
    const r = panel.getBoundingClientRect();
    held = { x: r.left, y: r.top, w: r.width, h: r.height };
    return true;
}
function write(value: number): void {
    if (edit) error = Number.isFinite(value) ? (edit.field.write(value) ?? "") : "Enter a finite number";
}
function scrubMove(e: PointerEvent): void {
    if (edit?.x0 !== undefined && edit.pointer === e.pointerId) write(edit.field.value + (e.clientX - edit.x0) * edit.field.rate);
}
function scrubDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    if (!open(field)) return;
    const label = e.currentTarget as HTMLElement;
    edit = { field, x0: e.clientX, pointer: e.pointerId, label };
    label.setPointerCapture(e.pointerId);
}
function fieldFocus(e: FocusEvent): void {
    if (!open(field)) return;
    const input = e.currentTarget as HTMLInputElement;
    edit = { field, input };
    input.select();
}
function fieldInput(e: Event): void {
    const text = (e.currentTarget as HTMLInputElement).value.trim();
    write(text === "" ? NaN : Number(text));
}
function fieldKey(e: KeyboardEvent): void {
    if (e.key !== "Enter" && e.key !== "Escape") return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === "Enter") {
        const text = (e.currentTarget as HTMLInputElement).value.trim();
        if (!text || !Number.isFinite(Number(text))) write(NaN);
        if (error) return;
    }
    finish(e.key === "Enter");
    (e.currentTarget as HTMLInputElement).blur();
    onpeel();
}
function measure(): void {
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    const panelBox: ScreenBox = { x: r.left, y: r.top, w: r.width, h: r.height };
    if (held && !usable(panelBox)) cancelForLayout();
    if (statusText && statusEl) {
        const s = statusEl.getBoundingClientRect();
        const position = statusFit({ w: s.width, h: s.height }, panelBox);
        const next = position ? { ...position, w: s.width, h: s.height } : null;
        statusBox = next;
        if (held && (!next || !usable(next))) cancelForLayout();
    } else statusBox = null;
    onmeasure(r.width, r.height);
}
$effect(() => {
    void x; void y; void statusText; void statusFit; void usable;
    if (!panel) return;
    if (observer && statusEl) observer.observe(statusEl);
    measure();
});
$effect(() => { void focusRequest; pending = focus; });
$effect(() => {
    void x; void y;
    if (!panel || !pending) return;
    const r = panel.getBoundingClientRect();
    if (!usable({ x: r.left, y: r.top, w: r.width, h: r.height })) return;
    const input = panel.querySelector<HTMLInputElement>(".field input");
    if (input) { pending = false; input.focus(); }
});
onMount(() => {
    observer = new ResizeObserver(measure);
    observer.observe(panel);
    if (statusEl) observer.observe(statusEl);
    measure();
    const up = (e: PointerEvent): void => { if (edit?.pointer === e.pointerId) { finish(true); onpeel(); } };
    const abort = (): void => finish();
    const key = (e: KeyboardEvent): void => {
        if (edit?.x0 !== undefined && e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); finish(); }
    };
    window.addEventListener("pointermove", scrubMove);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", abort);
    window.addEventListener("blur", abort);
    window.addEventListener("resize", abort);
    window.addEventListener("keydown", key, true);
    return () => {
        const wasEditing = edit !== null;
        observer?.disconnect(); observer = null; finish();
        if (wasEditing) onpeel();
        window.removeEventListener("pointermove", scrubMove);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", abort);
        window.removeEventListener("blur", abort);
        window.removeEventListener("resize", abort);
        window.removeEventListener("keydown", key, true);
    };
});
</script>

<div class="popover-layer">
    <div bind:this={panel} data-record={record} class="popover" style="left: {held?.x ?? x}px; top: {held?.y ?? y}px;" role="group" aria-label="Selected segment">
        <div class="line">
            <div class="field">
                <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_click_events_have_key_events -->
                <label for="pf-{field.name}" title="Scrub {label.toLowerCase()} horizontally; click value to type" onpointerdown={scrubDown} onclick={(e) => e.preventDefault()}>{label}</label>
                <input id="pf-{field.name}" type="text" inputmode="decimal" value={print(field)} onfocus={fieldFocus} oninput={fieldInput} onkeydown={fieldKey} onblur={() => finish()} />
                <span class="unit">{field.unit}</span>
            </div>
        </div>
    </div>
    {#if statusText}
        <div bind:this={statusEl} role="status" class="status" style="left: {statusBox?.x ?? x}px; top: {statusBox?.y ?? y}px; visibility: {statusBox ? "visible" : "hidden"};">{statusText}</div>
    {/if}
</div>

<style>
    .popover-layer { position: fixed; inset: 0; z-index: 6; pointer-events: none; }
    .popover { position: fixed; padding: 3px 5px; background: var(--bg-solid); font: 11px "JetBrains Mono", ui-monospace, monospace; box-sizing: border-box; max-width: calc(100vw - 16px); user-select: none; -webkit-user-select: none; pointer-events: auto; }
    .line, .field { display: flex; align-items: center; gap: 6px; }
    .field { height: 24px; }
    .field label { color: var(--muted); cursor: ew-resize; }
    .field input { width: 70px; min-width: 0; padding: 2px 3px; font: inherit; font-variant-numeric: tabular-nums; color: var(--fg); background: transparent; border: 1px solid transparent; border-radius: 3px; }
    .field input:focus { outline: 1px solid var(--muted); background: var(--neutral-soft); }
    .unit { color: var(--muted); }
    .status { position: fixed; max-width: min(310px, calc(100vw - 16px)); box-sizing: border-box; padding: 3px 5px; font: 10px/14px "JetBrains Mono", ui-monospace, monospace; color: var(--danger, #f08080); background: var(--bg-solid); overflow-wrap: anywhere; pointer-events: none; }
</style>
