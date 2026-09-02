// kex2d's SECTION-chain capture flows (multi-section ops, the clip strip, invoked geo↔force
// solves, v0 authoring, and the mixed-layout dogfood). Shared helpers + the `__kex` typed hook
// live in `./flow`.

import {
    test,
    expect,
    join,
    OUT,
    SHOT_MS,
    kexCall,
    nodePoint,
    seedHill,
    frameTimeline,
    clickMenuItem,
    menuGrammar,
    marqueeDrag,
    dockStrip,
    DOCK_RESERVE,
    frames,
    CHART_TOP,
    CHART_BOT_PAD,
    type Kex,
} from "./flow";

// Drive the MULTI-SECTION chain shape: a geo track → append a section → convert it to
// force (a mixed geo→force chain) → delete the force tail → undo. The ops run through the
// __kex hooks; sectionCount / sectionKinds assert the chain shape. (Split/join left the
// editor — deferred to the conversion tier — so they're no longer exercised here; the
// substrate ops stay covered by the unit suite.)
test("multi-section flow", async ({ page, boot }) => {
    await boot();

    const sectionCount = () => kexCall(page, "sectionCount");
    const sectionKinds = () => kexCall(page, "sectionKinds");
    const selectedSection = () => kexCall(page, "selectedSection");
    const tTotal = () => kexCall(page, "tTotal");

    await seedHill(page);
    expect(await sectionCount()).toBe(1);

    // ── 1. Append a geo section, then convert it to force → a mixed geo→force chain. the convert
    // seeds its keyframes from the RECOVERED ENTRY FORCE, which `sectionInfo` only carries once the
    // appended section is in the bake — and the section COUNT is satisfied the instant `append`
    // returns, a frame earlier (the bake-readiness law). Racing it seeds `DEFAULT_G` or the
    // recovered force by coin flip, and `sections-mixed.png` flips with it. So wait for the bake
    // itself to move. ──
    const tGeo = await tTotal();
    await kexCall(page, "append", 0); // SectionKind.Geo
    await expect.poll(sectionCount).toBe(2);
    await expect.poll(tTotal).not.toBe(tGeo); // the appended section is IN the bake
    await kexCall(page, "convertAt", 1);
    await expect.poll(async () => (await sectionKinds()).join(",")).toBe("0,1"); // geo, force
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "sections-mixed.png") });

    // ── 2. Delete the force tail → 1 (downstream rebases); undo restores it. ──
    await kexCall(page, "deleteAt", 1);
    await expect.poll(sectionCount).toBe(1);
    await page.keyboard.press("Control+z");
    await expect.poll(sectionCount).toBe(2);

    // ── 3. THE SELECTED NODE'S CLIP WASHES — the cross-surface context read (kex2d-geo-ux stage 3):
    // "which clip does the selection live in", a quieter register than the selected-clip state. It is
    // keyed to the OWNING section (`washSection` = `Handle.section` of the active node), which only a
    // chain with MORE THAN ONE geo clip can prove: with a single geo section every wrong answer
    // ("always the first clip", "always a geo clip") is indistinguishable from the right one. So grow
    // the chain to geo · force · geo and select a node in each end. ──
    const tMixed = await tTotal();
    await kexCall(page, "append", 0); // SectionKind.Geo — the third section
    await expect.poll(sectionCount).toBe(3);
    await expect.poll(tTotal).not.toBe(tMixed); // the appended section is IN the bake
    // `F` frames the SELECTION when there is one (`frameRange`), and every screen point below is
    // computed against that camera — so pin the precondition rather than inferring it from what the
    // undo happened to restore.
    expect(await selectedSection()).toBeNull();
    await page.keyboard.press("f"); // nothing selected → the whole chain frames
    await frameTimeline(page); // …and every clip on-screen, so `.clip.nth()` is section order
    const clips = page.locator(".clip");
    await expect(clips).toHaveCount(3);
    const washed = async (): Promise<boolean[]> => {
        const cls = await clips.evaluateAll((els) => els.map((e) => e.getAttribute("class") ?? ""));
        return cls.map((c) => c.split(/\s+/).includes("wash"));
    };

    const canvas = page.locator("canvas.viewport");
    const cb = await canvas.boundingBox();
    if (!cb) throw new Error("viewport canvas not laid out");

    // a node in the FIRST section (the seeded hill) → its own clip washes, the other two don't.
    // Mutations: `washSection` → null → red here; → the second section's id → red here.
    const nodeSelOrders = () => kexCall(page, "nodeSelOrders");
    const n3 = await nodePoint(page, 3);
    await page.mouse.click(cb.x + n3.x, cb.y + n3.y);
    await expect.poll(nodeSelOrders).toEqual([3]);
    await expect.poll(washed).toEqual([true, false, false]);

    // …and a node in the THIRD section moves it. That section's nodes have no `__kex` locator (the
    // hooks address section 0), so they're reached the way an author would: a marquee over the strip
    // of viewport downstream of the first section's tip — everything right of it belongs to the force
    // section (which has no nodes) or to the third (whose order-0 entry a marquee never takes, so the
    // rect can only resolve to its one draggable node). The `[false, false, true]` shape is what
    // discriminates: had the rect caught a first-section node instead, clip 0 would light.
    const tip = await nodePoint(page, 6); // the first section's chain end = the geo/force boundary
    await marqueeDrag(
        page,
        cb.x + tip.x + 24,
        cb.y + 6,
        cb.x + cb.width - 6,
        cb.y + cb.height - DOCK_RESERVE,
    );
    await expect.poll(nodeSelOrders).toEqual([1]); // its one draggable node — orders are per-section
    await expect.poll(washed).toEqual([false, false, true]);
    // …and the wash PAINTS: the class alone would survive deleting the `.clip.geo.wash` rule that is
    // the whole feature. Both clips are geo and neither is hovered (the pointer is over the canvas),
    // so their resolved fills differ only by the wash rung.
    const fills = await clips.evaluateAll((els) => els.map((e) => getComputedStyle(e).fill));
    expect(fills[2]).not.toBe(fills[0]);
    await page.waitForTimeout(SHOT_MS);
    const strip = dockStrip(page);
    if (strip) await page.screenshot({ path: join(OUT, "sections-wash.png"), clip: strip });

    // selecting a CLIP instead takes the selection with it (a plain click replace-selects,
    // clearing all members), so the wash goes out entirely — a washed clip is never also the
    // selected clip, which is the whole reason the wash is a quieter register than `sel`.
    // Mutation: key `washSection` to `editor.section` → the selected clip washes → red.
    await clips.nth(0).click();
    await expect(clips.nth(0)).toHaveClass(/sel/);
    await expect.poll(washed).toEqual([false, false, false]);
});

// Drive the CLIP STRIP flow (section-editor spec stage 1): the section lane in the
// dock's marker band. seed one geo section → append a force section via the real `+`
// flyout → select the geo clip → drag the force clip's right-edge extent trim → undo.
// Every affordance is driven through the real DOM (clip rect, flyout, trim handle); the
// __kex hook is read only for assertions, never to perform the op.
test("section clip strip flow", async ({ page, boot }) => {
    await boot();

    const sectionCount = () => kexCall(page, "sectionCount");
    const sectionKinds = () => kexCall(page, "sectionKinds");
    const sectionIds = () => kexCall(page, "sectionIds");
    const sectionLengths = () => kexCall(page, "sectionLengths");
    const selectedSection = () => kexCall(page, "selectedSection");

    const strip = dockStrip(page);

    // seed one geo section → one geo clip in the lane.
    await seedHill(page);
    await expect(page.locator(".clip")).toHaveCount(1);
    await page.waitForTimeout(SHOT_MS);
    if (strip) await page.screenshot({ path: join(OUT, "clip-1-strip.png"), clip: strip });

    // ── 1. Append a force section via the real + flyout → a mixed geo→force chain. the flyout
    // root-mounts (out of the dock's overflow clip), so assert its item is hit-testable at its
    // own center — a real pointer's reach, the Menus reachability net (a selector .click() fires
    // on a clipped, humanly-unreachable row). ──
    await page.locator(".clip-add").click();
    const forceItem = page
        .locator(".clip-flyout")
        .getByRole("menuitem", { name: "Append force section" });
    await expect(forceItem).toBeVisible();
    const fib = await forceItem.boundingBox();
    if (!fib) throw new Error("append flyout item not laid out");
    const fix = fib.x + fib.width / 2;
    const fiy = fib.y + fib.height / 2;
    const flyoutReach = await page.evaluate(
        (p: { x: number; y: number }) =>
            document.elementFromPoint(p.x, p.y)?.closest(".menu-item") !== null,
        { x: fix, y: fiy },
    );
    expect(
        flyoutReach,
        "append flyout item must be hit-testable at its own center (not clipped)",
    ).toBe(true);
    await page.mouse.click(fix, fiy);
    await expect.poll(sectionCount).toBe(2);
    await expect.poll(async () => (await sectionKinds()).join(",")).toBe("0,1"); // geo, force
    // the append selects the new (force) section — its clip reads selected.
    await expect.poll(selectedSection).toBe((await sectionIds())[1]);
    await frameTimeline(page); // append never pans; frame the grown chain into view
    await expect(page.locator(".clip")).toHaveCount(2);
    await page.waitForTimeout(SHOT_MS);
    if (strip) await page.screenshot({ path: join(OUT, "clip-2-append.png"), clip: strip });

    // ── 2. Click the geo clip → editor.section becomes the first section (one object,
    // two surfaces: the same selection the viewport span drives). ──
    const ids = await sectionIds();
    await page.locator(".clip").nth(0).click();
    await expect.poll(selectedSection).toBe(ids[0]);

    // ── 3. Drag the force clip's right-edge trim handle → the section lengthens (one
    // history entry). the force clip is the only one with a trim handle. ──
    const before = await sectionLengths();
    const trim = page.locator(".clip-trim");
    await expect(trim).toHaveCount(1);
    const tb = await trim.boundingBox();
    if (!tb) throw new Error("trim handle not laid out");
    const cy = tb.y + tb.height / 2;
    await trim.hover(); // move to the handle center with actionability, then drag right
    // hold Ctrl to bypass the snapping magnet (default-on, kex2d-ux-foundations stage E) —
    // this flow tests the extent trim itself, not snapping, so the drag lands where the
    // cursor does, deterministically. The un-bypassed snap grammar (grid + landmark, Ctrl
    // bypass) is exercised through the production handler by its own capture arm
    // (`segment and strip resize snap to grid increments (F4)`, S6) — never a unit arm alone
    // (S1's own residue: a unit arm plus an all-sites Ctrl opt-out reads as coverage from
    // either side and is neither).
    await page.keyboard.down("Control");
    await page.mouse.down();
    await page.mouse.move(tb.x + tb.width / 2 + 50, cy, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.up("Control");
    await expect.poll(async () => (await sectionLengths())[1]).toBeGreaterThan(before[1]);
    if (strip) await page.screenshot({ path: join(OUT, "clip-3-trim.png"), clip: strip });

    // undo restores the pre-drag extent, one entry.
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await sectionLengths())[1]).toBeCloseTo(before[1], 3);
});

// Drive the SECTION MENU + DIRECT-BY-POSITION flow (section-editor stage 2): a mixed
// geo→force chain → prove empty-chart click deselects → add a force keyframe by cursor
// position WITHOUT selecting the section → right-click the real context menu, assert its
// remaining rows (ONE kind-fitted conversion row + Delete — the destructive Convert row was
// removed, kex2d-geoforce-editor stage 5; the two direction rows collapsed to one in
// kex2d-forcegeo stage 4) → Delete via the real menu. The whole point is that authoring
// and section ops no longer depend on a "current section" selection. Everything is driven
// through the real DOM.
test("section menu + keyframe flow", async ({ page, boot }) => {
    await boot();

    const sectionCount = () => kexCall(page, "sectionCount");
    const sectionKinds = () => kexCall(page, "sectionKinds");
    const sectionIds = () => kexCall(page, "sectionIds");
    const forceCounts = () => kexCall(page, "sectionForceCounts");
    const selectedSection = () => kexCall(page, "selectedSection");
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

    // ── 1. Empty-chart click deselects the section (the stage-1 feel finding). ──
    const ids = await sectionIds();
    await page.locator(".clip").nth(0).click(); // select the geo clip
    await expect.poll(selectedSection).toBe(ids[0]);
    await page.mouse.click(bb.x + bb.width * 0.5, bb.y + bb.height * 0.62); // empty chart body
    await expect.poll(selectedSection).toBe(null);

    // ── 2. Force-area double-click is inert in S4; no free force keyframe is inserted. ──
    const before = await forceCounts(); // [n_geo(0), 0]
    const fcb = await page.locator(".clip").nth(1).boundingBox(); // the force clip
    if (!fcb) throw new Error("force clip not laid out");
    await page.mouse.dblclick(fcb.x + fcb.width / 2, bb.y + bb.height * 0.5);
    await expect.poll(async () => forceCounts()).toEqual(before);

    // ── 3. Escape peels EXACTLY ONE rung off the section context menu: the menu goes, the
    // section it was summoned on stays selected (root ui.md's layered dismissal). Both rungs are
    // pinned before the press — no other menu mounted above it, the selection it must NOT peel
    // asserted ON — so a green run can't be peeling a rung this flow never named. ──
    await page.locator(".clip").nth(1).click({ button: "right" });
    await expect(page.locator(".ctxmenu")).toBeVisible();
    await expect(page.locator(".nodemenu")).toHaveCount(0); // nothing above the rung being peeled
    expect(await selectedSection()).toBe(ids[1]); // the rung below, ON before the press
    await page.keyboard.press("Escape");
    await expect(page.locator(".ctxmenu")).toHaveCount(0);
    await frames(page, 2); // let a stray deselect land before reading — the assert is a retention
    expect(await selectedSection()).toBe(ids[1]);
    await page.keyboard.press("Escape"); // the NEXT press peels the selection (no stale swallow)
    await expect.poll(selectedSection).toBe(null);

    // ── 4. Right-click the force clip: the menu carries exactly FOUR rows — ONE `Convert` row
    // (stage 7 naming: the section's kind implies the direction, so the label is the verb
    // alone), the force-only Pin entry, Reset (kex2d-idioms stage 2 — kind-held, live on a
    // baked force section), and Delete. (Also the real-menu regression guard for the destructive
    // Convert row's removal.) ──
    await page.locator(".clip").nth(1).click({ button: "right" });
    await expect(page.locator(".ctxmenu")).toBeVisible();
    await expect(page.locator(".ctxmenu").getByRole("menuitem")).toHaveCount(4);
    await expect(page.locator(".ctxmenu").getByRole("menuitem", { name: "Convert" })).toBeEnabled();
    await expect(page.locator(".ctxmenu").getByRole("menuitem", { name: "Pin" })).toBeEnabled();
    await expect(page.locator(".ctxmenu").getByRole("menuitem", { name: "Reset" })).toBeEnabled();
    // the section menu's rows already sorted canonically, so the grammar's arrival adds only the
    // DERIVED modify→lifecycle divider. The expectation comes from the real `sectionMenu` builder,
    // run in the page against this section's live state (the section half of the rendered-DOM
    // cross-check, kex2d-menu-grammar decision 8).
    await menuGrammar(page, ".ctxmenu", {
        builder: "sectionMenu",
        // a single, baked force section, no pin session anywhere: Convert runs the force→geo
        // fit, Pin can enter, Reset and Delete are live.
        state: {
            inMode: false,
            solving: false,
            pinSolvable: false,
            multi: false,
            modeOpen: false,
            canSolve: false,
            canSolveShape: true,
            canPin: true,
            canReset: true,
            canDelete: true,
        },
        enums: { kind: "section.SectionKind.Force" },
    });
    if (strip) await page.screenshot({ path: join(OUT, "section-4-menu.png"), clip: strip });
    await page.keyboard.press("Escape");
    await expect(page.locator(".ctxmenu")).toHaveCount(0);

    // ── 5. Right-click a clip → Delete (real context menu). ──
    await page.locator(".clip").nth(1).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await expect.poll(sectionCount).toBe(1);
});

// Drive the INVOKED GEO→FORCE SOLVE end to end (kex2d-geoforce-editor stage 3): the section
// menu's Convert to force row → the modal (progress climbing, all other input blocked, Cancel and
// Escape) → the real solve → the document (kind flipped, keyframes landed) → one undo back to
// the authored shape, byte-identical.
//
// This is the ONE gate that proves the WORKER BUNDLING ships. `convert.ts` spawns its pool with
// `new Worker(new URL("./convert-worker.ts", import.meta.url))` — the exact shape the bundler
// rewrites — and bun's test runner resolves that specifier itself, so a build that ships a
// broken or dev-only worker URL is green everywhere except here.
test("invoked solve flow", async ({ page, boot }) => {
    await boot();

    const kinds = () => kexCall(page, "sectionKinds");
    const forceCounts = () => kexCall(page, "sectionForceCounts");
    const lengths = () => kexCall(page, "sectionLengths");
    const poses = () => kexCall(page, "poses");
    const undoDepth = () => kexCall(page, "undoDepth");
    const sectionCount = () => kexCall(page, "sectionCount");
    const scrim = page.locator(".scrim");
    const strip = dockStrip(page);

    // the twin hill, plus a force section behind it. the second section is what gives the
    // input-block assert below something to bite: Delete on a LONE section is a no-op whether or
    // not the modal blocks it, so the gate would pass vacuously on a one-section chain.
    await seedHill(page, "seedTwinHill");
    await kexCall(page, "append", 1); // SectionKind.Force
    await expect.poll(async () => (await kinds()).join(",")).toBe("0,1");
    await frameTimeline(page); // append never pans; frame the chain so `.clip.nth()` resolves
    const appended = await undoDepth(); // the append's own entry — the baseline every assert reads

    // ── 1. The row grays where the convert can't run, never hides (the bulk-row law): a
    // multi-set has no single subject to convert, so the kind-fitted row is there and dead. ──
    await page.locator(".clip").nth(0).click();
    await page
        .locator(".clip")
        .nth(1)
        .click({ modifiers: ["Shift"] }); // a two-section set
    await page.locator(".clip").nth(0).click({ button: "right" }); // right-click keeps the set
    await expect(page.locator(".ctxmenu")).toBeVisible();
    await expect(
        page.locator(".ctxmenu").getByRole("menuitem", { name: "Convert" }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(page.locator(".ctxmenu")).toHaveCount(0);
    await page.locator(".clip").nth(0).click(); // back to a single selection

    // ── 2. On the geo clip it's live. Invoke it, and the modal comes up. ──
    await page.locator(".clip").nth(0).click({ button: "right" });
    await expect(page.locator(".ctxmenu")).toBeVisible();
    const solveRow = page.locator(".ctxmenu").getByRole("menuitem", { name: "Convert" });
    await expect(solveRow).toBeEnabled();
    await page.waitForTimeout(SHOT_MS);
    if (strip) await page.screenshot({ path: join(OUT, "solve-1-menu.png"), clip: strip });
    await clickMenuItem(page, ".ctxmenu", "Convert");
    await expect(scrim).toBeVisible();

    // ── 3. Every other input is blocked while it runs. Del would delete the selected section
    // (the right-click selected it) and Ctrl+Z would undo the append — both real ops on this exact
    // state (both proven below with the modal down: Del in step 4, Ctrl+Z throughout), so it fails the moment
    // the gate stops swallowing. Read after EACH press: the two are inverses, so a pair read only at
    // the end passes on a gate that swallowed NEITHER. ──
    await page.keyboard.press("Delete"); // would remove the selected section
    await frames(page, 2); // let a leaked op land before reading — the assert is a retention
    expect(await sectionCount(), "Del reached the editor from behind the modal").toBe(2);
    await page.keyboard.press("Control+z"); // would undo the append
    await frames(page, 2);
    expect(await undoDepth(), "Ctrl+Z reached the editor from behind the modal").toBe(appended);
    expect((await kinds()).join(",")).toBe("0,1");
    // …and the OTHER input class the key swallow can't reach: a background control taking focus,
    // where an Enter/Space becomes a real `click` no keydown handler ever sees. `inert` on the
    // content is what closes it, so probe exactly that — a focus() the browser must refuse.
    const probe = await page.evaluate((): string => {
        const btn = document.querySelector<HTMLElement>(".dock button");
        if (!btn) return "no background button to probe";
        btn.focus();
        return document.activeElement === btn ? "focused" : "refused";
    });
    expect(probe, "a background control took focus from behind the modal").toBe("refused");
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "solve-2-modal.png") });

    // ── 4. The Cancel button closes it, writing nothing: the façade is pure, so a cancelled
    // solve leaves the document exactly as authored and says nothing (the author asked for it). ──
    await page.locator(".convert .cancel").click();
    await expect(scrim).toHaveCount(0);
    expect((await kinds()).join(",")).toBe("0,1");
    expect((await forceCounts())[0]).toBe(0);
    expect(await undoDepth()).toBe(appended);
    await expect(page.locator(".notice")).toHaveCount(0);

    // …and now the Del leg of step 3 earns its bite: that assert is a RETENTION, vacuous unless
    // the same press on the same state really does delete with the modal down. Press it here,
    // watch the section go, then put it back — the selection the right-click made is still the
    // geo section, so this is the identical op the gate swallowed. ──
    await page.keyboard.press("Delete");
    await expect.poll(sectionCount, { message: "Del does nothing with the modal down" }).toBe(1);
    await page.keyboard.press("Control+z");
    await expect.poll(sectionCount).toBe(2);
    await expect.poll(async () => (await kinds()).join(",")).toBe("0,1");
    expect(await undoDepth()).toBe(appended);
    await frames(page, 2); // a respawning restore — let the bake catch up before the next gesture

    // ── 5. Escape is the same control (the modal is the only live surface, so its dismissal
    // rung is the cancel). ──
    await page.locator(".clip").nth(0).click({ button: "right" });
    await clickMenuItem(page, ".ctxmenu", "Convert");
    await expect(scrim).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(scrim).toHaveCount(0);
    expect((await kinds()).join(",")).toBe("0,1");
    expect(await undoDepth()).toBe(appended);

    // ── 6. Now let one run to completion. The authored shape is recorded first — undo has to
    // put every one of these stored f32 back. ──
    const authored = await poses();
    expect(authored.length).toBeGreaterThan(2);

    // sample the modal's live progress per FRAME, from the page itself: the solve resolves on its
    // own schedule, so a poll from the test side could only ever catch it by luck. The sampler
    // records how many frames the surface was up for and every distinct reading it showed — a
    // modal that never rendered, or one whose counts never moved, both come back empty.
    await page.evaluate(() => {
        const w = window as any;
        w.__solve = { frames: 0 };
        const step = (): void => {
            // the in-flight status is the SPINNER now (stage 6 — the phase/keys/probes prose
            // was noise): the sampler counts the frames the affordance was actually on screen.
            if (document.querySelector(".convert .spin")) w.__solve.frames++;
            requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    });

    await page.locator(".clip").nth(0).click({ button: "right" });
    await clickMenuItem(page, ".ctxmenu", "Convert");
    // the solve is seconds long (the twin hill is ~1.3s of probes in bun, more in a browser under
    // four parallel workers), so this wait is the flow's own budget, not the default 5s.
    await expect.poll(async () => (await kinds()).join(","), { timeout: 120_000 }).toBe("1,1");

    const log = await page.evaluate((): { frames: number } => (window as any).__solve);
    expect(log.frames, "the progress spinner was never on screen").toBeGreaterThan(0);
    await expect(scrim).toHaveCount(0); // the gate closed with the answer

    // ── 7. What landed: the section is force, carrying the solve's keyframes and its realized
    // extent. One undo entry, on top of the append's. ──
    expect((await forceCounts())[0]).toBeGreaterThan(1);
    expect((await lengths())[0]).toBeGreaterThan(0);
    expect(await undoDepth()).toBe(appended + 1);

    // the transient readout: outcome + keys + how far off it landed. Nothing of it is stored.
    const notice = page.locator(".notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("Converted to force");
    await page.waitForTimeout(SHOT_MS);
    // the whole page: the readout is top-center and the converted curve is in the dock, and this
    // shot's subject is the pair.
    await page.screenshot({ path: join(OUT, "solve-3-done.png") });

    // ── 8. One undo, and the geo shape is back byte-identical — every stored node coordinate
    // and heading, not just the kind. ──
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await kinds()).join(",")).toBe("0,1");
    expect(await poses()).toEqual(authored);
    expect((await forceCounts())[0]).toBe(0);
    expect(await undoDepth()).toBe(appended);
});

// Drive the INVOKED FORCE→GEO FIT end to end (kex2d-forcegeo stage 3) — the observation-space
// twin of "invoked solve flow": the section menu's Convert to geo row → the modal (indeterminate —
// `geofit` has no internal phase, so there's no probe count to climb, only the same shared gate —
// all other input blocked, Cancel and Escape) → the real fit → the document (kind flipped, Auto
// geo nodes landed) → one undo back to the authored force shape, byte-identical.
test("invoked force→geo fit flow", async ({ page, boot }) => {
    await boot();

    const kinds = () => kexCall(page, "sectionKinds");
    const forceCounts = () => kexCall(page, "sectionForceCounts");
    const nodeCount = () => kexCall(page, "nodeCount");
    const poses = () => kexCall(page, "poses");
    const undoDepth = () => kexCall(page, "undoDepth");
    const sectionCount = () => kexCall(page, "sectionCount");
    const tTotal = () => kexCall(page, "tTotal");
    const scrim = page.locator(".scrim");
    const strip = dockStrip(page);

    // an oscillating force profile on section 0 (`seedForceStress` — long enough for the fit to
    // stay observably in flight, unlike the fast corpus-scale `seedForceBump`), then an appended
    // geo section — the second section gives the input-block assert below something to bite, and
    // lets the row-grays-on-a-geo-clip check use the section this flow's own subject ISN'T (the
    // mirror image of "invoked solve flow"'s force clip).
    await kexCall(page, "seedForceStress");
    await kexCall(page, "append", 0); // SectionKind.Geo
    await expect.poll(async () => (await kinds()).join(",")).toBe("1,0");
    // a kind flip is instant (live ECS), but the 1200 m profile only reaches `sectionInfo`/the
    // fit's own input on the NEXT bake pass — wait on that actually landing (`tTotal` growing
    // past what the tiny default seed could ever reach), not on the kind poll above (a count is
    // never bake-readiness, `kex2d-harness.md`).
    await expect.poll(tTotal).toBeGreaterThan(10);
    await frameTimeline(page); // append never pans; frame the chain so `.clip.nth()` resolves
    const appended = await undoDepth(); // the bump + append's own entries — the baseline every assert reads

    // ── 1. ONE `Convert` row on either kind (stage 7 naming — the kind implies the direction;
    // the action behind it is this kind's own). The grayed case (the kind fits, the invoke
    // can't run) is pinned in "invoked solve flow". ──
    await page.locator(".clip").nth(1).click({ button: "right" });
    await expect(page.locator(".ctxmenu")).toBeVisible();
    await expect(page.locator(".ctxmenu").getByRole("menuitem", { name: "Convert" })).toHaveCount(
        1,
    );
    await expect(page.locator(".ctxmenu").getByRole("menuitem", { name: "Convert" })).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(page.locator(".ctxmenu")).toHaveCount(0);

    // ── 2. On the force clip it's live. Invoke it, and the modal comes up. ──
    await page.locator(".clip").nth(0).click({ button: "right" });
    await expect(page.locator(".ctxmenu")).toBeVisible();
    const solveRow = page.locator(".ctxmenu").getByRole("menuitem", { name: "Convert" });
    await expect(solveRow).toBeEnabled();
    await page.waitForTimeout(SHOT_MS);
    if (strip) await page.screenshot({ path: join(OUT, "fit-1-menu.png"), clip: strip });
    await clickMenuItem(page, ".ctxmenu", "Convert");
    await expect(scrim).toBeVisible();

    // ── 3. Every other input is blocked while it runs — the same shared gate "invoked solve
    // flow" pins in full; here just enough to prove the gate is live for THIS direction too. ──
    await page.keyboard.press("Delete"); // would remove the selected section
    await frames(page, 2);
    expect(await sectionCount(), "Del reached the editor from behind the modal").toBe(2);
    await page.keyboard.press("Control+z"); // would undo the append
    await frames(page, 2);
    expect(await undoDepth(), "Ctrl+Z reached the editor from behind the modal").toBe(appended);
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "fit-2-modal.png") });

    // ── 4. The Cancel button closes it, writing nothing. ──
    await page.locator(".convert .cancel").click();
    await expect(scrim).toHaveCount(0);
    expect((await kinds()).join(",")).toBe("1,0");
    expect(await undoDepth()).toBe(appended);
    await expect(page.locator(".notice")).toHaveCount(0);

    // ── 5. Escape is the same control (the modal is the only live surface). ──
    await page.locator(".clip").nth(0).click({ button: "right" });
    await clickMenuItem(page, ".ctxmenu", "Convert");
    await expect(scrim).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(scrim).toHaveCount(0);
    expect((await kinds()).join(",")).toBe("1,0");
    expect(await undoDepth()).toBe(appended);

    // ── 6. Now let one run to completion. The authored shape is recorded first — undo has to put
    // every one of these keyframes back. ──
    const authoredForces = await forceCounts();
    expect(authoredForces[0]).toBeGreaterThan(2);

    await page.locator(".clip").nth(0).click({ button: "right" });
    await clickMenuItem(page, ".ctxmenu", "Convert");
    // the stress seed is ~2 s in bun, ~7× that under the real browser's worker — this wait is
    // that budget, not the default 5s.
    await expect.poll(async () => (await kinds()).join(","), { timeout: 30_000 }).toBe("0,0");
    await expect(scrim).toHaveCount(0); // the gate closed with the answer

    // ── 7. What landed: section 0 is geo, carrying the fit's Auto node chain, node 0 pinned at
    // the local origin exactly (the rigid-placement law). ──
    expect(await nodeCount()).toBeGreaterThan(1);
    expect((await poses())[0]).toEqual([0, 0, 0]);

    // the transient readout: a short confirmation — what it converted to, and the node count the
    // author now edits (the budget numbers appear only when a budget was missed).
    const notice = page.locator(".notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("Converted to geo");
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "fit-3-done.png") });

    // ── 8. One undo, and the force shape is back — every authored keyframe, not just the kind. ──
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await kinds()).join(",")).toBe("1,0");
    expect((await forceCounts())[0]).toBe(authoredForces[0]);
    expect(await undoDepth()).toBe(appended);
});

// RETIRED (S3, "one-shot events are a structurally distinct kind"): "v0 authoring flow" drove
// the entry speed by dragging `seed()`'s own real min-extent start STRIP's `s = 0` keyframe —
// that strip no longer exists (the track-start one-shot is a distinct point kind, no `Strip`
// row, no keyframe curve to drag). The one-shot's own lifecycle — delete, create, select,
// through the real pointer — is driven end to end in `affordance.pw.ts`'s "the track-start
// one-shot: delete, create, and select through the real pointer (S3)".

// Drive the START popover's REFUSAL path across its two remaining fields (μ, c) — the v0
// row retired (S5, the initial velocity is a strip now, no field left to refuse into): type
// an invalid value, press Enter (blur fires onchange) — the handler refuses the write
// (`validCoefficient`), so the model is untouched. What this pins beyond that: the DISPLAYED
// input text is also corrected back to the committed value, not left showing the refused
// text — a defect adversarial review caught (KexEdit PR #11 finding 1) because
// `value={muText}` is a Svelte prop binding that only writes the DOM on a computed-value
// change, and a refused write never changes the computed value. Witnessed red before the
// fix (this arm's own first run, `App.svelte` still un-repaired): "Timed out …
// expect(locator).toHaveValue … Expected string: \"0.021\" … Received string: \"-1\"" on the
// μ field — model-half (`friction`) already passed at that point, confirming the failure was
// the display half alone, not the refusal itself. Same shape for c (negative).
test("coefficient field refusal flow", async ({ page, boot }) => {
    await boot();

    const friction = () => kexCall(page, "friction");
    const resistance = () => kexCall(page, "resistance");

    const canvas = page.locator("canvas.viewport");
    const cb = await canvas.boundingBox();
    if (!cb) throw new Error("viewport canvas not laid out");
    await page.mouse.click(cb.x + cb.width / 2, cb.y + (cb.height - DOCK_RESERVE) / 2);
    await expect(page.locator(".vtip")).toBeVisible();

    const frictionBefore = await friction();
    const resistanceBefore = await resistance();

    // ── μ: type a negative value → refused (model untouched), and the field snaps back to the
    // committed text rather than showing the typed "-1" forever. ──
    const muInput = page.locator(".vtip .fld.mu input");
    await muInput.fill("-1");
    await page.keyboard.press("Enter");
    await expect.poll(friction).toBeCloseTo(frictionBefore, 6);
    await expect(muInput).toHaveValue(frictionBefore.toFixed(3));

    // ── c: same shape, a negative drag coefficient. ──
    const cInput = page.locator(".vtip .fld.c input");
    await cInput.fill("-0.001");
    await page.keyboard.press("Enter");
    await expect.poll(resistance).toBeCloseTo(resistanceBefore, 6);
    await expect(cInput).toHaveValue(resistanceBefore.toFixed(5));
});

// Drive the MIXED-LAYOUT DOGFOOD (section-editor stage 5): compose the whole chain the
// spec set out to author — a geo lead-in, a force airtime hill appended after it, then a
// geo turnaround appended after that — using the real `+` flyout and surviving force-value
// drag affordance. Force points are prepared through the headless authoring command because
// free force-area double-click insertion is removed in S4. This is the reproducible artifact
// behind the stage-5 verdict; the hands-on feel pass stays the user's.
// Precise geometry isn't asserted: the claim is the composed chain builds through real
// clicks and bakes, and the authored hill re-times the ride.
test("mixed layout dogfood flow", async ({ page, boot }) => {
    await boot();

    const sectionCount = () => kexCall(page, "sectionCount");
    const sectionKinds = () => kexCall(page, "sectionKinds");
    const forceCounts = () => kexCall(page, "sectionForceCounts");
    const tTotal = () => kexCall(page, "tTotal");
    const strip = dockStrip(page);

    // seed a shaped geo lead-in (section 0) — the shaped track the chain grows from.
    await seedHill(page);
    await expect.poll(sectionCount).toBe(1);

    // ── 1. Append a force section after the lead-in via the real + flyout. ──
    await page.locator(".clip-add").click();
    await page.getByRole("menuitem", { name: "Append force section" }).click();
    await expect.poll(async () => (await sectionKinds()).join(",")).toBe("0,1");
    await frameTimeline(page); // append never pans; frame the grown chain into view

    const body = page.locator(".dock .body");
    const bb = await body.boundingBox();
    if (!bb) throw new Error("timeline body not laid out");

    // ── 2. Use the two continuation keys seeded on the force section. Free force-area
    // double-click insertion is removed in S4; the value-drag heir edits the exit seed. ──
    const fcb = await page.locator(".clip").nth(1).boundingBox();
    if (!fcb) throw new Error("force clip not laid out");
    await page.locator(".clip").nth(1).click(); // select the appended force section
    await expect.poll(async () => (await forceCounts())[1]).toBe(2); // the two continuation seeds
    // Free chart insertion is gone, but the headless authoring command is the legitimate setup
    // seam for this capture. The behavior under test remains the real value affordance: three
    // authored points are present, and a pointer drag turns their flat profile into a hill.
    await kexCall(page, "placeForceAt", 1, 8, 1);
    await expect.poll(async () => (await forceCounts())[1]).toBe(3);

    // Pull the middle point below 1g via its fat hit target → an airtime change that re-times the
    // ride (the bake's total time shifts). `.fhit` is shared with velocity-strip keyframes.
    const tBefore = await tTotal();
    const beforeForces = (await kexCall(page, "forceU")) as {
        section: number;
        s: number;
        g: number;
    }[];
    const hits = page.locator(".fhit");
    await expect(hits).toHaveCount(3);
    const centers = await hits.evaluateAll(
        (els, range) =>
            els
                .map((el) => el.getBoundingClientRect())
                .map((r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 }))
                .filter((c) => c.x >= range.x0 && c.x <= range.x1)
                .sort((a, b) => a.x - b.x),
        { x0: fcb.x, x1: fcb.x + fcb.width },
    );
    expect(centers.length).toBe(3);
    const crest = centers[1];
    await page.mouse.move(crest.x, crest.y);
    await page.mouse.down();
    await page.mouse.move(crest.x, crest.y + 22, { steps: 10 });
    await page.mouse.up();
    const afterForces = (await kexCall(page, "forceU")) as {
        section: number;
        s: number;
        g: number;
    }[];
    const middleBefore = beforeForces.filter((p) => p.section === 1).sort((a, b) => a.s - b.s)[1];
    const middleAfter = afterForces.filter((p) => p.section === 1).sort((a, b) => a.s - b.s)[1];
    if (!middleBefore || !middleAfter) throw new Error("three-point force hill disappeared");
    expect(middleAfter.g).not.toBe(middleBefore.g);
    await expect.poll(async () => Math.abs((await tTotal()) - tBefore) > 1e-3).toBe(true);
    await page.waitForTimeout(SHOT_MS);
    if (strip) await page.screenshot({ path: join(OUT, "dogfood-1-hill.png"), clip: strip });

    // ── 3. Append a geo turnaround after the hill via the real + flyout → the composed
    // chain: geo lead-in, force hill, geo turnaround. (The turnaround's geometry is the
    // hands-on sculpt; here the claim is the three-section mixed chain composed and bakes.)
    await page.locator(".clip-add").click();
    await page.getByRole("menuitem", { name: "Append geometry section" }).click();
    await expect.poll(async () => (await sectionKinds()).join(",")).toBe("0,1,0");
    await expect.poll(tTotal).toBeGreaterThan(0);
    await frameTimeline(page); // append never pans; frame the grown chain into view
    await expect(page.locator(".clip")).toHaveCount(3);
    await page.screenshot({ path: join(OUT, "dogfood-2-chain.png") });
    if (strip) await page.screenshot({ path: join(OUT, "dogfood-3-timeline.png"), clip: strip });
});

// Drive PIN MODE end to end (kex2d-optimize-mode stage 7) — the SANDBOX over the real UI:
// entering opens a sandbox (outer history untouched), in-mode edits + undo/redo live in it,
// undo at its start exits, Exit/Esc discards without trace, downstream sections FREEZE at their
// mode-entry placement, a landed Solve is ONE outer entry whose undo reopens the resumed
// experiment and whose redo re-lands.
test("pin mode flow", async ({ page, boot }) => {
    await boot();

    const forces = () => kexCall(page, "forces");
    const undoDepth = () => kexCall(page, "undoDepth");
    const sandboxDepth = () => kexCall(page, "sandboxDepth");
    const entries = () => kexCall(page, "entries");
    const pinning = () => kexCall(page, "pinning");
    const landing = () => kexCall(page, "landing");
    const lockedCount = () => kexCall(page, "lockedCount");
    const forceSelIds = () => kexCall(page, "forceSelIds");
    const forceCount = () => kexCall(page, "forceCount");
    const forceU = () =>
        kexCall(page, "forceU") as Promise<
            { id: number; section: number; s: number; g: number; u: number }[]
        >;
    const panel = page.locator(".pinpanel");
    const solveBtn = page.locator(".pinpanel .solve");
    const reason = page.locator(".pinpanel .reason");
    const strip = dockStrip(page);
    const sorted = (rows: { s: number; g: number }[]) => [...rows].sort((a, b) => a.s - b.s);

    // ── the viewport dim probe (kex2d-idioms stage 5): read one polyline pixel off the real
    // canvas at a `spanMidAt` point (canvas-local CSS px → device px via the backing-store
    // scale). null when the canvas isn't up or the point is outside it.
    const probe = (pt: { x: number; y: number } | null) =>
        pt === null
            ? Promise.resolve(null)
            : page.evaluate(({ x, y }) => {
                  const canvas = document.querySelector<HTMLCanvasElement>("canvas.viewport");
                  const ctx = canvas?.getContext("2d");
                  if (!canvas || !ctx) return null;
                  const r = canvas.getBoundingClientRect();
                  const px = Math.round((x * canvas.width) / r.width);
                  const py = Math.round((y * canvas.height) / r.height);
                  if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return null;
                  const d = ctx.getImageData(px, py, 1, 1).data;
                  return [d[0], d[1], d[2]] as [number, number, number];
              }, pt);
    // GEO #78a5d6 = (120,165,214); the dim wash rgba(22,20,19,0.55) composites source-over to
    // round(0.45·c + 0.55·w) = (66,85,107). PROBE_TOL 8: compositing rounds ±1 per channel and
    // device-pixel rounding keeps the probe inside the 2px stroke's solid core — while the two
    // registers sit 54 apart on red, so the bands can't overlap. polled, so a cart transit
    // over the point only delays the read.
    const ProbeTol = 8;
    const near = (p: number[] | null, c: [number, number, number]) =>
        p?.every((v, i) => Math.abs(v - c[i]) <= ProbeTol) ?? false;
    const geoMid = () => kexCall(page, "spanMidAt", 1);

    // ── the stage-8 chrome-hold composite (kex2d-idioms): every mid-window claim in ONE
    // batched in-page read (several `__kex` calls inside one evaluate — the sanctioned
    // typed-inline-cast exception), so the asserts fit the 500 ms landing window on the
    // bridge. Returns the violated claims by name (empty = the whole modal presentation
    // holds); `landing` is part of the composite, so every green read describes MID-window
    // state and a too-slow run fails loudly on timing instead of comparing post-window
    // chrome. The pixel leg re-reads `spanMidAt` per attempt (polled — a cart transit over
    // the point only delays the read, the leg-0c/1a probe's own law).
    const chromeHeld = () =>
        page.evaluate(
            ({ tol, dim }) => {
                const kex = (
                    window as unknown as {
                        __kex: {
                            landing(): boolean;
                            spanMidAt(i: number): { x: number; y: number } | null;
                        };
                    }
                ).__kex;
                const bad: string[] = [];
                if (!kex.landing()) bad.push("landing");
                if (document.querySelector(".pinpanel") === null) bad.push("panel");
                const solve = document.querySelector<HTMLButtonElement>(".pinpanel .solve");
                const exit = document.querySelector<HTMLButtonElement>(".pinpanel .exit");
                if (!solve?.disabled) bad.push("solve-disabled");
                if (!exit?.disabled) bad.push("exit-disabled");
                if (document.querySelectorAll(".clip-stripes").length !== 1) bad.push("hatch");
                if (document.querySelectorAll(".mode-dim rect").length === 0) bad.push("mode-dim");
                const pt = kex.spanMidAt(1);
                const canvas = document.querySelector<HTMLCanvasElement>("canvas.viewport");
                const ctx = canvas?.getContext("2d");
                let pixel: Uint8ClampedArray | null = null;
                if (pt && canvas && ctx) {
                    const r = canvas.getBoundingClientRect();
                    const px = Math.round((pt.x * canvas.width) / r.width);
                    const py = Math.round((pt.y * canvas.height) / r.height);
                    if (px >= 0 && py >= 0 && px < canvas.width && py < canvas.height)
                        pixel = ctx.getImageData(px, py, 1, 1).data;
                }
                if (!pixel || !dim.every((c, i) => Math.abs(pixel[i] - c) <= tol))
                    bad.push("viewport-dim");
                return bad;
            },
            { tol: ProbeTol, dim: [66, 85, 107] as [number, number, number] },
        );

    // the bump profile on the boot section: 2 flat seeds + 3 authored keys (crest at index 2) —
    // plus an appended geo section: the lockdown leg's subject AND the downstream-freeze subject.
    await kexCall(page, "seedForceBump");
    await expect.poll(forceCount).toBe(5);
    await kexCall(page, "append", 0); // SectionKind.Geo
    await expect.poll(() => kexCall(page, "sectionCount")).toBe(2);
    await frameTimeline(page);
    const preMode = sorted(await forces()); // the pre-mode draft every discard assert reads
    const base = await undoDepth();
    const entryB0 = (await entries())[1]; // the DOWNSTREAM section's baked entry, pre-mode

    // ── 0b. The keyframe menu carries NO Lock row outside the mode (hidden, not grayed —
    // lock is mode-scoped state and doesn't exist in normal editing). ──
    const preHit = await page.locator(".fhit").nth(2).boundingBox();
    if (!preHit) throw new Error("diamond 2 not laid out");
    await page.mouse.click(preHit.x + preHit.width / 2, preHit.y + preHit.height / 2, {
        button: "right",
    });
    await expect(page.locator(".fmenu")).toBeVisible();
    await expect(page.locator(".fmenu").getByRole("menuitem", { name: "Lock" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(".fmenu")).toHaveCount(0);
    await page.keyboard.press("Escape"); // clear the selection the right-click made
    await expect.poll(async () => (await forceSelIds()).length).toBe(0);

    // ── 0c. Dim probe positive control: frame the viewport (hover routes `f` there; the corner
    // park keeps the pointer off the track so no hover rung tints the read), then the DOWNSTREAM
    // geo span's mid-sample pixel must read the plain geo kind color — proving the rig sees the
    // bright register BEFORE the mode opens, so the dim assert below can't pass vacuously. ──
    const vp = await page.locator("canvas.viewport").boundingBox();
    if (!vp) throw new Error("viewport canvas not laid out");
    await page.mouse.move(vp.x + vp.width * 0.08, vp.y + vp.height * 0.08);
    await page.keyboard.press("f"); // nothing selected → the whole chain frames
    await expect.poll(async () => near(await probe(await geoMid()), [120, 165, 214])).toBe(true);

    // ── 1. Enter through the section menu's Pin row: the docked panel + the striped clip
    // are the mode signal — and the OUTER history is untouched (the sandbox contract: entering
    // records nothing; a fresh, empty sandbox opens instead). ──
    await page.locator(".clip").first().click({ button: "right" });
    await expect(page.locator(".ctxmenu")).toBeVisible();
    await expect(page.locator(".ctxmenu").getByRole("menuitem", { name: "Pin" })).toBeEnabled();
    await clickMenuItem(page, ".ctxmenu", "Pin");
    await expect(panel).toBeVisible();
    await expect.poll(pinning).toBe(true);
    await expect(page.locator(".clip-stripes")).toHaveCount(1);
    expect(await undoDepth()).toBe(base); // NOTHING landed outer
    expect(await sandboxDepth()).toBe(0); // …the sandbox opened empty
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "pin-1-mode.png") });

    // ── 1a. The viewport out-of-scope dim (kex2d-idioms stage 5, editor-ui.md Mode
    // vocabulary): the same span's pixel now reads the dim-washed geo color — the timeline's
    // `.mode-dim` meaning on the viewport, same spans, same channel. ──
    await expect.poll(async () => near(await probe(await geoMid()), [66, 85, 107])).toBe(true);

    // ── 1b. The editing lockdown holds track-wide while the mode is open: another section's
    // Convert/Delete rows gray, the ruler's domain picker grays both rows, the append tail
    // grays. ──
    await expect(page.locator(".clip-add")).toBeDisabled();
    await page.locator(".clip").nth(1).click({ button: "right" }); // the appended GEO clip
    await expect(page.locator(".ctxmenu")).toBeVisible();
    await expect(
        page.locator(".ctxmenu").getByRole("menuitem", { name: "Convert" }),
    ).toBeDisabled();
    await expect(page.locator(".ctxmenu").getByRole("menuitem", { name: "Delete" })).toBeDisabled();
    await page.keyboard.press("Escape"); // peels the menu (the mode stays — layered dismissal)
    await expect(page.locator(".ctxmenu")).toHaveCount(0);
    await page.locator(".rulerzone").click({ button: "right" });
    await expect(page.locator(".rmenu")).toBeVisible();
    await expect(page.locator(".rmenu").getByRole("menuitem", { name: "Meters" })).toBeDisabled();
    await expect(page.locator(".rmenu").getByRole("menuitem", { name: "Seconds" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(page.locator(".rmenu")).toHaveCount(0);
    expect(await pinning()).toBe(true); // both menus peeled without touching the mode

    // ── 2. An in-mode edit lands in the SANDBOX (outer untouched), downstream FREEZES at its
    // mode-entry placement, in-mode undo/redo walk the sandbox, undo at its start EXITS, and
    // nothing is redoable after — no trace. ──
    const crestHit = await page.locator(".fhit").nth(2).boundingBox();
    if (!crestHit) throw new Error("crest hit target not laid out");
    await page.mouse.click(crestHit.x + crestHit.width / 2, crestHit.y + crestHit.height / 2);
    await expect.poll(async () => (await forceSelIds()).length).toBe(1);
    await page.keyboard.press("ArrowUp"); // one press = one sandbox entry (NUDGE_G)
    await expect.poll(async () => sorted(await forces())[2].g).not.toBe(preMode[2].g);
    expect(await undoDepth()).toBe(base); // the OUTER stack stood still
    expect(await sandboxDepth()).toBe(1); // the sandbox took the edit
    // the downstream freeze: the edit moved the pinning exit, but the next section's baked
    // entry is BYTE-STABLE at its mode-entry value (no live repropagation — the gap is the
    // residual made visible).
    const entryB1 = (await entries())[1];
    expect(entryB1.x).toBe(entryB0.x);
    expect(entryB1.y).toBe(entryB0.y);
    expect(entryB1.theta).toBe(entryB0.theta);
    expect(entryB1.v).toBe(entryB0.v);

    await page.keyboard.press("Control+z"); // in-mode undo: the sandbox, not the outer stack
    await expect.poll(async () => sorted(await forces())[2].g).toBe(preMode[2].g);
    expect(await pinning()).toBe(true); // still in the mode
    expect(await undoDepth()).toBe(base);
    await page.keyboard.press("Control+Shift+z"); // in-mode redo replays it
    await expect.poll(async () => sorted(await forces())[2].g).not.toBe(preMode[2].g);
    expect(await pinning()).toBe(true);
    await page.keyboard.press("Control+z"); // back off again
    await expect.poll(async () => sorted(await forces())[2].g).toBe(preMode[2].g);
    await page.keyboard.press("Control+z"); // at the sandbox's start → acts as EXIT
    await expect.poll(pinning).toBe(false);
    await expect(panel).toHaveCount(0);
    expect(sorted(await forces())).toEqual(preMode);
    expect(await undoDepth()).toBe(base);
    await page.keyboard.press("Control+Shift+z"); // no trace: nothing to redo
    await expect.poll(pinning).toBe(false);
    expect(sorted(await forces())).toEqual(preMode);
    // unfrozen on close: downstream repropagates — the draft was restored, so it lands where
    // it started.
    const entryB2 = (await entries())[1];
    expect(entryB2.x).toBe(entryB0.x);
    expect(entryB2.y).toBe(entryB0.y);

    // the Esc path is the same discard: re-enter, edit, Esc peels selection, Esc discards.
    await page.locator(".clip").first().click({ button: "right" });
    await clickMenuItem(page, ".ctxmenu", "Pin");
    await expect(panel).toBeVisible();
    // a DIFFERENT diamond than leg 2's crest: a second left press on the same diamond within
    // FDBL_MS is the double-press handle-edit summon BY DESIGN, and the flow's own pace can
    // land two same-diamond clicks under that window (root-caused live: the summon added an
    // extra Esc rung and the discard assert read one rung early).
    const shoulder = await page.locator(".fhit").nth(1).boundingBox();
    if (!shoulder) throw new Error("shoulder not laid out");
    await page.mouse.click(shoulder.x + shoulder.width / 2, shoulder.y + shoulder.height / 2);
    await expect.poll(async () => (await forceSelIds()).length).toBe(1);
    await page.keyboard.press("ArrowUp");
    await expect.poll(async () => sorted(await forces())[1].g).not.toBe(preMode[1].g);
    await page.keyboard.press("Escape"); // peels the selection first
    await expect.poll(async () => (await forceSelIds()).length).toBe(0);
    expect(await pinning()).toBe(true);
    await page.keyboard.press("Escape"); // the outermost rung: Exit = discard
    await expect.poll(pinning).toBe(false);
    expect(sorted(await forces())).toEqual(preMode);
    expect(await undoDepth()).toBe(base);

    // ── 3. Lock gating (pure counting): lock 3 of 5 → 2 free, Solve starves and the reason
    // shows; an in-mode-added key defaults FREE and re-arms it; delete + unlock restore. ──
    await page.locator(".clip").first().click({ button: "right" });
    await clickMenuItem(page, ".ctxmenu", "Pin");
    await expect(panel).toBeVisible();
    const hit = async (i: number) => {
        const b = await page.locator(".fhit").nth(i).boundingBox();
        if (!b) throw new Error(`diamond ${i} not laid out`);
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };
    const p1 = await hit(1);
    await page.mouse.click(p1.x, p1.y);
    await page.keyboard.down("Shift");
    const p2 = await hit(2);
    await page.mouse.click(p2.x, p2.y);
    const p3 = await hit(3);
    await page.mouse.click(p3.x, p3.y);
    await page.keyboard.up("Shift");
    await expect.poll(async () => (await forceSelIds()).length).toBe(3);
    await page.keyboard.press("q"); // the lock gesture (Q — one hand mouses, the other locks)
    await expect.poll(lockedCount).toBe(3);
    await expect(solveBtn).toBeDisabled(); // starved below MIN_FREE — pure counting
    await expect(reason).toHaveText("Needs 3 free keys");
    await page.waitForTimeout(SHOT_MS);
    if (strip) await page.screenshot({ path: join(OUT, "pin-2-locked.png"), clip: strip });

    // an in-mode-added key is free by construction: Solve re-arms and the reason clears —
    // and the surviving headless force authoring command lands in the SANDBOX. Free chart-area
    // insertion was removed in S4, so select the resulting diamond explicitly before Delete.
    const addedId = await kexCall(page, "placeForce", 8.4, 1);
    await expect.poll(forceCount).toBe(6);
    expect(addedId).toBeGreaterThan(0);
    expect(await sandboxDepth()).toBe(1); // the create is a sandbox entry
    expect(await undoDepth()).toBe(base); // …not an outer one
    await expect(solveBtn).toBeEnabled();
    await expect(reason).toHaveCount(0);
    const addedRow = (await forceU()).find((row) => row.id === addedId);
    const addedClip = await page.locator(".clip").first().boundingBox();
    const [, addedPxPerU] = await kexCall(page, "xView");
    if (!addedRow || !addedClip) throw new Error("sandbox force key not laid out");
    const addedHit = await page.locator(".fhit").evaluateAll(
        (els, x) => {
            const points = els.map((el) => {
                const r = el.getBoundingClientRect();
                return r.x + r.width / 2;
            });
            return points
                .map((point, index) => ({ index, distance: Math.abs(point - x) }))
                .sort((a, b) => a.distance - b.distance)[0]?.index;
        },
        addedClip.x + addedRow.s * addedPxPerU,
    );
    if (addedHit === undefined) throw new Error("sandbox force key has no hit target");
    const added = await hit(addedHit);
    await page.mouse.click(added.x, added.y);
    await expect.poll(async () => (await forceSelIds()).length).toBe(1);
    await page.keyboard.press("Delete"); // explicit selection; Del removes it again
    await expect.poll(forceCount).toBe(5);
    expect(await sandboxDepth()).toBe(2);
    await expect(solveBtn).toBeDisabled();
    // unlock: the same three members, Q on an all-locked set unlocks it.
    const q1 = await hit(1);
    await page.mouse.click(q1.x, q1.y);
    await page.keyboard.down("Shift");
    const q2 = await hit(2);
    await page.mouse.click(q2.x, q2.y);
    const q3 = await hit(3);
    await page.mouse.click(q3.x, q3.y);
    await page.keyboard.up("Shift");
    await page.keyboard.press("q");
    await expect.poll(lockedCount).toBe(0);
    await expect(solveBtn).toBeEnabled();

    // the menu path to the same toggle (mode-only row, the mouse twin of Q): the row reads the
    // selection's state — Lock on a free key, Unlock once it's locked. clear the 3-member set
    // first so the right-click replace-selects one subject.
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await forceSelIds()).length).toBe(0);
    const m1 = await hit(1);
    await page.mouse.click(m1.x, m1.y, { button: "right" });
    await expect(page.locator(".fmenu")).toBeVisible();
    await clickMenuItem(page, ".fmenu", "Lock");
    await expect.poll(lockedCount).toBe(1);
    await page.mouse.click(m1.x, m1.y, { button: "right" });
    await expect(page.locator(".fmenu")).toBeVisible();
    await clickMenuItem(page, ".fmenu", "Unlock");
    await expect.poll(lockedCount).toBe(0);

    // ── 4. A REFUSED solve through the real gate: flatten the crest to 1 g via the popover
    // (the draft goes exactly straight — the conditioning certificate), Solve → the refusal
    // stays in-mode with the draft untouched, its readout on the shared notice. ──
    await page.keyboard.press("Escape"); // clear the selection — a member click would PROMOTE
    await expect.poll(async () => (await forceSelIds()).length).toBe(0);
    const crestTargetIndex = 2;
    await page
        .locator(".fhit")
        .nth(crestTargetIndex)
        .click({ position: { x: 6, y: 6 } });
    await expect.poll(async () => (await forceSelIds()).length).toBe(1);
    const crestId = (await forceSelIds())[0];
    await expect.poll(async () => (await forces()).find((row) => row.id === crestId)?.g).toBe(0);
    await expect(page.locator(".ptip")).toBeVisible();
    const gField = page.locator('.ptip input[aria-label="Point force (g)"]');
    await expect(gField).toBeEnabled(); // the pinning section's own fields stay live in-mode
    await gField.fill("1");
    await gField.press("Enter");
    await expect.poll(async () => (await forces()).find((row) => row.id === crestId)?.g).toBe(1);
    expect(await sandboxDepth()).toBe(3); // the popover edit is a sandbox entry
    const flattened = sorted(await forces());
    await solveBtn.click();
    // the refusal rides the app's shared transient notice, top-center, in the error register
    // (stage-7 fourth check-in) — the panel carries no refusal line.
    await expect(page.locator(".notice.bad")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".notice.bad")).toContainText("can't steer the exit.");
    await expect(reason).toHaveCount(0); // the panel line is the starved reason only, and Solve is armed
    expect(await pinning()).toBe(true); // a refusal is not an exit
    expect(sorted(await forces())).toEqual(flattened); // …and writes nothing
    expect(await undoDepth()).toBe(base); // …anywhere
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "pin-3-refusal.png") });

    // ── 5. A landed solve: undo the flatten (in-mode), make a real edit, Solve → ONE outer
    // entry, the mode closes, the PACED LANDING is the feedback (no stats toast). ──
    await page.keyboard.press("Control+z");
    await expect.poll(async () => sorted(await forces())[2].g).toBe(preMode[2].g);
    expect(await sandboxDepth()).toBe(2); // in-mode undo popped it (redo clears on the next edit)
    const nudgeRow = (await forceU()).find((row) => row.id === crestId);
    const nudgeClip = await page.locator(".clip").first().boundingBox();
    const [, nudgePxPerU] = await kexCall(page, "xView");
    if (!nudgeRow || !nudgeClip) throw new Error("crest force key not laid out after undo");
    const nudgeTargetIndex = await page.locator(".fhit").evaluateAll(
        (els, x) => {
            const points = els.map((el) => {
                const r = el.getBoundingClientRect();
                return r.x + r.width / 2;
            });
            return points
                .map((point, index) => ({ index, distance: Math.abs(point - x) }))
                .sort((a, b) => a.distance - b.distance)[0]?.index;
        },
        nudgeClip.x + nudgeRow.s * nudgePxPerU,
    );
    if (nudgeTargetIndex === undefined)
        throw new Error("crest force key has no hit target after undo");
    await page
        .locator(".fhit")
        .nth(nudgeTargetIndex)
        .click({ position: { x: 6, y: 6 } });
    await expect.poll(async () => (await forceSelIds()).length).toBe(1);
    const nudgeId = (await forceSelIds())[0];
    await page.keyboard.press("ArrowUp");
    await expect
        .poll(async () => (await forces()).find((row) => row.id === nudgeId)?.g)
        .not.toBe(preMode[2].g);
    expect(await sandboxDepth()).toBe(3); // one press = one sandbox entry
    // …and the SECOND press needs a frame between it and the first, because the force nudge
    // resolves its base value from `forcePts` — the per-RAF PROJECTION, not the authored `Force`
    // component (`Timeline.svelte`'s `onKey`, the `nudgeKeyframes(members, ds, dv)` arm). Back to back,
    // press 2 reads press 1's pre-value, rounds to the same grid point, writes the value already
    // there, and `commit` records a no-op: measured g held at 0.05 with `sandboxDepth` stuck at 3
    // for 40 further frames (never late — absorbed), 1-in-4 to 7-in-8 of runs depending on pace,
    // at `KEX_WORKERS=1`. That is the same class the GEO nudge already fixed by resolving from
    // authored state (kex2d/AGENTS.md, Append/Delete: "back-to-back presses no longer need a settle
    // between them to land correctly") and it is a PRODUCT defect on the force side, reported not
    // repaired here — this flow's subject is the sandbox, so it waits the frame the app needs and
    // then PINS the second entry, which is the positive control the vacuous
    // `g !== preMode[2].g` poll below never was (it is already true from press 1).
    await frames(page, 1);
    await page.keyboard.press("ArrowUp");
    await expect.poll(sandboxDepth).toBe(4); // two presses = two entries — press 2 really landed
    await solveBtn.click();
    await expect.poll(pinning, { timeout: 30_000 }).toBe(false); // Solve confirms AND closes
    await expect.poll(landing).toBe(true); // the paced landing raised — the feedback
    // ── 5a. The landing HOLDS the modal chrome (kex2d-idioms stage 8): mid-window the panel
    // stays mounted with both actions disabled (the settling state), the subject clip keeps
    // its hatch, the timeline dim brackets, and the viewport dim wash all hold — the modal
    // presentation releases in ONE moment at window end or skip, never at the mode close.
    await expect.poll(chromeHeld).toEqual([]);
    // no stats toast — the animation IS the feedback. leg 4's refusal notice may still be
    // auto-dismissing, so the pin is register-shaped: no non-error (done-register) notice.
    await expect(page.locator(".notice:not(.bad)")).toHaveCount(0);
    expect(await undoDepth()).toBe(base + 1); // the WHOLE experiment is ONE outer entry

    // ── 5b. The landing is DISPLAY-WIDE (kex2d-idioms stage 4): mid-window the bake rides the
    // interpolant — the viewport crest marker sits off its final placement (compared after the
    // re-land, below) — and the downstream section's baked entry HOLDS at its frozen mode-entry
    // value while the gap eases shut (bit-stable, the same read leg 2 pinned under the freeze).
    // both reads then re-assert the landing is STILL live, so a too-slow run fails loudly on
    // timing instead of silently comparing post-window state.
    const midMarker = await kexCall(page, "forceMarkerAt", 2);
    if (!midMarker) throw new Error("crest marker not baked during the landing");
    const entryMid = (await entries())[1];
    expect(await landing()).toBe(true); // both reads landed inside the window
    expect(entryMid.x).toBe(entryB0.x); // the freeze held through the mode close
    expect(entryMid.y).toBe(entryB0.y);
    expect(entryMid.theta).toBe(entryB0.theta);
    expect(entryMid.v).toBe(entryB0.v);

    // ── 6. Undo DURING the landing invalidates it AND reopens the mode with the experiment
    // RESUMED (sandbox restored: create, delete, flatten-undone, 2 nudges → 4 entries); walking
    // the sandbox out exits at its start with the pre-mode draft; redo then RE-LANDS. ──
    await page.keyboard.press("Control+z");
    await expect.poll(landing).toBe(false); // invalidated by the undo route, not left to expire
    await expect.poll(pinning).toBe(true); // the experiment resumed
    expect(await sandboxDepth()).toBe(4); // create, delete, nudge 1, nudge 2 — all undoable again
    expect(await undoDepth()).toBe(base); // the landing sits on the outer REDO
    await page.keyboard.press("Control+z"); // nudge 2
    await page.keyboard.press("Control+z"); // nudge 1
    await page.keyboard.press("Control+z"); // the deleted key returns
    await page.keyboard.press("Control+z"); // the created key leaves
    await expect.poll(sandboxDepth).toBe(0);
    expect(await pinning()).toBe(true); // still inside the mode
    await page.keyboard.press("Control+z"); // at the sandbox's start → exits
    await expect.poll(pinning).toBe(false);
    await expect
        .poll(async () => JSON.stringify(sorted(await forces())))
        .toBe(JSON.stringify(preMode));
    expect(await undoDepth()).toBe(base);
    await page.keyboard.press("Control+Shift+z"); // the outer redo holds the landing → RE-LANDS
    await expect.poll(pinning).toBe(false);
    await expect.poll(undoDepth).toBe(base + 1);
    // the display-wide landing's other half (5b): the settled final marker differs from the
    // mid-window read — the viewport geometry really was mid-flight during the window (under a
    // snap-to-final bake the two reads are byte-equal and this poll times out).
    await expect
        .poll(async () => {
            const m = await kexCall(page, "forceMarkerAt", 2);
            return m !== null && (m.x !== midMarker.x || m.y !== midMarker.y);
        })
        .toBe(true);
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "pin-4-landed.png") });

    // ── 7. A skip releases the WHOLE chrome in one moment (kex2d-idioms stage 8): re-enter,
    // nudge the crest, Solve → the settling chrome holds mid-window (the same composite);
    // a pointerdown then skips the landing, and the panel, hatch, timeline dim, and viewport
    // dim all drop together with the display snapped to the document's own values. ──
    await page.locator(".clip").first().click({ button: "right" });
    await expect(page.locator(".ctxmenu")).toBeVisible();
    await clickMenuItem(page, ".ctxmenu", "Pin");
    await expect(panel).toBeVisible();
    const g7 = sorted(await forces())[2].g;
    const c7 = await hit(2);
    await page.mouse.click(c7.x, c7.y);
    await expect.poll(async () => (await forceSelIds()).length).toBe(1);
    await page.keyboard.press("ArrowUp");
    await expect.poll(async () => sorted(await forces())[2].g).not.toBe(g7);
    await solveBtn.click();
    await expect.poll(pinning, { timeout: 30_000 }).toBe(false);
    await expect.poll(chromeHeld).toEqual([]); // held mid-window (positive control for the skip)
    await page.mouse.click(vp.x + vp.width * 0.06, vp.y + vp.height * 0.06); // pointerdown = skip
    await expect.poll(landing).toBe(false);
    await expect(panel).toHaveCount(0); // …and the whole presentation released with it
    await expect(page.locator(".clip-stripes")).toHaveCount(0);
    await expect(page.locator(".mode-dim")).toHaveCount(0);
    await expect.poll(async () => near(await probe(await geoMid()), [120, 165, 214])).toBe(true);
    expect(await undoDepth()).toBe(base + 2); // the second experiment is one more outer entry
});

// Convert (`D`), Pin (`P`), Solve (`Enter`, mode-scoped), and Reset (`R`) — the section menu's own
// remaining keyboard bindings (`kex2d-shortcuts` stages 3 + 4), fired through the real DOM rather
// than a menu click: `D`/`P` dispatch through `App.svelte`'s own permanent listener (the merged
// chrome + document acts record, Locked decision 2 — `solve`/`solveShape`/`pinEnter` are chrome, so a
// source census alone can't prove the wiring reaches them; only the real keydown can). `Enter`
// reuses `BINDINGS.append`'s own literal outside the mode — the mode-scoped exception (law 3)
// only claims it once `editor.pinning` is actually open, which is what makes it unambiguous in
// fact (the lockdown bars geo append the whole time a session is live). `R` is a plain document act
// (`controls.ts`, no chrome merge needed) — its own enablement is computed FRESH off the keydown's
// own subject (`editor.section`), never off the menu's tick-derived reading (the exact shape stage
// 3's own defect took: `canSolve`/`canSolveShape`/`canPin` read `ctx.section`, the open context
// menu's subject, so they stayed `null` on every keyboard-only path — Live log). The click-driven
// paths for the same acts are covered elsewhere ("invoked solve flow", "pin mode flow"); this
// flow's own job is proving the KEYBOARD path reaches the identical acts, not re-proving what
// they do once invoked.
test("Convert/Pin/Solve/Reset keyboard bindings flow", async ({ page, boot }) => {
    await boot();

    const kinds = () => kexCall(page, "sectionKinds");
    const pinning = () => kexCall(page, "pinning");
    const undoDepth = () => kexCall(page, "undoDepth");
    const tTotal = () => kexCall(page, "tTotal");
    const scrim = page.locator(".scrim");
    const panel = page.locator(".pinpanel");

    await kexCall(page, "seedForceBump"); // the boot section: force, 5 keys, all free (≥ MIN_FREE)
    const tSeeded = await tTotal();
    await kexCall(page, "append", 0); // SectionKind.Geo — `D` needs a live Convert target too
    await expect.poll(async () => (await kinds()).join(",")).toBe("1,0");
    await frameTimeline(page);
    // every key below is gated on `bakeLive` (`track.ts`: the bake's hash equals the AUTHORED
    // hash), which the append invalidates until the bake actually re-runs — and a key that arrives
    // before it is a silent no-op, not a late one: `D` simply opens no modal. A fixed frame count
    // stood here and read as enough at ~700 ms per isolated run, but the appended section being IN
    // the bake is a CONDITION (`kex2d-harness.md`: a count is never bake-readiness, and the honest
    // wait is the bake output changing) — the same `tTotal` condition the wash flow's own append
    // uses. Measured once in 9 full runs at `KEX_WORKERS=1`: `.scrim` never appeared after `d`.
    await expect.poll(tTotal).not.toBe(tSeeded); // the appended section is IN the bake
    await frames(page, 1);

    // ── `D` — Convert on the geo section: select it, press `D`, the same modal a click on the
    // row opens (`invoked solve flow`'s own step 2) comes up; Escape cancels, the row's own
    // dismissal. ──
    const selected = () => kexCall(page, "selectedSection");

    await page.locator(".clip").nth(1).click(); // the appended geo section
    await expect.poll(selected).toBe(1); // wait for the appended section's selection to actually land
    const geoId = await selected();
    await frames(page, 1);
    await page.keyboard.press("d");
    await expect(scrim).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(scrim).toHaveCount(0);

    // ── `P` — Pin, on the force section: select it, press `P`, the docked panel comes up —
    // the same mode a click on the row opens (`pin mode flow`'s own step 1). ──
    await page.locator(".clip").first().click();
    await expect.poll(async () => (await selected()) !== geoId).toBe(true); // selection settled
    await page.keyboard.press("p");
    await expect(panel).toBeVisible();
    await expect.poll(pinning).toBe(true);

    // ── `Enter` — Solve, mode-scoped: fires the mode's own Solve action, never the unscoped
    // `append` binding it shares the literal with (nothing here is even geo, so `add` has no
    // live target regardless — the belt, not the buckle: the mode itself is the buckle). Nothing
    // was edited, so this is a zero-drift Solve — it still lands as ONE outer entry (the mode's
    // own law: a zero-drift Solve still closes and the transition sits on the stack). ──
    const base = await undoDepth();
    await page.keyboard.press("Enter");
    await expect.poll(pinning, { timeout: 30_000 }).toBe(false);
    expect(await undoDepth()).toBe(base + 1);

    // ── `R` — Reset, on the SAME force section, no menu open: re-selecting it fresh (the mode
    // just closed) and pressing `R` reseeds it kind-held to its own default — the two
    // continuation keyframes — collapsing `seedForceBump`'s airtime bump straight back down. This
    // is the keyboard path stage 3's own defect took (Live log): `sectionKeyAct`'s `canReset` is
    // computed fresh off `editor.section` in `controls.ts`, never off a context menu's own
    // tick-derived reading, so this step is dead on arrival if that wiring regresses. ──
    const forceCounts = () => kexCall(page, "sectionForceCounts");
    await page.locator(".clip").first().click();
    await expect.poll(selected).not.toBeNull();
    const beforeReset = (await forceCounts())[0];
    expect(beforeReset).toBeGreaterThan(2); // seedForceBump's bump: more than the 2-key default
    await page.keyboard.press("r");
    await expect.poll(async () => (await forceCounts())[0]).toBe(2);
});

// T1's summoned creation: right-click on the velocity-strip header band → context menu →
// "Add velocity strip" → the strip appears at the clicked station at minimum extent, selected.
// Empty band space is inert (no create-drag — the rescope that retired C5's rejected idiom).
// Deletion is the same menu on an existing strip, plus Delete on selection.
test("velocity strip creation flow", async ({ page, boot }) => {
    await boot();
    await seedHill(page);
    await frameTimeline(page);

    const stripsOf = () => kexCall(page, "stripsOf", 0);
    const undoDepth = () => kexCall(page, "undoDepth");

    // right-click on the band → the strip creation menu
    const bandBb = await page.locator(".hbandzone").boundingBox();
    const clipBb = await page.locator(".clip").first().boundingBox();
    if (!bandBb || !clipBb) throw new Error("header band / clip not laid out");
    const y = bandBb.y + bandBb.height / 2;
    const x = clipBb.x + clipBb.width * 0.3;
    await page.mouse.click(x, y, { button: "right" });
    await expect(page.locator(".smenu")).toBeVisible();
    await expect(
        page.locator(".smenu").getByRole("menuitem", { name: "Add velocity strip" }),
    ).toBeEnabled();
    await clickMenuItem(page, ".smenu", "Add velocity strip");

    // the strip appears at minimum extent, selected — `seed()` (S3) no longer carries its own
    // start strip on this section (the track-start one-shot is a distinct point kind, no
    // `Strip` row), so the count goes 0 → 1.
    await expect.poll(async () => (await stripsOf()).length).toBe(1);
    await expect.poll(async () => await kexCall(page, "selectedStrip")).not.toBe(null);

    // Delete on selection removes it — 1 → 0.
    const before = await undoDepth();
    await page.keyboard.press("Delete");
    await expect.poll(async () => (await stripsOf()).length).toBe(0);
    await expect.poll(undoDepth).toBe(before + 1);

    // undo restores it
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await stripsOf()).length).toBe(1);
});

// T2: velocity strip keyframe editing in the graph. A selected strip's velocity curve
// draws solid over its extent. Double-click over the strip's extent creates a velocity
// keyframe; the keyframe appears as a diamond in the velocity channel. The keyframe is
// draggable in both axes (s, v) and deletable via the Delete key. This flow covers the
// full editing gesture through REAL POINTER EVENTS (not the __kex hook) — a behaviour
// change owes the capture flow that performs the interaction (checks.md: an interaction
// affordance is only visible to an instrument that performs the interaction).
test("velocity strip keyframe editing flow", async ({ page, boot }) => {
    await boot();
    await seedHill(page);
    await frameTimeline(page);

    const stripsOf = () => kexCall(page, "stripsOf", 0);
    const stripKeyframesOf = (id: number) => kexCall(page, "stripKeyframesOf", id);
    const undoDepth = () => kexCall(page, "undoDepth");
    const xView = () => kexCall(page, "xView");
    const vRange = () => kexCall(page, "vRange");
    const stripKfPx = () => kexCall(page, "stripKfPx");

    // create a strip first (right-click on the band → Add velocity strip). `seed()` (S3)
    // carries no strip of its own (the track-start one-shot is a distinct point kind), so the
    // count goes 0 → 1, and the NEW strip is addressed by id, never index 0 (the created
    // strip's `start = 0` sorts first).
    const beforeStrips = (await stripsOf()) as { id: number }[];
    const bandBb = await page.locator(".hbandzone").boundingBox();
    const clipBb = await page.locator(".clip").first().boundingBox();
    if (!bandBb || !clipBb) throw new Error("header band / clip not laid out");
    const bandY = bandBb.y + bandBb.height / 2;
    const bandX = clipBb.x + clipBb.width * 0.3;
    await page.mouse.click(bandX, bandY, { button: "right" });
    await expect(page.locator(".smenu")).toBeVisible();
    await clickMenuItem(page, ".smenu", "Add velocity strip");
    await expect.poll(async () => (await stripsOf()).length).toBe(beforeStrips.length + 1);
    await expect.poll(async () => await kexCall(page, "selectedStrip")).not.toBe(null);

    // S4: creation seeds two keyframes at start/end, sized to the min-extent strip's own
    // width — a dblclick at the strip's midpoint would land on a diamond's own hit area
    // rather than empty curve. `seededIds` names the two so the CREATE step below can
    // find the genuinely-new keyframe among the (now three) rows.
    const beforeIds = new Set(beforeStrips.map((s) => s.id));
    const created = ((await stripsOf()) as { id: number }[]).find((s) => !beforeIds.has(s.id));
    if (!created) throw new Error("newly-created strip not found");
    const stripId0 = created.id;
    const seededIds = new Set(
        (
            (await stripKeyframesOf(stripId0)) as {
                id: number;
                s: number;
                v: number;
            }[]
        ).map((k) => k.id),
    );
    expect(seededIds.size).toBe(2);

    // Widen the strip via a REAL pointer edge-drag on its end. Non-sticking (S4, boundary
    // ride deleted): the resize does NOT carry the seeded end keyframe, but the strip's
    // own extent records the new edge, so the midpoint below (computed from start/end)
    // clears both diamonds by construction, not by tuning a smaller hit radius.
    // `stripPx`'s x0/x1 are CANVAS-local (like `ghostPx`, unlike the page-absolute
    // `stripKfPx`), so the chart canvas's own rect supplies the page offset.
    const chartCanvasBb = await page.locator("canvas.chart").boundingBox();
    if (!chartCanvasBb) throw new Error("chart canvas not laid out");
    const spBefore = (
        (await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[]
    ).find((s) => s.id === stripId0);
    if (!spBefore) throw new Error("created strip has no band px");
    const edgePx = chartCanvasBb.x + spBefore.x1;
    await page.mouse.move(edgePx, bandY);
    await page.mouse.down();
    await page.mouse.move(edgePx + 80, bandY, { steps: 5 });
    await page.mouse.up();

    // read the strip's (now widened) extent and the chart view to compute pixel positions —
    // by id (`stripId0`), never index 0 (the launch strip's own `start = 0` sorts first).
    const strip = (
        (await stripsOf()) as { id: number; start: number; end: number; value: number }[]
    ).find((s) => s.id === stripId0);
    if (!strip) throw new Error("widened strip not found");
    const [, pxPerU] = await xView();
    const [vLo, vHi] = await vRange();

    // compute the strip's center pixel position on the chart — the clip's pixel extent
    // maps linearly to the section's arclength (Distance domain, the default), so
    // stripCenterPx = clipBb.x + ((strip.start + strip.end) / 2) * pxPerU
    const stripMidS = (strip.start + strip.end) / 2;
    const stripCenterPx = clipBb.x + stripMidS * pxPerU;
    const stripWidthPx = (strip.end - strip.start) * pxPerU;

    // MEASUREMENT: the widened strip's pixel width, well clear of the ~80 px edge-drag
    // above plus the min-extent floor it started from — this reading checks the
    // dblclick's midpoint target lands inside it, not on a seeded diamond's own hit area.
    expect(stripWidthPx).toBeGreaterThan(60);

    // compute a y pixel for the strip's value (velocity) — the constant-when-no-keyframes
    // line is drawn at vOf(strip.value), so double-clicking there creates a keyframe at
    // that velocity. Derived from the chart's own row (`CHART_TOP`/`CHART_BOT_PAD`, `vOf`'s
    // own formula in Timeline.svelte), never a fractional guess at `dockBb.height` — a
    // fixed 0.7 heuristic read as "somewhere mid-chart" until S3 grew the header band
    // (`CHART_TOP`) and pushed that fixed pixel outside the chart's own dblclick zone, missing
    // the create entirely (`stripKeyframesOf(...).length` stayed 0 — the false-hit-region
    // read this replaces).
    const dockBb = await page.locator(".dock .body").boundingBox();
    if (!dockBb) throw new Error("dock body not laid out");
    const chartTop = dockBb.y + CHART_TOP;
    const chartBot = dockBb.y + dockBb.height - CHART_BOT_PAD;
    const vToY = (v: number): number =>
        chartTop + (1 - (v - vLo) / (vHi - vLo)) * (chartBot - chartTop);
    const stripValueY = vToY(strip.value);

    // CREATE: double-click over the strip's extent to create a velocity keyframe — the
    // strip already carries its two seeded keyframes (S4), so this lands a THIRD row.
    await page.mouse.dblclick(stripCenterPx, stripValueY);
    await expect.poll(async () => (await stripKeyframesOf(strip.id)).length).toBe(3);

    // DRAG: drag the newly-created keyframe (not one of the two seeded ones) via real
    // pointer events. Use a Playwright locator on the keyframe diamond's aria-label to
    // find it, then drag it by a fixed pixel offset (the v-axis is inverted: down =
    // higher v).
    let kfs = (await stripKeyframesOf(strip.id)) as { id: number; s: number; v: number }[];
    const kf0 = kfs.find((k) => !seededIds.has(k.id));
    if (!kf0) throw new Error("no newly-created keyframe found");
    // poll for the SPECIFIC newly-created keyframe's diamond, not just any diamond — the
    // seeded keyframes are already drawn, so a bare length > 0 passes before the new one's
    // $derived (read through the per-RAF tick) has propagated to `stripKfPx` (the same race
    // the sibling flow at line ~1883 fixed).
    await expect
        .poll(async () => {
            const px = (await stripKfPx()) as { id: number; x: number; y: number }[];
            return px.find((k) => k.id === kf0.id) ?? null;
        })
        .not.toBeNull();
    const kfPx = (await stripKfPx()) as { id: number; x: number; y: number }[];
    const kf0Px = kfPx.find((k) => k.id === kf0.id);
    if (!kf0Px) throw new Error("the created keyframe has no drawn diamond");

    // use the raw pixel position from the hook (projected exactly as drawn)
    await page.mouse.move(kf0Px.x, kf0Px.y);
    await page.mouse.down();
    await page.mouse.move(kf0Px.x, kf0Px.y + 40, { steps: 5 });
    await page.mouse.up();

    // verify the drag moved the keyframe (its v should have changed)
    await expect
        .poll(async () => {
            kfs = (await stripKeyframesOf(strip.id)) as { id: number; s: number; v: number }[];
            return kfs.find((k) => k.id === kf0.id)?.v;
        })
        .not.toBe(kf0.v);

    // DELETE: the keyframe is already selected (the drag selected it); press Delete.
    // Delete acts on the innermost selection (the keyframe), so the strip must SURVIVE
    // — the bare `stripKeyframesOf(...).length === 2` below (back to the two seeded rows)
    // would also pass if Delete destroyed the whole strip and it got re-seeded some other
    // way, so the `stripsOf().length` poll (launch strip + created strip, both surviving) is
    // the discriminating half. Witnessed red: with the keydown handler perturbed to
    // deleteSelectedStrip() instead of deleteSelectedStripKf(), this poll reds — the created
    // strip is destroyed, so stripsOf() drops by one instead of holding steady.
    await page.keyboard.press("Delete");
    await expect.poll(async () => (await stripKeyframesOf(strip.id)).length).toBe(2);
    await expect.poll(async () => (await stripsOf()).length).toBe(beforeStrips.length + 1);

    // undo restores the deleted keyframe
    const before = await undoDepth();
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await stripKeyframesOf(strip.id)).length).toBe(3);
    await expect.poll(undoDepth).toBe(before - 1);
});

// S5: assert the real typed-field popover call site against the containment-aware set-level
// `multi()` predicate. Setup writes only authored fixtures through the DEV hook; the three selection
// transitions below are real pointer events on the rendered `.fhit` circles, with a keyboard Escape
// rung between the second and third. The first `.ptip` assertion expects count 0 for the genuine
// force-point + strip-keyframe cross-kind set; the final `.ptip` assertion expects visibility after
// Escape and a plain click replace it with its owning strip + keyframe containment pair. Mutating
// the guard back to `editor.stripKfs.ids.size > 1` reds that first assertion; the final assertion is
// the owning-pair positive control. The over-broad containment exclusion in `multi()` is armed by
// the unit contrast `tests/editor.test.ts` test named `a keyframe with a non-owning strip reads multi`.
test("strip keyframe popover follows set-level multi context", async ({ page, boot }) => {
    await boot();
    await seedHill(page);
    await frameTimeline(page);

    const stripKeyframesOf = (id: number) => kexCall(page, "stripKeyframesOf", id);
    const stripsOf = () => kexCall(page, "stripsOf", 0);
    const sectionCount = () => kexCall(page, "sectionCount");
    const tTotal = () => kexCall(page, "tTotal");

    const stripId = (await kexCall(page, "addStripAt", 0, 8, 5)) as number;
    await kexCall(page, "placeStripKf", stripId, 4, 8);
    await expect.poll(async () => (await stripKeyframesOf(stripId)).length).toBe(3);

    const beforeTotal = await tTotal();
    await kexCall(page, "append", 1); // add a force section with its seeded force points
    await expect.poll(sectionCount).toBe(2);
    await expect.poll(async () => (await tTotal()) !== beforeTotal).toBe(true);
    await frameTimeline(page);

    const velocityKeyframes = page.locator('.fhit[aria-label="Velocity keyframe"]');
    const velocityKeyframe = velocityKeyframes.nth(1);
    const forcePoint = page.locator('.fhit[aria-label="Force point"]');
    await expect(velocityKeyframes).toHaveCount(3);
    await expect(forcePoint).toHaveCount(2);

    // First establish the genuine cross-kind selection through pointer events. Shift-clicking the
    // velocity keyframe also keeps its owning strip, but that containment member is not a subject.
    await forcePoint.first().click();
    await velocityKeyframe.click({ modifiers: ["Shift"] });
    await expect(page.locator(".nodemenu")).toHaveCount(0);
    await expect(page.locator(".ptip")).toHaveCount(0);
    await expect.poll(async () => (await kexCall(page, "stripKfSelIds")).length).toBe(1);

    // Pin both dismissal layers before Escape: no menu may swallow the press, and the cross-kind
    // selection (whose popover is hidden) must still be present as the rung this press peels.
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await kexCall(page, "stripKfSelIds")).length).toBe(0);
    await expect.poll(async () => await kexCall(page, "selectedStrip")).toBe(null);

    // The same keyframe is now visible again. A plain pointer click replaces the cleared set with
    // its owning strip + keyframe containment pair, and the typed-field popover is valid again.
    await velocityKeyframe.click();
    await expect(page.locator(".ptip")).toBeVisible();

    // Keep the setup's authored strip observable so a fixture that silently failed to create it
    // cannot make the pointer population empty and turn both DOM assertions into vacuous passes.
    await expect
        .poll(async () => (await stripsOf()).some((s: { id: number }) => s.id === stripId))
        .toBe(true);
});

// F1 repair (round 3, `Timeline.svelte`'s `deleteSelectedStripKf`): the RAF-tick race the fix
// closed, shipped with no arm — `selStrip` is a `$derived.by` gated on `void tick`, so its
// cached value only catches up to a fresh `editor.strip` write on the NEXT tick; a Delete
// pressed in the SAME tick-period as a selecting click used to race that cache. Pre-fix,
// `deleteSelectedStripKf` read that stale `selStrip`, saw null, and no-opped — post-fix it
// reads the strip directly off the ECS (`stripAt` + `Strip.start.get`), never depending on the
// cache, so there is no `selStrip` read left in this function for a click to race (checked
// below, not assumed). This test is the regression guard for that fix, single real click then
// Delete with no settle in between — see below for why no settle precedes the click either.
test("strip keyframe delete before the selection tick settles", async ({ page, boot }) => {
    await boot();
    await seedHill(page);
    await frameTimeline(page);

    const stripsOf = () => kexCall(page, "stripsOf", 0);
    const stripKeyframesOf = (id: number) => kexCall(page, "stripKeyframesOf", id);
    const stripKfPx = () => kexCall(page, "stripKfPx");

    // create a strip (the T1 idiom) — seeded with two keyframes at start/end (S4), close
    // together at this zoom (the whole-track fit) to be reliable click targets on their own.
    const beforeStrips = (await stripsOf()) as { id: number }[];
    const bandBb = await page.locator(".hbandzone").boundingBox();
    const clipBb = await page.locator(".clip").first().boundingBox();
    if (!bandBb || !clipBb) throw new Error("header band / clip not laid out");
    const bandY = bandBb.y + bandBb.height / 2;
    const bandX = clipBb.x + clipBb.width * 0.3;
    await page.mouse.click(bandX, bandY, { button: "right" });
    await expect(page.locator(".smenu")).toBeVisible();
    await clickMenuItem(page, ".smenu", "Add velocity strip");
    await expect.poll(async () => (await stripsOf()).length).toBe(beforeStrips.length + 1);
    await expect.poll(async () => await kexCall(page, "selectedStrip")).not.toBe(null);

    const beforeIds = new Set(beforeStrips.map((s) => s.id));
    const created = ((await stripsOf()) as { id: number }[]).find((s) => !beforeIds.has(s.id));
    if (!created) throw new Error("newly-created strip not found");
    const stripId = created.id;
    const seededIds = new Set(
        ((await stripKeyframesOf(stripId)) as { id: number }[]).map((k) => k.id),
    );
    expect(seededIds.size).toBe(2);

    // widen the strip via a real pointer edge-drag (the sibling flows' own idiom) so a THIRD
    // keyframe, created at its midpoint, sits well clear of both seeded diamonds — the two
    // seeded ones alone sit only a few px apart at this zoom (whole-track fit), too close for
    // an unambiguous click target.
    const chartCanvasBb = await page.locator("canvas.chart").boundingBox();
    if (!chartCanvasBb) throw new Error("chart canvas not laid out");
    const spBefore = (
        (await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[]
    ).find((s) => s.id === stripId);
    if (!spBefore) throw new Error("created strip has no band px");
    const edgePx = chartCanvasBb.x + spBefore.x1;
    await page.mouse.move(edgePx, bandY);
    await page.mouse.down();
    await page.mouse.move(edgePx + 80, bandY, { steps: 5 });
    await page.mouse.up();

    const strip = (
        (await stripsOf()) as { id: number; start: number; end: number; value: number }[]
    ).find((s) => s.id === stripId);
    if (!strip) throw new Error("widened strip not found");
    const [, pxPerU] = (await kexCall(page, "xView")) as [number, number];
    const [vLo, vHi] = (await kexCall(page, "vRange")) as [number, number];
    const stripMidS = (strip.start + strip.end) / 2;
    const stripCenterPx = clipBb.x + stripMidS * pxPerU;
    const stripWidthPx = (strip.end - strip.start) * pxPerU;
    expect(stripWidthPx).toBeGreaterThan(60);
    const dockBb = await page.locator(".dock .body").boundingBox();
    if (!dockBb) throw new Error("dock body not laid out");
    const chartTop = dockBb.y + CHART_TOP;
    const chartBot = dockBb.y + dockBb.height - CHART_BOT_PAD;
    const vToY = (v: number): number =>
        chartTop + (1 - (v - vLo) / (vHi - vLo)) * (chartBot - chartTop);
    const stripValueY = vToY(strip.value);

    // CREATE the third keyframe (`chartCreate` reads `editor.strip` off the ECS directly, not a
    // tick-gated `$derived` — its own repair, same class as F1 — so this create is not itself
    // racy).
    await page.mouse.dblclick(stripCenterPx, stripValueY);
    await expect.poll(async () => (await stripKeyframesOf(stripId)).length).toBe(3);
    const created3 = (
        (await stripKeyframesOf(stripId)) as { id: number; s: number; v: number }[]
    ).find((k) => !seededIds.has(k.id));
    if (!created3) throw new Error("no newly-created keyframe found");

    // locate the new keyframe's diamond — settled, a real, unambiguous hit target (well clear
    // of both seeded diamonds by construction, per `stripWidthPx` above).
    await expect
        .poll(async () => {
            const px = (await stripKfPx()) as { id: number; x: number; y: number }[];
            return px.find((k) => k.id === created3.id) ?? null;
        })
        .not.toBeNull();
    const px = (await stripKfPx()) as { id: number; x: number; y: number }[];
    const kfPx = px.find((k) => k.id === created3.id);
    if (!kfPx) throw new Error("created keyframe has no drawn diamond");

    // DESELECT fully (no stripKf sub-selection is active, so Escape clears the strip in one
    // rung). `expect.poll(selectedStrip)` proves the ECS write landed — the `__kex` hook returns
    // the raw, untracked `editor.strip` directly — never that `selStrip`'s per-tick `$derived.by`
    // cache caught up to it. No settle follows, on measurement rather than argument: a prior
    // version of this comment claimed the click below would otherwise race a stale NON-null
    // `selStrip` cache, but `deleteSelectedStripKf` (checked above) never reads `selStrip` at
    // all, so there is no such mechanism to construct — deleting the settle here held green
    // three consecutive runs, and stayed green under a forced 150ms-per-rAF-callback delay
    // armed on the six callbacks right after this line (`page.addInitScript`, temporary,
    // confirmed to have fired, removed before commit). This test is still the roster's own
    // regression guard for the F1 fix ("strip keyframe delete before the selection tick
    // settles", `kex2d-event-substrate` Validation): reverting `deleteSelectedStripKf` to its
    // pre-fix `selStrip`-reading body and re-running with no settle reds 4/4 (the buggy no-op
    // leaves the clicked keyframe behind, `Received` carrying the extra id) — the settle was
    // never what made this test discriminate the buggy no-op from the fixed behavior.
    //
    // ADDITIONAL CONFIRMATION (2026-08-25) — NOT an S2 roster member (`kex2d-event-substrate`
    // Validation owns this test; it does not appear in the S2 roster readings this spec's
    // Approach names): `capture -g "strip keyframe delete before the selection tick settles"
    // --repeat-each 8` exits 0, 8/8 on this tree. Re-ran the mutation directly rather than
    // trusting the prior claim: perturbed `deleteSelectedStripKf` back to the pre-fix
    // `selStrip`-reading body (`if (selStrip === null) return`) and re-ran `--repeat-each 4`
    // with no other change — reds 4/4 (`toEqual(seededIds)` timeout, `Received` carrying the
    // clicked keyframe's id, exactly this comment's own claim), then reverted and reran green
    // (exit 0). Still constructs the race, not vacuous — recorded here as extra rigor, not as
    // discharging any obligation this spec's S2 stage owes.
    await page.keyboard.press("Escape");
    await expect.poll(async () => await kexCall(page, "selectedStrip")).toBe(null);

    // THE RACE: a single click on the created diamond flips `editor.strip` null → `stripId` and
    // `editor.stripKf` null → `created3.id`, both plain synchronous writes — then Delete fires
    // with NO settle in between.
    await page.mouse.move(kfPx.x, kfPx.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.keyboard.press("Delete");

    // the clicked (third) keyframe is gone; the strip survives with exactly the two SEEDED
    // keyframes — the discriminating half against the buggy no-op (which would leave all three).
    await expect
        .poll(
            async () =>
                new Set(((await stripKeyframesOf(stripId)) as { id: number }[]).map((k) => k.id)),
        )
        .toEqual(seededIds);
    expect(await stripsOf()).toHaveLength(beforeStrips.length + 1);
});

// S1: the strip keyframe drag ORIGIN. `stripKfMove` subtracted the section entry
// (`BandStrip.startU`) where `keyframeDown`'s own pattern subtracts the GRAB POINT (`dragU0`) — so
// the first move wrote `s ≈ 2·s0` and both clamps (the extent clamp here, `setStripKeyframe`'s
// own) pinned it to `end`, regardless of how small the actual cursor delta was (the origin error
// dominates, not the drag distance). This flow drives REAL POINTER EVENTS (checks.md: an
// interaction affordance is only visible to an instrument that performs the interaction — the
// `__kex` hook only supplies pixel POSITIONS to drive the pointer at, per its own doc comment,
// never the drag itself) and asserts the authored `s` moves by the cursor delta, never landing
// on `end`.
test("strip keyframe drag origin regression", async ({ page, boot }) => {
    await boot();
    await seedHill(page);
    await frameTimeline(page);

    const stripsOf = () => kexCall(page, "stripsOf", 0);
    const stripKeyframesOf = (id: number) => kexCall(page, "stripKeyframesOf", id);
    const xView = () => kexCall(page, "xView");
    const vRange = () => kexCall(page, "vRange");
    const stripKfPx = () => kexCall(page, "stripKfPx");

    // create a strip (right-click on the band → Add velocity strip), the T1 flow's own idiom.
    // `seed()` (S3) carries no strip of its own (the track-start one-shot is a distinct point
    // kind), so the count goes 0 → 1, and the NEW strip is addressed by id, never index 0
    // (the created strip's `start = 0` sorts first).
    const beforeStrips = (await stripsOf()) as { id: number }[];
    const bandBb = await page.locator(".hbandzone").boundingBox();
    const clipBb = await page.locator(".clip").first().boundingBox();
    if (!bandBb || !clipBb) throw new Error("header band / clip not laid out");
    const bandY = bandBb.y + bandBb.height / 2;
    const bandX = clipBb.x + clipBb.width * 0.3;
    await page.mouse.click(bandX, bandY, { button: "right" });
    await expect(page.locator(".smenu")).toBeVisible();
    await clickMenuItem(page, ".smenu", "Add velocity strip");
    await expect.poll(async () => (await stripsOf()).length).toBe(beforeStrips.length + 1);
    await expect.poll(async () => await kexCall(page, "selectedStrip")).not.toBe(null);

    // S4: creation seeds two keyframes at start/end, sized to the min-extent strip's own
    // width — a dblclick at the strip's midpoint would land on a diamond's own hit area
    // rather than empty curve. `seededIds` names the two so the create step below can find
    // the genuinely-new keyframe among the (now three) rows. Widen the strip via a REAL
    // pointer edge-drag on its end. Non-sticking (S4, boundary ride deleted): the resize
    // does NOT carry the seeded end keyframe, but the strip's own extent records the new
    // edge, so the midpoint below (computed from start/end) clears both diamonds by
    // construction.
    const beforeIds = new Set(beforeStrips.map((s) => s.id));
    const created = ((await stripsOf()) as { id: number }[]).find((s) => !beforeIds.has(s.id));
    if (!created) throw new Error("newly-created strip not found");
    const stripId0 = created.id;
    const seededIds = new Set(
        ((await stripKeyframesOf(stripId0)) as { id: number; s: number; v: number }[]).map(
            (k) => k.id,
        ),
    );
    expect(seededIds.size).toBe(2);
    // `stripPx`'s x0/x1 are CANVAS-local (like `ghostPx`, unlike the page-absolute
    // `stripKfPx`), so the chart canvas's own rect supplies the page offset.
    const chartCanvasBb = await page.locator("canvas.chart").boundingBox();
    if (!chartCanvasBb) throw new Error("chart canvas not laid out");
    const spBefore = (
        (await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[]
    ).find((s) => s.id === stripId0);
    if (!spBefore) throw new Error("created strip has no band px");
    const edgePx = chartCanvasBb.x + spBefore.x1;
    await page.mouse.move(edgePx, bandY);
    await page.mouse.down();
    await page.mouse.move(edgePx + 80, bandY, { steps: 5 });
    await page.mouse.up();

    const strip = (
        (await stripsOf()) as { id: number; start: number; end: number; value: number }[]
    ).find((s) => s.id === stripId0);
    if (!strip) throw new Error("widened strip not found");
    const [, pxPerU] = await xView();
    const [vLo, vHi] = await vRange();
    const stripMidS = (strip.start + strip.end) / 2;
    const stripCenterPx = clipBb.x + stripMidS * pxPerU;
    const dockBb = await page.locator(".dock .body").boundingBox();
    if (!dockBb) throw new Error("dock body not laid out");
    const chartTop = dockBb.y + CHART_TOP;
    const chartBot = dockBb.y + dockBb.height - CHART_BOT_PAD;
    // derived from the chart's own row (`vOf`'s formula in Timeline.svelte), not a fractional
    // guess at `dockBb.height` — the sibling flow above's own note on why the 0.7 heuristic
    // stopped landing once S3 grew the header band.
    const vToY = (v: number): number =>
        chartTop + (1 - (v - vLo) / (vHi - vLo)) * (chartBot - chartTop);
    const stripValueY = vToY(strip.value);

    // create a keyframe at the strip's MIDPOINT — off both edges, so the bug's own jump (s ≈
    // 2·s0, clamped to `end`) is distinguishable from a correct small move in either
    // direction. The strip already carries its two seeded keyframes (S4), so this lands a
    // THIRD row; `kf0` is the newly-created one, not one of the two seeded ones.
    await page.mouse.dblclick(stripCenterPx, stripValueY);
    await expect.poll(async () => (await stripKeyframesOf(strip.id)).length).toBe(3);
    const kf0 = ((await stripKeyframesOf(strip.id)) as { id: number; s: number; v: number }[]).find(
        (k) => !seededIds.has(k.id),
    );
    if (!kf0) throw new Error("no newly-created keyframe found");

    // poll for the SPECIFIC newly-created keyframe's diamond, not just any diamond — the
    // seeded keyframes are already drawn, so a bare length > 0 passes before the new one's
    // $derived (read through the per-RAF tick) has propagated to `stripKfPx`.
    await expect
        .poll(async () => {
            const px = (await stripKfPx()) as { id: number; x: number; y: number }[];
            return px.find((k) => k.id === kf0.id) ?? null;
        })
        .not.toBeNull();
    const kfPx = (await stripKfPx()) as { id: number; x: number; y: number }[];
    const kf0Px = kfPx.find((k) => k.id === kf0.id);
    if (!kf0Px) throw new Error("the created keyframe has no drawn diamond");

    // a horizontal-only drag, held y fixed (the same client y throughout, so v holds and
    // only s is under test) — small enough that a correct drag stays well inside the strip's
    // own extent (widened to >60 px above; a 20 px move from the strip's own MIDPOINT clears
    // both edges by construction). Ctrl is held to bypass the grid/landmark snap (S1: snapping
    // is now applied to strip keyframe drags through the unified `applyKeyframeDrag`). The
    // drag is 20 px — well past SNAP_PX (8), so the per-axis gesture-start magnet that survives
    // the bypass (`snapAxis`'s `startPx`, the same axis pin the force side tests at force.pw.ts
    // 2b′) does not fire. The force side's own reference drag (force.pw.ts ~1539) uses the same
    // convention: Ctrl + a drag "well past SNAP_PX, so no landmark/gesture-start magnet fires."
    const DxPx = 20;
    await page.mouse.move(kf0Px.x, kf0Px.y);
    await page.keyboard.down("Control"); // bypass grid/landmark snap (S1: unified drag now snaps)
    await page.mouse.down();
    await page.mouse.move(kf0Px.x + DxPx, kf0Px.y, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up("Control");

    const kfs1 = (await stripKeyframesOf(strip.id)) as { id: number; s: number; v: number }[];
    const kf1 = kfs1.find((k) => k.id === kf0.id);
    if (!kf1) throw new Error("the dragged keyframe vanished");

    // the authored s moved by the CURSOR DELTA — `expectedDs`, derived from the same pxPerU
    // axis scale the app itself reads the drag through — not by the section-entry-sized jump
    // the bug produced (s ≈ 2·s0). Tolerance: 2 px worth of s, covering the whole-pixel
    // rounding `page.mouse.move` and `getBoundingClientRect` each contribute (at most 1 px
    // apiece, on top of and back off the axis).
    const expectedDs = DxPx / pxPerU;
    const tol = 2 / pxPerU;
    expect(Math.abs(kf1.s - kf0.s - expectedDs)).toBeLessThan(tol);
    // The vertical axis is held on this center-origin arm too: a horizontal move must preserve
    // the authored velocity exactly, independent of the live projected point.
    expect(kf1.v).toBe(kf0.v);
    // never lands on `end` — the buggy clamp's own tell, independent of the tolerance above.
    expect(kf1.s).toBeLessThan(strip.end - tol);
    expect(kf1.s).toBeGreaterThan(strip.start + tol);
});

// S2 projection hold/return: moving a strip keyframe horizontally re-bakes the recovered
// velocity curve, so its fitted target must stay live while the displayed velocity view and the
// dragged diamond remain fixed. Release then returns the held view to that target through the
// normal eased settle, rather than freezing the velocity channel wholesale.
test("velocity projection hold and return", async ({ page, boot }) => {
    await boot();
    await seedHill(page);
    const stripId = (await kexCall(page, "addStripAt", 2, 40, 8)) as number;
    await kexCall(page, "placeStripKf", stripId, 12, 40);
    await kexCall(page, "placeStripKf", stripId, 28, 3);
    await frameTimeline(page);
    await expect
        .poll(async () => {
            const range = await kexCall(page, "vRange");
            const fit = await kexCall(page, "vFit");
            return Math.abs(range[0] - fit[0]) < 0.02 && Math.abs(range[1] - fit[1]) < 0.02;
        })
        .toBe(true);

    const kfId = (
        (await kexCall(page, "stripKeyframesOf", stripId)) as { id: number; s: number }[]
    ).find((candidate) => candidate.s === 12)?.id;
    if (kfId === undefined) throw new Error("projection fixture keyframe missing");
    const read = () =>
        page.evaluate(
            ({ stripId, kfId }) => {
                const k = (window as unknown as { __kex: Kex }).__kex;
                const row = k.stripKeyframesOf(stripId).find((candidate) => candidate.id === kfId);
                const point = row
                    ? k.stripKfPx().find((candidate) => candidate.id === row.id)
                    : null;
                return { row, point, range: k.vRange(), fit: k.vFit() };
            },
            { stripId, kfId },
        );
    const before = await read();
    if (!before.row || !before.point) throw new Error("projection fixture keyframe not laid out");
    const pressX = before.point.x;
    const pressY = before.point.y;
    const dx = 300;
    await page.keyboard.down("Control");
    await page.mouse.move(pressX, pressY);
    await page.mouse.down();
    await page.mouse.move(pressX + dx, pressY, { steps: 8 });
    const held = await read();
    expect(held.row?.s).not.toBe(before.row.s);
    expect(held.row?.v).toBe(before.row.v);
    expect(held.range).toEqual(before.range);
    expect(held.point?.y).toBe(before.point.y);
    // The station move changes the recovered-speed fit beneath the held displayed axis. This
    // direct target read is the positive control against a fixture whose curve never moved.
    expect(held.fit).not.toEqual(before.fit);
    await page.mouse.up();
    await page.keyboard.up("Control");

    await expect
        .poll(async () => {
            const settled = await read();
            return (
                Math.abs(settled.range[0] - settled.fit[0]) < 0.02 &&
                Math.abs(settled.range[1] - settled.fit[1]) < 0.02
            );
        })
        .toBe(true);
});

// Length drags are not keyframe drags, but they re-bake the recovered velocity curve too. The
// velocity projection therefore holds for the extent gesture as well, then returns through the
// same fitted target on release.
test("velocity projection holds during length drag", async ({ page, boot }) => {
    await boot();
    await seedHill(page);
    await kexCall(page, "convert");
    await kexCall(page, "setLen", 0, 40);
    await kexCall(page, "seedForceBump");
    const speedStrip = (await kexCall(page, "addStripAt", 2, 40, 8)) as number;
    await kexCall(page, "placeStripKf", speedStrip, 20, 40);
    await kexCall(page, "placeStripKf", speedStrip, 30, 3);
    await frameTimeline(page);
    await expect
        .poll(async () => {
            const range = await kexCall(page, "vRange");
            const fit = await kexCall(page, "vFit");
            return Math.abs(range[0] - fit[0]) < 0.02 && Math.abs(range[1] - fit[1]) < 0.02;
        })
        .toBe(true);

    const trim = page.locator(".clip-trim");
    await expect(trim).toHaveCount(1);
    const box = await trim.boundingBox();
    const clip = await page.locator(".clip").first().boundingBox();
    const [, pxPerU] = (await kexCall(page, "xView")) as [number, number];
    if (!box || !clip) throw new Error("length trim handle not laid out");
    const before = { range: await kexCall(page, "vRange"), fit: await kexCall(page, "vFit") };
    await page.keyboard.down("Control");
    await trim.hover();
    await page.mouse.down();
    await page.mouse.move(clip.x + 12 * pxPerU, box.y + box.height / 2, { steps: 10 });
    const held = { range: await kexCall(page, "vRange"), fit: await kexCall(page, "vFit") };
    const heldLen = (await kexCall(page, "sectionLengths"))[0];
    expect(heldLen).toBeLessThan(40);
    expect(held.range).toEqual(before.range);
    // The trim cuts the authored force bump's tail from the bake, so the fitted velocity target
    // changes while the displayed projection is held. Removing `|| draggingLen` makes this red.
    expect(held.fit).not.toEqual(before.fit);
    await page.mouse.up();
    await page.keyboard.up("Control");
    await expect
        .poll(async () => {
            const settled = await kexCall(page, "vRange");
            const fit = await kexCall(page, "vFit");
            return Math.abs(settled[0] - fit[0]) < 0.02 && Math.abs(settled[1] - fit[1]) < 0.02;
        })
        .toBe(true);
});

// S2 channel edge-growth matrix: each arm holds a pointer-true vertical keyframe drag past the
// top and bottom edges. A strip anchor grows only vRange, a force anchor grows only gRange, and a
// mixed set follows the active strip anchor's view while its undefined mixed vertical value channel
// stays constrained. The lower-edge arm also proves the V_BASE cap prevents further lower growth.
test("channel-specific keyframe edge growth", async ({ page, boot }) => {
    const chartBounds = async () => {
        const body = await page.locator(".dock .body").boundingBox();
        if (!body) throw new Error("timeline body not laid out");
        return { top: body.y + CHART_TOP, bottom: body.y + body.height - CHART_BOT_PAD };
    };
    const readAxes = () =>
        page.evaluate(() => {
            const k = (
                window as unknown as {
                    __kex: Kex & {
                        valueAxes(): {
                            gRange: [number, number];
                            gFit: [number, number];
                            vRange: [number, number];
                            vFit: [number, number];
                        };
                    };
                }
            ).__kex;
            return k.valueAxes();
        });
    const growFrom = async (
        point: { x: number; y: number },
        edge: number,
        side: "top" | "bottom" = "top",
        id?: number,
        yOffset = 10,
        overshoot = 120,
    ) => {
        const press = { x: point.x, y: point.y + yOffset };
        const cursorY = side === "top" ? edge - overshoot : edge + overshoot;
        await page.keyboard.down("Control");
        await page.mouse.move(press.x, press.y);
        await page.mouse.down();
        const grabbed =
            id === undefined
                ? null
                : ((
                      (await kexCall(page, "stripKfPx")) as {
                          id: number;
                          x: number;
                          y: number;
                      }[]
                  ).find((candidate) => candidate.id === id) ?? null);
        if (id !== undefined && grabbed === null)
            throw new Error("off-center strip keyframe grab was not resolved");
        await page.mouse.move(press.x, cursorY, { steps: 8 });
        return { press, cursorY, grabbed };
    };
    const finish = async () => {
        await page.mouse.up();
        await page.keyboard.up("Control");
    };

    // Strip arm: only the velocity view follows the active strip keyframe.
    await boot();
    await seedHill(page);
    const stripId = (await kexCall(page, "addStripAt", 2, 40, 8)) as number;
    const stripKfId = await kexCall(page, "placeStripKf", stripId, 12, 8);
    const bottomKfId = await kexCall(page, "placeStripKf", stripId, 24, 0);
    await frameTimeline(page);
    const stripPoints = (await kexCall(page, "stripKfPx")) as {
        id: number;
        x: number;
        y: number;
    }[];
    const stripPoint = stripPoints.find((candidate) => candidate.id === stripKfId);
    if (!stripPoint) throw new Error("strip edge-growth keyframe not laid out");
    const { top, bottom } = await chartBounds();
    const readStrip = () =>
        page.evaluate((id) => {
            const k = (window as unknown as { __kex: Kex }).__kex;
            const axes = k.valueAxes();
            const row = k
                .stripKeyframesOf(
                    (k.stripsOf(0) as { id: number }[]).find((s) =>
                        (k.stripKeyframesOf(s.id) as { id: number }[]).some((x) => x.id === id),
                    )?.id ?? -1,
                )
                .find((x) => x.id === id);
            const point = k.stripKfPx().find((x) => x.id === id);
            return { axes, row, point };
        }, stripKfId);
    const stripBeforeRead = await readStrip();
    const stripBefore = stripBeforeRead.axes;
    if (!stripBeforeRead.row || !stripBeforeRead.point)
        throw new Error("strip edge-growth keyframe read was not complete");
    const stripGrab = await growFrom(stripPoint, top, "top", stripKfId, -10);
    await expect
        .poll(async () => (await readStrip()).axes.vRange[1])
        .toBeGreaterThan(stripBefore.vRange[1] + 0.01);
    // The top-edge press is 10px above the diamond, so it remains in the production candidate
    // list while the pointer overshoots strongly. Compare the signed value-space offset against
    // the clamped cursor ordinate, not the raw off-canvas pointer.
    if (!stripGrab.grabbed) throw new Error("off-center strip keyframe grab was not resolved");
    const grabOffsetPx = stripGrab.press.y - stripGrab.grabbed.y;
    expect(Math.abs(grabOffsetPx + 10)).toBeLessThan(1);
    const chartHeight = bottom - top;
    const valueAt = (range: [number, number], y: number): number =>
        range[0] +
        (1 - (Math.max(top, Math.min(bottom, y)) - top) / chartHeight) * (range[1] - range[0]);
    const stripDuring = await readStrip();
    if (!stripDuring.row || !stripDuring.point)
        throw new Error("grown strip keyframe left the production candidate list");
    const growthFactor =
        (stripDuring.axes.vRange[1] - stripDuring.axes.vRange[0]) /
        (stripBefore.vRange[1] - stripBefore.vRange[0]);
    // 120px of overshoot must produce a visible multi-percent span increase; this catches a
    // growth path that only nudges the edge or never applies the active channel's cap.
    expect(growthFactor).toBeGreaterThan(1.02);
    const clampedCursorY = Math.max(top, Math.min(bottom, stripGrab.cursorY));
    const expectedValueOffset =
        stripBeforeRead.row.v - valueAt(stripDuring.axes.vRange, stripGrab.press.y);
    // The chart coordinates are CSS pixels while the authored value is f32; one value-axis
    // pixel is the derived floor for this comparison, so the signed offset may round once.
    expect(stripDuring.row.v - valueAt(stripDuring.axes.vRange, clampedCursorY)).toBeCloseTo(
        expectedValueOffset,
        0,
    );
    const expectedDiamondY =
        top +
        (1 -
            (stripDuring.row.v - stripDuring.axes.vRange[0]) /
                (stripDuring.axes.vRange[1] - stripDuring.axes.vRange[0])) *
            chartHeight;
    expect(stripDuring.point.y - clampedCursorY).toBeCloseTo(expectedDiamondY - clampedCursorY, 1);
    // The strip edit keeps the velocity fit inside its resting band while the recovered force
    // target moves; both target fields are asserted from this one batched edge read.
    expect(stripDuring.axes.gFit).not.toEqual(stripBefore.gFit);
    expect(stripDuring.axes.vFit).toEqual(stripBefore.vFit);
    await page.mouse.move(stripGrab.press.x, stripGrab.press.y);
    const stripReturn = await readStrip();
    if (!stripReturn.row) throw new Error("returned strip keyframe read was not complete");
    expect(stripReturn.row.v).toBe(stripBeforeRead.row.v);
    expect(stripDuring.axes.vRange[0]).toBe(stripBefore.vRange[0]);
    expect(stripDuring.axes.gRange).toEqual(stripBefore.gRange);
    await finish();
    await frames(page, 40); // allow the released g-view's eased return to finish before the next arm

    // Near-bottom arm: put a real strip keyframe on the lower edge, drag beyond the chart, and
    // prove the V_BASE cap refuses further lower growth. This is deliberately a pointer gesture,
    // not a hook write; the unchanged lower edge is the cap's non-vacuous result.
    await expect
        .poll(async () => {
            const range = await kexCall(page, "vRange");
            const fit = await kexCall(page, "vFit");
            return Math.abs(range[0] - fit[0]) < 0.02 && Math.abs(range[1] - fit[1]) < 0.02;
        })
        .toBe(true);
    const bottomPoint = (
        (await kexCall(page, "stripKfPx")) as { id: number; x: number; y: number }[]
    ).find((candidate) => candidate.id === bottomKfId);
    if (!bottomPoint) throw new Error("strip lower-edge keyframe not laid out");
    const bottomBefore = await readAxes();
    await growFrom(bottomPoint, bottom, "bottom");
    await expect.poll(async () => (await readAxes()).vRange[0]).toBe(bottomBefore.vRange[0]);
    const bottomDuring = await readAxes();
    expect(bottomDuring.vRange[0]).toBeGreaterThanOrEqual(bottomBefore.vRange[0]);
    expect(bottomDuring.vRange[0]).toBe(bottomBefore.vRange[0]);
    expect(bottomDuring.vRange[1]).toBe(bottomBefore.vRange[1]);
    expect(bottomDuring.gRange).toEqual(bottomBefore.gRange);
    await finish();

    // Force arm: the inverse route grows gRange while the velocity view remains byte-identical.
    await boot();
    await seedHill(page);
    await kexCall(page, "seedForceBump");
    await frameTimeline(page);
    const forceRow = (await kexCall(page, "forceU")).find((candidate) => candidate.s === 12);
    const clip = await page.locator(".clip").first().boundingBox();
    const [, pxPerU] = await kexCall(page, "xView");
    if (!forceRow || !clip) throw new Error("force edge-growth keyframe not laid out");
    const expectedX = clip.x + forceRow.u * pxPerU;
    const forceHits = await page.locator(".fhit").evaluateAll((els) =>
        els.map((el) => {
            const box = el.getBoundingClientRect();
            return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        }),
    );
    const forcePoint = forceHits
        .map((point) => ({ point, distance: Math.abs(point.x - expectedX) }))
        .sort((a, b) => a.distance - b.distance)[0]?.point;
    if (!forcePoint) throw new Error("force edge-growth hit target not laid out");
    const forceBefore = await readAxes();
    const forceBounds = await chartBounds();
    await growFrom(forcePoint, forceBounds.top);
    await expect
        .poll(async () => (await readAxes()).gRange[1])
        .toBeGreaterThan(forceBefore.gRange[1] + 0.01);
    const forceDuring = await readAxes();
    expect(forceDuring.vRange).toEqual(forceBefore.vRange);
    await finish();

    // Mixed arm: make the strip keyframe active last, then drag it. The shared set has no vertical
    // value meaning, but edge growth still belongs to the active anchor's descriptor.
    await boot();
    await seedHill(page);
    await kexCall(page, "seedForceBump");
    const mixedStrip = (await kexCall(page, "addStripAt", 2, 40, 18)) as number;
    const mixedKf = await kexCall(page, "placeStripKf", mixedStrip, 12, 18);
    await frameTimeline(page);
    const mixedForce = (await kexCall(page, "forceU")).find((candidate) => candidate.s === 12);
    const mixedClip = await page.locator(".clip").first().boundingBox();
    const [, mixedPxPerU] = await kexCall(page, "xView");
    const mixedPoint = (await kexCall(page, "stripKfPx")).find(
        (candidate) => candidate.id === mixedKf,
    );
    if (!mixedForce || !mixedClip || !mixedPoint)
        throw new Error("mixed edge-growth fixture not laid out");
    const mixedExpectedX = mixedClip.x + mixedForce.u * mixedPxPerU;
    const mixedForcePoint = (
        await page.locator(".fhit").evaluateAll((els) =>
            els.map((el) => {
                const box = el.getBoundingClientRect();
                return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
            }),
        )
    ).sort((a, b) => Math.abs(a.x - mixedExpectedX) - Math.abs(b.x - mixedExpectedX))[0];
    if (!mixedForcePoint) throw new Error("mixed force keyframe not laid out");
    await page.mouse.click(mixedForcePoint.x, mixedForcePoint.y);
    await page.keyboard.down("Shift");
    await page.mouse.click(mixedPoint.x, mixedPoint.y);
    await page.keyboard.up("Shift");
    await expect.poll(() => kexCall(page, "stripKfSelActive")).toBe(mixedKf);
    const liveMixedPoint = (
        (await kexCall(page, "stripKfPx")) as { id: number; x: number; y: number }[]
    ).find((candidate) => candidate.id === mixedKf);
    if (!liveMixedPoint) throw new Error("mixed active strip keyframe moved out of view");
    const mixedBefore = await readAxes();
    const mixedBounds = await chartBounds();
    await growFrom(liveMixedPoint, mixedBounds.top);
    await expect
        .poll(async () => (await readAxes()).vRange[1])
        .toBeGreaterThan(mixedBefore.vRange[1] + 0.01);
    const mixedDuring = await readAxes();
    expect(mixedDuring.vRange[0]).toBe(mixedBefore.vRange[0]);
    expect(mixedDuring.gRange).toEqual(mixedBefore.gRange);
    await finish();
});

// S1 attribution matrix: the same legal grab is crossed with the two value-axis modes. Every
// sample reads the authored value, projected diamond, and displayed velocity range together so a
// green horizontal arm cannot hide a view/range change. The +10px arms also perform the vertical
// control: the expected value comes from the same pointer delta and the diamond keeps its grab
// offset, rather than a horizontal-only special case.
test("velocity strip keyframe drag origin flow", async ({ page, boot }) => {
    const arms = [
        { name: "center Ctrl", yOffset: 0, ctrl: true },
        { name: "center snap", yOffset: 0, ctrl: false },
        { name: "+10px-y Ctrl", yOffset: 10, ctrl: true },
        { name: "+10px-y snap", yOffset: 10, ctrl: false },
    ];
    const failures: string[] = [];
    for (const arm of arms) {
        await boot();
        await seedHill(page);
        const stripId = await kexCall(page, "addStripAt", 2, 22, 8);
        if (stripId === null) throw new Error(`${arm.name}: strip setup failed`);
        const kfId = await kexCall(page, "placeStripKf", stripId, 12, 8);
        await frameTimeline(page);
        const read = () =>
            page.evaluate(
                ({ stripId, kfId }) => {
                    const k = (window as unknown as { __kex: Kex }).__kex;
                    const row = k.stripKeyframesOf(stripId).find((x) => x.id === kfId);
                    const point = k.stripKfPx().find((x) => x.id === kfId);
                    return { row, point, range: k.vRange() };
                },
                { stripId, kfId },
            );
        const before = await read();
        if (!before.row || !before.point) throw new Error(`${arm.name}: keyframe not laid out`);
        const beforeRow = before.row;
        const beforePoint = before.point;
        const v0 = beforeRow.v;
        const range0 = before.range;
        const pressX = beforePoint.x;
        const pressY = beforePoint.y + arm.yOffset;
        const dx = 20;
        const samples: Awaited<ReturnType<typeof read>>[] = [];
        if (arm.ctrl) await page.keyboard.down("Control");
        await page.mouse.move(pressX, pressY);
        await page.mouse.down();
        for (let i = 1; i <= 5; i++) {
            await page.mouse.move(pressX + (dx * i) / 5, pressY);
            samples.push(await read());
        }
        await page.mouse.up();
        if (arm.ctrl) await page.keyboard.up("Control");
        const diagnostic = (
            label: string,
            step: number | string,
            sample: Awaited<ReturnType<typeof read>>,
        ): string => {
            const diamond = sample.point ? `(${sample.point.x},${sample.point.y})` : "missing";
            return `${arm.name}: ${label}; first-moving step=${step}; value=${sample.row?.v ?? "missing"}; projected y=${sample.point?.y ?? "missing"}; range=${JSON.stringify(sample.range)}; press point=(${pressX},${pressY}); diamond center=${diamond}; grab offset=(${pressX - beforePoint.x},${pressY - beforePoint.y})`;
        };
        const horizontalValueStable = samples.every((sample) => sample.row?.v === v0);
        const horizontalRangeStable = samples.every(
            (sample) => JSON.stringify(sample.range) === JSON.stringify(range0),
        );
        const horizontalProjectionStable = samples.every(
            (sample) =>
                sample.point !== undefined && Math.abs(sample.point.y - beforePoint.y) <= 0.5,
        );
        const stationMoved = samples.at(-1)?.row?.s !== beforeRow.s;
        const firstMovingIndex = samples.findIndex((sample) => sample.row?.s !== beforeRow.s);
        const firstMovingStep = firstMovingIndex >= 0 ? firstMovingIndex + 1 : "none";
        const firstMoving = samples[firstMovingIndex] ?? samples[0];
        if (!horizontalValueStable)
            failures.push(
                diagnostic("horizontal authored value moved", firstMovingStep, firstMoving),
            );
        if (!horizontalRangeStable)
            failures.push(diagnostic("velocity range moved", firstMovingStep, firstMoving));
        if (!horizontalProjectionStable)
            failures.push(diagnostic("horizontal projected y moved", firstMovingStep, firstMoving));
        if (!stationMoved)
            failures.push(
                diagnostic("horizontal station did not move", firstMovingStep, firstMoving),
            );

        if (arm.yOffset !== 0) {
            const range = before.range;
            const dock = await page.locator(".dock .body").boundingBox();
            if (!dock) throw new Error(`${arm.name}: dock not laid out`);
            const chartHeight = dock.height - CHART_TOP - CHART_BOT_PAD;
            const verticalDelta = 20;
            const rawExpectedV = v0 - (verticalDelta / chartHeight) * (range[1] - range[0]);
            const expectedV = arm.ctrl ? rawExpectedV : Math.round(rawExpectedV * 10) / 10;
            const afterHorizontal = samples.at(-1);
            if (!afterHorizontal?.point) throw new Error(`${arm.name}: horizontal sample missing`);
            if (arm.ctrl) await page.keyboard.down("Control");
            await page.mouse.move(afterHorizontal.point.x, afterHorizontal.point.y + arm.yOffset);
            await page.mouse.down();
            await page.mouse.move(
                afterHorizontal.point.x,
                afterHorizontal.point.y + arm.yOffset + verticalDelta,
                { steps: 5 },
            );
            const vertical = await read();
            await page.mouse.up();
            if (arm.ctrl) await page.keyboard.up("Control");
            if (!vertical.row || !vertical.point)
                throw new Error(`${arm.name}: vertical sample missing`);
            const verticalValueStable = Math.abs(vertical.row.v - expectedV) < 1e-5;
            const offsetStable = Math.abs(vertical.point.y - (beforePoint.y + verticalDelta)) < 1;
            if (!verticalValueStable)
                failures.push(diagnostic("vertical delta incorrect", "vertical", vertical));
            if (!offsetStable)
                failures.push(diagnostic("vertical grab offset changed", "vertical", vertical));
        }
    }
    if (failures.length > 0) throw new Error(failures.join("; "));
});

// S4 capture arm: the chart-body empty-click deselect grammar — one `deselectAll()` call
// clears every member of every kind (keyframes, strip, one-shot, node selection), not a
// partial sweep that silently omits the strip and one-shot. S1's arm checked keyframes
// alone; S4 widens it to assert each of the four rather than the keyframes alone — today's
// arm re-checked neither the strip nor the one-shot, which is how the gap survived.
//
// RED-FIRST WITNESS (S4): reverted marqueeUp's plain-click path from `deselectAll()` back to
// `selectSection(null); deselectKfKinds()` (the pre-S4 partial sweep). The flow reds at the
// `selectedStrip()` null assert: the strip stayed selected after the empty-chart click because
// the partial sweep never cleared it. Restored `deselectAll()`; the flow went green.
test("strip keyframe deselect on empty chart click", async ({ page, boot }) => {
    await boot();
    await seedHill(page);
    await frameTimeline(page);

    const stripKeyframesOf = (id: number) => kexCall(page, "stripKeyframesOf", id);
    const stripKfPx = () =>
        kexCall(page, "stripKfPx") as Promise<{ id: number; x: number; y: number }[]>;
    const stripKfSelIds = () => kexCall(page, "stripKfSelIds") as Promise<number[]>;
    const selectedStrip = () => kexCall(page, "selectedStrip");
    const oneShotSelected = () => kexCall(page, "oneShotSelected");
    const nodeSelOrders = () => kexCall(page, "nodeSelOrders");

    // a strip [0, 40) with two interior keyframes at s=10 and s=30 — 4 keyframes total.
    const stripId = (await kexCall(page, "addStripAt", 0, 40, 5)) as number;
    await kexCall(page, "placeStripKf", stripId, 10, 8);
    await kexCall(page, "placeStripKf", stripId, 30, 3);
    await expect.poll(async () => ((await stripKeyframesOf(stripId)) as unknown[]).length).toBe(4);

    // select the strip through a real band click. No settle and no hover poll before it: the
    // classifier computes its candidates fresh from the ECS (`freshBandStrips`), so a press is
    // never racing a tick-gated projection of the strip it lands on.
    const bandBb = await page.locator(".hbandzone").boundingBox();
    const chartCanvasBb = await page.locator("canvas.chart").boundingBox();
    const stripPx = (await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[];
    const sp = stripPx.find((s) => s.id === stripId);
    if (!bandBb || !chartCanvasBb || !sp) throw new Error("layout not ready");
    const bandY = bandBb.y + bandBb.height / 2;
    const bandClickX = chartCanvasBb.x + (sp.x0 + sp.x1) / 2;
    await page.mouse.click(bandClickX, bandY);
    await expect.poll(selectedStrip).toBe(stripId);

    // click one interior keyframe to select it (replace-select keeps the owning strip).
    const kfPx = await stripKfPx();
    const interior = kfPx.find(
        (k) => k.x > chartCanvasBb.x + sp.x0 + 10 && k.x < chartCanvasBb.x + sp.x1 - 10,
    );
    if (!interior) throw new Error("interior strip keyframe not projected");
    await page.mouse.click(interior.x, interior.y);
    await expect.poll(async () => (await stripKfSelIds()).length).toBe(1);
    await expect.poll(selectedStrip).toBe(stripId); // the strip is co-selected

    // Click on EMPTY CHART space — a plain click (no drag) triggers marqueeUp with !armed,
    // which must call deselectAll() to clear EVERY member of EVERY kind (S4's one empty-click
    // grammar). Click at a y near the chart top (high velocity), away from the keyframes.
    const dockBb = await page.locator(".dock .body").boundingBox();
    if (!dockBb) throw new Error("dock body not laid out");
    const emptyX = dockBb.x + dockBb.width * 0.5;
    const emptyY = dockBb.y + CHART_TOP + 4; // just inside the chart top, away from keyframes
    await page.mouse.click(emptyX, emptyY);
    await expect.poll(async () => (await stripKfSelIds()).length).toBe(0);
    await expect.poll(selectedStrip).toBe(null); // S4: the strip is cleared too

    // ── one-shot: select the glyph on the band, then empty-click the chart body — the
    // one-shot must clear too. ──
    const glyphLocalX = (await kexCall(page, "oneShotPx")) as number;
    await page.mouse.click(chartCanvasBb.x + glyphLocalX, bandY);
    await expect.poll(oneShotSelected).toBe(true);
    await page.mouse.click(emptyX, emptyY);
    await expect.poll(oneShotSelected).toBe(false); // S4: the one-shot is cleared

    // ── node: select a node in the viewport, then empty-click the chart body — the node
    // selection must clear too. ──
    const vpCanvas = page.locator("canvas.viewport");
    const vpBb = await vpCanvas.boundingBox();
    if (!vpBb) throw new Error("viewport canvas not laid out");
    await page.mouse.move(vpBb.x + vpBb.width / 2, vpBb.y + vpBb.height / 3);
    await page.keyboard.press("f"); // nothing selected → the whole chain frames
    const nodePt = await nodePoint(page, 3);
    await page.mouse.click(vpBb.x + nodePt.x, vpBb.y + nodePt.y);
    await expect.poll(async () => (await nodeSelOrders()).length).toBe(1);
    await page.mouse.click(emptyX, emptyY);
    await expect.poll(async () => (await nodeSelOrders()).length).toBe(0); // S4: the node is cleared
});

// S4 capture arm: `.sel` reads real container membership, retiring the strip-context
// expression. With a strip selected and one of its keyframes selected, every OTHER keyframe
// on that strip must read unselected — the strip-context expression (`selStrip !== null &&
// k.strip === selStrip.id`) made every keyframe on the selected strip render as if selected
// regardless of membership (feel-gate round 3, F3). The arm counts the `.fpt.sel` elements
// that carry a "Velocity keyframe" aria-label: at the pre-fix ref the count is > 1 (every
// keyframe on the strip), after the fix it is 1 (only the real member).
//
// RED-FIRST WITNESS (S4): reverted the strip-keyframe `.sel` from `selStripKfSet.has(k.id)`
// back to `selStrip !== null && k.strip === selStrip.id` (the strip-context expression). The
// flow reds at the `selCount === 1` assert: every keyframe on the strip has `.sel`, so the
// count is the strip's full keyframe count (4), not 1. Restored membership; the flow went green.
test("strip keyframe .sel reads membership not strip context (S4)", async ({ page, boot }) => {
    await boot();
    await frameTimeline(page);

    const stripKeyframesOf = (id: number) => kexCall(page, "stripKeyframesOf", id);
    const stripKfPx = () =>
        kexCall(page, "stripKfPx") as Promise<{ id: number; x: number; y: number }[]>;
    const stripKfSelIds = () => kexCall(page, "stripKfSelIds") as Promise<number[]>;

    // a strip [0, 40) with two interior keyframes at s=10 and s=30 — 4 keyframes total
    // (seeded start/end + 2 interior).
    const stripId = (await kexCall(page, "addStripAt", 0, 40, 5)) as number;
    await kexCall(page, "placeStripKf", stripId, 10, 8);
    await kexCall(page, "placeStripKf", stripId, 30, 3);
    await expect.poll(async () => ((await stripKeyframesOf(stripId)) as unknown[]).length).toBe(4);

    // select the strip through a real band click.
    const bandBb = await page.locator(".hbandzone").boundingBox();
    const chartCanvasBb = await page.locator("canvas.chart").boundingBox();
    const stripPx = (await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[];
    const sp = stripPx.find((s) => s.id === stripId);
    if (!bandBb || !chartCanvasBb || !sp) throw new Error("layout not ready");
    const bandY = bandBb.y + bandBb.height / 2;
    await page.mouse.click(chartCanvasBb.x + (sp.x0 + sp.x1) / 2, bandY);
    await expect.poll(async () => kexCall(page, "selectedStrip")).toBe(stripId);

    // click one interior keyframe to select it (replace-select keeps the owning strip).
    const kfPx = await stripKfPx();
    const interior = kfPx.find(
        (k) => k.x > chartCanvasBb.x + sp.x0 + 10 && k.x < chartCanvasBb.x + sp.x1 - 10,
    );
    if (!interior) throw new Error("interior strip keyframe not projected");
    await page.mouse.click(interior.x, interior.y);
    await expect.poll(async () => (await stripKfSelIds()).length).toBe(1);

    // count the `.fpt.sel` elements that are strip keyframes (aria-label "Velocity keyframe").
    // With membership: only the 1 selected keyframe has `.sel`. With strip-context: every
    // keyframe on the strip has `.sel` (count 4). The DOM is paced by the per-RAF tick, so
    // poll until the render catches up rather than reading immediately after the select write.
    await expect
        .poll(async () =>
            page
                .locator(".fpt.sel")
                .evaluateAll(
                    (els) =>
                        els.filter((el) => el.querySelector('[aria-label="Velocity keyframe"]'))
                            .length,
                ),
        )
        .toBe(1);
});

// S9 capture arm 1 (kex2d-event-substrate, F7 finding (a)): a marquee dragged over a strip
// keyframe selects it, and a shift-marquee toggles it — the same arm shape the force-keyframe
// marquee already has ("retained timeline gesture heirs after force position removal", force.pw.ts). Before S9, `marqueeUp`'s
// candidate list was built from `forcePts` alone, so a rubber-band never took a strip keyframe,
// with or without shift. Constructs a real strip via `addStripAt` (a real guarded write,
// `history.addStrip`) with two interior keyframes via `placeStripKf` at known stations, selects
// the strip through a real band click (the sub-selection's own invariant — the same
// precondition `keyframeDown` establishes before ever reaching a strip keyframe), drags a real
// marquee over both interior keyframes, then shift-marquee-toggles one back out.
//
// RED-FIRST WITNESS: reverted `KF_KINDS` to `["force"]` (Timeline.svelte) — `marqueeUp`'s
// resolve loop then never reaches the strip kind at all, reproducing pre-S9 finding (a)
// exactly. The flow reds at the first `stripKfSelIds()` poll (exit 1, timeout: stays `[]` — the
// marquee never selected the interior keyframes). Restored; green.
test("marquee over a strip keyframe selects it, shift-marquee toggles it (S9, F7 finding a)", async ({
    page,
    boot,
}) => {
    await boot();
    await frameTimeline(page);

    const stripKeyframesOf = (id: number) => kexCall(page, "stripKeyframesOf", id);
    const stripKfPx = () =>
        kexCall(page, "stripKfPx") as Promise<{ id: number; x: number; y: number }[]>;
    const stripKfSelIds = () => kexCall(page, "stripKfSelIds") as Promise<number[]>;

    // a strip [0, 40) with two interior keyframes at s=10 and s=30 — the seeded start/end pair
    // (s=0/40) sits well outside the marquee box below.
    const stripId = (await kexCall(page, "addStripAt", 0, 40, 5)) as number;
    await kexCall(page, "placeStripKf", stripId, 10, 8);
    await kexCall(page, "placeStripKf", stripId, 30, 3);
    await expect.poll(async () => ((await stripKeyframesOf(stripId)) as unknown[]).length).toBe(4);

    // select the strip through a real band click first.
    const bandBb = await page.locator(".hbandzone").boundingBox();
    const chartCanvasBb = await page.locator("canvas.chart").boundingBox();
    const stripPx = (await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[];
    const sp = stripPx.find((s) => s.id === stripId);
    if (!bandBb || !chartCanvasBb || !sp) throw new Error("layout not ready");
    const bandY = bandBb.y + bandBb.height / 2;
    await page.mouse.click(chartCanvasBb.x + (sp.x0 + sp.x1) / 2, bandY);
    await expect.poll(async () => kexCall(page, "selectedStrip")).toBe(stripId);

    let kfPx: { id: number; x: number; y: number }[] = [];
    await expect
        .poll(async () => {
            kfPx = await stripKfPx();
            return kfPx.length;
        })
        .toBeGreaterThan(0);
    const ids = (await stripKeyframesOf(stripId)) as { id: number; s: number }[];
    const interior = ids.filter((k) => k.s === 10 || k.s === 30).map((k) => k.id);
    expect(interior.length).toBe(2);
    const pxA = kfPx.find((k) => k.id === interior[0]);
    const pxB = kfPx.find((k) => k.id === interior[1]);
    if (!pxA || !pxB) throw new Error("interior keyframes not projected");

    // a real marquee spanning both interior keyframes (padded past their two distinct v's).
    const xLo = Math.min(pxA.x, pxB.x) - 8;
    const xHi = Math.max(pxA.x, pxB.x) + 8;
    const yLo = Math.min(pxA.y, pxB.y) - 12;
    const yHi = Math.max(pxA.y, pxB.y) + 12;
    await marqueeDrag(page, xLo, yLo, xHi, yHi);
    await expect.poll(async () => (await stripKfSelIds()).length).toBe(2);
    expect((await stripKfSelIds()).sort((a, b) => a - b)).toEqual(interior.sort((a, b) => a - b));

    // shift-marquee over just ONE of them toggles it out.
    await marqueeDrag(page, pxA.x - 8, pxA.y - 12, pxA.x + 8, pxA.y + 12, true);
    await expect.poll(async () => (await stripKfSelIds()).length).toBe(1);
    expect(await stripKfSelIds()).toEqual([interior.find((id) => id !== pxA.id) ?? -1]);
});

// S9 capture arm 2 (kex2d-event-substrate, F7 finding (b)): selecting a keyframe of either kind
// leaves ZERO members selected of the other, in BOTH directions. This flow selects a FORCE
// keyframe first, in both directions, so neither assertion can pass by the other kind having
// already been empty (force.pw.ts's own "one selection model" flow reads as coverage here
// vacuously — its strip keyframe is clicked AFTER a strip-body click already cleared `forces`
// via `selectStrip`'s own `clearAllMembers`, so its "the strip sweep clears it" comment never
// actually exercises `selectStripKf`'s own sweep).
//
// MEASURED, NOT ASSUMED: deleting `sweepOtherKinds` from `selectStripKf`'s replace path ALONE
// does NOT red this flow (exit 0) — `keyframeDown`'s own strip branch re-calls `selectStrip(k.strip)`
// (which clears all members via `clearAllMembers`) whenever `editor.strip` differs from the clicked
// keyframe's owner, and `editor.strip` is ALWAYS nulled by the time this flow re-clicks the strip
// keyframe (the intervening force click ran `selectForce`, which clears all members too). So the
// `sweepOtherKinds` call in `selectStripKf`'s replace path stays as a genuine structural guard
// (the only guard on the plain-click replace path when the owning strip is already selected, so
// `keyframeDown` skips its own `selectStrip` call — see the S2 criterion-(c) unit arm) —
// RED-FIRST WITNESS for the property this arm actually pins: deleting BOTH `selectStrip`'s own
// `clearAllMembers` AND `selectStripKf`'s `sweepOtherKinds` call together reds at
// `await expect.poll(forceSelIds).toEqual([]);` (the first strip-keyframe selection after the force
// click) — exit 1, timeout: `forceSelIds()` stays `[0]`. Restored; green.
// Deleting `selectStripKf`'s `sweepOtherKinds` call ALONE does not red this arm (exit 0) —
// recorded above as the measured finding.
test("selecting a keyframe of either kind clears the other's selection, both directions (S9, F7 finding b)", async ({
    page,
    boot,
}) => {
    await boot();
    await kexCall(page, "seedForceBump");
    await expect.poll(async () => kexCall(page, "forceCount")).toBe(5);
    await frameTimeline(page);

    const forceSelIds = () => kexCall(page, "forceSelIds") as Promise<number[]>;
    const stripKfSelIds = () => kexCall(page, "stripKfSelIds") as Promise<number[]>;
    const stripKfPx = () =>
        kexCall(page, "stripKfPx") as Promise<{ id: number; x: number; y: number }[]>;

    // interior extent — [0, len) would coincide with the leading/trailing force keyframes'
    // own stations (the seeded continuation points `seedForceBump` leaves at each end), and a
    // selected strip's own curve carries a click-to-create hit layer across its whole extent
    // (`chartCreate`'s T2), which would intercept a click aimed at a force diamond sitting on
    // that boundary.
    const len = ((await kexCall(page, "sectionLengths")) as number[])[0];
    const stripId = (await kexCall(page, "addStripAt", len * 0.3, len * 0.9, 4)) as number;
    const kfId = (await kexCall(page, "placeStripKf", stripId, len * 0.6, 6)) as number;

    const bandBb = await page.locator(".hbandzone").boundingBox();
    const chartCanvasBb = await page.locator("canvas.chart").boundingBox();
    const stripPx = (await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[];
    const sp = stripPx.find((s) => s.id === stripId);
    if (!bandBb || !chartCanvasBb || !sp) throw new Error("layout not ready");
    await page.mouse.click(chartCanvasBb.x + (sp.x0 + sp.x1) / 2, bandBb.y + bandBb.height / 2);
    await expect.poll(async () => kexCall(page, "selectedStrip")).toBe(stripId);

    let kfPx: { id: number; x: number; y: number }[] = [];
    await expect
        .poll(async () => {
            kfPx = await stripKfPx();
            return kfPx.some((k) => k.id === kfId);
        })
        .toBe(true);
    const target = kfPx.find((k) => k.id === kfId);
    if (!target) throw new Error("strip keyframe not projected");

    const forceHit = page.locator(".fhit").first(); // force points render first in DOM order
    const forceCenter = async (): Promise<{ x: number; y: number }> => {
        const b = await forceHit.boundingBox();
        if (!b) throw new Error("force diamond not laid out");
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };

    // select the force keyframe first.
    const fp = await forceCenter();
    await page.mouse.click(fp.x, fp.y);
    await expect.poll(async () => (await forceSelIds()).length).toBe(1);

    // now select the strip keyframe — the direction already correct (a plain click
    // replace-selects via `selectStrip`, clearing all members), but re-checked here against
    // a genuinely non-empty force selection.
    await page.mouse.click(target.x, target.y);
    await expect.poll(async () => (await stripKfSelIds()).length).toBe(1);
    await expect.poll(forceSelIds).toEqual([]);

    // re-select the force keyframe again — the direction MISSING before S9: `selectStripKf`
    // called no sweep of its own, so the force keyframe stayed selected alongside it.
    const fp2 = await forceCenter();
    await page.mouse.click(fp2.x, fp2.y);
    await expect.poll(async () => (await forceSelIds()).length).toBe(1);
    await expect.poll(stripKfSelIds).toEqual([]);
});

// S9 capture arm 3 (kex2d-event-substrate, F7): click, shift-click-toggle and empty-chart
// deselect each assert the SAME observable for a force keyframe and a strip keyframe — the
// round-2 standard's own symmetry check. force.pw.ts's "one selection model" flow already
// drives click/shift-toggle for both kinds through the RULER/LANE rows' own empty-space click
// (`startScrub`/`bandDown`); this arm is the CHART's own empty click — `marqueeUp`'s plain-
// click branch — which section.pw.ts only ever drove for the strip side before S9.
//
// RED-FIRST WITNESS: deleted the `deselectKfKinds()` call from `marqueeUp`'s plain-click branch
// (Timeline.svelte) — the flow reds at the first post-click `forceSelIds()` poll (exit 1,
// timeout: stays non-empty — the force keyframe stayed selected after the empty-chart click).
// Restored; green.
test("click, shift-click-toggle and empty-chart deselect read the same for a force keyframe and a strip keyframe (S9, F7)", async ({
    page,
    boot,
}) => {
    await boot();
    await kexCall(page, "seedForceBump");
    await expect.poll(async () => kexCall(page, "forceCount")).toBe(5);
    await frameTimeline(page);

    const forceSelIds = () => kexCall(page, "forceSelIds") as Promise<number[]>;
    const stripKfSelIds = () => kexCall(page, "stripKfSelIds") as Promise<number[]>;

    // interior extent — see the sibling arm's own note on why [0, len) is unsafe here.
    const len = ((await kexCall(page, "sectionLengths")) as number[])[0];
    const stripId = (await kexCall(page, "addStripAt", len * 0.3, len * 0.9, 4)) as number;
    const kfA = (await kexCall(page, "placeStripKf", stripId, len * 0.6, 6)) as number;

    const bandBb = await page.locator(".hbandzone").boundingBox();
    const chartCanvasBb = await page.locator("canvas.chart").boundingBox();
    if (!bandBb || !chartCanvasBb) throw new Error("layout not ready");
    const bandY = bandBb.y + bandBb.height / 2;
    const selectStripBody = async (): Promise<void> => {
        const sp = (
            (await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[]
        ).find((s) => s.id === stripId);
        if (!sp) throw new Error("created strip has no band px");
        await page.mouse.click(chartCanvasBb.x + (sp.x0 + sp.x1) / 2, bandY);
        await expect.poll(async () => kexCall(page, "selectedStrip")).toBe(stripId);
    };
    const kfPxOf = async (id: number): Promise<{ x: number; y: number }> => {
        const pts = (await kexCall(page, "stripKfPx")) as { id: number; x: number; y: number }[];
        const p = pts.find((k) => k.id === id);
        if (!p) throw new Error(`strip keyframe ${id} not laid out`);
        return p;
    };
    const forceCenter = async (): Promise<{ x: number; y: number }> => {
        const b = await page.locator(".fhit").first().boundingBox();
        if (!b) throw new Error("force diamond not laid out");
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };
    const dockBb = await page.locator(".dock .body").boundingBox();
    if (!dockBb) throw new Error("dock body not laid out");
    const emptyX = dockBb.x + dockBb.width * 0.5;
    const emptyY = dockBb.y + CHART_TOP + 4;

    // ── FORCE: click selects, shift-click toggles it back out, click re-selects, empty-chart
    // click clears — ONE path (`keyframeDown`/`marqueeUp`'s own `kfDesc`). ──
    let fp = await forceCenter();
    await page.mouse.click(fp.x, fp.y);
    await expect.poll(async () => (await forceSelIds()).length).toBe(1);
    await page.keyboard.down("Shift");
    await page.mouse.click(fp.x, fp.y);
    await page.keyboard.up("Shift");
    await expect.poll(async () => (await forceSelIds()).length).toBe(0); // toggled back OUT
    fp = await forceCenter();
    await page.mouse.click(fp.x, fp.y);
    await expect.poll(async () => (await forceSelIds()).length).toBe(1);
    await page.mouse.click(emptyX, emptyY);
    await expect.poll(async () => (await forceSelIds()).length).toBe(0);

    // ── STRIP KEYFRAME: the SAME three steps, the SAME observable shape — ONE path. ──
    await selectStripBody();
    let a = await kfPxOf(kfA);
    await page.mouse.click(a.x, a.y);
    await expect.poll(async () => (await stripKfSelIds()).length).toBe(1);
    await page.keyboard.down("Shift");
    await page.mouse.click(a.x, a.y);
    await page.keyboard.up("Shift");
    await expect.poll(async () => (await stripKfSelIds()).length).toBe(0); // toggled back OUT
    await selectStripBody();
    a = await kfPxOf(kfA);
    await page.mouse.click(a.x, a.y);
    await expect.poll(async () => (await stripKfSelIds()).length).toBe(1);
    await page.mouse.click(emptyX, emptyY);
    await expect.poll(async () => (await stripKfSelIds()).length).toBe(0);
});

// S7 (kex2d-event-substrate, F5): the velocity value popup. A strip keyframe's typed `v`
// field and the one-shot's typed `v` field read/edit through the SAME popover substrate —
// the `.ptip`/`.fld` markup and `kfFieldEdit`/`oneShotFieldEdit`'s shared begin/set/commit
// gesture shape, never a parallel twin (this stage's own adversarial named subject). This
// flow drives BOTH through the real pointer: selects a strip keyframe's diamond, types a new
// `v`, and reads the bake move just inside that keyframe's own station (`vAtD`, offset off
// the edge boundary — see `readD` below); selects the one-shot glyph — its POSITION field is
// LOCKED (disabled, `d = 0`, Locked decision F5) while its `v` field still edits — types a
// new `v`, and reads the bake move (`v0`, `entrySpeed`'s own readback).
//
// RED-FIRST WITNESS (successor executor, re-witnessed against the branch tree): deleted the
// `setOneShotValue(ecs, os.id, v);` line from `oneShotFieldEdit` (Timeline.svelte) — the flow
// reds at the `v0` poll (exit 1, timeout: `v0()` never moved off `v0Before`). Restored
// byte-identical; green. A second witness on the strip-keyframe half: deleted the same
// line's twin in `kfFieldEdit`'s strip branch (`setStripKeyframe(ecs, k.id, ...)`) — reds
// identically at the `vAtD` poll (exit 1). Restored byte-identical.
test("velocity value popup: typed edits move the bake, one-shot position stays locked (F5)", async ({
    page,
    boot,
}) => {
    await boot();
    await seedHill(page);
    await frameTimeline(page);

    const stripsOf = () => kexCall(page, "stripsOf", 0);
    const stripKeyframesOf = (id: number) => kexCall(page, "stripKeyframesOf", id);
    const stripKfPx = () => kexCall(page, "stripKfPx");
    const vAtD = (d: number) => kexCall(page, "vAtD", d);
    const v0 = () => kexCall(page, "v0");
    const oneShotPx = () => kexCall(page, "oneShotPx");
    const oneShotVal = () => kexCall(page, "oneShot");

    // create a strip (right-click on the band → Add velocity strip, `seed()` authors none —
    // only the track-start one-shot); creation seeds two keyframes at start/end (S4).
    const bandBb0 = await page.locator(".hbandzone").boundingBox();
    const clipBb = await page.locator(".clip").first().boundingBox();
    if (!bandBb0 || !clipBb) throw new Error("header band / clip not laid out");
    const bandY0 = bandBb0.y + bandBb0.height / 2;
    const bandX = clipBb.x + clipBb.width * 0.5;
    await page.mouse.click(bandX, bandY0, { button: "right" });
    await expect(page.locator(".smenu")).toBeVisible();
    await clickMenuItem(page, ".smenu", "Add velocity strip");
    await expect.poll(async () => (await stripsOf()).length).toBe(1);
    await frames(page, 2); // bandStrips/selStrip settle behind the RAF tick (`stripKfPx`'s own note)

    // ── strip keyframe half: select the created strip's first keyframe, type a new v ──
    const strips = (await stripsOf()) as { id: number; start: number; end: number }[];
    const strip0 = strips[0];
    if (!strip0) throw new Error("no seeded strip");
    const kfs = (await stripKeyframesOf(strip0.id)) as { id: number; s: number; v: number }[];
    const kf0 = kfs[0];
    if (!kf0) throw new Error("seeded strip has no keyframes");

    await expect.poll(async () => (await stripKfPx()).length).toBeGreaterThan(0);
    const kfPx = (await stripKfPx()) as { id: number; x: number; y: number }[];
    const kf0Px = kfPx.find((k) => k.id === kf0.id);
    if (!kf0Px) throw new Error("seeded keyframe not projected on screen");
    await page.mouse.click(kf0Px.x, kf0Px.y);

    const vField = page.locator('.ptip input[aria-label="Keyframe velocity (m/s)"]');
    await expect(vField).toBeVisible();
    // read the bake just INSIDE kf0's own station, never AT it: `edgeStrips`' boundary map
    // ties a station exactly on an edge to the EARLIER edge (`boundary`'s own "ties toward
    // the earlier edge" law), so `d = kf0.s` samples the edge just outside the override band
    // — measured 6.80 (unmoved) at `kf0.s` against 10.75 (moved) at `kf0.s + 0.5` on this
    // exact fixture. `readD` stays off the boundary and inside the strip's own extent.
    const readD = kf0.s + 0.5;
    const vBefore = (await vAtD(readD)) as number;
    const newKfV = kf0.v + 4;
    await vField.fill(String(newKfV));
    await page.keyboard.press("Enter");
    await frames(page, 4); // the bake reads through `bakeOut`'s RAF-tick gate (Residue: one frame behind)
    await expect.poll(async () => vAtD(readD), { timeout: 10000 }).not.toBeCloseTo(vBefore, 2);
    // within 0.5 m/s of the typed value, never exact equality: `readD` sits a half-metre
    // inside the strip's own extent (above), so the held-v² curve interpolates slightly
    // toward the strip's OTHER (unedited) keyframe over that offset.
    await expect.poll(async () => Math.abs((await vAtD(readD)) - newKfV)).toBeLessThan(0.5);

    await page.keyboard.press("Escape"); // clear the strip-keyframe popover before the one-shot's

    // ── one-shot half: select the glyph, confirm the position field is LOCKED, type a new v ──
    const chartCanvasBb = await page.locator("canvas.chart").boundingBox();
    if (!chartCanvasBb) throw new Error("chart canvas not laid out");
    const bandBb = await page.locator(".hbandzone").boundingBox();
    if (!bandBb) throw new Error("header band not laid out");
    const bandY = bandBb.y + bandBb.height / 2;
    const glyphLocalX = (await oneShotPx()) as number;
    await page.mouse.click(chartCanvasBb.x + glyphLocalX, bandY);
    await expect.poll(async () => kexCall(page, "oneShotSelected")).toBe(true);

    const posField = page.locator(".ptip .fld input[disabled]");
    await expect(posField).toBeVisible();
    await expect(posField).toBeDisabled();

    const v0Before = (await v0()) as number;
    const osVal = (await oneShotVal()) as { id: number; value: number };
    const newV0 = osVal.value + 5;
    const oneShotVField = page.locator('.ptip input[aria-label="Initial velocity (m/s)"]');
    await expect(oneShotVField).toBeVisible();
    await oneShotVField.fill(String(newV0));
    await page.keyboard.press("Enter");
    await expect.poll(v0).not.toBeCloseTo(v0Before, 2);
    await expect.poll(v0).toBeCloseTo(newV0, 2);

    // the position field never routed a write: still showing the locked station, never the
    // typed v's station (there is none — the one-shot has no `s` to author).
    await expect(posField).toBeDisabled();
});

// S10 (kex2d-event-substrate, F8): `scrubStart` (Timeline.svelte) resolved its subject from
// `selPoint` alone and was force-only by construction — the strip keyframe and one-shot
// popovers opted out of the label scrub in a comment beside them. This flow drives BOTH new
// arms through the real pointer: a strip keyframe's own position AND value labels, and the
// one-shot's own value label — each moving the bake (read through `vAtD`/`v0`, the same
// readback F5's typed-field arm above uses), same arm shape as the force keyframe's
// pre-existing scrub (`affordance.pw.ts`'s "popover key scrub affordance — force keyframe
// control").
//
// RED-FIRST WITNESS: nulled `scrubSubject`'s `k`/`os` locals (`selStripKfPt`/`selOneShotPt`
// forced to `null`, the force-only pre-S10 read) — the flow reds at the strip position poll
// (exit 1, timeout: the moved keyframe's own `s` never exceeds `readD` — the label's
// `onpointerdown` still fires but `scrubSubject()` resolves no subject to scrub, so
// `labelScrub` never runs). Restored byte-identical; green.
test("popup label scrub reaches the strip keyframe and one-shot popovers (S10, F8)", async ({
    page,
    boot,
}) => {
    await boot();
    await frameTimeline(page);

    const stripId = await kexCall(page, "addStripAt", 0, 12, 5);
    if (stripId === null) throw new Error("strip create refused");
    await expect.poll(async () => (await kexCall(page, "stripsOf", 0)).length).toBe(1);
    await frames(page, 2); // bandStrips/stripKfPts settle behind the RAF tick (F5's own note)
    // a third, DISTINCT-valued keyframe: `addStripAt`'s two boundary keyframes share one value
    // (S4's own seed, `createStrip`'s `value` param at both ends), which would leave the curve
    // FLAT regardless of where either boundary sits — a position move needs a differing
    // neighbour to be visible in the sampled curve at all.
    await kexCall(page, "placeStripKf", stripId, 6, 12);

    const stripKfPx = () =>
        kexCall(page, "stripKfPx") as Promise<{ id: number; x: number; y: number }[]>;
    const stripKeyframesOf = () =>
        kexCall(page, "stripKeyframesOf", stripId) as Promise<
            { id: number; s: number; v: number }[]
        >;
    const vAtD = (d: number) => kexCall(page, "vAtD", d) as Promise<number>;
    await expect.poll(async () => (await stripKfPx()).length).toBe(3);

    // ── position label: drag the start keyframe (s = 0) rightward, past a readback station ──
    const kfs = await stripKeyframesOf();
    const kf0 = kfs.find((k) => k.s === 0);
    if (!kf0) throw new Error("seeded start keyframe not found");
    let px = (await stripKfPx()).find((k) => k.id === kf0.id);
    if (!px) throw new Error("start keyframe not projected");
    await page.mouse.click(px.x, px.y);
    await expect.poll(() => kexCall(page, "stripKfSelIds")).toEqual([kf0.id]);

    const readD = 3; // between the start keyframe (s=0) and the mid one (s=6, v=12) — inside
    // the interpolated region until the start keyframe's own station passes it, at which point
    await frames(page, 4); // allow the authored strip keyframe to reach the bake before sampling
    const vBefore = await vAtD(readD);
    // it falls into the flat extrapolation BEFORE the earliest keyframe (S5's own out-of-extent
    // resolution) — a real, sampled change, not just a stored-field readback.
    const posKey = page.locator(".ptip .fld:nth-of-type(1) .key");
    const posBox = await posKey.boundingBox();
    if (!posBox) throw new Error("strip keyframe position scrub handle not laid out");
    await page.mouse.move(posBox.x + posBox.width / 2, posBox.y + posBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(posBox.x + posBox.width / 2 + 100, posBox.y + posBox.height / 2, {
        steps: 10,
    });
    await page.mouse.up();
    await frames(page, 4); // the bake reads through `bakeOut`'s RAF-tick gate (Residue: one frame behind)
    await expect
        .poll(async () => (await stripKeyframesOf()).find((k) => k.id === kf0.id)?.s)
        .toBeGreaterThan(readD);
    expect(await vAtD(readD)).not.toBeCloseTo(vBefore, 2);

    // ── value label: drag the mid keyframe's own v ──
    const midKf = (await stripKeyframesOf()).find((k) => k.s === 6);
    if (!midKf) throw new Error("mid keyframe not found");
    px = (await stripKfPx()).find((k) => k.id === midKf.id);
    if (!px) throw new Error("mid keyframe not projected");
    // The old popover deliberately covers the next diamond: without that geometry precondition,
    // elementFromPoint could report the diamond even if dismissal did nothing. In one browser task,
    // dispatch Escape, permit Svelte's microtask flush, and inspect the hit owner before any RAF.
    // `coveredByPopover` is a `!!` coercion, not `!== null`: `before` is nullable, and
    // `undefined !== null` reads true, which would pass the precondition on a dead hit point.
    //
    // This is the S4c dismissal-guard witness, driven through this flow rather than a dedicated
    // test — a repair-added arm, regression guard status, mutation-tested twice: (a) pre-fix
    // Timeline.svelte (no `stripTipDismissed` at all) reds this same `diamondAfterFlush`
    // assertion, exit 1 — the stale `.ptip` still owns the covered point after Escape's
    // microtask flush. (b) with the fix in place, deleting the `&& !stripTipDismissed` guard
    // term at the popover's render condition reds the same assertion the same way, exit 1 —
    // the popover keeps rendering (and hit-testing) after Escape, so nothing moved the hit
    // owner to the diamond. Both mutations restored byte-identical after; green.
    // What this arm does NOT discriminate: it dispatches only Escape, so the guard's reset
    // sites — the undo/redo keydown legs, `selectMany`'s marquee reset, `keyframeDown`'s
    // pointer reset — are unarmed here; deleting any reset leaves this assertion green. The
    // resets are enumeration-verified only (every subject-establishing route reviewed twice).
    const hitOwners = await page.evaluate(async ({ x, y }) => {
        const owner = () => document.elementFromPoint(x, y);
        const before = owner();
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await Promise.resolve();
        const after = owner();
        return {
            coveredByPopover: !!before?.closest(".ptip"),
            diamondAfterFlush: after?.classList.contains("fhit") ?? false,
        };
    }, px);
    expect(hitOwners.coveredByPopover).toBe(true);
    expect(hitOwners.diamondAfterFlush).toBe(true);
    await page.mouse.click(px.x, px.y);
    await expect.poll(() => kexCall(page, "stripKfSelIds")).toEqual([midKf.id]);

    const vReadD = 6.5; // just past the mid keyframe's own station, inside its influence
    const vBefore2 = await vAtD(vReadD);
    const vKey = page.locator(".ptip .fld:nth-of-type(2) .key");
    const vBox = await vKey.boundingBox();
    if (!vBox) throw new Error("strip keyframe value scrub handle not laid out");
    await page.mouse.move(vBox.x + vBox.width / 2, vBox.y + vBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(vBox.x + vBox.width / 2 + 60, vBox.y + vBox.height / 2, { steps: 10 });
    await page.mouse.up();
    await frames(page, 4);
    await expect.poll(() => vAtD(vReadD), { timeout: 1000 }).not.toBeCloseTo(vBefore2, 2);

    // ── one-shot value label: moves v0, the derived entry speed's own readback ──
    await page.keyboard.press("Escape");
    const chartCanvasBb = await page.locator("canvas.chart").boundingBox();
    if (!chartCanvasBb) throw new Error("chart canvas not laid out");
    const bandBb = await page.locator(".hbandzone").boundingBox();
    if (!bandBb) throw new Error("header band not laid out");
    const bandY = bandBb.y + bandBb.height / 2;
    const glyphLocalX = (await kexCall(page, "oneShotPx")) as number;
    await page.mouse.click(chartCanvasBb.x + glyphLocalX, bandY);
    await expect.poll(async () => kexCall(page, "oneShotSelected")).toBe(true);
    const v0Before = (await kexCall(page, "v0")) as number;
    const osVKey = page.locator(".ptip .fld:nth-of-type(2) .key");
    const osVBox = await osVKey.boundingBox();
    if (!osVBox) throw new Error("one-shot value scrub handle not laid out");
    await page.mouse.move(osVBox.x + osVBox.width / 2, osVBox.y + osVBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(osVBox.x + osVBox.width / 2 + 60, osVBox.y + osVBox.height / 2, {
        steps: 10,
    });
    await page.mouse.up();
    await expect.poll(() => kexCall(page, "v0"), { timeout: 1000 }).not.toBeCloseTo(v0Before, 2);
});

// S10 (kex2d-event-substrate, F8): a locked field refuses the scrub the way it already refuses
// the typed field — pin mode over the VALUE (a force keyframe outside the pinning section, the
// pre-existing lockdown `scrubStart` always carried, now reached through `scrubSubject`), and
// the one-shot's own POSITION, locked unconditionally (`scrubSubject`'s `pos: null` — F5's own
// invariant, `d = 0`, never `sectionEditable`).
//
// RED-FIRST WITNESS (two independent mutations, each restored byte-identical after): (1) deleted
// the `if (subj.val.locked) return;` guard in `scrubStart`'s value branch — the pin-mode half of
// this flow reds (exit 1, `toBeCloseTo` fails: the locked keyframe's `g` moved 0.6 under the
// drag instead of holding). (2) replaced the one-shot arm's `pos: null` with a live `pos` object
// (seed 0, unbounded, wired to `setOneShotValue`) — the one-shot half reds (exit 1, `toEqual`
// fails: `oneShot().value` moved from 10 to 3 under the position-label drag it must refuse).
test("popup label scrub refuses on a locked field — pin mode for the value, always for the one-shot's position (S10, F8)", async ({
    page,
    boot,
}) => {
    await boot();
    await seedHill(page);
    await kexCall(page, "convert"); // section 0 → FORCE, so it carries authored keyframes
    await kexCall(page, "seedForceBump");
    await expect.poll(async () => (await kexCall(page, "forces")).length).toBe(5);
    // section 1 → FORCE too: the Pin row only appears on a FORCE section (`menus.ts`'s own
    // `s.kind === SectionKind.Force` guard), so the section being PINNED must be force-kind —
    // the lockdown it OPENS falls on every OTHER section regardless of kind, which is what
    // leaves section 0's own keyframe locked.
    await kexCall(page, "append", 1);
    await expect.poll(() => kexCall(page, "sectionCount")).toBe(2);
    await frameTimeline(page);

    // pin section 1 (the appended FORCE section) — the section-selection this opens is a
    // DIFFERENT selectable kind than a force keyframe (a plain click replace-selects, clearing
    // all members), so the keyframe is selected AFTER the mode opens, not before it — selecting it
    // first would only be cleared by entering the mode.
    await page.locator(".clip").nth(1).click({ button: "right" });
    await expect(page.locator(".ctxmenu")).toBeVisible();
    await clickMenuItem(page, ".ctxmenu", "Pin");
    await expect.poll(() => kexCall(page, "pinning")).toBe(true);

    // select a force keyframe on the now-LOCKED section 0 through the real pointer — "another
    // section's force keys SELECT but never drag" (`keyframeDown`'s own comment): the click
    // still lands.
    const dia = await page.locator(".fpt").nth(2).boundingBox();
    if (!dia) throw new Error("force keyframe 2 not laid out");
    await page.mouse.click(dia.x + dia.width / 2, dia.y + dia.height / 2);
    await expect.poll(async () => (await kexCall(page, "forceSelIds")).length).toBe(1);
    const sel = await kexCall(page, "forceSelActive");
    const gOf = async () => (await kexCall(page, "forceU")).find((p) => p.id === sel)?.g;
    const gBefore = await gOf();
    if (gBefore === undefined) throw new Error("selected keyframe not readable");

    const gField = page.locator('.ptip input[aria-label="Point force (g)"]');
    await expect(gField).toBeDisabled();
    const gKey = page.locator(".ptip .fld:nth-of-type(2) .key");
    const gBox = await gKey.boundingBox();
    if (!gBox) throw new Error("g scrub handle not laid out under lockdown");
    await page.mouse.move(gBox.x + gBox.width / 2, gBox.y + gBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(gBox.x + gBox.width / 2 + 60, gBox.y + gBox.height / 2, { steps: 10 });
    await page.mouse.up();
    await frames(page, 2);
    expect(await gOf()).toBeCloseTo(gBefore, 6); // locked: the scrub never wrote

    await page.keyboard.press("Escape"); // clear the force keyframe popover
    await page.locator(".pinpanel .exit").click(); // discard the (empty) sandbox, exit the mode
    await expect.poll(() => kexCall(page, "pinning")).toBe(false);

    // ── the one-shot's own position label: ALWAYS locked — d = 0 is its whole invariant ──
    const chartCanvasBb = await page.locator("canvas.chart").boundingBox();
    if (!chartCanvasBb) throw new Error("chart canvas not laid out");
    const bandBb = await page.locator(".hbandzone").boundingBox();
    if (!bandBb) throw new Error("header band not laid out");
    const bandY = bandBb.y + bandBb.height / 2;
    const glyphLocalX = (await kexCall(page, "oneShotPx")) as number;
    await page.mouse.click(chartCanvasBb.x + glyphLocalX, bandY);
    await expect.poll(async () => kexCall(page, "oneShotSelected")).toBe(true);
    const before = (await kexCall(page, "oneShot")) as { id: number; value: number };

    const posKey = page.locator(".ptip .fld:nth-of-type(1) .key");
    const posBox = await posKey.boundingBox();
    if (!posBox) throw new Error("one-shot position scrub handle not laid out");
    await page.mouse.move(posBox.x + posBox.width / 2, posBox.y + posBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(posBox.x + posBox.width / 2 + 60, posBox.y + posBox.height / 2, {
        steps: 10,
    });
    await page.mouse.up();
    await frames(page, 2);
    expect(await kexCall(page, "oneShot")).toEqual(before); // nothing to scrub — unchanged
});

// S8 (kex2d-event-substrate, F6): the one-shot glyph's own hit priority at `d = 0` — when a
// velocity strip ALSO starts there, the glyph's own screen station and the band's own left
// edge coincide at minimum pan (`bandZoneX0`, Timeline.svelte). A click on the glyph's LEFT
// half (inside its own hit radius, `STRIP_HIT_R`, but past the pre-fix band rect's un-widened
// `LEFT_GUT` edge) used to reach no DOM element at all — never `bandDown`, so
// `classifyOneShotHit`'s own precedence check there (S3, already correct) was unreachable for
// that half; the coincident strip's own edge was the only affordance left standing in the dead
// zone. The fix widens `.hbandzone`'s own left edge to cover the glyph's full hit radius
// instead of adding a second DOM element (the Locked-decision "ONE band-wide hit rect" stands).
//
// RED-FIRST WITNESS: reverted `bandZoneX0` to its pre-fix unconditional `return LEFT_GUT;` —
// the flow reds at the `oneShotSelected` poll (exit 1, timeout: stays `false` — the click on
// the glyph's left half never reaches `bandDown` at all). Restored byte-identical; green.
test("one-shot glyph's left half selects it, even with a coincident strip at d = 0 (F6)", async ({
    page,
    boot,
}) => {
    await boot();
    await frameTimeline(page);

    // a strip starting exactly at d = 0 — the coincident-edge case the finding names. Direct
    // ECS write (`addStripAt`, a real guarded `history.addStrip`): the pointer-driven "Add
    // velocity strip" menu can't guarantee an exact station (`substrate.pw.ts`'s own reason).
    await kexCall(page, "addStripAt", 0, 10, 7);
    await expect
        .poll(async () => ((await kexCall(page, "stripsOf", 0)) as unknown[]).length)
        .toBe(1);
    await frames(page, 2); // bandStrips settle behind the RAF tick (the F5 test's own note)

    const glyphLocalX = (await kexCall(page, "oneShotPx")) as number;
    const chartCanvasBb = await page.locator("canvas.chart").boundingBox();
    if (!chartCanvasBb) throw new Error("chart canvas not laid out");
    const bandBb = await page.locator(".hbandzone").boundingBox();
    if (!bandBb) throw new Error("header band not laid out");
    const bandY = bandBb.y + bandBb.height / 2;

    // the glyph's own LEFT half: 3px inside its 6px hit radius (`STRIP_HIT_R`), on the side
    // the pre-fix band rect never covered (`bandBb.x` itself reads `LEFT_GUT`, unwidened, at
    // minimum pan — the click below lands strictly left of it).
    await page.mouse.click(chartCanvasBb.x + glyphLocalX - 3, bandY);
    await expect.poll(async () => kexCall(page, "oneShotSelected")).toBe(true);
    // the coincident strip, never selected — the glyph won the hit test, not its edge.
    await expect.poll(async () => kexCall(page, "selectedStrip")).toBe(null);
});

// S1 capture arm: keyframeDown's multi-member drag for strip keyframes — the offset-preserving
// path. keyframeDown (Timeline.svelte:1498) sets up the drag set from editor.stripKfs.ids:
// when multiple strip keyframes are selected (shift-click toggles into the set), the drag
// moves ALL members by one shared delta, preserving their relative offsets. Each member's
// `lo` is `sp.start` (the strip's start), not 0 — the lower bound that keeps a keyframe inside
// its strip. This flow constructs a real strip with three keyframes, selects two by real
// pointer events (click + shift-click), drags one, and asserts both moved by the same delta.
//
// RED-FIRST WITNESS: deleted the multi-member drag setup in keyframeDown's strip branch
// (Timeline.svelte ~1556-1559): replaced `const set = editor.stripKfs.ids; const members =
// set.size > 1 ? stripKfPts.filter((sp) => set.has(sp.id)) : [k]; dragKfMembers = members.map(
// (sp) => ({ id: sp.id, s0: sp.s, v0: sp.v, len: sp.end, lo: sp.start, section: sp.section }))`
// with `dragKfMembers = [{ id: k.id, s0: k.s, v0: k.v, len: k.end, lo: k.start, section: k.section }]`.
// The flow red at the assert that both selected keyframes moved: only the dragged keyframe's
// s changed, the other's stayed at its pre-drag value. Restored the multi-member setup; green.
test("strip keyframe multi-member drag", async ({ page, boot }) => {
    await boot();
    await seedHill(page);
    await frameTimeline(page);

    const stripsOf = () => kexCall(page, "stripsOf", 0);
    const stripKeyframesOf = (id: number) => kexCall(page, "stripKeyframesOf", id);
    const stripKfPx = () => kexCall(page, "stripKfPx");
    const stripKfSelIds = () => kexCall(page, "stripKfSelIds");
    const xView = () => kexCall(page, "xView");
    const vRange = () => kexCall(page, "vRange");

    // Create a strip (right-click on the band → Add velocity strip). `seed()` (S3) carries no
    // strip of its own (the track-start one-shot is a distinct point kind), so the count goes
    // 0 → 1; address the new strip by id.
    const beforeStrips = (await stripsOf()) as { id: number }[];
    const bandBb = await page.locator(".hbandzone").boundingBox();
    const clipBb = await page.locator(".clip").first().boundingBox();
    if (!bandBb || !clipBb) throw new Error("header band / clip not laid out");
    const bandY = bandBb.y + bandBb.height / 2;
    const bandX = clipBb.x + clipBb.width * 0.3;
    await page.mouse.click(bandX, bandY, { button: "right" });
    await expect(page.locator(".smenu")).toBeVisible();
    await clickMenuItem(page, ".smenu", "Add velocity strip");
    await expect.poll(async () => (await stripsOf()).length).toBe(beforeStrips.length + 1);
    await expect.poll(async () => await kexCall(page, "selectedStrip")).not.toBe(null);
    // Get the new strip's seeded keyframes — one at its own start, one at its own end (S4's
    // seeded-boundary-keyframes idiom). `stripDefaultExtentAt` (S2: track-global, no longer
    // clamped to a single section's own authored `Section.length`, which reads 0 for a geo
    // section) grows the created span toward the default length off the click's min-extent
    // edge, so on this hill (a geo section) the two seeded keyframes land well apart already —
    // no separate widen/separate-the-coincident-pair choreography needed to spread them.
    const beforeIds = new Set(beforeStrips.map((s) => s.id));
    const created = ((await stripsOf()) as { id: number }[]).find((s) => !beforeIds.has(s.id));
    if (!created) throw new Error("newly-created strip not found");
    const stripId = created.id;
    const seededIds = new Set(
        ((await stripKeyframesOf(stripId)) as { id: number; s: number; v: number }[]).map(
            (k) => k.id,
        ),
    );
    expect(seededIds.size).toBe(2);

    const strip = (
        (await stripsOf()) as { id: number; start: number; end: number; value: number }[]
    ).find((s) => s.id === stripId);
    if (!strip) throw new Error("created strip not found");
    const [, pxPerU] = await xView();
    const [vLo, vHi] = await vRange();
    const dockBb = await page.locator(".dock .body").boundingBox();
    if (!dockBb) throw new Error("dock body not laid out");
    const chartTop = dockBb.y + CHART_TOP;
    const chartBot = dockBb.y + dockBb.height - CHART_BOT_PAD;
    const vToY = (v: number): number =>
        chartTop + (1 - (v - vLo) / (vHi - vLo)) * (chartBot - chartTop);

    // identify start (smaller s) and end (larger s) among the two seeded keyframes.
    let kfs = (await stripKeyframesOf(strip.id)) as { id: number; s: number; v: number }[];
    const seededKfs = kfs.filter((k) => seededIds.has(k.id)).sort((a, b) => a.s - b.s);
    const startKf = seededKfs[0]; // smaller s = start
    const endKf = seededKfs[1]; // larger s = end
    if (!startKf || !endKf) throw new Error("start/end keyframe not found");

    // Create a third keyframe at the strip's MIDPOINT — off both edges.
    const stripMidS = (strip.start + strip.end) / 2;
    const stripCenterPx = clipBb.x + stripMidS * pxPerU;
    const stripValueY = vToY(strip.value);
    await page.mouse.dblclick(stripCenterPx, stripValueY);
    await expect.poll(async () => (await stripKeyframesOf(strip.id)).length).toBe(3);
    kfs = (await stripKeyframesOf(strip.id)) as { id: number; s: number; v: number }[];
    const midKf = kfs.find((k) => !seededIds.has(k.id));
    if (!midKf) throw new Error("midpoint keyframe not found");

    // Poll for the start and midpoint keyframes' diamonds to be projected on screen.
    await expect
        .poll(async () => {
            const px = (await stripKfPx()) as { id: number; x: number; y: number }[];
            return px.find((k) => k.id === startKf.id) ?? null;
        })
        .not.toBeNull();
    await expect
        .poll(async () => {
            const px = (await stripKfPx()) as { id: number; x: number; y: number }[];
            return px.find((k) => k.id === midKf.id) ?? null;
        })
        .not.toBeNull();
    const kfPxAll = (await stripKfPx()) as { id: number; x: number; y: number }[];
    const startKfPx = kfPxAll.find((k) => k.id === startKf.id)!;
    const midKfPx = kfPxAll.find((k) => k.id === midKf.id)!;

    // Click the start keyframe to select it (set = {startKf}).
    await page.mouse.click(startKfPx.x, startKfPx.y);
    await expect.poll(async () => (await stripKfSelIds()).length).toBe(1);

    // Shift-click the midpoint keyframe to toggle it into the set (set = {startKf, midKf}).
    await page.keyboard.down("Shift");
    await page.mouse.click(midKfPx.x, midKfPx.y);
    await page.keyboard.up("Shift");
    await expect.poll(async () => (await stripKfSelIds()).length).toBe(2);

    // Record pre-drag s values for both selected keyframes.
    kfs = (await stripKeyframesOf(strip.id)) as { id: number; s: number; v: number }[];
    const startSBefore = kfs.find((k) => k.id === startKf.id)!.s;
    const midSBefore = kfs.find((k) => k.id === midKf.id)!.s;

    // Re-read the start keyframe's pixel position right before the drag.
    const dragKfPx = (await stripKfPx()) as { id: number; x: number; y: number }[];
    const dragStartPx = dragKfPx.find((k) => k.id === startKf.id)!;

    // Drag the start keyframe to the RIGHT (with Ctrl to bypass snap). Both selected members
    // must move by the same delta — the multi-member drag's offset-preserving path. The drag
    // is 20 px, well past SNAP_PX (8), and held at the same y so only s is under test.
    const DxPx = 20;
    await page.mouse.move(dragStartPx.x, dragStartPx.y);
    await page.keyboard.down("Control");
    await page.mouse.down();
    await page.mouse.move(dragStartPx.x + DxPx, dragStartPx.y, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up("Control");

    // Assert BOTH keyframes moved by the same non-zero delta.
    kfs = (await stripKeyframesOf(strip.id)) as { id: number; s: number; v: number }[];
    const startSAfter = kfs.find((k) => k.id === startKf.id)!.s;
    const midSAfter = kfs.find((k) => k.id === midKf.id)!.s;
    const startDelta = startSAfter - startSBefore;
    const midDelta = midSAfter - midSBefore;
    const expectedDs = DxPx / pxPerU;
    const tol = 2 / pxPerU;
    expect(Math.abs(startDelta)).toBeGreaterThan(tol); // it actually moved
    expect(Math.abs(startDelta - expectedDs)).toBeLessThan(tol); // moved by the cursor delta
    expect(Math.abs(startDelta - midDelta)).toBeLessThan(tol); // same delta (offset preserved)
});

// S1 capture arm: the keyboard handler's strip-keyframe arrow-nudge branch
// (Timeline.svelte:3796-3828). When a strip keyframe is selected and the pointer is over the
// timeline, ArrowLeft/Right/Up/Down nudges the selected set through nudgeKeyframes, supplying
// each member's `lo: m.start` (the strip's start) as the lower bound — not 0. This flow
// constructs a real strip keyframe, selects it, presses ArrowRight, and asserts the keyframe
// moved to the next 0.1 grid position (NUDGE_S = 0.1). Then presses ArrowLeft to nudge back.
//
// RED-FIRST WITNESS: deleted the arrow-nudge `else if` branch (Timeline.svelte:3796-3828).
// The flow red at the assert that the keyframe moved: s stayed at its pre-nudge value — the
// arrow key did nothing. Restored the branch; green.
test("strip keyframe arrow-nudge", async ({ page, boot }) => {
    await boot();
    await seedHill(page);
    await frameTimeline(page);

    const stripsOf = () => kexCall(page, "stripsOf", 0);
    const stripKeyframesOf = (id: number) => kexCall(page, "stripKeyframesOf", id);
    const stripKfPx = () => kexCall(page, "stripKfPx");
    const xView = () => kexCall(page, "xView");
    const vRange = () => kexCall(page, "vRange");

    // Create a strip at 30% of the clip (so strip.start > 0 — the `lo: m.start` bound is
    // distinguishable from `lo: 0`). `seed()` (S3) carries no strip of its own (the
    // track-start one-shot is a distinct point kind), so the count goes 0 → 1; address the
    // new strip by id.
    const beforeStrips = (await stripsOf()) as { id: number }[];
    const bandBb = await page.locator(".hbandzone").boundingBox();
    const clipBb = await page.locator(".clip").first().boundingBox();
    if (!bandBb || !clipBb) throw new Error("header band / clip not laid out");
    const bandY = bandBb.y + bandBb.height / 2;
    const bandX = clipBb.x + clipBb.width * 0.3;
    await page.mouse.click(bandX, bandY, { button: "right" });
    await expect(page.locator(".smenu")).toBeVisible();
    await clickMenuItem(page, ".smenu", "Add velocity strip");
    await expect.poll(async () => (await stripsOf()).length).toBe(beforeStrips.length + 1);
    await expect.poll(async () => await kexCall(page, "selectedStrip")).not.toBe(null);
    // Get the new strip's seeded keyframes (2 at start/end).
    const beforeIds = new Set(beforeStrips.map((s) => s.id));
    const created = ((await stripsOf()) as { id: number }[]).find((s) => !beforeIds.has(s.id));
    if (!created) throw new Error("newly-created strip not found");
    const stripId = created.id;
    const seededIds = new Set(
        ((await stripKeyframesOf(stripId)) as { id: number; s: number; v: number }[]).map(
            (k) => k.id,
        ),
    );
    expect(seededIds.size).toBe(2);

    // Widen the strip via a REAL pointer edge-drag on its end.
    const chartCanvasBb = await page.locator("canvas.chart").boundingBox();
    if (!chartCanvasBb) throw new Error("chart canvas not laid out");
    const spBefore = (
        (await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[]
    ).find((s) => s.id === stripId);
    if (!spBefore) throw new Error("created strip has no band px");
    const edgePx = chartCanvasBb.x + spBefore.x1;
    await page.mouse.move(edgePx, bandY);
    await page.mouse.down();
    await page.mouse.move(edgePx + 120, bandY, { steps: 5 });
    await page.mouse.up();

    // Read the strip's extent — strip.start > 0 (created at 30% of the clip).
    const strip = (
        (await stripsOf()) as { id: number; start: number; end: number; value: number }[]
    ).find((s) => s.id === stripId);
    if (!strip) throw new Error("widened strip not found");
    expect(strip.start).toBeGreaterThan(0); // the `lo: m.start` bound is non-zero

    // Create a third keyframe at the strip's MIDPOINT.
    const [, pxPerU] = await xView();
    const [vLo, vHi] = await vRange();
    const stripMidS = (strip.start + strip.end) / 2;
    const stripCenterPx = clipBb.x + stripMidS * pxPerU;
    const dockBb = await page.locator(".dock .body").boundingBox();
    if (!dockBb) throw new Error("dock body not laid out");
    const chartTop = dockBb.y + CHART_TOP;
    const chartBot = dockBb.y + dockBb.height - CHART_BOT_PAD;
    const vToY = (v: number): number =>
        chartTop + (1 - (v - vLo) / (vHi - vLo)) * (chartBot - chartTop);
    const stripValueY = vToY(strip.value);
    await page.mouse.dblclick(stripCenterPx, stripValueY);
    await expect.poll(async () => (await stripKeyframesOf(strip.id)).length).toBe(3);

    // Identify the created (midpoint) keyframe — not one of the seeded ones.
    let kfs = (await stripKeyframesOf(strip.id)) as { id: number; s: number; v: number }[];
    const midKf = kfs.find((k) => !seededIds.has(k.id));
    if (!midKf) throw new Error("midpoint keyframe not found");

    // Poll for the midpoint keyframe's diamond to be projected on screen.
    await expect
        .poll(async () => {
            const px = (await stripKfPx()) as { id: number; x: number; y: number }[];
            return px.find((k) => k.id === midKf.id) ?? null;
        })
        .not.toBeNull();
    const kfPxAll = (await stripKfPx()) as { id: number; x: number; y: number }[];
    const midKfPx = kfPxAll.find((k) => k.id === midKf.id)!;

    // Click the midpoint keyframe to select it.
    await page.mouse.click(midKfPx.x, midKfPx.y);
    await expect.poll(async () => await kexCall(page, "stripKfSelActive")).toBe(midKf.id);
    await frames(page, 1); // let the per-RAF tick propagate the selection

    // The mouse is already over the dock (from the keyframe click), so editor.hover
    // is "timeline". Keep it there — don't move away.

    // Press ArrowRight → the keyframe must move by NUDGE_S (0.1), rounded to the 0.1 grid
    // (the single-member nudge rounds the absolute result: s → round((s + 0.1) * 10) / 10).
    const sBefore = midKf.s;
    await page.keyboard.press("ArrowRight");
    await frames(page, 1);
    kfs = (await stripKeyframesOf(strip.id)) as { id: number; s: number; v: number }[];
    const sAfterRight = kfs.find((k) => k.id === midKf.id)!.s;
    const expectedSRight = Math.round((sBefore + 0.1) * 10) / 10;
    expect(sAfterRight).toBeCloseTo(expectedSRight, 5);
    expect(sAfterRight).toBeGreaterThan(sBefore); // it moved right

    // Press ArrowLeft to nudge back — the keyframe must move left by NUDGE_S (0.1),
    // rounded to the 0.1 grid. This confirms the handler processes ArrowLeft too (the
    // `lo: m.start` bound is unit-tested in nudgeKeyframes; the capture arm pins the
    // handler branch that calls it).
    await page.keyboard.press("ArrowLeft");
    await frames(page, 1);
    kfs = (await stripKeyframesOf(strip.id)) as { id: number; s: number; v: number }[];
    const sAfterLeft = kfs.find((k) => k.id === midKf.id)!.s;
    const expectedSLeft = Math.round((sAfterRight - 0.1) * 10) / 10;
    expect(sAfterLeft).toBeCloseTo(expectedSLeft, 5); // nudged left, on the 0.1 grid
    expect(sAfterLeft).toBeLessThan(sAfterRight); // it moved left
});

// The two-strip arrow-nudge flow — the per-OWNING-strip member resolution. The nudge
// handler resolves the selected strip-keyframe set through `stripKfMembers` (controls.ts),
// never through the single active strip: a marquee across two strips selects keyframes of
// BOTH owners, and each member's clamp bounds come from the strip that owns it. Pre-fix, the
// handler read `stripKeyframes(ecs, editor.strip).filter(...)` — only the ACTIVE strip's
// keyframes came back, so a two-strip marquee nudged just the active strip's slice and the
// other owner's keyframes stayed put (the same defect class the marquee arms above pinned
// for the candidate pool).
//
// RED-FIRST WITNESS: stubbed the site back to the single-active-strip resolution
// (`stripKeyframes(ecs, editor.strip!).filter(...)`) — the flow red at strip A's keyframe:
// `sAfterA - sBeforeA` expected 0.1, received 0 (strip A is NOT the marquee's active strip,
// so its interior keyframe never moved; strip B's did). Restored; green.
//
// The marquee leaves a STRIP as the active member (each hit's `ensureStrip` promotes its
// owner, the last ensured one active) — and the arrow guard needs no activation click on
// top of it: `editor.stripKf` is `kindActiveId("stripKf")` (editor.ts), whose
// fallback-to-last-member answers the last-selected strip keyframe whenever the ACTIVE
// member is of another kind (the per-kind active that accessor's own doc records), so with
// the marquee'd keyframes in the set the guard already passes with a strip active. The arm
// is the criterion's literal sequence — marquee across two strips, then the arrow presses.
// The interior keyframes sit at one shared v well under the strips' values, so the
// marquee box excludes both strips' seeded boundary keyframes (they sit at the strips' band
// values, far outside the box's y range) — a caught boundary keyframe at its own strip's
// bound would clamp the group delta to 0 and mask the resolution entirely.
test("two-strip marquee arrow-nudge moves both strips' keyframes", async ({ page, boot }) => {
    await boot();
    await kexCall(page, "seedForceBump");
    await expect.poll(async () => kexCall(page, "forceCount")).toBe(5);
    await frameTimeline(page);

    const stripKeyframesOf = (id: number) => kexCall(page, "stripKeyframesOf", id);
    const stripKfPx = () =>
        kexCall(page, "stripKfPx") as Promise<{ id: number; x: number; y: number }[]>;
    const stripKfSelIds = () => kexCall(page, "stripKfSelIds") as Promise<number[]>;
    const forceSelIds = () => kexCall(page, "forceSelIds") as Promise<number[]>;
    const undoDepth = () => kexCall(page, "undoDepth") as Promise<number>;

    // two strips at non-overlapping positions (avoiding the seed strip at station 0), each
    // with one INTERIOR keyframe at the SAME v — the marquee box is then one narrow y band
    // that excludes both strips' boundary keyframes (they sit at the strips' values, 5 and 3)
    const len = ((await kexCall(page, "sectionLengths")) as number[])[0];
    const stripA = (await kexCall(page, "addStripAt", len * 0.3, len * 0.5, 5)) as number;
    const stripB = (await kexCall(page, "addStripAt", len * 0.6, len * 0.9, 3)) as number;
    if (stripA === null || stripB === null) throw new Error("strip creation failed (overlap?)");
    const kfA = (await kexCall(page, "placeStripKf", stripA, len * 0.4, 1)) as number;
    const kfB = (await kexCall(page, "placeStripKf", stripB, len * 0.75, 1)) as number;

    let kfPx: { id: number; x: number; y: number }[] = [];
    await expect
        .poll(async () => {
            kfPx = await stripKfPx();
            return kfPx.some((k) => k.id === kfA) && kfPx.some((k) => k.id === kfB);
        })
        .toBe(true);
    const pxA = kfPx.find((k) => k.id === kfA)!;
    const pxB = kfPx.find((k) => k.id === kfB)!;

    // marquee across both strips' interior keyframes — the co-selection that spans two
    // owning strips (the shape the marquee arms above established)
    const xLo = Math.min(pxA.x, pxB.x) - 8;
    const xHi = Math.max(pxA.x, pxB.x) + 8;
    const yLo = Math.min(pxA.y, pxB.y) - 12;
    const yHi = Math.max(pxA.y, pxB.y) + 12;
    await marqueeDrag(page, xLo, yLo, xHi, yHi);
    await expect.poll(async () => (await stripKfSelIds()).length).toBeGreaterThanOrEqual(2);
    const sel = (await stripKfSelIds()).sort((a, b) => a - b);
    expect(sel).toContain(kfA);
    expect(sel).toContain(kfB);

    // the marquee box also catches one seeded force point — the bump's s = 0.5·len crest
    // (g = 0), not the s = 0.8·len shoulder: the strip keyframes' v = 1 band renders at the
    // g = 0 y band (the v-axis and the g-axis scale independently), so the box's y range
    // spans the crest. Toggle it back OUT through the production shift-click path so the
    // nudges below reach the pure strip-keyframe branch. The caught point is resolved from
    // the marquee's own selection — this fixture's one force section has all five seeded
    // force circles in view after framing — not a hardcoded index.
    const caughtForce = (await forceSelIds()).sort((a, b) => a - b);
    expect(caughtForce.length).toBe(1);
    const fhit = page.locator(".fhit");
    const forceU = (await kexCall(page, "forceU")) as { id: number; s: number }[];
    const caughtIdx = forceU
        .slice()
        .sort((a, b) => a.s - b.s)
        .map((p) => p.id)
        .indexOf(caughtForce[0]);
    if (caughtIdx < 0) throw new Error("caught force point not found");
    const bump = await fhit.nth(caughtIdx).boundingBox();
    if (!bump) throw new Error("caught force point not laid out");
    await page.keyboard.down("Shift");
    await page.mouse.click(bump.x + bump.width / 2, bump.y + bump.height / 2);
    await page.keyboard.up("Shift");
    await expect.poll(async () => (await forceSelIds()).length).toBe(0);

    // the undo baseline sits AFTER the flow's own authoring steps (the strip and keyframe
    // creation calls above), so whatever those recorded is excluded from the deltas below —
    // the nudges are what they attribute to. The marquee is a selection gesture and records
    // no history entry of its own.
    const undoBase = await undoDepth();

    // the pointer stays over the chart (the marquee's own drag) — `editor.hover` is "timeline"
    const sBeforeA = (
        (await stripKeyframesOf(stripA)) as { id: number; s: number; v: number }[]
    ).find((k) => k.id === kfA)!.s;
    const sBeforeB = (
        (await stripKeyframesOf(stripB)) as { id: number; s: number; v: number }[]
    ).find((k) => k.id === kfB)!.s;

    // ArrowRight → BOTH owners' keyframes move by NUDGE_S (0.1), one shared multi-set delta
    // (no rounding — the multi-set regime), each clamped by its OWN strip's bounds
    await page.keyboard.press("ArrowRight");
    await frames(page, 1);
    const sAfterA = (
        (await stripKeyframesOf(stripA)) as { id: number; s: number; v: number }[]
    ).find((k) => k.id === kfA)!.s;
    const sAfterB = (
        (await stripKeyframesOf(stripB)) as { id: number; s: number; v: number }[]
    ).find((k) => k.id === kfB)!.s;
    expect(sAfterA - sBeforeA).toBeCloseTo(0.1, 5); // strip A's keyframe moved — not just the active strip's slice
    expect(sAfterB - sBeforeB).toBeCloseTo(0.1, 5);

    // the two-strip nudge is ONE undo entry: the history bracket (`beginStripKeyframeMoves`
    // … `commit`) wraps the whole resolved member set, never one entry per owning strip —
    // witnessed: per-member brackets (one begin+commit per member, no retained outer commit)
    // red this assert at undoBase + 2 for the two-member set, and a deleted commit reds it
    // with the entry missing.
    expect(await undoDepth()).toBe(undoBase + 1);

    // ArrowLeft back — both move back, the shared delta again
    await page.keyboard.press("ArrowLeft");
    await frames(page, 1);
    const sBackA = (
        (await stripKeyframesOf(stripA)) as { id: number; s: number; v: number }[]
    ).find((k) => k.id === kfA)!.s;
    const sBackB = (
        (await stripKeyframesOf(stripB)) as { id: number; s: number; v: number }[]
    ).find((k) => k.id === kfB)!.s;
    expect(sBackA).toBeCloseTo(sBeforeA, 5);
    expect(sBackB).toBeCloseTo(sBeforeB, 5);

    // the return nudge is its own single entry too, and ONE undo of it restores BOTH
    // strips' keyframes together — the entry carries both owners' moves, not the active
    // strip's slice.
    expect(await undoDepth()).toBe(undoBase + 2);
    await page.keyboard.press("Control+z");
    await frames(page, 1);
    const sUndoA = (
        (await stripKeyframesOf(stripA)) as { id: number; s: number; v: number }[]
    ).find((k) => k.id === kfA)!.s;
    const sUndoB = (
        (await stripKeyframesOf(stripB)) as { id: number; s: number; v: number }[]
    ).find((k) => k.id === kfB)!.s;
    expect(sUndoA).toBeCloseTo(sAfterA, 5); // back to the post-first-nudge position
    expect(sUndoB).toBeCloseTo(sAfterB, 5);
});

// The MIXED-DOMAIN lockdown fall-through: a pin session locks every non-pinning section, and
// the mixed force + strip-keyframe arrow nudge (the force handler's own branch — a shape the
// two-strip flow above cannot reach, holding no force member) is all-or-nothing on the
// strip-kf subset PER OWNING STRIP: one locked owner blocks the WHOLE subset from the mixed
// move while the forces still nudge alone — never a silent moving subset. The shipped
// `tests/controls.test.ts` `stripKfMembers` arms stop at the read's `anyLocked` flag; both
// branch outcomes live in the Svelte handler, which `bun test` cannot see — this harness is
// the arm seam. The lockdown gate is `stripEditableAtEcs` per owner (a strip whose station
// resolves into a non-pinning section), so the fixture pins section 0 and lays strip A in the
// APPENDED section 1's span (locked) while strip B sits in section 0 and is ensured the
// ACTIVE strip — the last strip member — which is exactly the owner the pre-fix gate read:
// it gated on the ACTIVE strip's editability alone, so a locked non-active owner's
// keyframes rode the mixed move silently.
//
// RED-FIRST WITNESS: stubbed the site back to the pre-fix gate — kept the per-owner
// `stripKfMembers` resolution, replaced `!anyLocked` with the ACTIVE strip's editability
// (`stripEditableAt(Strip.start.get(stripAt(ecs, editor.strip)))`, the pre-diff reading).
// The flow red at the strip-keyframe assertion
// `expect(kfAfter - kfBefore).toBeCloseTo(0, 5)` — Expected: 0,
// Received: 0.10000000000000142 (the locked owner's keyframe moved +NUDGE_S under the
// active-strip gate: strip B, in the editable pinning section, is the active strip the stub
// reads). Restored; green.
//
// FIXTURE LAW (the shipped controls.test.ts lockdown arm records it): any `addStrip`/
// `addStripKeyframe` write changes `authoredHash`, so the bake must re-run before entering
// the pin session — in the capture rig that is a real frame (`frames(page, 1)`) after the
// authoring hooks and before the ctxmenu's Pin row.
test("pin-session lockdown blocks mixed nudge and force-originated drag strip-kf subset", async ({
    page,
    boot,
}) => {
    await boot();
    await kexCall(page, "seedForceBump"); // section 0 → force, 5 authored keyframes
    await expect.poll(async () => kexCall(page, "forceCount")).toBe(5);
    // SectionKind.Force — the appended span that LOCKS in the session. Force-kind, not geo:
    // a force section STORES its extent (`Section.length`), so `sectionLengths` reads it
    // live, while a geo section's chord is derived from its node chain and the stored field
    // stays 0 — the fixture needs a live span number to lay stations by.
    await kexCall(page, "append", 1);
    await expect.poll(async () => kexCall(page, "sectionCount")).toBe(2);

    const sectionLengths = () => kexCall(page, "sectionLengths") as Promise<number[]>;
    await expect.poll(async () => ((await sectionLengths()) as number[])[1]).toBeGreaterThan(0);
    const stripKfPx = () =>
        kexCall(page, "stripKfPx") as Promise<{ id: number; x: number; y: number }[]>;
    const stripKfSelIds = () => kexCall(page, "stripKfSelIds") as Promise<number[]>;
    const stripSelIds = () => kexCall(page, "stripSelIds") as Promise<number[]>;
    const forceSelIds = () => kexCall(page, "forceSelIds") as Promise<number[]>;
    const forceU = () =>
        kexCall(page, "forceU") as Promise<
            { id: number; section: number; s: number; g: number; u: number }[]
        >;
    const stripKeyframesOf = (id: number) =>
        kexCall(page, "stripKeyframesOf", id) as Promise<{ id: number; s: number; v: number }[]>;

    // strip A in the APPENDED section's span (locked once the session opens), strip B in
    // section 0 (the pinning section, editable). One INTERIOR keyframe on A at v 1 — the
    // marquee's own band, far under A's band value 5 so the boundary keyframes stay out of
    // the box (a caught boundary keyframe at its own bound would clamp the delta to 0).
    const [L0, L1] = (await sectionLengths()) as [number, number];
    const stripA = (await kexCall(page, "addStripAt", L0 + L1 * 0.2, L0 + L1 * 0.8, 5)) as number;
    const stripB = (await kexCall(page, "addStripAt", L0 * 0.3, L0 * 0.9, 3)) as number;
    if (stripA === null || stripB === null) throw new Error("strip creation refused (overlap?)");
    const kfA = (await kexCall(page, "placeStripKf", stripA, L0 + L1 * 0.5, 1)) as number;
    const kfB = (await kexCall(page, "placeStripKf", stripB, L0 * 0.6, 3)) as number;

    await frameTimeline(page);
    let kfPx: { id: number; x: number; y: number }[] = [];
    await expect
        .poll(async () => {
            kfPx = await stripKfPx();
            return kfPx.some((k) => k.id === kfA) && kfPx.some((k) => k.id === kfB);
        })
        .toBe(true);
    const pxA = kfPx.find((k) => k.id === kfA)!;
    const pxB = kfPx.find((k) => k.id === kfB)!;
    await frames(page, 1); // the strip authoring changed the bake — re-run it before the session

    // pin section 0 (the Pin row's own force-section guard: seedForceBump made it one) —
    // every OTHER section locks for the session
    await page.locator(".clip").first().click({ button: "right" });
    await expect(page.locator(".ctxmenu")).toBeVisible();
    await clickMenuItem(page, ".ctxmenu", "Pin");
    await expect.poll(async () => kexCall(page, "pinning")).toBe(true);

    // the marquee over strip A's keyframe — a plain drag with ONE hit: A's keyframe selected,
    // A ensured. The box catches no force keyframe (section 0's five sit far left of it, and
    // the appended section's two continuation keys sit at its boundary stations, away from
    // A's interior keyframe) — the force selection must stay all-editable for the
    // fall-through's own `forceSetEditable` gate.
    await marqueeDrag(page, pxA.x - 8, pxA.y - 12, pxA.x + 8, pxA.y + 12);
    await expect.poll(async () => (await stripKfSelIds()).includes(kfA)).toBe(true);
    await expect.poll(async () => (await stripSelIds()).includes(stripA)).toBe(true);

    // strip B into the set LAST — its interior keyframe joins the cross-kind set while B remains
    // in the editable pinning section. A and B are deliberately on distinct value bands, so the
    // shift-marquee catches B's interior diamond without catching either seeded boundary.
    await marqueeDrag(page, pxB.x - 8, pxB.y - 12, pxB.x + 8, pxB.y + 12, true);
    await expect.poll(async () => (await stripKfSelIds()).includes(kfB)).toBe(true);
    await expect.poll(async () => (await stripSelIds()).includes(stripB)).toBe(true);

    // a section-0 force keyframe shift-clicked into the set LAST — the ACTIVE member is the
    // force keyframe, so the force handler's own branch is the site that fires
    const forceHit = await page.locator(".fhit").nth(2).boundingBox();
    if (!forceHit) throw new Error("force diamond 2 not laid out");
    await page.keyboard.down("Shift");
    await page.mouse.click(forceHit.x + forceHit.width / 2, forceHit.y + forceHit.height / 2);
    await page.keyboard.up("Shift");
    await expect.poll(async () => (await forceSelIds()).length).toBe(1);
    const activeForce = (await kexCall(page, "forceSelActive")) as number;
    const forceBefore = (await forceU()).find((p) => p.id === activeForce)?.s;
    if (forceBefore === undefined) throw new Error("selected force keyframe not readable");
    const kfBefore = (await stripKeyframesOf(stripA)).find((k) => k.id === kfA)!.s;

    // one ArrowRight — the pointer is over the chart (the shift-click), so the force branch
    // fires: A's owner is locked, the WHOLE strip-kf subset is blocked from the mixed move,
    // and the forces still nudge alone (the fall-through)
    await page.keyboard.press("ArrowRight");
    await frames(page, 1);
    const forceAfter = (await forceU()).find((p) => p.id === activeForce)?.s;
    if (forceAfter === undefined) throw new Error("selected force keyframe not readable after");
    expect(forceAfter - forceBefore).toBeCloseTo(0.1, 5); // the forces nudged ALONE
    const kfAfter = (await stripKeyframesOf(stripA)).find((k) => k.id === kfA)!.s;
    expect(kfAfter - kfBefore).toBeCloseTo(0, 5); // the locked owner's keyframe never moved
    expect(await kexCall(page, "pinning")).toBe(true); // the session stood through the nudge

    // Pointer arm: re-press the already-selected force diamond without Shift to promote it active,
    // then drag from that force origin. The locked A member must stay put while editable B moves;
    // this is the capture witness for the force-originated station-write lockdown gate.
    const beforePointerA = (await stripKeyframesOf(stripA)).find((k) => k.id === kfA)?.s;
    const beforePointerB = (await stripKeyframesOf(stripB)).find((k) => k.id === kfB)?.s;
    const beforePointerForce = (await forceU()).find((p) => p.id === activeForce)?.s;
    if (
        beforePointerA === undefined ||
        beforePointerB === undefined ||
        beforePointerForce === undefined
    )
        throw new Error("mixed pointer baseline is incomplete");
    await page.mouse.click(forceHit.x + forceHit.width / 2, forceHit.y + forceHit.height / 2);
    await page.mouse.move(forceHit.x + forceHit.width / 2, forceHit.y + forceHit.height / 2);
    await page.mouse.down();
    await page.mouse.move(forceHit.x + forceHit.width / 2 + 20, forceHit.y + forceHit.height / 2, {
        steps: 10,
    });
    await page.mouse.up();
    await expect
        .poll(async () => (await stripKeyframesOf(stripB)).find((k) => k.id === kfB)?.s)
        .toBeGreaterThan(beforePointerB);
    const afterPointerA = (await stripKeyframesOf(stripA)).find((k) => k.id === kfA)?.s;
    const afterPointerForce = (await forceU()).find((p) => p.id === activeForce)?.s;
    const afterPointerB = (await stripKeyframesOf(stripB)).find((k) => k.id === kfB)?.s;
    if (
        afterPointerA === undefined ||
        afterPointerB === undefined ||
        afterPointerForce === undefined
    )
        throw new Error("mixed pointer result is incomplete");
    expect(afterPointerA).toBeCloseTo(beforePointerA, 5);
    expect(afterPointerB).toBeGreaterThan(beforePointerB);
    expect(afterPointerForce).toBeCloseTo(beforePointerForce, 5);
});

// S1 capture arm (B3): strip-keyframe SNAP. `applyKeyframeDrag`'s s-axis snap resolves through
// `stripKfSTargets` (Timeline.svelte:1299, called at :1444) and v-axis through `vTargets`
// (:1291, called at :1460) — both kind-specific target builders feeding the shared `snapAxis`.
// Every other strip-keyframe flow holds Ctrl to bypass the snap magnet (the extent-trim flow at
// :200, the drag-origin flow at :1893, the multi-member flow at :2155, the nudge flow at :2275);
// `tests/timeline.test.ts:1391` calls `snapAxis` with hand-built arrays and cannot see the
// production target builders. So neither `stripKfSTargets` nor `vTargets` had any arm reaching
// them — killing both leaves `bun test` at 1654/0 and every capture flow green (verified by
// mutation, verify-b3.py). This flow is the missing arm: it drags a strip keyframe WITHOUT Ctrl
// and asserts the snapped landing — the v-axis snap to another keyframe's v value (a landmark
// `vTargets` provides, killed by the mutation). Strips cannot overlap, so a keyframe in one
// strip cannot reach another strip's s-axis station; the v-axis snap has no strip-extent
// constraint, so it is the axis the arm can reach.
//
// RED-FIRST WITNESS: killed both strip snap target arms — replaced the `stripKfSTargets(...)`
// call at :1444 with `[]` and the `vTargets(...)` call at :1460 with `[]`. The flow red at the
// snapped-v assertion: the keyframe landed at the v-grid quantum (V_GRID 0.1), not at the
// other keyframe's off-grid v landmark. Restored both arms; green.
test("strip keyframe snap landing", async ({ page, boot }) => {
    await boot();
    await seedHill(page);
    await frameTimeline(page);

    const stripsOf = () => kexCall(page, "stripsOf", 0);
    const stripKeyframesOf = (id: number) => kexCall(page, "stripKeyframesOf", id);
    const stripKfPx = () => kexCall(page, "stripKfPx");
    const xView = () => kexCall(page, "xView");
    const vRange = () => kexCall(page, "vRange");

    // Create a strip (right-click on the band → Add velocity strip). `seed()` (S3) carries no
    // strip of its own (the track-start one-shot is a distinct point kind), so the count goes
    // 0 → 1; address the new strip by id.
    const beforeStrips = (await stripsOf()) as { id: number }[];
    const bandBb = await page.locator(".hbandzone").boundingBox();
    const clipBb = await page.locator(".clip").first().boundingBox();
    if (!bandBb || !clipBb) throw new Error("header band / clip not laid out");
    const bandY = bandBb.y + bandBb.height / 2;
    const bandX = clipBb.x + clipBb.width * 0.3;
    await page.mouse.click(bandX, bandY, { button: "right" });
    await expect(page.locator(".smenu")).toBeVisible();
    await clickMenuItem(page, ".smenu", "Add velocity strip");
    await expect.poll(async () => (await stripsOf()).length).toBe(beforeStrips.length + 1);
    await expect.poll(async () => await kexCall(page, "selectedStrip")).not.toBe(null);
    const beforeIds = new Set(beforeStrips.map((s) => s.id));
    const created = ((await stripsOf()) as { id: number }[]).find((s) => !beforeIds.has(s.id));
    if (!created) throw new Error("newly-created strip not found");
    const stripId = created.id;
    const seededIds = new Set(
        ((await stripKeyframesOf(stripId)) as { id: number; s: number; v: number }[]).map(
            (k) => k.id,
        ),
    );
    expect(seededIds.size).toBe(2);

    const chartCanvasBb = await page.locator("canvas.chart").boundingBox();
    if (!chartCanvasBb) throw new Error("chart canvas not laid out");

    // The seeded pair (S4's own "seed two keyframes at start/end" idiom) already sits
    // STRIP_DEFAULT_LEN apart — 10 m as of F3, well past a keyframe's own hit radius at any
    // reachable zoom, so no widen/separate drag is owed here: the old default (24 m) only
    // ever read as "coincident" because it happened to saturate this fixture's own short
    // `seedHill` track to its full length (both ends landing at the SAME station, the track's
    // own end) — a coincidence F3's docblock names outright, and the property this arm
    // actually needs (two DISTINCT, addressable keyframes to build a midpoint snap landmark
    // between) holds without it.
    let kfs = (await stripKeyframesOf(stripId)) as { id: number; s: number; v: number }[];
    const seededKfs = kfs.filter((k) => seededIds.has(k.id)).sort((a, b) => a.s - b.s);
    const startKf = seededKfs[0]; // smaller s = start
    const endKf = seededKfs[1]; // larger s = end
    if (!startKf || !endKf) throw new Error("start/end keyframe not found");

    // Create a third keyframe at the strip's MIDPOINT.
    const strip = (
        (await stripsOf()) as { id: number; start: number; end: number; value: number }[]
    ).find((s) => s.id === stripId)!;
    const [, pxPerU] = await xView();
    const [vLo, vHi] = await vRange();
    const stripMidS = (strip.start + strip.end) / 2;
    const stripCenterPx = clipBb.x + stripMidS * pxPerU;
    const dockBb = await page.locator(".dock .body").boundingBox();
    if (!dockBb) throw new Error("dock body not laid out");
    const chartTop = dockBb.y + CHART_TOP;
    const chartBot = dockBb.y + dockBb.height - CHART_BOT_PAD;
    const vToY = (v: number): number =>
        chartTop + (1 - (v - vLo) / (vHi - vLo)) * (chartBot - chartTop);
    const stripValueY = vToY(strip.value);
    await page.mouse.dblclick(stripCenterPx, stripValueY);
    await expect.poll(async () => (await stripKeyframesOf(strip.id)).length).toBe(3);
    kfs = (await stripKeyframesOf(strip.id)) as { id: number; s: number; v: number }[];
    const midKf = kfs.find((k) => !seededIds.has(k.id));
    if (!midKf) throw new Error("midpoint keyframe not found");

    // Poll for the midpoint keyframe's diamond to be projected on screen.
    await expect
        .poll(async () => {
            const px = (await stripKfPx()) as { id: number; x: number; y: number }[];
            return px.find((k) => k.id === midKf.id) ?? null;
        })
        .not.toBeNull();
    let kfPxAll = (await stripKfPx()) as { id: number; x: number; y: number }[];

    // Move the END keyframe to an OFF-GRID v value (with Ctrl to bypass snap). This makes the
    // end keyframe's v a landmark snap target that is NOT on the V_GRID (0.1) quantum — so the
    // landmark snap and the grid snap give DIFFERENT values, and the mutation (which kills
    // `vTargets`, removing the landmark) would let the grid snap take over, yielding a
    // different v.
    kfPxAll = (await stripKfPx()) as { id: number; x: number; y: number }[];
    const endKfPx = kfPxAll.find((k) => k.id === endKf.id)!;
    // drag it DOWN (higher v) to an off-grid v value — 40px, well past SNAP_PX (8)
    const offGridDyPx = 40;
    await page.mouse.move(endKfPx.x, endKfPx.y);
    await page.keyboard.down("Control");
    await page.mouse.down();
    await page.mouse.move(endKfPx.x, endKfPx.y + offGridDyPx, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up("Control");

    // Read the end keyframe's new v — this is the snap landmark.
    kfs = (await stripKeyframesOf(strip.id)) as { id: number; s: number; v: number }[];
    const endKfAfter = kfs.find((k) => k.id === endKf.id)!;
    const landmarkV = endKfAfter.v;
    // verify it's off-grid (not a multiple of V_GRID = 0.1)
    const vGrid = 0.1;
    const remainder = Math.round((landmarkV / vGrid) * 1e6) % 100000;
    expect(remainder).not.toBe(0); // off-grid — the landmark and grid snap diverge

    // Now drag the MIDPOINT keyframe vertically (WITHOUT Ctrl) toward the end keyframe's v.
    // The snap magnet is ACTIVE (no Ctrl), so `vTargets` provides the end keyframe's v as a
    // landmark. When the cursor comes within SNAP_PX (8px) of vOf(landmarkV), the keyframe
    // snaps to landmarkV. With the mutation (`vTargets` killed), no landmark is in the pool,
    // so the keyframe falls to the V_GRID quantum — a DIFFERENT v.
    //
    // The landmark's pixel y is read from `stripKfPx` (the same projection the app's `vOf`
    // uses to draw the diamond), NOT computed from `vToY` — the dock body's height may
    // differ from the canvas's `h` (`vOf` uses `h`, `vToY` uses `dockBb.height`), so a
    // `vToY`-computed y would be at a different canvas-local pixel than `vOf`'s, and the
    // snap (which compares in canvas-local px) would not fire.
    kfPxAll = (await stripKfPx()) as { id: number; x: number; y: number }[];
    const midKfPxFresh = kfPxAll.find((k) => k.id === midKf.id)!;
    const endKfPxFresh = kfPxAll.find((k) => k.id === endKf.id)!;
    // drag toward the landmark v, stopping AT the target's exact pixel y (0px offset) so the
    // snap must fire — the v-axis scale is steep enough that even a 4px offset puts the cursor
    // outside SNAP_PX of the target in v-space
    const dragTargetY = endKfPxFresh.y; // exactly on the target
    await page.mouse.move(midKfPxFresh.x, midKfPxFresh.y);
    await page.mouse.down();
    await page.mouse.move(midKfPxFresh.x, dragTargetY, { steps: 10 });
    await page.mouse.up();

    // Assert the keyframe SNAPPED to the end keyframe's v (the landmark). With the snap arms
    // killed (the mutation), the keyframe would land at the V_GRID quantum (nearest 0.1),
    // NOT at landmarkV — so the v would differ from landmarkV by up to 0.05, well outside
    // the tolerance.
    const kfsFinal = (await stripKeyframesOf(strip.id)) as { id: number; s: number; v: number }[];
    const midKfFinal = kfsFinal.find((k) => k.id === midKf.id)!;
    const vDiff = Math.abs(midKfFinal.v - landmarkV);
    expect(
        vDiff,
        `snap assertion: midKf v=${midKfFinal.v}, landmarkV=${landmarkV}, diff=${vDiff}, midKfBefore=${midKf.v}, endKfBefore=${endKf.v}`,
    ).toBeLessThan(1e-5); // snapped to the landmark v
});

// S1/S5b capture arm: strip-keyframe OVERLAP REFUSAL on a multi-member drag. `applyKeyframeDrag`'s
// block-level Δd cap (Timeline.svelte, S5b's Locked decision) reads each member's own directional
// room to the nearest sibling NOT in the dragged set (`track.keyframeRoom`) and holds the whole
// block's shared Δd strictly short of the tightest member's room — never an equality test. Without
// this check, `setStripKeyframe`'s own per-keyframe exact-equality guard would still block the
// overlapping member's s write, but the non-overlapping member would move freely — the block
// tears apart. This flow constructs a multi-member set, drags it toward a non-selected keyframe's
// station (so one member would overlap), and asserts BOTH that the block held (both members moved
// by the same delta, offset preserved) AND that the would-overlap member landed STRICTLY SHORT of
// the target station — the discriminating half: pre-S5b, with the extent clamp already deleted
// (F2) and no cap in its place, the raw delta lands unbounded and BOTH selected members move by
// the full drag distance (offset preserved AND the member lands exactly on the target), so the
// offset-only assertion passed vacuously in both directions. The "held short" assertion is what a
// deleted cap can no longer satisfy.
//
// RED-FIRST WITNESS (S5b): mutated `dsWrite` to the raw `ds` (cap disabled — the same mutation
// `harness/mutate.ts`'s "overlap refusal" pair runs). The flow red at the "held short" assert: the
// start keyframe landed exactly at the end keyframe's station (0 distance, not held short).
// Restored the cap; green.
test("strip keyframe overlap refusal", async ({ page, boot }) => {
    await boot();
    await seedHill(page);
    await frameTimeline(page);

    const stripsOf = () => kexCall(page, "stripsOf", 0);
    const stripKeyframesOf = (id: number) => kexCall(page, "stripKeyframesOf", id);
    const stripKfPx = () => kexCall(page, "stripKfPx");
    const stripKfSelIds = () => kexCall(page, "stripKfSelIds");
    const xView = () => kexCall(page, "xView");
    const vRange = () => kexCall(page, "vRange");

    // Create a strip (right-click on the band → Add velocity strip). `seed()` (S3) carries no
    // strip of its own (the track-start one-shot is a distinct point kind), so the count goes
    // 0 → 1; address the new strip by id.
    const beforeStrips = (await stripsOf()) as { id: number }[];
    const bandBb = await page.locator(".hbandzone").boundingBox();
    const clipBb = await page.locator(".clip").first().boundingBox();
    if (!bandBb || !clipBb) throw new Error("header band / clip not laid out");
    const bandY = bandBb.y + bandBb.height / 2;
    const bandX = clipBb.x + clipBb.width * 0.3;
    await page.mouse.click(bandX, bandY, { button: "right" });
    await expect(page.locator(".smenu")).toBeVisible();
    await clickMenuItem(page, ".smenu", "Add velocity strip");
    await expect.poll(async () => (await stripsOf()).length).toBe(beforeStrips.length + 1);
    await expect.poll(async () => await kexCall(page, "selectedStrip")).not.toBe(null);
    const beforeIds = new Set(beforeStrips.map((s) => s.id));
    const created = ((await stripsOf()) as { id: number }[]).find((s) => !beforeIds.has(s.id));
    if (!created) throw new Error("newly-created strip not found");
    const stripId = created.id;
    const seededIds = new Set(
        ((await stripKeyframesOf(stripId)) as { id: number; s: number; v: number }[]).map(
            (k) => k.id,
        ),
    );
    expect(seededIds.size).toBe(2);

    // Widen the strip via a REAL pointer edge-drag on its end.
    const chartCanvasBb = await page.locator("canvas.chart").boundingBox();
    if (!chartCanvasBb) throw new Error("chart canvas not laid out");
    const spBefore = (
        (await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[]
    ).find((s) => s.id === stripId);
    if (!spBefore) throw new Error("created strip has no band px");
    // Widen generously (+280px, not the sibling flows' +120px): the rigid group clamp
    // (`clampDelta`) binds the shared delta to whichever selected member has the LEAST
    // room to its own `len` (strip.end) — the overlap-target keyframe below is placed at
    // ~30% of the widened extent and the third (selected) keyframe near the start, so the
    // third keyframe's own room (strip.end minus its position) is generously larger than
    // the drag distance (30% of the extent), and the clamp never binds before the anchor
    // reaches the overlap station.
    const edgePx = chartCanvasBb.x + spBefore.x1;
    await page.mouse.move(edgePx, bandY);
    await page.mouse.down();
    await page.mouse.move(edgePx + 280, bandY, { steps: 5 });
    await page.mouse.up();

    // Separate the still-coincident seeded pair — drag the END keyframe (renders on top at the
    // tie) to ~30% of the WIDENED extent (never to the strip's own end — S5b's Δd cap reads
    // directional room to the nearest SIBLING, not a container extent, but the third keyframe
    // below still needs its own room to the end keyframe generously larger than the drag
    // distance, or its tighter room — not the target member's — would bind the block's cap).
    await expect.poll(async () => (await stripKfPx()).length).toBeGreaterThan(0);
    let kfPxAll = (await stripKfPx()) as { id: number; x: number; y: number }[];
    const sharedPx = kfPxAll.find((k) => seededIds.has(k.id))!;
    const widePx = (
        (await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[]
    ).find((s) => s.id === stripId)!;
    const separateX = chartCanvasBb.x + widePx.x0 + (widePx.x1 - widePx.x0) * 0.3;
    await page.mouse.move(sharedPx.x, sharedPx.y);
    await page.mouse.down();
    await page.mouse.move(separateX, sharedPx.y, { steps: 8 });
    await page.mouse.up();

    // Read the separated keyframes — identify start (smaller s) and end (larger s).
    let kfs = (await stripKeyframesOf(stripId)) as { id: number; s: number; v: number }[];
    const seededKfs = kfs.filter((k) => seededIds.has(k.id)).sort((a, b) => a.s - b.s);
    const startKf = seededKfs[0]; // smaller s = start
    const endKf = seededKfs[1]; // larger s = end (the NON-SELECTED keyframe — the overlap target)
    if (!startKf || !endKf) throw new Error("start/end keyframe not found after separation");
    // verify the separation actually worked (the start and end are at different s values)
    expect(startKf.s).not.toBeCloseTo(endKf.s, 5);

    // Create a third keyframe NEAR THE START (not the strip's geometric midpoint) — 10% into
    // the strip's extent, off both the start keyframe's own hit circle and the overlap
    // target's — so its OWN room to `strip.end` stays generously larger than the drag
    // distance (see the widen/separate comments above).
    const strip = (
        (await stripsOf()) as { id: number; start: number; end: number; value: number }[]
    ).find((s) => s.id === stripId)!;
    const [, pxPerU] = await xView();
    const [vLo, vHi] = await vRange();
    const stripMidS = strip.start + (strip.end - strip.start) * 0.1;
    const stripCenterPx = clipBb.x + stripMidS * pxPerU;
    const dockBb = await page.locator(".dock .body").boundingBox();
    if (!dockBb) throw new Error("dock body not laid out");
    const chartTop = dockBb.y + CHART_TOP;
    const chartBot = dockBb.y + dockBb.height - CHART_BOT_PAD;
    const vToY = (v: number): number =>
        chartTop + (1 - (v - vLo) / (vHi - vLo)) * (chartBot - chartTop);
    const stripValueY = vToY(strip.value);
    await page.mouse.dblclick(stripCenterPx, stripValueY);
    await expect.poll(async () => (await stripKeyframesOf(strip.id)).length).toBe(3);
    kfs = (await stripKeyframesOf(strip.id)) as { id: number; s: number; v: number }[];
    const midKf = kfs.find((k) => !seededIds.has(k.id));
    if (!midKf) throw new Error("midpoint keyframe not found");

    // Poll for the start and midpoint keyframes' diamonds to be projected on screen.
    await expect
        .poll(async () => {
            const px = (await stripKfPx()) as { id: number; x: number; y: number }[];
            return px.find((k) => k.id === startKf.id) ?? null;
        })
        .not.toBeNull();
    await expect
        .poll(async () => {
            const px = (await stripKfPx()) as { id: number; x: number; y: number }[];
            return px.find((k) => k.id === midKf.id) ?? null;
        })
        .not.toBeNull();
    kfPxAll = (await stripKfPx()) as { id: number; x: number; y: number }[];
    const startKfPx = kfPxAll.find((k) => k.id === startKf.id)!;
    const midKfPx = kfPxAll.find((k) => k.id === midKf.id)!;

    // Select the start and midpoint keyframes (multi-member set). The END keyframe stays
    // unselected — it's the overlap target.
    await page.mouse.click(startKfPx.x, startKfPx.y);
    await expect.poll(async () => (await stripKfSelIds()).length).toBe(1);
    await page.keyboard.down("Shift");
    await page.mouse.click(midKfPx.x, midKfPx.y);
    await page.keyboard.up("Shift");
    await expect.poll(async () => (await stripKfSelIds()).length).toBe(2);

    // Record pre-drag s values for both selected keyframes.
    kfs = (await stripKeyframesOf(strip.id)) as { id: number; s: number; v: number }[];
    const startSBefore = kfs.find((k) => k.id === startKf.id)!.s;
    const midSBefore = kfs.find((k) => k.id === midKf.id)!.s;

    // Read the END keyframe's pixel position — the drag target. The start keyframe's raw target
    // would be `endS` (the end keyframe's station) if the block moved by `ds = endS - startS`.
    // The end keyframe is NOT in the dragged set, so `keyframeRoom` reads it as the occupant that
    // caps the block's Δd.
    kfPxAll = (await stripKfPx()) as { id: number; x: number; y: number }[];
    const endKfPx = kfPxAll.find((k) => k.id === endKf.id)!;

    // Drag the start keyframe to the end keyframe's station, in ONE step. `endKfPx.x` is the
    // exact page-absolute pixel the diamond is drawn at (`rect.left + uPx(k.u)`), so the
    // cursor's canvas-local x round-trips through `uAtPx`/`dOf` back to `endKf.s` exactly.
    // Ctrl held to bypass snap, so the s value is the raw cursor position.
    const dragTargetX = endKfPx.x;
    await page.mouse.move(startKfPx.x, startKfPx.y);
    await page.keyboard.down("Control");
    await page.mouse.down();
    await page.mouse.move(dragTargetX, startKfPx.y, { steps: 1 });
    await page.mouse.up();
    await page.keyboard.up("Control");

    // Assert the BLOCK held: both selected keyframes moved by the same delta (offset preserved) —
    // AND that the would-overlap member landed STRICTLY SHORT of the target station. The second
    // assert is what discriminates: with the cap disabled (S5b's mutation), the raw Δd is
    // unbounded and BOTH members move by the full drag distance (the start member lands EXACTLY
    // on the end keyframe's station), so offset-preservation alone passes vacuously either way —
    // deleting the cap makes the block "hold together" by moving fully together, not by holding.
    kfs = (await stripKeyframesOf(strip.id)) as { id: number; s: number; v: number }[];
    const startSAfter = kfs.find((k) => k.id === startKf.id)!.s;
    const midSAfter = kfs.find((k) => k.id === midKf.id)!.s;
    const startDelta = startSAfter - startSBefore;
    const midDelta = midSAfter - midSBefore;
    const tol = 0.5 / pxPerU; // sub-pixel tolerance — tight enough that a 1px drag reds
    // the drag was real (the cursor moved a substantial distance) — the separation and the
    // third keyframe's placement (see comments above) keep this well clear of the third member's
    // own room, so the shared delta reaches the overlap-target's neighbourhood uncapped by it.
    const expectedDs = (endKfPx.x - startKfPx.x) / pxPerU;
    expect(Math.abs(expectedDs)).toBeGreaterThan(tol);
    // the block held: both members moved by the same delta (offset preserved)
    expect(Math.abs(startDelta - midDelta)).toBeLessThan(tol);
    // the discriminating half: the start member never reached the end keyframe's station — the
    // Δd cap held it strictly short, within a small station-unit margin of the room's own edge
    // (`OVERLAP_CAP_EPS`, Timeline.svelte) rather than merely "less than its pre-drag position".
    const gapToOccupied = endKf.s - startSAfter;
    expect(gapToOccupied).toBeGreaterThan(0); // strictly short — never reaches the occupied station
    expect(gapToOccupied).toBeLessThan(0.01); // ...but held right at the room's edge, not far short
});

// S5 capture arm (F1): a strip BODY drag carries its keyframes — the same Δd `bandMove`'s
// "body" branch applies to `Strip.start`/`end` is applied to every `StripKeyframe.s` on it
// (`Timeline.svelte`'s `bandMove`, the `kfs` capture at gesture start in `bandDown`). This flow
// widens a freshly-created strip (seeded with two keyframes at its own start/end, S4), then
// drags the BODY — not an edge — via a real pointer gesture on the header band, and asserts
// BOTH seeded keyframes moved by the same Δd the strip's own `start` moved by.
//
// RED-FIRST WITNESS: reverted `bandMove`'s "body" branch to the pre-S5 shape (`setStrip` alone,
// no `kfs` loop). The flow red at the per-keyframe assert: both keyframes' `s` stayed at their
// pre-drag position while the strip's own `start`/`end` moved by the full drag distance — `dd`
// was nonzero but every keyframe's own delta read 0. Restored the loop; green.
test("strip body drag carries its keyframes (F1)", async ({ page, boot }) => {
    await boot();
    await seedHill(page);
    await frameTimeline(page);

    const stripsOf = () => kexCall(page, "stripsOf", 0);
    const stripKeyframesOf = (id: number) => kexCall(page, "stripKeyframesOf", id);
    const xView = () => kexCall(page, "xView") as Promise<[number, number]>;
    const uTotal = () => kexCall(page, "uTotal") as Promise<number>;

    // create a strip (right-click on the band → Add velocity strip), the T1 flow's own idiom.
    const beforeStrips = (await stripsOf()) as { id: number }[];
    const bandBb = await page.locator(".hbandzone").boundingBox();
    const clipBb = await page.locator(".clip").first().boundingBox();
    if (!bandBb || !clipBb) throw new Error("header band / clip not laid out");
    const bandY = bandBb.y + bandBb.height / 2;
    const bandX = clipBb.x + clipBb.width * 0.2;
    await page.mouse.click(bandX, bandY, { button: "right" });
    await expect(page.locator(".smenu")).toBeVisible();
    await clickMenuItem(page, ".smenu", "Add velocity strip");
    await expect.poll(async () => (await stripsOf()).length).toBe(beforeStrips.length + 1);
    await expect.poll(async () => await kexCall(page, "selectedStrip")).not.toBe(null);
    await frames(page, 2); // bandStrips/selStrip settle (the sibling flows' own documented race)

    const beforeIds = new Set(beforeStrips.map((s) => s.id));
    const created = (
        (await stripsOf()) as { id: number; start: number; end: number; value: number }[]
    ).find((s) => !beforeIds.has(s.id));
    if (!created) throw new Error("newly-created strip not found");
    const stripId0 = created.id;

    // widen via a real edge drag, well clear of the track's own end — a min-extent creation is
    // too narrow to safely grab the BODY clear of both edges (`velocity strip keyframe editing
    // flow`'s own idiom), but this fixture's track is short (~20-25 m), so a fixed-pixel widen
    // can overshoot the track's own end and jam the strip flush against it, leaving zero body
    // headroom in EITHER direction (measured: uTotal === the widened strip's own end). Target a
    // station instead of a pixel offset, so the widen always lands with headroom regardless of
    // track length.
    const [, pxPerU] = await xView();
    const total = await uTotal();
    const chartCanvasBb = await page.locator("canvas.chart").boundingBox();
    if (!chartCanvasBb) throw new Error("chart canvas not laid out");
    const spBefore = (
        (await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[]
    ).find((s) => s.id === stripId0);
    if (!spBefore) throw new Error("created strip has no band px");
    const edgePx = chartCanvasBb.x + spBefore.x1;
    const targetEnd = created.start + (total - created.start) * 0.5; // halfway to the track's end
    const widenDxPx = (targetEnd - created.end) * pxPerU;
    await page.mouse.move(edgePx, bandY);
    await page.mouse.down();
    await page.mouse.move(edgePx + widenDxPx, bandY, { steps: 5 });
    await page.mouse.up();

    const kfsBefore = (await stripKeyframesOf(stripId0)) as { id: number; s: number; v: number }[];
    expect(kfsBefore.length).toBe(2); // the two S4-seeded keyframes, at start/end
    const stripBefore = ((await stripsOf()) as { id: number; start: number; end: number }[]).find(
        (s) => s.id === stripId0,
    );
    if (!stripBefore) throw new Error("widened strip not found");
    // both edges cleared the widen with room left over on both sides (never flush against 0 or
    // the track's own end) — the precondition the body drag below needs to move freely.
    const roomRight = total - stripBefore.end;
    const roomLeft = stripBefore.start;
    expect(Math.min(roomRight, roomLeft)).toBeGreaterThan(0.5);

    // grab the BODY at its midpoint and drag it toward whichever side has more room, by a
    // modest fraction of that room — the header band row, never the chart row a keyframe
    // diamond drag targets, so this can't be mistaken for a keyframe grab.
    // Ctrl held to bypass the grid/landmark snap (F4: strip body drag now snaps like every
    // other drag on this chart) — this flow tests F1's keyframe-carry precision, not snap, so
    // the drag lands at the deterministic raw pixel-derived station (`strip resize snap
    // grammar (F4)`'s own arm exercises the un-bypassed snap).
    const midS = (stripBefore.start + stripBefore.end) / 2;
    const midPx = clipBb.x + midS * pxPerU;
    const ds = (roomRight >= roomLeft ? Math.min(roomRight, 3) : -Math.min(roomLeft, 3)) * 0.5;
    const DxPx = ds * pxPerU;
    await page.mouse.move(midPx, bandY);
    await page.keyboard.down("Control");
    await page.mouse.down();
    await page.mouse.move(midPx + DxPx, bandY, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up("Control");

    const stripAfter = ((await stripsOf()) as { id: number; start: number; end: number }[]).find(
        (s) => s.id === stripId0,
    );
    if (!stripAfter) throw new Error("dragged strip not found");
    const dd = stripAfter.start - stripBefore.start;
    const tol = 2 / pxPerU;
    expect(Math.abs(dd - ds)).toBeLessThan(tol); // the body actually moved by the intended Δd

    const kfsAfter = (await stripKeyframesOf(stripId0)) as { id: number; s: number; v: number }[];
    for (const before of kfsBefore) {
        const after = kfsAfter.find((k) => k.id === before.id);
        if (!after) throw new Error(`keyframe ${before.id} vanished across the body drag`);
        expect(Math.abs(after.s - (before.s + dd))).toBeLessThan(tol);
    }
});

// S5 capture arm (F2): a keyframe left outside its strip's extent by a resize is never
// clamped back inside on grab — `applyKeyframeDrag`/`setStripKeyframe` no longer carry a
// `[start, end]` clamp bound (Timeline.svelte, track.ts). This flow widens a strip, authors a
// keyframe near its right portion (`placeStripKf`, the same direct-authoring SETUP convention
// `sectionForceCounts`'s own docblock documents for `setLen`), then SHRINKS the strip's end
// past that keyframe's own station via a real edge drag — `setStrip` never touches a keyframe
// (non-sticking, S3/S4), so the keyframe stays exactly where it was, now outside the new
// extent. Grabbing it and dragging a small distance must move it BY the drag, never snap it
// back to the strip's own edge.
//
// RED-FIRST WITNESS: restored the pre-S5 clamp (`clamp(m.s0 + dsWrite, m.lo, m.len)` in
// `applyKeyframeDrag`, `Math.max(start, Math.min(end, s))` in `setStripKeyframe`). The flow
// red at the post-grab assert: the keyframe's `s` read exactly `strip.end` (the buggy snap)
// instead of `kfBefore.s + DxPx/pxPerU` — the very first move clamped it back inside.
// Restored the fix; green.
test("keyframe grab drags freely past its strip's extent after a resize leaves it outside (F2)", async ({
    page,
    boot,
}) => {
    await boot();
    await seedHill(page);
    await frameTimeline(page);

    const stripsOf = () => kexCall(page, "stripsOf", 0);
    const stripKeyframesOf = (id: number) => kexCall(page, "stripKeyframesOf", id);
    const stripKfPx = () => kexCall(page, "stripKfPx");
    const xView = () => kexCall(page, "xView") as Promise<[number, number]>;
    const uTotal = () => kexCall(page, "uTotal") as Promise<number>;

    const beforeStrips = (await stripsOf()) as { id: number }[];
    const bandBb = await page.locator(".hbandzone").boundingBox();
    const clipBb = await page.locator(".clip").first().boundingBox();
    if (!bandBb || !clipBb) throw new Error("header band / clip not laid out");
    const bandY = bandBb.y + bandBb.height / 2;
    const bandX = clipBb.x + clipBb.width * 0.2;
    await page.mouse.click(bandX, bandY, { button: "right" });
    await expect(page.locator(".smenu")).toBeVisible();
    await clickMenuItem(page, ".smenu", "Add velocity strip");
    await expect.poll(async () => (await stripsOf()).length).toBe(beforeStrips.length + 1);
    await frames(page, 2);

    const beforeIds = new Set(beforeStrips.map((s) => s.id));
    const created = (
        (await stripsOf()) as { id: number; start: number; end: number; value: number }[]
    ).find((s) => !beforeIds.has(s.id));
    if (!created) throw new Error("newly-created strip not found");
    const stripId0 = created.id;

    // widen well clear of the min-extent floor, but STOP well short of the track's own end
    // (a fixture-specific fixed-pixel widen can overshoot a short track and jam the strip
    // flush against `uTotal`, leaving zero room for the shrink below — the sibling F1 arm's
    // own finding). Target a station derived from `uTotal`, never a fixed pixel offset.
    const [, pxPerU] = await xView();
    const total = await uTotal();
    const chartCanvasBb = await page.locator("canvas.chart").boundingBox();
    if (!chartCanvasBb) throw new Error("chart canvas not laid out");
    let sp = ((await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[]).find(
        (s) => s.id === stripId0,
    );
    if (!sp) throw new Error("created strip has no band px");
    const targetEnd = created.start + (total - created.start) * 0.7; // leaves ~30% of the track past it
    const widenDxPx = (targetEnd - created.end) * pxPerU;
    await page.mouse.move(chartCanvasBb.x + sp.x1, bandY);
    await page.mouse.down();
    await page.mouse.move(chartCanvasBb.x + sp.x1 + widenDxPx, bandY, { steps: 5 });
    await page.mouse.up();

    let strip = ((await stripsOf()) as { id: number; start: number; end: number }[]).find(
        (s) => s.id === stripId0,
    );
    if (!strip) throw new Error("widened strip not found");

    // author a keyframe near the strip's right portion, well inside its current extent.
    const kfS = strip.end - (strip.end - strip.start) * 0.1;
    const kfId = (await kexCall(page, "placeStripKf", stripId0, kfS, 6)) as number;
    await expect
        .poll(async () =>
            (await stripKeyframesOf(stripId0)).some((k: { id: number }) => k.id === kfId),
        )
        .toBe(true);

    // shrink the strip's END back below the keyframe's own station via a real edge drag.
    sp = ((await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[]).find(
        (s) => s.id === stripId0,
    );
    if (!sp) throw new Error("widened strip has no band px");
    const shrinkPx = (strip.end - strip.start) * 0.5 * pxPerU;
    await page.mouse.move(chartCanvasBb.x + sp.x1, bandY);
    await page.mouse.down();
    await page.mouse.move(chartCanvasBb.x + sp.x1 - shrinkPx, bandY, { steps: 5 });
    await page.mouse.up();

    strip = ((await stripsOf()) as { id: number; start: number; end: number }[]).find(
        (s) => s.id === stripId0,
    )!;
    let kfs = (await stripKeyframesOf(stripId0)) as { id: number; s: number; v: number }[];
    const kfBefore = kfs.find((k) => k.id === kfId)!;
    // the resize left the keyframe outside the strip's new extent — the bug's own precondition.
    expect(kfBefore.s).toBeGreaterThan(strip.end);

    // GRAB the out-of-extent keyframe (its own drawn diamond, still projected truthfully at its
    // real, unclamped `s` — `computeStripKfPts` never filters by extent) and drag it a small
    // distance. Ctrl held to bypass snap; the per-axis gesture-start magnet still survives the
    // bypass (`applyKeyframeDrag`'s own note), so DxPx stays well past `SNAP_PX` (8) — the
    // sibling flows' own convention — or the magnet holds the result at the grab origin.
    const kfPxAll = (await stripKfPx()) as { id: number; x: number; y: number }[];
    const kfPx = kfPxAll.find((k) => k.id === kfId);
    if (!kfPx) throw new Error("out-of-extent keyframe has no drawn diamond");
    const DxPx = 20;
    await page.mouse.move(kfPx.x, kfPx.y);
    await page.keyboard.down("Control");
    await page.mouse.down();
    await page.mouse.move(kfPx.x + DxPx, kfPx.y, { steps: 3 });
    await page.mouse.up();
    await page.keyboard.up("Control");

    kfs = (await stripKeyframesOf(stripId0)) as { id: number; s: number; v: number }[];
    const kfAfter = kfs.find((k) => k.id === kfId)!;
    const tol = 2 / pxPerU;
    expect(Math.abs(kfAfter.s - (kfBefore.s + DxPx / pxPerU))).toBeLessThan(tol);
    expect(kfAfter.s).toBeGreaterThan(strip.end); // still outside — never snapped back in
});

const S_GRID = 1; // `timeline.ts`'s own arclength quantum — the ONE home is the module; this
// mirrors `strip keyframe snap landing`'s own hardcoded V_GRID convention (no `__kex` const export).
const onGrid = (v: number): boolean => Math.abs(v / S_GRID - Math.round(v / S_GRID)) < 1e-6;

// S6 capture arm (F4): the force-section extent trim (`applyLen`) and a strip resize
// (`bandMove`) now route the RESULTING edge through the SAME shared resolver a keyframe drag
// rides (`snapAxis`) — snapping ON lands both on an S_GRID (1 m) increment when no landmark is
// in range (neither drag below has one reachable: the segment's own force points sit well
// inside the ORIGINAL extent, behind the widened edge; the strip is created with room to
// drag without hitting the track's own end). The Ctrl twin below asserts the bypass — this is
// the arm that discharges the Residue instance list (S1's own six recorded
// `.clip-trim` Ctrl-bypass sites): the segment half here is the first `.clip-trim` flow that
// does NOT hold Ctrl through the drag.
//
// RED-FIRST WITNESS: replaced `applyLen`'s `const r = snapAxis(...)` call with a raw
// passthrough (`{ value: rawU, guide: null }`) and, separately, `bandMove`'s own call the same
// way. Both mutations reded this flow at the `onGrid` assertion (exit 1 each, one at a time)
// — the drag landed at the raw pixel-derived station instead of the nearest metre. Restored
// both; green.
test("segment and strip resize snap to grid increments (F4)", async ({ page, boot }) => {
    await boot();
    await kexCall(page, "seedForceBump");
    // widen the section past the fixture's own default flat seed (24 m, `EXTEND_DIST`) -- gives
    // a strip created on it (STRIP_DEFAULT_LEN, 10 m as of F3, an independent literal) room to
    // drag on either side without hitting the track's own end. Test
    // SETUP, the same `setLen` hook the domain flow uses for its own short-track fixture.
    await kexCall(page, "setLen", 0, 80);
    await expect.poll(async () => kexCall(page, "forceCount")).toBe(5);
    await frameTimeline(page);

    const stripsOf = () =>
        kexCall(page, "stripsOf", 0) as Promise<
            { id: number; start: number; end: number; value: number }[]
        >;

    // ── strip resize FIRST (before any segment trim -- a trim widens/undoes the section's
    // own extent, and the view's zoom never re-fits down after an undo, `commitLength`'s own
    // note, so a fraction-of-clip-width strip placement done AFTER a trim can land past the
    // reverted extent). Create a strip at 40% of the clip width, giving room to drag its BODY
    // without hitting the track's own end, no Ctrl. ──
    const beforeStrips = await stripsOf();
    const total = (await kexCall(page, "uTotal")) as number;
    const bandBb = await page.locator(".hbandzone").boundingBox();
    const clipBb = await page.locator(".clip").first().boundingBox();
    if (!bandBb || !clipBb) throw new Error("header band / clip not laid out");
    const bandY = bandBb.y + bandBb.height / 2;
    const bandX = clipBb.x + clipBb.width * 0.4; // room to drag before the track's own end
    await page.mouse.click(bandX, bandY, { button: "right" });
    await expect(page.locator(".smenu")).toBeVisible();
    await clickMenuItem(page, ".smenu", "Add velocity strip");
    await expect.poll(async () => (await stripsOf()).length).toBe(beforeStrips.length + 1);
    await frames(page, 2); // bandStrips/selStrip settle (the sibling flows' own documented race)
    const beforeIds = new Set(beforeStrips.map((s) => s.id));
    const created = (await stripsOf()).find((s) => !beforeIds.has(s.id));
    if (!created) throw new Error("newly-created strip not found");

    const [, pxPerU] = (await kexCall(page, "xView")) as [number, number];
    const midS = (created.start + created.end) / 2;
    const midPx = clipBb.x + midS * pxPerU;
    // room to move without hitting the track's own end or the strip's own extent floor.
    const room = Math.min(created.start, total - created.end);
    expect(room).toBeGreaterThan(1); // the fixture's own precondition for a real body drag
    const ds = Math.min(room * 0.5, 6.3); // an off-grid station, well past SNAP_PX
    await page.mouse.move(midPx, bandY);
    await page.mouse.down();
    await page.mouse.move(midPx + ds * pxPerU, bandY, { steps: 8 });
    await page.mouse.up();
    const after = (await stripsOf()).find((s) => s.id === created.id);
    if (!after) throw new Error("dragged strip not found");
    expect(after.start).not.toBeCloseTo(created.start, 3); // it actually moved
    expect(onGrid(after.start)).toBe(true); // the body's own rigidly-translated start landed
    // on the grid, not the raw cursor station.

    // ── segment resize: the force clip's right-edge extent trim handle, no Ctrl. ──
    const sectionLengths = () => kexCall(page, "sectionLengths") as Promise<number[]>;
    const before = await sectionLengths();
    const trim = page.locator(".clip-trim");
    await expect(trim).toHaveCount(1);
    const tb = await trim.boundingBox();
    if (!tb) throw new Error("trim handle not laid out");
    const cy = tb.y + tb.height / 2;
    await trim.hover();
    await page.mouse.down();
    // an off-grid px delta, well past SNAP_PX (8) — the grid quantum, not a coincidental raw
    // landing, is what resolves this drag (no reachable landmark: the section's own force
    // points sit well inside the ORIGINAL extent, behind the widened edge, and nothing parks
    // the playhead).
    await page.mouse.move(tb.x + tb.width / 2 + 63.4, cy, { steps: 11 });
    await page.mouse.up();
    const afterLen = (await sectionLengths())[0];
    expect(afterLen).toBeGreaterThan(before[0]);
    expect(onGrid(afterLen)).toBe(true); // the section's entry is d=0 (seedForceBump), so the
    // landed length IS the landed edge station.
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await sectionLengths())[0]).toBeCloseTo(before[0], 3);
});

// S6 capture arm (F4), the Ctrl twin: the same two drags, Ctrl held throughout — the resolver's
// bypass branch, exercised through the production handler rather than `snapAxis`'s own pure
// unit arm (`tests/timeline.test.ts`). Landing is the raw, unsnapped station (within a
// sub-pixel tolerance derived from `pxPerU`, matching every other deterministic-px arm in this
// file) — proving the bypass reaches BOTH handlers, not just the (pre-existing) keyframe path.
// This is the arm that discharges the Residue instance list (S1's own six recorded
// `.clip-trim` Ctrl-bypass sites): the segment half here is a `.clip-trim` flow whose OWN
// Ctrl hold is exercising the bypass itself, never citing a unit arm to opt out of it — its
// sibling (above) is the un-bypassed trim snap the residue names.
test("segment and strip resize Ctrl bypasses grid snap (F4)", async ({ page, boot }) => {
    await boot();
    await kexCall(page, "seedForceBump");
    // widen the section past the fixture's own default flat seed (24 m, `EXTEND_DIST`) -- gives
    // a strip created on it (STRIP_DEFAULT_LEN, 10 m as of F3, an independent literal) room to
    // drag on either side without hitting the track's own end. Test
    // SETUP, the same `setLen` hook the domain flow uses for its own short-track fixture.
    await kexCall(page, "setLen", 0, 80);
    await expect.poll(async () => kexCall(page, "forceCount")).toBe(5);
    await frameTimeline(page);

    const stripsOf = () =>
        kexCall(page, "stripsOf", 0) as Promise<
            { id: number; start: number; end: number; value: number }[]
        >;

    // ── strip resize, Ctrl held, FIRST (see the sibling arm's own note on ordering). ──
    const beforeStrips = await stripsOf();
    const total = (await kexCall(page, "uTotal")) as number;
    const bandBb = await page.locator(".hbandzone").boundingBox();
    const clipBb = await page.locator(".clip").first().boundingBox();
    if (!bandBb || !clipBb) throw new Error("header band / clip not laid out");
    const bandY = bandBb.y + bandBb.height / 2;
    const bandX = clipBb.x + clipBb.width * 0.4;
    await page.mouse.click(bandX, bandY, { button: "right" });
    await expect(page.locator(".smenu")).toBeVisible();
    await clickMenuItem(page, ".smenu", "Add velocity strip");
    await expect.poll(async () => (await stripsOf()).length).toBe(beforeStrips.length + 1);
    await frames(page, 2);
    const beforeIds = new Set(beforeStrips.map((s) => s.id));
    const created = (await stripsOf()).find((s) => !beforeIds.has(s.id));
    if (!created) throw new Error("newly-created strip not found");

    const [, pxPerU] = (await kexCall(page, "xView")) as [number, number];
    const midS = (created.start + created.end) / 2;
    const midPx = clipBb.x + midS * pxPerU;
    const room = Math.min(created.start, total - created.end);
    expect(room).toBeGreaterThan(1);
    const ds = Math.min(room * 0.5, 6.3);
    await page.mouse.move(midPx, bandY);
    await page.keyboard.down("Control");
    await page.mouse.down();
    await page.mouse.move(midPx + ds * pxPerU, bandY, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up("Control");
    const after = (await stripsOf()).find((s) => s.id === created.id);
    if (!after) throw new Error("dragged strip not found");
    expect(Math.abs(after.start - (created.start + ds))).toBeLessThan(2 / pxPerU);
    expect(onGrid(after.start)).toBe(false);

    // ── segment resize, Ctrl held: lands at the raw pixel-derived length (Distance domain,
    // section entry at d=0, so `dOf` is the identity — the length delta IS the raw px/pxPerU
    // delta, no gesture-frozen-table conversion needed). ──
    const sectionLengths = () => kexCall(page, "sectionLengths") as Promise<number[]>;
    const [, pxPerU0] = (await kexCall(page, "xView")) as [number, number];
    const before = await sectionLengths();
    const trim = page.locator(".clip-trim");
    await expect(trim).toHaveCount(1);
    const tb = await trim.boundingBox();
    if (!tb) throw new Error("trim handle not laid out");
    const cy = tb.y + tb.height / 2;
    const dragPx = 63.4;
    await trim.hover();
    await page.keyboard.down("Control");
    await page.mouse.down();
    await page.mouse.move(tb.x + tb.width / 2 + dragPx, cy, { steps: 11 });
    await page.mouse.up();
    await page.keyboard.up("Control");
    const afterLen = (await sectionLengths())[0];
    const expectedLen = before[0] + dragPx / pxPerU0;
    expect(Math.abs(afterLen - expectedLen)).toBeLessThan(2 / pxPerU0);
    // the positive control: the bypass landed off the S_GRID quantum (the mutation this arm's
    // sibling arm's own witness kills would have rounded it there instead).
    expect(onGrid(afterLen)).toBe(false);
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await sectionLengths())[0]).toBeCloseTo(before[0], 3);
});

// S2 reachability arm 1: shift-clicking a force keyframe and then a strip keyframe leaves BOTH
// selected, read back as members of one set. RED-FIRST WITNESS: at the pre-fix ref, the
// `selectStrip(k.strip)` call in `keyframeDown` (run unconditionally before the shift-check)
// replace-selects the strip, clearing the force selection via `clearAllMembers`. After S2's
// `ensureStrip` fix, the shift-click adds the owning strip without clearing others.
test("shift-click a force keyframe and a strip keyframe leaves both selected (S2)", async ({
    page,
    boot,
}) => {
    await boot();
    await kexCall(page, "seedForceBump");
    await expect.poll(async () => kexCall(page, "forceCount")).toBe(5);
    await frameTimeline(page);

    const forceSelIds = () => kexCall(page, "forceSelIds") as Promise<number[]>;
    const stripKfSelIds = () => kexCall(page, "stripKfSelIds") as Promise<number[]>;
    const stripKfPx = () =>
        kexCall(page, "stripKfPx") as Promise<{ id: number; x: number; y: number }[]>;

    const len = ((await kexCall(page, "sectionLengths")) as number[])[0];
    const stripId = (await kexCall(page, "addStripAt", len * 0.3, len * 0.9, 4)) as number;
    const kfId = (await kexCall(page, "placeStripKf", stripId, len * 0.6, 6)) as number;

    const bandBb = await page.locator(".hbandzone").boundingBox();
    const chartCanvasBb = await page.locator("canvas.chart").boundingBox();
    if (!bandBb || !chartCanvasBb) throw new Error("layout not ready");
    const bandY = bandBb.y + bandBb.height / 2;
    const sp = ((await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[]).find(
        (s) => s.id === stripId,
    );
    if (!sp) throw new Error("created strip has no band px");
    await page.mouse.click(chartCanvasBb.x + (sp.x0 + sp.x1) / 2, bandY);
    await expect.poll(async () => kexCall(page, "selectedStrip")).toBe(stripId);

    let kfPx: { id: number; x: number; y: number }[] = [];
    await expect
        .poll(async () => {
            kfPx = await stripKfPx();
            return kfPx.some((k) => k.id === kfId);
        })
        .toBe(true);
    const target = kfPx.find((k) => k.id === kfId);
    if (!target) throw new Error("strip keyframe not projected");

    const forceHit = page.locator(".fhit").first();
    const forceCenter = async (): Promise<{ x: number; y: number }> => {
        const b = await forceHit.boundingBox();
        if (!b) throw new Error("force diamond not laid out");
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };
    const fp = await forceCenter();
    await page.mouse.click(fp.x, fp.y);
    await expect.poll(async () => (await forceSelIds()).length).toBe(1);

    await page.keyboard.down("Shift");
    await page.mouse.click(target.x, target.y);
    await page.keyboard.up("Shift");
    await expect.poll(async () => (await stripKfSelIds()).length).toBe(1);
    await expect.poll(async () => (await forceSelIds()).length).toBe(1);
});

test("marquee over two different strips' keyframes takes both (S2)", async ({ page, boot }) => {
    await boot();
    await kexCall(page, "seedForceBump");
    await expect.poll(async () => kexCall(page, "forceCount")).toBe(5);
    await frameTimeline(page);

    const stripKfSelIds = () => kexCall(page, "stripKfSelIds") as Promise<number[]>;
    const stripKfPx = () =>
        kexCall(page, "stripKfPx") as Promise<{ id: number; x: number; y: number }[]>;
    const stripsOf = () =>
        kexCall(page, "stripsOf", 0) as Promise<
            { id: number; start: number; end: number; value: number }[]
        >;

    const len = ((await kexCall(page, "sectionLengths")) as number[])[0];
    // two strips at non-overlapping positions (avoiding the seed strip at station 0)
    const stripA = (await kexCall(page, "addStripAt", len * 0.3, len * 0.5, 5)) as number;
    const stripB = (await kexCall(page, "addStripAt", len * 0.6, len * 0.9, 3)) as number;
    if (stripA === null || stripB === null) throw new Error("strip creation failed (overlap?)");
    const kfA = (await kexCall(page, "placeStripKf", stripA, len * 0.4, 7)) as number;
    const kfB = (await kexCall(page, "placeStripKf", stripB, len * 0.75, 2)) as number;

    // select stripA first (so editor.strip === stripA, the pre-fix filter's scope)
    const bandBb = await page.locator(".hbandzone").boundingBox();
    const chartCanvasBb = await page.locator("canvas.chart").boundingBox();
    if (!bandBb || !chartCanvasBb) throw new Error("layout not ready");
    const bandY = bandBb.y + bandBb.height / 2;
    await expect.poll(async () => (await stripsOf()).some((s) => s.id === stripA)).toBe(true);
    const allStrips = await stripsOf();
    const sa = allStrips.find((s) => s.id === stripA)!;
    const [, pxPerU] = (await kexCall(page, "xView")) as [number, number];
    const stripAx = chartCanvasBb.x + 44 + ((sa.start + sa.end) / 2) * pxPerU;
    await page.mouse.click(stripAx, bandY);
    await expect.poll(async () => kexCall(page, "selectedStrip")).toBe(stripA);

    let kfPx: { id: number; x: number; y: number }[] = [];
    await expect
        .poll(async () => {
            kfPx = await stripKfPx();
            return kfPx.some((k) => k.id === kfA) && kfPx.some((k) => k.id === kfB);
        })
        .toBe(true);
    const pxA = kfPx.find((k) => k.id === kfA)!;
    const pxB = kfPx.find((k) => k.id === kfB)!;

    const xLo = Math.min(pxA.x, pxB.x) - 8;
    const xHi = Math.max(pxA.x, pxB.x) + 8;
    const yLo = Math.min(pxA.y, pxB.y) - 12;
    const yHi = Math.max(pxA.y, pxB.y) + 12;
    await marqueeDrag(page, xLo, yLo, xHi, yHi);
    // the marquee may also catch seeded boundary keyframes — assert both interior keyframes
    // are in the selected set (the reachability claim: keyframes from two different strips)
    await expect.poll(async () => (await stripKfSelIds()).length).toBeGreaterThanOrEqual(2);
    const sel = (await stripKfSelIds()).sort((a, b) => a - b);
    expect(sel).toContain(kfA);
    expect(sel).toContain(kfB);
});

test("mixed-set drag axis law: horizontal moves strip stations only, vertical moves none when the set spans both domains (S5/S4)", async ({
    page,
    boot,
}) => {
    await boot();
    await kexCall(page, "seedForceBump");
    await expect.poll(async () => kexCall(page, "forceCount")).toBe(5);
    await frameTimeline(page);

    const forceSelIds = () => kexCall(page, "forceSelIds") as Promise<number[]>;
    const stripKfSelIds = () => kexCall(page, "stripKfSelIds") as Promise<number[]>;
    const stripKfPx = () =>
        kexCall(page, "stripKfPx") as Promise<{ id: number; x: number; y: number }[]>;
    const stripKeyframesOf = (id: number) => kexCall(page, "stripKeyframesOf", id);
    const sectionForces = () =>
        kexCall(page, "forces") as Promise<{ id: number; s: number; g: number }[]>;

    const len = ((await kexCall(page, "sectionLengths")) as number[])[0];
    const stripId = (await kexCall(page, "addStripAt", len * 0.3, len * 0.9, 4)) as number;
    if (stripId === null) throw new Error("strip creation failed (overlap?)");
    const kfId = (await kexCall(page, "placeStripKf", stripId, len * 0.6, 6)) as number;

    const bandBb = await page.locator(".hbandzone").boundingBox();
    const chartCanvasBb = await page.locator("canvas.chart").boundingBox();
    if (!bandBb || !chartCanvasBb) throw new Error("layout not ready");
    const bandY = bandBb.y + bandBb.height / 2;
    const sp = ((await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[]).find(
        (s) => s.id === stripId,
    );
    if (!sp) throw new Error("created strip has no band px");
    await page.mouse.click(chartCanvasBb.x + (sp.x0 + sp.x1) / 2, bandY);
    await expect.poll(async () => kexCall(page, "selectedStrip")).toBe(stripId);

    let kfPx: { id: number; x: number; y: number }[] = [];
    await expect
        .poll(async () => {
            kfPx = await stripKfPx();
            return kfPx.some((k) => k.id === kfId);
        })
        .toBe(true);
    const stripKfTarget = kfPx.find((k) => k.id === kfId)!;

    const forceHit = page.locator(".fhit").first();
    const forceCenter = async (): Promise<{ x: number; y: number }> => {
        const b = await forceHit.boundingBox();
        if (!b) throw new Error("force diamond not laid out");
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };
    const fp = await forceCenter();
    await page.mouse.click(fp.x, fp.y);
    await expect.poll(async () => (await forceSelIds()).length).toBe(1);
    const forceId = (await forceSelIds())[0];

    const forcesBefore = await sectionForces();
    const forceBefore = forcesBefore.find((f) => f.id === forceId)!;
    const stripKfsBefore = (await stripKeyframesOf(stripId)) as {
        id: number;
        s: number;
        v: number;
    }[];
    const stripKfBefore = stripKfsBefore.find((k) => k.id === kfId)!;

    await page.keyboard.down("Shift");
    await page.mouse.click(stripKfTarget.x, stripKfTarget.y);
    await page.keyboard.up("Shift");
    await expect.poll(async () => (await stripKfSelIds()).length).toBe(1);
    await expect.poll(async () => (await forceSelIds()).length).toBe(1);

    // Re-locate the strip keyframe after the shift-click. It is the active member (the last
    // toggled-in member), so the drag starts at its current projection.
    let skDrag: { id: number; x: number; y: number }[] = [];
    await expect
        .poll(async () => {
            skDrag = await stripKfPx();
            return skDrag.some((k) => k.id === kfId);
        })
        .toBe(true);
    const skDragPt = skDrag.find((k) => k.id === kfId)!;
    const [, pxPerU] = (await kexCall(page, "xView")) as [number, number];
    const dragDs = 5;
    const dragPx = dragDs * pxPerU;
    await page.mouse.move(skDragPt.x, skDragPt.y);
    await page.mouse.down();
    await page.mouse.move(skDragPt.x + dragPx, skDragPt.y, { steps: 10 });
    await page.mouse.up();

    await expect.poll(async () => (await forceSelIds()).length).toBe(1);
    const forcesAfterH = await sectionForces();
    const forceAfterH = forcesAfterH.find((f) => f.id === forceId)!;
    const stripKfsAfterH = (await stripKeyframesOf(stripId)) as {
        id: number;
        s: number;
        v: number;
    }[];
    const stripKfAfterH = stripKfsAfterH.find((k) => k.id === kfId)!;

    const forceDs = forceAfterH.s - forceBefore.s;
    const stripKfDs = stripKfAfterH.s - stripKfBefore.s;
    // S4 removes the force position axis, so a strip-originated mixed drag moves only the
    // strip station. The strip VALUE remains unchanged because this is a horizontal drag.
    expect(forceDs).toBeCloseTo(0, 5); // force station is fixed
    expect(Math.abs(stripKfDs)).toBeGreaterThan(2 / pxPerU); // surviving strip station moved
    expect(stripKfAfterH.v).toBe(stripKfBefore.v); // value unchanged

    // Repeat the same mixed-set station drag from the FORCE diamond. The strip member supplies
    // the station anchor and snap targets; the force member's own station remains fixed.
    const forceBeforeAnchor = forceAfterH;
    const stripBeforeAnchor = stripKfAfterH;
    const forceAnchor = await forceCenter();
    const [, forceAnchorPxPerU] = (await kexCall(page, "xView")) as [number, number];
    const forceAnchorDragPx = dragDs * forceAnchorPxPerU;
    await page.mouse.move(forceAnchor.x, forceAnchor.y);
    await page.mouse.down();
    await page.mouse.move(forceAnchor.x + forceAnchorDragPx, forceAnchor.y, { steps: 10 });
    await page.mouse.up();

    const forceAfterAnchor = (await sectionForces()).find((f) => f.id === forceId)!;
    const stripAfterAnchor = (
        (await stripKeyframesOf(stripId)) as {
            id: number;
            s: number;
            v: number;
        }[]
    ).find((k) => k.id === kfId)!;
    expect(forceAfterAnchor.s).toBe(forceBeforeAnchor.s); // force station stays fixed
    expect(Math.abs(stripAfterAnchor.s - stripBeforeAnchor.s)).toBeGreaterThan(
        2 / forceAnchorPxPerU,
    ); // strip station moves from a force-originated drag
    expect(stripAfterAnchor.v).toBe(stripBeforeAnchor.v); // value unchanged

    const stripKfBeforeV = stripAfterAnchor;
    // re-locate the strip keyframe for the vertical drag
    let skDrag2: { id: number; x: number; y: number }[] = [];
    await expect
        .poll(async () => {
            skDrag2 = await stripKfPx();
            return skDrag2.some((k) => k.id === kfId);
        })
        .toBe(true);
    const skDragPt2 = skDrag2.find((k) => k.id === kfId)!;
    await page.mouse.move(skDragPt2.x, skDragPt2.y);
    await page.mouse.down();
    await page.mouse.move(skDragPt2.x, skDragPt2.y + 30, { steps: 10 });
    await page.mouse.up();

    const forcesAfterV = await sectionForces();
    const forceAfterV = forcesAfterV.find((f) => f.id === forceId)!;
    const stripKfsAfterV = (await stripKeyframesOf(stripId)) as {
        id: number;
        s: number;
        v: number;
    }[];
    const stripKfAfterV = stripKfsAfterV.find((k) => k.id === kfId)!;

    // S5 axis law: vertical moves NO member's value when the set spans both keyframe domains —
    // a gesture channel whose meaning is not defined for every member carries no meaning for
    // that gesture. both kinds' values are byte-identical; station is unchanged (vertical only).
    expect(stripKfAfterV.v).toBe(stripKfBeforeV.v); // strip value byte-identical — no move
    expect(forceAfterV.g).toBe(forceAfterAnchor.g); // force value byte-identical — no move
    expect(stripKfAfterV.s).toBe(stripKfBeforeV.s); // station unchanged (vertical only)
});

// S4 repair: a real mixed-family vertical drag has no applied value channel. Its values stay
// unchanged, and because the snap hint must come from the same applied result as the write, it
// must not paint either axis guide while the gesture is live. This is deliberately a focused
// pointer arm rather than a source assertion: the gesture reaches the shared drag path and reads
// the rendered guide painter while pointer capture is active.
test("mixed-family vertical drag writes no values and paints no snap hint", async ({
    page,
    boot,
}) => {
    await boot();
    await kexCall(page, "seedForceBump");
    await expect.poll(async () => kexCall(page, "forceCount")).toBe(5);
    await frameTimeline(page);

    const forceSelIds = () => kexCall(page, "forceSelIds") as Promise<number[]>;
    const stripKfSelIds = () => kexCall(page, "stripKfSelIds") as Promise<number[]>;
    const stripKfPx = () =>
        kexCall(page, "stripKfPx") as Promise<{ id: number; x: number; y: number }[]>;
    const sectionForces = () =>
        kexCall(page, "forces") as Promise<{ id: number; s: number; g: number }[]>;
    const stripKeyframesOf = (id: number) => kexCall(page, "stripKeyframesOf", id);

    const len = ((await kexCall(page, "sectionLengths")) as number[])[0];
    const stripId = (await kexCall(page, "addStripAt", len * 0.3, len * 0.9, 4)) as number;
    if (stripId === null) throw new Error("strip creation failed (overlap?)");
    const kfId = (await kexCall(page, "placeStripKf", stripId, len * 0.6, 6)) as number;

    const bandBb = await page.locator(".hbandzone").boundingBox();
    const chartBb = await page.locator("canvas.chart").boundingBox();
    if (!bandBb || !chartBb) throw new Error("layout not ready");
    const stripPx = (
        (await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[]
    ).find((s) => s.id === stripId);
    if (!stripPx) throw new Error("created strip has no band px");
    await page.mouse.click(chartBb.x + (stripPx.x0 + stripPx.x1) / 2, bandBb.y + bandBb.height / 2);

    const forceHit = page.locator(".fhit").first();
    const forceBox = await forceHit.boundingBox();
    if (!forceBox) throw new Error("force diamond not laid out");
    await page.mouse.click(forceBox.x + forceBox.width / 2, forceBox.y + forceBox.height / 2);
    await expect.poll(async () => (await forceSelIds()).length).toBe(1);
    const forceId = (await forceSelIds())[0];

    let points: { id: number; x: number; y: number }[] = [];
    await expect
        .poll(async () => {
            points = await stripKfPx();
            return points.some((p) => p.id === kfId) && points.some((p) => p.id !== kfId);
        })
        .toBe(true);
    const start = points.find((p) => p.id === kfId)!;
    const target = points.find((p) => p.id !== kfId)!;
    await page.keyboard.down("Shift");
    await page.mouse.click(start.x, start.y);
    await page.keyboard.up("Shift");
    await expect.poll(async () => (await stripKfSelIds()).length).toBe(1);
    await expect.poll(async () => (await forceSelIds()).length).toBe(1);

    const forceBefore = (await sectionForces()).find((p) => p.id === forceId)!;
    const stripBefore = (
        (await stripKeyframesOf(stripId)) as { id: number; s: number; v: number }[]
    ).find((p) => p.id === kfId)!;

    // Move vertically onto another strip keyframe's value landmark. The x coordinate is held
    // exactly at the grabbed station, so this is a genuine vertical mixed-family gesture.
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x, target.y, { steps: 10 });
    await expect
        .poll(async () => (await sectionForces()).find((p) => p.id === forceId)!.g)
        .toBe(forceBefore.g);
    await expect
        .poll(
            async () =>
                ((await stripKeyframesOf(stripId)) as { id: number; s: number; v: number }[]).find(
                    (p) => p.id === kfId,
                )!.v,
        )
        .toBe(stripBefore.v);
    await expect(page.locator(".snapguide")).toHaveCount(0);
    await page.mouse.up();
});

// S5 arm (b): a multi-select WITHIN one domain still moves every member's value, so the
// constraint reads off set composition, not off the mixed case having disabled the channel
// outright. Two force keyframes co-selected, vertical drag — both values move.
//
// RED-FIRST WITNESS: revert `keyframeDown`'s `dvScale: mixed ? 0 : 1` back to `dvScale: 0`
// (the S2 form that zeroed the active kind whenever the other kind was absent — but here
// both members are the same kind, so `mixed` is false and `dvScale` is 1 either way). The
// real red is against the S5 code with `mixed` computed as `true` unconditionally — then
// single-domain value drags stop moving, and this arm reds (exit 1).
test("single-domain multi-select drag still moves every member's value (S5)", async ({
    page,
    boot,
}) => {
    await boot();
    await kexCall(page, "seedForceBump");
    await expect.poll(async () => kexCall(page, "forceCount")).toBe(5);
    await frameTimeline(page);

    const forceSelIds = () => kexCall(page, "forceSelIds") as Promise<number[]>;
    const sectionForces = () =>
        kexCall(page, "forces") as Promise<{ id: number; s: number; g: number }[]>;

    // select two force keyframes (single-domain multi-select)
    const forceHits = page.locator(".fhit");
    const forceCenter = async (idx: number): Promise<{ x: number; y: number }> => {
        const b = await forceHits.nth(idx).boundingBox();
        if (!b) throw new Error(`force diamond ${idx} not laid out`);
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };

    const fp0 = await forceCenter(0);
    await page.mouse.click(fp0.x, fp0.y);
    await expect.poll(async () => (await forceSelIds()).length).toBe(1);
    const id0 = (await forceSelIds())[0];

    const fp1 = await forceCenter(1);
    await page.keyboard.down("Shift");
    await page.mouse.click(fp1.x, fp1.y);
    await page.keyboard.up("Shift");
    await expect.poll(async () => (await forceSelIds()).length).toBe(2);
    const ids = await forceSelIds();
    const id1 = ids.find((i) => i !== id0)!;

    const forcesBefore = await sectionForces();
    const f0Before = forcesBefore.find((f) => f.id === id0)!;
    const f1Before = forcesBefore.find((f) => f.id === id1)!;

    // vertical drag from the second keyframe (the active member)
    await page.mouse.move(fp1.x, fp1.y);
    await page.mouse.down();
    await page.mouse.move(fp1.x, fp1.y + 30, { steps: 10 });
    await page.mouse.up();

    const forcesAfter = await sectionForces();
    const f0After = forcesAfter.find((f) => f.id === id0)!;
    const f1After = forcesAfter.find((f) => f.id === id1)!;

    // single-domain: both members' values moved (the vertical channel is not constrained)
    expect(f0After.g).not.toBe(f0Before.g); // first member value moved
    expect(f1After.g).not.toBe(f1Before.g); // second (active) member value moved
});

// S2 repair round 2, criterion (a): the double-fire observable. With a node and a force
// keyframe co-selected by ordinary shift-click (force first, then node — so the node is the
// active member), one Delete key event must produce exactly ONE edit. The arm asserts the
// edit COUNT (history depth), not the guard's shape, so it survives S3's re-grounding.
//
// RED-FIRST WITNESS: revert Timeline.svelte's force guard from `activeKind() === "force"` to
// `editor.force !== null` (the pre-repair double-fire condition). With that revert, both
// controls.ts's node handler (`activeKind() === "node"` → true) AND Timeline.svelte's force
// handler (`editor.force !== null` → true, the force is co-selected) fire on one Delete press,
// producing TWO history entries. The arm asserts exactly one, so it reds (exit 1).
// `bun test` cannot see this: the handlers live behind `window.addEventListener` inside
// `onMount`, and bun:test has no DOM — so a unit arm asserting a routing predicate is vacuous.
// This capture arm is the only instrument that can see a keydown guard.
test("one Delete on a node+force mixed selection produces exactly one edit (S2 criterion a)", async ({
    page,
    boot,
}) => {
    await boot();
    // seedHill: 7 geo nodes (orders 0-6) in section 0. Append a force section (section 1)
    // with 2 seed force keyframes. The force keyframes are on the timeline; the geo nodes
    // are in the viewport. We need both kinds co-selected to test the double-fire guard.
    await seedHill(page);
    await expect.poll(async () => kexCall(page, "nodeCount")).toBe(7);
    const tBefore = await kexCall(page, "tTotal");
    await kexCall(page, "append", 1); // SectionKind.Force — 2 seed force keyframes
    await expect.poll(async () => kexCall(page, "sectionCount")).toBe(2);
    await expect.poll(async () => kexCall(page, "tTotal")).not.toBe(tBefore); // bake re-landed
    await frameTimeline(page);

    const undoDepth = () => kexCall(page, "undoDepth");
    const forceSelIds = () => kexCall(page, "forceSelIds") as Promise<number[]>;
    const nodeSelOrders = () => kexCall(page, "nodeSelOrders") as Promise<number[]>;
    const activeKind = () => kexCall(page, "activeKind") as Promise<string | null>;

    // 1. select a force keyframe on the timeline (plain click → replace-select, active = force)
    const forceHit = page.locator(".fhit").first();
    const fb = await forceHit.boundingBox();
    if (!fb) throw new Error("force diamond not laid out");
    await page.mouse.click(fb.x + fb.width / 2, fb.y + fb.height / 2);
    await expect.poll(async () => (await forceSelIds()).length).toBe(1);
    expect(await activeKind()).toBe("force");

    // 2. shift-click the chain-end node (order 6) in the viewport — adds the node without
    //    clearing the force (S2: shift-click extends across kinds). The node is now the active
    //    member (last toggled-in). Order 6 is the chain end, so Delete is a valid trim.
    const canvas = page.locator("canvas.viewport");
    const cb = await canvas.boundingBox();
    if (!cb) throw new Error("viewport canvas not laid out");
    await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 3);
    await page.keyboard.press("f"); // frame the viewport
    const nodePt = await nodePoint(page, 6); // the chain end (order 6)
    await page.keyboard.down("Shift");
    await page.mouse.click(cb.x + nodePt.x, cb.y + nodePt.y);
    await page.keyboard.up("Shift");

    // 3. confirm the mixed selection: both kinds present, node active
    await expect.poll(async () => (await forceSelIds()).length).toBe(1); // force still selected
    await expect.poll(async () => (await nodeSelOrders()).length).toBe(1); // node also selected
    await expect.poll(activeKind).toBe("node"); // node is the active member

    // 4. press Delete once, assert exactly ONE edit (history depth +1, not +2)
    const before = await undoDepth();
    await page.keyboard.press("Delete");
    await expect.poll(undoDepth).toBe(before + 1); // exactly one edit — the double-fire would be +2
});

// S2 repair round 2, R6: App.svelte's two permanent `window.addEventListener("keydown")`
// listeners read `editor.section` as a stand-in for "the active selection is a section." With
// cross-kind co-selection, a stale co-selected section makes `editor.section` read non-null
// while `activeKind()` is not "section."
//
// Site 1 (pin-mode listener, ~line 219): `if (bound(BINDINGS.remove, e.key) && editor.section !== null)`
// — INTENDED to swallow Delete on a non-section selection during pin mode, but UNREACHABLE for
// Delete: the handler returns early at `if (!bound(BINDINGS.exitMode, e.key) && !bound(BINDINGS.solve, e.key)) return;`
// for any key that isn't Escape/Enter. The fix (`activeKind() === "section"`) is still more correct
// (it would only swallow when the active kind is actually "section"), but the guard is dead code
// for Delete. Booked as residue — the early return makes the swallow unreachable, so no arm can
// witness a red. The fix is defense-in-depth, not a live-bug repair.
//
// Site 2 (Convert/Pin listener, ~line 233): `const section = editor.section; if (section === null) return;`
// — IS a live bug. With a stale force section co-selected (1 member, editor.section non-null via
// fallback) and a force keyframe active, pressing D fires `solveShape` (force→geo conversion) on
// the stale section. The fix (`activeKind() !== "section"` → return) prevents this.
//
// RED-FIRST WITNESS (D/Convert leg): select the force section (1 section in set), shift-click a
// force keyframe (force keyframe becomes active, section is stale). Press D → pre-fix:
// `editor.section !== null` proceeds, `computeCanSolveShape` returns true (1 force section, live
// bake), `sectionKeyAct` returns "solveShape", the conversion modal appears (`.scrim` visible) —
// RED. Post-fix: `activeKind() !== "section"` returns early, no modal — GREEN.
test("App.svelte Convert/Pin listener routes through activeKind, not editor.section (R6)", async ({
    page,
    boot,
}) => {
    await boot();
    await kexCall(page, "seedForceBump");
    await expect.poll(async () => kexCall(page, "forceCount")).toBe(5);
    await frameTimeline(page);

    const forceSelIds = () => kexCall(page, "forceSelIds") as Promise<number[]>;
    const activeKind = () => kexCall(page, "activeKind") as Promise<string | null>;

    // 1. select the force section (section 0) — 1 section in the set, active = section
    await page.locator(".clip").first().click();
    await expect.poll(async () => kexCall(page, "selectedSection")).not.toBeNull();
    await expect.poll(activeKind).toBe("section");

    // 2. shift-click a force keyframe — force keyframe becomes active, section 0 is stale
    //    (still in the set with 1 member, but activeKind is "force")
    const forceHit = page.locator(".fhit").first();
    await forceHit.click({ modifiers: ["Shift"] });
    await expect.poll(async () => (await forceSelIds()).length).toBe(1);
    await expect.poll(activeKind).toBe("force");
    // the stale section is still co-selected (1 section member in the set)
    await expect.poll(async () => (await kexCall(page, "sectionSelIds")).length).toBe(1);

    // 3. press D — must NOT fire Convert (solveShape) on the stale section.
    //    Pre-fix: `editor.section !== null` → proceeds → `canSolveShape` true → D fires
    //    solveShape → section 0 converts from force to geo (sectionKinds changes) (RED).
    //    Fix: `activeKind() !== "section"` → returns early → section stays force (GREEN).
    //    Asserted on sectionKinds (the durable effect), with a wait long enough for the
    //    async conversion to complete.
    const kindsBefore = await kexCall(page, "sectionKinds");
    await page.evaluate(() => {
        (document.activeElement as HTMLElement)?.blur?.();
    });
    await page.keyboard.press("d");
    // This fixed wait exceeds the measured ~2.03 s worst case; it is not a conversion-time bound.
    await frames(page, 120);
    expect(await kexCall(page, "sectionKinds")).toEqual(kindsBefore);
});

// S3: mixed-set Delete over force + stripKf in ONE history gesture. A force keyframe and a
// strip keyframe are co-selected by shift-click (S2's cross-kind co-selection). Delete must
// remove BOTH in one undo entry — one undo restores all, not N.
//
// RED-FIRST WITNESS: at the pre-fix ref, the active kind's Delete handler fires alone (S2's
// activeKind routing), so only the active kind's members are deleted. The other kind's members
// survive — the arm asserts both are gone, so it reds (the passive kind is still present).
// The history depth is also +1 (one kind's delete records one entry), but the member count
// assertion is what discriminates.
test("mixed-set Delete removes every member across kinds in one gesture (S3)", async ({
    page,
    boot,
}) => {
    await boot();
    await kexCall(page, "seedForceBump");
    await expect.poll(async () => kexCall(page, "forceCount")).toBe(5);
    await frameTimeline(page);

    const undoDepth = () => kexCall(page, "undoDepth");
    const forceSelIds = () => kexCall(page, "forceSelIds") as Promise<number[]>;
    const stripKfSelIds = () => kexCall(page, "stripKfSelIds") as Promise<number[]>;
    const stripKfPx = () =>
        kexCall(page, "stripKfPx") as Promise<{ id: number; x: number; y: number }[]>;
    const sectionForces = () =>
        kexCall(page, "forces") as Promise<{ id: number; s: number; g: number }[]>;
    const stripKeyframesOf = (id: number) => kexCall(page, "stripKeyframesOf", id);
    const activeKind = () => kexCall(page, "activeKind") as Promise<string | null>;

    const len = ((await kexCall(page, "sectionLengths")) as number[])[0];
    const stripId = (await kexCall(page, "addStripAt", len * 0.3, len * 0.9, 4)) as number;
    if (stripId === null) throw new Error("strip creation failed (overlap?)");
    const kfId = (await kexCall(page, "placeStripKf", stripId, len * 0.6, 6)) as number;

    // select the strip, then its keyframe
    const bandBb = await page.locator(".hbandzone").boundingBox();
    const chartCanvasBb = await page.locator("canvas.chart").boundingBox();
    if (!bandBb || !chartCanvasBb) throw new Error("layout not ready");
    const bandY = bandBb.y + bandBb.height / 2;
    const sp = ((await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[]).find(
        (s) => s.id === stripId,
    );
    if (!sp) throw new Error("created strip has no band px");
    await page.mouse.click(chartCanvasBb.x + (sp.x0 + sp.x1) / 2, bandY);
    await expect.poll(async () => kexCall(page, "selectedStrip")).toBe(stripId);

    let kfPx: { id: number; x: number; y: number }[] = [];
    await expect
        .poll(async () => {
            kfPx = await stripKfPx();
            return kfPx.some((k) => k.id === kfId);
        })
        .toBe(true);
    const stripKfTarget = kfPx.find((k) => k.id === kfId)!;

    // select the strip keyframe first (plain click → replace-select, active = stripKf)
    await page.mouse.click(stripKfTarget.x, stripKfTarget.y);
    await expect.poll(async () => (await stripKfSelIds()).length).toBe(1);

    // shift-click the force keyframe → co-select without clearing the stripKf (S2).
    // force is the last toggled-in member, so activeKind is "force".
    const forceHit = page.locator(".fhit").first();
    const fb = await forceHit.boundingBox();
    if (!fb) throw new Error("force diamond not laid out");
    await page.keyboard.down("Shift");
    await page.mouse.click(fb.x + fb.width / 2, fb.y + fb.height / 2);
    await page.keyboard.up("Shift");
    await expect.poll(async () => (await forceSelIds()).length).toBe(1);
    await expect.poll(async () => (await stripKfSelIds()).length).toBe(1);
    await expect.poll(activeKind).toBe("force");

    const forceCountBefore = (await sectionForces()).length;
    const stripKfCountBefore = ((await stripKeyframesOf(stripId)) as unknown[]).length;

    // Delete — one gesture, both kinds gone. The owning strip stays (the containment
    // edge: stripKfs non-empty ⇒ strip non-empty), so assert it survives and stays selected —
    // a strip with one keyframe makes stripKfCount - 1 === 0 read the same whether the strip
    // was deleted with its keyframe or correctly kept, so the strip's own survival is the
    // assertion that discriminates the ancestor-keep.
    const depthBefore = await undoDepth();
    await page.keyboard.press("Delete");
    await expect.poll(undoDepth).toBe(depthBefore + 1); // one edit, not N
    await expect.poll(async () => (await sectionForces()).length).toBe(forceCountBefore - 1);
    await expect
        .poll(async () => ((await stripKeyframesOf(stripId)) as unknown[]).length)
        .toBe(stripKfCountBefore - 1);
    await expect.poll(async () => kexCall(page, "selectedStrip")).toBe(stripId);

    // one Undo restores BOTH
    await page.keyboard.press("Control+z");
    await expect.poll(async () => (await sectionForces()).length).toBe(forceCountBefore);
    await expect
        .poll(async () => ((await stripKeyframesOf(stripId)) as unknown[]).length)
        .toBe(stripKfCountBefore);
});

// S5 (amended from S3): mixed-domain arrow nudge — station moves every member, value moves
// none. A force keyframe (active) and a strip keyframe are co-selected. ArrowRight moves both
// stations by the same Δs; ArrowUp moves NO member's value — both kinds' stored values are
// byte-identical (the S5 axis law: a gesture channel whose meaning is not defined for every
// member of the set carries no meaning for that gesture).
//
// RED-FIRST WITNESS: at the pre-fix ref (S3's code), ArrowUp moves the active kind's value
// (force) while the strip keyframe's value holds. The arm asserts the force value is
// byte-identical after the vertical nudge, so it reds (the force value moved).
test("mixed-domain arrow nudge moves all stations, value for none (S5)", async ({ page, boot }) => {
    await boot();
    await kexCall(page, "seedForceBump");
    await expect.poll(async () => kexCall(page, "forceCount")).toBe(5);
    await frameTimeline(page);

    const forceSelIds = () => kexCall(page, "forceSelIds") as Promise<number[]>;
    const stripKfSelIds = () => kexCall(page, "stripKfSelIds") as Promise<number[]>;
    const stripKfPx = () =>
        kexCall(page, "stripKfPx") as Promise<{ id: number; x: number; y: number }[]>;
    const sectionForces = () =>
        kexCall(page, "forces") as Promise<{ id: number; s: number; g: number }[]>;
    const stripKeyframesOf = (id: number) => kexCall(page, "stripKeyframesOf", id);
    const activeKind = () => kexCall(page, "activeKind") as Promise<string | null>;
    const undoDepth = () => kexCall(page, "undoDepth");

    const len = ((await kexCall(page, "sectionLengths")) as number[])[0];
    const stripId = (await kexCall(page, "addStripAt", len * 0.3, len * 0.9, 4)) as number;
    if (stripId === null) throw new Error("strip creation failed (overlap?)");
    const kfId = (await kexCall(page, "placeStripKf", stripId, len * 0.6, 6)) as number;

    // select the strip, then its keyframe
    const bandBb = await page.locator(".hbandzone").boundingBox();
    const chartCanvasBb = await page.locator("canvas.chart").boundingBox();
    if (!bandBb || !chartCanvasBb) throw new Error("layout not ready");
    const bandY = bandBb.y + bandBb.height / 2;
    const sp = ((await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[]).find(
        (s) => s.id === stripId,
    );
    if (!sp) throw new Error("created strip has no band px");
    // one click, no hover poll and no retry: `bandDown` hit-tests against a snapshot computed
    // fresh from the ECS, so the press cannot miss a strip the ECS already carries.
    const clickX = chartCanvasBb.x + (sp.x0 + sp.x1) / 2;
    await page.mouse.click(clickX, bandY);
    await expect.poll(async () => kexCall(page, "selectedStrip")).toBe(stripId);

    let kfPx: { id: number; x: number; y: number }[] = [];
    await expect
        .poll(async () => {
            kfPx = await stripKfPx();
            return kfPx.some((k) => k.id === kfId);
        })
        .toBe(true);
    const stripKfTarget = kfPx.find((k) => k.id === kfId)!;

    // select the strip keyframe first (plain click → active = stripKf)
    await page.mouse.click(stripKfTarget.x, stripKfTarget.y);
    await expect.poll(async () => (await stripKfSelIds()).length).toBe(1);

    // shift-click the force keyframe → co-select (S2). force is the last toggled-in,
    // so activeKind is "force".
    const forceHit = page.locator(".fhit").first();
    const fb = await forceHit.boundingBox();
    if (!fb) throw new Error("force diamond not laid out");
    await page.keyboard.down("Shift");
    await page.mouse.click(fb.x + fb.width / 2, fb.y + fb.height / 2);
    await page.keyboard.up("Shift");
    await expect.poll(async () => (await forceSelIds()).length).toBe(1);
    await expect.poll(async () => (await stripKfSelIds()).length).toBe(1);
    await expect.poll(activeKind).toBe("force");

    // read pre-nudge state
    const forceId = (await forceSelIds())[0];
    const forcesBefore = await sectionForces();
    const forceBefore = forcesBefore.find((f) => f.id === forceId)!;
    const stripKfsBefore = (await stripKeyframesOf(stripId)) as {
        id: number;
        s: number;
        v: number;
    }[];
    const stripKfBefore = stripKfsBefore.find((k) => k.id === kfId)!;

    // ArrowRight — station moves for BOTH (same Δs), no value change for either
    const depthBefore = await undoDepth();
    await page.mouse.move(chartCanvasBb.x + 100, chartCanvasBb.y + 100);
    await page.keyboard.press("ArrowRight");
    await expect.poll(undoDepth).toBe(depthBefore + 1); // one edit

    const forcesAfterH = await sectionForces();
    const forceAfterH = forcesAfterH.find((f) => f.id === forceId)!;
    const stripKfsAfterH = (await stripKeyframesOf(stripId)) as {
        id: number;
        s: number;
        v: number;
    }[];
    const stripKfAfterH = stripKfsAfterH.find((k) => k.id === kfId)!;

    // station moved for both
    expect(forceAfterH.s).not.toBe(forceBefore.s); // force station moved
    expect(stripKfAfterH.s).not.toBe(stripKfBefore.s); // strip keyframe station moved
    // same Δs (the shared delta) — tolerance for floating-point rounding
    const forceDs = forceAfterH.s - forceBefore.s;
    const stripKfDs = stripKfAfterH.s - stripKfBefore.s;
    expect(Math.abs(forceDs - stripKfDs)).toBeLessThan(1e-9);
    // values unchanged (ArrowRight has no value component)
    expect(forceAfterH.g).toBe(forceBefore.g);
    expect(stripKfAfterH.v).toBe(stripKfBefore.v);

    // ArrowUp — S5 axis law: value moves NO member when the set spans both keyframe domains.
    // the vertical channel carries no meaning, so the nudge is a no-op: no member's value
    // moves, no edit records (history's `same` guard detects the no-op). both kinds' stored
    // values are byte-identical; stations unchanged (ArrowUp has no station component).
    const forceBeforeV = forceAfterH;
    const stripKfBeforeV = stripKfAfterH;
    const depthBeforeV = await undoDepth();
    await page.keyboard.press("ArrowUp");
    await expect.poll(undoDepth).toBe(depthBeforeV); // no edit — the channel carries nothing

    const forcesAfterV = await sectionForces();
    const forceAfterV = forcesAfterV.find((f) => f.id === forceId)!;
    const stripKfsAfterV = (await stripKeyframesOf(stripId)) as {
        id: number;
        s: number;
        v: number;
    }[];
    const stripKfAfterV = stripKfsAfterV.find((k) => k.id === kfId)!;

    // S5: both kinds' values byte-identical — no member's value moves in the mixed-domain case
    expect(forceAfterV.g).toBe(forceBeforeV.g); // force value byte-identical — no move
    expect(stripKfAfterV.v).toBe(stripKfBeforeV.v); // strip keyframe value byte-identical
    // stations unchanged (ArrowUp has no station component)
    expect(forceAfterV.s).toBe(forceBeforeV.s);
    expect(stripKfAfterV.s).toBe(stripKfBeforeV.s);
});

// S3 repair: mixed-set Delete over node+force in ONE history gesture. A force keyframe and
// the chain-end node are co-selected by shift-click (S2's cross-kind co-selection). Delete
// must remove BOTH in one undo entry — one undo restores all, not N. This is the combination
// the pairwise force+stripKf path silently dropped: the active kind's handler fired alone and
// the passive kind survived.
//
// RED-FIRST WITNESS: at the pre-repair ref, the active kind's Delete handler fires alone
// (Timeline.svelte for force, controls.ts for node). With activeKind === "force", the force
// handler deletes forces but leaves the node alive; with activeKind === "node", the node
// handler trims the node but leaves the force alive. The arm asserts both are gone, so it
// reds (the passive kind survives). The history depth is +1 (one kind's delete), but the
// member count assertion is what discriminates.
test("mixed-set Delete removes node+force across kinds in one gesture (S3 repair)", async ({
    page,
    boot,
}) => {
    await boot();
    // seedHill: 7 geo nodes (orders 0-6) in section 0. Append a force section (section 1)
    // with 2 seed force keyframes. The force keyframes are on section 1 (not the first section,
    // so `forceCount`/`forces` — which read `sec()` = section 0 — cannot see them). The arm
    // verifies the force deletion through `forceSelIds` (selection state) and `undoDepth`
    // (history depth — a selection change alone never records, so +1 proves a deletion).
    // The node is on section 0, verified directly via `nodeCount`.
    await seedHill(page);
    await expect.poll(async () => kexCall(page, "nodeCount")).toBe(7);
    const tBefore = await kexCall(page, "tTotal");
    await kexCall(page, "append", 1); // SectionKind.Force — 2 seed force keyframes
    await expect.poll(async () => kexCall(page, "sectionCount")).toBe(2);
    await expect.poll(async () => kexCall(page, "tTotal")).not.toBe(tBefore);
    await frameTimeline(page);

    const undoDepth = () => kexCall(page, "undoDepth");
    const forceSelIds = () => kexCall(page, "forceSelIds") as Promise<number[]>;
    const nodeSelOrders = () => kexCall(page, "nodeSelOrders") as Promise<number[]>;
    const activeKind = () => kexCall(page, "activeKind") as Promise<string | null>;
    const nodeCount = () => kexCall(page, "nodeCount");
    const sectionForceCounts = () => kexCall(page, "sectionForceCounts") as Promise<number[]>;

    // 1. select a force keyframe on the timeline (plain click → active = force)
    const forceHit = page.locator(".fhit").first();
    const fb = await forceHit.boundingBox();
    if (!fb) throw new Error("force diamond not laid out");
    await page.mouse.click(fb.x + fb.width / 2, fb.y + fb.height / 2);
    await expect.poll(async () => (await forceSelIds()).length).toBe(1);
    expect(await activeKind()).toBe("force");

    // 2. shift-click the chain-end node (order 6) in the viewport — co-select without clearing
    const canvas = page.locator("canvas.viewport");
    const cb = await canvas.boundingBox();
    if (!cb) throw new Error("viewport canvas not laid out");
    await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 3);
    await page.keyboard.press("f"); // frame the viewport
    const nodePt = await nodePoint(page, 6); // the chain end (order 6)
    await page.keyboard.down("Shift");
    await page.mouse.click(cb.x + nodePt.x, cb.y + nodePt.y);
    await page.keyboard.up("Shift");

    // 3. confirm the mixed selection: both kinds present, node active
    await expect.poll(async () => (await forceSelIds()).length).toBe(1);
    await expect.poll(async () => (await nodeSelOrders()).length).toBe(1);
    await expect.poll(activeKind).toBe("node");

    const nodeCountBefore = await nodeCount();
    const forceCountsBefore = await sectionForceCounts();
    const forceCountSec1Before = forceCountsBefore[1]; // section 1 is the force section

    // 4. Delete — one gesture, both kinds gone. Assert the real force count on section 1
    // (not `forceSelIds` as a proxy — the force is on section 1 while `forceCount`/`forces`
    // read section 0, so only `sectionForceCounts` sees it).
    const depthBefore = await undoDepth();
    await page.keyboard.press("Delete");
    await expect.poll(undoDepth).toBe(depthBefore + 1); // one edit, not N
    await expect.poll(nodeCount).toBe(nodeCountBefore - 1); // node trimmed
    await expect.poll(async () => (await sectionForceCounts())[1]).toBe(forceCountSec1Before - 1); // force keyframe removed from section 1
    await expect.poll(async () => (await forceSelIds()).length).toBe(0); // force deselected
    await expect.poll(async () => (await nodeSelOrders()).length).toBe(0); // node deselected

    // 5. one Undo restores BOTH
    await page.keyboard.press("Control+z");
    await expect.poll(nodeCount).toBe(nodeCountBefore); // node restored
    await expect.poll(async () => (await sectionForceCounts())[1]).toBe(forceCountSec1Before); // force keyframe restored on section 1
    await expect.poll(async () => (await forceSelIds()).length).toBe(1); // force re-selected
    await expect.poll(async () => (await nodeSelOrders()).length).toBe(1); // node re-selected
});
