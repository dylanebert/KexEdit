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
    Handle,
    materializeRunForceClamps,
    sectionForces,
    sectionHandles,
    Segment,
    SectionKind,
    setForceEase,
    setForcePoint,
    setSectionLength,
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
        rebuildSegmentProjection(ecs).map((row) => ({ ...row, segmentIds: [row.id] })),
    );

    const secondEid = rebuildSegmentProjection(ecs).find((row) => row.id === second)!.eid;
    Segment.run.set(secondEid, first);
    expect(rebuildRunProjection(ecs)).toEqual([
        {
            eid: rebuildSegmentProjection(ecs)[0]!.eid,
            id: first,
            order: 0,
            kind: SectionKind.Force,
            length: 20,
            segmentIds: [first, second],
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

test("a segment-only extent edit invalidates the authored bake hash", () => {
    const ecs = new State();
    createTrack(ecs);
    const id = createSection(ecs, 0, SectionKind.Force, 20);
    const before = authoredHash(ecs);
    setSectionLength(ecs, id, 25);
    expect(authoredHash(ecs)).not.toBe(before);
});
