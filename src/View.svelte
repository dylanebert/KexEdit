<script lang="ts">
    import { installHarness } from "@dylanebert/shallot/harness";
    import { AmbientLight, Camera, DirectionalLight, Part, run } from "@dylanebert/shallot";
    import { Orbit } from "@dylanebert/shallot/extras";
    import { onMount } from "svelte";
    import project from "virtual:project";
    import { GridPlugin, readGridProbe } from "./grid";

    let canvas: HTMLCanvasElement;

    onMount(() => {
        let disposed = false;
        let app: Awaited<ReturnType<typeof run>> | undefined;

        void run({
            capacity: project.capacity ?? undefined,
            pixelRatio: project.pixelRatio ?? undefined,
            plugins: [...project.plugins, GridPlugin],
            scene: project.scene ?? undefined,
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
                    const cube = app ? [...app.state.query([Part])].length === 1 : false;
                    const orbit = app ? [...app.state.query([Camera, Orbit])].length === 1 : false;
                    const standardLighting = app
                        ? [...app.state.query([AmbientLight])].length === 1 &&
                          [...app.state.query([DirectionalLight])].length === 1
                        : false;
                    return {
                        ...(boot ?? { ok: true, checks: [] }),
                        ok: (boot?.ok ?? true) && grid.drawn && cube && orbit && standardLighting,
                        checks: [
                            ...(boot?.checks ?? []),
                            { name: "GPU grid material drew", ok: grid.drawn, data: { samples: grid.samples } },
                            { name: "one cube is present", ok: cube },
                            { name: "standard Orbit controls camera", ok: orbit },
                            { name: "standard scene lighting is present", ok: standardLighting },
                        ],
                    };
                };
                (globalThis as unknown as Window & {
                    __kexeditGridProbe?: typeof readGridProbe;
                }).__kexeditGridProbe = readGridProbe;
            },
            (error: unknown) => {
                console.error("KexEdit failed to boot Shallot", error);
            },
        );

        return () => {
            disposed = true;
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
