<script lang="ts">
    import { Pause, Play, Repeat2 } from "@lucide/svelte";
    import { transport, type TransportSnapshot } from "./path/view";

    let snapshot = $state<TransportSnapshot | null>(transport.snapshot());
    let draftRate = $state("1");
    let editingRate = $state(false);
    let draggingRuler = $state(false);
    let draggingRate = $state(false);
    let dragRateStartX = 0;
    let dragRateStartValue = 1;

    $effect(() => transport.subscribe((next) => (snapshot = next)));
    $effect(() => {
        if (!editingRate && !draggingRate && snapshot) draftRate = String(snapshot.rate);
    });

    const format = (value: number): string => value.toFixed(2).replace(/\.00$/, "");
    const percent = (value: number, length: number): number => (length > 0 ? (value / length) * 100 : 0);

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

    function commitRate(): void {
        const value = Number(draftRate);
        if (Number.isFinite(value) && value >= 0) transport.setRate(value);
        else if (snapshot) draftRate = String(snapshot.rate);
        editingRate = false;
        draggingRate = false;
    }

    function rateKeydown(event: KeyboardEvent): void {
        if (event.key === "Enter") {
            event.preventDefault();
            commitRate();
        } else if (event.key === "Escape") {
            event.preventDefault();
            if (snapshot) draftRate = String(snapshot.rate);
            editingRate = false;
            draggingRate = false;
        }
    }

    function beginRateDrag(event: PointerEvent): void {
        if (!snapshot) return;
        event.preventDefault();
        draggingRate = true;
        editingRate = true;
        dragRateStartX = event.clientX;
        dragRateStartValue = snapshot.rate;
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    }

    function moveRateDrag(event: PointerEvent): void {
        if (!draggingRate) return;
        const value = Math.max(0, dragRateStartValue + (event.clientX - dragRateStartX) / 40);
        draftRate = value.toFixed(2).replace(/\.00$/, "");
    }

    function endRateDrag(): void {
        if (draggingRate) commitRate();
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
        <button
            class="transport-button transport-play"
            type="button"
            data-action="play-pause"
            aria-label={snapshot?.playing ? "Pause" : "Play"}
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
        <div class="transport-rate" data-field="rate">
            <label
                class="rate-label"
                for="transport-rate"
                title="Drag to change rate"
                onpointerdown={beginRateDrag}
                onpointermove={moveRateDrag}
                onpointerup={endRateDrag}
                onpointercancel={endRateDrag}
            >rate</label>
            <input
                id="transport-rate"
                class="rate-value"
                type="text"
                inputmode="decimal"
                aria-label="Playback rate"
                value={draftRate}
                onfocus={() => (editingRate = true)}
                oninput={(event) => (draftRate = (event.currentTarget as HTMLInputElement).value)}
                onkeydown={rateKeydown}
                onblur={commitRate}
            />
            <span class="rate-unit">×</span>
        </div>
        <output class="transport-readout" data-readout="time" aria-label="Time">
            {snapshot ? `${format(snapshot.playhead / snapshot.headerRate)} / ${format(snapshot.length / snapshot.headerRate)} s` : "0 / 0 s"}
        </output>
    </div>

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
            ></div>
            <div class="timeline-label timeline-label-start">0 s</div>
            <div class="timeline-label timeline-label-end">{format(snapshot.length / snapshot.headerRate)} s</div>
        {/if}
    </div>

    <div class="timeline-lanes" data-region="reserved-lanes" aria-label="Reserved timeline lanes">
        <span>reserved lanes</span>
    </div>
</div>
