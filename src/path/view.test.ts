import { resolve } from "node:path";
import { linearToSrgb, srgbToLinear } from "@dylanebert/shallot";
import { check } from "@dylanebert/shallot/harness/check";
import launch from "@dylanebert/shallot/harness/browser" with { type: "json" };
import { chromium } from "playwright";
import { PATH_BYTES, PATH_COLORS } from "./view";

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
    "the path view uploads its sRGB bytes decoded to linear",
    { claim: "the path view hands sRGB byte fractions to the linear scene target", budget: 250 },
    () => {
        for (const name of ["chord", "lateral"] as const) {
            const rgb = PATH_BYTES[name];
            const want = [16, 8, 0].map((shift) => srgbToLinear(((rgb >> shift) & 0xff) / 255));
            const got = PATH_COLORS[name];
            if (got.length !== 4 || got[3] !== 1 || want.some((w, i) => got[i] !== w)) {
                throw new Error(`path ${name}: ${JSON.stringify(got)} is not srgbToLinear of ${JSON.stringify(want)}`);
            }
        }
        // The normal is derived, not a byte: the Gruvbox spectrum between neutral green and aqua read at 142°, #6b9d65.
        const normal = PATH_COLORS.normal;
        const want = [0x6b, 0x9d, 0x65];
        const bytes = normal.slice(0, 3).map((c) => linearToSrgb(c) * 255);
        if (normal.length !== 4 || normal[3] !== 1 || bytes.some((b, i) => Math.abs(b - want[i]) > 1)) {
            throw new Error(`path normal: ${JSON.stringify(bytes)} is not within one byte of #6b9d65`);
        }
    },
);

check(
    "the path view draws gizmo fragments from the pose binding and redraws on setPath",
    {
        claim: "the path view draws nothing or ignores a new path",
        size: "integration",
        requires: ["chromium"],
        subject: [
            "src/path/path.ts",
            "src/path/shader.ts",
            "src/path/upload.ts",
            "src/path/view.ts",
            "src/path/straight.fixture.ts",
            "src/path/hill.fixture.ts",
            "src/path/helix.fixture.ts",
            "src/View.svelte",
            "public/scenes/scaffold.scene",
        ],
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
            // shader incremented on the last drawn frame. The probe cannot see color, so the empty and helix
            // steps also screenshot the canvas for the axis-color witness.
            const step = (fixture: "empty" | "helix" | "straight") =>
                page.evaluate(async (name) => {
                    type Handle = {
                        readPathProbe(): Promise<Probe>;
                        setPath(path: unknown): void;
                        fixtures: Record<string, { header: Record<string, unknown>; poses: Float32Array }>;
                    };
                    type Probe = { samples: number; drawn: boolean; count: number };
                    const handle = (globalThis as unknown as { __kexeditPath: Handle }).__kexeditPath;
                    const { helix } = handle.fixtures;
                    handle.setPath(
                        name === "empty"
                            ? { header: { ...helix.header, count: 0 }, poses: new Float32Array(0) }
                            : handle.fixtures[name],
                    );
                    await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
                    return handle.readPathProbe();
                }, fixture) as Promise<Probe>;
            const canvas = page.locator("[data-region=canvas]");
            const empty = await step("empty");
            const emptyShot = (await canvas.screenshot({ type: "png" })).toString("base64");
            const helix = await step("helix");
            const helixShot = (await canvas.screenshot({ type: "png" })).toString("base64");
            const straight = await step("straight");
            const evidence = { empty, helix, straight };
            // A pixel counts only where the helix frame shows the axis color and the empty frame does not,
            // so the grid's own red X axis cannot witness the lateral tick.
            const colors = await page.evaluate(
                async ([before, after]) => {
                    const pixelsOf = async (encoded: string) => {
                        const image = new Image();
                        image.src = `data:image/png;base64,${encoded}`;
                        await image.decode();
                        const surface = document.createElement("canvas");
                        surface.width = image.naturalWidth;
                        surface.height = image.naturalHeight;
                        const context = surface.getContext("2d");
                        if (!context) throw new Error("no 2d context");
                        context.drawImage(image, 0, 0);
                        return context.getImageData(0, 0, surface.width, surface.height).data;
                    };
                    const a = await pixelsOf(before);
                    const b = await pixelsOf(after);
                    // #cc241d: red well above green and blue; #6b9d65: green well above red and blue.
                    const red = (p: Uint8ClampedArray, i: number) =>
                        p[i] >= 150 && p[i] - p[i + 1] >= 90 && p[i] - p[i + 2] >= 90;
                    const green = (p: Uint8ClampedArray, i: number) =>
                        p[i + 1] >= 120 && p[i + 1] - p[i] >= 40 && p[i + 1] - p[i + 2] >= 40;
                    let reds = 0;
                    let greens = 0;
                    for (let i = 0; i < b.length; i += 4) {
                        if (red(b, i) && !red(a, i)) reds++;
                        if (green(b, i) && !green(a, i)) greens++;
                    }
                    return { reds, greens };
                },
                [emptyShot, helixShot] as const,
            );
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
                colors.reds < 1 ||
                colors.greens < 1 ||
                pathCheck?.ok !== true ||
                errors.length > 0
            ) {
                throw new Error(`path view probe failed: ${JSON.stringify({ evidence, colors, pathCheck, errors })}`);
            }
        } finally {
            await browser?.close();
            server.kill();
            await server.exited;
        }
    },
);
