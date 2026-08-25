// kex2d's S2 (kex2d-event-substrate) capture flows — the track-global velocity-span substrate.
// Three arms, one per the spec's own S2 oracle line: a span authored across a section boundary
// drives both sections' override continuously; deleting the section under a span leaves the
// span's stored rows untouched, still driving whatever geometry occupies its window; split and
// join leave every Strip/StripKeyframe row byte-identical. Shared helpers + the `__kex` typed
// hook live in `./flow`.
//
// Setup goes through `addStripAt` (a real guarded write, `history.addStrip`, exposed directly so
// a span lands at an EXACT `[start, end)` the pointer-driven "Add velocity strip" menu can't
// guarantee — it always anchors at the click's min-extent edge and grows toward a default
// length). The BEHAVIOR under test — the bake's own windowed resolution, the structural ops, the
// undo/redo round trip — always runs through the real production path (`BakeSystem`'s per-RAF
// tick, `history.removeSection`/`splitSection`/`joinSections` via the real Cut/Join menu rows).

import { test, expect, kexCall, frameTimeline, clickMenuItem } from "./flow";

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

// a split or join never touches a strip's stored rows — no rebase, no mid-span split into two
// strips, no merge-on-agreement at the seam (all retired, S2 Locked decision: strips are
// track-global and span-blind to structural ops). One force section; a strip whose extent
// straddles the exact station a Cut lands at (the old code's own straddling-strip rebase
// branch); Cut then Join, each checked against the immediately-prior snapshot.
//
// RED-FIRST (quoted from the pre-S2 `splitForce`, same ref, two adjacent real lines):
// `Strip.end.set(st.eid, s);` then `const tailId = createStrip(ecs, bId, 0, st.end - s, st.value);`
// — literally trimming the original row's `end` and spawning a SECOND strip entity for the tail.
// Against that code this arm reds at the post-Cut poll: `stripsOf()` reports two rows sharing the
// original `value`, neither equal to `before`, instead of the untouched original.
test("split and join leave every strip row byte-identical", async ({ page, boot }) => {
    await boot();

    const sectionCount = () => kexCall(page, "sectionCount");
    const stripsOf = () => kexCall(page, "stripsOf", 0);
    const stripKeyframesOf = (id: number) => kexCall(page, "stripKeyframesOf", id);
    const ctxCut = () => kexCall(page, "ctxCut");
    const undoDepth = () => kexCall(page, "undoDepth");

    await kexCall(page, "convertAt", 0);
    await frameTimeline(page);

    // a strip straddling the section's own midpoint — the interior cut below lands inside it.
    const id = (await kexCall(page, "addStripAt", 6, 18, 7)) as number;
    expect(id).not.toBe(null);
    type StripRow = { id: number; start: number; end: number; value: number };
    const snapshot = async (): Promise<{
        strips: StripRow[];
        kfs: { id: number; s: number; v: number }[];
    }> => ({
        strips: ((await stripsOf()) as StripRow[]).sort((a, b) => a.id - b.id),
        kfs: (await stripKeyframesOf(id)) as { id: number; s: number; v: number }[],
    });
    const preCut = await snapshot();
    const stripCountBefore = preCut.strips.length;

    // right-click mid-strip (well inside [6, 18)) → Cut. `ctxCut` is the menu's own resolved
    // landing, read before the row is clicked (`section.pw.ts`'s own "force cut flow" idiom) —
    // asserting against it, not a re-derived pixel→domain guess.
    const clipBox = await page.locator(".clip").first().boundingBox();
    if (!clipBox) throw new Error("force clip not laid out");
    const cx = clipBox.x + clipBox.width * 0.5;
    const cy = clipBox.y + clipBox.height / 2;
    const before = await undoDepth();
    await page.mouse.click(cx, cy, { button: "right" });
    await expect(page.locator(".ctxmenu")).toBeVisible();
    const cut = await ctxCut();
    if (cut === null) throw new Error("Cut did not resolve a landing position");
    expect(cut.at).toBeGreaterThan(6);
    expect(cut.at).toBeLessThan(18);
    await expect(page.locator(".ctxmenu").getByRole("menuitem", { name: "Cut" })).toBeEnabled();
    await clickMenuItem(page, ".ctxmenu", "Cut");
    await expect.poll(sectionCount).toBe(2);
    await expect.poll(undoDepth).toBe(before + 1);

    const postCut = await snapshot();
    expect(postCut.strips.length).toBe(stripCountBefore); // no new strip spawned
    expect(postCut).toEqual(preCut); // every row (start/end/value + keyframes), byte-identical

    // Join the two force sections back — the same byte-identical law, checked against the
    // immediately-prior (post-Cut) snapshot.
    const preJoin = postCut;
    await page.locator(".clip").nth(0).click();
    await page
        .locator(".clip")
        .nth(1)
        .click({ modifiers: ["Shift"] });
    await page.locator(".clip").nth(0).click({ button: "right" });
    await expect(page.locator(".ctxmenu")).toBeVisible();
    await expect(page.locator(".ctxmenu").getByRole("menuitem", { name: "Join" })).toBeEnabled();
    await clickMenuItem(page, ".ctxmenu", "Join");
    await expect.poll(sectionCount).toBe(1);

    const postJoin = await snapshot();
    expect(postJoin).toEqual(preJoin);
});
