// Named evidence for the H11 resample/march cost ratio on the 30-minute pooled ride. Triggered by name
// (`bun run test -- --oracle "<claim>"`) when an active spec changes the march or resample kernel.

import { check } from "@dylanebert/shallot/harness/check";
import { boundRide, hardware, inputs, median, ROWS } from "./pool.fixture";

check(
    "H11: the resample is reported against the march on the same fixture",
    {
        claim: "the H11 ratio times a resample of a trajectory other than the march it is reported against",
        size: "integration",
        budget: 2_000,
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
