<script lang="ts">
    import { onDestroy } from "svelte";
    let { orientation, value, min, max, label, controls, onresize, ondrag } = $props<{
        orientation: "vertical" | "horizontal";
        value: number; min: number; max: number; label: string; controls: string;
        onresize: (value: number) => void; ondrag: (active: boolean) => void;
    }>();
    let element: HTMLDivElement;
    let drag = $state<{ id: number; start: number; value: number } | null>(null);
    const coordinate = (event: PointerEvent) => orientation === "vertical" ? event.clientX : event.clientY;
    function finish(event?: PointerEvent) {
        if (!drag || (event && event.pointerId !== drag.id)) return;
        const id = drag.id;
        drag = null;
        ondrag(false);
        if (element.hasPointerCapture(id)) element.releasePointerCapture(id);
    }
    function down(event: PointerEvent) {
        if (event.button !== 0 || drag) return;
        event.preventDefault();
        element.focus({ preventScroll: true });
        element.setPointerCapture(event.pointerId);
        drag = { id: event.pointerId, start: coordinate(event), value };
        ondrag(true);
    }
    function move(event: PointerEvent) {
        if (!drag || drag.id !== event.pointerId) return;
        onresize(drag.value + (coordinate(event) - drag.start) * (orientation === "vertical" ? 1 : -1));
    }
    function key(event: KeyboardEvent) {
        const direction = orientation === "vertical"
            ? { ArrowLeft: -1, ArrowRight: 1 } : { ArrowDown: -1, ArrowUp: 1 };
        const delta = direction[event.key as keyof typeof direction];
        if (delta === undefined && event.key !== "Home" && event.key !== "End") return;
        event.preventDefault();
        event.stopPropagation();
        onresize(event.key === "Home" ? min : event.key === "End" ? max : value + delta! * (event.shiftKey ? 40 : 10));
    }
    onDestroy(() => finish());
</script>

<svelte:window onblur={() => finish()} />
<!-- Focusable separators implement the APG Window Splitter keyboard pattern. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div bind:this={element} class="splitter splitter-{orientation}" class:dragging={drag !== null}
    role="separator" tabindex="0" aria-label={label} aria-controls={controls}
    aria-orientation={orientation} aria-valuemin={Math.round(min)} aria-valuemax={Math.round(max)}
    aria-valuenow={Math.round(value)} aria-valuetext={`${Math.round(value)} pixels`}
    onpointerdown={down} onpointermove={move} onpointerup={finish}
    onpointercancel={finish} onlostpointercapture={finish} onkeydown={key}
></div>
