// The path contract: the one artifact every later KexEdit layer produces or consumes.
//
// A path is a CPU header, a pose stream and an optional auxiliary stream.
//
// Frame law. The local frame is Shallot's: right-handed, -Z forward along the ride, +Y up through
// the rider's head, +X right. A pose's `rotation` is a unit quaternion stored (x, y, z, w), the
// sense of Shallot's `Xform.quat`, and it rotates that local frame into world. Roll is derived from
// the quaternion, never stored.
//
// Arclength of pose `i` is `min(i * spacing, length)`: the stream is uniform except that the last
// interval may be short, and `length` is the authored total.
//
// `w` is reserved zero. The stride is read from the schema; a second hand-authored stride is layout
// drift.
//
// The auxiliary stream is `ceil(slots / lanes)` vec4 rows per pose. The header's `aux` names slots in
// declaration order; `auxSlot` resolves a name to row and lane on the CPU, and no shader sees names.

import * as d from "typegpu/data";

export const Pose = d.struct({
    position: d.vec3f,
    w: d.f32,
    rotation: d.vec4f,
});

export const POSE_BYTES = d.sizeOf(Pose);
export const POSE_FLOATS = POSE_BYTES / Float32Array.BYTES_PER_ELEMENT;
export const AUX_LANES = d.sizeOf(d.vec4f) / Float32Array.BYTES_PER_ELEMENT;

const floatOffset = (bytes: number) => bytes / Float32Array.BYTES_PER_ELEMENT;
export const POSE_LANES = {
    position: floatOffset(d.memoryLayoutOf(Pose, (p) => p.position).offset),
    w: floatOffset(d.memoryLayoutOf(Pose, (p) => p.w).offset),
    rotation: floatOffset(d.memoryLayoutOf(Pose, (p) => p.rotation).offset),
} as const;

export const PATH_VERSION = 1;

/** Tolerance on `| |q| - 1 |` before `readPath` refuses a pose. */
export const UNIT_TOLERANCE = 1e-4;

export interface PathHeader {
    version: number;
    count: number;
    spacing: number;
    length: number;
    aux: readonly string[];
}

export interface Path {
    header: PathHeader;
    poses: Float32Array;
    aux?: Float32Array;
}

export interface AuxSlot {
    row: number;
    lane: number;
}

export function auxRows(slots: number): number {
    return Math.ceil(slots / AUX_LANES);
}

/** Resolve a slot name to its row and lane within one pose's auxiliary rows. */
export function auxSlot(header: PathHeader, name: string): AuxSlot {
    const index = header.aux.indexOf(name);
    if (index < 0) throw new Error(`path aux: no slot named ${JSON.stringify(name)}`);
    return { row: Math.floor(index / AUX_LANES), lane: index % AUX_LANES };
}

/** Index into `aux` of slot `name` for pose `pose`. */
export function auxIndex(header: PathHeader, pose: number, name: string): number {
    const { row, lane } = auxSlot(header, name);
    return (pose * auxRows(header.aux.length) + row) * AUX_LANES + lane;
}

/**
 * Pack per-pose slot values into the auxiliary stream. `rows[pose][slot]` follows `names` order.
 * An empty slot map yields no stream.
 */
export function packAux(
    names: readonly string[],
    rows: readonly (readonly number[])[],
): Float32Array | undefined {
    if (names.length === 0) return undefined;
    if (new Set(names).size !== names.length) throw new Error("path aux: duplicate slot names");
    const stride = auxRows(names.length) * AUX_LANES;
    const out = new Float32Array(rows.length * stride);
    rows.forEach((values, pose) => {
        if (values.length !== names.length) {
            throw new Error(
                `path aux: pose ${pose} has ${values.length} values for ${names.length} slots`,
            );
        }
        out.set(values, pose * stride);
    });
    return out;
}

/** Validate a path before any consumer reads it. Refusals name the field. */
export function readPath(path: Path): Path {
    const { header, poses, aux } = path;
    if (header.version !== PATH_VERSION) {
        throw new Error(`path version: expected ${PATH_VERSION}, got ${header.version}`);
    }
    if (!Number.isInteger(header.count) || header.count < 0) {
        throw new Error(`path count: expected a non-negative integer, got ${header.count}`);
    }
    if (!(header.spacing > 0)) throw new Error(`path spacing: expected > 0, got ${header.spacing}`);
    if (poses.length !== header.count * POSE_FLOATS) {
        throw new Error(
            `path poses: expected ${header.count * POSE_FLOATS} floats for count ${header.count}, got ${poses.length}`,
        );
    }
    const slots = header.aux.length;
    if (slots === 0) {
        if (aux !== undefined) throw new Error("path aux: stream present with an empty slot map");
    } else {
        const expected = header.count * auxRows(slots) * AUX_LANES;
        if (aux === undefined || aux.length !== expected) {
            throw new Error(
                `path aux: expected ${expected} floats for count ${header.count} and ${slots} slots, got ${aux?.length ?? "none"}`,
            );
        }
    }
    const r = POSE_LANES.rotation;
    for (let i = 0; i < header.count; i++) {
        const o = i * POSE_FLOATS + r;
        const norm = Math.hypot(poses[o], poses[o + 1], poses[o + 2], poses[o + 3]);
        if (!(Math.abs(norm - 1) <= UNIT_TOLERANCE)) {
            throw new Error(`path rotation: pose ${i} quaternion norm ${norm} is not unit`);
        }
    }
    return path;
}

export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];

export function poseAt(path: Path, i: number): { position: Vec3; rotation: Quat } {
    const o = i * POSE_FLOATS;
    const p = o + POSE_LANES.position;
    const r = o + POSE_LANES.rotation;
    const f = path.poses;
    return {
        position: [f[p], f[p + 1], f[p + 2]],
        rotation: [f[r], f[r + 1], f[r + 2], f[r + 3]],
    };
}

/** Rotate `v` by the unit quaternion `q` (x, y, z, w). */
export function rotate(q: Quat, v: Vec3): Vec3 {
    const [x, y, z, w] = q;
    const tx = 2 * (y * v[2] - z * v[1]);
    const ty = 2 * (z * v[0] - x * v[2]);
    const tz = 2 * (x * v[1] - y * v[0]);
    return [
        v[0] + w * tx + (y * tz - z * ty),
        v[1] + w * ty + (z * tx - x * tz),
        v[2] + w * tz + (x * ty - y * tx),
    ];
}

/** The quaternion whose rotation maps local -Z to `forward` and +Y to `up` (orthonormal inputs). */
export function frameQuat(forward: Vec3, up: Vec3): Quat {
    const zx = -forward[0];
    const zy = -forward[1];
    const zz = -forward[2];
    const [yx, yy, yz] = up;
    const xx = yy * zz - yz * zy;
    const xy = yz * zx - yx * zz;
    const xz = yx * zy - yy * zx;
    // columns X, Y, Z of the rotation matrix
    const trace = xx + yy + zz;
    if (trace > 0) {
        const s = 0.5 / Math.sqrt(trace + 1);
        return [(yz - zy) * s, (zx - xz) * s, (xy - yx) * s, 0.25 / s];
    }
    if (xx >= yy && xx >= zz) {
        const s = 2 * Math.sqrt(1 + xx - yy - zz);
        return [0.25 * s, (xy + yx) / s, (xz + zx) / s, (yz - zy) / s];
    }
    if (yy >= zz) {
        const s = 2 * Math.sqrt(1 + yy - xx - zz);
        return [(xy + yx) / s, 0.25 * s, (yz + zy) / s, (zx - xz) / s];
    }
    const s = 2 * Math.sqrt(1 + zz - xx - yy);
    return [(xz + zx) / s, (yz + zy) / s, 0.25 * s, (xy - yx) / s];
}

/** A closed-form curve parametrized by arclength. */
export interface Curve {
    length: number;
    position(s: number): Vec3;
    forward(s: number): Vec3;
    up(s: number): Vec3;
}

/** Sample a closed-form curve at `min(i * spacing, length)` into a validated path. */
export function sampleCurve(curve: Curve, spacing: number): Path {
    const count = Math.ceil(curve.length / spacing) + 1;
    const poses = new Float32Array(count * POSE_FLOATS);
    for (let i = 0; i < count; i++) {
        const s = Math.min(i * spacing, curve.length);
        const o = i * POSE_FLOATS;
        poses.set(curve.position(s), o + POSE_LANES.position);
        poses.set(frameQuat(curve.forward(s), curve.up(s)), o + POSE_LANES.rotation);
    }
    const header = { version: PATH_VERSION, count, spacing, length: curve.length, aux: [] };
    return readPath({ header, poses });
}
