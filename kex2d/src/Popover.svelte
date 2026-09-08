<script lang="ts">
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
} = $props();

const EASINGS: [string, Easing][] = [
    ["Linear", Easing.Linear],
    ["Cubic", Easing.Cubic],
    ["Quintic", Easing.Quintic],
];

const print = (f: FieldSpec): string => f.value.toFixed(f.precision);

// ── the label scrub: press the key, drag horizontally, release. One gesture, one undo entry.
let scrub: { field: FieldSpec; x0: number; v0: number } | null = null;
function scrubMove(e: PointerEvent): void {
    const s = scrub;
    if (!s) return;
    s.field.write(s.v0 + (e.clientX - s.x0) * s.field.rate);
}
function scrubUp(): void {
    if (!scrub) return;
    scrub.field.commit();
    scrub = null;
    window.removeEventListener("pointermove", scrubMove);
    window.removeEventListener("pointerup", scrubUp);
    window.removeEventListener("pointercancel", scrubUp);
}
function scrubDown(e: PointerEvent, f: FieldSpec): void {
    if (f.readonly) return;
    e.preventDefault();
    f.begin();
    scrub = { field: f, x0: e.clientX, v0: f.value };
    window.addEventListener("pointermove", scrubMove);
    window.addEventListener("pointerup", scrubUp);
    window.addEventListener("pointercancel", scrubUp);
}

// ── the typed edit: focus opens the gesture and selects all, Enter commits, Escape reverts.
// Escape stops here rather than reaching the timeline's own ladder — dismissal peels ONE layer
// (`ui.md`), and the innermost layer under a focused field is the field's own edit.
function fieldFocus(e: FocusEvent, f: FieldSpec): void {
    if (f.readonly) return;
    f.begin();
    (e.currentTarget as HTMLInputElement).select();
}
function fieldInput(e: Event, f: FieldSpec): void {
    const v = Number((e.currentTarget as HTMLInputElement).value);
    if (Number.isFinite(v)) f.write(v);
}
function fieldKey(e: KeyboardEvent, f: FieldSpec): void {
    if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        f.commit();
        (e.currentTarget as HTMLInputElement).blur();
        return;
    }
    if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        f.cancel();
        (e.currentTarget as HTMLInputElement).blur();
    }
}
function fieldBlur(f: FieldSpec): void {
    if (!f.readonly) f.commit();
}
</script>

<!-- opaque, flipped and clamped by the caller; it never covers its own span's handles because the
     fit opens it a gap BELOW the band (or above, flipped). -->
<div class="popover" style="left: {x}px; top: {y}px;" role="group" aria-label="{title} segment">
    <div class="head">
        <span class="quantity">{title}</span>
        <button class="peel" type="button" onclick={onpeel} aria-label="Dismiss">×</button>
    </div>
    {#each fields as f (f.key)}
        <div class="field" class:ro={f.readonly}>
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <label for="pf-{f.key}" onpointerdown={(e) => scrubDown(e, f)}>{f.key}</label>
            <input
                id="pf-{f.key}"
                type="text"
                inputmode="decimal"
                readonly={f.readonly}
                value={print(f)}
                onfocus={(e) => fieldFocus(e, f)}
                oninput={(e) => fieldInput(e, f)}
                onkeydown={(e) => fieldKey(e, f)}
                onblur={() => fieldBlur(f)}
            />
            <span class="unit">{f.unit}</span>
        </div>
    {/each}
    <div class="field ease">
        <span class="key">easing</span>
        <div class="picks">
            {#each EASINGS as [label, value] (value)}
                <button
                    type="button"
                    class:on={ease === value}
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
        position: absolute;
        z-index: 6;
        min-width: 168px;
        padding: 6px;
        background: var(--bg-solid);
        border: 1px solid var(--border);
        border-radius: 6px;
        box-shadow: var(--shadow);
        font-family: "Outfit", system-ui, sans-serif;
        user-select: none;
        -webkit-user-select: none;
    }
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
