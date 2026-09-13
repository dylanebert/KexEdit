// Helix: radius R about the vertical axis x = -R, climbing C per radian. With K = hypot(R, C) the
// angle is `t = s / K`. Up is the principal normal, pointing at the axis, so the frame rolls about
// world Y as it climbs; this is the fixture that sees a wrong quaternion sense. The length is not a
// multiple of the spacing, so the last interval is short.

import { type Curve, sampleCurve } from "./path";

const R = 8;
const C = 1.5;
const K = Math.hypot(R, C);

export const helixCurve: Curve = {
    length: 2.25 * Math.PI * K,
    position: (s) => {
        const t = s / K;
        return [R * Math.cos(t) - R, C * t, -R * Math.sin(t)];
    },
    forward: (s) => {
        const t = s / K;
        return [(-R * Math.sin(t)) / K, C / K, (-R * Math.cos(t)) / K];
    },
    up: (s) => {
        const t = s / K;
        return [-Math.cos(t), 0, Math.sin(t)];
    },
};

export const helix = sampleCurve(helixCurve, 0.5);
