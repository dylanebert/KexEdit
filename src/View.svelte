<script lang="ts">
    import { run, shallotDark } from "@dylanebert/shallot";
    import { onMount } from "svelte";
    import project from "virtual:project";
    import { assessWebGpu, blockCapability, type CapabilityOutcome } from "./capability";
    import { PathPlugin } from "./path/view";

    let {
        onCapability,
        onReady,
    }: {
        onCapability: (outcome: CapabilityOutcome) => void;
        onReady: () => void;
    } = $props();

    onMount(() => {
        let disposed = false;
        let revealFrame = 0;
        let loadingComplete = false;
        let app: Awaited<ReturnType<typeof run>> | undefined;

        void assessWebGpu().then((capability) => {
            if (disposed) return;
            onCapability(capability);
            if (capability.status === "block") return;

            return run({
                capacity: project.capacity ?? undefined,
                pixelRatio: project.pixelRatio ?? undefined,
                plugins: [...project.plugins, PathPlugin],
                scene: project.scene ?? undefined,
                // The engine's existing splash is mounted on body so it covers the shell, not just this view pane.
                loading: shallotDark(document.body),
            }).then(
                (next) => {
                if (disposed) {
                    next.dispose();
                    return;
                }
                app = next;
                // run() resolves only after Shallot's loading.complete() and its cleanup frame, so
                // this marks the splash-free handoff separately from the first rendered frame.
                loadingComplete = true;
                const revealWhenReady = () => {
                    if (disposed) return;
                    if (loadingComplete && (app?.state.time.elapsed ?? 0) > 0) {
                        onReady();
                        return;
                    }
                    revealFrame = requestAnimationFrame(revealWhenReady);
                };
                revealFrame = requestAnimationFrame(revealWhenReady);
                },
                (error: unknown) => {
                    onCapability(blockCapability("Shallot failed to initialize. WebGPU may be unavailable."));
                    console.error("KexEdit failed to boot Shallot", error);
                },
            );
        });

        return () => {
            disposed = true;
            cancelAnimationFrame(revealFrame);
            app?.dispose();
        };
    });
</script>

<div class="view-surface" data-region="view-surface">
    <canvas aria-label="KexEdit 3D view" data-region="canvas"></canvas>
</div>
