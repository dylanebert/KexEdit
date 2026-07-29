/** One-shot async wrapper around `geofit` (`geofit.ts`), off the main thread.
 *
 * geofit's own corpus worst is ~0.2 s but the stress-trio worst measured 2.03 s
 * (`kex2d-forcegeo` stage 2's lab timing) — past the ~1 s bar the spec sets for running inline,
 * so the invoking command wraps it in a worker. This mirrors `convert.ts`'s async façade minus
 * everything that one needed for `refine`'s multi-probe search: geofit is ONE closed-form call,
 * so there is no pool and no probe fan-out. There is also no progress to report — the kernel has
 * no internal phase to surface (the spec is explicit: don't add progress plumbing into the
 * kernel for it) — so the modal it drives shows an indeterminate wait instead of a probe count.
 *
 * **Cancellation is `Worker.terminate()`.** The façade is pure — it writes no document state —
 * so an aborted fit needs no rollback, just a dead worker. */

import type { GeofitBake, GeofitParams, GeofitResult } from "./geofit";
import type { GeofitReply, GeofitRequest } from "./geofit-worker";

/** The `new URL(…, import.meta.url)` has to sit inside the `new Worker(…)` call: that exact
 *  shape is what the bundler rewrites, and a hoisted URL silently ships a dev-only worker
 *  (`convert.ts`'s own note — the same bundling trap, the same fix). */
const spawn = (): Worker =>
    new Worker(new URL("./geofit-worker.ts", import.meta.url), { type: "module" });

/** every worker this module has spawned and not yet terminated — mirrors `convert.ts`'s `LIVE`,
 *  so a cancelled fit's teardown is independently observable (`tests/forcegeo.test.ts`). */
const LIVE = new Set<Worker>();

export function liveFitWorkers(): number {
    return LIVE.size;
}

export interface GeofitOpts {
    signal?: AbortSignal;
    /** the kernel's own parameters — budgets plus the sampling the LANDED section will bake at
     *  (`geofit.GeofitParams`). The invoking command fills the sampling from the live track;
     *  a bare call takes the kernel's mirrored defaults. */
    params?: GeofitParams;
}

/** Fit a dense force-section bake into a sparse geo node chain, off the main thread.
 *
 * Resolves with `geofit`'s own `GeofitResult`, bit-identical to calling it in-process. Rejects
 * with `signal.reason` if cancelled, or a wrapped message on a worker failure. */
export function runGeofit(
    bake: GeofitBake,
    v0: number,
    opts: GeofitOpts = {},
): Promise<GeofitResult> {
    const { signal, params } = opts;
    signal?.throwIfAborted();
    return new Promise<GeofitResult>((resolve, reject) => {
        const worker = spawn();
        LIVE.add(worker);
        const settle = (): void => {
            worker.onmessage = null;
            worker.onerror = null;
            worker.terminate();
            LIVE.delete(worker);
        };
        const abort = (): void => {
            settle();
            reject(signal?.reason);
        };
        signal?.addEventListener("abort", abort, { once: true });
        worker.onmessage = (event: MessageEvent<GeofitReply>): void => {
            signal?.removeEventListener("abort", abort);
            settle();
            if (event.data.kind === "done") resolve(event.data.result);
            else reject(new Error(`geofit worker: ${event.data.message}`));
        };
        worker.onerror = (event: ErrorEvent): void => {
            signal?.removeEventListener("abort", abort);
            settle();
            reject(new Error(`geofit worker: ${event.message || "terminated"}`));
        };
        worker.postMessage({ bake, v0, params } satisfies GeofitRequest);
    });
}
