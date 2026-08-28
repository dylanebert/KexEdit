// kex2d's SEGMENT SPIKE capture flow (`kex2d-segment-spike` S2, specs/kex2d-segment-spike.md):
// the throwaway grip-language overlay, armed by `?spike=1` alone. The overlay adds no `__kex`
// accessor of its own — its whole footprint is `src/segmentspike.ts` + `src/Timeline.svelte` +
// this file, `main.ts` untouched — so every read below is a real pixel off the live
// `canvas.chart`, the SAME idiom `affordance.pw.ts`'s `probeChart` uses for the header band's
// hover rung, or a production accessor the spike shares the projection with (`forceU`, `xView`,
// `gRange` — the SAME `markerX`/`yOf` math `Timeline.svelte`'s `drawSpike` uses to place its own
// arc/boundaries/knobs, since both read the identical `view`/`yView` live state).
//
// C2 (this stage): the arc and boundary lines draw, the selected boundary reads as selected,
// knobs appear on a single selection and vanish on a multi-set. S3 extends this file with the
// four gestures and the no-write arm (C3).

import {
    test,
    expect,
    join,
    OUT,
    SHOT_MS,
    kexCall,
    frameTimeline,
    dockStrip,
    CHART_TOP,
    CHART_BOT_PAD,
    LEFT_GUT,
    type Page,
} from "./flow";

/** a pixel off the real `canvas.chart`, at CANVAS-LOCAL CSS coordinates — `affordance.pw.ts`'s
 *  own `probeChart` idiom, duplicated here (this file is staged standalone; nothing outside the
 *  staged set is importable, `kex2d-harness.md` "Standalone staging"). */
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

const dist = (a: readonly number[], b: readonly number[]): number =>
    Math.max(...a.map((v, i) => Math.abs(v - b[i])));

interface ForceUPt {
    id: number;
    section: number;
    s: number;
    g: number;
    u: number;
}

/** every force keyframe's own screen (x, y) — the SAME `markerX`/`yOf` projection
 *  `Timeline.svelte` draws the spike's boundaries/knobs through: `x = LEFT_GUT + u·pxPerU − pan`
 *  (`xView`, the live `view` state) and `y` off `gRange` (the live `yView` state), over the
 *  chart canvas's own CSS height. Sorted by `s` — `Segment.index`/boundary-index arithmetic
 *  (`segmentspike.ts`) addresses this same order. */
async function spikePointsXY(
    page: Page,
): Promise<{ x: number; y: number; s: number; g: number }[]> {
    const pts = ((await kexCall(page, "forceU")) as ForceUPt[]).slice().sort((a, b) => a.s - b.s);
    const [pan, pxPerU] = await kexCall(page, "xView");
    const [lo, hi] = await kexCall(page, "gRange");
    const box = await page.locator("canvas.chart").boundingBox();
    if (!box) throw new Error("chart canvas not laid out");
    const inner = box.height - CHART_BOT_PAD - CHART_TOP;
    return pts.map((p) => ({
        x: LEFT_GUT + p.u * pxPerU - pan,
        y: CHART_TOP + (1 - (p.g - lo) / (hi - lo)) * inner,
        s: p.s,
        g: p.g,
    }));
}

test("segment spike overlay renders behind ?spike=1 (S2)", async ({ page, boot }) => {
    await boot("/?spike=1");
    await expect(page.locator(".dock")).toBeVisible();
    await kexCall(page, "seedForceBump");
    // 5 points: the two convert seeds (0, len) plus the 3 bump keys (.2, .5, .8 × len) —
    // segments 0..3, sorted-by-s index i's own boundary set is [i, i+1].
    await expect.poll(() => kexCall(page, "forceCount")).toBe(5);
    await frameTimeline(page);

    const chartBox = await page.locator("canvas.chart").boundingBox();
    if (!chartBox) throw new Error("chart canvas not laid out");
    const toPage = (x: number, y: number): [number, number] => [chartBox.x + x, chartBox.y + y];
    const probeY = CHART_TOP + (chartBox.height - CHART_BOT_PAD - CHART_TOP) / 2;

    const pts = await spikePointsXY(page);
    expect(pts).toHaveLength(5);
    // segment 1 spans boundary 1 (.2L) -> boundary 2 (.5L, the airtime crest) — its own RIGHT
    // boundary is boundary 2, the duration-handle line the Approach singles out.
    const b1 = pts[1];
    const b2 = pts[2];
    const b3 = pts[3];
    const segBodyX = (b1.x + b2.x) / 2;

    // ── the arc draws: SOME line paints across the chart body — read a column at the segment's
    // own midpoint before anything is selected, as the baseline every later read compares
    // against (an empty chart with nothing painted would read the plain dock background here). ──
    const arcColorBefore = await probeChart(page, segBodyX, probeY);
    expect(arcColorBefore).not.toBeNull();

    // ── boundary lines draw, at REST (nothing selected): boundary 2's own rest tone is the
    // baseline for the selection reads below. ──
    const restB2 = await probeChart(page, b2.x, probeY);
    expect(restB2).not.toBeNull();

    // knob baseline: OFFSET from the boundary's own vertical line (outside its stroke width,
    // inside the knob's radius were one drawn there) — at rest, nothing paints past the thin
    // line itself, so this reads the plain background.
    const KnobProbeDx = 4;
    const restKnob1 = await probeChart(page, b1.x + KnobProbeDx, b1.y);
    const restKnob2 = await probeChart(page, b2.x + KnobProbeDx, b2.y);
    expect(restKnob1).not.toBeNull();
    expect(restKnob2).not.toBeNull();
    // boundary 3's own rest tone, read BEFORE the click below — the baseline the "an unselected
    // boundary must not react" assert compares against (a same-instant reread of live state would
    // pass vacuously regardless of whether boundary 3 actually holds still).
    const restB3 = await probeChart(page, b3.x, probeY);
    expect(restB3).not.toBeNull();

    // ── click segment 1's body → selects it (`spikeChartDown`, a plain click, no drag). Poll on
    // the pixel itself changing (the spike exposes no selection hook — this IS the condition,
    // the same instrument S4's own admissibility probe reads through). ──
    const [clickX, clickY] = toPage(segBodyX, probeY);
    await page.mouse.click(clickX, clickY);
    const SelTol = 8;
    await expect
        .poll(async () => {
            const c = await probeChart(page, b2.x, probeY);
            return c && restB2 ? dist(c, restB2) : 0;
        }, "boundary 2 (the active segment's own right boundary) must read apart from its rest tone once selected")
        .toBeGreaterThan(SelTol);
    const selB2 = await probeChart(page, b2.x, probeY);
    const selB1 = await probeChart(page, b1.x, probeY);
    expect(selB1).not.toBeNull();
    // boundary 1 (the active segment's own LEFT boundary) is also "selected" (thickness +
    // brightness, Approach), but the RIGHT boundary lifts one rung further (the hover rung
    // declaring its own duration-handle gesture, Channel check) — the two must read apart.
    if (selB1 && selB2)
        expect(
            dist(selB1, selB2),
            "the right boundary's hover-lifted tone must read apart from the plain selected tone",
        ).toBeGreaterThan(2);
    // boundary 3 (outside the selection entirely) stays at its rest tone.
    const unselB3 = await probeChart(page, b3.x, probeY);
    if (restB3 && unselB3)
        expect(
            dist(restB3, unselB3),
            "an unselected boundary must not react to another's selection",
        ).toBeLessThanOrEqual(2);

    // ── knobs appear at the active segment's own two boundaries only. ──
    const KnobTol = 8;
    await expect
        .poll(async () => {
            const c = await probeChart(page, b1.x + KnobProbeDx, b1.y);
            return c && restKnob1 ? dist(c, restKnob1) : 0;
        }, "a knob must paint at the active segment's own left boundary")
        .toBeGreaterThan(KnobTol);
    await expect
        .poll(async () => {
            const c = await probeChart(page, b2.x + KnobProbeDx, b2.y);
            return c && restKnob2 ? dist(c, restKnob2) : 0;
        }, "a knob must paint at the active segment's own right boundary")
        .toBeGreaterThan(KnobTol);

    await page.waitForTimeout(SHOT_MS);
    const strip = dockStrip(page);
    if (strip) await page.screenshot({ path: join(OUT, "spike-single-select.png"), clip: strip });

    // ── Shift-click segment 2's body → a multi-set {1, 2}. Knobs hide to signal the absent
    // controls (Approach "Knobs hide on a multi-set"): both single-selection knob reads must
    // fall back toward their rest tone. ──
    const seg2X = (b2.x + b3.x) / 2;
    const [shiftX, shiftY] = toPage(seg2X, probeY);
    await page.keyboard.down("Shift");
    await page.mouse.click(shiftX, shiftY);
    await page.keyboard.up("Shift");
    await expect
        .poll(async () => {
            const c = await probeChart(page, b2.x + KnobProbeDx, b2.y);
            return c && restKnob2 ? dist(c, restKnob2) : Number.POSITIVE_INFINITY;
        }, "the multi-set must hide the knob that was showing at boundary 2")
        .toBeLessThanOrEqual(KnobTol);
    await expect
        .poll(async () => {
            const c = await probeChart(page, b1.x + KnobProbeDx, b1.y);
            return c && restKnob1 ? dist(c, restKnob1) : Number.POSITIVE_INFINITY;
        }, "the multi-set must hide the knob that was showing at boundary 1")
        .toBeLessThanOrEqual(KnobTol);

    await page.waitForTimeout(SHOT_MS);
    if (strip) await page.screenshot({ path: join(OUT, "spike-multi-select.png"), clip: strip });
});

// ── read-only against the document: the spike exists ENTIRELY over a local copy — S2 adds no
// gesture (no drag lands until S3), so the whole flow above must leave the section's own
// authored keys byte-identical to what `seedForceBump` wrote. This is the S2 slice of C3 (S3
// owns the drag-sequence arm); it is already provable here since nothing in this stage writes. ──
test("segment spike overlay never writes the document (S2 slice of C3)", async ({ page, boot }) => {
    await boot("/?spike=1");
    await expect(page.locator(".dock")).toBeVisible();
    await kexCall(page, "seedForceBump");
    await expect.poll(() => kexCall(page, "forceCount")).toBe(5);
    await frameTimeline(page);
    const before = await kexCall(page, "forces");
    const undoBefore = await kexCall(page, "undoDepth");

    const pts = await spikePointsXY(page);
    const chartBox = await page.locator("canvas.chart").boundingBox();
    if (!chartBox) throw new Error("chart canvas not laid out");
    const probeY = CHART_TOP + (chartBox.height - CHART_BOT_PAD - CHART_TOP) / 2;
    const segBodyX = (pts[1].x + pts[2].x) / 2;
    await page.mouse.click(chartBox.x + segBodyX, chartBox.y + probeY);
    // a double-click over the chart is the production create gesture — dropped entirely while
    // armed (the `.chartzone`'s `ondblclick` is `undefined` under `spikeArmed`), so this must
    // stay a no-op too.
    await page.mouse.dblclick(chartBox.x + segBodyX, chartBox.y + probeY);

    expect(await kexCall(page, "forces")).toEqual(before);
    expect(await kexCall(page, "undoDepth")).toBe(undoBefore);
});

// ── S3 of kex2d-segment-spike (specs/kex2d-segment-spike.md): the four gestures — boundary-body
// horizontal drag (duration, ripple), knob vertical drag (value), double-click a knob (the
// handle layer, rendered through `segmentControls`, dragged locally), and the contextual popup's
// own typed duration field — plus C3's own drag-sequence arm: the section's force keys stay
// byte-identical across every one of them.
//
// Every predicted post-gesture pixel below is computed from the SAME affine projection
// `Timeline.svelte`'s `markerX`/`yOf` use (`x = LEFT_GUT + s·pxPerU − pan`, `y` off `gRange`,
// both EXACT inverses of `uAtPx`/`yToG` — `timeline.ts`'s `uToPx`/`pxToU`) — never read back off
// `forceU` (a PRODUCTION accessor over the untouched document, blind to the spike's own local
// edits), so a prediction here projects a value THIS FLOW chose, not a guess at what the app did.
test("segment spike gestures move what they name; the document stays read-only (S3)", async ({
    page,
    boot,
}) => {
    await boot("/?spike=1");
    await expect(page.locator(".dock")).toBeVisible();
    await kexCall(page, "seedForceBump");
    await expect.poll(() => kexCall(page, "forceCount")).toBe(5);
    await frameTimeline(page);

    const before = await kexCall(page, "forces");
    const undoBefore = await kexCall(page, "undoDepth");

    const [, pxPerU] = await kexCall(page, "xView");
    const pts = await spikePointsXY(page);
    const chartBox = await page.locator("canvas.chart").boundingBox();
    if (!chartBox) throw new Error("chart canvas not laid out");
    const toPage = (x: number, y: number): [number, number] => [chartBox.x + x, chartBox.y + y];
    const probeY = CHART_TOP + (chartBox.height - CHART_BOT_PAD - CHART_TOP) / 2;
    const KnobDx = 4; // off the vertical line's own body, onto the knob circle (S2's own convention)
    const Tol = 8;

    const a = pts[1]; // segment 1's own leading boundary — untouched by every gesture below
    const b0x = pts[2].x; // segment 1's trailing (duration-handle) boundary, at rest
    const b0y = pts[2].y;
    const c0x = pts[3].x; // the NEXT boundary — ripple's own visible signature

    // ── gesture 1: a horizontal drag on the boundary line's own body selects segment 1 (the
    // FIRST click here — nothing is selected yet, so no knob competes for the hit) and ripples
    // its duration: boundary 2 moves by the drag delta, and boundary 3 moves by the SAME delta
    // (ripple, never roll — Locked decision). ──
    const DurDx = 30;
    const restNewB = await probeChart(page, b0x + DurDx, probeY);
    const restNewC = await probeChart(page, c0x + DurDx, probeY);
    let [mx, my] = toPage(b0x, probeY);
    await page.mouse.move(mx, my);
    await page.mouse.down();
    [mx, my] = toPage(b0x + DurDx, probeY);
    await page.mouse.move(mx, my, { steps: 8 });
    await page.mouse.up();
    const b1x = b0x + DurDx;
    const c1x = c0x + DurDx;
    await expect
        .poll(async () => {
            const c = await probeChart(page, b1x, probeY);
            return c && restNewB ? dist(c, restNewB) : 0;
        }, "the duration-handle boundary must repaint at its post-drag station")
        .toBeGreaterThan(Tol);
    await expect
        .poll(async () => {
            const c = await probeChart(page, c1x, probeY);
            return c && restNewC ? dist(c, restNewC) : 0;
        }, "ripple's own signature: the NEXT boundary moves by the SAME delta")
        .toBeGreaterThan(Tol);

    // ── gesture 2: knob vertical drag -> value. segment 1 is now the active selection (the
    // boundary hit above resolved and selected it), so its own two knobs are live; grab the
    // trailing one at its post-ripple station (unchanged in g — Locked decision). ──
    const ValDy = -24;
    const restKnobTarget = await probeChart(page, b1x + KnobDx, b0y + ValDy);
    [mx, my] = toPage(b1x, b0y);
    await page.mouse.move(mx, my);
    await page.mouse.down();
    [mx, my] = toPage(b1x, b0y + ValDy);
    await page.mouse.move(mx, my, { steps: 8 });
    await page.mouse.up();
    await expect
        .poll(async () => {
            const c = await probeChart(page, b1x + KnobDx, b0y + ValDy);
            return c && restKnobTarget ? dist(c, restKnobTarget) : 0;
        }, "the value knob must repaint at its post-drag height")
        .toBeGreaterThan(Tol);

    // ── gesture 3: double-click a knob -> the handle layer (`segmentControls`'s own two control
    // points — the SAME evaluator the arc reads, no second geometry). double-click the
    // UNTOUCHED knob (segment 1's leading boundary) so its own screen position is exactly known,
    // and the predicted control-point station is a pure function of it. ──
    const spanX = b1x - a.x; // segment 1's post-ripple screen span
    const p1x = a.x + spanX / 3; // Cubic default: flat tangent at 1/3 influence (profile.ts)
    const p1y = a.y; // flat (Δg = 0)
    const restHandle = await probeChart(page, p1x, p1y);
    [mx, my] = toPage(a.x, a.y);
    await page.mouse.dblclick(mx, my);
    await expect
        .poll(async () => {
            const c = await probeChart(page, p1x, p1y);
            return c && restHandle ? dist(c, restHandle) : 0;
        }, "the handle layer's own control point must paint at its Cubic-default station")
        .toBeGreaterThan(Tol);
    // dragged LOCALLY: pull the control point vertically, never the arc's own baked recovery —
    // the same evaluator, a different local offset.
    const HDrag = 16;
    const restHandleMoved = await probeChart(page, p1x, p1y - HDrag);
    [mx, my] = toPage(p1x, p1y);
    await page.mouse.move(mx, my);
    await page.mouse.down();
    [mx, my] = toPage(p1x, p1y - HDrag);
    await page.mouse.move(mx, my, { steps: 6 });
    await page.mouse.up();
    await expect
        .poll(async () => {
            const c = await probeChart(page, p1x, p1y - HDrag);
            return c && restHandleMoved ? dist(c, restHandleMoved) : 0;
        }, "the dragged control point must repaint at its new local station")
        .toBeGreaterThan(Tol);

    // exit the handle layer (a miss on both its own control points) and reselect segment 1, so
    // the contextual popup (single-selection only, hidden while the handle layer is open) shows.
    [mx, my] = toPage((a.x + b1x) / 2, probeY);
    await page.mouse.click(mx, my);

    // ── gesture 4: the contextual popup's own typed duration field — the OTHER route to the
    // SAME ripple law gesture 1 drove by hand (Approach "A contextual popup at the selection is
    // the other route to duration"). ──
    const durInput = page.getByLabel("Segment duration (m)");
    await expect(durInput).toBeVisible();
    await expect(page.getByLabel("Boundary value (g)")).toBeVisible();
    await expect(page.getByLabel("Segment easing")).toBeVisible();
    const curDur = (b1x - a.x) / pxPerU;
    const newDur = curDur + 5;
    const b2x = a.x + newDur * pxPerU;
    const restPopupTarget = await probeChart(page, b2x, probeY);
    await durInput.fill(String(newDur));
    await durInput.blur();
    await expect
        .poll(async () => {
            const c = await probeChart(page, b2x, probeY);
            return c && restPopupTarget ? dist(c, restPopupTarget) : 0;
        }, "the popup's own duration field must ripple the boundary exactly like the direct drag")
        .toBeGreaterThan(Tol);

    // "More settings" reveals the direction axis — display-only (Channel check: the substrate
    // carries no direction concept), so this confirms the affordance exists without asserting a
    // functional hook that doesn't exist.
    await page.getByRole("button", { name: /more/i }).click();
    await expect(page.getByLabel(/Easing direction/)).toBeVisible();

    // ── C3: read-only against the document, over EVERY gesture above. ──
    expect(await kexCall(page, "forces")).toEqual(before);
    expect(await kexCall(page, "undoDepth")).toBe(undoBefore);
});
