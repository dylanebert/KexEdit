import { expect, test } from "bun:test";
import { State } from "@dylanebert/shallot";
import {
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
    Handle,
    sectionForces,
    sectionHandles,
    Segment,
    SectionKind,
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

test("a segment-only extent edit invalidates the authored bake hash", () => {
    const ecs = new State();
    createTrack(ecs);
    const id = createSection(ecs, 0, SectionKind.Force, 20);
    const before = authoredHash(ecs);
    setSectionLength(ecs, id, 25);
    expect(authoredHash(ecs)).not.toBe(before);
});
