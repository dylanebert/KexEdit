<script lang="ts">
import { onMount } from "svelte";
import { Easing } from "./profile";
import type { FieldSpec } from "./timeline";

/** The contextual value editor for one selected span (spec `kex2d-segment-gestures` S3c, the
 *  person's check-in two point 13: "a pop-up contextual UI could perhaps be most modern and
 *  inline with the philosophy"). It is the value editor — there is no docked property panel —
 *  and it is summoned by the SELECTION rather than by a second click, so picking a span is
 *  already asking to read its numbers.
 *
 *  Presentational only: every field is a `FieldSpec` the caller built over `history.ts` gestures
 *  (`beginHandle`/`beginEdge` + the setter + `commit`), so this component holds no ECS, no
 *  history and no lane knowledge — it draws the field law and reports presses. The caller owns
 *  placement too (`timeline.popoverFit`), which is what makes the flip and the clamp a headless
 *  arm rather than something only a screenshot can see.
 *
 *  The field law is root `ui.md`'s: key / value / unit, an `ew-resize` label that scrubs at a
 *  fixed rate, select-all on focus, Enter commits, Escape reverts, and ONE undo entry per commit
 *  (the gesture the caller opened coalesces the scrub's live writes). No spinner. */

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
    ripple = false,
    onripple,
    busy = false,
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
    ripple?: boolean;
    onripple?: (value: boolean) => void;
    busy?: boolean;
} = $props();

const EASINGS: [string, Easing][] = [
    ["Linear", Easing.Linear],
    ["Cubic", Easing.Cubic],
    ["Quintic", Easing.Quintic],
];

const print = (f: FieldSpec): string => f.value.toFixed(f.precision);

// Hold the opening FieldSpec and screen position, not the tick-rebuilt closures.
let panel: HTMLDivElement;
let held: { x: number; y: number } | null = $state(null);
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
    error = "";
}
function open(f: FieldSpec): boolean {
    if (f.readonly) return false;
    finish();
    if (f.begin() === false) return false;
    held = { x, y };
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
    if (focusKey && panel) panel.querySelector<HTMLInputElement>(`#pf-${focusKey}`)?.focus();
});
onMount(() => {
    const up = (e: PointerEvent): void => {
        if (edit?.pointer === e.pointerId) finish(true);
    };
    const abort = (): void => finish();
    const key = (e: KeyboardEvent): void => {
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
    {#each fields as f (f.key)}
        <div class="field" class:ro={f.readonly}>
            <!-- Keyboard editing uses the associated input; prevent a scrub's synthetic click from opening a second edit. -->
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions a11y_click_events_have_key_events -->
            <label for="pf-{f.key}" onpointerdown={(e) => scrubDown(e, f)} onclick={(e) => e.preventDefault()}>{f.key}</label>
            <input
                id="pf-{f.key}"
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
    {#if onripple}
        <label class="ripple"><input type="checkbox" checked={ripple} disabled={busy} onchange={(e) => onripple(e.currentTarget.checked)} />Ripple later segments in this lane</label>
        <div class="scope">End resize only; other lanes stay at their stations</div>
    {/if}
    {#if error}<div role="status" class="error">{error}</div>{/if}
    <div class="field ease">
        <span class="key">easing</span>
        <div class="picks">
            {#each EASINGS as [label, value] (value)}
                <button
                    type="button"
                    class:on={ease === value}
                    disabled={busy}
                    onclick={() => onease(value)}
                    aria-pressed={ease === value}>{label}</button
                >
            {/each}
        </div>
    </div>
    {#if residual !== null}
        <!-- the driven readout (`editor-ui.md`: show demand/achieved residual; a driven record
             measures only), so the hatch on the row has a number behind it. -->
        <div class="residual">driven · {residual}</div>
    {/if}
</div>

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
    .error { color: var(--danger, #f08080); }
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
    .field label,
    .field .key {
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

    .ease .picks {
        flex: 1;
        display: flex;
        gap: 2px;
    }
    .ease button {
        all: unset;
        flex: 1;
        padding: 2px 0;
        text-align: center;
        border-radius: 3px;
        font-size: 10px;
        color: var(--muted);
        background: rgba(255, 255, 255, 0.05);
        cursor: pointer;
    }
    .ease button:hover {
        color: var(--fg);
    }
    .ease button.on {
        background: var(--accent-soft);
        color: var(--fg);
    }

    .residual {
        padding: 4px 4px 1px;
        font-family: "JetBrains Mono", ui-monospace, monospace;
        font-size: 10px;
        color: var(--muted);
    }
</style>
