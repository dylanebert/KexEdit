import { defineConfig } from "@playwright/test";

// Layered timeouts so a stuck flow fails in seconds, never hangs (a missing locator, a blank canvas).
// The orchestrator adds a spawn ceiling above these as a last-resort backstop (playwright.ts).
//
// Every flow owns its page and its screenshot names and shares nothing but the dev server, so the
// suite runs `fullyParallel` — a worker can pick up any test from any of the staged flow files
// (the staged set is `capture.ts`'s `stage.files`, matched by the `*.pw.ts` glob below), and
// without it Playwright would serialize the tests within whichever file a worker is given, leaving
// the rest idle. `fullyParallel` already schedules at the test level, so the per-file split below
// is an organizational move (staging, file size), not a new source of concurrency.
//   KEX_WORKERS=n   → worker count (1 to serialize, e.g. when bisecting a cross-test suspicion)
//   KEX_HEADED=1    → drive the host's visible Chrome instead of headless
//
// `capture.ts` validates both and forwards them explicitly; these fallbacks (and their guards) are
// for a direct `playwright test --config capture.pw.config.ts` run. This file is staged to the
// Windows host STANDALONE (`wsl.ts`) alongside `flow.ts` + every `*.pw.ts` flow file, so it can
// import nothing: `UsageError`, `intEnv` and `boolEnv` below are MIRRORED VERBATIM from
// `harness/args.ts`, and `tests/harness.test.ts` pins them character-identical to it — a drifting
// copy is a guard that only LOOKS enforced.
class UsageError extends Error {}

function intEnv(
    env: Record<string, string | undefined>,
    name: string,
    fallback: number,
    min: number,
    max: number,
): number {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || n < min || n > max)
        throw new UsageError(
            `${name} must be an integer in [${min}, ${max}] (got ${JSON.stringify(raw)})`,
        );
    return n;
}

function boolEnv(env: Record<string, string | undefined>, name: string): boolean {
    const raw = env[name];
    if (raw === undefined) return false;
    if (raw !== "0" && raw !== "1")
        throw new UsageError(`${name} must be 0 or 1 (got ${JSON.stringify(raw)})`);
    return raw === "1";
}

const workers = intEnv(process.env, "KEX_WORKERS", 4, 1, 64);
const headed = boolEnv(process.env, "KEX_HEADED");

export default defineConfig({
    testDir: ".",
    testMatch: "*.pw.ts",
    fullyParallel: true,
    retries: 0,
    workers,
    reporter: [["list"]],
    timeout: 60_000,
    // A leftover `test.only` would silently reduce the suite to one flow while every gate still reads
    // green — the same class of dishonesty the collected-vs-executed count oracle closes in
    // `capture.ts`. Fail the run instead.
    forbidOnly: true,
    // A wedge backstop, not a budget: it must clear the whole suite with room to grow, or it silently
    // truncates the run (at 120s it killed the last test and still reported the rest green). The
    // worst case is serial-per-worker: the collected suite × the 60s per-test timeout ÷ the worker
    // count, so this clears ~28 flows at the default 4 (27 today, split across the four staged flow
    // files — `kex2d-harness.md` "Growth"; `fullyParallel` already schedules every flow at the test
    // level regardless of which file it lives in, so the split changes file size, not this budget).
    // `capture.ts`'s spawn ceiling (480s) sits above this one.
    globalTimeout: 420_000,

    expect: { timeout: 5_000 },

    use: {
        trace: "off",
        video: "off",
        headless: !headed,
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2, // crisp text/lines for UI review
        actionTimeout: 15_000,
        navigationTimeout: 15_000,
    },

    // Headless Chrome ships WebGPU behind a flag, and shallot's `run()` acquires a real device even
    // though kex2d draws canvas2D — the first two mirror shallot's own host bridge
    // (`shallot/scripts/wsl-bridge.ts`). The backgrounding trio is load-bearing under parallel
    // workers: Chrome throttles rAF and timers in a renderer it considers backgrounded or occluded,
    // and kex2d projects its whole UI from a per-RAF tick, so a throttled worker's gestures resolve
    // against a frame that never ran (measured on a `viewport multiselect flow --repeat-each 10`
    // stress: 6/10 passing at 4 workers without them, 8/10 with, 10/10 at 1 worker either way — the
    // load sensitivity is the flow's own, the flags just cut the throttling half of it).
    projects: [
        {
            name: "chromium",
            use: {
                channel: "chrome",
                launchOptions: {
                    args: [
                        "--enable-unsafe-webgpu",
                        "--enable-features=WebGPUDeveloperFeatures",
                        "--disable-backgrounding-occluded-windows",
                        "--disable-renderer-backgrounding",
                        "--disable-background-timer-throttling",
                    ],
                },
            },
        },
    ],
});
