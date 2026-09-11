<script lang="ts">
    import Panel from "./Panel.svelte";
    import Status from "./Status.svelte";
    import Timeline from "./Timeline.svelte";
    import View from "./View.svelte";
</script>

<svelte:head>
    <meta name="theme-color" content="#0b0d10" />
</svelte:head>

<main class="shell" data-region="shell">
    <Panel title="Context" region="context">
        <div class="panel-placeholder">Select an object to edit its properties.</div>
    </Panel>
    <Panel title="View" region="view">
        <View />
    </Panel>
    <Panel title="Timeline" region="timeline">
        <Timeline />
    </Panel>
    <Status />
</main>
