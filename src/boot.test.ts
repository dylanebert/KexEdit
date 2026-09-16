import { check } from "@dylanebert/shallot/harness/check";
import { classifyAdapter } from "@dylanebert/shallot/harness/seat";
import { openPage, settleFrames, withApp } from "./browser.fixture";

check(
    "the KexEdit canvas boots in Chromium and reaches the final compositor",
    {
        claim: "the view fails to boot or leaves a blank canvas",
        size: "integration",
        requires: ["chromium"],
        host: "mac",
        subject: [
            "src/App.svelte",
            "src/View.svelte",
            "src/capability.ts",
            "src/app.css",
            "shallot.json",
            "public/scenes/scaffold.scene",
        ],
    },
    () =>
        withApp(async ({ url, browser }) => {
            const errors: string[] = [];
            const page = await openPage(browser, url, errors);
            // Attach before the harness becomes ready. This records real compositor playback rather
            // than trusting a settled animation declaration or a timeout.
            const temporalEvidence = page.evaluate(
                () =>
                    new Promise((resolve, reject) => {
                        const started = new Set<EventTarget>();
                        const ended = new Set<EventTarget>();
                        const samples: Array<{
                            opacity: number;
                            transform: string;
                            loadingPresent: boolean;
                            entranceFrameReady: boolean;
                            entranceFrameAt: number;
                            entranceArmed: boolean;
                        }> = [];
                        let firstStart:
                            | {
                                  loadingPresent: boolean;
                                  shellReady: boolean;
                                  entranceFrameReady: boolean;
                                  entranceFrameAt: number;
                                  entranceArmed: boolean;
                                  visible: boolean;
                                  animationStartAt: number;
                              }
                            | undefined;
                        const identity = (transform: string) =>
                            transform === "none" || transform.replaceAll(" ", "") === "matrix(1,0,0,1,0,0)";
                        const loadingPresent = () =>
                            [...document.body.children].some((candidate) => {
                                return getComputedStyle(candidate).zIndex === "10000";
                            });
                        const sample = () => {
                            const pane = document.querySelector<HTMLElement>("[data-region=context]");
                            const shell = document.querySelector<HTMLElement>("[data-region=shell]");
                            if (pane && shell) {
                                const style = getComputedStyle(pane);
                                const opacity = Number(style.opacity);
                                if (style.animationName === "pane-enter" && (opacity < 0.999 || !identity(style.transform))) {
                                    samples.push({
                                        opacity,
                                        transform: style.transform,
                                        loadingPresent: loadingPresent(),
                                        entranceFrameReady: shell.dataset.entranceFrameReady === "true",
                                        entranceFrameAt: Number(shell.dataset.entranceFrameAt),
                                        entranceArmed: shell.dataset.entranceArmed === "true",
                                    });
                                }
                            }
                            if (ended.size < 4) requestAnimationFrame(sample);
                        };
                        const finish = () => {
                            requestAnimationFrame(() => {
                                const final = [
                                    ...document.querySelectorAll<HTMLElement>(
                                        "[data-region=context], [data-region=view], [data-region=timeline], [data-region=status]",
                                    ),
                                ].map((element) => {
                                    const style = getComputedStyle(element);
                                    return { opacity: Number(style.opacity), transform: style.transform };
                                });
                                clearTimeout(timeout);
                                document.removeEventListener("animationstart", onStart);
                                document.removeEventListener("animationend", onEnd);
                                resolve({
                                    startCount: started.size,
                                    endCount: ended.size,
                                    firstStart,
                                    inProgress: samples[0] ?? null,
                                    sampleCount: samples.length,
                                    final,
                                });
                            });
                        };
                        const onStart = (event: AnimationEvent) => {
                            if (event.animationName !== "pane-enter") return;
                            started.add(event.target as EventTarget);
                            if (!firstStart) {
                                const shell = document.querySelector<HTMLElement>("[data-region=shell]");
                                firstStart = {
                                    loadingPresent: loadingPresent(),
                                    shellReady: shell?.dataset.shellReady === "true",
                                    entranceFrameReady: shell?.dataset.entranceFrameReady === "true",
                                    entranceFrameAt: Number(shell?.dataset.entranceFrameAt),
                                    entranceArmed: shell?.dataset.entranceArmed === "true",
                                    visible: getComputedStyle(shell ?? document.body).visibility !== "hidden",
                                    animationStartAt: performance.now(),
                                };
                            }
                            sample();
                        };
                        const onEnd = (event: AnimationEvent) => {
                            if (event.animationName !== "pane-enter") return;
                            ended.add(event.target as EventTarget);
                            if (ended.size === 4) finish();
                        };
                        const timeout = window.setTimeout(
                            () => reject(new Error("timed out collecting pane animation events")),
                            2_000,
                        );
                        document.addEventListener("animationstart", onStart);
                        document.addEventListener("animationend", onEnd);
                    }),
            );
            const bootEvidence = await page.evaluate(() => {
                const overlay = [...document.body.children].find(
                    (candidate) => getComputedStyle(candidate).zIndex === "10000",
                );
                const shell = document.querySelector("[data-shell-ready]");
                const rect = overlay?.getBoundingClientRect();
                return {
                    seen: Boolean(overlay),
                    fullPage:
                        rect !== undefined &&
                        rect.left === 0 &&
                        rect.top === 0 &&
                        rect.width >= window.innerWidth &&
                        rect.height >= window.innerHeight,
                    hasProgressTrack:
                        overlay !== undefined &&
                        [...overlay.querySelectorAll("div")].some((element) => {
                            const style = getComputedStyle(element);
                            return style.height === "4px" && element.querySelector(":scope > div") !== null;
                        }),
                    shellHidden: shell?.getAttribute("data-shell-ready") === "false",
                };
            });
            if (!bootEvidence.seen || !bootEvidence.fullPage || !bootEvidence.hasProgressTrack || !bootEvidence.shellHidden) {
                throw new Error(`full-page Shallot splash handoff failed: ${JSON.stringify(bootEvidence)}`);
            }
            await page.waitForFunction(() => window.__harness?.ready === true, undefined, {
                timeout: 15_000,
            });
            const temporal = (await temporalEvidence) as {
                startCount: number;
                endCount: number;
                firstStart?: {
                    loadingPresent: boolean;
                    shellReady: boolean;
                    entranceFrameReady: boolean;
                    entranceFrameAt: number;
                    entranceArmed: boolean;
                    visible: boolean;
                    animationStartAt: number;
                };
                inProgress: {
                    opacity: number;
                    transform: string;
                    loadingPresent: boolean;
                    entranceArmed: boolean;
                } | null;
                sampleCount: number;
                final: Array<{ opacity: number; transform: string }>;
            };
            const finalIdentity = (transform: string) =>
                transform === "none" || transform.replaceAll(" ", "") === "matrix(1,0,0,1,0,0)";
            if (
                temporal.startCount !== 4 ||
                temporal.endCount !== 4 ||
                temporal.firstStart?.loadingPresent !== false ||
                temporal.firstStart?.shellReady !== true ||
                temporal.firstStart?.entranceFrameReady !== true ||
                !Number.isFinite(temporal.firstStart?.entranceFrameAt) ||
                temporal.firstStart.animationStartAt <= temporal.firstStart.entranceFrameAt ||
                temporal.firstStart?.entranceArmed !== true ||
                temporal.firstStart?.visible !== true ||
                temporal.inProgress === null ||
                temporal.inProgress.opacity <= 0 ||
                temporal.inProgress.opacity >= 1 ||
                finalIdentity(temporal.inProgress.transform) ||
                temporal.inProgress.loadingPresent ||
                !temporal.inProgress.entranceArmed ||
                temporal.final.length !== 4 ||
                temporal.final.some((pane) => pane.opacity !== 1 || !finalIdentity(pane.transform))
            ) {
                throw new Error(`temporal pane entrance handoff failed: ${JSON.stringify(temporal)}`);
            }
            // Let the short compositor entrance settle before measuring seam geometry; transforms would
            // otherwise make a one-pixel divider appear displaced while the panes are scaling in.
            await settleFrames(page);
            const shellEvidence = await page.evaluate(async () => {
                const parseComputedRgb = (color: string): number[] | undefined => {
                    const legacy = color.match(/^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/);
                    if (legacy) return legacy.slice(1, 4).map(Number);
                    const srgb = color.match(/^color\(srgb\s+([\d.e+-]+)\s+([\d.e+-]+)\s+([\d.e+-]+)/);
                    if (srgb) return srgb.slice(1, 4).map((channel) => Number(channel) * 255);
                    return undefined;
                };
                const shell = document.querySelector<HTMLElement>("[data-region=shell]");
                const context = document.querySelector<HTMLElement>("[data-region=context]");
                const viewPane = document.querySelector<HTMLElement>("[data-region=view]");
                const view = document.querySelector<HTMLElement>("[data-region=view-surface]");
                const timeline = document.querySelector<HTMLElement>("[data-region=timeline-track]");
                const timelinePane = document.querySelector<HTMLElement>("[data-region=timeline]");
                const status = document.querySelector<HTMLElement>("[data-region=status]");
                const canvas = document.querySelector<HTMLCanvasElement>("canvas");
                if (!shell || !context || !viewPane || !view || !timeline || !timelinePane || !status || !canvas) {
                    return { ready: false, surfaceRoles: false, dividers: false, gap: false, clearMatch: false };
                }
                const style = (element: HTMLElement) => getComputedStyle(element);
                const grounds = {
                    context: style(context).backgroundColor,
                    view: style(view).backgroundColor,
                    canvas: style(canvas).backgroundColor,
                    timeline: style(timeline).backgroundColor,
                    status: style(status).backgroundColor,
                };
                const border = "rgb(60, 56, 54)";
                const noOuterBorder = (element: HTMLElement, allowed: "borderLeftWidth" | "borderTopWidth" | null) =>
                    ["borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"].every(
                        (side) => side === allowed || style(element)[side as "borderTopWidth"] === "0px",
                    );
                const divider = (element: HTMLElement, side: "borderLeftWidth" | "borderTopWidth") =>
                    style(element)[side] === "1px" &&
                    style(element)[side === "borderLeftWidth" ? "borderLeftColor" : "borderTopColor"] === border;
                const contextRect = context.getBoundingClientRect();
                const viewRect = viewPane.getBoundingClientRect();
                const timelineRect = timelinePane.getBoundingClientRect();
                const statusRect = status.getBoundingClientRect();
                const gapValues = [
                    viewRect.left - contextRect.right,
                    timelineRect.top - contextRect.bottom,
                    statusRect.top - timelineRect.bottom,
                ];
                const paneColor = grounds.context;
                const canvasColor = grounds.canvas;
                const rgb = parseComputedRgb(canvasColor);
                const handle = (globalThis as unknown as { __kexeditPath?: { captureFrame(): Promise<{ rgba: Uint8ClampedArray; width: number; height: number }> } }).__kexeditPath;
                const shot = await handle?.captureFrame();
                if (!shot || !rgb) {
                    return { ready: false, surfaceRoles: false, dividers: false, gap: false, clearMatch: false };
                }
                const samplePoints = [0.08, 0.32, 0.68, 0.92].map((fraction) => [
                    Math.min(shot.width - 1, Math.floor(shot.width * fraction)),
                    1,
                ]);
                const samples = samplePoints.map(([x, y]) => {
                    const index = (y * shot.width + x) * 4;
                    return [shot.rgba[index], shot.rgba[index + 1], shot.rgba[index + 2]];
                });
                const distance = (sample: number[]) =>
                    Math.max(...sample.map((channel, index) => Math.abs(channel - (rgb[index] ?? 0))));
                const clearMatches = samples.filter((sample) => distance(sample) <= 2).length;
                const animation = style(context);
                return {
                    ready: shell.dataset.shellReady === "true" && shell.getAttribute("aria-hidden") === "false",
                    surfaceRoles:
                        grounds.context === grounds.status &&
                        grounds.view === grounds.canvas &&
                        grounds.context !== grounds.timeline &&
                        grounds.timeline !== grounds.canvas,
                    dividers:
                        noOuterBorder(context, null) &&
                        noOuterBorder(viewPane, "borderLeftWidth") &&
                        noOuterBorder(timelinePane, "borderTopWidth") &&
                        noOuterBorder(status, "borderTopWidth") &&
                        divider(viewPane, "borderLeftWidth") &&
                        divider(timelinePane, "borderTopWidth") &&
                        divider(status, "borderTopWidth"),
                    gap: gapValues.every((value) => Math.abs(value) < 0.1),
                    gapValues,
                    clearMatch: clearMatches >= 3,
                    paneColor,
                    canvasColor,
                    clearSamples: samples,
                    clearMatches,
                    animation: animation.animationName === "pane-enter" && animation.animationDuration === "0.18s",
                };
            });
            if (
                !shellEvidence.ready ||
                !shellEvidence.surfaceRoles ||
                !shellEvidence.dividers ||
                !shellEvidence.gap ||
                !shellEvidence.clearMatch ||
                !shellEvidence.animation
            ) {
                throw new Error(`shell handoff/divider/zero-gap/clear-color/entrance failed: ${JSON.stringify(shellEvidence)}`);
            }
            await settleFrames(page);
            const entranceEvidence = await page.evaluate(() => {
                const elements = [
                    ...document.querySelectorAll<HTMLElement>("[data-region=context], [data-region=view], [data-region=timeline], [data-region=status]"),
                ];
                const identity = (transform: string) =>
                    transform === "none" || transform.replaceAll(" ", "") === "matrix(1,0,0,1,0,0)";
                return {
                    count: elements.length,
                    complete: elements.length === 4 && elements.every((element) => {
                        const computed = getComputedStyle(element);
                        return computed.opacity === "1" && identity(computed.transform);
                    }),
                };
            });
            if (!entranceEvidence.complete) {
                throw new Error(`pane entrance did not settle: ${JSON.stringify(entranceEvidence)}`);
            }
            const reducedPage = await openPage(browser, url, null, (reduced) => reduced.emulateMedia({ reducedMotion: "reduce" }));
            await reducedPage.waitForFunction(() => window.__harness?.ready === true, undefined, { timeout: 15_000 });
            const reducedMotionEvidence = await reducedPage.evaluate(() => {
                const shell = document.querySelector<HTMLElement>("[data-region=shell]");
                const pane = document.querySelector<HTMLElement>("[data-region=context]");
                const status = document.querySelector<HTMLElement>("[data-region=status]");
                if (!shell || !pane || !status) return { reduced: false };
                const paneStyle = getComputedStyle(pane);
                const statusStyle = getComputedStyle(status);
                return {
                    reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
                    ready: shell.dataset.shellReady === "true",
                    animation: paneStyle.animationName,
                    paneStable: paneStyle.opacity === "1" && paneStyle.transform === "none",
                    statusStable: statusStyle.opacity === "1" && statusStyle.transform === "none",
                };
            });
            if (
                !reducedMotionEvidence.reduced ||
                !reducedMotionEvidence.ready ||
                reducedMotionEvidence.animation !== "none" ||
                !reducedMotionEvidence.paneStable ||
                !reducedMotionEvidence.statusStable
            ) {
                throw new Error(`reduced-motion entrance failed: ${JSON.stringify(reducedMotionEvidence)}`);
            }
            const blockedPage = await openPage(browser, url, null, (blocked) =>
                blocked.addInitScript(() => {
                    Object.defineProperty(Navigator.prototype, "gpu", { configurable: true, value: undefined });
                }),
            );
            await blockedPage.waitForSelector("[data-region=capability-block]", { timeout: 5_000 });
            const blockedEvidence = await blockedPage.evaluate(() => {
                const shell = document.querySelector<HTMLElement>("[data-region=shell]");
                const block = document.querySelector<HTMLElement>("[data-region=capability-block]");
                return {
                    blocked: shell?.dataset.capability === "block",
                    shellHidden: getComputedStyle(shell ?? document.body).visibility === "hidden",
                    clearMessage: block?.textContent?.includes("WebGPU is required") === true,
                };
            });
            if (!blockedEvidence.blocked || !blockedEvidence.shellHidden || !blockedEvidence.clearMessage) {
                throw new Error(`no-WebGPU capability gate failed: ${JSON.stringify(blockedEvidence)}`);
            }
            const verdict = await page.evaluate(async () => {
                const harness = window.__harness;
                if (!harness?.run) throw new Error("page did not install window.__harness.run");
                return harness.run({ size: "integration", requires: ["chromium"] });
            });
            if (
                verdict.ok !== true ||
                !Array.isArray(verdict.checks) ||
                verdict.checks.length === 0 ||
                verdict.checks.some((check) => check.ok !== true)
            ) {
                throw new Error(`harness protocol failed: ${JSON.stringify(verdict)}`);
            }
            const requiredChecks = [
                "grid neutral lines drew",
                "grid red X axis drew",
                "grid blue Z axis drew",
                "grid green Y axis drew through the origin",
                "no placeholder cube remains",
                "standard Orbit controls camera",
                "standard scene lighting is present",
            ];
            for (const name of requiredChecks) {
                const check = verdict.checks.find((candidate) => candidate.name === name);
                if (!check?.ok) throw new Error(`missing passing scene evidence: ${name}`);
            }
            const evidence = await page.evaluate(async () => {
                const adapter = await navigator.gpu?.requestAdapter();
                const info = (adapter as (GPUAdapter & { info?: Record<string, string> }) | undefined)?.info;
                const hardware = [info?.description, info?.device, info?.vendor, info?.architecture]
                    .filter((part): part is string => Boolean(part))
                    .join(" ") || (adapter ? "gpu" : "none");
                const adapterInfo = {
                    description: info?.description,
                    device: info?.device,
                    vendor: info?.vendor,
                    architecture: info?.architecture,
                    isFallbackAdapter: (adapter as (GPUAdapter & { isFallbackAdapter?: boolean }) | undefined)?.isFallbackAdapter,
                };
                const handle = (globalThis as unknown as { __kexeditPath?: { captureFrame(): Promise<{ rgba: Uint8ClampedArray; width: number; height: number }> } }).__kexeditPath;
                const shot = await handle?.captureFrame();
                if (!shot) return { adapter: false, hardware, info: adapterInfo, pixels: 0, span: 0 };
                const pixels = shot.rgba;
                let count = 0;
                let minX = shot.width;
                let maxX = -1;
                for (let i = 0; i < pixels.length; i += 4) {
                    if (pixels[i + 3] > 0 && (pixels[i] > 8 || pixels[i + 1] > 8 || pixels[i + 2] > 8)) {
                        count += 1;
                        const x = (i / 4) % shot.width;
                        minX = Math.min(minX, x);
                        maxX = Math.max(maxX, x);
                    }
                }
                return { adapter: Boolean(adapter), hardware, info: adapterInfo, pixels: count, span: maxX >= 0 ? maxX - minX + 1 : 0 };
            });
            if (errors.length > 0) throw new Error(errors.join(" | "));
            const adapter = classifyAdapter({ present: evidence.adapter, info: evidence.info });
            if (adapter.class !== "real") throw new Error(`Chromium real-device seat refused: ${adapter.reason ?? adapter.class}`);
            console.log(
                `browser evidence: Chromium GPU ${adapter.identity}; capture=final-canvas 1280x720@1 rgba8-tight; pixels=${evidence.pixels}; span=${evidence.span}; gridChecks=${JSON.stringify(verdict.checks.filter((check) => check.name.startsWith("grid")).map((check) => check.detail))}; clearSamples=${JSON.stringify(shellEvidence.clearSamples)} vs ${shellEvidence.paneColor} (matches=${shellEvidence.clearMatches}/4); gaps=${JSON.stringify(shellEvidence.gapValues)}px; temporalEntrance=${JSON.stringify({ starts: temporal.startCount, ends: temporal.endCount, samples: temporal.sampleCount, first: temporal.firstStart, inProgress: temporal.inProgress, final: temporal.final })}; splash/painted-frame/painted-arm/temporal-scale/zero-gap/single-divider/entrance/reduced-motion/no-WebGPU-block/grid-axis/no-cube/orbit/lighting checks=pass`,
            );
            if (evidence.pixels < 200 || evidence.span < 24) {
                throw new Error(`canvas pixel gate failed: ${JSON.stringify(evidence)}`);
            }
            return { ok: true, checks: [{ name: "GPU canvas rendered", ok: true, data: evidence }] };
        }),
);
