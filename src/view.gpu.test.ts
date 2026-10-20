import { MeshInstance, type App } from "@dylanebert/shallot";
import { Gizmo, Orbit } from "@dylanebert/shallot/extras";
import { Grid } from "@dylanebert/shallot-grid";
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
    expect(app.world.has(scene.grid, Grid)).toBe(true);
    expect(app.world.has(scene.grid, MeshInstance)).toBe(false);
    attachTexture(app.world, scene.camera, { width: 256, height: 192 });
    app.world.remove(scene.grid, Grid);
}, TIMEOUT.startup);
afterAll(() => app?.dispose());

async function frame() {
    app.world.step(0);
    const capture = await captureTexture(app.world, app.world.resource(EditorScene).camera);
    await app.world.frameFence;
    return capture.rgba;
}
function delta(a: Uint8ClampedArray, b: Uint8ClampedArray, i: number) {
    return Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
}
function different(a: Uint8ClampedArray, b: Uint8ClampedArray) {
    let count = 0;
    for (let i = 0; i < a.length; i += 4) if (delta(a, b, i) > 8) count++;
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

test("Dawn composes the package grid with the path and opaque train across orbit and zoom", async () => {
    const { world } = app, scene = world.resource(EditorScene);
    const orbit = world.storage(Orbit);
    for (const [distance, yaw, pitch] of [[6, 0.6, 0.35], [18, 1.2, 0.6], [60, -0.5, 0.4]]) {
        orbit.distance.set(scene.camera, distance);
        orbit.yaw.set(scene.camera, yaw);
        orbit.pitch.set(scene.camera, pitch);
        world.remove(scene.path, Gizmo);
        world.remove(scene.train, MeshInstance);
        world.remove(scene.grid, Grid);
        const clear = await frame();
        world.add(scene.grid, Grid);
        const grid = await frame();
        expect(different(grid, clear)).toBeGreaterThan(100);
        world.add(scene.path, Gizmo, { handle: pathHandle });
        const path = await frame();
        expect(different(path, grid)).toBeGreaterThan(10);
        world.add(scene.train, MeshInstance);
        const composed = await frame();
        expect(different(composed, path)).toBeGreaterThan(5);
        // Compare opaque occlusion to the same scene without a grid, not shader arithmetic.
        if (distance === 6) {
            world.remove(scene.grid, Grid);
            const noGrid = await frame();
            let hidden = 0;
            for (let i = 0; i < composed.length; i += 4) {
                if (delta(grid, clear, i) > 8 && delta(composed, path, i) > 8 && delta(composed, noGrid, i) < 2) hidden++;
            }
            expect(hidden).toBeGreaterThan(5);
        }
    }
    orbit.distance.set(scene.camera, 6);
    orbit.yaw.set(scene.camera, 0.6);
    orbit.pitch.set(scene.camera, 0.35);
    world.remove(scene.grid, Grid);
}, TIMEOUT.gpu);

test("a new integrated generation updates the retained path without registering another asset", async () => {
    const { world } = app, scene = world.resource(EditorScene);
    world.remove(scene.train, MeshInstance);
    world.remove(scene.grid, Grid);
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
