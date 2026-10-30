<script lang="ts">
    import type { CapabilityOutcome } from "./capability";
    import { onMount, setContext } from "svelte";
    import Splitter from "./Splitter.svelte";
    import { createTransport, TRANSPORT_CONTEXT } from "./transport";
    setContext(TRANSPORT_CONTEXT, createTransport());
    import Panel from "./Panel.svelte";
    import Status from "./Status.svelte";
    import Timeline from "./Timeline.svelte";
    import View from "./View.svelte";

    let shell: HTMLElement;
    let width = $state(1280);
    let height = $state(800);
    let contextWidth = $state(256);
    let timelineHeight = $state(192);
    let dragging = $state<"vertical" | "horizontal" | null>(null);
    const contextMax = $derived(Math.max(192, Math.min(480, width - 400)));
    const timelineMax = $derived(Math.max(160, height - 272));
    const resizeContext = (value: number) => contextWidth = Math.min(contextMax, Math.max(192, value));
    const resizeTimeline = (value: number) => timelineHeight = Math.min(timelineMax, Math.max(160, value));
    onMount(() => {
        const textContent = (target: EventTarget | null) => target instanceof HTMLElement &&
            (target.isContentEditable || target.matches('textarea:not(:disabled), input:not(:disabled):is(:not([type]), [type="text"], [type="search"], [type="email"], [type="url"], [type="tel"], [type="password"], [type="number"])'));
        const preventFocus = (event: PointerEvent) => {
            if (event.target instanceof Element && !textContent(event.target) &&
                event.target.closest('button, input, select, [tabindex], canvas')) {
                event.preventDefault();
                if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
            }
        };
        const releaseFocus = (event: FocusEvent) => {
            if (event.target instanceof HTMLElement && !textContent(event.target)) event.target.blur();
        };
        shell.addEventListener('pointerdown', preventFocus, true);
        shell.addEventListener('focusin', releaseFocus);
        const observer = new ResizeObserver(([entry]) => {
            width = entry!.contentRect.width;
            height = entry!.contentRect.height;
            resizeContext(contextWidth);
            resizeTimeline(timelineHeight);
        });
        observer.observe(shell);
        return () => {
            observer.disconnect();
            shell.removeEventListener('pointerdown', preventFocus, true);
            shell.removeEventListener('focusin', releaseFocus);
        };
    });

    let shellReady = $state(false);
    let entranceArmed = $state(false);
    let capability = $state<CapabilityOutcome | null>(null);

    // Reveal the layout first. The first RAF records a visible, splash-free frame; the second
    // RAF arms the compositor entrance after that frame has painted.
    $effect(() => {
        if (!shellReady) return;
        let cleanupArm = () => {};
        const visibleFrame = requestAnimationFrame(() => {
            const armFrame = requestAnimationFrame(() => {
                entranceArmed = true;
            });
            cleanupArm = () => cancelAnimationFrame(armFrame);
        });
        return () => {
            cancelAnimationFrame(visibleFrame);
            cleanupArm();
        };
    });
</script>

<svelte:head>
    <meta name="theme-color" content="#1d2021" />
</svelte:head>

<main
    bind:this={shell}
    style={`--shell-context-width: ${contextWidth}px; --shell-timeline-height: ${timelineHeight}px`}
    data-resizing={dragging}
    class={`shell${shellReady ? "" : " shell-booting"}${entranceArmed ? " shell-entrance-armed" : ""}`}
    data-region="shell"
    data-shell-ready={shellReady}
    data-capability={capability?.status ?? "checking"}
    aria-hidden={!shellReady}
>
    <Panel title="Context" region="context">
        <div></div>
    </Panel>
    <Panel title="View" region="view">
        <View
            onCapability={(outcome) => (capability = outcome)}
            onReady={() => (shellReady = true)}
        />
    </Panel>
    <Panel title="Timeline" region="timeline">
        <Timeline />
    </Panel>
    <Splitter orientation="vertical" value={contextWidth} min={192} max={contextMax}
        label="Context width" controls="pane-context" onresize={resizeContext}
        ondrag={(active) => dragging = active ? "vertical" : null} />
    <Splitter orientation="horizontal" value={timelineHeight} min={160} max={timelineMax}
        label="Timeline height" controls="pane-timeline" onresize={resizeTimeline}
        ondrag={(active) => dragging = active ? "horizontal" : null} />
    <Status />
</main>

{#if capability?.status === "block"}
    <div class="startup-capability" data-region="capability-block" role="alert" aria-live="assertive">
        <div class="startup-capability-card">
            <p class="startup-capability-kicker">KexEdit cannot start</p>
            <h1>WebGPU is required</h1>
            <p>{capability.reason}</p>
        </div>
    </div>
{/if}
