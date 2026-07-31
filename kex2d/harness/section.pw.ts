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
    marqueeDrag,
    dockStrip,
    DOCK_RESERVE,
    frames,
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

    // ── 4. Right-click the force clip: the menu carries exactly THREE rows — ONE `Convert` row
    // (stage 7 naming: the section's kind implies the direction, so the label is the verb
    // alone), the force-only Optimize entry, and Delete. (Also the real-menu regression guard
    // for the destructive Convert row's removal.) ──
    await page.locator(".clip").nth(1).click({ button: "right" });
    await expect(page.locator(".ctxmenu")).toBeVisible();
    await expect(page.locator(".ctxmenu").getByRole("menuitem")).toHaveCount(3);
    await expect(page.locator(".ctxmenu").getByRole("menuitem", { name: "Convert" })).toBeEnabled();
    await expect(
        page.locator(".ctxmenu").getByRole("menuitem", { name: "Optimize" }),
    ).toBeEnabled();
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
// Escape) → the real solve → the document (kind flipped, keyframes landed, the realized step
// stored) → one undo back to the authored shape, byte-identical.
//
// This is the ONE gate that proves the WORKER BUNDLING ships. `convert.ts` spawns its pool with
// `new Worker(new URL("./convert-worker.ts", import.meta.url))` — the exact shape the bundler
// rewrites — and bun's test runner resolves that specifier itself, so a build that ships a
// broken or dev-only worker URL is green everywhere except here.
test("invoked solve flow", async ({ page, boot }) => {
    await boot();

    const kinds = () => kexCall(page, "sectionKinds");
    const forceCounts = () => kexCall(page, "sectionForceCounts");
    const steps = () => kexCall(page, "sectionSteps");
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

    // ── 7. What landed: the section is force, carrying the solve's keyframes, its realized
    // extent, and its realized step (`Section.ds`, 0 = the track-nominal sentinel — only an
    // invoked solve ever writes one). One undo entry, on top of the append's. ──
    expect((await forceCounts())[0]).toBeGreaterThan(1);
    expect((await lengths())[0]).toBeGreaterThan(0);
    expect((await steps())[0]).toBeGreaterThan(0);
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

// Drive the V0 AUTHORING flow (section-editor stage 4, fork 5): select the fixed START
// anchor in the viewport → its initial-speed popover → scrub the label AND type a value,
// each one undo entry → assert __kex.v0. The default flat seed keeps the START diamond
// clear of shape nodes (its one node sits a full EXTEND_DIST out) so it picks cleanly.
// Real affordances throughout; __kex is read only for assertions.
test("v0 authoring flow", async ({ page, boot }) => {
    await boot();

    const v0 = () => kexCall(page, "v0");
    const undoDepth = () => kexCall(page, "undoDepth");
    const tTotal = () => kexCall(page, "tTotal");

    // the default flat seed bakes on load — no seedHill, so the START diamond at the world
    // origin has no shape node on top of it.
    await expect.poll(tTotal).toBeGreaterThan(0);
    const v0Default = await v0();

    // ── 1. Click the START anchor → its v0 popover appears. The framing (DOCK_RESERVE) is the
    // camera's, not the canvas center — so the click follows it. ──
    const canvas = page.locator("canvas.viewport");
    const cb = await canvas.boundingBox();
    if (!cb) throw new Error("viewport canvas not laid out");
    await page.mouse.click(cb.x + cb.width / 2, cb.y + (cb.height - DOCK_RESERVE) / 2);
    await expect(page.locator(".vtip")).toBeVisible();
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "v0-1-selected.png") });

    // ── 2. Scrub the v₀ label to the right → the speed rises, one undo entry. ──
    const key = page.locator(".vtip .key");
    const kb = await key.boundingBox();
    if (!kb) throw new Error("v0 scrub handle not laid out");
    await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2);
    await page.mouse.down();
    await page.mouse.move(kb.x + kb.width / 2 + 120, kb.y + kb.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect.poll(v0).toBeGreaterThan(v0Default);
    expect(await undoDepth()).toBe(1); // the whole scrub → one entry

    // undo restores the default speed.
    await page.keyboard.press("Control+z");
    await expect.poll(v0).toBeCloseTo(v0Default, 3);
    await expect.poll(undoDepth).toBe(0);

    // ── 3. Type an exact speed in the field → it commits verbatim, one undo entry. ──
    await page.locator(".vtip input").fill("25");
    await page.keyboard.press("Enter");
    await expect.poll(v0).toBeCloseTo(25, 3);
    expect(await undoDepth()).toBe(1);
    await page.screenshot({ path: join(OUT, "v0-2-typed.png") });

    // undo restores the default speed.
    await page.keyboard.press("Control+z");
    await expect.poll(v0).toBeCloseTo(v0Default, 3);
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
    // of the five, not the middle of the three authored points.
    const tBefore = await tTotal();
    const hits = page.locator(".fhit");
    await expect(hits).toHaveCount(5);
    const centers = await hits.evaluateAll((els) =>
        els
            .map((el) => el.getBoundingClientRect())
            .map((r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 }))
            .sort((a, b) => a.x - b.x),
    );
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

// Drive OPTIMIZE MODE end to end (kex2d-optimize-mode stage 7) — the SANDBOX over the real UI:
// entering opens a sandbox (outer history untouched), in-mode edits + undo/redo live in it,
// undo at its start exits, Exit/Esc discards without trace, downstream sections FREEZE at their
// mode-entry placement, a landed Solve is ONE outer entry whose undo reopens the resumed
// experiment and whose redo re-lands.
test("optimize mode flow", async ({ page, boot }) => {
    await boot();

    const forces = () => kexCall(page, "forces");
    const undoDepth = () => kexCall(page, "undoDepth");
    const sandboxDepth = () => kexCall(page, "sandboxDepth");
    const entries = () => kexCall(page, "entries");
    const optimizing = () => kexCall(page, "optimizing");
    const landing = () => kexCall(page, "landing");
    const lockedCount = () => kexCall(page, "lockedCount");
    const forceSelIds = () => kexCall(page, "forceSelIds");
    const forceCount = () => kexCall(page, "forceCount");
    const panel = page.locator(".optpanel");
    const solveBtn = page.locator(".optpanel .solve");
    const reason = page.locator(".optpanel .reason");
    const strip = dockStrip(page);
    const sorted = (rows: { s: number; g: number }[]) => [...rows].sort((a, b) => a.s - b.s);

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

    // ── 1. Enter through the section menu's Optimize row: the docked panel + the striped clip
    // are the mode signal — and the OUTER history is untouched (the sandbox contract: entering
    // records nothing; a fresh, empty sandbox opens instead). ──
    await page.locator(".clip").first().click({ button: "right" });
    await expect(page.locator(".ctxmenu")).toBeVisible();
    await expect(
        page.locator(".ctxmenu").getByRole("menuitem", { name: "Optimize" }),
    ).toBeEnabled();
    await clickMenuItem(page, ".ctxmenu", "Optimize");
    await expect(panel).toBeVisible();
    await expect.poll(optimizing).toBe(true);
    await expect(page.locator(".clip-stripes")).toHaveCount(1);
    expect(await undoDepth()).toBe(base); // NOTHING landed outer
    expect(await sandboxDepth()).toBe(0); // …the sandbox opened empty
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "optimize-1-mode.png") });

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
    expect(await optimizing()).toBe(true); // both menus peeled without touching the mode

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
    // the downstream freeze: the edit moved the optimizing exit, but the next section's baked
    // entry is BYTE-STABLE at its mode-entry value (no live repropagation — the gap is the
    // residual made visible).
    const entryB1 = (await entries())[1];
    expect(entryB1.x).toBe(entryB0.x);
    expect(entryB1.y).toBe(entryB0.y);
    expect(entryB1.theta).toBe(entryB0.theta);
    expect(entryB1.v).toBe(entryB0.v);

    await page.keyboard.press("Control+z"); // in-mode undo: the sandbox, not the outer stack
    await expect.poll(async () => sorted(await forces())[2].g).toBe(preMode[2].g);
    expect(await optimizing()).toBe(true); // still in the mode
    expect(await undoDepth()).toBe(base);
    await page.keyboard.press("Control+Shift+z"); // in-mode redo replays it
    await expect.poll(async () => sorted(await forces())[2].g).not.toBe(preMode[2].g);
    expect(await optimizing()).toBe(true);
    await page.keyboard.press("Control+z"); // back off again
    await expect.poll(async () => sorted(await forces())[2].g).toBe(preMode[2].g);
    await page.keyboard.press("Control+z"); // at the sandbox's start → acts as EXIT
    await expect.poll(optimizing).toBe(false);
    await expect(panel).toHaveCount(0);
    expect(sorted(await forces())).toEqual(preMode);
    expect(await undoDepth()).toBe(base);
    await page.keyboard.press("Control+Shift+z"); // no trace: nothing to redo
    await expect.poll(optimizing).toBe(false);
    expect(sorted(await forces())).toEqual(preMode);
    // unfrozen on close: downstream repropagates — the draft was restored, so it lands where
    // it started.
    const entryB2 = (await entries())[1];
    expect(entryB2.x).toBe(entryB0.x);
    expect(entryB2.y).toBe(entryB0.y);

    // the Esc path is the same discard: re-enter, edit, Esc peels selection, Esc discards.
    await page.locator(".clip").first().click({ button: "right" });
    await clickMenuItem(page, ".ctxmenu", "Optimize");
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
    expect(await optimizing()).toBe(true);
    await page.keyboard.press("Escape"); // the outermost rung: Exit = discard
    await expect.poll(optimizing).toBe(false);
    expect(sorted(await forces())).toEqual(preMode);
    expect(await undoDepth()).toBe(base);

    // ── 3. Lock gating (pure counting): lock 3 of 5 → 2 free, Solve starves and the reason
    // shows; an in-mode-added key defaults FREE and re-arms it; delete + unlock restore. ──
    await page.locator(".clip").first().click({ button: "right" });
    await clickMenuItem(page, ".ctxmenu", "Optimize");
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
    if (strip) await page.screenshot({ path: join(OUT, "optimize-2-locked.png"), clip: strip });

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
    // stays in-mode with the draft untouched and its reason on the panel. ──
    await page.keyboard.press("Escape"); // clear the selection — a member click would PROMOTE
    await expect.poll(async () => (await forceSelIds()).length).toBe(0);
    const crest2 = await hit(2);
    await page.mouse.click(crest2.x, crest2.y);
    await expect(page.locator(".ptip")).toBeVisible();
    const gField = page.locator('.ptip input[aria-label="Point force (g)"]');
    await expect(gField).toBeEnabled(); // the optimizing section's own fields stay live in-mode
    await gField.fill("1");
    await gField.press("Enter");
    await expect.poll(async () => sorted(await forces())[2].g).toBe(1);
    expect(await sandboxDepth()).toBe(3); // the popover edit is a sandbox entry
    const flattened = sorted(await forces());
    await solveBtn.click();
    await expect(reason).toBeVisible({ timeout: 30_000 });
    await expect(reason).toContainText("can't steer");
    expect(await optimizing()).toBe(true); // a refusal is not an exit
    expect(sorted(await forces())).toEqual(flattened); // …and writes nothing
    expect(await undoDepth()).toBe(base); // …anywhere
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "optimize-3-refusal.png") });

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
    await page.keyboard.press("ArrowUp");
    await expect.poll(async () => sorted(await forces())[2].g).not.toBe(preMode[2].g);
    await solveBtn.click();
    await expect.poll(optimizing, { timeout: 30_000 }).toBe(false); // Solve confirms AND closes
    await expect(panel).toHaveCount(0);
    await expect(page.locator(".notice")).toHaveCount(0); // no stats toast — the animation IS the feedback
    expect(await undoDepth()).toBe(base + 1); // the WHOLE experiment is ONE outer entry
    await expect.poll(landing).toBe(true); // the paced landing raised — the feedback

    // ── 6. Undo DURING the landing invalidates it AND reopens the mode with the experiment
    // RESUMED (sandbox restored: create, delete, flatten-undone, 2 nudges → 4 entries); walking
    // the sandbox out exits at its start with the pre-mode draft; redo then RE-LANDS. ──
    await page.keyboard.press("Control+z");
    await expect.poll(landing).toBe(false); // invalidated by the undo route, not left to expire
    await expect.poll(optimizing).toBe(true); // the experiment resumed
    expect(await sandboxDepth()).toBe(4); // create, delete, nudge 1, nudge 2 — all undoable again
    expect(await undoDepth()).toBe(base); // the landing sits on the outer REDO
    await page.keyboard.press("Control+z"); // nudge 2
    await page.keyboard.press("Control+z"); // nudge 1
    await page.keyboard.press("Control+z"); // the deleted key returns
    await page.keyboard.press("Control+z"); // the created key leaves
    await expect.poll(sandboxDepth).toBe(0);
    expect(await optimizing()).toBe(true); // still inside the mode
    await page.keyboard.press("Control+z"); // at the sandbox's start → exits
    await expect.poll(optimizing).toBe(false);
    await expect
        .poll(async () => JSON.stringify(sorted(await forces())))
        .toBe(JSON.stringify(preMode));
    expect(await undoDepth()).toBe(base);
    await page.keyboard.press("Control+Shift+z"); // the outer redo holds the landing → RE-LANDS
    await expect.poll(optimizing).toBe(false);
    await expect.poll(undoDepth).toBe(base + 1);
    await page.waitForTimeout(SHOT_MS);
    await page.screenshot({ path: join(OUT, "optimize-4-landed.png") });
});
