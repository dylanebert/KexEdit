import { State } from "@dylanebert/shallot/ecs";
import { check } from "@dylanebert/shallot/harness/check";
import { rotate } from "../path/path";
import { createRideEntity, readRide } from "./ride";
import { FORCE_FLOOR, run } from "./policies";
import {
    ride,
    RIDE_CONSTANTS,
    RIDE_INTENTS,
    RIDE_INTENTS_STALLED,
    RIDE_RATE,
    RIDE_START,
    SEGMENTS,
    SPANS,
} from "./ride.fixture";
import { feltForces, type TickState, tickAt } from "./trajectory";
import { frameQuat } from "../path/path";

const { g, heartToCom: h, friction, drag, mass } = RIDE_CONSTANTS;
// ticks either side of a segment boundary where the stored input and the tick-start lift straddle two intents
const ENTRY = 10;

/** The felt specific force at the COM in g: the heart's read plus ω × (ω × r) for r = h along local +Y. */
function comForces(tick: TickState) {
    const felt = feltForces(tick, RIDE_CONSTANTS);
    const [wx, wy, wz] = tick.omega;
    return { normal: felt.normal - (h * (wx * wx + wz * wz)) / g, lateral: felt.lateral + (h * wx * wy) / g };
}

const authored = (name: string) => {
    const segment = SEGMENTS.find((s) => s.name === name);
    if (!segment || segment.intent.shape.kind !== "forces") throw new Error(`ride segment ${name}: expected forces shape`);
    return segment.intent.shape;
};

/** Interior ticks of a segment; tick `t + 1` stores the input row `t` produced. */
function interior(name: string): number[] {
    const [start, end] = SPANS[name];
    const ticks = Array.from({ length: end - start - 2 * ENTRY }, (_, k) => start + 1 + ENTRY + k);
    if (ticks.length < 100) throw new Error(`ride segment ${name}: population is ${ticks.length} ticks`);
    return ticks;
}

check(
    "the ride entity keeps authored length separate from its marched prefix",
    { claim: "the ride entity infers length from a complete trajectory or loses the refusal end state" },
    () => {
        const state = new State();
        const eid = createRideEntity(state, {
            length: RIDE_INTENTS.length,
            intents: RIDE_INTENTS,
            initial: RIDE_START,
            rate: RIDE_RATE,
            constants: RIDE_CONSTANTS,
        });
        const record = readRide(state, eid);
        if (
            record.header.length !== RIDE_INTENTS.length ||
            record.header.count !== RIDE_INTENTS.length + 1 ||
            record.header.endReason !== "complete" ||
            record.header.endTick !== RIDE_INTENTS.length
        ) {
            throw new Error(`header ${JSON.stringify(record.header)}`);
        }
        if (record.trajectory.header.count !== record.header.count) throw new Error("trajectory count diverged from header");
    },
);

check(
    "a stalled ride keeps its authored tail and records the energy lane",
    { claim: "a stalled ride truncates its authored length or drops the structured energy refusal" },
    () => {
        const state = new State();
        const eid = createRideEntity(state, {
            length: RIDE_INTENTS_STALLED.length,
            intents: RIDE_INTENTS_STALLED,
            initial: RIDE_START,
            rate: RIDE_RATE,
            constants: RIDE_CONSTANTS,
        });
        const record = readRide(state, eid);
        if (record.header.endReason !== "stalled" || !(record.header.endTick < record.header.length)) {
            throw new Error(`header ${JSON.stringify(record.header)}`);
        }
        if (!record.refusal || record.refusal.reason !== "stalled" || record.refusal.lane !== "energy") {
            throw new Error(`refusal ${JSON.stringify(record.refusal)}`);
        }
        if (record.header.count !== record.header.endTick + 1) throw new Error("stalled count is not the marched prefix");
    },
);

check(
    "a six-g force refusal names the floor and tick-start speed",
    { claim: "a force refusal loses its lane or swaps the force floor and tick-start speed" },
    () => {
        const initial = {
            position: [0, 0, 0] as [number, number, number],
            rotation: frameQuat([0, 0, -1], [0, 1, 0]),
            speed: 15,
            distance: 0,
        };
        const intents = new Array(400).fill({
            shape: { kind: "forces", normal: 6, lateral: 0, roll: 0 },
            energy: { kind: "free" },
        });
        const result = run(initial, intents, RIDE_RATE, RIDE_CONSTANTS);
        if (result.trajectory.header.endReason !== "unsatisfiable" || !result.refusal) {
            throw new Error(`result ${result.trajectory.header.endReason}`);
        }
        if (
            result.refusal.reason !== "unsatisfiable" ||
            result.refusal.lane !== "forces" ||
            result.refusal.need !== FORCE_FLOOR ||
            !(result.refusal.have < result.refusal.need)
        ) {
            throw new Error(`refusal ${JSON.stringify(result.refusal)}`);
        }
        if (result.refusal.tick !== result.trajectory.header.endTick) throw new Error("refusal tick is not the last good tick");
    },
);

check(
    "the integrated ride marches to its authored end and stops",
    { claim: "the view's integrated ride stalls, becomes unsatisfiable, overruns a minute or never comes to rest" },
    () => {
        const { endReason, count, rate } = ride.header;
        const rows = SPANS[SEGMENTS[SEGMENTS.length - 1].name][1];
        const last = tickAt(ride, count - 1);
        if (endReason !== "complete" || count !== rows + 1) throw new Error(`ride ended ${endReason} at ${count} of ${rows + 1}`);
        if (!(Math.abs(last.speed) < 0.1)) throw new Error(`ride ends at ${last.speed} m/s`);
        if (!(count / rate < 60)) throw new Error(`ride lasts ${count / rate} s`);
    },
);

check(
    "the ride's loop holds its authored COM normal g",
    { claim: "the loop's felt normal at the COM departs from its authored g by more than 2% away from the entries" },
    () => {
        const want = authored("loop").normal;
        let turned = 0;
        for (const t of interior("loop")) {
            const tick = tickAt(ride, t);
            const { normal } = comForces(tick);
            if (!(Math.abs(normal - want) <= 0.02 * want)) throw new Error(`loop tick ${t}: normal ${normal} g, authored ${want}`);
        }
        const [start, end] = SPANS.loop;
        for (let t = start + 1; t <= end; t++) turned += tickAt(ride, t).omega[0] / ride.header.rate;
        // the population is a loop, not a bump: the pitch rate turns the frame all the way round
        if (!(Math.abs(turned - 2 * Math.PI) < 0.05)) throw new Error(`loop turns ${turned} rad`);
    },
);

check(
    "the ride's banked turn is coordinated",
    { claim: "the banked turn's felt lateral at the COM leaves zero by more than 0.02 g" },
    () => {
        if (authored("turn").lateral !== 0) throw new Error("turn: authored lateral is not zero");
        let bank = 0;
        for (const t of interior("turn")) {
            const tick = tickAt(ride, t);
            const { lateral } = comForces(tick);
            if (!(Math.abs(lateral) <= 0.02)) throw new Error(`turn tick ${t}: lateral ${lateral} g`);
            bank = Math.max(bank, Math.abs(rotate(tick.rotation, [1, 0, 0])[1]));
        }
        // non-vacuity: a level unbanked frame reads zero lateral without turning
        if (!(bank > 0.5)) throw new Error(`turn never banks: |right.y| ${bank}`);
    },
);

check(
    "the ride's hill crest speed follows the energy balance from its base",
    { claim: "free roll over the hill gains or loses speed the balance of COM height, rolling loss and drag does not name" },
    () => {
        const start = SPANS["hill-up"][0];
        const end = SPANS["hill-out"][1];
        const comY = (tick: TickState) => tick.position[1] + h * rotate(tick.rotation, [0, 1, 0])[1];
        let crest = start;
        for (let t = start; t <= end; t++) if (comY(tickAt(ride, t)) > comY(tickAt(ride, crest))) crest = t;
        if (crest === start || crest === end) throw new Error(`hill has no interior crest (tick ${crest})`);
        // losses per tick from the stored ticks: Coulomb on the heart's felt force, drag on v0 v1
        let lost = 0;
        for (let t = start; t < crest; t++) {
            const a = tickAt(ride, t);
            const b = tickAt(ride, t + 1);
            const felt = feltForces({ ...a, omega: b.omega }, RIDE_CONSTANTS);
            const travel = Math.abs(b.distance - a.distance);
            lost += (friction * g * Math.hypot(felt.normal, felt.lateral) + (drag * a.speed * b.speed) / mass) * travel;
        }
        const base = tickAt(ride, start);
        const top = tickAt(ride, crest);
        const want = Math.sqrt(base.speed * base.speed - 2 * (g * (comY(top) - comY(base)) + lost));
        if (!(top.speed < base.speed)) throw new Error(`crest ${top.speed} m/s is not below base ${base.speed}`);
        if (!(Math.abs(top.speed - want) <= 0.01 * want)) throw new Error(`crest ${top.speed} m/s, balance ${want}`);
    },
);
