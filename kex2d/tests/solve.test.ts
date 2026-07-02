import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { State } from "@dylanebert/shallot";
import { addPin, bandConfig, Pin } from "../src/constraints";
import { seedSolveDemo } from "../src/demo";
import { forces64 } from "../src/force";
import { beginMove, commit, createHistory, undo } from "../src/history";
import { polylineLength } from "../src/resample";
import { solveState } from "../src/solve";
import { addNode, BakeSystem, bakeOut, createTrack, Handle, samples, Track } from "../src/track";

// the wiring: BakeSystem's constrained path — draft → solver grid →
// collocateRTI across ticks → realized = solved — plus the identity
// short-circuit, the suspension fallback, and the rest re-grid. device-free
// State via the scheduler, the `track.test.ts` pattern.

beforeEach(() => {
    // constraints + solve state are module maps keyed by eid; separate States
    // recycle eids, so tests clear them (samples/bakeOut reset via createTrack).
    bandConfig.clear();
    solveState.clear();
});
afterEach(() => {
    bandConfig.clear();
    solveState.clear();
});

function demoTrack(variant: "valley" | "losing" = "valley"): { state: State; eid: number } {
    const state = new State();
    state.addSystem(BakeSystem);
    createTrack(state);
    const eid = seedSolveDemo(state, variant);
    return { state, eid };
}

/** tick until the solve settles (converged + grid matched), bounded. */
function settle(state: State, eid: number, cap = 100): number {
    for (let k = 0; k < cap; k++) {
        state.step(0);
        const st = solveState.get(eid);
        if (st?.settled || st?.suspended) return k + 1;
    }
    return cap;
}

describe("identity short-circuit", () => {
    test("constraint add → remove leaves the bake byte-identical to never-constrained", () => {
        const plain = new State();
        plain.addSystem(BakeSystem);
        const pe = createTrack(plain);
        addNode(plain, -16, 0);
        addNode(plain, 16, 0);
        addNode(plain, 40, 3);
        plain.step(0);

        const other = new State();
        other.addSystem(BakeSystem);
        const oe = createTrack(other);
        addNode(other, -16, 0);
        addNode(other, 16, 0);
        addNode(other, 40, 3);
        other.step(0);
        // constrain, solve a few ticks, then remove the constraint.
        const pin = addPin(other, oe, 20, 0.5);
        other.step(0);
        other.step(0);
        other.destroy(pin);
        other.step(0); // hadSolve forces the rebake to the draft

        const ps = samples.get(pe);
        const os = samples.get(oe);
        const po = bakeOut.get(pe);
        const oo = bakeOut.get(oe);
        if (!ps || !os || !po || !oo) throw new Error("buffers missing");
        const n = Track.count.get(pe);
        expect(Track.count.get(oe)).toBe(n);
        expect(solveState.has(oe)).toBe(false);
        for (let i = 0; i < n; i++) {
            expect(os.posX[i]).toBe(ps.posX[i]);
            expect(os.posY[i]).toBe(ps.posY[i]);
        }
        for (let i = 0; i < n - 1; i++) expect(oo.fN[i]).toBe(po.fN[i]);
        expect(oo.tTotal).toBe(po.tTotal);
    });
});

describe("realized = solved", () => {
    test("the valley demo settles; samples carry the solved geometry", () => {
        const { state, eid } = demoTrack();
        const ticks = settle(state, eid);
        const st = solveState.get(eid);
        const s = samples.get(eid);
        const out = bakeOut.get(eid);
        if (!st || !s || !out) throw new Error("state missing");

        expect(ticks).toBeLessThan(100);
        expect(st.settled).toBe(true);
        expect(st.suspended).toBe(false);

        // realized = solved: the f32 samples are the rounded solver output.
        expect(Track.count.get(eid)).toBe(st.n);
        for (const i of [0, 1, st.n >> 2, st.n >> 1, st.n - 2, st.n - 1]) {
            expect(s.posX[i]).toBe(Math.fround(st.x[i]));
            expect(s.posY[i]).toBe(Math.fround(st.y[i]));
        }

        // the report: band satisfied, pin satisfied (target 0 at the crest).
        const band = st.report.find((r) => r.kind === "band");
        const pin = st.report.find((r) => r.kind === "pin");
        if (!band || !pin) throw new Error("report incomplete");
        expect(band.satisfied).toBe(true);
        expect(pin.satisfied).toBe(true);
        expect(Math.abs(pin.achieved - 0)).toBeLessThan(0.05);

        // the display bake agrees with the solver-space report to the
        // documented node-vs-edge centering gap (~0.1 g at ds=0.5; ×2 margin
        // as in the stage-2 bakeViol bound). the draft bottom pulled 4.77 g;
        // the realized track must be inside the band up to that gap.
        for (let i = 1; i < st.n - 2; i++) {
            expect(out.fN[i]).toBeLessThan(4 + 0.3);
            expect(out.fN[i]).toBeGreaterThan(-1 - 0.3);
        }
        // and the ride is live: finite positive total time, all feasible.
        expect(out.tTotal).toBeGreaterThan(0);
        expect(Number.isFinite(out.tTotal)).toBe(true);
        expect(out.firstInfeasible).toBe(-1);
    });

    test("the settled grid matches the solved length (rest re-grid ran if needed)", () => {
        const { state, eid } = demoTrack();
        settle(state, eid);
        const st = solveState.get(eid);
        if (!st) throw new Error("state missing");
        expect(st.settled).toBe(true);
        const L = polylineLength(st.x, st.y, st.n);
        expect(Math.abs(L - (st.n - 1) * st.ds)).toBeLessThanOrEqual(st.ds / 2 + 1e-9);
    });
});

describe("finite-width pins (the anti-spike design)", () => {
    test("a finite-width pin produces a smoother local optimum than a single-row pin", () => {
        // stage-2 finding: a single-sample pin on a curvature quantity makes
        // a one-sample force spike — the solver's honest optimum. the pin's
        // finite width spreads the demand. measured on an uncontested flat
        // track (F≡1, no band) with a 0.5g pin, in SOLVER space (`forces64`
        // per node — the edge-centered display bake smears a one-node spike
        // across two edges and hides it): the worst second difference in
        // the pin's neighborhood.
        const jag = (width: number): number => {
            bandConfig.clear();
            solveState.clear();
            const state = new State();
            state.addSystem(BakeSystem);
            const eid = createTrack(state);
            addNode(state, -30, 0);
            addNode(state, 0, 0);
            addNode(state, 30, 0);
            const pe = addPin(state, eid, 30, 0.5);
            Pin.width.set(pe, width);
            // a flat track settles slowly: the pin's soft-term ringing
            // diffuses outward one stencil-width per outer (invisible
            // sub-pixel motion, but real descent) — the domain is kept
            // short so the diffusion completes within the cap.
            settle(state, eid, 400);
            const st = solveState.get(eid);
            if (!st?.settled) throw new Error("did not settle");
            const { fN } = forces64(st.x, st.y, st.n, st.v0);
            const center = Math.round(30 / st.ds);
            let worst = 0;
            for (let i = center - 8; i <= center + 8; i++) {
                worst = Math.max(worst, Math.abs(fN[i - 1] - 2 * fN[i] + fN[i + 1]));
            }
            return worst;
        };
        const wide = jag(1);
        const point = jag(0);
        expect(wide).toBeLessThan(point);
    });
});

describe("the losing pin (infeasible demand fails loud)", () => {
    test("pin −5 vs band lo −1: the pin lands at the floor with a legible ~4 g residual", () => {
        const { state, eid } = demoTrack("losing");
        settle(state, eid);
        const st = solveState.get(eid);
        const s = samples.get(eid);
        if (!st || !s) throw new Error("state missing");

        const pin = st.report.find((r) => r.kind === "pin");
        const band = st.report.find((r) => r.kind === "band");
        if (!pin || !band) throw new Error("report incomplete");
        expect(pin.satisfied).toBe(false);
        expect(pin.residual).toBeGreaterThan(3.5); // achieved −1 vs target −5
        expect(pin.residual).toBeLessThan(4.5);
        expect(band.satisfied).toBe(true); // the hard band wins

        // the failing case is loud but never NaN/spiral.
        for (let i = 0; i < st.n; i++) {
            expect(Number.isFinite(s.posX[i])).toBe(true);
            expect(Number.isFinite(s.posY[i])).toBe(true);
        }
    });
});

describe("RTI across drag ticks", () => {
    test("20 per-tick node moves stay finite; rest re-converges", () => {
        const { state, eid } = demoTrack();
        settle(state, eid);

        // the dip-bottom node wanders during a "drag": one solver outer per
        // tick against a moving draft.
        const handles: number[] = [];
        for (const h of state.query([Handle])) handles.push(h);
        handles.sort((a, b) => Handle.order.get(a) - Handle.order.get(b));
        const node = handles[2];
        const x0 = Handle.pos.x.get(node);
        const y0 = Handle.pos.y.get(node);
        for (let k = 0; k < 20; k++) {
            Handle.pos.set(node, x0 + 0.05 * (k + 1), y0 - 0.02 * (k + 1));
            state.step(0);
            const st = solveState.get(eid);
            if (!st) throw new Error("state missing");
            for (let i = 0; i < st.n; i++) {
                expect(Number.isFinite(st.x[i])).toBe(true);
                expect(Number.isFinite(st.y[i])).toBe(true);
            }
        }

        const ticks = settle(state, eid);
        expect(ticks).toBeLessThan(100);
        const st = solveState.get(eid);
        if (!st) throw new Error("state missing");
        expect(st.settled).toBe(true);
        const band = st.report.find((r) => r.kind === "band");
        expect(band?.satisfied).toBe(true);
    });
});

describe("undo interaction", () => {
    test("undoing a drag re-converges to the pre-drag solve", () => {
        const { state, eid } = demoTrack();
        settle(state, eid);
        const before = solveState.get(eid);
        if (!before) throw new Error("state missing");
        const fBefore = Float32Array.from(bakeOut.get(eid)?.fN ?? []);
        const nBefore = before.n;

        const h = createHistory();
        const handles: number[] = [];
        for (const e of state.query([Handle])) handles.push(e);
        handles.sort((a, b) => Handle.order.get(a) - Handle.order.get(b));
        const node = handles[2];

        beginMove(state);
        Handle.pos.set(node, Handle.pos.x.get(node) + 4, Handle.pos.y.get(node) - 2);
        commit(h);
        settle(state, eid);

        undo(h);
        settle(state, eid);
        const after = solveState.get(eid);
        const out = bakeOut.get(eid);
        if (!after || !out) throw new Error("state missing");
        expect(after.settled).toBe(true);
        expect(after.n).toBe(nBefore);
        // same draft + same constraints ⇒ the same contract; the two settles
        // may stop at different points of the soft-term valley (the RTI stop
        // is display-derived), so equivalence is display equivalence: force
        // profiles within the readout threshold (0.05 g) — gated to smooth
        // regions, because at a band-riding step (|F′| ~ 9 g/m) a sub-pixel
        // gauge shift between the two settles reads as O(1) g at a matched
        // index (the transition moved half a sample, not a different solve).
        let smooth = 0;
        for (let i = 2; i < after.n - 3; i++) {
            const slope = Math.max(
                Math.abs(fBefore[i] - fBefore[i - 1]),
                Math.abs(fBefore[i + 1] - fBefore[i]),
                Math.abs(fBefore[i + 2] - fBefore[i + 1]),
            );
            if (slope > after.ds) continue; // |F′| > 1 g/m
            smooth++;
            expect(Math.abs(out.fN[i] - fBefore[i])).toBeLessThan(0.05);
        }
        expect(smooth).toBeGreaterThan(after.n / 2);
    });
});

describe("suspension", () => {
    test("an energy-infeasible draft suspends the solve; the draft bakes with red UX", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        // climbs to y=9 — past the V0=10 energy ceiling (~5 m).
        addNode(state, -20, 0);
        addNode(state, 0, 6);
        addNode(state, 20, 9);
        bandConfig.set(eid, { lo: -1, hi: 4 });
        addPin(state, eid, 20, 0.5);
        state.step(0);

        const st = solveState.get(eid);
        const out = bakeOut.get(eid);
        if (!st || !out) throw new Error("state missing");
        expect(st.suspended).toBe(true);
        expect(st.report.length).toBe(0);
        expect(out.firstInfeasible).toBeGreaterThanOrEqual(0); // the story is on the track

        // constraints untouched — the pin survives suspension.
        let pins = 0;
        for (const _ of state.query([Pin])) pins++;
        expect(pins).toBe(1);
    });
});
