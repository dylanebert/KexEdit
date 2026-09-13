// The path view's WGSL. Struct layouts are resolved from the typegpu schemas, so the pose stride and the
// uniform size have one authored source.

import tgpu from "typegpu";
import * as d from "typegpu/data";
import { Pose } from "./path";

export const PathUniform = d.struct({
    viewProj: d.mat4x4f,
    resolution: d.vec2f,
    count: d.f32,
    spacing: d.f32,
    chord: d.vec4f,
    lateral: d.vec4f,
    normal: d.vec4f,
    width: d.f32,
});

export const UNIFORM_FLOATS = d.sizeOf(PathUniform) / Float32Array.BYTES_PER_ELEMENT;

const BODY = /* wgsl */ `
@group(0) @binding(0) var<uniform> path: PathView;
@group(0) @binding(1) var<storage, read> poses: array<Pose>;
@group(0) @binding(2) var<storage, read_write> pathProbe: atomic<u32>;

struct VSOut {
    @builtin(position) position: vec4<f32>,
    @location(0) edge: vec2<f32>,
    @location(1) color: vec4<f32>,
}

const NEAR_W = 1e-5;

fn rotate(q: vec4<f32>, v: vec3<f32>) -> vec3<f32> {
    let t = 2.0 * cross(q.xyz, v);
    return v + q.w * t + cross(q.xyz, t);
}

// the lines extra's kernel: constant-pixel quad corner for one world segment
fn quad(a: vec3<f32>, b: vec3<f32>, t: f32, edge: f32, color: vec4<f32>) -> VSOut {
    var out: VSOut;
    out.color = color;
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
        return quad(pose.position, poses[iid + 1u].position, corner.x, corner.y, path.chord);
    }
    if (vi < 12u) {
        let side = pose.position + rotate(pose.rotation, vec3(1.0, 0.0, 0.0)) * path.spacing;
        return quad(pose.position, side, corner.x, corner.y, path.lateral);
    }
    let tip = pose.position + rotate(pose.rotation, vec3(0.0, 1.0, 0.0)) * path.spacing;
    return quad(pose.position, tip, corner.x, corner.y, path.normal);
}

@fragment
fn fs(input: VSOut) -> @location(0) vec4<f32> {
    let w = fwidth(input.edge.x);
    let aa = 1.0 - smoothstep(input.edge.y - w, input.edge.y + w, abs(input.edge.x));
    atomicAdd(&pathProbe, 1u);
    return vec4(input.color.rgb, input.color.a * aa);
}
`;

export const PATH_SHADER = tgpu.resolve({ template: BODY, externals: { Pose, PathView: PathUniform } });
