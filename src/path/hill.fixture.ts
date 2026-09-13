// Hill: a circular crest of radius R in the YZ plane, entering climbing and leaving falling. Angle
// `a = s / R - SPAN` runs from -SPAN to +SPAN; the crest is at the origin and the centre is at
// (0, -R, 0). Up is the outward radial, so the frame pitches and never rolls.

import { type Curve, sampleCurve } from "./path";

const R = 12;
const SPAN = Math.PI / 4;

export const hillCurve: Curve = {
    length: 2 * SPAN * R,
    position: (s) => {
        const a = s / R - SPAN;
        return [0, R * Math.cos(a) - R, -R * Math.sin(a)];
    },
    forward: (s) => {
        const a = s / R - SPAN;
        return [0, -Math.sin(a), -Math.cos(a)];
    },
    up: (s) => {
        const a = s / R - SPAN;
        return [0, Math.cos(a), -Math.sin(a)];
    },
};

export const hill = sampleCurve(hillCurve, 0.5);
