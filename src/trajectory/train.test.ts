import { check } from "@dylanebert/shallot/harness/check";
import type { Vec3 } from "../path/path";
import { createRide } from "./execution";
import { constants, helix, hill, RATE } from "./fixtures.fixture";
import { march } from "./integrator";
import { clockTick, initialState, intentTable, placeTrain } from "./train";
import { tickAt } from "./trajectory";

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
