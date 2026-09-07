import { describe, expect, test } from "bun:test";
import type { State } from "@dylanebert/shallot";
import { convertDomain, convertFailed, convertible, pickable } from "../src/domain";
import { createHistory, redo, undo } from "../src/history";
import { Domain } from "../src/section";
import { Lane } from "../src/lanes";
import { bakeOut, laneRows, snapshotAll, trackDomain } from "../src/track";
import { build, type Build } from "./helpers/build";

// `domain.convertDomain` — the ruler-menu pick, as a track-global command. S6 ("Domain: arclength
// is canonical, time is a lens") retired the old document-conversion op: `Track.domain` is a
// VIEW now, not a unit the store holds — every force keyframe, extent, strip and strip keyframe
// stays in meters of arclength always, so a flip writes exactly one column
// (`Track.domain`) and nothing else. This suite is split by what it pins:
//
//   1. guards — no live bake, a stale bake, the already-active domain — plus `convertible`/
//      `pickable`, the ruler menu's row-enablement rule over the same reading;
//   2. § Validation (a) — a flip leaves every authored component byte-identical and the bake
//      hash unchanged, RED on the pre-S6 tree (the old carry wrote new keyframes and rewrote
//      `Force.s`/extents/strips, and `bakeHash` suffixed a non-Distance domain);
//   3. § Validation (b) — a Meters→Seconds→Meters round trip, off `domain.lab.ts`'s own fixtures,
//      lands EXACTLY 0 world-exit deviation — the lab's reported 0.03–0.53 m band no longer
//      reproduces, by construction rather than by tolerance;
//   4. undo/redo — one entry, byte-identical either direction, selection untouched (nothing was
//      ever destroyed to begin with, unlike the old carry's respawned keyframes);
//   5. degeneracies the old carry used to reject on (a stalled ride, a keyframe past the baked
//      span) no longer have anything to reject — the flip doesn't read the table at all.
//
// the shared authoring builder: every fixture below is authored through the shared `Build` helper
// (`tests/helpers/build.ts`), the S2e-i lane setters.

/** a force-only track over `[0, len)`, whose adjacent records reach the values in `pts` — the
 *  lane spelling of a force run's keyframe list, one record per interval. */
function forceTrack(
    len: number,
    pts: readonly [number, number][],
): { state: State; eid: number; sec: number; bd: Build } {
    const bd = build();
    let sec = -1;
    if (pts.length < 2) sec = bd.force(0, len, pts[0]?.[1] ?? 1);
    else
        for (let i = 0; i + 1 < pts.length; i++) {
            const id = bd.force(pts[i]![0], pts[i + 1]![0], pts[i]![1], pts[i + 1]![1]);
            if (i === 0) sec = id;
        }
    bd.bake();
    return { state: bd.ecs, eid: bd.trackEid, sec, bd };
}

/** the force lane's own boundary stations — the lane spelling of the retired keyframe list. */
const kfs = (state: State): number[] => {
    const rows = laneRows(state, Lane.Force);
    return rows.length === 0 ? [] : [rows[0]!.start, ...rows.map((r) => r.end)];
};

describe("guards", () => {
    test("no live bake rejects: nothing written, nothing recorded", () => {
        const bd = build();
        bd.force(0, 40, 1);
        const state = bd.ecs;
        const h = createHistory();

        // never stepped — `bakeLive` is false, so there is nothing to display a Time reading
        // through yet.
        expect(convertDomain(h, state, Domain.Time)).toBe(false);
        expect(trackDomain(state)).toBe(Domain.Distance);
        expect(kfs(state)).toEqual([0, 40]);
        expect(h.undo.length).toBe(0);
    });

    test("a bake that went stale under an edit rejects too", () => {
        const { state, sec, bd } = forceTrack(40, [
            [0, 1],
            [40, 1],
        ]);
        const h = createHistory();
        bd.handle(sec, "exit", 1.2); // authored past the last bake, not re-baked yet
        expect(convertDomain(h, state, Domain.Time)).toBe(false);
        expect(trackDomain(state)).toBe(Domain.Distance);
        expect(h.undo.length).toBe(0);
    });

    test("the already-active domain is a no-op: nothing written, nothing recorded", () => {
        const { state } = forceTrack(40, [
            [0, 1],
            [40, 1],
        ]);
        const h = createHistory();
        expect(convertDomain(h, state, Domain.Distance)).toBe(false);
        expect(h.undo.length).toBe(0);
    });

    test("convertible reads the same liveness gate a flip itself checks", () => {
        const bd = build();
        bd.force(0, 40, 1);
        const state = bd.ecs;
        expect(convertible(state)).toBe(false); // never baked
        bd.bake();
        expect(convertible(state)).toBe(true);
    });

    test("pickable: the active row is always enabled, the inactive row follows convertible", () => {
        const bd = build();
        bd.force(0, 40, 1);
        const state = bd.ecs;
        // unbaked: the active (Distance) row is still pickable (a no-op pick), the other isn't.
        expect(pickable(state, Domain.Distance)).toBe(true);
        expect(pickable(state, Domain.Time)).toBe(false);
        bd.bake();
        expect(pickable(state, Domain.Time)).toBe(true);
    });

    test("convertFailed shapes a notice + a raw detail for the console", () => {
        const { notice, detail } = convertFailed(new Error("boom"));
        expect(notice).toBe("The units could not be switched. Nothing changed.");
        expect(detail).toContain("boom");
    });
});

describe("a flip is a pure view write (§ Validation a)", () => {
    const DiveAndRecover: [number, [number, number][]] = [
        40,
        [
            [0, 1],
            [20, 0.4],
            [40, 1],
        ],
    ];
    const MultiGPull: [number, [number, number][]] = [
        24,
        [
            [0, 1],
            [11.5, 4],
            [12.5, 4],
            [24, 1],
        ],
    ];

    for (const [len, pts] of [DiveAndRecover, MultiGPull]) {
        test(`leaves every authored component byte-identical, len=${len}`, () => {
            const { state, bd } = forceTrack(len, pts);
            bd.velocity(len * 0.1, len * 0.3, 5);
            bd.bake();
            const before = snapshotAll(state);
            const h = createHistory();
            expect(convertDomain(h, state, Domain.Time)).toBe(true);
            state.step(0);
            const after = snapshotAll(state);
            expect(after).toEqual(before); // deep structural equality — every field, every row

            const back = createHistory();
            expect(convertDomain(back, state, Domain.Distance)).toBe(true);
            state.step(0);
            expect(snapshotAll(state)).toEqual(before);
        });

        test(`leaves the bake hash untouched, len=${len}`, () => {
            const { state, eid, bd } = forceTrack(len, pts);
            bd.velocity(len * 0.1, len * 0.3, 5);
            bd.bake();
            const distanceHash = bakeOut.get(eid)?.hash;
            const h = createHistory();
            convertDomain(h, state, Domain.Time);
            state.step(0);
            expect(bakeOut.get(eid)?.hash).toBe(distanceHash);
        });
    }
});

describe("undo/redo", () => {
    test("one undo entry per flip, byte-identical either direction", () => {
        const { state } = forceTrack(40, [
            [0, 1],
            [40, 1],
        ]);
        const before = snapshotAll(state);
        const h = createHistory();
        convertDomain(h, state, Domain.Time);
        expect(h.undo.length).toBe(1);
        expect(trackDomain(state)).toBe(Domain.Time);

        undo(h, state);
        expect(trackDomain(state)).toBe(Domain.Distance);
        expect(snapshotAll(state)).toEqual(before);

        redo(h, state);
        expect(trackDomain(state)).toBe(Domain.Time);
        expect(snapshotAll(state)).toEqual(before); // the store never moved either way
    });
});

describe("degeneracies the old carry used to reject on", () => {
    test("a stalled ride still flips — the flip never reads the table", () => {
        const { state } = forceTrack(6, [[0, 1.2]]); // sustained 1.2 g drains to a stall
        const h = createHistory();
        expect(convertDomain(h, state, Domain.Time)).toBe(true);
        expect(trackDomain(state)).toBe(Domain.Time);
    });

    test("an interior force boundary still flips, untouched", () => {
        const { state, sec } = forceTrack(40, [
            [0, 1],
            [30, 1.5],
            [40, 1],
        ]);
        void sec;
        const before = snapshotAll(state);
        const h = createHistory();
        expect(convertDomain(h, state, Domain.Time)).toBe(true);
        state.step(0);
        expect(snapshotAll(state)).toEqual(before);
    });

    test("adjacent velocity records still flip, untouched", () => {
        const { state, bd } = forceTrack(40, [
            [0, 1],
            [40, 1],
        ]);
        bd.velocity(5, 10, 6, 8);
        bd.velocity(10, 15, 8, 10);
        bd.bake();
        const before = snapshotAll(state);
        const h = createHistory();
        expect(convertDomain(h, state, Domain.Time)).toBe(true);
        state.step(0);
        expect(snapshotAll(state)).toEqual(before);
    });
});
