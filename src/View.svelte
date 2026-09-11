<script lang="ts">
    import { installHarness } from "@dylanebert/shallot/harness";
    import { AmbientLight, Camera, DirectionalLight, Part, run, shallotDark } from "@dylanebert/shallot";
    import { Orbit } from "@dylanebert/shallot/extras";
    import { onMount } from "svelte";
    import project from "virtual:project";
    import { assessWebGpu, blockCapability, type CapabilityOutcome } from "./capability";
    import { GridPlugin, readGridMaterialContract, readGridProbe } from "./grid";

    let {
        onCapability,
        onReady,
    }: {
        onCapability: (outcome: CapabilityOutcome) => void;
        onReady: () => void;
    } = $props();
    let canvas: HTMLCanvasElement;

    onMount(() => {
        let disposed = false;
        let revealFrame = 0;
        let app: Awaited<ReturnType<typeof run>> | undefined;

        void assessWebGpu().then((capability) => {
            if (disposed) return;
            onCapability(capability);
            if (capability.status === "block") return;

            return run({
                capacity: project.capacity ?? undefined,
                pixelRatio: project.pixelRatio ?? undefined,
                plugins: [...project.plugins, GridPlugin],
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
                const harness = installHarness(app.state);
                const bootRun = harness.run;
                harness.run = async (options) => {
                    const boot = await bootRun?.(options);
                    const grid = await readGridProbe();
                    const noPlaceholderCube = app ? [...app.state.query([Part])].length === 0 : false;
                    const orbit = app ? [...app.state.query([Camera, Orbit])].length === 1 : false;
                    const standardLighting = app
                        ? [...app.state.query([AmbientLight])].length === 1 &&
                          [...app.state.query([DirectionalLight])].length === 1
                        : false;
                    const material = readGridMaterialContract();
                    const gridAxisMaterial =
                        material.present &&
                        material.neutral.length === 4 &&
                        material.axisX[0] > material.axisX[1] &&
                        material.axisX[0] > material.axisX[2] &&
                        material.axisZ[2] > material.axisZ[0] &&
                        material.axisZ[2] > material.axisZ[1] &&
                        material.hasYAxis === false;
                    return {
                        ...(boot ?? { ok: true, checks: [] }),
                        ok:
                            (boot?.ok ?? true) &&
                            grid.drawn &&
                            noPlaceholderCube &&
                            orbit &&
                            standardLighting &&
                            gridAxisMaterial,
                        checks: [
                            ...(boot?.checks ?? []),
                            { name: "GPU grid material drew", ok: grid.drawn, data: { samples: grid.samples } },
                            { name: "no placeholder cube remains", ok: noPlaceholderCube },
                            { name: "grid/axis material contract is present", ok: gridAxisMaterial },
                            { name: "standard Orbit controls camera", ok: orbit },
                            { name: "standard scene lighting is present", ok: standardLighting },
                        ],
                    };
                };
                (globalThis as unknown as Window & {
                    __kexeditGridProbe?: typeof readGridProbe;
                }).__kexeditGridProbe = readGridProbe;

                const revealWhenReady = () => {
                    if (disposed) return;
                    if (harness.ready) {
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
            delete (globalThis as unknown as Window & {
                __kexeditGridProbe?: typeof readGridProbe;
            }).__kexeditGridProbe;
            app?.dispose();
        };
    });
</script>

<div class="view-surface" data-region="view-surface">
    <canvas bind:this={canvas} aria-label="KexEdit 3D view" data-region="canvas"></canvas>
</div>
