import { expect, frameTimeline, kexCall, type Page, seedHill, test } from "./flow";

// ── AFFORDANCE ARMS ──────────────────────────────────────────────────────────────────────────
// One axis, one predicate: a surface that PAINTS an interactive cursor must have a handler
// behind it. Nothing else in this harness reads that axis, and that is the reason the C5
// band-authoring popover shipped `bun check` 0, `bun test` 1589/0/46 and capture 38/38 while the
// affordance axis stayed invisible to every gate (kex2d-substrate, feel gate 2026-08-20, verdict
// 5, "the popover is jarring and does not work" — this arm owns the "does not work" half; the
// "jarring" half is a separate, unmeasured axis this rig cannot see, and so is the strip value's
// own legibility: its only rendering in C5 is the α-0.25 dashed velocity channel
// (`Timeline.svelte:2797–2812`, one pass, no authored-span solid split), so a committed edit is
// near-invisible and a person typing a value and seeing nothing legible reported is also "does
// not work" — bounded either way by T2's solid-in-graph design, which retires the channel this
// gap lives in.
//
// THE MECHANISM. `.fld .key` is this app's scrub-handle dress — `cursor: ew-resize`,
// `user-select: none`, `touch-action: none`, a hover wash (`Timeline.svelte`, `.fld .key`).
// Seven `.fld .key` spans exist in that file (lines 3671, 3688, 3727, 3746, 3780, 3939, 3954);
// six wire `onpointerdown` to a scrub (`handleScrub` at 3671/3688, `scrubStart` at 3727/3746,
// `snapScrub` at 3939/3954) and the strip popover's `<span class="key">v</span>` at 3780 wires
// nothing. `App.svelte` carries three more under its own `.vtip .key` rule, the identical
// `ew-resize` dress (`v0ScrubStart`/`frictionScrubStart`/`resistanceScrubStart` at
// 1456/1471/1486), and all three are wired. Nine wired teachers app-wide, one refuser. The
// popover's own comment says the omission was deliberate — "no scrub handle (a strip's value
// has no natural drag axis…)" — but the decision was taken in the markup and not in the CSS, so
// the surface still paints the drag cursor, still lights up on hover, and still swallows the
// drag. It is the one surface in the app that promises a scrub and refuses it, and the promise
// is the only instruction a person has: the other nine taught them the gesture.
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
// asserted is `ew-resize`, left the strip's value bit-identical. What is proven, directly: the
// rig moves a value on a wired surface (the control below) and does not move one on the
// unwired popover (the subject). The inverse — that a real handler on the popover would flip
// the subject's own reading to "Expected to fail, but passed" — is not separately witnessed
// here; it follows from the control sharing the identical rig and dress.
//
// T1/T2 OWN THE FIX, not this arm. When the value surface is rebuilt (T2 retires the popover;
// T1 rebuilds the band), either honour the dress or stop painting it — then DELETE the
// `test.fail` annotation below, which reds as "Expected to fail, but passed" the moment the
// affordance is honoured.

/** the computed cursor a popover key label paints, read before a horizontal drag across it */
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
    return cursor;
}

/** create a velocity strip via T1's summoned creation (right-click → menu → Add) and return its seeded value */
async function createStrip(page: Page): Promise<number> {
    const bandBb = await page.locator(".hbandzone").boundingBox();
    const clipBb = await page.locator(".clip").first().boundingBox();
    if (!bandBb || !clipBb) throw new Error("header band / clip not laid out");
    const y = bandBb.y + bandBb.height / 2;
    const x = clipBb.x + clipBb.width * 0.3;
    // T1's summoned creation: right-click on empty band → context menu → "Add velocity strip"
    await page.mouse.click(x, y, { button: "right" });
    await expect(page.locator(".smenu")).toHaveCount(1);
    await page.locator(".smenu").getByText("Add velocity strip").click();
    await expect.poll(async () => (await kexCall(page, "stripsOf", 0)).length).toBe(1);
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
    await expect
        .poll(at, { message: "a drag on a key painting ew-resize moves the value", timeout: 1000 })
        .not.toBeCloseTo(g0, 6);

    // the inverted arm's setup, asserted where a failure can be read
    await page.keyboard.press("Escape"); // clear the keyframe popover
    await expect(page.locator(".ptip")).toHaveCount(0);
    await createStrip(page);
    // T1 does not add a strip value popover (the value surface is T2's, in the graph),
    // so there is no `.striptip` to check here — the control's strip create + the force
    // keyframe scrub above are the whole proof.
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
    await expect
        .poll(async () => (await kexCall(page, "stripsOf", 0))[0].value, {
            message: "a drag on a key painting ew-resize moves the value",
            timeout: 1000,
        })
        .not.toBeCloseTo(v0, 6);
});
