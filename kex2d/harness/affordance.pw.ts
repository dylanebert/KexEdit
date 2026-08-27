import {
    expect,
    frames,
    frameTimeline,
    HBAND_H,
    HBAND_TOP,
    clickMenuItem,
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
// Ten `.fld .key` spans exist in that file, all ten wiring `onpointerdown` to a scrub:
// `handleScrub` (two spans, s and g axes), `scrubStart` (six spans, S10/F8 — the force, strip
// keyframe, and one-shot popovers all share the one parameterized `scrubSubject()` descriptor,
// so every popup's position AND value label carries the gesture, the one-shot's position label
// included even though its own subject always refuses), `snapScrub` (two spans, angle and
// length). `App.svelte` carries two more under its own `.vtip .key` rule, the identical
// `ew-resize` dress (`frictionScrubStart`, `resistanceScrubStart`), both wired — the v0 row
// retired with S5's derived entry speed. Twelve wired teachers app-wide, zero refusers. The C5
// strip popover's unwired `.striptip .key` span (the refuser this arm originally targeted) does
// not exist in T1's tree — T1 does not add a strip value popover (the value surface is T2's, in
// the graph) — so the `test.fail` arm that targeted it was permanently vacuous and is retired
// (see below).
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
 *  stable id + seeded value. `seed()` (S3) carries no strip of its own (the track-start one-shot
 *  is a structurally distinct point kind, not a span), so the count goes 0 → 1 — every caller
 *  addresses the NEW strip by this id, never by index or position (the created strip's own
 *  `[0, min extent)` span sorts first in `sectionStrips`' `start`-ascending order, and
 *  `stripPx`/`stripsOf` follow the same order). */
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
// a lane visibly present even when empty (S4, finding 4 retired the lane's own label — typing
// lives on the item, never a per-lane word), and a hover rung that reads edge/body/empty apart,
// each carrying its own declared cursor (S4 finding 1's body pointer, S5 finding 2's edge
// ew-resize) — empty band space alone stays `default`. Driven with REAL pointer moves
// (`page.mouse.move`), never `__kex` calls: a hook-driven flow proves the model updated, not
// that a person could ever land the gesture (T2's own lesson, this file's header comment).

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

// RED-FIRST WITNESS (kex2d-capture-deflake S2, 2026-08-25): stubbing `Timeline.svelte`'s
// `bandHoverMove` to drop its `bandHoverX` write reds this arm — `capture -g "hit-zone
// partition"` exits 1 at the body-hover poll ("Expected {kind: body, id: 0}, Received {kind:
// empty}", 5000ms timeout) — reverted and reran green (exit 0). The `frames(page, 1)` settles
// this arm used are replaced by polling `bandHit`/`stripPx` (`__kex`'s classification-state
// reads) — the PARTITION a pointer position resolves to, never rendered pixels — so this arm
// survives a later in-scheme colour/height change to the band's paint.
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

    // The chart's zoom over this scenario already projects a min-extent strip past
    // `4 * STRIP_HIT_R` wide (measured: ~278px at `frameTimeline`'s fit), so unlike this arm's
    // stale premise — a genuine body region already exists without a drag. The end-edge drag
    // (the same gesture `bandDown`'s "end" mode drives) is kept anyway, driving the real
    // pointer through the resize affordance rather than skipping it — but a further widen is
    // NOT assumed: the strip's end can legitimately sit at the track's own live-extent ceiling
    // (`kex2d-map.md` "clamp at the neighbour"), a structural no-op rather than a race. `seed()`
    // (S3) carries no strip of its own (the track-start one-shot is a distinct point kind), so
    // this is the only strip — addressed by id anyway, never index 0, matching every sibling
    // flow's own convention.
    const createdPx = (
        (await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[]
    ).find((s) => s.id === created.id);
    if (!createdPx) throw new Error("created strip not projected on the band");
    const [endPageX, endPageY] = toPage(createdPx.x1);
    await page.mouse.move(endPageX, endPageY);
    await page.mouse.down();
    await page.mouse.move(endPageX + 250, endPageY, { steps: 10 });
    await page.mouse.up();
    // NOT a settle (kex2d-capture-deflake S2 finding F4): the pre-drag strip is already
    // ~278px wide at this zoom, far past `4 * STRIP_HIT_R` (24px), so a poll gated on that
    // same threshold is satisfied on its very first check regardless of whether the drag has
    // landed — it buys no synchronization over the `frames(page, 1)` it replaced. `stripPx` is
    // read fresh off the ECS (`freshness.pw.ts`'s MUST-READ-FRESH set), so there is no
    // propagation race here to poll for in the first place — a plain read is honest. The arm's
    // real synchronization point is the `expect.poll(selectedStrip)` below, after Escape: that
    // is what the pixel probes further down actually wait on.
    const stripPxAfterWiden = (
        (await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[]
    ).find((r) => r.id === created.id);
    if (!stripPxAfterWiden) throw new Error("widened strip not found");

    // deselect — the general (unselected) case, since a selected strip already wears its own
    // brighter stroke+fill and would make the edge/body split trivial for the wrong reason.
    await page.keyboard.press("Escape");
    await expect.poll(() => kexCall(page, "selectedStrip")).toBeNull();

    const strips = (await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[];
    expect(strips.length).toBe(1);
    const widened = strips.find((s) => s.id === created.id);
    if (!widened) throw new Error("widened strip not found");
    const { x0, x1 } = widened;
    expect(x1 - x0).toBeGreaterThan(4 * STRIP_HIT_R); // wide enough for a genuine body region
    const bodyX = (x0 + x1) / 2;
    const emptyX = x1 + 40; // well past both the strip AND its `STRIP_HIT_R` endpoint radius
    expect(emptyX - x1).toBeGreaterThan(STRIP_HIT_R);

    // move away from the band entirely before any REST read, so no stale hover survives from
    // `createStrip`'s own right-click (which leaves the pointer wherever the menu row was). The
    // condition is the classification state itself — `bandHit` — reaching "empty", which is the
    // PARTITION `render()` reads to paint the rest fill; never a frame count.
    await page.mouse.move(5, 5);
    await expect.poll(() => kexCall(page, "bandHit")).toEqual({ kind: "empty" });
    const restBody = await probeChart(page, bodyX, bandY);
    const restEmpty = await probeChart(page, emptyX, bandY);
    expect(restBody).not.toBeNull();
    expect(restEmpty).not.toBeNull();
    // body/empty already read apart at rest — the strip's own fill vs the plain band background.
    const RestTol = 10;
    if (restBody && restEmpty) expect(dist(restBody, restEmpty)).toBeGreaterThan(RestTol);

    // hover the BODY with a real pointer move — the fill lifts one `hovered()` rung. Await the
    // PARTITION (`bandHit` reading "body" for this strip's id), not a frame count: that is the
    // condition the render's fill lift depends on, and it survives a later colour/height
    // re-scheme of the paint itself (kex2d-capture-deflake S2, "prefer classification-state
    // where the criterion is really the partition, not the colour").
    const [bodyPageX, bodyPageY] = toPage(bodyX);
    await page.mouse.move(bodyPageX, bodyPageY);
    await expect.poll(() => kexCall(page, "bandHit")).toEqual({ kind: "body", id: created.id });
    const hoverBody = await probeChart(page, bodyX, bandY);
    expect(hoverBody).not.toBeNull();
    const HoverTol = 6;
    if (restBody && hoverBody)
        expect(
            dist(hoverBody, restBody),
            `hover should lift the body fill past rest ${JSON.stringify(restBody)}, got ${JSON.stringify(hoverBody)}`,
        ).toBeGreaterThan(HoverTol);

    // hover the START EDGE — the resize affordance reads apart from the body-hover fill lift,
    // by a distinct stroke, never a cursor swap (the S3 premise correction). Await the
    // classification reaching the endpoint kind for this strip's start edge.
    const [edgePageX, edgePageY] = toPage(x0);
    await page.mouse.move(edgePageX, edgePageY);
    await expect
        .poll(() => kexCall(page, "bandHit"))
        .toEqual({ kind: "endpoint", id: created.id, edge: "start" });
    const hoverEdge = await probeChart(page, x0, bandY);
    expect(hoverEdge).not.toBeNull();
    if (hoverEdge && hoverBody)
        expect(
            dist(hoverEdge, hoverBody),
            `edge hover ${JSON.stringify(hoverEdge)} should read apart from body hover ${JSON.stringify(hoverBody)}`,
        ).toBeGreaterThan(HoverTol);

    // hover truly EMPTY band space — stays inert: the pixel is unchanged from its rest reading.
    // Await the classification reaching "empty" again (past the strip AND its own hit radius).
    const [emptyPageX, emptyPageY] = toPage(emptyX);
    await page.mouse.move(emptyPageX, emptyPageY);
    await expect.poll(() => kexCall(page, "bandHit")).toEqual({ kind: "empty" });
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

// RED-FIRST WITNESS (kex2d-capture-deflake S2, 2026-08-25): deleting the `!sel &&` guard on
// `Timeline.svelte`'s endpoint-hover stroke (so the resize stroke draws unconditionally, the
// exact bug this test guards against) reds this arm — `capture -g "selected strip suppresses
// the endpoint hover stroke"` exits 1 ("a selected strip's edge must ignore hover", the
// SelHoverTol assert) — reverted and reran green (exit 0). The two `frames(page, 1)` settles
// are replaced by polling `bandHit` (the same classification-state reader the hit-zone
// partition arm above already uses) — the PARTITION a pointer position resolves to, never a
// frame count, so this arm survives a later in-scheme colour change to the stroke itself.
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
    // `seed()` (S3) carries no strip of its own — the created one is the only one, addressed
    // by id anyway (the SELECTED one is the review's own subject).
    expect(strips.length).toBe(1);
    const selected = strips.find((s) => s.id === created.id);
    if (!selected) throw new Error("selected strip not found");
    const { x0 } = selected;

    // rest, still selected: no hover anywhere near the band. Await the PARTITION reaching
    // "empty" (`bandHit`, the classification `render()` reads), never a frame count — the
    // condition the rest of this arm actually needs, same idiom as the hit-zone partition arm.
    await page.mouse.move(5, 5);
    await expect.poll(() => kexCall(page, "bandHit")).toEqual({ kind: "empty" });
    const restSelected = await probeChart(page, x0, bandY);
    expect(restSelected).not.toBeNull();

    // hover the SELECTED strip's own start edge with a real pointer move. Await the
    // classification reaching the endpoint kind for this strip's start edge — the condition
    // `bandHit.kind === "endpoint"`'s `!sel` guard reads before the stroke draws (or doesn't).
    const [edgePageX, edgePageY] = toPage(x0);
    await page.mouse.move(edgePageX, edgePageY);
    await expect
        .poll(() => kexCall(page, "bandHit"))
        .toEqual({ kind: "endpoint", id: created.id, edge: "start" });
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

// ── S3 (kex2d-event-substrate, "one-shot events are a structurally distinct kind") ─────────────
// the track-start one-shot (`track.OneShot`) is never a `Strip` row — the degenerate `[0, 0)`
// point-as-span convention S6 built (drag-out into a real span, `classifyStripHit`'s "glyph"
// kind) retires along with it (`strip-hit.ts` no longer has a glyph branch at all). This arm
// drives the one-shot's own lifecycle — delete, create, select — through the REAL pointer end
// to end, replacing the retired drag-out arm: `__kex` is read only for assertions
// (checks.md: an interaction affordance is only visible to an instrument that performs the
// interaction).
test("the track-start one-shot: delete, create, and select through the real pointer (S3)", async ({
    page,
    boot,
}) => {
    await boot();
    await seedHill(page);
    await frameTimeline(page);

    // `seed()` (S3) authors the one-shot directly — never a `Strip` row — so it's already live.
    const seeded = (await kexCall(page, "oneShot")) as { id: number; value: number } | null;
    expect(seeded).not.toBeNull();
    if (!seeded) throw new Error("unreachable");

    const chartBox = await page.locator("canvas.chart").boundingBox();
    if (!chartBox) throw new Error("chart canvas not laid out");
    const glyphLocalX = (await kexCall(page, "oneShotPx")) as number;
    const gx = chartBox.x + glyphLocalX;
    const gy = chartBox.y + bandY;

    // hover the glyph — it reads apart from rest (the same body-hover differential S3's own
    // hit-zone-partition arm uses for a real strip's body), proving there IS a live affordance
    // here even though the glyph has no `endpoint`/`body` kind of its own (`classifyOneShotHit`
    // is a single-point predicate, `strip-hit.ts`).
    await page.mouse.move(5, 5);
    await frames(page, 1);
    const rest = await probeChart(page, glyphLocalX, bandY);
    await page.mouse.move(gx, gy);
    await frames(page, 1);
    const hoverGlyph = await probeChart(page, glyphLocalX, bandY);
    expect(rest).not.toBeNull();
    expect(hoverGlyph).not.toBeNull();
    const HoverTol = 6;
    if (rest && hoverGlyph)
        expect(
            dist(hoverGlyph, rest),
            `the glyph should lift its fill under hover past rest ${JSON.stringify(rest)}, got ${JSON.stringify(hoverGlyph)}`,
        ).toBeGreaterThan(HoverTol);

    // SELECT: a real left-click on the glyph.
    await page.mouse.click(gx, gy);
    await expect.poll(async () => kexCall(page, "oneShotSelected")).toBe(true);

    // DELETE: a real Delete keypress on the selection — no drag-out, no extent to grow (fixed
    // at `d = 0`); the derived entry speed falls back to `V0` — read as the seed's own value
    // (`seed()` authors the one-shot at exactly `V0`, the Locked Decision), never imported: this
    // file stages standalone and can import nothing beyond `./flow` (its own header comment).
    await page.keyboard.press("Delete");
    await expect.poll(async () => kexCall(page, "oneShot")).toBeNull();
    await expect.poll(async () => kexCall(page, "v0")).toBeCloseTo(seeded.value, 3);

    // CREATE: right-click on the (now empty) band → the summoned menu offers "Add initial
    // velocity" only because none exists (`menus.stripMenu`'s own `oneShotExists` branch) —
    // the same right-click-on-empty grammar "Add velocity strip" already uses.
    const bandBb = await page.locator(".hbandzone").boundingBox();
    if (!bandBb) throw new Error("header band not laid out");
    const emptyY = bandBb.y + bandBb.height / 2;
    const emptyX = bandBb.x + bandBb.width * 0.6; // well clear of the glyph's own station
    await page.mouse.click(emptyX, emptyY, { button: "right" });
    await expect(page.locator(".smenu")).toHaveCount(1);
    await expect(
        page.locator(".smenu").getByRole("menuitem", { name: "Add initial velocity" }),
    ).toBeEnabled();
    await clickMenuItem(page, ".smenu", "Add initial velocity");

    // it appears at V0 (the seed value — a point event carries no live-bake `v` to read,
    // unlike a summoned strip's `stripSeedValue`), selected.
    await expect
        .poll(async () => (await kexCall(page, "oneShot")) as { id: number; value: number } | null)
        .not.toBeNull();
    const created = (await kexCall(page, "oneShot")) as { id: number; value: number };
    expect(created.id).not.toBe(seeded.id); // a fresh id — never resurrected
    expect(created.value).toBeCloseTo(seeded.value, 3);
    await expect.poll(async () => kexCall(page, "oneShotSelected")).toBe(true);
});
