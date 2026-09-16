import { resolve } from "node:path";
import launch from "@dylanebert/shallot/harness/browser" with { type: "json" };
import { type Browser, chromium, type Page } from "playwright";

const ROOT = resolve(import.meta.dir, "..");
const VIEWPORT = { width: 1563, height: 944 };

function freePort(): number {
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = listener.port;
    listener.stop();
    return port;
}

async function waitForServer(url: string, server: ReturnType<typeof Bun.spawn>): Promise<void> {
    const deadline = performance.now() + 15_000;
    while (performance.now() < deadline) {
        if (server.exitCode !== null) throw new Error(`vite exited with ${server.exitCode}`);
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(500) });
            if (response.ok) return;
        } catch {
            // Vite is still starting.
        }
        await Bun.sleep(50);
    }
    throw new Error(`timed out waiting for Vite at ${url}`);
}

/** Serves the app through Vite on a free port, launches Chromium, and tears both down after `body`. */

/**
 * Shallot's headless Chromium launch on every platform: the `chromium` seat is headless Chromium on a
 * real adapter, and a headed launch is the `display` seat with its own contract, so this fixture never
 * substitutes one for the other. On Omarchy headless Chromium reaches only a SwiftShader adapter, so the
 * Chromium rows declare `host: "mac"` and report unrun here.
 */
export function seatLaunch(): Parameters<typeof chromium.launch>[0] {
    return { headless: true, ...launch };
}

export async function withApp<T>(body: (app: { url: string; browser: Browser }) => Promise<T>): Promise<T> {
    const port = freePort();
    const url = `http://127.0.0.1:${port}/`;
    const server = Bun.spawn(
        [process.execPath, "run", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
        { cwd: ROOT, stdout: "ignore", stderr: "ignore" },
    );
    let browser: Browser | undefined;
    try {
        await waitForServer(url, server);
        browser = await chromium.launch(seatLaunch());
        return await body({ url, browser });
    } finally {
        await browser?.close();
        if (server.exitCode === null) server.kill();
        await server.exited;
    }
}

/**
 * Opens `url` at the fixed driver geometry. Page errors and console errors land in `errors` from before
 * navigation; `prepare` runs before navigation too (init scripts, media emulation).
 */
export async function openPage(
    browser: Browser,
    url: string,
    errors: string[] | null,
    prepare?: (page: Page) => Promise<unknown>,
): Promise<Page> {
    const page = await browser.newPage({ viewport: VIEWPORT });
    if (errors) {
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
            if (message.type() === "error") errors.push(message.text());
        });
    }
    await prepare?.(page);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10_000 });
    return page;
}

/** Waits until the harness is ready and the view has published its path handle. */
export function waitForView(page: Page): Promise<unknown> {
    return page.waitForFunction(() => window.__harness?.ready === true && "__kexeditPath" in globalThis, undefined, {
        timeout: 15_000,
    });
}

/** Lets `frames` animation frames present, so compositor transitions finish on frames rather than a clock. */
export function settleFrames(page: Page, frames = 15): Promise<void> {
    return page.evaluate(
        (count) =>
            new Promise<void>((done) => {
                let seen = 0;
                const settle = () => {
                    if (seen++ >= count) done();
                    else requestAnimationFrame(settle);
                };
                settle();
            }),
        frames,
    );
}
