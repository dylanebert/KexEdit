/** Pin mode's dedicated worker: one `solveOptimize` call per message, mirroring
 *  `geofit-worker.ts` — a single closed-form-shaped call (no probe search, no pool), so this
 *  worker takes exactly one message and replies exactly once. */

import { type OptimizeOpts, type OptimizeResult, solveOptimize } from "./optimize";

export interface OptimizeRequest {
    opts: OptimizeOpts;
}

export type OptimizeReply =
    | { kind: "done"; result: OptimizeResult }
    | { kind: "failed"; message: string };

const scope = globalThis as unknown as {
    onmessage: ((event: MessageEvent<OptimizeRequest>) => void) | null;
    postMessage(message: OptimizeReply): void;
};

scope.onmessage = (event: MessageEvent<OptimizeRequest>): void => {
    const { opts } = event.data;
    try {
        const result = solveOptimize(opts);
        scope.postMessage({ kind: "done", result });
    } catch (error) {
        scope.postMessage({ kind: "failed", message: String(error) });
    }
};
