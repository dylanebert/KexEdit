import { expect, test } from "bun:test";
import type { Selection } from "../src/editor";
import { type Candidate, hits, merge, normRect } from "../src/marquee";

// the pure marquee module: rect normalization, point-in-rect hit collection, and the
// replace/toggle merge of the hit set into a selection. device-free — no ECS, no DOM. the merge
// reuses the substrate's `toggleMember` for its promotion rule, so these pin the marquee's own
// geometry + mode logic; the set/promotion semantics themselves are pinned in editor.test.ts.

const sel = (ids: number[], active: number | null): Selection => ({ ids: new Set(ids), active });

// ── rect normalization: any drag direction yields the same min/max box ──

test("normRect normalizes all four drag quadrants to the same box", () => {
    const box = { minX: 10, minY: 20, maxX: 30, maxY: 40 };
    expect(normRect(10, 20, 30, 40)).toEqual(box); // ↘ top-left → bottom-right
    expect(normRect(30, 40, 10, 20)).toEqual(box); // ↖ bottom-right → top-left
    expect(normRect(30, 20, 10, 40)).toEqual(box); // ↙ top-right → bottom-left
    expect(normRect(10, 40, 30, 20)).toEqual(box); // ↗ bottom-left → top-right
});

// ── hit collection: inside, outside, boundary (inclusive) ──

const candidates: Candidate[] = [
    { id: 1, x: 5, y: 5 }, // outside (left/above)
    { id: 2, x: 15, y: 25 }, // inside
    { id: 3, x: 10, y: 20 }, // on the min corner — inclusive
    { id: 4, x: 30, y: 40 }, // on the max corner — inclusive
    { id: 5, x: 31, y: 25 }, // outside (just past maxX)
];

test("hits collects the ids inside the rect, boundary inclusive, in candidate order", () => {
    const rect = normRect(10, 20, 30, 40);
    expect(hits(rect, candidates)).toEqual([2, 3, 4]);
});

test("hits returns nothing for a rect over empty space", () => {
    expect(hits(normRect(100, 100, 200, 200), candidates)).toEqual([]);
});

// ── replace merge: the hit set becomes the selection, last member active ──

test("replace merge: the hit set replaces the selection, its last member active", () => {
    expect(merge(sel([9], 9), [2, 3, 4], "replace")).toEqual({ ids: [2, 3, 4], active: 4 });
});

test("replace merge with an empty hit set clears the selection (deselect-all)", () => {
    expect(merge(sel([9, 8], 8), [], "replace")).toEqual({ ids: [], active: null });
});

// ── toggle merge (shift+marquee): each hit toggles against the current set ──

test("toggle merge: an out-of-set hit is added and becomes active; an in-set hit is removed", () => {
    // current {1,2} active 2. hits [2,3]: 2 is in-set → removed; 3 is out-of-set → added, active.
    expect(merge(sel([1, 2], 2), [2, 3], "toggle")).toEqual({ ids: [1, 3], active: 3 });
});

test("toggle merge removing the active promotes the most-recently-added survivor", () => {
    // current {1,2,3} active 3. hit [3] removes the active → promote the last survivor (2).
    expect(merge(sel([1, 2, 3], 3), [3], "toggle")).toEqual({ ids: [1, 2], active: 2 });
});

test("toggle merge with an empty hit set leaves the selection unchanged", () => {
    expect(merge(sel([1, 2], 2), [], "toggle")).toEqual({ ids: [1, 2], active: 2 });
});

test("merge does not mutate the input selection", () => {
    const current = sel([1, 2], 2);
    merge(current, [2, 3], "toggle");
    expect([...current.ids]).toEqual([1, 2]);
    expect(current.active).toBe(2);
});
