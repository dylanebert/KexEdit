import { expect, frameTimeline, kexCall, type Page, seedHill, test } from "./flow";

// ── AFFORDANCE ARMS ──────────────────────────────────────────────────────────────────────────
// One axis, one predicate: a surface that PAINTS an interactive cursor must have a handler
// behind it. Nothing else in this harness reads that axis, and that is the whole reason the C5
// band-authoring popover shipped `bun check` 0, `bun test` 1589/0/46 and capture 38/38 while the
// person's verdict was "the popover is jarring and does not work" (kex2d-substrate, feel gate
// 2026-08-20, verdict 5).
//
// THE MECHANISM. `.fld .key` is this app's scrub-handle dress — `cursor: ew-resize`,
// `user-select: none`, `touch-action: none`, a hover wash (`Timeline.svelte`, `.fld .key`).
// Six `.fld .key` spans exist in that file; five wire `onpointerdown` to a scrub (`handleScrub`
// ×2, `scrubStart` ×2, `snapScrub` ×2) and the strip popover's `<span class="key">v</span>`
// wires nothing. Its own comment says so on purpose — "no scrub handle (a strip's value has no
// natural drag axis…)" — but the decision was taken in the markup and not in the CSS, so the
// surface still paints the drag cursor, still lights up on hover, and still swallows the drag.
// It is the one surface in the app that promises a scrub and refuses it, and the promise is the
// only instruction a person has: the other five taught them the gesture.
//
// WHY EVERY GATE WAS GREEN. All of this unit's evidence about the popover is a model read-back.
// `bun test` never mounts the component. The capture flow reaches the field with
// `locator.fill()`, which focuses the element and writes `.value` directly — it issues no
// pointer event and runs no hit test, so it can neither press the key label nor notice that one
// is being advertised; `toBeVisible()` is a layout predicate. The rig for this axis already
// existed one file over (`force.pw.ts` "the `scrubStart` label-scrub button guard") and was
// never pointed at the new surface.
//
// WITNESSED RED at `b77b2ac` (2026-08-21, `KEX_WORKERS=1`), before the `test.fail` annotation:
//     Error: a drag on a key painting ew-resize moves the value
//     expect(received).not.toBeCloseTo(expected, precision)
//     Expected: not 8.752357558882853
// — a 60 px pointer drag across the `v` label, whose computed cursor the arm had already
// asserted is `ew-resize`, left the strip's value bit-identical.
//
// T1/T2 OWN THE FIX, not this arm. When the value surface is rebuilt (T2 retires the popover;
// T1 rebuilds the band), either honour the dress or stop painting it — then DELETE the
// `test.fail` annotation below, which reds as "Expected to fail, but passed" the moment the
// affordance is honoured.

/** the computed cursor a popover key label paints, after a horizontal drag across it */
async function scrubKey(page: Page, keySel: string, dx: number): Promise<string> {
    const key = page.locator(keySel);
    const cursor = await key.evaluate((e) => getComputedStyle(e).cursor);
    const kb = await key.boundingBox();
    if (!kb) throw new Error(`${keySel} not laid out`);
    const cy = kb.y + kb.height / 2;
    await page.mouse.move(kb.x + kb.width / 2, cy);
    await page.mouse.down();
    await page.mouse.move(kb.x + kb.width / 2 + dx, cy, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    return cursor;
}

/** create-drag a velocity strip in the header band and return its seeded value */
async function createStrip(page: Page): Promise<number> {
    const bandBb = await page.locator(".hbandzone").boundingBox();
    const clipBb = await page.locator(".clip").first().boundingBox();
    if (!bandBb || !clipBb) throw new Error("header band / clip not laid out");
    const y = bandBb.y + bandBb.height / 2;
    const x = clipBb.x + clipBb.width * 0.3;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + clipBb.width * 0.2, y, { steps: 10 });
    await page.mouse.up();
    await expect.poll(async () => (await kexCall(page, "stripsOf", 0)).length).toBe(1);
    await expect(page.locator(".striptip")).toHaveCount(1);
    return (await kexCall(page, "stripsOf", 0))[0].value;
}

// CONTROL — green, and it is what makes the inverted arm below non-vacuous in BOTH directions.
// It runs the same rig (`scrubKey`) on the surface that HONOURS the dress, and it runs the
// inverted arm's whole setup (`createStrip`, the `.striptip` presence, the `ew-resize` reading)
// as plain assertions. So a broken rig or a broken strip create reds HERE, where it is legible,
// instead of silently satisfying the `test.fail` next door.
test("popover key scrub affordance — force keyframe control", async ({ page, boot }) => {
    await boot();
    await seedHill(page);
    await kexCall(page, "convert"); // → a FORCE section, so the chart carries authored keyframes
    await kexCall(page, "seedForceBump");
    await expect.poll(async () => (await kexCall(page, "forces")).length).toBe(5);
    await frameTimeline(page);

    const dia = await page.locator(".fpt").nth(2).boundingBox();
    if (!dia) throw new Error("force keyframe 2 not laid out");
    await page.mouse.click(dia.x + dia.width / 2, dia.y + dia.height / 2);
    await expect.poll(async () => (await kexCall(page, "forceSelIds")).length).toBe(1);
    await expect(page.locator(".ptip")).toHaveCount(1);
    const sel = await kexCall(page, "forceSelActive");
    const at = async () => (await kexCall(page, "forceU")).find((p) => p.id === sel)?.g;
    const g0 = await at();
    if (g0 === undefined) throw new Error("selected keyframe not readable");

    const cursor = await scrubKey(page, ".ptip .fld:nth-of-type(2) .key", 40);
    expect(cursor, "the g key paints the scrub cursor").toBe("ew-resize");
    expect(await at(), "a drag on a key painting ew-resize moves the value").not.toBeCloseTo(g0, 6);

    // the inverted arm's setup, asserted where a failure can be read
    await page.keyboard.press("Escape"); // clear the keyframe popover
    await expect(page.locator(".ptip")).toHaveCount(0);
    await createStrip(page);
    expect(
        await page.locator(".striptip .key").evaluate((e) => getComputedStyle(e).cursor),
        "the strip popover's v key paints the scrub cursor",
    ).toBe("ew-resize");
});

// SUBJECT — inverted. Reds ("Expected to fail, but passed") the moment the `v` key honours the
// cursor it paints, which is T1/T2's repair. See the mechanism and the witnessed red above.
test.fail("strip popover key scrub affordance (expected to fail — C5)", async ({ page, boot }) => {
    await boot();
    await seedHill(page);
    await frameTimeline(page);
    const v0 = await createStrip(page);

    const cursor = await scrubKey(page, ".striptip .key", 60);
    expect(cursor, "the v key paints the scrub cursor").toBe("ew-resize");
    expect(
        (await kexCall(page, "stripsOf", 0))[0].value,
        "a drag on a key painting ew-resize moves the value",
    ).not.toBeCloseTo(v0, 6);
});
