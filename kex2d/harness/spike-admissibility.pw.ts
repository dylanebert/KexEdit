// kex2d's SEGMENT SPIKE ADMISSIBILITY capture flow (`kex2d-segment-spike` S4,
// specs/kex2d-segment-spike.md): before a person's look is spent on the spike, measure that the
// artifact varies along the three axes the look is about (taste.md § "Instrument the gate's own
// inputs before presenting them" — nothing validates that an artifact varies along the axis it
// claims to, so this flow does, ahead of C5's hostile read):
//
//   (a) a selected boundary reads apart from an unselected one, at the SAME instant
//   (b) knobs paint on a single selection and fall back to their rest tone on a multi-set —
//       the null control (an unarmed instrument would read the same on both sides)
//   (c) a duration drag on one boundary measurably moves the NEXT boundary too — ripple's only
//       visible signature, and the whole reason this spike exists over the rejected "roll" law
//
// Same instrument S2/S3's own spike.pw.ts already carries — a real pixel off the live
// `canvas.chart` via `getImageData` (`affordance.pw.ts`'s file-local `probeChart` idiom,
// duplicated here per `kex2d-harness.md` "Standalone staging": this file is staged alone, nothing
// outside the staged set is importable). This flow does not re-test that the gestures land
// (spike.pw.ts's own C2/C3 arms own that) — it exists to print the three readings as labeled
// numbers so they can be pasted verbatim into the spec's fold rather than restated by hand, and to
// fail loud if any of the three axes reads flat.

import {
    test,
    expect,
    kexCall,
    frameTimeline,
    CHART_TOP,
    CHART_BOT_PAD,
    LEFT_GUT,
    type Page,
} from "./flow";

/** a pixel off the real `canvas.chart`, at CANVAS-LOCAL CSS coordinates — `affordance.pw.ts`'s
 *  own `probeChart` idiom, duplicated here (this file is staged standalone; nothing outside the
 *  staged set is importable, `kex2d-harness.md` "Standalone staging"). Identical to spike.pw.ts's
 *  own copy — three copies of one idiom in this harness now, all file-local by the same rule. */
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
 *  `Timeline.svelte` draws the spike's boundaries/knobs through, mirrored from spike.pw.ts. */
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

test("segment spike admissibility: selection, the null control, and ripple's signature (S4)", async ({
    page,
    boot,
}) => {
    await boot("/?spike=1");
    await expect(page.locator(".dock")).toBeVisible();
    await kexCall(page, "seedForceBump");
    // 5 points: the two convert seeds (0, len) plus the 3 bump keys — segments 0..3, sorted-by-s
    // index i's own boundary set is [i, i+1] (spike.pw.ts's own convention).
    await expect.poll(() => kexCall(page, "forceCount")).toBe(5);
    await frameTimeline(page);

    const chartBox = await page.locator("canvas.chart").boundingBox();
    if (!chartBox) throw new Error("chart canvas not laid out");
    const toPage = (x: number, y: number): [number, number] => [chartBox.x + x, chartBox.y + y];
    const probeY = CHART_TOP + (chartBox.height - CHART_BOT_PAD - CHART_TOP) / 2;

    const [, pxPerU] = await kexCall(page, "xView");
    const pts = await spikePointsXY(page);
    expect(pts).toHaveLength(5);
    const b1 = pts[1]; // segment 1's own leading boundary
    const b2 = pts[2]; // segment 1's own trailing (duration-handle) boundary
    const b3 = pts[3]; // the NEXT boundary — ripple's own visible signature
    const segBodyX = (b1.x + b2.x) / 2;
    const KnobProbeDx = 4; // off the vertical line's own body, onto the knob circle

    // rest tones, read BEFORE anything is selected — the baseline every poll below waits against
    // (a same-instant reread of live state would pass vacuously regardless of whether the paint
    // actually settled).
    const restKnob1 = await probeChart(page, b1.x + KnobProbeDx, b1.y);
    const restB2 = await probeChart(page, b2.x, probeY);

    // ── select segment 1 (a plain click on its body — nothing is selected yet, so no knob
    // competes for the hit). ──
    const [clickX, clickY] = toPage(segBodyX, probeY);
    await page.mouse.click(clickX, clickY);
    await expect
        .poll(async () => {
            const c = await probeChart(page, b2.x, probeY);
            return c && restB2 ? dist(c, restB2) : 0;
        }, "boundary 2 must repaint once selected")
        .toBeGreaterThan(8);

    // ── (a) a selected boundary differs measurably from an unselected one, AT THE SAME instant. ──
    const selB2 = await probeChart(page, b2.x, probeY); // selected (segment 1's own right boundary)
    const unselB3 = await probeChart(page, b3.x, probeY); // unselected (outside the selection)
    if (!selB2 || !unselB3) throw new Error("selection reading came back null off the canvas");
    const readingA = dist(selB2, unselB3);
    console.log(
        `READING (a) selected-vs-unselected boundary: dist=${readingA} rgb (compared at boundary 2 [selected] vs boundary 3 [unselected], same instant, max-channel distance in [0,255])`,
    );
    expect(readingA, "a selected boundary must read apart from an unselected one").toBeGreaterThan(
        8,
    );

    // ── (b) knobs present on a single selection, absent on a multi-set — the null control. ──
    const selKnob1 = await probeChart(page, b1.x + KnobProbeDx, b1.y);
    if (!selKnob1 || !restKnob1) throw new Error("knob reading came back null off the canvas");
    const readingBPresent = dist(selKnob1, restKnob1);
    console.log(
        `READING (b) knob present on single selection: dist=${readingBPresent} rgb (boundary 1's knob paint vs its own pre-selection rest tone, max-channel distance in [0,255])`,
    );
    expect(readingBPresent, "a knob must paint on a single selection").toBeGreaterThan(8);

    // shift-click segment 2's body → a multi-set {1, 2}. Knobs hide (Approach "Knobs hide on a
    // multi-set") — the null control: the same probe must now read back TOWARD rest.
    const seg2X = (b2.x + b3.x) / 2;
    const [shiftX, shiftY] = toPage(seg2X, probeY);
    await page.keyboard.down("Shift");
    await page.mouse.click(shiftX, shiftY);
    await page.keyboard.up("Shift");
    await expect
        .poll(async () => {
            const c = await probeChart(page, b1.x + KnobProbeDx, b1.y);
            return c && restKnob1 ? dist(c, restKnob1) : Number.POSITIVE_INFINITY;
        }, "the multi-set must hide the knob that was showing at boundary 1")
        .toBeLessThanOrEqual(8);
    const multiKnob1 = await probeChart(page, b1.x + KnobProbeDx, b1.y);
    if (!multiKnob1 || !restKnob1) throw new Error("multi-set knob reading came back null");
    const readingBAbsent = dist(multiKnob1, restKnob1);
    console.log(
        `READING (b) knob absent on multi-set (null control): dist=${readingBAbsent} rgb (same probe point, boundary 1's knob paint vs its own pre-selection rest tone, now with a multi-set active)`,
    );
    expect(
        readingBAbsent,
        "the null control: a knob must NOT paint on a multi-set",
    ).toBeLessThanOrEqual(8);

    // ── (c) one duration drag measurably moves the boundary AFTER the dragged one — ripple's
    // only visible signature. Click away first (deselect the multi-set), reselect segment 1 via
    // the same boundary-body drag spike.pw.ts's own gesture 1 uses (the FIRST touch on the
    // boundary both selects segment 1 and drags its duration in one gesture). ──
    const DurDx = 30;
    const restNewB2 = await probeChart(page, b2.x + DurDx, probeY);
    const restNewB3 = await probeChart(page, b3.x + DurDx, probeY);
    let [mx, my] = toPage(b2.x, probeY);
    await page.mouse.move(mx, my);
    await page.mouse.down();
    [mx, my] = toPage(b2.x + DurDx, probeY);
    await page.mouse.move(mx, my, { steps: 8 });
    await page.mouse.up();
    await expect
        .poll(async () => {
            const c = await probeChart(page, b2.x + DurDx, probeY);
            return c && restNewB2 ? dist(c, restNewB2) : 0;
        }, "the dragged boundary must repaint at its post-drag station")
        .toBeGreaterThan(8);
    const draggedB2 = await probeChart(page, b2.x + DurDx, probeY);
    const rippledB3 = await probeChart(page, b3.x + DurDx, probeY);
    if (!draggedB2 || !restNewB2 || !rippledB3 || !restNewB3)
        throw new Error("ripple reading came back null off the canvas");
    const readingCDragged = dist(draggedB2, restNewB2);
    const readingCRippled = dist(rippledB3, restNewB3);
    const dragDeltaU = DurDx / pxPerU;
    console.log(
        `READING (c) ripple signature: dragged boundary moved by ${DurDx}px (${dragDeltaU.toFixed(3)} u) — repaint dist=${readingCDragged} rgb at its new station; ` +
            `the NEXT boundary (undragged, one segment over) repaints dist=${readingCRippled} rgb at the SAME +${DurDx}px offset, confirming it moved by the identical delta (ripple, not roll)`,
    );
    expect(readingCDragged, "the dragged boundary must have moved").toBeGreaterThan(8);
    expect(
        readingCRippled,
        "ripple's own signature: the boundary AFTER the dragged one must also have moved, by the same delta",
    ).toBeGreaterThan(8);
});
