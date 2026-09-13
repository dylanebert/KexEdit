// Helix: radius R about the vertical axis x = -R, climbing C per radian. With K = hypot(R, C) the
// angle is `t = s / K`. Up is the rider-up, world +Y made orthogonal to forward, so the frame never
// rolls: the lateral forward × up stays horizontal while the heading turns about world Y. The length
// is not a multiple of the spacing, so the last interval is short.

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
        return [(C * Math.sin(t)) / K, R / K, (C * Math.cos(t)) / K];
    },
};

export const helix = sampleCurve(helixCurve, 0.5);
