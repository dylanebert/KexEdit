import { describe, expect, test } from "bun:test";
import { forceStationUnion, projectForceRun } from "../src/segment";

describe("force station union", () => {
    test("splits a run at positive-duration key stations and assigns stable ids", () => {
        let next = 100;
        const got = forceStationUnion(
            7,
            10,
            { id: 40, station: 0, value: 1 },
            [
                { id: 41, station: 2.5, value: 2 },
                { id: 42, station: 9, value: 3 },
                { id: 43, station: 10, value: 4 },
            ],
            () => next++,
        );
        expect(got.extent).toBe(10);
        expect(got.members.map((m) => [m.id, m.duration, m.boundary?.id, m.localStation])).toEqual([
            [7, 2.5, 41, 2.5],
            [100, 6.5, 42, 6.5],
            [101, 1, 43, 1],
        ]);
        expect(got.start?.id).toBe(40);
    });

    test("projects exact run-nested station wire without re-summing conserved extent", () => {
        const run = forceStationUnion(
            7,
            Math.fround(10.1),
            undefined,
            [
                { id: 1, station: 3.3, value: 2 },
                { id: 2, station: 7.7, value: 3 },
            ],
            () => 8,
        );
        // Deliberately corrupt the rounded member sum: the compatibility extent remains truth.
        run.members[0].duration = Math.fround(run.members[0].duration);
        run.members[1].duration = Math.fround(run.members[1].duration);
        expect(projectForceRun(run).extent).toBe(Math.fround(10.1));
        expect(projectForceRun(run).points.map((p) => p.station)).toEqual([3.3, 7.7]);
    });

    test("refuses duplicate/non-positive ownership intervals", () => {
        expect(() =>
            forceStationUnion(
                1,
                10,
                undefined,
                [
                    { id: 1, station: 4, value: 1 },
                    { id: 2, station: 4, value: 2 },
                ],
                () => 2,
            ),
        ).toThrow("positive duration");
    });
});
