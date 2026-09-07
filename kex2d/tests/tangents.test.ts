import { describe, expect, test } from "bun:test";
import { handleTip, TangentMode } from "../src/spline";
import { editHandleSets, localTipAt, stitchNode, tangentHandles } from "../src/tangents";
import { Handle, handleAt, lastHandle, samples, SectionKind, setTangent } from "../src/track";
import { cameraTx, screenToWorld } from "../src/view";
import { build } from "./helpers/build";

// tangentHandles (local offset → world, rotated by the section entry heading → screen, via
// tx) and localTipAt (its exact inverse: screen-derived world → local offset) are the two
// halves of the world↔screen↔local seam the handle-drag UI drives. this pins the round trip
// against a sign/rotation error, over a section whose entry frame carries real rotation +
// translation (not the identity frame a first section's node 0 would give) and a view with
// zoom + a y-flip (kex2d's screen convention, `cameraTx`'s `sy = -zoom`).
//
// the shared authoring builder: the node geometry below is authored through the shared `Build` helper
// (`tests/helpers/build.ts`), the same `applyOp` dispatch the CLI and the UI share; the
// explicit `TangentMode.Free` tangents this file pins have no op counterpart (`commands.ts`'s
// vocabulary carries no tangent-setting op), so `setTangent` stays a raw `track.ts` call.

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
        const bd = build();
        const eid = bd.trackEid;
        const a = bd.appendSection(SectionKind.Geo);
        bd.moveNode(a, 1, 24, 10); // the last handle reheads on its own move

        const b = bd.appendSection(SectionKind.Geo);
        bd.addNode(b, 20, -3); // a third node so node 1 keeps both neighbors (both handles show)
        const mag = 6.7;
        const tan = {
            mode: TangentMode.Free,
            inX: mag * Math.cos(-1.1),
            inY: mag * Math.sin(-1.1),
            outX: mag * Math.cos(0.9) * 1.4,
            outY: mag * Math.sin(0.9) * 1.4,
        };
        setTangent(bd.ecs, b, 1, tan);
        bd.bake();
        const state = bd.ecs;

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

// node 0 (the section entry anchor) is editable now: it exposes a single OUT-handle — the entry
// handle, the direction + length of the first segment leaving the section. its in-handle drives no
// segment, so it never shows. and at a geo→geo boundary the upstream tip's tangent edit stitches in
// the downstream section's node-0 out-handle (the one node the boundary really is), whose drag
// writes the downstream section's own tangent.
describe("node-0 entry handle + boundary stitch", () => {
    const tx = cameraTx({ zoom: 1, ox: 0, oy: 0 });

    test("node 0 shows only its out-handle (the entry handle), never an in-handle", () => {
        const bd = build();
        const eid = bd.trackEid;
        const a = bd.appendSection(SectionKind.Geo);
        bd.moveNode(a, 1, 24, 0);
        bd.bake();
        const state = bd.ecs;
        const s = samples.get(eid);
        const node0 = handleAt(state, a, 0);
        if (!s || node0 === null) throw new Error("setup missing");
        const sides = tangentHandles(state, s, tx, node0).map((h) => h.side);
        expect(sides).toEqual(["out"]);
    });

    test("stitchNode resolves a geo→geo boundary tip to the downstream node 0, and not otherwise", () => {
        const bd = build();
        const a = bd.appendSection(SectionKind.Geo);
        bd.moveNode(a, 1, 24, 0);
        const b = bd.appendSection(SectionKind.Geo); // B seeded with node 0 + node 1
        bd.bake();
        const state = bd.ecs;

        const tipA = lastHandle(state, a);
        const node0B = handleAt(state, b, 0);
        if (tipA === null || node0B === null) throw new Error("setup missing");
        expect(stitchNode(state, tipA)).toBe(node0B); // the boundary is one node, stitched

        // the downstream node 0 isn't itself a chain tip, so it stitches nothing (no runaway chain).
        expect(stitchNode(state, node0B)).toBeNull();
    });

    test("a force downstream section is not stitched (only geo→geo)", () => {
        const bd = build();
        const a = bd.appendSection(SectionKind.Geo);
        bd.moveNode(a, 1, 24, 0);
        bd.appendSection(SectionKind.Force);
        bd.bake();
        const state = bd.ecs;
        const tipA = lastHandle(state, a);
        if (tipA === null) throw new Error("tip missing");
        expect(stitchNode(state, tipA)).toBeNull();
    });

    test("editHandleSets on a boundary tip carries the downstream node-0 out-handle for write-through", () => {
        const bd = build();
        const eid = bd.trackEid;
        const a = bd.appendSection(SectionKind.Geo);
        bd.moveNode(a, 1, 24, 0);
        const b = bd.appendSection(SectionKind.Geo);
        bd.bake();
        const state = bd.ecs;
        const s = samples.get(eid);
        const tipA = lastHandle(state, a);
        const node0B = handleAt(state, b, 0);
        if (!s || tipA === null || node0B === null) throw new Error("setup missing");

        const sets = editHandleSets(state, s, tx, tipA);
        // the tip's own set (its in-handle — a chain end has no out) + the stitched downstream set.
        const stitchSet = sets.find((set) => set.eid === node0B);
        expect(stitchSet).toBeDefined();
        expect(stitchSet?.handles.map((h) => h.side)).toEqual(["out"]);

        // the write-through: authoring the stitched node-0 tangent (as the drag does, via that set's
        // own eid → its section) reshapes section B's first segment. `samples` is one reused buffer,
        // so read the flat default into a number BEFORE the re-bake overwrites it in place.
        const start = Handle.sample.get(node0B);
        const yBefore = s.posY[start + 2];
        setTangent(state, b, 0, { mode: TangentMode.Free, inX: 1, inY: 0, outX: 20, outY: 20 });
        bd.bake();
        const s2 = samples.get(eid);
        if (!s2) throw new Error("bake missing");
        // a sample a couple past the boundary now rides higher than the flat default did.
        expect(s2.posY[start + 2]).toBeGreaterThan(yBefore);
    });
});
