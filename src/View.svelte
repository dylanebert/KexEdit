<script lang="ts">
    import { installHarness } from "@dylanebert/shallot/harness";
    import { run } from "@dylanebert/shallot";
    import { onMount } from "svelte";
    import project from "virtual:project";

    let canvas: HTMLCanvasElement;

    onMount(() => {
        let disposed = false;
        let app: Awaited<ReturnType<typeof run>> | undefined;

        void run({
            capacity: project.capacity ?? undefined,
            pixelRatio: project.pixelRatio ?? undefined,
            plugins: project.plugins,
            scene: project.scene ?? undefined,
        }).then(
            (next) => {
                if (disposed) {
                    next.dispose();
                    return;
                }
                app = next;
                installHarness(app.state);
            },
            (error: unknown) => {
                console.error("KexEdit failed to boot Shallot", error);
            },
        );

        return () => {
            disposed = true;
            app?.dispose();
        };
    });
</script>

<div class="view-surface" data-region="view-surface">
    <canvas bind:this={canvas} aria-label="KexEdit 3D view" data-region="canvas"></canvas>
</div>
