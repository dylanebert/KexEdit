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

    // selecting a CLIP instead takes the selection with it (node and section selection are mutually
    // exclusive, `editor.ts`), so the wash goes out entirely — a washed clip is never also the
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
    // cursor does, deterministically. the snap resolver is unit-covered in timeline.test.ts.
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

    // ── 2. Add a force keyframe BY POSITION over the force section, with nothing
    // selected — double-click the chart directly below the force clip's center. ──
    const before = await forceCounts(); // [n_geo(0), 0]
    const fcb = await page.locator(".clip").nth(1).boundingBox(); // the force clip
    if (!fcb) throw new Error("force clip not laid out");
    await page.mouse.dblclick(fcb.x + fcb.width / 2, bb.y + bb.height * 0.5);
    await expect.poll(async () => (await forceCounts())[1]).toBeGreaterThan(before[1]);
    await page.waitForTimeout(SHOT_MS);
    if (strip) await page.screenshot({ path: join(OUT, "section-2-keyframe.png"), clip: strip });

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
    // 5 rows now (kex2d-structural-editing stage 6): the free-position Cut joined Convert / Pin /
    // Reset / Delete — the click lands at the clip's own center, a real interior point.
    await expect(page.locator(".ctxmenu").getByRole("menuitem")).toHaveCount(5);
    await expect(page.locator(".ctxmenu").getByRole("menuitem", { name: "Convert" })).toBeEnabled();
    await expect(page.locator(".ctxmenu").getByRole("menuitem", { name: "Pin" })).toBeEnabled();
    await expect(page.locator(".ctxmenu").getByRole("menuitem", { name: "Cut" })).toBeEnabled();
    await expect(page.locator(".ctxmenu").getByRole("menuitem", { name: "Reset" })).toBeEnabled();
    // the section menu's rows already sorted canonically, so the grammar's arrival adds only the
    // DERIVED modify→lifecycle divider. The expectation comes from the real `sectionMenu` builder,
    // run in the page against this section's live state (the section half of the rendered-DOM
    // cross-check, kex2d-menu-grammar decision 8).
    await menuGrammar(page, ".ctxmenu", {
        builder: "sectionMenu",
        // a single, baked force section, no pin session anywhere: Convert runs the force→geo
        // fit, Pin can enter, Reset and Delete are live. The click landed at the clip's own
        // center — a real interior point, so Cut resolves live too.
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
            canCut: true,
            cutSurface: true, // the clip strip — Cut's sole surface (`editor-ui.md` Menus)
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
// geo turnaround appended after that — end to end through the REAL affordances (the `+`
// flyout, double-clicks over the force arc, the fat-hit crest drag). This is the
// reproducible artifact behind the stage-5 verdict; the hands-on feel pass — where the
// author sculpts the geometry and judges where the surface fights — stays the user's.
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

    // ── 2. Author an airtime hill on the force section by real double-clicks over its arc
    // — three points (1g shoulders + a crest), the gotcha's minimum for a dip (one point
    // is a constant, so it takes three to make a localized bump). appendSection already
    // seeded two continuation keyframes (stage B) at the section's entry/exit → 2 + 3 = 5. ──
    const fcb = await page.locator(".clip").nth(1).boundingBox();
    if (!fcb) throw new Error("force clip not laid out");
    await expect.poll(async () => (await forceCounts())[1]).toBe(2); // the two seeds
    const cy = bb.y + bb.height * 0.5;
    for (const f of [0.25, 0.5, 0.75]) await page.mouse.dblclick(fcb.x + fcb.width * f, cy);
    await expect.poll(async () => (await forceCounts())[1]).toBe(5); // + the three hill points

    // pull the crest below 1g via its fat hit target → an airtime dip that re-times the
    // ride (the bake's total time shifts). five points now sort by x as: entry seed, the two
    // 1g shoulders flanking the crest, the crest itself, exit seed — the crest is the MIDDLE
    // of the five, not the middle of the three authored points. `.fhit` is shared with
    // velocity-strip keyframes, and `seed()` (S3) carries no strip of its own (the track-start
    // one-shot is a distinct point kind) — the five under test are the only five on the page,
    // still scoped to the force clip's own x-range for the same reason a future strip would need it.
    const tBefore = await tTotal();
    const hits = page.locator(".fhit");
    await expect(hits).toHaveCount(5);
    const centers = await hits.evaluateAll(
        (els, range) =>
            els
                .map((el) => el.getBoundingClientRect())
                .map((r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 }))
                .filter((c) => c.x >= range.x0 && c.x <= range.x1)
                .sort((a, b) => a.x - b.x),
        { x0: fcb.x, x1: fcb.x + fcb.width },
    );
    expect(centers.length).toBe(5);
    const crest = centers[2];
    await page.mouse.move(crest.x, crest.y);
    await page.mouse.down();
    await page.mouse.move(crest.x, crest.y + 22, { steps: 10 });
    await page.mouse.up();
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
    // and the create lands in the SANDBOX.
    const body = page.locator(".dock .body");
    const bodyBox = await body.boundingBox();
    const clipBox = await page.locator(".clip").first().boundingBox();
    if (!bodyBox || !clipBox) throw new Error("timeline not laid out");
    await page.mouse.dblclick(clipBox.x + clipBox.width * 0.08, bodyBox.y + bodyBox.height * 0.5);
    await expect.poll(forceCount).toBe(6);
    expect(await sandboxDepth()).toBe(1); // the create is a sandbox entry
    expect(await undoDepth()).toBe(base); // …not an outer one
    await expect(solveBtn).toBeEnabled();
    await expect(reason).toHaveCount(0);
    await page.keyboard.press("Delete"); // the create selected it; Del removes it again
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
    const crest2 = await hit(2);
    await page.mouse.click(crest2.x, crest2.y);
    await expect(page.locator(".ptip")).toBeVisible();
    const gField = page.locator('.ptip input[aria-label="Point force (g)"]');
    await expect(gField).toBeEnabled(); // the pinning section's own fields stay live in-mode
    await gField.fill("1");
    await gField.press("Enter");
    await expect.poll(async () => sorted(await forces())[2].g).toBe(1);
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
    const crest3 = await hit(2);
    await page.mouse.click(crest3.x, crest3.y);
    await page.keyboard.press("ArrowUp");
    await expect.poll(async () => sorted(await forces())[2].g).not.toBe(preMode[2].g);
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
    await expect.poll(selected).not.toBeNull(); // wait for the selection to actually land
    const geoId = await selected();
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

// Cut is ABSENT on the VIEWPORT surface (kex2d-structural-editing stage 7a) — the surface stage
// 4 shipped grayed, stage 6 resolved a real cursor position for, and stage 7 took away entirely
// (`pickSectionArc`/`pickCut` deleted; "cutting would be too imprecise" — the round-7 verdict).
// Right-click the track polyline strictly between two nodes still opens the section context
// menu (Convert/Reset/Delete), but it carries NO Cut row at all — absent, not grayed
// (`editor-ui.md` Menus, the surface axis). `tests/menu.test.ts`'s grammar oracle already drives
// `cutSurface: false` through the pure builder; this is the real-DOM half no source census can
// reach — a regression that resurrected `pickSectionArc` would light this up. It also doubles as
// deliverable 1's proof on a SECOND surface: the right-click lands on an unselected section and
// selects it before the menu opens (`openContext`), the same law the clip-strip flow (below)
// proves on its own surface.
test("cut absent on the viewport surface flow", async ({ page, boot }) => {
    await boot();

    const sectionCount = () => kexCall(page, "sectionCount");
    const sectionKinds = () => kexCall(page, "sectionKinds");
    const selectedSection = () => kexCall(page, "selectedSection");
    const canvas = page.locator("canvas.viewport");

    await seedHill(page);
    expect(await sectionCount()).toBe(1);
    expect((await sectionKinds())[0]).toBe(0); // SectionKind.Geo
    await page.keyboard.press("f"); // frame the hill so its nodes separate at pixel scale
    expect(await selectedSection()).toBe(null); // nothing selected yet — the click below must select

    const cb = await canvas.boundingBox();
    if (!cb) throw new Error("viewport canvas not laid out");
    // the segment from the entry anchor to node 1 — `seedHill`'s own shape holds both at y=0
    // local, so the Hermite curve between them is exactly straight, and their midpoint lands
    // ON the polyline (`spanMidAt`'s own SAMPLE midpoint instead lands exactly on the hill's
    // symmetric crest NODE, which the node pick beats the section pick to; a straight-line
    // midpoint between two farther-apart nodes isn't reliably on a curved segment either).
    const n0 = await kexCall(page, "startAt");
    if (!n0) throw new Error("track start not laid out");
    const n1 = await nodePoint(page, 1);
    const mid = { x: (n0.x + n1.x) / 2, y: (n0.y + n1.y) / 2 };
    const secId = (await kexCall(page, "sectionIds"))[0];

    await page.mouse.click(cb.x + mid.x, cb.y + mid.y, { button: "right" });
    await expect(page.locator(".ctxmenu")).toBeVisible();
    expect(await selectedSection()).toBe(secId); // deliverable 1: selected before the menu shows
    await expect(page.locator(".ctxmenu").getByRole("menuitem", { name: "Convert" })).toBeVisible();
    await expect(page.locator(".ctxmenu").getByRole("menuitem", { name: "Cut" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(".ctxmenu")).toHaveCount(0);
});

// Drive a FORCE Cut end to end from the CLIP STRIP (kex2d-structural-editing stage 9) —
// Cut's sole surface. Stage 6's flow passed 35/35 while this exact op was broken on two
// surfaces because it asserted only `sectionCount`/`undoDepth`, which a wrong-but-plausible cut
// (wrong split position, a dropped or corrupted keyframe) satisfies just as well as a correct
// one (`kex2d-harness.md`'s residue entry). This flow instead asserts the BEHAVIOR: the split
// lands exactly at the position the menu itself resolved and showed (`ctxCut`, read before the
// row is clicked — never a pixel→domain re-derivation of the harness's own), and every authored
// keyframe on both sides of the cut keeps its exact (s, g) — rebased on the tail, untouched on
// the head — proving nothing was lost, reset, or misplaced. It also drives deliverable 1 on the
// clip strip itself: the right-click lands on a clip that is NOT the current selection and
// selects it before the menu opens.
test("force cut flow", async ({ page, boot }) => {
    await boot();

    const sectionCount = () => kexCall(page, "sectionCount");
    const sectionKinds = () => kexCall(page, "sectionKinds");
    const sectionLengths = () => kexCall(page, "sectionLengths");
    const sectionIds = () => kexCall(page, "sectionIds");
    const undoDepth = () => kexCall(page, "undoDepth");
    const selectedSection = () => kexCall(page, "selectedSection");
    const forces = () => kexCall(page, "forces");
    const forceU = () => kexCall(page, "forceU");
    const ctxCut = () => kexCall(page, "ctxCut");
    const bySVal = <T extends { s: number }>(a: T[]): T[] => [...a].sort((x, y) => x.s - y.s);

    // seedForceBump converts the single default section to Force and lays 3 bump points (0.2L
    // g=1, 0.5L g=0 crest, 0.8L g=1) alongside the convert's own 2 continuation seeds (0, L) —
    // a genuinely non-flat profile, so a cut that corrupts a value is visible, not masked by a
    // flat curve where every g happens to already agree.
    await kexCall(page, "seedForceBump");
    expect((await sectionKinds())[0]).toBe(1); // SectionKind.Force
    const preLen = (await sectionLengths())[0];
    const pre = bySVal(await forces());
    expect(pre.length).toBe(5);
    await frameTimeline(page);
    expect(await selectedSection()).toBe(null); // nothing selected — the click below must select

    // right-click strictly between the two interior bump points (0.2L, 0.5L) — a real mid-
    // segment position, comfortably clear of the parked playhead's snap radius at u=0 so the
    // resolved position isn't pulled to the track start.
    const clipBox = await page.locator(".clip").first().boundingBox();
    if (!clipBox) throw new Error("force clip not laid out");
    const cx = clipBox.x + clipBox.width * 0.35;
    const cy = clipBox.y + clipBox.height / 2;
    const secId = (await sectionIds())[0];

    const before = await undoDepth();
    await page.mouse.click(cx, cy, { button: "right" });
    await expect(page.locator(".ctxmenu")).toBeVisible();
    expect(await selectedSection()).toBe(secId); // deliverable 1: selected before the menu shows

    const cut = await ctxCut();
    if (cut === null) throw new Error("Cut did not resolve a landing position");
    expect(cut.at).toBeGreaterThan(pre[1].s); // strictly past the 0.2L keyframe
    expect(cut.at).toBeLessThan(pre[2].s); // strictly before the 0.5L crest
    await expect(page.locator(".ctxmenu").getByRole("menuitem", { name: "Cut" })).toBeEnabled();
    await clickMenuItem(page, ".ctxmenu", "Cut");

    await expect.poll(sectionCount).toBe(2);
    expect((await sectionKinds()).join(",")).toBe("1,1"); // both halves stay force
    await expect.poll(undoDepth).toBe(before + 1); // ONE undo entry

    // the split landed exactly where the menu showed — not the clip midpoint, not the segment
    // start, not the playhead.
    const [headId, tailId] = await sectionIds();
    const lens = await sectionLengths();
    expect(lens[0]).toBeCloseTo(cut.at, 3);
    expect(lens[1]).toBeCloseTo(preLen - cut.at, 3);

    // every ORIGINAL keyframe survives with its exact authored value: unchanged on the head,
    // rebased (s -= cut.at) on the tail — a corrupted, dropped, or repositioned point fails
    // this even though sectionCount/undoDepth alone would have passed it.
    //
    // `forceU` reads `forcePts` — the timeline's per-RAF PROJECTION of the keyframes, not the
    // authored components — so it lags the Cut that `sectionCount`, `sectionLengths` and
    // `undoDepth` (direct ECS reads, all polled above) already report landed. Measured inside a
    // full run at `KEX_WORKERS=1`: `sectionCount` 2 and `lens` [8.3937, 15.6063] with `forceU`
    // still answering the five PRE-cut keys, every one on the head section and no boundary key at
    // all — 2 of 3 full runs, 0 of 6 in isolation, so a bare read here is a pace lottery rather
    // than load. Poll the projection (the settle idiom: a condition, never a sleep) and assert on
    // exactly the value the poll accepted.
    let post: Awaited<ReturnType<typeof forceU>> = [];
    await expect
        .poll(async () => {
            post = await forceU();
            return post.length;
        })
        .toBe(pre.length + 2); // every original keyframe, plus the two new boundary keys
    const head = bySVal(post.filter((p) => p.section === headId));
    const tail = bySVal(post.filter((p) => p.section === tailId));
    const headOriginal = pre.filter((p) => p.s < cut.at);
    const tailOriginal = pre.filter((p) => p.s > cut.at);
    expect(head.length).toBe(headOriginal.length + 1); // + the new boundary keyframe
    expect(tail.length).toBe(tailOriginal.length + 1);
    for (let i = 0; i < headOriginal.length; i++) {
        expect(head[i].s).toBeCloseTo(headOriginal[i].s, 3);
        expect(head[i].g).toBeCloseTo(headOriginal[i].g, 5);
    }
    for (let i = 0; i < tailOriginal.length; i++) {
        expect(tail[i + 1].s).toBeCloseTo(tailOriginal[i].s - cut.at, 3);
        expect(tail[i + 1].g).toBeCloseTo(tailOriginal[i].g, 5);
    }
    expect(head[head.length - 1].s).toBeCloseTo(cut.at, 3); // the new head-side boundary key
    expect(tail[0].s).toBeCloseTo(0, 5); // the new tail-side boundary key, rebased to its entry

    await page.keyboard.press("Control+z");
    await expect.poll(sectionCount).toBe(1);
    expect(bySVal(await forces())).toEqual(pre); // undo restored the authored profile exactly
});

// Join by multi-select (stage 5's own op, wired since that stage — this flow is its first
// real-UI proof): shift-click a contiguous same-kind run into a set, right-click a member (the
// promote-vs-replace grammar keeps the set), Join merges it as one undo entry.
test("join a run flow", async ({ page, boot }) => {
    await boot();

    const sectionCount = () => kexCall(page, "sectionCount");
    const sectionKinds = () => kexCall(page, "sectionKinds");
    const undoDepth = () => kexCall(page, "undoDepth");

    await seedHill(page);
    await kexCall(page, "append", 0); // a second geo section
    await kexCall(page, "append", 0); // a third — three geo sections in a row
    await expect.poll(async () => (await sectionKinds()).join(",")).toBe("0,0,0");
    await frameTimeline(page);

    const before = await undoDepth();
    await page.locator(".clip").nth(0).click();
    await page
        .locator(".clip")
        .nth(1)
        .click({ modifiers: ["Shift"] }); // a two-section run, {0,1}
    await page.locator(".clip").nth(0).click({ button: "right" }); // right-click keeps the set
    await expect(page.locator(".ctxmenu")).toBeVisible();
    await expect(page.locator(".ctxmenu").getByRole("menuitem", { name: "Join" })).toBeEnabled();
    await clickMenuItem(page, ".ctxmenu", "Join");
    await expect.poll(sectionCount).toBe(2); // {0,1} merged; the third section stays apart
    await expect.poll(undoDepth).toBe(before + 1);
    await page.keyboard.press("Control+z");
    await expect.poll(sectionCount).toBe(3);
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

    // create a strip first (right-click on the band → Add velocity strip). `seed()` (S5)
    // already carries its own start strip on this section, so the count goes 1 → 2, and the
    // NEW strip is addressed by id, never index 0 (the launch strip's `start = 0` sorts
    // first).
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
    await frames(page, 2); // bandStrips/selStrip are $derived behind void tick with no __kex
    // hook exposing them (bandDown's hit-test resolves through bandCandidates -> bandStrips) --
    // no readable condition exists for either, so this settles by frame count, never a
    // registered root property (checks.md: frames(page,N) is lawful only where the awaited
    // quantity has no readable condition). Forced-race witness (2026-08-25, this test, the
    // `:1582` roster member 7/8 base): armed a 150ms-per-rAF-callback `requestAnimationFrame`
    // delay (via a temporary `page.addInitScript`, scoped to the 6 callbacks right after this
    // line so unrelated reactivity downstream stays unperturbed) — the pre-fix 200ms
    // fixed-time sleep reds under it (exit 1, timeout on the drag-changed-v poll, the bandDown
    // edge-resize having missed the stale-cached strip); this `frames(page, 2)` greens under the
    // identical delay (exit 0). Both runs: `bun run capture -- -g "velocity strip keyframe
    // editing flow"`.

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

// F1 repair (round 3, `Timeline.svelte`'s `deleteSelectedStripKf`): the RAF-tick race the fix
// closes, shipped with no arm — `selStrip` is a `$derived.by` gated on `void tick`, so its
// cached value only catches up to a fresh `editor.strip` write on the NEXT tick; a Delete
// pressed in the SAME tick-period as a selecting click races that cache. Constructed the same
// way `deleteSelectedStrip`'s own sibling repair was witnessed (58fa676, P5): settle a NULL
// selection first (so the cache's own "nothing selected" reading is the stale value the race
// needs), then a single real click that flips `editor.strip` null → non-null (and sets
// `editor.stripKf`), then Delete with NO settle in between. Pre-fix, `deleteSelectedStripKf`
// read that stale `selStrip`, saw null, and no-opped — post-fix it reads the strip's section
// off the ECS directly (`stripAt` + `Strip.section.get`), never depending on the cache.
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
    await frames(page, 2); // bandStrips/selStrip are $derived behind void tick with no __kex
    // hook exposing them (bandDown's hit-test resolves through bandCandidates -> bandStrips) --
    // no readable condition exists for either, so this settles by frame count, never a
    // registered root property (checks.md: frames(page,N) is lawful only where the awaited
    // quantity has no readable condition). Forced-race witness: "velocity strip keyframe
    // editing flow"'s own docblock at its matching line, same mechanism.

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

    // DESELECT fully, and let the deselection ITSELF settle — `selStrip`'s cache must read the
    // null selection at least once before the race-constructing click below, or the click's
    // fresh write races a stale NON-null cache instead of the stale-null one the fix closes.
    await page.keyboard.press("Escape"); // clears the strip (no stripKf sub-selection is active)
    await expect.poll(async () => await kexCall(page, "selectedStrip")).toBe(null);
    await frames(page, 2); // selStrip's cache must read the null selection at least once
    // before the race-constructing click below (this test's own point) -- selStrip has no
    // __kex hook, so there is no readable condition to poll; settle by frame count.

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
test("velocity strip keyframe drag origin flow", async ({ page, boot }) => {
    await boot();
    await seedHill(page);
    await frameTimeline(page);

    const stripsOf = () => kexCall(page, "stripsOf", 0);
    const stripKeyframesOf = (id: number) => kexCall(page, "stripKeyframesOf", id);
    const xView = () => kexCall(page, "xView");
    const vRange = () => kexCall(page, "vRange");
    const stripKfPx = () => kexCall(page, "stripKfPx");

    // create a strip (right-click on the band → Add velocity strip), the T1 flow's own idiom.
    // `seed()` (S5) already carries its own start strip on this section, so the count goes
    // 1 → 2, and the NEW strip is addressed by id, never index 0 (the launch strip's
    // `start = 0` sorts first).
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
    await frames(page, 2); // bandStrips/selStrip are $derived behind void tick with no __kex
    // hook exposing them (bandDown's hit-test resolves through bandCandidates -> bandStrips) --
    // no readable condition exists for either, so this settles by frame count, never a
    // registered root property (checks.md: frames(page,N) is lawful only where the awaited
    // quantity has no readable condition). Forced-race witness: "velocity strip keyframe
    // editing flow"'s own docblock at its matching line, same mechanism.

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
    // never lands on `end` — the buggy clamp's own tell, independent of the tolerance above.
    expect(kf1.s).toBeLessThan(strip.end - tol);
    expect(kf1.s).toBeGreaterThan(strip.start + tol);
});

// S1 capture arm: marqueeUp's selectStripKf(null) — the strip-keyframe deselection path on
// empty-chart click. marqueeUp (Timeline.svelte:1681) fires on pointerup after a marqueeDown
// on the chartzone rect; a plain click (no drag past DRAG_PX) reaches the !armed && !shift
// branch, which calls selectStripKf(null) to clear the strip-keyframe sub-selection
// alongside the force/section kinds. This flow constructs a real strip keyframe, selects it
// by a real pointer press on its diamond, then clicks empty chart and asserts the selection
// is cleared.
//
// RED-FIRST WITNESS: deleted the `selectStripKf(null)` call at Timeline.svelte:1700 (the
// !armed && !shift branch of marqueeUp). The flow red at the stripKfSelIds() empty assert:
// stripKfSelIds() returned [<kf-id>] instead of [] — the strip keyframe stayed selected
// after the empty-chart click. Restored the call; the flow went green.
test("strip keyframe deselect on empty chart click", async ({ page, boot }) => {
    await boot();
    await seedHill(page);
    await frameTimeline(page);

    const stripsOf = () => kexCall(page, "stripsOf", 0);
    const stripKeyframesOf = (id: number) => kexCall(page, "stripKeyframesOf", id);
    const stripKfPx = () => kexCall(page, "stripKfPx");
    const stripKfSelIds = () => kexCall(page, "stripKfSelIds");

    // Create a strip (right-click on the band → Add velocity strip). `seed()` (S5) already
    // carries its own start strip, so the count goes 1 → 2; address the new strip by id.
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
    await frames(page, 2); // bandStrips/selStrip are $derived behind void tick with no __kex
    // hook exposing them (bandDown's hit-test resolves through bandCandidates -> bandStrips) --
    // no readable condition exists for either, so this settles by frame count, never a
    // registered root property (checks.md: frames(page,N) is lawful only where the awaited
    // quantity has no readable condition). Forced-race witness: "velocity strip keyframe
    // editing flow"'s own docblock at its matching line, same mechanism.

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

    // Widen the strip via a REAL pointer edge-drag on its end. Non-sticking (S4, boundary
    // ride deleted): the resize does NOT carry the seeded end keyframe — the two seeded
    // keyframes keep their positions and stay clickable on screen.
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

    // Poll for the seeded keyframes' diamonds to be projected on screen.
    await expect.poll(async () => (await stripKfPx()).length).toBeGreaterThan(0);
    const kfPx = (await stripKfPx()) as { id: number; x: number; y: number }[];
    // Find a seeded keyframe that belongs to our strip.
    const kf0Px = kfPx.find((k) => seededIds.has(k.id));
    if (!kf0Px) throw new Error("seeded keyframe not projected on screen");

    // Click on the keyframe diamond to select it.
    await page.mouse.click(kf0Px.x, kf0Px.y);
    await expect.poll(async () => (await stripKfSelIds()).length).toBe(1);

    // Click on EMPTY CHART space — a plain click (no drag) triggers marqueeUp with !armed,
    // which must call selectStripKf(null) to clear the strip-keyframe sub-selection.
    // Click at a y near the chart top (high velocity), away from the keyframes' velocity.
    const dockBb = await page.locator(".dock .body").boundingBox();
    if (!dockBb) throw new Error("dock body not laid out");
    const emptyX = dockBb.x + dockBb.width * 0.5;
    const emptyY = dockBb.y + CHART_TOP + 4; // just inside the chart top, away from keyframes
    await page.mouse.click(emptyX, emptyY);
    await expect.poll(async () => (await stripKfSelIds()).length).toBe(0);
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

    // Create a strip (right-click on the band → Add velocity strip). `seed()` (S5) already
    // carries its own start strip, so the count goes 1 → 2; address the new strip by id.
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
    await frames(page, 2); // bandStrips/selStrip are $derived behind void tick with no __kex
    // hook exposing them (bandDown's hit-test resolves through bandCandidates -> bandStrips) --
    // no readable condition exists for either, so this settles by frame count, never a
    // registered root property (checks.md: frames(page,N) is lawful only where the awaited
    // quantity has no readable condition). Forced-race witness: "velocity strip keyframe
    // editing flow"'s own docblock at its matching line, same mechanism.

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
    // distinguishable from `lo: 0`). `seed()` (S5) already carries its own start strip, so
    // the count goes 1 → 2; address the new strip by id.
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
    await frames(page, 2); // bandStrips/selStrip are $derived behind void tick with no __kex
    // hook exposing them (bandDown's hit-test resolves through bandCandidates -> bandStrips) --
    // no readable condition exists for either, so this settles by frame count, never a
    // registered root property (checks.md: frames(page,N) is lawful only where the awaited
    // quantity has no readable condition). Forced-race witness: "velocity strip keyframe
    // editing flow"'s own docblock at its matching line, same mechanism.

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

    // Create a strip (right-click on the band → Add velocity strip). `seed()` (S5) already
    // carries its own start strip, so the count goes 1 → 2; address the new strip by id.
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
    await frames(page, 2); // bandStrips/selStrip are $derived behind void tick with no __kex
    // hook exposing them (bandDown's hit-test resolves through bandCandidates -> bandStrips) --
    // no readable condition exists for either, so this settles by frame count, never a
    // registered root property (checks.md: frames(page,N) is lawful only where the awaited
    // quantity has no readable condition). Forced-race witness: "velocity strip keyframe
    // editing flow"'s own docblock at its matching line, same mechanism.

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

    // Separate the still-coincident seeded pair — drag the END keyframe (renders on top at the
    // tie) toward the widened end, uncovering the start keyframe.
    await expect.poll(async () => (await stripKfPx()).length).toBeGreaterThan(0);
    let kfPxAll = (await stripKfPx()) as { id: number; x: number; y: number }[];
    const sharedPx = kfPxAll.find((k) => seededIds.has(k.id))!;
    const widePx = (
        (await kexCall(page, "stripPx")) as { id: number; x0: number; x1: number }[]
    ).find((s) => s.id === stripId)!;
    const separateX = chartCanvasBb.x + widePx.x1 - 10;
    await page.mouse.move(sharedPx.x, sharedPx.y);
    await page.mouse.down();
    await page.mouse.move(separateX, sharedPx.y, { steps: 8 });
    await page.mouse.up();

    // Read the separated keyframes — identify start (smaller s) and end (larger s).
    let kfs = (await stripKeyframesOf(stripId)) as { id: number; s: number; v: number }[];
    const seededKfs = kfs.filter((k) => seededIds.has(k.id)).sort((a, b) => a.s - b.s);
    const startKf = seededKfs[0]; // smaller s = start
    const endKf = seededKfs[1]; // larger s = end
    if (!startKf || !endKf) throw new Error("start/end keyframe not found after separation");

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
    kfPxAll = (await stripKfPx()) as { id: number; x: number; y: number }[];

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

// S1 capture arm: strip-keyframe OVERLAP REFUSAL on a multi-member drag. `applyKeyframeDrag`'s
// block-level overlap check (Timeline.svelte:1471-1477) calls `keyframeTaken` for every member
// before committing the shared delta — if any member would land on an occupied station, the
// BLOCK holds at the last landed delta (`dragKfLastDs`), preserving offsets. Without this
// check, `setStripKeyframe`'s own per-keyframe refusal would still block the overlapping
// member's s write, but the non-overlapping member would move freely — the block tears apart.
// This flow constructs a multi-member set, drags it toward a non-selected keyframe's station
// (so one member would overlap), and asserts the block held (both members moved by the same
// delta). The drag is a single-step move to the end keyframe's station, so the
// overlap check fires at the final position — without the block check, the
// overlapping member's s write is refused by `setStripKeyframe` but the other
// member moves, tearing the block.
//
// RED-FIRST WITNESS: replaced the `landed` check at Timeline.svelte:1473-1476 with
// `const landed = true;` (overlap refusal disabled). The flow red at the offset-preserved
// assert: the overlapping member stayed at its pre-drag s while the other moved — the delta
// difference was the full drag distance, not within tolerance. Restored the check; green.
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

    // Create a strip (right-click on the band → Add velocity strip). `seed()` (S5) already
    // carries its own start strip, so the count goes 1 → 2; address the new strip by id.
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
    await frames(page, 2); // bandStrips/selStrip are $derived behind void tick with no __kex
    // hook exposing them (bandDown's hit-test resolves through bandCandidates -> bandStrips) --
    // no readable condition exists for either, so this settles by frame count, never a
    // registered root property (checks.md: frames(page,N) is lawful only where the awaited
    // quantity has no readable condition). Forced-race witness: "velocity strip keyframe
    // editing flow"'s own docblock at its matching line, same mechanism.

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
    // tie) to ~30% of the WIDENED extent (never to the strip's own end — that would leave no
    // room past it for the third selected keyframe's own clamp bound, the mechanism that
    // silently absorbed this arm's overlap in earlier attempts: `clampDelta` shrank the shared
    // delta to keep the OTHER member inside ITS OWN [lo, len] before the anchor ever reached
    // the overlap station, so `keyframeTaken` never fired — for either tree).
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

    // Read the END keyframe's pixel position — the drag target. The start keyframe's new s
    // would be `endS` (the end keyframe's station) if the block moved by `ds = endS - startS`.
    // The end keyframe is NOT in the dragged set, so `keyframeTaken` would detect the overlap.
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

    // Assert the BLOCK held: both selected keyframes moved by the same delta (offset preserved).
    // Without the mutation: `landed = false` (overlap at `endS`), `dsWrite = dragKfLastDs = 0`,
    // both stay → deltas are both 0 → offset preserved.
    // With the mutation: `landed = true`, `dsWrite = ds`. Start: `setStripKeyframe(endS)`
    // refuses (overlap with end keyframe) → stays. Mid: `setStripKeyframe(midS + ds)` succeeds
    // (not occupied) → moves. Deltas differ → offset NOT preserved → red.
    kfs = (await stripKeyframesOf(strip.id)) as { id: number; s: number; v: number }[];
    const startSAfter = kfs.find((k) => k.id === startKf.id)!.s;
    const midSAfter = kfs.find((k) => k.id === midKf.id)!.s;
    const startDelta = startSAfter - startSBefore;
    const midDelta = midSAfter - midSBefore;
    const tol = 0.5 / pxPerU; // sub-pixel tolerance — tight enough that a 1px drag reds
    // the drag was real (the cursor moved a substantial distance) — the separation and the
    // third keyframe's placement (see comments above) keep this well clear of any member's
    // own [lo, len] clamp, so the shared delta reaches the overlap station unclamped.
    const expectedDs = (endKfPx.x - startKfPx.x) / pxPerU;
    expect(Math.abs(expectedDs)).toBeGreaterThan(tol);
    // the block held: both members moved by the same delta (offset preserved)
    expect(Math.abs(startDelta - midDelta)).toBeLessThan(tol);
});
