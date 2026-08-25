import {
    expect,
    frames,
    frameTimeline,
    HBAND_H,
    HBAND_TOP,
    LEFT_GUT,
    kexCall,
    type Page,
    seedHill,
    test,
} from "./flow";

// ── AFFORDANCE ARMS ──────────────────────────────────────────────────────────────────────────
// One axis, one predicate: a surface that PAINTS an interactive cursor must have a handler
// behind it. Nothing else in this harness reads that axis, and that is the reason the C5
// band-authoring popover shipped `bun check` 0, `bun test` 1589/0/46 and capture 38/38 while the
// affordance axis stayed invisible to every gate (the feel gate's "the popover is jarring and
// does not work" verdict — this arm owns the "does not work" half; the
// "jarring" half is a separate, unmeasured axis this rig cannot see, and so is the strip value's
// own legibility: its only rendering in C5 is the α-0.25 dashed velocity channel
// (`Timeline.svelte:2797–2812`, one pass, no authored-span solid split), so a committed edit is
// near-invisible and a person typing a value and seeing nothing legible reported is also "does
// not work" — bounded either way by T2's solid-in-graph design, which retires the channel this
// gap lives in.
//
// THE MECHANISM. `.fld .key` is this app's scrub-handle dress — `cursor: ew-resize`,
// `user-select: none`, `touch-action: none`, a hover wash (`Timeline.svelte`, `.fld .key`).
// Six `.fld .key` spans exist in that file, all six wiring `onpointerdown` to a scrub:
// `handleScrub` (two spans, s and g axes), `scrubStart` (two spans, s and g axes),
// `snapScrub` (two spans, angle and length). `App.svelte` carries two more under its
// own `.vtip .key` rule, the identical `ew-resize` dress (`frictionScrubStart`,
// `resistanceScrubStart`), both wired — the v0 row retired with S5's derived entry
// speed. Eight wired teachers app-wide, zero refusers. The C5 strip popover's unwired `.striptip .key` span
// (the refuser this arm originally targeted) does not exist in T1's tree — T1 does not
// add a strip value popover (the value surface is T2's, in the graph) — so the `test.fail`
// arm that targeted it was permanently vacuous and is retired (see below).
// Cited by handler name, not line number — `7220424` moved all six by +22 and the line
// numbers rotted; handler names cannot rot.
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

/** create a velocity strip via T1's summoned creation (right-click → menu → Add) and return its
 *  stable id + seeded value. `seed()` already carries its own start strip at station 0 (S5), so
 *  the count goes 1 → 2, not 0 → 1 — every caller addresses the NEW strip by this id, never by
 *  index or position (the launch strip's own `[0, min extent)` span sorts first in
 *  `sectionStrips`' `start`-ascending order, and `stripPx`/`stripsOf` follow the same order). */
async function createStrip(page: Page): Promise<{ id: number; value: number }> {
    const before = (await kexCall(page, "stripsOf", 0)) as { id: number }[];
    const bandBb = await page.locator(".hbandzone").boundingBox();
    const clipBb = await page.locator(".clip").first().boundingBox();
    if (!bandBb || !clipBb) throw new Error("header band / clip not laid out");
    const y = bandBb.y + bandBb.height / 2;
    const x = clipBb.x + clipBb.width * 0.3;
    // T1's summoned creation: right-click on empty band → context menu → "Add velocity strip"
    await page.mouse.click(x, y, { button: "right" });
    await expect(page.locator(".smenu")).toHaveCount(1);
    await page.locator(".smenu").getByText("Add velocity strip").click();
    await expect
        .poll(async () => (await kexCall(page, "stripsOf", 0)).length)
        .toBe(before.length + 1);
    const beforeIds = new Set(before.map((s) => s.id));
    const strips = (await kexCall(page, "stripsOf", 0)) as { id: number; value: number }[];
    const created = strips.find((s) => !beforeIds.has(s.id));
    if (!created) throw new Error("newly-created strip not found");
    return created;
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

// RETIRED: the `test.fail` arm that targeted `.striptip .key` (C5's strip value popover's
// scrub handle) is gone. T1 does not add a strip value popover — the value surface is T2's,
// in the graph — so `.striptip .key` does not exist anywhere in T1's tree. A `test.fail`
// arm whose subject locator times out (15 s) is laundered into a pass by `test.fail` itself,
// so the arm was permanently vacuous: its stated retirement trigger (the moment T1/T2
// honours the cursor the popover paints) could never fire, because the popover it targeted
// was never built. The control arm above (force keyframe scrub) remains the whole proof
// that the rig moves a value on a wired surface. When T2 rebuilds the value surface in the
// graph, a new affordance arm should target THAT surface directly — not this retired one.

// ── S3 (Affordances) ─────────────────────────────────────────────────────────────────────────
// The header band declares its gestures before engagement (root ui.md gate 3, corrected at R):
// a lane visibly present + NAMED even when empty, and a hover rung — never the cursor, which
// stays `default` throughout — that reads edge/body/empty apart. Driven with REAL pointer
// moves (`page.mouse.move`), never `__kex` calls: a hook-driven flow proves the model updated,
// not that a person could ever land the gesture (T2's own lesson, this file's header comment).

/** a pixel off the real `canvas.chart`, at CANVAS-LOCAL CSS coordinates (device-px scaled) —
 *  the same idiom `geo.pw.ts`'s `probeChart` uses for the header band's ghost-strip probe. */
function probeChart(page: Page, x: number, y: number): Promise<[number, number, number] | null> {
    return page.evaluate(
        ({ x, y }) => {
            const canvas = document.querySelector<HTMLCanvasElement>("canvas.chart");
            const ctx = canvas?.getContext("2d");
            if (!canvas || !ctx) return null;
            const r = canvas.getBoundingClientRect();
            const px = Math.round((x * canvas.width) / r.width);
            const py = Math.round((y * canvas.height) / r.height);
            if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return null;
            const d = ctx.getImageData(px, py, 1, 1).data;
            return [d[0], d[1], d[2]] as [number, number, number];
        },
        { x, y },
    );
}

// mirrors Timeline.svelte's own `STRIP_HIT_R` — the endpoint-vs-body split radius (`strip-hit.ts`).
const STRIP_HIT_R = 6;
const dist = (a: readonly number[], b: readonly number[]): number =>
    Math.max(...a.map((v, i) => Math.abs(v - b[i])));
const bandY = HBAND_TOP + HBAND_H / 2;

test("velocity band names itself even with no strip authored (S3 on-surface naming)", async ({
    page,
    boot,
}) => {
    await boot();
    await seedHill(page);
    await frameTimeline(page);
    // no strip exists yet — the whole band is the plain header-band fill, so ANY pixel past
    // the gutter is a valid background reading for the differential below.
    const bg = await probeChart(page, LEFT_GUT + 80, bandY);
    expect(bg).not.toBeNull();
    // the label sits in the untouched left gutter (`x < LEFT_GUT`), where a strip or ghost span
    // never draws (both clamp to `LEFT_GUT`) — sampled at a few x across its glyphs since a
    // single-pixel probe can land between anti-aliased strokes.
    const labelXs = [5, 9, 13, 17, 21];
    const labelPixels = await Promise.all(labelXs.map((x) => probeChart(page, x, bandY)));
    const LabelTol = 15;
    expect(
        labelPixels.some((p) => p !== null && bg !== null && dist(p, bg) > LabelTol),
        `expected at least one gutter pixel to differ from the plain band background ${JSON.stringify(bg)}, got ${JSON.stringify(labelPixels)}`,
    ).toBe(true);
});

test("velocity band hit-zone partition (S3): hover lifts the body fill, and edge/body/empty read apart", async ({
    page,
    boot,
}) => {
    await boot();
    await seedHill(page);
    await frameTimeline(page);
    const created = await createStrip(page);

    const chartBox = await page.locator("canvas.chart").boundingBox();
    if (!chartBox) throw new Error("chart canvas not laid out");
    const toPage = (localX: number): [number, number] => [chartBox.x + localX, chartBox.y + bandY];

    // a min-extent strip at the whole-document zoom `frameTimeline` leaves is a few px wide —
    // its own midpoint reads as an ENDPOINT (`classifyStripHit`'s "endpoint beats body"
    // precedence), which would make the body/edge split trivially fail for the wrong reason.
    // Widen it with a REAL end-edge drag (the same gesture `bandDown`'s "end" mode drives) so a
    // genuine body region — more than `STRIP_HIT_R` from either edge — exists to hover. `seed()`
    // (S5) carries its own start strip too, so address the CREATED one by id, never index 0.
    const createdPx = (
        (await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[]
    ).find((s) => s.id === created.id);
    if (!createdPx) throw new Error("created strip not projected on the band");
    const [endPageX, endPageY] = toPage(createdPx.x1);
    await page.mouse.move(endPageX, endPageY);
    await page.mouse.down();
    await page.mouse.move(endPageX + 250, endPageY, { steps: 10 });
    await page.mouse.up();
    await frames(page, 1);

    // deselect — the general (unselected) case, since a selected strip already wears its own
    // brighter stroke+fill and would make the edge/body split trivial for the wrong reason.
    await page.keyboard.press("Escape");
    await expect.poll(() => kexCall(page, "selectedStrip")).toBeNull();

    const strips = (await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[];
    expect(strips.length).toBe(2);
    const widened = strips.find((s) => s.id === created.id);
    if (!widened) throw new Error("widened strip not found");
    const { x0, x1 } = widened;
    expect(x1 - x0).toBeGreaterThan(4 * STRIP_HIT_R); // wide enough for a genuine body region
    const bodyX = (x0 + x1) / 2;
    const emptyX = x1 + 40; // well past both the strip AND its `STRIP_HIT_R` endpoint radius
    expect(emptyX - x1).toBeGreaterThan(STRIP_HIT_R);

    // move away from the band entirely before any REST read, so no stale hover survives from
    // `createStrip`'s own right-click (which leaves the pointer wherever the menu row was).
    await page.mouse.move(5, 5);
    await frames(page, 1);
    const restBody = await probeChart(page, bodyX, bandY);
    const restEmpty = await probeChart(page, emptyX, bandY);
    expect(restBody).not.toBeNull();
    expect(restEmpty).not.toBeNull();
    // body/empty already read apart at rest — the strip's own fill vs the plain band background.
    const RestTol = 10;
    if (restBody && restEmpty) expect(dist(restBody, restEmpty)).toBeGreaterThan(RestTol);

    // hover the BODY with a real pointer move — the fill lifts one `hovered()` rung.
    const [bodyPageX, bodyPageY] = toPage(bodyX);
    await page.mouse.move(bodyPageX, bodyPageY);
    await frames(page, 1);
    const hoverBody = await probeChart(page, bodyX, bandY);
    expect(hoverBody).not.toBeNull();
    const HoverTol = 6;
    if (restBody && hoverBody)
        expect(
            dist(hoverBody, restBody),
            `hover should lift the body fill past rest ${JSON.stringify(restBody)}, got ${JSON.stringify(hoverBody)}`,
        ).toBeGreaterThan(HoverTol);

    // hover the START EDGE — the resize affordance reads apart from the body-hover fill lift,
    // by a distinct stroke, never a cursor swap (the S3 premise correction).
    const [edgePageX, edgePageY] = toPage(x0);
    await page.mouse.move(edgePageX, edgePageY);
    await frames(page, 1);
    const hoverEdge = await probeChart(page, x0, bandY);
    expect(hoverEdge).not.toBeNull();
    if (hoverEdge && hoverBody)
        expect(
            dist(hoverEdge, hoverBody),
            `edge hover ${JSON.stringify(hoverEdge)} should read apart from body hover ${JSON.stringify(hoverBody)}`,
        ).toBeGreaterThan(HoverTol);

    // hover truly EMPTY band space — stays inert: the pixel is unchanged from its rest reading.
    const [emptyPageX, emptyPageY] = toPage(emptyX);
    await page.mouse.move(emptyPageX, emptyPageY);
    await frames(page, 1);
    const hoverEmpty = await probeChart(page, emptyX, bandY);
    expect(hoverEmpty).not.toBeNull();
    const EmptyTol = 2; // tight — empty space must read IDENTICAL, not merely "close"
    if (hoverEmpty && restEmpty)
        expect(
            dist(hoverEmpty, restEmpty),
            `empty band space must stay inert under hover: rest ${JSON.stringify(restEmpty)}, hovered ${JSON.stringify(hoverEmpty)}`,
        ).toBeLessThanOrEqual(EmptyTol);
});

// ── S3 review fixes ──────────────────────────────────────────────────────────────────────────
// Finding 1 against the S3 diff: the endpoint/resize hover stroke had no `!sel` guard, so
// hovering a selected strip's edge layered a `hovered()` stroke over the selection outline
// (`bodyHover` three lines up already carried the guard, citing the same rule). Covered below,
// red-first.
//
// Finding 2 (should-fix, not blocker): a foreign gesture holding pointer capture on `canvas`
// was theorized to leave `.hbandzone`'s own `onpointermove`/`onpointerleave` unfired, so
// `bandHoverX` would freeze and re-derive into a stale hover once `editor.dragging` dropped.
// Investigated with a debug hook (`Timeline.svelte`'s own comment on the fix) across two real
// repros — a foreign force-keyframe drag, and a middle-click pan starting AT the hovered
// position — and in this Chromium/Playwright environment `onpointerleave` fired correctly
// regardless of capture in both cases: `bandHoverX` was already `null` well before
// `editor.dragging` dropped, so the theorized staleness window never opened. No capture arm
// exists for this one — a check that stays green with the fix reverted is not evidence, and
// re-mutating confirmed exactly that (both directions green). The `$effect` guard is still in
// `Timeline.svelte`, kept as a zero-cost hardening rather than a demonstrated fix.

test("selected strip suppresses the endpoint hover stroke (S3 review finding 1)", async ({
    page,
    boot,
}) => {
    await boot();
    await seedHill(page);
    await frameTimeline(page);
    const created = await createStrip(page); // creation selects the strip — the review's own subject

    const chartBox = await page.locator("canvas.chart").boundingBox();
    if (!chartBox) throw new Error("chart canvas not laid out");
    const toPage = (localX: number): [number, number] => [chartBox.x + localX, chartBox.y + bandY];

    await expect.poll(() => kexCall(page, "selectedStrip")).toBe(created.id);
    const strips = (await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[];
    // `seed()` (S5) carries its own start strip too, so the count is 2, not 1; address the
    // SELECTED (created) one by id.
    expect(strips.length).toBe(2);
    const selected = strips.find((s) => s.id === created.id);
    if (!selected) throw new Error("selected strip not found");
    const { x0 } = selected;

    // rest, still selected: no hover anywhere near the band.
    await page.mouse.move(5, 5);
    await frames(page, 1);
    const restSelected = await probeChart(page, x0, bandY);
    expect(restSelected).not.toBeNull();

    // hover the SELECTED strip's own start edge with a real pointer move.
    const [edgePageX, edgePageY] = toPage(x0);
    await page.mouse.move(edgePageX, edgePageY);
    await frames(page, 1);
    const hoverSelectedEdge = await probeChart(page, x0, bandY);
    expect(hoverSelectedEdge).not.toBeNull();

    // the endpoint hover stroke must be invisible on an already-selected element (editor-ui.md
    // Kind color) — no register above selection, unconditionally, the same law `bodyHover`
    // already follows.
    const SelHoverTol = 2;
    if (restSelected && hoverSelectedEdge)
        expect(
            dist(hoverSelectedEdge, restSelected),
            `a selected strip's edge must ignore hover: at-rest ${JSON.stringify(restSelected)}, hovered ${JSON.stringify(hoverSelectedEdge)}`,
        ).toBeLessThanOrEqual(SelHoverTol);
});

// ── S6 (kex2d-event-lane, finding 8, option 1 — no point events) ───────────────────────────────
// the degenerate `[0, 0)` entry-speed strip `setStartSpeed`'s own no-strip branch spawns
// (`track.ts`) drives the REAL pointer drag-out end to end: before, it hits as its own
// "glyph" kind (never "endpoint"/"body",
// `strip-hit.test.ts`'s own oracle) and reads apart from rest under hover the same way a body
// does (S3's own hover-partition differential, reused here); after, the strip is a real,
// non-degenerate span landed through the same guarded writer `track.test.ts`'s "glyph expanded
// via setStrip bakes byte-identical to a hand-created span" pins at the bake layer.
test("degenerate entry-speed strip drags out into a real span (S6, finding 8)", async ({
    page,
    boot,
}) => {
    await boot();
    await seedHill(page);
    await kexCall(page, "convert"); // section-0 geo → force; strips are untouched (S2)
    // delete `seed()`'s real (non-degenerate, min-extent) start strip, then re-author the
    // entry speed with none present — `setStartSpeed`'s own no-strip branch spawns the
    // DEGENERATE `[0, 0)` point (S6's own convention). Strips are track-global and survive a
    // convert untouched now (S2, Locked decision), so a convert alone no longer produces this
    // scenario the way it used to (`preserveEntrySpeedAcrossConvert`, retired with S2).
    const seeded = (await kexCall(page, "stripsOf", 0)) as { id: number }[];
    expect(seeded.length).toBe(1);
    await kexCall(page, "deleteStripId", seeded[0].id);
    await kexCall(page, "setV0", 10);
    await frameTimeline(page);

    const stripsBefore = (await kexCall(page, "stripsOf", 0)) as {
        id: number;
        start: number;
        end: number;
        value: number;
    }[];
    expect(stripsBefore.length).toBe(1);
    const glyph = stripsBefore[0];
    expect(glyph.start).toBe(glyph.end); // degenerate

    const chartBox = await page.locator("canvas.chart").boundingBox();
    if (!chartBox) throw new Error("chart canvas not laid out");
    const glyphPx = (
        (await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[]
    ).find((s) => s.id === glyph.id);
    if (!glyphPx) throw new Error("glyph strip not projected on the band");
    expect(glyphPx.x0).toBe(glyphPx.x1); // one screen station, not a span

    const gx = chartBox.x + glyphPx.x0;
    const gy = chartBox.y + bandY;

    // hover the glyph — it reads apart from rest (the same body-hover differential S3's own
    // hit-zone-partition arm uses), proving there IS a live affordance here, even though
    // `strip-hit.ts` never returns "endpoint"/"body" for it.
    await page.mouse.move(5, 5);
    await frames(page, 1);
    const rest = await probeChart(page, glyphPx.x0, bandY);
    await page.mouse.move(gx, gy);
    await frames(page, 1);
    const hoverGlyph = await probeChart(page, glyphPx.x0, bandY);
    expect(rest).not.toBeNull();
    expect(hoverGlyph).not.toBeNull();
    const HoverTol = 6;
    if (rest && hoverGlyph)
        expect(
            dist(hoverGlyph, rest),
            `the glyph should lift its fill under hover past rest ${JSON.stringify(rest)}, got ${JSON.stringify(hoverGlyph)}`,
        ).toBeGreaterThan(HoverTol);

    // the real drag-out: press on the glyph, drag right, release.
    await page.mouse.down();
    await page.mouse.move(gx + 200, gy, { steps: 10 });
    await page.mouse.up();

    await expect
        .poll(async () => {
            const after = (await kexCall(page, "stripsOf", 0)) as { id: number; end: number }[];
            return after.find((s) => s.id === glyph.id)?.end ?? 0;
        })
        .toBeGreaterThan(0);

    const after = (
        (await kexCall(page, "stripsOf", 0)) as {
            id: number;
            start: number;
            end: number;
            value: number;
        }[]
    ).find((s) => s.id === glyph.id);
    if (!after) throw new Error("the expanded strip vanished");
    expect(after.start).toBe(0); // start stays pinned — the glyph only ever grows forward
    expect(after.end).toBeGreaterThan(0);
    expect(after.value).toBe(glyph.value); // the seeded value survives the expansion
});
