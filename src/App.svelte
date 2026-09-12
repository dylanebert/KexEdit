<script lang="ts">
    import type { CapabilityOutcome } from "./capability";
    import Panel from "./Panel.svelte";
    import Status from "./Status.svelte";
    import Timeline from "./Timeline.svelte";
    import View from "./View.svelte";

    let shellReady = $state(false);
    let entranceFrameReady = $state(false);
    let entranceFrameAt = $state<number | null>(null);
    let entranceArmed = $state(false);
    let capability = $state<CapabilityOutcome | null>(null);

    // Reveal the layout first. The first RAF records a visible, splash-free frame; the second
    // RAF arms the compositor entrance after that frame has painted.
    $effect(() => {
        if (!shellReady) return;
        let cleanupArm = () => {};
        const visibleFrame = requestAnimationFrame(() => {
            entranceFrameAt = performance.now();
            entranceFrameReady = true;
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
    class={`shell${shellReady ? "" : " shell-booting"}${entranceArmed ? " shell-entrance-armed" : ""}`}
    data-region="shell"
    data-shell-ready={shellReady}
    data-entrance-frame-ready={entranceFrameReady}
    data-entrance-frame-at={entranceFrameAt ?? ""}
    data-entrance-armed={entranceArmed}
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
