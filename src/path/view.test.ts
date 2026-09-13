import { resolve } from "node:path";
import { check } from "@dylanebert/shallot/harness/check";
import launch from "@dylanebert/shallot/harness/browser" with { type: "json" };
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dir, "../..");

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

function freePort(): number {
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = listener.port;
    listener.stop();
    return port;
}

type Probe = { samples: number; drawn: boolean; count: number };

check(
    "the path view draws gizmo fragments from the pose binding and redraws on setPath",
    {
        claim: "the path view draws nothing or ignores a new path",
        size: "integration",
        requires: ["chromium"],
        subject: ["src/path/**", "src/View.svelte", "public/scenes/scaffold.scene"],
        budget: 20_000,
    },
    async () => {
        const port = freePort();
        const url = `http://127.0.0.1:${port}/`;
        const server = Bun.spawn(
            [process.execPath, "run", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
            { cwd: ROOT, stdout: "ignore", stderr: "ignore" },
        );
        let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
        const errors: string[] = [];
        try {
            await waitForServer(url, server);
            browser = await chromium.launch({ headless: false, ...launch });
            const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
            page.on("pageerror", (error) => errors.push(error.message));
            page.on("console", (message) => {
                if (message.type() === "error") errors.push(message.text());
            });
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10_000 });
            await page.waitForFunction(
                () => window.__harness?.ready === true && "__kexeditPath" in globalThis,
                undefined,
                { timeout: 15_000 },
            );
            // Each step stages (or not) a path, lets two frames draw, then reads the fragment counter the
            // shader incremented on the last drawn frame.
            const evidence = (await page.evaluate(async () => {
                type Handle = {
                    readPathProbe(): Promise<Probe>;
                    setPath(path: unknown): void;
                    fixtures: Record<string, { header: Record<string, unknown>; poses: Float32Array }>;
                };
                type Probe = { samples: number; drawn: boolean; count: number };
                const handle = (globalThis as unknown as { __kexeditPath: Handle }).__kexeditPath;
                const frames = () =>
                    new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
                const settle = async () => {
                    await frames();
                    return handle.readPathProbe();
                };
                const { straight, helix } = handle.fixtures;
                handle.setPath({ header: { ...helix.header, count: 0 }, poses: new Float32Array(0) });
                const empty = await settle();
                handle.setPath(helix);
                const helixProbe = await settle();
                handle.setPath(straight);
                const straightProbe = await settle();
                return { empty, helix: helixProbe, straight: straightProbe } satisfies Record<string, Probe>;
            })) as { empty: Probe; helix: Probe; straight: Probe };
            const harness = (await page.evaluate(() => window.__harness?.run?.())) as
                | { ok: boolean; checks: { name: string; ok: boolean }[] }
                | undefined;
            const pathCheck = harness?.checks.find((c) => c.name === "path gizmos drew");
            if (
                evidence.empty.samples !== 0 ||
                evidence.empty.count !== 0 ||
                !evidence.helix.drawn ||
                evidence.helix.count <= 0 ||
                !evidence.straight.drawn ||
                evidence.straight.count <= 0 ||
                evidence.straight.count === evidence.helix.count ||
                evidence.straight.samples === evidence.helix.samples ||
                pathCheck?.ok !== true ||
                errors.length > 0
            ) {
                throw new Error(`path view probe failed: ${JSON.stringify({ evidence, pathCheck, errors })}`);
            }
        } finally {
            await browser?.close();
            server.kill();
            await server.exited;
        }
    },
);
