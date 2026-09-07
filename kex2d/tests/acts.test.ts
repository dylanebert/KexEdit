import { afterEach, describe, expect, test } from "bun:test";
import type { State } from "@dylanebert/shallot";
import { forceSetEditable, keyframeActs, nodeActs, sectionActs } from "../src/acts";
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
    EXTEND_DIST,
    forceAt,
    Force,
    Handle,
    handleTangent,
    lastHandle,
    sectionForces,
    sectionHandles,
    sections,
    SectionKind,
    setTangent,
} from "../src/track";
import { build } from "./helpers/build";

// the third member of the menu triple's own coverage (kex2d-act-factory stage 2): drives each
// factory's acts against a real ECS track — history.test.ts/ops.test.ts's shape — testing the ACT
// layer (a record entry does the thing and carries its own guard), never re-testing the underlying
// ops (`removeSection`, `trimTrack`, …) those files already pin.
//
// the shared authoring builder: every fixture below is authored through the shared `Build` helper
// (`tests/helpers/build.ts`), the same `applyOp` dispatch the CLI and the UI share, rather
// than `track.ts`'s raw entity primitives — this file tests the ACT layer, which consumes an
// authored track, not the authoring layer itself.

/** a bare geo track: one section, `n` flat nodes at `i * EXTEND_DIST` along x. */
function geoTrack(n = 2): { state: State; sec: number } {
    const b = build();
    const sec = b.appendSection(SectionKind.Geo);
    // the default seed already places node 1 at `EXTEND_DIST` (`appendSection`'s own sticky
    // default), so `n = 2` needs no further authoring; `n > 2` extends the tip.
    for (let i = 2; i < n; i++) b.addNode(sec, i * EXTEND_DIST, 0);
    b.bake();
    return { state: b.ecs, sec };
}

/** two geo sections, chained. */
function twoGeoSections(): { state: State; a: number; b: number } {
    const bd = build();
    const a = bd.appendSection(SectionKind.Geo);
    const b = bd.appendSection(SectionKind.Geo);
    bd.bake();
    return { state: bd.ecs, a, b };
}

/** three geo sections, chained — the smallest chain where a bulk delete of TWO is not the
 *  last-section floor. */
function threeGeoSections(): { state: State; a: number; b: number; c: number } {
    const bd = build();
    const a = bd.appendSection(SectionKind.Geo);
    const b = bd.appendSection(SectionKind.Geo);
    const c = bd.appendSection(SectionKind.Geo);
    bd.bake();
    return { state: bd.ecs, a, b, c };
}

/** the five-keyframe force section shape (pin.test.ts's own), authored onto an in-flight
 *  `Build` — the repeated body every force fixture below opens with. `append-section`
 *  seeds a force section with its own two continuation keyframes (AGENTS.md's Model
 *  (force authoring)); `force-create` doesn't dedupe against them (unlike `force-move`'s
 *  `stationTaken` guard), so those two are cleared before authoring the five explicit
 *  ones or the section would carry seven. */
function fiveKeyframeForceSection(bd: ReturnType<typeof build>): number {
    const sec = bd.appendSection(SectionKind.Force);
    bd.deleteForces(sectionForces(bd.ecs, sec).map((r) => r.id));
    bd.sectionLength(sec, 40);
    bd.addForce(sec, 0, 1);
    bd.addForce(sec, 10, 1.5);
    bd.addForce(sec, 20, 1);
    bd.addForce(sec, 30, 0.8);
    bd.addForce(sec, 40, 1);
    bd.startSpeed(20);
    return sec;
}

/** a force section, seeded with five keyframes (pin.test.ts's shape). */
function forceTrack(): { state: State; sec: number } {
    const bd = build();
    const sec = fiveKeyframeForceSection(bd);
    bd.bake();
    return { state: bd.ecs, sec };
}

/** two force sections, chained — `b`'s two keyframes come from `appendSection`'s own
 *  continuation seed (kex2d/AGENTS.md's Model (force authoring)). */
function twoForceSections(): { state: State; a: number; b: number } {
    const bd = build();
    const a = fiveKeyframeForceSection(bd);
    const b = bd.appendSection(SectionKind.Force);
    bd.bake();
    return { state: bd.ecs, a, b };
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
});

describe("keyframeActs", () => {
    test("a pin session keeps force keys on every member of its run editable", () => {
        const { state, sec } = forceTrack();
        if (!enterPinMode(state, sec)) throw new Error("no session");
        const keys = sectionForces(state, sec);
        expect(
            new Set(keys.map((key) => Force.section.get(forceAt(state, key.id)!))).size,
        ).toBeGreaterThan(1);
        selectForces(
            keys.map((key) => key.id),
            keys.at(-1)!.id,
        );
        expect(forceSetEditable(state)).toBe(true);
        exitPinMode(state);
    });

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
});
