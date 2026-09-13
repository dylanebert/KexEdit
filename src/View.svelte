<script lang="ts">
    import { installHarness } from "@dylanebert/shallot/harness";
    import { type PixelProbe, pixelProbePass, probePixels } from "@dylanebert/shallot/harness/pixels";
    import { computeViewProj } from "@dylanebert/shallot/render";
    import { AmbientLight, Camera, DirectionalLight, Part, run, shallotDark } from "@dylanebert/shallot";
    import { Orbit } from "@dylanebert/shallot/extras";
    import { onMount } from "svelte";
    import project from "virtual:project";
    import { assessWebGpu, blockCapability, type CapabilityOutcome } from "./capability";
    import { PathPlugin, pathFixtures, readPathProbe, readTrain, setPath } from "./path/view";
    import { Transform } from "@dylanebert/shallot";

    // `train` reads the train's transform slab and the trajectory tick the scheduler clock names, for the placement row.
    const pathHandle = {
        readPathProbe,
        setPath,
        fixtures: pathFixtures,
        train: undefined as (() => unknown) | undefined,
    };
    type PathWindow = Window & { __kexeditPath?: typeof pathHandle };

    let {
        onCapability,
        onReady,
    }: {
        onCapability: (outcome: CapabilityOutcome) => void;
        onReady: () => void;
    } = $props();
    let canvas: HTMLCanvasElement;

    // The grid comes from the manifest's `@dylanebert/shallot-grid` plugin and the scene's `<a grid />`. The
    // boot row's grid evidence is the composited frame itself: bands over sRGB bytes on the `#1d2021` clear,
    // with each axis band excluding the other two axes and the path's foreground and olive ticks. Axes are 1 px
    // from 0.1.2, so the Y axis reads about (107,157,101) at its centre column.
    const GRID_PROBES = (width: number, height: number): Record<string, PixelProbe> => ({
        neutral: { name: "neutral", minPixels: 8000, minSpan: Math.floor(width / 2) + 1, r: [40, 96], g: [30, 88], b: [22, 80] },
        axisX: { name: "axisX", minPixels: 100, minSpan: Math.floor(width / 4), r: [120, 255], g: [0, 64], b: [0, 64] },
        axisZ: { name: "axisZ", minPixels: 100, minSpan: Math.floor(width / 4), r: [16, 96], g: [96, 176], b: [100, 176] },
        axisY: { name: "axisY", minPixels: 120, minSpan: Math.floor(height / 4), r: [56, 128], g: [112, 192], b: [40, 112] },
    });
    const GRID_CHECKS = {
        neutral: "grid neutral lines drew",
        axisX: "grid red X axis drew",
        axisZ: "grid blue Z axis drew",
        axisY: "grid green Y axis drew through the origin",
    } as const;
    const gridViewProj = new Float32Array(16);

    // A WebGPU canvas holds its frame only until the task that rendered it ends, so the read happens inside
    // a frame callback queued after the engine's own.
    async function captureCanvas(): Promise<ImageData> {
        const url = await new Promise<string>((done) => requestAnimationFrame(() => done(canvas.toDataURL("image/png"))));
        const bitmap = await createImageBitmap(await (await fetch(url)).blob());
        const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = surface.getContext("2d");
        if (!context) throw new Error("no 2d context for the grid capture");
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        return context.getImageData(0, 0, surface.width, surface.height);
    }

    async function classifyGrid(state: Awaited<ReturnType<typeof run>>["state"]) {
        const camera = state.only([Camera, Orbit]);
        if (camera < 0) return [{ name: "grid camera", ok: false }];
        const image = await captureCanvas();
        const probes = GRID_PROBES(image.width, image.height);
        computeViewProj(camera, image.width / image.height, gridViewProj);
        const m = gridViewProj;
        const screen = (x: number, z: number): [number, number] => {
            const w = m[3] * x + m[11] * z + m[15];
            return [
                (((m[0] * x + m[8] * z + m[12]) / w + 1) / 2) * image.width,
                ((1 - (m[1] * x + m[9] * z + m[13]) / w) / 2) * image.height,
            ];
        };
        const [sx, sy] = screen(0, 0);
        const ox = Math.round(sx);
        const oy = Math.round(sy);
        // The path's lateral ticks share the X axis red, so each ground axis is judged only within 6 px of
        // its own projected screen line through the origin.
        const along = (x: number, z: number): Uint8ClampedArray => {
            const [px, py] = screen(x, z);
            const dx = px - sx;
            const dy = py - sy;
            const length = Math.hypot(dx, dy);
            const masked = new Uint8ClampedArray(image.data.length);
            for (let y = 0; y < image.height; y++) {
                for (let x = 0; x < image.width; x++) {
                    if (Math.abs((x - sx) * dy - (y - sy) * dx) / length > 6) continue;
                    const i = (y * image.width + x) * 4;
                    masked.set(image.data.subarray(i, i + 4), i);
                }
            }
            return masked;
        };
        // The Y axis is judged in a 13 px column over the origin's projected screen position, above it.
        const x0 = Math.max(0, ox - 6);
        const stripWidth = Math.max(0, Math.min(image.width, ox + 7) - x0);
        const stripHeight = Math.max(0, Math.min(image.height, oy));
        const strip = new Uint8ClampedArray(stripWidth * stripHeight * 4);
        for (let y = 0; y < stripHeight; y++) {
            const from = (y * image.width + x0) * 4;
            strip.set(image.data.subarray(from, from + stripWidth * 4), y * stripWidth * 4);
        }
        return (Object.keys(GRID_CHECKS) as Array<keyof typeof GRID_CHECKS>).map((key) => {
            const probe = probes[key];
            const result =
                key === "axisY"
                    ? probePixels(strip, stripWidth, stripHeight, probe)
                    : probePixels(
                          key === "axisX" ? along(1, 0) : key === "axisZ" ? along(0, 1) : image.data,
                          image.width,
                          image.height,
                          probe,
                      );
            return {
                name: GRID_CHECKS[key],
                ok: pixelProbePass(result, probe),
                detail: `${key}: ${result.pixels} px over ${result.width}x${result.height}${key === "axisY" ? ` above origin (${ox}, ${oy})` : ""}`,
                data: { ...result },
            };
        });
    }

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
                const harness = installHarness(app.state);
                const bootRun = harness.run;
                harness.run = async (options) => {
                    const boot = await bootRun?.(options);
                    const grid = app ? await classifyGrid(app.state) : [];
                    const path = await readPathProbe();
                    const trainEid = app ? readTrain(app.state)?.eid : undefined;
                    const noPlaceholderCube = app
                        ? [...app.state.query([Part])].every((eid) => eid === trainEid)
                        : false;
                    const orbit = app ? [...app.state.query([Camera, Orbit])].length === 1 : false;
                    const standardLighting = app
                        ? [...app.state.query([AmbientLight])].length === 1 &&
                          [...app.state.query([DirectionalLight])].length === 1
                        : false;
                    return {
                        ...(boot ?? { ok: true, checks: [] }),
                        ok:
                            (boot?.ok ?? true) &&
                            grid.length === 4 &&
                            grid.every((check) => check.ok) &&
                            path.drawn &&
                            noPlaceholderCube &&
                            orbit &&
                            standardLighting,
                        checks: [
                            ...(boot?.checks ?? []),
                            ...grid,
                            {
                                name: "path gizmos drew",
                                ok: path.drawn,
                                data: { samples: path.samples, count: path.count },
                            },
                            { name: "no placeholder cube remains", ok: noPlaceholderCube },
                            { name: "standard Orbit controls camera", ok: orbit },
                            { name: "standard scene lighting is present", ok: standardLighting },
                        ],
                    };
                };
                pathHandle.train = () => {
                    const live = app ? readTrain(app.state) : null;
                    if (!live) return null;
                    const { eid, trajectory, elapsed } = live;
                    return {
                        elapsed,
                        rate: trajectory.header.rate,
                        count: trajectory.header.count,
                        ticks: Array.from(trajectory.ticks),
                        pos: [Transform.pos.x.get(eid), Transform.pos.y.get(eid), Transform.pos.z.get(eid)],
                        rot: [
                            Transform.rot.x.get(eid),
                            Transform.rot.y.get(eid),
                            Transform.rot.z.get(eid),
                            Transform.rot.w.get(eid),
                        ],
                    };
                };
                (globalThis as unknown as PathWindow).__kexeditPath = pathHandle;

                const revealWhenReady = () => {
                    if (disposed) return;
                    if (loadingComplete && harness.ready) {
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
            delete (globalThis as unknown as PathWindow).__kexeditPath;
            app?.dispose();
        };
    });
</script>

<div class="view-surface" data-region="view-surface">
    <canvas bind:this={canvas} aria-label="KexEdit 3D view" data-region="canvas"></canvas>
</div>
