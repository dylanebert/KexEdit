<script lang="ts">
import { onMount } from "svelte";
import type { Easing } from "./profile";
import { EASINGS, EASING_GLYPHS, spanMenu } from "./menus";
import Menu from "./Menu.svelte";
import { fitMenu } from "./menu";
import type { FieldSpec, ScreenBox } from "./timeline";

/** Presentational field lifecycle: hold the press value/rate and measured screen box while
 * authored writes and the bake remain live. The caller supplies shared history gestures. */

const {
    x,
    y,
    title,
    fields,
    ease,
    onease,
    residual,
    onpeel,
    focusKey = null,
    focusRequest = 0,
    ripple = false,
    onripple,
    busy = false,
    onmeasure,
    usable,
    entrySummary,
    owned,
    onentry,
}: {
    x: number;
    y: number;
    title: string;
    fields: FieldSpec[];
    ease: Easing;
    onease: (e: Easing) => void;
    /** the driven residual, already formatted, or null where the record drives its own stretch. */
    residual: string | null;
    onpeel: () => void;
    focusKey?: string | null;
    focusRequest?: number;
    ripple?: boolean;
    onripple?: (value: boolean) => void;
    busy?: boolean;
    onmeasure: (w: number, h: number) => void;
    usable: (box: ScreenBox) => boolean;
    entrySummary: string;
    owned: boolean;
    onentry: () => string;
} = $props();

let disclosed = $state(false);
let overriding = $state(false);
let pendingFocus: string | null = $state(null);
let easingMenu: { x: number; y: number } | null = $state(null);
const currentEase = $derived(EASINGS.find(([, value]) => value === ease)?.[0] ?? "Unknown");
const visibleFields = $derived(fields.filter((f) => f.name === "exit" || (f.name === "entry" ? disclosed && (owned || overriding) : disclosed || focusKey === f.name)));


const print = (f: FieldSpec): string => Number.isFinite(f.value) ? f.value.toFixed(f.precision) : "";

// Hold the opening FieldSpec and screen position, not the tick-rebuilt closures.
let panel: HTMLDivElement;
let held: { x: number; y: number; w: number; h: number } | null = $state(null);
let edit: { field: FieldSpec; input?: HTMLInputElement; x0?: number; pointer?: number; label?: HTMLElement } | null = null;
let error = $state("");
function finish(land = false): void {
    const g = edit;
    if (!g) return;
    edit = null; // blur/release cannot finish twice
    if (land && !error) g.field.commit();
    else g.field.cancel();
    if (g.input && !land) g.input.value = print(g.field);
    if (g.label && g.pointer !== undefined && g.label.hasPointerCapture(g.pointer))
        g.label.releasePointerCapture(g.pointer);
    held = null;
    if (g.field.name === "entry") overriding = false;
    error = "";
}
function open(f: FieldSpec): boolean {
    if (f.readonly) return false;
    finish();
    if (f.begin() === false) return false;
    const rect = panel.getBoundingClientRect();
    held = { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
    return true;
}
function write(value: number): void {
    if (!edit) return;
    error = Number.isFinite(value) ? (edit.field.write(value) ?? "") : "Enter a finite number";
}
function scrubMove(e: PointerEvent): void {
    if (!edit || edit.x0 === undefined || edit.pointer !== e.pointerId) return;
    write(edit.field.value + (e.clientX - edit.x0) * edit.field.rate);
}
function scrubDown(e: PointerEvent, f: FieldSpec): void {
    if (e.button !== 0) return;
    e.preventDefault();
    if (!open(f)) return;
    const label = e.currentTarget as HTMLElement;
    edit = { field: f, x0: e.clientX, pointer: e.pointerId, label };
    label.setPointerCapture(e.pointerId);
}
function fieldFocus(e: FocusEvent, f: FieldSpec): void {
    if (!open(f)) return;
    const input = e.currentTarget as HTMLInputElement;
    edit = { field: f, input };
    input.select();
}
function fieldInput(e: Event): void {
    const text = (e.currentTarget as HTMLInputElement).value.trim();
    write(text === "" ? NaN : Number(text));
}
function fieldKey(e: KeyboardEvent): void {
    if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        const input = e.currentTarget as HTMLInputElement;
        finish(e.key === "Enter");
        input.blur();
    }
}
function fieldBlur(): void { finish(); }
$effect(() => {
    void x; void y;
    if (held && !usable(held)) finish();
});
$effect(() => { void focusRequest; pendingFocus = focusKey; });
$effect(() => {
    void x; void y;
    if (!panel || !pendingFocus) return;
    const rect = panel.getBoundingClientRect();
    if (!usable({ x: rect.left, y: rect.top, w: rect.width, h: rect.height })) return;
    const input = panel.querySelector<HTMLInputElement>(`#pf-${pendingFocus}`);
    if (input) { pendingFocus = null; input.focus(); }
});
onMount(() => {
    const measure = (): void => {
        const rect = panel.getBoundingClientRect();
        if (held && !usable({ x: rect.left, y: rect.top, w: rect.width, h: rect.height })) finish();
        onmeasure(rect.width, rect.height);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    measure();
    const dismiss = (e: PointerEvent): void => {
        if (!(e.target as HTMLElement).closest(".ease-menu, .ease-control")) easingMenu = null;
    };
    window.addEventListener("pointerdown", dismiss);
    const up = (e: PointerEvent): void => {
        if (edit?.pointer === e.pointerId) finish(true);
    };
    const abort = (): void => finish();
    const key = (e: KeyboardEvent): void => {
        if (e.key === "Escape" && !edit && (easingMenu || overriding || disclosed)) {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (easingMenu) easingMenu = null;
            else if (overriding) overriding = false;
            else disclosed = false;
            return;
        }
        if (easingMenu) { e.stopImmediatePropagation(); return; }
        if (edit?.x0 !== undefined && e.key === "Escape") {
            e.preventDefault();
            e.stopImmediatePropagation();
            finish();
        }
    };
    window.addEventListener("pointermove", scrubMove);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", abort);
    window.addEventListener("blur", abort);
    window.addEventListener("resize", abort);
    window.addEventListener("keydown", key, true);
    return () => {
        observer.disconnect();
        window.removeEventListener("pointerdown", dismiss);
        finish();
        window.removeEventListener("pointermove", scrubMove);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", abort);
        window.removeEventListener("blur", abort);
        window.removeEventListener("resize", abort);
        window.removeEventListener("keydown", key, true);
    };
});
</script>

<!-- opaque, flipped and clamped by the caller; it never covers its own span's handles because the
     fit opens it a gap BELOW the band (or above, flipped). -->
<div bind:this={panel} class="popover" style="left: {held?.x ?? x}px; top: {held?.y ?? y}px;" role="group" aria-label="{title} segment">
    <div class="head">
        <span class="quantity">{title}</span>
        <button class="peel" type="button" onclick={onpeel} aria-label="Dismiss">×</button>
    </div>
    {#each visibleFields as f (f.name)}
        <div class="field" class:ro={f.readonly}>
            <!-- Keyboard editing uses the associated input; prevent a scrub's synthetic click from opening a second edit. -->
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_click_events_have_key_events -->
            <label for="pf-{f.name}" onpointerdown={(e) => scrubDown(e, f)} onclick={(e) => e.preventDefault()}>{f.name === "exit" ? "Target" : f.name}</label>
            <input
                id="pf-{f.name}"
                type="text"
                inputmode="decimal"
                readonly={f.readonly}
                value={print(f)}
                onfocus={(e) => fieldFocus(e, f)}
                oninput={fieldInput}
                onkeydown={fieldKey}
                onblur={fieldBlur}
            />
            <span class="unit">{f.unit}</span>
        </div>
    {/each}
    <button class="ease-control" type="button" disabled={busy} title="Change easing" onclick={(e) => { const r = e.currentTarget.getBoundingClientRect(); easingMenu = easingMenu ? null : { x: r.left, y: r.bottom + 8 }; }} aria-expanded={easingMenu !== null}>
        <svg viewBox="0 0 22 16" aria-hidden="true"><path d={EASING_GLYPHS[ease]} /></svg>Easing · {currentEase} ▾
    </button>
    <div class="scope">{entrySummary}</div>
    <button class="disclosure" type="button" disabled={busy} aria-expanded={disclosed} onclick={() => disclosed = !disclosed}>{disclosed ? "▾" : "▸"} Entry, range & diagnostics</button>
    {#if disclosed}
        <div class="entry-actions">
            {#if owned}<button type="button" disabled={busy} onclick={() => error = onentry()}>Inherit entry</button>
            {:else}<button type="button" disabled={busy} onclick={() => { overriding = !overriding; pendingFocus = overriding ? "entry" : null; }}>Override entry</button>{/if}
        </div>
    {/if}
    {#if onripple && (disclosed || focusKey === "end")} 
        <label class="ripple"><input type="checkbox" checked={ripple} disabled={busy} onchange={(e) => onripple(e.currentTarget.checked)} />Ripple later segments in this lane</label>
        <div class="scope">End resize only; other lanes stay at their stations</div>
    {/if}
    <div role={error ? "status" : undefined} class="error">{error}</div>
    {#if disclosed && residual !== null}
        <!-- the driven readout (`editor-ui.md`: show demand/achieved residual; a driven record
             measures only), so the hatch on the row has a number behind it. -->
        <div class="residual">driven · {residual}</div>
    {/if}
</div>
{#if easingMenu}
    <div class="ease-menu menu" role="menu" use:fitMenu={easingMenu}>
        <Menu items={spanMenu({ ease, presetGlyph: (value) => EASING_GLYPHS[value], canDelete: false }, { setEase: onease, remove: () => {} })[0]!.children!} onclose={() => easingMenu = null} />
    </div>
{/if}

<style>
    .popover {
        position: fixed;
        z-index: 6;
        min-width: 168px;
        padding: 6px;
        background: var(--bg-solid);
        border: 1px solid var(--border);
        border-radius: 6px;
        box-shadow: var(--shadow);
        font-family: "JetBrains Mono", ui-monospace, monospace;
        width: 270px;
        box-sizing: border-box;
        user-select: none;
        -webkit-user-select: none;
    }
    .ripple { display: flex; align-items: center; font-size: 10px; gap: 4px; }
    .scope, .error { font-size: 10px; padding: 4px; color: var(--muted); }
    .error { color: var(--danger, #f08080); min-height: 12px; }
    .head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 1px 4px 5px;
    }
    .quantity {
        font-size: 11px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--muted);
    }
    .peel {
        all: unset;
        width: 14px;
        height: 14px;
        line-height: 12px;
        text-align: center;
        border-radius: 3px;
        color: var(--muted);
        cursor: pointer;
    }
    .peel:hover {
        background: var(--neutral-soft);
        color: var(--fg);
    }

    .field {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 1px 4px;
        height: 22px;
    }
    .field label {
        flex: none;
        width: 42px;
        font-size: 11px;
        color: var(--muted);
    }
    .field label {
        cursor: ew-resize;
    }
    .field input {
        flex: 1;
        min-width: 0;
        box-sizing: border-box;
        padding: 2px 5px;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid transparent;
        border-radius: 3px;
        font-family: "JetBrains Mono", ui-monospace, monospace;
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        color: var(--fg);
    }
    .field input:focus {
        outline: none;
        border-color: var(--accent);
        background: rgba(255, 255, 255, 0.08);
    }
    .field.ro input {
        color: var(--muted);
        cursor: default;
    }
    .field .unit {
        flex: none;
        width: 24px;
        font-family: "JetBrains Mono", ui-monospace, monospace;
        font-size: 10px;
        color: var(--muted);
    }

    .ease-control { display: flex; align-items: center; gap: 6px; width: 100%; }
    .ease-control svg { width: 22px; height: 16px; fill: none; stroke: currentColor; }
    .ease-menu { position: fixed; z-index: 9; }
    .disclosure, .ease-control, .entry-actions button { font: 11px "JetBrains Mono", monospace; color: var(--fg); background: var(--bg-solid); border: 1px solid var(--border); border-radius: 3px; padding: 4px; cursor: pointer; }
    .entry-actions { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px; }

    .residual {
        padding: 4px 4px 1px;
        font-family: "JetBrains Mono", ui-monospace, monospace;
        font-size: 10px;
        color: var(--muted);
    }
</style>
