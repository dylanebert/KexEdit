<script lang="ts">
    import type { Snippet } from "svelte";

    let {
        children,
        region,
        title,
    }: {
        children: Snippet;
        region: string;
        title: string;
    } = $props();
</script>

<section class={`panel panel-${region}`} data-region={region} aria-label={title}>
    <div class="panel-content">
        {@render children()}
    </div>
</section>
