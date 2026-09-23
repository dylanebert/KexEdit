// The path view: orientation gizmos drawn straight from the pose binding. Per pose interval one chord
// from pose `i` to `i + 1` in the shell foreground, per pose a lateral tick along local +X in neutral red
// and a normal tick along local +Y in the derived axis green, all screen-constant-width quads, flat, unlit and
// depth-tested. One instanced draw of `count` instances with eighteen vertices each: vertices 0-5 are
// the chord (collapsed on the last pose, which has no successor), 6-11 the lateral tick, 12-17 the normal. The quad expansion is the lines extra's kernel (`shallot/src/extras/lines/surface.ts`):
// project both endpoints, pull one behind the near plane onto it, offset perpendicular in pixels.
//
// The path drawn is a ride's: the scene's fixture names the integrated ride, whose intent table the
// policies march into inputs, or a closed-form trajectory whose stored inputs are re-marched. Either is
// marched on the calling thread, resampled, and uploaded whole from the ride's shared memory. A train
// Part stands at the trajectory tick the ride transport names, set each frame before draw.
//
// The plugin takes the engine's draw-plugin shape: it owns its buffers and pipeline, runs in `draw`
// after `ColorSystem` and before `GlazeSystem`.

import {
    Camera,
    Color,
    Compute,
    Part,
    type Plugin,
    type State,
    type System,
    sparse,
    Transform,
    u8,
    unpackColor,
} from "@dylanebert/shallot";
import { GlazePlugin, GlazeSystem } from "@dylanebert/shallot/glaze";
import { computeViewProj, Render, RenderPlugin, type View, Views } from "@dylanebert/shallot/rendering";
import { ColorSystem, DEPTH_FORMAT, SearPlugin } from "@dylanebert/shallot/standard/rendering";
import * as d from "typegpu/data";
import { AUX_LANES, type Path, POSE_BYTES } from "./path";
import * as trajectoryFixtures from "../trajectory/fixtures.fixture";
import { Train, RideHeader, Transport, createRideEntity, readRide, rides, type RideEntity } from "../trajectory/ride";
import { type Input, type State as MarchState } from "../trajectory/integrator";
import { CHUNK, createRide, type Ride } from "../trajectory/execution";
import { DEFAULT_SPACING } from "../trajectory/resample";
import { RIDE_CONSTANTS, RIDE_INTENTS, RIDE_INTENTS_STALLED, RIDE_RATE, RIDE_START } from "../trajectory/ride.fixture";
import { initialState, intentTable } from "../trajectory/train";
import { advance, placeAt, scrub } from "../trajectory/transport";
import type { RideConstants, Trajectory } from "../trajectory/trajectory";
import { PATH_SHADER, PathUniform, UNIFORM_FLOATS } from "./shader";
import { pathUploads } from "./upload";

/** the published names of the two streams */
export const PATH_POSES = "pathPoses";
export const PATH_AUX = "pathAux";

// Gruvbox foreground and neutral red as sRGB bytes.
export const PATH_BYTES = { chord: 0xebdbb2, lateral: 0xcc241d } as const;
// The scene target is linear and the composite encodes to sRGB, so bytes decode through Shallot's own curve.
const linear = (rgb: number) => {
    const { r, g, b } = unpackColor(rgb);
    return [r, g, b, 1];
};
/** OKLCH (hue in degrees) to linear sRGB with alpha, through Ottosson's OKLab matrices; throws out of gamut */
export function oklch(l: number, c: number, h: number): number[] {
    const a = c * Math.cos((h * Math.PI) / 180);
    const b = c * Math.sin((h * Math.PI) / 180);
    const L = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const M = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const S = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const rgb = [
        4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
        -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
        -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
    ];
    if (rgb.some((v) => v < 0 || v > 1)) throw new Error(`oklch(${l}, ${c}, ${h}) is out of sRGB gamut`);
    return [...rgb, 1];
}
/** an sRGB byte to OKLCH `[l, c, h]` (hue in degrees), the inverse of `oklch` */
export function byteOklch(rgb: number): number[] {
    const [r, g, b] = linear(rgb);
    const L = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const M = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const S = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const l = 0.2104542553 * L + 0.793617785 * M - 0.0040720468 * S;
    const A = 1.9779984951 * L - 2.428592205 * M + 0.4505937099 * S;
    const B = 0.0259040371 * L + 0.7827717662 * M - 0.808675766 * S;
    const h = (Math.atan2(B, A) * 180) / Math.PI;
    return [l, Math.hypot(A, B), h < 0 ? h + 360 : h];
}
// Gruvbox neutral green and neutral aqua, the swatches the axis green's hue falls between.
export const SPECTRUM_BYTES = { green: 0x98971a, aqua: 0x689d6a } as const;
const AXIS_HUE = 142;
/** the Gruvbox spectrum's lightness and chroma, linear in hue between green and aqua, read at the axis hue */
function spectrumGreen(): number[] {
    const [l0, c0, h0] = byteOklch(SPECTRUM_BYTES.green);
    const [l1, c1, h1] = byteOklch(SPECTRUM_BYTES.aqua);
    const t = (AXIS_HUE - h0) / (h1 - h0);
    return oklch(l0 + (l1 - l0) * t, c0 + (c1 - c0) * t, AXIS_HUE);
}
/** the linear colors the uniform carries; the normal is the spectrum green at hue 142°, #6b9d65 */
const PATH_COLORS = {
    chord: linear(PATH_BYTES.chord),
    lateral: linear(PATH_BYTES.lateral),
    normal: spectrumGreen(),
} as const;
const WIDTH_PX = 2;
const VERTICES = 18;

const FLOAT_BYTES = Float32Array.BYTES_PER_ELEMENT;
const UNIFORM_BYTES = UNIFORM_FLOATS * FLOAT_BYTES;

export const PathFixture = { Straight: 0, Hill: 1, Ride: 2, Stalled: 3 } as const;

/** What a ride marches: a start state and one input row per tick after it, at a rate under constants. */
interface RideSource {
    initial: MarchState;
    inputs: readonly Input[];
    rate: number;
    constants: RideConstants;
}

// a closed-form trajectory's stored inputs, re-marched as they are
const closedForm = (fixture: Trajectory): RideSource => ({
    initial: initialState(fixture),
    inputs: intentTable(fixture),
    rate: fixture.header.rate,
    constants: fixture.header.constants,
});

const FIXTURES: Record<number, () => RideSource> = {
    [PathFixture.Straight]: () => closedForm(trajectoryFixtures.straight),
    [PathFixture.Hill]: () => closedForm(trajectoryFixtures.hill),
};

/** a scene handle naming the fixture whose intent the view's ride marches at boot */
export const PathView = { fixture: sparse(u8) };

// Train scale along local X, Y and Z (forward is -Z); a stand-in with no look.
const TRAIN_SCALE = [0.6, 0.4, 1.6] as const;

/** March a closed-form fixture into an execution ride for the legacy fixture selector. */
function marchRide(source: RideSource): Ride {
    const count = source.inputs.length + 1;
    let speed = Math.abs(source.initial.speed);
    let length = 0;
    for (const { a } of source.inputs) {
        speed += Math.abs(a) / source.rate;
        length += speed / source.rate;
    }
    const ride = createRide({
        ticks: Math.ceil((count + 1) / CHUNK),
        poses: Math.max(1, Math.ceil((length / DEFAULT_SPACING + 2) / CHUNK)),
        rate: source.rate,
        constants: source.constants,
    });
    ride.setInitial(source.initial);
    ride.setInputs(source.inputs);
    ride.pass();
    return ride;
}

function attachRide(state: State, ride: Ride, length: number, rate: number): number {
    const eid = state.create();
    state.add(eid, RideHeader);
    state.add(eid, Transport);
    RideHeader.length.set(eid, length);
    RideHeader.count.set(eid, ride.trajectory().header.count);
    RideHeader.rate.set(eid, rate);
    RideHeader.endReason.set(eid, 0);
    RideHeader.endTick.set(eid, ride.trajectory().header.endTick);
    RideHeader.generation.set(eid, 0);
    Transport.playhead.set(eid, 0);
    Transport.playing.set(eid, 0);
    Transport.rate.set(eid, 1);
    // Reserved compatibility data: playback is unconditionally looping in the timeline surface.
    Transport.loop.set(eid, 1);
    rides.set(eid, ride);
    return eid;
}

function createFixtureRide(state: State, fixture: PathFixtureValue): number {
    if (fixture === PathFixture.Ride || fixture === PathFixture.Stalled) {
        const intents = fixture === PathFixture.Stalled ? RIDE_INTENTS_STALLED : RIDE_INTENTS;
        return createRideEntity(state, {
            length: intents.length,
            intents,
            initial: RIDE_START,
            rate: RIDE_RATE,
            constants: RIDE_CONSTANTS,
        });
    }
    const source = FIXTURES[fixture]();
    return attachRide(state, marchRide(source), source.inputs.length, source.rate);
}

type PathFixtureValue = (typeof PathFixture)[keyof typeof PathFixture];

function trainFor(state: State, rideEid: number): number {
    for (const eid of state.query([Train, Transform])) {
        if (Train.ride.get(eid) === rideEid) return eid;
    }
    const eid = state.create();
    state.add(eid, Train);
    state.add(eid, Transform);
    state.add(eid, Part);
    state.add(eid, Color);
    Train.ride.set(eid, rideEid);
    Train.offset.set(eid, 0);
    Transform.scale.set(eid, TRAIN_SCALE[0], TRAIN_SCALE[1], TRAIN_SCALE[2], 0);
    const [r, g, b] = PATH_COLORS.chord;
    Color.rgba.set(eid, r, g, b, 1);
    return eid;
}

/** Read the train entity and its ride's transport state; null before the plugin warm phase. */
function readTrain(state: State): {
    rideEid: number;
    header: { length: number; count: number; rate: number; endReason: string; endTick: number; generation: number };
    refusal?: RideEntity["refusal"];
    transport: { playhead: number; playing: boolean; rate: number; loop: boolean };
} | null {
    for (const eid of state.query([Train, Transform])) {
        const rideEid = Train.ride.get(eid);
        if (!state.exists(rideEid) || !rides.has(rideEid)) continue;
        const ride = readRide(state, rideEid);
        return { rideEid, header: ride.header, refusal: ride.refusal, transport: ride.transport };
    }
    return null;
}

export interface TransportSnapshot {
    playhead: number;
    length: number;
    headerRate: number;
    playing: boolean;
    rate: number;
    loop: boolean;
    endReason: string;
    endTick: number;
    refusal?: RideEntity["refusal"];
    held: boolean;
}

type TransportListener = (snapshot: TransportSnapshot | null) => void;

let transportState: State | null = null;
let transportSnapshot: TransportSnapshot | null = null;
const transportListeners = new Set<TransportListener>();

function readTransportSnapshot(state: State): TransportSnapshot | null {
    const train = readTrain(state);
    if (!train) return null;
    return {
        playhead: train.transport.playhead,
        length: train.header.length,
        headerRate: train.header.rate,
        playing: train.transport.playing,
        rate: train.transport.rate,
        loop: train.transport.loop,
        endReason: train.header.endReason,
        endTick: train.header.endTick,
        refusal: train.refusal,
        held: train.header.endReason !== "complete" && train.transport.playhead > train.header.endTick,
    };
}

function publishTransport(state: State): void {
    transportSnapshot = readTransportSnapshot(state);
    for (const listener of transportListeners) listener(transportSnapshot);
}

function writeTransport(action: (state: State) => void): void {
    if (!transportState) return;
    action(transportState);
    publishTransport(transportState);
}

/** The sole Svelte-to-ECS seam for transport state and controls. */
export const transport = {
    subscribe(listener: TransportListener): () => void {
        transportListeners.add(listener);
        listener(transportSnapshot);
        return () => transportListeners.delete(listener);
    },
    snapshot: () => transportSnapshot,
    togglePlaying: () => writeTransport((state) => setRidePlaying(state, !transportSnapshot?.playing)),
    setPlaying: (playing: boolean) => writeTransport((state) => setRidePlaying(state, playing)),
    setRate: (rate: number) => writeTransport((state) => setRideRate(state, rate)),
    scrub: (playhead: number) => writeTransport((state) => scrubRide(state, playhead)),
};

export function bindTransport(state: State): void {
    transportState = state;
    publishTransport(state);
}

function unbindTransport(state: State): void {
    if (transportState !== state) return;
    transportState = null;
    transportSnapshot = null;
    for (const listener of transportListeners) listener(null);
}

/** Harness seam for transport controls; the Svelte layer does not reach into ECS fields directly. */
function setRidePlaying(state: State, playing: boolean): boolean | null {
    const train = readTrain(state);
    if (!train) return null;
    Transport.playing.set(train.rideEid, playing ? 1 : 0);
    return playing;
}

function setRideRate(state: State, rate: number): number | null {
    if (!(Number.isFinite(rate) && rate >= 0)) throw new Error(`transport rate: expected finite >= 0, got ${rate}`);
    const train = readTrain(state);
    if (!train) return null;
    Transport.rate.set(train.rideEid, rate);
    return rate;
}

/** Harness seam for authored scrubbing; Svelte never reaches into ECS fields directly. */
function scrubRide(state: State, playhead: number): number | null {
    const train = readTrain(state);
    if (!train) return null;
    const value = scrub(playhead, train.header);
    Transport.playhead.set(train.rideEid, value);
    return value;
}

/** The transport owns virtual time; the engine's pause and timescale remain untouched. */
export const TransportSystem: System = {
    name: "kexedit-transport",
    group: "simulation",
    update(state: State) {
        for (const eid of state.query([RideHeader, Transport])) {
            const next = advance(
                {
                    playhead: Transport.playhead.get(eid),
                    playing: Transport.playing.get(eid) !== 0,
                    rate: Transport.rate.get(eid),
                    loop: Transport.loop.get(eid) !== 0,
                },
                { length: RideHeader.length.get(eid), rate: RideHeader.rate.get(eid) },
                state.time.deltaTime,
            );
            Transport.playhead.set(eid, next.playhead);
            Transport.playing.set(eid, next.playing ? 1 : 0);
        }
        publishTransport(state);
    },
};

/** Place every train at its ride's discrete transport tick, never beyond the marched prefix. */
export const TrainSystem: System = {
    name: "kexedit-train",
    group: "simulation",
    after: [TransportSystem],
    update(state: State) {
        for (const eid of state.query([Train, Transform])) {
            const rideEid = Train.ride.get(eid);
            const ride = rides.get(rideEid);
            if (!ride || !state.exists(rideEid)) continue;
            const playhead = Transport.playhead.get(rideEid);
            const { position, rotation } = placeAt(ride.trajectory(), playhead, Train.offset.get(eid));
            const header = RideHeader.endReason.get(rideEid);
            const held = header !== 0 && playhead > RideHeader.endTick.get(rideEid);
            const [r, g, b] = PATH_COLORS.chord;
            Transform.pos.set(eid, position[0], position[1], position[2], 0);
            Transform.rot.set(eid, rotation[0], rotation[1], rotation[2], rotation[3]);
            Color.rgba.set(eid, r, g, b, held ? 0.34 : 1);
        }
    },
};


const ALPHA_BLEND: GPUBlendState = {
    color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
};

type PathGpu = {
    pipeline: GPURenderPipeline | null;
    layout: GPUBindGroupLayout | null;
    uniform: GPUBuffer | null;
    poses: GPUBuffer | null;
    aux: GPUBuffer | null;
    bindGroup: GPUBindGroup | null;
};

const gpu: PathGpu = {
    pipeline: null,
    layout: null,
    uniform: null,
    poses: null,
    aux: null,
    bindGroup: null,
};

const uploads = pathUploads();
const uniformData = new Float32Array(UNIFORM_FLOATS);
const lane = (bytes: number) => bytes / FLOAT_BYTES;
const U = {
    viewProj: lane(d.memoryLayoutOf(PathUniform, (u) => u.viewProj).offset),
    resolution: lane(d.memoryLayoutOf(PathUniform, (u) => u.resolution).offset),
    count: lane(d.memoryLayoutOf(PathUniform, (u) => u.count).offset),
    spacing: lane(d.memoryLayoutOf(PathUniform, (u) => u.spacing).offset),
    chord: lane(d.memoryLayoutOf(PathUniform, (u) => u.chord).offset),
    lateral: lane(d.memoryLayoutOf(PathUniform, (u) => u.lateral).offset),
    normal: lane(d.memoryLayoutOf(PathUniform, (u) => u.normal).offset),
    width: lane(d.memoryLayoutOf(PathUniform, (u) => u.width).offset),
};
const viewProj = new Float32Array(16);

/** Validate and stage a path; the next drawn frame writes each stream whole. */
function setPath(path: Path): void {
    uploads.set(path);
}

// Grow and republish under the same name; the stale buffer dies after the queue drains.
function ensure(
    device: GPUDevice,
    current: GPUBuffer | null,
    name: string,
    bytes: number,
): GPUBuffer {
    if (current && current.size >= bytes) return current;
    let size = current ? current.size : POSE_BYTES;
    while (size < bytes) size *= 2;
    const next = device.createBuffer({
        label: `kexedit-${name}`,
        size,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    Compute.buffers.set(name, next);
    if (current) {
        const stale = current;
        device.queue.onSubmittedWorkDone().then(() => stale.destroy());
    }
    gpu.bindGroup = null;
    return next;
}

function flush(device: GPUDevice): void {
    uploads.flush({
        poses(data) {
            gpu.poses = ensure(device, gpu.poses, PATH_POSES, Math.max(data.byteLength, POSE_BYTES));
            device.queue.writeBuffer(gpu.poses, 0, data.buffer, data.byteOffset, data.byteLength);
        },
        aux(data) {
            if (!data) {
                retract(PATH_AUX, gpu.aux);
                gpu.aux = null;
                return;
            }
            const floor = AUX_LANES * FLOAT_BYTES;
            gpu.aux = ensure(device, gpu.aux, PATH_AUX, Math.max(data.byteLength, floor));
            device.queue.writeBuffer(gpu.aux, 0, data.buffer, data.byteOffset, data.byteLength);
        },
    });
}

function retract(name: string, buffer: GPUBuffer | null): void {
    if (buffer && Compute.buffers?.get(name) === buffer) Compute.buffers.delete(name);
    buffer?.destroy();
}

function drawPath(eid: number, view: View): void {
    const device = Compute.device;
    const encoder = Render.encoder;
    if (!device || !encoder || !gpu.pipeline || !gpu.layout || !gpu.uniform) return;
    if (!view.framebuffer || !view.depth || view.width === 0 || view.height === 0) return;

    const live = uploads.path;
    const count = live?.header.count ?? 0;
    if (gpu.poses && count > 0) {
        computeViewProj(eid, view.width / view.height, viewProj);
        uniformData.set(viewProj, U.viewProj);
        uniformData[U.resolution] = view.width;
        uniformData[U.resolution + 1] = view.height;
        uniformData[U.count] = count;
        uniformData[U.spacing] = live?.header.spacing ?? 0;
        uniformData.set(PATH_COLORS.chord, U.chord);
        uniformData.set(PATH_COLORS.lateral, U.lateral);
        uniformData.set(PATH_COLORS.normal, U.normal);
        uniformData[U.width] = WIDTH_PX;
        device.queue.writeBuffer(gpu.uniform, 0, uniformData);

        if (!gpu.bindGroup) {
            gpu.bindGroup = device.createBindGroup({
                label: "kexedit-path",
                layout: gpu.layout,
                entries: [
                    { binding: 0, resource: { buffer: gpu.uniform } },
                    { binding: 1, resource: { buffer: gpu.poses } },
                ],
            });
        }
        const pass = encoder.beginRenderPass({
            label: "kexedit-path",
            colorAttachments: [{ view: view.framebuffer, loadOp: "load", storeOp: "store" }],
            depthStencilAttachment: { view: view.depth, depthLoadOp: "load", depthStoreOp: "store" },
        });
        pass.setPipeline(gpu.pipeline);
        pass.setBindGroup(0, gpu.bindGroup);
        pass.draw(VERTICES, count);
        pass.end();
    }
}

export const PathSystem: System = {
    name: "kexedit-path",
    group: "draw",
    after: [ColorSystem],
    before: [GlazeSystem],
    update(state: State) {
        const device = Compute.device;
        if (!device) return;
        // A ride publishes a new shared-memory path atomically. The view records only the generation it
        // has seen; the upload remains whole-buffer, while the ride and its header stay the source of truth.
        for (const rideEid of state.query([RideHeader])) {
            const ride = rides.get(rideEid);
            if (!ride) continue;
            const generation = ride.generation();
            if (RideHeader.generation.get(rideEid) === generation) continue;
            const published = ride.path();
            setPath(published.path);
            RideHeader.generation.set(rideEid, published.generation);
        }
        flush(device);
        for (const eid of state.query([Camera])) {
            const view = Views.get(eid);
            if (view) drawPath(eid, view);
        }
    },
};

function release(): void {
    retract(PATH_POSES, gpu.poses);
    retract(PATH_AUX, gpu.aux);
    gpu.uniform?.destroy();
    gpu.poses = null;
    gpu.aux = null;
    gpu.uniform = null;
    gpu.pipeline = null;
    gpu.layout = null;
    gpu.bindGroup = null;
}

export const PathPlugin: Plugin = {
    name: "KexEditPath",
    systems: [TransportSystem, TrainSystem, PathSystem],
    components: { PathView },
    traits: { PathView: { defaults: () => ({ fixture: PathFixture.Ride }), enums: { fixture: PathFixture } } },
    dependencies: [RenderPlugin, SearPlugin, GlazePlugin],
    async warm(state: State) {
        const device = Compute.device;
        if (!device) return;
        // warm re-runs on an in-place rebuild without dispose; release first so nothing is left behind
        release();
        // the rebuild dropped the GPU streams; a path set before it uploads again unless a fixture replaces it
        uploads.restage();
        const module = device.createShaderModule({ label: "kexedit-path", code: PATH_SHADER });
        gpu.layout = device.createBindGroupLayout({
            label: "kexedit-path",
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
                { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
            ],
        });
        gpu.uniform = device.createBuffer({
            label: "kexedit-path-uniform",
            size: UNIFORM_BYTES,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        gpu.pipeline = await device.createRenderPipelineAsync({
            label: "kexedit-path",
            layout: device.createPipelineLayout({ bindGroupLayouts: [gpu.layout] }),
            vertex: { module, entryPoint: "vs" },
            fragment: { module, entryPoint: "fs", targets: [{ format: Render.format, blend: ALPHA_BLEND }] },
            depthStencil: { format: DEPTH_FORMAT, depthCompare: "greater-equal", depthWriteEnabled: true },
            primitive: { topology: "triangle-list" },
        });
        for (const eid of state.query([PathView])) {
            const configured = PathView.fixture.get(eid) as PathFixtureValue;
            const queryFixture = typeof location !== "undefined" && new URLSearchParams(location.search).get("fixture");
            const fixture = queryFixture === "stalled" ? PathFixture.Stalled : configured;
            if (!FIXTURES[fixture] && fixture !== PathFixture.Ride && fixture !== PathFixture.Stalled) {
                throw new Error(`path-view fixture: no fixture ${fixture}`);
            }
            // The ride is an ECS entity. Its execution memory is the side-table value, and the train
            // points to that entity rather than retaining a module-level train singleton.
            const rideEid = [...state.query([RideHeader])][0] ?? createFixtureRide(state, fixture);
            trainFor(state, rideEid);
            bindTransport(state);
        }
    },
    dispose(state: State) {
        unbindTransport(state);
        for (const rideEid of state.query([RideHeader])) {
            void rides.get(rideEid)?.terminate();
            rides.delete(rideEid);
        }
        release();
        uploads.reset();
    },
};

export default PathPlugin;
