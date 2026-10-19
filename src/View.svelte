<script lang="ts">
    import { createApp, runApp, shallotDark, type App } from "@dylanebert/shallot";
    import { attachCanvas } from "@dylanebert/shallot/rendering";
    import { getContext, onMount } from "svelte";
    import { assessWebGpu, blockCapability, type CapabilityOutcome } from "./capability";
    import { TRANSPORT_CONTEXT, type EditorTransport } from "./transport";
    import { EditorScene, editorWorld } from "./world";
    import { pageSubject } from "./page-subject";

    let { onCapability, onReady }: {
        onCapability: (outcome: CapabilityOutcome) => void; onReady: () => void;
    } = $props();
    const transport = getContext<EditorTransport>(TRANSPORT_CONTEXT);
    let canvas: HTMLCanvasElement;

    onMount(() => {
        let disposed = false;
        let app: App | undefined;
        const scene = editorWorld(new URLSearchParams(location.search).get("fixture") === "stalled");
        const stepped = pageSubject !== undefined;
        const firstFrame = { create: () => ({ waiting: false }) };
        const fail = (error: unknown) => {
            if (disposed) return;
            onCapability(blockCapability("Shallot failed to initialize. WebGPU may be unavailable."));
            console.error("KexEdit failed to boot Shallot", error);
        };
        void (async () => {
            const capability = await assessWebGpu();
            if (disposed) return;
            onCapability(capability);
            if (capability.status === "block") return;
            const next = await (stepped ? createApp : runApp)({
                plugins: [scene, {
                    name: "KexEditHost", dependencies: [scene],
                    initialize(world) {
                        attachCanvas(world, world.resource(EditorScene).camera, canvas);
                        transport.bind(world);
                    },
                    systems: [{
                        name: "KexEditFirstFrame", group: "draw", update(world) {
                            const state = world.resource(firstFrame);
                            if (state.waiting) return;
                            state.waiting = true;
                            world.onFrameSubmit(() => {
                                const fence = world.frameFence;
                                if (!fence) { fail(new Error("The editor's first frame has no GPU fence")); return; }
                                void fence.then(() => { if (!disposed) onReady(); }).catch(fail);
                            });
                        },
                    }],
                }],
                pixelRatio: 1,
                loading: shallotDark({ container: document.body }),
            });
            if (disposed) { next.dispose(); return; }
            app = next;
            if (pageSubject) pageSubject.app = next;
            if (stepped) next.world.step(0);
            await next.world.frameFence;
        })().catch(fail);
        return () => {
            disposed = true;
            app?.dispose();
            if (pageSubject && pageSubject.app === app) pageSubject.app = undefined;
        };
    });
</script>

<div class="view-surface" data-region="view-surface">
    <canvas bind:this={canvas} aria-label="KexEdit 3D view" data-region="canvas"></canvas>
</div>
