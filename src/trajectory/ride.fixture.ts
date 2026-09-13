// The integrated ride: an intent table of short named segments, marched through the policies from rest
// at the station. Nothing in it is closed form; speed, the loop's radius and the turn's bank are what the
// policies make of the authored intent under gravity, Coulomb rolling loss and drag.
//
// Station and lift are driven at 2 m/s, rates-shaped up a 30° climb and over its crest. The drop starts
// under rates free roll, because the force closure is unsatisfiable below FORCE_FLOOR, then a forces-shaped
// dive and a 3.5 g pullout to level. The loop holds 3.5 g at the COM with roll 0, the turn rolls into a
// bank and holds 1.5 g at zero lateral through 180° of yaw, the hill is rates pitch under free roll, and a
// rates-shaped driven brake stops the train at 1 g. Segment lengths are tuned so each shape ends where the
// next begins; the policies are untouched.

import type { State } from "./integrator";
import { type Intent, run } from "./policies";
import type { RideConstants } from "./trajectory";

export const RIDE_RATE = 100;

/** Header constants: g, the policies' fixture heart-to-COM, prototype friction and drag, a 500 kg train. */
export const RIDE_CONSTANTS: RideConstants = { g: 9.81, heartToCom: -0.9, mass: 500, friction: 0.03, drag: 2e-5 };

/** At rest at the station: heart at the origin, heading -Z, level. */
export const RIDE_START: State = { position: [0, 0, 0], rotation: [0, 0, 0, 1], speed: 0, distance: 0 };

export interface Segment {
    name: string;
    seconds: number;
    intent: Intent;
}

const LIFT = { kind: "driven", target: 2, accel: 1 } as const;
const FREE = { kind: "free" } as const;
const rates = (pitch: number, yaw = 0, roll = 0) => ({ kind: "rates", omega: [pitch, yaw, roll] }) as const;
const forces = (normal: number, roll = 0) => ({ kind: "forces", normal, lateral: 0, roll }) as const;

// 30° of pitch at 0.2 rad/s, a 10 m radius at lift speed
const LIFT_TURN = Math.PI / 6 / 0.2;
const BANK_RATE = 0.8;

export const SEGMENTS: readonly Segment[] = [
    { name: "station", seconds: 2.1, intent: { shape: rates(0), energy: LIFT } },
    { name: "lift-in", seconds: LIFT_TURN, intent: { shape: rates(0.2), energy: LIFT } },
    { name: "lift", seconds: 30, intent: { shape: rates(0), energy: LIFT } },
    { name: "lift-crest", seconds: LIFT_TURN, intent: { shape: rates(-0.2), energy: LIFT } },
    // rates until the train clears FORCE_FLOOR
    { name: "drop-in", seconds: 1.5, intent: { shape: rates(-0.5), energy: FREE } },
    { name: "dive", seconds: 1, intent: { shape: forces(0.3), energy: FREE } },
    { name: "drop", seconds: 1, intent: { shape: forces(0.48), energy: FREE } },
    // tuned: the pullout ends as pitch crosses level, the loop as its pitch rate turns 2π
    { name: "pullout", seconds: 1.07, intent: { shape: forces(3.5), energy: FREE } },
    { name: "loop", seconds: 3.75, intent: { shape: forces(3.5), energy: FREE } },
    // tuned: roll-in reaches the 1.5 g level bank acos(1 / 1.5), the turn completes 180° of yaw with the rolls
    { name: "roll-in", seconds: 1.05, intent: { shape: forces(1.2, BANK_RATE), energy: FREE } },
    { name: "turn", seconds: 5, intent: { shape: forces(1.5), energy: FREE } },
    { name: "roll-out", seconds: 1.05, intent: { shape: forces(1.2, -BANK_RATE), energy: FREE } },
    { name: "hill-up", seconds: 0.8, intent: { shape: rates(0.3), energy: FREE } },
    { name: "hill-over", seconds: 1.6, intent: { shape: rates(-0.3), energy: FREE } },
    { name: "hill-out", seconds: 0.8, intent: { shape: rates(0.3), energy: FREE } },
    // the brake is rates-shaped, so the force floor never reaches it; driven lands on 0 and holds
    { name: "brake", seconds: 2.07, intent: { shape: rates(0), energy: { kind: "driven", target: 0, accel: 9.81 } } },
];

/** Each segment's input rows `[start, end)` in the per-tick table. */
export const SPANS: Readonly<Record<string, readonly [number, number]>> = (() => {
    const spans: Record<string, [number, number]> = {};
    let at = 0;
    for (const { name, seconds } of SEGMENTS) {
        const ticks = Math.round(seconds * RIDE_RATE);
        spans[name] = [at, at + ticks];
        at += ticks;
    }
    return spans;
})();

/** The per-tick intent table at RIDE_RATE: row `t` is the intent the policies read at tick `t`. */
export const RIDE_INTENTS: readonly Intent[] = SEGMENTS.flatMap(({ seconds, intent }) =>
    new Array<Intent>(Math.round(seconds * RIDE_RATE)).fill(intent),
);

/** The ride as marched through `run`: its f64 history and the materialized trajectory. */
export const marched = run(RIDE_START, RIDE_INTENTS, RIDE_RATE, RIDE_CONSTANTS);
export const ride = marched.trajectory;
