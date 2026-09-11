import {
    Camera,
    Compute,
    invert,
    Transform,
    type Plugin,
    type State,
    type System,
} from "@dylanebert/shallot";
import { GlazePlugin, GlazeSystem } from "@dylanebert/shallot/glaze";
import {
    ColorSystem,
    DEPTH_FORMAT,
    SearPlugin,
} from "@dylanebert/shallot/sear";
import {
    computeViewProj,
    Render,
    RenderPlugin,
    type View,
    Views,
} from "@dylanebert/shallot/render";

// The editor grid is a fullscreen material, not a collection of CPU line segments. It is ported from
// Shallot's removed editor viewport at 7e859147^ and keeps its ground-ray, derivative-AA and reverse-Z
// depth contract while targeting KexEdit's forward renderer seam.
const GRID_UNIFORM_FLOATS = 48;
const GRID_UNIFORM_BYTES = GRID_UNIFORM_FLOATS * 4;
const GRID_PROBE_BYTES = 4;
const GRID_PROBE_ZERO = new Uint32Array([0]);

// Unity-like world axes on the XZ ground plane: X is red and Z is blue. There is no Y axis
// material because this pass only represents the ground plane.
export const GRID_MATERIAL_CONTRACT = {
    neutral: [0.28, 0.34, 0.4, 1],
    axisX: [0.9, 0.12, 0.1, 1],
    axisZ: [0.12, 0.32, 0.95, 1],
    hasYAxis: false,
} as const;

const GRID_SHADER = /* wgsl */ `
struct Grid {
    viewProj: mat4x4<f32>,
    invViewProj: mat4x4<f32>,
    camPos: vec4<f32>,
    gridColor: vec4<f32>,
    axisXColor: vec4<f32>,
    axisZColor: vec4<f32>,
}

@group(0) @binding(0) var<uniform> grid: Grid;
@group(0) @binding(1) var<storage, read_write> gridProbe: atomic<u32>;

struct VSOut {
    @builtin(position) position: vec4<f32>,
    @location(0) nearPoint: vec3<f32>,
    @location(1) farPoint: vec3<f32>,
}

fn unproject(p: vec3<f32>) -> vec3<f32> {
    let u = grid.invViewProj * vec4(p, 1.0);
    return u.xyz / u.w;
}

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
    let pos = array<vec2<f32>, 6>(
        vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0),
        vec2(-1.0, 1.0), vec2(1.0, -1.0), vec2(1.0, 1.0),
    );
    let p = pos[vi];
    var out: VSOut;
    out.position = vec4(p, 0.0, 1.0);
    out.nearPoint = unproject(vec3(p, 0.0));
    out.farPoint = unproject(vec3(p, 1.0));
    return out;
}

struct FragOut {
    @builtin(frag_depth) depth: f32,
    @location(0) color: vec4<f32>,
}

fn line(worldPos: vec3<f32>, scale: f32) -> f32 {
    let coord = worldPos.xz / scale;
    let d = fwidth(coord);
    let g = abs(fract(coord - 0.5) - 0.5) / d;
    return 1.0 - min(min(g.x, g.y), 1.0);
}

@fragment
fn fs(input: VSOut) -> FragOut {
    let t = -input.nearPoint.y / (input.farPoint.y - input.nearPoint.y);
    if (t < 0.0) { discard; }

    let worldPos = input.nearPoint + t * (input.farPoint - input.nearPoint);
    let clip = grid.viewProj * vec4(worldPos, 1.0);
    let depth = clip.z / clip.w;
    if (depth < 0.0 || depth > 1.0) { discard; }

    let dist = length(worldPos.xz - grid.camPos.xz);
    let fade = 1.0 - smoothstep(20.0, 80.0, dist);
    if (fade <= 0.0) { discard; }

    let minor = line(worldPos, 1.0);
    let major = line(worldPos, 10.0);
    let l = max(minor * 0.12, major * 0.22);
    if (l < 0.01) { discard; }

    var color = grid.gridColor.rgb;
    var alpha = l * fade;
    let aw = fwidth(worldPos.xz);
    let xAxis = 1.0 - min(abs(worldPos.z) / aw.y, 1.0);
    let zAxis = 1.0 - min(abs(worldPos.x) / aw.x, 1.0);
    if (xAxis > 0.01) {
        color = mix(color, grid.axisXColor.rgb, xAxis);
        alpha = max(alpha, xAxis * 0.72 * fade);
    }
    if (zAxis > 0.01) {
        color = mix(color, grid.axisZColor.rgb, zAxis);
        alpha = max(alpha, zAxis * 0.72 * fade);
    }

    atomicAdd(&gridProbe, 1u);
    var out: FragOut;
    out.depth = depth;
    out.color = vec4(color, alpha);
    return out;
}
`;

const ALPHA_BLEND: GPUBlendState = {
    color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
};

type GridGpu = {
    pipeline: GPURenderPipeline | null;
    layout: GPUBindGroupLayout | null;
    uniform: GPUBuffer | null;
    probe: GPUBuffer | null;
    readback: GPUBuffer | null;
    bindGroup: GPUBindGroup | null;
};

const grid: GridGpu = {
    pipeline: null,
    layout: null,
    uniform: null,
    probe: null,
    readback: null,
    bindGroup: null,
};

const gridData = new Float32Array(GRID_UNIFORM_FLOATS);
const viewProj = new Float32Array(16);
const invViewProj = new Float32Array(16);

function drawGrid(eid: number, view: View): void {
    const device = Compute.device;
    const encoder = Render.encoder;
    if (!device || !encoder || !grid.pipeline || !grid.uniform || !grid.probe || !grid.readback || !grid.layout) return;
    if (!view.framebuffer || !view.depth || view.width === 0 || view.height === 0) return;

    computeViewProj(eid, view.width / view.height, viewProj);
    invert(viewProj, invViewProj);
    gridData.set(viewProj, 0);
    gridData.set(invViewProj, 16);
    gridData[32] = Transform.pos.x.get(eid);
    gridData[33] = Transform.pos.y.get(eid);
    gridData[34] = Transform.pos.z.get(eid);
    // Neutral hierarchy stays restrained; the two ground-plane axes carry the only strong accents.
    gridData.set(GRID_MATERIAL_CONTRACT.neutral, 36);
    gridData.set(GRID_MATERIAL_CONTRACT.axisX, 40);
    gridData.set(GRID_MATERIAL_CONTRACT.axisZ, 44);
    device.queue.writeBuffer(grid.uniform, 0, gridData);
    device.queue.writeBuffer(grid.probe, 0, GRID_PROBE_ZERO);

    if (!grid.bindGroup) {
        grid.bindGroup = device.createBindGroup({
            label: "kexedit-grid",
            layout: grid.layout,
            entries: [
                { binding: 0, resource: { buffer: grid.uniform } },
                { binding: 1, resource: { buffer: grid.probe } },
            ],
        });
    }

    const pass = encoder.beginRenderPass({
        label: "kexedit-grid",
        colorAttachments: [{ view: view.framebuffer, loadOp: "load", storeOp: "store" }],
        depthStencilAttachment: { view: view.depth, depthLoadOp: "load", depthStoreOp: "store" },
    });
    pass.setPipeline(grid.pipeline);
    pass.setBindGroup(0, grid.bindGroup);
    pass.draw(6);
    pass.end();
    // This readback is the integration probe: the fragment shader itself increments the storage counter,
    // so a positive sample count cannot be supplied by a proxy flag or an upstream draw call.
    encoder.copyBufferToBuffer(grid.probe, 0, grid.readback, 0, GRID_PROBE_BYTES);
}

export type GridProbe = { samples: number; drawn: boolean };

export type GridMaterialContract = {
    present: boolean;
    neutral: number[];
    axisX: number[];
    axisZ: number[];
    hasYAxis: false;
};

export function readGridMaterialContract(): GridMaterialContract {
    return {
        present: Boolean(grid.pipeline && grid.uniform && grid.probe && grid.layout),
        neutral: [...GRID_MATERIAL_CONTRACT.neutral],
        axisX: [...GRID_MATERIAL_CONTRACT.axisX],
        axisZ: [...GRID_MATERIAL_CONTRACT.axisZ],
        hasYAxis: false,
    };
}

let probeRead: Promise<GridProbe> | null = null;

export async function readGridProbe(): Promise<GridProbe> {
    if (probeRead) return probeRead;
    const readback = grid.readback;
    const device = Compute.device;
    if (!readback || !device) return { samples: 0, drawn: false };
    probeRead = (async () => {
        await device.queue.onSubmittedWorkDone();
        await readback.mapAsync(GPUMapMode.READ);
        const samples = new Uint32Array(readback.getMappedRange())[0] ?? 0;
        readback.unmap();
        return { samples, drawn: samples > 0 };
    })().finally(() => {
        probeRead = null;
    });
    return probeRead;
}

const GridSystem: System = {
    name: "kexedit-grid",
    group: "draw",
    after: [ColorSystem],
    before: [GlazeSystem],
    update(state: State) {
        for (const eid of state.query([Camera])) {
            const view = Views.get(eid);
            if (view) drawGrid(eid, view);
        }
    },
};

export const GridPlugin: Plugin = {
    name: "KexEditGrid",
    systems: [GridSystem],
    dependencies: [RenderPlugin, SearPlugin, GlazePlugin],
    async warm() {
        const device = Compute.device;
        if (!device) return;
        const module = device.createShaderModule({ label: "kexedit-grid", code: GRID_SHADER });
        grid.layout = device.createBindGroupLayout({
            label: "kexedit-grid",
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: "uniform" },
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: "storage" },
                },
            ],
        });
        grid.uniform?.destroy();
        grid.uniform = device.createBuffer({
            label: "kexedit-grid-uniform",
            size: GRID_UNIFORM_BYTES,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        grid.probe?.destroy();
        grid.probe = device.createBuffer({
            label: "kexedit-grid-probe",
            size: GRID_PROBE_BYTES,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });
        grid.readback?.destroy();
        grid.readback = device.createBuffer({
            label: "kexedit-grid-probe-readback",
            size: GRID_PROBE_BYTES,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
        grid.bindGroup = null;
        grid.pipeline = await device.createRenderPipelineAsync({
            label: "kexedit-grid",
            layout: device.createPipelineLayout({ bindGroupLayouts: [grid.layout] }),
            vertex: { module, entryPoint: "vs" },
            fragment: {
                module,
                entryPoint: "fs",
                targets: [{ format: Render.format, blend: ALPHA_BLEND }],
            },
            depthStencil: {
                format: DEPTH_FORMAT,
                depthCompare: "greater-equal",
                depthWriteEnabled: false,
            },
            primitive: { topology: "triangle-list" },
        });
    },
    dispose() {
        grid.uniform?.destroy();
        grid.probe?.destroy();
        grid.readback?.destroy();
        grid.uniform = null;
        grid.probe = null;
        grid.readback = null;
        grid.pipeline = null;
        grid.layout = null;
        grid.bindGroup = null;
        probeRead = null;
    },
};

export { GRID_SHADER };
