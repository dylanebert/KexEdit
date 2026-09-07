// Test preload. The `@dylanebert/shallot` barrel reads WebGPU enum globals at
// module scope (e.g. `GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT` in sear),
// so importing `track.ts` under plain `bun test` throws before any test runs.
// Define the enums — just constants, no device — so the ECS-layer tests can
// import the engine. kex2d's solver + bake are pure CPU (canvas2D viz, no
// WebGPU render path), so nothing here ever needs a real GPU device.
const g = globalThis as Record<string, unknown>;
g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
g.GPUBufferUsage ??= {
    MAP_READ: 1,
    MAP_WRITE: 2,
    COPY_SRC: 4,
    COPY_DST: 8,
    INDEX: 16,
    VERTEX: 32,
    UNIFORM: 64,
    STORAGE: 128,
    INDIRECT: 256,
    QUERY_RESOLVE: 512,
};
g.GPUTextureUsage ??= {
    COPY_SRC: 1,
    COPY_DST: 2,
    TEXTURE_BINDING: 4,
    STORAGE_BINDING: 8,
    RENDER_ATTACHMENT: 16,
};
g.GPUColorWrite ??= { RED: 1, GREEN: 2, BLUE: 4, ALPHA: 8, ALL: 15 };
g.GPUMapMode ??= { READ: 1, WRITE: 2 };
