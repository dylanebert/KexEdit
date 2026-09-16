import { availableParallelism, cpus } from "node:os";
import { frameQuat } from "../path/path";
import { CHUNK, createPooledRide, type Ride } from "./execution";
import { constants, RATE } from "./fixtures.fixture";
import type { Input } from "./integrator";

// The 30-minute bound at 100 Hz on a ride that keeps turning, rolling and changing speed.
export const ROWS = 180_000;
const REPEATS = 9;

export const inputs: Input[] = Array.from({ length: ROWS }, (_, i) => ({
    omega: [0.3 * Math.sin(i / 300), 0.5 * Math.cos(i / 500), 0.2 * Math.sin(i / 900)],
    a: 0.5 * Math.sin(i / 700),
}));

export async function boundRide(): Promise<Ride> {
    const ride = await createPooledRide(
        { ticks: Math.ceil((ROWS + 1) / CHUNK), poses: 96, rate: RATE, constants },
        availableParallelism() - 1,
    );
    if (ride.workers < 1) throw new Error("the pool spawned no workers");
    ride.setInitial({ position: [0, 0, 0], rotation: frameQuat([0, 0, -1], [0, 1, 0]), speed: 20, distance: 0 });
    ride.setInputs(inputs);
    return ride;
}

export const median = (run: () => void) => {
    const times: number[] = [];
    for (let i = 0; i < REPEATS; i++) {
        const t = performance.now();
        run();
        times.push(performance.now() - t);
    }
    return times.sort((a, b) => a - b)[REPEATS >> 1];
};

export const hardware = () => `${cpus()[0]?.model ?? "unknown"} x${availableParallelism()}`;
