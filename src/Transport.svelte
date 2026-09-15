<script lang="ts">
    import { Pause, Play } from "@lucide/svelte";
    import { transport, type TransportSnapshot } from "./path/view";
    import {
        frameAll,
        panByPixels,
        pixelToTime,
        timeToPixel,
        updateDomain,
        visibleTicks,
        wheelZoomRatio,
        zoomAtPixel,
        type TimelineViewport,
    } from "./timeline/viewport";

    type Gesture = {
        mode: "scrub" | "pan";
        pointerId: number;
        startClientX: number;
        startView: TimelineViewport;
        middle: boolean;
    };

    let snapshot = $state<TransportSnapshot | null>(transport.snapshot());
    let viewport = $state<TimelineViewport | null>(null);
    let surfaceWidth = $state(0);
    let surfaceElement = $state<HTMLDivElement | null>(null);
    let gesture = $state<Gesture | null>(null);
    let spaceHeld = $state(false);
    let spaceChordUsed = $state(false);
    let suppressMiddleAuxclick = $state(false);

    $effect(() =>
        transport.subscribe((next) => {
            snapshot = next;
            if (!next) {
                viewport = null;
                return;
            }
            const duration = next.length / next.headerRate;
            const minSpan = Math.min(duration, 1 / next.headerRate);
            if (!viewport || viewport.duration !== duration || viewport.minSpan !== minSpan) {
                viewport = viewport ? updateDomain(viewport, duration, next.headerRate) : frameAll(duration, next.headerRate);
            }
        }),
    );

    $effect(() => {
        const surface = surfaceElement;
        if (!surface) return;
        const resize = new ResizeObserver(([entry]) => {
            surfaceWidth = entry?.contentRect.width ?? surface.getBoundingClientRect().width;
        });
        resize.observe(surface);
        surfaceWidth = surface.getBoundingClientRect().width;
        return () => resize.disconnect();
    });

    $effect(() => {
        const surface = surfaceElement;
        if (!surface) return;
        const onWheel = (event: WheelEvent): void => {
            if (gesture || !viewport) return;
            const width = surface.getBoundingClientRect().width || surfaceWidth;
            if (!(width > 0)) return;
            const bounds = surface.getBoundingClientRect();
            const pixel = Math.min(width, Math.max(0, event.clientX - bounds.left));
            if (event.shiftKey) {
                const dominant = Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
                if (dominant === 0) return;
                const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? width : 1;
                viewport = panByPixels(viewport, width, dominant * unit);
                event.preventDefault();
                return;
            }
            if (event.deltaY !== 0) {
                viewport = zoomAtPixel(
                    viewport,
                    width,
                    pixel,
                    wheelZoomRatio(event.deltaY, event.deltaMode, event.ctrlKey || event.metaKey),
                );
                event.preventDefault();
            }
        };
        surface.addEventListener("wheel", onWheel, { passive: false });
        return () => surface.removeEventListener("wheel", onWheel);
    });

    const format = (value: number): string => value.toFixed(2).replace(/\.00$/, "");
    const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));
    const ticks = $derived(viewport && surfaceWidth > 0 ? visibleTicks(viewport, surfaceWidth) : []);

    function widthForSurface(): number {
        return surfaceElement?.getBoundingClientRect().width || surfaceWidth;
    }

    function rulerPixel(event: PointerEvent): number {
        const bounds = surfaceElement?.getBoundingClientRect();
        return bounds ? clamp(event.clientX - bounds.left, 0, widthForSurface()) : 0;
    }

    function scrubAt(event: PointerEvent): void {
        if (!snapshot || !viewport) return;
        const width = widthForSurface();
        if (!(width > 0)) return;
        const seconds = clamp(pixelToTime(viewport, width, rulerPixel(event)), viewport.start, viewport.start + viewport.span);
        transport.scrub(seconds * snapshot.headerRate);
    }

    function handlePointerDown(event: PointerEvent): void {
        const surface = surfaceElement;
        if (!surface || !viewport) return;
        if (event.button === 1) {
            gesture = { mode: "pan", pointerId: event.pointerId, startClientX: event.clientX, startView: viewport, middle: true };
            suppressMiddleAuxclick = false;
            event.preventDefault();
            surface.setPointerCapture(event.pointerId);
            return;
        }
        if (event.button !== 0) return;
        if (spaceHeld) {
            spaceChordUsed = true;
            gesture = { mode: "pan", pointerId: event.pointerId, startClientX: event.clientX, startView: viewport, middle: false };
            event.preventDefault();
            surface.setPointerCapture(event.pointerId);
            return;
        }
        const target = event.target instanceof Element ? event.target.closest('[data-region="ruler"]') : null;
        if (!target) return;
        gesture = { mode: "scrub", pointerId: event.pointerId, startClientX: event.clientX, startView: viewport, middle: false };
        event.preventDefault();
        surface.setPointerCapture(event.pointerId);
        scrubAt(event);
    }

    function handlePointerMove(event: PointerEvent): void {
        if (!gesture || gesture.pointerId !== event.pointerId || !viewport) return;
        if (gesture.mode === "pan") {
            viewport = panByPixels(gesture.startView, widthForSurface(), gesture.startClientX - event.clientX);
        } else {
            scrubAt(event);
        }
    }

    function endGesture(event?: PointerEvent): void {
        if (!gesture) return;
        const current = gesture;
        if (event && current.pointerId !== event.pointerId) return;
        if (current.middle) suppressMiddleAuxclick = true;
        if (surfaceElement?.hasPointerCapture(current.pointerId)) surfaceElement.releasePointerCapture(current.pointerId);
        gesture = null;
    }

    function handleAuxClick(event: MouseEvent): void {
        if (event.button === 1 && suppressMiddleAuxclick) {
            event.preventDefault();
            suppressMiddleAuxclick = false;
        }
    }

    function isIgnoredKeyTarget(target: EventTarget | null): boolean {
        return target instanceof HTMLElement && (target.matches("button, input, textarea, select") || target.isContentEditable);
    }

    function handleKeydown(event: KeyboardEvent): void {
        if (isIgnoredKeyTarget(event.target) || !snapshot) return;
        if (event.key === " ") {
            event.preventDefault();
            if (event.repeat) return;
            spaceHeld = true;
            if (gesture) spaceChordUsed = true;
            return;
        }
        if (event.code === "KeyF" && !event.ctrlKey && !event.metaKey && !event.altKey && viewport) {
            event.preventDefault();
            viewport = frameAll(viewport.duration, snapshot.headerRate);
            return;
        }
        if (event.key === "Home") {
            event.preventDefault();
            transport.scrub(0);
        } else if (event.key === "End") {
            event.preventDefault();
            transport.scrub(snapshot.length);
        } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            const direction = event.key === "ArrowLeft" ? -1 : 1;
            transport.scrub(snapshot.playhead + direction * (event.shiftKey ? snapshot.headerRate : 1));
        }
    }

    function handleKeyup(event: KeyboardEvent): void {
        if (event.key !== " " || isIgnoredKeyTarget(event.target)) return;
        event.preventDefault();
        if (!spaceHeld) return;
        const used = spaceChordUsed;
        spaceHeld = false;
        spaceChordUsed = false;
        if (!used) transport.togglePlaying();
    }

    function handleBlur(): void {
        spaceHeld = false;
        spaceChordUsed = false;
        endGesture();
    }

    function position(seconds: number): number {
        return viewport ? timeToPixel(viewport, widthForSurface(), seconds) : 0;
    }

    function intervalStyle(start: number, end: number): string | null {
        if (!viewport || !(widthForSurface() > 0)) return null;
        const visibleStart = Math.max(start, viewport.start);
        const visibleEnd = Math.min(end, viewport.start + viewport.span);
        if (visibleEnd <= visibleStart) return null;
        return `left: ${position(visibleStart)}px; width: ${position(visibleEnd) - position(visibleStart)}px`;
    }
</script>

<svelte:window onkeydown={handleKeydown} onkeyup={handleKeyup} onblur={handleBlur} />

<div class="transport" data-region="transport" data-playing={snapshot?.playing ?? false}>
    <div class="timeline-frame transport-controls" data-region="transport-controls">
        <div class="timeline-gutter" aria-hidden="true"></div>
        <div class="transport-control-viewport">
            <div class="transport-playback" role="group" aria-label="Playback controls">
                <button
                    class="transport-button transport-play"
                    type="button"
                    data-action="play-pause"
                    aria-label={snapshot?.playing ? "Pause" : "Play"}
                    aria-keyshortcuts="Space"
                    title={snapshot?.playing ? "Pause (Space)" : "Play (Space)"}
                    onclick={() => transport.togglePlaying()}
                >
                    {#if snapshot?.playing}
                        <Pause size={15} strokeWidth={2} />
                    {:else}
                        <Play size={15} strokeWidth={2} />
                    {/if}
                </button>
            </div>
            <output
                class="transport-readout"
                data-readout="time"
                aria-label={snapshot ? `Time: ${format(snapshot.playhead / snapshot.headerRate)} / ${format(snapshot.length / snapshot.headerRate)} seconds` : "Time: 0 / 0 seconds"}
            >
                <span class="transport-time-current">{snapshot ? format(snapshot.playhead / snapshot.headerRate) : "0"}</span>
                <span class="transport-time-total">/ {snapshot ? format(snapshot.length / snapshot.headerRate) : "0"} s</span>
            </output>
        </div>
    </div>

    <div class="timeline-frame timeline-frame-body">
        <div class="timeline-gutter" aria-hidden="true"></div>
        <div
            class="timeline-surface"
            role="group"
            aria-label="Timeline viewport"
            data-region="timeline-surface"
            data-gesture={gesture?.mode === "pan" ? "pan" : undefined}
            data-view-start={viewport?.start ?? 0}
            data-view-end={viewport ? viewport.start + viewport.span : 0}
            data-view-span={viewport?.span ?? 0}
            bind:this={surfaceElement}
            onpointerdown={handlePointerDown}
            onpointermove={handlePointerMove}
            onpointerup={endGesture}
            onpointercancel={endGesture}
            onauxclick={handleAuxClick}
        >
        <div
            class="timeline-ruler"
            data-region="ruler"
            role="slider"
            tabindex="0"
            aria-label="Timeline playhead"
            aria-valuemin="0"
            aria-valuemax={snapshot?.length ?? 0}
            aria-valuenow={snapshot?.playhead ?? 0}
            aria-valuetext={snapshot ? `Time: ${format(snapshot.playhead / snapshot.headerRate)} seconds` : "Time: 0 seconds"}
            title="Scroll zoom · Shift scroll pan · F frame all"
        >
            <div class="timeline-ticks" aria-hidden="true">
                {#each ticks as tick (tick.seconds)}
                    <span
                        class="timeline-tick"
                        data-tick-level={tick.major ? "major" : "minor"}
                        data-tick-seconds={tick.seconds}
                        style={`left: ${position(tick.seconds)}px`}
                    >
                        {#if tick.major}
                            <span class="timeline-tick-label">{tick.label}</span>
                        {/if}
                    </span>
                {/each}
            </div>
        </div>

        <div class="timeline-lanes" data-region="reserved-lanes" aria-label="Reserved timeline lanes">
            {#each [0, 1, 2, 3] as lane}
                <div class="timeline-lane" data-region="timeline-lane" data-lane={lane}></div>
            {/each}
            <div class="timeline-lanes-grid" aria-hidden="true">
                {#each ticks as tick (tick.seconds)}
                    <span
                        class="timeline-grid-line"
                        data-tick-level={tick.major ? "major" : "minor"}
                        data-tick-seconds={tick.seconds}
                        style={`left: ${position(tick.seconds)}px`}
                    ></span>
                {/each}
            </div>
        </div>

        {#if snapshot && viewport && intervalStyle(0, snapshot.endReason === "complete" ? viewport.duration : snapshot.endTick / snapshot.headerRate)}
            <div
                class="timeline-state timeline-state-solved"
                data-state="solved"
                style={intervalStyle(0, snapshot.endReason === "complete" ? viewport.duration : snapshot.endTick / snapshot.headerRate) ?? ""}
            ></div>
        {/if}
        {#if snapshot && viewport && snapshot.endReason !== "complete" && intervalStyle(snapshot.endTick / snapshot.headerRate, viewport.duration)}
            <div
                class="timeline-state timeline-state-unsolved"
                data-state="unsolved"
                data-region="dead-tail"
                style={intervalStyle(snapshot.endTick / snapshot.headerRate, viewport.duration) ?? ""}
            ></div>
            <div
                class="timeline-state timeline-state-offending"
                data-state="offending"
                data-region="end-mark"
                style={`left: ${position(snapshot.endTick / snapshot.headerRate)}px`}
            ></div>
        {/if}
        {#if snapshot && viewport}
            <div
                class="timeline-playhead"
                data-region="playhead"
                style={`left: ${position(snapshot.playhead / snapshot.headerRate)}px`}
                aria-hidden="true"
            >
                <span class="timeline-playhead-head"></span>
                <span class="timeline-playhead-line" data-region="playhead-line"></span>
            </div>
        {/if}
        </div>
    </div>
</div>
