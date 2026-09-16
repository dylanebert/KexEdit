import { check } from "@dylanebert/shallot/harness/check";
import { type Curve, frameQuat, type Path, poseAt, readPath, rotate, type Vec3 } from "../path/path";
import { helix as helixPath, helixCurve } from "../path/helix.fixture";
import { constants, corkscrew, HELIX_C, HELIX_R, helix, hill, RATE, SPEED, straight, turn } from "./fixtures.fixture";
import { type Input, march, type State } from "./integrator";
import { chordError, DEFAULT_SPACING, resample } from "./resample";
import { TICK_FLOATS, TICK_LANES, type Trajectory } from "./trajectory";

const HELIX_K2 = HELIX_R * HELIX_R + HELIX_C * HELIX_C;
const POSITION = 2e-5;
const ROTATION = 1e-5;

const gap = (a: readonly number[], b: readonly number[]) => Math.hypot(...a.map((x, i) => x - b[i]));
const quatGap = (a: readonly number[], b: readonly number[]) => {
    const sign = a.reduce((sum, x, i) => sum + x * b[i], 0) < 0 ? -1 : 1;
    return Math.hypot(...a.map((x, i) => sign * x - b[i]));
};

function marchedHelix(): Trajectory {
    const initial: State = {
        position: helixCurve.position(0),
        rotation: frameQuat(helixCurve.forward(0), helixCurve.up(0)),
        speed: SPEED,
        distance: 0,
    };
    const input: Input = { omega: [0, (SPEED * HELIX_R) / HELIX_K2, (SPEED * HELIX_C) / HELIX_K2], a: 0 };
    return march(initial, new Array(helix.header.count - 1).fill(input), RATE, constants);
}

const arclength = (path: Path, i: number) => Math.min(i * path.header.spacing, path.header.length);

/** Worst gap of each pose from `curve` at its arclength. */
function knotGap(path: Path, curve: Curve): string {
    for (let i = 0; i < path.header.count; i++) {
        const s = arclength(path, i);
        const pose = poseAt(path, i);
        const dp = gap(pose.position, curve.position(s));
        const dq = quatGap(pose.rotation, frameQuat(curve.forward(s), curve.up(s)));
        if (!(dp <= POSITION && dq <= ROTATION)) return `pose ${i} at ${s} m: position ${dp}, rotation ${dq}`;
    }
    return "";
}

/** Worst gap of the path read as chords between poses from `curve` at the same arclength. */
function chordGap(path: Path, curve: Curve): number {
    let worst = 0;
    for (let i = 0; i + 1 < path.header.count; i++) {
        const a = poseAt(path, i).position;
        const b = poseAt(path, i + 1).position;
        const s0 = arclength(path, i);
        const s1 = arclength(path, i + 1);
        for (let k = 0; k <= 16; k++) {
            const u = k / 16;
            const chord = a.map((x, c) => x + u * (b[c] - x));
            worst = Math.max(worst, gap(chord, curve.position(s0 + u * (s1 - s0))));
        }
    }
    return worst;
}

check(
    "the marched helix resamples onto the closed-form helix at every pose",
    { claim: "a resampled pose departs from the closed-form helix at its arclength" },
    () => {
        const trajectory = marchedHelix();
        const marchedLength = (trajectory.header.count - 1) * (SPEED / RATE);
        for (const spacing of [DEFAULT_SPACING, 0.25]) {
            const path = resample(trajectory, spacing);
            const { header } = path;
            if (header.spacing !== spacing || Math.abs(header.length - marchedLength) > 1e-4) {
                throw new Error(`header ${JSON.stringify(header)} for marched length ${marchedLength}`);
            }
            if (header.count !== Math.ceil(marchedLength / spacing) + 1 || header.count < 100) {
                throw new Error(`count ${header.count} at spacing ${spacing}`);
            }
            const where = knotGap(path, helixCurve);
            if (where) throw new Error(`spacing ${spacing}: ${where}`);
        }
        const path = resample(trajectory, DEFAULT_SPACING);
        for (let i = 0; i + 1 < path.header.count; i++) {
            const a = poseAt(path, i);
            const b = poseAt(helixPath, i);
            if (!(gap(a.position, b.position) <= POSITION && quatGap(a.rotation, b.rotation) <= ROTATION)) {
                throw new Error(`pose ${i} departs from helix.fixture`);
            }
        }
    },
);

check(
    "the resampled helix stays inside its spacing's chord bound and the error halves at half the spacing",
    { claim: "the resampled path read as chords exceeds its spacing bound or does not converge with spacing" },
    () => {
        const trajectory = marchedHelix();
        const curvature = HELIX_R / HELIX_K2;
        const coarse = chordGap(resample(trajectory, DEFAULT_SPACING), helixCurve);
        const fine = chordGap(resample(trajectory, 0.25), helixCurve);
        const report = `0.5 m ${coarse}, 0.25 m ${fine}`;
        if (!(coarse > 10 * POSITION)) throw new Error(`coarse error is inside f32 noise: ${report}`);
        if (!(coarse <= chordError(DEFAULT_SPACING, curvature) * 1.01 + POSITION)) {
            throw new Error(`0.5 m exceeds bound ${chordError(DEFAULT_SPACING, curvature)}: ${report}`);
        }
        if (!(fine <= chordError(0.25, curvature) * 1.01 + POSITION)) {
            throw new Error(`0.25 m exceeds bound ${chordError(0.25, curvature)}: ${report}`);
        }
        if (!(fine <= 0.5 * coarse)) throw new Error(`error does not halve: ${report}`);
    },
);

check(
    "a frame turning at v = 0 is dropped and a reversal walks back by arclength",
    { claim: "the resampler keeps a v = 0 cusp or walks a reversal by signed distance" },
    () => {
        // at rest yaw left a quarter turn in 1 s, then a = 4 for 1 s, then a = -8 for 1 s: forward 3 m, back 1 m
        const inputs: Input[] = [
            ...new Array(RATE).fill({ omega: [0, Math.PI / 2, 0], a: 0 }),
            ...new Array(RATE).fill({ omega: [0, 0, 0], a: 4 }),
            ...new Array(RATE).fill({ omega: [0, 0, 0], a: -8 }),
        ];
        const initial: State = { position: [0, 0, 0], rotation: [0, 0, 0, 1], speed: 0, distance: 0 };
        const trajectory = march(initial, inputs, RATE, constants);
        const path = resample(trajectory, 0.05);
        if (Math.abs(path.header.length - 4) > 1e-4) throw new Error(`length ${path.header.length}, expected 4`);
        const forward: Vec3 = [-1, 0, 0];
        for (let i = 0; i < path.header.count; i++) {
            const s = arclength(path, i);
            const along = s <= 3 ? s : 6 - s;
            const pose = poseAt(path, i);
            const dp = gap(pose.position, [-along, 0, 0]);
            const df = gap(rotate(pose.rotation, [0, 0, -1]), forward);
            if (!(dp <= 1e-4 && df <= 1e-5)) throw new Error(`pose ${i} at ${s} m: position ${dp}, forward ${df}`);
        }
    },
);

check(
    "a trajectory storing q or -q per tick resamples to the same path",
    { claim: "the resampler interpolates rotation across a sign flip instead of along the short arc" },
    () => {
        const trajectory = marchedHelix();
        const ticks = trajectory.ticks.slice();
        for (let i = 1; i < trajectory.header.count; i += 2) {
            const o = i * TICK_FLOATS + TICK_LANES.rotation;
            for (let c = 0; c < 4; c++) ticks[o + c] = -ticks[o + c];
        }
        const flipped = resample({ header: trajectory.header, ticks }, 0.05);
        const plain = resample(trajectory, 0.05);
        for (let i = 0; i < plain.header.count; i++) {
            const a = poseAt(plain, i);
            const b = poseAt(flipped, i);
            if (!(gap(a.position, b.position) <= POSITION && quatGap(a.rotation, b.rotation) <= ROTATION)) {
                throw new Error(`pose ${i}: rotation ${quatGap(a.rotation, b.rotation)}`);
            }
        }
    },
);

check(
    "readPath accepts the resample of every trajectory fixture at every spacing",
    { claim: "the resampler emits a path the path contract refuses" },
    () => {
        const still = march(
            { position: [0, 0, 0], rotation: [0, 0, 0, 1], speed: 0, distance: 0 },
            [{ omega: [0, 1, 0], a: 0 }],
            RATE,
            constants,
        );
        const fixtures = { straight, hill, helix, turn, corkscrew, marched: marchedHelix(), still };
        for (const [name, trajectory] of Object.entries(fixtures)) {
            for (const spacing of [DEFAULT_SPACING, 0.25, 1000]) {
                const path = readPath(resample(trajectory, spacing));
                const expected = Math.ceil(path.header.length / spacing) + 1;
                if (path.header.count !== expected) {
                    throw new Error(`${name} at ${spacing}: count ${path.header.count}, expected ${expected}`);
                }
            }
        }
        if (resample(still).header.count !== 1) throw new Error("a trajectory with no travel is not one pose");
    },
);
