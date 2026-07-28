import { State } from "@dylanebert/shallot";
import { describe, expect, test } from "bun:test";
import { liveWorkers } from "../src/convert";
import { convertGeo, StaleConvert } from "../src/geoforce";
import { createHistory, type History, undo } from "../src/history";
import {
    addNode,
    appendSection,
    BakeSystem,
    bakeOut,
    createSection,
    createTrack,
    Handle,
    handleAt,
    Section,
    sectionAt,
    sectionForces,
    sectionHandles,
    sectionInfo,
    SectionKind,
    type SectionSnapshot,
    setTrackV0,
    snapshotAll,
} from "../src/track";
import { divergingPool, withWorker } from "./helpers/pool";

// the invoked geo→force command (kex2d-geoforce-editor stage 2): the conversion tier solved
// off-thread, landed on the document as ONE undo entry. the solve itself is oracled in
// `convert.test.ts` against the frozen golden; what's pinned here is the document seam —
// atomicity, byte-identical undo, downstream continuity, and that a conversion which does not
// finish writes nothing at all.

/** a track carrying one geo hump (the shape a conversion is invoked on), baked. */
function humpTrack(): { state: State; eid: number; sec: number } {
    const state = new State();
    state.addSystem(BakeSystem);
    const eid = createTrack(state);
    setTrackV0(eid, 18);
    const sec = createSection(state, 0, SectionKind.Geo, 0);
    addNode(state, sec, 0, 0);
    addNode(state, sec, 12, 4);
    addNode(state, sec, 24, 0);
    state.step(0);
    return { state, eid, sec };
}

/** the whole authored document plus the bake's own input hash — the two readings that
 *  together say "byte-identical": every stored value back where it was, and the bake gate
 *  agreeing nothing about its input moved. */
function docState(state: State, eid: number): { snap: SectionSnapshot[]; hash: string } {
    return { snap: snapshotAll(state), hash: bakeOut.get(eid)?.hash ?? "" };
}

/** convert `sec` and settle the bake, asserting the solve actually converged (every pin below
 *  is about the document, not about the solver having a good day). */
async function convertAndBake(h: History, state: State, sec: number) {
    const result = await convertGeo(h, state, sec);
    expect(result.outcome).toBe("floor");
    state.step(0);
    return result;
}

describe("convertGeo", () => {
    test("the solve lands atomically and undo restores the geo section byte-identical", async () => {
        const { state, eid, sec } = humpTrack();
        const h = createHistory();
        const before = docState(state, eid);

        const result = await convertAndBake(h, state, sec);

        const secEid = sectionAt(state, sec);
        if (secEid === null) throw new Error("section missing");
        expect(Section.kind.get(secEid)).toBe(SectionKind.Force);
        // the solve's realized extent and step, exactly — not the nominal quantum, and not the
        // destructive convert's default extent + sentinel step.
        expect(Section.length.get(secEid)).toBe(result.length);
        expect(Section.ds.get(secEid)).toBe(result.ds);
        // the shape nodes are gone and the answer's keyframes are all that's there.
        expect(sectionHandles(state, sec)).toHaveLength(0);
        expect(sectionForces(state, sec).map(({ s, g }) => ({ s, g }))).toEqual(result.points);

        // one entry, and undoing it puts the track back exactly as authored.
        expect(h.undo).toHaveLength(1);
        undo(h, state);
        state.step(0);
        expect(docState(state, eid)).toEqual(before);
    }, 60_000);

    test("the converted section joins the chain where the geo shape exited", async () => {
        // continuity is the whole point of a shape-preserving conversion: the downstream
        // section is placed rigidly at this one's exit, so an exit that moved re-frames the
        // rest of the track. the bound is stage 1's exit-miss oracle, at the document layer:
        // the realized step spans the solve exactly and closes the pinned exit to ~1e-5 m,
        // while replaying the same profile at the nominal quantum stops ~0.2 m short. 1e-3
        // separates the two by orders of magnitude — the solve's own ~0.5 m floor is far too
        // loose to tell them apart.
        const { state, sec } = humpTrack();
        const down = appendSection(state, SectionKind.Geo);
        state.step(0);
        const geoExit = { ...(sectionInfo.get(down)?.entry ?? { x: Number.NaN, y: Number.NaN }) };

        await convertAndBake(createHistory(), state, sec);

        const forceExit = sectionInfo.get(down)?.entry;
        if (!forceExit) throw new Error("downstream section lost its bake");
        const miss = Math.hypot(forceExit.x - geoExit.x, forceExit.y - geoExit.y);
        expect(miss).toBeLessThan(1e-3);
    }, 60_000);

    test("a cancelled conversion leaves the track byte-identical", async () => {
        // the façade writes nothing and the apply happens once at resolution, so there is no
        // rollback path to get wrong — this pins that there is nothing TO roll back.
        const { state, eid, sec } = humpTrack();
        const h = createHistory();
        const before = docState(state, eid);

        const controller = new AbortController();
        const solving = convertGeo(h, state, sec, { signal: controller.signal });
        controller.abort(new Error("cancelled from the modal"));
        // the caller's own reason comes back, not a generic failure — that is what lets a UI
        // tell a cancel apart from a conversion that broke.
        await expect(solving).rejects.toThrow(/cancelled from the modal/);

        state.step(0);
        expect(docState(state, eid)).toEqual(before);
        expect(h.undo).toHaveLength(0);
        expect(liveWorkers()).toBe(0);
    }, 60_000);

    test("a diverged conversion leaves the track byte-identical", async () => {
        // a diverged answer still resolves — the caller surfaces it — but it is not an
        // authored section, so nothing of it reaches the document (its NaN deviation above
        // all, which is why nothing but points/length/ds is ever stored).
        const { state, eid, sec } = humpTrack();
        const h = createHistory();
        const before = docState(state, eid);

        const result = await withWorker(divergingPool(), () =>
            convertGeo(h, state, sec, { workers: 4 }),
        );
        expect(result.outcome).toBe("diverged");

        state.step(0);
        expect(docState(state, eid)).toEqual(before);
        expect(h.undo).toHaveLength(0);
    }, 60_000);

    test("an edit during the solve rejects the answer instead of landing it stale", async () => {
        // the solve targets the shape it was handed. if the document moves under it — a node
        // drag, a delete, another op — its answer describes a shape that is no longer there, and
        // landing it would silently replace what the author just did. the caller blocks input
        // for the duration; this is the backstop for when something gets through anyway.
        const { state, eid, sec } = humpTrack();
        const h = createHistory();

        const solving = convertGeo(h, state, sec);
        const crest = handleAt(state, sec, 1);
        if (crest === null) throw new Error("node missing");
        Handle.pos.set(crest, 12, 9); // a mid-solve reshape
        state.step(0);
        const edited = docState(state, eid);

        await expect(solving).rejects.toThrow(StaleConvert);
        state.step(0);
        expect(docState(state, eid)).toEqual(edited); // the edit stands, the answer is dropped
        expect(h.undo).toHaveLength(0);
    }, 60_000);

    test("a second invoke while one is running is refused", async () => {
        // two solves landing on one section would each snapshot the other's output as their
        // "before", so the second undo would restore the first solve rather than the geo shape.
        const { state, sec } = humpTrack();
        const h = createHistory();

        const first = convertGeo(h, state, sec);
        await expect(convertGeo(h, state, sec)).rejects.toThrow(/already converting/);
        await first;
        state.step(0);

        expect(h.undo).toHaveLength(1);
        undo(h, state);
        state.step(0);
        expect(sectionHandles(state, sec)).toHaveLength(3); // one entry took it all the way back
        // and the section is free again once the first invoke settled.
        await expect(convertGeo(h, state, sec)).resolves.toMatchObject({ outcome: "floor" });
    }, 60_000);

    test("a section that isn't geo is refused", async () => {
        const { state, sec } = humpTrack();
        const force = appendSection(state, SectionKind.Force);
        state.step(0);
        await expect(convertGeo(createHistory(), state, force)).rejects.toThrow(/not geo/);
        await expect(convertGeo(createHistory(), state, sec + 999)).rejects.toThrow(/no section/);
    });
});
