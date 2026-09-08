/** the command layer's own suite (spec `kex2d-segment-gestures` S2e-ii punch list items 3 and 4).
 *
 *  Two claims, both read off ONE template document so every op family is exercised against the
 *  same authored state:
 *
 *  1. **No second write path.** For each op family, `applyOp` and the `track.ts` setter the UI
 *     itself drives must leave byte-identical documents. An op that diverged from its setter
 *     would be a second authoring path, which is exactly what the Locked decision forbids.
 *  2. **Undo byte-identity.** For each gesture class, the saved text after one `undo` equals the
 *     pre-op text exactly. Anything an op writes outside `history.record` survives the undo and
 *     shows up as a diff here.
 *
 *  Every arm is red-proven by a mutation recorded beside it. Device-free: no GPU, no canvas. */

import { describe, expect, test } from "bun:test";
import { State } from "@dylanebert/shallot";
import { applyOp, type Op } from "../src/commands";
import { loadDocument, parseDocument, saveDocument, serializeDocument } from "../src/doc";
import { createHistory, type History, undo } from "../src/history";
import { Lane } from "../src/lanes";
import { Easing } from "../src/profile";
import { Domain } from "../src/section";
import {
    bakeOut,
    BakeSystem,
    createRecord,
    DEFAULT_FRICTION,
    DEFAULT_RESISTANCE,
    DS_NOMINAL,
    samples,
    Track,
    V0,
    deleteRecord,
    setEnd,
    setOrder,
    setRecordEase,
    setRecordHandle,
    setRecordSpan,
    setTrackDomain,
    setTrackFriction,
    setTrackResistance,
    setV0,
    trackEntity,
} from "../src/track";

/** the one template every arm loads: a geo run, an abutting force run, a velocity span inside
 *  the geo run, and non-default coefficients — so an op that silently rewrote a neighbouring
 *  column would show up in the compared text. Record ids are the wire's own, so an op can
 *  address them without a lookup. */
const TEMPLATE = serializeDocument(
    parseDocument(
        JSON.stringify({
            version: 4,
            track: { ds: 0.5, domain: 0, friction: 0.02, resistance: 2e-4, v0: 22 },
            lanes: {
                velocity: [{ id: 2, start: 10, end: 20, ease: 1, entry: 20, exit: 26 }],
                force: [{ id: 1, start: 40, end: 70, ease: 0, entry: 1.5, exit: 2.5 }],
                geo: [{ id: 0, start: 0, end: 40, ease: 0, entry: 0, exit: 0.24 }],
            },
        }),
    ),
);

const GEO = 0;
const FORCE = 1;
const VELOCITY = 2;

/** the saved text after one op, read while NOTHING ELSE is live. Two `State`s in one process
 *  alias module-scoped component storage (`kex2d/AGENTS.md`), so a differential that holds both
 *  documents open at once compares one document with itself and passes for free — each path here
 *  builds, writes and serializes before the other is created, and the control arm below is the
 *  non-vacuity witness. */
/** blank the id of a record the path just CREATED. `OpResult.id` names the record every op
 *  touched, not only a created one, so only a create is normalized — otherwise an edit's arm
 *  would blank the very id it is meant to be comparing. */
function normalizeNewId(text: string, id: number | undefined): string {
    return id === undefined ? text : text.replaceAll(`"id":${id},`, '"id":NEW,');
}

function viaOp(op: Op): string {
    const { ecs, h } = loaded();
    const result = applyOp(ecs, h, op);
    expect(result.refusals).toEqual([]);
    expect(result.applied).toBe(true);
    return normalizeNewId(saveDocument(ecs), op.type === "record-add" ? result.id : undefined);
}

function viaSetter(direct: (ecs: State) => number | void): string {
    const { ecs } = loaded();
    const id = direct(ecs);
    return normalizeNewId(saveDocument(ecs), id ?? undefined);
}

function loaded(): { ecs: State; h: History } {
    const ecs = new State();
    ecs.addSystem(BakeSystem);
    loadDocument(ecs, TEMPLATE);
    return { ecs, h: createHistory() };
}

/** the two paths one op family is read on: through `applyOp`, and through the setter the op is
 *  supposed to be driving. `undoable` is false only for a write the gesture layer deliberately
 *  does not record (there are none today — every op below lands one entry). */
interface Family {
    name: string;
    op: Op;
    /** the id a create allocates, so the monotone allocator's difference between the two paths
     *  is normalized out and everything else still compares byte-raw. */
    direct: (ecs: State) => number | void;
}

const FAMILIES: Family[] = [
    {
        name: "record-add",
        op: {
            type: "record-add",
            lane: "force",
            start: 70,
            end: 90,
            ease: Easing.Quintic,
            entry: 2.5,
            exit: 1,
        },
        direct: (ecs) =>
            createRecord(ecs, Lane.Force, {
                start: 70,
                end: 90,
                ease: Easing.Quintic,
                entry: 2.5,
                exit: 1,
            }).id ?? undefined,
    },
    {
        name: "record-delete",
        op: { type: "record-delete", id: VELOCITY },
        direct: (ecs) => void deleteRecord(ecs, VELOCITY),
    },
    {
        name: "record-span",
        op: { type: "record-span", id: FORCE, start: 40, end: 64 },
        direct: (ecs) => void setRecordSpan(ecs, FORCE, 40, 64),
    },
    {
        name: "record-handle (exit)",
        op: { type: "record-handle", id: GEO, which: "exit", value: -0.1 },
        direct: (ecs) => void setRecordHandle(ecs, GEO, "exit", -0.1),
    },
    {
        name: "record-handle (disown entry)",
        op: { type: "record-handle", id: FORCE, which: "entry" },
        direct: (ecs) => void setRecordHandle(ecs, FORCE, "entry", undefined),
    },
    {
        name: "record-ease",
        op: { type: "record-ease", id: VELOCITY, ease: Easing.Quintic },
        direct: (ecs) => void setRecordEase(ecs, VELOCITY, Easing.Quintic),
    },
    {
        name: "end",
        op: { type: "end", value: 90 },
        direct: (ecs) => void setEnd(ecs, 90),
    },
    {
        name: "order",
        op: { type: "order", value: ["force", "geo", "velocity"] },
        direct: (ecs) => void setOrder(ecs, [Lane.Force, Lane.Geo, Lane.Velocity]),
    },
    {
        name: "start-speed",
        op: { type: "start-speed", value: 14 },
        direct: (ecs) => void setV0(ecs, 14),
    },
    {
        name: "friction",
        op: { type: "friction", value: 0.05 },
        direct: (ecs) => void setTrackFriction(trackEntity(ecs)!, 0.05),
    },
    {
        name: "resistance",
        op: { type: "resistance", value: 1e-3 },
        direct: (ecs) => void setTrackResistance(trackEntity(ecs)!, 1e-3),
    },
    {
        name: "domain",
        op: { type: "domain", value: Domain.Time },
        direct: (ecs) => void setTrackDomain(ecs, Domain.Time),
    },
];

describe("the command-versus-setter differential, one template text", () => {
    // RED: point any op at a different column (e.g. dispatch `record-span` through
    // `setRecordHandle`) → the two saved documents diverge and that family's arm fails.
    for (const { name, op, direct } of FAMILIES) {
        test(`${name}: applyOp == the setter it drives, byte-identical`, () => {
            expect(viaOp(op)).toBe(viaSetter(direct));
        });
    }

    test("the template itself is the fixed point every arm starts from", () => {
        const { ecs } = loaded();
        expect(saveDocument(ecs)).toBe(TEMPLATE);
    });

    // the non-vacuity control: the comparison above must be able to SEE a divergence. Driving
    // `record-span`'s op against the wrong setter has to read as a difference, or every arm in
    // this block is passing on aliased storage rather than on agreement.
    test("the differential separates a mismatched setter", () => {
        const spanOp: Op = { type: "record-span", id: FORCE, start: 40, end: 64 };
        expect(viaOp(spanOp)).not.toBe(
            viaSetter((ecs) => void setRecordHandle(ecs, FORCE, "exit", 64)),
        );
    });
});

describe("undo byte-identity, one entry per gesture class", () => {
    // RED: have any op write through its setter WITHOUT the gesture bracket (drop `beginBody` and
    // `commit` from `record-span`, or the `record(...)` call from `addRecord`) → nothing is
    // recorded, the undo pops the wrong entry or none at all, and the saved text differs from the
    // template.
    for (const { name, op } of FAMILIES) {
        test(`${name}: the saved text after undo equals the pre-op text`, () => {
            const { ecs, h } = loaded();
            const before = saveDocument(ecs);
            expect(applyOp(ecs, h, op).refusals).toEqual([]);
            expect(saveDocument(ecs)).not.toBe(before); // the op actually changed the document
            expect(h.undo).toHaveLength(1); // exactly one entry, never two
            undo(h, ecs);
            expect(saveDocument(ecs)).toBe(before);
        });
    }

    test("a whole session of every gesture class undoes back to the template, in order", () => {
        const { ecs, h } = loaded();
        // the delete goes last: it retires the record the ease op addresses, and a session is
        // ordered by what the person did, not by this array's order.
        const session = [
            ...FAMILIES.filter((f) => f.op.type !== "record-delete"),
            ...FAMILIES.filter((f) => f.op.type === "record-delete"),
        ];
        for (const { op } of session) expect(applyOp(ecs, h, op).refusals).toEqual([]);
        expect(h.undo).toHaveLength(session.length);
        for (let i = 0; i < session.length; i++) undo(h, ecs);
        expect(saveDocument(ecs)).toBe(TEMPLATE);
    });
});

describe("op-shape refusals — what no setter ever sees", () => {
    const BadOps: { name: string; op: unknown; guard: string }[] = [
        {
            name: "an unknown lane name",
            op: { type: "record-add", lane: "roll", start: 0, end: 1, exit: 1 },
            guard: "opFieldInvalid",
        },
        { name: "a missing span", op: { type: "record-span", id: 0 }, guard: "opFieldInvalid" },
        { name: "a non-numeric end", op: { type: "end", value: "60" }, guard: "opFieldInvalid" },
        {
            name: "an order that is not lane names",
            op: { type: "order", value: [0, 1, 2] },
            guard: "opFieldInvalid",
        },
        {
            name: "a handle side that is neither",
            op: { type: "record-handle", id: 0, which: "middle" },
            guard: "opFieldInvalid",
        },
        {
            name: "a missing record",
            op: { type: "record-delete", id: 404 },
            guard: "recordNotFound",
        },
    ];

    // RED: drop the `finite`/`laneOf` guards → a NaN reaches the setter, which writes it (the
    // setters guard values, not op SHAPE), and the refusal these arms name never fires.
    for (const { name, op, guard } of BadOps) {
        test(`${name} is refused, nothing is written and nothing is recorded`, () => {
            const { ecs, h } = loaded();
            const before = saveDocument(ecs);
            const result = applyOp(ecs, h, op as Op);
            expect(result.applied).toBe(false);
            expect(result.refusals.map((r) => r.guard)).toEqual([guard]);
            expect(h.undo).toEqual([]);
            expect(saveDocument(ecs)).toBe(before);
        });
    }

    test("a setter refusal reaches the caller as the setter's own guard", () => {
        const { ecs, h } = loaded();
        const overlap = applyOp(ecs, h, {
            type: "record-add",
            lane: "force",
            start: 50,
            end: 60,
            exit: 1,
        });
        expect(overlap.refusals.map((r) => r.guard)).toEqual(["segmentOverlapped"]);
        expect(h.undo).toEqual([]);
    });
});

describe("Validation 3's live arms, as ops through applyOp", () => {
    /** the check-in transcript's own document: `cli new`'s one flat 24 m pitch record, with the
     *  ops Validation 3 (b) names applied to it. Written inline rather than shelled through the
     *  CLI so the arm is device-free and reads the bake directly; the seed is `cli new`'s
     *  output byte for byte. */
    const seed = JSON.stringify({
        version: 4,
        track: {
            ds: DS_NOMINAL,
            domain: 0,
            friction: DEFAULT_FRICTION,
            resistance: DEFAULT_RESISTANCE,
            v0: V0,
        },
        lanes: {
            velocity: [],
            force: [],
            geo: [{ id: 0, start: 0, end: 24, ease: 0, entry: 0, exit: 0 }],
        },
    });
    const setup: Op[] = [
        {
            type: "record-add",
            lane: "force",
            start: 14,
            end: 54,
            ease: Easing.Linear,
            entry: 1,
            exit: 2.5,
        },
        {
            type: "record-add",
            lane: "velocity",
            start: 4,
            end: 14,
            ease: Easing.Cubic,
            entry: 18,
            exit: 24,
        },
        { type: "record-handle", id: GEO, which: "exit", value: 0.35 },
        { type: "start-speed", value: 16 },
    ];

    interface Bake {
        count: number;
        x: number[];
        y: number[];
        theta: number[];
        fN: number[];
        v: number[];
        t: number[];
        tTotal: number;
    }

    /** every published number of the live bake, copied out — the fields Validation 3's `bytes`
     *  metric reads, off the same arrays `cli dump` publishes. */
    function readBake(ecs: State): Bake {
        ecs.step(0);
        const eid = trackEntity(ecs);
        if (eid === null) throw new Error("no track");
        const out = bakeOut.get(eid);
        const samp = samples.get(eid);
        if (!out || !samp) throw new Error("no bake");
        const n = Track.count.get(eid);
        const take = (a: ArrayLike<number>, k: number) => Array.from(a).slice(0, k);
        return {
            count: n,
            x: take(samp.posX, n),
            y: take(samp.posY, n),
            theta: take(samp.theta, n),
            fN: take(out.fN, n - 1),
            v: take(out.v, n),
            t: take(out.t, n),
            tTotal: out.tTotal,
        };
    }

    /** ONE `State` for the whole arm: two live `State`s in one process alias module-scoped
     *  component storage (`kex2d/AGENTS.md`), so the before/after pair is read as two snapshots
     *  of one document, never as two documents. */
    function transcript(): { before: Bake; after: Bake } {
        const ecs = new State();
        ecs.addSystem(BakeSystem);
        loadDocument(ecs, seed);
        const h = createHistory();
        for (const op of setup) {
            const r = applyOp(ecs, h, op);
            expect(r.refusals).toEqual([]);
            expect(r.applied).toBe(true);
        }
        const before = readBake(ecs);
        const swap = applyOp(ecs, h, { type: "order", value: ["force", "geo", "velocity"] });
        expect(swap.refusals).toEqual([]);
        return { before, after: readBake(ecs) };
    }

    // RED: read the PREVIOUS edge's chord (`chordAt(47)`) instead → 0.0109 rad against the same
    // 0.0073 rad bound, and the arm fails (exit 1). This is Validation 3 (b)'s own foil.
    test("a pitch edit's recovered heading lands on its authored exit within one edge's turning", () => {
        const { before } = transcript();
        expect(before.count).toBe(109);
        // the pitch record [0, 24) ends at sample 48 on the ds-0.5 ruler.
        const chordAt = (i: number) =>
            Math.atan2(before.y[i]! - before.y[i - 1]!, before.x[i]! - before.x[i - 1]!);
        const turning = Math.abs(before.theta[48]! - before.theta[47]!);
        expect(Math.abs(chordAt(48) - 0.35)).toBeLessThanOrEqual(turning);
        // non-vacuity: the bound is one edge's turning, not a free pass.
        expect(Math.abs(chordAt(47) - 0.35)).toBeGreaterThan(turning);
    });

    // RED: extend the compared prefix past the cut (29 samples / 28 edges) → `fN[27]` is still
    // equal but `fN[28]` reads 1.83 g before against 1.01 g after, and the arm fails (exit 1).
    test("an order swap changes only the overlap", () => {
        const { before, after } = transcript();
        // the swap hands force the [14, 24) overlap; everything before station 14 — 28 samples
        // and 27 edges on the ds-0.5 ruler — is published unchanged.
        for (const f of ["x", "y", "theta", "v", "t"] as const)
            expect(before[f].slice(0, 28)).toEqual(after[f].slice(0, 28));
        expect(before.fN.slice(0, 27)).toEqual(after.fN.slice(0, 27));
        // at the cut station itself the clipped record is re-parametrized over [0, 14) by the
        // profile sampler: f32 publication noise, not a level.
        expect(Math.abs(before.theta[28]! - after.theta[28]!)).toBeLessThan(1e-6);
        expect(Math.abs(before.fN[27]! - after.fN[27]!)).toBeLessThan(1e-4);
        // and past the cut, force owning the overlap is the reading itself.
        expect(before.fN[28]!).toBeCloseTo(1.83, 2);
        expect(after.fN[28]!).toBeCloseTo(1.01, 2);
        expect(after.count).toBe(before.count);
        expect(before.tTotal).toBeCloseTo(2.854, 3);
        expect(after.tTotal).toBeCloseTo(2.7049, 4);
    });
});
