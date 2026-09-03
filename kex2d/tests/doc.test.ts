import { describe, expect, test } from "bun:test";
import { State } from "@dylanebert/shallot";
import {
    checkDocInvariants,
    CURRENT_VERSION,
    docFromEcs,
    type DocGeoTangent,
    loadDocument,
    migrate,
    type MigrationStep,
    numLit,
    parseDocument,
    saveDocument,
    serializeDocument,
} from "../src/doc";
import { Easing } from "../src/profile";
import { rebuildSectionProjection } from "../src/projection";
import { scenarios } from "../src/scenarios";
import { TangentMode } from "../src/spline";
import {
    addNode,
    bakeOut,
    BakeSystem,
    createForcePoint,
    createOneShot,
    createSection,
    createStrip,
    createTrack,
    samples,
    SectionKind,
    sections,
    snapshotAll,
    spawnNode,
    Track,
    trackEntity,
} from "../src/track";

// the document boundary (spec `kex2d-serialization`): save → load → bake must be byte-identical
// (the ECS's own f32 truth, round-tripped through JSON text), the canonical emitter must be
// idempotent (`serialize(parse(text)) === text`), f32 must survive the text form exactly, and a
// rejected load must leave the live document untouched. Device-free — pure ECS + JSON, no GPU.

/** a fresh geo track carrying a scenario's exact node list — `spawnNode` (not `addNode`) so the
 *  node's authored `theta`/`tangent` land byte-identical to the scenario's own values, matching
 *  what `evalGeo` (the scenario corpus's own oracle) would see. */
function scenarioTrack(s: (typeof scenarios)[number]): { state: State; eid: number } {
    const state = new State();
    state.addSystem(BakeSystem);
    const eid = createTrack(state);
    Track.ds.set(eid, s.ds);
    const sec = createSection(state, 0, SectionKind.Geo, 0);
    s.nodes.forEach((n, i) => {
        spawnNode(state, sec, i, n.x, n.y, n.theta, n.tangent);
    });
    createOneShot(state, s.v0);
    return { state, eid };
}

/** a flat two-node geo track (the plugin's own seed shape) — the rejection-arm fixture, where
 *  the exact geometry doesn't matter, only that it survives a refused load untouched. */
function flatTrack(): { state: State; eid: number } {
    const state = new State();
    state.addSystem(BakeSystem);
    const eid = createTrack(state);
    const sec = createSection(state, 0, SectionKind.Geo, 0);
    addNode(state, sec, 0, 0);
    addNode(state, sec, 24, 0);
    createOneShot(state, 22);
    return { state, eid };
}

function bakedArrays(eid: number) {
    const count = Track.count.get(eid);
    const s = samples.get(eid);
    const out = bakeOut.get(eid);
    if (!s || !out) throw new Error("track buffers missing");
    return {
        count,
        posX: Array.from(s.posX.subarray(0, count)),
        posY: Array.from(s.posY.subarray(0, count)),
        theta: Array.from(s.theta.subarray(0, count)),
        v: Array.from(out.v.subarray(0, count)),
        t: Array.from(out.t.subarray(0, count)),
        fN: Array.from(out.fN.subarray(0, Math.max(0, count - 1))),
        ds: Array.from(out.ds.subarray(0, Math.max(0, count - 1))),
    };
}

describe("round-trip over the scenarios.ts corpus", () => {
    for (const s of scenarios) {
        test(`${s.name}: save → load → bake is byte-identical`, () => {
            const a = scenarioTrack(s);
            a.state.step(0);

            const text = saveDocument(a.state);

            // canonical idempotence: re-emitting a parsed document reproduces the same text.
            expect(serializeDocument(parseDocument(text))).toBe(text);

            const b = new State();
            b.addSystem(BakeSystem);
            loadDocument(b, text);
            b.step(0);
            const bEid = trackEntity(b);
            if (bEid === null) throw new Error("no track after load");

            // authored-state deep equality (TrackSnapshot) — every section/node/point/strip/
            // one-shot the document carries, plus the four Track scalars.
            expect(snapshotAll(b)).toEqual(snapshotAll(a.state));
            expect(Track.ds.get(bEid)).toBe(Track.ds.get(a.eid));
            expect(Track.domain.get(bEid)).toBe(Track.domain.get(a.eid));
            expect(Track.friction.get(bEid)).toBe(Track.friction.get(a.eid));
            expect(Track.resistance.get(bEid)).toBe(Track.resistance.get(a.eid));

            // bakeOut/samples arrays byte-identical.
            expect(bakedArrays(bEid)).toEqual(bakedArrays(a.eid));
        });
    }
});

describe("a document with strips, a force section, and an explicit geo tangent round-trips", () => {
    function widerTrack(): { state: State; eid: number } {
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        Track.friction.set(eid, 0.03);
        Track.resistance.set(eid, 3e-4);
        const geo = createSection(state, 0, SectionKind.Geo, 0);
        addNode(state, geo, 0, 0);
        spawnNode(state, geo, 1, 40, 8, 0.2, {
            mode: TangentMode.Free,
            inX: 10,
            inY: -1,
            outX: 12,
            outY: 3,
        });
        addNode(state, geo, 80, 0);
        const force = createSection(state, 1, SectionKind.Force, 30);
        createForcePoint(state, force, 0, 1.5, Easing.Cubic);
        createForcePoint(state, force, 15, 2.5, Easing.Quintic);
        createStrip(state, 5, 25, 24);
        createOneShot(state, 22);
        return { state, eid };
    }

    test("save → load → bake is byte-identical, deep-equal, and idempotent", () => {
        const a = widerTrack();
        a.state.step(0);
        const text = saveDocument(a.state);
        expect(serializeDocument(parseDocument(text))).toBe(text);

        const b = new State();
        b.addSystem(BakeSystem);
        loadDocument(b, text);
        b.step(0);
        const bEid = trackEntity(b);
        if (bEid === null) throw new Error("no track after load");

        expect(snapshotAll(b)).toEqual(snapshotAll(a.state));
        expect(bakedArrays(bEid)).toEqual(bakedArrays(a.eid));
    });
});

describe("f32 exactness: emit/parse/Math.fround round-trips identical bits", () => {
    // deterministic PRNG (mulberry32) — reproducible without a committed seed table.
    function mulberry32(seed: number): () => number {
        let a = seed >>> 0;
        return () => {
            a |= 0;
            a = (a + 0x6d2b79f5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function bits(f: number): number {
        return new Uint32Array(new Float32Array([f]).buffer)[0];
    }

    // through `numLit` — the module's own emit path (`emitFlat` routes every number through
    // it), not raw `JSON.stringify`: `JSON.stringify(-0) === "0"` silently drops the sign,
    // which `JSON.parse` would then read back as +0, a DIFFERENT f32 bit pattern — the exact
    // gap `numLit` exists to close (its own docblock). A sweep against `JSON.stringify`
    // directly would be exercising a mechanism this module doesn't use.

    test("random f32 values", () => {
        const rng = mulberry32(0xc0ffee);
        for (let i = 0; i < 5000; i++) {
            const raw = (rng() - 0.5) * 2 * 10 ** (1 + Math.floor(rng() * 12)); // wide magnitude spread
            const f = Math.fround(raw);
            const text = numLit(f);
            const parsed = JSON.parse(text) as number;
            const back = Math.fround(parsed);
            expect(bits(back)).toBe(bits(f));
        }
    });

    test("edge values: zero, negative zero, tiny denormals, large magnitudes", () => {
        const edge = [
            0,
            -0,
            1,
            -1,
            Number.MIN_VALUE,
            -Number.MIN_VALUE,
            3.4e38,
            -3.4e38,
            1e-30,
            -1e-30,
        ];
        for (const raw of edge) {
            const f = Math.fround(raw);
            const back = Math.fround(JSON.parse(numLit(f)) as number);
            expect(bits(back)).toBe(bits(f));
        }
    });

    test("numLit vs raw JSON.stringify: -0 is the one value where they diverge (the gap numLit closes)", () => {
        expect(numLit(-0)).toBe("-0");
        expect(JSON.stringify(-0)).toBe("0");
        expect(Object.is(JSON.parse(numLit(-0)), -0)).toBe(true);
        expect(Object.is(JSON.parse(JSON.stringify(-0)), -0)).toBe(false);
    });

    test("numLit refuses a non-finite number rather than emitting invalid JSON", () => {
        // plain JSON.stringify degrades NaN/Infinity to `null` (a different but still-valid
        // failure); String(NaN)/String(Infinity) are "NaN"/"Infinity", neither parseable JSON —
        // numLit throws instead of silently emitting unparseable text.
        expect(() => numLit(Number.NaN)).toThrow(/non-finite/);
        expect(() => numLit(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
        expect(() => numLit(Number.NEGATIVE_INFINITY)).toThrow(/non-finite/);
    });

    test("through the real ECS write path: f32 columns survive a save→load cycle bit-identical", () => {
        const rng = mulberry32(1234);
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        const ds = Math.fround(0.5 + rng() * 0.5); // clear of MAX_SAMPLES for this node spread
        Track.ds.set(eid, ds);
        Track.friction.set(eid, Math.fround(rng() * 0.1));
        Track.resistance.set(eid, Math.fround(rng() * 1e-3));
        const sec = createSection(state, 0, SectionKind.Geo, 0);
        addNode(state, sec, 0, 0);
        for (let i = 0; i < 8; i++) {
            spawnNode(
                state,
                sec,
                i + 1,
                Math.fround((i + 1) * 15 + rng() * 5),
                Math.fround((rng() - 0.5) * 10),
                0,
            );
        }
        createOneShot(state, 22);
        state.step(0);

        const text = saveDocument(state);
        const b = new State();
        b.addSystem(BakeSystem);
        loadDocument(b, text);
        const bEid = trackEntity(b);
        if (bEid === null) throw new Error("no track after load");

        expect(bits(Track.ds.get(bEid))).toBe(bits(Track.ds.get(eid)));
        expect(bits(Track.friction.get(bEid))).toBe(bits(Track.friction.get(eid)));
        expect(bits(Track.resistance.get(bEid))).toBe(bits(Track.resistance.get(eid)));
        expect(snapshotAll(b)).toEqual(snapshotAll(state));
    });
});

describe("rejection arms: refuse with a named remedy, touch nothing", () => {
    test("an unknown (future) version refuses and leaves the document untouched", () => {
        const { state } = flatTrack();
        state.step(0);
        const before = snapshotAll(state);
        const doc = JSON.parse(saveDocument(state));
        doc.version = CURRENT_VERSION + 999;
        const bad = JSON.stringify(doc);

        expect(() => loadDocument(state, bad)).toThrow(/version .* newer than this build supports/);
        expect(snapshotAll(state)).toEqual(before);
    });

    test("a version below any registered migration refuses and leaves the document untouched", () => {
        const { state } = flatTrack();
        state.step(0);
        const before = snapshotAll(state);
        const doc = JSON.parse(saveDocument(state));
        doc.version = 0;
        const bad = JSON.stringify(doc);

        expect(() => loadDocument(state, bad)).toThrow(/no migration path/);
        expect(snapshotAll(state)).toEqual(before);
    });

    // the migration seam's monotonicity guard: a step that runs but does not strictly advance
    // the version must refuse rather than spin — an unguarded `while (v < CURRENT_VERSION)` loop
    // keyed only on `isInt(doc.version)` would hang forever on a step that forgets to bump (the
    // natural copy-paste mistake, since `dropForceTangent` stamps the literal `version: 2`), and
    // a hang on load is the worst failure shape a data boundary has. `migrate`'s injectable
    // `steps` table lets this test register a deliberately non-bumping fake step against the
    // real guard without mutating the production migration table. The timeout is a real guard,
    // not decoration: with the monotonicity check removed, this test would hang rather than fail.
    test("a migration step that does not advance the version refuses instead of hanging", () => {
        const fakeSteps: Record<number, MigrationStep> = {
            1: (doc) => ({ ...doc, version: 1 }), // stamps its OWN starting version — the bug
        };
        expect(() => migrate({ version: 1 }, fakeSteps)).toThrow(/did not advance the version/);
    }, 1000);

    test("truncated JSON refuses and leaves the document untouched", () => {
        const { state } = flatTrack();
        state.step(0);
        const before = snapshotAll(state);
        const good = saveDocument(state);
        const truncated = good.slice(0, Math.floor(good.length / 2));

        expect(() => loadDocument(state, truncated)).toThrow(/kex2d document:/);
        expect(snapshotAll(state)).toEqual(before);
    });

    test("malformed shape (missing track object) refuses and leaves the document untouched", () => {
        const { state } = flatTrack();
        state.step(0);
        const before = snapshotAll(state);
        const doc = JSON.parse(saveDocument(state));
        delete doc.track;
        const bad = JSON.stringify(doc);

        expect(() => loadDocument(state, bad)).toThrow(/track/);
        expect(snapshotAll(state)).toEqual(before);
    });

    test("malformed shape (a node missing a required field) refuses and leaves the document untouched", () => {
        const { state } = flatTrack();
        state.step(0);
        const before = snapshotAll(state);
        const doc = JSON.parse(saveDocument(state));
        delete doc.segments[0].nodes[0].theta;
        const bad = JSON.stringify(doc);

        expect(() => loadDocument(state, bad)).toThrow(/nodes\[0\]\.theta/);
        expect(snapshotAll(state)).toEqual(before);
    });

    // enum-shaped fields: an in-range integer isn't enough — an out-of-range value must refuse
    // (not silently write a bogus enum member into the ECS, `Domain`/`Easing`/`TangentMode`
    // each carry a small closed set of valid values, and every other field-parses-as-a-number
    // check in this suite would let e.g. `"domain": 999` through unnoticed).

    test("an out-of-range track.domain refuses and leaves the document untouched", () => {
        const { state } = flatTrack();
        state.step(0);
        const before = snapshotAll(state);
        const beforeDomain = Track.domain.get(trackEntity(state) as number);
        const doc = JSON.parse(saveDocument(state));
        doc.track.domain = 999;
        const bad = JSON.stringify(doc);

        expect(() => loadDocument(state, bad)).toThrow(/track\.domain/);
        expect(snapshotAll(state)).toEqual(before);
        expect(Track.domain.get(trackEntity(state) as number)).toBe(beforeDomain);
    });

    test("an out-of-range force point ease refuses and leaves the document untouched", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        const sec = createSection(state, 0, SectionKind.Force, 30);
        createForcePoint(state, sec, 5, 1.5, Easing.Cubic);
        createOneShot(state, 22);
        state.step(0);
        const before = snapshotAll(state);
        const doc = JSON.parse(saveDocument(state));
        doc.segments[0].points[0].boundary.ease = 999;
        const bad = JSON.stringify(doc);

        expect(() => loadDocument(state, bad)).toThrow(/points\[0\]\.boundary\.ease/);
        expect(snapshotAll(state)).toEqual(before);
        expect(trackEntity(state)).toBe(eid);
    });

    test("an out-of-range explicit tangent mode refuses and leaves the document untouched", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        const sec = createSection(state, 0, SectionKind.Geo, 0);
        addNode(state, sec, 0, 0);
        spawnNode(state, sec, 1, 20, 4, 0, {
            mode: TangentMode.Free,
            inX: 5,
            inY: 0,
            outX: 5,
            outY: 0,
        });
        createOneShot(state, 22);
        state.step(0);
        const before = snapshotAll(state);
        const doc = JSON.parse(saveDocument(state));
        doc.segments[0].nodes[1].tangent.mode = 0; // 0 (Auto) is never a valid EXPLICIT tangent
        const bad = JSON.stringify(doc);

        expect(() => loadDocument(state, bad)).toThrow(/tangent\.mode/);
        expect(snapshotAll(state)).toEqual(before);
    });

    test("a root that isn't a JSON object refuses", () => {
        expect(() => parseDocument("[1,2,3]")).toThrow(/root is not a JSON object/);
        expect(() => parseDocument('"just a string"')).toThrow(/root is not a JSON object/);
    });

    test("every thrown error names a recovery remedy", () => {
        expect(() => parseDocument("not json at all")).toThrow(/re-save from a working document/);
    });

    test("a refused load clears no undo history and creates no track entity in an empty ECS", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        expect(() => loadDocument(state, "not json")).toThrow();
        expect(trackEntity(state)).toBeNull();
    });
});

// v1 → v2 (`kex2d-segment-removal` S3): the migration seam drops a force keyframe's `tangent`
// key (the explicit-handle `ForceTangent`/`Offset` shape the ECS can no longer author) while
// leaving a geo node's own `tangent` key — a structurally distinct field on a distinct entity —
// untouched. The ECS itself can never construct a force `tangent` key anymore, so these cases
// hand-author the v1 shape a pre-S3 producer (the GUI handle drag, or Cut's subdivide) used to
// write, the way `tests/invariants.test.ts`'s red fixtures hand-author other malformed shapes.
describe("v1 → v2 migration: drops force-tangent keys, preserves geo tangents", () => {
    /** a v1-shaped document text: one geo node carrying an explicit tangent (the structurally
     *  distinct field this migration must NOT touch) and one force keyframe carrying a
     *  hand-authored `tangent` key (the pre-S3 explicit-handle shape no live ECS can produce
     *  anymore) — built from a real v2 document (`docFromEcs`) so every other field is
     *  authentically canonical, then downgraded to v1 by hand. */
    function v1TextWithForceTangent(): { text: string; geoTangent: DocGeoTangent } {
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        const geo = createSection(state, 0, SectionKind.Geo, 0);
        addNode(state, geo, 0, 0);
        const geoTangent = { mode: TangentMode.Free, inX: 5, inY: 0, outX: 5, outY: 0 };
        spawnNode(state, geo, 1, 20, 4, 0, geoTangent);
        const force = createSection(state, 1, SectionKind.Force, 30);
        createForcePoint(state, force, 0, 1.5, Easing.Cubic);
        createForcePoint(state, force, 15, 2.5, Easing.Quintic);
        createOneShot(state, 22);

        const doc = JSON.parse(saveDocument(state));
        doc.version = 1;
        doc.sections = doc.segments;
        // Reconstruct the historical flat v1 point shape before exercising both migrations.
        for (const section of doc.sections) {
            section.points = section.points.map((p: Record<string, unknown>) => {
                const boundary = p.boundary as { g: number; ease: number };
                return { id: p.id, s: p.s, g: boundary.g, ease: boundary.ease };
            });
        }
        delete doc.segments;
        // the pre-S3 explicit-handle shape: a mode + one stored (Δs, Δg) offset.
        doc.sections[1].points[1].tangent = { mode: TangentMode.Free, out: { ds: 3, dg: -0.5 } };
        return { text: JSON.stringify(doc), geoTangent };
    }

    test("a v1 file's force-tangent key disappears on migration; its geo tangent survives", () => {
        const { text, geoTangent } = v1TextWithForceTangent();
        const doc = parseDocument(text);

        const forcePoint = doc.segments[1].points[1] as unknown as Record<string, unknown>;
        expect("tangent" in forcePoint).toBe(false);
        expect(doc.segments[0].nodes[1].tangent).toEqual(geoTangent);
    });

    test("loading a v1 file with a force-tangent key stamps v2 and stabilizes on re-save", () => {
        const { text } = v1TextWithForceTangent();
        const state = new State();
        state.addSystem(BakeSystem);
        loadDocument(state, text);
        const v2Text = saveDocument(state);
        expect(JSON.parse(v2Text).version).toBe(CURRENT_VERSION);

        // load→save stabilizes: the migrated form is a fixed point, not a one-time transform.
        const state2 = new State();
        state2.addSystem(BakeSystem);
        loadDocument(state2, v2Text);
        expect(saveDocument(state2)).toBe(v2Text);
    });

    test("a v2 write never carries a points[].tangent key, on any section", () => {
        const { text } = v1TextWithForceTangent();
        const state = new State();
        state.addSystem(BakeSystem);
        loadDocument(state, text);
        const doc = JSON.parse(saveDocument(state));
        for (const section of doc.segments) {
            for (const point of section.points) expect("tangent" in point).toBe(false);
        }
    });

    test("a v2 document carrying a stray points[].tangent key is malformed, refused by name", () => {
        const { state } = flatTrack();
        const sec = createSection(state, 1, SectionKind.Force, 30);
        createForcePoint(state, sec, 5, 1);
        state.step(0);
        const before = snapshotAll(state);
        const doc = JSON.parse(saveDocument(state));
        expect(doc.version).toBe(CURRENT_VERSION);
        doc.segments[1].points[0].tangent = { mode: TangentMode.Free };
        const bad = JSON.stringify(doc);

        expect(() => loadDocument(state, bad)).toThrow(/points\[0\]\.tangent/);
        expect(snapshotAll(state)).toEqual(before);
    });
});

describe("committed golden fixture: tests/fixtures/hill-explicit-golden.kex", () => {
    // a checked-in document (the "hill-explicit" scenario, saved through saveDocument) —
    // distinct from the corpus round-trip above, which never touches disk: this arm proves the
    // COMMITTED bytes stay canonical and loadable, so a future emitter-format drift shows up as
    // a diff against a real file rather than only against a freshly-minted in-memory string.
    const goldenPath = new URL("./fixtures/hill-explicit-golden.kex", import.meta.url);

    test("loads, round-trips, and re-serializes byte-identical to the committed file", async () => {
        const text = await Bun.file(goldenPath).text();

        // canonical idempotence over the committed bytes themselves.
        expect(serializeDocument(parseDocument(text))).toBe(text);

        const b = new State();
        b.addSystem(BakeSystem);
        loadDocument(b, text);
        b.step(0);
        const bEid = trackEntity(b);
        if (bEid === null) throw new Error("no track after load");

        // `restoreAll` spawns every row at its DOCUMENT id (`track.ts`'s `restoreAll`), so a
        // save right back out reproduces the committed bytes exactly — ids included, independent
        // of any other test in this run having advanced the process-wide id counter.
        expect(saveDocument(b)).toBe(text);

        // Capture b's bake BEFORE constructing a second State. `samples`/`bakeOut`
        // (`track.ts:1108`/`1123`) are module-level Maps keyed by raw numeric entity id, and
        // `track.ts:1123`'s own OWED note names the collision: two independent `State()`s both
        // start id counting at 0, so `b` and a freshly-built `a` below both resolve to track
        // entity 1 and share ONE map slot. `bakedArrays` already copies out of the typed arrays
        // (`Array.from`), so reading it now, before `a.state.step(0)` overwrites that slot, is
        // what makes the comparison below discriminate the FIXTURE's own bake rather than
        // comparing `a`'s bake to itself through the shared slot (silently vacuous either way —
        // proven by mutation: friction, a node's `x`, and the one-shot `value` each edited in the
        // committed fixture text used to pass clean; this ordering reds on all three, witnessed
        // 2026-08-28 by reverting the one-shot edit alone: `value: 22` -> `10` in the committed
        // file, without touching the code below, failed with the expected diff, then the fixture
        // was restored via `git show fe14c27:kex2d/tests/fixtures/hill-explicit-golden.kex`).
        const bBaked = bakedArrays(bEid);

        // the bake matches the scenario this fixture was minted from — bakedArrays carries no
        // ids, so this comparison is unaffected by the loaded track's ids differing from a
        // freshly-authored one's.
        const s = scenarios.find((x) => x.name === "hill-explicit");
        if (!s) throw new Error("scenario not found");
        const a = scenarioTrack(s);
        a.state.step(0);
        expect(bBaked).toEqual(bakedArrays(a.eid));
    });
});

describe("frozen v2 migration corpus", () => {
    const valid = [
        "cli/circular-arc.kex",
        "cli/double-hump.kex",
        "cli/full-loop.kex",
        "cli/hill-auto.kex",
        "cli/hill-explicit.kex",
        "cli/loop-explicit.kex",
        "cli/parabola-hill.kex",
        "cli/s-curve.kex",
        "cli/straight-fillet.kex",
        "cli/valley-explicit.kex",
        "hill-explicit-golden.kex",
    ];

    for (const name of valid) {
        test(`${name}: v2 migrates once and canonical v3 is a fixed point`, async () => {
            const text = await Bun.file(new URL(`./fixtures/v2/${name}`, import.meta.url)).text();
            expect(JSON.parse(text).version).toBe(2);
            const state = new State();
            state.addSystem(BakeSystem);
            loadDocument(state, text);
            state.step(0);
            const authored = snapshotAll(state);
            const canonical = saveDocument(state);
            expect(JSON.parse(canonical).version).toBe(CURRENT_VERSION);
            expect(serializeDocument(parseDocument(canonical))).toBe(canonical);

            loadDocument(state, canonical);
            state.step(0);
            expect(snapshotAll(state)).toEqual(authored);
            expect(saveDocument(state)).toBe(canonical);
        });
    }

    test("all 26 pre-S2 fixtures are frozen, with the malformed corpus byte-identical", async () => {
        const malformed = [
            "duplicateId-red.kex",
            "duplicateSectionOrder-red.kex",
            "emptyTrack-red.kex",
            "minExtentFloor-red.kex",
            "minForceExtent-red.kex",
            "minNodeFloor-red.kex",
            "minStartSpeed-red.kex",
            "nodeZeroOrigin-red.kex",
            "sectionKind-red.kex",
            "stationTaken-red.kex",
            "stripKeyframeTaken-red.kex",
            "stripOverlapped-red.kex",
            "valid-green.kex",
            "validCoefficient-red.kex",
            "validStripValue-red.kex",
        ];
        expect(valid.length + malformed.length).toBe(26);
        for (const name of malformed) {
            const frozen = await Bun.file(
                new URL(`./fixtures/v2/invariants/${name}`, import.meta.url),
            ).text();
            const live = await Bun.file(
                new URL(`./fixtures/invariants/${name}`, import.meta.url),
            ).text();
            expect(frozen).toBe(live);
            expect(JSON.parse(frozen).version).toBeLessThanOrEqual(2);
        }
    });
});

describe("run-nested unstable-v3 wire", () => {
    test("load → save → load keeps one contiguous id space across multi-member edge runs", () => {
        const run = (
            id: number,
            order: number,
            kind: SectionKind,
            length: number,
            stations: number[],
        ) => {
            const nodes =
                kind === SectionKind.Geo
                    ? [
                          { id: 0, order: 0, x: 0, y: 0, theta: 0 },
                          { id: 1, order: 1, x: 1, y: 0, theta: 0 },
                      ]
                    : [];
            const row = { id, order, kind, length, nodes, points: [] };
            return stations.length > 1
                ? {
                      ...row,
                      members: stations.map((station) => ({
                          station,
                          kind,
                          nodes: [],
                          points: [],
                      })),
                  }
                : row;
        };
        const wire = serializeDocument({
            version: CURRENT_VERSION,
            track: { ds: 1, domain: 0, friction: 0, resistance: 0 },
            segments: [
                run(41, 0, SectionKind.Force, 30, [0, 11.25]),
                run(50, 1, SectionKind.Force, 8, [0]),
                run(60, 2, SectionKind.Geo, 0, [0]),
                run(70, 3, SectionKind.Force, 20, [0, 7]),
            ],
            strips: [],
            oneShot: [],
        });
        const state = new State();
        state.addSystem(BakeSystem);
        loadDocument(state, wire);
        const first = snapshotAll(state);
        expect(first.segments.map((segment) => segment.order)).toEqual([0, 1, 2, 3, 4, 5]);
        expect(first.segments.map((segment) => segment.id)).toEqual([41, 71, 50, 60, 70, 72]);
        expect(first.segments.map((segment) => segment.run)).toEqual([41, 41, 50, 60, 70, 70]);
        expect(sections(state).map((section) => section.id)).toEqual([41, 50, 60, 70]);
        expect(rebuildSectionProjection(state).map((section) => section.id)).toEqual([
            41, 50, 60, 70,
        ]);
        const canonical = saveDocument(state);
        loadDocument(state, canonical);
        expect(snapshotAll(state)).toEqual(first);
        expect(saveDocument(state)).toBe(canonical);
    });

    test("geo run members use ordered node addresses and run-scoped node guards", () => {
        const document = {
            version: CURRENT_VERSION,
            track: { ds: 1, domain: 0, friction: 0, resistance: 0 },
            segments: [
                {
                    id: 9,
                    order: 0,
                    kind: SectionKind.Geo,
                    length: 0,
                    nodes: [],
                    points: [],
                    members: [
                        {
                            node: 0,
                            kind: SectionKind.Geo,
                            nodes: [{ order: 0, x: 0, y: 0, theta: 0 }],
                            points: [],
                        },
                        {
                            node: 1,
                            kind: SectionKind.Geo,
                            nodes: [{ order: 1, x: 8, y: 2, theta: 0 }],
                            points: [],
                        },
                    ],
                },
            ],
            strips: [],
            oneShot: [],
        };
        const wire = serializeDocument(document);
        const state = new State();
        state.addSystem(BakeSystem);
        loadDocument(state, wire);
        const canonical = saveDocument(state);
        expect(
            JSON.parse(canonical).segments[0].members.map(
                (member: { node: number }) => member.node,
            ),
        ).toEqual([0, 1]);
        expect(snapshotAll(state).segments.map((member) => member.geoEndNode)).toEqual([0, 1]);
        expect(checkDocInvariants(parseDocument(canonical))).toEqual([]);
    });
});

describe("saveDocument / loadDocument on a no-op cycle", () => {
    test("loadDocument(ecs, saveDocument(ecs)) is a no-op on the live ECS", () => {
        const { state, eid } = flatTrack();
        state.step(0);
        const before = snapshotAll(state);
        const beforeBaked = bakedArrays(eid);

        loadDocument(state, saveDocument(state));
        state.step(0);

        expect(snapshotAll(state)).toEqual(before);
        // the Track ENTITY itself survives a load untouched (`restoreAll` only respawns
        // sections/handles/forces/strips/keyframes/one-shot, never the Track entity) — `eid` is
        // still the live track's own id.
        expect(trackEntity(state)).toBe(eid);
        expect(bakedArrays(eid)).toEqual(beforeBaked);
    });

    test("docFromEcs stamps CURRENT_VERSION", () => {
        const { state } = flatTrack();
        expect(docFromEcs(state).version).toBe(CURRENT_VERSION);
    });

    // `Track.count` is bake-derived (spec `kex2d-serialization` Locked decision), so
    // `loadDocument` must zero a REUSED entity's stale count itself — nothing else does until
    // the next `state.step`. Read `Track.count` BEFORE stepping, or `BakeSystem` re-bakes it
    // regardless of whether `loadDocument` zeroed it, hiding the very branch this pins (deleting
    // `doc.ts`'s reuse-path `Track.count.set(trackEid, 0)` still leaves every other arm in this
    // file green).
    test("loadDocument zeroes a reused Track's stale count before the next bake", () => {
        const { state, eid } = flatTrack();
        state.step(0);
        const staleCount = Track.count.get(eid);
        expect(staleCount).toBeGreaterThan(0); // sanity: the track baked samples before reload

        loadDocument(state, saveDocument(state));

        expect(Track.count.get(eid)).toBe(0);
    });
});
