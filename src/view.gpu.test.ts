import { MeshInstance, type App } from "@dylanebert/shallot";
import { Gizmo } from "@dylanebert/shallot/extras";
import { attachTexture, captureTexture } from "@dylanebert/shallot/rendering";
import { openGpuApp } from "@dylanebert/shallot/testing/gpu";
import { TIMEOUT } from "@dylanebert/shallot/testing";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { EditorScene, editorWorld } from "./world";
import { PathGeometry } from "./path/view";
import { readRide } from "./trajectory/ride";
import { RIDE_START } from "./trajectory/ride.fixture";

let app: App;
let pathHandle: number;
beforeAll(async () => {
    app = await openGpuApp({ plugins: [editorWorld()] });
    console.info("KexEdit Dawn adapter", app.world.gpu.adapter);
    const scene = app.world.resource(EditorScene);
    pathHandle = app.world.storage(Gizmo).handle.get(scene.path);
    attachTexture(app.world, scene.camera, { width: 256, height: 192 });
    app.world.remove(scene.grid, MeshInstance);
}, TIMEOUT.startup);
afterAll(() => app?.dispose());

async function frame() {
    app.world.step(0);
    const capture = await captureTexture(app.world, app.world.resource(EditorScene).camera);
    await app.world.frameFence;
    return capture.rgba;
}
function different(a: Uint8ClampedArray, b: Uint8ClampedArray) {
    let count = 0;
    for (let i = 0; i < a.length; i += 4)
        if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > 8) count++;
    return count;
}

test("Dawn draws integrated path chords and both orientation axes into the camera", async () => {
    const { world } = app, scene = world.resource(EditorScene);
    world.remove(scene.train, MeshInstance);
    const drawn = await frame();
    const gizmo = world.storage(Gizmo).handle.get(scene.path);
    world.remove(scene.path, Gizmo);
    const clear = await frame();
    world.add(scene.path, Gizmo, { handle: gizmo });
    expect(different(drawn, clear)).toBeGreaterThan(50);
    let red = 0, green = 0, chord = 0;
    for (let i = 0; i < drawn.length; i += 4) {
        const r = drawn[i], g = drawn[i + 1], b = drawn[i + 2];
        if (r > 90 && r > g * 1.5 && r > b * 1.5) red++;
        if (g > 70 && g > r * 1.2 && g > b * 1.2) green++;
        if (r > 140 && g > 120 && b > 90) chord++;
    }
    expect(red).toBeGreaterThan(4);
    expect(green).toBeGreaterThan(4);
    expect(chord).toBeGreaterThan(10);
}, TIMEOUT.gpu);

test("Dawn draws the train box rather than only the path or clear", async () => {
    const { world } = app, scene = world.resource(EditorScene);
    world.remove(scene.path, Gizmo);
    world.remove(scene.train, MeshInstance);
    const clear = await frame();
    world.add(scene.train, MeshInstance);
    const drawn = await frame();
    expect(different(drawn, clear)).toBeGreaterThan(100);
}, TIMEOUT.gpu);

test("Dawn draws a neutral metre grid rather than long-line clipping artifacts", async () => {
    const { world } = app, scene = world.resource(EditorScene);
    world.remove(scene.path, Gizmo);
    world.remove(scene.train, MeshInstance);
    world.remove(scene.grid, MeshInstance);
    const clear = await frame();
    world.add(scene.grid, MeshInstance);
    const drawn = await frame();
    expect(different(drawn, clear)).toBeGreaterThan(100);
    for (let i = 0; i < drawn.length; i += 4) {
        expect(Math.max(drawn[i], drawn[i + 1], drawn[i + 2]) - Math.min(drawn[i], drawn[i + 1], drawn[i + 2])).toBeLessThan(10);
    }
    world.remove(scene.grid, MeshInstance);
}, TIMEOUT.gpu);

test("a new integrated generation updates the retained path without registering another asset", async () => {
    const { world } = app, scene = world.resource(EditorScene);
    world.remove(scene.train, MeshInstance);
    world.remove(scene.grid, MeshInstance);
    const view = world.resource(PathGeometry).get(scene.ride)!;
    if (!world.has(scene.path, Gizmo)) world.add(scene.path, Gizmo, { handle: pathHandle });
    const before = await frame(), asset = view.asset, generation = view.generation;
    const ride = readRide(world, scene.ride).ride;
    ride.setInitial({ ...RIDE_START, position: [2, 0, 0] });
    ride.pass();
    const after = await frame();
    expect(view.generation).toBe(generation + 1);
    expect(view.asset).toBe(asset);
    expect(different(before, after)).toBeGreaterThan(50);
}, TIMEOUT.gpu);
