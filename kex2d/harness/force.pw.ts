// kex2d's FORCE-authoring capture flows (the timeline chart, its keyframes, handles, easing menu,
// and the snap tool rail). Shared helpers + the `__kex` typed hook live in `./flow`.

import {
    test,
    expect,
    join,
    OUT,
    SHOT_MS,
    kexCall,
    forcePointAt,
    seedHill,
    frameTimeline,
    clickFlyout,
    clickMenuItem,
    menuGrammar,
    marqueeDrag,
    dockStrip,
    CHART_TOP,
    CHART_BOT_PAD,
    SNAP_DEG,
    SNAP_LEN,
    SNAP_DEG_MIN,
    SNAP_DEG_MAX,
    SAMPLE_BUDGET_M,
    frames,
    type Kex,
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
        { id: 0, s: 0, g: 1 }, // (0, F_entry) — F_entry = DEFAULT_G, the track-start fallback
        { id: 1, s: 24, g: 1 }, // (length, F_entry) — length = DEFAULT_FORCE_LEN (EXTEND_DIST)
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

    // ── 2b. Force insertion is intentionally inert in this interim editor. Prepare the
    // point needed by the surviving scrub/value-drag heirs through the headless force command;
    // segment-authoring will provide the boundary-aware placement gesture.
    const createdId = await kexCall(page, "placeForce", 8, 1);
    const created = (await forces()).find((point) => point.id === createdId);
    if (!created) throw new Error("headless force point was not created");
    await expect(page.locator(".fhit")).toHaveCount(6);
    const forceClip = await page.locator(".clip").first().boundingBox();
    const [, forcePxPerU] = await kexCall(page, "xView");
    if (!forceClip) throw new Error("force clip not laid out after headless create");
    const createdHit = await page.locator(".fhit").evaluateAll(
        (els, x) => {
            const points = els.map((el) => {
                const r = el.getBoundingClientRect();
                return { el, x: r.x + r.width / 2 };
            });
            return points
                .map((point, index) => ({ index, distance: Math.abs(point.x - x) }))
                .sort((a, b) => a.distance - b.distance)[0]?.index;
        },
        forceClip.x + created.s * forcePxPerU,
    );
    if (createdHit === undefined) throw new Error("headless force point has no hit target");
    await page.locator(".fhit").nth(createdHit).click();

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
    // pointer-true keyframe menu, then undo it. exercises the __kex ease hook stage C landed
    // against a keyframe that only exists because of stage B's seeding. Explicit per-keyframe
    // force handles (the Tangents ▸ submenu, the handle-drag gesture this step used to also
    // exercise) left with `kex2d-segment-removal` S3. ──
    await frameTimeline(page); // bring the whole section into view for the diamond DOM boxes
    expect((await forceEases())[0]).toBe(1); // Easing.Cubic — the fresh-seed default
    await page.locator(".fpt").first().click({ button: "right" }); // the leading seed (s=0)
    await expect(page.locator(".fmenu")).toBeVisible();
    await clickFlyout(page, ".fmenu", "Easing", "Quintic");
    await expect(page.locator(".fmenu")).toHaveCount(0);
    await expect.poll(async () => (await forceEases())[0]).toBe(2); // Easing.Quintic

    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await forceEases())[0]).toBe(1); // back to Cubic

    // ── 3. Convert back to geo via the __kex hook (setup, per step 1) → destructive reset to
    // the flat two-node seed. ──
    await kexCall(page, "convert");
    await expect.poll(kind).toBe(0);
    await expect.poll(nodeCount).toBe(2); // the flat seed
    expect(await forceCount()).toBe(0);
    await page.screenshot({ path: join(OUT, "force-3-geo.png") });

    // ── 4. Undo the convert → the force track + its points restored byte-identical (the
    // two seeds + the three bump points — the easing edit above was already undone, so this
    // is exactly the pre-convert-to-geo state). ──
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

    const forces = () => kexCall(page, "forces") as Promise<{ id: number; s: number; g: number }[]>;
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

// Force position-axis drag, including the old out-of-window F2 arm, was retired in S4.
// Force value dragging remains covered by the S4 shared-path control below.

// Drive the FORCE EASING MENU flow (kex2d-force-ux stage C, extended at stage E): seed a force
// section with keyframes → RIGHT-CLICK a diamond for the keyframe menu (Easing ▸ · Delete) →
// open the Easing ▸ submenu and set Linear POINTER-TRUE (clickFlyout — the regression net for
// the context-submenu clip class) → assert the leading keyframe's tag flipped → RIGHT-CLICK the
// CURVE SPAN between two keyframes (not a diamond), and a right-click in empty chart space, both
// open NO menu and change nothing (the retired leading-keyframe curve-span convention,
// `editor-ui.md` Keyframe/curve-editor conventions) → the TERMINAL keyframe's menu drops
// Easing ▸ entirely (Delete alone) → Delete, pointer-true (`clickMenuItem`), removes an interior
// keyframe. Every menu interaction is a real pointer event; __kex is read only for assertions.
// The double-click handle-edit summon, the handle drag, and the Custom/Reset rows this flow
// used to also exercise left with the explicit per-keyframe force handles they edited,
// `kex2d-segment-removal` S3 — every segment is now named.
test("force easing menu flow", async ({ page, boot }) => {
    await boot();

    const forceCount = () => kexCall(page, "forceCount");
    const forceEases = () => kexCall(page, "forceEases");

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
    // terminal (kex2d-menu-grammar stage 2). (The Handles + Reset rows, and the Custom preset
    // Easing ▸ used to also carry, are gone — the submenu is Linear | Cubic | Quintic only.) ──
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
    // `Easing ▸` by real hover to assert the preset rows (Linear | Cubic | Quintic) render — the
    // app authors no separator anywhere now (`tests/menu.test.ts`'s `Separators` registry is
    // empty; the one row it used to carry divided the presets from Custom, and left with it).
    await menuGrammar(page, ".fmenu", {
        builder: "keyframeMenu",
        // the leading keyframe of a bumped force section: single selection, non-terminal (it
        // governs the following segment), no pin session (so no Lock/Unlock row), nothing
        // under lockdown.
        state: {
            setOk: true,
            lock: null,
            multi: false,
            terminal: false,
            easeTargets: 1,
        },
        enums: { ease: "profile.Easing.Cubic" },
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

// S4 shared-path control: force diamonds retain value dragging while their position axis is
// inert. The off-center grab proves the value is press-relative; a vertical move proves the
// surviving force-value gesture still writes through the shared path.
test("force keyframe position drag is inert while value drag survives (S4)", async ({
    page,
    boot,
}) => {
    await boot();
    await seedHill(page);
    await kexCall(page, "seedForceBump");
    await expect.poll(async () => await kexCall(page, "forceCount")).toBe(5);
    await frameTimeline(page);

    const rows = (await kexCall(page, "forceU")) as {
        id: number;
        section: number;
        s: number;
        g: number;
        u: number;
    }[];
    const beforeRow = rows.find((row) => row.s === 12);
    if (!beforeRow) throw new Error("force keyframe at the stable setup station is missing");
    const forceId = beforeRow.id;
    const read = () =>
        page.evaluate(
            ({ forceId }) => {
                const k = (window as unknown as { __kex: Kex }).__kex;
                const row = k.forceU().find((candidate) => candidate.id === forceId);
                return { row, range: k.gRange() };
            },
            { forceId },
        );
    const before = await read();
    const [, pxPerU] = await kexCall(page, "xView");
    const clip = await page.locator(".clip").first().boundingBox();
    if (!before.row || !clip) throw new Error("force keyframe is not laid out");
    const expectedX = clip.x + beforeRow.s * pxPerU;
    const hitBoxes = await page.locator(".fhit").evaluateAll((els) =>
        els.map((el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }),
    );
    const hit = hitBoxes
        .map((point) => ({ point, distance: Math.abs(point.x - expectedX) }))
        .sort((a, b) => a.distance - b.distance)[0]?.point;
    if (!hit) throw new Error("force keyframe hit target is not laid out");
    const pressX = hit.x;
    const pressY = hit.y + 10;
    const range = before.range;
    const g0 = before.row.g;
    await page.keyboard.down("Control");
    await page.mouse.move(pressX, pressY);
    await page.mouse.down();
    const samples: Awaited<ReturnType<typeof read>>[] = [];
    for (let i = 1; i <= 5; i++) {
        await page.mouse.move(pressX + i * 4, pressY);
        samples.push(await read());
    }
    await page.mouse.up();
    await page.keyboard.up("Control");
    for (const sample of samples) {
        if (!sample.row) throw new Error("force sample lost keyframe");
        expect(sample.row.g).toBe(g0);
        expect(sample.range).toEqual(range);
    }
    expect(samples.at(-1)?.row?.s).toBe(beforeRow.s);

    // The surviving force-value arm: vertical movement changes g while station remains fixed.
    const valueHit = hitBoxes
        .map((point) => ({ point, distance: Math.abs(point.x - expectedX) }))
        .sort((a, b) => a.distance - b.distance)[0]?.point;
    if (!valueHit) throw new Error("force keyframe value target is not laid out");
    await page.mouse.move(valueHit.x, valueHit.y);
    await page.mouse.down();
    await page.mouse.move(valueHit.x, valueHit.y + 30, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.up("Control");
    const afterValue = await read();
    if (!afterValue.row) throw new Error("force keyframe lost after value drag");
    expect(afterValue.row.s).toBe(beforeRow.s);
    expect(afterValue.row.g).not.toBe(g0);
});

// "force tangent mode + linear ghost flow" (the Tangents ▸ mode submenu, the chord-aligned
// derived-Linear ghost) and "handle drag edge-pans the value axis and a released handle stays
// in range" left with `kex2d-segment-removal` S3 -- explicit per-keyframe force handles, the
// summon that rendered them, and the mode/ghost/edge-pan/release-accommodate behavior driven
// only through a handle drag. The shared `growValueAxis`/`yGrow` edge-pan-and-cap mechanism
// the second test also exercised stays covered: its pure math in
// `tests/timeline.test.ts` ("yGrow -- edge-triggered grow-to-follow"), and the SURVIVING
// force-keyframe-value-drag path (Keep the force glyph and force value drag, this spec's
// Locked decision) end-to-end in `harness/section.pw.ts`'s "channel-specific keyframe edge
// growth".

// Force multi-member station dragging was retired with the force position axis in S4.
// Cross-kind selection remains covered by section.pw.ts; force value dragging remains covered
// by the S4 shared-path control above.

// Retained timeline heirs for the retired multiselect flow. The flow deliberately uses a real
// marquee and real pointer gestures: live wheel/F suppression, bulk easing, blur teardown of a
// strip station drag and of a label scrub, and multi-key popover suppression are all still
// user-visible shared-path behavior. Force station dragging is not exercised because S4 removed
// that axis; the strip station drag is its genuine surviving timeline counterpart.
test("retained timeline gesture heirs after force position removal", async ({ page, boot }) => {
    await boot();
    await kexCall(page, "seedForceBump");
    await frameTimeline(page);

    const forceEases = () => kexCall(page, "forceEases") as Promise<number[]>;
    const forceSelIds = () => kexCall(page, "forceSelIds") as Promise<number[]>;
    const xView = () => kexCall(page, "xView") as Promise<[number, number]>;
    const body = await page.locator(".dock .body").boundingBox();
    if (!body) throw new Error("timeline body not laid out");
    const hits = page.locator('.fhit[aria-label="Force point"]');
    await expect(hits).toHaveCount(5);
    const boxes = await hits.evaluateAll((els) =>
        els.map((el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }),
    );
    const xLo = (boxes[0].x + boxes[1].x) / 2;
    const xHi = (boxes[3].x + boxes[4].x) / 2;
    const top = body.y + CHART_TOP + 4;
    const bottom = body.y + body.height - CHART_BOT_PAD - 4;
    await marqueeDrag(page, xLo, top, xHi, bottom);
    await expect.poll(async () => (await forceSelIds()).length).toBe(3);
    await expect(page.locator(".ptip")).toHaveCount(0); // multiForce popover suppression

    // Bulk easing is retained even though station dragging is not: all selected non-terminal
    // force keys change, while the two unselected continuation seeds remain Cubic (1).
    await page.locator(".fpt").nth(2).click({ button: "right" });
    await expect(page.locator(".fmenu")).toBeVisible();
    await clickFlyout(page, ".fmenu", "Easing", "Quintic");
    const eased = await forceEases();
    expect(eased.slice(1, 4)).toEqual([2, 2, 2]);
    expect(eased[0]).toBe(1);
    expect(eased[4]).toBe(1);

    // Wheel and F are swallowed while a real chart marquee is live, then work at rest.
    await frameTimeline(page);
    const rest = await xView();
    await page.mouse.move(xLo, top);
    await page.mouse.down();
    await page.mouse.move(xHi, bottom, { steps: 6 });
    await expect(page.locator("#app[data-dragging]")).toHaveCount(1);
    await page.mouse.wheel(0, -600);
    await page.keyboard.press("f");
    await frames(page, 2);
    expect(await xView()).toEqual(rest);
    await page.mouse.up();
    await expect(page.locator("#app[data-dragging]")).toHaveCount(0);
    await page.mouse.wheel(0, -600);
    await expect.poll(async () => (await xView())[1]).toBeGreaterThan(rest[1]);

    // Blur tears down the surviving strip station drag before pointerup can commit it.
    const stripId = (await kexCall(page, "addStripAt", 0, 40, 5)) as number;
    await kexCall(page, "placeStripKf", stripId, 12, 10);
    await frameTimeline(page);
    const stripKfs = () =>
        kexCall(page, "stripKeyframesOf", stripId) as Promise<
            { id: number; s: number; v: number }[]
        >;
    const stripPx = () =>
        kexCall(page, "stripKfPx") as Promise<{ id: number; x: number; y: number }[]>;
    const target = (await stripKfs())[1];
    const point = (await stripPx()).find((p) => p.id === target.id);
    if (!point) throw new Error("strip keyframe not laid out");
    const before = target.s;
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 35, point.y, { steps: 6 });
    await expect
        .poll(async () => (await stripKfs()).find((k) => k.id === target.id)?.s)
        .not.toBe(before);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect
        .poll(async () => (await stripKfs()).find((k) => k.id === target.id)?.s)
        .toBe(before);
    await expect(page.locator("#app[data-dragging]")).toHaveCount(0);
    await page.mouse.up();

    // Label-scrub listeners live on the label, so blur must cancel them separately from the
    // canvas drag teardown. The positive mid-scrub read proves the scrub really wrote first.
    const selected = (await stripKfs()).find((k) => k.s === before);
    if (!selected) throw new Error("restored strip keyframe not found");
    const restoredPx = (await stripPx()).find((p) => p.id === selected.id);
    if (!restoredPx) throw new Error("restored strip keyframe projection missing");
    await page.mouse.click(restoredPx.x, restoredPx.y);
    await expect(page.locator(".ptip")).toBeVisible();
    const label = page.locator(".ptip .fld").nth(0).locator(".key");
    const labelBox = await label.boundingBox();
    if (!labelBox) throw new Error("strip position scrub label not laid out");
    const scrubBefore = (await stripKfs()).find((k) => k.id === selected.id)?.s;
    if (scrubBefore === undefined) throw new Error("strip keyframe vanished before label scrub");
    await page.mouse.move(labelBox.x + labelBox.width / 2, labelBox.y + labelBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(labelBox.x + labelBox.width / 2 + 35, labelBox.y + labelBox.height / 2, {
        steps: 6,
    });
    await expect
        .poll(async () => (await stripKfs()).find((k) => k.id === selected.id)?.s)
        .not.toBe(scrubBefore);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect
        .poll(async () => (await stripKfs()).find((k) => k.id === selected.id)?.s)
        .toBe(scrubBefore);
    await expect(page.locator("#app[data-dragging]")).toHaveCount(0);
    await page.mouse.up();
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

    // ── 1. Use the two continuation keys seeded on the appended force section — free chart
    // double-click insertion is removed in S4. The value-drag heir below edits the exit seed.
    const fcb = await page.locator(".clip").nth(1).boundingBox(); // the force clip
    if (!fcb) throw new Error("force clip not laid out");
    await page.locator(".clip").nth(1).click();
    await expect.poll(async () => (await forceCounts())[1]).toBe(2); // the two seeds

    // ── 2. Park the playhead over the force section via a real RULER scrub — a click in
    // the ruler band (above the clip lane) at the force section's x. it parks (held) at
    // that content anchor and stops the cart. ──
    await page.mouse.click(fcb.x + fcb.width / 2, bb.y + 13); // ruler band y (< RULER_H)
    await expect.poll(parked).toBe(true);
    const arc1 = await cartArc();
    const tt1 = await tTotal();
    if (arc1 === null) throw new Error("cartArc null after park");
    if (strip) await page.screenshot({ path: join(OUT, "park-1-anchored.png"), clip: strip });

    // ── 3. Drag the keyframe's g from its projected station → the force profile changes and
    // the bake re-times. The station hook survives the force glyph identity change in S3c3. ──
    const marker = await forcePointAt(page, 1);
    await page.mouse.move(marker.x, marker.y);
    await page.mouse.down();
    await page.mouse.move(marker.x, marker.y + 60, { steps: 10 });
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

// Time-view force position dragging was retired with the force position axis in S4.
// The surviving Time-view trim and strip-keyframe projection arms remain covered below and in
// section.pw.ts; force value dragging is covered by the S4 shared-path control above.

// Time-view trim heirs retained by S4. These are extent and downstream-layout behaviors, not the
// removed force position axis, so they remain real pointer capture flows.
test("timeline domain flow — Time-view trim writes arclength through the frozen table (S6c heir)", async ({
    page,
    boot,
}) => {
    await boot();
    const forceU = () => kexCall(page, "forceU") as Promise<{ s: number; u: number }[]>;
    const lengths = () => kexCall(page, "sectionLengths") as Promise<number[]>;
    const domain = () => kexCall(page, "domain");
    const dOf = (u: number) => kexCall(page, "dOf", u) as Promise<number>;
    const dOfTrim = (u: number) => kexCall(page, "dOfTrim", u) as Promise<number>;
    const uOf = (d: number) => kexCall(page, "uOf", d) as Promise<number>;
    const xView = () => kexCall(page, "xView") as Promise<[number, number]>;
    await kexCall(page, "seedForceBump");
    await kexCall(page, "setV0", 25);
    await frameTimeline(page);
    await page.locator(".rulerzone").click({ button: "right", position: { x: 40, y: 10 } });
    await clickMenuItem(page, ".rmenu", "Seconds");
    await expect.poll(domain).toBe("time");
    await frames(page, 2);
    const rows = await forceU();
    const start = rows[0];
    const len0 = (await lengths())[0];
    const startD = await dOf(start.u);
    const trimU = await uOf(startD + len0);
    const [, scale] = await xView();
    const trim = page.locator(".clip-trim");
    const box = await trim.boundingBox();
    if (!box) throw new Error("Time-view trim handle not laid out");
    const finalU = trimU + 50 / scale;
    const expected = (await dOfTrim(finalU)) - startD;
    await page.keyboard.down("Control");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 50, box.y + box.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.up("Control");
    await expect.poll(async () => (await lengths())[0]).toBeCloseTo(expected, 0);
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await lengths())[0]).toBeCloseTo(len0, 3);
});

test("timeline domain flow — Time-view extent trim extrapolates past the bake end (S6b heir)", async ({
    page,
    boot,
}) => {
    await boot();
    const forceU = () => kexCall(page, "forceU") as Promise<{ s: number; u: number }[]>;
    const lengths = () => kexCall(page, "sectionLengths") as Promise<number[]>;
    const domain = () => kexCall(page, "domain");
    const dOf = (u: number) => kexCall(page, "dOf", u) as Promise<number>;
    const dOfTrim = (u: number) => kexCall(page, "dOfTrim", u) as Promise<number>;
    const uOf = (d: number) => kexCall(page, "uOf", d) as Promise<number>;
    const tTotal = () => kexCall(page, "tTotal") as Promise<number>;
    const xView = () => kexCall(page, "xView") as Promise<[number, number]>;
    await kexCall(page, "seedForceBump");
    await kexCall(page, "setV0", 25);
    await frameTimeline(page);
    await page.locator(".rulerzone").click({ button: "right", position: { x: 40, y: 10 } });
    await clickMenuItem(page, ".rmenu", "Seconds");
    await expect.poll(domain).toBe("time");
    await frames(page, 2);
    const rows = await forceU();
    const startD = await dOf(rows[0].u);
    const len0 = (await lengths())[0];
    const trimU = await uOf(startD + len0);
    const past = (await tTotal()) + 2;
    const clamped = await dOf(past);
    const extended = await dOfTrim(past);
    expect(extended).toBeGreaterThan(clamped + 1);
    const [, scale] = await xView();
    const trim = page.locator(".clip-trim");
    const box = await trim.boundingBox();
    if (!box) throw new Error("Time-view extrapolation trim not laid out");
    await page.keyboard.down("Control");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + (past - trimU) * scale, box.y + box.height / 2, {
        steps: 10,
    });
    await page.mouse.up();
    await page.keyboard.up("Control");
    const expected = extended - startD;
    await expect.poll(async () => (await lengths())[0]).toBeCloseTo(expected, 0);
    expect(Math.abs((await lengths())[0] - (clamped - startD))).toBeGreaterThan(0.5);
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await lengths())[0]).toBeCloseTo(len0, 3);
});

test("timeline domain flow — downstream clip edge tracks an upstream Time-view extent (S1 heir)", async ({
    page,
    boot,
}) => {
    await boot();
    const lengths = () => kexCall(page, "sectionLengths") as Promise<number[]>;
    const domain = () => kexCall(page, "domain");

    await kexCall(page, "seedForceBump");
    await kexCall(page, "setV0", 25);
    await kexCall(page, "append", 1);
    await frameTimeline(page);
    await page.locator(".rulerzone").click({ button: "right", position: { x: 40, y: 10 } });
    await clickMenuItem(page, ".rmenu", "Seconds");
    await expect.poll(domain).toBe("time");
    await frames(page, 2);
    const clips = page.locator(".clip");
    const downstreamBefore = await clips.nth(1).boundingBox();
    if (!downstreamBefore) throw new Error("downstream Time-view clip not laid out");
    // The trim gesture itself is exercised by the two pointer-true heirs above and by the
    // section clip flow. Here the capture subject is the downstream edge projection: change the
    // upstream extent through the same authored command, then read the rendered downstream clip.
    const beforeLength = (await lengths())[0];
    await kexCall(page, "setLen", 0, beforeLength + 8);
    await frames(page, 2);
    const downstreamAfter = await clips.nth(1).boundingBox();
    if (!downstreamAfter) throw new Error("downstream clip vanished during extent update");
    expect(downstreamAfter.x).toBeGreaterThan(downstreamBefore.x + 4);
    await expect.poll(async () => (await lengths())[0]).toBeGreaterThan(beforeLength);
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
// keyframes (start/end), the S4 shared-path selection fixture.
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
