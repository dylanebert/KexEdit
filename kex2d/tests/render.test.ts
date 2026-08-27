import { beforeEach, describe, expect, test } from "bun:test";
import { State, type System } from "@dylanebert/shallot";
import { COLOR_ACCENT, hovered } from "../src/colors";
import { deselectAll, editor, enterTangentEdit, selectStart } from "../src/editor";
import { AnchorDrawSystem, infeasibleSpans, TangentDrawSystem } from "../src/render";
import { TangentMode } from "../src/spline";
import {
    addNode,
    bakeOut,
    BakeSystem,
    createSection,
    createTrack,
    EXTEND_DIST,
    handleAt,
    SectionKind,
    seedTangent,
    setTangent,
    Track,
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
    deselectAll();
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
        selectStart(true);
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

describe("infeasibleSpans — the ghost strip's own pure reader", () => {
    // pure array-level tests first: no bake, no canvas — the boundary cases the header band's
    // span walk owes (S3's disclosed gaps: sub-pixel/zero-width spans, and the two ends of the
    // walk). `strokeFeasible`'s own bad-edge test (`feasible[i] === 0 || feasible[i + 1] === 0`)
    // is duplicated in each expectation below on purpose — these tests exist to catch the two
    // conditions drifting apart, so restating one from the other would make them vacuous.

    test("an all-feasible chain reports no spans", () => {
        const feasible = new Uint8Array([1, 1, 1, 1]);
        const s = new Float64Array([0, 1, 2, 3]);
        expect(infeasibleSpans(s, feasible, 4)).toEqual([]);
    });

    test("one interior bad run becomes one span at its bounding samples' s", () => {
        // edges 1 (samples 1,2) and 2 (samples 2,3) are bad; edge 0 and edge 3 are clean.
        const feasible = new Uint8Array([1, 1, 0, 1, 1]);
        const s = new Float64Array([0, 1, 2, 3, 4]);
        expect(infeasibleSpans(s, feasible, 5)).toEqual([{ start: 1, end: 3 }]);
    });

    test("two separated bad runs stay two spans — no coalescing across a feasible gap (S3)", () => {
        // a lone bad SAMPLE poisons both its adjacent edges (the OR test), so sample 1's badness
        // spans edges 0 and 1 (s[0]..s[2]); sample 4's spans edges 3 and 4 (s[3]..s[5]). Sample 2
        // and 3 stay feasible, so the walk closes and reopens between them — the clean spans a
        // real bake never has to earn a coalescing rule for (S3's own finding).
        const feasible = new Uint8Array([1, 0, 1, 1, 0, 1]);
        const s = new Float64Array([0, 1, 2, 3, 4, 5]);
        expect(infeasibleSpans(s, feasible, 6)).toEqual([
            { start: 0, end: 2 },
            { start: 3, end: 5 },
        ]);
    });

    test("a bad run touching sample 0 starts the walk at the first sample", () => {
        const feasible = new Uint8Array([0, 1, 1, 1]);
        const s = new Float64Array([0, 1, 2, 3]);
        expect(infeasibleSpans(s, feasible, 4)).toEqual([{ start: 0, end: 1 }]);
    });

    test("a bad run touching the last sample runs the walk to the end, unclosed by a trailing else", () => {
        const feasible = new Uint8Array([1, 1, 1, 0]);
        const s = new Float64Array([0, 1, 2, 3]);
        expect(infeasibleSpans(s, feasible, 4)).toEqual([{ start: 2, end: 3 }]);
    });

    test("a whole-chain-bad walk closes at count − 1, never past the array", () => {
        const feasible = new Uint8Array([0, 0, 0]);
        const s = new Float64Array([0, 1, 2]);
        expect(infeasibleSpans(s, feasible, 3)).toEqual([{ start: 0, end: 2 }]);
    });

    test("a zero-width span is real, not filtered — the downstream-freeze zero-length gap edge (S3's disclosed gap)", () => {
        // a lone bad SAMPLE poisons BOTH its adjacent edges (each edge's bad test is an OR over
        // its two endpoints), so a single-EDGE bad run only happens at a chain boundary — here
        // sample 0 is infeasible and edge 0 is the only bad edge (sample 1 onward is clean). Its
        // own `ds` is 0 (a frozen gap edge, `s[0] === s[1]`), so the resulting span is zero-width
        // by construction, not a hand-picked degenerate input.
        const feasible = new Uint8Array([0, 1, 1, 1]);
        const s = new Float64Array([0, 0, 1, 2]); // edge 0→1 has ds = 0
        expect(infeasibleSpans(s, feasible, 4)).toEqual([{ start: 0, end: 0 }]);
    });

    // the integration arm: a real bake (the same steep-climb fixture `cart.test.ts` uses to
    // prove `firstInfeasible` fires) composes correctly end to end — the pure walk above reading
    // real `bakeOut.feasible`/`cart.forceCurve`-shaped `s`, not a hand-built array.
    test("composes with a real bake: the walk's span brackets bakeOut.firstInfeasible", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        const sec = createSection(state, 0, SectionKind.Geo, 0);
        addNode(state, sec, 0, 0);
        addNode(state, sec, 16, 27.7); // the steep climb: depletes energy partway up
        state.step(0);
        const out = bakeOut.get(eid);
        if (!out) throw new Error("bakeOut missing");
        expect(out.firstInfeasible).toBeGreaterThan(0); // there is red (cart.test.ts's own arm)
        const count = Track.count.get(eid);
        const s = new Float64Array(count);
        for (let i = 1; i < count; i++) s[i] = s[i - 1] + out.ds[i - 1];
        const spans = infeasibleSpans(s, out.feasible, count);
        expect(spans.length).toBeGreaterThan(0);
        // the first span starts at or before the first infeasible sample's own s, and the whole
        // infeasible tail is covered (the climb never recovers, so exactly one span to the end).
        expect(spans.length).toBe(1);
        expect(spans[0].start).toBeLessThanOrEqual(s[out.firstInfeasible]);
        expect(spans[0].end).toBe(s[count - 1]);
    });

    // ── red-first evidence: perturbing the bad-edge test from `||` to `&&` (so a span only
    // opens when BOTH endpoints fail, mirroring `strokeFeasible`'s GOOD-edge test by mistake)
    // reds "one interior bad run becomes one span…" — it reports [] instead of one span,
    // because no edge in that fixture has both endpoints failing. Restoring `||` greens it.
    // Perturbing the trailing `if (start !== -1)` close to a no-op (dropping the last span when
    // the walk ends still-open) reds "a bad run touching the last sample…" and "a whole-chain-bad
    // walk…", both of which end open. Witnessed by hand at this stage's authoring time.
});
