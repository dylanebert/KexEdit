/** One-shot async wrapper around `solveOptimize` (`optimize.ts`), off the main thread —
 *  `geofit-async.ts`'s shape exactly: one closed-form-shaped call, no pool, no probe fan-out,
 *  no internal phase to report, so cancellation is `Worker.terminate()` and the modal (if any)
 *  shows an indeterminate wait. The façade writes no document state, so an aborted solve needs
 *  no rollback, just a dead worker. */

import type { OptimizeOpts, OptimizeResult } from "./optimize";
import type { OptimizeReply, OptimizeRequest } from "./optimize-worker";

const spawn = (): Worker =>
    new Worker(new URL("./optimize-worker.ts", import.meta.url), { type: "module" });

const LIVE = new Set<Worker>();

export function liveOptimizeWorkers(): number {
    return LIVE.size;
}

export interface OptimizeRunOpts {
    signal?: AbortSignal;
}

/** Solve the masked exit-restore off the main thread. Resolves with `solveOptimize`'s own
 *  `OptimizeResult`, bit-identical to calling it in-process. Rejects with `signal.reason` if
 *  cancelled, or a wrapped message on a worker failure. */
export function runOptimize(
    opts: OptimizeOpts,
    run: OptimizeRunOpts = {},
): Promise<OptimizeResult> {
    const { signal } = run;
    signal?.throwIfAborted();
    return new Promise<OptimizeResult>((resolve, reject) => {
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
        worker.onmessage = (event: MessageEvent<OptimizeReply>): void => {
            signal?.removeEventListener("abort", abort);
            settle();
            if (event.data.kind === "done") resolve(event.data.result);
            else reject(new Error(`optimize worker: ${event.data.message}`));
        };
        worker.onerror = (event: ErrorEvent): void => {
            signal?.removeEventListener("abort", abort);
            settle();
            reject(new Error(`optimize worker: ${event.message || "terminated"}`));
        };
        worker.postMessage({ opts } satisfies OptimizeRequest);
    });
}
