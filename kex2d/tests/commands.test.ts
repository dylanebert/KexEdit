import { describe, expect, test } from "bun:test";
import { State } from "@dylanebert/shallot";
import { applyOp, type OpResult } from "../src/commands";
import { loadDocument, parseDocument, saveDocument } from "../src/doc";
import {
    addStrip,
    addStripKeyframe,
    appendSection,
    beginForceMove,
    beginFriction,
    beginLength,
    beginMove,
    beginOneShotMove,
    beginResistance,
    beginStripKeyframeMove,
    beginStripMove,
    commit,
    convertSection,
    createForce,
    createHistory,
    deleteForces,
    deleteStripKeyframes,
    extendTrack,
    type History,
    landDomain,
    removeSection,
    setForcesEase,
    trimTrack,
} from "../src/history";
import { Easing } from "../src/profile";
import { Domain } from "../src/section";
import {
    addNode,
    createForcePoint,
    createOneShot,
    createSection,
    createStrip,
    createTrack,
    Handle,
    handleAt,
    lastHandle,
    reheadOnDrag,
    SectionKind,
    sectionForces,
    setForcePoint,
    setOneShotValue,
    setSectionLength,
    setStrip,
    setStripKeyframe,
    setTrackFriction,
    setTrackResistance,
    Strip,
    stripAt,
    StripKeyframe,
    stripKeyframeAt,
    trackEntity,
} from "../src/track";

// S2's own oracle (spec `kex2d-cli`, Approach S2): for each op family, the command-layer edit
// and the direct setter edit — the exact call sequence the UI itself performs, cited inline in
// `commands.ts`'s own docblocks — land byte-identical documents. No second write path.
//
// **Stable ids are per-process allocator artifacts** (`nextSectionId`/`nextForceId`/…,
// `track.ts`), never reset between fixtures in one `bun test` run (`tests/history.test.ts`'s own
// `norm` precedent for this exact class). Every fixture below is built by `loadDocument` from one
// frozen template text, which respawns every entity at its EXACT authored id (`restoreAll`'s
// `spawn*` path, no allocation) — so two independently loaded fixtures agree on every id the
// template itself carries. A CREATE op allocates a fresh id off the live (process-shared) counter,
// which the two branches below reach at different offsets purely from run order — not a
// discrepancy in what the command layer does — so those four op families compare with the
// allocator-artifact id fields normalized out (`normIds`), everything else compared byte-raw.

function buildTemplateText(): string {
    const state = new State();
    const eid = createTrack(state);
    setTrackFriction(eid, 0.02);
    setTrackResistance(eid, 2e-4);
    const geo = createSection(state, 0, SectionKind.Geo, 0);
    addNode(state, geo, 0, 0);
    addNode(state, geo, 20, 0);
    addNode(state, geo, 40, 5);
    const force = createSection(state, 1, SectionKind.Force, 30);
    createForcePoint(state, force, 0, 1.5);
    createForcePoint(state, force, 20, 2.5);
    createStrip(state, 40, 60, 12);
    createOneShot(state, 22);
    return saveDocument(state);
}

const TEMPLATE_TEXT = buildTemplateText();
const TEMPLATE = parseDocument(TEMPLATE_TEXT);

const GEO = TEMPLATE.sections.find((s) => s.kind === SectionKind.Geo)?.id;
const FORCE_SEC = TEMPLATE.sections.find((s) => s.kind === SectionKind.Force)?.id;
if (GEO === undefined || FORCE_SEC === undefined) throw new Error("template: missing a section");
const forceSecDoc = TEMPLATE.sections.find((s) => s.id === FORCE_SEC);
if (!forceSecDoc) throw new Error("template: force section vanished");
const FP0 = forceSecDoc.points.find((p) => p.s === 0)?.id;
const FP20 = forceSecDoc.points.find((p) => p.s === 20)?.id;
if (FP0 === undefined || FP20 === undefined) throw new Error("template: missing a force point");
const STRIP = TEMPLATE.strips[0]?.id;
if (STRIP === undefined) throw new Error("template: missing the strip");
const stripDoc = TEMPLATE.strips[0];
const KF40 = stripDoc.keyframes.find((k) => k.s === 40)?.id;
const KF60 = stripDoc.keyframes.find((k) => k.s === 60)?.id;
if (KF40 === undefined || KF60 === undefined) throw new Error("template: missing a strip keyframe");
const OS = TEMPLATE.oneShot[0]?.id;
if (OS === undefined) throw new Error("template: missing the one-shot");

function fixture(): State {
    const state = new State();
    loadDocument(state, TEMPLATE_TEXT);
    return state;
}

/** every allocator-generated `"id": N` field, normalized to a placeholder — the id-parity
 *  precedent above. Only reached for the four op families that create a fresh id. */
function normIds(text: string): string {
    return text.replace(/"id": -?\d+/g, '"id": #');
}

/** run `direct` (the hand-authored UI-shaped call sequence) against one fixture and
 *  `commands.applyOp` against another, then assert the two live documents agree — byte-raw by
 *  default, or with allocator ids normalized out when `createsId` is set. */
function expectSameDoc(
    op: Parameters<typeof applyOp>[2],
    direct: (state: State, h: History) => void,
    createsId = false,
): { result: OpResult; a: State; b: State } {
    const a = fixture();
    const ha = createHistory();
    direct(a, ha);

    const b = fixture();
    const hb = createHistory();
    const result = applyOp(b, hb, op);

    const docA = saveDocument(a);
    const docB = saveDocument(b);
    if (createsId) expect(normIds(docB)).toBe(normIds(docA));
    else expect(docB).toBe(docA);
    return { result, a, b };
}

describe("commands: differential arm — command layer vs. direct setter calls", () => {
    test("append-section", () => {
        const { result } = expectSameDoc(
            { type: "append-section", kind: SectionKind.Force },
            (state, h) => {
                appendSection(h, state, SectionKind.Force);
            },
            true,
        );
        expect(result.applied).toBe(true);
    });

    test("delete-section", () => {
        const { result } = expectSameDoc(
            { type: "delete-section", section: FORCE_SEC },
            (state, h) => {
                removeSection(h, state, FORCE_SEC);
            },
        );
        expect(result.applied).toBe(true);
    });

    test("convert-section", () => {
        const { result } = expectSameDoc(
            { type: "convert-section", section: FORCE_SEC },
            (state, h) => {
                convertSection(h, state, FORCE_SEC);
            },
        );
        expect(result.applied).toBe(true);
    });

    test("node-add", () => {
        const { result } = expectSameDoc({ type: "node-add", section: GEO }, (state, h) => {
            extendTrack(h, state, GEO);
        });
        expect(result.applied).toBe(true);
    });

    test("node-move (interior, no re-head)", () => {
        const { result } = expectSameDoc(
            { type: "node-move", section: GEO, order: 1, x: 21, y: 3 },
            (state, h) => {
                const eid = handleAt(state, GEO, 1);
                if (eid === null) throw new Error("fixture missing node");
                beginMove(state, GEO);
                Handle.pos.set(eid, 21, 3);
                if (eid === lastHandle(state, GEO)) reheadOnDrag(state, eid);
                commit(h);
            },
        );
        expect(result.applied).toBe(true);
    });

    test("node-move (tip, re-heads)", () => {
        const { result } = expectSameDoc(
            { type: "node-move", section: GEO, order: 2, x: 44, y: 9 },
            (state, h) => {
                const eid = handleAt(state, GEO, 2);
                if (eid === null) throw new Error("fixture missing node");
                beginMove(state, GEO);
                Handle.pos.set(eid, 44, 9);
                if (eid === lastHandle(state, GEO)) reheadOnDrag(state, eid);
                commit(h);
            },
        );
        expect(result.applied).toBe(true);
    });

    test("node-delete", () => {
        const { result } = expectSameDoc({ type: "node-delete", section: GEO }, (state, h) => {
            trimTrack(h, state, GEO);
        });
        expect(result.applied).toBe(true);
    });

    test("force-create", () => {
        const { result } = expectSameDoc(
            { type: "force-create", section: FORCE_SEC, s: 10, g: 3 },
            (state, h) => {
                createForce(h, state, FORCE_SEC, 10, 3);
            },
            true,
        );
        expect(result.applied).toBe(true);
    });

    test("force-move", () => {
        const { result } = expectSameDoc(
            { type: "force-move", id: FP0, s: 12, g: 4 },
            (state, h) => {
                beginForceMove(state, FP0);
                setForcePoint(state, FP0, 12, 4);
                commit(h);
            },
        );
        expect(result.applied).toBe(true);
    });

    test("force-delete", () => {
        const { result } = expectSameDoc({ type: "force-delete", ids: [FP20] }, (state, h) => {
            deleteForces(h, state, [FP20]);
        });
        expect(result.applied).toBe(true);
    });

    test("force-ease", () => {
        const { result } = expectSameDoc(
            { type: "force-ease", ids: [FP0], ease: Easing.Quintic },
            (state, h) => {
                setForcesEase(h, state, [FP0], Easing.Quintic);
            },
        );
        expect(result.applied).toBe(true);
    });

    test("strip-create", () => {
        const { result } = expectSameDoc(
            { type: "strip-create", start: 5, end: 15, value: 8 },
            (state, h) => {
                addStrip(h, state, 5, 15, 8);
            },
            true,
        );
        expect(result.applied).toBe(true);
    });

    test("strip-move", () => {
        const { result } = expectSameDoc(
            { type: "strip-move", id: STRIP, start: 40, end: 58, value: 14 },
            (state, h) => {
                beginStripMove(state, STRIP);
                setStrip(state, STRIP, 40, 58, 14);
                commit(h);
            },
        );
        expect(result.applied).toBe(true);
    });

    test("strip-keyframe-create", () => {
        const { result } = expectSameDoc(
            { type: "strip-keyframe-create", strip: STRIP, s: 50, v: 15 },
            (state, h) => {
                addStripKeyframe(h, state, STRIP, 50, 15);
            },
            true,
        );
        expect(result.applied).toBe(true);
    });

    test("strip-keyframe-move", () => {
        const { result } = expectSameDoc(
            { type: "strip-keyframe-move", id: KF40, s: 45, v: 13 },
            (state, h) => {
                beginStripKeyframeMove(state, KF40);
                setStripKeyframe(state, KF40, 45, 13);
                commit(h);
            },
        );
        expect(result.applied).toBe(true);
    });

    test("strip-keyframe-delete", () => {
        const { result } = expectSameDoc(
            { type: "strip-keyframe-delete", ids: [KF60] },
            (state, h) => {
                deleteStripKeyframes(h, state, [KF60]);
            },
        );
        expect(result.applied).toBe(true);
    });

    test("section-length", () => {
        const { result } = expectSameDoc(
            { type: "section-length", section: FORCE_SEC, length: 45 },
            (state, h) => {
                beginLength(state, FORCE_SEC);
                setSectionLength(state, FORCE_SEC, 45);
                commit(h);
            },
        );
        expect(result.applied).toBe(true);
    });

    test("start-speed (moves an existing one-shot)", () => {
        const { result } = expectSameDoc({ type: "start-speed", value: 18 }, (state, h) => {
            beginOneShotMove(state, OS);
            setOneShotValue(state, OS, 18);
            commit(h);
        });
        expect(result.applied).toBe(true);
    });

    test("friction", () => {
        const { result } = expectSameDoc({ type: "friction", value: 0.05 }, (state, h) => {
            const eid = trackEntity(state);
            if (eid === null) throw new Error("fixture missing track");
            beginFriction(eid);
            setTrackFriction(eid, 0.05);
            commit(h);
        });
        expect(result.applied).toBe(true);
    });

    test("resistance", () => {
        const { result } = expectSameDoc({ type: "resistance", value: 5e-4 }, (state, h) => {
            const eid = trackEntity(state);
            if (eid === null) throw new Error("fixture missing track");
            beginResistance(eid);
            setTrackResistance(eid, 5e-4);
            commit(h);
        });
        expect(result.applied).toBe(true);
    });

    test("domain", () => {
        const { result } = expectSameDoc({ type: "domain", value: Domain.Time }, (state, h) => {
            landDomain(h, state, Domain.Time);
        });
        expect(result.applied).toBe(true);
    });
});

describe("commands: refusals surface the violated guard structurally", () => {
    test("delete-section refuses at the last-section floor", () => {
        const state = new State();
        createTrack(state);
        const only = createSection(state, 0, SectionKind.Geo, 0);
        const h = createHistory();
        const before = saveDocument(state);
        const result = applyOp(state, h, { type: "delete-section", section: only });
        expect(result.applied).toBe(false);
        expect(result.refusals).toEqual([
            {
                guard: "lastSection",
                message: "refusing to delete the track's only remaining section",
            },
        ]);
        expect(saveDocument(state)).toBe(before);
    });

    test("delete-section refuses on an unknown section", () => {
        const state = fixture();
        const h = createHistory();
        const result = applyOp(state, h, { type: "delete-section", section: 999999 });
        expect(result.applied).toBe(false);
        expect(result.refusals[0]?.guard).toBe("sectionNotFound");
    });

    test("node-delete refuses below the two-node floor", () => {
        const state = new State();
        createTrack(state);
        const sec = createSection(state, 0, SectionKind.Geo, 0);
        addNode(state, sec, 0, 0);
        addNode(state, sec, 10, 0);
        const h = createHistory();
        const before = saveDocument(state);
        const result = applyOp(state, h, { type: "node-delete", section: sec });
        expect(result.applied).toBe(false);
        expect(result.refusals).toEqual([
            {
                guard: "minNodeFloor",
                message: "a geo section needs at least two nodes (node 0 + one shape node)",
            },
        ]);
        expect(saveDocument(state)).toBe(before);
    });

    test("node-move refuses to move node 0", () => {
        const state = fixture();
        const h = createHistory();
        const before = saveDocument(state);
        const result = applyOp(state, h, { type: "node-move", section: GEO, order: 0, x: 5, y: 5 });
        expect(result.applied).toBe(false);
        expect(result.refusals).toEqual([
            {
                guard: "nodeZeroLocked",
                message: "node 0 is pinned at the section's local origin and cannot move",
            },
        ]);
        expect(saveDocument(state)).toBe(before);
    });

    test("force-move refuses the station write when it collides, but still lands g", () => {
        const state = fixture();
        const h = createHistory();
        // FP20 already sits at s=20; drive FP0 (s=0) onto it.
        const result = applyOp(state, h, { type: "force-move", id: FP0, s: 20, g: 9 });
        expect(result.applied).toBe(true);
        expect(result.refusals).toEqual([
            {
                guard: "stationTaken",
                message:
                    "station 20 is already held by another force point on this section; g still lands",
            },
        ]);
        const rows = sectionForces(state, FORCE_SEC).filter((r) => r.id === FP0);
        expect(rows[0]?.s).toBe(0); // s refused
        expect(rows[0]?.g).toBe(9); // g still lands
    });

    test("strip-create refuses an overlapping span", () => {
        const state = fixture();
        const h = createHistory();
        const before = saveDocument(state);
        // the fixture's strip already covers [40, 60).
        const result = applyOp(state, h, { type: "strip-create", start: 45, end: 55, value: 10 });
        expect(result.applied).toBe(false);
        expect(result.refusals).toEqual([
            { guard: "stripOverlapped", message: "[45, 55) overlaps an existing velocity strip" },
        ]);
        expect(saveDocument(state)).toBe(before);
    });

    test("strip-create refuses a non-positive value", () => {
        const state = fixture();
        const h = createHistory();
        const result = applyOp(state, h, { type: "strip-create", start: 0, end: 10, value: 0 });
        expect(result.applied).toBe(false);
        expect(result.refusals).toEqual([
            {
                guard: "validStripValue",
                message: "strip value must be finite and strictly positive",
            },
        ]);
    });

    test("strip-move refuses value alone, still moves the span", () => {
        const state = fixture();
        const h = createHistory();
        const result = applyOp(state, h, {
            type: "strip-move",
            id: STRIP,
            start: 42,
            end: 62,
            value: -1,
        });
        expect(result.applied).toBe(true);
        expect(result.refusals).toEqual([
            {
                guard: "validStripValue",
                message: "strip value must be finite and strictly positive; value unchanged",
            },
        ]);
        const eid = stripAt(state, STRIP);
        expect(eid === null ? null : Strip.start.get(eid)).toBe(42);
    });

    test("strip-keyframe-move refuses a collision, still lands v", () => {
        const state = fixture();
        const h = createHistory();
        // KF40 (s=40) driven onto KF60's own station (s=60).
        const result = applyOp(state, h, { type: "strip-keyframe-move", id: KF40, s: 60, v: 30 });
        expect(result.applied).toBe(true);
        expect(result.refusals).toEqual([
            {
                guard: "stripKeyframeTaken",
                message:
                    "station 60 is already held by another keyframe on this strip; v still lands",
            },
        ]);
        const eid = stripKeyframeAt(state, KF40);
        expect(eid === null ? null : StripKeyframe.s.get(eid)).toBe(40); // s refused
        expect(eid === null ? null : StripKeyframe.v.get(eid)).toBe(30); // v still lands
    });

    test("force-ease refuses on a terminal keyframe", () => {
        const state = fixture();
        const h = createHistory();
        // FP20 is the section's last point — no following segment.
        const result = applyOp(state, h, { type: "force-ease", ids: [FP20], ease: Easing.Linear });
        expect(result.applied).toBe(true);
        expect(result.refusals).toEqual([
            {
                guard: "terminalKeyframe",
                message: `force point ${FP20} governs no following segment; its easing cannot be set`,
            },
        ]);
    });

    test("friction refuses a negative coefficient", () => {
        const state = fixture();
        const h = createHistory();
        const before = saveDocument(state);
        const result = applyOp(state, h, { type: "friction", value: -1 });
        expect(result.applied).toBe(false);
        expect(result.refusals).toEqual([
            {
                guard: "validCoefficient",
                message: "friction must be a finite, non-negative number",
            },
        ]);
        expect(saveDocument(state)).toBe(before);
    });

    test("resistance refuses a non-finite coefficient", () => {
        const state = fixture();
        const h = createHistory();
        const result = applyOp(state, h, { type: "resistance", value: Number.NaN });
        expect(result.applied).toBe(false);
        expect(result.refusals[0]?.guard).toBe("validCoefficient");
    });

    test("force-delete refuses when none of the ids exist", () => {
        const state = fixture();
        const h = createHistory();
        const result = applyOp(state, h, { type: "force-delete", ids: [999999] });
        expect(result.applied).toBe(false);
        expect(result.refusals[0]?.guard).toBe("notFound");
    });
});
