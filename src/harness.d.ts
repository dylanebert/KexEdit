declare global {
    type HarnessCheck = { name: string; ok: boolean; detail?: string; data?: Record<string, number> };
    type HarnessVerdict = { ok: boolean; checks?: HarnessCheck[]; [extra: string]: unknown };
    type HarnessTarget = {
        readonly ready: boolean;
        run?: (options?: Record<string, unknown>) => Promise<HarnessVerdict>;
    };
    interface Window {
        __harness?: HarnessTarget;
    }
}

export {};
