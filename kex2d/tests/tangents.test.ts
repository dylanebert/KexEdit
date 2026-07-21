import { describe, expect, test } from "bun:test";
import { State } from "@dylanebert/shallot";
import { handleTip, TangentMode } from "../src/spline";
import { localTipAt, tangentHandles } from "../src/tangents";
import {
    addNode,
    appendSection,
    BakeSystem,
    createSection,
    createTrack,
    Handle,
    handleAt,
    reheadOnDrag,
    samples,
    SectionKind,
    sectionHandles,
    setTangent,
} from "../src/track";
import { cameraTx, screenToWorld } from "../src/view";

// tangentHandles (local offset → world, rotated by the section entry heading → screen, via
// tx) and localTipAt (its exact inverse: screen-derived world → local offset) are the two
// halves of the world↔screen↔local seam the handle-drag UI drives. this pins the round trip
// against a sign/rotation error, over a section whose entry frame carries real rotation +
// translation (not the identity frame a first section's node 0 would give) and a view with
// zoom + a y-flip (kex2d's screen convention, `cameraTx`'s `sy = -zoom`).

/** an explicit tangent's f32 storage quantizes its components (`Handle.tin`/`tout`, `vec2` of
 *  `f32`) at ~2^-23 relative to the vector's own magnitude — the only lossy step in the round
 *  trip (the rotation forward and its algebraic inverse in `localTipAt` cancel in f64 to near
 *  machine epsilon). headroom covers the handful of trig + divide ops each side chains. */
const F32_EPS = 2 ** -23;
function tol(vx: number, vy: number): number {
    return Math.hypot(vx, vy) * F32_EPS * 8;
}

describe("tangentHandles ∘ localTipAt inverse", () => {
    test("a handle's screen position round-trips to its stored local tangent, both sides", () => {
        // section B's entry is A's real (bent) exit — nonzero rotation AND translation, not the
        // identity frame section A's own node 0 sits at.
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        const a = createSection(state, 0, SectionKind.Geo, 0);
        addNode(state, a, 0, 0);
        addNode(state, a, 24, 0);
        const tip = sectionHandles(state, a)[1];
        Handle.pos.set(tip, 24, 10);
        reheadOnDrag(state, tip);

        const b = appendSection(state, SectionKind.Geo);
        addNode(state, b, 20, -3); // a third node so node 1 keeps both neighbors (both handles show)
        const mag = 6.7;
        const tan = {
            mode: TangentMode.Free,
            inX: mag * Math.cos(-1.1),
            inY: mag * Math.sin(-1.1),
            outX: mag * Math.cos(0.9) * 1.4,
            outY: mag * Math.sin(0.9) * 1.4,
        };
        setTangent(state, b, 1, tan);
        state.step(0);

        const node = handleAt(state, b, 1);
        if (node === null) throw new Error("node missing");
        const s = samples.get(eid);
        if (!s) throw new Error("samples missing");

        // zoom + y-flip (`sy = -zoom`, the render convention) + a nonzero pan.
        const tx = cameraTx({ zoom: 2.7, ox: 41, oy: -18 });
        const handles = tangentHandles(state, s, tx, node);
        expect(handles.map((h) => h.side).sort()).toEqual(["in", "out"]);

        for (const h of handles) {
            const world = screenToWorld(tx, h.x, h.y);
            const local = localTipAt(s, node, world.x, world.y);
            const expected = handleTip(tan, h.side);
            const err = Math.hypot(local[0] - expected[0], local[1] - expected[1]);
            expect(err).toBeLessThan(tol(expected[0], expected[1]));
        }
    });
});
