// kex2d's S2 (kex2d-event-substrate) capture flows — the track-global velocity-span substrate.
// Two arms, one per the spec's own S2 oracle line: a span authored across a section boundary
// drives both sections' override continuously; deleting the section under a span leaves the
// span's stored rows untouched, still driving whatever geometry occupies its window. (A third
// arm proved a split never touches a strip's stored rows — Cut, the split op it drove through,
// and Join, the arm's other former half, both retired end to end by `kex2d-segment-removal` S1/
// S2, leaving no structural split/join op to exercise the property against.) Shared helpers +
// the `__kex` typed hook live in `./flow`.
//
// Setup goes through `addStripAt` (a real guarded write, `history.addStrip`, exposed directly so
// a span lands at an EXACT `[start, end)` the pointer-driven "Add velocity strip" menu can't
// guarantee — it always anchors at the click's min-extent edge and grows toward a default
// length). The BEHAVIOR under test — the bake's own windowed resolution, the structural ops, the
// undo/redo round trip — always runs through the real production path (`BakeSystem`'s per-RAF
// tick, `history.removeSection` for the deletion arm).

import { test, expect, kexCall } from "./flow";

// a track-global velocity span authored across two sections' shared boundary drives BOTH
// sections' override continuously — no seam step in the velocity readback. Two force sections
// (24 m each via the default extent, `stickyLen`), a span straddling their d=24 boundary; the
// bake's own recovered v (`vAtD`) reads the strip's own constant value on both sides.
//
// RED-FIRST: before S2, `Strip.section` pinned this span to whichever ONE section's
// `createStrip` guard it was authored against — an authoring surface with no track-global
// coordinate to straddle a boundary with at all (the min-extent/overlap guards resolved
// per-section). This arm has no pre-S2 analogue to run red against; its witness is the boundary
// reading itself, which S2's `sectionWindows`/`edgeStrips` in-pass resolution is what makes
// possible.
test("velocity span crosses a section boundary continuously", async ({ page, boot }) => {
    await boot();

    const sectionLengths = () => kexCall(page, "sectionLengths");
    const sectionCount = () => kexCall(page, "sectionCount");
    const vAtD = (d: number) => kexCall(page, "vAtD", d);

    // the default seed: one geo section, no strip authored (the track-start one-shot, S3, is a
    // distinct point kind that carries no `Strip` row). Convert to force (strips are untouched
    // by convert, S2) then append a second force section — both take the sticky default extent
    // (24 m, `DEFAULT_FORCE_LEN`), so the shared boundary lands at exactly `sectionLengths()[0]`.
    await kexCall(page, "convertAt", 0);
    await kexCall(page, "append", 1);
    await expect.poll(sectionCount).toBe(2);
    const lens = await sectionLengths();
    const boundary = lens[0];
    expect(boundary).toBeGreaterThan(4); // straddling room on both sides

    // a span straddling the boundary, well clear of the track's own far end.
    const value = 11;
    const id = await kexCall(page, "addStripAt", boundary - 4, boundary + 4, value);
    expect(id).not.toBe(null);

    // the bake recomputes on the next RAF tick — poll until the override lands, then read both
    // sides of the boundary off the SAME settled bake.
    await expect.poll(async () => Math.abs((await vAtD(boundary - 2)) - value) < 0.5).toBe(true);
    const head = await vAtD(boundary - 2); // inside the upstream section's own tail
    const tail = await vAtD(boundary + 2); // inside the downstream section's own head
    expect(Math.abs(head - value)).toBeLessThan(0.5);
    expect(Math.abs(tail - value)).toBeLessThan(0.5);
    expect(Math.abs(head - tail)).toBeLessThan(0.05); // no seam step at the shared boundary
});

// deleting the section a span's window currently overlaps leaves the span's own stored rows
// untouched — the span keeps driving whatever geometry now occupies its (unmoved) track-global
// window. Three force sections [0,24) [24,48) [48,72); a span inside the MIDDLE section's window;
// deleting it shifts the THIRD section up to fill the gap, landing its own window exactly where
// the span already was — so the same span, never rewritten, now drives the third section's
// content instead of the second's.
//
// RED-FIRST (quoted from the pre-S2 `deleteSection`, `git show 3d9b793:kexedit/kex2d/src/track.ts`):
// `for (const st of sectionStrips(ecs, sectionId)) { destroyStripKeyframes(ecs, st.id); ecs.destroy(st.eid); }`
// — every strip whose (then per-section) `Strip.section` matched the deleted section was
// destroyed outright. Against that code this arm reds at the FIRST poll below: `stripsOf()`
// loses the id entirely (`.find` returns `undefined`) rather than reporting it unchanged.
test("deleting the section under a span leaves it untouched, driving the new occupant", async ({
    page,
    boot,
}) => {
    await boot();

    const sectionCount = () => kexCall(page, "sectionCount");
    const stripsOf = () => kexCall(page, "stripsOf", 0);
    const vAtD = (d: number) => kexCall(page, "vAtD", d);

    await kexCall(page, "convertAt", 0);
    await kexCall(page, "append", 1);
    await kexCall(page, "append", 1);
    await expect.poll(sectionCount).toBe(3);

    const value = 9;
    const id = (await kexCall(page, "addStripAt", 30, 40, value)) as number;
    expect(id).not.toBe(null);
    const before = (
        (await stripsOf()) as { id: number; start: number; end: number; value: number }[]
    ).find((s) => s.id === id);
    expect(before).toBeDefined();

    // delete the MIDDLE section (order 1, [24,48) — the span's own window at creation).
    await kexCall(page, "deleteAt", 1);
    await expect.poll(sectionCount).toBe(2);

    // the stored row is byte-identical — never rewritten, never destroyed.
    const after = (
        (await stripsOf()) as { id: number; start: number; end: number; value: number }[]
    ).find((s) => s.id === id);
    expect(after).toEqual(before);

    // the third section shifted up to fill the gap; its own window now lands where the deleted
    // middle section's did (24..48) — the SAME span the deletion left untouched now drives it.
    await expect.poll(async () => Math.abs((await vAtD(35)) - value) < 0.5).toBe(true);
});
