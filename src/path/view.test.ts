import { linearToSrgb } from "@dylanebert/shallot";
import { check } from "@dylanebert/shallot/harness/check";
import { openPage, settleFrames, waitForView, withApp } from "../browser.fixture";
import { PATH_COLORS } from "./view";

type Probe = { samples: number; drawn: boolean; count: number };

check(
    "the path view's derived normal colour presents as #6b9d65",
    { claim: "the path normal tick presents a colour other than #6b9d65" },
    () => {
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
        host: "mac",
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
    },
    () =>
        withApp(async ({ url, browser }) => {
            const errors: string[] = [];
            const page = await openPage(browser, url, errors);
            await waitForView(page);
            // Let the accepted compositor entrance settle before the fixed capture contract is read.
            await settleFrames(page);
            // Each step stages (or not) a path, lets two frames draw, then reads the fragment counter the
            // shader incremented on the last drawn frame. The public capture contract supplies the semantic
            // axis-color witness; this row does not own a screenshot transport. Keep the captures in-page so
            // only compact verdict data crosses the driver boundary.
            const { evidence, colors } = await page.evaluate(async () => {
                type Handle = {
                    readPathProbe(): Promise<Probe>;
                    setPath(path: unknown): void;
                    captureFrame(): Promise<{ rgba: Uint8ClampedArray; width: number; height: number; identity: unknown }>;
                    fixtures: Record<string, { header: Record<string, unknown>; poses: Float32Array }>;
                };
                type Probe = { samples: number; drawn: boolean; count: number };
                const handle = (globalThis as unknown as { __kexeditPath: Handle }).__kexeditPath;
                const { helix } = handle.fixtures;
                const step = async (name: "empty" | "helix" | "straight") => {
                    handle.setPath(
                        name === "empty"
                            ? { header: { ...helix.header, count: 0 }, poses: new Float32Array(0) }
                            : handle.fixtures[name],
                    );
                    await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
                    return { probe: await handle.readPathProbe(), frame: await handle.captureFrame() };
                };
                const empty = await step("empty");
                const helixStep = await step("helix");
                const straight = await step("straight");
                // A pixel counts only where the helix frame shows the axis color and the empty frame does not,
                // so the grid's own red X axis cannot witness the lateral tick.
                const a = empty.frame.rgba;
                const b = helixStep.frame.rgba;
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
                return {
                    evidence: { empty: empty.probe, helix: helixStep.probe, straight: straight.probe },
                    colors: { reds, greens },
                };
            });
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
        }),
);
