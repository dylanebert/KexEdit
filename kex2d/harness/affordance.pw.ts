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
    // by a distinct stroke and the `ew-resize` cursor. Await the classification reaching the
    // endpoint kind for this strip's start edge.
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
// The endpoint is a distinct resize handle over the selected span: its `hovered()` stroke and
// `ew-resize` cursor survive selection, while the selected span body keeps hover suppression.
// The state table below covers both channels, including stationary release.
//
// Finding 2 (should-fix, not blocker): a foreign gesture holding pointer capture on `canvas`
// was theorized to leave `.hbandzone`'s own `onpointermove`/`onpointerleave` unfired, so
// `bandHoverX` would freeze and re-derive into a stale hover once `editor.dragging` dropped.
// The narrow release legs below now witness the boundary directly: only a real `pointerup` whose
// release point remains inside the horizontal band preserves the stationary handle; an off-band
// `pointerup` and `pointercancel` both clear the hover through the `$effect`. This is the capture
// arm for the teardown claim, without widening the flow to unrelated gestures.

// RED-FIRST WITNESS (kex2d-strip-resize-affordance S1): the rewritten state × affordance
// arm was run against unchanged production before the repair. It exited 1 because selected-edge
// hover stayed within the selected-at-rest paint band, while the cursor still read `ew-resize`.
// After removing only the endpoint stroke guard, the same arm exits 0; deleting that repaired
// stroke block reds it again. Numeric pixel readings and computed cursor values are recorded in
// the gate report.
test("selected strip endpoint paint and cursor agree across the state table", async ({
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
    const bandCursor = (): Promise<string> =>
        page.locator(".hbandzone").evaluate((e) => getComputedStyle(e).cursor);

    await expect.poll(() => kexCall(page, "selectedStrip")).toBe(created.id);
    const strips = (await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[];
    expect(strips.length).toBe(1);
    const selected = strips.find((s) => s.id === created.id);
    if (!selected) throw new Error("selected strip not found");
    const { x0, x1 } = selected;
    const bodyX = (x0 + x1) / 2;
    const emptyX = x1 + 40;
    expect(x1 - x0).toBeGreaterThan(4 * STRIP_HIT_R);
    expect(emptyX - x1).toBeGreaterThan(STRIP_HIT_R);
    expect(emptyX).toBeGreaterThanOrEqual(0);
    expect(emptyX).toBeLessThan(chartBox.width);

    // SELECTED: rest and body hover retain the selected paint; the selected edge keeps its
    // separate handle paint and its resize cursor. The hit partition is the synchronization
    // point for each rendered state, not a frame-count settle.
    const [emptyPageX, emptyPageY] = toPage(emptyX);
    await page.mouse.move(emptyPageX, emptyPageY);
    await expect.poll(() => kexCall(page, "bandHit")).toEqual({ kind: "empty" });
    await expect.poll(bandCursor).toBe("default");
    const selectedRest = await probeChart(page, bodyX, bandY);
    const selectedRestEdge = await probeChart(page, x0, bandY);
    expect(selectedRest).not.toBeNull();
    expect(selectedRestEdge).not.toBeNull();

    const [bodyPageX, bodyPageY] = toPage(bodyX);
    await page.mouse.move(bodyPageX, bodyPageY);
    await expect.poll(() => kexCall(page, "bandHit")).toEqual({ kind: "body", id: created.id });
    await expect.poll(bandCursor).toBe("pointer");
    const selectedBody = await probeChart(page, bodyX, bandY);
    expect(selectedBody).not.toBeNull();
    if (selectedRest && selectedBody)
        expect(dist(selectedBody, selectedRest)).toBeLessThanOrEqual(2);

    const [edgePageX, edgePageY] = toPage(x0);
    await page.mouse.move(edgePageX, edgePageY);
    await expect
        .poll(() => kexCall(page, "bandHit"))
        .toEqual({ kind: "endpoint", id: created.id, edge: "start" });
    await expect.poll(bandCursor).toBe("ew-resize");
    const selectedEdge = await probeChart(page, x0, bandY);
    expect(selectedEdge).not.toBeNull();
    if (selectedRestEdge && selectedEdge)
        expect(
            dist(selectedEdge, selectedRestEdge),
            `selected edge must paint apart from selected rest at the edge: rest ${JSON.stringify(selectedRestEdge)}, edge ${JSON.stringify(selectedEdge)}`,
        ).toBeGreaterThan(2);

    // SELECTED ENDPOINT RELEASE: begin and end the resize gesture without moving away from the
    // handle. Both the endpoint paint and its cursor must survive the shared drag teardown.
    await page.mouse.down();
    await page.mouse.up();
    await expect
        .poll(() => kexCall(page, "bandHit"))
        .toEqual({ kind: "endpoint", id: created.id, edge: "start" });
    await expect.poll(bandCursor).toBe("ew-resize");
    const selectedReleasedEdge = await probeChart(page, x0, bandY);
    expect(selectedReleasedEdge).not.toBeNull();
    if (selectedEdge && selectedReleasedEdge)
        expect(
            dist(selectedReleasedEdge, selectedEdge),
            `selected endpoint release must retain edge paint: before ${JSON.stringify(selectedEdge)}, after ${JSON.stringify(selectedReleasedEdge)}`,
        ).toBeLessThanOrEqual(2);

    // UNSELECTED: rest is inert, body hover lifts its fill and pointer cursor, and endpoint hover
    // adds the resize stroke and ew-resize cursor.
    await page.keyboard.press("Escape");
    await expect.poll(() => kexCall(page, "selectedStrip")).toBeNull();
    await page.mouse.move(emptyPageX, emptyPageY);
    await expect.poll(() => kexCall(page, "bandHit")).toEqual({ kind: "empty" });
    await expect.poll(bandCursor).toBe("default");
    const rest = await probeChart(page, bodyX, bandY);
    expect(rest).not.toBeNull();

    await page.mouse.move(bodyPageX, bodyPageY);
    await expect.poll(() => kexCall(page, "bandHit")).toEqual({ kind: "body", id: created.id });
    await expect.poll(bandCursor).toBe("pointer");
    const body = await probeChart(page, bodyX, bandY);
    expect(body).not.toBeNull();
    if (rest && body)
        expect(
            dist(body, rest),
            `body hover must lift the fill: rest ${JSON.stringify(rest)}, hover ${JSON.stringify(body)}`,
        ).toBeGreaterThan(6);

    await page.mouse.move(edgePageX, edgePageY);
    await expect
        .poll(() => kexCall(page, "bandHit"))
        .toEqual({ kind: "endpoint", id: created.id, edge: "start" });
    await expect.poll(bandCursor).toBe("ew-resize");
    const edge = await probeChart(page, x0, bandY);
    expect(edge).not.toBeNull();
    if (body && edge)
        expect(
            dist(edge, body),
            `edge hover must paint apart from body hover: body ${JSON.stringify(body)}, edge ${JSON.stringify(edge)}`,
        ).toBeGreaterThan(6);
    if (selectedEdge && edge)
        expect(
            dist(selectedEdge, edge),
            `selected edge must reuse the existing edge-hover paint: selected ${JSON.stringify(selectedEdge)}, unselected ${JSON.stringify(edge)}`,
        ).toBeLessThanOrEqual(2);

    // An endpoint release outside the horizontal band must not preserve the last body/edge read.
    // Pointer capture routes the move/up through the window listeners, so this witnesses the
    // teardown path rather than relying on `.hbandzone`'s leave event. Re-read the endpoint after
    // the drag because the off-band move may legitimately resize it to the track boundary.
    const offBandStrip = (
        (await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[]
    ).find((s) => s.id === created.id);
    if (!offBandStrip) throw new Error("strip missing before off-band release");
    const [offBandEdgeX, offBandEdgeY] = toPage(offBandStrip.x0);
    await page.mouse.move(offBandEdgeX, offBandEdgeY);
    await expect
        .poll(() => kexCall(page, "bandHit"))
        .toEqual({ kind: "endpoint", id: created.id, edge: "start" });
    await page.mouse.down();
    await page.mouse.move(offBandEdgeX, 5, { steps: 4 });
    await page.evaluate(
        ({ x, y }) =>
            window.dispatchEvent(
                new PointerEvent("pointerup", {
                    bubbles: true,
                    cancelable: true,
                    pointerId: 1,
                    clientX: x,
                    clientY: y,
                }),
            ),
        { x: offBandEdgeX, y: 5 },
    );
    await page.mouse.up();
    await expect.poll(() => kexCall(page, "bandHit")).toEqual({ kind: "empty" });
    await expect.poll(bandCursor).toBe("default");

    // Cancellation has the same non-preserving rule even when the pointer is captured. Dispatch
    // the event through window (where the real release listeners live), then release the test
    // mouse as cleanup if the browser does not synthesize its own cancel-up transition.
    const cancelStrip = (
        (await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[]
    ).find((s) => s.id === created.id);
    if (!cancelStrip) throw new Error("strip missing before cancellation");
    const [cancelEdgeX, cancelEdgeY] = toPage(cancelStrip.x0);
    await page.mouse.move(cancelEdgeX, cancelEdgeY);
    await expect
        .poll(() => kexCall(page, "bandHit"))
        .toEqual({ kind: "endpoint", id: created.id, edge: "start" });
    await page.mouse.down();
    await page.mouse.move(cancelEdgeX, 5, { steps: 4 });
    await page.evaluate(() => {
        window.dispatchEvent(
            new PointerEvent("pointercancel", {
                bubbles: true,
                cancelable: true,
                pointerId: 1,
                clientX: 5,
                clientY: 5,
            }),
        );
    });
    await page.mouse.up();
    await expect.poll(() => kexCall(page, "bandHit")).toEqual({ kind: "empty" });
    await expect.poll(bandCursor).toBe("default");
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
