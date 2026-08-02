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
        .toEqual(["Easing ▸", "Delete Del"]);
    // the rendered rows are the real `keyframeMenu` builder's, run in the page against this
    // keyframe's live state — the keyframe menu's half of the DOM cross-check. It reaches INSIDE
    // `Easing ▸` by real hover, which is where the app's ONE authored within-group separator lives
    // (the preset picks divided from Custom): the whole escape hatch rests on that row, and this is
    // the only place it's verified as rendered DOM.
    await menuGrammar(page, ".fmenu", {
        builder: "keyframeMenu",
        // the leading keyframe of a bumped force section: single selection, non-terminal (it
        // governs the following segment), no explicit handles, no pin session (so no
        // Lock/Unlock row), nothing under lockdown.
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
    // bump shoulder, s = 0.2·length) — a chart point, not a diamond — → the same LEADING
    // keyframe's menu (the Blender convention: a segment addresses the keyframe before it).
    // Setting Quintic through it is a value change, so it proves the addressing. `openForceMenu`
    // also SELECTS its target (keyframe 0, from step 1), so its `.ptip` popover is still floating
    // over the chart near it — Escape deselects and closes the popover first, or it eats the click. ──
    await page.keyboard.press("Escape");
    await expect(page.locator(".ptip")).toHaveCount(0);
    const fcb = await page.locator(".clip").first().boundingBox();
    const kf0 = await page.locator(".fpt").nth(0).boundingBox(); // s=0 seed (~1g)
    const kf1 = await page.locator(".fpt").nth(1).boundingBox(); // first bump shoulder (1g)
    if (!fcb || !kf0 || !kf1) throw new Error("force clip / keyframes not laid out");
    // the segment hit-target is gated to the drawn curve (chartCtx's FHIT_R vertical tolerance),
    // so the click must land ON the span. x ≈ 0.1·length sits halfway between kf0 (s=0) and
    // kf1 (s=0.2·length); the near-flat ~1g span there tracks the two flanking diamonds, so the
    // mean of their centre-y lands on the curve.
    const midX = fcb.x + fcb.width * 0.1;
    const midY = (kf0.y + kf0.height / 2 + (kf1.y + kf1.height / 2)) / 2;
    await page.mouse.click(midX, midY, { button: "right" });
    await expect(page.locator(".fmenu")).toBeVisible();
    await clickFlyout(page, ".fmenu", "Easing", "Quintic");
    await expect(page.locator(".fmenu")).toHaveCount(0);
    await expect.poll(async () => (await forceEases())[0]).toBe(2); // Easing.Quintic — keyframe 0 moved, not keyframe 1
    expect((await forceEases())[1]).toBe(1); // keyframe 1's own tag (Cubic, untouched) proves it

    // ── 2c. A right-click in EMPTY chart space (over the force section horizontally but ~1g
    // from the curve vertically) opens NO keyframe menu — the segment hit-target is the drawn
    // curve, not the whole force-section column. ──
    const crest = await page.locator(".fpt").nth(2).boundingBox(); // airtime crest (0g)
    if (!crest) throw new Error("crest keyframe not laid out");
    await page.mouse.click(midX, crest.y + crest.height / 2, { button: "right" });
    // a menu that IS going to open renders on the next tick, so one projected frame is the
    // condition that makes this absence assert mean something (a bare `toHaveCount(0)` passes
    // instantly against a menu that simply hasn't rendered yet).
    await frames(page);
    await expect(page.locator(".fmenu")).toHaveCount(0);
    expect((await forceEases())[0]).toBe(2); // unchanged — the empty-space click was inert

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
    // Easing ▸ entry entirely — its menu is Delete alone (there is no transition to ease). ──
    await page.locator(".fpt").last().click({ button: "right" });
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
        .toEqual(["Easing ▸", "Tangents ▸", "Delete Del"]);
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
        .toEqual(["Easing ▸", "Delete Del"]); // no Tangents ▸ on a derived keyframe
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

    // ── 3. MULTI-DRAG, RIGID CLAMP: grab the CREST (a member, but NOT the active one — a plain
    // click on a set member drags the whole block without collapsing it) and drag it FAR right —
    // past the tightest member's own room. the shared Δs clamps to that member's own [0, len]: the
    // s=0.8·len shoulder has the least room (0.2·len), so it lands EXACTLY at the section's extent
    // while every member's OFFSET from the others is preserved (the AE comp-start block); the two
    // unselected seeds never move. ──
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
    // the clamp binds EXACTLY at the tightest member's own room: its pre-drag distance to the
    // extent equals the shared delta (the definition of "the tightest member bounds the group").
    // asserted algebraically, not by re-reading a POST-drag index — the clamped member now sits at
    // s = len, tied with the untouched trailing seed (also at len), so `after`'s sort order between
    // that pair is no longer determined by identity (a stable sort ties on the ORIGINAL entity
    // order, not which one is "the seed") — exactly the spec's accepted "no auto-merge, coincident
    // points keep current engine behavior".
    expect(before[3].s + ds).toBeCloseTo(len, 3);
    const atLen = after.filter((p) => Math.abs(p.s - len) < 1e-3);
    expect(atLen.length).toBe(2); // the seed AND the clamped member now coincide — no auto-merge
    expect(atLen.some((p) => Math.abs(p.g - before[4].g) < 1e-6)).toBe(true); // the seed's g survived
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
    await expect(fhit).toHaveCount(5);
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
    // profile changes, the bake re-times (tTotal shifts). three points now exist (the two
    // seeds + the authored one); grab the AUTHORED one — the middle by s (and so by x), sorted
    // between the entry seed (s=0) and the exit seed (s=length). ──
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

// The TRACK DOMAIN picker (kex2d-time-domain stage 5): every force keyframe's position and every
// force section's extent are stored in the unit of `Track.domain`, and the ruler's own context menu
// (Meters / Seconds — the Premiere/REAPER/Cubase reference) is where it's picked. No keyboard
// shortcut (the second feel check-in's call). The pick is a DOCUMENT CONVERSION, not a view change,
// and that is what this flow pins in the only place it can be pinned honestly (a real browser, real
// gestures, the live bake's arc↔time table under them):
//
//   · the checked row follows `Track.domain`, and picking it is a no-op — no entry, no write;
//   · picking the other row converts the whole store in ONE undo entry: the keyframes' stored
//     numbers become seconds and every diamond moves (the positive control for what follows);
//   · TIME-CONSTRAINED editing, the whole point of the domain: in Seconds, editing one keyframe
//     leaves every other keyframe's stored t AND its drawn x exactly where they were — the store
//     is the time reading, so no edit anywhere can slide it (the inverse of the rejected
//     projection-only "honest slide", which slid every keyframe on any upstream re-timing);
//   · undo is the way back, byte-identically — for the edit and for the conversion itself. A
//     Meters → Seconds → Meters round trip is NOT bit-identical (the two marches disagree; see
//     `domain.ts`), so it is deliberately not asserted here; the unit suite bounds the drift.
//   · a gesture returned to its grab pixel is a byte-identical no-op that records no undo entry —
//     the carried lesson, and now exact by construction: the store and the axis are one unit, so
//     the drag is plain arithmetic with no projection to lose an ulp in. Pinned IN SECONDS, the
//     domain whose exactness is new;
//   · undo is refused mid-gesture and the document axis holds still: a live drag owns the open
//     history gesture, and a domain entry popped underneath it would flip the store's unit under a
//     grab resolved in the other one (`editor-ui.md`: no document-axis navigation while a gesture
//     is live);
//   · the converting row GRAYS where the conversion can't run — reached honestly by running a force
//     section off the end of the flat SoA, the one persistent such state.
test("timeline domain flow", async ({ page, boot }) => {
    await boot();

    const forces = () => kexCall(page, "forces");
    const forceU = () => kexCall(page, "forceU");
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

    // Author the entry speed off the default FIRST, because at exactly `V0` the two units are
    // proportional by one constant and this flow could not tell them apart: the time quantum and
    // the time lead-out floor are both derived at `V0` (`T_GRID`, `marginFloor`), so a ride
    // cruising at `V0` puts every diamond at the identical fraction of the span. 25 m/s makes the
    // conversion visibly its own thing.
    const tSeed = await tTotal();
    await kexCall(page, "setV0", 25);
    await expect.poll(tTotal).not.toBe(tSeed);
    await frameTimeline(page); // the whole section on-screen, for exact diamond boxes

    const posField = (label: string) => page.locator(`.ptip input[aria-label="${label}"]`);
    const fhit = page.locator(".fhit");
    const centers = async (): Promise<number[]> => {
        const out: number[] = [];
        for (let i = 0; i < 5; i++) {
            const b = await fhit.nth(i).boundingBox();
            if (!b) throw new Error(`force point ${i} not laid out`);
            out.push(b.x + b.width / 2);
        }
        return out;
    };

    // ── 1. Distance is the default: Meters reads checked, Seconds not. A live bake exists here
    // (the seeded points baked above), so Seconds is ENABLED — the gray case is a track the
    // conversion can't run on (no live bake, a section off the bake), unit-covered in
    // `domain.test.ts` against the same `convertible` reading this row grays on. Picking the
    // already-checked row is a no-op: nothing written, nothing recorded. ──
    expect(await domain()).toBe("distance");
    const xDist = await centers();
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

    // ── 2. The Seconds row, pointer-true (`clickMenuItem` — real hover isn't needed for a
    // top-level row, but the coordinate click + elementFromPoint reachability assert is the same
    // regression net every menu flow wears). It CONVERTS: one undo entry, and the store now holds
    // seconds — smaller numbers than the metres it held at 25 m/s. ──
    await openRulerMenu();
    await clickMenuItem(page, ".rmenu", "Seconds");
    await expect.poll(domain).toBe("time");
    // the pick's re-frame lands on the frame the tick re-derives the domain in (writing the new
    // scale from the handler would paint one frame of old coordinates against it), so the chart's
    // boxes are honest only after a projected frame.
    await frames(page, 2);
    const seconds = await forces();
    expect(await undoDepth()).toBe(undo0 + 1); // ONE entry for the whole conversion
    // the checked row FOLLOWS the store's unit: reopen and assert it flipped (a hardcoded
    // `checked` would sail through the pre-flip assert above).
    await openRulerMenu();
    await expect(secondsRow).toHaveClass(/checked/);
    await expect(metersRow).not.toHaveClass(/checked/);
    await page.keyboard.press("Escape");
    await expect(page.locator(".rmenu")).toHaveCount(0);
    for (let i = 1; i < 5; i++) expect(seconds[i].s).toBeLessThan(metres[i].s);
    for (let i = 0; i < 5; i++) expect(seconds[i].g).toBe(metres[i].g); // g is unit-free
    // the conversion really moved the chart — the positive control the "nothing else moved"
    // asserts below need, or they would pass vacuously against a chart that never changed.
    // (measured ~100px at this speed; the bar is only that it dwarfs a one-box rounding.)
    const xTime = await centers();
    expect(Math.max(...xTime.map((x, i) => Math.abs(x - xDist[i])))).toBeGreaterThan(20);

    // the selected keyframe's popover reads the store's own unit: `t` seconds, not `d` metres, and
    // the value it prints is the lens's affine for that keyframe (`forceU`).
    const crest = 2; // the airtime crest, s = 0.5·len — the interior keyframe this flow drives
    const c2 = await fhit.nth(crest).boundingBox();
    if (!c2) throw new Error("the crest diamond is not laid out");
    await page.mouse.click(c2.x + c2.width / 2, c2.y + c2.height / 2);
    await expect(posField("Point time (s)")).toHaveCount(1);
    await expect(posField("Point distance (m)")).toHaveCount(0);
    await expect(page.locator(".ptip .fld").first().locator(".key")).toHaveText("t");
    await expect(page.locator(".ptip .fld").first().locator(".unit")).toHaveText("s");
    const shownT = Number(await posField("Point time (s)").inputValue());
    const uCrest = (await forceU())[crest].u;
    expect(shownT).toBeCloseTo(uCrest, 1); // the field prints the keyframe's own global t
    expect(uCrest).toBeCloseTo(seconds[crest].s, 6); // one section from the start: u = 0 + t
    await page.waitForTimeout(SHOT_MS);
    const strip = dockStrip(page);
    if (strip) await page.screenshot({ path: join(OUT, "domain-time.png"), clip: strip });

    // ── 3. TIME-CONSTRAINED editing. Drag the crest right: its own t moves (by more than one time
    // quantum, so this is a real placement on the `T_GRID` vocabulary and not a metre grid), and
    // every OTHER keyframe holds — stored t byte-identical AND drawn x within half a device pixel.
    // Under the projection-only basis this same edit re-timed the whole ride and slid all four of
    // them; here the store IS the time reading, so nothing can slide it. The section's duration is
    // authored, so the geometry underneath changes while the clock does not. ──
    await page.keyboard.press("Escape"); // drop the popover: it floats over the neighbour diamonds
    await expect(page.locator(".ptip")).toHaveCount(0);
    const grab = await fhit.nth(crest).boundingBox();
    if (!grab) throw new Error("the crest diamond is not laid out for the drag");
    const gx = grab.x + grab.width / 2;
    const gy = grab.y + grab.height / 2;
    await page.mouse.move(gx, gy);
    await page.mouse.down();
    await page.mouse.move(gx + 18, gy, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await forces())[crest].s).toBeGreaterThan(seconds[crest].s);
    const edited = await forces();
    const moved = edited[crest].s - seconds[crest].s;
    expect(moved).toBeGreaterThan(0.1); // ≥ one time quantum (`T_GRID` = 0.1 s)
    await frames(page, 2);
    const xEdited = await centers();
    for (let i = 0; i < 5; i++) {
        if (i === crest) continue;
        expect(edited[i].s).toBe(seconds[i].s); // the stored time of every other keyframe
        expect(edited[i].g).toBe(seconds[i].g);
        expect(xEdited[i]).toBeCloseTo(xTime[i], 0); // …and where it draws
    }

    // ── 4. A gesture returned to its grab pixel is a byte-identical no-op with NO undo entry (the
    // carried lesson) — asserted HERE, in Seconds, because that is the domain whose exactness is
    // new: the drag resolves delta-from-grab in the store's own unit and the gesture-start magnet
    // resolves to the grabbed value rather than a pixel round-trip, so zero delta writes zero
    // bit-exactly on both axes with no projection in the path. The mid-gesture displacement is the
    // positive control: it proves this rig can see a write at all. It addresses the FIRST SHOULDER,
    // not the crest 3 drove: a second press on the same diamond inside `FDBL_MS` is the handle-edit
    // summon, not a drag, so re-grabbing the crest here would race the flow's own round-trip time
    // to decide whether a drag opens at all. No re-framing — the view must stay where 3 left it, so
    // 5's post-undo pixel comparison against `xDist` stays meaningful. ──
    const shoulder = 1; // s = 0.2·len
    await page.keyboard.press("Escape"); // the crest's popover floats over its neighbour
    await expect(page.locator(".ptip")).toHaveCount(0);
    const undoGrab = await undoDepth();
    const back = await fhit.nth(shoulder).boundingBox();
    if (!back) throw new Error("the shoulder diamond is not laid out for the zero-delta grab");
    const bx = back.x + back.width / 2;
    const by = back.y + back.height / 2;
    await page.mouse.move(bx, by);
    await page.mouse.down();
    await expect(page.locator("#app[data-dragging]")).toHaveCount(1); // the grab really opened
    await page.mouse.move(bx + 40, by - 30, { steps: 6 }); // really move it (both axes)
    await expect.poll(async () => (await forces())[shoulder].s).not.toBe(edited[shoulder].s);
    await page.mouse.move(bx, by, { steps: 6 }); // …and return to the exact grab pixel
    await page.mouse.up();
    expect(await forces()).toEqual(edited); // byte-identical, both axes
    expect(await undoDepth()).toBe(undoGrab); // and nothing on the undo stack

    // ── 5. Undo is REFUSED mid-gesture, and the document axis holds still under it. A live drag
    // owns the open history gesture (one at a time), so popping an entry underneath it would leave
    // the drag's own commit landing on top of an unrelated state — and a `Track.domain` entry would
    // flip the store's unit under a grab resolved in the other one, rescaling the axis mid-gesture
    // (`editor-ui.md`: no document-axis navigation while a gesture is live). The press is a no-op:
    // the domain holds, the view holds, and the gesture then commits normally on release. ──
    // the SECOND shoulder, not the one 4 just grabbed: a second press on the same diamond inside
    // `FDBL_MS` is the handle-edit summon, not a drag (4's own note), and a summon opens no gesture
    // at all — which is exactly how this pin first went red.
    const other = 3; // s = 0.8·len
    const far = await fhit.nth(other).boundingBox();
    if (!far) throw new Error("the second shoulder is not laid out for the mid-drag undo");
    const fx = far.x + far.width / 2;
    const fy = far.y + far.height / 2;
    const viewMid = await kexCall(page, "xView");
    await page.mouse.move(fx, fy);
    await page.mouse.down();
    await page.mouse.move(fx + 40, fy, { steps: 6 }); // past DRAG_PX — a live gesture
    await expect(page.locator("#app[data-dragging]")).toHaveCount(1);
    await page.keyboard.press("Control+z");
    await frames(page, 2); // give a re-frame a chance to land, if the guard were missing
    expect(await domain()).toBe("time"); // the conversion entry was NOT popped
    expect(await kexCall(page, "xView")).toEqual(viewMid); // …and the axis never rescaled
    await page.mouse.move(fx, fy, { steps: 6 }); // back to the grab pixel: still a no-op gesture
    await page.mouse.up();
    expect(await forces()).toEqual(edited);
    expect(await undoDepth()).toBe(undoGrab);

    // ── 6. Undo is the way back, byte-identically — first over the edit, then over the conversion
    // itself, which restores the metre store AND the domain in one entry. (A Meters → Seconds →
    // Meters round trip is deliberately NOT asserted: it is not bit-identical, by the locked
    // decision, and how close it lands is a property of the ride.) ──
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await forces())[crest].s).toBe(seconds[crest].s);
    expect(await forces()).toEqual(seconds); // the whole store, byte-identical
    expect(await domain()).toBe("time");
    await page.keyboard.press("Control+z");
    await expect.poll(domain).toBe("distance");
    expect(await forces()).toEqual(metres); // …and the metres came back exactly
    expect(await undoDepth()).toBe(undo0);
    await frames(page, 2);
    const xBack = await centers();
    for (let i = 0; i < 5; i++) expect(xBack[i]).toBeCloseTo(xDist[i], 0);
    await expect(posField("Point distance (m)")).toHaveCount(0); // nothing selected after the undos

    // ── 7. The CONVERTING row grays where the conversion can't run (`editor-ui.md`: gray a row
    // whose preconditions fail — never hide it, and never leave it clickable into a silent no-op).
    // Reached honestly: stretch this force section past the whole-track sample budget, then append a
    // second one — the appended section starts beyond the end of the flat SoA, so its arc↔time
    // window addresses samples that were never written. That is the one PERSISTENT state
    // `domain.convertible` reads false on (a stale bake is repaired on the next frame), and the
    // conversion must reject the WHOLE track rather than convert the section it CAN see. The enabled
    // assert in 1 is this one's positive control: the same row, the same locator. ──
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
