import { expect, test } from "bun:test";
import { State } from "@dylanebert/shallot";
import { Easing, forceProfile, type ForcePoint, resolveStep } from "../src/profile";
import {
    rebuildForceProjection,
    rebuildRunProjection,
    rebuildSectionProjection,
    rebuildSegmentProjection,
} from "../src/projection";
import {
    addNode,
    authoredHash,
    createForcePoint,
    createSection,
    createTrack,
    Force,
    ForceBoundary,
    forceDense,
    Handle,
    materializeRunForceClamps,
    sectionForces,
    sectionHandles,
    Segment,
    SectionKind,
    setForceEase,
    setForcePoint,
    setSectionLength,
    runToken,
    sectionToken,
    sections,
    TrackStart,
} from "../src/track";

test("section compatibility rows are a pure projection of canonical segments", () => {
    const ecs = new State();
    createTrack(ecs);
    const first = createSection(ecs, 0, SectionKind.Force, 20);
    createSection(ecs, 1, SectionKind.Geo, 0);
    expect(rebuildSectionProjection(ecs)).toEqual(rebuildSegmentProjection(ecs));

    setSectionLength(ecs, first, 31);
    expect(rebuildSectionProjection(ecs)).toEqual(rebuildSegmentProjection(ecs));
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
