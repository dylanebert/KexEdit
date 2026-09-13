import { check } from "@dylanebert/shallot/harness/check";
import { helix, helixCurve } from "./helix.fixture";
import { hill } from "./hill.fixture";
import { type Path, poseAt, rotate, type Vec3 } from "./path";
import { straight } from "./straight.fixture";

const FIXTURES: Record<string, Path> = { straight, hill, helix };
const EPS = 1e-4;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

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
    "helix up agrees with the analytic principal normal",
    { claim: "the helix pose up vector loses the analytic normal", budget: 250 },
    () => {
        const h = 1e-3;
        let checked = 0;
        for (let i = 0; i < helix.header.count; i++) {
            const s = Math.min(i * helix.header.spacing, helix.header.length);
            const p0 = helixCurve.position(s - h);
            const p1 = helixCurve.position(s);
            const p2 = helixCurve.position(s + h);
            const curl: Vec3 = [
                p0[0] - 2 * p1[0] + p2[0],
                p0[1] - 2 * p1[1] + p2[1],
                p0[2] - 2 * p1[2] + p2[2],
            ];
            const k = len(curl);
            const normal: Vec3 = [curl[0] / k, curl[1] / k, curl[2] / k];
            const up = rotate(poseAt(helix, i).rotation, [0, 1, 0]);
            const agree = dot(up, normal);
            if (agree < 0.999) throw new Error(`helix pose ${i} up vs normal agreement ${agree}`);
            checked += 1;
        }
        if (checked !== helix.header.count) throw new Error("helix poses not all checked");
    },
);
