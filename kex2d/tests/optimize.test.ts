import { expect, test } from "bun:test";
import { State } from "@dylanebert/shallot";
import { constraintTargets } from "../src/bezier";
import { OPT_GRID, SolveSystem, solveOut } from "../src/optimize";
import { addPin, pinsOf, removePin, setHandle } from "../src/pins";
import { addNode, BakeSystem, bakeOut, createTrack, Track } from "../src/track";

const G = 9.80665;

// SolveSystem solves the convex F_n optimizer on the draft-time grid, then rides
// the solved force to the realized track the cart follows. driven device-free
// via the scheduler (Bake then Solve, registration order), like track.test.ts.

/** a fresh flat track (anchor (−16,0) → node (16,0)), baked + solved. */
function solved(): number {
    const state = new State();
    state.addSystem(BakeSystem);
    state.addSystem(SolveSystem);
    const eid = createTrack(state);
    addNode(state, -16, 0);
    addNode(state, 16, 0);
    state.step(0);
    return eid;
}

test("a chain shorter than two nodes produces no solve output", () => {
    const state = new State();
    state.addSystem(BakeSystem);
    state.addSystem(SolveSystem);
    const eid = createTrack(state); // empty track, never bakes
    state.step(0);
    expect(solveOut.get(eid)).toBeUndefined();
});

test("the realized track of a flat draft rides flat, anchor to end", () => {
    // a flat draft is 1g everywhere: smoothing a constant leaves it constant and
    // 1g sits inside the band, so the solved force stays ≈ 1 and riding it
    // reproduces the flat line — the realized geometry coincides with the draft.
    // closed form: x spans the draft's 32 m arclength, y holds at 0.
    const eid = solved();
    const so = solveOut.get(eid);
    if (!so) throw new Error("solveOut missing after solve");

    expect(so.count).toBe(OPT_GRID);
    for (let i = 0; i < so.count; i++) expect(so.fN[i]).toBeCloseTo(1, 3);

    expect(so.posX[0]).toBeCloseTo(-16, 4); // launches at the anchor
    expect(so.posX[so.count - 1]).toBeCloseTo(16, 2); // rides the full 32 m
    for (let i = 1; i < so.count; i++) expect(so.posX[i]).toBeGreaterThan(so.posX[i - 1]);
    for (let i = 0; i < so.count; i++) expect(so.posY[i]).toBeCloseTo(0, 3);
    expect(so.firstInfeasible).toBe(-1); // the flat never depletes energy
});

test("the realized ride preserves draft arclength and conserves energy on a varying-velocity draft", () => {
    // a gentle hill: the draft slows over the crest, so the draft-time grid is
    // non-uniform in arclength (the flat case is degenerate — linear). riding the
    // solved force must still distribute the draft's *total* arclength across the
    // grid (each step rides its draft-arclength interval) and conserve energy.
    const state = new State();
    state.addSystem(BakeSystem);
    state.addSystem(SolveSystem);
    const eid = createTrack(state);
    addNode(state, -16, 0);
    addNode(state, 0, 2);
    addNode(state, 16, 0);
    state.step(0);
    const so = solveOut.get(eid);
    const out = bakeOut.get(eid);
    if (!so || !out) throw new Error("missing solve/bake output");

    // the realized polyline length equals the draft's Σ ds (the σ-mapping sums to
    // the full draft arclength).
    const count = Track.count.get(eid);
    let draftLen = 0;
    for (let i = 0; i < count - 1; i++) draftLen += out.ds[i];
    let realizedLen = 0;
    for (let i = 0; i < so.count - 1; i++) {
        realizedLen += Math.hypot(so.posX[i + 1] - so.posX[i], so.posY[i + 1] - so.posY[i]);
    }
    expect(realizedLen).toBeCloseTo(draftLen, 2);

    // energy is conserved along the ride: ½v² + g·y = ½V0².
    const E0 = 0.5 * so.v[0] * so.v[0] + G * so.posY[0];
    for (let i = 0; i < so.count; i++) {
        if (so.v[i] <= 0) break; // past an energy-out point v clamps to 0
        expect(0.5 * so.v[i] * so.v[i] + G * so.posY[i]).toBeCloseTo(E0, 2);
    }
});

/** a fresh hill track (anchor (−16,0) → crest (0,2) → (16,0)), baked + solved.
 *  varying curvature, so a pin off the draft visibly reshapes force + swings
 *  geometry — the flat track is degenerate. */
function hill(): { state: State; eid: number } {
    const state = new State();
    state.addSystem(BakeSystem);
    state.addSystem(SolveSystem);
    const eid = createTrack(state);
    addNode(state, -16, 0);
    addNode(state, 0, 2);
    addNode(state, 16, 0);
    state.step(0);
    return { state, eid };
}

test("an authored pin pulls the solved force toward its value at the pinned index", () => {
    const { state, eid } = hill();
    const base = solveOut.get(eid);
    if (!base) throw new Error("solveOut missing after solve");
    const k = Math.floor(OPT_GRID * 0.4);
    const target = base.fN[k] + 1.5; // well off the draft

    const pin = addPin(eid, k, target);
    state.step(0); // pin bumps the gate → re-solve
    const so = solveOut.get(eid);
    if (!so || so === base) throw new Error("a pin must trigger a re-solve");

    // the pin weight (1e4) dominates the unit prior + smoothness, so the solved
    // force nearly hits the pinned value and is far closer than the draft was.
    expect(Math.abs(so.fN[k] - target)).toBeLessThan(0.2);
    expect(Math.abs(so.fN[k] - target)).toBeLessThan(Math.abs(base.fN[k] - target) / 4);

    removePin(eid, pin.id);
    state.step(0);
    const back = solveOut.get(eid);
    if (!back) throw new Error("solveOut missing after pin removal");
    for (let i = 0; i < back.count; i++) expect(back.fN[i]).toBeCloseTo(base.fN[i], 5);
});

test("the recovery anchor heals the downstream swing a pin causes", () => {
    // an unbalanced off-draft pin would rigidly swing the whole downstream (the
    // realized endpoint moves metres). the wired endpoint anchor pins (x,y,θ)
    // back to the draft, so the endpoint barely moves *even though* the pin
    // reshapes the force by ~2g — large force change, no geometry swing.
    const { state, eid } = hill();
    const base = solveOut.get(eid);
    if (!base) throw new Error("solveOut missing after solve");
    const endX = base.posX[base.count - 1];
    const endY = base.posY[base.count - 1];

    const k = Math.floor(OPT_GRID * 0.35);
    addPin(eid, k, base.fN[k] + 2); // a stiff, off-draft pin
    state.step(0);
    const so = solveOut.get(eid);
    if (!so) throw new Error("solveOut missing after pin");

    // the pin really moved the force (not a no-op heal)...
    expect(Math.abs(so.fN[k] - base.fN[k])).toBeGreaterThan(1.5);
    // ...yet the realized endpoint holds to the draft (the anchor healed it).
    const drift = Math.hypot(so.posX[so.count - 1] - endX, so.posY[so.count - 1] - endY);
    expect(drift).toBeLessThan(0.15); // metres — orders below the un-anchored swing
});

test("a dominant-weight bezier draft pulls the solved force onto the drawn curve", () => {
    // two pins ⇒ a piecewise bezier across the span. the pin weight (1e4) dominates
    // the unit prior + smoothness, so the solved force tracks the drawn curve at
    // every covered grid index — "full bezier at dominant weight → solved ≈ drawn".
    const { state, eid } = hill();
    const a = addPin(eid, Math.floor(OPT_GRID * 0.3), 2.5);
    const b = addPin(eid, Math.floor(OPT_GRID * 0.6), 0.5);
    state.step(0);
    const so = solveOut.get(eid);
    if (!so) throw new Error("solveOut missing after pins");

    const targets = constraintTargets(pinsOf(eid));
    // a non-trivial curve (the two pins differ), spanning the interior.
    expect(targets.length).toBeGreaterThan(40);
    let maxGap = 0;
    for (const t of targets) maxGap = Math.max(maxGap, Math.abs(so.fN[t.index] - t.value));
    expect(maxGap).toBeLessThan(0.1); // solved hugs the drawn curve across the whole span
    // every target sits inside the band, and so does the solved force there.
    for (const t of targets) {
        expect(t.value).toBeGreaterThan(-2);
        expect(t.value).toBeLessThan(6);
        expect(so.fN[t.index]).toBeLessThan(6.05);
    }
    void a;
    void b;
});

test("the recovery anchor heals the downstream swing of a full-span bezier draft", () => {
    // a balanced (doublet) bezier reshape across the span — above the draft on the
    // first half, below on the second. the single endpoint anchor pins (x,y,θ) to
    // the draft, so the realized endpoint barely moves: the 2b point-heal
    // generalizes to a curve in the single-shoot regime. (a *sustained* same-sign
    // reshape integrates a larger net heading change and drifts further — the
    // multiple-shooting regime, scratch.md "Optimizer design".)
    const { state, eid } = hill();
    const base = solveOut.get(eid);
    if (!base) throw new Error("solveOut missing after solve");
    const endX = base.posX[base.count - 1];
    const endY = base.posY[base.count - 1];

    const k0 = Math.floor(OPT_GRID * 0.3);
    const k1 = Math.floor(OPT_GRID * 0.6);
    addPin(eid, k0, base.fN[k0] + 0.5);
    addPin(eid, k1, base.fN[k1] - 0.5);
    state.step(0);
    const so = solveOut.get(eid);
    if (!so) throw new Error("solveOut missing after pins");

    // the curve really reshaped the force across the span...
    let reshape = 0;
    for (let i = 0; i < so.count; i++) reshape = Math.max(reshape, Math.abs(so.fN[i] - base.fN[i]));
    expect(reshape).toBeGreaterThan(0.4);
    // ...yet the realized endpoint holds to the draft (measured ≈0.14 m; the
    // un-anchored swing of a reshape this wide is metres).
    const drift = Math.hypot(so.posX[so.count - 1] - endX, so.posY[so.count - 1] - endY);
    expect(drift).toBeLessThan(0.2);
});

test("authored overshoot survives: a bezier pulled above the ceiling rides above the band", () => {
    // handles dragged up push the curve above the 6g ceiling. the pin weight (1e4)
    // dominates the band hinge (≈4), so the authored overshoot survives in the
    // solved force — the absolute-g deviation, end to end.
    const { state, eid } = hill();
    const a = addPin(eid, Math.floor(OPT_GRID * 0.35), 5.5);
    const b = addPin(eid, Math.floor(OPT_GRID * 0.55), 5.5);
    // bow the segment well above the ceiling via the tangent handles (free dy).
    setHandle(eid, a.id, "r", 1 / 3, 3);
    setHandle(eid, b.id, "l", 1 / 3, 3);
    state.step(0);
    const so = solveOut.get(eid);
    if (!so) throw new Error("solveOut missing after pins");

    const targets = constraintTargets(pinsOf(eid));
    const peak = Math.max(...targets.map((t) => t.value));
    expect(peak).toBeGreaterThan(6); // the drawn curve overshoots the band
    const midIdx = targets.find((t) => t.value === peak)?.index ?? a.index;
    expect(so.fN[midIdx]).toBeGreaterThan(6); // and the solved force follows it over
});

test("a re-solve is skipped while the bake is unchanged (hash gate)", () => {
    const state = new State();
    state.addSystem(BakeSystem);
    state.addSystem(SolveSystem);
    const eid = createTrack(state);
    addNode(state, -16, 0);
    addNode(state, 16, 0);
    state.step(0);
    const first = solveOut.get(eid);
    if (!first) throw new Error("solveOut missing after solve");
    state.step(0); // nothing moved
    expect(solveOut.get(eid)).toBe(first); // same object — not recomputed
});
