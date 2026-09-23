// The resampler: a trajectory into the path `src/path/` draws, in the one Shallot frame.
//
// Arclength is the running sum of |Δdistance|, so a reversal walks back over the ground it covered and
// adds length rather than subtracting it. An interval of zero arclength is a frame turning at v = 0, a
// cusp: it is dropped before the walk, so the pose at a cusp's arclength is the frame leaving it. Pose
// `i` sits at `min(i * spacing, length)`, which leaves the last interval short. Between ticks, position
// is the cubic Hermite whose end tangents are each tick's forward in the interval's direction of travel,
// and rotation is the slerp of the tick rotations.
//
// Spacing is a geometric error bound, never a bare constant. The path is read as chords between poses,
// so at curvature κ it departs from the curve by at most κ·spacing²/8, the sagitta. The default is 0.5 m (NoLimits 2's export default; 0.25 m is track-recording
// practice).

import { PATH_VERSION, type Path, POSE_FLOATS, POSE_LANES, type Quat, readPath, rotate, type Vec3 } from "../path/path";
import { TICK_FLOATS, TICK_LANES, type Trajectory, readTrajectory } from "./trajectory";

export const DEFAULT_SPACING = 0.5;

/** Worst chord deviation, m, of poses `spacing` apart on a curve of curvature `curvature` (1/m). */
export function chordError(spacing: number, curvature: number): number {
    return (curvature * spacing * spacing) / 8;
}

const FORWARD: Vec3 = [0, 0, -1];

function slerp(p: Quat, q: Quat, u: number): Quat {
    let dot = p[0] * q[0] + p[1] * q[1] + p[2] * q[2] + p[3] * q[3];
    const sign = dot < 0 ? -1 : 1;
    dot *= sign;
    let a = 1 - u;
    let b = u * sign;
    if (dot < 1 - 1e-9) {
        const theta = Math.acos(dot);
        const s = Math.sin(theta);
        a = Math.sin((1 - u) * theta) / s;
        b = (Math.sin(u * theta) / s) * sign;
    }
    const r: Quat = [a * p[0] + b * q[0], a * p[1] + b * q[1], a * p[2] + b * q[2], a * p[3] + b * q[3]];
    const norm = Math.hypot(r[0], r[1], r[2], r[3]);
    return [r[0] / norm, r[1] / norm, r[2] / norm, r[3] / norm];
}

/** Resample `trajectory` by arclength at `spacing` m into a validated path. */
export function resample(trajectory: Trajectory, spacing = DEFAULT_SPACING): Path {
    const { header, ticks } = readTrajectory(trajectory);
    if (!(spacing > 0 && Number.isFinite(spacing))) {
        throw new Error(`resample spacing: expected finite > 0, got ${spacing}`);
    }
    const n = header.count;
    const position = (i: number): Vec3 => {
        const o = i * TICK_FLOATS + TICK_LANES.position;
        return [ticks[o], ticks[o + 1], ticks[o + 2]];
    };
    const rotation = (i: number): Quat => {
        const o = i * TICK_FLOATS + TICK_LANES.rotation;
        return [ticks[o], ticks[o + 1], ticks[o + 2], ticks[o + 3]];
    };
    const distance = (i: number) => ticks[i * TICK_FLOATS + TICK_LANES.distance];

    const sigma = new Float64Array(n);
    const spans: number[] = [];
    for (let i = 1; i < n; i++) {
        const ds = Math.abs(distance(i) - distance(i - 1));
        sigma[i] = sigma[i - 1] + ds;
        if (ds > 0) spans.push(i - 1);
    }
    const length = sigma[n - 1];
    const count = Math.ceil(length / spacing) + 1;
    const poses = new Float32Array(count * POSE_FLOATS);

    let k = 0;
    for (let i = 0; i < count; i++) {
        const o = i * POSE_FLOATS;
        if (spans.length === 0) {
            poses.set(position(0), o + POSE_LANES.position);
            poses.set(rotation(0), o + POSE_LANES.rotation);
            continue;
        }
        const s = Math.min(i * spacing, length);
        while (k < spans.length - 1 && sigma[spans[k] + 1] < s) k++;
        const j = spans[k];
        const h = sigma[j + 1] - sigma[j];
        const u = Math.min(Math.max((s - sigma[j]) / h, 0), 1);
        const direction = Math.sign(distance(j + 1) - distance(j)) * h;
        const q0 = rotation(j);
        const q1 = rotation(j + 1);
        const p0 = position(j);
        const p1 = position(j + 1);
        const m0 = rotate(q0, FORWARD);
        const m1 = rotate(q1, FORWARD);
        const u2 = u * u;
        const u3 = u2 * u;
        const h00 = 2 * u3 - 3 * u2 + 1;
        const h10 = (u3 - 2 * u2 + u) * direction;
        const h01 = -2 * u3 + 3 * u2;
        const h11 = (u3 - u2) * direction;
        poses.set(
            [0, 1, 2].map((c) => h00 * p0[c] + h10 * m0[c] + h01 * p1[c] + h11 * m1[c]),
            o + POSE_LANES.position,
        );
        poses.set(slerp(q0, q1, u), o + POSE_LANES.rotation);
    }
    return readPath({ header: { version: PATH_VERSION, count, spacing, length, aux: [] }, poses });
}
