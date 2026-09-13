// The path view: white orientation gizmos drawn straight from the pose binding. Per pose interval one
// chord from pose `i` to `i + 1`, per pose one tick along the local +Y, both screen-constant-width quads
// in the shell foreground, flat, unlit and depth-tested. One instanced draw of `count` instances with
// twelve vertices each: vertices 0-5 are the chord (collapsed on the last pose, which has no successor),
// 6-11 the tick. The quad expansion is the lines extra's kernel (`shallot/src/extras/lines/surface.ts`):
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
import { AUX_LANES, type Path, POSE_BYTES } from "./path";
import { straight } from "./straight.fixture";
import { pathUploads } from "./upload";

/** the published names of the two streams */
export const PATH_POSES = "pathPoses";
export const PATH_AUX = "pathAux";

// Gruvbox foreground #ebdbb2, sRGB bytes as the shell authors them.
const FOREGROUND = [0xeb / 255, 0xdb / 255, 0xb2 / 255, 1];
const WIDTH_PX = 2;
const VERTICES = 12;

const FLOAT_BYTES = Float32Array.BYTES_PER_ELEMENT;
// viewProj (16), resolution.xy + count + spacing (4), color (4), width + pad (4)
const UNIFORM_FLOATS = 28;
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

export const PATH_SHADER = /* wgsl */ `
struct Pose {
    position: vec3<f32>,
    w: f32,
    rotation: vec4<f32>,
}

struct PathView {
    viewProj: mat4x4<f32>,
    resolution: vec2<f32>,
    count: f32,
    spacing: f32,
    color: vec4<f32>,
    width: f32,
}

@group(0) @binding(0) var<uniform> path: PathView;
@group(0) @binding(1) var<storage, read> poses: array<Pose>;
@group(0) @binding(2) var<storage, read_write> pathProbe: atomic<u32>;

struct VSOut {
    @builtin(position) position: vec4<f32>,
    @location(0) edge: vec2<f32>,
}

const NEAR_W = 1e-5;

fn rotate(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
    let t = 2.0 * cross(q.xyz, v);
    return v + q.w * t + cross(q.xyz, t);
}

// the lines extra's kernel: constant-pixel quad corner for one world segment
fn quad(a: vec3<f32>, b: vec3<f32>, t: f32, edge: f32) -> VSOut {
    var out: VSOut;
    var sc = path.viewProj * vec4(a, 1.0);
    var ec = path.viewProj * vec4(b, 1.0);
    if (sc.w < NEAR_W && ec.w < NEAR_W) {
        out.position = vec4(0.0, 0.0, -1.0, 1.0);
        return out;
    }
    if (sc.w < NEAR_W) {
        sc = mix(sc, ec, (NEAR_W - sc.w) / (ec.w - sc.w));
    } else if (ec.w < NEAR_W) {
        ec = mix(ec, sc, (NEAR_W - ec.w) / (sc.w - ec.w));
    }
    let sNdc = sc.xy / sc.w;
    let eNdc = ec.xy / ec.w;
    let dirPx = (eNdc - sNdc) * path.resolution;
    let lenPx = length(dirPx);
    let dir = select(vec2(1.0, 0.0), dirPx / lenPx, lenPx > 1e-4);
    let perp = vec2(-dir.y, dir.x);
    let halfW = max(path.width, 1.0) * 0.5;
    let total = halfW + 1.0;
    let useEnd = t > 0.5;
    let baseNdc = select(sNdc, eNdc, useEnd);
    let baseClip = select(sc, ec, useEnd);
    let ndc = baseNdc + perp * edge * total * 2.0 / path.resolution;
    out.position = vec4(ndc, baseClip.z / baseClip.w, 1.0);
    out.edge = vec2(edge * total, halfW);
    return out;
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) iid: u32) -> VSOut {
    let corners = array<vec2<f32>, 6>(
        vec2(0.0, -1.0), vec2(1.0, -1.0), vec2(0.0, 1.0),
        vec2(0.0, 1.0), vec2(1.0, -1.0), vec2(1.0, 1.0),
    );
    let corner = corners[vi % 6u];
    let pose = poses[iid];
    if (vi < 6u) {
        if (f32(iid + 1u) >= path.count) {
            var out: VSOut;
            out.position = vec4(0.0, 0.0, -1.0, 1.0);
            return out;
        }
        return quad(pose.position, poses[iid + 1u].position, corner.x, corner.y);
    }
    let tip = pose.position + rotate(pose.rotation, vec3(0.0, 1.0, 0.0)) * path.spacing;
    return quad(pose.position, tip, corner.x, corner.y);
}

@fragment
fn fs(input: VSOut) -> @location(0) vec4<f32> {
    let w = fwidth(input.edge.x);
    let aa = 1.0 - smoothstep(input.edge.y - w, input.edge.y + w, abs(input.edge.x));
    atomicAdd(&pathProbe, 1u);
    return vec4(path.color.rgb, path.color.a * aa);
}
`;

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
        uniformData.set(viewProj, 0);
        uniformData[16] = view.width;
        uniformData[17] = view.height;
        uniformData[18] = count;
        uniformData[19] = live?.header.spacing ?? 0;
        uniformData.set(FOREGROUND, 20);
        uniformData[24] = WIDTH_PX;
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
    },
};

export const pathFixtures = { straight, hill, helix } as const;

export default PathPlugin;
