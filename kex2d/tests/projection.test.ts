import { expect, test } from "bun:test";
import { State } from "@dylanebert/shallot";
import { rebuildSectionProjection, rebuildSegmentProjection } from "../src/projection";
import { createSection, createTrack, SectionKind, setSectionLength } from "../src/track";

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
