/** Async, cancellable geo→force conversion — the façade an invoked tool calls.
 *
 * `refine` is seconds of solving (the corpus worst is ~9 s in bun, ~26 s in a browser), so
 * running it in-process freezes the page. Here the refinement loop keeps running on the caller's
 * thread — it is sub-millisecond, and it is the part that decides anything — while every
 * `polish` probe is handed to a pool of workers.
 *
 * **Determinism under concurrency.** The loop (`refine.plan`) asks for probes one at a time and
 * consumes answers strictly in ask order; the pool only ever *prefetches* the asks it has been
 * told are coming (a prune round's remaining candidates, which are fixed the moment the round
 * starts). So completion order is unobservable, and so is the pool size: the answers reach the
 * loop in the same order, carrying the same numbers, as an in-process `refine`. Pool size and
 * order invariance are oracled in `tests/convert.test.ts` against the frozen golden.
 *
 * **Cancellation is termination.** `signal` aborts by terminating the workers rather than
 * waiting out an in-flight probe (400 ms+ on a big section). The façade is pure — it writes no
 * document state — so a cancelled conversion needs no rollback, just a dead pool. */

import type { ConvertInit, ConvertReply, ConvertRequest } from "./convert-worker";
import type { PolishResult } from "./polish";
import {
    type ConvertPhase,
    type ConvertResult,
    narrow,
    plan,
    type RefineBake,
    type RefineResult,
} from "./refine";
import type { Entry } from "./section";

/** The `new URL(…, import.meta.url)` has to sit inside the `new Worker(…)` call: that exact
 *  shape is what the bundler rewrites, and a hoisted URL silently ships a dev-only worker. */
const spawn = (): Worker =>
    new Worker(new URL("./convert-worker.ts", import.meta.url), { type: "module" });

/** Every worker this module has spawned and not yet called `terminate()` on — the pool's own
 *  reference count, not proof of what the OS did with the thread. The cancellation contract is
 *  that an aborted conversion releases all of them, which is only checkable if the count is
 *  observable: `tests/convert.test.ts` reads it live mid-solve and again after the abort. */
const LIVE = new Set<Worker>();

export function liveWorkers(): number {
    return LIVE.size;
}

export interface ConvertProgress {
    phase: ConvertPhase;
    /** keys in the probe just answered. */
    keys: number;
    /** probes finished so far. There is deliberately no total: the refinement discovers how many
     *  it needs as it goes, so any denominator would be invented. */
    probes: number;
}

export interface ConvertOpts {
    signal?: AbortSignal;
    onProgress?: (progress: ConvertProgress) => void;
    /** pool size override — a finite count >= 1, or it throws. Default is
     *  `hardwareConcurrency − 1` (leave the caller's thread a core), floor 1; workers spawn on
     *  demand, so a conversion never runs more than its own fan-out — the serial split phase
     *  uses exactly one. */
    workers?: number;
}

interface Job {
    knots: readonly number[];
    resolve: (result: PolishResult) => void;
    reject: (reason: unknown) => void;
}

interface Pool {
    run: (knots: readonly number[]) => Promise<PolishResult>;
    dispose: (reason: unknown) => void;
}

function poolSize(workers: number | undefined): number {
    if (workers !== undefined) {
        // `Math.floor(NaN)` is NaN and `owned.size >= NaN` is always false, so an unvalidated
        // override would quietly uncap the pool instead of failing.
        if (!(workers >= 1) || !Number.isFinite(workers))
            throw new Error(`convert: workers must be a finite number >= 1, got ${workers}`);
        return Math.floor(workers);
    }
    const cores = typeof navigator === "undefined" ? 0 : navigator.hardwareConcurrency;
    return Math.max(1, (cores || 2) - 1);
}

function pool(init: Omit<ConvertInit, "kind">, size: number): Pool {
    const idle: Worker[] = [];
    const owned = new Set<Worker>();
    const inflight = new Map<Worker, Job>();
    const queue: Job[] = [];
    let closed = false;
    let dead: unknown = null;

    const retire = (worker: Worker): void => {
        worker.onmessage = null;
        worker.onerror = null;
        worker.terminate();
        owned.delete(worker);
        LIVE.delete(worker);
    };

    const finish = (worker: Worker): Job | undefined => {
        const job = inflight.get(worker);
        inflight.delete(worker);
        worker.onmessage = null;
        worker.onerror = null;
        return job;
    };

    const dispatch = (worker: Worker, job: Job): void => {
        inflight.set(worker, job);
        worker.onmessage = (event: MessageEvent<ConvertReply>): void => {
            if (finish(worker) !== job) return;
            idle.push(worker);
            if (event.data.kind === "done") job.resolve(event.data.result);
            else job.reject(new Error(`convert worker: ${event.data.message}`));
            pump();
        };
        // a worker that dies mid-probe is not reusable: fail its job and drop it. Its slot is
        // freed, so the next queued job spawns a replacement rather than waiting on a corpse.
        worker.onerror = (event: ErrorEvent): void => {
            if (finish(worker) !== job) return;
            retire(worker);
            job.reject(new Error(`convert worker: ${event.message || "terminated"}`));
            pump();
        };
        worker.postMessage({ kind: "probe", knots: [...job.knots] } satisfies ConvertRequest);
    };

    const hire = (): Worker | null => {
        const free = idle.pop();
        if (free) return free;
        if (owned.size >= size) return null;
        const worker = spawn();
        owned.add(worker);
        LIVE.add(worker);
        worker.postMessage({ kind: "init", ...init } satisfies ConvertRequest);
        return worker;
    };

    function pump(): void {
        while (queue.length > 0) {
            const worker = hire();
            if (!worker) return;
            const job = queue.shift();
            if (!job) return;
            dispatch(worker, job);
        }
    }

    return {
        run: (knots) =>
            new Promise<PolishResult>((resolve, reject) => {
                if (closed) {
                    reject(dead);
                    return;
                }
                queue.push({ knots, resolve, reject });
                pump();
            }),
        dispose: (reason) => {
            if (closed) return;
            closed = true;
            dead = reason;
            for (const worker of [...owned]) {
                const job = inflight.get(worker);
                inflight.delete(worker);
                retire(worker);
                job?.reject(reason);
            }
            idle.length = 0;
            for (const job of queue.splice(0)) job.reject(reason);
        },
    };
}

async function drive(
    bake: RefineBake,
    entry: Entry,
    ds: number,
    opts: ConvertOpts,
    playback: boolean,
): Promise<RefineResult> {
    const { signal } = opts;
    signal?.throwIfAborted();
    const workers = pool(
        { bake: pack(bake), entry, ds, snapshots: playback ? 1 : 0 },
        poolSize(opts.workers),
    );
    const abort = (): void => workers.dispose(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    try {
        const loop = plan({ bake, entry, ds, playback });
        // the current round's answers, keyed by knot set. Rebuilt whenever an ask arrives that
        // wasn't prefetched, so it holds at most one round.
        let round = new Map<string, Promise<PolishResult>>();
        let step = loop.next();
        while (!step.done) {
            const ask = step.value;
            const key = String(ask.knots);
            if (!round.has(key)) {
                round = new Map();
                for (const knots of [ask.knots, ...ask.ahead]) {
                    const answer = workers.run(knots);
                    // a round short-circuits on an unreadable candidate and an abort drops the
                    // rest; neither is an unhandled rejection.
                    answer.catch(() => {});
                    round.set(String(knots), answer);
                }
            }
            const answer = round.get(key);
            if (!answer) throw new Error("convert: unplanned probe");
            round.delete(key);
            const result = await answer;
            signal?.throwIfAborted();
            opts.onProgress?.({ phase: ask.phase, keys: ask.knots.length, probes: ask.count });
            step = loop.next(result);
        }
        return step.value;
    } finally {
        signal?.removeEventListener("abort", abort);
        workers.dispose(new Error("convert: pool closed"));
    }
}

/** The bake as it crosses the boundary: exactly the six arrays a probe reads, projected out of
 *  whatever the caller passed (a `SectionResult` also carries an exit state and node offsets the
 *  solve never touches, and they would clone too). Sent once per worker, not once per probe. */
function pack(bake: RefineBake): RefineBake {
    return {
        posX: bake.posX,
        posY: bake.posY,
        theta: bake.theta,
        ds: bake.ds,
        edges: bake.edges,
        fN: bake.fN,
    };
}

/** Convert a geo bake into an authored force section, off the main thread.
 *
 * Resolves with the narrow `ConvertResult` — the structured-clone-friendly payload an editor
 * command consumes, bit-identical to `narrow(refine({…, playback: false}))`. Rejects with
 * `signal.reason` if cancelled.
 *
 * @example
 * const controller = new AbortController();
 * const result = await convert(bake, entry, 0.5, {
 *     signal: controller.signal,
 *     onProgress: ({ phase, probes }) => status(`${phase} · ${probes} probes`),
 * });
 */
export async function convert(
    bake: RefineBake,
    entry: Entry,
    ds: number,
    opts: ConvertOpts = {},
): Promise<ConvertResult> {
    return narrow(await drive(bake, entry, ds, opts, false));
}

/** The same conversion with the fit lab's playback freight kept: every decision's event and one
 * solver frame per probe. Same pool, same answer — the recording is pure observation
 * (`refine.test.ts` pins both halves), it just costs the freight. The labs are the only caller;
 * an editor command wants `convert`. */
export async function convertPlayback(
    bake: RefineBake,
    entry: Entry,
    ds: number,
    opts: ConvertOpts = {},
): Promise<RefineResult> {
    return drive(bake, entry, ds, opts, true);
}
