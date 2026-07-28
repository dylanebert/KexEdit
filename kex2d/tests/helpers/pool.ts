/** Fake conversion workers, for the pool failure paths a real worker won't produce on demand.
 *
 * `convert.ts` spawns through the global `Worker`, so a test swaps that global for the duration
 * of a conversion and the real pool — hire, dispatch, retire, prefetch, dispose — runs
 * unchanged around it. Everything else stays real: the refinement loop, the probe body, the
 * ask order. Only the one failure being covered is injected.
 */

import type { ConvertInit, ConvertReply, ConvertRequest } from "../../src/convert-worker";
import { solve } from "../../src/refine";

type WorkerCtor = new (url: string | URL, opts?: WorkerOptions) => unknown;

/** Run `body` with the conversion pool spawning `ctor` instead of a real worker. Restores the
 *  global whatever happens — a leaked fake would silently fake every later conversion. */
export async function withWorker<T>(ctor: WorkerCtor, body: () => Promise<T>): Promise<T> {
    const scope = globalThis as unknown as Record<string, unknown>;
    const real = scope.Worker;
    scope.Worker = ctor;
    try {
        return await body();
    } finally {
        scope.Worker = real;
    }
}

/** The pool's side of a worker: the two handlers it assigns and the two calls it makes. */
abstract class Fake {
    onmessage: ((event: MessageEvent<ConvertReply>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    protected init: ConvertInit | null = null;

    postMessage(request: ConvertRequest): void {
        if (request.kind === "init") {
            this.init = request;
            return;
        }
        queueMicrotask(() => this.probe(request.knots));
    }

    terminate(): void {}

    protected reply(message: ConvertReply): void {
        this.onmessage?.({ data: message } as MessageEvent<ConvertReply>);
    }

    protected abstract probe(knots: number[]): void;
}

/** Answer every probe with the REAL solve, except the first one that REMOVES a key — the
 *  opening candidate of the first prune round — which comes back with a NaN residual profile,
 *  the reading a solver failure produces. The round's remaining candidates are already
 *  prefetched by then, so this is the abandoned-tail path as well as the diverged one.
 *
 *  Shared across the instances the pool hires, because a prune round is fanned out: the "first
 *  shrinking ask" is a property of the ask sequence, not of one worker. */
export function divergingPool(): WorkerCtor {
    let widest = 0;
    let poisoned = false;
    return class extends Fake {
        protected probe(knots: number[]): void {
            const init = this.init;
            if (!init) {
                this.reply({ kind: "failed", message: "probe before init" });
                return;
            }
            const result = solve(init.bake, init.entry, init.ds, knots, init.snapshots);
            const shrank = knots.length < widest;
            widest = Math.max(widest, knots.length);
            if (shrank && !poisoned) {
                poisoned = true;
                // both readings, the way a real divergence produces them: the profile the loop
                // guards on, and the max taken over it.
                result.deviations = new Float64Array(result.deviations.length).fill(Number.NaN);
                result.deviation = Number.NaN;
            }
            this.reply({ kind: "done", result });
        }
    };
}

/** Die on the first probe — the worker that stops existing mid-solve (an OOM, a host kill),
 *  which reaches the pool as an `error` event rather than a `failed` reply. */
export function dyingPool(): WorkerCtor {
    return class extends Fake {
        protected probe(): void {
            this.onerror?.({ message: "worker died" } as ErrorEvent);
        }
    };
}
