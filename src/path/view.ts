// The path view: orientation gizmos drawn straight from the pose binding. Per pose interval one chord
// from pose `i` to `i + 1` in the shell foreground, per pose a lateral tick along local +X in neutral red
// and a normal tick along local +Y in neutral green, all screen-constant-width quads, flat, unlit and
// depth-tested. One instanced draw of `count` instances with eighteen vertices each: vertices 0-5 are
// the chord (collapsed on the last pose, which has no successor), 6-11 the lateral tick, 12-17 the normal. The quad expansion is the lines extra's kernel (`shallot/src/extras/lines/surface.ts`):
// project both endpoints, pull one behind the near plane onto it, offset perpendicular in pixels.
//
// The plugin takes the grid's shape (`src/grid.ts`): it owns its buffers and pipeline, runs in `draw`
// after `ColorSystem` and before `GlazeSystem`, and counts fragments in an atomic probe.

import {
    Camera,
    Compute,
    type Plugin,
    type State,
    type System,
    sparse,
    u8,
} from "@dylanebert/shallot";
import { GlazePlugin, GlazeSystem } from "@dylanebert/shallot/glaze";
import { computeViewProj, Render, RenderPlugin, type View, Views } from "@dylanebert/shallot/render";
import { ColorSystem, DEPTH_FORMAT, SearPlugin } from "@dylanebert/shallot/sear";
import { helix } from "./helix.fixture";
import { hill } from "./hill.fixture";
import * as d from "typegpu/data";
import { AUX_LANES, type Path, POSE_BYTES } from "./path";
import { straight } from "./straight.fixture";
import { PATH_SHADER, PathUniform, UNIFORM_FLOATS } from "./shader";
import { pathUploads } from "./upload";

/** the published names of the two streams */
export const PATH_POSES = "pathPoses";
export const PATH_AUX = "pathAux";

// Gruvbox foreground #ebdbb2, neutral red #cc241d, neutral green #98971a, sRGB bytes as the grid authors them.
const hex = (rgb: number) => [((rgb >> 16) & 0xff) / 255, ((rgb >> 8) & 0xff) / 255, (rgb & 0xff) / 255, 1];
const CHORD = hex(0xebdbb2);
const LATERAL = hex(0xcc241d);
const NORMAL = hex(0x98971a);
const WIDTH_PX = 2;
const VERTICES = 18;

const FLOAT_BYTES = Float32Array.BYTES_PER_ELEMENT;
const UNIFORM_BYTES = UNIFORM_FLOATS * FLOAT_BYTES;
const PROBE_BYTES = Uint32Array.BYTES_PER_ELEMENT;
const PROBE_ZERO = new Uint32Array([0]);

export const PathFixture = { Straight: 0, Hill: 1, Helix: 2 } as const;
const FIXTURES: Record<number, Path> = {
    [PathFixture.Straight]: straight,
    [PathFixture.Hill]: hill,
    [PathFixture.Helix]: helix,
};

/** a scene handle naming the fixture the view shows at boot */
export const PathView = { fixture: sparse(u8) };


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
    probe: GPUBuffer | null;
    readback: GPUBuffer | null;
    bindGroup: GPUBindGroup | null;
};

const gpu: PathGpu = {
    pipeline: null,
    layout: null,
    uniform: null,
    poses: null,
    aux: null,
    probe: null,
    readback: null,
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

/** bytes the last frame's flush uploaded; zero on a frame with no invalidation */
export const PathUploadStats = { lastFrameBytes: 0, totalBytes: 0 };

/** Validate and stage a path; the next drawn frame writes each stream whole. */
export function setPath(path: Path): void {
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
    const bytes = uploads.flush({
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
    PathUploadStats.lastFrameBytes = bytes;
    PathUploadStats.totalBytes += bytes;
}

function retract(name: string, buffer: GPUBuffer | null): void {
    if (buffer && Compute.buffers?.get(name) === buffer) Compute.buffers.delete(name);
    buffer?.destroy();
}

function drawPath(eid: number, view: View): void {
    const device = Compute.device;
    const encoder = Render.encoder;
    if (!device || !encoder || !gpu.pipeline || !gpu.layout || !gpu.uniform || !gpu.probe || !gpu.readback) return;
    if (!view.framebuffer || !view.depth || view.width === 0 || view.height === 0) return;

    device.queue.writeBuffer(gpu.probe, 0, PROBE_ZERO);
    const live = uploads.path;
    const count = live?.header.count ?? 0;
    if (gpu.poses && count > 0) {
        computeViewProj(eid, view.width / view.height, viewProj);
        uniformData.set(viewProj, U.viewProj);
        uniformData[U.resolution] = view.width;
        uniformData[U.resolution + 1] = view.height;
        uniformData[U.count] = count;
        uniformData[U.spacing] = live?.header.spacing ?? 0;
        uniformData.set(CHORD, U.chord);
        uniformData.set(LATERAL, U.lateral);
        uniformData.set(NORMAL, U.normal);
        uniformData[U.width] = WIDTH_PX;
        device.queue.writeBuffer(gpu.uniform, 0, uniformData);

        if (!gpu.bindGroup) {
            gpu.bindGroup = device.createBindGroup({
                label: "kexedit-path",
                layout: gpu.layout,
                entries: [
                    { binding: 0, resource: { buffer: gpu.uniform } },
                    { binding: 1, resource: { buffer: gpu.poses } },
                    { binding: 2, resource: { buffer: gpu.probe } },
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
    // The fragment shader increments the counter itself, so a positive count cannot come from a flag.
    encoder.copyBufferToBuffer(gpu.probe, 0, gpu.readback, 0, PROBE_BYTES);
}

export type PathProbe = { samples: number; drawn: boolean; count: number };

let probeRead: Promise<PathProbe> | null = null;

export async function readPathProbe(): Promise<PathProbe> {
    if (probeRead) return probeRead;
    const readback = gpu.readback;
    const device = Compute.device;
    const count = uploads.path?.header.count ?? 0;
    if (!readback || !device) return { samples: 0, drawn: false, count };
    probeRead = (async () => {
        await device.queue.onSubmittedWorkDone();
        await readback.mapAsync(GPUMapMode.READ);
        const samples = new Uint32Array(readback.getMappedRange())[0] ?? 0;
        readback.unmap();
        return { samples, drawn: samples > 0, count };
    })().finally(() => {
        probeRead = null;
    });
    return probeRead;
}

const PathSystem: System = {
    name: "kexedit-path",
    group: "draw",
    after: [ColorSystem],
    before: [GlazeSystem],
    update(state: State) {
        const device = Compute.device;
        if (!device) return;
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
    gpu.probe?.destroy();
    gpu.readback?.destroy();
    gpu.poses = null;
    gpu.aux = null;
    gpu.uniform = null;
    gpu.probe = null;
    gpu.readback = null;
    gpu.pipeline = null;
    gpu.layout = null;
    gpu.bindGroup = null;
    probeRead = null;
}

export const PathPlugin: Plugin = {
    name: "KexEditPath",
    systems: [PathSystem],
    components: { PathView },
    traits: { PathView: { defaults: () => ({ fixture: PathFixture.Helix }), enums: { fixture: PathFixture } } },
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
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "storage" } },
            ],
        });
        gpu.uniform = device.createBuffer({
            label: "kexedit-path-uniform",
            size: UNIFORM_BYTES,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        gpu.probe = device.createBuffer({
            label: "kexedit-path-probe",
            size: PROBE_BYTES,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });
        gpu.readback = device.createBuffer({
            label: "kexedit-path-probe-readback",
            size: PROBE_BYTES,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
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
            const path = FIXTURES[PathView.fixture.get(eid)];
            if (!path) throw new Error(`path-view fixture: no fixture ${PathView.fixture.get(eid)}`);
            setPath(path);
        }
    },
    dispose() {
        release();
        uploads.reset();
        PathUploadStats.lastFrameBytes = 0;
        PathUploadStats.totalBytes = 0;
    },
};

export const pathFixtures = { straight, hill, helix } as const;

export default PathPlugin;
