// Straight: level along world -Z from the origin, up +Y, no roll.

import { type Curve, sampleCurve } from "./path";

export const straightCurve: Curve = {
    length: 20,
    position: (s) => [0, 0, -s],
    forward: () => [0, 0, -1],
    up: () => [0, 1, 0],
};

export const straight = sampleCurve(straightCurve, 0.5);
