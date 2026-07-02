import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { State } from "@dylanebert/shallot";
import { addPosPin, bandConfig, comfortConfig } from "../src/constraints";
import { seedSolveDemo } from "../src/demo";
import { createHistory, undo } from "../src/history";
import { forces64 } from "../src/force";
import { relaxTrack } from "../src/relax";
import { solveState } from "../src/solve";
import { BakeSystem, createTrack, Handle, sortedHandles } from "../src/track";

// stage 6: position pins as first-class weighted constraints, the relax verb
// (re-baseline the authored spine), and the force-roughness comfort knob.

beforeEach(() => {
    bandConfig.clear();
    comfortConfig.clear();
    solveState.clear();
});
afterEach(() => {
    // module maps are keyed by eid and eids recycle across States — leaked
    // entries would constrain OTHER test files' tracks.
    bandConfig.clear();
    comfortConfig.clear();
    solveState.clear();
});

function demoTrack(): { state: State; eid: number } {
    const state = new State();
    state.addSystem(BakeSystem);
    createTrack(state);
    const eid = seedSolveDemo(state, "valley");
    return { state, eid };
}

function settle(state: State, eid: number, cap = 150): boolean {
    for (let k = 0; k < cap; k++) {
        state.step(0);
        const st = solveState.get(eid);
        if (st?.settled || st?.suspended) return true;
    }
    return false;
}

/** the ghost gap: how far the solved track sits OFF the authored spine P° —
 *  point-to-segment (normal) distance, not index-matched (the two curves'
 *  arclength distributions differ, so an index metric reads tangential slide
 *  as a gap the eye can't see). */
function ghostGap(eid: number): number {
    const st = solveState.get(eid);
    if (!st) return 0;
    let max = 0;
    for (let i = 0; i < st.n; i++) {
        let best = Number.POSITIVE_INFINITY;
        for (let j = 0; j < st.n - 1; j++) {
            const ex = st.draftX[j + 1] - st.draftX[j];
            const ey = st.draftY[j + 1] - st.draftY[j];
            const ee = ex * ex + ey * ey;
            let u =
                ee > 0 ? ((st.x[i] - st.draftX[j]) * ex + (st.y[i] - st.draftY[j]) * ey) / ee : 0;
            u = Math.max(0, Math.min(1, u));
            best = Math.min(
                best,
                Math.hypot(st.x[i] - (st.draftX[j] + u * ex), st.y[i] - (st.draftY[j] + u * ey)),
            );
        }
        max = Math.max(max, best);
    }
    return max;
}

describe("position pins", () => {
    test("a position pin drags its point of the track; the band still holds", () => {
        const { state, eid } = demoTrack();
        expect(settle(state, eid)).toBe(true);
        const st0 = solveState.get(eid);
        if (!st0) throw new Error("state missing");

        // demand a 2 m dip in the exit flat — band-legal, energy-feasible,
        // and somewhere the unpinned solve does NOT go. (a demand inside the
        // band-ACTIVE dip is genuinely contested and loses honestly — that's
        // the readout's case, not this test's.)
        const i = Math.round(120 / st0.ds); // exit flat
        const tx = st0.x[i];
        const ty = st0.y[i] - 2;
        addPosPin(state, eid, 120, tx, ty);
        expect(settle(state, eid, 300)).toBe(true);

        const st = solveState.get(eid);
        if (!st) throw new Error("state missing");
        const pos = st.report.find((r) => r.kind === "pos");
        const band = st.report.find((r) => r.kind === "band");
        if (!pos || !band) throw new Error("report incomplete");
        expect(pos.satisfied).toBe(true); // within POS_TOL of the target
        expect(band.satisfied).toBe(true); // the band still holds
        const j = Math.round(120 / st.ds);
        expect(Math.hypot(st.x[j] - tx, st.y[j] - ty)).toBeLessThan(0.15);
    });
});

describe("the relax verb", () => {
    test("relax re-baselines the spine: the ghost collapses, one undoable entry", () => {
        const { state, eid } = demoTrack();
        bandConfig.set(eid, { lo: -1, hi: 3 }); // tighter: a big reshape to relax into
        expect(settle(state, eid, 300)).toBe(true);
        const gapBefore = ghostGap(eid);
        expect(gapBefore).toBeGreaterThan(0.3); // the band genuinely reshaped

        const h = createHistory();
        const chainBefore = sortedHandles(state).map((e) => ({
            x: Handle.pos.x.get(e),
            y: Handle.pos.y.get(e),
            theta: Handle.theta.get(e),
        }));

        expect(relaxTrack(h, state, eid)).toBe(true);
        expect(h.undo.length).toBe(1); // one entry for the whole verb
        expect(settle(state, eid)).toBe(true);

        // the authored spine now generates (approximately) what the solve
        // wants: the ghost gap shrinks to refit-tolerance scale.
        const gapAfter = ghostGap(eid);
        expect(gapAfter).toBeLessThan(Math.max(0.3, gapBefore / 3));

        // node-dragging keeps working on the relaxed chain: a drag re-bakes
        // and the solve follows, finite.
        const handles = sortedHandles(state);
        const node = handles[2];
        Handle.pos.set(node, Handle.pos.x.get(node) + 3, Handle.pos.y.get(node) - 1);
        expect(settle(state, eid)).toBe(true);
        const st = solveState.get(eid);
        if (!st) throw new Error("state missing");
        for (let i = 0; i < st.n; i++) {
            expect(Number.isFinite(st.x[i])).toBe(true);
        }
        undo(h); // undo the drag? no — the drag wasn't recorded on h; undo the relax
        // (the drag mutated pos directly without a gesture; h holds only the
        // relax entry, so this restores the pre-relax chain verbatim.)
        const restored = sortedHandles(state).map((e) => ({
            x: Handle.pos.x.get(e),
            y: Handle.pos.y.get(e),
            theta: Handle.theta.get(e),
        }));
        expect(restored.length).toBe(chainBefore.length);
        for (let k = 0; k < restored.length; k++) {
            expect(restored[k].x).toBeCloseTo(chainBefore[k].x, 5);
            expect(restored[k].y).toBeCloseTo(chainBefore[k].y, 5);
            expect(restored[k].theta).toBeCloseTo(chainBefore[k].theta, 5);
        }
    });
});

describe("the comfort knob (force roughness)", () => {
    test("fRough smooths the bang-bang band-riding profile; the band still holds", () => {
        const measure = (comfort: number | null): number => {
            bandConfig.clear();
            comfortConfig.clear();
            solveState.clear();
            const state = new State();
            state.addSystem(BakeSystem);
            createTrack(state);
            const eid = seedSolveDemo(state, "valley");
            if (comfort !== null) comfortConfig.set(eid, comfort);
            if (!settle(state, eid, 400)) throw new Error("did not settle");
            const st = solveState.get(eid);
            if (!st) throw new Error("state missing");
            const band = st.report.find((r) => r.kind === "band");
            expect(band?.satisfied).toBe(true);
            // roughness of the solved force profile: Σ (ΔF)².
            const { fN } = forces64(st.x, st.y, st.n, st.v0);
            let sum = 0;
            for (let i = 1; i < st.n - 2; i++) sum += (fN[i + 1] - fN[i]) ** 2;
            return sum;
        };
        // w=0.2 sits inside the knob's usable range (w≥0.5 fights the AL
        // band into a limit cycle and never settles — the knob's documented
        // ceiling); measured: roughness 63.5 → 0.86 on the valley.
        const base = measure(null);
        const smoothed = measure(0.2);
        expect(smoothed).toBeLessThan(base / 10);
    });
});
