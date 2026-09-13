// Execution: the march and resample kernels (`kernel/lib.rs`, wasm-simd128) over one shared memory,
// on Shallot's pool.
//
// One ride owns one `WebAssembly.Memory`, laid out once at creation and never grown: the f64 input
// table, the f32 trajectory, the f64 boundary stream, the resample's arclength and span scratch, two
// path buffers and a generation block. Capacity is declared in chunks. Every reader view is a
// `subarray` of that memory, so the trajectory and the path reach the main thread and the GPU without
// a copy.
//
// The chunk grid is one unit for everything: CHUNK ticks is the march's restart unit, CHUNK poses the
// resample's parallel unit and the upload's dirty set. The march stores its f64 state at every chunk's
// first tick, so an edit that first changes tick k re-marches from the last boundary whose state it
// cannot reach and reproduces the full march byte for byte. The march is sequential; the resample
// stripes pose chunks over the pool.
//
// Generations. A pass (march from the restart boundary, resample into the back path buffer) ends by
// publishing the back buffer as front and adding one to the generation, in that order, atomically per
// word. Readers compare generations; the pass never writes the buffer a reader holds, so no reader sees
// a half-written path. Single writer per region is the whole protocol.
//
// Shallot does not export its pool from the package, so `createPool` is reached by path into the
// installed package; the export is a Shallot follow-up.

import {
    createPool,
    maxWorkers,
    type Pool,
} from "../../node_modules/@dylanebert/shallot/src/standard/physics/kernel/pool";
import { PATH_VERSION, type Path, POSE_FLOATS, POSE_LANES, readPath } from "../path/path";
import type { Input, State } from "./integrator";
import { KERNEL_MAX_MEMORY, KERNEL_STACK_SIZE, KERNEL_WASM_BASE64 } from "./kernel.wasm";
import { DEFAULT_SPACING } from "./resample";
import {
    type RideConstants,
    TICK_FLOATS,
    TICK_LANES,
    type Trajectory,
    type TrajectoryHeader,
    TRAJECTORY_VERSION,
} from "./trajectory";

/** Poses (and ticks) per chunk. A producer parameter, never a contract field. */
export const CHUNK = 1024;

const PAGE = 65536;
const INPUT_FLOATS = 4;

interface KernelExports {
    __stack_pointer: WebAssembly.Global;
    __heap_base: WebAssembly.Global;
    setLayout(...lanes: number[]): void;
    boundaryFloats(): number;
    march(inputs: number, ticks: number, bounds: number, fromChunk: number, count: number, dt: number, chunk: number): void;
    resamplePrepare(ticks: number, count: number, sigma: number, spans: number): number;
    setResampleJob(
        ticks: number,
        sigma: number,
        spans: number,
        spanCount: number,
        poses: number,
        spacing: number,
        length: number,
        poseCount: number,
        chunk: number,
        threads: number,
    ): void;
    resampleRange(start: number, end: number): void;
    workerMain(worker: number): void;
}

let compiled: WebAssembly.Module | undefined;
function kernelModule(): WebAssembly.Module {
    compiled ??= new WebAssembly.Module(Uint8Array.from(atob(KERNEL_WASM_BASE64), (c) => c.charCodeAt(0)));
    return compiled;
}

export interface RideOptions {
    /** Tick capacity in chunks; the trajectory never exceeds `ticks * CHUNK` ticks. */
    ticks: number;
    /** Pose capacity in chunks. */
    poses: number;
    rate: number;
    constants: RideConstants;
    spacing?: number;
    chunk?: number;
}

/** Which pose chunks changed since the previous generation, as `[first, end)` chunk indices. */
export interface Dirty {
    first: number;
    end: number;
}

export interface PassResult {
    generation: number;
    /** The chunk whose boundary the march resumed from. */
    restart: number;
    dirty: Dirty;
}

export interface Ride {
    readonly memory: WebAssembly.Memory;
    readonly chunk: number;
    /** Worker count of the pool the resample runs on; 0 is single-threaded. */
    readonly workers: number;
    setInitial(state: State): void;
    /** Replace the whole input table; the trajectory becomes `inputs.length + 1` ticks. */
    setInputs(inputs: readonly Input[]): void;
    /** Overwrite rows from `from` on, extending the table if they run past its end. */
    editInputs(from: number, inputs: readonly Input[]): void;
    /** The boundary chunk the next pass resumes from. */
    restartChunk(): number;
    /** March from the restart boundary without resampling or publishing; returns the restart chunk. */
    march(): number;
    /** March from the restart boundary, resample into the back buffer, publish it. */
    pass(): PassResult;
    /** Resample the current trajectory into the back buffer on one thread or the pool, unpublished. */
    resampleInto(buffer: 0 | 1, threaded: boolean): number;
    /** One pool round over an empty job: the wake and join a threaded resample pays before any pose. */
    idleDispatch(): void;
    generation(): number;
    trajectory(): Trajectory;
    /** The published path and its generation; `poses` is a subarray of the shared memory. */
    path(): { generation: number; path: Path };
    /** The path in `buffer` as last written, for comparing buffers. */
    pathIn(buffer: 0 | 1): Path;
    boundaries(): Float64Array;
    terminate(): Promise<void>;
}

/** The first tick whose content an edit of input row `row` changes: tick 0 carries row 0 too. */
export const editTick = (row: number) => (row === 0 ? 0 : row + 1);

/** The last boundary whose f64 state an edit first reaching tick `k` cannot have changed. */
export const restartFor = (k: number, chunk = CHUNK) => (k === 0 ? 0 : Math.floor((k - 1) / chunk));

/** A ride on the calling thread only: the CLI, the checks and the non-isolated fallback. */
export function createRide(options: RideOptions): Ride {
    return build(options, null);
}

/** A ride whose resample runs on `threads` pool workers plus the caller, capped by the stack slices. */
export async function createPooledRide(options: RideOptions, threads: number): Promise<Ride> {
    let pool: Pool | null = null;
    const ride = build(options, async (module, memory, stackTop) => {
        pool = await createPool(module, memory, Math.min(threads, maxWorkers(KERNEL_STACK_SIZE)), stackTop, KERNEL_STACK_SIZE);
        return pool;
    });
    await ride.ready;
    return ride.ride;
}

function build(
    options: RideOptions,
    spawn: ((module: WebAssembly.Module, memory: WebAssembly.Memory, stackTop: number) => Promise<Pool>) | null,
): Ride & { ride: Ride; ready: Promise<void> } {
    const chunk = options.chunk ?? CHUNK;
    const spacing = options.spacing ?? DEFAULT_SPACING;
    const tickCap = options.ticks * chunk;
    const poseCap = options.poses * chunk;
    if (!(Number.isInteger(tickCap) && tickCap > 1 && Number.isInteger(poseCap) && poseCap > 0)) {
        throw new Error(`ride capacity: expected positive chunk counts, got ${options.ticks}, ${options.poses}`);
    }
    const module = kernelModule();
    const declared = WebAssembly.Module.imports(module).find((i) => i.name === "memory");
    if (!declared) throw new Error("ride kernel: the module imports no memory");

    // regions, 8-byte aligned, after the module's heap base; sized before the memory exists
    const regions = {
        inputs: tickCap * INPUT_FLOATS * 8,
        ticks: tickCap * TICK_FLOATS * 4,
        bounds: options.ticks * 9 * 8,
        sigma: tickCap * 8,
        spans: tickCap * 4,
        path0: poseCap * POSE_FLOATS * 4,
        path1: poseCap * POSE_FLOATS * 4,
        control: 4 * 4,
    };
    const probe = new WebAssembly.Memory({ initial: 128, maximum: KERNEL_MAX_MEMORY / PAGE, shared: true });
    let heap: number;
    try {
        const ex = new WebAssembly.Instance(module, { env: { memory: probe } }).exports as unknown as KernelExports;
        heap = ex.__heap_base.value as number;
    } catch (e) {
        throw new Error(`ride kernel: instantiation failed: ${String(e)}`);
    }
    const offsets = {} as Record<keyof typeof regions, number>;
    let cursor = Math.ceil(heap / 8) * 8;
    for (const [name, bytes] of Object.entries(regions) as [keyof typeof regions, number][]) {
        offsets[name] = cursor;
        cursor += Math.ceil(bytes / 8) * 8;
    }
    const pages = Math.ceil(cursor / PAGE);
    if (pages > KERNEL_MAX_MEMORY / PAGE) {
        throw new Error(`ride capacity: ${cursor} bytes exceeds the kernel's ${KERNEL_MAX_MEMORY}`);
    }
    const memory = new WebAssembly.Memory({ initial: pages, maximum: KERNEL_MAX_MEMORY / PAGE, shared: true });
    const ex = new WebAssembly.Instance(module, { env: { memory } }).exports as unknown as KernelExports;
    ex.setLayout(
        TICK_FLOATS,
        TICK_LANES.position,
        TICK_LANES.rotation,
        TICK_LANES.speed,
        TICK_LANES.distance,
        TICK_LANES.omega,
        TICK_LANES.a,
        POSE_FLOATS,
        POSE_LANES.position,
        POSE_LANES.w,
        POSE_LANES.rotation,
    );
    const boundaryFloats = ex.boundaryFloats();
    const buffer = memory.buffer;
    const inputs = new Float64Array(buffer, offsets.inputs, tickCap * INPUT_FLOATS);
    const ticks = new Float32Array(buffer, offsets.ticks, tickCap * TICK_FLOATS);
    const bounds = new Float64Array(buffer, offsets.bounds, options.ticks * boundaryFloats);
    const sigma = new Float64Array(buffer, offsets.sigma, tickCap);
    const paths = [
        new Float32Array(buffer, offsets.path0, poseCap * POSE_FLOATS),
        new Float32Array(buffer, offsets.path1, poseCap * POSE_FLOATS),
    ] as const;
    const pathOffsets = [offsets.path0, offsets.path1] as const;
    // generation, front buffer index
    const control = new Int32Array(buffer, offsets.control, 4);
    const pathHeaders: [{ count: number; length: number }, { count: number; length: number }] = [
        { count: 0, length: 0 },
        { count: 0, length: 0 },
    ];

    let pool: Pool | null = null;
    let count = 0;
    let pending = 0;
    let hasInitial = false;

    const restartChunk = () => restartFor(Math.min(pending, count), chunk);

    const resampleInto = (target: 0 | 1, threaded: boolean): number => {
        if (count < 2) throw new Error("ride resample: nothing marched");
        const spanCount = ex.resamplePrepare(offsets.ticks, count, offsets.sigma, offsets.spans);
        const length = sigma[count - 1];
        const poseCount = Math.ceil(length / spacing) + 1;
        if (poseCount > poseCap) throw new Error(`ride capacity: ${poseCount} poses exceed ${poseCap}`);
        const threads = threaded && pool ? pool.size + 1 : 1;
        ex.setResampleJob(
            offsets.ticks,
            offsets.sigma,
            offsets.spans,
            spanCount,
            pathOffsets[target],
            spacing,
            length,
            poseCount,
            chunk,
            threads,
        );
        if (threads > 1 && pool) {
            const running = pool;
            running.run(() => ex.workerMain(0));
        } else {
            ex.resampleRange(0, poseCount);
        }
        pathHeaders[target] = { count: poseCount, length };
        return poseCount;
    };

    const pathIn = (target: 0 | 1): Path => {
        const { count: poses, length } = pathHeaders[target];
        return {
            header: { version: PATH_VERSION, count: poses, spacing, length, aux: [] },
            poses: paths[target].subarray(0, poses * POSE_FLOATS),
        };
    };

    const ride: Ride = {
        memory,
        chunk,
        get workers() {
            return pool?.size ?? 0;
        },
        setInitial(state) {
            bounds.set([...state.position, ...state.rotation, state.speed, state.distance], 0);
            hasInitial = true;
            pending = 0;
        },
        setInputs(rows) {
            count = 0;
            ride.editInputs(0, rows);
            count = rows.length + 1;
        },
        editInputs(from, rows) {
            if (rows.length === 0) throw new Error("ride inputs: expected at least one row");
            if (from > Math.max(count - 1, 0)) throw new Error(`ride inputs: row ${from} leaves a gap after ${count - 1}`);
            const next = Math.max(count, from + rows.length + 1);
            if (next > tickCap) throw new Error(`ride capacity: ${next} ticks exceed ${tickCap}`);
            for (let i = 0; i < rows.length; i++) {
                const o = (from + i) * INPUT_FLOATS;
                inputs[o] = rows[i].omega[0];
                inputs[o + 1] = rows[i].omega[1];
                inputs[o + 2] = rows[i].omega[2];
                inputs[o + 3] = rows[i].a;
            }
            count = next;
            pending = Math.min(pending, editTick(from));
        },
        restartChunk,
        march() {
            if (!hasInitial) throw new Error("ride march: no initial state");
            const restart = restartChunk();
            ex.march(offsets.inputs, offsets.ticks, offsets.bounds, restart, count, 1 / options.rate, chunk);
            pending = Number.POSITIVE_INFINITY;
            return restart;
        },
        pass() {
            const front = Atomics.load(control, 1) as 0 | 1;
            const back = (1 - front) as 0 | 1;
            const previous = Atomics.load(control, 0) === 0 ? null : pathHeaders[front];
            // a pose at arclength at or below the restart boundary's reads only ticks before it
            const planned = restartChunk();
            const cleanTo = planned === 0 ? 0 : sigma[planned * chunk];
            const restart = ride.march();
            const poses = resampleInto(back, pool !== null);
            const firstPose = previous === null || cleanTo <= 0 ? 0 : Math.floor(cleanTo / spacing);
            const dirty = {
                first: Math.floor(firstPose / chunk),
                end: Math.ceil(Math.max(poses, previous?.count ?? 0) / chunk),
            };
            Atomics.store(control, 1, back);
            const generation = Atomics.add(control, 0, 1) + 1;
            return { generation, restart, dirty };
        },
        resampleInto,
        idleDispatch() {
            if (!pool) throw new Error("ride dispatch: no pool");
            const running = pool;
            ex.setResampleJob(0, 0, 0, 0, 0, spacing, 0, 0, chunk, running.size + 1);
            running.run(() => ex.workerMain(0));
        },
        generation: () => Atomics.load(control, 0),
        trajectory() {
            const header: TrajectoryHeader = {
                version: TRAJECTORY_VERSION,
                count,
                rate: options.rate,
                endReason: "complete",
                endTick: count - 1,
                constants: options.constants,
            };
            return { header, ticks: ticks.subarray(0, count * TICK_FLOATS) };
        },
        path() {
            const generation = Atomics.load(control, 0);
            if (generation === 0) throw new Error("ride path: no generation published");
            return { generation, path: readPath(pathIn(Atomics.load(control, 1) as 0 | 1)) };
        },
        pathIn,
        boundaries: () => bounds,
        async terminate() {
            await pool?.terminate();
        },
    };

    const ready = spawn
        ? spawn(module, memory, ex.__stack_pointer.value as number).then((p) => {
              pool = p;
          })
        : Promise.resolve();
    return Object.assign(ride, { ride, ready });
}
