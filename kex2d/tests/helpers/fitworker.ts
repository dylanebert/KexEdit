/** Fake `geofit` workers, for the failure paths a real worker won't produce on demand.
 *
 * Mirrors `tests/helpers/pool.ts`: `geofit-async.ts` spawns through the global `Worker`, so a
 * test swaps that global for the duration of a fit and the real façade — spawn, post, await,
 * terminate — runs unchanged around it. Only the one failure being covered is injected.
 */

import { geofit } from "../../src/geofit";
import type { GeofitReply, GeofitRequest } from "../../src/geofit-worker";

type WorkerCtor = new (url: string | URL, opts?: WorkerOptions) => unknown;

/** Run `body` with the fit façade spawning `ctor` instead of a real worker. Restores the global
 *  whatever happens — a leaked fake would silently fake every later fit. */
export async function withFitWorker<T>(ctor: WorkerCtor, body: () => Promise<T>): Promise<T> {
    const scope = globalThis as unknown as Record<string, unknown>;
    const real = scope.Worker;
    scope.Worker = ctor;
    try {
        return await body();
    } finally {
        scope.Worker = real;
    }
}

/** The façade's side of a worker: the two handlers it assigns and the one call it makes. */
abstract class Fake {
    onmessage: ((event: MessageEvent<GeofitReply>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;

    postMessage(request: GeofitRequest): void {
        queueMicrotask(() => this.run(request));
    }

    terminate(): void {}

    protected reply(message: GeofitReply): void {
        this.onmessage?.({ data: message } as MessageEvent<GeofitReply>);
    }

    protected abstract run(request: GeofitRequest): void;
}

/** Die on the message — the worker that stops existing mid-fit (an OOM, a host kill), which
 *  reaches the façade as an `error` event rather than a `failed` reply. */
export function dyingFit(): WorkerCtor {
    return class extends Fake {
        protected run(): void {
            this.onerror?.({ message: "worker died" } as ErrorEvent);
        }
    };
}

/** Answer with the REAL fit, but stamp its outcome `"diverged"` — the reading a genuine
 *  divergence produces (`geofit.ts`'s own NaN-deviation guard), without needing a bake that
 *  actually drives the kernel there. Exercises the command's "resolves but writes nothing" path. */
export function divergingFit(): WorkerCtor {
    return class extends Fake {
        protected run(request: GeofitRequest): void {
            const result = geofit(request.bake, request.v0, request.params);
            result.outcome = "diverged";
            result.deviation = Number.NaN;
            this.reply({ kind: "done", result });
        }
    };
}
