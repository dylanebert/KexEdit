import { check } from "@dylanebert/shallot/harness/check";
import { frameQuat, POSE_FLOATS, readPath } from "../path/path";
import { constants, RATE } from "./fixtures.fixture";
import { CHUNK, createRide, editTick, type Ride, restartFor } from "./execution";
import { type Input, march, type State, step } from "./integrator";
import { resample } from "./resample";
import { readTrajectory, TICK_FLOATS } from "./trajectory";

const ROWS = 5000;
// yawed and pitched so every rotation component is non-zero and has a tangential ulp to perturb
const PITCH = 0.3;
const initial: State = {
    position: [3, 40, -2],
    rotation: frameQuat(
        [0.6 * Math.cos(PITCH), Math.sin(PITCH), -0.8 * Math.cos(PITCH)],
        [-0.6 * Math.sin(PITCH), Math.cos(PITCH), 0.8 * Math.sin(PITCH)],
    ),
    speed: 20,
    distance: 0,
};
const baseInputs: Input[] = Array.from({ length: ROWS }, (_, i) => ({
    omega: [0.3 * Math.sin(i / 300), 0.5 * Math.cos(i / 500), 0.2 * Math.sin(i / 900)],
    a: 0.5 * Math.sin(i / 700),
}));
const edited = (row: number): Input => ({ omega: [0.4, -0.1, 0.3], a: -0.25 + baseInputs[row].a });

const ride = (inputs: readonly Input[]): Ride => {
    const r = createRide({ ticks: Math.ceil((ROWS + 1) / CHUNK), poses: 4, rate: RATE, constants });
    r.setInitial(initial);
    r.setInputs(inputs);
    r.pass();
    return r;
};

const bytes = (view: Float32Array | Float64Array) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

/**
 * The first differing byte of the trajectory, the boundary stream after chunk `after` (all of it when
 * negative) or the path, or "" when all three are equal.
 */
function difference(a: Ride, b: Ride, after = -1): string {
    const chunks = Math.ceil(ROWS / CHUNK);
    const streams: [string, Float32Array | Float64Array, Float32Array | Float64Array][] = [
        ["ticks", a.trajectory().ticks, b.trajectory().ticks],
        ["boundaries", a.boundaries().subarray((after + 1) * 9, chunks * 9), b.boundaries().subarray((after + 1) * 9, chunks * 9)],
        ["poses", a.path().path.poses, b.path().path.poses],
    ];
    for (const [name, x, y] of streams) {
        if (x.length !== y.length) return `${name} length ${x.length} vs ${y.length}`;
        const p = bytes(x);
        const q = bytes(y);
        for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return `${name} byte ${i}`;
    }
    return "";
}

const nextUp = (x: number) => {
    const f = new Float64Array([x]);
    const u = new BigUint64Array(f.buffer);
    u[0] += 1n;
    return f[0];
};

check(
    "an edit re-marched from the last boundary equals the full march byte for byte",
    { claim: "an incremental restart from a chunk boundary diverges from the full march of the same inputs", budget: 250 },
    () => {
        // interior, boundary-touching (tick k on the grid needs the boundary before it), and row 0
        const cases = [
            { row: 2500, restart: 2 },
            { row: 2 * CHUNK - 1, restart: 1 },
            { row: 0, restart: 0 },
        ];
        for (const { row, restart } of cases) {
            const inputs = baseInputs.slice();
            inputs[row] = edited(row);
            const full = ride(inputs);
            const incremental = ride(baseInputs);
            const before = incremental.trajectory().ticks.slice();
            incremental.editInputs(row, [edited(row)]);
            if (incremental.restartChunk() !== restart || restartFor(editTick(row)) !== restart) {
                throw new Error(`row ${row}: restart chunk ${incremental.restartChunk()}, expected ${restart}`);
            }
            incremental.pass();
            const k = editTick(row);
            const after = incremental.trajectory().ticks;
            const reached = after.slice(k * TICK_FLOATS, (k + 1) * TICK_FLOATS).some((v, i) => v !== before[k * TICK_FLOATS + i]);
            if (!reached) throw new Error(`row ${row}: the edit did not change tick ${k}`);
            const where = difference(incremental, full);
            if (where) throw new Error(`row ${row}: incremental restart differs from the full march at ${where}`);

            // one ulp on a lane of the boundary the restart reads must reach a byte the restart writes; that
            // boundary row is excluded, so only propagation through the march is seen. Rounding absorbs
            // some lanes' ulp outright, leaving the f64 march identical, so at least one lane must reach.
            const perturbed = ride(baseInputs);
            const row0 = perturbed.boundaries().slice(restart * 9, restart * 9 + 9);
            let seen = 0;
            for (let lane = 0; lane < 9; lane++) {
                if (row0[lane] === 0) continue;
                perturbed.boundaries().set(row0, restart * 9);
                perturbed.boundaries()[restart * 9 + lane] = nextUp(row0[lane]);
                perturbed.editInputs(row, [edited(row)]);
                perturbed.pass();
                if (difference(perturbed, full, restart)) seen++;
            }
            if (seen === 0) throw new Error(`row ${row}: no one-ulp boundary perturbation reached the comparison`);
        }
    },
);

check(
    "the wasm march and resample agree with integrator.ts and resample.ts",
    { claim: "the wasm march or resample kernel departs from the TypeScript integrator or resampler", budget: 250 },
    () => {
        const r = ride(baseInputs);
        const bounds = r.boundaries();
        let state = initial;
        for (let t = 1; t < ROWS + 1; t++) {
            state = step(state, baseInputs[t - 1], 1 / RATE);
            if (t % CHUNK !== 0) continue;
            const b = bounds.subarray((t / CHUNK) * 9, (t / CHUNK) * 9 + 9);
            const want = [...state.position, ...state.rotation, state.speed, state.distance];
            const worst = Math.max(...want.map((w, i) => Math.abs(w - b[i]) / Math.max(1, Math.abs(w))));
            if (!(worst <= 1e-9)) throw new Error(`boundary at tick ${t} departs by ${worst}`);
        }
        const reference = march(initial, baseInputs, RATE, constants);
        const ticks = r.trajectory().ticks;
        if (ticks.length !== reference.ticks.length) throw new Error(`count ${ticks.length / TICK_FLOATS}`);
        for (let i = 0; i < ticks.length; i++) {
            if (!(Math.abs(ticks[i] - reference.ticks[i]) <= 1e-6 * Math.max(1, Math.abs(reference.ticks[i])))) {
                throw new Error(`tick ${Math.floor(i / TICK_FLOATS)} float ${i % TICK_FLOATS}: ${ticks[i]} vs ${reference.ticks[i]}`);
            }
        }
        const want = resample(reference);
        const { path } = r.path();
        if (path.header.count !== want.header.count || path.header.length !== want.header.length) {
            throw new Error(`path header ${JSON.stringify(path.header)} vs ${JSON.stringify(want.header)}`);
        }
        if (path.header.count < 2 * CHUNK) throw new Error(`population ${path.header.count} poses spans one chunk`);
        for (let i = 0; i < path.poses.length; i++) {
            if (!(Math.abs(path.poses[i] - want.poses[i]) <= 2e-5 * Math.max(1, Math.abs(want.poses[i])))) {
                throw new Error(`pose ${Math.floor(i / POSE_FLOATS)} float ${i % POSE_FLOATS}: ${path.poses[i]} vs ${want.poses[i]}`);
            }
        }
    },
);

check(
    "authored length capacity admits exactly length plus one ticks",
    { claim: "ride capacity allocates from an inferred or one-row-short length", budget: 250 },
    () => {
        const length = CHUNK - 1;
        const chunks = Math.ceil((length + 1) / CHUNK);
        if (chunks !== 1) throw new Error(`capacity chunks ${chunks}`);
        const r = createRide({ ticks: chunks, poses: 1, rate: RATE, constants });
        r.setInitial(initial);
        const rows = Array.from({ length: length + 1 }, () => ({ omega: [0, 0, 0] as [number, number, number], a: 0 }));
        let refused = false;
        try {
            r.setInputs(rows);
        } catch (error) {
            refused = String(error).includes("exceed");
        }
        if (!refused) throw new Error("a table one row over tick capacity was accepted");
    },
);

check(
    "readTrajectory refuses an end tick that disagrees with the emitted count",
    { claim: "a trajectory can publish an end tick other than count minus one", budget: 250 },
    () => {
        const trajectory = ride(baseInputs).trajectory();
        let refused = false;
        try {
            readTrajectory({ ...trajectory, header: { ...trajectory.header, endTick: trajectory.header.endTick - 1 } });
        } catch (error) {
            refused = String(error).includes("trajectory endTick:");
        }
        if (!refused) throw new Error("end tick mismatch was accepted");
    },
);

check(
    "a pass writes the back path buffer, publishes it with the next generation and names its dirty chunks",
    { claim: "a pass overwrites the path a reader holds, skips the generation, or uploads outside its dirty chunks", budget: 250 },
    () => {
        const r = ride(baseInputs);
        const first = r.path();
        if (first.generation !== 1) throw new Error(`first generation ${first.generation}`);
        if (!(first.path.poses.buffer instanceof SharedArrayBuffer) || (first.path.poses.buffer as ArrayBufferLike) !== r.memory.buffer) {
            throw new Error("the published path is not a view of the ride's shared memory");
        }
        const held = first.path.poses.slice();
        const row = 3500;
        r.editInputs(row, [edited(row)]);
        const { generation, dirty } = r.pass();
        const second = r.path();
        if (generation !== 2 || second.generation !== 2) throw new Error(`second generation ${generation}, ${second.generation}`);
        if (second.path.poses.byteOffset === first.path.poses.byteOffset) throw new Error("the pass wrote the front buffer");
        if (first.path.poses.some((v, i) => !Object.is(v, held[i]))) throw new Error("the held path changed under its reader");
        readPath(second.path);
        const poses = Math.max(first.path.header.count, second.path.header.count);
        let firstChanged = -1;
        for (let i = 0; i < poses; i++) {
            const a = first.path.poses.subarray(i * POSE_FLOATS, (i + 1) * POSE_FLOATS);
            const b = second.path.poses.subarray(i * POSE_FLOATS, (i + 1) * POSE_FLOATS);
            const changed = a.length !== b.length || a.some((v, c) => v !== b[c]);
            if (!changed) continue;
            if (firstChanged < 0) firstChanged = i;
            const c = Math.floor(i / CHUNK);
            if (c < dirty.first || c >= dirty.end) throw new Error(`pose ${i} changed outside dirty ${JSON.stringify(dirty)}`);
        }
        if (firstChanged < 0) throw new Error("the edit changed no pose");
        if (dirty.first !== Math.floor(firstChanged / CHUNK) || dirty.first === 0) {
            throw new Error(`dirty ${JSON.stringify(dirty)} does not start at pose ${firstChanged}'s chunk`);
        }
        if (dirty.end !== Math.ceil(poses / CHUNK)) throw new Error(`dirty ${JSON.stringify(dirty)} for ${poses} poses`);
    },
);
