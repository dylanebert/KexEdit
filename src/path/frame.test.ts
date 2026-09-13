import { check } from "@dylanebert/shallot/harness/check";
import { helix, helixCurve } from "./helix.fixture";
import { hill, hillCurve } from "./hill.fixture";
import { type Curve, type Path, poseAt, rotate, type Vec3 } from "./path";
import { straight, straightCurve } from "./straight.fixture";

const FIXTURES: Record<string, Path> = { straight, hill, helix };
const EPS = 1e-4;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec3): Vec3 => [a[0] / len(a), a[1] / len(a), a[2] / len(a)];
const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
];

check(
    "fixture poses are arclength-spaced and face their chords",
    { claim: "a path fixture breaks uniform spacing or the -Z forward frame law", budget: 250 },
    () => {
        for (const [name, path] of Object.entries(FIXTURES)) {
            const { count, spacing, length } = path.header;
            if (count < 2) throw new Error(`${name} has ${count} poses`);
            let total = 0;
            for (let i = 0; i + 1 < count; i++) {
                const a = poseAt(path, i);
                const b = poseAt(path, i + 1);
                const chord = sub(b.position, a.position);
                const step = len(chord);
                if (step > spacing + EPS) throw new Error(`${name} interval ${i} is ${step}`);
                total += step;
                const dir: Vec3 = [chord[0] / step, chord[1] / step, chord[2] / step];
                for (const q of [a.rotation, b.rotation]) {
                    const agree = dot(dir, rotate(q, [0, 0, -1]));
                    if (agree < 0.99) {
                        throw new Error(`${name} interval ${i} chord vs -Z agreement ${agree}`);
                    }
                }
            }
            // chords undershoot arclength on curves; closure within a percent of the authored length
            if (Math.abs(total - length) > 0.01 * length) {
                throw new Error(`${name} chords sum ${total} against length ${length}`);
            }
        }
    },
);

check(
    "fixture up is the orthonormal rider-up and the frame is right-handed",
    { claim: "a path fixture rolls, flips its up, or builds a left-handed frame", budget: 250 },
    () => {
        const curves: Record<string, Curve> = { straight: straightCurve, hill: hillCurve, helix: helixCurve };
        for (const [name, curve] of Object.entries(curves)) {
            for (let s = 0; s <= curve.length; s += curve.length / 64) {
                const f = curve.forward(s);
                const u = curve.up(s);
                if (Math.abs(dot(f, u)) > 1e-12 || Math.abs(len(u) - 1) > 1e-12) {
                    throw new Error(`${name} up at s=${s} is not orthonormal to forward`);
                }
            }
        }
        for (const [name, path] of Object.entries(FIXTURES)) {
            for (let i = 0; i < path.header.count; i++) {
                const q = poseAt(path, i).rotation;
                const forward = rotate(q, [0, 0, -1]);
                const k = forward[1];
                const riderUp = norm([-k * forward[0], 1 - k * k, -k * forward[2]]);
                const lateral = cross(forward, riderUp);
                const right = rotate(q, [1, 0, 0]);
                if (Math.abs(right[1]) > EPS || len(sub(right, lateral)) > EPS) {
                    throw new Error(`${name} pose ${i} +X ${right} is not forward × up ${lateral}`);
                }
            }
        }
    },
);
