// kex2d's FORCE-authoring capture flows (the timeline chart, its keyframes, handles, easing menu,
// and the snap tool rail). Shared helpers + the `__kex` typed hook live in `./flow`.

import {
    test,
    expect,
    join,
    OUT,
    SHOT_MS,
    kexCall,
    seedHill,
    frameTimeline,
    clickFlyout,
    clickMenuItem,
    menuGrammar,
    marqueeDrag,
    dockStrip,
    overlaps,
    CHART_TOP,
    CHART_BOT_PAD,
    TIP_REACH,
    GROW_LO,
    SNAP_DEG,
    SNAP_LEN,
    SNAP_DEG_MIN,
    SNAP_DEG_MAX,
    SAMPLE_BUDGET_M,
    frames,
    type Page,
} from "./flow";

// Screenshot the TIMELINE TOOL RAIL (kex2d-authoring-surface): the thin icon-only strip on the
// dock's left edge that is the snap magnet's home (the Premiere vertical tool-strip precedent, a
// dock affordance — not a viewport overlay, not a second dock). Assert the toggle's lit/dimmed
// state rides `aria-pressed` (positive, not absence-of-error), and capture the default-on and
// toggled-off looks. `S` toggles it globally (the AE magnet key, not hover-gated).
//
// Then the magnet's SNAP-INCREMENT popover, summoned by right-click on that same button
// (Blender/Godot: the increments live on the snap control): the two quanta fields, their scrub
// handle, and the per-user persistence — the typed value survives a page reload, which is the whole
// point of the localStorage home and can only be proven in a real browser.
test("tool rail shot", async ({ page, boot }) => {
    await boot();

    const rail = page.locator(".tool-rail");
    // `.rail-snap` names the MAGNET specifically (the rail is magnet-only — the domain picker
    // lives on the ruler's own context menu, kex2d-time-domain).
    const snap = rail.locator(".rail-snap");
    await expect(rail).toBeVisible();
    // default-on: the magnet toggle reads pressed and lit.
    await expect(snap).toHaveAttribute("aria-pressed", "true");
    await page.waitForTimeout(SHOT_MS);
    await rail.screenshot({ path: join(OUT, "tool-rail-on.png") });

    // ── S toggles it off (global, the AE magnet key) → aria-pressed flips, the icon dims. ──
    await page.keyboard.press("s");
    await expect(snap).toHaveAttribute("aria-pressed", "false");
    await page.waitForTimeout(SHOT_MS);
    await rail.screenshot({ path: join(OUT, "tool-rail-off.png") });

    // S again restores the default — keep the toggle honest across the flow.
    await page.keyboard.press("s");
    await expect(snap).toHaveAttribute("aria-pressed", "true");

    // ── right-click the magnet → its increments popover, at the shipped defaults (5° / 1 m). ──
    const undoDepth = () => kexCall(page, "undoDepth");
    const pop = page.locator(".snap-pop");
    const angleField = pop.locator('input[aria-label="Snap angle increment (degrees)"]');
    const lenField = pop.locator('input[aria-label="Snap length increment (m)"]');
    await snap.click({ button: "right" });
    await expect(pop).toBeVisible();
    await expect(angleField).toHaveValue(SNAP_DEG);
    await expect(lenField).toHaveValue(SNAP_LEN);
    const undoBefore = await undoDepth();
    // the field is reachable where it actually paints — a selector-targeted assert proves nothing
    // about a box a human pointer can hit (the menus law: verify pointer-true).
    const fb = await angleField.boundingBox();
    if (!fb) throw new Error("snap angle field not laid out");
    expect(
        await page.evaluate(
            (p) => document.elementFromPoint(p.x, p.y)?.getAttribute("aria-label") ?? null,
            { x: fb.x + fb.width / 2, y: fb.y + fb.height / 2 },
        ),
    ).toBe("Snap angle increment (degrees)");
    await page.waitForTimeout(SHOT_MS);
    const strip = dockStrip(page);
    if (strip) await page.screenshot({ path: join(OUT, "tool-rail-increments.png"), clip: strip });

    // ── the key label is the field idiom's scrub handle: slide right → the increment rises. ──
    const key = pop.locator(".fld").first().locator(".key");
    const kb = await key.boundingBox();
    if (!kb) throw new Error("snap angle scrub handle not laid out");
    await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2);
    await page.mouse.down();
    await page.mouse.move(kb.x + kb.width / 2 + 80, kb.y + kb.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect
        .poll(async () => Number(await angleField.inputValue()))
        .toBeGreaterThan(Number(SNAP_DEG));

    // ── a typed value persists per user: it survives a full reload (localStorage, no document). ──
    await angleField.fill("12");
    await angleField.press("Enter");
    await expect(angleField).toHaveValue("12");
    // neither write is an authoring edit — a preference must not land on the undo stack (every other
    // field in this app commits a history entry, so this is the invariant a next author would break).
    expect(await undoDepth()).toBe(undoBefore);
    await page.reload({ waitUntil: "load" });
    await expect(page.locator(".dock")).toBeVisible();
    await snap.click({ button: "right" });
    await expect(pop).toBeVisible();
    await expect(angleField).toHaveValue("12");

    // both range ends clamp, and the FIELD is corrected to the clamped value — a rejected entry left
    // on screen would have the popover lying about the live grid. The ceiling matters because the
    // value persists: an extreme typed once would otherwise collapse the control across reloads.
    await angleField.fill("0.4");
    await angleField.press("Enter");
    await expect(angleField).toHaveValue(SNAP_DEG_MIN);
    // one frame between the two clamps: the field is CONTROLLED, so the correction above is a
    // store write the per-RAF projection paints back into the input. `toHaveValue` proves the
    // write-back arrived once, not that another flush isn't pending — and a pending flush lands
    // ON TOP of the next `fill`, so the Enter after it commits the OLD value. Measured once in 9
    // full runs at `KEX_WORKERS=1` (0 in 10 isolated): the ceiling assert read "1", the floor's
    // own clamped value, with "400" never in the field at all. Awaiting frames in the page is the
    // sanctioned wait for a tick-projected value (`kex2d-harness.md`, the settle idiom).
    await frames(page, 1);
    await angleField.fill("400");
    await angleField.press("Enter");
    await expect(angleField).toHaveValue(SNAP_DEG_MAX);
});

// Drive the FORCE-AUTHORING flow: a geo track →
// convert to force via the __kex hook (seeding setup — the destructive Convert menu row was
// removed, kex2d-geoforce-editor stage 5; `convertSection` and this hook onto it stay) → author
// an airtime bump by force points and the real menu/handle gestures → convert back to geo via
// the same hook → undo, which restores the force track with its points byte-identical.
test("force authoring flow", async ({ page, boot }) => {
    await boot();

    const kind = () => kexCall(page, "kind");
    const nodeCount = () => kexCall(page, "nodeCount");
    const forceCount = () => kexCall(page, "forceCount");
    const forces = () => kexCall(page, "forces");
    const forceEases = () => kexCall(page, "forceEases");
    const forceTangents = () => kexCall(page, "forceTangents");
    const undoDepth = () => kexCall(page, "undoDepth");
    const tTotal = () => kexCall(page, "tTotal");

    // seed a shaped geo track so the convert inherits a real arclength.
    await seedHill(page);
    expect(await kind()).toBe(0); // TrackKind.Geo
    const tGeo = await tTotal(); // the hill's own bake — the convert's shot waits for this to MOVE

    // ── 1. Convert to force via the __kex hook (setup — the row that drove this through the
    // real menu was removed) → stage B seeds two continuation keyframes at the recovered entry
    // force, not an empty profile. this is the FIRST (and only) section, so its entry sample
    // is 0 — no upstream edge — and the seed falls back to DEFAULT_G (1g): assert the seed
    // CONTRACT itself (two keys at (0, F_entry) and (length, F_entry)), not just the count. ──
    await kexCall(page, "convert");
    await expect.poll(kind).toBe(1); // TrackKind.Force
    await expect.poll(nodeCount).toBe(0);
    await expect.poll(forceCount).toBe(2); // the two seeds (stage B), not an empty profile
    expect(await forces()).toEqual([
        { s: 0, g: 1 }, // (0, F_entry) — F_entry = DEFAULT_G, the track-start fallback
        { s: 24, g: 1 }, // (length, F_entry) — length = DEFAULT_FORCE_LEN (EXTEND_DIST)
    ]);
    // the flat force track BAKED — `tTotal > 0` was already true of the pre-convert geo bake, so
    // only a CHANGE proves the shot below shows the converted track (the bake-readiness law).
    await expect.poll(tTotal).not.toBe(tGeo);
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "force-1-empty.png") });

    // ── 2. Author an airtime bump by force points → the recovered curve reacts. seedForceBump
    // adds 3 points on top of the 2 seeds → 5. ──
    await kexCall(page, "seedForceBump");
    await expect.poll(forceCount).toBe(5);
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "force-2-bump.png") });
    const strip = dockStrip(page);
    if (strip) await page.screenshot({ path: join(OUT, "force-timeline.png"), clip: strip });

    // ── 2b. Double-click the chart inserts a point ON the authored profile (the
    // envelope-insertion identity): between the leading seed (s=0) and the first bump
    // shoulder (s≈4.8) the profile holds a flat 1g, so the new point's g must be 1 regardless
    // of the cursor's y (which lands well off 1g here). the seeds now flank that gap, so the
    // target x is measured off the force clip's own box (10% in), clear of both keyframes'
    // fat hit-circles, rather than a fixed offset from the dock edge. identify the CREATED
    // point (not just rows[0], which is now always the s=0 seed) by diffing before/after. ──
    const body = page.locator(".dock .body");
    const box = await body.boundingBox();
    const fcb = await page.locator(".clip").first().boundingBox();
    if (!box || !fcb) throw new Error("timeline body / force clip not laid out");
    const before6 = await forces();
    await page.mouse.dblclick(fcb.x + fcb.width * 0.1, box.y + box.height * 0.35);
    await expect.poll(forceCount).toBe(6);
    // the create selects the point, so its popover is up — capture it for the feel pass
    // (let its 120ms fade-in finish, or the shot catches a ghost).
    await page.waitForTimeout(SHOT_MS);
    if (strip) await page.screenshot({ path: join(OUT, "force-popover.png"), clip: strip });
    const after6 = await forces();
    const created = after6.find((p) => !before6.some((b) => Math.abs(b.s - p.s) < 1e-6));
    if (!created) throw new Error("the newly inserted point wasn't found by s-diff");
    expect(created.g).toBeCloseTo(1, 5); // resolved on the profile, not at the cursor

    // ── 2b″. The `scrubStart` label-scrub button guard (kex2d-gesture-residue stage 5): the
    // shared `labelScrub` helper's `e.button !== 0` check is new for `scrubStart` — before this
    // stage only `snapScrub` carried it, so a right-press on this keyframe's "F" (g) label opened
    // a drag alongside the browser's native context menu underneath it. RED-RIG TRAP: the
    // left-press-drag just below is the positive control — it proves this rig can detect both a
    // real g write and a real gesture opening (`#app[data-dragging]`) — so the right-press check
    // that follows can't pass vacuously. Scrubs the g (not s) label so the created point stays
    // identifiable by its unmoved s. ──
    const gKey = page.locator(".ptip .fld").nth(1).locator(".key");
    const gKeyBox = await gKey.boundingBox();
    if (!gKeyBox) throw new Error("point g scrub handle not laid out");
    const findByS = async (s: number): Promise<number | undefined> =>
        (await forces()).find((p) => Math.abs(p.s - s) < 1e-6)?.g;
    const beforeLeftG = await findByS(created.s);
    if (beforeLeftG === undefined) throw new Error("created point not found for the scrub guard");
    await page.mouse.move(gKeyBox.x + gKeyBox.width / 2, gKeyBox.y + gKeyBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(gKeyBox.x + gKeyBox.width / 2 + 40, gKeyBox.y + gKeyBox.height / 2, {
        steps: 10,
    });
    await page.mouse.up();
    await expect.poll(() => findByS(created.s)).not.toBe(beforeLeftG); // positive control: it moves
    const afterLeftG = await findByS(created.s);

    // the guard itself: a right-press-drag on the SAME label must write nothing and open no
    // gesture — checked mid-drag, not only after release.
    await page.mouse.move(gKeyBox.x + gKeyBox.width / 2, gKeyBox.y + gKeyBox.height / 2);
    await page.mouse.down({ button: "right" });
    await frames(page, 2);
    await expect(page.locator("#app[data-dragging]")).toHaveCount(0); // no gesture opened
    await page.mouse.move(gKeyBox.x + gKeyBox.width / 2 + 40, gKeyBox.y + gKeyBox.height / 2, {
        steps: 10,
    });
    await frames(page, 2);
    await expect(page.locator("#app[data-dragging]")).toHaveCount(0); // still none, under movement
    await page.mouse.up({ button: "right" });
    expect(await findByS(created.s)).toBe(afterLeftG); // no write

    await page.keyboard.press("Control+z"); // undo the positive-control scrub
    await expect.poll(() => findByS(created.s)).toBeCloseTo(created.g, 5);
    await page.keyboard.press("Control+z"); // undo the point creation itself
    await expect.poll(forceCount).toBe(5);

    // ── 2b′. A Ctrl/Cmd drag frees the VALUE but never the per-axis gesture-start magnet (the
    // reframed contract, kex2d-force-ux): held within SNAP_PX horizontally, the crest's s pins
    // back to its exact grab while its g moves continuously off the 0.1 g grid. This is the
    // positive end-to-end proof the axis magnet survives the bypass; snapAxis's bypass-magnet
    // unit test is the oracle. Undo restores the crest for the rest of the flow. ──
    await frameTimeline(page); // frame the section so the .fhit boxes are well-placed
    const beforeCtrl = [...(await forces())].sort((a, b) => a.s - b.s);
    const crestHit = await page.locator(".fhit").nth(2).boundingBox(); // middle by x = interior
    if (!crestHit) throw new Error("crest hit target not laid out");
    const cxC = crestHit.x + crestHit.width / 2;
    const cyC = crestHit.y + crestHit.height / 2;
    await page.mouse.move(cxC, cyC);
    await page.mouse.down();
    await page.keyboard.down("Control"); // bypass held live, read per pointermove
    await page.mouse.move(cxC + 6, cyC - 55, { steps: 8 }); // dx < SNAP_PX (magnet), dy large
    await page.mouse.up();
    await page.keyboard.up("Control");
    const afterCtrl = [...(await forces())].sort((a, b) => a.s - b.s);
    expect(afterCtrl[2].s).toBeCloseTo(beforeCtrl[2].s, 2); // s pinned to its grab despite Ctrl
    expect(Math.abs(afterCtrl[2].g - beforeCtrl[2].g)).toBeGreaterThan(0.1); // g moved freely
    await page.keyboard.press("Control+z"); // restore the crest
    await expect
        .poll(async () => (await forces()).sort((a, b) => a.s - b.s)[2].g)
        .toBeCloseTo(beforeCtrl[2].g, 5);
    await page.keyboard.press("Escape"); // deselect: clear the crest's .ptip before 2c right-clicks

    // ── 2c. Seeded-keys extension (stage E): set the leading seed's easing via the real,
    // pointer-true keyframe menu, then drag its out-handle to author an explicit tangent
    // (the segment reads Custom), then undo both. exercises the __kex ease/tangent hooks
    // stage C landed against a keyframe that only exists because of stage B's seeding. ──
    await frameTimeline(page); // bring the whole section into view for the diamond DOM boxes
    expect((await forceEases())[0]).toBe(1); // Easing.Cubic — the fresh-seed default
    await page.locator(".fpt").first().click({ button: "right" }); // the leading seed (s=0)
    await expect(page.locator(".fmenu")).toBeVisible();
    await clickFlyout(page, ".fmenu", "Easing", "Quintic");
    await expect(page.locator(".fmenu")).toHaveCount(0);
    await expect.poll(async () => (await forceEases())[0]).toBe(2); // Easing.Quintic

    await page.locator(".fpt").first().dblclick(); // handle-edit sub-mode on the same seed
    await expect.poll(() => kexCall(page, "forceEditing")).toBe(true);
    const seedKnob = await page.locator(".thit").first().boundingBox(); // its one out-handle
    if (!seedKnob) throw new Error("seed handle knob not laid out");
    await page.mouse.move(seedKnob.x + seedKnob.width / 2, seedKnob.y + seedKnob.height / 2);
    await page.mouse.down();
    await page.mouse.move(
        seedKnob.x + seedKnob.width / 2 + 24,
        seedKnob.y + seedKnob.height / 2 - 40,
        { steps: 6 },
    );
    await page.mouse.up();
    await expect.poll(async () => (await forceTangents())[0] !== null).toBe(true);
    expect(await undoDepth()).toBeGreaterThan(0);

    // undo the handle drag, then the easing set — both revert cleanly.
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await forceTangents())[0] === null).toBe(true);
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await forceEases())[0]).toBe(1); // back to Cubic

    // ── 2d. Handle-drag gesture-start axis magnet (F1, the geo `latchAngle` mechanism):
    // the seed derives from Cubic, so its out-handle ghost is FLAT (dg=0) → a horizontal
    // grab ray. dragging it far along x with a small vertical wander (|dy| < LATCH_PX = 8)
    // stays latched to the ray, so the authored out-handle keeps dg≈0 — the "keep it flat"
    // affordance. the big diagonal in 2c above left the corridor and freed dg, so this is
    // the positive proof that the magnet fires (red without the latch: dy maps to ~0.08 g). ──
    await page.keyboard.press("Escape"); // exit any lingering handle-edit, then re-enter clean
    await page.locator(".fpt").first().dblclick();
    await expect.poll(() => kexCall(page, "forceEditing")).toBe(true);
    const flatKnob = await page.locator(".thit").first().boundingBox();
    if (!flatKnob) throw new Error("seed handle knob not laid out for the magnet drag");
    const fkx = flatKnob.x + flatKnob.width / 2;
    const fky = flatKnob.y + flatKnob.height / 2;
    await page.mouse.move(fkx, fky);
    await page.mouse.down();
    await page.mouse.move(fkx + 40, fky - 5, { steps: 6 }); // dx large, |dy| < LATCH_PX
    await page.mouse.up();
    const magnetTan = (await forceTangents())[0] as { outDs: number; outDg: number } | null;
    if (!magnetTan) throw new Error("magnet drag authored no handle");
    expect(Math.abs(magnetTan.outDg)).toBeLessThan(1e-4); // g pinned flat by the axis magnet
    expect(magnetTan.outDs).toBeGreaterThan(0); // s grew — it moved, not a no-op
    await page.keyboard.press("Control+z"); // revert so the flow resumes from the derived seed
    await expect.poll(async () => (await forceTangents())[0] === null).toBe(true);

    // ── 3. Convert back to geo via the __kex hook (setup, per step 1) → destructive reset to
    // the flat two-node seed. ──
    await kexCall(page, "convert");
    await expect.poll(kind).toBe(0);
    await expect.poll(nodeCount).toBe(2); // the flat seed
    expect(await forceCount()).toBe(0);
    await page.screenshot({ path: join(OUT, "force-3-geo.png") });

    // ── 4. Undo the convert → the force track + its points restored byte-identical (the
    // two seeds + the three bump points — the easing/handle edits above were already undone,
    // so this is exactly the pre-convert-to-geo state). ──
    await page.keyboard.press("Control+z");
    await expect.poll(kind).toBe(1);
    await expect.poll(forceCount).toBe(5);
});

// S1 capture arm (F3): the keyboard handler's FORCE-keyframe arrow-nudge branch
// (Timeline.svelte:3862-3906) — the strip-keyframe nudge arm's parity twin, both riding the
// SAME named `nudgeKeyframes` (`timeline.ts`) through the production handler (S1's locked
// oracle standard: one arm per kind through the one named path, never presence). Converts to
// force, seeds the airtime-bump profile (2 seeds + 3 authored = 5, the crest at index 2
// sorted by s — identified by its unique g=0 rather than an id the `forces()` hook doesn't
// carry), clicks it to select, presses ArrowRight and asserts it moved to the next 0.1 grid
// station (NUDGE_S, `timeline.ts`'s single-member nudge: s -> round((s + 0.1) * 10) / 10),
// then ArrowLeft to nudge back.
test("force keyframe arrow-nudge", async ({ page, boot }) => {
    await boot();
    await seedHill(page);
    await frameTimeline(page);

    const forces = () => kexCall(page, "forces") as Promise<{ s: number; g: number }[]>;
    const forceCount = () => kexCall(page, "forceCount");
    const forceSelIds = () => kexCall(page, "forceSelIds") as Promise<number[]>;
    const xView = () => kexCall(page, "xView") as Promise<[number, number]>;
    const gRange = () => kexCall(page, "gRange") as Promise<[number, number]>;

    await kexCall(page, "convert");
    await expect.poll(forceCount).toBe(2); // the two continuation seeds
    await kexCall(page, "seedForceBump");
    await expect.poll(forceCount).toBe(5); // + the airtime dip's 3 authored points
    await frameTimeline(page); // re-frame — convert/seed changed the section's own extent

    const rows = (await forces()).slice().sort((a, b) => a.s - b.s);
    const crest = rows.find((p) => p.g === 0); // the airtime dip — g=0 is unique among the 5
    if (!crest) throw new Error("airtime-dip crest not found");

    const [, pxPerU] = await xView();
    const [gLo, gHi] = await gRange();
    const clipBb = await page.locator(".clip").first().boundingBox();
    const dockBb = await page.locator(".dock .body").boundingBox();
    if (!clipBb || !dockBb) throw new Error("clip / dock body not laid out");
    const chartTop = dockBb.y + CHART_TOP;
    const chartBot = dockBb.y + dockBb.height - CHART_BOT_PAD;
    const gToY = (g: number): number =>
        chartTop + (1 - (g - gLo) / (gHi - gLo)) * (chartBot - chartTop);
    const crestX = clipBb.x + crest.s * pxPerU;
    const crestY = gToY(crest.g);

    // click the crest diamond to select it (a real pointer event through `keyframeDown`).
    await page.mouse.click(crestX, crestY);
    await expect.poll(async () => (await forceSelIds()).length).toBe(1);
    await frames(page, 1); // let the per-RAF tick propagate the selection to `forcePts`

    // Press ArrowRight -> the crest must move by NUDGE_S (0.1), rounded to the 0.1 grid
    // (the single-member nudge rounds the absolute result: s -> round((s + 0.1) * 10) / 10).
    const sBefore = crest.s;
    await page.keyboard.press("ArrowRight");
    await frames(page, 1);
    let after = (await forces()).find((p) => p.g === 0);
    if (!after) throw new Error("crest lost after ArrowRight");
    const expectedSRight = Math.round((sBefore + 0.1) * 10) / 10;
    expect(after.s).toBeCloseTo(expectedSRight, 5);
    expect(after.s).toBeGreaterThan(sBefore); // it moved right
    const sAfterRight = after.s;

    // Press ArrowLeft to nudge back — confirms the handler processes ArrowLeft too (the
    // shared `nudgeKeyframes` call the strip-side arm already pins from its own handler).
    await page.keyboard.press("ArrowLeft");
    await frames(page, 1);
    after = (await forces()).find((p) => p.g === 0);
    if (!after) throw new Error("crest lost after ArrowLeft");
    const expectedSLeft = Math.round((sAfterRight - 0.1) * 10) / 10;
    expect(after.s).toBeCloseTo(expectedSLeft, 5); // nudged left, on the 0.1 grid
    expect(after.s).toBeLessThan(sAfterRight); // it moved left
});

// Drive the FORCE EASING MENU + HANDLE-EDIT flow (kex2d-force-ux stage C, extended at stage
// E): seed a force section with keyframes → RIGHT-CLICK a diamond for the keyframe menu →
// open the Easing ▸ submenu and set Linear POINTER-TRUE (clickFlyout — the regression net for
// the context-submenu clip class) → assert the leading keyframe's tag flipped → RIGHT-CLICK
// the CURVE SPAN between two keyframes (not a diamond) → the same leading-keyframe menu (the
// segment-span hit-target, a C-review coverage hole) → DOUBLE-CLICK a diamond to summon its
// handles (the diamond hit beats insertion) → drag a handle to author an explicit tangent (the
// segment reads Custom) → reopen the menu and assert the Custom row reads checked (another
// C-review hole) → Reset via the menu, pointer-true (`clickMenuItem`), clears it back to the
// derived easing → Delete, also pointer-true, removes the keyframe. Every menu interaction is
// a real pointer event; __kex is read only for assertions.
test("force easing menu flow", async ({ page, boot }) => {
    await boot();

    const forceCount = () => kexCall(page, "forceCount");
    const forceEases = () => kexCall(page, "forceEases");
    const forceEditing = () => kexCall(page, "forceEditing");
    const forceHandleSel = () => kexCall(page, "forceHandleSel");
    const forceTangents = () => kexCall(page, "forceTangents");

    // seed a force section with an airtime bump (the two continuation seed keyframes stage B
    // stamps on convert, plus three bump points) → a chain with interior keyframes to edit.
    await kexCall(page, "seedForceBump");
    await expect.poll(forceCount).toBeGreaterThanOrEqual(3);
    const nPts = await forceCount();
    await frameTimeline(page); // bring the whole force section into view for the diamond DOM boxes
    // `.fpt` is shared with velocity-strip keyframes (Timeline.svelte draws both under the same
    // class); `seedForceBump` converts section 0 to force, and `seed()` (S3) carries no strip of
    // its own (the track-start one-shot is a distinct point kind, no `Strip`/keyframe row), so
    // `.fpt` is force points only.
    await expect(page.locator(".fpt")).toHaveCount(nPts);

    // ── 1. Right-click the leading (first) keyframe → the force keyframe menu, in the grammar's
    // canonical row order Easing ▸ · Delete — modify before lifecycle, the destructive row
    // terminal (kex2d-menu-grammar stage 2). (The Handles + Reset rows are gone — both subsumed
    // into the Easing list: Custom steps in, a preset steps back out.) ──
    await page.locator(".fpt").first().click({ button: "right" });
    await expect(page.locator(".fmenu")).toBeVisible();
    await expect
        .poll(async () =>
            (await page.locator(".fmenu [role=menuitem]").allTextContents()).map((t) =>
                t.replace(/\s+/g, " ").trim(),
            ),
        )
        .toEqual(["Easing ▸", "Cut C", "Delete Del"]);
    // the rendered rows are the real `keyframeMenu` builder's, run in the page against this
    // keyframe's live state — the keyframe menu's half of the DOM cross-check. It reaches INSIDE
    // `Easing ▸` by real hover, which is where the app's ONE authored within-group separator lives
    // (the preset picks divided from Custom): the whole escape hatch rests on that row, and this is
    // the only place it's verified as rendered DOM.
    await menuGrammar(page, ".fmenu", {
        builder: "keyframeMenu",
        // the leading keyframe of a bumped force section: single selection, non-terminal (it
        // governs the following segment), no explicit handles, no pin session (so no
        // Lock/Unlock row), nothing under lockdown. It's the section ENTRY (s = 0), so Cut's own
        // landmark bound (`keyframeCuttable`) grays its row — present, never omitted, since a
        // non-terminal keyframe always carries a Cut row (kex2d-structural-editing stage 6).
        state: {
            setOk: true,
            activeOk: true,
            lock: null,
            multi: false,
            terminal: false,
            easeTargets: 1,
            custom: false,
            hasHandles: false,
            customGlyph: "",
            canCut: false,
        },
        enums: { ease: "profile.Easing.Cubic", mode: "spline.TangentMode.Aligned" },
        fns: ["presetGlyph"],
    });
    await page.waitForTimeout(SHOT_MS);
    const menuStrip = dockStrip(page);
    if (menuStrip)
        await page.screenshot({ path: join(OUT, "force-easing-menu.png"), clip: menuStrip });

    // ── 2. Open Easing ▸ and set Linear — pointer-true through clickFlyout (a coordinate
    // click gated on elementFromPoint reachability, the context-submenu clip regression net).
    // the leading keyframe's tag flips to Linear (0); Cubic (default) is 1. ──
    expect((await forceEases())[0]).toBe(1); // Easing.Cubic default
    await clickFlyout(page, ".fmenu", "Easing", "Linear");
    await expect(page.locator(".fmenu")).toHaveCount(0); // picking a row closes the menu
    await expect.poll(async () => (await forceEases())[0]).toBe(0); // Easing.Linear

    // ── 2b. Right-click the CURVE SPAN between keyframe 0 (s=0) and keyframe 1 (the first
    // bump shoulder, s = 0.2·length) — a chart point, not a diamond — opens NO menu. This used to
    // address the LEADING keyframe (the Blender curve-span convention); that convention is
    // RETIRED (kex2d-structural-editing stage 7b, feel round 8: "I wouldn't expect that" — a
    // right-click addresses what's under the cursor or nothing, never a nearby landmark,
    // `editor-ui.md` Keyframe/curve-editor conventions). This is the spec's own named mutant:
    // restoring `chartCtx` makes this assertion fail. Step 1's right-click on the diamond is this
    // test's positive control (the rig does open `.fmenu` on a real hit) — this is the negative
    // twin, on a real pointer event, that the source census alone (`tests/menu.test.ts`) can't
    // reach (no DOM in `bun test`). `openForceMenu`'s old target (keyframe 0) also SELECTS, so
    // its `.ptip` popover is still floating over the chart from step 1 — Escape deselects and
    // closes it first, or it eats the click. ──
    await page.keyboard.press("Escape");
    await expect(page.locator(".ptip")).toHaveCount(0);
    const fcb = await page.locator(".clip").first().boundingBox();
    const kf0 = await page.locator(".fpt").nth(0).boundingBox(); // s=0 seed (~1g)
    const kf1 = await page.locator(".fpt").nth(1).boundingBox(); // first bump shoulder (1g)
    if (!fcb || !kf0 || !kf1) throw new Error("force clip / keyframes not laid out");
    // the OLD hit-target was gated to the drawn curve (chartCtx's own FHIT_R vertical tolerance),
    // so this click lands exactly where that convention used to fire. x ≈ 0.1·length sits halfway
    // between kf0 (s=0) and kf1 (s=0.2·length); the near-flat ~1g span there tracks the two
    // flanking diamonds, so the mean of their centre-y lands ON the curve.
    const midX = fcb.x + fcb.width * 0.1;
    const midY = (kf0.y + kf0.height / 2 + (kf1.y + kf1.height / 2)) / 2;
    await page.mouse.click(midX, midY, { button: "right" });
    // a menu that IS going to open renders on the next tick, so one projected frame is the
    // condition that makes this absence assert mean something (kex2d-harness.md, "a negative
    // assert needs a positive control" — the positive control here is step 1, above).
    await frames(page);
    await expect(page.locator(".fmenu")).toHaveCount(0);
    expect((await forceEases())[0]).toBe(0); // unchanged (Easing.Linear from step 2) — inert
    expect(await kexCall(page, "forceSelActive")).toBe(null); // no selection either — a miss changes nothing

    // ── 2c. A right-click in EMPTY chart space (over the force section horizontally but ~1g
    // from the curve vertically) also opens NO menu — the chartzone carries no `oncontextmenu`
    // at all; the outer `.body` wrapper's own handler is what keeps a miss from opening the
    // browser's menu (`Timeline.svelte`, the chartzone comment). ──
    const crest = await page.locator(".fpt").nth(2).boundingBox(); // airtime crest (0g)
    if (!crest) throw new Error("crest keyframe not laid out");
    await page.mouse.click(midX, crest.y + crest.height / 2, { button: "right" });
    await frames(page);
    await expect(page.locator(".fmenu")).toHaveCount(0);
    expect((await forceEases())[0]).toBe(0); // unchanged — the empty-space click was inert
    expect(await kexCall(page, "forceSelActive")).toBe(null);

    // ── 3. Double-click an interior keyframe → handle-edit sub-mode summons its two handles
    // (the direct gesture into handle edit; a diamond hit beats the chart's insertion double-
    // click, and it does NOT insert a point). ──
    await page.locator(".fpt").nth(1).dblclick();
    await expect.poll(forceEditing).toBe(true);
    await expect(page.locator(".thit")).toHaveCount(2); // in + out handles (an interior keyframe)
    await expect.poll(forceCount).toBe(nPts); // the double-click summoned, it did NOT insert

    // ── 3b. Dead-zone: a CLICK on a handle knob with a sub-threshold jitter (2-3 px, under
    // DRAG_PX) selects the handle but writes NO tangent and records NO history — it must not
    // materialize a ghost to explicit on a jittery click (the F2 review finding: the write was
    // gated only on the release verdict, not the dead zone). the IN handle (reaches backward,
    // away from step 4's out-drag). ──
    const undoDepth = () => kexCall(page, "undoDepth");
    const beforeJitter = await undoDepth();
    const inKnob = await page.locator(".thit").first().boundingBox();
    if (!inKnob) throw new Error("in-handle knob not laid out");
    await page.mouse.move(inKnob.x + inKnob.width / 2, inKnob.y + inKnob.height / 2);
    await page.mouse.down();
    await page.mouse.move(inKnob.x + inKnob.width / 2 + 2, inKnob.y + inKnob.height / 2 - 2, {
        steps: 2,
    });
    await page.mouse.up();
    await expect.poll(forceHandleSel).toBe("in"); // the jittery click SELECTED the handle
    expect((await forceTangents())[1]).toBeNull(); // …but wrote NO explicit tangent
    expect(await undoDepth()).toBe(beforeJitter); // …and recorded NO history entry
    await page.keyboard.press("Escape"); // peel: deselect the handle, stay in handle edit
    await expect.poll(forceHandleSel).toBeNull();

    // ── 4. Drag the OUT handle → the keyframe's OUT side gains an explicit tangent, so its
    // FOLLOWING segment (the one its menu addresses) reads Custom. a real canvas pointer drag,
    // located by the .thit grab circle. the out handle reaches into the larger next span, clear
    // of the diamond. ──
    const knob = await page.locator(".thit").last().boundingBox();
    if (!knob) throw new Error("handle knob not laid out");
    await page.mouse.move(knob.x + knob.width / 2, knob.y + knob.height / 2);
    await page.mouse.down();
    await page.mouse.move(knob.x + knob.width / 2 + 24, knob.y + knob.height / 2 - 40, {
        steps: 6,
    });
    await page.mouse.up();
    await expect.poll(async () => (await forceTangents())[1] !== null).toBe(true);

    // per-side materialization: dragging keyframe 1's OUT handle customizes only that side. Its
    // IN side — the trailing bound of the PRECEDING segment (kf0→kf1) — stays derived, so an
    // out-drag never spuriously customizes the segment behind the keyframe (composeTangent's
    // segment-scoped Custom model). A both-sides materialize would flip inOn true → red.
    expect((await forceTangents())[1]?.inOn).toBe(false);

    // (a) the DRAG selected the dragged side (the Blender rule — any interaction addresses the
    // handle). On pre-F3 code a drag left selection untouched, so this is the red-first pin.
    await expect.poll(forceHandleSel).toBe("out");
    // (b) the offset grid snapped Δg to a 0.1-g multiple (a real, nonzero offset). Remove the
    // grid quantize and the ~40-px drag's continuous Δg is essentially never a 0.1 multiple → red.
    const outDgSnap = (await forceTangents())[1]?.outDg ?? 0;
    expect(Math.abs(outDgSnap)).toBeGreaterThan(0.05);
    expect(Math.abs(outDgSnap * 10 - Math.round(outDgSnap * 10))).toBeLessThan(1e-6);
    // (b2) Δs, by contrast, is CONTINUOUS (F3d): a handle's horizontal offset is curvature
    // shaping, not a placement on the arclength, so it is NOT grid-quantized. The ~24-px drag's
    // Δs lands off the 1-m grid; re-enable the Δs quantize and it snaps to an integer → red.
    const outDsCont = (await forceTangents())[1]?.outDs ?? 0;
    expect(Math.abs(outDsCont)).toBeGreaterThan(0.05); // a real, nonzero reach
    expect(Math.abs(outDsCont - Math.round(outDsCont))).toBeGreaterThan(1e-3); // off the 1-m grid
    // …and the readout swapped to the handle, printing that snapped value in vocabulary form
    // (trailing zeros trimmed) — the popover shows the handle's own (Δs, Δg), not the keyframe's.
    const hgReadout = page.locator('.ptip input[aria-label="Handle g offset (g)"]');
    await expect(hgReadout).toBeVisible();
    expect(Number(await hgReadout.inputValue())).toBeCloseTo(outDgSnap, 6);
    // (d) the popover re-anchored at the SELECTED KNOB (attention lives where the drag just
    // ended). Its above/below-vs-dodge placement is pinned in the dedicated 4d scenarios below,
    // on the crest — two constructed cases where the vertical fit is deterministic.

    await page.waitForTimeout(SHOT_MS);
    const editStrip = dockStrip(page);
    if (editStrip)
        await page.screenshot({ path: join(OUT, "force-handle-edit.png"), clip: editStrip });

    // ── 4c. The handle (Δs, Δg) fields carry the slider/scrub affordance, the same drag-to-slide
    // as the keyframe d/F fields. Grab the Δg key label and slide it right: the OUT tangent's Δg
    // revises through the shared write path (composeTangent), one undo entry. On the old type-only
    // fields (no onpointerdown handler) the drag over the label writes nothing → outDg unchanged →
    // red. ──
    const dgKey = page
        .locator(".ptip .fld")
        .filter({ has: page.locator('input[aria-label="Handle g offset (g)"]') })
        .locator(".key");
    const dgKeyBox = await dgKey.boundingBox();
    if (!dgKeyBox) throw new Error("Δg scrub handle not laid out");
    const beforeScrubDg = (await forceTangents())[1]?.outDg ?? 0;
    const beforeScrubUndo = await undoDepth();
    await page.mouse.move(dgKeyBox.x + dgKeyBox.width / 2, dgKeyBox.y + dgKeyBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(dgKeyBox.x + dgKeyBox.width / 2 + 40, dgKeyBox.y + dgKeyBox.height / 2, {
        steps: 10,
    });
    await page.mouse.up();
    await expect.poll(async () => (await forceTangents())[1]?.outDg ?? 0).not.toBe(beforeScrubDg);
    expect(await undoDepth()).toBe(beforeScrubUndo + 1); // the whole scrub → one entry

    // ── 4c′. The label-scrub button guard (kex2d-gesture-residue stage 5, the shared
    // `labelScrub` helper): only `snapScrub` carried an `e.button !== 0` check before this
    // stage — `scrubStart`/`handleScrub` had none, so a right-press on this exact label opened
    // a drag (writing Δg) underneath the browser's native context menu. RED-RIG TRAP: the
    // left-press-drag just above is the positive control — it already proved this rig can
    // detect both a real Δg write and a real gesture opening (`#app[data-dragging]`), so this
    // negative check can't pass vacuously. A right-press-drag on the SAME label must write
    // nothing (Δg unchanged, no undo entry) and open no gesture at all — checked mid-drag, not
    // only after release, so a guard that merely un-did the write couldn't sneak by. ──
    const beforeGuardDg = (await forceTangents())[1]?.outDg ?? 0;
    const beforeGuardUndo = await undoDepth();
    await page.mouse.move(dgKeyBox.x + dgKeyBox.width / 2, dgKeyBox.y + dgKeyBox.height / 2);
    await page.mouse.down({ button: "right" });
    await frames(page, 2);
    await expect(page.locator("#app[data-dragging]")).toHaveCount(0); // no gesture opened
    await page.mouse.move(dgKeyBox.x + dgKeyBox.width / 2 + 40, dgKeyBox.y + dgKeyBox.height / 2, {
        steps: 10,
    });
    await frames(page, 2);
    await expect(page.locator("#app[data-dragging]")).toHaveCount(0); // still none, under movement
    await page.mouse.up({ button: "right" });
    expect((await forceTangents())[1]?.outDg ?? 0).toBe(beforeGuardDg); // no write
    expect(await undoDepth()).toBe(beforeGuardUndo); // no commit

    // ── 4b. Ctrl/Cmd frees the Δg grid (Δs is already continuous by default, F3d — the modifier's
    // remaining job is the Δg quantum). Reset step 4's handle to derived, re-enter, and drag the OUT
    // knob with the modifier held to an off-round pixel target: the bypass keeps Δg continuous, so it
    // lands off the 0.1-g grid (a continuous real hits the grid with vanishing probability); a broken
    // bypass snaps Δg → the assert goes red. Fresh-from-flat so the grab-ray latch releases on the
    // large move. ──
    await page.locator(".fpt").nth(1).click({ button: "right" });
    await clickFlyout(page, ".fmenu", "Easing", "Cubic");
    await expect(page.locator(".fmenu")).toHaveCount(0);
    await expect.poll(async () => (await forceTangents())[1] === null).toBe(true);
    await page.locator(".fpt").nth(1).dblclick();
    await expect.poll(forceEditing).toBe(true);
    const gk = await page.locator(".thit").last().boundingBox();
    if (!gk) throw new Error("out handle knob not laid out for the bypass drag");
    await page.mouse.move(gk.x + gk.width / 2, gk.y + gk.height / 2);
    await page.mouse.down({ button: "left" });
    await page.keyboard.down("Control");
    await page.mouse.move(gk.x + gk.width / 2 + 13, gk.y + gk.height / 2 - 37, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up("Control");
    await expect.poll(async () => (await forceTangents())[1] !== null).toBe(true);
    const free = (await forceTangents())[1];
    expect(Math.abs(free?.outDg ?? 0)).toBeGreaterThan(0.05); // a real, nonzero vertical reach
    const dgOnGrid = Math.abs((free?.outDg ?? 0) * 10 - Math.round((free?.outDg ?? 0) * 10)) < 1e-6; // G_GRID = 0.1 g
    expect(dgOnGrid).toBe(false); // the bypass freed Δg off its 0.1-g grid

    // ── 4d. Handle popover placement (F3c): vertical-primary, matching the keyframe popover's
    // above/below reading. The box sits above/below the knob, horizontally centred on it, on the
    // side AWAY from the diamond; only an edge that would flip it back over the workspace dodges it
    // horizontally outward (the collision fallback, never the default). Two constructed cases on the
    // CREST (nth 2, an interior keyframe near the chart BOTTOM): an up-handle with room = the
    // default above; a down-handle pinned to the bottom edge = the dodge. ──
    await page.keyboard.press("Escape"); // leave keyframe 1's handle edit clean before the crest
    await page.keyboard.press("Escape");
    const body = await page.locator(".dock .body").boundingBox();
    if (!body) throw new Error("timeline body not laid out");
    const chartTopY = body.y + CHART_TOP;
    const chartBotY = body.y + body.height - CHART_BOT_PAD;

    await page.locator(".fpt").nth(2).dblclick(); // enter handle edit on the crest
    await expect.poll(forceEditing).toBe(true);
    await expect(page.locator(".thit")).toHaveCount(2);
    const crestDia = await page.locator(".fpt").nth(2).locator(".fhit").boundingBox();
    if (!crestDia) throw new Error("crest diamond not laid out");
    const crestX = crestDia.x + crestDia.width / 2;
    const crestY = crestDia.y + crestDia.height / 2;

    // (i) DEFAULT above: drag the OUT knob straight UP to the midpoint between the top fit-line and
    // the crest — the box has clear room above, so it reads like the keyframe popover: above the
    // knob, centred, on the side away from the (below) diamond. NOT dodged to a side.
    const upY = (chartTopY + TIP_REACH + crestY) / 2;
    const uk = await page.locator(".thit").last().boundingBox();
    if (!uk) throw new Error("crest out knob not laid out for the up drag");
    await page.mouse.move(uk.x + uk.width / 2, uk.y + uk.height / 2);
    await page.mouse.down();
    await page.mouse.move(crestX + 2, upY, { steps: 8 }); // straight up (the grab-ray latch keeps s≈0)
    await page.mouse.up();
    await expect.poll(async () => ((await forceTangents())[2]?.outDg ?? 0) > 0.05).toBe(true); // points UP
    {
        const tipBox = await page.locator(".ptip").boundingBox();
        const knobBox = await page.locator(".thit").last().boundingBox();
        const inKnob = await page.locator(".thit").first().boundingBox();
        const dia = await page.locator(".fpt").nth(2).locator(".fhit").boundingBox();
        if (!tipBox || !knobBox || !inKnob || !dia)
            throw new Error("default-placement boxes not laid out");
        const knobCx = knobBox.x + knobBox.width / 2;
        const knobCy = knobBox.y + knobBox.height / 2;
        expect(dia.y + dia.height / 2).toBeGreaterThan(knobCy); // handle up → the diamond is BELOW the knob
        expect(tipBox.y + tipBox.height).toBeLessThanOrEqual(knobCy + 1); // …so the box is ABOVE the knob
        expect(knobCx).toBeGreaterThanOrEqual(tipBox.x); // horizontally centred on the knob (not dodged)
        expect(knobCx).toBeLessThanOrEqual(tipBox.x + tipBox.width);
        expect(overlaps(tipBox, knobBox)).toBe(false); // clears every workspace element it hangs off
        expect(overlaps(tipBox, inKnob)).toBe(false);
        expect(overlaps(tipBox, dia)).toBe(false);
    }

    // (ii) DODGE (the F3b refutation, now pinned): drag the OUT knob DOWN past the chart bottom so
    // it clamps to the edge, just below the near-bottom crest diamond. The preferred vertical side
    // (below, away from the diamond) no longer fits, and flipping back ABOVE would land the box over
    // the diamond — so it dodges horizontally OUTWARD (out → right) instead. Red-first: a naive
    // always-vertical placement flips above and OVERLAPS the crest diamond, so the no-overlap assert
    // goes red without the dodge (verified against a no-dodge mutation on the bridge).
    const dk = await page.locator(".thit").last().boundingBox();
    if (!dk) throw new Error("crest out knob not laid out for the dodge");
    await page.mouse.move(dk.x + dk.width / 2, dk.y + dk.height / 2);
    await page.mouse.down();
    await page.mouse.move(crestX + 14, chartBotY + 60, { steps: 8 }); // past the bottom → clamps to the edge
    await page.mouse.up();
    await expect.poll(async () => ((await forceTangents())[2]?.outDg ?? 0) < -0.05).toBe(true); // points DOWN
    {
        const tipBox = await page.locator(".ptip").boundingBox();
        const knobBox = await page.locator(".thit").last().boundingBox();
        const inKnob = await page.locator(".thit").first().boundingBox();
        const dia = await page.locator(".fpt").nth(2).locator(".fhit").boundingBox();
        if (!tipBox || !knobBox || !inKnob || !dia)
            throw new Error("dodge-placement boxes not laid out");
        const knobCy = knobBox.y + knobBox.height / 2;
        expect(tipBox.x).toBeGreaterThan(knobBox.x + knobBox.width); // dodged to the OUTWARD side (right)
        expect(tipBox.x - (knobBox.x + knobBox.width)).toBeLessThan(24); // …adjacent, not floating away
        // the box rides at the knob's vertical level (a side dodge, not above/below) — the in-view
        // clamp may push it up to a half-height when the knob is pinned to the very chart edge.
        expect(Math.abs(knobCy - (tipBox.y + tipBox.height / 2))).toBeLessThanOrEqual(32);
        // the load-bearing pin (the F3b scenario): the dodge clears the diamond fat-pick box and the
        // arm's knobs. A naive vertical flip would land over the diamond just above → this goes red.
        expect(overlaps(tipBox, dia)).toBe(false);
        expect(overlaps(tipBox, knobBox)).toBe(false);
        expect(overlaps(tipBox, inKnob)).toBe(false);
    }

    await page.keyboard.press("Escape"); // deselect the handle
    await page.keyboard.press("Escape"); // exit crest handle edit → clean for step 5
    await expect.poll(forceEditing).toBe(false);

    // ── 5. Reopen the menu on the now-Custom keyframe → its Easing ▸ submenu's Custom row reads
    // checked (derived provenance — the segment is bounded by an explicit handle). ──
    await page.locator(".fpt").nth(1).click({ button: "right" });
    await expect(page.locator(".fmenu")).toBeVisible();
    await page.locator(".fmenu").getByRole("menuitem", { name: "Easing", exact: true }).hover();
    const customRow = page.locator(".fmenu").getByRole("menuitem", { name: "Custom", exact: true });
    await expect(customRow).toBeVisible();
    await expect(customRow).toHaveClass(/checked/);

    // ── 6. Pick a PRESET row (Cubic) through the menu → it clears the explicit handles back to
    // the derived preset (what Reset did, now folded into choosing a named row — the way back up
    // the layers is the list). pointer-true through clickFlyout. ──
    await clickFlyout(page, ".fmenu", "Easing", "Cubic");
    await expect(page.locator(".fmenu")).toHaveCount(0);
    await expect.poll(async () => (await forceTangents())[1] === null).toBe(true); // handles cleared

    // ── 7. Pick CUSTOM through the menu → it materializes explicit handles from the current
    // derived ones (no drag) and steps into handle edit. the segment reads Custom again, from
    // the list this time. ──
    await page.locator(".fpt").nth(1).click({ button: "right" });
    await expect(page.locator(".fmenu")).toBeVisible();
    await clickFlyout(page, ".fmenu", "Easing", "Custom");
    await expect(page.locator(".fmenu")).toHaveCount(0);
    await expect.poll(forceEditing).toBe(true); // Custom entered handle edit
    await expect.poll(async () => (await forceTangents())[1] !== null).toBe(true); // handles materialized
    await expect(page.locator(".thit")).toHaveCount(2);

    // ── 8. Select a handle (click its knob) → the contextual readout swaps from the keyframe
    // to the handle, and its typed (Δs, Δg) fields appear. type a Δg → the tangent write path
    // applies it (history-bracketed); undo restores. the OUT handle (reaches into the larger
    // next span) is well clear of the diamond. ──
    await page.locator(".thit").last().click(); // no-move click selects, does not drag
    await expect.poll(forceHandleSel).toBe("out");
    const dgField = page.locator('.ptip input[aria-label="Handle g offset (g)"]');
    await expect(dgField).toBeVisible(); // the readout swapped to the handle
    await dgField.fill("0.6");
    await dgField.press("Enter"); // Enter blurs → onchange commits through the tangent path
    await expect.poll(async () => (await forceTangents())[1]?.outDg ?? 0).toBeCloseTo(0.6, 2);
    await page.keyboard.press("Control+z"); // undo the typed entry
    await expect
        .poll(async () => Math.abs((await forceTangents())[1]?.outDg ?? 1))
        .toBeLessThan(0.01);

    // ── 9. The TERMINAL keyframe (the last one, governing no following segment) drops the
    // Easing ▸ entry entirely — its menu is Delete alone (there is no transition to ease).
    // `.fpt` is shared with velocity-strip keyframes, rendered AFTER every force point in DOM
    // order — `.last()` would grab the launch strip's own keyframe instead (S5), so address the
    // terminal force point by its known index (`nPts - 1`). ──
    await page
        .locator(".fpt")
        .nth(nPts - 1)
        .click({ button: "right" });
    await expect(page.locator(".fmenu")).toBeVisible();
    await expect
        .poll(async () =>
            (await page.locator(".fmenu [role=menuitem]").allTextContents()).map((t) =>
                t.replace(/\s+/g, " ").trim(),
            ),
        )
        .toEqual(["Delete Del"]); // no Easing ▸ on the terminal keyframe
    await page.keyboard.press("Escape"); // close the menu
    await expect(page.locator(".fmenu")).toHaveCount(0);

    // ── 10. Delete, pointer-true, removes an interior keyframe. ──
    await page.keyboard.press("Escape"); // deselect the terminal keyframe
    const beforeDelete = await forceCount();
    await page.locator(".fpt").nth(1).click({ button: "right" });
    await expect(page.locator(".fmenu")).toBeVisible();
    await clickMenuItem(page, ".fmenu", "Delete");
    await expect.poll(forceCount).toBe(beforeDelete - 1);
});

// G2: the Tangents ▸ mode submenu (Mirror | Aligned | Free — the geo node menu's convention on a
// force keyframe) and the chord-aligned derived-Linear ghost display. Both are handle-layer feel
// features rendered on the real timeline, so both are driven pointer-true and asserted against the
// drawn DOM + __kex state.
test("force tangent mode + linear ghost flow", async ({ page, boot }) => {
    await boot();

    const forceCount = () => kexCall(page, "forceCount");
    const forceEases = () => kexCall(page, "forceEases");
    const forceEditing = () => kexCall(page, "forceEditing");
    const forceTangents = () => kexCall(page, "forceTangents");

    // seed an airtime bump on a force section: two continuation seeds + three bump points = five
    // keyframes, kf1..kf3 interior (each governs a following segment).
    await kexCall(page, "seedForceBump");
    await expect.poll(forceCount).toBeGreaterThanOrEqual(5);
    const nPts = await forceCount();
    await frameTimeline(page);
    // `.fpt` is shared with velocity-strip keyframes; `seed()` (S3) carries no strip of its own
    // (`force easing menu flow`'s own note), so `.fpt` is force points only.
    await expect(page.locator(".fpt")).toHaveCount(nPts);

    // ── A. Chord-aligned derived-Linear ghost (feature 2). Set kf1's following segment to Linear,
    // enter handle edit (no drag → both sides stay derived ghosts), and assert the OUT ghost knob
    // is DRAWN forward of the diamond (chord-aligned at influence 1/3), not collapsed to a dot on
    // it. Red-first: revert `derivedOut` to the flat `autoTangent` and a Linear ghost's Δs → 0, so
    // the knob lands on the diamond → `ghostCx − diaCx ≈ 0` → red. ──
    await page.locator(".fpt").nth(1).click({ button: "right" });
    await expect(page.locator(".fmenu")).toBeVisible();
    await clickFlyout(page, ".fmenu", "Easing", "Linear");
    await expect.poll(async () => (await forceEases())[1]).toBe(0); // Easing.Linear
    await page.keyboard.press("Escape"); // deselect (clear the keyframe .ptip floating over the chart)
    await expect(page.locator(".ptip")).toHaveCount(0);
    await page.locator(".fpt").nth(1).dblclick(); // handle-edit sub-mode
    await expect.poll(forceEditing).toBe(true);
    await expect(page.locator(".tknob.ghost")).toHaveCount(2); // both sides derived (hollow ghosts)
    const dia1 = await page.locator(".fpt").nth(1).locator(".fhit").boundingBox();
    const outGhost = await page.locator(".tknob.ghost").last().boundingBox(); // handles render in, then OUT
    if (!dia1 || !outGhost) throw new Error("kf1 diamond / out ghost not laid out");
    const diaCx = dia1.x + dia1.width / 2;
    const ghostCx = outGhost.x + outGhost.width / 2;
    expect(ghostCx - diaCx).toBeGreaterThan(12); // chord-aligned reach forward, not a dot on the diamond
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect.poll(forceEditing).toBe(false);

    // ── B. Tangents ▸ mode submenu (feature 1). Give kf1 BOTH explicit handles so the coupling is
    // observable: Custom on kf1 materializes its OUT, Custom on kf0 materializes kf1's IN. First
    // reset kf1 back to a preset (Cubic) so the seeds are flat. ──
    await page.locator(".fpt").nth(1).click({ button: "right" });
    await clickFlyout(page, ".fmenu", "Easing", "Cubic");
    await expect.poll(async () => (await forceEases())[1]).toBe(1); // back to Cubic
    await page.keyboard.press("Escape");
    await page.locator(".fpt").nth(1).click({ button: "right" });
    await clickFlyout(page, ".fmenu", "Easing", "Custom"); // materializes kf1.out, enters handle edit
    await expect.poll(async () => (await forceTangents())[1]?.outOn === true).toBe(true);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect.poll(forceEditing).toBe(false);
    await page.locator(".fpt").nth(0).click({ button: "right" });
    await clickFlyout(page, ".fmenu", "Easing", "Custom"); // materializes kf1.in (the kf0→kf1 trailing side)
    await expect
        .poll(async () => {
            const t = (await forceTangents())[1];
            return t?.inOn === true && t?.outOn === true;
        })
        .toBe(true);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect.poll(forceEditing).toBe(false);

    // ── B1. kf1 now holds both sides, default mode Aligned (a flat pair materializes Aligned). Its
    // menu carries a Tangents ▸ row, and Aligned is the checked mode inside the submenu. ──
    await page.locator(".fpt").nth(1).click({ button: "right" });
    await expect(page.locator(".fmenu")).toBeVisible();
    await expect
        .poll(async () =>
            (await page.locator(".fmenu [role=menuitem]").allTextContents()).map((t) =>
                t.replace(/\s+/g, " ").trim(),
            ),
        )
        .toEqual(["Easing ▸", "Tangents ▸", "Cut C", "Delete Del"]);
    // the two-flyout shape, cross-checked against the real builder: `hasHandles` adds Tangents ▸
    // inside `modify`, so the ONE derived divider still lands before Delete.
    await menuGrammar(page, ".fmenu", {
        builder: "keyframeMenu",
        state: {
            setOk: true,
            activeOk: true,
            lock: null,
            multi: false,
            terminal: false,
            easeTargets: 1,
            custom: true, // an explicit handle bounds the addressed segment
            hasHandles: true,
            customGlyph: "",
            canCut: true, // kf1 is interior (kex2d-structural-editing stage 6)
        },
        enums: { ease: "profile.Easing.Cubic", mode: "spline.TangentMode.Aligned" },
        fns: ["presetGlyph"],
    });
    await page.locator(".fmenu").getByRole("menuitem", { name: "Tangents", exact: true }).hover();
    await expect(
        page.locator(".fmenu").getByRole("menuitem", { name: "Aligned", exact: true }),
    ).toHaveClass(/checked/);

    // ── B2. Pick Free through the Tangents ▸ flyout → the stored mode flips to Free (2). ──
    await clickFlyout(page, ".fmenu", "Tangents", "Free");
    await expect(page.locator(".fmenu")).toHaveCount(0);
    await expect.poll(async () => (await forceTangents())[1]?.mode).toBe(2); // TangentMode.Free

    // ── B3. Under Free, dragging the OUT handle no longer couples the IN side (Aligned would swing
    // it collinear). Enter handle edit, record kf1's IN offset, drag OUT far off-axis, assert IN is
    // unchanged. Red-first: fold Free into composeTangent's coupling branch and IN moves → red. ──
    await page.locator(".fpt").nth(1).dblclick();
    await expect.poll(forceEditing).toBe(true);
    const inBefore = (await forceTangents())[1];
    if (!inBefore) throw new Error("kf1 must hold explicit handles for the decouple check");
    const outKnob = await page.locator(".thit").last().boundingBox(); // in, then OUT
    if (!outKnob) throw new Error("kf1 out knob not laid out");
    await page.mouse.move(outKnob.x + outKnob.width / 2, outKnob.y + outKnob.height / 2);
    await page.mouse.down();
    await page.mouse.move(outKnob.x + outKnob.width / 2 + 10, outKnob.y + outKnob.height / 2 - 44, {
        steps: 6,
    });
    await page.mouse.up();
    await expect
        .poll(async () => Math.abs((await forceTangents())[1]?.outDg ?? 0))
        .toBeGreaterThan(0.05); // OUT moved
    const inAfter = (await forceTangents())[1];
    expect(inAfter?.inDs).toBeCloseTo(inBefore.inDs, 6); // IN untouched — Free does not couple
    expect(inAfter?.inDg).toBeCloseTo(inBefore.inDg, 6);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect.poll(forceEditing).toBe(false);

    // ── C. A DERIVED-only keyframe (no explicit handles) shows NO Tangents ▸ row — there is no
    // stored mode to edit. kf3 (interior, untouched by A/B) is fully derived. ──
    await page.locator(".fpt").nth(3).click({ button: "right" });
    await expect(page.locator(".fmenu")).toBeVisible();
    expect((await forceTangents())[3]).toBeNull(); // kf3 is derived (no explicit handles)
    await expect
        .poll(async () =>
            (await page.locator(".fmenu [role=menuitem]").allTextContents()).map((t) =>
                t.replace(/\s+/g, " ").trim(),
            ),
        )
        .toEqual(["Easing ▸", "Cut C", "Delete Del"]); // no Tangents ▸ on a derived keyframe; kf3 is interior too
    await page.keyboard.press("Escape");
    await expect(page.locator(".fmenu")).toHaveCount(0);
});

// Handle drags must behave like keyframe/node drags at the view edges, through the SAME mechanisms:
// (1) a handle HELD past the chart edge EDGE-PANS the value axis (the shared growValueAxis path,
// factored from the keyframe drag), and (2) on RELEASE the range ACCOMMODATES the handle endpoint so
// a knob never sits outside the visible range (yTarget's content extent, extended to explicit handle
// endpoints — the same accommodate keyframes get through the curve scan). The gRange hook reads the
// displayed g-range (yView); a real canvas pointer drives the drag past the edge. Each half carries
// its own mutation: unwire the handle branch → no pan; drop the handle-endpoint inclusion → no fit.
test("handle drag edge-pans the value axis and a released handle stays in range", async ({
    page,
    boot,
}) => {
    await boot();

    const forceCount = () => kexCall(page, "forceCount");
    const forceEditing = () => kexCall(page, "forceEditing");
    const tTotal = () => kexCall(page, "tTotal");
    const forces = () => kexCall(page, "forces");
    const forceTangents = () => kexCall(page, "forceTangents");
    const gRange = () => kexCall(page, "gRange");

    // seed a force bump → an interior shoulder keyframe (nth 1) whose OUT handle has room downward.
    // the flat seed already bakes `tTotal > 0` on load, so wait it out and then for the bump's own
    // bake to CHANGE it — the diamonds below are read off that bake.
    await expect.poll(tTotal).toBeGreaterThan(0);
    const tFlat = await tTotal();
    await kexCall(page, "seedForceBump");
    await expect.poll(forceCount).toBeGreaterThanOrEqual(3);
    await expect.poll(tTotal).not.toBe(tFlat);
    await frameTimeline(page);

    const body = await page.locator(".dock .body").boundingBox();
    if (!body) throw new Error("timeline body not laid out");
    const chartBotY = body.y + body.height - CHART_BOT_PAD;

    await page.locator(".fpt").nth(1).dblclick(); // enter handle edit → its two handles summon
    await expect.poll(forceEditing).toBe(true);
    await expect(page.locator(".thit")).toHaveCount(2);

    // ── 1. Edge-pan: grab the OUT knob, drag it straight DOWN well past the chart bottom, and HOLD.
    // The shared edge-grow fires per frame while the cursor is held beyond the edge, so the displayed
    // range's floor keeps dropping (the held handle rides the growing axis) — until it lands on the
    // growth CAP and stops. Growth is span-proportional, so it compounds per frame; uncapped, a held
    // drag runs to absurd g in well under a second (the hand check that sent stage 8 back), which is
    // what the cap bounds. Mutation: revert the handle branch in the yView effect to `return` (unwire
    // the path) → the axis holds → the floor never drops → this times out red. Mutation: drop the cap
    // from `yGrow` → the floor keeps falling past it → the hold-still assert goes red. ──
    const [lo0] = await gRange();
    expect(lo0).toBeGreaterThan(GROW_LO); // the resting frame sits inside the cap — there IS room to grow
    const knob = await page.locator(".thit").last().boundingBox();
    if (!knob) throw new Error("out handle knob not laid out");
    const knobX = knob.x + knob.width / 2;
    await page.mouse.move(knobX, knob.y + knob.height / 2);
    await page.mouse.down();
    await page.mouse.move(knobX, chartBotY + 140, { steps: 8 }); // straight down, past the bottom, HELD
    await expect.poll(async () => (await gRange())[0]).toBeCloseTo(GROW_LO, 3); // grew down to the cap
    await frames(page, 24); // …held past the edge for 48 more real frames (`frames` awaits 2n rAF
    // callbacks). Growth compounds per FRAME, so frames — not milliseconds — are this hold's unit,
    // and the count is the detection power: a ~1e-4/frame leak past the cap hides inside 24.
    expect((await gRange())[0]).toBeCloseTo(GROW_LO, 3); // …and stopped there, never past it
    await page.mouse.up();
    await expect.poll(async () => (await forceTangents())[1] !== null).toBe(true);

    // ── 2. Release accommodate: the OUT handle now overshoots far below the drawn curve (its knob
    // sat at the panned floor). The range must include its ENDPOINT (keyframe g + Δg) — yFit pads
    // FIT_PAD (0.4 g) past the content extent, so the settled floor lands strictly BELOW the
    // endpoint. Mutation: drop the handle-endpoint inclusion in yTarget → the view fits the curve
    // only (its dip sits well above the overshoot knob), so the floor never reaches the endpoint and
    // instead lazily contracts back up → this times out red. ──
    const g1 = (await forces())[1].g;
    const endpointG = g1 + ((await forceTangents())[1]?.outDg ?? 0);
    await expect.poll(async () => (await gRange())[0]).toBeLessThan(endpointG - 0.2);
});

// Drive the TIMELINE MULTISELECT flow (kex2d-multiselect stage 6): seed an airtime force bump →
// CHART-MARQUEE selects its three interior keyframes (a real rect drag on the chartzone, excluding
// the two continuation seeds at the section's own bounds) → a per-diamond SHIFT-CLICK toggles the
// active member out (promoting the survivor) and back in → a plain-click MULTI-DRAG grabbed on a
// non-active member applies the SAME shared Δs to the whole set, RIGID-CLAMPED so the tightest
// member (nearest the section's own extent) bounds the whole group — the AE comp-start block,
// offsets preserved, then undoes clean as one entry → a right-click keeps the set and the Easing ▸
// menu's bulk preset applies to every selected NON-TERMINAL keyframe in one entry, leaving the two
// unselected seeds at their default tag → finally, WHEEL DURING A GESTURE: a wheel tick held inside
// a live chart marquee leaves the document axis exactly where it was, while the same tick at rest
// zooms (kex2d-ux-burndown stage 3, the timeline half of the one rule). Every gesture is a real pointer drag/click, located via
// the diamonds' own laid-out boxes (`.fhit`); `forceSelIds`/`forceSelActive`/`forces`/`forceEases`
// are read-only asserts.
test("timeline multiselect flow", async ({ page, boot }) => {
    await boot();

    const forceCount = () => kexCall(page, "forceCount");
    const forceSelIds = () => kexCall(page, "forceSelIds");
    const forceSelActive = () => kexCall(page, "forceSelActive");
    const forces = () => kexCall(page, "forces");
    const forceEases = () => kexCall(page, "forceEases");
    const tTotal = () => kexCall(page, "tTotal");

    await kexCall(page, "seedForceBump");
    await expect.poll(forceCount).toBe(5); // the two continuation seeds + the three bump points
    await expect.poll(tTotal).toBeGreaterThan(0);
    await frameTimeline(page); // the whole section on-screen for exact diamond boxes

    const fpt = page.locator(".fpt");
    // `.fpt` is shared with velocity-strip keyframes; `seed()` (S3) carries no strip of its own
    // (the track-start one-shot is a distinct point kind) — 5 force points, nothing else. Force
    // points still render first in DOM order, so the `fhit.nth(0..4)` indices below stay correct.
    await expect(fpt).toHaveCount(5);
    const fhit = page.locator(".fhit");
    const fhitCenter = async (i: number): Promise<{ cx: number; cy: number }> => {
        const b = await fhit.nth(i).boundingBox();
        if (!b) throw new Error(`force point ${i} not laid out`);
        return { cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
    };
    const b0 = await fhitCenter(0); // the leading seed (s=0)
    const b1 = await fhitCenter(1); // shoulder (s=0.2·len)
    const b2 = await fhitCenter(2); // the airtime crest (s=0.5·len)
    const b3 = await fhitCenter(3); // shoulder (s=0.8·len)
    const b4 = await fhitCenter(4); // the trailing seed (s=len)
    const bodyBox = await page.locator(".dock .body").boundingBox();
    if (!bodyBox) throw new Error("timeline body not laid out");
    const mid = (a: number, b: number): number => (a + b) / 2;

    // ── 1. CHART-MARQUEE the three interior keyframes: x bounded at the midpoints to the two
    // seeds, y spans the chartzone's own inner band (only x needs to exclude the seeds — they
    // sit at the section's own bounds, well outside the interior x-range regardless of g). ──
    const xLo = mid(b0.cx, b1.cx);
    const xHi = mid(b3.cx, b4.cx);
    const chartTop = bodyBox.y + CHART_TOP + 4;
    const chartBot = bodyBox.y + bodyBox.height - CHART_BOT_PAD - 4;
    await marqueeDrag(page, xLo, chartTop, xHi, chartBot);
    await expect.poll(async () => (await forceSelIds()).length).toBe(3);
    for (const i of [1, 2, 3]) await expect(fpt.nth(i)).toHaveClass(/sel/);
    for (const i of [0, 4]) await expect(fpt.nth(i)).not.toHaveClass(/sel/);
    await expect(fpt.nth(3)).toHaveClass(/active/); // the last hit — the active member
    const active1 = await forceSelActive();
    expect(active1).not.toBeNull();
    expect(await forceSelIds()).toContain(active1); // the active member is always a set member
    // kex2d-time-domain stage 1 (second rescope): the typed-field popover shows NO single-keyframe
    // context on a multi-set, same as the viewport ring — standard multi-select carries no
    // single-subject popover. Mutation: drop the `!multiForce` guard → count 1 → red.
    await expect(page.locator(".ptip")).toHaveCount(0);
    await page.waitForTimeout(SHOT_MS);
    const strip = dockStrip(page);
    if (strip)
        await page.screenshot({ path: join(OUT, "multiselect-timeline-marquee.png"), clip: strip });

    // ── 2. SHIFT-CLICK the ACTIVE diamond (the s=0.8·len shoulder) toggles it OUT — the survivor
    // (the crest) promotes active — then the SAME shift-click toggles it back IN, re-activating. ──
    await page.keyboard.down("Shift");
    await page.mouse.click(b3.cx, b3.cy);
    await page.keyboard.up("Shift");
    await expect.poll(async () => (await forceSelIds()).length).toBe(2);
    await expect(fpt.nth(3)).not.toHaveClass(/sel/);
    await expect(fpt.nth(2)).toHaveClass(/active/); // promoted survivor
    await page.keyboard.down("Shift");
    await page.mouse.click(b3.cx, b3.cy);
    await page.keyboard.up("Shift");
    await expect.poll(async () => (await forceSelIds()).length).toBe(3);
    await expect(fpt.nth(3)).toHaveClass(/sel/);
    await expect(fpt.nth(3)).toHaveClass(/active/); // re-added → active again

    // ── 3. MULTI-DRAG, RIGID CLAMP + THE STATION REFUSAL: grab the CREST (a member, but NOT the
    // active one — a plain click on a set member drags the whole block without collapsing it) and
    // drag it FAR right — past the tightest member's own room. `clampDelta` alone would bind the
    // shared Δs to that member's own [0, len] exactly: the s=0.8·len shoulder has the least room
    // (0.2·len), so the bare clamp math lands it EXACTLY at the section's extent — precisely where
    // the untouched trailing seed already sits. But `setForcePoint` refuses a taken station PER KEY
    // (`track.ts stationTaken`, "refuse rather than overwrite"), and the block tests the whole
    // shared step together before committing it (`Timeline.svelte applyKeyframeDrag`'s own comment: "which
    // would tear a multi-drag apart… the block holds at the last landed Δs") — so this drag
    // exercises the refusal APPLIED TO THE BLOCK, not just the raw clamp: the shoulder never
    // reaches the occupied station, and the group holds one step short instead (every member's
    // OFFSET from the others still preserved, the AE comp-start block); the two unselected seeds
    // never move. (Was asserted the other way — exact coincidence, "no auto-merge" — before the
    // station refusal was generalized to the block path; that premise no longer holds.) ──
    const before = await forces();
    const clipBox = await page.locator(".clip").first().boundingBox();
    if (!clipBox) throw new Error("force clip not laid out");
    await page.mouse.move(b2.cx, b2.cy);
    await page.mouse.down();
    // 0.4·clipWidth ≈ 0.4·len in s — well past the tightest member's 0.2·len room, but still well
    // inside the clip's own box (so the pointer never leaves the viewport).
    await page.mouse.move(b2.cx + clipBox.width * 0.4, b2.cy, { steps: 12 });
    await page.mouse.up();
    const after = await forces();
    expect(after[0]).toEqual(before[0]); // the leading seed never moved — no tie possible at s=0
    const ds = after[1].s - before[1].s; // the shoulder's shift — unambiguous, nothing ties here
    expect(ds).toBeGreaterThan(2); // a real, clamped-but-substantial shift
    expect(after[2].s - before[2].s).toBeCloseTo(ds, 5); // the crest — the SAME shared offset
    const len = before[4].s; // the section's own extent, read off the pre-drag (unambiguous) snapshot
    const room = len - before[3].s; // the tightest member's own room — what the bare clamp math allows
    // the refusal holds the block STRICTLY short of the room the clamp alone would grant: landing
    // exactly on `room` is exactly the collision `stationTaken` exists to refuse, so a landed Δs
    // that reached it would mean the refusal never fired. Qualitative, not a captured pixel-derived
    // number — the discrete mouse-move sampling picks WHICH pre-collision Δs the block holds at,
    // never whether it holds short (that's the write-path law, not an artifact of the drive).
    expect(ds).toBeLessThan(room);
    expect(before[3].s + ds).toBeLessThan(len); // never reaches the occupied station…
    const atLen = after.filter((p) => Math.abs(p.s - len) < 1e-3);
    expect(atLen.length).toBe(1); // …so only the untouched trailing seed sits there — no coincidence
    expect(atLen[0]).toEqual(before[4]); // …and it's byte-identical to its pre-drag self
    await page.keyboard.press("Control+z"); // one entry reverts the whole group
    await expect.poll(async () => (await forces())[3].s).toBeCloseTo(before[3].s, 3);
    // …and the DIAMONDS are back where the cached boxes say. The undo writes authored `s` in place
    // (no respawn), so the poll above is satisfied a frame before the per-RAF tick re-projects the
    // DOM — right-clicking the cached `b2` on that evidence lands 0.4·clipWidth away on empty chart
    // and opens no menu (reproduced 2/2 on full 4-worker runs). Same law as the viewport flow's
    // move-undo: after an IN-PLACE restore, wait for the projection to land back on the target.
    await expect
        .poll(async () => {
            const b = await fhit.nth(2).boundingBox();
            return b !== null && Math.abs(b.x + b.width / 2 - b2.cx) < 1;
        })
        .toBe(true);

    // ── 4. BULK EASING: right-click a member (the crest, keeping the set) → the Easing ▸ preset
    // applies to every SELECTED NON-TERMINAL keyframe (all three interior points — none is the
    // section's last) in one entry; the two UNSELECTED seeds keep their default tag. ──
    expect((await forceEases())[1]).toBe(1); // Easing.Cubic, the fresh-seed default
    await page.mouse.click(b2.cx, b2.cy, { button: "right" });
    await expect(page.locator(".fmenu")).toBeVisible();
    await clickFlyout(page, ".fmenu", "Easing", "Quintic");
    await expect(page.locator(".fmenu")).toHaveCount(0);
    const eased = await forceEases();
    expect(eased[1]).toBe(2); // Easing.Quintic — the s=0.2·len shoulder, bulk-applied
    expect(eased[2]).toBe(2); // the crest
    expect(eased[3]).toBe(2); // the s=0.8·len shoulder
    expect(eased[0]).toBe(1); // the leading seed — NOT selected, untouched
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await forceEases())[1]).toBe(1);

    // ── 5. WHEEL IS A NO-OP DURING A LIVE GESTURE (kex2d-ux-burndown stage 3) — the timeline half
    // of the one rule; the viewport half rides the viewport multiselect flow, and both surfaces
    // guard on the same `editor.dragging` flag. A live gesture reads its cursor against the
    // document axis, so a mid-drag zoom moves the surface under its own gesture. The chart marquee
    // drives it (it authors nothing, and — unlike the viewport's — it takes capture only PAST the
    // dead zone, so `data-dragging` here is a real armed gesture, not a mere pointerdown; the flip
    // side is that this surface's pre-dead-zone press is the one window the guard leaves open, and
    // it is deliberately not asserted). The idle wheel after release is the positive control (and
    // is what proves the mid-gesture tick reached this surface). Mutation: drop the `editor.dragging`
    // early-return in `Timeline.svelte` `onWheel` → the held view zooms → red (proven against that
    // build: `[pan, pxPerU]` [0, 16.20] → [638.12, 45.83] under the held marquee). ──
    const xView = () => kexCall(page, "xView");
    const rest = await xView();
    await page.mouse.move(xLo, chartTop);
    await page.mouse.down();
    await page.mouse.move(xHi, chartBot, { steps: 6 }); // past the dead zone → the marquee arms
    await expect(page.locator("#app[data-dragging]")).toHaveCount(1); // the gesture IS live
    await page.mouse.wheel(0, -600); // a zoom-in tick a resting chart would answer
    await frames(page, 2); // the wheel is dispatched, not awaited — let any write land
    expect(await xView()).toEqual(rest);
    await page.mouse.up();
    await expect(page.locator("#app[data-dragging]")).toHaveCount(0);
    await page.mouse.wheel(0, -600);
    await expect.poll(async () => (await xView())[1]).toBeGreaterThan(rest[1]);

    // ── 5b. `F` IS ALSO A NO-OP DURING A LIVE GESTURE (kex2d-gesture-residue stage 2) — the
    // timeline half; the viewport half rides the viewport multiselect flow, and both surfaces
    // guard on the SAME `editor.dragging` flag. `Timeline.svelte`'s `F` handler carried no
    // guard at all before this stage (unlike its `onWheel` twin, above). A fresh marquee is the
    // vehicle (it authors nothing, same as 5); the idle wheel just above left `pxPerU` PAST the
    // whole-section `F`-frame target established at `frameTimeline` (line 3315), so a real
    // reframe under this section is detectable — pinning the guard against a view already equal
    // to its own no-op target proves nothing (the false-negative section 5's wheel case avoids
    // by using a relative zoom instead). The idle `F` after release is the positive control: it
    // MUST reframe back toward the section fit (pxPerU decreases), so a guard that merely eats
    // the key outright can't pass the pair. Mutation: drop the `editor.dragging` guard in
    // `Timeline.svelte`'s `F` handler → the held view reframes under the marquee → red. ──
    const zoomed = await xView();
    await page.mouse.move(xLo, chartTop);
    await page.mouse.down();
    await page.mouse.move(xHi, chartBot, { steps: 6 }); // past the dead zone → the marquee arms
    await expect(page.locator("#app[data-dragging]")).toHaveCount(1); // the gesture IS live
    await page.keyboard.press("f");
    await frames(page, 2);
    expect(await xView()).toEqual(zoomed);
    await page.mouse.up();
    await expect(page.locator("#app[data-dragging]")).toHaveCount(0);
    await page.keyboard.press("f");
    await expect.poll(async () => (await xView())[1]).toBeLessThan(zoomed[1]);

    // ── 6. WINDOW BLUR TEARS DOWN A LIVE KEYFRAME DRAG (kex2d-gesture-residue stage 3) — the
    // unmount cancel set (`endScrub`/`sliderUp`/`panUp`/`navUp`/`cancelForceDrag`/`marqueeCancel`/
    // `cancelTanDrag`/`cancelLenDrag`/`endDragGesture`) is now factored into `cancelAll` and also
    // runs on a window blur (`Timeline.svelte`, mirroring `controls.ts`'s `onBlur`). A blur
    // mid-drag delivers no pointerup, so without the listener the gesture SURVIVES the focus
    // loss: the point stays moved, `editor.dragging` sticks (eating wheel zoom — the same flag 5
    // above rides — until the next completed drag elsewhere), and no history entry ever closes
    // the bracketed edit. The crest (index 2) is the vehicle — a plain keyframe drag, not the
    // marquee driving 5/5b. The mid-drag read is the positive control (the RED-RIG TRAP: a
    // revert-to-X assert is a false negative if the point never left X) — it proves the point
    // actually displaced before the blur is trusted to have reverted it. Mutation: an
    // empty/missing blur listener → the point stays moved, `data-dragging` stays 1, the idle
    // wheel after stays a no-op, and undo depth is unchanged either way (nothing here commits) →
    // red on the position and dragging-flag assertions. ──
    const undoDepth = () => kexCall(page, "undoDepth");
    const preForce = (await forces())[2];
    const preUndo = await undoDepth();
    await page.mouse.move(b2.cx, b2.cy);
    await page.mouse.down();
    await page.mouse.move(b2.cx + 40, b2.cy - 30, { steps: 8 }); // well past DRAG_PX
    await expect(page.locator("#app[data-dragging]")).toHaveCount(1); // the gesture IS live
    const midForce = (await forces())[2];
    // positive control: the drag actually moved the point before trusting the revert below
    expect(Math.hypot(midForce.s - preForce.s, midForce.g - preForce.g)).toBeGreaterThan(0.1);

    await page.evaluate(() => window.dispatchEvent(new Event("blur"))); // button still "held"

    const revertedForce = (await forces())[2];
    expect(revertedForce.s).toBeCloseTo(preForce.s, 5); // (a) reverted to the pre-drag s/g
    expect(revertedForce.g).toBeCloseTo(preForce.g, 5);
    await expect(page.locator("#app[data-dragging]")).toHaveCount(0); // (b) the flag cleared
    expect(await undoDepth()).toBe(preUndo); // (c) the torn-down gesture committed nothing

    const restXView = await xView();
    await page.mouse.wheel(0, -600); // (b) wheel zoom writes xView again
    await expect.poll(async () => (await xView())[1]).toBeGreaterThan(restXView[1]);
    await page.mouse.up(); // release cleanly — a torn-down gesture commits nothing on pointerup
    expect(await undoDepth()).toBe(preUndo);

    // kex2d-time-domain stage 1 (second rescope): the multi-set popover is retired, and the
    // selection here is still the 3-member set from 5/5b (a plain click/drag on a member keeps the
    // set — the multiselect law's promote-vs-replace rule), so no `.ptip` is showing. Esc clears
    // the whole set as one dismissal rung, then a plain click SINGLE-selects the crest (re-located:
    // the intervening zooms in 5/5b shifted its screen position) so its popover opens for step 7's
    // label scrub.
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await forceSelIds()).length).toBe(0);
    // re-fit the whole section (5/5b's zoom + reframe left the view somewhere else) so the
    // ORIGINAL diamond index mapping (`fhitCenter`, established at the top of the test) is valid
    // again before re-locating the crest.
    await frameTimeline(page);
    await expect(fhit).toHaveCount(5); // 5 force points, no strip of its own (S3: seed() carries no strip)
    const b2now = await fhitCenter(2);
    await page.mouse.click(b2now.cx, b2now.cy);
    await expect(page.locator(".ptip")).toHaveCount(1);

    // ── 7. WINDOW BLUR ALSO TEARS DOWN A LIVE LABEL SCRUB (adversarial-review finding on
    // kex2d-gesture-residue stage 5): `labelScrub`'s move/up/pointercancel listeners live on the
    // LABEL element, not window, so `cancelAll`'s blur path needs its OWN hook into them
    // (`cancelLabelScrub`) — the generic `endDragGesture()` call (step 6's mechanism) only clears
    // the drag FLAG, it doesn't reach a listener set attached to a different element. The crest's
    // now-single-selected popover is the vehicle: grab its "F" (g) label. RED-RIG TRAP: the
    // mid-scrub read is the positive control, proving the scrub actually wrote before the revert
    // below is trusted. Mutation: `cancelAll` with no `cancelLabelScrub` hook → the point stays at
    // its mid-scrub g and undo depth is unchanged either way (nothing here commits without the
    // hook) → red on the reverted-value assertion. ──
    const gLabel = page.locator(".ptip .fld").nth(1).locator(".key");
    const gLabelBox = await gLabel.boundingBox();
    if (!gLabelBox) throw new Error("crest g scrub handle not laid out for the blur-cancel check");
    const preScrubForce = (await forces())[2];
    const preScrubUndo = await undoDepth();
    await page.mouse.move(gLabelBox.x + gLabelBox.width / 2, gLabelBox.y + gLabelBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(
        gLabelBox.x + gLabelBox.width / 2 + 40,
        gLabelBox.y + gLabelBox.height / 2,
        { steps: 8 },
    );
    const midScrubForce = (await forces())[2];
    expect(Math.abs(midScrubForce.g - preScrubForce.g)).toBeGreaterThan(0.1); // positive control

    await page.evaluate(() => window.dispatchEvent(new Event("blur"))); // button still "held"

    const revertedScrubForce = (await forces())[2];
    expect(revertedScrubForce.g).toBeCloseTo(preScrubForce.g, 5); // reverted to the pre-scrub g
    expect(await undoDepth()).toBe(preScrubUndo); // the torn-down scrub committed nothing
    await page.mouse.up(); // release cleanly — the label's listeners are already detached
    expect(await undoDepth()).toBe(preScrubUndo);

    // a FRESH scrub on the SAME label proves the stale listener set is actually gone (the
    // double-fire symptom otherwise): exactly one new commit, and the write lands near one
    // scrub's worth of movementX, not double.
    await page.mouse.move(gLabelBox.x + gLabelBox.width / 2, gLabelBox.y + gLabelBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(
        gLabelBox.x + gLabelBox.width / 2 + 40,
        gLabelBox.y + gLabelBox.height / 2,
        { steps: 8 },
    );
    await page.mouse.up();
    const afterFreshScrub = (await forces())[2];
    expect(Math.abs(afterFreshScrub.g - preScrubForce.g)).toBeLessThan(0.6); // one scrub, not two
    expect(await undoDepth()).toBe(preScrubUndo + 1); // exactly one new entry
});

// Drive the CONTENT-ANCHORED PLAYHEAD PARKING flow (section-editor stage 3, fork 4): a
// mixed geo→force chain with a force keyframe → park the playhead over the force section
// via a REAL ruler scrub → drag the keyframe's g so the bake re-times → assert the parked
// playhead's arclength held (glued to the track feature) while the ride re-timed. Without
// content-anchoring the playhead is pinned to ride-time and would slide under the re-time.
test("playhead parking flow", async ({ page, boot }) => {
    await boot();

    const sectionKinds = () => kexCall(page, "sectionKinds");
    const forceCounts = () => kexCall(page, "sectionForceCounts");
    const cartArc = () => kexCall(page, "cartArc");
    const parked = () => kexCall(page, "parked");
    const tTotal = () => kexCall(page, "tTotal");
    const strip = dockStrip(page);

    // seed a geo section, append a force one via the real + flyout → a mixed chain.
    await seedHill(page);
    await page.locator(".clip-add").click();
    await page.getByRole("menuitem", { name: "Append force section" }).click();
    await expect.poll(async () => (await sectionKinds()).join(",")).toBe("0,1");
    await frameTimeline(page); // append never pans; frame the grown chain into view

    const body = page.locator(".dock .body");
    const bb = await body.boundingBox();
    if (!bb) throw new Error("timeline body not laid out");

    // ── 1. Author a keyframe by double-clicking the chart over the force section — the
    // handle the later re-time will drag. appendSection already seeded two continuation
    // keyframes (stage B) at the section's entry/exit; this adds a third, interior one. ──
    const fcb = await page.locator(".clip").nth(1).boundingBox(); // the force clip
    if (!fcb) throw new Error("force clip not laid out");
    await expect.poll(async () => (await forceCounts())[1]).toBe(2); // the two seeds
    await page.mouse.dblclick(fcb.x + fcb.width / 2, bb.y + bb.height * 0.5);
    await expect.poll(async () => (await forceCounts())[1]).toBe(3); // + the authored keyframe

    // ── 2. Park the playhead over the force section via a real RULER scrub — a click in
    // the ruler band (above the clip lane) at the force section's x. it parks (held) at
    // that content anchor and stops the cart. ──
    await page.mouse.click(fcb.x + fcb.width / 2, bb.y + 13); // ruler band y (< RULER_H)
    await expect.poll(parked).toBe(true);
    const arc1 = await cartArc();
    const tt1 = await tTotal();
    if (arc1 === null) throw new Error("cartArc null after park");
    if (strip) await page.screenshot({ path: join(OUT, "park-1-anchored.png"), clip: strip });

    // ── 3. Drag the keyframe's g (vertical drag on its fat hit circle) → the force
    // profile changes, the bake re-times (tTotal shifts). `.fhit` is shared with velocity-
    // strip keyframes (Timeline.svelte draws force points first, strip keyframes after, in
    // that DOM order), and `seed()` (S3) no longer carries its own strip on section 0 — the
    // track-start one-shot is a distinct point kind, no `Strip`/`StripKeyframe` row — so 3
    // total, all force points. three points now exist (the two seeds + the authored one);
    // grab the AUTHORED one — the middle by s (and so by x), sorted between the entry seed
    // (s=0) and the exit seed (s=length). ──
    const fhit = page.locator(".fhit");
    await expect(fhit).toHaveCount(3);
    const hb = await fhit.nth(1).boundingBox();
    if (!hb) throw new Error("force point hit target not laid out");
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + 60, { steps: 10 });
    await page.mouse.up();

    // the ride re-timed (the bake's total time changed)…
    await expect.poll(async () => Math.abs((await tTotal()) - tt1) > 1e-3).toBe(true);
    // …but the parked playhead stayed glued to the same track arclength (the fix — a
    // ride-time-pinned playhead would have slid when the timing changed).
    const arc2 = await cartArc();
    if (arc2 === null) throw new Error("cartArc null after re-time");
    expect(arc2).toBeCloseTo(arc1, 1);
    expect(await parked()).toBe(true);
    if (strip) await page.screenshot({ path: join(OUT, "park-2-held.png"), clip: strip });
});

// The TRACK DOMAIN picker (S6, "arclength is canonical, time is a lens"): `Track.domain` is a
// VIEW now, not a document conversion — every force keyframe's stored `s` and every force
// section's extent stay in meters of arclength always, so picking Seconds writes exactly one
// column and re-labels the ruler/readouts, never the store. This flow pins the lens contract at
// that depth, the only place it can be pinned honestly (a real browser, a real menu pick):
//
//   · the checked row follows `Track.domain`, and picking it is a no-op — no entry, no write;
//   · picking the other row flips the column in ONE undo entry (`history.landDomain` always
//     records one — read off the code, not assumed) and `forces()` reads BYTE-IDENTICAL to the
//     pre-flip snapshot, since there is no conversion left to move a single stored number;
//   · undo is the way back: one entry, `forces()`/`domain()` both restored exactly;
//   · the converting row GRAYS where `domain.convertible` reads false (no live bake) — reached
//     honestly by running a force section off the end of the flat SoA, the one persistent such
//     state; `convertible` still exists post-S6 (it now reads `bakeLive` alone), so this case
//     stays covered here.
//
// What this flow does NOT cover: the Time-view ruler/readout PROJECTION through the live bake's
// s↔t table, the gesture-start table freeze, and drag-in-Seconds placement — S6 retired the old
// "store is the time reading" mechanism those used to ride (§ locked decision, "What this gives
// up"), and S6b is the stage that builds their replacement (`timeline.ts`'s `dToU`/`uToD`
// projected onto force keyframes/strips the way geo already reads them). This flow extends there
// once that projection exists, rather than asserting anything about it now.
test("timeline domain flow", async ({ page, boot }) => {
    await boot();

    const forces = () => kexCall(page, "forces");
    const forceCount = () => kexCall(page, "forceCount");
    const domain = () => kexCall(page, "domain");
    const undoDepth = () => kexCall(page, "undoDepth");
    const tTotal = () => kexCall(page, "tTotal");
    const rulerZone = page.locator(".rulerzone");
    const openRulerMenu = () => rulerZone.click({ button: "right", position: { x: 40, y: 10 } });

    // a force section with real keyframes: two continuation seeds + the three airtime-bump points.
    await kexCall(page, "seedForceBump");
    await expect.poll(forceCount).toBe(5);
    await expect.poll(tTotal).toBeGreaterThan(0);
    await frameTimeline(page); // the whole section on-screen

    // ── 1. Distance is the default: Meters reads checked, Seconds not. A live bake exists here
    // (the seeded points baked above), so Seconds is ENABLED — the gray case is a track the
    // conversion can't run on (no live bake, a section off the bake), unit-covered in
    // `domain.test.ts` against the same `convertible` reading this row grays on. Picking the
    // already-checked row is a no-op: nothing written, nothing recorded. ──
    expect(await domain()).toBe("distance");
    const metres = await forces();
    const undo0 = await undoDepth();
    await openRulerMenu();
    // the right-click that opened this menu also FOCUSED the ruler (`.rulerzone`'s `tabindex="0"`,
    // for arrow-key scrub) — the pointer-focus-border fix's own repro: a click/right-click focus
    // must draw no outline (only a keyboard-driven Tab focus rings the playhead grip instead).
    expect(await rulerZone.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("none");
    const metersRow = page.locator(".rmenu").getByRole("menuitem", { name: "Meters" });
    const secondsRow = page.locator(".rmenu").getByRole("menuitem", { name: "Seconds" });
    await expect(metersRow).toHaveClass(/checked/);
    await expect(secondsRow).not.toHaveClass(/checked/);
    await expect(secondsRow).toBeEnabled();
    await clickMenuItem(page, ".rmenu", "Meters"); // the checked row — a no-op
    await expect(page.locator(".rmenu")).toHaveCount(0); // a leaf action dismisses the menu regardless
    expect(await domain()).toBe("distance");
    expect(await forces()).toEqual(metres);
    expect(await undoDepth()).toBe(undo0);

    // ── 2. The Seconds row, pointer-true. It writes ONE undo entry and the STORE DOES NOT
    // CONVERT: `forces()` reads byte-identical to the Meters snapshot, since S6 retired the
    // document-conversion op that used to rewrite every keyframe's stored number here. ──
    await openRulerMenu();
    await clickMenuItem(page, ".rmenu", "Seconds");
    await expect.poll(domain).toBe("time");
    expect(await forces()).toEqual(metres); // byte-identical — the lens changes no stored number
    expect(await undoDepth()).toBe(undo0 + 1); // one entry for the flip (`history.landDomain`)
    // the checked row FOLLOWS the store's `Track.domain`: reopen and assert it flipped (a
    // hardcoded `checked` would sail through the pre-flip assert above).
    await openRulerMenu();
    await expect(secondsRow).toHaveClass(/checked/);
    await expect(metersRow).not.toHaveClass(/checked/);
    await page.keyboard.press("Escape");
    await expect(page.locator(".rmenu")).toHaveCount(0);

    // ── 3. Undo is the way back, byte-identically: one entry, both `domain()` and `forces()`
    // restored exactly (trivially so, since the store never moved). ──
    await page.keyboard.press("Control+z");
    await expect.poll(domain).toBe("distance");
    expect(await forces()).toEqual(metres);
    expect(await undoDepth()).toBe(undo0);

    // ── 4. The CONVERTING row grays where `domain.convertible` reads false (`editor-ui.md`: gray
    // a row whose preconditions fail — never hide it, and never leave it clickable into a silent
    // no-op). Reached honestly: stretch this force section past the whole-track sample budget,
    // then append a second one — the appended section starts beyond the end of the flat SoA, so
    // `bakeLive` — the reading `convertible` is now built on entirely — cannot certify it. The
    // enabled assert in 1 is this one's positive control: the same row, the same locator. ──
    await kexCall(page, "setLen", 0, SAMPLE_BUDGET_M * 1.5);
    expect((await kexCall(page, "sectionLengths"))[0]).toBe(SAMPLE_BUDGET_M * 1.5);
    await kexCall(page, "append", 1); // SectionKind.Force — off the buffer at this offset
    await expect.poll(async () => (await kexCall(page, "sectionKinds")).length).toBe(2);
    await openRulerMenu();
    await expect(secondsRow).toBeDisabled(); // the pick that would convert
    await expect(metersRow).toBeEnabled(); // …while the active row stays lit (its pick is a no-op)
    await expect(metersRow).toHaveClass(/checked/);
    await page.keyboard.press("Escape");
    await expect(page.locator(".rmenu")).toHaveCount(0);
    expect(await domain()).toBe("distance");
    expect(await forces()).toEqual(metres); // …and the store this flow drove is untouched
});

// S6 criterion (c): the Time-view gesture writes arclength through the GESTURE-FROZEN s↔t table
// (`s0 + (dOf(u) - dOf(u0))`), never a raw chart-axis delta — and the diamond's drawn x tracks
// the pointer mid-drag. RED on the pre-fix tree: `applyDrag`/`applyLen` added the chart-axis
// (seconds-in-Time-view) delta straight to the metres store, so a Time-view drag/trim corrupted
// `Force.s`/`Section.length` by orders of magnitude (V0's own scale) rather than landing near the
// pointer at all. The oracle here is `Timeline.svelte`'s own `dOf`/`uOf` (`__kex` DEV bridges),
// read BEFORE each gesture starts — the same live table the gesture then freezes — so a change to
// the internal freeze/projection wiring that silently drifted from this contract would fail here
// even where the numbers still looked plausible.
test("timeline domain flow — Time-view gesture writes arclength through the frozen table (S6c)", async ({
    page,
    boot,
}) => {
    await boot();
    const forces = () => kexCall(page, "forces");
    const forceU = () => kexCall(page, "forceU");
    const forceCount = () => kexCall(page, "forceCount");
    const domain = () => kexCall(page, "domain");
    const sectionLengths = () => kexCall(page, "sectionLengths");
    const dOf = (u: number) => kexCall(page, "dOf", u);
    const dOfTrim = (u: number) => kexCall(page, "dOfTrim", u);
    const uOf = (d: number) => kexCall(page, "uOf", d);
    const xView = () => kexCall(page, "xView");
    const rulerZone = page.locator(".rulerzone");
    const openRulerMenu = () => rulerZone.click({ button: "right", position: { x: 40, y: 10 } });

    await kexCall(page, "seedForceBump");
    await expect.poll(forceCount).toBe(5);
    await kexCall(page, "setV0", 25); // a non-default speed so v(s) is genuinely non-constant
    await frameTimeline(page);

    // switch to Seconds — the projected axis every gesture below must go through.
    await openRulerMenu();
    await clickMenuItem(page, ".rmenu", "Seconds");
    await expect.poll(domain).toBe("time");
    await frames(page, 2);

    // ── drag arm: the airtime crest (index 2, s = 0.5·len), a real pointer, Ctrl-held to bypass
    // the snap magnet — this flow tests the raw delta formula, not snapping (`section.pw.ts`'s
    // own convention for an extent-trim drag). ──
    const crest = 2;
    const before = await forces();
    const beforeU = await forceU();
    const s0 = before[crest].s;
    const u0 = beforeU[crest].u;
    const [, pxPerU] = await xView();
    const DragPx = 60; // well past SNAP_PX, so no landmark/gesture-start magnet fires
    const uFinal = u0 + DragPx / pxPerU;
    // read the table BOTH values will be checked against — BEFORE the gesture starts, the same
    // live snapshot `keyframeDown` freezes into `gestureMapping`.
    const dU0 = await dOf(u0);
    const dUFinal = await dOf(uFinal);

    const fhit = page.locator(".fhit");
    const grab = await fhit.nth(crest).boundingBox();
    if (!grab) throw new Error("the crest diamond is not laid out");
    const gx = grab.x + grab.width / 2;
    const gy = grab.y + grab.height / 2;
    await page.mouse.move(gx, gy);
    await page.mouse.down();
    await page.keyboard.down("Control");
    // move in two steps so the mid-drag "tracks the pointer" claim is checked WHILE the gesture
    // is live, not only at release.
    await page.mouse.move(gx + DragPx / 2, gy, { steps: 6 });
    await frames(page, 1);
    const mid = await fhit.nth(crest).boundingBox();
    if (!mid) throw new Error("the crest diamond vanished mid-drag");
    expect(Math.abs(mid.x + mid.width / 2 - (gx + DragPx / 2))).toBeLessThan(3);
    await page.mouse.move(gx + DragPx, gy, { steps: 6 });
    await frames(page, 1);
    const end = await fhit.nth(crest).boundingBox();
    if (!end) throw new Error("the crest diamond vanished mid-drag");
    expect(Math.abs(end.x + end.width / 2 - (gx + DragPx))).toBeLessThan(3);
    await page.keyboard.up("Control");
    await page.mouse.up();

    const len = before[crest] ? (await sectionLengths())[0] : 0;
    const expectedS = Math.max(0, Math.min(len, s0 + (dUFinal - dU0)));
    const landed = (await forces())[crest].s;
    expect(landed).toBeCloseTo(expectedS, 0);
    // the positive control: the corrupted (pre-fix) formula would have added the RAW seconds
    // delta (`uFinal - u0`, small at this speed) straight to `s0`, landing far from `expectedS`
    // whenever the two differ by more than a rounding error.
    if (Math.abs(dUFinal - dU0 - (uFinal - u0)) > 0.5) {
        expect(Math.abs(landed - (s0 + (uFinal - u0)))).toBeGreaterThan(0.5);
    }
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await forces())[crest].s).toBeCloseTo(s0, 6);

    // ── trim arm: the force clip's right-edge extent handle, same table, same convention. ──
    const lenStartU = (await forceU())[0].u; // the section's own entry (s = 0 seed)
    const dLenStart = await dOf(lenStartU);
    const len0 = (await sectionLengths())[0];
    const trimU0 = await uOf(dLenStart + len0); // the handle's own current axis position
    const trim = page.locator(".clip-trim");
    await expect(trim).toHaveCount(1);
    const tb = await trim.boundingBox();
    if (!tb) throw new Error("trim handle not laid out");
    const [, pxPerU2] = await xView();
    const TrimPx = 50;
    const trimUFinal = trimU0 + TrimPx / pxPerU2;
    const dTrimStart = await dOf(lenStartU);
    // `dOfTrim` (S6b), not `dOf`: the extent trim EXTRAPOLATES past the bake's own end (the
    // handle's landing here reaches into the ruler's lead-out margin at this zoom) — `dOf`'s own
    // clamp is what `applyLen` used to read and no longer does.
    const dTrimFinal = await dOfTrim(trimUFinal);
    const tcy = tb.y + tb.height / 2;
    await trim.hover();
    await page.keyboard.down("Control");
    await page.mouse.down();
    await page.mouse.move(tb.x + tb.width / 2 + TrimPx, tcy, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.up("Control");
    const expectedLen = dTrimFinal - dTrimStart;
    await expect.poll(async () => (await sectionLengths())[0]).toBeCloseTo(expectedLen, 0);
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await sectionLengths())[0]).toBeCloseTo(len0, 3);
});

// S6b: the ruler and every readout (a selected keyframe's typed field here — the extent trim and
// strip/keyframe positions share the SAME `uOf`-projected fields this flow's S6c sibling already
// pins, `forceU().u`/`BandStrip.u0`/`StripKfPt.u`) project through the live bake's t(s) table, and
// an extent trim dragged past the bake's own end EXTRAPOLATES at the exit speed instead of
// clamping to the last finite sample. RED on the pre-fix tree: `applyLen` read plain `dOf`
// (`uToD`'s own clamp at `mapping.t[n-1]`), so dragging the trim handle into the ruler's own
// lead-out margin landed the extent at the bake's CURRENT total arclength no matter how far past
// it the cursor went — confirmed by temporarily reverting `uToDExtend` to its clamped form and
// restoring after (`timeline.test.ts`'s own red-first witness pins the pure function; this pins
// the wiring).
test("timeline domain flow — Time-view readouts project through t(s), and the extent trim extrapolates past the bake's end (S6b)", async ({
    page,
    boot,
}) => {
    await boot();
    const forceU = () => kexCall(page, "forceU");
    const forceCount = () => kexCall(page, "forceCount");
    const domain = () => kexCall(page, "domain");
    const sectionLengths = () => kexCall(page, "sectionLengths");
    const dOf = (u: number) => kexCall(page, "dOf", u);
    const dOfTrim = (u: number) => kexCall(page, "dOfTrim", u);
    const uOf = (d: number) => kexCall(page, "uOf", d);
    const tTotal = () => kexCall(page, "tTotal");
    const xView = () => kexCall(page, "xView");
    const rulerZone = page.locator(".rulerzone");
    const openRulerMenu = () => rulerZone.click({ button: "right", position: { x: 40, y: 10 } });

    await kexCall(page, "seedForceBump");
    await expect.poll(forceCount).toBe(5);
    await kexCall(page, "setV0", 25); // a non-default speed, S6c's own convention -- v(s) genuinely varies
    await frameTimeline(page);

    await openRulerMenu();
    await clickMenuItem(page, ".rmenu", "Seconds");
    await expect.poll(domain).toBe("time");
    await frames(page, 2);

    // ── (d), the keyframe readout: the selected point's typed position field shows the
    // PROJECTED time (`uOf`), never the raw stored arclength -- the same seam the diamond's
    // drawn x and every gesture writer already read through (S6a). ──
    const crest = 2;
    const before = await forceU();
    const fhit = page.locator(".fhit");
    const grab = await fhit.nth(crest).boundingBox();
    if (!grab) throw new Error("the crest diamond is not laid out");
    await page.mouse.click(grab.x + grab.width / 2, grab.y + grab.height / 2);
    const posField = page.locator('input[aria-label="Point time (s)"]');
    await expect(posField).toBeVisible();
    const expectedU = await uOf(before[crest].s);
    const shownU = Number(await posField.inputValue());
    expect(shownU).toBeCloseTo(expectedU, 1);
    // the positive control: the raw stored arclength (what a pre-S6a display would have shown)
    // reads far from the projected time at this non-default speed.
    expect(Math.abs(shownU - before[crest].s)).toBeGreaterThan(0.5);
    await page.keyboard.press("Escape");

    // ── the extent trim, dragged past the bake's own end. read the projection BOTH ways
    // (`dOf`'s clamp and `dOfTrim`'s extrapolation) BEFORE the gesture starts -- the same live
    // table `lenDown` will freeze. ──
    const lenStartU = (await forceU())[0].u; // the section's own entry (s = 0 seed)
    const dLenStart = await dOf(lenStartU);
    const len0 = (await sectionLengths())[0];
    const trimU0 = await uOf(dLenStart + len0); // the handle's own current axis position
    const uPastEnd = (await tTotal()) + 2; // 2s past the bake's own end, into the lead-out margin
    const clampedD = await dOf(uPastEnd); // what the OLD (pre-S6b) clamp would have landed at
    const extrapolatedD = await dOfTrim(uPastEnd); // what the extrapolation lands at
    expect(extrapolatedD).toBeGreaterThan(clampedD + 1); // the two genuinely diverge past the end

    const trim = page.locator(".clip-trim");
    await expect(trim).toHaveCount(1);
    const tb = await trim.boundingBox();
    if (!tb) throw new Error("trim handle not laid out");
    const [, pxPerU] = await xView();
    const dragPx = (uPastEnd - trimU0) * pxPerU;
    const tcy = tb.y + tb.height / 2;
    await trim.hover();
    await page.keyboard.down("Control"); // bypass the snap magnet -- deterministic px
    await page.mouse.down();
    await page.mouse.move(tb.x + tb.width / 2 + dragPx, tcy, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.up("Control");

    const expectedLen = extrapolatedD - dLenStart;
    await expect.poll(async () => (await sectionLengths())[0]).toBeCloseTo(expectedLen, 0);
    // the positive control: the pre-fix clamped formula would have landed far short of this.
    const landedLen = (await sectionLengths())[0];
    expect(Math.abs(landedLen - (clampedD - dLenStart))).toBeGreaterThan(0.5);
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await sectionLengths())[0]).toBeCloseTo(len0, 3);
});

// finding 9 (kex2d-event-lane S1): a force-section lengthen not visualizing in Time view. S6b
// above pins the STORE (`sectionLengths()` lands at the extrapolated extent) but never reads the
// trim handle's own drawn x mid-gesture — so it stayed green across the defect this flow now
// pins. RED on the pre-fix tree: `clips`' u1 read plain `dToU` (`uOf`) even while the write
// (`applyLen`) went through `uToDExtend`, so once the drag crossed the gesture-frozen table's own
// end the handle's screen x froze at that crossing point for the REST of the drag while
// `sectionLengths()` kept growing underneath it — confirmed by temporarily reverting
// `Timeline.svelte`'s `clips` to plain `uOf` and restoring after (`timeline.test.ts`'s own
// red-first witness pins the pure function; this pins the wiring a real pointer drives).
test("timeline domain flow — the trim handle's drawn edge tracks the pointer past the bake's own end, not just the store (finding 9, S1)", async ({
    page,
    boot,
}) => {
    await boot();
    const forceU = () => kexCall(page, "forceU");
    const forceCount = () => kexCall(page, "forceCount");
    const domain = () => kexCall(page, "domain");
    const sectionLengths = () => kexCall(page, "sectionLengths");
    const dOf = (u: number) => kexCall(page, "dOf", u);
    const uOf = (d: number) => kexCall(page, "uOf", d);
    const tTotal = () => kexCall(page, "tTotal");
    const xView = () => kexCall(page, "xView");
    const rulerZone = page.locator(".rulerzone");
    const openRulerMenu = () => rulerZone.click({ button: "right", position: { x: 40, y: 10 } });

    await kexCall(page, "seedForceBump");
    await expect.poll(forceCount).toBe(5);
    await kexCall(page, "setV0", 25); // a non-default speed, S6's own convention -- v(s) genuinely varies
    await frameTimeline(page);

    await openRulerMenu();
    await clickMenuItem(page, ".rmenu", "Seconds");
    await expect.poll(domain).toBe("time");
    await frames(page, 2);

    const lenStartU = (await forceU())[0].u; // the section's own entry (s = 0 seed)
    const dLenStart = await dOf(lenStartU);
    const len0 = (await sectionLengths())[0];
    const trimU0 = await uOf(dLenStart + len0); // the handle's own current axis position
    const uPastEnd = (await tTotal()) + 2; // 2s past the bake's own end, into the lead-out margin
    const [, pxPerU] = await xView();
    const dragPxToEnd = ((await tTotal()) - trimU0) * pxPerU; // crosses the bake's end exactly
    const dragPxTotal = (uPastEnd - trimU0) * pxPerU; // well past it

    const trim = page.locator(".clip-trim");
    await expect(trim).toHaveCount(1);
    const tb = await trim.boundingBox();
    if (!tb) throw new Error("trim handle not laid out");
    const tcy = tb.y + tb.height / 2;
    const startX = tb.x + tb.width / 2;
    await trim.hover();
    await page.keyboard.down("Control"); // bypass the snap magnet -- deterministic px
    await page.mouse.down();

    // first move: exactly to the bake's own end -- the handle still tracks the pointer, and the
    // store agrees (both sides of the crossing point coincide by construction, S1's own witness).
    await page.mouse.move(startX + dragPxToEnd, tcy, { steps: 6 });
    await frames(page, 1);
    const atEnd = await trim.boundingBox();
    if (!atEnd) throw new Error("trim handle vanished mid-drag");
    expect(Math.abs(atEnd.x + atEnd.width / 2 - (startX + dragPxToEnd))).toBeLessThan(4);

    // second move: 2s further, past the bake's own end and into the extrapolating regime -- the
    // defect this flow pins is the handle freezing HERE while the store keeps advancing.
    await page.mouse.move(startX + dragPxTotal, tcy, { steps: 6 });
    await frames(page, 1);
    const pastEnd = await trim.boundingBox();
    if (!pastEnd) throw new Error("trim handle vanished mid-drag");
    expect(Math.abs(pastEnd.x + pastEnd.width / 2 - (startX + dragPxTotal))).toBeLessThan(4);
    // the positive control: a frozen handle would still read at `atEnd`'s own x, well short of
    // this move's target -- the invisible lengthen, had the fix not landed.
    expect(pastEnd.x - atEnd.x).toBeGreaterThan(4);

    await page.mouse.up();
    await page.keyboard.up("Control");
    await expect.poll(async () => (await sectionLengths())[0]).toBeGreaterThan(len0);
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await sectionLengths())[0]).toBeCloseTo(len0, 3);
});

// finding 9's mechanism gap (adversarial pass on 0f6335a): the FIRST fix conditioned the
// extrapolating read on `sec.id === lenId` alone, but `sectionSpans` accumulates every
// downstream section's `offset` from the LIVE bake — so once an upstream lengthen crosses the
// gesture-frozen table's own end, a downstream section's cumulative offset exceeds it too, and
// plain `dToU` clamps ITS clip edges exactly the same way. RED on the pre-fix (0f6335a) tree:
// only the dragged clip's own edge read through `dToUExtend`; a downstream clip stayed on plain
// `uOf` and froze in lockstep with the pre-first-fix defect — confirmed by temporarily reverting
// the `lenId`-gated extrapolation to plain `uOf` for every clip and restoring after.
test("timeline domain flow — a downstream clip's edge also tracks an upstream lengthen past the bake's own end (finding 9 mechanism gap, S1)", async ({
    page,
    boot,
}) => {
    await boot();
    const forceU = () => kexCall(page, "forceU");
    const forceCount = () => kexCall(page, "forceCount");
    const domain = () => kexCall(page, "domain");
    const sectionCount = () => kexCall(page, "sectionCount");
    const sectionLengths = () => kexCall(page, "sectionLengths");
    const dOf = (u: number) => kexCall(page, "dOf", u);
    const uOf = (d: number) => kexCall(page, "uOf", d);
    const tTotal = () => kexCall(page, "tTotal");
    const xView = () => kexCall(page, "xView");
    const rulerZone = page.locator(".rulerzone");
    const openRulerMenu = () => rulerZone.click({ button: "right", position: { x: 40, y: 10 } });

    await kexCall(page, "seedForceBump");
    await expect.poll(forceCount).toBe(5);
    await kexCall(page, "setV0", 25); // a non-default speed, S6's own convention -- v(s) genuinely varies
    await kexCall(page, "append", 1); // SectionKind.Force -- a second, DOWNSTREAM force section
    await expect.poll(sectionCount).toBe(2);
    await frameTimeline(page);

    await openRulerMenu();
    await clickMenuItem(page, ".rmenu", "Seconds");
    await expect.poll(domain).toBe("time");
    await frames(page, 2);

    const lenStartU = (await forceU())[0].u; // section 0's own entry (s = 0 seed)
    const dLenStart = await dOf(lenStartU);
    const len0 = (await sectionLengths())[0];
    const trimU0 = await uOf(dLenStart + len0); // section 0's own trim handle, its current axis position
    const uPastEnd = (await tTotal()) + 2; // 2s past the bake's own end, into the lead-out margin
    const [, pxPerU] = await xView();
    const dragPxToEnd = ((await tTotal()) - trimU0) * pxPerU; // crosses the bake's end exactly
    const dragPxTotal = (uPastEnd - trimU0) * pxPerU; // well past it

    const trims = page.locator(".clip-trim");
    await expect(trims).toHaveCount(2); // both sections are force, each carries its own trim
    const trim = trims.first(); // section 0's own — the one this gesture drags
    const clip1 = page.locator(".clip").nth(1); // section 1's own clip — NOT under this gesture

    const tb = await trim.boundingBox();
    if (!tb) throw new Error("trim handle not laid out");
    const before1 = await clip1.boundingBox();
    if (!before1) throw new Error("downstream clip not laid out");
    const tcy = tb.y + tb.height / 2;
    const startX = tb.x + tb.width / 2;
    await trim.hover();
    await page.keyboard.down("Control"); // bypass the snap magnet -- deterministic px
    await page.mouse.down();

    // first move: exactly to the bake's own end -- section 1 shifts rigidly with section 0's
    // growing exit, same as it would at any point before the crossing.
    await page.mouse.move(startX + dragPxToEnd, tcy, { steps: 6 });
    await frames(page, 1);
    const atEnd1 = await clip1.boundingBox();
    if (!atEnd1) throw new Error("downstream clip vanished mid-drag");

    // second move: 2s further, past the bake's own end -- the mechanism gap this flow pins is
    // section 1's clip freezing HERE (in lockstep with section 0's own pre-first-fix freeze)
    // while section 0's authored length, and section 1's rigidly-shifted offset, keep growing.
    await page.mouse.move(startX + dragPxTotal, tcy, { steps: 6 });
    await frames(page, 1);
    const pastEnd1 = await clip1.boundingBox();
    if (!pastEnd1) throw new Error("downstream clip vanished mid-drag");
    expect(pastEnd1.x - atEnd1.x).toBeGreaterThan(4);
    expect(pastEnd1.x + pastEnd1.width - (atEnd1.x + atEnd1.width)).toBeGreaterThan(4);
    // section 1's OWN width (its authored length) IS invariant between these two reads: by
    // construction of `dragPxToEnd` both of section 1's edges already sit past the frozen
    // table's own end at `atEnd1` (section 0 alone was dragged out to the pre-drag WHOLE-TRACK
    // total, which already pushed all of downstream section 1 past that same total) — so both
    // `atEnd1` and `pastEnd1` read section 1 entirely inside `dToUExtend`'s AFFINE branch
    // (Δu = Δd/vExit), where a rigid arclength shift changes only position, not width, exactly.
    // Tolerance is float/layout noise, not a tuned value: two orders of magnitude above the
    // read residual this same affine identity measures in practice (~3e-5 px) and four orders
    // below the smallest regression this flow already proves it catches (the >4px assertions
    // above) — `before1`, taken BEFORE the gesture (section 1 still in the finite, nonlinear
    // t(s) region), is deliberately excluded from this comparison for exactly that reason.
    expect(pastEnd1.width).toBeCloseTo(atEnd1.width, 3);
    // over the WHOLE gesture, section 1 still shifted right of where it started.
    expect(pastEnd1.x).toBeGreaterThan(before1.x);

    await page.mouse.up();
    await page.keyboard.up("Control");
    await expect.poll(async () => (await sectionLengths())[0]).toBeGreaterThan(len0);
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await sectionLengths())[0]).toBeCloseTo(len0, 3);
});

// S6, create-path instance: the double-click chart-insert and the summoned strip-creation
// station both used to compute a section-local station as a raw chart-axis subtraction
// (`u − c.u0` / `toLocalU(spans, uAtPx(px))`) — the same corruption class the gesture writers
// had, on the CREATE path rather than an edit of an existing entity. RED on the pre-fix tree:
// a double-click in Time view landed the new keyframe at the raw seconds-scaled delta added to
// the section's own axis-projected entry, not the arclength the click implies.
test("timeline domain flow — Time-view double-click create writes arclength (S6c2)", async ({
    page,
    boot,
}) => {
    await boot();
    const forceU = () => kexCall(page, "forceU");
    const forceCount = () => kexCall(page, "forceCount");
    const domain = () => kexCall(page, "domain");
    const dOf = (u: number) => kexCall(page, "dOf", u);
    const xView = () => kexCall(page, "xView");
    const rulerZone = page.locator(".rulerzone");
    const openRulerMenu = () => rulerZone.click({ button: "right", position: { x: 40, y: 10 } });

    await kexCall(page, "seedForceBump");
    await expect.poll(forceCount).toBe(5);
    await kexCall(page, "setV0", 25); // a non-default speed so v(s) is genuinely non-constant
    await frameTimeline(page);

    await openRulerMenu();
    await clickMenuItem(page, ".rmenu", "Seconds");
    await expect.poll(domain).toBe("time");
    await frames(page, 2);

    // click 80px right of the s = 0.2·len seed — clear of every existing keyframe (creation
    // targets exclude them) and the section boundary, no snap magnet in reach.
    const fhit = page.locator(".fhit");
    const ref = await fhit.nth(1).boundingBox();
    if (!ref) throw new Error("the reference diamond is not laid out");
    const refU = (await forceU())[1].u;
    const [, pxPerU] = await xView();
    const OffsetPx = 80;
    const uTarget = refU + OffsetPx / pxPerU;
    const sectionEntryD = await dOf((await forceU())[0].u); // s = 0 seed's own global d
    const expectedS = (await dOf(uTarget)) - sectionEntryD;

    const cx = ref.x + ref.width / 2 + OffsetPx;
    const cy = ref.y + ref.height / 2;
    const before = await forceU();
    await page.keyboard.down("Control"); // bypass the grid/landmark magnet, deterministic px
    await page.mouse.dblclick(cx, cy);
    await page.keyboard.up("Control");
    await expect.poll(forceCount).toBe(6);
    const after = await forceU();
    const beforeIds = new Set(before.map((p) => p.id));
    const created = after.find((p) => !beforeIds.has(p.id));
    if (!created) throw new Error("no new point found after the double-click");
    expect(created.s).toBeCloseTo(expectedS, 0);

    await page.keyboard.press("Control+z");
    await expect.poll(forceCount).toBe(5);
});
// Viewport force markers (kex2d-idioms stage 3): every force keyframe draws ON the baked track —
// the timeline's filled-diamond glyph in force gold, same entity on both surfaces — display +
// select ONLY (s/g authoring stays on the chart; nothing here drags). This flow drives the whole
// contract pointer-true: click-select routes through the one selectForce (the timeline popover
// and Del key address the same selection), shift-click toggles the set, right-click on a set
// member keeps the set and promotes it active (the promote-vs-replace law) while opening the SAME
// keyframe context menu the chart opens, hover reads on the marker under the pointer, empty-click
// deselects, and the viewport marquee stays node-only (markers are never box-hits).
test("viewport force markers flow", async ({ page, boot }) => {
    await boot();

    // seed: convert the seed section to force + the airtime bump — 2 seed keyframes + 3 bump
    // keys. the poke lands synchronously but the markers place off the NEXT bake (forceSample
    // over bakeOut), so wait for the ride time to move off the flat seed's (the seedHill law).
    const tTotal = () => kexCall(page, "tTotal");
    await expect.poll(tTotal).toBeGreaterThan(0);
    const flat = await tTotal();
    await kexCall(page, "seedForceBump");
    await expect.poll(() => kexCall(page, "forceCount")).toBe(5);
    await expect.poll(tTotal).not.toBe(flat);

    const canvas = page.locator("canvas.viewport");
    const cb = await canvas.boundingBox();
    if (!cb) throw new Error("viewport canvas not laid out");

    // frame the track (`F` routes to the hovered viewport) so the five markers separate at
    // pixel scale — at the default ±280 m framing they sit under 10 px apart and neighbouring
    // diamonds overdraw the outline-lift probe's points (positive control: the camera moved).
    const preCam = await kexCall(page, "cam");
    await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 3);
    await page.keyboard.press("f");
    await expect.poll(() => kexCall(page, "cam")).not.toEqual(preCam);

    const markerAt = async (i: number): Promise<{ x: number; y: number }> => {
        const m = await kexCall(page, "forceMarkerAt", i);
        if (!m) throw new Error(`force marker ${i} not placed — the bake never landed`);
        return m;
    };
    const selIds = () => kexCall(page, "forceSelIds");

    // ── 1. click marker 2 (the 0g crest, mid-section — clear of the START diamond at s=0):
    // a replace-select through the one selectForce. ──
    const m2 = await markerAt(2);
    await page.mouse.click(cb.x + m2.x, cb.y + m2.y);
    await expect.poll(async () => (await selIds()).length).toBe(1);
    expect(await kexCall(page, "forceSelActive")).not.toBeNull();

    // ── 2. shift-click marker 3: toggle membership (the multiselect grammar) — a set of 2,
    // the shift-clicked member active. ──
    const m3 = await markerAt(3);
    await page.keyboard.down("Shift");
    await page.mouse.click(cb.x + m3.x, cb.y + m3.y);
    await page.keyboard.up("Shift");
    await expect.poll(async () => (await selIds()).length).toBe(2);
    const activeAfterShift = await kexCall(page, "forceSelActive");

    // ── 3. right-click marker 2 (a member, NOT the active): the set is KEPT, the target
    // promotes to active (promote-vs-replace), and the SAME keyframe context menu the chart
    // opens appears at the cursor. ──
    await page.mouse.click(cb.x + m2.x, cb.y + m2.y, { button: "right" });
    await expect(page.locator(".fmenu")).toHaveCount(1);
    expect((await selIds()).length).toBe(2); // the set survived the right-click
    expect(await kexCall(page, "forceSelActive")).not.toBe(activeAfterShift); // promoted
    // Escape peels the menu rung only (pin both layers: menu ON before the press, gone after,
    // selection still standing).
    await page.keyboard.press("Escape");
    await expect(page.locator(".fmenu")).toHaveCount(0);
    expect((await selIds()).length).toBe(2);

    // ── 4. hover: the marker under the pointer reads on `hoverForce` (the rung the render
    // lifts); empty space clears it. deselect first so the hover isn't member-suppressed. ──
    await page.mouse.click(cb.x + 30, cb.y + 30); // empty corner: deselect all
    await expect.poll(async () => (await selIds()).length).toBe(0);
    const m1 = await markerAt(1);
    await page.mouse.move(cb.x + m1.x, cb.y + m1.y);
    await expect.poll(() => kexCall(page, "hoverForceId")).not.toBeNull();

    // ── 4b. hover LIFTS the glyph's ink OUTLINE (kex2d-idioms 10b): while hovered the diamond
    // strokes hovered(COLOR_FORCE) — the same tone the fill lift wears — instead of ink #0e0d0c,
    // so the hovered tone extends through the stroke band. Probed off the real canvas as a RAY
    // RUN: walk device pixels outward from the marker center along the four axes and take the
    // longest contiguous run of the hovered tone. A 1 px stroke on a 45° diamond edge is √2 px
    // wide along an axis, so with the stroke still ink the hovered FILL run ends at r − 0.71 ≈
    // 4.29; with the stroke lifted the run continues through the band to r + 0.71 ≈ 5.71. The
    // 5.0 px floor splits the two with ~0.7 px beyond either one's worst AA-eaten edge. `center`
    // is the positive control (the fill lift exists with or without the outline lift — proves
    // the probe found a hovered marker). Polled: a cart transit over the marker only delays the
    // read. HOVER_FILL mirrors colors.ts hovered(COLOR_FORCE) = #e4a169; tol 8 (the stage-5 dim
    // probe's bound) separates it from base gold #d49560 (16 apart on red, 12 on green).
    const liftProbe = () =>
        page.evaluate(
            ({ x, y, fill, tol }) => {
                const canvas = document.querySelector<HTMLCanvasElement>("canvas.viewport");
                const ctx = canvas?.getContext("2d");
                if (!canvas || !ctx) return null;
                const r = canvas.getBoundingClientRect();
                const scale = canvas.width / r.width;
                const cx = Math.round(x * scale);
                const cy = Math.round(y * scale);
                const match = (px: number, py: number): boolean => {
                    if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return false;
                    const p = ctx.getImageData(px, py, 1, 1).data;
                    return fill.every((c, i) => Math.abs(p[i] - c) <= tol);
                };
                const run = (dx: number, dy: number): number => {
                    let k = 0;
                    while (match(cx + (k + 1) * dx, cy + (k + 1) * dy)) k++;
                    return k / scale; // device px back to CSS px
                };
                return {
                    center: match(cx, cy),
                    run: Math.max(run(1, 0), run(-1, 0), run(0, 1), run(0, -1)),
                };
            },
            { x: m1.x, y: m1.y, fill: [228, 161, 105] as [number, number, number], tol: 8 },
        );
    await expect
        .poll(async () => {
            const p = await liftProbe();
            return p === null ? null : { center: p.center, lifted: p.run >= 5.0 };
        })
        .toEqual({ center: true, lifted: true });

    await page.mouse.move(cb.x + 30, cb.y + 30);
    await expect.poll(() => kexCall(page, "hoverForceId")).toBeNull();

    // ── 4c. the timeline glyph lifts the SAME outline: hovering a chart diamond's fat hit
    // circle lifts `.fmarker`'s stroke from ink #0e0d0c to var(--fg) = #f0ece8 (selection's own
    // stroke token, at the base 1px width — the rung below its 1.4px). Computed style off the
    // real hover, polled through the 100ms stroke ease; the pre-hover ink read is the positive
    // control (the probe can tell the two apart). all diamonds are deselected here, so the
    // hover isn't selection-suppressed. ──
    const chartMarker = page.locator(".fpt .fmarker").first();
    const markerStroke = () => chartMarker.evaluate((el) => getComputedStyle(el).stroke);
    expect(await markerStroke()).toBe("rgb(14, 13, 12)");
    await page.locator(".fhit").first().hover();
    await expect.poll(markerStroke).toBe("rgb(240, 236, 232)");
    await page.mouse.move(cb.x + 30, cb.y + 30); // park back off both surfaces' glyphs

    // ── 5. the viewport marquee stays NODE-only: a box dragged right across the markers
    // selects no keyframes (the locked decision — authoring atoms only, and on this surface
    // that's draggable geo nodes). positive control: the same box IS the deselect-all click
    // path when empty, proven by 4's deselect; here the set stays empty THROUGH the drag. ──
    const m0 = await markerAt(0);
    const m4 = await markerAt(4);
    await marqueeDrag(
        page,
        cb.x + Math.min(m0.x, m4.x) - 20,
        cb.y + Math.min(m0.y, m4.y) - 30,
        cb.x + Math.max(m0.x, m4.x) + 20,
        cb.y + Math.max(m0.y, m4.y) + 30,
    );
    expect((await selIds()).length).toBe(0);

    // ── 6. the shot: markers on the track, one selected (the brightened-kind read). ──
    await page.mouse.click(cb.x + m2.x, cb.y + m2.y);
    await expect.poll(async () => (await selIds()).length).toBe(1);
    await page.mouse.move(cb.x + 30, cb.y + 30); // park the pointer off the markers
    await page.waitForTimeout(SHOT_MS);
    await canvas.screenshot({ path: join(OUT, "viewport-force-markers.png") });
});

// summon a velocity strip via T1's creation gesture (right-click empty band → "Add velocity
// strip", `affordance.pw.ts createStrip`'s own idiom) at a station clear of the auto-authored
// launch strip (`seed()`'s own real, min-extent entry-speed strip at station 0 — untouched by
// `seedForceBump`'s convert, S2). Returns the new strip's stable id — the creation seeds two
// keyframes (start/end), the S4 multiselect flow's own fixture.
async function addStrip(page: Page): Promise<number> {
    const before = (await kexCall(page, "stripsOf", 0)) as { id: number }[];
    const bandBb = await page.locator(".hbandzone").boundingBox();
    const clipBb = await page.locator(".clip").first().boundingBox();
    if (!bandBb || !clipBb) throw new Error("header band / clip not laid out");
    const y = bandBb.y + bandBb.height / 2;
    const x = clipBb.x + clipBb.width * 0.6;
    await page.mouse.click(x, y, { button: "right" });
    await expect(page.locator(".smenu")).toHaveCount(1);
    await clickMenuItem(page, ".smenu", "Add velocity strip");
    await expect
        .poll(async () => (await kexCall(page, "stripsOf", 0)).length)
        .toBe(before.length + 1);
    const beforeIds = new Set(before.map((s) => s.id));
    const strips = (await kexCall(page, "stripsOf", 0)) as { id: number }[];
    const created = strips.find((s) => !beforeIds.has(s.id));
    if (!created) throw new Error("newly-created strip not found");
    return created.id;
}

// kex2d-event-lane S4: ONE SELECTION MODEL — the locked decision's own transition table over
// {segment, span, keyframe, empty-ruler, empty-lane} × {click, modifier-click}, driven by a REAL
// pointer for every row (Validation's own requirement). "keyframe" covers BOTH substrates S3
// unified (force + strip), since the locked decision generalizes the segment behavior across all
// three kinds identically. Segment/span/force-keyframe already carried shift-toggle before this
// stage (`selectSection`/`selectStrip`/`selectForce`); this flow's own new ground is the
// strip-keyframe multiset (booked to S4 at S3's close) and the empty-ruler/empty-lane deselect.
test("one selection model — the S4 transition table", async ({ page, boot }) => {
    await boot();

    const selectedSection = () => kexCall(page, "selectedSection");
    const sectionSelIds = () => kexCall(page, "sectionSelIds");
    const selectedStrip = () => kexCall(page, "selectedStrip");
    const stripSelIds = () => kexCall(page, "stripSelIds");
    const forceSelIds = () => kexCall(page, "forceSelIds");
    const stripKfSelIds = () => kexCall(page, "stripKfSelIds");
    const nothingSelected = async (): Promise<boolean> =>
        (await selectedSection()) === null &&
        (await selectedStrip()) === null &&
        (await forceSelIds()).length === 0 &&
        (await stripKfSelIds()).length === 0;

    await seedHill(page);
    await kexCall(page, "convert"); // → a force section, so the chart carries force keyframes
    await kexCall(page, "seedForceBump");
    await expect.poll(async () => (await kexCall(page, "forces")).length).toBe(5);
    await frameTimeline(page);

    const stripId = await addStrip(page);
    await frames(page, 2); // let the per-RAF tick propagate the new selection before reading it
    await expect.poll(selectedStrip).toBe(stripId); // T1's creation selects the new strip

    const chartCanvas = page.locator("canvas.chart");
    const canvasBb = await chartCanvas.boundingBox();
    const clipBb = await page.locator(".clip").first().boundingBox();
    const bandBb = await page.locator(".hbandzone").boundingBox();
    if (!canvasBb || !clipBb || !bandBb) throw new Error("timeline surfaces not laid out");
    const bandY = bandBb.y + bandBb.height / 2;

    // widen the strip via a REAL edge-drag (`section.pw.ts`'s own idiom) — created at
    // minimum extent, its two seeded keyframes' fat hit-circles (FHIT_R) overlap, so a click
    // aimed at one lands on whichever draws on top instead. widening clears the diamonds apart
    // before either is addressed by pixel position.
    const spBefore = (
        (await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[]
    ).find((s) => s.id === stripId);
    if (!spBefore) throw new Error("created strip has no band px");
    const edgePx = canvasBb.x + spBefore.x1;
    await page.mouse.move(edgePx, bandY);
    await page.mouse.down();
    await page.mouse.move(edgePx + 80, bandY, { steps: 5 });
    await page.mouse.up();
    await expect
        .poll(async () => {
            const sp = (
                (await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[]
            ).find((s) => s.id === stripId);
            return sp ? sp.x1 - sp.x0 : 0;
        })
        .toBeGreaterThan(60);

    const kfs = (await kexCall(page, "stripKeyframesOf", stripId)) as { id: number }[];
    expect(kfs.length).toBe(2); // the seeded start/end pair

    // ── SEGMENT row: click replace-selects the clip, sweeping the span currently selected;
    // shift-click TOGGLES it (the sole member, so it toggles OUT then back IN) — the grammar
    // every other kind below generalizes from (`selectSection`'s own shape). ──
    const clip = page.locator(".clip").first();
    await clip.click();
    await expect.poll(selectedStrip).toBeNull();
    await expect.poll(selectedSection).not.toBeNull();
    await page.keyboard.down("Shift");
    await clip.click();
    await page.keyboard.up("Shift");
    await expect.poll(async () => (await sectionSelIds()).length).toBe(0);
    await page.keyboard.down("Shift");
    await clip.click();
    await page.keyboard.up("Shift");
    await expect.poll(selectedSection).not.toBeNull();

    // ── SPAN row: click replace-selects the strip, sweeping the segment; shift-click toggles
    // it (S4's own generalization onto `bandDown` — `selectStrip`'s toggle form already existed,
    // wiring the shift check to it is this stage's). ──
    const stripPx = () =>
        kexCall(page, "stripPx") as Promise<{ id: number; x0: number; x1: number }[]>;
    const stripBody = async (): Promise<number> => {
        const sp = (await stripPx()).find((s) => s.id === stripId);
        if (!sp) throw new Error("created strip has no band px");
        return canvasBb.x + (sp.x0 + sp.x1) / 2;
    };
    let sx = await stripBody();
    await page.mouse.click(sx, bandY);
    await expect.poll(selectedSection).toBeNull();
    await expect.poll(selectedStrip).toBe(stripId);
    sx = await stripBody();
    await page.keyboard.down("Shift");
    await page.mouse.click(sx, bandY);
    await page.keyboard.up("Shift");
    await expect.poll(async () => (await stripSelIds()).length).toBe(0);
    sx = await stripBody();
    await page.keyboard.down("Shift");
    await page.mouse.click(sx, bandY);
    await page.keyboard.up("Shift");
    await expect.poll(selectedStrip).toBe(stripId);

    // ── KEYFRAME row (force substrate): click replace-selects it, sweeping the strip; a second
    // point shift-clicked toggles IN, then the first shift-clicked back OUT — the multiselect
    // grammar this stage's strip-keyframe twin (below) mirrors. ──
    const fhit = page.locator(".fhit").first();
    await fhit.click();
    await expect.poll(selectedStrip).toBeNull();
    await expect.poll(async () => (await forceSelIds()).length).toBe(1);
    const fhit2 = page.locator(".fhit").nth(1);
    await page.keyboard.down("Shift");
    await fhit2.click();
    await page.keyboard.up("Shift");
    await expect.poll(async () => (await forceSelIds()).length).toBe(2);
    await page.keyboard.down("Shift");
    await fhit.click();
    await page.keyboard.up("Shift");
    await expect.poll(async () => (await forceSelIds()).length).toBe(1);

    // ── KEYFRAME row (strip substrate, S4's booked multi-select): re-select the strip so its
    // diamonds are the click target, then run the SAME click / shift-click / shift-click grammar
    // over `editor.stripKfs` — the force keyframe arms above, mirrored one-for-one (S3's parity
    // law) rather than a second, hand-built scheme. The seeded start/end pair (`kf0` unused below)
    // sit close together — non-sticking (S3) means the edge-drag above widened the STRIP without
    // carrying either along, so their fat hit-circles still overlap each other. Two FRESH
    // keyframes, dropped by real double-click at well-separated stations across the now-widened
    // strip (`section.pw.ts`'s own separation idiom, taken further — two new points, not one, so
    // neither target's hit-circle can graze the seeded pair OR each other), give this row two
    // genuinely distinct, unambiguous click targets. ──
    sx = await stripBody();
    await page.mouse.click(sx, bandY);
    await expect.poll(selectedStrip).toBe(stripId);
    const dockBb = await page.locator(".dock .body").boundingBox();
    if (!dockBb) throw new Error("dock body not laid out");
    const chartMidY = dockBb.y + CHART_TOP + (dockBb.height - CHART_TOP - CHART_BOT_PAD) / 2;
    const spWide = (
        (await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[]
    ).find((s) => s.id === stripId);
    if (!spWide) throw new Error("widened strip has no band px");
    const dropKf = async (frac: number): Promise<number> => {
        const before = (await kexCall(page, "stripKeyframesOf", stripId)) as { id: number }[];
        const beforeIds = new Set(before.map((k) => k.id));
        const x = canvasBb.x + spWide.x0 + (spWide.x1 - spWide.x0) * frac;
        await page.mouse.dblclick(x, chartMidY);
        await expect
            .poll(async () => (await kexCall(page, "stripKeyframesOf", stripId)).length)
            .toBe(before.length + 1);
        const after = (await kexCall(page, "stripKeyframesOf", stripId)) as { id: number }[];
        const created = after.find((k) => !beforeIds.has(k.id));
        if (!created) throw new Error("the double-click's new strip keyframe not found");
        return created.id;
    };
    const kfA = await dropKf(0.25);
    const kfB = await dropKf(0.75);

    const stripKfAt = async (id: number): Promise<{ x: number; y: number }> => {
        const pts = (await kexCall(page, "stripKfPx")) as { id: number; x: number; y: number }[];
        const p = pts.find((k) => k.id === id);
        if (!p) throw new Error(`strip keyframe ${id} not laid out`);
        return p;
    };
    let pA = await stripKfAt(kfA);
    await page.mouse.click(pA.x, pA.y);
    await expect.poll(async () => (await forceSelIds()).length).toBe(0); // the strip sweep clears it
    await expect.poll(stripKfSelIds).toEqual([kfA]);
    const pB = await stripKfAt(kfB);
    await page.keyboard.down("Shift");
    await page.mouse.click(pB.x, pB.y);
    await page.keyboard.up("Shift");
    await expect.poll(async () => (await stripKfSelIds()).length).toBe(2);
    pA = await stripKfAt(kfA);
    await page.keyboard.down("Shift");
    await page.mouse.click(pA.x, pA.y);
    await page.keyboard.up("Shift");
    await expect.poll(stripKfSelIds).toEqual([kfB]);

    // ── EMPTY-RULER row: a plain click deselects EVERYTHING (the ruler holds no selectable
    // objects, so every press is an empty-space click); shift-click preserves. ──
    const rulerZone = page.locator(".rulerzone");
    const rulerBb = await rulerZone.boundingBox();
    if (!rulerBb) throw new Error("ruler zone not laid out");
    const rulerPt = { x: rulerBb.x + rulerBb.width * 0.4, y: rulerBb.y + rulerBb.height / 2 };
    expect(
        await nothingSelected(),
        "a strip keyframe is still selected before the ruler click",
    ).toBe(false);
    await page.mouse.click(rulerPt.x, rulerPt.y);
    await expect.poll(nothingSelected).toBe(true);
    await clip.click(); // re-arm a selection to prove the modifier preserves it
    await expect.poll(selectedSection).not.toBeNull();
    await page.keyboard.down("Shift");
    await page.mouse.click(rulerPt.x, rulerPt.y);
    await page.keyboard.up("Shift");
    await expect.poll(selectedSection).not.toBeNull();

    // ── EMPTY-LANE row: the band's own empty-space click (S4's own new ground — `bandDown` was
    // previously inert here, no selection change at all) deselects everything the same way;
    // shift-click preserves. Read clear of EVERY strip's real px from `stripPx` rather than a
    // fixed fraction (kex2d-event-lane S5, findings 4/5/6: a summoned strip now grows to a
    // brake-section-typical span, not the bare min-extent this flow's own strip used to sit at,
    // so a hand-picked fraction can land back inside a strip whose width just changed). ──
    const findEmptyBandX = async (): Promise<number> => {
        const strips = await stripPx();
        for (let frac = 0.98; frac >= 0.02; frac -= 0.02) {
            const pageX = clipBb.x + clipBb.width * frac;
            const local = pageX - canvasBb.x; // stripPx's x0/x1 are canvas-local, not clip-local
            if (!strips.some((s) => local >= s.x0 - 4 && local <= s.x1 + 4)) {
                return pageX;
            }
        }
        throw new Error("no band x clear of every strip");
    };
    const emptyBandX = await findEmptyBandX();
    await expect.poll(selectedSection).not.toBeNull(); // still armed from the ruler's own re-select
    await page.mouse.click(emptyBandX, bandY);
    await expect.poll(nothingSelected).toBe(true);
    await clip.click();
    await expect.poll(selectedSection).not.toBeNull();
    await page.keyboard.down("Shift");
    await page.mouse.click(emptyBandX, bandY);
    await page.keyboard.up("Shift");
    await expect.poll(selectedSection).not.toBeNull();

    await page.waitForTimeout(SHOT_MS);
    const strip = dockStrip(page);
    if (strip)
        await page.screenshot({ path: join(OUT, "select-transition-table.png"), clip: strip });
});
