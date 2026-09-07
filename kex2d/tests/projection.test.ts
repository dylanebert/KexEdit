import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "../src/doc";
import { Lane, type LaneSegment, type Lanes } from "../src/lanes";
import { Easing, sampleForce } from "../src/profile";
import { deriveRuns } from "../src/projection";
import { materializeRunForceClamps, SectionKind } from "../src/track";

// ── deriveRuns: the lane → evaluator partition ──────────────────────────────────────────────

/** a geo record: its handles are PITCH angles in radians, the same scalar shape the force lane
 *  carries — one substrate over both shape lanes. */
function geoSeg(id: number, start: number, end: number, exit = 0): LaneSegment {
    return { id, start, end, ease: Easing.Linear, exit };
}

function laneSeg(
    id: number,
    start: number,
    end: number,
    exit: number,
    ease: Easing = Easing.Cubic,
    entry?: number,
): LaneSegment {
    return { id, start, end, ease, exit, ...(entry === undefined ? {} : { entry }) };
}

test("geo abutting groups are the geo runs and every uncovered stretch is a force run", () => {
    const lanes: Lanes = {
        velocity: [],
        // two abutting geo records, a gap, then one more: two geo runs.
        force: [laneSeg(10, 12, 20, 2)],
        geo: [geoSeg(0, 0, 5), geoSeg(1, 5, 12), geoSeg(2, 20, 26)],
    };
    const runs = deriveRuns(lanes, 0);
    expect(runs.map((r) => [r.kind, r.start, r.length, r.segmentIds])).toEqual([
        [SectionKind.Geo, 0, 12, [0, 1]],
        [SectionKind.Force, 12, 8, [10]],
        [SectionKind.Geo, 20, 6, [2]],
    ]);
    // the run identity is its first member's lane id, which is what `runInfo` keys on.
    expect(runs.map((r) => r.id)).toEqual([0, 10, 2]);
    // conserved run-local member stations, run length appended — never a sum of extents.
    expect(runs[0]!.stations).toEqual([0, 5, 12]);
});

test("a force run with no authored record still bakes, under an id no lane record holds", () => {
    const lanes: Lanes = { velocity: [], force: [], geo: [geoSeg(7, 0, 10)] };
    const runs = deriveRuns(lanes, 25);
    expect(runs.map((r) => [r.kind, r.start, r.length])).toEqual([
        [SectionKind.Geo, 0, 10],
        [SectionKind.Force, 10, 15],
    ]);
    expect(runs[1]!.segmentIds).toEqual([]);
    expect(runs[1]!.points).toEqual([]);
    expect(runs[1]!.id).toBeGreaterThan(7);
    // one station per member plus the run extent: a memberless run publishes only its extent.
    expect(runs[1]!.stations).toEqual([15]);
});

test("a pinned end extends the trailing force run; follow reads the longest lane", () => {
    const lanes: Lanes = {
        velocity: [laneSeg(3, 0, 40, 12)],
        force: [],
        geo: [geoSeg(0, 0, 9)],
    };
    expect(deriveRuns(lanes, 0).map((r) => r.length)).toEqual([9, 31]);
    expect(deriveRuns(lanes, 60).map((r) => r.length)).toEqual([9, 51]);
});

test("force keys read the leading record's easing and the successor's owned entry", () => {
    const lanes: Lanes = {
        velocity: [],
        geo: [],
        force: [
            laneSeg(0, 0, 5, 1.5, Easing.Quintic, 0.5),
            laneSeg(1, 5, 10, 3, Easing.Linear),
            // an authored discontinuity: the successor owns an entry at the shared station.
            laneSeg(2, 10, 14, 4, Easing.Cubic, -1),
        ],
    };
    expect(deriveRuns(lanes, 0)[0]!.points).toEqual([
        { s: 0, g: 0.5, ease: Easing.Quintic },
        { s: 5, g: 1.5, ease: Easing.Linear },
        // the discontinuity is TWO keys at the shared station, exit then entry: the
        // predecessor's owned exit is honoured up to 10 and the successor's value governs from
        // it on. A single key here would rewrite [5, 10) to arrive at −1, which the author
        // never asked for.
        { s: 10, g: 3, ease: Easing.Cubic },
        { s: 10, g: -1, ease: Easing.Cubic },
        { s: 14, g: 4, ease: Easing.Cubic },
    ]);
    // and the zero-width span changes no sample: the profile still reads the predecessor's
    // ramp right up to the station and the successor's value at it.
    const pts = deriveRuns(lanes, 0)[0]!.points;
    expect(sampleForce(pts, 9.999)).toBeCloseTo(3, 2);
    expect(sampleForce(pts, 10)).toBe(-1);
});

test("a record opening a lane gap without an owned entry authors no key at its start", () => {
    const lanes: Lanes = { velocity: [], geo: [], force: [laneSeg(0, 6, 12, 3, Easing.Linear)] };
    const run = deriveRuns(lanes, 20)[0]!;
    expect(run.points).toEqual([{ s: 12, g: 3, ease: Easing.Linear }]);
    // the run's own clamps, not a borrowed exit at the gap boundary.
    expect(materializeRunForceClamps(run.points, run.length)).toEqual([
        { s: 0, g: 3, ease: Easing.Linear },
        { s: 12, g: 3, ease: Easing.Linear },
        { s: 20, g: 3, ease: Easing.Linear },
    ]);
});

test("derived run stations are read from the records, never summed from member extents", () => {
    // `a + (b - a) !== b` in f64, so a station rebuilt by accumulating extents misses the
    // authored boundary — the conserved-frame law (`kex2d-map.md`: never re-sum run stations).
    const a = 12.1;
    const b = 30.3;
    expect(a - 0 + (b - a)).not.toBe(b);
    const lanes: Lanes = {
        velocity: [],
        force: [],
        geo: [geoSeg(0, 0, a), geoSeg(1, a, b), geoSeg(2, b, 44)],
    };
    const run = deriveRuns(lanes, 0)[0]!;
    expect(run.stations).toEqual([0, a, b, 44]);
    expect(run.length).toBe(44);
});

// ── the geo cut through a force record (S2b punch list) ────────────────────────────────────

test("a force record a geo group cuts keys its own curve's value at both cut stations", () => {
    // the punch-list case: force [0, 30) under a geo group at [10, 20). The record is cut into
    // two windows; each window's cut boundary carries the value the record's OWN curve reaches
    // there, never the far handle borrowed across the geo run.
    const lanes: Lanes = {
        velocity: [],
        force: [laneSeg(0, 0, 30, 4, Easing.Linear, 1)],
        geo: [geoSeg(5, 10, 20)],
    };
    const runs = deriveRuns(lanes, 40);
    expect(runs.map((r) => [r.kind, r.start, r.length])).toEqual([
        [SectionKind.Force, 0, 10],
        [SectionKind.Geo, 10, 10],
        [SectionKind.Force, 20, 20],
    ]);
    // linear 1 g → 4 g over [0, 30): 2 g at 10 and 3 g at 20.
    expect(runs[0]!.points).toEqual([
        { s: 0, g: 1, ease: Easing.Linear },
        { s: 10, g: 2, ease: Easing.Linear },
    ]);
    // the tail window opens on the same curve it was cut from, and closes on the record's own
    // exit handle (the cut value is solved on the curve, so it carries the solver's residual).
    expect(runs[2]!.points.map((p) => [p.s, p.ease])).toEqual([
        [0, Easing.Linear],
        [10, Easing.Linear],
    ]);
    expect(runs[2]!.points[0]!.g).toBeCloseTo(3, 12);
    expect(runs[2]!.points[1]!.g).toBe(4);
});

test("no derived run emits a force key outside its own [0, length] window", () => {
    const lanes: Lanes = {
        velocity: [],
        force: [laneSeg(0, 0, 30, 4, Easing.Cubic, 1), laneSeg(1, 32, 38, 2, Easing.Linear, 5)],
        geo: [geoSeg(5, 10, 20)],
    };
    for (const run of deriveRuns(lanes, 40)) {
        for (const p of run.points) {
            expect(p.s, `run ${run.id} key at ${p.s} of [0, ${run.length}]`).toBeGreaterThanOrEqual(
                0,
            );
            expect(p.s, `run ${run.id} key at ${p.s} of [0, ${run.length}]`).toBeLessThanOrEqual(
                run.length,
            );
        }
    }
});

test("every derived run id is unique, synthetic where a member started before the run", () => {
    const lanes: Lanes = {
        velocity: [],
        force: [laneSeg(0, 0, 30, 4, Easing.Linear, 1)],
        geo: [geoSeg(5, 10, 20)],
    };
    const ids = deriveRuns(lanes, 40).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    // the leading window keeps the record's own identity; the cut tail cannot claim it again.
    expect(ids[0]).toBe(0);
    expect(ids[2]).toBeGreaterThan(5);
});

test("a gap-leading force run reports its member's entry station, not just the run bounds", () => {
    // a record at 6–12 inside a run over [0, 20): the member's own entry station 6 is a real
    // boundary of the conserved frame and must be published. The frame is one station per
    // member plus the run extent — the leading dwell is not a member, so it mints no station
    // (spec architect Answer, 2026-09-07, folded at `c9087e20`).
    const lanes: Lanes = { velocity: [], geo: [], force: [laneSeg(0, 6, 12, 3, Easing.Linear)] };
    expect(deriveRuns(lanes, 20)[0]!.stations).toEqual([6, 20]);
});

// ── the lane partition against the loaded chain, over the whole fixture corpus ──────────────

/** every committed `.kex` fixture outside the frozen `v2`/`v3` migration inputs and the
 *  deliberately malformed `invariants/*-red` corpus — the documents that actually load. */
function _loadableFixtures(): string[] {
    const root = join(import.meta.dir, "fixtures");
    const out: string[] = [];
    for (const dir of ["", "cli", "force", "invariants", "velocity"]) {
        const abs = dir === "" ? root : join(root, dir);
        if (!existsSync(abs)) continue;
        for (const name of readdirSync(abs)) {
            if (!name.endsWith(".kex") || name.endsWith("-red.kex")) continue;
            out.push(dir === "" ? name : `${dir}/${name}`);
        }
    }
    return out.sort();
}

test("an unpinned end follows the longest lane, past the authored shape", () => {
    // `velocity/past-live-extent.kex` authors a strip out to 46 m over 40 m of force runs. The
    // retired chain ended at 40 and the strip's tail was inert; under the Locked decision the
    // document runs to the last exit on ANY lane, so the derived track reaches 46.
    const doc = parseDocument(
        readFileSync(join(import.meta.dir, "fixtures", "velocity", "past-live-extent.kex"), "utf8"),
    );
    const runs = deriveRuns(doc.lanes, doc.track.end ?? 0);
    expect(runs.map((r) => [r.kind, r.start, r.length])).toEqual([[SectionKind.Force, 0, 46]]);
    expect(Math.max(...doc.lanes.force.map((r) => r.end))).toBe(40);

    // and the tail past the last force exit is a force GAP that DWELLS at that exit (the
    // Locked decision: "the stretch under it bakes as a force gap dwelling at the last exit"),
    // never a hole and never a re-clamp to `DEFAULT_G` by some other route. The 16 m/s velocity
    // span that grew the track authors speed there, not force.
    const run = runs[0]!;
    expect(run.points.at(-1)).toEqual({ s: 40, g: 1, ease: Easing.Cubic });
    const clamped = materializeRunForceClamps(run.points, run.length);
    // the run's own trailing clamp carries the dwell value; its tag governs nothing past the
    // last key, so `materializeRunForceClamps` stamps the neutral Linear.
    expect(clamped.at(-1)).toEqual({ s: 46, g: 1, ease: Easing.Linear });
    // every station across the tail reads the dwell value, not just its two ends.
    // (the curve solve carries a bezier residual, so the dwell is exact to solver precision).
    for (const s of [40, 42, 44, 46]) expect(sampleForce(clamped, s)).toBeCloseTo(1, 12);
    expect(Math.max(...doc.lanes.velocity.map((r) => r.end))).toBe(46);
    expect(doc.lanes.velocity.some((r) => r.exit === 16)).toBe(true);
});

// ── conflict resolution: lane order is priority (spec Validation 10) ─────────────────────────

/** the six permutations of the three lanes, split by which SHAPE lane stands higher. Velocity
 *  never competes for shape, so its rank is the axis the partition must be BLIND to — which is
 *  only readable by iterating it, not by asserting one order. */
const GEO_ABOVE: readonly Lane[][] = [
    [Lane.Geo, Lane.Force, Lane.Velocity],
    [Lane.Geo, Lane.Velocity, Lane.Force],
    [Lane.Velocity, Lane.Geo, Lane.Force],
];
const FORCE_ABOVE: readonly Lane[][] = [
    [Lane.Force, Lane.Geo, Lane.Velocity],
    [Lane.Force, Lane.Velocity, Lane.Geo],
    [Lane.Velocity, Lane.Force, Lane.Geo],
];

describe("conflict resolution: the higher shape lane drives", () => {
    /** the four span cases of the truth table, over the window [10, 20) of a 40 m track. Each
     *  carries a force record at [0, 30) or none, and a geo group at [10, 20) or none, so the
     *  product is spans × order. */
    const cases = {
        both: {
            velocity: [],
            force: [laneSeg(0, 0, 30, 4, Easing.Linear, 1)],
            geo: [geoSeg(5, 10, 20, 0.4)],
        },
        geoOnly: { velocity: [], force: [], geo: [geoSeg(5, 10, 20, 0.4)] },
        forceOnly: { velocity: [], force: [laneSeg(0, 0, 30, 4, Easing.Linear, 1)], geo: [] },
        neither: { velocity: [], force: [], geo: [] },
    } satisfies Record<string, Lanes>;

    /** the partition as (kind, start, length) triples — what "who cuts" is actually visible as. */
    const partition = (lanes: Lanes, order: readonly Lane[]) =>
        deriveRuns(lanes, 40, order).map((r) => [r.kind, r.start, r.length]);

    test("velocity's rank changes nothing in the partition, in either shape order", () => {
        // the axis the instrument must be blind to. Iterated, not assumed: a `deriveRuns` that
        // read `order[0]` alone would pass a single-order arm and fail here.
        for (const [name, lanes] of Object.entries(cases)) {
            for (const group of [GEO_ABOVE, FORCE_ABOVE]) {
                const first = partition(lanes, group[0]!);
                for (const order of group.slice(1))
                    expect(partition(lanes, order), `${name} @ ${order}`).toEqual(first);
            }
        }
    });

    test("the truth table: cuts follow the higher shape lane", () => {
        const geoUp = GEO_ABOVE[0]!;
        const forceUp = FORCE_ABOVE[0]!;
        // both lanes span the window: whoever is higher owns it, and the other lane's stretch
        // there is not read. This pair is the live foil — the same document, two orders.
        expect(partition(cases.both, geoUp)).toEqual([
            [SectionKind.Force, 0, 10],
            [SectionKind.Geo, 10, 10],
            [SectionKind.Force, 20, 20],
        ]);
        expect(partition(cases.both, forceUp)).toEqual([[SectionKind.Force, 0, 40]]);
        // one lane only: the lane that has a span drives it whatever the order says, because
        // priority resolves a conflict and there is none.
        for (const order of [geoUp, forceUp]) {
            expect(partition(cases.geoOnly, order)).toEqual([
                [SectionKind.Force, 0, 10],
                [SectionKind.Geo, 10, 10],
                [SectionKind.Force, 20, 20],
            ]);
            expect(partition(cases.forceOnly, order)).toEqual([[SectionKind.Force, 0, 40]]);
            // neither lane: the track is still well-defined — one force run dwelling at the
            // last exit (`DEFAULT_G` before any), never a hole.
            expect(partition(cases.neither, order)).toEqual([[SectionKind.Force, 0, 40]]);
        }
    });

    test("the driven lane's records survive intact and are simply not read under a cut", () => {
        const before = structuredClone(cases.both);
        const geoRuns = deriveRuns(cases.both, 40, GEO_ABOVE[0]!);
        const forceRuns = deriveRuns(cases.both, 40, FORCE_ABOVE[0]!);
        // authoring is never rewritten by the partition — the driven record is still there.
        expect(cases.both).toEqual(before);
        // under geo-above, the force record is driven across [10, 20): its id appears in the
        // two force windows either side and in no run covering the geo group.
        const covering = geoRuns.find((r) => r.kind === SectionKind.Geo)!;
        expect(covering.segmentIds).toEqual([5]);
        expect(geoRuns.filter((r) => r.segmentIds.includes(0)).map((r) => r.start)).toEqual([
            0, 20,
        ]);
        // swap the order and the driven stretch moves to the OTHER lane: the geo record is now
        // read by nothing at all, and the force record spans the whole track unbroken.
        expect(forceRuns.flatMap((r) => r.segmentIds)).toEqual([0]);
        expect(forceRuns.some((r) => r.kind === SectionKind.Geo)).toBe(false);
    });
});

// ── the two S2d repairs, each with its own arm (spec S2d punch list item 4) ──────────────────

test("a geo record whose entry law is undefined keeps an undefined entry when the window cuts it", () => {
    // the geo lane yields to force across a gap, so a geo record opening off one has NO entry
    // law: the heading it starts from is whatever the incoming march arrives with. A force
    // group above it cuts the record, and the cut must not mint a flat owned entry at the exit
    // value — that would author a straight stretch in place of the ramp the run bakes.
    const lanes: Lanes = {
        velocity: [],
        force: [laneSeg(0, 0, 12, 2, Easing.Linear, 2)],
        geo: [geoSeg(7, 6, 30, 0.5)],
    };
    const runs = deriveRuns(lanes, 30, [Lane.Force, Lane.Geo, Lane.Velocity]);
    const geoRun = runs.find((r) => r.kind === SectionKind.Geo)!;
    // the record is cut at 12 (the force group's end) and opens the geo run there owning
    // nothing, so the run publishes only its exit key and `evalPitch` seeds at the march's own
    // incoming heading.
    expect(geoRun.start).toBe(12);
    expect(geoRun.points).toEqual([{ s: 18, g: 0.5, ease: Easing.Linear }]);
});

test("an authored discontinuity survives a run boundary as two keys, not one", () => {
    // the repair's own arm, at the composition site: the derived run — not `lanePoints` in
    // isolation — must publish both the predecessor's owned exit and the successor's owned
    // entry at the shared station.
    const lanes: Lanes = {
        velocity: [],
        geo: [],
        force: [laneSeg(0, 0, 10, 2, Easing.Linear, 1), laneSeg(1, 10, 20, 5, Easing.Linear, -3)],
    };
    const pts = deriveRuns(lanes, 20)[0]!.points;
    expect(pts.filter((p) => p.s === 10).map((p) => p.g)).toEqual([2, -3]);
    // …and where the successor's entry AGREES with the predecessor's exit there is no step, so
    // the station keeps its single key — the two-key form is the discontinuity, not the norm.
    const flush: Lanes = {
        velocity: [],
        geo: [],
        force: [laneSeg(0, 0, 10, 2, Easing.Linear, 1), laneSeg(1, 10, 20, 5, Easing.Linear, 2)],
    };
    expect(deriveRuns(flush, 20)[0]!.points.filter((p) => p.s === 10)).toHaveLength(1);
});
