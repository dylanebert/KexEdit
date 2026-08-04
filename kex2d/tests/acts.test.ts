import { afterEach, describe, expect, test } from "bun:test";
import { State } from "@dylanebert/shallot";
import { keyframeActs, nodeActs, sectionActs } from "../src/acts";
import {
    beginLanding,
    closeContext,
    editor,
    endPin,
    openContext,
    select,
    selectForce,
    selectForces,
    selectNodes,
    selectSection,
    skipLanding,
} from "../src/editor";
import { history } from "../src/history";
import { enterPinMode, exitPinMode } from "../src/pin";
import { TangentMode } from "../src/spline";
import {
    addNode,
    appendSection,
    BakeSystem,
    EXTEND_DIST,
    Handle,
    handleTangent,
    lastHandle,
    sectionForces,
    sectionHandles,
    sections,
    SectionKind,
    createSection,
    createTrack,
    createForcePoint,
    setTangent,
    setTrackV0,
} from "../src/track";

// the third member of the menu triple's own coverage (kex2d-act-factory stage 2): drives each
// factory's acts against a real ECS track — history.test.ts/ops.test.ts's shape — testing the ACT
// layer (a record entry does the thing and carries its own guard), never re-testing the underlying
// ops (`removeSection`, `trimTrack`, …) those files already pin.

/** a bare geo track: one section, `n` flat nodes at `i * EXTEND_DIST` along x. */
function geoTrack(n = 2): { state: State; sec: number } {
    const state = new State();
    state.addSystem(BakeSystem);
    createTrack(state);
    const sec = createSection(state, 0, SectionKind.Geo, 0);
    for (let i = 0; i < n; i++) addNode(state, sec, i * EXTEND_DIST, 0);
    state.step(0);
    return { state, sec };
}

/** two geo sections, chained. */
function twoGeoSections(): { state: State; a: number; b: number } {
    const { state, sec: a } = geoTrack(2);
    const b = appendSection(state, SectionKind.Geo);
    state.step(0);
    return { state, a, b };
}

/** three geo sections, chained — the smallest chain where a bulk delete of TWO is not the
 *  last-section floor. */
function threeGeoSections(): { state: State; a: number; b: number; c: number } {
    const { state, a, b } = twoGeoSections();
    const c = appendSection(state, SectionKind.Geo);
    state.step(0);
    return { state, a, b, c };
}

/** a force section, seeded with five keyframes (pin.test.ts's shape). */
function forceTrack(): { state: State; sec: number } {
    const state = new State();
    state.addSystem(BakeSystem);
    const eid = createTrack(state);
    setTrackV0(eid, 20);
    const sec = createSection(state, 0, SectionKind.Force, 40);
    createForcePoint(state, sec, 0, 1);
    createForcePoint(state, sec, 10, 1.5);
    createForcePoint(state, sec, 20, 1);
    createForcePoint(state, sec, 30, 0.8);
    createForcePoint(state, sec, 40, 1);
    state.step(0);
    return { state, sec };
}

/** two force sections, chained — `b`'s two keyframes come from `appendSection`'s own
 *  continuation seed (kex2d/AGENTS.md's Model (force authoring)). */
function twoForceSections(): { state: State; a: number; b: number } {
    const { state, sec: a } = forceTrack();
    const b = appendSection(state, SectionKind.Force);
    state.step(0);
    return { state, a, b };
}

/** a pinnable force section (`a`) plus an UNRELATED force section (`b`) carrying its own
 *  interior keyframe — `twoForceSections`' `b` only has the two boundary continuation
 *  keyframes (non-interior, so a cut there would no-op on its OWN merits and couldn't
 *  distinguish a consent-boundary leak from a correct refusal). `b`'s middle key at s=20
 *  is a genuine landmark Cut point. */
function twoForceSectionsInterior(): { state: State; a: number; b: number } {
    const { state, a } = twoForceSections();
    const b = createSection(state, 1, SectionKind.Force, 40);
    createForcePoint(state, b, 0, 1);
    createForcePoint(state, b, 20, 1);
    createForcePoint(state, b, 40, 1);
    state.step(0);
    return { state, a, b };
}

/** a pinnable force section (`a`) plus an UNRELATED geo section (`geo`) with an interior,
 *  cuttable node (order 2 of 4) — the consent-boundary repro's shape for `nodeActs.cut`. */
function forceAndGeoSections(): { state: State; force: number; geo: number } {
    const { state, sec: force } = forceTrack();
    const geo = appendSection(state, SectionKind.Geo);
    addNode(state, geo, 2 * EXTEND_DIST, 0);
    addNode(state, geo, 3 * EXTEND_DIST, 0);
    state.step(0);
    return { state, force, geo };
}

afterEach(() => {
    // a leaked pin session would leave `history.record` redirected into a dead sandbox for
    // every later test (`endPin`'s `redirectHistory(null)` is what actually clears that global).
    if (editor.pinning !== null) endPin();
    // a leaked landing override poisons `bakeLive` (`track.ts`, module-level) for every LATER
    // test's `enterPin`/`enterPinMode` — not just this test's own `state`.
    skipLanding();
    editor.locked.clear();
    closeContext();
    selectSection(null);
    select(null);
    selectForce(null);
});

describe("sectionActs", () => {
    test("remove deletes the section and clears the section selection", () => {
        const { state, a, b } = twoGeoSections();
        selectSection(a);
        sectionActs(state, a).remove();
        expect(sections(state).map((s) => s.id)).toEqual([b]);
        expect(editor.sections.active).toBeNull();
    });

    test("remove refuses at the last-section floor", () => {
        const { state, sec } = geoTrack(2);
        sectionActs(state, sec).remove();
        expect(sections(state).length).toBe(1);
    });

    test("remove refuses while ANY pin session is open, even on a different section", () => {
        const { state, a, b } = twoForceSections();
        if (!enterPinMode(state, a)) throw new Error("no session");
        const before = sections(state).length;
        sectionActs(state, b).remove();
        expect(sections(state).length).toBe(before);
        exitPinMode(state);
    });

    test("removeSet deletes the whole selected set as one op and clears the section selection", () => {
        const { state, a, b, c } = threeGeoSections();
        selectSection(a);
        selectSection(b, "toggle");
        sectionActs(state, a).removeSet();
        expect(sections(state).map((s) => s.id)).toEqual([c]);
        expect(editor.sections.active).toBeNull();
    });

    test("removeSet refuses at the last-section floor", () => {
        const { state, sec } = geoTrack(2);
        selectSection(sec);
        sectionActs(state, sec).removeSet();
        expect(sections(state).length).toBe(1);
    });

    test("removeSet refuses while ANY pin session is open", () => {
        const { state, a, b } = twoForceSections();
        if (!enterPinMode(state, a)) throw new Error("no session");
        selectSection(b);
        const before = sections(state).length;
        sectionActs(state, b).removeSet();
        expect(sections(state).length).toBe(before);
        exitPinMode(state);
    });

    test("reset lands a geo section at its creation state (the flat two-node seed)", () => {
        const { state, sec } = geoTrack(3);
        const tip = lastHandle(state, sec);
        if (tip === null) throw new Error("no tip");
        Handle.pos.set(tip, 500, 500);
        sectionActs(state, sec).reset();
        const handles = sectionHandles(state, sec);
        expect(handles.length).toBe(2);
        expect(Handle.pos.x.get(handles[1])).toBeCloseTo(EXTEND_DIST, 5);
        expect(Handle.pos.y.get(handles[1])).toBeCloseTo(0, 5);
    });

    test("reset lands a force section at its creation state (kind held, two seeded keyframes)", () => {
        const { state, sec } = forceTrack();
        sectionActs(state, sec).reset();
        expect(sectionForces(state, sec).length).toBe(2);
    });

    test("reset closes the summoned context menu", () => {
        const { state, sec } = geoTrack(2);
        openContext(0, 0, sec);
        sectionActs(state, sec).reset();
        expect(editor.context).toBeNull();
    });

    test("reset refuses while ANY pin session is open", () => {
        const { state, a, b } = twoForceSections();
        if (!enterPinMode(state, a)) throw new Error("no session");
        const idsBefore = sectionForces(state, b).map((r) => r.id);
        sectionActs(state, b).reset();
        expect(sectionForces(state, b).map((r) => r.id)).toEqual(idsBefore);
        exitPinMode(state);
    });

    test("pinExit closes the context menu and exits the mode", () => {
        const { state, a } = twoForceSections();
        if (!enterPinMode(state, a)) throw new Error("no session");
        openContext(0, 0, a);
        sectionActs(state, a).pinExit();
        expect(editor.context).toBeNull();
        expect(editor.pinning).toBeNull();
    });

    test("cutAt splits at the resolved position, landing one undo entry", () => {
        const { state, sec } = geoTrack(4);
        const before = sections(state).length;
        const undoBefore = history.undo.length;
        sectionActs(state, sec, { at: 2 }).cutAt();
        expect(sections(state).length).toBe(before + 1);
        expect(history.undo.length).toBe(undoBefore + 1);
    });

    test("cutAt no-ops with no resolved position (the default)", () => {
        const { state, sec } = geoTrack(4);
        const before = sections(state).length;
        sectionActs(state, sec).cutAt();
        expect(sections(state).length).toBe(before);
    });

    test("cutAt refuses while ANY pin session is open, even on a different section", () => {
        const { state, a, b } = twoForceSections();
        if (!enterPinMode(state, a)) throw new Error("no session");
        const before = sections(state).length;
        sectionActs(state, b, { at: 20 }).cutAt();
        expect(sections(state).length).toBe(before);
        exitPinMode(state);
    });

    test("join merges the selected contiguous run and selects the survivor", () => {
        const { state, a, b, c } = threeGeoSections();
        selectSection(a);
        selectSection(b, "toggle");
        sectionActs(state, a).join();
        expect(sections(state).map((s) => s.id)).toEqual([a, c]);
        expect(editor.sections.active).toBe(a);
    });

    test("join no-ops (records nothing) on a set that isn't a valid run — the menu grays it", () => {
        const { state, a, b, c } = threeGeoSections(); // b sits between: a, c is a gap
        selectSection(a);
        selectSection(c, "toggle");
        const undoBefore = history.undo.length;
        sectionActs(state, a).join();
        expect(sections(state).map((s) => s.id)).toEqual([a, b, c]);
        expect(history.undo.length).toBe(undoBefore);
    });

    test("join refuses while ANY pin session is open, even on a different section", () => {
        const { state, a, b } = twoForceSections();
        if (!enterPinMode(state, a)) throw new Error("no session");
        selectSection(a);
        selectSection(b, "toggle");
        const before = sections(state).length;
        sectionActs(state, a).join();
        expect(sections(state).length).toBe(before);
        exitPinMode(state);
    });
});

describe("nodeActs", () => {
    test("add extends the chain and selects the new node", () => {
        const { state, sec } = geoTrack(2);
        const tip = lastHandle(state, sec);
        if (tip === null) throw new Error("no tip");
        nodeActs(state, tip).add();
        const handles = sectionHandles(state, sec);
        expect(handles.length).toBe(3);
        expect(editor.nodes.active).toBe(handles[2]);
    });

    test("remove trims the chain end and selects the new tip", () => {
        const { state, sec } = geoTrack(3);
        const tip = lastHandle(state, sec);
        if (tip === null) throw new Error("no tip");
        nodeActs(state, tip).remove();
        const handles = sectionHandles(state, sec);
        expect(handles.length).toBe(2);
        expect(editor.nodes.active).toBe(handles[1]);
    });

    test("removeSet trims a valid suffix run", () => {
        const { state, sec } = geoTrack(4);
        const handles = sectionHandles(state, sec);
        selectNodes([handles[2], handles[3]], handles[3]);
        nodeActs(state, handles[2]).removeSet();
        expect(sectionHandles(state, sec).length).toBe(2);
    });

    test("removeSet refuses an interior (non-tip) selection — not a suffix run", () => {
        const { state, sec } = geoTrack(4);
        const handles = sectionHandles(state, sec);
        selectNodes([handles[1]], handles[1]);
        nodeActs(state, handles[1]).removeSet();
        expect(sectionHandles(state, sec).length).toBe(4);
    });

    test("toggleHandles enters and exits tangent-edit mode", () => {
        const { state, sec } = geoTrack(2);
        const tip = lastHandle(state, sec);
        if (tip === null) throw new Error("no tip");
        select(tip);
        nodeActs(state, tip).toggleHandles();
        expect(editor.tangentEdit).toBe(tip);
        nodeActs(state, tip).toggleHandles();
        expect(editor.tangentEdit).toBeNull();
    });

    test("pickMode is a no-op picking Aligned on an inferred (Auto) node", () => {
        const { state, sec } = geoTrack(2);
        const tip = lastHandle(state, sec);
        if (tip === null) throw new Error("no tip");
        const order = Handle.order.get(tip);
        const before = history.undo.length;
        nodeActs(state, tip).pickMode(TangentMode.Aligned);
        expect(history.undo.length).toBe(before);
        expect(handleTangent(state, sec, order)).toBeUndefined();
    });

    test("pickMode(Mirror) materializes an explicit tangent, one undo entry", () => {
        const { state, sec } = geoTrack(2);
        const tip = lastHandle(state, sec);
        if (tip === null) throw new Error("no tip");
        const order = Handle.order.get(tip);
        const before = history.undo.length;
        nodeActs(state, tip).pickMode(TangentMode.Mirror);
        expect(history.undo.length).toBe(before + 1);
        expect(handleTangent(state, sec, order)?.mode).toBe(TangentMode.Mirror);
    });

    test("pickModeSet applies the mode to every selected node", () => {
        const { state, sec } = geoTrack(3);
        const handles = sectionHandles(state, sec);
        selectNodes([handles[1], handles[2]], handles[2]);
        nodeActs(state, handles[1]).pickModeSet(TangentMode.Free);
        for (const h of [handles[1], handles[2]])
            expect(handleTangent(state, sec, Handle.order.get(h))?.mode).toBe(TangentMode.Free);
    });

    test("reset returns a node to creation state (position + Auto tangent)", () => {
        const { state, sec } = geoTrack(2);
        const tip = lastHandle(state, sec);
        if (tip === null) throw new Error("no tip");
        const order = Handle.order.get(tip);
        setTangent(state, sec, order, { mode: TangentMode.Free, inX: 1, inY: 1, outX: 1, outY: 1 });
        Handle.pos.set(tip, 500, 500);
        nodeActs(state, tip).reset();
        expect(Handle.pos.x.get(tip)).toBeCloseTo(EXTEND_DIST, 5);
        expect(Handle.pos.y.get(tip)).toBeCloseTo(0, 5);
        expect(handleTangent(state, sec, order)).toBeUndefined();
    });

    test("resetSet bulk-resets the selected set", () => {
        const { state, sec } = geoTrack(3);
        const handles = sectionHandles(state, sec);
        const tip = handles[2];
        const order = Handle.order.get(tip);
        setTangent(state, sec, order, { mode: TangentMode.Free, inX: 1, inY: 1, outX: 1, outY: 1 });
        Handle.pos.set(tip, 500, 500);
        selectNodes([tip], tip);
        nodeActs(state, tip).resetSet();
        expect(handleTangent(state, sec, order)).toBeUndefined();
        // tip is order 2; its predecessor (order 1) sits at `1 * EXTEND_DIST`, so the recreated
        // continuation lands one more chord past it.
        expect(Handle.pos.x.get(tip)).toBeCloseTo(2 * EXTEND_DIST, 5);
    });

    test("cut splits the section at the node's own order, landing one undo entry", () => {
        const { state, sec } = geoTrack(4); // orders 0..3; order 2 is interior
        const handles = sectionHandles(state, sec);
        const before = sections(state).length;
        const undoBefore = history.undo.length;
        nodeActs(state, handles[2]).cut();
        expect(sections(state).length).toBe(before + 1);
        expect(history.undo.length).toBe(undoBefore + 1);
        // a landmark cut is the no-subdivision reduction: the clicked node's own eid survives,
        // still the head section's new tip (`splitGeo`'s own shape — kept verbatim, not moved).
        expect(sectionHandles(state, sec).at(-1)).toBe(handles[2]);
    });

    test("cut no-ops at the chain end (non-interior — `splitGeo`'s own guard)", () => {
        const { state, sec } = geoTrack(3);
        const tip = lastHandle(state, sec);
        if (tip === null) throw new Error("no tip");
        const before = sections(state).length;
        nodeActs(state, tip).cut();
        expect(sections(state).length).toBe(before);
    });

    test("cut refuses while ANY pin session is open, even on an unrelated geo section", () => {
        const { state, force, geo } = forceAndGeoSections();
        if (!enterPinMode(state, force)) throw new Error("no session");
        const handles = sectionHandles(state, geo);
        const before = sections(state).length;
        nodeActs(state, handles[2]).cut();
        expect(sections(state).length).toBe(before);
        exitPinMode(state);
    });
});

describe("keyframeActs", () => {
    test("remove deletes the selected set and skips a live landing", () => {
        const { state, sec } = forceTrack();
        const ids = sectionForces(state, sec).map((r) => r.id);
        selectForces([ids[1]], ids[1]);
        beginLanding([{ id: ids[0], from: 1, to: 1.2 }], {
            section: sec,
            entry: { x: 0, y: 0, theta: 0, v: 20 },
        });
        expect(editor.landing).not.toBeNull();
        keyframeActs(state).remove();
        expect(editor.landing).toBeNull();
        expect(sectionForces(state, sec).map((r) => r.id)).toEqual([
            ids[0],
            ids[2],
            ids[3],
            ids[4],
        ]);
    });

    test("remove no-ops when nothing is selected, touching no landing in flight", () => {
        const { state, sec } = forceTrack();
        const ids = sectionForces(state, sec).map((r) => r.id);
        beginLanding([{ id: ids[0], from: 1, to: 1.2 }], {
            section: sec,
            entry: { x: 0, y: 0, theta: 0, v: 20 },
        });
        selectForce(null);
        keyframeActs(state).remove();
        expect(sectionForces(state, sec).length).toBe(5);
        // an empty selection must never reach `skipLanding()` — an unrelated in-flight landing
        // (a mouse-driven move settling) stays live.
        expect(editor.landing).not.toBeNull();
    });

    test("remove refuses a mixed-editability set under a live pin session (all-or-nothing)", () => {
        const { state, a, b } = twoForceSections();
        if (!enterPinMode(state, a)) throw new Error("no session");
        const idsA = sectionForces(state, a).map((r) => r.id);
        const idsB = sectionForces(state, b).map((r) => r.id);
        // idsA[0] IS on the pinning section (individually editable); idsB[0] is not — the set as
        // a whole must refuse rather than silently dropping the un-editable member.
        selectForces([idsA[0], idsB[0]], idsA[0]);
        const countA = idsA.length;
        const countB = idsB.length;
        keyframeActs(state).remove();
        expect(sectionForces(state, a).length).toBe(countA);
        expect(sectionForces(state, b).length).toBe(countB);
        exitPinMode(state);
    });

    // No "toggleLock refuses outside a session" test, deliberately: `lockCandidates`'s
    // `editor.pinning === null` early-out is TYPE NARROWING for the very next line, not defense —
    // deleting it doesn't yield a silent no-op to assert against, it fails to compile. There is no
    // legal mutant, so an assert here would pin nothing. The refusal is layered elsewhere and
    // tested there: `forceKeyAct` gates on `pinning && size > 0` (`tests/menu.test.ts`), and the
    // menu row is mode-scoped-hidden (`lockLabel`).
    test("toggleLock locks the selected set, filtered to the pinning section", () => {
        const { state, a, b } = twoForceSections();
        if (!enterPinMode(state, a)) throw new Error("no session");
        const idsA = sectionForces(state, a).map((r) => r.id);
        const idsB = sectionForces(state, b).map((r) => r.id);
        selectForces([idsA[0], idsA[1], idsB[0]], idsA[0]);
        keyframeActs(state).toggleLock();
        expect(editor.locked.has(idsA[0])).toBe(true);
        expect(editor.locked.has(idsA[1])).toBe(true);
        expect(editor.locked.has(idsB[0])).toBe(false); // off the pinning section — never a candidate
        // an UNSELECTED member of the pinning section itself — proves the toggle set is the
        // SELECTION intersected with the section, not the whole section.
        expect(editor.locked.has(idsA[2])).toBe(false);
        // every candidate WAS locked, so a second press unlocks (the toggle law).
        keyframeActs(state).toggleLock();
        expect(editor.locked.has(idsA[0])).toBe(false);
        expect(editor.locked.has(idsA[1])).toBe(false);
        exitPinMode(state);
    });

    test("cut splits the section at the active keyframe's own s, landing one undo entry", () => {
        const { state, sec } = forceTrack(); // keys at s = 0, 10, 20, 30, 40; length 40
        const ids = sectionForces(state, sec).map((r) => r.id);
        selectForce(ids[2]); // s = 20, interior
        const before = sections(state).length;
        const undoBefore = history.undo.length;
        keyframeActs(state).cut();
        expect(sections(state).length).toBe(before + 1);
        expect(history.undo.length).toBe(undoBefore + 1);
    });

    test("cut no-ops at the section exit (non-interior — `splitForce`'s own guard)", () => {
        const { state, sec } = forceTrack();
        const ids = sectionForces(state, sec).map((r) => r.id);
        selectForce(ids.at(-1) ?? null); // s = 40 === length, the exit
        const before = sections(state).length;
        keyframeActs(state).cut();
        expect(sections(state).length).toBe(before);
    });

    test("cut no-ops when nothing is selected", () => {
        const { state } = forceTrack();
        selectForce(null);
        const before = sections(state).length;
        keyframeActs(state).cut();
        expect(sections(state).length).toBe(before);
    });

    test("cut refuses while ANY pin session is open, even on an unrelated force section", () => {
        const { state, a, b } = twoForceSectionsInterior();
        if (!enterPinMode(state, a)) throw new Error("no session");
        const idsB = sectionForces(state, b).map((r) => r.id);
        selectForce(idsB[1]); // s = 20, interior — a genuine cut point, on the NON-pinning section
        const before = sections(state).length;
        keyframeActs(state).cut();
        expect(sections(state).length).toBe(before);
        exitPinMode(state);
    });
});
