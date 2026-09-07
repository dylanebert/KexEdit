/** The force→geo fit's dedicated worker: one `geofit` call and nothing else.
 *
 * Unlike `convert-worker.ts` (a pool worker taking one `polish` probe per message, many
 * messages per conversion), a fit is a single closed-form call — split-then-prune, no search —
 * so this worker takes exactly one message and replies exactly once. No `init`/`probe` split, no
 * pool, no per-probe traffic to minimize. */

import { type GeofitBake, geofit, type GeofitParams, type GeofitResult } from "./geofit";

export interface GeofitRequest {
    bake: GeofitBake;
    v0: number;
    params?: GeofitParams;
}

export type GeofitReply =
    | { kind: "done"; result: GeofitResult }
    | { kind: "failed"; message: string };

/** the dedicated-worker globals, named without depending on a `webworker` lib being in scope
 *  (mirrors `convert-worker.ts`). */
const scope = globalThis as unknown as {
    onmessage: ((event: MessageEvent<GeofitRequest>) => void) | null;
    postMessage(message: GeofitReply): void;
};

scope.onmessage = (event: MessageEvent<GeofitRequest>): void => {
    const { bake, v0, params } = event.data;
    try {
        const result = geofit(bake, v0, params);
        scope.postMessage({ kind: "done", result });
    } catch (error) {
        scope.postMessage({ kind: "failed", message: String(error) });
    }
};
