import { resolve } from "node:path";
import { check } from "@dylanebert/shallot/harness/check";
import launch from "@dylanebert/shallot/harness/browser" with { type: "json" };
import { chromium } from "playwright";
import type { Vec3 } from "../path/path";
import { createRide } from "./execution";
import { constants, helix, hill, RATE } from "./fixtures.fixture";
import { march } from "./integrator";
import { clockTick, initialState, intentTable, placeTrain } from "./train";
import { TICK_FLOATS, TICK_LANES, tickAt, type Trajectory } from "./trajectory";

const ROOT = resolve(import.meta.dir, "../..");

check(
    "the view places the train at the trajectory tick the scheduler clock names",
    { claim: "the train pose for scheduler time k / rate is not the trajectory's tick k", budget: 250 },
    () => {
        for (const fixture of [helix, hill]) {
            const { rate, count } = fixture.header;
            if (count < 100) throw new Error(`fixture population is ${count} ticks`);
            // every tick, at its instant, a hair under it as accumulated deltas land, and mid-interval
            for (let k = 0; k < count; k++) {
                const want = tickAt(fixture, k);
                for (const elapsed of [k / rate, k / rate - 1e-9, (k + 0.5) / rate]) {
                    const pose = placeTrain(fixture, elapsed);
                    if (pose.tick !== k) throw new Error(`elapsed ${elapsed}: tick ${pose.tick}, expected ${k}`);
                    const got = [...pose.position, ...pose.rotation];
                    const exp = [...want.position, ...want.rotation];
                    const at = got.findIndex((v, i) => !Object.is(v, exp[i]));
                    if (at >= 0) throw new Error(`tick ${k} at ${elapsed}: pose float ${at} is ${got[at]}, tick holds ${exp[at]}`);
                }
            }
            // the clock runs round: one full trajectory later names tick 0 again
            if (clockTick(fixture, count / rate) !== 0 || clockTick(fixture, (count + 3) / rate) !== 3) {
                throw new Error(`clock does not wrap at count ${count}`);
            }
        }
        // the ride the view marches from a trajectory's intent table stores that trajectory's inputs on every
        // tick, and on the constant-ω helix its geometry too; every closed-form fixture holds ω constant, so a
        // marched trajectory with varying ω is what sees a row shifted by one
        const varying = march(
            initialState(helix),
            Array.from({ length: 300 }, (_, i) => ({
                omega: [0.4 * Math.sin(i / 7), 0.9 * Math.cos(i / 11), -0.6 * Math.sin(i / 5)] as Vec3,
                a: 2 * Math.cos(i / 13),
            })),
            RATE,
            constants,
        );
        for (const fixture of [helix, varying]) {
            const ride = createRide({ ticks: 1, poses: 1, rate: fixture.header.rate, constants: fixture.header.constants });
            ride.setInitial(initialState(fixture));
            ride.setInputs(intentTable(fixture));
            ride.pass();
            const marched = ride.trajectory();
            if (marched.header.count !== fixture.header.count) {
                throw new Error(`ride marched ${marched.header.count} ticks, fixture ${fixture.header.count}`);
            }
            for (let t = 1; t < marched.header.count; t++) {
                const m = tickAt(marched, t);
                const f = tickAt(fixture, t);
                const got = [...m.omega, m.a];
                const exp = [...f.omega, f.a];
                if (fixture === helix) {
                    // q and -q are one rotation; the fixture's frameQuat and the march may pick either sign
                    const dot = m.rotation.reduce((sum, q, i) => sum + q * f.rotation[i], 0);
                    got.push(...m.position, m.speed, m.distance, Math.abs(dot));
                    exp.push(...f.position, f.speed, f.distance, 1);
                }
                if (got.some((v, i) => Math.abs(v - exp[i]) > 2e-5)) {
                    throw new Error(`ride tick ${t}: ${JSON.stringify(m)} vs fixture ${JSON.stringify(f)}`);
                }
            }
        }
    },
);

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

type Sample = { elapsed: number; rate: number; count: number; ticks: number[]; pos: number[]; rot: number[] };

check(
    "in Chromium the train's transform is the trajectory tick for the scheduler's elapsed time",
    {
        claim: "the drawn train's transform departs from the trajectory tick the scheduler clock names",
        size: "integration",
        requires: ["chromium"],
        subject: ["src/trajectory/train.ts", "src/trajectory/execution.ts", "src/path/view.ts", "src/View.svelte"],
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
            browser = await chromium.launch({ headless: true, ...launch });
            const page = await browser.newPage({ viewport: { width: 1563, height: 944 } });
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
            // N frames apart, sampled between frames so the transform and the clock are the same frame's
            const sample = (frames: number) =>
                page.evaluate(async (n) => {
                    for (let i = 0; i < n; i++) await new Promise<void>((done) => requestAnimationFrame(() => done()));
                    const handle = (globalThis as unknown as { __kexeditPath: { train(): unknown } }).__kexeditPath;
                    return handle.train();
                }, frames) as Promise<Sample | null>;
            const first = await sample(30);
            const second = await sample(45);
            if (!first || !second) throw new Error("the view placed no train");
            const evidence = [first, second].map((s) => {
                const trajectory: Trajectory = {
                    header: {
                        version: 1,
                        count: s.count,
                        rate: s.rate,
                        endReason: "complete",
                        endTick: s.count - 1,
                        constants: { g: 9.80665, heartToCom: 0, mass: 1, friction: 0, drag: 0 },
                    },
                    ticks: Float32Array.from(s.ticks),
                };
                // the tick is derived here from elapsed and rate, independent of the view's read
                const k = Math.floor(s.elapsed * s.rate + 1e-6) % s.count;
                const want = tickAt(trajectory, k);
                const exp = [...want.position, ...want.rotation];
                const got = [...s.pos, ...s.rot];
                const worst = Math.max(...got.map((v, i) => Math.abs(v - exp[i])));
                return { elapsed: s.elapsed, k, worst, got, exp };
            });
            const moved = evidence[0].k !== evidence[1].k && evidence[0].elapsed < evidence[1].elapsed;
            const distinct = first.ticks.length === first.count * TICK_FLOATS && first.count > 100;
            const travels = Math.abs(first.ticks[(first.count - 1) * TICK_FLOATS + TICK_LANES.distance]) > 1;
            if (!moved || !distinct || !travels || evidence.some((e) => !(e.elapsed > 0 && e.worst <= 1e-6)) || errors.length) {
                throw new Error(`train placement failed: ${JSON.stringify({ moved, distinct, travels, evidence, errors })}`);
            }
        } finally {
            await browser?.close();
            server.kill();
            await server.exited;
        }
    },
);
