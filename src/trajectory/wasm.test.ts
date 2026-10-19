import { expect, test } from "bun:test";
import { helixCurve } from "../path/helix.fixture";
import { poseAt, rotate } from "../path/path";
import { CHUNK, createRide } from "./execution";
import { helix } from "./fixtures.fixture";
import { initialState, intentTable } from "./train";
import { KERNEL_WASM_BASE64 } from "./kernel.wasm";

test("calling-thread WASM march and resampling follow the analytic helix in position and frame", () => {
    const ride = createRide({ ticks: Math.ceil(helix.header.count / CHUNK), poses: 1,
        rate: helix.header.rate, constants: helix.header.constants });
    ride.setInitial(initialState(helix));
    ride.setInputs(intentTable(helix));
    ride.pass();
    const path = ride.path().path;
    expect(path.header.count).toBeGreaterThan(100);
    for (let i = 0; i < path.header.count; i++) {
        const s = Math.min(i * path.header.spacing, path.header.length);
        const pose = poseAt(path, i);
        const p = helixCurve.position(s), forward = helixCurve.forward(s), up = helixCurve.up(s);
        const actualForward = rotate(pose.rotation, [0, 0, -1]), actualUp = rotate(pose.rotation, [0, 1, 0]);
        expect(Math.hypot(...pose.position.map((v, k) => v - p[k]))).toBeLessThan(0.002);
        expect(Math.hypot(...actualForward.map((v, k) => v - forward[k]))).toBeLessThan(0.001);
        expect(Math.hypot(...actualUp.map((v, k) => v - up[k]))).toBeLessThan(0.001);
    }
    expect(ride.memory.buffer).toBeInstanceOf(SharedArrayBuffer);
    const module = new WebAssembly.Module(Uint8Array.from(atob(KERNEL_WASM_BASE64), c => c.charCodeAt(0)));
    const exports = WebAssembly.Module.exports(module).map(item => item.name);
    for (const obsolete of ["workerMain", "workerFault", "scratchPtr", "setResampleJob", "resampleRange", "__wasm_init_tls", "__tls_base", "__stack_pointer"])
        expect(exports).not.toContain(obsolete);
});
