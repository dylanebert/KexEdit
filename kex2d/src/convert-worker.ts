/** The conversion pool's worker: one flat-family probe per message.
 *
 * A probe is `refine.solve` and nothing else — the worker owns no policy, holds no refinement
 * state, and never decides anything. The refinement loop stays on the caller's thread
 * (`convert.ts`), which is why an answer can't depend on how many of these are running.
 *
 * The bake arrives once, in `init`; every later message is a knot set. That keeps the per-probe
 * traffic to one small array out and one `PolishResult` back. */

import type { PolishResult } from "./polish";
import { type RefineBake, solve } from "./refine";
import type { Entry } from "./section";

/** the immutable half of a conversion: what every probe of this section solves against. */
export interface ConvertInit {
    kind: "init";
    bake: RefineBake;
    entry: Entry;
    ds: number;
    /** playback frames to record per probe — 0 on the production path. */
    snapshots: number;
}

export interface ConvertProbe {
    kind: "probe";
    knots: number[];
}

export type ConvertRequest = ConvertInit | ConvertProbe;

export type ConvertReply =
    | { kind: "done"; result: PolishResult }
    | { kind: "failed"; message: string };

/** The dedicated-worker globals, named without depending on a `webworker` lib being in scope
 *  (this file type-checks under the app's `DOM` lib, where `self.postMessage` is the window
 *  form). Nothing else here touches the global. */
const scope = globalThis as unknown as {
    onmessage: ((event: MessageEvent<ConvertRequest>) => void) | null;
    postMessage(message: ConvertReply): void;
};

let context: ConvertInit | null = null;

scope.onmessage = (event: MessageEvent<ConvertRequest>): void => {
    const message = event.data;
    if (message.kind === "init") {
        context = message;
        return;
    }
    if (!context) {
        scope.postMessage({ kind: "failed", message: "probe before init" });
        return;
    }
    try {
        const result = solve(
            context.bake,
            context.entry,
            context.ds,
            message.knots,
            context.snapshots,
        );
        scope.postMessage({ kind: "done", result });
    } catch (error) {
        scope.postMessage({ kind: "failed", message: String(error) });
    }
};
