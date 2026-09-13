// Closed-form trajectories at constant speed, 100 Hz, with ω written analytically in Shallot's frame
// and a = 0: the path fixtures' curves, plus a flat turn and a rolling straight so every ω component
// and the lateral read have a fixture that fixes its sign.
//
// Straight: no rotation. Hill: the nose drops over the crest, pitch -v / R. Helix: forward -Z = T,
// up +Y = N, right +X = B, so the Darboux vector τT + κB is κ about +X and τ about -Z per metre, with
// κ = R / K² and τ = C / K². Turn: level left circle, yaw +v / R. Corkscrew: straight along -Z with
// the right side going down at ROLL_RATE per second.

import { type Curve } from "../path/path";
import { helixCurve } from "../path/helix.fixture";
import { hillCurve } from "../path/hill.fixture";
import { straightCurve } from "../path/straight.fixture";
import { type RideConstants, sampleMotion } from "./trajectory";

export const RATE = 100;
export const SPEED = 12;
export const HILL_R = 12;
export const HELIX_R = 8;
export const HELIX_C = 1.5;
export const TURN_R = 20;
export const ROLL_RATE = 1.5;
const HELIX_K2 = HELIX_R * HELIX_R + HELIX_C * HELIX_C;

export const constants: RideConstants = { g: 9.80665, heartToCom: -0.9, mass: 5000, friction: 0.03, drag: 2e-5 };

/** Level left turn from the origin along -Z about the centre (-R, 0, 0). */
export const turnCurve: Curve = {
    length: Math.PI * TURN_R,
    position: (s) => {
        const t = s / TURN_R;
        return [TURN_R * Math.cos(t) - TURN_R, 0, -TURN_R * Math.sin(t)];
    },
    forward: (s) => {
        const t = s / TURN_R;
        return [-Math.sin(t), 0, -Math.cos(t)];
    },
    up: () => [0, 1, 0],
};

/** Straight along -Z whose up turns toward +X, lowering the right side, at ROLL_RATE per second. */
export const corkscrewCurve: Curve = {
    length: 20,
    position: (s) => [0, 0, -s],
    forward: () => [0, 0, -1],
    up: (s) => {
        const b = (s / SPEED) * ROLL_RATE;
        return [Math.sin(b), Math.cos(b), 0];
    },
};

export const straight = sampleMotion({ curve: straightCurve, speed: SPEED, omega: () => [0, 0, 0] }, RATE, constants);

export const hill = sampleMotion(
    { curve: hillCurve, speed: SPEED, omega: () => [-SPEED / HILL_R, 0, 0] },
    RATE,
    constants,
);

export const helix = sampleMotion(
    {
        curve: helixCurve,
        speed: SPEED,
        omega: () => [(SPEED * HELIX_R) / HELIX_K2, 0, (SPEED * HELIX_C) / HELIX_K2],
    },
    RATE,
    constants,
);

export const turn = sampleMotion({ curve: turnCurve, speed: SPEED, omega: () => [0, SPEED / TURN_R, 0] }, RATE, constants);

export const corkscrew = sampleMotion(
    { curve: corkscrewCurve, speed: SPEED, omega: () => [0, 0, ROLL_RATE] },
    RATE,
    constants,
);
