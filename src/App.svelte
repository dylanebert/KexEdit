<script lang="ts">
    import Panel from "./Panel.svelte";
    import Status from "./Status.svelte";
    import Timeline from "./Timeline.svelte";
    import View from "./View.svelte";

    let shellReady = $state(false);
</script>

<svelte:head>
    <meta name="theme-color" content="#1d2021" />
</svelte:head>

<main
    class={`shell${shellReady ? "" : " shell-booting"}`}
    data-region="shell"
    data-shell-ready={shellReady}
    aria-hidden={!shellReady}
>
    <Panel title="Context" region="context">
        <div></div>
    </Panel>
    <Panel title="View" region="view">
        <View onReady={() => (shellReady = true)} />
    </Panel>
    <Panel title="Timeline" region="timeline">
        <Timeline />
    </Panel>
    <Status />
</main>
