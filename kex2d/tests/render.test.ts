import { beforeEach, describe, expect, test } from "bun:test";
import { State, type System } from "@dylanebert/shallot";
import { COLOR_ACCENT, hovered } from "../src/colors";
import { editor, enterTangentEdit } from "../src/editor";
import { AnchorDrawSystem, TangentDrawSystem } from "../src/render";
import { TangentMode } from "../src/spline";
import {
    addNode,
    BakeSystem,
    createSection,
    createTrack,
    EXTEND_DIST,
    handleAt,
    SectionKind,
    seedTangent,
    setTangent,
} from "../src/track";
import { Canvas2D, frameCamera } from "../src/view";
import { type DrawCall, fakeCanvasElement, recordingContext } from "./helpers/recording-ctx";

// ── kex2d-followups follow-up 9: the two `colors.test.ts` source pins on `render.ts`
// (`hovered(COLOR_ANCHOR)` and the knob-draw shape) regexed the file's text — a renderer that
// calls `hovered()` and then strokes something else entirely would still pass both. This is the
// promotion: drive the real render systems over a bare `State` through a recording `ctx` double
// and read the ACTUAL `strokeStyle`/`fillStyle` a draw call used, not the source text that
// produced it.

const CANVAS_W = 800;
const CANVAS_H = 600;

/** a flat one-section geo track: node 0 at the section entry (the local origin, also the
 *  world origin here), node 1 a straight extend away — the same seed shape `tests/track.test.ts`
 *  uses, baked once so every node has a real sample point to draw at. */
function track(): { state: State; sec: number } {
    const state = new State();
    state.addSystem(BakeSystem);
    createTrack(state);
    const sec = createSection(state, 0, SectionKind.Geo, 0);
    addNode(state, sec, 0, 0);
    addNode(state, sec, EXTEND_DIST, 0);
    state.step(0);
    return { state, sec };
}

/** point `Canvas2D` at a fresh recorder + a fixed-size fake canvas, and re-frame the camera to
 *  it — `view.ts`'s camera is a module singleton that only frames once (`framed` latches), so a
 *  later test in the same process must re-frame explicitly rather than inherit a stale camera. */
function setupCanvas(): DrawCall[] {
    const { ctx, calls } = recordingContext();
    const element = fakeCanvasElement(CANVAS_W, CANVAS_H);
    Object.assign(Canvas2D, { element, ctx });
    frameCamera(CANVAS_W, CANVAS_H);
    return calls;
}

/** run a draw `System` for one frame — `System.update` is optional in the shallot scheduler
 *  type, but every system under test always declares one. */
function draw(system: System, state: State): void {
    if (!system.update) throw new Error("system has no update");
    system.update(state);
}

beforeEach(() => {
    // editor is a module singleton too — every hover/tangent-edit field a prior test left set
    // would otherwise bleed into the next.
    editor.hoverNode = null;
    editor.hoverKnob = null;
    editor.tangentEdit = null;
    editor.start = false;
});

// ── the double's own contract: `recording-ctx.ts`'s JSDoc promises save()/restore() fidelity
// (naming AnchorDrawSystem's START-anchor ring bracket as the reason it matters), but no test
// above actually depends on it — every draw in `render.ts` sets its own style immediately before
// drawing, so a broken `restore()` would corrupt style state with nothing here to notice
// (adversarial review, kex2d-followups stage 4). These two tests close that gap directly: the
// first proves the double round-trips arbitrary style state through save/restore on its own
// terms; the second drives the actual named production bracket end to end.
describe("recordingContext — save/restore fidelity", () => {
    test("restore() reverts strokeStyle/fillStyle/lineWidth/globalAlpha to the save-time snapshot", () => {
        const { ctx, calls } = recordingContext();
        ctx.strokeStyle = "#111111";
        ctx.fillStyle = "#222222";
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.5;
        ctx.save();
        ctx.strokeStyle = "#ff00ff";
        ctx.fillStyle = "#00ff00";
        ctx.lineWidth = 9;
        ctx.globalAlpha = 1;
        ctx.stroke(); // recorded with the post-save styles
        ctx.restore();
        ctx.stroke(); // recorded with the restored (pre-save) styles
        expect(calls[0].strokeStyle).toBe("#ff00ff");
        expect(calls[1].strokeStyle).toBe("#111111");
        expect(calls[1].fillStyle).toBe("#222222");
        expect(calls[1].lineWidth).toBe(2);
        expect(calls[1].globalAlpha).toBe(0.5);
    });

    test("AnchorDrawSystem's START-anchor ring bracket — the named production save/restore site", () => {
        // `editor.start` summons the soft ring drawn inside `ctx.save()`/`ctx.restore()` around
        // the section-0 entry anchor; the diamond stroke that follows sets its OWN style
        // regardless (`render.ts` never relies on the restored value), so this proves the
        // bracket is reachable and sequenced as expected, not that restore() is load-bearing
        // there — the test above covers that half.
        const { state } = track();
        editor.start = true;
        const calls = setupCanvas();
        draw(AnchorDrawSystem, state);
        const stroke = calls.filter((c) => c.method === "stroke");
        expect(stroke.length).toBe(2); // the ring, then the START diamond
        expect(stroke[0].strokeStyle).toBe("rgba(255, 209, 102, 0.45)");
        expect(stroke[0].lineWidth).toBe(1.5);
        expect(stroke[1].strokeStyle).toBe("#f0ece8");
    });
});

describe("AnchorDrawSystem — the entry anchor's hover stroke (kex2d-idioms 10b)", () => {
    test("at rest, the anchor diamond strokes its own neutral tone", () => {
        const { state } = track();
        const calls = setupCanvas();
        draw(AnchorDrawSystem, state);
        const stroke = calls.filter((c) => c.method === "stroke");
        expect(stroke.length).toBe(1);
        // COLOR_ANCHOR isn't exported (render.ts-local) — the resting value is duplicated here
        // exactly as `colors.test.ts`'s `whiteMix` duplicates its own old formula, the boundary
        // this test needs to state to prove hover CHANGES it.
        expect(stroke[0].strokeStyle).toBe("#9aa0a6");
    });

    test("hovered, the SAME diamond draw strokes hovered(COLOR_ANCHOR) — read off the actual call", () => {
        const { state, sec } = track();
        const entry = handleAt(state, sec, 0);
        expect(entry).not.toBeNull();
        editor.hoverNode = entry;
        const calls = setupCanvas();
        draw(AnchorDrawSystem, state);
        const stroke = calls.filter((c) => c.method === "stroke");
        expect(stroke.length).toBe(1);
        expect(stroke[0].strokeStyle).toBe(hovered("#9aa0a6"));
    });

    // ── red-first evidence (spec Validation: every behavioral replacement starts red) — see the
    // stage-4 report for the perturbation run + its failure output. The two tests above are what
    // goes red when `render.ts`'s anchor stroke is perturbed to ignore `hov` while still calling
    // `hovered(COLOR_ANCHOR)` in dead code (the exact gap the retired source pin couldn't see).
});

describe("TangentDrawSystem — one knob calibration, authored and inferred alike (kex2d-burndown feel fix)", () => {
    /** the knob's fill+stroke draw calls for node 1's single visible handle (its "in" side —
     *  the only segment it drives, a chain end has no "out"). the arm pass draws one shared
     *  `stroke()` first (the guide-gray arms, batched); the knob pass follows with one `fill()`
     *  then one `stroke()` per handle — exactly two calls for a one-handle set. */
    function knobCalls(calls: DrawCall[]): { fill: DrawCall; stroke: DrawCall } {
        const fill = calls.filter((c) => c.method === "fill");
        const stroke = calls.filter((c) => c.method === "stroke");
        expect(fill.length).toBe(1);
        // one arm stroke + one knob stroke.
        expect(stroke.length).toBe(2);
        return { fill: fill[0], stroke: stroke[1] };
    }

    function assertRestCalibration(calls: DrawCall[]): void {
        const { fill, stroke } = knobCalls(calls);
        expect(stroke.strokeStyle).toBe("#0e0d0c");
        expect(fill.fillStyle).toBe(COLOR_ACCENT);
    }

    function assertHoverCalibration(calls: DrawCall[]): void {
        const { fill, stroke } = knobCalls(calls);
        expect(stroke.strokeStyle).toBe(hovered(COLOR_ACCENT));
        expect(fill.fillStyle).toBe(hovered(COLOR_ACCENT));
    }

    test("an inferred (Auto) node's knob draws ink-outline rest / lifted-both hover", () => {
        const { state, sec } = track();
        const tip = handleAt(state, sec, 1);
        expect(tip).not.toBeNull();
        enterTangentEdit(tip as number);

        const restCalls = setupCanvas();
        draw(TangentDrawSystem, state);
        assertRestCalibration(restCalls);

        editor.hoverKnob = { eid: tip as number, side: "in" };
        const hoverCalls = setupCanvas();
        draw(TangentDrawSystem, state);
        assertHoverCalibration(hoverCalls);
    });

    test("an authored (explicit) node's knob draws the IDENTICAL calibration — no explicit/ghost fork", () => {
        const { state, sec } = track();
        const tip = handleAt(state, sec, 1);
        expect(tip).not.toBeNull();
        const seed = seedTangent(state, sec, 1, TangentMode.Free);
        expect(seed).not.toBeNull();
        setTangent(state, sec, 1, seed);
        enterTangentEdit(tip as number);

        const restCalls = setupCanvas();
        draw(TangentDrawSystem, state);
        assertRestCalibration(restCalls);

        editor.hoverKnob = { eid: tip as number, side: "in" };
        const hoverCalls = setupCanvas();
        draw(TangentDrawSystem, state);
        assertHoverCalibration(hoverCalls);
    });

    // ── red-first evidence — see the stage-4 report for the perturbation run + its failure
    // output. These two tests are what goes red when `render.ts`'s knob stroke/fill is
    // perturbed to draw an unconditional resting tone while the source still contains the
    // `hov ? hovered(COLOR_ACCENT) : …` text the retired pin matched on.
});
