import { check } from "@dylanebert/shallot/harness/check";
import { frameQuat } from "../path/path";
import { advance, placeAt, scrub } from "./transport";
import { TICK_FLOATS, TICK_LANES, type Trajectory, TRAJECTORY_VERSION } from "./trajectory";

const header = { length: 100, count: 11, rate: 10 };
const transport = (overrides: Partial<Parameters<typeof advance>[0]> = {}) => ({
    playhead: 0,
    playing: true,
    rate: 1,
    loop: false,
    ...overrides,
});

check(
    "transport advances on scheduler delta and both rates",
    { claim: "transport advances from elapsed or ignores either authored or playback rate" },
    () => {
        const one = advance(transport(), header, 0.25);
        const slow = advance(transport({ rate: 0.25 }), header, 0.25);
        const fast = advance(transport({ rate: 4 }), header, 0.25);
        if (one.playhead !== 2.5 || slow.playhead !== 0.625 || fast.playhead !== 10) {
            throw new Error(`playheads ${one.playhead}, ${slow.playhead}, ${fast.playhead}`);
        }
    },
);

check(
    "transport always wraps at the authored end",
    { claim: "transport makes its reserved loop bit an optional stop control" },
    () => {
        for (const loop of [false, true]) {
            const exact = advance(transport({ playhead: 95, loop }), header, 0.5);
            const multiple = advance(transport({ playhead: 95, loop }), header, 10.5);
            if (exact.playhead !== 0 || !exact.playing) throw new Error(`exact wrap ${JSON.stringify(exact)}`);
            if (multiple.playhead !== 0 || !multiple.playing) throw new Error(`multi-duration wrap ${JSON.stringify(multiple)}`);
        }
    },
);

check(
    "scrub stays inside authored length",
    { claim: "scrub writes a playhead outside the authored length" },
    () => {
        if (scrub(-1, header) !== 0 || scrub(101, header) !== 100 || scrub(37.5, header) !== 37.5) {
            throw new Error("scrub did not clamp to the authored interval");
        }
    },
);

const trajectory = (): Trajectory => {
    const ticks = new Float32Array(header.count * TICK_FLOATS);
    for (let i = 0; i < header.count; i++) {
        const o = i * TICK_FLOATS;
        ticks[o + TICK_LANES.position] = i;
        ticks.set(frameQuat([0, 0, -1], [0, 1, 0]), o + TICK_LANES.rotation);
    }
    return {
        header: {
            version: TRAJECTORY_VERSION,
            count: header.count,
            rate: header.rate,
            endReason: "complete",
            endTick: header.count - 1,
            constants: { g: 9.81, heartToCom: 0, mass: 1, friction: 0, drag: 0 },
        },
        ticks,
    };
};

check(
    "a train reads the transport tick and holds at a marched stall",
    { claim: "train placement interpolates or leaves the marched prefix after a stall" },
    () => {
        const ride = trajectory();
        const at = placeAt(ride, 3.9, 2);
        const stalled = placeAt({ ...ride, header: { ...ride.header, count: 5, endTick: 4 }, ticks: ride.ticks.subarray(0, 5 * TICK_FLOATS) }, 99, 2);
        if (at.tick !== 5 || at.position[0] !== 5) throw new Error(`transport tick ${at.tick}`);
        if (stalled.tick !== 4 || stalled.position[0] !== 4) throw new Error(`stall tick ${stalled.tick}`);
    },
);
