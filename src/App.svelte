<script lang="ts">
    import type { CapabilityOutcome } from "./capability";
    import Panel from "./Panel.svelte";
    import Status from "./Status.svelte";
    import Timeline from "./Timeline.svelte";
    import View from "./View.svelte";

    let shellReady = $state(false);
    let capability = $state<CapabilityOutcome | null>(null);
</script>

<svelte:head>
    <meta name="theme-color" content="#1d2021" />
</svelte:head>

<main
    class={`shell${shellReady ? "" : " shell-booting"}`}
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
