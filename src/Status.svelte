<script lang="ts">
    import { AlertTriangle } from "@lucide/svelte";
    import { transport, type TransportSnapshot } from "./path/view";

    let snapshot = $state<TransportSnapshot | null>(transport.snapshot());
    $effect(() => transport.subscribe((next) => (snapshot = next)));

    const format = (value: number): string => value.toFixed(2).replace(/\.00$/, "");
</script>

<footer class="status-line" data-region="status" aria-label="Status">
    <span class="status-ready">Ready</span>
    <span class="diagnostics" data-region="diagnostics">
        <span class="diagnostic-badge" data-diagnostic-badge>{snapshot?.refusal ? 1 : 0}</span>
        {#if snapshot?.refusal}
            <button
                class="diagnostic-entry"
                type="button"
                data-diagnostic-entry
                aria-label={`Go to ${snapshot.refusal.reason} at tick ${snapshot.refusal.tick}`}
                title="Go to the last solved tick"
                onclick={() => transport.scrub(snapshot?.endTick ?? 0)}
            >
                <AlertTriangle size={13} strokeWidth={2} />
                <span>
                    {snapshot.refusal.reason} at {format(snapshot.refusal.tick / (snapshot.headerRate || 1))} s:
                    {snapshot.refusal.lane} need {format(snapshot.refusal.need)}, have {format(snapshot.refusal.have)}
                </span>
            </button>
        {/if}
    </span>
</footer>
