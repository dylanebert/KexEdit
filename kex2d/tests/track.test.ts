import { describe, expect, test } from "bun:test";
import { State } from "@dylanebert/shallot";
import {
    addNode,
    BakeSystem,
    bakeOut,
    createTrack,
    EXTEND_DIST,
    extend,
    Handle,
    reheadOnDrag,
    removeTrailingHandle,
    samples,
    sortedHandles,
    Track,
} from "../src/track";

// the ECS layer: BakeSystem wires sortedHandles → chain([one geo section]) →
// computeTime, syncs each node's sample index, and records the orphan /
// feasibility state the renderer reads. the pure pieces are covered in
// section/spline/bake/forward; this pins the integration the glue owns. the bake
// is pure CPU, so the test runs BakeSystem on a device-free State via the
// scheduler — no GPU. `state.step()` runs BakeSystem (default group simulation).

/** a fresh flat track: two free nodes at (−16,0) and (16,0), the same flat seed
 *  the plugin starts with. */
function track(): { state: State; eid: number } {
    const state = new State();
    state.addSystem(BakeSystem);
    const eid = createTrack(state);
    addNode(state, -16, 0);
    addNode(state, 16, 0);
    return { state, eid };
}

describe("BakeSystem", () => {
    test("a flat horizontal chain bakes to 1g and is fully feasible", () => {
        const { state, eid } = track();
        state.step(0);
        const count = Track.count.get(eid);
        const out = bakeOut.get(eid);
        const s = samples.get(eid);
        if (!out || !s) throw new Error("track buffers missing");

        expect(count).toBeGreaterThan(2);
        // straight + level: no turning (dθ = 0) and cos θ = 1, so F_n = 1g.
        for (let i = 0; i < count - 1; i++) expect(out.fN[i]).toBeCloseTo(1, 3);
        for (let i = 0; i < count; i++) expect(s.posY[i]).toBeCloseTo(0, 4);
        expect(out.firstInfeasible).toBe(-1);
        for (let i = 0; i < count; i++) expect(out.feasible[i]).toBe(1);
    });

    test("the baked curve passes through every node; free positions stay put", () => {
        const { state, eid } = track();
        addNode(state, 40, 2); // a third node off-axis
        state.step(0);
        const s = samples.get(eid);
        if (!s) throw new Error("samples missing");

        const handles = sortedHandles(state);
        for (const h of handles) {
            const i = Handle.sample.get(h);
            expect(s.posX[i]).toBeCloseTo(Handle.pos.x.get(h), 4);
            expect(s.posY[i]).toBeCloseTo(Handle.pos.y.get(h), 4);
        }
        // every position is authored, not derived — unmoved by the bake.
        expect(Handle.pos.x.get(handles[0])).toBeCloseTo(-16, 6);
        expect(Handle.pos.y.get(handles[0])).toBeCloseTo(0, 6);
        expect(Handle.pos.x.get(handles[2])).toBeCloseTo(40, 6);
        expect(Handle.pos.y.get(handles[2])).toBeCloseTo(2, 6);
    });

    test("the off-origin flat anchor lands at sample 0 (entry = node 0's world pose)", () => {
        // the seed puts node 0 at (−16, 0), not the origin. the bake derives the
        // section entry from node 0 and localizes the handles into it, so sample 0
        // reproduces node 0's world position — guards the substrate wiring against
        // seeding sample 0 from a fixed {0,0} entry (which would strand the anchor).
        const { state, eid } = track();
        state.step(0);
        const s = samples.get(eid);
        if (!s) throw new Error("samples missing");
        expect(s.posX[0]).toBeCloseTo(-16, 4);
        expect(s.posY[0]).toBeCloseTo(0, 4);
    });

    test("extend lays a node continuing the last edge's direction", () => {
        const { state } = track(); // last edge is +x from (16,0)
        const before = sortedHandles(state).length;
        const e = extend(state);
        state.step(0);
        const handles = sortedHandles(state);
        expect(handles.length).toBe(before + 1);
        expect(handles[handles.length - 1]).toBe(e);
        // the new node lands EXTEND_DIST further along +x at (16 + EXTEND_DIST, 0).
        expect(Handle.pos.x.get(e)).toBeCloseTo(16 + EXTEND_DIST, 6);
        expect(Handle.pos.y.get(e)).toBeCloseTo(0, 6);
    });

    test("removing the trailing node drops it, never below two nodes", () => {
        const { state } = track();
        extend(state); // a third node
        state.step(0);
        expect(sortedHandles(state).length).toBe(3);

        expect(removeTrailingHandle(state)).toBe(true);
        expect(sortedHandles(state).length).toBe(2);
        // a two-node chain is the floor — further removal is refused.
        expect(removeTrailingHandle(state)).toBe(false);
        expect(sortedHandles(state).length).toBe(2);
    });

    test("deleting the tip re-derives the promoted node's heading (no stale jump)", () => {
        const { state } = track();
        addNode(state, 40, 0); // nodes 0,1,2
        const h = sortedHandles(state);
        // node 1 is interior with an off-axis position and a deliberately stale
        // heading — what a frozen interior heading looks like before promotion.
        Handle.pos.set(h[1], 16, 8);
        Handle.theta.set(h[1], 0.5);
        expect(removeTrailingHandle(state)).toBe(true); // drop node 2 → node 1 is the tip
        // the promoted tip re-derives from node 0 (flat): reflect(0, chord₀→₁).
        expect(Handle.theta.get(h[1])).toBeCloseTo(2 * Math.atan2(8, 16 - -16), 10);
        expect(Handle.theta.get(h[1])).not.toBe(0.5); // not the stale value
    });

    test("an unchanged chain is not re-baked; moving a node re-bakes (hash gate)", () => {
        const { state, eid } = track();
        state.step(0);
        const out = bakeOut.get(eid);
        if (!out) throw new Error("bakeOut missing");
        out.fN[0] = 999; // a re-bake would overwrite this sentinel
        state.step(0);
        expect(out.fN[0]).toBe(999); // unchanged → bake skipped

        Handle.pos.set(sortedHandles(state)[0], -16, 1); // move a node
        state.step(0);
        expect(out.fN[0]).not.toBe(999); // hash miss → re-baked
    });

    test("a steep straight climb beyond the energy budget flags downstream infeasible", () => {
        // ½·V0² = 50 J/kg reaches only ~5.1 m of climb. a straight ramp up at
        // ~60° (rise ≈ 27.7 m over 32 m) depletes energy partway up.
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        addNode(state, -16, 0);
        addNode(state, 0, 27.7);
        state.step(0);
        const out = bakeOut.get(eid);
        const count = Track.count.get(eid);
        if (!out) throw new Error("bakeOut missing");

        expect(out.feasible[0]).toBe(1); // launches at V0 = 10
        expect(out.firstInfeasible).toBeGreaterThan(0);
        expect(out.firstInfeasible).toBeLessThan(count);
        expect(out.feasible[count - 1]).toBe(0); // energy-depleted up the climb
    });

    test("a smooth curve bakes to a non-oscillating F_n", () => {
        // a gentle S-wave: a shallow rise, an arc-over, an arc-under, a level-
        // out. its true normal force varies slowly, so the baked F_n's slope
        // should reverse only where the curvature genuinely turns over — not
        // sample-to-sample. guards against regressing BakeSystem back to the
        // leapfrog-mode reflection inverse. small deviations keep the frozen-
        // heading reflection chain shallow (no runaway swing).
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        addNode(state, -40, 0);
        addNode(state, -20, 2);
        addNode(state, 0, 0);
        addNode(state, 20, -2);
        addNode(state, 40, 0);
        state.step(0);
        const out = bakeOut.get(eid);
        const count = Track.count.get(eid);
        if (!out) throw new Error("bakeOut missing");

        let reversals = 0;
        for (let i = 2; i < count - 1; i++) {
            const a = out.fN[i - 1] - out.fN[i - 2];
            const b = out.fN[i] - out.fN[i - 1];
            if (a * b < 0) reversals++;
        }
        expect(reversals).toBeLessThan((count - 1) / 4);
    });

    test("a coincident interior node orphans the trailing nodes", () => {
        const { state, eid } = track(); // nodes order 0,1
        addNode(state, 16, 0); // order 2 — coincident with node 1
        addNode(state, 40, 0); // order 3
        state.step(0);
        const out = bakeOut.get(eid);
        if (!out) throw new Error("bakeOut missing");

        expect(out.lastBakedOrder).toBe(1);
        const orphaned = sortedHandles(state)
            .map((h) => Handle.order.get(h))
            .filter((o) => o > out.lastBakedOrder);
        expect(orphaned).toEqual([2, 3]);
    });
});

describe("reheadOnDrag", () => {
    // the drag-time heading refresh: the last node always tracks its
    // predecessor; the first node (flat anchor) + interior nodes stay frozen.
    // controls.ts calls this after every pointermove; the pure logic is
    // exercised here without the DOM.

    test("dragging the last node re-derives its heading (the bend you drag in)", () => {
        const { state } = track(); // flat seed (−16,0),(16,0), both θ = 0
        const end = sortedHandles(state)[1];
        Handle.pos.set(end, 16, 10); // drag the end up
        reheadOnDrag(state, end);
        // predecessor heading is 0, so the exit reflects to 2·chord — a real arc.
        expect(Handle.theta.get(end)).toBeCloseTo(2 * Math.atan2(10, 16 - -16), 10);
    });

    test("dragging the node before the last re-aims the last node — no stale jump", () => {
        const { state } = track();
        addNode(state, 40, 0); // nodes 0,1,2 — node 2 is last, node 1 is before it
        const h = sortedHandles(state);
        expect(Handle.theta.get(h[2])).toBe(0); // last starts flat
        Handle.pos.set(h[1], 16, 8); // drag the node *before* the last
        reheadOnDrag(state, h[1]);
        // node 1 stays frozen; the last node re-derives from node 1's new position.
        expect(Handle.theta.get(h[1])).toBe(0);
        expect(Handle.theta.get(h[2])).toBeCloseTo(2 * Math.atan2(0 - 8, 40 - 16), 10);
    });

    test("the flat anchor and a pure interior node never re-derive", () => {
        const { state } = track();
        addNode(state, 40, 0);
        addNode(state, 64, 0); // nodes 0,1,2,3
        const h = sortedHandles(state);
        Handle.theta.set(h[1], 0.5); // node 1 is pure interior (not last, not before-last)
        const lastBefore = Handle.theta.get(h[3]);

        Handle.pos.set(h[0], -16, -6); // drag the flat anchor off-axis
        reheadOnDrag(state, h[0]);
        expect(Handle.theta.get(h[0])).toBe(0); // stays flat

        Handle.pos.set(h[1], 16, 8); // drag the pure interior node far off its chord
        reheadOnDrag(state, h[1]);
        expect(Handle.theta.get(h[1])).toBe(0.5); // frozen
        expect(Handle.theta.get(h[3])).toBe(lastBefore); // last node untouched
    });

    test("a dragged end bends its segment into an arc — end to end", () => {
        const { state, eid } = track();
        const end = sortedHandles(state)[1];
        Handle.pos.set(end, 16, 10);
        reheadOnDrag(state, end);
        state.step(0);
        const s = samples.get(eid);
        if (!s) throw new Error("samples missing");
        const count = Track.count.get(eid);
        // the re-derived heading makes a clean arc that *exits* climbing at
        // reflect(0, chord) ≈ 0.6 rad. without reheadOnDrag the end heading stays
        // 0 and the curve exits flat (≈ 0), so the exit angle pins the re-head;
        // the climb alone wouldn't (the node moved up regardless).
        expect(s.theta[count - 1]).toBeGreaterThan(0.3);
        expect(s.posY[Math.floor(count / 2)]).toBeGreaterThan(0); // a real climb
    });
});
