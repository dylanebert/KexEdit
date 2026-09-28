import { test } from "bun:test";
import { POSE_FLOATS } from "../path/path";
import { CHUNK } from "./execution";
import { boundRide } from "./pool.fixture";

test(
    "the pooled resample leaves a stripe unwritten or writes other bytes than the single-thread resample",
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
        } finally {
            await ride.terminate();
        }
    },
    { timeout: 250 }
);
