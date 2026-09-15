<script lang="ts">
    import { Pause, Play, Repeat2 } from "@lucide/svelte";
    import { transport, type TransportSnapshot } from "./path/view";

    type TimelineTick = { seconds: number; major: boolean };

    let snapshot = $state<TransportSnapshot | null>(transport.snapshot());
    let draggingRuler = $state(false);

    $effect(() => transport.subscribe((next) => (snapshot = next)));

    const format = (value: number): string => value.toFixed(2).replace(/\.00$/, "");
    const percent = (value: number, length: number): number => (length > 0 ? (value / length) * 100 : 0);

    function timelineTicks(duration: number): TimelineTick[] {
        if (!(Number.isFinite(duration) && duration > 0)) return [{ seconds: 0, major: true }];

        const target = duration / 8;
        const power = 10 ** Math.floor(Math.log10(target));
        const candidates = [power, power * 2, power * 5, power * 10];
        const majorStep = candidates.find((step) => step >= target) ?? power * 10;
        const ticks: TimelineTick[] = [];
        const epsilon = majorStep * 1e-9;

        for (let major = 0; major * majorStep <= duration + epsilon; major += 1) {
            const majorSeconds = major * majorStep;
            ticks.push({ seconds: majorSeconds, major: true });
            for (let subdivision = 1; subdivision < 5; subdivision += 1) {
                const seconds = majorSeconds + (majorStep * subdivision) / 5;
                if (seconds < duration - epsilon) ticks.push({ seconds, major: false });
            }
        }
        return ticks;
    }

    function scrubAt(event: PointerEvent): void {
        if (!snapshot) return;
        const ruler = event.currentTarget as HTMLElement;
        const bounds = ruler.getBoundingClientRect();
        const fraction = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
        transport.scrub(fraction * snapshot.length);
    }

    function beginScrub(event: PointerEvent): void {
        draggingRuler = true;
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        scrubAt(event);
    }

    function moveScrub(event: PointerEvent): void {
        if (draggingRuler) scrubAt(event);
    }

    function endScrub(): void {
        draggingRuler = false;
    }

    function handleKeydown(event: KeyboardEvent): void {
        const target = event.target as HTMLElement | null;
        if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
        if (!snapshot) return;
        if (event.key === " ") {
            event.preventDefault();
            transport.togglePlaying();
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
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="transport" data-region="transport" data-playing={snapshot?.playing ?? false}>
    <div class="transport-controls" data-region="transport-controls">
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
            <button
                class:transport-toggle-active={snapshot?.loop ?? false}
                class="transport-button transport-loop"
                type="button"
                data-action="loop"
                aria-pressed={snapshot?.loop ?? false}
                aria-label="Loop"
                title="Loop"
                onclick={() => transport.setLoop(!(snapshot?.loop ?? false))}
            >
                <Repeat2 size={15} strokeWidth={2} />
            </button>
        </div>
        <output class="transport-readout" data-readout="time" aria-label="Time">
            {snapshot ? `${format(snapshot.playhead / snapshot.headerRate)} / ${format(snapshot.length / snapshot.headerRate)} s` : "0 / 0 s"}
        </output>
    </div>

    <div class="timeline-surface" data-region="timeline-surface">
        <div
            class="timeline-ruler"
            data-region="ruler"
            role="slider"
            tabindex="0"
            aria-label="Timeline playhead"
            aria-valuemin="0"
            aria-valuemax={snapshot?.length ?? 0}
            aria-valuenow={snapshot?.playhead ?? 0}
            onpointerdown={beginScrub}
            onpointermove={moveScrub}
            onpointerup={endScrub}
            onpointercancel={endScrub}
        >
            {#if snapshot}
                <div class="timeline-ticks" aria-hidden="true">
                    {#each timelineTicks(snapshot.length / snapshot.headerRate) as tick (tick.seconds)}
                        <span
                            class="timeline-tick"
                            data-tick-level={tick.major ? "major" : "minor"}
                            data-tick-seconds={tick.seconds}
                            style={`left: ${percent(tick.seconds, snapshot.length / snapshot.headerRate)}%`}
                        >
                            {#if tick.major}
                                <span class="timeline-tick-label">{format(tick.seconds)}</span>
                            {/if}
                        </span>
                    {/each}
                </div>
            {/if}
        </div>

        <div class="timeline-lanes" data-region="reserved-lanes" aria-label="Reserved timeline lanes">
            {#each [0, 1, 2, 3] as lane}
                <div class="timeline-lane" data-region="timeline-lane" data-lane={lane}></div>
            {/each}
            {#if snapshot}
                <div class="timeline-lanes-grid" aria-hidden="true">
                    {#each timelineTicks(snapshot.length / snapshot.headerRate) as tick (tick.seconds)}
                        <span
                            class="timeline-grid-line"
                            data-tick-level={tick.major ? "major" : "minor"}
                            style={`left: ${percent(tick.seconds, snapshot.length / snapshot.headerRate)}%`}
                        ></span>
                    {/each}
                </div>
            {/if}
        </div>

        {#if snapshot}
            <div
                class="timeline-state timeline-state-solved"
                data-state="solved"
                style={`width: ${percent(snapshot.endReason === "complete" ? snapshot.length : snapshot.endTick, snapshot.length)}%`}
            ></div>
            {#if snapshot.endReason !== "complete"}
                <div
                    class="timeline-state timeline-state-unsolved"
                    data-state="unsolved"
                    data-region="dead-tail"
                    style={`left: ${percent(snapshot.endTick, snapshot.length)}%; width: ${100 - percent(snapshot.endTick, snapshot.length)}%`}
                ></div>
                <div
                    class="timeline-state timeline-state-offending"
                    data-state="offending"
                    data-region="end-mark"
                    style={`left: ${percent(snapshot.endTick, snapshot.length)}%`}
                ></div>
            {/if}
            <div
                class="timeline-playhead"
                data-region="playhead"
                style={`left: ${percent(snapshot.playhead, snapshot.length)}%`}
                aria-hidden="true"
            >
                <span class="timeline-playhead-head"></span>
                <span class="timeline-playhead-line" data-region="playhead-line"></span>
            </div>
        {/if}
    </div>
</div>
