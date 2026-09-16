import { check } from "@dylanebert/shallot/harness/check";
import { openPage, waitForView, withApp } from "../browser.fixture";
import type { Vec3 } from "../path/path";
import { createRide } from "./execution";
import { constants, helix, hill, RATE } from "./fixtures.fixture";
import { march } from "./integrator";
import { clockTick, initialState, intentTable, placeTrain } from "./train";
import { TICK_FLOATS, TICK_LANES, tickAt, type Trajectory } from "./trajectory";

check(
    "the view places the train at the trajectory tick the scheduler clock names",
    { claim: "the train pose for scheduler time k / rate is not the trajectory's tick k" },
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

type Sample = {
    elapsed: number;
    playhead: number;
    transportRate: number;
    playing: boolean;
    offset: number;
    rate: number;
    count: number;
    tick: number;
    ticks: number[];
    pos: number[];
    rot: number[];
};

check(
    "in Chromium the train transform follows the ride transport at rates one and two",
    {
        claim: "the drawn train transform departs from the tick named by the ride transport after scrub or pause",
        size: "integration",
        requires: ["chromium"],
        subject: ["src/trajectory/transport.ts", "src/trajectory/execution.ts", "src/path/view.ts", "src/View.svelte"],
    },
    () =>
        withApp(async ({ url, browser }) => {
            const errors: string[] = [];
            const page = await openPage(browser, url, errors);
            await waitForView(page);
            const sample = (frames: number) =>
                page.evaluate(async (n) => {
                    for (let i = 0; i < n; i++) await new Promise<void>((done) => requestAnimationFrame(() => done()));
                    const handle = (globalThis as unknown as { __kexeditPath: { train(): unknown } }).__kexeditPath;
                    return handle.train();
                }, frames) as Promise<Sample | null>;
            type Handle = {
                scrub(playhead: number): number | null;
                setPlaying(playing: boolean): boolean | null;
                setRate(rate: number): number | null;
            };
            const control = (action: string, value: number | boolean) =>
                page.evaluate(
                    ({ action, value }) => {
                        const handle = (globalThis as unknown as { __kexeditPath: Handle }).__kexeditPath;
                        if (action === "scrub") return handle.scrub(value as number);
                        if (action === "playing") return handle.setPlaying(value as boolean);
                        return handle.setRate(value as number);
                    },
                    { action, value },
                );
            const checked = (s: Sample) => {
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
                const k = Math.min(s.count - 1, Math.max(0, Math.floor(s.playhead) + Math.floor(s.offset)));
                const want = tickAt(trajectory, k);
                const got = [...s.pos, ...s.rot];
                const exp = [...want.position, ...want.rotation];
                return { ...s, k, worst: Math.max(...got.map((v, i) => Math.abs(v - exp[i]))) };
            };

            await control("playing", false);
            await control("scrub", 10.25);
            const scrubbed = checked((await sample(2))!);
            await control("setRate", 1);
            await control("playing", true);
            const rateOne = checked((await sample(30))!);
            await control("playing", false);
            const pauseStart = checked((await sample(2))!);
            const paused = checked((await sample(20))!);
            await control("scrub", 20.5);
            await control("setRate", 2);
            await control("playing", true);
            const rateTwo = checked((await sample(30))!);
            const distinct = scrubbed.ticks.length === scrubbed.count * TICK_FLOATS && scrubbed.count > 100;
            const travels = Math.abs(scrubbed.ticks[(scrubbed.count - 1) * TICK_FLOATS + TICK_LANES.distance]) > 1;
            const movedAtOne = rateOne.playhead > scrubbed.playhead;
            const heldWhilePaused = paused.playhead === pauseStart.playhead && paused.k === pauseStart.k;
            const movedAtTwo = rateTwo.playhead > 20.5;
            const rateScales = rateTwo.playhead - 20.5 > (rateOne.playhead - scrubbed.playhead) * 1.5;
            if (
                scrubbed.k !== 10 ||
                !movedAtOne ||
                !heldWhilePaused ||
                !movedAtTwo ||
                !rateScales ||
                !distinct ||
                !travels ||
                [scrubbed, rateOne, paused, rateTwo].some((e) => e.worst > 1e-6) ||
                errors.length
            ) {
                throw new Error(
                    `train placement failed: ${JSON.stringify({
                        samples: [scrubbed, rateOne, paused, rateTwo].map(({ ticks, pos, rot, ...sample }) => sample),
                        distinct,
                        travels,
                        errors,
                    })}`,
                );
            }
        }),
);
