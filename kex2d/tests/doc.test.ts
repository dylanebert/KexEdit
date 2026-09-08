import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { State } from "@dylanebert/shallot";
import {
    CURRENT_VERSION,
    docFromEcs,
    type DocGeoTangent,
    loadDocument,
    migrate,
    type MigrationStep,
    preLaneMigrations,
    numLit,
    parseDocument,
    saveDocument,
    serializeDocument,
} from "../src/doc";
import { Lane, emptyLanes, entryValue, laneExclusive } from "../src/lanes";
import { DEFAULT_G, Easing } from "../src/profile";
import { TangentMode } from "../src/spline";
import {
    bakeOut,
    BakeSystem,
    createRecord,
    createTrack,
    entrySpeed,
    lanesOf,
    samples,
    setV0,
    snapshotAll,
    Track,
    trackEntity,
} from "../src/track";

// the document boundary (spec `kex2d-serialization`): save → load → bake must be byte-identical
// (the ECS's own f32 truth, round-tripped through JSON text), the canonical emitter must be
// idempotent (`serialize(parse(text)) === text`), f32 must survive the text form exactly, and a
// rejected load must leave the live document untouched. Device-free — pure ECS + JSON, no GPU.

/** a fresh lane track: one geo record, one force record, one velocity record — the smallest
 *  document that exercises all three lanes through the wire. */
function laneTrack(): { state: State; eid: number } {
    const state = new State();
    state.addSystem(BakeSystem);
    const eid = createTrack(state);
    setV0(state, 22);
    createRecord(state, Lane.Geo, { start: 0, end: 24, ease: 0, entry: 0, exit: 0.2 });
    createRecord(state, Lane.Force, { start: 24, end: 44, ease: 1, entry: 1, exit: 1.4 });
    createRecord(state, Lane.Velocity, { start: 4, end: 14, ease: 0, entry: 22, exit: 18 });
    return { state, eid };
}

/** a flat one-record track — the rejection-arm fixture, where the exact geometry doesn't
 *  matter, only that it survives a refused load untouched. */
function flatTrack(): { state: State; eid: number } {
    const state = new State();
    state.addSystem(BakeSystem);
    const eid = createTrack(state);
    setV0(state, 22);
    createRecord(state, Lane.Geo, { start: 0, end: 24, ease: 0, entry: 0, exit: 0 });
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

test("a three-lane save and three reloads are an identity fixed point", () => {
    const { state } = laneTrack();
    let text = saveDocument(state);
    const before = snapshotAll(state);
    for (let reload = 0; reload < 3; reload++) {
        loadDocument(state, text);
        expect(saveDocument(state)).toBe(text);
        expect(snapshotAll(state)).toEqual(before);
        text = saveDocument(state);
    }
});

describe("a three-lane document round-trips through the wire", () => {
    test("save → load → bake is byte-identical, and the text is a fixed point", () => {
        const a = laneTrack();
        a.state.step(0);

        const text = saveDocument(a.state);
        const authored = snapshotAll(a.state);
        const baked = bakedArrays(a.eid);

        // canonical idempotence: re-emitting a parsed document reproduces the same text.
        expect(serializeDocument(parseDocument(text))).toBe(text);

        const b = new State();
        b.addSystem(BakeSystem);
        loadDocument(b, text);
        b.step(0);
        const bEid = trackEntity(b);
        if (bEid === null) throw new Error("no track after load");

        // authored-state deep equality — every record and every track-level scalar.
        expect(snapshotAll(b)).toEqual(authored);
        // bakeOut/samples arrays byte-identical.
        expect(bakedArrays(bEid)).toEqual(baked);
    });

    // **The dissolved constraint** (spec S2e-i punch list item 3): `docFromEcs` emits the stored
    // rows and never fits, so a record NO fit would accept still saves and round-trips exactly.
    // Red by routing the save through the fit: `lanesFromChain` cannot represent this record, so
    // a save that re-derived would either refuse it or move it.
    test("a 1 m pitch record turning 3 radians saves and round-trips byte-identically", () => {
        const state = new State();
        state.addSystem(BakeSystem);
        createTrack(state);
        setV0(state, 20);
        createRecord(state, Lane.Geo, { start: 0, end: 1, ease: 0, entry: 0, exit: 3 });
        createRecord(state, Lane.Force, { start: 1, end: 21, ease: 1, entry: 1, exit: 1 });
        const text = saveDocument(state);
        expect(text).toContain('"exit":3');
        const authored = lanesOf(state).geo[0]!;

        const b = new State();
        b.addSystem(BakeSystem);
        loadDocument(b, text);
        expect(saveDocument(b)).toBe(text);
        expect(lanesOf(b).geo[0]).toEqual(authored);
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

    test("through the real ECS write path: the columns survive a save→load cycle bit-identical", () => {
        const rng = mulberry32(1234);
        const state = new State();
        state.addSystem(BakeSystem);
        const eid = createTrack(state);
        const ds = Math.fround(0.5 + rng() * 0.5);
        Track.ds.set(eid, ds);
        Track.friction.set(eid, Math.fround(rng() * 0.1));
        Track.resistance.set(eid, Math.fround(rng() * 1e-3));
        setV0(state, 22);
        // f64 stations: a station f32 CANNOT represent, so a column that silently narrowed
        // would come back a different number and the round-trip below would fail.
        const hostile = 40.12345678901234;
        expect(Math.fround(hostile)).not.toBe(hostile);
        createRecord(state, Lane.Geo, { start: 0, end: hostile, ease: 0, entry: 0, exit: 0.25 });
        for (let i = 0; i < 8; i++)
            createRecord(state, Lane.Force, {
                start: hostile + i * 6,
                end: hostile + (i + 1) * 6,
                ease: 1,
                entry: Math.fround(1 + rng() * 0.5),
                exit: Math.fround(1 + rng() * 0.5),
            });
        state.step(0);

        const text = saveDocument(state);
        const authored = snapshotAll(state);
        const dsBits = bits(Track.ds.get(eid));
        const frictionBits = bits(Track.friction.get(eid));
        const resistanceBits = bits(Track.resistance.get(eid));
        const b = new State();
        b.addSystem(BakeSystem);
        loadDocument(b, text);
        const bEid = trackEntity(b);
        if (bEid === null) throw new Error("no track after load");

        expect(bits(Track.ds.get(bEid))).toBe(dsBits);
        expect(bits(Track.friction.get(bEid))).toBe(frictionBits);
        expect(bits(Track.resistance.get(bEid))).toBe(resistanceBits);
        expect(snapshotAll(b)).toEqual(authored);
        expect(lanesOf(b).geo[0]!.end).toBe(hostile);
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

    test("malformed shape (a record missing a required field) refuses and leaves the document untouched", () => {
        const { state } = flatTrack();
        state.step(0);
        const before = snapshotAll(state);
        const doc = JSON.parse(saveDocument(state));
        delete doc.lanes.geo[0].exit;
        const bad = JSON.stringify(doc);

        expect(() => loadDocument(state, bad)).toThrow(/lanes\.geo\[0\]\.exit/);
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

    test("an out-of-range lane easing refuses and leaves the document untouched", () => {
        const { state } = flatTrack();
        state.step(0);
        const before = snapshotAll(state);
        const doc = JSON.parse(saveDocument(state));
        doc.lanes.geo[0].ease = 999;
        expect(() => loadDocument(state, JSON.stringify(doc))).toThrow(/ease/);
        expect(snapshotAll(state)).toEqual(before);
    });

    test("a non-finite lane handle refuses and leaves the document untouched", () => {
        const { state } = flatTrack();
        state.step(0);
        const before = snapshotAll(state);
        const doc = JSON.parse(saveDocument(state));
        doc.lanes.geo[0].exit = "nope";
        expect(() => loadDocument(state, JSON.stringify(doc))).toThrow(/exit/);
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
        const geoTangent = { mode: TangentMode.Free, inX: 14, inY: 0, outX: 14, outY: 0 };
        const doc = {
            version: 1,
            track: { ds: 0.5, domain: 0, friction: 0, resistance: 0 },
            sections: [
                {
                    id: 0,
                    order: 0,
                    kind: 0,
                    length: 0,
                    nodes: [
                        { order: 0, x: 0, y: 0, theta: 0 },
                        { order: 1, x: 20, y: 4, theta: 0, tangent: geoTangent },
                    ],
                    points: [],
                },
                {
                    id: 1,
                    order: 1,
                    kind: 1,
                    length: 30,
                    nodes: [],
                    points: [
                        { id: 0, s: 0, g: 1.5, ease: Easing.Cubic },
                        // the pre-S3 explicit-handle shape: a mode + one stored (Δs, Δg) offset.
                        {
                            id: 1,
                            s: 15,
                            g: 2.5,
                            ease: Easing.Quintic,
                            tangent: { mode: TangentMode.Free, out: { ds: 3, dg: -0.5 } },
                        },
                    ],
                },
            ],
            strips: [],
            oneShot: [{ id: 0, value: 22 }],
        };
        return { text: JSON.stringify(doc), geoTangent };
    }

    test("a v1 file's force-tangent key disappears at migrations[1]; its geo tangent survives", () => {
        // read at the STEP, not at the loaded document: `segments`/`strips` left the v4 wire at
        // S2e-i, so the shape this migration reshapes is only observable here.
        const { text, geoTangent } = v1TextWithForceTangent();
        const v2 = preLaneMigrations[1]!(JSON.parse(text)) as {
            version: number;
            sections: { nodes: { tangent?: DocGeoTangent }[]; points: Record<string, unknown>[] }[];
        };
        expect(v2.version).toBe(2);
        for (const point of v2.sections[1]!.points) expect("tangent" in point).toBe(false);
        expect(v2.sections[0]!.nodes[1]!.tangent).toEqual(geoTangent);
    });

    test("a v1 file with a force-tangent key loads and stabilizes on re-save", () => {
        const { text } = v1TextWithForceTangent();
        const state = new State();
        state.addSystem(BakeSystem);
        loadDocument(state, text);
        const saved = saveDocument(state);
        expect(JSON.parse(saved).version).toBe(CURRENT_VERSION);
        const b = new State();
        b.addSystem(BakeSystem);
        loadDocument(b, saved);
        expect(saveDocument(b)).toBe(saved);
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

        // a real bake happened, so the round-trip above is not vacuous on an empty document.
        expect(bakedArrays(bEid).count).toBeGreaterThan(1);
    });
});

describe("frozen v2 migration corpus", () => {
    const valid = [
        "cli/circular-arc.kex",
        "cli/double-hump.kex",
        "cli/full-loop.kex",
        "cli/hill-auto.kex",
        "cli/hill-explicit.kex",
        "cli/parabola-hill.kex",
        "cli/s-curve.kex",
        "cli/straight-fillet.kex",
        "cli/valley-explicit.kex",
        "hill-explicit-golden.kex",
    ];

    test("cli/loop-explicit.kex is refused, at v2 exactly as at v3", async () => {
        // the refusal is a property of the SCENARIO, not of the version it is frozen at: the
        // near-cusps are in the node chain every version of the file carries.
        const text = await Bun.file(
            new URL("./fixtures/v2/cli/loop-explicit.kex", import.meta.url),
        ).text();
        const state = new State();
        state.addSystem(BakeSystem);
        expect(() => loadDocument(state, text)).toThrow(/retired\/pose-ux/);
    });

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

    test("all 18 pre-S2 fixtures are frozen at v2 or below", async () => {
        // The `invariants/` corpus is authored at v4 from S2e-i on (its guards are lane laws,
        // which no v2 document can express), so these frozen files are migration INPUTS only —
        // they no longer twin a live fixture, and asserting they did would pin a relationship
        // that ended with the node substrate.
        const malformed = [
            "duplicateId-red.kex",
            "emptyTrack-red.kex",
            "minExtentFloor-red.kex",
            "minStartSpeed-red.kex",
            "valid-green.kex",
            "validCoefficient-red.kex",
            "validStripValue-red.kex",
        ];
        // +1: `cli/loop-explicit.kex` is frozen here too, and is asserted above as a refusal
        // rather than listed among the documents that migrate.
        expect(valid.length + malformed.length + 1).toBe(18);
        for (const name of malformed) {
            const frozen = await Bun.file(
                new URL(`./fixtures/v2/invariants/${name}`, import.meta.url),
            ).text();
            expect(JSON.parse(frozen).version).toBeLessThanOrEqual(2);
        }
    });
});

describe("the start speed is `track.v0` and nothing else", () => {
    test("`track.v0` alone authors the start speed and survives a save", () => {
        // The retired `oneShot` array used to carry the identity a load resolved the value
        // through, so a document holding `v0` with an empty array authored NO start speed and
        // lost `v0` on the way back out. `track.v0` is now self-sufficient.
        const wire = serializeDocument({
            version: CURRENT_VERSION,
            track: { ds: 0.5, domain: 0, friction: 0, resistance: 0, v0: 17.5 },
            lanes: {
                ...emptyLanes(),
                geo: [{ id: 0, start: 0, end: 12, ease: 0, entry: 0, exit: 0 }],
            },
        });
        const state = new State();
        state.addSystem(BakeSystem);
        loadDocument(state, wire);
        expect(entrySpeed(state)).toBe(17.5);
        expect(parseDocument(saveDocument(state)).track.v0).toBe(17.5);
    });

    test("a surviving `oneShot` array is a mis-stamped file and is refused by name", () => {
        const raw = JSON.parse(
            readFileSync(join(import.meta.dir, "fixtures", "cli", "hill-auto.kex"), "utf8"),
        );
        raw.oneShot = [{ id: 0 }];
        expect(() => parseDocument(JSON.stringify(raw))).toThrow(/oneShot .*track\.v0/);
    });
});

describe("a retired wire column makes the file a bridged document, not a v4 one", () => {
    // one inline v4 text, valid but for the column: the guard is structural, so it needs no
    // `invariants/*-red.kex` fixture (that census is one fixture per semantic guard).
    const v4 = () => ({
        version: CURRENT_VERSION,
        track: { ds: 0.5, domain: 0, friction: 0, resistance: 0, v0: 16 },
        lanes: {
            velocity: [],
            force: [],
            geo: [{ id: 0, start: 0, end: 24, ease: 0, entry: 0, exit: 0 }],
        },
    });

    test("the inline v4 text itself loads", () => {
        expect(parseDocument(JSON.stringify(v4())).lanes.geo).toHaveLength(1);
    });

    for (const column of ["segments", "strips"] as const) {
        test(`a v4 text still carrying \`${column}\` is refused with the bridged-build remedy`, () => {
            const raw = { ...v4(), [column]: [] } as Record<string, unknown>;
            expect(() => parseDocument(JSON.stringify(raw))).toThrow(
                new RegExp(`${column} is not a valid field`),
            );
            expect(() => parseDocument(JSON.stringify(raw))).toThrow(/retired\/pose-ux/);
            expect(() => parseDocument(JSON.stringify(raw))).toThrow(/kex2d document:/);
        });
    }
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
        // and a SECOND cycle is a true fixed point.
        const once = saveDocument(state);
        loadDocument(state, once);
        state.step(0);
        expect(snapshotAll(state)).toEqual(before);
        // the Track ENTITY itself survives a load untouched (`restoreAll` only respawns lane
        // records, never the Track entity) — `eid` is still the live track's own id.
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

// ── v4 lane wire (`kex2d-segment-gestures` S1 § Validation 1) ────────────────────────────────

/** every committed `.kex` under `tests/fixtures/`, at whatever version it was frozen at —
 *  the migration corpus, read off disk rather than hand-listed so a fixture added later cannot
 *  quietly escape the sweep. */
function fixtureCorpus(): string[] {
    const root = join(import.meta.dir, "fixtures");
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
            a.name.localeCompare(b.name),
        )) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) walk(path);
            else if (entry.name.endsWith(".kex")) out.push(path);
        }
    };
    walk(root);
    return out;
}

/** the loadable half of the corpus: the `invariants/` fixtures are deliberately malformed (each
 *  trips one named guard) and the `v2/`/`v3/` mirrors duplicate their live siblings byte for
 *  byte, so a load arm reads the live, valid documents. */
function loadableCorpus(): string[] {
    return fixtureCorpus().filter(
        (p) => !p.includes("/invariants/") && !p.includes("/v2/") && !p.includes("/v3/"),
    );
}

/** every committed fixture that actually BAKES: the whole set minus the frozen `v2/`/`v3/`
 *  migration inputs and the deliberately malformed `invariants/*-red` corpus. The same
 *  population `tests/bake-identity.oracle.ts` pins. */
function _bakeableCorpus(): string[] {
    return fixtureCorpus().filter(
        (p) => !p.includes("/v2/") && !p.includes("/v3/") && !p.endsWith("-red.kex"),
    );
}

describe("v4 migration sweep", () => {
    const corpus = fixtureCorpus();

    test("the corpus is the whole committed fixture set", () => {
        // population floor: a narrowed walk (a typo'd root, a swallowed recursion) cannot pass.
        expect(corpus.length).toBe(68);
        expect(corpus.some((p) => p.includes("/velocity/"))).toBe(true);
        expect(corpus.some((p) => p.includes("/force/"))).toBe(true);
        expect(corpus.some((p) => p.includes("/cli/"))).toBe(true);
    });

    for (const path of corpus) {
        const name = path.slice(path.indexOf("fixtures/"));
        test(`${name} migrates forward to v${CURRENT_VERSION}`, () => {
            const raw = JSON.parse(readFileSync(path, "utf8"));
            expect(raw.version).toBeLessThanOrEqual(CURRENT_VERSION);
            if (name.endsWith("cli/loop-explicit.kex")) {
                // the one named refusal in the corpus: its near-cusps are sub-quantum, so the
                // geo lane cannot represent them and `migrations[3]` refuses rather than
                // shipping a fit that misrepresents the document.
                expect(() => migrate(raw)).toThrow(/retired\/pose-ux/);
                return;
            }
            const migrated = migrate(raw);
            expect(migrated.version).toBe(CURRENT_VERSION);
            // the lane substrate is present and shaped on every migrated document, malformed
            // legacy payload or not.
            const lanes = migrated.lanes as Record<string, unknown>;
            for (const lane of ["velocity", "force", "geo"]) expect(lanes[lane]).toBeArray();
            // and a pre-v4 file's retired `oneShot` value has moved onto `track.v0`.
            if (raw.version < CURRENT_VERSION) {
                const oneShot = (raw.oneShot ?? []) as { value?: number }[];
                expect((migrated.track as { v0?: number }).v0).toBe(oneShot[0]?.value);
            }
            // v4 retires the array outright: the start speed is `track.v0` and nothing else.
            expect(migrated).not.toHaveProperty("oneShot");
        });
    }
});

describe("hand-checked v4 lane shapes", () => {
    function migratedLanes(rel: string) {
        const text = readFileSync(join(import.meta.dir, "fixtures", rel), "utf8");
        return parseDocument(text).lanes;
    }

    test("velocity/multi-keyframe-strip.kex: one strip splits at each keyframe", () => {
        // the committed strip is [2, 14) value 10 with keyframes (2,10) (6,18) (10,8) (14,12):
        // three adjacent segments, each owning both handles, no gap and no overlap.
        const lanes = migratedLanes("velocity/multi-keyframe-strip.kex");
        // Cubic, not Linear: a strip-born span baked as the Cubic curve `profile.segment`
        // reads for a missing tag, so that is the tag the migration must mint.
        expect(lanes.velocity).toEqual([
            { id: 0, start: 2, end: 6, ease: Easing.Cubic, entry: 10, exit: 18 },
            { id: 1, start: 6, end: 10, ease: Easing.Cubic, entry: 18, exit: 8 },
            { id: 2, start: 10, end: 14, ease: Easing.Cubic, entry: 8, exit: 12 },
        ]);
        expect(laneExclusive(lanes.velocity)).toBe(true);
        // and the single force run of that fixture is one flat segment, entry key owned.
        expect(lanes.force).toEqual([
            { id: 3, start: 0, end: 20, ease: Easing.Cubic, entry: 1, exit: 1 },
        ]);
        expect(lanes.geo).toEqual([]);
    });

    test("cli/circular-arc.kex: an Auto-reflect arc fits one Linear record per node pair", () => {
        // read the FROZEN v3 source, so `migrations[3]` itself is under test rather than the
        // already-migrated committed file's parser round trip.
        const lanes = migratedLanes("v3/cli/circular-arc.kex");
        // one record per NODE PAIR — the arc's two Auto-reflect segments — each tagged Linear,
        // which on a constant-radius arc is the exact curve (a constant turn rate).
        expect(lanes.geo.map((r) => r.ease)).toEqual([Easing.Linear, Easing.Linear]);
        // the handles are PITCH — absolute unwrapped world headings in radians — so the record
        // opens at the entry heading and closes at the heading the bake recovered at the tail
        // node, and no frame column travels with it.
        expect(lanes.geo[0]!.start).toBe(0);
        expect(typeof lanes.geo[0]!.exit).toBe("number");
        expect(lanes.geo[0]!.entry).toBeCloseTo(0, 2);
    });

    test("an explicit-tangent group fits pitch records within both budgets", () => {
        const lanes = migratedLanes("v3/cli/hill-explicit.kex");
        expect(lanes.geo.length).toBeGreaterThan(0);
        for (const r of lanes.geo) expect(Number.isFinite(r.exit)).toBe(true);
        // and every geo record survives the emitter → parser round trip verbatim.
        const doc = parseDocument(
            readFileSync(join(import.meta.dir, "fixtures", "cli", "hill-explicit.kex"), "utf8"),
        );
        expect(parseDocument(serializeDocument(doc)).lanes.geo).toEqual(doc.lanes.geo);
    });

    test("velocity/keyframeless-strip.kex: one constant segment, entry === exit === value", () => {
        const lanes = migratedLanes("velocity/keyframeless-strip.kex");
        expect(lanes.velocity).toEqual([
            { id: 0, start: 3, end: 9, ease: Easing.Cubic, entry: 11, exit: 11 },
        ]);
    });

    test("force/adjacent-force-runs.kex: two runs, each run-entry key an owned entry", () => {
        // run 0 is extent 4 with keys (0, g1, Linear) and (4, g2, Linear); run 1 abuts it at
        // station 4, extent 5, keys (0, g2, Quintic) and (5, g0.75, Quintic).
        const lanes = migratedLanes("force/adjacent-force-runs.kex");
        expect(lanes.force).toEqual([
            { id: 0, start: 0, end: 4, ease: Easing.Linear, entry: 1, exit: 2 },
            { id: 1, start: 4, end: 9, ease: Easing.Quintic, entry: 2, exit: 0.75 },
        ]);
        // abutting, so exclusive — and segment 1's owned entry equals its predecessor's exit,
        // which is what makes the run boundary continuous rather than a jump.
        expect(laneExclusive(lanes.force)).toBe(true);
        expect(entryValue(Lane.Force, lanes.force, lanes.force[1]!)).toBe(2);
        expect(lanes.velocity).toEqual([]);
        expect(lanes.geo).toEqual([]);
    });

    test("force/all-easings.kex: the run splits at its keys and each record leads its own", () => {
        // extent 8, keys (0, 0.5, Linear) (2, 2, Cubic) (5, -0.25, Quintic) (8, 1, Cubic) — the
        // whole authored profile survives as three adjacent segments; only the first owns an
        // entry, and each record carries the tag of the key that LEADS it (`profile.ts`: the
        // leading keyframe governs the following segment), never the one that terminates it.
        const lanes = migratedLanes("force/all-easings.kex");
        // the fixture leads with a geo run, which claims lane id 0 (one shared id namespace,
        // walked velocity → chain order), so the force records start at 1.
        // the geo record's handles are PITCH scalars, the shape the Wire v4 paragraph names.
        expect(lanes.geo).toEqual([
            { id: 0, start: 0, end: 3, ease: Easing.Linear, entry: 0, exit: 0 },
        ]);
        // and the force run is anchored at the geo run's own derived length, not at zero.
        expect(lanes.force).toEqual([
            { id: 1, start: 3, end: 5, ease: Easing.Linear, entry: 0.5, exit: 2 },
            { id: 2, start: 5, end: 8, ease: Easing.Cubic, exit: -0.25 },
            { id: 3, start: 8, end: 11, ease: Easing.Quintic, exit: 1 },
        ]);
        expect(entryValue(Lane.Force, lanes.force, lanes.force[1]!)).toBe(2);
    });

    test("force/single-terminal.kex: the first record owns the run's materialized entry", () => {
        // one key at the run end, so the evaluator's own start clamp is `sampleForce(points, 0)`
        // — the migrated record owns exactly that, rather than ramping from an inferred DEFAULT_G.
        const lanes = migratedLanes("force/single-terminal.kex");
        expect(lanes.force).toEqual([
            { id: 0, start: 0, end: 6, ease: Easing.Linear, entry: 0.5, exit: 0.5 },
        ]);
        expect(entryValue(Lane.Force, lanes.force, lanes.force[0]!)).toBe(0.5);
    });

    test("force/keyless.kex: a keyless run is one flat DEFAULT_G segment owning both handles", () => {
        // the run still bakes — `materializeRunForceClamps` holds DEFAULT_G across it — so the
        // lane must carry that span rather than leaving the run's whole extent unauthored.
        expect(migratedLanes("force/keyless.kex").force).toEqual([
            { id: 0, start: 0, end: 6, ease: Easing.Linear, entry: DEFAULT_G, exit: DEFAULT_G },
        ]);
    });

    test("the SAVED v4 text carries the lanes, not just the parsed document", () => {
        // the fixed-point arms below compare a save against another save, so they cannot see a
        // lane block the emitter drops on both sides. This one reads the emitted bytes.
        const state = new State();
        state.addSystem(BakeSystem);
        loadDocument(
            state,
            readFileSync(
                join(import.meta.dir, "fixtures", "velocity", "multi-keyframe-strip.kex"),
                "utf8",
            ),
        );
        state.step(0);
        const emitted = JSON.parse(saveDocument(state)).lanes;
        expect(emitted.velocity).toEqual([
            { id: 0, start: 2, end: 6, ease: Easing.Cubic, entry: 10, exit: 18 },
            { id: 1, start: 6, end: 10, ease: Easing.Cubic, entry: 18, exit: 8 },
            { id: 2, start: 10, end: 14, ease: Easing.Cubic, entry: 8, exit: 12 },
        ]);
        expect(emitted.force).toEqual([
            { id: 3, start: 0, end: 20, ease: Easing.Cubic, entry: 1, exit: 1 },
        ]);
        expect(emitted.geo).toEqual([]);
    });
});

describe("v4 canonical text is a fixed point", () => {
    for (const path of loadableCorpus()) {
        const name = path.slice(path.indexOf("fixtures/"));
        test(`${name}: save(load(v4)) === v4`, () => {
            const state = new State();
            state.addSystem(BakeSystem);
            loadDocument(state, readFileSync(path, "utf8"));
            state.step(0);
            const canonical = saveDocument(state);
            expect(JSON.parse(canonical).version).toBe(CURRENT_VERSION);
            // the emitter's own idempotence, then the whole ECS round trip on the v4 text.
            expect(serializeDocument(parseDocument(canonical))).toBe(canonical);
            const authored = snapshotAll(state);
            loadDocument(state, canonical);
            state.step(0);
            expect(snapshotAll(state)).toEqual(authored);
            expect(saveDocument(state)).toBe(canonical);
        });
    }
});

describe("migrations[3] refuses a force key past its run's extent", () => {
    /** a minimal well-formed v3 document: one force run over `extent`, with `keys` on it. */
    function v3(extent: number, keys: { id: number; s: number }[]): string {
        return JSON.stringify({
            version: 3,
            track: { ds: 0.5, domain: 0, friction: 0, resistance: 0 },
            segments: [
                {
                    id: 0,
                    order: 0,
                    kind: 1,
                    run: 0,
                    station: 0,
                    extent,
                    nodes: [],
                    points: keys.map((k) => ({ id: k.id, s: k.s, boundary: { g: 1, ease: 1 } })),
                },
            ],
            strips: [],
            oneShot: [],
        });
    }

    test("a key inside the run migrates", () => {
        const lanes = parseDocument(v3(20, [{ id: 0, s: 8 }])).lanes;
        expect(lanes.force.map((r) => [r.start, r.end])).toEqual([
            [0, 8],
            [8, 20],
        ]);
    });

    test("a key past the run's extent is refused, not silently dropped", () => {
        // dropping it loses authored content while still producing a loadable document — the
        // shape a migration must never mint (spec S2b punch list).
        expect(() => parseDocument(v3(20, [{ id: 0, s: 26 }]))).toThrow(/26/);
        expect(() => parseDocument(v3(20, [{ id: 0, s: 26 }]))).toThrow(/kex2d document:/);
    });
});

describe("frozen v3 migration corpus", () => {
    // the pre-S1 v3 corpus, frozen under `tests/fixtures/v3/` exactly as `v2/` freezes the
    // pre-S2 one: a v3 file must keep migrating to canonical v4, and the canonical v4 it
    // produces must be the same document the live (already-v4) sibling loads.
    const frozen = [
        "cli/circular-arc.kex",
        "cli/double-hump.kex",
        "cli/full-loop.kex",
        "cli/hill-auto.kex",
        "cli/hill-explicit.kex",
        "cli/parabola-hill.kex",
        "cli/s-curve.kex",
        "cli/straight-fillet.kex",
        "cli/valley-explicit.kex",
        "hill-explicit-golden.kex",
    ];

    test("cli/loop-explicit.kex is refused, and its v3 file stays as the witness", async () => {
        // the named refusal witness: kept frozen under `tests/fixtures/v3/` precisely so the
        // refusal has a live document behind it, and minted into no v4 fixture
        // (`tests/mint-cli-fixtures.ts` skips it by name).
        const text = await Bun.file(
            new URL("./fixtures/v3/cli/loop-explicit.kex", import.meta.url),
        ).text();
        expect(() => parseDocument(text)).toThrow(/retired\/pose-ux/);
        expect(existsSync(new URL("./fixtures/cli/loop-explicit.kex", import.meta.url))).toBe(
            false,
        );
    });

    for (const name of frozen) {
        test(`${name}: v3 migrates once and canonical v4 is a fixed point`, () => {
            const text = readFileSync(join(import.meta.dir, "fixtures", "v3", name), "utf8");
            expect(JSON.parse(text).version).toBe(3);
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

            // the live sibling is the re-minted v4 of the same scenario; it carries its own
            // stable ids (minting allocates fresh), so what must agree is the format stamp.
            const live = readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
            expect(JSON.parse(live).version).toBe(CURRENT_VERSION);
        });
    }
});
