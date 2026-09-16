import { check } from "@dylanebert/shallot/harness/check";
import { POSE_FLOATS } from "../path/path";
import { CHUNK } from "./execution";
import { boundRide, hardware, median } from "./pool.fixture";

check(
    "the threaded resample on Shallot's pool writes the single-thread bytes and reports its speedup against dispatch",
    {
        claim: "the pooled resample leaves a stripe unwritten or writes other bytes than the single-thread resample",
        size: "integration",
        subject: ["src/trajectory/execution.ts", "src/trajectory/kernel.wasm.ts"],
        budget: 1_000,
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
