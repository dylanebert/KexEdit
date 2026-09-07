import { expect, spyOn, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadDocument, parseDocument } from "../src/doc";
import { State } from "@dylanebert/shallot";
import { Easing, forceProfile, type ForcePoint, resolveStep } from "../src/profile";
import * as projection from "../src/projection";
import type { LaneSegment, Lanes } from "../src/lanes";
import {
    deriveRuns,
    rebuildForceProjection,
    rebuildRunProjection,
    rebuildSectionProjection,
    rebuildSegmentProjection,
} from "../src/projection";
import {
    addNode,
    authoredHash,
    BakeSystem,
    createForcePoint,
    createSection,
    createTrack,
    Force,
    ForceBoundary,
    forceDense,
    Handle,
    materializeRunForceClamps,
    RunEntryForceBoundary,
    sectionForces,
    sectionHandles,
    Segment,
    SectionKind,
    setForceEase,
    setForcePoint,
    setSectionLength,
    runToken,
    sectionToken,
    sectionWindows,
    sections,
    trackDs,
    TrackStart,
} from "../src/track";

test("section compatibility rows are a pure projection of total runs", () => {
    const ecs = new State();
    createTrack(ecs);
    const first = createSection(ecs, 0, SectionKind.Force, 20);
    createSection(ecs, 1, SectionKind.Geo, 0);
    expect(rebuildSectionProjection(ecs)).toEqual(rebuildRunProjection(ecs));

    setSectionLength(ecs, first, 31);
    expect(rebuildSectionProjection(ecs)).toEqual(rebuildRunProjection(ecs));
    expect(rebuildSegmentProjection(ecs)[0]?.length).toBe(31);
});

test("run rows start row-identical and merge contiguous canonical segments by stable identity", () => {
    const ecs = new State();
    createTrack(ecs);
    const first = createSection(ecs, 0, SectionKind.Force, 12);
    const second = createSection(ecs, 1, SectionKind.Force, 8);

    expect(rebuildRunProjection(ecs)).toEqual(
        rebuildSegmentProjection(ecs).map((row) => ({
            ...row,
            segmentIds: [row.id],
            stations: [0, row.length],
        })),
    );

    const projected = rebuildSegmentProjection(ecs);
    const firstEid = projected.find((row) => row.id === first)!.eid;
    const secondEid = projected.find((row) => row.id === second)!.eid;
    Segment.run.set(secondEid, first);
    Segment.runStation.set(secondEid, 12);
    Segment.runExtent.set(firstEid, 20);
    expect(rebuildRunProjection(ecs)).toEqual([
        {
            eid: rebuildSegmentProjection(ecs)[0]!.eid,
            id: first,
            order: 0,
            kind: SectionKind.Force,
            length: 20,
            segmentIds: [first, second],
            stations: [0, 12, 20],
        },
    ]);
});

test("canonical structural identity owns track start and stable payload membership", () => {
    const ecs = new State();
    const track = createTrack(ecs);
    expect(TrackStart.id.get(track)).toBe(0);
    const geo = createSection(ecs, 0, SectionKind.Geo, 0);
    const force = createSection(ecs, 1, SectionKind.Force, 20);
    addNode(ecs, geo, 0, 0);
    const handle = sectionHandles(ecs, geo)[0]!;
    const pointId = createForcePoint(ecs, force, 0, 1);
    const point = sectionForces(ecs, force).find((row) => row.id === pointId)!;
    expect(Handle.segment.get(handle)).toBe(geo);
    expect(Force.segment.get(point.eid)).toBe(force);
});

test("force compatibility rows derive value and easing from the boundary owner", () => {
    const ecs = new State();
    createTrack(ecs);
    const segment = createSection(ecs, 0, SectionKind.Force, 20);
    const id = createForcePoint(ecs, segment, 7, 2, Easing.Linear);
    const eid = sectionForces(ecs, segment)[0]!.eid;

    expect(rebuildForceProjection(ecs)).toEqual([
        { eid, segment, id, s: 7, g: 2, ease: Easing.Linear },
    ]);
    setForcePoint(ecs, id, 8, 3);
    setForceEase(ecs, id, Easing.Quintic);
    expect(ForceBoundary.g.get(eid)).toBe(3);
    expect(ForceBoundary.ease.get(eid)).toBe(Easing.Quintic);
    expect(rebuildForceProjection(ecs)[0]).toMatchObject({ s: 8, g: 3, ease: Easing.Quintic });
});

test("named run-entry boundary follows the existing force row through its lifecycle", () => {
    const ecs = new State();
    createTrack(ecs);
    const run = createSection(ecs, 0, SectionKind.Force, 20);
    expect(RunEntryForceBoundary.g(ecs, run)).toBeUndefined();
    const id = createForcePoint(ecs, run, 0, 2, Easing.Linear);
    expect(RunEntryForceBoundary.g(ecs, run)).toBe(2);
    expect(RunEntryForceBoundary.ease(ecs, run)).toBe(Easing.Linear);
    setForcePoint(ecs, id, 3, 4);
    expect(RunEntryForceBoundary.g(ecs, run)).toBeUndefined();
    setForcePoint(ecs, id, 0, 5);
    setForceEase(ecs, id, Easing.Quintic);
    expect(RunEntryForceBoundary.g(ecs, run)).toBe(5);
    expect(RunEntryForceBoundary.ease(ecs, run)).toBe(Easing.Quintic);
});

test("multi-run dense and section-force reads never rebuild the run projection", () => {
    const ecs = new State();
    createTrack(ecs);
    const first = createSection(ecs, 0, SectionKind.Force, 20);
    const second = createSection(ecs, 1, SectionKind.Force, 12);
    createForcePoint(ecs, first, 0, 2, Easing.Linear);
    createForcePoint(ecs, first, 10, -1, Easing.Cubic);
    createForcePoint(ecs, second, 0, 3, Easing.Quintic);
    createForcePoint(ecs, second, 8, 1, Easing.Linear);
    const rebuild = spyOn(projection, "rebuildRunProjection");
    try {
        const a = forceDense(ecs, [first], [0, 20], 20, resolveStep(20, 0.5));
        const b = forceDense(ecs, [second], [0, 12], 12, resolveStep(12, 0.5));
        expect(a.length).toBeGreaterThan(0);
        expect(b.length).toBeGreaterThan(0);
        expect(sectionForces(ecs, first).map((row) => row.s)).toEqual([0, 10]);
        expect(sectionForces(ecs, second).map((row) => row.s)).toEqual([0, 8]);
        expect(rebuild).toHaveBeenCalledTimes(0);
    } finally {
        rebuild.mockRestore();
    }
});

test("run-edge clamp materialization is bit-exact over the force boundary corpus", () => {
    const length = 20;
    const step = resolveStep(length, 0.37);
    const cases: Array<{ name: string; points: ForcePoint[] }> = [
        { name: "keyless", points: [] },
        { name: "single start", points: [{ s: 0, g: 2, ease: Easing.Cubic }] },
        { name: "single interior", points: [{ s: 7, g: -1, ease: Easing.Quintic }] },
        { name: "single terminal", points: [{ s: length, g: 3, ease: Easing.Linear }] },
        {
            name: "two key",
            points: [
                { s: 3, g: -2, ease: Easing.Cubic },
                { s: 16, g: 4, ease: Easing.Quintic },
            ],
        },
        {
            name: "adjacent key",
            points: [
                { s: 8, g: 0, ease: Easing.Linear },
                { s: 8.37, g: 5, ease: Easing.Cubic },
            ],
        },
        {
            name: "sub-MIN_FORCE_LEN spacing",
            points: [
                { s: 9, g: -3, ease: Easing.Quintic },
                { s: 9.000001, g: 6, ease: Easing.Linear },
            ],
        },
        ...([Easing.Linear, Easing.Cubic, Easing.Quintic] as const).map((ease) => ({
            name: `easing ${Easing[ease]}`,
            points: [
                { s: 2, g: -1, ease },
                { s: 11, g: 4, ease: Easing.Linear },
                { s: 18, g: 0, ease: Easing.Linear },
            ],
        })),
    ];

    for (const { name, points } of cases) {
        const before = forceProfile(points, step);
        const after = forceProfile(materializeRunForceClamps(points, length), step);
        expect(new Uint32Array(after.buffer), name).toEqual(new Uint32Array(before.buffer));
    }
});

test("conserved f32-hostile frame keeps gathered stations, step, and dense profile bit-exact", () => {
    const ecs = new State();
    createTrack(ecs);
    const extent = Math.fround(63.13367462158203);
    const stations = [0, Math.fround(8.469388961791992), Math.fround(62.8066291809082), extent];
    const ids = stations
        .slice(0, -1)
        .map((station, order) =>
            createSection(
                ecs,
                order,
                SectionKind.Force,
                Math.fround(stations[order + 1]! - station),
            ),
        );
    const projected = rebuildSegmentProjection(ecs);
    projected.forEach((row, i) => {
        Segment.run.set(row.eid, ids[0]!);
        Segment.runStation.set(row.eid, stations[i]!);
    });
    Segment.runExtent.set(projected[0]!.eid, extent);
    createForcePoint(ecs, ids[0]!, 1.1, 2, Easing.Cubic);
    createForcePoint(ecs, ids[1]!, 20.2, -1, Easing.Quintic);
    createForcePoint(ecs, ids[2]!, 0.17, 4, Easing.Linear);

    const run = rebuildRunProjection(ecs)[0]!;
    expect(run.stations).toEqual(stations);
    expect(run.length).toBe(extent);
    const step = resolveStep(run.length, 0.5);
    expect(step).toEqual(resolveStep(extent, 0.5));
    const expectedPoints: ForcePoint[] = [
        { s: stations[0]! + 1.1, g: 2, ease: Easing.Cubic },
        { s: stations[1]! + 20.2, g: -1, ease: Easing.Quintic },
        { s: stations[2]! + 0.17, g: 4, ease: Easing.Linear },
    ];
    const expected = forceProfile(materializeRunForceClamps(expectedPoints, extent), step);
    const actual = forceDense(ecs, run.segmentIds, run.stations, run.length, step);
    expect(new Uint32Array(actual.buffer)).toEqual(new Uint32Array(expected.buffer));

    // Relevant perturbation proof: reconstructing entries from independently rounded durations
    // moves the third gathered station and therefore at least one dense f32 sample.
    const reconstructed = [0];
    for (const row of projected.slice(0, -1))
        reconstructed.push(Math.fround(reconstructed.at(-1)! + row.length));
    const perturbed = forceDense(ecs, run.segmentIds, reconstructed, run.length, step);
    expect(new Uint32Array(perturbed.buffer)).not.toEqual(new Uint32Array(expected.buffer));
});

test("run content hashes retain the single-member cardinality floor", () => {
    const ecs = new State();
    createTrack(ecs);
    const id = createSection(ecs, 0, SectionKind.Force, 20);
    createForcePoint(ecs, id, 4, 2, Easing.Quintic);
    expect(runToken(ecs, id)).toBe(sectionToken(ecs, sections(ecs)[0]!));
});

test("a segment-only extent edit invalidates the authored bake hash", () => {
    const ecs = new State();
    createTrack(ecs);
    const id = createSection(ecs, 0, SectionKind.Force, 20);
    const before = authoredHash(ecs);
    setSectionLength(ecs, id, 25);
    expect(authoredHash(ecs)).not.toBe(before);
});

// ── deriveRuns: the lane → evaluator partition ──────────────────────────────────────────────

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
        geo: [laneSeg(0, 0, 5, 0), laneSeg(1, 5, 12, 0), laneSeg(2, 20, 26, 0)],
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
    const lanes: Lanes = { velocity: [], force: [], geo: [laneSeg(7, 0, 10, 0)] };
    const runs = deriveRuns(lanes, 25);
    expect(runs.map((r) => [r.kind, r.start, r.length])).toEqual([
        [SectionKind.Geo, 0, 10],
        [SectionKind.Force, 10, 15],
    ]);
    expect(runs[1]!.segmentIds).toEqual([]);
    expect(runs[1]!.points).toEqual([]);
    expect(runs[1]!.id).toBeGreaterThan(7);
    expect(runs[1]!.stations).toEqual([0, 15]);
});

test("a pinned end extends the trailing force run; follow reads the longest lane", () => {
    const lanes: Lanes = {
        velocity: [laneSeg(3, 0, 40, 12)],
        force: [],
        geo: [laneSeg(0, 0, 9, 0)],
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
        { s: 10, g: -1, ease: Easing.Cubic },
        { s: 14, g: 4, ease: Easing.Cubic },
    ]);
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
        geo: [laneSeg(0, 0, a, 0), laneSeg(1, a, b, 0), laneSeg(2, b, 44, 0)],
    };
    const run = deriveRuns(lanes, 0)[0]!;
    expect(run.stations).toEqual([0, a, b, 44]);
    expect(run.length).toBe(44);
});

// ── the lane partition against the loaded chain, over the whole fixture corpus ──────────────

/** every committed `.kex` fixture outside the frozen `v2`/`v3` migration inputs and the
 *  deliberately malformed `invariants/*-red` corpus — the documents that actually load. */
function loadableFixtures(): string[] {
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
});

test("derived lane runs reproduce the loaded chain's geometry partition and force profile", () => {
    const names = loadableFixtures();
    // pin the population: a narrowed scan must not pass as a clean sweep.
    expect(names.length).toBeGreaterThanOrEqual(24);
    for (const name of names) {
        const text = readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
        const state = new State();
        state.addSystem(BakeSystem);
        loadDocument(state, text);
        state.step(0);

        const doc = parseDocument(text);
        const derived = deriveRuns(doc.lanes, doc.track.end ?? 0);
        const windows = sectionWindows(state);
        const chainRuns = rebuildRunProjection(state);
        const ds = trackDs(state);

        // Geo runs are the lanes' own maximal abutting groups, so they survive one-for-one at
        // the chain's own offsets and derived lengths. Two ADJACENT force runs carry no authored
        // seam in the lane model (the Locked decision derives the union chain), so they merge —
        // which is why the force arm below compares the PROFILE across the merge rather than the
        // partition, and why it is the arm that holds the bake.
        const geo = (kind: number) => kind === SectionKind.Geo;
        expect(
            derived.filter((r) => geo(r.kind)).map((r) => r.start),
            name,
        ).toEqual(
            chainRuns
                .map((r, i) => [r, windows[i]!] as const)
                .filter(([r]) => geo(r.kind))
                .map(([, w]) => w.offset),
        );
        expect(
            derived.filter((r) => geo(r.kind)).map((r) => r.length),
            name,
        ).toEqual(
            chainRuns
                .map((r, i) => [r, windows[i]!] as const)
                .filter(([r]) => geo(r.kind))
                .map(([, w]) => w.len),
        );

        for (const run of derived) {
            if (run.kind !== SectionKind.Force) continue;
            const covered = chainRuns
                .map((r, i) => ({ r, w: windows[i]! }))
                .filter(
                    ({ r, w }) =>
                        r.kind === SectionKind.Force &&
                        w.offset >= run.start &&
                        w.offset < run.start + run.length,
                );
            const want: number[] = [];
            for (const { r } of covered) {
                const dense = forceDense(
                    state,
                    r.segmentIds,
                    r.stations,
                    r.length,
                    resolveStep(r.length, ds),
                );
                want.push(...dense);
            }
            const got = forceProfile(
                materializeRunForceClamps(run.points, run.length),
                resolveStep(run.length, ds),
            );
            // Compare over the CHAIN's own extent. A lane may reach past it — an unpinned end
            // follows the longest lane (Locked decision), and `velocity/past-live-extent.kex`
            // has a strip beyond the authored shape — and that tail is new track the retired
            // chain never baked, so it is outside what a bake-identity comparison can say.
            expect(
                Array.from(got.subarray(0, want.length)),
                `${name} force run at ${run.start}`,
            ).toEqual(want);
        }
    }
});
