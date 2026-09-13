import { check } from "@dylanebert/shallot/harness/check";
import launch from "@dylanebert/shallot/harness/browser" with { type: "json" };
import { chromium } from "playwright";
import { POSE_FLOATS } from "../path/path";

const ORIGIN = "https://kexedit.test/";

type Evidence = {
    isolated: boolean;
    shared: boolean;
    byteOffset: number;
    expected: number[];
    got: number[];
    error: string;
};

check(
    "a SharedArrayBuffer-backed subarray reaches the GPU through writeBuffer",
    {
        claim: "a path view over shared wasm memory does not reach the GPU through queue.writeBuffer",
        size: "integration",
        requires: ["chromium"],
        subject: ["src/trajectory"],
        budget: 20_000,
    },
    async () => {
        const browser = await chromium.launch({ headless: false, ...launch });
        try {
            const page = await browser.newPage();
            // an isolated origin with no server: the navigation is fulfilled in the browser
            await page.route(`${ORIGIN}**`, (route) =>
                route.fulfill({
                    status: 200,
                    contentType: "text/html",
                    headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" },
                    body: "<!doctype html><title>shared upload</title>",
                }),
            );
            await page.goto(ORIGIN, { waitUntil: "domcontentloaded", timeout: 10_000 });
            const evidence = (await page.evaluate(async (poseFloats) => {
                const out: Evidence = { isolated: crossOriginIsolated, shared: false, byteOffset: 0, expected: [], got: [], error: "" };
                try {
                    const memory = new WebAssembly.Memory({ initial: 1, maximum: 4, shared: true });
                    const all = new Float32Array(memory.buffer);
                    for (let i = 0; i < all.length; i++) all[i] = i * 0.5 + 1;
                    const poses = 64;
                    const view = all.subarray(1024, 1024 + poses * poseFloats);
                    out.shared = view.buffer instanceof SharedArrayBuffer;
                    out.byteOffset = view.byteOffset;
                    out.expected = Array.from(view);
                    const adapter = await navigator.gpu?.requestAdapter();
                    if (!adapter) throw new Error("no WebGPU adapter");
                    const device = await adapter.requestDevice();
                    const target = device.createBuffer({ size: view.byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
                    const read = device.createBuffer({ size: view.byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
                    device.pushErrorScope("validation");
                    device.queue.writeBuffer(target, 0, view);
                    const encoder = device.createCommandEncoder();
                    encoder.copyBufferToBuffer(target, 0, read, 0, view.byteLength);
                    device.queue.submit([encoder.finish()]);
                    const scoped = await device.popErrorScope();
                    if (scoped) throw new Error(scoped.message);
                    await read.mapAsync(GPUMapMode.READ);
                    out.got = Array.from(new Float32Array(read.getMappedRange().slice(0)));
                    read.unmap();
                } catch (e) {
                    out.error = String(e);
                }
                return out;
            }, POSE_FLOATS)) as Evidence;
            if (evidence.error) throw new Error(`upload failed: ${evidence.error}`);
            if (!evidence.isolated || !evidence.shared || evidence.byteOffset === 0) {
                throw new Error(`source is not an offset shared view: ${JSON.stringify({ ...evidence, expected: [], got: [] })}`);
            }
            if (evidence.expected.length !== 64 * POSE_FLOATS || evidence.got.length !== evidence.expected.length) {
                throw new Error(`read back ${evidence.got.length} floats of ${evidence.expected.length}`);
            }
            const at = evidence.got.findIndex((v, i) => v !== evidence.expected[i]);
            if (at >= 0) throw new Error(`float ${at}: GPU holds ${evidence.got[at]}, view holds ${evidence.expected[at]}`);
        } finally {
            await browser.close();
        }
    },
);
