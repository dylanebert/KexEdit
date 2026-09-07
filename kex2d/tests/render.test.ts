import { beforeEach, describe, expect, test } from "bun:test";
import type { State, System } from "@dylanebert/shallot";
import { deselectAll, editor } from "../src/editor";
import { infeasibleSpans } from "../src/render";
import { bakeOut, Track } from "../src/track";
import { Canvas2D, frameCamera } from "../src/view";
import { build } from "./helpers/build";
import { type DrawCall, fakeCanvasElement, recordingContext } from "./helpers/recording-ctx";

// ── kex2d-followups follow-up 9: the two `colors.test.ts` source pins on `render.ts`
// (`hovered(COLOR_ANCHOR)` and the knob-draw shape) regexed the file's text — a renderer that
// calls `hovered()` and then strokes something else entirely would still pass both. This is the
// promotion: drive the real render systems over a bare `State` through a recording `ctx` double
// and read the ACTUAL `strokeStyle`/`fillStyle` a draw call used, not the source text that
// produced it.
//
// the shared authoring builder: fixtures below are authored through the shared `Build` helper
// (`tests/helpers/build.ts`) rather than `track.ts`'s raw entity primitives — this file
// tests the draw systems, which consume an authored track, not the authoring layer itself.

const CANVAS_W = 800;
const CANVAS_H = 600;

/** a flat one-record geo track, baked once so the polyline has real sample points to draw at. */
function _track(): { state: State; sec: number } {
    const b = build();
    const sec = b.geo(0, 24, 0, 0);
    b.bake();
    return { state: b.ecs, sec };
}

/** point `Canvas2D` at a fresh recorder + a fixed-size fake canvas, and re-frame the camera to
 *  it — `view.ts`'s camera is a module singleton that only frames once (`framed` latches), so a
 *  later test in the same process must re-frame explicitly rather than inherit a stale camera. */
function _setupCanvas(): DrawCall[] {
    const { ctx, calls } = recordingContext();
    const element = fakeCanvasElement(CANVAS_W, CANVAS_H);
    Object.assign(Canvas2D, { element, ctx });
    frameCamera(CANVAS_W, CANVAS_H);
    return calls;
}

/** run a draw `System` for one frame — `System.update` is optional in the shallot scheduler
 *  type, but every system under test always declares one. */
function _draw(system: System, state: State): void {
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
        const b = build();
        b.geo(0, 32, 0, 1.3); // the steep climb: depletes energy partway up
        b.bake();
        const eid = b.trackEid;
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
