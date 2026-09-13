import { availableParallelism, cpus } from "node:os";
import { check } from "@dylanebert/shallot/harness/check";
import { frameQuat, POSE_FLOATS } from "../path/path";
import { CHUNK, createPooledRide, type Ride } from "./execution";
import { constants, RATE } from "./fixtures.fixture";
import type { Input } from "./integrator";

// The 30-minute bound at 100 Hz on a ride that keeps turning, rolling and changing speed.
const ROWS = 180_000;
const REPEATS = 9;

const inputs: Input[] = Array.from({ length: ROWS }, (_, i) => ({
    omega: [0.3 * Math.sin(i / 300), 0.5 * Math.cos(i / 500), 0.2 * Math.sin(i / 900)],
    a: 0.5 * Math.sin(i / 700),
}));

async function boundRide(): Promise<Ride> {
    const ride = await createPooledRide(
        { ticks: Math.ceil((ROWS + 1) / CHUNK), poses: 96, rate: RATE, constants },
        availableParallelism() - 1,
    );
    if (ride.workers < 1) throw new Error("the pool spawned no workers");
    ride.setInitial({ position: [0, 0, 0], rotation: frameQuat([0, 0, -1], [0, 1, 0]), speed: 20, distance: 0 });
    ride.setInputs(inputs);
    return ride;
}

const median = (run: () => void) => {
    const times: number[] = [];
    for (let i = 0; i < REPEATS; i++) {
        const t = performance.now();
        run();
        times.push(performance.now() - t);
    }
    return times.sort((a, b) => a - b)[REPEATS >> 1];
};

const hardware = () => `${cpus()[0]?.model ?? "unknown"} x${availableParallelism()}`;

check(
    "the threaded resample on Shallot's pool writes the single-thread bytes and reports its speedup against dispatch",
    {
        claim: "the pooled resample leaves a stripe unwritten or writes other bytes than the single-thread resample",
        size: "integration",
        subject: ["src/trajectory"],
        budget: 20_000,
    },
    async () => {
        const ride = await boundRide();
        try {
            ride.pass();
            const target = (1 - (ride.generation() % 2)) as 0 | 1;
            ride.resampleInto(target, false);
            const reference = ride.pathIn(target).poses.slice();
            if (reference.length / POSE_FLOATS < 8 * CHUNK) throw new Error(`population ${reference.length / POSE_FLOATS} poses`);
            ride.pathIn(target).poses.fill(Number.NaN, 0, reference.length);
            ride.resampleInto(target, true);
            const threaded = ride.pathIn(target).poses;
            for (let i = 0; i < reference.length; i++) {
                if (!Object.is(threaded[i], reference[i])) {
                    throw new Error(`pose ${Math.floor(i / POSE_FLOATS)} float ${i % POSE_FLOATS}: ${threaded[i]} vs ${reference[i]}`);
                }
            }
            const singleMs = median(() => ride.resampleInto(target, false));
            const threadedMs = median(() => ride.resampleInto(target, true));
            const dispatchMs = median(() => ride.idleDispatch());
            console.log(
                `kexedit execution resample: ${reference.length / POSE_FLOATS} poses, ${ride.workers + 1} threads, single ${singleMs.toFixed(3)} ms, threaded ${threadedMs.toFixed(3)} ms, speedup ${(singleMs / threadedMs).toFixed(2)}x, dispatch ${dispatchMs.toFixed(4)} ms (${((dispatchMs / threadedMs) * 100).toFixed(2)}% of threaded)`,
            );
            return { hardware: hardware() };
        } finally {
            await ride.terminate();
        }
    },
);

check(
    "H11: the resample is reported against the march on the same fixture",
    {
        claim: "the H11 ratio times a resample of a trajectory other than the march it is reported against",
        size: "integration",
        subject: ["src/trajectory"],
        budget: 20_000,
    },
    async () => {
        const ride = await boundRide();
        try {
            ride.pass();
            const ticks = ride.trajectory().header.count;
            const published = ride.path().path.poses.slice();
            // every timed march restarts from boundary 0 over the same rows
            const restarts: number[] = [];
            const onlyMarch = median(() => {
                ride.setInputs(inputs);
                restarts.push(ride.march());
            });
            const target = (1 - (ride.generation() % 2)) as 0 | 1;
            const resampleMs = median(() => ride.resampleInto(target, false));
            const poses = ride.pathIn(target).header.count;
            const timed = ride.pathIn(target).poses;
            if (
                ticks !== ROWS + 1 ||
                restarts.some((r) => r !== 0) ||
                timed.length !== published.length ||
                timed.some((v, i) => v !== published[i])
            ) {
                throw new Error(`the timed resample (${poses} poses) is not the resample of the timed march`);
            }
            console.log(
                `kexedit execution H11: ${ticks} ticks, ${poses} poses (${(poses / ticks).toFixed(3)} per tick), march ${onlyMarch.toFixed(3)} ms (${((onlyMarch / ticks) * 1e6).toFixed(1)} ns/tick), resample ${resampleMs.toFixed(3)} ms (${((resampleMs / poses) * 1e6).toFixed(1)} ns/pose), resample/march ${(resampleMs / onlyMarch).toFixed(3)}, per pose/per tick ${(resampleMs / poses / (onlyMarch / ticks)).toFixed(2)}`,
            );
            return { hardware: hardware() };
        } finally {
            await ride.terminate();
        }
    },
);
